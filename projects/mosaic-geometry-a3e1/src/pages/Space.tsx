import { useEffect, useMemo, useRef, useState } from 'react'
import type { Vec3 } from '../geometry/vector3'
import { bounds3, boxCenter, boxRadius, sub3, dot3, add3, scale3 } from '../geometry/vector3'
import type { Point } from '../geometry/types'
import { convexHull3 } from '../geometry/hull3'
import { liftMap, liftedDelaunay, triKey } from '../geometry/lift'
import { delaunay } from '../geometry/delaunay'
import { delaunay3 } from '../geometry/delaunay3'
import { makeCloud3, CLOUD3_PRESETS } from '../geometry/cloud3'
import type { Cloud3Kind } from '../geometry/cloud3'
import { mulberry32 } from '../geometry/random'
import { makeCamera, paintScene } from '../render/scene3'
import type { Camera, Prim, RGB } from '../render/scene3'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { Button, Panel, Segmented, Slider, Stat, Toggle } from '../components/Controls'

// The Space axis — Mosaic in three dimensions. Everything is projected, depth-sorted
// and flat-shaded by hand (no WebGL). Three modes: the 3-D convex hull, the paraboloid
// lifting map that reveals 2-D Delaunay as a projected lower hull, and the 3-D Delaunay
// tetrahedralization with its Voronoi-foam dual.

type Mode = 'hull' | 'lift' | 'delaunay'

const Z_SCALE = 0.6 // vertical squash of the lifting paraboloid (combinatorics are scale-free)

// A cool→warm height ramp so the solids read their form without texture.
function heightColor(t: number): RGB {
  const stops: [number, RGB][] = [
    [0.0, [46, 165, 196]],
    [0.4, [92, 124, 240]],
    [0.7, [150, 96, 238]],
    [1.0, [240, 168, 84]],
  ]
  const c = Math.min(1, Math.max(0, t))
  let a = stops[0]
  let b = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (c >= stops[i][0] && c <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break }
  }
  const span = b[0] - a[0] || 1
  const u = (c - a[0]) / span
  return [
    Math.round(a[1][0] + (b[1][0] - a[1][0]) * u),
    Math.round(a[1][1] + (b[1][1] - a[1][1]) * u),
    Math.round(a[1][2] + (b[1][2] - a[1][2]) * u),
  ]
}

// Clip a segment to the sphere (centre, R): the portion inside, or null if it misses.
function clipSegToSphere(a: Vec3, b: Vec3, centre: Vec3, R: number): [Vec3, Vec3] | null {
  const d = sub3(b, a)
  const f = sub3(a, centre)
  const A = dot3(d, d)
  if (A < 1e-18) return dot3(f, f) <= R * R ? [a, b] : null
  const B = 2 * dot3(f, d)
  const C = dot3(f, f) - R * R
  const disc = B * B - 4 * A * C
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  let t0 = (-B - sq) / (2 * A)
  let t1 = (-B + sq) / (2 * A)
  t0 = Math.max(0, t0)
  t1 = Math.min(1, t1)
  if (t0 > t1) return null
  return [add3(a, scale3(d, t0)), add3(a, scale3(d, t1))]
}

function facesToEdges(faces: { a: number; b: number; c: number }[]): [number, number][] {
  const seen = new Set<number>()
  const out: [number, number][] = []
  const put = (u: number, v: number) => {
    const lo = Math.min(u, v), hi = Math.max(u, v)
    const k = lo * 1_000_003 + hi
    if (!seen.has(k)) { seen.add(k); out.push([lo, hi]) }
  }
  for (const f of faces) { put(f.a, f.b); put(f.b, f.c); put(f.c, f.a) }
  return out
}

// Centered 2-D cloud in [-1,1]² for the lifting demo (kept modest so the lift reads clearly).
function makeCloud2(n: number, seed: number): Point[] {
  const rng = mulberry32(seed * 40503 + 7)
  const pts: Point[] = []
  // A jittered-grid-ish blue-ish scatter inside a disk for a rounded bowl.
  let guard = 0
  while (pts.length < n && guard < n * 40) {
    guard++
    const x = rng() * 1.84 - 0.92
    const y = rng() * 1.84 - 0.92
    if (x * x + y * y <= 0.92 * 0.92) pts.push({ x, y })
  }
  return pts
}

export default function Space() {
  const { ref, size } = useCanvas()
  const [mode, setMode] = usePersistentState<Mode>('space:mode', 'hull')
  const [preset, setPreset] = usePersistentState<Cloud3Kind>('space:preset', 'ball')
  const [count, setCount] = usePersistentState<number>('space:count', 90)
  const [seed, setSeed] = useState(1)

  const [showFaces, setShowFaces] = usePersistentState<boolean>('space:faces', true)
  const [showEdges, setShowEdges] = usePersistentState<boolean>('space:edges', true)
  const [showPoints, setShowPoints] = usePersistentState<boolean>('space:points', true)
  const [spin, setSpin] = usePersistentState<boolean>('space:spin', true)
  const [zoom, setZoom] = useState(1)

  // lift-mode
  const [liftT, setLiftT] = useState(1)
  const [liftPlay, setLiftPlay] = useState(false)
  const [showParaboloid, setShowParaboloid] = usePersistentState<boolean>('space:parab', true)
  const [showBaseDelaunay, setShowBaseDelaunay] = usePersistentState<boolean>('space:base', true)

  // delaunay-mode
  const [showVoronoi, setShowVoronoi] = usePersistentState<boolean>('space:voro', true)
  const [showMesh, setShowMesh] = usePersistentState<boolean>('space:mesh', true)
  const [showSurface, setShowSurface] = usePersistentState<boolean>('space:surface', false)

  const [yaw, setYaw] = useState(0.7)
  const [pitch, setPitch] = useState(0.42)
  const drag = useRef<{ on: boolean; x: number; y: number }>({ on: false, x: 0, y: 0 })

  // ── Data ────────────────────────────────────────────────────────────────────
  const points3 = useMemo(() => makeCloud3(preset, count, seed), [preset, count, seed])
  const hull = useMemo(() => convexHull3(points3), [points3])
  const tetra = useMemo(() => (mode === 'delaunay' ? delaunay3(points3) : null), [mode, points3])

  const liftN = Math.min(count, 46)
  const pts2 = useMemo(() => makeCloud2(liftN, seed), [liftN, seed])
  const lift = useMemo(() => (mode === 'lift' ? liftMap(pts2, Z_SCALE) : null), [mode, pts2])
  const liftAgree = useMemo(() => {
    if (mode !== 'lift') return true
    const dt = delaunay(pts2)
    const lset = new Set(liftedDelaunay(pts2).map(triKey))
    return dt.every((t) => lset.has(triKey(t)))
  }, [mode, pts2])

  // ── Camera framing (fit to the scene extent for the active mode) ─────────────
  const frame = useMemo(() => {
    if (mode === 'lift' && lift) {
      // The plane is the world x–z ground; the lift rises along +y (up). Fit to the
      // fully-lifted bowl so framing doesn't breathe while animating.
      const full = pts2.map((p) => ({ x: p.x, y: Z_SCALE * (p.x * p.x + p.y * p.y), z: p.y }))
      const bb = bounds3(full.concat(pts2.map((p) => ({ x: p.x, y: 0, z: p.y }))))
      return { target: boxCenter(bb), radius: Math.max(0.6, boxRadius(bb)) }
    }
    const bb = bounds3(points3)
    return { target: boxCenter(bb), radius: Math.max(0.6, boxRadius(bb)) }
  }, [mode, lift, points3, pts2])

  const camera: Camera = useMemo(() => {
    const base = makeCamera(frame.target, frame.radius, yaw, pitch)
    return { ...base, dist: base.dist / zoom }
  }, [frame, yaw, pitch, zoom])

  // ── Auto-spin ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!spin) return
    let raf = 0
    let last = 0
    const tick = (ts: number) => {
      if (last === 0) last = ts
      const dt = (ts - last) / 1000
      last = ts
      if (!drag.current.on) setYaw((y) => y + dt * 0.35)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [spin])

  // ── Lift animation ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!liftPlay) return
    let raf = 0
    let last = 0
    let dirUp = true
    const tick = (ts: number) => {
      if (last === 0) last = ts
      const dt = (ts - last) / 1000
      last = ts
      setLiftT((t) => {
        let n = t + (dirUp ? 1 : -1) * dt * 0.5
        if (n >= 1) { n = 1; dirUp = false }
        else if (n <= 0) { n = 0; dirUp = true }
        return n
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [liftPlay])

  // ── Build primitives + paint ──────────────────────────────────────────────────
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || size.width === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const bg = ctx.createRadialGradient(width / 2, height * 0.4, 0, width / 2, height / 2, Math.max(width, height) * 0.8)
    bg.addColorStop(0, '#0e1525')
    bg.addColorStop(1, '#060910')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const prims: Prim[] = []

    if (mode === 'hull') {
      const bb = bounds3(points3)
      const lo = bb.min.y, hi = bb.max.y || lo + 1
      const vertSet = new Set(hull.vertices)
      if (showFaces && !hull.degenerate) {
        for (const f of hull.faces) {
          const cy = (points3[f.a].y + points3[f.b].y + points3[f.c].y) / 3
          const t = (cy - lo) / (hi - lo || 1)
          prims.push({ kind: 'face', a: points3[f.a], b: points3[f.b], c: points3[f.c], color: heightColor(t), opacity: 0.92, cull: true, stroke: 'rgba(10,16,28,0.55)' })
        }
      }
      if (showEdges && !hull.degenerate) {
        for (const [i, j] of hull.edges) prims.push({ kind: 'seg', a: points3[i], b: points3[j], color: 'rgba(226,236,255,0.55)', width: 1 })
      }
      if (showPoints) {
        for (let i = 0; i < points3.length; i++) {
          const onHull = vertSet.has(i)
          prims.push({ kind: 'point', p: points3[i], color: onHull ? '#eaf2ff' : 'rgba(150,166,200,0.45)', r: onHull ? 3 : 1.8, ring: onHull ? 'rgba(120,150,220,0.9)' : undefined })
        }
      }
    } else if (mode === 'lift' && lift) {
      // The 2-D plane maps to the world x–z ground (y = 0); the lift rises along +y.
      const hof = (p: Point) => Z_SCALE * (p.x * p.x + p.y * p.y) * liftT
      const liftedNow: Vec3[] = pts2.map((p) => ({ x: p.x, y: hof(p), z: p.y }))
      const flat: Vec3[] = pts2.map((p) => ({ x: p.x, y: 0, z: p.y }))

      // Paraboloid surface (faint wireframe grid).
      if (showParaboloid) {
        const G = 14
        const surf = (i: number, j: number): Vec3 => {
          const x = -0.92 + (1.84 * i) / G
          const z = -0.92 + (1.84 * j) / G
          return { x, y: Z_SCALE * (x * x + z * z) * liftT, z }
        }
        for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) {
          if (i < G) prims.push({ kind: 'seg', a: surf(i, j), b: surf(i + 1, j), color: 'rgba(120,150,210,0.14)', width: 1 })
          if (j < G) prims.push({ kind: 'seg', a: surf(i, j), b: surf(i, j + 1), color: 'rgba(120,150,210,0.14)', width: 1 })
        }
      }
      // Base-plane Delaunay (the projection of the lower hull).
      if (showBaseDelaunay) {
        for (const [i, j] of facesToEdges(lift.lowerFaces)) prims.push({ kind: 'seg', a: flat[i], b: flat[j], color: 'rgba(120,224,208,0.85)', width: 1.4 })
      }
      // The lower-hull "tent" over the lifted points.
      if (showFaces) {
        for (const f of lift.lowerFaces) prims.push({ kind: 'face', a: liftedNow[f.a], b: liftedNow[f.b], c: liftedNow[f.c], color: [120, 150, 240], opacity: 0.4, cull: false, stroke: 'rgba(180,200,255,0.5)' })
      }
      // Vertical connectors flat → lifted.
      if (showEdges) {
        for (let i = 0; i < pts2.length; i++) prims.push({ kind: 'seg', a: flat[i], b: liftedNow[i], color: 'rgba(150,170,220,0.28)', width: 1, dash: [3, 3] })
      }
      if (showPoints) {
        for (let i = 0; i < pts2.length; i++) {
          prims.push({ kind: 'point', p: flat[i], color: 'rgba(120,224,208,0.9)', r: 2.4 })
          prims.push({ kind: 'point', p: liftedNow[i], color: '#eaf2ff', r: 2.8, ring: 'rgba(120,150,220,0.9)' })
        }
      }
    } else if (mode === 'delaunay' && tetra) {
      if (showSurface && tetra.hullFaces.length) {
        const bb = bounds3(points3)
        const lo = bb.min.y, hi = bb.max.y || lo + 1
        for (const f of tetra.hullFaces) {
          const cy = (points3[f.a].y + points3[f.b].y + points3[f.c].y) / 3
          const t = (cy - lo) / (hi - lo || 1)
          prims.push({ kind: 'face', a: points3[f.a], b: points3[f.b], c: points3[f.c], color: heightColor(t), opacity: 0.12, cull: false })
        }
      }
      if (showMesh) {
        for (const [i, j] of facesToEdges(tetra.faces)) prims.push({ kind: 'seg', a: points3[i], b: points3[j], color: 'rgba(150,170,220,0.28)', width: 1 })
      }
      if (showVoronoi) {
        // Clip the (naturally unbounded) 3-D Voronoi diagram to a sphere around the cloud.
        const R = frame.radius * 1.15
        for (const [a, b] of tetra.voronoiEdges) {
          const seg = clipSegToSphere(a, b, frame.target, R)
          if (seg) prims.push({ kind: 'seg', a: seg[0], b: seg[1], color: 'rgba(120,224,208,0.85)', width: 1.5 })
        }
        for (const [a, b] of tetra.voronoiRays) {
          const seg = clipSegToSphere(a, b, frame.target, R)
          if (seg) prims.push({ kind: 'seg', a: seg[0], b: seg[1], color: 'rgba(120,224,208,0.3)', width: 1, dash: [3, 4] })
        }
      }
      if (showPoints) {
        for (const p of points3) prims.push({ kind: 'point', p, color: '#eaf2ff', r: 2.6, ring: 'rgba(120,150,220,0.9)' })
      }
    }

    paintScene(ctx, camera, width, height, prims)
  }, [ref, size, mode, points3, hull, tetra, lift, pts2, liftT, camera, frame, showFaces, showEdges, showPoints, showParaboloid, showBaseDelaunay, showVoronoi, showMesh, showSurface])

  // ── Pointer orbit ──────────────────────────────────────────────────────────────
  const onDown = (e: React.PointerEvent) => {
    drag.current = { on: true, x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current.on) return
    const dx = e.clientX - drag.current.x
    const dy = e.clientY - drag.current.y
    drag.current.x = e.clientX
    drag.current.y = e.clientY
    setYaw((y) => y - dx * 0.01)
    setPitch((p) => Math.max(-1.45, Math.min(1.45, p + dy * 0.01)))
  }
  const onUp = () => { drag.current.on = false }

  // ── Stats ───────────────────────────────────────────────────────────────────
  const euler = hull.vertices.length - hull.edges.length + hull.faces.length
  const sphericity = hull.area > 0 ? (Math.cbrt(Math.PI) * Math.cbrt(6 * hull.volume) ** 2) / hull.area : 0

  const modeHint =
    mode === 'hull'
      ? 'Drag to orbit. The solid is the convex hull; bright points are its vertices, dim points lie inside.'
      : mode === 'lift'
        ? 'Raise the points onto the paraboloid z = x²+y². The lower hull, dropped to the plane, IS the Delaunay triangulation (teal).'
        : 'The tetrahedral Delaunay mesh (grey) and its dual — the Voronoi foam (teal), a vertex at every circumcentre.'

  return (
    <div className="studio">
      <div className="stage">
        <canvas
          ref={ref}
          className="stage__canvas"
          style={{ cursor: drag.current.on ? 'grabbing' : 'grab', touchAction: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        />
        <div className="stage__chips">
          {mode === 'hull' && !hull.degenerate && (
            <>
              <Stat label="vertices" value={`${hull.vertices.length}/${points3.length}`} />
              <Stat label="faces" value={hull.faces.length} />
              <Stat label="V−E+F" value={euler} />
              <Stat label="volume" value={hull.volume.toFixed(3)} />
            </>
          )}
          {mode === 'lift' && lift && (
            <>
              <Stat label="triangles" value={lift.lowerFaces.length} />
              <Stat label="lifted = Delaunay" value={liftAgree ? '✓' : '—'} />
            </>
          )}
          {mode === 'delaunay' && tetra && (
            <>
              <Stat label="sites" value={points3.length} />
              <Stat label="tetrahedra" value={tetra.tetra.length} />
              <Stat label="voronoi edges" value={tetra.voronoiEdges.length} />
            </>
          )}
        </div>
        <p className="stage__hint">{modeHint}</p>
      </div>

      <aside className="sidebar">
        <Panel title="Mode" hint="the third dimension">
          <Segmented<Mode>
            options={[
              { id: 'hull', label: 'Convex hull' },
              { id: 'lift', label: 'Lifting map' },
              { id: 'delaunay', label: 'Delaunay · Voronoi' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <p className="muted">
            {mode === 'hull'
              ? 'The 3-D convex hull by the incremental algorithm — seed a tetrahedron, then fold each point in by carving its visible cap to the horizon.'
              : mode === 'lift'
                ? 'The lifting map: the plane’s in-circle test is a 3-D orientation test one dimension up. Lift onto the paraboloid, take the lower hull, drop it back — Delaunay.'
                : 'Bowyer–Watson in space builds the Delaunay tetrahedralization; its dual is the 3-D Voronoi diagram — a circumcentre per tetra, an edge across every shared face.'}
          </p>
        </Panel>

        {mode !== 'lift' && (
          <Panel title="Point cloud" hint={`${points3.length} pts`}>
            <Segmented<Cloud3Kind>
              options={CLOUD3_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
              value={preset}
              onChange={setPreset}
            />
            <Slider label="Count" value={count} min={8} max={mode === 'delaunay' ? 220 : 400} step={1} onChange={setCount} />
            <div className="row">
              <Button variant="primary" onClick={() => setSeed((s) => s + 1)}>New cloud</Button>
            </div>
          </Panel>
        )}

        {mode === 'lift' && (
          <Panel title="The lift" hint={`${pts2.length} points`}>
            <Slider label="Raise onto paraboloid" value={Math.round(liftT * 100)} min={0} max={100} step={1} onChange={(v) => { setLiftPlay(false); setLiftT(v / 100) }} />
            <div className="row">
              <Button variant="primary" onClick={() => setLiftPlay((p) => !p)}>{liftPlay ? '❚❚ Pause' : '▶ Animate lift'}</Button>
              <Button onClick={() => setSeed((s) => s + 1)}>New points</Button>
            </div>
            <div className="layers">
              <Toggle label="Paraboloid" swatch="rgba(120,150,210,0.6)" checked={showParaboloid} onChange={setShowParaboloid} />
              <Toggle label="Projected Delaunay" swatch="rgba(120,224,208,0.9)" checked={showBaseDelaunay} onChange={setShowBaseDelaunay} />
            </div>
          </Panel>
        )}

        <Panel title="Layers">
          <div className="layers">
            {mode === 'delaunay' ? (
              <>
                <Toggle label="Delaunay mesh" swatch="rgba(150,170,220,0.7)" checked={showMesh} onChange={setShowMesh} />
                <Toggle label="Voronoi foam" swatch="rgba(120,224,208,0.9)" checked={showVoronoi} onChange={setShowVoronoi} />
                <Toggle label="Hull surface" swatch="rgba(150,120,230,0.7)" checked={showSurface} onChange={setShowSurface} />
                <Toggle label="Sites" swatch="rgba(234,242,255,0.9)" checked={showPoints} onChange={setShowPoints} />
              </>
            ) : (
              <>
                <Toggle label="Faces" swatch="rgba(120,150,240,0.8)" checked={showFaces} onChange={setShowFaces} />
                <Toggle label={mode === 'lift' ? 'Lift connectors' : 'Edges'} swatch="rgba(226,236,255,0.6)" checked={showEdges} onChange={setShowEdges} />
                <Toggle label="Points" swatch="rgba(234,242,255,0.9)" checked={showPoints} onChange={setShowPoints} />
              </>
            )}
          </div>
        </Panel>

        <Panel title="View">
          <Slider label="Zoom" value={Math.round(zoom * 100)} min={40} max={260} step={1} onChange={(v) => setZoom(v / 100)} format={(v) => `${v}%`} />
          <div className="layers">
            <Toggle label="Auto-rotate" swatch="rgba(120,224,208,0.7)" checked={spin} onChange={setSpin} />
          </div>
        </Panel>

        {mode === 'hull' && !hull.degenerate && (
          <Panel title="Metrics" hint="Euler χ = 2">
            <div className="metrics">
              <Stat label="Vertices V" value={hull.vertices.length} />
              <Stat label="Edges E" value={hull.edges.length} />
              <Stat label="Faces F" value={hull.faces.length} />
              <Stat label="V − E + F" value={euler} />
              <Stat label="Surface area" value={hull.area.toFixed(3)} />
              <Stat label="Sphericity Ψ" value={sphericity.toFixed(3)} />
            </div>
            <p className="muted">
              Every convex polyhedron satisfies Euler’s <b>V − E + F = 2</b>. Sphericity Ψ (1 for a
              ball) is the volume-to-surface efficiency; the Fibonacci <i>Sphere</i> preset drives it
              toward 1.
            </p>
          </Panel>
        )}

        {mode === 'lift' && (
          <Panel title="Why it works" hint={liftAgree ? 'verified ✓' : ''}>
            <p className="muted">
              Four points are cocircular in the plane exactly when their lifts are coplanar in space.
              So “<i>d</i> is inside the circumcircle of <i>a,b,c</i>” becomes “<i>d</i>’s lift is
              below the plane of the lifts of <i>a,b,c</i>” — an <b>orient3d</b> test. The Delaunay
              triangulation drawn here (teal) is verified to contain every triangle Bowyer–Watson
              produces in the plane.
            </p>
          </Panel>
        )}
      </aside>
    </div>
  )
}
