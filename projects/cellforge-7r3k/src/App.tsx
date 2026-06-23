import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import './App.css'
import { Workbook } from './engine/workbook'
import type { Coord, RangeBox } from './engine/address'
import { boxOf, coordToA1, parseRef } from './engine/address'
import { offsetFormula } from './engine/rewrite'
import { isError } from './engine/values'
import { DEMOS, demoToCells } from './data'
import { toCSV, parseDelimited, gridToEntries, selectionToTSV } from './csv'
import Grid from './components/Grid'
import Toolbar from './components/Toolbar'
import Inspector from './components/Inspector'
import SelfTestPanel from './components/SelfTestPanel'

const STORAGE_KEY = 'cellforge.workbook.v1'
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

interface ClipData {
  box: RangeBox
  raws: string[][]
}

export default function App() {
  // The Workbook is a mutable model; `version` is bumped to force re-renders after
  // a mutation. It lives in state (not a ref) so reads during render are legitimate.
  const [wb] = useState(() => {
    const book = new Workbook()
    let loaded = false
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        book.loadJSON(JSON.parse(saved))
        loaded = true
      }
    } catch {
      /* sandboxed preview — fall through to the demo */
    }
    if (!loaded) book.loadJSON({ cells: demoToCells(DEMOS[0]) })
    return book
  })

  const [version, setVersion] = useState(0)
  const [active, setActive] = useState<Coord>({ row: 0, col: 0 })
  const [anchor, setAnchor] = useState<Coord>({ row: 0, col: 0 })
  const [editing, setEditing] = useState<string | null>(null)
  const [editFocus, setEditFocus] = useState<'grid' | 'bar'>('grid')
  const [heatmap, setHeatmap] = useState<RangeBox | null>(null)
  const [nameBox, setNameBox] = useState('')

  const containerRef = useRef<HTMLDivElement | null>(null)
  const clipRef = useRef<ClipData | null>(null)

  const selection = useMemo(() => boxOf(anchor, active), [anchor, active])

  // Focus the grid on mount so keyboard navigation works without a first click.
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const persist = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wb.toJSON()))
    } catch {
      /* ignore in sandbox */
    }
  }
  const bump = () => {
    persist()
    setVersion((v) => v + 1)
  }
  const refocus = () => requestAnimationFrame(() => containerRef.current?.focus())

  // ---- editing ----
  const commit = (dir: 'down' | 'right') => {
    if (editing === null) return
    wb.setCell(active, editing)
    setEditing(null)
    setEditFocus('grid')
    const na: Coord =
      dir === 'down'
        ? { row: clamp(active.row + 1, 0, wb.rows - 1), col: active.col }
        : { row: active.row, col: clamp(active.col + 1, 0, wb.cols - 1) }
    setActive(na)
    setAnchor(na)
    bump()
    refocus()
  }

  const cancel = () => {
    setEditing(null)
    setEditFocus('grid')
    refocus()
  }

  const flushEdit = () => {
    if (editing !== null) {
      wb.setCell(active, editing)
      setEditing(null)
      setEditFocus('grid')
      bump()
    }
  }

  const editStart = (coord: Coord) => {
    flushEdit()
    setActive(coord)
    setAnchor(coord)
    setEditing(wb.getRaw(coord))
    setEditFocus('grid')
  }

  // ---- selection / navigation ----
  const selectCell = (coord: Coord, extend: boolean) => {
    flushEdit()
    setActive(coord)
    if (!extend) setAnchor(coord)
  }
  const extendTo = (coord: Coord) => setActive(coord)

  const move = (dRow: number, dCol: number, extend: boolean) => {
    const na = {
      row: clamp(active.row + dRow, 0, wb.rows - 1),
      col: clamp(active.col + dCol, 0, wb.cols - 1),
    }
    setActive(na)
    if (!extend) setAnchor(na)
  }

  // ---- bulk operations ----
  const clearSelection = () => {
    const entries: Array<{ coord: Coord; raw: string }> = []
    for (let r = selection.top; r <= selection.bottom; r++)
      for (let c = selection.left; c <= selection.right; c++) entries.push({ coord: { row: r, col: c }, raw: '' })
    wb.setMany(entries)
    bump()
  }

  const fill = (axis: 'down' | 'right') => {
    const entries: Array<{ coord: Coord; raw: string }> = []
    if (axis === 'down') {
      for (let c = selection.left; c <= selection.right; c++) {
        const src = wb.getRaw({ row: selection.top, col: c })
        for (let r = selection.top + 1; r <= selection.bottom; r++)
          entries.push({ coord: { row: r, col: c }, raw: offsetFormula(src, r - selection.top, 0) })
      }
    } else {
      for (let r = selection.top; r <= selection.bottom; r++) {
        const src = wb.getRaw({ row: r, col: selection.left })
        for (let c = selection.left + 1; c <= selection.right; c++)
          entries.push({ coord: { row: r, col: c }, raw: offsetFormula(src, 0, c - selection.left) })
      }
    }
    if (entries.length) {
      wb.setMany(entries)
      bump()
    }
  }

  const copySelection = () => {
    const raws: string[][] = []
    for (let r = selection.top; r <= selection.bottom; r++) {
      const row: string[] = []
      for (let c = selection.left; c <= selection.right; c++) row.push(wb.getRaw({ row: r, col: c }))
      raws.push(row)
    }
    clipRef.current = { box: selection, raws }
    try {
      void navigator.clipboard?.writeText(
        selectionToTSV(wb, selection.top, selection.left, selection.bottom, selection.right),
      )
    } catch {
      /* clipboard blocked in sandbox */
    }
  }

  const pasteInternal = (clip: ClipData) => {
    const dRow = active.row - clip.box.top
    const dCol = active.col - clip.box.left
    const entries: Array<{ coord: Coord; raw: string }> = []
    for (let i = 0; i < clip.raws.length; i++) {
      for (let j = 0; j < clip.raws[i].length; j++) {
        const r = clip.box.top + i + dRow
        const c = clip.box.left + j + dCol
        if (r < 0 || c < 0 || r >= wb.rows || c >= wb.cols) continue
        entries.push({ coord: { row: r, col: c }, raw: offsetFormula(clip.raws[i][j], dRow, dCol) })
      }
    }
    wb.setMany(entries)
    bump()
  }

  const pasteTextAt = (text: string, origin: Coord) => {
    const grid = parseDelimited(text, text.includes('\t') ? '\t' : ',')
    wb.setMany(gridToEntries(grid, origin))
    bump()
  }

  const paste = () => {
    if (clipRef.current) {
      pasteInternal(clipRef.current)
      return
    }
    try {
      navigator.clipboard
        ?.readText()
        .then((t) => t && pasteTextAt(t, active))
        .catch(() => {})
    } catch {
      /* ignore */
    }
  }

  const selectAll = () => {
    setAnchor({ row: 0, col: 0 })
    setActive({ row: wb.rows - 1, col: wb.cols - 1 })
  }

  // ---- keyboard ----
  const onContainerKeyDown = (e: ReactKeyboardEvent) => {
    if (editing !== null) return
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      const handlers: Record<string, () => void> = {
        c: copySelection,
        v: paste,
        d: () => fill('down'),
        r: () => fill('right'),
        a: selectAll,
        home: () => {
          setActive({ row: 0, col: 0 })
          setAnchor({ row: 0, col: 0 })
        },
      }
      if (handlers[k]) {
        handlers[k]()
        e.preventDefault()
      }
      return
    }

    switch (e.key) {
      case 'ArrowUp':
        move(-1, 0, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowDown':
        move(1, 0, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowLeft':
        move(0, -1, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowRight':
        move(0, 1, e.shiftKey)
        e.preventDefault()
        break
      case 'Tab':
        move(0, e.shiftKey ? -1 : 1, false)
        e.preventDefault()
        break
      case 'Enter':
      case 'F2':
        editStart(active)
        e.preventDefault()
        break
      case 'Home':
        move(0, -active.col, e.shiftKey)
        e.preventDefault()
        break
      case 'Delete':
      case 'Backspace':
        clearSelection()
        e.preventDefault()
        break
      default:
        if (e.key.length === 1 && !e.altKey) {
          setEditing(e.key)
          setEditFocus('grid')
          e.preventDefault()
        }
    }
  }

  // ---- toolbar actions ----
  const loadDemo = (id: string) => {
    const demo = DEMOS.find((d) => d.id === id)
    if (!demo) return
    wb.loadJSON({ cells: demoToCells(demo) })
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
    setEditing(null)
    setHeatmap(null)
    bump()
    refocus()
  }
  const clearAll = () => {
    wb.clear()
    setHeatmap(null)
    bump()
  }
  const exportCSV = () => {
    const csv = toCSV(wb)
    try {
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'cellforge.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* sandbox: ignore */
    }
  }
  const importCSV = (text: string) => {
    wb.clear()
    pasteTextAt(text, { row: 0, col: 0 })
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
  }
  const toggleHeat = () => setHeatmap((h) => (h ? null : selection))

  const gotoName = () => {
    const ref = parseRef(nameBox.trim())
    if (ref) {
      const c = { row: clamp(ref.row, 0, wb.rows - 1), col: clamp(ref.col, 0, wb.cols - 1) }
      setActive(c)
      setAnchor(c)
      refocus()
    }
    setNameBox('')
  }

  // ---- derived: status-bar aggregates over the selection ----
  const stats = useMemo(() => {
    let count = 0
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let cells = 0
    for (let r = selection.top; r <= selection.bottom; r++) {
      for (let c = selection.left; c <= selection.right; c++) {
        cells++
        const v = wb.getValue({ row: r, col: c })
        if (typeof v === 'number') {
          count++
          sum += v
          if (v < min) min = v
          if (v > max) max = v
        }
      }
    }
    return { count, sum, min, max, cells }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, version])

  const barValue = editing !== null ? editing : wb.getRaw(active)
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : Number(n.toPrecision(8)).toString())

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▦</span>
          <div>
            <h1>Cellforge</h1>
            <p>a spreadsheet with a from-scratch formula language</p>
          </div>
        </div>
        <Toolbar
          onLoadDemo={loadDemo}
          onClear={clearAll}
          onExportCSV={exportCSV}
          onImportText={importCSV}
          onFillDown={() => fill('down')}
          onFillRight={() => fill('right')}
          heatOn={heatmap !== null}
          onToggleHeat={toggleHeat}
        />
      </header>

      <div className="formula-bar">
        <form
          className="namebox-form"
          onSubmit={(e) => {
            e.preventDefault()
            gotoName()
          }}
        >
          <input
            className="namebox"
            value={nameBox}
            placeholder={coordToA1(active.row, active.col)}
            onChange={(e) => setNameBox(e.target.value)}
            spellCheck={false}
          />
        </form>
        <span className="fx">ƒx</span>
        <input
          className="formula-input"
          value={barValue}
          spellCheck={false}
          placeholder="value or =formula"
          onFocus={() => {
            if (editing === null) {
              setEditing(wb.getRaw(active))
              setEditFocus('bar')
            }
          }}
          onChange={(e) => {
            setEditing(e.target.value)
            setEditFocus('bar')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit('down')
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
        />
      </div>

      <div className="workspace">
        <Grid
          wb={wb}
          version={version}
          rows={wb.rows}
          cols={wb.cols}
          active={active}
          selection={selection}
          editing={editing}
          autoFocusEditor={editFocus === 'grid'}
          heatmap={heatmap}
          containerRef={containerRef}
          onSelectCell={selectCell}
          onExtendTo={extendTo}
          onEditStart={editStart}
          onEditChange={(v) => setEditing(v)}
          onCommit={commit}
          onCancel={cancel}
          onContainerKeyDown={onContainerKeyDown}
        />

        <aside className="sidebar">
          <Inspector wb={wb} active={active} version={version} />
          <SelfTestPanel />
          <div className="panel help">
            <div className="panel-head">
              <h3>Keys & tips</h3>
            </div>
            <ul className="keys">
              <li>
                <kbd>↑↓←→</kbd> move · <kbd>Shift</kbd>+move selects
              </li>
              <li>
                <kbd>Enter</kbd>/<kbd>F2</kbd> edit · type to overwrite
              </li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>D</kbd>/<kbd>R</kbd> fill down/right
              </li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy/paste · <kbd>Del</kbd> clear
              </li>
              <li>
                Try <code>=SUM(A1:A5)</code> or <code>=SPARKLINE(B2:B15,"line")</code>
              </li>
            </ul>
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <span className="status-cell">{coordToA1(active.row, active.col)}</span>
        <span className="status-sep">·</span>
        <span>{stats.cells} selected</span>
        {stats.count > 0 ? (
          <>
            <span className="status-sep">·</span>
            <span>Sum {fmt(stats.sum)}</span>
            <span>Avg {fmt(stats.sum / stats.count)}</span>
            <span>Min {fmt(stats.min)}</span>
            <span>Max {fmt(stats.max)}</span>
            <span>Count {stats.count}</span>
          </>
        ) : null}
        <span className="spacer" />
        {isError(wb.getValue(active)) ? <span className="status-err">{wb.getDisplay(active)}</span> : null}
        <span className="muted">{wb.population} non-empty · stored locally</span>
      </footer>
    </div>
  )
}
