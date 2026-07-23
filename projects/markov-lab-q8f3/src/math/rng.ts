// A small, fast, *seedable* PRNG so every run is reproducible.
// splitmix64-style seeding feeding a mulberry32 stream — good enough
// statistical quality for Monte-Carlo demos, and completely deterministic.

export class RNG {
  private s: number

  constructor(seed = 0x2545f491) {
    // Scramble the seed a little so nearby seeds give unrelated streams.
    let z = (seed ^ 0x9e3779b9) >>> 0
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
    this.s = (z ^ (z >>> 15)) >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [lo, hi). */
  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next()
  }

  /** Standard normal via Box–Muller (caches the second variate). */
  private spare: number | null = null
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const v = this.spare
      this.spare = null
      return mean + sd * v
    }
    let u: number
    let v: number
    let s: number
    do {
      u = this.next() * 2 - 1
      v = this.next() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const mul = Math.sqrt((-2 * Math.log(s)) / s)
    this.spare = v * mul
    return mean + sd * (u * mul)
  }

  /** A vector of independent standard normals. */
  normalVec(n: number, sd = 1): number[] {
    const out = new Array<number>(n)
    for (let i = 0; i < n; i++) out[i] = this.normal(0, sd)
    return out
  }

  /** Draw an index in [0, weights.length) proportional to `weights`. */
  categorical(weights: number[]): number {
    let sum = 0
    for (const w of weights) sum += w
    let r = this.next() * sum
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]
      if (r <= 0) return i
    }
    return weights.length - 1
  }
}
