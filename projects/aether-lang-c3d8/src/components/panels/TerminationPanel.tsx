import { useMemo } from 'react'
import { runPipeline } from '../../lang/pipeline.ts'
import type { ScgArc, TermFnView } from '../../lang/termination.ts'

interface Props {
  /** the current editor source */
  code: string
}

/** Render one size-change graph as `param ↓ param` arcs, highlighting a strict
 *  in-situ descent — the well-founded thread that proves the loop terminates. */
function SizeGraph({ arcs }: { arcs: ScgArc[] }) {
  if (arcs.length === 0) {
    return <span className="scg-empty">no size relation — nothing provably shrinks</span>
  }
  return (
    <span className="scg">
      {arcs.map((a, i) => {
        const inSitu = a.from === a.to
        const cls = a.strict ? (inSitu ? 'scg-arc strict insitu' : 'scg-arc strict') : 'scg-arc eq'
        return (
          <span key={i} className={cls}>
            <code>{a.from}</code>
            <span className="scg-rel">{a.strict ? ' ↓ ' : ' ↓= '}</span>
            <code>{a.to}</code>
          </span>
        )
      })}
    </span>
  )
}

function FnCard({ fn }: { fn: TermFnView }) {
  const badge = fn.higherOrder
    ? { cls: 'term-badge ho', text: 'higher-order' }
    : fn.terminates
      ? { cls: 'term-badge ok', text: fn.recursive ? '✓ terminates' : '✓ trivially' }
      : { cls: 'term-badge no', text: 'not proven' }
  return (
    <div className={`term-card ${fn.terminates ? 'is-ok' : fn.higherOrder ? 'is-ho' : 'is-no'}`}>
      <div className="term-card-head">
        <code className="term-name">
          {fn.name}
          <span className="term-params"> {fn.params.join(' ')}</span>
        </code>
        <span className={badge.cls}>{badge.text}</span>
      </div>
      <div className="term-reason">{fn.reason}</div>
      {fn.recursive && fn.selfGraphs.length > 0 && (
        <div className="term-scgs">
          {fn.selfGraphs.map((arcs, i) => (
            <div className="term-scg-row" key={i}>
              <span className="term-scg-label">self-call:</span>
              <SizeGraph arcs={arcs} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TerminationPanel({ code }: Props) {
  const analysis = useMemo(() => runPipeline(code, { execute: false, optimize: true }), [code])
  const term = analysis.optimization?.termination ?? null

  if (analysis.error || !term) {
    return <div className="panel-empty">No analysis — fix the error first.</div>
  }

  const proven = term.fns.filter((f) => f.terminates)
  const recursiveProven = proven.filter((f) => f.recursive)
  const unproven = term.fns.filter((f) => !f.terminates)

  // edges grouped by source for a compact call-graph view
  const calls = new Map<string, Set<string>>()
  for (const e of term.callEdges) {
    if (!calls.has(e.from)) calls.set(e.from, new Set())
    calls.get(e.from)!.add(e.to)
  }

  return (
    <div className="term-panel">
      <p className="panel-note">
        <strong>Size-change termination</strong> (Lee–Jones–Ben-Amram, POPL 2001). A program
        terminates when no infinite call sequence is possible — and one is impossible when some value
        from a <em>well-founded</em> order would have to descend forever. Aether's order is the{' '}
        <strong>structural subterm order</strong> on finite data: a piece peeled out of a
        constructor, cons-cell or tuple by a <code>match</code> is <em>strictly smaller</em> (↓) than
        the whole. For every call <code>f → g</code> the analysis builds a <em>size-change graph</em>{' '}
        relating <code>f</code>'s parameters to <code>g</code>'s arguments, closes them under
        composition, and proves the loop terminates when every idempotent self-graph carries a strict
        in-situ arc. This is what lets the optimizer's effect-&amp;-totality analysis admit a{' '}
        <em>recursive</em> function — so CSE may share a repeated call and dead-code elimination may
        drop an unused one.
      </p>

      <div className="opt-stats">
        <div className="opt-stat">
          <div className="opt-stat-val">{term.analyzed}</div>
          <div className="opt-stat-lbl">functions analyzed</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-val">{proven.length}</div>
          <div className="opt-stat-lbl">proven terminating</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-val">{recursiveProven.length}</div>
          <div className="opt-stat-lbl">recursive &amp; proven</div>
        </div>
      </div>

      {term.fns.length === 0 ? (
        <p className="panel-note">No named functions in this program to analyze.</p>
      ) : (
        <>
          {recursiveProven.length > 0 && (
            <div className="term-section">
              <h4>Recursive — proven terminating</h4>
              <p className="panel-note tiny" style={{ marginTop: 0 }}>
                Each descends a strict subterm on every loop (the ↓ thread), so it cannot run forever.
              </p>
              {recursiveProven.map((f) => (
                <FnCard key={f.name} fn={f} />
              ))}
            </div>
          )}

          {proven.some((f) => !f.recursive) && (
            <div className="term-section">
              <h4>Non-recursive — terminate trivially</h4>
              <div className="term-trivial">
                {proven
                  .filter((f) => !f.recursive)
                  .map((f) => (
                    <code key={f.name} className="term-chip ok">
                      {f.name}
                    </code>
                  ))}
              </div>
            </div>
          )}

          {unproven.length > 0 && (
            <div className="term-section">
              <h4>Out of scope / not proven</h4>
              <p className="panel-note tiny" style={{ marginTop: 0 }}>
                Conservative by design: a higher-order function's termination depends on the function
                it is handed at runtime, and an unbounded integer countdown is not well-founded — so
                neither is claimed (an honest "don't know", never a wrong "yes").
              </p>
              {unproven.map((f) => (
                <FnCard key={f.name} fn={f} />
              ))}
            </div>
          )}

          {calls.size > 0 && (
            <div className="term-section">
              <h4>First-order call graph</h4>
              <div className="term-callgraph">
                {[...calls.entries()].map(([from, tos]) => (
                  <div className="term-edge" key={from}>
                    <code>{from}</code>
                    <span className="term-arrow"> → </span>
                    {[...tos].map((t, i) => (
                      <span key={t}>
                        {i > 0 ? ', ' : ''}
                        <code>{t}</code>
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
