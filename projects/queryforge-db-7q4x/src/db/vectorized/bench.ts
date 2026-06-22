// The benchmark harness behind the Vectorize Lab. It generates a large dataset,
// runs the SAME query through the Volcano engine (`engine.execute`) and the
// vectorized engine, asserts the two result multisets are identical (the
// correctness gate — a faster engine that disagrees is worthless), and measures
// the speedup, including a vector-width sweep.

import { Engine } from '../engine'
import { Database } from '../catalog'
import type { Row } from '../catalog'
import type { SelectStmt, Statement } from '../ast'
import { parse } from '../parser'
import { formatValue } from '../types'
import { prepareVectorized } from './engine'
import { DEFAULT_VECTOR_SIZE } from './types'

export interface BenchScenario {
  id: string
  label: string
  blurb: string
  /** DDL that creates the single source table. */
  ddl: string
  tableName: string
  /** Build one row for 0-based index i (integers only ⇒ exact SUM). */
  gen: (i: number, rnd: (mod: number) => number) => Row
  /** The query, run identically through both engines. */
  query: string
  defaultRows: number
}

// A deterministic 32-bit PRNG (mulberry32) so every run is reproducible.
function makeRng(seed: number): (mod: number) => number {
  let a = seed >>> 0
  return (mod: number) => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296
    return Math.floor(u * mod)
  }
}

export const SCENARIOS: BenchScenario[] = [
  {
    id: 'groupby',
    label: 'Group-by aggregation',
    blurb:
      'The canonical OLAP query: scan a fact table and roll it up by a low-cardinality key into COUNT / SUM / AVG / MIN / MAX. The Volcano engine builds a string hash key per row; the vectorized engine hashes the integer key natively and reads packed columns.',
    ddl: 'CREATE TABLE sales (region INTEGER, product INTEGER, amount INTEGER, qty INTEGER)',
    tableName: 'sales',
    gen: (i, rnd) => [i % 16, rnd(200), 1 + rnd(1000), 1 + rnd(20)],
    query:
      'SELECT region, COUNT(*) AS orders, SUM(amount) AS revenue, AVG(amount) AS avg_amount, MIN(amount) AS lo, MAX(amount) AS hi\nFROM sales\nGROUP BY region\nORDER BY region',
    defaultRows: 200000,
  },
  {
    id: 'filter',
    label: 'Heavy filter scan',
    blurb:
      'A selective conjunctive predicate over a wide scan, then ORDER BY … LIMIT. The vectorized engine evaluates the predicate over packed columns and carries only the surviving rows through a selection vector — no intermediate tuples are materialized.',
    ddl: 'CREATE TABLE events (id INTEGER, x INTEGER, y INTEGER, score INTEGER)',
    tableName: 'events',
    gen: (i, rnd) => [i, rnd(1000), rnd(1000), rnd(100000)],
    query:
      'SELECT id, x, y, score\nFROM events\nWHERE x < 80 AND y > 920 AND score % 7 = 0\nORDER BY id\nLIMIT 100',
    defaultRows: 200000,
  },
  {
    id: 'wide',
    label: 'Wide multi-aggregate roll-up',
    blurb:
      'Many groups (≈1 000 buckets) and seven aggregates at once. This stresses the group hash table the hardest — exactly where native integer keying and columnar accumulators pull furthest ahead of per-row string keys.',
    ddl: 'CREATE TABLE metrics (bucket INTEGER, a INTEGER, b INTEGER, c INTEGER)',
    tableName: 'metrics',
    gen: (i, rnd) => [i % 1000, rnd(500), rnd(5000), rnd(50000)],
    query:
      'SELECT bucket, COUNT(*) AS n, SUM(a) AS sa, SUM(b) AS sb, SUM(c) AS sc, MIN(a) AS mina, MAX(c) AS maxc\nFROM metrics\nGROUP BY bucket\nORDER BY bucket',
    defaultRows: 200000,
  },
]

export function scenarioById(id: string): BenchScenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]
}

/** Build a fresh engine, create the scenario table and bulk-load `n` rows
 *  straight into the heap (bypassing the SQL path for speed). */
export function buildDataset(scenario: BenchScenario, n: number, seed = 0x1234): Engine {
  const engine = new Engine(new Database())
  engine.execute(scenario.ddl)
  const table = engine.db.getTable(scenario.tableName)
  const rnd = makeRng(seed)
  for (let i = 0; i < n; i++) table.insertRawRow(scenario.gen(i, rnd))
  return engine
}

/** A stable multiset signature of a result, independent of row order. */
export function rowsSignature(rows: Row[]): string {
  return rows
    .map((r) => r.map(formatValue).join(''))
    .sort()
    .join('')
}

function firstSelect(sql: string): SelectStmt {
  const stmts: Statement[] = parse(sql)
  const s = stmts.find((x) => x.kind === 'select')
  if (!s) throw new Error('benchmark query is not a SELECT')
  return s as SelectStmt
}

function bestOf(times: number, fn: () => number): number {
  let best = Infinity
  for (let t = 0; t < times; t++) best = Math.min(best, fn())
  return best
}

export interface SweepPoint {
  vectorSize: number
  execMs: number
  throughput: number // input rows / sec
}

export interface BenchResult {
  supported: boolean
  reason?: string
  inputRows: number
  outputRows: number
  identical: boolean
  volcanoMs: number
  vectorBuildMs: number
  vectorExecMs: number
  vectorTotalMs: number
  speedupExec: number
  speedupTotal: number
  volcanoThroughput: number
  vectorThroughput: number
  columns: string[]
  sampleRows: Row[]
  sweep: SweepPoint[]
}

const SWEEP_WIDTHS = [16, 64, 256, 512, 1024, 2048, 4096, 8192, 16384]

export function runBenchmark(
  scenario: BenchScenario,
  n: number,
  vectorSize: number = DEFAULT_VECTOR_SIZE,
  reps = 3,
): BenchResult {
  const engine = buildDataset(scenario, n)
  const stmt = firstSelect(scenario.query)

  // Vectorized support check.
  const prep = prepareVectorized(stmt, engine.db)
  if ('reason' in prep) {
    return {
      supported: false,
      reason: prep.reason,
      inputRows: n,
      outputRows: 0,
      identical: false,
      volcanoMs: 0,
      vectorBuildMs: 0,
      vectorExecMs: 0,
      vectorTotalMs: 0,
      speedupExec: 0,
      speedupTotal: 0,
      volcanoThroughput: 0,
      vectorThroughput: 0,
      columns: [],
      sampleRows: [],
      sweep: [],
    }
  }
  const prepared = prep.prepared

  // --- Volcano (engine.execute) ---
  let volcanoRows: Row[] = []
  let volcanoCols: string[] = []
  const volcanoMs = bestOf(reps, () => {
    const t0 = performance.now()
    const res = engine.execute(scenario.query)[0]
    const ms = performance.now() - t0
    if (res.kind === 'rows') {
      volcanoRows = res.rows
      volcanoCols = res.columns.map((c) => c.name)
    }
    return ms
  })

  // --- Vectorized ---
  let vecRun = prepared.run(engine.db, vectorSize)
  let vectorExecMs = vecRun.execMs
  let vectorBuildMs = vecRun.buildMs
  for (let t = 1; t < reps; t++) {
    const r = prepared.run(engine.db, vectorSize)
    vectorExecMs = Math.min(vectorExecMs, r.execMs)
    vectorBuildMs = Math.min(vectorBuildMs, r.buildMs)
    vecRun = r
  }
  const vectorTotalMs = vectorBuildMs + vectorExecMs

  // --- correctness gate ---
  const identical = rowsSignature(volcanoRows) === rowsSignature(vecRun.rows)

  // --- vector-width sweep (exec-only) ---
  const sweep: SweepPoint[] = SWEEP_WIDTHS.map((w) => {
    const execMs = bestOf(reps, () => prepared.run(engine.db, w).execMs)
    return { vectorSize: w, execMs, throughput: (n / execMs) * 1000 }
  })

  return {
    supported: true,
    inputRows: n,
    outputRows: vecRun.outputRows,
    identical,
    volcanoMs,
    vectorBuildMs,
    vectorExecMs,
    vectorTotalMs,
    speedupExec: vectorExecMs > 0 ? volcanoMs / vectorExecMs : 0,
    speedupTotal: vectorTotalMs > 0 ? volcanoMs / vectorTotalMs : 0,
    volcanoThroughput: volcanoMs > 0 ? (n / volcanoMs) * 1000 : 0,
    vectorThroughput: vectorExecMs > 0 ? (n / vectorExecMs) * 1000 : 0,
    columns: volcanoCols.length ? volcanoCols : vecRun.columnNames,
    sampleRows: vecRun.rows.slice(0, 12),
    sweep,
  }
}
