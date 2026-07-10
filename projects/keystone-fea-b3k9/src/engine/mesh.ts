// Structured triangle meshers for the continuum solver. Free-form Delaunay
// meshing is out of scope (and well covered elsewhere in the catalog); Keystone
// meshes a handful of parametric engineering domains — a plate, a cantilever, a
// plate with a central hole, an L-bracket — by splitting a regular grid of
// quads into constant-strain triangles. Elements outside the domain (inside a
// hole, outside the bracket) are simply dropped and their orphan nodes ignored.

export type EdgeName = 'left' | 'right' | 'top' | 'bottom'

export interface Mesh {
  nodeCount: number
  x: Float64Array
  y: Float64Array
  tris: Int32Array // 3 node indices per triangle
  triCount: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  label: string
}

function finalize(
  x: number[],
  y: number[],
  tris: number[],
  label: string,
): Mesh {
  return {
    nodeCount: x.length,
    x: Float64Array.from(x),
    y: Float64Array.from(y),
    tris: Int32Array.from(tris),
    triCount: tris.length / 3,
    minX: Math.min(...x),
    maxX: Math.max(...x),
    minY: Math.min(...y),
    maxY: Math.max(...y),
    label,
  }
}

/**
 * Grid mesh over [x0, x0+W] × [y0, y0+H] with nx·ny cells, each split into two
 * triangles. `keep` optionally rejects a cell by its centroid (used to carve
 * holes and non-rectangular outlines). Orphan nodes are left in place but carry
 * no elements, so the solver clamps them harmlessly.
 */
function gridMesh(
  x0: number,
  y0: number,
  W: number,
  H: number,
  nx: number,
  ny: number,
  label: string,
  keep?: (cx: number, cy: number) => boolean,
): Mesh {
  const xs: number[] = []
  const ys: number[] = []
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      xs.push(x0 + (i / nx) * W)
      ys.push(y0 + (j / ny) * H)
    }
  const idx = (i: number, j: number) => j * (nx + 1) + i
  const tris: number[] = []
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const cx = x0 + ((i + 0.5) / nx) * W
      const cy = y0 + ((j + 0.5) / ny) * H
      if (keep && !keep(cx, cy)) continue
      const a = idx(i, j)
      const b = idx(i + 1, j)
      const c = idx(i + 1, j + 1)
      const d = idx(i, j + 1)
      // Alternate the diagonal for a symmetric, less biased mesh.
      if ((i + j) % 2 === 0) {
        tris.push(a, b, c, a, c, d)
      } else {
        tris.push(a, b, d, b, c, d)
      }
    }
  return finalize(xs, ys, tris, label)
}

export function rectPlate(W: number, H: number, nx: number, ny: number): Mesh {
  return gridMesh(0, 0, W, H, nx, ny, 'Plate')
}

/** Cantilever domain centred on y = 0 so the neutral axis matches beam theory. */
export function cantileverMesh(L: number, h: number, nx: number, ny: number): Mesh {
  return gridMesh(0, -h / 2, L, h, nx, ny, 'Cantilever')
}

/** Plate of size W×H with a central circular hole of radius r (approximate). */
export function plateWithHole(W: number, H: number, r: number, nx: number, ny: number): Mesh {
  const cx = W / 2
  const cy = H / 2
  return gridMesh(0, 0, W, H, nx, ny, 'Plate with hole', (x, y) => Math.hypot(x - cx, y - cy) > r)
}

/** L-shaped bracket: full W×H grid minus the top-right rectangular notch. */
export function lBracket(W: number, H: number, nx: number, ny: number): Mesh {
  const legX = W * 0.45
  const legY = H * 0.45
  return gridMesh(0, 0, W, H, nx, ny, 'L-bracket', (x, y) => !(x > legX && y > legY))
}

/** Node indices lying on a named bounding-box edge. */
export function edgeNodes(mesh: Mesh, edge: EdgeName): number[] {
  const eps = 1e-9 * Math.max(mesh.maxX - mesh.minX, mesh.maxY - mesh.minY)
  const out: number[] = []
  for (let i = 0; i < mesh.nodeCount; i++) {
    const on =
      (edge === 'left' && Math.abs(mesh.x[i] - mesh.minX) <= eps) ||
      (edge === 'right' && Math.abs(mesh.x[i] - mesh.maxX) <= eps) ||
      (edge === 'bottom' && Math.abs(mesh.y[i] - mesh.minY) <= eps) ||
      (edge === 'top' && Math.abs(mesh.y[i] - mesh.maxY) <= eps)
    if (on) out.push(i)
  }
  return out
}

/**
 * Boundary segments on a named edge, as consecutive node pairs sorted along the
 * edge. Used to convert an edge traction into consistent nodal forces.
 */
export function edgeSegments(mesh: Mesh, edge: EdgeName): [number, number][] {
  const nodes = edgeNodes(mesh, edge)
  const along = edge === 'left' || edge === 'right' ? mesh.y : mesh.x
  nodes.sort((a, b) => along[a] - along[b])
  const segs: [number, number][] = []
  for (let i = 0; i + 1 < nodes.length; i++) segs.push([nodes[i], nodes[i + 1]])
  return segs
}

/** The node on `edge` closest to the given along-edge coordinate. */
export function nodeNearest(mesh: Mesh, px: number, py: number): number {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < mesh.nodeCount; i++) {
    const d = (mesh.x[i] - px) ** 2 + (mesh.y[i] - py) ** 2
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}
