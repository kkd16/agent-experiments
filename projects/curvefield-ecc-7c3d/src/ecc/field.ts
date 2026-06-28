// Modular arithmetic over a prime field F_p, on native BigInt.
//
// Everything downstream — curve points, scalar multiplication, ECDSA, Schnorr —
// rests on these few operations. They are written to be correct for any prime p,
// from the toy p = 97 used in the visual labs up to the 256-bit secp256k1 prime.

/** Non-negative remainder: result is always in [0, m), even for negative a. */
export function mod(a: bigint, m: bigint): bigint {
  const r = a % m
  return r < 0n ? r + m : r
}

/** Modular exponentiation b^e mod m by square-and-multiply. e may be large. */
export function modPow(b: bigint, e: bigint, m: bigint): bigint {
  if (m === 1n) return 0n
  let base = mod(b, m)
  let exp = e
  let result = 1n
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m
    base = (base * base) % m
    exp >>= 1n
  }
  return result
}

/**
 * Modular inverse via the extended Euclidean algorithm: returns x with
 * a·x ≡ 1 (mod m). Throws if a is not invertible (gcd(a, m) ≠ 1), which on a
 * prime field only happens for a ≡ 0.
 */
export function modInv(a: bigint, m: bigint): bigint {
  let [oldR, r] = [mod(a, m), m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  if (oldR !== 1n) throw new Error(`${a} has no inverse modulo ${m}`)
  return mod(oldS, m)
}

/** Legendre symbol (a|p): 1 if a is a non-zero quadratic residue, -1 if not, 0 if a≡0. */
export function legendre(a: bigint, p: bigint): number {
  const ls = modPow(a, (p - 1n) / 2n, p)
  if (ls === 0n) return 0
  return ls === 1n ? 1 : -1
}

/** True iff a is a quadratic residue mod p (i.e. has a square root). */
export function isSquare(a: bigint, p: bigint): boolean {
  return legendre(mod(a, p), p) >= 0
}

/**
 * Modular square root via Tonelli–Shanks: returns r with r² ≡ a (mod p), or
 * null if a is a non-residue. The other root is p − r. Handles the common
 * p ≡ 3 (mod 4) fast path and the general case.
 */
export function modSqrt(a: bigint, p: bigint): bigint | null {
  a = mod(a, p)
  if (a === 0n) return 0n
  if (p === 2n) return a
  if (legendre(a, p) !== 1) return null

  // Fast path: p ≡ 3 (mod 4) ⇒ r = a^((p+1)/4).
  if (p % 4n === 3n) return modPow(a, (p + 1n) / 4n, p)

  // General Tonelli–Shanks. Write p − 1 = q·2^s with q odd.
  let q = p - 1n
  let s = 0n
  while (q % 2n === 0n) {
    q /= 2n
    s++
  }

  // Find a quadratic non-residue z.
  let z = 2n
  while (legendre(z, p) !== -1) z++

  let m = s
  let c = modPow(z, q, p)
  let t = modPow(a, q, p)
  let r = modPow(a, (q + 1n) / 2n, p)

  while (t !== 1n) {
    // Find the least i, 0 < i < m, with t^(2^i) = 1.
    let i = 0n
    let t2 = t
    while (t2 !== 1n) {
      t2 = (t2 * t2) % p
      i++
      if (i === m) return null
    }
    const b = modPow(c, modPow(2n, m - i - 1n, p - 1n), p)
    m = i
    c = (b * b) % p
    t = (t * c) % p
    r = (r * b) % p
  }
  return r
}

/** gcd via Euclid, on BigInt. */
export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) [a, b] = [b, a % b]
  return a
}
