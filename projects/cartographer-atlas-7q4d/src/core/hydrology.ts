// Water. This is where the map stops being noise and starts behaving like a world.
//
// 1. Priority-flood depression filling (Barnes, Lehman & Mulla 2014): every land
//    cell is raised just enough that a strictly-downhill path to the sea exists —
//    no more endorheic pits that would trap rivers.
// 2. A second, *epsilon-free* flood recovers each basin's spill elevation. Where the
//    terrain sits below that level, standing water collects — lakes and inland seas.
// 3. Orographic precipitation (see climate.ts) drives per-cell rainfall.
// 4. Downslope graph: each land cell points at its lowest neighbour.
// 5. Flow accumulation: route rainfall downhill; the accumulated flux is the river.
// 6. Moisture: coast distance + precipitation + river wetness.

import type { Mesh, WorldParams } from './types'
import { Noise2D } from './noise'
import { computePrecipitation } from './climate'

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Binary min-heap keyed by a float priority. Small, allocation-light. */
class MinHeap {
  private prio: number[] = []
  private val: number[] = []

  get size(): number {
    return this.val.length
  }

  push(priority: number, value: number): void {
    this.prio.push(priority)
    this.val.push(value)
    let i = this.val.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.prio[parent] <= this.prio[i]) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): number {
    const top = this.val[0]
    const lastP = this.prio.pop() as number
    const lastV = this.val.pop() as number
    if (this.val.length > 0) {
      this.prio[0] = lastP
      this.val[0] = lastV
      this.siftDown(0)
    }
    return top
  }

  private siftDown(i: number): void {
    const n = this.val.length
    for (;;) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let smallest = i
      if (l < n && this.prio[l] < this.prio[smallest]) smallest = l
      if (r < n && this.prio[r] < this.prio[smallest]) smallest = r
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
  }

  private swap(a: number, b: number): void {
    const p = this.prio[a]
    this.prio[a] = this.prio[b]
    this.prio[b] = p
    const v = this.val[a]
    this.val[a] = this.val[b]
    this.val[b] = v
  }
}

export interface Hydrology {
  ocean: Uint8Array
  coast: Uint8Array
  filled: Float64Array
  waterLevel: Float64Array
  lake: Uint8Array
  downslope: Int32Array
  flux: Float64Array
  precip: Float64Array
  moisture: Float64Array
  rivers: Array<{ a: number; b: number; flux: number }>
}

/** Minimum lake depth (spill − terrain) that counts as standing water. */
const LAKE_DEPTH = 0.004

export function computeHydrology(
  mesh: Mesh,
  params: WorldParams,
  elevation: Float64Array,
  temperature: Float64Array,
): Hydrology {
  const n = mesh.numRegions
  const { seaLevel } = params

  // --- Ocean & coast ---
  const ocean = new Uint8Array(n)
  for (let r = 0; r < n; r++) {
    if (mesh.isFrame[r] || elevation[r] < seaLevel) ocean[r] = 1
  }
  const coast = new Uint8Array(n)
  for (let r = 0; r < mesh.numSolid; r++) {
    if (ocean[r]) continue
    for (const j of mesh.neighbors[r]) {
      if (ocean[j]) {
        coast[r] = 1
        break
      }
    }
  }

  // --- Priority-flood depression filling (epsilon: guarantees drainage) ---
  const filled = Float64Array.from(elevation)
  {
    const visited = new Uint8Array(n)
    const heap = new MinHeap()
    const EPS = 1e-5
    for (let r = 0; r < n; r++) {
      if (ocean[r]) {
        visited[r] = 1
        heap.push(filled[r], r)
      }
    }
    while (heap.size > 0) {
      const c = heap.pop()
      for (const nb of mesh.neighbors[c]) {
        if (visited[nb]) continue
        visited[nb] = 1
        if (filled[nb] <= filled[c]) filled[nb] = filled[c] + EPS
        heap.push(filled[nb], nb)
      }
    }
  }

  // --- Epsilon-free flood → spill surface → lakes ---
  const waterLevel = Float64Array.from(elevation)
  const lake = new Uint8Array(n)
  {
    const visited = new Uint8Array(n)
    const heap = new MinHeap()
    for (let r = 0; r < n; r++) {
      if (ocean[r]) {
        visited[r] = 1
        heap.push(waterLevel[r], r)
      }
    }
    while (heap.size > 0) {
      const c = heap.pop()
      for (const nb of mesh.neighbors[c]) {
        if (visited[nb]) continue
        visited[nb] = 1
        // Spill level: the lowest barrier height the water must clear to escape.
        if (waterLevel[nb] < waterLevel[c]) waterLevel[nb] = waterLevel[c]
        heap.push(waterLevel[nb], nb)
      }
    }
    for (let r = 0; r < mesh.numSolid; r++) {
      if (!ocean[r] && waterLevel[r] - elevation[r] > LAKE_DEPTH) lake[r] = 1
    }
  }

  // --- Orographic precipitation (needs the full water mask: sea + lakes) ---
  const water = new Uint8Array(n)
  for (let r = 0; r < n; r++) water[r] = ocean[r] || lake[r] ? 1 : 0
  const precip = computePrecipitation(mesh, params, elevation, water, temperature)

  // --- Downslope graph (steepest descent on the filled surface) ---
  const downslope = new Int32Array(n).fill(-1)
  for (let r = 0; r < mesh.numSolid; r++) {
    if (ocean[r]) continue
    let best = -1
    let bestH = filled[r]
    for (const j of mesh.neighbors[r]) {
      if (filled[j] < bestH) {
        bestH = filled[j]
        best = j
      }
    }
    downslope[r] = best
  }

  // --- Flow accumulation: rain (scaled by local precip) routed downhill ---
  const flux = new Float64Array(n)
  const land: number[] = []
  for (let r = 0; r < mesh.numSolid; r++) {
    if (!ocean[r]) {
      // Precip-weighted rainfall: wet windward slopes feed far bigger rivers than
      // rain-shadow interiors under the same nominal rainfall setting.
      flux[r] = params.rainfall * (0.35 + 1.5 * precip[r])
      land.push(r)
    }
  }
  land.sort((a, b) => filled[b] - filled[a])
  let maxFlux = 0
  for (const r of land) {
    const d = downslope[r]
    if (d >= 0) flux[d] += flux[r]
    if (flux[r] > maxFlux) maxFlux = flux[r]
  }

  // --- Rivers: land edges whose flux clears the threshold (lakes hide their bed) ---
  const rivers: Array<{ a: number; b: number; flux: number }> = []
  const thr = Math.max(params.rainfall * 2.5, params.riverThreshold * maxFlux)
  for (const r of land) {
    const d = downslope[r]
    if (d < 0) continue
    if (flux[r] >= thr) rivers.push({ a: r, b: d, flux: flux[r] })
  }

  // --- Moisture: coast distance + precipitation + river wetness ---
  const dist = new Int32Array(n).fill(-1)
  let queue: number[] = []
  for (let r = 0; r < n; r++) {
    if (water[r]) {
      dist[r] = 0
      queue.push(r)
    }
  }
  while (queue.length > 0) {
    const nextQ: number[] = []
    for (const c of queue) {
      for (const j of mesh.neighbors[c]) {
        if (dist[j] === -1 && !water[j]) {
          dist[j] = dist[c] + 1
          nextQ.push(j)
        }
      }
    }
    queue = nextQ
  }

  const mNoise = new Noise2D(`${params.seed}:moist`)
  const moisture = new Float64Array(n)
  for (let r = 0; r < mesh.numSolid; r++) {
    if (water[r]) {
      moisture[r] = 1
      continue
    }
    const coastM = Math.exp(-(dist[r] < 0 ? 40 : dist[r]) * 0.1)
    const riverM = maxFlux > 0 ? clamp01(Math.sqrt(flux[r] / maxFlux) * 1.3) : 0
    const nz = mNoise.fbm((mesh.px[r] / params.width) * 3, (mesh.py[r] / params.height) * 3, 3)
    moisture[r] = clamp01(
      coastM * 0.3 + precip[r] * 0.55 + riverM * 0.32 + (nz - 0.5) * 0.16,
    )
  }

  return { ocean, coast, filled, waterLevel, lake, downslope, flux, precip, moisture, rivers }
}
