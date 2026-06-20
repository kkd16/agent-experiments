// Turn a BDD into a positioned graph for SVG rendering. Pure data — no DOM.
//
// Internal nodes are stacked by level (variable order, root at top); terminals
// sit on a final row. Within a level, nodes keep depth-first discovery order,
// which tends to keep edges short. The 1-edge (high) is drawn solid, the 0-edge
// (low) dashed — the universal BDD drawing convention.

import { Bdd } from './bdd'
import type { NodeId } from './bdd'

export interface LaidNode {
  id: NodeId
  /** Variable index, or -1 for terminals. */
  v: number
  label: string
  x: number
  y: number
  level: number
  terminal: boolean
}

export interface LaidEdge {
  from: NodeId
  to: NodeId
  kind: 'lo' | 'hi'
}

export interface Layout {
  nodes: LaidNode[]
  edges: LaidEdge[]
  width: number
  height: number
  size: number // internal node count
}

const COL_W = 76
const ROW_H = 78
const MARGIN_X = 48
const MARGIN_Y = 44

export function layoutBdd(bdd: Bdd, root: NodeId, varNames?: string[]): Layout {
  const byLevel = new Map<number, NodeId[]>()
  const seen = new Set<NodeId>()
  let usesFalse = false
  let usesTrue = false
  const edges: LaidEdge[] = []

  const visit = (n: NodeId): void => {
    if (n === 0) {
      usesFalse = true
      return
    }
    if (n === 1) {
      usesTrue = true
      return
    }
    if (seen.has(n)) return
    seen.add(n)
    const lvl = bdd.levelOf(n)
    const row = byLevel.get(lvl)
    if (row) row.push(n)
    else byLevel.set(lvl, [n])
    visit(bdd.low(n))
    visit(bdd.high(n))
    edges.push({ from: n, to: bdd.low(n), kind: 'lo' })
    edges.push({ from: n, to: bdd.high(n), kind: 'hi' })
  }
  visit(root)

  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  const maxRow = Math.max(1, ...[...byLevel.values()].map((r) => r.length), usesFalse || usesTrue ? 2 : 1)
  const width = MARGIN_X * 2 + (maxRow - 1) * COL_W
  const terminalRow = (levels.length ? Math.max(...levels) : -1) + 1
  const height = MARGIN_Y * 2 + terminalRow * ROW_H

  const nodes: LaidNode[] = []
  const xy = new Map<NodeId, { x: number; y: number }>()

  // Map a level to a display row index (compact — skip empty levels).
  const rowIndexOf = new Map<number, number>()
  levels.forEach((lvl, i) => rowIndexOf.set(lvl, i))
  const totalRows = levels.length + 1 // + terminal row

  const placeRow = (members: NodeId[], rowIdx: number) => {
    const count = members.length
    const y = MARGIN_Y + rowIdx * ROW_H
    members.forEach((id, i) => {
      // center this row within the canvas width
      const rowWidth = (count - 1) * COL_W
      const x = (width - rowWidth) / 2 + i * COL_W
      xy.set(id, { x, y })
      const v = bdd.varOf(id)
      nodes.push({
        id,
        v,
        label: varNames && varNames[v] !== undefined ? varNames[v] : `x${v}`,
        x,
        y,
        level: bdd.levelOf(id),
        terminal: false,
      })
    })
  }

  levels.forEach((lvl, i) => placeRow(byLevel.get(lvl)!, i))

  // terminals
  const termY = MARGIN_Y + (totalRows - 1) * ROW_H
  const terms: NodeId[] = []
  if (usesFalse) terms.push(0)
  if (usesTrue) terms.push(1)
  terms.forEach((id, i) => {
    const rowWidth = (terms.length - 1) * COL_W
    const x = (width - rowWidth) / 2 + i * COL_W
    xy.set(id, { x, y: termY })
    nodes.push({ id, v: -1, label: id === 1 ? '1' : '0', x, y: termY, level: terminalRow, terminal: true })
  })

  return { nodes, edges, width, height, size: seen.size }
}
