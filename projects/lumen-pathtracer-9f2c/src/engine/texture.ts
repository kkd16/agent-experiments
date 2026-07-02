// texture.ts — procedural, world-space surface textures + bump mapping.
//
// These are evaluated analytically at a hit point's 3D position, so they need no
// UV coordinates, no image decoding, and nothing that breaks the postMessage
// boundary: a `Texture` is a plain serialisable record (a small *tree*, since
// combinators nest children) the workers rebuild for free. The integrator
// resolves a textured material into a flat-coloured one at each vertex (see
// `resolveMaterial`), so the BSDF math never has to know a texture existed.
//
// Two layers sit here:
//
//   • ScalarField — a deterministic ℝ³ → scalar in a bounded range. It is the
//     raw material of every pattern: fractal noise (Perlin gradient fBm, ridged,
//     turbulence), cellular (Worley/Voronoi F1/F2), analytic waves, and a domain
//     *warp* combinator that folds one field's coordinates through another. A
//     scalar field also drives BUMP MAPPING — the surface normal is perturbed by
//     the field's world-space gradient, so a flat quad reads as rippled stone or
//     hammered metal with no extra geometry (see `perturbNormal`).
//
//   • Texture — a colour (Vec3) pattern. The classics (checker / grid / marble)
//     plus wood grain, running-bond brick, cellular Voronoi tiling, a
//     colour-ramp driven by any ScalarField, and two combinators (mix, tint)
//     that make the whole thing a composable tree.
//
// Everything is world-space and analytic, so it costs nothing to reflect,
// refract, or bump — and it is bit-for-bit reproducible across workers.

import type { Vec3 } from './vec3'
import { dot, lerp, normalize, scale, sub, v } from './vec3'

// ===========================================================================
// Noise primitives
// ===========================================================================

// Integer hash → uint32. Three large primes decorrelate the axes; the
// xor-shift-multiply finisher (à la `splitmix`) scrambles the low bits that the
// lattice grid would otherwise leave visibly periodic.
function ihash3(ix: number, iy: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return h >>> 0
}

// Integer hash → float in [0,1).
function hash3(ix: number, iy: number, iz: number): number {
  return ihash3(ix, iy, iz) / 4294967296
}

const fade5 = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10) // quintic (Perlin 2002)
const fade = (t: number): number => t * t * (3 - 2 * t) // smoothstep (value noise)

// ---------------------------------------------------------------------------
// Value noise — a cheap, well-distributed scalar field on ℝ³, in [0,1).
// ---------------------------------------------------------------------------
function valueNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = fade(x - ix)
  const fy = fade(y - iy)
  const fz = fade(z - iz)
  const c000 = hash3(ix, iy, iz)
  const c100 = hash3(ix + 1, iy, iz)
  const c010 = hash3(ix, iy + 1, iz)
  const c110 = hash3(ix + 1, iy + 1, iz)
  const c001 = hash3(ix, iy, iz + 1)
  const c101 = hash3(ix + 1, iy, iz + 1)
  const c011 = hash3(ix, iy + 1, iz + 1)
  const c111 = hash3(ix + 1, iy + 1, iz + 1)
  const x00 = c000 + (c100 - c000) * fx
  const x10 = c010 + (c110 - c010) * fx
  const x01 = c001 + (c101 - c001) * fx
  const x11 = c011 + (c111 - c011) * fx
  const y0 = x00 + (x10 - x00) * fy
  const y1 = x01 + (x11 - x01) * fy
  return y0 + (y1 - y0) * fz
}

// ---------------------------------------------------------------------------
// Perlin gradient noise — the improved 3D noise (Perlin 2002), in ≈[-1,1].
// Gradient noise has no lattice-aligned axis bias the way value noise does, so
// its fBm reads as organic clouds/terrain rather than a blurred grid. Uses the
// 12 edge-of-cube gradient directions selected by the corner hash.
// ---------------------------------------------------------------------------
function gradDot(h: number, x: number, y: number, z: number): number {
  // 12 gradients: the midpoints of a cube's edges. Branch-free selection à la
  // Perlin's reference `grad()`.
  const hh = h & 15
  const u = hh < 8 ? x : y
  const vv = hh < 4 ? y : hh === 12 || hh === 14 ? x : z
  return ((hh & 1) === 0 ? u : -u) + ((hh & 2) === 0 ? vv : -vv)
}

function perlin(x: number, y: number, z: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const u = fade5(fx)
  const w = fade5(fy)
  const t = fade5(fz)
  const g000 = gradDot(ihash3(ix, iy, iz), fx, fy, fz)
  const g100 = gradDot(ihash3(ix + 1, iy, iz), fx - 1, fy, fz)
  const g010 = gradDot(ihash3(ix, iy + 1, iz), fx, fy - 1, fz)
  const g110 = gradDot(ihash3(ix + 1, iy + 1, iz), fx - 1, fy - 1, fz)
  const g001 = gradDot(ihash3(ix, iy, iz + 1), fx, fy, fz - 1)
  const g101 = gradDot(ihash3(ix + 1, iy, iz + 1), fx - 1, fy, fz - 1)
  const g011 = gradDot(ihash3(ix, iy + 1, iz + 1), fx, fy - 1, fz - 1)
  const g111 = gradDot(ihash3(ix + 1, iy + 1, iz + 1), fx - 1, fy - 1, fz - 1)
  const x00 = g000 + (g100 - g000) * u
  const x10 = g010 + (g110 - g010) * u
  const x01 = g001 + (g101 - g001) * u
  const x11 = g011 + (g111 - g011) * u
  const y0 = x00 + (x10 - x00) * w
  const y1 = x01 + (x11 - x01) * w
  // Perlin's raw range is a little inside ±1; the classic ×0.97 normaliser keeps
  // fBm comfortably bounded.
  return (y0 + (y1 - y0) * t) * 0.97
}

// fBm of Perlin gradient noise, remapped to [0,1].
function fbm(x: number, y: number, z: number, octaves: number, lac: number, gain: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * perlin(x * freq, y * freq, z * freq)
    norm += amp
    amp *= gain
    freq *= lac
  }
  return 0.5 + 0.5 * (norm > 0 ? sum / norm : 0)
}

// Ridged fBm: 1−|noise| per octave sharpens the crests into ridgelines
// (mountain silhouettes, cracked-mud veins). Already in [0,1].
function ridged(x: number, y: number, z: number, octaves: number, lac: number, gain: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    const r = 1 - Math.abs(perlin(x * freq, y * freq, z * freq))
    sum += amp * r * r
    norm += amp
    amp *= gain
    freq *= lac
  }
  return norm > 0 ? sum / norm : 0
}

// Turbulence: sum of |value-noise| octaves (the absolute value gives the sharp
// creases that read as stone veins rather than smooth clouds). In [0,1].
function turbulence(x: number, y: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * Math.abs(valueNoise(x * freq, y * freq, z * freq) * 2 - 1)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

// ---------------------------------------------------------------------------
// Worley / Voronoi cellular noise. Each integer lattice cell owns one jittered
// feature point; we scan the 3×3×3 neighbourhood and keep the two nearest
// (F1 ≤ F2), plus the id-hash of the F1 cell so colour patterns can tint each
// tile independently.
// ---------------------------------------------------------------------------
interface WorleyResult {
  f1: number
  f2: number
  cell: number // hash of the winning cell, in [0,1)
}

function worley(x: number, y: number, z: number, jitter: number): WorleyResult {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  let f1 = Infinity
  let f2 = Infinity
  let cell = 0
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx
        const cy = iy + dy
        const cz = iz + dz
        // Three decorrelated hashes place the feature point inside the cell.
        const fx = cx + 0.5 + (hash3(cx, cy, cz) - 0.5) * jitter
        const fy = cy + 0.5 + (hash3(cx + 101, cy + 71, cz + 53) - 0.5) * jitter
        const fz = cz + 0.5 + (hash3(cx + 17, cy + 199, cz + 251) - 0.5) * jitter
        const ex = fx - x
        const ey = fy - y
        const ez = fz - z
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
        if (d < f1) {
          f2 = f1
          f1 = d
          cell = hash3(cx + 7, cy + 13, cz + 29)
        } else if (d < f2) {
          f2 = d
        }
      }
    }
  }
  return { f1, f2, cell }
}

// ===========================================================================
// Scalar fields — ℝ³ → scalar, bounded roughly to [0,1]. The composable layer
// under both colour ramps and bump mapping.
// ===========================================================================

export type ScalarField =
  | { kind: 'const'; value: number }
  // fBm of Perlin gradient noise → smooth clouds / rolling terrain.
  | { kind: 'fbm'; scale: number; octaves: number; lacunarity?: number; gain?: number }
  // Ridged multifractal → sharp crests (mountains, cracked veins).
  | { kind: 'ridged'; scale: number; octaves: number; lacunarity?: number; gain?: number }
  // Absolute-value value-noise turbulence → billowing marble/stone.
  | { kind: 'turbulence'; scale: number; octaves: number }
  // Worley cellular distance: F1 (round pebbles), F2−F1 (cell walls / cracks).
  | { kind: 'cellular'; scale: number; metric?: 'f1' | 'f2' | 'f2f1'; jitter?: number }
  // An analytic sinusoid along an axis or the radial distance from the origin;
  // `warp` (optional) modulates its phase by Perlin noise for a wavy grain.
  | { kind: 'wave'; axis: 'x' | 'y' | 'z' | 'radial'; freq: number; warp?: number }
  // Domain warp: evaluate `field` at coordinates pushed by a Perlin offset of
  // magnitude `amount` at frequency `scale`. The single most effective trick for
  // turning mechanical noise into something that looks hand-made.
  | { kind: 'warp'; field: ScalarField; amount: number; scale: number }

const LAC_DEFAULT = 2.0
const GAIN_DEFAULT = 0.5

export function evalScalar(f: ScalarField, p: Vec3): number {
  switch (f.kind) {
    case 'const':
      return f.value
    case 'fbm': {
      const s = f.scale
      return fbm(p.x * s, p.y * s, p.z * s, f.octaves, f.lacunarity ?? LAC_DEFAULT, f.gain ?? GAIN_DEFAULT)
    }
    case 'ridged': {
      const s = f.scale
      return ridged(p.x * s, p.y * s, p.z * s, f.octaves, f.lacunarity ?? LAC_DEFAULT, f.gain ?? GAIN_DEFAULT)
    }
    case 'turbulence': {
      const s = f.scale
      return turbulence(p.x * s, p.y * s, p.z * s, f.octaves)
    }
    case 'cellular': {
      const s = f.scale
      const r = worley(p.x * s, p.y * s, p.z * s, f.jitter ?? 1)
      const metric = f.metric ?? 'f1'
      // Feature distances are ≲ √3 across a unit cell; clamp the normalised
      // result so ramps see a clean [0,1].
      if (metric === 'f1') return Math.min(1, r.f1)
      if (metric === 'f2') return Math.min(1, r.f2 * 0.5)
      return Math.min(1, (r.f2 - r.f1) * 1.5) // f2f1 — thin bright cell walls
    }
    case 'wave': {
      let phase: number
      if (f.axis === 'radial') phase = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z)
      else phase = f.axis === 'x' ? p.x : f.axis === 'y' ? p.y : p.z
      let t = phase * f.freq
      if (f.warp) t += f.warp * perlin(p.x, p.y, p.z)
      return 0.5 + 0.5 * Math.sin(t * Math.PI * 2)
    }
    case 'warp': {
      const s = f.scale
      const ox = perlin(p.x * s, p.y * s, p.z * s)
      const oy = perlin(p.x * s + 5.2, p.y * s + 1.3, p.z * s + 9.1)
      const oz = perlin(p.x * s + 2.8, p.y * s + 7.7, p.z * s + 3.4)
      const q = v(p.x + ox * f.amount, p.y + oy * f.amount, p.z + oz * f.amount)
      return evalScalar(f.field, q)
    }
  }
}

// ===========================================================================
// Colour ramp — a piecewise-linear map from a scalar in [0,1] to a colour.
// Stops must be sorted by `t`; endpoints clamp.
// ===========================================================================
export interface ColorStop {
  t: number
  color: Vec3
}

export function sampleRamp(stops: ColorStop[], t: number): Vec3 {
  if (stops.length === 0) return v(0, 0, 0)
  if (t <= stops[0].t) return stops[0].color
  const last = stops[stops.length - 1]
  if (t >= last.t) return last.color
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const a = stops[i - 1]
      const b = stops[i]
      const span = b.t - a.t
      const k = span > 1e-9 ? (t - a.t) / span : 0
      return lerp(a.color, b.color, k)
    }
  }
  return last.color
}

// ===========================================================================
// Textures — ℝ³ → colour. A composable tree.
// ===========================================================================

export type Texture =
  | { kind: 'checker'; even: Vec3; odd: Vec3; scale: number }
  | { kind: 'grid'; base: Vec3; line: Vec3; scale: number; width: number }
  | { kind: 'marble'; lo: Vec3; hi: Vec3; scale: number; turbulence: number }
  // Wood grain: concentric rings around an axis, warped by turbulence so the
  // grain wanders like real timber. `rings` = rings per world unit.
  | {
      kind: 'wood'
      lo: Vec3
      hi: Vec3
      scale: number
      rings: number
      turbulence: number
      axis?: 'x' | 'y' | 'z'
    }
  // Running-bond brick in the plane perpendicular to `axis` (default 'y' ⇒ the
  // x–z floor plane). Alternate rows shift by half a brick; mortar lines get the
  // `mortar` colour, faces the `brick` colour with a per-brick tonal jitter.
  | {
      kind: 'brick'
      brick: Vec3
      mortar: Vec3
      scaleU: number
      scaleV: number
      mortarWidth: number
      axis?: 'x' | 'y' | 'z'
    }
  // Voronoi tiling: each cell gets a colour interpolated between `a` and `b` by
  // its id-hash, with darkened seams along the cell walls (F2−F1).
  | { kind: 'voronoi'; a: Vec3; b: Vec3; scale: number; jitter?: number; seam?: number }
  // Colour ramp driven by any scalar field — the universal "map noise to a
  // gradient" texture (rust, rock strata, heat maps, gas giants…).
  | { kind: 'gradient'; field: ScalarField; stops: ColorStop[] }
  // Combinators.
  | { kind: 'mix'; a: Texture; b: Texture; field: ScalarField } // blend a→b by a mask
  | { kind: 'tint'; tex: Texture; factor: Vec3 } // per-channel multiply

// Pick the two in-plane axes for a pattern whose normal is `axis`.
function planeUV(p: Vec3, axis: 'x' | 'y' | 'z'): { u: number; v: number } {
  if (axis === 'x') return { u: p.y, v: p.z }
  if (axis === 'z') return { u: p.x, v: p.y }
  return { u: p.x, v: p.z } // 'y'
}

export function evalTexture(tex: Texture, p: Vec3): Vec3 {
  switch (tex.kind) {
    case 'checker': {
      const s = tex.scale
      const parity = Math.floor(p.x * s) + Math.floor(p.y * s) + Math.floor(p.z * s)
      return (parity & 1) === 0 ? tex.even : tex.odd
    }
    case 'grid': {
      const s = tex.scale
      const w = tex.width
      const fx = Math.abs(((p.x * s) % 1) + (p.x < 0 ? 1 : 0)) % 1
      const fz = Math.abs(((p.z * s) % 1) + (p.z < 0 ? 1 : 0)) % 1
      const onLine = fx < w || fx > 1 - w || fz < w || fz > 1 - w
      return onLine ? tex.line : tex.base
    }
    case 'marble': {
      const s = tex.scale
      const t = turbulence(p.x * s, p.y * s, p.z * s, 5)
      const m = 0.5 + 0.5 * Math.sin((p.x + p.z) * s + tex.turbulence * t * Math.PI * 2)
      return lerp(tex.lo, tex.hi, m)
    }
    case 'wood': {
      const s = tex.scale
      const axis = tex.axis ?? 'y'
      const { u, v: vv } = planeUV(p, axis)
      // Radial distance from the trunk axis, in ring units, plus turbulence.
      const r = Math.sqrt(u * u + vv * vv) * tex.rings
      const tb = turbulence(p.x * s, p.y * s, p.z * s, 4) * tex.turbulence
      const g = r + tb
      const m = 0.5 + 0.5 * Math.sin(g * Math.PI * 2)
      // Sharpen the light early-wood / dark late-wood transition.
      const grain = Math.pow(m, 1.6)
      return lerp(tex.lo, tex.hi, grain)
    }
    case 'brick': {
      const axis = tex.axis ?? 'y'
      const { u, v: vv } = planeUV(p, axis)
      const su = u * tex.scaleU
      const sv = vv * tex.scaleV
      const row = Math.floor(sv)
      // Alternate rows shift half a brick for the running bond.
      const offset = (row & 1) === 0 ? 0 : 0.5
      const cu = su + offset
      const fu = cu - Math.floor(cu)
      const fv = sv - row
      const w = tex.mortarWidth
      const inMortar = fu < w || fu > 1 - w || fv < w || fv > 1 - w
      if (inMortar) return tex.mortar
      // Per-brick tonal jitter so the wall is not a flat slab of colour.
      const jitter = hash3(Math.floor(cu), row, 0) * 0.3 - 0.15
      return v(
        Math.max(0, tex.brick.x * (1 + jitter)),
        Math.max(0, tex.brick.y * (1 + jitter)),
        Math.max(0, tex.brick.z * (1 + jitter)),
      )
    }
    case 'voronoi': {
      const s = tex.scale
      const r = worley(p.x * s, p.y * s, p.z * s, tex.jitter ?? 1)
      let col = lerp(tex.a, tex.b, r.cell)
      const seam = tex.seam ?? 0
      if (seam > 0) {
        // Darken toward the cell walls (small F2−F1 ⇒ near a boundary).
        const edge = Math.min(1, (r.f2 - r.f1) / seam)
        col = scale(col, edge)
      }
      return col
    }
    case 'gradient':
      return sampleRamp(tex.stops, evalScalar(tex.field, p))
    case 'mix': {
      const k = evalScalar(tex.field, p)
      return lerp(evalTexture(tex.a, p), evalTexture(tex.b, p), Math.max(0, Math.min(1, k)))
    }
    case 'tint': {
      const c = evalTexture(tex.tex, p)
      return v(c.x * tex.factor.x, c.y * tex.factor.y, c.z * tex.factor.z)
    }
  }
}

// A representative flat colour for a texture — used only as a denoiser albedo
// guide for textured surfaces so the G-buffer is not left black. (The hot path
// bakes the exact per-vertex albedo via `resolveMaterial`; this is a fallback.)
export function textureMeanColor(tex: Texture): Vec3 {
  const mid = (a: Vec3, b: Vec3): Vec3 => v((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5)
  switch (tex.kind) {
    case 'checker':
      return mid(tex.even, tex.odd)
    case 'grid':
      return tex.base
    case 'marble':
      return mid(tex.lo, tex.hi)
    case 'wood':
      return mid(tex.lo, tex.hi)
    case 'brick':
      return mid(tex.brick, tex.mortar)
    case 'voronoi':
      return mid(tex.a, tex.b)
    case 'gradient':
      return tex.stops.length ? sampleRamp(tex.stops, 0.5) : v(0.5, 0.5, 0.5)
    case 'mix':
      return mid(textureMeanColor(tex.a), textureMeanColor(tex.b))
    case 'tint': {
      const c = textureMeanColor(tex.tex)
      return v(c.x * tex.factor.x, c.y * tex.factor.y, c.z * tex.factor.z)
    }
  }
}

// ===========================================================================
// Bump mapping — perturb a shading normal by a height field's gradient.
// ===========================================================================

// A scalar height field plus how hard it dents the surface. `eps` is the
// finite-difference step (world units) used to estimate the gradient.
export interface BumpField {
  field: ScalarField
  strength: number
  eps?: number
}

// Perturb shading normal `n` at world point `p` by the surface gradient of the
// bump field (Blinn 1978). We estimate ∇h by central differences, project it
// onto the tangent plane (the component along `n` cannot bend the normal), and
// tilt `n` away from the uphill direction. The result is renormalised; the
// caller guards against it dropping below the geometric horizon (which would
// leak light), so this stays a pure, allocation-light helper.
export function perturbNormal(bump: BumpField, p: Vec3, n: Vec3): Vec3 {
  const e = bump.eps ?? 1e-3
  const f = bump.field
  // Central differences: fewer directional artefacts than forward differences.
  const gx = evalScalar(f, v(p.x + e, p.y, p.z)) - evalScalar(f, v(p.x - e, p.y, p.z))
  const gy = evalScalar(f, v(p.x, p.y + e, p.z)) - evalScalar(f, v(p.x, p.y - e, p.z))
  const gz = evalScalar(f, v(p.x, p.y, p.z + e)) - evalScalar(f, v(p.x, p.y, p.z - e))
  const inv = 1 / (2 * e)
  const grad = v(gx * inv, gy * inv, gz * inv)
  // Tangent-plane component of the gradient (surface gradient).
  const gt = sub(grad, scale(n, dot(grad, n)))
  const np = sub(n, scale(gt, bump.strength))
  const out = normalize(np)
  // Guard degenerate cases (flat field ⇒ zero gradient ⇒ NaN-free identity).
  return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) ? out : n
}
