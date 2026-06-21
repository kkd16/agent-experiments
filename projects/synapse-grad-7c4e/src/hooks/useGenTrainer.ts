import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { VAE, VAE_PRESETS, sampleNoise, klDivStandardNormal } from '../engine/vae';
import { mulberry32, type Activation } from '../engine/nn';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { bceWithLogits } from '../engine/losses';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { makeImageDataset, datasetMeta, type ImageDataset, type VisionDatasetKind } from '../engine/images';
import { pca2d } from '../lib/pca';

export interface GenConfig {
  dataset: VisionDatasetKind;
  imgSize: number;
  samples: number;
  noise: number;
  jitter: number;
  seed: number;
  latent: number;
  presetId: string;
  activation: Activation;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  beta: number;
  batchSize: number;
  stepsPerFrame: number;
  valFraction: number;
  scheduleKind: ScheduleKind;
  schedulePeriod: number;
  scheduleWarmup: number;
  clipNorm: number;
  manifoldN: number;
  manifoldSpan: number;
  loadId: number;
}

export interface GenMetrics {
  step: number;
  loss: number;
  recon: number;
  kl: number;
  valLoss: number;
  gradNorm: number;
  lr: number;
  lossHistory: number[];
  reconHistory: number[];
  klHistory: number[];
  valLossHistory: number[];
}

export interface GenHandle {
  model: VAE | null;
  data: ImageDataset | null;
  classes: number;
  labels: string[];
  imgSize: number;
  latent: number;
}

export interface ScatterPoint {
  x: number;
  y: number;
  cls: number;
}

// The encoded-latent summary used by both the scatter and the manifold sweep: every (capped)
// sample's mean projected onto the top-2 PCA axes, plus those axes (in full latent space) and
// the per-axis spread so the manifold can sweep a sensible window.
interface LatentInfo {
  points: ScatterPoint[];
  axisU: Float64Array;
  axisV: Float64Array;
  mean: Float64Array;
  stdU: number;
  stdV: number;
}

const MAX_HISTORY = 600;
const EVAL_CAP = 160;
const SCATTER_CAP = 260;

const EMPTY_METRICS: GenMetrics = {
  step: 0,
  loss: NaN,
  recon: NaN,
  kl: NaN,
  valLoss: NaN,
  gradNorm: NaN,
  lr: NaN,
  lossHistory: [],
  reconHistory: [],
  klHistory: [],
  valLossHistory: [],
};

function presetHidden(id: string): number[] {
  return (VAE_PRESETS.find((p) => p.id === id) ?? VAE_PRESETS[1]).hidden;
}

function scheduleOf(cfg: GenConfig): ScheduleConfig {
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

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function useGenTrainer(cfg: GenConfig) {
  const modelRef = useRef<VAE | null>(null);
  const dataRef = useRef<ImageDataset | null>(null);
  const targetRef = useRef<Float64Array>(new Float64Array()); // pixels mapped to [0,1] for BCE
  const trainIdxRef = useRef<Int32Array>(new Int32Array());
  const valIdxRef = useRef<Int32Array>(new Int32Array());
  const orderRef = useRef<Int32Array>(new Int32Array());
  const optRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const cursor = useRef(0);
  const shuffleRng = useRef<() => number>(() => 0);
  const noiseRng = useRef<() => number>(() => Math.random());
  const latentRef = useRef<LatentInfo | null>(null);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<GenHandle>({ model: null, data: null, classes: 1, labels: [], imgSize: cfg.imgSize, latent: cfg.latent });
  const [metrics, setMetrics] = useState<GenMetrics>(EMPTY_METRICS);

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    imgSize: cfg.imgSize,
    samples: cfg.samples,
    noise: cfg.noise,
    jitter: cfg.jitter,
    seed: cfg.seed,
    latent: cfg.latent,
    presetId: cfg.presetId,
    activation: cfg.activation,
    optimizer: cfg.optimizer,
    valFraction: cfg.valFraction,
    loadId: cfg.loadId,
  });

  // Build an input tensor [k, px] and its [0,1] target tensor from dataset indices.
  const batchTensors = useCallback((idx: Int32Array, start: number, count: number): { x: Tensor; target: Tensor } => {
    const ds = dataRef.current!;
    const px = ds.size * ds.size;
    const Xb = new Float64Array(count * px);
    const Tb = new Float64Array(count * px);
    const T = targetRef.current;
    for (let i = 0; i < count; i++) {
      const di = idx[start + i];
      Xb.set(ds.X.subarray(di * px, di * px + px), i * px);
      Tb.set(T.subarray(di * px, di * px + px), i * px);
    }
    return { x: Tensor.fromFlat(Xb, count, px), target: Tensor.fromFlat(Tb, count, px) };
  }, []);

  // Deterministic eval (z = μ): reconstruction + KL + total ELBO on a capped slice.
  const evalOn = useCallback(
    (idx: Int32Array): { loss: number; recon: number; kl: number } => {
      const model = modelRef.current;
      if (!model || idx.length === 0) return { loss: NaN, recon: NaN, kl: NaN };
      const k = Math.min(idx.length, EVAL_CAP);
      const { x, target } = batchTensors(idx, 0, k);
      const { mu, logvar } = model.encode(x);
      const logits = model.decode(mu);
      const recon = bceWithLogits(logits, target).data[0];
      const kl = klDivStandardNormal(mu, logvar).data[0];
      return { recon, kl, loss: recon + cfg.beta * kl };
    },
    [batchTensors, cfg.beta],
  );

  // Encode a capped subset, project the means to 2-D via PCA, and cache for the viz views.
  const refreshLatent = useCallback(() => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return;
    const src = trainIdxRef.current.length ? trainIdxRef.current : valIdxRef.current;
    const k = Math.min(src.length, SCATTER_CAP);
    if (k === 0) return;
    const { x } = batchTensors(src, 0, k);
    const { mu } = model.encode(x);
    const L = cfg.latent;
    const rows: Float64Array[] = [];
    for (let i = 0; i < k; i++) rows.push(mu.data.slice(i * L, i * L + L));
    const pca = pca2d(rows, L, cfg.seed ^ 0x51ed);
    const points: ScatterPoint[] = pca.points.map((p, i) => ({ x: p.x, y: p.y, cls: ds.y[src[i]] }));
    let su = 0;
    let sv = 0;
    for (const p of points) {
      su += p.x * p.x;
      sv += p.y * p.y;
    }
    su = Math.sqrt(su / Math.max(1, points.length));
    sv = Math.sqrt(sv / Math.max(1, points.length));
    latentRef.current = { points, axisU: pca.axisU, axisV: pca.axisV, mean: pca.mean, stdU: su || 1, stdV: sv || 1 };
  }, [batchTensors, cfg.latent, cfg.seed]);

  const seedMetrics = useCallback(() => {
    const tr = evalOn(trainIdxRef.current);
    const va = valIdxRef.current.length ? evalOn(valIdxRef.current) : { loss: NaN, recon: NaN, kl: NaN };
    setMetrics({
      ...EMPTY_METRICS,
      step: stepRef.current,
      loss: tr.loss,
      recon: tr.recon,
      kl: tr.kl,
      valLoss: va.loss,
      lr: cfg.lr,
      lossHistory: [tr.loss],
      reconHistory: [tr.recon],
      klHistory: [tr.kl],
      valLossHistory: [va.loss],
    });
    refreshLatent();
  }, [evalOn, cfg.lr, refreshLatent]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const meta = datasetMeta(cfg.dataset);
    const ds = makeImageDataset(cfg.dataset, cfg.samples, cfg.noise, cfg.jitter, cfg.imgSize, cfg.seed);
    dataRef.current = ds;
    const T = new Float64Array(ds.X.length);
    for (let i = 0; i < T.length; i++) T[i] = Math.max(0, Math.min(1, ds.X[i] + 0.5));
    targetRef.current = T;

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
    noiseRng.current = mulberry32(cfg.seed ^ 0xb1a5);

    const rng = mulberry32(cfg.seed);
    const model = new VAE(
      { px: cfg.imgSize * cfg.imgSize, hidden: presetHidden(cfg.presetId), latent: cfg.latent, activation: cfg.activation },
      rng,
    );
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, data: ds, classes: meta.classes, labels: ds.labels, imgSize: cfg.imgSize, latent: cfg.latent });
    seedMetrics();
    setTick((t) => t + 1);
  }, [
    cfg.dataset,
    cfg.imgSize,
    cfg.samples,
    cfg.noise,
    cfg.jitter,
    cfg.seed,
    cfg.latent,
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
    const { x, target } = batchTensors(order, cursor.current, bs);
    cursor.current += bs;
    const eps = sampleNoise(bs, cfg.latent, noiseRng.current);
    const { logits, mu, logvar } = model.forward(x, eps);
    const recon = bceWithLogits(logits, target);
    const kl = klDivStandardNormal(mu, logvar);
    const loss = recon.add(kl.scale(cfg.beta));
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.cfg.lr = lrAt(scheduleOf(cfg), stepRef.current);
    opt.step();
    stepRef.current++;
    return { gradNorm, lr: opt.cfg.lr, recon: recon.data[0], kl: kl.data[0], loss: loss.data[0] };
  }, [cfg, batchTensors]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; lr: number; recon: number; kl: number; loss: number } | undefined) => {
      const va = valIdxRef.current.length ? evalOn(valIdxRef.current) : { loss: NaN, recon: NaN, kl: NaN };
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const reconHistory = cap(m.reconHistory);
        const klHistory = cap(m.klHistory);
        const valLossHistory = cap(m.valLossHistory);
        if (last) {
          lossHistory.push(last.loss);
          reconHistory.push(last.recon);
          klHistory.push(last.kl);
          valLossHistory.push(va.loss);
        }
        return {
          step: stepRef.current,
          loss: last ? last.loss : m.loss,
          recon: last ? last.recon : m.recon,
          kl: last ? last.kl : m.kl,
          valLoss: va.loss,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          lr: last ? last.lr : m.lr,
          lossHistory,
          reconHistory,
          klHistory,
          valLossHistory,
        };
      });
    },
    [evalOn],
  );

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: { gradNorm: number; lr: number; recon: number; kl: number; loss: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      pushMetrics(last);
      frames++;
      if (frames % 4 === 0) {
        refreshLatent();
        setTick((t) => t + 1);
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, cfg.stepsPerFrame, trainStep, pushMetrics, refreshLatent]);

  const start = useCallback(() => setRunning(true), []);
  const pause = useCallback(() => {
    setRunning(false);
    refreshLatent();
    setTick((t) => t + 1);
  }, [refreshLatent]);
  const reset = useCallback(() => {
    setRunning(false);
    buildAll();
  }, [buildAll]);
  const stepOnce = useCallback(() => {
    const last = trainStep();
    pushMetrics(last);
    refreshLatent();
    setTick((t) => t + 1);
  }, [trainStep, pushMetrics, refreshLatent]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    const src = trainIdxRef.current.length ? trainIdxRef.current : new Int32Array([...Array(ds.n).keys()]);
    const k = Math.min(8, src.length);
    const { x, target } = batchTensors(src, 0, k);
    const eps = sampleNoise(k, cfg.latent, mulberry32(999));
    return gradCheck(
      model.parameters(),
      () => {
        const { logits, mu, logvar } = model.forward(x, eps);
        return bceWithLogits(logits, target).add(klDivStandardNormal(mu, logvar).scale(cfg.beta));
      },
      { samplesPerParam: 3 },
    );
  }, [batchTensors, cfg.latent, cfg.beta]);

  // ---- views ------------------------------------------------------------------------

  // Input vs. its (deterministic) reconstruction, in display range (ink ≈ +0.5).
  const reconstructionsFor = useCallback((indices: number[]): { input: Float64Array; recon: Float64Array }[] => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return [];
    const px = ds.size * ds.size;
    const k = indices.length;
    const Xb = new Float64Array(k * px);
    for (let i = 0; i < k; i++) Xb.set(ds.X.subarray(indices[i] * px, indices[i] * px + px), i * px);
    const x = Tensor.fromFlat(Xb, k, px);
    const { mu } = model.encode(x);
    const logits = model.decode(mu);
    const out: { input: Float64Array; recon: Float64Array }[] = [];
    for (let i = 0; i < k; i++) {
      const input = ds.X.slice(indices[i] * px, indices[i] * px + px);
      const recon = new Float64Array(px);
      for (let p = 0; p < px; p++) recon[p] = sigmoid(logits.data[i * px + p]) - 0.5;
      out.push({ input, recon });
    }
    return out;
  }, []);

  const latentScatter = useCallback((): { points: ScatterPoint[]; stdU: number; stdV: number } | null => {
    const info = latentRef.current;
    if (!info) return null;
    return { points: info.points, stdU: info.stdU, stdV: info.stdV };
  }, []);

  // Decode an n×n grid sweeping the latent plane spanned by the PCA axes (±span·σ).
  const decodeManifold = useCallback((n: number, span: number): { grids: Float64Array[]; n: number } | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    const info = latentRef.current;
    if (!model || !ds || !info) return null;
    const L = ds.size * ds.size;
    const Z = new Float64Array(n * n * cfg.latent);
    let r = 0;
    for (let gy = 0; gy < n; gy++) {
      const v = (gy / (n - 1) - 0.5) * 2 * span * info.stdV;
      for (let gx = 0; gx < n; gx++) {
        const u = (gx / (n - 1) - 0.5) * 2 * span * info.stdU;
        for (let d = 0; d < cfg.latent; d++) {
          Z[r * cfg.latent + d] = info.mean[d] + u * info.axisU[d] + v * info.axisV[d];
        }
        r++;
      }
    }
    const logits = model.decode(Tensor.fromFlat(Z, n * n, cfg.latent));
    const grids: Float64Array[] = [];
    for (let i = 0; i < n * n; i++) {
      const g = new Float64Array(L);
      for (let p = 0; p < L; p++) g[p] = sigmoid(logits.data[i * L + p]) - 0.5;
      grids.push(g);
    }
    return { grids, n };
  }, [cfg.latent]);

  // Decode one plane point (u, v in σ units along the PCA axes) — for the latent explorer.
  const decodePlanePoint = useCallback((u: number, v: number): Float64Array | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    const info = latentRef.current;
    if (!model || !ds || !info) return null;
    const L = ds.size * ds.size;
    const z = new Float64Array(cfg.latent);
    for (let d = 0; d < cfg.latent; d++) z[d] = info.mean[d] + u * info.stdU * info.axisU[d] + v * info.stdV * info.axisV[d];
    const logits = model.decode(Tensor.fromFlat(z, 1, cfg.latent));
    const g = new Float64Array(L);
    for (let p = 0; p < L; p++) g[p] = sigmoid(logits.data[p]) - 0.5;
    return g;
  }, [cfg.latent]);

  const priorSamples = useCallback((k: number, seed: number): Float64Array[] => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return [];
    const L = ds.size * ds.size;
    const z = sampleNoise(k, cfg.latent, mulberry32(seed));
    const logits = model.decode(z);
    const out: Float64Array[] = [];
    for (let i = 0; i < k; i++) {
      const g = new Float64Array(L);
      for (let p = 0; p < L; p++) g[p] = sigmoid(logits.data[i * L + p]) - 0.5;
      out.push(g);
    }
    return out;
  }, [cfg.latent]);

  // Linear interpolation between two samples' latent means, decoded to a strip of glyphs.
  const interpolate = useCallback((iA: number, iB: number, steps: number): { input: Float64Array; grids: Float64Array[]; inputB: Float64Array } | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    const px = ds.size * ds.size;
    const X2 = new Float64Array(2 * px);
    X2.set(ds.X.subarray(iA * px, iA * px + px), 0);
    X2.set(ds.X.subarray(iB * px, iB * px + px), px);
    const { mu } = model.encode(Tensor.fromFlat(X2, 2, px));
    const L = cfg.latent;
    const muA = mu.data.slice(0, L);
    const muB = mu.data.slice(L, 2 * L);
    const Z = new Float64Array(steps * L);
    for (let s = 0; s < steps; s++) {
      const t = steps > 1 ? s / (steps - 1) : 0;
      for (let d = 0; d < L; d++) Z[s * L + d] = muA[d] * (1 - t) + muB[d] * t;
    }
    const logits = model.decode(Tensor.fromFlat(Z, steps, L));
    const grids: Float64Array[] = [];
    for (let s = 0; s < steps; s++) {
      const g = new Float64Array(px);
      for (let p = 0; p < px; p++) g[p] = sigmoid(logits.data[s * px + p]) - 0.5;
      grids.push(g);
    }
    return { input: ds.X.slice(iA * px, iA * px + px), inputB: ds.X.slice(iB * px, iB * px + px), grids };
  }, [cfg.latent]);

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
    reconstructionsFor,
    latentScatter,
    decodeManifold,
    decodePlanePoint,
    priorSamples,
    interpolate,
  };
}
