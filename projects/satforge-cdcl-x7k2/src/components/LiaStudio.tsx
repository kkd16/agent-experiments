import { useMemo, useState } from 'react'
import './LiaStudio.css'
import {
  LIA_EXAMPLES,
  OmegaBudgetError,
  bruteForce,
  omegaTest,
  parseLia,
  runLiaChecks,
  verifyModel,
  type LiaCheckReport,
  type OmegaResult,
} from '../lia'

type Source = { kind: 'example'; index: number } | { kind: 'custom' }

interface Decided {
  result: OmegaResult | null
  error: string | null
}

/** Largest half-width K so that (2K+1)^n stays under the in-UI brute budget. */
function boxRadius(n: number): bigint {
  const BUDGET = 80_000
  let k = 1
  while (Math.pow(2 * (k + 1) + 1, n) <= BUDGET && k < 400) k++
  return BigInt(k)
}

interface CrossCheck {
  kind: 'confirm' | 'consistent' | 'outside' | 'mismatch' | 'skip'
  text: string
}

export function LiaStudio() {
  const [source, setSource] = useState<Source>({ kind: 'example', index: 0 })
  const [src, setSrc] = useState<string>(LIA_EXAMPLES[0].src)
  const [checks, setChecks] = useState<LiaCheckReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [showTrace, setShowTrace] = useState(false)

  const parsed = useMemo(() => parseLia(src), [src])

  const decided = useMemo<Decided>(() => {
    if (!parsed.ok) return { result: null, error: null }
    try {
      const result = omegaTest(parsed.constraints, parsed.names.length, (v) => parsed.names[v] ?? `σ${v}`, {
        trace: true,
        maxNodes: 200_000,
        maxTrace: 600,
      })
      return { result, error: null }
    } catch (e) {
      if (e instanceof OmegaBudgetError) return { result: null, error: e.message }
      return { result: null, error: e instanceof Error ? e.message : 'solver error' }
    }
  }, [parsed])

  // Independent corroboration: exhaustive search of a finite box, sharing no
  // code with the Omega test. It can confirm SAT outright and is at least
  // consistent with UNSAT (no counterexample inside the searched box).
  const cross = useMemo<CrossCheck>(() => {
    if (!parsed.ok || !decided.result) return { kind: 'skip', text: '' }
    const n = parsed.names.length
    if (n > 4) return { kind: 'skip', text: `independent search skipped (${n} variables — box too large)` }
    const K = boxRadius(n)
    const brute = bruteForce(parsed.constraints, n, -K, K)
    const res = decided.result
    if (res.status === 'sat') {
      if (brute.sat) return { kind: 'confirm', text: `confirmed by exhaustive search over [−${K}, ${K}]${sup(n)}` }
      // Omega's witness may lie outside the searched box — verify it directly.
      return verifyModel(parsed.constraints, res.model)
        ? { kind: 'outside', text: `model checks out, but lies outside the ±${K} search box` }
        : { kind: 'mismatch', text: 'internal error: model fails the constraints' }
    }
    // Omega says UNSAT.
    if (brute.sat) return { kind: 'mismatch', text: 'mismatch: brute force found a solution the solver missed' }
    return { kind: 'consistent', text: `no solution in [−${K}, ${K}]${sup(n)} (consistent with unsat)` }
  }, [parsed, decided])

  const pickExample = (index: number) => {
    setSource({ kind: 'example', index })
    setSrc(LIA_EXAMPLES[index].src)
    setShowTrace(false)
  }
  const onEdit = (v: string) => {
    setSrc(v)
    setSource({ kind: 'custom' })
  }
  const runVerify = () => {
    setChecking(true)
    setTimeout(() => {
      setChecks(runLiaChecks())
      setChecking(false)
    }, 30)
  }

  const blurb = source.kind === 'example' ? LIA_EXAMPLES[source.index].blurb : 'Your own integer linear system.'
  const res = decided.result
  const verdictClass = res == null ? '' : res.status === 'sat' ? 'sat' : 'unsat'
  const verdictLabel = res == null ? '' : res.status === 'sat' ? 'SATISFIABLE' : 'UNSATISFIABLE'

  return (
    <div className="layout">
      <aside className="control lia-side">
        <p className="imc-blurb">
          The <strong>Omega test</strong> (Pugh 1991) decides quantifier-free linear arithmetic over
          the <strong>integers</strong> — not the rationals. Rational feasibility is easy
          (Fourier–Motzkin); the integer question is harder because the projected interval for an
          eliminated variable can be nonempty yet contain no integer. Omega closes that gap with the{' '}
          <strong>dark shadow</strong> (a tightened projection, sound for SAT) and{' '}
          <strong>gray-shadow splinters</strong> (a finite case split that makes it exact). Every
          coefficient is a <code>BigInt</code>, and each SAT verdict ships a model the studio
          re-checks against your constraints.
        </p>

        <div className="lia-examples">
          <h3>Examples</h3>
          <div className="lia-ex-grid">
            {LIA_EXAMPLES.map((ex, i) => (
              <button
                key={i}
                className={source.kind === 'example' && source.index === i ? 'active' : ''}
                onClick={() => pickExample(i)}
                title={ex.blurb}
              >
                {ex.title}
              </button>
            ))}
          </div>
        </div>

        <div className="lia-selftest">
          <h3>Self-test</h3>
          <p>
            Cross-checks the Omega test against an exhaustive integer oracle over bounded systems
            (where the box is the whole feasible region) plus a battery of hand-derived classics —
            verdicts and SAT certificates both.
          </p>
          <button onClick={runVerify} disabled={checking}>
            {checking ? 'Running…' : '▶ Run self-test'}
          </button>
          {checks && (
            <div className={`lia-check ${checks.fail === 0 ? 'ok' : 'bad'}`}>
              {checks.fail === 0 ? (
                <>✓ {checks.pass} assertions passed</>
              ) : (
                <>
                  ✗ {checks.fail} failed / {checks.pass} passed
                  <ul>
                    {checks.messages.slice(0, 6).map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>LIA Studio</h2>
            <p className="subtitle">{blurb}</p>
          </div>
          {res && <span className={`status-pill ${verdictClass}`}>{verdictLabel}</span>}
        </div>

        <div className="lia-editor">
          <label>Constraints — one relation per line ( =, ≤, ≥, &lt;, &gt; ); coefficients like 3x or 3*x</label>
          <textarea value={src} onChange={(e) => onEdit(e.target.value)} spellCheck={false} rows={9} />
          {!parsed.ok && (
            <div className="banner error">
              ⚠ {parsed.error}
              {parsed.line ? ` (line ${parsed.line})` : ''}
            </div>
          )}
          {decided.error && <div className="banner error">⚠ {decided.error}</div>}
        </div>

        {parsed.ok && (
          <div className="lia-summary">
            <span className="lia-chip">
              {parsed.names.length} variable{parsed.names.length === 1 ? '' : 's'}
            </span>
            <span className="lia-chip">
              {parsed.constraints.length} constraint{parsed.constraints.length === 1 ? '' : 's'}
            </span>
            <span className="lia-vars">{parsed.names.join(', ')}</span>
          </div>
        )}

        {res && res.status === 'sat' && (
          <section className="view lia-model">
            <h3>An integer solution</h3>
            <div className="lia-model-grid">
              {[...res.model.entries()].map(([v, val]) => (
                <div key={v} className="lia-assign">
                  <span className="lia-name">{parsed.ok ? parsed.names[v] : `x${v}`}</span>
                  <span className="lia-eq">=</span>
                  <span className="lia-val">{val.toString()}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {res && res.status === 'unsat' && (
          <section className="view lia-unsat">
            <h3>No integer solution exists</h3>
            <p>
              The Omega test eliminated every variable and reached a contradiction — proven over all
              integers, not merely searched.
            </p>
          </section>
        )}

        {res && cross.kind !== 'skip' && (
          <div className={`lia-cross lia-cross-${cross.kind}`}>
            {cross.kind === 'confirm' || cross.kind === 'consistent' || cross.kind === 'outside'
              ? '✓ '
              : '⚠ '}
            {cross.text}
          </div>
        )}
        {res && cross.kind === 'skip' && cross.text && <div className="lia-cross lia-cross-note">{cross.text}</div>}

        {res && res.trace.length > 0 && (
          <section className="view lia-trace">
            <button className="lia-trace-toggle" onClick={() => setShowTrace((s) => !s)}>
              {showTrace ? '▾' : '▸'} Elimination trace — {res.trace.length} step
              {res.trace.length === 1 ? '' : 's'} · {res.nodes} node{res.nodes === 1 ? '' : 's'}
            </button>
            {showTrace && (
              <pre className="lia-trace-body">
                {res.trace.join('\n')}
              </pre>
            )}
          </section>
        )}
      </main>
    </div>
  )
}

function sup(n: number): string {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴' }
  return String(n)
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
}
