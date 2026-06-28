// A second curve, a different shape: Curve25519, the workhorse behind modern
// TLS, SSH, Signal, and WireGuard. Same big idea as secp256k1 — a group law on
// an elliptic curve over a prime field — but two deliberate engineering choices
// set it apart:
//
//   • X25519 (RFC 7748) does key exchange on the *Montgomery* form using only
//     x-coordinates and a constant-time ladder — no point addition, no branches
//     on secret data.
//   • Ed25519 (RFC 8032) signs on the birationally-equivalent *twisted Edwards*
//     form, whose addition law is complete (one formula, no special cases) and
//     uses SHA-512 instead of SHA-256.
//
// Both are implemented here from scratch on BigInt and validated against the
// official RFC test vectors on the Self-Test page.

import { mod, modInv, modPow } from './field'
import { sha512 } from './sha512'

// Shared field prime p = 2^255 − 19.
export const P25519 = (1n << 255n) - 19n
// Group order of the prime-order subgroup (used to reduce scalars in EdDSA).
export const L25519 = (1n << 252n) + 27742317777372353535851937790883648493n

const fmod = (a: bigint): bigint => mod(a, P25519)
const finv = (a: bigint): bigint => modInv(a, P25519)

// ── X25519 (Montgomery ladder, RFC 7748) ─────────────────────────────────────
// Curve: v² = u³ + 486662·u² + u. We never need v: the ladder works purely on u,
// which is exactly why it is fast and easy to make constant-time.

const A24 = 121665n // (486662 − 2) / 4

function decodeLittleEndian(b: Uint8Array): bigint {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}

function encodeLittleEndian(n: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len)
  let v = n
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** Clamp a 32-byte scalar per RFC 7748: clear the low 3 bits, set bit 254,
 *  clear bit 255. This forces the scalar into the prime-order subgroup and
 *  fixes its bit length, both for security and for ladder regularity. */
export function clampScalar(k: Uint8Array): bigint {
  const c = k.slice(0, 32)
  c[0] &= 248
  c[31] &= 127
  c[31] |= 64
  return decodeLittleEndian(c)
}

/** The X25519 scalar multiplication: given a clamped scalar and a u-coordinate,
 *  return the resulting u-coordinate. This is the whole primitive. */
export function x25519(scalar: Uint8Array, uBytes: Uint8Array): Uint8Array {
  const k = clampScalar(scalar)
  const u = mod(decodeLittleEndian(uBytes) & ((1n << 255n) - 1n), P25519)

  const x1 = u
  let x2 = 1n
  let z2 = 0n
  let x3 = u
  let z3 = 1n
  let swap = 0n

  for (let t = 254; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n
    swap ^= kt
    if (swap === 1n) {
      ;[x2, x3] = [x3, x2]
      ;[z2, z3] = [z3, z2]
    }
    swap = kt

    const aa = fmod(x2 + z2)
    const bb = fmod(x2 - z2)
    const cc = fmod(x3 + z3)
    const d = fmod(x3 - z3)
    const da = fmod(d * aa)
    const cb = fmod(cc * bb)
    x3 = fmod((da + cb) * (da + cb))
    z3 = fmod(x1 * fmod((da - cb) * (da - cb)))
    const aa2 = fmod(aa * aa)
    const bb2 = fmod(bb * bb)
    x2 = fmod(aa2 * bb2)
    const e = fmod(aa2 - bb2)
    z2 = fmod(e * (aa2 + fmod(A24 * e)))
  }
  // Final conditional swap, selecting (not writing back) so there is no dead
  // store on the no-swap path.
  const rx = swap === 1n ? x3 : x2
  const rz = swap === 1n ? z3 : z2
  const result = fmod(rx * modPow(rz, P25519 - 2n, P25519))
  return encodeLittleEndian(result)
}

/** The X25519 base point u = 9. */
export const X25519_BASE = encodeLittleEndian(9n)

/** Public key for an X25519 private scalar: x25519(sk, 9). */
export function x25519Public(sk: Uint8Array): Uint8Array {
  return x25519(sk, X25519_BASE)
}

// ── Ed25519 (twisted Edwards, RFC 8032) ──────────────────────────────────────
// Curve: −x² + y² = 1 + d·x²·y², with d = −121665/121666. Points are stored in
// extended coordinates (X:Y:Z:T) so addition is a single complete formula.

const D = fmod(-121665n * finv(121666n))
// √(−1) mod p, used when recovering x from y during point decompression.
const SQRT_M1 = modPow(2n, (P25519 - 1n) / 4n, P25519)

interface Ed {
  X: bigint
  Y: bigint
  Z: bigint
  T: bigint
}

function edAdd(p: Ed, q: Ed): Ed {
  const a = fmod((p.Y - p.X) * (q.Y - q.X))
  const b = fmod((p.Y + p.X) * (q.Y + q.X))
  const c = fmod(2n * p.T * q.T * D)
  const d = fmod(2n * p.Z * q.Z)
  const e = b - a
  const f = d - c
  const g = d + c
  const h = b + a
  return { X: fmod(e * f), Y: fmod(g * h), Z: fmod(f * g), T: fmod(e * h) }
}

function edDouble(p: Ed): Ed {
  return edAdd(p, p)
}

function edScalarMul(k: bigint, p: Ed): Ed {
  let r: Ed = { X: 0n, Y: 1n, Z: 1n, T: 0n } // identity
  let base = p
  let n = k
  while (n > 0n) {
    if (n & 1n) r = edAdd(r, base)
    base = edDouble(base)
    n >>= 1n
  }
  return r
}

// The Ed25519 base point B.
const BY = fmod(4n * finv(5n))
const BX = recoverX(BY, 0n)!
const B: Ed = { X: BX, Y: BY, Z: 1n, T: fmod(BX * BY) }

// Recover the x-coordinate of an Edwards point from y and the sign bit.
function recoverX(y: bigint, sign: bigint): bigint | null {
  const y2 = fmod(y * y)
  const u = fmod(y2 - 1n)
  const v = fmod(D * y2 + 1n)
  // x = u·v³·(u·v⁷)^((p−5)/8), then fix up by √−1.
  const v3 = fmod(v * v * v)
  const v7 = fmod(v3 * v3 * v)
  let x = fmod(u * v3 * modPow(fmod(u * v7), (P25519 - 5n) / 8n, P25519))
  const check = fmod(v * x * x)
  if (check === fmod(u)) {
    // ok
  } else if (check === fmod(-u)) {
    x = fmod(x * SQRT_M1)
  } else {
    return null
  }
  if (x === 0n && sign === 1n) return null
  if ((x & 1n) !== sign) x = fmod(-x)
  return x
}

function encodePoint(p: Ed): Uint8Array {
  const zInv = finv(p.Z)
  const x = fmod(p.X * zInv)
  const y = fmod(p.Y * zInv)
  const out = encodeLittleEndian(y)
  out[31] |= Number(x & 1n) << 7 // store x's sign in the top bit
  return out
}

function decodePoint(b: Uint8Array): Ed | null {
  const sign = BigInt((b[31] >> 7) & 1)
  const y = decodeLittleEndian(b) & ((1n << 255n) - 1n)
  if (y >= P25519) return null
  const x = recoverX(y, sign)
  if (x === null) return null
  return { X: x, Y: y, Z: 1n, T: fmod(x * y) }
}

const hashToScalar = (b: Uint8Array): bigint => mod(decodeLittleEndian(sha512(b)), L25519)

/** Derive a 32-byte Ed25519 public key from a 32-byte seed (RFC 8032 §5.1.5). */
export function ed25519Public(seed: Uint8Array): Uint8Array {
  const h = sha512(seed.slice(0, 32))
  const a = clampEd(h.slice(0, 32))
  return encodePoint(edScalarMul(a, B))
}

function clampEd(h: Uint8Array): bigint {
  const a = h.slice(0, 32)
  a[0] &= 248
  a[31] &= 127
  a[31] |= 64
  return decodeLittleEndian(a)
}

/** Ed25519 signature over `msg` with a 32-byte seed → 64 bytes (R ‖ S). */
export function ed25519Sign(seed: Uint8Array, msg: Uint8Array): Uint8Array {
  const h = sha512(seed.slice(0, 32))
  const a = clampEd(h.slice(0, 32))
  const prefix = h.slice(32, 64)
  const A = encodePoint(edScalarMul(a, B))

  const r = hashToScalar(cat(prefix, msg))
  const R = encodePoint(edScalarMul(r, B))
  const k = hashToScalar(cat(R, A, msg))
  const S = mod(r + k * a, L25519)

  const sig = new Uint8Array(64)
  sig.set(R, 0)
  sig.set(encodeLittleEndian(S), 32)
  return sig
}

/** Verify an Ed25519 signature: [S]B == R + [k]A, computed via the cofactor-8
 *  group equation 8·([S]B) == 8·R + 8·[k]A as in the RFC's permissive check. */
export function ed25519Verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64 || pub.length !== 32) return false
  const A = decodePoint(pub)
  if (A === null) return false
  const Rbytes = sig.slice(0, 32)
  const R = decodePoint(Rbytes)
  if (R === null) return false
  const S = decodeLittleEndian(sig.slice(32, 64))
  if (S >= L25519) return false

  const k = hashToScalar(cat(Rbytes, pub, msg))
  // Check [8][S]B == [8]R + [8][k]A.
  const lhs = edScalarMul(8n, edScalarMul(S, B))
  const rhs = edScalarMul(8n, edAdd(R, edScalarMul(k, A)))
  return edEqual(lhs, rhs)
}

function edEqual(p: Ed, q: Ed): boolean {
  // Compare in affine: X1·Z2 == X2·Z1 and Y1·Z2 == Y2·Z1.
  return (
    fmod(p.X * q.Z - q.X * p.Z) === 0n && fmod(p.Y * q.Z - q.Y * p.Z) === 0n
  )
}

function cat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

// Small helpers the page reuses for display / interop.
export { encodeLittleEndian, decodeLittleEndian }
