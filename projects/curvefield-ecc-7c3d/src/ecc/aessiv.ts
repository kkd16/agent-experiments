// AES-SIV — deterministic authenticated encryption (RFC 5297).
//
// The CMAC-based sibling of AES-GCM-SIV: another *nonce-misuse-resistant* AEAD,
// but built on the block-cipher MAC (`cmac.ts`) instead of a polynomial hash. It
// is what RFC 8291 (Web Push encryption), several key-wrapping schemes, and the
// "deterministic encryption" use cases (encrypting database keys so equal keys
// encrypt equally, searchable) actually use.
//
// The construction has two ideas:
//   • S2V ("string-to-vector") — a CMAC-based PRF that folds a *vector* of
//     associated-data strings plus the plaintext into a single 16-byte value V.
//     It doubles (a GF(2¹²⁸) ·x) the running value between inputs so the header
//     order is bound, and mixes the plaintext in by xorend / dbl-and-pad. V is
//     simultaneously the authentication tag AND the synthetic IV.
//   • CTR — V (with two bits masked, per the RFC) seeds AES-CTR to encrypt.
//
// Because the IV is derived from the whole message, a repeated nonce is a
// non-event: identical (AD, plaintext) encrypt identically and nothing else
// leaks. The key is *double length* — the left half keys S2V, the right half
// keys CTR. Pinned to RFC 5297's Appendix A.1 test vector in `selftest.ts`. Built
// on this lab's from-scratch `aes.ts` + `cmac.ts`.

import { expandKey, encryptBlock, type AesKey } from './aes'
import { cmac } from './cmac'

const Rb = 0x87

/** GF(2¹²⁸) doubling: a left shift by one with the conditional reduction XOR. */
function dbl(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  const msb = input[0] & 0x80
  for (let i = 0; i < 16; i++) out[i] = ((input[i] << 1) | (i < 15 ? input[i + 1] >> 7 : 0)) & 0xff
  if (msb) out[15] ^= Rb
  return out
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

/** XOR `b` (16 bytes) into the *end* of `a` (|a| ≥ 16). */
function xorend(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = a.slice()
  const off = a.length - 16
  for (let i = 0; i < 16; i++) out[off + i] ^= b[i]
  return out
}

/** pad: append 0x80 then zeros to a 16-byte block. */
function pad16(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(16)
  out.set(a.subarray(0, 16))
  if (a.length < 16) out[a.length] = 0x80
  return out
}

/** S2V(K, S_1, …, S_n) — the CMAC-based PRF at the heart of SIV (RFC 5297 §2.4).
 *  The final element is the plaintext; the earlier ones are associated data. */
export function s2v(key: Uint8Array | AesKey, strings: Uint8Array[]): Uint8Array {
  const k = 'roundKeys' in key ? key : expandKey(key)
  if (strings.length === 0) {
    // S2V of the empty vector: CMAC of a single "1" block.
    const one = new Uint8Array(16)
    one[15] = 1
    return cmac(k, one)
  }
  let d = cmac(k, new Uint8Array(16)) // CMAC of zero
  for (let i = 0; i < strings.length - 1; i++) {
    d = xor(dbl(d), cmac(k, strings[i]))
  }
  const last = strings[strings.length - 1]
  let t: Uint8Array
  if (last.length >= 16) {
    t = xorend(last, d)
  } else {
    t = xor(dbl(d), pad16(last))
  }
  return cmac(k, t)
}

/** Zero the 31st and 63rd bits (from the right) of V to form the CTR counter Q. */
function toCounter(v: Uint8Array): Uint8Array {
  const q = v.slice(0, 16)
  q[8] &= 0x7f
  q[12] &= 0x7f
  return q
}

function aesCtr(k: AesKey, counter: Uint8Array, input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  const cb = counter.slice(0, 16)
  for (let off = 0; off < input.length; off += 16) {
    const ks = encryptBlock(k, cb)
    const n = Math.min(16, input.length - off)
    for (let i = 0; i < n; i++) out[off + i] = input[off + i] ^ ks[i]
    for (let i = 15; i >= 0; i--) { cb[i] = (cb[i] + 1) & 0xff; if (cb[i] !== 0) break }
  }
  return out
}

export interface SivResult {
  /** the synthetic IV = authentication tag (16 bytes) */
  v: Uint8Array
  ciphertext: Uint8Array
}

/** AES-SIV encryption. `key` is 32 or 64 bytes (K1‖K2, each 16/32). `ad` is the
 *  vector of associated-data strings. Output is V ‖ ciphertext (V prepended). */
export function sivEncrypt(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array[] = []): SivResult {
  const half = key.length / 2
  const k1 = expandKey(key.subarray(0, half))
  const k2 = expandKey(key.subarray(half))
  const v = s2v(k1, [...ad, plaintext])
  const ciphertext = aesCtr(k2, toCounter(v), plaintext)
  return { v, ciphertext }
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Verify and decrypt an AES-SIV message. Returns null on authentication failure. */
export function sivDecrypt(key: Uint8Array, v: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array[] = []): Uint8Array | null {
  const half = key.length / 2
  const k1 = expandKey(key.subarray(0, half))
  const k2 = expandKey(key.subarray(half))
  const plaintext = aesCtr(k2, toCounter(v), ciphertext)
  const v2 = s2v(k1, [...ad, plaintext])
  if (!ctEqual(v2, v)) return null
  return plaintext
}

/** Seal into a single V‖ciphertext buffer (the RFC 5297 wire format). */
export function seal(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array[] = []): Uint8Array {
  const { v, ciphertext } = sivEncrypt(key, plaintext, ad)
  const out = new Uint8Array(16 + ciphertext.length)
  out.set(v)
  out.set(ciphertext, 16)
  return out
}

/** Open a V‖ciphertext buffer, or null on failure. */
export function open(key: Uint8Array, sealed: Uint8Array, ad: Uint8Array[] = []): Uint8Array | null {
  if (sealed.length < 16) return null
  return sivDecrypt(key, sealed.slice(0, 16), sealed.slice(16), ad)
}
