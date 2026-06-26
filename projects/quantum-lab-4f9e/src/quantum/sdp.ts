import { Complex, C } from './Complex';
import { hermitianEig } from './Hermitian';

/**
 * A from-scratch semidefinite-programming (SDP) solver — the optimisation workhorse of modern
 * quantum information, built here with NO external libraries on top of the lab's own complex
 * Hermitian (cyclic-Jacobi) eigensolver.
 *
 * The lab can diagonalise over the PSD cone (every density matrix is Hermitian PSD) but it has
 * never *optimised* over it. The device-independent programme needs exactly that: the NPA hierarchy
 * relaxes "what correlations are quantum?" to "does a positive-semidefinite moment matrix exist?",
 * an SDP. This module solves the two specific SDP shapes that programme needs, both small and dense,
 * and both reduce to a positive-semidefiniteness oracle the Jacobi eigensolver already provides.
 *
 *   1. PRIMAL — the *elliptope* problem        maximise ⟨C, X⟩   s.t.  X ⪰ 0,  diag(X) = 1.
 *      This is the Goemans–Williamson / NPA-level-1 shape. We solve it by BURER–MONTEIRO: write the
 *      (real, symmetric) PSD matrix as X = V Vᵀ with V an n×k matrix, which makes X ⪰ 0 automatic and
 *      turns diag(X)=1 into "every row of V is a unit vector". Then maximise ⟨C, VVᵀ⟩ = Σ_ij C_ij vᵢ·vⱼ
 *      by projected gradient ascent on the product of unit spheres. For this diagonally-constrained
 *      class the low-rank landscape has no spurious local maxima once k ≥ ⌈√(2n)⌉ (Barvinok–Pataki /
 *      Boumal–Voroninski–Bandeira), so a few multistart runs find the global SDP optimum.
 *
 *   2. DUAL — the certificate                   minimise Σ yᵢ     s.t.  Diag(y) − C ⪰ 0.
 *      Weak duality gives ⟨C,X⟩ = Σyᵢ − ⟨Diag(y)−C, X⟩ ≤ Σyᵢ for any primal-feasible X, so every
 *      dual-feasible y is a *rigorous upper bound* on the primal — the proof, not just a number. We
 *      minimise Σyᵢ with an eigenvalue-penalised subgradient descent: the penalty −λ_min(Diag(y)−C)
 *      (from the eigensolver) pushes y back into the PSD-feasible region, and the slack matrix
 *      Diag(y)−C at the optimum is the certificate (its smallest eigenvalue → 0 at the active bound).
 *
 * The duality gap primal − dual → 0 certifies global optimality from the inside, with no solver to
 * trust but this file.
 */

// ───────────────────────────── real symmetric helpers ─────────────────────────────
// The SDPs here are over REAL symmetric matrices, but the PSD oracle (hermitianEig) is complex
// Hermitian, so we embed reals as Complex with zero imaginary part. (A real symmetric matrix is a
// special Hermitian matrix; its eigenvalues are the real ones we need.)

export type RealMat = number[][];

function toComplex(A: RealMat): Complex[][] {
  return A.map((row) => row.map((x) => C(x)));
}

/** Smallest eigenvalue of a real symmetric matrix (via the complex Hermitian Jacobi eigensolver). */
export function minEigenvalue(A: RealMat): number {
  const vals = hermitianEig(toComplex(A)).values; // sorted descending
  return vals[vals.length - 1];
}

/** All eigenvalues (descending) of a real symmetric matrix. */
export function eigenvalues(A: RealMat): number[] {
  return hermitianEig(toComplex(A)).values;
}

/** Frobenius inner product ⟨A,B⟩ = Σ A_ij B_ij. */
export function frobenius(A: RealMat, B: RealMat): number {
  let s = 0;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) s += A[i][j] * B[i][j];
  return s;
}

// A small deterministic RNG so every solve is reproducible (splitmix32).
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = (z ^ (z >>> 16)) >>> 0; z = Math.imul(z, 0x21f0aaad) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0; z = Math.imul(z, 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
}

// ───────────────────────────── primal: the elliptope ─────────────────────────────

export interface ElliptopeResult {
  /** The optimal value max ⟨C, X⟩. */
  value: number;
  /** The optimal moment matrix X = V Vᵀ (diag 1, PSD). */
  X: RealMat;
  /** The factor V (n×k, rows unit), the low-rank witness of feasibility. */
  V: RealMat;
}

/**
 * Maximise ⟨C, X⟩ over { X ⪰ 0, diag(X) = 1 } by Burer–Monteiro projected-gradient ascent.
 * `C` must be symmetric. Returns the optimum and an explicit feasible witness X = V Vᵀ.
 */
export function maximizeElliptope(C: RealMat, opts: { rank?: number; restarts?: number; iters?: number; seed?: number } = {}): ElliptopeResult {
  const n = C.length;
  const k = opts.rank ?? Math.max(2, Math.ceil(Math.sqrt(2 * n)) + 1);
  const restarts = opts.restarts ?? 6;
  const iters = opts.iters ?? 1500;
  const seed = opts.seed ?? 1;
  const rng = makeRng(seed);

  // Symmetrise C defensively; the gradient of ⟨C, VVᵀ⟩ w.r.t. row i is 2 Σ_j Csym_ij v_j.
  const Cs: RealMat = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => 0.5 * (C[i][j] + C[j][i])));

  const objective = (V: RealMat): number => {
    let s = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let dot = 0;
      for (let a = 0; a < k; a++) dot += V[i][a] * V[j][a];
      s += Cs[i][j] * dot;
    }
    return s;
  };

  const randUnitRow = (): number[] => {
    const v = Array.from({ length: k }, () => rng() * 2 - 1);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };

  let best: { V: RealMat; val: number } | null = null;
  for (let r = 0; r < restarts; r++) {
    const V: RealMat = Array.from({ length: n }, () => randUnitRow());
    let step = 0.5;
    let prev = objective(V);
    for (let it = 0; it < iters; it++) {
      // Riemannian gradient step per row, then re-project onto the unit sphere.
      for (let i = 0; i < n; i++) {
        const g = new Array(k).fill(0);
        for (let j = 0; j < n; j++) {
          const c = 2 * Cs[i][j];
          if (c === 0) continue;
          for (let a = 0; a < k; a++) g[a] += c * V[j][a];
        }
        // Project the gradient onto the tangent space of the sphere (remove the radial part),
        // ascend, and renormalise — keeps the row a unit vector (diag(X)=1) exactly.
        let radial = 0;
        for (let a = 0; a < k; a++) radial += g[a] * V[i][a];
        for (let a = 0; a < k; a++) V[i][a] += step * (g[a] - radial * V[i][a]);
        const norm = Math.hypot(...V[i]) || 1;
        for (let a = 0; a < k; a++) V[i][a] /= norm;
      }
      const cur = objective(V);
      if (cur < prev - 1e-12) step *= 0.7; else step = Math.min(step * 1.05, 1.0);
      if (Math.abs(cur - prev) < 1e-13 && it > 50) break;
      prev = cur;
    }
    const val = objective(V);
    if (!best || val > best.val) best = { V: V.map((row) => row.slice()), val };
  }

  const V = best!.V;
  const X: RealMat = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    let dot = 0;
    for (let a = 0; a < k; a++) dot += V[i][a] * V[j][a];
    return dot;
  }));
  return { value: best!.val, X, V };
}

// ───────────────────────────── dual: the certificate ─────────────────────────────

export interface DualResult {
  /** The optimal dual value Σ yᵢ — a rigorous UPPER bound on the primal. */
  value: number;
  /** The dual variables y (the per-row "prices"). */
  y: number[];
  /** The certificate (slack) matrix Diag(y) − C ⪰ 0; its λ_min → 0 at optimality. */
  slack: RealMat;
  /** The smallest eigenvalue of the slack (≥ −tol at a feasible point). */
  slackMinEig: number;
}

/**
 * Minimise Σ yᵢ subject to Diag(y) − C ⪰ 0, returning the certificate matrix. Eigenvalue-penalised
 * projected descent: feasibility is restored by lifting y uniformly until λ_min(Diag(y)−C) ≥ 0, and
 * the objective Σyᵢ is reduced by lowering the entries with the most PSD slack. `C` symmetric.
 */
export function minimizeDual(C: RealMat, opts: { iters?: number } = {}): DualResult {
  const n = C.length;
  const iters = opts.iters ?? 20000;
  const Cs: RealMat = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => 0.5 * (C[i][j] + C[j][i])));

  const slackOf = (y: number[]): RealMat =>
    Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? y[i] : 0) - Cs[i][j]));

  // Start strictly feasible: y_i large enough that Diag(y) − C ≻ 0 (Gershgorin: row-sum bound).
  let y = new Array(n).fill(0).map((_, i) => {
    let off = 0;
    for (let j = 0; j < n; j++) if (j !== i) off += Math.abs(Cs[i][j]);
    return Cs[i][i] + off + 1;
  });

  // Restore PSD feasibility by repeatedly lifting y along the violating eigenvector: since
  // ∂λ_min/∂y_i = (v_min)_i², adding (−λ_min)·(v_min)_i²/Σ(v_min)² raises λ_min back to ~0.
  const project = (yv: number[]): number[] => {
    for (let s = 0; s < 60; s++) {
      const eig = hermitianEig(toComplex(slackOf(yv)));
      const lam = eig.values[n - 1];
      if (lam >= -1e-10) break;
      const vmin = eig.vectors.map((row) => row[n - 1].re);
      const denom = vmin.reduce((acc, x) => acc + x * x, 0) || 1;
      const need = -lam + 1e-9;
      for (let i = 0; i < n; i++) yv[i] += need * (vmin[i] * vmin[i]) / denom;
    }
    return yv;
  };

  // Projected subgradient on the linear objective Σyᵢ (subgradient = all-ones): step DOWN the
  // objective, then project back onto the PSD-feasible boundary. The combination traces the active
  // face down to the true minimum (a uniform descent alone freezes at the first boundary it touches).
  let alpha = 1.0;
  let best = Infinity;
  let bestY = y.slice();
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) y[i] -= alpha;
    y = project(y);
    const lam = minEigenvalue(slackOf(y));
    if (lam >= -1e-7) {
      const val = y.reduce((s, v) => s + v, 0);
      if (val < best) { best = val; bestY = y.slice(); }
    }
    alpha *= 0.9994;
    if (alpha < 1e-9) break;
  }

  const slack = slackOf(bestY);
  return { value: best, y: bestY, slack, slackMinEig: minEigenvalue(slack) };
}

/** Solve both sides of the elliptope SDP and report the duality gap (proof of optimality). */
export interface SdpReport {
  primal: number;
  dual: number;
  gap: number;
  X: RealMat;
  y: number[];
  slack: RealMat;
  slackMinEig: number;
}

export function solveElliptopeSDP(C: RealMat, opts: { rank?: number; restarts?: number; seed?: number } = {}): SdpReport {
  const p = maximizeElliptope(C, opts);
  const d = minimizeDual(C);
  return {
    primal: p.value,
    dual: d.value,
    gap: d.value - p.value,
    X: p.X,
    y: d.y,
    slack: d.slack,
    slackMinEig: d.slackMinEig,
  };
}
