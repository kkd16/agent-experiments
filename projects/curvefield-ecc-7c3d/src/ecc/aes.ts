// AES — the Advanced Encryption Standard (FIPS-197), from scratch.
//
// This lab has, until now, exactly one symmetric primitive: ChaCha20-Poly1305.
// That is the *modern* AEAD — but AES is the one the rest of the world actually
// runs. It is inside TLS (AES-GCM is the default cipher suite), disk encryption,
// Wi-Fi (WPA2/3 = AES-CCM/GCM), the Secure Enclave, and almost every hardware
// crypto accelerator (AES-NI). A cryptography lab without AES has a hole in its
// floor. This file fills it, and `gcm.ts` / `gcmsiv.ts` / `cmac.ts` build the
// real authenticated modes on top.
//
// AES is a *substitution–permutation network*: a 128-bit block is laid out as a
// 4×4 matrix of bytes (the "state") and pushed through Nr rounds, each a fixed
// sequence of four invertible steps —
//
//   • SubBytes    — a nonlinear byte substitution (the S-box), the only source
//                   of confusion; it is inversion in GF(2⁸) followed by an affine
//                   map, chosen for a flat difference/linear-approximation table.
//   • ShiftRows   — cyclically rotate row r left by r bytes (diffusion across
//                   columns).
//   • MixColumns  — multiply each column by a fixed matrix over GF(2⁸)
//                   (diffusion within a column); omitted in the last round.
//   • AddRoundKey — XOR in a 128-bit round key from the expanded key schedule.
//
// Nothing here is a table copied out of a reference: the S-box is *computed* from
// the GF(2⁸) inverse and the affine transform at load, and every field multiply
// goes through log/exp tables built from the generator 0x03. Pinned byte-for-byte
// to the FIPS-197 worked examples (Appendix B's round-by-round trace and the
// Appendix C ciphertexts for all three key sizes) in `selftest.ts`.
//
// Pure Uint8Array arithmetic — no WebCrypto — so it runs in the sandboxed catalog
// thumbnail too. NOT constant-time (the S-box is a table lookup); this is a
// teaching engine, not a hardened one.

// ── GF(2⁸) arithmetic — the Rijndael field 𝔽₂[x]/(x⁸+x⁴+x³+x+1) ───────────────

const POLY = 0x11b // x⁸ + x⁴ + x³ + x + 1, the AES reduction polynomial

/** Multiply two bytes in GF(2⁸) (carry-less multiply, reduce mod POLY). */
export function gmul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= POLY & 0xff // reduce: x⁸ ≡ x⁴+x³+x+1
    b >>= 1
  }
  return p & 0xff
}

// log/exp tables over the generator 0x03 (a primitive element of GF(2⁸)*),
// so the S-box inverse and MixColumns multiplies are single lookups.
const EXP = new Uint8Array(256)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x = gmul(x, 0x03)
  }
  EXP[255] = EXP[0]
}

/** Multiplicative inverse in GF(2⁸) (0⁻¹ ≔ 0, as AES defines it). */
export function ginv(a: number): number {
  if (a === 0) return 0
  return EXP[(255 - LOG[a]) % 255]
}

// ── The S-box: inverse in GF(2⁸), then the AES affine transform ───────────────

function affine(b: number): number {
  // s = b ⊕ (b⋘1) ⊕ (b⋘2) ⊕ (b⋘3) ⊕ (b⋘4) ⊕ 0x63, rotations over 8 bits.
  let s = b ^ 0x63
  for (const r of [1, 2, 3, 4]) s ^= ((b << r) | (b >> (8 - r))) & 0xff
  return s & 0xff
}

export const SBOX = new Uint8Array(256)
export const INV_SBOX = new Uint8Array(256)
for (let i = 0; i < 256; i++) {
  const s = affine(ginv(i))
  SBOX[i] = s
  INV_SBOX[s] = i
}

// ── Key expansion (FIPS-197 §5.2) ─────────────────────────────────────────────

const RCON = new Uint8Array(11)
{
  let r = 1
  for (let i = 1; i <= 10; i++) {
    RCON[i] = r
    r = gmul(r, 0x02)
  }
}

export interface AesKey {
  /** Nr+1 round keys, each 16 bytes (the flat schedule is 4·(Nr+1) words). */
  roundKeys: Uint8Array[]
  rounds: number // Nr
  bits: 128 | 192 | 256
}

function rotWord(w: number[]): number[] {
  return [w[1], w[2], w[3], w[0]]
}
function subWord(w: number[]): number[] {
  return [SBOX[w[0]], SBOX[w[1]], SBOX[w[2]], SBOX[w[3]]]
}

/** Expand a 16/24/32-byte key into the AES round-key schedule. */
export function expandKey(key: Uint8Array): AesKey {
  const Nk = key.length / 4
  if (Nk !== 4 && Nk !== 6 && Nk !== 8) throw new Error('AES key must be 16, 24, or 32 bytes')
  const Nr = Nk + 6
  const bits = (key.length * 8) as 128 | 192 | 256

  const w: number[][] = []
  for (let i = 0; i < Nk; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]])

  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let temp = w[i - 1].slice()
    if (i % Nk === 0) {
      temp = subWord(rotWord(temp))
      temp[0] ^= RCON[i / Nk]
    } else if (Nk > 6 && i % Nk === 4) {
      temp = subWord(temp)
    }
    w.push(w[i - Nk].map((b, j) => b ^ temp[j]))
  }

  const roundKeys: Uint8Array[] = []
  for (let r = 0; r <= Nr; r++) {
    const rk = new Uint8Array(16)
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) rk[4 * c + row] = w[4 * r + c][row]
    roundKeys.push(rk)
  }
  return { roundKeys, rounds: Nr, bits }
}

// ── The round transformations (state = 16 bytes, column-major: idx = 4·col+row)─

function subBytes(s: Uint8Array, box: Uint8Array): void {
  for (let i = 0; i < 16; i++) s[i] = box[s[i]]
}

function shiftRows(s: Uint8Array, inverse = false): void {
  const out = s.slice()
  for (let row = 1; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const src = inverse ? (col - row + 4) % 4 : (col + row) % 4
      out[4 * col + row] = s[4 * src + row]
    }
  }
  s.set(out)
}

function mixColumns(s: Uint8Array, inverse = false): void {
  const m = inverse
    ? [0x0e, 0x0b, 0x0d, 0x09]
    : [0x02, 0x03, 0x01, 0x01]
  const out = new Uint8Array(16)
  for (let c = 0; c < 4; c++) {
    const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3]
    out[4 * c + 0] = gmul(a0, m[0]) ^ gmul(a1, m[1]) ^ gmul(a2, m[2]) ^ gmul(a3, m[3])
    out[4 * c + 1] = gmul(a0, m[3]) ^ gmul(a1, m[0]) ^ gmul(a2, m[1]) ^ gmul(a3, m[2])
    out[4 * c + 2] = gmul(a0, m[2]) ^ gmul(a1, m[3]) ^ gmul(a2, m[0]) ^ gmul(a3, m[1])
    out[4 * c + 3] = gmul(a0, m[1]) ^ gmul(a1, m[2]) ^ gmul(a2, m[3]) ^ gmul(a3, m[0])
  }
  s.set(out)
}

function addRoundKey(s: Uint8Array, rk: Uint8Array): void {
  for (let i = 0; i < 16; i++) s[i] ^= rk[i]
}

// ── Block encryption / decryption ─────────────────────────────────────────────

/** A single 16-byte block through the AES cipher. `key` may be a raw key or a
 *  pre-expanded schedule (reuse the schedule across many blocks in a mode). */
export function encryptBlock(key: Uint8Array | AesKey, block: Uint8Array): Uint8Array {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const s = block.slice(0, 16)
  addRoundKey(s, k.roundKeys[0])
  for (let r = 1; r < k.rounds; r++) {
    subBytes(s, SBOX)
    shiftRows(s)
    mixColumns(s)
    addRoundKey(s, k.roundKeys[r])
  }
  subBytes(s, SBOX)
  shiftRows(s)
  addRoundKey(s, k.roundKeys[k.rounds])
  return s
}

/** The inverse cipher (equivalent-inverse would fold InvMixColumns into the key
 *  schedule; here we use the straightforward inverse for clarity). */
export function decryptBlock(key: Uint8Array | AesKey, block: Uint8Array): Uint8Array {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const s = block.slice(0, 16)
  addRoundKey(s, k.roundKeys[k.rounds])
  for (let r = k.rounds - 1; r >= 1; r--) {
    shiftRows(s, true)
    subBytes(s, INV_SBOX)
    addRoundKey(s, k.roundKeys[r])
    mixColumns(s, true)
  }
  shiftRows(s, true)
  subBytes(s, INV_SBOX)
  addRoundKey(s, k.roundKeys[0])
  return s
}

// ── An instrumented encryption that records every intermediate state ──────────
// This is what the AES lab page animates: the 4×4 grid after each transformation.

export interface AesStep {
  round: number
  op: 'input' | 'start' | 'subbytes' | 'shiftrows' | 'mixcolumns' | 'addroundkey' | 'output'
  state: Uint8Array
  roundKey?: Uint8Array
}

export function traceEncrypt(key: Uint8Array | AesKey, block: Uint8Array): AesStep[] {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const steps: AesStep[] = []
  const s = block.slice(0, 16)
  const snap = (round: number, op: AesStep['op'], roundKey?: Uint8Array) =>
    steps.push({ round, op, state: s.slice(), roundKey: roundKey?.slice() })

  snap(0, 'input')
  addRoundKey(s, k.roundKeys[0])
  snap(0, 'addroundkey', k.roundKeys[0])
  for (let r = 1; r < k.rounds; r++) {
    subBytes(s, SBOX); snap(r, 'subbytes')
    shiftRows(s); snap(r, 'shiftrows')
    mixColumns(s); snap(r, 'mixcolumns')
    addRoundKey(s, k.roundKeys[r]); snap(r, 'addroundkey', k.roundKeys[r])
  }
  subBytes(s, SBOX); snap(k.rounds, 'subbytes')
  shiftRows(s); snap(k.rounds, 'shiftrows')
  addRoundKey(s, k.roundKeys[k.rounds]); snap(k.rounds, 'addroundkey', k.roundKeys[k.rounds])
  snap(k.rounds, 'output')
  return steps
}

// ── CTR mode — turn the block cipher into a stream cipher (SP 800-38A) ─────────
// GCM builds its keystream this way; exposed here so the lab can show raw AES-CTR
// next to the authenticated modes.

function inc32(ctr: Uint8Array): void {
  // increment the low 32 bits (big-endian), as GCM's GCTR does
  for (let i = 15; i >= 12; i--) {
    ctr[i] = (ctr[i] + 1) & 0xff
    if (ctr[i] !== 0) break
  }
}

/** AES-CTR: XOR the input with the keystream E_K(ctr), E_K(ctr+1), … The initial
 *  counter block is 16 bytes; only its low 32 bits are incremented (GCM style). */
export function ctr(key: Uint8Array | AesKey, initialCounter: Uint8Array, input: Uint8Array): Uint8Array {
  const k = 'roundKeys' in key ? key : expandKey(key)
  const out = new Uint8Array(input.length)
  const counter = initialCounter.slice(0, 16)
  for (let off = 0; off < input.length; off += 16) {
    const ks = encryptBlock(k, counter)
    const n = Math.min(16, input.length - off)
    for (let i = 0; i < n; i++) out[off + i] = input[off + i] ^ ks[i]
    inc32(counter)
  }
  return out
}
