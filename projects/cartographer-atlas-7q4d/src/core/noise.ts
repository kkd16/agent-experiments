// Seeded gradient (Perlin) noise + fractal helpers. The permutation table is
// shuffled from the seed so every world gets its own coherent noise field, while
// staying perfectly reproducible.

import { Rng } from './rng'

const GRAD2: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
]

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

export class Noise2D {
  private perm: Uint8Array

  constructor(seed: number | string) {
    const rng = new Rng(seed)
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    // Fisher–Yates shuffle driven by the seeded RNG.
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i)
      const tmp = p[i]
      p[i] = p[j]
      p[j] = tmp
    }
    // Double the table so index wrap-around is a cheap mask.
    this.perm = new Uint8Array(512)
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
  }

  private grad(hash: number, x: number, y: number): number {
    const g = GRAD2[hash & 7]
    return g[0] * x + g[1] * y
  }

  /** Raw Perlin noise in roughly [-1, 1]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const u = fade(xf)
    const v = fade(yf)
    const perm = this.perm
    const aa = perm[perm[xi] + yi]
    const ab = perm[perm[xi] + yi + 1]
    const ba = perm[perm[xi + 1] + yi]
    const bb = perm[perm[xi + 1] + yi + 1]
    const x1 = lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u)
    const x2 = lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u)
    return lerp(x1, x2, v)
  }

  /**
   * Fractal Brownian motion: sum of `octaves` noise layers, each doubling in
   * frequency and halving in amplitude. Returns a value in [0, 1].
   */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let freq = 1
    let amp = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return (sum / norm) * 0.5 + 0.5
  }

  /**
   * Ridged multifractal noise — sharp crests, good for mountain spines.
   * Returns a value in [0, 1].
   */
  ridged(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let freq = 1
    let amp = 1
    let sum = 0
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq))
      sum += amp * n * n
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }
}
