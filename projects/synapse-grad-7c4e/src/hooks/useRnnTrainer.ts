import { useCallback, useEffect, useRef, useState } from 'react';
import { RecurrentLM, type CellKind } from '../engine/recurrent';
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
import { makeSample, vocabSize, type RnnSample, type RnnTaskKind } from '../engine/charseq';

export interface RnnTrainerConfig {
  cell: CellKind;
  task: RnnTaskKind;
  len: number;
  embDim: number;
  hidden: number;
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

export interface RnnMetrics {
  step: number;
  loss: number;
  tokAcc: number; // per-graded-token accuracy on the eval set
  seqAcc: number; // exact-match (all graded tokens correct) on the eval set
  gradNorm: number;
  lossHistory: number[];
  tokAccHistory: number[];
  seqAccHistory: number[];
  gradNormHistory: number[];
}

const MAX_HISTORY = 600;

const EMPTY: RnnMetrics = {
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

export interface RnnHandle {
  model: RecurrentLM | null;
  task: RnnTaskKind;
  len: number;
  cell: CellKind;
}

export function useRnnTrainer(cfg: RnnTrainerConfig) {
  const modelRef = useRef<RecurrentLM | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const trainRng = useRef<() => number>(() => 0);
  const evalSetRef = useRef<RnnSample[]>([]);
  const probeRef = useRef<RnnSample | null>(null);
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<RnnHandle>({ model: null, task: cfg.task, len: cfg.len, cell: cfg.cell });
  const [metrics, setMetrics] = useState<RnnMetrics>(EMPTY);

  const structKey = JSON.stringify({
    cell: cfg.cell,
    task: cfg.task,
    len: cfg.len,
    embDim: cfg.embDim,
    hidden: cfg.hidden,
    nLayers: cfg.nLayers,
    optimizer: cfg.optimizer,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  const evaluate = useCallback((): { loss: number; tokAcc: number; seqAcc: number } => {
    const model = modelRef.current;
    const set = evalSetRef.current;
    if (!model || set.length === 0) return { loss: NaN, tokAcc: NaN, seqAcc: NaN };
    const vocab = model.cfg.vocab;
    let lossSum = 0;
    let tokTotal = 0;
    let tokCorrect = 0;
    let seqCorrect = 0;
    for (const ex of set) {
      const logits = model.forward(ex.input);
      lossSum += maskedCrossEntropy(logits, ex.target, ex.keep).loss.data[0];
      let allOk = true;
      for (let i = 0; i < ex.target.length; i++) {
        if (!ex.keep[i]) continue;
        const base = i * vocab;
        let best = 0;
        let bv = -Infinity;
        for (let j = 0; j < vocab; j++) {
          const v = logits.data[base + j];
          if (v > bv) {
            bv = v;
            best = j;
          }
        }
        tokTotal++;
        if (best === ex.target[i]) tokCorrect++;
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
    const vocab = vocabSize(cfg.task);
    const model = new RecurrentLM({
      cell: cfg.cell,
      vocab,
      embDim: cfg.embDim,
      hidden: cfg.hidden,
      nLayers: cfg.nLayers,
      seed: cfg.seed,
    });
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    trainRng.current = mulberry32(cfg.seed ^ 0xa5a5);

    const evalRng = mulberry32(cfg.seed ^ 0x1234);
    const evalSet: RnnSample[] = [];
    for (let i = 0; i < 48; i++) evalSet.push(makeSample(cfg.task, cfg.len, evalRng));
    evalSetRef.current = evalSet;
    probeRef.current = makeSample(cfg.task, cfg.len, mulberry32(cfg.seed ^ 0x7777));
    stepRef.current = 0;

    if (pendingWeights.current) {
      if (model.importWeights(pendingWeights.current)) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ model, task: cfg.task, len: cfg.len, cell: cfg.cell });
    seedMetrics();
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cfg.cell,
    cfg.task,
    cfg.len,
    cfg.embDim,
    cfg.hidden,
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
    let total = null as null | ReturnType<RecurrentLM['forward']>;
    for (let b = 0; b < B; b++) {
      const ex = makeSample(cfg.task, cfg.len, rng);
      const { loss } = maskedCrossEntropy(model.forward(ex.input), ex.target, ex.keep);
      const scaled = loss.scale(1 / B);
      total = total ? total.add(scaled) : scaled;
    }
    if (!total) return undefined;
    total.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.step();
    stepRef.current++;
    return { gradNorm, loss: total.data[0] };
  }, [cfg.task, cfg.len, cfg.batchSize, cfg.clipNorm]);

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
    const ex = probeRef.current ?? makeSample(cfg.task, cfg.len, mulberry32(7));
    return gradCheck(model.parameters(), () => maskedCrossEntropy(model.forward(ex.input), ex.target, ex.keep).loss, {
      samplesPerParam: 4,
    });
  }, [cfg.task, cfg.len]);

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
