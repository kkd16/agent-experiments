import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { GAN, ganPresetById, type GANObjective } from '../engine/gan';
import { makeFlowDataset, type FlowDataset, type FlowDatasetKind } from '../engine/flow-data';
import { mulberry32, type Activation } from '../engine/nn';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';

// The plane half-window the decision surface / samples are drawn over. The data is standardised
// to unit variance, so ±3.2 comfortably covers it and the generator's spread.
export const GAN_VIEW = 3.2;
const D = 2;

export interface GANConfigUI {
  dataset: FlowDatasetKind;
  samples: number;
  noise: number;
  seed: number;
  presetId: string;
  zDim: number;
  gAct: Activation;
  dAct: Activation;
  objective: GANObjective;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  dSteps: number; // discriminator/critic updates per generator update (n_critic)
  clipC: number; // WGAN weight-clip magnitude
  stepsPerFrame: number;
  clipNorm: number;
  gridRes: number;
  sampleCount: number;
  loadId: number;
}

export interface GANMetrics {
  step: number;
  dLoss: number;
  gLoss: number;
  dReal: number; // mean σ(D(real)) — prob games — or raw critic score (WGAN)
  dFake: number; // mean σ(D(fake)) — prob games — or raw critic score (WGAN)
  wDist: number; // raw E[D(real)] − E[D(fake)]  (the Wasserstein/EM estimate)
  gradNorm: number; // generator gradient norm
  lr: number;
  dLossHistory: number[];
  gLossHistory: number[];
  wDistHistory: number[];
}

export interface GANHandle {
  model: GAN | null;
  data: FlowDataset | null;
  n: number;
  view: number;
  objective: GANObjective;
  zDim: number;
}

export interface DiscGrid {
  values: Float64Array; // σ(D) ∈ [0,1] for prob games; raw critic score for WGAN
  res: number;
  signed: boolean; // WGAN critic scores straddle 0 → diverging colour map
  maxAbs: number; // for normalising the signed map
}

const MAX_HISTORY = 600;
const SCATTER_CAP = 1500;

const EMPTY_METRICS: GANMetrics = {
  step: 0,
  dLoss: NaN,
  gLoss: NaN,
  dReal: NaN,
  dFake: NaN,
  wDist: NaN,
  gradNorm: NaN,
  lr: NaN,
  dLossHistory: [],
  gLossHistory: [],
  wDistHistory: [],
};

function shuffleInPlace(arr: Int32Array, rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

export function useGANTrainer(cfg: GANConfigUI) {
  const modelRef = useRef<GAN | null>(null);
  const dataRef = useRef<FlowDataset | null>(null);
  const orderRef = useRef<Int32Array>(new Int32Array());
  const optGRef = useRef<Optimizer | null>(null);
  const optDRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const cursor = useRef(0);
  const shuffleRng = useRef<() => number>(() => 0);
  const latentRng = useRef<() => number>(() => 0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<GANHandle>({ model: null, data: null, n: 0, view: GAN_VIEW, objective: cfg.objective, zDim: cfg.zDim });
  const [metrics, setMetrics] = useState<GANMetrics>(EMPTY_METRICS);

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    samples: cfg.samples,
    noise: cfg.noise,
    seed: cfg.seed,
    presetId: cfg.presetId,
    zDim: cfg.zDim,
    gAct: cfg.gAct,
    dAct: cfg.dAct,
    objective: cfg.objective,
    optimizer: cfg.optimizer,
    loadId: cfg.loadId,
  });

  // Real-data batch [k, 2] from dataset indices.
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

  // GANs are famously sensitive to the optimiser; Adam with β1≈0.5 is the standard stabiliser
  // (Radford et al.), so we lower the first-moment decay for the adaptive optimisers.
  const makeOpt = useCallback(
    (params: Tensor[]): Optimizer => {
      const base: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
      if (cfg.optimizer === 'adam' || cfg.optimizer === 'adamw') base.beta1 = 0.5;
      return new Optimizer(params, base);
    },
    [cfg.optimizer, cfg.lr, cfg.weightDecay],
  );

  const buildAll = useCallback(() => {
    setRunning(false);
    const ds = makeFlowDataset(cfg.dataset, cfg.samples, cfg.noise, cfg.seed);
    dataRef.current = ds;

    const all = new Int32Array(ds.n);
    for (let i = 0; i < ds.n; i++) all[i] = i;
    shuffleRng.current = mulberry32(cfg.seed ^ 0x1234);
    latentRng.current = mulberry32(cfg.seed ^ 0x77777777);
    orderRef.current = all;
    shuffleInPlace(orderRef.current, shuffleRng.current);
    cursor.current = 0;

    const preset = ganPresetById(cfg.presetId);
    const model = new GAN(
      { D, zDim: cfg.zDim, gHidden: preset.gHidden, dHidden: preset.dHidden, gAct: cfg.gAct, dAct: cfg.dAct, objective: cfg.objective },
      mulberry32(cfg.seed),
    );
    modelRef.current = model;
    optGRef.current = makeOpt(model.genParameters());
    optDRef.current = makeOpt(model.discParameters());
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, data: ds, n: ds.n, view: GAN_VIEW, objective: cfg.objective, zDim: cfg.zDim });
    setMetrics({ ...EMPTY_METRICS, step: stepRef.current, lr: cfg.lr });
    setTick((t) => t + 1);
  }, [cfg.dataset, cfg.samples, cfg.noise, cfg.seed, cfg.presetId, cfg.zDim, cfg.gAct, cfg.dAct, cfg.objective, cfg.lr, makeOpt]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  useEffect(() => {
    if (optGRef.current) {
      optGRef.current.cfg.lr = cfg.lr;
      optGRef.current.cfg.weightDecay = cfg.weightDecay;
    }
    if (optDRef.current) {
      optDRef.current.cfg.lr = cfg.lr;
      optDRef.current.cfg.weightDecay = cfg.weightDecay;
    }
  }, [cfg.lr, cfg.weightDecay]);

  // Draw the next real batch, advancing (and reshuffling at the epoch boundary).
  const nextReal = useCallback(
    (bs: number): Tensor => {
      const order = orderRef.current;
      if (cursor.current + bs > order.length) {
        shuffleInPlace(order, shuffleRng.current);
        cursor.current = 0;
      }
      const x = batchTensor(order, cursor.current, bs);
      cursor.current += bs;
      return x;
    },
    [batchTensor],
  );

  // One full adversarial round: `dSteps` critic updates, then a single generator update. This
  // alternating gradient descent — two players, two optimisers, two objectives — is the whole
  // novelty over the other (single-loss) labs.
  const trainStep = useCallback(() => {
    const model = modelRef.current;
    const optG = optGRef.current;
    const optD = optDRef.current;
    if (!model || !optG || !optD) return;
    const bs = Math.min(cfg.batchSize, orderRef.current.length);
    if (bs === 0) return;

    let dLoss = NaN;
    let dReal = NaN;
    let dFake = NaN;
    let wDist = NaN;

    // ---- critic / discriminator phase ----
    for (let d = 0; d < Math.max(1, cfg.dSteps); d++) {
      const real = nextReal(bs);
      const z = model.sampleLatent(bs, latentRng.current);
      // Detach the fakes: the D update must not flow back into G.
      const fakeRaw = model.generate(z);
      const fake = Tensor.fromFlat(fakeRaw.data.slice(), bs, D, false);
      const out = model.discLoss(real, fake);
      optD.zeroGrad();
      out.loss.backward();
      clipGradGlobalNorm(model.discParameters(), cfg.clipNorm);
      optD.step();
      if (cfg.objective === 'wgan') model.clipDiscWeights(cfg.clipC);
      dLoss = out.loss.data[0];
      dReal = out.dReal;
      dFake = out.dFake;
      wDist = out.wDist;
    }

    // ---- generator phase ----
    const z = model.sampleLatent(bs, latentRng.current);
    const fake = model.generate(z);
    const gout = model.genLoss(fake);
    optG.zeroGrad();
    gout.loss.backward();
    const gradNorm = clipGradGlobalNorm(model.genParameters(), cfg.clipNorm);
    optG.step();
    stepRef.current++;

    return { dLoss, gLoss: gout.loss.data[0], dReal, dFake, wDist, gradNorm, lr: cfg.lr };
  }, [cfg.batchSize, cfg.dSteps, cfg.clipNorm, cfg.objective, cfg.clipC, cfg.lr, nextReal]);

  const pushMetrics = useCallback((last: ReturnType<typeof trainStep> | undefined) => {
    if (!last) return;
    setMetrics((m) => {
      const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
      const dLossHistory = cap(m.dLossHistory);
      const gLossHistory = cap(m.gLossHistory);
      const wDistHistory = cap(m.wDistHistory);
      dLossHistory.push(last.dLoss);
      gLossHistory.push(last.gLoss);
      wDistHistory.push(last.wDist);
      return {
        step: stepRef.current,
        dLoss: last.dLoss,
        gLoss: last.gLoss,
        dReal: last.dReal,
        dFake: last.dFake,
        wDist: last.wDist,
        gradNorm: last.gradNorm,
        lr: last.lr,
        dLossHistory,
        gLossHistory,
        wDistHistory,
      };
    });
  }, []);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: ReturnType<typeof trainStep> | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      pushMetrics(last);
      frames++;
      if (frames % 4 === 0) setTick((t) => t + 1); // throttle the heavier field redraw
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

  // Gradient check the GENERATOR end to end: with z and the discriminator frozen, the
  // generator loss is a clean function of G's parameters, and its gradient is what the
  // discriminator back-propagates into the generator — the signal that trains a GAN. Proving
  // it matches finite differences proves that learning signal is exact.
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    if (!model) return null;
    const k = 8;
    const z = model.sampleLatent(k, mulberry32(101));
    return gradCheck(model.genParameters(), () => model.genLoss(model.generate(z)).loss, { samplesPerParam: 3 });
  }, []);

  // ---- visualisation queries --------------------------------------------------------

  // The discriminator's decision surface over the view window. For the probabilistic games it
  // is σ(D(x)) ∈ [0,1] (1 = "real"); for WGAN it is the raw critic score, returned signed with
  // its max magnitude so the canvas can centre a diverging map at 0.
  const discGrid = useCallback((res: number): DiscGrid | null => {
    const model = modelRef.current;
    if (!model) return null;
    const coords = new Float64Array(res * res * D);
    let r = 0;
    for (let gy = 0; gy < res; gy++) {
      const y = GAN_VIEW - (gy / (res - 1)) * 2 * GAN_VIEW;
      for (let gx = 0; gx < res; gx++) {
        const x = -GAN_VIEW + (gx / (res - 1)) * 2 * GAN_VIEW;
        coords[r * D] = x;
        coords[r * D + 1] = y;
        r++;
      }
    }
    const logits = model.discriminate(Tensor.fromFlat(coords, res * res, D));
    const signed = model.cfg.objective === 'wgan';
    const values = new Float64Array(res * res);
    let maxAbs = 1e-6;
    for (let i = 0; i < res * res; i++) {
      const z = logits.data[i];
      const v = signed ? z : 1 / (1 + Math.exp(-z));
      values[i] = v;
      if (signed && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    return { values, res, signed, maxAbs };
  }, []);

  const dataPoints = useCallback((): Float64Array | null => {
    const ds = dataRef.current;
    if (!ds) return null;
    const k = Math.min(ds.n, SCATTER_CAP);
    return ds.X.slice(0, k * D);
  }, []);

  // Draw k samples from the generator: z ~ N(0, I) → x = G(z).
  const modelSamples = useCallback((k: number, seed: number): Float64Array | null => {
    const model = modelRef.current;
    if (!model) return null;
    const z = model.sampleLatent(k, mulberry32(seed));
    return model.generate(z).data.slice(0, k * D);
  }, []);

  // The generator's pushforward made visible (only when the latent is 2-D): a Cartesian grid of
  // latent lines mapped through G, so you can watch the noise square fold and stretch onto the
  // data — the GAN analogue of the flow's coordinate warp.
  const generatorWarp = useCallback((): { polylines: Float64Array[] } | null => {
    const model = modelRef.current;
    if (!model || model.cfg.zDim !== 2) return null;
    const lines = 11;
    const per = 48;
    const span = 2.6;
    const Z: number[] = [];
    for (let li = 0; li < lines; li++) {
      const c = -span + (li / (lines - 1)) * 2 * span;
      for (let s = 0; s < per; s++) {
        const t = -span + (s / (per - 1)) * 2 * span;
        Z.push(t, c);
      }
    }
    for (let li = 0; li < lines; li++) {
      const c = -span + (li / (lines - 1)) * 2 * span;
      for (let s = 0; s < per; s++) {
        const t = -span + (s / (per - 1)) * 2 * span;
        Z.push(c, t);
      }
    }
    const total = Z.length / D;
    const x = model.generate(Tensor.fromFlat(Float64Array.from(Z), total, D));
    const polylines: Float64Array[] = [];
    for (let li = 0; li < lines * 2; li++) {
      const pl = new Float64Array(per * D);
      for (let s = 0; s < per; s++) {
        const idx = li * per + s;
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
    discGrid,
    dataPoints,
    modelSamples,
    generatorWarp,
  };
}
