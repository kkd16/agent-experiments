import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { mulberry32 } from '../engine/nn';
import { sampleNoise } from '../engine/vae';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { mse } from '../engine/losses';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { makeImageDataset, datasetMeta, type ImageDataset, type VisionDatasetKind } from '../engine/images';
import {
  NoiseSchedule,
  Denoiser,
  DIFF_PRESETS,
  qSampleData,
  sinusoidalTimeEmbedding,
  ddimTimesteps,
  ddimStep,
  ddpmStep,
  predictX0,
  classifierFreeGuidance,
  type ScheduleKind as DiffScheduleKind,
} from '../engine/diffusion';

export type SamplerKind = 'ddim' | 'ddpm';

export interface DiffConfig {
  dataset: VisionDatasetKind;
  imgSize: number;
  samples: number;
  noise: number;
  jitter: number;
  seed: number;
  presetId: string;
  timeDim: number;
  diffSchedule: DiffScheduleKind; // the *noise* schedule (linear / cosine)
  T: number; // number of diffusion timesteps
  pUncond: number; // classifier-free label-dropout probability
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  valFraction: number;
  scheduleKind: ScheduleKind; // the *learning-rate* schedule
  schedulePeriod: number;
  scheduleWarmup: number;
  clipNorm: number;
  // sampling
  sampler: SamplerKind;
  samplingSteps: number; // DDIM step count
  eta: number; // DDIM stochasticity
  guidance: number; // classifier-free guidance strength
  loadId: number;
}

export interface DiffMetrics {
  step: number;
  loss: number;
  valLoss: number;
  gradNorm: number;
  lr: number;
  lossHistory: number[];
  valLossHistory: number[];
}

export interface DiffHandle {
  model: Denoiser | null;
  data: ImageDataset | null;
  classes: number;
  labels: string[];
  imgSize: number;
}

// One captured frame of a reverse-diffusion run: the noisy latent x_t and the model's predicted
// clean image x̂0 at that step, both already mapped to the display range (ink ≈ +0.5).
export interface TrajFrame {
  t: number; // diffusion timestep (1..T), 0 = final clean image
  xt: Float64Array;
  x0: Float64Array;
}

const MAX_HISTORY = 600;
const EVAL_CAP = 96;
const DISPLAY_SCALE = 0.5; // diffusion space is [-1,1]; the ink ramp wants [-0.5,0.5]
// A fixed salt so the deterministic validation slice (its timesteps + noise) stays constant across
// steps — the validation curve should reflect the model improving, not a moving target.
const VAL_SALT = 0x9e37;

const EMPTY_METRICS: DiffMetrics = {
  step: 0,
  loss: NaN,
  valLoss: NaN,
  gradNorm: NaN,
  lr: NaN,
  lossHistory: [],
  valLossHistory: [],
};

function preset(id: string): { hidden: number; depth: number } {
  const p = DIFF_PRESETS.find((q) => q.id === id) ?? DIFF_PRESETS[1];
  return { hidden: p.hidden, depth: p.depth };
}

function scheduleOf(cfg: DiffConfig): ScheduleConfig {
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

export function useDiffusionTrainer(cfg: DiffConfig) {
  const modelRef = useRef<Denoiser | null>(null);
  const dataRef = useRef<ImageDataset | null>(null);
  const x0Ref = useRef<Float64Array>(new Float64Array()); // pixels scaled to [-1,1]
  const schedRef = useRef<NoiseSchedule | null>(null);
  const trainIdxRef = useRef<Int32Array>(new Int32Array());
  const valIdxRef = useRef<Int32Array>(new Int32Array());
  const orderRef = useRef<Int32Array>(new Int32Array());
  const optRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const cursor = useRef(0);
  const shuffleRng = useRef<() => number>(() => 0);
  const tRng = useRef<() => number>(() => Math.random());
  const noiseRng = useRef<() => number>(() => Math.random());
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<DiffHandle>({ model: null, data: null, classes: 1, labels: [], imgSize: cfg.imgSize });
  const [metrics, setMetrics] = useState<DiffMetrics>(EMPTY_METRICS);

  const numClasses = datasetMeta(cfg.dataset).classes;

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    imgSize: cfg.imgSize,
    samples: cfg.samples,
    noise: cfg.noise,
    jitter: cfg.jitter,
    seed: cfg.seed,
    presetId: cfg.presetId,
    timeDim: cfg.timeDim,
    diffSchedule: cfg.diffSchedule,
    T: cfg.T,
    optimizer: cfg.optimizer,
    valFraction: cfg.valFraction,
    loadId: cfg.loadId,
  });

  const px = cfg.imgSize * cfg.imgSize;

  // ε-prediction MSE on a capped, deterministic slice (fixed t and ε per index) — a stable
  // validation curve that doesn't jitter with the random training draws.
  const evalOn = useCallback(
    (idx: Int32Array): number => {
      const model = modelRef.current;
      const sched = schedRef.current;
      if (!model || !sched || idx.length === 0) return NaN;
      const k = Math.min(idx.length, EVAL_CAP);
      const x0all = x0Ref.current;
      const x0 = new Float64Array(k * px);
      for (let i = 0; i < k; i++) x0.set(x0all.subarray(idx[i] * px, idx[i] * px + px), i * px);
      const er = mulberry32(0xe7a1 ^ VAL_SALT);
      const tIdx = new Int32Array(k);
      for (let i = 0; i < k; i++) tIdx[i] = Math.floor(er() * cfg.T);
      const epsD = new Float64Array(k * px);
      for (let i = 0; i < epsD.length; i++) {
        let u = 0;
        let v = 0;
        while (u === 0) u = er();
        while (v === 0) v = er();
        epsD[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      }
      const xt = qSampleData(x0, epsD, tIdx, px, sched);
      const temb = sinusoidalTimeEmbedding(tIdx, cfg.T, cfg.timeDim);
      const cls = new Int32Array(k);
      const ds = dataRef.current!;
      for (let i = 0; i < k; i++) cls[i] = ds.y[idx[i]];
      const out = model.forward(Tensor.fromFlat(xt, k, px, false), temb, cls);
      return mse(out, Tensor.fromFlat(epsD, k, px, false)).data[0];
    },
    [cfg.T, cfg.timeDim, px],
  );

  const seedMetrics = useCallback(() => {
    const tr = evalOn(trainIdxRef.current);
    const va = valIdxRef.current.length ? evalOn(valIdxRef.current) : NaN;
    setMetrics({
      ...EMPTY_METRICS,
      step: stepRef.current,
      loss: tr,
      valLoss: va,
      lr: cfg.lr,
      lossHistory: [tr],
      valLossHistory: [va],
    });
  }, [evalOn, cfg.lr]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const meta = datasetMeta(cfg.dataset);
    const ds = makeImageDataset(cfg.dataset, cfg.samples, cfg.noise, cfg.jitter, cfg.imgSize, cfg.seed);
    dataRef.current = ds;
    // map the [-0.5,0.5] glyph intensities to the [-1,1] range the diffusion process lives in.
    const X0 = new Float64Array(ds.X.length);
    for (let i = 0; i < X0.length; i++) X0[i] = Math.max(-1, Math.min(1, ds.X[i] * 2));
    x0Ref.current = X0;
    schedRef.current = new NoiseSchedule(cfg.T, cfg.diffSchedule);

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
    tRng.current = mulberry32(cfg.seed ^ 0x7a1e);
    noiseRng.current = mulberry32(cfg.seed ^ 0xb1a5);

    const rng = mulberry32(cfg.seed);
    const { hidden, depth } = preset(cfg.presetId);
    const model = new Denoiser({ px, hidden, depth, timeDim: cfg.timeDim, numClasses: meta.classes }, rng);
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, data: ds, classes: meta.classes, labels: ds.labels, imgSize: cfg.imgSize });
    seedMetrics();
    setTick((t) => t + 1);
  }, [
    cfg.dataset,
    cfg.imgSize,
    cfg.samples,
    cfg.noise,
    cfg.jitter,
    cfg.seed,
    cfg.presetId,
    cfg.timeDim,
    cfg.diffSchedule,
    cfg.T,
    cfg.optimizer,
    cfg.lr,
    cfg.weightDecay,
    cfg.valFraction,
    px,
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

  // One training step: sample a minibatch, a per-sample timestep t and noise ε, form x_t, predict
  // ε̂, minimise ‖ε̂ − ε‖² — with classifier-free label dropout (a fraction of the batch is trained
  // with the null class token so the model learns an unconditional score too).
  const trainStep = useCallback(() => {
    const model = modelRef.current;
    const opt = optRef.current;
    const sched = schedRef.current;
    const ds = dataRef.current;
    if (!model || !opt || !sched || !ds) return;
    const order = orderRef.current;
    const bs = Math.min(cfg.batchSize, order.length);
    if (bs === 0) return;
    if (cursor.current + bs > order.length) {
      shuffleInPlace(order, shuffleRng.current);
      cursor.current = 0;
    }
    const x0all = x0Ref.current;
    const x0 = new Float64Array(bs * px);
    const cls = new Int32Array(bs);
    for (let i = 0; i < bs; i++) {
      const di = order[cursor.current + i];
      x0.set(x0all.subarray(di * px, di * px + px), i * px);
      cls[i] = tRng.current() < cfg.pUncond ? numClasses : ds.y[di];
    }
    cursor.current += bs;
    const tIdx = new Int32Array(bs);
    for (let i = 0; i < bs; i++) tIdx[i] = Math.floor(tRng.current() * cfg.T);
    const eps = sampleNoise(bs, px, noiseRng.current);
    const xt = qSampleData(x0, eps.data, tIdx, px, sched);
    const temb = sinusoidalTimeEmbedding(tIdx, cfg.T, cfg.timeDim);
    const out = model.forward(Tensor.fromFlat(xt, bs, px, false), temb, cls);
    const loss = mse(out, eps);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.cfg.lr = lrAt(scheduleOf(cfg), stepRef.current);
    opt.step();
    stepRef.current++;
    return { gradNorm, lr: opt.cfg.lr, loss: loss.data[0] };
  }, [cfg, px, numClasses]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; lr: number; loss: number } | undefined) => {
      const va = valIdxRef.current.length ? evalOn(valIdxRef.current) : NaN;
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const valLossHistory = cap(m.valLossHistory);
        if (last) {
          lossHistory.push(last.loss);
          valLossHistory.push(va);
        }
        return {
          step: stepRef.current,
          loss: last ? last.loss : m.loss,
          valLoss: va,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          lr: last ? last.lr : m.lr,
          lossHistory,
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
      let last: { gradNorm: number; lr: number; loss: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      pushMetrics(last);
      frames++;
      if (frames % 4 === 0) setTick((t) => t + 1);
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
    const sched = schedRef.current;
    const ds = dataRef.current;
    if (!model || !sched || !ds) return null;
    const k = 6;
    const x0all = x0Ref.current;
    const src = trainIdxRef.current.length ? trainIdxRef.current : new Int32Array([...Array(ds.n).keys()]);
    const x0 = new Float64Array(k * px);
    const cls = new Int32Array(k);
    for (let i = 0; i < k; i++) {
      x0.set(x0all.subarray(src[i] * px, src[i] * px + px), i * px);
      cls[i] = ds.y[src[i]];
    }
    const gr = mulberry32(2024);
    const tIdx = new Int32Array(k);
    for (let i = 0; i < k; i++) tIdx[i] = Math.floor(gr() * cfg.T);
    const eps = sampleNoise(k, px, mulberry32(7));
    const xt = qSampleData(x0, eps.data, tIdx, px, sched);
    const temb = sinusoidalTimeEmbedding(tIdx, cfg.T, cfg.timeDim);
    const xtT = Tensor.fromFlat(xt, k, px, false);
    return gradCheck(
      model.parameters(),
      () => mse(model.forward(xtT, temb, cls), eps),
      { samplesPerParam: 2 },
    );
  }, [cfg.T, cfg.timeDim, px]);

  // ---- sampling -------------------------------------------------------------------

  // One CFG noise prediction at timestep index ti for a single image x [px], conditioned on `cls`
  // (-1 ⇒ unconditional / null token). w>0 applies classifier-free guidance.
  const predictEps = useCallback(
    (x: Float64Array, ti: number, cls: number, w: number): Float64Array => {
      const model = modelRef.current!;
      const temb = sinusoidalTimeEmbedding(Int32Array.from([ti]), cfg.T, cfg.timeDim);
      const xt = Tensor.fromFlat(x, 1, px, false);
      const condId = cls >= 0 ? cls : numClasses;
      const epsCond = model.forward(xt, temb, Int32Array.from([condId])).data.slice();
      if (w > 0 && cls >= 0) {
        const epsUncond = model.forward(xt, temb, Int32Array.from([numClasses])).data;
        return classifierFreeGuidance(epsCond, epsUncond, w);
      }
      return epsCond;
    },
    [cfg.T, cfg.timeDim, px, numClasses],
  );

  const toDisplay = (x: Float64Array): Float64Array => {
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] * DISPLAY_SCALE;
    return out;
  };

  // Run a full reverse-diffusion trajectory for one seed and class, capturing every step's noisy
  // latent x_t and the model's predicted clean image x̂0 (both in display range). The returned
  // frames run from pure noise to the final clean glyph.
  const sampleTrajectory = useCallback(
    (cls: number, seed: number): TrajFrame[] => {
      const model = modelRef.current;
      const sched = schedRef.current;
      if (!model || !sched) return [];
      const T = cfg.T;
      const steps = cfg.sampler === 'ddim' ? ddimTimesteps(T, cfg.samplingSteps) : Array.from({ length: T }, (_, i) => T - 1 - i);
      const nrng = mulberry32((seed ^ 0xc0ffee) >>> 0);
      const gauss = () => {
        let u = 0;
        let v = 0;
        while (u === 0) u = nrng();
        while (v === 0) v = nrng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      };
      let x: Float64Array = sampleNoise(1, px, mulberry32((seed ^ 0xabcd) >>> 0)).data.slice();
      const frames: TrajFrame[] = [];
      for (let si = 0; si < steps.length; si++) {
        const ti = steps[si];
        const tiPrev = si + 1 < steps.length ? steps[si + 1] : -1;
        const epsHat = predictEps(x, ti, cls, cfg.guidance);
        const x0hat = predictX0(x, epsHat, ti, sched, 1);
        frames.push({ t: ti + 1, xt: toDisplay(x), x0: toDisplay(x0hat) });
        if (cfg.sampler === 'ddim') {
          const noise = cfg.eta > 0 ? Float64Array.from({ length: px }, gauss) : null;
          x = ddimStep(x, epsHat, ti, tiPrev, sched, cfg.eta, noise, 1);
        } else {
          const noise = ti > 0 ? Float64Array.from({ length: px }, gauss) : null;
          x = ddpmStep(x, epsHat, ti, sched, noise, 1);
        }
      }
      frames.push({ t: 0, xt: toDisplay(x), x0: toDisplay(x) });
      return frames;
    },
    [cfg.T, cfg.sampler, cfg.samplingSteps, cfg.eta, cfg.guidance, px, predictEps],
  );

  // Generate the final clean image only (the trajectory's endpoint) for a class + seed.
  const sampleFinal = useCallback(
    (cls: number, seed: number): Float64Array => {
      const frames = sampleTrajectory(cls, seed);
      return frames.length ? frames[frames.length - 1].x0 : new Float64Array(px);
    },
    [sampleTrajectory, px],
  );

  // Spherical interpolation (slerp) between two seeds' noise vectors, decoded by the sampler — the
  // smooth latent walk that diffusion's deterministic DDIM map makes possible.
  const slerpInterpolate = useCallback(
    (cls: number, seedA: number, seedB: number, stepsN: number): Float64Array[] => {
      const sched = schedRef.current;
      const model = modelRef.current;
      if (!sched || !model) return [];
      const nA = sampleNoise(1, px, mulberry32((seedA ^ 0xabcd) >>> 0)).data.slice();
      const nB = sampleNoise(1, px, mulberry32((seedB ^ 0xabcd) >>> 0)).data.slice();
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < px; i++) {
        dot += nA[i] * nB[i];
        na += nA[i] * nA[i];
        nb += nB[i] * nB[i];
      }
      const omega = Math.acos(Math.max(-1, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9))));
      const sinOmega = Math.sin(omega) || 1e-6;
      const T = cfg.T;
      const steps = cfg.sampler === 'ddim' ? ddimTimesteps(T, cfg.samplingSteps) : Array.from({ length: T }, (_, i) => T - 1 - i);
      const out: Float64Array[] = [];
      for (let s = 0; s < stepsN; s++) {
        const u = stepsN > 1 ? s / (stepsN - 1) : 0;
        let x: Float64Array = new Float64Array(px);
        const ca = Math.sin((1 - u) * omega) / sinOmega;
        const cb = Math.sin(u * omega) / sinOmega;
        for (let i = 0; i < px; i++) x[i] = ca * nA[i] + cb * nB[i];
        // deterministic DDIM (eta=0) decode from this interpolated seed
        for (let si = 0; si < steps.length; si++) {
          const ti = steps[si];
          const tiPrev = si + 1 < steps.length ? steps[si + 1] : -1;
          const epsHat = predictEps(x, ti, cls, cfg.guidance);
          x = ddimStep(x, epsHat, ti, tiPrev, sched, 0, null, 1);
        }
        out.push(toDisplay(x));
      }
      return out;
    },
    [cfg.T, cfg.sampler, cfg.samplingSteps, cfg.guidance, px, predictEps],
  );

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const model = modelRef.current;
    return { weights: model ? model.exportWeights() : [], step: stepRef.current };
  }, []);

  const prepareLoad = useCallback((weights: number[], step: number) => {
    pendingWeights.current = weights;
    pendingStep.current = step;
  }, []);

  const schedule = useCallback((): NoiseSchedule | null => schedRef.current, []);

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
    sampleTrajectory,
    sampleFinal,
    slerpInterpolate,
    schedule,
  };
}
