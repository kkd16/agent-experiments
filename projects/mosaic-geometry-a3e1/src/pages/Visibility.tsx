import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Point } from '../geometry/types'
import { triangulatePolygon, type VertexKind } from '../geometry/triangulate'
import { threeColorTriangulation } from '../geometry/artgallery'
import { geodesicPath } from '../geometry/funnel'
import { visibilityPolygon, pointInRegion } from '../geometry/visibility'
import { signedArea, area } from '../geometry/polygon'
import { orient } from '../geometry/predicates'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { Button, Panel, Segmented, Stat } from '../components/Controls'

// The Visibility axis — the whole "what can be seen, and how to move" family:
//   • Triangulate — the O(n log n) monotone-decomposition triangulation.
//   • Guards      — the Art Gallery theorem made constructive (3-colour → ⌊n/3⌋).
//   • Visibility  — the star-shaped visibility polygon of a draggable viewpoint.
//   • Geodesic    — the taut-string shortest path (Lee–Preparata funnel).

const PAD = 22
type Mode = 'triangulate' | 'guards' | 'visibility' | 'geodesic'
type Shape = 'comb' | 'spiral' | 'star' | 'random'

// ── Preset simple polygons (in the unit square) ─────────────────────────────
function comb(teeth = 5): Point[] {
  const pts: Point[] = []
  const x0 = 0.08
  const x1 = 0.92
  const span = x1 - x0
  const w = span / (teeth * 2 - 1)
  pts.push({ x: x0, y: 0.82 })
  for (let i = 0; i < teeth; i++) {
    const bx = x0 + i * 2 * w
    pts.push({ x: bx, y: 0.28 })
    pts.push({ x: bx + w, y: 0.28 })
    pts.push({ x: bx + w, y: 0.66 })
    if (i < teeth - 1) pts.push({ x: bx + 2 * w, y: 0.66 })
  }
  pts.push({ x: x1, y: 0.66 })
  pts.push({ x: x1, y: 0.82 })
  return pts
}

function spiral(turns = 2.4, n = 40): Point[] {
  const outer: Point[] = []
  const inner: Point[] = []
  const cx = 0.5
  const cy = 0.5
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const ang = t * turns * Math.PI * 2
    const rO = 0.44 * (1 - 0.62 * t)
    const rI = rO - 0.06
    outer.push({ x: cx + Math.cos(ang) * rO, y: cy + Math.sin(ang) * rO })
    inner.push({ x: cx + Math.cos(ang) * rI, y: cy + Math.sin(ang) * rI })
  }
  return [...outer, ...inner.reverse()]
}

function starPoly(spikes = 7, seed = 1): Point[] {
  const rng = mulberry32(seed * 7919 + 3)
  const pts: Point[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2
    const r = i % 2 === 0 ? 0.42 : 0.16 + rng() * 0.1
    pts.push({ x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r })
  }
  return pts
}

// Evenly-spaced angles + random radii ⇒ always a simple (star-shaped) polygon.
function randomSimple(seed: number): Point[] {
  const rng = mulberry32(seed * 2654435761 + 11)
  const n = 8 + Math.floor(rng() * 10)
  const pts: Point[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rng() - 0.5) * (Math.PI / n)
    const r = 0.16 + rng() * 0.28
    pts.push({ x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r })
  }
  return pts
}

function mulberry32(a: number) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeShape(shape: Shape, seed: number): Point[] {
  const raw =
    shape === 'comb'
      ? comb(5)
      : shape === 'spiral'
        ? spiral()
        : shape === 'star'
          ? starPoly(7, seed)
          : randomSimple(seed)
  return signedArea(raw) < 0 ? raw.slice().reverse() : raw
}

function centroid(V: Point[]): Point {
  let x = 0
  let y = 0
  for (const p of V) {
    x += p.x
    y += p.y
  }
  return { x: x / V.length, y: y / V.length }
}

// Default viewpoint + geodesic endpoints for a polygon: the centroid, and two
// points nudged from it toward far-apart vertices so they start interior.
function anchors(p: Point[]): { view: Point; src: Point; dst: Point } {
  const c = centroid(p)
  const s0 = { x: c.x * 0.55 + p[0].x * 0.45, y: c.y * 0.55 + p[0].y * 0.45 }
  const half = p[Math.floor(p.length / 2)]
  const g0 = { x: c.x * 0.55 + half.x * 0.45, y: c.y * 0.55 + half.y * 0.45 }
  return {
    view: c,
    src: pointInRegion(s0, [p]) ? s0 : c,
    dst: pointInRegion(g0, [p]) ? g0 : c,
  }
}

const KIND_COLOR: Record<VertexKind, string> = {
  start: '#7cf6c0',
  end: '#60cdff',
  split: '#f472b6',
  merge: '#ffd166',
  regular: '#9fb2d4',
}
const COLOR3 = ['#ff6b6b', '#4dd4ff', '#ffd166']

export default function Visibility() {
  const { ref, size } = useCanvas()
  const [mode, setMode] = usePersistentState<Mode>('vis:mode', 'triangulate')
  const [shape, setShape] = usePersistentState<Shape>('vis:shape', 'comb')
  const [showTri, setShowTri] = usePersistentState<boolean>('vis:showTri', true)
  const [seed, setSeed] = useState(1)

  const [poly, setPoly] = useState<Point[]>(() => makeShape(shape, 1))
  const [viewpoint, setViewpoint] = useState<Point>(() => anchors(makeShape(shape, 1)).view)
  const [src, setSrc] = useState<Point>(() => anchors(makeShape(shape, 1)).src)
  const [dst, setDst] = useState<Point>(() => anchors(makeShape(shape, 1)).dst)

  const drag = useRef<{ kind: string; index: number } | null>(null)

  // Rebuild the polygon + handles for a shape/seed. Called from event handlers
  // (never an effect) so shape changes reset the editable geometry cleanly.
  const reshape = useCallback((s: Shape, sd: number) => {
    const p = makeShape(s, sd)
    const a = anchors(p)
    setPoly(p)
    setViewpoint(a.view)
    setSrc(a.src)
    setDst(a.dst)
  }, [])

  const pickShape = (s: Shape) => {
    setShape(s)
    reshape(s, seed)
  }

  // ── Derived geometry ────────────────────────────────────────────────────────
  const tri = useMemo(() => triangulatePolygon(poly), [poly])
  const coloring = useMemo(
    () => threeColorTriangulation(tri.triangles, tri.vertices.length),
    [tri],
  )
  const vis = useMemo(
    () => (pointInRegion(viewpoint, [poly]) ? visibilityPolygon(viewpoint, [poly]) : []),
    [viewpoint, poly],
  )
  const geo = useMemo(() => geodesicPath(src, dst, poly), [src, dst, poly])

  const polyArea = useMemo(() => area(poly), [poly])
  const triArea = useMemo(
    () =>
      tri.triangles.reduce(
        (s, t) => s + Math.abs(orient(tri.vertices[t.a], tri.vertices[t.b], tri.vertices[t.c])) / 2,
        0,
      ),
    [tri],
  )
  const tilesExactly = Math.abs(triArea - polyArea) < 1e-6
  const rightCount = tri.triangles.length === Math.max(0, tri.vertices.length - 2)
  const visFraction = vis.length >= 3 ? area(vis) / Math.max(polyArea, 1e-9) : 0
  const straight = Math.hypot(dst.x - src.x, dst.y - src.y)

  // ── Pointer interaction ─────────────────────────────────────────────────────
  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const canvas = ref.current
      if (!canvas) return { x: 0, y: 0 }
      const rect = canvas.getBoundingClientRect()
      const w = size.width - PAD * 2
      const h = size.height - PAD * 2
      return { x: (clientX - rect.left - PAD) / w, y: (clientY - rect.top - PAD) / h }
    },
    [ref, size],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY)
    e.currentTarget.setPointerCapture(e.pointerId)
    // Mode-specific handles take priority.
    if (mode === 'visibility' && Math.hypot(p.x - viewpoint.x, p.y - viewpoint.y) < 0.05) {
      drag.current = { kind: 'view', index: 0 }
      return
    }
    if (mode === 'geodesic') {
      if (Math.hypot(p.x - src.x, p.y - src.y) < 0.05) {
        drag.current = { kind: 'src', index: 0 }
        return
      }
      if (Math.hypot(p.x - dst.x, p.y - dst.y) < 0.05) {
        drag.current = { kind: 'dst', index: 0 }
        return
      }
    }
    // Otherwise grab the nearest polygon vertex.
    let best = -1
    let bestD = 0.04
    poly.forEach((v, i) => {
      const d = Math.hypot(v.x - p.x, v.y - p.y)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    if (best >= 0) drag.current = { kind: 'vertex', index: best }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) return
    const p = clampPt(toWorld(e.clientX, e.clientY))
    if (d.kind === 'view') setViewpoint(p)
    else if (d.kind === 'src') setSrc(p)
    else if (d.kind === 'dst') setDst(p)
    else if (d.kind === 'vertex') setPoly((cur) => cur.map((v, i) => (i === d.index ? p : v)))
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || size.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const bg = ctx.createRadialGradient(width / 2, height * 0.42, 0, width / 2, height / 2, Math.max(width, height) * 0.75)
    bg.addColorStop(0, '#0e1525')
    bg.addColorStop(1, '#070a12')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const w = width - PAD * 2
    const h = height - PAD * 2
    const toPx = (p: Point) => ({ x: PAD + p.x * w, y: PAD + p.y * h })
    const V = tri.vertices

    const trace = (ring: Point[]) => {
      ctx.beginPath()
      ring.forEach((p, i) => {
        const q = toPx(p)
        if (i === 0) ctx.moveTo(q.x, q.y)
        else ctx.lineTo(q.x, q.y)
      })
      ctx.closePath()
    }

    // Polygon interior fill.
    trace(poly)
    ctx.fillStyle = 'rgba(120,160,230,0.07)'
    ctx.fill()

    // ── Triangulation layer (shared by triangulate / guards / geodesic) ───────
    const drawTriangles = (alpha: number) => {
      ctx.lineWidth = 1
      ctx.strokeStyle = `rgba(140,180,255,${alpha})`
      for (const t of tri.triangles) {
        ctx.beginPath()
        const a = toPx(V[t.a])
        const b = toPx(V[t.b])
        const c = toPx(V[t.c])
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.closePath()
        ctx.stroke()
      }
    }

    if (mode === 'triangulate') {
      // Monotone pieces tinted, diagonals gold, triangulation faint, typed vertices.
      tri.monotonePieces.forEach((piece, i) => {
        trace(piece.map((k) => V[k]))
        ctx.fillStyle = `hsla(${(i * 47) % 360}, 70%, 60%, 0.10)`
        ctx.fill()
      })
      if (showTri) drawTriangles(0.5)
      ctx.strokeStyle = 'rgba(255,209,102,0.85)'
      ctx.lineWidth = 1.4
      ctx.setLineDash([4, 3])
      for (const [a, b] of tri.monotoneDiagonals) {
        const p = toPx(V[a])
        const q = toPx(V[b])
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      strokeRing(ctx, poly.map(toPx), 'rgba(150,190,255,0.9)', 2)
      // Typed vertices.
      V.forEach((v, i) => {
        const q = toPx(v)
        ctx.beginPath()
        ctx.arc(q.x, q.y, 4.5, 0, Math.PI * 2)
        ctx.fillStyle = KIND_COLOR[tri.kinds[i]]
        ctx.fill()
      })
    } else if (mode === 'guards') {
      drawTriangles(0.28)
      // Coverage tint: every triangle contains a guard, so shade them all softly.
      const guardSet = new Set(coloring.guards)
      for (const t of tri.triangles) {
        const hasGuard = guardSet.has(t.a) || guardSet.has(t.b) || guardSet.has(t.c)
        trace([V[t.a], V[t.b], V[t.c]])
        ctx.fillStyle = hasGuard ? 'rgba(124,246,192,0.12)' : 'rgba(244,114,182,0.18)'
        ctx.fill()
      }
      strokeRing(ctx, poly.map(toPx), 'rgba(150,190,255,0.9)', 2)
      // 3-coloured vertices; guards ringed.
      V.forEach((v, i) => {
        const q = toPx(v)
        const c = coloring.colors[i]
        ctx.beginPath()
        ctx.arc(q.x, q.y, coloring.guards.includes(i) ? 8 : 4.5, 0, Math.PI * 2)
        ctx.fillStyle = c >= 0 ? COLOR3[c] : '#888'
        ctx.fill()
        if (coloring.guards.includes(i)) {
          ctx.lineWidth = 2.5
          ctx.strokeStyle = '#fff'
          ctx.stroke()
          // A camera glyph.
          ctx.fillStyle = '#0a0e18'
          ctx.font = '700 9px ui-sans-serif, system-ui'
          ctx.fillText('◉', q.x - 4.5, q.y + 3)
        }
      })
    } else if (mode === 'visibility') {
      // The visible region.
      if (vis.length >= 3) {
        trace(vis)
        const g = ctx.createRadialGradient(
          toPx(viewpoint).x,
          toPx(viewpoint).y,
          2,
          toPx(viewpoint).x,
          toPx(viewpoint).y,
          Math.max(w, h) * 0.7,
        )
        g.addColorStop(0, 'rgba(255,240,180,0.42)')
        g.addColorStop(1, 'rgba(255,209,102,0.10)')
        ctx.fillStyle = g
        ctx.fill()
        strokeRing(ctx, vis.map(toPx), 'rgba(255,225,150,0.9)', 1.5)
        // Sight lines to each visible boundary vertex.
        ctx.strokeStyle = 'rgba(255,235,190,0.25)'
        ctx.lineWidth = 0.6
        const vp = toPx(viewpoint)
        for (const p of vis) {
          const q = toPx(p)
          ctx.beginPath()
          ctx.moveTo(vp.x, vp.y)
          ctx.lineTo(q.x, q.y)
          ctx.stroke()
        }
      }
      strokeRing(ctx, poly.map(toPx), 'rgba(150,190,255,0.9)', 2)
      // The viewpoint.
      const vp = toPx(viewpoint)
      ctx.beginPath()
      ctx.arc(vp.x, vp.y, 7, 0, Math.PI * 2)
      ctx.fillStyle = pointInRegion(viewpoint, [poly]) ? '#ffd166' : '#f47272'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#0a0e18'
      ctx.stroke()
    } else {
      // Geodesic.
      if (showTri) drawTriangles(0.22)
      // Triangle-dual corridor.
      for (const ti of geo.triPath) {
        const t = tri.triangles[ti]
        if (!t) continue
        trace([V[t.a], V[t.b], V[t.c]])
        ctx.fillStyle = 'rgba(96,205,255,0.10)'
        ctx.fill()
      }
      // Portals.
      ctx.strokeStyle = 'rgba(167,139,250,0.7)'
      ctx.lineWidth = 1.4
      ctx.setLineDash([3, 3])
      for (const [a, b] of geo.portals) {
        const p = toPx(a)
        const q = toPx(b)
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
      ctx.setLineDash([])
      strokeRing(ctx, poly.map(toPx), 'rgba(150,190,255,0.9)', 2)
      // Straight reference (dashed) vs geodesic.
      const sp = toPx(src)
      const gp = toPx(dst)
      ctx.strokeStyle = 'rgba(160,170,200,0.35)'
      ctx.setLineDash([6, 5])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(sp.x, sp.y)
      ctx.lineTo(gp.x, gp.y)
      ctx.stroke()
      ctx.setLineDash([])
      if (geo.path.length > 1) {
        ctx.strokeStyle = 'rgba(124,246,192,0.95)'
        ctx.lineWidth = 3
        ctx.lineJoin = 'round'
        ctx.beginPath()
        geo.path.forEach((p, i) => {
          const q = toPx(p)
          if (i === 0) ctx.moveTo(q.x, q.y)
          else ctx.lineTo(q.x, q.y)
        })
        ctx.stroke()
        for (const p of geo.path) {
          const q = toPx(p)
          ctx.beginPath()
          ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2)
          ctx.fillStyle = '#7cf6c0'
          ctx.fill()
        }
      }
      for (const [pt, color, label] of [
        [sp, '#60cdff', 'S'],
        [gp, '#ffd166', 'T'],
      ] as const) {
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.fillStyle = '#0a0e18'
        ctx.font = '700 11px ui-sans-serif, system-ui'
        ctx.fillText(label, pt.x - 3.5, pt.y + 4)
      }
    }
  }, [mode, size, ref, poly, tri, coloring, vis, geo, viewpoint, src, dst, showTri])

  const nFloor3 = Math.floor(tri.vertices.length / 3)

  return (
    <div className="studio">
      <div className="stage">
        <canvas
          ref={ref}
          className="stage__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className="stage__chips">
          <Stat label="vertices" value={tri.vertices.length} />
          {mode === 'triangulate' && <Stat label="triangles" value={tri.triangles.length} />}
          {mode === 'triangulate' && <Stat label="monotone pieces" value={tri.monotonePieces.length} />}
          {mode === 'guards' && <Stat label="guards" value={`${coloring.guards.length} / ⌊n/3⌋=${nFloor3}`} />}
          {mode === 'visibility' && <Stat label="visible area" value={`${(visFraction * 100).toFixed(1)}%`} />}
          {mode === 'geodesic' && <Stat label="path length" value={geo.length.toFixed(4)} />}
          {mode === 'geodesic' && <Stat label="vs straight" value={`${(geo.length / Math.max(straight, 1e-9)).toFixed(3)}×`} />}
        </div>
        <p className="stage__hint">
          {mode === 'triangulate'
            ? 'Drag any vertex — the sweep re-triangulates live. Dots are vertex types.'
            : mode === 'guards'
              ? 'Ringed ◉ vertices are the guards; every triangle is shaded green because it holds one.'
              : mode === 'visibility'
                ? 'Drag the yellow viewpoint — the lit region is everything it can see.'
                : 'Drag S, T, or a vertex — the taut shortest path bends only at reflex corners.'}
        </p>
      </div>

      <aside className="sidebar">
        <Panel title="Mode" hint="visibility & paths">
          <Segmented<Mode>
            options={[
              { id: 'triangulate', label: 'Triangulate' },
              { id: 'guards', label: 'Guards' },
              { id: 'visibility', label: 'Visibility' },
              { id: 'geodesic', label: 'Geodesic' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <p className="muted">
            {mode === 'triangulate'
              ? 'The textbook O(n log n) triangulation: a plane sweep classifies every vertex (start / end / split / merge / regular) and cuts the polygon into y-monotone pieces along gold diagonals, then each piece is triangulated by the linear stack walk.'
              : mode === 'guards'
                ? 'Fisk’s proof of the Art Gallery theorem, run live: 3-colour the triangulation (the dual is a tree, so it always works) and post guards on the smallest colour class. Every triangle owns one guard, so ⌊n/3⌋ cameras see the whole gallery.'
                : mode === 'visibility'
                  ? 'The visibility polygon: an angular sweep shoots a ray toward every corner (and a hair to each side) and keeps the nearest wall, carving out the exact star-shaped region the viewpoint can see.'
                  : 'The Lee–Preparata funnel: triangulate, walk the triangle-dual tree from S to T across its diagonal “portals”, then pull the string taut through them — the exact Euclidean geodesic, bending only at reflex vertices.'}
          </p>
        </Panel>

        <Panel title="Polygon">
          <Segmented<Shape>
            options={[
              { id: 'comb', label: 'Comb' },
              { id: 'spiral', label: 'Spiral' },
              { id: 'star', label: 'Star' },
              { id: 'random', label: 'Random' },
            ]}
            value={shape}
            onChange={pickShape}
          />
          <div className="row">
            <Button
              onClick={() => {
                const s = seed + 1
                setSeed(s)
                if (shape === 'random' || shape === 'star') reshape(shape, s)
                else reshape(shape, s)
              }}
              variant="ghost"
            >
              Regenerate / reset
            </Button>
          </div>
          {(mode === 'triangulate' || mode === 'geodesic') && (
            <div className="row" style={{ marginTop: 8 }}>
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={showTri} onChange={(e) => setShowTri(e.target.checked)} />
                show triangulation
              </label>
            </div>
          )}
        </Panel>

        {mode === 'triangulate' && (
          <Panel title="Sweep result">
            <div className="metrics">
              <Stat label="triangles" value={tri.triangles.length} />
              <Stat label="expected" value={Math.max(0, tri.vertices.length - 2)} />
            </div>
            <p className="muted">
              <Badge ok={rightCount} text={`${tri.triangles.length} = n − 2`} />{' '}
              <Badge ok={tilesExactly} text="exact area tiling" />
            </p>
            <LegendRow />
          </Panel>
        )}

        {mode === 'guards' && (
          <Panel title="Art Gallery">
            <div className="metrics">
              <Stat label="guards" value={coloring.guards.length} />
              <Stat label="⌊n/3⌋" value={nFloor3} />
            </div>
            <p className="muted">
              <Badge ok={coloring.valid} text="proper 3-colouring" />{' '}
              <Badge ok={coloring.guards.length <= nFloor3} text="≤ ⌊n/3⌋ guards" />
            </p>
            <p className="muted">
              Colour classes: <b style={{ color: COLOR3[0] }}>{coloring.classes[0].length}</b> ·{' '}
              <b style={{ color: COLOR3[1] }}>{coloring.classes[1].length}</b> ·{' '}
              <b style={{ color: COLOR3[2] }}>{coloring.classes[2].length}</b>. Guards sit on the
              smallest. The <b>comb</b> preset is the tight case: k teeth force ⌊n/3⌋ guards.
            </p>
          </Panel>
        )}

        {mode === 'visibility' && (
          <Panel title="Visibility polygon">
            <div className="metrics">
              <Stat label="visible" value={`${(visFraction * 100).toFixed(1)}%`} />
              <Stat label="corners" value={vis.length} />
            </div>
            <p className="muted">
              <Badge ok={vis.length >= 3 && pointInRegion(viewpoint, [poly])} text="viewpoint inside" />{' '}
              <Badge ok={isStar(viewpoint, vis)} text="star-shaped from viewpoint" />
            </p>
            <p className="muted">
              Every corner of the lit region is an exact ray/edge intersection. Reflex vertices cast
              the shadows; drag the point behind a spike to watch them swing.
            </p>
          </Panel>
        )}

        {mode === 'geodesic' && (
          <Panel title="Shortest path">
            <div className="metrics">
              <Stat label="length" value={geo.length.toFixed(4)} />
              <Stat label="straight" value={straight.toFixed(4)} />
            </div>
            <p className="muted">
              <Badge ok={geo.ok} text="path found" />{' '}
              <Badge ok={geo.length >= straight - 1e-6} text="≥ straight-line bound" />{' '}
              <Badge ok={geo.path.length === 2 || bendsAreReflex(geo, tri)} text="bends only at reflex" />
            </p>
            <p className="muted">
              The dashed grey line is the straight (often blocked) route; the green string is the
              true geodesic through {geo.triPath.length} triangles and {geo.portals.length} portals.
            </p>
          </Panel>
        )}

        <Panel title="About this axis">
          <p className="muted">
            One triangulation underpins the whole axis: it powers the guard placement, feeds the
            funnel its portals, and stands beside the sweep’s star-shaped visibility polygon. Every
            claim is checked live against its invariant — area tiling, the ⌊n/3⌋ bound, star-shape,
            and the straight-line lower bound.
          </p>
        </Panel>
      </aside>
    </div>
  )
}

function LegendRow() {
  const items: [VertexKind, string][] = [
    ['start', 'start'],
    ['end', 'end'],
    ['split', 'split'],
    ['merge', 'merge'],
    ['regular', 'regular'],
  ]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
      {items.map(([k, label]) => (
        <span key={k} className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: KIND_COLOR[k] }} />
          {label}
        </span>
      ))}
    </div>
  )
}

function Badge({ ok, text }: { ok: boolean; text: string }) {
  return <span className={`badge ${ok ? 'badge--ok' : 'badge--bad'}`}>{ok ? `✓ ${text}` : `✗ ${text}`}</span>
}

function strokeRing(ctx: CanvasRenderingContext2D, ring: Point[], color: string, lw: number) {
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.beginPath()
  ring.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.stroke()
}

function clampPt(p: Point): Point {
  return { x: Math.min(0.99, Math.max(0.01, p.x)), y: Math.min(0.99, Math.max(0.01, p.y)) }
}

function isStar(q: Point, vis: Point[]): boolean {
  if (vis.length < 3) return false
  for (let i = 0; i < vis.length; i++) {
    if (orient(q, vis[i], vis[(i + 1) % vis.length]) < -1e-6) return false
  }
  return true
}

// Every interior bend of the geodesic should coincide with a polygon vertex
// (a reflex corner). Endpoints S and T are exempt.
function bendsAreReflex(geo: ReturnType<typeof geodesicPath>, tri: ReturnType<typeof triangulatePolygon>): boolean {
  const verts = tri.vertices
  for (let i = 1; i < geo.path.length - 1; i++) {
    const b = geo.path[i]
    const onVertex = verts.some((v) => Math.hypot(v.x - b.x, v.y - b.y) < 1e-6)
    if (!onVertex) return false
  }
  return true
}
