import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { gatherCols } from '../engine/ops';
import { mulberry32, type Activation } from '../engine/nn';
import { makeEnv, type Env, GRID_LAYOUTS } from '../engine/rl-env';
import {
  DQNAgent,
  qForward,
  tabularQStar,
  weightedHuber,
  tdTarget,
  type DQNConfig,
  type QArch,
} from '../engine/dqn';

// DQN supports discrete-action environments only (its argmax_a Q(s,a) is over a finite action set).
export type DQNEnvKind = 'cartpole' | 'gridworld' | 'mountaincar';

export interface HiddenPreset {
  id: string;
  label: string;
  hidden: number[];
}

export const DQN_PRESETS: HiddenPreset[] = [
  { id: 'small', label: 'Small · [64]', hidden: [64] },
  { id: 'standard', label: 'Standard · [128,128]', hidden: [128, 128] },
  { id: 'wide', label: 'Wide · [256,256]', hidden: [256, 256] },
];

export interface DQNUIConfig {
  envKind: DQNEnvKind;
  gridLayoutId: string;
  arch: QArch;
  double: boolean;
  per: boolean;
  presetId: string;
  activation: Activation;
  gamma: number;
  lr: number;
  bufferSize: number;
  batch: number;
  warmup: number;
  nStep: number;
  epsStart: number;
  epsEnd: number;
  epsDecaySteps: number;
  targetMode: 'hard' | 'soft';
  targetPeriod: number;
  tau: number;
  perAlpha: number;
  huberDelta: number;
  clipNorm: number;
  learnPerStep: number; // gradient steps per collected env step
  stepsPerFrame: number; // collected env steps per animation frame
  demoSpeed: number;
  seed: number;
  loadId: number;
}

export interface DQNMetrics {
  iter: number;
  envSteps: number;
  learnSteps: number;
  episodes: number;
  meanReturn: number;
  smoothReturn: number;
  bestReturn: number;
  epsilon: number;
  tdLoss: number;
  meanQ: number;
  bufferFill: number;
  gradNorm: number;
  qStarErr: number; // GridWorld: mean |Q − Q*| over non-terminal state-actions (NaN otherwise)
  policyMatch: number; // GridWorld: fraction of cells whose greedy action == the optimal one
  returnHistory: number[];
  smoothHistory: number[];
  lossHistory: number[];
  epsHistory: number[];
  qErrHistory: number[];
}

const EMPTY: DQNMetrics = {
  iter: 0,
  envSteps: 0,
  learnSteps: 0,
  episodes: 0,
  meanReturn: NaN,
  smoothReturn: NaN,
  bestReturn: NaN,
  epsilon: NaN,
  tdLoss: NaN,
  meanQ: NaN,
  bufferFill: 0,
  gradNorm: NaN,
  qStarErr: NaN,
  policyMatch: NaN,
  returnHistory: [],
  smoothHistory: [],
  lossHistory: [],
  epsHistory: [],
  qErrHistory: [],
};

const MAX_HISTORY = 600;

export interface DQNHandle {
  agent: DQNAgent | null;
  env: Env | null;
  kind: DQNEnvKind;
  gridLayoutId: string;
}

export interface DQNDemoInfo {
  q: Float64Array | null;
  greedy: number;
  action: number;
  value: number; // max_a Q
  episodeReturn: number;
  episodeSteps: number;
  lastEpisodeReturn: number;
  episodeCount: number;
}

function emptyDemo(): DQNDemoInfo {
  return {
    q: null,
    greedy: 0,
    action: 0,
    value: 0,
    episodeReturn: 0,
    episodeSteps: 0,
    lastEpisodeReturn: NaN,
    episodeCount: 0,
  };
}

function presetHidden(id: string): number[] {
  return (DQN_PRESETS.find((p) => p.id === id) ?? DQN_PRESETS[1]).hidden;
}

// Build the engine DQNConfig from the UI config.
function toEngineConfig(c: DQNUIConfig): DQNConfig {
  return {
    gamma: c.gamma,
    lr: c.lr,
    arch: c.arch,
    double: c.double,
    per: c.per,
    hidden: presetHidden(c.presetId),
    activation: c.activation,
    bufferSize: c.bufferSize,
    batch: c.batch,
    warmup: c.warmup,
    nStep: c.nStep,
    epsStart: c.epsStart,
    epsEnd: c.epsEnd,
    epsDecaySteps: c.epsDecaySteps,
    targetMode: c.targetMode,
    targetPeriod: c.targetPeriod,
    tau: c.tau,
    perAlpha: c.perAlpha,
    perBetaStart: 0.4,
    perBetaEnd: 1,
    perBetaSteps: 20000,
    huberDelta: c.huberDelta,
    clipNorm: c.clipNorm,
    seed: c.seed,
  };
}

// Mean |Q − Q*| over all non-terminal state-actions, and the fraction of cells whose greedy action
// is optimal — the live convergence-to-ground-truth read-outs (GridWorld only).
function gridGroundTruth(agent: DQNAgent, gridLayoutId: string, gamma: number): { err: number; match: number } {
  const layout = GRID_LAYOUTS.find((l) => l.id === gridLayoutId) ?? GRID_LAYOUTS[0];
  const star = tabularQStar(layout, gamma);
  const n = layout.w * layout.h;
  let errSum = 0;
  let count = 0;
  let matched = 0;
  let cells = 0;
  for (let s = 0; s < n; s++) {
    const cell = layout.cells[s];
    if (cell === 'wall' || cell === 'goal' || cell === 'pit') continue;
    const obs = new Float64Array(n);
    obs[s] = 1;
    const q = qForward(agent.online, obs);
    let best = 0;
    let bv = q[0];
    let starMax = star.Q[s * 4];
    for (let a = 0; a < 4; a++) {
      errSum += Math.abs(q[a] - star.Q[s * 4 + a]);
      count++;
      if (q[a] > bv) {
        bv = q[a];
        best = a;
      }
      if (star.Q[s * 4 + a] > starMax) starMax = star.Q[s * 4 + a];
    }
    // The greedy action counts as optimal if it is *co-optimal* (its Q* ties the state's best),
    // not only when it equals value iteration's particular tie-break choice.
    if (star.Q[s * 4 + best] >= starMax - 1e-9) matched++;
    cells++;
  }
  return { err: count ? errSum / count : NaN, match: cells ? matched / cells : NaN };
}

export function useDQNTrainer(cfg: DQNUIConfig) {
  const agentRef = useRef<DQNAgent | null>(null);
  const trainEnvRef = useRef<Env | null>(null);
  const demoEnvRef = useRef<Env | null>(null);
  const exploreRng = useRef<() => number>(() => 0);
  const learnRng = useRef<() => number>(() => 0);
  const demoRng = useRef<() => number>(() => 0);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const iterRef = useRef(0);
  const episodesRef = useRef(0);
  const smoothRef = useRef(NaN);
  const bestRef = useRef(NaN);
  const trainEpRetRef = useRef(0);
  const lastStatsRef = useRef<{ tdLoss: number; meanQ: number; gradNorm: number }>({
    tdLoss: NaN,
    meanQ: NaN,
    gradNorm: NaN,
  });
  const demoInfoRef = useRef<DQNDemoInfo>(emptyDemo());
  const pendingWeights = useRef<number[] | null>(null);
  const pendingReturns = useRef<number[]>([]); // completed-episode returns awaiting a metrics flush
  const cfgRef = useRef(cfg);

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<DQNHandle>({
    agent: null,
    env: null,
    kind: cfg.envKind,
    gridLayoutId: cfg.gridLayoutId,
  });
  const [metrics, setMetrics] = useState<DQNMetrics>(EMPTY);

  // Keep the latest config in a ref so the always-on RAF loop and event callbacks read live values
  // without re-subscribing. Updated in an effect (not during render) per the hooks rules.
  useEffect(() => {
    cfgRef.current = cfg;
  });

  const structKey = JSON.stringify({
    envKind: cfg.envKind,
    gridLayoutId: cfg.gridLayoutId,
    arch: cfg.arch,
    double: cfg.double,
    per: cfg.per,
    presetId: cfg.presetId,
    activation: cfg.activation,
    gamma: cfg.gamma,
    bufferSize: cfg.bufferSize,
    nStep: cfg.nStep,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  const buildAll = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    const rng = mulberry32(cfg.seed ^ 0x51ed);
    const probe = makeEnv(cfg.envKind, cfg.gridLayoutId, rng, cfg.gamma);
    const agent = new DQNAgent(probe.stateDim, probe.nActions, toEngineConfig(cfg));
    agentRef.current = agent;
    exploreRng.current = mulberry32(cfg.seed ^ 0xa5a5);
    learnRng.current = mulberry32(cfg.seed ^ 0x7c7c);
    demoRng.current = mulberry32(cfg.seed ^ 0x1234);
    trainEnvRef.current = makeEnv(cfg.envKind, cfg.gridLayoutId, mulberry32(cfg.seed ^ 0x2222), cfg.gamma);
    trainEnvRef.current.reset();
    const demoEnv = makeEnv(cfg.envKind, cfg.gridLayoutId, mulberry32(cfg.seed ^ 0x3333), cfg.gamma);
    demoEnv.reset();
    demoEnvRef.current = demoEnv;
    iterRef.current = 0;
    episodesRef.current = 0;
    smoothRef.current = NaN;
    bestRef.current = NaN;
    trainEpRetRef.current = 0;
    lastStatsRef.current = { tdLoss: NaN, meanQ: NaN, gradNorm: NaN };
    demoInfoRef.current = emptyDemo();

    if (pendingWeights.current) {
      agent.importWeights(pendingWeights.current);
      pendingWeights.current = null;
    }

    setHandle({ agent, env: demoEnv, kind: cfg.envKind, gridLayoutId: cfg.gridLayoutId });
    setMetrics({ ...EMPTY });
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
  }, [buildAll]);

  // Live lr updates without a rebuild.
  useEffect(() => {
    if (agentRef.current) agentRef.current.opt.cfg.lr = cfg.lr;
  }, [cfg.lr]);

  // One iteration: collect a batch of env steps (ε-greedy) into the buffer, running `learnPerStep`
  // gradient steps after each collected step (off-policy: learning and acting are decoupled).
  const trainIter = useCallback(() => {
    const agent = agentRef.current;
    const env = trainEnvRef.current;
    if (!agent || !env) return;
    const c = cfgRef.current;
    const rng = exploreRng.current;
    const steps = Math.max(1, c.stepsPerFrame);
    let lastTdLoss = lastStatsRef.current.tdLoss;
    let lastMeanQ = lastStatsRef.current.meanQ;
    let lastGrad = lastStatsRef.current.gradNorm;

    for (let i = 0; i < steps; i++) {
      const obs = env.observe();
      const a = agent.act(obs, rng, true);
      const r = env.step(a);
      agent.observe(obs, a, r.reward, r.obs, r.terminated, r.truncated);
      trainEpRetRef.current += r.reward;
      if (r.terminated || r.truncated) {
        const ret = trainEpRetRef.current;
        trainEpRetRef.current = 0;
        episodesRef.current++;
        const prev = smoothRef.current;
        smoothRef.current = Number.isFinite(prev) ? prev * 0.95 + ret * 0.05 : ret;
        bestRef.current = Number.isFinite(bestRef.current) ? Math.max(bestRef.current, ret) : ret;
        env.reset();
        // Record the completed episode's return for the next metrics flush.
        pendingReturns.current.push(ret);
      }
      // Learn.
      for (let k = 0; k < Math.max(1, c.learnPerStep); k++) {
        const st = agent.learn(learnRng.current);
        if (st) {
          lastTdLoss = st.loss;
          lastMeanQ = st.meanQ;
          lastGrad = st.gradNorm;
        }
      }
    }
    lastStatsRef.current = { tdLoss: lastTdLoss, meanQ: lastMeanQ, gradNorm: lastGrad };
    iterRef.current++;
  }, []);

  const refreshMetrics = useCallback(() => {
    const agent = agentRef.current;
    if (!agent) return;
    const c = cfgRef.current;
    const gt =
      c.envKind === 'gridworld' ? gridGroundTruth(agent, c.gridLayoutId, c.gamma) : { err: NaN, match: NaN };
    const newReturns = pendingReturns.current;
    pendingReturns.current = [];
    setMetrics((m) => {
      const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(arr.length - MAX_HISTORY + 1) : arr.slice());
      const returnHistory = cap(m.returnHistory);
      const smoothHistory = cap(m.smoothHistory);
      const lossHistory = cap(m.lossHistory);
      const epsHistory = cap(m.epsHistory);
      const qErrHistory = cap(m.qErrHistory);
      for (const ret of newReturns) {
        returnHistory.push(ret);
        smoothHistory.push(smoothRef.current);
      }
      lossHistory.push(lastStatsRef.current.tdLoss);
      epsHistory.push(agent.epsilon());
      if (Number.isFinite(gt.err)) qErrHistory.push(gt.err);
      return {
        iter: iterRef.current,
        envSteps: agent.envSteps,
        learnSteps: agent.learnSteps,
        episodes: episodesRef.current,
        meanReturn: returnHistory.length ? returnHistory[returnHistory.length - 1] : NaN,
        smoothReturn: smoothRef.current,
        bestReturn: bestRef.current,
        epsilon: agent.epsilon(),
        tdLoss: lastStatsRef.current.tdLoss,
        meanQ: lastStatsRef.current.meanQ,
        bufferFill: agent.replay.size() / agent.replay.capacity(),
        gradNorm: lastStatsRef.current.gradNorm,
        qStarErr: gt.err,
        policyMatch: gt.match,
        returnHistory,
        smoothHistory,
        lossHistory,
        epsHistory,
        qErrHistory,
      };
    });
  }, []);

  const demoStep = useCallback(() => {
    const agent = agentRef.current;
    const env = demoEnvRef.current;
    if (!agent || !env) return;
    const info = demoInfoRef.current;
    const obs = env.observe();
    const q = qForward(agent.online, obs);
    let greedy = 0;
    let bv = q[0];
    for (let a = 1; a < q.length; a++)
      if (q[a] > bv) {
        bv = q[a];
        greedy = a;
      }
    info.q = q;
    info.greedy = greedy;
    info.action = greedy;
    info.value = bv;
    const r = env.step(greedy);
    info.episodeReturn += r.reward;
    info.episodeSteps++;
    if (r.terminated || r.truncated) {
      info.lastEpisodeReturn = info.episodeReturn;
      info.episodeCount++;
      info.episodeReturn = 0;
      info.episodeSteps = 0;
      env.reset();
    }
  }, []);

  // The single always-on RAF loop: animate the greedy demo every frame, and — while training —
  // run the collect+learn iterations, then refresh the metrics.
  useEffect(() => {
    let alive = true;
    let frames = 0;
    const frame = () => {
      if (!alive) return;
      const c = cfgRef.current;
      for (let i = 0; i < Math.max(1, c.demoSpeed); i++) demoStep();
      if (runningRef.current) {
        trainIter();
        frames++;
        if (frames % 2 === 0) refreshMetrics(); // metrics are relatively expensive (ground truth)
      }
      setTick((t) => (t + 1) % 1000000);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [demoStep, trainIter, refreshMetrics]);

  const start = useCallback(() => {
    runningRef.current = true;
    setRunning(true);
  }, []);
  const pause = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
  }, []);
  const reset = useCallback(() => buildAll(), [buildAll]);
  const stepOnce = useCallback(() => {
    trainIter();
    refreshMetrics();
    setTick((t) => t + 1);
  }, [trainIter, refreshMetrics]);
  const resetDemo = useCallback(() => {
    const env = demoEnvRef.current;
    if (env) env.reset();
    demoInfoRef.current = emptyDemo();
    setTick((t) => t + 1);
  }, []);

  const demoInfo = useCallback((): DQNDemoInfo => demoInfoRef.current, []);

  // Gradient-check the online Q-net end-to-end through the (importance-weighted) Huber TD loss on a
  // small captured minibatch — the whole learning objective, VJP proven against finite differences.
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const agent = agentRef.current;
    const env = trainEnvRef.current;
    if (!agent || !env) return null;
    const rng = mulberry32(2024);
    const B = 8;
    // Warm the buffer with a few real transitions so targets are meaningful.
    env.reset();
    for (let i = 0; i < 64; i++) {
      const obs = env.observe();
      const a = Math.floor(rng() * agent.nActions);
      const r = env.step(a);
      agent.observe(obs, a, r.reward, r.obs, r.terminated, r.truncated);
      if (r.terminated || r.truncated) env.reset();
    }
    const { items } = agent.replay.sample(B, 1, rng);
    const m = items.length;
    const sd = new Float64Array(m * agent.stateDim);
    const acts = new Int32Array(m);
    const targets = new Float64Array(m);
    const weights = new Float64Array(m).fill(1);
    for (let i = 0; i < m; i++) {
      sd.set(items[i].s, i * agent.stateDim);
      acts[i] = items[i].a;
      targets[i] = tdTarget(items[i], agent.online, agent.target, agent.cfg.double);
    }
    const statesT = Tensor.fromFlat(sd, m, agent.stateDim, false);
    return gradCheck(
      agent.online.parameters(),
      () => {
        const q = agent.online.forward(statesT);
        const qa = gatherCols(q, acts);
        return weightedHuber(qa, targets, weights, agent.cfg.huberDelta);
      },
      { samplesPerParam: 5 },
    );
  }, []);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const agent = agentRef.current;
    return { weights: agent ? agent.exportWeights() : [], step: iterRef.current };
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
    resetDemo,
    demoInfo,
    runGradCheck,
    snapshot,
    prepareLoad,
  };
}
