import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { ViT, VIT_ARCH_PRESETS, attentionRollout, clsAttentionAt, type ViTAttn, type RolloutView } from '../engine/vit';
import { mulberry32 } from '../engine/nn';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { softmaxCrossEntropy } from '../engine/losses';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { makeImageDataset, datasetMeta, type ImageDataset, type VisionDatasetKind } from '../engine/images';
import type { TrainerMetrics } from './useTrainer';

export interface ViTConfigUI {
  dataset: VisionDatasetKind;
  imgSize: number;
  samples: number;
  noise: number;
  jitter: number;
  seed: number;
  archId: string;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  valFraction: number;
  scheduleKind: ScheduleKind;
  schedulePeriod: number;
  scheduleWarmup: number;
  clipNorm: number;
  loadId: number;
}

export interface ViTHandle {
  model: ViT | null;
  data: ImageDataset | null;
  classes: number;
  labels: string[];
  imgSize: number;
  gridSide: number;
  patch: number;
}

export interface ViTPrediction {
  probs: Float64Array;
  pred: number;
}

// Everything the attention views need for one image: the class prediction, the folded rollout
// (with per-depth truncations), the raw per-layer [CLS] attention, and the patch pixels so the
// grid can be drawn.
export interface AttnAnalysis {
  pred: ViTPrediction;
  rollout: RolloutView;
  perLayerCls: Float64Array[]; // raw (un-rolled) mean [CLS]→patch attention, one per layer
  attn: ViTAttn;
}

const MAX_HISTORY = 600;
const EVAL_CAP = 140;

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

export function vitArch(id: string) {
  return VIT_ARCH_PRESETS.find((p) => p.id === id) ?? VIT_ARCH_PRESETS[1];
}

function scheduleOf(cfg: ViTConfigUI): ScheduleConfig {
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

function softmaxOf(logits: Float64Array, C: number): ViTPrediction {
  const probs = new Float64Array(C);
  let max = -Infinity;
  for (let c = 0; c < C; c++) max = Math.max(max, logits[c]);
  let sum = 0;
  for (let c = 0; c < C; c++) {
    probs[c] = Math.exp(logits[c] - max);
    sum += probs[c];
  }
  let pred = 0;
  let bv = -Infinity;
  for (let c = 0; c < C; c++) {
    probs[c] /= sum;
    if (probs[c] > bv) {
      bv = probs[c];
      pred = c;
    }
  }
  return { probs, pred };
}

export function useViTTrainer(cfg: ViTConfigUI) {
  const modelRef = useRef<ViT | null>(null);
  const dataRef = useRef<ImageDataset | null>(null);
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
  const [handle, setHandle] = useState<ViTHandle>({ model: null, data: null, classes: 1, labels: [], imgSize: cfg.imgSize, gridSide: 4, patch: 4 });
  const [metrics, setMetrics] = useState<TrainerMetrics>(EMPTY_METRICS);
  const [confusion, setConfusion] = useState<number[][] | null>(null);

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    imgSize: cfg.imgSize,
    samples: cfg.samples,
    noise: cfg.noise,
    jitter: cfg.jitter,
    seed: cfg.seed,
    archId: cfg.archId,
    optimizer: cfg.optimizer,
    valFraction: cfg.valFraction,
    loadId: cfg.loadId,
  });

  const batchTensor = useCallback((idx: Int32Array, start: number, count: number): { x: Tensor; y: Int32Array } => {
    const ds = dataRef.current!;
    const px = ds.size * ds.size;
    const Xb = new Float64Array(count * px);
    const yb = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const di = idx[start + i];
      Xb.set(ds.X.subarray(di * px, di * px + px), i * px);
      yb[i] = ds.y[di];
    }
    return { x: Tensor.fromFlat(Xb, count, px), y: yb };
  }, []);

  const evalOn = useCallback(
    (idx: Int32Array, confOut?: number[][]): { loss: number; acc: number } => {
      const model = modelRef.current;
      const ds = dataRef.current;
      if (!model || !ds || idx.length === 0) return { loss: NaN, acc: NaN };
      model.eval();
      const k = Math.min(idx.length, EVAL_CAP);
      const { x, y } = batchTensor(idx, 0, k);
      const logits = model.forwardBatch(x, k);
      const { loss } = softmaxCrossEntropy(logits, y);
      const C = ds.classes;
      let correct = 0;
      for (let i = 0; i < k; i++) {
        let best = 0;
        let bv = -Infinity;
        for (let c = 0; c < C; c++) {
          const v = logits.data[i * C + c];
          if (v > bv) {
            bv = v;
            best = c;
          }
        }
        if (best === y[i]) correct++;
        if (confOut) confOut[y[i]][best]++;
      }
      return { loss: loss.data[0], acc: correct / k };
    },
    [batchTensor],
  );

  const recomputeConfusion = useCallback(() => {
    const ds = dataRef.current;
    if (!ds) return;
    const C = ds.classes;
    const conf: number[][] = Array.from({ length: C }, () => new Array(C).fill(0));
    const set = valIdxRef.current.length ? valIdxRef.current : trainIdxRef.current;
    evalOn(set, conf);
    setConfusion(conf);
  }, [evalOn]);

  const seedMetrics = useCallback(() => {
    const tr = evalOn(trainIdxRef.current);
    const va = valIdxRef.current.length ? evalOn(valIdxRef.current) : { loss: NaN, acc: NaN };
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
    recomputeConfusion();
  }, [evalOn, cfg.lr, recomputeConfusion]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const meta = datasetMeta(cfg.dataset);
    const ds = makeImageDataset(cfg.dataset, cfg.samples, cfg.noise, cfg.jitter, cfg.imgSize, cfg.seed);
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

    const a = vitArch(cfg.archId);
    const model = new ViT({
      imgSize: cfg.imgSize,
      patch: a.patch,
      dModel: a.dModel,
      nHeads: a.nHeads,
      nLayers: a.nLayers,
      dFF: a.dFF,
      numClasses: meta.classes,
      seed: cfg.seed,
    });
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    stepRef.current = 0;

    if (pendingWeights.current) {
      const ok = model.importWeights(pendingWeights.current);
      if (ok) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, data: ds, classes: meta.classes, labels: ds.labels, imgSize: cfg.imgSize, gridSide: model.gridSide, patch: a.patch });
    seedMetrics();
    setTick((t) => t + 1);
  }, [cfg.dataset, cfg.imgSize, cfg.samples, cfg.noise, cfg.jitter, cfg.seed, cfg.archId, cfg.optimizer, cfg.lr, cfg.weightDecay, cfg.valFraction, seedMetrics]);

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
    const ds = dataRef.current;
    if (!model || !opt || !ds) return;
    model.train();
    const order = orderRef.current;
    const bs = Math.min(cfg.batchSize, order.length);
    if (cursor.current + bs > order.length) {
      shuffleInPlace(order, shuffleRng.current);
      cursor.current = 0;
    }
    const { x, y } = batchTensor(order, cursor.current, bs);
    cursor.current += bs;
    const logits = model.forwardBatch(x, bs);
    const { loss } = softmaxCrossEntropy(logits, y);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.cfg.lr = lrAt(scheduleOf(cfg), stepRef.current);
    opt.step();
    model.eval();
    stepRef.current++;
    return { gradNorm, lr: opt.cfg.lr };
  }, [cfg, batchTensor]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; lr: number } | undefined) => {
      const tr = evalOn(trainIdxRef.current);
      const va = valIdxRef.current.length ? evalOn(valIdxRef.current) : { loss: NaN, acc: NaN };
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

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: { gradNorm: number; lr: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      pushMetrics(last);
      frames++;
      if (frames % 8 === 0) recomputeConfusion();
      setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, cfg.stepsPerFrame, trainStep, pushMetrics, recomputeConfusion]);

  const start = useCallback(() => setRunning(true), []);
  const pause = useCallback(() => {
    setRunning(false);
    recomputeConfusion();
  }, [recomputeConfusion]);
  const reset = useCallback(() => {
    setRunning(false);
    buildAll();
  }, [buildAll]);
  const stepOnce = useCallback(() => {
    const last = trainStep();
    pushMetrics(last);
    recomputeConfusion();
    setTick((t) => t + 1);
  }, [trainStep, pushMetrics, recomputeConfusion]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    model.eval();
    const src = trainIdxRef.current.length ? trainIdxRef.current : Int32Array.from({ length: ds.n }, (_, i) => i);
    const k = Math.min(6, src.length);
    const { x, y } = batchTensor(src, 0, k);
    return gradCheck(model.parameters(), () => softmaxCrossEntropy(model.forwardBatch(x, k), y).loss, { samplesPerParam: 3, eps: 1e-4 });
  }, [batchTensor]);

  const predictImage = useCallback((pixels: Float64Array): ViTPrediction | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    model.eval();
    const logits = model.forwardOne(pixels);
    return softmaxOf(logits.data, ds.classes);
  }, []);

  // Full attention analysis for one raw image buffer (already in the model's value range).
  const analyze = useCallback((pixels: Float64Array): AttnAnalysis | null => {
    const model = modelRef.current;
    const ds = dataRef.current;
    if (!model || !ds) return null;
    model.eval();
    const logits = model.forwardOne(pixels, true);
    const pred = softmaxOf(logits.data, ds.classes);
    const attn = model.lastAttn!;
    const rollout = attentionRollout(attn);
    const perLayerCls: Float64Array[] = [];
    for (let l = 0; l < attn.nLayers; l++) perLayerCls.push(clsAttentionAt(attn, l));
    return { pred, rollout, perLayerCls, attn };
  }, []);

  const analyzeSample = useCallback(
    (sampleIdx: number): AttnAnalysis | null => {
      const ds = dataRef.current;
      if (!ds) return null;
      const px = ds.size * ds.size;
      return analyze(ds.X.slice(sampleIdx * px, sampleIdx * px + px));
    },
    [analyze],
  );

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
    confusion,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    handle,
    snapshot,
    prepareLoad,
    predictImage,
    analyze,
    analyzeSample,
  };
}
