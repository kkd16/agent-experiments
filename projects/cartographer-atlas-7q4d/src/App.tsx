import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import './App.css'
import { DEFAULT_PARAMS } from './core/presets'
import type { WorldParams } from './core/types'
import { renderWorld } from './render/render'
import { worldToSvg } from './render/svg'
import { paletteByKey } from './render/palettes'
import { useWorld } from './ui/useWorld'
import { DEFAULT_VIEW } from './ui/viewOptions'
import type { ViewOptions } from './ui/viewOptions'
import Controls from './ui/Controls'
import MapCanvas from './ui/MapCanvas'
import Legend from './ui/Legend'
import Inspector from './ui/Inspector'
import Chronicle from './ui/Chronicle'
import Timeline from './ui/Timeline'
import ProofLab from './ui/ProofLab'

const STORE_KEY = 'cartographer.state.v2'

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

function download(href: string, name: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.click()
}

export default function App(): ReactElement {
  const [stored] = useState(loadStored)
  const { params, patch, world, generating } = useWorld({
    ...DEFAULT_PARAMS,
    ...stored.params,
  })
  const [view, setView] = useState<ViewOptions>({ ...DEFAULT_VIEW, ...stored.view })
  const [selected, setSelected] = useState<number | null>(null)
  const [showChronicle, setShowChronicle] = useState(false)
  const [showProofs, setShowProofs] = useState(false)

  // --- The Ages timeline (transient — never persisted, like the cell selection) ---
  const [agesOpen, setAgesOpen] = useState(false)
  const [frameIdx, setFrameIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)

  // A fresh world invalidates the old cell selection and rewinds the timeline to the
  // present age — reset during render (the sanctioned React pattern for deriving state
  // from a changed value).
  const [prevWorld, setPrevWorld] = useState(world)
  if (world !== prevWorld) {
    setPrevWorld(world)
    setSelected(null)
    setPlaying(false)
    setFrameIdx(world ? world.history.frames.length - 1 : 0)
  }

  const frame = agesOpen && world ? world.history.frames[Math.min(frameIdx, world.history.frames.length - 1)] : null

  useEffect(() => {
    save(params, view)
  }, [params, view])

  const onExportPng = useCallback(() => {
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
      // When the timeline is open, capture the scrubbed age; otherwise the present map.
      renderWorld(ctx, world, { palette: paletteByKey(view.paletteKey), view, selected: null, frame })
      const suffix = frame ? `-year-${frame.year}` : ''
      download(c.toDataURL('image/png'), `cartographer-${world.params.seed}${suffix}.png`)
    } catch (err) {
      console.error('PNG export failed', err)
    }
  }, [world, view, frame])

  const onExportSvg = useCallback(() => {
    if (!world) return
    try {
      const svg = worldToSvg(world, view)
      const blob = new Blob([svg], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      download(url, `cartographer-${world.params.seed}.svg`)
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch (err) {
      console.error('SVG export failed', err)
    }
  }, [world, view])

  return (
    <div className="app">
      <Controls
        params={params}
        patch={patch}
        view={view}
        setView={setView}
        onExportPng={onExportPng}
        onExportSvg={onExportSvg}
        generating={generating}
        chronicleOpen={showChronicle}
        onToggleChronicle={() => setShowChronicle((s) => !s)}
        agesOpen={agesOpen}
        onToggleAges={() => setAgesOpen((s) => !s)}
        proofsOpen={showProofs}
        onToggleProofs={() => setShowProofs((s) => !s)}
      />
      <main className="stage">
        <MapCanvas world={world} view={view} selected={selected} onPick={setSelected} frame={frame} />
        {world && !agesOpen && <Legend world={world} view={view} />}
        {world && selected != null && (
          <Inspector
            world={world}
            region={selected}
            frame={frame}
            onClose={() => setSelected(null)}
          />
        )}
        {world && showChronicle && (
          <Chronicle world={world} onClose={() => setShowChronicle(false)} />
        )}
        {showProofs && <ProofLab onClose={() => setShowProofs(false)} />}
        {world && agesOpen && (
          <Timeline
            world={world}
            frameIdx={frameIdx}
            setFrameIdx={setFrameIdx}
            playing={playing}
            setPlaying={setPlaying}
            speed={speed}
            setSpeed={setSpeed}
            onClose={() => {
              setAgesOpen(false)
              setPlaying(false)
            }}
          />
        )}
        {!world && generating && <div className="loading">Generating world…</div>}
      </main>
    </div>
  )
}
