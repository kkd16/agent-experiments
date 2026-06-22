// A from-scratch RealNVP normalizing flow on the engine's reverse-mode autograd.
//
// Where the VAE optimises a *lower bound* on the likelihood and diffusion learns a *score*,
// a normalizing flow gives the **exact** log-likelihood in closed form. It does this by being
// an exactly invertible map f: x ↦ z between data space and a base Gaussian, so the
// change-of-variables formula applies directly:
//
//     log p_x(x) = log p_z(f(x)) + log |det ∂f/∂x|
//
// The trick is to compose maps whose Jacobian is triangular, so its determinant is just the
// product of the diagonal — no N³ determinant, ever. RealNVP's building block is the
// **affine coupling layer**: a binary mask b splits the D dims into a passthrough set (b=1)
// and a transformed set (b=0); a small MLP reads ONLY the passthrough dims and emits a per-dim
// log-scale s and shift t, and the transformed dims are rescaled and shifted by them. The
// passthrough dims are untouched, so ∂z/∂x is lower-triangular and  log|det| = Σ s  exactly.
//
//   forward  (x → z, the *normalizing* direction, used for density + training):
//       z = b⊙x + (1−b)⊙((x − t)·exp(−s)),     logdet(x→z) = Σ_{transformed} (−s)
//   inverse  (z → x, the *generative* direction, used for sampling):
//       x = b⊙z + (1−b)⊙(z·exp(s) + t)
//
// where s, t are functions of the passthrough dims alone (identical in both directions, which
// is exactly what makes the layer analytically invertible). s is squashed through a bounded
// tanh·SCALE so exp(±s) can never blow up — the standard RealNVP stabiliser — and the scale
// head is zero-initialised so every coupling starts as a near-identity map (logdet 0) and
// training is stable from the very first step. Alternating the mask parity between layers lets
// every dimension be transformed, conditioned on the others.
//
// The whole stack is assembled from the engine's primitive ops (matmul, add, mul, sub, exp,
// tanh, rowSum), so the gradient of the exact negative-log-likelihood flows back into every
// parameter for free — and `selftest.ts` gradchecks it end-to-end, proves the layer is
// numerically invertible to ~1e-12, and proves the analytic log-det equals the true Jacobian
// determinant by finite differences.

import { Tensor } from './tensor';
import { Linear, applyActivation, mulberry32, type Activation } from './nn';
import { sampleNoise } from './vae';

export { mulberry32, sampleNoise };

export const LOG_2PI = Math.log(2 * Math.PI);

// Default bound on the log-scale: s ∈ (−SCALE_BOUND, SCALE_BOUND), so the per-dim scale
// exp(s) stays in (e^−2, e^2) ≈ (0.14, 7.4). Composed over several layers this is plenty of
// dynamic range while keeping the forward/inverse maps numerically tame.
const SCALE_BOUND = 2;

// ---- one affine coupling layer -------------------------------------------------------

class CouplingLayer {
  readonly D: number;
  private mask: Tensor; // b   [1,D] constant
  private invMask: Tensor; // 1−b [1,D] constant
  private trunk: Linear[];
  private sHead: Linear;
  private tHead: Linear;
  private act: Activation;
  private scaleBound: number;

  constructor(D: number, hidden: number[], act: Activation, parity: 0 | 1, rng: () => number, scaleBound: number) {
    this.D = D;
    this.act = act;
    this.scaleBound = scaleBound;

    const b = new Float64Array(D);
    const ib = new Float64Array(D);
    for (let i = 0; i < D; i++) {
      const pass = (i + parity) % 2 === 0 ? 1 : 0;
      b[i] = pass;
      ib[i] = 1 - pass;
    }
    this.mask = Tensor.fromFlat(b, 1, D, false).named('b');
    this.invMask = Tensor.fromFlat(ib, 1, D, false).named('1−b');

    this.trunk = [];
    let prev = D;
    for (const h of hidden) {
      this.trunk.push(new Linear(prev, h, act, rng));
      prev = h;
    }
    // Scale head: zero-initialised → s ≡ 0 → each coupling starts as a translation-only,
    // logdet-0 map. Translation head: small linear init.
    this.sHead = new Linear(prev, D, 'linear', rng);
    this.sHead.weight.data.fill(0);
    this.sHead.bias.data.fill(0);
    this.tHead = new Linear(prev, D, 'linear', rng);
  }

  // (s, t) from an already-masked input (transformed dims zeroed). s is bounded.
  private st(masked: Tensor): { s: Tensor; t: Tensor } {
    let h = masked;
    for (const l of this.trunk) h = applyActivation(l.forward(h), this.act);
    const s = this.sHead.forward(h).tanh().scale(this.scaleBound);
    const t = this.tHead.forward(h);
    return { s, t };
  }

  // x → z, returning the per-row log-determinant [N,1].
  forward(x: Tensor): { z: Tensor; logdet: Tensor } {
    const xId = x.mul(this.mask);
    const { s, t } = this.st(xId);
    const inner = x.sub(t).mul(s.scale(-1).exp()); // (x − t)·exp(−s)
    const z = xId.add(inner.mul(this.invMask));
    const logdet = s.mul(this.invMask).rowSum().scale(-1); // Σ_transformed (−s)
    return { z, logdet };
  }

  // z → x (the exact inverse). No gradient is needed here — it is only used for sampling and
  // the visualisations — but it is still built from the same `st` so it is provably the
  // inverse of `forward`.
  inverse(z: Tensor): Tensor {
    const zId = z.mul(this.mask);
    const { s, t } = this.st(zId);
    const inner = z.mul(s.exp()).add(t); // z·exp(s) + t
    return zId.add(inner.mul(this.invMask));
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.trunk) ps.push(...l.parameters());
    ps.push(...this.sHead.parameters(), ...this.tHead.parameters());
    return ps;
  }
}

// ---- the flow ------------------------------------------------------------------------

export interface FlowConfig {
  D: number; // data dimension (2 for the lab)
  hidden: number[]; // coupling-net hidden widths
  layers: number; // number of coupling layers
  activation: Activation;
  scaleBound?: number;
}

export class RealNVP {
  readonly cfg: FlowConfig;
  readonly D: number;
  private couplings: CouplingLayer[];

  constructor(cfg: FlowConfig, rng: () => number) {
    this.cfg = cfg;
    this.D = cfg.D;
    const bound = cfg.scaleBound ?? SCALE_BOUND;
    this.couplings = [];
    for (let k = 0; k < cfg.layers; k++) {
      this.couplings.push(new CouplingLayer(cfg.D, cfg.hidden, cfg.activation, (k % 2) as 0 | 1, rng, bound));
    }
  }

  // x → z with the accumulated log-determinant of the whole stack.
  forward(x: Tensor): { z: Tensor; logdet: Tensor } {
    let z = x;
    let logdet = Tensor.zeros(x.rows, 1);
    for (const c of this.couplings) {
      const r = c.forward(z);
      z = r.z;
      logdet = logdet.add(r.logdet);
    }
    return { z, logdet };
  }

  // z → x: run the couplings in reverse with each layer's exact inverse.
  inverse(z: Tensor): Tensor {
    let x = z;
    for (let i = this.couplings.length - 1; i >= 0; i--) x = this.couplings[i].inverse(x);
    return x;
  }

  // Per-row log-density WITHOUT the additive constant −(D/2)·log(2π):
  //   core = −½·Σ z²  +  logdet.
  // The constant is irrelevant to the gradient and is folded back in for any *reported* nats.
  logProbCore(x: Tensor): Tensor {
    const { z, logdet } = this.forward(x);
    const quad = z.mul(z).rowSum().scale(-0.5); // −½ Σ z²   [N,1]
    return quad.add(logdet);
  }

  // The training objective: mean negative log-likelihood (in nats, minus the constant).
  // Minimising it maximises the exact data likelihood under the flow.
  nllLoss(x: Tensor): Tensor {
    return this.logProbCore(x).meanAll().scale(-1);
  }

  // The constant that turns `logProbCore` into a true log-density (nats).
  logConst(): number {
    return -0.5 * this.D * LOG_2PI;
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const c of this.couplings) ps.push(...c.parameters());
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
}

export interface FlowPreset {
  id: string;
  label: string;
  hidden: number[];
  layers: number;
}

export const FLOW_PRESETS: FlowPreset[] = [
  { id: 'small', label: 'Small · 6 × [32]', hidden: [32], layers: 6 },
  { id: 'standard', label: 'Standard · 8 × [64, 64]', hidden: [64, 64], layers: 8 },
  { id: 'deep', label: 'Deep · 12 × [64, 64]', hidden: [64, 64], layers: 12 },
];

export function presetById(id: string): FlowPreset {
  return FLOW_PRESETS.find((p) => p.id === id) ?? FLOW_PRESETS[1];
}
