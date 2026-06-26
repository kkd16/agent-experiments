import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import {
  NCA,
  makeSeed,
  renderTarget,
  renderRGBA,
  ncaVisibleLoss,
  damage,
  NCA_TARGETS,
  type GridMeta,
} from '../engine/nca';
import { mulberry32 } from '../engine/nn';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm, type OptimizerConfig, type OptimizerKind } from '../engine/optim';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';

export type NCAMode = 'grow' | 'persist' | 'regenerate';

export interface NCAConfigUI {
  target: string;
  grid: number; // training grid (H = W)
  channels: number; // C
  hidden: number; // update MLP width
  fireRate: number;
  mode: NCAMode;
  poolSize: number;
  batchSize: number;
  stepsMin: number;
  stepsMax: number;
  optimizer: OptimizerKind;
  lr: number;
  clipNorm: number;
  damageRadius: number; // fraction of grid
  seed: number;
  demoScale: number; // demo grid = grid * demoScale
  loadId: number;
}

export interface NCAMetrics {
  step: number;
  loss: number;
  gradNorm: number;
  lr: number;
  msPerStep: number;
  lossHistory: number[];
}

export interface NCAHandle {
  model: NCA | null;
  trainMeta: GridMeta;
  demoMeta: GridMeta;
  target: Float64Array | null;
  targetId: string;
  rebuildKey: number;
}

export interface PoolThumb {
  rgba: Uint8ClampedArray;
  loss: number;
}

const MAX_HISTORY = 600;

const EMPTY_METRICS: NCAMetrics = {
  step: 0,
  loss: NaN,
  gradNorm: NaN,
  lr: NaN,
  msPerStep: NaN,
  lossHistory: [],
};

function visibleLossOf(state: Float64Array, target: Float64Array, cells: number, C: number, off = 0): number {
  let total = 0;
  for (let p = 0; p < cells; p++) {
    const s = off + p * C;
    const t = p * 4;
    for (let c = 0; c < 4; c++) {
      const d = state[s + c] - target[t + c];
      total += d * d;
    }
  }
  return total / (cells * 4);
}

export function useNCATrainer(cfg: NCAConfigUI) {
  const modelRef = useRef<NCA | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const poolRef = useRef<Float64Array[]>([]);
  const targetRef = useRef<Float64Array | null>(null);
  const seedRef = useRef<Float64Array>(new Float64Array());
  const rngRef = useRef<() => number>(() => 0);
  const stepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingWeights = useRef<number[] | null>(null);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<NCAHandle>({
    model: null,
    trainMeta: { N: 1, H: cfg.grid, W: cfg.grid, C: cfg.channels },
    demoMeta: { N: 1, H: cfg.grid * cfg.demoScale, W: cfg.grid * cfg.demoScale, C: cfg.channels },
    target: null,
    targetId: cfg.target,
    rebuildKey: 0,
  });
  const [metrics, setMetrics] = useState<NCAMetrics>(EMPTY_METRICS);

  const structKey = JSON.stringify({
    grid: cfg.grid,
    channels: cfg.channels,
    hidden: cfg.hidden,
    fireRate: cfg.fireRate,
    poolSize: cfg.poolSize,
    optimizer: cfg.optimizer,
    seed: cfg.seed,
    demoScale: cfg.demoScale,
    loadId: cfg.loadId,
  });

  const buildAll = useCallback(() => {
    setRunning(false);
    const C = cfg.channels;
    const trainMeta: GridMeta = { N: 1, H: cfg.grid, W: cfg.grid, C };
    const demoMeta: GridMeta = { N: 1, H: cfg.grid * cfg.demoScale, W: cfg.grid * cfg.demoScale, C };

    const targetId = NCA_TARGETS.some((t) => t.id === cfg.target) ? cfg.target : NCA_TARGETS[0].id;
    targetRef.current = renderTarget(targetId, trainMeta);
    seedRef.current = makeSeed(trainMeta);

    // sample pool: every slot starts as a fresh seed
    const pool: Float64Array[] = [];
    for (let i = 0; i < cfg.poolSize; i++) pool.push(seedRef.current.slice());
    poolRef.current = pool;

    const model = new NCA({ channels: C, hidden: cfg.hidden, fireRate: cfg.fireRate }, mulberry32(cfg.seed));
    modelRef.current = model;
    const ocfg: OptimizerConfig = { ...defaultOptimizer(cfg.optimizer, cfg.lr) };
    optRef.current = new Optimizer(model.parameters(), ocfg);
    rngRef.current = mulberry32(cfg.seed ^ 0x9e3779b9);
    stepRef.current = 0;

    if (pendingWeights.current) {
      model.importWeights(pendingWeights.current);
      pendingWeights.current = null;
    }

    setHandle((h) => ({
      model,
      trainMeta,
      demoMeta,
      target: targetRef.current,
      targetId,
      rebuildKey: h.rebuildKey + 1,
    }));
    setMetrics(EMPTY_METRICS);
    setTick((t) => t + 1);
  }, [cfg.channels, cfg.grid, cfg.hidden, cfg.fireRate, cfg.poolSize, cfg.optimizer, cfg.lr, cfg.seed, cfg.demoScale, cfg.target]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  // a target switch (no structural rebuild) just re-renders the target + resets the pool to seeds
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const trainMeta: GridMeta = { N: 1, H: cfg.grid, W: cfg.grid, C: cfg.channels };
    const targetId = NCA_TARGETS.some((t) => t.id === cfg.target) ? cfg.target : NCA_TARGETS[0].id;
    targetRef.current = renderTarget(targetId, trainMeta);
    seedRef.current = makeSeed(trainMeta);
    poolRef.current = poolRef.current.map(() => seedRef.current.slice());
    setHandle((h) => ({ ...h, target: targetRef.current, targetId, rebuildKey: h.rebuildKey + 1 }));
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.target]);

  useEffect(() => {
    if (optRef.current) optRef.current.cfg.lr = cfg.lr;
  }, [cfg.lr]);

  const trainStep = useCallback((): { loss: number; gradNorm: number; ms: number } | undefined => {
    const model = modelRef.current;
    const opt = optRef.current;
    const target = targetRef.current;
    if (!model || !opt || !target) return;
    const randint = (n: number) => Math.floor(rngRef.current() * n) % n;
    const C = cfg.channels;
    const cells = cfg.grid * cfg.grid;
    const bs = cfg.batchSize;
    const seed = seedRef.current;
    const pool = poolRef.current;
    const t0 = performance.now();

    const T = cfg.stepsMin + randint(Math.max(1, cfg.stepsMax - cfg.stepsMin + 1));
    const buf = new Float64Array(bs * cells * C);
    const idxs = new Int32Array(bs);

    if (cfg.mode === 'grow') {
      for (let b = 0; b < bs; b++) buf.set(seed, b * cells * C);
    } else {
      // sample pool indices; replace the highest-loss member with a fresh seed
      const losses = new Float64Array(bs);
      let worst = 0;
      let worstLoss = -Infinity;
      for (let b = 0; b < bs; b++) {
        idxs[b] = randint(pool.length);
        losses[b] = visibleLossOf(pool[idxs[b]], target, cells, C);
        if (losses[b] > worstLoss) {
          worstLoss = losses[b];
          worst = b;
        }
      }
      for (let b = 0; b < bs; b++) {
        const off = b * cells * C;
        if (b === worst) buf.set(seed, off);
        else buf.set(pool[idxs[b]], off);
      }
      if (cfg.mode === 'regenerate') {
        // damage the lowest-loss samples (the ones that have grown best) so the rule must regrow
        const order = Array.from({ length: bs }, (_, b) => b)
          .filter((b) => b !== worst)
          .sort((a, c) => losses[a] - losses[c]);
        const nDmg = Math.min(order.length, Math.max(1, Math.round(bs * 0.4)));
        const meta1: GridMeta = { N: 1, H: cfg.grid, W: cfg.grid, C };
        const rad = Math.max(2, cfg.damageRadius * cfg.grid);
        for (let d = 0; d < nDmg; d++) {
          const b = order[d];
          const sub = buf.subarray(b * cells * C, (b + 1) * cells * C);
          const cx = (0.25 + 0.5 * rngRef.current()) * cfg.grid;
          const cy = (0.25 + 0.5 * rngRef.current()) * cfg.grid;
          damage(sub, meta1, cx, cy, rad);
        }
      }
    }

    const meta: GridMeta = { N: bs, H: cfg.grid, W: cfg.grid, C };
    const seedT = Tensor.fromFlat(buf, bs * cells, C, false);
    const { state } = model.rollout(seedT, T, meta, rngRef.current);
    const loss = ncaVisibleLoss(state, target, meta);
    opt.zeroGrad();
    loss.backward();
    const gradNorm = clipGradGlobalNorm(model.parameters(), cfg.clipNorm);
    opt.step();
    stepRef.current++;

    // write final states back into the pool (persist / regenerate)
    if (cfg.mode !== 'grow') {
      for (let b = 0; b < bs; b++) {
        const off = b * cells * C;
        pool[idxs[b]] = state.data.slice(off, off + cells * C);
      }
    }

    return { loss: loss.data[0], gradNorm, ms: performance.now() - t0 };
  }, [cfg.batchSize, cfg.channels, cfg.clipNorm, cfg.damageRadius, cfg.grid, cfg.mode, cfg.stepsMax, cfg.stepsMin]);

  const pushMetrics = useCallback((last: { loss: number; gradNorm: number; ms: number } | undefined) => {
    if (!last) return;
    setMetrics((m) => {
      const lossHistory = m.lossHistory.length >= MAX_HISTORY ? m.lossHistory.slice(1) : m.lossHistory.slice();
      lossHistory.push(last.loss);
      return {
        step: stepRef.current,
        loss: last.loss,
        gradNorm: last.gradNorm,
        lr: optRef.current?.cfg.lr ?? cfg.lr,
        msPerStep: last.ms,
        lossHistory,
      };
    });
  }, [cfg.lr]);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      const last = trainStep();
      pushMetrics(last);
      frames++;
      if (frames % 2 === 0) setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, trainStep, pushMetrics]);

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
    const target = targetRef.current;
    if (!model || !target) return null;
    const C = cfg.channels;
    const cells = cfg.grid * cfg.grid;
    const meta: GridMeta = { N: 1, H: cfg.grid, W: cfg.grid, C };
    const seedT = Tensor.fromFlat(seedRef.current.slice(), cells, C, false);
    const T = Math.min(8, cfg.stepsMin);
    const captured = model.rollout(seedT, T, meta, mulberry32(0x5eed)).masks;
    return gradCheck(
      model.parameters(),
      () => ncaVisibleLoss(model.rollout(seedT, T, meta, mulberry32(0x5eed), captured).state, target, meta),
      { samplesPerParam: 2 },
    );
  }, [cfg.channels, cfg.grid, cfg.stepsMin]);

  // pool thumbnails (train-grid RGBA + stored loss), for the pool strip
  const poolThumbs = useCallback((maxN: number): PoolThumb[] => {
    const target = targetRef.current;
    if (!target) return [];
    const C = cfg.channels;
    const cells = cfg.grid * cfg.grid;
    const meta: GridMeta = { N: 1, H: cfg.grid, W: cfg.grid, C };
    const pool = poolRef.current;
    const out: PoolThumb[] = [];
    const n = Math.min(maxN, pool.length);
    for (let i = 0; i < n; i++) {
      out.push({ rgba: renderRGBA(pool[i], meta), loss: visibleLossOf(pool[i], target, cells, C) });
    }
    return out;
  }, [cfg.channels, cfg.grid]);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const model = modelRef.current;
    return { weights: model ? model.exportWeights() : [], step: stepRef.current };
  }, []);

  const prepareLoad = useCallback((weights: number[]) => {
    pendingWeights.current = weights;
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
    poolThumbs,
    snapshot,
    prepareLoad,
  };
}
