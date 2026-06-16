import { useState } from 'react'
import { checkSat, parseSmtLib, SmtSyntaxError, SMT_EXAMPLES, smtUnsatCore, formulaToString, type FullSmtResult } from '../smt'
import { parseBv, solveBv, BvSyntaxError, BV_EXAMPLES, type BvResult } from '../smt/bv'

type Example = { name: string; logic: string; blurb: string; expected: 'sat' | 'unsat'; src: string }
const ALL_EXAMPLES: Example[] = [...SMT_EXAMPLES, ...BV_EXAMPLES]

/** QF_BV is decided by a different engine (eager bit-blasting), so route on it. */
function isBvScript(src: string): boolean {
  return /\bQF_BV\b/.test(src) || /\bBitVec\b/.test(src) || /\bbv[a-z]/.test(src)
}

interface RunState {
  smt?: FullSmtResult
  bv?: BvResult
  error?: string
  expected?: 'sat' | 'unsat'
  core?: string[]
}

export function SmtStudio() {
  const [example, setExample] = useState<Example>(ALL_EXAMPLES[0])
  const [src, setSrc] = useState<string>(ALL_EXAMPLES[0].src)
  const [run, setRun] = useState<RunState | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = (ex: Example) => {
    setExample(ex)
    setSrc(ex.src)
    setRun(null)
  }

  const solve = () => {
    setBusy(true)
    setTimeout(() => {
      try {
        if (isBvScript(src)) {
          const script = parseBv(src)
          if (script.assertions.length === 0) {
            setRun({ error: 'No (assert …) commands found.' })
            setBusy(false)
            return
          }
          const bv = solveBv(script, { maxTimeMs: 15000, certify: true })
          setRun({ bv, expected: script.expected })
        } else {
          const script = parseSmtLib(src)
          if (script.assertions.length === 0) {
            setRun({ error: 'No (assert …) commands found.' })
            setBusy(false)
            return
          }
          const smt = checkSat(script.tm, script.tm.and(script.assertions), { maxRounds: 200000 })
          let core: string[] | undefined
          if (smt.status === 'unsat' && script.assertions.length > 1) {
            const idx = smtUnsatCore(script.tm, script.assertions, { maxRounds: 200000 })
            core = idx.map((i) => formulaToString(script.tm, script.assertions[i]))
          }
          setRun({ smt, expected: script.expected, core })
        }
      } catch (e) {
        const msg = e instanceof SmtSyntaxError || e instanceof BvSyntaxError ? `Syntax error: ${e.message}` : String(e)
        setRun({ error: msg })
      }
      setBusy(false)
    }, 10)
  }

  const isBv = isBvScript(src)

  return (
    <div className="smt">
      <aside className="smt-examples">
        <h3>Examples</h3>
        <p className="smt-hint">Pick one, or edit the script and re-check.</p>
        <ul>
          {ALL_EXAMPLES.map((ex) => (
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

        <textarea className="smt-code" spellCheck={false} value={src} onChange={(e) => setSrc(e.target.value)} />

        <section className="smt-result">
          {busy && (
            <div className="placeholder">
              <div className="spinner" />
              <p>{isBv ? 'Bit-blasting → CDCL…' : 'Running DPLL(T)…'}</p>
            </div>
          )}
          {!busy && run?.error && <div className="banner error">⚠ {run.error}</div>}
          {!busy && run?.bv && <BvResultView res={run.bv} expected={run.expected} />}
          {!busy && run?.smt && <SmtResultView result={run.smt} expected={run.expected} core={run.core} />}
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

// ---- QF_BV result -------------------------------------------------------------
function BvResultView({ res, expected }: { res: BvResult; expected?: 'sat' | 'unsat' }) {
  const exp = expected
  const verdictMatches = exp ? res.status === exp : undefined
  return (
    <>
      <div className="smt-verdict-row">
        <div className={`status-pill ${res.status}`}>
          <strong>{res.status.toUpperCase()}</strong>
          <span>{(res.timeMs ?? 0).toFixed(1)} ms</span>
        </div>
        <div className="smt-meta">
          <span className="bv-engine">bit-blasted → CDCL</span>
          <span>
            <b>{res.stats.vars.toLocaleString()}</b> SAT vars
          </span>
          <span>
            <b>{res.stats.clauses.toLocaleString()}</b> clauses
          </span>
          {res.stats.conflicts > 0 && (
            <span>
              <b>{res.stats.conflicts.toLocaleString()}</b> conflicts
            </span>
          )}
          {verdictMatches !== undefined && (
            <span className={verdictMatches ? 'ok' : 'mismatch'}>
              {verdictMatches ? '✓ matches expected' : '✗ expected ' + exp}
            </span>
          )}
        </div>
      </div>

      {res.status === 'sat' && (
        <div className="smt-model">
          <h4>
            Model
            {res.modelVerified && <span className="bv-verified" title="The decoded model was re-checked by an independent BigInt evaluator">✓ re-checked</span>}
          </h4>
          {res.values && res.values.length > 0 ? (
            <table className="bv-model">
              <thead>
                <tr>
                  <th>variable</th>
                  <th>hex</th>
                  <th>binary</th>
                  <th>unsigned</th>
                  <th>signed</th>
                </tr>
              </thead>
              <tbody>
                {res.values.map((v) => (
                  <tr key={v.name}>
                    <td className="bv-name">
                      {v.name}
                      <span className="bv-width">:{v.width}</span>
                    </td>
                    <td className="bv-hex">{v.hex}</td>
                    <td className="bv-bin">{v.bin}</td>
                    <td className="bv-dec">{v.dec}</td>
                    <td className="bv-dec">{v.sdec}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="smt-hint">No bit-vector variables — any assignment to the Booleans works.</p>
          )}
          {res.boolValues && res.boolValues.length > 0 && (
            <ul className="smt-assign">
              {res.boolValues.map((b) => (
                <li key={b.name} className={b.value ? 'true' : 'false'}>
                  <span className="bit">{b.value ? 'T' : 'F'}</span>
                  <code>{b.name}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {res.status === 'unsat' && (
        <div className="smt-lemmas">
          <h4>Why unsatisfiable</h4>
          <p className="smt-hint">
            The whole formula was <em>eagerly bit-blasted</em> into one propositional circuit — every bit-vector
            operation becomes gates and clauses — and the CDCL core refuted that CNF
            {res.stats.conflicts > 0 ? ` after ${res.stats.conflicts.toLocaleString()} conflicts` : ' by unit propagation alone'}.
            Bit-blasting is a <strong>complete</strong> decision procedure for QF_BV, so an unsatisfiable encoding means
            the bit-vector formula is genuinely unsatisfiable — there is no assignment of bits that works.
          </p>
          {res.proof && (
            <p className={`bv-proof ${res.proof.verified ? 'ok' : 'bad'}`}>
              {res.proof.verified ? '✓' : '✗'} DRAT proof {res.proof.verified ? 'verified' : 'NOT verified'} by an
              independent RUP/RAT checker — <b>{res.proof.steps.toLocaleString()}</b> steps
              {' '}(<b>{res.proof.rupSteps.toLocaleString()}</b> RUP, <b>{res.proof.ratSteps.toLocaleString()}</b> RAT)
              {res.proof.truncated ? ' · proof truncated' : ''}, re-deriving the empty clause from the CNF alone.
            </p>
          )}
        </div>
      )}

      {res.status === 'unknown' && (
        <div className="banner warn">The solver could not decide this instance within its budget ({res.message ?? 'limit reached'}).</div>
      )}
    </>
  )
}

// ---- DPLL(T) result (EUF / arithmetic), unchanged -----------------------------
function SmtResultView({ result, expected, core }: { result: FullSmtResult; expected?: 'sat' | 'unsat'; core?: string[] }) {
  const verdictMatches = result && expected ? result.status === expected : undefined
  return (
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
            Terms the solver proved equal. Each colour is one equivalence class closed under congruence (equal arguments ⇒
            equal applications).
          </p>
          <CongruenceGraph classes={result.congruenceClasses} />
        </div>
      )}

      {result.status === 'sat' && (
        <div className="smt-model">
          <h4>Model</h4>
          {(() => {
            const { arrays, rest } = partitionArrayModel(result.model ?? [])
            return (
              <>
                {arrays.length > 0 && <ArrayModelView arrays={arrays} />}
                {rest.length > 0 ? (
                  <ul className="smt-assign">
                    {rest.map((m, i) => (
                      <li key={i}>
                        <code>{m}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  arrays.length === 0 && <p className="smt-hint">Any assignment satisfying the atoms below works.</p>
                )}
              </>
            )
          })()}
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

      {result.status === 'unsat' && core && core.length > 0 && (
        <div className="smt-core">
          <h4>Minimal unsat core</h4>
          <p className="smt-hint">
            The smallest subset of your assertions that is already contradictory — drop any one and it becomes
            satisfiable.
          </p>
          <ul className="smt-assign">
            {core.map((c, i) => (
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
            Each refinement round, a theory rejected the SAT solver's candidate and taught it a <em>theory lemma</em> — a
            fact true in the theory that the Boolean engine didn't know. Together they close every branch.
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
            <p className="smt-hint">The Boolean skeleton alone is contradictory — no theory reasoning was even needed.</p>
          )}
        </div>
      )}

      {result.status === 'unknown' && (
        <div className="banner warn">
          The solver could not decide this instance within its budget ({result.message ?? 'limit reached'}).
        </div>
      )}
    </>
  )
}

// ---- array model view ---------------------------------------------------------
interface ArrayModel {
  name: string
  cells: { index: string; value: string }[]
}

/** Pull `arr[index] = value` model lines into per-array tables; keep the rest. */
function partitionArrayModel(model: string[]): { arrays: ArrayModel[]; rest: string[] } {
  const byName = new Map<string, ArrayModel>()
  const rest: string[] = []
  for (const line of model) {
    // Match a single read: <name>[<index>] = <value>, where name is a bare symbol
    // (so nested a[i][j] / multi-equalities fall through to the plain list).
    const m = /^([A-Za-z_][\w']*)\[([^[\]]+)\]\s*=\s*(.+)$/.exec(line)
    if (!m) {
      rest.push(line)
      continue
    }
    const [, name, index, value] = m
    if (!byName.has(name)) byName.set(name, { name, cells: [] })
    byName.get(name)!.cells.push({ index, value })
  }
  return { arrays: [...byName.values()], rest }
}

function ArrayModelView({ arrays }: { arrays: ArrayModel[] }) {
  return (
    <div className="smt-arrays">
      <p className="smt-hint">
        The array contents the solver committed to — each row is a cell <code>array[index]</code> and the value read
        there.
      </p>
      {arrays.map((arr) => (
        <div key={arr.name} className="smt-array">
          <table className="array-model">
            <thead>
              <tr>
                <th colSpan={2}>
                  <code>{arr.name}</code>
                </th>
              </tr>
            </thead>
            <tbody>
              {arr.cells.map((c, i) => (
                <tr key={i}>
                  <td className="array-idx">
                    <code>[{c.index}]</code>
                  </td>
                  <td className="array-val">
                    <code>{c.value}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

const CLASS_COLORS = ['#6ea8fe', '#9b8cff', '#22c55e', '#f59e0b', '#ef476f', '#2dd4bf', '#e879f9', '#fbbf24']

function CongruenceGraph({ classes }: { classes: string[][] }) {
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
