// Structured quadrilateral meshers for the isoparametric (Q4/Q8) continuum
// solver. These mirror the CST triangle meshers in mesh.ts — the same parametric
// engineering domains (plate, cantilever, plate-with-hole, L-bracket) — but emit
// 4- or 8-node quadrilaterals instead of splitting every cell into two triangles.
//
// For Q8 the four mid-side nodes are generated per cell and de-duplicated by
// coordinate so adjacent elements share them (a conforming mesh). Dropped cells
// (inside a hole, outside a bracket) never create their nodes, so orphans don't
// appear.

import type { EdgeName } from './mesh'
import type { QOrder } from './isoparam'
import { EDGE_NODES } from './isoparam'

export type { EdgeName }

export interface QuadMesh {
  order: QOrder
  nodeCount: number
  x: Float64Array
  y: Float64Array
  /** `order` node indices per element, row-major. */
  elems: Int32Array
  elemCount: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  label: string
}

class NodeSet {
  xs: number[] = []
  ys: number[] = []
  private map = new Map<string, number>()
  at(x: number, y: number): number {
    const k = `${Math.round(x * 1e7)},${Math.round(y * 1e7)}`
    const found = this.map.get(k)
    if (found !== undefined) return found
    const id = this.xs.length
    this.xs.push(x)
    this.ys.push(y)
    this.map.set(k, id)
    return id
  }
}

function gridQuadMesh(
  order: QOrder,
  x0: number,
  y0: number,
  W: number,
  H: number,
  nx: number,
  ny: number,
  label: string,
  keep?: (cx: number, cy: number) => boolean,
): QuadMesh {
  const ns = new NodeSet()
  const elems: number[] = []
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x1 = x0 + (i / nx) * W
      const x2 = x0 + ((i + 1) / nx) * W
      const y1 = y0 + (j / ny) * H
      const y2 = y0 + ((j + 1) / ny) * H
      const cx = (x1 + x2) / 2
      const cy = (y1 + y2) / 2
      if (keep && !keep(cx, cy)) continue
      // Corner nodes, CCW from bottom-left.
      const n0 = ns.at(x1, y1)
      const n1 = ns.at(x2, y1)
      const n2 = ns.at(x2, y2)
      const n3 = ns.at(x1, y2)
      if (order === 4) {
        elems.push(n0, n1, n2, n3)
      } else {
        const n4 = ns.at(cx, y1) // bottom mid
        const n5 = ns.at(x2, cy) // right mid
        const n6 = ns.at(cx, y2) // top mid
        const n7 = ns.at(x1, cy) // left mid
        elems.push(n0, n1, n2, n3, n4, n5, n6, n7)
      }
    }
  const x = Float64Array.from(ns.xs)
  const y = Float64Array.from(ns.ys)
  return {
    order,
    nodeCount: x.length,
    x,
    y,
    elems: Int32Array.from(elems),
    elemCount: elems.length / order,
    minX: Math.min(...ns.xs),
    maxX: Math.max(...ns.xs),
    minY: Math.min(...ns.ys),
    maxY: Math.max(...ns.ys),
    label,
  }
}

export function rectPlateQ(order: QOrder, W: number, H: number, nx: number, ny: number): QuadMesh {
  return gridQuadMesh(order, 0, 0, W, H, nx, ny, 'Plate')
}

export function cantileverMeshQ(order: QOrder, L: number, h: number, nx: number, ny: number): QuadMesh {
  return gridQuadMesh(order, 0, -h / 2, L, h, nx, ny, 'Cantilever')
}

export function plateWithHoleQ(
  order: QOrder,
  W: number,
  H: number,
  r: number,
  nx: number,
  ny: number,
): QuadMesh {
  const cx = W / 2
  const cy = H / 2
  return gridQuadMesh(order, 0, 0, W, H, nx, ny, 'Plate with hole', (x, y) => Math.hypot(x - cx, y - cy) > r)
}

export function lBracketQ(order: QOrder, W: number, H: number, nx: number, ny: number): QuadMesh {
  const legX = W * 0.45
  const legY = H * 0.45
  return gridQuadMesh(order, 0, 0, W, H, nx, ny, 'L-bracket', (x, y) => !(x > legX && y > legY))
}

const edgeEps = (m: QuadMesh) => 1e-7 * Math.max(m.maxX - m.minX, m.maxY - m.minY)

/** Is node `n` on the named bounding-box edge? */
export function onEdge(m: QuadMesh, n: number, edge: EdgeName): boolean {
  const eps = edgeEps(m)
  if (edge === 'left') return Math.abs(m.x[n] - m.minX) <= eps
  if (edge === 'right') return Math.abs(m.x[n] - m.maxX) <= eps
  if (edge === 'bottom') return Math.abs(m.y[n] - m.minY) <= eps
  return Math.abs(m.y[n] - m.maxY) <= eps
}

/** All node indices on the named edge (includes Q8 mid-side nodes). */
export function edgeNodesQ(m: QuadMesh, edge: EdgeName): number[] {
  const out: number[] = []
  for (let n = 0; n < m.nodeCount; n++) if (onEdge(m, n, edge)) out.push(n)
  return out
}

/**
 * Element edges lying on the named boundary, as ordered local→global node lists
 * ([corner, corner] for Q4; [corner, mid, corner] for Q8). Used to turn an edge
 * traction into consistent nodal forces.
 */
export function boundaryElementEdges(m: QuadMesh, edge: EdgeName): number[][] {
  const local = EDGE_NODES[m.order]
  const out: number[][] = []
  for (let e = 0; e < m.elemCount; e++) {
    const base = e * m.order
    for (const le of local) {
      const c1 = m.elems[base + le[0]]
      const c2 = m.elems[base + le[le.length - 1]]
      if (onEdge(m, c1, edge) && onEdge(m, c2, edge)) {
        out.push(le.map((li) => m.elems[base + li]))
      }
    }
  }
  return out
}

/** Node nearest a target point (for pinning a single DOF). */
export function nodeNearestQ(m: QuadMesh, px: number, py: number): number {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < m.nodeCount; i++) {
    const d = (m.x[i] - px) ** 2 + (m.y[i] - py) ** 2
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}
