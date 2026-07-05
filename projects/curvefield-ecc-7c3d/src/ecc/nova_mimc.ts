// A second IVC application: a MiMC-style arithmetic permutation, folded into a
// sequential hash chain / verifiable delay.
//
// The folding scheme in `nova.ts` is generic — it folds any R1CS. What changes
// between applications is only the step *circuit*. Where CUBIC_STEP is a toy
// (one cube), this is the shape real IVC targets: an inherently *sequential*
// computation. MiMC (Albrecht–Grassi–Rechberger–Roy–Tiessen 2016) permutes a
// field element by R rounds of x ↦ (x + cᵣ)³ — an S-box that is a permutation of
// 𝔽_r and, crucially for us, expressible as just two multiplications per round.
// Chaining the permutation, z_{i+1} = MiMC(z_i), gives a hash chain nobody can
// shortcut (each step needs the previous output), the same skeleton as a MinRoot
// VDF — and Nova proves the whole chain ran, with one final check, by folding.
//
// The step R1CS (public IO x = [z_in, z_out], witness W = [sq₀, cube₀, …]):
//   per round r on the running value xᵣ (x₀ = z_in):
//     sqᵣ   = (xᵣ + cᵣ)·(xᵣ + cᵣ)
//     cubeᵣ = sqᵣ·(xᵣ + cᵣ)          (= xᵣ₊₁)
//   final:  cube_{R−1} · 1 = z_out
// so a chain of N MiMC permutations folds exactly like the cubic — the generic
// folding machinery is untouched.

import { R } from './bls12381'
import { mod } from './field'
import { sha256, utf8, bytesToBig } from './sha256'
import { type R1CS, type StepFn } from './nova'

/** Nothing-up-my-sleeve round constants from the lab's own SHA-256. The first is
 *  0 by MiMC convention; the rest are H("curvefield/nova/mimc/rc/"+r) mod r. */
export function mimcConstants(rounds: number): bigint[] {
  const cs: bigint[] = []
  for (let r = 0; r < rounds; r++) {
    cs.push(r === 0 ? 0n : mod(bytesToBig(sha256(utf8('curvefield/nova/mimc/rc/' + r))), R))
  }
  return cs
}

/** The index of the running value xᵣ in the assignment Z = [one, z_in, z_out, …]. */
function xIndex(r: number): number {
  return r === 0 ? 1 : 2 + 2 * r // cube_{r-1} = 4 + 2(r-1) = 2 + 2r
}

/** Build the MiMC step's R1CS (2·rounds + 1 constraints, 2·rounds witness wires). */
export function mimcR1CS(constants: bigint[]): R1CS {
  const rounds = constants.length
  const numVars = 3 + 2 * rounds // one, z_in, z_out, then (sqᵣ, cubeᵣ) per round
  const row = () => new Array<bigint>(numVars).fill(0n)
  const A: bigint[][] = []
  const B: bigint[][] = []
  const C: bigint[][] = []
  for (let r = 0; r < rounds; r++) {
    const xi = xIndex(r)
    const sq = 3 + 2 * r
    const cube = 4 + 2 * r
    const c = mod(constants[r], R)
    // sqᵣ = (xᵣ + cᵣ)²
    let a = row(), b = row(), cc = row()
    a[xi] = mod(a[xi] + 1n, R); a[0] = mod(a[0] + c, R)
    b[xi] = mod(b[xi] + 1n, R); b[0] = mod(b[0] + c, R)
    cc[sq] = 1n
    A.push(a); B.push(b); C.push(cc)
    // cubeᵣ = sqᵣ·(xᵣ + cᵣ)
    a = row(); b = row(); cc = row()
    a[sq] = 1n
    b[xi] = mod(b[xi] + 1n, R); b[0] = mod(b[0] + c, R)
    cc[cube] = 1n
    A.push(a); B.push(b); C.push(cc)
  }
  // cube_{R-1} · one = z_out
  const a = row(), b = row(), cc = row()
  a[4 + 2 * (rounds - 1)] = 1n
  b[0] = 1n
  cc[2] = 1n
  A.push(a); B.push(b); C.push(cc)
  return { numVars, numPublic: 2, A, B, C }
}

/** Run the MiMC permutation once, recording the per-round witness wires. */
export function mimcAssign(
  constants: bigint[],
  zIn: bigint,
): { x: bigint[]; W: bigint[]; zOut: bigint } {
  let x = mod(zIn, R)
  const W: bigint[] = []
  for (let r = 0; r < constants.length; r++) {
    const s = mod(x + constants[r], R)
    const sq = mod(s * s, R)
    const cube = mod(sq * s, R)
    W.push(sq, cube)
    x = cube
  }
  return { x: [mod(zIn, R), x], W, zOut: x }
}

/** The MiMC permutation evaluated directly, for cross-checking the folded chain. */
export function mimcEval(constants: bigint[], zIn: bigint): bigint {
  let x = mod(zIn, R)
  for (let r = 0; r < constants.length; r++) {
    const s = mod(x + constants[r], R)
    x = mod(s * s * s, R)
  }
  return x
}

/** Package a MiMC permutation of the given round count as a foldable StepFn. */
export function mimcStep(rounds = 6): StepFn {
  const constants = mimcConstants(rounds)
  return {
    r1cs: mimcR1CS(constants),
    assign: (z) => mimcAssign(constants, z),
    eval: (z) => mimcEval(constants, z),
    label: `MiMC permutation (${rounds} rounds, x ↦ (x+c)³)`,
  }
}
