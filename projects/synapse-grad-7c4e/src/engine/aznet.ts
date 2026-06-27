// The AlphaZero network: one body, two heads.
//
// A single convolutional tower reads the canonical board (side-to-move planes) and forks into:
//   • a POLICY head — a distribution over moves, "where should I consider playing?"
//   • a VALUE head  — one number in (−1, 1), "who is winning from here, from my side?"
//
// Both heads are trained together on data the *search* produces: the policy is regressed onto the
// MCTS visit distribution (a better policy than the raw net, because the search looked ahead), and
// the value onto the eventual game result. That is the whole of AlphaZero's learning signal — no
// human games, no heuristics, no dataset. Everything is built on the same hand-rolled autograd
// engine as every other lab (conv2d, matmul, relu, tanh, logSoftmax), so the combined loss
// gradchecks to ~1e-6 against finite differences.

import { Tensor } from './tensor';
import { conv2d, type ConvMeta } from './conv';
import { Linear } from './nn';
import { mulberry32 } from './nn';

export interface AZConfig {
  planes: number;
  rows: number;
  cols: number;
  numActions: number;
  channels: number; // width of the conv tower
  blocks: number; // number of conv layers in the body
  valueHidden: number; // hidden units in the value head
}

function randn(rng: () => number): number {
  // Box–Muller.
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const BIG = 1e9; // additive penalty that zeroes an illegal move under the softmax

export interface AZForward {
  policyLogits: Tensor; // [N, numActions] — raw, *unmasked* logits
  value: Tensor; // [N, 1] in (−1, 1)
}

export interface AZEval {
  policy: Float64Array; // [numActions], softmax over legal moves only (illegal entries are 0)
  logits: Float64Array; // [numActions], raw logits (for the search-stat readout)
  value: number; // scalar in (−1, 1), from the side-to-move's perspective
}

export class AZNet {
  readonly cfg: AZConfig;
  // Body: `blocks` 3×3 "same" convolutions (channels wide), each followed by ReLU.
  private convW: Tensor[] = [];
  private convB: Tensor[] = [];
  // Policy head: 1×1 conv → ReLU → flatten → linear to move logits.
  private pConvW: Tensor;
  private pConvB: Tensor;
  private pFc: Linear;
  // Value head: 1×1 conv → ReLU → flatten → linear → ReLU → linear → tanh.
  private vConvW: Tensor;
  private vConvB: Tensor;
  private vFc1: Linear;
  private vFc2: Linear;

  private readonly PHC = 2; // policy-head channels
  private readonly VHC = 1; // value-head channels

  constructor(cfg: AZConfig, rng: () => number) {
    this.cfg = cfg;
    const cells = cfg.rows * cfg.cols;
    let cin = cfg.planes;
    for (let b = 0; b < cfg.blocks; b++) {
      const cout = cfg.channels;
      const fanIn = cin * 9; // 3×3 kernel
      const gain = Math.sqrt(2 / fanIn);
      const w = new Float64Array(cout * fanIn);
      for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
      this.convW.push(Tensor.fromFlat(w, cout, fanIn, true).named(`body${b}`));
      this.convB.push(Tensor.zeros(1, cout, true).named(`bodyB${b}`));
      cin = cout;
    }

    // Policy head 1×1 conv.
    {
      const fanIn = cin; // 1×1
      const gain = Math.sqrt(2 / fanIn);
      const w = new Float64Array(this.PHC * fanIn);
      for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
      this.pConvW = Tensor.fromFlat(w, this.PHC, fanIn, true).named('pconv');
      this.pConvB = Tensor.zeros(1, this.PHC, true).named('pconvB');
      this.pFc = new Linear(this.PHC * cells, cfg.numActions, 'linear', rng);
    }
    // Value head 1×1 conv.
    {
      const fanIn = cin;
      const gain = Math.sqrt(2 / fanIn);
      const w = new Float64Array(this.VHC * fanIn);
      for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
      this.vConvW = Tensor.fromFlat(w, this.VHC, fanIn, true).named('vconv');
      this.vConvB = Tensor.zeros(1, this.VHC, true).named('vconvB');
      this.vFc1 = new Linear(this.VHC * cells, cfg.valueHidden, 'relu', rng);
      this.vFc2 = new Linear(cfg.valueHidden, 1, 'tanh', rng);
    }
  }

  // The shared trunk and both heads, batched. `enc` is [N, planes*rows*cols] (NCHW-flattened).
  forward(enc: Tensor): AZForward {
    const cfg = this.cfg;
    const N = enc.rows;
    let h = enc;
    let cin = cfg.planes;
    for (let b = 0; b < cfg.blocks; b++) {
      const meta: ConvMeta = {
        N,
        Cin: cin,
        H: cfg.rows,
        W: cfg.cols,
        Cout: cfg.channels,
        kh: 3,
        kw: 3,
        stride: 1,
        pad: 1, // "same"
      };
      h = conv2d(h, this.convW[b], this.convB[b], meta).relu();
      cin = cfg.channels;
    }
    const meta1 = (cout: number): ConvMeta => ({
      N,
      Cin: cin,
      H: cfg.rows,
      W: cfg.cols,
      Cout: cout,
      kh: 1,
      kw: 1,
      stride: 1,
      pad: 0,
    });
    // Policy head.
    const p = conv2d(h, this.pConvW, this.pConvB, meta1(this.PHC)).relu();
    const policyLogits = this.pFc.forward(p); // [N, numActions]
    // Value head.
    const v = conv2d(h, this.vConvW, this.vConvB, meta1(this.VHC)).relu();
    const value = this.vFc2.forward(this.vFc1.forward(v).relu()).tanh(); // [N, 1]
    return { policyLogits, value };
  }

  // Single-position inference for the search: returns a legal-masked softmax policy and the value.
  // Plain numeric arithmetic (no tape) — the search calls this thousands of times.
  evaluate(enc: Float64Array, mask: Uint8Array): AZEval {
    const cells = this.cfg.rows * this.cfg.cols;
    const t = Tensor.fromFlat(enc.slice(), 1, this.cfg.planes * cells, false);
    const out = this.forward(t);
    const logits = out.policyLogits.data.slice();
    // Masked softmax over legal moves.
    const policy = new Float64Array(this.cfg.numActions);
    let max = -Infinity;
    for (let a = 0; a < policy.length; a++) if (mask[a]) max = Math.max(max, logits[a]);
    let sum = 0;
    for (let a = 0; a < policy.length; a++) {
      if (mask[a]) {
        const e = Math.exp(logits[a] - max);
        policy[a] = e;
        sum += e;
      }
    }
    if (sum > 0) for (let a = 0; a < policy.length; a++) policy[a] /= sum;
    return { policy, logits, value: out.value.data[0] };
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (let i = 0; i < this.convW.length; i++) ps.push(this.convW[i], this.convB[i]);
    ps.push(this.pConvW, this.pConvB, ...this.pFc.parameters());
    ps.push(this.vConvW, this.vConvB, ...this.vFc1.parameters(), ...this.vFc2.parameters());
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
    let n = 0;
    for (const p of ps) n += p.size;
    if (flat.length !== n) return false;
    let k = 0;
    for (const p of ps) for (let i = 0; i < p.size; i++) p.data[i] = flat[k++];
    return true;
  }
}

export function makeAZNet(cfg: AZConfig, seed: number): AZNet {
  return new AZNet(cfg, mulberry32(seed >>> 0));
}

export interface AZLossParts {
  loss: Tensor; // total (policy CE + value MSE + L2), differentiable
  policyLoss: number;
  valueLoss: number;
}

// The AlphaZero loss on a minibatch:
//   L = −Σ π·log p_θ   (policy cross-entropy onto the MCTS visit distribution)
//       + (z − v_θ)²    (value mean-squared error onto the game outcome)
//       + c·‖θ‖²        (L2 regularization)
// Illegal moves are removed from the softmax by an additive −BIG mask, so the policy is a clean
// distribution over legal moves only (the targets `pi` already place zero mass there).
export function azLoss(
  net: AZNet,
  enc: Float64Array, // [N, planes*cells]
  mask: Float64Array, // [N, numActions], 1 = legal, 0 = illegal
  pi: Float64Array, // [N, numActions] target visit distribution
  z: Float64Array, // [N] target outcomes in [−1, 1]
  N: number,
  l2 = 1e-4,
): AZLossParts {
  const cfg = net.cfg;
  const A = cfg.numActions;
  const cells = cfg.rows * cfg.cols;
  const encT = Tensor.fromFlat(enc.slice(0, N * cfg.planes * cells), N, cfg.planes * cells, false);
  const out = net.forward(encT);

  // Masked log-softmax: add (mask−1)·BIG so illegal logits go to −∞.
  const maskBias = new Float64Array(N * A);
  for (let i = 0; i < N * A; i++) maskBias[i] = (mask[i] - 1) * BIG;
  const masked = out.policyLogits.add(Tensor.fromFlat(maskBias, N, A, false));
  const logp = masked.logSoftmax(); // [N, A]
  const piT = Tensor.fromFlat(pi.slice(0, N * A), N, A, false);
  // −Σ π·log p, averaged over the batch.
  const policyLoss = piT.mul(logp).sumAll().neg().scale(1 / N);

  // Value MSE.
  const zT = Tensor.fromFlat(z.slice(0, N), N, 1, false);
  const diff = out.value.sub(zT);
  const valueLoss = diff.mul(diff).meanAll();

  let total = policyLoss.add(valueLoss);
  if (l2 > 0) {
    let reg: Tensor | null = null;
    for (const p of net.parameters()) {
      const term = p.mul(p).sumAll();
      reg = reg ? reg.add(term) : term;
    }
    if (reg) total = total.add(reg.scale(l2));
  }
  return { loss: total, policyLoss: policyLoss.data[0], valueLoss: valueLoss.data[0] };
}
