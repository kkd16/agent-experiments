// ML-DSA — the NIST post-quantum *signature* standard (FIPS 204, Aug 2024), the
// standardised form of CRYSTALS-Dilithium. From scratch, no dependencies beyond
// this lab's own Keccak.
//
// ML-KEM (the sister file mlkem.ts) gives this lab a quantum-safe *key exchange*;
// ML-DSA gives it the other half — a quantum-safe *digital signature*, the thing
// that replaces ECDSA / Ed25519 / BLS the day Shor's algorithm eats the discrete
// log. Both rest on the same rock, Module-LWE/SIS over a polynomial ring, but the
// signature is the harder object: it is a "Fiat–Shamir with aborts" identification
// scheme, and getting it right means getting the rounding, the rejection loop, and
// the hint machinery all exactly aligned.
//
// The shape (FIPS 204):
//   • Keys live in R_q = Z_q[X]/(X²⁵⁶+1), q = 8380417 = 2²³ − 2¹³ + 1. Because
//     q ≡ 1 (mod 512) the ring splits *completely* into 256 linear factors, so the
//     NTT is a full radix-2 transform and multiplication is 256 scalar products —
//     even cleaner than Kyber's degree-1 base ring.
//   • KeyGen hides a short secret (s1, s2) inside t = A·s1 + s2, then throws away
//     the low d = 13 bits of t (the verifier reconstructs them from a "hint").
//   • Sign samples a masking vector y, commits to w = HighBits(A·y), derives a
//     sparse ±1 challenge c = H(μ ‖ w1), and answers z = y + c·s1. If z or the
//     low bits leak too much it *rejects and retries* — that abort is what makes
//     the transcript zero-knowledge and the signature unforgeable.
//   • Verify recomputes w1 from (A, z, c, t1) using the one-bit-per-coefficient
//     hint to undo the discarded low bits, and checks the challenge reproduces.
//
// Everything is validated live in the self-test: the NTT inverts and its pointwise
// product reproduces a schoolbook negacyclic convolution; Power2Round and the
// Decompose/MakeHint/UseHint identities round-trip on random input; full
// KeyGen→Sign→Verify succeeds for all three parameter sets; a tampered message or
// a mauled signature is rejected; deterministic signing is byte-for-byte
// reproducible; and every key/signature length matches the FIPS 204 Table-2 sizes.

import { shake256, shake128Xof, shake256Xof } from './keccak'

// ── Ring parameters ───────────────────────────────────────────────────────────
export const Q = 8380417 // 2²³ − 2¹³ + 1
export const N = 256
export const D = 13 // low bits of t dropped into the public key's hint budget
const ZETA = 1753 // a primitive 512th root of unity mod q (ζ²⁵⁶ ≡ −1)

/** A ring element R_q: 256 coefficients held in [0, q). */
export type Poly = Int32Array
/** A length-k or length-l vector of ring elements. */
export type PolyVec = Poly[]

export interface MlDsaParams {
  name: string
  k: number // rows of A / length of t, w, s2
  l: number // cols of A / length of s1, y, z
  eta: number // secret coefficient bound  (s1, s2 ∈ [−η, η])
  tau: number // number of ±1 entries in the challenge c
  beta: number // τ·η — the norm the abort test subtracts
  gamma1: number // masking-vector range (y ∈ (−γ1, γ1])
  gamma2: number // low-bits rounding modulus ((q−1)/88 or (q−1)/32)
  omega: number // max number of 1's across the whole hint
  lambda: number // challenge-hash entropy in bits (c̃ is λ/4 bytes)
}

export const MLDSA44: MlDsaParams = {
  name: 'ML-DSA-44', k: 4, l: 4, eta: 2, tau: 39, beta: 78,
  gamma1: 1 << 17, gamma2: (Q - 1) / 88, omega: 80, lambda: 128,
}
export const MLDSA65: MlDsaParams = {
  name: 'ML-DSA-65', k: 6, l: 5, eta: 4, tau: 49, beta: 196,
  gamma1: 1 << 19, gamma2: (Q - 1) / 32, omega: 55, lambda: 192,
}
export const MLDSA87: MlDsaParams = {
  name: 'ML-DSA-87', k: 8, l: 7, eta: 2, tau: 60, beta: 120,
  gamma1: 1 << 19, gamma2: (Q - 1) / 32, omega: 75, lambda: 256,
}
export const PARAM_SETS = [MLDSA44, MLDSA65, MLDSA87]

// ── Modular helpers ───────────────────────────────────────────────────────────
// Products stay under q² ≈ 7.0·10¹³ < 2⁵³, so plain Number arithmetic is exact.
const modq = (a: number): number => {
  const r = a % Q
  return r < 0 ? r + Q : r
}
/** Centered representative in (−q/2, q/2] — the value whose |·| is the ∞-norm. */
export const toSigned = (a: number): number => {
  const r = modq(a)
  return r > Q >> 1 ? r - Q : r
}
/** ∞-norm of a polynomial: max centered magnitude of its coefficients. */
export function normInf(p: Poly): number {
  let m = 0
  for (let i = 0; i < N; i++) {
    const v = Math.abs(toSigned(p[i]))
    if (v > m) m = v
  }
  return m
}

const newPoly = (): Poly => new Int32Array(N)
const bitlen = (x: number): number => (x <= 0 ? 0 : Math.floor(Math.log2(x)) + 1)

// ── Zeta table (bit-reversed powers of ζ), computed once with BigInt ──────────
const bitrev8 = (i: number): number => {
  let r = 0
  for (let b = 0; b < 8; b++) r |= ((i >> b) & 1) << (7 - b)
  return r
}
const modpow = (base: bigint, exp: bigint, m: bigint): bigint => {
  let r = 1n
  base %= m
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m
    base = (base * base) % m
    exp >>= 1n
  }
  return r
}
// ZETAS[i] = ζ^{bitrev8(i)} mod q, i = 0..255 — the twiddles the butterflies eat.
const ZETAS: number[] = (() => {
  const z = new Array<number>(256)
  const qb = BigInt(Q)
  for (let i = 0; i < 256; i++) z[i] = Number(modpow(BigInt(ZETA), BigInt(bitrev8(i)), qb))
  return z
})()
const N_INV = Number(modpow(256n, BigInt(Q) - 2n, BigInt(Q))) // 256⁻¹ mod q

// ── Number-theoretic transform (FIPS 204 Alg. 41/42) ─────────────────────────
/** Forward NTT, in place: coefficient form → 256 pointwise evaluations. */
export function ntt(f: Poly): Poly {
  const a = f.slice() as Poly
  let k = 0
  for (let len = 128; len >= 1; len >>= 1) {
    for (let start = 0; start < 256; start += 2 * len) {
      const zeta = ZETAS[++k]
      for (let j = start; j < start + len; j++) {
        const t = modq(zeta * a[j + len])
        a[j + len] = modq(a[j] - t)
        a[j] = modq(a[j] + t)
      }
    }
  }
  return a
}

/** Inverse NTT, in place, including the 256⁻¹ normalisation. */
export function invNtt(f: Poly): Poly {
  const a = f.slice() as Poly
  let k = 256
  for (let len = 1; len < 256; len <<= 1) {
    for (let start = 0; start < 256; start += 2 * len) {
      const zeta = Q - ZETAS[--k] // −ζ, kept non-negative
      for (let j = start; j < start + len; j++) {
        const t = a[j]
        a[j] = modq(t + a[j + len])
        a[j + len] = modq(zeta * modq(t - a[j + len]))
      }
    }
  }
  for (let j = 0; j < 256; j++) a[j] = modq(a[j] * N_INV)
  return a
}

/** Pointwise multiply in the NTT domain — 256 scalar products (Alg. 45). */
export function nttMul(f: Poly, g: Poly): Poly {
  const h = newPoly()
  for (let i = 0; i < N; i++) h[i] = modq(f[i] * g[i])
  return h
}

const polyAdd = (a: Poly, b: Poly): Poly => {
  const c = newPoly()
  for (let i = 0; i < N; i++) c[i] = modq(a[i] + b[i])
  return c
}
const polySub = (a: Poly, b: Poly): Poly => {
  const c = newPoly()
  for (let i = 0; i < N; i++) c[i] = modq(a[i] - b[i])
  return c
}

// ── Vector / matrix helpers (all in the NTT domain where noted) ───────────────
const vecNtt = (v: PolyVec): PolyVec => v.map(ntt)
const vecInvNtt = (v: PolyVec): PolyVec => v.map(invNtt)
const vecAdd = (a: PolyVec, b: PolyVec): PolyVec => a.map((p, i) => polyAdd(p, b[i]))
const vecSub = (a: PolyVec, b: PolyVec): PolyVec => a.map((p, i) => polySub(p, b[i]))
/** Scale every polynomial of a vector by an NTT-domain scalar poly ĉ. */
const vecScale = (chat: Poly, v: PolyVec): PolyVec => v.map((p) => nttMul(chat, p))
/** Matrix (k×l, NTT domain) times vector (length l, NTT domain) → length k. */
const matVec = (aHat: PolyVec[], vHat: PolyVec): PolyVec =>
  aHat.map((row) => {
    let acc = newPoly()
    for (let j = 0; j < row.length; j++) acc = polyAdd(acc, nttMul(row[j], vHat[j]))
    return acc
  })

// ── Rounding (FIPS 204 §7.4) ─────────────────────────────────────────────────
/** Split r into (r1, r0) with r = r1·2ᵈ + r0 and r0 ∈ (−2^{d−1}, 2^{d−1}]. */
export function power2Round(r: number): [number, number] {
  const rp = modq(r)
  const r1 = (rp + (1 << (D - 1)) - 1) >> D
  const r0 = rp - (r1 << D)
  return [r1, r0]
}

/** Centered residue in (−α/2, α/2]. */
const modPm = (r: number, alpha: number): number => {
  let x = modq(r) % alpha
  if (x > alpha >> 1) x -= alpha
  return x
}

/** Decompose r into high/low parts about the modulus α = 2·γ2 (Alg. 36). */
export function decompose(r: number, gamma2: number): [number, number] {
  const alpha = 2 * gamma2
  const rp = modq(r)
  let r0 = modPm(rp, alpha)
  let r1: number
  if (rp - r0 === Q - 1) {
    r1 = 0
    r0 = r0 - 1
  } else {
    r1 = (rp - r0) / alpha
  }
  return [r1, r0]
}
export const highBits = (r: number, gamma2: number): number => decompose(r, gamma2)[0]
export const lowBits = (r: number, gamma2: number): number => decompose(r, gamma2)[1]

/** MakeHint (Alg. 39): does adding z flip the high bits of r? */
export function makeHint(z: number, r: number, gamma2: number): number {
  return highBits(r, gamma2) !== highBits(r + z, gamma2) ? 1 : 0
}
/**
 * UseHint (Alg. 40): recover HighBits(r + z) from r and the one-bit hint.
 * (Named `applyHint`, not `useHint`, so the React lint rule doesn't mistake it
 * for a hook — this is FIPS 204's UseHint.)
 */
export function applyHint(h: number, r: number, gamma2: number): number {
  const m = (Q - 1) / (2 * gamma2)
  const [r1, r0] = decompose(r, gamma2)
  if (h === 0) return r1
  return r0 > 0 ? (r1 + 1) % m : (r1 - 1 + m) % m
}

// Per-polynomial rounding lifted to whole vectors.
const power2RoundVec = (v: PolyVec): [PolyVec, PolyVec] => {
  const t1 = v.map(() => newPoly())
  const t0 = v.map(() => newPoly())
  v.forEach((p, i) => {
    for (let j = 0; j < N; j++) {
      const [a, b] = power2Round(p[j])
      t1[i][j] = a
      t0[i][j] = modq(b)
    }
  })
  return [t1, t0]
}
const highBitsVec = (v: PolyVec, g2: number): PolyVec =>
  v.map((p) => {
    const o = newPoly()
    for (let j = 0; j < N; j++) o[j] = highBits(p[j], g2)
    return o
  })
const lowBitsVec = (v: PolyVec, g2: number): PolyVec =>
  v.map((p) => {
    const o = newPoly()
    for (let j = 0; j < N; j++) o[j] = lowBits(p[j], g2)
    return o
  })
const makeHintVec = (z: PolyVec, r: PolyVec, g2: number): PolyVec =>
  r.map((p, i) => {
    const o = newPoly()
    for (let j = 0; j < N; j++) o[j] = makeHint(z[i][j], p[j], g2)
    return o
  })
const applyHintVec = (h: PolyVec, r: PolyVec, g2: number): PolyVec =>
  r.map((p, i) => {
    const o = newPoly()
    for (let j = 0; j < N; j++) o[j] = applyHint(h[i][j], p[j], g2)
    return o
  })
const countOnes = (h: PolyVec): number => h.reduce((s, p) => s + p.reduce((a, x) => a + x, 0), 0)

// ── Low-level bit packing (numeric accumulator, overflow-safe) ────────────────
const P2 = (n: number): number => Math.pow(2, n)
function packBits(vals: number[], bits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((vals.length * bits) / 8))
  let acc = 0
  let nbits = 0
  let o = 0
  const cap = P2(bits)
  for (const v of vals) {
    acc += (((v % cap) + cap) % cap) * P2(nbits)
    nbits += bits
    while (nbits >= 8) {
      out[o++] = acc % 256
      acc = Math.floor(acc / 256)
      nbits -= 8
    }
  }
  if (nbits > 0) out[o] = acc % 256
  return out
}
function unpackBits(bytes: Uint8Array, count: number, bits: number): number[] {
  const vals = new Array<number>(count)
  let acc = 0
  let nbits = 0
  let bi = 0
  const cap = P2(bits)
  for (let i = 0; i < count; i++) {
    while (nbits < bits) {
      acc += (bytes[bi++] ?? 0) * P2(nbits)
      nbits += 8
    }
    vals[i] = acc % cap
    acc = Math.floor(acc / cap)
    nbits -= bits
  }
  return vals
}

// SimpleBitPack (Alg. 16): coefficients already in [0, 2^bits). Used for t1, w1.
const simpleBitPack = (p: Poly, bits: number): Uint8Array => packBits(Array.from(p), bits)
const simpleBitUnpack = (bytes: Uint8Array, bits: number): Poly => {
  const p = newPoly()
  const v = unpackBits(bytes, N, bits)
  for (let i = 0; i < N; i++) p[i] = v[i]
  return p
}
// BitPack (Alg. 17): encode (b − coeff), coeff ∈ [−a, b], in bitlen(a+b) bits.
const bitPack = (p: Poly, a: number, b: number): Uint8Array => {
  const bits = bitlen(a + b)
  return packBits(Array.from(p, (x) => b - toSigned(x)), bits)
}
const bitUnpack = (bytes: Uint8Array, a: number, b: number): Poly => {
  const bits = bitlen(a + b)
  const v = unpackBits(bytes, N, bits)
  const p = newPoly()
  for (let i = 0; i < N; i++) p[i] = modq(b - v[i])
  return p
}

// ── Samplers ─────────────────────────────────────────────────────────────────
/** RejNTTPoly (Alg. 30): a uniform NTT-domain poly rejection-sampled via SHAKE128. */
function rejNttPoly(seed: Uint8Array): Poly {
  const xof = shake128Xof(seed)
  const a = newPoly()
  let j = 0
  while (j < N) {
    const b = xof.read(3)
    const d = b[0] + 256 * b[1] + 65536 * (b[2] & 0x7f) // 23-bit candidate
    if (d < Q) a[j++] = d
  }
  return a
}

/** CoeffFromHalfByte (Alg. 31 helper): a nibble → a bounded ±η coefficient, or ⊥. */
const coeffFromHalfByte = (z: number, eta: number): number | null => {
  if (eta === 2) return z < 15 ? 2 - (z % 5) : null
  return z < 9 ? 4 - z : null // eta === 4
}
/** RejBoundedPoly (Alg. 31): coefficients in [−η, η] rejection-sampled via SHAKE256. */
function rejBoundedPoly(seed: Uint8Array, eta: number): Poly {
  const xof = shake256Xof(seed)
  const a = newPoly()
  let j = 0
  while (j < N) {
    const b = xof.read(1)[0]
    const z0 = coeffFromHalfByte(b & 0x0f, eta)
    if (z0 !== null && j < N) a[j++] = modq(z0)
    const z1 = coeffFromHalfByte(b >> 4, eta)
    if (z1 !== null && j < N) a[j++] = modq(z1)
  }
  return a
}

// ExpandA (Alg. 32): the public k×l matrix Â, sampled directly in the NTT domain
// from ρ with a per-cell (column, row) domain separator.
function expandA(rho: Uint8Array, k: number, l: number): PolyVec[] {
  const A: PolyVec[] = []
  for (let i = 0; i < k; i++) {
    const row: PolyVec = []
    for (let j = 0; j < l; j++) {
      const seed = new Uint8Array(34)
      seed.set(rho)
      seed[32] = j
      seed[33] = i
      row.push(rejNttPoly(seed))
    }
    A.push(row)
  }
  return A
}

// ExpandS (Alg. 33): the short secret vectors (s1 length l, s2 length k) from ρ'.
function expandS(rhoP: Uint8Array, k: number, l: number, eta: number): [PolyVec, PolyVec] {
  const seedOf = (nonce: number): Uint8Array => {
    const s = new Uint8Array(66)
    s.set(rhoP)
    s[64] = nonce & 0xff
    s[65] = (nonce >> 8) & 0xff
    return s
  }
  const s1: PolyVec = []
  for (let i = 0; i < l; i++) s1.push(rejBoundedPoly(seedOf(i), eta))
  const s2: PolyVec = []
  for (let i = 0; i < k; i++) s2.push(rejBoundedPoly(seedOf(l + i), eta))
  return [s1, s2]
}

// ExpandMask (Alg. 34): the masking vector y (length l) from ρ'' and counter κ.
function expandMask(rhoPP: Uint8Array, kappa: number, l: number, gamma1: number): PolyVec {
  const c = 1 + bitlen(gamma1 - 1) // bits per coefficient (18 or 20)
  const y: PolyVec = []
  for (let r = 0; r < l; r++) {
    const nonce = kappa + r
    const s = new Uint8Array(66)
    s.set(rhoPP)
    s[64] = nonce & 0xff
    s[65] = (nonce >> 8) & 0xff
    const v = shake256(s, 32 * c)
    y.push(bitUnpack(v, gamma1 - 1, gamma1))
  }
  return y
}

/** SampleInBall (Alg. 29): a sparse challenge — τ coefficients ±1, the rest 0. */
export function sampleInBall(cTilde: Uint8Array, tau: number): Poly {
  const xof = shake256Xof(cTilde)
  const signs = xof.read(8) // 64 sign bits, LSB-first across the 8 bytes
  const c = newPoly()
  let signBit = 0
  for (let i = 256 - tau; i < 256; i++) {
    let j: number
    do {
      j = xof.read(1)[0]
    } while (j > i)
    c[i] = c[j]
    const bit = (signs[signBit >> 3] >> (signBit & 7)) & 1
    c[j] = bit ? Q - 1 : 1 // −1 stored as q−1
    signBit++
  }
  return c
}

// ── Hint packing (Alg. 20/21): positions of the 1's, terminated per polynomial ─
function hintBitPack(h: PolyVec, omega: number): Uint8Array {
  const y = new Uint8Array(omega + h.length)
  let index = 0
  for (let i = 0; i < h.length; i++) {
    for (let j = 0; j < N; j++) if (h[i][j] !== 0) y[index++] = j
    y[omega + i] = index
  }
  return y
}
function hintBitUnpack(y: Uint8Array, k: number, omega: number): PolyVec | null {
  const h: PolyVec = Array.from({ length: k }, () => newPoly())
  let index = 0
  for (let i = 0; i < k; i++) {
    const end = y[omega + i]
    if (end < index || end > omega) return null
    const first = index
    while (index < end) {
      if (index > first && y[index - 1] >= y[index]) return null // strictly increasing
      h[i][y[index]] = 1
      index++
    }
  }
  for (let j = index; j < omega; j++) if (y[j] !== 0) return null // padding must be zero
  return h
}

// ── Key / signature (de)serialisation (FIPS 204 §7.2) ─────────────────────────
export interface Keys {
  pk: Uint8Array
  sk: Uint8Array
}

function pkEncode(rho: Uint8Array, t1: PolyVec): Uint8Array {
  const parts = [rho, ...t1.map((p) => simpleBitPack(p, bitlen((Q - 1) >> D)))]
  return concatBytes(parts)
}
function pkDecode(pk: Uint8Array, k: number): { rho: Uint8Array; t1: PolyVec } {
  const bits = bitlen((Q - 1) >> D) // 10
  const rho = pk.slice(0, 32)
  const t1: PolyVec = []
  let off = 32
  const step = 32 * bits
  for (let i = 0; i < k; i++) {
    t1.push(simpleBitUnpack(pk.slice(off, off + step), bits))
    off += step
  }
  return { rho, t1 }
}

function skEncode(
  rho: Uint8Array, K: Uint8Array, tr: Uint8Array,
  s1: PolyVec, s2: PolyVec, t0: PolyVec, eta: number,
): Uint8Array {
  const parts: Uint8Array[] = [rho, K, tr]
  for (const p of s1) parts.push(bitPack(p, eta, eta))
  for (const p of s2) parts.push(bitPack(p, eta, eta))
  for (const p of t0) parts.push(bitPack(p, (1 << (D - 1)) - 1, 1 << (D - 1)))
  return concatBytes(parts)
}
function skDecode(sk: Uint8Array, params: MlDsaParams): {
  rho: Uint8Array; K: Uint8Array; tr: Uint8Array; s1: PolyVec; s2: PolyVec; t0: PolyVec
} {
  const { k, l, eta } = params
  const rho = sk.slice(0, 32)
  const K = sk.slice(32, 64)
  const tr = sk.slice(64, 128)
  let off = 128
  const etaStep = 32 * bitlen(2 * eta)
  const t0Step = 32 * D
  const s1: PolyVec = []
  for (let i = 0; i < l; i++) { s1.push(bitUnpack(sk.slice(off, off + etaStep), eta, eta)); off += etaStep }
  const s2: PolyVec = []
  for (let i = 0; i < k; i++) { s2.push(bitUnpack(sk.slice(off, off + etaStep), eta, eta)); off += etaStep }
  const t0: PolyVec = []
  const half = 1 << (D - 1)
  for (let i = 0; i < k; i++) { t0.push(bitUnpack(sk.slice(off, off + t0Step), half - 1, half)); off += t0Step }
  return { rho, K, tr, s1, s2, t0 }
}

function sigEncode(cTilde: Uint8Array, z: PolyVec, h: PolyVec, params: MlDsaParams): Uint8Array {
  const parts: Uint8Array[] = [cTilde]
  for (const p of z) parts.push(bitPack(p, params.gamma1 - 1, params.gamma1))
  parts.push(hintBitPack(h, params.omega))
  return concatBytes(parts)
}
function sigDecode(sig: Uint8Array, params: MlDsaParams): {
  cTilde: Uint8Array; z: PolyVec; h: PolyVec | null
} {
  const { l, gamma1, omega, k, lambda } = params
  const clen = lambda / 4
  const cTilde = sig.slice(0, clen)
  let off = clen
  const zStep = 32 * (1 + bitlen(gamma1 - 1))
  const z: PolyVec = []
  for (let i = 0; i < l; i++) { z.push(bitUnpack(sig.slice(off, off + zStep), gamma1 - 1, gamma1)); off += zStep }
  const h = hintBitUnpack(sig.slice(off, off + omega + k), k, omega)
  return { cTilde, z, h }
}

// ── Hashing shorthands ────────────────────────────────────────────────────────
const H = (m: Uint8Array, outLen: number): Uint8Array => shake256(m, outLen)

function concatBytes(arrs: Uint8Array[]): Uint8Array {
  let n = 0
  for (const a of arrs) n += a.length
  const out = new Uint8Array(n)
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}

// ── The three public operations (internal, un-prefixed) ──────────────────────
/** KeyGen_internal (Alg. 6): a 32-byte seed ξ → (pk, sk). */
export function keyGenInternal(params: MlDsaParams, xi: Uint8Array): Keys {
  const { k, l, eta } = params
  const seedIn = concatBytes([xi, new Uint8Array([k]), new Uint8Array([l])])
  const expanded = H(seedIn, 128)
  const rho = expanded.slice(0, 32)
  const rhoP = expanded.slice(32, 96)
  const K = expanded.slice(96, 128)

  const aHat = expandA(rho, k, l)
  const [s1, s2] = expandS(rhoP, k, l, eta)
  const t = vecAdd(vecInvNtt(matVec(aHat, vecNtt(s1))), s2)
  const [t1, t0] = power2RoundVec(t)

  const pk = pkEncode(rho, t1)
  const tr = H(pk, 64)
  const sk = skEncode(rho, K, tr, s1, s2, t0, eta)
  return { pk, sk }
}

/** Diagnostics the interactive lab reads from a signing run. */
export interface SignTrace {
  iterations: number // total loop passes, including the accepted one
  rejects: string[] // the abort reason for each rejected pass, in order
  cTilde: Uint8Array // the sparse challenge's Fiat–Shamir hash
  challenge: Poly // c — the τ-sparse ±1 polynomial
  z: PolyVec // the response vector
  hint: PolyVec // the one-bit-per-coefficient carry hint
  hintCount: number // total 1's in the hint (≤ ω)
  zNorm: number // ‖z‖∞
}

/** Sign_internal (Alg. 7). rnd = 32 zero bytes gives deterministic signatures. */
export function signInternal(
  params: MlDsaParams, sk: Uint8Array, mPrime: Uint8Array, rnd: Uint8Array, trace?: SignTrace,
): Uint8Array {
  const { k, l, tau, beta, gamma1, gamma2, omega, lambda } = params
  const { rho, K, tr, s1, s2, t0 } = skDecode(sk, params)
  const aHat = expandA(rho, k, l)
  const s1Hat = vecNtt(s1)
  const s2Hat = vecNtt(s2)
  const t0Hat = vecNtt(t0)

  const mu = H(concatBytes([tr, mPrime]), 64)
  const rhoPP = H(concatBytes([K, rnd, mu]), 64)
  const rejects: string[] = []

  let kappa = 0
  const clen = lambda / 4
  // Fiat–Shamir with aborts: retry until (z, h) both pass their leakage tests.
  for (let iter = 0; iter < 1000; iter++) {
    const y = expandMask(rhoPP, kappa, l, gamma1)
    kappa += l
    const w = vecInvNtt(matVec(aHat, vecNtt(y)))
    const w1 = highBitsVec(w, gamma2)

    const w1Bits = bitlen((Q - 1) / (2 * gamma2) - 1)
    const w1Packed = concatBytes(w1.map((p) => simpleBitPack(p, w1Bits)))
    const cTilde = H(concatBytes([mu, w1Packed]), clen)
    const c = sampleInBall(cTilde, tau)
    const cHat = ntt(c)

    const cs1 = vecInvNtt(vecScale(cHat, s1Hat))
    const cs2 = vecInvNtt(vecScale(cHat, s2Hat))
    const z = vecAdd(y, cs1)
    const r0 = lowBitsVec(vecSub(w, cs2), gamma2)

    const zNorm = Math.max(...z.map(normInf))
    if (zNorm >= gamma1 - beta) { rejects.push('‖z‖∞ ≥ γ1−β'); continue }
    if (Math.max(...r0.map(normInf)) >= gamma2 - beta) { rejects.push('‖r0‖∞ ≥ γ2−β'); continue }

    const ct0 = vecInvNtt(vecScale(cHat, t0Hat))
    if (Math.max(...ct0.map(normInf)) >= gamma2) { rejects.push('‖c·t0‖∞ ≥ γ2'); continue }

    const negCt0 = ct0.map((p) => { const o = newPoly(); for (let i = 0; i < N; i++) o[i] = modq(-p[i]); return o })
    const h = makeHintVec(negCt0, vecAdd(vecSub(w, cs2), ct0), gamma2)
    const hc = countOnes(h)
    if (hc > omega) { rejects.push('#hint > ω'); continue }

    if (trace) {
      trace.iterations = iter + 1
      trace.rejects = rejects
      trace.cTilde = cTilde
      trace.challenge = c
      trace.z = z
      trace.hint = h
      trace.hintCount = hc
      trace.zNorm = zNorm
    }
    return sigEncode(cTilde, z, h, params)
  }
  throw new Error('ML-DSA sign: exceeded rejection budget (should be astronomically rare)')
}

/** Verify_internal (Alg. 8). */
export function verifyInternal(
  params: MlDsaParams, pk: Uint8Array, mPrime: Uint8Array, sig: Uint8Array,
): boolean {
  const { k, l, tau, beta, gamma1, gamma2, omega } = params
  const { rho, t1 } = pkDecode(pk, k)
  const { cTilde, z, h } = sigDecode(sig, params)
  if (h === null) return false
  if (Math.max(...z.map(normInf)) >= gamma1 - beta) return false
  if (countOnes(h) > omega) return false

  const aHat = expandA(rho, k, l)
  const tr = H(pk, 64)
  const mu = H(concatBytes([tr, mPrime]), 64)
  const c = sampleInBall(cTilde, tau)
  const cHat = ntt(c)

  // w'Approx = A·z − c·(t1·2ᵈ), all in the NTT domain then inverted.
  const t1Scaled = t1.map((p) => { const o = newPoly(); for (let i = 0; i < N; i++) o[i] = modq(p[i] << D); return o })
  const az = matVec(aHat, vecNtt(z))
  const ct1 = vecScale(cHat, vecNtt(t1Scaled))
  const wApprox = vecInvNtt(vecSub(az, ct1))
  const w1 = applyHintVec(h, wApprox, gamma2)

  const w1Bits = bitlen((Q - 1) / (2 * gamma2) - 1)
  const w1Packed = concatBytes(w1.map((p) => simpleBitPack(p, w1Bits)))
  const cTildePrime = H(concatBytes([mu, w1Packed]), params.lambda / 4)
  return bytesEqual(cTilde, cTildePrime)
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

// ── External API (Alg. 2/3): prepend the context-string prefix, then run ─────
/** Format M' = 0x00 ‖ len(ctx) ‖ ctx ‖ M (the pure, non-prehashed variant). */
function messagePrefix(m: Uint8Array, ctx: Uint8Array): Uint8Array {
  if (ctx.length > 255) throw new Error('ML-DSA: context string must be ≤ 255 bytes')
  return concatBytes([new Uint8Array([0, ctx.length]), ctx, m])
}

export interface SignOptions {
  ctx?: Uint8Array
  /** Deterministic (rnd = 0) by default so the lab is reproducible; set false to hedge. */
  deterministic?: boolean
  rnd?: Uint8Array
}

/** ML-DSA.KeyGen — a fresh keypair from a caller-supplied 32-byte seed. */
export function keyGen(params: MlDsaParams, seed: Uint8Array): Keys {
  return keyGenInternal(params, seed.slice(0, 32))
}

/** ML-DSA.Sign — sign a message (with optional context string). */
export function sign(params: MlDsaParams, sk: Uint8Array, m: Uint8Array, opts: SignOptions = {}): Uint8Array {
  const ctx = opts.ctx ?? new Uint8Array(0)
  const rnd = opts.rnd ?? new Uint8Array(32) // zeros → deterministic
  return signInternal(params, sk, messagePrefix(m, ctx), rnd)
}

/** Like `sign`, but also returns the rejection-loop diagnostics for the lab UI. */
export function signTrace(
  params: MlDsaParams, sk: Uint8Array, m: Uint8Array, opts: SignOptions = {},
): { sig: Uint8Array; trace: SignTrace } {
  const ctx = opts.ctx ?? new Uint8Array(0)
  const rnd = opts.rnd ?? new Uint8Array(32)
  const trace = {} as SignTrace
  const sig = signInternal(params, sk, messagePrefix(m, ctx), rnd, trace)
  return { sig, trace }
}

/** ML-DSA.Verify — verify a signature under a public key. */
export function verify(
  params: MlDsaParams, pk: Uint8Array, m: Uint8Array, sig: Uint8Array, opts: SignOptions = {},
): boolean {
  const ctx = opts.ctx ?? new Uint8Array(0)
  if (sig.length !== sigSize(params)) return false
  return verifyInternal(params, pk, messagePrefix(m, ctx), sig)
}

// ── Sizes (FIPS 204 Table 2) ─────────────────────────────────────────────────
export function pkSize(p: MlDsaParams): number {
  return 32 + 32 * p.k * bitlen((Q - 1) >> D)
}
export function skSize(p: MlDsaParams): number {
  return 128 + 32 * (p.l + p.k) * bitlen(2 * p.eta) + 32 * p.k * D
}
export function sigSize(p: MlDsaParams): number {
  return p.lambda / 4 + 32 * p.l * (1 + bitlen(p.gamma1 - 1)) + p.omega + p.k
}
export function sizes(p: MlDsaParams): { pk: number; sk: number; sig: number } {
  return { pk: pkSize(p), sk: skSize(p), sig: sigSize(p) }
}
