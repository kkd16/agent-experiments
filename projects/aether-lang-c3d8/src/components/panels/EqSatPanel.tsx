import { useMemo, useState } from 'react'
import { runPipeline } from '../../lang/pipeline.ts'
import { valueToString } from '../../lang/values.ts'
import type { EClassView, EqSatRewrite } from '../../lang/egraph.ts'

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

/** One e-class rendered as a box holding all its (equivalent) e-nodes. */
function ClassBox({ c }: { c: EClassView }) {
  const cls = ['eg-class']
  if (c.root) cls.push('eg-root')
  if (c.extracted) cls.push('eg-extracted')
  return (
    <div className={cls.join(' ')}>
      <div className="eg-class-id">
        c{c.id}
        {c.root && <span className="eg-tag">root</span>}
      </div>
      <div className="eg-nodes">
        {c.nodes.map((n, i) => (
          <span className="eg-node" key={i}>
            <span className="eg-op">{n.label}</span>
            {n.children.length > 0 && (
              <span className="eg-children">
                {n.children.map((ch, j) => (
                  <span className="eg-ref" key={j}>
                    c{ch}
                  </span>
                ))}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

function RewriteCard({ r }: { r: EqSatRewrite }) {
  return (
    <div className="eg-rewrite">
      <div className="eg-rw-head">
        <code className="eg-before">{r.before}</code>
        <span className="eg-arrow">⟶</span>
        <code className="eg-after">{r.after}</code>
      </div>
      <div className="eg-rw-stats">
        <span className={r.validated ? 'opt-badge ok' : 'opt-badge bad'}>
          {r.validated ? `✓ validated · ${r.trials + 6} points` : '✗ not validated'}
        </span>
        <span className="eg-chip">
          cost <strong>{r.costBefore}</strong> → <strong>{r.costAfter}</strong>
        </span>
        <span className="eg-chip">
          {r.leaves} {r.leaves === 1 ? 'variable' : 'variables'}
        </span>
        <span className="eg-chip">
          {r.classes} e-classes · {r.enodes} e-nodes
        </span>
        <span className="eg-chip">
          {r.iters} {r.iters === 1 ? 'iteration' : 'iterations'}
          {r.saturated ? ' · saturated' : ' · budget'}
        </span>
      </div>
      <details className="eg-graph-details">
        <summary>
          show the saturated e-graph ({r.graph.length}
          {r.graph.length >= 60 ? '+' : ''} classes)
        </summary>
        <p className="panel-note" style={{ marginTop: 8 }}>
          Each box is an <strong>e-class</strong> — a set of subterms proven equal. The chips inside
          are its <strong>e-nodes</strong> (operators whose children are <em>other</em> e-classes,
          shown as <code>c·</code> references), so one box can hold many equivalent forms at once.
          Boxes on the cheapest extracted program are highlighted; the{' '}
          <span className="eg-swatch eg-root" /> box is the island's root.
        </p>
        <div className="eg-graph">
          {r.graph.map((c) => (
            <ClassBox c={c} key={c.id} />
          ))}
        </div>
      </details>
    </div>
  )
}

export default function EqSatPanel({ code }: Props) {
  const [measured, setMeasured] = useState<Measured | null>(null)

  const on = useMemo(() => runPipeline(code, { execute: false, optimize: true }), [code])
  const eqsat = on.optimization?.eqsat ?? null

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

  if (on.error || !eqsat) {
    return <div className="panel-empty">No analysis — fix the error first.</div>
  }

  const pct = (before: number, after: number): string =>
    before === 0 ? '0%' : `−${Math.round((1 - after / before) * 100)}%`

  return (
    <div className="opt-panel eg-panel">
      <p className="panel-note">
        <strong>Equality saturation</strong> (Aether 16.0) is a non-destructive superoptimizer. Where
        the greedy middle-end commits to one rewrite per node — and so can pick a first move it can
        never undo — this pass grows an <strong>e-graph</strong>: it applies <em>every</em> algebraic
        law (commutativity, associativity, factoring, identities, cancellation) at once, recording all
        equivalent forms in shared equivalence classes, until the graph <em>saturates</em>. Then a
        single cost-driven <strong>extraction</strong> pulls out the cheapest program in the whole
        class. It runs on the <strong>integer-arithmetic islands</strong> the type system guarantees
        are pure polynomials over their leaves.
      </p>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Soundness is not taken on faith: every adopted rewrite is <strong>differentially validated</strong>{' '}
        by polynomial identity testing (Schwartz–Zippel) — original and candidate are evaluated on
        dozens of random integer assignments, and a single disagreement vetoes the rewrite, certifying
        a genuine <strong>integer identity</strong>. Aether's <code>Int</code> is exact within ±2<sup>53</sup>,
        so within that range (every realistic program) the answer is bit-for-bit unchanged — the same
        overflow-free assumption GCC and LLVM make to reassociate integer arithmetic. The cost gate
        only ever adopts a <em>strictly cheaper</em> form, so VM steps can only fall.
      </p>

      <div className="opt-stats">
        <div className="opt-stat">
          <div className="opt-stat-val">{eqsat.islands}</div>
          <div className="opt-stat-lbl">arithmetic islands</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-val">{eqsat.rewrites.length}</div>
          <div className="opt-stat-lbl">islands improved</div>
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
              VM steps: <strong>{measured.offSteps}</strong> → <strong>{measured.onSteps}</strong>{' '}
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

      {eqsat.rewrites.length > 0 ? (
        <div className="opt-passes">
          <h4>Superoptimized islands</h4>
          {eqsat.rewrites.map((r, i) => (
            <RewriteCard r={r} key={i} />
          ))}
        </div>
      ) : (
        <p className="panel-note">
          {eqsat.islands === 0
            ? 'No integer-arithmetic islands in this program yet. Try a function whose body does arithmetic on its parameters — e.g. '
            : 'Found arithmetic, but the greedy passes already left it optimal (or every reassociation cost more). Try a body the greedy pass cannot factor — e.g. '}
          <code>map (fn a -&gt; a*2 + a*3) [1, 2, 3]</code>, which equality saturation rewrites to{' '}
          <code>a * 5</code>.
        </p>
      )}
    </div>
  )
}
