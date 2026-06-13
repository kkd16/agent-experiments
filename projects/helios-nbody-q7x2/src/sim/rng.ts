// Deterministic, seedable PRNG utilities.
//
// Presets must be reproducible: a given seed always builds the same galaxy. We
// use mulberry32 — a tiny, fast, well-distributed 32-bit generator — and layer
// Gaussian / spherical samplers on top of it.

export class Rng {
  private state: number

  constructor(seed: number) {
    // Force into a 32-bit unsigned integer and avoid the degenerate 0 state.
    this.state = (seed >>> 0) || 0x9e3779b9
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next()
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  /** Standard normal sample via the Box–Muller transform. */
  gaussian(mean = 0, std = 1): number {
    // Guard against log(0).
    let u = 0
    while (u === 0) u = this.next()
    const v = this.next()
    const mag = Math.sqrt(-2 * Math.log(u))
    return mean + std * mag * Math.cos(2 * Math.PI * v)
  }

  /** A point uniformly distributed inside the unit disk. */
  inUnitDisk(): [number, number] {
    // Inverse-CDF radius keeps the distribution areally uniform.
    const r = Math.sqrt(this.next())
    const theta = 2 * Math.PI * this.next()
    return [r * Math.cos(theta), r * Math.sin(theta)]
  }
}
