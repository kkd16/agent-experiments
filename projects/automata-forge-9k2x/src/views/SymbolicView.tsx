import { useMemo, useState } from 'react'
import { parseCtl } from '../engine/ctl/parser'
import type { Ctl } from '../engine/ctl/formula'
import { showCtl } from '../engine/ctl/formula'
import { totalize, satVector } from '../engine/ctl/modelcheck'
import { parseKripke, kripkeToGraph } from '../engine/ltl/kripke'
import { Bdd } from '../engine/bdd/bdd'
import type { BddId } from '../engine/bdd/bdd'
import { parseBool, varsOf, toBdd, showBool } from '../engine/bdd/bool'
import {
  SymbolicModel,
  symbolicLabel,
  symbolicReachable,
} from '../engine/bdd/symbolic'
import type { SymbolicSub } from '../engine/bdd/symbolic'
import { runSelfTest } from '../engine/bdd/selftest'
import { SYMBOLIC_EXAMPLES } from '../engine/bdd/examples'
import Graph from '../components/Graph'
import BddDiagram from '../components/BddDiagram'
import { Stat } from '../components/Stat'
import './LogicView.css'
import './BranchingView.css'
import './SymbolicView.css'

export type SymbolicTab = 'bdd' | 'relation' | 'check' | 'verify' | 'about'

const TABS: { id: SymbolicTab; label: string }[] = [
  { id: 'bdd', label: 'BDD explorer' },
  { id: 'relation', label: 'Transition relation' },
  { id: 'check', label: 'Symbolic check' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

interface Props {
  formula: string
  onFormula: (s: string) => void
  model: string
  onModel: (s: string) => void
  bool: string
  onBool: (s: string) => void
  tab: SymbolicTab
  onTab: (t: SymbolicTab) => void
}

/** Walk a BDD under a full assignment (index = level) to its terminal. */
function evalBits(m: Bdd, f: BddId, bits: boolean[]): boolean {
  let cur = f
  while (!m.isTerminal(cur)) cur = bits[m.levelOf(cur)] ? m.hi(cur) : m.lo(cur)
  return cur === 1
}

export default function SymbolicView({ formula, onFormula, model, onModel, bool, onBool, tab, onTab }: Props) {
  const pf = useMemo(() => parseCtl(formula), [formula])
  const ast = pf.ok ? pf.formula : null
  const pm = useMemo(() => parseKripke(model), [model])
  const cm = useMemo(() => (pm.model ? totalize(pm.model) : null), [pm])
  const sm = useMemo(() => (cm ? new SymbolicModel(cm) : null), [cm])
  const lab = useMemo(() => (ast && sm ? symbolicLabel(ast, sm) : null), [ast, sm])

  const loadExample = (i: number) => {
    onFormula(SYMBOLIC_EXAMPLES[i].formula)
    onModel(SYMBOLIC_EXAMPLES[i].model)
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
          ) : tab === 'bdd' ? (
            <BddTab bool={bool} onBool={onBool} />
          ) : tab === 'relation' ? (
            <RelationTab sm={sm} pm={pm} />
          ) : !ast ? (
            <div className="empty">
              <div className="parse-error">
                <div className="err-msg">{pf.ok ? 'enter a formula' : `column ${pf.pos + 1}: ${pf.message}`}</div>
              </div>
            </div>
          ) : (
            <CheckTab ast={ast} sm={sm} cm={cm} pm={pm} lab={lab} />
          )}
        </div>
      </main>

      <aside className="rail">
        {tab === 'bdd' ? (
          <section className="panel">
            <h2>Boolean function</h2>
            <p className="panel-sub">
              Any propositional formula over variables — <code>a &amp; b</code>, <code>x -&gt; y</code>,{' '}
              <code>p ⊕ q</code>. The <b>BDD explorer</b> compiles it to a reduced, ordered decision
              diagram and lets you reorder the variables to watch the diagram grow and shrink.
            </p>
            <p className="note small">
              Operators: <code>! ¬</code>, <code>&amp; ∧</code>, <code>| ∨</code>, <code>^ ⊕</code>,{' '}
              <code>-&gt; →</code>, <code>&lt;-&gt; ↔</code>. Constants <code>0 1 ⊤ ⊥</code>.
            </p>
          </section>
        ) : (
          <>
            <section className="panel">
              <h2>CTL formula</h2>
              <p className="panel-sub">
                Path quantifiers <code>E</code>/<code>A</code> + a temporal operator: <code>EX</code>{' '}
                <code>AF</code> <code>EG</code>, or <code>E[p U q]</code>. Checked <b>symbolically</b>,
                on BDDs.
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
                <div className="logic-rendered">{showCtl(ast!)}</div>
              )}
            </section>

            <section className="panel">
              <h2>Kripke model</h2>
              <p className="panel-sub">
                One state per line: <code>name {'{ props }'} -&gt; succ…</code>. <code>init:</code> sets
                the start state(s); <code>#</code> starts a comment.
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
              {sm && pm.model && (
                <div className="statline">
                  <Stat k="S" v={pm.model.states.length} title="states" />
                  <Stat k="bits" v={sm.k} title="state bits (⌈log₂ S⌉)" />
                  <Stat k="vars" v={sm.m.varCount} title="BDD variables (current + next)" />
                  <Stat k="|T|" v={sm.m.nodeCount(sm.T)} title="transition-relation BDD nodes" />
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
                <option value="">load a symbolic model-checking problem ▾</option>
                {SYMBOLIC_EXAMPLES.map((ex, i) => (
                  <option key={i} value={i}>
                    {ex.name}
                  </option>
                ))}
              </select>
              {lab && (
                <div className={`mc-pill ${lab.holds ? 'yes' : 'no'}`}>
                  {lab.holds ? '✓ model satisfies φ' : '✗ counterexample exists'}
                </div>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BDD explorer — a Boolean formula, its ROBDD, and the effect of variable order.
// ---------------------------------------------------------------------------

function mergeOrder(prev: string[], vars: string[]): string[] {
  const kept = prev.filter((v) => vars.includes(v))
  const missing = vars.filter((v) => !kept.includes(v))
  return [...kept, ...missing]
}

function BddTab({ bool, onBool }: { bool: string; onBool: (s: string) => void }) {
  const parse = useMemo(() => parseBool(bool), [bool])
  const ast = parse.ok ? parse.formula : null

  const [order, setOrder] = useState<string[]>(() => (ast ? varsOf(ast) : []))
  const [orderKey, setOrderKey] = useState(bool)
  const [assign, setAssign] = useState<Record<string, boolean>>({})

  // Guarded setState-in-render: reconcile the variable order when the formula changes.
  if (orderKey !== bool) {
    setOrderKey(bool)
    if (ast) setOrder((o) => mergeOrder(o, varsOf(ast)))
  }

  const built = useMemo(() => {
    if (!ast) return null
    const vars = order.length ? order : varsOf(ast)
    const m = new Bdd(vars)
    const level = (name: string) => vars.indexOf(name)
    const f = toBdd(ast, m, level)
    return { m, f, vars }
  }, [ast, order])

  if (!ast) {
    return (
      <div className="pad-scroll bdd-tab">
        <input
          className="sim-input logic-formula"
          value={bool}
          spellCheck={false}
          onChange={(e) => onBool(e.target.value)}
          aria-label="Boolean formula"
        />
        <div className="warn small">column {(parse as { pos: number }).pos + 1}: {(parse as { message: string }).message}</div>
      </div>
    )
  }

  const { m, f, vars } = built!
  const bits = vars.map((v) => assign[v] ?? false)
  const value = evalBits(m, f, bits)
  const nodes = m.nodeCount(f)
  const total = 2 ** vars.length
  const sat = m.satCount(f, vars.length)

  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= order.length) return
    const next = order.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setOrder(next)
  }

  const showTruth = vars.length <= 4

  return (
    <div className="pad-scroll bdd-tab">
      <input
        className="sim-input logic-formula"
        value={bool}
        spellCheck={false}
        onChange={(e) => onBool(e.target.value)}
        aria-label="Boolean formula"
      />
      <div className="logic-rendered">{showBool(ast)}</div>

      <div className="statline bdd-stats">
        <Stat k="nodes" v={nodes} title="internal BDD nodes (the DAG size)" />
        <Stat k="vars" v={vars.length} title="variables" />
        <Stat k="#SAT" v={sat} title="satisfying assignments" />
        <span className="stat" title="fraction of the 2ⁿ boolean space that satisfies f">
          <span className="stat-k">density</span>
          <span className="stat-v">
            {sat}/{total}
          </span>
        </span>
      </div>

      <h3 className="sec-h">Variable order</h3>
      <p className="note small">
        A BDD's size can swing from linear to exponential with the order alone. Reorder the variables and
        watch the <b>node count</b> above move — the diagram is always the <i>same function</i>, just a
        different-sized representation.
      </p>
      <div className="bdd-order">
        {order.map((v, i) => (
          <div key={v} className="bdd-order-chip">
            <button className="ord-btn" disabled={i === 0} onClick={() => move(i, -1)} title="earlier (nearer the root)">
              ◀
            </button>
            <code>{v}</code>
            <button className="ord-btn" disabled={i === order.length - 1} onClick={() => move(i, 1)} title="later">
              ▶
            </button>
          </div>
        ))}
        <button className="chip" onClick={() => setOrder([...order].reverse())} title="reverse the order">
          reverse
        </button>
        <button className="chip" onClick={() => ast && setOrder(varsOf(ast))} title="reset to appearance order">
          appearance order
        </button>
      </div>

      <h3 className="sec-h">The diagram</h3>
      <BddDiagram m={m} roots={[{ id: f, label: 'f' }]} assign={bits} traceRoot={f} />

      <h3 className="sec-h">Try an assignment</h3>
      <p className="note small">
        Toggle the variables to trace the highlighted decision path from the root to a sink — that is
        exactly how a BDD evaluates: one edge per variable, in order.
      </p>
      <div className="bdd-assign">
        {vars.map((v) => (
          <button
            key={v}
            className={`assign-toggle ${assign[v] ? 'on' : 'off'}`}
            onClick={() => setAssign((a) => ({ ...a, [v]: !(a[v] ?? false) }))}
          >
            <code>{v}</code> = {assign[v] ? '1' : '0'}
          </button>
        ))}
        <span className={`assign-result ${value ? 'yes' : 'no'}`}>f = {value ? '1' : '0'}</span>
      </div>

      {showTruth && (
        <>
          <h3 className="sec-h">Truth table</h3>
          <table className="bdd-truth">
            <thead>
              <tr>
                {vars.map((v) => (
                  <th key={v}>{v}</th>
                ))}
                <th className="tt-out">f</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: total }, (_, mask) => {
                const row = vars.map((_, i) => ((mask >> i) & 1) === 1)
                const out = evalBits(m, f, row)
                return (
                  <tr key={mask} className={out ? 'tt-true' : ''}>
                    {row.map((b, i) => (
                      <td key={i}>{b ? 1 : 0}</td>
                    ))}
                    <td className={`tt-out ${out ? 'yes' : 'no'}`}>{out ? 1 : 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transition relation — the symbolic encoding + forward reachability fixpoint.
// ---------------------------------------------------------------------------

function RelationTab({ sm, pm }: { sm: SymbolicModel | null; pm: ReturnType<typeof parseKripke> }) {
  const reach = useMemo(() => (sm ? symbolicReachable(sm) : null), [sm])
  const [round, setRound] = useState<number | null>(null)
  if (!sm || !pm.model || !reach) return <div className="empty">define a valid model on the right.</div>

  const m = sm.m
  const N = 2 ** sm.k
  const relSpace = 2 ** (2 * sm.k)
  const edgeCount = sm.model.succ.reduce((a, e) => a + e.length, 0)
  const activeStates = round !== null && round < reach.chain.length ? reach.chain[round].states : reach.states

  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Symbolic encoding</h3>
      <p className="note">
        A model with <b>{sm.model.n}</b> states is encoded in <b>{sm.k}</b> bit
        {sm.k === 1 ? '' : 's'}. Each state is a valuation of the <i>current</i> bits{' '}
        {sm.curVars.map((lv) => <code key={lv}>{m.vars[lv]}</code>)}; every transition also names the{' '}
        <i>next</i> bits {sm.nextVars.map((lv) => <code key={lv}>{m.vars[lv]}</code>)}. The interleaved
        order <code>s₀ s₀′ s₁ s₁′ …</code> keeps the relation's BDD small.
      </p>

      <div className="cmp-grid">
        <div className="cmp-cell">
          <div className="cmp-num">{m.nodeCount(sm.T)}</div>
          <div className="cmp-lab">BDD nodes for T(s, s′)</div>
        </div>
        <div className="cmp-cell">
          <div className="cmp-num">{edgeCount}</div>
          <div className="cmp-lab">explicit edges</div>
        </div>
        <div className="cmp-cell muted-cell">
          <div className="cmp-num">{relSpace.toLocaleString()}</div>
          <div className="cmp-lab">rows in the naïve 2^2ᵏ relation table</div>
        </div>
      </div>
      <p className="note small">
        The transition relation is one BDD over all {2 * sm.k} variables — never the full{' '}
        {relSpace.toLocaleString()}-row table. That gap is the entire reason symbolic model checking
        scales: the <i>set</i> is huge, its <i>BDD</i> is not.
      </p>

      {m.nodeCount(sm.T) <= 120 ? (
        <>
          <h3 className="sec-h">T(s, s′) as a BDD</h3>
          <BddDiagram m={m} roots={[{ id: sm.T, label: 'T' }]} />
        </>
      ) : null}

      <h3 className="sec-h">Symbolic reachability</h3>
      <p className="note">
        The reachable state set is the least fixpoint <code>μZ. init ∨ post∃(Z)</code> — grow the frontier
        one image at a time until it stops. Each approximant is itself a BDD; scrub the rounds to watch the
        set (and its node count) expand to a fixed point.
      </p>
      <div className="approx">
        <div className="approx-head">
          <b>μ (least) fixpoint</b> — {reach.chain.length} approximant{reach.chain.length === 1 ? '' : 's'};{' '}
          <b>{reach.states.length}</b> of {sm.model.n} states reachable ({N} bit-patterns available).
        </div>
        <div className="approx-strip">
          <button className={`approx-cell${round === null ? ' cur' : ''}`} onClick={() => setRound(null)}>
            final
          </button>
          {reach.chain.map((z, i) => (
            <button
              key={i}
              className={`approx-cell${round === i ? ' cur' : ''}`}
              onClick={() => setRound(i)}
              title={`${z.states.length} states, ${z.nodes} BDD nodes`}
            >
              Z{i}
              <span className="approx-size">{z.states.length}</span>
            </button>
          ))}
        </div>
        <div className="approx-detail">
          {round !== null ? (
            <>
              Z{round}: {activeStates.length ? activeStates.map((i) => sm.model.names[i]).join(', ') : <i>∅</i>} —{' '}
              {reach.chain[round].nodes} BDD nodes
            </>
          ) : (
            <>
              reachable: {reach.states.map((i) => sm.model.names[i]).join(', ')}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Symbolic check — the verdict, live agreement with the explicit checker, per-sub BDDs.
// ---------------------------------------------------------------------------

function CheckTab({
  ast,
  sm,
  cm,
  pm,
  lab,
}: {
  ast: Ctl
  sm: SymbolicModel | null
  cm: ReturnType<typeof totalize> | null
  pm: ReturnType<typeof parseKripke>
  lab: ReturnType<typeof symbolicLabel> | null
}) {
  const graph = useMemo(() => (pm.model ? kripkeToGraph(pm.model) : null), [pm])
  const [selKey, setSelKey] = useState<string | null>(null)
  const [round, setRound] = useState<number | null>(null)

  const explicitAgree = useMemo(() => {
    if (!cm || !lab || !sm) return null
    const explicit = satVector(ast, cm)
    const symSet = new Set(sm.decode(lab.top))
    return explicit.every((v, i) => v === symSet.has(i))
  }, [ast, cm, lab, sm])

  const subs = lab?.subs ?? []
  const topKey = subs.length ? subs[subs.length - 1].key : null
  const activeKey = selKey ?? topKey
  const sel = subs.find((s) => s.key === activeKey) ?? null

  const [lastSel, setLastSel] = useState(activeKey)
  if (lastSel !== activeKey) {
    setLastSel(activeKey)
    setRound(null)
  }

  if (!sm || !cm || !pm.model || !graph || !lab || !sel) {
    return <div className="empty">define a valid model and formula to run the symbolic check.</div>
  }

  const highlight =
    sel.approx && round !== null && round < sel.approx.length ? sel.approx[round].states : sel.sat

  return (
    <div className="check-wrap">
      <div className={`mc-banner ${lab.holds ? 'yes' : 'no'}`}>
        {lab.holds ? (
          <>
            <span className="mc-icon">✓</span> The model satisfies <code>{showCtl(ast)}</code> — every
            initial state is in the symbolic <code>Sat(φ)</code>.
          </>
        ) : (
          <>
            <span className="mc-icon">✗</span> The model <b>violates</b> <code>{showCtl(ast)}</code> — some
            initial state is outside <code>Sat(φ)</code>.
          </>
        )}
      </div>

      <div className="init-verdicts">
        {lab.initialVerdict.map((v) => (
          <span key={v.state} className={`verdict-chip ${v.holds ? 'yes' : 'no'}`}>
            {sm.model.names[v.state]} {v.holds ? '⊨' : '⊭'} φ
          </span>
        ))}
        {explicitAgree !== null && (
          <span className={`verdict-chip ${explicitAgree ? 'yes' : 'no'}`} title="the symbolic Sat set is decoded and compared against the explicit boolean-array checker, live, for this exact model">
            {explicitAgree ? '✓ matches the explicit checker, state-for-state' : '✗ disagrees with the explicit checker'}
          </span>
        )}
      </div>

      <div className="label-wrap">
        <div className="label-graph">
          <Graph
            graph={graph}
            highlight={highlight}
            fitKey={`sym:${pm.model.states.map((s) => s.name).join()}`}
            exportName="kripke-model"
          />
          <p className="note small">
            Highlighted states are <code>Sat({sel.text})</code>, decoded from its BDD.{' '}
            {sel.approx && round !== null ? (
              <>
                Showing approximant <b>Z{round}</b> ({sel.approx[round].nodes} BDD nodes) of the{' '}
                {sel.fixpoint} fixpoint.
              </>
            ) : (
              'Pick a subformula, then scrub a fixpoint to watch its BDD converge.'
            )}
          </p>
          {sel.approx && (
            <div className="approx">
              <div className="approx-head">
                <b>{sel.fixpoint === 'least' ? 'μ (least)' : 'ν (greatest)'} fixpoint</b> — BDD node
                counts per round:
              </div>
              <div className="approx-strip">
                <button className={`approx-cell${round === null ? ' cur' : ''}`} onClick={() => setRound(null)}>
                  final
                </button>
                {sel.approx.map((z, i) => (
                  <button
                    key={i}
                    className={`approx-cell${round === i ? ' cur' : ''}`}
                    onClick={() => setRound(i)}
                    title={`${z.states.length} states, ${z.nodes} BDD nodes`}
                  >
                    Z{i}
                    <span className="approx-size">{z.nodes}n</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="bdd-satdiagram">
            <BddDiagram m={sm.m} roots={[{ id: sel.bdd, label: 'Sat' }]} />
          </div>
        </div>

        <div className="label-side">
          <h3 className="sec-h">Subformulas</h3>
          <p className="note small">
            Each <code>Sat(ψ)</code> is a BDD, computed bottom-up. The count is its <b>node size</b> — the
            symbolic cost. Click to light up its states and show its diagram.
          </p>
          <ul className="sub-list">
            {subs.map((s: SymbolicSub) => (
              <li
                key={s.key}
                className={`sub-row${s.key === activeKey ? ' active' : ''}`}
                onClick={() => setSelKey(s.key)}
              >
                <code className="sub-text">{s.text}</code>
                <span className="sub-meta">
                  {s.fixpoint && <span className={`fix-badge ${s.fixpoint}`}>{s.fixpoint === 'least' ? 'μ' : 'ν'}</span>}
                  <span className="sub-count" title="BDD nodes">
                    {s.nodes}n
                  </span>
                  <span className="sub-count" title="satisfying states">
                    {s.sat.length}/{cm.n}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="sat-states">
            <b>Sat({sel.text})</b> ={' '}
            {sel.sat.length ? sel.sat.map((i) => sm.model.names[i]).join(', ') : <i>∅</i>}
          </div>
          <div className="statline">
            <Stat k="peak" v={lab.peakNodes} title="largest per-subformula BDD" />
            <Stat k="pool" v={sm.m.poolSize} title="total BDD nodes the manager allocated" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Verify — the live differential self-test.
// ---------------------------------------------------------------------------

function VerifyTab() {
  const report = useMemo(() => runSelfTest(), [])
  return (
    <div className="pad-scroll">
      <h3 className="sec-h">Verification suite</h3>
      <p className="note">
        A hand-rolled BDD engine is only trustworthy if it is <b>proven</b>. The headline check is
        differential: the symbolic CTL checker is run against the <b>explicit</b> boolean-array checker of
        the Branching mode over hundreds of random (model, formula) pairs, and the decoded <code>Sat</code>{' '}
        sets must agree at <b>every</b> state. Beneath it: <code>ite</code> against brute-force truth
        tables, the algebra laws by canonical id-equality, <code>satCount</code> against enumeration,
        witness soundness, the quantifier identities, the propositional parser round-trip, and symbolic
        reachability against explicit BFS. All live, in your browser, right now.
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
// About — explicit vs symbolic, why BDDs win, the ordering story.
// ---------------------------------------------------------------------------

function AboutTab() {
  return (
    <div className="pad-scroll about">
      <h3 className="sec-h">Symbolic model checking: sets as formulas, not lists</h3>
      <p className="note">
        The Branching mode checks CTL by storing each <code>Sat(ψ)</code> as an explicit array of states —
        one bit per state. That is perfect for teaching and hopeless at scale: a protocol with 40 boolean
        variables has 2⁴⁰ ≈ a trillion states, and no array is that long. The breakthrough of the 1990s
        (McMillan's <b>SMV</b>, then NuSMV) was to represent every set of states, and the transition
        relation itself, as a <b>Reduced Ordered Binary Decision Diagram</b> — a canonical Boolean-function
        DAG — and to do the whole fixpoint computation with BDD operations. Suddenly 10²⁰ states became
        routine.
      </p>
      <h3 className="sec-h">The same fixpoints, a different representation</h3>
      <p className="note">
        Nothing about the <i>algorithm</i> changes — these are the identical Clarke–Emerson–Sistla
        fixpoints of the Branching mode:
      </p>
      <ul className="about-list">
        <li>
          A <b>set of states</b> becomes a BDD over the state bits; <code>∪ ∩ ¬</code> become BDD{' '}
          <code>or / and / not</code>.
        </li>
        <li>
          The pre-image <code>pre∃(Y)</code> becomes a <b>relational product</b>:{' '}
          <code>∃ s′. T(s,s′) ∧ Y(s′)</code> — conjoin with the transition-relation BDD, then existentially
          quantify away the next-state variables. <code>pre∀</code> is <code>¬pre∃¬</code>.
        </li>
        <li>
          <code>EF</code>/<code>EU</code>/<code>AF</code>/<code>AU</code> are least fixpoints,{' '}
          <code>EG</code>/<code>AG</code>/<code>ER</code>/<code>AR</code> greatest — iterated to
          convergence, where "no change" is a single <b>id comparison</b> because the BDD is canonical.
        </li>
      </ul>
      <p className="note">
        The <b>Symbolic check</b> tab decodes the resulting BDDs back to state names and, for this exact
        model, compares them against the explicit checker — a live proof that the two engines compute the
        same thing.
      </p>
      <h3 className="sec-h">Why order is everything</h3>
      <p className="note">
        The <b>BDD explorer</b> tab is where the one subtlety of BDDs lives. The size of the diagram depends
        entirely on the variable order: <code>(a∧b) ∨ (c∧d) ∨ (e∧f)</code> is a tidy 6-node chain in the
        order <code>a b c d e f</code>, but blows up in the interleaved order <code>a c e b d f</code>.
        Finding a good order is NP-hard in general and the practical heart of every real BDD tool. Reorder
        the variables and watch the node count move — same function, wildly different cost.
      </p>
      <h3 className="sec-h">The lab, from explicit to symbolic</h3>
      <p className="note">
        With the Branching mode (explicit fixpoints) and this one (the identical fixpoints over a
        from-scratch ROBDD engine), the lab now spans both halves of how CTL is actually checked. Every
        piece is hand-written and dependency-free: the unique-table hash-consing, the <code>ite</code>{' '}
        recursion, the relational product, the symbolic reachability, and the differential self-test that
        proves the whole chain against the explicit checker in the Verify tab.
      </p>
    </div>
  )
}
