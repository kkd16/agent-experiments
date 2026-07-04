// Overlay shown on top of the map: a compact stats HUD (land coverage, river count,
// generation timings) and a biome legend listing only the biomes actually present.

import { useMemo } from 'react'
import type { ReactElement } from 'react'
import type { WorldMap } from '../core/types'
import { BIOMES } from '../core/biomes'

interface Props {
  world: WorldMap
}

export default function Legend({ world }: Props): ReactElement {
  const stats = useMemo(() => {
    const { mesh, ocean, biome } = world
    let land = 0
    const present = new Set<number>()
    for (let r = 0; r < mesh.numSolid; r++) {
      if (ocean[r]) continue
      land++
      present.add(biome[r])
    }
    const landPct = mesh.numSolid ? (100 * land) / mesh.numSolid : 0
    const total = Object.values(world.timings).reduce((a, b) => a + b, 0)
    return { landPct, present: [...present].sort((a, b) => a - b), total }
  }, [world])

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
        <div className="hud-item">
          <span className="hud-k">cells</span>
          <span className="hud-v">{world.mesh.numSolid.toLocaleString()}</span>
        </div>
        <div className="hud-item">
          <span className="hud-k">gen</span>
          <span className="hud-v">{stats.total.toFixed(0)} ms</span>
        </div>
      </div>
      <div className="legend-biomes">
        {stats.present.map((b) => (
          <div key={b} className="legend-item">
            <span className="swatch" style={{ background: BIOMES[b].color }} />
            {BIOMES[b].name}
          </div>
        ))}
      </div>
    </div>
  )
}
