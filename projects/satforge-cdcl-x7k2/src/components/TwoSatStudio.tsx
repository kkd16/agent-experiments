import { useMemo, useState } from 'react'
import './TwoSatStudio.css'
import { parseDimacs, toDimacs, verifyModel, type CNF } from '../sat/cnf'
import { solve } from '../sat/solver'
import {
  decide2Sat,
  is2Cnf,
  wideClauses,
  binaryCore,
  layoutImplication,
  layoutCondensation,
  compColor,
  litLabel,
  runTwoSatChecks,
  TWO_SAT_EXAMPLES,
  randomTwoSat,
  type TwoSatResult,
  type TwoSatCheckReport,
} from '../twosat'

type Source = { kind: 'example'; index: number } | { kind: 'random' } | { kind: 'custom' }

interface RandomParams {
  n: number
  ratio: number
  seed: number
}
const DEFAULT_RANDOM: RandomParams = { n: 7, ratio: 1.0, seed: 7 }

interface ParseOk {
  ok: true
  /** The 2-CNF actually decided (the binary core when wider clauses were dropped). */
  cnf: CNF
  /** The full formula as parsed (== cnf unless wider clauses were dropped). */
  original: CNF
  /** How many wider clauses were dropped to form the binary core. */
  dropped: number
  warnings: string[]
}
interface ParseFail {
  ok: false
  error: string
}

function parse(src: string, coreMode: boolean): ParseOk | ParseFail {
  try {
    const { cnf, warnings } = parseDimacs(src)
    if (cnf.numVars === 0) return { ok: false, error: 'No variables — add some clauses.' }
    if (!is2Cnf(cnf)) {
      const wide = wideClauses(cnf)
      if (!coreMode) {
        return {
          ok: false,
          error: `Not a 2-CNF: ${wide.length} clause${wide.length === 1 ? '' : 's'} have more than two literals. Enable "decide the binary core" below to project to the implication-graph skeleton, or edit the formula.`,
        }
      }
      const core = binaryCore(cnf)
      if (core.cnf.clauses.length === 0)
        return { ok: false, error: 'The binary core is empty — no unit or binary clauses to build a graph from.' }
      return { ok: true, cnf: core.cnf, original: cnf, dropped: core.dropped, warnings }
    }
    return { ok: true, cnf, original: cnf, dropped: 0, warnings }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
  }
}

export function TwoSatStudio() {
  const [source, setSource] = useState<Source>({ kind: 'example', index: 0 })
  const [src, setSrc] = useState<string>(() => toDimacs(TWO_SAT_EXAMPLES[0].cnf))
  const [rand, setRand] = useState<RandomParams>(DEFAULT_RANDOM)
  const [coreMode, setCoreMode] = useState(false)
  const [checks, setChecks] = useState<TwoSatCheckReport | null>(null)
  const [checking, setChecking] = useState(false)

  const parsed = useMemo(() => parse(src, coreMode), [src, coreMode])
  const result = useMemo<TwoSatResult | null>(
    () => (parsed.ok ? decide2Sat(parsed.cnf) : null),
    [parsed],
  )
  // Cross-check against the project's complete CDCL solver — always on the FULL
  // formula, so in binary-core mode it judges what the core can only bound.
  const cdcl = useMemo(
    () => (parsed.ok ? solve(parsed.original).status : null),
    [parsed],
  )

  const blurb =
    source.kind === 'example'
      ? TWO_SAT_EXAMPLES[source.index].blurb
      : source.kind === 'random'
        ? `A random 2-CNF with ${rand.n} variables at clause/variable ratio ${rand.ratio.toFixed(2)}. Random 2-SAT flips from almost-always satisfiable to almost-always unsatisfiable as the ratio crosses 1 — sweep it in the phase-transition explorer below.`
        : 'Your own 2-CNF in DIMACS (every clause a unit or a pair of literals).'

  const pickExample = (index: number) => {
    setSource({ kind: 'example', index })
    setSrc(toDimacs(TWO_SAT_EXAMPLES[index].cnf))
  }
  const genRandom = (p: RandomParams) => {
    setRand(p)
    setSource({ kind: 'random' })
    const m = Math.max(1, Math.round(p.ratio * p.n))
    setSrc(toDimacs(randomTwoSat(p.n, m, p.seed)))
  }
  const onEdit = (text: string) => {
    setSrc(text)
    setSource({ kind: 'custom' })
  }

  const runVerify = () => {
    setChecking(true)
    setTimeout(() => {
      setChecks(runTwoSatChecks())
      setChecking(false)
    }, 30)
  }

  const verdictClass = result == null ? '' : result.sat ? 'sat' : 'unsat'
  const verdictLabel = result == null ? '' : result.sat ? 'SATISFIABLE' : 'UNSATISFIABLE'

  return (
    <div className="layout">
      <aside className="control twosat-side">
        <p className="imc-blurb">
          <strong>2-SAT</strong> is the satisfiable corner of SAT: with at most two literals per
          clause it is decidable in <strong>linear time</strong>. Each clause{' '}
          <code>(a ∨ b)</code> is two implications <code>¬a ⇒ b</code> and <code>¬b ⇒ a</code>; the
          whole question collapses to the <strong>strongly-connected components</strong> of that
          implication graph (Aspvall–Plass–Tarjan). It is <strong>UNSAT</strong> exactly when some
          variable shares an SCC with its own negation, and otherwise a model is read straight off
          the component order. Every verdict here is cross-checked against the studio's complete CDCL
          solver.
        </p>

        <div className="smt-examples">
          <h3>Examples</h3>
          <ul>
            {TWO_SAT_EXAMPLES.map((ex, i) => (
              <li key={ex.name}>
                <button
                  className={source.kind === 'example' && source.index === i ? 'active' : ''}
                  onClick={() => pickExample(i)}
                >
                  {ex.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="twosat-random">
          <h3>Random generator</h3>
          <div className="twosat-rand-grid">
            <label>
              variables
              <input
                type="number"
                min={2}
                max={16}
                value={rand.n}
                onChange={(e) => genRandom({ ...rand, n: clamp(+e.target.value, 2, 16) })}
              />
            </label>
            <label>
              ratio m/n
              <input
                type="number"
                step={0.1}
                min={0.1}
                max={3}
                value={rand.ratio}
                onChange={(e) => genRandom({ ...rand, ratio: clamp(+e.target.value, 0.1, 3) })}
              />
            </label>
            <button
              className="twosat-reroll"
              onClick={() => genRandom({ ...rand, seed: (rand.seed * 1103515245 + 12345) & 0x7fffffff })}
            >
              ↻ reroll seed
            </button>
          </div>
        </div>

        <div className="twosat-selftest">
          <h3>Self-test</h3>
          <p>
            Cross-checks <code>decide2Sat</code> against the CDCL solver and an exhaustive
            brute-force oracle — verdict, model, equivalence classes and backbone.
          </p>
          <button onClick={runVerify} disabled={checking}>
            {checking ? 'Running…' : '▶ Run self-test'}
          </button>
          {checks && (
            <div className={`twosat-check ${checks.fail === 0 ? 'ok' : 'bad'}`}>
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
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>2-SAT Studio</h2>
            <p className="subtitle">{blurb}</p>
          </div>
          {result && <span className={`status-pill ${verdictClass}`}>{verdictLabel}</span>}
        </div>

        <div className="twosat-editor">
          <label>DIMACS — every clause a unit or a pair, terminated by 0</label>
          <textarea value={src} onChange={(e) => onEdit(e.target.value)} spellCheck={false} rows={7} />
          <label className="twosat-coremode">
            <input type="checkbox" checked={coreMode} onChange={(e) => setCoreMode(e.target.checked)} />
            decide the <strong>binary core</strong> of wider clauses (units + pairs only)
          </label>
          {!parsed.ok && <div className="banner error">⚠ {parsed.error}</div>}
          {parsed.ok && parsed.dropped > 0 && (
            <div className="banner warn">
              Binary core: {parsed.dropped} wider clause{parsed.dropped === 1 ? '' : 's'} dropped.
              The core is a <em>one-way</em> test — if it is UNSAT the whole formula is UNSAT; if it
              is satisfiable the result is inconclusive for the full formula.
            </div>
          )}
          {parsed.ok &&
            parsed.warnings.map((w, i) => (
              <div key={i} className="banner warn">
                {w}
              </div>
            ))}
        </div>

        {result && parsed.ok && (
          <Results result={result} cnf={parsed.cnf} cdcl={cdcl} dropped={parsed.dropped} />
        )}
        {!result && (
          <div className="placeholder">
            <p>Write a 2-CNF (or pick an example) — it is decided live.</p>
          </div>
        )}

        <PhaseExplorer />
      </main>
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

function Results({
  result,
  cnf,
  cdcl,
  dropped,
}: {
  result: TwoSatResult
  cnf: CNF
  cdcl: 'sat' | 'unsat' | 'unknown' | null
  dropped: number
}) {
  const modelOk = result.model ? verifyModel(cnf, result.model).ok : false
  const coreMode = dropped > 0
  // In strict mode the core IS the formula, so the verdicts must agree. In
  // binary-core mode they need only agree when the core is UNSAT (a sound
  // refutation of the full formula); a satisfiable core is inconclusive.
  const cdclAgrees =
    cdcl == null ? null : coreMode ? (result.sat ? null : cdcl === 'unsat') : (cdcl === 'sat') === result.sat
  const conflictComp =
    result.conflictVar != null ? result.comp[2 * (result.conflictVar - 1)] : -1

  return (
    <>
      <div className="imc-cards">
        <div className="imc-card">
          <h3>Verdict</h3>
          <p>
            The formula is <strong>{result.sat ? 'SATISFIABLE' : 'UNSATISFIABLE'}</strong>.{' '}
            {result.sat ? (
              <>A model is read directly off the SCC condensation.</>
            ) : (
              <>
                Variable <code>{litLabel(result.conflictVar!)}</code> shares a strongly-connected
                component with <code>{litLabel(-result.conflictVar!)}</code> — so{' '}
                <code>x{result.conflictVar} ⇔ ¬x{result.conflictVar}</code>, a contradiction.
              </>
            )}
          </p>
        </div>
        <div className="imc-card oracle">
          <h3>CDCL cross-check</h3>
          <p>
            The complete CDCL solver reports <strong>{cdcl?.toUpperCase()}</strong> on the{' '}
            {coreMode ? 'full formula' : 'formula'}.{' '}
            {coreMode && result.sat ? (
              <span className="twosat-inconclusive">satisfiable core — inconclusive</span>
            ) : (
              <span className={cdclAgrees ? 'check-ok' : 'check-bad'}>
                {cdclAgrees ? (coreMode ? '✓ core refutation confirmed' : '✓ agrees') : '✗ MISMATCH'}
              </span>
            )}
          </p>
        </div>
        <div className="imc-card">
          <h3>Implication graph</h3>
          <div className="twosat-stats">
            <div>
              <span>{result.stats.nodes}</span>literal nodes
            </div>
            <div>
              <span>{result.stats.edges}</span>implications
            </div>
            <div>
              <span>{result.stats.comps}</span>SCCs
            </div>
            <div>
              <span>{result.stats.nontrivialComps}</span>non-trivial
            </div>
            <div>
              <span>{result.stats.backbones}</span>backbone
            </div>
          </div>
        </div>
      </div>

      {result.sat && result.model && (
        <div className="imc-panel">
          <h3>
            Model{' '}
            <span className={modelOk ? 'check-ok' : 'check-bad'}>
              {modelOk ? '✓ verified' : '✗ invalid'}
            </span>
          </h3>
          <div className="twosat-chips">
            {Array.from({ length: result.numVars }, (_, i) => i + 1).map((v) => (
              <span
                key={v}
                className={`twosat-chip ${result.model![v] ? 'true' : 'false'}`}
              >
                x{v} = {result.model![v] ? '1' : '0'}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="imc-panel">
        <h3>Implication graph</h3>
        <p className="imc-note">
          A clause <code>(a ∨ b)</code> draws <code>¬a → b</code> and <code>¬b → a</code>. Positive
          literals sit on the top row, their negations directly below; nodes are coloured by
          strongly-connected component. {result.sat ? '' : 'The contradictory SCC is ringed in red.'}
        </p>
        <ImplicationGraphView result={result} conflictComp={conflictComp} />
      </div>

      <div className="imc-panel">
        <h3>Condensation (the SCC DAG)</h3>
        <p className="imc-note">
          Collapsing each strongly-connected component to a point leaves a directed acyclic graph,
          drawn left→right in topological order. The 2-SAT model picks, for each variable, whichever
          of <code>x</code>/<code>¬x</code> lies nearer a sink.
        </p>
        <CondensationView result={result} conflictComp={conflictComp} />
      </div>

      {result.equivClasses.length > 0 && (
        <div className="imc-panel">
          <h3>Equivalent-literal classes</h3>
          <p className="imc-note">
            Literals in the same SCC are forced equal in every model — the substitution a real solver
            performs to shrink the formula.
          </p>
          <ul className="twosat-equiv">
            {result.equivClasses.map((cls, i) => (
              <li key={i}>
                {cls.map((l, j) => (
                  <span key={l}>
                    {j > 0 && <span className="twosat-equiv-eq"> ≡ </span>}
                    <code>{litLabel(l)}</code>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.sat && result.backbones.length > 0 && (
        <div className="imc-panel">
          <h3>Backbone — literals forced in every model</h3>
          <p className="imc-note">
            A literal <code>ℓ</code> is forced true exactly when the graph contains a path{' '}
            <code>¬ℓ →* ℓ</code>: assuming the opposite implies it, a contradiction. Each row shows
            that witness path.
          </p>
          <ul className="twosat-backbone">
            {result.backbones.map((b) => (
              <li key={b.lit}>
                <code className="twosat-forced">{litLabel(b.lit)}</code>
                <span className="twosat-path">
                  {b.path.map((l, j) => (
                    <span key={j}>
                      {j > 0 && <span className="twosat-arrow"> → </span>}
                      <code>{litLabel(l)}</code>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function ImplicationGraphView({
  result,
  conflictComp,
}: {
  result: TwoSatResult
  conflictComp: number
}) {
  const layout = useMemo(() => layoutImplication(result), [result])
  if (result.numVars > 24) {
    return (
      <p className="twosat-toobig">
        {result.numVars} variables — too many to draw legibly. The decision, model and condensation
        stats above are still exact; try a smaller instance to see the graph.
      </p>
    )
  }
  return (
    <div className="twosat-svgwrap">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="twosat-graph"
      >
        <defs>
          <marker id="ts-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" className="ts-arrowhead" />
          </marker>
        </defs>
        {layout.edges.map((e, i) => (
          <path
            key={i}
            d={e.path}
            className={`ts-edge ${e.internal ? 'internal' : ''}`}
            markerEnd="url(#ts-arrow)"
          />
        ))}
        {layout.nodes.map((nd) => {
          const inConflict = nd.comp === conflictComp && conflictComp >= 0
          return (
            <g key={nd.node}>
              <circle
                cx={nd.x}
                cy={nd.y}
                r={16}
                fill={compColor(nd.comp, result.numComps)}
                className={`ts-node ${inConflict ? 'conflict' : ''}`}
              />
              <text x={nd.x} y={nd.y} className="ts-label" dominantBaseline="central" textAnchor="middle">
                {litLabel(nd.lit)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function CondensationView({
  result,
  conflictComp,
}: {
  result: TwoSatResult
  conflictComp: number
}) {
  const layout = useMemo(() => layoutCondensation(result), [result])
  if (result.numVars > 24) {
    return <p className="twosat-toobig">Too many variables to draw the condensation legibly.</p>
  }
  return (
    <div className="twosat-svgwrap">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="twosat-cond"
      >
        <defs>
          <marker id="ts-arrow2" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" className="ts-arrowhead" />
          </marker>
        </defs>
        {layout.edges.map((e, i) => (
          <path key={i} d={e.path} className="ts-cond-edge" markerEnd="url(#ts-arrow2)" />
        ))}
        {layout.nodes.map((box) => {
          const inConflict = box.comp === conflictComp && conflictComp >= 0
          return (
            <g key={box.comp}>
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={8}
                className={`ts-cond-box ${inConflict ? 'conflict' : ''}`}
                style={{ stroke: compColor(box.comp, result.numComps) }}
              />
              {box.labels.map((lbl, j) => (
                <text
                  key={j}
                  x={box.x + box.w / 2}
                  y={box.y + 16 + j * 16}
                  className="ts-cond-label"
                  textAnchor="middle"
                >
                  {lbl}
                </text>
              ))}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

interface PhasePoint {
  ratio: number
  pSat: number
}

function PhaseExplorer() {
  const [n, setN] = useState(60)
  const [samples, setSamples] = useState(40)
  const [data, setData] = useState<PhasePoint[] | null>(null)
  const [running, setRunning] = useState(false)

  const run = () => {
    setRunning(true)
    setTimeout(() => {
      const pts: PhasePoint[] = []
      let seed = 1234567
      for (let r = 0.2; r <= 2.0001; r += 0.1) {
        const m = Math.max(1, Math.round(r * n))
        let sat = 0
        for (let s = 0; s < samples; s++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff
          if (decide2Sat(randomTwoSat(n, m, seed)).sat) sat++
        }
        pts.push({ ratio: r, pSat: sat / samples })
      }
      setData(pts)
      setRunning(false)
    }, 30)
  }

  return (
    <div className="imc-panel twosat-phase">
      <h3>Phase-transition explorer</h3>
      <p className="imc-note">
        Random 2-SAT has a sharp <strong>satisfiability threshold</strong> at clause/variable ratio{' '}
        <code>m/n = 1</code> (Chvátal–Reed / Goerdt): below it almost every formula is satisfiable,
        above it almost none. Sweep the ratio and watch <code>P(sat)</code> fall — decided by the
        linear-time procedure, thousands of instances in a blink.
      </p>
      <div className="twosat-phase-controls">
        <label>
          variables
          <input type="number" min={10} max={200} value={n} onChange={(e) => setN(clamp(+e.target.value, 10, 200))} />
        </label>
        <label>
          samples/ratio
          <input
            type="number"
            min={5}
            max={200}
            value={samples}
            onChange={(e) => setSamples(clamp(+e.target.value, 5, 200))}
          />
        </label>
        <button onClick={run} disabled={running}>
          {running ? 'Sweeping…' : '▶ Sweep'}
        </button>
      </div>
      {data && <PhaseChart data={data} />}
    </div>
  )
}

function PhaseChart({ data }: { data: PhasePoint[] }) {
  const W = 560
  const H = 240
  const padL = 44
  const padB = 34
  const padT = 14
  const padR = 14
  const rMin = 0.2
  const rMax = 2.0
  const x = (r: number) => padL + ((r - rMin) / (rMax - rMin)) * (W - padL - padR)
  const y = (p: number) => padT + (1 - p) * (H - padT - padB)
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(d.ratio).toFixed(1)} ${y(d.pSat).toFixed(1)}`).join(' ')

  return (
    <div className="twosat-svgwrap">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="twosat-chart">
        {/* y gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line x1={padL} y1={y(p)} x2={W - padR} y2={y(p)} className="ts-grid" />
            <text x={padL - 6} y={y(p)} className="ts-axis" textAnchor="end" dominantBaseline="central">
              {p}
            </text>
          </g>
        ))}
        {/* threshold marker at ratio 1 */}
        <line x1={x(1)} y1={padT} x2={x(1)} y2={H - padB} className="ts-threshold" />
        <text x={x(1)} y={padT + 2} className="ts-threshold-label" textAnchor="middle">
          m/n = 1
        </text>
        {/* x ticks */}
        {[0.5, 1.0, 1.5, 2.0].map((r) => (
          <text key={r} x={x(r)} y={H - padB + 16} className="ts-axis" textAnchor="middle">
            {r.toFixed(1)}
          </text>
        ))}
        <text x={(padL + W - padR) / 2} y={H - 4} className="ts-axis-title" textAnchor="middle">
          clause / variable ratio
        </text>
        <path d={line} className="ts-curve" />
        {data.map((d, i) => (
          <circle key={i} cx={x(d.ratio)} cy={y(d.pSat)} r={3} className="ts-dot" />
        ))}
      </svg>
    </div>
  )
}
