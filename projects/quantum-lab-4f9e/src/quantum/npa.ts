import { solveElliptopeSDP, frobenius, minEigenvalue, type RealMat } from './sdp';

/**
 * The NPA hierarchy (Navascués–Pironio–Acín, 2007), level 1 — and an independent operator
 * sum-of-squares certificate — for the device-independent upper bound on a Bell functional.
 *
 * The deep question of nonlocality is not "can quantum *reach* S=2√2?" (15.0 sampled qubit
 * strategies and found it) but "can quantum *exceed* 2√2 — in ANY dimension, with ANY measurements?"
 * That is a quantifier over all of Hilbert space, seemingly intractable. NPA makes it an SDP. The
 * idea: any quantum correlation has a moment matrix Γ whose entries are inner products ⟨ψ| u†v |ψ⟩
 * of operator monomials u,v, and Γ is necessarily positive-semidefinite (it is a Gram matrix). So
 * the maximum of a Bell functional over all PSD matrices with the right structure is an UPPER bound
 * on the quantum value — a relaxation that gets tighter with the monomial set. At level 1, with the
 * monomials {1, A₀, A₁, B₀, B₁}, the relaxation is already tight for CHSH: it yields exactly 2√2.
 *
 * Indexing of the 5×5 moment matrix Γ (real symmetric, diag = 1 because A²=B²=I):
 *
 *        │  1    A₀    A₁    B₀    B₁
 *    ────┼───────────────────────────
 *     1  │  1   ⟨A₀⟩ ⟨A₁⟩ ⟨B₀⟩ ⟨B₁⟩     ← marginals
 *    A₀  │       1   ⟨A₀A₁⟩ E₀₀  E₀₁
 *    A₁  │             1    E₁₀  E₁₁     ← E_xy = ⟨A_x B_y⟩, the correlators (free off-diagonals)
 *    B₀  │                   1   ⟨B₀B₁⟩
 *    B₁  │                         1
 *
 * Every off-diagonal is a free variable (no monomial collides at level 1), so "maximise a Bell
 * functional over Γ ⪰ 0, diag = 1" is exactly the elliptope SDP solved from scratch in `sdp.ts`.
 */

// Moment-matrix indices.
const IDENT = 0;
const A = [1, 2]; // A₀, A₁
const B = [3, 4]; // B₀, B₁
const DIM = 5;

/** A 2-input/2-output correlation Bell functional: B = Σ αₓ⟨Aₓ⟩ + Σ βᵧ⟨Bᵧ⟩ + Σ g_xy ⟨AₓBᵧ⟩. */
export interface BellFunctional {
  /** Marginal weights on Alice's two observables (default 0). */
  alpha?: [number, number];
  /** Marginal weights on Bob's two observables (default 0). */
  beta?: [number, number];
  /** 2×2 correlation weights g_xy on ⟨AₓBᵧ⟩. */
  g: [[number, number], [number, number]];
}

/** The CHSH functional S = ⟨A₀B₀⟩ + ⟨A₀B₁⟩ + ⟨A₁B₀⟩ − ⟨A₁B₁⟩. */
export const CHSH_FUNCTIONAL: BellFunctional = { g: [[1, 1], [1, -1]] };

/** Build the cost matrix C such that ⟨C, Γ⟩ equals the Bell functional evaluated on Γ's entries. */
export function bellCostMatrix(f: BellFunctional): RealMat {
  const C: RealMat = Array.from({ length: DIM }, () => new Array(DIM).fill(0));
  const set = (i: number, j: number, v: number) => { C[i][j] += v / 2; C[j][i] += v / 2; };
  const alpha = f.alpha ?? [0, 0];
  const beta = f.beta ?? [0, 0];
  for (let x = 0; x < 2; x++) set(IDENT, A[x], alpha[x]);
  for (let y = 0; y < 2; y++) set(IDENT, B[y], beta[y]);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) set(A[x], B[y], f.g[x][y]);
  return C;
}

export interface NPAResult {
  /** SDP primal optimum — the best Bell value any feasible moment matrix achieves. */
  primal: number;
  /** SDP dual optimum — a RIGOROUS upper bound on every quantum strategy in any dimension. */
  upperBound: number;
  /** Duality gap (→ 0 ⇒ the bound is proven optimal). */
  gap: number;
  /** The certified Tsirelson value (primal and dual agree on it). */
  value: number;
  /** The optimal moment matrix Γ. */
  moment: RealMat;
  /** The four correlators E_xy read off the optimal Γ. */
  correlators: [[number, number], [number, number]];
  /** The marginals ⟨Aₓ⟩, ⟨Bᵧ⟩ read off Γ (≈ 0 for CHSH — no-signalling, unbiased). */
  marginalsA: [number, number];
  marginalsB: [number, number];
  /** The dual certificate y and the slack matrix's smallest eigenvalue (≈ 0 ⇒ tight). */
  dualY: number[];
  slackMinEig: number;
}

/** Solve the NPA level-1 relaxation for a Bell functional. For CHSH this certifies 2√2. */
export function npaLevel1(f: BellFunctional = CHSH_FUNCTIONAL): NPAResult {
  const C = bellCostMatrix(f);
  const sdp = solveElliptopeSDP(C, { restarts: 8, seed: 3 });
  const corr: [[number, number], [number, number]] = [
    [sdp.X[A[0]][B[0]], sdp.X[A[0]][B[1]]],
    [sdp.X[A[1]][B[0]], sdp.X[A[1]][B[1]]],
  ];
  return {
    primal: sdp.primal,
    upperBound: sdp.dual,
    gap: Math.abs(sdp.gap),
    value: 0.5 * (sdp.primal + sdp.dual),
    moment: sdp.X,
    correlators: corr,
    marginalsA: [sdp.X[IDENT][A[0]], sdp.X[IDENT][A[1]]],
    marginalsB: [sdp.X[IDENT][B[0]], sdp.X[IDENT][B[1]]],
    dualY: sdp.y,
    slackMinEig: sdp.slackMinEig,
  };
}

/** Tsirelson's bound, the headline NPA result. */
export const TSIRELSON = 2 * Math.SQRT2;

// ───────────────────────────── operator sum-of-squares certificate ─────────────────────────────
//
// A second, fully rigorous and *basis-independent* proof of 2√2, independent of the numerical SDP.
// Using only A_x² = I, B_y² = I and [A_x, B_y] = 0, the CHSH operator obeys the identity
//
//     2√2·I − S  =  (1/√2)( u² + v² ),     u = A₀ − (B₀+B₁)/√2,   v = A₁ − (B₀−B₁)/√2,
//
// where S = A₀B₀ + A₀B₁ + A₁B₀ − A₁B₁. The right side is a sum of squares of Hermitian operators,
// hence positive-semidefinite, so 2√2·I − S ⪰ 0 for EVERY state and EVERY representation — no
// quantum strategy can give ⟨S⟩ > 2√2. We verify the identity is the exact zero matrix on a concrete
// dense 4×4 representation (A on the first qubit, B on the second, so commutation is automatic).

type M4 = number[][];
const mul = (X: M4, Y: M4): M4 => X.map((_, i) => Y[0].map((_, j) => { let s = 0; for (let k = 0; k < Y.length; k++) s += X[i][k] * Y[k][j]; return s; }));
const add = (X: M4, Y: M4): M4 => X.map((row, i) => row.map((v, j) => v + Y[i][j]));
const sub = (X: M4, Y: M4): M4 => X.map((row, i) => row.map((v, j) => v - Y[i][j]));
const scal = (X: M4, s: number): M4 => X.map((row) => row.map((v) => v * s));
const kron2 = (X: M4, Y: M4): M4 => {
  const R: M4 = Array.from({ length: 4 }, () => new Array(4).fill(0));
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) R[i * 2 + p][j * 2 + q] = X[i][j] * Y[p][q];
  return R;
};

export interface SOSCertificate {
  /** Max |entry| of the residual 2√2·I − S − (1/√2)(u²+v²) — should be ~1e-16. */
  residual: number;
  /** ⟨Φ⁺|S|Φ⁺⟩ on the dense representation (= 2√2, the attaining state). */
  expectation: number;
  /** Whether u² and v² are individually PSD (smallest eigenvalues ≥ 0). */
  squaresPSD: boolean;
}

export function chshSOSCertificate(): SOSCertificate {
  const I2: M4 = [[1, 0], [0, 1]];
  const Z: M4 = [[1, 0], [0, -1]];
  const X: M4 = [[0, 1], [1, 0]];
  const r2 = Math.SQRT1_2;
  // Alice: A₀ = Z⊗I, A₁ = X⊗I.  Bob: B₀ = I⊗(Z+X)/√2, B₁ = I⊗(Z−X)/√2.  All ±1 observables.
  const A0 = kron2(Z, I2), A1 = kron2(X, I2);
  const B0 = kron2(I2, scal(add(Z, X), r2)), B1 = kron2(I2, scal(sub(Z, X), r2));
  const S = sub(add(add(mul(A0, B0), mul(A0, B1)), mul(A1, B0)), mul(A1, B1));
  const u = sub(A0, scal(add(B0, B1), r2));
  const v = sub(A1, scal(sub(B0, B1), r2));
  const u2 = mul(u, u), v2 = mul(v, v);
  const id4: M4 = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => (i === j ? 1 : 0)));
  const R = sub(sub(scal(id4, TSIRELSON), S), scal(add(u2, v2), r2));
  let residual = 0;
  for (const row of R) for (const x of row) residual = Math.max(residual, Math.abs(x));
  // |Φ⁺⟩ = (|00⟩ + |11⟩)/√2 attains the bound.
  const phi = [r2, 0, 0, r2];
  const Sphi = S.map((row) => row.reduce((s, x, j) => s + x * phi[j], 0));
  const expectation = phi.reduce((s, x, i) => s + x * Sphi[i], 0);
  const squaresPSD = minEigenvalue(u2) > -1e-9 && minEigenvalue(v2) > -1e-9;
  return { residual, expectation, squaresPSD };
}

/** Convenience: the Frobenius norm of (Diag(y) − C) ⪰ 0 contraction with the optimal Γ ≈ 0 (KKT). */
export function complementarySlackness(res: NPAResult): number {
  const C = bellCostMatrix(CHSH_FUNCTIONAL);
  const slack: RealMat = res.moment.map((row, i) => row.map((_, j) => (i === j ? res.dualY[i] : 0) - C[i][j]));
  return Math.abs(frobenius(slack, res.moment));
}
