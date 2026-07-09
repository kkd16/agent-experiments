// AES-GCM — Galois/Counter Mode, the authenticated cipher that actually runs the
// internet (NIST SP 800-38D). It is the default AEAD in TLS 1.3, the workhorse of
// IPsec and SSH, and the reason AES-NI ships a `PCLMULQDQ` carry-less multiply.
// Built here on this lab's from-scratch `aes.ts`.
//
// GCM = counter-mode encryption + a *universal hash* (GHASH) for authentication:
//
//   • The block cipher, run in CTR mode from a per-message counter J0, produces
//     the keystream that hides the plaintext.
//   • GHASH is a polynomial evaluated in GF(2¹²⁸): H = E_K(0), and the ciphertext
//     and associated-data blocks are the coefficients — S = Σ Bᵢ·H^{n−i+1}. It is
//     a Wegman–Carter / Carter–Wegman MAC: fast, parallelisable, but catastrophic
//     if a (key, nonce) pair ever repeats (two messages leak GHASH's key H, and
//     forgeries follow). `gcmsiv.ts` is the nonce-misuse-resistant answer.
//   • The tag is E_K(J0) ⊕ S — the hash blinded by one cipher block.
//
// The whole security of the MAC rests on that one GF(2¹²⁸) multiply, so it is
// implemented here from the bit up (the spec's right-shift algorithm), not
// borrowed. Pinned to NIST's GCM test vectors (the McGrew–Viega test cases) in
// `selftest.ts`. Pure Uint8Array — no WebCrypto.

import { expandKey, encryptBlock, type AesKey } from './aes'

// ── GF(2¹²⁸) multiplication (SP 800-38D §6.3) ─────────────────────────────────
// Blocks are big-endian; bit 0 is the most-significant bit of byte 0. R is the
// reduction constant for the field 𝔽₂[x]/(x¹²⁸ + x⁷ + x² + x + 1): 0xE1 ‖ 0¹²⁰.

function xorInto(a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < 16; i++) a[i] ^= b[i]
}

/** Multiply two 16-byte field elements X·Y in the GHASH field. */
export function gfmul(X: Uint8Array, Y: Uint8Array): Uint8Array {
  const Z = new Uint8Array(16)
  const V = Y.slice(0, 16)
  for (let i = 0; i < 128; i++) {
    // if the i-th bit of X (MSB-first) is set, add V into Z
    if ((X[i >> 3] >> (7 - (i & 7))) & 1) xorInto(Z, V)
    // V = V >> 1, and if a 1 fell off the right, reduce by XORing R (0xe1…)
    const lsb = V[15] & 1
    for (let j = 15; j > 0; j--) V[j] = ((V[j] >> 1) | (V[j - 1] << 7)) & 0xff
    V[0] >>= 1
    if (lsb) V[0] ^= 0xe1
  }
  return Z
}

/** GHASH_H(data): fold each 16-byte block into the running product (data is
 *  zero-padded to a block boundary by the caller-supplied composition). */
export function ghash(H: Uint8Array, data: Uint8Array): Uint8Array {
  let Y: Uint8Array = new Uint8Array(16)
  for (let off = 0; off < data.length; off += 16) {
    const blk = new Uint8Array(16)
    blk.set(data.subarray(off, Math.min(off + 16, data.length)))
    xorInto(Y, blk)
    Y = gfmul(Y, H)
  }
  return Y
}

// ── GCTR — the counter-mode keystream (SP 800-38D §6.5) ───────────────────────

function inc32(block: Uint8Array): Uint8Array {
  const out = block.slice(0, 16)
  for (let i = 15; i >= 12; i--) {
    out[i] = (out[i] + 1) & 0xff
    if (out[i] !== 0) break
  }
  return out
}

function gctr(k: AesKey, icb: Uint8Array, input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  let cb: Uint8Array = icb.slice(0, 16)
  for (let off = 0; off < input.length; off += 16) {
    const ks = encryptBlock(k, cb)
    const n = Math.min(16, input.length - off)
    for (let i = 0; i < n; i++) out[off + i] = input[off + i] ^ ks[i]
    cb = inc32(cb)
  }
  return out
}

// ── Length encoding + the authenticated-data hash ─────────────────────────────

function be64(n: number): Uint8Array {
  const b = new Uint8Array(8)
  let v = BigInt(n)
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return b
}

function padTo16(len: number): number {
  return len % 16 === 0 ? 0 : 16 - (len % 16)
}

/** GHASH over A ‖ 0* ‖ C ‖ 0* ‖ [len(A)]₆₄ ‖ [len(C)]₆₄ (all bit-lengths). */
function ghashAC(H: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const total = aad.length + padTo16(aad.length) + ct.length + padTo16(ct.length) + 16
  const buf = new Uint8Array(total)
  let o = 0
  buf.set(aad, o); o += aad.length + padTo16(aad.length)
  buf.set(ct, o); o += ct.length + padTo16(ct.length)
  buf.set(be64(aad.length * 8), o); o += 8
  buf.set(be64(ct.length * 8), o)
  return ghash(H, buf)
}

/** Derive the pre-counter block J0 from the nonce (SP 800-38D §7.1 step 2). */
export function computeJ0(H: Uint8Array, iv: Uint8Array): Uint8Array {
  if (iv.length === 12) {
    const j0 = new Uint8Array(16)
    j0.set(iv)
    j0[15] = 1
    return j0
  }
  // GHASH(IV ‖ 0* ‖ [len(IV)]₁₂₈) for any other nonce length
  const total = iv.length + padTo16(iv.length) + 16
  const buf = new Uint8Array(total)
  buf.set(iv)
  buf.set(be64(iv.length * 8), total - 8)
  return ghash(H, buf)
}

export interface GcmResult {
  ciphertext: Uint8Array
  tag: Uint8Array
}

/** AES-GCM authenticated encryption. `tagLen` in bytes (default 16). */
export function gcmEncrypt(
  key: Uint8Array | AesKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
  tagLen = 16,
): GcmResult {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const H = encryptBlock(k, new Uint8Array(16))
  const J0 = computeJ0(H, iv)
  const ciphertext = gctr(k, inc32(J0), plaintext)
  const S = ghashAC(H, aad, ciphertext)
  const fullTag = gctr(k, J0, S)
  return { ciphertext, tag: fullTag.slice(0, tagLen) }
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Verify the tag and decrypt. Returns null on any authentication failure — the
 *  caller must treat null as fatal and never expose the candidate plaintext. */
export function gcmDecrypt(
  key: Uint8Array | AesKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array | null {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const H = encryptBlock(k, new Uint8Array(16))
  const J0 = computeJ0(H, iv)
  const S = ghashAC(H, aad, ciphertext)
  const expected = gctr(k, J0, S).slice(0, tag.length)
  if (!ctEqual(expected, tag)) return null
  return gctr(k, inc32(J0), ciphertext)
}

// ── GMAC — GCM used purely as a message authentication code ───────────────────

/** GMAC: authenticate `data` (as associated data, empty plaintext). */
export function gmac(key: Uint8Array | AesKey, iv: Uint8Array, data: Uint8Array, tagLen = 16): Uint8Array {
  return gcmEncrypt(key, iv, new Uint8Array(0), data, tagLen).tag
}

/** Seal into a single ciphertext‖tag buffer. */
export function seal(
  key: Uint8Array | AesKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const { ciphertext, tag } = gcmEncrypt(key, iv, plaintext, aad)
  const out = new Uint8Array(ciphertext.length + 16)
  out.set(ciphertext)
  out.set(tag, ciphertext.length)
  return out
}

/** Open a ciphertext‖tag buffer, or null on failure. */
export function open(
  key: Uint8Array | AesKey,
  iv: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array | null {
  if (sealed.length < 16) return null
  return gcmDecrypt(key, iv, sealed.slice(0, sealed.length - 16), sealed.slice(sealed.length - 16), aad)
}
