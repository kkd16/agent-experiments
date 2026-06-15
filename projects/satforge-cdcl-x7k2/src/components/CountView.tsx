import { useRef, useState } from 'react'
import type { CNF } from '../sat'
import { countModelsTask } from '../tasks'
import type { CountTaskResult } from '../tasks'

type State =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; result: CountTaskResult }
  | { phase: 'error'; message: string }

/**
 * Exact model counting (#SAT): how many distinct assignments satisfy the formula?
 * Runs the from-scratch component-caching counter off the main thread.
 */
export function CountView({ cnf }: { cnf: CNF }) {
  const [state, setState] = useState<State>({ phase: 'idle' })
  const reqId = useRef(0)

  const run = () => {
    const id = ++reqId.current
    setState({ phase: 'running' })
    countModelsTask(cnf, 600000)
      .then((result) => {
        if (id === reqId.current) setState({ phase: 'done', result })
      })
      .catch((e) => {
        if (id === reqId.current) setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      })
  }

  return (
    <div className="count-view">
      <p className="proof-intro">
        Deciding satisfiability asks <em>whether</em> a solution exists; <strong>#SAT</strong> asks{' '}
        <em>how many</em>. SatForge counts them exactly with a from-scratch DPLL counter that
        unit-propagates, splits the formula into independent <strong>connected components</strong> (whose
        counts multiply), and <strong>caches</strong> repeated sub-formulas — the same idea behind solvers
        like Cachet and sharpSAT. The arithmetic is exact BigInt, so even astronomically large counts are
        precise to the last digit.
      </p>

      <button className="solve-btn count-btn" onClick={run} disabled={state.phase === 'running'}>
        {state.phase === 'running' ? 'Counting…' : '∑ Count all solutions'}
      </button>

      {state.phase === 'error' && <div className="banner error">Counter error: {state.message}</div>}

      {state.phase === 'done' && <CountResultView result={state.result} />}
    </div>
  )
}

function CountResultView({ result }: { result: CountTaskResult }) {
  if (!result.exact || result.count === null) {
    return (
      <div className="banner warn">
        The search budget was exhausted before the exact count finished ({fmt(result.nodes)} nodes explored).
        This formula has too many independent choices to count exactly in the browser — try a smaller instance.
      </div>
    )
  }
  const c = result.count
  const digits = c.toString()
  return (
    <div className="count-result">
      <div className="count-big">
        <span className="count-label">Satisfying assignments</span>
        <span className="count-number" title={digits}>
          {groupDigits(digits)}
        </span>
        {digits.length > 12 && <span className="count-sci">≈ {scientific(c)}</span>}
        {c === 0n && <span className="count-note">— the formula is unsatisfiable.</span>}
        {c === 1n && <span className="count-note">— the solution is unique.</span>}
      </div>
      <div className="stat-grid proof-grid">
        <Stat value={fmt(result.nodes)} label="Search nodes" hint="DPLL recursion depth-first" />
        <Stat value={fmt(result.cacheHits)} label="Cache hits" hint="sub-formulas reused" />
        <Stat value={fmt(result.cacheSize)} label="Cached forms" hint="distinct sub-formulas" />
        <Stat value={`${result.timeMs.toFixed(1)} ms`} label="Count time" hint="exact #SAT" />
      </div>
    </div>
  )
}

function Stat({ value, label, hint }: { value: string; label: string; hint: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-hint">{hint}</div>
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** Group a decimal digit string into thousands with thin spaces. */
function groupDigits(s: string): string {
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return neg ? '-' + grouped : grouped
}

/** A short scientific-notation approximation of a BigInt. */
function scientific(n: bigint): string {
  const s = (n < 0n ? -n : n).toString()
  const exp = s.length - 1
  const mantissa = `${s[0]}.${s.slice(1, 3)}`
  return `${n < 0n ? '-' : ''}${mantissa} × 10^${exp}`
}
