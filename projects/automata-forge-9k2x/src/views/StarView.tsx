import { useEffect, useMemo, useState } from 'react'
import { parseStar } from '../engine/star/parser'
import type { Star } from '../engine/star/formula'
import { showStar, atomsOf, opLabel, childrenOf, classify } from '../engine/star/formula'
import { modelCheckStar, checkWellFormed } from '../engine/star/modelcheck'
import type { StarResult, StarStep } from '../engine/star/modelcheck'
import { runSelfTest } from '../engine/star/selftest'
import { STAR_EXAMPLES, FORMULA_GALLERY } from '../engine/star/examples'
import { parseKripke, kripkeToGraph, showProps } from '../engine/ltl/kripke'
import { totalize } from '../engine/ctl/modelcheck'
import type { CtlModel } from '../engine/ctl/modelcheck'
import Graph from '../components/Graph'
import { Stat } from '../components/Stat'
import './LogicView.css'
import './BranchingView.css'
import './StarView.css'

export type StarTab = 'formula' | 'decompose' | 'check' | 'verify' | 'about'

const TABS: { id: StarTab; label: string }[] = [
  { id: 'formula', label: 'Formula' },
  { id: 'decompose', label: 'Decompose' },
  { id: 'check', label: 'Model-check' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

const FRAGMENT_LABEL: Record<ReturnType<typeof classify>, string> = {
  ltl: 'linear (LTL under one quantifier)',
  ctl: 'CTL fragment',
  star: 'proper CTL*',
}

interface Props {
  formula: string
  onFormula: (s: string) => void
  model: string
  onModel: (s: string) => void
  tab: StarTab
  onTab: (t: StarTab) => void
}

export default function StarView({ formula, onFormula, model, onModel, tab, onTab }: Props) {
  const pf = useMemo(() => parseStar(formula), [formula])
  const ast = pf.ok ? pf.formula : null
  const wf = useMemo(() => (ast ? checkWellFormed(ast) : null), [ast])
  const ok = ast && wf?.ok ? ast : null
  const pm = useMemo(() => parseKripke(model), [model])
  const cm = useMemo(() => (pm.model ? totalize(pm.model) : null), [pm])
  const res = useMemo(() => (ok && pm.model ? modelCheckStar(ok, pm.model) : null), [ok, pm])

  const loadExample = (i: number) => {
    onFormula(STAR_EXAMPLES[i].formula)
    onModel(STAR_EXAMPLES[i].model)
  }

  const formulaError = !pf.ok
    ? `column ${pf.pos + 1}: ${pf.message}`
    : ast && wf && !wf.ok
      ? wf.message
      : null

  return (
    <div className="workspace logic-ws">
      <main className="viewer">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="canvas">
          {tab === 'about' ? (
            <AboutTab />
          ) : tab === 'verify' ? (
            <VerifyTab />
          ) : !ok ? (
            <div className="empty">
              <div className="parse-error">
                <div className="err-msg">{formulaError ?? 'enter a formula'}</div>
              </div>
            </div>
          ) : tab === 'formula' ? (
            <FormulaTab ast={ok} />
          ) : tab === 'decompose' ? (
            <DecomposeTab res={res} cm={cm} pm={pm} />
          ) : (
            <CheckTab ast={ok} res={res} cm={cm} pm={pm} />
          )}
        </div>
      </main>

      <aside className="rail">
        <section className="panel">
          <h2>CTL* formula</h2>
          <p className="panel-sub">
            Path quantifiers <code>E</code> (some path) / <code>A</code> (all paths) bind a whole{' '}
            <em>path formula</em> in which the temporal operators nest freely:{' '}
            <code>E[G F p]</code>, <code>A[F G p]</code>, <code>EF AG p</code>. Propositions are
            lower-case.
          </p>
          <input
            className="sim-input logic-formula"
            value={formula}
            spellCheck={false}
            onChange={(e) => onFormula(e.target.value)}
            placeholder="E[G F p]"
            aria-label="CTL* formula"
          />
          {formulaError ? (
            <div className="warn small">{formulaError}</div>
          ) : (
            <div className="logic-rendered" title="the formula, normalised">
              {showStar(ok!)}
              <span className={`frag-badge frag-${classify(ok!)}`}>{FRAGMENT_LABEL[classify(ok!)]}</span>
            </div>
          )}
          <div className="formula-gallery">
            {FORMULA_GALLERY.map((g) => (
              <button key={g.name} className="chip" title={g.formula} onClick={() => onFormula(g.formula)}>
                {g.name}
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Kripke model</h2>
          <p className="panel-sub">
            One state per line: <code>name {'{ props }'} -&gt; succ…</code>. <code>init:</code> sets the
            start state(s); <code>#</code> or <code>//</code> starts a comment.
          </p>
          <textarea
            className="tm-input logic-model"
            value={model}
            spellCheck={false}
            onChange={(e) => onModel(e.target.value)}
            rows={8}
            aria-label="Kripke model source"
          />
          {pm.errors.length > 0 && (
            <div className="warn small">
              {pm.errors.slice(0, 4).map((e, i) => (
                <div key={i}>
                  {e.line ? `line ${e.line}: ` : ''}
                  {e.message}
                </div>
              ))}
            </div>
          )}
          {cm && cm.addedSelfLoops.length > 0 && (
            <div className="note small">
              deadlock state(s) self-looped for the total-relation convention:{' '}
              {cm.addedSelfLoops.map((i) => cm.names[i]).join(', ')}.
            </div>
          )}
          {pm.model && (
            <div className="statline">
              <Stat k="S" v={pm.model.states.length} title="states" />
              <Stat k="→" v={pm.model.edges.reduce((a, e) => a + e.length, 0)} title="transitions" />
              <Stat k="AP" v={pm.model.atoms.length} title="atomic propositions" />
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Examples</h2>
          <select
            className="examples"
            value=""
            onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
            aria-label="load an example"
          >
            <option value="">load a CTL* problem ▾</option>
            {STAR_EXAMPLES.map((ex, i) => (
              <option key={i} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
          {res && (
            <div className={`mc-pill ${res.holds ? 'yes' : 'no'}`}>
              {res.holds ? '✓ model satisfies φ' : '✗ counterexample found'}
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formula tab — syntax tree + which logic the formula lives in.
// ---------------------------------------------------------------------------

function FormulaTab({ ast }: { ast: Star }) {
  const frag = classify(ast)
  const atoms = atomsOf(ast)
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Syntax tree</h3>
      <p className="note">
        CTL* drops CTL’s rule that a quantifier must hug a single temporal operator: an{' '}
        <code>E</code>/<code>A</code> binds a whole <em>path formula</em>, so temporal operators and
        booleans nest under it freely. That single relaxation is what makes CTL* strictly contain both
        CTL and LTL.
      </p>
      <div className="ltl-tree">
        <StarNode node={ast} />
      </div>

      <h3 className="sec-h">Which logic is this?</h3>
      <div className={`frag-card frag-${frag}`}>
        <div className="frag-title">{FRAGMENT_LABEL[frag]}</div>
        <p className="note small">
          {frag === 'ctl'
            ? 'Every quantifier here immediately wraps one temporal operator, so this is a CTL formula — the Branching mode could check it too. CTL* checks it by the same Emerson–Lei reduction, which collapses to the CTL labelling on this fragment (the Verify tab proves the agreement over hundreds of random formulas).'
            : frag === 'ltl'
              ? 'A single outer quantifier over a quantifier-free path formula: pure linear-time, wearing one E/A. A φ over an LTL body is the universal model-checking question of the Logic mode; E φ is its dual.'
              : 'A temporal operator is nested under a quantifier in a way CTL cannot flatten (e.g. E[G F p], A[F G p]) — a property expressible in neither CTL nor LTL on its own. This is exactly the case the Emerson–Lei algorithm is for.'}
        </p>
      </div>

      <h3 className="sec-h">How it reads</h3>
      <div className="nnf-row">
        <span className="nnf-label">φ</span>
        <code className="nnf-formula">{showStar(ast)}</code>
      </div>
      <p className="note small">
        Atomic propositions: {atoms.length ? atoms.map((a) => <code key={a}>{a}</code>) : <i>none</i>}
      </p>
    </div>
  )
}

function StarNode({ node }: { node: Star }) {
  const kids = childrenOf(node)
  const head =
    node.k === 'atom' ? (
      <span className="ltl-atom">{node.name}</span>
    ) : node.k === 'true' || node.k === 'false' ? (
      <span className="ltl-const">{opLabel(node.k)}</span>
    ) : (
      <span className={`ltl-opnode${node.k === 'E' || node.k === 'A' ? ' star-quant' : ''}`}>
        {opLabel(node.k)}
      </span>
    )
  return (
    <div className="ltl-node">
      <div className="ltl-head">
        {head}
        {kids.length > 0 && <span className="ltl-sub muted">{showStar(node)}</span>}
      </div>
      {kids.length > 0 && (
        <div className="ltl-children">
          {kids.map((c, i) => (
            <StarNode key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Decompose tab — the Emerson–Lei elimination, round by round.
// ---------------------------------------------------------------------------

function DecomposeTab({
  res,
  cm,
  pm,
}: {
  res: StarResult | null
  cm: CtlModel | null
  pm: ReturnType<typeof parseKripke>
}) {
  const graph = useMemo(() => (pm.model ? kripkeToGraph(pm.model) : null), [pm])
  const [sel, setSel] = useState<number | null>(null)
  if (!res || !cm || !graph || !pm.model) {
    return <div className="empty">define a valid model and formula to see the decomposition.</div>
  }
  if (res.steps.length === 0) {
    return (
      <div className="pad-scroll">
        <p className="note">
          This formula has no path quantifier, so there is nothing to eliminate — it is a Boolean
          combination of atoms, evaluated directly. Add an <code>E</code> or <code>A</code> to watch the
          Emerson–Lei reduction work.
        </p>
      </div>
    )
  }
  const active = sel ?? res.steps.length - 1
  const step = res.steps[active]
  return (
    <div className="label-wrap">
      <div className="label-graph">
        <Graph
          graph={graph}
          highlight={step.sat}
          fitKey={`star:${pm.model.states.map((s) => s.name).join()}`}
          exportName="kripke-model"
        />
        <p className="note small">
          Highlighted: <code>Sat({step.label} ≡ {step.quant === 'E' ? 'E' : 'A'} {step.pathText})</code>{' '}
          — the {step.sat.length} state{step.sat.length === 1 ? '' : 's'} where this quantifier round
          holds.
        </p>
        {step.witnesses.length > 0 && (
          <WitnessStrip step={step} model={cm} />
        )}
      </div>

      <div className="label-side">
        <h3 className="sec-h">Elimination rounds</h3>
        <p className="note small">
          Innermost quantifier first. Each round decides <code>E ρ</code> (some path satisfies the LTL
          body ρ — one Büchi-emptiness check per state) or <code>A ρ = ¬E¬ρ</code>, then names the
          result with a fresh proposition <code>χ</code> and substitutes it upward.
        </p>
        <ul className="sub-list">
          {res.steps.map((s, i) => (
            <li key={i} className={`sub-row${i === active ? ' active' : ''}`} onClick={() => setSel(i)}>
              <code className="sub-text">
                {s.label} ≡ {s.quant} {s.pathText}
              </code>
              <span className="sub-meta">
                <span className={`fix-badge ${s.quant === 'E' ? 'least' : 'greatest'}`}>{s.quant}</span>
                <span className="sub-count">
                  {s.sat.length}/{model_n(cm)}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="sat-states">
          <b>χ-substitutions</b>
          <div className="chi-list">
            {res.steps.map((s, i) => (
              <div key={i} className="chi-row">
                <code className="chi-name">{s.label}</code>
                <span className="chi-eq">≡</span>
                <code className="chi-src">{s.sourceText}</code>
              </div>
            ))}
          </div>
          <div className="resid-row">
            <b>residual</b> <code>{showStar(res.residual)}</code> over atoms + χ
          </div>
        </div>
      </div>
    </div>
  )
}

function model_n(cm: CtlModel): number {
  return cm.n
}

/** A replayable witnessing / refuting lasso for the selected elimination round. */
function WitnessStrip({ step, model }: { step: StarStep; model: CtlModel }) {
  const [wIdx, setWIdx] = useState(0)
  const idx = Math.min(wIdx, Math.max(0, step.witnesses.length - 1))
  const w = step.witnesses[idx]
  const [cur, setCur] = useState(0)
  const [playing, setPlaying] = useState(false)

  const seq = w ? [...w.lasso.prefix, ...w.lasso.loop] : []
  const loopStart = w && w.lasso.loop.length > 0 ? w.lasso.prefix.length : null

  useEffect(() => {
    if (!playing || seq.length === 0) return
    const id = window.setTimeout(() => {
      setCur((x) => {
        const n = x + 1
        if (n < seq.length) return n
        return loopStart !== null ? loopStart : x
      })
    }, 700)
    return () => window.clearTimeout(id)
  }, [playing, cur, seq.length, loopStart])

  const key = `${step.label}:${idx}`
  const [lastKey, setLastKey] = useState(key)
  if (lastKey !== key) {
    setLastKey(key)
    setCur(0)
    setPlaying(false)
  }
  if (!w) return null

  return (
    <div className="cert">
      <div className={`cert-kind ${w.kind === 'sat' ? 'witness' : 'counterexample'}`}>
        {w.kind === 'sat' ? 'a path from' : 'a refuting path from'} <b>{model.names[w.state]}</b>{' '}
        {w.kind === 'sat' ? 'satisfying' : 'violating, i.e. satisfying ¬of,'} <code>{step.pathText}</code>
      </div>
      {step.witnesses.length > 1 && (
        <div className="witness-picker">
          start state:
          {step.witnesses.map((ww, i) => (
            <button
              key={i}
              className={`chip${i === idx ? ' active' : ''}`}
              onClick={() => {
                setWIdx(i)
                setCur(0)
                setPlaying(false)
              }}
            >
              {model.names[ww.state]}
            </button>
          ))}
        </div>
      )}
      <div className="lasso-strip cert-strip">
        {seq.map((sid, i) => {
          const inLoop = loopStart !== null && i >= loopStart
          return (
            <div key={i} className="lasso-cellwrap">
              {loopStart !== null && i === loopStart && (
                <span className="lasso-loopstart" title="start of the repeated loop">
                  ↻
                </span>
              )}
              <div
                className={`lasso-cell cert-cell${i === cur ? ' cur' : ''}${inLoop ? ' loop' : ''}`}
                onClick={() => {
                  setPlaying(false)
                  setCur(i)
                }}
              >
                <div className="lasso-name">{model.names[sid]}</div>
                <div className="lasso-props">{showProps(model.props[sid])}</div>
                <div className="lasso-step">t{i}</div>
              </div>
            </div>
          )
        })}
        {loopStart !== null && (
          <span className="lasso-ellipsis" title="the loop repeats forever">
            ⟳ …
          </span>
        )}
      </div>
      <div className="sim-controls">
        <button onClick={() => { setPlaying(false); setCur(0) }} title="reset">⏮</button>
        <button className="play" onClick={() => setPlaying((p) => !p)} title="play/pause">
          {playing ? '⏸' : '▶'}
        </button>
        <button
          onClick={() => { setPlaying(false); setCur((x) => (x + 1 < seq.length ? x + 1 : loopStart ?? x)) }}
          title="step"
        >
          ▶
        </button>
        <span className="step-count">
          t{cur}
          {loopStart !== null ? (cur < loopStart ? ' · stem' : ' · loop') : ''}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model-check tab — verdict + the decomposition certificate.
// ---------------------------------------------------------------------------

function CheckTab({
  ast,
  res,
  cm,
  pm,
}: {
  ast: Star
  res: StarResult | null
  cm: CtlModel | null
  pm: ReturnType<typeof parseKripke>
}) {
  if (!res || !cm || !pm.model) {
    return <div className="empty">define a valid model on the right to run the check.</div>
  }
  return (
    <div className="pad-scroll check-wrap">
      <div className={`mc-banner ${res.holds ? 'yes' : 'no'}`}>
        {res.holds ? (
          <>
            <span className="mc-icon">✓</span> The model satisfies <code>{showStar(ast)}</code> — every
            initial state is labelled φ.
          </>
        ) : (
          <>
            <span className="mc-icon">✗</span> The model <b>violates</b> <code>{showStar(ast)}</code> —
            some initial state fails it.
          </>
        )}
      </div>

      <div className="init-verdicts">
        {res.initialVerdict.map((v) => (
          <span key={v.state} className={`verdict-chip ${v.holds ? 'yes' : 'no'}`}>
            {cm.names[v.state]} {v.holds ? '⊨' : '⊭'} φ
          </span>
        ))}
      </div>

      <h3 className="sec-h">Reduced to {res.steps.length} quantifier round{res.steps.length === 1 ? '' : 's'}</h3>
      <p className="note">
        Emerson–Lei strips the innermost path quantifier first, decides it by an LTL emptiness check at
        every state (the Logic mode’s Büchi machinery), records the result as a fresh proposition{' '}
        <code>χ</code>, and substitutes upward until a Boolean residual remains. The{' '}
        <b>Decompose</b> tab animates each round and replays a witnessing path; the residual evaluates
        to <code>Sat(φ)</code>.
      </p>
      <div className="resid-row big">
        <b>residual</b> <code>{showStar(res.residual)}</code> — true at{' '}
        {res.sat.length ? res.sat.map((i) => cm.names[i]).join(', ') : <i>no state</i>}
      </div>
      <ol className="mc-steps">
        {res.steps.map((s, i) => (
          <li key={i}>
            <code>{s.label} ≡ {s.sourceText}</code> holds at{' '}
            <b>{s.sat.length}</b>/{cm.n} state{cm.n === 1 ? '' : 's'} — decided by a per-state{' '}
            <code>{s.quant === 'E' ? 'E' : 'A = ¬E¬'}</code> emptiness check on the body{' '}
            <code>{s.pathText}</code>.
          </li>
        ))}
      </ol>
      <p className="note small">
        This is the Emerson–Lei CTL* algorithm — branching-time labelling on the outside, the
        automata-theoretic LTL check on the inside, glued by fresh-atom introduction. It is the method
        NuSMV and SPIN-family tools use to lift model checking from CTL/LTL to full CTL*.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Verify tab.
// ---------------------------------------------------------------------------

function VerifyTab() {
  const report = useMemo(() => runSelfTest(), [])
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Verification suite</h3>
      <p className="note">
        The CTL* checker is cross-examined by engines that share <b>no code</b> with it. On the CTL
        fragment it must match the Branching mode’s <b>symbolic-fixpoint</b> labelling engine, state for
        state; on full CTL* with genuine nesting it must match an <b>independent Tarjan-SCC</b>
        path-existence oracle; on the linear fragment it must match the Logic mode’s <b>direct ω-word
        semantics</b>. Plus the <code>A ρ = ¬E¬ρ</code> duality, certificate soundness (every witness
        lasso is a real path that replays under the direct semantics), and the gallery verdicts. All of
        it runs live, in your browser, right now.
      </p>
      <div className={`verify-summary ${report.ok ? 'ok' : 'bad'}`}>
        {report.passed} / {report.total} checks passed
      </div>
      <ul className="verify-list">
        {report.results.map((r, i) => (
          <li key={i} className={r.pass ? 'pass' : 'fail'}>
            <span className="verify-mark">{r.pass ? '✓' : '✗'}</span>
            <span className="verify-name">{r.name}</span>
            <span className="verify-detail muted">{r.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// About tab.
// ---------------------------------------------------------------------------

function AboutTab() {
  return (
    <div className="pad-scroll about">
      <h3 className="sec-h">CTL*: the temporal logic that contains the other two</h3>
      <p className="note">
        The Logic mode checks <b>LTL</b> (one path at a time) and the Branching mode checks <b>CTL</b>{' '}
        (each temporal operator wrapped in a path quantifier). Each can say something the other cannot —
        and <b>CTL*</b> is the logic that drops the wall between them: a quantifier <code>E</code>/
        <code>A</code> binds an arbitrary path formula, so the linear operators nest under the branching
        ones with no restriction.
      </p>
      <table className="ctl-square">
        <thead>
          <tr>
            <th></th>
            <th>expressible in…</th>
            <th>not in…</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>F G p</code></td>
            <td>LTL, CTL*</td>
            <td>CTL</td>
          </tr>
          <tr>
            <td><code>A[F G p]</code>, <code>E[G F p]</code></td>
            <td>CTL*</td>
            <td>CTL <i>and</i> LTL</td>
          </tr>
          <tr>
            <td><code>A G E F reset</code></td>
            <td>CTL, CTL*</td>
            <td>LTL</td>
          </tr>
        </tbody>
      </table>

      <h3 className="sec-h">How CTL* is checked — Emerson–Lei</h3>
      <ul className="about-list">
        <li>
          <b>Peel the innermost quantifier.</b> Find a subformula <code>Q ρ</code> whose body ρ has no
          quantifier left inside it — so ρ is a pure LTL path formula over atoms (and the labels earlier
          rounds introduced).
        </li>
        <li>
          <b>Decide it as LTL, per state.</b> <code>E ρ</code> at a state asks “does <i>some</i> path
          from here satisfy ρ?” — one Büchi-automaton emptiness check (the Logic mode’s GPVW product),
          run with the start state pinned to each state in turn. <code>A ρ = ¬E¬ρ</code> is its dual.
        </li>
        <li>
          <b>Name it and climb.</b> Introduce a fresh proposition <code>χ</code> true exactly where{' '}
          <code>Q ρ</code> holds, replace the subformula by χ, and repeat. When the last quantifier is
          gone the residual is propositional — evaluate it state by state to get <code>Sat(φ)</code>.
        </li>
      </ul>
      <p className="note">
        So CTL* model checking is literally the lab’s two temporal engines working together: CTL-style{' '}
        <i>labelling</i> on the outside, LTL-style <i>automata</i> on the inside, glued by atom
        introduction. Everything here is hand-written — the parser, the elimination driver, the
        per-state Büchi emptiness, the independent SCC oracle, the witness certificates, and the
        differential self-test that proves the whole chain in the Verify tab.
      </p>
      <h3 className="sec-h">The hierarchy, completed</h3>
      <p className="note">
        Explore (regular) · Grammar (context-free) · Machine (Turing) · Parse (LL/LR) · Learn (L*) ·
        Logic (LTL) · Branching (CTL) — and now the temporal capstone that subsumes the last two.
      </p>
    </div>
  )
}
