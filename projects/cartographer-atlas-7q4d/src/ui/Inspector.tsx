// Click-to-inspect panel. Given the region picked on the map, it reads the engine's
// per-cell fields and presents them in friendly units (metres, °C, %) so the map's
// numbers are legible without a debugger.

import type { ReactElement } from 'react'
import type { WorldMap } from '../core/types'
import { BIOMES } from '../core/biomes'

interface Props {
  world: WorldMap
  region: number
  onClose: () => void
}

function row(label: string, value: string): ReactElement {
  return (
    <div className="insp-row" key={label}>
      <span className="insp-k">{label}</span>
      <span className="insp-v">{value}</span>
    </div>
  )
}

export default function Inspector({ world, region, onClose }: Props): ReactElement | null {
  if (region < 0 || region >= world.mesh.numSolid) return null
  const p = world.params
  const denom = 1 - p.seaLevel || 1
  const elev = world.elevation[region]
  const above = Math.max(0, elev - p.seaLevel) / denom
  const isOcean = world.ocean[region] === 1
  const isLake = world.lake[region] === 1

  // Friendly units.
  const metres = isOcean
    ? -Math.round(((p.seaLevel - elev) / (p.seaLevel || 1)) * 6000)
    : Math.round(above * 4200)
  const celsius = Math.round(world.temperature[region] * 60 - 25)
  const precipPct = Math.round(world.precip[region] * 100)
  const moistPct = Math.round(world.moisture[region] * 100)

  let maxFlux = 1
  for (let r = 0; r < world.mesh.numSolid; r++) if (world.flux[r] > maxFlux) maxFlux = world.flux[r]
  const fluxRel = world.flux[region] / maxFlux
  const riverLabel =
    fluxRel > 0.5 ? 'major river' : fluxRel > 0.15 ? 'river' : fluxRel > 0.04 ? 'stream' : 'trickle'

  const kind = isOcean ? 'Ocean' : isLake ? 'Lake' : world.coast[region] ? 'Coast' : 'Inland'
  const prov = world.province[region]
  const city = prov >= 0 ? world.cities[prov] : null

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="insp-title">Cell #{region}</span>
        <button className="insp-close" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>
      <div className="insp-body">
        {row('Type', kind)}
        {row('Biome', BIOMES[world.biome[region]].name)}
        {row('Elevation', `${metres.toLocaleString()} m`)}
        {!isOcean && row('Temperature', `${celsius}°C`)}
        {!isOcean && row('Precipitation', `${precipPct}%`)}
        {!isOcean && !isLake && row('Moisture', `${moistPct}%`)}
        {!isOcean && !isLake && world.flux[region] > 0 && row('Water', riverLabel)}
        {p.terrainMode === 'tectonic' &&
          world.plateId.length > 0 &&
          row('Plate', `#${world.plateId[region]}${world.plateBoundary[region] ? ' (boundary)' : ''}`)}
        {city && row('Realm', city.realm)}
        {city && row('Seat', `${city.name}${city.capital ? ' ★' : ''}`)}
      </div>
    </div>
  )
}
