import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PRESET_CONFIGS,
  configById,
  generateSuite,
  benchSteps,
  summarize,
  cactus,
  agreementErrors,
  ALL_FAMILIES,
  FAMILY_LABEL,
  DEFAULT_SUITE,
  DEFAULT_BUDGET,
} from '../sat'
import type { SuiteSpec, BenchBudget, RunResult, InstanceFamily } from '../sat'
import type { InstanceMeta, LabRequest, LabResponse } from '../worker/lab.worker'

// A distinct, color-blind-friendly-ish palette; configs take colors in selection order.
const PALETTE = [
  '#6ea8fe',
  '#9b8cff',
  '#22c55e',
  '#f59e0b',
  '#ef476f',
  '#2dd4bf',
  '#f472b6',
  '#a3e635',
  '#38bdf8',
  '#fb923c',
]

interface BenchState {
  phase: 'idle' | 'running' | 'done'
  results: RunResult[]
  instances: InstanceMeta[]
  progress: { done: number; total: number }
  error?: string
}

const IDLE: BenchState = { phase: 'idle', results: [], instances: [], progress: { done: 0, total: 0 } }

/**
 * Drives the benchmark, preferring a Web Worker so the long sweep never freezes
 * the UI. If a worker can't be created (older browsers, sandboxed iframe), it
 * falls back to a chunked main-thread run that yields between cells.
 */
function useBench() {
  const [state, setState] = useState<BenchState>(IDLE)
  const workerRef = useRef<Worker | null>(null)
  const cancelRef = useRef(false)

  const cleanup = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
    cancelRef.current = true
  }, [])

  useEffect(() => cleanup, [cleanup])

  const stop = useCallback(() => {
    cleanup()
    setState((s) => (s.phase === 'running' ? { ...s, phase: 'done' } : s))
  }, [cleanup])

  const run = useCallback((configIds: string[], suite: SuiteSpec, budget: BenchBudget) => {
    cleanup()
    cancelRef.current = false
    setState({ phase: 'running', results: [], instances: [], progress: { done: 0, total: 0 } })

    let worker: Worker | null
    try {
      worker = new Worker(new URL('../worker/lab.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      worker = null
    }

    if (worker) {
      workerRef.current = worker
      worker.onmessage = (ev: MessageEvent<LabResponse>) => {
        const msg = ev.data
        if (msg.type === 'meta') {
          setState((s) => ({ ...s, instances: msg.instances, progress: { done: 0, total: msg.total } }))
        } else if (msg.type === 'progress') {
          setState((s) => ({
            ...s,
            results: [...s.results, msg.result],
            progress: { done: msg.index, total: msg.total },
          }))
        } else if (msg.type === 'done') {
          cleanup()
          setState((s) => ({ ...s, phase: 'done' }))
        } else if (msg.type === 'error') {
          cleanup()
          setState((s) => ({ ...s, phase: 'done', error: msg.error }))
        }
      }
      worker.onerror = (e) => {
        cleanup()
        setState((s) => ({ ...s, phase: 'done', error: e.message || 'worker error' }))
      }
      worker.postMessage({ configIds, suite, budget } satisfies LabRequest)
      return
    }

    // ---- main-thread fallback: chunk the work so the UI can repaint ----
    const configs = configIds.map((id) => configById(id)).filter((c): c is NonNullable<typeof c> => !!c)
    const instances = generateSuite(suite)
    setState((s) => ({
      ...s,
      instances: instances.map((i) => ({ id: i.id, family: i.family, label: i.label, expected: i.expected })),
      progress: { done: 0, total: configs.length * instances.length },
    }))
    const gen = benchSteps(configs, instances, budget)
    const pump = () => {
      if (cancelRef.current) return
      const batch: RunResult[] = []
      let last = { index: 0, total: configs.length * instances.length }
      for (let i = 0; i < 3; i++) {
        const next = gen.next()
        if (next.done) {
          setState((s) => ({ ...s, results: [...s.results, ...batch], phase: 'done' }))
          return
        }
        batch.push(next.value.result)
        last = { index: next.value.index, total: next.value.total }
      }
      setState((s) => ({ ...s, results: [...s.results, ...batch], progress: { done: last.index, total: last.total } }))
      setTimeout(pump, 0)
    }
    setTimeout(pump, 0)
  }, [cleanup])

  return { state, run, stop }
}

// ---------------------------------------------------------------------------

export function SolverLab() {
  const [families, setFamilies] = useState<Record<InstanceFamily, boolean>>(DEFAULT_SUITE.families)
  const [scale, setScale] = useState(DEFAULT_SUITE.scale)
  const [seed, setSeed] = useState(DEFAULT_SUITE.seed)
  const [conflicts, setConflicts] = useState(DEFAULT_BUDGET.maxConflicts)
  const [timeMs, setTimeMs] = useState(DEFAULT_BUDGET.maxTimeMs)
  const [selected, setSelected] = useState<string[]>([
    'full',
    'no-restart',
    'no-reduce',
    'no-min',
    'random-branch',
  ])
  const [logScale, setLogScale] = useState(false)

  const { state, run, stop } = useBench()

  const toggleFamily = (f: InstanceFamily) => setFamilies((s) => ({ ...s, [f]: !s[f] }))
  const toggleConfig = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  // Stable color per *selected* config (selection order), so the legend, the
  // cactus curves and the heatmap rows all agree.
  const colorOf = useMemo(() => {
    const order = PRESET_CONFIGS.filter((c) => selected.includes(c.id)).map((c) => c.id)
    const map = new Map<string, string>()
    order.forEach((id, i) => map.set(id, PALETTE[i % PALETTE.length]))
    return (id: string) => map.get(id) ?? '#888'
  }, [selected])

  const orderedConfigs = useMemo(() => PRESET_CONFIGS.filter((c) => selected.includes(c.id)), [selected])

  const anyFamily = ALL_FAMILIES.some((f) => families[f])
  const canRun = selected.length >= 1 && anyFamily

  const onRun = () => {
    if (!canRun) return
    const suite: SuiteSpec = { families, seed, scale }
    const budget: BenchBudget = { maxConflicts: conflicts, maxTimeMs: timeMs }
    run(selected, suite, budget)
  }

  // ---- derived analytics (work on partial results too) ----
  const budget: BenchBudget = { maxConflicts: conflicts, maxTimeMs: timeMs }
  const summaries = useMemo(() => {
    if (state.instances.length === 0) return []
    const inst = state.instances.map((m) => ({ id: m.id, family: m.family as InstanceFamily, label: m.label, cnf: { numVars: 0, clauses: [] }, expected: m.expected }))
    return summarize(orderedConfigs, inst, state.results, budget)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedConfigs, state.results, state.instances, conflicts, timeMs])

  const cactusData = useMemo(() => cactus(orderedConfigs, state.results), [orderedConfigs, state.results])

  const disagreements = useMemo(
    () =>
      agreementErrors(
        state.instances.map((m) => ({ id: m.id, family: m.family as InstanceFamily, label: m.label, cnf: { numVars: 0, clauses: [] }, expected: m.expected })),
        state.results,
      ),
    [state.instances, state.results],
  )

  const ranked = useMemo(
    () => [...summaries].sort((a, b) => b.solved - a.solved || a.par2 - b.par2),
    [summaries],
  )

  const labelOf = (id: string) => configById(id)?.label ?? id
  const showResults = state.results.length > 0 || state.phase !== 'idle'

  return (
    <div className="layout">
      <aside className="panel lab-panel">
        <div>
          <h2>Benchmark suite</h2>
          <div className="lab-checks">
            {ALL_FAMILIES.map((f) => (
              <label key={f} className="lab-check">
                <input type="checkbox" checked={families[f]} onChange={() => toggleFamily(f)} />
                <span>{FAMILY_LABEL[f]}</span>
              </label>
            ))}
          </div>
          <label className="field lab-range">
            <span>
              Difficulty / size <em>{['quick', 'small', 'medium', 'stress'][scale - 1]}</em>
            </span>
            <input type="range" min={1} max={4} value={scale} onChange={(e) => setScale(+e.target.value)} />
          </label>
          <label className="field">
            <span>
              Suite seed <em>{seed}</em>
            </span>
            <input
              type="number"
              value={seed}
              min={1}
              onChange={(e) => setSeed(Math.max(1, +e.target.value || 1))}
            />
          </label>
        </div>

        <div>
          <h2>Per-instance budget</h2>
          <label className="field">
            <span>
              Conflict cap <em>{conflicts.toLocaleString()}</em>
            </span>
            <input
              type="range"
              min={10000}
              max={500000}
              step={10000}
              value={conflicts}
              onChange={(e) => setConflicts(+e.target.value)}
            />
          </label>
          <label className="field">
            <span>
              Time cap <em>{timeMs} ms</em>
            </span>
            <input
              type="range"
              min={1000}
              max={10000}
              step={500}
              value={timeMs}
              onChange={(e) => setTimeMs(+e.target.value)}
            />
          </label>
        </div>

        <div>
          <h2>Configurations ({selected.length})</h2>
          <div className="lab-configs">
            {PRESET_CONFIGS.map((c) => (
              <label key={c.id} className="lab-config" title={c.description}>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggleConfig(c.id)} />
                <span className="lab-swatch" style={{ background: selected.includes(c.id) ? colorOf(c.id) : 'transparent' }} />
                <span className="lab-config-label">{c.label}</span>
              </label>
            ))}
          </div>
          <div className="lab-config-actions">
            <button className="kind-btn" onClick={() => setSelected(PRESET_CONFIGS.map((c) => c.id))}>
              All
            </button>
            <button className="kind-btn" onClick={() => setSelected(['full'])}>
              Reset
            </button>
          </div>
        </div>

        {state.phase === 'running' ? (
          <button className="solve-btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="solve-btn" disabled={!canRun} onClick={onRun}>
            Run benchmark
          </button>
        )}
        {!canRun && <p className="hint">Pick at least one family and one configuration.</p>}
      </aside>

      <main className="content lab-content">
        <div className="problem-head">
          <div>
            <h2>Solver Lab</h2>
            <p className="subtitle">
              Race CDCL heuristics across a reproducible suite — cactus plot, PAR-2 scores, and a
              soundness cross-check.
            </p>
          </div>
        </div>

        {state.phase === 'running' && (
          <div className="lab-progress">
            <div className="lab-progress-bar">
              <span
                style={{
                  width: `${state.progress.total ? (100 * state.progress.done) / state.progress.total : 0}%`,
                }}
              />
            </div>
            <span className="muted">
              {state.progress.done} / {state.progress.total} runs
            </span>
          </div>
        )}

        {state.error && <div className="banner error">Benchmark error: {state.error}</div>}

        {!showResults && (
          <div className="placeholder lab-intro">
            <p>
              The Solver Lab runs the <strong>same proved-correct CDCL engine</strong> with a single
              heuristic flipped at a time, over a mixed suite of random 3-SAT (at the α ≈ 4.26 phase
              transition), pigeonhole UNSAT, graph coloring and Langford instances.
            </p>
            <p className="muted">
              The <strong>cactus plot</strong> ranks solvers the way the SAT Competition does — a curve
              that reaches further right and stays lower solved more instances in less total time.
              Because every configuration is the same complete solver, they must all agree on every
              instance they decide: the soundness banner checks exactly that.
            </p>
          </div>
        )}

        {showResults && (
          <>
            <SoundnessBanner errors={disagreements} running={state.phase === 'running'} />

            <section className="view lab-section">
              <div className="lab-section-head">
                <h3>Cactus plot</h3>
                <label className="lab-toggle">
                  <input type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
                  log time
                </label>
              </div>
              <CactusPlot data={cactusData} colorOf={colorOf} labelOf={labelOf} logScale={logScale} />
            </section>

            <section className="view lab-section">
              <h3>Leaderboard</h3>
              <Leaderboard ranked={ranked} colorOf={colorOf} labelOf={labelOf} />
            </section>

            <section className="view lab-section">
              <h3>Per-instance grid</h3>
              <p className="muted lab-grid-note">
                Each cell is colored by speed relative to the fastest solver on that instance (green =
                fastest, red = slowest); ✕ = hit the budget without an answer.
              </p>
              <Heatmap
                instances={state.instances}
                configs={orderedConfigs}
                results={state.results}
                colorOf={colorOf}
              />
            </section>
          </>
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------

function SoundnessBanner({ errors, running }: { errors: { detail: string }[]; running: boolean }) {
  if (errors.length > 0) {
    return (
      <div className="banner error lab-sound bad">
        <strong>⚠ Soundness violation</strong> — configurations disagree on a verdict. This is a bug:
        <ul>
          {errors.slice(0, 6).map((e, i) => (
            <li key={i}>{e.detail}</li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="banner lab-sound ok">
      ✓ <strong>Sound</strong> — every configuration agrees on each instance it decides
      {running ? ' (so far)' : ''}. Flipping a heuristic changes the <em>speed</em>, never the answer.
    </div>
  )
}

// ---- cactus plot ----------------------------------------------------------

interface CactusProps {
  data: { configId: string; points: Array<{ solved: number; cumTimeMs: number }> }[]
  colorOf: (id: string) => string
  labelOf: (id: string) => string
  logScale: boolean
}

function CactusPlot({ data, colorOf, labelOf, logScale }: CactusProps) {
  const W = 640
  const H = 340
  const m = { top: 16, right: 16, bottom: 40, left: 56 }
  const iw = W - m.left - m.right
  const ih = H - m.top - m.bottom

  const maxSolved = Math.max(1, ...data.map((d) => d.points.length))
  const maxTime = Math.max(1, ...data.flatMap((d) => d.points.map((p) => p.cumTimeMs)))

  const tx = (solved: number) => m.left + (iw * solved) / maxSolved
  const ty = (t: number) => {
    if (logScale) {
      const lo = Math.log10(1)
      const hi = Math.log10(maxTime + 1)
      return m.top + ih - (ih * (Math.log10(t + 1) - lo)) / (hi - lo || 1)
    }
    return m.top + ih - (ih * t) / maxTime
  }

  const xTicks = Array.from({ length: Math.min(maxSolved, 6) + 1 }, (_, i) =>
    Math.round((i * maxSolved) / Math.min(maxSolved, 6)),
  )
  const yTickVals = logScale
    ? [1, 10, 100, 1000, 10000].filter((v) => v <= maxTime * 1.5)
    : Array.from({ length: 5 }, (_, i) => (maxTime * i) / 4)

  return (
    <div className="lab-cactus">
      <svg viewBox={`0 0 ${W} ${H}`} className="lab-cactus-svg" role="img" aria-label="Cactus plot">
        {/* grid + axes */}
        {yTickVals.map((v, i) => (
          <g key={i}>
            <line x1={m.left} x2={W - m.right} y1={ty(v)} y2={ty(v)} className="lab-grid-line" />
            <text x={m.left - 8} y={ty(v) + 4} className="lab-axis-label" textAnchor="end">
              {fmtMs(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v, i) => (
          <text key={i} x={tx(v)} y={H - m.bottom + 18} className="lab-axis-label" textAnchor="middle">
            {v}
          </text>
        ))}
        <text x={m.left + iw / 2} y={H - 6} className="lab-axis-title" textAnchor="middle">
          instances solved
        </text>
        <text
          x={14}
          y={m.top + ih / 2}
          className="lab-axis-title"
          textAnchor="middle"
          transform={`rotate(-90 14 ${m.top + ih / 2})`}
        >
          cumulative time{logScale ? ' (log)' : ''}
        </text>

        {/* curves */}
        {data.map((d) => {
          if (d.points.length === 0) return null
          const pts = [{ solved: 0, cumTimeMs: 0 }, ...d.points]
          const path = pts.map((p) => `${tx(p.solved)},${ty(p.cumTimeMs)}`).join(' ')
          const color = colorOf(d.configId)
          return (
            <g key={d.configId}>
              <polyline points={path} fill="none" stroke={color} strokeWidth={2} />
              {d.points.map((p, i) => (
                <circle key={i} cx={tx(p.solved)} cy={ty(p.cumTimeMs)} r={2.5} fill={color} />
              ))}
            </g>
          )
        })}
      </svg>
      <div className="lab-legend">
        {data.map((d) => (
          <span key={d.configId} className="lab-legend-item">
            <span className="lab-swatch" style={{ background: colorOf(d.configId) }} />
            {labelOf(d.configId)} <em>({d.points.length})</em>
          </span>
        ))}
      </div>
    </div>
  )
}

// ---- leaderboard ----------------------------------------------------------

interface LbProps {
  ranked: Array<{
    configId: string
    solved: number
    total: number
    par2: number
    timeSolvedMs: number
    meanConflicts: number
    meanDecisions: number
  }>
  colorOf: (id: string) => string
  labelOf: (id: string) => string
}

function Leaderboard({ ranked, colorOf, labelOf }: LbProps) {
  return (
    <div className="lab-table-wrap">
      <table className="lab-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Configuration</th>
            <th>Solved</th>
            <th>PAR-2</th>
            <th>Σ time</th>
            <th>x̄ conflicts</th>
            <th>x̄ decisions</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((s, i) => (
            <tr key={s.configId} className={i === 0 ? 'lab-row-best' : ''}>
              <td>{i + 1}</td>
              <td>
                <span className="lab-swatch" style={{ background: colorOf(s.configId) }} />
                {labelOf(s.configId)}
              </td>
              <td>
                <span className="lab-solved-bar">
                  <span
                    style={{ width: `${s.total ? (100 * s.solved) / s.total : 0}%`, background: colorOf(s.configId) }}
                  />
                </span>
                {s.solved}/{s.total}
              </td>
              <td>{fmtMs(s.par2)}</td>
              <td>{fmtMs(s.timeSolvedMs)}</td>
              <td>{Math.round(s.meanConflicts).toLocaleString()}</td>
              <td>{Math.round(s.meanDecisions).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- heatmap --------------------------------------------------------------

interface HeatProps {
  instances: InstanceMeta[]
  configs: { id: string; label: string }[]
  results: RunResult[]
  colorOf: (id: string) => string
}

function Heatmap({ instances, configs, results, colorOf }: HeatProps) {
  const byCell = useMemo(() => {
    const m = new Map<string, RunResult>()
    for (const r of results) m.set(`${r.configId}|${r.instanceId}`, r)
    return m
  }, [results])

  // Fastest solved time per instance, for relative coloring.
  const minTime = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of results) {
      if (r.status === 'sat' || r.status === 'unsat') {
        const cur = m.get(r.instanceId)
        if (cur === undefined || r.timeMs < cur) m.set(r.instanceId, r.timeMs)
      }
    }
    return m
  }, [results])

  return (
    <div className="lab-heat-wrap">
      <table className="lab-heat">
        <thead>
          <tr>
            <th className="lab-heat-corner" />
            {instances.map((inst) => (
              <th key={inst.id} className="lab-heat-col" title={`${inst.label} · ${inst.family}`}>
                <span>{inst.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {configs.map((c) => (
            <tr key={c.id}>
              <th className="lab-heat-row" title={c.label}>
                <span className="lab-swatch" style={{ background: colorOf(c.id) }} />
                {c.label}
              </th>
              {instances.map((inst) => {
                const r = byCell.get(`${c.id}|${inst.id}`)
                if (!r) return <td key={inst.id} className="lab-cell lab-cell-pending" />
                if (r.status === 'unknown')
                  return (
                    <td key={inst.id} className="lab-cell lab-cell-timeout" title={cellTitle(inst, r)}>
                      ✕
                    </td>
                  )
                const min = minTime.get(inst.id) ?? r.timeMs
                return (
                  <td
                    key={inst.id}
                    className="lab-cell"
                    style={{ background: speedColor(r.timeMs, min) }}
                    title={cellTitle(inst, r)}
                  >
                    {r.status === 'sat' ? 'S' : 'U'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function cellTitle(inst: InstanceMeta, r: RunResult): string {
  return `${inst.label}\n${r.status.toUpperCase()} in ${fmtMs(r.timeMs)}\n${r.conflicts.toLocaleString()} conflicts · ${r.decisions.toLocaleString()} decisions · ${r.restarts} restarts`
}

// Green (fastest) → amber → red (slowest), on a log-relative scale vs the fastest
// solver on the same instance.
function speedColor(t: number, min: number): string {
  const ratio = Math.max(1, t / Math.max(0.0001, min))
  const f = Math.min(1, Math.log2(ratio) / 5) // 1× → 0, 32× → 1
  const hue = 130 - 130 * f // 130 (green) → 0 (red)
  return `hsl(${hue}, 62%, 42%)`
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  if (ms >= 10) return `${Math.round(ms)}ms`
  return `${ms.toFixed(1)}ms`
}
