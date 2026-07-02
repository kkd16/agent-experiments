// Poseidon — an *algebraic* hash function over the Goldilocks field.
//
// Every hash elsewhere in the lab (SHA-256, SHA-512, RIPEMD-160) is a *bit*
// function: it shreds its input with rotations, xors and modular additions on
// 32/64-bit words. Those are wonderful for a CPU and miserable for a
// zero-knowledge proof, because expressing a single 32-bit xor as low-degree
// polynomial constraints over a prime field takes dozens of gates. Poseidon is
// built the other way round: it is *nothing but* field arithmetic — add a
// constant, raise to the 7th power, multiply by a matrix — so its entire
// computation is already a short list of low-degree polynomial identities. That
// is exactly what a STARK (`poseidon_stark.ts`) can prove you executed.
//
// The design is the standard Hades strategy (Grassi–Khovratovich–Rechberger–
// Roy–Schofnegger 2019): a wide state of `t` field elements, a small number of
// *full* rounds at each end (the S-box hits every element) sandwiching a longer
// run of cheap *partial* rounds (the S-box hits only element 0). Each round is
//
//     AddRoundConstants → S-box → MixLayer (multiply by an MDS matrix).
//
// Concretely here:
//   • field    = Goldilocks p = 2^64 − 2^32 + 1 (the STARK field, `goldilocks.ts`)
//   • S-box    = x^7. The exponent must be coprime to p−1 for x↦x^α to be a
//                bijection; p−1 = 2^32·3·5·17·257·65537, so 3 and 5 are out and
//                7 is the smallest that works (this is the Plonky2/Risc0 choice).
//   • width    = t = 8 (rate 4, capacity 4 → a 256-bit capacity, ≈128-bit
//                collision resistance for the sponge).
//   • rounds   = R_F = 8 full + R_P = 22 partial = 30, laid out 4 · full,
//                22 · partial, 4 · full.
//   • MDS      = a Cauchy matrix M[i][j] = 1/(x_i − y_j); a Cauchy matrix is MDS
//                (every square submatrix is invertible), which is what a diffusion
//                layer needs. NUMS points, no hidden structure.
//   • constants= nothing-up-my-sleeve: each is SHA-256 of a fixed label string
//                reduced mod p, so the whole schedule is reproducible from the
//                lab's *own* SHA-256 and there is nowhere to hide a trapdoor.
//
// Everything is exact BigInt; there are no dependencies. The security-parameter
// choices (t, R_P) follow the published Goldilocks instantiations, but treat this
// as a teaching hash — the point is that it is *arithmetic*, and therefore
// provable.

import { P, add, mul, pow, fp } from './goldilocks'
import { sha256, utf8, bytesToBig } from './sha256'

/** State width: rate 4 + capacity 4. */
export const T_WIDTH = 8
/** Capacity elements (the sponge's security margin). */
export const CAPACITY = 4
/** Rate elements (how many field elements are absorbed / squeezed per permute). */
export const RATE = T_WIDTH - CAPACITY
/** Number of full rounds (S-box on every element), split half at each end. */
export const R_F = 8
/** Number of partial rounds (S-box on element 0 only). */
export const R_P = 22
/** Total rounds. */
export const ROUNDS = R_F + R_P
/** The S-box exponent. gcd(7, p−1) = 1, so x ↦ x^7 is a bijection of 𝔽_p. */
export const ALPHA = 7n

/** True on the full rounds: the first R_F/2 and the last R_F/2. */
export function isFullRound(r: number): boolean {
  return r < R_F / 2 || r >= R_F / 2 + R_P
}

/**
 * The round-constant schedule RC[r][j], nothing-up-my-sleeve. Each constant is
 * SHA-256 of a fixed label reduced mod p. Derived once at load time.
 */
export const RC: bigint[][] = (() => {
  const out: bigint[][] = []
  for (let r = 0; r < ROUNDS; r++) {
    const row: bigint[] = []
    for (let j = 0; j < T_WIDTH; j++) {
      // A domain-separated label per (round, lane). SHA-256 → 256 bits → mod p.
      const digest = sha256(utf8(`curvefield/poseidon/goldilocks/rc/${r}/${j}`))
      row.push(bytesToBig(digest) % P)
    }
    out.push(row)
  }
  return out
})()

/**
 * A Cauchy MDS matrix M[i][j] = 1/(x_i − y_j) with x_i = i, y_j = t + j. The x's
 * and y's are pairwise distinct and x_i ≠ y_j (since i < t ≤ t + j), so every
 * entry is defined; a Cauchy matrix is provably MDS. Derived once at load time.
 */
export const MDS: bigint[][] = (() => {
  const t = T_WIDTH
  const x = Array.from({ length: t }, (_, i) => BigInt(i))
  const y = Array.from({ length: t }, (_, j) => BigInt(t + j))
  const m: bigint[][] = []
  for (let i = 0; i < t; i++) {
    const row: bigint[] = []
    for (let j = 0; j < t; j++) {
      // 1/(x_i − y_j); x_i − y_j = i − (t+j) is negative, fp() lifts it into [0,p).
      row.push(pow(fp(x[i] - y[j]), P - 2n))
    }
    m.push(row)
  }
  return m
})()

/** The S-box x ↦ x^7 (three multiplications: x²·x⁴·x… actually x^7 = x^4·x^2·x). */
export function sbox(a: bigint): bigint {
  const a2 = mul(a, a)
  const a4 = mul(a2, a2)
  return mul(mul(a4, a2), a) // a^7
}

/** MixLayer: out_j = Σ_k MDS[j][k]·in_k. */
export function mdsApply(state: bigint[]): bigint[] {
  const t = T_WIDTH
  const out = new Array<bigint>(t).fill(0n)
  for (let i = 0; i < t; i++) {
    let acc = 0n
    for (let k = 0; k < t; k++) acc = add(acc, mul(MDS[i][k], state[k]))
    out[i] = acc
  }
  return out
}

/**
 * Apply one round r to `state`, returning the new state. This is the exact
 * function the STARK's transition constraint encodes as polynomials:
 *   a_k = state_k + RC[r][k];  y_k = (full or k==0) ? a_k^7 : a_k;  out = MDS·y.
 */
export function round(state: bigint[], r: number): bigint[] {
  const full = isFullRound(r)
  const y = new Array<bigint>(T_WIDTH)
  for (let k = 0; k < T_WIDTH; k++) {
    const a = add(state[k], RC[r][k])
    y[k] = full || k === 0 ? sbox(a) : a
  }
  return mdsApply(y)
}

/** The Poseidon permutation: apply all ROUNDS rounds to an 8-element state. */
export function permute(input: bigint[]): bigint[] {
  if (input.length !== T_WIDTH) throw new Error(`poseidon: state must be ${T_WIDTH} elements`)
  let state = input.map(fp)
  for (let r = 0; r < ROUNDS; r++) state = round(state, r)
  return state
}

/**
 * The full round-by-round trace: states[0] = input, states[r+1] = after round r.
 * Length ROUNDS+1. This is exactly the execution the STARK lays out as a trace,
 * one row per state.
 */
export function permuteTrace(input: bigint[]): bigint[][] {
  if (input.length !== T_WIDTH) throw new Error(`poseidon: state must be ${T_WIDTH} elements`)
  const states: bigint[][] = [input.map(fp)]
  for (let r = 0; r < ROUNDS; r++) states.push(round(states[states.length - 1], r))
  return states
}

/**
 * The compression the STARK proves: hash a RATE-element preimage by permuting
 * [m_0 … m_{RATE-1}, 0 … 0] and returning the first RATE output elements. A
 * 256-bit → 256-bit fixed-input hash (the shape of a zk-friendly Merkle-tree
 * compressor). The all-zero capacity is the domain-separation IV.
 */
export function compress(preimage: bigint[]): bigint[] {
  if (preimage.length !== RATE) throw new Error(`poseidon: preimage must be ${RATE} elements`)
  const state = new Array<bigint>(T_WIDTH).fill(0n)
  for (let i = 0; i < RATE; i++) state[i] = fp(preimage[i])
  const out = permute(state)
  return out.slice(0, RATE)
}

/**
 * A sponge hash of an arbitrary-length message (padded to a multiple of RATE
 * with the 10*-style pad: append a 1 then zeros). Absorb RATE at a time into the
 * rate lanes, permute; squeeze RATE lanes at the end. Returns `outLen` elements.
 */
export function hash(message: bigint[], outLen = RATE): bigint[] {
  // Pad: append 1, then zeros up to a multiple of RATE (guarantees ≥ 1 pad elem
  // so distinct messages differing only by trailing zeros don't collide).
  const padded = message.map(fp)
  padded.push(1n)
  while (padded.length % RATE !== 0) padded.push(0n)

  let state = new Array<bigint>(T_WIDTH).fill(0n)
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE; i++) state[i] = add(state[i], padded[off + i])
    state = permute(state)
  }

  const out: bigint[] = []
  while (out.length < outLen) {
    for (let i = 0; i < RATE && out.length < outLen; i++) out.push(state[i])
    if (out.length < outLen) state = permute(state)
  }
  return out
}

/** 2-to-1 compression for Merkle trees: hash(left ‖ right) → one field element. */
export function hashTwoToOne(left: bigint, right: bigint): bigint {
  const state = new Array<bigint>(T_WIDTH).fill(0n)
  state[0] = fp(left)
  state[1] = fp(right)
  return permute(state)[0]
}

/**
 * Is the MDS matrix invertible (a necessary condition for the diffusion layer to
 * be a bijection)? A tiny Gaussian elimination over 𝔽_p — used by the self-test.
 */
export function mdsInvertible(): boolean {
  const t = T_WIDTH
  const m = MDS.map((row) => row.slice())
  let det = 1n
  for (let col = 0; col < t; col++) {
    let piv = -1
    for (let r = col; r < t; r++)
      if (m[r][col] !== 0n) { piv = r; break }
    if (piv < 0) return false
    if (piv !== col) { const tmp = m[piv]; m[piv] = m[col]; m[col] = tmp; det = P - det }
    det = mul(det, m[col][col])
    const invPiv = pow(m[col][col], P - 2n)
    for (let r = col + 1; r < t; r++) {
      const f = mul(m[r][col], invPiv)
      if (f === 0n) continue
      for (let c = col; c < t; c++) m[r][c] = add(m[r][c], P - mul(f, m[col][c]))
    }
  }
  return det !== 0n
}
