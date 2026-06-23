import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { Coord, RangeBox } from '../engine/address'
import { colToLetters, boxContains } from '../engine/address'
import type { Workbook } from '../engine/workbook'
import { isError, isSparkline, isBlank } from '../engine/values'
import Sparkline from './Sparkline'

export const ROW_H = 26
export const COL_W = 100
const HEAD_W = 48
const HEAD_H = 26
const OVERSCAN = 3

interface Props {
  wb: Workbook
  version: number
  rows: number
  cols: number
  active: Coord
  selection: RangeBox
  editing: string | null
  autoFocusEditor: boolean
  heatmap: RangeBox | null
  containerRef: RefObject<HTMLDivElement | null>
  onSelectCell: (coord: Coord, extend: boolean) => void
  onExtendTo: (coord: Coord) => void
  onEditStart: (coord: Coord) => void
  onEditChange: (value: string) => void
  onCommit: (dir: 'down' | 'right') => void
  onCancel: () => void
  onContainerKeyDown: (e: ReactKeyboardEvent) => void
}

function lerp(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t)
}
function heatColor(t: number): string {
  // cool → neutral → warm
  const cool = [40, 70, 130]
  const mid = [60, 64, 82]
  const warm = [176, 70, 47]
  const [r, g, b] =
    t < 0.5
      ? [lerp(cool[0], mid[0], t * 2), lerp(cool[1], mid[1], t * 2), lerp(cool[2], mid[2], t * 2)]
      : [lerp(mid[0], warm[0], (t - 0.5) * 2), lerp(mid[1], warm[1], (t - 0.5) * 2), lerp(mid[2], warm[2], (t - 0.5) * 2)]
  return `rgb(${r},${g},${b})`
}

export default function Grid(props: Props) {
  const { wb, rows, cols, active, selection, editing, heatmap, containerRef } = props
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [vp, setVp] = useState({ w: 900, h: 560 })
  const dragging = useRef(false)

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setVp({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Keep the active cell scrolled into view when navigating by keyboard.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || editing !== null) return
    const top = active.row * ROW_H
    const left = active.col * COL_W
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (left + COL_W > el.scrollLeft + el.clientWidth) el.scrollLeft = left + COL_W - el.clientWidth
  }, [active, editing])

  useEffect(() => {
    const stop = () => (dragging.current = false)
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  const firstRow = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN)
  const lastRow = Math.min(rows - 1, Math.ceil((scroll.top + vp.h) / ROW_H) + OVERSCAN)
  const firstCol = Math.max(0, Math.floor(scroll.left / COL_W) - OVERSCAN)
  const lastCol = Math.min(cols - 1, Math.ceil((scroll.left + vp.w) / COL_W) + OVERSCAN)

  // Heatmap min/max over the frozen range.
  const heatRange = useMemo(() => {
    if (!heatmap) return null
    let min = Infinity
    let max = -Infinity
    for (let r = heatmap.top; r <= heatmap.bottom; r++) {
      for (let c = heatmap.left; c <= heatmap.right; c++) {
        const v = wb.getValue({ row: r, col: c })
        if (typeof v === 'number') {
          if (v < min) min = v
          if (v > max) max = v
        }
      }
    }
    return min <= max ? { min, max } : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatmap, props.version])

  const cellsOut = []
  for (let r = firstRow; r <= lastRow; r++) {
    for (let c = firstCol; c <= lastCol; c++) {
      const coord = { row: r, col: c }
      const v = wb.getValue(coord)
      const selected = boxContains(selection, coord)
      const isActive = r === active.row && c === active.col
      const err = isError(v)
      const numeric = typeof v === 'number'
      const cls = ['cell']
      if (selected) cls.push('sel')
      if (isActive) cls.push('active')
      if (err) cls.push('err')
      if (numeric || err) cls.push('right')

      let bg: string | undefined
      if (heatRange && heatmap && boxContains(heatmap, coord) && numeric) {
        const t = heatRange.max === heatRange.min ? 0.5 : (v - heatRange.min) / (heatRange.max - heatRange.min)
        bg = heatColor(t)
      }

      const style: React.CSSProperties = {
        transform: `translate(${c * COL_W}px, ${r * ROW_H}px)`,
        width: COL_W,
        height: ROW_H,
        background: bg,
      }

      let content: React.ReactNode
      if (isActive && editing !== null) {
        content = (
          <input
            className="cell-input"
            autoFocus={props.autoFocusEditor}
            value={editing}
            onChange={(e) => props.onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                props.onCommit('down')
              } else if (e.key === 'Tab') {
                e.preventDefault()
                props.onCommit('right')
              } else if (e.key === 'Escape') {
                e.preventDefault()
                props.onCancel()
              }
              e.stopPropagation()
            }}
          />
        )
      } else if (isSparkline(v)) {
        content = <Sparkline spark={v} />
      } else if (!isBlank(v)) {
        content = <span className="cell-text">{wb.getDisplay(coord)}</span>
      }

      cellsOut.push(
        <div
          key={`${r}:${c}`}
          className={cls.join(' ')}
          style={style}
          onMouseDown={(e) => {
            if (editing !== null) return
            dragging.current = true
            props.onSelectCell(coord, e.shiftKey)
          }}
          onMouseEnter={(e) => {
            if (dragging.current && e.buttons === 1) props.onExtendTo(coord)
          }}
          onDoubleClick={() => props.onEditStart(coord)}
        >
          {content}
        </div>,
      )
    }
  }

  const colHeaders = []
  for (let c = firstCol; c <= lastCol; c++) {
    const on = c >= selection.left && c <= selection.right
    colHeaders.push(
      <div key={c} className={'colhead' + (on ? ' on' : '')} style={{ transform: `translateX(${c * COL_W}px)`, width: COL_W }}>
        {colToLetters(c)}
      </div>,
    )
  }
  const rowHeaders = []
  for (let r = firstRow; r <= lastRow; r++) {
    const on = r >= selection.top && r <= selection.bottom
    rowHeaders.push(
      <div key={r} className={'rowhead' + (on ? ' on' : '')} style={{ transform: `translateY(${r * ROW_H}px)`, height: ROW_H }}>
        {r + 1}
      </div>,
    )
  }

  const totalW = cols * COL_W
  const totalH = rows * ROW_H

  return (
    <div
      className="grid"
      style={{ gridTemplateColumns: `${HEAD_W}px 1fr`, gridTemplateRows: `${HEAD_H}px 1fr` }}
      ref={containerRef}
      tabIndex={0}
      onKeyDown={props.onContainerKeyDown}
    >
      <div className="corner" style={{ width: HEAD_W, height: HEAD_H }} />
      <div className="colheaders" style={{ height: HEAD_H }}>
        <div className="colheaders-inner" style={{ width: totalW, transform: `translateX(${-scroll.left}px)` }}>
          {colHeaders}
        </div>
      </div>
      <div className="rowheaders" style={{ width: HEAD_W }}>
        <div className="rowheaders-inner" style={{ height: totalH, transform: `translateY(${-scroll.top}px)` }}>
          {rowHeaders}
        </div>
      </div>
      <div
        className="cells"
        ref={scrollerRef}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
      >
        <div className="canvas" style={{ width: totalW, height: totalH }}>
          {cellsOut}
        </div>
      </div>
    </div>
  )
}
