// Exponential ElGamal over secp256k1 — the additively-homomorphic public-key
// encryption at the heart of every verifiable e-voting system (Helios, Belenios,
// Estonia's IVXV). It is the same group law from curve.ts, wrapped so that the
// *ciphertexts add*: multiply two encryptions and you get an encryption of the
// sum of the plaintexts, without ever decrypting. That single property is what
// lets a bulletin board tally thousands of encrypted ballots and then decrypt
// only the total — never a single voter's choice.
//
// The trick is to encode the message in the *exponent*. A textbook ElGamal
// ciphertext is (A, B) = (r·G, M + r·PK) where M is a group element; here we set
// M = m·G, so decryption yields m·G and homomorphism is additive:
//
//     Enc(m₁)·Enc(m₂) = (r₁·G + r₂·G, (m₁+m₂)·G + (r₁+r₂)·PK) = Enc(m₁ + m₂).
//
// Recovering m from m·G is a discrete log — deliberately hard in general, but the
// tallies here are small (bounded by the number of voters), so a baby-step
// giant-step search finishes in √(range) steps. That asymmetry is the whole
// design: everyone can *add* votes, only the range-bounded final total is opened.
//
// On top of the cryptosystem sit two Fiat–Shamir Σ-proofs that make a ballot
// *self-certifying*: a disjunctive Chaum–Pedersen proof that a ciphertext
// encrypts 0 or 1 (so nobody can stuff a "1000" into one candidate), and — reused
// from sigma.ts — the DLEQ proof a trustee attaches to each decryption share.

import { secp256k1, G, N, taggedHash } from './secp256k1'
import { type Point } from './curve'
import { mod } from './field'
import { concat, bigToBytes, bytesToBig } from './sha256'
import { randomScalar } from './rng'

// ── Point (de)serialization + Fiat–Shamir challenge, matching sigma.ts ─────────

const ser = (Q: Point): Uint8Array => {
  if (Q === null) return new Uint8Array(33)
  const out = new Uint8Array(33)
  out[0] = Q.y % 2n === 0n ? 0x02 : 0x03
  out.set(bigToBytes(Q.x, 32), 1)
  return out
}

export const eq = (A: Point, B: Point): boolean =>
  (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)

/** Fiat–Shamir challenge in F_n, domain-separated from the plain Σ-protocols so a
 *  voting proof can never be replayed as (say) a Pedersen bit proof. */
function fsChallenge(points: Point[], extra: bigint[] = []): bigint {
  const parts = [...points.map(ser), ...extra.map((e) => bigToBytes(mod(e, N), 32))]
  return mod(bytesToBig(taggedHash('Curvefield/elgamal/challenge', concat(...parts))), N)
}

// ── The cryptosystem ──────────────────────────────────────────────────────────

/** A ciphertext (A, B) = (r·G, m·G + r·PK). Either component may be O (identity),
 *  which is exactly what an "encryption of 0 with randomness 0" looks like — the
 *  neutral element the homomorphic tally starts from. */
export interface Ciphertext {
  A: Point
  B: Point
}

/** The identity ciphertext (O, O) — an encryption of 0. Adding it changes nothing,
 *  so it seeds the running homomorphic sum. */
export function zeroCipher(): Ciphertext {
  return { A: null, B: null }
}

/** Enc(m; r) = (r·G, m·G + r·PK) under election public key PK. */
export function encrypt(pk: Point, m: bigint, r: bigint): Ciphertext {
  const A = secp256k1.multiply(r, G)
  const B = secp256k1.add(secp256k1.multiply(mod(m, N), G), secp256k1.multiply(r, pk))
  return { A, B }
}

/** The homomorphic group law on ciphertexts: Enc(m₁) ⊕ Enc(m₂) = Enc(m₁+m₂). */
export function addCipher(c1: Ciphertext, c2: Ciphertext): Ciphertext {
  return { A: secp256k1.add(c1.A, c2.A), B: secp256k1.add(c1.B, c2.B) }
}

/** Scale a ciphertext by k: Enc(m)^k = Enc(k·m). (Used to weight ballots.) */
export function scaleCipher(k: bigint, c: Ciphertext): Ciphertext {
  return { A: secp256k1.multiply(k, c.A), B: secp256k1.multiply(k, c.B) }
}

/** Partial decryption with a full secret key: B − sk·A = m·G. The scalar sk is
 *  never held whole in the voting protocol — there each trustee applies only its
 *  *share* of sk to A (see votingDecryptShare) — but the single-key form is the
 *  clearest statement of what decryption *is*, and drives the round-trip tests. */
export function decryptToPoint(sk: bigint, c: Ciphertext): Point {
  return secp256k1.subtract(c.B, secp256k1.multiply(sk, c.A))
}

/**
 * Recover m from M = m·G for a *small* non-negative m ≤ bound, by baby-step
 * giant-step: √bound baby steps j·G tabulated, then giant strides of −⌈√bound⌉·G
 * from M. Returns null if no m in [0, bound] matches — the honest "this tally is
 * impossible" signal a verifier wants when a ciphertext was malformed.
 */
export function dlogSmall(M: Point, bound: number): number | null {
  if (bound < 0) return null
  const m = Math.max(1, Math.ceil(Math.sqrt(bound + 1)))
  // Baby steps: table[j·G] = j for j ∈ [0, m].
  const table = new Map<string, number>()
  let baby: Point = null // 0·G = O
  for (let j = 0; j <= m; j++) {
    const key = baby === null ? 'O' : `${baby.x},${baby.y}`
    if (!table.has(key)) table.set(key, j)
    baby = secp256k1.add(baby, G)
  }
  // Giant steps: subtract m·G each iteration; gamma = M − i·m·G should hit j·G.
  const negGiant = secp256k1.negate(secp256k1.multiply(BigInt(m), G))
  let gamma: Point = M
  for (let i = 0; i <= m + 1; i++) {
    const key = gamma === null ? 'O' : `${gamma.x},${gamma.y}`
    const j = table.get(key)
    if (j !== undefined) {
      const k = i * m + j
      if (k <= bound) return k
    }
    gamma = secp256k1.add(gamma, negGiant)
  }
  return null
}

// ── Ballot-validity proof: a ciphertext encrypts 0 or 1 ───────────────────────
//
// Statement: given PK and (A, B) with A = r·G, prove m ∈ {0, 1} without revealing
// which — i.e. *either* (A = r·G ∧ B = r·PK)  [m=0]  *or*  (A = r·G ∧ B−G = r·PK)
// [m=1]. Each disjunct is a Chaum–Pedersen "two bases, one exponent r" statement;
// the whole thing is their OR via the Cramer–Damgård–Schoenmakers transform: run
// the true branch honestly, *simulate* the false one with a pre-chosen challenge,
// and let the Fiat–Shamir hash fix the split c = c₀ + c₁. A cheating voter who
// tried m = 2 would have to forge one branch for a challenge they cannot predict.

export interface Enc01Proof {
  a: [Point, Point] // aᵥ = commitment against base G, per branch v ∈ {0,1}
  b: [Point, Point] // bᵥ = commitment against base PK
  c: [bigint, bigint] // per-branch challenge; c₀ + c₁ must equal the FS hash
  s: [bigint, bigint] // per-branch response
}

/** Prove the ciphertext (A, B) = encrypt(pk, m, r) encrypts a bit m ∈ {0,1}. */
export function proveEnc01(pk: Point, m: number, r: bigint, A: Point, B: Point): Enc01Proof {
  if (m !== 0 && m !== 1) throw new Error('message must be a bit (0 or 1)')
  const rr = mod(r, N)
  const f = 1 - m // the simulated branch

  const w = randomScalar(N) || 1n // real-branch nonce
  const cFake = randomScalar(N) || 1n
  const sFake = randomScalar(N) || 1n

  const a: [Point, Point] = [null, null]
  const b: [Point, Point] = [null, null]

  // Simulate the false branch f so its two verification equations hold by design:
  //   aᶠ = sᶠ·G − cᶠ·A,   bᶠ = sᶠ·PK − cᶠ·(B − f·G).
  const Bf = secp256k1.subtract(B, secp256k1.multiply(BigInt(f), G))
  a[f] = secp256k1.subtract(secp256k1.multiply(sFake, G), secp256k1.multiply(cFake, A))
  b[f] = secp256k1.subtract(secp256k1.multiply(sFake, pk), secp256k1.multiply(cFake, Bf))

  // Honest commitment on the real branch m.
  a[m] = secp256k1.multiply(w, G)
  b[m] = secp256k1.multiply(w, pk)

  // Fiat–Shamir: the challenge binds PK, the ciphertext, and all four commitments.
  const c = fsChallenge([pk, A, B, a[0], b[0], a[1], b[1]])
  const cc: [bigint, bigint] = [0n, 0n]
  const ss: [bigint, bigint] = [0n, 0n]
  cc[f] = cFake
  cc[m] = mod(c - cFake, N)
  ss[f] = sFake
  ss[m] = mod(w + cc[m] * rr, N)
  return { a, b, c: cc, s: ss }
}

/** Verify an encrypt-a-bit proof against PK and the ciphertext (A, B). */
export function verifyEnc01(pk: Point, A: Point, B: Point, p: Enc01Proof): boolean {
  const c = fsChallenge([pk, A, B, p.a[0], p.b[0], p.a[1], p.b[1]])
  if (mod(p.c[0] + p.c[1], N) !== c) return false
  for (let v = 0; v < 2; v++) {
    // sᵥ·G ?= aᵥ + cᵥ·A
    if (!eq(secp256k1.multiply(p.s[v], G), secp256k1.add(p.a[v], secp256k1.multiply(p.c[v], A))))
      return false
    // sᵥ·PK ?= bᵥ + cᵥ·(B − v·G)
    const Bv = secp256k1.subtract(B, secp256k1.multiply(BigInt(v), G))
    if (!eq(secp256k1.multiply(p.s[v], pk), secp256k1.add(p.b[v], secp256k1.multiply(p.c[v], Bv))))
      return false
  }
  return true
}
