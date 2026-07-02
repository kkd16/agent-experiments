// PLONK — a *universal* zk-SNARK, end to end, on the from-scratch BLS12-381
// pairing and the KZG commitments already in this engine.
//
// Groth16 (see groth16.ts) is unbeatably small — three group elements — but its
// trusted setup is *circuit-specific*: change one gate and you must run a new
// ceremony. PLONK (Gabizon–Williamson–Ciobotaru, 2019) trades a slightly larger
// proof for a **universal, updatable** setup: one powers-of-τ string (the same
// KZG SRS this lab already builds) proves *any* circuit up to a size bound. It is
// the proof system under Aztec, zkSync's early versions, and countless rollups,
// and the direct ancestor of Halo2 and Plonky2.
//
// The two ideas that make it work, both realised here from scratch:
//
//   1. **One gate equation for the whole circuit.** Every gate — add, multiply,
//      constant, public-input — is a single row of five *selector* constants
//      (q_L, q_R, q_O, q_M, q_C) picking out a linear combination of its three
//      wires a, b, c:
//
//          q_L·a + q_R·b + q_O·c + q_M·a·b + q_C + PI = 0.
//
//      Interpolating each column over a multiplicative domain H = {ω⁰…ω^{n−1}}
//      turns "every gate holds" into one polynomial identity that vanishes on H.
//
//   2. **A permutation argument for the wiring.** Which wires are the *same*
//      value (the copy constraints — x reused across gates, an output fed into
//      the next gate) is encoded as a permutation σ of the 3n wire cells. A
//      grand-product polynomial z(X) accumulates a running ratio that returns to
//      1 after a full loop **iff** every wire equals the wire σ maps it to. This
//      is the piece Groth16's R1CS gets "for free" from its matrices and PLONK
//      must prove explicitly — and it's the reason PLONK's arithmetization is so
//      flexible.
//
// Both identities are bundled into one quotient t(X) = (gate + α·perm +
// α²·L₁·(z−1)) / Z_H(X), committed with KZG, and checked at a single Fiat–Shamir
// point ζ. We verify **transparently**: the prover opens every polynomial at ζ
// (and z at ζ·ω) with two batched KZG proofs, and the verifier re-checks the big
// identity as a scalar equation among the opened values. (Production PLONK folds
// this into a "linearisation" polynomial to shave a few group elements; we keep
// the openings explicit so every term of the identity is visible.) Soundness is
// the usual Schwartz–Zippel argument: ζ is drawn *after* the commitments are
// fixed, so a false identity survives with probability ≈ deg/r ≈ 2⁻²⁴⁰.
//
// Verified in selftest.ts: honest proofs accept; the grand product returns to 1;
// and a wrong public input, a tampered proof element, a forged witness, and a
// mauled evaluation each break the pairing/identity check.

import { R, g1, type G1 } from './bls12381'
import {
  type Poly,
  add as pAdd,
  sub as pSub,
  scale as pScale,
  mul as pMul,
  divmod as pDivmod,
  evaluate as pEval,
  interpolate,
  degree as pDegree,
} from './polynomial'
import { mod, modInv, modPow } from './field'
import { sha256, concat, bigToBytes, bytesToBig } from './sha256'
import { compressG1 } from './blsenc'
import { setup as kzgSetup, commit as kzgCommit, open as kzgOpen, verify as kzgVerify, type SRS } from './kzg'

// ── The multiplicative domain H = ⟨ω⟩ of size n (a power of two) ───────────────
//
// BLS12-381's scalar field has 2³² | (r−1), so it contains roots of unity of
// every order 2ᵏ up to 2³². We find a primitive n-th root ω by raising a small
// generator to the (r−1)/n power and checking its order is *exactly* n.

/** A primitive n-th root of unity in F_r (n must be a power of two, n ≤ 2³²). */
export function rootOfUnity(n: number): bigint {
  if (n < 1 || (n & (n - 1)) !== 0) throw new Error('domain size must be a power of two')
  if (n === 1) return 1n
  const exp = (R - 1n) / BigInt(n)
  for (const g of [5n, 7n, 11n, 13n, 17n, 19n, 23n, 2n, 3n]) {
    const w = modPow(g, exp, R)
    if (w !== 1n && modPow(w, BigInt(n), R) === 1n && modPow(w, BigInt(n / 2), R) !== 1n) return w
  }
  throw new Error('no primitive root found (unreachable for n ≤ 2³²)')
}

/** The domain H = {ω⁰, ω¹, …, ω^{n−1}}. */
export function domain(n: number): bigint[] {
  const w = rootOfUnity(n)
  const H: bigint[] = new Array(n)
  let acc = 1n
  for (let i = 0; i < n; i++) {
    H[i] = acc
    acc = mod(acc * w, R)
  }
  return H
}

/** The vanishing polynomial Z_H(X) = Xⁿ − 1 (roots = all of H). */
export function vanishingH(n: number): Poly {
  const z: Poly = new Array(n + 1).fill(0n)
  z[0] = mod(-1n, R)
  z[n] = 1n
  return z
}

/** Z_H(ζ) = ζⁿ − 1, evaluated directly. */
export function evalVanishing(n: number, zeta: bigint): bigint {
  return mod(modPow(zeta, BigInt(n), R) - 1n, R)
}

/** The i-th Lagrange basis polynomial over H (value 1 at ωⁱ, 0 elsewhere). */
export function lagrangeBasis(n: number, i: number): Poly {
  const H = domain(n)
  const ys = new Array(n).fill(0n)
  ys[i] = 1n
  return interpolate(
    H.map((x, j) => ({ x, y: ys[j] })),
    R,
  )
}

/**
 * L_i(ζ) in closed form: L_i(ζ) = (ωⁱ (ζⁿ − 1)) / (n (ζ − ωⁱ)). Lets the verifier
 * evaluate a Lagrange polynomial at ζ without materialising it.
 */
export function lagrangeEval(n: number, i: number, zeta: bigint): bigint {
  const w = rootOfUnity(n)
  const wi = modPow(w, BigInt(i), R)
  const num = mod(wi * (modPow(zeta, BigInt(n), R) - 1n), R)
  const den = mod(BigInt(n) * mod(zeta - wi, R), R)
  return mod(num * modInv(den, R), R)
}

/** Shift a polynomial by ω: given f(X) = Σ fₖ Xᵏ, return f(ω·X) = Σ fₖ ωᵏ Xᵏ. */
function shiftByOmega(f: Poly, w: bigint): Poly {
  const out: Poly = new Array(f.length)
  let wk = 1n
  for (let k = 0; k < f.length; k++) {
    out[k] = mod(f[k] * wk, R)
    wk = mod(wk * w, R)
  }
  return out
}

// ── The constraint system ──────────────────────────────────────────────────────
//
// A circuit is n gates over three wire columns a, b, c. Each gate is five selector
// constants; wiring is a permutation σ over the 3n cells (column-major: cell
// index = col·n + row, col ∈ {0,1,2}). Public inputs live at designated rows.

export interface Gate {
  qL: bigint
  qR: bigint
  qO: bigint
  qM: bigint
  qC: bigint
}

export interface Circuit {
  n: number // domain size (power of two ≥ #gates)
  gates: Gate[] // length n (padded with zero gates)
  // Wire assignment for the *witness*: a[i], b[i], c[i] are field values.
  // (Supplied at prove time, not baked into the circuit shape.)
  // Copy constraints, as equivalence classes of cell indices:
  copyClasses: number[][]
  publicRows: number[] // rows whose `a` wire is bound to a public input
}

/** Column shifts making H, k1·H, k2·H three disjoint cosets (so the 3n identity
 *  values are distinct). k1=7, k2=13 are not n-th roots of unity for any small n. */
export const K1 = 7n
export const K2 = 13n

/** The identity value of a cell: ω^row on column 0, k1·ω^row on 1, k2·ω^row on 2. */
function cellIdentity(cell: number, n: number, H: bigint[]): bigint {
  const col = Math.floor(cell / n)
  const row = cell % n
  const base = H[row]
  return col === 0 ? base : col === 1 ? mod(K1 * base, R) : mod(K2 * base, R)
}

/** Build the permutation σ (as an array over 3n cells) from copy-constraint
 *  classes: each class becomes a cycle. Cells not in any class are fixed points. */
export function buildPermutation(n: number, classes: number[][]): number[] {
  const sigma = Array.from({ length: 3 * n }, (_, i) => i) // start as identity
  for (const cls of classes) {
    if (cls.length < 2) continue
    for (let i = 0; i < cls.length; i++) {
      sigma[cls[i]] = cls[(i + 1) % cls.length] // rotate the cycle
    }
  }
  return sigma
}

/** The three permutation polynomials S_σ1, S_σ2, S_σ3: S_σ(col)(ωⁱ) = identity
 *  value of the cell σ maps (col,row) to. */
export function permutationPolys(n: number, sigma: number[]): [Poly, Poly, Poly] {
  const H = domain(n)
  const col = (c: number): Poly =>
    interpolate(
      H.map((x, row) => ({ x, y: cellIdentity(sigma[c * n + row], n, H) })),
      R,
    )
  return [col(0), col(1), col(2)]
}

// ── Preprocessed / verifying key ────────────────────────────────────────────────

export interface PreprocessedInput {
  n: number
  srs: SRS
  // Selector polynomials + their commitments.
  qM: Poly
  qL: Poly
  qR: Poly
  qO: Poly
  qC: Poly
  cQM: G1
  cQL: G1
  cQR: G1
  cQO: G1
  cQC: G1
  // Permutation polynomials + commitments.
  sigma1: Poly
  sigma2: Poly
  sigma3: Poly
  cS1: G1
  cS2: G1
  cS3: G1
  publicRows: number[]
}

/** Run the (universal) preprocessing: interpolate the selectors + permutation and
 *  commit them. The SRS is the ordinary KZG powers-of-τ, sized to the circuit. */
export function preprocess(circuit: Circuit, tau: bigint): PreprocessedInput {
  const { n, gates } = circuit
  const H = domain(n)
  const col = (pick: (g: Gate) => bigint): Poly =>
    interpolate(
      H.map((x, i) => ({ x, y: mod(pick(gates[i]), R) })),
      R,
    )
  const qM = col((g) => g.qM)
  const qL = col((g) => g.qL)
  const qR = col((g) => g.qR)
  const qO = col((g) => g.qO)
  const qC = col((g) => g.qC)

  const sigma = buildPermutation(n, circuit.copyClasses)
  const [sigma1, sigma2, sigma3] = permutationPolys(n, sigma)

  // SRS large enough for the highest-degree committed polynomial. With blinding,
  // t splits into pieces of degree up to n+5; 3n+6 is a safe, cheap bound.
  const srs = kzgSetup(3 * n + 6, tau)

  return {
    n,
    srs,
    qM,
    qL,
    qR,
    qO,
    qC,
    cQM: kzgCommit(srs, qM),
    cQL: kzgCommit(srs, qL),
    cQR: kzgCommit(srs, qR),
    cQO: kzgCommit(srs, qO),
    cQC: kzgCommit(srs, qC),
    sigma1,
    sigma2,
    sigma3,
    cS1: kzgCommit(srs, sigma1),
    cS2: kzgCommit(srs, sigma2),
    cS3: kzgCommit(srs, sigma3),
    publicRows: circuit.publicRows,
  }
}

// ── Fiat–Shamir transcript ──────────────────────────────────────────────────────
//
// A running SHA-256 hash absorbing every prover message; challenges are squeezed
// as field elements and ratcheted back in, so both parties derive the same
// β, γ, α, ζ, v deterministically from the public transcript.

class Transcript {
  private state: Uint8Array
  constructor(label: string) {
    this.state = sha256(concat(new Uint8Array([0x50, 0x4c, 0x4f, 0x4e, 0x4b]), utf8(label)))
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

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

// ── Deterministic blinders ──────────────────────────────────────────────────────

function blinders(seed: bigint, count: number): bigint[] {
  const out: bigint[] = []
  for (let i = 0; i < count; i++) {
    const h = sha256(concat(utf8('plonk/blind/'), bigToBytes(seed, 32), new Uint8Array([i])))
    out.push(mod(bytesToBig(h), R))
  }
  return out
}

// ── The witness ─────────────────────────────────────────────────────────────────

export interface Witness {
  a: bigint[] // length n
  b: bigint[]
  c: bigint[]
  publicInputs: bigint[] // the values bound at publicRows (in order)
}

/** Check the witness satisfies every gate (a·b·q_M + a·q_L + b·q_R + c·q_O + q_C + PI = 0). */
export function circuitSatisfied(circuit: Circuit, w: Witness): boolean {
  const { n, gates, publicRows } = circuit
  const PI = new Array(n).fill(0n)
  publicRows.forEach((row, j) => (PI[row] = mod(-w.publicInputs[j], R)))
  for (let i = 0; i < n; i++) {
    const g = gates[i]
    const v = mod(
      g.qM * w.a[i] * w.b[i] + g.qL * w.a[i] + g.qR * w.b[i] + g.qO * w.c[i] + g.qC + PI[i],
      R,
    )
    if (v !== 0n) return false
  }
  // Copy constraints: every cell in a class holds the same value.
  const cell = (idx: number): bigint => (idx < n ? w.a[idx] : idx < 2 * n ? w.b[idx - n] : w.c[idx - 2 * n])
  for (const cls of circuit.copyClasses) {
    for (let i = 1; i < cls.length; i++) if (cell(cls[i]) !== cell(cls[0])) return false
  }
  return true
}

// ── The proof ─────────────────────────────────────────────────────────────────

export interface PlonkProof {
  // Round 1–3 commitments.
  cA: G1
  cB: G1
  cC: G1
  cZ: G1
  cTlo: G1
  cTmid: G1
  cThi: G1
  // Round 4 evaluations at ζ (and z at ζ·ω).
  aBar: bigint
  bBar: bigint
  cBar: bigint
  s1Bar: bigint
  s2Bar: bigint
  s3Bar: bigint
  zBar: bigint
  zOmegaBar: bigint
  tLoBar: bigint
  tMidBar: bigint
  tHiBar: bigint
  // Round 5 batched opening proofs.
  Wzeta: G1
  Wzomega: G1
}

/** Intermediate values a prover may expose for a lab (grand product, quotient). */
export interface ProverTrace {
  accumulator: bigint[] // z(ωⁱ) for i=0..n (should close the loop: acc[n] === 1)
  grandProductClosed: boolean
  quotientRemainderZero: boolean
  zeta: bigint
  beta: bigint
  gamma: bigint
  alpha: bigint
  v: bigint
}

/** Public-input polynomial: PI(ωʳᵒʷ) = −(public value) at each public row, 0 else. */
function publicInputPoly(circuit: Circuit, w: Witness): Poly {
  const { n, publicRows } = circuit
  const H = domain(n)
  const ys = new Array(n).fill(0n)
  publicRows.forEach((row, j) => (ys[row] = mod(-w.publicInputs[j], R)))
  return interpolate(
    H.map((x, i) => ({ x, y: ys[i] })),
    R,
  )
}

/** PI(ζ) from the public values alone (what the verifier can compute). */
export function publicInputEval(circuit: Circuit, publicInputs: bigint[], zeta: bigint): bigint {
  let acc = 0n
  circuit.publicRows.forEach((row, j) => {
    acc = mod(acc + mod(-publicInputs[j], R) * lagrangeEval(circuit.n, row, zeta), R)
  })
  return acc
}

// ── The prover ──────────────────────────────────────────────────────────────────

export function prove(
  pp: PreprocessedInput,
  circuit: Circuit,
  w: Witness,
  seed: bigint,
): { proof: PlonkProof; trace: ProverTrace } {
  const { n, srs } = pp
  const H = domain(n)
  const wRoot = rootOfUnity(n)
  const ZH = vanishingH(n)
  const bl = blinders(seed, 11)

  const tr = new Transcript('curvefield/plonk/v1')
  // Absorb the preprocessed circuit + public inputs so challenges bind to them.
  ;[pp.cQM, pp.cQL, pp.cQR, pp.cQO, pp.cQC, pp.cS1, pp.cS2, pp.cS3].forEach((C) => tr.absorbPoint(C))
  w.publicInputs.forEach((x) => tr.absorbScalar(x))

  // Round 1: witness polynomials a, b, c with blinding (b₁X+b₂)·Z_H etc.
  const interp = (vals: bigint[]): Poly =>
    interpolate(
      H.map((x, i) => ({ x, y: vals[i] })),
      R,
    )
  const withBlind = (base: Poly, hi: bigint, lo: bigint): Poly =>
    pAdd(base, pMul([lo, hi], ZH, R), R)
  const aPoly = withBlind(interp(w.a), bl[0], bl[1])
  const bPoly = withBlind(interp(w.b), bl[2], bl[3])
  const cPoly = withBlind(interp(w.c), bl[4], bl[5])
  const cA = kzgCommit(srs, aPoly)
  const cB = kzgCommit(srs, bPoly)
  const cC = kzgCommit(srs, cPoly)
  tr.absorbPoint(cA)
  tr.absorbPoint(cB)
  tr.absorbPoint(cC)

  // Round 2: permutation challenges β, γ; the grand-product polynomial z(X).
  const beta = tr.challenge()
  const gamma = tr.challenge()

  // σ identity/target values on H, per column.
  const id1 = H.map((wi) => wi)
  const id2 = H.map((wi) => mod(K1 * wi, R))
  const id3 = H.map((wi) => mod(K2 * wi, R))
  const s1 = H.map((_, i) => pEval(pp.sigma1, H[i], R))
  const s2 = H.map((_, i) => pEval(pp.sigma2, H[i], R))
  const s3 = H.map((_, i) => pEval(pp.sigma3, H[i], R))

  // Accumulator: acc[0]=1, acc[i+1] = acc[i]·(num/den) over row i.
  const acc: bigint[] = new Array(n + 1)
  acc[0] = 1n
  for (let i = 0; i < n; i++) {
    const num = mod(
      (w.a[i] + beta * id1[i] + gamma) *
        (w.b[i] + beta * id2[i] + gamma) *
        (w.c[i] + beta * id3[i] + gamma),
      R,
    )
    const den = mod(
      (w.a[i] + beta * s1[i] + gamma) *
        (w.b[i] + beta * s2[i] + gamma) *
        (w.c[i] + beta * s3[i] + gamma),
      R,
    )
    acc[i + 1] = mod(acc[i] * num % R * modInv(den, R), R)
  }
  const grandProductClosed = acc[n] === 1n
  // z(ωⁱ) = acc[i]; interpolate over H, then blind with (b₇X²+b₈X+b₉)·Z_H.
  const zBase = interp(acc.slice(0, n))
  const zPoly = pAdd(zBase, pMul([bl[8], bl[7], bl[6]], ZH, R), R)
  const cZ = kzgCommit(srs, zPoly)
  tr.absorbPoint(cZ)

  // Round 3: quotient challenge α; the quotient t(X).
  const alpha = tr.challenge()
  const PIpoly = publicInputPoly(circuit, w)

  // gate(X) = q_M·a·b + q_L·a + q_R·b + q_O·c + q_C + PI.
  let gate: Poly = pMul(pp.qM, pMul(aPoly, bPoly, R), R)
  gate = pAdd(gate, pMul(pp.qL, aPoly, R), R)
  gate = pAdd(gate, pMul(pp.qR, bPoly, R), R)
  gate = pAdd(gate, pMul(pp.qO, cPoly, R), R)
  gate = pAdd(gate, pp.qC, R)
  gate = pAdd(gate, PIpoly, R)

  // perm1(X) = (a+βX+γ)(b+βk₁X+γ)(c+βk₂X+γ)·z(X).
  const lin = (poly: Poly, k: bigint): Poly =>
    pAdd(poly, pAdd(pScale([0n, 1n], mod(beta * k, R), R), [gamma], R), R)
  let perm1 = pMul(lin(aPoly, 1n), lin(bPoly, K1), R)
  perm1 = pMul(perm1, lin(cPoly, K2), R)
  perm1 = pMul(perm1, zPoly, R)

  // perm2(X) = (a+βSσ1+γ)(b+βSσ2+γ)(c+βSσ3+γ)·z(ωX).
  const linS = (poly: Poly, s: Poly): Poly =>
    pAdd(poly, pAdd(pScale(s, beta, R), [gamma], R), R)
  const zShift = shiftByOmega(zPoly, wRoot)
  let perm2 = pMul(linS(aPoly, pp.sigma1), linS(bPoly, pp.sigma2), R)
  perm2 = pMul(perm2, linS(cPoly, pp.sigma3), R)
  perm2 = pMul(perm2, zShift, R)

  // L₁(X)·(z(X) − 1).
  const L1 = lagrangeBasis(n, 0)
  const zMinus1 = pSub(zPoly, [1n], R)
  const perm3 = pMul(L1, zMinus1, R)

  // Numerator = gate + α(perm1 − perm2) + α²·perm3.
  let numer = gate
  numer = pAdd(numer, pScale(pSub(perm1, perm2, R), alpha, R), R)
  numer = pAdd(numer, pScale(perm3, mod(alpha * alpha, R), R), R)

  const { q: tPoly, r: tRem } = pDivmod(numer, ZH, R)
  const quotientRemainderZero = pDegree(tRem, R) < 0

  // Split t into t_lo, t_mid, t_hi (chunks of size n), with blinding b₁₀,b₁₁ so
  // the pieces are hiding: the (Xⁿ, X²ⁿ) blinders cancel in reconstruction.
  const chunk = (from: number, to: number): Poly => tPoly.slice(from, to)
  const b10 = bl[9]
  const b11 = bl[10]
  const tLo = pAdd(chunk(0, n), shiftUp(b10, n), R)
  const tMid = pAdd(pSub(chunk(n, 2 * n), [b10], R), shiftUp(b11, n), R)
  const tHi = pSub(chunk(2 * n, tPoly.length), [b11], R)
  const cTlo = kzgCommit(srs, tLo)
  const cTmid = kzgCommit(srs, tMid)
  const cThi = kzgCommit(srs, tHi)
  tr.absorbPoint(cTlo)
  tr.absorbPoint(cTmid)
  tr.absorbPoint(cThi)

  // Round 4: evaluation point ζ; open every polynomial there (z also at ζ·ω).
  const zeta = tr.challenge()
  const zetaOmega = mod(zeta * wRoot, R)
  const aBar = pEval(aPoly, zeta, R)
  const bBar = pEval(bPoly, zeta, R)
  const cBar = pEval(cPoly, zeta, R)
  const s1Bar = pEval(pp.sigma1, zeta, R)
  const s2Bar = pEval(pp.sigma2, zeta, R)
  const s3Bar = pEval(pp.sigma3, zeta, R)
  const zBar = pEval(zPoly, zeta, R)
  const zOmegaBar = pEval(zPoly, zetaOmega, R)
  const tLoBar = pEval(tLo, zeta, R)
  const tMidBar = pEval(tMid, zeta, R)
  const tHiBar = pEval(tHi, zeta, R)
  ;[aBar, bBar, cBar, s1Bar, s2Bar, s3Bar, zBar, zOmegaBar, tLoBar, tMidBar, tHiBar].forEach((x) =>
    tr.absorbScalar(x),
  )

  // Round 5: batching challenge v; two batched KZG opening proofs.
  const v = tr.challenge()
  // Batch at ζ: F(X) = Σ vⁱ·fᵢ(X) over the ζ-opened polynomials, in a fixed order.
  const zetaBatch: Poly[] = [aPoly, bPoly, cPoly, pp.sigma1, pp.sigma2, pp.sigma3, zPoly, tLo, tMid, tHi]
  const Fzeta = combine(zetaBatch, v)
  const Wzeta = kzgOpen(srs, Fzeta, zeta).W
  // Batch at ζ·ω: only z(X).
  const Wzomega = kzgOpen(srs, zPoly, zetaOmega).W

  const proof: PlonkProof = {
    cA,
    cB,
    cC,
    cZ,
    cTlo,
    cTmid,
    cThi,
    aBar,
    bBar,
    cBar,
    s1Bar,
    s2Bar,
    s3Bar,
    zBar,
    zOmegaBar,
    tLoBar,
    tMidBar,
    tHiBar,
    Wzeta,
    Wzomega,
  }
  const trace: ProverTrace = {
    accumulator: acc,
    grandProductClosed,
    quotientRemainderZero,
    zeta,
    beta,
    gamma,
    alpha,
    v,
  }
  return { proof, trace }
}

/** b·Xⁿ as a polynomial. */
function shiftUp(b: bigint, n: number): Poly {
  if (mod(b, R) === 0n) return []
  const out: Poly = new Array(n + 1).fill(0n)
  out[n] = mod(b, R)
  return out
}

/** Σ vⁱ · polys[i]. */
function combine(polys: Poly[], v: bigint): Poly {
  let acc: Poly = []
  let vi = 1n
  for (const p of polys) {
    acc = pAdd(acc, pScale(p, vi, R), R)
    vi = mod(vi * v, R)
  }
  return acc
}

// ── The verifier ────────────────────────────────────────────────────────────────

export interface VerifyResult {
  identityHolds: boolean // the big scalar equation among opened values
  openingZeta: boolean // batched KZG opening at ζ
  openingZetaOmega: boolean // KZG opening of z at ζ·ω
  accepted: boolean
  // Intermediate values (for the lab's transparent-verifier panel).
  zeta: bigint
  gateTerm: bigint // gate(ζ) + PI(ζ)
  permTerm: bigint // α·(perm1 − perm2)
  boundaryTerm: bigint // α²·(z̄−1)·L₁(ζ)
  lhs: bigint // gate + perm + boundary
  rhs: bigint // t̄·Z_H(ζ)
}

export function verify(pp: PreprocessedInput, publicInputs: bigint[], proof: PlonkProof): VerifyResult {
  const { n, srs } = pp
  const wRoot = rootOfUnity(n)

  // Re-derive all challenges from the transcript (must match the prover exactly).
  const tr = new Transcript('curvefield/plonk/v1')
  ;[pp.cQM, pp.cQL, pp.cQR, pp.cQO, pp.cQC, pp.cS1, pp.cS2, pp.cS3].forEach((C) => tr.absorbPoint(C))
  publicInputs.forEach((x) => tr.absorbScalar(x))
  tr.absorbPoint(proof.cA)
  tr.absorbPoint(proof.cB)
  tr.absorbPoint(proof.cC)
  const beta = tr.challenge()
  const gamma = tr.challenge()
  tr.absorbPoint(proof.cZ)
  const alpha = tr.challenge()
  tr.absorbPoint(proof.cTlo)
  tr.absorbPoint(proof.cTmid)
  tr.absorbPoint(proof.cThi)
  const zeta = tr.challenge()
  const zetaOmega = mod(zeta * wRoot, R)
  ;[
    proof.aBar,
    proof.bBar,
    proof.cBar,
    proof.s1Bar,
    proof.s2Bar,
    proof.s3Bar,
    proof.zBar,
    proof.zOmegaBar,
    proof.tLoBar,
    proof.tMidBar,
    proof.tHiBar,
  ].forEach((x) => tr.absorbScalar(x))
  const v = tr.challenge()

  // Public selector evaluations at ζ (selectors are public → verifier evaluates).
  const qM = pEval(pp.qM, zeta, R)
  const qL = pEval(pp.qL, zeta, R)
  const qR = pEval(pp.qR, zeta, R)
  const qO = pEval(pp.qO, zeta, R)
  const qC = pEval(pp.qC, zeta, R)
  const PIz = publicInputEval({ n, publicRows: pp.publicRows } as Circuit, publicInputs, zeta)

  const { aBar, bBar, cBar, s1Bar, s2Bar, s3Bar, zBar, zOmegaBar } = proof

  // The gate + permutation identity, as a scalar equation at ζ.
  const gate = mod(qM * aBar * bBar + qL * aBar + qR * bBar + qO * cBar + qC + PIz, R)
  const perm1 = mod(
    (aBar + beta * zeta + gamma) *
      (bBar + beta * K1 * zeta + gamma) *
      (cBar + beta * K2 * zeta + gamma) *
      zBar,
    R,
  )
  const perm2 = mod(
    (aBar + beta * s1Bar + gamma) *
      (bBar + beta * s2Bar + gamma) *
      (cBar + beta * s3Bar + gamma) *
      zOmegaBar,
    R,
  )
  const L1z = lagrangeEval(n, 0, zeta)
  const perm3 = mod((zBar - 1n) * L1z, R)
  const permTerm = mod(alpha * mod(perm1 - perm2, R), R)
  const boundaryTerm = mod(mod(alpha * alpha, R) * perm3, R)
  const identity = mod(gate + permTerm + boundaryTerm, R)

  // t(ζ) reconstructed from the three opened chunks.
  const zetaN = modPow(zeta, BigInt(n), R)
  const zeta2N = mod(zetaN * zetaN, R)
  const tBar = mod(proof.tLoBar + zetaN * proof.tMidBar + zeta2N * proof.tHiBar, R)
  const ZHz = evalVanishing(n, zeta)
  const rhs = mod(tBar * ZHz, R)
  const identityHolds = identity === rhs

  // Batched KZG opening at ζ: fold commitments + claimed evals with the same vⁱ.
  const zetaCommits: G1[] = [
    proof.cA,
    proof.cB,
    proof.cC,
    pp.cS1,
    pp.cS2,
    pp.cS3,
    proof.cZ,
    proof.cTlo,
    proof.cTmid,
    proof.cThi,
  ]
  const zetaEvals: bigint[] = [
    aBar,
    bBar,
    cBar,
    s1Bar,
    s2Bar,
    s3Bar,
    zBar,
    proof.tLoBar,
    proof.tMidBar,
    proof.tHiBar,
  ]
  const Cfold = foldCommits(zetaCommits, v)
  const yFold = foldScalars(zetaEvals, v)
  const openingZeta = kzgVerify(srs, Cfold, { z: zeta, y: yFold, W: proof.Wzeta })

  // KZG opening of z at ζ·ω.
  const openingZetaOmega = kzgVerify(srs, proof.cZ, { z: zetaOmega, y: zOmegaBar, W: proof.Wzomega })

  return {
    identityHolds,
    openingZeta,
    openingZetaOmega,
    accepted: identityHolds && openingZeta && openingZetaOmega,
    zeta,
    gateTerm: gate,
    permTerm,
    boundaryTerm,
    lhs: identity,
    rhs,
  }
}

function foldCommits(cs: G1[], v: bigint): G1 {
  let acc: G1 = null
  let vi = 1n
  for (const C of cs) {
    if (C !== null) acc = g1.add(acc, g1.mul(vi, C))
    vi = mod(vi * v, R)
  }
  return acc
}

function foldScalars(ys: bigint[], v: bigint): bigint {
  let acc = 0n
  let vi = 1n
  for (const y of ys) {
    acc = mod(acc + vi * y, R)
    vi = mod(vi * v, R)
  }
  return acc
}

// ── A worked example: prove knowledge of x with x³ + x + 5 = out ─────────────────
//
// The *same statement* as the Groth16 lab, so the two proof systems can be
// compared directly. Gates (n = 8, three padding rows):
//   g0: x·x      = v1     (q_M=1, q_O=−1)
//   g1: v1·x     = v2=x³  (q_M=1, q_O=−1)
//   g2: v2 + x   = v3     (q_L=1, q_R=1, q_O=−1)
//   g3: v3 + 5   = out    (q_L=1, q_C=5, q_O=−1)   [b wire unused]
//   g4: out      = OUT    (q_L=1, PI=−OUT)          [binds out to the public input]
// Copy constraints wire x across a0,b0,b1,b2; v1 across c0,a1; v2 across c1,a2;
// v3 across c2,a3; out across c3,a4.

export function cubeCircuit(): Circuit {
  const n = 8
  const Z: Gate = { qL: 0n, qR: 0n, qO: 0n, qM: 0n, qC: 0n }
  const gates: Gate[] = [
    { qL: 0n, qR: 0n, qO: mod(-1n, R), qM: 1n, qC: 0n }, // x·x = v1
    { qL: 0n, qR: 0n, qO: mod(-1n, R), qM: 1n, qC: 0n }, // v1·x = v2
    { qL: 1n, qR: 1n, qO: mod(-1n, R), qM: 0n, qC: 0n }, // v2 + x = v3
    { qL: 1n, qR: 0n, qO: mod(-1n, R), qM: 0n, qC: 5n }, // v3 + 5 = out
    { qL: 1n, qR: 0n, qO: 0n, qM: 0n, qC: 0n }, // out = OUT (public)
    { ...Z },
    { ...Z },
    { ...Z },
  ]
  // Cells: column a = 0..7, b = 8..15, c = 16..23.
  const A = (r: number) => r
  const B = (r: number) => 8 + r
  const C = (r: number) => 16 + r
  const copyClasses = [
    [A(0), B(0), B(1), B(2)], // x
    [C(0), A(1)], // v1
    [C(1), A(2)], // v2 = x³
    [C(2), A(3)], // v3
    [C(3), A(4)], // out
  ]
  return { n, gates, copyClasses, publicRows: [4] }
}

/** Build the full witness (a,b,c columns) for the cube circuit at secret x. */
export function cubeWitness(x: bigint): { witness: Witness; out: bigint } {
  const xv = mod(x, R)
  const v1 = mod(xv * xv, R)
  const v2 = mod(v1 * xv, R)
  const v3 = mod(v2 + xv, R)
  const out = mod(v3 + 5n, R)
  const a = [xv, v1, v2, v3, out, 0n, 0n, 0n]
  const b = [xv, xv, xv, 0n, 0n, 0n, 0n, 0n]
  const c = [v1, v2, v3, out, 0n, 0n, 0n, 0n]
  return { witness: { a, b, c, publicInputs: [out] }, out }
}
