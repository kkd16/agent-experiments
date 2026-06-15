// Word-level bit-vector circuits, built on the gate-level Blaster. A bit-vector
// is a `Bits` — an array of literals, **LSB first** (bit i has weight 2ⁱ). Every
// function here is a from-scratch hardware construction: ripple-carry adders, a
// shift-add multiplier, restoring division, barrel shifters, and unsigned/signed
// comparators. Together they cover the SMT-LIB `QF_BV` operator set exactly,
// including its corner cases (division by zero, over-wide shifts, signedness).

import { Blaster, type Lit } from './bits'

export type Bits = Lit[] // LSB-first, length === width

// ---- constants & helpers -----------------------------------------------------
export function constBits(B: Blaster, value: bigint, width: number): Bits {
  const mask = (1n << BigInt(width)) - 1n
  const v = ((value % (1n << BigInt(width))) + (1n << BigInt(width))) % (1n << BigInt(width))
  void mask
  const out: Bits = []
  for (let i = 0; i < width; i++) out.push((v >> BigInt(i)) & 1n ? B.TRUE : B.FALSE)
  return out
}

export function freshBits(B: Blaster, width: number): Bits {
  const out: Bits = []
  for (let i = 0; i < width; i++) out.push(B.newVar())
  return out
}

// ---- bitwise -----------------------------------------------------------------
export const bvnot = (B: Blaster, a: Bits): Bits => a.map((x) => B.not(x))
export const bvand = (B: Blaster, a: Bits, b: Bits): Bits => a.map((x, i) => B.and(x, b[i]))
export const bvor = (B: Blaster, a: Bits, b: Bits): Bits => a.map((x, i) => B.or(x, b[i]))
export const bvxor = (B: Blaster, a: Bits, b: Bits): Bits => a.map((x, i) => B.xor(x, b[i]))
export const bvnand = (B: Blaster, a: Bits, b: Bits): Bits => bvnot(B, bvand(B, a, b))
export const bvnor = (B: Blaster, a: Bits, b: Bits): Bits => bvnot(B, bvor(B, a, b))
export const bvxnor = (B: Blaster, a: Bits, b: Bits): Bits => a.map((x, i) => B.iff(x, b[i]))

// ---- full adder & ripple-carry adder ----------------------------------------
function fullAdder(B: Blaster, a: Lit, b: Lit, cin: Lit): { sum: Lit; cout: Lit } {
  const axb = B.xor(a, b)
  const sum = B.xor(axb, cin)
  // cout = majority(a,b,cin) = (a∧b) ∨ (cin ∧ (a⊕b))
  const cout = B.or(B.and(a, b), B.and(cin, axb))
  return { sum, cout }
}

/** Ripple-carry add with an incoming carry; returns the width-bit sum + carry-out. */
export function addWithCarry(B: Blaster, a: Bits, b: Bits, cin: Lit): { sum: Bits; cout: Lit } {
  const sum: Bits = []
  let carry = cin
  for (let i = 0; i < a.length; i++) {
    const fa = fullAdder(B, a[i], b[i], carry)
    sum.push(fa.sum)
    carry = fa.cout
  }
  return { sum, cout: carry }
}

export const bvadd = (B: Blaster, a: Bits, b: Bits): Bits => addWithCarry(B, a, b, B.FALSE).sum

/** a − b = a + ¬b + 1; carry-out is 1 iff a ≥ b (no borrow). */
export function subWithBorrow(B: Blaster, a: Bits, b: Bits): { diff: Bits; noBorrow: Lit } {
  const { sum, cout } = addWithCarry(B, a, bvnot(B, b), B.TRUE)
  return { diff: sum, noBorrow: cout }
}
export const bvsub = (B: Blaster, a: Bits, b: Bits): Bits => subWithBorrow(B, a, b).diff
export const bvneg = (B: Blaster, a: Bits): Bits => bvadd(B, bvnot(B, a), constBits(B, 1n, a.length))

// ---- equality & comparators --------------------------------------------------
export function eqBits(B: Blaster, a: Bits, b: Bits): Lit {
  let acc = B.TRUE
  for (let i = 0; i < a.length; i++) acc = B.and(acc, B.iff(a[i], b[i]))
  return acc
}

/** Unsigned a < b via the borrow out of (a − b). */
export function ult(B: Blaster, a: Bits, b: Bits): Lit {
  return B.not(subWithBorrow(B, a, b).noBorrow) // borrow ⇒ a < b
}
export const ule = (B: Blaster, a: Bits, b: Bits): Lit => B.not(ult(B, b, a))

/** Signed a < b: flip the most-significant (sign) bit and compare unsigned. */
export function slt(B: Blaster, a: Bits, b: Bits): Lit {
  const n = a.length
  const af = [...a.slice(0, n - 1), B.not(a[n - 1])]
  const bf = [...b.slice(0, n - 1), B.not(b[n - 1])]
  return ult(B, af, bf)
}
export const sle = (B: Blaster, a: Bits, b: Bits): Lit => B.not(slt(B, b, a))

/** 1-bit result: #b1 iff a == b (bvcomp). */
export const bvcomp = (B: Blaster, a: Bits, b: Bits): Bits => [eqBits(B, a, b)]

// ---- shifts (barrel shifter; handles shift amounts ≥ width) ------------------
export function shl(B: Blaster, a: Bits, amt: Bits): Bits {
  const n = a.length
  let cur = a.slice()
  for (let i = 0; i < amt.length; i++) {
    const shift = 1 << i
    const shifted: Bits = []
    for (let j = 0; j < n; j++) shifted.push(shift > j ? B.FALSE : cur[j - shift] ?? B.FALSE)
    // when 2ⁱ ≥ width, shifting by it (if selected) zeroes everything
    cur = cur.map((c, j) => B.mux(amt[i], shifted[j], c))
  }
  return cur
}

export function lshr(B: Blaster, a: Bits, amt: Bits): Bits {
  const n = a.length
  let cur = a.slice()
  for (let i = 0; i < amt.length; i++) {
    const shift = 1 << i
    const shifted: Bits = []
    for (let j = 0; j < n; j++) shifted.push(j + shift < n ? cur[j + shift] : B.FALSE)
    cur = cur.map((c, j) => B.mux(amt[i], shifted[j], c))
  }
  return cur
}

export function ashr(B: Blaster, a: Bits, amt: Bits): Bits {
  const n = a.length
  const sign = a[n - 1]
  let cur = a.slice()
  for (let i = 0; i < amt.length; i++) {
    const shift = 1 << i
    const shifted: Bits = []
    for (let j = 0; j < n; j++) shifted.push(j + shift < n ? cur[j + shift] : sign)
    cur = cur.map((c, j) => B.mux(amt[i], shifted[j], c))
  }
  return cur
}

// ---- multiply (shift-and-add) ------------------------------------------------
export function bvmul(B: Blaster, a: Bits, b: Bits): Bits {
  const n = a.length
  let acc = constBits(B, 0n, n)
  for (let i = 0; i < n; i++) {
    // partial product: (a << i) gated by b[i], truncated to n bits
    const pp: Bits = []
    for (let j = 0; j < n; j++) pp.push(j >= i ? B.and(b[i], a[j - i]) : B.FALSE)
    acc = bvadd(B, acc, pp)
  }
  return acc
}

// ---- unsigned divide / remainder (restoring division) ------------------------
// Returns the SMT-LIB results directly, including the divisor-zero conventions:
// bvudiv by 0 = all-ones, bvurem by 0 = the dividend.
export function udivurem(B: Blaster, a: Bits, b: Bits): { q: Bits; r: Bits } {
  const n = a.length
  // Work with an (n+1)-bit running remainder so (R<<1)|bit never overflows.
  let rem: Bits = constBits(B, 0n, n + 1)
  const bExt = [...b, B.FALSE] // n+1 bits
  const q: Bits = new Array(n).fill(B.FALSE)
  for (let i = n - 1; i >= 0; i--) {
    // rem = (rem << 1) | a[i]
    rem = [a[i], ...rem.slice(0, n)]
    const { diff, noBorrow } = subWithBorrow(B, rem, bExt) // rem − b ; ge = noBorrow
    const ge = noBorrow
    q[i] = ge
    rem = rem.map((bit, j) => B.mux(ge, diff[j], bit))
  }
  const r = rem.slice(0, n)
  // divisor == 0 conventions
  const bZero = eqBits(B, b, constBits(B, 0n, n))
  const allOnes = constBits(B, (1n << BigInt(n)) - 1n, n)
  const qOut = q.map((bit, j) => B.mux(bZero, allOnes[j], bit))
  const rOut = r.map((bit, j) => B.mux(bZero, a[j], bit))
  return { q: qOut, r: rOut }
}

// ---- signed divide / remainder / modulo (SMT-LIB definitions) ----------------
function absBits(B: Blaster, a: Bits): Bits {
  const sign = a[a.length - 1]
  const neg = bvneg(B, a)
  return a.map((bit, j) => B.mux(sign, neg[j], bit))
}

export function bvsdiv(B: Blaster, a: Bits, b: Bits): Bits {
  const sa = a[a.length - 1]
  const sb = b[b.length - 1]
  const { q } = udivurem(B, absBits(B, a), absBits(B, b))
  const negate = B.xor(sa, sb)
  const nq = bvneg(B, q)
  return q.map((bit, j) => B.mux(negate, nq[j], bit))
}

export function bvsrem(B: Blaster, a: Bits, b: Bits): Bits {
  const sa = a[a.length - 1]
  const { r } = udivurem(B, absBits(B, a), absBits(B, b))
  const nr = bvneg(B, r)
  return r.map((bit, j) => B.mux(sa, nr[j], bit)) // sign follows dividend
}

export function bvsmod(B: Blaster, a: Bits, b: Bits): Bits {
  const n = a.length
  const sa = a[n - 1]
  const sb = b[n - 1]
  const { r: u } = udivurem(B, absBits(B, a), absBits(B, b))
  const uZero = eqBits(B, u, constBits(B, 0n, n))
  const negU = bvneg(B, u)
  const uPlusT = bvadd(B, u, b)
  const negUPlusT = bvadd(B, negU, b)
  // case table on (sa, sb); when u==0 the result is u (=0) regardless.
  const both0 = u // sa=0,sb=0
  const negTo0 = negUPlusT // sa=1,sb=0 → (-u)+t
  const posTo1 = uPlusT // sa=0,sb=1 → u+t
  const both1 = negU // sa=1,sb=1 → -u
  const out: Bits = []
  for (let j = 0; j < n; j++) {
    const sbCol = B.mux(sb, B.mux(sa, both1[j], posTo1[j]), B.mux(sa, negTo0[j], both0[j]))
    out.push(B.mux(uZero, u[j], sbCol))
  }
  return out
}

// ---- structural ops ----------------------------------------------------------
export const concat = (high: Bits, low: Bits): Bits => [...low, ...high] // low bits first
export const extract = (a: Bits, hi: number, lo: number): Bits => a.slice(lo, hi + 1)
export const zeroExtend = (B: Blaster, a: Bits, by: number): Bits => [...a, ...new Array(by).fill(B.FALSE)]
export const signExtend = (a: Bits, by: number): Bits => [...a, ...new Array(by).fill(a[a.length - 1])]

export function repeat(a: Bits, times: number): Bits {
  const out: Bits = []
  for (let k = 0; k < times; k++) out.push(...a)
  return out
}

export function rotateLeft(a: Bits, amount: number): Bits {
  const n = a.length
  const k = ((amount % n) + n) % n
  const out: Bits = []
  for (let j = 0; j < n; j++) out.push(a[(j - k + n) % n])
  return out
}
export function rotateRight(a: Bits, amount: number): Bits {
  return rotateLeft(a, a.length - (((amount % a.length) + a.length) % a.length))
}
