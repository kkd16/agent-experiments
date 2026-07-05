/**
 * A minimal symbolic Pauli algebra and the Jordan–Wigner transform.
 *
 * A qubit Hamiltonian is a real linear combination of Pauli strings (tensor products of
 * I/X/Y/Z). To build one from a fermionic (electronic) Hamiltonian we need to (a) multiply
 * Pauli strings, tracking the ±1, ±i phases of the single-qubit product table, and (b) map
 * fermionic creation/annihilation operators to qubit operators. The Jordan–Wigner encoding
 * does exactly that:  aⱼ = (∏_{k<j} Zₖ) · (Xⱼ + iYⱼ)/2, with a Z "string" enforcing the
 * fermionic antisymmetry (a sign for every occupied mode to the left).
 *
 * This module is deliberately tiny and exact — no floating Pauli truncation until the very
 * end — so the resulting Hamiltonian is Hermitian to machine precision (all imaginary parts
 * cancel), which the tests check.
 */

type Cx = { re: number; im: number };
const cx = (re: number, im = 0): Cx => ({ re, im });
const cmul = (a: Cx, b: Cx): Cx => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cadd = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im });

/** Single-qubit Pauli product table: A·B = phase · P. */
const TABLE: Record<string, [string, Cx]> = {
  II: ['I', cx(1)], IX: ['X', cx(1)], IY: ['Y', cx(1)], IZ: ['Z', cx(1)],
  XI: ['X', cx(1)], XX: ['I', cx(1)], XY: ['Z', cx(0, 1)], XZ: ['Y', cx(0, -1)],
  YI: ['Y', cx(1)], YX: ['Z', cx(0, -1)], YY: ['I', cx(1)], YZ: ['X', cx(0, 1)],
  ZI: ['Z', cx(1)], ZX: ['Y', cx(0, 1)], ZY: ['X', cx(0, -1)], ZZ: ['I', cx(1)],
};

/** A sum of Pauli strings: key = length-M string over {I,X,Y,Z}, value = complex coefficient. */
export type PauliSum = Map<string, Cx>;

export function psScale(a: PauliSum, s: Cx): PauliSum {
  const r: PauliSum = new Map();
  for (const [k, v] of a) r.set(k, cmul(v, s));
  return r;
}
export function psAdd(a: PauliSum, b: PauliSum): PauliSum {
  const r: PauliSum = new Map(a);
  for (const [k, v] of b) r.set(k, cadd(r.get(k) ?? cx(0), v));
  return r;
}
export function psMul(a: PauliSum, b: PauliSum, M: number): PauliSum {
  const r: PauliSum = new Map();
  for (const [ka, va] of a)
    for (const [kb, vb] of b) {
      let phase = cx(1);
      const out = new Array(M);
      for (let i = 0; i < M; i++) {
        const [p, ph] = TABLE[ka[i] + kb[i]];
        out[i] = p;
        phase = cmul(phase, ph);
      }
      const key = out.join('');
      r.set(key, cadd(r.get(key) ?? cx(0), cmul(cmul(va, vb), phase)));
    }
  return r;
}

/** A single Pauli operator `p` on qubit `idx` (over M qubits) with coefficient `coeff`. */
export function single(M: number, idx: number, p: string, coeff: Cx): PauliSum {
  const s = new Array(M).fill('I');
  s[idx] = p;
  return new Map([[s.join(''), coeff]]);
}

/** Jordan–Wigner annihilation operator a_j = (∏_{k<j} Z_k)(X_j + iY_j)/2. */
export function jwAnnihilate(M: number, j: number): PauliSum {
  let op = psAdd(single(M, j, 'X', cx(0.5)), single(M, j, 'Y', cx(0, 0.5)));
  for (let k = 0; k < j; k++) op = psMul(single(M, k, 'Z', cx(1)), op, M);
  return op;
}

/** Jordan–Wigner creation operator a†_j = (∏_{k<j} Z_k)(X_j − iY_j)/2. */
export function jwCreate(M: number, j: number): PauliSum {
  let op = psAdd(single(M, j, 'X', cx(0.5)), single(M, j, 'Y', cx(0, -0.5)));
  for (let k = 0; k < j; k++) op = psMul(single(M, k, 'Z', cx(1)), op, M);
  return op;
}

/** Product of an ordered list of JW operators (each 'c'=create or 'a'=annihilate at a mode). */
export function jwProduct(M: number, ops: Array<{ kind: 'c' | 'a'; mode: number }>): PauliSum {
  let acc: PauliSum = new Map([[('I'.repeat(M)), cx(1)]]);
  for (const o of ops) acc = psMul(acc, o.kind === 'c' ? jwCreate(M, o.mode) : jwAnnihilate(M, o.mode), M);
  return acc;
}

/** The repo-standard Pauli term used by `expectation` / `exactGroundEnergy`. */
export interface PauliTerm {
  coeff: number;
  ops: Record<number, 'I' | 'X' | 'Y' | 'Z'>;
}

/**
 * Collapse a (Hermitian) PauliSum into real PauliTerms, dropping negligible coefficients.
 * Throws if any surviving imaginary part is non-trivial — a guard that the operator really
 * is Hermitian and no phase bookkeeping was lost.
 */
export function toPauliTerms(sum: PauliSum, eps = 1e-10): { terms: PauliTerm[]; constant: number } {
  const terms: PauliTerm[] = [];
  let constant = 0;
  for (const [key, v] of sum) {
    if (Math.abs(v.re) < eps && Math.abs(v.im) < eps) continue;
    if (Math.abs(v.im) > 1e-8) throw new Error(`non-Hermitian Pauli term ${key}: im=${v.im}`);
    if (![...key].some((c) => c !== 'I')) { constant += v.re; continue; }
    const ops: Record<number, 'I' | 'X' | 'Y' | 'Z'> = {};
    for (let i = 0; i < key.length; i++) if (key[i] !== 'I') ops[i] = key[i] as 'X' | 'Y' | 'Z';
    terms.push({ coeff: v.re, ops });
  }
  return { terms, constant };
}

/** Pretty-print a Pauli string like "IXYZ" as "X₁ Y₂ Z₃" (identity qubits dropped). */
export function prettyPauli(key: string): string {
  const sub = '₀₁₂₃₄₅₆₇₈₉';
  const parts: string[] = [];
  for (let i = 0; i < key.length; i++)
    if (key[i] !== 'I') parts.push(key[i] + String(i).split('').map((d) => sub[+d]).join(''));
  return parts.length ? parts.join(' ') : 'I';
}
