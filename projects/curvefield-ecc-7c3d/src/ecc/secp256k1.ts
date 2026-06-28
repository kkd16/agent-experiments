// secp256k1 — the curve behind Bitcoin and countless other systems — with a
// real cryptosystem on top: key generation, ECDH, RFC 6979 deterministic ECDSA,
// and BIP-340 Schnorr. All of it is the same group law from curve.ts, just with
// 256-bit parameters and a hash to bind messages to signatures.

import { Curve, type Point } from './curve'
import { mod, modInv, modPow } from './field'
import {
  sha256,
  hmacSha256,
  concat,
  bigToBytes,
  bytesToBig,
  utf8,
} from './sha256'

// ── Curve parameters ────────────────────────────────────────────────────────
export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
export const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
export const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n

export const secp256k1 = new Curve(0n, 7n, P)
secp256k1.order = N
export const G: Point = { x: Gx, y: Gy }

/** Public key (a curve point) from a private scalar d ∈ [1, n). */
export function publicKey(d: bigint): Point {
  return secp256k1.multiply(d, G)
}

/** ECDH shared secret: the x-coordinate of d_self · Q_other. */
export function ecdh(dSelf: bigint, qOther: Point): bigint {
  const s = secp256k1.multiply(dSelf, qOther)
  if (s === null) throw new Error('ECDH produced the identity — invalid key')
  return s.x
}

// ── RFC 6979: deterministic nonces ──────────────────────────────────────────
// A fixed, attacker-known function of (private key, message hash). Removes the
// catastrophic failure mode of ECDSA — a repeated or biased k leaks the key —
// while keeping signatures reproducible. Same key + message ⇒ same signature.

function bits2int(b: Uint8Array, qlen: number): bigint {
  let v = bytesToBig(b)
  const blen = b.length * 8
  if (blen > qlen) v >>= BigInt(blen - qlen)
  return v
}

function rfc6979Nonce(d: bigint, hash: Uint8Array, n: bigint): bigint {
  const qlen = n.toString(2).length
  const rlen = (qlen + 7) >> 3
  const int2octets = (x: bigint) => bigToBytes(x, rlen)
  const bits2octets = (b: Uint8Array) => int2octets(mod(bits2int(b, qlen), n))

  const h1 = bits2octets(hash)
  const x = int2octets(d)

  let V: Uint8Array = new Uint8Array(32).fill(0x01)
  let K: Uint8Array = new Uint8Array(32).fill(0x00)
  K = hmacSha256(K, concat(V, new Uint8Array([0x00]), x, h1))
  V = hmacSha256(K, V)
  K = hmacSha256(K, concat(V, new Uint8Array([0x01]), x, h1))
  V = hmacSha256(K, V)

  for (;;) {
    V = hmacSha256(K, V)
    const k = bits2int(V, qlen)
    if (k >= 1n && k < n) return k
    K = hmacSha256(K, concat(V, new Uint8Array([0x00])))
    V = hmacSha256(K, V)
  }
}

// ── ECDSA ───────────────────────────────────────────────────────────────────
export interface EcdsaSig {
  r: bigint
  s: bigint
}

/** Sign the SHA-256 hash of `msg` with private key d (deterministic, low-s). */
export function ecdsaSign(d: bigint, msg: Uint8Array): EcdsaSig {
  const hash = sha256(msg)
  const z = bits2int(hash, N.toString(2).length)
  for (;;) {
    const k = rfc6979Nonce(d, hash, N)
    const R = secp256k1.multiply(k, G)
    if (R === null) continue
    const r = mod(R.x, N)
    if (r === 0n) continue
    let s = mod(modInv(k, N) * (z + r * d), N)
    if (s === 0n) continue
    if (s > N / 2n) s = N - s // low-s normalization (canonical for secp256k1)
    return { r, s }
  }
}

/** Verify an ECDSA signature of `msg` against public key Q. */
export function ecdsaVerify(Q: Point, msg: Uint8Array, sig: EcdsaSig): boolean {
  const { r, s } = sig
  if (r < 1n || r >= N || s < 1n || s >= N) return false
  if (Q === null || !secp256k1.isOnCurve(Q)) return false
  const z = bits2int(sha256(msg), N.toString(2).length)
  const w = modInv(s, N)
  const u1 = mod(z * w, N)
  const u2 = mod(r * w, N)
  const X = secp256k1.add(secp256k1.multiply(u1, G), secp256k1.multiply(u2, Q))
  if (X === null) return false
  return mod(X.x, N) === r
}

// ── BIP-340 Schnorr ─────────────────────────────────────────────────────────
// x-only public keys (the y-coordinate is taken even by convention) and tagged
// hashes that domain-separate every use of SHA-256. Linear in the secret, so it
// supports clean key/signature aggregation — the reason Bitcoin adopted it.

const tagCache = new Map<string, Uint8Array>()
export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  let th = tagCache.get(tag)
  if (!th) {
    th = sha256(utf8(tag))
    tagCache.set(tag, th)
  }
  return sha256(concat(th, th, msg))
}

const hasEvenY = (pt: Point): boolean => pt !== null && pt.y % 2n === 0n

/** Lift an x-only coordinate to the point with even y (BIP-340), or null. */
export function liftXEven(x: bigint): Point {
  if (x <= 0n || x >= P) return null
  const c = mod(x * x * x + 7n, P)
  const y = modPow(c, (P + 1n) / 4n, P)
  if (mod(y * y, P) !== c) return null
  return { x, y: y % 2n === 0n ? y : P - y }
}

/** The 32-byte x-only public key for private scalar d. */
export function schnorrPubkey(d: bigint): bigint {
  const Pp = secp256k1.multiply(d, G)
  if (Pp === null) throw new Error('invalid private key')
  return Pp.x
}

/** BIP-340 sign. `aux` should be 32 random bytes; defaults to zeros. */
export function schnorrSign(
  dRaw: bigint,
  msg: Uint8Array,
  aux: Uint8Array = new Uint8Array(32),
): Uint8Array {
  if (dRaw < 1n || dRaw >= N) throw new Error('private key out of range')
  const Pp = secp256k1.multiply(dRaw, G)
  if (Pp === null) throw new Error('invalid private key')
  const d = hasEvenY(Pp) ? dRaw : N - dRaw
  const px = bigToBytes(Pp.x, 32)

  const t = bigToBytes(d, 32)
  const auxHash = taggedHash('BIP0340/aux', aux)
  const masked = new Uint8Array(32)
  for (let i = 0; i < 32; i++) masked[i] = t[i] ^ auxHash[i]

  const rand = taggedHash('BIP0340/nonce', concat(masked, px, msg))
  const kPrime = mod(bytesToBig(rand), N)
  if (kPrime === 0n) throw new Error('nonce was zero (astronomically unlikely)')
  const R = secp256k1.multiply(kPrime, G)
  if (R === null) throw new Error('R is identity')
  const k = hasEvenY(R) ? kPrime : N - kPrime
  const rx = bigToBytes(R.x, 32)

  const e = mod(bytesToBig(taggedHash('BIP0340/challenge', concat(rx, px, msg))), N)
  const sig = concat(rx, bigToBytes(mod(k + e * d, N), 32))
  return sig
}

/** BIP-340 verify: x-only pubkey, 64-byte signature, message bytes. */
export function schnorrVerify(pubX: bigint, msg: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false
  const Pp = liftXEven(pubX)
  if (Pp === null) return false
  const r = bytesToBig(sig.slice(0, 32))
  const s = bytesToBig(sig.slice(32, 64))
  if (r >= P || s >= N) return false
  const e = mod(
    bytesToBig(taggedHash('BIP0340/challenge', concat(sig.slice(0, 32), bigToBytes(pubX, 32), msg))),
    N,
  )
  const R = secp256k1.add(secp256k1.multiply(s, G), secp256k1.negate(secp256k1.multiply(e, Pp)))
  if (R === null) return false
  if (!hasEvenY(R)) return false
  return R.x === r
}
