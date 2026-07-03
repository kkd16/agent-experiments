import { useMemo, useState } from 'react'
import Graph from '../components/Graph'
import { Stat } from '../components/Stat'
import { parseFormula } from '../engine/presburger/parser'
import { compile } from '../engine/presburger/build'
import type { BuildStep } from '../engine/presburger/build'
import { showFormula } from '../engine/presburger/formula'
import { presburgerToGraph } from '../engine/presburger/diagram'
import { enumerate, isEmpty, encodeTuple, runTrace, alphabetSize } from '../engine/presburger/automaton'
import type { PDfa } from '../engine/presburger/automaton'
import { PRESBURGER_EXAMPLES } from '../engine/presburger/examples'
import { runSelfTest } from '../engine/presburger/selftest'
import './LogicView.css'
import './PresburgerView.css'

export type PresburgerTab = 'construct' | 'automaton' | 'solutions' | 'verify' | 'about'

const TABS: { id: PresburgerTab; label: string }[] = [
  { id: 'construct', label: 'Construct' },
  { id: 'automaton', label: 'Automaton' },
  { id: 'solutions', label: 'Solutions' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

interface Props {
  formula: string
  onFormula: (s: string) => void
  input: string
  onInput: (s: string) => void
  tab: PresburgerTab
  onTab: (t: PresburgerTab) => void
}

export default function PresburgerView({ formula, onFormula, input, onInput, tab, onTab }: Props) {
  const pf = useMemo(() => parseFormula(formula), [formula])
  const built = useMemo(() => {
    if (!pf.ok || !pf.formula) return null
    try {
      return compile(pf.formula)
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [pf])

  const [step, setStep] = useState<number | null>(null)

  const loadExample = (i: number) => {
    onFormula(PRESBURGER_EXAMPLES[i].formula)
    setStep(null)
  }

  const formulaError = !pf.ok
    ? `column ${(pf.pos ?? 0) + 1}: ${pf.message}`
    : built && 'error' in built
      ? built.error
      : null

  const ok = built && !('error' in built) ? built : null

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
                <div className="err-msg">{formulaError ?? 'enter a Presburger formula'}</div>
              </div>
            </div>
          ) : tab === 'construct' ? (
            <ConstructTab res={ok} step={step} setStep={setStep} />
          ) : tab === 'automaton' ? (
            <AutomatonTab res={ok} />
          ) : (
            <SolutionsTab res={ok} input={input} onInput={onInput} />
          )}
        </div>
      </main>

      <aside className="rail">
        <section className="panel">
          <h2>Presburger formula</h2>
          <p className="panel-sub">
            Linear integer arithmetic over ℕ: <code>+</code>, integer coefficients, <code>=</code> <code>&lt;</code>{' '}
            <code>≤</code> …, divisibility <code>d | t</code>, the connectives <code>¬ ∧ ∨ → ↔</code>, and the
            quantifiers <code>E x.</code> / <code>A x.</code> (also <code>∃ ∀</code>). Free variables become the
            axes of the solution set.
          </p>
          <input
            className="sim-input logic-formula"
            value={formula}
            spellCheck={false}
            onChange={(e) => onFormula(e.target.value)}
            placeholder="E y. x = 2*y"
            aria-label="Presburger formula"
          />
          {formulaError ? (
            <div className="warn small">{formulaError}</div>
          ) : ok ? (
            <div className="logic-rendered" title="the formula, normalised">
              {showFormula(pf.formula!)}
              <span className={`frag-badge frag-${ok.sentence ? 'sentence' : 'open'}`}>
                {ok.sentence ? 'closed sentence — a truth value' : `${ok.vars.length}-variable solution set`}
              </span>
            </div>
          ) : null}
          <div className="formula-gallery">
            {PRESBURGER_EXAMPLES.map((g, i) => (
              <button key={g.name} className="chip" title={g.formula} onClick={() => loadExample(i)}>
                {g.name}
              </button>
            ))}
          </div>
        </section>

        {ok && (
          <section className="panel">
            <h2>The final machine</h2>
            <p className="panel-sub">{ok.vars.length ? `over the tracks ${ok.vars.join(', ')}` : 'over the empty alphabet — a sentence'}</p>
            <div className="statline">
              <Stat k="Q" v={ok.dfa.numStates} title="states of the minimized automaton" />
              <Stat k="Σ" v={alphabetSize(ok.dfa.k)} title="alphabet size = 2^(variables in scope)" />
              <Stat k="k" v={ok.dfa.k} title="variable tracks" />
              <Stat k="steps" v={ok.steps.length} title="construction steps" />
            </div>
            {ok.sentence ? (
              <div className={`sentence-verdict ${isEmpty(ok.dfa) ? 'no' : 'yes'}`}>
                {isEmpty(ok.dfa) ? 'FALSE' : 'TRUE'}
              </div>
            ) : null}
          </section>
        )}

        <section className="panel">
          <h2>Gallery</h2>
          <select
            className="examples"
            value=""
            onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
            aria-label="load an example"
          >
            <option value="">load a formula ▾</option>
            {PRESBURGER_EXAMPLES.map((g, i) => (
              <option key={g.name} value={i}>
                {g.name}
              </option>
            ))}
          </select>
          {ok && (
            <p className="note small gallery-note">
              {PRESBURGER_EXAMPLES.find((e) => e.formula === formula)?.note ??
                'Every formula is a regular language of LSBF bit-vector words — that is Presburger’s theorem, made mechanical.'}
            </p>
          )}
        </section>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Construct tab — the build, bottom-up.
// ---------------------------------------------------------------------------

function opTitle(op: string): string {
  if (op === 'atom') return 'atomic automaton'
  if (op === '¬') return 'complement'
  if (op === '∧') return 'product ∧'
  if (op === '∨') return 'product ∨'
  if (op === '→') return 'product →'
  if (op === '↔') return 'product ↔'
  if (op.startsWith('∃')) return 'project ' + op
  if (op.startsWith('∀')) return '¬∃¬ ' + op
  if (op === '⊤' || op === '⊥') return 'constant'
  return op
}

function ConstructTab({
  res,
  step,
  setStep,
}: {
  res: { steps: BuildStep[]; dfa: PDfa }
  step: number | null
  setStep: (n: number) => void
}) {
  const sel = step === null ? res.steps.length - 1 : Math.min(step, res.steps.length - 1)
  const cur = res.steps[sel]
  const pg = useMemo(() => presburgerToGraph(cur.dfa), [cur])
  return (
    <div className="construct-wrap">
      <div className="construct-strip">
        {res.steps.map((s) => (
          <button
            key={s.id}
            className={`step-chip${s.id === sel ? ' active' : ''}`}
            onClick={() => setStep(s.id)}
            title={s.formula}
          >
            <span className="step-op">{s.op}</span>
            <span className="step-form">{s.formula.length > 26 ? s.formula.slice(0, 25) + '…' : s.formula}</span>
            <span className="step-q">{s.states}Q</span>
          </button>
        ))}
      </div>
      <div className="construct-main">
        <div className="construct-caption">
          <span className="op-badge">{opTitle(cur.op)}</span>
          <span className="op-formula">{cur.formula}</span>
          <span className="op-meta">
            tracks [{cur.vars.join(', ') || '∅'}] · {cur.states} states · Σ = {alphabetSize(cur.dfa.k)}
          </span>
        </div>
        <div className="graph-frame">
          <Graph graph={pg.graph} fitKey={`c-${sel}-${cur.states}`} exportName={`presburger-step-${sel}`} />
        </div>
        <AlphabetLegend vars={cur.dfa.vars} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Automaton tab — the final machine.
// ---------------------------------------------------------------------------

function AutomatonTab({ res }: { res: { dfa: PDfa; sentence: boolean; vars: string[] } }) {
  const pg = useMemo(() => presburgerToGraph(res.dfa), [res])
  if (res.sentence) {
    const empty = isEmpty(res.dfa)
    return (
      <div className="pad-scroll">
        <h3 className="sec-h">A closed sentence collapses to a truth value</h3>
        <p className="note">
          With no free variables the alphabet is empty (2⁰ = 1 letter): the automaton either accepts the empty
          word or nothing at all. It is <b>{empty ? 'empty' : 'non-empty'}</b>, so the sentence is{' '}
          <b>{empty ? 'FALSE' : 'TRUE'}</b>. This is the decision procedure at its sharpest — a whole
          quantified statement of arithmetic reduced to “is this automaton empty?”.
        </p>
        <div className={`sentence-verdict big ${empty ? 'no' : 'yes'}`}>{empty ? 'FALSE' : 'TRUE'}</div>
      </div>
    )
  }
  return (
    <div className="automaton-wrap">
      <div className="graph-frame tall">
        <Graph graph={pg.graph} fitKey={`final-${res.dfa.numStates}`} exportName="presburger-automaton" />
      </div>
      <AlphabetLegend vars={res.dfa.vars} />
    </div>
  )
}

function AlphabetLegend({ vars }: { vars: string[] }) {
  if (vars.length === 0)
    return <div className="alpha-legend empty-alpha">alphabet: the single empty bit-vector (a sentence)</div>
  return (
    <div className="alpha-legend">
      <span className="legend-title">bit-vector alphabet {'{0,1}'}<sup>{vars.length}</sup>:</span>
      {vars.map((v, i) => (
        <span key={v} className="track-key">
          <span className="track-pos">bit {i}</span> = <span className="track-var">{v}</span>
        </span>
      ))}
      <span className="legend-note">edges read least-significant-bit first; <code>·</code> = “either bit”.</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Solutions tab — enumerate + a live membership tester.
// ---------------------------------------------------------------------------

function SolutionsTab({
  res,
  input,
  onInput,
}: {
  res: { dfa: PDfa; sentence: boolean; vars: string[] }
  input: string
  onInput: (s: string) => void
}) {
  const solutions = useMemo(() => (res.sentence ? [] : enumerate(res.dfa, 40)), [res])

  if (res.sentence) {
    const empty = isEmpty(res.dfa)
    return (
      <div className="pad-scroll">
        <h3 className="sec-h">Verdict</h3>
        <p className="note">
          A closed sentence has no solution <em>tuples</em> — only a truth value, read off as the emptiness of
          the final automaton.
        </p>
        <div className={`sentence-verdict big ${empty ? 'no' : 'yes'}`}>{empty ? 'FALSE' : 'TRUE'}</div>
      </div>
    )
  }

  const values = input
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10))
  const clean = res.vars.map((_, i) => (Number.isFinite(values[i]) && values[i] >= 0 ? values[i] : 0))
  const word = encodeTuple(clean)
  const trace = runTrace(res.dfa, word)
  const accepted = res.dfa.accept[trace[trace.length - 1]]

  return (
    <div className="solutions-wrap">
      <div className="sol-section">
        <h3 className="sec-h">Smallest solutions</h3>
        <p className="note">
          The shortest accepted words, decoded back to tuples of naturals (least-significant-bit first). The
          solution set is infinite; here are the first {solutions.length}.
        </p>
        <div className="sol-grid">
          {solutions.map((tup, i) => (
            <div key={i} className="sol-tuple">
              {res.vars.map((v, j) => (
                <span key={v} className="sol-assign">
                  <span className="sol-var">{v}</span>=<span className="sol-val">{tup[j]}</span>
                </span>
              ))}
            </div>
          ))}
          {solutions.length === 0 && <div className="sol-empty">no solutions — the language is empty</div>}
        </div>
      </div>

      <div className="sol-section">
        <h3 className="sec-h">Membership tester</h3>
        <p className="note">
          Type a value for each variable; we encode the tuple LSBF and run it through the automaton, one
          bit-vector column at a time.
        </p>
        <div className="mem-inputs">
          {res.vars.map((v, i) => (
            <label key={v} className="mem-field">
              <span className="mem-var">{v}</span>
              <input
                className="mem-num"
                type="number"
                min={0}
                value={Number.isFinite(values[i]) ? values[i] : ''}
                placeholder="0"
                onChange={(e) => {
                  const next = [...clean]
                  next[i] = Math.max(0, parseInt(e.target.value || '0', 10) || 0)
                  onInput(next.join(', '))
                }}
              />
            </label>
          ))}
        </div>
        <WordRun vars={res.vars} clean={clean} word={word} trace={trace} accepted={accepted} />
      </div>
    </div>
  )
}

function WordRun({
  vars,
  clean,
  word,
  trace,
  accepted,
}: {
  vars: string[]
  clean: number[]
  word: number[]
  trace: number[]
  accepted: boolean
}) {
  return (
    <div className="word-run">
      <div className="word-matrix">
        <div className="wm-row wm-head">
          <div className="wm-label">state</div>
          {trace.map((s, i) => (
            <div key={i} className="wm-state">
              {s}
              {i < word.length && <span className="wm-arrow">→</span>}
            </div>
          ))}
        </div>
        {vars.map((v, j) => (
          <div key={v} className="wm-row">
            <div className="wm-label">
              {v} = {clean[j]}
            </div>
            {word.map((letter, i) => (
              <div key={i} className={`wm-bit${(letter >> j) & 1 ? ' one' : ''}`}>
                {(letter >> j) & 1}
                {i < word.length && <span className="wm-gap" />}
              </div>
            ))}
            {word.length === 0 && <div className="wm-bit eps">ε</div>}
          </div>
        ))}
      </div>
      <div className={`mem-verdict ${accepted ? 'yes' : 'no'}`}>
        {accepted ? '✓ satisfies the formula' : '✗ does not satisfy the formula'}
      </div>
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
        The decision procedure is graded, live, against a brute-force evaluator that shares <b>no code</b> with
        it. The headline is an <b>exhaustive</b> differential: across hundreds of random quantifier-free formulas
        the automaton accepts the LSBF encoding of a tuple <b>iff</b> the direct semantics say the tuple
        satisfies the formula — every tuple in a box <code>[0,R)ᵏ</code>. Plus existential agreement against a
        bounded-witness oracle, the boolean-algebra laws (double negation, idempotence, De Morgan), structural
        invariants on every machine (total, deterministic, 0-stable, already minimal), and a known-answer battery.
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
      <h3 className="sec-h">Arithmetic, decided by automata</h3>
      <p className="note">
        <b>Presburger arithmetic</b> is the first-order theory of the naturals with addition and order — you may
        write <code>+</code>, integer constants, <code>=</code> and <code>&lt;</code>, all the boolean
        connectives, and quantifiers <code>∃</code>/<code>∀</code>, but <b>not multiplication of variables</b>.
        In 1929 Mojżesz Presburger proved this theory <b>decidable</b>: there is an algorithm that settles the
        truth of every sentence. Drop the ban on multiplication and you regain full arithmetic — where Gödel and
        Church proved no such algorithm can exist. This mode lives exactly one axis away from the undecidable.
      </p>
      <h4 className="sub-h">The idea: a number is a word</h4>
      <p className="note">
        Read a tuple of naturals <b>least-significant-bit first</b> as a word over the bit-vector alphabet{' '}
        <code>{'{0,1}'}ᵏ</code> — column <em>i</em> holds bit <em>i</em> of every variable at once. Presburger’s
        theorem, in its automata-theoretic form (Büchi; Boudet–Comon; Wolper–Boigelot — the engine inside{' '}
        <b>MONA</b>), says the encodings of the satisfying tuples of <em>any</em> formula form a{' '}
        <b>regular language</b>. So the whole formula compiles, piece by piece, into a finite automaton:
      </p>
      <ul className="about-list">
        <li>
          <b>Atoms.</b> An equation or inequality <code>Σ aᵢxᵢ ⋈ c</code> becomes a tiny <b>carry automaton</b>:
          the state is the value the remaining higher bits still owe, halved as each column is read.
          A divisibility <code>d | t</code> becomes a residue-and-place-value automaton (≤ d² states).
        </li>
        <li>
          <b>¬ ∧ ∨ → ↔.</b> Exactly the DFA boolean algebra the rest of the lab already owns —{' '}
          <b>complement</b> and the reachable <b>product</b>.
        </li>
        <li>
          <b>∃x.</b> Drop x’s track. Each remaining letter now has two pre-images (x’s bit was 0 or 1), so the
          machine goes nondeterministic; <b>subset-determinize</b>, then <b>0-saturate</b> so a short word can
          still spell an arbitrarily large witness. <b>∀x = ¬∃x¬</b>.
        </li>
        <li>
          <b>A sentence</b> has no free variables — its alphabet is empty, and it is <b>true iff the automaton is
          non-empty</b>. Emptiness of a finite automaton is trivially decidable: that is the whole proof, run.
        </li>
      </ul>
      <h4 className="sub-h">Why it is honest</h4>
      <p className="note">
        Every construction here is checked, live, in the <b>Verify</b> tab against a from-scratch evaluator that
        never touches an automaton — an exhaustive tuple-by-tuple differential, the boolean laws, and a
        known-answer battery (the even numbers, the Frobenius set ⟨3,5⟩, <code>2x=1</code> unsatisfiable). The
        worst-case cost is famously enormous — the tower of exponentials — but for the small formulas here the
        machines are tiny, minimal, and drawn for you to walk.
      </p>
    </div>
  )
}
