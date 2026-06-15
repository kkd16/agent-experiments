// Integer factoring as SAT: build a Boolean circuit for "a · b = N" and let the
// solver search for the bits of a and b. This is the same idea that makes SAT a
// (very slow!) cryptanalytic tool: multiplication is easy to *encode* but, run
// backwards, factoring is hard.
//
// We lay down a from-scratch shift-and-add multiplier in Tseitin form. Each AND/XOR/OR
// gate becomes a fresh variable plus the clauses that pin it to its definition; a
// chain of full adders sums the partial products. The product bits are then fixed to
// the bits of N, and we require a ≥ 2 and b ≥ 2. A satisfying assignment is a genuine
// factorization; UNSAT is a proof that N has no such split — i.e. N is prime (or 1).

import type { CNF } from '../cnf'
import { CnfBuilder } from './util'

export interface FactorSolution {
  n: number
  a: number
  b: number
  aBits: number[] // LSB-first
  bBits: number[]
}

export function encodeFactoring(N: number): {
  cnf: CNF
  decode: (model: boolean[]) => FactorSolution
  bits: number
} {
  const n = Math.max(0, Math.floor(N))
  const b = new CnfBuilder()

  // Bit widths: each factor gets `m` bits; the product spans `W = 2m` bits, enough to
  // hold any product of two m-bit numbers without wraparound.
  const m = Math.max(2, n.toString(2).length)
  const W = 2 * m

  // A constant-false wire lets the gate helpers special-case it away, shrinking the CNF.
  const F = b.fresh()
  b.add(-F)

  const AND = (x: number, y: number): number => {
    if (x === F || y === F) return F
    const z = b.fresh()
    b.add(-z, x)
    b.add(-z, y)
    b.add(z, -x, -y)
    return z
  }
  const XOR = (x: number, y: number): number => {
    if (x === F) return y
    if (y === F) return x
    const z = b.fresh()
    b.add(-z, -x, -y)
    b.add(-z, x, y)
    b.add(z, -x, y)
    b.add(z, x, -y)
    return z
  }
  const OR = (x: number, y: number): number => {
    if (x === F) return y
    if (y === F) return x
    const z = b.fresh()
    b.add(z, -x)
    b.add(z, -y)
    b.add(-z, x, y)
    return z
  }
  // Full adder: returns sum = x ⊕ y ⊕ cin and carry = majority(x, y, cin).
  const fullAdd = (x: number, y: number, cin: number): { sum: number; carry: number } => {
    const xy = XOR(x, y)
    const sum = XOR(xy, cin)
    const carry = OR(AND(x, y), AND(xy, cin))
    return { sum, carry }
  }

  const A: number[] = []
  const Bv: number[] = []
  for (let i = 0; i < m; i++) A.push(b.fresh())
  for (let i = 0; i < m; i++) Bv.push(b.fresh())

  // Accumulate the product by rippling each shifted partial-product row into `acc`.
  const acc: number[] = new Array<number>(W).fill(F)
  for (let i = 0; i < m; i++) {
    let carry = F
    for (let j = 0; j < m; j++) {
      const pos = i + j
      const pp = AND(A[i], Bv[j]) // partial-product bit a_i · b_j at weight i+j
      const { sum, carry: c } = fullAdd(acc[pos], pp, carry)
      acc[pos] = sum
      carry = c
    }
    // Ripple the leftover carry up through the high columns.
    for (let pos = i + m; pos < W; pos++) {
      const { sum, carry: c } = fullAdd(acc[pos], F, carry)
      acc[pos] = sum
      carry = c
    }
    // The product of two m-bit numbers fits in W bits, so the top carry must vanish.
    if (carry !== F) b.add(-carry)
  }

  // Constrain the product to equal N bit by bit.
  for (let w = 0; w < W; w++) {
    const bit = (n >> w) & 1
    b.add(bit ? acc[w] : -acc[w])
  }

  // Require both factors ≥ 2 (some bit above bit 0 is set), ruling out the trivial
  // 1 · N split and forcing a genuine factorization.
  b.add(...A.slice(1))
  b.add(...Bv.slice(1))

  b.comments.push(`Factoring N=${n} as a*b with a,b >= 2 (shift-add multiplier, ${m}-bit factors)`)

  return {
    cnf: b.build(),
    bits: m,
    decode: (model) => {
      const readBits = (vars: number[]) => vars.map((v) => (model[v] ? 1 : 0))
      const toInt = (bitsArr: number[]) => bitsArr.reduce((acc2, bit, i) => acc2 + bit * 2 ** i, 0)
      const aBits = readBits(A)
      const bBits = readBits(Bv)
      return { n, a: toInt(aBits), b: toInt(bBits), aBits, bBits }
    },
  }
}
