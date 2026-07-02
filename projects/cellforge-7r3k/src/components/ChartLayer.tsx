import { useRef } from 'react'
import type { Workbook } from '../engine/workbook'
import type { ChartSpec, ChartType } from '../engine/chart'
import { buildChartData, CHART_TYPES, CHART_LABELS } from '../engine/chart'
import { coordToA1 } from '../engine/address'
import ChartView from './ChartView'

interface Props {
  wb: Workbook
  sheetId: string
  version: number
  charts: ChartSpec[]
  onChange: (id: string, patch: Partial<ChartSpec>) => void
  onCheckpoint: () => void // push an undo snapshot at the *start* of an interaction
  onDelete: (id: string) => void
}

const HEADER_H = 28

/** A floating layer of draggable, resizable chart cards over the grid. */
export default function ChartLayer({ wb, sheetId, version, charts, onChange, onCheckpoint, onDelete }: Props) {
  void version
  if (charts.length === 0) return null
  return (
    <div className="chart-layer">
      {charts.map((c) => (
        <ChartCard key={c.id} wb={wb} sheetId={sheetId} spec={c} onChange={onChange} onCheckpoint={onCheckpoint} onDelete={onDelete} />
      ))}
    </div>
  )
}

function ChartCard({
  wb,
  sheetId,
  spec,
  onChange,
  onCheckpoint,
  onDelete,
}: {
  wb: Workbook
  sheetId: string
  spec: ChartSpec
  onChange: (id: string, patch: Partial<ChartSpec>) => void
  onCheckpoint: () => void
  onDelete: (id: string) => void
}) {
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; ox: number; oy: number; ow: number; oh: number } | null>(null)

  const data = buildChartData(spec, (r, c) => wb.getValue({ row: r, col: c }, sheetId))
  const rangeLabel = `${coordToA1(spec.range.top, spec.range.left)}:${coordToA1(spec.range.bottom, spec.range.right)}`

  const beginDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    onCheckpoint() // snapshot the pre-drag state so the move is undoable
    drag.current = { mode, x: e.clientX, y: e.clientY, ox: spec.x, oy: spec.y, ow: spec.w, oh: spec.h }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (d.mode === 'move') onChange(spec.id, { x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) })
    else onChange(spec.id, { w: Math.max(180, d.ow + dx), h: Math.max(140, d.oh + dy) })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="chart-card" style={{ left: spec.x, top: spec.y, width: spec.w, height: spec.h }}>
      <div
        className="chart-head"
        onPointerDown={(e) => beginDrag(e, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <input
          className="chart-title"
          value={spec.title}
          placeholder={rangeLabel}
          onPointerDown={(e) => e.stopPropagation()}
          onFocus={onCheckpoint}
          onChange={(e) => onChange(spec.id, { title: e.target.value })}
          spellCheck={false}
        />
        <select
          className="chart-type"
          value={spec.type}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            onCheckpoint()
            onChange(spec.id, { type: e.target.value as ChartType })
          }}
        >
          {CHART_TYPES.map((t) => (
            <option key={t} value={t}>
              {CHART_LABELS[t]}
            </option>
          ))}
        </select>
        <button
          className={'chart-toggle' + (spec.headers ? ' on' : '')}
          title="First row is series headers"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            onCheckpoint()
            onChange(spec.id, { headers: !spec.headers })
          }}
        >
          H
        </button>
        <button
          className={'chart-toggle' + (spec.labels ? ' on' : '')}
          title="First column is category labels"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            onCheckpoint()
            onChange(spec.id, { labels: !spec.labels })
          }}
        >
          L
        </button>
        <button
          className={'chart-toggle' + (spec.trendline ? ' on' : '')}
          title="Least-squares trendline + R² (line / area / scatter)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            onCheckpoint()
            onChange(spec.id, { trendline: !spec.trendline })
          }}
        >
          T
        </button>
        <button className="chart-x" title="Delete chart" onPointerDown={(e) => e.stopPropagation()} onClick={() => onDelete(spec.id)}>
          ✕
        </button>
      </div>
      <div className="chart-body">
        <ChartView type={spec.type} data={data} width={spec.w - 2} height={spec.h - HEADER_H - 2} trendline={spec.trendline} />
      </div>
      <div className="chart-resize" onPointerDown={(e) => beginDrag(e, 'resize')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
    </div>
  )
}
