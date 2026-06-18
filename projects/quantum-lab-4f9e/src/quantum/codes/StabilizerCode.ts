/**
 * General stabilizer codes from scratch — the symplectic (GF(2)) backbone behind the
 * surface code, the Steane/Shor codes and, the star of this module, the *perfect*
 * five-qubit [[5,1,3]] code.
 *
 * A stabilizer code on n physical qubits is fixed by an abelian group S of commuting Pauli
 * operators (its n−k independent generators). The simultaneous +1 eigenspace of S is a
 * 2ᵏ-dimensional code space holding k logical qubits. A Pauli error E is *detected* by which
 * generators it anticommutes with — its **syndrome** — and is *correctable* when distinct
 * low-weight errors give distinct syndromes. Everything here is pure GF(2) symplectic linear
 * algebra: no state vector is needed to decide whether a code corrects an error, which is
 * exactly why code-capacity simulations scale.
 *
 * Each n-qubit Pauli (ignoring its ± phase, which is irrelevant to the code structure) is a
 * 2n-bit symplectic vector: an X-part and a Z-part, with I=00, X=10, Y=11, Z=01 per qubit.
 * Two Paulis commute iff their symplectic product Σ_q (a.x_q·b.z_q ⊕ a.z_q·b.x_q) is 0.
 */

import { mulberry32 } from '../surface/SurfaceCode';

export interface Pauli {
  x: number[]; // length n, 0/1
  z: number[]; // length n, 0/1
}

/** Parse a Pauli string like "XZZXI" into its symplectic (x,z) bit vectors. */
export function parsePauli(s: string): Pauli {
  const x: number[] = [], z: number[] = [];
  for (const ch of s) {
    switch (ch) {
      case 'I': x.push(0); z.push(0); break;
      case 'X': x.push(1); z.push(0); break;
      case 'Y': x.push(1); z.push(1); break;
      case 'Z': x.push(0); z.push(1); break;
      default: throw new Error(`bad Pauli char "${ch}"`);
    }
  }
  return { x, z };
}

/** Render a Pauli as its letter string (no sign). */
export function pauliString(p: Pauli): string {
  let out = '';
  for (let q = 0; q < p.x.length; q++) out += p.x[q] && p.z[q] ? 'Y' : p.x[q] ? 'X' : p.z[q] ? 'Z' : 'I';
  return out;
}

/** Symplectic inner product (0 ⇔ the two Paulis commute, 1 ⇔ they anticommute). */
export function symplectic(a: Pauli, b: Pauli): number {
  let acc = 0;
  for (let q = 0; q < a.x.length; q++) acc ^= (a.x[q] & b.z[q]) ^ (a.z[q] & b.x[q]);
  return acc;
}

/** Pauli product up to phase: the GF(2) sum of two symplectic vectors. */
export function pauliMul(a: Pauli, b: Pauli): Pauli {
  const n = a.x.length;
  const x = new Array(n), z = new Array(n);
  for (let q = 0; q < n; q++) { x[q] = a.x[q] ^ b.x[q]; z[q] = a.z[q] ^ b.z[q]; }
  return { x, z };
}

/** Number of qubits the Pauli acts on non-trivially. */
export function pauliWeight(p: Pauli): number {
  let w = 0;
  for (let q = 0; q < p.x.length; q++) if (p.x[q] || p.z[q]) w++;
  return w;
}

export function identityPauli(n: number): Pauli {
  return { x: new Array(n).fill(0), z: new Array(n).fill(0) };
}

/** Single-qubit Pauli error of a given type on qubit q. */
export function singleError(n: number, q: number, type: 'X' | 'Y' | 'Z'): Pauli {
  const p = identityPauli(n);
  if (type === 'X' || type === 'Y') p.x[q] = 1;
  if (type === 'Z' || type === 'Y') p.z[q] = 1;
  return p;
}

export type Residual = 'I' | 'stabilizer' | 'logical';

export interface CodeValidity {
  stabilizersCommute: boolean;
  stabilizersIndependent: boolean;
  logicalsCommuteWithStabilizers: boolean;
  logicalAlgebra: boolean; // X̄ᵢ anticommutes with Z̄ᵢ only; logicals pairwise commute otherwise
  ok: boolean;
}

/** GF(2) rank of a set of symplectic vectors (each flattened to its 2n bits). */
function gf2Rank(vecs: Pauli[]): number {
  const rows = vecs.map((p) => [...p.x, ...p.z]);
  const m = rows.length;
  if (m === 0) return 0;
  const cols = rows[0].length;
  let rank = 0;
  for (let c = 0; c < cols && rank < m; c++) {
    let piv = -1;
    for (let r = rank; r < m; r++) if (rows[r][c]) { piv = r; break; }
    if (piv < 0) continue;
    [rows[rank], rows[piv]] = [rows[piv], rows[rank]];
    for (let r = 0; r < m; r++) if (r !== rank && rows[r][c]) for (let k = 0; k < cols; k++) rows[r][k] ^= rows[rank][k];
    rank++;
  }
  return rank;
}

export class StabilizerCode {
  readonly name: string;
  readonly n: number;
  readonly k: number;
  readonly stabs: Pauli[];
  readonly logicalX: Pauli[];
  readonly logicalZ: Pauli[];
  private decoder: Map<number, Pauli> | null = null;
  private _distance: number | null = null;

  constructor(
    name: string,
    n: number,
    stabilizers: string[],
    logicalX: string[],
    logicalZ: string[],
  ) {
    this.name = name;
    this.n = n;
    this.stabs = stabilizers.map(parsePauli);
    this.logicalX = logicalX.map(parsePauli);
    this.logicalZ = logicalZ.map(parsePauli);
    this.k = this.logicalX.length;
  }

  get numChecks(): number { return this.stabs.length; }

  /** Syndrome of an error: one bit per generator (1 ⇔ the error anticommutes with it). */
  syndrome(err: Pauli): number[] {
    return this.stabs.map((g) => symplectic(g, err));
  }

  /** Pack a syndrome bit-list into an integer key (≤ n−k bits). */
  syndromeKey(bits: number[]): number {
    let key = 0;
    for (let i = 0; i < bits.length; i++) key |= bits[i] << i;
    return key;
  }

  /** Verify the code is well-formed: commuting independent stabilizers + a valid logical algebra. */
  validity(): CodeValidity {
    let stabilizersCommute = true;
    for (let i = 0; i < this.stabs.length; i++)
      for (let j = i + 1; j < this.stabs.length; j++)
        if (symplectic(this.stabs[i], this.stabs[j])) stabilizersCommute = false;

    const stabilizersIndependent = gf2Rank(this.stabs) === this.stabs.length
      && this.stabs.length === this.n - this.k;

    let logicalsCommuteWithStabilizers = true;
    for (const g of this.stabs)
      for (const l of [...this.logicalX, ...this.logicalZ])
        if (symplectic(g, l)) logicalsCommuteWithStabilizers = false;

    let logicalAlgebra = this.logicalX.length === this.k && this.logicalZ.length === this.k;
    for (let i = 0; i < this.k; i++)
      for (let j = 0; j < this.k; j++) {
        const want = i === j ? 1 : 0; // X̄ᵢ·Z̄ⱼ
        if (symplectic(this.logicalX[i], this.logicalZ[j]) !== want) logicalAlgebra = false;
        if (i < j && (symplectic(this.logicalX[i], this.logicalX[j]) || symplectic(this.logicalZ[i], this.logicalZ[j])))
          logicalAlgebra = false;
      }

    const ok = stabilizersCommute && stabilizersIndependent && logicalsCommuteWithStabilizers && logicalAlgebra;
    return { stabilizersCommute, stabilizersIndependent, logicalsCommuteWithStabilizers, logicalAlgebra, ok };
  }

  /** Classify a residual Pauli: trivial (in the stabilizer group ⇒ success) or a logical error. */
  classify(residual: Pauli): Residual {
    // A residual with non-trivial syndrome is not in N(S) at all (uncorrected detectable error);
    // we still report it via the logical test below since it disturbs the logical state.
    for (const l of [...this.logicalX, ...this.logicalZ]) if (symplectic(l, residual)) return 'logical';
    for (const g of this.stabs) if (symplectic(g, residual)) return 'logical'; // left the codespace
    return pauliWeight(residual) === 0 ? 'I' : 'stabilizer';
  }

  /** Build the min-weight lookup decoder over all errors up to a given weight (default single-qubit). */
  buildDecoder(maxWeight = 1): Map<number, Pauli> {
    if (this.decoder && maxWeight === 1) return this.decoder;
    const table = new Map<number, Pauli>();
    const best = new Map<number, number>(); // syndrome → weight of stored correction
    table.set(0, identityPauli(this.n)); best.set(0, 0);

    const consider = (err: Pauli) => {
      const key = this.syndromeKey(this.syndrome(err));
      const w = pauliWeight(err);
      const cur = best.get(key);
      if (cur === undefined || w < cur) { table.set(key, err); best.set(key, w); }
    };

    // Enumerate every Pauli of weight 1..maxWeight (3 non-trivial single-qubit Paulis per site).
    const types: ('X' | 'Y' | 'Z')[] = ['X', 'Y', 'Z'];
    const rec = (start: number, weight: number, acc: Pauli) => {
      if (weight > 0) consider(acc);
      if (weight === maxWeight) return;
      for (let q = start; q < this.n; q++) for (const t of types) {
        const next = pauliMul(acc, singleError(this.n, q, t));
        rec(q + 1, weight + 1, next);
      }
    };
    rec(0, 0, identityPauli(this.n));

    if (maxWeight === 1) this.decoder = table;
    return table;
  }

  /** Look up the recovery operator for a syndrome (identity if the syndrome is unseen). */
  decode(syndrome: number[]): Pauli {
    const table = this.buildDecoder(1);
    return table.get(this.syndromeKey(syndrome)) ?? identityPauli(this.n);
  }

  /** The exact code distance: the minimum weight of a non-trivial logical operator (an element of
   *  N(S)\S). Brute-forced over all 4ⁿ Paulis — feasible from scratch for n ≤ ~10. */
  distance(): number {
    if (this._distance !== null) return this._distance;
    let best = Infinity;
    const x = new Array(this.n).fill(0), z = new Array(this.n).fill(0);
    const total = 1 << (2 * this.n);
    for (let code = 1; code < total; code++) {
      for (let q = 0; q < this.n; q++) { x[q] = (code >> (2 * q)) & 1; z[q] = (code >> (2 * q + 1)) & 1; }
      const p: Pauli = { x, z };
      // commutes with every stabilizer?
      let inNormalizer = true;
      for (const g of this.stabs) if (symplectic(g, p)) { inNormalizer = false; break; }
      if (!inNormalizer) continue;
      // non-trivial logical ⇔ anticommutes with some logical operator
      let logical = false;
      for (const l of [...this.logicalX, ...this.logicalZ]) if (symplectic(l, p)) { logical = true; break; }
      if (!logical) continue;
      const w = pauliWeight(p);
      if (w < best) best = w;
    }
    this._distance = best === Infinity ? 0 : best;
    return this._distance;
  }

  /** Does the code saturate the quantum Hamming bound (a *perfect* code)? */
  perfect(): boolean {
    const t = Math.floor((this.distance() - 1) / 2);
    let sphere = 0;
    for (let j = 0; j <= t; j++) sphere += binom(this.n, j) * 3 ** j;
    return sphere * 2 ** this.k === 2 ** this.n;
  }

  /** Apply a depolarizing channel of rate p to every qubit, decode, and report whether the logical
   *  state was corrupted. Returns the residual class. */
  depolarizingShot(p: number, rng: () => number): Residual {
    const err = identityPauli(this.n);
    for (let q = 0; q < this.n; q++) {
      const r = rng();
      if (r < p) {
        const t = r < p / 3 ? 'X' : r < (2 * p) / 3 ? 'Y' : 'Z';
        if (t === 'X' || t === 'Y') err.x[q] = 1;
        if (t === 'Z' || t === 'Y') err.z[q] = 1;
      }
    }
    const correction = this.decode(this.syndrome(err));
    return this.classify(pauliMul(err, correction));
  }

  /** Monte-Carlo logical error rate under depolarizing noise of rate p. */
  logicalErrorRate(p: number, shots: number, rng: () => number = mulberry32(0x5eed)): number {
    let fail = 0;
    for (let s = 0; s < shots; s++) if (this.depolarizingShot(p, rng) === 'logical') fail++;
    return fail / shots;
  }
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}
