// The economy turns provinces into polities with something to trade. Every land cell has
// a resource potential drawn from its biome and terrain — grain on temperate lowlands, ore
// in the mountains, fish along the coast, furs in the boreal north, wine on warm hills. The
// dominant resource per cell paints a resource map; aggregated per province it yields each
// realm's wealth, a rough population, and a basket of exports. Roads become trade arteries
// weighted by how *complementary* the realms they join are: a grain realm and an ore realm
// trade far more than two identical ones.

import type { City, Mesh, ProvinceInfo, Road, WorldParams } from './types'
import { B } from './biomes'
import type { Fields, Political } from './political'

export interface ResourceInfo {
  key: string
  name: string
  /** Base worth per unit — how much wealth this good contributes. */
  worth: number
  /** Overlay colour. */
  color: string
}

// Order defines the id stored per cell. 255 = none.
export const RESOURCES: readonly ResourceInfo[] = [
  { key: 'grain', name: 'Grain', worth: 1.0, color: '#e8c15a' },
  { key: 'livestock', name: 'Livestock', worth: 1.1, color: '#c98f5a' },
  { key: 'timber', name: 'Timber', worth: 1.0, color: '#4f8a4a' },
  { key: 'fish', name: 'Fish', worth: 1.2, color: '#4aa5c4' },
  { key: 'ore', name: 'Ore & Metal', worth: 2.2, color: '#8a8f9a' },
  { key: 'furs', name: 'Furs', worth: 1.8, color: '#7d6b53' },
  { key: 'wine', name: 'Wine', worth: 2.0, color: '#9c3b63' },
  { key: 'spice', name: 'Spice', worth: 2.8, color: '#d06a2c' },
  { key: 'stone', name: 'Stone', worth: 0.8, color: '#9ca0a6' },
  { key: 'salt', name: 'Salt', worth: 1.6, color: '#dfe3ea' },
]
export const RESOURCE_NONE = 255
const IDX: Record<string, number> = {}
RESOURCES.forEach((r, i) => (IDX[r.key] = i))

export interface Economy {
  resource: Uint8Array
  provinceInfo: ProvinceInfo[]
  roads: Road[]
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Resource potential (0..~1) per good for one land cell. */
function potential(
  mesh: Mesh,
  f: Fields,
  params: WorldParams,
  cont: Float64Array,
  r: number,
  maxFlux: number,
): number[] {
  const above = Math.max(0, f.elevation[r] - params.seaLevel) / (1 - params.seaLevel || 1)
  const temp = f.temperature[r]
  const moist = f.moisture[r]
  const b = f.biome[r]
  const river = maxFlux > 0 ? Math.sqrt(f.flux[r] / maxFlux) : 0
  let lakeAdj = 0
  for (const j of mesh.neighbors[r]) if (f.lake[j]) { lakeAdj = 1; break }

  const p = new Array(RESOURCES.length).fill(0)
  const warm = clamp01((temp - 0.35) / 0.4) // 0 cold .. 1 warm-temperate+
  const gentle = 1 - clamp01(above / 0.6) // lowland factor

  // Fish — coasts and lakeshores.
  p[IDX.fish] = (f.coast[r] ? 0.95 : 0) + lakeAdj * 0.55
  // Grain — the best farmland: gentle, temperate ground with steady (not saturated) water.
  const waterBand = clamp01(1 - Math.abs(moist - 0.5) * 1.7) // peaks at moderate moisture
  p[IDX.grain] =
    gentle * (0.35 + 0.9 * waterBand) * (temp > 0.35 && temp < 0.82 ? 1.25 : 0.25) *
    (b === B.grassland || b === B.deciduous || b === B.savanna || b === B.tropical_sf ? 1.35 : 0.7)
  // Livestock — open grazing on drier or cooler range than cropland.
  p[IDX.livestock] =
    gentle * (0.3 + 0.7 * (1 - moist)) *
    (b === B.grassland || b === B.savanna || b === B.tundra ? 1.0 : 0.5)
  // Timber — forests, the wetter the better.
  p[IDX.timber] =
    (b === B.taiga || b === B.deciduous || b === B.temperate_rf || b === B.tropical_rf || b === B.tropical_sf
      ? 1
      : 0.15) *
    (0.5 + 0.6 * moist)
  // Ore & metal — highlands, ridges, exposed rock.
  p[IDX.ore] = clamp01((above - 0.4) / 0.5) * (b === B.bare || b === B.snow ? 1.25 : 0.85) + (above > 0.7 ? 0.2 : 0)
  // Furs — cold forests and tundra.
  p[IDX.furs] = clamp01(1 - temp * 2.2) * (b === B.taiga || b === B.tundra || b === B.snow ? 1.1 : 0.4)
  // Wine — warm, sunny hills of middling moisture.
  p[IDX.wine] =
    warm * clamp01(1 - Math.abs(above - 0.28) * 3) * clamp01(1 - Math.abs(moist - 0.42) * 2.4) *
    (temp > 0.55 ? 1.1 : 0.5)
  // Spice — hot, wet tropics.
  p[IDX.spice] = clamp01((temp - 0.62) / 0.3) * clamp01((moist - 0.55) / 0.4)
  // Stone — bare uplands.
  p[IDX.stone] = clamp01((above - 0.35) / 0.5) * (b === B.bare ? 1.1 : 0.5)
  // Salt — arid coasts and desert pans.
  p[IDX.salt] = (b === B.desert ? 0.8 : 0) + (f.coast[r] && moist < 0.35 ? 0.5 : 0)

  // River trade access lifts whatever the land already offers.
  const access = 1 + river * 0.4 - cont[r] * 0.15
  for (let i = 0; i < p.length; i++) p[i] = Math.max(0, p[i] * access)
  return p
}

export function buildEconomy(
  mesh: Mesh,
  params: WorldParams,
  f: Fields,
  cont: Float64Array,
  political: Political,
): Economy {
  const n = mesh.numSolid
  let maxFlux = 0
  for (let r = 0; r < n; r++) if (f.flux[r] > maxFlux) maxFlux = f.flux[r]

  const resource = new Uint8Array(mesh.numRegions).fill(RESOURCE_NONE)
  const cities = political.cities
  const K = cities.length
  const provWealth = new Float64Array(K)
  const provArea = new Int32Array(K)
  const provGoods: Float64Array[] = Array.from({ length: K }, () => new Float64Array(RESOURCES.length))

  for (let r = 0; r < n; r++) {
    if (f.ocean[r] || f.lake[r]) continue
    const p = potential(mesh, f, params, cont, r, maxFlux)
    // Dominant resource for the overlay.
    let best = -1
    let bestV = 0.12 // floor: below this a cell has no notable export
    for (let i = 0; i < p.length; i++) {
      if (p[i] > bestV) {
        bestV = p[i]
        best = i
      }
    }
    if (best >= 0) resource[r] = best

    const owner = political.province[r]
    if (owner >= 0) {
      provArea[owner]++
      let cellWealth = 0
      for (let i = 0; i < p.length; i++) {
        const contrib = p[i] * RESOURCES[i].worth
        provGoods[owner][i] += contrib
        cellWealth += contrib
      }
      provWealth[owner] += cellWealth
    }
  }

  // Province summaries.
  let maxScore = 1
  const score = new Float64Array(K)
  let maxArea = 1
  for (let i = 0; i < K; i++) if (provArea[i] > maxArea) maxArea = provArea[i]
  let maxWealth = 1
  for (let i = 0; i < K; i++) if (provWealth[i] > maxWealth) maxWealth = provWealth[i]

  const provinceInfo: ProvinceInfo[] = []
  for (let i = 0; i < K; i++) {
    const goods = provGoods[i]
    const order = [...goods.keys()].sort((a, b) => goods[b] - goods[a])
    const exports = order.filter((k) => goods[k] > 0.5).slice(0, 3).map((k) => RESOURCES[k].key)
    // Population scales with wealth (food + trade) and a base per settled cell.
    const population = Math.round(provArea[i] * 220 + provWealth[i] * 950)
    provinceInfo.push({ id: i, area: provArea[i], wealth: provWealth[i], population, exports })
    // A blend of size and prosperity decides how big the city reads.
    score[i] = 0.5 * (provArea[i] / maxArea) + 0.5 * (provWealth[i] / maxWealth)
    if (score[i] > maxScore) maxScore = score[i]
  }

  // Re-tier cities from the blended score; capitals always read largest.
  cities.forEach((c: City, i: number) => {
    const t = maxScore > 0 ? score[i] / maxScore : 0
    c.tier = c.capital ? 3 : t > 0.62 ? 2 : t > 0.3 ? 1 : 0
    c.population = Math.round((provinceInfo[i]?.population ?? 0) * (c.capital ? 0.16 : 0.1)) + 1200
  })

  // Trade weight per road: complementary + wealthy neighbours trade hardest.
  const roads = political.roads
  for (const rd of roads) {
    const a = political.province[rd.path[0]]
    const b = political.province[rd.path[rd.path.length - 1]]
    if (a < 0 || b < 0 || a === b) {
      rd.trade = 0.15
      continue
    }
    const ga = provGoods[a]
    const gb = provGoods[b]
    // Cosine-style similarity of the two export baskets → complementarity = 1 − sim.
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < RESOURCES.length; i++) {
      dot += ga[i] * gb[i]
      na += ga[i] * ga[i]
      nb += gb[i] * gb[i]
    }
    const sim = na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 1
    const complement = 1 - sim
    const wealthFactor = clamp01((provWealth[a] + provWealth[b]) / (2 * maxWealth))
    rd.trade = clamp01(0.2 + complement * 0.7 + wealthFactor * 0.3)
  }

  return { resource, provinceInfo, roads }
}
