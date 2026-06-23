import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { KAN, type KANSpec, type LayerCurves } from '../engine/kan';
import {
  makeClassDataset,
  makeRegressionDataset,
  splitIndices,
  type ClassDataset,
  type RegressionDataset,
  type ClassDatasetKind,
  type RegressionKind,
} from '../engine/data';
import { mulberry32 } from '../engine/nn';
import { softmaxCrossEntropy, mse } from '../engine/losses';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';

export type KANTask = 'classify' | 'regress';

export interface KANConfigUI {
  task: KANTask;
  classDataset: ClassDatasetKind;
  regDataset: RegressionKind;
  n: number;
  noise: number;
  seed: number;
  hiddenLayers: number;
  hiddenDim: number;
  gridSize: number;
  degree: number;
  domain: number;
  valFraction: number;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  clipNorm: number;
  stepsPerFrame: number;
  loadId: number;
}

export interface KANMetrics {
  step: number;
  loss: number;
  trainScore: number; // classify: accuracy · regress: R²
  valScore: number;
  gridSize: number;
  gradNorm: number;
  lossHistory: number[];
  valLossHistory: number[];
  trainScoreHistory: number[];
  valScoreHistory: number[];
}

export interface KANHandle {
  model: KAN | null;
  task: KANTask;
  classData: ClassDataset | null;
  regData: RegressionDataset | null;
}

export interface BoundaryView {
  res: number;
  domain: number;
  classes: number;
  field: Int8Array; // [res*res] argmax class
  conf: Float64Array; // [res*res] max prob
  X: Float64Array;
  y: Int32Array;
  n: number;
  split: Uint8Array;
}

export interface FitView {
  domain: number;
  xs: Float64Array; // model sample abscissae
  ys: Float64Array; // model prediction
  X: Float64Array; // data x
  y: Float64Array; // data target
  n: number;
  split: Uint8Array;
}

const MAX_HISTORY = 600;
const BOUNDARY_RES = 80;

const EMPTY: KANMetrics = {
  step: 0,
  loss: NaN,
  trainScore: NaN,
  valScore: NaN,
  gridSize: 0,
  gradNorm: NaN,
  lossHistory: [],
  valLossHistory: [],
  trainScoreHistory: [],
  valScoreHistory: [],
};

function specOf(cfg: KANConfigUI, classes: number): KANSpec {
  return {
    inDim: cfg.task === 'classify' ? 2 : 1,
    hidden: Array.from({ length: Math.max(0, cfg.hiddenLayers) }, () => cfg.hiddenDim),
    outDim: cfg.task === 'classify' ? classes : 1,
    gridSize: cfg.gridSize,
    degree: cfg.degree,
    domain: cfg.domain,
  };
}

export function useKANTrainer(cfg: KANConfigUI) {
  const modelRef = useRef<KAN | null>(null);
  const classRef = useRef<ClassDataset | null>(null);
  const regRef = useRef<RegressionDataset | null>(null);
  const splitRef = useRef<Uint8Array>(new Uint8Array());
  const trainXRef = useRef<Tensor | null>(null);
  const trainYClsRef = useRef<Int32Array>(new Int32Array());
  const trainYRegRef = useRef<Tensor | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const gridRef = useRef(cfg.gridSize);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<KANHandle>({ model: null, task: cfg.task, classData: null, regData: null });
  const [metrics, setMetrics] = useState<KANMetrics>(EMPTY);

  // A rebuild key: any of these changing tears the model down and starts fresh. Grid size is
  // deliberately NOT here — it's mutated live via refine/refit, preserving the learned curves.
  const structKey = JSON.stringify({
    task: cfg.task,
    classDataset: cfg.classDataset,
    regDataset: cfg.regDataset,
    n: cfg.n,
    noise: cfg.noise,
    seed: cfg.seed,
    hiddenLayers: cfg.hiddenLayers,
    hiddenDim: cfg.hiddenDim,
    gridSize: cfg.gridSize,
    degree: cfg.degree,
    domain: cfg.domain,
    valFraction: cfg.valFraction,
    optimizer: cfg.optimizer,
    loadId: cfg.loadId,
  });

  const recomputeMetrics = useCallback((loss: number, gradNorm: number, push: boolean) => {
    const model = modelRef.current;
    if (!model) return;
    let trainScore = NaN;
    let valScore = NaN;
    let valLoss = NaN;
    if (cfg.task === 'classify') {
      const ds = classRef.current;
      if (!ds) return;
      const { out } = model.infer(ds.X, ds.n);
      const C = ds.classes;
      let trC = 0;
      let trN = 0;
      let vaC = 0;
      let vaN = 0;
      let vLossSum = 0;
      for (let i = 0; i < ds.n; i++) {
        let best = 0;
        let bv = -Infinity;
        let max = -Infinity;
        for (let c = 0; c < C; c++) max = Math.max(max, out[i * C + c]);
        let sum = 0;
        for (let c = 0; c < C; c++) sum += Math.exp(out[i * C + c] - max);
        for (let c = 0; c < C; c++) {
          const v = out[i * C + c];
          if (v > bv) {
            bv = v;
            best = c;
          }
        }
        const correct = best === ds.y[i] ? 1 : 0;
        if (splitRef.current[i] === 1) {
          vaN++;
          vaC += correct;
          vLossSum += -(out[i * C + ds.y[i]] - max - Math.log(sum));
        } else {
          trN++;
          trC += correct;
        }
      }
      trainScore = trN ? trC / trN : NaN;
      valScore = vaN ? vaC / vaN : NaN;
      valLoss = vaN ? vLossSum / vaN : NaN;
    } else {
      const ds = regRef.current;
      if (!ds) return;
      const { out } = model.infer(ds.X, ds.n);
      // R² and val MSE over each split.
      let trMeanN = 0;
      let trMean = 0;
      let vaMeanN = 0;
      let vaMean = 0;
      for (let i = 0; i < ds.n; i++) {
        if (splitRef.current[i] === 1) {
          vaMean += ds.y[i];
          vaMeanN++;
        } else {
          trMean += ds.y[i];
          trMeanN++;
        }
      }
      trMean = trMeanN ? trMean / trMeanN : 0;
      vaMean = vaMeanN ? vaMean / vaMeanN : 0;
      let trRes = 0;
      let trTot = 0;
      let vaRes = 0;
      let vaTot = 0;
      let vLossSum = 0;
      for (let i = 0; i < ds.n; i++) {
        const r = out[i] - ds.y[i];
        if (splitRef.current[i] === 1) {
          vaRes += r * r;
          vaTot += (ds.y[i] - vaMean) ** 2;
          vLossSum += r * r;
        } else {
          trRes += r * r;
          trTot += (ds.y[i] - trMean) ** 2;
        }
      }
      trainScore = trTot > 0 ? 1 - trRes / trTot : NaN;
      valScore = vaTot > 0 ? 1 - vaRes / vaTot : NaN;
      valLoss = vaMeanN ? vLossSum / vaMeanN : NaN;
    }
    setMetrics((m) => {
      const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
      const lossHistory = cap(m.lossHistory);
      const valLossHistory = cap(m.valLossHistory);
      const trainScoreHistory = cap(m.trainScoreHistory);
      const valScoreHistory = cap(m.valScoreHistory);
      if (push) {
        lossHistory.push(loss);
        valLossHistory.push(valLoss);
        trainScoreHistory.push(trainScore);
        valScoreHistory.push(valScore);
      }
      return {
        step: stepRef.current,
        loss: Number.isFinite(loss) ? loss : m.loss,
        trainScore,
        valScore,
        gridSize: gridRef.current,
        gradNorm: Number.isFinite(gradNorm) ? gradNorm : m.gradNorm,
        lossHistory,
        valLossHistory,
        trainScoreHistory,
        valScoreHistory,
      };
    });
  }, [cfg.task]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const rng = mulberry32(cfg.seed ^ 0x7ab12c3d);
    let classes = 2;
    if (cfg.task === 'classify') {
      const ds = makeClassDataset(cfg.classDataset, cfg.n, cfg.noise, cfg.seed);
      classRef.current = ds;
      regRef.current = null;
      classes = ds.classes;
      const split = splitMake(ds.n, cfg.valFraction, cfg.seed);
      splitRef.current = split;
      // Train tensor: only the training-split points (full-batch).
      const trIdx: number[] = [];
      for (let i = 0; i < ds.n; i++) if (split[i] !== 1) trIdx.push(i);
      const xd = new Float64Array(trIdx.length * 2);
      const yd = new Int32Array(trIdx.length);
      for (let k = 0; k < trIdx.length; k++) {
        xd[k * 2] = ds.X[trIdx[k] * 2];
        xd[k * 2 + 1] = ds.X[trIdx[k] * 2 + 1];
        yd[k] = ds.y[trIdx[k]];
      }
      trainXRef.current = Tensor.fromFlat(xd, trIdx.length, 2, false);
      trainYClsRef.current = yd;
      trainYRegRef.current = null;
    } else {
      const ds = makeRegressionDataset(cfg.regDataset, cfg.n, cfg.noise, cfg.seed);
      regRef.current = ds;
      classRef.current = null;
      const split = splitMake(ds.n, cfg.valFraction, cfg.seed);
      splitRef.current = split;
      const trIdx: number[] = [];
      for (let i = 0; i < ds.n; i++) if (split[i] !== 1) trIdx.push(i);
      const xd = new Float64Array(trIdx.length);
      const yd = new Float64Array(trIdx.length);
      for (let k = 0; k < trIdx.length; k++) {
        xd[k] = ds.X[trIdx[k]];
        yd[k] = ds.y[trIdx[k]];
      }
      trainXRef.current = Tensor.fromFlat(xd, trIdx.length, 1, false);
      trainYRegRef.current = Tensor.fromFlat(yd, trIdx.length, 1, false);
      trainYClsRef.current = new Int32Array();
    }

    const model = new KAN(specOf(cfg, classes), rng);
    modelRef.current = model;
    gridRef.current = cfg.gridSize;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      if (model.importWeights(pendingWeights.current)) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, task: cfg.task, classData: classRef.current, regData: regRef.current });
    setMetrics({ ...EMPTY, gridSize: gridRef.current });
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
    const x = trainXRef.current;
    if (!model || !opt || !x) return undefined;
    let loss: Tensor;
    if (cfg.task === 'classify') {
      loss = softmaxCrossEntropy(model.forward(x), trainYClsRef.current).loss;
    } else {
      loss = mse(model.forward(x), trainYRegRef.current!);
    }
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.step();
    stepRef.current++;
    return { loss: loss.data[0], gradNorm };
  }, [cfg.task, cfg.clipNorm]);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    const frame = () => {
      if (!alive) return;
      let last: { loss: number; gradNorm: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      recomputeMetrics(last ? last.loss : NaN, last ? last.gradNorm : NaN, Boolean(last));
      setTick((t) => t + 1);
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

  // Rebuild the optimizer after the parameter *shapes* change (a grid resize re-allocates the
  // coefficient tensors), preserving the learning rate / decay but resetting moment buffers.
  const rebuildOptimizer = useCallback(() => {
    const model = modelRef.current;
    if (!model) return;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
  }, [cfg.optimizer, cfg.lr, cfg.weightDecay]);

  // Grid extension: change spline resolution while preserving the learned functions.
  const setGridSize = useCallback(
    (g: number) => {
      const model = modelRef.current;
      if (!model) return;
      const applied = model.setGridSize(g);
      gridRef.current = applied;
      rebuildOptimizer();
      recomputeMetrics(NaN, NaN, false);
      setTick((t) => t + 1);
    },
    [rebuildOptimizer, recomputeMetrics],
  );

  // Re-centre every layer's grid onto the activations it actually receives, refitting curves.
  const fitGridToData = useCallback(() => {
    const model = modelRef.current;
    const ds = cfg.task === 'classify' ? classRef.current : regRef.current;
    if (!model || !ds) return;
    const xData = cfg.task === 'classify' ? (ds as ClassDataset).X : (ds as RegressionDataset).X;
    const rows = ds.n;
    const { acts } = model.infer(xData, rows);
    model.fitGridToData(acts, rows);
    rebuildOptimizer();
    recomputeMetrics(NaN, NaN, false);
    setTick((t) => t + 1);
  }, [cfg.task, rebuildOptimizer, recomputeMetrics]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    const x = trainXRef.current;
    if (!model || !x) return null;
    return gradCheck(
      model.parameters(),
      () =>
        cfg.task === 'classify'
          ? softmaxCrossEntropy(model.forward(x), trainYClsRef.current).loss
          : mse(model.forward(x), trainYRegRef.current!),
      { samplesPerParam: 3 },
    );
  }, [cfg.task]);

  // ---- visualization queries --------------------------------------------------------

  const boundaryView = useCallback((): BoundaryView | null => {
    const model = modelRef.current;
    const ds = classRef.current;
    if (!model || !ds || cfg.task !== 'classify') return null;
    const R = BOUNDARY_RES;
    const D = cfg.domain;
    const grid = new Float64Array(R * R * 2);
    let p = 0;
    for (let yy = 0; yy < R; yy++) {
      const gy = D - (yy / (R - 1)) * 2 * D;
      for (let xx = 0; xx < R; xx++) {
        grid[p++] = -D + (xx / (R - 1)) * 2 * D;
        grid[p++] = gy;
      }
    }
    const { out } = model.infer(grid, R * R);
    const C = ds.classes;
    const field = new Int8Array(R * R);
    const conf = new Float64Array(R * R);
    for (let i = 0; i < R * R; i++) {
      let max = -Infinity;
      for (let c = 0; c < C; c++) max = Math.max(max, out[i * C + c]);
      let sum = 0;
      let best = 0;
      let bv = -Infinity;
      for (let c = 0; c < C; c++) {
        const e = Math.exp(out[i * C + c] - max);
        sum += e;
        if (out[i * C + c] > bv) {
          bv = out[i * C + c];
          best = c;
        }
      }
      field[i] = best;
      conf[i] = Math.exp(bv - max) / sum;
    }
    return { res: R, domain: D, classes: C, field, conf, X: ds.X, y: ds.y, n: ds.n, split: splitRef.current };
  }, [cfg.task, cfg.domain]);

  const fitView = useCallback((): FitView | null => {
    const model = modelRef.current;
    const ds = regRef.current;
    if (!model || !ds || cfg.task !== 'regress') return null;
    const M = 200;
    const D = cfg.domain;
    const xs = new Float64Array(M);
    const xinput = new Float64Array(M);
    for (let m = 0; m < M; m++) {
      const x = -D + (2 * D * m) / (M - 1);
      xs[m] = x;
      xinput[m] = x;
    }
    const { out } = model.infer(xinput, M);
    const ys = out.slice(0, M);
    return { domain: D, xs, ys, X: ds.X, y: ds.y, n: ds.n, split: splitRef.current };
  }, [cfg.task, cfg.domain]);

  const diagram = useCallback((): LayerCurves[] | null => {
    const model = modelRef.current;
    if (!model) return null;
    return model.layerCurves(40);
  }, []);

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
    setGridSize,
    fitGridToData,
    runGradCheck,
    boundaryView,
    fitView,
    diagram,
    snapshot,
    prepareLoad,
  };
}

// Train/val split as a per-point mask (0 = train, 1 = val). Mirrors the playground's split.
function splitMake(n: number, valFraction: number, seed: number): Uint8Array {
  const { val } = splitIndices(n, valFraction, seed);
  const mask = new Uint8Array(n);
  for (let i = 0; i < val.length; i++) mask[val[i]] = 1;
  return mask;
}
