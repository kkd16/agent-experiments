import { useMemo, useState } from 'react'
import { runPipeline } from '../../lang/pipeline.ts'
import { unparse } from '../../lang/unparse.ts'
import { valueToString } from '../../lang/values.ts'

interface Props {
  /** the current editor source */
  code: string
}

// A friendly one-line description for each named rewrite rule.
const PASS_LABELS: Record<string, string> = {
  'const-fold': 'constant folding (literal arithmetic / comparison / string)',
  algebra: 'algebraic identities (x+0, x*1, x++[], true && x, …)',
  'if-fold': 'branch elimination (if on a known condition / equal arms)',
  beta: 'β-reduction ((fn x -> b) a ⇒ let x = a in b)',
  'beta-float': 'let-floating through application (curried β)',
  eta: 'η-contraction (fn x -> f x ⇒ f)',
  inline: 'inlining a single-use value binding',
  'copy-prop': 'copy propagation (let x = y)',
  'dead-let': 'dead binding elimination (pure, unused let)',
  'dead-let-seq': 'unused effect kept as a sequence',
  'dead-letrec': 'dead letrec binding elimination',
  'known-match': 'known-constructor match reduction',
  'field-proj': 'record field projection ({ a = e, … }.a ⇒ e)',
  'seq-clean': 'sequence cleanup (pure ; rest ⇒ rest)',
}

interface Measured {
  ok: boolean
  offSteps: number
  onSteps: number
  result: string | null
  identical: boolean
}

export default function OptimizerPanel({ code }: Props) {
  const [showBefore, setShowBefore] = useState(false)
  const [measured, setMeasured] = useState<Measured | null>(null)

  // Cheap static analysis: elaborate + optimize, no execution.
  const on = useMemo(() => runPipeline(code, { execute: false, optimize: true }), [code])
  const stats = on.optimization

  const measure = (): void => {
    const offRun = runPipeline(code, { execute: true, optimize: false })
    const onRun = runPipeline(code, { execute: true, optimize: true })
    if (offRun.error || onRun.error || !offRun.run || !onRun.run) {
      setMeasured({ ok: false, offSteps: 0, onSteps: 0, result: null, identical: false })
      return
    }
    const offVal = offRun.run.result ? valueToString(offRun.run.result) : '()'
    const onVal = onRun.run.result ? valueToString(onRun.run.result) : '()'
    const sameOut = offRun.run.output.join('\n') === onRun.run.output.join('\n')
    setMeasured({
      ok: true,
      offSteps: offRun.run.steps,
      onSteps: onRun.run.steps,
      result: onVal,
      identical: offVal === onVal && sameOut,
    })
  }

  if (on.error || !stats || !on.optimizedCoreAst || !on.coreAst) {
    return <div className="panel-empty">No optimization — fix the error first.</div>
  }

  const pct = (before: number, after: number): string =>
    before === 0 ? '0%' : `−${Math.round((1 - after / before) * 100)}%`

  const passEntries = Object.entries(stats.passes).sort((a, b) => b[1] - a[1])
  const shownCore = showBefore ? on.coreAst : on.optimizedCoreAst

  return (
    <div className="opt-panel">
      <p className="panel-note">
        The optimizing middle-end rewrites the elaborated <em>core</em> (the dictionary-passed,
        class-free program) into a smaller, faster equivalent that <strong>all three backends</strong>{' '}
        — the bytecode VM, the JavaScript backend and the WebAssembly backend — then compile. Every
        rewrite is semantics-preserving: the equivalence checks re-prove, on every example, that the
        answer never changed.
      </p>

      <div className="opt-stats">
        <div className="opt-stat">
          <div className="opt-stat-val">{stats.total}</div>
          <div className="opt-stat-lbl">rewrites</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-val">{stats.rounds}</div>
          <div className="opt-stat-lbl">fixpoint rounds</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-val">
            {stats.nodesBefore} → {stats.nodesAfter}
          </div>
          <div className="opt-stat-lbl">core nodes ({pct(stats.nodesBefore, stats.nodesAfter)})</div>
        </div>
        <div className="opt-stat">
          <button className="btn" onClick={measure}>
            ▶ Measure VM steps
          </button>
        </div>
      </div>

      {measured &&
        (measured.ok ? (
          <div className="opt-measure">
            <span className={measured.identical ? 'opt-badge ok' : 'opt-badge bad'}>
              {measured.identical ? '✓ identical result' : '✗ result changed!'}
            </span>
            <span className="opt-measure-steps">
              VM steps: <strong>{measured.offSteps}</strong> →{' '}
              <strong>{measured.onSteps}</strong>{' '}
              <span className="opt-pct">({pct(measured.offSteps, measured.onSteps)})</span>
            </span>
            {measured.result !== null && (
              <span className="opt-measure-result">
                = <code>{measured.result}</code>
              </span>
            )}
          </div>
        ) : (
          <div className="opt-measure">
            <span className="opt-badge bad">this program does not run to a value</span>
          </div>
        ))}

      {passEntries.length > 0 ? (
        <div className="opt-passes">
          <h4>Rewrites by rule</h4>
          <table className="opt-table">
            <tbody>
              {passEntries.map(([name, count]) => (
                <tr key={name}>
                  <td className="opt-pass-count">{count}×</td>
                  <td className="opt-pass-name">
                    <code>{name}</code>
                  </td>
                  <td className="opt-pass-desc">{PASS_LABELS[name] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="panel-note">
          Nothing to optimize here — this program is already in its simplest form.
        </p>
      )}

      <div className="opt-core">
        <div className="opt-core-head">
          <h4>{showBefore ? 'Elaborated core (before)' : 'Optimized core (after)'}</h4>
          <button className="btn small" onClick={() => setShowBefore((b) => !b)}>
            show {showBefore ? 'after' : 'before'}
          </button>
        </div>
        <pre className="opt-core-src">
          <code>{unparse(shownCore)}</code>
        </pre>
      </div>
    </div>
  )
}
