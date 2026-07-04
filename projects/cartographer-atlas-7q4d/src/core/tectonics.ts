// Plate tectonics: an alternative to pure fractal noise for the base heightfield.
//
// The idea, boiled down to something that runs in a few milliseconds on a Voronoi
// mesh: scatter a handful of plate seeds, grow every region to its nearest seed
// (so plates are themselves Voronoi cells over the region sites), give each plate a
// drift vector and a crust type, then read elevation off the *boundaries*.
//
//   • Where two plates converge (their relative motion points into the shared
//     border) crust piles up — a mountain arc if both are continental, a coastal
//     cordillera + trench if one subducts. Uplift decays with distance inland.
//   • Where they diverge, crust thins — a rift valley or a mid-ocean spreading ridge.
//   • Continental plates float high (land); oceanic plates sit low (sea floor).
//
// A little fBm is layered on top for texture so the plates don't read as flat slabs.
// Everything is seeded, so a given (seed, plates) pair always yields the same world.

import type { Mesh, Plate, WorldParams } from './types'
import { Rng } from './rng'
import { Noise2D } from './noise'

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export interface Tectonics {
  /** Plate id per region (frame regions included; they take the nearest plate). */
  plateId: Int32Array
  /** 1 if a region borders a region on a different plate. */
  boundary: Uint8Array
  plates: Plate[]
  /** Convergence stress per region: >0 compressive (uplift), <0 tensile (rift). */
  stress: Float64Array
}

/** Assign every region to its nearest plate seed and record plate metadata. */
export function buildPlates(mesh: Mesh, params: WorldParams): Tectonics {
  const rng = new Rng(`${params.seed}:plates`)
  const nPlates = Math.max(2, Math.min(24, Math.round(params.plates)))
  const { width, height } = params

  // --- Seed sites, biased to spread out via a few rejection tries ---
  const plates: Plate[] = []
  for (let i = 0; i < nPlates; i++) {
    let bx = 0
    let by = 0
    let bestD = -1
    // Mitchell's best-candidate: pick the seed farthest from existing seeds.
    for (let cand = 0; cand < 8; cand++) {
      const x = rng.range(0, width)
      const y = rng.range(0, height)
      let nearest = Infinity
      for (const p of plates) {
        const d = (p.sx - x) ** 2 + (p.sy - y) ** 2
        if (d < nearest) nearest = d
      }
      if (nearest > bestD) {
        bestD = nearest
        bx = x
        by = y
      }
    }
    const ang = rng.range(0, Math.PI * 2)
    const speed = rng.range(0.35, 1)
    // Roughly a 45/55 continental/oceanic split reads as land amid sea without
    // drowning the world. The first plate is always continental so there is always
    // a seed continent to grow rivers and cities on.
    const oceanic = i === 0 ? false : rng.next() < 0.5
    plates.push({
      id: i,
      sx: bx,
      sy: by,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      oceanic,
    })
  }

  // --- Nearest-plate assignment (plate = Voronoi cell over the seeds) ---
  const plateId = new Int32Array(mesh.numRegions).fill(-1)
  for (let r = 0; r < mesh.numRegions; r++) {
    let best = 0
    let bestD = Infinity
    const x = mesh.px[r]
    const y = mesh.py[r]
    for (let i = 0; i < nPlates; i++) {
      const p = plates[i]
      const d = (p.sx - x) ** 2 + (p.sy - y) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    plateId[r] = best
  }

  // --- Boundary detection + per-region convergence stress ---
  const boundary = new Uint8Array(mesh.numRegions)
  const stress = new Float64Array(mesh.numRegions)
  for (let r = 0; r < mesh.numSolid; r++) {
    const pa = plateId[r]
    let maxStress = 0
    let onBoundary = false
    for (const j of mesh.neighbors[r]) {
      const pb = plateId[j]
      if (pb === pa) continue
      onBoundary = true
      // Border normal = direction from r to its neighbour on the other plate.
      let nx = mesh.px[j] - mesh.px[r]
      let ny = mesh.py[j] - mesh.py[r]
      const nl = Math.hypot(nx, ny) || 1
      nx /= nl
      ny /= nl
      // Relative velocity of the two plates; project onto the normal. Negative
      // (plates closing) ⇒ convergence ⇒ compressive stress.
      const rvx = plates[pb].vx - plates[pa].vx
      const rvy = plates[pb].vy - plates[pa].vy
      const closing = -(rvx * nx + rvy * ny)
      if (Math.abs(closing) > Math.abs(maxStress)) maxStress = closing
    }
    if (onBoundary) boundary[r] = 1
    stress[r] = maxStress
  }

  return { plateId, boundary, plates, stress }
}

/**
 * Turn plates + boundary stress into a normalised [0,1] elevation field.
 *
 * Base level comes from crust type; boundary stress adds mountain arcs / rifts that
 * decay with graph distance from the boundary; fBm adds texture; the same radial
 * island mask as the noise path keeps the world sea-ringed.
 */
export function tectonicElevation(
  mesh: Mesh,
  params: WorldParams,
  tect: Tectonics,
): Float64Array {
  const { width, height, octaves, noiseScale, islandFalloff } = params
  const n = mesh.numRegions
  const noise = new Noise2D(`${params.seed}:tect`)
  const elev = new Float64Array(n)

  // --- BFS distance (in hops) from the nearest plate boundary ---
  const bdist = new Int32Array(n).fill(-1)
  let q: number[] = []
  for (let r = 0; r < mesh.numSolid; r++) {
    if (tect.boundary[r]) {
      bdist[r] = 0
      q.push(r)
    }
  }
  while (q.length) {
    const nq: number[] = []
    for (const c of q) {
      for (const j of mesh.neighbors[c]) {
        if (j < mesh.numSolid && bdist[j] === -1) {
          bdist[j] = bdist[c] + 1
          nq.push(j)
        }
      }
    }
    q = nq
  }

  let lo = Infinity
  let hi = -Infinity
  for (let r = 0; r < mesh.numSolid; r++) {
    const pid = tect.plateId[r]
    const oceanic = tect.plates[pid]?.oceanic ?? false
    // Base crust height: continents ride high, ocean floor sits low. The gap is
    // wide enough that a mid-range sea level cleanly separates land from sea.
    let h = oceanic ? 0.24 : 0.68

    // Boundary orogeny: uplift/rifting that decays a few cells inland.
    const d = bdist[r] < 0 ? 40 : bdist[r]
    const decay = Math.exp(-d * 0.28)
    const s = tect.stress[r]
    if (s > 0) {
      // Convergent: mountains. Continent–continent collisions build the highest ranges.
      const collide = oceanic ? 0.55 : 1.0
      h += s * decay * 0.85 * collide
    } else {
      // Divergent: rift valleys / spreading centres carve down.
      h += s * decay * 0.45
    }

    // fBm texture so plates aren't flat slabs; ridged term roughens the ranges.
    const nx = mesh.px[r] / width
    const ny = mesh.py[r] / height
    const base = noise.fbm(nx * noiseScale + 4.2, ny * noiseScale + 9.6, octaves)
    const ridge = noise.ridged(nx * noiseScale * 1.6 + 2, ny * noiseScale * 1.6 + 2, Math.max(2, octaves - 1))
    h += (base - 0.5) * 0.28 + ridge * decay * 0.22

    // Radial island mask (same as the noise path) keeps land off the border.
    const u = nx * 2 - 1
    const v = ny * 2 - 1
    const rad = Math.sqrt(u * u + v * v) / Math.SQRT2
    const mask = clamp01(1 - islandFalloff * 0.8 * Math.pow(rad, 1.9))
    h *= 0.35 + 0.65 * mask

    elev[r] = h
    if (h < lo) lo = h
    if (h > hi) hi = h
  }

  const span = hi - lo || 1
  for (let r = 0; r < mesh.numSolid; r++) elev[r] = clamp01((elev[r] - lo) / span)
  for (let r = mesh.numSolid; r < n; r++) elev[r] = 0
  return elev
}
