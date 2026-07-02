// ChaCha20 + Poly1305 — the modern authenticated cipher (RFC 8439), the one
// symmetric primitive this lab needs to turn its key-agreement machinery into a
// real *secure channel*. Everything else here proves who said something or that
// a statement is true; this is the piece that keeps a message secret.
//
//   • ChaCha20 is Bernstein's stream cipher: a 20-round ARX permutation over a
//     4×4 matrix of 32-bit words, run in counter mode to make a keystream.
//   • Poly1305 is a one-time Wegman–Carter MAC — a single polynomial evaluated
//     modulo 2¹³⁰ − 5 — that authenticates the ciphertext.
//   • AEAD_CHACHA20_POLY1305 (§2.8) welds them: a per-message Poly1305 key is
//     drawn from ChaCha20 block 0, the payload is encrypted from block 1 on, and
//     the tag covers the associated data and the ciphertext with length framing.
//
// Pinned byte-for-byte to the RFC's own test vectors in `selftest.ts`. Pure
// Uint32/Uint8 arithmetic — no WebCrypto, so it also runs in the sandboxed
// catalog thumbnail.

// ── ChaCha20 (RFC 8439 §2.1–§2.4) ─────────────────────────────────────────────

const CONSTANTS = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] // "expand 32-byte k"

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

function readLE32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

function writeLE32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
  b[o + 2] = (v >>> 16) & 0xff
  b[o + 3] = (v >>> 24) & 0xff
}

/** One ChaCha quarter-round on four state words (in place, by index). */
function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0
  s[d] = rotl32(s[d] ^ s[a], 16)
  s[c] = (s[c] + s[d]) >>> 0
  s[b] = rotl32(s[b] ^ s[c], 12)
  s[a] = (s[a] + s[b]) >>> 0
  s[d] = rotl32(s[d] ^ s[a], 8)
  s[c] = (s[c] + s[d]) >>> 0
  s[b] = rotl32(s[b] ^ s[c], 7)
}

/**
 * The ChaCha20 block function: expand a 32-byte key, a 32-bit block counter, and
 * a 12-byte nonce into 64 bytes of keystream (RFC 8439 §2.3).
 */
export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  const state = new Uint32Array(16)
  state[0] = CONSTANTS[0]
  state[1] = CONSTANTS[1]
  state[2] = CONSTANTS[2]
  state[3] = CONSTANTS[3]
  for (let i = 0; i < 8; i++) state[4 + i] = readLE32(key, i * 4)
  state[12] = counter >>> 0
  state[13] = readLE32(nonce, 0)
  state[14] = readLE32(nonce, 4)
  state[15] = readLE32(nonce, 8)

  const w = state.slice()
  for (let i = 0; i < 10; i++) {
    // column round
    quarterRound(w, 0, 4, 8, 12)
    quarterRound(w, 1, 5, 9, 13)
    quarterRound(w, 2, 6, 10, 14)
    quarterRound(w, 3, 7, 11, 15)
    // diagonal round
    quarterRound(w, 0, 5, 10, 15)
    quarterRound(w, 1, 6, 11, 12)
    quarterRound(w, 2, 7, 8, 13)
    quarterRound(w, 3, 4, 9, 14)
  }

  const out = new Uint8Array(64)
  for (let i = 0; i < 16; i++) writeLE32(out, i * 4, (w[i] + state[i]) >>> 0)
  return out
}

/**
 * ChaCha20 stream encryption/decryption (RFC 8439 §2.4). XORs the plaintext with
 * the keystream produced from `initialCounter` onward. Encryption and decryption
 * are the same operation.
 */
export function chacha20(
  key: Uint8Array,
  initialCounter: number,
  nonce: Uint8Array,
  input: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(input.length)
  for (let off = 0; off < input.length; off += 64) {
    const ks = chacha20Block(key, (initialCounter + off / 64) >>> 0, nonce)
    const n = Math.min(64, input.length - off)
    for (let i = 0; i < n; i++) out[off + i] = input[off + i] ^ ks[i]
  }
  return out
}

// ── Poly1305 (RFC 8439 §2.5) ──────────────────────────────────────────────────

const P130 = (1n << 130n) - 5n
const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn
const MASK128 = (1n << 128n) - 1n

function leToBig(b: Uint8Array): bigint {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}

/**
 * The one-time Poly1305 authenticator: evaluate the message as a polynomial in
 * the (clamped) key `r`, modulo 2¹³⁰ − 5, then add the blind `s`. Returns a
 * 16-byte tag. The key MUST be used for a single message (Wegman–Carter).
 */
export function poly1305Mac(oneTimeKey: Uint8Array, msg: Uint8Array): Uint8Array {
  const r = leToBig(oneTimeKey.slice(0, 16)) & CLAMP
  const s = leToBig(oneTimeKey.slice(16, 32))
  let acc = 0n
  for (let off = 0; off < msg.length; off += 16) {
    const n = Math.min(16, msg.length - off)
    const block = new Uint8Array(n + 1)
    block.set(msg.subarray(off, off + n))
    block[n] = 1 // the high "1" bit that frames each block
    acc = ((acc + leToBig(block)) * r) % P130
  }
  acc = (acc + s) & MASK128
  const tag = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(acc & 0xffn)
    acc >>= 8n
  }
  return tag
}

/** Derive the per-message Poly1305 key from ChaCha20 block 0 (RFC 8439 §2.6). */
export function poly1305KeyGen(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  return chacha20Block(key, 0, nonce).slice(0, 32)
}

// ── AEAD_CHACHA20_POLY1305 (RFC 8439 §2.8) ────────────────────────────────────

function pad16(len: number): number {
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

function macData(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(
    aad.length + pad16(aad.length) + ciphertext.length + pad16(ciphertext.length) + 16,
  )
  let o = 0
  out.set(aad, o)
  o += aad.length + pad16(aad.length)
  out.set(ciphertext, o)
  o += ciphertext.length + pad16(ciphertext.length)
  out.set(le64(aad.length), o)
  o += 8
  out.set(le64(ciphertext.length), o)
  return out
}

export interface AeadResult {
  ciphertext: Uint8Array
  tag: Uint8Array
}

/**
 * Encrypt-then-MAC with ChaCha20-Poly1305. Returns the ciphertext and a 16-byte
 * authentication tag that binds both the ciphertext and the associated data.
 */
export function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): AeadResult {
  const otk = poly1305KeyGen(key, nonce)
  const ciphertext = chacha20(key, 1, nonce, plaintext)
  const tag = poly1305Mac(otk, macData(aad, ciphertext))
  return { ciphertext, tag }
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Verify the tag and decrypt. Returns the plaintext, or `null` if the tag does
 * not authenticate (a forged, truncated, or tampered message) — the caller must
 * treat `null` as a hard failure and never touch the plaintext.
 */
export function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array | null {
  const otk = poly1305KeyGen(key, nonce)
  const expected = poly1305Mac(otk, macData(aad, ciphertext))
  if (!ctEqual(expected, tag)) return null
  return chacha20(key, 1, nonce, ciphertext)
}

/** Convenience: seal into a single `ciphertext‖tag` buffer. */
export function seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const { ciphertext, tag } = aeadEncrypt(key, nonce, plaintext, aad)
  const out = new Uint8Array(ciphertext.length + 16)
  out.set(ciphertext)
  out.set(tag, ciphertext.length)
  return out
}

/** Convenience: open a `ciphertext‖tag` buffer, or `null` on any failure. */
export function open(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array | null {
  if (sealed.length < 16) return null
  const ciphertext = sealed.slice(0, sealed.length - 16)
  const tag = sealed.slice(sealed.length - 16)
  return aeadDecrypt(key, nonce, ciphertext, tag, aad)
}
