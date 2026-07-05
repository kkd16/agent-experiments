// Nova — a folding scheme for Incrementally Verifiable Computation (IVC).
//
// Kothapalli–Setty–Tzialla (2022) asked a deceptively simple question: to prove
// that a function F was applied N times in a row (a hash chain, a VM's fetch/
// execute loop, a rollup's block sequence), must the prover build one giant proof
// over all N steps? Nova's answer is no. Each step emits an ordinary R1CS
// instance, and instead of *proving* it we merely **fold** it into a running
// accumulator — one cheap linear combination of two instances into one — so the
// prover only ever has ONE instance in flight, and a single final proof attests
// to the whole chain. No trusted setup, no pairings, no FFTs: the entire scheme
// rides on the additive homomorphism of a Pedersen commitment.
//
// The trick is the **relaxed R1CS** shape. An ordinary constraint system asks
// (A·Z)∘(B·Z) = (C·Z). Two satisfying assignments do NOT add to a third — the
// quadratic ∘ product breaks linearity. Nova relaxes the equation to
//
//        (A·Z)∘(B·Z) = u·(C·Z) + E
//
// with a scalar `u` and a per-row error vector `E`. THIS shape is closed under a
// random linear combination: fold Z = Z₁ + r·Z₂, and the cross terms land
// exactly in a computable `T`, so E and u absorb them and the folded assignment
// satisfies the folded instance. That is the whole paper in one identity:
//
//   A(Z₁+rZ₂)∘B(Z₁+rZ₂) = (u₁+ru₂)·C(Z₁+rZ₂) + (E₁ + r·T + r²·E₂)
//   where  T = (A·Z₁)∘(B·Z₂) + (A·Z₂)∘(B·Z₁) − u₁·(C·Z₂) − u₂·(C·Z₁).
//
// Because the Pedersen commitment is homomorphic, the *verifier* folds the
// committed instances with the same two elliptic-curve additions and one scalar
// mul per commitment — it never sees a witness. Fiat–Shamir picks r from a hash
// of everything said so far, so a cheating prover can't choose commitments after
// seeing r; the binding commitment then pins the (unknown) witness.
//
// This lab runs the folding scheme end to end over the from-scratch BLS12-381 G₁
// group (`bls12381.ts`) with a non-hiding Pedersen commitment (binding is what
// folding needs; hiding for zero-knowledge is an orthogonal add-on). It builds
// the canonical Nova step z ↦ z³ + z + 5, folds an N-step chain into one relaxed
// instance, and checks that a single relaxed-R1CS satisfaction test — instead of
// N ordinary ones — certifies the entire computation. Verified in selftest.ts:
// the folding identity holds, honest chains accept, and every tamper (corrupted
// witness, forged cross-term, broken chaining) is rejected.

import { R, g1, hashToG1, type G1 } from './bls12381'
import { mod } from './field'
import { sha256, concat, utf8, bigToBytes, bytesToBig } from './sha256'

// ── R1CS ──────────────────────────────────────────────────────────────────────
//
// The assignment vector is Z = [ u | x | W ]:
//   Z[0]        the "one" slot — carries the relaxation scalar u (u = 1 when the
//               instance is an ordinary, un-relaxed R1CS instance),
//   Z[1..p]     the p public IO entries x,
//   Z[p+1..]    the private witness W.

export interface R1CS {
  numVars: number // total columns m = 1 + numPublic + |W|
  numPublic: number // p — how many public IO entries follow the u slot
  A: bigint[][] // n × m
  B: bigint[][]
  C: bigint[][]
}

/** Matrix · vector over 𝔽_r. */
function matVec(M: bigint[][], z: bigint[]): bigint[] {
  return M.map((row) => {
    let acc = 0n
    for (let i = 0; i < row.length; i++) if (row[i] !== 0n) acc = mod(acc + row[i] * z[i], R)
    return acc
  })
}

// ── committed relaxed-R1CS instance / witness ───────────────────────────────────

/** The public, verifier-visible half: two commitments, the scalar u, and the IO. */
export interface RelaxedInstance {
  commE: G1 // Commit(E)
  u: bigint
  commW: G1 // Commit(W)
  x: bigint[] // public IO, length numPublic
}

/** The private, prover-held half: the error vector and the witness it commits to. */
export interface RelaxedWitness {
  E: bigint[] // length n (= number of constraints)
  W: bigint[] // length m − 1 − numPublic
}

/** Reconstruct the full assignment Z = [u | x | W] from an instance+witness pair. */
export function assignment(U: RelaxedInstance, wit: RelaxedWitness): bigint[] {
  return [U.u, ...U.x, ...wit.W]
}

// ── Pedersen vector commitment over G₁ (non-hiding, homomorphic) ─────────────────

/** Deterministic NUMS generator basis: hash-to-curve gives independent points
 *  with no known discrete-log relation, so the commitment is binding. */
function genVec(tag: string, n: number): G1[] {
  return Array.from({ length: n }, (_, i) => hashToG1(utf8(`curvefield/nova/gen/${tag}/${i}`)))
}

/** Commit(v) = Σ vᵢ·Gᵢ. Homomorphic: Commit(a) + [r]·Commit(b) = Commit(a + r·b). */
export function commit(gens: G1[], v: bigint[]): G1 {
  let acc: G1 = null
  for (let i = 0; i < v.length; i++) {
    const c = mod(v[i], R)
    if (c !== 0n) acc = g1.add(acc, g1.mul(c, gens[i]))
  }
  return acc
}

/** Everything a prover/verifier pair shares: the constraint system and the two
 *  generator bases (one sized to |W|, one to n for the error vector). */
export interface NovaParams {
  cs: R1CS
  gW: G1[]
  gE: G1[]
}

export function setup(cs: R1CS): NovaParams {
  const n = cs.A.length
  const wLen = cs.numVars - 1 - cs.numPublic
  return { cs, gW: genVec('W', wLen), gE: genVec('E', n) }
}

// ── satisfaction ────────────────────────────────────────────────────────────────

/** Does (U, wit) satisfy the *relaxed* system, AND do the commitments open? This
 *  single test is what the IVC verifier runs once at the end, in place of N
 *  ordinary R1CS checks. */
export function relaxedSatisfied(p: NovaParams, U: RelaxedInstance, wit: RelaxedWitness): boolean {
  const { cs } = p
  if (U.x.length !== cs.numPublic) return false
  if (wit.W.length !== cs.numVars - 1 - cs.numPublic) return false
  if (wit.E.length !== cs.A.length) return false
  const z = assignment(U, wit)
  const az = matVec(cs.A, z)
  const bz = matVec(cs.B, z)
  const cz = matVec(cs.C, z)
  for (let i = 0; i < cs.A.length; i++) {
    // (A·Z)∘(B·Z) = u·(C·Z) + E
    if (mod(az[i] * bz[i] - U.u * cz[i] - wit.E[i], R) !== 0n) return false
  }
  if (!g1.eq(U.commW, commit(p.gW, wit.W))) return false
  if (!g1.eq(U.commE, commit(p.gE, wit.E))) return false
  return true
}

/** Build an ordinary (un-relaxed) instance: u = 1, E = 0. This is what each IVC
 *  step emits before it is folded in. */
export function strictInstance(
  p: NovaParams,
  x: bigint[],
  W: bigint[],
): { U: RelaxedInstance; wit: RelaxedWitness } {
  const E = new Array(p.cs.A.length).fill(0n)
  const U: RelaxedInstance = {
    commE: null, // Commit(0) = identity
    u: 1n,
    commW: commit(p.gW, W),
    x: x.map((v) => mod(v, R)),
  }
  return { U, wit: { E, W: W.map((v) => mod(v, R)) } }
}

/** The trivially-satisfied relaxed instance the accumulator starts from: u = 0,
 *  E = 0, W = 0, x = 0. Both sides of the relaxed equation are the zero vector. */
export function trivialInstance(p: NovaParams): { U: RelaxedInstance; wit: RelaxedWitness } {
  const wLen = p.cs.numVars - 1 - p.cs.numPublic
  return {
    U: { commE: null, u: 0n, commW: null, x: new Array(p.cs.numPublic).fill(0n) },
    wit: { E: new Array(p.cs.A.length).fill(0n), W: new Array(wLen).fill(0n) },
  }
}

// ── Fiat–Shamir transcript over (𝔽_r, G₁) ────────────────────────────────────────

export class NovaTranscript {
  private state: Uint8Array
  constructor(label: string) {
    this.state = sha256(utf8('curvefield/nova/' + label))
  }
  absorbField(x: bigint): void {
    this.state = sha256(concat(this.state, bigToBytes(mod(x, R), 32)))
  }
  absorbPoint(P: G1): void {
    const bytes =
      P === null
        ? new Uint8Array([0])
        : concat(new Uint8Array([1]), bigToBytes(P.x, 48), bigToBytes(P.y, 48))
    this.state = sha256(concat(this.state, bytes))
  }
  absorbInstance(U: RelaxedInstance): void {
    this.absorbPoint(U.commE)
    this.absorbField(U.u)
    this.absorbPoint(U.commW)
    for (const xi of U.x) this.absorbField(xi)
  }
  /** Squeeze a challenge in 𝔽_r. Reducing 256 hash bits mod the 255-bit r biases
   *  below 2⁻²⁵² — cryptographically negligible. */
  challenge(): bigint {
    this.state = sha256(this.state)
    return bytesToBig(this.state) % R
  }
}

// ── NIFS: the non-interactive folding scheme ─────────────────────────────────────

/** The prover's cross-term: the degree-1 coefficient of the folded quadratic.
 *  T = (A·Z₁)∘(B·Z₂) + (A·Z₂)∘(B·Z₁) − u₁·(C·Z₂) − u₂·(C·Z₁). */
export function crossTerm(
  cs: R1CS,
  U1: RelaxedInstance,
  wit1: RelaxedWitness,
  U2: RelaxedInstance,
  wit2: RelaxedWitness,
): bigint[] {
  const z1 = assignment(U1, wit1)
  const z2 = assignment(U2, wit2)
  const a1 = matVec(cs.A, z1)
  const b1 = matVec(cs.B, z1)
  const c1 = matVec(cs.C, z1)
  const a2 = matVec(cs.A, z2)
  const b2 = matVec(cs.B, z2)
  const c2 = matVec(cs.C, z2)
  const T: bigint[] = []
  for (let i = 0; i < cs.A.length; i++) {
    T.push(mod(a1[i] * b2[i] + a2[i] * b1[i] - U1.u * c2[i] - U2.u * c1[i], R))
  }
  return T
}

/** Fold committed instances with challenge r — the verifier's whole job. Two G₁
 *  adds + a scalar-mul per commitment, and a scalar fold of u and x. No witness. */
export function foldInstance(
  U1: RelaxedInstance,
  U2: RelaxedInstance,
  commT: G1,
  r: bigint,
): RelaxedInstance {
  const r2 = mod(r * r, R)
  return {
    // commE = commE₁ + r·commT + r²·commE₂
    commE: g1.add(U1.commE, g1.add(g1.mul(r, commT), g1.mul(r2, U2.commE))),
    u: mod(U1.u + r * U2.u, R),
    commW: g1.add(U1.commW, g1.mul(r, U2.commW)),
    x: U1.x.map((xi, i) => mod(xi + r * U2.x[i], R)),
  }
}

/** Fold the prover's private witnesses with the same r. */
export function foldWitness(
  wit1: RelaxedWitness,
  wit2: RelaxedWitness,
  T: bigint[],
  r: bigint,
): RelaxedWitness {
  const r2 = mod(r * r, R)
  return {
    E: wit1.E.map((e, i) => mod(e + r * T[i] + r2 * wit2.E[i], R)),
    W: wit1.W.map((w, i) => mod(w + r * wit2.W[i], R)),
  }
}

export interface FoldProof {
  commT: G1
  r: bigint
  U: RelaxedInstance
  wit: RelaxedWitness
}

/** Prover: commit the cross-term, derive r from the transcript, fold both halves. */
export function foldProve(
  p: NovaParams,
  U1: RelaxedInstance,
  wit1: RelaxedWitness,
  U2: RelaxedInstance,
  wit2: RelaxedWitness,
  tr: NovaTranscript,
): FoldProof {
  const T = crossTerm(p.cs, U1, wit1, U2, wit2)
  const commT = commit(p.gE, T)
  tr.absorbInstance(U1)
  tr.absorbInstance(U2)
  tr.absorbPoint(commT)
  const r = tr.challenge()
  return { commT, r, U: foldInstance(U1, U2, commT, r), wit: foldWitness(wit1, wit2, T, r) }
}

/** Verifier: re-derive r from the transcript and fold the committed instances. */
export function foldVerify(
  U1: RelaxedInstance,
  U2: RelaxedInstance,
  commT: G1,
  tr: NovaTranscript,
): { r: bigint; U: RelaxedInstance } {
  tr.absorbInstance(U1)
  tr.absorbInstance(U2)
  tr.absorbPoint(commT)
  const r = tr.challenge()
  return { r, U: foldInstance(U1, U2, commT, r) }
}

// ── the step function F(z) = z³ + z + 5, as an R1CS ─────────────────────────────
//
// Assignment layout Z = [ one | z_in | z_out | sym1 | y ] (numVars 5, numPublic 2).
//   c1:  z_in · z_in = sym1            (sym1 = z_in²)
//   c2:  sym1 · z_in = y              (y    = z_in³)
//   c3:  (y + z_in + 5·one) · one = z_out
// Public IO x = [z_in, z_out] threads one step's output into the next's input.

const IDX = { one: 0, zIn: 1, zOut: 2, sym1: 3, y: 4 } as const

export function stepR1CS(): R1CS {
  const m = 5
  const row = () => new Array<bigint>(m).fill(0n)
  const A: bigint[][] = []
  const B: bigint[][] = []
  const C: bigint[][] = []
  // c1
  let a = row(), b = row(), c = row()
  a[IDX.zIn] = 1n; b[IDX.zIn] = 1n; c[IDX.sym1] = 1n
  A.push(a); B.push(b); C.push(c)
  // c2
  a = row(); b = row(); c = row()
  a[IDX.sym1] = 1n; b[IDX.zIn] = 1n; c[IDX.y] = 1n
  A.push(a); B.push(b); C.push(c)
  // c3
  a = row(); b = row(); c = row()
  a[IDX.y] = 1n; a[IDX.zIn] = 1n; a[IDX.one] = 5n; b[IDX.one] = 1n; c[IDX.zOut] = 1n
  A.push(a); B.push(b); C.push(c)
  return { numVars: m, numPublic: 2, A, B, C }
}

/** Apply F once and return the public IO + private witness for that step. */
export function stepAssign(zIn: bigint): { x: bigint[]; W: bigint[]; zOut: bigint } {
  const z = mod(zIn, R)
  const sym1 = mod(z * z, R)
  const y = mod(sym1 * z, R)
  const zOut = mod(y + z + 5n, R)
  return { x: [z, zOut], W: [sym1, y], zOut }
}

/** F(z) evaluated directly, for cross-checking the folded chain. */
export function stepEval(zIn: bigint): bigint {
  const z = mod(zIn, R)
  return mod(z * z * z + z + 5n, R)
}

// ── IVC: fold an N-step chain into a single relaxed instance ─────────────────────

export interface IvcProof {
  z0: bigint
  zN: bigint
  numSteps: number
  /** the ordinary instance emitted by each step (verifier re-folds these) */
  stepInstances: RelaxedInstance[]
  /** the cross-term commitment produced at each fold */
  commTs: G1[]
  /** the running accumulator instance after each fold (for display / audit) */
  accInstances: RelaxedInstance[]
  /** the ONE folded witness the verifier finally checks */
  finalWit: RelaxedWitness
  finalInstance: RelaxedInstance
}

export function ivcProve(p: NovaParams, z0: bigint, numSteps: number): IvcProof {
  const tr = new NovaTranscript('ivc')
  tr.absorbField(z0)
  let acc = trivialInstance(p)
  const stepInstances: RelaxedInstance[] = []
  const commTs: G1[] = []
  const accInstances: RelaxedInstance[] = []
  let z = mod(z0, R)
  for (let i = 0; i < numSteps; i++) {
    const s = stepAssign(z)
    const step = strictInstance(p, s.x, s.W)
    stepInstances.push(step.U)
    const folded = foldProve(p, acc.U, acc.wit, step.U, step.wit, tr)
    commTs.push(folded.commT)
    acc = { U: folded.U, wit: folded.wit }
    accInstances.push(folded.U)
    z = s.zOut
  }
  return {
    z0: mod(z0, R),
    zN: z,
    numSteps,
    stepInstances,
    commTs,
    accInstances,
    finalWit: acc.wit,
    finalInstance: acc.U,
  }
}

export interface IvcReport {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
}

/** Verify an IVC proof. The verifier re-derives every folding challenge, folds
 *  the committed step instances itself, and runs ONE relaxed-R1CS satisfaction
 *  test on the final accumulator — the succinctness Nova buys. It also checks the
 *  public-IO chaining z₀ → z₁ → … → z_N that full Nova folds into the circuit. */
export function ivcVerify(p: NovaParams, proof: IvcProof): IvcReport {
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  // 1. Each step instance must be a genuine *ordinary* R1CS instance (u=1, E=0).
  let wellFormed = true
  for (const U of proof.stepInstances) {
    if (U.u !== 1n || U.commE !== null) wellFormed = false
  }
  push('steps un-relaxed (u=1, E=0)', wellFormed, `${proof.stepInstances.length} step instances`)

  // 2. Public-IO chaining: z_out of step i is z_in of step i+1; ends match z₀, z_N.
  let chained = proof.stepInstances.length === proof.numSteps
  if (chained && proof.numSteps > 0) {
    if (proof.stepInstances[0].x[0] !== mod(proof.z0, R)) chained = false
    for (let i = 0; i + 1 < proof.stepInstances.length; i++) {
      if (proof.stepInstances[i].x[1] !== proof.stepInstances[i + 1].x[0]) chained = false
    }
    const last = proof.stepInstances[proof.stepInstances.length - 1]
    if (last.x[1] !== mod(proof.zN, R)) chained = false
  }
  push('public-IO chaining z₀→…→z_N', chained, `z₀=${short(proof.z0)}, z_N=${short(proof.zN)}`)

  // 3. Re-fold the committed instances with transcript-derived challenges.
  const tr = new NovaTranscript('ivc')
  tr.absorbField(proof.z0)
  let accU = trivialInstance(p).U
  let refoldOk = proof.commTs.length === proof.numSteps
  for (let i = 0; i < proof.stepInstances.length; i++) {
    const { U } = foldVerify(accU, proof.stepInstances[i], proof.commTs[i], tr)
    accU = U
    if (proof.accInstances[i] && !instanceEq(accU, proof.accInstances[i])) refoldOk = false
  }
  const matchesFinal = instanceEq(accU, proof.finalInstance)
  push('verifier re-fold matches prover', refoldOk && matchesFinal, `${proof.numSteps} folds replayed`)

  // 4. THE succinct check: one relaxed-R1CS satisfaction on the final accumulator.
  const satisfied = relaxedSatisfied(p, accU, proof.finalWit)
  push('final relaxed-R1CS satisfied', satisfied, `1 check replaces ${proof.numSteps}·${p.cs.A.length} = ${proof.numSteps * p.cs.A.length}`)

  const ok = checks.every((c) => c.ok)
  return { ok, checks }
}

export function instanceEq(a: RelaxedInstance, b: RelaxedInstance): boolean {
  if (a.u !== b.u) return false
  if (!g1.eq(a.commW, b.commW) || !g1.eq(a.commE, b.commE)) return false
  if (a.x.length !== b.x.length) return false
  for (let i = 0; i < a.x.length; i++) if (a.x[i] !== b.x[i]) return false
  return true
}

function short(x: bigint): string {
  const v = mod(x, R)
  if (v < 100000n) return v.toString()
  const h = v.toString(16)
  return '0x' + h.slice(0, 6) + '…' + h.slice(-4)
}
