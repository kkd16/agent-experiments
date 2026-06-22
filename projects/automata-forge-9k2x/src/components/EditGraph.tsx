// A direct-manipulation SVG editor for automata: the canvas behind Build mode. Click to add
// states, drag to reposition, click-source-then-target to draw a labelled transition, double-click
// to toggle accepting, and delete with the eraser tool. It edits an EditAutomaton through the pure
// operations in engine/edit.ts and reuses the read-only renderer's visual language (curved
// anti-parallel edges, self-loops, double-ring accepts, a start arrow).

import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import type { EditAutomaton } from '../engine/edit'
import { addState, addTransition, moveState, removeState, removeTransition, toggleAccept } from '../engine/edit'
import { showChar } from '../engine/types'
import type { Point } from '../layout/layout'
import './Graph.css'
import './EditGraph.css'

const R = 24

export type EditTool = 'move' | 'state' | 'edge' | 'delete'

interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

interface Props {
  automaton: EditAutomaton
  onChange: (next: EditAutomaton) => void
  tool: EditTool
  /** Editor state ids to highlight (current simulation configuration). */
  highlight?: number[]
}

function unit(dx: number, dy: number): Point {
  const m = Math.hypot(dx, dy) || 1
  return { x: dx / m, y: dy / m }
}

export default function EditGraph({ automaton, onChange, tool, highlight }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [vb, setVb] = useState<ViewBox>({ x: 0, y: 0, w: 720, h: 460 })
  const [edgeFrom, setEdgeFrom] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ from: number; to: number } | null>(null)
  const [draftSym, setDraftSym] = useState('')

  const posOf = useMemo(() => {
    const m = new Map<number, Point>()
    for (const s of automaton.states) m.set(s.id, { x: s.x, y: s.y })
    return m
  }, [automaton.states])

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

  const drag = useRef<
    | { kind: 'pan'; startClient: Point; startVb: ViewBox }
    | { kind: 'node'; id: number; offset: Point; moved: boolean }
    | null
  >(null)

  // --- background interactions ----------------------------------------------
  const onPointerDownBg = (e: ReactPointerEvent) => {
    if (tool === 'state') {
      const p = clientToSvg(e.clientX, e.clientY)
      onChange(addState(automaton, p.x, p.y))
      return
    }
    if (tool === 'edge') setEdgeFrom(null) // clicking empty space cancels a pending edge
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    drag.current = { kind: 'pan', startClient: { x: e.clientX, y: e.clientY }, startVb: vb }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'node') {
      const p = clientToSvg(e.clientX, e.clientY)
      d.moved = true
      onChange(moveState(automaton, d.id, p.x - d.offset.x, p.y - d.offset.y))
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
      const w = Math.min(6000, Math.max(160, cur.w * factor))
      const h = Math.min(6000, Math.max(110, cur.h * factor))
      return {
        x: p.x - ((p.x - cur.x) * w) / cur.w,
        y: p.y - ((p.y - cur.y) * h) / cur.h,
        w,
        h,
      }
    })
  }

  // --- node interactions ----------------------------------------------------
  const onPointerDownNode = (e: ReactPointerEvent, id: number) => {
    e.stopPropagation()
    if (tool === 'delete') {
      onChange(removeState(automaton, id))
      return
    }
    if (tool === 'edge') {
      if (edgeFrom === null) {
        setEdgeFrom(id)
      } else {
        setDraft({ from: edgeFrom, to: id })
        setDraftSym('')
        setEdgeFrom(null)
      }
      return
    }
    // move tool: start dragging
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const cur = posOf.get(id)!
    const p = clientToSvg(e.clientX, e.clientY)
    drag.current = { kind: 'node', id, offset: { x: p.x - cur.x, y: p.y - cur.y }, moved: false }
  }

  const onDoubleClickNode = (e: ReactMouseEvent, id: number) => {
    e.stopPropagation()
    onChange(toggleAccept(automaton, id))
  }

  const commitDraft = () => {
    if (!draft) return
    const syms = draftSym.trim()
    let next = automaton
    if (syms === '' || syms === 'ε') {
      next = addTransition(next, draft.from, draft.to, null)
    } else {
      // each character becomes its own symbol-transition (a quick way to add several at once).
      for (const ch of syms) next = addTransition(next, draft.from, draft.to, ch)
    }
    onChange(next)
    setDraft(null)
    setDraftSym('')
  }

  // --- edge geometry (mirrors the read-only Graph) --------------------------
  const groups = useMemo(() => {
    const m = new Map<string, { from: number; to: number; indices: number[]; labels: string[] }>()
    automaton.transitions.forEach((t, i) => {
      const k = `${t.from}->${t.to}`
      let g = m.get(k)
      if (!g) {
        g = { from: t.from, to: t.to, indices: [], labels: [] }
        m.set(k, g)
      }
      g.indices.push(i)
      g.labels.push(t.symbol === null ? 'ε' : showChar(t.symbol))
    })
    return [...m.values()]
  }, [automaton.transitions])

  const hasReverse = useMemo(() => {
    const set = new Set(groups.map((g) => `${g.from}->${g.to}`))
    return (from: number, to: number) => set.has(`${to}->${from}`)
  }, [groups])

  const highlightSet = useMemo(() => new Set(highlight ?? []), [highlight])

  const deleteGroup = (indices: number[]) => {
    // Remove highest indices first so earlier ones stay valid.
    let next = automaton
    for (const i of [...indices].sort((a, b) => b - a)) next = removeTransition(next, i)
    onChange(next)
  }

  const rendered = groups.map((g, gi) => {
    const label = g.labels.join(', ')
    const onEdgeClick = (e: ReactPointerEvent) => {
      if (tool === 'delete') {
        e.stopPropagation()
        deleteGroup(g.indices)
      }
    }
    if (g.from === g.to) {
      const c = posOf.get(g.from)
      if (!c) return null
      const path = `M ${c.x - 11} ${c.y - R + 4} C ${c.x - 38} ${c.y - R - 44}, ${c.x + 38} ${
        c.y - R - 44
      }, ${c.x + 11} ${c.y - R + 4}`
      return (
        <g key={gi} className={`edge${tool === 'delete' ? ' deletable' : ''}`} onPointerDown={onEdgeClick}>
          <path d={path} className="edge-path" markerEnd="url(#arrow-e)" fill="none" />
          <path d={path} className="edge-hit" fill="none" />
          <text x={c.x} y={c.y - R - 34} className="edge-label" textAnchor="middle">
            {label}
          </text>
        </g>
      )
    }
    const p0 = posOf.get(g.from)
    const p1 = posOf.get(g.to)
    if (!p0 || !p1) return null
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
    const dir = unit(p1.x - p0.x, p1.y - p0.y)
    const perp = { x: -dir.y, y: dir.x }
    const offset = hasReverse(g.from, g.to) ? (g.from < g.to ? 34 : -34) : 0
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
      <g key={gi} className={`edge${tool === 'delete' ? ' deletable' : ''}`} onPointerDown={onEdgeClick}>
        <path d={path} className="edge-path" markerEnd="url(#arrow-e)" fill="none" />
        <path d={path} className="edge-hit" fill="none" />
        <text x={labelPt.x} y={labelPt.y - 6} className="edge-label" textAnchor="middle">
          {label}
        </text>
      </g>
    )
  })

  const startPos = automaton.start !== null ? posOf.get(automaton.start) : undefined
  const draftMid =
    draft && posOf.get(draft.from) && posOf.get(draft.to)
      ? {
          x: (posOf.get(draft.from)!.x + posOf.get(draft.to)!.x) / 2,
          y: (posOf.get(draft.from)!.y + posOf.get(draft.to)!.y) / 2,
        }
      : null

  return (
    <div className={`graph-wrap edit-wrap tool-${tool}`}>
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
          <marker id="arrow-e" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
          </marker>
        </defs>

        {startPos && (
          <path
            d={`M ${startPos.x - R - 34} ${startPos.y} L ${startPos.x - R - 2} ${startPos.y}`}
            className="edge-path start-arrow"
            markerEnd="url(#arrow-e)"
          />
        )}

        {rendered}

        {/* rubber-band line while picking an edge target */}
        {edgeFrom !== null && posOf.get(edgeFrom) && (
          <circle
            cx={posOf.get(edgeFrom)!.x}
            cy={posOf.get(edgeFrom)!.y}
            r={R + 6}
            className="edge-pending-ring"
          />
        )}

        {automaton.states.map((s) => {
          const active = highlightSet.has(s.id)
          const isStart = automaton.start === s.id
          const isFrom = edgeFrom === s.id
          return (
            <g
              key={s.id}
              className={`node edit-node${active ? ' active' : ''}${isFrom ? ' picking' : ''}`}
              onPointerDown={(e) => onPointerDownNode(e, s.id)}
              onDoubleClick={(e) => onDoubleClickNode(e, s.id)}
            >
              {s.accepting && <circle cx={s.x} cy={s.y} r={R + 4} className="accept-ring" />}
              <circle cx={s.x} cy={s.y} r={R} className="node-circle" />
              <text x={s.x} y={s.y + 1} className="node-label" textAnchor="middle">
                q{automaton.states.indexOf(s)}
              </text>
              {isStart && (
                <text x={s.x} y={s.y - R - 8} className="node-start-tag" textAnchor="middle">
                  start
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {automaton.states.length === 0 && (
        <div className="edit-hint-empty">
          Pick <b>＋ State</b> and click here to drop your first state — or load a template.
        </div>
      )}

      {draft && draftMid && (
        <div className="edge-draft">
          <span className="edge-draft-label">
            q{automaton.states.findIndex((s) => s.id === draft.from)} →
            q{automaton.states.findIndex((s) => s.id === draft.to)} on
          </span>
          <input
            autoFocus
            value={draftSym}
            spellCheck={false}
            placeholder="symbol(s)"
            onChange={(e) => setDraftSym(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft()
              if (e.key === 'Escape') {
                setDraft(null)
                setDraftSym('')
              }
            }}
          />
          <button className="edge-draft-eps" title="ε-transition" onClick={() => { setDraftSym('ε'); }}>
            ε
          </button>
          <button className="edge-draft-add" onClick={commitDraft}>
            add
          </button>
          <button
            className="edge-draft-cancel"
            onClick={() => {
              setDraft(null)
              setDraftSym('')
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
