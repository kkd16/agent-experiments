// The reinforcement-learning agent: a stochastic categorical policy and a state-value critic,
// both ordinary MLPs from `nn.ts` (so they reuse the same autograd engine, optimizers, schedules,
// gradient clipping, gradient-check and save/share as every other lab). The policy maps a state
// to per-action logits; sampling from its softmax gives the action and its log-probability — the
// quantity the policy-gradient theorem differentiates. The critic estimates V(s) for the
// baseline / GAE advantage. Nothing here is a black box: the only new differentiable pieces RL
// needs are `logSoftmax` and `gatherCols`, both hand-derived and in the engine self-test.

import { Tensor } from './tensor';
import { gatherCols } from './ops';
import { MLP, mulberry32, type Activation, type LayerSpec } from './nn';

export type RLAlgo = 'reinforce' | 'baseline' | 'a2c' | 'ppo';

export const RL_ALGOS: { id: RLAlgo; label: string; usesCritic: boolean; usesGae: boolean }[] = [
  { id: 'reinforce', label: 'REINFORCE', usesCritic: false, usesGae: false },
  { id: 'baseline', label: 'REINFORCE + baseline', usesCritic: true, usesGae: false },
  { id: 'a2c', label: 'Advantage Actor–Critic (GAE)', usesCritic: true, usesGae: true },
  { id: 'ppo', label: 'PPO (clipped, GAE)', usesCritic: true, usesGae: true },
];

const LOG_2PI = Math.log(2 * Math.PI);
const HALF_LOG_2PI_E = 0.5 * Math.log(2 * Math.PI * Math.E);

export interface RLPreset {
  id: string;
  label: string;
  hidden: number[];
}

export const RL_PRESETS: RLPreset[] = [
  { id: 'tiny', label: 'Tiny · [32]', hidden: [32] },
  { id: 'standard', label: 'Standard · [64, 64]', hidden: [64, 64] },
  { id: 'wide', label: 'Wide · [128, 128]', hidden: [128, 128] },
  { id: 'deep', label: 'Deep · [64, 64, 64]', hidden: [64, 64, 64] },
];

function hiddenSpec(hidden: number[], act: Activation): LayerSpec[] {
  return hidden.map((units) => ({ units, activation: act }));
}

// Bundles the two networks and the few utilities the trainer needs. Weight export/import
// concatenates policy (then the continuous policy's log-σ vector) then critic so a single flat
// vector round-trips through save/share.
//
// The agent serves two action spaces from the same engine:
//   • discrete   — the policy MLP emits per-action logits; the distribution is a softmax and the
//                  score function differentiates logSoftmax + gatherCols (the original RL lab).
//   • continuous — the policy MLP emits the mean of a diagonal Gaussian and a *separate* learnable
//                  log-σ vector (state-independent, the standard PPO/A2C parameterization) gives the
//                  spread; the score function differentiates the Gaussian log-density (gaussianLogProb
//                  below, which sums a per-dimension log-density with rowSum). Both are hand-derived
//                  and gradchecked end-to-end in the engine self-test.
export class Agent {
  policy: MLP;
  critic: MLP;
  readonly stateDim: number;
  readonly nActions: number; // categorical action count (discrete) or action dimension (continuous)
  readonly continuous: boolean;
  readonly actDim: number; // continuous action dimension (0 for discrete)
  logStd: Tensor | null; // [1, actDim] learnable log standard deviation (continuous only)

  constructor(
    stateDim: number,
    nActions: number,
    hidden: number[],
    act: Activation,
    rng: () => number,
    continuous = false,
  ) {
    this.stateDim = stateDim;
    this.nActions = nActions;
    this.continuous = continuous;
    this.actDim = continuous ? nActions : 0;
    const outDim = continuous ? nActions : nActions; // mean per dim (continuous) or logit per action
    this.policy = new MLP(stateDim, hiddenSpec(hidden, act), outDim, rng);
    this.critic = new MLP(stateDim, hiddenSpec(hidden, act), 1, rng);
    // Start the Gaussian fairly exploratory: σ ≈ exp(-0.5) ≈ 0.61.
    this.logStd = continuous ? Tensor.fromFlat(new Float64Array(nActions).fill(-0.5), 1, nActions, true).named('logσ') : null;
  }

  // Forward a batch of observations [B, stateDim] through the policy → logits/means [B, out].
  policyLogits(obs: Tensor): Tensor {
    return this.policy.forward(obs);
  }

  // The parameters the policy optimizer trains: the policy MLP plus (continuous) the log-σ vector.
  policyParams(): Tensor[] {
    return this.continuous ? [...this.policy.parameters(), this.logStd!] : this.policy.parameters();
  }

  // Forward a batch of observations through the critic → values [B, 1].
  values(obs: Tensor): Tensor {
    return this.critic.forward(obs);
  }

  // Action distribution for a single observation, computed without building a tape (the hot path
  // during environment rollout). Returns the softmax probabilities over actions (discrete only).
  actionProbs(obs: Float64Array): Float64Array {
    const logits = forwardNumeric(this.policy, obs);
    return softmaxInPlace(logits);
  }

  // The Gaussian mean for a single observation, tape-free (continuous only).
  actionMean(obs: Float64Array): Float64Array {
    return forwardNumeric(this.policy, obs);
  }

  // The current standard-deviation vector σ = exp(log σ) (continuous only).
  stdVec(): Float64Array {
    const ls = this.logStd!.data;
    const out = new Float64Array(ls.length);
    for (let i = 0; i < ls.length; i++) out[i] = Math.exp(ls[i]);
    return out;
  }

  // V(s) for a single observation, tape-free.
  valueOf(obs: Float64Array): number {
    return forwardNumeric(this.critic, obs)[0];
  }

  paramCount(): number {
    return this.policy.paramCount() + (this.continuous ? this.actDim : 0) + this.critic.paramCount();
  }

  exportWeights(): number[] {
    const head = this.continuous ? Array.from(this.logStd!.data) : [];
    return [...this.policy.exportWeights(), ...head, ...this.critic.exportWeights()];
  }

  importWeights(flat: number[]): boolean {
    const pn = this.policy.paramCount();
    const ln = this.continuous ? this.actDim : 0;
    const cn = this.critic.paramCount();
    if (flat.length !== pn + ln + cn) return false;
    if (!this.policy.importWeights(flat.slice(0, pn))) return false;
    if (this.continuous) this.logStd!.data.set(flat.slice(pn, pn + ln));
    return this.critic.importWeights(flat.slice(pn + ln));
  }
}

// ---- diagonal-Gaussian policy (continuous control) ------------------------------------------
//
// All three pieces below are hand-derived and gradchecked. The log-density of a diagonal Gaussian
// at action a, with mean μ and (per-dimension) standard deviation σ = exp(logσ), summed over the
// action dimensions, is
//   log π(a|s) = Σ_d [ −½·((a_d − μ_d)/σ_d)² − logσ_d − ½·log(2π) ].
// It is assembled entirely from existing engine ops (sub, mul, exp, scale, rowSum), so the tape
// differentiates it w.r.t. both the network's μ output *and* the learnable logσ.

// Differentiable joint log-prob [B,1] of actions [B,A] under N(mu [B,A], diag(exp(logStd)²)),
// where logStd is the shared [1,A] parameter (row-broadcast across the batch).
export function gaussianLogProb(mu: Tensor, logStd: Tensor, actions: Tensor): Tensor {
  const A = mu.cols;
  const invStd = logStd.neg().exp(); // [1,A] = 1/σ
  const z = actions.sub(mu).mul(invStd); // [B,A] standardized residual
  // per-dim log-density = −½ z² − logStd − ½ log(2π)
  const perDim = z.mul(z).scale(-0.5).sub(logStd); // [B,A] (the −½log2π constant added after the sum)
  const sum = perDim.rowSum(); // [B,1]
  const c = Tensor.fromFlat(new Float64Array([(-0.5 * LOG_2PI * A)]), 1, 1, false);
  return sum.add(c); // [B,1] broadcast constant
}

// Differentiable scalar entropy [1,1] of the diagonal Gaussian: H = Σ_d (logσ_d + ½·log(2πe)).
// (State-independent here, so it is a pure function of the shared logStd vector.)
export function gaussianEntropy(logStd: Tensor): Tensor {
  const A = logStd.cols;
  const c = Tensor.fromFlat(new Float64Array([HALF_LOG_2PI_E * A]), 1, 1, false);
  return logStd.sumAll().add(c);
}

// Tape-free Gaussian log-prob of a single action (used to record the behavior log-prob at rollout
// time, the πθ_old(a|s) that PPO's importance ratio divides by).
export function gaussianLogProbNumeric(mu: Float64Array, logStd: Float64Array, a: Float64Array): number {
  let s = 0;
  for (let d = 0; d < mu.length; d++) {
    const z = (a[d] - mu[d]) * Math.exp(-logStd[d]);
    s += -0.5 * z * z - logStd[d] - 0.5 * LOG_2PI;
  }
  return s;
}

// Sample an action vector from N(mu, diag(exp(logStd)²)) using the supplied rng (Box–Muller).
export function sampleGaussian(mu: Float64Array, logStd: Float64Array, rng: () => number): Float64Array {
  const out = new Float64Array(mu.length);
  for (let d = 0; d < mu.length; d++) out[d] = mu[d] + Math.exp(logStd[d]) * randnFrom(rng);
  return out;
}

function randnFrom(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Discrete log-prob of the chosen actions, differentiable [B,1]: gatherCols(logSoftmax(logits)).
export function categoricalLogProb(logits: Tensor, actions: Int32Array): Tensor {
  return gatherCols(logits.logSoftmax(), actions);
}

// Differentiable scalar mean entropy [1,1] of the per-row categorical policies: −Σ p·log p / B.
export function categoricalEntropy(logits: Tensor): Tensor {
  return logits.softmax().mul(logits.logSoftmax()).sumAll().scale(-1 / logits.rows);
}

// A tape-free forward pass mirroring MLP.forward for the (norm/dropout-free) RL nets: each layer
// is y = act(x·W + b). Used for fast rollout sampling where we never need gradients.
function forwardNumeric(net: MLP, obs: Float64Array): Float64Array {
  let h = obs;
  for (let li = 0; li < net.layers.length; li++) {
    const layer = net.layers[li];
    const inF = layer.weight.rows;
    const outF = layer.weight.cols;
    const w = layer.weight.data;
    const b = layer.bias.data;
    const out = new Float64Array(outF);
    for (let o = 0; o < outF; o++) {
      let s = b[o];
      for (let i = 0; i < inF; i++) s += h[i] * w[i * outF + o];
      out[o] = s;
    }
    applyActNumeric(out, net.acts[li]);
    h = out;
  }
  return h;
}

function applyActNumeric(v: Float64Array, act: Activation): void {
  switch (act) {
    case 'relu':
      for (let i = 0; i < v.length; i++) v[i] = v[i] > 0 ? v[i] : 0;
      break;
    case 'leaky_relu':
      for (let i = 0; i < v.length; i++) v[i] = v[i] > 0 ? v[i] : 0.01 * v[i];
      break;
    case 'elu':
      for (let i = 0; i < v.length; i++) v[i] = v[i] > 0 ? v[i] : Math.exp(v[i]) - 1;
      break;
    case 'gelu':
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        v[i] = 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x * x * x)));
      }
      break;
    case 'silu':
      for (let i = 0; i < v.length; i++) v[i] = v[i] / (1 + Math.exp(-v[i]));
      break;
    case 'softplus':
      for (let i = 0; i < v.length; i++) v[i] = Math.log1p(Math.exp(-Math.abs(v[i]))) + Math.max(v[i], 0);
      break;
    case 'tanh':
      for (let i = 0; i < v.length; i++) v[i] = Math.tanh(v[i]);
      break;
    case 'sigmoid':
      for (let i = 0; i < v.length; i++) v[i] = 1 / (1 + Math.exp(-v[i]));
      break;
    case 'linear':
      break;
  }
}

export function softmaxInPlace(logits: Float64Array): Float64Array {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) max = Math.max(max, logits[i]);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    logits[i] = Math.exp(logits[i] - max);
    sum += logits[i];
  }
  for (let i = 0; i < logits.length; i++) logits[i] /= sum;
  return logits;
}

// Sample an action index from a (normalized) probability vector using the supplied rng.
export function sampleCategorical(probs: Float64Array, rng: () => number): number {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (r < acc) return i;
  }
  return probs.length - 1;
}

export function argmax(v: Float64Array): number {
  let best = 0;
  let bv = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (v[i] > bv) {
      bv = v[i];
      best = i;
    }
  }
  return best;
}

// Shannon entropy (in nats) of a probability vector — the policy's exploration, charted live.
export function entropyOf(probs: Float64Array): number {
  let h = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > 1e-12) h -= probs[i] * Math.log(probs[i]);
  }
  return h;
}

// ---- returns & advantages -------------------------------------------------------------------

export interface EpisodeTrace {
  rewards: number[];
  values: number[]; // V(s_t) per step (zeros if no critic)
  bootstrap: number; // V(s_T) for a truncated episode, else 0
}

export interface Targets {
  adv: number[]; // policy-gradient weight per step
  ret: number[]; // critic regression target per step
}

// Per-episode returns and advantages. The Monte-Carlo discounted return G_t (with bootstrap at a
// time-limit truncation) is always available; GAE(λ) is computed from the critic for A2C.
//   reinforce    : adv = G_t,            (no critic)
//   baseline     : adv = G_t − V(s_t),   ret = G_t
//   a2c/ppo (GAE): adv = Â_t (GAE),      ret = Â_t + V(s_t)
export function computeTargets(ep: EpisodeTrace, gamma: number, lambda: number, algo: RLAlgo): Targets {
  const T = ep.rewards.length;
  const ret: number[] = new Array(T).fill(0);
  const adv: number[] = new Array(T).fill(0);
  const usesGae = RL_ALGOS.find((a) => a.id === algo)?.usesGae ?? false;

  // Monte-Carlo discounted returns.
  const mc: number[] = new Array(T).fill(0);
  let g = ep.bootstrap;
  for (let t = T - 1; t >= 0; t--) {
    g = ep.rewards[t] + gamma * g;
    mc[t] = g;
  }

  if (usesGae) {
    let gae = 0;
    for (let t = T - 1; t >= 0; t--) {
      const vNext = t + 1 < T ? ep.values[t + 1] : ep.bootstrap;
      const delta = ep.rewards[t] + gamma * vNext - ep.values[t];
      gae = delta + gamma * lambda * gae;
      adv[t] = gae;
      ret[t] = gae + ep.values[t];
    }
  } else if (algo === 'baseline') {
    for (let t = 0; t < T; t++) {
      adv[t] = mc[t] - ep.values[t];
      ret[t] = mc[t];
    }
  } else {
    for (let t = 0; t < T; t++) {
      adv[t] = mc[t];
      ret[t] = mc[t];
    }
  }
  return { adv, ret };
}

// Standardize advantages (zero mean, unit variance) across the whole batch — the single most
// reliable variance-reduction trick in policy-gradient training. Mutates the array in place.
export function normalizeAdvantages(adv: number[]): void {
  const n = adv.length;
  if (n === 0) return;
  let mean = 0;
  for (const a of adv) mean += a;
  mean /= n;
  let varr = 0;
  for (const a of adv) varr += (a - mean) * (a - mean);
  varr /= n;
  const std = Math.sqrt(varr) + 1e-8;
  for (let i = 0; i < n; i++) adv[i] = (adv[i] - mean) / std;
}

export function buildAgent(
  stateDim: number,
  nActions: number,
  presetId: string,
  act: Activation,
  seed: number,
  continuous = false,
): Agent {
  const preset = RL_PRESETS.find((p) => p.id === presetId) ?? RL_PRESETS[1];
  return new Agent(stateDim, nActions, preset.hidden, act, mulberry32(seed), continuous);
}
