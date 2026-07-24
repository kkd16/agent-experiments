// A structured rectangular mesher for the plate-bending studio.
//
// The plate lies in the x–y plane over the rectangle [0,Lx]×[0,Ly], divided into
// nx×ny bilinear (Q4) cells. Every node carries three DOFs (w, θx, θy); this
// module only owns geometry and connectivity — the assembly lives in platesolve.

export type PlateEdge = 'left' | 'right' | 'bottom' | 'top'

export interface PlateMesh {
  Lx: number
  Ly: number
  nx: number
  ny: number
  nodeCount: number
  elemCount: number
  /** node x/y coordinates */
  x: Float64Array
  y: Float64Array
  /** 4 corner node indices per element (CCW: bl, br, tr, tl) */
  elems: Int32Array
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** node index from grid coordinates (0..nx, 0..ny). */
function nodeId(i: number, j: number, nx: number): number {
  return j * (nx + 1) + i
}

export function makePlateMesh(Lx: number, Ly: number, nx: number, ny: number): PlateMesh {
  const nnx = nx + 1
  const nny = ny + 1
  const nodeCount = nnx * nny
  const x = new Float64Array(nodeCount)
  const y = new Float64Array(nodeCount)
  for (let j = 0; j < nny; j++)
    for (let i = 0; i < nnx; i++) {
      const n = nodeId(i, j, nx)
      x[n] = (Lx * i) / nx
      y[n] = (Ly * j) / ny
    }
  const elemCount = nx * ny
  const elems = new Int32Array(elemCount * 4)
  let e = 0
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const bl = nodeId(i, j, nx)
      const br = nodeId(i + 1, j, nx)
      const tr = nodeId(i + 1, j + 1, nx)
      const tl = nodeId(i, j + 1, nx)
      elems[e * 4] = bl
      elems[e * 4 + 1] = br
      elems[e * 4 + 2] = tr
      elems[e * 4 + 3] = tl
      e++
    }
  return { Lx, Ly, nx, ny, nodeCount, elemCount, x, y, elems, minX: 0, maxX: Lx, minY: 0, maxY: Ly }
}

/** Node indices lying on a given edge. */
export function edgeNodes(mesh: PlateMesh, edge: PlateEdge): number[] {
  const { nx, ny } = mesh
  const out: number[] = []
  if (edge === 'left') for (let j = 0; j <= ny; j++) out.push(nodeId(0, j, nx))
  else if (edge === 'right') for (let j = 0; j <= ny; j++) out.push(nodeId(nx, j, nx))
  else if (edge === 'bottom') for (let i = 0; i <= nx; i++) out.push(nodeId(i, 0, nx))
  else for (let i = 0; i <= nx; i++) out.push(nodeId(i, ny, nx))
  return out
}

/** The node closest to a world point (for placing a point load / support). */
export function nearestNode(mesh: PlateMesh, px: number, py: number): number {
  let best = 0
  let bestD = Infinity
  for (let n = 0; n < mesh.nodeCount; n++) {
    const d = (mesh.x[n] - px) ** 2 + (mesh.y[n] - py) ** 2
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return best
}

/** The interior node nearest the plate centre (for a central point load). */
export function centreNode(mesh: PlateMesh): number {
  return nearestNode(mesh, mesh.Lx / 2, mesh.Ly / 2)
}
