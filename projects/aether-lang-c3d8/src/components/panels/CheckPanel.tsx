import { useMemo, useState } from 'react'
import { runProperties } from '../../lang/property.ts'
import type { PropOutcome, PropReport } from '../../lang/property.ts'

interface Props {
  code: string
}

const RUNS = 200

// Does the source declare anything that looks like a property? (cheap heuristic
// so the panel can prompt before the user pays for a full run.)
function hasProps(code: string): boolean {
  return /\bprop[A-Za-z0-9_']*\s*=/.test(code)
}

export default function CheckPanel({ code }: Props) {
  const [run0, setRun0] = useState<{ code: string; report: PropReport } | null>(null)
  const [running, setRunning] = useState(false)

  // a report is only shown while it matches the current buffer (no effect needed)
  const report = run0 && run0.code === code ? run0.report : null
  const looksTestable = useMemo(() => hasProps(code), [code])

  const run = (): void => {
    setRunning(true)
    const snapshot = code
    setTimeout(() => {
      const r = runProperties(snapshot, { runs: RUNS, seed: 0x5eed })
      setRun0({ code: snapshot, report: r })
      setRunning(false)
    }, 10)
  }

  const summary = useMemo(() => {
    if (!report) return null
    const o = report.outcomes
    return {
      total: o.length,
      passed: o.filter((x) => x.status === 'pass').length,
      failed: o.filter((x) => x.status === 'fail').length,
      skipped: o.filter((x) => x.status === 'skip' || x.status === 'error').length,
    }
  }, [report])

  return (
    <div className="check-panel">
      <p className="panel-note">
        <strong>Aether Check</strong> is property-based testing driven by the type checker. Write a{' '}
        <code>prop_…</code> function returning <code>Bool</code>; Check reads its{' '}
        <em>inferred type</em>, generates random inputs from that type — numbers, strings, lists,
        tuples, records, your own ADTs, and even <strong>functions</strong> ({RUNS} per property) —
        runs them through the VM, and <strong>shrinks</strong> any failure to a minimal
        counterexample. Polymorphic arguments default to <code>Int</code>; runs are deterministic.
      </p>

      <div className="check-toolbar">
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? 'checking…' : '✓ Run property tests'}
        </button>
        {summary && (
          <span className="check-summary">
            <span className="ok">{summary.passed} passed</span>
            {summary.failed > 0 && <span className="bad"> · {summary.failed} failed</span>}
            {summary.skipped > 0 && <span className="muted"> · {summary.skipped} skipped</span>}
          </span>
        )}
      </div>

      {!report && !looksTestable && (
        <div className="check-hint">
          <p>No properties detected yet. Try:</p>
          <pre className="check-egcode">{EXAMPLE_SNIPPET}</pre>
        </div>
      )}

      {report?.error && (
        <div className="check-toplevel-error">
          The program doesn’t compile, so nothing can be tested:
          <pre>{report.error}</pre>
        </div>
      )}

      {report && !report.error && report.outcomes.length === 0 && (
        <div className="check-hint">
          <p>
            No <code>prop_…</code> bindings found. A property is a top-level binding whose name starts
            with <code>prop</code> and whose type is <code>… -&gt; Bool</code>.
          </p>
        </div>
      )}

      {report &&
        report.outcomes.map((o) => <OutcomeCard key={o.name} o={o} />)}
    </div>
  )
}

function OutcomeCard({ o }: { o: PropOutcome }) {
  const badge =
    o.status === 'pass'
      ? '✓ passed'
      : o.status === 'fail'
        ? '✗ failed'
        : o.status === 'error'
          ? '! error'
          : '— skipped'
  return (
    <div className={`check-card ${o.status}`}>
      <div className="check-card-head">
        <span className={`check-badge ${o.status}`}>{badge}</span>
        <span className="check-name">{o.name}</span>
        <code className="check-sig">{o.signature}</code>
      </div>

      {o.status === 'pass' && (
        <div className="check-detail ok">
          {o.tests} random cases — <code>{o.argTypes.join(' → ')} → Bool</code> — all held.
        </div>
      )}

      {o.status === 'fail' && (
        <div className="check-detail bad">
          <div>
            Falsified after <strong>{o.tests}</strong> test{o.tests === 1 ? '' : 's'}
            {o.shrinks !== undefined && o.shrinks > 0 && (
              <span> (shrunk {o.shrinks}×)</span>
            )}
            :
          </div>
          <div className="check-counterex">
            <span className="check-call">
              {o.name} {o.counterexample?.map((c, i) => <code key={i}>{wrap(c)}</code>)}
            </span>
          </div>
          {o.runtimeError && (
            <div className="check-runtime-err">raised at runtime: {o.runtimeError}</div>
          )}
        </div>
      )}

      {(o.status === 'skip' || o.status === 'error') && (
        <div className="check-detail muted">{o.message}</div>
      )}
    </div>
  )
}

// counterexample args that contain spaces are parenthesised for an unambiguous call
function wrap(s: string): string {
  return /\s/.test(s) && !(s.startsWith('[') || s.startsWith('(') || s.startsWith('{'))
    ? `(${s})`
    : s
}

const EXAMPLE_SNIPPET = `let prop_rev = fn xs -> reverse (reverse xs) == xs in
let prop_sorted = fn xs -> isSorted (sort xs) in
prop_rev`
