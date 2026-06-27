import { useCallback, useEffect, useRef, useState } from 'react';
import { MambaLM, defaultDtRank } from '../engine/ssm';
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
import { makeSample, maxSeqLen, VOCAB, type SsmSample, type SsmTaskKind } from '../engine/ssmtasks';

export interface SsmTrainerConfig {
  task: SsmTaskKind;
  n: number; // task difficulty (digits / pairs)
  dModel: number;
  dState: number; // N
  expand: number;
  nLayers: number;
  optimizer: OptimizerKind;
  lr: number;
  weightDecay: number;
  batchSize: number;
  stepsPerFrame: number;
  clipNorm: number;
  seed: number;
  loadId: number;
}

export interface SsmMetrics {
  step: number;
  loss: number;
  tokAcc: number;
  seqAcc: number;
  gradNorm: number;
  lossHistory: number[];
  tokAccHistory: number[];
  seqAccHistory: number[];
  gradNormHistory: number[];
}

const MAX_HISTORY = 600;

const EMPTY: SsmMetrics = {
  step: 0,
  loss: NaN,
  tokAcc: NaN,
  seqAcc: NaN,
  gradNorm: NaN,
  lossHistory: [],
  tokAccHistory: [],
  seqAccHistory: [],
  gradNormHistory: [],
};

export interface SsmHandle {
  model: MambaLM | null;
  task: SsmTaskKind;
  n: number;
}

const D_CONV = 4;

function sampleToTrain(ex: SsmSample) {
  const L = ex.tokens.length;
  const ids = Int32Array.from(ex.tokens.subarray(0, L - 1));
  const targets = Int32Array.from(ex.tokens.subarray(1, L));
  const keep = new Uint8Array(L - 1);
  for (let i = 0; i < L - 1; i++) keep[i] = i + 1 >= ex.answerStart ? 1 : 0;
  return { ids, targets, keep };
}

export function useSsmTrainer(cfg: SsmTrainerConfig) {
  const modelRef = useRef<MambaLM | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const trainRng = useRef<() => number>(() => 0);
  const evalSetRef = useRef<SsmSample[]>([]);
  const probeRef = useRef<SsmSample | null>(null);
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<SsmHandle>({ model: null, task: cfg.task, n: cfg.n });
  const [metrics, setMetrics] = useState<SsmMetrics>(EMPTY);

  const structKey = JSON.stringify({
    task: cfg.task,
    n: cfg.n,
    dModel: cfg.dModel,
    dState: cfg.dState,
    expand: cfg.expand,
    nLayers: cfg.nLayers,
    optimizer: cfg.optimizer,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  const evaluate = useCallback((): { loss: number; tokAcc: number; seqAcc: number } => {
    const model = modelRef.current;
    const set = evalSetRef.current;
    if (!model || set.length === 0) return { loss: NaN, tokAcc: NaN, seqAcc: NaN };
    let lossSum = 0;
    let tokTotal = 0;
    let tokCorrect = 0;
    let seqCorrect = 0;
    for (const ex of set) {
      const { ids, targets, keep } = sampleToTrain(ex);
      const logits = model.forward(ids);
      const { loss } = maskedCrossEntropy(logits, targets, keep);
      lossSum += loss.data[0];
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
    return {
      loss: lossSum / set.length,
      tokAcc: tokTotal ? tokCorrect / tokTotal : NaN,
      seqAcc: seqCorrect / set.length,
    };
  }, []);

  const seedMetrics = useCallback(() => {
    const ev = evaluate();
    setMetrics({
      ...EMPTY,
      step: stepRef.current,
      loss: ev.loss,
      tokAcc: ev.tokAcc,
      seqAcc: ev.seqAcc,
      lossHistory: [ev.loss],
      tokAccHistory: [ev.tokAcc],
      seqAccHistory: [ev.seqAcc],
    });
  }, [evaluate]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const maxLen = maxSeqLen(cfg.task, cfg.n);
    const model = new MambaLM({
      vocab: VOCAB,
      dModel: cfg.dModel,
      dState: cfg.dState,
      dConv: D_CONV,
      expand: cfg.expand,
      dtRank: defaultDtRank(cfg.dModel, cfg.expand),
      nLayers: cfg.nLayers,
      maxLen,
      seed: cfg.seed,
    });
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    trainRng.current = mulberry32(cfg.seed ^ 0xa5a5);

    const evalRng = mulberry32(cfg.seed ^ 0x1234);
    const evalSet: SsmSample[] = [];
    for (let i = 0; i < 48; i++) evalSet.push(makeSample(cfg.task, cfg.n, evalRng));
    evalSetRef.current = evalSet;
    probeRef.current = makeSample(cfg.task, cfg.n, mulberry32(cfg.seed ^ 0x7777));
    stepRef.current = 0;

    if (pendingWeights.current) {
      if (model.importWeights(pendingWeights.current)) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, task: cfg.task, n: cfg.n });
    seedMetrics();
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cfg.task,
    cfg.n,
    cfg.dModel,
    cfg.dState,
    cfg.expand,
    cfg.nLayers,
    cfg.optimizer,
    cfg.lr,
    cfg.weightDecay,
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
    if (!model || !opt) return undefined;
    const B = cfg.batchSize;
    const rng = trainRng.current;
    opt.zeroGrad();
    let total = null as null | ReturnType<MambaLM['forward']>;
    for (let b = 0; b < B; b++) {
      const ex = makeSample(cfg.task, cfg.n, rng);
      const { ids, targets, keep } = sampleToTrain(ex);
      const { loss } = maskedCrossEntropy(model.forward(ids), targets, keep);
      const scaled = loss.scale(1 / B);
      total = total ? total.add(scaled) : scaled;
    }
    if (!total) return undefined;
    total.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.step();
    stepRef.current++;
    return { gradNorm, loss: total.data[0] };
  }, [cfg.task, cfg.n, cfg.batchSize, cfg.clipNorm]);

  const pushMetrics = useCallback(
    (last: { gradNorm: number; loss: number } | undefined) => {
      const ev = evaluate();
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const tokAccHistory = cap(m.tokAccHistory);
        const seqAccHistory = cap(m.seqAccHistory);
        const gradNormHistory = cap(m.gradNormHistory);
        lossHistory.push(ev.loss);
        tokAccHistory.push(ev.tokAcc);
        seqAccHistory.push(ev.seqAcc);
        if (last) gradNormHistory.push(last.gradNorm);
        return {
          step: stepRef.current,
          loss: ev.loss,
          tokAcc: ev.tokAcc,
          seqAcc: ev.seqAcc,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          lossHistory,
          tokAccHistory,
          seqAccHistory,
          gradNormHistory,
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
      let last: { gradNorm: number; loss: number } | undefined;
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
    const ex = probeRef.current ?? makeSample(cfg.task, cfg.n, mulberry32(7));
    const { ids, targets, keep } = sampleToTrain(ex);
    return gradCheck(model.parameters(), () => maskedCrossEntropy(model.forward(ids), targets, keep).loss, {
      samplesPerParam: 5,
    });
  }, [cfg.task, cfg.n]);

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
    handle,
    probe: probeRef,
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    snapshot,
    prepareLoad,
  };
}
