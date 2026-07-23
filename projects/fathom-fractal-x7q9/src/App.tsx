import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { useFractalEngine } from './fractal/useFractalEngine'
import ControlPanel from './components/ControlPanel'
import Hud from './components/Hud'
import BookmarkBar from './components/BookmarkBar'

export default function App() {
  const { canvasRef, params, setParam, hud, error, refining, diving, actions } = useFractalEngine()
  const [panelOpen, setPanelOpen] = useState(true)
  const [showHelp, setShowHelp] = useState(true)
  const [wallpaper, setWallpaper] = useState(false)
  const [shareLabel, setShareLabel] = useState('Copy share link')
  const shareTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onShare = useCallback(async () => {
    const ok = await actions.share()
    setShareLabel(ok ? 'Link copied ✓' : 'Link in address bar')
    if (shareTimer.current) clearTimeout(shareTimer.current)
    shareTimer.current = setTimeout(() => setShareLabel('Copy share link'), 2200)
  }, [actions])

  // Wallpaper mode hides every overlay for a clean, framed view. `w` toggles it;
  // Escape leaves it. (Ignored while typing so it never fights a text field.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === 'w' || e.key === 'W') setWallpaper((v) => !v)
      else if (e.key === 'Escape') setWallpaper(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="fractal-canvas" />

      {error && (
        <div className="fallback">
          <h1>Fathom</h1>
          <p>This deep-zoom fractal explorer needs WebGL2, which isn't available here.</p>
          <p className="fallback-detail">{error}</p>
        </div>
      )}

      {!error && !wallpaper && (
        <>
          <div className="top-bar">
            <div className="brand">
              <span className="brand-mark">◎</span>
              <span className="brand-name">Fathom</span>
              <span className="brand-sub">deep-zoom fractal explorer</span>
            </div>
            <div className="top-actions">
              <button className="ghost-btn" onClick={() => setWallpaper(true)} title="Hide all UI (w)">
                Wallpaper
              </button>
              <button className="ghost-btn" onClick={() => setPanelOpen((v) => !v)}>
                {panelOpen ? 'Hide panel' : 'Show panel'}
              </button>
            </div>
          </div>

          <Hud hud={hud} />

          {refining && <div className="refining">refining…</div>}

          <BookmarkBar onPick={actions.applyBookmark} inset={panelOpen} />

          {panelOpen && (
            <ControlPanel
              params={params}
              span={hud.span}
              setParam={setParam}
              onReset={actions.reset}
              onSeedJulia={actions.seedJuliaFromCenter}
              onExport={actions.exportPng}
              onShare={onShare}
              shareLabel={shareLabel}
              onSetMode={actions.setMode}
              onDive={actions.toggleDive}
              diving={diving}
            />
          )}

          {showHelp && (
            <div className="help">
              <button className="help-close" onClick={() => setShowHelp(false)} aria-label="Dismiss">
                ×
              </button>
              <strong>Drag</strong> to pan · <strong>scroll</strong> or <strong>double-click</strong>{' '}
              to zoom · <strong>shift-click</strong> a point to spin up its Julia set · <strong>arrow
              keys</strong> pan, <strong>+/−</strong> zoom · pinch on touch. Past a zoom of ~1e9
              Fathom switches to a <strong>perturbation</strong> engine — a high-precision reference
              orbit computed on the CPU lets the GPU dive past 1e28, far beyond where ordinary float
              renderers dissolve into blocks.
            </div>
          )}
        </>
      )}

      {!error && wallpaper && (
        <button className="wallpaper-exit" onClick={() => setWallpaper(false)}>
          Exit wallpaper (Esc)
        </button>
      )}
    </div>
  )
}
