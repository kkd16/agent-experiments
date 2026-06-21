import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { MLP, mulberry32, type LayerSpec } from '../engine/nn';
import {
  Optimizer,
  defaultOptimizer,
  clipGradGlobalNorm,
  type OptimizerConfig,
  type OptimizerKind,
} from '../engine/optim';
import { softmaxCrossEntropy, regressionLoss, type RegLoss } from '../engine/losses';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import {
  makeClassDataset,
  makeRegressionDataset,
  splitIndices,
  type ClassDataset,
  type ClassDatasetKind,
  type RegressionDataset,
  type RegressionKind,
} from '../engine/data';

export type Mode = 'classification' | 'regression';

export interface TrainerConfig {
  mode: Mode;
  classKind: ClassDatasetKind;
  regKind: RegressionKind;
  samples: number;
  noise: number;
  seed: number;
  hidden: LayerSpec[];
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  // session 2 additions
  regLoss: RegLoss;
  valFraction: number;
  scheduleKind: ScheduleKind;
  schedulePeriod: number;
  scheduleWarmup: number;
  clipNorm: number;
  loadId: number; // bumped to force a rebuild when restoring saved weights
}

export interface TrainerMetrics {
  step: number;
  loss: number;
  acc: number; // train accuracy, or R^2 for regression
  valLoss: number;
  valAcc: number;
  gradNorm: number;
  lr: number;
  lossHistory: number[];
  accHistory: number[];
  valLossHistory: number[];
  valAccHistory: number[];
  gradNormHistory: number[];
}

const MAX_HISTORY = 600;

const EMPTY_METRICS: TrainerMetrics = {
  step: 0,
  loss: NaN,
  acc: NaN,
  valLoss: NaN,
  valAcc: NaN,
  gradNorm: NaN,
  lr: NaN,
  lossHistory: [],
  accHistory: [],
  valLossHistory: [],
  valAccHistory: [],
  gradNormHistory: [],
};

// Everything the views need to render, bundled so a single `tick` bump re-renders them.
export interface TrainerHandle {
  model: MLP | null;
  classData: ClassDataset | null;
  regData: RegressionDataset | null;
  classes: number;
  mode: Mode;
}

function scheduleOf(cfg: TrainerConfig): ScheduleConfig {
  return {
    kind: cfg.scheduleKind,
    baseLr: cfg.lr,
    period: cfg.schedulePeriod,
    warmup: cfg.scheduleWarmup,
    gamma: 0.5,
    minFrac: 0.05,
  };
}

export function useTrainer(cfg: TrainerConfig) {
  const modelRef = useRef<MLP | null>(null);
  const classDataRef = useRef<ClassDataset | null>(null);
  const regDataRef = useRef<RegressionDataset | null>(null);
  const splitRef = useRef<{ train: Int32Array; val: Int32Array }>({ train: new Int32Array(), val: new Int32Array() });
  const trainOrderRef = useRef<Int32Array>(new Int32Array());
  const optRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const cursor = useRef(0);
  const shuffleRng = useRef<() => number>(() => 0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef<number>(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<TrainerHandle>({
    model: null,
    classData: null,
    regData: null,
    classes: 1,
    mode: cfg.mode,
  });
  const [metrics, setMetrics] = useState<TrainerMetrics>(EMPTY_METRICS);

  // Structural signature: when any of these change we rebuild the net + data from scratch.
  const structKey = JSON.stringify({
    mode: cfg.mode,
    classKind: cfg.classKind,
    regKind: cfg.regKind,
    samples: cfg.samples,
    noise: cfg.noise,
    seed: cfg.seed,
    hidden: cfg.hidden,
    optimizer: cfg.optimizer,
    valFraction: cfg.valFraction,
    loadId: cfg.loadId,
  });

  const reshuffle = useCallback(() => {
    const order = splitRef.current.train.slice();
    const rng = shuffleRng.current;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    trainOrderRef.current = order;
    cursor.current = 0;
  }, []);

  // ---- evaluation over an index subset ---------------------------------------------
  const evalOn = useCallback(
    (idx: Int32Array): { loss: number; acc: number } => {
      const model = modelRef.current;
      if (!model || idx.length === 0) return { loss: NaN, acc: NaN };
      model.eval();
      if (cfg.mode === 'classification') {
        const ds = classDataRef.current!;
        const k = idx.length;
        const Xb = new Float64Array(k * 2);
        const yb = new Int32Array(k);
        for (let i = 0; i < k; i++) {
          Xb[i * 2] = ds.X[idx[i] * 2];
          Xb[i * 2 + 1] = ds.X[idx[i] * 2 + 1];
          yb[i] = ds.y[idx[i]];
        }
        const logits = model.forward(Tensor.fromFlat(Xb, k, 2));
        const { loss } = softmaxCrossEntropy(logits, yb);
        let correct = 0;
        for (let i = 0; i < k; i++) {
          let best = 0;
          let bv = -Infinity;
          for (let c = 0; c < ds.classes; c++) {
            const v = logits.data[i * ds.classes + c];
            if (v > bv) {
              bv = v;
              best = c;
            }
          }
          if (best === yb[i]) correct++;
        }
        return { loss: loss.data[0], acc: correct / k };
      } else {
        const ds = regDataRef.current!;
        const k = idx.length;
        const Xb = new Float64Array(k);
        const Yb = new Float64Array(k);
        for (let i = 0; i < k; i++) {
          Xb[i] = ds.X[idx[i]];
          Yb[i] = ds.y[idx[i]];
        }
        const pred = model.forward(Tensor.fromFlat(Xb, k, 1));
        let mean = 0;
        for (let i = 0; i < k; i++) mean += Yb[i];
        mean /= k;
        let ssRes = 0;
        let ssTot = 0;
        for (let i = 0; i < k; i++) {
          ssRes += (pred.data[i] - Yb[i]) ** 2;
          ssTot += (Yb[i] - mean) ** 2;
        }
        const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
        return { loss: ssRes / k, acc: r2 };
      }
    },
    [cfg.mode],
  );

  const seedMetrics = useCallback(() => {
    const tr = evalOn(splitRef.current.train);
    const va = splitRef.current.val.length ? evalOn(splitRef.current.val) : { loss: NaN, acc: NaN };
    setMetrics({
      ...EMPTY_METRICS,
      step: stepRef.current,
      loss: tr.loss,
      acc: tr.acc,
      valLoss: va.loss,
      valAcc: va.acc,
      lr: cfg.lr,
      lossHistory: [tr.loss],
      accHistory: [tr.acc],
      valLossHistory: [va.loss],
      valAccHistory: [va.acc],
      gradNormHistory: [],
    });
  }, [evalOn, cfg.lr]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const inputDim = cfg.mode === 'classification' ? 2 : 1;
    const rng = mulberry32(cfg.seed);
    let classData: ClassDataset | null = null;
    let regData: RegressionDataset | null = null;
    let classes = 2;
    let n: number;
    if (cfg.mode === 'classification') {
      classData = makeClassDataset(cfg.classKind, cfg.samples, cfg.noise, cfg.seed);
      classes = classData.classes;
      n = classData.n;
    } else {
      regData = makeRegressionDataset(cfg.regKind, cfg.samples, cfg.noise, cfg.seed);
      n = regData.n;
    }
    classDataRef.current = classData;
    regDataRef.current = regData;
    splitRef.current = splitIndices(n, cfg.valFraction, cfg.seed);
    shuffleRng.current = mulberry32(cfg.seed ^ 0x1234);
    reshuffle();

    const out = cfg.mode === 'classification' ? classes : 1;
    const model = new MLP(inputDim, cfg.hidden, out, rng);
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    // Restore weights if a load is pending and the shapes line up.
    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, classData, regData, classes, mode: cfg.mode });
    seedMetrics();
    setTick((t) => t + 1);
  }, [
    cfg.mode,
    cfg.classKind,
    cfg.regKind,
    cfg.samples,
    cfg.noise,
    cfg.seed,
    cfg.hidden,
    cfg.optimizer,
    cfg.lr,
    cfg.weightDecay,
    cfg.valFraction,
    reshuffle,
    seedMetrics,
  ]);

  // Rebuild on structural change (and on first mount).
  useEffect(() => {
    // Rebuilding the model + datasets is exactly the "synchronize React state with an
    // external system (the engine)" case effects are for; the cascading render is one
    // intentional reset, not a loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  // Live hyperparameters (lr / weight decay) update in place — no rebuild.
  useEffect(() => {
    if (optRef.current) {
      optRef.current.cfg.lr = cfg.lr;
      optRef.current.cfg.weightDecay = cfg.weightDecay;
    }
  }, [cfg.lr, cfg.weightDecay]);

  // ---- one optimization step (a minibatch) -----------------------------------------
  const trainStep = useCallback(() => {
    const model = modelRef.current;
    const opt = optRef.current;
    if (!model || !opt) return;
    model.train();
    const order = trainOrderRef.current;
    const bs = Math.min(cfg.batchSize, order.length);
    const sched = scheduleOf(cfg);

    if (cfg.mode === 'classification') {
      const ds = classDataRef.current!;
      const Xb = new Float64Array(bs * 2);
      const yb = new Int32Array(bs);
      for (let i = 0; i < bs; i++) {
        if (cursor.current >= order.length) reshuffle();
        const idx = order[cursor.current++];
        Xb[i * 2] = ds.X[idx * 2];
        Xb[i * 2 + 1] = ds.X[idx * 2 + 1];
        yb[i] = ds.y[idx];
      }
      const logits = model.forward(Tensor.fromFlat(Xb, bs, 2));
      const { loss } = softmaxCrossEntropy(logits, yb);
      opt.zeroGrad();
      loss.backward();
    } else {
      const ds = regDataRef.current!;
      const Xb = new Float64Array(bs);
      const Yb = new Float64Array(bs);
      for (let i = 0; i < bs; i++) {
        if (cursor.current >= order.length) reshuffle();
        const idx = order[cursor.current++];
        Xb[i] = ds.X[idx];
        Yb[i] = ds.y[idx];
      }
      const pred = model.forward(Tensor.fromFlat(Xb, bs, 1));
      const loss = regressionLoss(cfg.regLoss, pred, Tensor.fromFlat(Yb, bs, 1));
      opt.zeroGrad();
      loss.backward();
    }
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.cfg.lr = lrAt(sched, stepRef.current);
    opt.step();
    model.eval();
    stepRef.current++;
    return { gradNorm, lr: opt.cfg.lr };
  }, [cfg, reshuffle]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; lr: number } | undefined) => {
      const tr = evalOn(splitRef.current.train);
      const va = splitRef.current.val.length ? evalOn(splitRef.current.val) : { loss: NaN, acc: NaN };
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const accHistory = cap(m.accHistory);
        const valLossHistory = cap(m.valLossHistory);
        const valAccHistory = cap(m.valAccHistory);
        const gradNormHistory = cap(m.gradNormHistory);
        lossHistory.push(tr.loss);
        accHistory.push(tr.acc);
        valLossHistory.push(va.loss);
        valAccHistory.push(va.acc);
        if (last) gradNormHistory.push(last.gradNorm);
        return {
          step: stepRef.current,
          loss: tr.loss,
          acc: tr.acc,
          valLoss: va.loss,
          valAcc: va.acc,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          lr: last ? last.lr : m.lr,
          lossHistory,
          accHistory,
          valLossHistory,
          valAccHistory,
          gradNormHistory,
        };
      });
    },
    [evalOn],
  );

  // ---- animation loop --------------------------------------------------------------
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const frame = () => {
      if (!alive) return;
      let last: { gradNorm: number; lr: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      pushMetrics(last);
      setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, cfg.stepsPerFrame, trainStep, pushMetrics]);

  const start = useCallback(() => setRunning(true), []);
  const pause = useCallback(() => setRunning(false), []);
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
    if (!model) return null;
    model.eval();
    if (cfg.mode === 'classification') {
      const ds = classDataRef.current!;
      const k = Math.min(ds.n, 40);
      const xT = Tensor.fromFlat(ds.X.slice(0, k * 2), k, 2);
      const yb = ds.y.slice(0, k);
      return gradCheck(model.parameters(), () => softmaxCrossEntropy(model.forward(xT), yb).loss, {
        samplesPerParam: 10,
      });
    } else {
      const ds = regDataRef.current!;
      const k = Math.min(ds.n, 40);
      const xT = Tensor.fromFlat(ds.X.slice(0, k), k, 1);
      const yT = Tensor.fromFlat(ds.y.slice(0, k), k, 1);
      return gradCheck(model.parameters(), () => regressionLoss(cfg.regLoss, model.forward(xT), yT), {
        samplesPerParam: 10,
      });
    }
  }, [cfg.mode, cfg.regLoss]);

  // Current trainable weights + step, for save/share.
  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const model = modelRef.current;
    return { weights: model ? model.exportWeights() : [], step: stepRef.current };
  }, []);

  // Stage weights to be restored on the next rebuild (the caller bumps cfg.loadId).
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
  };
}
