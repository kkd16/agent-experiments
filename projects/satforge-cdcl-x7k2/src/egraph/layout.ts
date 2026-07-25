// Positions an e-graph for the SVG view. Each e-class becomes a box holding its
// e-nodes; each e-node draws an edge from its row to every child *class*. Classes
// are laid out in columns by depth. Depth is a shortest-derivation level (min
// over a class's nodes of 1 + max child level), which stays finite even though a
// saturated e-graph is cyclic — e.g. after `x + 0 → x` the node `+(x,0)` lives in
// x's own class and points back at it.

import type { EGraph, EClassId } from './egraph'

export interface EgNodeRow {
  label: string
  children: EClassId[]
}

export interface EgBox {
  id: EClassId
  x: number
  y: number
  w: number
  h: number
  rows: EgNodeRow[]
  data: bigint | null
  isRoot: boolean
}

export interface EgEdge {
  path: string
  child: EClassId
}

export interface EgLayout {
  width: number
  height: number
  boxes: EgBox[]
  edges: EgEdge[]
  byId: Map<EClassId, EgBox>
}

const HEADER = 18
const ROW_H = 18
const CHAR_W = 8
const MIN_W = 46
const COL_GAP = 92
const ROW_GAP = 16
const PAD = 16

function nodeLabel(op: string): string {
  return op
}

/** Assign a cycle-safe depth level to every live class. */
function levels(eg: EGraph, roots: EClassId[]): Map<EClassId, number> {
  const lvl = new Map<EClassId, number>()
  for (const id of roots) lvl.set(id, Number.POSITIVE_INFINITY)
  let changed = true
  let guard = 0
  while (changed && guard++ < roots.length + 4) {
    changed = false
    for (const id of roots) {
      let best = Number.POSITIVE_INFINITY
      for (const n of eg.nodesOf(id)) {
        if (n.children.length === 0) {
          best = 0
          break
        }
        let cand = 0
        let ok = true
        for (const ch of n.children) {
          const cl = lvl.get(eg.find(ch)) ?? Number.POSITIVE_INFINITY
          if (cl === Number.POSITIVE_INFINITY) {
            ok = false
            break
          }
          cand = Math.max(cand, cl + 1)
        }
        if (ok) best = Math.min(best, cand)
      }
      if (best < (lvl.get(id) ?? Number.POSITIVE_INFINITY)) {
        lvl.set(id, best)
        changed = true
      }
    }
  }
  // Any class still unreached (shouldn't happen) drops to level 0.
  for (const id of roots) if (!Number.isFinite(lvl.get(id)!)) lvl.set(id, 0)
  return lvl
}

export function layoutEgraph(eg: EGraph, rootId: EClassId): EgLayout {
  const roots = eg.liveRoots()
  const lvl = levels(eg, roots)
  const rootCanon = eg.find(rootId)

  // Build the boxes (without positions yet).
  const boxes: EgBox[] = []
  const byId = new Map<EClassId, EgBox>()
  for (const id of roots) {
    const rows: EgNodeRow[] = eg.nodesOf(id).map((n) => ({
      label: nodeLabel(n.op),
      children: n.children.map((c) => eg.find(c)),
    }))
    const w = Math.max(MIN_W, ...rows.map((r) => r.label.length * CHAR_W + 16))
    const h = HEADER + Math.max(1, rows.length) * ROW_H + 6
    const box: EgBox = { id, x: 0, y: 0, w, h, rows, data: eg.constantOf(id), isRoot: id === rootCanon }
    boxes.push(box)
    byId.set(id, box)
  }

  // Group by level and stack.
  const maxLevel = Math.max(0, ...roots.map((id) => lvl.get(id) ?? 0))
  const cols: EgBox[][] = Array.from({ length: maxLevel + 1 }, () => [])
  for (const box of boxes) cols[lvl.get(box.id) ?? 0].push(box)

  let x = PAD
  let height = 0
  for (const col of cols) {
    const colW = Math.max(MIN_W, ...col.map((b) => b.w), 0)
    let y = PAD
    // Sort within a column for stable output.
    col.sort((p, q) => p.id - q.id)
    for (const box of col) {
      box.x = x + (colW - box.w) / 2
      box.y = y
      y += box.h + ROW_GAP
    }
    height = Math.max(height, y)
    x += colW + COL_GAP
  }
  const width = x - COL_GAP + PAD

  // Edges: node row → child box (curved).
  const edges: EgEdge[] = []
  for (const box of boxes) {
    box.rows.forEach((row, ri) => {
      const y0 = box.y + HEADER + ri * ROW_H + ROW_H / 2
      const x0 = box.x + box.w
      for (const ch of row.children) {
        const target = byId.get(ch)
        if (!target) continue
        const x1 = target.x
        const y1 = target.y + target.h / 2
        const dx = Math.max(30, Math.abs(x1 - x0) * 0.4)
        const path =
          x1 >= x0
            ? `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`
            : // back-edge (cycle / reordered layout): loop out to the right and around
              `M ${x0} ${y0} C ${x0 + 40} ${y0 - 26}, ${x1 - 40} ${y1 - 26}, ${x1} ${y1}`
        edges.push({ path, child: ch })
      }
    })
  }

  return { width: Math.max(width, 120), height: height + PAD, boxes, edges, byId }
}
