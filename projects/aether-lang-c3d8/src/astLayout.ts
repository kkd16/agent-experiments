// Tidy-tree layout for the AST visualiser. Leaves are placed left-to-right;
// internal nodes are centred over their children. Coordinates are in grid units
// that the renderer scales to pixels.

import type { Expr } from './lang/ast.ts'
import { children, nodeLabel } from './lang/ast.ts'

export interface LaidNode {
  index: number
  gx: number
  depth: number
  label: string
  expr: Expr
}

export interface LaidEdge {
  from: number
  to: number
}

export interface AstLayout {
  nodes: LaidNode[]
  edges: LaidEdge[]
  maxGx: number
  maxDepth: number
}

export function layoutAst(root: Expr): AstLayout {
  const nodes: LaidNode[] = []
  const edges: LaidEdge[] = []
  let nextLeaf = 0
  let maxDepth = 0

  const place = (e: Expr, depth: number, parent: number): number => {
    const index = nodes.length
    nodes.push({ index, gx: 0, depth, label: nodeLabel(e), expr: e })
    if (parent >= 0) edges.push({ from: parent, to: index })
    if (depth > maxDepth) maxDepth = depth

    const kids = children(e)
    let gx: number
    if (kids.length === 0) {
      gx = nextLeaf++
    } else {
      const xs = kids.map((k) => place(k, depth + 1, index))
      gx = (xs[0] + xs[xs.length - 1]) / 2
    }
    nodes[index].gx = gx
    return gx
  }

  place(root, 0, -1)
  const maxGx = nodes.reduce((m, n) => Math.max(m, n.gx), 0)
  return { nodes, edges, maxGx, maxDepth }
}
