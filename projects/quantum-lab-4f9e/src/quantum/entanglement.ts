import { Complex, C } from './Complex';
import type { Matrix } from './Matrix';
import { matMul, tensorProduct, identity, dagger } from './Matrix';
import { hermitianEig, vonNeumannEntropy } from './Hermitian';

/**
 * Mixed-state entanglement theory for two qubits, built from scratch on the lab's own
 * complex linear algebra (matMul / tensorProduct / the Jacobi Hermitian eigensolver).
 *
 * Where the Bell / device-independent pillars ask what *correlations* an entangled state can
 * produce, this module studies entanglement itself as a *resource*: how much of it a mixed
 * state carries (Wootters concurrence, entanglement of formation, negativity, log-negativity),
 * whether it carries any at all (the Peres–Horodecki PPT criterion — necessary AND sufficient
 * in 2×2), how those measures sit in the Werner-state hierarchy against steering and Bell
 * nonlocality, how two-qubit entanglement is monogamous (Coffman–Kundu–Wootters, the 3-tangle),
 * and how noisy entanglement is purified back toward a Bell pair (BBPSSW recurrence distillation
 * — verified by an exact 16-dimensional simulation of the bilateral-CNOT protocol).
 */

// ─────────────────────────────── small complex linear algebra ───────────────────────────────

/** Entrywise complex conjugate. */
function conjMat(m: Matrix): Matrix {
  return m.map((row) => row.map((z) => z.conj()));
}

/** Re Tr(ρ M) — the physical expectation of a Hermitian observable M in state ρ. */
export function expect(rho: Matrix, M: Matrix): number {
  let s = 0;
  const n = rho.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += rho[i][j].mul(M[j][i]).re;
  return s;
}

/** Hermitian matrix from an outer product |v⟩⟨v| of a (possibly unnormalised) complex vector. */
function ketBra(v: Complex[]): Matrix {
  const n = v.length;
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => v[i].mul(v[j].conj())));
}

/** A ← scalar·A + scalar·B for real scalars (both matrices same shape). */
function mix(a: number, A: Matrix, b: number, B: Matrix): Matrix {
  return A.map((row, i) => row.map((z, j) => z.scale(a).add(B[i][j].scale(b))));
}

/** Principal square root of a Hermitian PSD matrix via its eigendecomposition (√λ ≥ 0). */
export function sqrtPSD(rho: Matrix): Matrix {
  const { values, vectors } = hermitianEig(rho);
  const n = values.length;
  const D: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? C(Math.sqrt(Math.max(0, values[i]))) : C(0))),
  );
  return matMul(matMul(vectors, D), dagger(vectors));
}

// ─────────────────────────────── single-qubit Paulis ───────────────────────────────

export const I2: Matrix = [[C(1), C(0)], [C(0), C(1)]];
export const PX: Matrix = [[C(0), C(1)], [C(1), C(0)]];
export const PY: Matrix = [[C(0), C(0, -1)], [C(0, 1), C(0)]];
export const PZ: Matrix = [[C(1), C(0)], [C(0), C(-1)]];
const PAULIS = [PX, PY, PZ];

// ─────────────────────────────── canonical two-qubit states ───────────────────────────────

const INV_SQRT2 = 1 / Math.SQRT2;
/** Bell |Φ⁺⟩ = (|00⟩+|11⟩)/√2, |Φ⁻⟩, |Ψ⁺⟩, |Ψ⁻⟩ as state vectors. */
export const BELL_PHI_PLUS = [C(INV_SQRT2), C(0), C(0), C(INV_SQRT2)];
export const BELL_PHI_MINUS = [C(INV_SQRT2), C(0), C(0), C(-INV_SQRT2)];
export const BELL_PSI_PLUS = [C(0), C(INV_SQRT2), C(INV_SQRT2), C(0)];
export const BELL_PSI_MINUS = [C(0), C(INV_SQRT2), C(-INV_SQRT2), C(0)];

export const RHO_PHI_PLUS = ketBra(BELL_PHI_PLUS);
export const rhoPsiMinus = ketBra(BELL_PSI_MINUS);
export const MAX_MIXED_2Q: Matrix = identity(4).map((row) => row.map((z) => z.scale(0.25)));

/** A reproducible random two-qubit mixed state ρ = AA†/Tr(AA†) from a seed (valid, full-rank). */
export function randomMixed(seed: number): Matrix {
  let a = (seed * 2654435761) >>> 0;
  const rng = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const A: Matrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => C(rng() * 2 - 1, rng() * 2 - 1)));
  const R = matMul(A, dagger(A));
  let tr = 0;
  for (let i = 0; i < 4; i++) tr += R[i][i].re;
  return R.map((row) => row.map((z) => z.scale(1 / tr)));
}

/**
 * The Werner / isotropic family ρ(p) = p·|Φ⁺⟩⟨Φ⁺| + (1−p)·I/4, p ∈ [0,1] — a Bell pair seen
 * through a depolarizing channel of visibility p. The canonical one-parameter probe: its
 * separability, steering and Bell-nonlocality thresholds are all exact rationals, so every
 * measure below can be checked against a closed form.
 */
export function wernerState(p: number): Matrix {
  return mix(p, RHO_PHI_PLUS, 1 - p, MAX_MIXED_2Q);
}

/** Fidelity of the Werner state to |Φ⁺⟩: F = ⟨Φ⁺|ρ(p)|Φ⁺⟩ = (1+3p)/4. */
export function wernerFidelity(p: number): number {
  return (1 + 3 * p) / 4;
}

/** A separable but classically-correlated state ½|00⟩⟨00| + ½|11⟩⟨11| (C = N = 0, yet correlated). */
export const CLASSICAL_CORRELATED: Matrix = mix(0.5, ketBra([C(1), C(0), C(0), C(0)]), 0.5, ketBra([C(0), C(0), C(0), C(1)]));

/** Product state |a⟩⊗|b⟩ from two Bloch angles, as a 4×4 density matrix (pure, separable). */
export function productState(thetaA: number, thetaB: number): Matrix {
  const a = [C(Math.cos(thetaA / 2)), C(Math.sin(thetaA / 2))];
  const b = [C(Math.cos(thetaB / 2)), C(Math.sin(thetaB / 2))];
  return tensorProduct(ketBra(a), ketBra(b));
}

// ─────────────────────────────── the measures ───────────────────────────────

/** Purity Tr(ρ²) and von Neumann entropy S(ρ) = −Tr ρ log₂ ρ. */
export function purity(rho: Matrix): number {
  let s = 0;
  for (const row of rho) for (const z of row) s += z.abs2();
  return s;
}
export function vonNeumann(rho: Matrix): number {
  return vonNeumannEntropy(hermitianEig(rho).values);
}

/**
 * Wootters concurrence of a two-qubit state — the exact entanglement monotone that closed the
 * mixed-state entanglement-of-formation problem for two qubits.
 *
 * C(ρ) = max(0, λ₁ − λ₂ − λ₃ − λ₄), where λᵢ (sorted ↓) are the square roots of the eigenvalues
 * of ρ·ρ̃ with the spin-flipped ρ̃ = (Y⊗Y)·ρ*·(Y⊗Y). The eigenvalues of ρρ̃ are real and ≥0;
 * to get them robustly (ρρ̃ is not Hermitian) we diagonalise the Hermitian, spectrally-identical
 * √ρ·ρ̃·√ρ instead.
 */
export function concurrence(rho: Matrix): number {
  const YY = tensorProduct(PY, PY);
  const rhoTilde = matMul(matMul(YY, conjMat(rho)), YY);
  const sr = sqrtPSD(rho);
  const M = matMul(matMul(sr, rhoTilde), sr); // Hermitian, same spectrum as ρρ̃
  const eig = hermitianEig(M).values.map((v) => Math.sqrt(Math.max(0, v))).sort((a, b) => b - a);
  return Math.max(0, eig[0] - eig[1] - eig[2] - eig[3]);
}

/** Binary entropy h(x) = −x log₂x − (1−x) log₂(1−x). */
export function binaryEntropy(x: number): number {
  if (x <= 0 || x >= 1) return 0;
  return -x * Math.log2(x) - (1 - x) * Math.log2(1 - x);
}

/** Entanglement of formation from the concurrence: E_F = h((1+√(1−C²))/2). */
export function entanglementOfFormation(rho: Matrix): number {
  const c = concurrence(rho);
  return binaryEntropy((1 + Math.sqrt(Math.max(0, 1 - c * c))) / 2);
}

/** Partial transpose over qubit B (the second qubit): (ρ^{T_B})_{ab,a'b'} = ρ_{ab',a'b}. */
export function partialTransposeB(rho: Matrix): Matrix {
  const out: Matrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => C(0)));
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++)
    for (let a2 = 0; a2 < 2; a2++) for (let b2 = 0; b2 < 2; b2++) {
      out[2 * a + b][2 * a2 + b2] = rho[2 * a + b2][2 * a2 + b];
    }
  return out;
}

export interface PPTResult {
  eigenvalues: number[]; // of ρ^{T_B}, sorted ↓
  minEigenvalue: number;
  negativity: number; // N = |Σ negative eigenvalues| = (‖ρ^{T_B}‖₁ − 1)/2
  logNegativity: number; // E_N = log₂ ‖ρ^{T_B}‖₁ = log₂(2N+1)
  separable: boolean; // PPT ⇔ separable for 2×2 (Horodecki)
}

/** The Peres–Horodecki PPT test + negativity / logarithmic negativity. */
export function pptAnalysis(rho: Matrix, eps = 1e-9): PPTResult {
  const eigenvalues = hermitianEig(partialTransposeB(rho)).values;
  let neg = 0;
  for (const v of eigenvalues) if (v < 0) neg += -v;
  const minEigenvalue = Math.min(...eigenvalues);
  return {
    eigenvalues,
    minEigenvalue,
    negativity: neg,
    logNegativity: Math.log2(2 * neg + 1),
    separable: minEigenvalue > -eps,
  };
}

/** Correlation matrix T_ij = Tr(ρ σ_i⊗σ_j), i,j ∈ {x,y,z}. */
export function correlationMatrix(rho: Matrix): number[][] {
  return PAULIS.map((si) => PAULIS.map((sj) => expect(rho, tensorProduct(si, sj))));
}

/**
 * Maximal CHSH value achievable by optimising the measurement settings (Horodecki criterion):
 * S_max = 2·√(t₁+t₂), where t₁ ≥ t₂ are the two largest eigenvalues of TᵀT. The state violates
 * a Bell inequality iff S_max > 2.
 */
export function chshMax(rho: Matrix): number {
  const T = correlationMatrix(rho);
  // U = TᵀT (real symmetric 3×3); its eigenvalues are the squared singular values of T.
  const U: Matrix = Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => {
      let s = 0;
      for (let k = 0; k < 3; k++) s += T[k][i] * T[k][j];
      return C(s);
    }));
  const ev = hermitianEig(U).values.sort((a, b) => b - a);
  return 2 * Math.sqrt(Math.max(0, ev[0]) + Math.max(0, ev[1]));
}

/** Bell-state fidelity ⟨Φ⁺|ρ|Φ⁺⟩ (the singlet-fraction analogue for |Φ⁺⟩). */
export function fidelityToPhiPlus(rho: Matrix): number {
  return expect(rho, RHO_PHI_PLUS);
}

// ─────────────────────────────── the optimal entanglement witness ───────────────────────────────

export interface Witness {
  exists: boolean; // an entanglement witness exists iff ρ is NPT (entangled)
  W: Matrix; // the witness operator W = |η⟩⟨η|^{T_B}
  value: number; // Tr(Wρ) — negative exactly when ρ is entangled
  lambdaMin: number; // the min eigenvalue of ρ^{T_B} (equals value by construction)
}

/**
 * The optimal entanglement witness dual to the PPT test. If ρ has a negative partial-transpose
 * eigenvalue λ with eigenvector |η⟩, then W = |η⟩⟨η|^{T_B} is a Hermitian operator with
 * Tr(Wσ) ≥ 0 for EVERY separable σ (because σ^{T_B} stays positive) yet Tr(Wρ) = ⟨η|ρ^{T_B}|η⟩ = λ < 0
 * — a hyperplane in the space of operators that separates the entangled ρ from the convex separable set.
 */
export function optimalWitness(rho: Matrix): Witness {
  const eig = hermitianEig(partialTransposeB(rho));
  const idx = eig.values.length - 1; // values sorted descending ⇒ last is the minimum
  const lambdaMin = eig.values[idx];
  const eta = eig.vectors.map((row) => row[idx]); // the eigenvector column
  const W = partialTransposeB(ketBra(eta)); // W = |η⟩⟨η|^{T_B}
  return { exists: lambdaMin < -1e-9, W, value: expect(rho, W), lambdaMin };
}

/** A reproducible random SEPARABLE two-qubit state: a convex mix of random product states. */
export function randomSeparable(seed: number, terms = 4): Matrix {
  let a = (seed * 40503 + 12345) >>> 0;
  const rng = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: Matrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => C(0)));
  let wsum = 0;
  for (let k = 0; k < terms; k++) {
    const w = rng() + 1e-3; wsum += w;
    const rho = productState(rng() * Math.PI, rng() * Math.PI); // a random pure product state
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i][j] = out[i][j].add(rho[i][j].scale(w));
  }
  return out.map((row) => row.map((z) => z.scale(1 / wsum)));
}

// ─────────────────────────────── the Werner-state hierarchy ───────────────────────────────

/** The four exact thresholds of the Werner/isotropic family, in the visibility p. */
export const WERNER_THRESHOLDS = {
  separable: 1 / 3, // p ≤ 1/3 separable (Peres–Horodecki); p > 1/3 entangled AND distillable
  steerable: 1 / 2, // p > 1/2 steerable by projective measurements (Wiseman–Jones–Doherty)
  bell: 1 / Math.SQRT2, // p > 1/√2 violates CHSH (Bell-nonlocal)
} as const;

export interface WernerPoint {
  p: number;
  concurrence: number;
  negativity: number;
  chsh: number;
  entropy: number;
  hashingYield: number; // 1 − S(ρ): a lower bound on distillable entanglement (hashing bound)
}

/** Sample the Werner family, returning every measure vs the visibility p. */
export function wernerSweep(samples = 121): WernerPoint[] {
  const out: WernerPoint[] = [];
  for (let i = 0; i < samples; i++) {
    const p = i / (samples - 1);
    const rho = wernerState(p);
    out.push({
      p,
      concurrence: concurrence(rho),
      negativity: pptAnalysis(rho).negativity,
      chsh: chshMax(rho),
      entropy: vonNeumann(rho),
      hashingYield: Math.max(0, 1 - vonNeumann(rho)),
    });
  }
  return out;
}

/** Closed-form Werner concurrence C(p) = max(0, (3p−1)/2) — the check for the numeric routine. */
export function wernerConcurrenceExact(p: number): number {
  return Math.max(0, (3 * p - 1) / 2);
}
/** Closed-form Werner negativity N(p) = max(0, (3p−1)/4). */
export function wernerNegativityExact(p: number): number {
  return Math.max(0, (3 * p - 1) / 4);
}
/** Closed-form Werner CHSH value S(p) = 2√2·p. */
export function wernerChshExact(p: number): number {
  return 2 * Math.SQRT2 * p;
}

// ─────────────────────────────── entanglement distillation (BBPSSW) ───────────────────────────────

/**
 * The BBPSSW recurrence map on the singlet fraction F of a Werner state (Bennett, Brassard,
 * Popescu, Schumacher, Smolin, Wootters 1996). Take two identical noisy pairs, apply a bilateral
 * CNOT, measure the target pair and keep only when the two outcomes agree; the surviving source
 * pair (re-twirled to Werner form) has fidelity
 *
 *     F' = [F² + (1/9)(1−F)²] / [F² + (2/3)F(1−F) + (5/9)(1−F)²].
 *
 * F = 1/2 is the unstable fixed point: above it the map climbs to F = 1 (a pure Bell pair),
 * below it collapses to F = 1/4 (the maximally mixed state). F > 1/2 ⇔ the pair is entangled.
 */
export function bbpsswStep(F: number): number {
  const num = F * F + (1 / 9) * (1 - F) * (1 - F);
  const den = F * F + (2 / 3) * F * (1 - F) + (5 / 9) * (1 - F) * (1 - F);
  return num / den;
}

/** Acceptance probability (both target measurements agree) of one BBPSSW round at fidelity F. */
export function bbpsswAcceptance(F: number): number {
  return F * F + (2 / 3) * F * (1 - F) + (5 / 9) * (1 - F) * (1 - F);
}

export interface DistillRound {
  round: number;
  F: number;
  concurrence: number; // concurrence of the Werner state with this fidelity
  accept: number; // acceptance probability of the round that produced this F
  pairsPerOutput: number; // raw noisy pairs consumed per surviving output pair
}

/** Run the BBPSSW recurrence for `rounds` iterations from an initial fidelity F₀. */
export function bbpsswCascade(F0: number, rounds: number): DistillRound[] {
  const out: DistillRound[] = [{ round: 0, F: F0, concurrence: wernerFromFidelityConcurrence(F0), accept: 1, pairsPerOutput: 1 }];
  let F = F0;
  let pairs = 1;
  for (let r = 1; r <= rounds; r++) {
    const accept = bbpsswAcceptance(F);
    F = bbpsswStep(F);
    // each round needs 2 input pairs and succeeds with prob `accept`
    pairs = (pairs * 2) / accept;
    out.push({ round: r, F, concurrence: wernerFromFidelityConcurrence(F), accept, pairsPerOutput: pairs });
  }
  return out;
}

/** Concurrence of the Werner state whose |Φ⁺⟩-fidelity is F (p = (4F−1)/3 ⇒ C = max(0,2F−1)). */
export function wernerFromFidelityConcurrence(F: number): number {
  return Math.max(0, 2 * F - 1);
}

// ---- exact 16-dimensional simulation of the protocol (ground truth for the closed form) ----

/** CNOT (control c, target t) embedded on 4 qubits (16×16), MSB = qubit 0. */
function cnot4(control: number, target: number): Matrix {
  const U: Matrix = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => C(0)));
  for (let s = 0; s < 16; s++) {
    const cb = (s >> (3 - control)) & 1;
    let d = s;
    if (cb) d ^= 1 << (3 - target);
    U[d][s] = C(1);
  }
  return U;
}

export interface SimulatedRound {
  Fout: number; // fidelity of the post-selected output pair to |Φ⁺⟩
  accept: number; // probability both target qubits measured equal
}

/**
 * Simulate one BBPSSW round exactly on ρ⊗ρ (16×16). Qubit layout: 0=A_src, 1=A_tgt, 2=B_src,
 * 3=B_tgt. Alice CNOTs src→tgt (control 0, target 1); Bob CNOTs src→tgt (control 2, target 3).
 * Measure the two target qubits (1,3) in Z; post-select on equal outcomes; return the reduced
 * source pair's fidelity to |Φ⁺⟩ and the acceptance probability. This is an independent check on
 * the closed-form `bbpsswStep`.
 */
export function bbpsswSimulate(rho: Matrix): SimulatedRound {
  // ρ⊗ρ with qubit order (A_src, B_src) ⊗ (A_src', B_src') → relabel to (A_src,A_tgt,B_src,B_tgt).
  const rr = tensorProduct(rho, rho); // qubits: 0=A_src,1=B_src,2=A_tgt,3=B_tgt
  // permute to 0=A_src,1=A_tgt,2=B_src,3=B_tgt: swap qubit indices 1 and 2.
  const perm = permuteQubits(rr, [0, 2, 1, 3]);
  const U = matMul(cnot4(0, 1), cnot4(2, 3));
  const evolved = matMul(matMul(U, perm), dagger(U));
  // Measure targets 1 and 3; keep outcomes with bit1 == bit3. Build the projected (unnormalised) ρ.
  let accept = 0;
  const kept: Matrix = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => C(0)));
  for (let s = 0; s < 16; s++) {
    const b1 = (s >> (3 - 1)) & 1;
    const b3 = (s >> (3 - 3)) & 1;
    if (b1 !== b3) continue;
    for (let t = 0; t < 16; t++) {
      const t1 = (t >> (3 - 1)) & 1;
      const t3 = (t >> (3 - 3)) & 1;
      if (t1 !== t3) continue;
      // only diagonal-in-target blocks survive a projective measurement bookkeeping;
      // but keeping the full coherent block for the kept target values and tracing them is exact.
      if (t1 === b1 && t3 === b3) kept[s][t] = evolved[s][t];
    }
  }
  for (let s = 0; s < 16; s++) accept += kept[s][s].re;
  if (accept < 1e-15) return { Fout: 0, accept: 0 };
  // reduced density matrix of the source pair (qubits 0,2) after tracing 1,3, then normalise.
  const src = partialTrace4to2(kept, [0, 2]);
  const norm = src[0][0].re + src[1][1].re + src[2][2].re + src[3][3].re;
  const srcNorm = src.map((row) => row.map((z) => z.scale(1 / norm)));
  return { Fout: fidelityToPhiPlus(srcNorm), accept };
}

/** Permute the 4 qubits of a 16×16 operator: newQubitOrder[i] = old index placed at new slot i. */
function permuteQubits(m: Matrix, order: number[]): Matrix {
  const map = (idx: number) => {
    let out = 0;
    for (let newPos = 0; newPos < 4; newPos++) {
      const oldPos = order[newPos];
      const bit = (idx >> (3 - oldPos)) & 1;
      out |= bit << (3 - newPos);
    }
    return out;
  };
  const out: Matrix = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => C(0)));
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) out[map(i)][map(j)] = m[i][j];
  return out;
}

/** Partial trace of a 16×16 (4-qubit) operator down to the two kept qubits (returns 4×4). */
function partialTrace4to2(m: Matrix, keep: number[]): Matrix {
  const trace = [0, 1, 2, 3].filter((q) => !keep.includes(q));
  const bitAt = (idx: number, q: number) => (idx >> (3 - q)) & 1;
  const compose = (kb: number[], tb: number[]) => {
    let idx = 0;
    keep.forEach((q, i) => { idx |= kb[i] << (3 - q); });
    trace.forEach((q, i) => { idx |= tb[i] << (3 - q); });
    return idx;
  };
  const out: Matrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => C(0)));
  for (let ka = 0; ka < 4; ka++) for (let kc = 0; kc < 4; kc++) {
    const kaBits = [(ka >> 1) & 1, ka & 1];
    const kcBits = [(kc >> 1) & 1, kc & 1];
    for (let t = 0; t < 4; t++) {
      const tBits = [(t >> 1) & 1, t & 1];
      const i = compose(kaBits, tBits);
      const j = compose(kcBits, tBits);
      out[ka][kc] = out[ka][kc].add(m[i][j]);
    }
  }
  // silence unused-var lint for bitAt (kept for clarity of the index convention)
  void bitAt;
  return out;
}

// ─────────────────────────────── monogamy of entanglement (CKW) ───────────────────────────────

/** Reduced 4×4 density matrix of two qubits from a 3-qubit pure state |ψ⟩ (8-vector), tracing the third. */
function reduceTwoQubits(psi: Complex[], keep: [number, number]): Matrix {
  const trace = [0, 1, 2].find((q) => q !== keep[0] && q !== keep[1])!;
  const bit = (idx: number, q: number) => (idx >> (2 - q)) & 1;
  const out: Matrix = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => C(0)));
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    if (bit(i, trace) !== bit(j, trace)) continue;
    const ra = (bit(i, keep[0]) << 1) | bit(i, keep[1]);
    const rb = (bit(j, keep[0]) << 1) | bit(j, keep[1]);
    out[ra][rb] = out[ra][rb].add(psi[i].mul(psi[j].conj()));
  }
  return out;
}

/** Single-qubit reduced density matrix from a 3-qubit pure state. */
function reduceOneQubit(psi: Complex[], keep: number): Matrix {
  const others = [0, 1, 2].filter((q) => q !== keep);
  const bit = (idx: number, q: number) => (idx >> (2 - q)) & 1;
  const out: Matrix = [[C(0), C(0)], [C(0), C(0)]];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    if (bit(i, others[0]) !== bit(j, others[0]) || bit(i, others[1]) !== bit(j, others[1])) continue;
    out[bit(i, keep)][bit(j, keep)] = out[bit(i, keep)][bit(j, keep)].add(psi[i].mul(psi[j].conj()));
  }
  return out;
}

export interface Monogamy {
  cAB: number; // concurrence of qubits A,B
  cAC: number; // concurrence of qubits A,C
  cSq_Abc: number; // C²(A|BC) = 4 det ρ_A — the one-vs-rest tangle
  tangle: number; // residual 3-tangle τ = C²(A|BC) − C²_AB − C²_AC ≥ 0
  satisfied: boolean; // the CKW inequality C²(A|BC) ≥ C²_AB + C²_AC holds
}

/**
 * Coffman–Kundu–Wootters monogamy for a 3-qubit pure state |ψ⟩ (8-vector). The entanglement of
 * A with the *rest* upper-bounds what A can share pairwise: C²(A|BC) ≥ C²_AB + C²_AC. The slack
 * is the permutation-invariant 3-tangle τ — 1 for |GHZ⟩ (irreducibly tripartite), 0 for |W⟩.
 */
export function monogamy(psi: Complex[]): Monogamy {
  const rhoA = reduceOneQubit(psi, 0);
  const cSq_Abc = 4 * detHermitian2(rhoA); // C²(A|BC) = 2(1−Trρ_A²) = 4 det ρ_A for a pure global state
  const cAB = concurrence(reduceTwoQubits(psi, [0, 1]));
  const cAC = concurrence(reduceTwoQubits(psi, [0, 2]));
  const tangle = cSq_Abc - cAB * cAB - cAC * cAC;
  return { cAB, cAC, cSq_Abc, tangle: Math.max(0, tangle), satisfied: tangle > -1e-9 };
}

/** Determinant of a 2×2 Hermitian matrix (real). */
function detHermitian2(m: Matrix): number {
  return m[0][0].mul(m[1][1]).sub(m[0][1].mul(m[1][0])).re;
}

/** |GHZ⟩ = (|000⟩+|111⟩)/√2 and |W⟩ = (|001⟩+|010⟩+|100⟩)/√3 as 8-vectors. */
export const GHZ3 = [C(INV_SQRT2), C(0), C(0), C(0), C(0), C(0), C(0), C(INV_SQRT2)];
export const W3 = (() => {
  const v = Array.from({ length: 8 }, () => C(0));
  const a = 1 / Math.sqrt(3);
  v[1] = C(a); v[2] = C(a); v[4] = C(a);
  return v;
})();

/** A generalised GHZ/W interpolation |ψ(s)⟩ = normalise(√(1−s)·|GHZ⟩ + √s·|W⟩), s ∈ [0,1]. */
export function ghzWInterpolate(s: number): Complex[] {
  const a = Math.sqrt(1 - s), b = Math.sqrt(s);
  const v = GHZ3.map((z, i) => z.scale(a).add(W3[i].scale(b)));
  let n = 0;
  for (const z of v) n += z.abs2();
  const inv = 1 / Math.sqrt(n);
  return v.map((z) => z.scale(inv));
}
