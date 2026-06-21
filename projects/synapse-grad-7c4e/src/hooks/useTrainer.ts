import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { MLP, mulberry32, type LayerSpec } from '../engine/nn';
import { Optimizer, defaultOptimizer, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { softmaxCrossEntropy, mse } from '../engine/losses';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import {
  makeClassDataset,
  makeRegressionDataset,
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
}

export interface TrainerMetrics {
  step: number;
  loss: number;
  acc: number; // classification accuracy, or R^2 for regression
  lossHistory: number[];
  accHistory: number[];
}

const MAX_HISTORY = 600;

// Everything the views need to render, bundled so a single `tick` bump re-renders them.
export interface TrainerHandle {
  model: MLP | null;
  classData: ClassDataset | null;
  regData: RegressionDataset | null;
  classes: number;
  mode: Mode;
}

export function useTrainer(cfg: TrainerConfig) {
  const modelRef = useRef<MLP | null>(null);
  const classDataRef = useRef<ClassDataset | null>(null);
  const regDataRef = useRef<RegressionDataset | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const sampleCursor = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<TrainerHandle>({
    model: null,
    classData: null,
    regData: null,
    classes: 1,
    mode: cfg.mode,
  });
  const [metrics, setMetrics] = useState<TrainerMetrics>({
    step: 0,
    loss: NaN,
    acc: NaN,
    lossHistory: [],
    accHistory: [],
  });

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
  });

  const buildAll = useCallback(() => {
    setRunning(false);
    const inputDim = cfg.mode === 'classification' ? 2 : 1;
    const outputDim = cfg.mode === 'classification' ? undefined : 1;
    const rng = mulberry32(cfg.seed);
    let classData: ClassDataset | null = null;
    let regData: RegressionDataset | null = null;
    let classes = 2;
    if (cfg.mode === 'classification') {
      classData = makeClassDataset(cfg.classKind, cfg.samples, cfg.noise, cfg.seed);
      classes = classData.classes;
    } else {
      regData = makeRegressionDataset(cfg.regKind, cfg.samples, cfg.noise, cfg.seed);
    }
    classDataRef.current = classData;
    regDataRef.current = regData;
    const out = outputDim ?? classes;
    const model = new MLP(inputDim, cfg.hidden, out, rng);
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;
    sampleCursor.current = 0;
    setHandle({ model, classData, regData, classes, mode: cfg.mode });
    setMetrics({ step: 0, loss: NaN, acc: NaN, lossHistory: [], accHistory: [] });
    setTick((t) => t + 1);
  }, [cfg.mode, cfg.classKind, cfg.regKind, cfg.samples, cfg.noise, cfg.seed, cfg.hidden, cfg.optimizer, cfg.lr, cfg.weightDecay]);

  // Rebuild on structural change (and on first mount).
  useEffect(() => {
    // Rebuilding the model + datasets is exactly the "synchronize React state with an
    // external system (the engine)" case effects are for; the cascading render is one
    // intentional reset, not a loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  // Live hyperparameters (lr / weight decay / batch / speed) update in place — no rebuild.
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
    if (!model || !opt) return NaN;
    let lossVal: number;

    if (cfg.mode === 'classification') {
      const ds = classDataRef.current!;
      const bs = Math.min(cfg.batchSize, ds.n);
      const Xb = new Float64Array(bs * 2);
      const yb = new Int32Array(bs);
      for (let i = 0; i < bs; i++) {
        const idx = sampleCursor.current % ds.n;
        sampleCursor.current = (sampleCursor.current + 1) % ds.n;
        Xb[i * 2] = ds.X[idx * 2];
        Xb[i * 2 + 1] = ds.X[idx * 2 + 1];
        yb[i] = ds.y[idx];
      }
      const xT = Tensor.fromFlat(Xb, bs, 2);
      const logits = model.forward(xT);
      const { loss } = softmaxCrossEntropy(logits, yb);
      opt.zeroGrad();
      loss.backward();
      opt.step();
      lossVal = loss.data[0];
    } else {
      const ds = regDataRef.current!;
      const bs = Math.min(cfg.batchSize, ds.n);
      const Xb = new Float64Array(bs);
      const Yb = new Float64Array(bs);
      for (let i = 0; i < bs; i++) {
        const idx = sampleCursor.current % ds.n;
        sampleCursor.current = (sampleCursor.current + 1) % ds.n;
        Xb[i] = ds.X[idx];
        Yb[i] = ds.y[idx];
      }
      const xT = Tensor.fromFlat(Xb, bs, 1);
      const yT = Tensor.fromFlat(Yb, bs, 1);
      const pred = model.forward(xT);
      const loss = mse(pred, yT);
      opt.zeroGrad();
      loss.backward();
      opt.step();
      lossVal = loss.data[0];
    }
    stepRef.current++;
    return lossVal;
  }, [cfg.mode, cfg.batchSize]);

  // Full-dataset metrics (loss over all points + accuracy or R^2).
  const evaluate = useCallback((): { loss: number; acc: number } => {
    const model = modelRef.current;
    if (!model) return { loss: NaN, acc: NaN };
    if (cfg.mode === 'classification') {
      const ds = classDataRef.current!;
      const xT = Tensor.fromFlat(ds.X.slice(), ds.n, 2);
      const logits = model.forward(xT);
      const { loss } = softmaxCrossEntropy(logits, ds.y);
      let correct = 0;
      for (let i = 0; i < ds.n; i++) {
        let best = 0;
        let bv = -Infinity;
        for (let c = 0; c < ds.classes; c++) {
          const v = logits.data[i * ds.classes + c];
          if (v > bv) {
            bv = v;
            best = c;
          }
        }
        if (best === ds.y[i]) correct++;
      }
      return { loss: loss.data[0], acc: correct / ds.n };
    } else {
      const ds = regDataRef.current!;
      const xT = Tensor.fromFlat(ds.X.slice(), ds.n, 1);
      const pred = model.forward(xT);
      let mean = 0;
      for (let i = 0; i < ds.n; i++) mean += ds.y[i];
      mean /= ds.n;
      let ssRes = 0;
      let ssTot = 0;
      for (let i = 0; i < ds.n; i++) {
        ssRes += (pred.data[i] - ds.y[i]) ** 2;
        ssTot += (ds.y[i] - mean) ** 2;
      }
      const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
      return { loss: ssRes / ds.n, acc: r2 };
    }
  }, [cfg.mode]);

  const pushMetrics = useCallback(() => {
    const { loss, acc } = evaluate();
    setMetrics((m) => {
      const lossHistory = m.lossHistory.length >= MAX_HISTORY ? m.lossHistory.slice(1) : m.lossHistory.slice();
      const accHistory = m.accHistory.length >= MAX_HISTORY ? m.accHistory.slice(1) : m.accHistory.slice();
      lossHistory.push(loss);
      accHistory.push(acc);
      return { step: stepRef.current, loss, acc, lossHistory, accHistory };
    });
  }, [evaluate]);

  // ---- animation loop --------------------------------------------------------------
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const frame = () => {
      if (!alive) return;
      for (let i = 0; i < cfg.stepsPerFrame; i++) trainStep();
      pushMetrics();
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
    trainStep();
    pushMetrics();
    setTick((t) => t + 1);
  }, [trainStep, pushMetrics]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    if (!model) return null;
    if (cfg.mode === 'classification') {
      const ds = classDataRef.current!;
      const xT = Tensor.fromFlat(ds.X.slice(0, Math.min(ds.n, 40) * 2), Math.min(ds.n, 40), 2);
      const yb = ds.y.slice(0, Math.min(ds.n, 40));
      return gradCheck(model.parameters(), () => softmaxCrossEntropy(model.forward(xT), yb).loss, {
        samplesPerParam: 10,
      });
    } else {
      const ds = regDataRef.current!;
      const k = Math.min(ds.n, 40);
      const xT = Tensor.fromFlat(ds.X.slice(0, k), k, 1);
      const yT = Tensor.fromFlat(ds.y.slice(0, k), k, 1);
      return gradCheck(model.parameters(), () => mse(model.forward(xT), yT), { samplesPerParam: 10 });
    }
  }, [cfg.mode]);

  return { running, tick, metrics, start, pause, reset, stepOnce, runGradCheck, handle };
}
