import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { mulberry32 } from '../engine/nn';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm } from '../engine/optim';
import { makeImageDataset, datasetMeta, type ImageDataset, type VisionDatasetKind } from '../engine/images';
import {
  SNN,
  snnLoss,
  encodeInput,
  type SNNConfig,
  type SurrogateKind,
  type EncodingKind,
  type SNNTrace,
} from '../engine/snn';

export interface HiddenPreset {
  id: string;
  label: string;
  hidden: number[];
}

export const SNN_PRESETS: HiddenPreset[] = [
  { id: 'small', label: 'Small · [64]', hidden: [64] },
  { id: 'deep', label: 'Deep · [96,64]', hidden: [96, 64] },
  { id: 'wide', label: 'Wide · [128]', hidden: [128] },
];

export type TrainMode = 'hard' | 'soft';

export interface SnnUIConfig {
  dataset: VisionDatasetKind;
  imgSize: number;
  samples: number;
  noise: number;
  jitter: number;
  presetId: string;
  recurrent: boolean;
  T: number;
  beta: number;
  kappa: number;
  threshold: number;
  surrogate: SurrogateKind;
  slope: number;
  encoding: EncodingKind;
  currentScale: number;
  trainMode: TrainMode;
  rateReg: number;
  lr: number;
  batch: number;
  clipNorm: number;
  spotlight: number; // which held-out sample the raster/traces visualize
  seed: number;
  loadId: number;
}

export interface SnnMetrics {
  iter: number;
  examples: number;
  trainLoss: number;
  trainAcc: number;
  testAcc: number;
  meanRate: number; // spikes per hidden neuron per timestep (Hz-like)
  sparsity: number; // fraction of neuron·steps that are silent
  spikesPerInfer: number; // total hidden spikes for one forward (the "energy" proxy)
  layerRates: number[]; // mean firing rate per hidden layer
  gradNorm: number;
  confusion: number[]; // [classes*classes] row = true, col = pred (test set)
  lossHistory: number[];
  trainAccHistory: number[];
  testAccHistory: number[];
  rateHistory: number[];
}

const EMPTY: SnnMetrics = {
  iter: 0,
  examples: 0,
  trainLoss: NaN,
  trainAcc: NaN,
  testAcc: NaN,
  meanRate: NaN,
  sparsity: NaN,
  spikesPerInfer: NaN,
  layerRates: [],
  gradNorm: NaN,
  confusion: [],
  lossHistory: [],
  trainAccHistory: [],
  testAccHistory: [],
  rateHistory: [],
};

const MAX_HISTORY = 600;

export interface SnnHandle {
  net: SNN | null;
  classes: number;
  labels: string[];
  size: number;
}

function presetHidden(id: string): number[] {
  return (SNN_PRESETS.find((p) => p.id === id) ?? SNN_PRESETS[0]).hidden;
}

function toEngineConfig(c: SnnUIConfig, inDim: number, classes: number): SNNConfig {
  return {
    inDim,
    hidden: presetHidden(c.presetId),
    classes,
    T: c.T,
    beta: c.beta,
    kappa: c.kappa,
    threshold: c.threshold,
    surrogate: c.surrogate,
    slope: c.slope,
    recurrent: c.recurrent,
    seed: c.seed,
  };
}

// A deterministic train/test split of a freshly generated glyph dataset.
interface Split {
  ds: ImageDataset;
  trainIdx: Int32Array;
  testIdx: Int32Array;
  inDim: number;
  classes: number;
  labels: string[];
}

function makeSplit(c: SnnUIConfig): Split {
  const ds = makeImageDataset(c.dataset, c.samples, c.noise, c.jitter, c.imgSize, c.seed);
  const meta = datasetMeta(c.dataset);
  const rng = mulberry32(c.seed ^ 0x9e37);
  const order = Array.from({ length: ds.n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const nTest = Math.max(meta.classes, Math.floor(ds.n * 0.2));
  const testIdx = Int32Array.from(order.slice(0, nTest));
  const trainIdx = Int32Array.from(order.slice(nTest));
  return { ds, trainIdx, testIdx, inDim: ds.size * ds.size, classes: meta.classes, labels: meta.labels };
}

export function useSnnTrainer(cfg: SnnUIConfig) {
  const netRef = useRef<SNN | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const splitRef = useRef<Split | null>(null);
  const batchRng = useRef<() => number>(() => 0);
  const encRng = useRef<() => number>(() => 0);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const iterRef = useRef(0);
  const examplesRef = useRef(0);
  const lastStats = useRef<{ loss: number; gradNorm: number }>({ loss: NaN, gradNorm: NaN });
  const traceRef = useRef<SNNTrace | null>(null);
  const pendingWeights = useRef<number[] | null>(null);
  const cfgRef = useRef(cfg);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<SnnHandle>({ net: null, classes: 0, labels: [], size: cfg.imgSize });
  const [metrics, setMetrics] = useState<SnnMetrics>(EMPTY);

  useEffect(() => {
    cfgRef.current = cfg;
  });

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    imgSize: cfg.imgSize,
    samples: cfg.samples,
    noise: cfg.noise,
    jitter: cfg.jitter,
    presetId: cfg.presetId,
    recurrent: cfg.recurrent,
    T: cfg.T,
    beta: cfg.beta,
    kappa: cfg.kappa,
    threshold: cfg.threshold,
    surrogate: cfg.surrogate,
    slope: cfg.slope,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  // Encode one image (by dataset index) into input spike frames.
  const encodeSample = useCallback((idx: number): Tensor[] => {
    const sp = splitRef.current!;
    const c = cfgRef.current;
    const X = sp.ds.X.subarray(idx * sp.inDim, (idx + 1) * sp.inDim) as Float64Array;
    return encodeInput(X, 1, sp.inDim, c.T, c.encoding, c.currentScale, encRng.current);
  }, []);

  // Recompute the spotlight trace on the current net (no grad).
  const refreshTrace = useCallback(() => {
    const net = netRef.current;
    const sp = splitRef.current;
    if (!net || !sp || sp.testIdx.length === 0) return;
    const c = cfgRef.current;
    const which = ((c.spotlight % sp.testIdx.length) + sp.testIdx.length) % sp.testIdx.length;
    const idx = sp.testIdx[which];
    const frames = encodeSample(idx);
    const { trace } = net.forward(frames, true, { row: 0 });
    if (trace) {
      // annotate the true label onto the trace's logits view via a side field on pred is not needed;
      // the panel reads the true label from the handle+spotlight.
      traceRef.current = trace;
    }
  }, [encodeSample]);

  const buildAll = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    const c = cfgRef.current;
    const split = makeSplit(c);
    splitRef.current = split;
    const net = new SNN(toEngineConfig(c, split.inDim, split.classes));
    netRef.current = net;
    optRef.current = new Optimizer(net.parameters(), defaultOptimizer('adam', c.lr));
    batchRng.current = mulberry32(c.seed ^ 0x2b2b);
    encRng.current = mulberry32(c.seed ^ 0x7f7f);
    iterRef.current = 0;
    examplesRef.current = 0;
    lastStats.current = { loss: NaN, gradNorm: NaN };
    if (pendingWeights.current) {
      try {
        net.importWeights(pendingWeights.current);
      } catch {
        /* shape mismatch on load — ignore, keep fresh init */
      }
      pendingWeights.current = null;
    }
    refreshTrace();
    setHandle({ net, classes: split.classes, labels: split.labels, size: split.ds.size });
    setMetrics({ ...EMPTY });
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey, refreshTrace]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
  }, [buildAll]);

  // Live lr updates without a rebuild.
  useEffect(() => {
    if (optRef.current) optRef.current.cfg.lr = cfg.lr;
  }, [cfg.lr]);

  // One training iteration: a minibatch through BPTT.
  const trainIter = useCallback(() => {
    const net = netRef.current;
    const opt = optRef.current;
    const sp = splitRef.current;
    if (!net || !opt || !sp || sp.trainIdx.length === 0) return;
    const c = cfgRef.current;
    const B = Math.max(1, c.batch);
    const X = new Float64Array(B * sp.inDim);
    const y = new Int32Array(B);
    for (let i = 0; i < B; i++) {
      const idx = sp.trainIdx[Math.floor(batchRng.current() * sp.trainIdx.length)];
      y[i] = sp.ds.y[idx];
      X.set(sp.ds.X.subarray(idx * sp.inDim, (idx + 1) * sp.inDim), i * sp.inDim);
    }
    const frames = encodeInput(X, B, sp.inDim, c.T, c.encoding, c.currentScale, encRng.current);
    const { logits, spikeCount } = net.forward(frames, c.trainMode === 'hard');
    const { loss } = snnLoss(logits, y, spikeCount, c.T, c.rateReg);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(net.parameters(), c.clipNorm);
    opt.step();
    lastStats.current = { loss: loss.data[0], gradNorm };
    iterRef.current++;
    examplesRef.current += B;
  }, []);

  // Evaluate accuracy + confusion + firing statistics over the held-out set (hard spikes).
  const refreshMetrics = useCallback(() => {
    const net = netRef.current;
    const sp = splitRef.current;
    if (!net || !sp) return;
    const c = cfgRef.current;
    const K = sp.classes;
    const confusion = new Array(K * K).fill(0);
    let correct = 0;
    const hidden = presetHidden(c.presetId);
    const layerSpikeSum = new Array(hidden.length).fill(0);
    let totalNeuronSteps = 0;
    let totalSpikes = 0;
    const evalCap = Math.min(sp.testIdx.length, 120);
    for (let s = 0; s < evalCap; s++) {
      const idx = sp.testIdx[s];
      const frames = encodeSample(idx);
      const { trace } = net.forward(frames, true, { row: 0 });
      if (!trace) continue;
      const pred = trace.pred;
      const truth = sp.ds.y[idx];
      confusion[truth * K + pred]++;
      if (pred === truth) correct++;
      for (let l = 0; l < trace.layers.length; l++) {
        const layer = trace.layers[l];
        let sm = 0;
        for (const frame of layer.spikes) for (let j = 0; j < frame.length; j++) sm += frame[j];
        layerSpikeSum[l] += sm;
        totalSpikes += sm;
        totalNeuronSteps += layer.H * trace.T;
      }
    }
    const testAcc = evalCap ? correct / evalCap : NaN;
    const meanRate = totalNeuronSteps ? totalSpikes / totalNeuronSteps : NaN;
    const sparsity = 1 - meanRate;
    const spikesPerInfer = evalCap ? totalSpikes / evalCap : NaN;
    const layerRates = hidden.map((H, l) => (evalCap ? layerSpikeSum[l] / (evalCap * H * c.T) : NaN));

    // A quick train-accuracy probe on a small sample (hard spikes).
    let trCorrect = 0;
    const trCap = Math.min(sp.trainIdx.length, 80);
    for (let s = 0; s < trCap; s++) {
      const idx = sp.trainIdx[s];
      const frames = encodeSample(idx);
      const { trace } = net.forward(frames, true, { row: 0 });
      if (trace && trace.pred === sp.ds.y[idx]) trCorrect++;
    }
    const trainAcc = trCap ? trCorrect / trCap : NaN;

    refreshTrace();

    setMetrics((m) => {
      const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(arr.length - MAX_HISTORY + 1) : arr.slice());
      const lossHistory = cap(m.lossHistory);
      const trainAccHistory = cap(m.trainAccHistory);
      const testAccHistory = cap(m.testAccHistory);
      const rateHistory = cap(m.rateHistory);
      if (Number.isFinite(lastStats.current.loss)) lossHistory.push(lastStats.current.loss);
      trainAccHistory.push(trainAcc);
      testAccHistory.push(testAcc);
      if (Number.isFinite(meanRate)) rateHistory.push(meanRate);
      return {
        iter: iterRef.current,
        examples: examplesRef.current,
        trainLoss: lastStats.current.loss,
        trainAcc,
        testAcc,
        meanRate,
        sparsity,
        spikesPerInfer,
        layerRates,
        gradNorm: lastStats.current.gradNorm,
        confusion,
        lossHistory,
        trainAccHistory,
        testAccHistory,
        rateHistory,
      };
    });
  }, [encodeSample, refreshTrace]);

  // The always-on RAF loop.
  useEffect(() => {
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      if (runningRef.current) {
        const c = cfgRef.current;
        const iters = Math.max(1, c.batch >= 48 ? 1 : 2);
        for (let i = 0; i < iters; i++) trainIter();
        frames++;
        if (frames % 3 === 0) refreshMetrics();
      }
      setTick((t) => (t + 1) % 1000000);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [trainIter, refreshMetrics]);

  const start = useCallback(() => {
    runningRef.current = true;
    setRunning(true);
  }, []);
  const pause = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
  }, []);
  const reset = useCallback(() => buildAll(), [buildAll]);
  const stepOnce = useCallback(() => {
    trainIter();
    refreshMetrics();
    setTick((t) => t + 1);
  }, [trainIter, refreshMetrics]);

  // Re-render the spotlight when the user scrubs the spotlight index (no training needed).
  useEffect(() => {
    refreshTrace();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTick((t) => t + 1);
  }, [cfg.spotlight, cfg.encoding, cfg.currentScale, refreshTrace]);

  const trace = useCallback((): SNNTrace | null => traceRef.current, []);

  // The true label + dataset index of the current spotlight sample.
  const spotlightInfo = useCallback((): { idx: number; truth: number; which: number; count: number } => {
    const sp = splitRef.current;
    if (!sp || sp.testIdx.length === 0) return { idx: -1, truth: -1, which: 0, count: 0 };
    const c = cfgRef.current;
    const which = ((c.spotlight % sp.testIdx.length) + sp.testIdx.length) % sp.testIdx.length;
    const idx = sp.testIdx[which];
    return { idx, truth: sp.ds.y[idx], which, count: sp.testIdx.length };
  }, []);

  // Gradient-check the whole SNN end-to-end through BPTT on the smooth twin (finite differences of
  // the hard spike are ~0 by design). A small captured minibatch, current encoding (rng-free).
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const net = netRef.current;
    const sp = splitRef.current;
    if (!net || !sp) return null;
    const c = cfgRef.current;
    const B = 4;
    const X = new Float64Array(B * sp.inDim);
    const y = new Int32Array(B);
    for (let i = 0; i < B; i++) {
      const idx = sp.trainIdx[i % sp.trainIdx.length];
      y[i] = sp.ds.y[idx];
      X.set(sp.ds.X.subarray(idx * sp.inDim, (idx + 1) * sp.inDim), i * sp.inDim);
    }
    const frames = encodeInput(X, B, sp.inDim, c.T, 'current', c.currentScale, mulberry32(1));
    return gradCheck(
      net.parameters(),
      () => {
        const { logits, spikeCount } = net.forward(frames, false);
        return snnLoss(logits, y, spikeCount, c.T, c.rateReg).loss;
      },
      { samplesPerParam: 3 },
    );
  }, []);

  // Classify an arbitrary externally supplied glyph (e.g. the draw pad) and return its trace.
  const classify = useCallback((X: Float64Array): { trace: SNNTrace | null } => {
    const net = netRef.current;
    const sp = splitRef.current;
    if (!net || !sp) return { trace: null };
    const c = cfgRef.current;
    const frames = encodeInput(X, 1, sp.inDim, c.T, c.encoding, c.currentScale, encRng.current);
    const { trace } = net.forward(frames, true, { row: 0 });
    return { trace };
  }, []);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const net = netRef.current;
    return { weights: net ? net.exportWeights() : [], step: iterRef.current };
  }, []);
  const prepareLoad = useCallback((weights: number[]) => {
    pendingWeights.current = weights;
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
    trace,
    spotlightInfo,
    runGradCheck,
    classify,
    snapshot,
    prepareLoad,
  };
}
