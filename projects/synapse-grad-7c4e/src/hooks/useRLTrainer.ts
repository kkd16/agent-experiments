import { useCallback, useEffect, useRef, useState } from 'react';
import { Tensor } from '../engine/tensor';
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
  sampleGaussian,
  gaussianLogProb,
  gaussianLogProbNumeric,
  gaussianEntropy,
  categoricalLogProb,
  categoricalEntropy,
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
  // PPO-specific knobs (ignored by the other algorithms).
  ppoClip: number; // surrogate clip ε
  ppoEpochs: number; // optimization passes over each collected batch
  minibatch: number; // SGD minibatch size within each epoch
  targetKL: number; // early-stop the epochs if mean KL exceeds this (0 = off)
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
  clipFrac: number; // PPO: fraction of samples outside the trust region
  approxKL: number; // PPO: mean KL(π_old ‖ π) over the batch (Schulman k3 estimator)
  explainedVar: number; // critic quality: 1 − Var(ret − V)/Var(ret)
  stdMean: number; // continuous: mean action standard deviation (NaN for discrete)
  returnHistory: number[];
  smoothHistory: number[];
  entropyHistory: number[];
  valueLossHistory: number[];
  returnDist: number[]; // most recent batch's per-episode returns (for the histogram)
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
  clipFrac: NaN,
  approxKL: NaN,
  explainedVar: NaN,
  stdMean: NaN,
  returnHistory: [],
  smoothHistory: [],
  entropyHistory: [],
  valueLossHistory: [],
  returnDist: [],
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
  probs: Float64Array | null; // discrete: π(a|s)
  continuous: boolean;
  mean: Float64Array | null; // continuous: Gaussian mean
  std: Float64Array | null; // continuous: Gaussian σ
  actionVec: Float64Array | null; // continuous: the action actually taken
  value: number;
  action: number; // discrete action index (continuous: 0)
  episodeReturn: number;
  episodeSteps: number;
  lastEpisodeReturn: number;
  episodeCount: number;
}

function emptyDemo(continuous: boolean): DemoInfo {
  return {
    probs: null,
    continuous,
    mean: null,
    std: null,
    actionVec: null,
    value: 0,
    action: 0,
    episodeReturn: 0,
    episodeSteps: 0,
    lastEpisodeReturn: NaN,
    episodeCount: 0,
  };
}

// Population variance of an array, used for explained-variance.
function variance(arr: number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  let mean = 0;
  for (const v of arr) mean += v;
  mean /= n;
  let s = 0;
  for (const v of arr) s += (v - mean) * (v - mean);
  return s / n;
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
  const demoInfoRef = useRef<DemoInfo>(emptyDemo(false));

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
    // Probe the environment for its dimensions and action space so the agent matches it exactly.
    const probe = makeEnv(cfg.envKind, cfg.gridLayoutId, rng, cfg.gamma);
    const agent = buildAgent(
      probe.stateDim,
      probe.continuous ? probe.actDim : probe.nActions,
      cfg.presetId,
      cfg.activation,
      cfg.seed,
      probe.continuous,
    );
    agentRef.current = agent;
    pOptRef.current = new Optimizer(agent.policyParams(), defaultOptimizer('adam', cfg.policyLr));
    vOptRef.current = new Optimizer(agent.critic.parameters(), defaultOptimizer('adam', cfg.valueLr));
    trainRng.current = mulberry32(cfg.seed ^ 0xa5a5);
    demoRng.current = mulberry32(cfg.seed ^ 0x1234);
    trainEnvRef.current = makeEnv(cfg.envKind, cfg.gridLayoutId, mulberry32(cfg.seed ^ 0x2222), cfg.gamma);
    const demoEnv = makeEnv(cfg.envKind, cfg.gridLayoutId, mulberry32(cfg.seed ^ 0x3333), cfg.gamma);
    demoEnv.reset();
    demoEnvRef.current = demoEnv;
    iterRef.current = 0;
    envStepRef.current = 0;
    smoothRef.current = NaN;
    bestRef.current = NaN;
    demoInfoRef.current = emptyDemo(probe.continuous);

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
  // policy, compute per-step returns/advantages, then update. REINFORCE/baseline/A2C take a single
  // full-batch policy-gradient step; PPO runs several epochs of clipped-surrogate minibatch SGD over
  // the same data. Works for both the categorical (discrete) and diagonal-Gaussian (continuous)
  // policies. Returns the batch statistics.
  const trainIter = useCallback(() => {
    const agent = agentRef.current;
    const pOpt = pOptRef.current;
    const vOpt = vOptRef.current;
    const env = trainEnvRef.current;
    const rng = trainRng.current;
    if (!agent || !pOpt || !vOpt || !env) return undefined;
    const c = cfgRef.current;
    const meta = RL_ALGOS.find((a) => a.id === c.algo)!;
    const usesCritic = meta.usesCritic;
    const isPPO = c.algo === 'ppo';
    const cont = agent.continuous;
    const A = agent.actDim;

    const states: Float64Array[] = [];
    const actionsI: number[] = []; // discrete action indices
    const actionsC: number[] = []; // continuous actions, flattened [B*A]
    const oldLogp: number[] = [];
    const advAll: number[] = [];
    const retAll: number[] = [];
    const valAll: number[] = [];
    const epReturns: number[] = [];
    let collected = 0;

    while (collected < c.batchSteps) {
      env.reset();
      const ep: EpisodeTrace = { rewards: [], values: [], bootstrap: 0 };
      const epS: Float64Array[] = [];
      let epRet = 0;
      let obs = env.observe();
      for (;;) {
        const v = usesCritic ? agent.valueOf(obs) : 0;
        let r;
        if (cont) {
          const mean = agent.actionMean(obs);
          const logStd = agent.logStd!.data;
          const a = sampleGaussian(mean, logStd, rng);
          oldLogp.push(gaussianLogProbNumeric(mean, logStd, a));
          for (let d = 0; d < A; d++) actionsC.push(a[d]);
          r = env.step(a);
        } else {
          const probs = agent.actionProbs(obs);
          const a = sampleCategorical(probs, rng);
          oldLogp.push(Math.log(Math.max(probs[a], 1e-12)));
          actionsI.push(a);
          r = env.step(a);
        }
        epS.push(obs);
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
        advAll.push(adv[i]);
        retAll.push(ret[i]);
        valAll.push(ep.values[i]);
      }
      epReturns.push(epRet);
    }

    if (c.normAdv) normalizeAdvantages(advAll);
    const B = states.length;

    // Pack the whole batch into flat tensors once; minibatches index into them.
    const sdAll = new Float64Array(B * agent.stateDim);
    for (let i = 0; i < B; i++) sdAll.set(states[i], i * agent.stateDim);

    // Build the differentiable per-sample log-prob and the policy entropy for a set of row indices.
    const buildLogp = (idx: number[]) => {
      const m = idx.length;
      const sd = new Float64Array(m * agent.stateDim);
      for (let i = 0; i < m; i++) sd.set(states[idx[i]], i * agent.stateDim);
      const statesT = Tensor.fromFlat(sd, m, agent.stateDim, false);
      const out = agent.policyLogits(statesT); // logits (discrete) or means (continuous)
      let logp: Tensor;
      let ent: Tensor;
      if (cont) {
        const acts = new Float64Array(m * A);
        for (let i = 0; i < m; i++) for (let d = 0; d < A; d++) acts[i * A + d] = actionsC[idx[i] * A + d];
        const actsT = Tensor.fromFlat(acts, m, A, false);
        logp = gaussianLogProb(out, agent.logStd!, actsT);
        ent = gaussianEntropy(agent.logStd!);
      } else {
        const acts = new Int32Array(m);
        for (let i = 0; i < m; i++) acts[i] = actionsI[idx[i]];
        logp = categoricalLogProb(out, acts);
        ent = categoricalEntropy(out);
      }
      return { statesT, logp, ent };
    };

    // A single policy(+critic) update over a set of row indices. `clip > 0` selects the PPO
    // clipped-surrogate objective; otherwise the vanilla score-function objective −E[Â·logπ].
    const update = (idx: number[], clip: number) => {
      const m = idx.length;
      const advd = new Float64Array(m);
      for (let i = 0; i < m; i++) advd[i] = advAll[idx[i]];
      pOpt.zeroGrad();
      const { statesT, logp, ent } = buildLogp(idx);

      let surrogate: Tensor;
      let clipped = 0;
      let kl = 0;
      if (clip > 0) {
        const oldd = new Float64Array(m);
        for (let i = 0; i < m; i++) oldd[i] = oldLogp[idx[i]];
        const oldT = Tensor.fromFlat(oldd, m, 1, false);
        const logratio = logp.sub(oldT); // [m,1]
        const ratio = logratio.exp(); // [m,1]
        // Decide, per sample, whether the unclipped branch wins the min (so its gradient flows).
        const activeAdv = new Float64Array(m);
        for (let i = 0; i < m; i++) {
          const r = ratio.data[i];
          const a = advd[i];
          const surr1 = r * a;
          const cr = Math.max(1 - clip, Math.min(1 + clip, r));
          const surr2 = cr * a;
          activeAdv[i] = surr1 <= surr2 ? a : 0; // clipped samples contribute zero gradient
          if (Math.abs(r - 1) > clip) clipped++;
          const lr = logratio.data[i];
          kl += r - 1 - lr; // Schulman k3 KL estimator (always ≥ 0)
        }
        const activeT = Tensor.fromFlat(activeAdv, m, 1, false);
        surrogate = ratio.mul(activeT).meanAll().neg();
        kl /= m;
      } else {
        const advT = Tensor.fromFlat(advd, m, 1, false);
        surrogate = logp.mul(advT).meanAll().neg();
      }

      const policyLoss = surrogate.add(ent.scale(-c.entCoef));
      policyLoss.backward();
      clipGradGlobalNorm(agent.policyParams(), c.clipNorm);
      pOpt.step();

      let valueLoss = NaN;
      if (usesCritic) {
        vOpt.zeroGrad();
        const retd = new Float64Array(m);
        for (let i = 0; i < m; i++) retd[i] = retAll[idx[i]];
        const values = agent.values(statesT);
        const vloss = mse(values, Tensor.fromFlat(retd, m, 1, false));
        vloss.backward();
        clipGradGlobalNorm(agent.critic.parameters(), c.clipNorm);
        vOpt.step();
        valueLoss = vloss.data[0];
      }
      return { policyLoss: policyLoss.data[0], entropy: ent.data[0], valueLoss, clipFrac: clipped / m, approxKL: kl };
    };

    const order = Array.from({ length: B }, (_, i) => i);
    let lastPolicyLoss = NaN;
    let lastEntropy = NaN;
    let lastValueLoss = NaN;
    let clipFracAcc = 0;
    let klAcc = 0;
    let updates = 0;
    if (isPPO) {
      const mb = Math.max(32, Math.min(c.minibatch, B));
      outer: for (let ep = 0; ep < c.ppoEpochs; ep++) {
        // Fisher–Yates shuffle so each epoch sees fresh minibatches.
        for (let i = B - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          const t = order[i];
          order[i] = order[j];
          order[j] = t;
        }
        for (let s = 0; s < B; s += mb) {
          const idx = order.slice(s, Math.min(s + mb, B));
          const r = update(idx, c.ppoClip);
          lastPolicyLoss = r.policyLoss;
          lastEntropy = r.entropy;
          lastValueLoss = r.valueLoss;
          clipFracAcc += r.clipFrac;
          klAcc += r.approxKL;
          updates++;
        }
        // Early-stop the remaining epochs if the policy has already moved too far (trust region).
        if (c.targetKL > 0 && updates > 0 && klAcc / updates > c.targetKL) break outer;
      }
    } else {
      const r = update(order, 0);
      lastPolicyLoss = r.policyLoss;
      lastEntropy = r.entropy;
      lastValueLoss = r.valueLoss;
      updates = 1;
    }

    iterRef.current++;
    envStepRef.current += collected;
    const meanReturn = epReturns.reduce((a, b) => a + b, 0) / epReturns.length;
    const explainedVar = usesCritic ? explainedVariance(retAll, valAll) : NaN;
    return {
      meanReturn,
      episodes: epReturns.length,
      entropy: lastEntropy,
      policyLoss: lastPolicyLoss,
      valueLoss: lastValueLoss,
      clipFrac: isPPO ? clipFracAcc / Math.max(1, updates) : NaN,
      approxKL: isPPO ? klAcc / Math.max(1, updates) : NaN,
      explainedVar,
      stdMean: cont ? mean(agent.stdVec()) : NaN,
      returnDist: epReturns.slice(),
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
    const value = agent.valueOf(obs);
    let r;
    if (agent.continuous) {
      const mean = agent.actionMean(obs);
      const std = agent.stdVec();
      const a = c.greedyDemo ? mean : sampleGaussian(mean, agent.logStd!.data, demoRng.current);
      info.mean = mean;
      info.std = std;
      info.actionVec = a;
      info.probs = null;
      info.action = 0;
      r = env.step(a);
    } else {
      const probs = agent.actionProbs(obs);
      const action = c.greedyDemo ? argmax(probs) : sampleCategorical(probs, demoRng.current);
      info.probs = probs;
      info.action = action;
      info.mean = null;
      info.std = null;
      info.actionVec = null;
      r = env.step(action);
    }
    info.value = value;
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
        clipFrac: last.clipFrac,
        approxKL: last.approxKL,
        explainedVar: last.explainedVar,
        stdMean: last.stdMean,
        returnHistory,
        smoothHistory,
        entropyHistory,
        valueLossHistory,
        returnDist: last.returnDist,
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
    const agent = agentRef.current;
    if (env) env.reset();
    demoInfoRef.current = emptyDemo(agent ? agent.continuous : false);
    setTick((t) => t + 1);
  }, []);

  const demoInfo = useCallback((): DemoInfo => demoInfoRef.current, []);

  // Gradient-check the whole policy through its policy-gradient objective on a small captured batch
  // — categorical (logSoftmax + gatherCols) or diagonal-Gaussian (gaussianLogProb), as appropriate.
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const agent = agentRef.current;
    const env = trainEnvRef.current;
    if (!agent || !env) return null;
    const rng = mulberry32(99);
    const B = 8;
    const A = agent.actDim;
    const sd = new Float64Array(B * agent.stateDim);
    const advd = new Float64Array(B);
    const actsI = new Int32Array(B);
    const actsC = new Float64Array(B * Math.max(1, A));
    env.reset();
    let obs = env.observe();
    for (let i = 0; i < B; i++) {
      sd.set(obs, i * agent.stateDim);
      advd[i] = rng() * 2 - 1;
      let r;
      if (agent.continuous) {
        const mean = agent.actionMean(obs);
        const a = sampleGaussian(mean, agent.logStd!.data, rng);
        for (let d = 0; d < A; d++) actsC[i * A + d] = a[d];
        r = env.step(a);
      } else {
        const probs = agent.actionProbs(obs);
        const a = sampleCategorical(probs, rng);
        actsI[i] = a;
        r = env.step(a);
      }
      obs = r.terminated || r.truncated ? (env.reset(), env.observe()) : r.obs;
    }
    const statesT = Tensor.fromFlat(sd, B, agent.stateDim, false);
    const advT = Tensor.fromFlat(advd, B, 1, false);
    const actsCT = agent.continuous ? Tensor.fromFlat(actsC, B, A, false) : null;
    return gradCheck(
      agent.policyParams(),
      () => {
        const out = agent.policyLogits(statesT);
        let logp: Tensor;
        let ent: Tensor;
        if (agent.continuous) {
          logp = gaussianLogProb(out, agent.logStd!, actsCT!);
          ent = gaussianEntropy(agent.logStd!);
        } else {
          logp = categoricalLogProb(out, actsI);
          ent = categoricalEntropy(out);
        }
        const pg = logp.mul(advT).meanAll().neg();
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

function mean(arr: Float64Array): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : NaN;
}

// 1 − Var(returns − values)/Var(returns): how much of the return's variance the critic explains.
function explainedVariance(ret: number[], val: number[]): number {
  const vr = variance(ret);
  if (vr < 1e-12) return NaN;
  const resid = ret.map((r, i) => r - val[i]);
  return 1 - variance(resid) / vr;
}
