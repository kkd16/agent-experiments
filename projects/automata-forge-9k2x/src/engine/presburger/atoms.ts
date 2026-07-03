// The atomic automata of the Presburger construction — the base cases the boolean algebra and the
// quantifier projection build on. Two families, both reading least-significant-bit-first:
//
//   • a **linear (in)equality** `Σ aᵢ·xᵢ  {≤ < ≥ > = ≠}  c` — the classic LSBF *carry automaton*
//     (Boudet–Comon 1996 / Wolper–Boigelot): the state is the value the remaining higher bits must
//     still account for. Reading a bit-vector `b` consumes the low bit of the equation and halves
//     what is left: `s → ⌊(s − a·b)/2⌋` for `≤`, and the parity-gated `(s − a·b)/2` for `=` (an odd
//     residue means the low bit can never balance, so that branch dies).
//
//   • a **congruence** `Σ aᵢ·xᵢ ≡ c (mod m)` — the state tracks `(running residue, 2ⁱ mod m)`, at
//     most m² states, and accepts when the residue matches.
//
// Every atom is finite-state (the carry stays within a fixed band) and 0-stable by construction:
// reading the all-zero letter maps `s ↦ ⌊s/2⌋` (`≤`: sign-preserving) resp. leaves the residue fixed,
// so acceptance is unchanged.

import type { PDfa } from './automaton'
import { fromSym, complement } from './automaton'

export type Cmp = 'le' | 'lt' | 'ge' | 'gt' | 'eq' | 'ne'

export const CMP_GLYPH: Record<Cmp, string> = {
  le: '≤',
  lt: '<',
  ge: '≥',
  gt: '>',
  eq: '=',
  ne: '≠',
}

/** Σ coeffs·(bits of `letter`) — the contribution of one LSBF column. */
function dot(coeffs: number[], letter: number): number {
  let s = 0
  for (let j = 0; j < coeffs.length; j++) if ((letter >> j) & 1) s += coeffs[j]
  return s
}

/** Automaton for `Σ coeffs·x ≤ c` over the given variable tracks. */
function leq(coeffs: number[], c: number, vars: string[]): PDfa {
  return fromSym<number>({
    start: c,
    k: vars.length,
    vars,
    key: (s) => String(s),
    step: (s, letter) => Math.floor((s - dot(coeffs, letter)) / 2),
    accept: (s) => s >= 0,
  })
}

/** Automaton for `Σ coeffs·x = c` over the given variable tracks (a parity-gated carry chain). */
function eq(coeffs: number[], c: number, vars: string[]): PDfa {
  return fromSym<number>({
    start: c,
    k: vars.length,
    vars,
    key: (s) => String(s),
    step: (s, letter) => {
      const d = s - dot(coeffs, letter)
      return (d & 1) !== 0 ? null : d / 2 // odd residue ⇒ dead
    },
    accept: (s) => s === 0,
  })
}

/**
 * The general linear atom. Every comparison reduces to `≤` or `=` (and possibly a complement):
 *   a·x < c   ≡  a·x ≤ c−1
 *   a·x ≥ c   ≡  (−a)·x ≤ −c
 *   a·x > c   ≡  (−a)·x ≤ −c−1
 *   a·x ≠ c   ≡  ¬(a·x = c)
 */
export function buildLinear(coeffs: number[], op: Cmp, c: number, vars: string[]): PDfa {
  const neg = coeffs.map((x) => -x)
  switch (op) {
    case 'le':
      return leq(coeffs, c, vars)
    case 'lt':
      return leq(coeffs, c - 1, vars)
    case 'ge':
      return leq(neg, -c, vars)
    case 'gt':
      return leq(neg, -c - 1, vars)
    case 'eq':
      return eq(coeffs, c, vars)
    case 'ne':
      return complement(eq(coeffs, c, vars))
  }
}

/** Automaton for `Σ coeffs·x ≡ c (mod m)` over the given variable tracks. */
export function buildCongruence(coeffs: number[], c: number, m: number, vars: string[]): PDfa {
  const mm = Math.abs(m) | 0
  if (mm === 0) throw new Error('congruence modulus must be non-zero')
  const cred = ((c % mm) + mm) % mm
  const cmod = coeffs.map((a) => ((a % mm) + mm) % mm)
  const dotMod = (letter: number): number => {
    let s = 0
    for (let j = 0; j < coeffs.length; j++) if ((letter >> j) & 1) s = (s + cmod[j]) % mm
    return s
  }
  return fromSym<{ r: number; p: number }>({
    start: { r: 0, p: 1 % mm },
    k: vars.length,
    vars,
    key: (s) => s.r + ':' + s.p,
    step: (s, letter) => ({ r: (s.r + s.p * dotMod(letter)) % mm, p: (s.p * 2) % mm }),
    accept: (s) => s.r === cred,
  })
}

/** The constant automaton — ⊤ (accept everything) or ⊥ (accept nothing) — over a scope. */
export function constDfa(value: boolean, vars: string[]): PDfa {
  const A = 1 << vars.length
  return {
    numStates: 1,
    start: 0,
    accept: [value],
    trans: [new Array(A).fill(0)],
    k: vars.length,
    vars,
  }
}
