// HyperLogLog — cardinality (COUNT DISTINCT) in a few kilobytes.
//
// The question "how many DISTINCT values?" normally costs O(distinct) memory —
// a hash set of everything ever seen. HyperLogLog (Flajolet, Fusy, Gandouet &
// Meunier 2007) answers it in a fixed `m = 2^p` register array, each register a
// single byte, at a standard error of ≈ 1.04/√m — so p = 14 (16 KB) estimates a
// billion distinct values within ~0.8 %.
//
// The idea is a stochastic leading-zero bet. Hash each value to a ~uniform
// 64-bit word. The low `p` bits pick a register; ρ = the position of the first
// set bit of the rest is a geometric variable — seeing ρ = k somewhere is
// evidence you've drawn ≈2^k distinct items (a run of k zeros happens once per
// 2^k draws). Each register keeps the *max* ρ it has witnessed; averaging 2^ρ
// across registers (a harmonic mean, which tames the high-variance tail) and
// correcting the bias gives the estimate. Because a register only ever keeps a
// max, two HLLs MERGE by taking the register-wise max — the estimator is a
// monoid, which is why HLL is the backbone of distributed COUNT(DISTINCT).

import { hashValue64, rho64 } from './hash'
import type { SqlValue } from '../types'

export class HyperLogLog {
  readonly p: number
  readonly m: number
  readonly registers: Uint8Array
  /** Bias-correction constant α_m for the harmonic-mean estimator. */
  private readonly alpha: number

  constructor(p = 14) {
    if (p < 4 || p > 20) throw new Error(`HyperLogLog precision p must be in [4, 20], got ${p}`)
    this.p = p
    this.m = 1 << p
    this.registers = new Uint8Array(this.m)
    this.alpha = alphaFor(this.m)
  }

  /** Fold a value into the sketch (idempotent — a repeat can only keep the max). */
  add(v: SqlValue): void {
    const h = hashValue64(v)
    const idx = h.lo & (this.m - 1)
    const r = rho64(h, this.p)
    if (r > this.registers[idx]) this.registers[idx] = r
  }

  /** The estimated number of distinct values folded in so far. */
  estimate(): number {
    let sum = 0
    let zeros = 0
    for (let i = 0; i < this.m; i++) {
      const r = this.registers[i]
      sum += 1 / (1 << r) // 2^{-r}, r < 32 in every practical regime
      if (r === 0) zeros++
    }
    const raw = (this.alpha * this.m * this.m) / sum
    // Small-range correction: when many registers are still empty the raw
    // estimator is biased low, and linear counting (m·ln(m/V)) is exact-ish.
    if (raw <= 2.5 * this.m && zeros > 0) {
      return this.m * Math.log(this.m / zeros)
    }
    return raw
  }

  /** The theoretical relative standard error of this configuration. */
  standardError(): number {
    return 1.04 / Math.sqrt(this.m)
  }

  /** Bytes of register state (the whole footprint, independent of cardinality). */
  byteSize(): number {
    return this.m
  }

  /** Register-wise max with another HLL of the same precision → the union's sketch. */
  merge(other: HyperLogLog): void {
    if (other.p !== this.p) throw new Error(`cannot merge HLL p=${other.p} into p=${this.p}`)
    for (let i = 0; i < this.m; i++) {
      if (other.registers[i] > this.registers[i]) this.registers[i] = other.registers[i]
    }
  }

  clone(): HyperLogLog {
    const c = new HyperLogLog(this.p)
    c.registers.set(this.registers)
    return c
  }
}

/** The static merge of two same-precision sketches into a fresh one. */
export function mergeHLL(a: HyperLogLog, b: HyperLogLog): HyperLogLog {
  const out = a.clone()
  out.merge(b)
  return out
}

/** α_m: the harmonic-mean bias constant, with the small-m special cases. */
function alphaFor(m: number): number {
  if (m === 16) return 0.673
  if (m === 32) return 0.697
  if (m === 64) return 0.709
  return 0.7213 / (1 + 1.079 / m)
}
