// Bayesian deep learning — predictive uncertainty from scratch.
//
// This module powers the "Uncertainty" lab. It implements three classic ways to make a neural
// network report *how much it doesn't know*, all built on the same hand-rolled tensor autograd:
//
//   1. Bayes-by-Backprop (Blundell et al., 2015) — a *variational* network whose every weight is
//      a Gaussian q(w)=N(μ, σ²) with σ=softplus(ρ). The forward pass samples weights with the
//      reparameterization trick (w = μ + σ⊙ε), so the ELBO stays differentiable, and the loss is
//      data-NLL + (1/N)·KL(q‖prior). Sampling weights at test time gives epistemic uncertainty.
//   2. MC-Dropout (Gal & Ghahramani, 2016) — an ordinary net trained with dropout, but with
//      dropout *kept on at test time*; each stochastic forward pass is a sample from an implicit
//      posterior, so the spread across passes is (approximately) Bayesian uncertainty.
//   3. Deep Ensembles (Lakshminarayanan et al., 2017) — M independently-initialised nets, each
//      trained on the same data; the disagreement between members is the epistemic signal.
//
// All three predict a *heteroscedastic* Gaussian per input — both a mean and a log-variance —
// so the lab can cleanly separate the two faces of uncertainty:
//   • aleatoric  (irreducible data noise)         = average of the per-sample variances,
//   • epistemic  (model uncertainty, reducible)   = variance of the per-sample means.
// Their sum (the law of total variance) is the predictive variance the bands are drawn from.
//
// No ML libraries: the Gaussian NLL and the Gaussian KL are hand-derived below and gradchecked
// against finite differences in `selftest.ts`, exactly like every other op in the engine.

import { Tensor } from './tensor';
import { Linear, applyActivation, mulberry32, type Activation } from './nn';
import { dropout } from './ops';

// ---- numerics ----------------------------------------------------------------------

// Standard-normal sample via Box–Muller from a uniform rng.
export function randnFrom(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function softplus(x: number): number {
  return x > 30 ? x : Math.log1p(Math.exp(x));
}
function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

// A log-variance is clamped into this band before being exp()'d so a confidently-low-noise fit
// can't send the precision e^{-logVar} to infinity. The window is far wider than any sane test
// point, so gradchecks (which sample log-variances in [-1,1]) hit the exact, unclamped branch.
const LV_MIN = -7;
const LV_MAX = 7;

// ---- losses ------------------------------------------------------------------------

// Heteroscedastic Gaussian negative log-likelihood, averaged over the batch. Given a predicted
// mean μ and log-variance s=log σ² (each [N,1]) and a target y [N,1]:
//   NLL = (1/N) Σ ½·s + ½·(y−μ)²·e^{−s}      (the constant ½·log 2π is dropped).
// The fused backward gives the clean gradients
//   ∂/∂μ = (μ−y)·e^{−s}/N,   ∂/∂s = ½·(1 − (y−μ)²·e^{−s})/N
// — the precision-weighted residual that makes the model learn to *widen* its variance exactly
// where it cannot fit the mean.
export function gaussianNLL(mu: Tensor, logVar: Tensor, target: Tensor): Tensor {
  if (mu.rows !== target.rows || mu.cols !== target.cols || logVar.rows !== mu.rows || logVar.cols !== mu.cols) {
    throw new Error('gaussianNLL shape mismatch');
  }
  const n = mu.size;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lv = logVar.data[i];
    const lvc = lv < LV_MIN ? LV_MIN : lv > LV_MAX ? LV_MAX : lv;
    const d = target.data[i] - mu.data[i];
    total += 0.5 * lv + 0.5 * d * d * Math.exp(-lvc);
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / n;
  out.op = 'gaussianNLL';
  out.prev = [mu, logVar];
  out.backwardFn = () => {
    const seed = out.grad[0];
    for (let i = 0; i < n; i++) {
      const lv = logVar.data[i];
      const clamped = lv < LV_MIN || lv > LV_MAX;
      const lvc = lv < LV_MIN ? LV_MIN : lv > LV_MAX ? LV_MAX : lv;
      const e = Math.exp(-lvc);
      const dmt = mu.data[i] - target.data[i];
      mu.grad[i] += (seed * dmt * e) / n;
      // d/dlv of ½·lv is ½; d/dlv of ½·d²·e^{−lv} is −½·d²·e (zero once clamped/saturated).
      logVar.grad[i] += (seed * (0.5 + (clamped ? 0 : -0.5 * dmt * dmt * e))) / n;
    }
  };
  return out;
}

// KL divergence from a diagonal-Gaussian variational posterior q=N(μ, σ²), σ=softplus(ρ), to a
// zero-mean Gaussian prior N(0, σ_p²), summed over every weight:
//   KL = Σ  log(σ_p/σ) + (σ² + μ²)/(2σ_p²) − ½.
// Differentiated through σ=softplus(ρ) (so ∂σ/∂ρ = sigmoid(ρ)). This is the regulariser that
// pulls unused weights back to the prior — the Occam term in the ELBO.
export function gaussianKL(mu: Tensor, rho: Tensor, priorSigma: number): Tensor {
  if (mu.rows !== rho.rows || mu.cols !== rho.cols) throw new Error('gaussianKL shape mismatch');
  const n = mu.size;
  const sp2 = priorSigma * priorSigma;
  const logSp = Math.log(priorSigma);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const s = softplus(rho.data[i]);
    const m = mu.data[i];
    total += logSp - Math.log(s) + (s * s + m * m) / (2 * sp2) - 0.5;
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total;
  out.op = 'gaussianKL';
  out.prev = [mu, rho];
  out.backwardFn = () => {
    const seed = out.grad[0];
    for (let i = 0; i < n; i++) {
      const r = rho.data[i];
      const s = softplus(r);
      const dsdr = sigmoid(r);
      mu.grad[i] += seed * (mu.data[i] / sp2);
      rho.grad[i] += seed * (-1 / s + s / sp2) * dsdr;
    }
  };
  return out;
}

// Map a clamped log-variance to a variance, matching `gaussianNLL`'s precision floor/ceiling.
export function varFromLogVar(logVar: number): number {
  const lvc = logVar < LV_MIN ? LV_MIN : logVar > LV_MAX ? LV_MAX : logVar;
  return Math.exp(lvc);
}

// ---- a variational (Bayes-by-Backprop) linear layer --------------------------------

export interface LayerEps {
  epsW: Tensor;
  epsB: Tensor;
}

// y = x·W + b with W ~ N(μ_W, softplus(ρ_W)²) and b likewise. Forward draws W,b with the
// reparameterization trick from supplied noise so the whole path is on the tape. `rhoInit` sets
// the starting posterior width (a small negative value ⇒ a tight, near-deterministic start).
export class BayesLinear {
  muW: Tensor;
  rhoW: Tensor;
  muB: Tensor;
  rhoB: Tensor;
  readonly inF: number;
  readonly outF: number;

  constructor(inF: number, outF: number, act: Activation, rng: () => number, rhoInit: number) {
    this.inF = inF;
    this.outF = outF;
    const heLike = act === 'relu' || act === 'leaky_relu' || act === 'elu' || act === 'gelu' || act === 'silu';
    const gain = heLike ? Math.sqrt(2 / inF) : Math.sqrt(1 / inF);
    const w = new Float64Array(inF * outF);
    for (let i = 0; i < w.length; i++) w[i] = randnFrom(rng) * gain;
    this.muW = Tensor.fromFlat(w, inF, outF, true).named('μW');
    this.rhoW = Tensor.fromFlat(new Float64Array(inF * outF).fill(rhoInit), inF, outF, true).named('ρW');
    this.muB = Tensor.zeros(1, outF, true).named('μb');
    this.rhoB = Tensor.fromFlat(new Float64Array(outF).fill(rhoInit), 1, outF, true).named('ρb');
  }

  sampleEps(rng: () => number): LayerEps {
    const ew = new Float64Array(this.inF * this.outF);
    for (let i = 0; i < ew.length; i++) ew[i] = randnFrom(rng);
    const eb = new Float64Array(this.outF);
    for (let i = 0; i < eb.length; i++) eb[i] = randnFrom(rng);
    return { epsW: Tensor.fromFlat(ew, this.inF, this.outF, false), epsB: Tensor.fromFlat(eb, 1, this.outF, false) };
  }

  forwardWith(x: Tensor, eps: LayerEps): Tensor {
    const W = this.muW.add(this.rhoW.softplus().mul(eps.epsW));
    const b = this.muB.add(this.rhoB.softplus().mul(eps.epsB));
    return x.matmul(W).add(b);
  }

  // The posterior *mean* network — deterministic, used for the mean prediction line.
  forwardMean(x: Tensor): Tensor {
    return x.matmul(this.muW).add(this.muB);
  }

  kl(priorSigma: number): Tensor {
    return gaussianKL(this.muW, this.rhoW, priorSigma).add(gaussianKL(this.muB, this.rhoB, priorSigma));
  }

  parameters(): Tensor[] {
    return [this.muW, this.rhoW, this.muB, this.rhoB];
  }
}

// ---- the three model families ------------------------------------------------------

// All models output [N,2] = (mean, log-variance) per input.
export const OUT_DIM = 2;

function flatten(ps: Tensor[]): number[] {
  const out: number[] = [];
  for (const p of ps) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
  return out;
}
function unflatten(ps: Tensor[], flat: number[]): boolean {
  let total = 0;
  for (const p of ps) total += p.size;
  if (flat.length !== total) return false;
  let k = 0;
  for (const p of ps) for (let i = 0; i < p.size; i++) p.data[i] = flat[k++];
  return true;
}

// A Bayes-by-Backprop MLP: a stack of variational linears with one activation between them.
export class BayesMLP {
  layers: BayesLinear[];
  acts: Activation[];

  constructor(inDim: number, hidden: number[], rng: () => number, activation: Activation, rhoInit: number) {
    this.layers = [];
    this.acts = [];
    let prev = inDim;
    for (const h of hidden) {
      this.layers.push(new BayesLinear(prev, h, activation, rng, rhoInit));
      this.acts.push(activation);
      prev = h;
    }
    this.layers.push(new BayesLinear(prev, OUT_DIM, 'linear', rng, rhoInit));
    this.acts.push('linear');
  }

  sampleAllEps(rng: () => number): LayerEps[] {
    return this.layers.map((l) => l.sampleEps(rng));
  }

  forwardWith(x: Tensor, epsList: LayerEps[]): Tensor {
    let h = x;
    const last = this.layers.length - 1;
    for (let i = 0; i < this.layers.length; i++) {
      const z = this.layers[i].forwardWith(h, epsList[i]);
      h = i < last ? applyActivation(z, this.acts[i]) : z;
    }
    return h;
  }

  forward(x: Tensor, rng: () => number): Tensor {
    return this.forwardWith(x, this.sampleAllEps(rng));
  }

  forwardMean(x: Tensor): Tensor {
    let h = x;
    const last = this.layers.length - 1;
    for (let i = 0; i < this.layers.length; i++) {
      const z = this.layers[i].forwardMean(h);
      h = i < last ? applyActivation(z, this.acts[i]) : z;
    }
    return h;
  }

  kl(priorSigma: number): Tensor {
    let acc = this.layers[0].kl(priorSigma);
    for (let i = 1; i < this.layers.length; i++) acc = acc.add(this.layers[i].kl(priorSigma));
    return acc;
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.layers) ps.push(...l.parameters());
    return ps;
  }
  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }
  exportWeights(): number[] {
    return flatten(this.parameters());
  }
  importWeights(flat: number[]): boolean {
    return unflatten(this.parameters(), flat);
  }
}

export interface DetForwardOpts {
  training: boolean;
  dropP: number;
  rng: () => number;
}

// A plain deterministic MLP (reusing the engine's gradchecked `Linear`), outputting (mean, logVar).
// Dropout can be toggled on for *inference* — that is exactly what turns it into an MC-Dropout
// sampler. Members of a deep ensemble are just DetMLPs with different seeds.
export class DetMLP {
  layers: Linear[];
  acts: Activation[];

  constructor(inDim: number, hidden: number[], rng: () => number, activation: Activation) {
    this.layers = [];
    this.acts = [];
    let prev = inDim;
    for (const h of hidden) {
      this.layers.push(new Linear(prev, h, activation, rng));
      this.acts.push(activation);
      prev = h;
    }
    this.layers.push(new Linear(prev, OUT_DIM, 'linear', rng));
    this.acts.push('linear');
  }

  forward(x: Tensor, opts: DetForwardOpts): Tensor {
    let h = x;
    const last = this.layers.length - 1;
    for (let i = 0; i < this.layers.length; i++) {
      const z = this.layers[i].forward(h);
      if (i < last) {
        let a = applyActivation(z, this.acts[i]);
        if (opts.dropP > 0 && opts.training) a = dropout(a, opts.dropP, true, opts.rng);
        h = a;
      } else {
        h = z;
      }
    }
    return h;
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.layers) ps.push(...l.parameters());
    return ps;
  }
  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }
  exportWeights(): number[] {
    return flatten(this.parameters());
  }
  importWeights(flat: number[]): boolean {
    return unflatten(this.parameters(), flat);
  }
}

// M independently-initialised DetMLPs.
export class Ensemble {
  members: DetMLP[];

  constructor(inDim: number, hidden: number[], rng: () => number, activation: Activation, size: number) {
    this.members = [];
    for (let m = 0; m < size; m++) {
      // Each member gets its own PRNG stream so inits (and the data order, set by the trainer)
      // differ — that disagreement is the ensemble's epistemic signal.
      const sub = mulberry32((Math.floor(rng() * 1e9) ^ (0x9e3779b9 * (m + 1))) >>> 0);
      this.members.push(new DetMLP(inDim, hidden, sub, activation));
    }
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const m of this.members) ps.push(...m.parameters());
    return ps;
  }
  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }
  exportWeights(): number[] {
    return flatten(this.parameters());
  }
  importWeights(flat: number[]): boolean {
    return unflatten(this.parameters(), flat);
  }
}

// ---- predictive moment-matching ----------------------------------------------------

export interface Predictive {
  mean: Float64Array; // [G] predictive mean per query point
  aleatoric: Float64Array; // [G] irreducible data-noise variance (avg of per-sample variances)
  epistemic: Float64Array; // [G] model variance (variance of per-sample means)
}

// Combine S stochastic forward passes — each giving a per-point mean and variance — into the
// mixture's first two moments. Predictive mean = mean of means; aleatoric = mean of variances;
// epistemic = variance of means (the law of total variance). `means`/`vars` are [S][G].
export function mixtureMoments(means: Float64Array[], vars: Float64Array[], G: number): Predictive {
  const S = means.length;
  const mean = new Float64Array(G);
  const aleatoric = new Float64Array(G);
  const epistemic = new Float64Array(G);
  for (let g = 0; g < G; g++) {
    let mAcc = 0;
    let vAcc = 0;
    for (let s = 0; s < S; s++) {
      mAcc += means[s][g];
      vAcc += vars[s][g];
    }
    const mBar = mAcc / S;
    mean[g] = mBar;
    aleatoric[g] = vAcc / S;
    let eAcc = 0;
    for (let s = 0; s < S; s++) {
      const d = means[s][g] - mBar;
      eAcc += d * d;
    }
    epistemic[g] = eAcc / S;
  }
  return { mean, aleatoric, epistemic };
}

// Mixture predictive NLL at a single target y given S component (mean, var) pairs:
//   −log( (1/S) Σ N(y; mean_s, var_s) ),  computed with the log-sum-exp trick.
export function mixtureNLL(y: number, means: number[], vars: number[]): number {
  const S = means.length;
  const logS = Math.log(S);
  const half = 0.5 * Math.log(2 * Math.PI);
  let max = -Infinity;
  const logp = new Array<number>(S);
  for (let s = 0; s < S; s++) {
    const v = vars[s];
    const d = y - means[s];
    logp[s] = -half - 0.5 * Math.log(v) - (d * d) / (2 * v);
    if (logp[s] > max) max = logp[s];
  }
  let sum = 0;
  for (let s = 0; s < S; s++) sum += Math.exp(logp[s] - max);
  return -(max + Math.log(sum) - logS);
}

// Inverse standard-normal CDF (probit), Acklam's rational approximation — used to turn a
// confidence level p into the z that bounds the central p-credible interval (±z·σ).
export function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x: number;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

// ---- the 1-D regression datasets ---------------------------------------------------

export type RegFuncKind = 'sine' | 'cubic' | 'step' | 'sinc' | 'damped';

export interface RegFuncMeta {
  id: RegFuncKind;
  label: string;
}

export const REG_FUNCS: RegFuncMeta[] = [
  { id: 'sine', label: 'two-tone sine' },
  { id: 'cubic', label: 'cubic' },
  { id: 'step', label: 'smooth step' },
  { id: 'sinc', label: 'sinc' },
  { id: 'damped', label: 'damped wave' },
];

// The clean target function (no noise) — also the dashed "truth" curve in the plot.
export function trueFn(kind: RegFuncKind, x: number): number {
  switch (kind) {
    case 'sine':
      return 0.8 * Math.sin(1.8 * x) + 0.28 * Math.sin(3.3 * x);
    case 'cubic':
      return 0.32 * x * x * x - 0.7 * x;
    case 'step':
      return 0.85 * Math.tanh(3.2 * x);
    case 'sinc': {
      const z = 2.6 * x;
      return Math.abs(z) < 1e-6 ? 1 : (1.05 * Math.sin(z)) / z;
    }
    case 'damped':
      return 1.2 * Math.exp(-0.28 * x * x) * Math.sin(3.4 * x);
  }
}

// Half-width of the data-bearing region and of the plotted view window. Data lives in two bands
// inside ±DATA_HALF with a central gap; the wider ±VIEW_HALF window exposes the extrapolation
// regions on both ends — both places epistemic uncertainty should visibly grow.
export const DATA_HALF = 2.2;
export const VIEW_HALF = 3.4;
export const GAP_HALF = 0.55; // central [−GAP_HALF, GAP_HALF] is left empty

// Per-x observation-noise standard deviation. Homoscedastic by default; the heteroscedastic
// option ramps the noise from left to right so the lab can show *aleatoric* uncertainty grow.
export function noiseStdAt(x: number, noise: number, hetero: boolean): number {
  if (!hetero) return noise;
  const t = (x + DATA_HALF) / (2 * DATA_HALF); // 0..1 across the data band
  return noise * (0.25 + 1.5 * Math.max(0, Math.min(1, t)));
}

export interface Reg1D {
  X: Float64Array; // [n]
  y: Float64Array; // [n]
  n: number;
  kind: RegFuncKind;
  noise: number;
  hetero: boolean;
}

// Sample n points split between two bands (a gap in the middle), with Gaussian observation noise.
export function makeReg1D(kind: RegFuncKind, n: number, noise: number, hetero: boolean, seed: number): Reg1D {
  const rng = mulberry32(seed >>> 0);
  const X = new Float64Array(n);
  const y = new Float64Array(n);
  const leftLo = -DATA_HALF;
  const leftHi = -GAP_HALF;
  const rightLo = GAP_HALF;
  const rightHi = DATA_HALF;
  for (let i = 0; i < n; i++) {
    let x: number;
    if (i % 2 === 0) x = leftLo + rng() * (leftHi - leftLo);
    else x = rightLo + rng() * (rightHi - rightLo);
    X[i] = x;
    y[i] = trueFn(kind, x) + randnFrom(rng) * noiseStdAt(x, noise, hetero);
  }
  return { X, y, n, kind, noise, hetero };
}
