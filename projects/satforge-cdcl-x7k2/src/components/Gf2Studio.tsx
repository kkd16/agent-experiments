import { useMemo, useState } from 'react'
import './Gf2Studio.css'
import {
  GF2_EXAMPLES,
  solveMixed,
  xorSystem,
  xorToClauses,
  rref,
  rrefTrace,
  solutionCount,
  linearBackbone,
  parseXorDimacs,
  parseXorDsl,
  toXorDimacs,
  runGf2Checks,
  solveLightsOut,
  applyPresses,
  quietDimension,
  randomLfsr,
  runLfsr,
  breakLfsr,
  mulberry32,
  type XorCnf,
  type MixedResult,
  type Gf2CheckReport,
  type ParseXorResult,
} from '../gf2'

type Panel = 'solve' | 'reduce' | 'lights' | 'lfsr' | 'checks'

const PANELS: { id: Panel; label: string }[] = [
  { id: 'solve', label: 'Solve' },
  { id: 'reduce', label: 'Reduce' },
  { id: 'lights', label: 'Lights Out' },
  { id: 'lfsr', label: 'Break an LFSR' },
  { id: 'checks', label: 'Self-tests' },
]

const DEFAULT_SRC = `c Two secrets and a parity leak — recover them.
c   x1 ⊕ x2 ⊕ x3 = 1
c   x2 ⊕ x3      = 0
c   x1 ⊕ x3      = 1
x 1 2 3 0
x -2 3 0
x 1 3 0`

// ────────────────────────────────────────────────────────────────────────────
export function Gf2Studio() {
  const [panel, setPanel] = useState<Panel>('solve')
  return (
    <div className="layout gf2">
      <aside className="panel gf2-side">
        <h2>XOR / GF(2) Studio</h2>
        <p className="gf2-intro">
          Parity constraints are <strong>linear algebra over 𝔽₂</strong>. Gaussian elimination decides,
          counts and solves a whole XOR system in one reduction — annihilating structure that pure clause
          search (CDCL) blows up on exponentially. This is the engine inside solvers like CryptoMiniSat.
        </p>
        <div className="gf2-navcol">
          {PANELS.map((p) => (
            <button key={p.id} className={panel === p.id ? 'active' : ''} onClick={() => setPanel(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="gf2-legend">
          <h3>The idea in one line</h3>
          <p>
            <code>⊕ xᵢ = b</code> is a linear equation. <code>n</code> variables, rank <code>r</code> ⇒
            exactly <code>2ⁿ⁻ʳ</code> solutions (or none). Everything else — a model, the backbone, the null
            space — falls straight out of the reduced matrix.
          </p>
        </div>
      </aside>
      <main className="content gf2-main">
        {panel === 'solve' && <SolvePanel />}
        {panel === 'reduce' && <ReducePanel />}
        {panel === 'lights' && <LightsPanel />}
        {panel === 'lfsr' && <LfsrPanel />}
        {panel === 'checks' && <ChecksPanel />}
      </main>
    </div>
  )
}

// ── shared: parse the editor into an XorCnf ─────────────────────────────────
function useProblem(src: string, dsl: boolean): { parsed: ParseXorResult } {
  return useMemo(() => ({ parsed: dsl ? parseXorDsl(src) : parseXorDimacs(src) }), [src, dsl])
}

function statusClass(s: string) {
  return s === 'sat' ? 'sat' : s === 'unsat' ? 'unsat' : 'unknown'
}

// ── Solve panel: hybrid engine + head-to-head vs clause search ──────────────
function SolvePanel() {
  const [src, setSrc] = useState(DEFAULT_SRC)
  const [dsl, setDsl] = useState(false)
  const { parsed } = useProblem(src, dsl)

  const analysis = useMemo(() => {
    if (!parsed.ok) return null
    const p = parsed.problem
    const gauss = solveMixed(p, { budget: 2_000_000 })
    // Head-to-head: expand XORs to clauses, run the SAME engine with no linear reasoning.
    const expandedSize = p.xors.reduce((a, x) => a + (x.vars.length === 0 ? 0 : 1 << (x.vars.length - 1)), 0)
    let clausal: MixedResult | null = null
    if (expandedSize <= 200_000) {
      const clauses = p.clauses.concat(...p.xors.map((x) => xorToClauses(x)))
      clausal = solveMixed({ numVars: p.numVars, clauses, xors: [] }, { budget: 300_000 })
    }
    const sys = xorSystem(p)
    const count = p.clauses.length === 0 ? solutionCount(sys) : null
    const rr = rref(sys)
    const backbone = linearBackbone(rr)
    return { p, gauss, clausal, expandedSize, count, rank: rr.rank, backbone }
  }, [parsed])

  const loadExample = (i: number) => {
    setDsl(false)
    setSrc(toXorDimacs(GF2_EXAMPLES[i].make()))
  }

  return (
    <>
      <div className="problem-head">
        <div>
          <h2>Hybrid DPLL(⊕) — clauses and parity, together</h2>
          <p className="subtitle">
            Unit propagation and Gaussian elimination cooperate on one assignment. Watch what the linear
            propagator saves.
          </p>
        </div>
        {analysis && (
          <span className={`status-pill ${statusClass(analysis.gauss.status)}`}>
            {analysis.gauss.status.toUpperCase()}
          </span>
        )}
      </div>

      <div className="gf2-examples">
        {GF2_EXAMPLES.map((e, i) => (
          <button key={e.name} title={e.blurb} onClick={() => loadExample(i)}>
            {e.name}
          </button>
        ))}
      </div>

      <div className="gf2-editor">
        <div className="gf2-editor-head">
          <label>{dsl ? 'DSL — one constraint per line, e.g. x1 ^ x2 ^ x3 = 1' : 'Extended DIMACS — “x …” lines are XOR clauses'}</label>
          <label className="gf2-toggle">
            <input type="checkbox" checked={dsl} onChange={(e) => setDsl(e.target.checked)} /> DSL mode
          </label>
        </div>
        <textarea value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} rows={8} />
        {!parsed.ok && <div className="banner error">⚠ line {parsed.line}: {parsed.error}</div>}
        {parsed.ok && parsed.warnings.length > 0 && <div className="banner warn">{parsed.warnings.join('; ')}</div>}
      </div>

      {analysis && (
        <>
          <div className="gf2-cards">
            <div className={`gf2-card gf2-hero ${statusClass(analysis.gauss.status)}`}>
              <span className="gf2-card-k">Hybrid solver (with Gauss)</span>
              <strong className="gf2-verdict">{analysis.gauss.status.toUpperCase()}</strong>
              <div className="gf2-statgrid">
                <span>decisions</span><b>{analysis.gauss.stats.decisions}</b>
                <span>gauss props</span><b>{analysis.gauss.stats.gaussProps}</b>
                <span>rref calls</span><b>{analysis.gauss.stats.gaussReductions}</b>
                <span>conflicts</span><b>{analysis.gauss.stats.conflicts}</b>
              </div>
            </div>
            <div className="gf2-card">
              <span className="gf2-card-k">Same engine, no linear reasoning (XORs → clauses)</span>
              {analysis.clausal ? (
                <>
                  <strong className={`gf2-verdict small ${statusClass(analysis.clausal.status)}`}>
                    {analysis.clausal.status === 'unknown' ? 'GAVE UP' : analysis.clausal.status.toUpperCase()}
                  </strong>
                  <div className="gf2-statgrid">
                    <span>clauses</span><b>{analysis.expandedSize + analysis.p.clauses.length}</b>
                    <span>decisions</span><b>{analysis.clausal.stats.decisions}</b>
                    <span>conflicts</span><b>{analysis.clausal.stats.conflicts}</b>
                    <span>budget hit</span><b>{analysis.clausal.stats.budgetHit ? 'yes' : 'no'}</b>
                  </div>
                  <Speedup a={analysis.clausal.stats.conflicts + analysis.clausal.stats.decisions} b={analysis.gauss.stats.decisions + analysis.gauss.stats.conflicts} />
                </>
              ) : (
                <p className="gf2-note">The clausal expansion is too large to build (parity gadgets are 2^(k−1) clauses). That blow-up is exactly why linear reasoning matters.</p>
              )}
            </div>
          </div>

          <div className="gf2-cards">
            {analysis.count !== null && (
              <div className="gf2-card">
                <span className="gf2-card-k">Exact solution count (closed form)</span>
                <strong className="gf2-count">{analysis.count.toString()}</strong>
                <p className="gf2-note">2^(n−rank), n={analysis.p.numVars}, rank={analysis.rank}. No search — pure rank.</p>
              </div>
            )}
            {analysis.gauss.status === 'sat' && (
              <div className="gf2-card gf2-model">
                <span className="gf2-card-k">A model</span>
                <div className="gf2-chips">
                  {analysis.gauss.model!.slice(1).map((b, i) => (
                    <span key={i} className={`gf2-lit ${b ? 'on' : 'off'}`}>x{i + 1}={b ? 1 : 0}</span>
                  ))}
                </div>
              </div>
            )}
            {analysis.backbone.length > 0 && (
              <div className="gf2-card gf2-model">
                <span className="gf2-card-k">Linear backbone — forced by parity alone</span>
                <div className="gf2-chips">
                  {analysis.backbone.map(({ var: v, value }) => (
                    <span key={v} className={`gf2-lit forced ${value ? 'on' : 'off'}`}>x{v + 1}={value ? 1 : 0}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

function Speedup({ a, b }: { a: number; b: number }) {
  if (b <= 0 || a <= b) return null
  const factor = a / Math.max(1, b)
  return <div className="gf2-speedup">Gauss did <strong>{factor >= 100 ? Math.round(factor) : factor.toFixed(1)}×</strong> less search work.</div>
}

// ── Reduce panel: animated Gauss–Jordan on the XOR matrix ────────────────────
function ReducePanel() {
  const [src, setSrc] = useState(toXorDimacs(GF2_EXAMPLES[3].make()))
  const parsed = useMemo(() => parseXorDimacs(src), [src])
  const problem: XorCnf | null = parsed.ok ? parsed.problem : null
  const trace = useMemo(() => (problem ? rrefTrace(xorSystem(problem)) : null), [problem])
  const [step, setStep] = useState(0)
  const shown = useMemo(() => {
    if (!trace) return null
    if (step === 0) return { matrix: trace.initial, pivotCol: -1, pivotRow: -1, note: 'the augmented matrix, before reduction' }
    const s = trace.steps[Math.min(step - 1, trace.steps.length - 1)]
    return s
  }, [trace, step])

  const loadExample = (i: number) => {
    setSrc(toXorDimacs(GF2_EXAMPLES[i].make()))
    setStep(0)
  }

  const maxStep = trace ? trace.steps.length : 0

  return (
    <>
      <div className="problem-head">
        <div>
          <h2>Gauss–Jordan, one pivot at a time</h2>
          <p className="subtitle">Each pivot clears its column from every other equation. When the dust settles, the answer is just the shape of the matrix.</p>
        </div>
        {trace && (
          <span className={`status-pill ${trace.inconsistent ? 'unsat' : 'sat'}`}>
            {trace.inconsistent ? 'INCONSISTENT' : `${(1n << BigInt(trace.numVars - trace.rank)).toString()} SOLUTIONS`}
          </span>
        )}
      </div>

      <div className="gf2-examples">
        {GF2_EXAMPLES.map((e, i) => (
          <button key={e.name} title={e.blurb} onClick={() => loadExample(i)}>{e.name}</button>
        ))}
      </div>

      <div className="gf2-editor">
        <label>Extended DIMACS — the “x …” lines are the parity equations reduced below</label>
        <textarea value={src} onChange={(e) => { setSrc(e.target.value); setStep(0) }} spellCheck={false} rows={6} />
        {!parsed.ok && <div className="banner error">⚠ line {parsed.line}: {parsed.error}</div>}
      </div>

      {trace && shown && (
        <>
          <div className="gf2-stepper">
            <button onClick={() => setStep(0)} disabled={step === 0}>⏮</button>
            <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>◀ prev</button>
            <input type="range" min={0} max={maxStep} value={step} onChange={(e) => setStep(Number(e.target.value))} />
            <button onClick={() => setStep((s) => Math.min(maxStep, s + 1))} disabled={step >= maxStep}>next ▶</button>
            <button onClick={() => setStep(maxStep)} disabled={step >= maxStep}>⏭</button>
            <span className="gf2-stepcount">{step} / {maxStep}</span>
          </div>
          <p className="gf2-note gf2-stepnote">{'note' in shown ? shown.note : ''}</p>
          <Matrix matrix={shown.matrix} numVars={trace.numVars} pivotRow={'pivotRow' in shown ? shown.pivotRow : -1} pivotCol={'pivotCol' in shown ? shown.pivotCol : -1} />
          <div className="gf2-cards">
            <div className="gf2-card">
              <span className="gf2-card-k">Reading the reduced matrix</span>
              <div className="gf2-statgrid">
                <span>variables (n)</span><b>{trace.numVars}</b>
                <span>rank (r)</span><b>{trace.rank}</b>
                <span>free variables</span><b>{trace.freeVars.length}</b>
                <span>solutions</span><b>{trace.inconsistent ? '0' : (1n << BigInt(trace.numVars - trace.rank)).toString()}</b>
              </div>
              {trace.inconsistent && <p className="gf2-note">A row reduced to <code>0 = 1</code> — an algebraic proof of UNSAT, found without any search.</p>}
              {!trace.inconsistent && trace.freeVars.length > 0 && (
                <p className="gf2-note">Free: {trace.freeVars.map((v) => `x${v + 1}`).join(', ')} — each independent choice doubles the solution set.</p>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}

function Matrix({ matrix, numVars, pivotRow, pivotCol }: { matrix: number[][]; numVars: number; pivotRow: number; pivotCol: number }) {
  if (matrix.length === 0) return <p className="gf2-note">No equations.</p>
  return (
    <div className="gf2-matrix-wrap">
      <table className="gf2-matrix">
        <thead>
          <tr>
            {Array.from({ length: numVars }, (_, c) => (
              <th key={c} className={c === pivotCol ? 'pivotcol' : ''}>x{c + 1}</th>
            ))}
            <th className="rhs">=</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, r) => (
            <tr key={r} className={r === pivotRow ? 'pivotrow' : ''}>
              {row.slice(0, numVars).map((v, c) => (
                <td key={c} className={`${v ? 'one' : 'zero'} ${r === pivotRow && c === pivotCol ? 'pivot' : ''}`}>{v}</td>
              ))}
              <td className={`rhs ${row[numVars] ? 'one' : 'zero'}`}>{row[numVars]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Lights Out panel ─────────────────────────────────────────────────────────
function LightsPanel() {
  const [rows, setRows] = useState(5)
  const [cols, setCols] = useState(5)
  const [board, setBoard] = useState<boolean[]>(() => new Array(25).fill(false))
  const [showPresses, setShowPresses] = useState(true)

  const resize = (r: number, c: number) => {
    setRows(r)
    setCols(c)
    setBoard(new Array(r * c).fill(false))
  }
  const toggleCell = (i: number) => setBoard((b) => b.map((v, j) => (j === i ? !v : v)))
  const randomize = () => {
    const rng = mulberry32((Date.now() & 0xffff) ^ (rows * 131 + cols * 17))
    const presses = Array.from({ length: rows * cols }, () => rng() < 0.5)
    setBoard(applyPresses(rows, cols, new Array(rows * cols).fill(false), presses))
  }

  const sol = useMemo(() => solveLightsOut(rows, cols, board), [rows, cols, board])
  const litCount = board.reduce((a, b) => a + (b ? 1 : 0), 0)

  return (
    <>
      <div className="problem-head">
        <div>
          <h2>Lights Out — a puzzle that is a linear system</h2>
          <p className="subtitle">Pressing a cell XOR-toggles it and its neighbours. “Which buttons clear the board?” is <code>A·p = b</code>.</p>
        </div>
        <span className={`status-pill ${sol.solvable ? 'sat' : 'unsat'}`}>{sol.solvable ? 'SOLVABLE' : 'UNSOLVABLE'}</span>
      </div>

      <div className="gf2-lights-controls">
        <div className="gf2-sizes">
          {[[3, 3], [4, 4], [5, 5], [6, 6], [5, 7]].map(([r, c]) => (
            <button key={`${r}x${c}`} className={r === rows && c === cols ? 'active' : ''} onClick={() => resize(r, c)}>{r}×{c}</button>
          ))}
        </div>
        <button onClick={randomize}>🎲 random position</button>
        <button onClick={() => setBoard(new Array(rows * cols).fill(false))}>clear</button>
        {sol.solvable && <button onClick={() => setBoard(applyPresses(rows, cols, board, sol.minPresses!))}>▶ apply solution</button>}
        <label className="gf2-toggle"><input type="checkbox" checked={showPresses} onChange={(e) => setShowPresses(e.target.checked)} /> mark presses</label>
      </div>

      <div className="gf2-lights-board" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, maxWidth: cols * 62 }}>
        {board.map((lit, i) => {
          const press = showPresses && sol.solvable && sol.minPresses![i]
          return (
            <button key={i} className={`gf2-cell ${lit ? 'lit' : ''} ${press ? 'press' : ''}`} onClick={() => toggleCell(i)}>
              {press ? '●' : ''}
            </button>
          )
        })}
      </div>

      <div className="gf2-cards">
        <div className="gf2-card">
          <span className="gf2-card-k">This position</span>
          <div className="gf2-statgrid">
            <span>lit cells</span><b>{litCount}</b>
            <span>min presses</span><b>{sol.solvable ? sol.minCount : '—'}</b>
            <span>distinct solutions</span><b>{sol.solutionCount.toString()}</b>
            <span>quiet patterns</span><b>{sol.quietPatterns.length}</b>
          </div>
          <p className="gf2-note">
            Every {rows}×{cols} board has a <b>{quietDimension(rows, cols)}</b>-dimensional space of “quiet” press
            sets that do nothing — so a solvable position has exactly {sol.solutionCount.toString()} solutions, and we
            pick the lightest. Click cells to author a position; <em>apply solution</em> proves it clears.
          </p>
        </div>
      </div>
    </>
  )
}

// ── LFSR panel ───────────────────────────────────────────────────────────────
function LfsrPanel() {
  const [length, setLength] = useState(10)
  const [seedNum, setSeedNum] = useState(1)
  const [observed, setObserved] = useState(20)

  const spec = useMemo(() => randomLfsr(length, seedNum), [length, seedNum])
  const full = useMemo(() => runLfsr(spec, Math.max(observed, 2 * length + 6)), [spec, observed, length])
  const keystream = full.slice(0, observed)
  const broken = useMemo(() => breakLfsr(length, spec.taps, keystream), [length, spec.taps, keystream])
  const recovered = broken.seed
  const correct = recovered !== null && recovered.join('') === spec.seed.join('')

  return (
    <>
      <div className="problem-head">
        <div>
          <h2>Breaking a stream cipher with linear algebra</h2>
          <p className="subtitle">An LFSR's every output bit is a linear function of its secret seed. Observe ~L bits and Gauss recovers the key.</p>
        </div>
        <span className={`status-pill ${broken.unique ? (correct ? 'sat' : 'unsat') : 'unknown'}`}>
          {broken.unique ? (correct ? 'SEED RECOVERED' : 'MISMATCH') : 'UNDER-DETERMINED'}
        </span>
      </div>

      <div className="gf2-lfsr-controls">
        <label>register length L
          <input type="range" min={4} max={24} value={length} onChange={(e) => { setLength(Number(e.target.value)); setObserved((o) => Math.max(o, Number(e.target.value) + 2)) }} />
          <b>{length}</b>
        </label>
        <label>observed output bits
          <input type="range" min={2} max={48} value={observed} onChange={(e) => setObserved(Number(e.target.value))} />
          <b>{observed}</b>
        </label>
        <button onClick={() => setSeedNum((s) => s + 1)}>🎲 new secret</button>
      </div>

      <div className="gf2-cards">
        <div className="gf2-card">
          <span className="gf2-card-k">The register</span>
          <p className="gf2-note">taps (XOR feedback): {spec.taps.map((t) => `c${t}`).join(' ⊕ ')} → new bit</p>
          <div className="gf2-bits">
            {spec.seed.map((b, i) => <span key={i} className={`gf2-bit secret ${b ? 'on' : 'off'}`}>{b}</span>)}
          </div>
          <span className="gf2-bitlabel">↑ the secret seed (hidden from the attacker)</span>
        </div>
        <div className="gf2-card">
          <span className="gf2-card-k">Observed keystream ({observed} bits)</span>
          <div className="gf2-bits stream">
            {keystream.map((b, i) => <span key={i} className={`gf2-bit ${b ? 'on' : 'off'}`}>{b}</span>)}
          </div>
        </div>
      </div>

      <div className="gf2-cards">
        <div className={`gf2-card ${broken.unique ? (correct ? 'sat' : 'unsat') : ''}`}>
          <span className="gf2-card-k">Gaussian recovery</span>
          <div className="gf2-statgrid">
            <span>equations</span><b>{observed}</b>
            <span>rank</span><b>{broken.rank} / {length}</b>
            <span>unique?</span><b>{broken.unique ? 'yes' : 'no — need more bits'}</b>
            <span>correct?</span><b>{broken.unique ? (correct ? '✓ verified' : '✗') : '—'}</b>
          </div>
          {recovered && (
            <>
              <div className="gf2-bits">
                {recovered.map((b, i) => <span key={i} className={`gf2-bit rec ${b ? 'on' : 'off'} ${spec.seed[i] === b ? '' : 'wrong'}`}>{b}</span>)}
              </div>
              <span className="gf2-bitlabel">↑ recovered seed{correct ? ' — matches the secret exactly' : ''}</span>
            </>
          )}
          {!broken.unique && <p className="gf2-note">With rank &lt; L the seed isn't pinned yet — drag “observed output bits” up until the rank reaches {length}.</p>}
        </div>
      </div>
    </>
  )
}

// ── Self-tests panel ─────────────────────────────────────────────────────────
function ChecksPanel() {
  const [report, setReport] = useState<Gf2CheckReport | null>(null)
  const [running, setRunning] = useState(false)
  const run = () => {
    setRunning(true)
    setTimeout(() => {
      setReport(runGf2Checks())
      setRunning(false)
    }, 20)
  }
  return (
    <>
      <div className="problem-head">
        <div>
          <h2>Differential self-check</h2>
          <p className="subtitle">Every claim here is cross-checked against an independent oracle — brute force, the project's clausal CDCL, and its exact #SAT counter.</p>
        </div>
        {report && <span className={`status-pill ${report.fail === 0 ? 'sat' : 'unsat'}`}>{report.fail === 0 ? `${report.pass}/${report.pass} PASS` : `${report.fail} FAIL`}</span>}
      </div>
      <div className="gf2-cards">
        <div className="gf2-card">
          <span className="gf2-card-k">Oracles</span>
          <p className="gf2-note">
            The 𝔽₂ core is pinned against brute-force enumeration and its own closed form; the hybrid DPLL(⊕)
            against the clausal CDCL on the expanded formula (verdict + valid models) and against exact #SAT;
            the expand↔recover bridge to the identity; Tseitin formulas to their total-charge oracle; Lights Out
            by actually clearing the board; and each recovered LFSR seed by regenerating its keystream.
          </p>
          <button className="gf2-runbtn" onClick={run} disabled={running}>{running ? 'Running…' : '▶ Run self-check'}</button>
        </div>
      </div>
      {report && (
        <div className={`gf2-check ${report.fail === 0 ? 'ok' : 'bad'}`}>
          <ul>
            {report.messages.map((m, i) => (
              <li key={i} className={m.startsWith('✓') ? 'ok' : 'bad'}>{m}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
