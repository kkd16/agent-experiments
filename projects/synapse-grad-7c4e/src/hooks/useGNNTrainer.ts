import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { GNN, buildAdj, type GraphAdj, type ConvKind, type GNNSpec } from '../engine/gnn';
import { makeGraphDataset, type GraphDataset, type GraphDatasetKind, type GraphParams } from '../engine/graph-data';
import { mulberry32, type Activation } from '../engine/nn';
import { maskedCrossEntropy } from '../engine/losses';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { forceLayout } from '../lib/graph-layout';
import { pca2d } from '../lib/pca';

export interface GNNConfigUI {
  dataset: GraphDatasetKind;
  nodes: number;
  communities: number;
  pIn: number;
  pOut: number;
  knnK: number;
  featDim: number;
  signal: number;
  noise: number;
  seed: number;
  conv: ConvKind;
  hiddenDim: number;
  hiddenLayers: number;
  heads: number;
  activation: Activation;
  dropout: number;
  labelsPerClass: number;
  valFraction: number;
  useGraph: boolean;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  clipNorm: number;
  stepsPerFrame: number;
  loadId: number;
}

export interface GNNMetrics {
  step: number;
  loss: number;
  trainAcc: number;
  valAcc: number;
  testAcc: number;
  gradNorm: number;
  lossHistory: number[];
  trainAccHistory: number[];
  valAccHistory: number[];
  testAccHistory: number[];
}

export interface NodeView {
  n: number;
  numClasses: number;
  classNames: string[];
  positions: Float64Array; // [n*2] in [-1,1]
  edges: [number, number][];
  labels: Int32Array;
  preds: Int32Array;
  confidence: Float64Array; // [n] max softmax prob
  split: Uint8Array; // 0 train, 1 val, 2 test
  attention: Float64Array | null; // [n*n] head-averaged
  embed2d: { x: number; y: number }[]; // PCA of penultimate activations
  density: number; // edges / possible
}

export interface GNNHandle {
  model: GNN | null;
  data: GraphDataset | null;
}

const MAX_HISTORY = 600;

const EMPTY_METRICS: GNNMetrics = {
  step: 0,
  loss: NaN,
  trainAcc: NaN,
  valAcc: NaN,
  testAcc: NaN,
  gradNorm: NaN,
  lossHistory: [],
  trainAccHistory: [],
  valAccHistory: [],
  testAccHistory: [],
};

function paramsOf(cfg: GNNConfigUI): GraphParams {
  return {
    nodes: cfg.nodes,
    communities: cfg.communities,
    pIn: cfg.pIn,
    pOut: cfg.pOut,
    knnK: cfg.knnK,
    featDim: cfg.featDim,
    signal: cfg.signal,
    noise: cfg.noise,
    seed: cfg.seed,
  };
}

function specOf(cfg: GNNConfigUI, ds: GraphDataset): GNNSpec {
  return {
    inDim: ds.featDim,
    hidden: Array.from({ length: Math.max(1, cfg.hiddenLayers) }, () => cfg.hiddenDim),
    numClasses: ds.numClasses,
    conv: cfg.conv,
    activation: cfg.activation,
    dropout: cfg.dropout,
    heads: cfg.heads,
  };
}

// Stratified semi-supervised split: `labelsPerClass` nodes per class become the labeled
// training set; the rest are partitioned into validation and the held-out test set. The split
// is seeded so a fixed seed reproduces exactly the same labeled set.
function makeSplit(ds: GraphDataset, labelsPerClass: number, valFraction: number, seed: number): Uint8Array {
  const split = new Uint8Array(ds.n).fill(2); // default: test
  const rng = mulberry32((seed ^ 0x2f8b21a3) >>> 0);
  const byClass: number[][] = Array.from({ length: ds.numClasses }, () => []);
  for (let i = 0; i < ds.n; i++) byClass[ds.labels[i]].push(i);
  const rest: number[] = [];
  for (const group of byClass) {
    // shuffle the class members
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    const take = Math.min(labelsPerClass, Math.max(1, group.length - 1));
    for (let i = 0; i < group.length; i++) {
      if (i < take) split[group[i]] = 0; // train
      else rest.push(group[i]);
    }
  }
  // shuffle the remainder, carve out the validation slice
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const valN = Math.round(rest.length * valFraction);
  for (let i = 0; i < rest.length; i++) split[rest[i]] = i < valN ? 1 : 2;
  return split;
}

function accuracy(preds: Int32Array, labels: Int32Array, split: Uint8Array, which: number): number {
  let correct = 0;
  let total = 0;
  for (let i = 0; i < preds.length; i++) {
    if (split[i] !== which) continue;
    total++;
    if (preds[i] === labels[i]) correct++;
  }
  return total ? correct / total : NaN;
}

export function useGNNTrainer(cfg: GNNConfigUI) {
  const modelRef = useRef<GNN | null>(null);
  const dataRef = useRef<GraphDataset | null>(null);
  const adjRef = useRef<GraphAdj | null>(null);
  const xRef = useRef<Tensor | null>(null);
  const splitRef = useRef<Uint8Array>(new Uint8Array());
  const keepRef = useRef<Uint8Array>(new Uint8Array());
  const posRef = useRef<Float64Array>(new Float64Array());
  const optRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<GNNHandle>({ model: null, data: null });
  const [metrics, setMetrics] = useState<GNNMetrics>(EMPTY_METRICS);

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    nodes: cfg.nodes,
    communities: cfg.communities,
    pIn: cfg.pIn,
    pOut: cfg.pOut,
    knnK: cfg.knnK,
    featDim: cfg.featDim,
    signal: cfg.signal,
    noise: cfg.noise,
    seed: cfg.seed,
    conv: cfg.conv,
    hiddenDim: cfg.hiddenDim,
    hiddenLayers: cfg.hiddenLayers,
    heads: cfg.heads,
    activation: cfg.activation,
    dropout: cfg.dropout,
    labelsPerClass: cfg.labelsPerClass,
    valFraction: cfg.valFraction,
    useGraph: cfg.useGraph,
    optimizer: cfg.optimizer,
    loadId: cfg.loadId,
  });

  // Current predictions for every node, from an eval-mode forward.
  const inferAll = useCallback(() => {
    const model = modelRef.current;
    const x = xRef.current;
    const ds = dataRef.current;
    if (!model || !x || !ds) return null;
    const res = model.infer(x);
    const preds = new Int32Array(ds.n);
    const conf = new Float64Array(ds.n);
    const C = ds.numClasses;
    for (let i = 0; i < ds.n; i++) {
      let best = 0;
      let bestP = -Infinity;
      for (let j = 0; j < C; j++) {
        const p = res.probs[i * C + j];
        if (p > bestP) {
          bestP = p;
          best = j;
        }
      }
      preds[i] = best;
      conf[i] = bestP;
    }
    return { res, preds, conf };
  }, []);

  const recomputeMetrics = useCallback(
    (loss: number, gradNorm: number, push: boolean) => {
      const ds = dataRef.current;
      const inf = inferAll();
      if (!ds || !inf) return;
      const trainAcc = accuracy(inf.preds, ds.labels, splitRef.current, 0);
      const valAcc = accuracy(inf.preds, ds.labels, splitRef.current, 1);
      const testAcc = accuracy(inf.preds, ds.labels, splitRef.current, 2);
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const trainAccHistory = cap(m.trainAccHistory);
        const valAccHistory = cap(m.valAccHistory);
        const testAccHistory = cap(m.testAccHistory);
        if (push) {
          lossHistory.push(loss);
          trainAccHistory.push(trainAcc);
          valAccHistory.push(valAcc);
          testAccHistory.push(testAcc);
        }
        return {
          step: stepRef.current,
          loss: Number.isFinite(loss) ? loss : m.loss,
          trainAcc,
          valAcc,
          testAcc,
          gradNorm: Number.isFinite(gradNorm) ? gradNorm : m.gradNorm,
          lossHistory,
          trainAccHistory,
          valAccHistory,
          testAccHistory,
        };
      });
    },
    [inferAll],
  );

  const buildAll = useCallback(() => {
    setRunning(false);
    const ds = makeGraphDataset(cfg.dataset, paramsOf(cfg));
    dataRef.current = ds;
    const adj = buildAdj(ds.n, ds.edges, cfg.useGraph);
    adjRef.current = adj;
    xRef.current = Tensor.fromFlat(ds.features.slice(), ds.n, ds.featDim, false);
    splitRef.current = makeSplit(ds, cfg.labelsPerClass, cfg.valFraction, cfg.seed);
    const keep = new Uint8Array(ds.n);
    for (let i = 0; i < ds.n; i++) keep[i] = splitRef.current[i] === 0 ? 1 : 0;
    keepRef.current = keep;
    posRef.current = ds.positions ? ds.positions.slice() : forceLayout(ds.n, ds.edges, { seed: cfg.seed });

    const model = new GNN(specOf(cfg, ds), adj, mulberry32(cfg.seed ^ 0x1f123bb5));
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      if (model.importWeights(pendingWeights.current)) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, data: ds });
    setMetrics(EMPTY_METRICS);
    recomputeMetrics(NaN, NaN, false);
    setTick((t) => t + 1);
  }, [cfg, recomputeMetrics]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  useEffect(() => {
    if (optRef.current) {
      optRef.current.cfg.lr = cfg.lr;
      optRef.current.cfg.weightDecay = cfg.weightDecay;
    }
  }, [cfg.lr, cfg.weightDecay]);

  const trainStep = useCallback(() => {
    const model = modelRef.current;
    const opt = optRef.current;
    const x = xRef.current;
    const ds = dataRef.current;
    if (!model || !opt || !x || !ds) return undefined;
    model.train();
    const logits = model.forward(x);
    const { loss } = maskedCrossEntropy(logits, ds.labels, keepRef.current);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.step();
    stepRef.current++;
    return { loss: loss.data[0], gradNorm };
  }, [cfg.clipNorm]);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: { loss: number; gradNorm: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      recomputeMetrics(last ? last.loss : NaN, last ? last.gradNorm : NaN, Boolean(last));
      frames++;
      if (frames % 2 === 0) setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, cfg.stepsPerFrame, trainStep, recomputeMetrics]);

  const start = useCallback(() => setRunning(true), []);
  const pause = useCallback(() => {
    setRunning(false);
    setTick((t) => t + 1);
  }, []);
  const reset = useCallback(() => {
    setRunning(false);
    buildAll();
  }, [buildAll]);
  const stepOnce = useCallback(() => {
    const last = trainStep();
    recomputeMetrics(last ? last.loss : NaN, last ? last.gradNorm : NaN, Boolean(last));
    setTick((t) => t + 1);
  }, [trainStep, recomputeMetrics]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    const x = xRef.current;
    const ds = dataRef.current;
    if (!model || !x || !ds) return null;
    model.eval(); // freeze dropout so the loss is a deterministic function of the params
    return gradCheck(model.parameters(), () => maskedCrossEntropy(model.forward(x), ds.labels, keepRef.current).loss, {
      samplesPerParam: 3,
    });
  }, []);

  // ---- visualization query ----------------------------------------------------------
  const nodeView = useCallback((): NodeView | null => {
    const ds = dataRef.current;
    const inf = inferAll();
    if (!ds || !inf) return null;
    // PCA of the penultimate embeddings down to 2-D
    const D = inf.res.embDim;
    const rows: Float64Array[] = [];
    for (let i = 0; i < ds.n; i++) rows.push(inf.res.embeddings.slice(i * D, i * D + D));
    const embed2d = D >= 2 ? pca2d(rows, D, cfg.seed).points : Array.from({ length: ds.n }, () => ({ x: 0, y: 0 }));
    const possible = (ds.n * (ds.n - 1)) / 2;
    return {
      n: ds.n,
      numClasses: ds.numClasses,
      classNames: ds.classNames,
      positions: posRef.current,
      edges: ds.edges,
      labels: ds.labels,
      preds: inf.preds,
      confidence: inf.conf,
      split: splitRef.current,
      attention: inf.res.attention,
      embed2d,
      density: possible ? ds.edges.length / possible : 0,
    };
  }, [inferAll, cfg.seed]);

  const snapshot = useCallback(() => {
    const model = modelRef.current;
    return { weights: model ? model.exportWeights() : [], step: stepRef.current };
  }, []);

  const prepareLoad = useCallback((weights: number[], step: number) => {
    pendingWeights.current = weights;
    pendingStep.current = step;
  }, []);

  return {
    running,
    tick,
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    nodeView,
    snapshot,
    prepareLoad,
  };
}
