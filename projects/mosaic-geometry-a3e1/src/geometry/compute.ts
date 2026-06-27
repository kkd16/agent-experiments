import type { Circle, Edge, Point, Rect, Triangle, VoronoiCell } from './types'
import { convexHull } from './convexHull'
import { delaunay, triangulationEdges } from './delaunay'
import { circumcircle } from './predicates'
import { voronoiCells } from './voronoi'
import {
  euclideanMST,
  gabrielGraph,
  relativeNeighborhoodGraph,
  nearestNeighborGraph,
  urquhartGraph,
  closestPair,
  totalLength,
  type ClosestPair,
} from './graphs'
import { centroid } from './polygon'
import {
  diameter,
  minWidth,
  perimeter,
  hullArea,
  convexLayers,
  type FarthestPair,
  type MinWidth,
} from './hullMetrics'
import { minimumEnclosingCircle } from './enclosingCircle'
import { largestEmptyCircle, type EmptyCircle } from './emptyCircle'

// Derives every structure the studio can display from a single point set, with
// per-stage timings for the stats panel. The Delaunay triangulation is the
// backbone: the proximity graphs, alpha shapes, closest pair and largest empty
// circle all read off it. Heavier optional layers (Gabriel/RNG/NNG/Urquhart and
// the convex-layer peeling) are gated by `opts` so the common case stays fast;
// the cheap O(n)/O(h) measurements (hull metrics, MEC, LEC) are always computed.

export interface ComputeOpts {
  gabriel: boolean
  proximity: boolean // relative-neighborhood + nearest-neighbor + Urquhart graphs
  layers: boolean // convex layers (onion peeling)
}

export interface GeometryResult {
  hull: number[]
  triangles: Triangle[]
  delaunayEdges: Edge[]
  triangleCount: number
  cells: VoronoiCell[]
  circumcircles: Circle[]
  centroids: Point[]
  mst: Edge[]
  gabriel: Edge[]
  rng: Edge[]
  nng: Edge[]
  urquhart: Edge[]
  layers: number[][]
  mstLength: number
  // Single-shot measurements (always computed; drawn only when their toggle is on).
  closest: ClosestPair | null
  diameter: FarthestPair | null
  width: MinWidth | null
  mec: Circle | null
  lec: EmptyCircle | null
  hullArea: number
  hullPerimeter: number
  timings: { delaunay: number; voronoi: number; total: number }
}

const EMPTY: GeometryResult = {
  hull: [],
  triangles: [],
  delaunayEdges: [],
  triangleCount: 0,
  cells: [],
  circumcircles: [],
  centroids: [],
  mst: [],
  gabriel: [],
  rng: [],
  nng: [],
  urquhart: [],
  layers: [],
  mstLength: 0,
  closest: null,
  diameter: null,
  width: null,
  mec: null,
  lec: null,
  hullArea: 0,
  hullPerimeter: 0,
  timings: { delaunay: 0, voronoi: 0, total: 0 },
}

export function computeGeometry(points: Point[], clip: Rect, opts: ComputeOpts): GeometryResult {
  if (points.length === 0) return EMPTY
  const t0 = performance.now()

  const hull = convexHull(points)
  const hullPts = hull.map((i) => points[i])

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
  const rng = opts.proximity ? relativeNeighborhoodGraph(points, delaunayEdges) : []
  const nng = opts.proximity ? nearestNeighborGraph(points, delaunayEdges) : []
  const urquhart = opts.proximity ? urquhartGraph(points, tris) : []
  const layers = opts.layers ? convexLayers(points) : []

  return {
    hull,
    triangles: tris,
    delaunayEdges,
    triangleCount: tris.length,
    cells,
    circumcircles,
    centroids,
    mst,
    gabriel,
    rng,
    nng,
    urquhart,
    layers,
    mstLength: totalLength(points, mst),
    closest: closestPair(points, delaunayEdges),
    diameter: diameter(hullPts),
    width: minWidth(hullPts),
    mec: minimumEnclosingCircle(points),
    lec: largestEmptyCircle(points, tris, hullPts),
    hullArea: hullArea(hullPts),
    hullPerimeter: perimeter(hullPts),
    timings: { delaunay: td1 - td0, voronoi: tv1 - tv0, total: performance.now() - t0 },
  }
}
