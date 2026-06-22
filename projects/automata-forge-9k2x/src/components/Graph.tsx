import { useCallback, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import type { GraphModel } from '../engine/types'
import { layout } from '../layout/layout'
import type { Point } from '../layout/layout'
import './Graph.css'

const R = 22 // node radius

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  graph: GraphModel
  /** States to highlight (current simulation configuration). */
  highlight?: number[]
  /** A key that, when it changes, refits the view (e.g. when the source regex changes). */
  fitKey?: string
}

function unit(dx: number, dy: number): Point {
  const m = Math.hypot(dx, dy) || 1
  return { x: dx / m, y: dy / m }
}

export default function Graph({ graph, highlight, fitKey }: Props) {
  const base = useMemo(() => layout(graph), [graph])
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Node positions can be dragged; start from the computed layout.
  const [override, setOverride] = useState<Map<number, Point>>(new Map())
  const pos = useCallback(
    (i: number): Point => override.get(i) ?? base.pos[i],
    [override, base],
  )

  const fit = useCallback((): ViewBox => {
    const pad = 24
    return { x: -pad, y: -pad, w: base.width + pad * 2, h: base.height + pad * 2 }
  }, [base])

  const [vb, setVb] = useState<ViewBox>(fit)

  // Refit + clear drags whenever the underlying graph changes. This is the documented
  // "adjust state when a prop changes" pattern (setState during render, guarded by a key) —
  // it avoids an effect and the cascading-render it would cause.
  const [lastKey, setLastKey] = useState(fitKey)
  if (fitKey !== lastKey) {
    setLastKey(fitKey)
    setOverride(new Map())
    setVb(fit())
  }

  const clientToSvg = useCallback(
    (clientX: number, clientY: number): Point => {
      const svg = svgRef.current
      if (!svg) return { x: 0, y: 0 }
      const rect = svg.getBoundingClientRect()
      return {
        x: vb.x + ((clientX - rect.left) / rect.width) * vb.w,
        y: vb.y + ((clientY - rect.top) / rect.height) * vb.h,
      }
    },
    [vb],
  )

  // --- interaction state ----------------------------------------------------
  const drag = useRef<
    | { kind: 'pan'; startClient: Point; startVb: ViewBox }
    | { kind: 'node'; id: number; offset: Point }
    | null
  >(null)

  const onPointerDownNode = (e: ReactPointerEvent, id: number) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const p = clientToSvg(e.clientX, e.clientY)
    const cur = pos(id)
    drag.current = { kind: 'node', id, offset: { x: p.x - cur.x, y: p.y - cur.y } }
  }

  const onPointerDownBg = (e: ReactPointerEvent) => {
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    drag.current = { kind: 'pan', startClient: { x: e.clientX, y: e.clientY }, startVb: vb }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'node') {
      const p = clientToSvg(e.clientX, e.clientY)
      setOverride((prev) => {
        const next = new Map(prev)
        next.set(d.id, { x: p.x - d.offset.x, y: p.y - d.offset.y })
        return next
      })
    } else {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const ddx = ((e.clientX - d.startClient.x) / rect.width) * d.startVb.w
      const ddy = ((e.clientY - d.startClient.y) / rect.height) * d.startVb.h
      setVb({ ...d.startVb, x: d.startVb.x - ddx, y: d.startVb.y - ddy })
    }
  }

  const endDrag = () => {
    drag.current = null
  }

  const onWheel = (e: ReactWheelEvent) => {
    const factor = Math.exp(e.deltaY * 0.0015)
    const p = clientToSvg(e.clientX, e.clientY)
    setVb((cur) => {
      const w = Math.min(8000, Math.max(120, cur.w * factor))
      const h = Math.min(8000, Math.max(80, cur.h * factor))
      // Keep the cursor anchored to the same world point.
      return {
        x: p.x - ((p.x - cur.x) * w) / cur.w,
        y: p.y - ((p.y - cur.y) * h) / cur.h,
        w,
        h,
      }
    })
  }

  // --- edge geometry --------------------------------------------------------
  const hasReverse = useMemo(() => {
    const set = new Set(graph.edges.map((e) => `${e.from}->${e.to}`))
    return (from: number, to: number) => set.has(`${to}->${from}`)
  }, [graph])

  const highlightSet = useMemo(() => new Set(highlight ?? []), [highlight])

  const rendered = graph.edges.map((e, i) => {
    if (e.from === e.to) {
      // Self-loop: a small arc above the node.
      const c = pos(e.from)
      const top = { x: c.x, y: c.y - R }
      const path = `M ${c.x - 10} ${c.y - R + 4} C ${c.x - 34} ${c.y - R - 40}, ${c.x + 34} ${
        c.y - R - 40
      }, ${c.x + 10} ${c.y - R + 4}`
      return (
        <g key={i} className="edge">
          <path d={path} className="edge-path" markerEnd="url(#arrow)" fill="none" />
          <text x={top.x} y={c.y - R - 30} className="edge-label" textAnchor="middle">
            {e.label}
          </text>
        </g>
      )
    }
    const p0 = pos(e.from)
    const p1 = pos(e.to)
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
    const dir = unit(p1.x - p0.x, p1.y - p0.y)
    const perp = { x: -dir.y, y: dir.x }
    // Separate anti-parallel edges; orient the offset deterministically by id ordering.
    const offset = hasReverse(e.from, e.to) ? (e.from < e.to ? 34 : -34) : 0
    const ctrl = { x: mid.x + perp.x * offset, y: mid.y + perp.y * offset }

    const toCtrl0 = unit(ctrl.x - p0.x, ctrl.y - p0.y)
    const toCtrl1 = unit(ctrl.x - p1.x, ctrl.y - p1.y)
    const start = { x: p0.x + toCtrl0.x * R, y: p0.y + toCtrl0.y * R }
    const end = { x: p1.x + toCtrl1.x * R, y: p1.y + toCtrl1.y * R }
    const labelPt = {
      x: 0.25 * start.x + 0.5 * ctrl.x + 0.25 * end.x,
      y: 0.25 * start.y + 0.5 * ctrl.y + 0.25 * end.y,
    }
    const path = offset
      ? `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`
      : `M ${start.x} ${start.y} L ${end.x} ${end.y}`
    return (
      <g key={i} className="edge">
        <path d={path} className="edge-path" markerEnd="url(#arrow)" fill="none" />
        <text x={labelPt.x} y={labelPt.y - 5} className="edge-label" textAnchor="middle">
          {e.label}
        </text>
      </g>
    )
  })

  return (
    <div className="graph-wrap">
      <svg
        ref={svgRef}
        className="graph-svg"
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        onPointerDown={onPointerDownBg}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onWheel={onWheel}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
          </marker>
        </defs>

        {/* start marker: an arrow into the start state from the left */}
        {(() => {
          const s = pos(graph.start)
          return (
            <path
              d={`M ${s.x - R - 34} ${s.y} L ${s.x - R - 2} ${s.y}`}
              className="edge-path start-arrow"
              markerEnd="url(#arrow)"
            />
          )
        })()}

        {rendered}

        {Array.from({ length: graph.numStates }, (_, i) => {
          const p = pos(i)
          const accepting = graph.accepting.has(i)
          const active = highlightSet.has(i)
          const sub = graph.stateSub?.[i]
          return (
            <g
              key={i}
              className={`node${active ? ' active' : ''}`}
              onPointerDown={(e) => onPointerDownNode(e, i)}
            >
              {accepting && <circle cx={p.x} cy={p.y} r={R + 4} className="accept-ring" />}
              <circle cx={p.x} cy={p.y} r={R} className="node-circle" />
              <text x={p.x} y={p.y + 1} className="node-label" textAnchor="middle">
                {i}
              </text>
              {sub && (
                <text x={p.x} y={p.y + R + 14} className="node-sub" textAnchor="middle">
                  {sub}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <button
        className="graph-fit"
        onClick={() => {
          setOverride(new Map())
          setVb(fit())
        }}
        title="Reset view & layout"
      >
        ⤢ fit
      </button>
    </div>
  )
}
