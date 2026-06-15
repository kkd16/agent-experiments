// rng.ts — a fast, statistically sound random number generator plus the
// importance-sampling primitives the path tracer relies on.
//
// We use `sfc32` (Small Fast Counting, Doty-Humphrey) seeded by `splitmix32`.
// Both operate natively on 32-bit words, so they are bit-exact under V8's
// integer fast paths (no 64-bit emulation), they pass PractRand to multiple
// terabytes, and they cost a handful of integer ops per draw — which matters
// when every bounce pulls a dozen randoms. Each pixel gets its own decorrelated
// stream so the render is deterministic and reproducible across worker layouts.

import type { Vec3 } from './vec3'
import { onb, toWorld } from './vec3'

const TWO_PI = Math.PI * 2

export class Rng {
  private a = 0
  private b = 0
  private c = 0
  private d = 0

  constructor(seed: number, stream = 1) {
    // splitmix32 expands the (seed, stream) pair into four decorrelated words.
    let x = (seed ^ 0x9e3779b9 ^ Math.imul(stream, 0x85ebca6b)) >>> 0
    const sm = (): number => {
      x = (x + 0x9e3779b9) >>> 0
      let z = x
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
      return (z ^ (z >>> 15)) >>> 0
    }
    this.a = sm()
    this.b = sm()
    this.c = sm()
    this.d = sm()
    // Warm up so the very first outputs are already well mixed.
    for (let i = 0; i < 12; i++) this.nextUint32()
  }

  // One sfc32 step → a well-distributed unsigned 32-bit integer.
  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0
    this.d = (this.d + 1) >>> 0
    this.a = (this.b ^ (this.b >>> 9)) >>> 0
    this.b = (this.c + (this.c << 3)) >>> 0
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0
    this.c = (this.c + t) >>> 0
    return t >>> 0
  }

  // Uniform float in [0, 1) with a full 24-bit mantissa.
  next(): number {
    return (this.nextUint32() >>> 8) / 0x1000000
  }

  // Uniform float in [lo, hi).
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  int(n: number): number {
    return Math.min(n - 1, (this.next() * n) | 0)
  }
}

// ---------------------------------------------------------------------------
// Sampling helpers. Each returns a direction and (where relevant) leaves the
// caller to combine with the analytic pdf, which we expose separately so the
// MIS code can evaluate pdfs for directions it did not itself generate.
// ---------------------------------------------------------------------------

// Cosine-weighted hemisphere sample in the local frame (z = up). pdf = cosθ/π.
export function cosineHemisphere(rng: Rng): Vec3 {
  const r = Math.sqrt(rng.next())
  const phi = TWO_PI * rng.next()
  const x = r * Math.cos(phi)
  const y = r * Math.sin(phi)
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
  return { x, y, z }
}

// Concentric mapping of a given unit-square point (u0,u1) ∈ [0,1)² to the unit
// disk (Shirley & Chiu). Split from concentricDisk so a low-discrepancy lens
// sample can be mapped with the identical area-preserving transform.
export function concentricDiskFrom(u0: number, u1: number): { x: number; y: number } {
  const ox = 2 * u0 - 1
  const oy = 2 * u1 - 1
  if (ox === 0 && oy === 0) return { x: 0, y: 0 }
  let r: number
  let theta: number
  if (Math.abs(ox) > Math.abs(oy)) {
    r = ox
    theta = (Math.PI / 4) * (oy / ox)
  } else {
    r = oy
    theta = Math.PI / 2 - (Math.PI / 4) * (ox / oy)
  }
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) }
}

// Concentric disk from the next two RNG draws.
export function concentricDisk(rng: Rng): { x: number; y: number } {
  return concentricDiskFrom(rng.next(), rng.next())
}

// Uniformly sample a triangle's barycentric coordinates.
export function triangleBary(rng: Rng): { u: number; v: number } {
  const u0 = rng.next()
  const u1 = rng.next()
  const su = Math.sqrt(u0)
  return { u: 1 - su, v: u1 * su }
}

// Convert a cosine-hemisphere local sample to world space around normal n.
export function sampleCosineWorld(rng: Rng, n: Vec3): Vec3 {
  const local = cosineHemisphere(rng)
  const { t, b } = onb(n)
  return toWorld(local, t, b, n)
}

// The power heuristic (β = 2) used to weight competing samplers in MIS.
export function powerHeuristic(nf: number, fPdf: number, ng: number, gPdf: number): number {
  const f = nf * fPdf
  const g = ng * gPdf
  const f2 = f * f
  const d = f2 + g * g
  return d > 0 ? f2 / d : 0
}
