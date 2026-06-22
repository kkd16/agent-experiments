// The Vectorize Lab — run the SAME query through the Volcano (row-at-a-time)
// engine and the from-scratch vectorized (columnar, batched) engine over a large
// dataset, prove the two answers are an identical multiset, and measure the
// speedup. The fifth sibling of the Concurrency / Optimizer / Recovery /
// Execution Labs: a deep systems idea made legible and, here, *measured*.

import { useState } from 'react'
import { SCENARIOS, runBenchmark, type BenchResult } from '../db/vectorized/bench'
import { formatValue } from '../db/types'

const ROW_STOPS = [50_000, 100_000, 200_000, 400_000, 800_000]
const WIDTH_STOPS = [64, 256, 512, 1024, 2048, 4096]

function fmtMs(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1)
}
function fmtThroughput(rowsPerSec: number): string {
  if (rowsPerSec >= 1e9) return `${(rowsPerSec / 1e9).toFixed(2)}B rows/s`
  if (rowsPerSec >= 1e6) return `${(rowsPerSec / 1e6).toFixed(1)}M rows/s`
  if (rowsPerSec >= 1e3) return `${(rowsPerSec / 1e3).toFixed(0)}K rows/s`
  return `${rowsPerSec.toFixed(0)} rows/s`
}

/** The throughput-vs-vector-width sweep, drawn as a small SVG bar chart. */
function SweepChart({ result }: { result: BenchResult }) {
  const pts = result.sweep
  if (!pts.length) return null
  const max = Math.max(...pts.map((p) => p.throughput))
  const best = pts.reduce((a, b) => (b.throughput > a.throughput ? b : a))
  const W = 460
  const H = 150
  const padL = 6
  const padB = 26
  const barGap = 8
  const barW = (W - padL * 2 - barGap * (pts.length - 1)) / pts.length
  return (
    <div className="vec-sweep">
      <div className="vec-sub-title">
        Throughput vs. vector width &mdash; the cache-residency sweet spot peaks near{' '}
        <strong>{best.vectorSize.toLocaleString()}</strong> values/batch
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="vec-sweep-svg" role="img" aria-label="throughput vs vector width">
        {pts.map((p, i) => {
          const h = max > 0 ? (p.throughput / max) * (H - padB - 8) : 0
          const x = padL + i * (barW + barGap)
          const y = H - padB - h
          const isBest = p.vectorSize === best.vectorSize
          return (
            <g key={p.vectorSize}>
              <rect x={x} y={y} width={barW} height={h} rx={2} className={`vec-bar ${isBest ? 'best' : ''}`} />
              <text x={x + barW / 2} y={H - padB + 12} textAnchor="middle" className="vec-axis">
                {p.vectorSize >= 1024 ? `${p.vectorSize / 1024}k` : p.vectorSize}
              </text>
              <text x={x + barW / 2} y={y - 4} textAnchor="middle" className="vec-axis-val">
                {(p.throughput / 1e6).toFixed(0)}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="vec-axis-caption">bars: million rows/sec (exec-only) &middot; x-axis: vector width</div>
    </div>
  )
}

function TimingBars({ result }: { result: BenchResult }) {
  const max = Math.max(result.volcanoMs, result.vectorExecMs, 0.001)
  const vol = (result.volcanoMs / max) * 100
  const vec = (result.vectorExecMs / max) * 100
  return (
    <div className="vec-timing">
      <div className="vec-bar-row">
        <span className="vec-bar-label">Volcano (row-at-a-time)</span>
        <div className="vec-bar-track">
          <div className="vec-bar-fill volcano" style={{ width: `${vol}%` }} />
        </div>
        <span className="vec-bar-num">{fmtMs(result.volcanoMs)} ms</span>
      </div>
      <div className="vec-bar-row">
        <span className="vec-bar-label">Vectorized (columnar)</span>
        <div className="vec-bar-track">
          <div className="vec-bar-fill vector" style={{ width: `${Math.max(vec, 1)}%` }} />
        </div>
        <span className="vec-bar-num">{fmtMs(result.vectorExecMs)} ms</span>
      </div>
    </div>
  )
}

export function VectorLab() {
  const [scenarioIdx, setScenarioIdx] = useState(0)
  const [rowStop, setRowStop] = useState(2) // 200k
  const [widthStop, setWidthStop] = useState(3) // 1024
  const [result, setResult] = useState<BenchResult | null>(null)
  const [running, setRunning] = useState(false)

  const scenario = SCENARIOS[scenarioIdx]
  const rows = ROW_STOPS[rowStop]
  const width = WIDTH_STOPS[widthStop]

  const run = () => {
    setRunning(true)
    setResult(null)
    // Defer so the "running…" state paints before the blocking benchmark.
    setTimeout(() => {
      try {
        const r = runBenchmark(scenario, rows, width, 3)
        setResult(r)
      } finally {
        setRunning(false)
      }
    }, 30)
  }

  return (
    <div className="lab vec-lab">
      <div className="lab-head">
        <h2>Vectorize Lab</h2>
        <p className="lab-sub">
          The same SQL, two engines: the row-at-a-time <em>Volcano</em> executor vs. a from-scratch{' '}
          <em>vectorized</em> columnar engine. Identical answer, measured speedup.
        </p>
      </div>

      <div className="exec-scenarios">
        {SCENARIOS.map((s, i) => (
          <button
            key={s.id}
            className={`exec-scn ${i === scenarioIdx ? 'active' : ''}`}
            onClick={() => {
              setScenarioIdx(i)
              setResult(null)
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="exec-blurb">{scenario.blurb}</p>

      <div className="vec-controls">
        <label className="exec-slider-label">
          <span>
            rows: <strong>{rows.toLocaleString()}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={ROW_STOPS.length - 1}
            step={1}
            value={rowStop}
            onChange={(e) => setRowStop(Number(e.target.value))}
          />
        </label>
        <label className="exec-slider-label">
          <span>
            vector width: <strong>{width.toLocaleString()}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={WIDTH_STOPS.length - 1}
            step={1}
            value={widthStop}
            onChange={(e) => setWidthStop(Number(e.target.value))}
          />
        </label>
        <button className="vec-run-btn" onClick={run} disabled={running}>
          {running ? 'Running…' : '▶ Run benchmark'}
        </button>
      </div>

      <div className="vec-query">
        <code>{scenario.query}</code>
      </div>

      {running && <div className="vec-running">Generating {rows.toLocaleString()} rows and racing both engines…</div>}

      {result && !result.supported && (
        <div className="lab-error">
          ⚠ The vectorized engine declined this query ({result.reason}) — it would fall back to Volcano. This is the
          safety valve: the vectorized path only runs what it can prove it matches.
        </div>
      )}

      {result && result.supported && (
        <>
          <div className="vec-verdict-row">
            <span className={`exec-verdict ${result.identical ? 'ok' : 'bad'}`}>
              {result.identical ? '✓ identical result (multiset)' : '✗ results differ!'}
            </span>
            <span className="vec-speedup">{result.speedupExec.toFixed(1)}× faster</span>
            <span className="exec-stat">{result.outputRows.toLocaleString()} rows out</span>
            <span className="exec-stat dim">
              over {result.inputRows.toLocaleString()} input rows · vector width {width.toLocaleString()}
            </span>
          </div>

          <TimingBars result={result} />

          <div className="vec-metrics">
            <div className="vec-metric">
              <div className="vec-metric-val">{fmtThroughput(result.vectorThroughput)}</div>
              <div className="vec-metric-lbl">vectorized throughput</div>
            </div>
            <div className="vec-metric">
              <div className="vec-metric-val">{fmtThroughput(result.volcanoThroughput)}</div>
              <div className="vec-metric-lbl">Volcano throughput</div>
            </div>
            <div className="vec-metric">
              <div className="vec-metric-val">{result.speedupExec.toFixed(1)}×</div>
              <div className="vec-metric-lbl">exec-only speedup</div>
            </div>
            <div className="vec-metric">
              <div className="vec-metric-val">{fmtMs(result.vectorBuildMs)} ms</div>
              <div className="vec-metric-lbl">columnar transpose (one-time)</div>
            </div>
          </div>

          <SweepChart result={result} />

          {result.sampleRows.length > 0 && (
            <div className="vec-output">
              <div className="vec-sub-title">First rows of the (identical) result</div>
              <table className="vec-table">
                <thead>
                  <tr>
                    {result.columns.map((c, i) => (
                      <th key={i}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.sampleRows.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((v, ci) => (
                        <td key={ci}>{formatValue(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="exec-explain">
            Both engines read the same heap and the multisets match bit-for-bit — yet the vectorized engine is{' '}
            <strong>{result.speedupExec.toFixed(1)}×</strong> faster on execution. The win comes from four things the
            row-at-a-time model can&rsquo;t do: <strong>columnar typed-array reads</strong> (a million integers in one
            packed buffer, no boxed <code>SqlValue</code>s), a <strong>selection vector</strong> that narrows a filter
            instead of copying rows, <strong>native integer key hashing</strong> for GROUP BY (no per-row string key),
            and <strong>tight batch loops</strong> the JIT keeps in registers — versus threading every row through a
            chain of virtual <code>next()</code> calls. The one-time {fmtMs(result.vectorBuildMs)} ms columnar transpose
            is work a real column store pays once at load, not per query.
          </p>
        </>
      )}

      {!result && !running && (
        <p className="exec-explain">
          Pick a scenario, choose a dataset size and vector width, and hit <strong>Run benchmark</strong>. The Lab
          generates the rows, runs the query through both engines three times (keeping the best), checks the answers are
          an identical multiset, and charts the throughput as the vector width sweeps from cache-friendly to cache-busting.
        </p>
      )}
    </div>
  )
}
