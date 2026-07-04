// The pipeline. params → a fully realised WorldMap, with per-stage timings so the
// UI can show where the milliseconds go. Deterministic: same params ⇒ same world.

import type { Plate, WorldMap, WorldParams } from './types'
import { buildMesh } from './mesh'
import { assignElevation, computeTemperature } from './terrain'
import { buildPlates, tectonicElevation } from './tectonics'
import { computeHydrology } from './hydrology'
import { buildPolitical } from './political'
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

  const political = stage('polity', () =>
    buildPolitical(
      mesh,
      {
        elevation,
        ocean: hydro.ocean,
        lake: hydro.lake,
        coast: hydro.coast,
        flux: hydro.flux,
        moisture: hydro.moisture,
        temperature,
        biome,
      },
      params,
      params.seed,
    ),
  )

  const labels = stage('labels', () =>
    generateLabels(mesh, elevation, hydro.ocean, params.seaLevel, params.seed, hydro.lake),
  )

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
    plateId,
    plateBoundary,
    plates,
    cities: political.cities,
    province: political.province,
    roads: political.roads,
    timings,
  }
}
