import { useMemo, useState } from 'react'
import { randomKSat } from '../sat'
import type { CNF } from '../sat'
import {
  localSearch,
  anneal,
  surveyPropagate,
  race,
  sweepPhase,
  runSlsChecks,
  type SlsAlgorithm,
  type SlsResult,
  type AnnealResult,
  type SpResult,
  type RaceResult,
  type PhaseResult,
  type SlsCheckReport,
} from '../sls'

type View = 'run' | 'race' | 'phase'
type Method = SlsAlgorithm | 'anneal' | 'sp'

interface Cfg {
  n: number
  alpha: number
  k: number
  seed: number
}

const METHOD_LABEL: Record<Method, string> = {
  gsat: 'GSAT + walk',
  walksat: 'WalkSAT / SKC',
  probsat: 'ProbSAT',
  novelty: 'Novelty+',
  anneal: 'Simulated annealing',
  sp: 'Survey propagation',
}

const METHOD_BLURB: Record<Method, string> = {
  gsat: 'Greedy hill-climbing on the number of unsatisfied clauses, with a random-walk escape from local minima. The original (1992) local-search SAT solver.',
  walksat:
    'Focuses on a single unsatisfied clause and flips its least-damaging variable — taking a zero-break "freebie" whenever one exists. The workhorse of modern SLS.',
  probsat:
    'No greedy step at all: inside an unsatisfied clause it flips variable v with probability ∝ cb^−break(v). Astonishingly, this pure break-driven sampling is state-of-the-art (Balint & Schöning, 2012).',
  novelty:
    'Picks the best-scoring variable of an unsatisfied clause — but if that is the one it just flipped, it takes the runner-up, breaking the flip-cycles that trap greedier methods.',
  anneal:
    'SAT as statistical mechanics: energy = unsatisfied clauses, flips accepted by the Metropolis rule e^−ΔE/T while a geometric schedule cools T toward zero, freezing into a (hopefully global) minimum.',
  sp: 'Survey propagation: the cavity method of spin-glass physics, run as message passing on the formula’s factor graph. It estimates how "frozen" each variable is, fixes the most frozen, and recurses — solving random 3-SAT right at the threshold where every complete solver explodes.',
}

function buildCnf(cfg: Cfg): CNF {
  return randomKSat(cfg.n, cfg.alpha, cfg.k, cfg.seed)
}

const DEFAULT_CFG: Cfg = { n: 120, alpha: 4.0, k: 3, seed: 1 }

interface RunOutcome {
  method: Method
  cnf: CNF
  sls?: SlsResult
  ann?: AnnealResult
  sp?: SpResult
}

function runMethod(method: Method, cnf: CNF, seed: number, noise: number): RunOutcome {
  if (method === 'anneal') return { method, cnf, ann: anneal(cnf, { seed, maxTimeMs: 4000 }) }
  if (method === 'sp') return { method, cnf, sp: surveyPropagate(cnf, { seed, maxTimeMs: 6000 }) }
  return { method, cnf, sls: localSearch(cnf, { algorithm: method, seed, noise, maxTimeMs: 4000, maxTries: 1_000_000 }) }
}

export function PhysStudio() {
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG)
  const [method, setMethod] = useState<Method>('walksat')
  const [noise, setNoise] = useState(0.4)
  const [view, setView] = useState<View>('run')

  const cnf = useMemo(() => buildCnf(cfg), [cfg])

  const [outcome, setOutcome] = useState<RunOutcome | null>(() => runMethod('walksat', buildCnf(DEFAULT_CFG), DEFAULT_CFG.seed, 0.4))
  const [raceRes, setRaceRes] = useState<RaceResult | null>(null)
  const [phase, setPhase] = useState<PhaseResult | null>(null)
  const [busy, setBusy] = useState<null | 'run' | 'race' | 'phase'>(null)
  const [checks, setChecks] = useState<SlsCheckReport | null>(null)
  const [checking, setChecking] = useState(false)

  const defer = (fn: () => void) => setTimeout(fn, 30)

  const doRun = () => {
    setBusy('run')
    setView('run')
    defer(() => {
      setOutcome(runMethod(method, cnf, cfg.seed, noise))
      setBusy(null)
    })
  }
  const doRace = () => {
    setBusy('race')
    setView('race')
    defer(() => {
      setRaceRes(race(cnf, { budgetMs: 2500, seed: cfg.seed }))
      setBusy(null)
    })
  }
  const doPhase = () => {
    setBusy('phase')
    setView('phase')
    defer(() => {
      setPhase(sweepPhase({ numVars: 80, alphaMin: 3, alphaMax: 6, steps: 16, samplesPerPoint: 14, seed: cfg.seed, maxTimeMs: 14000 }))
      setBusy(null)
    })
  }
  const runVerify = () => {
    setChecking(true)
    defer(() => {
      setChecks(runSlsChecks())
      setChecking(false)
    })
  }

  const reroll = () => setCfg((c) => ({ ...c, seed: (c.seed * 1103515245 + 12345) & 0x7fffffff }))

  return (
    <div className="layout">
      <aside className="control sls-side">
        <p className="imc-blurb">
          <strong>Incomplete</strong> solvers don&rsquo;t search a tree — they <em>sample</em>. Local search hill-climbs the
          number of unsatisfied clauses; survey propagation borrows the <strong>cavity method</strong> from the physics of
          spin glasses. None can prove UNSAT, but they crack satisfiable instances — even at the phase transition — that
          stop complete solvers cold. Every model is re-checked against the formula, and the complete CDCL engine referees.
        </p>

        <div className="sls-gen">
          <h3>Random k-SAT</h3>
          <div className="sls-grid">
            <label>
              variables n
              <input type="number" min={5} max={400} value={cfg.n}
                onChange={(e) => setCfg((c) => ({ ...c, n: clampInt(+e.target.value, 5, 400) }))} />
            </label>
            <label>
              ratio α = m/n
              <input type="number" step={0.1} min={1} max={8} value={cfg.alpha}
                onChange={(e) => setCfg((c) => ({ ...c, alpha: clamp(+e.target.value, 1, 8) }))} />
            </label>
            <label>
              clause width k
              <input type="number" min={2} max={6} value={cfg.k}
                onChange={(e) => setCfg((c) => ({ ...c, k: clampInt(+e.target.value, 2, 6) }))} />
            </label>
            <label>
              seed
              <input type="number" value={cfg.seed}
                onChange={(e) => setCfg((c) => ({ ...c, seed: Math.max(1, Math.floor(+e.target.value || 1)) }))} />
            </label>
          </div>
          <button className="qbf-reroll" onClick={reroll}>⟳ Reroll seed</button>
          <p className="count-note">
            {cnf.clauses.length} clauses · α = {cfg.alpha.toFixed(2)}{' '}
            {cfg.k === 3 && (
              <span className={cfg.alpha > 4.267 ? 'sls-warn' : 'sls-ok'}>
                ({cfg.alpha < 4.0 ? 'under-constrained' : cfg.alpha > 4.5 ? 'likely UNSAT' : 'near the 4.27 threshold'})
              </span>
            )}
          </p>
        </div>

        <div className="sls-methods">
          <h3>Method</h3>
          <div className="sls-method-list">
            {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
              <button key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
                {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
          {(method === 'gsat' || method === 'walksat' || method === 'novelty') && (
            <label className="sls-noise">
              noise p = {noise.toFixed(2)}
              <input type="range" min={0} max={1} step={0.01} value={noise} onChange={(e) => setNoise(+e.target.value)} />
            </label>
          )}
        </div>

        <div className="sls-actions">
          <button className="qbf-solve" onClick={doRun} disabled={busy !== null}>Run ▶</button>
          <button className="count-btn" onClick={doRace} disabled={busy !== null}>Race all solvers</button>
          <button className="count-btn" onClick={doPhase} disabled={busy !== null}>Phase-transition sweep</button>
        </div>

        <div className="pb-verify">
          <button className="count-btn" onClick={runVerify} disabled={checking}>
            {checking ? 'Running…' : 'Run verification suite'}
          </button>
          {checks && (
            <span className={checks.fail === 0 ? 'check-ok' : 'check-bad'}>
              {checks.fail === 0 ? `✓ all ${checks.pass} assertions pass` : `✗ ${checks.fail} of ${checks.pass + checks.fail} failed`}
            </span>
          )}
          <p className="count-note">
            Thousands of random instances: the incremental flip engine checked against a from-scratch rebuild after every
            flip, every model re-verified, and no stochastic solver ever allowed to disagree with the complete solver.
          </p>
          {checks && checks.messages.length > 0 && (
            <ul className="pb-fail-list">{checks.messages.slice(0, 8).map((m, i) => <li key={i}>{m}</li>)}</ul>
          )}
        </div>
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>Phys Studio — local search &amp; survey propagation</h2>
            <p className="subtitle">{METHOD_BLURB[method]}</p>
          </div>
        </div>

        <nav className="tabs">
          <button className={`tab ${view === 'run' ? 'active' : ''}`} onClick={() => setView('run')}>Single run</button>
          <button className={`tab ${view === 'race' ? 'active' : ''}`} onClick={() => setView('race')} disabled={!raceRes && busy !== 'race'}>Race</button>
          <button className={`tab ${view === 'phase' ? 'active' : ''}`} onClick={() => setView('phase')} disabled={!phase && busy !== 'phase'}>Phase transition</button>
        </nav>

        <section className="view">
          {busy && (
            <div className="placeholder"><div className="spinner" /><p>{busy === 'phase' ? 'Sweeping α across the threshold…' : busy === 'race' ? 'Racing the field…' : 'Running…'}</p></div>
          )}
          {!busy && view === 'run' && outcome && <RunView outcome={outcome} />}
          {!busy && view === 'race' && raceRes && <RaceView res={raceRes} />}
          {!busy && view === 'race' && !raceRes && <div className="placeholder"><p>Press “Race all solvers”.</p></div>}
          {!busy && view === 'phase' && phase && <PhaseView res={phase} />}
          {!busy && view === 'phase' && !phase && <div className="placeholder"><p>Press “Phase-transition sweep”.</p></div>}
        </section>
      </main>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Single-run view
// ----------------------------------------------------------------------------
function RunView({ outcome }: { outcome: RunOutcome }) {
  if (outcome.sp) return <SpView sp={outcome.sp} cnf={outcome.cnf} />
  if (outcome.ann) return <AnnealView a={outcome.ann} />
  if (outcome.sls) return <SlsView r={outcome.sls} />
  return null
}

function Verdict({ solved, label }: { solved: boolean; label: string }) {
  return (
    <div className="imc-card">
      <h3>Verdict</h3>
      <p>
        {solved ? (
          <><strong className="verdict-sat">SAT</strong> — {label} found a satisfying assignment, re-verified against the formula. ✓</>
        ) : (
          <><strong className="verdict-unknown">UNKNOWN</strong> — budget exhausted. Incomplete solvers never report UNSAT.</>
        )}
      </p>
    </div>
  )
}

function SlsView({ r }: { r: SlsResult }) {
  const solved = r.status === 'sat'
  return (
    <>
      <div className="imc-cards">
        <Verdict solved={solved} label="local search" />
        <div className="imc-card">
          <h3>Effort</h3>
          <div className="qbf-stats">
            <div><span>{r.flips.toLocaleString()}</span>flips</div>
            <div><span>{r.tries}</span>tries</div>
            <div><span>{r.restarts}</span>restarts</div>
            <div><span>{r.bestEnergy}</span>best unsat</div>
            <div><span>{r.timeMs.toFixed(0)}</span>ms</div>
            <div><span>{Math.round(r.flips / Math.max(1, r.timeMs))}k</span>flips/s</div>
          </div>
        </div>
      </div>
      <Trajectory data={r.trajectory} title="Unsatisfied clauses over the search" sampleEvery={r.sampleEvery} solvedAtEnd={solved} />
    </>
  )
}

function AnnealView({ a }: { a: AnnealResult }) {
  const solved = a.status === 'sat'
  return (
    <>
      <div className="imc-cards">
        <Verdict solved={solved} label="simulated annealing" />
        <div className="imc-card">
          <h3>Thermodynamics</h3>
          <div className="qbf-stats">
            <div><span>{a.steps.toLocaleString()}</span>steps</div>
            <div><span>{a.bestEnergy}</span>best unsat</div>
            <div><span>{(a.acceptUphill * 100).toFixed(0)}%</span>uphill accepted</div>
            <div><span>{a.timeMs.toFixed(0)}</span>ms</div>
          </div>
        </div>
      </div>
      <Trajectory data={a.trajectory} title="Energy (unsatisfied clauses) as the system cools" sampleEvery={a.sampleEvery} temps={a.temperature} solvedAtEnd={solved} />
    </>
  )
}

function SpView({ sp, cnf }: { sp: SpResult; cnf: CNF }) {
  const solved = sp.status === 'sat'
  const biases = sp.initialBiases ?? []
  const ranked = [...biases].sort((x, y) => Math.abs(y.wPlus - y.wMinus) - Math.abs(x.wPlus - x.wMinus)).slice(0, 80)
  return (
    <>
      <div className="imc-cards">
        <div className="imc-card">
          <h3>Verdict</h3>
          <p>
            {solved ? (
              <><strong className="verdict-sat">SAT</strong> — survey-propagation decimation found a model{sp.verified ? ', re-verified ✓' : ''}.</>
            ) : sp.status === 'contradiction' ? (
              <><strong className="verdict-unknown">DECIMATION FAILED</strong> — SP fixed a variable wrong and drove the residual to an empty clause. {sp.message}</>
            ) : sp.status === 'unconverged' ? (
              <><strong className="verdict-unknown">UNCONVERGED</strong> — the cavity equations did not reach a fixed point. {sp.message}</>
            ) : (
              <><strong className="verdict-unknown">UNKNOWN</strong> — {sp.message}</>
            )}
          </p>
        </div>
        <div className="imc-card">
          <h3>Decimation</h3>
          <div className="qbf-stats">
            <div><span>{sp.rounds}</span>SP rounds</div>
            <div><span>{sp.totalIters.toLocaleString()}</span>cavity iters</div>
            <div><span>{sp.fixedBySp}</span>fixed by SP</div>
            <div><span>{sp.fixedByUnit}</span>by unit-prop</div>
            <div><span>{sp.fixedByWalksat}</span>by WalkSAT</div>
            <div><span>{sp.timeMs.toFixed(0)}</span>ms</div>
          </div>
        </div>
        <div className="imc-card">
          <h3>Whole-formula field</h3>
          <p>
            First fixed point {sp.initialConverged ? 'converged' : 'did not converge'}; peak survey{' '}
            <strong>η<sub>max</sub> = {sp.initialMaxEta.toFixed(3)}</strong>.{' '}
            {sp.initialMaxEta < 0.01 ? 'Paramagnetic — no frozen variables.' : 'Non-trivial surveys — a frozen backbone exists.'}
          </p>
        </div>
      </div>

      {ranked.length > 0 && (
        <div className="pb-panel">
          <h3>Survey field — per-variable frozen bias (most-frozen first)</h3>
          <p className="count-note">
            Each bar is one variable: <span className="sls-leg sls-leg-pos">W⁺</span> probability it is frozen true,
            {' '}<span className="sls-leg sls-leg-neg">W⁻</span> frozen false,
            {' '}<span className="sls-leg sls-leg-zero">W⁰</span> free to wobble. SP decimates the most polarized variables first.
          </p>
          <BiasField biases={ranked} />
        </div>
      )}

      {sp.history.length > 0 && (
        <div className="pb-panel">
          <h3>Decimation log</h3>
          <div className="sls-log">
            <table>
              <thead><tr><th>round</th><th>conv?</th><th>iters</th><th>η<sub>max</sub></th><th>fixed</th><th>remaining</th><th>note</th></tr></thead>
              <tbody>
                {sp.history.map((h) => (
                  <tr key={h.round}>
                    <td>{h.round}</td>
                    <td>{h.converged ? '✓' : '✗'}</td>
                    <td>{h.iters}</td>
                    <td>{h.maxEta.toFixed(3)}</td>
                    <td>{h.fixed}</td>
                    <td>{h.remaining}</td>
                    <td className="sls-note">{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="count-note">Instance: {cnf.numVars} variables, {cnf.clauses.length} clauses.</p>
    </>
  )
}

// ----------------------------------------------------------------------------
// Race view
// ----------------------------------------------------------------------------
function RaceView({ res }: { res: RaceResult }) {
  const solvers = res.racers.filter((r) => r.status === 'sat')
  const fastest = solvers.length ? solvers.reduce((a, b) => (a.timeMs <= b.timeMs ? a : b)) : null
  return (
    <>
      <div className="imc-cards">
        <div className="imc-card">
          <h3>Ground truth</h3>
          <p>
            The complete CDCL solver proves this instance{' '}
            <strong className={res.truth === 'sat' ? 'verdict-sat' : res.truth === 'unsat' ? 'verdict-unsat' : 'verdict-unknown'}>
              {res.truth.toUpperCase()}
            </strong>. {res.numVars} vars, {res.numClauses} clauses.
          </p>
        </div>
        <div className="imc-card oracle">
          <h3>Consistency</h3>
          <p className={res.consistent ? 'check-ok' : 'check-bad'}>
            {res.consistent ? '✓ every stochastic verdict & model agrees with the referee' : '✗ a stochastic solver disagreed!'}
          </p>
        </div>
        {fastest && (
          <div className="imc-card">
            <h3>Fastest to a model</h3>
            <p><strong>{fastest.name}</strong> — {fastest.timeMs.toFixed(0)} ms, {fastest.work.toLocaleString()} {fastest.workUnit}.</p>
          </div>
        )}
      </div>

      <div className="pb-panel">
        <h3>The field</h3>
        <div className="sls-log">
          <table>
            <thead><tr><th>solver</th><th>kind</th><th>result</th><th>work</th><th>time</th><th>model ✓</th></tr></thead>
            <tbody>
              {res.racers.map((r) => (
                <tr key={r.name} className={r.kind === 'complete' ? 'sls-row-complete' : ''}>
                  <td>{r.name}</td>
                  <td>{r.kind}</td>
                  <td>
                    <span className={r.status === 'sat' ? 'verdict-sat' : r.status === 'unsat' ? 'verdict-unsat' : 'verdict-unknown'}>
                      {r.status.toUpperCase()}
                    </span>
                  </td>
                  <td>{r.work.toLocaleString()} {r.workUnit}</td>
                  <td>{r.timeMs.toFixed(0)} ms</td>
                  <td>{r.verified === null ? '—' : r.verified ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="count-note">
          Complete vs. incomplete: the CDCL engine is the only one that can prove UNSAT, but on satisfiable instances the
          stochastic solvers often reach a model in a fraction of the work — and every model they produce is re-checked
          against the original formula.
        </p>
      </div>
    </>
  )
}

// ----------------------------------------------------------------------------
// Phase-transition view
// ----------------------------------------------------------------------------
function PhaseView({ res }: { res: PhaseResult }) {
  return (
    <>
      <div className="imc-cards">
        <div className="imc-card">
          <h3>The satisfiability threshold</h3>
          <p>
            Random {res.k}-SAT on {res.numVars} variables, swept across the clause/variable ratio α. The fraction of
            satisfiable instances falls from ≈1 to ≈0 through a sharp transition near{' '}
            <strong>α ≈ {res.threshold}</strong> — a genuine phase transition.
          </p>
        </div>
        <div className="imc-card">
          <h3>Easy → hard → easy</h3>
          <p>Solver effort (CDCL conflicts, WalkSAT flips) is tiny away from the threshold and spikes into a peak right at it, where instances are critically constrained.</p>
        </div>
      </div>
      <div className="pb-panel">
        <h3>SAT probability &amp; solver effort vs. α</h3>
        <PhaseChart res={res} />
        {!res.completed && <p className="count-note">⚠ Sweep stopped early at the time budget; later α points may be missing.</p>}
      </div>
    </>
  )
}

// ----------------------------------------------------------------------------
// Charts (inline SVG, no dependencies)
// ----------------------------------------------------------------------------
function Trajectory({ data, title, sampleEvery, temps, solvedAtEnd }: { data: number[]; title: string; sampleEvery: number; temps?: number[]; solvedAtEnd: boolean }) {
  const W = 720
  const H = 240
  const padL = 44
  const padB = 28
  const padT = 12
  const padR = 12
  if (data.length === 0) return null
  const maxE = Math.max(1, ...data)
  const n = data.length
  const x = (i: number) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR)
  const y = (e: number) => padT + (1 - e / maxE) * (H - padT - padB)
  const path = data.map((e, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(e).toFixed(1)}`).join(' ')
  let tempPath = ''
  if (temps && temps.length === data.length) {
    const maxT = Math.max(1e-9, ...temps)
    tempPath = temps.map((t, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${(padT + (1 - t / maxT) * (H - padT - padB)).toFixed(1)}`).join(' ')
  }
  return (
    <div className="pb-panel">
      <h3>{title}</h3>
      <svg className="sls-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} className="sls-axis" />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} className="sls-axis" />
        <text x={4} y={y(maxE) + 4} className="sls-tick">{maxE}</text>
        <text x={4} y={y(0)} className="sls-tick">0</text>
        <text x={padL} y={H - 6} className="sls-tick">0</text>
        <text x={W - padR} y={H - 6} className="sls-tick" textAnchor="end">{(n * sampleEvery).toLocaleString()} flips</text>
        {tempPath && <path d={tempPath} className="sls-line-temp" fill="none" />}
        <path d={path} className="sls-line-energy" fill="none" />
        {solvedAtEnd && <circle cx={x(n - 1)} cy={y(0)} r={4} className="sls-solved-dot" />}
      </svg>
      {temps && <p className="count-note"><span className="sls-leg sls-leg-energy">energy</span> unsatisfied clauses · <span className="sls-leg sls-leg-temp">T</span> temperature (cooling left→right).</p>}
    </div>
  )
}

function BiasField({ biases }: { biases: { v: number; wPlus: number; wMinus: number; wZero: number }[] }) {
  const W = 720
  const H = 180
  const padB = 16
  const n = biases.length
  const bw = (W) / n
  return (
    <svg className="sls-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {biases.map((b, i) => {
        const x = i * bw
        const hPos = b.wPlus * (H - padB)
        const hZero = b.wZero * (H - padB)
        const hNeg = b.wMinus * (H - padB)
        let yy = 0
        const segs = [
          { h: hPos, cls: 'sls-bar-pos' },
          { h: hZero, cls: 'sls-bar-zero' },
          { h: hNeg, cls: 'sls-bar-neg' },
        ]
        return (
          <g key={b.v}>
            {segs.map((s, k) => {
              const rect = <rect key={k} x={x.toFixed(1)} y={yy.toFixed(1)} width={Math.max(0.5, bw - 0.3).toFixed(2)} height={Math.max(0, s.h).toFixed(1)} className={s.cls} />
              yy += s.h
              return rect
            })}
          </g>
        )
      })}
    </svg>
  )
}

function PhaseChart({ res }: { res: PhaseResult }) {
  const W = 720
  const H = 300
  const padL = 44
  const padR = 48
  const padB = 34
  const padT = 14
  const pts = res.points
  if (pts.length === 0) return null
  const aMin = pts[0].alpha
  const aMax = pts[pts.length - 1].alpha
  const x = (a: number) => padL + ((a - aMin) / Math.max(1e-9, aMax - aMin)) * (W - padL - padR)
  const ySat = (p: number) => padT + (1 - p) * (H - padT - padB)
  const maxEffort = Math.max(1, ...pts.map((p) => p.medianConflicts))
  const yEff = (c: number) => padT + (1 - c / maxEffort) * (H - padT - padB)
  const satPath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.alpha).toFixed(1)},${ySat(p.satFraction).toFixed(1)}`).join(' ')
  const effPath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.alpha).toFixed(1)},${yEff(p.medianConflicts).toFixed(1)}`).join(' ')
  const thr = res.threshold
  return (
    <>
      <svg className="sls-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} className="sls-axis" />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} className="sls-axis" />
        <line x1={W - padR} y1={padT} x2={W - padR} y2={H - padB} className="sls-axis" />
        {/* gridlines for SAT fraction */}
        {[0, 0.5, 1].map((p) => (
          <g key={p}>
            <line x1={padL} y1={ySat(p)} x2={W - padR} y2={ySat(p)} className="sls-grid" />
            <text x={padL - 6} y={ySat(p) + 4} className="sls-tick" textAnchor="end">{p}</text>
          </g>
        ))}
        {thr > 0 && aMin <= thr && thr <= aMax && (
          <g>
            <line x1={x(thr)} y1={padT} x2={x(thr)} y2={H - padB} className="sls-threshold" />
            <text x={x(thr) + 4} y={padT + 12} className="sls-tick">α≈{thr}</text>
          </g>
        )}
        {/* α ticks */}
        {pts.filter((_, i) => i % 3 === 0).map((p) => (
          <text key={p.alpha} x={x(p.alpha)} y={H - padB + 16} className="sls-tick" textAnchor="middle">{p.alpha.toFixed(1)}</text>
        ))}
        <text x={(padL + W - padR) / 2} y={H - 4} className="sls-axis-label" textAnchor="middle">clause / variable ratio α</text>
        <path d={effPath} className="sls-line-effort" fill="none" />
        <path d={satPath} className="sls-line-sat" fill="none" />
        {pts.map((p) => <circle key={'s' + p.alpha} cx={x(p.alpha)} cy={ySat(p.satFraction)} r={2.5} className="sls-dot-sat" />)}
        {pts.map((p) => <circle key={'e' + p.alpha} cx={x(p.alpha)} cy={yEff(p.medianConflicts)} r={2} className="sls-dot-effort" />)}
      </svg>
      <p className="count-note">
        <span className="sls-leg sls-leg-sat">P(sat)</span> fraction satisfiable (left axis, the threshold) ·{' '}
        <span className="sls-leg sls-leg-effort">effort</span> median CDCL conflicts (right axis, the easy–hard–easy peak).
        WalkSAT solved {(avgAgreement(pts) * 100).toFixed(0)}% of the satisfiable instances it was handed.
      </p>
    </>
  )
}

function avgAgreement(pts: PhaseResult['points']): number {
  if (pts.length === 0) return 1
  return pts.reduce((s, p) => s + p.slsAgreement, 0) / pts.length
}

function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo
  return Math.max(lo, Math.min(hi, x))
}
function clampInt(x: number, lo: number, hi: number): number {
  return Math.round(clamp(x, lo, hi))
}
