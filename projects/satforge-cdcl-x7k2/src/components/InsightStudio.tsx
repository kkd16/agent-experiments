import { useMemo, useState } from 'react'
import './InsightStudio.css'
import type { CNF } from '../sat/cnf'
import { countModels } from '../sat/modelCount'
import { SOFT_EXAMPLES, CNF_EXAMPLES, SAMPLE_EXAMPLES } from '../insight/examples'
import { marco, deletionMus, quickXplainMus } from '../insight/mus'
import { SoftSolver } from '../insight/core'
import { allModels, backbone, minimalModel } from '../insight/enumerate'
import { approxModelCount } from '../insight/approxmc'
import { uniGen, naiveSample } from '../insight/sampling'
import { uniformityReport, marginalComparison } from '../insight/uniformity'
import { runSelfTests } from '../insight/selftest'

type Panel = 'mus' | 'space' | 'count' | 'sample' | 'tests'

export function InsightStudio() {
  const [panel, setPanel] = useState<Panel>('mus')
  return (
    <div className="layout">
      <aside className="control insight-side">
        <p className="imc-blurb">
          <strong>Insight</strong> reasons about the whole solution space, not one yes/no. On the
          same CDCL core it enumerates every model, isolates the <strong>backbone</strong> (facts
          true in all of them), diagnoses infeasibility into minimal <strong>MUS/MCS</strong> reasons
          by <strong>MARCO</strong>, estimates model counts by <strong>XOR hashing</strong> with
          an (ε,δ) guarantee, and draws <strong>almost-uniform witnesses</strong> from the same
          hashing (<strong>UniGen</strong>) — each answer cross-checked against a brute-force oracle.
        </p>
        <nav className="insight-nav">
          <button className={panel === 'mus' ? 'active' : ''} onClick={() => setPanel('mus')}>
            Why unsat? — MUS / MCS
          </button>
          <button className={panel === 'space' ? 'active' : ''} onClick={() => setPanel('space')}>
            Solution space — backbone & AllSAT
          </button>
          <button className={panel === 'count' ? 'active' : ''} onClick={() => setPanel('count')}>
            Counting — exact vs approximate
          </button>
          <button className={panel === 'sample' ? 'active' : ''} onClick={() => setPanel('sample')}>
            Sampling — uniform witnesses
          </button>
          <button className={panel === 'tests' ? 'active' : ''} onClick={() => setPanel('tests')}>
            Self-tests
          </button>
        </nav>
      </aside>
      <main className="content insight-main">
        {panel === 'mus' && <MusPanel />}
        {panel === 'space' && <SpacePanel />}
        {panel === 'count' && <CountPanel />}
        {panel === 'sample' && <SamplePanel />}
        {panel === 'tests' && <TestsPanel />}
      </main>
    </div>
  )
}

// ---------- MUS / MCS panel ----------

function MusPanel() {
  const [pick, setPick] = useState(0)
  const ex = SOFT_EXAMPLES[pick]
  const sys = ex.sys
  const m = sys.soft.length

  const res = useMemo(() => marco(sys), [sys])
  const single = useMemo(() => {
    const solver = new SoftSolver(sys)
    const full = Array.from({ length: m }, (_, i) => i)
    // Only meaningful when the whole system is UNSAT.
    if (solver.isSat(full)) return null
    return { deletion: deletionMus(solver, full), quickx: quickXplainMus(solver, full) }
  }, [sys, m])

  const label = (i: number) => sys.labels?.[i] ?? `C${i}`

  return (
    <div className="insight-panel">
      <ExamplePicker items={SOFT_EXAMPLES.map((e) => e.name)} pick={pick} setPick={setPick} />
      <p className="insight-blurb">{ex.blurb}</p>

      <section className="insight-card">
        <h3>Soft clauses</h3>
        <div className="clause-list">
          {sys.soft.map((c, i) => (
            <span key={i} className="clause-chip">
              <b>C{i}</b> {label(i)} <code>({c.join(' ∨ ')})</code>
            </span>
          ))}
        </div>
      </section>

      <section className="insight-card">
        <h3>
          MARCO enumeration{' '}
          <span className="muted">
            {res.muses.length} MUS · {res.mcses.filter((c) => c.length).length} MCS ·{' '}
            {res.satCalls} SAT calls · {res.timeMs.toFixed(1)} ms {res.complete ? '· complete' : '· capped'}
          </span>
        </h3>
        <p className="insight-note">
          Every <span className="tag mus">MUS</span> is an irreducible reason the system fails; every{' '}
          <span className="tag mcs">MCS</span> is a minimal repair. They are minimal hitting sets of
          one another — each MUS meets every MCS.
        </p>
        <div className="subset-cols">
          <SubsetList title="MUSes (irreducible reasons)" kind="mus" subsets={res.muses} label={label} />
          <SubsetList
            title="MCSes (minimal repairs)"
            kind="mcs"
            subsets={res.mcses.filter((c) => c.length)}
            label={label}
          />
        </div>
      </section>

      {(res.muses.length > 0 || res.mcses.some((c) => c.length)) && (
        <section className="insight-card">
          <h3>Membership matrix</h3>
          <MembershipMatrix m={m} muses={res.muses} mcses={res.mcses.filter((c) => c.length)} label={label} />
        </section>
      )}

      {single && (
        <section className="insight-card">
          <h3>Single-MUS extractors (agree with a listed MUS)</h3>
          <div className="two-col">
            <div>
              <span className="muted">deletion-based:</span>{' '}
              <SubsetInline subset={single.deletion} kind="mus" label={label} />
            </div>
            <div>
              <span className="muted">QuickXplain:</span>{' '}
              <SubsetInline subset={single.quickx} kind="mus" label={label} />
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function SubsetList({
  title,
  kind,
  subsets,
  label,
}: {
  title: string
  kind: 'mus' | 'mcs'
  subsets: number[][]
  label: (i: number) => string
}) {
  return (
    <div>
      <h4>{title}</h4>
      {subsets.length === 0 ? (
        <p className="muted">none</p>
      ) : (
        <ul className="subset-ul">
          {subsets.map((s, i) => (
            <li key={i}>
              <SubsetInline subset={s} kind={kind} label={label} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SubsetInline({
  subset,
  kind,
  label,
}: {
  subset: number[]
  kind: 'mus' | 'mcs'
  label: (i: number) => string
}) {
  return (
    <span className="subset-inline">
      {subset.map((i) => (
        <span key={i} className={`cell-chip ${kind}`} title={label(i)}>
          C{i}
        </span>
      ))}
    </span>
  )
}

function MembershipMatrix({
  m,
  muses,
  mcses,
  label,
}: {
  m: number
  muses: number[][]
  mcses: number[][]
  label: (i: number) => string
}) {
  const rows = [
    ...muses.map((s, i) => ({ tag: `M${i + 1}`, kind: 'mus' as const, set: new Set(s) })),
    ...mcses.map((s, i) => ({ tag: `R${i + 1}`, kind: 'mcs' as const, set: new Set(s) })),
  ]
  return (
    <div className="matrix-scroll">
      <table className="matrix">
        <thead>
          <tr>
            <th />
            {Array.from({ length: m }, (_, i) => (
              <th key={i} title={label(i)}>
                C{i}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <th className={`rowtag ${r.kind}`}>{r.tag}</th>
              {Array.from({ length: m }, (_, ci) => (
                <td key={ci} className={r.set.has(ci) ? `on ${r.kind}` : ''} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- Solution-space panel ----------

function SpacePanel() {
  const [pick, setPick] = useState(0)
  const ex = CNF_EXAMPLES[pick]
  const cnf = ex.cnf

  const data = useMemo(() => {
    const bb = backbone(cnf)
    const exact = countModels(cnf, { budget: 2_000_000 })
    const enumRes = allModels(cnf, { maxModels: 64 })
    const minModel = minimalModel(cnf)
    return { bb, exact, enumRes, minModel }
  }, [cnf])

  const litLabel = (l: number) => {
    const v = Math.abs(l)
    const name = ex.varLabels?.[v] || `x${v}`
    return (l > 0 ? '' : '¬') + name
  }

  return (
    <div className="insight-panel">
      <ExamplePicker items={CNF_EXAMPLES.map((e) => e.name)} pick={pick} setPick={setPick} />
      <p className="insight-blurb">{ex.blurb}</p>

      <div className="stat-row">
        <Stat
          label="Exact #models"
          value={data.exact.count === null ? '≥ budget' : data.exact.count.toString()}
          sub={`${data.exact.nodes} nodes · ${data.exact.cacheHits} cache hits`}
        />
        <Stat
          label="Backbone size"
          value={data.bb.status === 'unsat' ? '— (UNSAT)' : String(data.bb.literals.length)}
          sub={`${data.bb.solverCalls} solver calls`}
        />
        <Stat
          label="Enumerated"
          value={`${data.enumRes.models.length}${data.enumRes.complete ? '' : '+'}`}
          sub={data.enumRes.complete ? 'all models' : 'first 64'}
        />
      </div>

      <section className="insight-card">
        <h3>Backbone — literals true in every model</h3>
        {data.bb.status === 'unsat' ? (
          <p className="muted">The formula is UNSAT; it has no models and hence no backbone.</p>
        ) : data.bb.literals.length === 0 ? (
          <p className="muted">Empty backbone — every variable takes both values across the models.</p>
        ) : (
          <div className="clause-list">
            {data.bb.literals.map((l) => (
              <span key={l} className={`lit-chip ${l > 0 ? 'pos' : 'neg'}`}>
                {litLabel(l)}
              </span>
            ))}
          </div>
        )}
      </section>

      {data.minModel.status === 'sat' && (
        <section className="insight-card">
          <h3>A subset-minimal model</h3>
          <p className="insight-note">No true variable here can be switched off while staying a model.</p>
          <div className="clause-list">
            {data.minModel.trueVars.length === 0 ? (
              <span className="muted">the all-false assignment</span>
            ) : (
              data.minModel.trueVars.map((v) => (
                <span key={v} className="lit-chip pos">
                  {ex.varLabels?.[v] || `x${v}`}
                </span>
              ))
            )}
          </div>
        </section>
      )}

      {data.enumRes.models.length > 0 && (
        <section className="insight-card">
          <h3>Model gallery {data.enumRes.complete ? '(exhaustive)' : '(first 64)'}</h3>
          <ModelGrid cnf={cnf} models={data.enumRes.models} labels={ex.varLabels} />
        </section>
      )}
    </div>
  )
}

function ModelGrid({ cnf, models, labels }: { cnf: CNF; models: boolean[][]; labels?: string[] }) {
  const shown = models.slice(0, 64)
  return (
    <div className="matrix-scroll">
      <table className="matrix model-grid">
        <thead>
          <tr>
            <th />
            {Array.from({ length: cnf.numVars }, (_, i) => (
              <th key={i} title={labels?.[i + 1]}>
                {labels?.[i + 1] || `x${i + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((mdl, ri) => (
            <tr key={ri}>
              <th className="rowtag">#{ri + 1}</th>
              {Array.from({ length: cnf.numVars }, (_, ci) => (
                <td key={ci} className={mdl[ci + 1] ? 'on true1' : 'false0'}>
                  {mdl[ci + 1] ? '1' : '·'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- Counting panel ----------

function CountPanel() {
  const [pick, setPick] = useState(3) // default to the loose 3-SAT
  const ex = CNF_EXAMPLES[pick]
  const cnf = ex.cnf
  const [eps, setEps] = useState(0.8)
  const [delta, setDelta] = useState(0.2)
  const [rounds, setRounds] = useState(15)
  const [seed, setSeed] = useState(7)
  const [run, setRun] = useState<{ exact: bigint | null; approx: ReturnType<typeof approxModelCount> } | null>(null)
  const [busy, setBusy] = useState(false)

  const go = () => {
    setBusy(true)
    // Defer so the button paints its busy state before the (synchronous) compute.
    setTimeout(() => {
      const exact = countModels(cnf, { budget: 4_000_000 }).count
      const approx = approxModelCount(cnf, { epsilon: eps, delta, rounds, seed })
      setRun({ exact, approx })
      setBusy(false)
    }, 0)
  }

  const within = useMemo(() => {
    if (!run || run.exact === null) return null
    const exact = Number(run.exact)
    const lo = exact / (1 + eps)
    const hi = exact * (1 + eps)
    return { lo, hi, ok: run.approx.estimate >= lo && run.approx.estimate <= hi }
  }, [run, eps])

  return (
    <div className="insight-panel">
      <ExamplePicker items={CNF_EXAMPLES.map((e) => e.name)} pick={pick} setPick={setPick} />
      <p className="insight-blurb">{ex.blurb}</p>
      <p className="insight-note">
        Exact #SAT is #P-complete. <strong>ApproxMC</strong> hashes the models into 2<sup>m</sup> cells
        with random XOR (parity) constraints, counts one small cell exactly, and scales back by
        2<sup>m</sup> — a within-(1+ε) estimate with probability ≥ 1−δ.
      </p>

      <div className="controls-row">
        <Slider label={`ε (tolerance) = ${eps.toFixed(2)}`} min={0.4} max={1.6} step={0.1} value={eps} onChange={setEps} />
        <Slider label={`δ (failure) = ${delta.toFixed(2)}`} min={0.05} max={0.5} step={0.05} value={delta} onChange={setDelta} />
        <Slider label={`rounds = ${rounds}`} min={1} max={31} step={2} value={rounds} onChange={(v) => setRounds(Math.round(v))} />
        <Slider label={`seed = ${seed}`} min={1} max={100} step={1} value={seed} onChange={(v) => setSeed(Math.round(v))} />
        <button className="run-btn" onClick={go} disabled={busy}>
          {busy ? 'Estimating…' : 'Estimate count'}
        </button>
      </div>

      {run && (
        <>
          <div className="stat-row">
            <Stat label="Exact count" value={run.exact === null ? '≥ budget' : run.exact.toString()} sub="component-cached #SAT" />
            <Stat label="ApproxMC estimate" value={run.approx.estimate.toLocaleString()} sub={`${run.approx.rounds} rounds · thresh ${run.approx.thresh}`} />
            <Stat
              label="Within (1+ε)?"
              value={within === null ? 'n/a' : within.ok ? '✓ yes' : '✗ no'}
              sub={within === null ? 'exact unavailable' : `[${within.lo.toFixed(0)}, ${within.hi.toFixed(0)}]`}
              tone={within?.ok ? 'good' : within ? 'bad' : undefined}
            />
          </div>
          {run.approx.exactSmall ? (
            <p className="insight-note">Formula had fewer than the threshold many models — counted exactly, no hashing needed.</p>
          ) : (
            <section className="insight-card">
              <h3>Per-round cell estimates (median = the answer)</h3>
              <RoundBars estimates={run.approx.roundEstimates} exact={run.exact === null ? null : Number(run.exact)} />
            </section>
          )}
        </>
      )}
    </div>
  )
}

function RoundBars({ estimates, exact }: { estimates: number[]; exact: number | null }) {
  const max = Math.max(...estimates, exact ?? 0, 1)
  return (
    <div className="round-bars">
      {estimates.map((e, i) => (
        <div key={i} className="round-bar" title={`round ${i + 1}: ${e.toFixed(0)}`}>
          <div className="round-fill" style={{ height: `${(e / max) * 100}%` }} />
        </div>
      ))}
      {exact !== null && <div className="exact-line" style={{ bottom: `${(exact / max) * 100}%` }} title={`exact ${exact}`} />}
    </div>
  )
}

// ---------- Sampling panel (UniGen almost-uniform witnesses) ----------

function SamplePanel() {
  const [pick, setPick] = useState(0)
  const ex = SAMPLE_EXAMPLES[pick]
  const cnf = ex.cnf
  const [nSamples, setNSamples] = useState(600)
  const [kappa, setKappa] = useState(0.9)
  const [seed, setSeed] = useState(7)
  const [showNaive, setShowNaive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<null | {
    ug: ReturnType<typeof uniGen>
    ugRep: ReturnType<typeof uniformityReport>
    marg: ReturnType<typeof marginalComparison>
    naiveRep: ReturnType<typeof uniformityReport> | null
  }>(null)

  const go = () => {
    setBusy(true)
    setTimeout(() => {
      const ug = uniGen(cnf, { numSamples: nSamples, kappa, seed })
      const ugRep = uniformityReport(cnf, ug.samplingVars, ug.samples)
      const marg = marginalComparison(cnf, ug.samplingVars, ug.samples)
      let naiveRep: ReturnType<typeof uniformityReport> | null = null
      if (showNaive) {
        const nv = naiveSample(cnf, { numSamples: nSamples, seed, sampling: ug.samplingVars })
        naiveRep = uniformityReport(cnf, nv.samplingVars, nv.samples)
      }
      setRun({ ug, ugRep, marg, naiveRep })
      setBusy(false)
    }, 0)
  }

  // Clear stale results whenever the example changes.
  const choose = (i: number) => {
    setPick(i)
    setRun(null)
  }

  return (
    <div className="insight-panel">
      <ExamplePicker items={SAMPLE_EXAMPLES.map((e) => e.name)} pick={pick} setPick={choose} />
      <p className="insight-blurb">{ex.blurb}</p>
      <p className="insight-note">
        <strong>UniGen</strong> draws witnesses <em>almost uniformly</em> by the same trick that powers
        ApproxMC: hash the models into 2<sup>q</sup> random XOR cells, keep hashing until a typical cell
        is small enough to enumerate, then return one survivor of a cell chosen uniformly at random. The
        two uniform choices compose into a near-flat draw. The naive baseline — just ask the solver — is
        shown for contrast: it is <em>sound</em> (only real solutions) but <em>skewed</em> toward whatever
        the search finds first.
      </p>

      <div className="controls-row">
        <Slider label={`samples = ${nSamples}`} min={100} max={1500} step={100} value={nSamples} onChange={(v) => setNSamples(Math.round(v))} />
        <Slider label={`κ (tolerance) = ${kappa.toFixed(1)}`} min={0.4} max={1.6} step={0.1} value={kappa} onChange={setKappa} />
        <Slider label={`seed = ${seed}`} min={1} max={100} step={1} value={seed} onChange={(v) => setSeed(Math.round(v))} />
        <label className="toggle">
          <input type="checkbox" checked={showNaive} onChange={(e) => setShowNaive(e.target.checked)} />
          <span>compare naive</span>
        </label>
        <button className="run-btn" onClick={go} disabled={busy}>
          {busy ? 'Sampling…' : 'Draw witnesses'}
        </button>
      </div>

      {run && (
        <>
          <div className="stat-row">
            <Stat label="Exact #models" value={run.ugRep.support.toLocaleString()} sub="enumerated support" />
            <Stat
              label="Method"
              value={run.ug.fastPath ? 'exact' : `hashed 2^${run.ug.hashBits}`}
              sub={run.ug.fastPath ? 'space fit one cell' : `cell band [${run.ug.loThresh},${run.ug.hiThresh}]`}
            />
            <Stat
              label="Coverage"
              value={`${run.ugRep.distinct}/${run.ugRep.support}`}
              sub={`${(run.ugRep.coverage * 100).toFixed(0)}% of solutions hit`}
              tone={run.ugRep.coverage === 1 ? 'good' : undefined}
            />
            <Stat
              label="UniGen TV distance"
              value={run.ugRep.tvDistance.toFixed(3)}
              sub={`χ² ${run.ugRep.chiSquare.toFixed(0)} / ${run.ugRep.chiDof} dof`}
              tone={run.naiveRep && run.ugRep.tvDistance < run.naiveRep.tvDistance ? 'good' : undefined}
            />
            {run.naiveRep && (
              <Stat
                label="Naive TV distance"
                value={run.naiveRep.tvDistance.toFixed(3)}
                sub={`χ² ${run.naiveRep.chiSquare.toFixed(0)} · ${(run.naiveRep.coverage * 100).toFixed(0)}% cover`}
                tone={run.naiveRep.tvDistance > run.ugRep.tvDistance ? 'bad' : undefined}
              />
            )}
          </div>

          {run.ug.samples.length === 0 ? (
            <p className="muted">No witnesses drawn — the formula is unsatisfiable.</p>
          ) : (
            <>
              <section className="insight-card">
                <h3>
                  Sample frequency per solution{' '}
                  <span className="muted">
                    lower &amp; flatter is more uniform · the dashed line is the {run.ugRep.expected.toFixed(1)}-per-solution
                    ideal
                  </span>
                </h3>
                <Histogram label="UniGen (almost-uniform)" kind="ug" counts={run.ugRep.counts} expected={run.ugRep.expected} />
                {run.naiveRep && (
                  <Histogram
                    label="Naive (ask the solver)"
                    kind="naive"
                    counts={run.naiveRep.counts}
                    expected={run.naiveRep.expected}
                  />
                )}
                <p className="insight-note">
                  Each bar is one satisfying assignment; its height is how often that exact solution was
                  drawn. UniGen’s bars hug the ideal line; the naive sampler’s tower over a favoured few.
                </p>
              </section>

              <section className="insight-card">
                <h3>
                  Per-variable marginals{' '}
                  <span className="muted">sampled vs exact · max error {run.marg.maxError.toFixed(3)}</span>
                </h3>
                <MarginalBars rows={run.marg.rows} labels={ex.varLabels} />
                <p className="insight-note">
                  P(variable = true) estimated from the UniGen draws (solid) against the exact marginal over
                  every model (outline). Uniform sampling recovers each marginal to within sampling noise.
                </p>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}

function Histogram({
  label,
  kind,
  counts,
  expected,
}: {
  label: string
  kind: 'ug' | 'naive'
  counts: { key: string; count: number }[]
  expected: number
}) {
  const max = Math.max(expected, ...counts.map((c) => c.count), 1)
  return (
    <div className="histo-block">
      <div className="histo-label">{label}</div>
      <div className="histo">
        <div className={`histo-bars ${kind}`}>
          {counts.map((c, i) => (
            <div
              key={i}
              className="histo-bar"
              style={{ height: `${(c.count / max) * 100}%` }}
              title={`solution ${i + 1} (${c.key}): ${c.count}×`}
            />
          ))}
        </div>
        <div className="histo-ideal" style={{ bottom: `${(expected / max) * 100}%` }} />
      </div>
    </div>
  )
}

function MarginalBars({ rows, labels }: { rows: { v: number; exact: number; sampled: number }[]; labels?: string[] }) {
  return (
    <div className="marg-grid">
      {rows.map((r) => (
        <div key={r.v} className="marg-row">
          <span className="marg-name">{labels?.[r.v] || `x${r.v}`}</span>
          <div className="marg-track">
            <div className="marg-exact" style={{ width: `${r.exact * 100}%` }} title={`exact ${(r.exact * 100).toFixed(0)}%`} />
            <div className="marg-samp" style={{ width: `${r.sampled * 100}%` }} title={`sampled ${(r.sampled * 100).toFixed(0)}%`} />
          </div>
          <span className="marg-val">{(r.sampled * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  )
}

// ---------- Self-tests panel ----------

function TestsPanel() {
  const [report, setReport] = useState<ReturnType<typeof runSelfTests> | null>(null)
  const [busy, setBusy] = useState(false)
  const run = () => {
    setBusy(true)
    setTimeout(() => {
      setReport(runSelfTests())
      setBusy(false)
    }, 0)
  }
  return (
    <div className="insight-panel">
      <p className="insight-blurb">
        Every Insight algorithm is checked against a brute-force truth-table oracle: AllSAT, backbone,
        minimal models, deletion &amp; QuickXplain MUSes, full MARCO MUS/MCS enumeration, and ApproxMC
        vs the exact count. If any from-scratch answer disagreed with the oracle, its row would go red.
      </p>
      <button className="run-btn" onClick={run} disabled={busy}>
        {busy ? 'Running…' : 'Run self-tests'}
      </button>
      {report && (
        <>
          <div className="stat-row">
            <Stat label="Passed" value={`${report.passed}/${report.cases.length}`} tone={report.failed === 0 ? 'good' : 'bad'} />
            <Stat label="Failed" value={String(report.failed)} tone={report.failed === 0 ? 'good' : 'bad'} />
          </div>
          <table className="test-table">
            <tbody>
              {report.cases.map((c, i) => (
                <tr key={i} className={c.passed ? 'pass' : 'fail'}>
                  <td className="tstatus">{c.passed ? 'PASS' : 'FAIL'}</td>
                  <td>{c.name}</td>
                  <td className="tdetail">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ---------- shared bits ----------

function ExamplePicker({ items, pick, setPick }: { items: string[]; pick: number; setPick: (i: number) => void }) {
  return (
    <div className="ex-tabs">
      {items.map((name, i) => (
        <button key={i} className={i === pick ? 'active' : ''} onClick={() => setPick(i)}>
          {name}
        </button>
      ))}
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`insight-stat ${tone ?? ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}
