/**
 * Stabilizer (CHP) tableau simulator — Aaronson & Gottesman, "Improved Simulation of
 * Stabilizer Circuits" (Phys. Rev. A 70, 052328, 2004).
 *
 * A pure stabilizer state on n qubits is the simultaneous +1 eigenstate of n commuting
 * Pauli generators. Tracking those generators (rather than 2ⁿ amplitudes) lets *Clifford*
 * circuits — H, S, the Paulis, CNOT, CZ, SWAP — run in O(n²) time and O(n²) memory, so a
 * 30-qubit GHZ state is instant where the state-vector engine would need 8 GB of amplitudes.
 *
 * Layout: a (2n+1)×(2n+1) tableau of bits. Rows 0..n-1 are *destabilizers*, rows n..2n-1 are
 * *stabilizers*, row 2n is scratch. Each row stores x_j, z_j (j<n) and a sign bit r. A row
 * encodes the Pauli  (-1)^r · ⊗_j P_j  with the per-qubit reading 00→I, 10→X, 11→Y, 01→Z.
 * The update rules below keep that reading globally phase-consistent (e.g. S·X·S†=+Y,
 * S·Y·S†=-X, H·Y·H=-Y), which we exploit to print generators and to cross-check the
 * state-vector engine.
 */

export type CliffordGate = 'H' | 'S' | 'Sdg' | 'X' | 'Y' | 'Z' | 'CNOT' | 'CZ' | 'SWAP';

export type Pauli1 = 'I' | 'X' | 'Y' | 'Z';

/** Normalise a gate name to its Clifford identity, or null if it is non-Clifford. */
export function cliffordName(name: string): CliffordGate | null {
  switch (name) {
    case 'H': return 'H';
    case 'S': return 'S';
    case 'Sdg': return 'Sdg';
    case 'X': return 'X';
    case 'Y': return 'Y';
    case 'Z': return 'Z';
    case 'CNOT': case 'CX': return 'CNOT';
    case 'CZ': return 'CZ';
    case 'SWAP': return 'SWAP';
    default: return null;
  }
}

export function isClifford(name: string): boolean {
  return cliffordName(name) !== null;
}

export interface Generator {
  sign: 1 | -1;
  paulis: Pauli1[]; // length n, paulis[q] is the Pauli on qubit q
}

export class Stabilizer {
  readonly n: number;
  private rows: number; // 2n+1
  private x: Uint8Array; // rows × n
  private z: Uint8Array; // rows × n
  private r: Uint8Array; // rows
  rng: () => number;

  constructor(n: number, rng: () => number = Math.random) {
    this.n = n;
    this.rows = 2 * n + 1;
    this.x = new Uint8Array(this.rows * n);
    this.z = new Uint8Array(this.rows * n);
    this.r = new Uint8Array(this.rows);
    this.rng = rng;
    // |0…0⟩: destabilizer i = X_i, stabilizer i = Z_i.
    for (let i = 0; i < n; i++) {
      this.x[i * n + i] = 1;          // destabilizers
      this.z[(n + i) * n + i] = 1;    // stabilizers
    }
  }

  clone(): Stabilizer {
    const s = new Stabilizer(this.n, this.rng);
    s.x.set(this.x); s.z.set(this.z); s.r.set(this.r);
    return s;
  }

  private idx(row: number, col: number): number { return row * this.n + col; }

  // ---- Clifford gates -----------------------------------------------------

  /** Hadamard: X↔Z, sign picks up x·z. */
  h(q: number): void {
    const { n, x, z, r } = this;
    for (let i = 0; i < this.rows - 1; i++) {
      const a = this.idx(i, q);
      r[i] ^= x[a] & z[a];
      const t = x[a]; x[a] = z[a]; z[a] = t;
    }
    void n;
  }

  /** Phase gate S: Z↦Z, X↦Y. */
  s(q: number): void {
    const { x, z, r } = this;
    for (let i = 0; i < this.rows - 1; i++) {
      const a = this.idx(i, q);
      r[i] ^= x[a] & z[a];
      z[a] ^= x[a];
    }
  }

  /** S† = S·Z (S applied, then a Z phase fix). */
  sdg(q: number): void {
    this.s(q);
    this.z_(q);
  }

  /** Pauli X = H·S·S·H, but applied via its phase action: flip sign where z=1. */
  x_(q: number): void {
    const { z, r } = this;
    for (let i = 0; i < this.rows - 1; i++) r[i] ^= z[this.idx(i, q)];
  }

  /** Pauli Z: flip sign where x=1. */
  z_(q: number): void {
    const { x, r } = this;
    for (let i = 0; i < this.rows - 1; i++) r[i] ^= x[this.idx(i, q)];
  }

  /** Pauli Y = iXZ: flip sign where x⊕z=1 (row Pauli is X or Z, i.e. anticommutes with Y). */
  y_(q: number): void {
    const { x, z, r } = this;
    for (let i = 0; i < this.rows - 1; i++) {
      const a = this.idx(i, q);
      r[i] ^= x[a] ^ z[a];
    }
  }

  /** CNOT: control a, target b. */
  cnot(a: number, b: number): void {
    const { x, z, r } = this;
    for (let i = 0; i < this.rows - 1; i++) {
      const ia = this.idx(i, a), ib = this.idx(i, b);
      r[i] ^= x[ia] & z[ib] & (x[ib] ^ z[ia] ^ 1);
      x[ib] ^= x[ia];
      z[ia] ^= z[ib];
    }
  }

  /** CZ = H_b · CNOT(a,b) · H_b. */
  cz(a: number, b: number): void {
    this.h(b); this.cnot(a, b); this.h(b);
  }

  /** SWAP = CNOT(a,b)·CNOT(b,a)·CNOT(a,b). */
  swap(a: number, b: number): void {
    this.cnot(a, b); this.cnot(b, a); this.cnot(a, b);
  }

  /** Apply a named Clifford gate. Returns false (no-op) for non-Clifford gates. */
  apply(name: string, qubits: number[]): boolean {
    const g = cliffordName(name);
    if (!g) return false;
    switch (g) {
      case 'H': this.h(qubits[0]); break;
      case 'S': this.s(qubits[0]); break;
      case 'Sdg': this.sdg(qubits[0]); break;
      case 'X': this.x_(qubits[0]); break;
      case 'Y': this.y_(qubits[0]); break;
      case 'Z': this.z_(qubits[0]); break;
      case 'CNOT': this.cnot(qubits[0], qubits[1]); break;
      case 'CZ': this.cz(qubits[0], qubits[1]); break;
      case 'SWAP': this.swap(qubits[0], qubits[1]); break;
    }
    return true;
  }

  // ---- Row arithmetic -----------------------------------------------------

  /** Phase exponent (mod 4) contributed by left-multiplying Pauli (x1,z1) onto (x2,z2). */
  private static gExp(x1: number, z1: number, x2: number, z2: number): number {
    if (x1 === 0 && z1 === 0) return 0;
    if (x1 === 1 && z1 === 1) return z2 - x2;          // ∈ {-1,0,1}
    if (x1 === 1 && z1 === 0) return z2 * (2 * x2 - 1);
    return x2 * (1 - 2 * z2);                          // x1=0,z1=1
  }

  /** rowsum: set row h ← (row i)·(row h), tracking the sign exactly (AG eq. 2). */
  private rowsum(h: number, i: number): void {
    const { n, x, z, r } = this;
    let acc = 2 * r[h] + 2 * r[i];
    for (let j = 0; j < n; j++) {
      const hi = this.idx(h, j), ii = this.idx(i, j);
      acc += Stabilizer.gExp(x[ii], z[ii], x[hi], z[hi]);
    }
    acc = ((acc % 4) + 4) % 4; // 0 or 2 for valid Paulis
    r[h] = acc === 2 ? 1 : 0;
    for (let j = 0; j < n; j++) {
      const hi = this.idx(h, j), ii = this.idx(i, j);
      x[hi] ^= x[ii];
      z[hi] ^= z[ii];
    }
  }

  private copyRow(dest: number, src: number): void {
    const { n, x, z, r } = this;
    for (let j = 0; j < n; j++) {
      x[this.idx(dest, j)] = x[this.idx(src, j)];
      z[this.idx(dest, j)] = z[this.idx(src, j)];
    }
    r[dest] = r[src];
  }

  private zeroRow(row: number): void {
    const { n, x, z, r } = this;
    for (let j = 0; j < n; j++) { x[this.idx(row, j)] = 0; z[this.idx(row, j)] = 0; }
    r[row] = 0;
  }

  // ---- Measurement --------------------------------------------------------

  /** Index of the first anticommuting stabilizer row for a Z-measurement of qubit q. */
  private pivot(q: number): number {
    for (let i = this.n; i < 2 * this.n; i++) if (this.x[this.idx(i, q)]) return i;
    return -1;
  }

  /**
   * Probability of obtaining outcome 1 when measuring qubit q in the Z basis — without
   * collapsing the state. Returns exactly 0, 1, or 0.5.
   */
  prob1(q: number): number {
    if (this.pivot(q) >= 0) return 0.5; // random outcome
    // Deterministic: compute the outcome into the scratch row (does not touch generators).
    const scratch = 2 * this.n;
    this.zeroRow(scratch);
    for (let i = 0; i < this.n; i++) if (this.x[this.idx(i, q)]) this.rowsum(scratch, i + this.n);
    return this.r[scratch];
  }

  /**
   * Measure qubit q in the Z basis, collapsing the state. `forced` (0|1) overrides the
   * random branch — used to walk a specific outcome when computing exact probabilities.
   */
  measure(q: number, forced?: 0 | 1): 0 | 1 {
    const p = this.pivot(q);
    if (p >= 0) {
      for (let i = 0; i < 2 * this.n; i++) {
        if (i !== p && this.x[this.idx(i, q)]) this.rowsum(i, p);
      }
      this.copyRow(p - this.n, p);   // destabilizer ← old stabilizer
      this.zeroRow(p);
      this.z[this.idx(p, q)] = 1;    // new stabilizer is ±Z_q
      const outcome: 0 | 1 = forced !== undefined ? forced : (this.rng() < 0.5 ? 0 : 1);
      this.r[p] = outcome;
      return outcome;
    }
    // Deterministic — state already an eigenstate, nothing to collapse.
    return this.prob1(q) as 0 | 1;
  }

  /** Sample a full computational-basis measurement of every qubit (little-endian). */
  sample(): number {
    const s = this.clone();
    let out = 0;
    for (let q = 0; q < this.n; q++) if (s.measure(q)) out |= (1 << q);
    return out;
  }

  /**
   * Exact probability of a specific basis outcome `bits` (bit q = qubit q), via the
   * measurement chain rule on a clone. O(n³) — for cross-checking small circuits.
   */
  probabilityOf(bits: number): number {
    const s = this.clone();
    let p = 1;
    for (let q = 0; q < this.n; q++) {
      const b = ((bits >> q) & 1) as 0 | 1;
      const p1 = s.prob1(q);
      const pq = b ? p1 : 1 - p1;
      if (pq <= 0) return 0;
      p *= pq;
      s.measure(q, b);
    }
    return p;
  }

  /** Symplectic inner product of an external Pauli (px,pz) with tableau row `row` (0 ⇔ commute). */
  private symp(px: number[], pz: number[], row: number): number {
    let acc = 0;
    for (let j = 0; j < this.n; j++) acc ^= (px[j] & this.z[this.idx(row, j)]) ^ (pz[j] & this.x[this.idx(row, j)]);
    return acc;
  }

  /**
   * Eigenvalue of a multi-qubit Pauli observable P (given by its x/z bit vectors) on the
   * current stabilizer state: +1 or -1 if P is a (signed) member of the stabilizer group
   * (a deterministic measurement), or 0 if P anticommutes with some generator (⟨P⟩ = 0).
   * Exact for pure-X / pure-Z observables — used for code syndrome extraction.
   */
  pauliEigenvalue(px: number[], pz: number[]): -1 | 0 | 1 {
    for (let i = this.n; i < 2 * this.n; i++) if (this.symp(px, pz, i)) return 0; // random ⇒ ⟨P⟩=0
    const scratch = 2 * this.n;
    this.zeroRow(scratch); // identity
    for (let i = 0; i < this.n; i++) if (this.symp(px, pz, i)) this.rowsum(scratch, i + this.n);
    return this.r[scratch] ? -1 : 1;
  }

  // ---- Generators ---------------------------------------------------------

  /** The n stabilizer generators (signed Pauli strings) defining the state. */
  generators(): Generator[] {
    const out: Generator[] = [];
    for (let i = this.n; i < 2 * this.n; i++) {
      const paulis: Pauli1[] = [];
      for (let q = 0; q < this.n; q++) {
        const xb = this.x[this.idx(i, q)], zb = this.z[this.idx(i, q)];
        paulis.push(xb && zb ? 'Y' : xb ? 'X' : zb ? 'Z' : 'I');
      }
      out.push({ sign: this.r[i] ? -1 : 1, paulis });
    }
    return out;
  }

  /** Generators as printable strings, e.g. "+XXX", "-ZZI". */
  generatorStrings(): string[] {
    return this.generators().map((g) => (g.sign < 0 ? '-' : '+') + g.paulis.join(''));
  }

  /**
   * Build the unique stabilizer state pinned by n commuting, independent generators given as
   * signed Pauli strings — no Clifford circuit required. This is how an *encoded* logical state
   * is loaded directly: pass a code's n−k stabilizers together with its k logical-Z operators and
   * the result is the joint +1 eigenstate |0…0⟩_L.
   *
   * The stabilizer rows are placed verbatim; the destabilizer rows (the symplectic-dual basis the
   * CHP tableau needs for measurement and sign tracking) are synthesised by solving, over GF(2),
   * the symplectic system ⟨dᵢ, sⱼ⟩ = δᵢⱼ and then a symplectic Gram–Schmidt pass that makes the
   * destabilizers mutually commuting without disturbing their pairing with the stabilizers.
   */
  static fromGenerators(generators: Generator[], rng?: () => number): Stabilizer {
    const n = generators.length;
    if (generators.some((g) => g.paulis.length !== n))
      throw new Error('fromGenerators needs exactly n generators on n qubits');

    // Symplectic vectors of the stabilizers: sVec[i] = [x_0..x_{n-1}, z_0..z_{n-1}].
    const sVec: number[][] = generators.map((g) => {
      const x = new Array(n).fill(0), z = new Array(n).fill(0);
      for (let q = 0; q < n; q++) {
        const p = g.paulis[q];
        if (p === 'X' || p === 'Y') x[q] = 1;
        if (p === 'Z' || p === 'Y') z[q] = 1;
      }
      return [...x, ...z];
    });

    const sympVec = (a: number[], b: number[]): number => {
      let acc = 0;
      for (let q = 0; q < n; q++) acc ^= (a[q] & b[n + q]) ^ (a[n + q] & b[q]);
      return acc;
    };

    // Row i of A is sᵢ with its X/Z blocks swapped, so A·d = ⟨sᵢ, d⟩.
    const A: number[][] = sVec.map((s) => [...s.slice(n), ...s.slice(0, n)]);

    // Particular GF(2) solution of A·d = rhs (free columns set to 0).
    const solve = (rhs: number[]): number[] => {
      const m = A.map((row, i) => [...row, rhs[i]]); // n × (2n+1) augmented
      const pivotCol: number[] = [];
      let r = 0;
      for (let c = 0; c < 2 * n && r < n; c++) {
        let piv = -1;
        for (let i = r; i < n; i++) if (m[i][c]) { piv = i; break; }
        if (piv < 0) continue;
        [m[r], m[piv]] = [m[piv], m[r]];
        for (let i = 0; i < n; i++) if (i !== r && m[i][c]) for (let j = 0; j <= 2 * n; j++) m[i][j] ^= m[r][j];
        pivotCol[r] = c; r++;
      }
      const d = new Array(2 * n).fill(0);
      for (let i = 0; i < r; i++) d[pivotCol[i]] = m[i][2 * n];
      return d;
    };

    const dVec: number[][] = [];
    for (let i = 0; i < n; i++) { const e = new Array(n).fill(0); e[i] = 1; dVec.push(solve(e)); }
    // Symplectic Gram–Schmidt: adding sᵢ to dⱼ leaves every ⟨d, s⟩ fixed (stabilizers commute)
    // and flips only ⟨dᵢ, dⱼ⟩, so this clears all destabilizer–destabilizer overlaps.
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (sympVec(dVec[i], dVec[j])) for (let c = 0; c < 2 * n; c++) dVec[j][c] ^= sVec[i][c];

    const s = new Stabilizer(n, rng);
    for (let i = 0; i < n; i++) {
      for (let q = 0; q < n; q++) {
        s.x[s.idx(i, q)] = dVec[i][q];      s.z[s.idx(i, q)] = dVec[i][n + q];      // destabilizer
        s.x[s.idx(n + i, q)] = sVec[i][q];  s.z[s.idx(n + i, q)] = sVec[i][n + q];  // stabilizer
      }
      s.r[i] = 0;
      s.r[n + i] = generators[i].sign < 0 ? 1 : 0;
    }
    return s;
  }

  /** Build a stabilizer state by running a Clifford circuit; throws on a non-Clifford gate. */
  static fromCircuit(
    n: number,
    ops: { name: string; qubits: number[] }[],
    rng?: () => number,
  ): Stabilizer {
    const s = new Stabilizer(n, rng);
    for (const op of ops) {
      if (!s.apply(op.name, op.qubits)) {
        throw new Error(`Non-Clifford gate "${op.name}" — not representable in the stabilizer formalism`);
      }
    }
    return s;
  }
}

/** True iff every op in the circuit is a Clifford gate (so the tableau can simulate it). */
export function isCliffordCircuit(ops: { name: string }[]): boolean {
  return ops.every((o) => isClifford(o.name));
}
