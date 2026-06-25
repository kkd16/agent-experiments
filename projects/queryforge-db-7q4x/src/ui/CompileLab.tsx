// The Compile Lab — take a query, watch QueryForge *generate JavaScript* for
// it (the data-centric / push model: the whole pipeline fused into one loop),
// run that compiled function next to the row-at-a-time Volcano interpreter,
// prove the two answers are an identical multiset, and measure the speedup. The
// sixth sibling of the Optimizer / Execution / Vectorize / Concurrency /
// Recovery Labs: a deep systems idea — "compiling query plans into machine
// code" (Neumann 2011) — made legible, and here, *visible* (you read the code
// it wrote) and *measured*.

import { useMemo, useState } from 'react'
import { SCENARIOS, runBenchmark, type BenchResult } from '../db/compiled/bench'
import { prepareCompiled } from '../db/compiled/compile'
import { parse } from '../db/parser'
import type { SelectStmt, Statement } from '../db/ast'
import { formatValue } from '../db/types'
import { Engine } from '../db/engine'
import { Database } from '../db/catalog'

const ROW_STOPS = [10_000, 50_000, 100_000, 200_000, 400_000]

function fmtMs(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1)
}

/** Live codegen preview: parse the scenario query and show the generated source
 *  without running anything (so the page is interesting before you hit Run). */
function previewSource(query: string): { source: string; pipeline: string[] } | { reason: string } {
  try {
    const stmt = parse(query).find((x: Statement) => x.kind === 'select') as SelectStmt | undefined
    if (!stmt) return { reason: 'not a SELECT' }
    // A throwaway engine with just the scenario schema, no rows — codegen only
    // needs the catalog (column names / types), not data.
    const prep = prepareCompiledForPreview(stmt, query)
    return prep
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) }
  }
}

// Build the scenario's empty tables in a scratch engine so codegen can resolve
// columns, then compile — codegen needs the catalog (names/types), not data.
function prepareCompiledForPreview(stmt: SelectStmt, query: string): { source: string; pipeline: string[] } | { reason: string } {
  const scn = SCENARIOS.find((s) => s.query === query)
  const e = new Engine(new Database())
  if (scn) for (const t of scn.tables) e.execute(t.ddl)
  const prep = prepareCompiled(stmt, e.db)
  if ('reason' in prep) return { reason: prep.reason }
  return { source: prep.prepared.source, pipeline: prep.prepared.pipeline }
}

function TimingBars({ result }: { result: BenchResult }) {
  const max = Math.max(result.volcanoMs, result.compiledMs, 0.001)
  const vol = (result.volcanoMs / max) * 100
  const comp = (result.compiledMs / max) * 100
  return (
    <div className="vec-timing">
      <div className="vec-bar-row">
        <span className="vec-bar-label">Volcano (interpreted)</span>
        <div className="vec-bar-track">
          <div className="vec-bar-fill volcano" style={{ width: `${vol}%` }} />
        </div>
        <span className="vec-bar-num">{fmtMs(result.volcanoMs)} ms</span>
      </div>
      <div className="vec-bar-row">
        <span className="vec-bar-label">Compiled (JIT&rsquo;d JS)</span>
        <div className="vec-bar-track">
          <div className="vec-bar-fill compiled" style={{ width: `${comp}%` }} />
        </div>
        <span className="vec-bar-num">{fmtMs(result.compiledMs)} ms</span>
      </div>
    </div>
  )
}

export function CompileLab() {
  const [scenarioIdx, setScenarioIdx] = useState(0)
  const [rowStop, setRowStop] = useState(2)
  const [result, setResult] = useState<BenchResult | null>(null)
  const [running, setRunning] = useState(false)

  const scenario = SCENARIOS[scenarioIdx]
  const rows = ROW_STOPS[rowStop]

  // The generated source updates the moment you switch scenarios — no run needed.
  const preview = useMemo(() => previewSource(scenario.query), [scenario.query])
  const shownSource = result?.source ?? ('source' in preview ? preview.source : '')
  const shownPipeline = result?.pipeline ?? ('pipeline' in preview ? preview.pipeline : [])

  const run = () => {
    setRunning(true)
    setResult(null)
    setTimeout(() => {
      try {
        const r = runBenchmark(scenario.id, rows)
        setResult(r)
      } finally {
        setRunning(false)
      }
    }, 30)
  }

  return (
    <div className="lab vec-lab">
      <div className="lab-head">
        <h2>Compile Lab</h2>
        <p className="lab-sub">
          QueryForge doesn&rsquo;t just <em>interpret</em> your query — it can <em>compile</em> it. Watch it generate a
          JavaScript function that fuses the whole pipeline into one loop, then race that against the row-at-a-time{' '}
          <em>Volcano</em> engine. Identical answer, measured speedup, and the generated code on screen.
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
            fact rows: <strong>{rows.toLocaleString()}</strong>
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
        <button className="vec-run-btn" onClick={run} disabled={running}>
          {running ? 'Running…' : '▶ Compile & race'}
        </button>
      </div>

      <div className="vec-query">
        <code>{scenario.query}</code>
      </div>

      {'reason' in preview ? (
        <div className="lab-error">⚠ This query isn&rsquo;t in the compiled subset ({preview.reason}). It would fall back to Volcano.</div>
      ) : (
        <>
          {shownPipeline.length > 0 && (
            <div className="comp-pipeline">
              <div className="vec-sub-title">Fused pipeline — one loop, no operator boundaries</div>
              <ol className="comp-steps">
                {shownPipeline.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </div>
          )}

          <div className="comp-source-wrap">
            <div className="vec-sub-title">
              Generated JavaScript <span className="comp-dim">— produced in {result ? fmtMs(result.compileMs) : '<1'} ms, then handed to the browser&rsquo;s own JIT</span>
            </div>
            <pre className="comp-source">
              <code>{shownSource}</code>
            </pre>
          </div>
        </>
      )}

      {running && <div className="vec-running">Generating {rows.toLocaleString()} rows and racing both engines…</div>}

      {result && (
        <>
          <div className="vec-verdict-row">
            <span className={`exec-verdict ${result.identical ? 'ok' : 'bad'}`}>
              {result.identical ? '✓ identical result (multiset)' : '✗ results differ!'}
            </span>
            <span className="vec-speedup">{result.speedup.toFixed(1)}× faster</span>
            <span className="exec-stat">{result.outputRows.toLocaleString()} rows out</span>
            <span className="exec-stat dim">over {result.inputRows.toLocaleString()} input rows</span>
          </div>

          <TimingBars result={result} />

          <div className="vec-metrics">
            <div className="vec-metric">
              <div className="vec-metric-val">{result.speedup.toFixed(1)}×</div>
              <div className="vec-metric-lbl">exec speedup</div>
            </div>
            <div className="vec-metric">
              <div className="vec-metric-val">{fmtMs(result.compiledMs)} ms</div>
              <div className="vec-metric-lbl">compiled exec</div>
            </div>
            <div className="vec-metric">
              <div className="vec-metric-val">{fmtMs(result.volcanoMs)} ms</div>
              <div className="vec-metric-lbl">Volcano exec</div>
            </div>
            <div className="vec-metric">
              <div className="vec-metric-val">{result.compileMs.toFixed(2)} ms</div>
              <div className="vec-metric-lbl">codegen (one-time)</div>
            </div>
          </div>

          {result.preview.length > 0 && (
            <div className="vec-output">
              <div className="vec-sub-title">First rows of the (identical) result</div>
              <table className="vec-table">
                <thead>
                  <tr>
                    {result.columnNames.map((c, i) => (
                      <th key={i}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.preview.map((r, ri) => (
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
            Both engines read the same heaps and the multisets match bit-for-bit — yet the compiled function is{' '}
            <strong>{result.speedup.toFixed(1)}×</strong> faster. The interpreter threads every tuple through a tree of
            virtual <code>next()</code> calls, materializing an intermediate row at each operator boundary. The compiler
            instead emits <strong>one straight-line loop</strong>: the join hash tables are built inline, the probes are
            fused into the scan, and the group accumulators are plain local fields — so the browser&rsquo;s JIT compiles
            the whole pipeline to machine code with no per-operator dispatch and no intermediate tuples. The expression
            leaves still call the canonical evaluator from <code>eval.ts</code>, which is why the answer is provably
            identical: only the <em>shape</em> of the work changed, not its meaning.
          </p>
        </>
      )}

      {!result && !running && !('reason' in preview) && (
        <p className="exec-explain">
          The source above was generated from the query <em>right now</em>. Pick a dataset size and hit{' '}
          <strong>Compile &amp; race</strong> to load the rows, run the query through both engines three times (keeping
          the best), check the answers are an identical multiset, and measure how much the fused, JIT&rsquo;d pipeline
          wins by.
        </p>
      )}
    </div>
  )
}
