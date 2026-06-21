// The Execution Lab — watch memory pressure change the algorithm.
//
// Every blocking operator has a memory budget (`work_mem`). Past it, a real
// engine doesn't fail — it spills to disk and keeps the right answer. This lab
// makes that visible: pick a scenario, drag the work_mem slider, and watch the
// plan switch between an in-memory algorithm and its spilling counterpart, with
// per-operator memory bars, spilled-row counts and partition/pass tallies. A
// side-by-side "unbounded memory" run proves the answer never changes. It is the
// Concurrency / Optimizer / Recovery Labs' twin: an invisible subsystem made legible.

import { useMemo, useState } from 'react'
import { Engine } from '../db/engine'
import type { PlanNode, MemStats } from '../db/operators'
import type { Row } from '../db/catalog'

interface Scenario {
  label: string
  blurb: string
  /** DDL + data generation (a recursive-CTE row generator). */
  setup: string
  /** The query to run under varying work_mem. */
  query: string
  /** What the slider controls for this scenario, in one line. */
  note: string
}

const UNLIMITED = 1_000_000_000

const SCENARIOS: Scenario[] = [
  {
    label: 'Hash aggregate spill',
    blurb:
      '2 000 rows over 80 groups. With a small budget the hash table can’t hold every group at once, so new keys are partitioned by a hash and spilled, then each partition is re-aggregated.',
    setup:
      'CREATE TABLE metrics (g INTEGER, v INTEGER);\n' +
      'INSERT INTO metrics (g, v) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 2000) SELECT n % 80, n % 250 FROM s;',
    query: 'SELECT g, COUNT(*) AS rows, SUM(v) AS total, MIN(v) AS lo, MAX(v) AS hi\nFROM metrics\nGROUP BY g\nORDER BY g',
    note: 'work_mem = max groups held in memory before the aggregate spills.',
  },
  {
    label: 'Grace hash join',
    blurb:
      'A 400-row probe side joined to a 360-row build side on duplicated keys. Once the build side exceeds the budget, both inputs are partitioned by hash and joined partition-by-partition.',
    setup:
      'CREATE TABLE lhs (id INTEGER, k INTEGER);\n' +
      'INSERT INTO lhs (id, k) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 400) SELECT n, n % 60 FROM s;\n' +
      'CREATE TABLE rhs (id INTEGER, k INTEGER);\n' +
      'INSERT INTO rhs (id, k) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 360) SELECT n, n % 70 FROM s;',
    query: 'SELECT lhs.id, lhs.k, rhs.id\nFROM lhs JOIN rhs ON lhs.k = rhs.k\nORDER BY lhs.id, rhs.id\nLIMIT 200',
    note: 'work_mem = build rows held in memory before the join goes Grace (partitioned).',
  },
  {
    label: 'Top-N heapsort',
    blurb:
      '4 000 rows, but the query only wants the smallest 10. A bounded max-heap keeps just those 10 — O(k) memory, O(n·log k) time — instead of sorting everything. Provably identical to a full sort then LIMIT.',
    setup:
      'CREATE TABLE events (id INTEGER, ts INTEGER);\n' +
      'INSERT INTO events (id, ts) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 4000) SELECT n, (4001 - n) * 7 % 9973 FROM s;',
    query: 'SELECT id, ts FROM events ORDER BY ts LIMIT 10',
    note: 'A LIMIT bounds the sort to k rows regardless of work_mem — the heap is O(k).',
  },
  {
    label: 'External merge sort',
    blurb:
      '4 000 rows sorted with no LIMIT. When the input exceeds the budget the sort generates work_mem-sized runs on “disk” and k-way-merges them — lower the budget for more, smaller runs and more passes.',
    setup:
      'CREATE TABLE nums (k INTEGER);\n' +
      'INSERT INTO nums (k) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 4000) SELECT 4001 - n FROM s;',
    query: 'SELECT k FROM nums ORDER BY k',
    note: 'work_mem = rows per sorted run; smaller runs ⇒ more merge passes.',
  },
]

// Slider stops (rows). The last is "unlimited".
const STOPS = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, UNLIMITED]

interface Analysis {
  ok: boolean
  error?: string
  bounded?: PlanNode
  unbounded?: PlanNode
  boundedMs?: number
  unboundedMs?: number
  identical?: boolean
  rowCount?: number
  spilledTotal?: number
}

/** A stable multiset signature of a result, so a partitioned (reordered) spill
 *  can be compared to the in-memory answer. */
function rowsSignature(rows: Row[]): string {
  return rows
    .map((r) => JSON.stringify(r))
    .sort()
    .join('\n')
}

function sumSpilled(n: PlanNode): number {
  return (n.mem?.spilledRows ?? 0) + n.children.reduce((s, c) => s + sumSpilled(c), 0)
}

function runAnalysis(engine: Engine, query: string, workMem: number): Analysis {
  try {
    engine.execute(`SET work_mem = ${workMem}`)
    const be = engine.execute(`EXPLAIN ANALYZE ${query}`)[0]
    const br = engine.execute(query)[0]
    engine.execute(`SET work_mem = ${UNLIMITED}`)
    const ue = engine.execute(`EXPLAIN ANALYZE ${query}`)[0]
    const ur = engine.execute(query)[0]
    if (be.kind !== 'explain' || ue.kind !== 'explain' || br.kind !== 'rows' || ur.kind !== 'rows') {
      return { ok: false, error: 'expected EXPLAIN + rows results' }
    }
    return {
      ok: true,
      bounded: be.plan,
      unbounded: ue.plan,
      boundedMs: br.elapsedMs,
      unboundedMs: ur.elapsedMs,
      identical: rowsSignature(br.rows) === rowsSignature(ur.rows),
      rowCount: br.rowCount,
      spilledTotal: sumSpilled(be.plan),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n))
}
function memLabel(m: MemStats): string {
  return m.budget >= UNLIMITED ? 'unlimited' : `${fmt(m.budget)} rows`
}

/** A plan node that foregrounds memory: the operator, its method, a peak-vs-budget
 *  bar, and spill stats when it spilled. */
function MemNode({ node }: { node: PlanNode }) {
  const m = node.mem
  const spilled = m && m.spilledRows > 0
  const pct = m && m.budget > 0 && m.budget < UNLIMITED ? Math.min(100, (m.peakRows / m.budget) * 100) : m ? Math.min(100, m.peakRows / Math.max(1, node.estRows) * 100) : 0
  return (
    <li>
      <div className={`exec-node ${spilled ? 'spilled' : m ? 'inmem' : ''}`}>
        <div className="exec-node-head">
          <span className="plan-op">{node.op}</span>
          {node.detail && <span className="plan-detail">{node.detail}</span>}
          {m && <span className={`exec-method ${spilled ? 'spilled' : ''}`}>{m.method}</span>}
        </div>
        <div className="plan-metrics">
          <span title="actual rows">{fmt(node.actualRows)} rows</span>
          {m && <span title="peak rows held in memory">peak {fmt(m.peakRows)}</span>}
          {m && m.budget < UNLIMITED && <span title="work_mem budget">budget {fmt(m.budget)}</span>}
          {spilled && <span className="exec-spill-badge">spilled {fmt(m.spilledRows)}</span>}
          {m && m.partitions ? <span title="spill partitions">{m.partitions}&nbsp;parts</span> : null}
          {m && m.passes && m.passes > 1 ? <span title="passes / recursion">{m.passes}&nbsp;passes</span> : null}
        </div>
        {m && (
          <div className="exec-mem-bar" title={`peak ${m.peakRows} vs budget ${memLabel(m)}`}>
            <div className={`exec-mem-fill ${spilled ? 'over' : ''}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {node.extra.length > 0 && (
          <div className="plan-extra">
            {node.extra.map((x, i) => (
              <span key={i}>{x}</span>
            ))}
          </div>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="plan-children">
          {node.children.map((c, i) => (
            <MemNode key={i} node={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function ExecutionLab() {
  const [scenarioIdx, setScenarioIdx] = useState(0)
  const [stop, setStop] = useState(2) // index into STOPS (default 16 rows)
  const scenario = SCENARIOS[scenarioIdx]
  const workMem = STOPS[stop]

  // Build the dataset once per scenario; only the work_mem changes as you drag.
  const engine = useMemo(() => {
    const e = new Engine()
    try {
      e.execute(scenario.setup)
    } catch {
      /* surfaced via analysis */
    }
    return e
  }, [scenario])

  const analysis = useMemo(() => runAnalysis(engine, scenario.query, workMem), [engine, scenario, workMem])

  return (
    <div className="lab exec-lab">
      <div className="lab-head">
        <h2>Execution Lab</h2>
        <p className="lab-sub">
          Watch a query&rsquo;s operators spill to &ldquo;disk&rdquo; as you shrink the in-memory budget &mdash; and watch the
          answer stay <em>exactly</em> the same.
        </p>
      </div>

      <div className="exec-scenarios">
        {SCENARIOS.map((s, i) => (
          <button key={s.label} className={`exec-scn ${i === scenarioIdx ? 'active' : ''}`} onClick={() => setScenarioIdx(i)}>
            {s.label}
          </button>
        ))}
      </div>

      <p className="exec-blurb">{scenario.blurb}</p>

      <div className="exec-controls">
        <label className="exec-slider-label">
          <span>
            work_mem: <strong>{workMem >= UNLIMITED ? 'unlimited' : `${workMem.toLocaleString()} rows`}</strong>
          </span>
          <input
            type="range"
            min={0}
            max={STOPS.length - 1}
            step={1}
            value={stop}
            onChange={(e) => setStop(Number(e.target.value))}
          />
        </label>
        <span className="exec-note">{scenario.note}</span>
      </div>

      {!analysis.ok ? (
        <div className="lab-error">⚠ {analysis.error}</div>
      ) : (
        <>
          <div className="exec-verdict-row">
            <span className={`exec-verdict ${analysis.identical ? 'ok' : 'bad'}`}>
              {analysis.identical ? '✓ identical result' : '✗ results differ!'}
            </span>
            <span className="exec-stat">{fmt(analysis.rowCount ?? 0)} rows out</span>
            <span className="exec-stat">
              {analysis.spilledTotal ? `${fmt(analysis.spilledTotal)} rows spilled` : 'fully in memory'}
            </span>
            <span className="exec-stat dim">
              {analysis.boundedMs?.toFixed(2)} ms &nbsp;vs&nbsp; {analysis.unboundedMs?.toFixed(2)} ms unbounded
            </span>
          </div>

          <div className="exec-query">
            <code>{scenario.query}</code>
          </div>

          <div className="exec-plans">
            <div className="exec-plan-col">
              <div className="exec-plan-title">
                Plan at work_mem = {workMem >= UNLIMITED ? 'unlimited' : workMem.toLocaleString()}
              </div>
              <div className="plan-tree">
                <ul className="plan-root">{analysis.bounded && <MemNode node={analysis.bounded} />}</ul>
              </div>
            </div>
            <div className="exec-plan-col">
              <div className="exec-plan-title dim">Plan with unbounded memory (reference)</div>
              <div className="plan-tree">
                <ul className="plan-root">{analysis.unbounded && <MemNode node={analysis.unbounded} />}</ul>
              </div>
            </div>
          </div>

          <p className="exec-explain">
            Spilling operators degrade gracefully: a tight budget trades memory for extra passes over &ldquo;disk&rdquo;, never
            correctness. The reference plan on the right runs the same query with the budget effectively infinite, so every
            operator stays in memory &mdash; and its rows match the bounded run on the left, multiset for multiset.
          </p>
        </>
      )}
    </div>
  )
}
