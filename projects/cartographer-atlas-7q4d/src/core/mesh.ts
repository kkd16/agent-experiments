// Build the dual mesh that everything else runs on. We scatter jittered points,
// relax them for even spacing, triangulate with Delaunator, then derive the
// Voronoi cells (region polygons), region adjacency, and triangle circumcenters.
//
// A ring of "frame" points is added around the map so that every real (solid)
// region is fully enclosed — its Voronoi cell is always a closed polygon, which
// keeps rendering and neighbour walks simple and correct.

import Delaunator from 'delaunator'
import { Rng } from './rng'
import type { Mesh, WorldParams } from './types'

const nextHalfedge = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1)
const triangleOfEdge = (e: number): number => Math.floor(e / 3)

/** Circumcentre of a triangle; falls back to the centroid if degenerate. */
function circumcenter(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): [number, number] {
  const ad = ax * ax + ay * ay
  const bd = bx * bx + by * by
  const cd = cx * cx + cy * cy
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) return [(ax + bx + cx) / 3, (ay + by + cy) / 3]
  const ux = (ad * (by - cy) + bd * (cy - ay) + cd * (ay - by)) / d
  const uy = (ad * (cx - bx) + bd * (ax - cx) + cd * (bx - ax)) / d
  return [ux, uy]
}

/** Delaunay neighbours of every point, as an adjacency list. */
function buildNeighbors(triangles: Uint32Array, n: number): number[][] {
  const neighbors: number[][] = Array.from({ length: n }, () => [])
  const seen = new Set<number>()
  for (let e = 0; e < triangles.length; e++) {
    const a = triangles[e]
    const b = triangles[nextHalfedge(e)]
    const key = a * n + b
    if (!seen.has(key)) {
      seen.add(key)
      neighbors[a].push(b)
    }
  }
  return neighbors
}

/** One Laplacian relaxation pass: nudge each solid point toward its neighbours'
 * mean. Cheaper than full Lloyd relaxation but visually just as even. */
function relax(
  px: Float64Array,
  py: Float64Array,
  numSolid: number,
  neighbors: number[][],
): void {
  for (let i = 0; i < numSolid; i++) {
    const nb = neighbors[i]
    if (nb.length === 0) continue
    let sx = 0
    let sy = 0
    for (const j of nb) {
      sx += px[j]
      sy += py[j]
    }
    // Blend 60% toward the neighbour centroid — enough to smooth, not so much
    // that the field collapses.
    px[i] = px[i] * 0.4 + (sx / nb.length) * 0.6
    py[i] = py[i] * 0.4 + (sy / nb.length) * 0.6
  }
}

export function buildMesh(params: WorldParams, relaxIters = 2): Mesh {
  const { width, height, regions } = params
  const rng = new Rng(`${params.seed}:mesh`)
  const spacing = Math.sqrt((width * height) / regions)
  const margin = spacing * 1.2

  // --- Solid interior points on a jittered grid ---
  const cols = Math.max(2, Math.floor((width - 2 * margin) / spacing))
  const rows = Math.max(2, Math.floor((height - 2 * margin) / spacing))
  const stepX = (width - 2 * margin) / cols
  const stepY = (height - 2 * margin) / rows
  const xs: number[] = []
  const ys: number[] = []
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const jx = (rng.next() - 0.5) * stepX * 0.85
      const jy = (rng.next() - 0.5) * stepY * 0.85
      xs.push(margin + i * stepX + jx)
      ys.push(margin + j * stepY + jy)
    }
  }
  const numSolid = xs.length

  // --- Frame ring: points along and just outside the border, so no solid point
  // ever lands on the convex hull. These become permanent ocean. ---
  const framePer = Math.max(cols, rows) + 2
  for (let i = 0; i <= framePer; i++) {
    const t = i / framePer
    // just-inside edge
    xs.push(t * width, t * width, 0, width)
    ys.push(0, height, t * height, t * height)
    // just-outside edge (guarantees enclosure)
    xs.push(t * width, t * width, -margin, width + margin)
    ys.push(-margin, height + margin, t * height, t * height)
  }
  const numRegions = xs.length

  const px = Float64Array.from(xs)
  const py = Float64Array.from(ys)
  const pack = (): Float64Array => {
    const coords = new Float64Array(numRegions * 2)
    for (let i = 0; i < numRegions; i++) {
      coords[2 * i] = px[i]
      coords[2 * i + 1] = py[i]
    }
    return coords
  }

  // --- Relax solid points for even spacing ---
  for (let iter = 0; iter < relaxIters; iter++) {
    const d = new Delaunator(pack())
    relax(px, py, numSolid, buildNeighbors(d.triangles, numRegions))
  }

  // --- Final triangulation and derived structures ---
  {
    const d = new Delaunator(pack())
    const triangles = d.triangles
    const halfedges = d.halfedges
    const neighbors = buildNeighbors(triangles, numRegions)

    // --- Circumcentres (Voronoi vertices) ---
    const numTriangles = triangles.length / 3
    const cx = new Float64Array(numTriangles)
    const cy = new Float64Array(numTriangles)
    for (let t = 0; t < numTriangles; t++) {
      const a = triangles[3 * t]
      const b = triangles[3 * t + 1]
      const c = triangles[3 * t + 2]
      const [ux, uy] = circumcenter(px[a], py[a], px[b], py[b], px[c], py[c])
      cx[t] = ux
      cy[t] = uy
    }

    // --- Starting incoming half-edge for each region (for the cell walk) ---
    const inedges = new Int32Array(numRegions).fill(-1)
    for (let e = 0; e < triangles.length; e++) {
      const endpoint = triangles[nextHalfedge(e)]
      if (inedges[endpoint] === -1) inedges[endpoint] = e
    }

    // --- Ordered Voronoi cell (triangle fan) per solid region ---
    const cellTriangles: number[][] = Array.from({ length: numRegions }, () => [])
    for (let r = 0; r < numSolid; r++) {
      const start = inedges[r]
      if (start === -1) continue
      const tris: number[] = []
      let incoming = start
      let guard = 0
      do {
        tris.push(triangleOfEdge(incoming))
        const outgoing = nextHalfedge(incoming)
        incoming = halfedges[outgoing]
        if (++guard > 64) break
      } while (incoming !== -1 && incoming !== start)
      cellTriangles[r] = tris
    }

    const isFrame = new Uint8Array(numRegions)
    for (let i = numSolid; i < numRegions; i++) isFrame[i] = 1

    return {
      px,
      py,
      numRegions,
      numSolid,
      cx,
      cy,
      numTriangles,
      cellTriangles,
      triangles,
      halfedges,
      neighbors,
      isFrame,
    }
  }
}
