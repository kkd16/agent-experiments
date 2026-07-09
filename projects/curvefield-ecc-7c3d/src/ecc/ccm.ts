// AES-CCM — Counter with CBC-MAC (NIST SP 800-38C, RFC 3610). The *other* major
// AES AEAD beside GCM: it is the mandatory cipher of Wi-Fi WPA2 (CCMP),
// Bluetooth Low Energy, Zigbee/Thread, and the TLS `AES_CCM` suites. Where GCM
// uses a polynomial hash, CCM authenticates with a plain CBC-MAC and encrypts
// with CTR — a "MAC-then-encrypt" of the tag — so it needs only the block cipher
// forward direction and no field multiply, which is why it shows up on the
// smallest radios.
//
// The fiddly part is the formatting (RFC 3610 §2.2): the message length L and tag
// length M are packed into a flags byte; the first CBC-MAC block B0 carries the
// flags, the nonce, and the payload length; associated data is length-prefixed
// and zero-padded; and the CTR counter blocks reuse the same nonce with their own
// flags. Built on this lab's from-scratch `aes.ts` and pinned to the RFC 3610
// test vectors in `selftest.ts`.

import { expandKey, encryptBlock, type AesKey } from './aes'

function cbcMacStep(k: AesKey, x: Uint8Array, block: Uint8Array): Uint8Array {
  const t = new Uint8Array(16)
  for (let i = 0; i < 16; i++) t[i] = x[i] ^ block[i]
  return encryptBlock(k, t)
}

/** Build the length-prefixed, zero-padded associated-data blocks (RFC 3610 §2.2). */
function formatAad(aad: Uint8Array): Uint8Array {
  if (aad.length === 0) return new Uint8Array(0)
  // Only the common 0 < a < 2¹⁶−2⁸ encoding (a 2-byte big-endian length) is used here.
  const prefixed = new Uint8Array(2 + aad.length)
  prefixed[0] = (aad.length >> 8) & 0xff
  prefixed[1] = aad.length & 0xff
  prefixed.set(aad, 2)
  const padded = new Uint8Array(Math.ceil(prefixed.length / 16) * 16)
  padded.set(prefixed)
  return padded
}

function counterBlock(nonce: Uint8Array, L: number, i: number): Uint8Array {
  const a = new Uint8Array(16)
  a[0] = L - 1 // flags: just the length field
  a.set(nonce, 1)
  for (let j = 0; j < L; j++) a[15 - j] = (i >> (8 * j)) & 0xff
  return a
}

export interface CcmResult {
  ciphertext: Uint8Array
  tag: Uint8Array
}

/** AES-CCM authenticated encryption. Nonce is 7–13 bytes (L = 15 − |nonce|); tag
 *  length `tagLen` (M) is an even 4–16 (default 16). */
export function ccmEncrypt(
  key: Uint8Array | AesKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
  tagLen = 16,
): CcmResult {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const L = 15 - nonce.length
  const M = tagLen

  // ── CBC-MAC over B0 ‖ formatted-AAD ‖ payload ─────────────────────────────
  const b0 = new Uint8Array(16)
  b0[0] = (aad.length > 0 ? 0x40 : 0) | (((M - 2) / 2) << 3) | (L - 1)
  b0.set(nonce, 1)
  for (let j = 0; j < L; j++) b0[15 - j] = (plaintext.length >> (8 * j)) & 0xff

  let x = encryptBlock(k, b0)
  const aadBlocks = formatAad(aad)
  for (let off = 0; off < aadBlocks.length; off += 16) x = cbcMacStep(k, x, aadBlocks.subarray(off, off + 16))
  for (let off = 0; off < plaintext.length; off += 16) {
    const blk = new Uint8Array(16)
    blk.set(plaintext.subarray(off, off + 16))
    x = cbcMacStep(k, x, blk)
  }
  const T = x.subarray(0, M)

  // ── CTR: encrypt the payload from A1, encrypt the tag with A0 ──────────────
  const s0 = encryptBlock(k, counterBlock(nonce, L, 0))
  const tag = new Uint8Array(M)
  for (let i = 0; i < M; i++) tag[i] = T[i] ^ s0[i]

  const ciphertext = new Uint8Array(plaintext.length)
  for (let off = 0, i = 1; off < plaintext.length; off += 16, i++) {
    const s = encryptBlock(k, counterBlock(nonce, L, i))
    const n = Math.min(16, plaintext.length - off)
    for (let j = 0; j < n; j++) ciphertext[off + j] = plaintext[off + j] ^ s[j]
  }
  return { ciphertext, tag }
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Verify and decrypt an AES-CCM message. Returns null on authentication failure. */
export function ccmDecrypt(
  key: Uint8Array | AesKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array | null {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const L = 15 - nonce.length

  // decrypt the payload with CTR from A1
  const plaintext = new Uint8Array(ciphertext.length)
  for (let off = 0, i = 1; off < ciphertext.length; off += 16, i++) {
    const s = encryptBlock(k, counterBlock(nonce, L, i))
    const n = Math.min(16, ciphertext.length - off)
    for (let j = 0; j < n; j++) plaintext[off + j] = ciphertext[off + j] ^ s[j]
  }
  // recompute the tag and compare
  const { tag: expected } = ccmEncrypt(k, nonce, plaintext, aad, tag.length)
  if (!ctEqual(expected, tag)) return null
  return plaintext
}
