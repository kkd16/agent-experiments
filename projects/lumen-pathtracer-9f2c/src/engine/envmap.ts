// envmap.ts — (21.0) IMAGE-BASED LIGHTING: an equirectangular HDRI environment
// that escaping rays read as radiance *and* that next-event estimation samples
// directly, by importance.
//
// For twenty versions Lumen's environment was either a constant colour, a vertical
// gradient, or the analytic Preetham sky — and the only part of it the integrator
// could *sample* was the sun: a single small cone. Everything else in the
// environment (a bright softbox, a band of city lights, the warm horizon of a
// sunset) was found only by a BSDF ray that happened to point at it, so a glossy
// surface lit by a vivid environment rendered as a storm of noise. An HDRI is the
// production-standard answer: a panorama of incident radiance wrapped around the
// scene, sampled where it is *bright* instead of uniformly.
//
// This module is a from-scratch implementation of PBRT's InfiniteAreaLight: a
// piecewise-constant 2D distribution over the lat-long image, built from the
// luminance of every texel weighted by sinθ (the solid-angle Jacobian of the
// equirectangular map), sampled via a marginal-then-conditional inverse CDF. The
// returned directional pdf is exact and in solid-angle measure, so it MIS-pairs
// with BSDF sampling byte-for-byte the way every other Lumen light does — the
// estimator stays provably unbiased; only the variance collapses.
//
// The panoramas themselves are generated procedurally (no image assets to ship):
// `studio` (a dark stage lit by three bright softboxes), `sunset` (a graded sky
// with a blinding low sun) and `twilight` (a dark dome over a horizon strewn with
// hundreds of warm city lights). Each is deterministic, so the worker pool and the
// verification suite build byte-identical maps.

import type { Vec3 } from './vec3'
import { luminance, v } from './vec3'

const TWO_PI = 2 * Math.PI

// ---- A 1D piecewise-constant distribution (PBRT Distribution1D) --------------
//
// Holds n bucket weights `func` and the normalised CDF of their integral. A
// uniform deviate maps through the inverse CDF to a continuous x∈[0,1) whose
// density is proportional to `func`; `funcInt` is the average bucket weight (the
// integral over [0,1)).
export class Distribution1D {
  readonly func: Float64Array
  readonly cdf: Float64Array
  readonly funcInt: number
  readonly n: number

  constructor(f: ArrayLike<number>) {
    const n = f.length
    this.n = n
    this.func = new Float64Array(n)
    for (let i = 0; i < n; i++) this.func[i] = f[i]
    const cdf = new Float64Array(n + 1)
    cdf[0] = 0
    for (let i = 1; i <= n; i++) cdf[i] = cdf[i - 1] + this.func[i - 1] / n
    const integral = cdf[n]
    this.funcInt = integral
    if (integral === 0) {
      // A degenerate (all-zero) row: fall back to a uniform CDF so sampling is
      // still well-defined (the row carries no light, but never divides by zero).
      for (let i = 1; i <= n; i++) cdf[i] = i / n
    } else {
      for (let i = 1; i <= n; i++) cdf[i] /= integral
    }
    this.cdf = cdf
  }

  // Map u∈[0,1) to a continuous sample. Returns the sample x, its density in the
  // [0,1) measure (func[off]/funcInt), and the bucket index it fell in.
  sampleContinuous(u: number): { x: number; pdf: number; off: number } {
    // Largest index with cdf[off] <= u (binary search).
    let lo = 0
    let hi = this.n
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (this.cdf[mid] <= u) lo = mid
      else hi = mid
    }
    const off = lo
    let du = u - this.cdf[off]
    const span = this.cdf[off + 1] - this.cdf[off]
    if (span > 0) du /= span
    const pdf = this.funcInt > 0 ? this.func[off] / this.funcInt : 0
    return { x: (off + du) / this.n, pdf, off }
  }

  // Density (in the [0,1) measure) the sampler assigns to a point x∈[0,1).
  pdfAt(x: number): number {
    if (this.funcInt <= 0) return 0
    let off = Math.floor(x * this.n)
    if (off < 0) off = 0
    if (off >= this.n) off = this.n - 1
    return this.func[off] / this.funcInt
  }
}

// ---- A 2D piecewise-constant distribution over the unit square ---------------
//
// One conditional Distribution1D per row (over u) plus a marginal over the rows
// (over v, weighted by each row's integral). Sampling draws a row from the
// marginal then a column from that row's conditional; the joint density is
// func(u,v) / ∫∫func, which integrates to 1 over the unit square by construction.
export class Distribution2D {
  readonly conditional: Distribution1D[]
  readonly marginal: Distribution1D
  readonly nu: number
  readonly nv: number

  constructor(func: Float64Array, nu: number, nv: number) {
    this.nu = nu
    this.nv = nv
    this.conditional = new Array(nv)
    const rowIntegrals = new Float64Array(nv)
    for (let vIdx = 0; vIdx < nv; vIdx++) {
      const row = func.subarray(vIdx * nu, vIdx * nu + nu)
      const d = new Distribution1D(row)
      this.conditional[vIdx] = d
      rowIntegrals[vIdx] = d.funcInt
    }
    this.marginal = new Distribution1D(rowIntegrals)
  }

  // Draw (u,v)∈[0,1)² and return its joint density in the unit-square measure.
  sampleContinuous(u0: number, u1: number): { u: number; v: number; pdf: number } {
    const m = this.marginal.sampleContinuous(u1)
    const c = this.conditional[m.off].sampleContinuous(u0)
    return { u: c.x, v: m.x, pdf: c.pdf * m.pdf }
  }

  // Joint density (unit-square measure) at (u,v): func[iu][iv] / ∫∫func, where
  // ∫∫func is exactly the marginal's integral (the average of the row integrals).
  pdf(u: number, vCoord: number): number {
    const denom = this.marginal.funcInt
    if (denom <= 0) return 0
    let iu = Math.floor(u * this.nu)
    let iv = Math.floor(vCoord * this.nv)
    if (iu < 0) iu = 0
    if (iu >= this.nu) iu = this.nu - 1
    if (iv < 0) iv = 0
    if (iv >= this.nv) iv = this.nv - 1
    return this.conditional[iv].func[iu] / denom
  }
}

export type HdriPreset = 'studio' | 'sunset' | 'twilight'

// ---- equirectangular ↔ direction mapping ------------------------------------
//
// Pixel (i,j) → (u,v)=((i+0.5)/W,(j+0.5)/H) → spherical (θ=vπ from +y, φ=u·2π).
// The y axis is up (matching the renderer's convention), so the top image row is
// the zenith and the bottom row the nadir.

function uvToDir(u: number, vCoord: number, rotation: number): Vec3 {
  const theta = vCoord * Math.PI
  const phi = u * TWO_PI + rotation
  const sinT = Math.sin(theta)
  return v(sinT * Math.cos(phi), Math.cos(theta), sinT * Math.sin(phi))
}

// Inverse map: a unit direction → (u,v) with the rotation undone, plus sinθ
// (needed for the solid-angle Jacobian). u is wrapped into [0,1).
function dirToUV(d: Vec3, rotation: number): { u: number; v: number; sinT: number } {
  const y = d.y < -1 ? -1 : d.y > 1 ? 1 : d.y
  const theta = Math.acos(y)
  let phi = Math.atan2(d.z, d.x) - rotation
  // Wrap φ into [0, 2π).
  phi = phi % TWO_PI
  if (phi < 0) phi += TWO_PI
  return { u: phi / TWO_PI, v: theta / Math.PI, sinT: Math.sqrt(Math.max(0, 1 - y * y)) }
}

// ---- the environment map ----------------------------------------------------

export class EnvMap {
  readonly width: number
  readonly height: number
  // Interleaved [r,g,b] linear HDR radiance, row-major (row 0 = zenith).
  private readonly pixels: Float64Array
  private readonly dist: Distribution2D
  private readonly rotation: number
  private readonly intensity: number
  // The luminance-weighted mean radiance over the whole sphere (∫L dω / 4π),
  // exposed for diagnostics / SPPM-style energy bookkeeping.
  readonly meanRadiance: Vec3

  constructor(preset: HdriPreset, intensity = 1, rotationRad = 0) {
    const W = 512
    const H = 256
    this.width = W
    this.height = H
    this.rotation = rotationRad
    this.intensity = intensity
    this.pixels = generatePanorama(preset, W, H)

    // Importance weights: luminance × sinθ (the equirectangular area element).
    const func = new Float64Array(W * H)
    let sumW = 0
    let sr = 0
    let sg = 0
    let sb = 0
    for (let j = 0; j < H; j++) {
      const theta = ((j + 0.5) / H) * Math.PI
      const sinT = Math.sin(theta)
      for (let i = 0; i < W; i++) {
        const o = (j * W + i) * 3
        const r = this.pixels[o]
        const g = this.pixels[o + 1]
        const b = this.pixels[o + 2]
        func[j * W + i] = luminance(v(r, g, b)) * sinT
        sr += r * sinT
        sg += g * sinT
        sb += b * sinT
        sumW += sinT
      }
    }
    this.dist = new Distribution2D(func, W, H)
    // ∫L dω / ∫dω, the sin-weighted mean (the constant ambient an env this bright
    // would contribute). sumW ≈ (W·H)·(2/π); the ratio is independent of the grid.
    const inv = sumW > 0 ? 1 / sumW : 0
    this.meanRadiance = v(sr * inv * intensity, sg * inv * intensity, sb * inv * intensity)
  }

  // Bilinear radiance lookup for a direction (wraps in u, clamps in v).
  radiance(dir: Vec3): Vec3 {
    const { u, v: vc } = dirToUV(dir, this.rotation)
    return this.texel(u, vc)
  }

  private texel(u: number, vc: number): Vec3 {
    const W = this.width
    const H = this.height
    const fx = u * W - 0.5
    const fy = vc * H - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const xa = ((x0 % W) + W) % W
    const xb = (xa + 1) % W
    const ya = y0 < 0 ? 0 : y0 >= H ? H - 1 : y0
    const yb = y0 + 1 < 0 ? 0 : y0 + 1 >= H ? H - 1 : y0 + 1
    const p = this.pixels
    const i00 = (ya * W + xa) * 3
    const i10 = (ya * W + xb) * 3
    const i01 = (yb * W + xa) * 3
    const i11 = (yb * W + xb) * 3
    const w00 = (1 - tx) * (1 - ty)
    const w10 = tx * (1 - ty)
    const w01 = (1 - tx) * ty
    const w11 = tx * ty
    const k = this.intensity
    return v(
      (p[i00] * w00 + p[i10] * w10 + p[i01] * w01 + p[i11] * w11) * k,
      (p[i00 + 1] * w00 + p[i10 + 1] * w10 + p[i01 + 1] * w01 + p[i11 + 1] * w11) * k,
      (p[i00 + 2] * w00 + p[i10 + 2] * w10 + p[i01 + 2] * w01 + p[i11 + 2] * w11) * k,
    )
  }

  // Importance-sample a direction toward the environment. Returns the direction,
  // its solid-angle pdf, and the radiance there — or null at a pole (sinθ→0,
  // where the directional density is undefined; the surrounding BSDF sampling
  // carries those directions unbiasedly).
  sample(u0: number, u1: number): { wi: Vec3; pdf: number; radiance: Vec3 } | null {
    const s = this.dist.sampleContinuous(u0, u1)
    const theta = s.v * Math.PI
    const sinT = Math.sin(theta)
    if (sinT <= 0) return null
    const wi = uvToDir(s.u, s.v, this.rotation)
    // p(ω) = p(u,v) / (2π² sinθ): dω = sinθ dθ dφ = 2π²·sinθ·du dv.
    const pdf = s.pdf / (TWO_PI * Math.PI * sinT)
    return { wi, pdf, radiance: this.texel(s.u, s.v) }
  }

  // Solid-angle pdf the sampler would assign to direction `dir` — the MIS partner
  // of `sample`. Zero at a pole. Matches `sample`'s returned pdf to machine ε.
  pdf(dir: Vec3): number {
    const { u, v: vc, sinT } = dirToUV(dir, this.rotation)
    if (sinT <= 0) return 0
    const puv = this.dist.pdf(u, vc)
    return puv / (TWO_PI * Math.PI * sinT)
  }
}

// ---- procedural equirectangular panorama generators -------------------------

// A tiny deterministic PRNG (mulberry32) so the city-light scatter is identical
// across the worker pool and the verification suite.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

// Angular distance between two directions given by (θ,φ).
function angDist(t0: number, p0: number, t1: number, p1: number): number {
  const c =
    Math.cos(t0) * Math.cos(t1) +
    Math.sin(t0) * Math.sin(t1) * Math.cos(p0 - p1)
  return Math.acos(Math.min(1, Math.max(-1, c)))
}

function generatePanorama(preset: HdriPreset, W: number, H: number): Float64Array {
  const px = new Float64Array(W * H * 3)
  const set = (i: number, j: number, r: number, g: number, b: number): void => {
    const o = (j * W + i) * 3
    px[o] = r
    px[o + 1] = g
    px[o + 2] = b
  }
  if (preset === 'studio') {
    // A dark cyclorama lit by three soft rectangular sources: a warm key and a
    // cool fill high in front, and a bright rim source behind. Most of the dome
    // is near-black, so importance sampling is the difference between a clean
    // render and pure noise — the canonical product-shot lighting setup.
    type Box = { theta: number; phi: number; dt: number; dp: number; col: Vec3 }
    const boxes: Box[] = [
      { theta: 0.7, phi: 1.1, dt: 0.32, dp: 0.5, col: v(34, 30, 24) }, // warm key
      { theta: 0.85, phi: 4.0, dt: 0.4, dp: 0.6, col: v(11, 13, 17) }, // cool fill
      { theta: 0.55, phi: 3.0, dt: 0.18, dp: 0.9, col: v(46, 46, 50) }, // rim/back
    ]
    for (let j = 0; j < H; j++) {
      const theta = ((j + 0.5) / H) * Math.PI
      // A faint vertical gradient: a touch of cool sky above, dark floor below.
      const up = Math.cos(theta) * 0.5 + 0.5
      const ambR = 0.015 + 0.02 * up
      const ambG = 0.02 + 0.028 * up
      const ambB = 0.03 + 0.05 * up
      for (let i = 0; i < W; i++) {
        const phi = ((i + 0.5) / W) * TWO_PI
        let r = ambR
        let g = ambG
        let b = ambB
        for (const bx of boxes) {
          // Soft rectangular falloff in (θ,φ); φ distance wraps around the sphere.
          let dphi = Math.abs(phi - bx.phi)
          if (dphi > Math.PI) dphi = TWO_PI - dphi
          const wt =
            smoothstep(bx.dt, bx.dt * 0.6, Math.abs(theta - bx.theta)) *
            smoothstep(bx.dp, bx.dp * 0.6, dphi)
          r += bx.col.x * wt
          g += bx.col.y * wt
          b += bx.col.z * wt
        }
        set(i, j, r, g, b)
      }
    }
  } else if (preset === 'sunset') {
    // A graded evening sky: deep-blue zenith, a band of warm orange at the
    // horizon, a dark ground below — and a small, blindingly bright sun just
    // above the horizon. The sun is a tiny fraction of the sphere carrying most
    // of the energy, so BSDF sampling alone would find it once in hundreds of
    // rays; the importance sampler lands on it directly.
    const sunTheta = Math.PI * 0.46 // just above the horizon (θ=π/2)
    const sunPhi = Math.PI * 0.85
    const sunR = 0.04 // angular radius
    const zenith = v(0.04, 0.09, 0.22)
    const horizon = v(1.4, 0.55, 0.18)
    const ground = v(0.06, 0.045, 0.04)
    for (let j = 0; j < H; j++) {
      const theta = ((j + 0.5) / H) * Math.PI
      for (let i = 0; i < W; i++) {
        const phi = ((i + 0.5) / W) * TWO_PI
        let r: number
        let g: number
        let b: number
        if (theta < Math.PI / 2) {
          // Sky: blend zenith→horizon as we descend, with an extra warm flush
          // concentrated near the sun's azimuth (atmospheric forward scatter).
          const t = smoothstep(0, Math.PI / 2, theta)
          let dphi = Math.abs(phi - sunPhi)
          if (dphi > Math.PI) dphi = TWO_PI - dphi
          const glow = Math.exp(-dphi * dphi * 1.2) * smoothstep(0.2, 1.4, theta)
          r = zenith.x + (horizon.x - zenith.x) * t + 0.5 * glow
          g = zenith.y + (horizon.y - zenith.y) * t + 0.28 * glow
          b = zenith.z + (horizon.z - zenith.z) * t + 0.1 * glow
        } else {
          // Ground: horizon colour fading down into a dark earth.
          const t = smoothstep(Math.PI / 2, Math.PI * 0.62, theta)
          r = horizon.x * (1 - t) * 0.35 + ground.x * t
          g = horizon.y * (1 - t) * 0.35 + ground.y * t
          b = horizon.z * (1 - t) * 0.35 + ground.z * t
        }
        // The sun disc with a bright halo.
        const ad = angDist(theta, phi, sunTheta, sunPhi)
        if (ad < sunR) {
          r += 620
          g += 470
          b += 300
        } else {
          const halo = Math.exp(-(ad - sunR) * 26) * 18
          r += halo
          g += halo * 0.72
          b += halo * 0.4
        }
        set(i, j, r, g, b)
      }
    }
  } else {
    // twilight: a deep blue-violet dome over a horizon strewn with hundreds of
    // warm city lights, plus a pale moon. Many small bright features over a dark
    // field — gorgeous reflected in chrome and a stress test for the sampler,
    // which must resolve a crowd of point-like emitters, not one big source.
    const rng = mulberry32(0x5eed1357)
    for (let j = 0; j < H; j++) {
      const theta = ((j + 0.5) / H) * Math.PI
      const up = Math.cos(theta) * 0.5 + 0.5
      for (let i = 0; i < W; i++) {
        // Sky gradient: violet near the horizon to near-black overhead.
        const r = 0.012 + 0.05 * (1 - up)
        const g = 0.016 + 0.04 * (1 - up)
        const b = 0.04 + 0.09 * (1 - up)
        set(i, j, r, g, b)
      }
    }
    // The moon.
    const moonTheta = Math.PI * 0.3
    const moonPhi = Math.PI * 0.4
    for (let j = 0; j < H; j++) {
      const theta = ((j + 0.5) / H) * Math.PI
      for (let i = 0; i < W; i++) {
        const phi = ((i + 0.5) / W) * TWO_PI
        const ad = angDist(theta, phi, moonTheta, moonPhi)
        if (ad < 0.05) {
          const o = (j * W + i) * 3
          px[o] += 120
          px[o + 1] += 125
          px[o + 2] += 140
        }
      }
    }
    // City lights: a dense band of small bright dots around the horizon.
    const nLights = 520
    for (let k = 0; k < nLights; k++) {
      const phi = rng() * TWO_PI
      // Cluster the lights just below the horizon (θ slightly > π/2).
      const theta = Math.PI * 0.5 + (rng() * rng() - 0.05) * 0.32
      const warm = 0.6 + rng() * 0.4
      const power = 6 + rng() * rng() * 90
      const cr = power * (0.8 + 0.4 * warm)
      const cg = power * (0.6 + 0.25 * warm)
      const cb = power * (0.35 + 0.1 * (1 - warm))
      const ci = Math.floor((phi / TWO_PI) * W)
      const cj = Math.floor((theta / Math.PI) * H)
      // A 2×2 splat so each light spans more than a single texel.
      for (let dj = 0; dj <= 1; dj++) {
        for (let di = 0; di <= 1; di++) {
          const ii = ((ci + di) % W + W) % W
          const jj = Math.min(H - 1, Math.max(0, cj + dj))
          const o = (jj * W + ii) * 3
          px[o] += cr
          px[o + 1] += cg
          px[o + 2] += cb
        }
      }
    }
  }
  return px
}
