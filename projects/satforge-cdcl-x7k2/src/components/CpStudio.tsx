import { useMemo, useState } from 'react'
import './CpStudio.css'
import {
  CP_EXAMPLES,
  langfordLayout,
  optimize,
  runCpChecks,
  search,
  buildStore,
  type AllDiffLevel,
  type Built,
  type CpCheckReport,
  type OptimizeResult,
  type SearchResult,
  type ValHeuristic,
  type VarHeuristic,
} from '../cp'

interface Options {
  level: AllDiffLevel
  varH: VarHeuristic
  valH: ValHeuristic
  restarts: boolean
}

const PALETTE = ['#6ea8fe', '#ef476f', '#22c55e', '#f59e0b', '#9b8cff', '#2dd4bf', '#f472b6', '#a3e635']

interface RunResult {
  built: Built
  exampleId: string
  params: Record<string, number>
  mode: Built['mode']
  search?: SearchResult
  opt?: OptimizeResult
  rootFixedBefore: number
  rootFixed: number
  rootPruned: number
  rootMs: number
  rootFailed: boolean
}

export function CpStudio() {
  const [exampleId, setExampleId] = useState<string>('queens')
  const [paramState, setParamState] = useState<Record<string, Record<string, number>>>(() => {
    const init: Record<string, Record<string, number>> = {}
    for (const ex of CP_EXAMPLES) init[ex.id] = Object.fromEntries(ex.params.map((p) => [p.key, p.default]))
    return init
  })
  const [opts, setOpts] = useState<Options>({ level: 'domain', varH: 'dom-wdeg', valH: 'min', restarts: true })
  const [result, setResult] = useState<RunResult | null>(null)
  const [solving, setSolving] = useState(false)
  const [solIndex, setSolIndex] = useState(0)
  const [checks, setChecks] = useState<CpCheckReport | null>(null)
  const [checking, setChecking] = useState(false)

  const example = useMemo(() => CP_EXAMPLES.find((e) => e.id === exampleId)!, [exampleId])
  const params = paramState[exampleId]

  const setParam = (key: string, value: number) => {
    setParamState((s) => ({ ...s, [exampleId]: { ...s[exampleId], [key]: value } }))
  }

  const solve = () => {
    setSolving(true)
    setSolIndex(0)
    setTimeout(() => {
      const built = example.build(params)
      // Root propagation snapshot at the chosen level.
      const store = buildStore(built.model, opts.level)
      const before = store.doms.map((d) => d.length)
      const beforeFixed = before.filter((l) => l === 1).length
      const t0 = Date.now()
      store.seedAll()
      const rootOk = store.propagate()
      const rootMs = Date.now() - t0
      const after = store.doms.map((d) => d.length)
      const rootFixed = after.filter((l) => l === 1).length
      const rootPruned = before.reduce((s, b, i) => s + (b - after[i]), 0)

      const common = {
        varHeuristic: opts.varH,
        valHeuristic: opts.valH,
        allDiffLevel: opts.level,
        randomSeed: 0x1234,
        nodeLimit: 6_000_000,
        timeLimitMs: 8000,
      }
      let sres: SearchResult | undefined
      let ores: OptimizeResult | undefined
      if (built.mode === 'optimize' && built.objective) {
        ores = optimize(built.model, built.objective.v, built.objective.sense, {
          mode: 'first',
          restarts: opts.restarts,
          ...common,
        })
      } else {
        const mode = built.mode === 'first' ? 'first' : built.mode === 'all' ? 'all' : 'count'
        sres = search(built.model, {
          mode,
          maxStored: 2000,
          solutionCap: 500_000,
          restarts: built.mode === 'first' && opts.restarts,
          ...common,
        })
      }
      setResult({
        built,
        exampleId,
        params: { ...params },
        mode: built.mode,
        search: sres,
        opt: ores,
        rootFixedBefore: beforeFixed,
        rootFixed,
        rootPruned,
        rootMs,
        rootFailed: !rootOk,
      })
      setSolving(false)
    }, 20)
  }

  const runVerify = () => {
    setChecking(true)
    setTimeout(() => {
      setChecks(runCpChecks())
      setChecking(false)
    }, 30)
  }

  const classic = CP_EXAMPLES.filter((e) => e.category === 'classic')
  const optim = CP_EXAMPLES.filter((e) => e.category === 'optimization')

  return (
    <div className="layout">
      <aside className="control cp-side">
        <p className="cp-blurb">
          A from-scratch <strong>finite-domain constraint solver</strong>: propagation to a fixpoint
          (arc consistency generalised to arbitrary propagators), backtracking search with{' '}
          <strong>dom/wdeg</strong> and <strong>Luby restarts</strong>, and{' '}
          <strong>branch-and-bound</strong> optimisation. The star propagator is{' '}
          <strong>Régin's domain-consistent all-different</strong> (maximum matching + SCC) — the
          reason Sudoku falls out almost without search.
        </p>

        <div className="cp-gallery">
          <h3>Classic (decide / count)</h3>
          <div className="cp-ex-grid">
            {classic.map((ex) => (
              <button key={ex.id} className={ex.id === exampleId ? 'active' : ''} onClick={() => setExampleId(ex.id)} title={ex.blurb}>
                {ex.title}
              </button>
            ))}
          </div>
          <h3>Optimisation (branch &amp; bound)</h3>
          <div className="cp-ex-grid">
            {optim.map((ex) => (
              <button key={ex.id} className={ex.id === exampleId ? 'active' : ''} onClick={() => setExampleId(ex.id)} title={ex.blurb}>
                {ex.title}
              </button>
            ))}
          </div>
        </div>

        {example.params.length > 0 && (
          <div className="cp-params">
            <h3>Parameters</h3>
            {example.params.map((p) => (
              <label key={p.key} className="cp-param">
                <span>
                  {p.label}: <strong>{params[p.key]}</strong>
                </span>
                <input
                  type="range"
                  min={p.min}
                  max={p.max}
                  value={params[p.key]}
                  onChange={(e) => setParam(p.key, Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        )}

        <div className="cp-options">
          <h3>Solver</h3>
          <Segmented
            label="all-different"
            value={opts.level}
            options={[
              ['value', 'value'],
              ['bounds', 'bounds'],
              ['domain', 'GAC'],
            ]}
            onChange={(v) => setOpts((o) => ({ ...o, level: v as AllDiffLevel }))}
          />
          <Segmented
            label="variable order"
            value={opts.varH}
            options={[
              ['input', 'input'],
              ['first-fail', 'first-fail'],
              ['dom-wdeg', 'dom/wdeg'],
            ]}
            onChange={(v) => setOpts((o) => ({ ...o, varH: v as VarHeuristic }))}
          />
          <Segmented
            label="value order"
            value={opts.valH}
            options={[
              ['min', 'min'],
              ['max', 'max'],
              ['median', 'med'],
              ['random', 'rnd'],
            ]}
            onChange={(v) => setOpts((o) => ({ ...o, valH: v as ValHeuristic }))}
          />
          <label className="cp-check-row">
            <input type="checkbox" checked={opts.restarts} onChange={(e) => setOpts((o) => ({ ...o, restarts: e.target.checked }))} />
            Luby restarts (single-solution &amp; optimisation)
          </label>
        </div>

        <button className="cp-solve" onClick={solve} disabled={solving}>
          {solving ? 'Solving…' : '▶ Solve'}
        </button>

        <div className="cp-selftest">
          <h3>Self-test</h3>
          <p>
            700 random models vs. brute force, 600 all-different instances checked for exact domain
            consistency, three filtering levels cross-agreed, branch-and-bound vs. brute optima, and
            the gallery's pinned OEIS answers — thousands of assertions.
          </p>
          <button onClick={runVerify} disabled={checking}>
            {checking ? 'Running…' : '▶ Run self-test'}
          </button>
          {checks && (
            <div className={`cp-check ${checks.fail === 0 ? 'ok' : 'bad'}`}>
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
            <h2>CP Studio — {example.title}</h2>
            <p className="subtitle">{example.blurb}</p>
          </div>
          {result && <StatusPill result={result} />}
        </div>

        {!result && (
          <div className="placeholder">
            <div className="cp-hint">Pick a model, choose a filtering level and heuristics, then press Solve.</div>
          </div>
        )}

        {result && (
          <>
            <RootPropagation result={result} />
            <SolutionPanel result={result} solIndex={solIndex} setSolIndex={setSolIndex} />
            <StatsPanel result={result} />
            <CrossCheck result={result} />
          </>
        )}
      </main>
    </div>
  )
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: [string, string][]
  onChange: (v: string) => void
}) {
  return (
    <div className="cp-seg">
      <span className="cp-seg-label">{label}</span>
      <div className="cp-seg-btns">
        {options.map(([val, txt]) => (
          <button key={val} className={val === value ? 'active' : ''} onClick={() => onChange(val)}>
            {txt}
          </button>
        ))}
      </div>
    </div>
  )
}

function StatusPill({ result }: { result: RunResult }) {
  let kind: 'sat' | 'unsat' | 'unknown' = 'unknown'
  let strong = ''
  let sub = ''
  if (result.opt) {
    if (result.opt.status === 'optimal') {
      kind = 'sat'
      strong = 'OPTIMAL'
      sub = `${result.built.objective?.label} = ${result.opt.best}`
    } else if (result.opt.status === 'infeasible') {
      kind = 'unsat'
      strong = 'INFEASIBLE'
    } else {
      kind = 'unknown'
      strong = 'TIMEOUT'
      sub = result.opt.best !== null ? `best ${result.opt.best}` : ''
    }
  } else if (result.search) {
    const s = result.search
    if (result.mode === 'count' || result.mode === 'all') {
      kind = s.count > 0 ? 'sat' : 'unsat'
      strong = s.complete ? `${s.count}` : `≥ ${s.count}`
      sub = s.complete ? 'solutions' : 'solutions (capped)'
    } else {
      kind = s.status === 'sat' ? 'sat' : s.status === 'unsat' ? 'unsat' : 'unknown'
      strong = s.status === 'sat' ? 'SAT' : s.status === 'unsat' ? 'UNSAT' : 'TIMEOUT'
    }
  }
  return (
    <div className={`status-pill ${kind}`}>
      <strong>{strong}</strong>
      {sub && <span>{sub}</span>}
    </div>
  )
}

function RootPropagation({ result }: { result: RunResult }) {
  const n = result.built.model.n
  return (
    <div className="cp-rootprop">
      <span className="cp-rp-title">root propagation ({result.built.model.allDiffScopes.length ? 'GAC-level: ' : ''}before search)</span>
      <div className="cp-rp-stats">
        <span>
          fixed <strong>{result.rootFixed}</strong>/{n} variables
        </span>
        <span>
          pruned <strong>{result.rootPruned}</strong> candidate values
        </span>
        <span>{result.rootMs} ms</span>
        {result.rootFailed && <span className="cp-rp-fail">proved infeasible at the root</span>}
      </div>
    </div>
  )
}

function currentAssignment(result: RunResult, solIndex: number): number[] | null {
  if (result.opt) return result.opt.solution
  const s = result.search
  if (!s) return null
  if (result.mode === 'first') return s.solution
  if (s.solutions.length === 0) return null
  return s.solutions[Math.min(solIndex, s.solutions.length - 1)] ?? null
}

function SolutionPanel({
  result,
  solIndex,
  setSolIndex,
}: {
  result: RunResult
  solIndex: number
  setSolIndex: (n: number) => void
}) {
  const a = currentAssignment(result, solIndex)
  const s = result.search
  const browsable = !!s && (result.mode === 'all' || result.mode === 'count') && s.solutions.length > 1
  return (
    <section className="view cp-solution">
      <div className="cp-sol-head">
        <h3>Solution</h3>
        {browsable && s && (
          <div className="cp-browse">
            <button onClick={() => setSolIndex(Math.max(0, solIndex - 1))} disabled={solIndex === 0}>
              ‹
            </button>
            <span>
              {Math.min(solIndex + 1, s.solutions.length)} / {s.solutions.length}
              {!s.complete || s.solutions.length < s.count ? ` (of ${s.complete ? s.count : '≥ ' + s.count})` : ''}
            </span>
            <button onClick={() => setSolIndex(Math.min(s.solutions.length - 1, solIndex + 1))} disabled={solIndex >= s.solutions.length - 1}>
              ›
            </button>
          </div>
        )}
      </div>
      {a ? <RenderSolution result={result} a={a} /> : <p className="cp-nosol">No solution.</p>}
      {result.opt && result.opt.improvements.length > 0 && (
        <div className="cp-improvements">
          incumbent trajectory:{' '}
          {result.opt.improvements.map((im, i) => (
            <span key={i} className="cp-imp">
              {im.value}
              {i < result.opt!.improvements.length - 1 ? ' → ' : ''}
            </span>
          ))}{' '}
          ({result.opt.iterations} searches)
        </div>
      )}
    </section>
  )
}

function RenderSolution({ result, a }: { result: RunResult; a: number[] }) {
  const r = result.built.render
  if (r.kind === 'queens') return <QueensBoard n={r.n} cols={r.cols} a={a} />
  if (r.kind === 'grid') return <GridView spec={r} a={a} result={result} />
  if (r.kind === 'coloring') return <ColoringView spec={r} a={a} />
  if (r.kind === 'crypt') return <CryptView spec={r} a={a} />
  if (r.kind === 'ruler') return <RulerView spec={r} a={a} />
  if (r.kind === 'knap') return <KnapView spec={r} a={a} />
  return null
}

function QueensBoard({ n, cols, a }: { n: number; cols: number[]; a: number[] }) {
  const cells = []
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const dark = (row + col) % 2 === 1
      const queen = a[cols[col]] === row
      cells.push(
        <div key={`${row}-${col}`} className={`cp-cell ${dark ? 'dark' : ''}`}>
          {queen ? '♛' : ''}
        </div>,
      )
    }
  }
  return (
    <div className="cp-board" style={{ gridTemplateColumns: `repeat(${n}, 1fr)`, maxWidth: Math.min(520, n * 56) }}>
      {cells}
    </div>
  )
}

function GridView({
  spec,
  a,
  result,
}: {
  spec: Extract<Built['render'], { kind: 'grid' }>
  a: number[]
  result: RunResult
}) {
  if (spec.display === 'langford') {
    const n = result.params.n
    const slots = langfordLayout(n, result.built.model, a)
    return (
      <div className="cp-langford">
        {slots.map((v, i) => (
          <div key={i} className="cp-lf-slot">
            <span className="cp-lf-num">{v}</span>
            <span className="cp-lf-pos">{i + 1}</span>
          </div>
        ))}
      </div>
    )
  }
  const { rows, cols, cells, box, offset = 0 } = spec
  const initial = result.built.model.domains
  const items = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      const vid = cells[idx]
      const val = a[vid] + offset
      const given = initial[vid].length === 1
      const classes = ['cp-gcell']
      if (given && spec.display === 'sudoku') classes.push('given')
      if (box) {
        if ((c + 1) % box[1] === 0 && c + 1 < cols) classes.push('box-r')
        if ((r + 1) % box[0] === 0 && r + 1 < rows) classes.push('box-b')
      }
      items.push(
        <div key={idx} className={classes.join(' ')}>
          {val}
        </div>,
      )
    }
  }
  return (
    <div className="cp-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, maxWidth: Math.min(520, cols * 52) }}>
      {items}
    </div>
  )
}

function ColoringView({ spec, a }: { spec: Extract<Built['render'], { kind: 'coloring' }>; a: number[] }) {
  const S = 260
  const R = 110
  const cx = S / 2
  const cy = S / 2
  const pos = spec.nodes.map((nd) => ({ x: cx + nd.x * R, y: cy + nd.y * R, label: nd.label }))
  return (
    <div className="cp-coloring">
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
        {spec.edges.map(([u, v], i) => (
          <line key={i} x1={pos[u].x} y1={pos[u].y} x2={pos[v].x} y2={pos[v].y} stroke="var(--border)" strokeWidth={2} />
        ))}
        {spec.nodes.map((_, i) => (
          <g key={i}>
            <circle cx={pos[i].x} cy={pos[i].y} r={16} fill={PALETTE[a[spec.vars[i]] % PALETTE.length]} stroke="#0b1020" strokeWidth={2} />
            <text x={pos[i].x} y={pos[i].y + 4} textAnchor="middle" fontSize={12} fill="#0b1020" fontWeight={700}>
              {pos[i].label}
            </text>
          </g>
        ))}
      </svg>
      <div className="cp-legend">
        {Array.from({ length: spec.colors }, (_, k) => (
          <span key={k} className="cp-legend-item">
            <span className="cp-swatch" style={{ background: PALETTE[k % PALETTE.length] }} /> colour {k}
          </span>
        ))}
      </div>
    </div>
  )
}

function CryptView({ spec, a }: { spec: Extract<Built['render'], { kind: 'crypt' }>; a: number[] }) {
  const digit = (L: string) => a[spec.letterVar[L]]
  const wordVal = (w: string) => Number([...w].map((L) => digit(L)).join(''))
  return (
    <div className="cp-crypt">
      <div className="cp-crypt-sum">
        {spec.lines.map((w, i) => (
          <div key={i} className={`cp-crypt-line ${i === spec.lines.length - 1 ? 'total' : ''}`}>
            <span className="cp-crypt-word">
              {[...w].map((L, j) => (
                <span key={j} className="cp-crypt-letter">
                  <em>{L}</em>
                  <b>{digit(L)}</b>
                </span>
              ))}
            </span>
            <span className="cp-crypt-num">{wordVal(w)}</span>
          </div>
        ))}
      </div>
      <div className="cp-crypt-eq">
        {wordVal(spec.lines[0])} + {wordVal(spec.lines[1])} = {wordVal(spec.lines[2])}
      </div>
      <div className="cp-mapping">
        {spec.letters.map((L) => (
          <span key={L} className="cp-map-item">
            {L}={digit(L)}
          </span>
        ))}
      </div>
    </div>
  )
}

function RulerView({ spec, a }: { spec: Extract<Built['render'], { kind: 'ruler' }>; a: number[] }) {
  const marks = spec.marks.map((v) => a[v]).sort((x, y) => x - y)
  const span = a[spec.span]
  const W = 520
  const pad = 20
  const scale = (v: number) => pad + (v / Math.max(1, span)) * (W - 2 * pad)
  const diffs: number[] = []
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) diffs.push(marks[j] - marks[i])
  diffs.sort((x, y) => x - y)
  return (
    <div className="cp-ruler">
      <svg width={W} height={70} viewBox={`0 0 ${W} 70`}>
        <line x1={pad} y1={40} x2={W - pad} y2={40} stroke="var(--border)" strokeWidth={2} />
        {marks.map((mk, i) => (
          <g key={i}>
            <line x1={scale(mk)} y1={28} x2={scale(mk)} y2={52} stroke="var(--accent)" strokeWidth={3} />
            <text x={scale(mk)} y={22} textAnchor="middle" fontSize={12} fill="var(--text)">
              {mk}
            </text>
          </g>
        ))}
      </svg>
      <div className="cp-ruler-diffs">
        <span className="cp-rd-label">distinct distances ({diffs.length}):</span> {diffs.join(', ')}
      </div>
    </div>
  )
}

function KnapView({ spec, a }: { spec: Extract<Built['render'], { kind: 'knap' }>; a: number[] }) {
  const chosen = spec.items.filter((it) => a[it.v] === 1)
  const w = chosen.reduce((s, it) => s + it.weight, 0)
  const val = a[spec.valueVar]
  return (
    <div className="cp-knap">
      <div className="cp-knap-summary">
        weight <strong>{w}</strong> / {spec.capacity} · value <strong>{val}</strong>
      </div>
      <div className="cp-knap-items">
        {spec.items.map((it) => (
          <div key={it.label} className={`cp-knap-item ${a[it.v] === 1 ? 'in' : ''}`}>
            <span className="cp-ki-name">{it.label}</span>
            <span className="cp-ki-meta">
              w{it.weight} · v{it.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatsPanel({ result }: { result: RunResult }) {
  const st = result.opt ? result.opt.stats : result.search!.stats
  const cards: [string, string | number][] = [
    ['nodes', st.nodes.toLocaleString()],
    ['failures', st.failures.toLocaleString()],
    ['propagations', st.propagations.toLocaleString()],
    ['peak depth', st.peakDepth],
    ['restarts', st.restarts],
    ['time', `${st.timeMs} ms`],
  ]
  if (result.opt) cards.push(['B&B searches', result.opt.iterations])
  else cards.push(['solutions', result.search!.count.toLocaleString()])
  return (
    <section className="view cp-stats">
      <h3>Search statistics</h3>
      <div className="cp-stat-grid">
        {cards.map(([k, v]) => (
          <div key={k} className="cp-stat">
            <span className="cp-stat-val">{v}</span>
            <span className="cp-stat-key">{k}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function CrossCheck({ result }: { result: RunResult }) {
  const known = result.built.known
  if (!known) return null
  let verdict: 'confirm' | 'mismatch' | 'note' = 'note'
  let text = known.note
  if (result.opt && known.optimum !== undefined && result.opt.status === 'optimal') {
    verdict = result.opt.best === known.optimum ? 'confirm' : 'mismatch'
    text = `${known.note} — solver found ${result.opt.best}`
  } else if (result.search && known.count !== undefined && (result.mode === 'count' || result.mode === 'all')) {
    if (result.search.complete) {
      verdict = result.search.count === known.count ? 'confirm' : 'mismatch'
      text = `${known.note} — solver counted ${result.search.count}`
    }
  }
  return (
    <div className={`cp-cross cp-cross-${verdict}`}>
      {verdict === 'confirm' ? '✓ ' : verdict === 'mismatch' ? '⚠ ' : 'ℹ '}
      {text}
    </div>
  )
}
