// Bulletproofs — short, logarithmic-size zero-knowledge range proofs, built from
// scratch on the secp256k1 group (Bünz, Bootle, Boneh, Poelstra, Wuille & Maxwell,
// IEEE S&P 2018). The headline: proving a committed value lies in [0, 2ⁿ) costs only
// 2·⌈log₂(n·m)⌉ + O(1) group elements — for a 64-bit amount, *13 points and a handful
// of scalars*, versus the linear (one OR-proof per bit) construction in `sigma.ts`.
//
// The engine is three layers stacked on the Pedersen commitments of `sigma.ts`:
//
//   1. A Fiat–Shamir TRANSCRIPT — a running hash that absorbs every prover message
//      and squeezes the verifier's challenges, so the interactive protocol becomes a
//      single offline-checkable object. Domain-separated from every other hash here.
//
//   2. The INNER-PRODUCT ARGUMENT — the heart of Bulletproofs. It proves knowledge
//      of two vectors a, b with a public commitment P = ⟨a,g⟩ + ⟨b,h⟩ + ⟨a,b⟩·u,
//      and it does so in log-many rounds: each round halves the vectors by folding
//      them under a challenge, sending one L and one R point per round. We ship both
//      a transparent recursive verifier and an optimised single multi-exponentiation
//      verifier (the s-vector trick) and the self-test pins them to agree.
//
//   3. The RANGE PROOF — encode "v ∈ [0,2ⁿ)" as the polynomial identity t(X) =
//      ⟨l(X), r(X)⟩ over the bit-vectors of v, commit to its coefficients, and have
//      the inner-product argument prove the evaluation t̂ = ⟨l,r⟩ compactly. Supports
//      AGGREGATION: m values proven together in one proof of size 2·⌈log₂(nm)⌉+O(1),
//      the construction Monero and Bitcoin confidential-transaction designs use.
//
// Everything is computed live on native BigInt with zero crypto dependencies, and is
// pinned by round-trip + soundness + naive-vs-fast-verifier checks in `selftest.ts`.

import { secp256k1, G, N } from './secp256k1'
import { type Point } from './curve'
import { mod, modInv } from './field'
import { taggedHash } from './secp256k1'
import { concat, bigToBytes, bytesToBig, utf8 } from './sha256'
import { H, commit } from './sigma'

// ── point + scalar shorthands ────────────────────────────────────────────────
const add = (A: Point, B: Point) => secp256k1.add(A, B)
const sub = (A: Point, B: Point) => secp256k1.subtract(A, B)
const mul = (k: bigint, A: Point) => secp256k1.multiply(mod(k, N), A)
const eq = (A: Point, B: Point) =>
  (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)

/** Compressed (33-byte) SEC serialization, used only to feed the transcript hash. */
const ser = (Q: Point): Uint8Array => {
  if (Q === null) return new Uint8Array(33)
  const out = new Uint8Array(33)
  out[0] = Q.y % 2n === 0n ? 0x02 : 0x03
  out.set(bigToBytes(Q.x, 32), 1)
  return out
}

// ── vector arithmetic over F_n ───────────────────────────────────────────────
type Vec = bigint[]
const vAdd = (a: Vec, b: Vec): Vec => a.map((x, i) => mod(x + b[i], N))
const vScale = (a: Vec, s: bigint): Vec => a.map((x) => mod(x * s, N))
const vHad = (a: Vec, b: Vec): Vec => a.map((x, i) => mod(x * b[i], N)) // entrywise product
const vInner = (a: Vec, b: Vec): bigint => a.reduce((acc, x, i) => mod(acc + x * b[i], N), 0n)
/** (1, base, base², …, base^{len-1}) mod n. */
const vPow = (base: bigint, len: number): Vec => {
  const out: Vec = []
  let cur = 1n
  for (let i = 0; i < len; i++) {
    out.push(cur)
    cur = mod(cur * base, N)
  }
  return out
}
/** Multi-scalar multiplication Σ sᵢ·Pᵢ. */
const msm = (scalars: Vec, points: Point[]): Point => {
  let acc: Point = null
  for (let i = 0; i < scalars.length; i++) acc = add(acc, mul(scalars[i], points[i]))
  return acc
}
const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0

// ── Fiat–Shamir transcript ───────────────────────────────────────────────────
// A running 32-byte state. Absorbing mixes a labelled message into the state;
// squeezing derives a challenge from the state and ratchets it forward, so every
// challenge depends on the entire prior transcript. Prover and verifier perform
// the identical sequence of absorbs and squeezes, in lock-step.
export class Transcript {
  private state: Uint8Array
  constructor(domain: string) {
    this.state = taggedHash('Curvefield/bp/init', utf8(domain))
  }
  private absorb(label: string, bytes: Uint8Array) {
    this.state = taggedHash('Curvefield/bp/absorb', concat(this.state, utf8(label), bytes))
  }
  point(label: string, P: Point) {
    this.absorb(label, ser(P))
  }
  scalar(label: string, s: bigint) {
    this.absorb(label, bigToBytes(mod(s, N), 32))
  }
  /** Squeeze a non-zero challenge in F_n and ratchet the state. */
  challenge(label: string): bigint {
    const h = taggedHash('Curvefield/bp/chal', concat(this.state, utf8(label)))
    this.state = taggedHash('Curvefield/bp/next', concat(this.state, h))
    const c = mod(bytesToBig(h), N)
    return c === 0n ? 1n : c
  }
}

// ── generators ───────────────────────────────────────────────────────────────
// Independent NUMS ("nothing up my sleeve") generators with pairwise-unknown
// discrete logs: each is the image of a distinct domain-separated label under the
// existing try-and-increment hash-to-curve. g (value) and h (blinding) are the
// same generators the rest of the lab's Pedersen commitments use.
export interface Generators {
  gv: Point[] // ⟨aL,·⟩ generator vector
  hv: Point[] // ⟨aR,·⟩ generator vector
  u: Point // inner-product generator
  g: Point // value generator (= G)
  h: Point // blinding generator (= H)
}

/** Derive a NUMS point from a label by try-and-increment hashing to the curve.
 *  secp256k1 has cofactor 1, so every lift lands in the prime-order group. */
function numsPoint(label: string): Point {
  for (let ctr = 0; ctr < 256; ctr++) {
    const x = mod(bytesToBig(taggedHash('Curvefield/bp/gen', concat(utf8(label), Uint8Array.of(ctr)))), secp256k1.p)
    const ys = secp256k1.liftX(x)
    if (ys.length > 0) {
      const y = ys[0] % 2n === 0n ? ys[0] : mod(-ys[0], secp256k1.p)
      return { x, y }
    }
  }
  throw new Error('NUMS generator derivation failed')
}

// Generators are deterministic, so we build one shared pool and slice/extend it.
const _gv: Point[] = []
const _hv: Point[] = []
let _u: Point = null
/** Generators for vectors of length `n` (built once, cached, extended on demand). */
export function generators(n: number): Generators {
  while (_gv.length < n) {
    _gv.push(numsPoint(`G/${_gv.length}`))
    _hv.push(numsPoint(`H/${_hv.length}`))
  }
  if (_u === null) _u = numsPoint('U')
  return { gv: _gv.slice(0, n), hv: _hv.slice(0, n), u: _u, g: G, h: H }
}

// ── the inner-product argument ───────────────────────────────────────────────
export interface IpaProof {
  L: Point[] // one per round
  R: Point[]
  a: bigint // final folded scalars
  b: bigint
}

/** Prove knowledge of a, b with P = ⟨a,gv⟩ + ⟨b,hv⟩ + ⟨a,b⟩·u, folding the
 *  vectors in ⌈log₂ n⌉ rounds. The transcript continues from the caller's. */
export function ipaProve(
  tr: Transcript,
  gvIn: Point[],
  hvIn: Point[],
  u: Point,
  aIn: Vec,
  bIn: Vec,
): IpaProof {
  let g = gvIn.slice()
  let h = hvIn.slice()
  let a = aIn.slice()
  let b = bIn.slice()
  const L: Point[] = []
  const R: Point[] = []
  let n = a.length
  while (n > 1) {
    const m = n >> 1
    const aLo = a.slice(0, m), aHi = a.slice(m)
    const bLo = b.slice(0, m), bHi = b.slice(m)
    const gLo = g.slice(0, m), gHi = g.slice(m)
    const hLo = h.slice(0, m), hHi = h.slice(m)
    const cL = vInner(aLo, bHi)
    const cR = vInner(aHi, bLo)
    const Lp = add(add(msm(aLo, gHi), msm(bHi, hLo)), mul(cL, u))
    const Rp = add(add(msm(aHi, gLo), msm(bLo, hHi)), mul(cR, u))
    L.push(Lp)
    R.push(Rp)
    tr.point('L', Lp)
    tr.point('R', Rp)
    const x = tr.challenge('ipa-x')
    const xi = modInv(x, N)
    const ng: Point[] = [], nh: Point[] = []
    const na: Vec = [], nb: Vec = []
    for (let i = 0; i < m; i++) {
      ng.push(add(mul(xi, gLo[i]), mul(x, gHi[i])))
      nh.push(add(mul(x, hLo[i]), mul(xi, hHi[i])))
      na.push(mod(x * aLo[i] + xi * aHi[i], N))
      nb.push(mod(xi * bLo[i] + x * bHi[i], N))
    }
    g = ng; h = nh; a = na; b = nb; n = m
  }
  return { L, R, a: a[0], b: b[0] }
}

/** Transparent recursive verifier: replays the fold round-by-round and checks the
 *  final scalar relation. O(n log n) point ops — clear, used as ground truth. */
export function ipaVerifyNaive(
  tr: Transcript,
  gvIn: Point[],
  hvIn: Point[],
  u: Point,
  Pin: Point,
  proof: IpaProof,
): boolean {
  let g = gvIn.slice()
  let h = hvIn.slice()
  let P = Pin
  let n = g.length
  let round = 0
  while (n > 1) {
    const m = n >> 1
    const Lp = proof.L[round], Rp = proof.R[round]
    tr.point('L', Lp)
    tr.point('R', Rp)
    const x = tr.challenge('ipa-x')
    const xi = modInv(x, N)
    const x2 = mod(x * x, N), xi2 = mod(xi * xi, N)
    P = add(add(mul(x2, Lp), P), mul(xi2, Rp))
    const gLo = g.slice(0, m), gHi = g.slice(m)
    const hLo = h.slice(0, m), hHi = h.slice(m)
    const ng: Point[] = [], nh: Point[] = []
    for (let i = 0; i < m; i++) {
      ng.push(add(mul(xi, gLo[i]), mul(x, gHi[i])))
      nh.push(add(mul(x, hLo[i]), mul(xi, hHi[i])))
    }
    g = ng; h = nh; n = m; round++
  }
  const want = add(add(mul(proof.a, g[0]), mul(proof.b, h[0])), mul(mod(proof.a * proof.b, N), u))
  return eq(P, want)
}

/** Optimised verifier: collapse the whole fold into one multi-exponentiation via
 *  the s-vector sᵢ = Π xⱼ^{±1}. One pass over the generators instead of log passes
 *  of vector folding — the verification real deployments run. */
export function ipaVerifyFast(
  tr: Transcript,
  gvIn: Point[],
  hvIn: Point[],
  u: Point,
  Pin: Point,
  proof: IpaProof,
): boolean {
  const n = gvIn.length
  const k = proof.L.length
  if ((1 << k) !== n) return false
  const xs: bigint[] = [], xinv: bigint[] = []
  let P = Pin
  for (let j = 0; j < k; j++) {
    tr.point('L', proof.L[j])
    tr.point('R', proof.R[j])
    const x = tr.challenge('ipa-x')
    const xi = modInv(x, N)
    xs.push(x); xinv.push(xi)
    P = add(add(mul(mod(x * x, N), proof.L[j]), P), mul(mod(xi * xi, N), proof.R[j]))
  }
  // sᵢ = Π_j xⱼ if bit (k-1-j) of i is set, else xⱼ⁻¹.
  const s: Vec = new Array(n)
  for (let i = 0; i < n; i++) {
    let prod = 1n
    for (let j = 0; j < k; j++) {
      const bit = (i >> (k - 1 - j)) & 1
      prod = mod(prod * (bit ? xs[j] : xinv[j]), N)
    }
    s[i] = prod
  }
  const gScalars = s.map((si) => mod(proof.a * si, N))
  const hScalars = s.map((si) => mod(proof.b * modInv(si, N), N))
  const lhs = add(add(msm(gScalars, gvIn), msm(hScalars, hvIn)), mul(mod(proof.a * proof.b, N), u))
  return eq(lhs, P)
}

// ── range proof (single + aggregated) ────────────────────────────────────────
export interface RangeProof {
  V: Point[] // Pedersen commitments Vⱼ = vⱼ·G + γⱼ·H
  A: Point // commitment to the bit-vectors aL, aR
  S: Point // commitment to the blinding vectors sL, sR
  T1: Point // commitment to t₁
  T2: Point // commitment to t₂
  taux: bigint // blinding for t̂
  mu: bigint // blinding for A + x·S
  tHat: bigint // t̂ = ⟨l, r⟩ = t(x)
  ipa: IpaProof // proves ⟨l, r⟩ = t̂ in log size
  n: number // bits per value
  m: number // number of aggregated values
}

const TR_DOMAIN = 'Curvefield/bulletproofs/v1'

/** How many group elements a proof carries: 2·⌈log₂(nm)⌉ + 4. */
export function proofSize(n: number, m: number): { points: number; scalars: number } {
  const rounds = Math.log2(n * m)
  return { points: 2 * rounds + 4, scalars: 5 } // L,R per round + A,S,T1,T2 ; taux,mu,tHat,a,b
}

/** Prove each vⱼ ∈ [0, 2ⁿ) for the commitments Vⱼ = commit(vⱼ, γⱼ), aggregated
 *  into a single proof. `n` and `values.length` must each be powers of two. */
export function proveRange(values: bigint[], gammas: bigint[], n: number): RangeProof {
  const m = values.length
  const nm = n * m
  if (!isPow2(n)) throw new Error('bit width n must be a power of two')
  if (!isPow2(m)) throw new Error('number of values must be a power of two')
  if (gammas.length !== m) throw new Error('need one blinding per value')
  for (const v of values) if (v < 0n || v >= 1n << BigInt(n)) throw new Error('value out of range')

  const { gv, hv, u } = generators(nm)
  const V = values.map((v, j) => commit(v, gammas[j]))

  // Bit decomposition: aL holds the bits of all values concatenated, aR = aL − 1ⁿᵐ.
  const aL: Vec = new Array(nm)
  const aR: Vec = new Array(nm)
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const bit = (values[j] >> BigInt(i)) & 1n
      aL[j * n + i] = bit
      aR[j * n + i] = mod(bit - 1n, N)
    }
  }

  // A = α·H + ⟨aL, gv⟩ + ⟨aR, hv⟩.
  const alpha = rand()
  const A = add(mul(alpha, H), add(msm(aL, gv), msm(aR, hv)))
  // S = ρ·H + ⟨sL, gv⟩ + ⟨sR, hv⟩ for fresh blinding vectors.
  const sL = randVec(nm)
  const sR = randVec(nm)
  const rho = rand()
  const S = add(mul(rho, H), add(msm(sL, gv), msm(sR, hv)))

  const tr = new Transcript(TR_DOMAIN)
  tr.scalar('n', BigInt(n))
  tr.scalar('m', BigInt(m))
  for (const Vj of V) tr.point('V', Vj)
  tr.point('A', A)
  tr.point('S', S)
  const y = tr.challenge('y')
  const z = tr.challenge('z')

  const yN = vPow(y, nm)
  const twoN = vPow(2n, n)
  const z2 = mod(z * z, N)
  // zpow[j] = z^{j+2}: the aggregation weight on value j (smallest is z²).
  const zpow: Vec = []
  for (let j = 0; j < m; j++) zpow.push(mod(z2 * modPowSmall(z, j), N))

  // l(X) = (aL − z·1) + sL·X ; r(X) = y∘(aR + z·1 + sR·X) + d, with the block-weighted
  // powers-of-two vector d[j·n+i] = z^{j+2}·2ⁱ.
  const ones = new Array(nm).fill(z) as Vec
  const l0 = vAdd(aL, vScale(ones, mod(-1n, N))) // aL − z·1
  const l1 = sL
  const aRz = aR.map((x) => mod(x + z, N))
  const d: Vec = new Array(nm)
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) d[j * n + i] = mod(zpow[j] * twoN[i], N)
  const r0 = vAdd(vHad(yN, aRz), d)
  const r1 = vHad(yN, sR)

  // t(X) = ⟨l(X), r(X)⟩ = t₀ + t₁X + t₂X².
  const t1 = mod(vInner(l0, r1) + vInner(l1, r0), N)
  const t2 = vInner(l1, r1)
  const tau1 = rand()
  const tau2 = rand()
  const T1 = commit(t1, tau1)
  const T2 = commit(t2, tau2)

  tr.point('T1', T1)
  tr.point('T2', T2)
  const x = tr.challenge('x')

  const l = vAdd(l0, vScale(l1, x))
  const r = vAdd(r0, vScale(r1, x))
  const tHat = vInner(l, r)
  // τₓ = τ₂x² + τ₁x + Σ z^{j+2}·γⱼ ; μ = α + ρx.
  let taux = mod(tau2 * mod(x * x, N) + tau1 * x, N)
  for (let j = 0; j < m; j++) taux = mod(taux + zpow[j] * gammas[j], N)
  const mu = mod(alpha + rho * x, N)

  // Inner-product argument over gv and the rescaled hv: h'ᵢ = y^{−i}·hvᵢ, with the
  // inner-product generator bound by a fresh challenge so t̂ cannot be forged.
  tr.scalar('taux', taux)
  tr.scalar('mu', mu)
  tr.scalar('tHat', tHat)
  const w = tr.challenge('w')
  const Q = mul(w, u)
  const yInvN = vPow(modInv(y, N), nm)
  const hp = hv.map((Hi, i) => mul(yInvN[i], Hi))
  const ipa = ipaProve(tr, gv, hp, Q, l, r)

  return { V, A, S, T1, T2, taux, mu, tHat, ipa, n, m }
}

/** Verify an (aggregated) range proof. `fast` selects the single-multiexp IPA
 *  verifier; the default replays the fold transparently. */
export function verifyRange(p: RangeProof, fast = false): boolean {
  const { n, m } = p
  const nm = n * m
  if (!isPow2(nm)) return false
  if (p.V.length !== m) return false
  if (p.ipa.L.length !== Math.log2(nm)) return false

  const { gv, hv, u } = generators(nm)

  const tr = new Transcript(TR_DOMAIN)
  tr.scalar('n', BigInt(n))
  tr.scalar('m', BigInt(m))
  for (const Vj of p.V) tr.point('V', Vj)
  tr.point('A', p.A)
  tr.point('S', p.S)
  const y = tr.challenge('y')
  const z = tr.challenge('z')

  const yN = vPow(y, nm)
  const twoN = vPow(2n, n)
  const z2 = mod(z * z, N)
  const zpow: Vec = []
  for (let j = 0; j < m; j++) zpow.push(mod(z2 * modPowSmall(z, j), N))

  tr.point('T1', p.T1)
  tr.point('T2', p.T2)
  const x = tr.challenge('x')

  // Check ①: the t̂ commitment.
  //   t̂·G + τₓ·H  ?=  Σ z^{j+2}·Vⱼ + δ(y,z)·G + x·T₁ + x²·T₂
  // δ(y,z) = (z − z²)·⟨1,yⁿᵐ⟩ − Σⱼ z^{j+3}·(2ⁿ−1).
  const sumY = yN.reduce((acc, v) => mod(acc + v, N), 0n)
  const twoSum = mod((1n << BigInt(n)) - 1n, N)
  let delta = mod((z - z2) * sumY, N)
  for (let j = 0; j < m; j++) delta = mod(delta - mod(zpow[j] * z, N) * twoSum, N)
  const lhs1 = commit(p.tHat, p.taux)
  const rhs1 = add(
    add(msm(zpow, p.V), mul(delta, G)),
    add(mul(x, p.T1), mul(mod(x * x, N), p.T2)),
  )
  if (!eq(lhs1, rhs1)) return false

  // Check ②: rebuild the inner-product commitment P and hand it to the IPA verifier.
  //   P = A + x·S − z·Σgvᵢ + Σ (z·yⁱ + z^{⌊i/n⌋+2}·2^{i mod n})·h'ᵢ
  const w = (() => {
    tr.scalar('taux', p.taux)
    tr.scalar('mu', p.mu)
    tr.scalar('tHat', p.tHat)
    return tr.challenge('w')
  })()
  const Q = mul(w, u)
  const yInvN = vPow(modInv(y, N), nm)
  const hp = hv.map((Hi, i) => mul(yInvN[i], Hi))

  const zAll = new Array(nm).fill(z) as Vec
  const hExp: Vec = new Array(nm)
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) hExp[j * n + i] = mod(z * yN[j * n + i] + zpow[j] * twoN[i], N)

  let P = add(p.A, mul(x, p.S))
  P = sub(P, msm(zAll, gv))
  P = add(P, msm(hExp, hp))
  // Move μ·H out and fold in the claimed inner product, giving the IPA's P.
  const Pipa = add(sub(P, mul(p.mu, H)), mul(p.tHat, Q))

  const ipaOk = fast
    ? ipaVerifyFast(tr, gv, hp, Q, Pipa, p.ipa)
    : ipaVerifyNaive(tr, gv, hp, Q, Pipa, p.ipa)
  return ipaOk
}

// ── confidential transactions ───────────────────────────────────────────────
// The canonical Bulletproofs application. Amounts live only inside Pedersen
// commitments, never in the clear. Two properties make such a transaction safe:
//
//   • BALANCE — money is conserved. Because commitments are additively homomorphic,
//     the "kernel excess" E = Σinputs − Σoutputs − fee·G is a commitment to the
//     value 0 *iff* Σ(input amounts) = Σ(output amounts) + fee. The spender proves
//     E has no G-component by a Schnorr proof of knowledge of its blinding Δr with
//     respect to H (E = Δr·H) — revealing the amounts to no one.
//
//   • NON-NEGATIVITY — every output amount is in [0, 2ⁿ). Without this a "−5 coin"
//     output could balance the books while minting money from nothing. One
//     AGGREGATED Bulletproof over all outputs proves it in log-size.
//
// This is exactly the kernel + rangeproof structure of Monero / Mimblewimble.
export interface ConfidentialTx {
  inputs: Point[] // input commitments aₖ·G + rₖ·H
  outputs: Point[] // output commitments bⱼ·G + sⱼ·H (padded to a power of two)
  fee: bigint // public fee, in value units
  n: number // range bit width
  range: RangeProof // aggregated proof that every output ∈ [0, 2ⁿ)
  excess: { T: Point; s: bigint } // Schnorr PoK that the kernel excess = Δr·H
}

const ctChallenge = (E: Point, T: Point): bigint =>
  mod(bytesToBig(taggedHash('Curvefield/bp/ct-excess', concat(ser(E), ser(T)))), N)

/** Build a confidential transaction. Inputs/outputs are amounts with blinds; the
 *  outputs are committed, padded to a power of two, range-proven in aggregate, and
 *  the balance is sealed with a kernel-excess signature. */
export function buildConfidentialTx(
  inAmounts: bigint[],
  inBlinds: bigint[],
  outAmounts: bigint[],
  fee: bigint,
  n: number,
): ConfidentialTx {
  const sin = inAmounts.reduce((a, b) => a + b, 0n)
  const sout = outAmounts.reduce((a, b) => a + b, 0n)
  if (sin !== sout + fee) throw new Error('balance broken: Σinputs ≠ Σoutputs + fee')

  const inputs = inAmounts.map((a, i) => commit(a, inBlinds[i]))
  // Pad outputs to a power of two with zero-value commitments (free of charge —
  // a 0-amount output contributes 0·G and is absorbed into the blinding balance).
  const outs = outAmounts.slice()
  const outBlinds = outAmounts.map(() => rand())
  while (!isPow2(outs.length)) {
    outs.push(0n)
    outBlinds.push(rand())
  }
  const outputs = outs.map((b, j) => commit(b, outBlinds[j]))
  const range = proveRange(outs, outBlinds, n)

  // Kernel excess E = Σinputs − Σoutputs − fee·G = (Σrₖ − Σsⱼ)·H.
  let E: Point = null
  for (const c of inputs) E = add(E, c)
  for (const c of outputs) E = sub(E, c)
  E = sub(E, mul(fee, G))
  const dr = mod(
    inBlinds.reduce((a, b) => mod(a + b, N), 0n) - outBlinds.reduce((a, b) => mod(a + b, N), 0n),
    N,
  )
  // Schnorr PoK of Δr with base H: T = t·H, c = Hash(E,T), s = t + c·Δr.
  const t = rand()
  const T = mul(t, H)
  const c = ctChallenge(E, T)
  const s = mod(t + c * dr, N)
  return { inputs, outputs, fee, n, range, excess: { T, s } }
}

/** Verify a confidential transaction: outputs in range, and the books balance. */
export function verifyConfidentialTx(tx: ConfidentialTx): {
  rangeOk: boolean
  balanceOk: boolean
  ok: boolean
} {
  // The range proof must be about exactly these output commitments.
  const sameOutputs =
    tx.range.V.length === tx.outputs.length && tx.range.V.every((v, j) => eq(v, tx.outputs[j]))
  const rangeOk = sameOutputs && verifyRange(tx.range)

  let E: Point = null
  for (const c of tx.inputs) E = add(E, c)
  for (const c of tx.outputs) E = sub(E, c)
  E = sub(E, mul(tx.fee, G))
  const c = ctChallenge(E, tx.excess.T)
  // s·H ?= T + c·E  ⇔  E is a pure-H commitment (value component is zero).
  const balanceOk = eq(mul(tx.excess.s, H), add(tx.excess.T, mul(c, E)))
  return { rangeOk, balanceOk, ok: rangeOk && balanceOk }
}

// ── small helpers ────────────────────────────────────────────────────────────
import { randomScalar } from './rng'
const rand = (): bigint => randomScalar(N) || 1n
const randVec = (len: number): Vec => Array.from({ length: len }, rand)
/** z^e for small non-negative integer e (used for the z^{j+2} aggregation weights). */
function modPowSmall(z: bigint, e: number): bigint {
  let r = 1n
  for (let i = 0; i < e; i++) r = mod(r * z, N)
  return r
}
