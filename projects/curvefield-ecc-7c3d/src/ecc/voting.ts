// A verifiable, end-to-end-auditable election — the Helios / Belenios protocol,
// assembled from this lab's own parts. It is the capstone of the threshold and
// zero-knowledge shelves: exponential ElGamal (elgamal.ts) for homomorphic
// ballots, a Pedersen distributed key generation (shamir.ts Feldman VSS) so no
// single authority can decrypt, Chaum–Pedersen DLEQ proofs (sigma.ts) so every
// decryption is publicly checkable, and disjunctive Σ-proofs so every ballot is
// provably well-formed.
//
// The guarantees it delivers are the ones real elections are graded on:
//   • Ballot privacy — a voter's choice is a semantically-secure ciphertext; only
//     the *aggregate* is ever decrypted.
//   • Distributed trust — the decryption key exists only as t-of-n Shamir shares
//     across the trustees; fewer than t learn nothing, and no one holds it whole.
//   • Universal verifiability — a bulletin board carries every ciphertext and every
//     proof, so *anyone* can recompute the tally and check it without trusting the
//     authorities, the voters, or the server. verifyElection() is that auditor.
//   • Cast-as-intended integrity — each ballot proves it encrypts exactly one vote
//     for exactly one candidate, so nobody can over-vote or stuff a ballot.
//
// Everything runs in the browser over secp256k1; the "voters" and "trustees" are
// simulated so you can watch — and tamper with — the whole pipeline.

import { secp256k1, G, N } from './secp256k1'
import { type Point } from './curve'
import { mod } from './field'
import { randomScalar } from './rng'
import { lagrangeWeights } from './polynomial'
import { split, verifyShare, type SharingResult } from './shamir'
import { proveDleq, verifyDleq, type DleqProof } from './sigma'
import {
  type Ciphertext,
  type Enc01Proof,
  encrypt,
  addCipher,
  zeroCipher,
  dlogSmall,
  proveEnc01,
  verifyEnc01,
  eq,
} from './elgamal'

// ── Distributed key generation (Pedersen / joint-Feldman) ─────────────────────

export interface Trustee {
  index: bigint // evaluation point i ∈ [1, n]
  share: bigint // skᵢ = Σⱼ fⱼ(i) — this trustee's share of the election key
  vk: Point // verification key Yᵢ = skᵢ·G, public and recomputable from commitments
  dealtOk: boolean // did every share this trustee *received* pass its Feldman check?
}

export interface Election {
  n: number
  t: number
  pk: Point // election public key = sk·G, sk = Σ dealer secrets (nobody holds it)
  trustees: Trustee[]
  dealers: SharingResult[] // one Feldman VSS per trustee; commitments are public
  sk: bigint // the implied secret key — computed ONLY for tests/demos, never used in the tally
}

/**
 * Run a t-of-n Pedersen DKG. Every trustee acts as a dealer: it Shamir-splits a
 * fresh random secret and publishes Feldman commitments; each trustee's key share
 * is the sum of the shares dealt to it, and the election public key is the sum of
 * the dealers' constant-term commitments. The resulting secret key sk = Σ aᵢ₀ is
 * an implicit value no participant ever reconstructs.
 */
export function runDKG(n: number, t: number): Election {
  if (t < 1 || t > n) throw new Error('require 1 ≤ t ≤ n')
  const dealers: SharingResult[] = []
  for (let d = 0; d < n; d++) dealers.push(split(randomScalar(N) || 1n, t, n))

  // Election public key = Σ_dealers C₀ (= Σ aₖ₀ · G = sk·G).
  let pk: Point = null
  for (const d of dealers) pk = secp256k1.add(pk, d.commitments[0])

  const trustees: Trustee[] = []
  for (let j = 1; j <= n; j++) {
    let share = 0n
    let dealtOk = true
    for (const d of dealers) {
      const received = d.shares[j - 1] // dealer's share to party j (index j)
      if (!verifyShare(received, d.commitments)) dealtOk = false
      share = mod(share + received.y, N)
    }
    trustees.push({ index: BigInt(j), share, vk: secp256k1.multiply(share, G), dealtOk })
  }

  const sk = mod(
    dealers.reduce((acc, d) => acc + d.secret, 0n),
    N,
  )
  return { n, t, pk, trustees, dealers, sk }
}

// ── Ballots: a 1-of-k encrypted vote with a validity proof ────────────────────

export interface Ballot {
  voter: string
  choice: number // the plaintext choice — kept ONLY for the demo's audit view
  ciphers: Ciphertext[] // one per candidate, each an encryption of 0 or 1
  proofs: Enc01Proof[] // each ciphertext is provably a bit
  sumProof: DleqProof // the k ciphertexts sum to an encryption of exactly 1
}

/** Cast a ballot for `choice` among `k` candidates under the election key. Each
 *  candidate slot is an encrypted bit with a 0/1 proof, and the aggregate carries
 *  a Chaum–Pedersen proof that the bits sum to exactly one — the "exactly one
 *  vote" guarantee that makes ballot-stuffing detectable by anyone. */
export function castBallot(election: Election, voter: string, choice: number, k: number): Ballot {
  const ciphers: Ciphertext[] = []
  const proofs: Enc01Proof[] = []
  let rSum = 0n
  for (let c = 0; c < k; c++) {
    const v = c === choice ? 1 : 0
    const r = randomScalar(N) || 1n
    const ct = encrypt(election.pk, BigInt(v), r)
    ciphers.push(ct)
    proofs.push(proveEnc01(election.pk, v, r, ct.A, ct.B))
    rSum = mod(rSum + r, N)
  }
  // The aggregate ciphertext encrypts Σvᵢ = 1 with randomness rSum, so a DLEQ that
  // log_G(ΣA) = log_PK(ΣB − G) = rSum proves the sum is exactly one.
  const { proof: sumProof } = proveDleq(rSum, election.pk)
  return { voter, choice, ciphers, proofs, sumProof }
}

/** Verify a ballot without any secret: every slot is a bit, and the slots sum to
 *  exactly one encrypted vote. Returns per-part detail for the audit view. */
export function verifyBallot(
  election: Election,
  ballot: Ballot,
  k: number,
): { ok: boolean; bitsOk: boolean[]; sumOk: boolean } {
  const bitsOk: boolean[] = []
  if (ballot.ciphers.length !== k || ballot.proofs.length !== k) {
    return { ok: false, bitsOk: new Array(k).fill(false), sumOk: false }
  }
  for (let c = 0; c < k; c++) {
    bitsOk.push(verifyEnc01(election.pk, ballot.ciphers[c].A, ballot.ciphers[c].B, ballot.proofs[c]))
  }
  // Aggregate and check the sum-is-one DLEQ.
  const agg = ballot.ciphers.reduce((acc, ct) => addCipher(acc, ct), zeroCipher())
  const Q = secp256k1.subtract(agg.B, G) // (ΣB) − G should equal rSum·PK
  const sumOk = verifyDleq(agg.A, Q, election.pk, ballot.sumProof)
  return { ok: bitsOk.every(Boolean) && sumOk, bitsOk, sumOk }
}

// ── Homomorphic tally ─────────────────────────────────────────────────────────

/** Aggregate every (valid) ballot into one ciphertext per candidate. This is the
 *  homomorphic heart: adding ciphertexts adds the underlying vote counts, so the
 *  result encrypts each candidate's exact total — still without decrypting a soul. */
export function aggregate(ballots: Ballot[], k: number): Ciphertext[] {
  const totals: Ciphertext[] = new Array(k).fill(null).map(() => zeroCipher())
  for (const ballot of ballots) {
    for (let c = 0; c < k; c++) totals[c] = addCipher(totals[c], ballot.ciphers[c])
  }
  return totals
}

// ── Threshold decryption with proofs ──────────────────────────────────────────

export interface DecryptionShare {
  index: bigint // the trustee's evaluation point i
  D: Point // Dᵢ = skᵢ·A  (the partial decryption of this candidate's aggregate)
  proof: DleqProof // Chaum–Pedersen: log_G(Yᵢ) = log_A(Dᵢ) = skᵢ
}

/** A trustee's decryption share of one aggregate ciphertext, with a public proof
 *  it used the same key skᵢ committed in its verification key Yᵢ. */
export function decryptShare(trustee: Trustee, agg: Ciphertext): DecryptionShare {
  // proveDleq(skᵢ, base2 = A) yields P = skᵢ·G = Yᵢ and Q = skᵢ·A = Dᵢ.
  const { Q, proof } = proveDleq(trustee.share, agg.A)
  return { index: trustee.index, D: Q, proof }
}

/** Check a decryption share against the trustee's public verification key Yᵢ and
 *  the ciphertext's A component — no secret needed. */
export function verifyDecryptionShare(vk: Point, agg: Ciphertext, share: DecryptionShare): boolean {
  return verifyDleq(vk, share.D, agg.A, share.proof)
}

/**
 * Combine ≥ t decryption shares by Lagrange interpolation *in the exponent*:
 * Σ λᵢ·Dᵢ = Σ λᵢ·skᵢ·A = sk·A, so B − Σ λᵢ·Dᵢ = m·G. Returns the recovered
 * plaintext point; fewer than t shares (or the wrong subset) reconstruct the wrong
 * key and yield a point that is not m·G for any small m.
 */
export function combineShares(agg: Ciphertext, shares: DecryptionShare[]): Point {
  const xs = shares.map((s) => s.index)
  const weights = lagrangeWeights(xs, 0n, N)
  let combined: Point = null // Σ λᵢ·Dᵢ = sk·A
  shares.forEach((s, k) => {
    combined = secp256k1.add(combined, secp256k1.multiply(weights[k], s.D))
  })
  return secp256k1.subtract(agg.B, combined)
}

// ── The end-to-end election result + universal verifier ───────────────────────

export interface CandidateResult {
  aggregate: Ciphertext
  shares: DecryptionShare[]
  M: Point // the recovered plaintext point m·G
  count: number | null // m, via the bounded discrete log (null ⇒ malformed)
}

export interface Tally {
  results: CandidateResult[]
  counts: (number | null)[]
}

/** Run the full tally: aggregate ballots, gather decryption shares from a chosen
 *  quorum of trustees, combine, and recover each candidate's count by bounded
 *  discrete log (the total can be at most the number of ballots). */
export function tally(ballots: Ballot[], k: number, quorum: Trustee[]): Tally {
  const aggregates = aggregate(ballots, k)
  const results: CandidateResult[] = aggregates.map((agg) => {
    const shares = quorum.map((tr) => decryptShare(tr, agg))
    const M = combineShares(agg, shares)
    const count = dlogSmall(M, ballots.length)
    return { aggregate: agg, shares, M, count }
  })
  return { results, counts: results.map((r) => r.count) }
}

export interface AuditCheck {
  label: string
  ok: boolean
  detail: string
}

/**
 * The universal verifier: given only the public bulletin board (election key,
 * ballots + proofs, tally + decryption proofs), re-derive and re-check everything.
 * This is the function a scrutineer runs; it never touches a secret and trusts no
 * authority. It returns a checklist so the UI can show exactly which guarantees
 * hold — and, when someone tampers, exactly which one snaps.
 */
export function verifyElection(
  election: Election,
  ballots: Ballot[],
  k: number,
  result: Tally,
  quorumIndices: bigint[],
): { ok: boolean; checks: AuditCheck[] } {
  const checks: AuditCheck[] = []
  const push = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail })

  // 1. Every trustee's verification key is consistent with the published DKG
  //    commitments (Yᵢ = Σ_dealers Σ_j Cⱼ·iʲ), and every dealt share checked out.
  let vkOk = true
  for (const tr of election.trustees) {
    let expected: Point = null
    for (const d of election.dealers) {
      let ipow = 1n
      let contrib: Point = null
      for (const Cj of d.commitments) {
        contrib = secp256k1.add(contrib, secp256k1.multiply(ipow, Cj))
        ipow = mod(ipow * tr.index, N)
      }
      expected = secp256k1.add(expected, contrib)
    }
    if (!eq(expected, tr.vk) || !tr.dealtOk) vkOk = false
  }
  push('DKG', vkOk, 'trustee keys match the public Feldman commitments (t-of-n, no dealer knows sk)')

  // 2. Election public key = Σ dealer commitments C₀.
  let pkExpected: Point = null
  for (const d of election.dealers) pkExpected = secp256k1.add(pkExpected, d.commitments[0])
  push('Election key', eq(pkExpected, election.pk), 'PK = Σ trustee public commitments')

  // 3. Every ballot is well-formed: each slot a bit, the slots sum to one.
  let allBallotsOk = true
  for (const b of ballots) {
    if (!verifyBallot(election, b, k).ok) allBallotsOk = false
  }
  push(
    'Ballots',
    allBallotsOk,
    `${ballots.length} ballots each prove "exactly one vote for one candidate"`,
  )

  // 4. The tally's aggregates are the actual homomorphic sum of the ballots.
  const recomputed = aggregate(ballots, k)
  let aggOk = result.results.length === k
  for (let c = 0; c < k && aggOk; c++) {
    if (!eq(recomputed[c].A, result.results[c].aggregate.A)) aggOk = false
    if (!eq(recomputed[c].B, result.results[c].aggregate.B)) aggOk = false
  }
  push('Aggregation', aggOk, 'published per-candidate ciphertexts = Σ of the ballots')

  // 5. Every decryption share carries a valid DLEQ proof, and the recovered point
  //    equals m·G for the claimed count. Quorum size ≥ t is checked too.
  let decOk = quorumIndices.length >= election.t
  const vkByIndex = new Map(election.trustees.map((tr) => [tr.index.toString(), tr.vk]))
  for (let c = 0; c < k && decOk; c++) {
    const res = result.results[c]
    for (const sh of res.shares) {
      const vk = vkByIndex.get(sh.index.toString())
      if (!vk || !verifyDecryptionShare(vk, res.aggregate, sh)) decOk = false
    }
    // The claimed count must actually explain the combined plaintext point.
    const claimed = res.count
    const expectedM = claimed === null ? null : secp256k1.multiply(BigInt(claimed), G)
    if (claimed === null || !eq(expectedM, res.M)) decOk = false
  }
  push('Decryption', decOk, `${quorumIndices.length} trustees proved correct partial decryptions`)

  return { ok: checks.every((c) => c.ok), checks }
}

// ── Tamper helpers (for the live soundness demos) ─────────────────────────────

/** Flip a ballot to encrypt a "2" for its chosen candidate while keeping the old
 *  (now invalid) proof — a ballot-stuffing attempt the verifier must reject. */
export function stuffBallot(election: Election, ballot: Ballot): Ballot {
  const ciphers = ballot.ciphers.map((ct, c) =>
    c === ballot.choice
      ? // Add an encryption of 1 more (randomness 0) → this slot now holds 2.
        addCipher(ct, encrypt(election.pk, 1n, 0n))
      : ct,
  )
  return { ...ballot, ciphers }
}

/** Corrupt a decryption share (a dishonest trustee), invalidating its DLEQ proof. */
export function corruptShare(share: DecryptionShare): DecryptionShare {
  return { ...share, D: secp256k1.add(share.D, G) }
}

/** Plain-text reference count, to grade the homomorphic tally against ground truth. */
export function plaintextCounts(ballots: Ballot[], k: number): number[] {
  const counts = new Array(k).fill(0)
  for (const b of ballots) if (b.choice >= 0 && b.choice < k) counts[b.choice]++
  return counts
}
