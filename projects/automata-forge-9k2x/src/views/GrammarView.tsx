import { useMemo, useState } from 'react'
import {
  parseGrammar,
  prettyGrammar,
  groupByLhs,
  showRhs,
  ntSetOf,
} from '../engine/cfg/grammar'
import type { Grammar } from '../engine/cfg/grammar'
import { analyzeUsefulness, firstFollow } from '../engine/cfg/analyze'
import { earley, earleyParse, countParses, showItem } from '../engine/cfg/earley'
import { enumerateLanguage } from '../engine/cfg/brute'
import { toCnfStages, isCnf } from '../engine/cfg/normalize'
import { cyk } from '../engine/cfg/cyk'
import { cfgToPda, runPda } from '../engine/cfg/pda'
import { regexToRightLinear } from '../engine/cfg/regular2cfg'
import { pump, parts, checkDecomposition, normalizeDecomposition } from '../engine/cfg/cflPumping'
import type { Decomposition } from '../engine/cfg/cflPumping'
import { showChar } from '../engine/types'
import ParseTree from '../components/ParseTree'
import { Stat } from '../components/Stat'
import { GRAMMAR_EXAMPLES } from '../engine/cfg/examples'
import './GrammarView.css'

export type GrammarTab = 'analyze' | 'cnf' | 'cyk' | 'earley' | 'tree' | 'sampler' | 'pda' | 'pumping'

const TABS: { id: GrammarTab; label: string }[] = [
  { id: 'analyze', label: 'Analyze' },
  { id: 'cnf', label: 'CNF' },
  { id: 'cyk', label: 'CYK' },
  { id: 'earley', label: 'Earley' },
  { id: 'tree', label: 'Parse tree' },
  { id: 'sampler', label: 'Sampler' },
  { id: 'pda', label: 'PDA' },
  { id: 'pumping', label: 'Pumping' },
]

interface Props {
  text: string
  onText: (t: string) => void
  input: string
  onInput: (s: string) => void
  tab: GrammarTab
  onTab: (t: GrammarTab) => void
}

const sym = (s: string) => (s === '' ? 'ε' : s === '$' ? '$' : showChar(s))

export default function GrammarView({ text, onText, input, onInput, tab, onTab }: Props) {
  const [regexSeed, setRegexSeed] = useState('(a|b)*ab')

  const parsed = useMemo(() => parseGrammar(text), [text])
  const grammar = parsed.grammar

  const loadExample = (i: number) => {
    onText(GRAMMAR_EXAMPLES[i].text)
    onInput(GRAMMAR_EXAMPLES[i].test)
  }

  return (
    <div className="workspace grammar-ws">
      <main className="viewer">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="canvas">
          {!grammar ? (
            <div className="empty">
              {parsed.errors.length > 0 ? (
                <div className="parse-error gram-error">
                  {parsed.errors.slice(0, 6).map((e, i) => (
                    <div key={i} className="err-msg">
                      line {e.line}: {e.message}
                    </div>
                  ))}
                </div>
              ) : (
                'Write a grammar to begin.'
              )}
            </div>
          ) : (
            <TabBody tab={tab} grammar={grammar} input={input} />
          )}
        </div>
      </main>

      <aside className="rail">
        <section className="panel">
          <h2>Grammar</h2>
          <p className="panel-sub">
            One <strong>uppercase letter</strong> = a nonterminal; every other character is a
            terminal. <code>-&gt;</code> or <code>→</code>, <code>|</code> for choice, <code>ε</code>{' '}
            or an empty body for the empty word.
          </p>
          <textarea
            className="grammar-input"
            value={text}
            spellCheck={false}
            onChange={(e) => onText(e.target.value)}
            rows={8}
            aria-label="grammar"
          />
          <select
            className="examples"
            value=""
            onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
            aria-label="load an example grammar"
          >
            <option value="">examples ▾</option>
            {GRAMMAR_EXAMPLES.map((ex, i) => (
              <option key={i} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
          {grammar && (
            <div className="statline gram-stats">
              <Stat k="V" v={grammar.nonterminals.length} title="nonterminals (variables)" />
              <Stat k="Σ" v={grammar.terminals.length} title="terminals" />
              <Stat k="P" v={grammar.productions.length} title="productions" />
            </div>
          )}
          {parsed.errors.length > 0 && grammar && (
            <div className="warn small">
              {parsed.errors.length} line(s) ignored — check the syntax.
            </div>
          )}
        </section>

        {grammar && <MemberPanel grammar={grammar} input={input} onInput={onInput} />}

        <section className="panel">
          <h2>From a regex</h2>
          <p className="panel-sub">
            Every regular language is context-free. Compile a regex to an equivalent{' '}
            <strong>right-linear</strong> grammar.
          </p>
          <input
            className="sim-input"
            value={regexSeed}
            spellCheck={false}
            onChange={(e) => setRegexSeed(e.target.value)}
            placeholder="regex, e.g. (a|b)*ab"
            aria-label="regex to convert"
          />
          <button
            className="ghost-btn"
            onClick={() => {
              const r = regexToRightLinear(regexSeed)
              if (r.grammar) onText(prettyGrammar(r.grammar))
            }}
          >
            → load as grammar
          </button>
        </section>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------

function TabBody({ tab, grammar, input }: { tab: GrammarTab; grammar: Grammar; input: string }) {
  switch (tab) {
    case 'analyze':
      return <AnalyzeTab grammar={grammar} />
    case 'cnf':
      return <CnfTab grammar={grammar} />
    case 'cyk':
      return <CykTab grammar={grammar} input={input} />
    case 'earley':
      return <EarleyTab grammar={grammar} input={input} />
    case 'tree':
      return <TreeTab grammar={grammar} input={input} />
    case 'sampler':
      return <SamplerTab grammar={grammar} />
    case 'pda':
      return <PdaTab grammar={grammar} input={input} />
    case 'pumping':
      return <PumpingTab grammar={grammar} input={input} />
  }
}

function GrammarBlock({ grammar }: { grammar: Grammar }) {
  return (
    <div className="grammar-block">
      {groupByLhs(grammar).map(({ lhs, rhss }) => (
        <div key={lhs} className="prod-line">
          <span className="prod-lhs">{lhs}</span>
          <span className="prod-arrow">→</span>
          <span className="prod-rhs">
            {rhss.map((r, i) => (
              <span key={i}>
                {i > 0 && <span className="prod-bar"> | </span>}
                {showRhs(r)}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

function AnalyzeTab({ grammar }: { grammar: Grammar }) {
  const use = useMemo(() => analyzeUsefulness(grammar), [grammar])
  const ff = useMemo(() => firstFollow(grammar), [grammar])
  const set = (s: Set<string>) => [...s].filter((x) => grammar.nonterminals.includes(x))
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Symbol classification</h3>
      <div className="class-grid">
        <ClassRow label="Nullable" hint="derive ε" items={set(use.nullable)} />
        <ClassRow
          label="Generating"
          hint="derive some terminal string"
          items={grammar.nonterminals.filter((n) => use.generating.has(n))}
        />
        <ClassRow
          label="Reachable"
          hint="usable from the start symbol"
          items={grammar.nonterminals.filter((n) => use.reachable.has(n))}
        />
        <ClassRow label="Useless" hint="non-generating or unreachable" items={use.uselessNts} bad />
      </div>

      <h3 className="sec-h">FIRST / FOLLOW</h3>
      <table className="ff-table">
        <thead>
          <tr>
            <th>A</th>
            <th>FIRST(A)</th>
            <th>FOLLOW(A)</th>
          </tr>
        </thead>
        <tbody>
          {grammar.nonterminals.map((n) => (
            <tr key={n}>
              <td className="ff-nt">{n}</td>
              <td>{[...(ff.first.get(n) ?? [])].map(sym).join('  ') || '∅'}</td>
              <td>{[...(ff.follow.get(n) ?? [])].map(sym).join('  ') || '∅'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">FIRST/FOLLOW are the foundation of LL/LR parse tables. ε shown as <code>ε</code>, end-of-input as <code>$</code>.</p>
    </div>
  )
}

function ClassRow({ label, hint, items, bad }: { label: string; hint: string; items: string[]; bad?: boolean }) {
  return (
    <div className="class-row">
      <div className="class-label">
        {label}
        <span className="class-hint">{hint}</span>
      </div>
      <div className="class-items">
        {items.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          items.map((x) => (
            <code key={x} className={`chip${bad ? ' bad' : ''}`}>
              {x}
            </code>
          ))
        )}
      </div>
    </div>
  )
}

function CnfTab({ grammar }: { grammar: Grammar }) {
  const stages = useMemo(() => toCnfStages(grammar), [grammar])
  return (
    <div className="pad-scroll">
      <p className="note">
        Each stage rewrites the grammar toward Chomsky Normal Form (A → BC, A → a, or S₀ → ε). The
        last stage is the CNF used by the CYK tab.
      </p>
      <div className="stage-list">
        {stages.map((st, i) => (
          <div key={i} className="stage">
            <div className="stage-head">
              <span className="stage-name">{st.name}</span>
              <span className="stage-note">{st.note}</span>
            </div>
            <GrammarBlock grammar={st.grammar} />
          </div>
        ))}
      </div>
      <p className="note">
        Result is {isCnf(stages[stages.length - 1].grammar) ? <b className="ok">valid CNF ✓</b> : <b className="bad">not CNF</b>}.
      </p>
    </div>
  )
}

function CykTab({ grammar, input }: { grammar: Grammar; input: string }) {
  const { cnf, res } = useMemo(() => {
    const stages = toCnfStages(grammar)
    const cnf = stages[stages.length - 1].grammar
    return { cnf, res: cyk(cnf, input) }
  }, [grammar, input])
  const n = input.length

  return (
    <div className="pad-scroll">
      <div className={`verdict ${res.accepted ? 'yes' : 'no'}`}>
        {input === '' ? 'ε' : input} is {res.accepted ? '' : 'not '}in L
        {res.accepted && res.count > 1 && <span className="amb"> · {res.count >= 2000 ? '2000+' : res.count} parse trees</span>}
      </div>
      {n === 0 ? (
        <p className="note">Empty input: accepted iff the start symbol has an ε-rule in CNF.</p>
      ) : (
        <div className="cyk-wrap">
          <table className="cyk-table">
            <tbody>
              {[...res.cells].reverse().map((row, ri) => {
                const len = res.cells.length - ri
                return (
                  <tr key={len}>
                    <th className="cyk-len">{len}</th>
                    {row.map((cell, i) => (
                      <td key={i} className={`cyk-cell${cell.length ? '' : ' empty-cell'}`}>
                        {cell.length ? cell.join(' ') : '·'}
                      </td>
                    ))}
                  </tr>
                )
              })}
              <tr>
                <th className="cyk-len">len</th>
                {[...input].map((ch, i) => (
                  <td key={i} className="cyk-input">
                    {showChar(ch)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="note">
        Cell (row = span length, column = start position) lists every CNF nonterminal deriving that
        substring. Top cell holding <code>{cnf.start}</code> ⇒ accepted.
      </p>
    </div>
  )
}

function EarleyTab({ grammar, input }: { grammar: Grammar; input: string }) {
  const res = useMemo(() => earley(grammar, input), [grammar, input])
  return (
    <div className="pad-scroll">
      <div className={`verdict ${res.accepted ? 'yes' : 'no'}`}>
        {input === '' ? 'ε' : input} is {res.accepted ? '' : 'not '}in L
      </div>
      <div className="chart">
        {res.chart.map((state, k) => (
          <div key={k} className="chart-state">
            <div className="chart-head">
              S<sub>{k}</sub>
              <span className="chart-pos">{k < input.length ? `· next: ${showChar(input[k])}` : '· end'}</span>
            </div>
            <div className="chart-items">
              {state.length === 0 ? (
                <span className="muted">(empty)</span>
              ) : (
                state.map((it, i) => (
                  <code key={i} className="item">
                    {showItem(res, it)}
                  </code>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="note">
        Each state S<sub>k</sub> holds items <code>A → α • β (j)</code>: production, dot, and the
        origin where the attempt began. The string is accepted iff the augmented start <code>Γ → S •
        (0)</code> appears in the final state.
      </p>
    </div>
  )
}

function TreeTab({ grammar, input }: { grammar: Grammar; input: string }) {
  const { tree, count } = useMemo(
    () => ({ tree: earleyParse(grammar, input), count: countParses(grammar, input) }),
    [grammar, input],
  )
  if (!tree) {
    return (
      <div className="empty">
        <code>{input === '' ? 'ε' : input}</code> is not in L — no parse tree.
      </div>
    )
  }
  return (
    <div className="tree-wrap">
      <div className="tree-banner">
        Leftmost derivation tree
        {count > 1 && (
          <span className="amb"> · grammar is ambiguous here: {count >= 2000 ? '2000+' : count} trees</span>
        )}
      </div>
      <ParseTree tree={tree} />
    </div>
  )
}

function SamplerTab({ grammar }: { grammar: Grammar }) {
  const words = useMemo(() => enumerateLanguage(grammar, { maxLen: 9, limit: 40 }), [grammar])
  return (
    <div className="pad-scroll">
      <p className="note">Shortest words in L (by length, then lexicographic), found by expanding leftmost nonterminals.</p>
      {words.length === 0 ? (
        <div className="empty">L appears empty (up to length 9).</div>
      ) : (
        <div className="word-grid">
          {words.map((w, i) => (
            <code key={i} className="word">
              {w === '' ? 'ε' : [...w].map(showChar).join('')}
            </code>
          ))}
        </div>
      )}
    </div>
  )
}

function PdaTab({ grammar, input }: { grammar: Grammar; input: string }) {
  const pda = useMemo(() => cfgToPda(grammar), [grammar])
  const run = useMemo(() => runPda(pda, input), [pda, input])
  const [step, setStep] = useState(0)
  const nt = useMemo(() => ntSetOf(grammar), [grammar])
  const maxStep = Math.max(0, run.steps.length - 1)
  const s = Math.min(step, maxStep)
  const cur = run.steps[s]

  return (
    <div className="pda-wrap">
      <div className="pda-left">
        <h3 className="sec-h">Transition function δ (single state q, accept by empty stack)</h3>
        <div className="pda-trans">
          {pda.transitions.map((t, i) => (
            <code key={i} className="pda-rule">
              (q, {t.read === null ? 'ε' : showChar(t.read)}, {showChar(t.pop)}) → (q,{' '}
              {t.push.length ? t.push.map(showChar).join('') : 'ε'})
            </code>
          ))}
        </div>
        <p className="note">
          Stack starts as <code>{grammar.start}</code>. Variable rules expand on ε; terminal rules
          match &amp; pop one input symbol. A leftmost derivation ↔ an accepting run.
        </p>
      </div>
      <div className="pda-right">
        <div className={`verdict ${run.accepted ? 'yes' : 'no'}`}>
          {input === '' ? 'ε' : input} {run.accepted ? 'accepted' : run.budgetExceeded ? 'undecided (budget)' : 'rejected'}
        </div>
        {run.accepted && cur && (
          <>
            <div className="pda-config">
              <div className="pda-stack-col">
                <span className="pda-cap">stack</span>
                <div className="pda-stack">
                  {cur.stack.length === 0 ? (
                    <span className="muted">empty</span>
                  ) : (
                    [...cur.stack].reverse().map((x, i) => (
                      <span key={i} className={`stack-cell${nt.has(x) ? ' nt' : ''}${i === 0 ? ' top' : ''}`}>
                        {showChar(x)}
                      </span>
                    ))
                  )}
                </div>
              </div>
              <div className="pda-tape-col">
                <span className="pda-cap">remaining input</span>
                <div className="pda-remaining">
                  {cur.remaining === '' ? <span className="muted">ε</span> : [...cur.remaining].map((c, i) => (
                    <span key={i} className={`cell${i === 0 ? ' current' : ''}`}>{showChar(c)}</span>
                  ))}
                </div>
                {cur.via && (
                  <div className="pda-action">
                    apply (q, {cur.via.read === null ? 'ε' : showChar(cur.via.read)}, {showChar(cur.via.pop)}) → push{' '}
                    {cur.via.push.length ? cur.via.push.map(showChar).join('') : 'ε'}
                  </div>
                )}
              </div>
            </div>
            <div className="sim-controls">
              <button onClick={() => setStep(0)} disabled={s === 0}>⏮</button>
              <button onClick={() => setStep((x) => Math.max(0, x - 1))} disabled={s === 0}>◀</button>
              <span className="step-count">{s} / {maxStep}</span>
              <button onClick={() => setStep((x) => Math.min(maxStep, x + 1))} disabled={s >= maxStep}>▶</button>
              <button onClick={() => setStep(maxStep)} disabled={s >= maxStep}>⏭</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PumpingTab({ grammar, input }: { grammar: Grammar; input: string }) {
  const z = input
  const [dec, setDec] = useState<Decomposition>({ a: 0, b: 0, c: 0, d: 0 })
  const [i, setI] = useState(2)
  const d = useMemo(() => normalizeDecomposition(dec, z.length), [dec, z.length])
  const p = parts(z, d)
  const checks = checkDecomposition(d, z.length)
  const pumped = pump(z, d, i)
  const inL = useMemo(() => earley(grammar, z).accepted, [grammar, z])
  const pumpedInL = useMemo(() => earley(grammar, pumped).accepted, [grammar, pumped])

  return (
    <div className="pad-scroll">
      <p className="note">
        The CFL pumping lemma: every long enough z ∈ L splits as <b>z = u v x y z′</b> with |vxy| ≤ p,
        |vy| ≥ 1, and u vⁱ x yⁱ z′ ∈ L for all i. Slide the four cut points and pump.
      </p>
      {z === '' ? (
        <div className="empty">Type a string in the test box to decompose it.</div>
      ) : (
        <>
          <div className="pump-string">
            {p.u && <span className="seg u">{[...p.u].map(showChar).join('')}</span>}
            <span className="seg v">{p.v ? [...p.v].map(showChar).join('') : '·'}</span>
            <span className="seg x">{p.x ? [...p.x].map(showChar).join('') : '·'}</span>
            <span className="seg y">{p.y ? [...p.y].map(showChar).join('') : '·'}</span>
            {p.tail && <span className="seg z">{[...p.tail].map(showChar).join('')}</span>}
          </div>
          <div className="pump-legend">
            <span className="seg u">u</span> <span className="seg v">v</span> <span className="seg x">x</span>{' '}
            <span className="seg y">y</span> <span className="seg z">z′</span>
          </div>
          <div className="cuts">
            <Cut label="a" val={d.a} set={(n) => setDec({ ...d, a: n })} max={z.length} />
            <Cut label="b" val={d.b} set={(n) => setDec({ ...d, b: n })} max={z.length} />
            <Cut label="c" val={d.c} set={(n) => setDec({ ...d, c: n })} max={z.length} />
            <Cut label="d" val={d.d} set={(n) => setDec({ ...d, d: n })} max={z.length} />
          </div>
          <div className="checks">
            <span className={checks.windowOk ? 'ok' : 'bad'}>|vxy| = {checks.vxyLen} ≤ p={z.length} {checks.windowOk ? '✓' : '✗'}</span>
            <span className={checks.nonemptyOk ? 'ok' : 'bad'}>|vy| = {checks.vyLen} ≥ 1 {checks.nonemptyOk ? '✓' : '✗'}</span>
            <span className={inL ? 'ok' : 'bad'}>z ∈ L {inL ? '✓' : '✗'}</span>
          </div>
          <label className="pump-i">
            pump i =
            <input type="range" min={0} max={5} value={i} onChange={(e) => setI(Number(e.target.value))} />
            <span className="cut-val">{i}</span>
          </label>
          <div className="pump-result">
            <span className="pr-label">u v<sup>{i}</sup> x y<sup>{i}</sup> z′ =</span>
            <code className="pr-word">{pumped === '' ? 'ε' : [...pumped].map(showChar).join('')}</code>
            <span className={`pr-verdict ${pumpedInL ? 'yes' : 'no'}`}>{pumpedInL ? '∈ L' : '∉ L'}</span>
          </div>
        </>
      )}
    </div>
  )
}

function Cut({ label, val, set, max }: { label: string; val: number; set: (n: number) => void; max: number }) {
  return (
    <label className="cut">
      {label}
      <input type="range" min={0} max={max} value={val} onChange={(e) => set(Number(e.target.value))} />
      <span className="cut-val">{val}</span>
    </label>
  )
}

function MemberPanel({ grammar, input, onInput }: { grammar: Grammar; input: string; onInput: (s: string) => void }) {
  const verdict = useMemo(() => (input === '' ? earley(grammar, '').accepted : earley(grammar, input).accepted), [grammar, input])
  return (
    <section className="panel">
      <h2>Test string</h2>
      <p className="panel-sub">The string parsed by the CYK / Earley / PDA / tree tabs.</p>
      <input
        className="sim-input"
        value={input}
        spellCheck={false}
        onChange={(e) => onInput(e.target.value)}
        placeholder="input string"
        aria-label="test string"
      />
      <div className={`member-verdict ${verdict ? 'yes' : 'no'}`}>
        {input === '' ? 'ε (empty string)' : input} {verdict ? '∈ L' : '∉ L'}
      </div>
    </section>
  )
}
