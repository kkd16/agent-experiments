import { useMemo, useState } from 'react'
import { runPipeline } from '../../lang/pipeline.ts'
import { unparse } from '../../lang/unparse.ts'
import { valueToString } from '../../lang/values.ts'
import type { DtView, DtViewNode } from '../../lang/decisiontree.ts'

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
  'inline-fn': 'call-site inlining (copy a small non-recursive function into each saturated call)',
  'copy-prop': 'copy propagation (let x = y)',
  'dead-let': 'dead binding elimination (pure, unused let)',
  'dead-let-seq': 'unused effect kept as a sequence',
  'dead-letrec': 'dead letrec binding elimination',
  'known-match': 'known-constructor match reduction',
  'field-proj': 'record field projection ({ a = e, … }.a ⇒ e)',
  'seq-clean': 'sequence cleanup (pure ; rest ⇒ rest)',
  cse: 'common-subexpression elimination (compute repeated work once)',
  gvn: 'global value numbering (share work across `let` / `λ` / `match` binders)',
  dt: 'pattern matching compiled to a decision tree (test each position once)',
  sat: 'static-argument transformation (lift a loop-invariant argument into a wrapper)',
  specconstr:
    'call-pattern specialisation / SpecConstr (recurse on a tuple/constructor argument’s fields so the per-iteration box + match vanish)',
  'float-in': 'float-in (sink a pure binding past a conditional into the one branch that uses it)',
  'dead-param': 'dead-argument elimination (drop a parameter whose value never reaches the result)',
  eqsat: 'equality saturation (e-graph superoptimiser over integer-arithmetic islands)',
  fuse: 'short-cut fusion (delete the intermediate list flowing between two combinators)',
}

// A friendly description for each fusion law, keyed by `consumer/producer`.
const FUSION_LABELS: Record<string, string> = {
  'map/map': 'map f (map g xs) ⇒ map (f ∘ g) xs — one pass, no list in between',
  'filter/filter': 'filter p (filter q xs) ⇒ filter (q ⋀ p) xs',
  'foldr/map': 'foldr k z (map g xs) ⇒ foldr (k ∘ g) z xs',
  'foldl/map': 'foldl k z (map g xs) ⇒ foldl (k ∘ g) z xs',
  'foldr/filter': 'foldr k z (filter p xs) ⇒ foldr (guard p k) z xs',
  'foldl/filter': 'foldl k z (filter p xs) ⇒ foldl (guard p k) z xs',
  'sum/map': 'sum (map g xs) ⇒ foldl (+∘g) 0 xs — never builds the mapped list',
  'sum/filter': 'sum (filter p xs) ⇒ foldl (if p then +) 0 xs',
  'all/map': 'all p (map g xs) ⇒ all (p ∘ g) xs',
  'any/map': 'any p (map g xs) ⇒ any (p ∘ g) xs',
  'length/map': 'length (map g xs) ⇒ length xs — the whole map is dead',
  'length/reverse': 'length (reverse xs) ⇒ length xs',
  'reverse/reverse': 'reverse (reverse xs) ⇒ xs — two traversals vanish',
  'take/map': 'take n (map g xs) ⇒ map g (take n xs) — map only n elements',
}

/** Render one decision-tree node as an indented tree. */
function TreeNode({ node }: { node: DtViewNode }) {
  if (node.t === 'fail') return <div className="dt-leaf dt-fail">MATCH_FAIL</div>
  if (node.t === 'leaf') {
    return (
      <div className="dt-leaf">
        → arm #{node.row + 1}
        {node.guard && <span className="dt-guard"> (when …)</span>}
        {node.binds.length > 0 && (
          <span className="dt-binds">
            {' '}
            {node.binds.map(([n, o]) => `${n}=${o}`).join(', ')}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="dt-switch">
      <div className="dt-test">
        {node.tests ? 'switch' : 'destructure'} <code>{node.occ}</code>
      </div>
      <div className="dt-arms">
        {node.arms.map((a, i) => (
          <div className="dt-arm" key={i}>
            <span className="dt-arm-label">
              <code>{a.label}</code>
              {a.sub.length > 0 && <span className="dt-sub"> → {a.sub.join(', ')}</span>}
            </span>
            <TreeNode node={a.child} />
          </div>
        ))}
        {node.fallback && (
          <div className="dt-arm">
            <span className="dt-arm-label">
              <code>_</code>
            </span>
            <TreeNode node={node.fallback} />
          </div>
        )}
      </div>
    </div>
  )
}

function DecisionTrees({ trees }: { trees: DtView[] }) {
  return (
    <div className="opt-passes">
      <h4>Decision trees (Aether 12.0)</h4>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Each <code>match</code> below was compiled to a <strong>good decision tree</strong> (Maranget,
        2008): instead of re-testing a shared constructor prefix once per arm, the tree tests each
        scrutinee position <em>once</em> and branches. It lowers to ordinary core, so all three
        backends run it unchanged — the equivalence checks still hold.
      </p>
      {trees.map((t, i) => (
        <div className="dt-tree" key={i}>
          <div className="dt-tree-head">
            match #{i + 1} — {t.arms} arm{t.arms === 1 ? '' : 's'}, pattern tests{' '}
            <strong>{t.naiveTests}</strong> (naive) → <strong>{t.treeTests}</strong> (tree)
            {t.naiveTests > t.treeTests && (
              <span className="opt-pct"> (−{t.naiveTests - t.treeTests})</span>
            )}
          </div>
          <div className="dt-root">
            <TreeNode node={t.root} />
          </div>
        </div>
      ))}
    </div>
  )
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

      {stats.fusions.length > 0 && (
        <div className="opt-passes">
          <h4>Short-cut fusion (Aether 18.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Every other pass simplifies code; this one deletes <em>data</em>. A pipeline like{' '}
            <code>sum (map f (filter p xs))</code> naively builds a throwaway list at each arrow, only
            to walk it once and discard it. <strong>Deforestation</strong> (Wadler 1990; Gill,
            Launchbury &amp; Peyton Jones 1993) rewrites a consumer applied to a producer into a single
            pass that never materialises the list in between. Each law fires only when the function
            whose call-timing it changes is proven <strong>pure &amp; total</strong>, so no effect is
            reordered and no exception hoisted — the equivalence checks re-prove it, and the VM step
            count only falls:
          </p>
          <table className="opt-table">
            <tbody>
              {stats.fusions.map((f, i) => (
                <tr key={i}>
                  <td className="opt-pass-count">{f.count}×</td>
                  <td className="opt-pass-name">
                    <code>{f.rule}</code>
                  </td>
                  <td className="opt-pass-desc">{FUSION_LABELS[f.rule] ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.trace.length > 1 && (
        <div className="opt-passes">
          <h4>Fixpoint trace</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            The optimizer re-runs to a fixpoint; each round can expose new rewrites for the next
            (a CSE uncovers a dead binding, an inline uncovers a fold, …). Watch the core melt:
          </p>
          <table className="opt-table">
            <tbody>
              <tr>
                <td className="opt-pass-count">start</td>
                <td className="opt-pass-name" />
                <td className="opt-pass-desc">{stats.nodesBefore} core nodes</td>
              </tr>
              {stats.trace.map((t) => (
                <tr key={t.round}>
                  <td className="opt-pass-count">round {t.round}</td>
                  <td className="opt-pass-name">
                    <code>{t.rewrites}×</code>
                  </td>
                  <td className="opt-pass-desc">
                    {t.nodes} core nodes{' '}
                    <span className="opt-pct">({pct(stats.nodesBefore, t.nodes)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.gvnHoists.length > 0 && (
        <div className="opt-passes">
          <h4>Global value numbering (Aether 14.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Where the local CSE only shares work among a single node's binder-free strict frontier,
            this top-down pass shares a pure, costly expression recomputed <em>across</em> binders —
            on either side of a <code>let</code>, inside a <code>λ</code> body, or across a{' '}
            <code>match</code> — hoisting it into one shared <code>let</code> at the dominating node.
            It only fires when the expression is guaranteed-evaluated more than once, so the VM step
            count can only fall:
          </p>
          <table className="opt-table">
            <tbody>
              {stats.gvnHoists.map((h, i) => (
                <tr key={i}>
                  <td className="opt-pass-count">{h.sites}×</td>
                  <td className="opt-pass-desc">
                    shared <code>{h.expr}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.inlinedFns.length > 0 && (
        <div className="opt-passes">
          <h4>Call-site inlining (Aether 15.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Where the single-use inliner only copies a function used exactly once, this pass copies a
            small, non-recursive function into <em>every saturated call site</em> — deleting the
            closure-application the site paid and exposing its body to const-folding — while any
            partial application or higher-order <em>escape</em> keeps a single shared closure. An
            inlined call is cheaper than a real one and an un-taken copy costs nothing at runtime, so
            the VM step count can only fall:
          </p>
          <table className="opt-table">
            <tbody>
              {stats.inlinedFns.map((f, i) => (
                <tr key={i}>
                  <td className="opt-pass-count">{f.sites}×</td>
                  <td className="opt-pass-name">
                    <code>{f.name}</code>
                  </td>
                  <td className="opt-pass-desc">
                    {f.size}-node body{f.escaped ? ', escape closure kept' : ', fully inlined'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.satTransforms.length > 0 && (
        <div className="opt-passes">
          <h4>Static-argument transformation (Aether 17.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            A recursive function often threads an argument round its loop completely{' '}
            <em>unchanged</em> — the function argument of a recursive <code>map</code>, the limit of a
            counting loop. This pass (Santos 1995; Peyton Jones &amp; Santos 1998) splits it into a
            thin <strong>wrapper</strong> that binds the static arguments once and a recursive{' '}
            <strong>worker</strong> that loops on only the <em>dynamic</em> ones, capturing the static
            ones as free variables — so each iteration passes one fewer argument. Because the wrapper
            is no longer recursive, a <em>known</em> function flowing into a lifted slot is then
            inlined and β-reduced into the loop — a SpecConstr-like specialisation:
          </p>
          <table className="opt-table">
            <tbody>
              {stats.satTransforms.map((s, i) => (
                <tr key={i}>
                  <td className="opt-pass-count">{s.calls}×</td>
                  <td className="opt-pass-name">
                    <code>{s.name}</code>
                  </td>
                  <td className="opt-pass-desc">
                    lifted{' '}
                    {s.static.map((p, j) => (
                      <span key={p}>
                        {j > 0 ? ', ' : ''}
                        <code>{p}</code>
                      </span>
                    ))}{' '}
                    out of the loop; worker recurses on{' '}
                    {s.dynamic.map((p, j) => (
                      <span key={p}>
                        {j > 0 ? ', ' : ''}
                        <code>{p}</code>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.specConstrs.length > 0 && (
        <div className="opt-passes">
          <h4>Call-pattern specialisation — SpecConstr (Aether 23.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            The other half of GHC&rsquo;s loop-specialisation toolkit (Peyton Jones,{' '}
            <em>Call-pattern specialisation</em>, ICFP 2007). Where the 17.0 transform lifts a
            loop-<em>invariant</em> argument out, this attacks a loop-<em>varying</em> one that is rebuilt
            as the <em>same</em> tuple/constructor shape every iteration only to be torn straight back
            apart by the function&rsquo;s own <code>match</code> — pure box-then-project churn. SpecConstr{' '}
            <strong>recurses on the shape&rsquo;s fields directly</strong>, reconstructing the whole value
            only where it is genuinely used (single-use, so the inliner copies it onto the{' '}
            <code>match</code> and the 11.0 known-constructor rule deletes the cell <em>and</em> the test):
          </p>
          <table className="opt-table">
            <tbody>
              {stats.specConstrs.map((s, i) => (
                <tr key={i}>
                  <td className="opt-pass-count">{s.calls}×</td>
                  <td className="opt-pass-name">
                    <code>{s.name}</code>
                  </td>
                  <td className="opt-pass-desc">
                    specialised on <code>{s.param}</code> <code>{s.shape}</code> — recurses on its{' '}
                    {s.arity} unpacked field{s.arity === 1 ? '' : 's'}; no per-iteration box or{' '}
                    <code>match</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.floatIns.length > 0 && (
        <div className="opt-passes">
          <h4>Float-in (Aether 19.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            The <em>dual</em> of global value numbering. GVN floats a pure expression <em>up</em> to
            share it across guaranteed evaluations; float-in (Peyton Jones, Partain &amp; Santos,{' '}
            <em>Let-floating</em>, ICFP 1996) sinks a pure, non-trivial binding <em>down</em> — past a
            conditional, into the one branch that uses it — so the branches that don&apos;t take it
            skip the work entirely. Only pure (effect-free, terminating) bindings move, never inside a{' '}
            <code>λ</code> (which would recompute), so a strict program&apos;s VM step count can only
            fall:
          </p>
          <table className="opt-table">
            <tbody>
              {stats.floatIns.map((f, i) => (
                <tr key={i}>
                  <td className="opt-pass-name">
                    <code>{f.name}</code>
                  </td>
                  <td className="opt-pass-desc">
                    <code>{f.value}</code> sunk into a <code>{f.into}</code> branch
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.deadParams.length > 0 && (
        <div className="opt-passes">
          <h4>Dead-argument elimination (Aether 20.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            A parameter whose value can never reach the result is dropped from the function and from
            every saturated call site — both an <em>unused</em> parameter and a <em>useless
            accumulator</em> that only ever feeds its own recursive slot (its per-iteration update runs
            for nothing). Fires only when every dropped argument is pure, so no effect is lost and the VM
            step count can only fall:
          </p>
          <table className="opt-table">
            <tbody>
              {stats.deadParams.map((d, i) => (
                <tr key={i}>
                  <td className="opt-pass-name">
                    <code>{d.name}</code>
                  </td>
                  <td className="opt-pass-desc">
                    dropped{' '}
                    {d.dropped.map((p, j) => (
                      <span key={p}>
                        {j > 0 ? ', ' : ''}
                        <code>{p}</code>
                      </span>
                    ))}{' '}
                    {d.recursive ? '(a dead loop argument)' : '(an unused parameter)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.commutes.length > 0 && (
        <div className="opt-passes">
          <h4>Case-of-case — commuting conversions (Aether 21.0)</h4>
          <p className="panel-note" style={{ marginTop: 0 }}>
            A strict eliminator (a <code>match</code> scrutinee, a <code>.field</code> projection, a{' '}
            <code>binop</code>/<code>unop</code> operand) sitting on an <code>if</code>/<code>match</code>{' '}
            <em>producer</em> is pushed inward into the producer's branches, so each branch meets the
            eliminator <em>statically</em> — the intermediate constructor, record or boxed value is never
            built. It fires only when a branch is thereby <em>exposed to a redex</em>, so a known-match,
            field-projection or fold always follows and the VM step count can only fall
            (Peyton&nbsp;Jones &amp; Santos 1998):
          </p>
          <table className="opt-table">
            <tbody>
              {stats.commutes.map((c, i) => (
                <tr key={i}>
                  <td className="opt-pass-name">
                    <code>{c.frame}</code>
                  </td>
                  <td className="opt-pass-desc">
                    pushed into a <code>{c.producer}</code> ({c.branches} branch
                    {c.branches === 1 ? '' : 'es'}, {c.exposed} exposed a redex)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {stats.decisionTrees.length > 0 && <DecisionTrees trees={stats.decisionTrees} />}

      {stats.pureFns.length > 0 && (
        <p className="panel-note">
          <strong>Effect-&amp;-totality analysis</strong> — proved these functions effect-free and
          total (recursive ones via <strong>size-change termination</strong> — see the Termination
          tab), so common-subexpression elimination may share a repeated call and dead-code
          elimination may drop an unused one:{' '}
          {stats.pureFns.map((f, i) => (
            <span key={f}>
              {i > 0 ? ', ' : ''}
              <code>{f}</code>
            </span>
          ))}
          .
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
