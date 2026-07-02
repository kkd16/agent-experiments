// A dedicated renderer for a Reduced Ordered BDD. Unlike the automaton graph (a general digraph laid
// out by BFS rank), a BDD has a rigid shape the picture should make obvious: every node sits on the
// *level* of the variable it tests, the two constant sinks sit at the bottom, the `hi` (1) edge is
// drawn solid and the `lo` (0) edge dashed. Sharing (two parents pointing at one node) and reduction
// (a skipped variable = an edge that jumps a level) are then visible at a glance — the whole reason a
// BDD can be exponentially smaller than a truth table. An optional assignment traces its decision path.

import { useMemo } from 'react'
import { Bdd } from '../engine/bdd/bdd'
import type { BddId } from '../engine/bdd/bdd'
import './BddDiagram.css'

interface Root {
  id: BddId
  label?: string
}
interface Props {
  m: Bdd
  roots: Root[]
  /** An assignment (index = variable level) whose decision path is highlighted, from `traceRoot`. */
  assign?: boolean[]
  traceRoot?: BddId
  maxNodes?: number // above this, the caller shows a summary instead
}

const R = 20
const COL = 78
const ROW = 78
const MARGIN = 40

export default function BddDiagram({ m, roots, assign, traceRoot, maxNodes = 120 }: Props) {
  const rootIds = roots.map((r) => r.id)
  const rootKey = rootIds.join(',')
  const internal = useMemo(() => m.reachable(rootIds), [m, rootKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const layout = useMemo(() => {
    // Rows: one per distinct variable level used, then a terminal row at the bottom.
    const levels = [...new Set(internal.map((id) => m.levelOf(id)))].sort((a, b) => a - b)
    const rowOf = new Map<number, number>() // variable level → row
    levels.forEach((lv, i) => rowOf.set(lv, i))
    const termRow = levels.length

    // Order nodes within a row by first-visit order from the roots (cuts crossings cheaply).
    const order = new Map<BddId, number>()
    let counter = 0
    const seen = new Set<BddId>()
    const walk = (x: BddId) => {
      if (x < 2 || seen.has(x)) return
      seen.add(x)
      order.set(x, counter++)
      walk(m.lo(x))
      walk(m.hi(x))
    }
    for (const r of rootIds) walk(r)

    const rows: BddId[][] = levels.map(() => [])
    for (const id of internal) rows[rowOf.get(m.levelOf(id))!].push(id)
    rows.forEach((row) => row.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)))

    // Which sinks are referenced?
    const refTerminals = new Set<BddId>()
    for (const id of internal) {
      refTerminals.add(m.lo(id))
      refTerminals.add(m.hi(id))
    }
    if (internal.length === 0) for (const r of rootIds) if (r < 2) refTerminals.add(r)

    const maxRowLen = Math.max(1, ...rows.map((r) => r.length), refTerminals.size)
    const span = (maxRowLen - 1) * COL

    const pos = new Map<BddId, { x: number; y: number }>()
    rows.forEach((row, ri) => {
      const rowSpan = (row.length - 1) * COL
      const x0 = MARGIN + (span - rowSpan) / 2
      row.forEach((id, ci) => pos.set(id, { x: x0 + ci * COL, y: MARGIN + ri * ROW }))
    })
    // Terminals side by side on the bottom row.
    const terms = [...refTerminals].sort()
    const tSpan = (terms.length - 1) * COL * 1.6
    const tx0 = MARGIN + (span - tSpan) / 2
    terms.forEach((t, i) => pos.set(t, { x: tx0 + i * COL * 1.6, y: MARGIN + termRow * ROW }))

    const width = span + MARGIN * 2
    const height = termRow * ROW + MARGIN * 2

    // Highlighted path (nodes + directed edges) for the traced assignment.
    const pathNodes = new Set<BddId>()
    const pathEdges = new Set<string>()
    if (assign && traceRoot !== undefined) {
      let cur = traceRoot
      pathNodes.add(cur)
      while (cur >= 2) {
        const hi = assign[m.levelOf(cur)]
        const nxt = hi ? m.hi(cur) : m.lo(cur)
        pathEdges.add(cur + (hi ? 'H' : 'L') + nxt)
        pathNodes.add(nxt)
        cur = nxt
      }
    }

    return { rows, levels, pos, terms, width, height, pathNodes, pathEdges }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, internal, rootKey, assign, traceRoot])

  if (internal.length > maxNodes) {
    return (
      <div className="bdd-toobig">
        This BDD has <b>{internal.length}</b> nodes — too many to draw legibly. The node count and the
        symbolic operations are still exact; try a tighter formula or a better variable order to shrink it.
      </div>
    )
  }

  const { pos, terms, width, height, levels, pathNodes, pathEdges } = layout
  const edgePath = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const midY = (from.y + to.y) / 2
    return `M ${from.x} ${from.y + R} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y - R}`
  }

  return (
    <div className="bdd-diagram-wrap">
      <svg className="bdd-svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="BDD diagram">
        <defs>
          <marker id="bdd-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" className="bdd-arrowhead" />
          </marker>
          <marker id="bdd-arrow-hl" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" className="bdd-arrowhead hl" />
          </marker>
        </defs>

        {/* variable-level guide labels on the left */}
        {levels.map((lv, ri) => (
          <text key={'lvl' + lv} className="bdd-levellabel" x={6} y={MARGIN + ri * ROW + 4}>
            {m.vars[lv]}
          </text>
        ))}

        {/* edges */}
        {[...pos.keys()].filter((id) => id >= 2).flatMap((id) => {
          const from = pos.get(id)!
          const lo = m.lo(id)
          const hi = m.hi(id)
          const loHl = pathEdges.has(id + 'L' + lo)
          const hiHl = pathEdges.has(id + 'H' + hi)
          return [
            <path
              key={id + 'lo'}
              className={`bdd-edge lo${loHl ? ' hl' : ''}`}
              d={edgePath(from, pos.get(lo)!)}
              markerEnd={`url(#bdd-arrow${loHl ? '-hl' : ''})`}
            />,
            <path
              key={id + 'hi'}
              className={`bdd-edge hi${hiHl ? ' hl' : ''}`}
              d={edgePath(from, pos.get(hi)!)}
              markerEnd={`url(#bdd-arrow${hiHl ? '-hl' : ''})`}
            />,
          ]
        })}

        {/* internal nodes */}
        {[...pos.keys()].filter((id) => id >= 2).map((id) => {
          const p = pos.get(id)!
          return (
            <g key={id} className={`bdd-node${pathNodes.has(id) ? ' hl' : ''}`}>
              <circle cx={p.x} cy={p.y} r={R} />
              <text x={p.x} y={p.y + 5} className="bdd-varlabel">
                {m.vars[m.levelOf(id)]}
              </text>
            </g>
          )
        })}

        {/* terminal sinks */}
        {terms.map((t) => {
          const p = pos.get(t)!
          return (
            <g key={'t' + t} className={`bdd-term ${t === 1 ? 'one' : 'zero'}${pathNodes.has(t) ? ' hl' : ''}`}>
              <rect x={p.x - 15} y={p.y - 15} width={30} height={30} rx={4} />
              <text x={p.x} y={p.y + 6} className="bdd-termlabel">
                {t === 1 ? '1' : '0'}
              </text>
            </g>
          )
        })}

        {/* root arrows + labels */}
        {roots.map((r, i) => {
          const p = pos.get(r.id)
          if (!p) return null
          return (
            <g key={'root' + i} className="bdd-root">
              <path d={`M ${p.x} ${p.y - R - 22} L ${p.x} ${p.y - R - 2}`} markerEnd="url(#bdd-arrow)" className="bdd-rootedge" />
              {r.label && (
                <text x={p.x} y={p.y - R - 26} className="bdd-rootlabel">
                  {r.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="bdd-legend">
        <span><span className="swatch solid" /> hi edge (variable = 1)</span>
        <span><span className="swatch dashed" /> lo edge (variable = 0)</span>
        <span><span className="swatch node" /> decision node</span>
      </div>
    </div>
  )
}
