// XEdDSA — signatures with a Montgomery (X25519) key (Signal's specification).
//
// X3DH gives every party a single X25519 identity key used for Diffie–Hellman.
// But the responder must *sign* its prekey, and an X25519 key is only a
// u-coordinate — it has no signing algorithm of its own. XEdDSA bridges the two
// curves: it converts the Montgomery key pair to the birationally equivalent
// twisted-Edwards key pair, signs with ordinary Ed25519 (RFC 8032) maths, and —
// because the Montgomery public key fixes only the y-coordinate — pins the
// Edwards public key's sign bit to 0 so the verifier can rebuild it from just
// the u-coordinate.
//
// Built directly on the lab's Ed25519 group; the verifier reuses `ed25519Verify`
// unchanged, since an XEdDSA signature *is* a valid Ed25519 signature under the
// derived key.

import { mod, modInv } from './field'
import { sha512 } from './sha512'
import { randomBytes } from './rng'
import {
  ED_B,
  edMul,
  edEncode,
  ed25519Verify,
  clampScalar,
  encodeLittleEndian,
  decodeLittleEndian,
  P25519,
  L25519,
} from './ed25519'

// hash_1 domain prefix (2^256 − 1 − 1, little-endian): separates the nonce hash
// from the challenge hash so the two SHA-512 calls can never collide.
const HASH1_PREFIX = (() => {
  const p = new Uint8Array(32).fill(0xff)
  p[0] = 0xfe
  return p
})()

function leBytes(n: bigint, len: number): Uint8Array {
  const b = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    b[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return b
}

function leToBig(b: Uint8Array): bigint {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrs) {
    out.set(a, o)
    o += a.length
  }
  return out
}

/** Convert a Montgomery public key (u-coordinate bytes) to the sign-bit-0
 *  Edwards public-key encoding: y = (u − 1)/(u + 1), sign bit cleared. */
export function montPubToEdPub(u: Uint8Array): Uint8Array | null {
  const uInt = mod(decodeLittleEndian(u) & ((1n << 255n) - 1n), P25519)
  const denom = mod(uInt + 1n, P25519)
  if (denom === 0n) return null
  const y = mod((uInt - 1n) * modInv(denom, P25519), P25519)
  const enc = encodeLittleEndian(y) // 32 bytes, top (sign) bit already 0 since y < p
  enc[31] &= 0x7f
  return enc
}

/**
 * XEdDSA sign. `montPriv` is the 32-byte X25519 private key; `msg` is the
 * message; `randomness` is 64 fresh random bytes (defaults to a CSPRNG draw).
 * Returns a 64-byte Ed25519-shaped signature R‖s.
 */
export function xeddsaSign(
  montPriv: Uint8Array,
  msg: Uint8Array,
  randomness: Uint8Array = randomBytes(64),
): Uint8Array {
  // Derive the Edwards signing scalar and force the public key's sign bit to 0.
  let a = clampScalar(montPriv)
  const A0 = edMul(a, ED_B)
  const A0enc = edEncode(A0)
  if ((A0enc[31] & 0x80) !== 0) a = mod(L25519 - a, L25519)
  const A = edEncode(edMul(a, ED_B)) // sign bit now 0

  const aBytes = leBytes(a, 32)
  const r = mod(leToBig(sha512(concat(HASH1_PREFIX, aBytes, msg, randomness))), L25519)
  const R = edEncode(edMul(r, ED_B))
  const h = mod(leToBig(sha512(concat(R, A, msg))), L25519)
  const s = mod(r + h * a, L25519)

  return concat(R, leBytes(s, 32))
}

/**
 * XEdDSA verify. `montPub` is the signer's 32-byte X25519 public key. Rebuilds
 * the Edwards public key from it (sign bit 0) and checks the Ed25519 equation.
 */
export function xeddsaVerify(montPub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false
  const edPub = montPubToEdPub(montPub)
  if (!edPub) return false
  return ed25519Verify(edPub, msg, sig)
}
