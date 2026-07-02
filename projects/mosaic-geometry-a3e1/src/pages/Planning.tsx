import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Point } from '../geometry/types'
import {
  booleanOp,
  regionArea,
  type BoolOp,
  type MultiPolygon,
  type Ring,
} from '../geometry/boolean'
import { convexMinkowski, minkowskiSum, toCCW } from '../geometry/minkowski'
import { isConvex, planPath } from '../geometry/planning'
import { useCanvas } from '../hooks/useCanvas'
import { usePersistentState } from '../hooks/usePersistentState'
import { Button, Panel, Segmented, Slider, Stat } from '../components/Controls'

// The Polygons studio: areal geometry — boolean set operations, Minkowski sums,
// and translational motion planning — all over draggable shapes, every answer
// cross-checked (area identities for boolean, collision-freedom for the plan).

const PAD = 20
type Mode = 'boolean' | 'minkowski' | 'planning'

function regularPoly(cx: number, cy: number, r: number, n: number, phase = 0): Ring {
  const pts: Ring = []
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
  }
  return pts
}

function star(cx: number, cy: number, r: number, n: number, phase = 0): Ring {
  const pts: Ring = []
  for (let i = 0; i < n * 2; i++) {
    const a = phase + (i / (n * 2)) * Math.PI * 2
    const rr = i % 2 === 0 ? r : r * 0.45
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr })
  }
  return pts
}

function translate(ring: Ring, dx: number, dy: number): Ring {
  return ring.map((p) => ({ x: p.x + dx, y: p.y + dy }))
}

function centroidOf(ring: Ring): Point {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p.x
    y += p.y
  }
  return { x: x / ring.length, y: y / ring.length }
}

function pointInRing(ring: Ring, p: Point): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if ((a.y > p.y) !== (b.y > p.y)) {
      const t = (p.y - a.y) / (b.y - a.y)
      if (p.x < a.x + t * (b.x - a.x)) inside = !inside
    }
  }
  return inside
}

const OP_LABEL: Record<BoolOp, string> = {
  union: 'A ∪ B',
  intersection: 'A ∩ B',
  difference: 'A − B',
  xor: 'A ⊕ B',
}

export default function Planning() {
  const { ref, size } = useCanvas()
  const [mode, setMode] = usePersistentState<Mode>('poly:mode', 'boolean')
  const [op, setOp] = usePersistentState<BoolOp>('poly:op', 'union')
  const [robotR, setRobotR] = usePersistentState<number>('poly:robotR', 0.06)
  const [robotSides, setRobotSides] = usePersistentState<number>('poly:robotSides', 4)

  // ── Boolean operands ────────────────────────────────────────────────────────
  const [polyA, setPolyA] = useState<Ring>(() => regularPoly(0.42, 0.5, 0.2, 6, 0.2))
  const [polyB, setPolyB] = useState<Ring>(() => star(0.6, 0.48, 0.19, 5, 0.6))

  // ── Minkowski operands ──────────────────────────────────────────────────────
  const [mShape, setMShape] = useState<Ring>(() => star(0.42, 0.5, 0.16, 5, 0.1))

  // ── Planning scene ──────────────────────────────────────────────────────────
  const [obstacles, setObstacles] = useState<Ring[]>(() => [
    regularPoly(0.42, 0.34, 0.1, 4, 0.6),
    star(0.6, 0.62, 0.11, 5, 0.2),
    regularPoly(0.3, 0.66, 0.08, 3, 0.9),
  ])
  const [start, setStart] = useState<Point>({ x: 0.08, y: 0.5 })
  const [goal, setGoal] = useState<Point>({ x: 0.92, y: 0.5 })

  const drag = useRef<{ kind: string; index: number; off: Point } | null>(null)

  const robot = useMemo(() => regularPoly(0, 0, robotR, robotSides, Math.PI / robotSides), [robotR, robotSides])

  // ── Boolean result + verification ───────────────────────────────────────────
  const boolResult = useMemo(() => booleanOp([polyA], [polyB], op), [polyA, polyB, op])
  const boolVerify = useMemo(() => {
    const u = regionArea(booleanOp([polyA], [polyB], 'union'))
    const i = regionArea(booleanOp([polyA], [polyB], 'intersection'))
    const aA = regionArea([polyA])
    const aB = regionArea([polyB])
    return Math.abs(u + i - aA - aB) < 1e-4
  }, [polyA, polyB])
  const boolArea = useMemo(() => regionArea(boolResult), [boolResult])

  // ── Minkowski result ────────────────────────────────────────────────────────
  const minkResult = useMemo<MultiPolygon>(() => {
    if (isConvex(toCCW(mShape)) && isConvex(toCCW(robot))) return [convexMinkowski(mShape, robot)]
    return minkowskiSum(mShape, robot)
  }, [mShape, robot])

  // ── Planning result ─────────────────────────────────────────────────────────
  const plan = useMemo(() => planPath(start, goal, obstacles, robot), [start, goal, obstacles, robot])

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
    if (mode === 'boolean') {
      if (pointInRing(polyB, p)) {
        const c = centroidOf(polyB)
        drag.current = { kind: 'B', index: 0, off: { x: p.x - c.x, y: p.y - c.y } }
      } else if (pointInRing(polyA, p)) {
        const c = centroidOf(polyA)
        drag.current = { kind: 'A', index: 0, off: { x: p.x - c.x, y: p.y - c.y } }
      }
    } else if (mode === 'minkowski') {
      if (pointInRing(mShape, p)) {
        const c = centroidOf(mShape)
        drag.current = { kind: 'M', index: 0, off: { x: p.x - c.x, y: p.y - c.y } }
      }
    } else {
      // planning: grab start / goal handle first, then an obstacle
      if (Math.hypot(p.x - start.x, p.y - start.y) < 0.04) drag.current = { kind: 'start', index: 0, off: { x: 0, y: 0 } }
      else if (Math.hypot(p.x - goal.x, p.y - goal.y) < 0.04) drag.current = { kind: 'goal', index: 0, off: { x: 0, y: 0 } }
      else {
        for (let i = 0; i < obstacles.length; i++) {
          if (pointInRing(obstacles[i], p)) {
            const c = centroidOf(obstacles[i])
            drag.current = { kind: 'obs', index: i, off: { x: p.x - c.x, y: p.y - c.y } }
            break
          }
        }
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) return
    const p = toWorld(e.clientX, e.clientY)
    const target: Point = { x: p.x - d.off.x, y: p.y - d.off.y }
    if (d.kind === 'A') setPolyA((r) => recenter(r, target))
    else if (d.kind === 'B') setPolyB((r) => recenter(r, target))
    else if (d.kind === 'M') setMShape((r) => recenter(r, target))
    else if (d.kind === 'start') setStart(clampPt(p))
    else if (d.kind === 'goal') setGoal(clampPt(p))
    else if (d.kind === 'obs')
      setObstacles((list) => list.map((r, i) => (i === d.index ? recenter(r, target) : r)))
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  const randomize = () => {
    const seed = Math.random()
    if (mode === 'boolean') {
      setPolyA(regularPoly(0.4, 0.5, 0.16 + seed * 0.06, 3 + Math.floor(seed * 5), seed * 6))
      setPolyB(star(0.58, 0.48, 0.16 + seed * 0.05, 4 + Math.floor(seed * 3), seed * 3))
    } else if (mode === 'minkowski') {
      setMShape(Math.random() > 0.5 ? star(0.42, 0.5, 0.16, 4 + Math.floor(Math.random() * 3), Math.random() * 3) : regularPoly(0.42, 0.5, 0.16, 3 + Math.floor(Math.random() * 4), Math.random() * 3))
    } else {
      const n = 3 + Math.floor(Math.random() * 3)
      const obs: Ring[] = []
      for (let i = 0; i < n; i++) {
        const cx = 0.25 + Math.random() * 0.5
        const cy = 0.2 + Math.random() * 0.6
        obs.push(Math.random() > 0.5 ? star(cx, cy, 0.07 + Math.random() * 0.05, 5, Math.random() * 3) : regularPoly(cx, cy, 0.07 + Math.random() * 0.05, 3 + Math.floor(Math.random() * 3), Math.random() * 3))
      }
      setObstacles(obs)
    }
  }

  const [frame, setFrame] = useState(0)

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

    const tracePath = (ring: Point[]) => {
      ring.forEach((p, i) => {
        const q = toPx(p)
        if (i === 0) ctx.moveTo(q.x, q.y)
        else ctx.lineTo(q.x, q.y)
      })
      ctx.closePath()
    }
    const strokeRing = (ring: Point[], color: string, lw = 1.6, dash: number[] = []) => {
      ctx.strokeStyle = color
      ctx.lineWidth = lw
      ctx.setLineDash(dash)
      ctx.beginPath()
      tracePath(ring)
      ctx.stroke()
      ctx.setLineDash([])
    }
    const fillRings = (rings: MultiPolygon, color: string) => {
      ctx.fillStyle = color
      ctx.beginPath()
      for (const r of rings) tracePath(r)
      ctx.fill('evenodd')
    }

    if (mode === 'boolean') {
      fillRings([polyA], 'rgba(96,205,255,0.10)')
      fillRings([polyB], 'rgba(244,114,182,0.10)')
      strokeRing(polyA, 'rgba(96,205,255,0.55)', 1.4, [5, 4])
      strokeRing(polyB, 'rgba(244,114,182,0.55)', 1.4, [5, 4])
      // Result region.
      fillRings(boolResult, 'rgba(124,246,192,0.28)')
      for (const r of boolResult) strokeRing(r, 'rgba(124,246,192,0.95)', 2)
      // Label A / B.
      ctx.fillStyle = 'rgba(150,210,255,0.9)'
      ctx.font = '600 15px ui-sans-serif, system-ui'
      const ca = toPx(centroidOf(polyA))
      const cb = toPx(centroidOf(polyB))
      ctx.fillText('A', ca.x - 5, ca.y + 5)
      ctx.fillStyle = 'rgba(250,160,205,0.9)'
      ctx.fillText('B', cb.x - 5, cb.y + 5)
    } else if (mode === 'minkowski') {
      // The swept sum.
      fillRings(minkResult, 'rgba(124,246,192,0.16)')
      for (const r of minkResult) strokeRing(r, 'rgba(124,246,192,0.85)', 1.8)
      // The base shape.
      fillRings([mShape], 'rgba(96,205,255,0.16)')
      strokeRing(mShape, 'rgba(96,205,255,0.95)', 1.8)
      // The robot shown gliding along the shape's boundary to suggest the sweep.
      const t = (Date.now() / 3000) % 1
      const anchor = mShape[Math.floor(t * mShape.length) % mShape.length]
      const rob = translate(robot, anchor.x, anchor.y)
      fillRings([rob], 'rgba(255,209,102,0.18)')
      strokeRing(rob, 'rgba(255,209,102,0.95)', 1.6)
      ctx.fillStyle = 'rgba(150,210,255,0.9)'
      ctx.font = '600 14px ui-sans-serif, system-ui'
      const cm = toPx(centroidOf(mShape))
      ctx.fillText('shape', cm.x - 18, cm.y + 4)
    } else {
      const { result, cObstacles } = plan
      // C-space obstacles (grown), faint.
      for (const region of cObstacles) {
        fillRings(region, 'rgba(167,139,250,0.10)')
        for (const r of region) strokeRing(r, 'rgba(167,139,250,0.35)', 1, [4, 4])
      }
      // Original obstacles.
      for (const o of obstacles) {
        fillRings([o], 'rgba(244,114,182,0.16)')
        strokeRing(o, 'rgba(244,114,182,0.8)', 1.5)
      }
      // Visibility graph, very faint.
      ctx.strokeStyle = 'rgba(140,180,255,0.10)'
      ctx.lineWidth = 0.6
      ctx.beginPath()
      for (const e of result.graph.edges) {
        const a = toPx(result.graph.nodes[e.u])
        const b = toPx(result.graph.nodes[e.v])
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.stroke()
      // The shortest path.
      if (result.reachable && result.path.length > 1) {
        ctx.strokeStyle = 'rgba(124,246,192,0.95)'
        ctx.lineWidth = 3
        ctx.lineJoin = 'round'
        ctx.beginPath()
        result.path.forEach((p, i) => {
          const q = toPx(p)
          if (i === 0) ctx.moveTo(q.x, q.y)
          else ctx.lineTo(q.x, q.y)
        })
        ctx.stroke()
        for (const p of result.path) {
          const q = toPx(p)
          ctx.beginPath()
          ctx.arc(q.x, q.y, 3, 0, Math.PI * 2)
          ctx.fillStyle = '#7cf6c0'
          ctx.fill()
        }
        // Robot ghosts along the path.
        for (let i = 0; i < result.path.length; i++) {
          const rob = translate(robot, result.path[i].x, result.path[i].y)
          strokeRing(rob, 'rgba(124,246,192,0.25)', 1)
        }
      }
      // Start / goal handles.
      const sp = toPx(start)
      const gp = toPx(goal)
      for (const [pt, color, label] of [
        [sp, '#60cdff', 'S'],
        [gp, '#ffd166', 'G'],
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
  }, [mode, size, ref, polyA, polyB, boolResult, mShape, minkResult, robot, obstacles, start, goal, plan, frame])

  // Drive the Minkowski sweep animation by ticking a frame counter (a render dep).
  useEffect(() => {
    if (mode !== 'minkowski') return
    let raf = 0
    const tick = () => {
      setFrame((n) => (n + 1) % 1_000_000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mode])

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
          {mode === 'boolean' && <Stat label="operation" value={OP_LABEL[op]} />}
          {mode === 'boolean' && <Stat label="result area" value={boolArea.toFixed(4)} />}
          {mode === 'boolean' && <Stat label="result rings" value={boolResult.length} />}
          {mode === 'minkowski' && <Stat label="sum rings" value={minkResult.length} />}
          {mode === 'minkowski' && <Stat label="sum area" value={regionArea(minkResult).toFixed(4)} />}
          {mode === 'planning' && <Stat label="reachable" value={plan.result.reachable ? 'yes' : 'no'} />}
          {mode === 'planning' && plan.result.reachable && (
            <Stat label="path length" value={plan.result.length.toFixed(4)} />
          )}
          {mode === 'planning' && <Stat label="graph nodes" value={plan.result.graph.nodes.length} />}
        </div>
        <p className="stage__hint">
          {mode === 'boolean'
            ? 'Drag shape A or B — the boolean region updates live'
            : mode === 'minkowski'
              ? 'Drag the shape; the robot glides its boundary tracing the swept sum'
              : 'Drag S, G, or any obstacle — the shortest safe path replans live'}
        </p>
      </div>

      <aside className="sidebar">
        <Panel title="Mode" hint="areal geometry">
          <Segmented<Mode>
            options={[
              { id: 'boolean', label: 'Boolean' },
              { id: 'minkowski', label: 'Minkowski' },
              { id: 'planning', label: 'Planning' },
            ]}
            value={mode}
            onChange={setMode}
          />
          <p className="muted">
            {mode === 'boolean'
              ? 'Boolean set operations on polygons via a from-scratch planar-arrangement sweep: overlay both boundaries, split at every crossing, and keep each sub-edge whose result-membership flips across it. Verified live by the inclusion–exclusion identity |A∪B| + |A∩B| = |A| + |B|.'
              : mode === 'minkowski'
                ? 'The Minkowski sum A ⊕ R = { a + r }. Convex operands merge their angle-sorted edges in linear time; a non-convex shape is triangulated (ear clipping) and the per-triangle sums are boolean-unioned back together.'
                : "Translational motion planning: grow every obstacle by the robot's reflection into a configuration-space obstacle, build the visibility graph over the grown vertices, and Dijkstra the Euclidean-shortest collision-free route. The robot then shrinks to a point."}
          </p>
        </Panel>

        {mode === 'boolean' && (
          <Panel title="Operation">
            <Segmented<BoolOp>
              options={[
                { id: 'union', label: '∪' },
                { id: 'intersection', label: '∩' },
                { id: 'difference', label: '−' },
                { id: 'xor', label: '⊕' },
              ]}
              value={op}
              onChange={setOp}
            />
            <div className="metrics">
              <Stat label="area" value={boolArea.toFixed(4)} />
              <Stat label="|A|" value={regionArea([polyA]).toFixed(3)} />
              <Stat label="|B|" value={regionArea([polyB]).toFixed(3)} />
            </div>
            <p className="muted">
              <Badge ok={boolVerify} text="inclusion–exclusion" />
            </p>
            <div className="row">
              <Button onClick={randomize} variant="ghost">
                Randomize shapes
              </Button>
            </div>
          </Panel>
        )}

        {mode === 'minkowski' && (
          <Panel title="Robot">
            <Slider label="radius" value={robotR} min={0.02} max={0.14} step={0.005} onChange={setRobotR} format={(v) => v.toFixed(3)} />
            <Slider label="sides" value={robotSides} min={3} max={10} step={1} onChange={setRobotSides} />
            <div className="metrics">
              <Stat label="sum rings" value={minkResult.length} />
              <Stat label="shape convex" value={isConvex(toCCW(mShape)) ? 'yes' : 'no'} />
            </div>
            <div className="row">
              <Button onClick={randomize} variant="ghost">
                Randomize shape
              </Button>
            </div>
          </Panel>
        )}

        {mode === 'planning' && (
          <Panel title="Robot & scene">
            <Slider label="robot radius" value={robotR} min={0.01} max={0.14} step={0.005} onChange={setRobotR} format={(v) => v.toFixed(3)} />
            <Slider label="robot sides" value={robotSides} min={3} max={10} step={1} onChange={setRobotSides} />
            <div className="metrics">
              <Stat label="obstacles" value={obstacles.length} />
              <Stat label="graph edges" value={plan.result.graph.edges.length} />
            </div>
            <p className="muted">
              {plan.result.reachable ? (
                <Badge ok text={`path ${plan.result.length.toFixed(3)}`} />
              ) : (
                <span className="badge badge--bad">✗ no collision-free path</span>
              )}
            </p>
            <div className="row">
              <Button onClick={randomize} variant="ghost">
                Randomize obstacles
              </Button>
            </div>
          </Panel>
        )}

        <Panel title="About this axis">
          <p className="muted">
            Everything here operates on <em>regions</em>, not points — the areal counterpart to the rest
            of the studio. Boolean ops, Minkowski sums and the motion planner all reduce to one robust
            primitive: the planar arrangement of polygon boundaries, classified by even-odd membership.
          </p>
        </Panel>
      </aside>
    </div>
  )
}

function Badge({ ok, text }: { ok: boolean; text: string }) {
  return <span className={`badge ${ok ? 'badge--ok' : 'badge--bad'}`}>{ok ? `✓ ${text}` : `✗ ${text}`}</span>
}

function recenter(ring: Ring, center: Point): Ring {
  const c = centroidOf(ring)
  return translate(ring, center.x - c.x, center.y - c.y)
}

function clampPt(p: Point): Point {
  return { x: Math.min(0.98, Math.max(0.02, p.x)), y: Math.min(0.98, Math.max(0.02, p.y)) }
}
