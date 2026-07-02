// Value · DQN — off-policy, value-based deep reinforcement learning, all on the engine's own
// reverse-mode tensor autograd. Where `policy.ts` learns a policy *directly* from the returns of
// on-policy rollouts, this module learns the **action-value** function Q(s,a) — the expected
// discounted return of taking action a in state s and acting greedily afterwards — and derives the
// policy by acting greedily w.r.t. it (ε-greedy while exploring). This is DQN (Mnih et al. 2015)
// plus Double DQN (van Hasselt 2016), the Dueling architecture (Wang et al. 2016), n-step returns,
// and Prioritized Experience Replay (Schaul et al. 2016).
//
// Everything here is hand-derived and gradchecked in `selftest.ts`. The only genuinely new
// backward pass is `weightedHuber` (a per-sample importance-weighted smooth-L1 whose VJP w.r.t. the
// predicted Q is derived below); the Dueling recombination Q = V + (A − mean_a A) is assembled from
// existing tape ops (matmul/add/sub) so it back-propagates for free.

import { Tensor } from './tensor';
import { Linear, applyActivation, mulberry32, type Activation } from './nn';
import { gatherCols } from './ops';
import { Optimizer, defaultOptimizer, clipGradGlobalNorm } from './optim';
import type { Env } from './rl-env';
import { GRID_LAYOUTS, type GridLayout } from './rl-env';

// ---------------------------------------------------------------------------------------------
// weightedHuber — a scalar loss  mean_i  w_i · Huber_δ(pred_i − target_i),  where `target` and
// `weights` are constants (the frozen TD targets and PER importance weights). Only `pred` needs a
// gradient. Huber_δ(r) = ½r² for |r|≤δ, else δ(|r|−½δ); its derivative is r (clamped to ±δ), so
//   ∂L/∂pred_i = seed · w_i · clamp(r_i, −δ, δ) / B.
// This is the Huber the DQN literature uses (robust to the fat-tailed TD errors a bootstrap
// target produces) with PER's bias-correcting weights folded in per sample.
// ---------------------------------------------------------------------------------------------
export function weightedHuber(pred: Tensor, target: Float64Array, weights: Float64Array, delta = 1): Tensor {
  const n = pred.size;
  if (target.length !== n || weights.length !== n) throw new Error('weightedHuber shape mismatch');
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = pred.data[i] - target[i];
    const h = Math.abs(r) <= delta ? 0.5 * r * r : delta * (Math.abs(r) - 0.5 * delta);
    total += weights[i] * h;
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / n;
  out.op = 'weightedHuber';
  out.prev = [pred];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const g = pred.grad;
    for (let i = 0; i < n; i++) {
      const r = pred.data[i] - target[i];
      const dr = Math.abs(r) <= delta ? r : delta * Math.sign(r);
      g[i] += (seed * weights[i] * dr) / n;
    }
  };
  return out;
}

// ---------------------------------------------------------------------------------------------
// QNet — the action-value network. `plain` is an MLP state → hidden → Q[nActions]. `dueling`
// splits the last hidden into a scalar value stream V(s) and an advantage stream A(s,a),
// recombined as Q = V + (A − mean_a A): the mean-subtraction fixes the otherwise-unidentifiable
// V/A split (adding c to V and −c to every A leaves Q unchanged), which is exactly what makes the
// dueling decomposition trainable. Built from `Linear`, so `parameters()` + the tape give the
// gradient; two constant tensors expand the per-row scalars to [B, nActions] with a matmul
// (the engine's broadcasting only adds a [1, C] row across rows, not a [B, 1] column across cols).
// ---------------------------------------------------------------------------------------------
export type QArch = 'plain' | 'dueling';

export class QNet {
  stateDim: number;
  nActions: number;
  arch: QArch;
  hidden: Linear[] = [];
  acts: Activation[] = [];
  // plain head:
  head: Linear | null = null;
  // dueling heads:
  valHead: Linear | null = null;
  advHead: Linear | null = null;
  private onesRow: Tensor; // [1, nActions] of ones
  private avgCol: Tensor; // [nActions, 1] of 1/nActions

  constructor(stateDim: number, nActions: number, hidden: number[], act: Activation, arch: QArch, rng: () => number) {
    this.stateDim = stateDim;
    this.nActions = nActions;
    this.arch = arch;
    let prev = stateDim;
    for (const h of hidden) {
      this.hidden.push(new Linear(prev, h, act, rng));
      this.acts.push(act);
      prev = h;
    }
    if (arch === 'dueling') {
      this.valHead = new Linear(prev, 1, 'linear', rng);
      this.advHead = new Linear(prev, nActions, 'linear', rng);
    } else {
      this.head = new Linear(prev, nActions, 'linear', rng);
    }
    this.onesRow = Tensor.fromFlat(new Float64Array(nActions).fill(1), 1, nActions, false);
    this.avgCol = Tensor.fromFlat(new Float64Array(nActions).fill(1 / nActions), nActions, 1, false);
  }

  // Forward over a batch of states [B, stateDim] → Q [B, nActions], differentiable.
  forward(x: Tensor): Tensor {
    let h = x;
    for (let i = 0; i < this.hidden.length; i++) {
      h = applyActivation(this.hidden[i].forward(h), this.acts[i]);
    }
    if (this.arch === 'dueling') {
      const V = this.valHead!.forward(h); // [B,1]
      const A = this.advHead!.forward(h); // [B,nA]
      const meanA = A.matmul(this.avgCol); // [B,1]
      const meanFull = meanA.matmul(this.onesRow); // [B,nA]
      const Vfull = V.matmul(this.onesRow); // [B,nA]
      return Vfull.add(A).sub(meanFull);
    }
    return this.head!.forward(h);
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.hidden) ps.push(...l.parameters());
    if (this.arch === 'dueling') {
      ps.push(...this.valHead!.parameters(), ...this.advHead!.parameters());
    } else {
      ps.push(...this.head!.parameters());
    }
    return ps;
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }

  exportWeights(): number[] {
    const out: number[] = [];
    for (const p of this.parameters()) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
    return out;
  }

  importWeights(flat: number[]): boolean {
    const ps = this.parameters();
    let total = 0;
    for (const p of ps) total += p.size;
    if (flat.length !== total) return false;
    let k = 0;
    for (const p of ps) for (let i = 0; i < p.size; i++) p.data[i] = flat[k++];
    return true;
  }

  // Hard target sync: copy every parameter value from `src` into this net.
  hardUpdateFrom(src: QNet): void {
    const s = src.parameters();
    const d = this.parameters();
    for (let i = 0; i < d.length; i++) d[i].data.set(s[i].data);
  }

  // Polyak (soft) target update: θ_tgt ← (1−τ)·θ_tgt + τ·θ_online.
  softUpdateFrom(src: QNet, tau: number): void {
    const s = src.parameters();
    const d = this.parameters();
    for (let i = 0; i < d.length; i++) {
      const sd = s[i].data;
      const dd = d[i].data;
      for (let j = 0; j < dd.length; j++) dd[j] = (1 - tau) * dd[j] + tau * sd[j];
    }
  }
}

// Fast no-tape forward for a single state — used by the greedy demo, the Q-heatmap field, and
// action selection. Numerically identical to `forward` on one row. Returns Q[nActions].
export function qForward(net: QNet, obs: Float64Array): Float64Array {
  let h = obs;
  for (let i = 0; i < net.hidden.length; i++) {
    h = linearNumeric(h, net.hidden[i]);
    applyActNumeric(h, net.acts[i]);
  }
  if (net.arch === 'dueling') {
    const V = linearNumeric(h, net.valHead!)[0];
    const A = linearNumeric(h, net.advHead!);
    let mean = 0;
    for (let a = 0; a < A.length; a++) mean += A[a];
    mean /= A.length;
    const q = new Float64Array(A.length);
    for (let a = 0; a < A.length; a++) q[a] = V + A[a] - mean;
    return q;
  }
  return linearNumeric(h, net.head!);
}

function linearNumeric(x: Float64Array, l: Linear): Float64Array {
  const inF = l.weight.rows;
  const outF = l.weight.cols;
  const w = l.weight.data;
  const b = l.bias.data;
  const out = new Float64Array(outF);
  for (let o = 0; o < outF; o++) {
    let s = b[o];
    for (let i = 0; i < inF; i++) s += x[i] * w[i * outF + o];
    out[o] = s;
  }
  return out;
}

function applyActNumeric(v: Float64Array, act: Activation): void {
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    switch (act) {
      case 'relu':
        v[i] = x > 0 ? x : 0;
        break;
      case 'leaky_relu':
        v[i] = x > 0 ? x : 0.01 * x;
        break;
      case 'elu':
        v[i] = x > 0 ? x : Math.exp(x) - 1;
        break;
      case 'gelu':
        v[i] = 0.5 * x * (1 + Math.tanh(0.7978845608028654 * (x + 0.044715 * x * x * x)));
        break;
      case 'silu':
        v[i] = x / (1 + Math.exp(-x));
        break;
      case 'softplus':
        v[i] = Math.log1p(Math.exp(-Math.abs(x))) + Math.max(x, 0);
        break;
      case 'tanh':
        v[i] = Math.tanh(x);
        break;
      case 'sigmoid':
        v[i] = 1 / (1 + Math.exp(-x));
        break;
      case 'linear':
        break;
    }
  }
}

export function greedyAction(net: QNet, obs: Float64Array): number {
  const q = qForward(net, obs);
  let best = 0;
  let bv = q[0];
  for (let a = 1; a < q.length; a++)
    if (q[a] > bv) {
      bv = q[a];
      best = a;
    }
  return best;
}

export function argmaxOf(v: Float64Array): number {
  let best = 0;
  let bv = v[0];
  for (let i = 1; i < v.length; i++)
    if (v[i] > bv) {
      bv = v[i];
      best = i;
    }
  return best;
}

export function maxOf(v: Float64Array): number {
  let m = v[0];
  for (let i = 1; i < v.length; i++) if (v[i] > m) m = v[i];
  return m;
}

// ---------------------------------------------------------------------------------------------
// Replay — the experience buffer. A `Transition` is already n-step-assembled (see the collector in
// the agent): a start state/action, the n-step discounted reward `rn`, the bootstrap state `s2`
// (null iff the trajectory terminated within the horizon), and `gammaN` = γ^k for the k steps
// until the bootstrap. So the TD target is uniformly  rn + gammaN·(bootstrap value), 0 if terminal.
// ---------------------------------------------------------------------------------------------
export interface Transition {
  s: Float64Array;
  a: number;
  rn: number;
  s2: Float64Array | null; // null ⇒ terminal (no bootstrap)
  gammaN: number;
  reward1: number; // the immediate one-step reward (for the reward histogram)
}

export interface Sampled {
  items: Transition[];
  indices: number[];
  weights: Float64Array; // importance-sampling weights (all 1 for uniform replay)
}

export interface Replay {
  add(t: Transition): void;
  sample(batch: number, beta: number, rng: () => number): Sampled;
  updatePriorities(indices: number[], tdErrors: Float64Array): void;
  size(): number;
  capacity(): number;
  rewards(): number[]; // stored one-step rewards, for the histogram
  priorityStats(): { min: number; max: number; mean: number } | null;
}

export class UniformReplay implements Replay {
  private buf: Transition[] = [];
  private pos = 0;
  private cap: number;
  constructor(capacity: number) {
    this.cap = Math.max(1, capacity);
  }
  add(t: Transition): void {
    if (this.buf.length < this.cap) this.buf.push(t);
    else this.buf[this.pos] = t;
    this.pos = (this.pos + 1) % this.cap;
  }
  sample(batch: number, _beta: number, rng: () => number): Sampled {
    const n = this.buf.length;
    const items: Transition[] = [];
    const indices: number[] = [];
    const m = Math.min(batch, n);
    for (let i = 0; i < m; i++) {
      const idx = Math.floor(rng() * n);
      indices.push(idx);
      items.push(this.buf[idx]);
    }
    return { items, indices, weights: new Float64Array(m).fill(1) };
  }
  updatePriorities(): void {
    /* uniform: no priorities */
  }
  size(): number {
    return this.buf.length;
  }
  capacity(): number {
    return this.cap;
  }
  rewards(): number[] {
    return this.buf.map((t) => t.reward1);
  }
  priorityStats(): null {
    return null;
  }
}

// A sum-tree: a complete binary tree over `cap` leaves where each internal node holds the sum of
// its children, so (1) the total priority is the root in O(1) and (2) sampling a value in
// [0, total) descends to a leaf in O(log cap), landing on leaf i with probability p_i/total. This
// is the data structure that makes proportional prioritized sampling cheap.
export class SumTree {
  private tree: Float64Array; // size 2*cap; leaves at [cap, 2*cap)
  private cap: number;
  constructor(cap: number) {
    this.cap = cap;
    this.tree = new Float64Array(2 * cap);
  }
  total(): number {
    return this.tree[1];
  }
  set(i: number, p: number): void {
    let node = i + this.cap;
    const delta = p - this.tree[node];
    this.tree[node] = p;
    node >>= 1;
    while (node >= 1) {
      this.tree[node] += delta;
      node >>= 1;
    }
  }
  get(i: number): number {
    return this.tree[i + this.cap];
  }
  // Find the leaf index whose cumulative priority interval contains `value` ∈ [0, total).
  find(value: number): number {
    let node = 1;
    while (node < this.cap) {
      const left = node << 1;
      if (value <= this.tree[left]) node = left;
      else {
        value -= this.tree[left];
        node = left | 1;
      }
    }
    return node - this.cap;
  }
}

export class PrioritizedReplay implements Replay {
  private buf: (Transition | null)[];
  private tree: SumTree;
  private cap: number;
  private count = 0;
  private pos = 0;
  private maxPriority = 1;
  private alpha: number;
  private eps = 1e-5;
  constructor(capacity: number, alpha: number) {
    // Round capacity up to a power of two for a clean complete tree.
    let c = 1;
    while (c < capacity) c <<= 1;
    this.cap = c;
    this.buf = new Array(c).fill(null);
    this.tree = new SumTree(c);
    this.alpha = alpha;
  }
  add(t: Transition): void {
    // New transitions enter at the current maximum priority so they're guaranteed to be replayed.
    this.buf[this.pos] = t;
    this.tree.set(this.pos, Math.pow(this.maxPriority, this.alpha));
    this.pos = (this.pos + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }
  sample(batch: number, beta: number, rng: () => number): Sampled {
    const items: Transition[] = [];
    const indices: number[] = [];
    const total = this.tree.total();
    const m = Math.min(batch, this.count);
    const weights = new Float64Array(m);
    const seg = total / m; // stratified sampling: one draw per equal-probability segment
    let minProb = Infinity;
    const probs = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const value = seg * (i + rng());
      const idx = this.tree.find(value);
      const p = this.tree.get(idx) / total;
      probs[i] = p;
      if (p < minProb) minProb = p;
      indices.push(idx);
      items.push(this.buf[idx]!);
    }
    // Importance-sampling weights w_i = (N·P_i)^{−β}, normalized by the max so they only scale down.
    const maxW = Math.pow(this.count * minProb, -beta);
    for (let i = 0; i < m; i++) weights[i] = Math.pow(this.count * probs[i], -beta) / maxW;
    return { items, indices, weights };
  }
  updatePriorities(indices: number[], tdErrors: Float64Array): void {
    for (let i = 0; i < indices.length; i++) {
      const p = Math.abs(tdErrors[i]) + this.eps;
      if (p > this.maxPriority) this.maxPriority = p;
      this.tree.set(indices[i], Math.pow(p, this.alpha));
    }
  }
  size(): number {
    return this.count;
  }
  capacity(): number {
    return this.cap;
  }
  rewards(): number[] {
    const out: number[] = [];
    for (const t of this.buf) if (t) out.push(t.reward1);
    return out;
  }
  priorityStats(): { min: number; max: number; mean: number } | null {
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.tree.get(i);
      mn = Math.min(mn, p);
      mx = Math.max(mx, p);
      sum += p;
      n++;
    }
    return n ? { min: mn, max: mx, mean: sum / n } : null;
  }
}

// ---------------------------------------------------------------------------------------------
// TD targets. For each sampled transition, the bootstrap value of s2 is either the plain-DQN
// max_a' Q_tgt(s2,a') or the Double-DQN Q_tgt(s2, argmax_a' Q_online(s2,a')) — decoupling action
// SELECTION (online net) from action EVALUATION (target net) removes DQN's systematic
// maximization bias. Terminal transitions (s2 === null) get no bootstrap.
// ---------------------------------------------------------------------------------------------
export function tdTarget(t: Transition, online: QNet, target: QNet, double: boolean): number {
  if (t.s2 === null) return t.rn;
  let bootstrap: number;
  if (double) {
    const a = argmaxOf(qForward(online, t.s2));
    bootstrap = qForward(target, t.s2)[a];
  } else {
    bootstrap = maxOf(qForward(target, t.s2));
  }
  return t.rn + t.gammaN * bootstrap;
}

// ---------------------------------------------------------------------------------------------
// The agent — ties the online/target nets, replay, optimizer and ε-schedule together into the DQN
// control loop. `observe` handles n-step assembly; `learn` runs one gradient step; the collector
// (in the hook, or the self-test) drives an environment through `act` / `observe`.
// ---------------------------------------------------------------------------------------------
export interface DQNConfig {
  gamma: number;
  lr: number;
  arch: QArch;
  double: boolean;
  per: boolean;
  hidden: number[];
  activation: Activation;
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
  perBetaStart: number;
  perBetaEnd: number;
  perBetaSteps: number;
  huberDelta: number;
  clipNorm: number;
  seed: number;
  // Deadly-triad demo switches (default true). Turning both OFF — bootstrapping off the *online*
  // net and training on the most recent, temporally-correlated transitions instead of a shuffled
  // replay — reproduces the classic instability that makes tabular-looking Q-learning with a neural
  // function approximator diverge, so the two stabilising tricks earn their keep visibly.
  useTargetNet?: boolean; // false ⇒ bootstrap from the online net itself (no frozen target)
  useReplay?: boolean; // false ⇒ learn online from the most recent transitions (correlated updates)
}

export interface LearnStats {
  loss: number;
  meanQ: number;
  maxQ: number;
  meanTdError: number;
  gradNorm: number;
}

export class DQNAgent {
  cfg: DQNConfig;
  stateDim: number;
  nActions: number;
  online: QNet;
  target: QNet;
  opt: Optimizer;
  replay: Replay;
  envSteps = 0;
  learnSteps = 0;
  private nbuf: { s: Float64Array; a: number; r: number }[] = []; // n-step FIFO for the current episode
  private recent: Transition[] = []; // recency window for the no-replay (online, correlated) path

  constructor(stateDim: number, nActions: number, cfg: DQNConfig) {
    this.cfg = cfg;
    this.stateDim = stateDim;
    this.nActions = nActions;
    const rng = mulberry32(cfg.seed ^ 0x0d9d);
    this.online = new QNet(stateDim, nActions, cfg.hidden, cfg.activation, cfg.arch, rng);
    this.target = new QNet(stateDim, nActions, cfg.hidden, cfg.activation, cfg.arch, mulberry32(cfg.seed ^ 0x0d9d));
    this.target.hardUpdateFrom(this.online); // start the target identical to the online net
    this.opt = new Optimizer(this.online.parameters(), defaultOptimizer('adam', cfg.lr));
    this.replay = cfg.per ? new PrioritizedReplay(cfg.bufferSize, cfg.perAlpha) : new UniformReplay(cfg.bufferSize);
  }

  epsilon(): number {
    const { epsStart, epsEnd, epsDecaySteps } = this.cfg;
    if (epsDecaySteps <= 0) return epsEnd;
    const frac = Math.min(1, this.envSteps / epsDecaySteps);
    return epsStart + (epsEnd - epsStart) * frac;
  }

  private beta(): number {
    const { perBetaStart, perBetaEnd, perBetaSteps } = this.cfg;
    if (perBetaSteps <= 0) return perBetaEnd;
    const frac = Math.min(1, this.learnSteps / perBetaSteps);
    return perBetaStart + (perBetaEnd - perBetaStart) * frac;
  }

  // ε-greedy action selection (greedy when `explore` is false, e.g. the demo).
  act(obs: Float64Array, rng: () => number, explore = true): number {
    if (explore && rng() < this.epsilon()) return Math.floor(rng() * this.nActions);
    return greedyAction(this.online, obs);
  }

  // Feed one environment step. Assembles n-step transitions into the replay buffer. `terminated`
  // is a true absorbing terminal (no bootstrap); `truncated` ends the episode but the last state
  // is non-terminal, so we still bootstrap from it (the standard time-limit handling).
  observe(s: Float64Array, a: number, r: number, s2: Float64Array, terminated: boolean, truncated: boolean): void {
    this.envSteps++;
    const n = Math.max(1, this.cfg.nStep);
    const gamma = this.cfg.gamma;
    this.nbuf.push({ s, a, r });
    // Emit a full n-step transition once the FIFO is deep enough.
    if (this.nbuf.length >= n) {
      let rn = 0;
      for (let k = 0; k < n; k++) rn += Math.pow(gamma, k) * this.nbuf[k].r;
      const head = this.nbuf[0];
      const done = terminated; // the nth step's terminality
      this.emit({ s: head.s, a: head.a, rn, s2: done ? null : s2, gammaN: Math.pow(gamma, n), reward1: head.r });
      this.nbuf.shift();
    }
    if (terminated || truncated) {
      // Drain the remaining partial n-step transitions at the episode boundary.
      while (this.nbuf.length > 0) {
        const k = this.nbuf.length;
        let rn = 0;
        for (let j = 0; j < k; j++) rn += Math.pow(gamma, j) * this.nbuf[j].r;
        const head = this.nbuf[0];
        this.emit({ s: head.s, a: head.a, rn, s2: terminated ? null : s2, gammaN: Math.pow(gamma, k), reward1: head.r });
        this.nbuf.shift();
      }
    }
  }

  // Store an assembled transition in the replay buffer and the recency window.
  private emit(t: Transition): void {
    this.replay.add(t);
    this.recent.push(t);
    if (this.recent.length > 1024) this.recent.shift();
  }

  ready(): boolean {
    return this.replay.size() >= Math.max(this.cfg.batch, this.cfg.warmup);
  }

  // One gradient step: sample a minibatch, compute the (frozen-target) TD targets, forward the
  // online Q, gather the taken action's value, weighted-Huber against the targets, back-propagate,
  // clip, and Adam-step. Updates PER priorities from the fresh TD errors, and syncs the target net.
  learn(rng: () => number): LearnStats | null {
    if (!this.ready()) return null;
    const cfg = this.cfg;
    const useReplay = cfg.useReplay !== false;
    const useTarget = cfg.useTargetNet !== false;
    let items: Transition[];
    let indices: number[];
    let weights: Float64Array;
    if (useReplay) {
      ({ items, indices, weights } = this.replay.sample(cfg.batch, this.beta(), rng));
    } else {
      // No replay: learn from the most recent transitions in order — highly temporally correlated,
      // exactly the setting that makes bootstrapped value learning unstable.
      const k = Math.min(cfg.batch, this.recent.length);
      items = this.recent.slice(this.recent.length - k);
      indices = [];
      weights = new Float64Array(k).fill(1);
    }
    // Bootstrap from the frozen target net, or — in the deadly-triad demo — from the online net itself.
    const tgtNet = useTarget ? this.target : this.online;
    const B = items.length;
    const targets = new Float64Array(B);
    for (let i = 0; i < B; i++) targets[i] = tdTarget(items[i], this.online, tgtNet, cfg.double);

    const sd = new Float64Array(B * this.stateDim);
    const acts = new Int32Array(B);
    for (let i = 0; i < B; i++) {
      sd.set(items[i].s, i * this.stateDim);
      acts[i] = items[i].a;
    }
    const statesT = Tensor.fromFlat(sd, B, this.stateDim, false);
    this.opt.zeroGrad();
    const q = this.online.forward(statesT); // [B, nA]
    const qa = gatherCols(q, acts); // [B, 1]
    const loss = weightedHuber(qa, targets, weights, cfg.huberDelta);
    loss.backward();
    const gradNorm = clipGradGlobalNorm(this.online.parameters(), cfg.clipNorm);
    this.opt.step();
    this.learnSteps++;

    // TD errors (post-update read is fine as a priority proxy; use pre-update Q values captured above).
    const tdErr = new Float64Array(B);
    let meanTd = 0;
    let meanQ = 0;
    let maxQ = -Infinity;
    for (let i = 0; i < B; i++) {
      const e = qa.data[i] - targets[i];
      tdErr[i] = e;
      meanTd += Math.abs(e);
      meanQ += qa.data[i];
      if (qa.data[i] > maxQ) maxQ = qa.data[i];
    }
    if (useReplay) this.replay.updatePriorities(indices, tdErr);

    // Target network sync (skipped entirely when the target net is disabled).
    if (useTarget) {
      if (cfg.targetMode === 'soft') this.target.softUpdateFrom(this.online, cfg.tau);
      else if (this.learnSteps % Math.max(1, cfg.targetPeriod) === 0) this.target.hardUpdateFrom(this.online);
    }

    return { loss: loss.data[0], meanQ: meanQ / B, maxQ, meanTdError: meanTd / B, gradNorm };
  }

  paramCount(): number {
    return this.online.paramCount();
  }
  exportWeights(): number[] {
    return this.online.exportWeights();
  }
  importWeights(flat: number[]): boolean {
    const ok = this.online.importWeights(flat);
    if (ok) this.target.hardUpdateFrom(this.online);
    return ok;
  }
}

// ---------------------------------------------------------------------------------------------
// Tabular ground truth. GridWorld is a finite, deterministic MDP, so we can compute the EXACT
// optimal action-value Q*(s,a) by value iteration and check the neural DQN against it. This is the
// external oracle no other lab has for its full learned behaviour.
//
// Model (matching rl-env.ts GridWorld exactly): from a non-terminal cell, action a moves one step
// (blocked by walls / bounds ⇒ stay). Landing on goal pays +1 and terminates; on a pit −1 and
// terminates; otherwise −stepCost and continues. Q*(s,a) = r(s,a) + γ·V*(s'), V*(terminal)=0,
// V*(s) = max_a Q*(s,a) over non-terminal s.
// ---------------------------------------------------------------------------------------------
const GRID_MOVES = [
  [-1, 0], // up
  [0, 1], // right
  [1, 0], // down
  [0, -1], // left
];

export interface GridMDP {
  layout: GridLayout;
  nStates: number;
  nActions: number;
  terminal: boolean[]; // per cell
  wall: boolean[];
  reward: Float64Array; // [state*4 + a] immediate reward
  next: Int32Array; // [state*4 + a] next-state index
}

export function buildGridMDP(layout: GridLayout): GridMDP {
  const { w, h, cells, stepCost } = layout;
  const nStates = w * h;
  const terminal: boolean[] = [];
  const wall: boolean[] = [];
  for (let i = 0; i < nStates; i++) {
    terminal.push(cells[i] === 'goal' || cells[i] === 'pit');
    wall.push(cells[i] === 'wall');
  }
  const reward = new Float64Array(nStates * 4);
  const next = new Int32Array(nStates * 4);
  for (let s = 0; s < nStates; s++) {
    const r = Math.floor(s / w);
    const c = s % w;
    for (let a = 0; a < 4; a++) {
      let nr = r + GRID_MOVES[a][0];
      let nc = c + GRID_MOVES[a][1];
      if (nr < 0 || nr >= h || nc < 0 || nc >= w || cells[nr * w + nc] === 'wall') {
        nr = r;
        nc = c;
      }
      const ns = nr * w + nc;
      next[s * 4 + a] = ns;
      const cell = cells[ns];
      reward[s * 4 + a] = cell === 'goal' ? 1 : cell === 'pit' ? -1 : -stepCost;
    }
  }
  return { layout, nStates, nActions: 4, terminal, wall, reward, next };
}

export interface QStar {
  Q: Float64Array; // [state*4 + a]
  V: Float64Array; // [state]
  policy: Int32Array; // [state] greedy action
  bellmanResidual: number; // max |V - max_a (r + γ V(next))| after convergence
}

export function tabularQStar(layout: GridLayout, gamma: number, iters = 2000, tol = 1e-12): QStar {
  const mdp = buildGridMDP(layout);
  const n = mdp.nStates;
  const V = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    let maxDelta = 0;
    for (let s = 0; s < n; s++) {
      if (mdp.terminal[s] || mdp.wall[s]) continue; // V(terminal)=0, walls unreachable
      let best = -Infinity;
      for (let a = 0; a < 4; a++) {
        const ns = mdp.next[s * 4 + a];
        const bootstrap = mdp.terminal[ns] ? 0 : V[ns];
        const q = mdp.reward[s * 4 + a] + gamma * bootstrap;
        if (q > best) best = q;
      }
      maxDelta = Math.max(maxDelta, Math.abs(best - V[s]));
      V[s] = best;
    }
    if (maxDelta < tol) break;
  }
  const Q = new Float64Array(n * 4);
  const policy = new Int32Array(n);
  let residual = 0;
  for (let s = 0; s < n; s++) {
    if (mdp.terminal[s] || mdp.wall[s]) continue;
    let best = -Infinity;
    let bestA = 0;
    for (let a = 0; a < 4; a++) {
      const ns = mdp.next[s * 4 + a];
      const bootstrap = mdp.terminal[ns] ? 0 : V[ns];
      const q = mdp.reward[s * 4 + a] + gamma * bootstrap;
      Q[s * 4 + a] = q;
      if (q > best) {
        best = q;
        bestA = a;
      }
    }
    policy[s] = bestA;
    residual = Math.max(residual, Math.abs(best - V[s]));
  }
  return { Q, V, policy, bellmanResidual: residual };
}

export function gridLayoutById(id: string): GridLayout {
  return GRID_LAYOUTS.find((l) => l.id === id) ?? GRID_LAYOUTS[0];
}

// ---------------------------------------------------------------------------------------------
// A tiny deterministic corridor MDP used by the self-test's convergence proof: cells 0..L-1 in a
// line, start at 0, goal at L-1. Actions: 0 = right (toward goal), 1 = left. −stepCost per move,
// +1 on reaching the goal (terminal). Small enough that a DQN provably converges to Q* fast, and
// its Q* is closed-form, so we can assert the learned Q matches it.
// ---------------------------------------------------------------------------------------------
export interface CorridorMDP {
  length: number;
  stepCost: number;
}

export class Corridor implements Env {
  readonly kind = 'gridworld' as const;
  readonly nActions = 2;
  readonly continuous = false;
  readonly actDim = 0;
  readonly actionLabels = ['→ right', '← left'];
  readonly stateDim: number;
  private pos = 0;
  steps = 0;
  private length: number;
  private stepCost: number;
  private maxSteps: number;
  constructor(mdp: CorridorMDP) {
    this.length = mdp.length;
    this.stepCost = mdp.stepCost;
    this.stateDim = mdp.length;
    this.maxSteps = mdp.length * 4;
    this.reset();
  }
  reset(): Float64Array {
    this.pos = 0;
    this.steps = 0;
    return this.observe();
  }
  observe(): Float64Array {
    const v = new Float64Array(this.stateDim);
    v[this.pos] = 1;
    return v;
  }
  observeCell(i: number): Float64Array {
    const v = new Float64Array(this.stateDim);
    v[i] = 1;
    return v;
  }
  step(action: number | Float64Array): { obs: Float64Array; reward: number; terminated: boolean; truncated: boolean } {
    const a = typeof action === 'number' ? action : action[0];
    if (a === 0 && this.pos < this.length - 1) this.pos++;
    else if (a === 1 && this.pos > 0) this.pos--;
    this.steps++;
    let reward = -this.stepCost;
    let terminated = false;
    if (this.pos === this.length - 1) {
      reward = 1;
      terminated = true;
    }
    const truncated = this.steps >= this.maxSteps;
    return { obs: this.observe(), reward, terminated, truncated };
  }
}

// Closed-form Q* for the corridor (right = 0, left = 1). From cell i (< goal), moving right lands
// at i+1: if i+1 is the goal, r=+1 and no bootstrap; else r=−stepCost and bootstrap V*(i+1).
// V*(i) = the value of walking straight to the goal: −stepCost·(d−1) + γ^{d-1}·1 discounted, where
// d = (L-1-i) is the distance. We just run value iteration on the corridor to get it exactly.
export function corridorQStar(mdp: CorridorMDP, gamma: number): { Q: Float64Array; V: Float64Array; policy: Int32Array } {
  const L = mdp.length;
  const V = new Float64Array(L);
  const terminal = (i: number) => i === L - 1;
  for (let it = 0; it < 5000; it++) {
    let delta = 0;
    for (let i = 0; i < L; i++) {
      if (terminal(i)) continue;
      const right = i < L - 1 ? i + 1 : i;
      const left = i > 0 ? i - 1 : i;
      const qr = (right === L - 1 ? 1 : -mdp.stepCost) + gamma * (terminal(right) ? 0 : V[right]);
      const ql = (left === L - 1 ? 1 : -mdp.stepCost) + gamma * (terminal(left) ? 0 : V[left]);
      const best = Math.max(qr, ql);
      delta = Math.max(delta, Math.abs(best - V[i]));
      V[i] = best;
    }
    if (delta < 1e-14) break;
  }
  const Q = new Float64Array(L * 2);
  const policy = new Int32Array(L);
  for (let i = 0; i < L; i++) {
    if (terminal(i)) continue;
    const right = i < L - 1 ? i + 1 : i;
    const left = i > 0 ? i - 1 : i;
    const qr = (right === L - 1 ? 1 : -mdp.stepCost) + gamma * (terminal(right) ? 0 : V[right]);
    const ql = (left === L - 1 ? 1 : -mdp.stepCost) + gamma * (terminal(left) ? 0 : V[left]);
    Q[i * 2 + 0] = qr;
    Q[i * 2 + 1] = ql;
    policy[i] = qr >= ql ? 0 : 1;
  }
  return { Q, V, policy };
}
