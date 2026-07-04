// galois.ts — the algebraic substrate for the channel-coding pillar.
//
// Two independent pieces of finite-field machinery live here:
//
//  1. GF(2) LINEAR ALGEBRA — vectors and matrices over the two-element field
//     {0,1} where addition is XOR and multiplication is AND. Every *linear block
//     code* (Hamming, repetition, single-parity, and the parity-check side of
//     LDPC) is a null space / row space of a GF(2) matrix, so we need mod-2
//     Gauss–Jordan elimination, rank, and null-space extraction.
//
//  2. GF(2^8) = GF(256) FIELD ARITHMETIC — the field Reed–Solomon and QR codes
//     live in. Its 256 elements are the polynomials of degree < 8 over GF(2);
//     multiplication is polynomial multiplication reduced modulo the primitive
//     polynomial x^8+x^4+x^3+x^2+1 (0x11D). Because the field is cyclic, every
//     non-zero element is a power of the generator α=0x02, so multiply/divide/
//     inverse become add/subtract of discrete logarithms via exp/log tables.
//
// Both are framework-free and individually unit-tested by the Self-test page.

// ======================================================================
//  Part 1 — GF(2) linear algebra
// ======================================================================

/** A GF(2) matrix as an array of rows, each row an array of 0/1 numbers. */
export type BitMatrix = number[][]

/** Multiply a row vector (length k) by a k×n GF(2) matrix → length-n vector. */
export function vecMatMul(vec: number[], mat: BitMatrix): number[] {
  const n = mat[0]?.length ?? 0
  const out = new Array(n).fill(0)
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] & 1) {
      const row = mat[i]
      for (let j = 0; j < n; j++) out[j] ^= row[j] & 1
    }
  }
  return out
}

/** Multiply an m×n matrix by a length-n column vector → length-m vector (H·xᵀ). */
export function matVecMul(mat: BitMatrix, vec: number[]): number[] {
  return mat.map((row) => {
    let acc = 0
    for (let j = 0; j < row.length; j++) acc ^= row[j] & vec[j] & 1
    return acc
  })
}

/** Deep copy of a bit matrix. */
export function cloneMatrix(m: BitMatrix): BitMatrix {
  return m.map((r) => r.slice())
}

/**
 * Reduced row-echelon form over GF(2) (Gauss–Jordan). Returns the RREF matrix,
 * its rank, and the pivot column of each pivot row. Non-destructive.
 */
export function rref(mat: BitMatrix): { R: BitMatrix; rank: number; pivots: number[] } {
  const R = cloneMatrix(mat)
  const rows = R.length
  const cols = rows > 0 ? R[0].length : 0
  const pivots: number[] = []
  let r = 0
  for (let c = 0; c < cols && r < rows; c++) {
    // Find a pivot in column c at or below row r.
    let piv = -1
    for (let i = r; i < rows; i++) {
      if (R[i][c] & 1) {
        piv = i
        break
      }
    }
    if (piv === -1) continue
    // Swap into position.
    if (piv !== r) {
      const tmp = R[piv]
      R[piv] = R[r]
      R[r] = tmp
    }
    // Eliminate this column from every other row.
    for (let i = 0; i < rows; i++) {
      if (i !== r && R[i][c] & 1) {
        for (let j = c; j < cols; j++) R[i][j] ^= R[r][j]
      }
    }
    pivots.push(c)
    r++
  }
  return { R, rank: r, pivots }
}

/** Rank of a GF(2) matrix. */
export function gf2Rank(mat: BitMatrix): number {
  return rref(mat).rank
}

/**
 * A basis for the null space {x : M·xᵀ = 0} of an m×n GF(2) matrix, returned as
 * an array of length-n basis vectors. For an (n,k) code, the parity-check matrix
 * H is m=(n−k) × n and this basis is exactly the code's generator rows.
 */
export function nullSpace(mat: BitMatrix): number[][] {
  const n = mat[0]?.length ?? 0
  const { R, pivots } = rref(mat)
  const pivotSet = new Set(pivots)
  const free: number[] = []
  for (let c = 0; c < n; c++) if (!pivotSet.has(c)) free.push(c)
  const basis: number[][] = []
  for (const f of free) {
    const v = new Array(n).fill(0)
    v[f] = 1
    // For each pivot row, the pivot variable equals the XOR of the free vars in
    // that row (since over GF(2), −1 = 1). Back-substitute.
    for (let pr = 0; pr < pivots.length; pr++) {
      const pc = pivots[pr]
      if (R[pr][f] & 1) v[pc] ^= 1
    }
    basis.push(v)
  }
  return basis
}

/** Hamming weight (number of 1s) of a bit vector. */
export function bitWeight(v: number[]): number {
  let w = 0
  for (const b of v) w += b & 1
  return w
}

/** Hamming distance between two equal-length bit vectors. */
export function bitDistance(a: number[], b: number[]): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += (a[i] ^ b[i]) & 1
  return d
}

// ======================================================================
//  Part 2 — GF(2^8) = GF(256) field arithmetic
// ======================================================================

/**
 * A GF(2^m) field built from a primitive polynomial. Exposes exp/log tables so
 * multiply/divide/inverse are O(1). Reed–Solomon uses GF(256) with 0x11D; the
 * Hamming family can use smaller fields (GF(8), GF(16)) via the same class.
 */
export class GF {
  readonly m: number
  readonly size: number // 2^m
  readonly order: number // size − 1 (the multiplicative group order)
  readonly prim: number
  readonly generator: number
  readonly exp: Uint16Array // exp[i] = generator^i, length 2·order for wrap-free multiply
  readonly log: Uint16Array // log[x] = i s.t. generator^i = x; log[0] unused

  constructor(m = 8, prim = 0x11d, generator = 2) {
    this.m = m
    this.size = 1 << m
    this.order = this.size - 1
    this.prim = prim
    this.generator = generator
    this.exp = new Uint16Array(2 * this.order)
    this.log = new Uint16Array(this.size)
    let x = 1
    for (let i = 0; i < this.order; i++) {
      this.exp[i] = x
      this.log[x] = i
      // Multiply x by the generator (α), reducing mod prim when it overflows m bits.
      x <<= 1
      if (x & this.size) x ^= prim
    }
    // Duplicate the table so exp[i + order] is valid for i in [0, order) — this
    // lets multiply add logs without a modulo on the fast path.
    for (let i = this.order; i < 2 * this.order; i++) this.exp[i] = this.exp[i - this.order]
    this.log[0] = 0 // sentinel; never read for a real product
  }

  /** Field multiplication a·b. */
  mul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0
    return this.exp[this.log[a] + this.log[b]]
  }

  /** Field division a/b (b ≠ 0). */
  div(a: number, b: number): number {
    if (a === 0) return 0
    // log[a] − log[b] can be negative; add `order` to keep the index in range.
    return this.exp[this.log[a] + this.order - this.log[b]]
  }

  /** Multiplicative inverse 1/a. */
  inv(a: number): number {
    return this.exp[this.order - this.log[a]]
  }

  /** a raised to an integer power (handles negative exponents). */
  pow(a: number, n: number): number {
    if (a === 0) return n === 0 ? 1 : 0
    let e = (this.log[a] * n) % this.order
    if (e < 0) e += this.order
    return this.exp[e]
  }

  /** α^i, the i-th power of the field generator. */
  alpha(i: number): number {
    let e = i % this.order
    if (e < 0) e += this.order
    return this.exp[e]
  }
}

// A shared GF(256) — the Reed–Solomon / QR field. Constructed once.
export const GF256 = new GF(8, 0x11d, 2)

// ======================================================================
//  Part 3 — polynomials over GF(2^m) (Reed–Solomon works in this ring)
// ======================================================================
//
// A polynomial is a plain number[] of coefficients, HIGHEST degree FIRST
// (poly[0] is the leading coefficient) — the convention that makes synthetic
// division read naturally. All arithmetic is over the supplied field.

/** Evaluate p(x) at a field element via Horner's rule. */
export function polyEval(gf: GF, p: number[], x: number): number {
  let y = 0
  for (const c of p) y = gf.mul(y, x) ^ c
  return y
}

/** Add two polynomials (XOR of coefficients, degree-aligned at the low end). */
export function polyAdd(p: number[], q: number[]): number[] {
  const n = Math.max(p.length, q.length)
  const out = new Array(n).fill(0)
  for (let i = 0; i < p.length; i++) out[i + (n - p.length)] ^= p[i]
  for (let i = 0; i < q.length; i++) out[i + (n - q.length)] ^= q[i]
  return out
}

/** Multiply a polynomial by a scalar field element. */
export function polyScale(gf: GF, p: number[], s: number): number[] {
  return p.map((c) => gf.mul(c, s))
}

/** Multiply two polynomials over the field. */
export function polyMul(gf: GF, p: number[], q: number[]): number[] {
  const out = new Array(p.length + q.length - 1).fill(0)
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue
    for (let j = 0; j < q.length; j++) out[i + j] ^= gf.mul(p[i], q[j])
  }
  return out
}

/** Strip leading zero coefficients (keep at least one term). */
export function polyTrim(p: number[]): number[] {
  let i = 0
  while (i < p.length - 1 && p[i] === 0) i++
  return p.slice(i)
}

/**
 * Polynomial division: returns quotient and remainder such that
 * dividend = quotient·divisor + remainder, all over the field.
 */
export function polyDivMod(gf: GF, dividend: number[], divisor: number[]): { q: number[]; r: number[] } {
  const out = dividend.slice()
  const dLead = divisor[0]
  const sep = out.length - (divisor.length - 1)
  for (let i = 0; i < sep; i++) {
    const coef = out[i]
    if (coef !== 0) {
      const factor = gf.div(coef, dLead)
      out[i] = factor
      for (let j = 1; j < divisor.length; j++) {
        out[i + j] ^= gf.mul(divisor[j], factor)
      }
    }
  }
  const q = out.slice(0, sep)
  const r = polyTrim(out.slice(sep))
  return { q: q.length ? q : [0], r }
}

/** Formal derivative of a polynomial over GF(2^m): even-index (from the low end)
 * terms survive, odd ones vanish (since 2 = 0 in characteristic 2). */
export function polyDeriv(p: number[]): number[] {
  // With highest-degree-first storage, term at position i has degree deg−i.
  const deg = p.length - 1
  const out: number[] = []
  for (let i = 0; i < p.length; i++) {
    const d = deg - i
    if (d === 0) break
    out.push(d & 1 ? p[i] : 0) // multiply by d: only odd d survives in char 2
  }
  return out.length ? out : [0]
}
