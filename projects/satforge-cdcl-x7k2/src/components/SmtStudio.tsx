import { useState } from 'react'
import { checkSat, parseSmtLib, SmtSyntaxError, SMT_EXAMPLES, smtUnsatCore, formulaToString, type FullSmtResult } from '../smt'
import type { SmtExample } from '../smt'

interface RunState {
  result?: FullSmtResult
  error?: string
  expected?: 'sat' | 'unsat'
  core?: string[]
}

export function SmtStudio() {
  const [example, setExample] = useState<SmtExample>(SMT_EXAMPLES[0])
  const [src, setSrc] = useState<string>(SMT_EXAMPLES[0].src)
  const [run, setRun] = useState<RunState | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = (ex: SmtExample) => {
    setExample(ex)
    setSrc(ex.src)
    setRun(null)
  }

  const solve = () => {
    setBusy(true)
    // let the spinner paint before the (synchronous) solve
    setTimeout(() => {
      try {
        const script = parseSmtLib(src)
        if (script.assertions.length === 0) {
          setRun({ error: 'No (assert …) commands found.' })
          setBusy(false)
          return
        }
        const result = checkSat(script.tm, script.tm.and(script.assertions), { maxRounds: 200000 })
        let core: string[] | undefined
        if (result.status === 'unsat' && script.assertions.length > 1) {
          const idx = smtUnsatCore(script.tm, script.assertions, { maxRounds: 200000 })
          core = idx.map((i) => formulaToString(script.tm, script.assertions[i]))
        }
        setRun({ result, expected: script.expected, core })
      } catch (e) {
        const msg = e instanceof SmtSyntaxError ? `Syntax error: ${e.message}` : String(e)
        setRun({ error: msg })
      }
      setBusy(false)
    }, 10)
  }

  const result = run?.result
  const expected = run?.expected ?? example.expected
  const verdictMatches = result && expected ? result.status === expected : undefined

  return (
    <div className="smt">
      <aside className="smt-examples">
        <h3>Examples</h3>
        <p className="smt-hint">Pick one, or edit the script and re-check.</p>
        <ul>
          {SMT_EXAMPLES.map((ex) => (
            <li key={ex.name}>
              <button className={ex.name === example.name ? 'active' : ''} onClick={() => pick(ex)}>
                <span className="smt-ex-name">{ex.name}</span>
                <span className={`logic-badge l-${ex.logic.toLowerCase()}`}>{ex.logic}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="smt-main">
        <div className="smt-editor-head">
          <div>
            <h3>{example.name}</h3>
            <p className="subtitle">{example.blurb}</p>
          </div>
          <button className="solve-btn" onClick={solve} disabled={busy}>
            {busy ? 'Checking…' : 'Check sat ▸'}
          </button>
        </div>

        <textarea
          className="smt-code"
          spellCheck={false}
          value={src}
          onChange={(e) => setSrc(e.target.value)}
        />

        <section className="smt-result">
          {busy && (
            <div className="placeholder">
              <div className="spinner" />
              <p>Running DPLL(T)…</p>
            </div>
          )}
          {!busy && run?.error && <div className="banner error">⚠ {run.error}</div>}
          {!busy && result && (
            <>
              <div className="smt-verdict-row">
                <div className={`status-pill ${result.status}`}>
                  <strong>{result.status.toUpperCase()}</strong>
                  <span>{(result.timeMs ?? 0).toFixed(1)} ms</span>
                </div>
                <div className="smt-meta">
                  <span>
                    <b>{result.rounds}</b> refinement round{result.rounds === 1 ? '' : 's'}
                  </span>
                  <span>
                    <b>{result.lemmas.length}</b> theory lemma{result.lemmas.length === 1 ? '' : 's'}
                  </span>
                  {verdictMatches !== undefined && (
                    <span className={verdictMatches ? 'ok' : 'mismatch'}>
                      {verdictMatches ? '✓ matches expected' : '✗ expected ' + expected}
                    </span>
                  )}
                </div>
              </div>

              {result.status === 'sat' && result.congruenceClasses && (
                <div className="smt-model">
                  <h4>Congruence classes</h4>
                  <p className="smt-hint">
                    Terms the solver proved equal. Each colour is one equivalence class closed under
                    congruence (equal arguments ⇒ equal applications).
                  </p>
                  <CongruenceGraph classes={result.congruenceClasses} />
                </div>
              )}

              {result.status === 'sat' && (
                <div className="smt-model">
                  <h4>Model</h4>
                  {result.model && result.model.length > 0 ? (
                    <ul className="smt-assign">
                      {result.model.map((m, i) => (
                        <li key={i}>
                          <code>{m}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="smt-hint">Any assignment satisfying the atoms below works.</p>
                  )}
                  {result.atomList && result.atomList.length > 0 && (
                    <div className="smt-atoms">
                      <h4>Atoms</h4>
                      <ul className="smt-assign">
                        {result.atomList.map((a, i) => (
                          <li key={i} className={a.value ? 'true' : 'false'}>
                            <span className="bit">{a.value ? 'T' : 'F'}</span>
                            <code>{a.name}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {result.status === 'unsat' && run?.core && run.core.length > 0 && (
                <div className="smt-core">
                  <h4>Minimal unsat core</h4>
                  <p className="smt-hint">
                    The smallest subset of your assertions that is already contradictory — drop any one
                    and it becomes satisfiable.
                  </p>
                  <ul className="smt-assign">
                    {run.core.map((c, i) => (
                      <li key={i}>
                        <code>{c}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.status === 'unsat' && (
                <div className="smt-lemmas">
                  <h4>Why unsatisfiable</h4>
                  <p className="smt-hint">
                    Each refinement round, a theory rejected the SAT solver's candidate and taught it a{' '}
                    <em>theory lemma</em> — a fact true in the theory that the Boolean engine didn't know.
                    Together they close every branch.
                  </p>
                  {result.lemmas.length > 0 ? (
                    <ol className="smt-lemma-list">
                      {result.lemmas.slice(0, 40).map((l, i) => (
                        <li key={i}>
                          <code>{l}</code>
                        </li>
                      ))}
                      {result.lemmas.length > 40 && <li>… {result.lemmas.length - 40} more</li>}
                    </ol>
                  ) : (
                    <p className="smt-hint">
                      The Boolean skeleton alone is contradictory — no theory reasoning was even needed.
                    </p>
                  )}
                </div>
              )}

              {result.status === 'unknown' && (
                <div className="banner warn">
                  The solver could not decide this instance within its budget ({result.message ?? 'limit reached'}).
                </div>
              )}
            </>
          )}
          {!busy && !run && (
            <div className="placeholder">
              <p>Press “Check sat” to decide this formula.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

const CLASS_COLORS = ['#6ea8fe', '#9b8cff', '#22c55e', '#f59e0b', '#ef476f', '#2dd4bf', '#e879f9', '#fbbf24']

function CongruenceGraph({ classes }: { classes: string[][] }) {
  // One circle; nodes coloured by class, edges (star) within each class.
  const nodes: { name: string; cls: number }[] = []
  classes.forEach((g, ci) => g.forEach((name) => nodes.push({ name, cls: ci })))
  const n = nodes.length
  const W = 380
  const H = Math.max(220, 60 + n * 14)
  const cx = W / 2
  const cy = H / 2
  const r = Math.min(cx, cy) - 46
  const pos = nodes.map((_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
  // edges: connect each class's members as a star from its first node.
  const edges: [number, number][] = []
  let base = 0
  for (const g of classes) {
    for (let k = 1; k < g.length; k++) edges.push([base, base + k])
    base += g.length
  }
  return (
    <svg className="smt-cc-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="congruence classes">
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={pos[a].x}
          y1={pos[a].y}
          x2={pos[b].x}
          y2={pos[b].y}
          stroke={CLASS_COLORS[nodes[a].cls % CLASS_COLORS.length]}
          strokeWidth={2}
          strokeOpacity={0.55}
        />
      ))}
      {nodes.map((nd, i) => {
        const color = CLASS_COLORS[nd.cls % CLASS_COLORS.length]
        return (
          <g key={i}>
            <circle cx={pos[i].x} cy={pos[i].y} r={6} fill={color} stroke="#0b1020" strokeWidth={1.5} />
            <text
              x={pos[i].x}
              y={pos[i].y - 11}
              textAnchor="middle"
              fontSize={11}
              fill="#e6ecff"
              fontFamily="ui-monospace, monospace"
            >
              {nd.name.length > 12 ? nd.name.slice(0, 11) + '…' : nd.name}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
