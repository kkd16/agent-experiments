/**
 * Multi-qubit Pauli operators in the symplectic (binary) representation. A Pauli on n qubits,
 * ignoring global phase, is a pair of bit vectors (x, z) ∈ GF(2)ⁿ × GF(2)ⁿ: qubit j carries
 *
 *     00 → I,  10 → X,  11 → Y,  01 → Z.
 *
 * The Pauli group's *commutation* structure is then a symplectic form: two Paulis P, Q commute
 * iff their symplectic inner product ⟨P, Q⟩ = Σ_j (x_j z'_j ⊕ z_j x'_j) is 0. This single fact
 * is the entire algebraic engine behind stabilizer codes — syndromes, the normaliser, logical
 * operators and code distance are all read off it. We keep an optional `sign` bit (the eigenvalue
 * ±1) so a decoder can return an actual correction, but distance/syndrome analysis ignores it.
 */

export interface SymPauli {
  x: number[]; // length n
  z: number[]; // length n
  sign: 0 | 1; // 0 → +1, 1 → −1
}

export type Pauli1 = 'I' | 'X' | 'Y' | 'Z';

/** The single-qubit Pauli on qubit j implied by bits (x, z). */
export function pauliLetter(x: number, z: number): Pauli1 {
  return x && z ? 'Y' : x ? 'X' : z ? 'Z' : 'I';
}

/** Parse a Pauli string like "+XZZXI", "-IIZ" or "XXXX" into its symplectic form. */
export function parsePauli(s: string): SymPauli {
  let sign: 0 | 1 = 0;
  let str = s.trim();
  if (str[0] === '+') str = str.slice(1);
  else if (str[0] === '-') { sign = 1; str = str.slice(1); }
  const x: number[] = [], z: number[] = [];
  for (const ch of str) {
    switch (ch.toUpperCase()) {
      case 'I': x.push(0); z.push(0); break;
      case 'X': x.push(1); z.push(0); break;
      case 'Y': x.push(1); z.push(1); break;
      case 'Z': x.push(0); z.push(1); break;
      default: throw new Error(`bad Pauli letter "${ch}" in "${s}"`);
    }
  }
  return { x, z, sign };
}

/** Render a Pauli back to a signed string, e.g. "+XZZXI". */
export function pauliString(p: SymPauli): string {
  let out = p.sign ? '-' : '+';
  for (let j = 0; j < p.x.length; j++) out += pauliLetter(p.x[j], p.z[j]);
  return out;
}

/** Number of qubits a Pauli acts on non-trivially (its weight). */
export function weight(p: SymPauli): number {
  let w = 0;
  for (let j = 0; j < p.x.length; j++) if (p.x[j] || p.z[j]) w++;
  return w;
}

/** Symplectic inner product ⟨P, Q⟩ ∈ {0, 1}; 0 ⇔ P and Q commute. */
export function symplectic(p: SymPauli, q: SymPauli): number {
  let acc = 0;
  for (let j = 0; j < p.x.length; j++) acc ^= (p.x[j] & q.z[j]) ^ (p.z[j] & q.x[j]);
  return acc & 1;
}

export function commute(p: SymPauli, q: SymPauli): boolean {
  return symplectic(p, q) === 0;
}

/** Product P·Q of two Paulis, ignoring the global phase (x/z add mod 2). Sign is XORed as a
 *  bookkeeping convenience — it does not track the i factors, which are irrelevant to code
 *  analysis (a decoder only needs the X/Z content of its correction). */
export function multiply(p: SymPauli, q: SymPauli): SymPauli {
  const n = p.x.length;
  const x = new Array(n), z = new Array(n);
  for (let j = 0; j < n; j++) { x[j] = p.x[j] ^ q.x[j]; z[j] = p.z[j] ^ q.z[j]; }
  return { x, z, sign: (p.sign ^ q.sign) as 0 | 1 };
}

/** The 2n-bit symplectic vector [x | z] of a Pauli — the row used in GF(2) matrices. */
export function toVec(p: SymPauli): number[] {
  return [...p.x, ...p.z];
}

/** Inverse of `toVec`: split a 2n-bit vector back into (x, z). */
export function fromVec(v: number[], sign: 0 | 1 = 0): SymPauli {
  const n = v.length / 2;
  return { x: v.slice(0, n), z: v.slice(n), sign };
}

/** The identity Pauli on n qubits. */
export function identity(n: number): SymPauli {
  return { x: new Array(n).fill(0), z: new Array(n).fill(0), sign: 0 };
}
