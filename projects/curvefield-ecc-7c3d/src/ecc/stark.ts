// A STARK — Scalable Transparent ARgument of Knowledge — built from scratch on
// the FRI engine. This is the fourth proof system in the lab, and the odd one
// out: Groth16, PLONK and Bulletproofs all rest on elliptic-curve hardness (and
// the first two on a trusted setup). A STARK rests on *nothing but a hash*. No
// pairing, no toxic waste, no discrete-log assumption — which is why it is both
// transparent (anyone can verify, nothing secret was generated) and plausibly
// post-quantum (Shor breaks curves, not SHA-256).
//
// The statement proved here is an execution: the computation
//     a₀ = 1,  a₁ = 1,  a_{n+2} = a_n² + a_{n+1²}      (a "Fibonacci-square")
// run for T steps, ending at a public value a_{T−1}. The prover convinces the
// verifier it ran the computation correctly and reached that value, revealing
// nothing else and in time far smaller than re-running it.
//
// The pipeline is the standard AIR → LDE → constraint-quotient → DEEP-ALI → FRI:
//
//  1. AIR: lay the run out as a trace of two columns A=aₙ, B=aₙ₊₁ over the trace
//     domain H = ⟨g⟩ of size T. Correctness becomes algebraic constraints:
//       transition   A(gx) − B(x) = 0,      B(gx) − A(x)² − B(x)² = 0   (rows 0…T−2)
//       boundary     A(1) = 1,  B(1) = 1,   A(g^{T−1}) = output.
//  2. LDE: interpolate each column and re-evaluate it on a blowup×-larger coset D,
//     giving Reed–Solomon codewords with slack for FRI. Commit them by Merkle root.
//  3. Quotients: each constraint, divided by the vanishing polynomial of the rows
//     it must hold on, is a *polynomial iff the constraint holds*. A random linear
//     combination of them is the composition polynomial CP. Commit it.
//  4. DEEP: sample an out-of-domain point ζ, reveal the trace + CP evaluations
//     there, and check the constraint identity at ζ. Fold everything into one
//     DEEP polynomial whose low-degreeness ⟺ the whole proof is consistent.
//  5. FRI proves that DEEP polynomial has low degree. Done.

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
import { buildMerkle, openMerkle, verifyMerkle } from './merkle'
import { Transcript } from './transcript'
import { friProve, friVerify, type FriProof, type FriParams } from './fri'

export interface StarkConfig {
  traceLen: number // T, a power of two
  blowup: number // LDE expansion factor (a power of two ≥ 2)
  numQueries: number // FRI queries — security ≈ numQueries·log₂(blowup) bits
}

export const DEFAULT_CONFIG: StarkConfig = { traceLen: 64, blowup: 8, numQueries: 32 }

/** Run the Fibonacci-square computation and return the two trace columns. */
export function buildTrace(traceLen: number): { A: bigint[]; B: bigint[]; output: bigint } {
  const A = new Array<bigint>(traceLen)
  const B = new Array<bigint>(traceLen)
  A[0] = 1n // a₀
  B[0] = 1n // a₁
  for (let i = 1; i < traceLen; i++) {
    A[i] = B[i - 1] // aᵢ = a_{i}
    B[i] = add(mul(A[i - 1], A[i - 1]), mul(B[i - 1], B[i - 1])) // a_{i+1} = a_{i-1}² + a_i²
  }
  return { A, B, output: A[traceLen - 1] } // output = a_{T−1}
}

/** Just the public output a_{T−1}, without building the whole proof. */
export function fibSquareOutput(traceLen: number): bigint {
  return buildTrace(traceLen).output
}

interface OodValues {
  Az: bigint // A(ζ)
  Bz: bigint // B(ζ)
  Agz: bigint // A(ζ·g)
  Bgz: bigint // B(ζ·g)
}

export interface StarkProof {
  traceLen: number
  blowup: number
  numQueries: number
  output: bigint
  traceRoot: string
  cpRoot: string
  ood: OodValues
  fri: FriProof
  // Per-query openings of the committed trace + composition codewords, at the
  // same positions FRI queried (both halves of each fold pair).
  queries: {
    lo: { A: bigint; B: bigint; cp: bigint; tracePath: string[]; cpPath: string[] }
    hi: { A: bigint; B: bigint; cp: bigint; tracePath: string[]; cpPath: string[] }
  }[]
}

export interface StarkInfo {
  traceLen: number
  domainSize: number
  blowup: number
  numQueries: number
  friLayers: number
  zeta: bigint
  proofFieldElements: number
  proofBytes: number
}

// The five random constraint-combination coefficients + the DEEP coefficient are
// all squeezed from the transcript; grouping the constraint work in one place
// keeps prover and verifier in lockstep.
function drawAlphas(t: Transcript): bigint[] {
  return [
    t.challengeField(),
    t.challengeField(),
    t.challengeField(),
    t.challengeField(),
    t.challengeField(),
  ]
}

/**
 * Evaluate the composition polynomial CP at a single out-of-domain point from the
 * trace values there. This is the constraint identity: both prover and verifier
 * run it, so the value CP is pinned to at ζ is a deterministic function of the
 * (claimed) trace evaluations — the heart of DEEP soundness.
 */
function compositionAt(
  ood: OodValues,
  zeta: bigint,
  alphas: bigint[],
  traceLen: number,
  output: bigint,
  omegaT: bigint,
): bigint {
  const T = BigInt(traceLen)
  const last = pow(omegaT, T - 1n) // g^{T−1}
  const zh = sub(pow(zeta, T), 1n) // Z_H(ζ) = ζ^T − 1
  const zhInv = inv(zh)
  const transAdjust = mul(sub(zeta, last), zhInv) // (ζ − g^{T−1}) / Z_H(ζ)

  const c1 = sub(ood.Agz, ood.Bz) // A(gζ) − B(ζ)
  const c2 = sub(sub(ood.Bgz, mul(ood.Az, ood.Az)), mul(ood.Bz, ood.Bz)) // B(gζ) − A²−B²
  const q1 = mul(c1, transAdjust)
  const q2 = mul(c2, transAdjust)
  const qA0 = mul(sub(ood.Az, 1n), inv(sub(zeta, 1n))) // (A(ζ)−1)/(ζ−1)
  const qB0 = mul(sub(ood.Bz, 1n), inv(sub(zeta, 1n))) // (B(ζ)−1)/(ζ−1)
  const qOut = mul(sub(ood.Az, output), inv(sub(zeta, last))) // (A(ζ)−out)/(ζ−g^{T−1})

  return [q1, q2, qA0, qB0, qOut].reduce((acc, q, i) => add(acc, mul(alphas[i], q)), 0n)
}

export interface ProveOptions {
  /**
   * Fault-injection for the demo: after building an honest trace, bump B at this
   * interior row so the recurrence no longer holds there — a prover fudging one
   * intermediate step while still claiming the correct final output. The proof it
   * produces must be rejected (the constraint quotients stop being polynomials, so
   * FRI catches the non-low-degree composition).
   */
  corruptRow?: number
}

/** Build a full STARK proof for the T-step Fibonacci-square run. */
export function starkProve(
  config: StarkConfig = DEFAULT_CONFIG,
  opts: ProveOptions = {},
): {
  proof: StarkProof
  info: StarkInfo
} {
  const { traceLen: T, blowup, numQueries } = config
  const N = T * blowup
  const offset = GENERATOR
  const omegaT = rootOfUnity(T)
  const omegaN = rootOfUnity(N)

  const { A, B, output } = buildTrace(T)
  if (opts.corruptRow !== undefined) {
    const r = Math.min(Math.max(1, opts.corruptRow), T - 2)
    B[r] = add(B[r], 1n) // break the recurrence at an interior row; output unchanged
  }

  // ── LDE: interpolate the columns over H, re-evaluate over the coset D. ──
  const coeffsA = intt(A)
  const coeffsB = intt(B)
  const A_D = cosetEval(coeffsA, offset, N)
  const B_D = cosetEval(coeffsB, offset, N)

  // Domain points xᵢ = offset·ω_Nⁱ.
  const xs = new Array<bigint>(N)
  { let x = offset; for (let i = 0; i < N; i++) { xs[i] = x; x = mul(x, omegaN) } }

  const transcript = new Transcript('fib-square')
  transcript.absorbField(BigInt(T))
  transcript.absorbField(output)

  // Commit the trace (each leaf holds both columns of a row).
  const traceTree = buildMerkle(A_D.map((a, i) => [a, B_D[i]]))
  transcript.absorbHex(traceTree.root)

  const alphas = drawAlphas(transcript)

  // ── Composition polynomial over D, built pointwise. ──
  const last = pow(omegaT, BigInt(T - 1)) // g^{T−1}
  // Denominators we invert in bulk.
  const zh = xs.map((x) => sub(pow(x, BigInt(T)), 1n)) // Z_H(xᵢ)
  const zhInv = batchInv(zh)
  const xMinus1Inv = batchInv(xs.map((x) => sub(x, 1n)))
  const xMinusLastInv = batchInv(xs.map((x) => sub(x, last)))

  const CP = new Array<bigint>(N)
  for (let i = 0; i < N; i++) {
    const iNext = (i + blowup) % N // shift by blowup = evaluate at g·xᵢ
    const transAdjust = mul(sub(xs[i], last), zhInv[i])
    const c1 = sub(A_D[iNext], B_D[i]) // A(gx) − B(x)
    const c2 = sub(sub(B_D[iNext], mul(A_D[i], A_D[i])), mul(B_D[i], B_D[i]))
    const q1 = mul(c1, transAdjust)
    const q2 = mul(c2, transAdjust)
    const qA0 = mul(sub(A_D[i], 1n), xMinus1Inv[i])
    const qB0 = mul(sub(B_D[i], 1n), xMinus1Inv[i])
    const qOut = mul(sub(A_D[i], output), xMinusLastInv[i])
    CP[i] = add(
      add(add(mul(alphas[0], q1), mul(alphas[1], q2)), add(mul(alphas[2], qA0), mul(alphas[3], qB0))),
      mul(alphas[4], qOut),
    )
  }

  const cpTree = buildMerkle(CP.map((v) => [v]))
  transcript.absorbHex(cpTree.root)

  // ── DEEP: out-of-domain point ζ and the trace values there. ──
  const zeta = transcript.challengeField()
  const gz = mul(zeta, omegaT)
  const ood: OodValues = {
    Az: polyEvalCoeffs(coeffsA, zeta),
    Bz: polyEvalCoeffs(coeffsB, zeta),
    Agz: polyEvalCoeffs(coeffsA, gz),
    Bgz: polyEvalCoeffs(coeffsB, gz),
  }
  transcript.absorbField(ood.Az)
  transcript.absorbField(ood.Bz)
  transcript.absorbField(ood.Agz)
  transcript.absorbField(ood.Bgz)

  const cpZeta = compositionAt(ood, zeta, alphas, T, output, omegaT)
  const gamma = transcript.challengeField()

  // DEEP polynomial: fold the trace + CP quotients at ζ (and the shifted ζ·g for
  // the trace) into one codeword with powers of γ.
  const xMinusZetaInv = batchInv(xs.map((x) => sub(x, zeta)))
  const xMinusGzInv = batchInv(xs.map((x) => sub(x, gz)))
  const g2 = mul(gamma, gamma)
  const g3 = mul(g2, gamma)
  const g4 = mul(g3, gamma)
  const DEEP = new Array<bigint>(N)
  for (let i = 0; i < N; i++) {
    const t1 = mul(sub(A_D[i], ood.Az), xMinusZetaInv[i])
    const t2 = mul(sub(B_D[i], ood.Bz), xMinusZetaInv[i])
    const t3 = mul(sub(A_D[i], ood.Agz), xMinusGzInv[i])
    const t4 = mul(sub(B_D[i], ood.Bgz), xMinusGzInv[i])
    const t5 = mul(sub(CP[i], cpZeta), xMinusZetaInv[i])
    DEEP[i] = add(add(add(t1, mul(gamma, t2)), add(mul(g2, t3), mul(g3, t4))), mul(g4, t5))
  }

  const friParams: FriParams = { size: N, offset, degreeBound: T, numQueries }
  const { proof: fri, positions } = friProve(DEEP, friParams, transcript)

  // Open the committed trace + CP at each FRI query's pair (lo, lo + N/2).
  const half = N >> 1
  const queries = positions.map((lo) => {
    const hi = lo + half
    return {
      lo: {
        A: A_D[lo], B: B_D[lo], cp: CP[lo],
        tracePath: openMerkle(traceTree, lo), cpPath: openMerkle(cpTree, lo),
      },
      hi: {
        A: A_D[hi], B: B_D[hi], cp: CP[hi],
        tracePath: openMerkle(traceTree, hi), cpPath: openMerkle(cpTree, hi),
      },
    }
  })

  const proof: StarkProof = {
    traceLen: T, blowup, numQueries, output,
    traceRoot: traceTree.root, cpRoot: cpTree.root, ood, fri, queries,
  }
  return { proof, info: describe(proof, zeta) }
}

/** Recompute the DEEP codeword at one domain point from opened trace + CP values. */
function deepAt(
  x: bigint,
  aVal: bigint,
  bVal: bigint,
  cpVal: bigint,
  ood: OodValues,
  cpZeta: bigint,
  zeta: bigint,
  gz: bigint,
  gamma: bigint,
): bigint {
  const invZ = inv(sub(x, zeta))
  const invGz = inv(sub(x, gz))
  const t1 = mul(sub(aVal, ood.Az), invZ)
  const t2 = mul(sub(bVal, ood.Bz), invZ)
  const t3 = mul(sub(aVal, ood.Agz), invGz)
  const t4 = mul(sub(bVal, ood.Bgz), invGz)
  const t5 = mul(sub(cpVal, cpZeta), invZ)
  const g2 = mul(gamma, gamma)
  const g3 = mul(g2, gamma)
  const g4 = mul(g3, gamma)
  return add(add(add(t1, mul(gamma, t2)), add(mul(g2, t3), mul(g3, t4))), mul(g4, t5))
}

export interface StarkVerdict {
  ok: boolean
  reason: string
  friOk: boolean
  merkleOk: boolean
  deepConsistent: boolean
}

/** Verify a STARK proof against a claimed public output. */
export function starkVerify(claimedOutput: bigint, config: StarkConfig, proof: StarkProof): StarkVerdict {
  const { traceLen: T, blowup, numQueries } = config
  const N = T * blowup
  const offset = GENERATOR
  const omegaT = rootOfUnity(T)
  const omegaN = rootOfUnity(N)
  const fail = (reason: string, parts: Partial<StarkVerdict> = {}): StarkVerdict => ({
    ok: false, reason, friOk: false, merkleOk: false, deepConsistent: false, ...parts,
  })

  if (proof.traceLen !== T || proof.blowup !== blowup || proof.numQueries !== numQueries)
    return fail('proof parameters do not match verifier config')
  if (proof.output !== ((claimedOutput % P) + P) % P)
    return fail('claimed output ≠ output committed in the proof')

  // Replay the transcript exactly as the prover wrote it.
  const transcript = new Transcript('fib-square')
  transcript.absorbField(BigInt(T))
  transcript.absorbField(proof.output)
  transcript.absorbHex(proof.traceRoot)
  const alphas = drawAlphas(transcript)
  transcript.absorbHex(proof.cpRoot)
  const zeta = transcript.challengeField()
  const gz = mul(zeta, omegaT)
  transcript.absorbField(proof.ood.Az)
  transcript.absorbField(proof.ood.Bz)
  transcript.absorbField(proof.ood.Agz)
  transcript.absorbField(proof.ood.Bgz)
  const cpZeta = compositionAt(proof.ood, zeta, alphas, T, proof.output, omegaT)
  const gamma = transcript.challengeField()

  // FRI: prove the DEEP codeword is low degree. This continues the transcript.
  const friParams: FriParams = { size: N, offset, degreeBound: T, numQueries }
  const friVerdict = friVerify(proof.fri, friParams, transcript)
  if (!friVerdict.ok) return fail('FRI rejected: ' + friVerdict.reason, {})

  // Cross-check: the trace + CP openings must reproduce the FRI layer-0 (DEEP)
  // values at every queried position, and their Merkle paths must be valid.
  if (proof.queries.length !== numQueries) return fail('wrong number of trace openings', { friOk: true })
  const half = N >> 1
  for (let q = 0; q < numQueries; q++) {
    const info = friVerdict.layer0[q]
    const { lo, hi, valLo, valHi } = info
    if (hi !== lo + half) return fail(`query ${q}: pair not (lo, lo+N/2)`, { friOk: true })
    const op = proof.queries[q]

    // Merkle-verify the trace and CP openings.
    if (!verifyMerkle(proof.traceRoot, lo, [op.lo.A, op.lo.B], op.lo.tracePath))
      return fail(`query ${q}: bad trace path (lo)`, { friOk: true })
    if (!verifyMerkle(proof.traceRoot, hi, [op.hi.A, op.hi.B], op.hi.tracePath))
      return fail(`query ${q}: bad trace path (hi)`, { friOk: true })
    if (!verifyMerkle(proof.cpRoot, lo, [op.lo.cp], op.lo.cpPath))
      return fail(`query ${q}: bad CP path (lo)`, { friOk: true })
    if (!verifyMerkle(proof.cpRoot, hi, [op.hi.cp], op.hi.cpPath))
      return fail(`query ${q}: bad CP path (hi)`, { friOk: true })

    // Recompute DEEP from those openings and match FRI's committed layer 0.
    const xLo = mul(offset, pow(omegaN, BigInt(lo)))
    const xHi = mul(offset, pow(omegaN, BigInt(hi)))
    const dLo = deepAt(xLo, op.lo.A, op.lo.B, op.lo.cp, proof.ood, cpZeta, zeta, gz, gamma)
    const dHi = deepAt(xHi, op.hi.A, op.hi.B, op.hi.cp, proof.ood, cpZeta, zeta, gz, gamma)
    if (dLo !== valLo || dHi !== valHi)
      return fail(`query ${q}: DEEP reconstruction ≠ FRI codeword`, { friOk: true, merkleOk: true })
  }

  return {
    ok: true,
    reason: 'FRI low-degree ✓, DEEP + Merkle openings consistent, constraint identity binds at ζ',
    friOk: true, merkleOk: true, deepConsistent: true,
  }
}

// ── small helpers ──

function polyEvalCoeffs(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n
  for (let i = coeffs.length - 1; i >= 0; i--) acc = add(mul(acc, x), coeffs[i])
  return acc
}

function describe(proof: StarkProof, zeta: bigint): StarkInfo {
  const N = proof.traceLen * proof.blowup
  // Count field elements in the proof (roots counted as 4 elements ≈ 32 bytes).
  let fe = 4 /* ood */ + 1 /* output */ + 1 /* finalConst */
  fe += proof.fri.layerRoots.length * 4 + 2 /* trace+cp roots */
  for (const query of proof.fri.queries)
    for (const l of query.layers) fe += 2 + (l.pathLo.length + l.pathHi.length) * 4
  for (const q of proof.queries)
    fe += 6 + (q.lo.tracePath.length + q.hi.tracePath.length + q.lo.cpPath.length + q.hi.cpPath.length) * 4
  return {
    traceLen: proof.traceLen,
    domainSize: N,
    blowup: proof.blowup,
    numQueries: proof.numQueries,
    friLayers: proof.fri.layerRoots.length,
    zeta,
    proofFieldElements: fe,
    proofBytes: fe * 8,
  }
}
