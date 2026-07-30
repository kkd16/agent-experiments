import { useMemo, useState } from 'react'
import { runPipeline } from '../../lang/pipeline.ts'
import { valueToString } from '../../lang/values.ts'

interface Props {
  /** the current editor source */
  code: string
}

interface Measured {
  ok: boolean
  offSteps: number
  onSteps: number
  result: string | null
  identical: boolean
}

const STATUS_LABEL: Record<string, string> = {
  used: 'used — may reach the result or an effect',
  absent: 'absent — proven irrelevant (retained: its argument has an effect)',
  dropped: 'absent — dropped, from the function and every call site',
}

/**
 * The Demand panel (Aether 31.0). Runs the backward relevance/absence analysis
 * (`demand.ts`) via the optimizer and renders each mutually-recursive group's
 * per-parameter signature — Used / Absent / Dropped — plus a live before/after
 * VM-step measurement proving the dropped work was pure dead weight.
 */
export default function DemandPanel({ code }: Props) {
  const [measured, setMeasured] = useState<Measured | null>(null)

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

  if (on.error || !stats) {
    return <div className="panel-empty">No analysis — fix the error first.</div>
  }

  const sigs = stats.demandSigs
  const droppedCount = stats.deadParams
    .filter((d) => d.recursive)
    .reduce((n, d) => n + d.dropped.length, 0)

  return (
    <div className="opt-panel">
      <p className="panel-note">
        A backward <strong>demand&nbsp;/&nbsp;absence analysis</strong> (Mycroft 1980; the heart of
        GHC's demand analyser), from scratch. For every <code>let rec … and …</code> group it proves,
        per parameter, whether the value is <em>Used</em> — it may reach the program's result or an
        observable effect — or provably <em>Absent</em>. In a strict language every reachable argument
        is evaluated, so the actionable signal is absence: a parameter that never reaches the answer is
        dead work, and its per-iteration computation is deleted (dead-argument elimination, Aether
        31.0). The engine is a <em>greatest fixpoint</em>: it starts by assuming every parameter absent,
        then demotes any it finds needed — which is what lets it see an accumulator threaded through a{' '}
        <em>mutual</em> loop (each function feeds the other's dead slot) that no single-function
        reasoning can catch.
      </p>

      <div className="opt-stats">
        <div className="opt-stat">
          <div className="opt-stat-val">{sigs.length}</div>
          <div className="opt-stat-lbl">functions analysed</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-val">
            {sigs.reduce((n, s) => n + s.params.filter((p) => p.status !== 'used').length, 0)}
          </div>
          <div className="opt-stat-lbl">absent parameters</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-val">{droppedCount}</div>
          <div className="opt-stat-lbl">dropped</div>
        </div>
        <div className="opt-stat">
          <button className="btn" onClick={measure}>
            measure ≡ / steps
          </button>
        </div>
      </div>

      {measured && (
        <div className="opt-measure">
          {measured.ok ? (
            <>
              <span className={measured.identical ? 'opt-badge ok' : 'opt-badge bad'}>
                {measured.identical ? '✓ identical result & output' : '✗ diverged'}
              </span>
              <span className="opt-measure-steps">
                VM steps <strong>{measured.offSteps}</strong> →{' '}
                <strong>{measured.onSteps}</strong>
                {measured.offSteps > 0 && (
                  <span className="opt-pct">
                    {' '}
                    (−{Math.round((1 - measured.onSteps / measured.offSteps) * 100)}%)
                  </span>
                )}
              </span>
              {measured.result !== null && (
                <span className="opt-measure-result">
                  {' '}
                  = <code>{measured.result}</code>
                </span>
              )}
            </>
          ) : (
            <span className="opt-badge bad">could not run — check the program</span>
          )}
        </div>
      )}

      {sigs.length === 0 ? (
        <p className="panel-note">
          No mutually-recursive function group in scope. Absence analysis runs on{' '}
          <code>let rec f = … and g = …</code> groups; try the{' '}
          <strong>“dead accumulator (mutual recursion)”</strong> example.
        </p>
      ) : (
        <div className="opt-passes">
          <h4>Relevance signatures</h4>
          <div className="demand-sigs">
            {sigs.map((s) => (
              <div className="demand-fn" key={s.fn}>
                <div className="demand-fn-head">
                  <code className="demand-fn-name">{s.fn}</code>
                  <span className="demand-fn-sep">::</span>
                  <span className="demand-fn-params">
                    {s.params.map((p, i) => (
                      <span key={p.name}>
                        {i > 0 ? ' → ' : ''}
                        <span
                          className={`demand-chip demand-${p.status}`}
                          title={STATUS_LABEL[p.status]}
                        >
                          {p.name}
                        </span>
                      </span>
                    ))}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="demand-legend">
            <span className="demand-chip demand-used">used</span>
            <span className="demand-chip demand-absent">absent</span>
            <span className="demand-chip demand-dropped">dropped</span>
          </div>
          <p className="panel-note" style={{ marginBottom: 0 }}>
            A parameter is dropped only when it is proven Absent, every argument ever passed there is
            pure (so no effect is lost), a syntactic strip-and-check confirms its binder can go with no
            free variable left behind, and at least one parameter is retained. Dropping pure dead work
            can only lower the VM step count — re-proven by the standing VM ≡ JS ≡ WASM equivalence
            checks. Use <strong>measure</strong> above to see the answer stay byte-for-byte identical
            while the steps fall.
          </p>
        </div>
      )}
    </div>
  )
}
