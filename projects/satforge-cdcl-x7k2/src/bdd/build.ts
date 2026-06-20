// Builders: BDDs from CNF, and a gallery of classic functions chosen to show
// off canonicity, model counting, and (above all) order sensitivity.

import { Bdd, BDD_FALSE, BDD_TRUE } from './bdd'
import type { NodeId } from './bdd'
import type { CNF } from '../sat/cnf'

/** Conjoin a CNF into a single BDD over variables x0..x_{numVars-1}. */
export function bddFromCnf(cnf: CNF, order?: number[]): { bdd: Bdd; root: NodeId } {
  const bdd = new Bdd(cnf.numVars, order)
  let root: NodeId = BDD_TRUE
  // Conjoin shortest clauses first — keeps intermediate diagrams smaller.
  const clauses = cnf.clauses.slice().sort((a, b) => a.length - b.length)
  for (const clause of clauses) {
    let c: NodeId = BDD_FALSE
    for (const lit of clause) c = bdd.or(c, bdd.literal(lit))
    root = bdd.and(root, c)
    if (root === BDD_FALSE) break // unsatisfiable — short-circuit
  }
  return { bdd, root }
}

export interface BuiltFn {
  bdd: Bdd
  root: NodeId
  varNames: string[]
}

export interface GalleryItem {
  id: string
  title: string
  blurb: string
  build: () => BuiltFn
  /** A variable order (level→var) that keeps the diagram small, if one exists. */
  goodOrder?: number[]
  /** A variable order that blows it up — the cautionary tale. */
  badOrder?: number[]
}

// --- helpers ---------------------------------------------------------------

function interleavedNames(n: number, a = 'a', b = 'b'): string[] {
  const names: string[] = []
  for (let i = 0; i < n; i++) names.push(`${a}${i}`)
  for (let i = 0; i < n; i++) names.push(`${b}${i}`)
  return names
}

// Variable layout for the paired examples: indices 0..n-1 are a0..a_{n-1},
// indices n..2n-1 are b0..b_{n-1}. "Grouped" = identity order (all a's then all
// b's). "Interleaved" = a0 b0 a1 b1 …
function groupedOrder(n: number): number[] {
  return Array.from({ length: 2 * n }, (_, i) => i)
}
function interleavedOrder(n: number): number[] {
  const o: number[] = []
  for (let i = 0; i < n; i++) {
    o.push(i) // a_i
    o.push(n + i) // b_i
  }
  return o
}

// --- the order-sensitive star: OR_i (a_i ∧ b_i) -----------------------------

function pairOr(n: number): BuiltFn {
  const bdd = new Bdd(2 * n) // identity order = grouped (the BAD order)
  let root: NodeId = BDD_FALSE
  for (let i = 0; i < n; i++) {
    const ai = bdd.ithVar(i)
    const bi = bdd.ithVar(n + i)
    root = bdd.or(root, bdd.and(ai, bi))
  }
  return { bdd, root, varNames: interleavedNames(n) }
}

// A==B over n-bit words.
function equalWords(n: number): BuiltFn {
  const bdd = new Bdd(2 * n)
  let root: NodeId = BDD_TRUE
  for (let i = 0; i < n; i++) root = bdd.and(root, bdd.iff(bdd.ithVar(i), bdd.ithVar(n + i)))
  return { bdd, root, varNames: interleavedNames(n) }
}

// Ripple-carry adder: the carry-out of a + b.
function adderCarry(n: number): BuiltFn {
  const bdd = new Bdd(2 * n, interleavedOrder(n)) // start in the good order
  let carry: NodeId = BDD_FALSE
  for (let i = 0; i < n; i++) {
    const ai = bdd.ithVar(i)
    const bi = bdd.ithVar(n + i)
    const ab = bdd.and(ai, bi)
    const ac = bdd.and(ai, carry)
    const bc = bdd.and(bi, carry)
    carry = bdd.or(bdd.or(ab, ac), bc) // majority(a_i, b_i, carry)
  }
  return { bdd, root: carry, varNames: interleavedNames(n) }
}

// n-bit parity — linear in EVERY order (a nice contrast to pairOr).
function parity(n: number): BuiltFn {
  const bdd = new Bdd(n)
  let root: NodeId = BDD_FALSE
  for (let i = 0; i < n; i++) root = bdd.xor(root, bdd.ithVar(i))
  return { bdd, root, varNames: Array.from({ length: n }, (_, i) => `x${i}`) }
}

// "At least k of n" — a symmetric threshold function, built by DP over the BDD.
function threshold(n: number, k: number): BuiltFn {
  const bdd = new Bdd(n)
  const memo = new Map<string, NodeId>()
  const go = (i: number, need: number): NodeId => {
    if (need <= 0) return BDD_TRUE
    if (n - i < need) return BDD_FALSE
    const key = i + ',' + need
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const hiB = go(i + 1, need - 1) // x_i = 1
    const loB = go(i + 1, need) // x_i = 0
    const r = bdd.mk(i, loB, hiB)
    memo.set(key, r)
    return r
  }
  const root = go(0, k)
  return { bdd, root, varNames: Array.from({ length: n }, (_, i) => `x${i}`) }
}

// Majority of n (odd) bits.
function majority(n: number): BuiltFn {
  const t = threshold(n, Math.ceil(n / 2))
  return t
}

export const GALLERY: GalleryItem[] = [
  {
    id: 'pair-or',
    title: 'Bit-match  ⋁ᵢ (aᵢ ∧ bᵢ)',
    blurb:
      'The textbook order trap. Interleave a0 b0 a1 b1 … and the diagram is linear; ' +
      'keep the groups apart (all aᵢ then all bᵢ) and it is exponential. Loads in the BAD order.',
    build: () => pairOr(5),
    goodOrder: interleavedOrder(5),
    badOrder: groupedOrder(5),
  },
  {
    id: 'equal-words',
    title: 'Word equality  A = B',
    blurb:
      'Two 5-bit words are equal iff every bit matches. Interleaving the operands keeps the ' +
      'diagram linear; the grouped order is exponential.',
    build: () => equalWords(5),
    goodOrder: interleavedOrder(5),
    badOrder: groupedOrder(5),
  },
  {
    id: 'adder-carry',
    title: 'Adder carry-out  cₙ(a + b)',
    blurb:
      'The most-significant carry of a ripple-carry adder. Bit-interleaved it is tiny; group the ' +
      'operands and it grows. Loads in the GOOD order — try “reverse” to watch it swell.',
    build: () => adderCarry(6),
    goodOrder: interleavedOrder(6),
    badOrder: groupedOrder(6),
  },
  {
    id: 'parity',
    title: 'Parity  x0 ⊕ x1 ⊕ … ⊕ x7',
    blurb:
      'Exclusive-or of 8 bits — exactly 2n−1 nodes in EVERY order. The happy case where order ' +
      'cannot hurt you. Half of all 256 assignments satisfy it.',
    build: () => parity(8),
  },
  {
    id: 'majority',
    title: 'Majority of 7 bits',
    blurb: 'True when at least four of seven inputs are set — a symmetric threshold function.',
    build: () => majority(7),
  },
  {
    id: 'threshold',
    title: 'At least 3 of 8',
    blurb: 'A cardinality constraint Σxᵢ ≥ 3 as a BDD; its model count is the binomial tail.',
    build: () => threshold(8, 3),
  },
]

export { BDD_FALSE, BDD_TRUE }
