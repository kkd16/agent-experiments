import { Complex, C } from './Complex';
import { type Matrix, matVecMul } from './Matrix';
import { QuantumState } from './QuantumState';
import { singleQubitCliffords } from './rb';
import { GATE_H, GATE_S } from './gates/single';

/**
 * CLASSICAL SHADOWS — predicting many properties of a quantum state from very few
 * measurements (Huang, Kueng & Preskill, *Nature Physics* 2020).
 *
 * The idea. You cannot read a 2ⁿ-amplitude state out of a quantum device; you can only
 * measure it, and each measurement returns one classical bit-string. Full tomography needs
 * exponentially many measurements. But you usually don't want the whole state — you want a
 * handful of expectation values ⟨O₁⟩, ⟨O₂⟩, … . Classical shadows get all of them at once:
 *
 *   1. Apply a *random* unitary U (drawn from a fixed ensemble) and measure in the
 *      computational basis, getting |b⟩.
 *   2. The measurement is an information-losing quantum channel  M(ρ) = E[ U†|b⟩⟨b|U ].
 *      Because M is a known, invertible linear map, a single run yields an *unbiased*
 *      classical estimate of the whole state — the SNAPSHOT
 *
 *          ρ̂ = M⁻¹( U†|b⟩⟨b|U ),     E[ρ̂] = ρ.
 *
 *   3. Average  ô = tr(O ρ̂)  over the snapshots to estimate ⟨O⟩ = tr(Oρ). One dataset of
 *      snapshots — the "classical shadow" of ρ — predicts ANY observable you ask for later.
 *
 * Two ensembles, two regimes (both built here from scratch and verified):
 *
 *   • RANDOM PAULI (local).  U = ⊗ R_q, each qubit independently rotated into a random
 *     X/Y/Z basis. The inverse channel factorises, σ̂_q = 3|s_q⟩⟨s_q| − I, so the snapshot
 *     of a weight-k Pauli is read off in O(k): no exponential storage. The price is locality:
 *     the variance of a weight-k Pauli is bounded by 3ᵏ (computed exactly below), so it is
 *     ideal for the many *local* observables of a Hamiltonian or a correlation function.
 *
 *   • RANDOM CLIFFORD (global).  U is a uniform n-qubit Clifford (an exact 3-design, so the
 *     estimator is exact). The inverse is ρ̂ = (2ⁿ+1) U†|b⟩⟨b|U − I, and the variance of ANY
 *     observable is bounded by 3·tr(O₀²) independent of locality — perfect for fidelities and
 *     low-rank observables. We enumerate the Clifford group for n ≤ 2 (24 and 11520 elements)
 *     so the ensemble is provably uniform.
 *
 * Applications built on top: simultaneous estimation of many observables; the robust
 * MEDIAN-OF-MEANS aggregator; the second-moment (purity Tr ρ², hence the 2-Rényi entanglement
 * entropy) via a U-statistic over snapshot pairs; and quantum-state FIDELITY with a pure
 * target. Everything is cross-checked against the exact state vector, and the unbiasedness is
 * proven *deterministically* (not just statistically) by enumerating the finite measurement
 * ensemble.
 */

// ───────────────────────────── seeded RNG ─────────────────────────────

/** mulberry32 — a small, fast, seedable PRNG so every shadow run reproduces from a seed. */
export function shadowRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── Pauli observables ─────────────────────────────

export type Pauli = 'I' | 'X' | 'Y' | 'Z';
/** A Pauli string as a length-n array; index q is the Pauli on qubit q (qubit 0 = LSB). */
export type PauliString = Pauli[];

/** 0 = X, 1 = Y, 2 = Z basis index (the order in which a qubit can be measured). */
const PAULI_TO_BASIS: Record<string, number> = { X: 0, Y: 1, Z: 2 };

export function pauliWeight(p: PauliString): number {
  return p.reduce((w, c) => w + (c === 'I' ? 0 : 1), 0);
}

export function pauliLabel(p: PauliString): string {
  // Most-significant qubit first, matching ket order |q_{n-1}…q_0⟩.
  return p.slice().reverse().join('');
}

/** Parse "XIZ" (MSB first) into a PauliString (index 0 = LSB = last character). */
export function parsePauli(s: string, n: number): PauliString {
  const chars = s.replace(/\s/g, '').toUpperCase().split('');
  const out: PauliString = Array(n).fill('I');
  for (let i = 0; i < chars.length && i < n; i++) {
    const ch = chars[chars.length - 1 - i];
    if (ch === 'X' || ch === 'Y' || ch === 'Z' || ch === 'I') out[i] = ch;
  }
  return out;
}

// ───────────────────────────── single-qubit measurement bases ─────────────────────────────

// To MEASURE qubit q in the eigenbasis of Pauli P we rotate by R_P so the +1 eigenstate maps
// to |0⟩ and the −1 eigenstate to |1⟩, then read Z. R_X = H, R_Y = H·S†, R_Z = I.
// Equivalently, given the recorded outcome bit b, the post-measurement eigenstate is
// |s⟩ = R_P†|b⟩ — exactly the column of R_P† used by the snapshot σ̂ = 3|s⟩⟨s| − I.

/** Apply the basis-change R_P to qubit q on `state` (mutates), so a Z-measurement reads P. */
function rotateToMeasure(state: QuantumState, q: number, basis: number): void {
  if (basis === 0) {
    state.applyGate({ name: 'H', qubits: [q] }); // X: H
  } else if (basis === 1) {
    state.applyGate({ name: 'Sdg', qubits: [q] }); // Y: H·S†
    state.applyGate({ name: 'H', qubits: [q] });
  }
  // basis === 2 (Z): identity
}

/** The six single-qubit snapshot operators σ̂ = 3|s⟩⟨s| − I, indexed by [basis][bit]. */
function singleSnapshotOps(): Matrix[][] {
  // |s⟩ eigenstates: X:{|+⟩,|−⟩}, Y:{|+i⟩,|−i⟩}, Z:{|0⟩,|1⟩}.
  const r2 = 1 / Math.SQRT2;
  const kets: Complex[][][] = [
    [[C(r2), C(r2)], [C(r2), C(-r2)]], // X: |+⟩, |−⟩
    [[C(r2), C(0, r2)], [C(r2), C(0, -r2)]], // Y: |+i⟩, |−i⟩
    [[C(1), C(0)], [C(0), C(1)]], // Z: |0⟩, |1⟩
  ];
  const ops: Matrix[][] = [];
  for (let basis = 0; basis < 3; basis++) {
    ops[basis] = [];
    for (let bit = 0; bit < 2; bit++) {
      const s = kets[basis][bit];
      // 3|s⟩⟨s| − I
      const m: Matrix = [
        [s[0].mul(s[0].conj()).scale(3).sub(C(1)), s[0].mul(s[1].conj()).scale(3)],
        [s[1].mul(s[0].conj()).scale(3), s[1].mul(s[1].conj()).scale(3).sub(C(1))],
      ];
      ops[basis][bit] = m;
    }
  }
  return ops;
}

const SNAP_OPS = singleSnapshotOps();

// ───────────────────────────── Born sampling ─────────────────────────────

/** Sample one computational-basis outcome index from amplitudes using `rng`. */
function sampleOutcome(amps: Complex[], rng: () => number): number {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < amps.length; i++) {
    acc += amps[i].abs2();
    if (r < acc) return i;
  }
  return amps.length - 1;
}

// ───────────────────────────── Pauli (local) shadows ─────────────────────────────

/** One random-Pauli snapshot: the measured basis per qubit and the recorded outcome bit. */
export interface PauliSnapshot {
  bases: Uint8Array; // 0=X, 1=Y, 2=Z, per qubit
  bits: Uint8Array; // 0/1 outcome per qubit
}

/** Collect M random-Pauli snapshots of `state` (clones internally; never mutates input). */
export function collectPauliShadows(state: QuantumState, M: number, rng: () => number): PauliSnapshot[] {
  const n = state.numQubits;
  const snaps: PauliSnapshot[] = [];
  for (let m = 0; m < M; m++) {
    const bases = new Uint8Array(n);
    const rot = state.clone();
    for (let q = 0; q < n; q++) {
      const basis = Math.min(2, Math.floor(rng() * 3));
      bases[q] = basis;
      rotateToMeasure(rot, q, basis);
    }
    const outcome = sampleOutcome(rot.amplitudes, rng);
    const bits = new Uint8Array(n);
    for (let q = 0; q < n; q++) bits[q] = (outcome >> q) & 1;
    snaps.push({ bases, bits });
  }
  return snaps;
}

/**
 * Single-snapshot unbiased estimate of a Pauli string Q.
 *   tr(Q ρ̂) = ∏_q tr(Q_q σ̂_q).  Identity qubits contribute 1; a non-identity Q_q contributes
 *   3·(±1) when the measured basis matches Q_q, and 0 otherwise (a basis miss).
 */
export function pauliSnapshotEstimate(snap: PauliSnapshot, Q: PauliString): number {
  let prod = 1;
  for (let q = 0; q < Q.length; q++) {
    const pq = Q[q];
    if (pq === 'I') continue;
    if (snap.bases[q] !== PAULI_TO_BASIS[pq]) return 0; // basis miss → zero contribution
    prod *= snap.bits[q] === 0 ? 3 : -3;
  }
  return prod;
}

/** Plain mean estimate of ⟨Q⟩ over all snapshots. */
export function estimatePauli(snaps: PauliSnapshot[], Q: PauliString): number {
  if (!snaps.length) return 0;
  let s = 0;
  for (const snap of snaps) s += pauliSnapshotEstimate(snap, Q);
  return s / snaps.length;
}

export interface MoMEstimate {
  mean: number; // plain sample mean
  median: number; // median-of-means point estimate (robust)
  stderr: number; // standard error of the group means (a confidence proxy)
}

/**
 * MEDIAN OF MEANS — the robust aggregator the classical-shadows guarantee is built on.
 * Split the snapshots into K equal groups, average each, then take the median of the K means.
 * This converts the (possibly heavy-tailed) single-shot variance into an exponentially-good
 * confidence interval: K = O(log(1/δ)) groups suffice for failure probability δ.
 */
export function medianOfMeans(values: number[], K: number): MoMEstimate {
  const N = values.length;
  if (N === 0) return { mean: 0, median: 0, stderr: 0 };
  const groups = Math.max(1, Math.min(K, N));
  const size = Math.floor(N / groups);
  const means: number[] = [];
  let total = 0;
  for (let g = 0; g < groups; g++) {
    let s = 0;
    for (let i = 0; i < size; i++) s += values[g * size + i];
    means.push(s / size);
    total += s;
  }
  const mean = total / (groups * size);
  const sorted = means.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  // Standard error of the group means about their mean.
  let varSum = 0;
  for (const mu of means) varSum += (mu - mean) * (mu - mean);
  const stderr = means.length > 1 ? Math.sqrt(varSum / (means.length * (means.length - 1))) : 0;
  return { mean, median, stderr };
}

export interface ObservableEstimate {
  label: string;
  weight: number;
  estimate: number; // median-of-means point estimate
  mean: number;
  stderr: number;
  exact: number;
  error: number; // |estimate − exact|
}

/**
 * Estimate MANY Pauli observables from one shadow dataset — the headline of the method.
 * One pass over the snapshots fills every observable's single-shot values; each is then
 * aggregated by median-of-means and compared to the exact value from the state vector.
 */
export function estimateObservables(
  state: QuantumState,
  snaps: PauliSnapshot[],
  observables: PauliString[],
  K = 8,
): ObservableEstimate[] {
  return observables.map((Q) => {
    const values = snaps.map((s) => pauliSnapshotEstimate(s, Q));
    const mom = medianOfMeans(values, K);
    const exact = exactPauli(state, Q);
    return {
      label: pauliLabel(Q),
      weight: pauliWeight(Q),
      estimate: mom.median,
      mean: mom.mean,
      stderr: mom.stderr,
      exact,
      error: Math.abs(mom.median - exact),
    };
  });
}

// ───────────────────────────── purity / Rényi-2 from Pauli shadows ─────────────────────────────

// The per-qubit overlap factor tr(σ̂ᵢ σ̂ⱼ) = 9|⟨sᵢ|sⱼ⟩|² − 4 between two snapshots:
//   same basis & same bit → 5,   same basis & different bit → −4,   different basis → 0.5.
function pairFactor(a: PauliSnapshot, b: PauliSnapshot, qubits: number[]): number {
  let prod = 1;
  for (const q of qubits) {
    if (a.bases[q] === b.bases[q]) prod *= a.bits[q] === b.bits[q] ? 5 : -4;
    else prod *= 0.5;
  }
  return prod;
}

/**
 * Unbiased purity Tr(ρ_A²) over the subsystem `qubits` (default: all), as a U-statistic over
 * distinct snapshot pairs. Because snapshots are independent, E[tr(ρ̂ᵢρ̂ⱼ)] = tr(E[ρ̂]²) = Tr ρ².
 * For large datasets the O(M²) pair sum is subsampled to `maxPairs` random pairs.
 */
export function estimatePurity(
  snaps: PauliSnapshot[],
  qubits?: number[],
  rng?: () => number,
  maxPairs = 200000,
): number {
  const M = snaps.length;
  if (M < 2) return 0;
  const qs = qubits ?? Array.from({ length: snaps[0].bases.length }, (_, i) => i);
  const totalPairs = (M * (M - 1)) / 2;
  if (totalPairs <= maxPairs || !rng) {
    let sum = 0;
    for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) sum += pairFactor(snaps[i], snaps[j], qs);
    return sum / totalPairs;
  }
  // Subsample distinct pairs.
  let sum = 0;
  let count = 0;
  while (count < maxPairs) {
    const i = Math.min(M - 1, Math.floor(rng() * M));
    let j = Math.min(M - 1, Math.floor(rng() * M));
    if (i === j) j = (j + 1) % M;
    sum += pairFactor(snaps[i], snaps[j], qs);
    count++;
  }
  return sum / count;
}

/** 2-Rényi entanglement entropy S₂(A) = −log₂ Tr(ρ_A²) of subsystem `qubits`, from shadows. */
export function estimateRenyi2(snaps: PauliSnapshot[], qubits: number[], rng?: () => number): number {
  const p = estimatePurity(snaps, qubits, rng);
  return p > 0 ? -Math.log2(p) : Infinity;
}

// ───────────────────────────── fidelity with a pure target ─────────────────────────────

/**
 * Pauli decomposition of a pure state's density matrix: |φ⟩⟨φ| = Σ_P (⟨φ|P|φ⟩ / 2ⁿ) P.
 * Returns the non-negligible terms, used to estimate fidelity F = ⟨φ|ρ|φ⟩ = Σ_P coeff_P ⟨P⟩_ρ.
 */
export function pauliDecomposePure(target: QuantumState, tol = 1e-9): { pauli: PauliString; coeff: number }[] {
  const n = target.numQubits;
  const dim = 1 << n;
  const terms: { pauli: PauliString; coeff: number }[] = [];
  const letters: Pauli[] = ['I', 'X', 'Y', 'Z'];
  const total = 4 ** n;
  for (let code = 0; code < total; code++) {
    const p: PauliString = Array(n).fill('I');
    let c = code;
    for (let q = 0; q < n; q++) {
      p[q] = letters[c & 3];
      c >>= 2;
    }
    const coeff = exactPauli(target, p) / dim;
    if (Math.abs(coeff) > tol) terms.push({ pauli: p, coeff });
  }
  return terms;
}

/** Estimate fidelity F = ⟨φ|ρ|φ⟩ from a Pauli shadow of ρ, via the target's Pauli expansion. */
export function estimateFidelity(
  snaps: PauliSnapshot[],
  target: QuantumState,
  terms?: { pauli: PauliString; coeff: number }[],
): number {
  const decomp = terms ?? pauliDecomposePure(target);
  let f = 0;
  for (const { pauli, coeff } of decomp) f += coeff * estimatePauli(snaps, pauli);
  return f;
}

// ───────────────────────────── exact references (from the state vector) ─────────────────────────────

/** Exact ⟨ψ|Q|ψ⟩ for a Pauli string Q, computed directly on the amplitudes. */
export function exactPauli(state: QuantumState, Q: PauliString): number {
  const n = state.numQubits;
  const amps = state.amplitudes;
  const dim = 1 << n;
  // Q|j⟩ flips the qubits where Q has X/Y, and applies phases for Y (±i) and Z (−1 on |1⟩).
  let acc = C(0);
  let flip = 0;
  for (let q = 0; q < n; q++) if (Q[q] === 'X' || Q[q] === 'Y') flip |= 1 << q;
  for (let j = 0; j < dim; j++) {
    const aj = amps[j];
    if (aj.re === 0 && aj.im === 0) continue;
    const i = j ^ flip; // row index of the single nonzero entry of column j
    // phase of Q|j⟩ in row i
    let ph = C(1);
    for (let q = 0; q < n; q++) {
      const bit = (j >> q) & 1;
      if (Q[q] === 'Z') {
        if (bit) ph = ph.neg();
      } else if (Q[q] === 'Y') {
        // Y|0⟩ = i|1⟩, Y|1⟩ = −i|0⟩
        ph = ph.mul(bit ? C(0, -1) : C(0, 1));
      }
      // X: no phase, Y phase handled, I/Z handled
    }
    acc = acc.add(amps[i].conj().mul(ph).mul(aj));
  }
  return acc.re;
}

/** Exact subsystem purity Tr(ρ_A²) for the reduced state on `qubits` of a pure |ψ⟩. */
export function exactReducedPurity(state: QuantumState, qubits: number[]): number {
  const n = state.numQubits;
  const amps = state.amplitudes;
  const Aset = new Set(qubits);
  const aBits: number[] = [];
  const bBits: number[] = [];
  for (let q = 0; q < n; q++) (Aset.has(q) ? aBits : bBits).push(q);
  const dA = 1 << aBits.length;
  const dB = 1 << bBits.length;
  // Reshape amplitudes into ψ[a][b]; ρ_A[a][a'] = Σ_b ψ[a][b] ψ*[a'][b].
  const idxOf = (a: number, b: number): number => {
    let idx = 0;
    for (let k = 0; k < aBits.length; k++) if ((a >> k) & 1) idx |= 1 << aBits[k];
    for (let k = 0; k < bBits.length; k++) if ((b >> k) & 1) idx |= 1 << bBits[k];
    return idx;
  };
  const rho: Complex[][] = Array.from({ length: dA }, () => Array.from({ length: dA }, () => C(0)));
  for (let a = 0; a < dA; a++) {
    for (let ap = 0; ap < dA; ap++) {
      let acc = C(0);
      for (let b = 0; b < dB; b++) acc = acc.add(amps[idxOf(a, b)].mul(amps[idxOf(ap, b)].conj()));
      rho[a][ap] = acc;
    }
  }
  // Tr(ρ²) = Σ_{a,a'} |ρ[a][a']|².
  let p = 0;
  for (let a = 0; a < dA; a++) for (let ap = 0; ap < dA; ap++) p += rho[a][ap].abs2();
  return p;
}

// ───────────────────────────── exact unbiasedness (deterministic proofs) ─────────────────────────────

/**
 * The EXACT expected snapshot E[ρ̂] over the *entire* random-Pauli ensemble (all 3ⁿ bases,
 * each outcome weighted by its Born probability) — no sampling. The classical-shadows promise
 * is E[ρ̂] = ρ, which the self-tests confirm to machine precision by comparing this to |ψ⟩⟨ψ|.
 */
export function pauliChannelExpectation(state: QuantumState): Matrix {
  const n = state.numQubits;
  const dim = 1 << n;
  const out: Matrix = Array.from({ length: dim }, () => Array.from({ length: dim }, () => C(0)));
  const basis = new Array<number>(n).fill(0);
  const total = 3 ** n;
  for (let t = 0; t < total; t++) {
    // decode basis assignment
    let c = t;
    for (let q = 0; q < n; q++) {
      basis[q] = c % 3;
      c = Math.floor(c / 3);
    }
    const rot = state.clone();
    for (let q = 0; q < n; q++) rotateToMeasure(rot, q, basis[q]);
    const probs = rot.amplitudes.map((a) => a.abs2());
    for (let outcome = 0; outcome < dim; outcome++) {
      const p = probs[outcome];
      if (p < 1e-15) continue;
      // ⊗_q σ̂_q(basis_q, bit_q), scaled by p / 3ⁿ, added into out.
      addKronScaled(out, basis, outcome, n, p / total);
    }
  }
  return out;
}

/** out += scale · ⊗_q SNAP_OPS[basis_q][bit_q(outcome)]. */
function addKronScaled(out: Matrix, basis: number[], outcome: number, n: number, scale: number): void {
  const dim = 1 << n;
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      let v = C(scale);
      for (let q = 0; q < n; q++) {
        const bit = (outcome >> q) & 1;
        const op = SNAP_OPS[basis[q]][bit];
        v = v.mul(op[(i >> q) & 1][(j >> q) & 1]);
      }
      out[i][j] = out[i][j].add(v);
    }
  }
}

/** Exact expectation of the single-shot Pauli estimator (should equal ⟨Q⟩) over the ensemble. */
export function pauliEstimatorExpectation(state: QuantumState, Q: PauliString): number {
  const n = state.numQubits;
  const dim = 1 << n;
  const basis = new Array<number>(n).fill(0);
  const total = 3 ** n;
  let acc = 0;
  for (let t = 0; t < total; t++) {
    let c = t;
    for (let q = 0; q < n; q++) {
      basis[q] = c % 3;
      c = Math.floor(c / 3);
    }
    const rot = state.clone();
    for (let q = 0; q < n; q++) rotateToMeasure(rot, q, basis[q]);
    const probs = rot.amplitudes.map((a) => a.abs2());
    for (let outcome = 0; outcome < dim; outcome++) {
      const p = probs[outcome];
      if (p < 1e-15) continue;
      const bits = new Uint8Array(n);
      for (let q = 0; q < n; q++) bits[q] = (outcome >> q) & 1;
      const est = pauliSnapshotEstimate({ bases: Uint8Array.from(basis), bits }, Q);
      acc += (p / total) * est;
    }
  }
  return acc;
}

/**
 * Exact second moment E[X²] of the single-shot Pauli estimator. For a weight-k Pauli this is
 * exactly 3ᵏ — the shadow-norm bound that fixes the sample complexity. Verified to machine
 * precision and independent of the state.
 */
export function pauliEstimatorSecondMoment(state: QuantumState, Q: PauliString): number {
  const n = state.numQubits;
  const dim = 1 << n;
  const basis = new Array<number>(n).fill(0);
  const total = 3 ** n;
  let acc = 0;
  for (let t = 0; t < total; t++) {
    let c = t;
    for (let q = 0; q < n; q++) {
      basis[q] = c % 3;
      c = Math.floor(c / 3);
    }
    const rot = state.clone();
    for (let q = 0; q < n; q++) rotateToMeasure(rot, q, basis[q]);
    const probs = rot.amplitudes.map((a) => a.abs2());
    for (let outcome = 0; outcome < dim; outcome++) {
      const p = probs[outcome];
      if (p < 1e-15) continue;
      const bits = new Uint8Array(n);
      for (let q = 0; q < n; q++) bits[q] = (outcome >> q) & 1;
      const est = pauliSnapshotEstimate({ bases: Uint8Array.from(basis), bits }, Q);
      acc += (p / total) * est * est;
    }
  }
  return acc;
}

// ───────────────────────────── global Clifford shadows (n ≤ 2) ─────────────────────────────

// Generate the n-qubit Clifford group as a list of 2ⁿ×2ⁿ unitaries (mod global phase). For
// shadows only the action U(·)U† matters, so quotienting by the centre (global phases) gives an
// exactly uniform Clifford twirl. n=1 → 24 elements, n=2 → 11520 (both exact 3-designs).

function embedSingle(g: Matrix, q: number, n: number): Matrix {
  const dim = 1 << n;
  const m: Matrix = Array.from({ length: dim }, () => Array.from({ length: dim }, () => C(0)));
  for (let i = 0; i < dim; i++) {
    for (let jb = 0; jb < 2; jb++) {
      const j = (i & ~(1 << q)) | (jb << q);
      m[i][j] = g[(i >> q) & 1][jb];
    }
  }
  return m;
}

function embedCNOT(control: number, target: number, n: number): Matrix {
  const dim = 1 << n;
  const m: Matrix = Array.from({ length: dim }, () => Array.from({ length: dim }, () => C(0)));
  for (let i = 0; i < dim; i++) {
    const out = (i >> control) & 1 ? i ^ (1 << target) : i;
    m[out][i] = C(1);
  }
  return m;
}

function matMul2n(a: Matrix, b: Matrix): Matrix {
  const dim = a.length;
  const out: Matrix = Array.from({ length: dim }, () => Array.from({ length: dim }, () => C(0)));
  for (let i = 0; i < dim; i++) {
    for (let k = 0; k < dim; k++) {
      const aik = a[i][k];
      if (aik.re === 0 && aik.im === 0) continue;
      for (let j = 0; j < dim; j++) out[i][j] = out[i][j].add(aik.mul(b[k][j]));
    }
  }
  return out;
}

/** Canonical key of a unitary modulo global phase (rotate first significant entry to real+). */
function phaseKey(m: Matrix): string {
  let pivot = C(1);
  outer: for (let i = 0; i < m.length; i++)
    for (let j = 0; j < m.length; j++)
      if (m[i][j].abs() > 1e-6) {
        pivot = m[i][j];
        break outer;
      }
  const ph = pivot.scale(1 / pivot.abs());
  return m
    .flat()
    .map((z) => {
      const w = z.div(ph);
      return `${w.re.toFixed(3)},${w.im.toFixed(3)}`;
    })
    .join('|');
}

const cliffordCache = new Map<number, Matrix[]>();

/** The full n-qubit Clifford group (mod phase) as unitary matrices; memoized. n ∈ {1, 2}. */
export function cliffordGroup(n: number): Matrix[] {
  if (n < 1 || n > 2) throw new Error('global Clifford shadows are enumerated for n ≤ 2');
  const cached = cliffordCache.get(n);
  if (cached) return cached;

  if (n === 1) {
    const group = singleQubitCliffords().map((c) => c.mat);
    cliffordCache.set(1, group);
    return group;
  }

  // n === 2: BFS over generators {H, S on each wire, CNOT both directions}.
  const gens: Matrix[] = [
    embedSingle(GATE_H, 0, 2),
    embedSingle(GATE_H, 1, 2),
    embedSingle(GATE_S, 0, 2),
    embedSingle(GATE_S, 1, 2),
    embedCNOT(0, 1, 2),
    embedCNOT(1, 0, 2),
  ];
  const I: Matrix = [
    [C(1), C(0), C(0), C(0)],
    [C(0), C(1), C(0), C(0)],
    [C(0), C(0), C(1), C(0)],
    [C(0), C(0), C(0), C(1)],
  ];
  const seen = new Map<string, Matrix>();
  seen.set(phaseKey(I), I);
  const queue: Matrix[] = [I];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const g of gens) {
      const m = matMul2n(g, cur);
      const k = phaseKey(m);
      if (!seen.has(k)) {
        seen.set(k, m);
        queue.push(m);
      }
    }
  }
  const group = [...seen.values()];
  cliffordCache.set(2, group);
  return group;
}

/** A global-Clifford snapshot stores |s⟩ = U†|b⟩ — the back-rotated computational basis state. */
export interface CliffordSnapshot {
  s: Complex[]; // length 2ⁿ
}

/** Collect M global-Clifford snapshots of `state` (n ≤ 2). */
export function collectCliffordShadows(state: QuantumState, M: number, rng: () => number): CliffordSnapshot[] {
  const n = state.numQubits;
  const group = cliffordGroup(n);
  const dim = 1 << n;
  const snaps: CliffordSnapshot[] = [];
  for (let m = 0; m < M; m++) {
    const U = group[Math.min(group.length - 1, Math.floor(rng() * group.length))];
    const v = matVecMul(U, state.amplitudes); // U|ψ⟩
    const b = sampleOutcome(v, rng);
    // |s⟩ = U†|b⟩ = conj of the b-th row of U.
    const s: Complex[] = new Array(dim);
    for (let k = 0; k < dim; k++) s[k] = U[b][k].conj();
    snaps.push({ s });
  }
  return snaps;
}

function innerAbs2(a: Complex[], b: Complex[]): number {
  // |⟨a|b⟩|²
  let re = 0;
  let im = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i].conj();
    re += ai.re * b[i].re - ai.im * b[i].im;
    im += ai.re * b[i].im + ai.im * b[i].re;
  }
  return re * re + im * im;
}

/** Estimate fidelity F = ⟨φ|ρ|φ⟩ from a global-Clifford shadow: (2ⁿ+1)|⟨φ|s⟩|² − 1, averaged. */
export function estimateCliffordFidelity(snaps: CliffordSnapshot[], target: QuantumState): number {
  if (!snaps.length) return 0;
  const dim = 1 << target.numQubits;
  let acc = 0;
  for (const snap of snaps) acc += (dim + 1) * innerAbs2(target.amplitudes, snap.s) - 1;
  return acc / snaps.length;
}

/**
 * Unbiased purity Tr(ρ²) from a global-Clifford shadow:
 *   tr(ρ̂ᵢ ρ̂ⱼ) = (2ⁿ+1)²|⟨sᵢ|sⱼ⟩|² − (2ⁿ+2),  averaged over distinct pairs.
 */
export function estimateCliffordPurity(snaps: CliffordSnapshot[], dim: number, rng?: () => number, maxPairs = 200000): number {
  const M = snaps.length;
  if (M < 2) return 0;
  const a = (dim + 1) * (dim + 1);
  const c = dim + 2;
  const totalPairs = (M * (M - 1)) / 2;
  if (totalPairs <= maxPairs || !rng) {
    let sum = 0;
    for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) sum += a * innerAbs2(snaps[i].s, snaps[j].s) - c;
    return sum / totalPairs;
  }
  let sum = 0;
  let count = 0;
  while (count < maxPairs) {
    const i = Math.min(M - 1, Math.floor(rng() * M));
    let j = Math.min(M - 1, Math.floor(rng() * M));
    if (i === j) j = (j + 1) % M;
    sum += a * innerAbs2(snaps[i].s, snaps[j].s) - c;
    count++;
  }
  return sum / count;
}

/**
 * The EXACT expected global-Clifford snapshot E[(2ⁿ+1)|s⟩⟨s| − I] over the whole enumerated
 * group and all Born outcomes. The self-tests confirm this equals ρ to machine precision.
 */
export function cliffordChannelExpectation(state: QuantumState): Matrix {
  const n = state.numQubits;
  const dim = 1 << n;
  const group = cliffordGroup(n);
  const out: Matrix = Array.from({ length: dim }, () => Array.from({ length: dim }, () => C(0)));
  const scale = 1 / group.length;
  for (const U of group) {
    const v = matVecMul(U, state.amplitudes);
    for (let b = 0; b < dim; b++) {
      const p = v[b].abs2();
      if (p < 1e-15) continue;
      // |s⟩ = conj(row b of U); add scale·p·((dim+1)|s⟩⟨s| − I)
      const s: Complex[] = new Array(dim);
      for (let k = 0; k < dim; k++) s[k] = U[b][k].conj();
      for (let i = 0; i < dim; i++) {
        for (let j = 0; j < dim; j++) {
          const term = s[i].mul(s[j].conj()).scale((dim + 1) * scale * p);
          out[i][j] = out[i][j].add(term);
          if (i === j) out[i][j] = out[i][j].sub(C(scale * p));
        }
      }
    }
  }
  return out;
}
