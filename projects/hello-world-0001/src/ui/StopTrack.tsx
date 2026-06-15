// The editable stop rail. The bar shows the gradient as a 0→1 ramp (independent of whether the
// actual gradient is linear/radial/conic); handles can be dragged, the bar can be clicked to add a
// stop sampling the color already there, and a handle can be removed (down to two).

import { useCallback, useRef } from 'react'
import { rgbaToCss } from '../color/convert'
import { ramp, sampleAt, sortedStops } from '../color/interpolate'
import { makeStopId } from '../color/random'
import type { Gradient, Stop } from '../color/types'

function rampCss(g: Gradient): string {
  const cols = ramp(g, 24)
  const stops = cols.map((c, i) => `${rgbaToCss(c)} ${(i / (cols.length - 1)) * 100}%`).join(', ')
  return `linear-gradient(90deg, ${stops})`
}

export function StopTrack({
  gradient,
  selectedId,
  onSelect,
  onStops,
}: {
  gradient: Gradient
  selectedId: string | null
  onSelect: (id: string) => void
  onStops: (stops: Stop[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const draggingId = useRef<string | null>(null)

  const fractionAt = useCallback((clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }, [])

  const moveStop = useCallback(
    (id: string, pos: number) => {
      onStops(gradient.stops.map((s) => (s.id === id ? { ...s, pos } : s)))
    },
    [gradient.stops, onStops],
  )

  const onHandleDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    draggingId.current = id
    onSelect(id)
  }
  const onHandleMove = (e: React.PointerEvent, id: string) => {
    if (draggingId.current === id && e.buttons === 1) moveStop(id, fractionAt(e.clientX))
  }
  const onHandleUp = () => {
    draggingId.current = null
  }

  const addAt = (e: React.PointerEvent) => {
    const pos = fractionAt(e.clientX)
    const color = sampleAt(gradient, pos)
    const stop: Stop = { id: makeStopId(), color, pos }
    onStops([...gradient.stops, stop])
    onSelect(stop.id)
  }

  const removeStop = (id: string) => {
    if (gradient.stops.length <= 2) return
    const remaining = gradient.stops.filter((s) => s.id !== id)
    onStops(remaining)
    if (selectedId === id) onSelect(sortedStops(remaining)[0].id)
  }

  return (
    <div className="stoptrack">
      <div className="stoptrack-bar" ref={ref} style={{ background: rampCss(gradient) }} onPointerDown={addAt}>
        <div className="checker" />
        {gradient.stops.map((s) => (
          <button
            key={s.id}
            className={`stop-handle${s.id === selectedId ? ' is-selected' : ''}`}
            style={{ left: `${s.pos * 100}%` }}
            onPointerDown={(e) => onHandleDown(e, s.id)}
            onPointerMove={(e) => onHandleMove(e, s.id)}
            onPointerUp={onHandleUp}
            onDoubleClick={(e) => {
              e.stopPropagation()
              removeStop(s.id)
            }}
            title={`${Math.round(s.pos * 100)}% · double-click to remove`}
            aria-label={`stop at ${Math.round(s.pos * 100)} percent`}
          >
            <span className="stop-chip" style={{ background: rgbaToCss(s.color) }} />
          </button>
        ))}
      </div>
      <p className="stoptrack-hint">Click the bar to add a stop · drag to move · double-click a handle to remove</p>
    </div>
  )
}
