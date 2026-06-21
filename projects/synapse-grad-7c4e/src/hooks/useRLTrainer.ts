import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
import { gatherCols } from '../engine/ops';
import { mse } from '../engine/losses';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm } from '../engine/optim';
import { mulberry32, type Activation } from '../engine/nn';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { makeEnv, type Env, type EnvKind } from '../engine/rl-env';
import {
  Agent,
  buildAgent,
  computeTargets,
  normalizeAdvantages,
  sampleCategorical,
  argmax,
  RL_ALGOS,
  type RLAlgo,
  type EpisodeTrace,
} from '../engine/policy';

export interface RLConfig {
  envKind: EnvKind;
  gridLayoutId: string;
  algo: RLAlgo;
  presetId: string;
  activation: Activation;
  policyLr: number;
  valueLr: number;
  gamma: number;
  lambda: number;
  entCoef: number;
  batchSteps: number; // env steps collected per update
  clipNorm: number;
  normAdv: boolean;
  stepsPerFrame: number; // training updates per animation frame
  demoSpeed: number; // demo env steps per frame
  greedyDemo: boolean;
  seed: number;
  loadId: number;
}

export interface RLMetrics {
  iter: number;
  envSteps: number;
  episodes: number;
  meanReturn: number;
  smoothReturn: number;
  bestReturn: number;
  entropy: number;
  valueLoss: number;
  policyLoss: number;
  returnHistory: number[];
  smoothHistory: number[];
  entropyHistory: number[];
  valueLossHistory: number[];
}

const EMPTY: RLMetrics = {
  iter: 0,
  envSteps: 0,
  episodes: 0,
  meanReturn: NaN,
  smoothReturn: NaN,
  bestReturn: NaN,
  entropy: NaN,
  valueLoss: NaN,
  policyLoss: NaN,
  returnHistory: [],
  smoothHistory: [],
  entropyHistory: [],
  valueLossHistory: [],
};

const MAX_HISTORY = 600;

// What the views need: the agent + the live demo environment + its rolling state.
export interface RLHandle {
  agent: Agent | null;
  env: Env | null; // the demo (animated) environment
  kind: EnvKind;
  gridLayoutId: string;
}

export interface DemoInfo {
  probs: Float64Array | null;
  value: number;
  action: number;
  episodeReturn: number;
  episodeSteps: number;
  lastEpisodeReturn: number;
  episodeCount: number;
}

export function useRLTrainer(cfg: RLConfig) {
  const agentRef = useRef<Agent | null>(null);
  const pOptRef = useRef<Optimizer | null>(null);
  const vOptRef = useRef<Optimizer | null>(null);
  const trainEnvRef = useRef<Env | null>(null);
  const demoEnvRef = useRef<Env | null>(null);
  const trainRng = useRef<() => number>(() => 0);
  const demoRng = useRef<() => number>(() => 0);
  const iterRef = useRef(0);
  const envStepRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const smoothRef = useRef(NaN);
  const bestRef = useRef(NaN);
  const pendingWeights = useRef<number[] | null>(null);
  const pendingStep = useRef(0);

  // Live demo rollout bookkeeping (mutated outside React state for smooth animation).
  const demoInfoRef = useRef<DemoInfo>({
    probs: null,
    value: 0,
    action: 0,
    episodeReturn: 0,
    episodeSteps: 0,
    lastEpisodeReturn: NaN,
    episodeCount: 0,
  });

  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [handle, setHandle] = useState<RLHandle>({
    agent: null,
    env: null,
    kind: cfg.envKind,
    gridLayoutId: cfg.gridLayoutId,
  });
  const [metrics, setMetrics] = useState<RLMetrics>(EMPTY);

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const structKey = JSON.stringify({
    envKind: cfg.envKind,
    gridLayoutId: cfg.gridLayoutId,
    presetId: cfg.presetId,
    activation: cfg.activation,
    seed: cfg.seed,
    loadId: cfg.loadId,
  });

  const buildAll = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    const rng = mulberry32(cfg.seed ^ 0x51ed);
    const agent = buildAgent(
      cfg.envKind === 'gridworld' ? makeEnv('gridworld', cfg.gridLayoutId, rng).stateDim : 4,
      cfg.envKind === 'gridworld' ? 4 : 2,
      cfg.presetId,
      cfg.activation,
      cfg.seed,
    );
    agentRef.current = agent;
    pOptRef.current = new Optimizer(agent.policy.parameters(), defaultOptimizer('adam', cfg.policyLr));
    vOptRef.current = new Optimizer(agent.critic.parameters(), defaultOptimizer('adam', cfg.valueLr));
    trainRng.current = mulberry32(cfg.seed ^ 0xa5a5);
    demoRng.current = mulberry32(cfg.seed ^ 0x1234);
    trainEnvRef.current = makeEnv(cfg.envKind, cfg.gridLayoutId, mulberry32(cfg.seed ^ 0x2222));
    const demoEnv = makeEnv(cfg.envKind, cfg.gridLayoutId, mulberry32(cfg.seed ^ 0x3333));
    demoEnv.reset();
    demoEnvRef.current = demoEnv;
    iterRef.current = 0;
    envStepRef.current = 0;
    smoothRef.current = NaN;
    bestRef.current = NaN;
    demoInfoRef.current = {
      probs: null,
      value: 0,
      action: 0,
      episodeReturn: 0,
      episodeSteps: 0,
      lastEpisodeReturn: NaN,
      episodeCount: 0,
    };

    if (pendingWeights.current) {
      if (agent.importWeights(pendingWeights.current)) iterRef.current = pendingStep.current;
      pendingWeights.current = null;
    }

    setHandle({ agent, env: demoEnv, kind: cfg.envKind, gridLayoutId: cfg.gridLayoutId });
    setMetrics({ ...EMPTY, iter: iterRef.current });
    setTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.envKind, cfg.gridLayoutId, cfg.presetId, cfg.activation, cfg.seed]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  // Live optimizer-lr updates without a rebuild.
  useEffect(() => {
    if (pOptRef.current) pOptRef.current.cfg.lr = cfg.policyLr;
    if (vOptRef.current) vOptRef.current.cfg.lr = cfg.valueLr;
  }, [cfg.policyLr, cfg.valueLr]);

  // One training iteration: roll out a batch of complete episodes with the current stochastic
  // policy, compute per-step returns/advantages, then take a single policy-gradient step (and a
  // value-regression step for the critic-based algorithms). Returns the batch statistics.
  const trainIter = useCallback(() => {
    const agent = agentRef.current;
    const pOpt = pOptRef.current;
    const vOpt = vOptRef.current;
    const env = trainEnvRef.current;
    const rng = trainRng.current;
    if (!agent || !pOpt || !vOpt || !env) return undefined;
    const c = cfgRef.current;
    const usesCritic = RL_ALGOS.find((a) => a.id === c.algo)!.usesCritic;

    const states: Float64Array[] = [];
    const actions: number[] = [];
    const advAll: number[] = [];
    const retAll: number[] = [];
    const epReturns: number[] = [];
    let collected = 0;

    while (collected < c.batchSteps) {
      env.reset();
      const ep: EpisodeTrace = { rewards: [], values: [], bootstrap: 0 };
      const epS: Float64Array[] = [];
      const epA: number[] = [];
      let epRet = 0;
      let obs = env.observe();
      for (;;) {
        const probs = agent.actionProbs(obs);
        const a = sampleCategorical(probs, rng);
        const v = usesCritic ? agent.valueOf(obs) : 0;
        const r = env.step(a);
        epS.push(obs);
        epA.push(a);
        ep.rewards.push(r.reward);
        ep.values.push(v);
        epRet += r.reward;
        collected++;
        obs = r.obs;
        if (r.terminated || r.truncated) {
          ep.bootstrap = r.truncated && !r.terminated && usesCritic ? agent.valueOf(obs) : 0;
          break;
        }
      }
      const { adv, ret } = computeTargets(ep, c.gamma, c.lambda, c.algo);
      for (let i = 0; i < adv.length; i++) {
        states.push(epS[i]);
        actions.push(epA[i]);
        advAll.push(adv[i]);
        retAll.push(ret[i]);
      }
      epReturns.push(epRet);
    }

    if (c.normAdv) normalizeAdvantages(advAll);
    const B = states.length;
    const sd = new Float64Array(B * agent.stateDim);
    for (let i = 0; i < B; i++) sd.set(states[i], i * agent.stateDim);
    const statesT = Tensor.fromFlat(sd, B, agent.stateDim, false);
    const actionsI = Int32Array.from(actions);
    const advT = Tensor.fromFlat(Float64Array.from(advAll), B, 1, false);

    // Policy-gradient step: minimize −E[Â·logπ(a|s)] − entCoef·H(π).
    pOpt.zeroGrad();
    const logits = agent.policyLogits(statesT);
    const logp = gatherCols(logits.logSoftmax(), actionsI);
    const pg = logp.mul(advT).meanAll().neg();
    const ent = logits.softmax().mul(logits.logSoftmax()).sumAll().scale(-1 / B);
    const policyLoss = pg.add(ent.scale(-c.entCoef));
    policyLoss.backward();
    clipGradGlobalNorm(agent.policy.parameters(), c.clipNorm);
    pOpt.step();

    // Critic step: regress V(s) onto the return targets.
    let valueLoss = NaN;
    if (usesCritic) {
      vOpt.zeroGrad();
      const values = agent.values(statesT);
      const retT = Tensor.fromFlat(Float64Array.from(retAll), B, 1, false);
      const vloss = mse(values, retT);
      vloss.backward();
      clipGradGlobalNorm(agent.critic.parameters(), c.clipNorm);
      vOpt.step();
      valueLoss = vloss.data[0];
    }

    iterRef.current++;
    envStepRef.current += collected;
    const meanReturn = epReturns.reduce((a, b) => a + b, 0) / epReturns.length;
    return {
      meanReturn,
      episodes: epReturns.length,
      entropy: ent.data[0],
      policyLoss: policyLoss.data[0],
      valueLoss,
    };
  }, []);

  // Advance the demo environment one step with the current policy, for the live animation.
  const demoStep = useCallback(() => {
    const agent = agentRef.current;
    const env = demoEnvRef.current;
    if (!agent || !env) return;
    const c = cfgRef.current;
    const info = demoInfoRef.current;
    const obs = env.observe();
    const probs = agent.actionProbs(obs);
    const action = c.greedyDemo ? argmax(probs) : sampleCategorical(probs, demoRng.current);
    const value = agent.valueOf(obs);
    const r = env.step(action);
    info.probs = probs;
    info.value = value;
    info.action = action;
    info.episodeReturn += r.reward;
    info.episodeSteps += 1;
    if (r.terminated || r.truncated) {
      info.lastEpisodeReturn = info.episodeReturn;
      info.episodeCount += 1;
      info.episodeReturn = 0;
      info.episodeSteps = 0;
      env.reset();
    }
  }, []);

  const pushMetrics = useCallback((last: ReturnType<typeof trainIter>) => {
    if (!last) return;
    const prevSmooth = smoothRef.current;
    const smooth = Number.isFinite(prevSmooth) ? prevSmooth * 0.9 + last.meanReturn * 0.1 : last.meanReturn;
    smoothRef.current = smooth;
    const best = Number.isFinite(bestRef.current) ? Math.max(bestRef.current, last.meanReturn) : last.meanReturn;
    bestRef.current = best;
    setMetrics((m) => {
      const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
      const returnHistory = cap(m.returnHistory);
      const smoothHistory = cap(m.smoothHistory);
      const entropyHistory = cap(m.entropyHistory);
      const valueLossHistory = cap(m.valueLossHistory);
      returnHistory.push(last.meanReturn);
      smoothHistory.push(smooth);
      entropyHistory.push(last.entropy);
      valueLossHistory.push(last.valueLoss);
      return {
        iter: iterRef.current,
        envSteps: envStepRef.current,
        episodes: last.episodes,
        meanReturn: last.meanReturn,
        smoothReturn: smooth,
        bestReturn: best,
        entropy: last.entropy,
        valueLoss: last.valueLoss,
        policyLoss: last.policyLoss,
        returnHistory,
        smoothHistory,
        entropyHistory,
        valueLossHistory,
      };
    });
  }, []);

  // A single always-on animation loop: it advances the demo env every frame so you can always
  // watch the current policy act, and — while training is on — runs the configured number of
  // policy-gradient updates too.
  useEffect(() => {
    let alive = true;
    const frame = () => {
      if (!alive) return;
      const c = cfgRef.current;
      for (let i = 0; i < Math.max(1, c.demoSpeed); i++) demoStep();
      if (runningRef.current) {
        let last: ReturnType<typeof trainIter> = undefined;
        for (let i = 0; i < c.stepsPerFrame; i++) last = trainIter();
        pushMetrics(last);
      }
      setTick((t) => (t + 1) % 1000000);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [demoStep, trainIter, pushMetrics]);

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
    const last = trainIter();
    pushMetrics(last);
    setTick((t) => t + 1);
  }, [trainIter, pushMetrics]);
  const resetDemo = useCallback(() => {
    const env = demoEnvRef.current;
    if (env) env.reset();
    demoInfoRef.current = {
      probs: null,
      value: 0,
      action: 0,
      episodeReturn: 0,
      episodeSteps: 0,
      lastEpisodeReturn: NaN,
      episodeCount: 0,
    };
    setTick((t) => t + 1);
  }, []);

  const demoInfo = useCallback((): DemoInfo => demoInfoRef.current, []);

  // Gradient-check the whole policy through the REINFORCE objective on a small captured batch.
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const agent = agentRef.current;
    const env = trainEnvRef.current;
    if (!agent || !env) return null;
    const rng = mulberry32(99);
    const B = 8;
    const sd = new Float64Array(B * agent.stateDim);
    const acts = new Int32Array(B);
    const advd = new Float64Array(B);
    env.reset();
    let obs = env.observe();
    for (let i = 0; i < B; i++) {
      sd.set(obs, i * agent.stateDim);
      const probs = agent.actionProbs(obs);
      const a = sampleCategorical(probs, rng);
      acts[i] = a;
      advd[i] = rng() * 2 - 1;
      const r = env.step(a);
      obs = r.terminated || r.truncated ? (env.reset(), env.observe()) : r.obs;
    }
    const statesT = Tensor.fromFlat(sd, B, agent.stateDim, false);
    const advT = Tensor.fromFlat(advd, B, 1, false);
    return gradCheck(
      agent.policy.parameters(),
      () => {
        const logits = agent.policyLogits(statesT);
        const logp = gatherCols(logits.logSoftmax(), acts);
        const pg = logp.mul(advT).meanAll().neg();
        const ent = logits.softmax().mul(logits.logSoftmax()).sumAll().scale(-1 / B);
        return pg.add(ent.scale(-0.01));
      },
      { samplesPerParam: 5 },
    );
  }, []);

  const snapshot = useCallback((): { weights: number[]; step: number } => {
    const agent = agentRef.current;
    return { weights: agent ? agent.exportWeights() : [], step: iterRef.current };
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
    resetDemo,
    demoInfo,
    runGradCheck,
    snapshot,
    prepareLoad,
  };
}
