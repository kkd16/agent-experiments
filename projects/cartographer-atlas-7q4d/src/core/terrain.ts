// Turn the bare mesh into a heightfield. Each region's elevation is domain-warped
// fractal noise (organic coastlines) plus a ridged "mountain" term, multiplied by
// a radial island mask so the map reads as land surrounded by sea. A few passes of
// light neighbour-averaging stand in for thermal erosion, softening slopes.

import type { Mesh, WorldParams, WorldShape } from './types'
import { Noise2D } from './noise'

interface ShapeCfg {
  falloff: number
  edgePow: number
  contrast: number
  warp: number
  mountainAmp: number
}

const SHAPES: Record<WorldShape, ShapeCfg> = {
  continent: { falloff: 1.15, edgePow: 1.7, contrast: 1.0, warp: 0.35, mountainAmp: 0.6 },
  pangaea: { falloff: 0.75, edgePow: 2.3, contrast: 0.85, warp: 0.3, mountainAmp: 0.5 },
  archipelago: { falloff: 1.5, edgePow: 1.15, contrast: 1.7, warp: 0.55, mountainAmp: 0.7 },
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Assign a normalised [0,1] elevation to every region (frame regions ⇒ 0). */
export function assignElevation(mesh: Mesh, params: WorldParams): Float64Array {
  const { width, height, octaves, noiseScale, islandFalloff } = params
  const cfg = SHAPES[params.shape]
  const noise = new Noise2D(`${params.seed}:elev`)
  const elev = new Float64Array(mesh.numRegions)

  let lo = Infinity
  let hi = -Infinity
  for (let r = 0; r < mesh.numSolid; r++) {
    const nx = mesh.px[r] / width
    const ny = mesh.py[r] / height
    const u = nx * 2 - 1
    const v = ny * 2 - 1

    // Domain warp so coastlines meander instead of following the noise grid.
    const wx = noise.fbm(nx * noiseScale + 11.3, ny * noiseScale + 7.1, 2)
    const wy = noise.fbm(nx * noiseScale + 31.7, ny * noiseScale + 2.9, 2)
    const fx = nx * noiseScale + (wx - 0.5) * cfg.warp * noiseScale
    const fy = ny * noiseScale + (wy - 0.5) * cfg.warp * noiseScale

    const base = noise.fbm(fx, fy, octaves)
    const mtn = noise.ridged(fx * 1.7 + 5, fy * 1.7 + 5, Math.max(2, octaves - 1))
    let h = base * 0.72 + mtn * mtn * 0.5 * cfg.mountainAmp

    // Radial island mask: 0 at the corners, ~1 in the middle.
    const d = Math.sqrt(u * u + v * v) / Math.SQRT2
    const mask = clamp01(1 - islandFalloff * cfg.falloff * Math.pow(d, cfg.edgePow))
    h = clamp01(h) * mask
    h = Math.pow(h, cfg.contrast)

    elev[r] = h
    if (h < lo) lo = h
    if (h > hi) hi = h
  }

  // Normalise the solid range to [0,1] so the sea-level slider is meaningful.
  const span = hi - lo || 1
  for (let r = 0; r < mesh.numSolid; r++) elev[r] = (elev[r] - lo) / span
  // Frame regions are deep, permanent ocean and drainage sinks.
  for (let r = mesh.numSolid; r < mesh.numRegions; r++) elev[r] = 0

  if (params.erosion > 0) thermalSmooth(mesh, elev, params.erosion)
  return elev
}

/** Light neighbour-averaging: a cheap stand-in for thermal erosion. */
function thermalSmooth(mesh: Mesh, elev: Float64Array, passes: number): void {
  const next = new Float64Array(mesh.numSolid)
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < mesh.numSolid; r++) {
      const nb = mesh.neighbors[r]
      let sum = 0
      let n = 0
      for (const j of nb) {
        sum += elev[j]
        n++
      }
      next[r] = n ? elev[r] * 0.55 + (sum / n) * 0.45 : elev[r]
    }
    for (let r = 0; r < mesh.numSolid; r++) elev[r] = next[r]
  }
}

/**
 * Temperature 0..1: warm near the equatorial band (map mid-height), cold at the
 * poles (top/bottom), with an altitude lapse that chills the highlands.
 */
export function computeTemperature(
  mesh: Mesh,
  params: WorldParams,
  elev: Float64Array,
): Float64Array {
  const temp = new Float64Array(mesh.numRegions)
  for (let r = 0; r < mesh.numRegions; r++) {
    const ny = mesh.py[r] / params.height
    const lat = Math.abs(ny * 2 - 1) // 0 at equator band, 1 at poles
    const above = Math.max(0, elev[r] - params.seaLevel) / (1 - params.seaLevel || 1)
    temp[r] = clamp01(1 - lat * 0.95 - above * 0.5)
  }
  return temp
}
