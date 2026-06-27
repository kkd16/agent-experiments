import { useEffect, useMemo, useState } from 'react'
import { parseCtl } from '../engine/ctl/parser'
import type { Ctl } from '../engine/ctl/formula'
import { showCtl, nnf, toAdequate, atomsOf, opLabel, childrenOf } from '../engine/ctl/formula'
import { totalize, labelModel, modelCheckCtl } from '../engine/ctl/modelcheck'
import type { CtlModel, SubLabel } from '../engine/ctl/modelcheck'
import { certify } from '../engine/ctl/witness'
import type { LinearCert } from '../engine/ctl/witness'
import { runSelfTest } from '../engine/ctl/selftest'
import { parseKripke, kripkeToGraph, showProps } from '../engine/ltl/kripke'
import { CTL_EXAMPLES, FORMULA_GALLERY } from '../engine/ctl/examples'
import Graph from '../components/Graph'
import { Stat } from '../components/Stat'
import './LogicView.css'
import './BranchingView.css'

export type BranchingTab = 'formula' | 'label' | 'check' | 'verify' | 'about'

const TABS: { id: BranchingTab; label: string }[] = [
  { id: 'formula', label: 'Formula' },
  { id: 'label', label: 'Labelling' },
  { id: 'check', label: 'Model-check' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

interface Props {
  formula: string
  onFormula: (s: string) => void
  model: string
  onModel: (s: string) => void
  tab: BranchingTab
  onTab: (t: BranchingTab) => void
}

export default function BranchingView({ formula, onFormula, model, onModel, tab, onTab }: Props) {
  const pf = useMemo(() => parseCtl(formula), [formula])
  const ast = pf.ok ? pf.formula : null
  const pm = useMemo(() => parseKripke(model), [model])
  const cm = useMemo(() => (pm.model ? totalize(pm.model) : null), [pm])
  const lab = useMemo(() => (ast && cm ? labelModel(ast, cm) : null), [ast, cm])
  const mc = useMemo(() => (ast && pm.model ? modelCheckCtl(ast, pm.model) : null), [ast, pm])
  const cert = useMemo(() => (ast && pm.model ? certify(ast, pm.model) : null), [ast, pm])

  const loadExample = (i: number) => {
    onFormula(CTL_EXAMPLES[i].formula)
    onModel(CTL_EXAMPLES[i].model)
  }

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
          ) : !ast ? (
            <div className="empty">
              <div className="parse-error">
                <div className="err-msg">{pf.ok ? 'enter a formula' : `column ${pf.pos + 1}: ${pf.message}`}</div>
              </div>
            </div>
          ) : tab === 'formula' ? (
            <FormulaTab ast={ast} />
          ) : tab === 'label' ? (
            <LabelTab pm={pm} cm={cm} lab={lab} />
          ) : (
            <CheckTab ast={ast} pm={pm} mc={mc} cert={cert} cm={cm} />
          )}
        </div>
      </main>

      <aside className="rail">
        <section className="panel">
          <h2>CTL formula</h2>
          <p className="panel-sub">
            Path quantifiers <code>E</code> (some path) / <code>A</code> (all paths), each followed by a
            temporal operator: <code>EX</code> <code>AF</code> <code>EG</code> … or a bracketed{' '}
            <code>E[p U q]</code>, <code>A[p R q]</code>. Propositions are lower-case.
          </p>
          <input
            className="sim-input logic-formula"
            value={formula}
            spellCheck={false}
            onChange={(e) => onFormula(e.target.value)}
            placeholder="AG EF restart"
            aria-label="CTL formula"
          />
          {!pf.ok ? (
            <div className="warn small">
              column {pf.pos + 1}: {pf.message}
            </div>
          ) : (
            <div className="logic-rendered" title="the formula, normalised">
              {showCtl(ast!)}
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
            <option value="">load a model-checking problem ▾</option>
            {CTL_EXAMPLES.map((ex, i) => (
              <option key={i} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
          {mc && (
            <div className={`mc-pill ${mc.holds ? 'yes' : 'no'}`}>
              {mc.holds ? '✓ model satisfies φ' : '✗ counterexample found'}
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formula tab — syntax tree, NNF, and the adequate-basis rewrite.
// ---------------------------------------------------------------------------

function FormulaTab({ ast }: { ast: Ctl }) {
  const negForm = useMemo(() => nnf(ast), [ast])
  const adequate = useMemo(() => toAdequate(ast), [ast])
  const atoms = atomsOf(ast)
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Syntax tree</h3>
      <p className="note">
        A CTL formula reasons about the <em>tree</em> of futures: every temporal operator is paired with
        a path quantifier, <code>E</code> (“along some path”) or <code>A</code> (“along all paths”). That
        pairing is what separates branching time from the linear time of the Logic mode.
      </p>
      <div className="ltl-tree">
        <CtlNode node={ast} />
      </div>

      <h3 className="sec-h">Negation normal form</h3>
      <p className="note">
        Pushing <code>¬</code> down to the propositions uses the CTL dualities — <code>¬EX = AX¬</code>,{' '}
        <code>¬EG = AF¬</code>, <code>¬E[a U b] = A[¬a R ¬b]</code> — so a quantifier never sits under a
        negation. This is the form the witness engine consumes.
      </p>
      <div className="nnf-row">
        <span className="nnf-label">φ</span>
        <code className="nnf-formula">{showCtl(ast)}</code>
      </div>
      <div className="nnf-row">
        <span className="nnf-label">nnf</span>
        <code className="nnf-formula">{showCtl(negForm)}</code>
      </div>

      <h3 className="sec-h">Adequate basis {'{¬, ∧, EX, E[·U·], EG}'}</h3>
      <p className="note">
        Every CTL operator reduces to just five primitives — the basis the labelling algorithm is built
        on. <code>AX = ¬EX¬</code>, <code>EF = E[⊤ U ·]</code>, <code>AG = ¬E[⊤ U ¬·]</code>,{' '}
        <code>AF = ¬EG¬</code>, and <code>A[a U b] = ¬(E[¬b U (¬a∧¬b)] ∨ EG¬b)</code>. The checker
        evaluates each operator directly with its own fixpoint, but they all rest on these five:
      </p>
      <div className="nnf-row">
        <span className="nnf-label">φ</span>
        <code className="nnf-formula">{showCtl(adequate)}</code>
      </div>

      <p className="note">
        Atomic propositions: {atoms.length ? atoms.map((a) => <code key={a}>{a}</code>) : <i>none</i>}
      </p>
    </div>
  )
}

function CtlNode({ node }: { node: Ctl }) {
  const kids = childrenOf(node)
  const head =
    node.k === 'atom' ? (
      <span className="ltl-atom">{node.name}</span>
    ) : node.k === 'true' || node.k === 'false' ? (
      <span className="ltl-const">{opLabel(node.k)}</span>
    ) : (
      <span className="ltl-opnode">{opLabel(node.k)}</span>
    )
  return (
    <div className="ltl-node">
      <div className="ltl-head">
        {head}
        {kids.length > 0 && <span className="ltl-sub muted">{showCtl(node)}</span>}
      </div>
      {kids.length > 0 && (
        <div className="ltl-children">
          {kids.map((c, i) => (
            <CtlNode key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Labelling tab — Sat(ψ) on the graph + the fixpoint approximant chain.
// ---------------------------------------------------------------------------

function LabelTab({
  pm,
  cm,
  lab,
}: {
  pm: ReturnType<typeof parseKripke>
  cm: CtlModel | null
  lab: ReturnType<typeof labelModel> | null
}) {
  const graph = useMemo(() => (pm.model ? kripkeToGraph(pm.model) : null), [pm])
  const [selKey, setSelKey] = useState<string | null>(null)
  const [round, setRound] = useState<number | null>(null)

  // The selected row defaults to the whole formula (the last sub in post-order).
  const subs = lab?.subs ?? []
  const topKey = subs.length ? subs[subs.length - 1].key : null
  const activeKey = selKey ?? topKey
  const sel = subs.find((s) => s.key === activeKey) ?? null

  // Reset the approximant scrubber when the selection changes.
  const [lastSel, setLastSel] = useState(activeKey)
  if (lastSel !== activeKey) {
    setLastSel(activeKey)
    setRound(null)
  }

  if (!pm.model || !graph || !cm || !lab || !sel) {
    return <div className="empty">define a valid model and formula to see the labelling.</div>
  }

  const highlight =
    sel.approx && round !== null && round < sel.approx.length ? sel.approx[round] : sel.sat

  return (
    <div className="label-wrap">
      <div className="label-graph">
        <Graph
          graph={graph}
          highlight={highlight}
          fitKey={`ctl:${pm.model.states.map((s) => s.name).join()}`}
          exportName="kripke-model"
        />
        <p className="note small">
          Highlighted states are exactly <code>Sat({sel.text})</code> — the states where the selected
          subformula holds.{' '}
          {sel.approx && round !== null ? (
            <>
              Showing approximant <b>Z{round}</b> of the {sel.fixpoint} fixpoint.
            </>
          ) : (
            'Pick a subformula below, then scrub a fixpoint operator to watch it converge.'
          )}
        </p>
        {sel.approx && (
          <ApproxStrip sub={sel} round={round} onRound={setRound} names={cm.names} />
        )}
      </div>

      <div className="label-side">
        <h3 className="sec-h">Subformulas</h3>
        <p className="note small">
          Computed bottom-up, smallest first — the labelling algorithm. Click one to light up its
          satisfying set on the graph.
        </p>
        <ul className="sub-list">
          {subs.map((s) => (
            <li
              key={s.key}
              className={`sub-row${s.key === activeKey ? ' active' : ''}`}
              onClick={() => setSelKey(s.key)}
            >
              <code className="sub-text">{s.text}</code>
              <span className="sub-meta">
                {s.fixpoint && <span className={`fix-badge ${s.fixpoint}`}>{s.fixpoint === 'least' ? 'μ' : 'ν'}</span>}
                <span className="sub-count">
                  {s.sat.length}/{cm.n}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="sat-states">
          <b>Sat({sel.text})</b> ={' '}
          {sel.sat.length ? sel.sat.map((i) => cm.names[i]).join(', ') : <i>∅</i>}
        </div>
      </div>
    </div>
  )
}

function ApproxStrip({
  sub,
  round,
  onRound,
  names,
}: {
  sub: SubLabel
  round: number | null
  onRound: (r: number | null) => void
  names: string[]
}) {
  const approx = sub.approx!
  return (
    <div className="approx">
      <div className="approx-head">
        <b>{sub.fixpoint === 'least' ? 'μ (least)' : 'ν (greatest)'} fixpoint</b> — {approx.length}{' '}
        approximant{approx.length === 1 ? '' : 's'} to convergence:
      </div>
      <div className="approx-strip">
        <button className={`approx-cell${round === null ? ' cur' : ''}`} onClick={() => onRound(null)}>
          final
        </button>
        {approx.map((z, i) => (
          <button key={i} className={`approx-cell${round === i ? ' cur' : ''}`} onClick={() => onRound(i)} title={z.map((j) => names[j]).join(', ') || '∅'}>
            Z{i}
            <span className="approx-size">{z.length}</span>
          </button>
        ))}
      </div>
      {round !== null && (
        <div className="approx-detail">
          Z{round} = {approx[round].length ? approx[round].map((j) => names[j]).join(', ') : <i>∅</i>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model-check tab — verdict + the witness / counterexample certificate.
// ---------------------------------------------------------------------------

function CheckTab({
  ast,
  pm,
  mc,
  cert,
  cm,
}: {
  ast: Ctl
  pm: ReturnType<typeof parseKripke>
  mc: ReturnType<typeof modelCheckCtl> | null
  cert: LinearCert | null
  cm: CtlModel | null
}) {
  if (!pm.model || !mc || !cm) {
    return <div className="empty">define a valid model on the right to run the check.</div>
  }
  const linear = cert && (cert.states.length > 1 || cert.loopStart !== null)
  return (
    <div className="pad-scroll check-wrap">
      <div className={`mc-banner ${mc.holds ? 'yes' : 'no'}`}>
        {mc.holds ? (
          <>
            <span className="mc-icon">✓</span> The model satisfies <code>{showCtl(ast)}</code> — every
            initial state is labelled φ.
          </>
        ) : (
          <>
            <span className="mc-icon">✗</span> The model <b>violates</b> <code>{showCtl(ast)}</code> — here
            is a counterexample.
          </>
        )}
      </div>

      <div className="init-verdicts">
        {mc.labelling.initialVerdict.map((v) => (
          <span key={v.state} className={`verdict-chip ${v.holds ? 'yes' : 'no'}`}>
            {cm.names[v.state]} {v.holds ? '⊨' : '⊭'} φ
          </span>
        ))}
      </div>

      {cert && linear ? (
        <CertView cert={cert} model={cm} />
      ) : (
        <p className="note">
          {mc.holds
            ? 'The property holds; because it is a universal (“for all paths”) property, its witness is the whole tree of behaviours rather than a single path — explore the Labelling tab to see exactly which states carry each subformula.'
            : 'No single-path certificate was produced for this formula.'}
        </p>
      )}

      <h3 className="sec-h">How the check ran</h3>
      <ol className="mc-steps">
        <li>
          For each subformula of φ, compute <b>Sat</b> — the set of states where it holds — bottom-up,
          smallest first. The model has <b>{cm.n}</b> state{cm.n === 1 ? '' : 's'}.
        </li>
        <li>
          The temporal operators are <b>fixpoints</b> of a pre-image step:{' '}
          <code>E[·U·]</code>/<code>EF</code>/<code>AF</code>/<code>A[·U·]</code> are <i>least</i>{' '}
          fixpoints, <code>EG</code>/<code>AG</code>/<code>E[·R·]</code>/<code>A[·R·]</code> are{' '}
          <i>greatest</i> — watch them converge in the Labelling tab.
        </li>
        <li>
          φ <b>holds</b> exactly when every <i>initial</i> state lands in <code>Sat(φ)</code>.{' '}
          {mc.holds ? 'It does here.' : 'Some initial state does not — the certificate above replays why.'}
        </li>
      </ol>
      <p className="note small">
        This is the labelling algorithm of Clarke, Emerson &amp; Sistla — branching-time model checking
        by explicit µ-calculus fixpoints, the method inside symbolic model checkers like NuSMV.
      </p>
    </div>
  )
}

/** The certificate as a playable path/lasso, each state annotated with the obligations it discharges. */
function CertView({ cert, model }: { cert: LinearCert; model: CtlModel }) {
  const seq = cert.states
  const loopStart = cert.loopStart
  const [cur, setCur] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!playing) return
    const id = window.setTimeout(() => {
      setCur((x) => {
        const n = x + 1
        if (n < seq.length) return n
        return loopStart !== null ? loopStart : x
      })
    }, 750)
    return () => window.clearTimeout(id)
  }, [playing, cur, seq.length, loopStart])

  const key = seq.join(',') + '|' + loopStart
  const [lastKey, setLastKey] = useState(key)
  if (lastKey !== key) {
    setLastKey(key)
    setCur(0)
    setPlaying(false)
  }

  return (
    <div className="cert">
      <div className={`cert-kind ${cert.kind}`}>
        {cert.kind === 'witness' ? 'witness for' : 'counterexample — a behaviour satisfying'}{' '}
        <code>{cert.goalText}</code>
      </div>
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
                {cert.obligations[i] && cert.obligations[i].length > 0 && (
                  <div className="cert-oblig">
                    {cert.obligations[i].map((o, k) => (
                      <code key={k}>{o}</code>
                    ))}
                  </div>
                )}
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
        <button
          onClick={() => {
            setPlaying(false)
            setCur(0)
          }}
          title="reset"
        >
          ⏮
        </button>
        <button className="play" onClick={() => setPlaying((p) => !p)} title="play/pause">
          {playing ? '⏸' : '▶'}
        </button>
        <button
          onClick={() => {
            setPlaying(false)
            setCur((x) => (x + 1 < seq.length ? x + 1 : loopStart !== null ? loopStart : x))
          }}
          title="step"
        >
          ▶
        </button>
        <span className="step-count">
          t{cur}
          {loopStart !== null ? (cur < loopStart ? ' · stem' : ' · loop') : ''}
        </span>
      </div>
      <p className="note small">
        Each cell is a state of the model; the chips under it are the subformulas that must hold there
        (all independently verified). Consecutive cells are real transitions
        {loopStart !== null ? '; the boxed tail repeats forever.' : '.'}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Verify tab — the live self-test report.
// ---------------------------------------------------------------------------

function VerifyTab() {
  const report = useMemo(() => runSelfTest(), [])
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Verification suite</h3>
      <p className="note">
        The fixpoint checker is cross-checked against a <b>second, independent</b> engine — one that
        decides the temporal operators by explicit backward-BFS and Tarjan <b>SCC</b> analysis instead
        of symbolic pre-image fixpoints — across hundreds of random (model, formula) pairs. Plus the
        adequate-basis rewrite, the textbook fixpoint identities, certificate soundness, and agreement
        with the v8 LTL semantics on linear models. All of it runs live, in your browser, right now.
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
// About tab — branching vs linear time.
// ---------------------------------------------------------------------------

function AboutTab() {
  return (
    <div className="pad-scroll about">
      <h3 className="sec-h">Branching time: the other half of temporal logic</h3>
      <p className="note">
        The Logic mode checks <b>Linear</b> Temporal Logic: a formula constrains a single infinite path,
        and <code>M ⊨ φ</code> means <em>every</em> behaviour satisfies it. CTL — <b>Computation Tree
        Logic</b> — instead reasons about the <em>tree</em> of futures branching out of each state. Every
        temporal operator carries a path quantifier:
      </p>
      <table className="ctl-square">
        <thead>
          <tr>
            <th></th>
            <th>X · next</th>
            <th>F · eventually</th>
            <th>G · always</th>
            <th>U · until</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>E · some path</th>
            <td>EX</td>
            <td>EF</td>
            <td>EG</td>
            <td>E[·U·]</td>
          </tr>
          <tr>
            <th>A · all paths</th>
            <td>AX</td>
            <td>AF</td>
            <td>AG</td>
            <td>A[·U·]</td>
          </tr>
        </tbody>
      </table>
      <h3 className="sec-h">Why it needs its own mode</h3>
      <ul className="about-list">
        <li>
          <b>It is genuinely more, and less, expressive than LTL.</b> <code>AG EF restart</code> (“from
          every reachable state the system can be reset”) has <em>no</em> LTL equivalent — LTL cannot
          quantify “some future” mid-formula. Conversely <code>FG p</code> (“every path eventually
          stabilises on p”) has no CTL equivalent. The two logics are <b>incomparable</b>; CTL\* is the
          superlogic that contains both.
        </li>
        <li>
          <b>It is checked by a different algorithm.</b> Not the automata-theoretic product of the Logic
          mode, but the <i>labelling algorithm</i>: compute <code>Sat(ψ)</code> for each subformula
          bottom-up, the temporal operators as least/greatest <b>fixpoints</b> of a pre-image step. The
          Labelling tab animates those fixpoints converging.
        </li>
        <li>
          <b>Counterexamples differ too.</b> A violated safety property yields a finite path to the bad
          state; a violated liveness one yields a lasso that avoids the goal forever. The witness engine
          builds them as real, replayable behaviours whose every claim is independently verified.
        </li>
      </ul>
      <h3 className="sec-h">The hierarchy, completed</h3>
      <p className="note">
        With the Logic mode (linear time) and this one (branching time) the lab now spans both readings
        of “temporal”. Everything here is hand-written: the parser, the labelling fixpoints, the
        independent SCC/reachability oracle, the witness certificates, and the differential self-test
        that proves the whole chain in the Verify tab.
      </p>
    </div>
  )
}
