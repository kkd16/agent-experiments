import { useCallback, useEffect, useRef, useState } from 'react'
import './styles.css'
import { Engine } from './logic/engine'
import { makeComp, serialize, deserialize, cloneComps } from './logic/factory'
import type { SavedCircuit } from './logic/factory'
import type { Comp, Wire } from './logic/geometry'
import { bodyHeight, bodyWidth } from './logic/geometry'
import type { Kind } from './logic/kinds'
import { EXAMPLES } from './logic/examples'
import { History } from './logic/history'
import { shareUrl, readHashCircuit } from './logic/share'
import Canvas from './ui/Canvas'
import Palette from './ui/Palette'
import Drawer from './ui/Drawer'
import Analyzer from './ui/Analyzer'
import Inspector from './ui/Inspector'
import type { Selection, View } from './ui/types'
import { selectedComps } from './ui/types'

const STORAGE_KEY = 'logiclab.save.v1'

export default function App() {
  const [engine] = useState(() => {
    const e = new Engine()
    const shared = readHashCircuit()
    e.load(shared ? deserialize(shared) : EXAMPLES.find((x) => x.id === 'hex-counter')!.build())
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
  const [analyzerOpen, setAnalyzerOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // ---- undo/redo history + clipboard ----------------------------------------
  const history = useRef(new History())
  const clipboard = useRef<{ comps: Comp[]; wires: Wire[] } | null>(null)
  const pasteN = useRef(0)
  const [histState, setHistState] = useState({ undo: false, redo: false })
  const refreshHistory = useCallback(
    () => setHistState({ undo: history.current.canUndo(), redo: history.current.canRedo() }),
    [],
  )
  const snapJSON = useCallback(() => JSON.stringify(serialize(engine.snapshot())), [engine])
  const beginMutation = useCallback(() => history.current.begin(snapJSON()), [snapJSON])
  const endMutation = useCallback(() => {
    history.current.commit(snapJSON())
    refreshHistory()
  }, [snapJSON, refreshHistory])

  const flash = useCallback((m: string) => {
    setToast(m)
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 1600)
  }, [])

  const restartTrace = useCallback(() => {
    if (analyzerOpen) engine.beginTrace()
  }, [analyzerOpen, engine])

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

  const toggleRun = useCallback(() => {
    setRunning((r) => {
      const next = !r
      if (next && analyzerOpen) engine.beginTrace()
      return next
    })
  }, [analyzerOpen, engine])

  // ---- undo / redo / duplicate / copy / paste -------------------------------
  const applyState = useCallback(
    (json: string | null) => {
      if (json == null) return
      engine.load(deserialize(JSON.parse(json) as SavedCircuit))
      setSelection(null)
      setRunning(false)
      restartTrace()
      refreshHistory()
      bump()
    },
    [engine, restartTrace, refreshHistory, bump],
  )
  const undo = useCallback(() => applyState(history.current.undo(snapJSON())), [applyState, snapJSON])
  const redo = useCallback(() => applyState(history.current.redo(snapJSON())), [applyState, snapJSON])

  const duplicate = useCallback(() => {
    const ids = selectedComps(selection)
    if (!ids.length) return
    beginMutation()
    const { comps, wires } = cloneComps(Array.from(engine.comps.values()), engine.wires, new Set(ids), 40, 40)
    engine.addCluster(comps, wires)
    engine.solve()
    setSelection({ kind: 'comp', ids: comps.map((c) => c.id) })
    endMutation()
    bump()
  }, [engine, selection, beginMutation, endMutation, bump])

  const copy = useCallback(() => {
    const ids = new Set(selectedComps(selection))
    if (!ids.size) return
    const comps = Array.from(engine.comps.values()).filter((c) => ids.has(c.id)).map((c) => ({ ...c, outs: c.outs.slice() }))
    const wires = engine.wires.filter((w) => ids.has(w.from.comp) && ids.has(w.to.comp)).map((w) => ({ ...w }))
    clipboard.current = { comps, wires }
    pasteN.current = 0
    flash(`Copied ${comps.length} part${comps.length > 1 ? 's' : ''}.`)
  }, [engine, selection, flash])

  const paste = useCallback(() => {
    const cb = clipboard.current
    if (!cb || !cb.comps.length) return
    beginMutation()
    pasteN.current += 1
    const off = 30 + pasteN.current * 20
    const ids = new Set(cb.comps.map((c) => c.id))
    const { comps, wires } = cloneComps(cb.comps, cb.wires, ids, off, off)
    engine.addCluster(comps, wires)
    engine.solve()
    setSelection({ kind: 'comp', ids: comps.map((c) => c.id) })
    endMutation()
    bump()
  }, [engine, beginMutation, endMutation, bump])

  const selectAll = useCallback(() => {
    const ids = Array.from(engine.comps.keys())
    setSelection(ids.length ? { kind: 'comp', ids } : null)
  }, [engine])

  const deleteSelection = useCallback(() => {
    if (selection?.kind === 'comp' && selection.ids.length) {
      beginMutation()
      engine.removeComps(selection.ids)
      setSelection(null)
      engine.solve()
      endMutation()
      bump()
    } else if (selection?.kind === 'wire') {
      beginMutation()
      engine.removeWire(selection.id)
      setSelection(null)
      engine.solve()
      endMutation()
      bump()
    }
  }, [selection, engine, beginMutation, endMutation, bump])

  // ---- keyboard -------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
      } else if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        duplicate()
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        copy()
      } else if (mod && (e.key === 'v' || e.key === 'V')) {
        paste()
      } else if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        selectAll()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelection()
      } else if (e.key === ' ') {
        e.preventDefault()
        toggleRun()
      } else if (e.key === 'Escape') {
        setTool(null)
        setSelection(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, duplicate, copy, paste, selectAll, deleteSelection, toggleRun])

  // ---- actions --------------------------------------------------------------
  const onPlace = useCallback(
    (kind: Kind, x: number, y: number) => {
      beginMutation()
      const c = makeComp(kind, x, y)
      engine.addComp(c)
      engine.solve()
      setSelection({ kind: 'comp', ids: [c.id] })
      endMutation()
      bump()
    },
    [engine, bump, beginMutation, endMutation],
  )

  const loadCircuit = useCallback(
    (snap: { comps: Comp[]; wires: Wire[] }, note?: string, resetView = true) => {
      beginMutation()
      engine.load(snap)
      setSelection(null)
      setRunning(false)
      if (resetView) setView({ x: 40, y: 30, scale: 1 })
      restartTrace()
      endMutation()
      bump()
      if (note) flash(note)
    },
    [engine, bump, flash, beginMutation, endMutation, restartTrace],
  )

  const loadExample = useCallback(
    (id: string) => {
      const ex = EXAMPLES.find((e) => e.id === id)
      if (ex) loadCircuit(ex.build(), ex.note)
    },
    [loadCircuit],
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
      loadCircuit(deserialize(data), 'Loaded your saved circuit.', false)
    } catch {
      flash('Load failed.')
    }
  }, [loadCircuit, flash])

  const doShare = useCallback(() => {
    const url = shareUrl(serialize(engine.snapshot()))
    try {
      const hash = url.includes('#') ? '#' + url.split('#')[1] : ''
      window.history.replaceState(null, '', hash || window.location.pathname)
    } catch {
      // ignore — address-bar update is best-effort
    }
    try {
      navigator.clipboard?.writeText(url).then(
        () => flash('Share link copied to clipboard.'),
        () => flash('Share link is in the address bar.'),
      )
    } catch {
      flash('Share link is in the address bar.')
    }
  }, [engine, flash])

  const doClear = useCallback(() => {
    loadCircuit({ comps: [], wires: [] }, undefined, false)
  }, [loadCircuit])

  const doReset = useCallback(() => {
    engine.reset()
    restartTrace()
    bump()
  }, [engine, bump, restartTrace])

  const doStep = useCallback(() => {
    engine.step(0.12)
    bump()
  }, [engine, bump])

  const toggleAnalyzer = useCallback(() => {
    setAnalyzerOpen((o) => {
      const next = !o
      if (next) engine.beginTrace()
      else engine.clearTrace()
      return next
    })
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
  const selCount = selectedComps(selection).length

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <b>LogicLab</b>
          <span>digital circuit sandbox</span>
        </div>

        <button className={`btn primary${running ? ' running' : ''}`} onClick={toggleRun}>
          {running ? '❚❚ Pause' : '▶ Run'}
        </button>
        <button className="btn" onClick={doStep} disabled={running} title="Advance one step">
          ⏭ Step
        </button>
        <button className="btn" onClick={doReset} title="Clear signal state">
          ↺ Reset
        </button>

        <button className="btn" onClick={undo} disabled={!histState.undo} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button className="btn" onClick={redo} disabled={!histState.redo} title="Redo (Ctrl+Shift+Z)">
          ↷
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

        <button className={`btn${drawer === 'truth' ? ' on' : ''}`} onClick={() => setDrawer((d) => (d === 'truth' ? null : 'truth'))}>
          ⊞ Truth table
        </button>
        <button className={`btn${analyzerOpen ? ' on' : ''}`} onClick={toggleAnalyzer} title="Timing diagram / logic analyzer">
          ∿ Analyzer
        </button>

        <div className="spacer" />

        <span className={`pill${engine.unstable ? ' warn' : ''}`}>
          {engine.unstable ? (
            '⚠ oscillating'
          ) : selCount > 1 ? (
            <>
              <b>{selCount}</b> selected
            </>
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

        <button className="btn" onClick={doShare} title="Copy a shareable link to this circuit">
          ↗ Share
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
          beginMutation={beginMutation}
          endMutation={endMutation}
        />
        <Drawer tab={drawer} engine={engine} onClose={() => setDrawer(null)} />
        {selection?.kind === 'comp' && selection.ids.length === 1 && (
          <Inspector
            engine={engine}
            compId={selection.ids[0]}
            commit={bump}
            beginMutation={beginMutation}
            endMutation={endMutation}
            onDelete={deleteSelection}
          />
        )}
        {analyzerOpen && <Analyzer engine={engine} onClose={toggleAnalyzer} onClear={() => { engine.beginTrace(); bump() }} />}
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  )
}
