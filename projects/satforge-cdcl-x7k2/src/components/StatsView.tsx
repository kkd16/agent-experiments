import type { SolveResult } from '../sat'

export function StatsView({ result, elapsed }: { result: SolveResult; elapsed: number }) {
  const s = result.stats
  const propsPerConflict = s.conflicts ? s.propagations / s.conflicts : s.propagations
  const items: [string, string, string][] = [
    ['Decisions', fmt(s.decisions), 'branching choices made'],
    ['Propagations', fmt(s.propagations), 'implications via BCP'],
    ['Conflicts', fmt(s.conflicts), 'clauses learnt from'],
    ['Learnt clauses', fmt(s.learned), 'added to the database'],
    ['Clauses deleted', fmt(s.removed), 'by LBD reduction'],
    ['Restarts', fmt(s.restarts), 'Luby-scheduled'],
    ['Max depth', fmt(s.maxLevel), 'deepest decision level'],
    ['Peak trail', fmt(s.peakTrail), 'simultaneous assignments'],
    ['Minimized lits', fmt(s.minimizedLits), 'removed by self-subsumption'],
    ['Avg learnt size', s.learned ? (s.learntLiterals / s.learned).toFixed(1) : '—', 'literals/clause'],
    ['Props / conflict', propsPerConflict.toFixed(1), 'BCP intensity'],
    ['Solve time', `${(s.timeMs || elapsed).toFixed(1)} ms`, 'pure solver wall-time'],
  ]
  return (
    <div className="stats">
      <div className="stat-grid">
        {items.map(([label, value, hint]) => (
          <div key={label} className="stat-card">
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
            <div className="stat-hint">{hint}</div>
          </div>
        ))}
      </div>
      {result.history.length > 2 && <HistoryChart result={result} />}
    </div>
  )
}

function HistoryChart({ result }: { result: SolveResult }) {
  const h = result.history
  const w = 720
  const ht = 220
  const pad = { l: 48, r: 16, t: 16, b: 28 }
  const iw = w - pad.l - pad.r
  const ih = ht - pad.t - pad.b
  const maxConf = h[h.length - 1].conflicts || 1
  const maxLevel = Math.max(...h.map((p) => p.level), 1)
  const maxTrail = Math.max(...h.map((p) => p.trail), 1)
  const x = (c: number) => pad.l + (c / maxConf) * iw
  const yLevel = (v: number) => pad.t + ih - (v / maxLevel) * ih
  const yTrail = (v: number) => pad.t + ih - (v / maxTrail) * ih
  const path = (sel: (p: (typeof h)[number]) => number, y: (v: number) => number) =>
    h.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.conflicts).toFixed(1)},${y(sel(p)).toFixed(1)}`).join(' ')

  return (
    <div className="chart-wrap">
      <div className="chart-title">
        Search dynamics over time
        <span className="legend">
          <i className="dot level" /> decision depth <i className="dot trail" /> trail size
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${ht}`} className="chart" preserveAspectRatio="xMidYMid meet">
        <rect x={pad.l} y={pad.t} width={iw} height={ih} className="chart-bg" />
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={pad.l} x2={pad.l + iw} y1={pad.t + ih * f} y2={pad.t + ih * f} className="grid" />
        ))}
        <path d={path((p) => p.trail, yTrail)} className="line-trail" />
        <path d={path((p) => p.level, yLevel)} className="line-level" />
        <text x={pad.l} y={ht - 6} className="axis">
          0
        </text>
        <text x={pad.l + iw} y={ht - 6} className="axis" textAnchor="end">
          {fmt(maxConf)} conflicts
        </text>
      </svg>
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}
