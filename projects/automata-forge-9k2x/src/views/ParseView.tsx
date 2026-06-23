import { useMemo, useState } from 'react'
import { parseGrammar, prettyGrammar } from '../engine/cfg/grammar'
import type { Grammar } from '../engine/cfg/grammar'
import { regexToRightLinear } from '../engine/cfg/regular2cfg'
import { showChar } from '../engine/types'
import { augment, showProd } from '../engine/parse/augment'
import { buildLl1Table, parseLl1 } from '../engine/parse/ll1'
import type { Ll1Step } from '../engine/parse/ll1'
import { buildLrTable, parseLr } from '../engine/parse/lr-table'
import type { ParserKind, LrTable, Action } from '../engine/parse/lr-table'
import { buildLr0, buildLr1, buildLalr1, showItem } from '../engine/parse/lr-items'
import type { LrAutomaton } from '../engine/parse/lr-items'
import { lrToGraph } from '../engine/parse/diagram'
import { classifyGrammar } from '../engine/parse/classify'
import { PARSE_EXAMPLES } from '../engine/parse/examples'
import Graph from '../components/Graph'
import ParseTree from '../components/ParseTree'
import { Stat } from '../components/Stat'
import './ParseView.css'

export type ParseTab = 'class' | 'll1' | 'automaton' | 'table' | 'parse'

const TABS: { id: ParseTab; label: string }[] = [
  { id: 'class', label: 'Class' },
  { id: 'll1', label: 'LL(1)' },
  { id: 'automaton', label: 'LR automaton' },
  { id: 'table', label: 'LR table' },
  { id: 'parse', label: 'LR parse' },
]

interface Props {
  text: string
  onText: (t: string) => void
  input: string
  onInput: (s: string) => void
  tab: ParseTab
  onTab: (t: ParseTab) => void
}

const tk = (s: string) => (s === '$' ? '$' : showChar(s))

export default function ParseView({ text, onText, input, onInput, tab, onTab }: Props) {
  const [regexSeed, setRegexSeed] = useState('(a|b)*ab')
  const parsed = useMemo(() => parseGrammar(text), [text])
  const grammar = parsed.grammar

  const loadExample = (i: number) => {
    onText(PARSE_EXAMPLES[i].text)
    onInput(PARSE_EXAMPLES[i].test)
  }

  return (
    <div className="workspace parse-ws">
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
            for the empty word. Parsers read each character as one token.
          </p>
          <textarea
            className="grammar-input"
            value={text}
            spellCheck={false}
            onChange={(e) => onText(e.target.value)}
            rows={7}
            aria-label="grammar"
          />
          <select
            className="examples"
            value=""
            onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
            aria-label="load a grammar"
          >
            <option value="">examples ▾</option>
            {PARSE_EXAMPLES.map((ex, i) => (
              <option key={i} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
          {grammar && (
            <div className="statline">
              <Stat k="V" v={grammar.nonterminals.length} title="nonterminals" />
              <Stat k="Σ" v={grammar.terminals.length} title="terminals" />
              <Stat k="P" v={grammar.productions.length} title="productions" />
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Input to parse</h2>
          <p className="panel-sub">The string the LL(1) and LR parsers trace, in the table tabs.</p>
          <input
            className="sim-input"
            value={input}
            spellCheck={false}
            onChange={(e) => onInput(e.target.value)}
            placeholder="e.g. i+i*i"
            aria-label="input string"
          />
        </section>

        <section className="panel">
          <h2>From a regex</h2>
          <p className="panel-sub">
            Every regular language is context-free. Compile a regex to a right-linear grammar (always
            LL(1)/LR(1)).
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

function TabBody({ tab, grammar, input }: { tab: ParseTab; grammar: Grammar; input: string }) {
  switch (tab) {
    case 'class':
      return <ClassTab grammar={grammar} />
    case 'll1':
      return <Ll1Tab grammar={grammar} input={input} />
    case 'automaton':
      return <AutomatonTab grammar={grammar} />
    case 'table':
      return <TableTab grammar={grammar} />
    case 'parse':
      return <ParseTab grammar={grammar} input={input} />
  }
}

// ---- Class summary --------------------------------------------------------

const LR_KINDS: ParserKind[] = ['LR0', 'SLR1', 'LALR1', 'LR1']
const LR_LABEL: Record<ParserKind, string> = {
  LR0: 'LR(0)',
  SLR1: 'SLR(1)',
  LALR1: 'LALR(1)',
  LR1: 'LR(1)',
}

function ClassTab({ grammar }: { grammar: Grammar }) {
  const report = useMemo(() => classifyGrammar(grammar), [grammar])
  return (
    <div className="tabwrap">
      <h3 className="sec-h">Where this grammar sits in the parsing hierarchy</h3>
      <p className="prose">
        A grammar belongs to a parser class exactly when that parser’s table has <em>no conflicts</em>.
        Top-down LL(1) reads left-to-right with one token of lookahead; the bottom-up family grows in
        power LR(0) ⊊ SLR(1) ⊊ LALR(1) ⊊ LR(1) by sharpening <em>when</em> a completed rule may reduce.
      </p>

      <div className="class-grid">
        <ClassCard
          name="LL(1)"
          family="top-down · predictive"
          ok={report.ll1}
          detail={
            report.ll1
              ? 'One token of lookahead picks the production every time — no backtracking.'
              : `${report.ll1Conflicts.length} table cell(s) hold two productions (left recursion or a common left-factor).`
          }
        />
        {LR_KINDS.map((k) => {
          const r = report.lr[k]
          return (
            <ClassCard
              key={k}
              name={LR_LABEL[k]}
              family="bottom-up · shift-reduce"
              ok={r.ok}
              detail={
                r.ok
                  ? 'Conflict-free ACTION table — a deterministic shift-reduce parser exists.'
                  : `${r.conflicts.length} conflict(s): ${[...new Set(r.conflicts.map((c) => c.kinds))].join(', ')}.`
              }
            />
          )
        })}
      </div>

      <div className="class-verdict">
        {report.strongestLr ? (
          <>
            Strongest deterministic bottom-up parser: <strong>{LR_LABEL[report.strongestLr]}</strong>
            {report.ll1 && <> — and it is <strong>LL(1)</strong> too.</>}
          </>
        ) : report.ll1 ? (
          <>It is <strong>LL(1)</strong>, but not LR(k) for any k shown — unusual; double-check the grammar.</>
        ) : (
          <>
            Not LL(1) and not LR(1): the grammar is <strong>ambiguous or inherently nondeterministic</strong>{' '}
            for these methods. (Earley, in Grammar mode, still parses it.)
          </>
        )}
      </div>
    </div>
  )
}

function ClassCard({ name, family, ok, detail }: { name: string; family: string; ok: boolean; detail: string }) {
  return (
    <div className={`class-card ${ok ? 'ok' : 'no'}`}>
      <div className="cc-head">
        <span className="cc-name">{name}</span>
        <span className={`cc-badge ${ok ? 'ok' : 'no'}`}>{ok ? '✓ in class' : '✗ conflicts'}</span>
      </div>
      <div className="cc-family">{family}</div>
      <div className="cc-detail">{detail}</div>
    </div>
  )
}

// ---- LL(1) ----------------------------------------------------------------

function Ll1Tab({ grammar, input }: { grammar: Grammar; input: string }) {
  const table = useMemo(() => buildLl1Table(grammar), [grammar])
  const run = useMemo(() => parseLl1(grammar, table, input), [grammar, table, input])
  const [step, setStep] = useState(0)
  const s = Math.min(step, run.steps.length - 1)
  const cur = run.steps[s]
  const maxStep = run.steps.length - 1

  return (
    <div className="tabwrap">
      <h3 className="sec-h">LL(1) predictive parse table M[A, a]</h3>
      <div className={`verdict ${table.isLl1 ? 'yes' : 'no'}`}>
        {table.isLl1
          ? 'This grammar IS LL(1) — every cell holds at most one production.'
          : `This grammar is NOT LL(1) — ${table.conflicts.length} cell(s) hold two productions (highlighted).`}
      </div>

      <div className="table-scroll">
        <table className="ptable">
          <thead>
            <tr>
              <th className="corner" />
              {table.terminals.map((t) => (
                <th key={t}>{tk(t)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.nonterminals.map((A) => (
              <tr key={A}>
                <th className="rowhead">{A}</th>
                {table.terminals.map((a) => {
                  const prods = table.cell.get(`${A} ${a}`) ?? []
                  const conflict = prods.length > 1
                  return (
                    <td key={a} className={conflict ? 'conflict' : prods.length ? 'filled' : ''}>
                      {prods.map((pi, i) => (
                        <div key={i} className="cell-prod">
                          {showProd(grammar.productions[pi])}
                        </div>
                      ))}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="sec-h">Predictive parse of “{input || 'ε'}”</h3>
      {!table.isLl1 && (
        <p className="hint warn-text">
          The table has conflicts, so this trace resolves each by taking the first production — it may
          mis-parse.
        </p>
      )}
      <div className={`verdict ${run.accepted ? 'yes' : 'no'}`}>
        {run.accepted ? 'accepted ✓' : `rejected — ${run.error ?? 'no valid parse'}`}
      </div>

      <StackParse
        stack={cur.stack}
        topRight
        rest={cur.rest}
        action={cur.action}
        detail={cur.detail}
        highlight={cur.ambiguous}
      />
      <Stepper s={s} max={maxStep} set={setStep} />

      {run.tree && (
        <>
          <h3 className="sec-h">Leftmost-derivation parse tree</h3>
          <ParseTree tree={run.tree} />
        </>
      )}
    </div>
  )
}

// ---- LR automaton ---------------------------------------------------------

type AutoKind = 'LR0' | 'LALR1' | 'LR1'

function AutomatonTab({ grammar }: { grammar: Grammar }) {
  const [kind, setKind] = useState<AutoKind>('LR0')
  const aug = useMemo(() => augment(grammar), [grammar])
  const automaton: LrAutomaton = useMemo(() => {
    if (kind === 'LR0') return buildLr0(aug)
    if (kind === 'LR1') return buildLr1(aug)
    return buildLalr1(aug)
  }, [aug, kind])
  const { graph } = useMemo(() => lrToGraph(automaton), [automaton])
  const [sel, setSel] = useState(0)
  const selId = Math.min(sel, automaton.states.length - 1)

  return (
    <div className="tabwrap">
      <h3 className="sec-h">The canonical {LR_LABEL[kind === 'LALR1' ? 'LALR1' : kind]} automaton (item sets)</h3>
      <div className="seg">
        {(['LR0', 'LALR1', 'LR1'] as AutoKind[]).map((k) => (
          <button key={k} className={`seg-btn${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>
            {LR_LABEL[k]}
          </button>
        ))}
        <span className="seg-note">{automaton.states.length} states</span>
      </div>
      <p className="prose">
        Each node is a <em>set of items</em> (productions with a dot marking how much has been seen);
        an edge <code>I →X→ J</code> is the <code>goto</code> on reading symbol X. Walking it over the
        parse stack tells the parser exactly which reductions are possible. The double ring is the
        accept state ({showProd(aug.prods[0])} •).
      </p>
      <div className="lr-graphwrap">
        <Graph graph={graph} fitKey={`${kind}-${grammar.productions.length}`} exportName={`lr-${kind}`} />
      </div>

      <h3 className="sec-h">Item set Iₙ</h3>
      <div className="seg statewrap">
        {automaton.states.map((st) => (
          <button key={st.id} className={`seg-btn${selId === st.id ? ' active' : ''}`} onClick={() => setSel(st.id)}>
            I{st.id}
          </button>
        ))}
      </div>
      <pre className="itemlist">
        {automaton.states[selId].items.map((it, i) => (
          <div key={i}>{showItem(aug, it, kind !== 'LR0')}</div>
        ))}
      </pre>
    </div>
  )
}

// ---- LR table -------------------------------------------------------------

function actionStr(a: Action): string {
  if (a.kind === 'shift') return `s${a.target}`
  if (a.kind === 'reduce') return `r${a.prod}`
  return 'acc'
}

function TableTab({ grammar }: { grammar: Grammar }) {
  const [kind, setKind] = useState<ParserKind>('SLR1')
  const aug = useMemo(() => augment(grammar), [grammar])
  const table: LrTable = useMemo(() => buildLrTable(grammar, aug, kind), [grammar, aug, kind])
  const states = table.automaton.states

  return (
    <div className="tabwrap">
      <h3 className="sec-h">LR parse table — ACTION &amp; GOTO</h3>
      <div className="seg">
        {LR_KINDS.map((k) => (
          <button key={k} className={`seg-btn${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>
            {LR_LABEL[k]}
          </button>
        ))}
      </div>
      <div className={`verdict ${table.ok ? 'yes' : 'no'}`}>
        {table.ok
          ? `Conflict-free — this grammar IS ${LR_LABEL[kind]}.`
          : `${table.conflicts.length} conflict(s) — NOT ${LR_LABEL[kind]}: ${[...new Set(table.conflicts.map((c) => c.kinds))].join(', ')} (highlighted).`}
      </div>

      <p className="hint">
        <code>sN</code> = shift &amp; go to state N · <code>rN</code> = reduce by production N ·{' '}
        <code>acc</code> = accept. Productions (0 is the augmented start):{' '}
        {aug.prods.map((p, i) => (
          <span key={i} className="prodref">
            <b>{i}</b>:{showProd(p)}
          </span>
        ))}
      </p>

      <div className="table-scroll">
        <table className="ptable lrtable">
          <thead>
            <tr>
              <th rowSpan={2} className="corner">
                state
              </th>
              <th colSpan={table.terminals.length}>ACTION</th>
              <th colSpan={table.nonterminals.length}>GOTO</th>
            </tr>
            <tr>
              {table.terminals.map((t) => (
                <th key={t}>{tk(t)}</th>
              ))}
              {table.nonterminals.map((n) => (
                <th key={n} className="goto-col">
                  {n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {states.map((st) => (
              <tr key={st.id}>
                <th className="rowhead">{st.id}</th>
                {table.terminals.map((t) => {
                  const acts = table.action.get(`${st.id} ${t}`) ?? []
                  const conflict = acts.length > 1
                  return (
                    <td key={t} className={conflict ? 'conflict' : acts.length ? 'filled' : ''}>
                      {acts.map((a, i) => (
                        <span key={i} className={`act ${a.kind}`}>
                          {actionStr(a)}
                        </span>
                      ))}
                    </td>
                  )
                })}
                {table.nonterminals.map((n) => {
                  const g = table.goto.get(`${st.id} ${n}`)
                  return (
                    <td key={n} className={`goto-col${g !== undefined ? ' filled' : ''}`}>
                      {g !== undefined ? g : ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---- LR parse -------------------------------------------------------------

function ParseTab({ grammar, input }: { grammar: Grammar; input: string }) {
  const [kind, setKind] = useState<ParserKind>('LALR1')
  const aug = useMemo(() => augment(grammar), [grammar])
  const table = useMemo(() => buildLrTable(grammar, aug, kind), [grammar, aug, kind])
  const run = useMemo(() => parseLr(table, input), [table, input])
  const [step, setStep] = useState(0)
  const s = Math.min(step, run.steps.length - 1)
  const cur = run.steps[s]
  const maxStep = run.steps.length - 1

  return (
    <div className="tabwrap">
      <h3 className="sec-h">Shift-reduce parse of “{input || 'ε'}”</h3>
      <div className="seg">
        {LR_KINDS.map((k) => (
          <button key={k} className={`seg-btn${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>
            {LR_LABEL[k]}
          </button>
        ))}
        {!table.ok && <span className="seg-note bad-note">{table.conflicts.length} conflict(s)</span>}
      </div>
      <div className={`verdict ${run.accepted ? 'yes' : 'no'}`}>
        {run.accepted ? 'accepted ✓' : `rejected — ${run.error ?? 'syntax error'}`}
      </div>

      <div className="lr-config">
        <div className="lr-col">
          <span className="lr-cap">state stack</span>
          <div className="lr-row states">
            {cur.states.map((st, i) => (
              <span key={i} className="lr-cell st">
                {st}
              </span>
            ))}
          </div>
        </div>
        <div className="lr-col">
          <span className="lr-cap">symbol stack</span>
          <div className="lr-row">
            {cur.symbols.length === 0 ? (
              <span className="lr-empty">⊥</span>
            ) : (
              cur.symbols.map((x, i) => (
                <span key={i} className="lr-cell sym">
                  {tk(x)}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="lr-col grow">
          <span className="lr-cap">input</span>
          <div className="lr-row input">
            {cur.rest.map((x, i) => (
              <span key={i} className={`lr-cell in${i === 0 ? ' next' : ''}`}>
                {tk(x)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className={`action-line ${cur.action}${cur.ambiguous ? ' amb' : ''}`}>
        <span className="action-kind">{cur.action}</span>
        {cur.detail}
      </div>
      <Stepper s={s} max={maxStep} set={setStep} />

      {run.tree && (
        <>
          <h3 className="sec-h">Parse tree (rightmost derivation, reversed)</h3>
          <ParseTree tree={run.tree} />
        </>
      )}
    </div>
  )
}

// ---- shared bits ----------------------------------------------------------

function StackParse({
  stack,
  rest,
  action,
  detail,
  highlight,
  topRight,
}: {
  stack: string[]
  rest: string[]
  action: Ll1Step['action']
  detail: string
  highlight?: boolean
  topRight?: boolean
}) {
  const shown = topRight ? stack : [...stack].reverse()
  return (
    <div className="ll-config">
      <div className="lr-col">
        <span className="lr-cap">stack {topRight ? '(top →)' : ''}</span>
        <div className="lr-row">
          {shown.map((x, i) => (
            <span key={i} className={`lr-cell sym${topRight && i === shown.length - 1 ? ' next' : ''}`}>
              {tk(x)}
            </span>
          ))}
        </div>
      </div>
      <div className="lr-col grow">
        <span className="lr-cap">input</span>
        <div className="lr-row input">
          {rest.map((x, i) => (
            <span key={i} className={`lr-cell in${i === 0 ? ' next' : ''}`}>
              {tk(x)}
            </span>
          ))}
        </div>
      </div>
      <div className={`action-line ${action}${highlight ? ' amb' : ''}`}>
        <span className="action-kind">{action}</span>
        {detail}
      </div>
    </div>
  )
}

function Stepper({ s, max, set }: { s: number; max: number; set: (n: number) => void }) {
  return (
    <div className="stepper">
      <button onClick={() => set(0)} disabled={s === 0}>
        ⏮
      </button>
      <button onClick={() => set(Math.max(0, s - 1))} disabled={s === 0}>
        ◀
      </button>
      <span className="step-count">
        step {s + 1} / {max + 1}
      </span>
      <button onClick={() => set(Math.min(max, s + 1))} disabled={s >= max}>
        ▶
      </button>
      <button onClick={() => set(max)} disabled={s >= max}>
        ⏭
      </button>
    </div>
  )
}
