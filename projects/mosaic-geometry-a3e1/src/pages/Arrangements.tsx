import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Point, Rect } from '../geometry/types'
import {
  lineFromSI,
  lineThroughPoints,
  clipLineToRect,
  arrangementFaces,
  arrangementStats,
  locateFace,
  levelOfPoint,
  zoneComplexity,
  kLevelPath,
  lowerEnvelope,
  upperEnvelope,
  dualLineOfPoint,
  kthValueAt,
  hamSandwich,
  seidelLP,
  lpBruteForce,
  halfPlaneRegion,
  type Line,
  type SILine,
  type HalfPlane,
} from '../geometry/arrangement'
import { mulberry32 } from '../geometry/random'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { Button, Panel, Segmented, Slider, Stat, Toggle } from '../components/Controls'

// The Arrangements studio — computational geometry's "dual world". Five modes:
// the arrangement n lines carve the plane into (with a live Euler check and the
// zone of a moving line), point–line duality, the k-levels & envelopes of a line
// set, the ham-sandwich cut bisecting two point clouds, and 2-D linear
// programming by Seidel's randomized method — each cross-checked on screen.

type Mode = 'arrangement' | 'duality' | 'levels' | 'ham' | 'lp'

const PAD = 18
const FRAME: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
const DUAL_VIEW: Rect = { minX: -1.7, minY: -1.7, maxX: 1.7, maxY: 1.7 }

// ── Seeded generators ─────────────────────────────────────────────────────────
function genSILines(count: number, seed: number): SILine[] {
  const rng = mulberry32(seed)
  const out: SILine[] = []
  for (let i = 0; i < count; i++) out.push({ m: (rng() - 0.5) * 3.2, b: 0.1 + rng() * 0.8 })
  return out
}
function genTwoSets(seed: number, nR: number, nB: number): { red: Point[]; blue: Point[] } {
  const rng = mulberry32(seed)
  const spread = (): Point => ({ x: 0.1 + rng() * 0.8, y: 0.1 + rng() * 0.8 })
  const red: Point[] = []
  const blue: Point[] = []
  for (let i = 0; i < nR; i++) red.push(spread())
  for (let i = 0; i < nB; i++) blue.push(spread())
  return { red, blue }
}
function genConstraints(count: number, seed: number): HalfPlane[] {
  const rng = mulberry32(seed)
  const center = { x: 0.5, y: 0.5 }
  const out: HalfPlane[] = []
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rng() * 0.6
    const nx = Math.cos(ang)
    const ny = Math.sin(ang)
    // Offset chosen so the polytope centre stays feasible → a non-empty region.
    const c = nx * center.x + ny * center.y + (0.12 + rng() * 0.28)
    out.push({ nx, ny, c })
  }
  return out
}

interface Tx {
  toPx: (p: Point) => Point
  toWorld: (px: number, py: number) => Point
}
function makeTx(view: Rect, w: number, h: number): Tx {
  const iw = w - PAD * 2
  const ih = h - PAD * 2
  const sx = iw / (view.maxX - view.minX)
  const sy = ih / (view.maxY - view.minY)
  return {
    // y is flipped so the plot reads as a standard Cartesian frame (+y up).
    toPx: (p) => ({ x: PAD + (p.x - view.minX) * sx, y: h - PAD - (p.y - view.minY) * sy }),
    toWorld: (px, py) => ({ x: view.minX + (px - PAD) / sx, y: view.minY + (h - PAD - py) / sy }),
  }
}

const LEVEL_COLORS = [
  '#60cdff', '#7cf6c0', '#b6ff6b', '#ffd166', '#ffb347', '#ff8fa3', '#f472b6', '#a78bfa', '#8ec5ff',
]

export default function Arrangements() {
  const { ref, size } = useCanvas()
  const [mode, setMode] = usePersistentState<Mode>('arr:mode', 'arrangement')
  const [count, setCount] = usePersistentState<number>('arr:count', 7)
  const [seed, setSeed] = useState(3)
  const [k, setK] = usePersistentState<number>('arr:k', 3)
  const [showLower, setShowLower] = usePersistentState<boolean>('arr:lower', true)
  const [showUpper, setShowUpper] = usePersistentState<boolean>('arr:upper', false)
  const [showFaces, setShowFaces] = usePersistentState<boolean>('arr:faces', true)
  const [showDual, setShowDual] = usePersistentState<boolean>('arr:hamdual', true)

  // Zone query line (arrangement mode) — two draggable endpoints in the frame.
  const [qa, setQa] = useState<Point>({ x: 0.12, y: 0.3 })
  const [qb, setQb] = useState<Point>({ x: 0.88, y: 0.72 })
  // Hovered probe (arrangement point-location) — tracks the cursor.
  const [probe, setProbe] = useState<Point>({ x: 0.5, y: 0.5 })
  // Objective direction (LP mode) — a draggable handle on the unit circle.
  const [objAngle, setObjAngle] = useState(0.9)

  // Editable point sets (duality + ham) live in state so they can be dragged.
  const [dualPts, setDualPts] = useState<Point[]>(() => [
    { x: -0.9, y: -0.4 },
    { x: -0.1, y: 0.5 },
    { x: 0.8, y: -0.7 },
    { x: 0.4, y: 0.9 },
  ])
  const [ham, setHam] = useState<{ red: Point[]; blue: Point[] }>(() => genTwoSets(3, 9, 8))

  const drag = useRef<{ kind: string; idx: number } | null>(null)

  // Regenerate data whenever the generator inputs change.
  const siLines = useMemo(() => genSILines(count, seed), [count, seed])
  const lines = useMemo<Line[]>(() => siLines.map(lineFromSI), [siLines])
  const constraints = useMemo(() => genConstraints(count, seed), [count, seed])
  const obj = useMemo<Point>(() => ({ x: Math.cos(objAngle), y: Math.sin(objAngle) }), [objAngle])

  // ── Derived structures ──────────────────────────────────────────────────────
  const stats = useMemo(
    () => (mode === 'arrangement' ? arrangementStats(lines, FRAME) : null),
    [mode, lines],
  )
  const faces = useMemo(
    () => (mode === 'arrangement' ? arrangementFaces(lines, FRAME) : []),
    [mode, lines],
  )
  const located = useMemo(
    () => (mode === 'arrangement' ? locateFace(faces, probe) : -1),
    [mode, faces, probe],
  )
  const probeLevel = useMemo(
    () => (mode === 'arrangement' ? levelOfPoint(lines, probe) : 0),
    [mode, lines, probe],
  )
  const locateOK = located < 0 || faces[located].level === probeLevel
  const queryLine = useMemo(() => lineThroughPoints(qa, qb), [qa, qb])
  const zone = useMemo(
    () => (mode === 'arrangement' ? zoneComplexity(lines, queryLine, FRAME) : null),
    [mode, lines, queryLine],
  )
  const levelPath = useMemo(
    () => (mode === 'levels' ? kLevelPath(siLines, k, 0, 1) : []),
    [mode, siLines, k],
  )
  const lowerPath = useMemo(
    () => (mode === 'levels' && showLower ? lowerEnvelope(siLines, 0, 1) : []),
    [mode, siLines, showLower],
  )
  const upperPath = useMemo(
    () => (mode === 'levels' && showUpper ? upperEnvelope(siLines, 0, 1) : []),
    [mode, siLines, showUpper],
  )
  const hs = useMemo(
    () => (mode === 'ham' ? hamSandwich(ham.red, ham.blue) : null),
    [mode, ham],
  )
  const lp = useMemo(
    () => (mode === 'lp' ? seidelLP(constraints, obj, FRAME, seed) : null),
    [mode, constraints, obj, seed],
  )
  const lpBrute = useMemo(
    () => (mode === 'lp' ? lpBruteForce(constraints, obj, FRAME) : null),
    [mode, constraints, obj],
  )
  const lpRegion = useMemo(
    () => (mode === 'lp' ? halfPlaneRegion(constraints, FRAME) : []),
    [mode, constraints],
  )
  const lpVerified =
    !lp || !lpBrute
      ? true
      : lp.feasible === lpBrute.feasible && (!lp.feasible || Math.abs(lp.value - lpBrute.value) < 1e-6)

  const view = mode === 'duality' ? DUAL_VIEW : FRAME

  // ── Pointer interaction ─────────────────────────────────────────────────────
  const pick = useCallback(
    (p: Point): { kind: string; idx: number } | null => {
      const near = (a: Point, r = 0.05) =>
        Math.abs(a.x - p.x) < r && Math.abs(a.y - p.y) < r * ((view.maxY - view.minY) / (view.maxX - view.minX) || 1)
      if (mode === 'arrangement') {
        if (near(qa)) return { kind: 'qa', idx: 0 }
        if (near(qb)) return { kind: 'qb', idx: 0 }
      } else if (mode === 'duality') {
        for (let i = 0; i < dualPts.length; i++) if (near(dualPts[i], 0.12)) return { kind: 'dual', idx: i }
      } else if (mode === 'ham') {
        for (let i = 0; i < ham.red.length; i++) if (near(ham.red[i])) return { kind: 'red', idx: i }
        for (let i = 0; i < ham.blue.length; i++) if (near(ham.blue[i])) return { kind: 'blue', idx: i }
      }
      return null
    },
    [mode, qa, qb, dualPts, ham, view],
  )

  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const canvas = ref.current
      if (!canvas) return { x: 0, y: 0 }
      const rect = canvas.getBoundingClientRect()
      const tx = makeTx(view, size.width, size.height)
      return tx.toWorld(clientX - rect.left, clientY - rect.top)
    },
    [ref, view, size],
  )

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (mode === 'lp') {
      // Point the objective toward the cursor from the frame centre.
      setObjAngle(Math.atan2(p.y - 0.5, p.x - 0.5))
      drag.current = { kind: 'obj', idx: 0 }
      return
    }
    const hit = pick(p)
    if (hit) drag.current = hit
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY)
    if (mode === 'arrangement') setProbe(p) // locate the face live as the cursor moves
    if (!drag.current) return
    const d = drag.current
    if (d.kind === 'obj') setObjAngle(Math.atan2(p.y - 0.5, p.x - 0.5))
    else if (d.kind === 'qa') setQa(p)
    else if (d.kind === 'qb') setQb(p)
    else if (d.kind === 'dual') setDualPts((s) => s.map((q, i) => (i === d.idx ? p : q)))
    else if (d.kind === 'red') setHam((s) => ({ ...s, red: s.red.map((q, i) => (i === d.idx ? p : q)) }))
    else if (d.kind === 'blue') setHam((s) => ({ ...s, blue: s.blue.map((q, i) => (i === d.idx ? p : q)) }))
  }
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  const reseed = () => {
    const next = seed + 1
    setSeed(next)
    if (mode === 'ham') setHam(genTwoSets(next, ham.red.length, ham.blue.length))
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

    const tx = makeTx(view, width, height)
    const P = (p: Point) => tx.toPx(p)
    const strokeChord = (l: Line, color: string, lw: number, dash: number[] = []) => {
      const chord = clipLineToRect(l, view)
      if (!chord) return
      const a = P(chord[0])
      const b = P(chord[1])
      ctx.strokeStyle = color
      ctx.lineWidth = lw
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
    }
    const dot = (p: Point, r: number, fill: string, stroke?: string) => {
      const q = P(p)
      ctx.beginPath()
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      if (stroke) {
        ctx.lineWidth = 1.5
        ctx.strokeStyle = stroke
        ctx.stroke()
      }
    }
    const drawPath = (path: Point[], color: string, lw: number, dash: number[] = []) => {
      if (path.length < 2) return
      ctx.strokeStyle = color
      ctx.lineWidth = lw
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.setLineDash(dash)
      ctx.beginPath()
      path.forEach((p, i) => {
        const q = P(p)
        if (i === 0) ctx.moveTo(q.x, q.y)
        else ctx.lineTo(q.x, q.y)
      })
      ctx.stroke()
      ctx.setLineDash([])
    }
    const fillPoly = (poly: Point[], fill: string, stroke?: string, lw = 1) => {
      if (poly.length < 3) return
      ctx.beginPath()
      poly.forEach((p, i) => {
        const q = P(p)
        if (i === 0) ctx.moveTo(q.x, q.y)
        else ctx.lineTo(q.x, q.y)
      })
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
      if (stroke) {
        ctx.strokeStyle = stroke
        ctx.lineWidth = lw
        ctx.stroke()
      }
    }

    if (mode === 'duality') {
      // Faint axes for the shared primal/dual plane.
      const o = P({ x: 0, y: 0 })
      ctx.strokeStyle = 'rgba(150,160,200,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(PAD, o.y)
      ctx.lineTo(width - PAD, o.y)
      ctx.moveTo(o.x, PAD)
      ctx.lineTo(o.x, height - PAD)
      ctx.stroke()
    }

    // ── Mode renderers ─────────────────────────────────────────────────────────
    if (mode === 'arrangement') {
      if (showFaces) {
        for (const f of faces) {
          const col = LEVEL_COLORS[f.level % LEVEL_COLORS.length]
          fillPoly(f.polygon, hexA(col, 0.14))
        }
      }
      for (const l of lines) strokeChord(l, 'rgba(140,180,255,0.5)', 1.3)
      // Zone: faces the query line crosses, brightened.
      if (zone) for (const f of zone.faces) fillPoly(f.polygon, 'rgba(255,209,102,0.16)')
      // The face located under the cursor — point location off the convex cells.
      if (located >= 0) fillPoly(faces[located].polygon, 'rgba(124,246,192,0.22)', 'rgba(124,246,192,0.9)', 1.8)
      strokeChord(queryLine, 'rgba(255,209,102,0.95)', 2.2, [7, 4])
      dot(qa, 5, '#ffd166', 'rgba(8,12,22,0.7)')
      dot(qb, 5, '#ffd166', 'rgba(8,12,22,0.7)')
      // Vertices of the arrangement.
      if (stats) for (const v of stats.vertices) dot(v, 2.2, 'rgba(200,215,255,0.8)')
      // Probe crosshair.
      {
        const q = P(probe)
        ctx.strokeStyle = '#7cf6c0'
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.moveTo(q.x - 7, q.y)
        ctx.lineTo(q.x + 7, q.y)
        ctx.moveTo(q.x, q.y - 7)
        ctx.lineTo(q.x, q.y + 7)
        ctx.stroke()
      }
    } else if (mode === 'duality') {
      // Each point and its dual line share the plane; a moving point rotates its
      // line about the dual of whatever line the points currently sample.
      dualPts.forEach((p, i) => {
        const col = LEVEL_COLORS[i % LEVEL_COLORS.length]
        strokeChord(lineFromSI(dualLineOfPoint(p)), hexA(col, 0.85), 1.6)
        dot(p, 5.5, col, 'rgba(8,12,22,0.8)')
      })
      // The line through the first two points, and its dual point (the crossing
      // of their dual lines) — incidence made visible.
      if (dualPts.length >= 2) {
        const supp = lineThroughPoints(dualPts[0], dualPts[1])
        strokeChord(supp, 'rgba(255,255,255,0.35)', 1.2, [5, 4])
        // Dual point of the supporting line y=mx+b is (m, −b).
        const si = toSISafe(dualPts[0], dualPts[1])
        if (si) dot({ x: si.m, y: -si.b }, 6, '#ffffff', 'rgba(8,12,22,0.9)')
      }
    } else if (mode === 'levels') {
      for (const l of lines) strokeChord(l, 'rgba(140,180,255,0.35)', 1.1)
      if (showLower) drawPath(lowerPath, 'rgba(96,205,255,0.95)', 2.6)
      if (showUpper) drawPath(upperPath, 'rgba(255,143,163,0.95)', 2.6)
      drawPath(levelPath, 'rgba(255,209,102,0.98)', 3.2)
    } else if (mode === 'ham') {
      for (const p of ham.red) dot(p, 5, '#ff6b6b', 'rgba(8,12,22,0.8)')
      for (const p of ham.blue) dot(p, 5, '#5b9dff', 'rgba(8,12,22,0.8)')
      if (hs) {
        strokeChord(hs.line, hs.balanced ? 'rgba(124,246,192,0.95)' : 'rgba(255,120,120,0.95)', 2.6)
      }
      // Dual-plane inset: the "why". Each set is a fan of dual lines; the cut is
      // where their two median levels cross — that crossing point is hs.dual.
      if (showDual && hs && hs.dual) {
        const iw = Math.min(300, width * 0.36)
        const ih = iw
        const ix = width - iw - 12
        const iy = 12
        ctx.save()
        ctx.fillStyle = 'rgba(6,10,20,0.86)'
        ctx.strokeStyle = 'rgba(150,170,220,0.35)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.rect(ix, iy, iw, ih)
        ctx.fill()
        ctx.stroke()
        ctx.clip()
        const rL = ham.red.map(dualLineOfPoint)
        const bL = ham.blue.map(dualLineOfPoint)
        const kR = Math.floor(ham.red.length / 2)
        const kB = Math.floor(ham.blue.length / 2)
        const cx = hs.dual.x
        const x0 = cx - 1.7
        const x1 = cx + 1.7
        let yMin = hs.dual.y
        let yMax = hs.dual.y
        for (let s = 0; s <= 10; s++) {
          const x = x0 + ((x1 - x0) * s) / 10
          yMin = Math.min(yMin, kthValueAt(rL, kR, x), kthValueAt(bL, kB, x))
          yMax = Math.max(yMax, kthValueAt(rL, kR, x), kthValueAt(bL, kB, x))
        }
        const padY = (yMax - yMin) * 0.15 + 1e-6
        const vr: Rect = { minX: x0, minY: yMin - padY, maxX: x1, maxY: yMax + padY }
        const pad = 12
        const sx = (iw - pad * 2) / (vr.maxX - vr.minX)
        const sy = (ih - pad * 2) / (vr.maxY - vr.minY)
        const q = (p: Point): Point => ({ x: ix + pad + (p.x - vr.minX) * sx, y: iy + ih - pad - (p.y - vr.minY) * sy })
        const line = (path: Point[], col: string, lw: number) => {
          if (path.length < 2) return
          ctx.strokeStyle = col
          ctx.lineWidth = lw
          ctx.beginPath()
          path.forEach((p, i) => {
            const w = q(p)
            if (i === 0) ctx.moveTo(w.x, w.y)
            else ctx.lineTo(w.x, w.y)
          })
          ctx.stroke()
        }
        // Faint fans of dual lines.
        for (const sl of rL) { const ch = clipLineToRect(lineFromSI(sl), vr); if (ch) line(ch, 'rgba(255,107,107,0.22)', 1) }
        for (const sl of bL) { const ch = clipLineToRect(lineFromSI(sl), vr); if (ch) line(ch, 'rgba(91,157,255,0.22)', 1) }
        // The two median levels, bold, and their crossing.
        line(kLevelPath(rL, kR, x0, x1), 'rgba(255,107,107,0.95)', 2.2)
        line(kLevelPath(bL, kB, x0, x1), 'rgba(91,157,255,0.95)', 2.2)
        const dp = q(hs.dual)
        ctx.beginPath()
        ctx.arc(dp.x, dp.y, 4.5, 0, Math.PI * 2)
        ctx.fillStyle = '#7cf6c0'
        ctx.fill()
        ctx.restore()
        ctx.fillStyle = 'rgba(200,215,255,0.7)'
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
        ctx.fillText('dual plane — median levels cross at the cut', ix + 8, iy + ih - 8)
      }
    } else if (mode === 'lp') {
      // Feasible region, its bounding constraints, the objective, the optimum.
      fillPoly(lpRegion, 'rgba(96,205,255,0.12)', 'rgba(96,205,255,0.6)', 1.5)
      for (const h of constraints) strokeChord(h, 'rgba(150,170,220,0.28)', 1)
      // Objective direction as an arrow from the frame centre.
      const c0 = P({ x: 0.5, y: 0.5 })
      const tip = P({ x: 0.5 + obj.x * 0.32, y: 0.5 + obj.y * 0.32 })
      ctx.strokeStyle = 'rgba(255,209,102,0.9)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(c0.x, c0.y)
      ctx.lineTo(tip.x, tip.y)
      ctx.stroke()
      dot({ x: 0.5 + obj.x * 0.32, y: 0.5 + obj.y * 0.32 }, 5, '#ffd166', 'rgba(8,12,22,0.8)')
      if (lp && lp.point) {
        // Iso-objective line through the optimum (perpendicular to the gradient).
        const opt = lp.point
        const isoDir = { x: -obj.y, y: obj.x }
        strokeChord(
          lineThroughPoints(opt, { x: opt.x + isoDir.x, y: opt.y + isoDir.y }),
          'rgba(124,246,192,0.5)',
          1.2,
          [5, 4],
        )
        dot(opt, 7, '#7cf6c0', 'rgba(8,12,22,0.9)')
      }
    }
  }, [
    ref, size, view, mode, lines, faces, located, probe, showFaces, stats, zone, queryLine, qa, qb,
    dualPts, siLines, levelPath, lowerPath, upperPath, showLower, showUpper, ham, hs, showDual,
    constraints, obj, lp, lpRegion,
  ])

  const badge = (ok: boolean, okLabel = '✓ verified', badLabel = '✗ mismatch') => (
    <span className={`badge ${ok ? 'badge--ok' : 'badge--bad'}`}>{ok ? okLabel : badLabel}</span>
  )

  return (
    <div className="studio">
      <div className="stage">
        <canvas
          ref={ref}
          className="stage__canvas"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className="stage__chips">
          {mode === 'arrangement' && stats && (
            <>
              <Stat label="V" value={stats.V} />
              <Stat label="E" value={stats.E} />
              <Stat label="F" value={stats.F} />
              <Stat label="zone edges" value={zone ? zone.edges : '—'} />
            </>
          )}
          {mode === 'duality' && <Stat label="points" value={dualPts.length} />}
          {mode === 'levels' && <Stat label={`${k}-level`} value={`${levelPath.length ? levelPath.length - 1 : 0} edges`} />}
          {mode === 'ham' && hs && (
            <>
              <Stat label="red split" value={`${hs.redBelow} · ${hs.redAbove}`} />
              <Stat label="blue split" value={`${hs.blueBelow} · ${hs.blueAbove}`} />
            </>
          )}
          {mode === 'lp' && lp && (
            <Stat label="objective" value={lp.feasible ? lp.value.toFixed(4) : 'infeasible'} />
          )}
        </div>
        <p className="stage__hint">
          {mode === 'arrangement'
            ? 'Drag the amber endpoints to sweep the query line — its zone lights up'
            : mode === 'duality'
              ? 'Drag any point; its dual line moves. Line them up to see the duals concur'
              : mode === 'levels'
                ? 'Raise k to climb from the lower envelope to the upper'
                : mode === 'ham'
                  ? 'Drag red or blue points — the cut re-balances live'
                  : 'Drag to aim the objective; the optimum vertex tracks it'}
        </p>
      </div>

      <aside className="sidebar">
        <Panel title="Mode" hint="the dual world">
          <Segmented<Mode>
            options={[
              { id: 'arrangement', label: 'Arrangement' },
              { id: 'duality', label: 'Duality' },
              { id: 'levels', label: 'Levels' },
              { id: 'ham', label: 'Ham cut' },
              { id: 'lp', label: 'LP' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <p className="muted">{DESC[mode]}</p>
        </Panel>

        {mode === 'arrangement' && stats && (
          <Panel title="Euler's formula" hint="V − E + F">
            <div className="metrics">
              <Stat label="vertices" value={stats.V} />
              <Stat label="edges" value={stats.E} />
              <Stat label="faces (+outer)" value={stats.F} />
              <Stat label="V − E + F" value={stats.euler} />
            </div>
            {badge(stats.eulerOK, '✓ V − E + F = 2', '✗ Euler broken')}
            <p className="muted">
              The {count} lines split the frame into {stats.F - 1} faces at {stats.V} vertices and{' '}
              {stats.E} edges. The zone of the amber line touches {zone?.faces.length ?? 0} faces
              spanning {zone?.edges ?? 0} edges — the zone theorem's O(n) bound in action.
            </p>
            <div className="metrics">
              <Stat label="face under cursor" value={located >= 0 ? located : 'outside'} />
              <Stat label="its level" value={located >= 0 ? faces[located].level : '—'} />
              <Stat label="lines below cursor" value={probeLevel} />
            </div>
            {badge(locateOK, '✓ face level = lines below', '✗ locate mismatch')}
            <Toggle label="Fill faces by level" swatch="#7cf6c0" checked={showFaces} onChange={setShowFaces} />
          </Panel>
        )}

        {mode === 'duality' && (
          <Panel title="Point ↔ line" hint="an involution">
            <p className="muted">
              Point (a, b) dualizes to the line y = a·x − b, and a line y = m·x + c to the point
              (m, −c). Incidence is preserved: collinear points map to concurrent lines, and the
              white point is exactly the dual of the dashed line through the first two.
            </p>
            <div className="row">
              <Button onClick={() => setDualPts((s) => [...s, { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2 }])}>
                Add point
              </Button>
              <Button
                onClick={() => setDualPts((s) => (s.length > 2 ? s.slice(0, -1) : s))}
                variant="ghost"
              >
                Remove
              </Button>
            </div>
          </Panel>
        )}

        {mode === 'levels' && (
          <Panel title="k-level" hint="order statistics">
            <Slider label="k (lines below)" value={k} min={0} max={Math.max(0, count - 1)} step={1} onChange={setK} />
            <p className="muted">
              The gold curve is the k-level: the locus with exactly k of the {count} lines strictly
              below it. At every x it is the k-th lowest line, so k = 0 is the lower envelope and
              k = {count - 1} the upper.
            </p>
            <div className="layers">
              <Toggle label="Lower envelope (0-level)" swatch="#60cdff" checked={showLower} onChange={setShowLower} />
              <Toggle label="Upper envelope" swatch="#ff8fa3" checked={showUpper} onChange={setShowUpper} />
            </div>
          </Panel>
        )}

        {mode === 'ham' && hs && (
          <Panel title="Ham-sandwich cut" hint="vs. brute count">
            <div className="metrics">
              <Stat label="red (below·above)" value={`${hs.redBelow} · ${hs.redAbove}`} />
              <Stat label="blue (below·above)" value={`${hs.blueBelow} · ${hs.blueAbove}`} />
              <Stat label="red on line" value={hs.redOn} />
              <Stat label="blue on line" value={hs.blueOn} />
            </div>
            {badge(hs.balanced, '✓ both bisected', '✗ unbalanced')}
            <p className="muted">
              One line halves {ham.red.length} red <em>and</em> {ham.blue.length} blue points at
              once. Found in the dual: each set becomes a fan of lines, and the cut is where their
              two median levels meet{hs.rotated ? ' (recovered by rotating past a near-vertical cut)' : ''}.
            </p>
            <Toggle
              label={hs.dual ? 'Show dual construction' : 'Dual construction (n/a — vertical cut)'}
              swatch="#7cf6c0"
              checked={showDual}
              onChange={setShowDual}
            />
          </Panel>
        )}

        {mode === 'lp' && lp && (
          <Panel title="Linear program" hint="Seidel vs. brute force">
            <div className="metrics">
              <Stat label="constraints" value={count} />
              <Stat label="Seidel optimum" value={lp.feasible ? lp.value.toFixed(4) : '—'} />
              <Stat label="brute-force" value={lpBrute && lpBrute.feasible ? lpBrute.value.toFixed(4) : '—'} />
              <Stat label="region vertices" value={lpRegion.length} />
            </div>
            {badge(lpVerified)}
            <p className="muted">
              Maximize the amber objective over {count} half-planes. Seidel's randomized incremental
              method keeps a running optimum and, whenever a new constraint is violated, slides it
              along that constraint via a 1-D sub-program — expected O(n), and it lands on the same
              vertex a full scan of the feasible polygon would.
            </p>
          </Panel>
        )}

        <Panel title="Generate" hint={`seed ${seed}`}>
          {mode !== 'duality' && mode !== 'ham' && (
            <Slider label={mode === 'lp' ? 'Constraints' : 'Lines'} value={count} min={3} max={mode === 'lp' ? 16 : 14} step={1} onChange={setCount} />
          )}
          <div className="row">
            <Button variant="primary" onClick={reseed}>New seed</Button>
            {mode === 'ham' && (
              <Button onClick={() => setHam(genTwoSets(seed, 6 + Math.floor(Math.random() * 10), 6 + Math.floor(Math.random() * 10)))}>
                Reshuffle sets
              </Button>
            )}
          </div>
        </Panel>
      </aside>
    </div>
  )
}

const DESC: Record<Mode, string> = {
  arrangement:
    'The arrangement of n lines: the planar subdivision they induce, coloured by level, with a live Euler check and the zone of a draggable line.',
  duality:
    'Point–line duality — the order-preserving involution that trades points for lines and turns collinearity into concurrency.',
  levels:
    'The k-levels and lower/upper envelopes of a set of lines — the k-th line from the bottom at every abscissa.',
  ham: 'The ham-sandwich cut: a single line that simultaneously bisects two point sets, found via median levels in the dual.',
  lp: 'Two-dimensional linear programming by Seidel’s randomized incremental algorithm, checked against a brute-force vertex scan.',
}

// Slope-intercept line through two points, or null if vertical.
function toSISafe(p: Point, q: Point): SILine | null {
  if (Math.abs(q.x - p.x) < 1e-9) return null
  const m = (q.y - p.y) / (q.x - p.x)
  return { m, b: p.y - m * p.x }
}

// Apply an alpha to a #rrggbb colour.
function hexA(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}
