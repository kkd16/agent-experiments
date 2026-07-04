// The civilisation layer — what turns a terrain map into an *atlas*.
//
// Three stages, all driven by a single "how hard is it to cross this ground" cost:
//   1. Siting: score every habitable cell (harbours, river confluences, arable
//      lowland, fresh water; penalise crags, ice and swamp) and Poisson-pick a set
//      of well-spaced cities.
//   2. Provinces: a multi-source Dijkstra from every city partitions the land into
//      city-state territories — borders naturally settle along ridgelines and rivers
//      because those are the expensive ground to govern across.
//   3. Roads: terrain-aware least-cost paths, knit into a minimum-spanning web so the
//      whole realm is connected without roads climbing over every mountain.

import type { City, Mesh, Road, WorldParams } from './types'
import { B } from './biomes'
import { Rng } from './rng'

/** Binary min-heap of (priority, value). */
class Heap {
  private p: number[] = []
  private v: number[] = []
  get size(): number {
    return this.v.length
  }
  push(priority: number, value: number): void {
    this.p.push(priority)
    this.v.push(value)
    let i = this.v.length - 1
    while (i > 0) {
      const par = (i - 1) >> 1
      if (this.p[par] <= this.p[i]) break
      this.swap(i, par)
      i = par
    }
  }
  pop(): number {
    const top = this.v[0]
    const lp = this.p.pop() as number
    const lv = this.v.pop() as number
    if (this.v.length) {
      this.p[0] = lp
      this.v[0] = lv
      let i = 0
      const n = this.v.length
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let s = i
        if (l < n && this.p[l] < this.p[s]) s = l
        if (r < n && this.p[r] < this.p[s]) s = r
        if (s === i) break
        this.swap(i, s)
        i = s
      }
    }
    return top
  }
  private swap(a: number, b: number): void {
    ;[this.p[a], this.p[b]] = [this.p[b], this.p[a]]
    ;[this.v[a], this.v[b]] = [this.v[b], this.v[a]]
  }
}

export interface Fields {
  elevation: Float64Array
  ocean: Uint8Array
  lake: Uint8Array
  coast: Uint8Array
  flux: Float64Array
  moisture: Float64Array
  temperature: Float64Array
  biome: Uint8Array
}

export interface Political {
  cities: City[]
  province: Int32Array
  roads: Road[]
}

// --- Place-name grammar (kept independent of names.ts so both stay self-contained) ---
const ONSET = ['B', 'Br', 'C', 'D', 'Dr', 'F', 'G', 'Gl', 'H', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'St', 'T', 'Th', 'V', 'W']
const VOW = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'ea', 'ou']
const CODA = ['n', 'r', 'l', 's', 'th', 'ld', 'rk', 'st', 'm', 'nd']
const CITY_SUFFIX = ['ford', 'burg', 'ton', 'holm', 'gate', 'haven', 'mere', 'wick', 'bury', 'stead', 'fell', 'port']
const REALM_FORM = ['%s', 'The %s Marches', 'Kingdom of %s', '%s', 'The %s Dominion', 'Duchy of %s', '%s']

function stem(rng: Rng): string {
  let s = rng.pick(ONSET) + rng.pick(VOW)
  if (rng.next() < 0.6) s += rng.pick(CODA)
  return s
}

function cityName(rng: Rng, coastal: boolean): string {
  const base = stem(rng)
  if (rng.next() < 0.7) {
    const suf = coastal && rng.next() < 0.5 ? rng.pick(['port', 'haven', 'mouth', 'bay']) : rng.pick(CITY_SUFFIX)
    return base.toLowerCase().replace(/^./, (c) => c.toUpperCase()) + suf
  }
  return base + rng.pick(VOW) + rng.pick(CODA)
}

function realmName(rng: Rng): string {
  const nm = stem(rng) + (rng.next() < 0.5 ? rng.pick(VOW) + rng.pick(CODA) : rng.pick(CODA))
  const cap = nm.charAt(0).toUpperCase() + nm.slice(1)
  return rng.pick(REALM_FORM).replace('%s', cap)
}

/** Habitability score for a land cell — higher is a better city site. */
function siteScore(mesh: Mesh, f: Fields, params: WorldParams, r: number, maxFlux: number): number {
  const above = Math.max(0, f.elevation[r] - params.seaLevel) / (1 - params.seaLevel || 1)
  if (above > 0.7) return 0 // no cities on the high peaks
  const b = f.biome[r]
  if (b === B.snow || b === B.bare) return 0

  let s = 0
  // Harbours: coastal sites are prime.
  if (f.coast[r]) s += 0.9
  // Rivers & confluences: fresh water + trade.
  const river = maxFlux > 0 ? Math.sqrt(f.flux[r] / maxFlux) : 0
  s += river * 1.1
  // Lakeside.
  for (const j of mesh.neighbors[r]) if (f.lake[j]) { s += 0.5; break }
  // Arable lowland: gentle, temperate, watered ground.
  const arable = (1 - above) * f.moisture[r] * (0.4 + 0.6 * f.temperature[r])
  s += arable * 0.8
  // Mild climates preferred; deserts and frozen wastes discouraged.
  s -= Math.max(0, 0.25 - f.temperature[r]) * 2
  if (b === B.desert) s -= 0.5
  return s
}

/** Cost of a road/settler step from a to its neighbour b (∞ ⇒ impassable). */
function moveCost(mesh: Mesh, f: Fields, params: WorldParams, a: number, b: number): number {
  if (f.ocean[b] || f.lake[b]) return Infinity
  const dx = mesh.px[b] - mesh.px[a]
  const dy = mesh.py[b] - mesh.py[a]
  const dist = Math.hypot(dx, dy)
  const rugged = Math.abs(f.elevation[b] - f.elevation[a])
  const above = Math.max(0, f.elevation[b] - params.seaLevel) / (1 - params.seaLevel || 1)
  const highland = Math.max(0, above - 0.45)
  let mult = 1 + rugged * 34 + highland * 5
  if (f.biome[b] === B.snow || f.biome[b] === B.bare) mult += 4
  if (f.biome[b] === B.wetland) mult += 1.5
  // Rivers carve valleys travellers follow — a discount for well-watered ground.
  if (f.moisture[b] > 0.6) mult *= 0.9
  return dist * mult
}

export function buildPolitical(mesh: Mesh, f: Fields, params: WorldParams, seed: string): Political {
  const rng = new Rng(`${seed}:polity`)
  const n = mesh.numRegions

  // --- Site scoring ---
  let maxFlux = 0
  for (let r = 0; r < mesh.numSolid; r++) if (f.flux[r] > maxFlux) maxFlux = f.flux[r]
  const candidates: Array<{ r: number; s: number }> = []
  for (let r = 0; r < mesh.numSolid; r++) {
    if (f.ocean[r] || f.lake[r]) continue
    const s = siteScore(mesh, f, params, r, maxFlux)
    if (s > 0.15) candidates.push({ r, s })
  }
  candidates.sort((a, b) => b.s - a.s)

  // --- Poisson pick: greedily take high-scoring sites that are far enough apart ---
  const wantCities = Math.max(0, Math.round(params.cities))
  const minDist = Math.max(28, Math.sqrt((params.width * params.height) / Math.max(1, wantCities)) * 0.62)
  const min2 = minDist * minDist
  const chosen: number[] = []
  for (const c of candidates) {
    if (chosen.length >= wantCities) break
    let ok = true
    for (const q of chosen) {
      const dx = mesh.px[q] - mesh.px[c.r]
      const dy = mesh.py[q] - mesh.py[c.r]
      if (dx * dx + dy * dy < min2) {
        ok = false
        break
      }
    }
    if (ok) chosen.push(c.r)
  }

  const cities: City[] = chosen.map((r) => ({
    r,
    x: mesh.px[r],
    y: mesh.py[r],
    name: cityName(rng, f.coast[r] === 1),
    score: 0,
    tier: 1,
    capital: false,
    realm: realmName(rng),
  }))
  for (let i = 0; i < cities.length; i++) {
    const c = candidates.find((k) => k.r === cities[i].r)
    cities[i].score = c ? c.s : 0
  }

  const province = new Int32Array(n).fill(-1)
  const roads: Road[] = []
  if (cities.length === 0) return { cities, province, roads }

  // --- Provinces: multi-source Dijkstra from every city ---
  {
    const distArr = new Float64Array(n).fill(Infinity)
    const owner = new Int32Array(n).fill(-1)
    const heap = new Heap()
    cities.forEach((c, i) => {
      distArr[c.r] = 0
      owner[c.r] = i
      heap.push(0, c.r)
    })
    while (heap.size) {
      const u = heap.pop()
      const du = distArr[u]
      for (const v of mesh.neighbors[u]) {
        if (v >= mesh.numSolid) continue
        const w = moveCost(mesh, f, params, u, v)
        if (!isFinite(w)) continue
        const nd = du + w
        if (nd < distArr[v]) {
          distArr[v] = nd
          owner[v] = owner[u]
          heap.push(nd, v)
        }
      }
    }
    for (let r = 0; r < mesh.numSolid; r++) if (!f.ocean[r] && !f.lake[r]) province[r] = owner[r]
  }

  // --- Province sizes → capital + population tiers ---
  const size = new Array(cities.length).fill(0)
  for (let r = 0; r < mesh.numSolid; r++) if (province[r] >= 0) size[province[r]]++
  let capital = 0
  for (let i = 1; i < cities.length; i++) if (size[i] > size[capital]) capital = i
  cities[capital].capital = true
  const maxSize = Math.max(1, ...size)
  cities.forEach((c, i) => {
    const t = size[i] / maxSize
    c.tier = c.capital ? 3 : t > 0.55 ? 2 : t > 0.25 ? 1 : 0
  })

  // --- Roads: all-pairs city Dijkstra → MST → reconstruct terrain paths ---
  if (cities.length >= 2) {
    const K = cities.length
    const prevs: Int32Array[] = []
    const cityDist: number[][] = []
    for (let i = 0; i < K; i++) {
      const { dist, prev } = dijkstraFrom(mesh, f, params, cities[i].r, n)
      prevs.push(prev)
      cityDist.push(cities.map((c) => dist[c.r]))
    }
    // Prim's MST over the complete city graph.
    const inTree = new Array(K).fill(false)
    const best = new Array(K).fill(Infinity)
    const from = new Array(K).fill(-1)
    best[0] = 0
    const edges: Array<[number, number]> = []
    for (let it = 0; it < K; it++) {
      let u = -1
      for (let i = 0; i < K; i++) if (!inTree[i] && (u === -1 || best[i] < best[u])) u = i
      if (u === -1) break
      inTree[u] = true
      if (from[u] >= 0) edges.push([from[u], u])
      for (let vtx = 0; vtx < K; vtx++) {
        const d = cityDist[u][vtx]
        if (!inTree[vtx] && isFinite(d) && d < best[vtx]) {
          best[vtx] = d
          from[vtx] = u
        }
      }
    }
    for (const [a, b] of edges) {
      const path = reconstruct(prevs[a], cities[a].r, cities[b].r)
      if (path.length >= 2) {
        const trunk = a === capital || b === capital || cities[a].tier >= 2 || cities[b].tier >= 2
        roads.push({ path, trunk })
      }
    }
  }

  return { cities, province, roads }
}

function dijkstraFrom(
  mesh: Mesh,
  f: Fields,
  params: WorldParams,
  src: number,
  n: number,
): { dist: Float64Array; prev: Int32Array } {
  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const heap = new Heap()
  dist[src] = 0
  heap.push(0, src)
  while (heap.size) {
    const u = heap.pop()
    const du = dist[u]
    for (const v of mesh.neighbors[u]) {
      if (v >= mesh.numSolid) continue
      const w = moveCost(mesh, f, params, u, v)
      if (!isFinite(w)) continue
      const nd = du + w
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        heap.push(nd, v)
      }
    }
  }
  return { dist, prev }
}

function reconstruct(prev: Int32Array, src: number, dst: number): number[] {
  const path: number[] = []
  let c = dst
  let guard = 0
  while (c !== -1 && guard++ < 100000) {
    path.push(c)
    if (c === src) break
    c = prev[c]
  }
  path.reverse()
  return path[0] === src ? path : []
}
