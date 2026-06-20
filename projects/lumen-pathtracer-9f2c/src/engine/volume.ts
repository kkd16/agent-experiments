// volume.ts — compiles a serialisable `DensityDef` into a `DensityField`: a pure
// `density(point) → [0, 1]` evaluator (plus its constant majorant) that the
// delta-/ratio-tracking estimators in scene.ts probe to trace light through a
// heterogeneous medium. The field is *normalised* to [0, 1]; the medium's
// `sigmaT` is the majorant extinction (the rate at density 1), so the constant
// collision rate null-collision tracking needs is exactly `sigmaT`.
//
// A homogeneous medium (no `density`) never reaches this module — scene.ts keeps
// the analytic Beer–Lambert path for it — so everything here only runs for the
// procedural cloud / smoke / fog media introduced in 9.0.

import type { Vec3 } from './vec3'
import type { MediumDef, DensityDef } from './types'
import { fbm3, valueNoise3, warp3 } from './noise'

export interface DensityField {
  // An upper bound on `density(p)` over all p (= 1, since density is normalised);
  // multiplied by the medium's `sigmaT` it gives the tracking majorant σ̄.
  majorant: number
  // Normalised extinction modulation at a world-space point, in [0, 1].
  density: (p: Vec3) => number
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

// Smoothstep over [edge0, edge1] (handles edge0 > edge1 for a falling ramp).
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

// Build the density evaluator for a heterogeneous medium, or `null` if the
// medium is homogeneous (so the caller keeps the analytic transmittance path).
export function makeDensityField(m: MediumDef): DensityField | null {
  const d = m.density
  if (!d || d.kind === undefined) return null
  const cx = m.center.x
  const cy = m.center.y
  const cz = m.center.z
  const radius = m.radius
  const invR = 1 / radius

  if (d.kind === 'fbm') {
    return makeFbmField(d, cx, cy, cz, radius, invR)
  }
  if (d.kind === 'layer') {
    return makeLayerField(d)
  }
  return null
}

function makeFbmField(
  d: Extract<DensityDef, { kind: 'fbm' }>,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  invR: number,
): DensityField {
  const freq = d.frequency
  const octaves = Math.max(1, d.octaves | 0)
  const lacunarity = d.lacunarity
  const gain = d.gain
  const coverage = clamp01(d.coverage)
  const invKeep = coverage < 1 ? 1 / (1 - coverage) : 0
  const edge = d.edge > 0 ? d.edge : 0
  const verticalBias = d.verticalBias ?? 0
  const warpAmt = d.warp ?? 0
  const seed = d.seed ?? 0
  const yBottom = cy - radius // height datum: the bottom of the medium sphere

  const density = (p: Vec3): number => {
    // Soft spherical envelope: 1 in the interior, fading to 0 over the outer
    // `edge` shell so the cloud has no hard rim at the medium boundary.
    const dx = p.x - cx
    const dy = p.y - cy
    const dz = p.z - cz
    const rNorm = Math.sqrt(dx * dx + dy * dy + dz * dz) * invR
    let env = 1
    if (edge > 0) {
      env = smoothstep(1, 1 - edge, rNorm) // 1 inside, 0 at rNorm=1
      if (env <= 0) return 0
    } else if (rNorm > 1) {
      return 0
    }

    // Domain-warp then evaluate fBm at the requested frequency.
    const w = warp3(p.x * freq, p.y * freq, p.z * freq, warpAmt * freq, seed)
    let val = fbm3(w.x, w.y, w.z, octaves, lacunarity, gain, seed)

    // Coverage threshold: subtract a floor and renormalise so a fraction of
    // space is empty sky between the billows (higher coverage ⇒ sparser).
    val = (val - coverage) * invKeep
    if (val <= 0) return 0

    // Vertical bias: thin the field with height above the medium floor.
    if (verticalBias !== 0) {
      val *= Math.exp(-verticalBias * (p.y - yBottom))
    }
    return clamp01(val * env)
  }
  return { majorant: 1, density }
}

function makeLayerField(d: Extract<DensityDef, { kind: 'layer' }>): DensityField {
  const base = d.base
  const invH = 1 / d.scaleHeight
  const noiseAmount = clamp01(d.noiseAmount ?? 0)
  const freq = d.frequency ?? 0.4
  const seed = d.seed ?? 0

  const density = (p: Vec3): number => {
    // Exponential vertical profile: full density at/below `base`, decaying up.
    let val = p.y <= base ? 1 : Math.exp(-(p.y - base) * invH)
    if (noiseAmount > 0) {
      const n = valueNoise3(p.x * freq, p.y * freq, p.z * freq, seed) // [0,1]
      val *= 1 - noiseAmount * (1 - n)
    }
    return clamp01(val)
  }
  return { majorant: 1, density }
}
