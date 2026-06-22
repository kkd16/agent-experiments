// A from-scratch Denoising Diffusion Probabilistic Model (DDPM/DDIM) on the engine's
// reverse-mode autograd.
//
// A diffusion model learns to *reverse* a fixed Gaussian noising process. The forward process
// gradually corrupts a data sample x0 into pure noise over T steps,
//
//     q(x_t | x_{t-1}) = N( sqrt(alpha_t)·x_{t-1}, beta_t·I ),
//
// which has the convenient closed form (the "forward marginal")
//
//     q(x_t | x0) = N( sqrt(abar_t)·x0, (1 - abar_t)·I ),   abar_t = prod_{s<=t} alpha_s,
//
// so a noised sample is just  x_t = sqrt(abar_t)·x0 + sqrt(1 - abar_t)·eps,  eps ~ N(0, I).
// We train a network eps_theta(x_t, t) to predict that eps (Ho et al. 2020's "simple" objective,
// an MSE on the noise), and *sample* by walking the prediction backwards from x_T ~ N(0, I) to a
// clean x0. Everything here is built from the engine's primitive ops, hand-derived, and the
// schedule/posterior identities are proven in `selftest.ts`.

import { Tensor } from './tensor';
import { Linear } from './nn';
import { layerNorm, embedding } from './ops';

export type ScheduleKind = 'linear' | 'cosine';

// ---- noise schedule -----------------------------------------------------------------
//
// All arrays are length T, 0-indexed: entry i corresponds to diffusion step t = i+1 (t in 1..T).
// `alphaBarPrev[i]` is abar_{t-1} with the convention abar_0 = 1.
export class NoiseSchedule {
  readonly T: number;
  readonly kind: ScheduleKind;
  readonly beta: Float64Array;
  readonly alpha: Float64Array;
  readonly alphaBar: Float64Array;
  readonly alphaBarPrev: Float64Array;
  readonly sqrtAlphaBar: Float64Array; // sqrt(abar_t)
  readonly sqrtOneMinusAlphaBar: Float64Array; // sqrt(1 - abar_t)
  readonly posteriorVar: Float64Array; // beta~_t = (1-abar_{t-1})/(1-abar_t) · beta_t

  constructor(T: number, kind: ScheduleKind, betaStart = 1e-4, betaEnd = 0.02) {
    this.T = T;
    this.kind = kind;
    this.beta = new Float64Array(T);
    this.alpha = new Float64Array(T);
    this.alphaBar = new Float64Array(T);
    this.alphaBarPrev = new Float64Array(T);
    this.sqrtAlphaBar = new Float64Array(T);
    this.sqrtOneMinusAlphaBar = new Float64Array(T);
    this.posteriorVar = new Float64Array(T);

    if (kind === 'cosine') {
      // Nichol & Dhariwal: abar_t = f(t)/f(0), f(t) = cos^2( ((t/T)+s)/(1+s) · pi/2 ), s = 0.008.
      const s = 0.008;
      const f = (t: number) => {
        const a = ((t / T + s) / (1 + s)) * (Math.PI / 2);
        return Math.cos(a) * Math.cos(a);
      };
      const f0 = f(0);
      let prevBar = 1;
      for (let i = 0; i < T; i++) {
        const t = i + 1;
        const bar = f(t) / f0;
        // beta_t = 1 - abar_t/abar_{t-1}, clipped to keep the chain well-conditioned.
        let b = 1 - bar / prevBar;
        b = Math.max(1e-8, Math.min(0.999, b));
        this.beta[i] = b;
        prevBar = bar;
      }
    } else {
      // Linear beta schedule.
      for (let i = 0; i < T; i++) {
        this.beta[i] = T > 1 ? betaStart + (betaEnd - betaStart) * (i / (T - 1)) : betaStart;
      }
    }

    let bar = 1;
    for (let i = 0; i < T; i++) {
      const a = 1 - this.beta[i];
      this.alpha[i] = a;
      this.alphaBarPrev[i] = bar; // abar_{t-1}
      bar *= a;
      this.alphaBar[i] = bar; // abar_t
      this.sqrtAlphaBar[i] = Math.sqrt(bar);
      this.sqrtOneMinusAlphaBar[i] = Math.sqrt(Math.max(0, 1 - bar));
    }
    for (let i = 0; i < T; i++) {
      const oneMinusBar = 1 - this.alphaBar[i];
      this.posteriorVar[i] = oneMinusBar > 0 ? ((1 - this.alphaBarPrev[i]) / oneMinusBar) * this.beta[i] : 0;
    }
  }

  // Signal-to-noise ratio abar_t / (1 - abar_t) — a clean way to read the schedule.
  snr(i: number): number {
    const bar = this.alphaBar[i];
    return bar / Math.max(1e-12, 1 - bar);
  }
}

// ---- forward process ----------------------------------------------------------------

// x_t = sqrt(abar_t)·x0 + sqrt(1-abar_t)·eps, per row using that row's timestep index `ti` (0-based,
// = t-1). `x0` and `eps` are [B, px]; `tIdx` is length B. Returns a plain Float64Array [B*px] (the
// forward process is not differentiated — it builds the network's *input*).
export function qSampleData(
  x0: Float64Array,
  eps: Float64Array,
  tIdx: Int32Array,
  px: number,
  sched: NoiseSchedule,
): Float64Array {
  const B = tIdx.length;
  const out = new Float64Array(B * px);
  for (let b = 0; b < B; b++) {
    const sa = sched.sqrtAlphaBar[tIdx[b]];
    const so = sched.sqrtOneMinusAlphaBar[tIdx[b]];
    const base = b * px;
    for (let p = 0; p < px; p++) out[base + p] = sa * x0[base + p] + so * eps[base + p];
  }
  return out;
}

// ---- time embedding -----------------------------------------------------------------

// Transformer-style sinusoidal features of a normalised timestep tau in [0,1]. Returns a [B, dim]
// frozen leaf (the conditioning input — not a learnable parameter). For each frequency f_k the
// embedding carries [sin(tau·f_k·2pi), cos(tau·f_k·2pi)] with log-spaced frequencies.
export function sinusoidalTimeEmbedding(tIdx: Int32Array, T: number, dim: number): Tensor {
  const B = tIdx.length;
  const half = Math.max(1, Math.floor(dim / 2));
  const d = new Float64Array(B * dim);
  for (let b = 0; b < B; b++) {
    const tau = T > 1 ? tIdx[b] / (T - 1) : 0; // in [0,1]
    const base = b * dim;
    for (let k = 0; k < half; k++) {
      // frequencies from 1 .. ~1000 (log-spaced); scaled by 2pi so a full sweep covers the range.
      const freq = Math.exp((k / half) * Math.log(1000)) * 2 * Math.PI;
      d[base + 2 * k] = Math.sin(tau * freq);
      if (2 * k + 1 < dim) d[base + 2 * k + 1] = Math.cos(tau * freq);
    }
  }
  return Tensor.fromFlat(d, B, dim, false);
}

// ---- the denoiser network -----------------------------------------------------------

export interface DenoiserConfig {
  px: number;
  hidden: number; // H — block width
  depth: number; // number of residual blocks
  timeDim: number; // sinusoidal-embedding dimension
  numClasses: number; // 0 ⇒ unconditional; otherwise a learned class embedding (+1 null token)
}

interface Block {
  norm1g: Tensor;
  norm1b: Tensor;
  lin1: Linear;
  lin2: Linear;
}

// A time-conditioned residual MLP that predicts the noise eps_theta(x_t, t[, class]). The
// conditioning vector (time MLP output, plus an optional learned class embedding) is injected into
// the stem and re-added inside every residual block — the standard way diffusion nets feed t.
export class Denoiser {
  cfg: DenoiserConfig;
  private inProj: Linear;
  private temb1: Linear;
  private temb2: Linear;
  private classTable: Tensor | null;
  private blocks: Block[] = [];
  private outProj: Linear;

  constructor(cfg: DenoiserConfig, rng: () => number) {
    this.cfg = cfg;
    const H = cfg.hidden;
    this.inProj = new Linear(cfg.px, H, 'silu', rng);
    this.temb1 = new Linear(cfg.timeDim, H, 'silu', rng);
    this.temb2 = new Linear(H, H, 'silu', rng);
    if (cfg.numClasses > 0) {
      // (numClasses + 1) rows: the last index is the "null" token for classifier-free guidance.
      const V = cfg.numClasses + 1;
      const data = new Float64Array(V * H);
      const gain = Math.sqrt(1 / H);
      for (let i = 0; i < data.length; i++) {
        // small Gaussian init via two uniforms (Box–Muller) so embeddings start near zero.
        let u = 0;
        let v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        data[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * gain;
      }
      this.classTable = Tensor.fromFlat(data, V, H, true).named('classEmb');
    } else {
      this.classTable = null;
    }
    for (let i = 0; i < cfg.depth; i++) {
      this.blocks.push({
        norm1g: Tensor.fromFlat(new Float64Array(H).fill(1), 1, H, true).named('γ'),
        norm1b: Tensor.zeros(1, H, true).named('β'),
        lin1: new Linear(H, H, 'silu', rng),
        lin2: new Linear(H, H, 'linear', rng),
      });
    }
    this.outProj = new Linear(H, cfg.px, 'linear', rng);
  }

  // Build the conditioning vector cond = silu(temb2(silu(temb1(timeEmb)))) [+ classEmb], [B, H].
  private conditioning(timeEmb: Tensor, classIds: Int32Array | null): Tensor {
    let c = this.temb1.forward(timeEmb).silu();
    c = this.temb2.forward(c).silu();
    if (this.classTable && classIds) {
      c = c.add(embedding(this.classTable, classIds));
    }
    return c;
  }

  // eps_theta(x_t, t[, class]). `timeEmb` is [B, timeDim] (frozen); `classIds` is [B] (or null for
  // unconditional / when the model is unconditional). Returns the predicted noise [B, px].
  forward(xt: Tensor, timeEmb: Tensor, classIds: Int32Array | null): Tensor {
    const cond = this.conditioning(timeEmb, classIds);
    let h = this.inProj.forward(xt).silu().add(cond);
    for (const blk of this.blocks) {
      const res = h;
      let z = layerNorm(h, blk.norm1g, blk.norm1b);
      z = blk.lin1.forward(z).silu();
      z = z.add(cond);
      z = blk.lin2.forward(z);
      h = res.add(z);
    }
    return this.outProj.forward(h);
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    ps.push(...this.inProj.parameters(), ...this.temb1.parameters(), ...this.temb2.parameters());
    if (this.classTable) ps.push(this.classTable);
    for (const b of this.blocks) ps.push(b.norm1g, b.norm1b, ...b.lin1.parameters(), ...b.lin2.parameters());
    ps.push(...this.outProj.parameters());
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

// ---- reverse process (sampling) -----------------------------------------------------

// Classifier-free guidance (Ho & Salimans): combine a conditional and unconditional noise
// prediction with guidance *strength* w,
//   eps~ = eps_cond + w·(eps_cond - eps_uncond) = (1+w)·eps_cond - w·eps_uncond.
// w = 0 reduces exactly to the plain conditional prediction; larger w sharpens class identity.
export function classifierFreeGuidance(epsCond: Float64Array, epsUncond: Float64Array, w: number): Float64Array {
  const out = new Float64Array(epsCond.length);
  for (let i = 0; i < out.length; i++) out[i] = epsCond[i] + w * (epsCond[i] - epsUncond[i]);
  return out;
}

// Predicted clean sample x̂0 from x_t and an eps prediction:  x̂0 = (x_t - sqrt(1-abar_t)·eps)/sqrt(abar_t),
// optionally clamped to ±`clampAbs` (the data range). Clamping x̂0 is the standard cure for the DDIM
// blow-up at large t, where sqrt(abar_t) → 0 amplifies any error in the noise estimate.
export function predictX0(
  xt: Float64Array,
  eps: Float64Array,
  ti: number,
  sched: NoiseSchedule,
  clampAbs = Infinity,
): Float64Array {
  const sa = sched.sqrtAlphaBar[ti];
  const so = sched.sqrtOneMinusAlphaBar[ti];
  const out = new Float64Array(xt.length);
  for (let i = 0; i < out.length; i++) {
    let v = (xt[i] - so * eps[i]) / Math.max(1e-8, sa);
    if (v > clampAbs) v = clampAbs;
    else if (v < -clampAbs) v = -clampAbs;
    out[i] = v;
  }
  return out;
}

// One ancestral DDPM reverse step from x_t (timestep index ti) to x_{t-1}. Written through the
// (optionally clamped) x̂0 prediction and the true forward-posterior mean μ̃_t — algebraically the
// classic  1/sqrt(alpha_t)·(x_t - beta_t/sqrt(1-abar_t)·eps)  when x̂0 is left unclamped:
//   x_{t-1} = μ̃_t(x̂0, x_t) + sqrt(beta~_t)·z,  z ~ N(0, I)  (z = 0 at the final step).
export function ddpmStep(
  xt: Float64Array,
  eps: Float64Array,
  ti: number,
  sched: NoiseSchedule,
  noise: Float64Array | null,
  clampAbs = Infinity,
): Float64Array {
  const x0 = predictX0(xt, eps, ti, sched, clampAbs);
  const mu = posteriorMean(x0, xt, ti, sched);
  const sigma = Math.sqrt(Math.max(0, sched.posteriorVar[ti]));
  const out = new Float64Array(xt.length);
  for (let i = 0; i < out.length; i++) out[i] = mu[i] + (noise ? sigma * noise[i] : 0);
  return out;
}

// One DDIM reverse step from x_t (index ti) to x_{t'} (index tiPrev, or -1 for the t=0 clean image):
//   x̂0 = predictX0(x_t, eps);
//   x_{t'} = sqrt(abar_{t'})·x̂0 + sqrt(1 - abar_{t'} - sigma^2)·eps + sigma·z,
//   sigma = eta·sqrt((1-abar_{t'})/(1-abar_t))·sqrt(1 - abar_t/abar_{t'}).  eta = 0 ⇒ deterministic.
export function ddimStep(
  xt: Float64Array,
  eps: Float64Array,
  ti: number,
  tiPrev: number,
  sched: NoiseSchedule,
  eta: number,
  noise: Float64Array | null,
  clampAbs = Infinity,
): Float64Array {
  const x0 = predictX0(xt, eps, ti, sched, clampAbs);
  const barT = sched.alphaBar[ti];
  const barPrev = tiPrev >= 0 ? sched.alphaBar[tiPrev] : 1; // abar = 1 at t = 0 (clean image)
  if (tiPrev < 0) return x0; // last step lands on the predicted clean image
  let sigma = 0;
  if (eta > 0) {
    const ratio = (1 - barPrev) / Math.max(1e-12, 1 - barT);
    sigma = eta * Math.sqrt(Math.max(0, ratio)) * Math.sqrt(Math.max(0, 1 - barT / Math.max(1e-12, barPrev)));
  }
  const dirCoef = Math.sqrt(Math.max(0, 1 - barPrev - sigma * sigma));
  const sqrtBarPrev = Math.sqrt(barPrev);
  const out = new Float64Array(xt.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = sqrtBarPrev * x0[i] + dirCoef * eps[i] + (noise ? sigma * noise[i] : 0);
  }
  return out;
}

// The true forward-posterior mean μ̃_t = E[x_{t-1} | x_t, x_0] used by the DDPM update; this is the
// quantity the network implicitly targets. Surfaced for the self-test posterior identity.
//   μ̃_t = ( sqrt(abar_{t-1})·beta_t/(1-abar_t) )·x0 + ( sqrt(alpha_t)·(1-abar_{t-1})/(1-abar_t) )·x_t
export function posteriorMean(x0: Float64Array, xt: Float64Array, ti: number, sched: NoiseSchedule): Float64Array {
  const beta = sched.beta[ti];
  const barT = sched.alphaBar[ti];
  const barPrev = sched.alphaBarPrev[ti];
  const a = sched.alpha[ti];
  const oneMinusBar = Math.max(1e-12, 1 - barT);
  const cx0 = (Math.sqrt(barPrev) * beta) / oneMinusBar;
  const cxt = (Math.sqrt(a) * (1 - barPrev)) / oneMinusBar;
  const out = new Float64Array(x0.length);
  for (let i = 0; i < out.length; i++) out[i] = cx0 * x0[i] + cxt * xt[i];
  return out;
}

// Build the descending list of timestep indices for a k-step DDIM run over a T-step schedule
// (e.g. T=200, k=50 → 50 evenly-spaced indices from T-1 down to 0). Always includes the first step.
export function ddimTimesteps(T: number, k: number): number[] {
  const steps = Math.max(1, Math.min(T, k));
  const idx: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = Math.round((T - 1) * (1 - i / steps));
    idx.push(t);
  }
  // de-dup while preserving descending order
  const seen = new Set<number>();
  const out: number[] = [];
  for (const t of idx) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export interface DiffPreset {
  id: string;
  label: string;
  hidden: number;
  depth: number;
}

export const DIFF_PRESETS: DiffPreset[] = [
  { id: 'tiny', label: 'Tiny · 96×2', hidden: 96, depth: 2 },
  { id: 'standard', label: 'Standard · 128×3', hidden: 128, depth: 3 },
  { id: 'deep', label: 'Deep · 192×4', hidden: 192, depth: 4 },
];
