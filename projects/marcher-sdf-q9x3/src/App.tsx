import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import type { Scene } from './scene/types'
import { PRESETS, defaultScene } from './scene/presets'
import { reducer } from './state/reducer'
import { clearPersisted, cloneScene, initState, persist } from './state/store'
import { useRenderer } from './hooks/useRenderer'
import { buildStandaloneHtml } from './export/standalone'
import { downloadDataUrl, downloadText } from './export/download'
import Toolbar from './components/Toolbar'
import Canvas from './components/Canvas'
import SceneTree from './components/SceneTree'
import Inspector from './components/Inspector'
import GlobalPanel from './components/GlobalPanel'
import GlslViewer from './components/GlslViewer'
import HelpOverlay from './components/HelpOverlay'

type RightTab = 'node' | 'world'
type Overlay = 'none' | 'glsl' | 'help'

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initState)
  const { scene, selectedId } = state
  const { canvasRef, fps, error, getGlsl, capturePng } = useRenderer(scene)

  const [tab, setTab] = useState<RightTab>('node')
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [glsl, setGlsl] = useState('')
  const [saved, setSaved] = useState(true)

  const selectedNode = useMemo(
    () => scene.nodes.find((n) => n.id === selectedId) ?? null,
    [scene.nodes, selectedId],
  )
  const isBase = selectedNode ? scene.nodes[0]?.id === selectedNode.id : false

  // Autosave (debounced) to localStorage.
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    setSaved(false)
    const t = window.setTimeout(() => {
      persist(scene)
      setSaved(true)
    }, 400)
    return () => window.clearTimeout(t)
  }, [scene])

  const loadPreset = useCallback((build: () => Scene) => {
    dispatch({ type: 'loadScene', scene: cloneScene(build()) })
  }, [])

  const reset = useCallback(() => {
    clearPersisted()
    dispatch({ type: 'loadScene', scene: defaultScene() })
  }, [])

  const showGlsl = useCallback(() => {
    setGlsl(getGlsl())
    setOverlay('glsl')
  }, [getGlsl])

  const exportHtml = useCallback(() => {
    downloadText(buildStandaloneHtml(scene), 'marcher-scene.html')
  }, [scene])

  const capture = useCallback(() => {
    downloadDataUrl(capturePng(), 'marcher.png')
  }, [capturePng])

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'a') dispatch({ type: 'add', kind: 'sphere' })
      else if (k === 'd' && selectedId) dispatch({ type: 'duplicate', id: selectedId })
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId)
        dispatch({ type: 'delete', id: selectedId })
      else if (k === 'r')
        dispatch({ type: 'patchCamera', patch: { autoRotate: !scene.camera.autoRotate } })
      else if (k === 'g') showGlsl()
      else if (k === 'p') capture()
      else if (k === 'e') exportHtml()
      else if (k === '?' || (k === '/' && e.shiftKey)) setOverlay('help')
      else if (k >= '1' && k <= '9') {
        const idx = Number(k) - 1
        if (PRESETS[idx]) loadPreset(PRESETS[idx].build)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, scene.camera.autoRotate, showGlsl, loadPreset, capture, exportHtml])

  return (
    <div className="app">
      <Toolbar
        onLoadPreset={loadPreset}
        onReset={reset}
        onShowGlsl={showGlsl}
        onShowHelp={() => setOverlay('help')}
        onExport={exportHtml}
        onCapture={capture}
        saved={saved}
      />

      <div className="workspace">
        <aside className="col left">
          <SceneTree nodes={scene.nodes} selectedId={selectedId} dispatch={dispatch} />
        </aside>

        <main className="col center">
          <Canvas
            canvasRef={canvasRef}
            camera={scene.camera}
            fps={fps}
            error={error}
            dispatch={dispatch}
          />
        </main>

        <aside className="col right">
          <div className="tabs">
            <button type="button" className={tab === 'node' ? 'active' : ''} onClick={() => setTab('node')}>
              Node
            </button>
            <button type="button" className={tab === 'world' ? 'active' : ''} onClick={() => setTab('world')}>
              World
            </button>
          </div>
          <div className="tab-body">
            {tab === 'node' ? (
              <Inspector node={selectedNode} isBase={isBase} dispatch={dispatch} />
            ) : (
              <GlobalPanel scene={scene} dispatch={dispatch} />
            )}
          </div>
        </aside>
      </div>

      {overlay === 'glsl' ? <GlslViewer glsl={glsl} onClose={() => setOverlay('none')} /> : null}
      {overlay === 'help' ? <HelpOverlay onClose={() => setOverlay('none')} /> : null}
    </div>
  )
}
