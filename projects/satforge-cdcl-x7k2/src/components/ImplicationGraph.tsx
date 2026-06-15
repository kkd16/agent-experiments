import { useMemo } from 'react'
import type { ConflictSnapshot } from '../sat'

// Renders the implication graph of the first conflict: the backward cone of
// assignments that forced the contradiction. Decision nodes are diamonds,
// implied literals are circles, and κ is the conflict node.

interface LaidNode {
  lit: number
  level: number
  reason: number
  decision: boolean
  x: number
  y: number
}

export function ImplicationGraph({ snapshot }: { snapshot: ConflictSnapshot }) {
  const layout = useMemo(() => buildLayout(snapshot), [snapshot])
  if (!layout) return <p className="muted">The conflict graph is empty (root-level conflict).</p>
  const { nodes, edges, conflict, width, height, truncated, totalRelevant } = layout

  return (
    <div className="impl-graph">
      <p className="muted">
        Backward implication cone of the first conflict — every assignment that, through unit
        propagation, forced the contradiction κ. Diamonds are decisions; circles are propagated
        literals (labelled <code>literal@level</code>).
        {truncated && ` Showing ${nodes.length} of ${totalRelevant} nodes.`}
      </p>
      <div className="impl-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="impl-svg">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="rgba(148,163,184,0.8)" />
            </marker>
            <marker id="arrow-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#ef476f" />
            </marker>
          </defs>
          {edges.map((e, i) => (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              className={e.toConflict ? 'edge edge-conflict' : 'edge'}
              markerEnd={e.toConflict ? 'url(#arrow-c)' : 'url(#arrow)'}
            />
          ))}
          {nodes.map((n) => (
            <g key={n.lit} transform={`translate(${n.x},${n.y})`}>
              {n.decision ? (
                <rect x={-22} y={-15} width={44} height={30} transform="rotate(45 0 0)" className="node node-decision" />
              ) : (
                <circle r={19} className="node node-implied" />
              )}
              <text className="node-label" textAnchor="middle" dy={4}>
                {fmtLit(n.lit)}@{n.level}
              </text>
            </g>
          ))}
          <g transform={`translate(${conflict.x},${conflict.y})`}>
            <circle r={18} className="node node-conflict" />
            <text className="node-label" textAnchor="middle" dy={5}>
              κ
            </text>
          </g>
        </svg>
      </div>
    </div>
  )
}

const MAX_NODES = 70

function buildLayout(snap: ConflictSnapshot) {
  // Index every assigned literal by its true form.
  const byLit = new Map<number, (typeof snap.nodes)[number]>()
  for (const n of snap.nodes) byLit.set(n.lit, n)

  // Backward reachability from the conflict.
  const relevant = new Set<number>()
  const queue: number[] = []
  for (const q of snap.conflictClause) {
    const ante = byLit.get(-q)
    if (ante) {
      if (!relevant.has(ante.lit)) {
        relevant.add(ante.lit)
        queue.push(ante.lit)
      }
    }
  }
  while (queue.length) {
    const lit = queue.shift()!
    const node = byLit.get(lit)!
    for (const q of node.reasonLits) {
      if (q === lit) continue
      const ante = byLit.get(-q)
      if (ante && !relevant.has(ante.lit)) {
        relevant.add(ante.lit)
        queue.push(ante.lit)
      }
    }
  }
  if (relevant.size === 0) return null

  // Keep the highest-level nodes if too large (closest to the conflict).
  let chosen = [...relevant].map((l) => byLit.get(l)!)
  const totalRelevant = chosen.length
  const truncated = chosen.length > MAX_NODES
  if (truncated) {
    chosen.sort((a, b) => b.level - a.level)
    chosen = chosen.slice(0, MAX_NODES)
  }
  const keep = new Set(chosen.map((n) => n.lit))

  // Layered layout: x by decision level, y stacked within level.
  const levels = [...new Set(chosen.map((n) => n.level))].sort((a, b) => a - b)
  const levelIndex = new Map(levels.map((lv, i) => [lv, i]))
  const perLevel = new Map<number, number>()
  const colW = 150
  const rowH = 66
  const padX = 60
  const padY = 44

  const laid: LaidNode[] = chosen.map((n) => {
    const li = levelIndex.get(n.level)!
    const row = perLevel.get(n.level) ?? 0
    perLevel.set(n.level, row + 1)
    return {
      lit: n.lit,
      level: n.level,
      reason: n.reason,
      decision: n.reason === -1,
      x: padX + li * colW,
      y: padY + row * rowH,
    }
  })
  const posByLit = new Map(laid.map((n) => [n.lit, n]))
  const maxRows = Math.max(...[...perLevel.values()], 1)

  const conflictX = padX + levels.length * colW
  const conflictY = padY + ((maxRows - 1) * rowH) / 2

  // Edges.
  const edges: { x1: number; y1: number; x2: number; y2: number; toConflict: boolean }[] = []
  for (const n of laid) {
    const node = byLit.get(n.lit)!
    for (const q of node.reasonLits) {
      if (q === n.lit) continue
      const ante = posByLit.get(-q)
      if (ante) edges.push({ x1: ante.x, y1: ante.y, x2: n.x, y2: n.y, toConflict: false })
    }
  }
  for (const q of snap.conflictClause) {
    const ante = posByLit.get(-q)
    if (ante) edges.push({ x1: ante.x, y1: ante.y, x2: conflictX, y2: conflictY, toConflict: true })
  }

  const width = conflictX + padX
  const height = padY * 2 + maxRows * rowH
  return {
    nodes: laid,
    edges,
    conflict: { x: conflictX, y: conflictY },
    width,
    height,
    truncated,
    totalRelevant,
    keep,
  }
}

function fmtLit(d: number): string {
  return d < 0 ? `¬x${-d}` : `x${d}`
}
