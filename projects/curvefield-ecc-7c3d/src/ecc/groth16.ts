// Groth16 — a real zk-SNARK, end to end, on the from-scratch BLS12-381 pairing.
//
// This is the proof system behind Zcash Sapling and countless rollups: a prover
// convinces a verifier it knows a satisfying assignment to an arithmetic circuit
// while revealing nothing but the public inputs, and the proof is just THREE
// group elements (A, C ∈ 𝔾₁, B ∈ 𝔾₂ — 192 bytes) checked by a single pairing
// equation, no matter how large the circuit:
//
//     e(A, B) = e(α₁, β₂) · e(Σ aᵢ·ICᵢ, γ₂) · e(C, δ₂)
//
// The pipeline (Groth16, 2016):
//   circuit ──flatten──▶ R1CS  ── (A·s)∘(B·s) = (C·s)
//          ──interpolate──▶ QAP  ── A(x)B(x) − C(x) = h(x)·t(x)
//          ──trusted setup (τ,α,β,γ,δ)──▶ proving / verifying keys
//          ──prove (witness + r,s)──▶ π = (A, B, C)
//          ──verify (1 pairing eq)──▶ accept / reject
//
// The "toxic waste" is kept visible here on purpose — a real ceremony destroys
// it, but the lab shows that anyone who keeps it could forge proofs. Built only
// on polynomial.ts and the pairing; verified in selftest.ts (honest proof
// accepts; tampered proof, wrong public input, and forged witness all reject).

import { R, G1_GEN, G2_GEN, g1, g2, pairingProduct, type G1, type G2 } from './bls12381'
import { Fp12 } from './fp12'
import {
  type Poly,
  add as pAdd,
  sub as pSub,
  scale as pScale,
  mul as pMul,
  divmod as pDivmod,
  evaluate as pEval,
  interpolate,
  vanishing,
  degree as pDegree,
} from './polynomial'
import { mod, modInv } from './field'
import { sha256, utf8, concat, bigToBytes, bytesToBig } from './sha256'

// ── R1CS: the rank-1 constraint system ────────────────────────────────────────

/** A constraint (A·s)·(B·s) = (C·s); each row is a coefficient vector over the
 *  variables (index 0 is the constant 1). */
export interface R1CS {
  vars: string[] // variable names; vars[0] === '~one'
  numPublic: number // variables 0..numPublic-1 are public inputs (incl. ~one)
  a: bigint[][] // n × m
  b: bigint[][]
  c: bigint[][]
}

/** Evaluate one row · witness over F_r. */
function dot(row: bigint[], wit: bigint[]): bigint {
  let acc = 0n
  for (let i = 0; i < row.length; i++) acc = mod(acc + row[i] * wit[i], R)
  return acc
}

/** Check that a witness satisfies every R1CS constraint. */
export function r1csSatisfied(sys: R1CS, wit: bigint[]): boolean {
  for (let j = 0; j < sys.a.length; j++) {
    const l = dot(sys.a[j], wit)
    const r = dot(sys.b[j], wit)
    const o = dot(sys.c[j], wit)
    if (mod(l * r - o, R) !== 0n) return false
  }
  return true
}

// ── QAP: the quadratic arithmetic program ─────────────────────────────────────

export interface QAP {
  u: Poly[] // u_i(x), one per variable
  v: Poly[]
  w: Poly[]
  t: Poly // target / vanishing polynomial ∏(x − j)
  n: number // number of constraints
  m: number // number of variables
}

/** Interpolate the R1CS columns into QAP polynomials at points x = 1..n. */
export function r1csToQap(sys: R1CS): QAP {
  const n = sys.a.length
  const m = sys.vars.length
  const xs = Array.from({ length: n }, (_, j) => BigInt(j + 1))
  const col = (mat: bigint[][], i: number): Poly =>
    interpolate(
      xs.map((x, j) => ({ x, y: mat[j][i] })),
      R,
    )
  const u = Array.from({ length: m }, (_, i) => col(sys.a, i))
  const v = Array.from({ length: m }, (_, i) => col(sys.b, i))
  const w = Array.from({ length: m }, (_, i) => col(sys.c, i))
  const t = vanishing(xs, R)
  return { u, v, w, t, n, m }
}

/** The combined polynomials A(x)=Σ aᵢuᵢ, B(x)=Σ aᵢvᵢ, C(x)=Σ aᵢwᵢ and the
 *  quotient h(x) = (A·B − C)/t. Remainder must be zero for a valid witness. */
export function qapWitnessPolys(qap: QAP, wit: bigint[]): {
  A: Poly
  B: Poly
  C: Poly
  h: Poly
  remainderZero: boolean
} {
  const combine = (polys: Poly[]): Poly => {
    let acc: Poly = []
    for (let i = 0; i < polys.length; i++) acc = pAdd(acc, pScale(polys[i], wit[i], R), R)
    return acc
  }
  const A = combine(qap.u)
  const B = combine(qap.v)
  const C = combine(qap.w)
  const p = pSub(pMul(A, B, R), C, R)
  const { q, r } = pDivmod(p, qap.t, R)
  return { A, B, C, h: q, remainderZero: pDegree(r, R) < 0 }
}

// ── trusted setup ─────────────────────────────────────────────────────────────

export interface ToxicWaste {
  tau: bigint
  alpha: bigint
  beta: bigint
  gamma: bigint
  delta: bigint
}

export interface VerifyingKey {
  alpha1: G1
  beta2: G2
  gamma2: G2
  delta2: G2
  ic: G1[] // IC_i for i = 0..numPublic-1
}

export interface ProvingKey {
  alpha1: G1
  beta1: G1
  beta2: G2
  delta1: G1
  delta2: G2
  a1: G1[] // u_i(τ)·G1
  b1: G1[] // v_i(τ)·G1
  b2: G2[] // v_i(τ)·G2
  k1: G1[] // private witness terms (β u_i + α v_i + w_i)/δ · G1
  h1: G1[] // (τ^j · t(τ)/δ)·G1, j = 0..n-2
}

export interface Setup {
  qap: QAP
  toxic: ToxicWaste
  pk: ProvingKey
  vk: VerifyingKey
}

/** Derive a field scalar in [1, r) deterministically from a seed + label. */
export function scalarFromSeed(seed: bigint, label: string): bigint {
  for (let ctr = 0; ; ctr++) {
    const h = sha256(concat(utf8('groth16/' + label + '/'), bigToBytes(seed, 32), new Uint8Array([ctr])))
    const s = mod(bytesToBig(h), R)
    if (s !== 0n) return s
  }
}

/** A (transparent, non-ceremony) trusted setup from a numeric seed. */
export function setup(sys: R1CS, seed: bigint): Setup {
  const qap = r1csToQap(sys)
  const toxic: ToxicWaste = {
    tau: scalarFromSeed(seed, 'tau'),
    alpha: scalarFromSeed(seed, 'alpha'),
    beta: scalarFromSeed(seed, 'beta'),
    gamma: scalarFromSeed(seed, 'gamma'),
    delta: scalarFromSeed(seed, 'delta'),
  }
  const { tau, alpha, beta, gamma, delta } = toxic
  const tTau = pEval(qap.t, tau, R)
  const invGamma = modInv(gamma, R)
  const invDelta = modInv(delta, R)

  const a1: G1[] = []
  const b1: G1[] = []
  const b2: G2[] = []
  const ic: G1[] = []
  const k1: G1[] = []
  for (let i = 0; i < qap.m; i++) {
    const ui = pEval(qap.u[i], tau, R)
    const vi = pEval(qap.v[i], tau, R)
    const wi = pEval(qap.w[i], tau, R)
    a1.push(g1.mul(ui, G1_GEN))
    b1.push(g1.mul(vi, G1_GEN))
    b2.push(g2.mul(vi, G2_GEN))
    const li = mod(beta * ui + alpha * vi + wi, R) // β u_i(τ) + α v_i(τ) + w_i(τ)
    if (i < sys.numPublic) {
      ic.push(g1.mul(mod(li * invGamma, R), G1_GEN))
    } else {
      k1.push(g1.mul(mod(li * invDelta, R), G1_GEN))
    }
  }

  // H powers: (τ^j · t(τ) / δ)·G1 for j = 0 .. n-2.
  const h1: G1[] = []
  let tauPow = 1n
  for (let j = 0; j <= qap.n - 2; j++) {
    h1.push(g1.mul(mod(tauPow * tTau % R * invDelta, R), G1_GEN))
    tauPow = mod(tauPow * tau, R)
  }

  const pk: ProvingKey = {
    alpha1: g1.mul(alpha, G1_GEN),
    beta1: g1.mul(beta, G1_GEN),
    beta2: g2.mul(beta, G2_GEN),
    delta1: g1.mul(delta, G1_GEN),
    delta2: g2.mul(delta, G2_GEN),
    a1,
    b1,
    b2,
    k1,
    h1,
  }
  const vk: VerifyingKey = {
    alpha1: g1.mul(alpha, G1_GEN),
    beta2: g2.mul(beta, G2_GEN),
    gamma2: g2.mul(gamma, G2_GEN),
    delta2: g2.mul(delta, G2_GEN),
    ic,
  }
  return { qap, toxic, pk, vk }
}

// ── prove ─────────────────────────────────────────────────────────────────────

export interface Proof {
  A: G1
  B: G2
  C: G1
}

/** Produce a Groth16 proof for `wit` (full witness, public part first). */
export function prove(setupData: Setup, sys: R1CS, wit: bigint[], seed: bigint): Proof {
  const { pk, qap } = setupData
  const r = scalarFromSeed(seed, 'r')
  const s = scalarFromSeed(seed, 's')

  // A = (α + Σ aᵢ uᵢ(τ) + r·δ)·G1, built from the proving-key points.
  let A: G1 = pk.alpha1
  for (let i = 0; i < qap.m; i++) A = g1.add(A, g1.mul(wit[i], pk.a1[i]))
  A = g1.add(A, g1.mul(r, pk.delta1))

  // B = (β + Σ aᵢ vᵢ(τ) + s·δ)·G2, and the same scalar lifted to G1 for C.
  let B2: G2 = pk.beta2
  let B1: G1 = pk.beta1
  for (let i = 0; i < qap.m; i++) {
    B2 = g2.add(B2, g2.mul(wit[i], pk.b2[i]))
    B1 = g1.add(B1, g1.mul(wit[i], pk.b1[i]))
  }
  B2 = g2.add(B2, g2.mul(s, pk.delta2))
  B1 = g1.add(B1, g1.mul(s, pk.delta1))

  // The private-witness sum Σ_{priv} aᵢ·Kᵢ.
  let C: G1 = null
  for (let i = sys.numPublic; i < qap.m; i++) {
    C = g1.add(C, g1.mul(wit[i], pk.k1[i - sys.numPublic]))
  }
  // The h(x)·t(x)/δ term: Σ_j h_j · H_j.
  const { h } = qapWitnessPolys(qap, wit)
  for (let j = 0; j < pk.h1.length; j++) {
    if (j < h.length) C = g1.add(C, g1.mul(h[j], pk.h1[j]))
  }
  // + s·A + r·B1 − r·s·δ·G1.
  C = g1.add(C, g1.mul(s, A))
  C = g1.add(C, g1.mul(r, B1))
  C = g1.add(C, g1.mul(mod(-(r * s), R), pk.delta1))

  return { A, B: B2, C }
}

// ── verify ────────────────────────────────────────────────────────────────────

/** Verify a Groth16 proof against public inputs (a_0..a_{numPublic-1}). */
export function verify(vk: VerifyingKey, publicInputs: bigint[], proof: Proof): boolean {
  if (publicInputs.length !== vk.ic.length) return false
  // vk_x = Σ aᵢ·ICᵢ over the public inputs.
  let vkx: G1 = null
  for (let i = 0; i < publicInputs.length; i++) {
    vkx = g1.add(vkx, g1.mul(publicInputs[i], vk.ic[i]))
  }
  // e(A,B) · e(−α₁,β₂) · e(−vk_x,γ₂) · e(−C,δ₂) ?= 1.
  const f = pairingProduct([
    { p: proof.A, q: proof.B },
    { p: g1.neg(vk.alpha1), q: vk.beta2 },
    { p: g1.neg(vkx), q: vk.gamma2 },
    { p: g1.neg(proof.C), q: vk.delta2 },
  ])
  return Fp12.isOne(f)
}

// ── a worked example circuit: prove knowledge of x with x³ + x + 5 = out ──────

/**
 * The canonical "cube" circuit (Vitalik's QAP example). Variables, in order:
 *   [~one, ~out, x, sym1=x², y=x³, sym2=x³+x]
 * with ~one and ~out public (numPublic = 2). Four constraints:
 *   x·x = sym1 ;  sym1·x = y ;  (y+x)·1 = sym2 ;  (sym2+5)·1 = out
 */
export function cubeCircuit(): R1CS {
  const z = () => [0n, 0n, 0n, 0n, 0n, 0n]
  // indices: 0:~one 1:~out 2:x 3:sym1 4:y 5:sym2
  const a: bigint[][] = []
  const b: bigint[][] = []
  const c: bigint[][] = []
  // c1: x*x = sym1
  let A = z(); A[2] = 1n; let B = z(); B[2] = 1n; let C = z(); C[3] = 1n
  a.push(A); b.push(B); c.push(C)
  // c2: sym1*x = y
  A = z(); A[3] = 1n; B = z(); B[2] = 1n; C = z(); C[4] = 1n
  a.push(A); b.push(B); c.push(C)
  // c3: (y + x)*1 = sym2
  A = z(); A[4] = 1n; A[2] = 1n; B = z(); B[0] = 1n; C = z(); C[5] = 1n
  a.push(A); b.push(B); c.push(C)
  // c4: (sym2 + 5)*1 = out
  A = z(); A[5] = 1n; A[0] = 5n; B = z(); B[0] = 1n; C = z(); C[1] = 1n
  a.push(A); b.push(B); c.push(C)
  return { vars: ['~one', '~out', 'x', 'sym1', 'y', 'sym2'], numPublic: 2, a, b, c }
}

/** Build the full witness for the cube circuit at a chosen secret x. */
export function cubeWitness(x: bigint): { witness: bigint[]; out: bigint } {
  const sym1 = mod(x * x, R)
  const y = mod(sym1 * x, R)
  const sym2 = mod(y + x, R)
  const out = mod(sym2 + 5n, R)
  return { witness: [1n, out, x, sym1, y, sym2], out }
}
