// ML-KEM — the NIST post-quantum key-encapsulation standard (FIPS 203, Aug 2024),
// the standardised form of CRYSTALS-Kyber. From scratch, no dependencies beyond
// this lab's own Keccak.
//
// This is the lab's first *lattice* scheme. Everything else here — ECDH, ECDSA,
// BLS, the SNARKs — dies the day someone builds a large quantum computer, because
// Shor's algorithm eats the discrete log. ML-KEM rests instead on Module-LWE:
// recovering a short secret from `t = A·s + e` over the ring R_q = Z_q[X]/(X²⁵⁶+1),
// q = 3329, which no known quantum algorithm solves.
//
// The construction is two layers:
//   • K-PKE  — an IND-CPA public-key encryption (LPR-style: mask the message with
//              a noisy inner product, decrypt by cancelling A·s and rounding).
//   • ML-KEM — the Fujisaki–Okamoto transform around K-PKE: derive all randomness
//              from the message, re-encrypt on decapsulation, and fall back to a
//              secret pseudorandom key on mismatch ("implicit rejection"). That
//              upgrades IND-CPA to IND-CCA2 — safe under active, adaptive attack.
//
// The fast heart is the number-theoretic transform: q ≡ 1 (mod 256), so X²⁵⁶+1
// splits into 128 quadratics mod q and a degree-256 multiply becomes 128 tiny
// 2×2 products. Validated by full KeyGen→Encaps→Decaps round-trips (a single bug
// in the NTT, base multiply, compression, or FO wiring breaks the shared secret)
// and by the standard implicit-rejection behaviour on a mauled ciphertext.

import { sha3_256, sha3_512, shake256, shake128Xof } from './keccak'

// ── Ring parameters ───────────────────────────────────────────────────────────
export const Q = 3329
export const N = 256
const ZETA = 17 // a primitive 256th root of unity mod q
const INV_N = 3303 // 128⁻¹ mod q (the NTT normaliser: 2·128 = 256 butterflies)

/** A ring element R_q = Z_q[X]/(X²⁵⁶+1): 256 coefficients, always reduced. */
export type Poly = Int16Array
/** A length-k vector of ring elements. */
export type PolyVec = Poly[]

export interface MlKemParams {
  name: string
  k: number // module rank
  eta1: number // key/message noise width
  eta2: number // ciphertext noise width
  du: number // ciphertext u compression bits
  dv: number // ciphertext v compression bits
}

export const MLKEM512: MlKemParams = { name: 'ML-KEM-512', k: 2, eta1: 3, eta2: 2, du: 10, dv: 4 }
export const MLKEM768: MlKemParams = { name: 'ML-KEM-768', k: 3, eta1: 2, eta2: 2, du: 10, dv: 4 }
export const MLKEM1024: MlKemParams = { name: 'ML-KEM-1024', k: 4, eta1: 2, eta2: 2, du: 11, dv: 5 }
export const PARAM_SETS = [MLKEM512, MLKEM768, MLKEM1024]

// ── Modular helpers ─────────────────────────────────────────────────────────
const mod = (a: number): number => {
  const r = a % Q
  return r < 0 ? r + Q : r
}
// Reduce a signed value into the symmetric range (−q/2, q/2] — used only for
// display so the "short" secrets read as small ±numbers, not near-q values.
export const toSigned = (a: number): number => {
  const r = mod(a)
  return r > Q >> 1 ? r - Q : r
}

const newPoly = (): Poly => new Int16Array(N)

// ── Zeta tables (bit-reversed powers of 17), computed once ────────────────────
const bitrev7 = (i: number): number => {
  let r = 0
  for (let b = 0; b < 7; b++) r |= ((i >> b) & 1) << (6 - b)
  return r
}
// zetas[i] = 17^bitrev7(i) mod q, for the Cooley–Tukey butterflies.
const ZETAS: number[] = (() => {
  const pow = new Array<number>(128)
  let acc = 1
  const byExp: number[] = []
  for (let e = 0; e < 128; e++) {
    byExp[e] = acc
    acc = mod(acc * ZETA)
  }
  for (let i = 0; i < 128; i++) pow[i] = byExp[bitrev7(i)]
  return pow
})()
// gammas[i] = 17^(2·bitrev7(i)+1) mod q, the modulus of each degree-2 base ring.
const GAMMAS: number[] = (() => {
  const g = new Array<number>(128)
  for (let i = 0; i < 128; i++) {
    const e = (2 * bitrev7(i) + 1) % 256
    let acc = 1
    for (let j = 0; j < e; j++) acc = mod(acc * ZETA)
    g[i] = acc
  }
  return g
})()

// ── Number-theoretic transform (FIPS 203 Alg. 9/10) ──────────────────────────
/** Forward NTT, in place: coefficient form → evaluation (128 degree-1) form. */
export function ntt(f: Poly): Poly {
  const a = f.slice() as Poly
  let i = 1
  for (let len = 128; len >= 2; len >>= 1) {
    for (let start = 0; start < 256; start += 2 * len) {
      const zeta = ZETAS[i++]
      for (let j = start; j < start + len; j++) {
        const t = mod(zeta * a[j + len])
        a[j + len] = mod(a[j] - t)
        a[j] = mod(a[j] + t)
      }
    }
  }
  return a
}

/** Inverse NTT, in place, including the 128⁻¹ normalisation. */
export function invNtt(f: Poly): Poly {
  const a = f.slice() as Poly
  let i = 127
  for (let len = 2; len <= 128; len <<= 1) {
    for (let start = 0; start < 256; start += 2 * len) {
      const zeta = ZETAS[i--]
      for (let j = start; j < start + len; j++) {
        const t = a[j]
        a[j] = mod(t + a[j + len])
        a[j + len] = mod(zeta * (a[j + len] - t))
      }
    }
  }
  for (let j = 0; j < 256; j++) a[j] = mod(a[j] * INV_N)
  return a
}

/** Multiply two NTT-domain polynomials via the 128 degree-2 base products. */
export function nttMul(f: Poly, g: Poly): Poly {
  const h = newPoly()
  for (let i = 0; i < 128; i++) {
    const a0 = f[2 * i]
    const a1 = f[2 * i + 1]
    const b0 = g[2 * i]
    const b1 = g[2 * i + 1]
    // (a0 + a1 X)(b0 + b1 X) mod (X² − γ):  c0 = a0b0 + a1b1γ,  c1 = a0b1 + a1b0
    h[2 * i] = mod(a0 * b0 + mod(a1 * b1) * GAMMAS[i])
    h[2 * i + 1] = mod(a0 * b1 + a1 * b0)
  }
  return h
}

const polyAdd = (a: Poly, b: Poly): Poly => {
  const c = newPoly()
  for (let i = 0; i < N; i++) c[i] = mod(a[i] + b[i])
  return c
}
const polySub = (a: Poly, b: Poly): Poly => {
  const c = newPoly()
  for (let i = 0; i < N; i++) c[i] = mod(a[i] - b[i])
  return c
}

// ── Compression / decompression (FIPS 203 §4.2.1) ─────────────────────────────
// Compress_d(x) = round(2ᵈ·x / q) mod 2ᵈ, with round-half-up. Written as an
// integer expression: ⌊(2·2ᵈ·x + q) / (2q)⌋ mod 2ᵈ.
export const compress = (x: number, d: number): number => {
  const twoD = 1 << d
  return Math.floor((2 * twoD * mod(x) + Q) / (2 * Q)) & (twoD - 1)
}
// Decompress_d(y) = round(q·y / 2ᵈ) = ⌊(2·q·y + 2ᵈ) / 2^(d+1)⌋.
export const decompress = (y: number, d: number): number => {
  const twoD = 1 << d
  return Math.floor((2 * Q * y + twoD) / (2 * twoD))
}

// ── Byte (de)serialisation (FIPS 203 §4.2.1) ─────────────────────────────────
/** Pack 256 d-bit coefficients little-endian into 32·d bytes. */
export function byteEncode(p: Poly, d: number): Uint8Array {
  const out = new Uint8Array(32 * d)
  let acc = 0
  let bits = 0
  let o = 0
  const mask = d === 12 ? 0xfff : (1 << d) - 1
  for (let i = 0; i < N; i++) {
    acc |= (p[i] & mask) * Math.pow(2, bits)
    bits += d
    while (bits >= 8) {
      out[o++] = acc & 0xff
      acc = Math.floor(acc / 256)
      bits -= 8
    }
  }
  return out
}
/** Inverse of byteEncode: unpack 32·d bytes into 256 d-bit coefficients. */
export function byteDecode(bytes: Uint8Array, d: number): Poly {
  const p = newPoly()
  const mask = (1 << d) - 1
  let acc = 0
  let bits = 0
  let bi = 0
  for (let i = 0; i < N; i++) {
    while (bits < d) {
      acc |= (bytes[bi++] ?? 0) * Math.pow(2, bits)
      bits += 8
    }
    const v = acc & mask
    acc = Math.floor(acc / Math.pow(2, d))
    bits -= d
    // d = 12 decodes the public key; coefficients are reduced mod q (FIPS 203).
    p[i] = d === 12 ? v % Q : v
  }
  return p
}

// ── Sampling ─────────────────────────────────────────────────────────────────
/** SampleNTT (Alg. 7): rejection-sample a uniform NTT-domain poly from an XOF. */
export function sampleNTT(seed: Uint8Array): Poly {
  const xof = shake128Xof(seed)
  const a = newPoly()
  let j = 0
  while (j < N) {
    const b = xof.read(3)
    const d1 = b[0] + 256 * (b[1] & 0x0f)
    const d2 = (b[1] >> 4) + 16 * b[2]
    if (d1 < Q && j < N) a[j++] = d1
    if (d2 < Q && j < N) a[j++] = d2
  }
  return a
}

/** SamplePolyCBD_η (Alg. 8): a centered-binomial noise poly from 64·η bytes. */
export function samplePolyCBD(bytes: Uint8Array, eta: number): Poly {
  const p = newPoly()
  // Treat `bytes` as a bit stream; each coefficient is (Σ η bits) − (Σ η bits).
  const bit = (i: number): number => (bytes[i >> 3] >> (i & 7)) & 1
  for (let i = 0; i < N; i++) {
    let x = 0
    let y = 0
    for (let j = 0; j < eta; j++) x += bit(2 * i * eta + j)
    for (let j = 0; j < eta; j++) y += bit(2 * i * eta + eta + j)
    p[i] = mod(x - y)
  }
  return p
}

// PRF_η (FIPS 203 §4.1): SHAKE256(s ‖ b) → 64·η bytes.
const prf = (eta: number, s: Uint8Array, b: number): Uint8Array => {
  const inp = new Uint8Array(s.length + 1)
  inp.set(s)
  inp[s.length] = b
  return shake256(inp, 64 * eta)
}
// XOF seed for Â[i][j]: ρ ‖ j ‖ i (two index bytes).
const xofSeed = (rho: Uint8Array, i: number, j: number): Uint8Array => {
  const s = new Uint8Array(34)
  s.set(rho)
  s[32] = j
  s[33] = i
  return s
}
// G = SHA3-512 (returns two 32-byte halves); H = SHA3-256; J = SHAKE256→32.
const G = (m: Uint8Array): [Uint8Array, Uint8Array] => {
  const h = sha3_512(m)
  return [h.slice(0, 32), h.slice(32, 64)]
}
const H = (m: Uint8Array): Uint8Array => sha3_256(m)
const J = (m: Uint8Array): Uint8Array => shake256(m, 32)

const cat = (...a: Uint8Array[]): Uint8Array => {
  let n = 0
  for (const x of a) n += x.length
  const out = new Uint8Array(n)
  let o = 0
  for (const x of a) {
    out.set(x, o)
    o += x.length
  }
  return out
}

// ── K-PKE (the IND-CPA core, FIPS 203 §5) ─────────────────────────────────────
export interface KPkeKeys {
  ekPke: Uint8Array // ByteEncode₁₂(t̂) ‖ ρ
  dkPke: Uint8Array // ByteEncode₁₂(ŝ)
  tHat: PolyVec // exposed for the lab's inspector
  sHat: PolyVec
  rho: Uint8Array
  Ahat: Poly[][]
}

/** Build Â[i][j] = SampleNTT(XOF(ρ, i, j)); identical in KeyGen and Encrypt. */
function expandMatrix(rho: Uint8Array, k: number): Poly[][] {
  const A: Poly[][] = []
  for (let i = 0; i < k; i++) {
    A[i] = []
    for (let j = 0; j < k; j++) A[i][j] = sampleNTT(xofSeed(rho, i, j))
  }
  return A
}

export function kpkeKeyGen(params: MlKemParams, d: Uint8Array): KPkeKeys {
  const { k, eta1 } = params
  const [rho, sigma] = G(cat(d, new Uint8Array([k])))
  const Ahat = expandMatrix(rho, k)

  let nonce = 0
  const s: PolyVec = []
  for (let i = 0; i < k; i++) s.push(samplePolyCBD(prf(eta1, sigma, nonce++), eta1))
  const e: PolyVec = []
  for (let i = 0; i < k; i++) e.push(samplePolyCBD(prf(eta1, sigma, nonce++), eta1))

  const sHat = s.map(ntt)
  const eHat = e.map(ntt)
  // t̂ = Â ∘ ŝ + ê
  const tHat: PolyVec = []
  for (let i = 0; i < k; i++) {
    let acc = newPoly()
    for (let j = 0; j < k; j++) acc = polyAdd(acc, nttMul(Ahat[i][j], sHat[j]))
    tHat.push(polyAdd(acc, eHat[i]))
  }

  const ekPke = cat(...tHat.map((p) => byteEncode(p, 12)), rho)
  const dkPke = cat(...sHat.map((p) => byteEncode(p, 12)))
  return { ekPke, dkPke, tHat, sHat, rho, Ahat }
}

export function kpkeEncrypt(params: MlKemParams, ekPke: Uint8Array, msg: Uint8Array, coins: Uint8Array): Uint8Array {
  const { k, eta1, eta2, du, dv } = params
  const tHat: PolyVec = []
  for (let i = 0; i < k; i++) tHat.push(byteDecode(ekPke.subarray(384 * i, 384 * (i + 1)), 12))
  const rho = ekPke.subarray(384 * k, 384 * k + 32)
  const Ahat = expandMatrix(rho, k)

  let nonce = 0
  const r: PolyVec = []
  for (let i = 0; i < k; i++) r.push(samplePolyCBD(prf(eta1, coins, nonce++), eta1))
  const e1: PolyVec = []
  for (let i = 0; i < k; i++) e1.push(samplePolyCBD(prf(eta2, coins, nonce++), eta2))
  const e2 = samplePolyCBD(prf(eta2, coins, nonce), eta2) // final nonce = 2k

  const rHat = r.map(ntt)
  // u = NTT⁻¹(Âᵀ ∘ r̂) + e1
  const u: PolyVec = []
  for (let i = 0; i < k; i++) {
    let acc = newPoly()
    for (let j = 0; j < k; j++) acc = polyAdd(acc, nttMul(Ahat[j][i], rHat[j]))
    u.push(polyAdd(invNtt(acc), e1[i]))
  }
  // v = NTT⁻¹(t̂ᵀ ∘ r̂) + e2 + Decompress₁(m)
  let vAcc = newPoly()
  for (let j = 0; j < k; j++) vAcc = polyAdd(vAcc, nttMul(tHat[j], rHat[j]))
  const mu = decodeMessage(msg)
  const v = polyAdd(polyAdd(invNtt(vAcc), e2), mu)

  const c1 = cat(...u.map((p) => byteEncode(mapPoly(p, (x) => compress(x, du)), du)))
  const c2 = byteEncode(mapPoly(v, (x) => compress(x, dv)), dv)
  return cat(c1, c2)
}

export function kpkeDecrypt(params: MlKemParams, dkPke: Uint8Array, ct: Uint8Array): Uint8Array {
  const { k, du, dv } = params
  const c1Len = 32 * du * k
  const u: PolyVec = []
  for (let i = 0; i < k; i++) {
    const chunk = ct.subarray(32 * du * i, 32 * du * (i + 1))
    u.push(mapPoly(byteDecode(chunk, du), (x) => decompress(x, du)))
  }
  const v = mapPoly(byteDecode(ct.subarray(c1Len, c1Len + 32 * dv), dv), (x) => decompress(x, dv))
  const sHat: PolyVec = []
  for (let i = 0; i < k; i++) sHat.push(byteDecode(dkPke.subarray(384 * i, 384 * (i + 1)), 12))
  // w = v − NTT⁻¹(ŝᵀ ∘ NTT(u))
  let acc = newPoly()
  const uHat = u.map(ntt)
  for (let i = 0; i < k; i++) acc = polyAdd(acc, nttMul(sHat[i], uHat[i]))
  const w = polySub(v, invNtt(acc))
  return encodeMessage(w)
}

// A message is 32 bytes ↔ a poly whose coefficients are 0 or ⌈q/2⌉ per bit.
const decodeMessage = (msg: Uint8Array): Poly => mapPoly(byteDecode(msg, 1), (x) => decompress(x, 1))
const encodeMessage = (w: Poly): Uint8Array => byteEncode(mapPoly(w, (x) => compress(x, 1)), 1)
const mapPoly = (p: Poly, f: (x: number) => number): Poly => {
  const q = newPoly()
  for (let i = 0; i < N; i++) q[i] = f(p[i])
  return q
}

// ── ML-KEM (the IND-CCA2 KEM, FIPS 203 §6) ────────────────────────────────────
export interface KemKeys {
  ek: Uint8Array // encapsulation (public) key
  dk: Uint8Array // decapsulation (secret) key: dkPke ‖ ek ‖ H(ek) ‖ z
}

/** ML-KEM.KeyGen — deterministic in the 32+32 random bytes (d, z). */
export function keyGen(params: MlKemParams, d: Uint8Array, z: Uint8Array): KemKeys {
  const { ekPke, dkPke } = kpkeKeyGen(params, d)
  const ek = ekPke
  const dk = cat(dkPke, ek, H(ek), z)
  return { ek, dk }
}

export interface Encapsulation {
  sharedSecret: Uint8Array // K
  ciphertext: Uint8Array // c
}

/** ML-KEM.Encaps — deterministic in the 32-byte message `m`. */
export function encaps(params: MlKemParams, ek: Uint8Array, m: Uint8Array): Encapsulation {
  const [K, r] = G(cat(m, H(ek)))
  const ciphertext = kpkeEncrypt(params, ek, m, r)
  return { sharedSecret: K, ciphertext }
}

export interface Decapsulation {
  sharedSecret: Uint8Array // K′ (implicitly rejected → the pseudorandom fallback)
  rejected: boolean // true when re-encryption disagreed (FO fallback taken)
}

/** ML-KEM.Decaps — the FO re-encryption check with constant-behaviour fallback. */
export function decaps(params: MlKemParams, dk: Uint8Array, ct: Uint8Array): Decapsulation {
  const { k } = params
  const dkPkeLen = 384 * k
  const ekLen = 384 * k + 32
  const dkPke = dk.subarray(0, dkPkeLen)
  const ek = dk.subarray(dkPkeLen, dkPkeLen + ekLen)
  const h = dk.subarray(dkPkeLen + ekLen, dkPkeLen + ekLen + 32)
  const z = dk.subarray(dkPkeLen + ekLen + 32, dkPkeLen + ekLen + 64)

  const mPrime = kpkeDecrypt(params, dkPke, ct)
  const [Kprime, rPrime] = G(cat(mPrime, h))
  const Kbar = J(cat(z, ct))
  const cPrime = kpkeEncrypt(params, ek, mPrime, rPrime)

  const rejected = !bytesEqual(ct, cPrime)
  return { sharedSecret: rejected ? Kbar : Kprime, rejected }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ── Size table (for the lab's comparison panel) ──────────────────────────────
export function kemSizes(params: MlKemParams): { ek: number; dk: number; ct: number; ss: number } {
  const { k, du, dv } = params
  return {
    ek: 384 * k + 32,
    dk: 768 * k + 96,
    ct: 32 * du * k + 32 * dv,
    ss: 32,
  }
}
