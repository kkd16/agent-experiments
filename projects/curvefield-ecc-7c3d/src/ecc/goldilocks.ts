// The Goldilocks field 𝔽_p with p = 2^64 − 2^32 + 1, and the number-theoretic
// transform (NTT) that lives on it.
//
// Every other file in the lab computes over the *elliptic-curve* fields — the
// 256-bit secp256k1 prime, or the BLS12-381 tower. Those are chosen so a curve
// with the right structure exists. STARKs need something different: a prime
// whose multiplicative group has a large power-of-two subgroup, so a fast
// Fourier transform (the NTT) exists for polynomial interpolation and low-degree
// extension. Goldilocks is the canonical choice — it is used by Plonky2,
// Winterfell, Miden and Risc0.
//
//   p − 1 = 2^64 − 2^32 = 2^32 · (2^32 − 1) = 2^32 · 3 · 5 · 17 · 257 · 65537.
//
// So the field has a cyclic subgroup of order 2^32: for any power-of-two n up to
// 2^32 there is a primitive n-th root of unity, and the NTT interpolates n
// samples in O(n log n) field operations. Everything here is exact BigInt.

/** The Goldilocks prime p = 2^64 − 2^32 + 1. */
export const P = 0xffffffff00000001n

/** A multiplicative generator of 𝔽_p^× (order p − 1). Verified in the self-test. */
export const GENERATOR = 7n

/** Two-adicity: p − 1 is divisible by 2^32, so NTTs exist up to size 2^32. */
export const TWO_ADICITY = 32

/** Non-negative reduction mod p. */
export function fp(a: bigint): bigint {
  const r = a % P
  return r < 0n ? r + P : r
}

export function add(a: bigint, b: bigint): bigint {
  const s = a + b
  return s >= P ? s - P : s
}

export function sub(a: bigint, b: bigint): bigint {
  const d = a - b
  return d < 0n ? d + P : d
}

export function neg(a: bigint): bigint {
  return a === 0n ? 0n : P - a
}

export function mul(a: bigint, b: bigint): bigint {
  return (a * b) % P
}

/** b^e mod p by square-and-multiply (e is an ordinary bigint exponent). */
export function pow(b: bigint, e: bigint): bigint {
  if (e < 0n) return pow(inv(b), -e)
  let base = fp(b)
  let exp = e
  let acc = 1n
  while (exp > 0n) {
    if (exp & 1n) acc = (acc * base) % P
    base = (base * base) % P
    exp >>= 1n
  }
  return acc
}

/** Multiplicative inverse via Fermat: a^(p−2). Throws on 0. */
export function inv(a: bigint): bigint {
  const x = fp(a)
  if (x === 0n) throw new Error('goldilocks: inverse of 0')
  return pow(x, P - 2n)
}

/** Batch inverse (Montgomery's trick): one inversion for the whole array. */
export function batchInv(xs: bigint[]): bigint[] {
  const n = xs.length
  const out = new Array<bigint>(n).fill(0n)
  const prefix = new Array<bigint>(n)
  let acc = 1n
  for (let i = 0; i < n; i++) {
    prefix[i] = acc
    if (xs[i] !== 0n) acc = (acc * xs[i]) % P
  }
  let invAcc = inv(acc)
  for (let i = n - 1; i >= 0; i--) {
    if (xs[i] === 0n) continue
    out[i] = (prefix[i] * invAcc) % P
    invAcc = (invAcc * xs[i]) % P
  }
  return out
}

/**
 * A primitive n-th root of unity, for n a power of two dividing 2^32.
 * ω = g^((p−1)/n) has order exactly n because g generates the whole group.
 */
export function rootOfUnity(n: number): bigint {
  if (n <= 0 || (n & (n - 1)) !== 0) throw new Error('rootOfUnity: n must be a power of two')
  const log = Math.log2(n)
  if (log > TWO_ADICITY) throw new Error('rootOfUnity: n exceeds 2^32')
  return pow(GENERATOR, (P - 1n) / BigInt(n))
}

/** The cyclic subgroup ⟨ω⟩ of size n as an explicit array [1, ω, ω², …]. */
export function subgroup(n: number): bigint[] {
  const w = rootOfUnity(n)
  const out = new Array<bigint>(n)
  let cur = 1n
  for (let i = 0; i < n; i++) {
    out[i] = cur
    cur = (cur * w) % P
  }
  return out
}

function bitReverse(a: bigint[]): void {
  const n = a.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const t = a[i]
      a[i] = a[j]
      a[j] = t
    }
  }
}

/**
 * In-place iterative radix-2 NTT (Cooley–Tukey). `invert` runs the inverse
 * transform (conjugate root + 1/n scaling). Input length must be a power of two.
 */
function nttInPlace(a: bigint[], invert: boolean): void {
  const n = a.length
  if ((n & (n - 1)) !== 0) throw new Error('ntt: length must be a power of two')
  bitReverse(a)
  const base = invert ? inv(rootOfUnity(n)) : rootOfUnity(n)
  for (let len = 2; len <= n; len <<= 1) {
    // w_len is a primitive len-th root: base^(n/len).
    const wlen = pow(base, BigInt(n / len))
    for (let i = 0; i < n; i += len) {
      let w = 1n
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const u = a[i + k]
        const v = (a[i + k + half] * w) % P
        a[i + k] = u + v >= P ? u + v - P : u + v
        a[i + k + half] = u - v < 0n ? u - v + P : u - v
        w = (w * wlen) % P
      }
    }
  }
  if (invert) {
    const ninv = inv(BigInt(n))
    for (let i = 0; i < n; i++) a[i] = (a[i] * ninv) % P
  }
}

/** Forward NTT: coefficients → evaluations on ⟨ω_n⟩. Returns a fresh array. */
export function ntt(coeffs: bigint[]): bigint[] {
  const a = coeffs.map(fp)
  nttInPlace(a, false)
  return a
}

/** Inverse NTT: evaluations on ⟨ω_n⟩ → coefficients. Returns a fresh array. */
export function intt(evals: bigint[]): bigint[] {
  const a = evals.map(fp)
  nttInPlace(a, true)
  return a
}

/**
 * Evaluate a coefficient vector on the coset `offset · ⟨ω_n⟩`. We scale the
 * i-th coefficient by offset^i, then run a plain NTT — because
 * f(offset·ω^k) = Σ (cᵢ·offsetⁱ)·ω^{ik}. `size` (a power of two ≥ coeffs.length)
 * sets the output length; the coefficients are zero-padded up to it.
 */
export function cosetEval(coeffs: bigint[], offset: bigint, size: number): bigint[] {
  if ((size & (size - 1)) !== 0) throw new Error('cosetEval: size must be a power of two')
  if (coeffs.length > size) throw new Error('cosetEval: size smaller than polynomial')
  const scaled = new Array<bigint>(size).fill(0n)
  let pw = 1n
  for (let i = 0; i < coeffs.length; i++) {
    scaled[i] = (fp(coeffs[i]) * pw) % P
    pw = (pw * offset) % P
  }
  nttInPlace(scaled, false)
  return scaled
}

/** Horner evaluation of a coefficient vector at an arbitrary point x. */
export function polyEval(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n
  const xr = fp(x)
  for (let i = coeffs.length - 1; i >= 0; i--) {
    acc = (acc * xr + coeffs[i]) % P
  }
  return acc
}

/** Trim trailing zero coefficients (returns [0] for the zero polynomial). */
export function polyTrim(coeffs: bigint[]): bigint[] {
  let d = coeffs.length - 1
  while (d > 0 && fp(coeffs[d]) === 0n) d--
  return coeffs.slice(0, d + 1).map(fp)
}

/** Degree of a coefficient vector (−∞ ↦ −1 for the zero polynomial). */
export function polyDegree(coeffs: bigint[]): number {
  const t = polyTrim(coeffs)
  return t.length === 1 && t[0] === 0n ? -1 : t.length - 1
}
