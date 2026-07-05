import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import type { Params, Preset, ViewId } from './types'
import { DEFAULT_PARAMS, PRESETS } from './state'
import { clamp, clampParams } from './ui/controls-config'
import { decodeParams, encodeParams } from './ui/share'
import RenderView from './components/RenderView'
import Controls from './components/Controls'
import GeodesicView from './components/GeodesicView'
import AboutView from './components/AboutView'

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'render', label: 'Render' },
  { id: 'geodesics', label: 'Geodesics' },
  { id: 'about', label: 'Physics' },
]

function parseHash(): { view: ViewId; query: string } {
  const h = window.location.hash.replace(/^#\/?/, '')
  const [rawView, query = ''] = h.split('?')
  const view: ViewId = rawView === 'geodesics' || rawView === 'about' ? rawView : 'render'
  return { view, query }
}

const wrapAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180

export default function App() {
  const [params, setParams] = useState<Params>(() => {
    const { query } = parseHash()
    return query ? decodeParams(query) : DEFAULT_PARAMS
  })
  const [view, setView] = useState<ViewId>(() => parseHash().view)
  const [copied, setCopied] = useState(false)

  // Mirror the latest params into a ref so debounced/async handlers read the current value.
  const paramsRef = useRef(params)
  useEffect(() => {
    paramsRef.current = params
  }, [params])

  // Reflect state → URL hash, debounced so continuous drags don't spam history.replaceState.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const q = encodeParams(paramsRef.current)
      const hash = `#/${view}${q ? `?${q}` : ''}`
      window.history.replaceState(null, '', hash)
    }, 350)
    return () => window.clearTimeout(id)
  }, [params, view])

  // External hash changes (back/forward, hand-edited URL) → state. Our own replaceState is silent.
  useEffect(() => {
    const onHash = () => {
      const { view: v, query } = parseHash()
      setView(v)
      if (query) setParams(decodeParams(query))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const change = (patch: Partial<Params>) => setParams((p) => clampParams({ ...p, ...patch }))

  const orbit = useCallback(
    (dAz: number, dInc: number) =>
      setParams((p) => ({
        ...p,
        azimuth: wrapAngle(p.azimuth + dAz),
        inclination: clamp(p.inclination + dInc, -89, 89),
      })),
    [],
  )

  const dolly = useCallback(
    (factor: number) => setParams((p) => ({ ...p, cameraDistance: clamp(p.cameraDistance * factor, 3.5, 60) })),
    [],
  )

  const applyPreset = (preset: Preset) => setParams((p) => clampParams({ ...p, ...preset.params }))
  const reset = () => setParams(DEFAULT_PARAMS)

  const share = useCallback(async () => {
    const q = encodeParams(paramsRef.current)
    const url = `${window.location.origin}${window.location.pathname}#/render${q ? `?${q}` : ''}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      window.history.replaceState(null, '', `#/render${q ? `?${q}` : ''}`) // at least update the address bar
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }, [])

  // Keyboard shortcuts (ignored while typing in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= PRESETS.length) {
        applyPreset(PRESETS[n - 1])
        return
      }
      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault()
          change({ autoRotate: !paramsRef.current.autoRotate })
          break
        case 'b':
          change({ bloom: !paramsRef.current.bloom })
          break
        case 'e':
          change({ ergosphere: !paramsRef.current.ergosphere })
          break
        case 'r':
          reset()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
              onClick={(e) => {
                e.preventDefault()
                setView(v.id)
              }}
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
              <Controls
                params={params}
                onChange={change}
                presets={PRESETS}
                onPreset={applyPreset}
                onReset={reset}
                onShare={share}
                shared={copied}
              />
            </aside>
          </div>
        )}
        {view === 'geodesics' && <GeodesicView />}
        {view === 'about' && <AboutView />}
      </main>
    </div>
  )
}
