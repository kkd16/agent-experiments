import { useMemo, useState } from 'react'
import {
  simplify,
  reconstruct,
  ALL_TECHNIQUES,
  TECHNIQUE_LABEL,
  EXAMPLES,
  runPreprocessChecks,
  type Technique,
  type SimplifyResult,
  type PreprocessCheckReport,
} from '../preprocess'
import { parseDimacs, toDimacs, solve, verifyModel, type CNF } from '../sat'

const DEFAULT_EXAMPLE = 2 // "Variable elimination (gate network)" — BVE shines

function allOn(): Record<Technique, boolean> {
  const r = {} as Record<Technique, boolean>
  for (const t of ALL_TECHNIQUES) r[t] = true
  return r
}

interface RoundTrip {
  status: 'sat' | 'unsat' | 'trivial-sat'
  model?: boolean[]
  verified: boolean
  failingClause: number
}

export function SimplifyStudio() {
  const [exampleIdx, setExampleIdx] = useState(DEFAULT_EXAMPLE)
  const [src, setSrc] = useState<string>(() => toDimacs(EXAMPLES[DEFAULT_EXAMPLE].build()))
  const [dirty, setDirty] = useState(false)
  const [enabled, setEnabled] = useState<Record<Technique, boolean>>(allOn)
  const [checks, setChecks] = useState<PreprocessCheckReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [roundTrip, setRoundTrip] = useState<RoundTrip | null>(null)

  const parsed = useMemo<{ ok: true; cnf: CNF } | { ok: false; error: string }>(() => {
    try {
      return { ok: true, cnf: parseDimacs(src).cnf }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
    }
  }, [src])

  const result = useMemo<SimplifyResult | null>(() => {
    if (!parsed.ok) return null
    return simplify(parsed.cnf, { techniques: enabled, log: true })
  }, [parsed, enabled])

  const pickExample = (i: number) => {
    setExampleIdx(i)
    setSrc(toDimacs(EXAMPLES[i].build()))
    setDirty(false)
    setRoundTrip(null)
  }

  const onEdit = (text: string) => {
    setSrc(text)
    setDirty(true)
    setRoundTrip(null)
  }

  const toggle = (t: Technique) => {
    setEnabled((e) => ({ ...e, [t]: !e[t] }))
    setRoundTrip(null)
  }

  const runRoundTrip = () => {
    if (!parsed.ok || !result) return
    if (result.status === 'unsat') {
      setRoundTrip({ status: 'unsat', verified: true, failingClause: -1 })
      return
    }
    if (result.status === 'trivial-sat') {
      const model = new Array<boolean>(parsed.cnf.numVars + 1).fill(false)
      const full = reconstruct(parsed.cnf.numVars, result.stack, model)
      const v = verifyModel(parsed.cnf, full)
      setRoundTrip({ status: 'trivial-sat', model: full, verified: v.ok, failingClause: v.failing })
      return
    }
    const sres = solve(result.cnf)
    if (sres.status === 'sat' && sres.model) {
      const full = reconstruct(parsed.cnf.numVars, result.stack, sres.model)
      const v = verifyModel(parsed.cnf, full)
      setRoundTrip({ status: 'sat', model: full, verified: v.ok, failingClause: v.failing })
    } else {
      setRoundTrip({ status: 'unsat', verified: sres.status === 'unsat', failingClause: -1 })
    }
  }

  const runVerify = () => {
    setChecking(true)
    setTimeout(() => {
      setChecks(runPreprocessChecks())
      setChecking(false)
    }, 30)
  }

  const blurb = dirty ? 'Your edited formula.' : EXAMPLES[exampleIdx].blurb

  const downloadSimplified = () => {
    if (!result) return
    const blob = new Blob([toDimacs(result.cnf)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'simplified.cnf'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="layout">
      <aside className="control qbf-side">
        <p className="imc-blurb">
          <strong>Preprocessing</strong> is the simplification layer every modern SAT solver runs
          before and during search. None of these rules <em>search</em> — they rewrite the formula
          into an <strong>equisatisfiable</strong> one with fewer variables and clauses, recording a{' '}
          <strong>reconstruction stack</strong> that lifts any model of the simplified formula back to
          a model of the original. Toggle techniques and watch the formula shrink.
        </p>

        <div className="smt-examples">
          <h3>Examples</h3>
          <ul>
            {EXAMPLES.map((ex, i) => (
              <li key={ex.name}>
                <button className={!dirty && exampleIdx === i ? 'active' : ''} onClick={() => pickExample(i)}>
                  {ex.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="simp-techniques">
          <h3>Techniques</h3>
          {ALL_TECHNIQUES.map((t) => (
            <label key={t} className="simp-toggle">
              <input type="checkbox" checked={enabled[t]} onChange={() => toggle(t)} />
              <span>{TECHNIQUE_LABEL[t]}</span>
              {result && result.stats.byTechnique[t].applied > 0 && (
                <span className="simp-badge">{result.stats.byTechnique[t].applied}</span>
              )}
            </label>
          ))}
        </div>

        <div className="pb-editor">
          <div className="qbf-editor-head">
            <label>DIMACS CNF {dirty && <span className="pb-dirty">edited</span>}</label>
            <code>p cnf V C</code>
          </div>
          <textarea spellCheck={false} value={src} onChange={(e) => onEdit(e.target.value)} rows={9} />
          {!parsed.ok && <div className="banner error">⚠ {parsed.error}</div>}
        </div>
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>Simplify Studio</h2>
            <p className="subtitle">{blurb}</p>
          </div>
          {result && (
            <div className={`status-pill ${result.status === 'unsat' ? 'unsat' : 'sat'}`}>
              <strong>
                {result.status === 'unsat'
                  ? 'UNSAT'
                  : result.status === 'trivial-sat'
                    ? 'SOLVED'
                    : 'SIMPLIFIED'}
              </strong>
              <span>{result.stats.rounds} rounds</span>
            </div>
          )}
        </div>

        {result ? (
          <>
            {result.status === 'unsat' && (
              <div className="banner warn">
                Preprocessing derived the empty clause — the formula is <strong>UNSAT</strong>, proven
                without any search.
              </div>
            )}
            {result.status === 'trivial-sat' && (
              <div className="banner warn">
                Preprocessing eliminated every clause — the formula is <strong>satisfiable</strong>, and
                a model is recovered purely by reconstruction.
              </div>
            )}

            <ReductionBars result={result} />

            <TechniqueTable result={result} />

            <div className="simp-roundtrip">
              <button className="count-btn" onClick={runRoundTrip}>
                Solve simplified → reconstruct → verify original
              </button>
              {roundTrip && (
                <span className={roundTrip.verified ? 'check-ok' : 'check-bad'}>
                  {roundTrip.status === 'unsat'
                    ? roundTrip.verified
                      ? '✓ UNSAT confirmed'
                      : '✗ verdict mismatch'
                    : roundTrip.verified
                      ? '✓ reconstructed model satisfies the original formula'
                      : `✗ reconstruction failed (clause #${roundTrip.failingClause})`}
                </span>
              )}
              <p className="count-note">
                The acid test: solve the <em>simplified</em> formula, replay the reconstruction stack in
                reverse, and check the lifted assignment against the <em>original</em> clauses.
              </p>
              {roundTrip?.model && <ModelGrid model={roundTrip.model} numVars={parsed.ok ? parsed.cnf.numVars : 0} />}
            </div>

            <OpLog result={result} />

            <div className="simp-output">
              <div className="qbf-editor-head">
                <label>Simplified DIMACS</label>
                <button className="qbf-reroll" onClick={downloadSimplified}>
                  ⭳ download .cnf
                </button>
              </div>
              <textarea spellCheck={false} readOnly value={toDimacs(result.cnf)} rows={8} />
            </div>

            <div className="pb-verify">
              <button className="count-btn" onClick={runVerify} disabled={checking}>
                {checking ? 'Running…' : 'Run verification suite'}
              </button>
              {checks && (
                <span className={checks.fail === 0 ? 'check-ok' : 'check-bad'}>
                  {checks.fail === 0
                    ? `✓ all ${checks.pass} assertions pass`
                    : `✗ ${checks.fail} of ${checks.pass + checks.fail} failed`}
                </span>
              )}
              <p className="count-note">
                Thousands of random instances: equisatisfiability cross-checked against the complete CDCL
                solver and exhaustive enumeration, and — the gold standard — <em>every</em> model of the
                simplified formula reconstructed and verified against the original. Subsumption and
                self-subsumption are additionally checked to preserve the model set bit-for-bit.
              </p>
              {checks && checks.messages.length > 0 && (
                <ul className="pb-fail-list">
                  {checks.messages.slice(0, 8).map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <div className="placeholder">
            <p>Enter a CNF in DIMACS format.</p>
          </div>
        )}
      </main>
    </div>
  )
}

function ReductionBars({ result }: { result: SimplifyResult }) {
  const b = result.stats.before
  const a = result.stats.after
  const rows: { label: string; before: number; after: number }[] = [
    { label: 'Variables', before: b.vars, after: a.activeVars },
    { label: 'Clauses', before: b.clauses, after: a.clauses },
    { label: 'Literals', before: b.lits, after: a.lits },
  ]
  return (
    <div className="simp-bars">
      {rows.map((r) => {
        const pct = r.before > 0 ? Math.round((1 - r.after / r.before) * 100) : 0
        const w = r.before > 0 ? Math.max(2, Math.round((r.after / r.before) * 100)) : 0
        return (
          <div className="simp-bar-row" key={r.label}>
            <span className="simp-bar-label">{r.label}</span>
            <div className="simp-bar-track">
              <div className="simp-bar-before" />
              <div className="simp-bar-after" style={{ width: `${w}%` }} />
              <span className="simp-bar-text">
                {r.before} → {r.after}
              </span>
            </div>
            <span className={`simp-bar-pct ${pct > 0 ? 'good' : pct < 0 ? 'bad' : ''}`}>
              {pct > 0 ? `−${pct}%` : pct < 0 ? `+${-pct}%` : '0%'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function TechniqueTable({ result }: { result: SimplifyResult }) {
  const used = ALL_TECHNIQUES.filter((t) => result.stats.byTechnique[t].applied > 0)
  if (used.length === 0) {
    return <p className="count-note">No technique fired — the formula is already in normal form for the selected rules.</p>
  }
  return (
    <table className="simp-table">
      <thead>
        <tr>
          <th>Technique</th>
          <th>fired</th>
          <th>vars −</th>
          <th>clauses −</th>
          <th>clauses +</th>
          <th>lits −</th>
        </tr>
      </thead>
      <tbody>
        {used.map((t) => {
          const s = result.stats.byTechnique[t]
          return (
            <tr key={t}>
              <td>{TECHNIQUE_LABEL[t]}</td>
              <td>{s.applied}</td>
              <td>{s.varsRemoved || ''}</td>
              <td>{s.clausesRemoved || ''}</td>
              <td>{s.clausesAdded || ''}</td>
              <td>{s.litsRemoved || ''}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function OpLog({ result }: { result: SimplifyResult }) {
  const [open, setOpen] = useState(false)
  if (result.log.length === 0) return null
  return (
    <details className="simp-log" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Operation log ({result.log.length} steps)</summary>
      <ol>
        {result.log.slice(0, 200).map((e, i) => (
          <li key={i}>
            <span className="simp-log-round">r{e.round}</span>
            <span className={`simp-log-tag tag-${e.technique}`}>{e.technique}</span>
            <span>{e.detail}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

function ModelGrid({ model, numVars }: { model: boolean[]; numVars: number }) {
  const vars = Array.from({ length: numVars }, (_, i) => i + 1).slice(0, 64)
  return (
    <div className="simp-model">
      {vars.map((v) => (
        <span key={v} className={`simp-lit ${model[v] ? 'on' : 'off'}`}>
          {model[v] ? '' : '¬'}x{v}
        </span>
      ))}
      {numVars > 64 && <span className="simp-lit">… {numVars - 64} more</span>}
    </div>
  )
}
