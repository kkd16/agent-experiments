import { useCallback, useEffect, useRef, useState } from 'react';
import { GPT } from '../engine/transformer';
import { mulberry32 } from '../engine/nn';
import {
  Optimizer,
  defaultOptimizer,
  clipGradGlobalNorm,
  globalGradNorm,
  type OptimizerConfig,
} from '../engine/optim';
import { maskedCrossEntropy } from '../engine/losses';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import {
  buildDataset,
  grokConfig,
  grokTargets,
  fourierSpectrum,
  GROK_KEEP,
  type GrokDataset,
  type GrokOp,
  type FourierSpectrum,
} from '../engine/grok';

export interface GrokTrainerConfig {
  p: number;
  op: GrokOp;
  trainFrac: number;
  dModel: number;
  nHeads: number;
  dFF: number;
  lr: number;
  weightDecay: number;
  batchSize: number; // 0 ⇒ full-batch
  stepsPerFrame: number;
  clipNorm: number;
  seed: number;
  loadId: number;
}

// One logged sample of the training trajectory. We stamp `step` so the curves can be drawn on a
// logarithmic x-axis (grokking lives across orders of magnitude of optimization steps).
export interface GrokPoint {
  step: number;
  trainAcc: number;
  testAcc: number;
  trainLoss: number;
  testLoss: number;
  weightNorm: number;
  sparsity: number;
}

export interface GrokMetrics {
  step: number;
  trainAcc: number;
  testAcc: number;
  trainLoss: number;
  testLoss: number;
  gradNorm: number;
  weightNorm: number;
  spectrum: FourierSpectrum | null;
  grokStep: number; // step at which test-acc first crossed 95% (−1 until then)
  history: GrokPoint[];
}

const MAX_HISTORY = 1200;

const EMPTY: GrokMetrics = {
  step: 0,
  trainAcc: NaN,
  testAcc: NaN,
  trainLoss: NaN,
  testLoss: NaN,
  gradNorm: NaN,
  weightNorm: NaN,
  spectrum: null,
  grokStep: -1,
  history: [],
};

function weightL2(gpt: GPT): number {
  let sq = 0;
  for (const par of gpt.parameters()) for (let i = 0; i < par.size; i++) sq += par.data[i] * par.data[i];
  return Math.sqrt(sq);
}

// Exact-match accuracy + mean loss over an index list, capped at `cap` samples (a fixed seeded
// stride) so a live per-frame eval never dominates the frame budget for large p.
function evalCapped(gpt: GPT, ds: GrokDataset, idx: Int32Array, cap: number): { acc: number; loss: number } {
  if (idx.length === 0) return { acc: NaN, loss: NaN };
  const V = ds.vocab;
  const stride = idx.length > cap ? Math.floor(idx.length / cap) : 1;
  let correct = 0;
  let lossSum = 0;
  let count = 0;
  for (let n = 0; n < idx.length; n += stride) {
    const ex = ds.all[idx[n]];
    const logits = gpt.forward(ex.ids);
    const { loss } = maskedCrossEntropy(logits, grokTargets(ex, ds.eqToken), GROK_KEEP);
    lossSum += loss.data[0];
    const base = 2 * V;
    let best = 0;
    let bv = -Infinity;
    for (let j = 0; j < V; j++) {
      const v = logits.data[base + j];
      if (v > bv) {
        bv = v;
        best = j;
      }
    }
    if (best === ex.c) correct++;
    count++;
  }
  return { acc: correct / count, loss: lossSum / count };
}

export interface GrokHandle {
  gpt: GPT | null;
  ds: GrokDataset | null;
}

export function useGrokTrainer(cfg: GrokTrainerConfig) {
  const gptRef = useRef<GPT | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const dsRef = useRef<GrokDataset | null>(null);
  const orderRef = useRef<Int32Array>(new Int32Array(0)); // shuffled train order for minibatching
  const cursorRef = useRef(0);
  const shuffleRng = useRef<() => number>(() => 0);
  const stepRef = useRef(0);
  const grokStepRef = useRef(-1);
  const rafRef = useRef<number | null>(null);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<GrokHandle>({ gpt: null, ds: null });
  const [metrics, setMetrics] = useState<GrokMetrics>(EMPTY);

  const structKey = JSON.stringify({
    p: cfg.p,
    op: cfg.op,
    trainFrac: cfg.trainFrac,
    dModel: cfg.dModel,
    nHeads: cfg.nHeads,
    dFF: cfg.dFF,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  const measure = useCallback((): GrokMetrics => {
    const gpt = gptRef.current;
    const ds = dsRef.current;
    if (!gpt || !ds) return EMPTY;
    const tr = evalCapped(gpt, ds, ds.trainIdx, 400);
    const te = evalCapped(gpt, ds, ds.testIdx, 400);
    const spectrum = fourierSpectrum(gpt, ds.p);
    const wn = weightL2(gpt);
    if (grokStepRef.current < 0 && te.acc >= 0.95) grokStepRef.current = stepRef.current;
    return {
      step: stepRef.current,
      trainAcc: tr.acc,
      testAcc: te.acc,
      trainLoss: tr.loss,
      testLoss: te.loss,
      gradNorm: NaN,
      weightNorm: wn,
      spectrum,
      grokStep: grokStepRef.current,
      history: [],
    };
  }, []);

  const buildAll = useCallback(() => {
    setRunning(false);
    const cfgG = grokConfig(cfg.p, cfg.dModel, cfg.nHeads, cfg.dFF, cfg.seed);
    const gpt = new GPT(cfgG);
    gptRef.current = gpt;
    const ocfg: OptimizerConfig = { ...defaultOptimizer('adamw', cfg.lr), weightDecay: cfg.weightDecay };
    optRef.current = new Optimizer(gpt.parameters(), ocfg);
    const ds = buildDataset(cfg.p, cfg.op, cfg.trainFrac, cfg.seed);
    dsRef.current = ds;
    orderRef.current = Int32Array.from(ds.trainIdx);
    cursorRef.current = orderRef.current.length; // force a reshuffle on first batch
    shuffleRng.current = mulberry32(cfg.seed ^ 0x5151);
    stepRef.current = 0;
    grokStepRef.current = -1;

    if (pendingWeights.current) {
      if (gpt.importWeights(pendingWeights.current)) stepRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ gpt, ds });
    const m0 = measure();
    setMetrics({
      ...m0,
      history: [
        {
          step: m0.step,
          trainAcc: m0.trainAcc,
          testAcc: m0.testAcc,
          trainLoss: m0.trainLoss,
          testLoss: m0.testLoss,
          weightNorm: m0.weightNorm,
          sparsity: m0.spectrum ? m0.spectrum.sparsity : NaN,
        },
      ],
    });
    setTick((t) => t + 1);
  }, [cfg.p, cfg.op, cfg.trainFrac, cfg.dModel, cfg.nHeads, cfg.dFF, cfg.lr, cfg.weightDecay, cfg.seed, measure]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  // Live lr / weight-decay knobs without a rebuild (the whole point is to watch weight decay
  // drive the transition, so tuning it mid-run must be instant).
  useEffect(() => {
    if (optRef.current) {
      optRef.current.cfg.lr = cfg.lr;
      optRef.current.cfg.weightDecay = cfg.weightDecay;
    }
  }, [cfg.lr, cfg.weightDecay]);

  // Draw the next minibatch of train indices (reshuffling each epoch). Full-batch when
  // batchSize ≤ 0 or ≥ train size.
  const nextBatch = useCallback((): Int32Array => {
    const order = orderRef.current;
    const B = cfg.batchSize;
    if (B <= 0 || B >= order.length) return order;
    if (cursorRef.current + B > order.length) {
      const rng = shuffleRng.current;
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
      }
      cursorRef.current = 0;
    }
    const out = order.subarray(cursorRef.current, cursorRef.current + B);
    cursorRef.current += B;
    return out;
  }, [cfg.batchSize]);

  // One optimization step. Sums the per-example scaled losses into one scalar (the loss is
  // scored at the '=' position only via GROK_KEEP) and back-propagates once, exactly like the
  // Attention lab — the difference is the *fixed* train set and weight-decayed AdamW that make
  // grokking happen.
  const trainStep = useCallback((): { gradNorm: number; trainLoss: number } | undefined => {
    const gpt = gptRef.current;
    const opt = optRef.current;
    const ds = dsRef.current;
    if (!gpt || !opt || !ds) return undefined;
    const batch = nextBatch();
    const B = batch.length;
    opt.zeroGrad();
    let total: ReturnType<GPT['forward']> | null = null;
    for (let b = 0; b < B; b++) {
      const ex = ds.all[batch[b]];
      const { loss } = maskedCrossEntropy(gpt.forward(ex.ids), grokTargets(ex, ds.eqToken), GROK_KEEP);
      const scaled = loss.scale(1 / B);
      total = total ? total.add(scaled) : scaled;
    }
    if (!total) return undefined;
    total.backward();
    const preClip = cfg.clipNorm > 0 ? clipGradGlobalNorm(gpt.parameters(), cfg.clipNorm) : globalGradNorm(gpt.parameters());
    opt.step();
    stepRef.current++;
    return { gradNorm: preClip, trainLoss: total.data[0] };
  }, [nextBatch, cfg.clipNorm]);

  const pushMetrics = useCallback((last: { gradNorm: number } | undefined) => {
    const m = measure();
    setMetrics((prev) => {
      const history = prev.history.length >= MAX_HISTORY ? prev.history.slice(1) : prev.history.slice();
      history.push({
        step: m.step,
        trainAcc: m.trainAcc,
        testAcc: m.testAcc,
        trainLoss: m.trainLoss,
        testLoss: m.testLoss,
        weightNorm: m.weightNorm,
        sparsity: m.spectrum ? m.spectrum.sparsity : NaN,
      });
      return { ...m, gradNorm: last ? last.gradNorm : prev.gradNorm, history };
    });
  }, [measure]);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    const frame = () => {
      if (!alive) return;
      let last: { gradNorm: number; trainLoss: number } | undefined;
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
    const gpt = gptRef.current;
    const ds = dsRef.current;
    if (!gpt || !ds) return null;
    const ex = ds.all[ds.trainIdx[0]];
    return gradCheck(
      gpt.parameters(),
      () => maskedCrossEntropy(gpt.forward(ex.ids), grokTargets(ex, ds.eqToken), GROK_KEEP).loss,
      { samplesPerParam: 6 },
    );
  }, []);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const gpt = gptRef.current;
    return { weights: gpt ? gpt.exportWeights() : [], step: stepRef.current };
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
    start,
    pause,
    reset,
    stepOnce,
    runGradCheck,
    snapshot,
    prepareLoad,
  };
}
