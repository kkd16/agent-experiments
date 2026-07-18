import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MetaModel,
  metaStep,
  metaStepClf,
  adaptTrace,
  adaptClfTrace,
  fewShotCurve,
  fewShotCurveClf,
  sampleTask,
  taskBatch,
  taskTruth,
  domainGrid,
  sampleClfTask,
  clfBatch,
  makeLayers,
  cloneLayers,
  forwardLayers,
  CLF_VIEW,
  type MetaConfig,
  type ClfMetaConfig,
  type MetaAlgo,
  type TaskFamily,
  type Task,
  type Batch,
  type Layer,
  type ClfTask,
  type ClfBatch,
  type ClfField,
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

export type MetaMode = 'regression' | 'classification';

export interface MetaConfigUI {
  mode: MetaMode;
  family: TaskFamily; // regression task family
  nClasses: number; // classification: number of classes
  std: number; // classification: blob spread
  algo: MetaAlgo;
  hidden: number;
  depth: number;
  kShot: number; // support size (per class in classification)
  querySize: number; // query size (per class in classification)
  innerSteps: number;
  innerLr: number;
  metaLr: number;
  metaBatch: number;
  noise: number; // regression: label noise
  seed: number;
  metaStepsPerFrame: number;
  loadId: number;
}

export interface MetaMetrics {
  step: number;
  // regression (loss); classification reuses these too (post-adapt query CE loss)
  preLoss: number;
  postLoss: number;
  preHistory: number[];
  postHistory: number[];
  // classification (accuracy)
  preAcc: number;
  postAcc: number;
  preAccHistory: number[];
  postAccHistory: number[];
}

export interface MetaHandle {
  model: MetaModel | null;
  paramCount: number;
}

export interface NovelProblem {
  task: Task;
  support: Batch;
}
export interface NovelClfProblem {
  task: ClfTask;
  support: ClfBatch;
}

export interface AdaptationView {
  grid: Float64Array;
  truth: Float64Array;
  support: Batch;
  metaPreds: Float64Array[];
  randomPreds: Float64Array[];
  metaSupportLoss: number[];
  randomSupportLoss: number[];
}

export interface ClfAdaptationView {
  res: number;
  view: number;
  task: ClfTask;
  support: ClfBatch;
  metaFields: ClfField[];
  randomFields: ClfField[];
  metaSupportAcc: number[];
  randomSupportAcc: number[];
}

export interface FewShotView {
  steps: number[];
  meta: number[];
  random: number[];
}

const MAX_HISTORY = 500;
const GRID_RES = 121;
const CLF_GRID_RES = 64;
const EVAL_TASKS = 48;
const EVAL_TASKS_CLF = 40;
const EVAL_EXTRA_STEPS = 5;

const EMPTY_METRICS: MetaMetrics = {
  step: 0,
  preLoss: NaN,
  postLoss: NaN,
  preHistory: [],
  postHistory: [],
  preAcc: NaN,
  postAcc: NaN,
  preAccHistory: [],
  postAccHistory: [],
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

function clfConfig(cfg: MetaConfigUI): ClfMetaConfig {
  return {
    algo: cfg.algo,
    nClasses: cfg.nClasses,
    kShot: cfg.kShot,
    querySize: cfg.querySize,
    innerSteps: cfg.innerSteps,
    innerLr: cfg.innerLr,
    metaLr: cfg.metaLr,
    metaBatch: cfg.metaBatch,
    std: cfg.std,
  };
}

export function useMetaTrainer(cfg: MetaConfigUI) {
  const modelRef = useRef<MetaModel | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const trainRngRef = useRef<() => number>(() => 0);
  const randomInitRef = useRef<Layer[] | null>(null); // fixed random control
  const novelRef = useRef<NovelProblem | null>(null);
  const novelClfRef = useRef<NovelClfProblem | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<MetaHandle>({ model: null, paramCount: 0 });
  const [metrics, setMetrics] = useState<MetaMetrics>(EMPTY_METRICS);

  // Rebuild the model whenever its structure changes (mode/arch/classes/family/seed/algo/load).
  const structKey = JSON.stringify({
    mode: cfg.mode,
    family: cfg.family,
    nClasses: cfg.nClasses,
    algo: cfg.algo,
    hidden: cfg.hidden,
    depth: cfg.depth,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  const resampleNovel = useCallback(() => {
    const model = modelRef.current;
    if (!model) return;
    const rng = mulberry32((cfg.seed ^ (0x2545f491 + stepRef.current * 2654435761)) >>> 0);
    if (cfg.mode === 'classification') {
      const task = sampleClfTask(cfg.nClasses, rng);
      novelClfRef.current = { task, support: clfBatch(task, cfg.kShot, cfg.std, rng) };
    } else {
      const task = sampleTask(cfg.family, rng);
      novelRef.current = { task, support: taskBatch(task, cfg.kShot, cfg.noise, rng) };
    }
    setTick((t) => t + 1);
  }, [cfg.mode, cfg.family, cfg.nClasses, cfg.kShot, cfg.std, cfg.noise, cfg.seed]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const arch = { hidden: cfg.hidden, depth: cfg.depth };
    const clf = cfg.mode === 'classification';
    const inDim = clf ? 2 : 1;
    const outDim = clf ? cfg.nClasses : 1;
    const model = new MetaModel(arch, mulberry32(cfg.seed), inDim, outDim);
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer('adam', cfg.metaLr) };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    randomInitRef.current = makeLayers(arch, mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0), inDim, outDim);
    trainRngRef.current = mulberry32((cfg.seed ^ 0x1a2b3c4d) >>> 0);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    // Pin a novel task for the adaptation panel.
    const nrng = mulberry32((cfg.seed ^ 0x2545f491) >>> 0);
    if (clf) {
      const task = sampleClfTask(cfg.nClasses, nrng);
      novelClfRef.current = { task, support: clfBatch(task, cfg.kShot, cfg.std, nrng) };
    } else {
      const task = sampleTask(cfg.family, nrng);
      novelRef.current = { task, support: taskBatch(task, cfg.kShot, cfg.noise, nrng) };
    }

    setHandle({ model, paramCount: model.paramCount() });
    setMetrics({ ...EMPTY_METRICS, step: stepRef.current });
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
  }, [buildAll]);

  useEffect(() => {
    if (optRef.current) optRef.current.cfg.lr = cfg.metaLr;
  }, [cfg.metaLr]);

  const doMetaStep = useCallback(() => {
    const model = modelRef.current;
    const opt = optRef.current;
    if (!model || !opt) return;
    if (cfg.mode === 'classification') {
      const rep = metaStepClf(model, clfConfig(cfg), trainRngRef.current, () => opt.step());
      stepRef.current++;
      return { clf: true as const, rep };
    }
    const rep = metaStep(model, engineConfig(cfg), trainRngRef.current, () => opt.step());
    stepRef.current++;
    return { clf: false as const, rep };
  }, [cfg]);

  const pushMetrics = useCallback(
    (
      out:
        | { clf: true; rep: { preAdaptAcc: number; postAdaptAcc: number; postAdaptLoss: number } }
        | { clf: false; rep: { preAdaptLoss: number; postAdaptLoss: number } }
        | undefined,
    ) => {
      if (!out) return;
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        if (out.clf) {
          const preAccHistory = cap(m.preAccHistory);
          const postAccHistory = cap(m.postAccHistory);
          const postHistory = cap(m.postHistory);
          preAccHistory.push(out.rep.preAdaptAcc);
          postAccHistory.push(out.rep.postAdaptAcc);
          postHistory.push(out.rep.postAdaptLoss);
          return {
            ...m,
            step: stepRef.current,
            preAcc: out.rep.preAdaptAcc,
            postAcc: out.rep.postAdaptAcc,
            postLoss: out.rep.postAdaptLoss,
            preAccHistory,
            postAccHistory,
            postHistory,
          };
        }
        const preHistory = cap(m.preHistory);
        const postHistory = cap(m.postHistory);
        preHistory.push(out.rep.preAdaptLoss);
        postHistory.push(out.rep.postAdaptLoss);
        return {
          ...m,
          step: stepRef.current,
          preLoss: out.rep.preAdaptLoss,
          postLoss: out.rep.postAdaptLoss,
          preHistory,
          postHistory,
        };
      });
    },
    [],
  );

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: ReturnType<typeof doMetaStep>;
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
    const out = doMetaStep();
    pushMetrics(out);
    setTick((t) => t + 1);
  }, [doMetaStep, pushMetrics]);

  // ---- visualization queries -------------------------------------------------------------------

  const adaptationView = useCallback((): AdaptationView | null => {
    const model = modelRef.current;
    const rnd = randomInitRef.current;
    const problem = novelRef.current;
    // Guard against the one render after a mode switch where the model hasn't rebuilt yet
    // (its input dim still mismatches the requested view).
    if (!model || !rnd || !problem || cfg.mode !== 'regression' || model.inDim !== 1) return null;
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
  }, [cfg.mode, cfg.innerLr, cfg.innerSteps]);

  const clfAdaptationView = useCallback((): ClfAdaptationView | null => {
    const model = modelRef.current;
    const rnd = randomInitRef.current;
    const problem = novelClfRef.current;
    if (!model || !rnd || !problem || cfg.mode !== 'classification' || model.inDim !== 2) return null;
    const metaT = adaptClfTrace(model.theta, problem.support, CLF_GRID_RES, CLF_VIEW, cfg.innerLr, cfg.innerSteps);
    const randT = adaptClfTrace(rnd, problem.support, CLF_GRID_RES, CLF_VIEW, cfg.innerLr, cfg.innerSteps);
    return {
      res: CLF_GRID_RES,
      view: CLF_VIEW,
      task: problem.task,
      support: problem.support,
      metaFields: metaT.fields,
      randomFields: randT.fields,
      metaSupportAcc: metaT.supportAcc,
      randomSupportAcc: randT.supportAcc,
    };
  }, [cfg.mode, cfg.innerLr, cfg.innerSteps]);

  const fewShotView = useCallback((): FewShotView | null => {
    const model = modelRef.current;
    const rnd = randomInitRef.current;
    if (!model || !rnd) return null;
    const evalSteps = cfg.innerSteps + EVAL_EXTRA_STEPS;
    const steps = Array.from({ length: evalSteps + 1 }, (_, i) => i);
    const wantIn = cfg.mode === 'classification' ? 2 : 1;
    if (model.inDim !== wantIn) return null; // model not rebuilt for this mode yet
    if (cfg.mode === 'classification') {
      const meta = fewShotCurveClf(model.theta, cfg.nClasses, EVAL_TASKS_CLF, cfg.kShot, cfg.querySize, evalSteps, cfg.innerLr, cfg.std, mulberry32((cfg.seed ^ 0x51ed270b) >>> 0));
      const random = fewShotCurveClf(rnd, cfg.nClasses, EVAL_TASKS_CLF, cfg.kShot, cfg.querySize, evalSteps, cfg.innerLr, cfg.std, mulberry32((cfg.seed ^ 0x51ed270b) >>> 0));
      return { steps, meta, random };
    }
    const meta = fewShotCurve(model.theta, cfg.family, EVAL_TASKS, cfg.kShot, cfg.querySize, evalSteps, cfg.innerLr, cfg.noise, mulberry32((cfg.seed ^ 0x51ed270b) >>> 0));
    const random = fewShotCurve(rnd, cfg.family, EVAL_TASKS, cfg.kShot, cfg.querySize, evalSteps, cfg.innerLr, cfg.noise, mulberry32((cfg.seed ^ 0x51ed270b) >>> 0));
    return { steps, meta, random };
  }, [cfg.mode, cfg.family, cfg.nClasses, cfg.std, cfg.kShot, cfg.querySize, cfg.innerSteps, cfg.innerLr, cfg.noise, cfg.seed]);

  const taskGallery = useCallback(
    (count: number): { grid: Float64Array; curves: Float64Array[] } => {
      const grid = domainGrid(GRID_RES);
      const rng = mulberry32((cfg.seed ^ 0x27d4eb2f) >>> 0);
      const curves: Float64Array[] = [];
      if (cfg.mode === 'regression') {
        for (let t = 0; t < count; t++) {
          const task = sampleTask(cfg.family, rng);
          const c = new Float64Array(GRID_RES);
          for (let i = 0; i < GRID_RES; i++) c[i] = taskTruth(task, grid[i]);
          curves.push(c);
        }
      }
      return { grid, curves };
    },
    [cfg.mode, cfg.family, cfg.seed],
  );

  const resampleNovelTask = resampleNovel;

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    const problem = novelRef.current;
    if (!model || !problem || cfg.mode !== 'regression') return null;
    const fast = cloneLayers(model.theta);
    const params = fast.flatMap((l) => [l.W, l.b]);
    const xs = problem.support.x;
    const ys = problem.support.y;
    return gradCheck(params, () => metaSupportLoss(fast, xs, ys), { samplesPerParam: 3 });
  }, [cfg.mode]);

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
    metrics,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    adaptationView,
    clfAdaptationView,
    fewShotView,
    taskGallery,
    resampleNovelTask,
    runGradCheck,
    snapshot,
    loadWeights,
    tick,
  };
}
