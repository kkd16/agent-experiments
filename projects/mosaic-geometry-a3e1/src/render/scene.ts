import type { Circle, Edge, Point, VoronoiCell } from '../geometry/types'
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
  mst: boolean
  centroids: boolean
  points: boolean
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
  cellAlpha: number
}

interface Tx {
  toPx: (p: Point) => Point
}

function makeTransform(o: DrawOptions): Tx {
  const w = o.width - o.pad * 2
  const h = o.height - o.pad * 2
  return {
    toPx: (p) => ({ x: o.pad + p.x * w, y: o.pad + p.y * h }),
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
  const { layers } = o
  const pts = scene.points

  if (layers.voronoiFill || layers.voronoiEdges) drawVoronoi(ctx, scene.cells, pts, tx, o)
  if (layers.circumcircles) drawCircumcircles(ctx, scene.circumcircles, tx, o)
  if (layers.delaunay) drawEdges(ctx, scene.delaunayEdges, pts, tx, 'rgba(120,170,255,0.32)', 1)
  if (layers.gabriel) drawEdges(ctx, scene.gabriel, pts, tx, 'rgba(120,255,214,0.6)', 1.6)
  if (layers.hull) drawHull(ctx, scene.hull, pts, tx)
  if (layers.mst) drawEdges(ctx, scene.mst, pts, tx, 'rgba(255,209,102,0.95)', 2.2)
  if (layers.centroids) drawCentroids(ctx, scene.centroids, tx)
  if (layers.points) drawPoints(ctx, scene, tx)
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

function drawCircumcircles(ctx: CanvasRenderingContext2D, circles: Circle[], tx: Tx, o: DrawOptions): void {
  const scaleX = (o.width - o.pad * 2)
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(150,160,200,0.12)'
  for (const c of circles) {
    const center = tx.toPx({ x: c.x, y: c.y })
    const r = c.r * scaleX
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

function drawPoints(ctx: CanvasRenderingContext2D, scene: Scene, tx: Tx): void {
  for (let i = 0; i < scene.points.length; i++) {
    const q = tx.toPx(scene.points[i])
    const isHover = i === scene.hover
    const isSel = i === scene.selected
    const r = isSel ? 6 : isHover ? 5 : 3.2
    if (isHover || isSel) {
      ctx.beginPath()
      ctx.arc(q.x, q.y, r + 4, 0, Math.PI * 2)
      ctx.fillStyle = isSel ? 'rgba(255,209,102,0.25)' : 'rgba(255,255,255,0.16)'
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
    ctx.fillStyle = isSel ? '#ffd166' : '#f4f7ff'
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(8,12,22,0.7)'
    ctx.stroke()
  }
}

export { makeTransform }
