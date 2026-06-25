import { useEffect, useMemo, useState } from 'react'
import { parseLtl } from '../engine/ltl/parser'
import type { Ltl } from '../engine/ltl/formula'
import {
  GLYPH,
  showLtl,
  showCore,
  toCore,
  atomsOf,
  untilSubformulas,
} from '../engine/ltl/formula'
import { buildBuchi, modelCheck, acceptsLasso } from '../engine/ltl/modelcheck'
import type { MCResult } from '../engine/ltl/modelcheck'
import { baToGraph, showGuard } from '../engine/ltl/buchi'
import { evalLtlOnLasso } from '../engine/ltl/semantics'
import { parseKripke, kripkeToGraph, showProps } from '../engine/ltl/kripke'
import type { Kripke } from '../engine/ltl/kripke'
import {
  LOGIC_EXAMPLES,
  FORMULA_GALLERY,
} from '../engine/ltl/examples'
import { runSelfTest } from '../engine/ltl/selftest'
import Graph from '../components/Graph'
import { Stat } from '../components/Stat'
import './LogicView.css'

export type LogicTab = 'formula' | 'buchi' | 'kripke' | 'check' | 'verify' | 'about'

const TABS: { id: LogicTab; label: string }[] = [
  { id: 'formula', label: 'Formula' },
  { id: 'buchi', label: 'Büchi' },
  { id: 'kripke', label: 'Model' },
  { id: 'check', label: 'Model-check' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

interface Props {
  formula: string
  onFormula: (s: string) => void
  model: string
  onModel: (s: string) => void
  tab: LogicTab
  onTab: (t: LogicTab) => void
}

export default function LogicView({ formula, onFormula, model, onModel, tab, onTab }: Props) {
  const pf = useMemo(() => parseLtl(formula), [formula])
  const ast = pf.ok ? pf.formula : null
  const phi = useMemo(() => (pf.ok ? buildBuchi(toCore(pf.formula)) : null), [pf])
  const notPhi = useMemo(() => (pf.ok ? buildBuchi(toCore(pf.formula, true)) : null), [pf])
  const pm = useMemo(() => parseKripke(model), [model])
  const mc = useMemo(
    () => (pf.ok && pm.model ? modelCheck(pf.formula, pm.model) : null),
    [pf, pm],
  )

  const loadExample = (i: number) => {
    onFormula(LOGIC_EXAMPLES[i].formula)
    onModel(LOGIC_EXAMPLES[i].model)
  }

  return (
    <div className="workspace logic-ws">
      <main className="viewer">
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => onTab(t.id)}
            >
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
                <div className="err-msg">
                  {pf.ok ? 'enter a formula' : `column ${pf.pos + 1}: ${pf.message}`}
                </div>
              </div>
            </div>
          ) : tab === 'formula' ? (
            <FormulaTab ast={ast} />
          ) : tab === 'buchi' ? (
            <BuchiTab ast={ast} phi={phi!} />
          ) : tab === 'kripke' ? (
            <KripkeTab pm={pm} />
          ) : (
            <CheckTab ast={ast} pm={pm} mc={mc} notPhi={notPhi!} />
          )}
        </div>
      </main>

      <aside className="rail">
        <section className="panel">
          <h2>LTL formula</h2>
          <p className="panel-sub">
            Operators: <code>!</code> <code>&amp;</code> <code>|</code> <code>-&gt;</code>{' '}
            <code>&lt;-&gt;</code>, and temporal <code>X</code> (next) <code>F</code> (eventually){' '}
            <code>G</code> (always) <code>U</code> (until) <code>R</code> (release) <code>W</code>{' '}
            (weak until). Propositions are lower-case names.
          </p>
          <input
            className="sim-input logic-formula"
            value={formula}
            spellCheck={false}
            onChange={(e) => onFormula(e.target.value)}
            placeholder="G (req -> F ack)"
            aria-label="LTL formula"
          />
          {!pf.ok ? (
            <div className="warn small">
              column {pf.pos + 1}: {pf.message}
            </div>
          ) : (
            <div className="logic-rendered" title="the formula, normalised">
              {showLtl(ast!)}
            </div>
          )}
          <div className="formula-gallery">
            {FORMULA_GALLERY.map((g) => (
              <button
                key={g.name}
                className="chip"
                title={g.formula}
                onClick={() => onFormula(g.formula)}
              >
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
          {pm.model && pm.model.deadlocks.length > 0 && (
            <div className="note small">
              deadlock state(s):{' '}
              {pm.model.deadlocks.map((i) => pm.model!.states[i].name).join(', ')} — no infinite path
              runs through them.
            </div>
          )}
          {pm.model && (
            <div className="statline">
              <Stat k="S" v={pm.model.states.length} title="states" />
              <Stat
                k="→"
                v={pm.model.edges.reduce((a, e) => a + e.length, 0)}
                title="transitions"
              />
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
            {LOGIC_EXAMPLES.map((ex, i) => (
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
// Formula tab — the parse tree + the negation-normal form + the closure.
// ---------------------------------------------------------------------------

function FormulaTab({ ast }: { ast: Ltl }) {
  const core = useMemo(() => toCore(ast), [ast])
  const negCore = useMemo(() => toCore(ast, true), [ast])
  const atoms = atomsOf(ast)
  const untils = untilSubformulas(core)
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Syntax tree</h3>
      <p className="note">
        The formula as the parser sees it. Temporal operators (X F G U R W) are what lift this above
        propositional logic — they quantify over the <em>positions</em> of an infinite trace.
      </p>
      <div className="ltl-tree">
        <FormulaNode node={ast} />
      </div>

      <h3 className="sec-h">Negation normal form</h3>
      <p className="note">
        Pushing ¬ down to the propositions (via De Morgan and the temporal dualities{' '}
        <code>¬X = X¬</code>, <code>¬(a U b) = ¬a R ¬b</code>) leaves a formula over only{' '}
        <code>∧ ∨ X U R</code> and literals — the shape the Büchi construction consumes. F and G are
        sugar: <code>F a = ⊤ U a</code>, <code>G a = ⊥ R a</code>.
      </p>
      <div className="nnf-row">
        <span className="nnf-label">φ</span>
        <code className="nnf-formula">{showCore(core)}</code>
      </div>
      <div className="nnf-row">
        <span className="nnf-label">¬φ</span>
        <code className="nnf-formula">{showCore(negCore)}</code>
        <span className="muted small"> — this is what model checking builds an automaton for</span>
      </div>

      <h3 className="sec-h">Eventualities</h3>
      <p className="note">
        Each <code>U</code> subformula of φ becomes one Büchi acceptance set, forcing its “eventually”
        to actually be discharged rather than postponed forever. φ in NNF has{' '}
        <b>{untils.length}</b> such subformula{untils.length === 1 ? '' : 's'}
        {untils.length ? ':' : '.'}
      </p>
      {untils.length > 0 && (
        <ul className="until-list">
          {untils.map((u, i) => (
            <li key={i}>
              <code>{showCore(u)}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="note">
        Atomic propositions: {atoms.length ? atoms.map((a) => <code key={a}>{a}</code>) : <i>none</i>}
      </p>
    </div>
  )
}

/** A node of the LTL syntax tree, rendered as an indented operator tree. */
function FormulaNode({ node }: { node: Ltl }) {
  const opName: Record<Ltl['k'], string> = {
    true: GLYPH.top,
    false: GLYPH.bot,
    atom: '',
    not: `${GLYPH.not} not`,
    and: `${GLYPH.and} and`,
    or: `${GLYPH.or} or`,
    imp: `${GLYPH.imp} implies`,
    iff: `${GLYPH.iff} iff`,
    next: `${GLYPH.next} next`,
    fin: `${GLYPH.fin} eventually`,
    glob: `${GLYPH.glob} always`,
    until: `${GLYPH.until} until`,
    release: `${GLYPH.release} release`,
    wuntil: `${GLYPH.wuntil} weak-until`,
  }
  const children: Ltl[] =
    node.k === 'atom' || node.k === 'true' || node.k === 'false'
      ? []
      : 'b' in node
        ? [node.a, node.b]
        : [node.a]
  const head =
    node.k === 'atom' ? (
      <span className="ltl-atom">{node.name}</span>
    ) : node.k === 'true' || node.k === 'false' ? (
      <span className="ltl-const">{opName[node.k]}</span>
    ) : (
      <span className="ltl-opnode">{opName[node.k]}</span>
    )
  return (
    <div className="ltl-node">
      <div className="ltl-head">
        {head}
        {children.length > 0 && <span className="ltl-sub muted">{showLtl(node)}</span>}
      </div>
      {children.length > 0 && (
        <div className="ltl-children">
          {children.map((c, i) => (
            <FormulaNode key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Büchi tab — the automaton for φ, its state table, and a word tracer.
// ---------------------------------------------------------------------------

function BuchiTab({ ast, phi }: { ast: Ltl; phi: ReturnType<typeof buildBuchi> }) {
  const graph = useMemo(() => baToGraph(phi.ba), [phi])
  const fitKey = useMemo(() => showLtl(ast) + phi.ba.states.length, [ast, phi])
  return (
    <div className="buchi-wrap">
      <div className="statline buchi-stats">
        <Stat k="GBA" v={phi.gba.states.length} title="generalized-Büchi states (GPVW)" />
        <Stat k="acc" v={Math.max(phi.gba.acceptSets.length, 1)} title="acceptance sets" />
        <Stat k="BA" v={phi.ba.states.length} title="states after degeneralization" />
        <Stat k="F" v={phi.ba.accept.size} title="accepting states" />
      </div>
      {phi.overflow ? (
        <div className="warn">formula too large — the automaton was capped. Try a smaller formula.</div>
      ) : phi.ba.states.length === 0 ? (
        <div className="empty">the automaton is empty — φ is unsatisfiable (no trace satisfies it).</div>
      ) : (
        <Graph
          graph={graph}
          fitKey={fitKey}
          exportName="buchi-automaton"
        />
      )}
      <p className="note small buchi-note">
        A Büchi automaton: a run is an <b>infinite</b> path; it is accepting when it passes a{' '}
        <span className="legend-accept">double-ringed</span> state infinitely often. The guard under
        each state (⊤ = unconstrained) is what the letter at that step must satisfy. Several states may
        be initial (each gets a start arrow). This automaton accepts exactly the traces satisfying{' '}
        <code>{showLtl(ast)}</code>.
      </p>
      <WordTracer ast={ast} phi={phi} />
      <StateTable phi={phi} />
    </div>
  )
}

function StateTable({ phi }: { phi: ReturnType<typeof buildBuchi> }) {
  return (
    <details className="state-table">
      <summary>state table ({phi.ba.states.length} states)</summary>
      <table className="tm-trace">
        <thead>
          <tr>
            <th>#</th>
            <th>guard</th>
            <th>accept?</th>
            <th>successors</th>
            <th>obligations (Old set)</th>
          </tr>
        </thead>
        <tbody>
          {phi.ba.states.map((s) => (
            <tr key={s.id}>
              <td className="tm-trace-n">{s.id}</td>
              <td>
                <code>{showGuard(s.label)}</code>
              </td>
              <td>{phi.ba.accept.has(s.id) ? '✓' : ''}</td>
              <td>{s.next.length ? s.next.join(', ') : <span className="muted">—</span>}</td>
              <td className="old-set">{phi.gba.states[s.gba]?.old.join(', ') || '⊤'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

/** Parse an ultimately-periodic word: letters separated by spaces, `;` splits prefix from loop. */
function parseWord(s: string): { prefix: Set<string>[]; loop: Set<string>[] } {
  const parseLetter = (tok: string): Set<string> => {
    let t = tok.trim()
    if (t === '-' || t === '_' || t === '{}' || t === '∅' || t === '') return new Set()
    if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1)
    return new Set(
      t
        .split(/[,&\s]+/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    )
  }
  const parseSeq = (str: string): Set<string>[] =>
    str
      .trim()
      .split(/\s+/)
      .filter((x) => x.length > 0)
      .map(parseLetter)
  const sep = s.search(/[;]/)
  if (sep < 0) return { prefix: [], loop: parseSeq(s) }
  return { prefix: parseSeq(s.slice(0, sep)), loop: parseSeq(s.slice(sep + 1)) }
}

function WordTracer({ ast, phi }: { ast: Ltl; phi: ReturnType<typeof buildBuchi> }) {
  const [word, setWord] = useState('{} ; {p}')
  const parsed = useMemo(() => parseWord(word), [word])
  const valid = parsed.loop.length > 0
  const truth = valid ? evalLtlOnLasso(ast, parsed.prefix, parsed.loop) : null
  const auto = valid ? acceptsLasso(phi.ba, parsed.prefix, parsed.loop) : null
  return (
    <details className="word-tracer" open>
      <summary>trace an ω-word</summary>
      <p className="note small">
        Enter an ultimately-periodic word — a stem, a <code>;</code>, then a forever-repeated loop.
        Each letter is a set of true propositions: <code>{'{p,q}'}</code>, <code>{'{}'}</code> (or{' '}
        <code>-</code>) for none. Example: <code>{'{} ; {p}'}</code> is “¬p once, then p forever”.
      </p>
      <input
        className="sim-input"
        value={word}
        spellCheck={false}
        onChange={(e) => setWord(e.target.value)}
        aria-label="omega word"
      />
      {!valid ? (
        <div className="warn small">the loop (after ;) needs at least one letter</div>
      ) : (
        <div className="trace-verdicts">
          <span className={`verdict-chip ${truth ? 'yes' : 'no'}`}>
            semantics: w {truth ? '⊨' : '⊭'} φ
          </span>
          <span className={`verdict-chip ${auto ? 'yes' : 'no'}`}>
            automaton: {auto ? 'accepts' : 'rejects'}
          </span>
          <span className={`verdict-chip ${truth === auto ? 'agree' : 'no'}`}>
            {truth === auto ? '✓ agree' : '✗ disagree'}
          </span>
        </div>
      )}
    </details>
  )
}

// ---------------------------------------------------------------------------
// Model tab — the Kripke structure as a graph.
// ---------------------------------------------------------------------------

function KripkeTab({ pm }: { pm: ReturnType<typeof parseKripke> }) {
  const graph = useMemo(() => (pm.model ? kripkeToGraph(pm.model) : null), [pm])
  if (!pm.model || !graph) {
    return <div className="empty">define a model on the right to see it here.</div>
  }
  return (
    <div className="kripke-wrap">
      <Graph
        graph={graph}
        fitKey={`kripke:${pm.model.states.map((s) => s.name).join()}`}
        exportName="kripke-model"
      />
      <p className="note small">
        A Kripke structure: nodes are states of the world, each labelled with the propositions true
        there (shown under the node as <code>name ⊨ props</code>); start arrows mark the initial
        state(s). Its behaviours are the infinite paths from an initial state — and each path spells an
        ω-word that the formula judges.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model-check tab — the verdict + the counterexample lasso.
// ---------------------------------------------------------------------------

function CheckTab({
  ast,
  pm,
  mc,
  notPhi,
}: {
  ast: Ltl
  pm: ReturnType<typeof parseKripke>
  mc: MCResult | null
  notPhi: ReturnType<typeof buildBuchi>
}) {
  if (!pm.model) {
    return <div className="empty">define a valid model on the right to run the check.</div>
  }
  if (!mc) return <div className="empty">—</div>
  return (
    <div className="pad-scroll check-wrap">
      <div className={`mc-banner ${mc.holds ? 'yes' : 'no'}`}>
        {mc.holds ? (
          <>
            <span className="mc-icon">✓</span> The model satisfies{' '}
            <code>{showLtl(ast)}</code> — every behaviour does.
          </>
        ) : (
          <>
            <span className="mc-icon">✗</span> The model <b>violates</b> <code>{showLtl(ast)}</code> —
            here is a counterexample.
          </>
        )}
      </div>

      {!mc.holds && mc.counterexample && (
        <Lasso model={pm.model} prefix={mc.counterexample.prefix} loop={mc.counterexample.loop} ast={ast} />
      )}

      <h3 className="sec-h">How the check ran</h3>
      <ol className="mc-steps">
        <li>
          Build a Büchi automaton <b>A(¬φ)</b> accepting exactly the traces that <em>violate</em> φ —{' '}
          <b>{notPhi.ba.states.length}</b> states, <b>{notPhi.ba.accept.size}</b> accepting.
        </li>
        <li>
          Form the product <b>A(¬φ) ⊗ M</b> — the behaviours of the model whose trace A(¬φ) accepts.
          Explored <b>{mc.productStates}</b> product state{mc.productStates === 1 ? '' : 's'}.
        </li>
        <li>
          {mc.holds
            ? 'The product has no accepting run, so no behaviour violates φ — the property holds.'
            : 'An accepting run exists; its projection onto the model is the lasso shown above.'}
        </li>
      </ol>
      <p className="note small">
        This is the automata-theoretic method (Vardi–Wolper): model checking reduces to the{' '}
        <b>emptiness</b> of a Büchi automaton, decided by hunting for a reachable accepting state on a
        cycle.
      </p>
    </div>
  )
}

/** The counterexample lasso: a stem of states leading into a repeated loop, with a playhead. */
function Lasso({
  model,
  prefix,
  loop,
  ast,
}: {
  model: Kripke
  prefix: number[]
  loop: number[]
  ast: Ltl
}) {
  const seq = [...prefix, ...loop]
  const loopStart = prefix.length
  const [cur, setCur] = useState(0)
  const [playing, setPlaying] = useState(false)

  // Advance the playhead; once past the end it wraps back to the start of the loop.
  useEffect(() => {
    if (!playing) return
    const id = window.setTimeout(() => {
      setCur((x) => {
        const n = x + 1
        return n < seq.length ? n : loopStart
      })
    }, 700)
    return () => window.clearTimeout(id)
  }, [playing, cur, seq.length, loopStart])

  // Reset the cursor when the lasso identity changes.
  const key = seq.join(',') + '|' + loopStart
  const [lastKey, setLastKey] = useState(key)
  if (lastKey !== key) {
    setLastKey(key)
    setCur(0)
    setPlaying(false)
  }

  const traceLetters = seq.map((i) => model.states[i].props)
  const truth = evalLtlOnLasso(
    ast,
    prefix.map((i) => model.states[i].props),
    loop.map((i) => model.states[i].props),
  )

  return (
    <div className="lasso">
      <div className="lasso-strip">
        {seq.map((sid, i) => {
          const inLoop = i >= loopStart
          return (
            <div key={i} className="lasso-cellwrap">
              {i === loopStart && <span className="lasso-loopstart" title="start of the repeated loop">↻</span>}
              <div
                className={`lasso-cell${i === cur ? ' cur' : ''}${inLoop ? ' loop' : ''}`}
                onClick={() => {
                  setPlaying(false)
                  setCur(i)
                }}
              >
                <div className="lasso-name">{model.states[sid].name}</div>
                <div className="lasso-props">{showProps(model.states[sid].props)}</div>
                <div className="lasso-step">t{i}</div>
              </div>
            </div>
          )
        })}
        <span className="lasso-ellipsis" title="the loop repeats forever">⟳ …</span>
      </div>

      <div className="sim-controls">
        <button onClick={() => { setPlaying(false); setCur(0) }} title="reset">⏮</button>
        <button
          className="play"
          onClick={() => setPlaying((p) => !p)}
          title="play/pause"
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          onClick={() => { setPlaying(false); setCur((x) => (x + 1 < seq.length ? x + 1 : loopStart)) }}
          title="step"
        >
          ▶
        </button>
        <span className="step-count">
          t{cur} · {cur < loopStart ? 'stem' : 'loop'}
        </span>
      </div>

      <p className="note small">
        The behaviour is the stem then the boxed loop repeated forever — an ω-word that{' '}
        {truth ? 'satisfies ¬φ' : 'should violate φ'} (so it{' '}
        <b>violates the property</b>). Trace:{' '}
        <code>
          {traceLetters
            .slice(0, loopStart)
            .map((l) => `{${showProps(l)}}`)
            .join(' ')}
          {prefix.length ? ' ' : ''}(
          {loop.map((i) => `{${showProps(model.states[i].props)}}`).join(' ')})
          <sup>ω</sup>
        </code>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Verify tab — the self-test report.
// ---------------------------------------------------------------------------

function VerifyTab() {
  const report = useMemo(() => runSelfTest(), [])
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Verification suite</h3>
      <p className="note">
        The GPVW translation is checked against an <b>independent</b> oracle — the direct LTL semantics
        over lasso words — across hundreds of random formula/word pairs, plus the complementation
        invariant, degeneralization, and the full model checker (gallery verdicts + replayed
        counterexamples). All of it runs live, in your browser, right now.
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
// About tab — where this mode sits.
// ---------------------------------------------------------------------------

function AboutTab() {
  return (
    <div className="pad-scroll about">
      <h3 className="sec-h">Beyond finite words: ω-automata &amp; temporal logic</h3>
      <p className="note">
        Every other mode in this lab is about <b>finite</b> strings — does this word, which ends,
        belong to the language? Reactive systems (an OS, a protocol, a controller) never end, so their
        correctness is a property of <b>infinite</b> traces: “the lock is never held by two processes”,
        “every request is eventually granted”, “the system is infinitely often ready”. These are{' '}
        <b>Linear Temporal Logic</b> (LTL) properties, and the machine that recognises an infinite-word
        language is a <b>Büchi automaton</b> — an NFA whose run is infinite and which accepts by
        visiting an accepting state infinitely often.
      </p>
      <h3 className="sec-h">The pipeline</h3>
      <ul className="about-list">
        <li>
          <b>Formula → automaton.</b> The <i>GPVW tableau</i> (Gerth–Peled–Vardi–Wolper 1995) turns an
          LTL formula into a generalized Büchi automaton by repeatedly unrolling{' '}
          <code>a U b ≡ b ∨ (a ∧ X(a U b))</code> and <code>a R b ≡ b ∧ (a ∨ X(a R b))</code>. We then{' '}
          <i>degeneralize</i> it (a counter construction) to an ordinary Büchi automaton.
        </li>
        <li>
          <b>Model.</b> A <i>Kripke structure</i> is the system under test: states of the world
          labelled with the propositions true there. Its behaviours are its infinite paths.
        </li>
        <li>
          <b>Model checking.</b> To prove M ⊨ φ we try to <i>refute</i> it: build A(¬φ), take the
          product with M, and check whether any behaviour of M is accepted by A(¬φ). A non-empty
          product yields a <i>lasso</i> counterexample; an empty one certifies the property. This is
          the <i>automata-theoretic</i> method of Vardi &amp; Wolper, the engine inside SPIN and NuSMV.
        </li>
      </ul>
      <h3 className="sec-h">The hierarchy, one level up</h3>
      <p className="note">
        Finite-word regular languages are recognised by NFAs; their infinite-word cousins, the{' '}
        <b>ω-regular</b> languages, are recognised by Büchi automata — and LTL carves out exactly the{' '}
        <i>star-free</i> ω-regular properties. Everything here is hand-written: the parser, the tableau,
        the degeneralization, the product, the emptiness search, and an independent semantics oracle
        that differentially verifies the whole chain in the Verify tab.
      </p>
    </div>
  )
}
