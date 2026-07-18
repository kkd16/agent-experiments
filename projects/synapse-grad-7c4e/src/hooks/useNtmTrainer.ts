import { useCallback, useEffect, useRef, useState } from 'react';
import { NTM, type ControllerKind } from '../engine/ntm';
import { mulberry32 } from '../engine/nn';
import {
  Optimizer,
  defaultOptimizer,
  clipGradGlobalNorm,
  type OptimizerConfig,
  type OptimizerKind,
} from '../engine/optim';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import {
  makeSample,
  ntmLoss,
  scoreSample,
  inputWidth,
  outputWidth,
  type NtmSample,
  type NtmTaskConfig,
  type NtmTaskKind,
} from '../engine/ntmtasks';

export interface NtmTrainerConfig {
  task: NtmTaskKind;
  bitWidth: number;
  controller: ControllerKind;
  controllerSize: number; // H
  memLocations: number; // N
  memWidth: number; // M
  readHeads: number;
  writeHeads: number;
  shiftRange: number;
  maxLen: number; // curriculum ceiling
  optimizer: OptimizerKind;
  lr: number;
  clipNorm: number;
  batchSize: number;
  stepsPerFrame: number;
  probeLen: number; // length of the fixed sample the visualizers render
  seed: number;
  loadId: number;
}

export interface NtmMetrics {
  step: number;
  loss: number;
  bitAcc: number;
  seqAcc: number;
  genAcc: number; // held-out solve rate at lengths *beyond* the training ceiling
  curLen: number;
  gradNorm: number;
  lossHistory: number[];
  bitAccHistory: number[];
  seqAccHistory: number[];
  gradNormHistory: number[];
}

const MAX_HISTORY = 600;

const EMPTY: NtmMetrics = {
  step: 0,
  loss: NaN,
  bitAcc: NaN,
  seqAcc: NaN,
  genAcc: NaN,
  curLen: 1,
  gradNorm: NaN,
  lossHistory: [],
  bitAccHistory: [],
  seqAccHistory: [],
  gradNormHistory: [],
};

export interface NtmHandle {
  model: NTM | null;
  task: NtmTaskKind;
}

function taskConfig(cfg: NtmTrainerConfig, curLen: number): NtmTaskConfig {
  // `curLen` is the difficulty knob: sequence length for copy / repeat-copy, and the number of
  // stored items for associative recall (which then indexes maxItems).
  return {
    kind: cfg.task,
    bitWidth: cfg.bitWidth,
    minLen: 1,
    curLen,
    maxRepeats: 3,
    itemLen: 3,
    maxItems: Math.max(2, curLen),
  };
}

export function useNtmTrainer(cfg: NtmTrainerConfig) {
  const modelRef = useRef<NTM | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const trainRng = useRef<() => number>(() => 0);
  const evalSetRef = useRef<NtmSample[]>([]);
  const genSetRef = useRef<NtmSample[]>([]);
  const probeRef = useRef<NtmSample | null>(null);
  const stepRef = useRef(0);
  const curLenRef = useRef(1);
  const rafRef = useRef<number | null>(null);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);
  const pendingCurLen = useRef(1);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<NtmHandle>({ model: null, task: cfg.task });
  const [metrics, setMetrics] = useState<NtmMetrics>(EMPTY);

  const structKey = JSON.stringify({
    task: cfg.task,
    bitWidth: cfg.bitWidth,
    controller: cfg.controller,
    controllerSize: cfg.controllerSize,
    memLocations: cfg.memLocations,
    memWidth: cfg.memWidth,
    readHeads: cfg.readHeads,
    writeHeads: cfg.writeHeads,
    shiftRange: cfg.shiftRange,
    optimizer: cfg.optimizer,
    probeLen: cfg.probeLen,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  // Build a fixed-length evaluation set at a given length ceiling.
  const buildSet = useCallback(
    (cfgKind: NtmTrainerConfig, curLen: number, count: number, seed: number): NtmSample[] => {
      const rng = mulberry32(seed);
      const tc = taskConfig(cfgKind, curLen);
      const set: NtmSample[] = [];
      for (let i = 0; i < count; i++) set.push(makeSample(tc, rng));
      return set;
    },
    [],
  );

  const evaluate = useCallback((): { loss: number; bitAcc: number; seqAcc: number; genAcc: number } => {
    const model = modelRef.current;
    const set = evalSetRef.current;
    if (!model || set.length === 0) return { loss: NaN, bitAcc: NaN, seqAcc: NaN, genAcc: NaN };
    let lossSum = 0;
    let bt = 0;
    let bc = 0;
    let seq = 0;
    for (const ex of set) {
      const { logits } = model.forward(ex.inputs);
      const l = ntmLoss(logits, ex);
      if (l) lossSum += l.data[0];
      const sc = scoreSample(logits, ex);
      bt += sc.bitTotal;
      bc += sc.bitCorrect;
      if (sc.solved) seq++;
    }
    // Generalization: solve rate on sequences longer than anything trained on.
    let gen = 0;
    const gset = genSetRef.current;
    for (const ex of gset) {
      const { logits } = model.forward(ex.inputs);
      if (scoreSample(logits, ex).solved) gen++;
    }
    return {
      loss: lossSum / set.length,
      bitAcc: bt ? bc / bt : NaN,
      seqAcc: seq / set.length,
      genAcc: gset.length ? gen / gset.length : NaN,
    };
  }, []);

  const seedMetrics = useCallback(() => {
    const ev = evaluate();
    setMetrics({
      ...EMPTY,
      step: stepRef.current,
      loss: ev.loss,
      bitAcc: ev.bitAcc,
      seqAcc: ev.seqAcc,
      genAcc: ev.genAcc,
      curLen: curLenRef.current,
      lossHistory: [ev.loss],
      bitAccHistory: [ev.bitAcc],
      seqAccHistory: [ev.seqAcc],
    });
  }, [evaluate]);

  const buildAll = useCallback(() => {
    setRunning(false);
    const tc0 = taskConfig(cfg, 1);
    const model = new NTM({
      inputWidth: inputWidth(tc0),
      outputWidth: outputWidth(tc0),
      memLocations: cfg.memLocations,
      memWidth: cfg.memWidth,
      controller: cfg.controller,
      controllerSize: cfg.controllerSize,
      readHeads: cfg.readHeads,
      writeHeads: cfg.writeHeads,
      shiftRange: cfg.shiftRange,
      seed: cfg.seed,
    });
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr), momentum: 0.9 };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    trainRng.current = mulberry32((cfg.seed ^ 0xa5a5) >>> 0);
    stepRef.current = 0;
    curLenRef.current = Math.min(2, cfg.maxLen);

    // Fixed probe sample for the visualizers (deterministic).
    const probeRng = mulberry32((cfg.seed ^ 0x7777) >>> 0);
    const probeTc = taskConfig(cfg, cfg.probeLen);
    probeTc.minLen = cfg.probeLen; // exact length for a legible raster
    probeRef.current = makeSample(probeTc, probeRng);

    if (pendingWeights.current) {
      if (model.importWeights(pendingWeights.current)) {
        stepRef.current = pendingStep.current;
        curLenRef.current = pendingCurLen.current;
      }
      pendingWeights.current = null;
    }

    evalSetRef.current = buildSet(cfg, curLenRef.current, 24, (cfg.seed ^ 0x1234) >>> 0);
    genSetRef.current = buildSet(cfg, cfg.maxLen + 4, 16, (cfg.seed ^ 0x9abc) >>> 0);

    setHandle({ model, task: cfg.task });
    seedMetrics();
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey, seedMetrics, buildSet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  useEffect(() => {
    if (optRef.current) optRef.current.cfg.lr = cfg.lr;
  }, [cfg.lr]);

  const trainStep = useCallback(() => {
    const model = modelRef.current;
    const opt = optRef.current;
    if (!model || !opt) return undefined;
    const B = cfg.batchSize;
    const rng = trainRng.current;
    const tc = taskConfig(cfg, curLenRef.current);
    opt.zeroGrad();
    let total: ReturnType<typeof ntmLoss> = null;
    for (let b = 0; b < B; b++) {
      const ex = makeSample(tc, rng);
      const l = ntmLoss(model.forward(ex.inputs).logits, ex);
      if (!l) continue;
      const scaled = l.scale(1 / B);
      total = total ? total.add(scaled) : scaled;
    }
    if (!total) return undefined;
    total.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.step();
    stepRef.current++;
    return { gradNorm, loss: total.data[0] };
  }, [cfg.task, cfg.bitWidth, cfg.batchSize, cfg.clipNorm]);

  // Advance the curriculum: when the held-out solve rate at the current ceiling is high, extend
  // to longer sequences (rebuilding the eval set) — this is what lets the machine learn an
  // algorithm that generalizes past its training lengths.
  const maybeAdvance = useCallback(
    (seqAcc: number) => {
      if (seqAcc >= 0.93 && curLenRef.current < cfg.maxLen) {
        curLenRef.current += 1;
        evalSetRef.current = buildSet(cfg, curLenRef.current, 24, (cfg.seed ^ 0x1234) >>> 0);
      }
    },
    [buildSet, cfg],
  );

  const pushMetrics = useCallback(
    (last: { gradNorm: number; loss: number } | undefined) => {
      const ev = evaluate();
      maybeAdvance(ev.seqAcc);
      setMetrics((m) => {
        const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
        const lossHistory = cap(m.lossHistory);
        const bitAccHistory = cap(m.bitAccHistory);
        const seqAccHistory = cap(m.seqAccHistory);
        const gradNormHistory = cap(m.gradNormHistory);
        lossHistory.push(ev.loss);
        bitAccHistory.push(ev.bitAcc);
        seqAccHistory.push(ev.seqAcc);
        if (last) gradNormHistory.push(last.gradNorm);
        return {
          step: stepRef.current,
          loss: ev.loss,
          bitAcc: ev.bitAcc,
          seqAcc: ev.seqAcc,
          genAcc: ev.genAcc,
          curLen: curLenRef.current,
          gradNorm: last ? last.gradNorm : m.gradNorm,
          lossHistory,
          bitAccHistory,
          seqAccHistory,
          gradNormHistory,
        };
      });
    },
    [evaluate, maybeAdvance],
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
    const tc = taskConfig(cfg, 2);
    tc.minLen = 2;
    const ex = makeSample(tc, mulberry32(7));
    return gradCheck(model.parameters(), () => ntmLoss(model.forward(ex.inputs).logits, ex)!, {
      samplesPerParam: 2,
      eps: 1e-4,
    });
  }, [cfg]);

  const snapshot = useCallback((): { weights: number[]; step: number; curLen: number } => {
    const model = modelRef.current;
    return { weights: model ? model.exportWeights() : [], step: stepRef.current, curLen: curLenRef.current };
  }, []);

  const prepareLoad = useCallback((weights: number[], step: number, curLen: number) => {
    pendingWeights.current = weights;
    pendingStep.current = step;
    pendingCurLen.current = curLen;
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
