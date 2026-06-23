import { useCallback, useEffect, useRef, useState } from 'react';
import { MoEGPT } from '../engine/moe';
import { mulberry32 } from '../engine/nn';
import {
  Optimizer,
  defaultOptimizer,
  clipGradGlobalNorm,
  type OptimizerConfig,
  type OptimizerKind,
} from '../engine/optim';
import { maskedCrossEntropy } from '../engine/losses';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { makeSample, maxSeqLen, VOCAB, type SeqSample, type SeqTaskKind } from '../engine/seqtasks';

export interface MoETrainerConfig {
  task: SeqTaskKind;
  digits: number;
  dModel: number;
  nHeads: number;
  nLayers: number;
  dFF: number;
  nExperts: number;
  topK: number;
  loadCoef: number;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  clipNorm: number;
  seed: number;
  loadId: number;
}

export interface MoEMetrics {
  step: number;
  loss: number; // held-out cross-entropy (task only)
  auxLoss: number; // mean per-layer load-balancing term over the last batch
  tokAcc: number;
  seqAcc: number;
  gradNorm: number;
  loadCV: number; // coefficient of variation of per-expert load over the eval set (0 = perfectly balanced)
  lossHistory: number[];
  tokAccHistory: number[];
  seqAccHistory: number[];
  auxHistory: number[];
  loadCVHistory: number[];
}

// Per-expert routing statistics aggregated over the held-out eval set.
export interface RoutingStats {
  nExperts: number;
  nLayers: number;
  topK: number;
  util: number[]; // overall fraction of dispatches each expert received (sums to 1)
  perLayerUtil: number[][]; // [layer][expert] fractions
  cv: number; // coefficient of variation of `util` (imbalance, 0 = uniform)
  spec: number[][]; // [expert][tokenId] — top-1 routed token-identity histogram (row-normalised)
  tokenTotals: number[]; // how many top-1 dispatches each expert received
}

const MAX_HISTORY = 600;

const EMPTY: MoEMetrics = {
  step: 0,
  loss: NaN,
  auxLoss: NaN,
  tokAcc: NaN,
  seqAcc: NaN,
  gradNorm: NaN,
  loadCV: NaN,
  lossHistory: [],
  tokAccHistory: [],
  seqAccHistory: [],
  auxHistory: [],
  loadCVHistory: [],
};

export interface MoEHandle {
  moe: MoEGPT | null;
  task: SeqTaskKind;
  digits: number;
  nExperts: number;
  topK: number;
}

function sampleToTrain(ex: SeqSample) {
  const L = ex.tokens.length;
  const ids = Int32Array.from(ex.tokens.subarray(0, L - 1));
  const targets = Int32Array.from(ex.tokens.subarray(1, L));
  const keep = new Uint8Array(L - 1);
  for (let i = 0; i < L - 1; i++) keep[i] = i + 1 >= ex.answerStart ? 1 : 0;
  return { ids, targets, keep };
}

export function useMoETrainer(cfg: MoETrainerConfig) {
  const moeRef = useRef<MoEGPT | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const trainRng = useRef<() => number>(() => 0);
  const evalSetRef = useRef<SeqSample[]>([]);
  const probeRef = useRef<SeqSample | null>(null);
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<MoEHandle>({
    moe: null,
    task: cfg.task,
    digits: cfg.digits,
    nExperts: cfg.nExperts,
    topK: cfg.topK,
  });
  const [metrics, setMetrics] = useState<MoEMetrics>(EMPTY);

  const structKey = JSON.stringify({
    task: cfg.task,
    digits: cfg.digits,
    dModel: cfg.dModel,
    nHeads: cfg.nHeads,
    nLayers: cfg.nLayers,
    dFF: cfg.dFF,
    nExperts: cfg.nExperts,
    topK: cfg.topK,
    optimizer: cfg.optimizer,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  // Teacher-forced evaluation over the held-out set, plus the per-expert load coefficient of
  // variation read off the routing snapshots — the live "is the router balanced?" number.
  const evaluate = useCallback((): { loss: number; tokAcc: number; seqAcc: number; loadCV: number } => {
    const moe = moeRef.current;
    const set = evalSetRef.current;
    if (!moe || set.length === 0) return { loss: NaN, tokAcc: NaN, seqAcc: NaN, loadCV: NaN };
    let lossSum = 0;
    let tokTotal = 0;
    let tokCorrect = 0;
    let seqCorrect = 0;
    const E = moe.cfg.nExperts;
    const load = new Float64Array(E);
    for (const ex of set) {
      const { ids, targets, keep } = sampleToTrain(ex);
      const logits = moe.forward(ids);
      const { loss } = maskedCrossEntropy(logits, targets, keep);
      lossSum += loss.data[0];
      const snap = moe.lastRouting;
      if (snap) for (const ti of snap.topIdx) for (let i = 0; i < ti.length; i++) load[ti[i]]++;
      let allOk = true;
      for (let i = 0; i < targets.length; i++) {
        if (!keep[i]) continue;
        const base = i * VOCAB;
        let best = 0;
        let bv = -Infinity;
        for (let j = 0; j < VOCAB; j++) {
          const v = logits.data[base + j];
          if (v > bv) {
            bv = v;
            best = j;
          }
        }
        tokTotal++;
        if (best === targets[i]) tokCorrect++;
        else allOk = false;
      }
      if (allOk) seqCorrect++;
    }
    let tot = 0;
    for (let e = 0; e < E; e++) tot += load[e];
    const mean = 1 / E;
    let varr = 0;
    for (let e = 0; e < E; e++) {
      const f = tot > 0 ? load[e] / tot : 0;
      varr += (f - mean) * (f - mean);
    }
    const loadCV = mean > 0 ? Math.sqrt(varr / E) / mean : NaN;
    return {
      loss: lossSum / set.length,
      tokAcc: tokTotal ? tokCorrect / tokTotal : NaN,
      seqAcc: seqCorrect / set.length,
      loadCV,
    };
  }, []);

  // Full routing breakdown for the visualisers: per-expert + per-layer utilisation and an
  // expert×token-identity specialisation matrix (which token an expert most often takes, by
  // its top-1 assignment), computed over the held-out set.
  const routingStats = useCallback((): RoutingStats | null => {
    const moe = moeRef.current;
    const set = evalSetRef.current;
    if (!moe || set.length === 0) return null;
    const E = moe.cfg.nExperts;
    const L = moe.cfg.nLayers;
    const k = moe.cfg.topK;
    const util = new Float64Array(E);
    const perLayer: Float64Array[] = Array.from({ length: L }, () => new Float64Array(E));
    const spec: Float64Array[] = Array.from({ length: E }, () => new Float64Array(VOCAB));
    const tokenTotals = new Float64Array(E);
    for (const ex of set) {
      const { ids } = sampleToTrain(ex);
      moe.forward(ids);
      const snap = moe.lastRouting;
      if (!snap) continue;
      for (let l = 0; l < snap.topIdx.length; l++) {
        const ti = snap.topIdx[l];
        const T = snap.T;
        for (let t = 0; t < T; t++) {
          for (let s = 0; s < k; s++) {
            const e = ti[t * k + s];
            util[e]++;
            perLayer[l][e]++;
          }
          // top-1 expert for this token → record what token it was (specialisation)
          const top1 = ti[t * k];
          spec[top1][ids[t]]++;
          tokenTotals[top1]++;
        }
      }
    }
    let tot = 0;
    for (let e = 0; e < E; e++) tot += util[e];
    const utilArr = Array.from(util, (v) => (tot > 0 ? v / tot : 0));
    const perLayerArr = perLayer.map((row) => {
      let s = 0;
      for (let e = 0; e < E; e++) s += row[e];
      return Array.from(row, (v) => (s > 0 ? v / s : 0));
    });
    const mean = 1 / E;
    let varr = 0;
    for (let e = 0; e < E; e++) varr += (utilArr[e] - mean) * (utilArr[e] - mean);
    const cv = Math.sqrt(varr / E) / mean;
    const specArr = spec.map((row, e) => {
      const tt = tokenTotals[e];
      return Array.from(row, (v) => (tt > 0 ? v / tt : 0));
    });
    return { nExperts: E, nLayers: L, topK: k, util: utilArr, perLayerUtil: perLayerArr, cv, spec: specArr, tokenTotals: Array.from(tokenTotals) };
  }, []);

  const seedMetrics = useCallback(() => {
    const ev = evaluate();
    setMetrics({
      ...EMPTY,
      step: stepRef.current,
      loss: ev.loss,
      tokAcc: ev.tokAcc,
      seqAcc: ev.seqAcc,
      loadCV: ev.loadCV,
      lossHistory: [ev.loss],
      tokAccHistory: [ev.tokAcc],
      seqAccHistory: [ev.seqAcc],
      loadCVHistory: [ev.loadCV],
    });
  }, [evaluate]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const maxLen = maxSeqLen(cfg.task, cfg.digits);
    const moe = new MoEGPT({
      vocab: VOCAB,
      dModel: cfg.dModel,
      nHeads: cfg.nHeads,
      nLayers: cfg.nLayers,
      dFF: cfg.dFF,
      nExperts: cfg.nExperts,
      topK: Math.min(cfg.topK, cfg.nExperts),
      maxLen,
      seed: cfg.seed,
      loadCoef: cfg.loadCoef,
    });
    moeRef.current = moe;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(moe.parameters(), ocfg);
    trainRng.current = mulberry32(cfg.seed ^ 0xa5a5);

    const evalRng = mulberry32(cfg.seed ^ 0x1234);
    const evalSet: SeqSample[] = [];
    for (let i = 0; i < 48; i++) evalSet.push(makeSample(cfg.task, cfg.digits, evalRng));
    evalSetRef.current = evalSet;
    probeRef.current = makeSample(cfg.task, cfg.digits, mulberry32(cfg.seed ^ 0x7777));
    stepRef.current = 0;

    if (pendingWeights.current) {
      if (moe.importWeights(pendingWeights.current)) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ moe, task: cfg.task, digits: cfg.digits, nExperts: cfg.nExperts, topK: Math.min(cfg.topK, cfg.nExperts) });
    seedMetrics();
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cfg.task,
    cfg.digits,
    cfg.dModel,
    cfg.nHeads,
    cfg.nLayers,
    cfg.dFF,
    cfg.nExperts,
    cfg.topK,
    cfg.optimizer,
    cfg.lr,
    cfg.loadCoef,
    cfg.weightDecay,
    seedMetrics,
  ]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  // Live lr / weight-decay / aux-coef updates without a rebuild.
  useEffect(() => {
    if (optRef.current) {
      optRef.current.cfg.lr = cfg.lr;
      optRef.current.cfg.weightDecay = cfg.weightDecay;
    }
    if (moeRef.current) moeRef.current.loadCoef = cfg.loadCoef;
  }, [cfg.lr, cfg.weightDecay, cfg.loadCoef]);

  // One optimization step over a minibatch. Each sample's task cross-entropy and its router
  // load-balancing aux loss are summed into a single scalar and back-propagated once.
  const trainStep = useCallback(() => {
    const moe = moeRef.current;
    const opt = optRef.current;
    if (!moe || !opt) return undefined;
    const B = cfg.batchSize;
    const rng = trainRng.current;
    opt.zeroGrad();
    let total = null as null | ReturnType<MoEGPT['forward']>;
    let auxAccum = 0;
    for (let b = 0; b < B; b++) {
      const ex = makeSample(cfg.task, cfg.digits, rng);
      const { ids, targets, keep } = sampleToTrain(ex);
      const logits = moe.forward(ids);
      const ce = maskedCrossEntropy(logits, targets, keep).loss;
      const withAux = moe.lastAux ? ce.add(moe.lastAux) : ce;
      const scaled = withAux.scale(1 / B);
      total = total ? total.add(scaled) : scaled;
      auxAccum += moe.lastLoadValue;
    }
    if (!total) return undefined;
    total.backward();
    const gradNorm = clipGradGlobalNorm(moe.parameters(), cfg.clipNorm);
    opt.step();
    stepRef.current++;
    return { gradNorm, loss: total.data[0], auxLoss: auxAccum / B };
  }, [cfg.task, cfg.digits, cfg.batchSize, cfg.clipNorm]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; loss: number; auxLoss: number } | undefined) => {
      const ev = evaluate();
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const tokAccHistory = cap(m.tokAccHistory);
        const seqAccHistory = cap(m.seqAccHistory);
        const auxHistory = cap(m.auxHistory);
        const loadCVHistory = cap(m.loadCVHistory);
        lossHistory.push(ev.loss);
        tokAccHistory.push(ev.tokAcc);
        seqAccHistory.push(ev.seqAcc);
        if (last) auxHistory.push(last.auxLoss);
        loadCVHistory.push(ev.loadCV);
        return {
          step: stepRef.current,
          loss: ev.loss,
          auxLoss: last ? last.auxLoss : m.auxLoss,
          tokAcc: ev.tokAcc,
          seqAcc: ev.seqAcc,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          loadCV: ev.loadCV,
          lossHistory,
          tokAccHistory,
          seqAccHistory,
          auxHistory,
          loadCVHistory,
        };
      });
    },
    [evaluate],
  );

  useEffect(() => {
    if (!running) return;
    let alive = true;
    const frame = () => {
      if (!alive) return;
      let last: { gradNorm: number; loss: number; auxLoss: number } | undefined;
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
    const moe = moeRef.current;
    if (!moe) return null;
    const ex = probeRef.current ?? makeSample(cfg.task, cfg.digits, mulberry32(7));
    const { ids, targets, keep } = sampleToTrain(ex);
    return gradCheck(
      moe.parameters(),
      () => {
        const logits = moe.forward(ids);
        const ce = maskedCrossEntropy(logits, targets, keep).loss;
        return moe.lastAux ? ce.add(moe.lastAux) : ce;
      },
      { samplesPerParam: 4 },
    );
  }, [cfg.task, cfg.digits]);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const moe = moeRef.current;
    return { weights: moe ? moe.exportWeights() : [], step: stepRef.current };
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
    probe: probeRef,
    routingStats,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    snapshot,
    prepareLoad,
  };
}
