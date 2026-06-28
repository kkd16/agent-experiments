import { useMemo } from 'react'
import {
  type Cons,
  constraintLines,
  feasiblePolygon,
  isTwoVar,
  lattice,
} from '../lia'

interface Props {
  cons: Cons[]
  names: string[]
  /** Optional highlighted points (e.g. the Omega witness / the optimum). */
  marks?: { x: bigint; y: bigint; kind: 'sat' | 'opt' }[]
  /** Optional objective direction line through the optimum: c·x = value. */
  objective?: { a: bigint; b: bigint; value: bigint } | null
}

const SIZE = 380
const PAD = 34

/** A 2-D drawing of the integer lattice, the rational region, and its shadows. */
export function ShadowPlot({ cons, names, marks = [], objective = null }: Props) {
  const drawable = isTwoVar(cons) && (names.length === 2 || onlyTwoUsed(cons))

  const view = useMemo(() => {
    // Choose a window that comfortably holds the action.
    let R = 6n
    for (const m of marks) {
      const a = m.x < 0n ? -m.x : m.x
      const b = m.y < 0n ? -m.y : m.y
      if (a + 1n > R) R = a + 1n
      if (b + 1n > R) R = b + 1n
    }
    if (R > 12n) R = 12n
    return { lo: -R, hi: R }
  }, [marks])

  const data = useMemo(() => {
    if (!drawable) return null
    const { lo, hi } = view
    const pts = lattice(cons, lo, hi, lo, hi)
    const poly = feasiblePolygon(cons, Number(lo), Number(hi), Number(lo), Number(hi))
    const lines = constraintLines(cons, Number(lo), Number(hi), Number(lo), Number(hi))
    // Integer shadows: which x (resp. y) carries any feasible point.
    const shadowX = new Set<string>()
    const shadowY = new Set<string>()
    for (const p of pts)
      if (p.feasible) {
        shadowX.add(p.x.toString())
        shadowY.add(p.y.toString())
      }
    return { pts, poly, lines, shadowX, shadowY }
  }, [drawable, cons, view])

  if (!drawable || !data) {
    return (
      <div className="lia-cross lia-cross-note">
        2-D shadow view is shown for systems over exactly two variables.
      </div>
    )
  }

  const { lo, hi } = view
  const span = Number(hi - lo)
  const inner = SIZE - 2 * PAD
  const sx = (x: number) => PAD + ((x - Number(lo)) / span) * inner
  const sy = (y: number) => PAD + ((Number(hi) - y) / span) * inner

  const ticks: number[] = []
  for (let v = Number(lo); v <= Number(hi); v++) ticks.push(v)

  const polyStr = data.poly.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')

  return (
    <div className="shadow-wrap">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shadow-svg">
        {/* grid */}
        {ticks.map((t) => (
          <g key={`g${t}`}>
            <line x1={sx(t)} y1={PAD} x2={sx(t)} y2={SIZE - PAD} className="sp-grid" />
            <line x1={PAD} y1={sy(t)} x2={SIZE - PAD} y2={sy(t)} className="sp-grid" />
          </g>
        ))}
        {/* integer shadows on the axes */}
        {ticks.map((t) =>
          data.shadowX.has(String(t)) ? (
            <rect key={`shx${t}`} x={sx(t) - 4} y={SIZE - PAD + 4} width={8} height={6} className="sp-shadow-x" />
          ) : null,
        )}
        {ticks.map((t) =>
          data.shadowY.has(String(t)) ? (
            <rect key={`shy${t}`} x={PAD - 10} y={sy(t) - 4} width={6} height={8} className="sp-shadow-y" />
          ) : null,
        )}
        {/* feasible rational polygon */}
        {data.poly.length >= 3 && <polygon points={polyStr} className="sp-region" />}
        {/* constraint lines */}
        {data.lines.map((l, i) =>
          l.seg ? (
            <line
              key={`l${i}`}
              x1={sx(l.seg[0][0])}
              y1={sy(l.seg[0][1])}
              x2={sx(l.seg[1][0])}
              y2={sy(l.seg[1][1])}
              className={l.op === 'eq' ? 'sp-line-eq' : 'sp-line'}
            />
          ) : null,
        )}
        {/* objective level line through the optimum */}
        {objective && objective.b !== 0n && (
          <ObjectiveLine obj={objective} lo={Number(lo)} hi={Number(hi)} sx={sx} sy={sy} />
        )}
        {/* axes */}
        <line x1={PAD} y1={sy(0)} x2={SIZE - PAD} y2={sy(0)} className="sp-axis" />
        <line x1={sx(0)} y1={PAD} x2={sx(0)} y2={SIZE - PAD} className="sp-axis" />
        {/* lattice points */}
        {data.pts.map((p, i) => (
          <circle
            key={`p${i}`}
            cx={sx(Number(p.x))}
            cy={sy(Number(p.y))}
            r={p.feasible ? 3.4 : 1.7}
            className={p.feasible ? 'sp-dot-feas' : 'sp-dot-infeas'}
          />
        ))}
        {/* highlighted marks */}
        {marks.map((m, i) => (
          <g key={`m${i}`} transform={`translate(${sx(Number(m.x))},${sy(Number(m.y))})`}>
            <circle r={6.5} className={m.kind === 'opt' ? 'sp-mark-opt' : 'sp-mark-sat'} />
            <circle r={2.4} className="sp-mark-core" />
          </g>
        ))}
        {/* axis labels */}
        <text x={SIZE - PAD + 2} y={sy(0) - 6} className="sp-axis-label">
          {names[0] ?? 'x'}
        </text>
        <text x={sx(0) + 6} y={PAD - 6} className="sp-axis-label">
          {names[1] ?? 'y'}
        </text>
      </svg>
      <div className="shadow-legend">
        <span><i className="lg-feas" /> feasible lattice point</span>
        <span><i className="lg-region" /> rational region (real shadow)</span>
        <span><i className="lg-shadow" /> integer shadow on each axis</span>
        {marks.some((m) => m.kind === 'opt') && (
          <span><i className="lg-opt" /> optimum</span>
        )}
      </div>
    </div>
  )
}

function ObjectiveLine({
  obj,
  lo,
  hi,
  sx,
  sy,
}: {
  obj: { a: bigint; b: bigint; value: bigint }
  lo: number
  hi: number
  sx: (x: number) => number
  sy: (y: number) => number
}) {
  const a = Number(obj.a)
  const b = Number(obj.b)
  const val = Number(obj.value)
  // a·x + b·y = val  ⇒  y = (val − a·x) / b
  const y1 = (val - a * lo) / b
  const y2 = (val - a * hi) / b
  return <line x1={sx(lo)} y1={sy(y1)} x2={sx(hi)} y2={sy(y2)} className="sp-obj" />
}

/** True if the constraints only ever use variable ids 0 and 1. */
function onlyTwoUsed(cons: Cons[]): boolean {
  const used = new Set<number>()
  for (const c of cons) for (const v of c.lin.t.keys()) used.add(v)
  return [...used].every((v) => v === 0 || v === 1)
}
