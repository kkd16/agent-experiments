import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import './App.css'
import { DEFAULT_PARAMS } from './core/presets'
import type { WorldParams } from './core/types'
import { renderWorld } from './render/render'
import { paletteByKey } from './render/palettes'
import { useWorld } from './ui/useWorld'
import { DEFAULT_VIEW } from './ui/viewOptions'
import type { ViewOptions } from './ui/viewOptions'
import Controls from './ui/Controls'
import MapCanvas from './ui/MapCanvas'
import Legend from './ui/Legend'

const STORE_KEY = 'cartographer.state.v1'

// Persistence is best-effort: sandboxed thumbnail frames have no same-origin
// storage, so every access is guarded.
function loadStored(): { params?: Partial<WorldParams>; view?: Partial<ViewOptions> } {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function save(params: WorldParams, view: ViewOptions): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ params, view }))
  } catch {
    /* ignore */
  }
}

export default function App(): ReactElement {
  const [stored] = useState(loadStored)
  const { params, patch, world, generating } = useWorld({
    ...DEFAULT_PARAMS,
    ...stored.params,
  })
  const [view, setView] = useState<ViewOptions>({ ...DEFAULT_VIEW, ...stored.view })

  useEffect(() => {
    save(params, view)
  }, [params, view])

  const onExport = useCallback(() => {
    if (!world) return
    try {
      const scale = 2
      const W = world.params.width
      const H = world.params.height
      const c = document.createElement('canvas')
      c.width = W * scale
      c.height = H * scale
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      renderWorld(ctx, world, {
        palette: paletteByKey(view.paletteKey),
        showRivers: view.showRivers,
        showCoast: view.showCoast,
        showHillshade: view.showHillshade,
        showBorders: view.showBorders,
        showLabels: view.showLabels,
        showGrain: view.showGrain,
      })
      const a = document.createElement('a')
      a.href = c.toDataURL('image/png')
      a.download = `cartographer-${world.params.seed}.png`
      a.click()
    } catch (err) {
      console.error('export failed', err)
    }
  }, [world, view])

  return (
    <div className="app">
      <Controls
        params={params}
        patch={patch}
        view={view}
        setView={setView}
        onExport={onExport}
        generating={generating}
      />
      <main className="stage">
        <MapCanvas world={world} view={view} />
        {world && <Legend world={world} />}
        {!world && generating && <div className="loading">Generating world…</div>}
      </main>
    </div>
  )
}
