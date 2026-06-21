// The Solovay–Kitaev algorithm — compiling an arbitrary single-qubit gate into a
// finite, fault-tolerant instruction set ({H, T} + Clifford), from scratch.
//
// The rest of the lab can run *any* unitary, but a real fault-tolerant machine only
// has a discrete set of gates it can apply transversally and cheaply — the Clifford
// group plus the T = diag(1, e^{iπ/4}) gate. Solovay–Kitaev is the bridge: given any
// target U ∈ SU(2) and a precision ε, it produces a *word* over {H, T, T†, S, S†, X,
// Y, Z} whose product approximates U to within ε, using only O(log^c (1/ε)) gates.
//
// The algorithm is a beautiful recursion. A precomputed "ε₀-net" of short words gives a
// crude base approximation. To do better, approximate U at depth n−1, look at the
// leftover error Δ = U·U_{n−1}† (a small rotation near the identity), write Δ as a
// BALANCED GROUP COMMUTATOR Δ = V W V† W† with V, W *also* near the identity, and
// recursively approximate V and W at depth n−1. Because the group-commutator
// construction halves the "distance from identity" of its factors, the error contracts
// super-linearly: ε_n ≈ c·ε_{n−1}^{3/2}, so a handful of levels reaches machine-tiny ε.
//
// SU(2) is represented compactly as a pair (a, b) of complex numbers standing for the
// matrix [[a, b], [−b̄, ā]] (|a|² + |b|² = 1). Products stay in this form, axis–angle
// extraction is closed-form, and the Dawson–Nielsen group-commutator decomposition uses
// only rotations — no eigensolver. Everything is self-contained (no engine imports) and
// cross-checked: every compiled word, multiplied back out in genuine U(2), reproduces the
// target up to a physically-irrelevant global phase, and the error/length scaling laws
// are verified against the Solovay–Kitaev theorem.

import { Complex } from './Complex';

// ───────────────────────────── SU(2) as (a, b) ─────────────────────────────
// Matrix is [[a, b], [−conj(b), conj(a)]] with |a|² + |b|² = 1.

export interface SU2 { a: Complex; b: Complex; }

export const SU2_ID: SU2 = { a: new Complex(1, 0), b: new Complex(0, 0) };

/** Product U·V (stays in SU(2)). */
export function su2Mul(U: SU2, V: SU2): SU2 {
  // top-left  = a·c − b·conj(d);  top-right = a·d + b·conj(c)
  return {
    a: U.a.mul(V.a).sub(U.b.mul(V.b.conj())),
    b: U.a.mul(V.b).add(U.b.mul(V.a.conj())),
  };
}

/** Hermitian conjugate (inverse, since unitary). */
export function su2Dag(U: SU2): SU2 {
  return { a: U.a.conj(), b: U.b.neg() };
}

export function su2Neg(U: SU2): SU2 {
  return { a: U.a.neg(), b: U.b.neg() };
}

/** Rotation by angle ψ about a unit axis û, as an SU(2) element exp(−i ψ/2 û·σ). */
export function su2Rot(axis: [number, number, number], psi: number): SU2 {
  const c = Math.cos(psi / 2), s = Math.sin(psi / 2);
  const [ux, uy, uz] = axis;
  return { a: new Complex(c, -s * uz), b: new Complex(-s * uy, -s * ux) };
}

/**
 * Axis–angle of an SU(2) element. Writes U = cos(θ/2) I − i sin(θ/2)(n̂·σ); returns the
 * rotation angle θ ∈ [0, 2π] and the unit axis n̂ (arbitrary when U ≈ ±I).
 */
export function su2AxisAngle(U: SU2): { theta: number; axis: [number, number, number] } {
  const c = Math.max(-1, Math.min(1, U.a.re));
  const half = Math.acos(c);          // θ/2 ∈ [0, π]
  const s = Math.sin(half);
  let axis: [number, number, number];
  if (s < 1e-12) axis = [0, 0, 1];
  else axis = [-U.b.im / s, -U.b.re / s, -U.a.im / s];
  return { theta: 2 * half, axis };
}

/** Operator-norm (largest singular value) distance ‖U − V‖₂ between two SU(2) elements. */
export function su2Dist(U: SU2, V: SU2): number {
  // M = U − V as a full 2×2; spectral norm = √(largest eigenvalue of M†M).
  const m00 = U.a.sub(V.a);
  const m01 = U.b.sub(V.b);
  const m10 = V.b.conj().sub(U.b.conj());        // −conj(b_U) − (−conj(b_V))
  const m11 = U.a.conj().sub(V.a.conj());
  const p = m00.abs2() + m10.abs2();
  const sN = m01.abs2() + m11.abs2();
  // q = conj(m00)·m01 + conj(m10)·m11
  const q = m00.conj().mul(m01).add(m10.conj().mul(m11));
  const tr = (p + sN) / 2;
  const d = Math.sqrt(Math.max(0, ((p - sN) / 2) ** 2 + q.abs2()));
  return Math.sqrt(Math.max(0, tr + d));
}

// ───────────────────────────── the instruction set ─────────────────────────────

export type Gate = 'H' | 'T' | 'Ti' | 'S' | 'Si' | 'X' | 'Y' | 'Z';
export const GATES: Gate[] = ['H', 'T', 'Ti', 'S', 'Si', 'X', 'Y', 'Z'];

const SQ = 1 / Math.sqrt(2);

/** SU(2) lifts (det = 1) of the discrete gate set. H is lifted as H/i = −iH. */
export const GATE_SU2: Record<Gate, SU2> = {
  H: { a: new Complex(0, -SQ), b: new Complex(0, -SQ) },
  T: su2Rot([0, 0, 1], Math.PI / 4),
  Ti: su2Rot([0, 0, 1], -Math.PI / 4),
  S: su2Rot([0, 0, 1], Math.PI / 2),
  Si: su2Rot([0, 0, 1], -Math.PI / 2),
  X: su2Rot([1, 0, 0], Math.PI),
  Y: su2Rot([0, 1, 0], Math.PI),
  Z: su2Rot([0, 0, 1], Math.PI),
};

const GATE_INV: Record<Gate, Gate> = {
  H: 'H', T: 'Ti', Ti: 'T', S: 'Si', Si: 'S', X: 'X', Y: 'Y', Z: 'Z',
};
export const gateInverse = (g: Gate): Gate => GATE_INV[g];

/** The genuine U(2) matrices (not SU(2) lifts) — for an honest reconstruction check. */
export function gateU2(g: Gate): Complex[][] {
  const c0 = new Complex(0, 0), c1 = new Complex(1, 0);
  switch (g) {
    case 'H': return [[new Complex(SQ, 0), new Complex(SQ, 0)], [new Complex(SQ, 0), new Complex(-SQ, 0)]];
    case 'T': return [[c1, c0], [c0, Complex.fromPolar(1, Math.PI / 4)]];
    case 'Ti': return [[c1, c0], [c0, Complex.fromPolar(1, -Math.PI / 4)]];
    case 'S': return [[c1, c0], [c0, new Complex(0, 1)]];
    case 'Si': return [[c1, c0], [c0, new Complex(0, -1)]];
    case 'X': return [[c0, c1], [c1, c0]];
    case 'Y': return [[c0, new Complex(0, -1)], [new Complex(0, 1), c0]];
    case 'Z': return [[c1, c0], [c0, new Complex(-1, 0)]];
  }
}

/** Multiply a gate word out into a genuine U(2) matrix (left-to-right application order). */
export function sequenceToU2(seq: Gate[]): Complex[][] {
  let M: Complex[][] = [[new Complex(1, 0), new Complex(0, 0)], [new Complex(0, 0), new Complex(1, 0)]];
  for (const g of seq) {
    const G = gateU2(g);
    // M ← G·M
    const r: Complex[][] = [[new Complex(0, 0), new Complex(0, 0)], [new Complex(0, 0), new Complex(0, 0)]];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++)
      r[i][j] = G[i][0].mul(M[0][j]).add(G[i][1].mul(M[1][j]));
    M = r;
  }
  return M;
}

/** The genuine SU(2) element realised by a gate word (product of the SU(2) lifts). */
export function sequenceToSU2(seq: Gate[]): SU2 {
  let U = SU2_ID;
  for (const g of seq) U = su2Mul(U, GATE_SU2[g]);
  return U;
}

// ───────────────────────── group-commutator decomposition ─────────────────────────
//
// Given Δ ∈ SU(2) (a rotation by θ about n̂), find V, W ∈ SU(2) with Δ = V W V† W†.
// Dawson–Nielsen: take V₀ = Rx(φ), W₀ = Ry(φ) with φ chosen so the commutator has the
// SAME rotation angle θ; then conjugate both by the rotation S taking the commutator's
// axis to n̂. The factors satisfy ‖V₀ − I‖, ‖W₀ − I‖ = O(√‖Δ − I‖) — the contraction.

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

export function gcDecompose(D: SU2): { V: SU2; W: SU2 } {
  const { theta, axis: n } = su2AxisAngle(D);
  // φ such that the Rx(φ),Ry(φ) commutator is a rotation by θ (Dawson–Nielsen).
  const st = Math.sqrt(Math.max(0, (1 - Math.cos(theta / 2)) / 2));
  const phi = 2 * Math.asin(Math.min(1, Math.sqrt(st)));
  const V0 = su2Rot([1, 0, 0], phi);
  const W0 = su2Rot([0, 1, 0], phi);
  const Ccomm = su2Mul(su2Mul(V0, W0), su2Mul(su2Dag(V0), su2Dag(W0)));
  const { axis: m } = su2AxisAngle(Ccomm);
  // S rotates the commutator axis m̂ onto the target axis n̂.
  let S: SU2;
  const cd = Math.max(-1, Math.min(1, dot3(m, n)));
  if (cd > 1 - 1e-12) {
    S = SU2_ID;
  } else if (cd < -1 + 1e-12) {
    let perp = Math.abs(m[0]) < 0.9 ? cross(m, [1, 0, 0]) : cross(m, [0, 1, 0]);
    const nn = norm3(perp); perp = [perp[0] / nn, perp[1] / nn, perp[2] / nn];
    S = su2Rot(perp, Math.PI);
  } else {
    let ax = cross(m, n); const nn = norm3(ax); ax = [ax[0] / nn, ax[1] / nn, ax[2] / nn];
    S = su2Rot(ax, Math.acos(cd));
  }
  return {
    V: su2Mul(su2Mul(S, V0), su2Dag(S)),
    W: su2Mul(su2Mul(S, W0), su2Dag(S)),
  };
}

// ───────────────────────────── the ε₀-net ─────────────────────────────

export interface NetEntry { seq: Gate[]; U: SU2; }

/**
 * Breadth-first enumeration of reduced gate words up to `maxLen`, deduplicated by their
 * SU(2) value (folding the global ± sign, which is the same operator). This is the base
 * "ε₀-net": the finite mesh of short words that seeds the recursion.
 */
export function buildNet(maxLen: number, prec = 2e4): NetEntry[] {
  const net: NetEntry[] = [];
  const seen = new Set<string>();
  const key = (U: SU2): string => {
    let a = U.a, b = U.b;
    if (a.re < 0 || (a.re === 0 && a.im < 0)) { a = a.neg(); b = b.neg(); }   // canonical sign
    const r = (x: number) => Math.round(x * prec);
    return `${r(a.re)},${r(a.im)},${r(b.re)},${r(b.im)}`;
  };
  net.push({ seq: [], U: SU2_ID });
  seen.add(key(SU2_ID));
  let frontier: NetEntry[] = [{ seq: [], U: SU2_ID }];
  for (let len = 1; len <= maxLen; len++) {
    const next: NetEntry[] = [];
    for (const item of frontier) {
      const last = item.seq[item.seq.length - 1];
      for (const g of GATES) {
        // prune obvious cancellations / idempotents so the frontier stays productive
        if ((last === 'T' && g === 'Ti') || (last === 'Ti' && g === 'T')) continue;
        if ((last === 'S' && g === 'Si') || (last === 'Si' && g === 'S')) continue;
        if (last === g && (g === 'H' || g === 'X' || g === 'Y' || g === 'Z')) continue;
        const U = su2Mul(item.U, GATE_SU2[g]);
        const k = key(U);
        if (seen.has(k)) continue;
        seen.add(k);
        const it: NetEntry = { seq: [...item.seq, g], U };
        net.push(it);
        next.push(it);
      }
    }
    frontier = next;
  }
  return net;
}

let CACHED_NET: NetEntry[] | null = null;
let CACHED_LEN = 0;
/** Lazily built, cached base net (default length 16 ≈ 10k words, builds in well under a second). */
export function getNet(maxLen = 16): NetEntry[] {
  if (!CACHED_NET || CACHED_LEN !== maxLen) {
    CACHED_NET = buildNet(maxLen);
    CACHED_LEN = maxLen;
  }
  return CACHED_NET;
}

/** Nearest word in the net to U, by operator-norm distance. */
export function basicApproximation(U: SU2, net: NetEntry[]): NetEntry {
  let best = net[0], bd = Infinity;
  for (const e of net) {
    const d = su2Dist(U, e.U);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// ───────────────────────────── the recursion ─────────────────────────────

/** Solovay–Kitaev recursion to depth `n`. Returns the gate word and the SU(2) it realises. */
export function solovayKitaev(U: SU2, n: number, net: NetEntry[]): { seq: Gate[]; U: SU2 } {
  if (n === 0) {
    const b = basicApproximation(U, net);
    return { seq: b.seq.slice(), U: b.U };
  }
  const prev = solovayKitaev(U, n - 1, net);
  const D = su2Mul(U, su2Dag(prev.U));            // leftover error, near I
  const { V, W } = gcDecompose(D);
  const vn = solovayKitaev(V, n - 1, net);
  const wn = solovayKitaev(W, n - 1, net);
  const vInv = [...vn.seq].reverse().map(gateInverse);
  const wInv = [...wn.seq].reverse().map(gateInverse);
  const seq = [...vn.seq, ...wn.seq, ...vInv, ...wInv, ...prev.seq];
  const Uout = su2Mul(
    su2Mul(su2Mul(su2Mul(vn.U, wn.U), su2Dag(vn.U)), su2Dag(wn.U)),
    prev.U,
  );
  return { seq, U: Uout };
}

// ───────────────────────────── public compile API ─────────────────────────────

export interface SKResult {
  sequence: Gate[];
  reduced: Gate[];
  approx: SU2;
  error: number;       // operator-norm distance to the target
  length: number;      // gate count of the (reduced) word
  tCount: number;      // number of T / T† gates — the costly, non-Clifford resource
}

/** Cancel adjacent inverse pairs and idempotent runs to shorten a word (operator-preserving). */
export function simplifySequence(seq: Gate[]): Gate[] {
  const out: Gate[] = [];
  for (const g of seq) {
    const last = out[out.length - 1];
    if (last !== undefined) {
      if (gateInverse(last) === g) { out.pop(); continue; }      // g·g⁻¹ → ∅
      if (last === g && (g === 'H' || g === 'X' || g === 'Y' || g === 'Z')) { out.pop(); continue; }
    }
    out.push(g);
  }
  return out;
}

/** Compile a target SU(2) gate to the discrete set at recursion depth `depth`. */
export function compileGate(target: SU2, depth: number, maxLen = 16): SKResult {
  const net = getNet(maxLen);
  const raw = solovayKitaev(target, depth, net);
  const reduced = simplifySequence(raw.seq);
  const tCount = reduced.filter((g) => g === 'T' || g === 'Ti').length;
  return {
    sequence: raw.seq,
    reduced,
    approx: raw.U,
    error: su2Dist(target, raw.U),
    length: reduced.length,
    tCount,
  };
}

// ───────────────────────────── named target gates ─────────────────────────────

export const rzTarget = (theta: number): SU2 => su2Rot([0, 0, 1], theta);
export const rxTarget = (theta: number): SU2 => su2Rot([1, 0, 0], theta);
export const ryTarget = (theta: number): SU2 => su2Rot([0, 1, 0], theta);

/** A general SU(2) from ZYZ Euler angles: Rz(α) Ry(β) Rz(γ). */
export function eulerTarget(alpha: number, beta: number, gamma: number): SU2 {
  return su2Mul(su2Mul(rzTarget(alpha), ryTarget(beta)), rzTarget(gamma));
}

/** A reproducible "random" SU(2) from a seed, for the demo gallery. */
export function seededTarget(seed: number): SU2 {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return eulerTarget(rnd() * 2 * Math.PI, Math.acos(2 * rnd() - 1), rnd() * 2 * Math.PI);
}

export interface NamedTarget { id: string; label: string; desc: string; make: () => SU2; }

/** The √NOT gate V = √X — the canonical "irrational" single-qubit gate SK is asked to build. */
const V_GATE: SU2 = su2Rot([1, 0, 0], Math.PI / 2);

export const NAMED_TARGETS: NamedTarget[] = [
  { id: 'rz_pi5', label: 'Rz(π/5)', desc: 'A rotation with no exact {H,T} word — the SK workhorse.', make: () => rzTarget(Math.PI / 5) },
  { id: 'v', label: 'V = √X', desc: 'The √NOT gate, a π/2 rotation about x.', make: () => V_GATE },
  { id: 'rx_1', label: 'Rx(1 rad)', desc: 'An irrational-angle rotation about x.', make: () => rxTarget(1) },
  { id: 'ry_golden', label: 'Ry(2π/φ²)', desc: 'A golden-ratio rotation about y.', make: () => ryTarget((2 * Math.PI) / 2.6180339887) },
  { id: 'hadamardish', label: 'Rn(2π/7)', desc: 'A 2π/7 rotation about the body-diagonal axis (1,1,1)/√3.', make: () => su2Rot([1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], (2 * Math.PI) / 7) },
  { id: 'seed', label: 'Random (seeded)', desc: 'A pseudo-random Haar-ish SU(2) target.', make: () => seededTarget(20260621) },
];
