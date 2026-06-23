import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import {
  NeuralODE,
  makeNodeDataset,
  terminalAdjointCE,
  adjointDynamicsGrad,
  type NeuralODEConfig,
  type Solver,
} from '../engine/node-ode';
import type { ClassDatasetKind, ClassDataset } from '../engine/data';
import { mulberry32, type Activation } from '../engine/nn';
import { softmaxCrossEntropy } from '../engine/losses';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';

// The data lives in roughly [-1.2, 1.2]², so this half-window frames it with a margin.
export const NODE_VIEW = 1.5;

export interface NodeConfigUI {
  dataset: ClassDatasetKind;
  samples: number;
  noise: number;
  seed: number;
  augDim: number;
  hidden: number;
  depth: number;
  activation: Activation;
  solver: Solver;
  steps: number;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  scheduleKind: ScheduleKind;
  schedulePeriod: number;
  scheduleWarmup: number;
  clipNorm: number;
  valFraction: number;
  gridRes: number;
  trajCount: number;
  loadId: number;
}

export interface NodeMetrics {
  step: number;
  loss: number;
  trainAcc: number;
  valAcc: number;
  gradNorm: number;
  lr: number;
  lossHistory: number[];
  trainAccHistory: number[];
  valAccHistory: number[];
}

export interface NodeHandle {
  model: NeuralODE | null;
  data: ClassDataset | null;
  classes: number;
  view: number;
}

export interface AdjointReport {
  relL2: number;
  maxRel: number;
  steps: number;
  paramCount: number;
  cosine: number;
}

const MAX_HISTORY = 600;
const EVAL_CAP = 800;

const EMPTY_METRICS: NodeMetrics = {
  step: 0,
  loss: NaN,
  trainAcc: NaN,
  valAcc: NaN,
  gradNorm: NaN,
  lr: NaN,
  lossHistory: [],
  trainAccHistory: [],
  valAccHistory: [],
};

function scheduleOf(cfg: NodeConfigUI): ScheduleConfig {
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

function modelConfig(cfg: NodeConfigUI, classes: number): NeuralODEConfig {
  return {
    inDim: 2,
    classes,
    arch: { hidden: cfg.hidden, depth: cfg.depth, activation: cfg.activation, augDim: cfg.augDim },
    solver: cfg.solver,
    steps: cfg.steps,
    t0: 0,
    t1: 1,
  };
}

export function useNodeTrainer(cfg: NodeConfigUI) {
  const modelRef = useRef<NeuralODE | null>(null);
  const dataRef = useRef<ClassDataset | null>(null);
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
  const [handle, setHandle] = useState<NodeHandle>({ model: null, data: null, classes: 2, view: NODE_VIEW });
  const [metrics, setMetrics] = useState<NodeMetrics>(EMPTY_METRICS);

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    samples: cfg.samples,
    noise: cfg.noise,
    seed: cfg.seed,
    augDim: cfg.augDim,
    hidden: cfg.hidden,
    depth: cfg.depth,
    activation: cfg.activation,
    solver: cfg.solver,
    steps: cfg.steps,
    optimizer: cfg.optimizer,
    valFraction: cfg.valFraction,
    loadId: cfg.loadId,
  });

  const batchTensor = useCallback((idx: Int32Array, start: number, count: number): { x: Tensor; y: Int32Array } => {
    const ds = dataRef.current!;
    const Xb = new Float64Array(count * 2);
    const yb = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const di = idx[start + i];
      Xb[i * 2] = ds.X[di * 2];
      Xb[i * 2 + 1] = ds.X[di * 2 + 1];
      yb[i] = ds.y[di];
    }
    return { x: Tensor.fromFlat(Xb, count, 2), y: yb };
  }, []);

  const evalAcc = useCallback((idx: Int32Array): number => {
    const model = modelRef.current;
    if (!model || idx.length === 0) return NaN;
    const k = Math.min(idx.length, EVAL_CAP);
    const xy = new Float64Array(k * 2);
    const ds = dataRef.current!;
    for (let i = 0; i < k; i++) {
      const di = idx[i];
      xy[i * 2] = ds.X[di * 2];
      xy[i * 2 + 1] = ds.X[di * 2 + 1];
    }
    const { cls } = model.classifyRaw(xy, k);
    let correct = 0;
    for (let i = 0; i < k; i++) if (cls[i] === ds.y[idx[i]]) correct++;
    return correct / k;
  }, []);

  const seedMetrics = useCallback(() => {
    const tr = evalAcc(trainIdxRef.current);
    const va = valIdxRef.current.length ? evalAcc(valIdxRef.current) : NaN;
    setMetrics({ ...EMPTY_METRICS, step: stepRef.current, trainAcc: tr, valAcc: va, lr: cfg.lr, trainAccHistory: [tr], valAccHistory: [va] });
  }, [evalAcc, cfg.lr]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const ds = makeNodeDataset(cfg.dataset, cfg.samples, cfg.noise, cfg.seed);
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

    const model = new NeuralODE(modelConfig(cfg, ds.classes), mulberry32(cfg.seed));
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, data: ds, classes: ds.classes, view: NODE_VIEW });
    seedMetrics();
    setTick((t) => t + 1);
  }, [
    cfg.dataset,
    cfg.samples,
    cfg.noise,
    cfg.seed,
    cfg.augDim,
    cfg.hidden,
    cfg.depth,
    cfg.activation,
    cfg.solver,
    cfg.steps,
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
    const { x, y } = batchTensor(order, cursor.current, bs);
    cursor.current += bs;
    const logits = model.forward(x);
    const { loss } = softmaxCrossEntropy(logits, y);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.cfg.lr = lrAt(scheduleOf(cfg), stepRef.current);
    opt.step();
    stepRef.current++;
    return { gradNorm, lr: opt.cfg.lr, loss: loss.data[0] };
  }, [cfg, batchTensor]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; lr: number; loss: number } | undefined) => {
      const tr = evalAcc(trainIdxRef.current);
      const va = valIdxRef.current.length ? evalAcc(valIdxRef.current) : NaN;
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const trainAccHistory = cap(m.trainAccHistory);
        const valAccHistory = cap(m.valAccHistory);
        if (last) lossHistory.push(last.loss);
        trainAccHistory.push(tr);
        valAccHistory.push(va);
        return {
          step: stepRef.current,
          loss: last ? last.loss : m.loss,
          trainAcc: tr,
          valAcc: va,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          lr: last ? last.lr : m.lr,
          lossHistory,
          trainAccHistory,
          valAccHistory,
        };
      });
    },
    [evalAcc],
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
      if (frames % 3 === 0) setTick((t) => t + 1);
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
    const k = Math.min(12, src.length);
    const { x, y } = batchTensor(src, 0, k);
    return gradCheck(model.parameters(), () => softmaxCrossEntropy(model.forward(x), y).loss, { samplesPerParam: 2 });
  }, [batchTensor]);

  // Compare the O(1)-memory continuous adjoint against back-prop-through-the-solver on a real
  // batch — the proof the adjoint ODE is implemented right.
  const runAdjointCheck = useCallback((): AdjointReport | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    const src = trainIdxRef.current.length ? trainIdxRef.current : new Int32Array([...Array(ds.n).keys()]);
    const k = Math.min(64, src.length);
    const { x, y } = batchTensor(src, 0, k);

    // back-prop reference (dynamics params only)
    const logits = model.forward(x);
    softmaxCrossEntropy(logits, y).loss.backward();
    const bp = model.func.parameters().map((p) => p.grad.slice());

    // continuous adjoint
    const z1 = model.flow(x);
    const { aT } = terminalAdjointCE(model, z1, y);
    const { paramGrads } = adjointDynamicsGrad(model.func, z1.data, aT, k, model.cfg.steps, 0, 1, model.cfg.solver);

    let num = 0;
    let den = 0;
    let maxRel = 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    let count = 0;
    for (let pi = 0; pi < bp.length; pi++) {
      for (let i = 0; i < bp[pi].length; i++) {
        const a = bp[pi][i];
        const b = paramGrads[pi][i];
        num += (a - b) * (a - b);
        den += a * a;
        dot += a * b;
        na += a * a;
        nb += b * b;
        const denom = Math.max(Math.abs(a) + Math.abs(b), 1e-8);
        maxRel = Math.max(maxRel, Math.abs(a - b) / denom);
        count++;
      }
    }
    return {
      relL2: Math.sqrt(num / Math.max(den, 1e-30)),
      maxRel,
      steps: model.cfg.steps,
      paramCount: count,
      cosine: dot / Math.max(Math.sqrt(na * nb), 1e-30),
    };
  }, [batchTensor]);

  // ---- visualisation queries --------------------------------------------------------

  // The terminal (t=1) decision field over the view window: class index + confidence per cell.
  const decisionField = useCallback((res: number): { cls: Int32Array; conf: Float64Array; res: number } | null => {
    const model = modelRef.current;
    if (!model) return null;
    const xy = new Float64Array(res * res * 2);
    let r = 0;
    for (let gy = 0; gy < res; gy++) {
      const y = NODE_VIEW - (gy / (res - 1)) * 2 * NODE_VIEW;
      for (let gx = 0; gx < res; gx++) {
        const x = -NODE_VIEW + (gx / (res - 1)) * 2 * NODE_VIEW;
        xy[r * 2] = x;
        xy[r * 2 + 1] = y;
        r++;
      }
    }
    const { cls, conf } = model.classifyRaw(xy, res * res);
    return { cls, conf, res };
  }, []);

  // Trajectories of a capped sample of data points across the whole integration, returned as
  // `frames+1` snapshots so the UI can scrub/animate the continuous transformation. Each point
  // keeps its true label for colouring. The first two state channels are the plane coords; the
  // third (when augmented) is returned separately for the "lift" view.
  const sampleTrajectories = useCallback(
    (count: number, frames: number): { plane: Float64Array[]; aug: Float64Array[] | null; labels: Int32Array; frames: number } | null => {
      const model = modelRef.current;
      const ds = dataRef.current;
      if (!model || !ds) return null;
      const idx = trainIdxRef.current.length ? trainIdxRef.current : new Int32Array([...Array(ds.n).keys()]);
      const k = Math.min(count, idx.length);
      const D = model.D;
      const labels = new Int32Array(k);
      const z0 = new Float64Array(k * D);
      for (let i = 0; i < k; i++) {
        const di = idx[i];
        z0[i * D] = ds.X[di * 2];
        z0[i * D + 1] = ds.X[di * 2 + 1];
        labels[i] = ds.y[di];
      }
      // integrate with `frames` viz steps for a smooth path (independent of training steps)
      const trace = traceRaw(model, z0, k, frames);
      const plane = trace.map((zf) => {
        const out = new Float64Array(k * 2);
        for (let i = 0; i < k; i++) {
          out[i * 2] = zf[i * D];
          out[i * 2 + 1] = zf[i * D + 1];
        }
        return out;
      });
      let aug: Float64Array[] | null = null;
      if (D > 2) {
        aug = trace.map((zf) => {
          const out = new Float64Array(k * 2);
          for (let i = 0; i < k; i++) {
            out[i * 2] = zf[i * D]; // plane x
            out[i * 2 + 1] = zf[i * D + 2]; // first augment channel
          }
          return out;
        });
      }
      return { plane, aug, labels, frames };
    },
    [],
  );

  // The learned vector field f_θ(·, t) restricted to the plane (aug channels = 0) at time t,
  // sampled on a res×res grid, returned as (x, y, dx, dy) so the UI can draw a quiver.
  const vectorField = useCallback((res: number, t: number): Float64Array | null => {
    const model = modelRef.current;
    if (!model) return null;
    const D = model.D;
    const z = new Float64Array(res * res * D);
    const out = new Float64Array(res * res * 4);
    let r = 0;
    for (let gy = 0; gy < res; gy++) {
      const y = NODE_VIEW - (gy / (res - 1)) * 2 * NODE_VIEW;
      for (let gx = 0; gx < res; gx++) {
        const x = -NODE_VIEW + (gx / (res - 1)) * 2 * NODE_VIEW;
        z[r * D] = x;
        z[r * D + 1] = y;
        out[r * 4] = x;
        out[r * 4 + 1] = y;
        r++;
      }
    }
    const v = model.func.evalRaw(z, res * res, t);
    for (let i = 0; i < res * res; i++) {
      out[i * 4 + 2] = v[i * D];
      out[i * 4 + 3] = v[i * D + 1];
    }
    return out;
  }, []);

  const dataPoints = useCallback((): { xy: Float64Array; labels: Int32Array } | null => {
    const ds = dataRef.current;
    if (!ds) return null;
    const k = Math.min(ds.n, 1200);
    const xy = new Float64Array(k * 2);
    const labels = new Int32Array(k);
    for (let i = 0; i < k; i++) {
      xy[i * 2] = ds.X[i * 2];
      xy[i * 2 + 1] = ds.X[i * 2 + 1];
      labels[i] = ds.y[i];
    }
    return { xy, labels };
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
    runAdjointCheck,
    handle,
    snapshot,
    prepareLoad,
    decisionField,
    sampleTrajectories,
    vectorField,
    dataPoints,
  };
}

// Trace a packed augmented buffer through the model's solver with a chosen number of viz
// frames, returning every snapshot.
function traceRaw(model: NeuralODE, z0: Float64Array, N: number, frames: number): Float64Array[] {
  return model.traceRaw(z0, N, frames);
}
