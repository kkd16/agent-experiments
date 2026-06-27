import type { Circle, Edge, Point, Rect, VoronoiCell } from './types'
import { convexHull } from './convexHull'
import { delaunay, triangulationEdges } from './delaunay'
import { circumcircle } from './predicates'
import { voronoiCells } from './voronoi'
import { euclideanMST, gabrielGraph, totalLength } from './graphs'
import { centroid } from './polygon'

// Derives every structure the studio can display from a single point set, with
// per-stage timings for the stats panel. Optional stages (Gabriel graph) are
// skipped unless requested so the common case stays fast.

export interface GeometryResult {
  hull: number[]
  delaunayEdges: Edge[]
  triangleCount: number
  cells: VoronoiCell[]
  circumcircles: Circle[]
  centroids: Point[]
  mst: Edge[]
  gabriel: Edge[]
  mstLength: number
  timings: { delaunay: number; voronoi: number; total: number }
}

const EMPTY: GeometryResult = {
  hull: [],
  delaunayEdges: [],
  triangleCount: 0,
  cells: [],
  circumcircles: [],
  centroids: [],
  mst: [],
  gabriel: [],
  mstLength: 0,
  timings: { delaunay: 0, voronoi: 0, total: 0 },
}

export function computeGeometry(points: Point[], clip: Rect, opts: { gabriel: boolean }): GeometryResult {
  if (points.length === 0) return EMPTY
  const t0 = performance.now()

  const hull = convexHull(points)

  const td0 = performance.now()
  const tris = points.length >= 3 ? delaunay(points) : []
  const delaunayEdges = triangulationEdges(tris)
  const td1 = performance.now()

  const circumcircles: Circle[] = []
  for (const t of tris) {
    const c = circumcircle(points[t.a], points[t.b], points[t.c])
    if (c) circumcircles.push(c)
  }

  const tv0 = performance.now()
  const cells = voronoiCells(points, clip)
  const tv1 = performance.now()

  const centroids: Point[] = []
  for (const cell of cells) {
    if (cell.polygon.length >= 3) centroids.push(centroid(cell.polygon))
  }

  const mst = euclideanMST(points, delaunayEdges)
  const gabriel = opts.gabriel ? gabrielGraph(points, delaunayEdges) : []

  return {
    hull,
    delaunayEdges,
    triangleCount: tris.length,
    cells,
    circumcircles,
    centroids,
    mst,
    gabriel,
    mstLength: totalLength(points, mst),
    timings: { delaunay: td1 - td0, voronoi: tv1 - tv0, total: performance.now() - t0 },
  }
}
