import { useEffect, useState } from 'react'
import './App.css'
import type { Params, Preset, ViewId } from './types'
import { DEFAULT_PARAMS, PRESETS } from './state'
import { clamp, clampParams } from './ui/controls-config'
import RenderView from './components/RenderView'
import Controls from './components/Controls'
import GeodesicView from './components/GeodesicView'
import AboutView from './components/AboutView'

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'render', label: 'Render' },
  { id: 'geodesics', label: 'Geodesics' },
  { id: 'about', label: 'Physics' },
]

function readHash(): ViewId {
  const h = window.location.hash.replace(/^#\/?/, '')
  return h === 'geodesics' || h === 'about' ? h : 'render'
}

function useHashView(): ViewId {
  const [view, setView] = useState<ViewId>(readHash)
  useEffect(() => {
    const onHash = () => setView(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return view
}

const wrapAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180

export default function App() {
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS)
  const view = useHashView()

  const change = (patch: Partial<Params>) => setParams((p) => clampParams({ ...p, ...patch }))

  const orbit = (dAz: number, dInc: number) =>
    setParams((p) => ({
      ...p,
      azimuth: wrapAngle(p.azimuth + dAz),
      inclination: clamp(p.inclination + dInc, -89, 89),
    }))

  const dolly = (factor: number) =>
    setParams((p) => ({ ...p, cameraDistance: clamp(p.cameraDistance * factor, 3.5, 60) }))

  const applyPreset = (preset: Preset) => setParams((p) => clampParams({ ...p, ...preset.params }))

  const reset = () => setParams(DEFAULT_PARAMS)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" aria-hidden="true" />
          <div>
            <h1>Event Horizon</h1>
            <p className="brand__sub">a real-time black hole ray tracer</p>
          </div>
        </div>
        <nav className="tabs">
          {VIEWS.map((v) => (
            <a
              key={v.id}
              href={`#/${v.id}`}
              className={view === v.id ? 'tab tab--active' : 'tab'}
              aria-current={view === v.id ? 'page' : undefined}
            >
              {v.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="main">
        {view === 'render' && (
          <div className="render-layout">
            <RenderView params={params} onOrbit={orbit} onDolly={dolly} />
            <aside className="sidebar">
              <Controls params={params} onChange={change} presets={PRESETS} onPreset={applyPreset} onReset={reset} />
            </aside>
          </div>
        )}
        {view === 'geodesics' && <GeodesicView />}
        {view === 'about' && <AboutView />}
      </main>
    </div>
  )
}
