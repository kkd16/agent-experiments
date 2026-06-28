import type { Circle, Edge, Point, Triangle, VoronoiCell } from '../geometry/types'
import type { ClosestPair } from '../geometry/graphs'
import type { FarthestPair, MinWidth } from '../geometry/hullMetrics'
import type { EmptyCircle } from '../geometry/emptyCircle'
import { cellFill, type Scheme } from './palette'

// All canvas drawing for the studio happens here. The renderer works in
// normalized [0,1] world coordinates and maps them to device pixels through a
// padded transform, so points hugging the border still get breathing room.

export interface LayerToggles {
  voronoiFill: boolean
  voronoiEdges: boolean
  delaunay: boolean
  circumcircles: boolean
  hull: boolean
  gabriel: boolean
  rng: boolean
  nng: boolean
  urquhart: boolean
  beta: boolean
  knn: boolean
  spanner: boolean
  alpha: boolean
  convexLayers: boolean
  mst: boolean
  refine: boolean
  cdt: boolean
  power: boolean
  regular: boolean
  radical: boolean
  farthest: boolean
  centroids: boolean
  points: boolean
}

export interface MeasureToggles {
  closest: boolean
  diameter: boolean
  width: boolean
  mec: boolean
  lec: boolean
}

export interface AlphaRender {
  boundary: Edge[]
  triangles: Triangle[]
}

/** A refined (Ruppert) mesh carries its own augmented point set. */
export interface RefineRender {
  points: Point[]
  triangles: Triangle[]
  steinerStart: number
}

/** A constrained Delaunay triangulation: triangles + edges flagged as pinned. */
export interface CdtRender {
  triangles: Triangle[]
  edges: { edge: Edge; constrained: boolean }[]
}

/** The weighted (power / Laguerre) geometry bundle. */
export interface PowerRender {
  cells: VoronoiCell[] // power cells (convex, possibly empty for hidden sites)
  regular: Edge[] // regular (weighted Delaunay) triangulation edges
  radical: Circle[] // radical circles (centre = site, r = √w) for positive weights
  hidden: number[] // indices of hidden (outweighed) sites
}

/** The farthest-point Voronoi diagram bundle. */
export interface FarthestRender {
  edges: [Point, Point][] // the diagram's tree skeleton
  owners: number[] // hull vertices that own a non-empty cell
  mec: Circle | null // smallest enclosing circle — its centre lives on the diagram
}

export interface Scene {
  points: Point[]
  hull: number[]
  delaunayEdges: Edge[]
  cells: VoronoiCell[]
  circumcircles: Circle[]
  centroids: Point[]
  mst: Edge[]
  gabriel: Edge[]
  rng: Edge[]
  nng: Edge[]
  urquhart: Edge[]
  beta: Edge[]
  knn: Edge[]
  spanner: Edge[]
  layers: number[][]
  alpha: AlphaRender | null
  refine: RefineRender | null
  cdt: CdtRender | null
  power: PowerRender | null
  farthest: FarthestRender | null
  closest: ClosestPair | null
  diameter: FarthestPair | null
  width: MinWidth | null
  mec: Circle | null
  lec: EmptyCircle | null
  hover: number
  selected: number
}

export interface DrawOptions {
  width: number
  height: number
  dpr: number
  pad: number
  scheme: Scheme
  layers: LayerToggles
  measure: MeasureToggles
  cellAlpha: number
}

interface Tx {
  toPx: (p: Point) => Point
  scale: number // world→pixel scale for radii
}

function makeTransform(o: DrawOptions): Tx {
  const w = o.width - o.pad * 2
  const h = o.height - o.pad * 2
  return {
    toPx: (p) => ({ x: o.pad + p.x * w, y: o.pad + p.y * h }),
    scale: w,
  }
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, o: DrawOptions): void {
  const { dpr, width, height } = o
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // Backdrop — a soft radial wash that reads as depth behind the diagram.
  const bg = ctx.createRadialGradient(width / 2, height * 0.42, 0, width / 2, height / 2, Math.max(width, height) * 0.75)
  bg.addColorStop(0, '#0e1525')
  bg.addColorStop(1, '#070a12')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const tx = makeTransform(o)
  const { layers, measure } = o
  const pts = scene.points

  if (layers.voronoiFill || layers.voronoiEdges) drawVoronoi(ctx, scene.cells, pts, tx, o)
  if (layers.power && scene.power) drawPowerCells(ctx, scene.power, pts, tx, o)
  if (layers.alpha && scene.alpha) drawAlphaShape(ctx, scene.alpha, pts, tx)
  if (layers.circumcircles) drawCircumcircles(ctx, scene.circumcircles, tx, o)
  if (layers.refine && scene.refine) drawRefineMesh(ctx, scene.refine, tx)
  if (layers.cdt && scene.cdt) drawCdt(ctx, scene.cdt, pts, tx)
  if (layers.delaunay) drawEdges(ctx, scene.delaunayEdges, pts, tx, 'rgba(120,170,255,0.32)', 1)
  if (layers.urquhart) drawEdges(ctx, scene.urquhart, pts, tx, 'rgba(190,242,100,0.7)', 1.4)
  if (layers.knn) drawEdges(ctx, scene.knn, pts, tx, 'rgba(167,139,250,0.7)', 1.3)
  if (layers.spanner) drawEdges(ctx, scene.spanner, pts, tx, 'rgba(255,176,32,0.78)', 1.5)
  if (layers.beta) drawEdges(ctx, scene.beta, pts, tx, 'rgba(251,146,140,0.9)', 1.6)
  if (layers.gabriel) drawEdges(ctx, scene.gabriel, pts, tx, 'rgba(120,255,214,0.6)', 1.4)
  if (layers.rng) drawEdges(ctx, scene.rng, pts, tx, 'rgba(244,114,182,0.85)', 1.6)
  if (layers.nng) drawEdges(ctx, scene.nng, pts, tx, 'rgba(96,205,255,0.95)', 1.6)
  if (layers.convexLayers) drawConvexLayers(ctx, scene.layers, pts, tx)
  if (layers.radical && scene.power) drawRadicalCircles(ctx, scene.power.radical, tx)
  if (layers.regular && scene.power) drawEdges(ctx, scene.power.regular, pts, tx, 'rgba(255,170,90,0.8)', 1.5)
  if (layers.farthest && scene.farthest) drawFarthest(ctx, scene.farthest, tx)
  if (layers.hull) drawHull(ctx, scene.hull, pts, tx)
  if (layers.mst) drawEdges(ctx, scene.mst, pts, tx, 'rgba(255,209,102,0.95)', 2.2)

  // Measurement highlights sit above the structural layers.
  if (measure.lec && scene.lec) drawLargestEmptyCircle(ctx, scene.lec, tx)
  if (measure.mec && scene.mec) drawEnclosingCircle(ctx, scene.mec, tx)
  if (measure.width && scene.width) drawWidth(ctx, scene.width, tx)
  if (measure.diameter && scene.diameter) drawDiameter(ctx, scene.diameter, tx)
  if (measure.closest && scene.closest) drawClosestPair(ctx, scene.closest, pts, tx)

  if (layers.centroids) drawCentroids(ctx, scene.centroids, tx)
  if (layers.points) {
    const hidden = layers.power && scene.power ? new Set(scene.power.hidden) : null
    drawPoints(ctx, scene, tx, hidden)
  }
}

function drawVoronoi(
  ctx: CanvasRenderingContext2D,
  cells: VoronoiCell[],
  pts: Point[],
  tx: Tx,
  o: DrawOptions,
): void {
  for (const cell of cells) {
    if (cell.polygon.length < 3) continue
    ctx.beginPath()
    for (let i = 0; i < cell.polygon.length; i++) {
      const q = tx.toPx(cell.polygon[i])
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    }
    ctx.closePath()
    if (o.layers.voronoiFill) {
      ctx.fillStyle = cellFill(o.scheme, pts[cell.site], o.cellAlpha)
      ctx.fill()
    }
    if (o.layers.voronoiEdges) {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(8,12,22,0.55)'
      ctx.stroke()
    }
  }
}

function drawAlphaShape(ctx: CanvasRenderingContext2D, alpha: AlphaRender, pts: Point[], tx: Tx): void {
  // Translucent fill over the retained triangles, then a bright outline.
  ctx.fillStyle = 'rgba(124,246,192,0.10)'
  for (const t of alpha.triangles) {
    const a = tx.toPx(pts[t.a])
    const b = tx.toPx(pts[t.b])
    const c = tx.toPx(pts[t.c])
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(c.x, c.y)
    ctx.closePath()
    ctx.fill()
  }
  drawEdges(ctx, alpha.boundary, pts, tx, 'rgba(124,246,192,0.95)', 2.4)
}

function drawRefineMesh(ctx: CanvasRenderingContext2D, mesh: RefineRender, tx: Tx): void {
  const pts = mesh.points
  // Translucent triangle fills, brightening with the angle-quality of the mesh.
  ctx.fillStyle = 'rgba(120,170,255,0.05)'
  for (const t of mesh.triangles) {
    const a = tx.toPx(pts[t.a])
    const b = tx.toPx(pts[t.b])
    const c = tx.toPx(pts[t.c])
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(c.x, c.y)
    ctx.closePath()
    ctx.fill()
  }
  // Mesh edges.
  ctx.strokeStyle = 'rgba(124,246,192,0.45)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const t of mesh.triangles) {
    const a = tx.toPx(pts[t.a])
    const b = tx.toPx(pts[t.b])
    const c = tx.toPx(pts[t.c])
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(c.x, c.y)
    ctx.lineTo(a.x, a.y)
  }
  ctx.stroke()
  // Steiner points (the vertices Ruppert inserted) — small amber dots.
  ctx.fillStyle = 'rgba(255,180,90,0.9)'
  for (let i = mesh.steinerStart; i < pts.length; i++) {
    const q = tx.toPx(pts[i])
    ctx.beginPath()
    ctx.arc(q.x, q.y, 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawCdt(ctx: CanvasRenderingContext2D, cdt: CdtRender, pts: Point[], tx: Tx): void {
  // Ordinary mesh edges first, then the pinned constraints on top in bold magenta.
  const plain: Edge[] = []
  const pinned: Edge[] = []
  for (const e of cdt.edges) (e.constrained ? pinned : plain).push(e.edge)
  drawEdges(ctx, plain, pts, tx, 'rgba(120,170,255,0.30)', 1)
  drawEdges(ctx, pinned, pts, tx, 'rgba(255,90,140,0.95)', 2.6)
}

function drawConvexLayers(ctx: CanvasRenderingContext2D, layers: number[][], pts: Point[], tx: Tx): void {
  ctx.lineWidth = 1.2
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]
    if (layer.length < 2) continue
    // Fade outer→inner so the nesting reads at a glance.
    const a = 0.85 - (li / Math.max(1, layers.length)) * 0.55
    ctx.strokeStyle = `rgba(150,190,255,${a.toFixed(3)})`
    ctx.beginPath()
    for (let i = 0; i < layer.length; i++) {
      const q = tx.toPx(pts[layer[i]])
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    }
    if (layer.length >= 3) ctx.closePath()
    ctx.stroke()
  }
}

function drawCircumcircles(ctx: CanvasRenderingContext2D, circles: Circle[], tx: Tx, o: DrawOptions): void {
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(150,160,200,0.12)'
  for (const c of circles) {
    const center = tx.toPx({ x: c.x, y: c.y })
    const r = c.r * tx.scale
    if (r > Math.max(o.width, o.height) * 1.5) continue // skip degenerate huge circles
    ctx.beginPath()
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: Edge[],
  pts: Point[],
  tx: Tx,
  color: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (const e of edges) {
    const a = tx.toPx(pts[e.a])
    const b = tx.toPx(pts[e.b])
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  ctx.stroke()
}

function drawHull(ctx: CanvasRenderingContext2D, hull: number[], pts: Point[], tx: Tx): void {
  if (hull.length < 2) return
  ctx.beginPath()
  for (let i = 0; i < hull.length; i++) {
    const q = tx.toPx(pts[hull[i]])
    if (i === 0) ctx.moveTo(q.x, q.y)
    else ctx.lineTo(q.x, q.y)
  }
  ctx.closePath()
  ctx.fillStyle = 'rgba(120,170,255,0.06)'
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = 'rgba(150,190,255,0.7)'
  ctx.setLineDash([6, 5])
  ctx.stroke()
  ctx.setLineDash([])
}

// ── Measurement highlights ───────────────────────────────────────────────────

function strokeCircle(ctx: CanvasRenderingContext2D, c: Circle, tx: Tx, color: string, lw: number): Point {
  const center = tx.toPx({ x: c.x, y: c.y })
  ctx.beginPath()
  ctx.arc(center.x, center.y, c.r * tx.scale, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.stroke()
  return center
}

function marker(ctx: CanvasRenderingContext2D, p: Point, color: string, r = 4): void {
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

function drawEnclosingCircle(ctx: CanvasRenderingContext2D, c: Circle, tx: Tx): void {
  ctx.fillStyle = 'rgba(124,246,192,0.06)'
  const center = tx.toPx({ x: c.x, y: c.y })
  ctx.beginPath()
  ctx.arc(center.x, center.y, c.r * tx.scale, 0, Math.PI * 2)
  ctx.fill()
  strokeCircle(ctx, c, tx, 'rgba(124,246,192,0.9)', 2)
  marker(ctx, center, 'rgba(124,246,192,0.95)', 3)
}

function drawLargestEmptyCircle(ctx: CanvasRenderingContext2D, lec: EmptyCircle, tx: Tx): void {
  const c = lec.circle
  ctx.fillStyle = 'rgba(255,180,90,0.08)'
  const center = tx.toPx({ x: c.x, y: c.y })
  ctx.beginPath()
  ctx.arc(center.x, center.y, c.r * tx.scale, 0, Math.PI * 2)
  ctx.fill()
  strokeCircle(ctx, c, tx, 'rgba(255,180,90,0.92)', 2)
  // Radius spoke to one of the three defining sites.
  const s = tx.toPx(lec.sites[0])
  ctx.beginPath()
  ctx.moveTo(center.x, center.y)
  ctx.lineTo(s.x, s.y)
  ctx.strokeStyle = 'rgba(255,180,90,0.6)'
  ctx.lineWidth = 1.2
  ctx.setLineDash([4, 4])
  ctx.stroke()
  ctx.setLineDash([])
  marker(ctx, center, 'rgba(255,180,90,0.95)', 3)
}

function drawDiameter(ctx: CanvasRenderingContext2D, d: FarthestPair, tx: Tx): void {
  const a = tx.toPx(d.p)
  const b = tx.toPx(d.q)
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.strokeStyle = 'rgba(255,209,102,0.95)'
  ctx.lineWidth = 2
  ctx.setLineDash([8, 5])
  ctx.stroke()
  ctx.setLineDash([])
  marker(ctx, a, '#ffd166', 4)
  marker(ctx, b, '#ffd166', 4)
}

function drawWidth(ctx: CanvasRenderingContext2D, w: MinWidth, tx: Tx): void {
  const e0 = tx.toPx(w.edge[0])
  const e1 = tx.toPx(w.edge[1])
  const sup = tx.toPx(w.support)
  // Direction of the supporting edge, extended across the frame for the slab look.
  const dx = e1.x - e0.x
  const dy = e1.y - e0.y
  const len = Math.hypot(dx, dy) || 1
  const ux = (dx / len) * 4000
  const uy = (dy / len) * 4000
  const drawLine = (px: number, py: number) => {
    ctx.beginPath()
    ctx.moveTo(px - ux, py - uy)
    ctx.lineTo(px + ux, py + uy)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(120,200,255,0.85)'
  ctx.lineWidth = 1.6
  ctx.setLineDash([7, 5])
  drawLine(e0.x, e0.y)
  drawLine(sup.x, sup.y)
  ctx.setLineDash([])
  // Perpendicular span from the support point to the edge line.
  const nx = -dy / len
  const ny = dx / len
  const t = (sup.x - e0.x) * nx + (sup.y - e0.y) * ny
  const foot = { x: sup.x - nx * t, y: sup.y - ny * t }
  ctx.beginPath()
  ctx.moveTo(sup.x, sup.y)
  ctx.lineTo(foot.x, foot.y)
  ctx.strokeStyle = 'rgba(150,215,255,0.95)'
  ctx.lineWidth = 2
  ctx.stroke()
  marker(ctx, sup, 'rgba(150,215,255,0.95)', 3)
}

function drawClosestPair(ctx: CanvasRenderingContext2D, cp: ClosestPair, pts: Point[], tx: Tx): void {
  const a = tx.toPx(pts[cp.a])
  const b = tx.toPx(pts[cp.b])
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.strokeStyle = 'rgba(182,255,107,0.95)'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.stroke()
  for (const q of [a, b]) {
    ctx.beginPath()
    ctx.arc(q.x, q.y, 6, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(182,255,107,0.95)'
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

function drawCentroids(ctx: CanvasRenderingContext2D, centroids: Point[], tx: Tx): void {
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  for (const c of centroids) {
    const q = tx.toPx(c)
    ctx.beginPath()
    ctx.moveTo(q.x - 3, q.y)
    ctx.lineTo(q.x, q.y - 3)
    ctx.lineTo(q.x + 3, q.y)
    ctx.lineTo(q.x, q.y + 3)
    ctx.closePath()
    ctx.fill()
  }
}

function drawPoints(ctx: CanvasRenderingContext2D, scene: Scene, tx: Tx, hidden: Set<number> | null): void {
  for (let i = 0; i < scene.points.length; i++) {
    const q = tx.toPx(scene.points[i])
    const isHover = i === scene.hover
    const isSel = i === scene.selected
    const isHidden = hidden ? hidden.has(i) : false
    const r = isSel ? 6 : isHover ? 5 : 3.2
    if (isHover || isSel) {
      ctx.beginPath()
      ctx.arc(q.x, q.y, r + 4, 0, Math.PI * 2)
      ctx.fillStyle = isSel ? 'rgba(255,209,102,0.25)' : 'rgba(255,255,255,0.16)'
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(q.x, q.y, isHidden ? 2.4 : r, 0, Math.PI * 2)
    // Hidden (outweighed) sites read as hollow grey rings — present but face-less.
    ctx.fillStyle = isHidden ? 'rgba(120,130,160,0.5)' : isSel ? '#ffd166' : '#f4f7ff'
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = isHidden ? 'rgba(150,160,200,0.7)' : 'rgba(8,12,22,0.7)'
    ctx.stroke()
  }
}

// ── Weighted geometry: power diagrams + farthest-point Voronoi ───────────────

function drawPowerCells(
  ctx: CanvasRenderingContext2D,
  power: PowerRender,
  pts: Point[],
  tx: Tx,
  o: DrawOptions,
): void {
  for (const cell of power.cells) {
    if (cell.polygon.length < 3) continue
    ctx.beginPath()
    for (let i = 0; i < cell.polygon.length; i++) {
      const q = tx.toPx(cell.polygon[i])
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    }
    ctx.closePath()
    ctx.fillStyle = cellFill(o.scheme, pts[cell.site], o.cellAlpha)
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(8,12,22,0.55)'
    ctx.stroke()
  }
}

function drawRadicalCircles(ctx: CanvasRenderingContext2D, circles: Circle[], tx: Tx): void {
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,180,90,0.4)'
  for (const c of circles) {
    const center = tx.toPx({ x: c.x, y: c.y })
    const r = c.r * tx.scale
    if (r < 0.5) continue
    ctx.beginPath()
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawFarthest(ctx: CanvasRenderingContext2D, far: FarthestRender, tx: Tx): void {
  // The diagram skeleton (a tree) in cyan.
  ctx.strokeStyle = 'rgba(96,205,255,0.85)'
  ctx.lineWidth = 1.6
  ctx.lineCap = 'round'
  ctx.beginPath()
  for (const [p, q] of far.edges) {
    const a = tx.toPx(p)
    const b = tx.toPx(q)
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  ctx.stroke()
  // The smallest-enclosing-circle centre — a vertex of this diagram.
  if (far.mec) {
    const c = tx.toPx({ x: far.mec.x, y: far.mec.y })
    ctx.beginPath()
    ctx.arc(c.x, c.y, far.mec.r * tx.scale, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(124,246,192,0.45)'
    ctx.lineWidth = 1.4
    ctx.setLineDash([5, 5])
    ctx.stroke()
    ctx.setLineDash([])
    marker(ctx, c, 'rgba(124,246,192,0.95)', 3.5)
  }
}

export { makeTransform }
