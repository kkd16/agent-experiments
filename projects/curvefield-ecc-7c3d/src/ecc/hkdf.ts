// HKDF-SHA256 — the HMAC-based extract-and-expand key-derivation function
// (RFC 5869). The Double Ratchet and X3DH both lean on it: extract concentrates
// the entropy of a raw Diffie–Hellman secret into a uniform pseudorandom key,
// and expand stretches that key into as many independent sub-keys as a protocol
// needs, each namespaced by an `info` label so two uses never collide.
//
// Built on the lab's own hand-written HMAC-SHA256; pinned to RFC 5869's test
// vectors in `selftest.ts`.

import { hmacSha256, concat } from './sha256'

const HASH_LEN = 32

/**
 * HKDF-Extract (RFC 5869 §2.2): PRK = HMAC(salt, IKM). Concentrates a possibly
 * non-uniform input keying material into a fixed-length pseudorandom key.
 */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmacSha256(salt, ikm)
}

/**
 * HKDF-Expand (RFC 5869 §2.3): stretch a PRK into `length` bytes of output
 * keying material, bound to a context string `info`. Capped at 255·HashLen.
 */
export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (length > 255 * HASH_LEN) throw new Error('HKDF-Expand: length too large')
  const out: Uint8Array[] = []
  let t: Uint8Array = new Uint8Array(0)
  const n = Math.ceil(length / HASH_LEN)
  for (let i = 1; i <= n; i++) {
    t = hmacSha256(prk, concat(t, info, new Uint8Array([i])))
    out.push(t)
  }
  return concat(...out).slice(0, length)
}

/**
 * The full HKDF: extract then expand in one call. When `salt` is omitted it
 * defaults to a string of HashLen zero bytes, exactly as the RFC specifies.
 */
export function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const usableSalt = salt.length === 0 ? new Uint8Array(HASH_LEN) : salt
  return hkdfExpand(hkdfExtract(usableSalt, ikm), info, length)
}
