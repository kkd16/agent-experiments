import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { buildProblem, DEFAULT_SPEC } from './problems'
import type { ProblemSpec } from './problems'
import { useSolver } from './useSolver'
import { ControlPanel } from './components/ControlPanel'
import type { SolverUiOptions } from './components/ControlPanel'
import { SolutionView } from './components/SolutionView'
import { StatsView } from './components/StatsView'
import { ImplicationGraph } from './components/ImplicationGraph'
import { TraceView } from './components/TraceView'
import { CnfView } from './components/CnfView'

type Tab = 'solution' | 'stats' | 'graph' | 'trace' | 'cnf'

export default function App() {
  const [spec, setSpec] = useState<ProblemSpec>(DEFAULT_SPEC)
  const [opts, setOpts] = useState<SolverUiOptions>({ minimize: true, randomize: false, restartBase: 100 })
  const [tab, setTab] = useState<Tab>('solution')
  const { state, run, reset } = useSolver()

  const problem = useMemo(() => buildProblem(spec), [spec])

  // Reset the result whenever the problem definition changes.
  const specKey = JSON.stringify(spec)
  const lastKey = useRef(specKey)
  useEffect(() => {
    if (lastKey.current !== specKey) {
      lastKey.current = specKey
      reset()
    }
  }, [specKey, reset])

  const solve = () => {
    if (problem.error) return
    const trace = problem.cnf.clauses.length <= 4000
    run(problem.cnf, {
      minimize: opts.minimize,
      randomFreq: opts.randomize ? 0.04 : 0,
      restartBase: opts.restartBase,
      trace,
      maxTrace: 40000,
      maxTimeMs: 15000,
      maxConflicts: 8_000_000,
      randomSeed: spec.seed * 2654435761 + 1,
    })
    setTab('solution')
  }

  // Solve the default problem once on load.
  const didInit = useRef(false)
  useEffect(() => {
    if (!didInit.current) {
      didInit.current = true
      solve()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const result = state.phase === 'done' ? state.result : null
  const hasTrace = !!result?.trace && result.trace.length > 0
  const hasGraph = !!result?.firstConflict

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⊨</span>
          <div>
            <h1>SatForge</h1>
            <p>A from-scratch CDCL SAT solver, visualized.</p>
          </div>
        </div>
        <a className="ghlink" href="https://en.wikipedia.org/wiki/Conflict-driven_clause_learning" target="_blank" rel="noreferrer">
          What is CDCL?
        </a>
      </header>

      <div className="layout">
        <ControlPanel
          spec={spec}
          onSpec={(patch) => setSpec((s) => ({ ...s, ...patch }))}
          opts={opts}
          onOpts={(patch) => setOpts((o) => ({ ...o, ...patch }))}
          onSolve={solve}
          solving={state.phase === 'solving'}
        />

        <main className="content">
          <div className="problem-head">
            <div>
              <h2>{problem.title}</h2>
              <p className="subtitle">{problem.subtitle}</p>
            </div>
            {result && <StatusPill status={result.status} elapsed={state.phase === 'done' ? state.elapsed : 0} />}
          </div>

          {problem.error && <div className="banner error">⚠ {problem.error}</div>}
          {problem.warnings?.map((w, i) => (
            <div key={i} className="banner warn">
              {w}
            </div>
          ))}

          <nav className="tabs">
            <TabBtn id="solution" tab={tab} setTab={setTab}>
              Solution
            </TabBtn>
            <TabBtn id="stats" tab={tab} setTab={setTab} disabled={!result}>
              Statistics
            </TabBtn>
            <TabBtn id="graph" tab={tab} setTab={setTab} disabled={!hasGraph}>
              Conflict graph
            </TabBtn>
            <TabBtn id="trace" tab={tab} setTab={setTab} disabled={!hasTrace}>
              Trace
            </TabBtn>
            <TabBtn id="cnf" tab={tab} setTab={setTab}>
              CNF
            </TabBtn>
          </nav>

          <section className="view">
            {state.phase === 'solving' && (
              <div className="placeholder">
                <div className="spinner" />
                <p>Running CDCL…</p>
              </div>
            )}
            {state.phase === 'error' && <div className="banner error">Solver error: {state.message}</div>}
            {state.phase === 'idle' && (
              <div className="placeholder">
                <p>Configure a problem and press Solve.</p>
              </div>
            )}

            {result && tab === 'solution' && <SolutionView problem={problem} result={result} />}
            {result && tab === 'stats' && (
              <StatsView result={result} elapsed={state.phase === 'done' ? state.elapsed : 0} />
            )}
            {result && tab === 'graph' && hasGraph && <ImplicationGraph snapshot={result.firstConflict!} />}
            {result && tab === 'trace' && hasTrace && (
              <TraceView trace={result.trace!} truncated={!!result.traceTruncated} />
            )}
            {tab === 'cnf' && <CnfView problem={problem} />}
          </section>
        </main>
      </div>

      <footer className="footer">
        Two-watched-literals BCP · VSIDS · first-UIP learning · non-chronological backjumping ·
        recursive minimization · Luby restarts · LBD clause deletion — all hand-written in TypeScript.
      </footer>
    </div>
  )
}

function TabBtn({
  id,
  tab,
  setTab,
  disabled,
  children,
}: {
  id: Tab
  tab: Tab
  setTab: (t: Tab) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button className={`tab ${tab === id ? 'active' : ''}`} disabled={disabled} onClick={() => setTab(id)}>
      {children}
    </button>
  )
}

function StatusPill({ status, elapsed }: { status: 'sat' | 'unsat' | 'unknown'; elapsed: number }) {
  const label = status === 'sat' ? 'SAT' : status === 'unsat' ? 'UNSAT' : 'UNKNOWN'
  return (
    <div className={`status-pill ${status}`}>
      <strong>{label}</strong>
      <span>{elapsed.toFixed(0)} ms</span>
    </div>
  )
}
