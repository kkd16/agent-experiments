// The Monte-Carlo sampling kit for the path tracer: a tiny per-pixel RNG, the
// distributions we importance-sample (cosine hemisphere, GGX microfacet normals),
// a branchless orthonormal basis and Fresnel–Schlick. Everything here is pure and
// allocation-light so the tracer's inner loops stay cheap.
import type { Vec3 } from '../math/vec.ts'
import { clamp01 } from '../math/scalar.ts'

const TAU = Math.PI * 2

// A small, fast xorshift32 generator. Seeded per pixel+sample from a hash so the
// stream is deterministic (reproducible images) yet decorrelated between pixels.
export class Rng {
  private s: number
  constructor(seed: number) {
    // never let the state be zero (xorshift would stick at zero)
    this.s = (seed | 0) === 0 ? 0x9e3779b9 : seed >>> 0
  }
  // next float in [0, 1)
  next(): number {
    let x = this.s
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x >>> 0
    // 24-bit mantissa worth of randomness, divided into [0,1)
    return (this.s >>> 8) / 0x01000000
  }
}

// A 3-round integer hash (a la PCG) to turn (x, y, sampleIndex) into a seed.
export function hashSeed(x: number, y: number, frame: number): number {
  let h = (Math.imul(x, 1973) + Math.imul(y, 9277) + Math.imul(frame, 26699) + 1) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h = (h ^ (h >>> 12)) >>> 0
  h = Math.imul(h, 0x297a2d39) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  return h >>> 0
}

// Branchless orthonormal basis around a unit normal n (Duff, Pixar 2017). Returns
// two unit tangents perpendicular to n and to each other.
export function orthonormalBasis(n: Vec3): [Vec3, Vec3] {
  const s = n[2] >= 0 ? 1 : -1
  const a = -1 / (s + n[2])
  const b = n[0] * n[1] * a
  const t1: Vec3 = [1 + s * n[0] * n[0] * a, s * b, -s * n[0]]
  const t2: Vec3 = [b, s + n[1] * n[1] * a, -n[1]]
  return [t1, t2]
}

// Map a tangent-space direction (built in the basis of n) back to world space.
export function toWorld(local: Vec3, t1: Vec3, t2: Vec3, n: Vec3): Vec3 {
  return [
    local[0] * t1[0] + local[1] * t2[0] + local[2] * n[0],
    local[0] * t1[1] + local[1] * t2[1] + local[2] * n[1],
    local[0] * t1[2] + local[1] * t2[2] + local[2] * n[2],
  ]
}

// Cosine-weighted hemisphere direction around +Z (local). pdf = cosθ/π. Concentric
// (Shirley) disk mapping keeps the distribution low-discrepancy.
export function cosineHemisphere(u1: number, u2: number): Vec3 {
  // concentric disk
  const a = 2 * u1 - 1
  const b = 2 * u2 - 1
  let r: number
  let phi: number
  if (a === 0 && b === 0) {
    r = 0
    phi = 0
  } else if (a * a > b * b) {
    r = a
    phi = (Math.PI / 4) * (b / a)
  } else {
    r = b
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b)
  }
  const x = r * Math.cos(phi)
  const y = r * Math.sin(phi)
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
  return [x, y, z]
}

// A direction inside a cone of half-angle `cosThetaMax` (its cosine) around +Z,
// uniformly in solid angle. Used to soften directional / point lights.
export function uniformCone(u1: number, u2: number, cosThetaMax: number): Vec3 {
  const cosTheta = 1 - u1 * (1 - cosThetaMax)
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
  const phi = TAU * u2
  return [Math.cos(phi) * sinTheta, Math.sin(phi) * sinTheta, cosTheta]
}

// A uniform point on the unit sphere (for sampling a spherical area light).
export function uniformSphere(u1: number, u2: number): Vec3 {
  const z = 1 - 2 * u1
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  const phi = TAU * u2
  return [Math.cos(phi) * r, Math.sin(phi) * r, z]
}

// GGX/Trowbridge–Reitz half-vector importance sample (local space, around +Z).
// Returns a microfacet normal m with pdf = D(m)·cosθ_m. a = roughness².
export function sampleGGX(u1: number, u2: number, a: number): Vec3 {
  const phi = TAU * u1
  const cosTheta = Math.sqrt((1 - u2) / (1 + (a * a - 1) * u2))
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
  return [Math.cos(phi) * sinTheta, Math.sin(phi) * sinTheta, cosTheta]
}

// GGX normal distribution (same as pbr.ts, exposed for the tracer's pdf math).
export function distributionGGX(noh: number, a: number): number {
  const a2 = a * a
  const d = noh * noh * (a2 - 1) + 1
  return a2 / (Math.PI * d * d + 1e-7)
}

// Smith GGX masking-shadowing (separable G1·G1), un-folded — the tracer divides
// by 4·NoV·NoL itself so it can share this with the pdf.
export function smithG(nov: number, nol: number, a: number): number {
  const a2 = a * a
  const gv = nol * Math.sqrt(nov * nov * (1 - a2) + a2)
  const gl = nov * Math.sqrt(nol * nol * (1 - a2) + a2)
  const denom = gv + gl
  return denom > 1e-7 ? (2 * nol * nov) / denom : 0
}

// Fresnel–Schlick over an RGB F0.
export function fresnelSchlick(cosTheta: number, f0: Vec3): Vec3 {
  const f = Math.pow(clamp01(1 - cosTheta), 5)
  return [f0[0] + (1 - f0[0]) * f, f0[1] + (1 - f0[1]) * f, f0[2] + (1 - f0[2]) * f]
}

// Veach's power heuristic (β = 2) for combining two Monte-Carlo sampling strategies in
// multiple importance sampling: the weight given to a sample drawn from strategy A whose
// densities at that sample are pdfA / pdfB. Squaring sharpens the balance heuristic so the
// lower-variance strategy dominates; the paired weights w(A)+w(B) sum to 1 by construction.
// Returns 1 when the other strategy assigns zero density (so no light is ever lost).
export function powerHeuristic(pdfA: number, pdfB: number): number {
  const a2 = pdfA * pdfA
  const b2 = pdfB * pdfB
  const denom = a2 + b2
  return denom > 0 ? a2 / denom : 0
}
