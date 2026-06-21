// A from-scratch Variational Autoencoder on the engine's reverse-mode autograd.
//
// The VAE adds two things the other labs never needed, and both are built honestly here:
//
//   • the *reparameterization trick* — the latent sample z = μ + σ·ε is a stochastic node, but
//     it stays differentiable because the noise ε is a frozen leaf (requiresGrad = false). The
//     whole sample is then just `mu.add(std.mul(eps))`, assembled from primitive ops, so the
//     gradient flows back into μ and logσ² for free;
//
//   • the closed-form KL divergence between the diagonal Gaussian posterior N(μ, σ²) and the
//     unit prior N(0, I): KL = −½ Σ(1 + logσ² − μ² − σ²). It's a fused op below with a
//     hand-derived backward, gradchecked alongside everything else.
//
// The decoder emits pixel *logits*; the reconstruction term is `bceWithLogits` (a Bernoulli
// decoder). Training minimises  recon + β·KL  — the (negative) ELBO with a tunable KL weight.

import { Tensor } from './tensor';
import { Linear, applyActivation, mulberry32, type Activation } from './nn';

export { mulberry32 };

// ---- KL( N(μ, σ²) ‖ N(0, I) ), averaged over the batch -------------------------------
//
// With logvar = logσ², the per-sample KL is −½ Σ_j (1 + logvar_j − μ_j² − e^{logvar_j}); we
// sum that over the latent dims and average over the N rows. Derivatives:
//   ∂KL/∂μ_ij      =  μ_ij / N
//   ∂KL/∂logvar_ij = ½ (e^{logvar_ij} − 1) / N
export function klDivStandardNormal(mu: Tensor, logvar: Tensor): Tensor {
  if (mu.rows !== logvar.rows || mu.cols !== logvar.cols) {
    throw new Error('klDivStandardNormal shape mismatch');
  }
  const N = mu.rows;
  const n = mu.size;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lv = logvar.data[i];
    const m = mu.data[i];
    total += 1 + lv - m * m - Math.exp(lv);
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = (-0.5 * total) / N;
  out.op = 'klDivStdNormal';
  out.prev = [mu, logvar];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const gm = mu.grad;
    const gl = logvar.grad;
    for (let i = 0; i < n; i++) {
      gm[i] += (seed * mu.data[i]) / N;
      gl[i] += (seed * 0.5 * (Math.exp(logvar.data[i]) - 1)) / N;
    }
  };
  return out;
}

// z = μ + exp(½·logvar)·ε, with ε a fixed (non-differentiated) noise tensor of the same shape.
// Built entirely from primitive ops so the backward to μ and logvar is the engine's own.
export function reparameterize(mu: Tensor, logvar: Tensor, eps: Tensor): Tensor {
  const std = logvar.scale(0.5).exp();
  return mu.add(std.mul(eps));
}

// Sample a standard-normal noise tensor [rows, cols] from an rng (Box–Muller).
export function sampleNoise(rows: number, cols: number, rng: () => number): Tensor {
  const d = new Float64Array(rows * cols);
  for (let i = 0; i < d.length; i++) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    d[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return Tensor.fromFlat(d, rows, cols, false);
}

export interface VAEConfig {
  px: number; // input/output dimension (image is flattened, H*W)
  hidden: number[]; // encoder hidden widths; the decoder mirrors them in reverse
  latent: number; // latent dimension
  activation: Activation;
}

export interface VAEOutput {
  logits: Tensor; // decoder output (pre-sigmoid pixel logits)
  mu: Tensor;
  logvar: Tensor;
  z: Tensor;
}

// A symmetric MLP VAE. Encoder: px → hidden… → (μ, logσ²) each [N, latent]. Decoder:
// latent → reverse(hidden)… → px logits. Activations are applied on every hidden layer; the
// μ / logσ² heads and the output layer are plain linear.
export class VAE {
  cfg: VAEConfig;
  private enc: Linear[] = [];
  private muHead: Linear;
  private logvarHead: Linear;
  private dec: Linear[] = [];
  private outHead: Linear;
  private act: Activation;

  constructor(cfg: VAEConfig, rng: () => number) {
    this.cfg = cfg;
    this.act = cfg.activation;

    // Encoder.
    let prev = cfg.px;
    for (const h of cfg.hidden) {
      this.enc.push(new Linear(prev, h, cfg.activation, rng));
      prev = h;
    }
    this.muHead = new Linear(prev, cfg.latent, 'linear', rng);
    this.logvarHead = new Linear(prev, cfg.latent, 'linear', rng);

    // Decoder (mirror).
    prev = cfg.latent;
    const rev = [...cfg.hidden].reverse();
    for (const h of rev) {
      this.dec.push(new Linear(prev, h, cfg.activation, rng));
      prev = h;
    }
    this.outHead = new Linear(prev, cfg.px, 'linear', rng);
  }

  encode(x: Tensor): { mu: Tensor; logvar: Tensor } {
    let h = x;
    for (const l of this.enc) h = applyActivation(l.forward(h), this.act);
    return { mu: this.muHead.forward(h), logvar: this.logvarHead.forward(h) };
  }

  decode(z: Tensor): Tensor {
    let h = z;
    for (const l of this.dec) h = applyActivation(l.forward(h), this.act);
    return this.outHead.forward(h);
  }

  // Full pass with a supplied noise tensor (caller controls ε so gradient checks and
  // deterministic eval are reproducible). Pass an all-zero ε to get z = μ (the eval path).
  forward(x: Tensor, eps: Tensor): VAEOutput {
    const { mu, logvar } = this.encode(x);
    const z = reparameterize(mu, logvar, eps);
    const logits = this.decode(z);
    return { logits, mu, logvar, z };
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.enc) ps.push(...l.parameters());
    ps.push(...this.muHead.parameters(), ...this.logvarHead.parameters());
    for (const l of this.dec) ps.push(...l.parameters());
    ps.push(...this.outHead.parameters());
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

export interface VAEPreset {
  id: string;
  label: string;
  hidden: number[];
}

export const VAE_PRESETS: VAEPreset[] = [
  { id: 'tiny', label: 'Tiny · [128]', hidden: [128] },
  { id: 'standard', label: 'Standard · [256, 96]', hidden: [256, 96] },
  { id: 'deep', label: 'Deep · [256, 128, 64]', hidden: [256, 128, 64] },
];
