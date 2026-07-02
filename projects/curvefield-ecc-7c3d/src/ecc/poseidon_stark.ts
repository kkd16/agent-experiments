// A STARK that proves knowledge of a **Poseidon hash preimage**.
//
// The lab's first STARK (`stark.ts`) proved a toy recurrence — a Fibonacci-square
// — chosen because its constraints are trivial (degree two, two columns). This
// one proves something a real system cares about: *"I know a secret preimage m
// such that Poseidon(m) = d"*, for a public digest d, without revealing m and in
// time far below re-hashing. It is the same idea the whole lab is built on — one
// primitive (a hash) carried up to its zero-knowledge form — but now the hash is
// `poseidon.ts`, an *arithmetic* hash whose entire execution is already a list of
// low-degree polynomial identities. That is the whole reason Poseidon exists, and
// this file is the payoff.
//
// It is a genuine multi-column AIR (unlike the two-column fib STARK):
//
//  • Trace. Lay the permutation out as T = 32 rows of t = 8 columns — one row per
//    intermediate state. Rows 0…30 are the 31 states of the 30-round permutation;
//    row 31 pads the domain to a power of two.
//  • Transition (rows 0…29). Between consecutive rows the Poseidon round map must
//    hold, column by column:
//        col_j(g·x) = Σ_k MDS[j][k]·Y_k(x),
//        a_k = col_k(x) + rc_k(x),   Y_0 = a_0^7,
//        Y_k = selFull(x)·a_k^7 + (1−selFull(x))·a_k   (k ≥ 1).
//    The round constants rc_k and the full/partial selector selFull are *public*
//    polynomials interpolated over the trace domain, so the verifier evaluates
//    them itself at the out-of-domain point. The x^7 S-box makes these degree-≈248
//    constraints — an order of magnitude past the fib STARK's degree-2 ones, which
//    is exactly why the FRI degree bound and the LDE blowup are larger here.
//  • Boundary. At row 0 the capacity lanes (cols 4…7) are pinned to 0 — the
//    sponge IV. At row 30 the rate lanes (cols 0…3) are pinned to the public
//    digest d. The rate lanes at row 0 are the *witness* (the secret preimage):
//    no constraint reveals them.
//
// The pipeline is the same AIR → LDE → constraint-quotient → DEEP-ALI → FRI as
// `stark.ts`, generalised to width t and high-degree constraints. Soundness is
// unchanged: if any round is fudged or the wrong digest is claimed, a constraint
// quotient stops being a polynomial, the composition is no longer low degree, and
// FRI rejects.

import {
  P,
  GENERATOR,
  add,
  sub,
  mul,
  inv,
  pow,
  rootOfUnity,
  intt,
  cosetEval,
  batchInv,
} from './goldilocks'
import {
  T_WIDTH,
  RATE,
  ROUNDS,
  RC,
  MDS,
  isFullRound,
  permuteTrace,
  compress,
} from './poseidon'
import { buildMerkle, openMerkle, verifyMerkle } from './merkle'
import { Transcript } from './transcript'
import { friProve, friVerify, type FriProof, type FriParams } from './fri'

// ── Fixed AIR geometry ──
export const TRACE_LEN = 32 // T: 31 states + 1 pad row, a power of two
export const OUT_ROW = ROUNDS // row 30 holds the final state (after ROUNDS rounds)
const NUM_TRANS = T_WIDTH // one transition constraint per output column
const NUM_BOUND = T_WIDTH // 4 capacity (row 0) + 4 output (row OUT_ROW)
const NUM_ALPHAS = NUM_TRANS + NUM_BOUND // random constraint-combination coefficients

export interface PoseidonStarkConfig {
  blowup: number // LDE expansion of the *degree bound* (FRI rate = 1/blowup)
  degreeBound: number // FRI degree claim (a power of two > max composition degree)
  numQueries: number // FRI queries
}

// max composition degree ≤ 248 (selFull·a^7) + 2 − T = 218, so 256 is a safe
// power-of-two bound; N = degreeBound·blowup = 2048 gives a 1/8 FRI rate.
export const DEFAULT_CONFIG: PoseidonStarkConfig = { blowup: 8, degreeBound: 256, numQueries: 28 }

/** The LDE domain size N for a config. */
export function domainSize(cfg: PoseidonStarkConfig): number {
  return cfg.degreeBound * cfg.blowup
}

/** The public digest of a RATE-element preimage — what the STARK proves you know. */
export function digestOf(preimage: bigint[]): bigint[] {
  return compress(preimage)
}

// ── Public constant polynomials (round constants + selector), shared by both
//    prover and verifier. Interpolate the schedules over the trace domain H. ──

interface PublicPolys {
  rcCoeffs: bigint[][] // rcCoeffs[j] = coefficients of rc_j(x), j = 0…t−1
  selCoeffs: bigint[] // coefficients of selFull(x)
}

function buildPublicPolys(): PublicPolys {
  const T = TRACE_LEN
  // rc_j over rows: RC[r][j] for r < ROUNDS, else 0 (pad rows are unconstrained).
  const rcCoeffs: bigint[][] = []
  for (let j = 0; j < T_WIDTH; j++) {
    const vals = new Array<bigint>(T).fill(0n)
    for (let r = 0; r < ROUNDS; r++) vals[r] = RC[r][j]
    rcCoeffs.push(intt(vals))
  }
  // selFull: 1 on full rounds, 0 otherwise (pad rows 0).
  const selVals = new Array<bigint>(T).fill(0n)
  for (let r = 0; r < ROUNDS; r++) selVals[r] = isFullRound(r) ? 1n : 0n
  return { rcCoeffs, selCoeffs: intt(selVals) }
}

const PUBLIC = buildPublicPolys()

/** Evaluate a coefficient vector at a point (Horner). */
function evalCoeffs(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n
  for (let i = coeffs.length - 1; i >= 0; i--) acc = add(mul(acc, x), coeffs[i])
  return acc
}

// ── The Poseidon round map, evaluated symbolically at one point from the state
//    values there. Returns Y = the post-S-box vector; both the pointwise CP
//    builder and the out-of-domain check call it, keeping them in lockstep. ──
function roundImage(state: bigint[], rc: bigint[], selFull: bigint): bigint[] {
  const Y = new Array<bigint>(T_WIDTH)
  for (let k = 0; k < T_WIDTH; k++) {
    const a = add(state[k], rc[k])
    const a2 = mul(a, a)
    const a7 = mul(mul(mul(a2, a2), a2), a) // a^7
    if (k === 0) Y[k] = a7
    else Y[k] = add(mul(selFull, a7), mul(sub(1n, selFull), a)) // sel·a^7 + (1−sel)·a
  }
  const out = new Array<bigint>(T_WIDTH)
  for (let j = 0; j < T_WIDTH; j++) {
    let acc = 0n
    for (let k = 0; k < T_WIDTH; k++) acc = add(acc, mul(MDS[j][k], Y[k]))
    out[j] = acc
  }
  return out
}

interface OodValues {
  cols: bigint[] // col_k(ζ),   k = 0…t−1
  colsNext: bigint[] // col_k(ζ·g), k = 0…t−1  (the next row)
}

export interface PoseidonStarkProof {
  blowup: number
  degreeBound: number
  numQueries: number
  digest: bigint[] // the public statement: Poseidon(preimage) = digest
  traceRoot: string
  cpRoot: string
  ood: OodValues
  fri: FriProof
  queries: {
    lo: { cols: bigint[]; cp: bigint; tracePath: string[]; cpPath: string[] }
    hi: { cols: bigint[]; cp: bigint; tracePath: string[]; cpPath: string[] }
  }[]
}

export interface PoseidonStarkInfo {
  traceLen: number
  width: number
  rounds: number
  domainSize: number
  blowup: number
  numQueries: number
  friLayers: number
  degreeBound: number
  zeta: bigint
  proofFieldElements: number
  proofBytes: number
}

function drawAlphas(t: Transcript): bigint[] {
  const a: bigint[] = []
  for (let i = 0; i < NUM_ALPHAS; i++) a.push(t.challengeField())
  return a
}

/**
 * Reconstruct the composition polynomial value CP(ζ) from the out-of-domain
 * trace values — the constraint identity, run identically by prover and verifier.
 */
function compositionAt(
  ood: OodValues,
  zeta: bigint,
  alphas: bigint[],
  digest: bigint[],
  omegaT: bigint,
): bigint {
  const T = BigInt(TRACE_LEN)
  const gOut = pow(omegaT, BigInt(OUT_ROW)) // g^30 : output row & first excluded row
  const gPad = pow(omegaT, BigInt(TRACE_LEN - 1)) // g^31 : the pad row (also excluded)
  const zh = sub(pow(zeta, T), 1n) // Z_H(ζ) = ζ^T − 1
  // transition holds on rows 0…ROUNDS−1, i.e. everywhere except g^30 and g^31.
  const transAdjust = mul(mul(sub(zeta, gOut), sub(zeta, gPad)), inv(zh))

  // Public round constants + selector at ζ.
  const rc = PUBLIC.rcCoeffs.map((c) => evalCoeffs(c, zeta))
  const selFull = evalCoeffs(PUBLIC.selCoeffs, zeta)
  const image = roundImage(ood.cols, rc, selFull)

  let acc = 0n
  // Transition constraints: col_j(gζ) − image_j, one per column.
  for (let j = 0; j < T_WIDTH; j++) {
    const c = sub(ood.colsNext[j], image[j])
    acc = add(acc, mul(alphas[j], mul(c, transAdjust)))
  }
  // Boundary: capacity lanes (4…7) = 0 at row 0 (x = 1); rate lanes (0…3) =
  // digest at row OUT_ROW (x = g^30).
  const invZeta1 = inv(sub(zeta, 1n))
  const invZetaOut = inv(sub(zeta, gOut))
  for (let j = 0; j < T_WIDTH; j++) {
    const a = alphas[NUM_TRANS + j]
    if (j < RATE) {
      // output lane
      acc = add(acc, mul(a, mul(sub(ood.cols[j], digest[j]), invZetaOut)))
    } else {
      // capacity lane pinned to 0 at row 0
      acc = add(acc, mul(a, mul(ood.cols[j], invZeta1)))
    }
  }
  return acc
}

export interface ProveOptions {
  /**
   * Soundness demo: after building the honest trace, add 1 to one interior state
   * cell so the round map no longer holds there — a prover fudging one step while
   * still claiming the right digest. The proof must be rejected.
   */
  corruptRow?: number
  /**
   * Soundness demo: prove against a digest that is *not* the real hash of the
   * preimage (the prover lies about the statement). Must be rejected.
   */
  forgeDigest?: bigint[]
}

/** Build a STARK proving knowledge of `preimage` with Poseidon(preimage)=digest. */
export function poseidonStarkProve(
  preimage: bigint[],
  cfg: PoseidonStarkConfig = DEFAULT_CONFIG,
  opts: ProveOptions = {},
): { proof: PoseidonStarkProof; info: PoseidonStarkInfo } {
  const { blowup, degreeBound, numQueries } = cfg
  const T = TRACE_LEN
  const N = degreeBound * blowup
  const offset = GENERATOR
  const omegaT = rootOfUnity(T)
  const omegaN = rootOfUnity(N)
  const scale = N / T // index shift for the g·x (next-row) evaluation

  // ── Build the execution trace: one row per permutation state. ──
  const initial = new Array<bigint>(T_WIDTH).fill(0n)
  for (let i = 0; i < RATE; i++) initial[i] = ((preimage[i] % P) + P) % P
  const states = permuteTrace(initial) // length ROUNDS+1 = 31
  const realDigest = states[OUT_ROW].slice(0, RATE)
  const digest = opts.forgeDigest ? opts.forgeDigest.map((d) => ((d % P) + P) % P) : realDigest

  // columns[j][row], padded to T rows (pad row = copy of the last real state).
  const columns: bigint[][] = []
  for (let j = 0; j < T_WIDTH; j++) {
    const col = new Array<bigint>(T)
    for (let r = 0; r < T; r++) col[r] = (r <= OUT_ROW ? states[r] : states[OUT_ROW])[j]
    columns.push(col)
  }
  if (opts.corruptRow !== undefined) {
    const r = Math.min(Math.max(1, opts.corruptRow), OUT_ROW - 1)
    columns[0][r] = add(columns[0][r], 1n) // break the round map at an interior row
  }

  // ── LDE: interpolate each column over H, re-evaluate on the coset D. ──
  const colCoeffs = columns.map((c) => intt(c))
  const colD = colCoeffs.map((c) => cosetEval(c, offset, N))

  // Public polys evaluated over D.
  const rcD = PUBLIC.rcCoeffs.map((c) => cosetEval(c, offset, N))
  const selD = cosetEval(PUBLIC.selCoeffs, offset, N)

  // Domain points xᵢ = offset·ω_Nⁱ.
  const xs = new Array<bigint>(N)
  { let x = offset; for (let i = 0; i < N; i++) { xs[i] = x; x = mul(x, omegaN) } }

  const transcript = new Transcript('poseidon-preimage')
  transcript.absorbField(BigInt(ROUNDS))
  for (const d of digest) transcript.absorbField(d)

  // Commit the trace (each leaf holds the whole 8-column row).
  const traceTree = buildMerkle(colD[0].map((_, i) => colD.map((c) => c[i])))
  transcript.absorbHex(traceTree.root)

  const alphas = drawAlphas(transcript)

  // ── Composition polynomial over D, built pointwise. ──
  const gOut = pow(omegaT, BigInt(OUT_ROW))
  const gPad = pow(omegaT, BigInt(T - 1))
  const zh = xs.map((x) => sub(pow(x, BigInt(T)), 1n))
  const zhInv = batchInv(zh)
  const xMinus1Inv = batchInv(xs.map((x) => sub(x, 1n)))
  const xMinusOutInv = batchInv(xs.map((x) => sub(x, gOut)))

  const CP = new Array<bigint>(N)
  for (let i = 0; i < N; i++) {
    const iNext = (i + scale) % N
    const state = colD.map((c) => c[i])
    const rc = rcD.map((c) => c[i])
    const image = roundImage(state, rc, selD[i])
    const transAdjust = mul(mul(sub(xs[i], gOut), sub(xs[i], gPad)), zhInv[i])
    let acc = 0n
    for (let j = 0; j < T_WIDTH; j++) {
      const c = sub(colD[j][iNext], image[j])
      acc = add(acc, mul(alphas[j], mul(c, transAdjust)))
    }
    for (let j = 0; j < T_WIDTH; j++) {
      const a = alphas[NUM_TRANS + j]
      if (j < RATE) acc = add(acc, mul(a, mul(sub(colD[j][i], digest[j]), xMinusOutInv[i])))
      else acc = add(acc, mul(a, mul(colD[j][i], xMinus1Inv[i])))
    }
    CP[i] = acc
  }

  const cpTree = buildMerkle(CP.map((v) => [v]))
  transcript.absorbHex(cpTree.root)

  // ── DEEP: out-of-domain point ζ and the trace values there. ──
  const zeta = transcript.challengeField()
  const gz = mul(zeta, omegaT)
  const ood: OodValues = {
    cols: colCoeffs.map((c) => evalCoeffs(c, zeta)),
    colsNext: colCoeffs.map((c) => evalCoeffs(c, gz)),
  }
  for (const v of ood.cols) transcript.absorbField(v)
  for (const v of ood.colsNext) transcript.absorbField(v)

  const cpZeta = compositionAt(ood, zeta, alphas, digest, omegaT)
  const gamma = transcript.challengeField()

  // DEEP polynomial: fold every column quotient at ζ and at ζ·g, plus the CP
  // quotient at ζ, with successive powers of γ.
  const xMinusZetaInv = batchInv(xs.map((x) => sub(x, zeta)))
  const xMinusGzInv = batchInv(xs.map((x) => sub(x, gz)))
  const DEEP = new Array<bigint>(N)
  for (let i = 0; i < N; i++) {
    let acc = 0n
    let gp = 1n
    for (let k = 0; k < T_WIDTH; k++) {
      acc = add(acc, mul(gp, mul(sub(colD[k][i], ood.cols[k]), xMinusZetaInv[i])))
      gp = mul(gp, gamma)
      acc = add(acc, mul(gp, mul(sub(colD[k][i], ood.colsNext[k]), xMinusGzInv[i])))
      gp = mul(gp, gamma)
    }
    acc = add(acc, mul(gp, mul(sub(CP[i], cpZeta), xMinusZetaInv[i])))
    DEEP[i] = acc
  }

  const friParams: FriParams = { size: N, offset, degreeBound, numQueries }
  const { proof: fri, positions } = friProve(DEEP, friParams, transcript)

  const half = N >> 1
  const queries = positions.map((lo) => {
    const hi = lo + half
    return {
      lo: {
        cols: colD.map((c) => c[lo]), cp: CP[lo],
        tracePath: openMerkle(traceTree, lo), cpPath: openMerkle(cpTree, lo),
      },
      hi: {
        cols: colD.map((c) => c[hi]), cp: CP[hi],
        tracePath: openMerkle(traceTree, hi), cpPath: openMerkle(cpTree, hi),
      },
    }
  })

  const proof: PoseidonStarkProof = {
    blowup, degreeBound, numQueries, digest,
    traceRoot: traceTree.root, cpRoot: cpTree.root, ood, fri, queries,
  }
  return { proof, info: describe(proof, zeta) }
}

/** Recompute the DEEP codeword at one domain point from opened trace + CP values. */
function deepAt(
  x: bigint,
  cols: bigint[],
  cpVal: bigint,
  ood: OodValues,
  cpZeta: bigint,
  zeta: bigint,
  gz: bigint,
  gamma: bigint,
): bigint {
  const invZ = inv(sub(x, zeta))
  const invGz = inv(sub(x, gz))
  let acc = 0n
  let gp = 1n
  for (let k = 0; k < T_WIDTH; k++) {
    acc = add(acc, mul(gp, mul(sub(cols[k], ood.cols[k]), invZ)))
    gp = mul(gp, gamma)
    acc = add(acc, mul(gp, mul(sub(cols[k], ood.colsNext[k]), invGz)))
    gp = mul(gp, gamma)
  }
  acc = add(acc, mul(gp, mul(sub(cpVal, cpZeta), invZ)))
  return acc
}

export interface PoseidonStarkVerdict {
  ok: boolean
  reason: string
  friOk: boolean
  merkleOk: boolean
  deepConsistent: boolean
}

/** Verify a proof that some preimage hashes to `claimedDigest`. */
export function poseidonStarkVerify(
  claimedDigest: bigint[],
  cfg: PoseidonStarkConfig,
  proof: PoseidonStarkProof,
): PoseidonStarkVerdict {
  const { blowup, degreeBound, numQueries } = cfg
  const T = TRACE_LEN
  const N = degreeBound * blowup
  const offset = GENERATOR
  const omegaT = rootOfUnity(T)
  const omegaN = rootOfUnity(N)
  const fail = (reason: string, parts: Partial<PoseidonStarkVerdict> = {}): PoseidonStarkVerdict => ({
    ok: false, reason, friOk: false, merkleOk: false, deepConsistent: false, ...parts,
  })

  if (proof.blowup !== blowup || proof.degreeBound !== degreeBound || proof.numQueries !== numQueries)
    return fail('proof parameters do not match verifier config')
  const norm = claimedDigest.map((d) => ((d % P) + P) % P)
  if (proof.digest.length !== norm.length || proof.digest.some((d, i) => d !== norm[i]))
    return fail('claimed digest ≠ digest committed in the proof')

  const transcript = new Transcript('poseidon-preimage')
  transcript.absorbField(BigInt(ROUNDS))
  for (const d of proof.digest) transcript.absorbField(d)
  transcript.absorbHex(proof.traceRoot)
  const alphas = drawAlphas(transcript)
  transcript.absorbHex(proof.cpRoot)
  const zeta = transcript.challengeField()
  const gz = mul(zeta, omegaT)
  if (proof.ood.cols.length !== T_WIDTH || proof.ood.colsNext.length !== T_WIDTH)
    return fail('malformed out-of-domain values')
  for (const v of proof.ood.cols) transcript.absorbField(v)
  for (const v of proof.ood.colsNext) transcript.absorbField(v)
  const cpZeta = compositionAt(proof.ood, zeta, alphas, proof.digest, omegaT)
  const gamma = transcript.challengeField()

  const friParams: FriParams = { size: N, offset, degreeBound, numQueries }
  const friVerdict = friVerify(proof.fri, friParams, transcript)
  if (!friVerdict.ok) return fail('FRI rejected: ' + friVerdict.reason)

  if (proof.queries.length !== numQueries) return fail('wrong number of trace openings', { friOk: true })
  const half = N >> 1
  for (let q = 0; q < numQueries; q++) {
    const info = friVerdict.layer0[q]
    const { lo, hi, valLo, valHi } = info
    if (hi !== lo + half) return fail(`query ${q}: pair not (lo, lo+N/2)`, { friOk: true })
    const op = proof.queries[q]
    if (op.lo.cols.length !== T_WIDTH || op.hi.cols.length !== T_WIDTH)
      return fail(`query ${q}: malformed column opening`, { friOk: true })

    if (!verifyMerkle(proof.traceRoot, lo, op.lo.cols, op.lo.tracePath))
      return fail(`query ${q}: bad trace path (lo)`, { friOk: true })
    if (!verifyMerkle(proof.traceRoot, hi, op.hi.cols, op.hi.tracePath))
      return fail(`query ${q}: bad trace path (hi)`, { friOk: true })
    if (!verifyMerkle(proof.cpRoot, lo, [op.lo.cp], op.lo.cpPath))
      return fail(`query ${q}: bad CP path (lo)`, { friOk: true })
    if (!verifyMerkle(proof.cpRoot, hi, [op.hi.cp], op.hi.cpPath))
      return fail(`query ${q}: bad CP path (hi)`, { friOk: true })

    const xLo = mul(offset, pow(omegaN, BigInt(lo)))
    const xHi = mul(offset, pow(omegaN, BigInt(hi)))
    const dLo = deepAt(xLo, op.lo.cols, op.lo.cp, proof.ood, cpZeta, zeta, gz, gamma)
    const dHi = deepAt(xHi, op.hi.cols, op.hi.cp, proof.ood, cpZeta, zeta, gz, gamma)
    if (dLo !== valLo || dHi !== valHi)
      return fail(`query ${q}: DEEP reconstruction ≠ FRI codeword`, { friOk: true, merkleOk: true })
  }

  return {
    ok: true,
    reason: 'FRI low-degree ✓, DEEP + Merkle openings consistent, Poseidon round + boundary identities bind at ζ',
    friOk: true, merkleOk: true, deepConsistent: true,
  }
}

function describe(proof: PoseidonStarkProof, zeta: bigint): PoseidonStarkInfo {
  const N = proof.degreeBound * proof.blowup
  let fe = proof.ood.cols.length + proof.ood.colsNext.length + proof.digest.length + 1
  fe += proof.fri.layerRoots.length * 4 + 2
  for (const query of proof.fri.queries)
    for (const l of query.layers) fe += 2 + (l.pathLo.length + l.pathHi.length) * 4
  for (const q of proof.queries)
    fe += q.lo.cols.length + q.hi.cols.length + 2 +
      (q.lo.tracePath.length + q.hi.tracePath.length + q.lo.cpPath.length + q.hi.cpPath.length) * 4
  return {
    traceLen: TRACE_LEN,
    width: T_WIDTH,
    rounds: ROUNDS,
    domainSize: N,
    blowup: proof.blowup,
    numQueries: proof.numQueries,
    friLayers: proof.fri.layerRoots.length,
    degreeBound: proof.degreeBound,
    zeta,
    proofFieldElements: fe,
    proofBytes: fe * 8,
  }
}
