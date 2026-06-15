import { useMemo, useState } from 'react'
import type { TraceEvent } from '../sat'

export function TraceView({ trace, truncated }: { trace: TraceEvent[]; truncated: boolean }) {
  const [step, setStep] = useState(trace.length)
  const [filter, setFilter] = useState<'all' | 'decision' | 'conflict' | 'learn'>('all')

  const summary = useMemo(() => {
    let decisions = 0
    let conflicts = 0
    let learnt = 0
    let restarts = 0
    let level = 0
    for (let i = 0; i < step && i < trace.length; i++) {
      const e = trace[i]
      if (e.t === 'decision') {
        decisions++
        level = e.level
      } else if (e.t === 'propagate') level = e.level
      else if (e.t === 'conflict') conflicts++
      else if (e.t === 'learn') learnt++
      else if (e.t === 'backjump') level = e.level
      else if (e.t === 'restart') {
        restarts++
        level = 0
      }
    }
    return { decisions, conflicts, learnt, restarts, level }
  }, [trace, step])

  // Render a window around the current step for performance.
  const window = 160
  const lo = Math.max(0, step - window)
  const hi = Math.min(trace.length, step + 40)
  const rows: { idx: number; e: TraceEvent }[] = []
  for (let i = lo; i < hi; i++) {
    if (filter !== 'all' && trace[i].t !== filter) continue
    rows.push({ idx: i, e: trace[i] })
  }

  return (
    <div className="trace">
      <div className="trace-controls">
        <input
          type="range"
          min={0}
          max={trace.length}
          value={step}
          onChange={(e) => setStep(Number(e.target.value))}
          className="scrubber"
        />
        <div className="trace-step">
          step <strong>{step}</strong> / {trace.length}
        </div>
      </div>
      <div className="trace-summary">
        <span>depth {summary.level}</span>
        <span>{summary.decisions} decisions</span>
        <span>{summary.conflicts} conflicts</span>
        <span>{summary.learnt} learnt</span>
        <span>{summary.restarts} restarts</span>
      </div>
      <div className="trace-filter">
        {(['all', 'decision', 'conflict', 'learn'] as const).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      {truncated && <p className="muted small">Trace capped — showing the first {trace.length} events.</p>}
      <div className="trace-log">
        {rows.map(({ idx, e }) => (
          <div key={idx} className={`trace-row ${e.t} ${idx === step - 1 ? 'current' : ''} ${idx >= step ? 'future' : ''}`}>
            <span className="trace-idx">{idx}</span>
            <span className="trace-tag">{e.t}</span>
            <span className="trace-body">{describe(e)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function lit(d: number): string {
  return d < 0 ? `¬x${-d}` : `x${d}`
}

function describe(e: TraceEvent): string {
  switch (e.t) {
    case 'decision':
      return `branch ${lit(e.lit)} at level ${e.level}`
    case 'propagate':
      return `imply ${lit(e.lit)} (clause #${e.reason}) at level ${e.level}`
    case 'conflict':
      return `clause #${e.clause} falsified at level ${e.level}`
    case 'learn':
      return `learn (${e.lits.map(lit).join(' ∨ ')}) — LBD ${e.lbd}, backjump to ${e.backLevel}`
    case 'backjump':
      return `backtrack to level ${e.level}`
    case 'restart':
      return `restart after ${e.conflicts} conflicts`
    case 'reduce':
      return `delete ${e.removed} learnt clauses`
    case 'unit':
      return `assert unit ${lit(e.lit)} at root`
  }
}
