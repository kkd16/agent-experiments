import { useMemo, useState } from 'react'
import './LtlStudio.css'
import {
  EXAMPLES,
  modelCheck,
  parseKripke,
  parseLtl,
  printLtl,
  runLtlChecks,
  toNnf,
  deadlocks,
} from '../ltl'
import type { Counterexample, Gba, Kripke, LtlCheckReport, ModelCheckResult } from '../ltl'

type Sub = 'model' | 'automaton' | 'check'

interface RunState {
  kripke: Kripke
  result: ModelCheckResult
  formulaPretty: string
  negPretty: string
  deadlocked: number[]
}

interface Outcome {
  run: RunState | null
  error: string | null
}

/** Parse + check; never throws (errors are returned for display). */
function compute(ktext: string, ftext: string): Outcome {
  try {
    const kripke = parseKripke(ktext)
    const phi = parseLtl(ftext)
    const result = modelCheck(kripke, phi)
    return {
      run: {
        kripke,
        result,
        formulaPretty: printLtl(phi),
        negPretty: printLtl(toNnf({ k: 'not', a: phi }, false)),
        deadlocked: deadlocks(kripke),
      },
      error: null,
    }
  } catch (e) {
    return { run: null, error: (e as Error).message }
  }
}

export function LtlStudio() {
  const [kripkeText, setKripkeText] = useState<string>(EXAMPLES[0].kripke)
  const [formulaText, setFormulaText] = useState<string>(EXAMPLES[0].formula)
  const initial = useMemo(() => compute(EXAMPLES[0].kripke, EXAMPLES[0].formula), [])
  const [run, setRun] = useState<RunState | null>(initial.run)
  const [error, setError] = useState<string | null>(initial.error)
  const [sub, setSub] = useState<Sub>('model')
  const [checkReport, setCheckReport] = useState<LtlCheckReport | null>(null)
  const [checking, setChecking] = useState(false)

  const doCheck = (ktext: string, ftext: string) => {
    const out = compute(ktext, ftext)
    setRun(out.run)
    setError(out.error)
  }

  const loadExample = (i: number) => {
    setKripkeText(EXAMPLES[i].kripke)
    setFormulaText(EXAMPLES[i].formula)
    setSub('model')
    doCheck(EXAMPLES[i].kripke, EXAMPLES[i].formula)
  }

  const runSelfCheck = () => {
    setChecking(true)
    setSub('check')
    // Defer so the "running…" state paints before the (synchronous) sweep.
    setTimeout(() => {
      setCheckReport(runLtlChecks())
      setChecking(false)
    }, 20)
  }

  return (
    <div className="layout">
      <aside className="control ltl-side">
        <p className="imc-blurb">
          <strong>Explicit-state LTL model checking.</strong> Give a finite-state <em>Kripke structure</em> and a{' '}
          <strong>Linear Temporal Logic</strong> specification; the checker decides whether <em>every</em> run of the
          system satisfies it. It compiles <code>¬φ</code> into a <strong>Büchi automaton</strong> (the GPVW tableau),
          takes the synchronous product with the system, and tests <strong>emptiness by nested DFS</strong>. An empty
          product proves the property; otherwise it returns a concrete <strong>counterexample lasso</strong> — a stem
          plus an infinitely repeated loop — every one re-checked by an independent word-level LTL oracle.
        </p>

        <div className="ltl-field">
          <label htmlFor="ltl-formula">LTL specification</label>
          <input
            id="ltl-formula"
            className="ltl-input"
            value={formulaText}
            spellCheck={false}
            onChange={(e) => setFormulaText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doCheck(kripkeText, formulaText)
            }}
          />
          <p className="ltl-hint">
            Ops: <code>! &amp; | -&gt; &lt;-&gt;</code> · <code>X</code> next · <code>F</code> eventually ·{' '}
            <code>G</code> globally · <code>U</code> until · <code>R</code> release · <code>W</code> weak-until
          </p>
        </div>

        <div className="ltl-field">
          <label htmlFor="ltl-kripke">Kripke structure</label>
          <textarea
            id="ltl-kripke"
            className="ltl-textarea"
            value={kripkeText}
            spellCheck={false}
            rows={9}
            onChange={(e) => setKripkeText(e.target.value)}
          />
          <p className="ltl-hint">
            <code>state s [a, b] init</code> declares a state (atoms are TRUE there); <code>s -&gt; t, u</code> adds
            transitions.
          </p>
        </div>

        <button className="ltl-run" onClick={() => doCheck(kripkeText, formulaText)}>
          ▶ Check property
        </button>

        <div className="ltl-examples">
          <h3>Examples</h3>
          {EXAMPLES.map((ex, i) => (
            <button key={ex.name} className="ltl-example" onClick={() => loadExample(i)}>
              <span className="ltl-ex-name">{ex.name}</span>
              <span className={`ltl-ex-verdict ${ex.holds ? 'holds' : 'fails'}`}>{ex.holds ? 'holds' : 'fails'}</span>
            </button>
          ))}
        </div>

        <div className="ltl-selftest">
          <h3>Verification</h3>
          <button onClick={runSelfCheck} disabled={checking}>
            {checking ? 'Running…' : 'Run self-check'}
          </button>
          {checkReport && (
            <p className={`ltl-selftest-res ${checkReport.fail === 0 ? 'ok' : 'bad'}`}>
              {checkReport.pass} passed, {checkReport.fail} failed
            </p>
          )}
        </div>
      </aside>

      <main className="content ltl-main">
        {error && <div className="banner error">⚠ {error}</div>}

        {run && (
          <>
            <div className="ltl-verdict-row">
              <VerdictPill holds={run.result.holds} />
              <div className="ltl-formula-echo">
                <code>{run.formulaPretty}</code>
              </div>
            </div>

            {run.deadlocked.length > 0 && (
              <div className="banner warn">
                Deadlock: state{run.deadlocked.length > 1 ? 's' : ''}{' '}
                {run.deadlocked.map((d) => run.kripke.states[d].name).join(', ')} ha
                {run.deadlocked.length > 1 ? 've' : 's'} no successor. LTL is a logic of <em>infinite</em> runs; states
                without a successor start no run and are effectively ignored.
              </div>
            )}

            <nav className="tabs ltl-tabs">
              <button className={`tab ${sub === 'model' ? 'active' : ''}`} onClick={() => setSub('model')}>
                Model &amp; counterexample
              </button>
              <button className={`tab ${sub === 'automaton' ? 'active' : ''}`} onClick={() => setSub('automaton')}>
                Büchi automaton
              </button>
              <button className={`tab ${sub === 'check' ? 'active' : ''}`} onClick={() => setSub('check')}>
                Self-check
              </button>
            </nav>

            {sub === 'model' && <ModelView run={run} />}
            {sub === 'automaton' && <AutomatonView gba={run.result.gba} negPretty={run.negPretty} stats={run.result.stats} />}
            {sub === 'check' && <CheckView report={checkReport} checking={checking} onRun={runSelfCheck} />}
          </>
        )}
      </main>
    </div>
  )
}

function VerdictPill({ holds }: { holds: boolean }) {
  return (
    <div className={`ltl-verdict ${holds ? 'holds' : 'fails'}`}>
      <strong>{holds ? 'HOLDS' : 'VIOLATED'}</strong>
      <span>{holds ? 'every run satisfies φ' : 'a run violates φ'}</span>
    </div>
  )
}

// ── Model + counterexample view ──────────────────────────────────────────────

function ModelView({ run }: { run: RunState }) {
  const { kripke, result } = run
  const cex = result.counterexample

  const edgeKinds = useMemo(() => kripkeEdgeKinds(cex), [cex])

  return (
    <section className="view ltl-view">
      <div className="ltl-panel">
        <h3>System K</h3>
        <GraphSvg
          nodes={kripke.states.map((s) => ({
            id: s.id,
            title: s.name,
            sub: '{' + s.labels.join(',') + '}',
            initial: kripke.init.includes(s.id),
            highlight: cex ? new Set([...cex.stem, ...cex.loop]).has(s.id) : false,
          }))}
          edges={kripke.states.flatMap((s) => kripke.edges[s.id].map((t) => ({ from: s.id, to: t, cls: edgeKinds.get(s.id + '->' + t) })))}
        />
      </div>

      <div className="ltl-panel">
        {result.holds ? (
          <div className="ltl-proof">
            <h3>Why it holds</h3>
            <p>
              The product of the system with the Büchi automaton for <code>¬φ</code> has{' '}
              <strong>{result.stats.productStates}</strong> reachable state
              {result.stats.productStates === 1 ? '' : 's'} and <strong>no reachable accepting cycle</strong> — the
              nested DFS explored {result.stats.outerVisited} state{result.stats.outerVisited === 1 ? '' : 's'} and found
              none. No run of the system can satisfy <code>¬φ</code>, so every run satisfies <code>φ</code>. ∎
            </p>
          </div>
        ) : cex ? (
          <div className="ltl-cex">
            <h3>Counterexample run</h3>
            <p className="ltl-cex-desc">
              An accepting lasso in the product projects to this ultimately-periodic run of the system, which satisfies{' '}
              <code>¬φ</code>. It repeats the looped block forever.
            </p>
            <LassoTrace kripke={kripke} cex={cex} />
          </div>
        ) : (
          <p>Property fails but no counterexample could be extracted.</p>
        )}

        <div className="ltl-stats">
          <h3>Pipeline</h3>
          <div className="ltl-stat-grid">
            <Stat label="Büchi states" v={result.stats.buchiStates} />
            <Stat label="Büchi edges" v={result.stats.buchiEdges} />
            <Stat label="Accept. sets" v={result.stats.buchiAcceptSets} />
            <Stat label="Degen. copies" v={result.stats.productCopies} />
            <Stat label="Product states" v={result.stats.productStates} />
            <Stat label="Product edges" v={result.stats.productEdges} />
            <Stat label="Outer DFS" v={result.stats.outerVisited} />
            <Stat label="Inner DFS" v={result.stats.innerVisited} />
          </div>
        </div>
      </div>
    </section>
  )
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="ltl-stat">
      <span className="ltl-stat-v">{v}</span>
      <span className="ltl-stat-l">{label}</span>
    </div>
  )
}

function LassoTrace({ kripke, cex }: { kripke: Kripke; cex: Counterexample }) {
  const cell = (id: number, key: string, kind: string) => (
    <div key={key} className={`ltl-trace-cell ${kind}`}>
      <span className="ltl-trace-name">{kripke.states[id].name}</span>
      <span className="ltl-trace-label">{'{' + kripke.states[id].labels.join(',') + '}'}</span>
    </div>
  )
  return (
    <div className="ltl-trace">
      {cex.stem.map((id, i) => cell(id, 'stem' + i, 'stem'))}
      <div className="ltl-loop-wrap">
        <span className="ltl-loop-tag">loop&nbsp;∞</span>
        <div className="ltl-loop-cells">{cex.loop.map((id, i) => cell(id, 'loop' + i, 'loop'))}</div>
      </div>
    </div>
  )
}

// ── Büchi automaton view ─────────────────────────────────────────────────────

function AutomatonView({ gba, negPretty, stats }: { gba: Gba; negPretty: string; stats: ModelCheckResult['stats'] }) {
  const acceptOf = useMemo(() => {
    const m = new Map<number, number[]>()
    gba.accept.forEach((set, si) => {
      for (const q of set) {
        const arr = m.get(q) ?? []
        arr.push(si)
        m.set(q, arr)
      }
    })
    return m
  }, [gba])

  return (
    <section className="view ltl-view">
      <div className="ltl-panel">
        <h3>
          B(¬φ) &nbsp;<span className="ltl-neg">¬φ ≡ {negPretty}</span>
        </h3>
        <p className="ltl-cex-desc">
          A state-labeled generalized Büchi automaton over 2<sup>AP</sup>: each state's label is the literals the current
          input letter must satisfy to enter it. A run is accepting iff it visits every acceptance set infinitely often —
          this forces each <code>U</code> eventuality to be met. {stats.buchiAcceptSets === 0 ? 'This formula has no eventualities, so every run is accepting.' : `There ${stats.buchiAcceptSets === 1 ? 'is 1 acceptance set' : `are ${stats.buchiAcceptSets} acceptance sets`}.`}
        </p>
        <GraphSvg
          nodes={gba.states.map((s) => {
            const lits = [...s.pos, ...s.neg.map((n) => '¬' + n)]
            return {
              id: s.id,
              title: 'q' + s.id,
              sub: lits.length ? lits.join(',') : '⊤',
              initial: gba.initial.includes(s.id),
              accepting: acceptOf.has(s.id),
            }
          })}
          edges={gba.states.flatMap((s) => gba.edges[s.id].map((t) => ({ from: s.id, to: t })))}
        />
      </div>
      <div className="ltl-panel">
        <div className="ltl-stats">
          <h3>Acceptance sets</h3>
          {gba.accept.length === 0 ? (
            <p className="ltl-cex-desc">None (a safety-style formula — every infinite run is accepting).</p>
          ) : (
            <ul className="ltl-accept-list">
              {gba.accept.map((set, i) => (
                <li key={i}>
                  <span className="ltl-accept-tag">F{sub(i)}</span> = &#123;{set.map((q) => 'q' + q).join(', ') || '∅'}&#125;
                </li>
              ))}
            </ul>
          )}
          <p className="ltl-cex-desc" style={{ marginTop: '0.8rem' }}>
            Degeneralization to an ordinary Büchi automaton uses{' '}
            <strong>{stats.productCopies}</strong> cop{stats.productCopies === 1 ? 'y' : 'ies'} of the product state
            space (one per acceptance set), so nested DFS can hunt for a single accepting cycle.
          </p>
        </div>
      </div>
    </section>
  )
}

function sub(n: number): string {
  return String(n)
    .split('')
    .map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
    .join('')
}

// ── Self-check view ──────────────────────────────────────────────────────────

function CheckView({ report, checking, onRun }: { report: LtlCheckReport | null; checking: boolean; onRun: () => void }) {
  return (
    <section className="view ltl-view ltl-check-view">
      <div className="ltl-panel" style={{ gridColumn: '1 / -1' }}>
        <h3>Cross-check against an independent oracle</h3>
        <p className="ltl-cex-desc">
          Every verdict is refereed by a from-scratch word-level LTL evaluator that shares no code with the automaton.
          The cornerstone: for thousands of random formulas and random lasso words, wrapping the word as a one-path
          Kripke structure must make the full pipeline agree with the direct fixpoint semantics — a decisive test that
          the Büchi construction is both sound and complete. It also round-trips the parser, verifies NNF preserves
          meaning, checks nested DFS against a BFS lasso finder, validates every counterexample as a real violating run,
          and confirms a brute-force enumerator never beats the checker.
        </p>
        {!report && !checking && (
          <button className="ltl-run" onClick={onRun}>
            Run self-check
          </button>
        )}
        {checking && <p className="ltl-selftest-res">Running thousands of randomized cross-checks…</p>}
        {report && (
          <>
            <p className={`ltl-selftest-res big ${report.fail === 0 ? 'ok' : 'bad'}`}>
              {report.fail === 0 ? '✓ ' : '✗ '}
              {report.pass} passed, {report.fail} failed
            </p>
            {report.fail > 0 && (
              <ul className="ltl-fail-list">
                {report.messages.slice(1).map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  )
}

// ── SVG graph renderer (circular layout, curved arrows, self-loops) ───────────

interface GNode {
  id: number
  title: string
  sub?: string
  initial?: boolean
  accepting?: boolean
  highlight?: boolean
}
interface GEdge {
  from: number
  to: number
  cls?: string
}

function GraphSvg({ nodes, edges }: { nodes: GNode[]; edges: GEdge[] }) {
  const n = nodes.length
  const nr = 26
  const R = Math.max(90, n * 26)
  const pad = 70
  const size = 2 * (R + pad)
  const cx = size / 2
  const cy = size / 2

  const pos = new Map<number, { x: number; y: number }>()
  nodes.forEach((nd, i) => {
    if (n === 1) {
      pos.set(nd.id, { x: cx, y: cy })
    } else {
      const a = (2 * Math.PI * i) / n - Math.PI / 2
      pos.set(nd.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) })
    }
  })

  const edgeSet = new Set(edges.map((e) => e.from + '->' + e.to))
  const hasReverse = (e: GEdge) => e.from !== e.to && edgeSet.has(e.to + '->' + e.from)

  const paths = edges.map((e, i) => {
    const p = pos.get(e.from)!
    const q = pos.get(e.to)!
    const cls = 'ltl-edge' + (e.cls ? ' ' + e.cls : '')
    if (e.from === e.to) {
      // self-loop above the node
      const lx = p.x
      const ly = p.y - nr
      const d = `M ${lx - 10} ${ly} C ${lx - 30} ${ly - 46}, ${lx + 30} ${ly - 46}, ${lx + 10} ${ly}`
      return <path key={i} d={d} className={cls} markerEnd={markerFor(e.cls)} fill="none" />
    }
    const dx = q.x - p.x
    const dy = q.y - p.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const sx = p.x + ux * nr
    const sy = p.y + uy * nr
    const ex = q.x - ux * nr
    const ey = q.y - uy * nr
    if (hasReverse(e)) {
      // bow the edge so the two directions don't overlap
      const mx = (sx + ex) / 2 - uy * 26
      const my = (sy + ey) / 2 + ux * 26
      return <path key={i} d={`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`} className={cls} markerEnd={markerFor(e.cls)} fill="none" />
    }
    return <path key={i} d={`M ${sx} ${sy} L ${ex} ${ey}`} className={cls} markerEnd={markerFor(e.cls)} fill="none" />
  })

  return (
    <svg className="ltl-graph" viewBox={`0 0 ${size} ${size}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="ltl-arrowhead" />
        </marker>
        <marker id="arrow-stem" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="ltl-arrowhead stem" />
        </marker>
        <marker id="arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="ltl-arrowhead loop" />
        </marker>
      </defs>
      {paths}
      {nodes.map((nd) => {
        const p = pos.get(nd.id)!
        return (
          <g key={nd.id} className={`ltl-node ${nd.highlight ? 'hl' : ''}`}>
            {nd.initial && <InitArrow x={p.x} y={p.y} nr={nr} cx={cx} cy={cy} />}
            {nd.accepting && <circle cx={p.x} cy={p.y} r={nr + 4} className="ltl-accept-ring" />}
            <circle cx={p.x} cy={p.y} r={nr} className="ltl-node-circle" />
            <text x={p.x} y={p.y - 3} className="ltl-node-title">
              {nd.title}
            </text>
            {nd.sub && (
              <text x={p.x} y={p.y + 11} className="ltl-node-sub">
                {nd.sub}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function InitArrow({ x, y, nr, cx, cy }: { x: number; y: number; nr: number; cx: number; cy: number }) {
  // point inward from outside the circle toward the node
  const dx = x - cx
  const dy = y - cy
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const sx = x + ux * (nr + 24)
  const sy = y + uy * (nr + 24)
  const ex = x + ux * (nr + 3)
  const ey = y + uy * (nr + 3)
  return <path d={`M ${sx} ${sy} L ${ex} ${ey}`} className="ltl-init-arrow" markerEnd="url(#arrow)" fill="none" />
}

function markerFor(cls?: string): string {
  if (cls === 'stem') return 'url(#arrow-stem)'
  if (cls === 'loop') return 'url(#arrow-loop)'
  return 'url(#arrow)'
}

/** Classify each Kripke edge as part of the counterexample stem / loop. */
function kripkeEdgeKinds(cex: Counterexample | null): Map<string, string> {
  const m = new Map<string, string>()
  if (!cex) return m
  const path = [...cex.stem, ...cex.loop]
  for (let i = 0; i + 1 < path.length; i++) {
    const key = path[i] + '->' + path[i + 1]
    m.set(key, i < cex.stem.length ? 'stem' : 'loop')
  }
  if (cex.loop.length > 0) {
    const last = cex.loop[cex.loop.length - 1]
    m.set(last + '->' + cex.loop[0], 'loop')
  }
  return m
}
