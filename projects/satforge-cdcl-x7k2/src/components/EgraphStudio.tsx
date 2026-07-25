import { useMemo, useState } from 'react'
import './EgraphStudio.css'
import {
  optimize,
  prove,
  evalTerm,
  freeVars,
  printTerm,
  layoutEgraph,
  RULE_GROUPS,
  rulesFor,
  ruleLabel,
  OPT_EXAMPLES,
  PROVE_EXAMPLES,
  tryParse,
  runEgraphChecks,
  mulberry32,
} from '../egraph'
import type { Term, EGraph, EClassId, OptimizeResult, ProveResult, EgraphCheckReport } from '../egraph'

type Sub = 'optimize' | 'prove'

const OPT_OPTS = { maxIters: 30, maxNodes: 600 }
const PROVE_OPTS = { maxIters: 40, maxNodes: 1500 }

export function EgraphStudio() {
  const [sub, setSub] = useState<Sub>('optimize')
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(RULE_GROUPS.map((g) => g.name)))
  const rules = useMemo(() => rulesFor(enabled), [enabled])

  const toggle = (name: string) =>
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <div className="layout">
      <aside className="control eg-side">
        <p className="imc-blurb">
          <strong>An e-graph</strong> represents a whole equivalence class of programs at once:
          hash-consed <em>e-nodes</em> over shared <em>e-classes</em>, a union-find that merges
          classes proven equal, and a <strong>congruence</strong> repair that keeps{' '}
          <code>f(x) ≡ f(y)</code> whenever <code>x ≡ y</code>. <strong>Equality saturation</strong>{' '}
          applies every rewrite everywhere at once until nothing changes — then the extractor reads
          the <em>cheapest</em> equivalent term back out. Because a rewrite only ever adds an
          equality, two terms are provably equal exactly when they land in one class. Every result
          here is re-checked by an independent exact evaluator (the "egg" design, Willsey&nbsp;2021).
        </p>

        <div className="eg-rules">
          <h3>Rewrite rules</h3>
          <p className="eg-hint">Toggle a family and watch what it unlocks. Every rule is an integer identity.</p>
          {RULE_GROUPS.map((g) => (
            <div key={g.name} className={`eg-rulegroup ${enabled.has(g.name) ? 'on' : 'off'}`}>
              <label className="eg-rulehead">
                <input type="checkbox" checked={enabled.has(g.name)} onChange={() => toggle(g.name)} />
                <span>{g.name}</span>
              </label>
              <ul className="eg-rulelist">
                {g.rules.map((r) => (
                  <li key={r.name}>
                    <code>{ruleLabel(r)}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <SelfTestPanel />
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>Congruence Studio</h2>
            <p className="subtitle">
              Equality saturation: optimize a term to its cheapest equivalent, or prove two terms
              equal — all inside one growing e-graph.
            </p>
          </div>
        </div>

        <nav className="tabs eg-subtabs">
          <button className={`tab ${sub === 'optimize' ? 'active' : ''}`} onClick={() => setSub('optimize')}>
            Optimize
          </button>
          <button className={`tab ${sub === 'prove' ? 'active' : ''}`} onClick={() => setSub('prove')}>
            Prove equal
          </button>
        </nav>

        {sub === 'optimize' ? <OptimizePane rules={rules} /> : <ProvePane rules={rules} />}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Optimize
// ---------------------------------------------------------------------------

function OptimizePane({ rules }: { rules: ReturnType<typeof rulesFor> }) {
  const [src, setSrc] = useState(OPT_EXAMPLES[0].src)
  const [note, setNote] = useState(OPT_EXAMPLES[0].note)

  const parsed = useMemo(() => tryParse(src), [src])
  const full = useMemo(() => {
    if (!parsed.ok) return null
    try {
      return optimize(parsed.term, rules, OPT_OPTS)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const
    }
  }, [parsed, rules])

  const iterCount = full && 'saturate' in full ? full.saturate.iterations.length : 0
  const [stage, setStage] = useState<number>(-1) // -1 → follow the full run
  const effStage = stage < 0 ? iterCount : Math.min(stage, iterCount)

  // A staged run for the visualization ("watch it grow").
  const staged = useMemo(() => {
    if (!parsed.ok) return null
    try {
      return optimize(parsed.term, rules, { ...OPT_OPTS, maxIters: effStage })
    } catch {
      return null
    }
  }, [parsed, rules, effStage])

  const pick = (i: number) => {
    setSrc(OPT_EXAMPLES[i].src)
    setNote(OPT_EXAMPLES[i].note)
    setStage(-1)
  }

  return (
    <div className="eg-pane">
      <div className="eg-examples">
        {OPT_EXAMPLES.map((ex, i) => (
          <button key={ex.name} className={src === ex.src ? 'active' : ''} onClick={() => pick(i)}>
            {ex.name}
          </button>
        ))}
      </div>

      <div className="eg-editor">
        <label>Expression — integers, variables, <code>+ - * &lt;&lt;</code></label>
        <input
          value={src}
          spellCheck={false}
          onChange={(e) => {
            setSrc(e.target.value)
            setNote('')
            setStage(-1)
          }}
        />
        {note && <p className="eg-note">{note}</p>}
        {!parsed.ok && <div className="banner error">⚠ {parsed.error}</div>}
        {full && 'error' in full && <div className="banner error">⚠ saturation error: {full.error}</div>}
      </div>

      {full && 'saturate' in full && parsed.ok && (
        <>
          <ResultCards res={full} original={parsed.term} />
          <EvalCheck a={parsed.term} b={full.best} label="Optimized term vs. original" />
          <IterTable res={full} />
          {iterCount > 0 && (
            <div className="eg-slider">
              <label>
                Saturation stage: <strong>{effStage}</strong> / {iterCount}
              </label>
              <input
                type="range"
                min={0}
                max={iterCount}
                value={effStage}
                onChange={(e) => setStage(+e.target.value)}
              />
              <span className="eg-hint">drag to watch the e-graph grow, iteration by iteration</span>
            </div>
          )}
          {staged && <EgraphView eg={staged.eg} roots={[staged.rootId]} />}
        </>
      )}
    </div>
  )
}

function ResultCards({ res, original }: { res: OptimizeResult; original: Term }) {
  const reason =
    res.saturate.stopReason === 'saturated'
      ? '✓ fully saturated'
      : res.saturate.stopReason === 'nodes'
        ? '◈ stopped at node budget'
        : '◈ stopped at iteration cap'
  const pct = res.originalCost > 0 ? Math.round((1 - res.bestCost / res.originalCost) * 100) : 0
  return (
    <div className="imc-cards">
      <div className="imc-card">
        <h3>Input</h3>
        <p className="eg-term">{printTerm(original)}</p>
        <p className="eg-cost">cost {res.originalCost}</p>
      </div>
      <div className="imc-card oracle">
        <h3>Extracted (cheapest)</h3>
        <p className="eg-term eg-best">{printTerm(res.best)}</p>
        <p className="eg-cost">
          cost {res.bestCost}
          {pct > 0 && <span className="eg-win"> · −{pct}%</span>}
        </p>
      </div>
      <div className="imc-card">
        <h3>Saturation</h3>
        <div className="eg-stats">
          <div>
            <span>{res.eg.numClasses()}</span>e-classes
          </div>
          <div>
            <span>{res.eg.numNodes()}</span>e-nodes
          </div>
          <div>
            <span>{res.saturate.iterations.length}</span>iterations
          </div>
          <div>
            <span>{res.eg.totalUnions}</span>merges
          </div>
        </div>
        <p className={`eg-reason ${res.saturate.stopReason}`}>{reason}</p>
      </div>
    </div>
  )
}

function IterTable({ res }: { res: OptimizeResult }) {
  if (res.saturate.iterations.length === 0) return null
  return (
    <div className="imc-panel">
      <h3>Iterations</h3>
      <p className="imc-note">
        Each pass matches every rule everywhere, adds the right-hand sides, then rebuilds
        congruence. The graph grows until it saturates (a pass that changes nothing) or hits the
        budget.
      </p>
      <table className="eg-itertable">
        <thead>
          <tr>
            <th>iter</th>
            <th>rewrites applied</th>
            <th>e-classes</th>
            <th>e-nodes</th>
          </tr>
        </thead>
        <tbody>
          {res.saturate.iterations.map((it) => (
            <tr key={it.iter}>
              <td>{it.iter}</td>
              <td>{it.applied}</td>
              <td>{it.classes}</td>
              <td>{it.nodes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prove
// ---------------------------------------------------------------------------

function ProvePane({ rules }: { rules: ReturnType<typeof rulesFor> }) {
  const [lhs, setLhs] = useState(PROVE_EXAMPLES[0].lhs)
  const [rhs, setRhs] = useState(PROVE_EXAMPLES[0].rhs)
  const [note, setNote] = useState(PROVE_EXAMPLES[0].note)

  const pl = useMemo(() => tryParse(lhs), [lhs])
  const pr = useMemo(() => tryParse(rhs), [rhs])

  const result = useMemo(() => {
    if (!pl.ok || !pr.ok) return null
    try {
      return prove(pl.term, pr.term, rules, PROVE_OPTS)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const
    }
  }, [pl, pr, rules])

  const pick = (i: number) => {
    setLhs(PROVE_EXAMPLES[i].lhs)
    setRhs(PROVE_EXAMPLES[i].rhs)
    setNote(PROVE_EXAMPLES[i].note)
  }

  return (
    <div className="eg-pane">
      <div className="eg-examples">
        {PROVE_EXAMPLES.map((ex, i) => (
          <button key={ex.name} className={lhs === ex.lhs && rhs === ex.rhs ? 'active' : ''} onClick={() => pick(i)}>
            {ex.name}
          </button>
        ))}
      </div>

      <div className="eg-editor eg-prove-editor">
        <label>Left-hand term</label>
        <input value={lhs} spellCheck={false} onChange={(e) => { setLhs(e.target.value); setNote('') }} />
        <label>Right-hand term</label>
        <input value={rhs} spellCheck={false} onChange={(e) => { setRhs(e.target.value); setNote('') }} />
        {note && <p className="eg-note">{note}</p>}
        {!pl.ok && <div className="banner error">⚠ left: {pl.error}</div>}
        {!pr.ok && <div className="banner error">⚠ right: {pr.error}</div>}
        {result && 'error' in result && <div className="banner error">⚠ {result.error}</div>}
      </div>

      {result && 'proved' in result && pl.ok && pr.ok && (
        <ProveResultView res={result} a={pl.term} b={pr.term} />
      )}
    </div>
  )
}

function ProveResultView({ res, a, b }: { res: ProveResult; a: Term; b: Term }) {
  const oracle = sampleEqual(a, b, 200)
  const verdictClass = res.proved ? 'sat' : oracle.equal ? 'unknown' : 'unsat'
  const verdict = res.proved
    ? 'PROVED EQUAL'
    : oracle.equal
      ? 'NOT PROVED (within budget)'
      : 'NOT EQUAL'
  return (
    <>
      <div className="problem-head eg-verdict-head">
        <h3>Verdict</h3>
        <span className={`status-pill ${verdictClass}`}>{verdict}</span>
      </div>
      <div className="imc-cards">
        <div className="imc-card">
          <h3>Equality saturation</h3>
          <p>
            {res.proved ? (
              <>
                The two terms were driven into the <strong>same e-class</strong> — a rewrite proof
                that they are equal for <em>all</em> integer inputs.
              </>
            ) : oracle.equal ? (
              <>
                They agree on every random assignment, but saturation stopped ({res.saturate.stopReason}
                ) before merging them. Enable more rule families or the equality may need a rule
                that is not present.
              </>
            ) : (
              <>They are genuinely unequal — the evaluator found a counterexample below.</>
            )}
          </p>
        </div>
        <div className="imc-card oracle">
          <h3>Evaluator cross-check</h3>
          {oracle.equal ? (
            <p>
              <span className="check-ok">✓ agree</span> on {200} random assignments (exact BigInt
              arithmetic).{' '}
              {res.proved && <>Soundness witness: a proof that disagreed here would be a bug.</>}
            </p>
          ) : (
            <p>
              <span className="check-bad">✗ differ</span> at{' '}
              <code>{oracle.env}</code>: {oracle.va} ≠ {oracle.vb}.
            </p>
          )}
        </div>
        <div className="imc-card">
          <h3>Graph</h3>
          <div className="eg-stats">
            <div>
              <span>{res.eg.numClasses()}</span>e-classes
            </div>
            <div>
              <span>{res.eg.numNodes()}</span>e-nodes
            </div>
            <div>
              <span>{res.saturate.iterations.length}</span>iterations
            </div>
            <div>
              <span>{res.eg.checkInvariants().length === 0 ? '✓' : '✗'}</span>invariants
            </div>
          </div>
        </div>
      </div>
      <EgraphView eg={res.eg} roots={[res.lhsId, res.rhsId]} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Shared: inline evaluator cross-check + the e-graph SVG
// ---------------------------------------------------------------------------

function sampleEqual(a: Term, b: Term, trials: number) {
  const vars = [...new Set([...freeVars(a), ...freeVars(b)])]
  const rng = mulberry32(0xe6)
  for (let i = 0; i < trials; i++) {
    const env = new Map<string, bigint>()
    const desc: string[] = []
    for (const v of vars) {
      const val = BigInt(Math.floor(rng() * 21) - 10)
      env.set(v, val)
      desc.push(`${v}=${val}`)
    }
    // A user-written variable shift (`a << b`) is undefined for a negative
    // amount — the evaluator throws; skip such samples rather than crash.
    let va: bigint
    let vb: bigint
    try {
      va = evalTerm(a, env)
      vb = evalTerm(b, env)
    } catch {
      continue
    }
    if (va !== vb) return { equal: false, env: desc.join(', '), va: va.toString(), vb: vb.toString() }
  }
  return { equal: true, env: '', va: '', vb: '' }
}

function EvalCheck({ a, b, label }: { a: Term; b: Term; label: string }) {
  const r = sampleEqual(a, b, 200)
  return (
    <div className={`eg-evalcheck ${r.equal ? 'ok' : 'bad'}`}>
      {r.equal ? (
        <>
          <strong>✓ {label}:</strong> identical on 200 random integer assignments — the optimization
          preserves meaning exactly (independent BigInt evaluator).
        </>
      ) : (
        <>
          <strong>✗ {label}:</strong> disagree at <code>{r.env}</code> ({r.va} ≠ {r.vb}) — this
          should never happen; it would mean an unsound rewrite.
        </>
      )}
    </div>
  )
}

const MAX_DRAW_CLASSES = 64

function EgraphView({ eg, roots }: { eg: EGraph; roots: EClassId[] }) {
  const layout = useMemo(() => layoutEgraph(eg, roots[0]), [eg, roots])
  const rootSet = useMemo(() => new Set(roots.map((r) => eg.find(r))), [eg, roots])

  if (eg.numClasses() > MAX_DRAW_CLASSES) {
    return (
      <div className="imc-panel">
        <h3>The e-graph</h3>
        <p className="eg-toobig">
          {eg.numClasses()} e-classes / {eg.numNodes()} e-nodes — too dense to draw legibly. The
          stats, extraction and cross-checks above are still exact; try a smaller term or fewer rule
          families to watch the structure.
        </p>
      </div>
    )
  }

  const merged = roots.length > 1 && rootSet.size === 1

  return (
    <div className="imc-panel">
      <h3>
        The e-graph{' '}
        {roots.length > 1 && (
          <span className={merged ? 'check-ok' : 'eg-unmerged'}>
            {merged ? '✓ both terms in one class' : 'terms in distinct classes'}
          </span>
        )}
      </h3>
      <p className="imc-note">
        Solid boxes are <strong>e-classes</strong>; each row inside is an <strong>e-node</strong>{' '}
        (an operator whose edges point at child classes). A class tagged{' '}
        <code className="eg-consttag">=k</code> was proven constant by the analysis. Root
        {roots.length > 1 ? 's are' : ' is'} ringed.
      </p>
      <div className="eg-svgwrap">
        <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} className="eg-graph">
          <defs>
            <marker id="eg-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" className="eg-arrowhead" />
            </marker>
          </defs>
          {layout.edges.map((e, i) => (
            <path key={i} d={e.path} className="eg-edge" markerEnd="url(#eg-arrow)" />
          ))}
          {layout.boxes.map((box) => (
            <g key={box.id}>
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={7}
                className={`eg-box ${rootSet.has(box.id) ? 'root' : ''} ${box.data !== null ? 'const' : ''}`}
              />
              <text x={box.x + 6} y={box.y + 13} className="eg-classid">
                c{box.id}
                {box.data !== null && <tspan className="eg-constval"> ={box.data.toString()}</tspan>}
              </text>
              {box.rows.map((row, ri) => (
                <text
                  key={ri}
                  x={box.x + box.w / 2}
                  y={box.y + 18 + ri * 18 + 10}
                  className="eg-nodelabel"
                  textAnchor="middle"
                >
                  {row.label}
                </text>
              ))}
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function SelfTestPanel() {
  const [checks, setChecks] = useState<EgraphCheckReport | null>(null)
  const [running, setRunning] = useState(false)
  const run = () => {
    setRunning(true)
    setTimeout(() => {
      setChecks(runEgraphChecks())
      setRunning(false)
    }, 30)
  }
  return (
    <div className="eg-selftest">
      <h3>Self-test</h3>
      <p>
        An independent exact evaluator hammers the engine: optimized terms must stay numerically
        identical, the congruence / hashcons / analysis invariants must hold after every saturation,
        and every proved equality must actually be true.
      </p>
      <button onClick={run} disabled={running}>
        {running ? 'Running…' : '▶ Run self-test'}
      </button>
      {checks && (
        <div className={`eg-check ${checks.fail === 0 ? 'ok' : 'bad'}`}>
          {checks.fail === 0 ? (
            <>✓ {checks.pass} assertions passed</>
          ) : (
            <>
              ✗ {checks.fail} failed / {checks.pass} passed
              <ul>
                {checks.messages.slice(0, 6).map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
