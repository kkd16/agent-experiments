// The Fuzz Lab — a from-scratch metamorphic SQL tester, live in the browser. Pick a
// seed and an iteration budget, and the lab builds a random database and throws
// thousands of random queries at the engine, each checked against an *oracle* — an
// identity that must hold for any correct engine, no reference database required.
// A green banner means the engine survived; a red one shows the minimized,
// paste-able query that breaks it. This is the technique (SQLancer: NoREC/TLP) that
// has found hundreds of real bugs in SQLite, PostgreSQL, MySQL and DuckDB — and it
// found three in QueryForge the first time it ran (all since fixed; see the journal).

import { useState } from 'react'
import { runFuzz, ORACLES, type FuzzReport } from '../db/fuzz/runner'
import type { OracleKind } from '../db/fuzz/oracles'

const ITER_STOPS = [200, 500, 1000, 2000, 5000]

const ORACLE_DOC: Record<OracleKind, string> = {
  'TLP-WHERE':
    'Ternary Logic Partitioning. Every row satisfies exactly one of p / NOT p / p IS NULL, so an unfiltered scan equals the multiset-union of the three filtered scans.',
  'TLP-AGG':
    'The same three-way partition, checked through COUNT(*) and SUM — an aggregate over the whole must equal the sum of the aggregate over the parts.',
  NoREC:
    'Non-optimizing Reference Engine Construction. COUNT(*) … WHERE p (the optimizer may use an index) must equal SUM(CASE WHEN p THEN 1 ELSE 0 END) (a plain per-row scan it can’t optimize).',
  DISTINCT:
    'SELECT DISTINCT must equal the engine’s own non-distinct scan, de-duplicated by the canonical row key — the optimizer’s DISTINCT vs. a ground-truth dedup.',
  'OPT-DIFF':
    'The very same query with the optimizer ON vs. OFF (no join reordering, no index access paths) must return an identical multiset — a sound optimizer never changes a result.',
}

function rollSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000)
}

export function FuzzLab() {
  const [seed, setSeed] = useState(42)
  const [iterStop, setIterStop] = useState(1)
  const [report, setReport] = useState<FuzzReport | null>(null)
  const [running, setRunning] = useState(false)

  const iterations = ITER_STOPS[iterStop]

  const run = () => {
    setRunning(true)
    setReport(null)
    // Defer so the "running…" state paints before the (blocking) fuzz loop.
    setTimeout(() => {
      try {
        setReport(runFuzz(seed, iterations, { maxBugs: 10, shrinkBugs: true }))
      } finally {
        setRunning(false)
      }
    }, 30)
  }

  const clean = report && report.counterexamples.length === 0 && report.errors.length === 0

  return (
    <div className="lab fuzz-lab">
      <div className="lab-head">
        <h2>Fuzz Lab</h2>
        <p className="lab-sub">
          A metamorphic SQL tester. It builds a random database from a seed and checks thousands of random queries
          against <em>oracles</em> — identities that must hold for any correct engine, with no reference database to
          compare against. Reproducible to the byte from the seed; any counterexample is automatically{' '}
          <strong>shrunk</strong> to a minimal repro.
        </p>
      </div>

      <div className="fuzz-controls">
        <label className="fuzz-seed">
          <span>seed</span>
          <input
            type="number"
            value={seed}
            min={0}
            onChange={(e) => {
              setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))
              setReport(null)
            }}
          />
        </label>
        <button
          className="fuzz-dice"
          title="random seed"
          onClick={() => {
            setSeed(rollSeed())
            setReport(null)
          }}
        >
          🎲
        </button>
        <label className="exec-slider-label">
          <span>
            queries: <strong>{iterations.toLocaleString()}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={ITER_STOPS.length - 1}
            step={1}
            value={iterStop}
            onChange={(e) => {
              setIterStop(Number(e.target.value))
              setReport(null)
            }}
          />
        </label>
        <button className="vec-run-btn" onClick={run} disabled={running}>
          {running ? 'Fuzzing…' : '▶ Run fuzzer'}
        </button>
      </div>

      <div className="fuzz-oracles">
        {ORACLES.map((o) => (
          <div className="fuzz-oracle-card" key={o}>
            <div className="fuzz-oracle-name">{o}</div>
            <div className="fuzz-oracle-doc">{ORACLE_DOC[o]}</div>
          </div>
        ))}
      </div>

      {running && (
        <div className="vec-running">
          Building database #{seed} and running {iterations.toLocaleString()} metamorphic checks…
        </div>
      )}

      {report && (
        <>
          <div className="fuzz-verdict-row">
            <span className={`exec-verdict ${clean ? 'ok' : 'bad'}`}>
              {clean
                ? '✓ no counterexamples — every oracle held'
                : `✗ ${report.counterexamples.length + report.errors.length} counterexample${
                    report.counterexamples.length + report.errors.length === 1 ? '' : 's'
                  }`}
            </span>
            <span className="exec-stat">
              <strong>{report.queriesRun.toLocaleString()}</strong> SQL queries executed
            </span>
            <span className="exec-stat dim">seed {report.seed}</span>
          </div>

          <div className="fuzz-oracle-counts">
            {ORACLES.map((o) => (
              <span className="fuzz-count-chip" key={o}>
                {o} <strong>{report.oracleChecks[o].toLocaleString()}</strong>
              </span>
            ))}
          </div>

          {report.errors.map((err, i) => (
            <div className="lab-error" key={`e${i}`}>
              ⚠ engine error in a {err.oracle} check: {err.detail}
            </div>
          ))}

          {report.counterexamples.map((ce, i) => (
            <div className="fuzz-bug" key={`b${i}`}>
              <div className="fuzz-bug-head">
                <span className="fuzz-bug-oracle">{ce.oracle}</span>
                <span className="fuzz-bug-detail">{ce.detail}</span>
                <span className="fuzz-bug-rows">minimized to {ce.rowsAfterShrink} row(s)</span>
              </div>
              {ce.sampleDiff.length > 0 && (
                <div className="fuzz-bug-diff">
                  {ce.sampleDiff.map((d, j) => (
                    <code key={j}>{d}</code>
                  ))}
                </div>
              )}
              <pre className="fuzz-bug-repro">{ce.reproSql.join('\n')}</pre>
            </div>
          ))}

          {clean && (
            <p className="fuzz-clean-note">
              The engine answered {report.queriesRun.toLocaleString()} randomized queries with perfect metamorphic
              consistency. Try another seed, or push the slider to 5,000 queries.
            </p>
          )}
        </>
      )}
    </div>
  )
}
