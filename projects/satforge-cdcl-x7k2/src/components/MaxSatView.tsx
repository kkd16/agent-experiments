import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuiltProblem } from '../problems'
import { solveMaxSatTask } from '../tasks'
import { clauseSat } from '../sat'
import type { MaxSatResult } from '../sat'

type State =
  | { phase: 'running' }
  | { phase: 'done'; result: MaxSatResult; elapsed: number }
  | { phase: 'error'; message: string }

/**
 * The optimization view: runs weighted MaxSAT off the main thread, then shows the optimum
 * cost, the bound-convergence chart, a solution visualization, and the soft-clause breakdown.
 * Mounted with a fresh key per problem, so it begins in the "running" phase and the effect
 * just kicks off the async solve (no synchronous state-set in the effect).
 */
export function MaxSatView({ problem }: { problem: BuiltProblem }) {
  const [state, setState] = useState<State>({ phase: 'running' })
  const reqId = useRef(0)

  const launch = useCallback(() => {
    if (!problem.maxsat) return
    const id = ++reqId.current
    const t0 = performance.now()
    solveMaxSatTask(problem.maxsat, { strategy: problem.strategy ?? 'linear', maxConflicts: 4_000_000, maxTimeMs: 15000 })
      .then((result) => {
        if (id === reqId.current) setState({ phase: 'done', result, elapsed: performance.now() - t0 })
      })
      .catch((e) => {
        if (id === reqId.current) setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      })
  }, [problem])

  // Re-run from the button (an event handler — setState here is fine).
  const rerun = () => {
    setState({ phase: 'running' })
    launch()
  }

  // Kick off the initial solve once mounted.
  useEffect(() => launch(), [launch])

  const inst = problem.maxsat!
  return (
    <div className="maxsat-view">
      <p className="proof-intro">
        <strong>MaxSAT</strong> is optimization on top of SAT: satisfy every <em>hard</em> clause while
        minimizing the total weight of violated <em>soft</em> clauses. SatForge solves it two ways on the same
        CDCL engine — <strong>linear SAT-UNSAT</strong> ratchets an upper bound <em>down</em> one model at a
        time, while <strong>core-guided</strong> (WPM1) lifts a lower bound <em>up</em> by relaxing each unsat
        core. Pick a strategy in the panel; both reach the proven optimum.
      </p>

      <div className="maxsat-runbar">
        <button className="solve-btn count-btn" onClick={rerun} disabled={state.phase === 'running'}>
          {state.phase === 'running' ? 'Optimizing…' : '◆ Optimize'}
        </button>
        <span className="maxsat-meta">
          {inst.hard.length} hard · {inst.soft.length} soft · strategy: <strong>{problem.strategy}</strong>
        </span>
      </div>

      {state.phase === 'error' && <div className="banner error">MaxSAT error: {state.message}</div>}
      {state.phase === 'running' && (
        <div className="placeholder">
          <div className="spinner" />
          <p>Searching for the optimum…</p>
        </div>
      )}
      {state.phase === 'done' && <MaxSatResultView problem={problem} result={state.result} elapsed={state.elapsed} />}
    </div>
  )
}

function MaxSatResultView({ problem, result, elapsed }: { problem: BuiltProblem; result: MaxSatResult; elapsed: number }) {
  if (result.status === 'unsat-hard') {
    return (
      <div className="banner error">
        The <strong>hard</strong> clauses are unsatisfiable — no assignment can satisfy them, so there is no
        feasible solution to optimize.
      </div>
    )
  }
  if (result.status === 'unknown' || !result.model) {
    return <div className="banner warn">The search budget was exhausted before proving optimality. Try a smaller instance.</div>
  }

  const inst = problem.maxsat!
  const model = result.model
  const violated = inst.soft.filter((s) => !clauseSat(s.lits, model))
  const violatedWeight = violated.reduce((a, c) => a + c.weight, 0)
  const totalSoft = inst.soft.reduce((a, c) => a + c.weight, 0)
  const satWeight = totalSoft - violatedWeight

  return (
    <div className="maxsat-result">
      <div className="maxsat-headline">
        <div className="maxsat-cost">
          <span className="count-label">Optimum {problem.costLabel ?? 'cost'}</span>
          <span className="count-number">{result.cost}</span>
          <span className="count-note">proven optimal · {result.iterations} iterations · {elapsed.toFixed(0)} ms</span>
        </div>
        <HighlightStat problem={problem} result={result} />
      </div>

      <ConvergenceChart result={result} optimum={result.cost} />

      <div className="maxsat-bars">
        <div className="chart-title">
          <strong>Soft clauses</strong>
          <span>
            satisfied {satWeight} / {totalSoft} weight · {violated.length} of {inst.soft.length} clauses violated
          </span>
        </div>
        <div className="wbar">
          <div className="wbar-sat" style={{ width: `${totalSoft ? (satWeight / totalSoft) * 100 : 100}%` }} />
          <div className="wbar-vio" style={{ width: `${totalSoft ? (violatedWeight / totalSoft) * 100 : 0}%` }} />
        </div>
        <div className="legend">
          <span className="legend-item"><i className="dot sat-dot" /> satisfied weight {satWeight}</span>
          <span className="legend-item"><i className="dot vio-dot" /> violated weight {violatedWeight}</span>
        </div>
      </div>

      {problem.maxRender === 'maxcut' && problem.wgraph && problem.decodeMaxCut && (
        <GraphView problem={problem} model={model} mode="maxcut" />
      )}
      {problem.maxRender === 'subset' && problem.wgraph && problem.decodeSubset && (
        <GraphView problem={problem} model={model} mode="subset" />
      )}
      {problem.maxRender === 'model' && <AssignmentView model={model} numVars={inst.numVars} />}
    </div>
  )
}

function HighlightStat({ problem, result }: { problem: BuiltProblem; result: MaxSatResult }) {
  if (problem.maxRender === 'maxcut' && problem.totalWeight !== undefined) {
    return (
      <div className="maxsat-cost alt">
        <span className="count-label">Maximum cut weight</span>
        <span className="count-number">{problem.totalWeight - result.cost}</span>
        <span className="count-note">of {problem.totalWeight} total edge weight</span>
      </div>
    )
  }
  if (problem.kind === 'maxindset' && problem.totalWeight !== undefined) {
    return (
      <div className="maxsat-cost alt">
        <span className="count-label">Largest independent set</span>
        <span className="count-number">{problem.totalWeight - result.cost}</span>
        <span className="count-note">of {problem.totalWeight} vertices</span>
      </div>
    )
  }
  return null
}

/** A two-line bound-convergence chart: UB falling, LB rising, meeting at the optimum. */
function ConvergenceChart({ result, optimum }: { result: MaxSatResult; optimum: number }) {
  const w = 520
  const h = 150
  const padL = 38
  const padB = 22
  const padT = 12
  const pts = result.progress
  if (pts.length === 0) return null
  const maxIter = Math.max(1, pts.length - 1)
  // y-range across all known bounds.
  const vals: number[] = [optimum]
  for (const p of pts) {
    if (p.ub !== null) vals.push(p.ub)
    vals.push(p.lb)
  }
  const yMax = Math.max(...vals, 1)
  const yMin = 0
  const x = (i: number) => padL + (i / maxIter) * (w - padL - 8)
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * (h - padT - padB)

  const ubLine = pts.filter((p) => p.ub !== null).map((p) => `${x(p.iteration - 1)},${y(p.ub!)}`)
  const lbLine = pts.map((p) => `${x(p.iteration - 1)},${y(p.lb)}`)

  return (
    <div className="chart-wrap">
      <div className="chart-title">
        <strong>Bound convergence</strong>
        <span>{result.strategy === 'linear' ? 'upper bound ratchets down to the optimum' : 'lower bound climbs to the optimum'}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="chart" preserveAspectRatio="xMidYMid meet">
        {/* optimum guide line */}
        <line x1={padL} x2={w - 8} y1={y(optimum)} y2={y(optimum)} className="opt-guide" />
        <text x={padL - 6} y={y(optimum) + 3} className="axis" textAnchor="end">
          {optimum}
        </text>
        <text x={padL - 6} y={y(yMax) + 3} className="axis" textAnchor="end">
          {yMax}
        </text>
        {lbLine.length > 1 && <polyline points={lbLine.join(' ')} className="lb-line" />}
        {ubLine.length > 1 && <polyline points={ubLine.join(' ')} className="ub-line" />}
        {pts.map((p, i) =>
          p.ub !== null ? <circle key={`u${i}`} cx={x(p.iteration - 1)} cy={y(p.ub)} r={3} className="ub-dot" /> : null,
        )}
        {pts.map((p, i) => (
          <circle key={`l${i}`} cx={x(p.iteration - 1)} cy={y(p.lb)} r={2.5} className="lb-dot" />
        ))}
      </svg>
      <div className="legend">
        <span className="legend-item"><i className="dot ub-dot-l" /> upper bound (best model)</span>
        <span className="legend-item"><i className="dot lb-dot-l" /> lower bound (proven)</span>
      </div>
    </div>
  )
}

/** Circular graph layout, colored by partition / membership. */
function GraphView({ problem, model, mode }: { problem: BuiltProblem; model: boolean[]; mode: 'maxcut' | 'subset' }) {
  const g = problem.wgraph!
  const n = g.numVertices
  const size = 320
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 28
  const pos = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
  const chosen = (v: number) => !!model[v + 1]

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} className="maxsat-graph" preserveAspectRatio="xMidYMid meet">
        {g.edges.map((e, i) => {
          const cut = mode === 'maxcut' ? chosen(e.u) !== chosen(e.v) : false
          const inside = mode === 'subset' ? chosen(e.u) && chosen(e.v) : false
          const cls = mode === 'maxcut' ? (cut ? 'g-edge cut' : 'g-edge uncut') : inside ? 'g-edge bad' : 'g-edge'
          return (
            <line key={i} x1={pos[e.u].x} y1={pos[e.u].y} x2={pos[e.v].x} y2={pos[e.v].y} className={cls} strokeWidth={mode === 'maxcut' ? Math.min(4, 1 + e.w / 3) : 1.5} />
          )
        })}
        {pos.map((p, v) => (
          <g key={v}>
            <circle cx={p.x} cy={p.y} r={11} className={`g-node ${mode === 'maxcut' ? (chosen(v) ? 'side-a' : 'side-b') : chosen(v) ? 'chosen' : 'unchosen'}`} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" className="g-label">
              {v}
            </text>
          </g>
        ))}
      </svg>
      <div className="legend">
        {mode === 'maxcut' ? (
          <>
            <span className="legend-item"><i className="dot side-a-dot" /> side A</span>
            <span className="legend-item"><i className="dot side-b-dot" /> side B</span>
            <span className="legend-item"><i className="dot cut-dot" /> cut edge</span>
          </>
        ) : (
          <>
            <span className="legend-item"><i className="dot chosen-dot" /> chosen</span>
            <span className="legend-item"><i className="dot unchosen-dot" /> not chosen</span>
          </>
        )}
      </div>
    </div>
  )
}

function AssignmentView({ model, numVars }: { model: boolean[]; numVars: number }) {
  return (
    <div className="model-view">
      <div className="chart-title">
        <strong>Optimal assignment</strong>
        <span>{numVars} variables</span>
      </div>
      <div className="model-grid">
        {Array.from({ length: numVars }, (_, i) => i + 1).map((v) => (
          <span key={v} className={`lit ${model[v] ? 'true' : 'false'}`}>
            {model[v] ? v : -v}
          </span>
        ))}
      </div>
    </div>
  )
}
