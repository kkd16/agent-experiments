// AES-GCM-SIV — nonce-misuse-resistant authenticated encryption (RFC 8452).
//
// GCM has one catastrophic failure mode: repeat a (key, nonce) pair and the
// universal-hash key H leaks — an attacker recovers the authentication key and
// forges at will (see the note in `gcm.ts`). In the real world nonces DO repeat:
// a VM is cloned and its counter rewinds, a bad RNG collides, an embedded device
// reboots. GCM-SIV is the fix that Google shipped and the IETF standardised.
//
// The trick is "Synthetic IV": the per-message counter is not the nonce but a
// *tag derived from the plaintext itself*. So the same plaintext under the same
// nonce is deterministic (an attacker only learns that two messages were equal —
// the minimum any deterministic scheme must leak), and there is no keystream
// reuse across *different* plaintexts. It degrades gracefully instead of
// exploding.
//
// The construction, per message:
//   • DeriveKeys — hash the nonce through AES to split the key into a fresh
//     message-authentication key and message-encryption key (so H is per-nonce).
//   • POLYVAL — the authenticator, GHASH's little-endian mirror over the field
//     𝔽₂[x]/(x¹²⁸+x¹²⁷+x¹²⁶+x¹²¹+1) with the montgomery factor x⁻¹²⁸ folded into
//     every multiply. Implemented here directly from that definition.
//   • the SIV tag = AES_MEK(POLYVAL(...) ⊕ nonce, top bit cleared), and the tag
//     (top bit set) seeds AES-CTR to encrypt.
//
// Built on this lab's `aes.ts`. Cross-checked in `selftest.ts` against a second,
// independent POLYVAL (via GHASH + bit reversal) and full round-trips; the SIV
// property — deterministic, no cross-plaintext keystream reuse — is demonstrated
// live on the lab page.

import { expandKey, encryptBlock, type AesKey } from './aes'

// ── POLYVAL (RFC 8452 §3) ─────────────────────────────────────────────────────
// Field elements are little-endian in both byte and bit order: coefficient of xᵏ
// is bit k of the little-endian integer of the 16-byte block. dot(a,b) = a·b·x⁻¹²⁸
// mod M, with M = x¹²⁸ + x¹²⁷ + x¹²⁶ + x¹²¹ + 1.

const M_POLYVAL = (1n << 128n) | (1n << 127n) | (1n << 126n) | (1n << 121n) | 1n

function bytesToPoly(b: Uint8Array, off = 0): bigint {
  let n = 0n
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(b[off + i] ?? 0)
  return n
}

function polyToBytes(n: bigint): Uint8Array {
  const b = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    b[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return b
}

/** Carry-less (GF(2)) polynomial multiply. */
function clmul(a: bigint, b: bigint): bigint {
  let r = 0n
  while (b > 0n) {
    if (b & 1n) r ^= a
    a <<= 1n
    b >>= 1n
  }
  return r
}

/** dot(a,b) = a·b·x⁻¹²⁸ mod M — a Montgomery multiply in the POLYVAL field. */
export function polyvalDot(a: bigint, b: bigint): bigint {
  let t = clmul(a, b) // degree < 256
  // Montgomery reduction: clear the low 128 bits by adding shifted multiples of M
  // (M has constant term 1, so it is invertible mod x), then divide by x¹²⁸.
  for (let i = 0n; i < 128n; i++) {
    if ((t >> i) & 1n) t ^= M_POLYVAL << i
  }
  return t >> 128n
}

/** POLYVAL_H(X_1 ‖ … ‖ X_n): S ← 0; for each block Xᵢ: S ← dot(S ⊕ Xᵢ, H). */
export function polyval(H: Uint8Array, data: Uint8Array): Uint8Array {
  const h = bytesToPoly(H)
  let s = 0n
  for (let off = 0; off < data.length; off += 16) {
    s = polyvalDot(s ^ bytesToPoly(data, off), h)
  }
  return polyToBytes(s)
}

// ── DeriveKeys (RFC 8452 §4) ──────────────────────────────────────────────────
// Encrypt LE32(counter) ‖ nonce under the master key; the left 8 bytes of each
// output are concatenated to build the two per-message keys.

function deriveKeys(masterKey: Uint8Array, nonce: Uint8Array): { mak: Uint8Array; mek: Uint8Array } {
  const k = expandKey(masterKey)
  const mekLen = masterKey.length // 16 → AES-128, 32 → AES-256
  const block = (ctr: number): Uint8Array => {
    const b = new Uint8Array(16)
    b[0] = ctr & 0xff
    b[1] = (ctr >> 8) & 0xff
    b[2] = (ctr >> 16) & 0xff
    b[3] = (ctr >> 24) & 0xff
    b.set(nonce, 4)
    return encryptBlock(k, b).subarray(0, 8)
  }
  const mak = new Uint8Array(16)
  mak.set(block(0), 0)
  mak.set(block(1), 8)
  const mek = new Uint8Array(mekLen)
  const n = mekLen / 8
  for (let i = 0; i < n; i++) mek.set(block(2 + i), i * 8)
  return { mak, mek }
}

// ── The AEAD (RFC 8452 §4) ────────────────────────────────────────────────────

function padTo16(len: number): number {
  return len % 16 === 0 ? 0 : 16 - (len % 16)
}

function le64(n: number): Uint8Array {
  const b = new Uint8Array(8)
  let v = BigInt(n)
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return b
}

/** The length-framed POLYVAL input: A ‖ 0* ‖ P ‖ 0* ‖ [bitlen A]₆₄ ‖ [bitlen P]₆₄. */
function polyvalInput(aad: Uint8Array, msg: Uint8Array): Uint8Array {
  const total = aad.length + padTo16(aad.length) + msg.length + padTo16(msg.length) + 16
  const buf = new Uint8Array(total)
  let o = 0
  buf.set(aad, o); o += aad.length + padTo16(aad.length)
  buf.set(msg, o); o += msg.length + padTo16(msg.length)
  buf.set(le64(aad.length * 8), o); o += 8
  buf.set(le64(msg.length * 8), o)
  return buf
}

/** Compute the SIV tag from the message-auth key, nonce, AAD and plaintext. */
function sivTag(mak: Uint8Array, mek: AesKey, nonce: Uint8Array, aad: Uint8Array, msg: Uint8Array): Uint8Array {
  const S = polyval(mak, polyvalInput(aad, msg))
  for (let i = 0; i < 12; i++) S[i] ^= nonce[i]
  S[15] &= 0x7f // clear the most-significant bit before encrypting
  return encryptBlock(mek, S)
}

/** AES-CTR with GCM-SIV's little-endian 32-bit counter, seeded by the tag. */
function sivCtr(mek: AesKey, tag: Uint8Array, input: Uint8Array): Uint8Array {
  const counter = tag.slice(0, 16)
  counter[15] |= 0x80 // set the most-significant bit of the initial counter block
  const out = new Uint8Array(input.length)
  for (let off = 0; off < input.length; off += 16) {
    const ks = encryptBlock(mek, counter)
    const n = Math.min(16, input.length - off)
    for (let i = 0; i < n; i++) out[off + i] = input[off + i] ^ ks[i]
    // increment the first 32 bits, little-endian
    for (let i = 0; i < 4; i++) {
      counter[i] = (counter[i] + 1) & 0xff
      if (counter[i] !== 0) break
    }
  }
  return out
}

export interface SivResult {
  ciphertext: Uint8Array
  tag: Uint8Array
}

/** AES-GCM-SIV encryption. `key` is 16 (AES-128) or 32 (AES-256) bytes; nonce is
 *  12 bytes. Output ciphertext is |plaintext| bytes plus a 16-byte tag. */
export function gcmSivEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): SivResult {
  const { mak, mek } = deriveKeys(key, nonce)
  const mekS = expandKey(mek)
  const tag = sivTag(mak, mekS, nonce, aad, plaintext)
  const ciphertext = sivCtr(mekS, tag, plaintext)
  return { ciphertext, tag }
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Verify and decrypt. Returns null on authentication failure. */
export function gcmSivDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array | null {
  const { mak, mek } = deriveKeys(key, nonce)
  const mekS = expandKey(mek)
  const plaintext = sivCtr(mekS, tag, ciphertext)
  const expected = sivTag(mak, mekS, nonce, aad, plaintext)
  if (!ctEqual(expected, tag)) return null
  return plaintext
}

/** Expose the derived per-message keys for the lab page's DeriveKeys panel. */
export function deriveKeysPublic(key: Uint8Array, nonce: Uint8Array): { mak: Uint8Array; mek: Uint8Array } {
  return deriveKeys(key, nonce)
}
