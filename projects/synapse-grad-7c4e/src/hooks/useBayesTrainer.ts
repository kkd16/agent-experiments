import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { mulberry32, type Activation } from '../engine/nn';
import { gatherCols } from '../engine/ops';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import {
  BayesMLP,
  DetMLP,
  Ensemble,
  gaussianNLL,
  makeReg1D,
  trueFn,
  varFromLogVar,
  mixtureMoments,
  mixtureNLL,
  probit,
  VIEW_HALF,
  type RegFuncKind,
  type Reg1D,
  type Predictive,
} from '../engine/bayes';

export type UQMethod = 'bbb' | 'dropout' | 'ensemble';

export interface BayesConfigUI {
  method: UQMethod;
  func: RegFuncKind;
  samples: number;
  noise: number;
  hetero: boolean;
  seed: number;
  hidden: number;
  depth: number;
  activation: Activation;
  // method-specific
  priorSigma: number; // BBB prior std
  klWeight: number; // BBB β on the KL term
  rhoInit: number; // BBB initial posterior log-width
  dropP: number; // MC-dropout rate
  ensembleSize: number; // deep-ensemble member count
  // optimisation
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  scheduleKind: ScheduleKind;
  schedulePeriod: number;
  scheduleWarmup: number;
  clipNorm: number;
  // visualisation / evaluation
  predSamples: number; // forward passes for the predictive bands
  funcSamples: number; // sampled mean-curves to draw
  loadId: number;
}

export interface BayesMetrics {
  step: number;
  loss: number;
  rmse: number;
  nll: number;
  ece: number;
  gradNorm: number;
  lr: number;
  lossHistory: number[];
  nllHistory: number[];
}

type ModelBox =
  | { kind: 'bbb'; net: BayesMLP }
  | { kind: 'dropout'; net: DetMLP }
  | { kind: 'ensemble'; net: Ensemble };

export interface BayesHandle {
  paramCount: number;
  method: UQMethod;
  members: number; // effective predictive-sample count actually used
}

export interface BayesBands {
  xs: Float64Array; // [G] query points across the view
  mean: Float64Array; // [G] predictive mean
  aleStd: Float64Array; // [G] aleatoric std (data noise)
  epiStd: Float64Array; // [G] epistemic std (model disagreement)
  totalStd: Float64Array; // [G] sqrt(ale² + epi²)
}

export interface CalibrationResult {
  levels: number[]; // expected central-interval coverage p
  observed: number[]; // empirical coverage at each p
  ece: number;
  rmse: number;
  nll: number;
}

const MAX_HISTORY = 600;
const GRID = 160; // query resolution for the bands/curves
const TEST_N = 200; // held-out points for calibration / metrics
const EVAL_S = 24; // forward passes when scoring metrics live each frame

const EMPTY_METRICS: BayesMetrics = {
  step: 0,
  loss: NaN,
  rmse: NaN,
  nll: NaN,
  ece: NaN,
  gradNorm: NaN,
  lr: NaN,
  lossHistory: [],
  nllHistory: [],
};

function scheduleOf(cfg: BayesConfigUI): ScheduleConfig {
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

function hiddenSpec(cfg: BayesConfigUI): number[] {
  return new Array<number>(Math.max(1, cfg.depth)).fill(cfg.hidden);
}

function paramsOf(box: ModelBox): Tensor[] {
  return box.net.parameters();
}

// Split a [rows,2] output into its mean column (0) and log-variance column (1), keeping the tape.
function splitOut(out: Tensor, rows: number): { mu: Tensor; lv: Tensor } {
  const z = new Int32Array(rows); // column 0 = mean
  const o = new Int32Array(rows).fill(1); // column 1 = log-variance
  return { mu: gatherCols(out, z), lv: gatherCols(out, o) };
}

function effectiveSamples(box: ModelBox, cfg: BayesConfigUI): number {
  return box.kind === 'ensemble' ? box.net.members.length : cfg.predSamples;
}

export function useBayesTrainer(cfg: BayesConfigUI) {
  const boxRef = useRef<ModelBox | null>(null);
  const dataRef = useRef<Reg1D | null>(null);
  const testRef = useRef<Reg1D | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const ordersRef = useRef<Int32Array[]>([]); // per-member (ensemble) or single training order
  const cursorsRef = useRef<number[]>([]);
  const shuffleRngRef = useRef<() => number>(() => 0);
  const trainRngRef = useRef<() => number>(() => Math.random());
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<BayesHandle>({ paramCount: 0, method: cfg.method, members: cfg.predSamples });
  const [metrics, setMetrics] = useState<BayesMetrics>(EMPTY_METRICS);

  const structKey = JSON.stringify({
    method: cfg.method,
    func: cfg.func,
    samples: cfg.samples,
    noise: cfg.noise,
    hetero: cfg.hetero,
    seed: cfg.seed,
    hidden: cfg.hidden,
    depth: cfg.depth,
    activation: cfg.activation,
    rhoInit: cfg.rhoInit,
    ensembleSize: cfg.ensembleSize,
    optimizer: cfg.optimizer,
    loadId: cfg.loadId,
  });

  // ---- a batch of (x,y) for member `m`'s training order --------------------------
  const nextBatch = useCallback((m: number, bs: number): { x: Tensor; y: Tensor } => {
    const ds = dataRef.current!;
    const order = ordersRef.current[m];
    if (cursorsRef.current[m] + bs > order.length) {
      shuffleInPlace(order, shuffleRngRef.current);
      cursorsRef.current[m] = 0;
    }
    const start = cursorsRef.current[m];
    const xb = new Float64Array(bs);
    const yb = new Float64Array(bs);
    for (let i = 0; i < bs; i++) {
      const di = order[start + i];
      xb[i] = ds.X[di];
      yb[i] = ds.y[di];
    }
    cursorsRef.current[m] = start + bs;
    return { x: Tensor.fromFlat(xb, bs, 1, false), y: Tensor.fromFlat(yb, bs, 1, false) };
  }, []);

  // ---- S stochastic forward passes over a query grid -------------------------------
  // Returns the per-pass mean and variance at each query point (raw arrays, no tape kept).
  const forwardSamples = useCallback(
    (xs: Float64Array, S: number, seed: number): { means: Float64Array[]; vars: Float64Array[] } => {
      const box = boxRef.current!;
      const G = xs.length;
      const xT = Tensor.fromFlat(xs.slice(), G, 1, false);
      const rng = mulberry32(seed >>> 0);
      const means: Float64Array[] = [];
      const vars: Float64Array[] = [];
      const extract = (out: Tensor) => {
        const mu = new Float64Array(G);
        const vr = new Float64Array(G);
        for (let g = 0; g < G; g++) {
          mu[g] = out.data[g * 2];
          vr[g] = varFromLogVar(out.data[g * 2 + 1]);
        }
        means.push(mu);
        vars.push(vr);
      };
      if (box.kind === 'bbb') {
        for (let s = 0; s < S; s++) extract(box.net.forwardWith(xT, box.net.sampleAllEps(rng)));
      } else if (box.kind === 'dropout') {
        for (let s = 0; s < S; s++) extract(box.net.forward(xT, { training: true, dropP: cfg.dropP, rng }));
      } else {
        for (const member of box.net.members) extract(member.forward(xT, { training: false, dropP: 0, rng }));
      }
      return { means, vars };
    },
    [cfg.dropP],
  );

  // ---- live metrics on the held-out test set ---------------------------------------
  const evalMetrics = useCallback((): { rmse: number; nll: number; ece: number } => {
    const test = testRef.current;
    const box = boxRef.current;
    if (!test || !box) return { rmse: NaN, nll: NaN, ece: NaN };
    const S = box.kind === 'ensemble' ? box.net.members.length : EVAL_S;
    const { means, vars } = forwardSamples(test.X, S, 0xbeef ^ stepRef.current);
    const Sn = means.length;
    let se = 0;
    let nllAcc = 0;
    const pm = mixtureMoments(means, vars, test.n);
    for (let i = 0; i < test.n; i++) {
      const d = test.y[i] - pm.mean[i];
      se += d * d;
      const ms: number[] = [];
      const vs: number[] = [];
      for (let s = 0; s < Sn; s++) {
        ms.push(means[s][i]);
        vs.push(vars[s][i]);
      }
      nllAcc += mixtureNLL(test.y[i], ms, vs);
    }
    // calibration error across a few central-interval levels
    const levels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    let eceAcc = 0;
    for (const p of levels) {
      const z = probit((1 + p) / 2);
      let cov = 0;
      for (let i = 0; i < test.n; i++) {
        const total = Math.sqrt(pm.aleatoric[i] + pm.epistemic[i]);
        if (Math.abs(test.y[i] - pm.mean[i]) <= z * total) cov++;
      }
      eceAcc += Math.abs(cov / test.n - p);
    }
    return { rmse: Math.sqrt(se / test.n), nll: nllAcc / test.n, ece: eceAcc / levels.length };
  }, [forwardSamples]);

  const seedMetrics = useCallback(() => {
    const m = evalMetrics();
    setMetrics({ ...EMPTY_METRICS, step: stepRef.current, rmse: m.rmse, nll: m.nll, ece: m.ece, lr: cfg.lr, nllHistory: [m.nll] });
  }, [evalMetrics, cfg.lr]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const ds = makeReg1D(cfg.func, cfg.samples, cfg.noise, cfg.hetero, cfg.seed);
    dataRef.current = ds;
    testRef.current = makeReg1D(cfg.func, TEST_N, cfg.noise, cfg.hetero, (cfg.seed ^ 0x5a17) >>> 0);

    const rng = mulberry32(cfg.seed >>> 0);
    const hidden = hiddenSpec(cfg);
    let box: ModelBox;
    if (cfg.method === 'bbb') box = { kind: 'bbb', net: new BayesMLP(1, hidden, rng, cfg.activation, cfg.rhoInit) };
    else if (cfg.method === 'dropout') box = { kind: 'dropout', net: new DetMLP(1, hidden, rng, cfg.activation) };
    else box = { kind: 'ensemble', net: new Ensemble(1, hidden, rng, cfg.activation, cfg.ensembleSize) };
    boxRef.current = box;

    // one training order per "member" (ensemble) or a single order otherwise
    const members = box.kind === 'ensemble' ? box.net.members.length : 1;
    shuffleRngRef.current = mulberry32((cfg.seed ^ 0x1234) >>> 0);
    ordersRef.current = [];
    cursorsRef.current = [];
    for (let m = 0; m < members; m++) {
      const o = new Int32Array(ds.n);
      for (let i = 0; i < ds.n; i++) o[i] = i;
      shuffleInPlace(o, shuffleRngRef.current);
      ordersRef.current.push(o);
      cursorsRef.current.push(0);
    }
    trainRngRef.current = mulberry32((cfg.seed ^ 0x7a1e) >>> 0);

    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(paramsOf(box), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = box.net.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ paramCount: box.net.paramCount(), method: cfg.method, members: effectiveSamples(box, cfg) });
    seedMetrics();
    setTick((t) => t + 1);
  }, [cfg, seedMetrics]);

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

  // ---- one optimisation step --------------------------------------------------------
  const trainStep = useCallback(() => {
    const box = boxRef.current;
    const opt = optRef.current;
    const ds = dataRef.current;
    if (!box || !opt || !ds) return;
    const bs = Math.min(cfg.batchSize, ds.n);
    if (bs === 0) return;
    const trng = trainRngRef.current;

    opt.zeroGrad();
    let loss: Tensor;
    if (box.kind === 'bbb') {
      const { x, y } = nextBatch(0, bs);
      const out = box.net.forwardWith(x, box.net.sampleAllEps(trng));
      const { mu, lv } = splitOut(out, bs);
      const nll = gaussianNLL(mu, lv, y);
      const kl = box.net.kl(cfg.priorSigma).scale(cfg.klWeight / ds.n);
      loss = nll.add(kl);
    } else if (box.kind === 'dropout') {
      const { x, y } = nextBatch(0, bs);
      const out = box.net.forward(x, { training: true, dropP: cfg.dropP, rng: trng });
      const { mu, lv } = splitOut(out, bs);
      loss = gaussianNLL(mu, lv, y);
    } else {
      // sum each member's NLL on its own shuffled minibatch (disjoint params ⇒ independent grads)
      let acc: Tensor | null = null;
      for (let m = 0; m < box.net.members.length; m++) {
        const { x, y } = nextBatch(m, bs);
        const out = box.net.members[m].forward(x, { training: false, dropP: 0, rng: trng });
        const { mu, lv } = splitOut(out, bs);
        const nll = gaussianNLL(mu, lv, y);
        acc = acc ? acc.add(nll) : nll;
      }
      loss = acc!;
    }
    loss.backward();
    const gradNorm = clipGradGlobalNorm(paramsOf(box), cfg.clipNorm);
    opt.cfg.lr = lrAt(scheduleOf(cfg), stepRef.current);
    opt.step();
    stepRef.current++;
    return { gradNorm, lr: opt.cfg.lr, loss: loss.data[0] };
  }, [cfg, nextBatch]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; lr: number; loss: number } | undefined) => {
      const m = evalMetrics();
      setMetrics((prev) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(prev.lossHistory);
        const nllHistory = cap(prev.nllHistory);
        if (last) lossHistory.push(last.loss);
        nllHistory.push(m.nll);
        return {
          step: stepRef.current,
          loss: last ? last.loss : prev.loss,
          rmse: m.rmse,
          nll: m.nll,
          ece: m.ece,
          gradNorm: last ? last.gradNorm : prev.gradNorm,
          lr: last ? last.lr : prev.lr,
          lossHistory,
          nllHistory,
        };
      });
    },
    [evalMetrics],
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
      if (frames % 2 === 0) setTick((t) => t + 1);
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

  // ---- gradient check ---------------------------------------------------------------
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const box = boxRef.current;
    const ds = dataRef.current;
    if (!box || !ds) return null;
    const k = Math.min(8, ds.n);
    const xb = new Float64Array(k);
    const yb = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      xb[i] = ds.X[i];
      yb[i] = ds.y[i];
    }
    const x = Tensor.fromFlat(xb, k, 1, false);
    const y = Tensor.fromFlat(yb, k, 1, false);

    if (box.kind === 'bbb') {
      const eps = box.net.sampleAllEps(mulberry32(20242)); // frozen ⇒ deterministic ELBO
      return gradCheck(
        box.net.parameters(),
        () => {
          const out = box.net.forwardWith(x, eps);
          const { mu, lv } = splitOut(out, k);
          return gaussianNLL(mu, lv, y).add(box.net.kl(cfg.priorSigma).scale(cfg.klWeight / ds.n));
        },
        { samplesPerParam: 2 },
      );
    }
    if (box.kind === 'dropout') {
      const net = box.net;
      return gradCheck(
        net.parameters(),
        () => {
          const out = net.forward(x, { training: false, dropP: 0, rng: mulberry32(1) });
          const { mu, lv } = splitOut(out, k);
          return gaussianNLL(mu, lv, y);
        },
        { samplesPerParam: 2 },
      );
    }
    const m0 = box.net.members[0];
    return gradCheck(
      m0.parameters(),
      () => {
        const out = m0.forward(x, { training: false, dropP: 0, rng: mulberry32(1) });
        const { mu, lv } = splitOut(out, k);
        return gaussianNLL(mu, lv, y);
      },
      { samplesPerParam: 2 },
    );
  }, [cfg.priorSigma, cfg.klWeight]);

  // ---- visualisation queries --------------------------------------------------------
  const gridXs = useCallback((): Float64Array => {
    const xs = new Float64Array(GRID);
    for (let g = 0; g < GRID; g++) xs[g] = -VIEW_HALF + (g / (GRID - 1)) * 2 * VIEW_HALF;
    return xs;
  }, []);

  const predict = useCallback((): BayesBands | null => {
    const box = boxRef.current;
    if (!box) return null;
    const xs = gridXs();
    const S = box.kind === 'ensemble' ? box.net.members.length : cfg.predSamples;
    const { means, vars } = forwardSamples(xs, S, 0x1234 ^ stepRef.current);
    const pm: Predictive = mixtureMoments(means, vars, GRID);
    const aleStd = new Float64Array(GRID);
    const epiStd = new Float64Array(GRID);
    const totalStd = new Float64Array(GRID);
    for (let g = 0; g < GRID; g++) {
      aleStd[g] = Math.sqrt(pm.aleatoric[g]);
      epiStd[g] = Math.sqrt(pm.epistemic[g]);
      totalStd[g] = Math.sqrt(pm.aleatoric[g] + pm.epistemic[g]);
    }
    return { xs, mean: pm.mean, aleStd, epiStd, totalStd };
  }, [cfg.predSamples, forwardSamples, gridXs]);

  // Individual sampled mean-curves (the "spaghetti" of plausible functions).
  const sampleFunctions = useCallback(
    (count: number): Float64Array[] => {
      const box = boxRef.current;
      if (!box) return [];
      const xs = gridXs();
      const S = box.kind === 'ensemble' ? box.net.members.length : count;
      const { means } = forwardSamples(xs, S, 0xfeed ^ stepRef.current);
      return means;
    },
    [forwardSamples, gridXs],
  );

  const trueCurve = useCallback((): { xs: Float64Array; ys: Float64Array } => {
    const xs = gridXs();
    const ys = new Float64Array(GRID);
    for (let g = 0; g < GRID; g++) ys[g] = trueFn(cfg.func, xs[g]);
    return { xs, ys };
  }, [cfg.func, gridXs]);

  const dataPoints = useCallback((): { x: Float64Array; y: Float64Array } | null => {
    const ds = dataRef.current;
    if (!ds) return null;
    return { x: ds.X, y: ds.y };
  }, []);

  const calibration = useCallback((): CalibrationResult | null => {
    const test = testRef.current;
    const box = boxRef.current;
    if (!test || !box) return null;
    const S = box.kind === 'ensemble' ? box.net.members.length : Math.max(cfg.predSamples, 16);
    const { means, vars } = forwardSamples(test.X, S, 0xc0de ^ stepRef.current);
    const Sn = means.length;
    const pm = mixtureMoments(means, vars, test.n);
    const levels = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
    const observed: number[] = [];
    let ece = 0;
    for (const p of levels) {
      const z = probit((1 + p) / 2);
      let cov = 0;
      for (let i = 0; i < test.n; i++) {
        const total = Math.sqrt(pm.aleatoric[i] + pm.epistemic[i]);
        if (Math.abs(test.y[i] - pm.mean[i]) <= z * total) cov++;
      }
      const o = cov / test.n;
      observed.push(o);
      ece += Math.abs(o - p);
    }
    let se = 0;
    let nllAcc = 0;
    for (let i = 0; i < test.n; i++) {
      const d = test.y[i] - pm.mean[i];
      se += d * d;
      const ms: number[] = [];
      const vs: number[] = [];
      for (let s = 0; s < Sn; s++) {
        ms.push(means[s][i]);
        vs.push(vars[s][i]);
      }
      nllAcc += mixtureNLL(test.y[i], ms, vs);
    }
    return { levels, observed, ece: ece / levels.length, rmse: Math.sqrt(se / test.n), nll: nllAcc / test.n };
  }, [cfg.predSamples, forwardSamples]);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const box = boxRef.current;
    return { weights: box ? box.net.exportWeights() : [], step: stepRef.current };
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
    predict,
    sampleFunctions,
    trueCurve,
    dataPoints,
    calibration,
    snapshot,
    prepareLoad,
  };
}
