// ── BBS anonymous credentials ────────────────────────────────────────────────
//
// BBS is a **pairing-based multi-message signature** with a superpower ordinary
// signatures lack: the holder of a signed credential can, at presentation time,
// prove they possess a valid issuer signature over a *vector* of attributes while
//   • disclosing an arbitrary subset of those attributes,
//   • hiding all the rest in zero knowledge, and
//   • making every presentation **unlinkable** to every other one.
//
// It is the cryptography under W3C Verifiable Credentials, the ISO mobile
// driver's licence (mDL), and the EU Digital Identity Wallet: an issuer signs
// {name, date-of-birth, licence-no, expiry, over-21, …} once, and the holder can
// later prove "I am over 21" to a bar — revealing *only* that bit — without the
// issuer being online and without two bars being able to tell it was the same
// person. This module builds the whole thing from scratch on the lab's own
// BLS12-381 pairing (`bls12381.ts`), RFC 9380 hash-to-curve generators
// (`hash2curve.ts`), and a Fiat–Shamir Σ-proof — zero crypto dependencies.
//
// ── The scheme (in the BBS family, draft-irtf-cfrg-bbs-signatures) ────────────
//
// Public parameters: a base P1 ∈ 𝔾₁, a domain generator Q₁ ∈ 𝔾₁, and one message
// generator Hᵢ ∈ 𝔾₁ per attribute slot — all NUMS points hashed onto the curve so
// no one knows any discrete-log relation between them. P₂ = G₂ generates 𝔾₂.
//
//   KeyGen:  SK ∈ 𝔽_r,   PK = SK·P₂ ∈ 𝔾₂
//   Sign:    domain = H(PK, generators, header)
//            e      = H(SK, domain, messages)            (deterministic)
//            B      = P1 + domain·Q₁ + Σ mᵢ·Hᵢ
//            A      = B · 1/(SK + e)                      signature = (A, e)
//   Verify:  e(A, PK + e·P₂) ?= e(B, P₂)
//
// The verify equation holds because A·(SK+e) = B, so pairing both sides against
// P₂ gives e(A,(SK+e)·P₂) = e(B,P₂) and PK + e·P₂ = (SK+e)·P₂.  ✔
//
// ── The zero-knowledge selective-disclosure proof (this file's headline) ──────
//
// Presenting the credential must reveal a chosen subset D of attributes yet prove
// a valid signature exists over the *full* vector, hiding the undisclosed U. We
// derive the proof directly (a member of the BBS proof family) so every step is
// checkable here:
//
//   Split B = C + Σ_{j∈U} mⱼ·Hⱼ, where C = P1 + domain·Q₁ + Σ_{i∈D} mᵢ·Hᵢ is
//   entirely recomputable by the verifier from the *disclosed* attributes.
//
//   1. Randomize (this is what buys unlinkability): pick a fresh nonzero r,
//        Ā = r·A,   B̄ = r·B,   D̂ = B̄ − e·Ā.
//      Then from the signature relation, e(Ā, PK) = e(D̂, P₂)  ……… (★)
//      — a single pairing the verifier checks on the *sent* Ā, D̂. Because Ā is
//      uniformly random over presentations, it leaks nothing and links nothing.
//
//   2. D̂ expands to a linear relation the verifier can pose over known points:
//        D̂ = r·C − e·Ā + Σ_{j∈U} uⱼ·Hⱼ,     with uⱼ := r·mⱼ.        ……… (ℛ)
//      A Fiat–Shamir Σ-proof proves knowledge of (r, e, {uⱼ}) satisfying (ℛ).
//
// Soundness: (★) forces D̂ = SK·Ā; substituting into (ℛ) and dividing by r≠0
// yields (SK+e)·(Ā/r) = C + Σ (uⱼ/r)·Hⱼ — a genuine BBS signature (Ā/r, e) over
// the disclosed attributes and the extracted mⱼ = uⱼ/r. So a passing proof
// certifies a real credential. Zero-knowledge: the Σ-proof reveals only blinded
// responses, and the randomizer r hides A and the undisclosed messages.

import {
  type G1,
  type G2,
  g1,
  g2,
  G2_GEN,
  R,
  pairingProduct,
} from './bls12381'
import { Fp12 } from './fp12'
import { hashToCurveG1, expandMessageXmd } from './hash2curve'
import { utf8, concat, bigToBytes } from './sha256'
import { mod, modInv } from './field'
import { randomScalar } from './rng'

// ── Domain-separation tags ────────────────────────────────────────────────────
const CIPHERSUITE = 'CURVEFIELD-BBS-BLS12381-SHA256-'
const GEN_DST = utf8(CIPHERSUITE + 'H2G_HM2S_MESSAGE_GENERATOR_')
const GEN_SEED = utf8(CIPHERSUITE + 'SIG_GENERATOR_SEED_')
const MAP_DST = utf8(CIPHERSUITE + 'MAP_MSG_TO_SCALAR_AS_HASH_')
const H2S_DST = utf8(CIPHERSUITE + 'H2S_')
const SIG_DST = utf8(CIPHERSUITE + 'SIGNATURE_DST_')
const DOM_DST = utf8(CIPHERSUITE + 'DOMAIN_DST_')
const CHAL_DST = utf8(CIPHERSUITE + 'CHALLENGE_DST_')

// ── Scalar helpers ────────────────────────────────────────────────────────────

/** os2ip: big-endian bytes → integer. */
function os2ip(b: Uint8Array): bigint {
  let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  return n
}

/**
 * hash_to_scalar: expand 48 bytes with RFC 9380 expand_message_xmd and reduce
 * mod r. 48 bytes = 384 bits over a 255-bit r leaves a sampling bias below
 * 2⁻¹²⁸ — cryptographically uniform. Never returns 0 (a zero scalar would break
 * the signature's 1/(SK+e), so we nudge the vanishingly-unlikely 0 to 1).
 */
export function hashToScalar(msg: Uint8Array, dst: Uint8Array = H2S_DST): bigint {
  const uniform = expandMessageXmd(msg, dst, 48)
  const s = mod(os2ip(uniform), R)
  return s === 0n ? 1n : s
}

/** Map a human-readable attribute string to a field scalar (message → 𝔽_r). */
export function messageToScalar(message: string): bigint {
  return hashToScalar(utf8(message), MAP_DST)
}

export function messagesToScalars(messages: string[]): bigint[] {
  return messages.map(messageToScalar)
}

// ── Generators ────────────────────────────────────────────────────────────────

export interface Generators {
  /** The base point P1. */
  P1: G1
  /** The domain generator Q₁. */
  Q1: G1
  /** One message generator Hᵢ per attribute slot. */
  H: G1[]
}

const genCache = new Map<number, Generators>()

/**
 * Deterministically derive `count` message generators plus P1 and Q₁ by hashing
 * indexed seeds onto 𝔾₁ (RFC 9380 hash-to-curve). Because each is a random-oracle
 * point, no one knows a discrete-log relation among them — exactly the "nothing
 * up my sleeve" property the scheme's binding rests on. Cached per count.
 */
export function createGenerators(count: number): Generators {
  const cached = genCache.get(count)
  if (cached) return cached
  const gen = (label: string): G1 =>
    hashToCurveG1(concat(GEN_SEED, utf8(label)), GEN_DST)
  const P1 = gen('BP_')
  const Q1 = gen('Q1_')
  const H: G1[] = []
  for (let i = 0; i < count; i++) H.push(gen('H_' + i))
  const g: Generators = { P1, Q1, H }
  genCache.set(count, g)
  return g
}

// ── Serialization for the transcript hashes ──────────────────────────────────
// Points and scalars are folded into hashes byte-exactly so prover and verifier
// derive identical challenges. Affine coordinates are enough here (all points in
// valid flows are non-identity r-torsion points).

const G1_LEN = 96 // two 48-byte 𝔽_p coordinates
function serG1(P: G1): Uint8Array {
  if (P === null) return new Uint8Array(G1_LEN) // identity ⇒ all-zero marker
  return concat(bigToBytes(P.x, 48), bigToBytes(P.y, 48))
}
function serG2(Q: G2): Uint8Array {
  if (Q === null) return new Uint8Array(4 * 48)
  return concat(
    bigToBytes(Q.x.a, 48),
    bigToBytes(Q.x.b, 48),
    bigToBytes(Q.y.a, 48),
    bigToBytes(Q.y.b, 48),
  )
}
function serScalar(s: bigint): Uint8Array {
  return bigToBytes(mod(s, R), 32)
}
function serInt(n: number): Uint8Array {
  return bigToBytes(BigInt(n), 8)
}

// ── Keys / signature / proof types ────────────────────────────────────────────

export interface BbsKey {
  sk: bigint
  pk: G2
}
export interface BbsSignature {
  A: G1
  e: bigint
}
export interface BbsProof {
  /** Randomized signature element Ā = r·A. */
  Abar: G1
  /** D̂ = B̄ − e·Ā, the point (★) pairs against PK. */
  D: G1
  /** Fiat–Shamir challenge. */
  c: bigint
  /** Response for the randomizer r. */
  rHat: bigint
  /** Response for e. */
  eHat: bigint
  /** Responses for the undisclosed messages (uⱼ = r·mⱼ), in ascending index order. */
  mHat: bigint[]
  /** Indices of the disclosed attributes (ascending). */
  disclosed: number[]
  /** Total number of attribute slots L in the credential. */
  total: number
}

// ── Key generation ────────────────────────────────────────────────────────────

/** Derive a key pair from a secret scalar. PK = SK·P₂ ∈ 𝔾₂. */
export function bbsKeygen(sk: bigint): BbsKey {
  const d = mod(sk, R)
  return { sk: d, pk: g2.mul(d, G2_GEN) }
}

// ── Domain and B ──────────────────────────────────────────────────────────────

/** domain = H(PK ‖ L ‖ Q₁ ‖ H₁…H_L ‖ header) — binds generators, count, header. */
function calcDomain(pk: G2, gens: Generators, header: Uint8Array): bigint {
  const parts: Uint8Array[] = [serG2(pk), serInt(gens.H.length), serG1(gens.Q1)]
  for (const h of gens.H) parts.push(serG1(h))
  parts.push(serInt(header.length), header)
  return hashToScalar(concat(...parts), DOM_DST)
}

/** B = P1 + domain·Q₁ + Σ mᵢ·Hᵢ. */
function computeB(gens: Generators, domain: bigint, msgs: bigint[]): G1 {
  let B = g1.add(gens.P1, g1.mul(domain, gens.Q1))
  for (let i = 0; i < msgs.length; i++) B = g1.add(B, g1.mul(msgs[i], gens.H[i]))
  return B
}

// ── Sign ──────────────────────────────────────────────────────────────────────

/**
 * Sign a vector of message scalars. Deterministic: e is derived from the secret
 * key and the messages, so signing the same credential twice yields the same
 * signature (the presentation proof is what randomizes, not the signature).
 */
export function bbsSign(
  key: BbsKey,
  header: Uint8Array,
  msgs: bigint[],
  gens: Generators,
): BbsSignature {
  const domain = calcDomain(key.pk, gens, header)
  const eInput = concat(serScalar(key.sk), serScalar(domain), ...msgs.map(serScalar))
  const e = hashToScalar(eInput, SIG_DST)
  const B = computeB(gens, domain, msgs)
  const denom = mod(key.sk + e, R)
  const A = g1.mul(modInv(denom, R), B)
  return { A, e }
}

// ── Verify ────────────────────────────────────────────────────────────────────

/** Full-disclosure verification: e(A, PK + e·P₂) ?= e(B, P₂). */
export function bbsVerify(
  pk: G2,
  sig: BbsSignature,
  header: Uint8Array,
  msgs: bigint[],
  gens: Generators,
): boolean {
  if (sig.A === null) return false
  const domain = calcDomain(pk, gens, header)
  const B = computeB(gens, domain, msgs)
  // e(A, PK + e·P₂) · e(−B, P₂) ?= 1  (one final exponentiation).
  const pkE = g2.add(pk, g2.mul(sig.e, G2_GEN))
  const prod = pairingProduct([
    { p: sig.A, q: pkE },
    { p: g1.neg(B), q: G2_GEN },
  ])
  return Fp12.eq(prod, Fp12.ONE)
}

// ── The challenge hash, shared by prover and verifier ─────────────────────────

function proofChallenge(
  pk: G2,
  Abar: G1,
  D: G1,
  C: G1,
  T: G1,
  domain: bigint,
  disclosed: number[],
  disclosedMsgs: bigint[],
  ph: Uint8Array,
): bigint {
  const parts: Uint8Array[] = [serG2(pk), serG1(Abar), serG1(D), serG1(C), serG1(T), serScalar(domain)]
  parts.push(serInt(disclosed.length))
  for (let i = 0; i < disclosed.length; i++) {
    parts.push(serInt(disclosed[i]), serScalar(disclosedMsgs[i]))
  }
  parts.push(serInt(ph.length), ph)
  return hashToScalar(concat(...parts), CHAL_DST)
}

// ── ProofGen — selective-disclosure zero-knowledge presentation ───────────────

/**
 * Produce a zero-knowledge proof of possession of `sig` over `msgs`, disclosing
 * exactly the attributes in `disclosedIndexes`. `ph` is the presentation header
 * (e.g. a verifier nonce / session id) bound into the challenge so a proof can't
 * be replayed. Randomness comes from the module RNG — seed it (via `rng.ts`) for
 * reproducible presentations, or leave it for fresh, unlinkable ones.
 */
export function bbsProofGen(
  key: Pick<BbsKey, 'pk'>,
  sig: BbsSignature,
  header: Uint8Array,
  ph: Uint8Array,
  msgs: bigint[],
  disclosedIndexes: number[],
  gens: Generators,
): BbsProof {
  const L = msgs.length
  const disclosed = [...disclosedIndexes].sort((a, b) => a - b)
  const disclosedSet = new Set(disclosed)
  const undisclosed: number[] = []
  for (let i = 0; i < L; i++) if (!disclosedSet.has(i)) undisclosed.push(i)

  const domain = calcDomain(key.pk, gens, header)
  const B = computeB(gens, domain, msgs)

  // 1. Randomize. r must be nonzero so extraction (÷r) is well-defined.
  let r = randomScalar(R)
  if (r === 0n) r = 1n
  const Abar = g1.mul(r, sig.A)
  const Bbar = g1.mul(r, B)
  const D = g1.add(Bbar, g1.mul(mod(-sig.e, R), Abar)) // D̂ = B̄ − e·Ā

  // C = disclosed part of B, recomputable by the verifier.
  let C = g1.add(gens.P1, g1.mul(domain, gens.Q1))
  for (const i of disclosed) C = g1.add(C, g1.mul(msgs[i], gens.H[i]))

  // uⱼ = r·mⱼ for the undisclosed slots.
  const u = undisclosed.map((j) => mod(r * msgs[j], R))

  // 2. Σ-proof of (ℛ): D̂ = r·C − e·Ā + Σ uⱼ·Hⱼ.
  let rTil = randomScalar(R)
  if (rTil === 0n) rTil = 1n
  const eTil = randomScalar(R)
  const uTil = undisclosed.map(() => randomScalar(R))

  // Commitment T = rTil·C − eTil·Ā + Σ uTilⱼ·Hⱼ.
  let T = g1.mul(rTil, C)
  T = g1.add(T, g1.mul(mod(-eTil, R), Abar))
  for (let k = 0; k < undisclosed.length; k++) {
    T = g1.add(T, g1.mul(uTil[k], gens.H[undisclosed[k]]))
  }

  const disclosedMsgs = disclosed.map((i) => msgs[i])
  const c = proofChallenge(key.pk, Abar, D, C, T, domain, disclosed, disclosedMsgs, ph)

  // Responses (schnorr): x̂ = x̃ + c·x.
  const rHat = mod(rTil + c * r, R)
  const eHat = mod(eTil + c * sig.e, R)
  const mHat = u.map((uj, k) => mod(uTil[k] + c * uj, R))

  return { Abar, D, c, rHat, eHat, mHat, disclosed, total: L }
}

// ── ProofVerify ───────────────────────────────────────────────────────────────

/**
 * Verify a selective-disclosure proof. `disclosedMsgs` are the revealed
 * attribute scalars, aligned with `proof.disclosed`. Checks (a) the Σ-proof of
 * (ℛ) via the recomputed challenge, and (b) the pairing (★) e(Ā, PK)=e(D̂, P₂),
 * plus that Ā is non-identity (so the randomizer was genuine).
 */
export function bbsProofVerify(
  pk: G2,
  proof: BbsProof,
  header: Uint8Array,
  ph: Uint8Array,
  disclosedMsgs: bigint[],
  gens: Generators,
): boolean {
  const { Abar, D, c, rHat, eHat, mHat, disclosed, total } = proof
  if (Abar === null || D === null) return false
  if (disclosed.length !== disclosedMsgs.length) return false

  const disclosedSet = new Set(disclosed)
  const undisclosed: number[] = []
  for (let i = 0; i < total; i++) if (!disclosedSet.has(i)) undisclosed.push(i)
  if (mHat.length !== undisclosed.length) return false

  const domain = calcDomain(pk, gens, header)

  // Recompute C from the disclosed attributes.
  let C = g1.add(gens.P1, g1.mul(domain, gens.Q1))
  for (let i = 0; i < disclosed.length; i++) {
    C = g1.add(C, g1.mul(disclosedMsgs[i], gens.H[disclosed[i]]))
  }

  // Recompute the commitment: T' = rHat·C − eHat·Ā + Σ mHatⱼ·Hⱼ − c·D̂.
  let T = g1.mul(rHat, C)
  T = g1.add(T, g1.mul(mod(-eHat, R), Abar))
  for (let k = 0; k < undisclosed.length; k++) {
    T = g1.add(T, g1.mul(mHat[k], gens.H[undisclosed[k]]))
  }
  T = g1.add(T, g1.mul(mod(-c, R), D))

  const cPrime = proofChallenge(pk, Abar, D, C, T, domain, disclosed, disclosedMsgs, ph)
  if (cPrime !== c) return false

  // Pairing (★): e(Ā, PK) = e(D̂, P₂)  ⇔  e(Ā, PK)·e(−D̂, P₂) = 1.
  const prod = pairingProduct([
    { p: Abar, q: pk },
    { p: g1.neg(D), q: G2_GEN },
  ])
  return Fp12.eq(prod, Fp12.ONE)
}

// ── A worked credential: a named attribute set ────────────────────────────────
// Sugar that turns "issue a driver's licence, then prove over-21" into three
// calls, so the UI (and the self-test) read like the real use case.

export interface Credential {
  key: BbsKey
  header: Uint8Array
  attributes: { name: string; value: string }[]
  msgs: bigint[]
  gens: Generators
  sig: BbsSignature
}

/** Issue: an issuer signs a full attribute set. */
export function issueCredential(
  sk: bigint,
  header: string,
  attributes: { name: string; value: string }[],
): Credential {
  const key = bbsKeygen(sk)
  const gens = createGenerators(attributes.length)
  const msgs = attributes.map((a) => messageToScalar(a.value))
  const h = utf8(header)
  const sig = bbsSign(key, h, msgs, gens)
  return { key, header: h, attributes, msgs, gens, sig }
}

/** Present: the holder discloses a chosen subset of attributes by name. */
export function presentCredential(
  cred: Credential,
  discloseNames: string[],
  presentationHeader: string,
): BbsProof {
  const disclosedIndexes = cred.attributes
    .map((a, i) => (discloseNames.includes(a.name) ? i : -1))
    .filter((i) => i >= 0)
  return bbsProofGen(
    { pk: cred.key.pk },
    cred.sig,
    cred.header,
    utf8(presentationHeader),
    cred.msgs,
    disclosedIndexes,
    cred.gens,
  )
}

/** Verify a presentation, given the values the holder claims for disclosed slots. */
export function verifyPresentation(
  pk: G2,
  proof: BbsProof,
  header: string,
  presentationHeader: string,
  disclosedValues: { index: number; value: string }[],
  gens: Generators,
): boolean {
  const byIndex = new Map(disclosedValues.map((d) => [d.index, d.value]))
  const disclosedMsgs = proof.disclosed.map((i) => {
    const v = byIndex.get(i)
    if (v === undefined) return 0n
    return messageToScalar(v)
  })
  return bbsProofVerify(pk, proof, utf8(header), utf8(presentationHeader), disclosedMsgs, gens)
}
