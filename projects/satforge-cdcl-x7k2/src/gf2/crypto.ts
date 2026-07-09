// A linear-feedback shift register (LFSR) and its downfall — the studio's
// "linear algebra breaks a cipher" demonstration.
//
// An LFSR clocks a register of `L` bits: the new bit is a fixed XOR (the taps)
// of some current bits, everything shifts, and the bit that falls off is output.
// Every output bit is therefore a *linear* function of the L unknown seed bits
// over 𝔽₂. Observe about L output bits and you have L linear equations in L
// unknowns — Gaussian elimination recovers the entire secret seed exactly. This
// is the Berlekamp–Massey lesson in raw form and precisely why a bare LFSR is
// never used as a stream cipher: its keystream carries no nonlinearity to hide
// the seed behind.
//
// We build the observation system symbolically: each register cell is tracked
// as the set of seed bits it currently equals (a bitmask), so clocking is just
// XOR of masks and reading a keystream bit hands us one parity equation.

import type { Gf2System } from './gf2'
import { rref, particularSolution } from './gf2'
import { mulberry32 } from './examples'

export interface LfsrSpec {
  /** Register length (number of seed bits). */
  length: number
  /** Tap positions (0-based cell indices) that feed the XOR of the new bit. */
  taps: number[]
  /** The secret initial state, most-significant cell first (length bits). */
  seed: number[]
}

/**
 * Run an LFSR forward, returning `steps` output bits. Each step outputs cell 0,
 * shifts every cell down, and loads the tap-XOR into the top cell (a Fibonacci
 * LFSR). Purely concrete — used to manufacture a keystream to then break.
 */
export function runLfsr(spec: LfsrSpec, steps: number): number[] {
  const state = spec.seed.slice()
  const out: number[] = []
  for (let t = 0; t < steps; t++) {
    out.push(state[0])
    let feedback = 0
    for (const tap of spec.taps) feedback ^= state[tap]
    for (let i = 0; i < spec.length - 1; i++) state[i] = state[i + 1]
    state[spec.length - 1] = feedback
  }
  return out
}

/**
 * The keystream-recovery system: track each cell symbolically as the XOR of
 * seed bits it equals, clock the register, and emit one parity equation per
 * observed output bit. Variables are the L seed bits (0-based). Feeding this to
 * the 𝔽₂ engine reconstructs the seed.
 */
export function lfsrRecoverySystem(length: number, taps: number[], keystream: number[]): Gf2System {
  // cell[i] is a bitmask over seed bits; initially cell i == seed bit i.
  let cell = Array.from({ length }, (_, i) => 1n << BigInt(i))
  const rows: { mask: bigint; rhs: number }[] = []
  for (let t = 0; t < keystream.length; t++) {
    rows.push({ mask: cell[0], rhs: keystream[t] & 1 })
    let feedback = 0n
    for (const tap of taps) feedback ^= cell[tap]
    const next = cell.slice()
    for (let i = 0; i < length - 1; i++) next[i] = cell[i + 1]
    next[length - 1] = feedback
    cell = next
  }
  return { numVars: length, rows }
}

export interface LfsrBreak {
  /** The recovered seed (length bits, cell 0 first), or null if under-determined/inconsistent. */
  seed: number[] | null
  /** Rank of the observation system — L means a unique recovery. */
  rank: number
  length: number
  /** True when the linear system pins the seed uniquely. */
  unique: boolean
}

/** Recover an LFSR seed from an observed keystream by Gaussian elimination. */
export function breakLfsr(length: number, taps: number[], keystream: number[]): LfsrBreak {
  const sys = lfsrRecoverySystem(length, taps, keystream)
  const rr = rref(sys)
  if (rr.inconsistent) return { seed: null, rank: rr.rank, length, unique: false }
  const unique = rr.rank === length
  const ps = particularSolution(rr)
  const seed = ps ? ps.map((b) => (b ? 1 : 0)) : null
  return { seed, rank: rr.rank, length, unique }
}

/** A reproducible random LFSR with a nonempty, seed-dependent tap set. */
export function randomLfsr(length: number, seed: number): LfsrSpec {
  const rng = mulberry32(seed)
  const taps: number[] = [length - 1] // always tap the top for a full-ish period
  for (let i = 0; i < length - 1; i++) if (rng() < 0.5) taps.push(i)
  const seedBits: number[] = Array.from({ length }, () => (rng() < 0.5 ? 1 : 0))
  let ones = 0
  for (const b of seedBits) ones += b
  if (ones === 0) seedBits[0] = 1 // avoid the dead all-zero state
  return { length, taps, seed: seedBits }
}
