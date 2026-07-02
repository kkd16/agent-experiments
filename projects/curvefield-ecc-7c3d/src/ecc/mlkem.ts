// ML-KEM — the FIPS 203 module-lattice key-encapsulation mechanism (Kyber),
// from scratch, in the browser, with zero dependencies.
//
// This is Curvefield's first *lattice* post-quantum primitive. Everything else
// on the PQ shelf (Lamport … SPHINCS⁺) is hash-based; ML-KEM is the algorithm
// NIST actually standardised for key establishment, and the one already shipping
// in TLS 1.3 hybrids. Its security rests on Module-LWE: a public key is a noisy
// linear system  t = A·s + e  over the ring R_q = ℤ_q[X]/(X²⁵⁶+1), q = 3329, and
// recovering the small secret s from (A, t) is the hard problem.
//
// The construction has two layers. The inner **K-PKE** is an IND-CPA public-key
// encryption: encrypt a 32-byte message by hiding it in fresh lattice noise. The
// outer **ML-KEM** wraps it in the Fujisaki–Okamoto transform to get an IND-CCA2
// KEM — the shared secret is derived from the message, the ciphertext is
// re-encrypted on decapsulation and compared, and on *any* mismatch the receiver
// returns a secret pseudorandom key (implicit rejection) instead of failing, so
// a chosen-ciphertext attacker learns nothing from decapsulation behaviour.
//
// The number-theoretic transform is the trick that makes the ring multiplication
// fast: X²⁵⁶+1 splits mod q into 128 quadratics, so a polynomial becomes 128
// independent pairs and the convolution turns into cheap base-case products.
//
// Correctness is not self-asserted. The self-test pins SHA-3/SHAKE to their FIPS
// 202 vectors, and a Node harness runs the C2SP CCTV "accumulated" test —
// 10,000 randomised KeyGen/Encaps/Decaps rounds (including implicit rejection)
// whose running SHAKE-128 digest must equal the community-published constant, a
// single 32-byte value that certifies every step byte-for-byte.

import { sha3_256, sha3_512, shake256, shake128Stream } from './keccak'
import { randomBytes } from './rng'

export const Q = 3329
export const N = 256
const F = 3303 // 128⁻¹ mod q, applied at the tail of the inverse NTT
const ZETA = 17 // a primitive 256-th root of unity mod q

// ── modular arithmetic over ℤ_q ─────────────────────────────────────────────

const mod = (a: number): number => {
  const r = a % Q
  return r < 0 ? r + Q : r
}

const powmod = (b: number, e: number): number => {
  let r = 1
  let base = mod(b)
  while (e > 0) {
    if (e & 1) r = mod(r * base)
    base = mod(base * base)
    e >>= 1
  }
  return r
}

// 7-bit bit-reversal — the index permutation the NTT butterflies walk in.
const brv7 = (i: number): number => {
  let r = 0
  for (let b = 0; b < 7; b++) r |= ((i >> b) & 1) << (6 - b)
  return r
}

// zetas[i] = ζ^{brv7(i)} drives the forward/inverse butterflies (i = 1..127).
const ZETAS: number[] = Array.from({ length: 128 }, (_, i) => powmod(ZETA, brv7(i)))
// gammas[i] = ζ^{2·brv7(i)+1} is the modulus of the i-th quadratic factor.
const GAMMAS: number[] = Array.from({ length: 128 }, (_, i) => powmod(ZETA, 2 * brv7(i) + 1))

// ── polynomials in R_q (256 coefficients) ───────────────────────────────────

export type Poly = number[] // length 256, each in [0, q)

const polyAdd = (a: Poly, b: Poly): Poly => a.map((x, i) => mod(x + b[i]))
const polySub = (a: Poly, b: Poly): Poly => a.map((x, i) => mod(x - b[i]))

/** Forward NTT (FIPS 203 Algorithm 9), in place on a copy. */
export function ntt(f: Poly): Poly {
  const a = f.slice()
  let i = 1
  for (let len = 128; len >= 2; len >>= 1) {
    for (let start = 0; start < 256; start += 2 * len) {
      const z = ZETAS[i++]
      for (let j = start; j < start + len; j++) {
        const t = mod(z * a[j + len])
        a[j + len] = mod(a[j] - t)
        a[j] = mod(a[j] + t)
      }
    }
  }
  return a
}

/** Inverse NTT (FIPS 203 Algorithm 10), in place on a copy. */
export function invNtt(f: Poly): Poly {
  const a = f.slice()
  let i = 127
  for (let len = 2; len <= 128; len <<= 1) {
    for (let start = 0; start < 256; start += 2 * len) {
      const z = ZETAS[i--]
      for (let j = start; j < start + len; j++) {
        const t = a[j]
        a[j] = mod(t + a[j + len])
        a[j + len] = mod(z * mod(a[j + len] - t))
      }
    }
  }
  for (let j = 0; j < 256; j++) a[j] = mod(a[j] * F)
  return a
}

/** Multiply two NTT-domain polynomials via the 128 base-case products. */
export function baseMul(a: Poly, b: Poly): Poly {
  const c: Poly = new Array(256)
  for (let i = 0; i < 128; i++) {
    const a0 = a[2 * i]
    const a1 = a[2 * i + 1]
    const b0 = b[2 * i]
    const b1 = b[2 * i + 1]
    const g = GAMMAS[i]
    c[2 * i] = mod(mod(a0 * b0) + mod(mod(a1 * b1) * g))
    c[2 * i + 1] = mod(mod(a0 * b1) + mod(a1 * b0))
  }
  return c
}

// ── compression and byte (de)serialisation ──────────────────────────────────

// Compress_d(x) = round(x·2^d / q) mod 2^d, ties up, in exact integer form.
const compress = (x: number, d: number): number =>
  Math.floor((2 * x * (1 << d) + Q) / (2 * Q)) & ((1 << d) - 1)
// Decompress_d(y) = round(y·q / 2^d), ties up.
const decompress = (y: number, d: number): number => (y * Q + (1 << (d - 1))) >> d

const compressPoly = (p: Poly, d: number): Poly => p.map((x) => compress(x, d))
const decompressPoly = (p: Poly, d: number): Poly => p.map((y) => decompress(y, d))

/** ByteEncode_d: pack 256 d-bit integers, least-significant bit first. */
function byteEncode(p: Poly, d: number): Uint8Array {
  const out = new Uint8Array((256 * d) / 8)
  let bit = 0
  for (let i = 0; i < 256; i++) {
    const v = p[i]
    for (let b = 0; b < d; b++) {
      if ((v >> b) & 1) out[bit >> 3] |= 1 << (bit & 7)
      bit++
    }
  }
  return out
}

/** ByteDecode_d: unpack 256 d-bit integers (d=12 reduces mod q, per FIPS 203). */
function byteDecode(bytes: Uint8Array, d: number): Poly {
  const p: Poly = new Array(256)
  let bit = 0
  for (let i = 0; i < 256; i++) {
    let v = 0
    for (let b = 0; b < d; b++) {
      v |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << b
      bit++
    }
    p[i] = d === 12 ? v % Q : v
  }
  return p
}

// ── sampling ─────────────────────────────────────────────────────────────────

/** SampleNTT (Algorithm 7): rejection-sample a uniform NTT-domain poly. */
function sampleNTT(seed: Uint8Array): Poly {
  const xof = shake128Stream(seed)
  const p: Poly = new Array(256)
  let j = 0
  while (j < 256) {
    const b = xof.read(3)
    const d1 = b[0] | ((b[1] & 0xf) << 8)
    const d2 = (b[1] >> 4) | (b[2] << 4)
    if (d1 < Q && j < 256) p[j++] = d1
    if (d2 < Q && j < 256) p[j++] = d2
  }
  return p
}

/** SamplePolyCBD_η (Algorithm 8): a centred binomial from 64·η bytes. */
function samplePolyCBD(bytes: Uint8Array, eta: number): Poly {
  const p: Poly = new Array(256)
  const bit = (idx: number): number => (bytes[idx >> 3] >> (idx & 7)) & 1
  for (let i = 0; i < 256; i++) {
    let x = 0
    let y = 0
    for (let k = 0; k < eta; k++) x += bit(2 * i * eta + k)
    for (let k = 0; k < eta; k++) y += bit(2 * i * eta + eta + k)
    p[i] = mod(x - y)
  }
  return p
}

const concat = (...arrs: Uint8Array[]): Uint8Array => {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const a of arrs) {
    out.set(a, o)
    o += a.length
  }
  return out
}

/** PRF_η(s, b) = SHAKE256(s ‖ b, 64η) — the noise-expansion function. */
const prf = (eta: number, s: Uint8Array, b: number): Uint8Array =>
  shake256(concat(s, Uint8Array.of(b)), 64 * eta)

// H = SHA3-256, G = SHA3-512, J = SHAKE256(·,32).
const H = sha3_256
const G = sha3_512
const J = (m: Uint8Array): Uint8Array => shake256(m, 32)

/** Â[i][j] = SampleNTT(ρ ‖ j ‖ i) — the public k×k matrix over R_q (FIPS 203). */
function genMatrix(rho: Uint8Array, k: number): Poly[][] {
  const A: Poly[][] = []
  for (let i = 0; i < k; i++) {
    A[i] = []
    for (let j = 0; j < k; j++) A[i][j] = sampleNTT(concat(rho, Uint8Array.of(j, i)))
  }
  return A
}

// ── parameter sets ──────────────────────────────────────────────────────────

export interface Params {
  name: string
  k: number
  eta1: number
  eta2: number
  du: number
  dv: number
}

export const ML_KEM_512: Params = { name: 'ML-KEM-512', k: 2, eta1: 3, eta2: 2, du: 10, dv: 4 }
export const ML_KEM_768: Params = { name: 'ML-KEM-768', k: 3, eta1: 2, eta2: 2, du: 10, dv: 4 }
export const ML_KEM_1024: Params = { name: 'ML-KEM-1024', k: 4, eta1: 2, eta2: 2, du: 11, dv: 5 }
export const PARAM_SETS: Params[] = [ML_KEM_512, ML_KEM_768, ML_KEM_1024]

export interface Sizes {
  ek: number
  dk: number
  ct: number
  ss: number
}
export const sizes = (p: Params): Sizes => ({
  ek: 384 * p.k + 32,
  dk: 768 * p.k + 96,
  ct: 32 * (p.du * p.k + p.dv),
  ss: 32,
})

// ── K-PKE (the IND-CPA core) ─────────────────────────────────────────────────

/**
 * The seed → (ρ, σ) expansion, and the one place the IPD and the final standard
 * disagree. FIPS 203 *final* (Aug 2024) hashes `d ‖ k` so that two parameter
 * sets sharing a seed still get independent public matrices — a domain-separation
 * fix added after the initial public draft. The IPD (and NIST's Oct-2023
 * intermediate values, and the C2SP CCTV vectors) hash `d` alone. Everything
 * downstream is identical, so this single byte is the whole delta between the
 * two versions.
 */
export type Variant = 'final' | 'ipd'

function kpkeKeyGen(
  d: Uint8Array,
  p: Params,
  variant: Variant,
): { ekPKE: Uint8Array; dkPKE: Uint8Array } {
  const g = variant === 'ipd' ? G(d) : G(concat(d, Uint8Array.of(p.k)))
  const rho = g.slice(0, 32)
  const sigma = g.slice(32, 64)
  const A = genMatrix(rho, p.k)
  let nn = 0
  const s: Poly[] = []
  const e: Poly[] = []
  for (let i = 0; i < p.k; i++) s.push(ntt(samplePolyCBD(prf(p.eta1, sigma, nn++), p.eta1)))
  for (let i = 0; i < p.k; i++) e.push(ntt(samplePolyCBD(prf(p.eta1, sigma, nn++), p.eta1)))
  const t: Poly[] = []
  for (let i = 0; i < p.k; i++) {
    let acc: Poly = new Array(256).fill(0)
    for (let j = 0; j < p.k; j++) acc = polyAdd(acc, baseMul(A[i][j], s[j]))
    t.push(polyAdd(acc, e[i]))
  }
  const ekPKE = concat(...t.map((ti) => byteEncode(ti, 12)), rho)
  const dkPKE = concat(...s.map((si) => byteEncode(si, 12)))
  return { ekPKE, dkPKE }
}

function kpkeEncrypt(ekPKE: Uint8Array, m: Uint8Array, r: Uint8Array, p: Params): Uint8Array {
  const t: Poly[] = []
  for (let i = 0; i < p.k; i++) t.push(byteDecode(ekPKE.subarray(384 * i, 384 * (i + 1)), 12))
  const rho = ekPKE.subarray(384 * p.k, 384 * p.k + 32)
  const A = genMatrix(rho, p.k)
  let nn = 0
  const rv: Poly[] = []
  for (let i = 0; i < p.k; i++) rv.push(ntt(samplePolyCBD(prf(p.eta1, r, nn++), p.eta1)))
  const e1: Poly[] = []
  for (let i = 0; i < p.k; i++) e1.push(samplePolyCBD(prf(p.eta2, r, nn++), p.eta2))
  const e2 = samplePolyCBD(prf(p.eta2, r, nn), p.eta2)
  // u = INTT(Âᵀ ∘ r̂) + e1
  const u: Poly[] = []
  for (let i = 0; i < p.k; i++) {
    let acc: Poly = new Array(256).fill(0)
    for (let j = 0; j < p.k; j++) acc = polyAdd(acc, baseMul(A[j][i], rv[j]))
    u.push(polyAdd(invNtt(acc), e1[i]))
  }
  // v = INTT(t̂ᵀ ∘ r̂) + e2 + Decompress₁(m)
  let vacc: Poly = new Array(256).fill(0)
  for (let j = 0; j < p.k; j++) vacc = polyAdd(vacc, baseMul(t[j], rv[j]))
  const mu = decompressPoly(byteDecode(m, 1), 1)
  const v = polyAdd(polyAdd(invNtt(vacc), e2), mu)
  const c1 = concat(...u.map((ui) => byteEncode(compressPoly(ui, p.du), p.du)))
  const c2 = byteEncode(compressPoly(v, p.dv), p.dv)
  return concat(c1, c2)
}

function kpkeDecrypt(dkPKE: Uint8Array, c: Uint8Array, p: Params): Uint8Array {
  const c1len = 32 * p.du * p.k
  const u: Poly[] = []
  for (let i = 0; i < p.k; i++) {
    const seg = c.subarray(32 * p.du * i, 32 * p.du * (i + 1))
    u.push(decompressPoly(byteDecode(seg, p.du), p.du))
  }
  const v = decompressPoly(byteDecode(c.subarray(c1len), p.dv), p.dv)
  const s: Poly[] = []
  for (let i = 0; i < p.k; i++) s.push(byteDecode(dkPKE.subarray(384 * i, 384 * (i + 1)), 12))
  let acc: Poly = new Array(256).fill(0)
  for (let j = 0; j < p.k; j++) acc = polyAdd(acc, baseMul(s[j], ntt(u[j])))
  const w = polySub(v, invNtt(acc))
  return byteEncode(compressPoly(w, 1), 1)
}

// ── ML-KEM (the IND-CCA2 KEM via Fujisaki–Okamoto) ───────────────────────────

export interface KeyPair {
  ek: Uint8Array
  dk: Uint8Array
}

/** Deterministic KeyGen from the two 32-byte seeds d, z (FIPS 203 §7.1). */
export function keyGenInternal(
  d: Uint8Array,
  z: Uint8Array,
  p: Params,
  variant: Variant = 'final',
): KeyPair {
  const { ekPKE, dkPKE } = kpkeKeyGen(d, p, variant)
  const ek = ekPKE
  const dk = concat(dkPKE, ek, H(ek), z)
  return { ek, dk }
}

export interface Encapsulation {
  K: Uint8Array
  c: Uint8Array
}

/** Deterministic Encaps from message m (FIPS 203 §7.2, internal form). */
export function encapsInternal(ek: Uint8Array, m: Uint8Array, p: Params): Encapsulation {
  const g = G(concat(m, H(ek)))
  const K = g.slice(0, 32)
  const r = g.slice(32, 64)
  const c = kpkeEncrypt(ek, m, r, p)
  return { K, c }
}

/** Constant-time byte-string equality. */
function ctEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export interface Decapsulation {
  K: Uint8Array
  /** True when re-encryption matched; false ⇒ implicit rejection fired. */
  valid: boolean
}

/** Decaps with the FO transform and implicit rejection (FIPS 203 §7.3). */
export function decapsInternal(dk: Uint8Array, c: Uint8Array, p: Params): Decapsulation {
  const k = p.k
  const dkPKE = dk.subarray(0, 384 * k)
  const ekPKE = dk.subarray(384 * k, 768 * k + 32)
  const h = dk.subarray(768 * k + 32, 768 * k + 64)
  const z = dk.subarray(768 * k + 64, 768 * k + 96)
  const m2 = kpkeDecrypt(dkPKE, c, p)
  const g = G(concat(m2, h))
  const K2 = g.slice(0, 32)
  const r2 = g.slice(32, 64)
  const Kbar = J(concat(z, c))
  const c2 = kpkeEncrypt(ekPKE, m2, r2, p)
  const valid = ctEq(c, c2)
  return { K: valid ? K2 : Kbar, valid }
}

/**
 * Encapsulation input check (FIPS 203 §7.2): the key must be the right length
 * and every field element must have a canonical 12-bit encoding. A malformed
 * key (used in the "modulus" attack vectors) is rejected here.
 */
export function encapsCheck(ek: Uint8Array, p: Params): boolean {
  if (ek.length !== sizes(p).ek) return false
  for (let i = 0; i < p.k; i++) {
    const seg = ek.subarray(384 * i, 384 * (i + 1))
    const t = byteDecode(seg, 12) // already reduced mod q
    if (!ctEq(byteEncode(t, 12), seg)) return false
  }
  return true
}

// ── randomised wrappers ──────────────────────────────────────────────────────

/** Generate a key pair, drawing d, z from the platform CSPRNG. */
export function keyGen(
  p: Params,
  variant: Variant = 'final',
): KeyPair & { d: Uint8Array; z: Uint8Array } {
  const d = randomBytes(32)
  const z = randomBytes(32)
  return { ...keyGenInternal(d, z, p, variant), d, z }
}

/** Encapsulate to ek, drawing the message m at random. */
export function encaps(ek: Uint8Array, p: Params): Encapsulation & { m: Uint8Array } {
  const m = randomBytes(32)
  return { ...encapsInternal(ek, m, p), m }
}

/** Decapsulate a ciphertext. */
export const decaps = decapsInternal
