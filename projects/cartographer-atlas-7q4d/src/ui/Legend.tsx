// Overlay shown on top of the map: a compact stats HUD (land coverage, rivers, realms,
// generation time) and a legend that adapts to the active thematic overlay — the biome
// key by default, or the Köppen / resource swatches or a gradient bar for the data maps —
// plus a short roll of the world's greatest rivers.

import { useMemo } from 'react'
import type { ReactElement } from 'react'
import type { WorldMap } from '../core/types'
import { BIOMES } from '../core/biomes'
import type { ViewOptions } from './viewOptions'
import { overlayLegend } from '../render/overlay'

interface Props {
  world: WorldMap
  view: ViewOptions
}

export default function Legend({ world, view }: Props): ReactElement {
  const stats = useMemo(() => {
    const { mesh, ocean, lake, biome } = world
    let land = 0
    let lakeCells = 0
    const present = new Set<number>()
    for (let r = 0; r < mesh.numSolid; r++) {
      if (lake[r]) lakeCells++
      if (ocean[r] || lake[r]) continue
      land++
      present.add(biome[r])
    }
    const landPct = mesh.numSolid ? (100 * land) / mesh.numSolid : 0
    const total = Object.values(world.timings).reduce((a, b) => a + b, 0)
    return { landPct, lakeCells, present: [...present].sort((a, b) => a - b), total }
  }, [world])

  const legend = useMemo(() => overlayLegend(world, view.overlay), [world, view.overlay])
  const topRivers = world.namedRivers.slice(0, 3)

  return (
    <div className="legend">
      <div className="hud">
        <div className="hud-item">
          <span className="hud-k">land</span>
          <span className="hud-v">{stats.landPct.toFixed(0)}%</span>
        </div>
        <div className="hud-item">
          <span className="hud-k">rivers</span>
          <span className="hud-v">{world.rivers.length}</span>
        </div>
        {stats.lakeCells > 0 && (
          <div className="hud-item">
            <span className="hud-k">lakes</span>
            <span className="hud-v">{stats.lakeCells}</span>
          </div>
        )}
        {world.cities.length > 0 && (
          <div className="hud-item">
            <span className="hud-k">realms</span>
            <span className="hud-v">{world.cities.length}</span>
          </div>
        )}
        <div className="hud-item">
          <span className="hud-k">cells</span>
          <span className="hud-v">{world.mesh.numSolid.toLocaleString()}</span>
        </div>
        <div className="hud-item">
          <span className="hud-k">gen</span>
          <span className="hud-v">{stats.total.toFixed(0)} ms</span>
        </div>
      </div>

      {legend ? (
        <div className="legend-overlay">
          <div className="legend-heading">{legend.title}</div>
          {legend.swatches && (
            <div className="legend-swatches">
              {legend.swatches.map((s) => (
                <div key={s.label} className="legend-item">
                  <span className="swatch" style={{ background: s.color }} />
                  {s.label}
                </div>
              ))}
            </div>
          )}
          {legend.gradient && (
            <div className="legend-gradient">
              <div
                className="grad-bar"
                style={{ background: `linear-gradient(90deg, ${legend.gradient.stops.join(',')})` }}
              />
              <div className="grad-ends">
                <span>{legend.gradient.lo}</span>
                <span>{legend.gradient.hi}</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="legend-biomes">
          {stats.present.map((b) => (
            <div key={b} className="legend-item">
              <span className="swatch" style={{ background: BIOMES[b].color }} />
              {BIOMES[b].name}
            </div>
          ))}
        </div>
      )}

      {topRivers.length > 0 && (
        <div className="legend-rivers">
          <div className="legend-heading">Great rivers</div>
          {topRivers.map((r) => (
            <div key={r.name} className="river-row">
              <span className="river-name">{r.name}</span>
              <span className="river-len">{r.lengthLeagues.toLocaleString()} lg</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
