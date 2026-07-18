import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MetaModel,
  metaStep,
  adaptTrace,
  fewShotCurve,
  sampleTask,
  taskBatch,
  taskTruth,
  domainGrid,
  makeLayers,
  cloneLayers,
  forwardLayers,
  type MetaConfig,
  type MetaAlgo,
  type TaskFamily,
  type Task,
  type Batch,
  type Layer,
} from '../engine/meta';
import { mulberry32 } from '../engine/nn';
import { mse } from '../engine/losses';
import { Tensor } from '../engine/tensor';
import { Optimizer, defaultOptimizer, type OptimizerConfig } from '../engine/optim';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';

// A scalar MSE loss for the gradient check, rebuilt from the current fast-weight values each call
// (finite differences perturb them in place between evaluations).
function metaSupportLoss(layers: Layer[], xs: Float64Array, ys: Float64Array): Tensor {
  const x = Tensor.fromFlat(xs.slice(), xs.length, 1);
  const y = Tensor.fromFlat(ys.slice(), ys.length, 1);
  return mse(forwardLayers(layers, x), y);
}

export interface MetaConfigUI {
  family: TaskFamily;
  algo: MetaAlgo;
  hidden: number;
  depth: number;
  kShot: number;
  querySize: number;
  innerSteps: number;
  innerLr: number;
  metaLr: number;
  metaBatch: number;
  noise: number;
  seed: number;
  metaStepsPerFrame: number;
  loadId: number;
}

export interface MetaMetrics {
  step: number;
  preLoss: number;
  postLoss: number;
  preHistory: number[];
  postHistory: number[];
}

export interface MetaHandle {
  model: MetaModel | null;
  paramCount: number;
}

// One novel task the adaptation panel is pinned to, plus its support set (kept stable across
// meta-steps so the panel animates the *same* few-shot problem as θ improves).
export interface NovelProblem {
  task: Task;
  support: Batch;
}

export interface AdaptationView {
  grid: Float64Array;
  truth: Float64Array;
  support: Batch;
  metaPreds: Float64Array[]; // prediction over grid after 0..innerSteps, from the meta-init
  randomPreds: Float64Array[]; // ditto, from a random init (the control)
  metaSupportLoss: number[];
  randomSupportLoss: number[];
}

export interface FewShotView {
  steps: number[]; // 0..evalSteps
  meta: number[]; // avg query MSE of the current model, adapting step by step
  random: number[]; // avg query MSE of a random init, same tasks
}

const MAX_HISTORY = 500;
const GRID_RES = 121;
const EVAL_TASKS = 48;
const EVAL_EXTRA_STEPS = 5; // eval curve runs a few steps past the training innerSteps

const EMPTY_METRICS: MetaMetrics = {
  step: 0,
  preLoss: NaN,
  postLoss: NaN,
  preHistory: [],
  postHistory: [],
};

function engineConfig(cfg: MetaConfigUI): MetaConfig {
  return {
    family: cfg.family,
    algo: cfg.algo,
    arch: { hidden: cfg.hidden, depth: cfg.depth },
    kShot: cfg.kShot,
    querySize: cfg.querySize,
    innerSteps: cfg.innerSteps,
    innerLr: cfg.innerLr,
    metaLr: cfg.metaLr,
    metaBatch: cfg.metaBatch,
    noise: cfg.noise,
  };
}

export function useMetaTrainer(cfg: MetaConfigUI) {
  const modelRef = useRef<MetaModel | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const trainRngRef = useRef<() => number>(() => 0);
  const randomInitRef = useRef<Layer[] | null>(null); // fixed random control for the comparisons
  const novelRef = useRef<NovelProblem | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<MetaHandle>({ model: null, paramCount: 0 });
  const [metrics, setMetrics] = useState<MetaMetrics>(EMPTY_METRICS);

  // Structural key: rebuilding the model (arch / family / seed / algo / loaded weights).
  const structKey = JSON.stringify({
    family: cfg.family,
    algo: cfg.algo,
    hidden: cfg.hidden,
    depth: cfg.depth,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  const resampleNovel = useCallback(() => {
    const model = modelRef.current;
    if (!model) return;
    // A stable RNG derived from the seed + a nonce so "new task" gives a fresh but reproducible one.
    const rng = mulberry32((cfg.seed ^ (0x2545f491 + stepRef.current * 2654435761)) >>> 0);
    const task = sampleTask(cfg.family, rng);
    const support = taskBatch(task, cfg.kShot, cfg.noise, rng);
    novelRef.current = { task, support };
    setTick((t) => t + 1);
  }, [cfg.family, cfg.kShot, cfg.noise, cfg.seed]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const model = new MetaModel({ hidden: cfg.hidden, depth: cfg.depth }, mulberry32(cfg.seed));
    modelRef.current = model;
    // FOMAML / baseline drive an Adam outer optimizer over θ; Reptile updates θ in place.
    const ocfg: OptimizerConfig = { ...defaultOptimizer('adam', cfg.metaLr) };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    // A fixed random init (never trained) as the honest control in every comparison.
    randomInitRef.current = makeLayers({ hidden: cfg.hidden, depth: cfg.depth }, mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0));
    trainRngRef.current = mulberry32((cfg.seed ^ 0x1a2b3c4d) >>> 0);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    // Pin a novel task for the adaptation panel.
    const nrng = mulberry32((cfg.seed ^ 0x2545f491) >>> 0);
    const task = sampleTask(cfg.family, nrng);
    novelRef.current = { task, support: taskBatch(task, cfg.kShot, cfg.noise, nrng) };

    setHandle({ model, paramCount: model.paramCount() });
    setMetrics({ ...EMPTY_METRICS, step: stepRef.current });
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
  }, [buildAll]);

  // Keep the outer optimizer LR in sync when the slider moves (no rebuild).
  useEffect(() => {
    if (optRef.current) optRef.current.cfg.lr = cfg.metaLr;
  }, [cfg.metaLr]);

  const doMetaStep = useCallback(() => {
    const model = modelRef.current;
    const opt = optRef.current;
    if (!model || !opt) return;
    const rep = metaStep(model, engineConfig(cfg), trainRngRef.current, () => opt.step());
    stepRef.current++;
    return rep;
  }, [cfg]);

  const pushMetrics = useCallback((rep: { preAdaptLoss: number; postAdaptLoss: number } | undefined) => {
    if (!rep) return;
    setMetrics((m) => {
      const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
      const preHistory = cap(m.preHistory);
      const postHistory = cap(m.postHistory);
      preHistory.push(rep.preAdaptLoss);
      postHistory.push(rep.postAdaptLoss);
      return {
        step: stepRef.current,
        preLoss: rep.preAdaptLoss,
        postLoss: rep.postAdaptLoss,
        preHistory,
        postHistory,
      };
    });
  }, []);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: { preAdaptLoss: number; postAdaptLoss: number } | undefined;
      for (let i = 0; i < cfg.metaStepsPerFrame; i++) last = doMetaStep();
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
  }, [running, cfg.metaStepsPerFrame, doMetaStep, pushMetrics]);

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
    const rep = doMetaStep();
    pushMetrics(rep);
    setTick((t) => t + 1);
  }, [doMetaStep, pushMetrics]);

  // ---- visualization queries -------------------------------------------------------------------

  const adaptationView = useCallback((): AdaptationView | null => {
    const model = modelRef.current;
    const rnd = randomInitRef.current;
    const problem = novelRef.current;
    if (!model || !rnd || !problem) return null;
    const grid = domainGrid(GRID_RES);
    const truth = new Float64Array(GRID_RES);
    for (let i = 0; i < GRID_RES; i++) truth[i] = taskTruth(problem.task, grid[i]);
    const metaT = adaptTrace(model.theta, problem.support, grid, cfg.innerLr, cfg.innerSteps);
    const randT = adaptTrace(rnd, problem.support, grid, cfg.innerLr, cfg.innerSteps);
    return {
      grid,
      truth,
      support: problem.support,
      metaPreds: metaT.preds,
      randomPreds: randT.preds,
      metaSupportLoss: metaT.supportLoss,
      randomSupportLoss: randT.supportLoss,
    };
  }, [cfg.innerLr, cfg.innerSteps]);

  const fewShotView = useCallback((): FewShotView | null => {
    const model = modelRef.current;
    const rnd = randomInitRef.current;
    if (!model || !rnd) return null;
    const evalSteps = cfg.innerSteps + EVAL_EXTRA_STEPS;
    // Same seed for both curves => the *same* novel tasks, an apples-to-apples comparison.
    const metaRng = mulberry32((cfg.seed ^ 0x51ed270b) >>> 0);
    const randRng = mulberry32((cfg.seed ^ 0x51ed270b) >>> 0);
    const meta = fewShotCurve(model.theta, cfg.family, EVAL_TASKS, cfg.kShot, cfg.querySize, evalSteps, cfg.innerLr, cfg.noise, metaRng);
    const random = fewShotCurve(rnd, cfg.family, EVAL_TASKS, cfg.kShot, cfg.querySize, evalSteps, cfg.innerLr, cfg.noise, randRng);
    const steps = Array.from({ length: evalSteps + 1 }, (_, i) => i);
    return { steps, meta, random };
  }, [cfg.family, cfg.kShot, cfg.querySize, cfg.innerSteps, cfg.innerLr, cfg.noise, cfg.seed]);

  // A small-multiples gallery of sampled tasks (just the ground-truth curves).
  const taskGallery = useCallback(
    (count: number): { grid: Float64Array; curves: Float64Array[] } => {
      const grid = domainGrid(GRID_RES);
      const rng = mulberry32((cfg.seed ^ 0x27d4eb2f) >>> 0);
      const curves: Float64Array[] = [];
      for (let t = 0; t < count; t++) {
        const task = sampleTask(cfg.family, rng);
        const c = new Float64Array(GRID_RES);
        for (let i = 0; i < GRID_RES; i++) c[i] = taskTruth(task, grid[i]);
        curves.push(c);
      }
      return { grid, curves };
    },
    [cfg.family, cfg.seed],
  );

  const resampleNovelTask = resampleNovel;

  // Gradient check of the functional MLP's autograd on a support batch (the inner-loop objective).
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    const problem = novelRef.current;
    if (!model || !problem) return null;
    const fast = cloneLayers(model.theta);
    const params = fast.flatMap((l) => [l.W, l.b]);
    const xs = problem.support.x;
    const ys = problem.support.y;
    return gradCheck(params, () => metaSupportLoss(fast, xs, ys), { samplesPerParam: 3 });
  }, []);

  // Read the refs inside a callback (never during render): the weights + step to save/share.
  const snapshot = useCallback((): { weights: number[]; step: number } => ({
    weights: modelRef.current?.exportWeights() ?? [],
    step: stepRef.current,
  }), []);
  const loadWeights = useCallback((flat: number[], step: number) => {
    pendingWeights.current = flat;
    pendingStep.current = step;
  }, []);

  return {
    running,
    tick,
    handle,
    metrics,
    start,
    pause,
    reset,
    stepOnce,
    adaptationView,
    fewShotView,
    taskGallery,
    resampleNovelTask,
    runGradCheck,
    snapshot,
    loadWeights,
  };
}
