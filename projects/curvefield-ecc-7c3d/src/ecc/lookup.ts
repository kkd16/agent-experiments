// Lookup arguments — proving that every value a circuit uses lies in a fixed
// table, without re-deriving the table in-circuit. This is the piece PLONK
// (see plonk.ts) is *missing*: its selector gates express arithmetic
// (a·b, a+b, constants) cheaply, but a bitwise XOR, an 8-bit range check, or an
// S-box costs dozens of gates each. A lookup collapses all of that to a single
// constraint — "this row appears in that table" — and is the reason modern
// zkVMs (Halo2, Plonky2/3, the zkEVMs of Scroll, Polygon, zkSync) can prove a
// whole CPU: range checks, byte operations, and precompiles all become lookups.
//
// This module builds the two canonical lookup arguments from scratch, on the
// *same* BLS12-381 + KZG machinery this lab already uses for PLONK:
//
//   1. **logUp** (Häbök 2022) — the modern log-derivative argument, and the
//      flagship here: a full non-interactive KZG SNARK. Its identity is
//
//          Σ_i  1/(β − f_i)  =  Σ_j  m_j/(β − t_j),
//
//      where m_j counts how often table entry t_j is looked up. As a rational
//      function of a formal β this holds **iff** every witness value f_i is some
//      table value — a multiset inclusion turned into one field identity. We
//      clear denominators, accumulate the per-row terms into a grand-sum
//      polynomial S over a multiplicative domain H (the same H PLONK uses for
//      its permutation argument), bundle the check into a quotient
//      Q = (constraint + α·L₀·S)/Z_H, commit f, m, S, Q with KZG, and let the
//      verifier re-check the identity at one Fiat–Shamir point ζ from six
//      openings. Soundness is Schwartz–Zippel: ζ is drawn after the commitments
//      are fixed, so a false identity survives with probability ≈ deg/r ≈ 2⁻²³⁰.
//
//   2. **Plookup** (Gabizon–Williamson 2020) — the original, verified here in
//      its transparent multiset-equality form: sort f∪t by the table's order
//      into s, then for random β, γ
//
//          (1+β)ⁿ ∏(γ+f_i) ∏(γ(1+β)+t_i+β·t_{i+1}) = ∏(γ(1+β)+s_i+β·s_{i+1})
//
//      holds iff f ⊆ t. We compute both sides directly — a faithful check of
//      the theorem that started the whole field.
//
// On top of logUp we build the two workhorse applications: an n-bit **range
// check** (lookup into {0,…,2ⁿ−1}) and a **vector lookup** that folds several
// columns into one value with a random challenge, giving a byte-wise **XOR
// table** (rows (x, y, x⊕y)) — exactly how a zkVM proves bitwise ops.
//
// Everything runs on native BigInt over F_r with zero crypto dependencies, and
// is pinned in selftest.ts: honest proofs accept, an out-of-table value is
// rejected, and a tampered opening breaks the pairing check.

import { R, type G1 } from './bls12381'
import {
  type Poly,
  add as pAdd,
  sub as pSub,
  scale as pScale,
  mul as pMul,
  divmod as pDivmod,
  interpolate,
} from './polynomial'
import { mod, modInv } from './field'
import { sha256, concat, bigToBytes, bytesToBig } from './sha256'
import { compressG1 } from './blsenc'
import {
  setup as kzgSetup,
  commit as kzgCommit,
  open as kzgOpen,
  type SRS,
  type Opening,
} from './kzg'
import { batchVerify } from './kzg'
import {
  rootOfUnity,
  domain,
  vanishingH,
  evalVanishing,
  lagrangeBasis,
  lagrangeEval,
} from './plonk'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// ── Fiat–Shamir over F_r ─────────────────────────────────────────────────────
//
// A running SHA-256 state absorbing every prover message (commitments, the
// public table), squeezing challenges β, α, ζ. Mirrors the transcript PLONK
// uses so the two arguments share a threat model: every challenge binds to all
// prior messages, so the prover cannot pick its commitments after seeing them.

class Transcript {
  private state: Uint8Array
  constructor(label: string) {
    this.state = sha256(concat(utf8('curvefield/lookup/'), utf8(label)))
  }
  absorbScalar(x: bigint): void {
    this.state = sha256(concat(this.state, new Uint8Array([0x01]), bigToBytes(mod(x, R), 32)))
  }
  absorbPoint(P: G1): void {
    this.state = sha256(concat(this.state, new Uint8Array([0x02]), compressG1(P)))
  }
  challenge(): bigint {
    const out = sha256(concat(this.state, new Uint8Array([0xff])))
    this.state = sha256(concat(this.state, out)) // ratchet
    const c = mod(bytesToBig(out), R)
    return c === 0n ? 1n : c
  }
}

// ── Small polynomial helpers ─────────────────────────────────────────────────

/** Interpolate the polynomial through (ωⁱ, values[i]) over the size-N domain H. */
function interpOverH(values: bigint[], H: bigint[]): Poly {
  return interpolate(
    H.map((x, i) => ({ x, y: mod(values[i], R) })),
    R,
  )
}

/** Given f(X) = Σ fₖ Xᵏ, return f(ω·X) = Σ (fₖ ωᵏ) Xᵏ — the "next row" shift. */
function shiftByOmega(f: Poly, w: bigint): Poly {
  const out: Poly = new Array(f.length)
  let wk = 1n
  for (let k = 0; k < f.length; k++) {
    out[k] = mod(f[k] * wk, R)
    wk = mod(wk * w, R)
  }
  return out
}

/** Smallest power of two ≥ max(2, n). */
export function padToPow2(n: number): number {
  let N = 1
  while (N < n || N < 2) N <<= 1
  return N
}

// ─────────────────────────────────────────────────────────────────────────────
//  logUp — the log-derivative lookup argument, as a full KZG SNARK
// ─────────────────────────────────────────────────────────────────────────────

/** Public parameters of a logUp instance: the table (public) and the domain. */
export interface LogupInstance {
  table: bigint[] // the fixed lookup table t (public, preprocessed)
  N: number // domain size = padToPow2(max(|table|, |witness|))
}

/** The prover's private artefacts, surfaced for the UI. */
export interface LogupWitnessAux {
  witnessPadded: bigint[] // f padded to length N (with a valid table value)
  tablePadded: bigint[] // t padded to length N (with a duplicate table value)
  multiplicities: bigint[] // m: how often each *padded* table row is looked up
  accumulator: bigint[] // S over H: running sum of the per-row log-derivative terms
  rowTerms: bigint[] // aᵢ = 1/(β−fᵢ) − mᵢ/(β−tᵢ) for each row
  beta: bigint
  inTable: boolean // did every witness value actually appear in the table?
}

export interface LogupProof {
  N: number
  cF: G1 // KZG commitment to f
  cM: G1 // KZG commitment to m
  cS: G1 // KZG commitment to the grand-sum accumulator S
  cQ: G1 // KZG commitment to the quotient Q
  beta: bigint // FS challenge (the formal β in the log-derivative identity)
  alpha: bigint // FS challenge combining the boundary constraint
  zeta: bigint // FS evaluation point
  // openings at ζ (and S additionally at ζ·ω)
  fz: bigint
  tz: bigint
  mz: bigint
  sz: bigint
  sωz: bigint
  qz: bigint
  Wf: G1
  Wt: G1
  Wm: G1
  Ws: G1
  Wsω: G1
  Wq: G1
}

/** Build a KZG SRS large enough for a logUp instance of domain size N. The
 *  quotient reaches degree ≈ 3N, so we size the powers-of-τ to 4N with room. */
export function logupSetup(N: number, tau: bigint): SRS {
  return kzgSetup(4 * N + 4, tau)
}

/**
 * Assign multiplicities. For each distinct table value we place the *entire*
 * count of matching witness entries on its first occurrence in the padded table
 * (other occurrences get 0). The log-derivative identity only constrains the sum
 * Σ_j m_j/(β − t_j), so folding duplicates onto one row is exact — and it makes
 * the padding-with-duplicates trick sound. Returns `inTable=false` (and, when
 * `forceCheat` is set, dumps unmatched counts onto row 0 to build a *failing*
 * proof for the soundness demo) if some witness value is absent from the table.
 */
function buildMultiplicities(
  witnessPadded: bigint[],
  tablePadded: bigint[],
  forceCheat: boolean,
): { m: bigint[]; inTable: boolean } {
  const N = tablePadded.length
  const firstRow = new Map<string, number>()
  for (let j = 0; j < N; j++) {
    const key = tablePadded[j].toString()
    if (!firstRow.has(key)) firstRow.set(key, j)
  }
  const m = new Array<bigint>(N).fill(0n)
  let inTable = true
  for (const v of witnessPadded) {
    const row = firstRow.get(v.toString())
    if (row === undefined) {
      inTable = false
      if (forceCheat) m[0] = mod(m[0] + 1n, R) // best-effort cheat → fails verify
    } else {
      m[row] = mod(m[row] + 1n, R)
    }
  }
  return { m, inTable }
}

/**
 * Produce a non-interactive logUp proof that every entry of `witness` lies in
 * `inst.table`. When `forceCheat` is true the prover still emits a (malformed)
 * proof even though the witness escapes the table, so the caller can watch the
 * verifier reject it.
 */
export function logupProve(
  srs: SRS,
  inst: LogupInstance,
  witness: bigint[],
  opts: { forceCheat?: boolean } = {},
): { proof: LogupProof; aux: LogupWitnessAux } {
  const N = inst.N
  const H = domain(N)
  const w = rootOfUnity(N)

  // Pad witness (repeat a real table value so padding stays a valid lookup) and
  // table (repeat its last value; duplicates are harmless — see multiplicities).
  const table = inst.table
  const witnessPadded = witness.slice()
  while (witnessPadded.length < N) witnessPadded.push(mod(table[0], R))
  const tablePadded = table.map((x) => mod(x, R))
  while (tablePadded.length < N) tablePadded.push(mod(table[table.length - 1], R))

  const { m, inTable } = buildMultiplicities(witnessPadded, tablePadded, opts.forceCheat ?? false)

  // Commit f, m (t is public / preprocessed). Then draw β so it binds to them.
  const fPoly = interpOverH(witnessPadded, H)
  const tPoly = interpOverH(tablePadded, H)
  const mPoly = interpOverH(m, H)
  const cF = kzgCommit(srs, fPoly)
  const cM = kzgCommit(srs, mPoly)

  const tr = new Transcript('logup')
  tr.absorbScalar(BigInt(N))
  for (const v of tablePadded) tr.absorbScalar(v)
  tr.absorbPoint(cF)
  tr.absorbPoint(cM)
  const beta = tr.challenge()

  // Per-row log-derivative terms aᵢ = 1/(β−fᵢ) − mᵢ/(β−tᵢ), then the grand sum
  // S with S₀ = 0 and S_{i+1} = S_i + aᵢ (indices mod N). Because H is a full
  // cycle, Σ(S(ωx)−S(x)) telescopes to 0, so the row constraint forces Σaᵢ = 0.
  const rowTerms: bigint[] = new Array(N)
  for (let i = 0; i < N; i++) {
    const invF = modInv(mod(beta - witnessPadded[i], R), R)
    const invT = modInv(mod(beta - tablePadded[i], R), R)
    rowTerms[i] = mod(invF - mod(m[i] * invT, R), R)
  }
  const S: bigint[] = new Array(N)
  S[0] = 0n
  for (let i = 1; i < N; i++) S[i] = mod(S[i - 1] + rowTerms[i - 1], R)
  const sPoly = interpOverH(S, H)
  const cS = kzgCommit(srs, sPoly)

  tr.absorbPoint(cS)
  const alpha = tr.challenge()

  // Constraint polynomial. Clearing denominators of S(ωX)−S(X) = 1/φ − m/ψ:
  //   C(X) = (S(ωX)−S(X))·φ·ψ − (ψ − m·φ),   φ = β−f, ψ = β−t,
  // which vanishes on H. Add α·L₀·S to pin the boundary S(1) = 0. Divide by Z_H.
  const phi = pSub([beta], fPoly, R) // β − f(X)
  const psi = pSub([beta], tPoly, R) // β − t(X)
  const sShift = shiftByOmega(sPoly, w) // S(ωX)
  const dS = pSub(sShift, sPoly, R)
  const term1 = pMul(dS, pMul(phi, psi, R), R)
  const term2 = pSub(psi, pMul(mPoly, phi, R), R)
  const C = pSub(term1, term2, R)
  const L0 = lagrangeBasis(N, 0)
  const boundary = pScale(pMul(L0, sPoly, R), alpha, R)
  const combined = pAdd(C, boundary, R)
  const { q: qPoly, r: rem } = pDivmod(combined, vanishingH(N), R)
  if (!opts.forceCheat && rem.length !== 0) {
    throw new Error('logup: constraint does not vanish on H (bug or invalid witness)')
  }
  const cQ = kzgCommit(srs, qPoly)

  tr.absorbPoint(cQ)
  const zeta = tr.challenge()

  const zω = mod(zeta * w, R)
  const of = kzgOpen(srs, fPoly, zeta)
  const ot = kzgOpen(srs, tPoly, zeta)
  const om = kzgOpen(srs, mPoly, zeta)
  const os = kzgOpen(srs, sPoly, zeta)
  const osω = kzgOpen(srs, sPoly, zω)
  const oq = kzgOpen(srs, qPoly, zeta)

  const proof: LogupProof = {
    N,
    cF,
    cM,
    cS,
    cQ,
    beta,
    alpha,
    zeta,
    fz: of.y,
    tz: ot.y,
    mz: om.y,
    sz: os.y,
    sωz: osω.y,
    qz: oq.y,
    Wf: of.W,
    Wt: ot.W,
    Wm: om.W,
    Ws: os.W,
    Wsω: osω.W,
    Wq: oq.W,
  }
  const aux: LogupWitnessAux = {
    witnessPadded,
    tablePadded,
    multiplicities: m,
    accumulator: S,
    rowTerms,
    beta,
    inTable,
  }
  return { proof, aux }
}

export interface LogupVerifyResult {
  ok: boolean
  openingsOk: boolean // all six KZG openings check against their commitments
  identityOk: boolean // the log-derivative identity holds at ζ
  detail: string
}

/**
 * Verify a logUp proof. The table is public: the verifier recomputes its
 * commitment and its opening at ζ from scratch, re-derives β, α, ζ from the
 * transcript, batch-checks all six openings with a single multi-pairing, and
 * finally re-evaluates the combined constraint at ζ as a scalar equation.
 */
export function logupVerify(srs: SRS, inst: LogupInstance, proof: LogupProof): LogupVerifyResult {
  const N = inst.N
  const w = rootOfUnity(N)
  const H = domain(N)

  // Rebuild the public table polynomial and its commitment (verifier-side).
  const tablePadded = inst.table.map((x) => mod(x, R))
  while (tablePadded.length < N) tablePadded.push(mod(inst.table[inst.table.length - 1], R))
  const tPoly = interpOverH(tablePadded, H)
  const cT = kzgCommit(srs, tPoly)

  // Re-derive the challenges exactly as the prover did.
  const tr = new Transcript('logup')
  tr.absorbScalar(BigInt(N))
  for (const v of tablePadded) tr.absorbScalar(v)
  tr.absorbPoint(proof.cF)
  tr.absorbPoint(proof.cM)
  const beta = tr.challenge()
  tr.absorbPoint(proof.cS)
  const alpha = tr.challenge()
  tr.absorbPoint(proof.cQ)
  const zeta = tr.challenge()
  const zω = mod(zeta * w, R)

  const challengesOk = beta === proof.beta && alpha === proof.alpha && zeta === proof.zeta

  // Batch-verify all openings against their commitments in one multi-pairing.
  const mkOp = (z: bigint, y: bigint, W: G1): Opening => ({ z, y, W })
  const openingsOk = batchVerify(srs, [
    { C: proof.cF, op: mkOp(zeta, proof.fz, proof.Wf) },
    { C: cT, op: mkOp(zeta, proof.tz, proof.Wt) },
    { C: proof.cM, op: mkOp(zeta, proof.mz, proof.Wm) },
    { C: proof.cS, op: mkOp(zeta, proof.sz, proof.Ws) },
    { C: proof.cS, op: mkOp(zω, proof.sωz, proof.Wsω) },
    { C: proof.cQ, op: mkOp(zeta, proof.qz, proof.Wq) },
  ])

  // Re-check the constraint at ζ from the opened values.
  const phiZ = mod(beta - proof.fz, R)
  const psiZ = mod(beta - proof.tz, R)
  const cZ = mod(
    mod(mod(proof.sωz - proof.sz, R) * mod(phiZ * psiZ, R), R) -
      mod(psiZ - mod(proof.mz * phiZ, R), R),
    R,
  )
  const l0Z = lagrangeEval(N, 0, zeta)
  const combinedZ = mod(cZ + mod(alpha * mod(l0Z * proof.sz, R), R), R)
  const zhZ = evalVanishing(N, zeta)
  const identityOk = combinedZ === mod(proof.qz * zhZ, R)

  const ok = challengesOk && openingsOk && identityOk
  const detail = ok
    ? `identity holds at ζ; 6 openings verified in one pairing`
    : !challengesOk
      ? 'Fiat–Shamir challenges do not match the transcript'
      : !openingsOk
        ? 'a KZG opening failed the pairing check'
        : 'the log-derivative identity does not hold at ζ'
  return { ok, openingsOk, identityOk, detail }
}

/**
 * A transparent, KZG-free replay of the logUp argument (like a naive verifier):
 * recompute the accumulator directly over H from f, t, m and β, and check both
 * that it returns to zero (Σ aᵢ = 0) and that the per-row constraint holds at
 * every domain point. Certifies the multiset inclusion independently of the
 * pairing machinery — useful for the UI and as a cross-check in the self-test.
 */
export function logupReplay(aux: LogupWitnessAux): { closes: boolean; rowsOk: boolean } {
  const N = aux.accumulator.length
  const S = aux.accumulator
  let closes = true
  let rowsOk = true
  // S must satisfy S_{i+1} − S_i = aᵢ on every row (wrapping N−1 → 0), and the
  // wrap forces the total Σaᵢ to be zero.
  let total = 0n
  for (let i = 0; i < N; i++) {
    total = mod(total + aux.rowTerms[i], R)
    const next = S[(i + 1) % N]
    const expected = mod(S[i] + aux.rowTerms[i], R)
    if (i < N - 1 && next !== expected) rowsOk = false
  }
  if (total !== 0n) closes = false
  return { closes, rowsOk }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Vector lookups — folding several columns into one value
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold a tuple (x₀, x₁, …) into a single field element x₀ + γ·x₁ + γ²·x₂ + …
 * A random γ makes the fold collision-resistant, so a lookup on the folded
 * values proves the *tuples* match. This is how a byte-wise operation table is
 * looked up: each row is a triple (a, b, a∘b).
 */
export function foldTuple(tuple: bigint[], gamma: bigint): bigint {
  let acc = 0n
  let g = 1n
  for (const x of tuple) {
    acc = mod(acc + mod(x * g, R), R)
    g = mod(g * gamma, R)
  }
  return acc
}

/** A multi-column (vector) lookup instance: rows of the table and the witness
 *  are equal-length tuples, folded with a shared challenge γ before logUp. */
export interface VectorLookup {
  tableRows: bigint[][]
  witnessRows: bigint[][]
  gamma: bigint
}

/** Fold both sides of a vector lookup and hand back a scalar logUp instance. */
export function foldVectorLookup(v: VectorLookup): { table: bigint[]; witness: bigint[] } {
  return {
    table: v.tableRows.map((r) => foldTuple(r, v.gamma)),
    witness: v.witnessRows.map((r) => foldTuple(r, v.gamma)),
  }
}

// ── A *committed* multi-column vector lookup ─────────────────────────────────
//
// The `foldVectorLookup` above folds tuples into scalars *in the clear* — fine
// when the columns are public, but a real prover commits each column and folds
// only in the exponent, drawing γ by Fiat–Shamir *after* the commitments so it
// can't choose them to force a collision. This is that honest construction: one
// KZG commitment per witness column, a transcript-drawn γ, and a verifier that
// reconstructs the folded openings ff(ζ) = Σ γᵏ fₖ(ζ), tf(ζ) = Σ γᵏ tₖ(ζ) from
// the per-column openings itself. The scalar logUp machinery then runs on the
// folded polynomials exactly as before.

export interface VectorLogupInstance {
  tableRows: bigint[][] // rows of equal-length tuples (public, preprocessed)
  N: number
}

export interface VectorLogupProof {
  N: number
  cols: number
  cF: G1[] // one commitment per witness column
  cM: G1
  cS: G1
  cQ: G1
  gamma: bigint
  beta: bigint
  alpha: bigint
  zeta: bigint
  fz: bigint[] // per-column openings at ζ
  tz: bigint[]
  mz: bigint
  sz: bigint
  sωz: bigint
  qz: bigint
  Wf: G1[]
  Wt: G1[]
  Wm: G1
  Ws: G1
  Wsω: G1
  Wq: G1
}

/** Powers γ⁰, γ¹, …, γ^{k−1}. */
function gammaPowers(gamma: bigint, k: number): bigint[] {
  const out: bigint[] = new Array(k)
  let g = 1n
  for (let i = 0; i < k; i++) {
    out[i] = g
    g = mod(g * gamma, R)
  }
  return out
}

/** Build the logUp constraint/quotient for folded value polynomials ffPoly,
 *  tfPoly (β − f, β − t), a multiplicity poly and an accumulator. Shared by the
 *  committed vector prover; returns the quotient (or throws on a real witness
 *  whose constraint fails to vanish, unless the caller is demoing a cheat). */
function logupQuotient(
  ffPoly: Poly,
  tfPoly: Poly,
  mPoly: Poly,
  sPoly: Poly,
  N: number,
  w: bigint,
  beta: bigint,
  alpha: bigint,
  allowNonExact: boolean,
): Poly {
  const phi = pSub([beta], ffPoly, R)
  const psi = pSub([beta], tfPoly, R)
  const dS = pSub(shiftByOmega(sPoly, w), sPoly, R)
  const term1 = pMul(dS, pMul(phi, psi, R), R)
  const term2 = pSub(psi, pMul(mPoly, phi, R), R)
  const C = pSub(term1, term2, R)
  const boundary = pScale(pMul(lagrangeBasis(N, 0), sPoly, R), alpha, R)
  const combined = pAdd(C, boundary, R)
  const { q, r } = pDivmod(combined, vanishingH(N), R)
  if (!allowNonExact && r.length !== 0) throw new Error('vector logup: constraint does not vanish on H')
  return q
}

/**
 * Prove that every witness *tuple* appears as a table row, with each witness
 * column committed separately and folded by a Fiat–Shamir γ.
 */
export function logupProveVector(
  srs: SRS,
  inst: VectorLogupInstance,
  witnessRows: bigint[][],
  opts: { forceCheat?: boolean } = {},
): { proof: VectorLogupProof; foldedInTable: boolean } {
  const N = inst.N
  const H = domain(N)
  const w = rootOfUnity(N)
  const cols = inst.tableRows[0].length

  // Pad rows (witness with a real table row, table with its last row).
  const tableRowsP = inst.tableRows.map((r) => r.map((x) => mod(x, R)))
  while (tableRowsP.length < N) tableRowsP.push(tableRowsP[tableRowsP.length - 1].slice())
  const witnessRowsP = witnessRows.map((r) => r.map((x) => mod(x, R)))
  while (witnessRowsP.length < N) witnessRowsP.push(inst.tableRows[0].map((x) => mod(x, R)))

  // Per-column polynomials; commit the witness columns.
  const fPoly: Poly[] = []
  const tPoly: Poly[] = []
  const cF: G1[] = []
  for (let k = 0; k < cols; k++) {
    const fCol = witnessRowsP.map((r) => r[k])
    const tCol = tableRowsP.map((r) => r[k])
    const fp = interpOverH(fCol, H)
    fPoly.push(fp)
    tPoly.push(interpOverH(tCol, H))
    cF.push(kzgCommit(srs, fp))
  }

  const tr = new Transcript('logup-vec')
  tr.absorbScalar(BigInt(N))
  tr.absorbScalar(BigInt(cols))
  for (const r of tableRowsP) for (const v of r) tr.absorbScalar(v)
  for (const c of cF) tr.absorbPoint(c)
  const gamma = tr.challenge()

  const gp = gammaPowers(gamma, cols)
  const ffVals = witnessRowsP.map((r) => foldTuple(r, gamma))
  const tfVals = tableRowsP.map((r) => foldTuple(r, gamma))
  const { m, inTable } = buildMultiplicities(ffVals, tfVals, opts.forceCheat ?? false)

  // Folded polynomials as exact linear combinations of the committed columns.
  let ffPoly: Poly = []
  let tfPoly: Poly = []
  for (let k = 0; k < cols; k++) {
    ffPoly = pAdd(ffPoly, pScale(fPoly[k], gp[k], R), R)
    tfPoly = pAdd(tfPoly, pScale(tPoly[k], gp[k], R), R)
  }
  const mPoly = interpOverH(m, H)
  const cM = kzgCommit(srs, mPoly)
  tr.absorbPoint(cM)
  const beta = tr.challenge()

  const S: bigint[] = new Array(N)
  S[0] = 0n
  for (let i = 1; i < N; i++) {
    const invF = modInv(mod(beta - ffVals[i - 1], R), R)
    const invT = modInv(mod(beta - tfVals[i - 1], R), R)
    S[i] = mod(S[i - 1] + mod(invF - mod(m[i - 1] * invT, R), R), R)
  }
  const sPoly = interpOverH(S, H)
  const cS = kzgCommit(srs, sPoly)
  tr.absorbPoint(cS)
  const alpha = tr.challenge()

  const qPoly = logupQuotient(ffPoly, tfPoly, mPoly, sPoly, N, w, beta, alpha, opts.forceCheat ?? false)
  const cQ = kzgCommit(srs, qPoly)
  tr.absorbPoint(cQ)
  const zeta = tr.challenge()
  const zω = mod(zeta * w, R)

  const fOpen = fPoly.map((p) => kzgOpen(srs, p, zeta))
  const tOpen = tPoly.map((p) => kzgOpen(srs, p, zeta))
  const om = kzgOpen(srs, mPoly, zeta)
  const os = kzgOpen(srs, sPoly, zeta)
  const osω = kzgOpen(srs, sPoly, zω)
  const oq = kzgOpen(srs, qPoly, zeta)

  const proof: VectorLogupProof = {
    N,
    cols,
    cF,
    cM,
    cS,
    cQ,
    gamma,
    beta,
    alpha,
    zeta,
    fz: fOpen.map((o) => o.y),
    tz: tOpen.map((o) => o.y),
    mz: om.y,
    sz: os.y,
    sωz: osω.y,
    qz: oq.y,
    Wf: fOpen.map((o) => o.W),
    Wt: tOpen.map((o) => o.W),
    Wm: om.W,
    Ws: os.W,
    Wsω: osω.W,
    Wq: oq.W,
  }
  return { proof, foldedInTable: inTable }
}

/** Verify a committed vector lookup: batch-check every column opening, then fold
 *  the openings and re-check the log-derivative identity at ζ. */
export function logupVerifyVector(
  srs: SRS,
  inst: VectorLogupInstance,
  proof: VectorLogupProof,
): LogupVerifyResult {
  const N = inst.N
  const w = rootOfUnity(N)
  const H = domain(N)
  const cols = proof.cols

  const tableRowsP = inst.tableRows.map((r) => r.map((x) => mod(x, R)))
  while (tableRowsP.length < N) tableRowsP.push(tableRowsP[tableRowsP.length - 1].slice())
  const tPoly: Poly[] = []
  const cT: G1[] = []
  for (let k = 0; k < cols; k++) {
    const tp = interpOverH(tableRowsP.map((r) => r[k]), H)
    tPoly.push(tp)
    cT.push(kzgCommit(srs, tp))
  }

  const tr = new Transcript('logup-vec')
  tr.absorbScalar(BigInt(N))
  tr.absorbScalar(BigInt(cols))
  for (const r of tableRowsP) for (const v of r) tr.absorbScalar(v)
  for (const c of proof.cF) tr.absorbPoint(c)
  const gamma = tr.challenge()
  tr.absorbPoint(proof.cM)
  const beta = tr.challenge()
  tr.absorbPoint(proof.cS)
  const alpha = tr.challenge()
  tr.absorbPoint(proof.cQ)
  const zeta = tr.challenge()
  const zω = mod(zeta * w, R)

  const challengesOk =
    gamma === proof.gamma && beta === proof.beta && alpha === proof.alpha && zeta === proof.zeta

  const mkOp = (z: bigint, y: bigint, W: G1): Opening => ({ z, y, W })
  const items = [
    ...proof.cF.map((C, k) => ({ C, op: mkOp(zeta, proof.fz[k], proof.Wf[k]) })),
    ...cT.map((C, k) => ({ C, op: mkOp(zeta, proof.tz[k], proof.Wt[k]) })),
    { C: proof.cM, op: mkOp(zeta, proof.mz, proof.Wm) },
    { C: proof.cS, op: mkOp(zeta, proof.sz, proof.Ws) },
    { C: proof.cS, op: mkOp(zω, proof.sωz, proof.Wsω) },
    { C: proof.cQ, op: mkOp(zeta, proof.qz, proof.Wq) },
  ]
  const openingsOk = batchVerify(srs, items)

  const gp = gammaPowers(gamma, cols)
  let ffz = 0n
  let tfz = 0n
  for (let k = 0; k < cols; k++) {
    ffz = mod(ffz + mod(gp[k] * proof.fz[k], R), R)
    tfz = mod(tfz + mod(gp[k] * proof.tz[k], R), R)
  }
  const phiZ = mod(beta - ffz, R)
  const psiZ = mod(beta - tfz, R)
  const cZ = mod(
    mod(mod(proof.sωz - proof.sz, R) * mod(phiZ * psiZ, R), R) -
      mod(psiZ - mod(proof.mz * phiZ, R), R),
    R,
  )
  const combinedZ = mod(cZ + mod(alpha * mod(lagrangeEval(N, 0, zeta) * proof.sz, R), R), R)
  const identityOk = combinedZ === mod(proof.qz * evalVanishing(N, zeta), R)

  const ok = challengesOk && openingsOk && identityOk
  const detail = ok
    ? `${cols} columns committed + folded by γ; identity holds at ζ`
    : !challengesOk
      ? 'Fiat–Shamir challenges do not match'
      : !openingsOk
        ? 'a per-column KZG opening failed'
        : 'the folded log-derivative identity does not hold at ζ'
  return { ok, openingsOk, identityOk, detail }
}

// ── Range check ──────────────────────────────────────────────────────────────

/** The n-bit range table {0, 1, …, 2ⁿ−1}. Proving a value looks up into this
 *  table is exactly proving 0 ≤ value < 2ⁿ. */
export function rangeTable(bits: number): bigint[] {
  const size = 1 << bits
  const t: bigint[] = new Array(size)
  for (let i = 0; i < size; i++) t[i] = BigInt(i)
  return t
}

// ── XOR table ────────────────────────────────────────────────────────────────

/** The k-bit XOR table: every row (x, y, x⊕y) for x, y ∈ [0, 2ᵏ). A lookup of
 *  (a, b, c) proves c = a ⊕ b. Returned as tuples for a vector lookup. */
export function xorTable(bits: number): bigint[][] {
  const size = 1 << bits
  const rows: bigint[][] = []
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++) rows.push([BigInt(x), BigInt(y), BigInt(x ^ y)])
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
//  Plookup — the original lookup argument (transparent multiset-equality form)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arrange f ∪ t into s, sorted so equal values are contiguous and the order of
 * *distinct* values follows their first appearance in t — the "sorted by t"
 * sequence Plookup needs. |s| = |f| + |t|.
 */
export function sortByTable(f: bigint[], t: bigint[]): bigint[] {
  const order = new Map<string, number>()
  t.forEach((v, i) => {
    const k = mod(v, R).toString()
    if (!order.has(k)) order.set(k, i)
  })
  const BIG = t.length + f.length + 1
  const rank = (v: bigint) => order.get(mod(v, R).toString()) ?? BIG // out-of-table sinks to the end
  const s = [...f, ...t].map((v) => mod(v, R))
  s.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    return a < b ? -1 : a > b ? 1 : 0
  })
  return s
}

export interface PlookupResult {
  s: bigint[] // the sorted merge of f and t
  lhs: bigint // (1+β)ⁿ ∏(γ+fᵢ) ∏(γ(1+β)+tᵢ+β tᵢ₊₁)
  rhs: bigint // ∏(γ(1+β)+sᵢ+β sᵢ₊₁)
  equal: boolean // lhs = rhs  ⇔  f ⊆ t (w.h.p. over β, γ)
  beta: bigint
  gamma: bigint
}

/**
 * The Plookup multiset-equality theorem, computed directly. Challenges β, γ are
 * drawn by Fiat–Shamir from f and t so the check is deterministic and
 * non-interactive. Both products are evaluated in the clear — a faithful,
 * transparent verifier for the identity at the heart of the original paper.
 */
export function plookupCheck(f: bigint[], t: bigint[]): PlookupResult {
  const tr = new Transcript('plookup')
  for (const v of t) tr.absorbScalar(v)
  for (const v of f) tr.absorbScalar(v)
  const beta = tr.challenge()
  const gamma = tr.challenge()

  const s = sortByTable(f, t)
  const n = f.length
  const d = t.length
  const onePlusB = mod(1n + beta, R)

  let lhs = 1n
  // (1+β)ⁿ
  for (let i = 0; i < n; i++) lhs = mod(lhs * onePlusB, R)
  // ∏ (γ + fᵢ)
  for (let i = 0; i < n; i++) lhs = mod(lhs * mod(gamma + mod(f[i], R), R), R)
  // ∏ (γ(1+β) + tᵢ + β·tᵢ₊₁)
  for (let i = 0; i < d - 1; i++) {
    const factor = mod(mod(gamma * onePlusB, R) + mod(t[i], R) + mod(beta * mod(t[i + 1], R), R), R)
    lhs = mod(lhs * factor, R)
  }

  let rhs = 1n
  for (let i = 0; i < n + d - 1; i++) {
    const factor = mod(mod(gamma * onePlusB, R) + s[i] + mod(beta * s[i + 1], R), R)
    rhs = mod(rhs * factor, R)
  }

  return { s, lhs, rhs, equal: lhs === rhs, beta, gamma }
}
