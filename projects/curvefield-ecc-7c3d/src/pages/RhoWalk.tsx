import { useEffect, useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import { Curve, fmtPoint, type Point } from '../ecc/curve'
import { pollardRhoWalk, type RhoWalk } from '../ecc/dlog'

// A handful of prime-order toy curves where the single-step walk recovers k
// cleanly for every secret — chosen so the ρ is always well-formed on screen.
const PRESETS = [
  { label: 'F₉₇ · y²=x³+x+3', a: 1n, b: 3n, p: 97n },
  { label: 'F₉₇ · y²=x³+3x+2', a: 3n, b: 2n, p: 97n },
  { label: 'F₁₂₇ · y²=x³+7', a: 0n, b: 7n, p: 127n },
  { label: 'F₁₂₇ · y²=x³+3', a: 0n, b: 3n, p: 127n },
]

const PART_COLORS = ['#f5a3c7', '#8fd6ff', '#ffd596'] // the three partition classes

export function RhoWalk() {
  const [preset, setPreset] = useState(2)
  const [k, setK] = useState(45)

  const { curve, G, order } = useMemo(() => {
    const pr = PRESETS[preset]
    const c = new Curve(pr.a, pr.b, pr.p)
    const g = c.points().find((pt) => pt !== null) ?? null
    return { curve: c, G: g, order: c.count() }
  }, [preset])

  const ord = Number(order)
  const secret = ((k % ord) + ord) % ord || 1
  const Q: Point = G ? curve.multiply(BigInt(secret), G) : null
  const walk: RhoWalk | null = useMemo(
    () => (G && Q ? pollardRhoWalk(curve, G, Q, order) : null),
    [curve, G, Q, order],
  )

  return (
    <main className="page">
      <PageHead eyebrow="Lab 07 — the shape of an attack" title="Pollard's ρ, Drawn">
        Pollard's rho solves the discrete log in <code>O(√n)</code> time and{' '}
        <code>O(1)</code> memory by following a pseudo-random walk until it runs into itself. The
        path it traces looks like the Greek letter ρ: a straight <em>tail</em> that feeds into a
        closed <em>cycle</em>. The instant the walk revisits a point, two different{' '}
        <code>a·P + b·Q</code> labels collide on the same point — and that one equation gives up
        the secret. Watch it happen.
      </PageHead>

      <div className="seg" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        {PRESETS.map((pr, i) => (
          <button key={i} className={preset === i ? 'on' : ''} onClick={() => setPreset(i)}>
            {pr.label}
          </button>
        ))}
      </div>

      <Panel
        title="The walk"
        sub={
          walk
            ? `group order ${ord} · tail ${walk.tailLen} · cycle ${walk.cycleLen} · ${walk.path.length} steps to collision`
            : 'no usable base point'
        }
      >
        <Slider
          label="secret k"
          value={k}
          min={2}
          max={Math.max(3, ord - 1)}
          display={`${secret}`}
          onChange={(v) => setK(v)}
        />
        {/* Keying on the walk identity remounts the animator, resetting its
            cursor and play state without a setState-in-effect. */}
        {walk && <WalkAnimator key={`${preset}:${secret}`} walk={walk} />}
      </Panel>

      {walk && <RhoSolve walk={walk} secret={secret} order={order} />}
    </main>
  )
}

// ── The self-contained animator (its own cursor + play state) ────────────────

function WalkAnimator({ walk }: { walk: RhoWalk }) {
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const total = walk.path.length

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setCursor((c) => {
        if (c >= total) {
          setPlaying(false)
          return c
        }
        return c + 1
      })
    }, 320)
    return () => clearInterval(id)
  }, [playing, total])

  return (
    <>
      <div className="btn-row" style={{ margin: '0.4rem 0 0.8rem' }}>
        <button
          className="btn"
          onClick={() => {
            if (cursor >= total) setCursor(0)
            setPlaying((p) => !p)
          }}
        >
          {playing ? '❚❚ pause' : '▶ play'}
        </button>
        <button className="btn ghost" onClick={() => { setCursor(0); setPlaying(false) }}>
          ↺ reset
        </button>
        <button className="btn ghost" onClick={() => { setCursor(total); setPlaying(false) }}>
          ⤓ to collision
        </button>
      </div>
      <RhoDiagram walk={walk} cursor={cursor} />
      <div className="legend" style={{ marginTop: '0.6rem' }}>
        <span><i style={{ background: PART_COLORS[0] }} />class 0 (+Q)</span>
        <span><i style={{ background: PART_COLORS[1] }} />class 1 (double)</span>
        <span><i style={{ background: PART_COLORS[2] }} />class 2 (+P)</span>
        <span><i style={{ background: '#ff5d5d' }} />collision</span>
      </div>
    </>
  )
}

// ── The ρ-shaped diagram ─────────────────────────────────────────────────────

function RhoDiagram({ walk, cursor }: { walk: RhoWalk; cursor: number }) {
  const W = 760
  const H = 360
  const { path, tailLen, cycleLen, matchIndex } = walk

  // Lay out the cycle around a circle on the right; the tail as a line into it.
  const R = Math.min(130, 16 + cycleLen * 6)
  const cx = W - R - 70
  const cy = H / 2
  const entryAngle = Math.PI // the tail enters at the circle's leftmost point

  const pos = (i: number): { x: number; y: number } => {
    if (i < tailLen) {
      // Tail: evenly spaced from the left edge to the circle entry point.
      const entry = { x: cx + R * Math.cos(entryAngle), y: cy + R * Math.sin(entryAngle) }
      const startX = 40
      const t = tailLen <= 1 ? 1 : i / tailLen
      return { x: startX + (entry.x - startX) * t, y: cy }
    }
    // Cycle: distribute around the circle, starting at the entry going clockwise.
    const j = i - tailLen
    const ang = entryAngle - (2 * Math.PI * j) / cycleLen
    return { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) }
  }

  const shown = Math.min(cursor, path.length)

  // Edges between consecutive nodes, plus the closing edge back to the match.
  const edges: { a: { x: number; y: number }; b: { x: number; y: number }; active: boolean }[] = []
  for (let i = 0; i < path.length - 1; i++) {
    edges.push({ a: pos(i), b: pos(i + 1), active: i < shown - 1 })
  }
  // Closing edge: last node collides back onto matchIndex.
  edges.push({
    a: pos(path.length - 1),
    b: pos(matchIndex),
    active: shown >= path.length,
  })

  return (
    <div className="plotwrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Pollard rho walk">
        {edges.map((e, i) => {
          const closing = i === edges.length - 1
          return (
            <line
              key={i}
              x1={e.a.x}
              y1={e.a.y}
              x2={e.b.x}
              y2={e.b.y}
              stroke={closing ? '#ff5d5d' : e.active ? '#b794f6' : '#3a3550'}
              strokeWidth={closing ? 2.5 : e.active ? 2 : 1}
              strokeDasharray={closing ? '6 4' : undefined}
            />
          )
        })}
        {path.map((n, i) => {
          const p = pos(i)
          const isEntry = i === matchIndex
          const visible = i < shown
          const isCursor = i === shown - 1
          return (
            <g key={i}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isEntry ? 9 : 6}
                fill={visible ? PART_COLORS[n.partition] : '#2a2740'}
                stroke={isEntry ? '#ff5d5d' : isCursor ? '#fff' : '#1c1a2e'}
                strokeWidth={isEntry ? 3 : isCursor ? 2.5 : 1}
              />
            </g>
          )
        })}
        {/* Label the tail and cycle. */}
        <text x={70} y={cy - 18} fill="#8a85a5" fontSize="13">
          tail ({tailLen})
        </text>
        <text x={cx - 14} y={cy - R - 10} fill="#8a85a5" fontSize="13">
          cycle ({cycleLen})
        </text>
      </svg>
    </div>
  )
}

// ── The arithmetic that falls out of the collision ───────────────────────────

function RhoSolve({ walk, secret, order }: { walk: RhoWalk; secret: number; order: bigint }) {
  const { path, matchIndex, collisionIndex, k } = walk
  if (matchIndex < 0 || collisionIndex < 0) return null
  const A = path[matchIndex]
  // The colliding node's labels are those of the node that wraps onto matchIndex —
  // i.e. the last node in `path`, whose successor equals path[matchIndex].
  const last = path[path.length - 1]

  return (
    <Panel
      title="From collision to key"
      sub="Two labels for the same point give one linear equation in the unknown k."
    >
      <table className="data">
        <tbody>
          <tr>
            <td className="mono">point</td>
            <td className="mono">{fmtPoint(A.X)}</td>
          </tr>
          <tr>
            <td className="mono">first visit (tail)</td>
            <td className="mono">
              a={A.a.toString()}, b={A.b.toString()}
            </td>
          </tr>
          <tr>
            <td className="mono">revisit (cycle wraps)</td>
            <td className="mono">
              a={last.a.toString()}, b={last.b.toString()}
            </td>
          </tr>
          <tr>
            <td className="mono">⇒ equation</td>
            <td className="mono">
              ({A.a.toString()}−{last.a.toString()})·P = ({last.b.toString()}−{A.b.toString()})·Q
              (mod {order.toString()})
            </td>
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
        {k !== null ? (
          <>
            <Verdict ok={k === BigInt(secret)}>
              recovered k = {k.toString()}
            </Verdict>
            <span className="note">
              the slider's secret was {secret} — {k === BigInt(secret) ? 'exact match' : 'mismatch'}
            </span>
          </>
        ) : (
          <Verdict ok={false}>
            degenerate collision (b-difference not invertible) — rho restarts from a fresh offset
          </Verdict>
        )}
      </div>
      <div className="note" style={{ marginTop: '0.6rem' }}>
        The whole attack cost {path.length} steps on a group of order {order.toString()} — close to{' '}
        <code>√{order.toString()} ≈ {Math.round(Math.sqrt(Number(order)))}</code>. That square-root
        scaling is exactly why a 256-bit curve (≈ 2¹²⁸ steps) is out of reach.
      </div>
    </Panel>
  )
}
