// Volumetric participating media for the path tracer. This is the fog / haze /
// smoke / nebula layer the renderer was missing: a bounded region of space that
// *absorbs* and *scatters* light along a ray, rather than only at surfaces. Every
// estimator here is unbiased and shares the tracer's RNG.
//
// The physics, hand-derived:
//   • A ray crossing the medium loses energy as transmittance T(t) = exp(−∫σ_t ds)
//     (Beer–Lambert), where σ_t = σ_a + σ_s is the extinction coefficient.
//   • At a scattering event the light turns by an angle drawn from the
//     Henyey–Greenstein phase function p(cosθ); the *single-scattering albedo*
//     σ_s/σ_t is the fraction that survives (the rest is absorbed).
//   • Two tracking schemes drive it: an analytic, spectral (per-RGB) estimator for a
//     HOMOGENEOUS medium (constant coefficients — fog, haze, god-ray beams), and
//     DELTA / RATIO TRACKING (Woodcock) for a HETEROGENEOUS medium whose density
//     comes from a from-scratch 3-D fBm noise field (clouds, smoke, nebulae).
//
// Nothing here touches the DOM; `medium_verify.ts` re-derives every claim numerically.
import type { Vec3 } from '../math/vec.ts'
import { orthonormalBasis, toWorld, type Rng } from './sampling.ts'

const PI = Math.PI
const INV_4PI = 1 / (4 * PI)

// A bounded participating medium. `homogeneous` media use the full RGB extinction
// (so fog can be coloured); `heterogeneous` media modulate a single (max-channel)
// extinction by a [0,1] density field, with the colour carried by the albedo.
export interface Medium {
  // world-space bounding box the medium fills
  minx: number; miny: number; minz: number
  maxx: number; maxy: number; maxz: number
  sigmaT: Vec3 // extinction = absorption + scattering, per RGB channel
  sigmaS: Vec3 // scattering coefficient, per RGB channel (≤ sigmaT)
  g: number // Henyey–Greenstein anisotropy ∈ (−1,1): >0 forward, <0 back, 0 isotropic
  heterogeneous: boolean
  // heterogeneous field: σ_t(x) = sigmaMax · density(x), density ∈ [0,1]
  sigmaMax: number // mono majorant for delta/ratio tracking (max channel of sigmaT)
  albedo: Vec3 // sigmaS/sigmaT per channel — the colour a scattering event keeps
  noiseFreq: number // spatial frequency of the density field
  noiseOctaves: number
  densityFloor: number // subtract-then-clamp to carve empty space (wisps → clear)
  edgeFalloff: number // 0..1 radial fade to the box so clouds don't clip flat
}

// A box (world-space AABB) the medium is confined to.
export interface MediumBox {
  minx: number; miny: number; minz: number
  maxx: number; maxy: number; maxz: number
}

// A curated medium look. `sigmaT` is the per-channel extinction at density = 1;
// homogeneous media use it directly (so fog can be coloured), heterogeneous media use
// its max channel as the mono majorant and carry colour in `albedo`. `lobes` is the
// number of fBm cells across the box for heterogeneous fields.
export interface MediumPreset {
  key: string
  label: string
  blurb: string
  heterogeneous: boolean
  sigmaT: Vec3
  albedo: Vec3 // single-scattering albedo σ_s/σ_t (1 = lossless, <1 absorbs)
  g: number
  lobes: number
  densityFloor: number
  edgeFalloff: number
}

export const MEDIUM_PRESETS: MediumPreset[] = [
  {
    key: 'haze', label: 'Haze', heterogeneous: false,
    sigmaT: [0.05, 0.055, 0.07], albedo: [0.95, 0.95, 0.97], g: 0.55, lobes: 0, densityFloor: 0, edgeFalloff: 0,
    blurb: 'Thin, near-lossless atmosphere with strong forward scattering — distant objects haze out and the light blooms into soft crepuscular glow.',
  },
  {
    key: 'fog', label: 'Fog', heterogeneous: false,
    sigmaT: [0.22, 0.22, 0.23], albedo: [0.92, 0.92, 0.93], g: 0.3, lobes: 0, densityFloor: 0, edgeFalloff: 0,
    blurb: 'Dense neutral fog: everything fades quickly with distance and shadows soften as light is scattered out of the beam.',
  },
  {
    key: 'beams', label: 'Sun beams', heterogeneous: false,
    sigmaT: [0.09, 0.09, 0.1], albedo: [0.97, 0.97, 0.99], g: 0.82, lobes: 0, densityFloor: 0, edgeFalloff: 0,
    blurb: 'Sharply forward-scattering air — wherever geometry blocks the key light, the shadow carves visible god-ray volumes out of the lit haze.',
  },
  {
    key: 'amber', label: 'Amber smog', heterogeneous: false,
    sigmaT: [0.1, 0.17, 0.32], albedo: [0.9, 0.85, 0.75], g: 0.45, lobes: 0, densityFloor: 0, edgeFalloff: 0,
    blurb: 'Wavelength-dependent extinction: blue is absorbed fastest, so the medium reddens what it veils — a warm, smoggy dusk. (Coloured fog needs the spectral sampler.)',
  },
  {
    key: 'smoke', label: 'Smoke', heterogeneous: true,
    sigmaT: [1.7, 1.7, 1.7], albedo: [0.6, 0.6, 0.62], g: 0.0, lobes: 2.4, densityFloor: 0.46, edgeFalloff: 0.55,
    blurb: 'A heterogeneous fBm density field — billowing, absorbing smoke. Delta tracking samples collisions through the turbulence; ratio tracking shadows it.',
  },
  {
    key: 'nebula', label: 'Nebula', heterogeneous: true,
    sigmaT: [1.2, 1.2, 1.2], albedo: [0.72, 0.5, 0.92], g: 0.25, lobes: 2.0, densityFloor: 0.4, edgeFalloff: 0.6,
    blurb: 'A scattering cloud with a coloured albedo, glowing where an interior light bleeds through it — multiple scattering through a procedural volume.',
  },
]

// Build a runtime `Medium` for a preset confined to `box`, with the UI's density
// multiplier and anisotropy applied. Density scales the extinction (and majorant);
// the albedo (hence colour) is scale-invariant.
export function buildMedium(preset: MediumPreset, density: number, g: number, box: MediumBox): Medium {
  const st: Vec3 = [preset.sigmaT[0] * density, preset.sigmaT[1] * density, preset.sigmaT[2] * density]
  const ss: Vec3 = [st[0] * preset.albedo[0], st[1] * preset.albedo[1], st[2] * preset.albedo[2]]
  const ext = Math.max(box.maxx - box.minx, box.maxy - box.miny, box.maxz - box.minz) || 1
  return {
    minx: box.minx, miny: box.miny, minz: box.minz,
    maxx: box.maxx, maxy: box.maxy, maxz: box.maxz,
    sigmaT: st, sigmaS: ss, g,
    heterogeneous: preset.heterogeneous,
    sigmaMax: Math.max(st[0], st[1], st[2]) || 1e-6,
    albedo: preset.albedo,
    noiseFreq: preset.lobes > 0 ? preset.lobes / ext : 0.4,
    noiseOctaves: 5,
    densityFloor: preset.densityFloor,
    edgeFalloff: preset.edgeFalloff,
  }
}

// ── Henyey–Greenstein phase function ─────────────────────────────────────────────
// p(cosθ) is a normalised pdf over the sphere: ∫ p dω = 1. cosθ is between the
// *incoming* propagation direction and the outgoing (scattered) direction.
export function phaseHG(g: number, cosTheta: number): number {
  const g2 = g * g
  const denom = 1 + g2 - 2 * g * cosTheta
  // denom can dip to (1−|g|)² > 0 for |g|<1; guard the cube-root regardless
  return INV_4PI * (1 - g2) / (denom * Math.sqrt(Math.max(denom, 1e-12)))
}

// Importance-sample a scattering direction around the forward axis `w` (the unit
// propagation direction). Returns a unit world-space direction distributed exactly
// as p(cosθ), so phase/pdf = 1 and the throughput is unchanged by the bounce.
export function samplePhaseHG(
  g: number, wx: number, wy: number, wz: number, u1: number, u2: number,
): Vec3 {
  let cosTheta: number
  if (Math.abs(g) < 1e-3) {
    cosTheta = 1 - 2 * u1 // isotropic
  } else {
    const s = (1 - g * g) / (1 - g + 2 * g * u1)
    cosTheta = (1 + g * g - s * s) / (2 * g)
  }
  if (cosTheta > 1) cosTheta = 1
  else if (cosTheta < -1) cosTheta = -1
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
  const phi = 2 * PI * u2
  const [t1, t2] = orthonormalBasis([wx, wy, wz])
  // local (sinθcosφ, sinθsinφ, cosθ) built in the basis whose +Z is the forward axis
  return toWorld([sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta], t1, t2, [wx, wy, wz])
}

// ── 3-D fractal noise → heterogeneous density ────────────────────────────────────
// A hash-based value noise (trilinear, smoothstep-faded) summed over octaves. Pure
// and deterministic: density(x) is a fixed function of position, so images repeat.
function hash3(ix: number, iy: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647 & 1274126177)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 0xffffffff // [0,1]
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = smoothstep(x - ix), fy = smoothstep(y - iy), fz = smoothstep(z - iz)
  const c000 = hash3(ix, iy, iz), c100 = hash3(ix + 1, iy, iz)
  const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz)
  const c001 = hash3(ix, iy, iz + 1), c101 = hash3(ix + 1, iy, iz + 1)
  const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1)
  const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx
  const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy
  return y0 + (y1 - y0) * fz
}

function fbm(x: number, y: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq)
    norm += amp
    amp *= 0.5
    freq *= 2.03 // slightly off 2 to avoid lattice alignment
  }
  return norm > 0 ? sum / norm : 0
}

// Heterogeneous density ∈ [0,1] at a world point: fBm carved by a floor and faded
// to the box edges so the cloud sits inside the volume instead of clipping flat.
export function densityAt(m: Medium, x: number, y: number, z: number): number {
  let d = fbm(x * m.noiseFreq, y * m.noiseFreq, z * m.noiseFreq, m.noiseOctaves)
  d = (d - m.densityFloor) / (1 - m.densityFloor)
  if (d <= 0) return 0
  if (d > 1) d = 1
  if (m.edgeFalloff > 0) {
    // normalised distance from box centre, per axis; fade the outer shell
    const cx = (m.minx + m.maxx) * 0.5, cy = (m.miny + m.maxy) * 0.5, cz = (m.minz + m.maxz) * 0.5
    const hx = (m.maxx - m.minx) * 0.5 || 1, hy = (m.maxy - m.miny) * 0.5 || 1, hz = (m.maxz - m.minz) * 0.5 || 1
    const rx = Math.abs(x - cx) / hx, ry = Math.abs(y - cy) / hy, rz = Math.abs(z - cz) / hz
    const r = Math.sqrt(rx * rx + ry * ry + rz * rz) / Math.SQRT2 // ~1 at a face mid-edge
    const start = 1 - m.edgeFalloff
    if (r >= 1) return 0
    if (r > start) d *= 1 - smoothstep((r - start) / (1 - start))
  }
  return d
}

// ── ray ∩ box: the parametric span [t0,t1] of the segment inside the medium ───────
// Returns false (and leaves `out` untouched) if the ray misses the box within
// [tMin,tMax]. `out` is [t0,t1], both clamped to [tMin,tMax].
export function raySpan(
  m: Medium,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMin: number, tMax: number,
  out: { t0: number; t1: number },
): boolean {
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz
  let t0 = tMin, t1 = tMax
  let n = (m.minx - ox) * ix, f = (m.maxx - ox) * ix
  if (n > f) { const s = n; n = f; f = s }
  if (n > t0) t0 = n
  if (f < t1) t1 = f
  n = (m.miny - oy) * iy; f = (m.maxy - oy) * iy
  if (n > f) { const s = n; n = f; f = s }
  if (n > t0) t0 = n
  if (f < t1) t1 = f
  n = (m.minz - oz) * iz; f = (m.maxz - oz) * iz
  if (n > f) { const s = n; n = f; f = s }
  if (n > t0) t0 = n
  if (f < t1) t1 = f
  if (t0 > t1) return false
  out.t0 = t0; out.t1 = t1
  return true
}

// ── homogeneous (analytic, spectral) distance sampling ───────────────────────────
// Standard spectral path tracing: pick a wavelength (RGB channel) proportional to its
// extinction, sample a free-flight distance along it, then weight by the balance-style
// pdf over all three channels so the estimate stays unbiased and the medium can be
// coloured. `out.scatter` says whether a real collision fell inside the span.
export interface DistanceSample {
  scatter: boolean
  t: number // distance from the span start to the collision (valid iff scatter)
  wr: number; wg: number; wb: number // per-channel throughput multiplier
}

export function sampleHomogeneousDistance(
  sigmaT: Vec3, sigmaS: Vec3, span: number, rng: Rng, out: DistanceSample,
): void {
  const st0 = sigmaT[0], st1 = sigmaT[1], st2 = sigmaT[2]
  const sum = st0 + st1 + st2
  if (sum <= 0) { out.scatter = false; out.wr = 1; out.wg = 1; out.wb = 1; return }
  // channel-selection probabilities q_c ∝ σ_t[c]
  const q0 = st0 / sum, q1 = st1 / sum
  const pick = rng.next()
  const c = pick < q0 ? 0 : pick < q0 + q1 ? 1 : 2
  const stc = sigmaT[c]
  const t = -Math.log(1 - rng.next()) / stc
  // transmittance to t (or to the span end), per channel
  const e0 = Math.exp(-st0 * Math.min(t, span))
  const e1 = Math.exp(-st1 * Math.min(t, span))
  const e2 = Math.exp(-st2 * Math.min(t, span))
  if (t < span) {
    // real collision inside the medium — pdf is the mixture collision density
    const pdf = q0 * st0 * e0 + q1 * st1 * e1 + (1 - q0 - q1) * st2 * e2
    const inv = pdf > 1e-30 ? 1 / pdf : 0
    out.scatter = true
    out.t = t
    out.wr = e0 * sigmaS[0] * inv
    out.wg = e1 * sigmaS[1] * inv
    out.wb = e2 * sigmaS[2] * inv
  } else {
    // escaped the medium — pdf is the mixture survival probability over the span
    const es0 = Math.exp(-st0 * span), es1 = Math.exp(-st1 * span), es2 = Math.exp(-st2 * span)
    const pdf = q0 * es0 + q1 * es1 + (1 - q0 - q1) * es2
    const inv = pdf > 1e-30 ? 1 / pdf : 0
    out.scatter = false
    out.wr = es0 * inv
    out.wg = es1 * inv
    out.wb = es2 * inv
  }
}

// ── heterogeneous tracking (Woodcock) ────────────────────────────────────────────
// Core delta tracking over a parametric span, driven by a density(t) ∈ [0,1] evaluator
// and a constant majorant. Returns the distance of the first real collision, or −1 if
// the ray escapes. Exposed so the self-test can drive it with a constant field.
export function deltaTrackCore(
  sigmaMax: number, density: (t: number) => number, t0: number, t1: number, rng: Rng,
): number {
  const inv = 1 / sigmaMax
  let t = t0
  for (let guard = 0; guard < 10000; guard++) {
    t += -Math.log(1 - rng.next()) * inv
    if (t >= t1) return -1
    if (rng.next() < density(t)) return t // real collision with prob σ_t/σ_max = density
  }
  return -1
}

// Core ratio tracking: an unbiased estimate of exp(−∫_{t0}^{t1} σ_max·density dt) that
// never terminates on a null collision (it multiplies the survival ratio instead).
export function ratioTrackCore(
  sigmaMax: number, density: (t: number) => number, t0: number, t1: number, rng: Rng,
): number {
  const inv = 1 / sigmaMax
  let tr = 1
  let t = t0
  for (let guard = 0; guard < 10000; guard++) {
    t += -Math.log(1 - rng.next()) * inv
    if (t >= t1) break
    tr *= 1 - density(t)
    if (tr < 1e-4) break
  }
  return tr
}

// Delta tracking: returns the distance (from `t0`) of the first *real* collision, or
// −1 if the ray escapes the span. Unbiased: P(escape) = exp(−∫σ_t) exactly.
export function sampleDeltaTracking(
  m: Medium,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  t0: number, t1: number, rng: Rng,
): number {
  const inv = 1 / m.sigmaMax
  let t = t0
  for (let guard = 0; guard < 10000; guard++) {
    t += -Math.log(1 - rng.next()) * inv
    if (t >= t1) return -1
    const d = densityAt(m, ox + dx * t, oy + dy * t, oz + dz * t)
    if (rng.next() < d) return t // real collision with probability σ_t/σ_max = density
  }
  return -1
}

// Ratio tracking: an unbiased, low-variance estimate of the transmittance
// exp(−∫_{t0}^{t1} σ_t ds) through a heterogeneous medium. It never terminates on a
// null collision — it accumulates the survival ratio (1 − density) instead.
export function transmittanceRatioTracking(
  m: Medium,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  t0: number, t1: number, rng: Rng,
): number {
  const inv = 1 / m.sigmaMax
  let tr = 1
  let t = t0
  for (let guard = 0; guard < 10000; guard++) {
    t += -Math.log(1 - rng.next()) * inv
    if (t >= t1) break
    const d = densityAt(m, ox + dx * t, oy + dy * t, oz + dz * t)
    tr *= 1 - d
    if (tr < 1e-4) break // negligible — let it die (slight bias, far below noise floor)
  }
  return tr
}

// Transmittance of a (shadow) ray of length `dist` through the medium, as an RGB
// factor to multiply a light's contribution by. Homogeneous → analytic Beer–Lambert
// over the in-box span; heterogeneous → mono ratio tracking. [1,1,1] if it misses.
const spanTmp = { t0: 0, t1: 0 }
export function mediumTransmittance(
  m: Medium,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  dist: number, rng: Rng,
): Vec3 {
  if (!raySpan(m, ox, oy, oz, dx, dy, dz, 0, dist, spanTmp)) return [1, 1, 1]
  const len = spanTmp.t1 - spanTmp.t0
  if (len <= 0) return [1, 1, 1]
  if (!m.heterogeneous) {
    return [
      Math.exp(-m.sigmaT[0] * len),
      Math.exp(-m.sigmaT[1] * len),
      Math.exp(-m.sigmaT[2] * len),
    ]
  }
  const tr = transmittanceRatioTracking(m, ox, oy, oz, dx, dy, dz, spanTmp.t0, spanTmp.t1, rng)
  return [tr, tr, tr]
}
