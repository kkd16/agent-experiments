// Click-to-inspect panel. Given the region picked on the map, it reads the engine's
// per-cell fields and presents them in friendly units (metres, °C, mm, %) so the map's
// numbers are legible without a debugger — now including the Köppen climate zone, the
// seasonal temperature range, the river the cell drains to, and its realm's economy.

import type { ReactElement } from 'react'
import type { HistoryFrame, WorldMap } from '../core/types'
import { BIOMES } from '../core/biomes'
import { KOPPEN, KOPPEN_NONE } from '../core/koppen'
import { RESOURCES } from '../core/economy'

interface Props {
  world: WorldMap
  region: number
  onClose: () => void
  /** When the timeline is open, the frame whose ruling realm to report. */
  frame?: HistoryFrame | null
}

function row(label: string, value: string): ReactElement {
  return (
    <div className="insp-row" key={label}>
      <span className="insp-k">{label}</span>
      <span className="insp-v">{value}</span>
    </div>
  )
}

const RES_NAME: Record<string, string> = {}
RESOURCES.forEach((r) => (RES_NAME[r.key] = r.name))

const COMPASS8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']
/** Compass point a screen-space vector points toward (0°=E, +y=S — the app's convention). */
function vecBearing(u: number, v: number): string {
  const deg = (Math.atan2(v, u) * 180) / Math.PI
  return COMPASS8[Math.round(((deg % 360) + 360) / 45) % 8]
}
function strength(norm: number): string {
  return norm < 0.12 ? 'calm' : norm < 0.4 ? 'light' : norm < 0.7 ? 'moderate' : 'strong'
}

export default function Inspector({ world, region, onClose, frame }: Props): ReactElement | null {
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
  const info = prov >= 0 ? world.provinceInfo[prov] : null

  const kop = world.koppen[region]
  const riverIdx = world.riverName[region]
  const river = riverIdx >= 0 ? world.namedRivers[riverIdx] : null

  // Circulation fields (Session 5).
  const circ = world.circulation
  const wind = `${strength(circ.windSpeed[region])} ${vecBearing(circ.windU[region], circ.windV[region])}`
  const curSpeed = circ.curSpeed[region]
  const current =
    isOcean && curSpeed > 0.02
      ? `${strength(curSpeed)} ${vecBearing(circ.curU[region], circ.curV[region])}`
      : null
  const oceanSst = isOcean && !Number.isNaN(circ.sst[region]) ? circ.sst[region] : null
  const coastSea = !isOcean && !isLake && !Number.isNaN(circ.seaTempC[region]) ? circ.seaTempC[region] : null

  // When the timeline is open, report who ruled this cell in the scrubbed year.
  const agesOwner = frame && !isOcean && !isLake ? frame.owner[region] : -1
  const agesRealm = agesOwner >= 0 ? world.history.realms[agesOwner] : null

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
        {!isOcean && !isLake && kop !== KOPPEN_NONE &&
          row('Climate', `${KOPPEN[kop].code} · ${KOPPEN[kop].name}`)}
        {row('Elevation', `${metres.toLocaleString()} m`)}
        {!isOcean && row('Mean temp', `${celsius}°C`)}
        {!isOcean && !isLake &&
          row('Seasonal', `${Math.round(world.tCold[region])}…${Math.round(world.tWarm[region])}°C`)}
        {!isOcean && row('Rainfall', `${Math.round(world.precipMm[region]).toLocaleString()} mm · ${precipPct}%`)}
        {!isOcean && !isLake && row('Moisture', `${moistPct}%`)}
        {!isOcean && !isLake &&
          row('Continental', `${Math.round(world.continentality[region] * 100)}%`)}
        {river && row('River', `${river.name} (${river.lengthLeagues.toLocaleString()} lg)`)}
        {!isOcean && !isLake && !river && world.flux[region] > 0 && row('Water', riverLabel)}
        {p.terrainMode === 'tectonic' &&
          world.plateId.length > 0 &&
          row('Plate', `#${world.plateId[region]}${world.plateBoundary[region] ? ' (boundary)' : ''}`)}
        <div className="insp-sep" />
        {row('Wind', wind)}
        {current && row('Current', current)}
        {oceanSst != null && row('Sea temp', `${Math.round(oceanSst)}°C`)}
        {coastSea != null && row('Offshore sea', `${Math.round(coastSea)}°C`)}
        {city && <div className="insp-sep" />}
        {city && row('Realm', city.realm)}
        {city && row('Seat', `${city.name}${city.capital ? ' ★' : ''}`)}
        {info && info.population > 0 && row('Realm pop.', `≈ ${info.population.toLocaleString()}`)}
        {info && info.exports.length > 0 &&
          row('Exports', info.exports.map((e) => RES_NAME[e] ?? e).join(', '))}
        {frame && !isOcean && !isLake && <div className="insp-sep" />}
        {frame && !isOcean && !isLake &&
          row(`Ruler · ${frame.year}`, agesRealm ? agesRealm.name : 'Unclaimed wild')}
      </div>
    </div>
  )
}
