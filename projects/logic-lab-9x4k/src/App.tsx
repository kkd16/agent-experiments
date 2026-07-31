import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import { Engine } from './logic/engine'
import { makeComp, serialize, deserialize } from './logic/factory'
import type { SavedCircuit } from './logic/factory'
import { bodyHeight, bodyWidth } from './logic/geometry'
import type { Kind } from './logic/kinds'
import { EXAMPLES } from './logic/examples'
import Canvas from './ui/Canvas'
import Palette from './ui/Palette'
import Drawer from './ui/Drawer'
import type { Selection, View } from './ui/types'

const STORAGE_KEY = 'logiclab.save.v1'

export default function App() {
  const [engine] = useState(() => {
    const e = new Engine()
    e.load(EXAMPLES.find((x) => x.id === 'hex-counter')!.build())
    return e
  })

  const [, force] = useState(0)
  const bump = useCallback(() => force((n) => (n + 1) & 0x7fffffff), [])

  const [running, setRunning] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tool, setTool] = useState<Kind | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [view, setView] = useState<View>({ x: 60, y: 40, scale: 1 })
  const [drawer, setDrawer] = useState<'truth' | 'help' | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const flash = useCallback((m: string) => {
    setToast(m)
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 1600)
  }, [])

  // ---- simulation loop ------------------------------------------------------
  useEffect(() => {
    if (!running) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000) * speed
      last = now
      engine.step(dt)
      bump()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, speed, engine, bump])

  // ---- keyboard -------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection?.kind === 'comp') {
          engine.removeComp(selection.id)
          setSelection(null)
          engine.solve()
          bump()
        } else if (selection?.kind === 'wire') {
          engine.removeWire(selection.id)
          setSelection(null)
          engine.solve()
          bump()
        }
      } else if (e.key === ' ') {
        e.preventDefault()
        setRunning((r) => !r)
      } else if (e.key === 'Escape') {
        setTool(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, engine, bump])

  // ---- actions --------------------------------------------------------------
  const onPlace = useCallback(
    (kind: Kind, x: number, y: number) => {
      const c = makeComp(kind, x, y)
      engine.addComp(c)
      engine.solve()
      setSelection({ kind: 'comp', id: c.id })
      bump()
    },
    [engine, bump],
  )

  const loadExample = useCallback(
    (id: string) => {
      const ex = EXAMPLES.find((e) => e.id === id)
      if (!ex) return
      engine.load(ex.build())
      setSelection(null)
      setRunning(false)
      setView({ x: 40, y: 30, scale: 1 })
      bump()
      flash(ex.note)
    },
    [engine, bump, flash],
  )

  const doSave = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(engine.snapshot())))
      flash('Saved to this browser.')
    } catch {
      flash('Save failed (storage blocked).')
    }
  }, [engine, flash])

  const doLoad = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        flash('Nothing saved yet.')
        return
      }
      const data = JSON.parse(raw) as SavedCircuit
      engine.load(deserialize(data))
      setSelection(null)
      setRunning(false)
      bump()
      flash('Loaded your saved circuit.')
    } catch {
      flash('Load failed.')
    }
  }, [engine, bump, flash])

  const doClear = useCallback(() => {
    engine.load({ comps: [], wires: [] })
    setSelection(null)
    setRunning(false)
    bump()
  }, [engine, bump])

  const doReset = useCallback(() => {
    engine.reset()
    bump()
  }, [engine, bump])

  const doStep = useCallback(() => {
    engine.step(0.12)
    bump()
  }, [engine, bump])

  const fit = useCallback(() => {
    const comps = Array.from(engine.comps.values())
    if (comps.length === 0) {
      setView({ x: 60, y: 40, scale: 1 })
      return
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const c of comps) {
      minX = Math.min(minX, c.x)
      minY = Math.min(minY, c.y)
      maxX = Math.max(maxX, c.x + bodyWidth(c.kind))
      maxY = Math.max(maxY, c.y + bodyHeight(c.kind))
    }
    const w = window.innerWidth - 190
    const h = window.innerHeight - 52
    const pad = 60
    const scale = Math.max(
      0.35,
      Math.min(1.6, Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxY - minY || 1))),
    )
    setView({ scale, x: pad - minX * scale, y: pad - minY * scale })
  }, [engine])

  const zoom = useCallback((factor: number) => {
    setView((v) => {
      const ns = Math.max(0.35, Math.min(2.6, v.scale * factor))
      const cx = (window.innerWidth - 190) / 2
      const cy = (window.innerHeight - 52) / 2
      const wx = (cx - v.x) / v.scale
      const wy = (cy - v.y) / v.scale
      return { scale: ns, x: cx - wx * ns, y: cy - wy * ns }
    })
  }, [])

  const count = engine.comps.size

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <b>LogicLab</b>
          <span>digital circuit sandbox</span>
        </div>

        <button className={`btn primary${running ? ' running' : ''}`} onClick={() => setRunning((r) => !r)}>
          {running ? '❚❚ Pause' : '▶ Run'}
        </button>
        <button className="btn" onClick={doStep} disabled={running} title="Advance one step">
          ⏭ Step
        </button>
        <button className="btn" onClick={doReset} title="Clear signal state">
          ↺ Reset
        </button>

        <div className="slider">
          speed
          <input type="range" min={0.25} max={4} step={0.25} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          <b style={{ color: 'var(--ink)' }}>{speed}×</b>
        </div>

        <select
          className="btn"
          value=""
          onChange={(e) => {
            if (e.target.value) loadExample(e.target.value)
          }}
        >
          <option value="">Examples ▾</option>
          {EXAMPLES.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.title}
            </option>
          ))}
        </select>

        <button className="btn" onClick={() => setDrawer((d) => (d === 'truth' ? null : 'truth'))}>
          ⊞ Truth table
        </button>

        <div className="spacer" />

        <span className={`pill${engine.unstable ? ' warn' : ''}`}>
          {engine.unstable ? (
            '⚠ oscillating'
          ) : (
            <>
              <b>{count}</b> parts
            </>
          )}
        </span>

        <button className="btn ghost" onClick={() => zoom(1 / 1.15)} title="Zoom out">
          −
        </button>
        <button className="btn ghost" onClick={fit} title="Fit to view">
          {Math.round(view.scale * 100)}%
        </button>
        <button className="btn ghost" onClick={() => zoom(1.15)} title="Zoom in">
          +
        </button>

        <button className="btn" onClick={doSave} title="Save to this browser">
          Save
        </button>
        <button className="btn" onClick={doLoad} title="Load saved">
          Load
        </button>
        <button className="btn" onClick={doClear} title="Empty the board">
          Clear
        </button>
        <button className="btn ghost" onClick={() => setDrawer((d) => (d === 'help' ? null : 'help'))} title="Help">
          ?
        </button>
      </div>

      <Palette tool={tool} setTool={setTool} />

      <div className="main">
        <Canvas
          engine={engine}
          view={view}
          setView={setView}
          tool={tool}
          onPlace={onPlace}
          selection={selection}
          setSelection={setSelection}
          commit={bump}
        />
        <Drawer tab={drawer} engine={engine} onClose={() => setDrawer(null)} />
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  )
}
