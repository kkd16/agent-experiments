// The pipeline. params → a fully realised WorldMap, with per-stage timings so the
// UI can show where the milliseconds go. Deterministic: same params ⇒ same world.

import type { Plate, WorldMap, WorldParams } from './types'
import { buildMesh } from './mesh'
import { assignElevation, computeTemperature } from './terrain'
import { buildPlates, tectonicElevation } from './tectonics'
import { computeHydrology } from './hydrology'
import { computeContinentality } from './climate'
import { computeCirculation } from './circulation'
import { classifyKoppen } from './koppen'
import { buildPolitical } from './political'
import { traceNamedRivers } from './rivers'
import { buildEconomy } from './economy'
import { simulateHistory } from './simulation'
import { B, classify } from './biomes'
import { generateLabels } from './names'

const now = (): number =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : 0

export function generateWorld(params: WorldParams): WorldMap {
  const timings: Record<string, number> = {}
  const stage = <T>(name: string, fn: () => T): T => {
    const t0 = now()
    const r = fn()
    timings[name] = now() - t0
    return r
  }

  const mesh = stage('mesh', () => buildMesh(params))

  // --- Base heightfield: layered noise, or a plate-tectonic simulation ---
  let plateId: Int32Array = new Int32Array(0)
  let plateBoundary: Uint8Array = new Uint8Array(0)
  let plates: Plate[] = []
  const elevation = stage('terrain', () => {
    if (params.terrainMode === 'tectonic') {
      const tect = buildPlates(mesh, params)
      plateId = tect.plateId
      plateBoundary = tect.boundary
      plates = tect.plates
      return tectonicElevation(mesh, params, tect)
    }
    return assignElevation(mesh, params)
  })

  const temperature = stage('climate', () => computeTemperature(mesh, params, elevation))
  const hydro = stage('hydrology', () => computeHydrology(mesh, params, elevation, temperature))

  const biome = stage('biomes', () => {
    const out = new Uint8Array(mesh.numRegions)
    const denom = 1 - params.seaLevel || 1
    for (let r = 0; r < mesh.numSolid; r++) {
      if (hydro.ocean[r] || hydro.lake[r]) {
        out[r] = B.ocean
        continue
      }
      const above = Math.max(0, elevation[r] - params.seaLevel) / denom
      out[r] = classify(above, hydro.moisture[r], temperature[r], hydro.coast[r] === 1)
    }
    return out
  })

  // --- The Living Planet: coupled atmosphere + ocean circulation ---
  const circulation = stage('circulation', () =>
    computeCirculation(mesh, params, {
      ocean: hydro.ocean,
      lake: hydro.lake,
      coast: hydro.coast,
      temperature,
    }),
  )

  // --- Deep climate: continentality → Köppen–Geiger zones (ocean-moderated on the coasts) ---
  const water = new Uint8Array(mesh.numRegions)
  for (let r = 0; r < mesh.numRegions; r++) water[r] = hydro.ocean[r] || hydro.lake[r] ? 1 : 0
  const continentality = stage('continentality', () => computeContinentality(mesh, water))
  const koppen = stage('koppen', () =>
    classifyKoppen(
      mesh,
      params,
      water,
      temperature,
      hydro.precip,
      continentality,
      circulation.seaTempC,
    ),
  )

  const fields = {
    elevation,
    ocean: hydro.ocean,
    lake: hydro.lake,
    coast: hydro.coast,
    flux: hydro.flux,
    moisture: hydro.moisture,
    temperature,
    biome,
  }

  const political = stage('polity', () => buildPolitical(mesh, fields, params, params.seed))

  // --- Named rivers: trace the great stems and name them ---
  const namedRivers = stage('rivers', () =>
    traceNamedRivers(mesh, params, hydro.downslope, hydro.flux, water, hydro.rivers),
  )
  const riverName = new Int32Array(mesh.numRegions).fill(-1)
  namedRivers.forEach((rv, i) => {
    for (const c of rv.cells) riverName[c] = i
  })

  // --- Economy: resources, provincial wealth, trade weights on the roads ---
  const economy = stage('economy', () =>
    buildEconomy(mesh, params, fields, continentality, political),
  )

  // --- The Ages: a turn-by-turn history simulation, and the emergent chronicle it writes ---
  const history = stage('history', () =>
    simulateHistory(mesh, params, {
      elevation,
      ocean: hydro.ocean,
      lake: hydro.lake,
      coast: hydro.coast,
      flux: hydro.flux,
      moisture: hydro.moisture,
      temperature,
      biome,
      continentality,
      plateBoundary,
      namedRivers,
    }),
  )

  const labels = stage('labels', () =>
    generateLabels(mesh, elevation, hydro.ocean, params.seaLevel, params.seed, hydro.lake),
  )
  // Stamp the great rivers into the label set, styled as waterways.
  const maxRiverLen = namedRivers[0]?.lengthLeagues || 1
  for (const rv of namedRivers.slice(0, 6)) {
    const mid = rv.cells[Math.floor(rv.cells.length / 2)]
    labels.push({
      x: mesh.px[mid],
      y: mesh.py[mid],
      text: rv.name,
      kind: 'river',
      weight: Math.min(1, rv.lengthLeagues / maxRiverLen),
    })
  }

  return {
    params,
    mesh,
    elevation,
    filled: hydro.filled,
    ocean: hydro.ocean,
    coast: hydro.coast,
    downslope: hydro.downslope,
    flux: hydro.flux,
    moisture: hydro.moisture,
    temperature,
    precip: hydro.precip,
    biome,
    rivers: hydro.rivers,
    labels,
    waterLevel: hydro.waterLevel,
    lake: hydro.lake,
    continentality,
    koppen: koppen.koppen,
    tWarm: koppen.tWarm,
    tCold: koppen.tCold,
    precipMm: koppen.precipMm,
    plateId,
    plateBoundary,
    plates,
    cities: political.cities,
    province: political.province,
    roads: economy.roads,
    namedRivers,
    riverName,
    resource: economy.resource,
    provinceInfo: economy.provinceInfo,
    chronicle: history.events,
    era: history.era,
    history,
    circulation,
    timings,
  }
}
