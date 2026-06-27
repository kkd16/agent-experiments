import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { mulberry32 } from '../engine/nn';
import { datasetMeta, type VisionDatasetKind } from '../engine/images';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { lrAt, type ScheduleKind, type ScheduleConfig } from '../engine/schedule';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { pca2d } from '../lib/pca';
import {
  Encoder,
  ENCODER_PRESETS,
  makeContrastiveData,
  augment,
  ntXentLoss,
  diagonalMask,
  contrastiveAccuracy,
  alignUniform,
  cosineSimMatrix,
  linearProbe,
  knnAccuracy,
  type AugConfig,
  type ContrastiveData,
} from '../engine/contrastive';

export interface ContrastiveConfig {
  dataset: VisionDatasetKind;
  imgSize: number;
  samples: number;
  seed: number;
  presetId: string;
  temperature: number;
  batchPairs: number; // N: each step builds 2N augmented views
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  stepsPerFrame: number;
  clipNorm: number;
  scheduleKind: ScheduleKind;
  schedulePeriod: number;
  scheduleWarmup: number;
  // augmentation
  augStrength: number; // scales rotation/scale/shift/noise/intensity
  cutout: number; // random-erasing probability
  loadId: number;
}

export interface ContrastiveMetrics {
  step: number;
  loss: number;
  gradNorm: number;
  lr: number;
  contrastiveAcc: number;
  probeAcc: number;
  knnAcc: number;
  pixelProbeAcc: number;
  alignment: number;
  uniformity: number;
  lossHistory: number[];
  probeHistory: number[];
  knnHistory: number[];
  alignHistory: number[];
  uniformHistory: number[];
}

export interface ScatterView {
  points: { x: number; y: number }[];
  labels: number[];
}
export interface SimView {
  mat: Float64Array;
  posIdx: Int32Array;
  m: number;
  labels: number[];
}
export interface AugView {
  anchor: Float64Array;
  views: Float64Array[];
  label: number;
}
export interface ContrastiveViews {
  scatter: ScatterView | null;
  sim: SimView | null;
  aug: AugView | null;
}

export interface ContrastiveHandle {
  encoder: Encoder | null;
  data: ContrastiveData | null;
  classes: number;
  labels: string[];
  imgSize: number;
  repDim: number;
  projDim: number;
}

const MAX_HISTORY = 600;
const EVAL_CAP = 200; // images encoded for the probe / kNN / scatter
const SIM_PAIRS = 8; // pairs shown in the similarity matrix (→ 2·8 = 16 rows)
const AUG_PREVIEW = 6; // augmented views drawn next to the anchor
const EVAL_EVERY = 8; // recompute the heavy probes every N animation frames

const EMPTY_METRICS: ContrastiveMetrics = {
  step: 0,
  loss: NaN,
  gradNorm: NaN,
  lr: NaN,
  contrastiveAcc: NaN,
  probeAcc: NaN,
  knnAcc: NaN,
  pixelProbeAcc: NaN,
  alignment: NaN,
  uniformity: NaN,
  lossHistory: [],
  probeHistory: [],
  knnHistory: [],
  alignHistory: [],
  uniformHistory: [],
};

function presetOf(id: string) {
  return ENCODER_PRESETS.find((p) => p.id === id) ?? ENCODER_PRESETS[1];
}

// Map the single "augment strength" slider to a full augmentation recipe.
function augConfig(cfg: ContrastiveConfig): AugConfig {
  const s = cfg.augStrength;
  return {
    rot: 0.5 * s,
    scale: 0.28 * s,
    shift: 0.13 * s,
    noise: 0.08 * s,
    intensity: 0.32 * s,
    cutout: cfg.cutout,
  };
}

function scheduleOf(cfg: ContrastiveConfig): ScheduleConfig {
  return { kind: cfg.scheduleKind, baseLr: cfg.lr, period: cfg.schedulePeriod, warmup: cfg.scheduleWarmup, gamma: 0.5, minFrac: 0.05 };
}

export function useContrastiveTrainer(cfg: ContrastiveConfig) {
  const encRef = useRef<Encoder | null>(null);
  const dataRef = useRef<ContrastiveData | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const maskRef = useRef<Tensor | null>(null);
  const evalIdxRef = useRef<Int32Array>(new Int32Array());
  const pixelBaselineRef = useRef<number>(NaN);
  const augRng = useRef<() => number>(() => Math.random());
  const batchRng = useRef<() => number>(() => Math.random());
  const rafRef = useRef<number | null>(null);
  const stepRef = useRef(0);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<ContrastiveHandle>({
    encoder: null,
    data: null,
    classes: 1,
    labels: [],
    imgSize: cfg.imgSize,
    repDim: 64,
    projDim: 32,
  });
  const [metrics, setMetrics] = useState<ContrastiveMetrics>(EMPTY_METRICS);
  const [views, setViews] = useState<ContrastiveViews>({ scatter: null, sim: null, aug: null });

  const px = cfg.imgSize * cfg.imgSize;
  const numClasses = datasetMeta(cfg.dataset).classes;

  const structKey = JSON.stringify({
    dataset: cfg.dataset,
    imgSize: cfg.imgSize,
    samples: cfg.samples,
    seed: cfg.seed,
    presetId: cfg.presetId,
    batchPairs: cfg.batchPairs,
    optimizer: cfg.optimizer,
    loadId: cfg.loadId,
  });

  // Encode a set of base-image indices into representation vectors (forward only, no graph kept).
  const encodeFeatures = useCallback(
    (idx: Int32Array): { feats: Float64Array; labels: Int32Array; repDim: number } => {
      const enc = encRef.current!;
      const data = dataRef.current!;
      const k = idx.length;
      const X = new Float64Array(k * px);
      const y = new Int32Array(k);
      for (let i = 0; i < k; i++) {
        X.set(data.X.subarray(idx[i] * px, idx[i] * px + px), i * px);
        y[i] = data.y[idx[i]];
      }
      const h = enc.represent(Tensor.fromFlat(X, k, px, false));
      return { feats: h.data.slice(), labels: y, repDim: h.cols };
    },
    [px],
  );

  // Build the two-view contrastive batch (interleaved positives) for a set of base indices.
  const buildViewBatch = useCallback(
    (baseIdx: Int32Array, rng: () => number): { X: Tensor; posIdx: Int32Array; labels: number[] } => {
      const data = dataRef.current!;
      const acfg = augConfig(cfg);
      const N = baseIdx.length;
      const m = 2 * N;
      const batch = new Float64Array(m * px);
      const posIdx = new Int32Array(m);
      const labels: number[] = [];
      for (let i = 0; i < N; i++) {
        const src = data.X.subarray(baseIdx[i] * px, baseIdx[i] * px + px);
        const va = augment(src, cfg.imgSize, rng, acfg);
        const vb = augment(src, cfg.imgSize, rng, acfg);
        batch.set(va, 2 * i * px);
        batch.set(vb, (2 * i + 1) * px);
        posIdx[2 * i] = 2 * i + 1;
        posIdx[2 * i + 1] = 2 * i;
        labels.push(data.y[baseIdx[i]], data.y[baseIdx[i]]);
      }
      return { X: Tensor.fromFlat(batch, m, px, false), posIdx, labels };
    },
    [cfg, px],
  );

  // The heavy evaluation: encode the eval subset, fit a fresh linear probe + kNN, PCA the
  // representations, and rebuild the similarity-matrix and augmentation previews.
  const evaluate = useCallback(
    (fresh: boolean) => {
      const enc = encRef.current;
      const data = dataRef.current;
      if (!enc || !data) return;
      const idx = evalIdxRef.current;
      const { feats, labels, repDim } = encodeFeatures(idx);
      const k = idx.length;
      const probeRng = mulberry32(0x9e37 ^ cfg.seed);
      const probe = linearProbe(feats, labels, k, repDim, numClasses, probeRng);
      const knn = knnAccuracy(feats, labels, k, repDim, numClasses, 5);

      // PCA of the representation to a plane (subsample so the scatter stays readable)
      const cap = Math.min(k, 160);
      const rows: Float64Array[] = [];
      const lab: number[] = [];
      for (let i = 0; i < cap; i++) {
        rows.push(feats.subarray(i * repDim, i * repDim + repDim) as Float64Array);
        lab.push(labels[i]);
      }
      const pca = pca2d(rows, repDim, cfg.seed ^ 0x55);
      const scatter: ScatterView = { points: pca.points, labels: lab };

      // Similarity matrix + alignment/uniformity from a fresh small two-view batch
      const simRng = fresh ? augRng.current : mulberry32((cfg.seed ^ 0x5117) >>> 0);
      const simBaseN = Math.min(SIM_PAIRS, data.n);
      const simBase = new Int32Array(simBaseN);
      for (let i = 0; i < simBaseN; i++) simBase[i] = idx[i % idx.length];
      const sb = buildViewBatch(simBase, simRng);
      const zsim = enc.project(sb.X).data.slice();
      const m = 2 * simBaseN;
      const projDim = enc.cfg.projDim;
      const simMat = cosineSimMatrix(zsim, m, projDim);
      const au = alignUniform(zsim, m, projDim);
      const sim: SimView = { mat: simMat, posIdx: sb.posIdx, m, labels: sb.labels };

      // Augmentation preview: an anchor base image and a strip of its augmentations
      const augRngLocal = fresh ? augRng.current : mulberry32((cfg.seed ^ 0xa116) >>> 0);
      const anchorIdx = idx[Math.floor(augRngLocal() * idx.length)];
      const anchor = data.X.slice(anchorIdx * px, anchorIdx * px + px);
      const acfg = augConfig(cfg);
      const augViews: Float64Array[] = [];
      for (let i = 0; i < AUG_PREVIEW; i++) augViews.push(augment(anchor, cfg.imgSize, augRngLocal, acfg));
      const aug: AugView = { anchor, views: augViews, label: data.y[anchorIdx] };

      setViews({ scatter, sim, aug });
      setMetrics((prev) => {
        const cap2 = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const probeHistory = cap2(prev.probeHistory);
        const knnHistory = cap2(prev.knnHistory);
        const alignHistory = cap2(prev.alignHistory);
        const uniformHistory = cap2(prev.uniformHistory);
        probeHistory.push(probe.testAcc);
        knnHistory.push(knn);
        alignHistory.push(au.alignment);
        uniformHistory.push(au.uniformity);
        return {
          ...prev,
          probeAcc: probe.testAcc,
          knnAcc: knn,
          pixelProbeAcc: pixelBaselineRef.current,
          alignment: au.alignment,
          uniformity: au.uniformity,
          probeHistory,
          knnHistory,
          alignHistory,
          uniformHistory,
        };
      });
    },
    [cfg, encodeFeatures, buildViewBatch, numClasses, px],
  );

  const buildAll = useCallback(() => {
    setRunning(false);
    const data = makeContrastiveData(cfg.dataset, cfg.samples, cfg.imgSize, cfg.seed);
    dataRef.current = data;
    const p = presetOf(cfg.presetId);
    const enc = new Encoder({ size: cfg.imgSize, ch1: p.ch1, ch2: p.ch2, repDim: p.repDim, projDim: p.projDim }, mulberry32(cfg.seed));
    encRef.current = enc;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(enc.parameters(), ocfg);
    maskRef.current = diagonalMask(2 * cfg.batchPairs);
    stepRef.current = 0;

    // Fixed eval subset (balanced-ish: just a shuffled prefix of all bases)
    const all = new Int32Array(data.n);
    for (let i = 0; i < data.n; i++) all[i] = i;
    const sr = mulberry32(cfg.seed ^ 0x1234);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(sr() * (i + 1));
      const t = all[i];
      all[i] = all[j];
      all[j] = t;
    }
    evalIdxRef.current = all.slice(0, Math.min(EVAL_CAP, data.n));

    // Raw-pixel linear-probe baseline (the bar the learned representation must beat)
    {
      const idx = evalIdxRef.current;
      const k = idx.length;
      const Xpx = new Float64Array(k * px);
      const y = new Int32Array(k);
      for (let i = 0; i < k; i++) {
        Xpx.set(data.X.subarray(idx[i] * px, idx[i] * px + px), i * px);
        y[i] = data.y[idx[i]];
      }
      pixelBaselineRef.current = linearProbe(Xpx, y, k, px, data.classes, mulberry32(0xbee), 120).testAcc;
    }

    augRng.current = mulberry32(cfg.seed ^ 0x7a1e);
    batchRng.current = mulberry32(cfg.seed ^ 0xb1a5);

    if (pendingWeights.current) {
      if (enc.importWeights(pendingWeights.current)) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({
      encoder: enc,
      data,
      classes: data.classes,
      labels: data.labels,
      imgSize: cfg.imgSize,
      repDim: p.repDim,
      projDim: p.projDim,
    });
    setMetrics({ ...EMPTY_METRICS, step: stepRef.current, lr: cfg.lr });
    evaluate(false);
    setTick((t) => t + 1);
  }, [
    cfg.dataset,
    cfg.samples,
    cfg.imgSize,
    cfg.seed,
    cfg.presetId,
    cfg.batchPairs,
    cfg.optimizer,
    cfg.lr,
    cfg.weightDecay,
    px,
    evaluate,
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

  // Rebuild the mask if the batch size changes without a full rebuild (it is in structKey, so this
  // mostly guards the very first frame).
  const trainStep = useCallback(() => {
    const enc = encRef.current;
    const opt = optRef.current;
    const data = dataRef.current;
    if (!enc || !opt || !data) return;
    const N = cfg.batchPairs;
    if (!maskRef.current || maskRef.current.rows !== 2 * N) maskRef.current = diagonalMask(2 * N);
    const baseIdx = new Int32Array(N);
    for (let i = 0; i < N; i++) baseIdx[i] = Math.floor(batchRng.current() * data.n);
    const { X, posIdx } = buildViewBatch(baseIdx, augRng.current);
    const z = enc.project(X);
    const loss = ntXentLoss(z, posIdx, maskRef.current, cfg.temperature);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(enc.parameters(), cfg.clipNorm);
    opt.cfg.lr = lrAt(scheduleOf(cfg), stepRef.current);
    opt.step();
    stepRef.current++;
    const cAcc = contrastiveAccuracy(z.data, posIdx, 2 * N, enc.cfg.projDim);
    return { gradNorm, lr: opt.cfg.lr, loss: loss.data[0], contrastiveAcc: cAcc };
  }, [cfg, buildViewBatch]);

  const pushMetrics = useCallback((last: { gradNorm: number; lr: number; loss: number; contrastiveAcc: number } | undefined) => {
    setMetrics((m) => {
      const lossHistory = m.lossHistory.length >= MAX_HISTORY ? m.lossHistory.slice(1) : m.lossHistory.slice();
      if (last) lossHistory.push(last.loss);
      return {
        ...m,
        step: stepRef.current,
        loss: last ? last.loss : m.loss,
        gradNorm: last ? last.gradNorm : m.gradNorm,
        lr: last ? last.lr : m.lr,
        contrastiveAcc: last ? last.contrastiveAcc : m.contrastiveAcc,
        lossHistory,
      };
    });
  }, []);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      let last: { gradNorm: number; lr: number; loss: number; contrastiveAcc: number } | undefined;
      for (let i = 0; i < cfg.stepsPerFrame; i++) last = trainStep();
      pushMetrics(last);
      frames++;
      if (frames % EVAL_EVERY === 0) evaluate(false);
      if (frames % 3 === 0) setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, cfg.stepsPerFrame, trainStep, pushMetrics, evaluate]);

  const start = useCallback(() => setRunning(true), []);
  const pause = useCallback(() => {
    setRunning(false);
    evaluate(false);
    setTick((t) => t + 1);
  }, [evaluate]);
  const reset = useCallback(() => {
    setRunning(false);
    buildAll();
  }, [buildAll]);
  const stepOnce = useCallback(() => {
    const last = trainStep();
    pushMetrics(last);
    evaluate(false);
    setTick((t) => t + 1);
  }, [trainStep, pushMetrics, evaluate]);
  const refreshViews = useCallback(() => {
    evaluate(true);
    setTick((t) => t + 1);
  }, [evaluate]);

  const runGradCheck = useCallback((): GradCheckResult | null => {
    const enc = encRef.current;
    const data = dataRef.current;
    if (!enc || !data) return null;
    const N = Math.min(3, cfg.batchPairs);
    const baseIdx = new Int32Array(N);
    for (let i = 0; i < N; i++) baseIdx[i] = i % data.n;
    const { X, posIdx } = buildViewBatch(baseIdx, mulberry32(2024));
    const mask = diagonalMask(2 * N);
    return gradCheck(enc.parameters(), () => ntXentLoss(enc.project(X), posIdx, mask, cfg.temperature), { samplesPerParam: 2 });
  }, [cfg, buildViewBatch]);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const enc = encRef.current;
    return { weights: enc ? enc.exportWeights() : [], step: stepRef.current };
  }, []);
  const prepareLoad = useCallback((weights: number[], step: number) => {
    pendingWeights.current = weights;
    pendingStep.current = step;
  }, []);

  return {
    running,
    tick,
    metrics,
    views,
    handle,
    start,
    pause,
    reset,
    stepOnce,
    refreshViews,
    runGradCheck,
    snapshot,
    prepareLoad,
  };
}
