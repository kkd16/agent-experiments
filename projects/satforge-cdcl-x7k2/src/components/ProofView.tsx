import { useMemo, useState } from 'react'
import type { BuiltProblem } from '../problems'
import type { SolveResult } from '../sat'
import { checkProof, proofToDrat, toDimacs } from '../sat'
import type { DratResult } from '../sat'

/**
 * Verifies the solver's DRAT refutation with the independent in-app checker and
 * presents the result: per-rule step counts, the extracted unsat core, and
 * downloads for the `.drat` proof and the core `.cnf`.
 */
export function ProofView({ problem, result }: { problem: BuiltProblem; result: SolveResult }) {
  const proof = result.proof ?? []
  const truncated = !!result.proofTruncated

  // Run the checker once per result. Guarded so the sandboxed thumbnail can't crash.
  const check = useMemo<DratResult | { error: string } | null>(() => {
    if (truncated || proof.length === 0) return null
    try {
      return checkProof(problem.cnf, proof, { extractCore: true })
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [problem.cnf, proof, truncated])

  const additions = proof.filter((s) => s.a === 'a').length
  const deletions = proof.length - additions

  return (
    <div className="proof-view">
      <p className="proof-intro">
        A <strong>DRAT</strong> proof is a machine-checkable certificate of unsatisfiability: the ordered
        list of clauses the solver derived (<code>a</code>) and deleted (<code>d</code>), ending in the empty
        clause. SatForge re-checks it here with a <em>completely independent</em> verifier — reverse unit
        propagation (RUP) plus the more general RAT rule — so you never have to trust the solver.
      </p>

      {truncated && (
        <div className="banner warn">
          The proof exceeded the recording cap and was truncated, so it can't be fully verified. Try a
          smaller instance to see end-to-end verification.
        </div>
      )}

      {check && 'error' in check && <div className="banner error">Checker error: {check.error}</div>}

      {check && !('error' in check) && <Verdict check={check} />}

      <div className="stat-grid proof-grid">
        <Stat value={fmt(proof.length)} label="Proof steps" hint="derivations + deletions" />
        <Stat value={fmt(additions)} label="Clause additions" hint="learnt + the empty clause" />
        <Stat value={fmt(deletions)} label="Clause deletions" hint="from LBD reduction" />
        {check && !('error' in check) && (
          <>
            <Stat value={fmt(check.rupSteps)} label="RUP steps" hint="reverse unit propagation" />
            <Stat value={fmt(check.ratSteps)} label="RAT steps" hint="resolution asymmetric tautology" />
            <Stat value={`${check.elapsedMs.toFixed(1)} ms`} label="Verify time" hint="independent re-check" />
          </>
        )}
      </div>

      {check && !('error' in check) && check.core && (
        <CorePanel problem={problem} core={check.core} />
      )}

      <div className="proof-actions">
        <button
          className="kind-btn"
          onClick={() => download('proof.drat', proofToDrat(proof))}
          disabled={proof.length === 0}
        >
          ⤓ Download .drat proof
        </button>
        {check && !('error' in check) && check.core && (
          <button
            className="kind-btn"
            onClick={() =>
              download(
                'core.cnf',
                toDimacs({
                  numVars: problem.cnf.numVars,
                  clauses: check.core!.originalIndices.map((i) => problem.cnf.clauses[i]),
                }),
              )
            }
          >
            ⤓ Download unsat core (.cnf)
          </button>
        )}
      </div>

      <ProofListing proof={proof} />
    </div>
  )
}

function Verdict({ check }: { check: DratResult }) {
  if (check.ok) {
    return (
      <div className="proof-verdict ok">
        <span className="vmark">✓</span>
        <div>
          <strong>Proof verified.</strong> The empty clause is derived by {fmt(check.additions)} valid
          inferences ({fmt(check.rupSteps)} RUP{check.ratSteps ? ` + ${fmt(check.ratSteps)} RAT` : ''}). The
          UNSAT answer is independently confirmed.
        </div>
      </div>
    )
  }
  return (
    <div className="proof-verdict bad">
      <span className="vmark">✕</span>
      <div>
        <strong>Verification failed.</strong>{' '}
        {check.firstError
          ? `Step ${check.firstError.index + 1} (${
              check.firstError.lits.length ? check.firstError.lits.join(' ') + ' 0' : 'empty clause'
            }): ${check.firstError.message}.`
          : check.derivedEmpty
            ? 'Some step did not verify.'
            : 'The proof never derived the empty clause.'}
      </div>
    </div>
  )
}

function CorePanel({ problem, core }: { problem: BuiltProblem; core: { originalIndices: number[]; numOriginal: number } }) {
  const total = problem.cnf.clauses.length
  const inCore = new Set(core.originalIndices)
  const size = core.originalIndices.length
  const pct = total ? (size / total) * 100 : 0
  // Cap how many clause chips we paint so a huge formula won't lock the DOM.
  const CAP = 600
  const shown = problem.cnf.clauses.slice(0, CAP)
  return (
    <div className="core-panel">
      <div className="core-head">
        <div>
          <h3>Unsat core</h3>
          <p className="muted">
            The contradiction needs only <strong>{fmt(size)}</strong> of {fmt(total)} original clauses
            ({pct.toFixed(0)}%). Removing any clause outside the core leaves the formula unsatisfiable.
          </p>
        </div>
        <Donut frac={total ? size / total : 0} />
      </div>
      <div className="core-grid" role="list" aria-label="original clauses; highlighted are in the core">
        {shown.map((clause, i) => (
          <span
            key={i}
            role="listitem"
            className={`core-chip ${inCore.has(i) ? 'in' : 'out'}`}
            title={`clause ${i + 1}: ${clause.join(' ')} 0`}
          >
            {clause.join(' ')}
          </span>
        ))}
        {total > CAP && <span className="core-more">… {fmt(total - CAP)} more clauses</span>}
      </div>
    </div>
  )
}

function Donut({ frac }: { frac: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  const dash = Math.max(0, Math.min(1, frac)) * c
  return (
    <svg className="donut" viewBox="0 0 64 64" width="64" height="64" aria-hidden>
      <circle cx="32" cy="32" r={r} className="donut-bg" />
      <circle
        cx="32"
        cy="32"
        r={r}
        className="donut-fg"
        strokeDasharray={`${dash} ${c - dash}`}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="36" textAnchor="middle" className="donut-label">
        {Math.round(frac * 100)}%
      </text>
    </svg>
  )
}

function ProofListing({ proof }: { proof: { a: 'a' | 'd'; lits: number[] }[] }) {
  const [open, setOpen] = useState(false)
  const CAP = 400
  const lines = proof.slice(0, CAP)
  return (
    <div className="proof-listing">
      <button className="listing-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? '▾' : '▸'} Proof listing ({fmt(proof.length)} steps)
      </button>
      {open && (
        <div className="listing-body">
          {lines.map((s, i) => (
            <div key={i} className={`pline ${s.a === 'd' ? 'del' : 'add'}`}>
              <span className="badge">{s.a === 'd' ? 'd' : 'a'}</span>
              <span className="plits">{s.lits.length ? `${s.lits.join(' ')} 0` : '◻ (empty clause)'}</span>
            </div>
          ))}
          {proof.length > CAP && <div className="pline more">… {fmt(proof.length - CAP)} more steps</div>}
        </div>
      )}
    </div>
  )
}

function Stat({ value, label, hint }: { value: string; label: string; hint: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-hint">{hint}</div>
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** Trigger a client-side download. Sandboxed previews may block this — tolerate it. */
function download(name: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    /* ignore — download not available in this context */
  }
}
