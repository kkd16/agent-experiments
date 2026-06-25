// Evaluation graph: a sparkline of the position evaluation (White's point of
// view) across the whole game, filled in by a background search sweep. Click
// anywhere to jump to that move. Blunders — a big swing against the side that
// just moved — get a marker.

import { useRef } from 'react'

interface EvalGraphProps {
  evals: (number | null)[] // white-POV centipawns per node (index = ply 0..N)
  ply: number
  blunders: Set<number> // node indices flagged as a blunder by the mover
  onJump: (ply: number) => void
}

const W = 100
const H = 40
const CLAMP = 800 // cp; mates are pre-clamped to ±CLAMP upstream

function y(cp: number): number {
  const v = Math.max(-CLAMP, Math.min(CLAMP, cp))
  return H / 2 - (v / CLAMP) * (H / 2 - 2)
}

export default function EvalGraph({ evals, ply, blunders, onJump }: EvalGraphProps) {
  const ref = useRef<HTMLDivElement>(null)
  const n = evals.length - 1
  const x = (i: number): number => (n > 0 ? (i / n) * W : W / 2)

  // Polyline through the known points, and a filled area down to the midline.
  const pts: { i: number; v: number }[] = []
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]
    if (e !== null) pts.push({ i, v: e })
  }
  const line = pts.map((p) => `${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ')
  const area =
    pts.length > 0
      ? `M ${x(pts[0].i).toFixed(2)},${(H / 2).toFixed(2)} ` +
        pts.map((p) => `L ${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ') +
        ` L ${x(pts[pts.length - 1].i).toFixed(2)},${(H / 2).toFixed(2)} Z`
      : ''

  const handleClick = (e: React.MouseEvent) => {
    const el = ref.current
    if (!el || n <= 0) return
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onJump(Math.round(frac * n))
  }

  return (
    <div className="evalgraph" ref={ref} onClick={handleClick} title="click to jump to a move">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <rect x={0} y={0} width={W} height={H / 2} className="eg-white-zone" />
        <rect x={0} y={H / 2} width={W} height={H / 2} className="eg-black-zone" />
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} className="eg-mid" />
        {area && <path d={area} className="eg-area" />}
        {line && <polyline points={line} className="eg-line" />}
        {[...blunders].map((i) => {
          const e = evals[i]
          return e === null ? null : (
            <circle key={i} cx={x(i)} cy={y(e)} r={1.1} className="eg-blunder" />
          )
        })}
        {n > 0 && <line x1={x(ply)} y1={0} x2={x(ply)} y2={H} className="eg-cursor" />}
        {n > 0 && evals[ply] !== null && (
          <circle cx={x(ply)} cy={y(evals[ply] as number)} r={1.5} className="eg-dot" />
        )}
      </svg>
    </div>
  )
}
