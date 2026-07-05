import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GP,
  makeGPDataset,
  kernelValue,
  GP_KERNELS,
  DEFAULT_SHAPE,
  type GPConfig,
  type GPDatasetKind,
  type KernelKind,
  type Posterior,
} from '../engine/gp';
import { Optimizer, defaultOptimizer, globalGradNorm, type OptimizerKind } from '../engine/optim';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';

export interface GPConfigUI {
  dataset: GPDatasetKind;
  kind: KernelKind;
  seed: number;
  alpha: number; // rational-quadratic shape
  period: number; // periodic kernel period
  optimizer: OptimizerKind;
  lr: number;
  lockEll: boolean;
  lockSf: boolean;
  lockSn: boolean;
  stepsPerFrame: number;
  sampleCount: number;
  showSamples: boolean;
  showPredictive: boolean;
  loadId: number;
}

export interface HyperReadout {
  logEll: number;
  logSf: number;
  logSn: number;
  ell: number;
  sf: number;
  sn: number;
}

export interface GPMetrics {
  step: number;
  lml: number;
  gradNorm: number;
  lmlHistory: number[];
  hyper: HyperReadout;
}

const MAX_HISTORY = 600;
const MAX_TRAJ = 400;

// sensible starting hyperparameters (the whole point of the lab is to *learn* them from here)
function defaultHyper(): { logEll: number; logSf: number; logSn: number } {
  return { logEll: 0.0, logSf: 0.0, logSn: -1.6 };
}

function readout(gp: GP): HyperReadout {
  return {
    logEll: gp.logEll.data[0],
    logSf: gp.logSf.data[0],
    logSn: gp.logSn.data[0],
    ell: gp.ell,
    sf: Math.sqrt(gp.sf2),
    sn: Math.sqrt(gp.sn2),
  };
}

export interface SharedGP {
  config: GPConfigUI;
  hyper: { logEll: number; logSf: number; logSn: number };
  points: { X: number[]; y: number[] };
  step: number;
}

export function useGPTrainer(cfg: GPConfigUI) {
  const gpRef = useRef<GP | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const pointsRef = useRef<{ X: number[]; y: number[] }>({ X: [], y: [] });
  const hyperRef = useRef(defaultHyper());
  const domainRef = useRef<[number, number]>([-4, 4]);
  const trajRef = useRef<number[]>([]); // flattened (logEll, logSn) pairs
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingShared = useRef<SharedGP | null>(null);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [domain, setDomain] = useState<[number, number]>([-4, 4]);
  const [pointCount, setPointCount] = useState(0);
  const [metrics, setMetrics] = useState<GPMetrics>({
    step: 0,
    lml: NaN,
    gradNorm: NaN,
    lmlHistory: [],
    hyper: { logEll: 0, logSf: 0, logSn: 0, ell: 1, sf: 1, sn: 0.2 },
  });

  const gpConfig = useCallback(
    (): GPConfig => ({
      kind: cfg.kind,
      logEll: hyperRef.current.logEll,
      logSf: hyperRef.current.logSf,
      logSn: hyperRef.current.logSn,
      shape: { alpha: cfg.alpha, period: cfg.period },
    }),
    [cfg.kind, cfg.alpha, cfg.period],
  );

  const rebuildOptimizer = useCallback(() => {
    const gp = gpRef.current;
    if (!gp) return;
    const params = gp.learnable({ ell: cfg.lockEll, sf: cfg.lockSf, sn: cfg.lockSn });
    optRef.current = new Optimizer(params, defaultOptimizer(cfg.optimizer, cfg.lr));
  }, [cfg.lockEll, cfg.lockSf, cfg.lockSn, cfg.optimizer, cfg.lr]);

  const seedMetrics = useCallback(() => {
    const gp = gpRef.current;
    if (!gp) return;
    const lml = gp.logMarginalLikelihood();
    trajRef.current = [gp.logEll.data[0], gp.logSn.data[0]];
    setMetrics({ step: stepRef.current, lml, gradNorm: NaN, lmlHistory: [lml], hyper: readout(gp) });
  }, []);

  const buildGP = useCallback(() => {
    setRunning(false);
    const gp = new GP(pointsRef.current.X, pointsRef.current.y, gpConfig());
    gpRef.current = gp;
    stepRef.current = 0;
    rebuildOptimizer();
    seedMetrics();
    setDomain(domainRef.current);
    setPointCount(pointsRef.current.X.length);
    setTick((t) => t + 1);
  }, [gpConfig, rebuildOptimizer, seedMetrics]);

  // sync live hyper back into the ref so a rebuild/share captures the trained values
  const syncHyperRef = useCallback(() => {
    const gp = gpRef.current;
    if (!gp) return;
    hyperRef.current = { logEll: gp.logEll.data[0], logSf: gp.logSf.data[0], logSn: gp.logSn.data[0] };
  }, []);

  // full reset when the dataset / seed / share-load changes: regenerate points + default hyper
  useEffect(() => {
    if (pendingShared.current) {
      const s = pendingShared.current;
      pendingShared.current = null;
      pointsRef.current = { X: s.points.X.slice(), y: s.points.y.slice() };
      hyperRef.current = { ...s.hyper };
      domainRef.current = deriveDomain(pointsRef.current.X, cfg.dataset);
      stepRef.current = s.step;
      buildGP();
      return;
    }
    const ds = makeGPDataset(cfg.dataset, cfg.seed);
    pointsRef.current = { X: ds.X.slice(), y: ds.y.slice() };
    domainRef.current = ds.domain;
    hyperRef.current = defaultHyper();
    buildGP();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.dataset, cfg.seed, cfg.loadId]);

  // kernel change: keep the points and the current hyperparameters, rebuild with the new kernel
  useEffect(() => {
    syncHyperRef();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildGP();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.kind]);

  // shape knobs: rebuild the kernel constants but keep hyper + points
  useEffect(() => {
    const gp = gpRef.current;
    if (!gp) return;
    gp.shape.alpha = cfg.alpha;
    gp.setPeriod(cfg.period);
    seedMetrics();
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.alpha, cfg.period]);

  // optimizer / lr / locks: rebuild the optimizer over the (possibly new) learnable set
  useEffect(() => {
    rebuildOptimizer();
  }, [rebuildOptimizer]);

  const trainStep = useCallback((): void => {
    const gp = gpRef.current;
    const opt = optRef.current;
    if (!gp || !opt || gp.X.length === 0 || opt.params.length === 0) return;
    const nll = gp.nll();
    opt.zeroGrad();
    nll.backward();
    opt.step();
    stepRef.current++;
  }, []);

  const pushMetrics = useCallback(() => {
    const gp = gpRef.current;
    if (!gp) return;
    const lml = gp.logMarginalLikelihood();
    const gnorm = globalGradNorm(optRef.current?.params ?? []);
    trajRef.current.push(gp.logEll.data[0], gp.logSn.data[0]);
    if (trajRef.current.length > MAX_TRAJ * 2) trajRef.current.splice(0, trajRef.current.length - MAX_TRAJ * 2);
    setMetrics((m) => {
      const hist = m.lmlHistory.length >= MAX_HISTORY ? m.lmlHistory.slice(1) : m.lmlHistory.slice();
      hist.push(lml);
      return { step: stepRef.current, lml, gradNorm: gnorm, lmlHistory: hist, hyper: readout(gp) };
    });
  }, []);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    const frame = () => {
      if (!alive) return;
      for (let i = 0; i < cfg.stepsPerFrame; i++) trainStep();
      syncHyperRef();
      pushMetrics();
      setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, cfg.stepsPerFrame, trainStep, pushMetrics, syncHyperRef]);

  const start = useCallback(() => {
    const gp = gpRef.current;
    if (gp && gp.X.length > 0 && (optRef.current?.params.length ?? 0) > 0) setRunning(true);
  }, []);
  const pause = useCallback(() => {
    setRunning(false);
    setTick((t) => t + 1);
  }, []);
  const reset = useCallback(() => {
    setRunning(false);
    hyperRef.current = defaultHyper();
    buildGP();
  }, [buildGP]);
  const stepOnce = useCallback(() => {
    trainStep();
    syncHyperRef();
    pushMetrics();
    setTick((t) => t + 1);
  }, [trainStep, syncHyperRef, pushMetrics]);

  // set one hyperparameter live from a slider
  const setHyper = useCallback(
    (name: 'ell' | 'sf' | 'sn', logVal: number) => {
      const gp = gpRef.current;
      if (!gp) return;
      const t = name === 'ell' ? gp.logEll : name === 'sf' ? gp.logSf : gp.logSn;
      t.data[0] = logVal;
      syncHyperRef();
      const lml = gp.logMarginalLikelihood();
      trajRef.current.push(gp.logEll.data[0], gp.logSn.data[0]);
      setMetrics((m) => ({ ...m, lml, hyper: readout(gp) }));
      setTick((x) => x + 1);
    },
    [syncHyperRef],
  );

  const addPoint = useCallback(
    (x: number, y: number) => {
      pointsRef.current.X.push(x);
      pointsRef.current.y.push(y);
      syncHyperRef();
      setRunning(false);
      buildGP();
    },
    [buildGP, syncHyperRef],
  );

  const removePointNear = useCallback(
    (x: number, spanX: number) => {
      const pts = pointsRef.current;
      if (pts.X.length === 0) return;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < pts.X.length; i++) {
        const d = Math.abs(pts.X[i] - x);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0 && bestD < spanX * 0.04) {
        pts.X.splice(best, 1);
        pts.y.splice(best, 1);
        syncHyperRef();
        setRunning(false);
        buildGP();
      }
    },
    [buildGP, syncHyperRef],
  );

  const clearPoints = useCallback(() => {
    pointsRef.current = { X: [], y: [] };
    syncHyperRef();
    setRunning(false);
    buildGP();
  }, [buildGP, syncHyperRef]);

  const resetPoints = useCallback(() => {
    const ds = makeGPDataset(cfg.dataset, cfg.seed);
    pointsRef.current = { X: ds.X.slice(), y: ds.y.slice() };
    domainRef.current = ds.domain;
    syncHyperRef();
    setRunning(false);
    buildGP();
  }, [cfg.dataset, cfg.seed, buildGP, syncHyperRef]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const gp = gpRef.current;
    if (!gp || gp.X.length === 0) return null;
    // Verify the Cholesky VJP at a fixed, well-conditioned *off-optimum* reference point: at a
    // converged hyperparameter setting the marginal-likelihood gradient is ≈0, so a *relative*
    // finite-difference error is dominated by 0/0 noise and reads spuriously large. Nudging to a
    // reference (where ∂NLL/∂θ is genuinely non-trivial) checks the exact same backward pass.
    const saved = [gp.logEll.data[0], gp.logSf.data[0], gp.logSn.data[0]];
    gp.logEll.data[0] = -0.3;
    gp.logSf.data[0] = 0.0;
    gp.logSn.data[0] = -1.0;
    const res = gradCheck(gp.allParams(), () => gp.nll(), { samplesPerParam: 1, eps: 1e-5 });
    gp.logEll.data[0] = saved[0];
    gp.logSf.data[0] = saved[1];
    gp.logSn.data[0] = saved[2];
    return res;
  }, []);

  // ---- visualisation queries --------------------------------------------------------

  const linspace = useCallback((res: number): Float64Array => {
    const [a, b] = domainRef.current;
    const xs = new Float64Array(res);
    for (let i = 0; i < res; i++) xs[i] = a + (i / (res - 1)) * (b - a);
    return xs;
  }, []);

  const posterior = useCallback(
    (res: number): Posterior | null => {
      const gp = gpRef.current;
      if (!gp) return null;
      return gp.posterior(linspace(res));
    },
    [linspace],
  );

  const samples = useCallback(
    (res: number, count: number, seed: number): { Xs: Float64Array; curves: Float64Array[] } | null => {
      const gp = gpRef.current;
      if (!gp) return null;
      const Xs = linspace(res);
      return { Xs, curves: gp.sampleFunctions(Xs, count, seed) };
    },
    [linspace],
  );

  const kernelMatrix = useCallback((): { data: Float64Array; n: number } | null => {
    const gp = gpRef.current;
    if (!gp || gp.X.length === 0) return null;
    const K = gp.buildK();
    return { data: K.data.slice(), n: K.rows };
  }, []);

  const kernelShape = useCallback(
    (res: number): { rs: Float64Array; ks: Float64Array; prior: Float64Array[] } | null => {
      const gp = gpRef.current;
      if (!gp) return null;
      const [a, b] = domainRef.current;
      const rmax = (b - a) * 0.6;
      const rs = new Float64Array(res);
      const ks = new Float64Array(res);
      for (let i = 0; i < res; i++) {
        rs[i] = (i / (res - 1)) * rmax;
        ks[i] = kernelValue(gp.kind, rs[i], gp.ell, gp.sf2, gp.shape) / gp.sf2; // normalized correlation
      }
      // draw a few functions straight from the prior (an empty-data GP with the same kernel)
      const Xs = linspace(res);
      const priorGP = new GP([], [], {
        kind: gp.kind,
        logEll: gp.logEll.data[0],
        logSf: gp.logSf.data[0],
        logSn: gp.logSn.data[0],
        shape: gp.shape,
      });
      const prior = priorGP.sampleFunctions(Xs, 4, 20240705);
      return { rs, ks, prior };
    },
    [linspace],
  );

  const lmlLandscape = useCallback(
    (res: number): {
      values: Float64Array;
      ellAxis: Float64Array;
      snAxis: Float64Array;
      min: number;
      max: number;
      cur: [number, number];
      traj: number[];
    } | null => {
      const gp = gpRef.current;
      if (!gp || gp.X.length === 0) return null;
      const cle = gp.logEll.data[0];
      const csn = gp.logSn.data[0];
      const ellRange: [number, number] = [Math.min(cle - 2.2, -2.5), Math.max(cle + 2.2, 2.5)];
      const snRange: [number, number] = [Math.min(csn - 2.5, -5), Math.max(csn + 1.5, 0.5)];
      const grid = gp.lmlGrid(ellRange, snRange, res);
      return { ...grid, cur: [cle, csn], traj: trajRef.current.slice() };
    },
    [],
  );

  const shareState = useCallback((): SharedGP => {
    const gp = gpRef.current;
    return {
      config: cfg,
      hyper: gp
        ? { logEll: gp.logEll.data[0], logSf: gp.logSf.data[0], logSn: gp.logSn.data[0] }
        : hyperRef.current,
      points: { X: pointsRef.current.X.slice(), y: pointsRef.current.y.slice() },
      step: stepRef.current,
    };
  }, [cfg]);

  const prepareShared = useCallback((s: SharedGP) => {
    pendingShared.current = s;
  }, []);

  const dataPoints = useCallback((): { X: number[]; y: number[] } => {
    return { X: pointsRef.current.X.slice(), y: pointsRef.current.y.slice() };
  }, []);

  return {
    running,
    tick,
    metrics,
    start,
    pause,
    reset,
    stepOnce,
    setHyper,
    addPoint,
    removePointNear,
    clearPoints,
    resetPoints,
    runGradCheck,
    posterior,
    samples,
    kernelMatrix,
    kernelShape,
    lmlLandscape,
    dataPoints,
    domain,
    pointCount,
    shareState,
    prepareShared,
  };
}

function deriveDomain(X: number[], dataset: GPDatasetKind): [number, number] {
  if (X.length === 0) return makeGPDataset(dataset, 0).domain;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of X) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  const pad = Math.max(1, (hi - lo) * 0.25);
  return [lo - pad, hi + pad];
}

export { GP_KERNELS, DEFAULT_SHAPE };
