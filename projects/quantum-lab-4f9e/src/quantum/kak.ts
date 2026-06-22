// The two-qubit KAK (Cartan) decomposition — synthesising ANY two-qubit gate from
// scratch, the way a real compiler lowers a unitary onto hardware.
//
// A real machine has no "arbitrary U(4)" instruction. It has single-qubit rotations and
// ONE entangling gate (the CNOT). The structure theorem that makes universal compilation
// possible is the Cartan / KAK decomposition of SU(4): every two-qubit gate factors as
//
//     U = e^{iφ} (A₀ ⊗ A₁) · exp(i(cx XX + cy YY + cz ZZ)) · (B₀ ⊗ B₁)
//
// — a layer of single-qubit gates, a purely *non-local* "canonical" interaction fixed by
// three numbers (cx,cy,cz) (the Weyl-chamber coordinates), and another single-qubit layer.
// The triple (cx,cy,cz) is a complete local invariant: two gates are equal up to single-
// qubit gates iff they share it, and it dictates the MINIMUM number of CNOTs needed
// (0/1/2/3). Feeding the single-qubit pieces through Solovay–Kitaev then yields a fully
// discrete, fault-tolerant {H, T, CNOT} circuit.
//
// The algorithm is the classic "magic basis" trick (Kraus–Cirac / Makhlin): in the magic
// (Bell) basis M, a single-qubit pair k₀⊗k₁ becomes a REAL orthogonal matrix, and the
// canonical interaction becomes diagonal. So in that basis U is O₁ · F · O₂ with O₁,O₂ ∈
// SO(4) real and F diagonal — recovered by a real simultaneous diagonalisation of the
// commuting real and imaginary parts of Ũ Ũᵀ (robust even when eigenvalues coincide, as
// they do for CNOT/iSWAP). Everything reconstructs to ~1e-12 and is checked in the suite.

import { Complex, C } from './Complex';
import { matMul, dagger, tensorProduct } from './Matrix';

export type Mat = Complex[][];

// ───────────────────────────── small complex-matrix helpers ─────────────────────────────

export function zeros(n: number, m: number): Mat {
  return Array.from({ length: n }, () => Array.from({ length: m }, () => C(0)));
}
export function eye(n: number): Mat {
  const M = zeros(n, n);
  for (let i = 0; i < n; i++) M[i][i] = C(1);
  return M;
}
/** Plain (non-conjugate) transpose. */
export function transpose(A: Mat): Mat {
  const n = A.length, m = A[0].length, R = zeros(m, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) R[j][i] = A[i][j];
  return R;
}
export function scaleMat(A: Mat, z: Complex): Mat {
  return A.map((r) => r.map((x) => x.mul(z)));
}
export function frob(A: Mat, B: Mat): number {
  let s = 0;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) s += A[i][j].sub(B[i][j]).abs() ** 2;
  return Math.sqrt(s);
}
const eI = (t: number) => Complex.fromPolar(1, t);

/** Determinant of a complex square matrix via Gaussian elimination with partial pivoting. */
export function det(Ain: Mat): Complex {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  let d = C(1);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col; r < n; r++) if (A[r][col].abs() > A[piv][col].abs()) piv = r;
    if (A[piv][col].abs() < 1e-300) return C(0);
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; d = d.scale(-1); }
    d = d.mul(A[col][col]);
    const inv = C(1).div(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col].mul(inv);
      for (let k = col; k < n; k++) A[r][k] = A[r][k].sub(f.mul(A[col][k]));
    }
  }
  return d;
}

// ───────────────────────── real symmetric Jacobi eigensolver ─────────────────────────
// (A dedicated real version — the lab's Hermitian solver works too, but a flat real one
//  keeps the simultaneous-diagonalisation code simple and fast for the 4×4 blocks here.)

export function jacobiSym(Ain: number[][]): { values: number[]; vectors: number[][] } {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const app = A[p][p], aqq = A[q][q], apq = A[p][q];
      const tau = (aqq - app) / (2 * apq);
      const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: A.map((_, i) => A[i][i]), vectors: V };
}

/**
 * Simultaneous diagonalisation of two commuting real symmetric matrices Sr, Si by a single
 * real orthogonal O (columns = shared eigenvectors). Diagonalise Sr, then within each
 * degenerate eigen-cluster diagonalise Si — so degeneracies (CNOT, iSWAP) are handled.
 */
export function simDiag(Sr: number[][], Si: number[][]): number[][] {
  const n = Sr.length;
  const { values: v1, vectors: V } = jacobiSym(Sr);
  // Si in the V basis: T = Vᵀ Si V.
  const SiV = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let l = 0; l < n; l++) { let s = 0; for (let j = 0; j < n; j++) s += Si[i][j] * V[j][l]; SiV[i][l] = s; }
  const T = Array.from({ length: n }, () => Array(n).fill(0));
  for (let k = 0; k < n; k++) for (let l = 0; l < n; l++) { let s = 0; for (let i = 0; i < n; i++) s += V[i][k] * SiV[i][l]; T[k][l] = s; }
  const used = Array(n).fill(false);
  const O = V.map((r) => r.slice());
  for (let a = 0; a < n; a++) {
    if (used[a]) continue;
    const cluster = [a];
    used[a] = true;
    for (let b = a + 1; b < n; b++) if (!used[b] && Math.abs(v1[a] - v1[b]) < 1e-7) { cluster.push(b); used[b] = true; }
    if (cluster.length > 1) {
      const m = cluster.length;
      const sub = Array.from({ length: m }, (_, i) => cluster.map((j) => T[cluster[i]][j]));
      const { vectors: W } = jacobiSym(sub);
      const nc = Array.from({ length: n }, () => Array(m).fill(0));
      for (let i = 0; i < n; i++) for (let p = 0; p < m; p++) { let s = 0; for (let q = 0; q < m; q++) s += O[i][cluster[q]] * W[q][p]; nc[i][p] = s; }
      for (let p = 0; p < m; p++) for (let i = 0; i < n; i++) O[i][cluster[p]] = nc[i][p];
    }
  }
  return O;
}

// ───────────────────────────── the magic (Bell) basis ─────────────────────────────
// Columns are the four Bell states with phases. The key property: M† (k₀⊗k₁) M is real
// orthogonal for any single-qubit pair, and M† exp(i(cx XX+cy YY+cz ZZ)) M is diagonal.

const R2 = 1 / Math.sqrt(2);
export const MAGIC: Mat = [
  [C(R2), C(0), C(0), C(0, R2)],
  [C(0), C(0, R2), C(R2), C(0)],
  [C(0), C(0, R2), C(-R2), C(0)],
  [C(R2), C(0), C(0), C(0, -R2)],
];
export const MAGIC_DAG = dagger(MAGIC);

// Pauli tensor products (real symmetric).
const X: Mat = [[C(0), C(1)], [C(1), C(0)]];
const Y: Mat = [[C(0), C(0, -1)], [C(0, 1), C(0)]];
const Z: Mat = [[C(1), C(0)], [C(0), C(-1)]];
const XX = tensorProduct(X, X), YY = tensorProduct(Y, Y), ZZ = tensorProduct(Z, Z);

/** The canonical interaction gate A = exp(i(cx XX + cy YY + cz ZZ)). */
export function canonicalGate(cx: number, cy: number, cz: number): Mat {
  const H = zeros(4, 4);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
    H[i][j] = XX[i][j].scale(cx).add(YY[i][j].scale(cy)).add(ZZ[i][j].scale(cz));
  const Hr = H.map((r) => r.map((z) => z.re));        // H is real symmetric
  const { values, vectors } = jacobiSym(Hr);
  const O = vectors.map((r) => r.map((x) => C(x)));
  const D = zeros(4, 4);
  for (let k = 0; k < 4; k++) D[k][k] = eI(values[k]);
  return matMul(matMul(O, D), transpose(O));          // O diag(e^{iλ}) Oᵀ
}

// ───────────────────────── single-qubit (tensor) factorisation ─────────────────────────

/** Factor a 4×4 that equals k₀ ⊗ k₁ into its two SU(2) factors (k₀ on the high qubit). */
export function tensorFactor(M: Mat): { k0: Mat; k1: Mat } {
  let bi = 0, bj = 0, bn = -1;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    let nrm = 0;
    for (let k = 0; k < 2; k++) for (let l = 0; l < 2; l++) nrm += M[2 * i + k][2 * j + l].abs() ** 2;
    if (nrm > bn) { bn = nrm; bi = i; bj = j; }
  }
  let k1: Mat = [[M[2 * bi][2 * bj], M[2 * bi][2 * bj + 1]], [M[2 * bi + 1][2 * bj], M[2 * bi + 1][2 * bj + 1]]];
  const det2 = k1[0][0].mul(k1[1][1]).sub(k1[0][1].mul(k1[1][0]));
  const sdet = Complex.fromPolar(Math.sqrt(det2.abs()), det2.phase() / 2);   // normalise to SU(2)
  const invs = C(1).div(sdet);
  k1 = k1.map((r) => r.map((z) => z.mul(invs)));
  let nk = 0;
  for (let k = 0; k < 2; k++) for (let l = 0; l < 2; l++) nk += k1[k][l].abs() ** 2;
  const k0: Mat = [[C(0), C(0)], [C(0), C(0)]];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    let s = C(0);
    for (let k = 0; k < 2; k++) for (let l = 0; l < 2; l++) s = s.add(k1[k][l].conj().mul(M[2 * i + k][2 * j + l]));
    k0[i][j] = s.scale(1 / nk);
  }
  return { k0, k1 };
}

// ───────────────────────────── the KAK decomposition ─────────────────────────────

export interface KakResult {
  globalPhase: number;            // φ in U = e^{iφ} (A₀⊗A₁) · canonical · (B₀⊗B₁)
  left: [Mat, Mat];               // (A₀, A₁) — applied last
  coords: [number, number, number]; // raw canonical coords (cx,cy,cz) of the recovered A
  right: [Mat, Mat];              // (B₀, B₁) — applied first
  canonical: Mat;                 // the recovered canonical interaction gate
  reconError: number;            // ‖U − e^{iφ}(A₀⊗A₁)·canonical·(B₀⊗B₁)‖_F
  localityError: number;         // worst departure of the two local layers from a tensor product
}

const negCol = (M: number[][], c: number) => { for (let i = 0; i < M.length; i++) M[i][c] = -M[i][c]; };

/** Decompose any 4×4 unitary U into the Cartan form. */
export function kakDecompose(U: Mat): KakResult {
  const phi = det(U).phase() / 4;                       // reduce to SU(4)
  const U0 = scaleMat(U, eI(-phi));
  const Ut = matMul(matMul(MAGIC_DAG, U0), MAGIC);      // magic basis: Ut = O₁ F O₂
  const theta = matMul(Ut, transpose(Ut));             // = O₁ F² O₁ᵀ (complex symmetric)
  const Sr = theta.map((r) => r.map((z) => z.re));
  const Si = theta.map((r) => r.map((z) => z.im));
  const O1 = simDiag(Sr, Si);                           // real eigenvectors of θ
  if (det(O1.map((r) => r.map((x) => C(x)))).re < 0) negCol(O1, 0);   // force O₁ ∈ SO(4)
  const O1c = O1.map((r) => r.map((x) => C(x)));
  const left = matMul(transpose(O1c), Ut);             // = F O₂ (each row is e^{iμ}·real)
  const mus: number[] = [];
  const O2 = zeros(4, 4);
  for (let k = 0; k < 4; k++) {
    let bi = 0;
    for (let j = 1; j < 4; j++) if (left[k][j].abs() > left[k][bi].abs()) bi = j;
    const mu = left[k][bi].phase();
    const row = left[k].map((z) => z.mul(eI(-mu)));     // strip the shared phase → real row
    mus.push(mu);
    for (let j = 0; j < 4; j++) O2[k][j] = C(row[j].re);
  }
  if (det(O2).re < 0) { for (let j = 0; j < 4; j++) O2[0][j] = O2[0][j].scale(-1); mus[0] += Math.PI; }  // force O₂ ∈ SO(4)
  const Fd = zeros(4, 4);
  for (let k = 0; k < 4; k++) Fd[k][k] = eI(mus[k]);
  const L = matMul(matMul(MAGIC, O1c), MAGIC_DAG);     // = A₀ ⊗ A₁ (local)
  const Rr = matMul(matMul(MAGIC, O2), MAGIC_DAG);     // = B₀ ⊗ B₁ (local)
  const A = matMul(matMul(MAGIC, Fd), MAGIC_DAG);      // = canonical interaction gate

  const { k0: a0, k1: a1 } = tensorFactor(L);
  const { k0: b0, k1: b1 } = tensorFactor(Rr);
  const coords = canonCoordsOf(A);

  const recon = scaleMat(matMul(matMul(L, A), Rr), eI(phi));
  const reconError = frob(recon, U);
  const localityError = Math.max(frob(tensorProduct(a0, a1), L), frob(tensorProduct(b0, b1), Rr));

  return { globalPhase: phi, left: [a0, a1], coords, right: [b0, b1], canonical: A, reconError, localityError };
}

/** Read the raw canonical coordinates (cx,cy,cz) off a Bell-diagonal canonical gate A. */
export function canonCoordsOf(A: Mat): [number, number, number] {
  const F = matMul(matMul(MAGIC_DAG, A), MAGIC);       // diagonal e^{iμk} in fixed magic order
  const m0 = F[0][0].phase(), m1 = F[1][1].phase(), m2 = F[2][2].phase(), m3 = F[3][3].phase();
  // Inverse of the calibrated sign table (μ = S·(cx,cy,cz)).
  return [(m0 + m1 - m2 - m3) / 4, (-m0 + m1 - m2 + m3) / 4, (m0 - m1 - m2 + m3) / 4];
}

// ───────────────────────── Weyl chamber + local invariants ─────────────────────────

const HALF_PI = Math.PI / 2, QUARTER_PI = Math.PI / 4;
const reduceHalfPi = (v: number) => {
  let x = v % HALF_PI;
  if (x > QUARTER_PI) x -= HALF_PI;
  if (x <= -QUARTER_PI + 1e-12) x += HALF_PI;
  return x;
};

/**
 * Canonicalise (cx,cy,cz) into the Weyl chamber π/4 ≥ x ≥ y ≥ |z|. The sign of z is a
 * chirality invariant for x < π/4 (a gate and its mirror have conjugate local invariants),
 * fixed here by matching the Makhlin invariant of the source gate when one is supplied.
 */
export function canonicalizeCoords(c: [number, number, number], U0?: Mat): [number, number, number] {
  const v = c.map(reduceHalfPi);
  const m = v.map(Math.abs).sort((a, b) => b - a) as [number, number, number];
  if (!U0) return m;
  const mk = makhlinInvariants(U0);
  const cands: [number, number, number][] = [[m[0], m[1], m[2]], [m[0], m[1], -m[2]]];
  let best = cands[0], be = Infinity;
  for (const cc of cands) {
    const mc = makhlinInvariants(canonicalGate(...cc));
    const e = mk.G1.sub(mc.G1).abs() + mk.G2.sub(mc.G2).abs();
    if (e < be) { be = e; best = cc; }
  }
  return best;
}

/** The Makhlin local invariants G₁, G₂ (a complete set for two-qubit local equivalence). */
export function makhlinInvariants(U0: Mat): { G1: Complex; G2: Complex } {
  // Renormalise to SU(4) so the invariants are well-defined.
  const su = scaleMat(U0, eI(-det(U0).phase() / 4));
  const Ut = matMul(matMul(MAGIC_DAG, su), MAGIC);
  const m = matMul(transpose(Ut), Ut);
  const tr = (M: Mat) => { let s = C(0); for (let i = 0; i < M.length; i++) s = s.add(M[i][i]); return s; };
  const trm = tr(m), trm2 = trm.mul(trm);
  const m2 = matMul(m, m);
  return { G1: trm2.scale(1 / 16), G2: trm2.sub(tr(m2)).scale(1 / 4) };
}

/** Minimum number of CNOTs to realise a gate with the given (canonicalised) coordinates. */
export function cnotCount(c: [number, number, number]): number {
  const x = Math.abs(c[0]), y = Math.abs(c[1]), z = Math.abs(c[2]), e = 1e-6;
  if (x < e && y < e && z < e) return 0;
  if (Math.abs(x - QUARTER_PI) < e && y < e && z < e) return 1;
  if (z < e) return 2;
  return 3;
}

// ───────────────────────── single-qubit ZYZ decomposition ─────────────────────────

/** Euler ZYZ angles of a 2×2 unitary: U = e^{iα} Rz(β) Ry(γ) Rz(δ), Rσ(θ)=exp(−iθσ/2). */
export function zyzAngles(U: Mat): { alpha: number; beta: number; gamma: number; delta: number } {
  const d = U[0][0].mul(U[1][1]).sub(U[0][1].mul(U[1][0]));
  const alpha = d.phase() / 2;
  const u = scaleMat(U, eI(-alpha));                   // now in SU(2)
  const gamma = 2 * Math.atan2(u[1][0].abs(), u[0][0].abs());
  const bpd = u[1][1].phase();                         // (β+δ)/2
  const bmd = u[1][0].phase();                         // (β−δ)/2
  return { alpha, beta: bpd + bmd, gamma, delta: bpd - bmd };
}
