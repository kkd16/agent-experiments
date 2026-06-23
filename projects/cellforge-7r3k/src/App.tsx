import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import './App.css'
import { Workbook } from './engine/workbook'
import type { WorkbookSnapshot } from './engine/workbook'
import type { Coord, RangeBox } from './engine/address'
import { boxOf, coordToA1, parseRef } from './engine/address'
import { offsetFormula } from './engine/rewrite'
import { isError } from './engine/values'
import type { CellFormat } from './engine/format'
import type { ChartSpec } from './engine/chart'
import { DEMOS, demoToCells } from './data'
import type { Demo } from './data'
import { toCSV, parseDelimited, gridToEntries, selectionToTSV } from './csv'
import Grid from './components/Grid'
import Toolbar from './components/Toolbar'
import Inspector from './components/Inspector'
import SelfTestPanel from './components/SelfTestPanel'
import FormatBar from './components/FormatBar'
import SheetTabs from './components/SheetTabs'
import ChartLayer from './components/ChartLayer'
import NameManager from './components/NameManager'
import FindReplace from './components/FindReplace'

const STORAGE_KEY = 'cellforge.workbook.v2'
const LEGACY_KEY = 'cellforge.workbook.v1'
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

interface ClipData {
  box: RangeBox
  raws: string[][]
}

function loadDemoInto(wb: Workbook, demo: Demo): void {
  if (demo.snapshot) wb.loadJSON(demo.snapshot())
  else wb.loadJSON({ cells: demoToCells(demo) })
}

export default function App() {
  // The Workbook is a mutable model; `version` is bumped to force re-renders after
  // a mutation. It lives in state (not a ref) so reads during render are legitimate.
  const [wb] = useState(() => {
    const book = new Workbook()
    let loaded = false
    try {
      const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY)
      if (saved) {
        book.loadJSON(JSON.parse(saved))
        loaded = true
      }
    } catch {
      /* sandboxed preview — fall through to the demo */
    }
    if (!loaded) loadDemoInto(book, DEMOS[0])
    return book
  })

  const [version, setVersion] = useState(0)
  const [sheetId, setSheetId] = useState(wb.activeSheetId)
  const [active, setActive] = useState<Coord>({ row: 0, col: 0 })
  const [anchor, setAnchor] = useState<Coord>({ row: 0, col: 0 })
  const [editing, setEditing] = useState<string | null>(null)
  const [editFocus, setEditFocus] = useState<'grid' | 'bar'>('grid')
  const [heatmap, setHeatmap] = useState<RangeBox | null>(null)
  const [nameBox, setNameBox] = useState('')
  const [showNames, setShowNames] = useState(false)
  const [showFind, setShowFind] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const clipRef = useRef<ClipData | null>(null)
  const undoRef = useRef<string[]>([])
  const redoRef = useRef<string[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const syncHistory = () => {
    setCanUndo(undoRef.current.length > 0)
    setCanRedo(redoRef.current.length > 0)
  }

  const selection = useMemo(() => boxOf(anchor, active), [anchor, active])

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

  // ---- undo / redo ----
  const snapStr = () => JSON.stringify(wb.serialize())
  const checkpoint = () => {
    undoRef.current.push(snapStr())
    if (undoRef.current.length > 120) undoRef.current.shift()
    redoRef.current = []
    syncHistory()
  }
  const restoreSnap = (snap: string) => {
    wb.restore(JSON.parse(snap) as WorkbookSnapshot)
    setSheetId(wb.activeSheetId)
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
    setEditing(null)
    setHeatmap(null)
    bump()
  }
  const undo = () => {
    const snap = undoRef.current.pop()
    if (snap === undefined) return
    redoRef.current.push(snapStr())
    syncHistory()
    restoreSnap(snap)
  }
  const redo = () => {
    const snap = redoRef.current.pop()
    if (snap === undefined) return
    undoRef.current.push(snapStr())
    syncHistory()
    restoreSnap(snap)
  }

  // ---- editing ----
  const commit = (dir: 'down' | 'right') => {
    if (editing === null) return
    checkpoint()
    wb.setCell(active, editing, sheetId)
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
      checkpoint()
      wb.setCell(active, editing, sheetId)
      setEditing(null)
      setEditFocus('grid')
      bump()
    }
  }

  const editStart = (coord: Coord) => {
    flushEdit()
    setActive(coord)
    setAnchor(coord)
    setEditing(wb.getRaw(coord, sheetId))
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
    checkpoint()
    const entries: Array<{ coord: Coord; raw: string }> = []
    for (let r = selection.top; r <= selection.bottom; r++)
      for (let c = selection.left; c <= selection.right; c++) entries.push({ coord: { row: r, col: c }, raw: '' })
    wb.setMany(entries, sheetId)
    bump()
  }

  const fill = (axis: 'down' | 'right') => {
    const entries: Array<{ coord: Coord; raw: string }> = []
    if (axis === 'down') {
      for (let c = selection.left; c <= selection.right; c++) {
        const src = wb.getRaw({ row: selection.top, col: c }, sheetId)
        for (let r = selection.top + 1; r <= selection.bottom; r++)
          entries.push({ coord: { row: r, col: c }, raw: offsetFormula(src, r - selection.top, 0) })
      }
    } else {
      for (let r = selection.top; r <= selection.bottom; r++) {
        const src = wb.getRaw({ row: r, col: selection.left }, sheetId)
        for (let c = selection.left + 1; c <= selection.right; c++)
          entries.push({ coord: { row: r, col: c }, raw: offsetFormula(src, 0, c - selection.left) })
      }
    }
    if (entries.length) {
      checkpoint()
      wb.setMany(entries, sheetId)
      bump()
    }
  }

  const copySelection = () => {
    const raws: string[][] = []
    for (let r = selection.top; r <= selection.bottom; r++) {
      const row: string[] = []
      for (let c = selection.left; c <= selection.right; c++) row.push(wb.getRaw({ row: r, col: c }, sheetId))
      raws.push(row)
    }
    clipRef.current = { box: selection, raws }
    try {
      void navigator.clipboard?.writeText(selectionToTSV(wb, selection.top, selection.left, selection.bottom, selection.right))
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
    checkpoint()
    wb.setMany(entries, sheetId)
    bump()
  }

  const pasteTextAt = (text: string, origin: Coord) => {
    const grid = parseDelimited(text, text.includes('\t') ? '\t' : ',')
    checkpoint()
    wb.setMany(gridToEntries(grid, origin), sheetId)
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

  // ---- formatting ----
  const applyFormat = (patch: CellFormat) => {
    checkpoint()
    wb.applyFormat(selection, patch, sheetId)
    bump()
    refocus()
  }
  const clearFormat = () => {
    checkpoint()
    wb.clearFormat(selection, sheetId)
    bump()
    refocus()
  }

  // ---- charts ----
  const insertChart = () => {
    const range: RangeBox = { ...selection }
    const single = range.top === range.bottom && range.left === range.right
    const box: RangeBox = single ? { top: range.top, left: range.left, bottom: Math.min(range.top + 4, wb.rows - 1), right: Math.min(range.left + 1, wb.cols - 1) } : range
    // Infer headers/labels: text in the first row/column suggests they label the data.
    const firstRowText = rangeHasText(box.top, box.top, box.left, box.right)
    const firstColText = rangeHasText(box.top, box.bottom, box.left, box.left)
    checkpoint()
    const n = wb.chartsOf(sheetId).length
    wb.addChart(
      { type: 'column', range: box, title: '', x: 80 + (n % 4) * 28, y: 70 + (n % 4) * 28, w: 380, h: 250, headers: firstRowText, labels: firstColText },
      sheetId,
    )
    bump()
  }
  const rangeHasText = (r0: number, r1: number, c0: number, c1: number): boolean => {
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const v = wb.getValue({ row: r, col: c }, sheetId)
        if (typeof v === 'string' && v !== '') return true
      }
    return false
  }
  const changeChart = (id: string, patch: Partial<ChartSpec>) => {
    wb.updateChart(id, patch, sheetId)
    bump()
  }
  const deleteChart = (id: string) => {
    checkpoint()
    wb.deleteChart(id, sheetId)
    bump()
  }

  // ---- sheets ----
  const switchSheet = (id: string) => {
    flushEdit()
    wb.setActiveSheet(id)
    setSheetId(id)
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
    setEditing(null)
    setHeatmap(null)
    bump()
    refocus()
  }
  const addSheet = () => {
    checkpoint()
    const id = wb.addSheet()
    setSheetId(id)
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
    setHeatmap(null)
    bump()
  }
  const renameSheet = (id: string, name: string) => {
    checkpoint()
    wb.renameSheet(id, name)
    bump()
  }
  const duplicateSheet = (id: string) => {
    checkpoint()
    const nid = wb.duplicateSheet(id)
    if (nid) setSheetId(nid)
    bump()
  }
  const deleteSheet = (id: string) => {
    checkpoint()
    wb.deleteSheet(id)
    setSheetId(wb.activeSheetId)
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
    setHeatmap(null)
    bump()
  }
  const reorderSheet = (id: string, toIndex: number) => {
    checkpoint()
    wb.moveSheet(id, toIndex)
    bump()
  }

  // ---- defined names ----
  const addName = (name: string, formula: string, scope: string): boolean => {
    checkpoint()
    const ok = wb.setName(name, formula, scope)
    bump()
    return ok
  }
  const deleteName = (name: string) => {
    checkpoint()
    wb.deleteName(name)
    bump()
  }

  // ---- find & replace ----
  const applyReplacements = (entries: Array<{ coord: Coord; raw: string }>) => {
    if (!entries.length) return
    checkpoint()
    wb.setMany(entries, sheetId)
    bump()
  }

  // ---- keyboard ----
  const onContainerKeyDown = (e: ReactKeyboardEvent) => {
    if (editing !== null) return
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        undo()
        e.preventDefault()
        return
      }
      if ((k === 'z' && e.shiftKey) || k === 'y') {
        redo()
        e.preventDefault()
        return
      }
      if (k === 'f') {
        setShowFind(true)
        e.preventDefault()
        return
      }
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
      case 'Escape':
        if (showFind) setShowFind(false)
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
    checkpoint()
    loadDemoInto(wb, demo)
    setSheetId(wb.activeSheetId)
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
    setEditing(null)
    setHeatmap(null)
    bump()
    refocus()
  }
  const clearAll = () => {
    checkpoint()
    wb.clear(sheetId)
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
      a.download = `${wb.sheetName(sheetId)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* sandbox: ignore */
    }
  }
  const importCSV = (text: string) => {
    checkpoint()
    wb.clear(sheetId)
    const grid = parseDelimited(text, text.includes('\t') ? '\t' : ',')
    wb.setMany(gridToEntries(grid, { row: 0, col: 0 }), sheetId)
    setActive({ row: 0, col: 0 })
    setAnchor({ row: 0, col: 0 })
    bump()
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
        const v = wb.getValue({ row: r, col: c }, sheetId)
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
  }, [selection, version, sheetId])

  const barValue = editing !== null ? editing : wb.getRaw(active, sheetId)
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : Number(n.toPrecision(8)).toString())
  const charts = wb.chartsOf(sheetId)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▦</span>
          <div>
            <h1>Cellforge</h1>
            <p>a multi-sheet spreadsheet with a from-scratch formula engine</p>
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
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          onInsertChart={insertChart}
          onOpenNames={() => setShowNames(true)}
          onFind={() => setShowFind(true)}
        />
      </header>

      <FormatBar current={wb.getFormat(active, sheetId)} onApply={applyFormat} onClear={clearFormat} />

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
              setEditing(wb.getRaw(active, sheetId))
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
        <div className="grid-wrap">
          <Grid
            wb={wb}
            sheetId={sheetId}
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
          <ChartLayer
            wb={wb}
            sheetId={sheetId}
            version={version}
            charts={charts}
            onChange={changeChart}
            onCheckpoint={checkpoint}
            onDelete={deleteChart}
          />
          {showFind ? (
            <FindReplace
              wb={wb}
              sheetId={sheetId}
              version={version}
              onGoto={(c) => {
                setActive(c)
                setAnchor(c)
              }}
              applyReplacements={applyReplacements}
              onClose={() => {
                setShowFind(false)
                refocus()
              }}
            />
          ) : null}
        </div>

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
                <kbd>Enter</kbd>/<kbd>F2</kbd> edit · <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> undo/redo
              </li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>D</kbd>/<kbd>R</kbd> fill · <kbd>Ctrl</kbd>+<kbd>F</kbd> find
              </li>
              <li>
                Cross-sheet: <code>=Summary!B5</code> · names: <code>=SUM(Revenue)</code>
              </li>
              <li>
                Try <code>=TODAY()</code>, <code>=XLOOKUP(...)</code>, <code>=SUMIFS(...)</code>
              </li>
            </ul>
          </div>
        </aside>
      </div>

      <SheetTabs
        sheets={wb.sheetList()}
        activeId={sheetId}
        onSelect={switchSheet}
        onAdd={addSheet}
        onRename={renameSheet}
        onDelete={deleteSheet}
        onDuplicate={duplicateSheet}
        onReorder={reorderSheet}
      />

      <footer className="statusbar">
        <span className="status-cell">
          {wb.sheetName(sheetId)}!{coordToA1(active.row, active.col)}
        </span>
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
        {isError(wb.getValue(active, sheetId)) ? <span className="status-err">{wb.getDisplay(active, sheetId)}</span> : null}
        <span className="muted">{wb.population} non-empty · stored locally</span>
      </footer>

      {showNames ? (
        <NameManager
          names={wb.listNames()}
          sheets={wb.sheetList()}
          activeSheetId={sheetId}
          onAdd={addName}
          onDelete={deleteName}
          onClose={() => {
            setShowNames(false)
            refocus()
          }}
        />
      ) : null}
    </div>
  )
}
