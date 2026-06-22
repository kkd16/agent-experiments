import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { RealNVP, presetById, sampleNoise, LOG_2PI } from '../engine/flows';
import { makeFlowDataset, type FlowDataset, type FlowDatasetKind } from '../engine/flow-data';
import { mulberry32, type Activation } from '../engine/nn';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';

// The plane half-window the density / samples / warp are drawn over. The data is standardised
// to unit variance, so ±3.2 comfortably covers it and the Gaussian tails.
export const FLOW_VIEW = 3.2;
const D = 2;

export interface FlowConfigUI {
  dataset: FlowDatasetKind;
  samples: number;
  noise: number;
  seed: number;
  presetId: string;
  activation: Activation;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  valFraction: number;
  scheduleKind: ScheduleKind;
  schedulePeriod: number;
  scheduleWarmup: number;
  clipNorm: number;
  gridRes: number;
  sampleCount: number;
  loadId: number;
}

export interface FlowMetrics {
  step: number;
  nll: number; // mean negative log-likelihood, true nats
  bpd: number; // bits per dimension
  valNll: number;
  gradNorm: number;
  lr: number;
  nllHistory: number[];
  valNllHistory: number[];
}

export interface FlowHandle {
  model: RealNVP | null;
  data: FlowDataset | null;
  n: number;
  view: number;
}

const MAX_HISTORY = 600;
const EVAL_CAP = 512;
const SCATTER_CAP = 1500;

const EMPTY_METRICS: FlowMetrics = {
  step: 0,
  nll: NaN,
  bpd: NaN,
  valNll: NaN,
  gradNorm: NaN,
  lr: NaN,
  nllHistory: [],
  valNllHistory: [],
};

function scheduleOf(cfg: FlowConfigUI): ScheduleConfig {
  return { kind: cfg.scheduleKind, baseLr: cfg.lr, period: cfg.schedulePeriod, warmup: cfg.scheduleWarmup, gamma: 0.5, minFrac: 0.05 };
}

function shuffleInPlace(arr: Int32Array, rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

export function useFlowTrainer(cfg: FlowConfigUI) {
  const modelRef = useRef<RealNVP | null>(null);
  const dataRef = useRef<FlowDataset | null>(null);
  const trainIdxRef = useRef<Int32Array>(new Int32Array());
  const valIdxRef = useRef<Int32Array>(new Int32Array());
  const orderRef = useRef<Int32Array>(new Int32Array());
  const optRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const cursor = useRef(0);
  const shuffleRng = useRef<() => number>(() => 0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<FlowHandle>({ model: null, data: null, n: 0, view: FLOW_VIEW });
  const [metrics, setMetrics] = useState<FlowMetrics>(EMPTY_METRICS);

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    samples: cfg.samples,
    noise: cfg.noise,
    seed: cfg.seed,
    presetId: cfg.presetId,
    activation: cfg.activation,
    optimizer: cfg.optimizer,
    valFraction: cfg.valFraction,
    loadId: cfg.loadId,
  });

  // Build an input tensor [k, 2] from dataset indices.
  const batchTensor = useCallback((idx: Int32Array, start: number, count: number): Tensor => {
    const ds = dataRef.current!;
    const Xb = new Float64Array(count * D);
    for (let i = 0; i < count; i++) {
      const di = idx[start + i];
      Xb[i * D] = ds.X[di * D];
      Xb[i * D + 1] = ds.X[di * D + 1];
    }
    return Tensor.fromFlat(Xb, count, D);
  }, []);

  // Mean true NLL (nats) over a capped slice.
  const evalNll = useCallback((idx: Int32Array): number => {
    const model = modelRef.current;
    if (!model || idx.length === 0) return NaN;
    const k = Math.min(idx.length, EVAL_CAP);
    const x = batchTensor(idx, 0, k);
    const core = model.logProbCore(x); // [k,1]
    let s = 0;
    for (let i = 0; i < k; i++) s += core.data[i];
    return -(s / k) - model.logConst();
  }, [batchTensor]);

  const seedMetrics = useCallback(() => {
    const trNll = evalNll(trainIdxRef.current);
    const vaNll = valIdxRef.current.length ? evalNll(valIdxRef.current) : NaN;
    setMetrics({
      ...EMPTY_METRICS,
      step: stepRef.current,
      nll: trNll,
      bpd: trNll / (D * Math.LN2),
      valNll: vaNll,
      lr: cfg.lr,
      nllHistory: [trNll],
      valNllHistory: [vaNll],
    });
  }, [evalNll, cfg.lr]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const ds = makeFlowDataset(cfg.dataset, cfg.samples, cfg.noise, cfg.seed);
    dataRef.current = ds;

    const all = new Int32Array(ds.n);
    for (let i = 0; i < ds.n; i++) all[i] = i;
    shuffleInPlace(all, mulberry32(cfg.seed ^ 0x5bd1e995));
    const valN = Math.max(0, Math.min(ds.n - 1, Math.round(ds.n * cfg.valFraction)));
    valIdxRef.current = all.slice(0, valN);
    trainIdxRef.current = all.slice(valN);
    shuffleRng.current = mulberry32(cfg.seed ^ 0x1234);
    orderRef.current = trainIdxRef.current.slice();
    shuffleInPlace(orderRef.current, shuffleRng.current);
    cursor.current = 0;

    const preset = presetById(cfg.presetId);
    const model = new RealNVP({ D, hidden: preset.hidden, layers: preset.layers, activation: cfg.activation }, mulberry32(cfg.seed));
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, data: ds, n: ds.n, view: FLOW_VIEW });
    seedMetrics();
    setTick((t) => t + 1);
  }, [
    cfg.dataset,
    cfg.samples,
    cfg.noise,
    cfg.seed,
    cfg.presetId,
    cfg.activation,
    cfg.optimizer,
    cfg.lr,
    cfg.weightDecay,
    cfg.valFraction,
    seedMetrics,
  ]);

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
    if (!model || !opt) return;
    const order = orderRef.current;
    const bs = Math.min(cfg.batchSize, order.length);
    if (bs === 0) return;
    if (cursor.current + bs > order.length) {
      shuffleInPlace(order, shuffleRng.current);
      cursor.current = 0;
    }
    const x = batchTensor(order, cursor.current, bs);
    cursor.current += bs;
    const loss = model.nllLoss(x);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.cfg.lr = lrAt(scheduleOf(cfg), stepRef.current);
    opt.step();
    stepRef.current++;
    const nll = loss.data[0] - model.logConst();
    return { gradNorm, lr: opt.cfg.lr, nll };
  }, [cfg, batchTensor]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; lr: number; nll: number } | undefined) => {
      const vaNll = valIdxRef.current.length ? evalNll(valIdxRef.current) : NaN;
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const nllHistory = cap(m.nllHistory);
        const valNllHistory = cap(m.valNllHistory);
        if (last) {
          nllHistory.push(last.nll);
          valNllHistory.push(vaNll);
        }
        const nll = last ? last.nll : m.nll;
        return {
          step: stepRef.current,
          nll,
          bpd: nll / (D * Math.LN2),
          valNll: vaNll,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          lr: last ? last.lr : m.lr,
          nllHistory,
          valNllHistory,
        };
      });
    },
    [evalNll],
  );

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: { gradNorm: number; lr: number; nll: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      pushMetrics(last);
      frames++;
      if (frames % 5 === 0) setTick((t) => t + 1); // throttle the (heavier) density redraw
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, cfg.stepsPerFrame, trainStep, pushMetrics]);

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
    pushMetrics(last);
    setTick((t) => t + 1);
  }, [trainStep, pushMetrics]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    const src = trainIdxRef.current.length ? trainIdxRef.current : new Int32Array([...Array(ds.n).keys()]);
    const k = Math.min(16, src.length);
    const x = batchTensor(src, 0, k);
    return gradCheck(model.parameters(), () => model.nllLoss(x), { samplesPerParam: 3 });
  }, [batchTensor]);

  // ---- visualisation queries --------------------------------------------------------

  // The exact model density exp(log p) sampled on a res×res grid over the view window. The raw
  // (unnormalised) probabilities are returned with their max so the canvas can map them.
  const densityGrid = useCallback((res: number): { values: Float64Array; res: number; maxP: number } | null => {
    const model = modelRef.current;
    if (!model) return null;
    const coords = new Float64Array(res * res * D);
    let r = 0;
    for (let gy = 0; gy < res; gy++) {
      const y = FLOW_VIEW - (gy / (res - 1)) * 2 * FLOW_VIEW; // top → +view
      for (let gx = 0; gx < res; gx++) {
        const x = -FLOW_VIEW + (gx / (res - 1)) * 2 * FLOW_VIEW;
        coords[r * D] = x;
        coords[r * D + 1] = y;
        r++;
      }
    }
    const core = model.logProbCore(Tensor.fromFlat(coords, res * res, D));
    const c = model.logConst();
    const values = new Float64Array(res * res);
    let maxP = 0;
    for (let i = 0; i < res * res; i++) {
      const p = Math.exp(core.data[i] + c);
      values[i] = p;
      if (p > maxP) maxP = p;
    }
    return { values, res, maxP: maxP || 1 };
  }, []);

  // A capped copy of the data points for scatter overlays.
  const dataPoints = useCallback((): Float64Array | null => {
    const ds = dataRef.current;
    if (!ds) return null;
    const k = Math.min(ds.n, SCATTER_CAP);
    return ds.X.slice(0, k * D);
  }, []);

  // The pushforward of the data into latent space, z = f(x): a trained flow turns the data
  // cloud into a clean isotropic Gaussian — the visual proof the map is working.
  const latentScatter = useCallback((): Float64Array | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    const k = Math.min(ds.n, SCATTER_CAP);
    const x = batchTensor(new Int32Array([...Array(k).keys()]), 0, k);
    const { z } = model.forward(x);
    return z.data.slice(0, k * D);
  }, [batchTensor]);

  // Draw k samples from the model: z ~ N(0, I) → x = f⁻¹(z).
  const modelSamples = useCallback((k: number, seed: number): Float64Array | null => {
    const model = modelRef.current;
    if (!model) return null;
    const z = sampleNoise(k, D, mulberry32(seed));
    const x = model.inverse(z);
    return x.data.slice(0, k * D);
  }, []);

  // The bijection made visible: push a Cartesian grid of lines from latent space through the
  // inverse map and draw where they land in data space — the learned coordinate warp.
  const warpLines = useCallback((): { polylines: Float64Array[] } | null => {
    const model = modelRef.current;
    if (!model) return null;
    const lines = 11;
    const samplesPerLine = 48;
    const span = 2.6;
    const Z: number[] = [];
    // horizontal lines (constant z2), then vertical lines (constant z1)
    for (let li = 0; li < lines; li++) {
      const c = -span + (li / (lines - 1)) * 2 * span;
      for (let s = 0; s < samplesPerLine; s++) {
        const t = -span + (s / (samplesPerLine - 1)) * 2 * span;
        Z.push(t, c);
      }
    }
    for (let li = 0; li < lines; li++) {
      const c = -span + (li / (lines - 1)) * 2 * span;
      for (let s = 0; s < samplesPerLine; s++) {
        const t = -span + (s / (samplesPerLine - 1)) * 2 * span;
        Z.push(c, t);
      }
    }
    const total = Z.length / D;
    const x = model.inverse(Tensor.fromFlat(Float64Array.from(Z), total, D));
    const polylines: Float64Array[] = [];
    for (let li = 0; li < lines * 2; li++) {
      const pl = new Float64Array(samplesPerLine * D);
      for (let s = 0; s < samplesPerLine; s++) {
        const idx = li * samplesPerLine + s;
        pl[s * D] = x.data[idx * D];
        pl[s * D + 1] = x.data[idx * D + 1];
      }
      polylines.push(pl);
    }
    return { polylines };
  }, []);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
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
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    handle,
    snapshot,
    prepareLoad,
    densityGrid,
    dataPoints,
    latentScatter,
    modelSamples,
    warpLines,
  };
}

// Re-export so the panel can present the constant without importing the engine directly.
export { LOG_2PI };
