import { useRef, useState } from 'react'
import { PageHead, Panel, Slider } from '../ui/components'
import {
  add,
  discriminant,
  sampleCurve,
  snapToCurve,
  type RPoint,
  type RealCurve,
} from '../ecc/real'

const W = 560
const H = 460
const VX = 3.4 // half-width of the visible x window
const VY = 4.2 // half-height (y)

type Marker = { x: number; upper: boolean }

export function RealGroupLaw() {
  const [curve, setCurve] = useState<RealCurve>({ a: -1, b: 1 })
  const [mode, setMode] = useState<'add' | 'double'>('add')
  const [pMark, setPMark] = useState<Marker>({ x: -1.1, upper: true })
  const [qMark, setQMark] = useState<Marker>({ x: 0.9, upper: false })
  const [drag, setDrag] = useState<'P' | 'Q' | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const sx = (x: number) => (W / 2) * (1 + x / VX)
  const sy = (y: number) => (H / 2) * (1 - y / VY)
  const fromPx = (clientX: number): number => {
    const r = svgRef.current!.getBoundingClientRect()
    const px = ((clientX - r.left) / r.width) * W
    return (px / (W / 2) - 1) * VX
  }

  const P = snapToCurve(curve, pMark.x, pMark.upper)
  const Q = mode === 'double' ? P : snapToCurve(curve, qMark.x, qMark.upper)
  const { sum, slope, third } = add(curve, P, Q)
  const disc = discriminant(curve)
  const singular = Math.abs(disc) < 1e-6

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return
    const x = fromPx(e.clientX)
    const r = svgRef.current!.getBoundingClientRect()
    const my = ((e.clientY - r.top) / r.height) * H
    const upper = my < H / 2
    if (drag === 'P') setPMark({ x, upper })
    else setQMark({ x, upper })
  }

  const segs = sampleCurve(curve, -VX - 0.4, VX + 0.4, 900)

  return (
    <main className="page">
      <PageHead eyebrow="Lab 01 — the geometry" title="The Group Law over ℝ">
        An elliptic curve over the real numbers is a smooth cubic, symmetric about the x-axis. To
        “add” two points, draw the line through them, find the third place it meets the curve, and
        reflect that point across the axis. Drag <b>P</b> and <b>Q</b> below — the construction
        follows your hands.
      </PageHead>

      <div className="grid cols-2" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <div className="plotwrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            onPointerMove={onMove}
            onPointerUp={() => setDrag(null)}
            onPointerLeave={() => setDrag(null)}
          >
            <Grid sx={sx} sy={sy} />

            {/* the curve */}
            {segs.map((s, i) => (
              <polyline
                key={i}
                points={[...s.upper, ...[...s.lower].reverse()]
                  .filter((p): p is { x: number; y: number } => p !== null)
                  .map((p) => `${sx(p.x)},${sy(p.y)}`)
                  .join(' ')}
                fill="none"
                stroke={singular ? '#fb7185' : 'url(#cg)'}
                strokeWidth="2.4"
              />
            ))}

            {/* construction line + third point + reflection */}
            {P && Q && slope !== null && third && (
              <ConstructionLine
                P={P}
                third={third}
                sum={sum}
                slope={slope}
                sx={sx}
                sy={sy}
              />
            )}
            {P && Q && sum === null && (
              // vertical line P + (−P) = O
              <line
                x1={sx(P.x)}
                y1={0}
                x2={sx(P.x)}
                y2={H}
                stroke="#fbbf24"
                strokeWidth="1.4"
                strokeDasharray="5 5"
              />
            )}

            <DragPoint label="P" pt={P} color="#5eead4" sx={sx} sy={sy} onDown={() => setDrag('P')} />
            {mode === 'add' && (
              <DragPoint label="Q" pt={Q} color="#a78bfa" sx={sx} sy={sy} onDown={() => setDrag('Q')} />
            )}
            {sum && <ResultPoint pt={sum} sx={sx} sy={sy} label={mode === 'double' ? '2P' : 'P+Q'} />}

            <defs>
              <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#5eead4" />
                <stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          <Panel title="Curve">
            <Slider
              label="a"
              min={-3}
              max={3}
              step={0.05}
              value={curve.a}
              display={curve.a.toFixed(2)}
              onChange={(a) => setCurve((c) => ({ ...c, a }))}
            />
            <Slider
              label="b"
              min={-3}
              max={3}
              step={0.05}
              value={curve.b}
              display={curve.b.toFixed(2)}
              onChange={(b) => setCurve((c) => ({ ...c, b }))}
            />
            <div className="kv">
              <dt>equation</dt>
              <dd>
                y² = x³ {curve.a >= 0 ? '+' : '−'} {Math.abs(curve.a).toFixed(2)}x{' '}
                {curve.b >= 0 ? '+' : '−'} {Math.abs(curve.b).toFixed(2)}
              </dd>
              <dt>discriminant</dt>
              <dd>{disc.toFixed(2)}</dd>
            </div>
            {singular && (
              <div className="note" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
                Δ = 0 — the curve is singular (it has a cusp or self-intersection) and is not a valid
                group. Nudge a or b.
              </div>
            )}
          </Panel>

          <Panel title="Operation">
            <div className="seg" style={{ marginBottom: '0.9rem' }}>
              <button className={mode === 'add' ? 'on' : ''} onClick={() => setMode('add')}>
                P + Q
              </button>
              <button className={mode === 'double' ? 'on' : ''} onClick={() => setMode('double')}>
                2P (tangent)
              </button>
            </div>
            <dl className="kv">
              <dt>P</dt>
              <dd>{fmt(P)}</dd>
              {mode === 'add' && (
                <>
                  <dt>Q</dt>
                  <dd>{fmt(Q)}</dd>
                </>
              )}
              <dt>slope λ</dt>
              <dd>{slope === null ? '∞ (vertical)' : slope.toFixed(3)}</dd>
              <dt>{mode === 'double' ? '2P' : 'P + Q'}</dt>
              <dd style={{ color: 'var(--accent)' }}>{fmt(sum)}</dd>
            </dl>
            <div className="note">
              {mode === 'double'
                ? 'Doubling uses the tangent line at P. Its slope is (3x² + a) / 2y — calculus and the group law agreeing.'
                : sum === null
                  ? 'P and Q are vertical mirrors: the line misses any third point, so P + Q = O, the identity “at infinity.”'
                  : 'The dashed line is the chord; the hollow point is its third intersection; P + Q is that point reflected across the x-axis.'}
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="Why reflect?">
        <p style={{ color: 'var(--ink-dim)', margin: 0, maxWidth: '78ch' }}>
          The reflection is what makes addition <em>associative</em> with a clean identity. Define
          three collinear points to sum to zero; then P + Q is forced to be the reflection of the
          line’s third intersection. The point “at infinity” O is where all vertical lines meet — it
          plays the role of 0. Over a finite field the picture turns into a lattice of dots, but
          these exact formulas, taken mod p, still hold. That is the next lab.
        </p>
      </Panel>
    </main>
  )
}

function fmt(p: RPoint): string {
  return p === null ? 'O (point at infinity)' : `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`
}

function Grid({ sx, sy }: { sx: (x: number) => number; sy: (y: number) => number }) {
  const lines = []
  for (let x = -3; x <= 3; x++) lines.push(<line key={'vx' + x} x1={sx(x)} y1={0} x2={sx(x)} y2={H} stroke="#141d30" />)
  for (let y = -4; y <= 4; y++) lines.push(<line key={'hz' + y} x1={0} y1={sy(y)} x2={W} y2={sy(y)} stroke="#141d30" />)
  return (
    <g>
      {lines}
      <line x1={0} y1={sy(0)} x2={W} y2={sy(0)} stroke="#2b3a55" strokeWidth="1.2" />
      <line x1={sx(0)} y1={0} x2={sx(0)} y2={H} stroke="#2b3a55" strokeWidth="1.2" />
    </g>
  )
}

function ConstructionLine({
  P,
  third,
  sum,
  slope,
  sx,
  sy,
}: {
  P: { x: number; y: number }
  third: { x: number; y: number }
  sum: RPoint
  slope: number
  sx: (x: number) => number
  sy: (y: number) => number
}) {
  // extend the line across the whole view
  const x0 = -VX - 0.5
  const x1 = VX + 0.5
  const yAtLine = (x: number) => slope * (x - P.x) + P.y
  return (
    <g>
      <line
        x1={sx(x0)}
        y1={sy(yAtLine(x0))}
        x2={sx(x1)}
        y2={sy(yAtLine(x1))}
        stroke="#fbbf24"
        strokeWidth="1.3"
        strokeDasharray="5 5"
        opacity={0.85}
      />
      {/* third intersection (hollow) */}
      <circle cx={sx(third.x)} cy={sy(third.y)} r={5} fill="none" stroke="#fbbf24" strokeWidth="1.6" />
      {/* reflection drop */}
      {sum && (
        <line
          x1={sx(third.x)}
          y1={sy(third.y)}
          x2={sx(sum.x)}
          y2={sy(sum.y)}
          stroke="#f0abfc"
          strokeWidth="1.2"
          strokeDasharray="2 4"
        />
      )}
    </g>
  )
}

function DragPoint({
  label,
  pt,
  color,
  sx,
  sy,
  onDown,
}: {
  label: string
  pt: RPoint
  color: string
  sx: (x: number) => number
  sy: (y: number) => number
  onDown: () => void
}) {
  if (!pt) return null
  return (
    <g style={{ cursor: 'grab' }} onPointerDown={onDown}>
      <circle cx={sx(pt.x)} cy={sy(pt.y)} r={13} fill={color} opacity={0.16} />
      <circle cx={sx(pt.x)} cy={sy(pt.y)} r={6} fill={color} stroke="#06121a" strokeWidth="1.5" />
      <text x={sx(pt.x) + 11} y={sy(pt.y) - 9} fill={color} fontSize="14" fontWeight={700}>
        {label}
      </text>
    </g>
  )
}

function ResultPoint({
  pt,
  sx,
  sy,
  label,
}: {
  pt: { x: number; y: number }
  sx: (x: number) => number
  sy: (y: number) => number
  label: string
}) {
  return (
    <g>
      <circle cx={sx(pt.x)} cy={sy(pt.y)} r={6.5} fill="#f0abfc" stroke="#06121a" strokeWidth="1.5" />
      <text x={sx(pt.x) + 11} y={sy(pt.y) + 16} fill="#f0abfc" fontSize="14" fontWeight={700}>
        {label}
      </text>
    </g>
  )
}
