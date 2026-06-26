// Pure layout helpers for drawing the implication graph and its condensation.
// The components consume these as data and render the SVG.

import type { TwoSatResult } from './twosat'
import { nodeToLit } from './twosat'

export interface LaidOutNode {
  node: number
  lit: number // DIMACS literal
  x: number
  y: number
  comp: number
}

export interface LaidOutEdge {
  from: number // node index
  to: number
  /** SVG cubic-bezier path d-string. */
  path: string
  /** True when both endpoints share a component (an intra-SCC edge). */
  internal: boolean
}

export interface ImplicationLayout {
  width: number
  height: number
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  /** Map node index → its laid-out position (for callers). */
  pos: Map<number, LaidOutNode>
}

const NODE_R = 16
const COL_GAP = 92
const MARGIN_X = 44
const ROW_TOP = 46
const ROW_BOT = 196

/**
 * Two-row, column-per-variable layout: positive literals on top, their
 * negations directly below — the canonical way to read a 2-SAT implication
 * graph (you see x and ¬x stacked, and the symmetry of the edges).
 */
export function layoutImplication(result: TwoSatResult): ImplicationLayout {
  const n = result.numVars
  const nodes: LaidOutNode[] = []
  const pos = new Map<number, LaidOutNode>()
  for (let v = 1; v <= n; v++) {
    const x = MARGIN_X + (v - 1) * COL_GAP
    const posNode: LaidOutNode = { node: 2 * (v - 1), lit: v, x, y: ROW_TOP, comp: result.comp[2 * (v - 1)] }
    const negNode: LaidOutNode = {
      node: 2 * (v - 1) + 1,
      lit: -v,
      x,
      y: ROW_BOT,
      comp: result.comp[2 * (v - 1) + 1],
    }
    nodes.push(posNode, negNode)
    pos.set(posNode.node, posNode)
    pos.set(negNode.node, negNode)
  }

  const edges: LaidOutEdge[] = []
  for (const e of result.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    edges.push({
      from: e.from,
      to: e.to,
      path: edgePath(a, b),
      internal: result.comp[e.from] === result.comp[e.to],
    })
  }

  const width = MARGIN_X * 2 + Math.max(0, n - 1) * COL_GAP
  const height = ROW_BOT + ROW_TOP
  return { width, height, nodes, edges, pos }
}

/** A curved arrow path between two nodes, bowed so opposite-direction edges separate. */
function edgePath(a: LaidOutNode, b: LaidOutNode): string {
  if (a.node === b.node) {
    // self-loop (shouldn't happen for 2-SAT, but be safe)
    return `M ${a.x} ${a.y - NODE_R} a ${NODE_R} ${NODE_R} 0 1 1 0.1 0`
  }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  // Trim the endpoints to the node radius.
  const ux = dx / len
  const uy = dy / len
  const sx = a.x + ux * NODE_R
  const sy = a.y + uy * NODE_R
  const ex = b.x - ux * (NODE_R + 4)
  const ey = b.y - uy * (NODE_R + 4)
  // Bow perpendicular to the edge; sign by direction so a↔b don't overlap.
  const nx = -uy
  const ny = ux
  const bow = 18 + Math.min(40, len * 0.12)
  const sign = a.node < b.node ? 1 : -1
  const cx = (sx + ex) / 2 + nx * bow * sign
  const cy = (sy + ey) / 2 + ny * bow * sign
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`
}

export interface CondNode {
  comp: number
  x: number
  y: number
  w: number
  h: number
  labels: string[] // literal strings inside this SCC
}

export interface CondEdge {
  from: number
  to: number
  path: string
}

export interface CondensationLayout {
  width: number
  height: number
  nodes: CondNode[]
  edges: CondEdge[]
}

const BOX_W = 96
const BOX_GAP_X = 150
const BOX_GAP_Y = 26
const COND_MARGIN = 30

/** Layered left→right layout of the condensation DAG using the longest-path layer. */
export function layoutCondensation(result: TwoSatResult): CondensationLayout {
  const { comps, adj, topoLayer } = result.condensation
  const count = comps.length
  // Bucket components by layer.
  const byLayer = new Map<number, number[]>()
  let maxLayer = 0
  for (let c = 0; c < count; c++) {
    const L = topoLayer[c]
    maxLayer = Math.max(maxLayer, L)
    if (!byLayer.has(L)) byLayer.set(L, [])
    byLayer.get(L)!.push(c)
  }

  const boxes = new Map<number, CondNode>()
  let maxBottom = 0
  for (let L = 0; L <= maxLayer; L++) {
    const members = (byLayer.get(L) ?? []).sort((a, b) => a - b)
    let y = COND_MARGIN
    for (const c of members) {
      const labels = comps[c].map(nodeToLit).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b).map(litLabel)
      const h = Math.max(34, 18 + labels.length * 16)
      const x = COND_MARGIN + L * BOX_GAP_X
      boxes.set(c, { comp: c, x, y, w: BOX_W, h, labels })
      y += h + BOX_GAP_Y
      maxBottom = Math.max(maxBottom, y)
    }
  }

  const nodes = [...boxes.values()]
  const edges: CondEdge[] = []
  for (let c = 0; c < count; c++) {
    const from = boxes.get(c)
    if (!from) continue
    for (const w of adj[c]) {
      const to = boxes.get(w)
      if (!to) continue
      const sx = from.x + from.w
      const sy = from.y + from.h / 2
      const ex = to.x
      const ey = to.y + to.h / 2
      const mx = (sx + ex) / 2
      edges.push({ from: c, to: w, path: `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}` })
    }
  }

  const width = COND_MARGIN * 2 + maxLayer * BOX_GAP_X + BOX_W
  const height = Math.max(80, maxBottom + COND_MARGIN - BOX_GAP_Y)
  return { width, height, nodes, edges }
}

export function litLabel(lit: number): string {
  return lit > 0 ? `x${lit}` : `¬x${-lit}`
}

/** A deterministic, readable colour per component id (HSL wheel). */
export function compColor(comp: number, total: number): string {
  if (total <= 1) return 'hsl(210 70% 58%)'
  const hue = Math.round((comp * 360) / total) % 360
  return `hsl(${hue} 64% 56%)`
}
