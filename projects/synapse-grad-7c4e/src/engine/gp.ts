// Gaussian processes — exact non-parametric Bayesian regression, on the same hand-rolled tape.
//
// A GP places a prior *directly over functions*: any finite set of inputs X has a joint
// Gaussian prior f ~ N(0, K) whose covariance K_ij = k(x_i, x_j; θ) is set by a kernel. Given
// noisy observations y = f(X) + ε, ε ~ N(0, σ_n²), the posterior over f is Gaussian in closed
// form. What belongs in *this* repo is how the kernel hyperparameters θ = (ℓ, σ_f, σ_n) are
// learned: by gradient ascent on the exact **log marginal likelihood**
//
//     log p(y|X,θ) = −½ yᵀ K⁻¹ y − ½ log|K| − n⁄2 log 2π,   K = K_f(θ) + σ_n² I,
//
// back-propagated straight through a **Cholesky factorization**. The kernel matrix is assembled
// on the autograd tape from the log-hyperparameter leaves (via `Tensor.tile`), and the one fused
// op below (`gpMarginalNLL`) carries the whole quadratic-form + log-determinant through a single
// hand-derived vector-Jacobian product: the textbook adjoint  K̄ = ½(K⁻¹ − ααᵀ),  α = K⁻¹y.
// No GP library, no autodiff-through-linalg framework — the Cholesky VJP is proven against finite
// differences in `selftest.ts`, exactly like every other gradient in the engine.

import { Tensor } from './tensor';

// ---- numeric linear algebra (no grad) ---------------------------------------------------

// Lower-triangular Cholesky L (row-major, LLᵀ = A) written into `L`. Returns false if a
// non-positive pivot is hit (A not positive-definite at this jitter).
function choleskyInto(L: Float64Array, A: Float64Array, n: number): boolean {
  L.fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 0) return false;
        L[i * n + j] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return true;
}

export interface CholResult {
  L: Float64Array;
  jitter: number;
}

// Cholesky with an adaptive diagonal jitter: a well-conditioned SPD matrix factors at jitter 0;
// a near-singular one (dense kernels, tiny noise) gets the smallest ε·I nudge that makes it
// factor. Returns L and the jitter actually used.
export function cholesky(A: Float64Array, n: number): CholResult {
  const L = new Float64Array(n * n);
  if (choleskyInto(L, A, n)) return { L, jitter: 0 };
  let scale = 0;
  for (let i = 0; i < n; i++) scale += A[i * n + i];
  scale = (scale / n) * 1e-9 + 1e-12;
  const J = A.slice();
  for (let t = 0; t < 30; t++) {
    for (let i = 0; i < n; i++) J[i * n + i] = A[i * n + i] + scale;
    if (choleskyInto(L, J, n)) return { L, jitter: scale };
    scale *= 10;
  }
  return { L, jitter: scale }; // best effort
}

// Solve L z = b (forward substitution), L lower-triangular.
export function solveLower(L: Float64Array, b: Float64Array, n: number): Float64Array {
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * z[k];
    z[i] = s / L[i * n + i];
  }
  return z;
}

// Solve Lᵀ x = z (back substitution), L lower-triangular (so Lᵀ is upper).
export function solveUpperT(L: Float64Array, z: Float64Array, n: number): Float64Array {
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

// x = K⁻¹ b, given the Cholesky L of K.
export function choleskySolve(L: Float64Array, b: Float64Array, n: number): Float64Array {
  return solveUpperT(L, solveLower(L, b, n), n);
}

// K⁻¹ as a dense matrix, from L (solve against each identity column).
export function inverseFromChol(L: Float64Array, n: number): Float64Array {
  const inv = new Float64Array(n * n);
  const e = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    e.fill(0);
    e[j] = 1;
    const col = choleskySolve(L, e, n);
    for (let i = 0; i < n; i++) inv[i * n + j] = col[i];
  }
  return inv;
}

// ---- kernels -----------------------------------------------------------------------------

export type KernelKind = 'rbf' | 'matern12' | 'matern32' | 'matern52' | 'rq' | 'periodic';

export interface KernelInfo {
  id: KernelKind;
  label: string;
  blurb: string;
  shape?: 'alpha' | 'period'; // structural knob this kernel exposes (not learned by ML)
}

export const GP_KERNELS: KernelInfo[] = [
  { id: 'rbf', label: 'RBF / Squared-Exp', blurb: 'infinitely smooth; the default' },
  { id: 'matern12', label: 'Matérn ½ (Exp)', blurb: 'rough, continuous but not differentiable' },
  { id: 'matern32', label: 'Matérn 3⁄2', blurb: 'once-differentiable; a common default' },
  { id: 'matern52', label: 'Matérn 5⁄2', blurb: 'twice-differentiable; smoother' },
  { id: 'rq', label: 'Rational Quadratic', blurb: 'a scale mixture of RBFs', shape: 'alpha' },
  { id: 'periodic', label: 'Periodic (ExpSine²)', blurb: 'exactly repeating structure', shape: 'period' },
];

export interface Shape {
  alpha: number; // rational-quadratic scale-mixture parameter
  period: number; // periodic kernel period
}

export const DEFAULT_SHAPE: Shape = { alpha: 2, period: 2 };

const SQRT3 = Math.sqrt(3);
const SQRT5 = Math.sqrt(5);

// The numeric kernel value at (absolute) input distance r, given σ_f² and lengthscale ℓ. Used
// for every no-grad query (posterior mean/variance, cross-covariance, kernel-shape plot). It is
// kept byte-for-byte consistent with the on-tape builder below so training and inference agree.
export function kernelValue(kind: KernelKind, r: number, ell: number, sf2: number, shape: Shape): number {
  switch (kind) {
    case 'rbf':
      return sf2 * Math.exp(-0.5 * (r * r) / (ell * ell));
    case 'matern12':
      return sf2 * Math.exp(-r / ell);
    case 'matern32': {
      const u = (SQRT3 * r) / ell;
      return sf2 * (1 + u) * Math.exp(-u);
    }
    case 'matern52': {
      const u = (SQRT5 * r) / ell;
      return sf2 * (1 + u + (u * u) / 3) * Math.exp(-u);
    }
    case 'rq': {
      const a = shape.alpha;
      return sf2 * Math.pow(1 + (r * r) / (2 * a * ell * ell), -a);
    }
    case 'periodic': {
      const s = Math.sin((Math.PI * r) / shape.period);
      return sf2 * Math.exp((-2 * s * s) / (ell * ell));
    }
  }
}

// Precomputed constant matrices for a fixed set of inputs: the pairwise |Δ| and Δ², plus the
// periodic sin² term at the current period, and the identity. These are leaves (no grad); only
// the hyperparameters carry gradient, so the kernel matrix differentiates through them alone.
export interface KernelConsts {
  n: number;
  D: Tensor; // |x_i - x_j|
  D2: Tensor; // (x_i - x_j)²
  Sper: Tensor; // sin²(π|Δ|/p)
  EYE: Tensor;
  ONES: Tensor;
}

export function buildConsts(X: Float64Array, period: number): KernelConsts {
  const n = X.length;
  const D = new Float64Array(n * n);
  const D2 = new Float64Array(n * n);
  const S = new Float64Array(n * n);
  const eye = new Float64Array(n * n);
  const ones = new Float64Array(n * n).fill(1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = Math.abs(X[i] - X[j]);
      D[i * n + j] = d;
      D2[i * n + j] = d * d;
      const s = Math.sin((Math.PI * d) / period);
      S[i * n + j] = s * s;
    }
    eye[i * n + i] = 1;
  }
  return {
    n,
    D: Tensor.fromFlat(D, n, n),
    D2: Tensor.fromFlat(D2, n, n),
    Sper: Tensor.fromFlat(S, n, n),
    EYE: Tensor.fromFlat(eye, n, n),
    ONES: Tensor.fromFlat(ones, n, n),
  };
}

export interface HyperParams {
  logEll: Tensor; // log lengthscale        [1,1]
  logSf: Tensor; // log signal std          [1,1]  → σ_f² = exp(2·logSf)
  logSn: Tensor; // log noise std           [1,1]  → σ_n² = exp(2·logSn)
}

// Assemble the covariance matrix K = σ_f²·Φ(D;ℓ) + σ_n²·I **on the tape**. Every kernel reduces
// to one shape function Φ of the precomputed distances and the lengthscale; multiplying by the
// tiled scalar σ_f² and adding the tiled σ_n²·I keeps the whole thing a differentiable graph, so
// `nll.backward()` produces ∂NLL/∂{logℓ, logσ_f, logσ_n} with no special-casing.
export function buildKernelMatrix(
  kind: KernelKind,
  hp: HyperParams,
  consts: KernelConsts,
  shape: Shape,
): Tensor {
  const n = consts.n;
  const invLen2 = hp.logEll.scale(-2).exp(); // 1/ℓ²
  const invLen = hp.logEll.scale(-1).exp(); // 1/ℓ
  let phi: Tensor;
  switch (kind) {
    case 'rbf': {
      phi = consts.D2.mul(invLen2.tile(n, n)).scale(-0.5).exp();
      break;
    }
    case 'matern12': {
      const u = consts.D.mul(invLen.tile(n, n)); // r/ℓ
      phi = u.neg().exp();
      break;
    }
    case 'matern32': {
      const u = consts.D.mul(invLen.tile(n, n)).scale(SQRT3); // √3 r/ℓ
      phi = consts.ONES.add(u).mul(u.neg().exp());
      break;
    }
    case 'matern52': {
      const u = consts.D.mul(invLen.tile(n, n)).scale(SQRT5); // √5 r/ℓ
      const poly = consts.ONES.add(u).add(u.mul(u).scale(1 / 3));
      phi = poly.mul(u.neg().exp());
      break;
    }
    case 'rq': {
      const a = shape.alpha;
      const base = consts.ONES.add(consts.D2.mul(invLen2.tile(n, n)).scale(1 / (2 * a)));
      phi = base.pow(-a);
      break;
    }
    case 'periodic': {
      phi = consts.Sper.mul(invLen2.tile(n, n)).scale(-2).exp();
      break;
    }
  }
  const sf2 = hp.logSf.scale(2).exp();
  const sn2 = hp.logSn.scale(2).exp();
  const Kf = phi.mul(sf2.tile(n, n));
  return Kf.add(consts.EYE.mul(sn2.tile(n, n)));
}

// ---- the fused marginal-likelihood op ----------------------------------------------------

// Negative log marginal likelihood of a GP given the (on-tape) covariance K and the centred
// targets y. Forward: Cholesky of K, then quad = yᵀK⁻¹y via triangular solves and log|K| = 2Σlog Lᵢᵢ.
// Backward: the single hand-derived VJP  K̄ = ½(K⁻¹ − ααᵀ), α = K⁻¹y — the exact adjoint of both
// the quadratic form (−½ααᵀ) and the log-determinant (+½K⁻¹). Back-prop then carries K̄ through
// `buildKernelMatrix` into the log-hyperparameters. y is a constant (the data), so it needs no grad.
export function gpMarginalNLL(K: Tensor, y: Float64Array): Tensor {
  const n = K.rows;
  if (K.cols !== n || y.length !== n) throw new Error('gpMarginalNLL shape mismatch');
  const { L } = cholesky(K.data, n);
  const z = solveLower(L, y, n); // L z = y
  const alpha = solveUpperT(L, z, n); // α = K⁻¹ y
  let quad = 0;
  for (let i = 0; i < n; i++) quad += z[i] * z[i]; // yᵀK⁻¹y = ‖L⁻¹y‖²
  let logdet = 0;
  for (let i = 0; i < n; i++) logdet += Math.log(L[i * n + i]);
  logdet *= 2;
  const nll = 0.5 * quad + 0.5 * logdet + 0.5 * n * Math.log(2 * Math.PI);

  const out = Tensor.zeros(1, 1);
  out.data[0] = nll;
  out.op = 'gpMarginalNLL';
  out.prev = [K];
  out.backwardFn = () => {
    const seed = out.grad[0];
    if (seed === 0) return;
    const Kinv = inverseFromChol(L, n);
    const gK = K.grad;
    for (let i = 0; i < n; i++) {
      const ai = alpha[i];
      for (let j = 0; j < n; j++) {
        // ½(K⁻¹ − ααᵀ)
        gK[i * n + j] += seed * 0.5 * (Kinv[i * n + j] - ai * alpha[j]);
      }
    }
  };
  return out;
}

// ---- datasets ----------------------------------------------------------------------------

export type GPDatasetKind = 'sine' | 'step' | 'damped' | 'cubic' | 'runs' | 'sparse' | 'co2';

export interface GPDatasetInfo {
  id: GPDatasetKind;
  label: string;
}

export const GP_DATASETS: GPDatasetInfo[] = [
  { id: 'sine', label: 'Sine' },
  { id: 'damped', label: 'Damped wave' },
  { id: 'step', label: 'Smooth step' },
  { id: 'cubic', label: 'Cubic' },
  { id: 'runs', label: 'Heteroscedastic' },
  { id: 'sparse', label: 'Sparse (few points)' },
  { id: 'co2', label: 'CO₂ (trend + season)' },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface GPData {
  X: number[];
  y: number[];
  domain: [number, number]; // the x-window the plot should span (wider than the data)
}

export function makeGPDataset(kind: GPDatasetKind, seed: number): GPData {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const X: number[] = [];
  const y: number[] = [];
  const push = (x: number, f: number, noise: number) => {
    X.push(x);
    y.push(f + gauss(rng) * noise);
  };
  switch (kind) {
    case 'sine': {
      for (let i = 0; i < 11; i++) {
        const x = -3 + (i / 10) * 6;
        push(x, Math.sin(1.6 * x), 0.12);
      }
      return { X, y, domain: [-4.2, 4.2] };
    }
    case 'damped': {
      for (let i = 0; i < 14; i++) {
        const x = -4 + (i / 13) * 8;
        push(x, Math.exp(-0.18 * Math.abs(x)) * Math.sin(2.4 * x), 0.08);
      }
      return { X, y, domain: [-5.4, 5.4] };
    }
    case 'step': {
      for (let i = 0; i < 13; i++) {
        const x = -3 + (i / 12) * 6;
        push(x, Math.tanh(2.5 * x), 0.09);
      }
      return { X, y, domain: [-4, 4] };
    }
    case 'cubic': {
      for (let i = 0; i < 12; i++) {
        const x = -2.4 + (i / 11) * 4.8;
        push(x, 0.18 * x * x * x - 0.4 * x, 0.25);
      }
      return { X, y, domain: [-3.4, 3.4] };
    }
    case 'runs': {
      // heteroscedastic: quiet on the left, noisy on the right
      for (let i = 0; i < 16; i++) {
        const x = -3 + (i / 15) * 6;
        const noise = 0.04 + 0.28 * ((x + 3) / 6);
        push(x, Math.sin(1.3 * x) + 0.15 * x, noise);
      }
      return { X, y, domain: [-4, 4] };
    }
    case 'sparse': {
      for (const x of [-2.6, -1.1, 0.2, 1.7, 3.1]) push(x, Math.sin(1.2 * x) + 0.2 * x, 0.05);
      return { X, y, domain: [-4.5, 5] };
    }
    case 'co2': {
      // a rising trend with a strong annual cycle — the classic extrapolation demo
      for (let i = 0; i < 22; i++) {
        const x = (i / 21) * 6;
        push(x, 0.35 * x + Math.sin(2 * Math.PI * x), 0.05);
      }
      return { X, y, domain: [0, 9.5] };
    }
  }
}

// ---- the GP model ------------------------------------------------------------------------

export interface GPConfig {
  kind: KernelKind;
  logEll: number;
  logSf: number;
  logSn: number;
  shape: Shape;
}

export interface Posterior {
  Xs: Float64Array;
  mean: Float64Array;
  sdLatent: Float64Array; // ±sd of the latent function f
  sdPredictive: Float64Array; // latent + observation noise σ_n
}

export interface GPSnapshot {
  logEll: number;
  logSf: number;
  logSn: number;
}

export class GP {
  kind: KernelKind;
  shape: Shape;
  X: Float64Array;
  y: Float64Array; // raw targets
  yMean: number;
  yc: Float64Array; // centred targets (zero-mean GP)
  logEll: Tensor;
  logSf: Tensor;
  logSn: Tensor;
  private consts: KernelConsts;

  constructor(X: number[], y: number[], cfg: GPConfig) {
    this.kind = cfg.kind;
    this.shape = { ...cfg.shape };
    this.X = Float64Array.from(X);
    this.y = Float64Array.from(y);
    this.yMean = this.y.length ? this.y.reduce((a, b) => a + b, 0) / this.y.length : 0;
    this.yc = this.y.map((v) => v - this.yMean);
    this.logEll = mkScalar(cfg.logEll, 'logEll');
    this.logSf = mkScalar(cfg.logSf, 'logSf');
    this.logSn = mkScalar(cfg.logSn, 'logSn');
    this.consts = buildConsts(this.X, this.shape.period);
  }

  private hp(): HyperParams {
    return { logEll: this.logEll, logSf: this.logSf, logSn: this.logSn };
  }

  get ell(): number {
    return Math.exp(this.logEll.data[0]);
  }
  get sf2(): number {
    return Math.exp(2 * this.logSf.data[0]);
  }
  get sn2(): number {
    return Math.exp(2 * this.logSn.data[0]);
  }

  // rebuild the input-dependent constants (after points are added/removed or the period changes)
  rebuild(): void {
    this.yMean = this.y.length ? this.y.reduce((a, b) => a + b, 0) / this.y.length : 0;
    this.yc = Float64Array.from(this.y).map((v) => v - this.yMean);
    this.consts = buildConsts(this.X, this.shape.period);
  }

  setPeriod(p: number): void {
    this.shape.period = p;
    this.consts = buildConsts(this.X, p);
  }

  // the covariance matrix, on the tape (differentiable w.r.t. the log-hyperparameters)
  buildK(): Tensor {
    return buildKernelMatrix(this.kind, this.hp(), this.consts, this.shape);
  }

  // the training / gradcheck objective: negative log marginal likelihood
  nll(): Tensor {
    return gpMarginalNLL(this.buildK(), this.yc);
  }

  logMarginalLikelihood(): number {
    if (this.X.length === 0) return NaN;
    return -this.nll().data[0];
  }

  learnable(locks: { ell: boolean; sf: boolean; sn: boolean }): Tensor[] {
    const ps: Tensor[] = [];
    if (!locks.ell) ps.push(this.logEll);
    if (!locks.sf) ps.push(this.logSf);
    if (!locks.sn) ps.push(this.logSn);
    return ps;
  }

  allParams(): Tensor[] {
    return [this.logEll, this.logSf, this.logSn];
  }

  // A numeric covariance matrix between two input sets (no grad), optionally with σ_n² on the
  // diagonal of a self-covariance. Used for every posterior/sampling query.
  private cov(A: Float64Array, B: Float64Array, addNoise: boolean): Float64Array {
    const na = A.length;
    const nb = B.length;
    const sf2 = this.sf2;
    const ell = this.ell;
    const M = new Float64Array(na * nb);
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < nb; j++) {
        const r = Math.abs(A[i] - B[j]);
        let v = kernelValue(this.kind, r, ell, sf2, this.shape);
        if (addNoise && A === B && i === j) v += this.sn2;
        M[i * nb + j] = v;
      }
    }
    return M;
  }

  // Closed-form posterior mean and variance at test inputs Xs.
  posterior(Xs: Float64Array): Posterior {
    const n = this.X.length;
    const m = Xs.length;
    const mean = new Float64Array(m);
    const sdLatent = new Float64Array(m);
    const sdPredictive = new Float64Array(m);
    const sf2 = this.sf2;
    if (n === 0) {
      // prior: zero mean, σ_f std everywhere
      for (let i = 0; i < m; i++) {
        mean[i] = this.yMean;
        sdLatent[i] = Math.sqrt(sf2);
        sdPredictive[i] = Math.sqrt(sf2 + this.sn2);
      }
      return { Xs, mean, sdLatent, sdPredictive };
    }
    const Knn = this.cov(this.X, this.X, true);
    const { L } = cholesky(Knn, n);
    const alpha = choleskySolve(L, this.yc, n); // K⁻¹ (y − ȳ)
    const Ksn = this.cov(Xs, this.X, false); // [m,n]
    for (let i = 0; i < m; i++) {
      let mu = 0;
      const ks = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        ks[j] = Ksn[i * n + j];
        mu += ks[j] * alpha[j];
      }
      const v = solveLower(L, ks, n); // v = L⁻¹ k_*
      let vv = 0;
      for (let j = 0; j < n; j++) vv += v[j] * v[j];
      const varF = Math.max(sf2 - vv, 0);
      mean[i] = mu + this.yMean;
      sdLatent[i] = Math.sqrt(varF);
      sdPredictive[i] = Math.sqrt(varF + this.sn2);
    }
    return { Xs, mean, sdLatent, sdPredictive };
  }

  // Draw `count` sample functions from the posterior at Xs (or the prior when there is no data),
  // via a jittered Cholesky of the full joint covariance among the test points.
  sampleFunctions(Xs: Float64Array, count: number, seed: number): Float64Array[] {
    const m = Xs.length;
    const rng = mulberry32(seed);
    const mean = new Float64Array(m);
    let cov: Float64Array;
    const n = this.X.length;
    if (n === 0) {
      cov = this.cov(Xs, Xs, false);
      for (let i = 0; i < m; i++) mean[i] = this.yMean;
    } else {
      const Knn = this.cov(this.X, this.X, true);
      const { L: Ln } = cholesky(Knn, n);
      const alpha = choleskySolve(Ln, this.yc, n);
      const Kss = this.cov(Xs, Xs, false);
      const Ksn = this.cov(Xs, this.X, false);
      // posterior mean and covariance
      cov = new Float64Array(m * m);
      // V = L⁻¹ Ksnᵀ  → [n, m]; posterior cov = Kss − VᵀV
      const V = new Float64Array(n * m);
      for (let i = 0; i < m; i++) {
        const ks = new Float64Array(n);
        let mu = 0;
        for (let j = 0; j < n; j++) {
          ks[j] = Ksn[i * n + j];
          mu += ks[j] * alpha[j];
        }
        mean[i] = mu + this.yMean;
        const vi = solveLower(Ln, ks, n);
        for (let j = 0; j < n; j++) V[j * m + i] = vi[j];
      }
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
          let dot = 0;
          for (let k = 0; k < n; k++) dot += V[k * m + i] * V[k * m + j];
          cov[i * m + j] = Kss[i * m + j] - dot;
        }
      }
    }
    const { L } = cholesky(cov, m);
    const out: Float64Array[] = [];
    for (let s = 0; s < count; s++) {
      const zvec = new Float64Array(m);
      for (let i = 0; i < m; i++) zvec[i] = gauss(rng);
      const f = new Float64Array(m);
      for (let i = 0; i < m; i++) {
        let acc = mean[i];
        for (let k = 0; k <= i; k++) acc += L[i * m + k] * zvec[k];
        f[i] = acc;
      }
      out.push(f);
    }
    return out;
  }

  // The log-marginal-likelihood surface over a grid of (logEll, logSn), holding logSf fixed —
  // the landscape hyperparameter optimization descends. Returns row-major values (noise outer,
  // lengthscale inner) plus the axis breakpoints, and the current point's grid coords.
  lmlGrid(
    logEllRange: [number, number],
    logSnRange: [number, number],
    res: number,
  ): { values: Float64Array; ellAxis: Float64Array; snAxis: Float64Array; min: number; max: number } {
    const n = this.X.length;
    const values = new Float64Array(res * res);
    const ellAxis = new Float64Array(res);
    const snAxis = new Float64Array(res);
    for (let i = 0; i < res; i++) {
      ellAxis[i] = logEllRange[0] + (i / (res - 1)) * (logEllRange[1] - logEllRange[0]);
      snAxis[i] = logSnRange[0] + (i / (res - 1)) * (logSnRange[1] - logSnRange[0]);
    }
    const sf2 = this.sf2;
    let min = Infinity;
    let max = -Infinity;
    for (let a = 0; a < res; a++) {
      const sn2 = Math.exp(2 * snAxis[a]);
      for (let b = 0; b < res; b++) {
        const ell = Math.exp(ellAxis[b]);
        // build K numerically at this (ell, sn2)
        const K = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const r = Math.abs(this.X[i] - this.X[j]);
            let v = kernelValue(this.kind, r, ell, sf2, this.shape);
            if (i === j) v += sn2;
            K[i * n + j] = v;
          }
        }
        const { L } = cholesky(K, n);
        const z = solveLower(L, this.yc, n);
        let quad = 0;
        for (let i = 0; i < n; i++) quad += z[i] * z[i];
        let logdet = 0;
        for (let i = 0; i < n; i++) logdet += Math.log(L[i * n + i]);
        const lml = -(0.5 * quad + logdet + 0.5 * n * Math.log(2 * Math.PI));
        values[a * res + b] = lml;
        if (lml < min) min = lml;
        if (lml > max) max = lml;
      }
    }
    return { values, ellAxis, snAxis, min, max };
  }

  snapshot(): GPSnapshot {
    return { logEll: this.logEll.data[0], logSf: this.logSf.data[0], logSn: this.logSn.data[0] };
  }
}

function mkScalar(v: number, label: string): Tensor {
  const t = Tensor.fromFlat(Float64Array.from([v]), 1, 1, true);
  t.named(label);
  return t;
}
