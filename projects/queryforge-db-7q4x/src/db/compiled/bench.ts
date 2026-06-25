// The benchmark harness behind the Compile Lab. It builds a dataset (often a
// little star schema), runs the SAME query through the Volcano interpreter
// (`engine.execute`) and the compiled function, asserts the two result
// multisets are identical (the correctness gate — a faster engine that
// disagrees is worthless), and measures the speedup.

import { Engine } from '../engine'
import { Database } from '../catalog'
import type { Row } from '../catalog'
import type { SelectStmt, Statement } from '../ast'
import { parse } from '../parser'
import { formatValue } from '../types'
import { prepareCompiled, type CompiledQuery } from './compile'

/** One source table in a scenario. */
export interface BenchTable {
  ddl: string
  name: string
  /** Build one row for 0-based index i. `rnd(mod)` is a deterministic PRNG. */
  gen: (i: number, rnd: (mod: number) => number) => Row
  /** Row count — a function of the scenario's headline scale `n`. */
  count: (n: number) => number
}

export interface BenchScenario {
  id: string
  label: string
  blurb: string
  tables: BenchTable[]
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
    id: 'star-join',
    label: 'Star-schema join + roll-up',
    blurb:
      'The textbook OLAP shape — a big fact table joined to a small dimension, rolled up by a dimension attribute. The interpreter pulls every probed tuple through a HashJoin→HashAggregate operator chain; the compiler fuses the dimension hash-table build, the probe, and the group accumulators into one straight-line loop with no intermediate tuples.',
    tables: [
      {
        ddl: 'CREATE TABLE region (id INTEGER, zone INTEGER)',
        name: 'region',
        gen: (i, rnd) => [i, rnd(5)],
        count: () => 64,
      },
      {
        ddl: 'CREATE TABLE sales (id INTEGER, region_id INTEGER, amount INTEGER, qty INTEGER)',
        name: 'sales',
        gen: (i, rnd) => [i, rnd(64), 1 + rnd(1000), 1 + rnd(20)],
        count: (n) => n,
      },
    ],
    query:
      'SELECT region.zone AS zone, COUNT(*) AS orders, SUM(sales.amount) AS revenue, AVG(sales.amount) AS avg_amount\nFROM sales JOIN region ON sales.region_id = region.id\nGROUP BY region.zone\nORDER BY zone',
    defaultRows: 200000,
  },
  {
    id: 'two-join',
    label: 'Two-dimension snowflake',
    blurb:
      'A fact joined to two dimensions at once. Each extra join is another fused probe inside the same scan loop — the compiled pipeline grows by a few lines of generated code, not by another operator boundary the interpreter must cross per row.',
    tables: [
      {
        ddl: 'CREATE TABLE product (id INTEGER, category INTEGER)',
        name: 'product',
        gen: (i, rnd) => [i, rnd(8)],
        count: () => 200,
      },
      {
        ddl: 'CREATE TABLE region (id INTEGER, zone INTEGER)',
        name: 'region',
        gen: (i, rnd) => [i, rnd(5)],
        count: () => 64,
      },
      {
        ddl: 'CREATE TABLE sales (id INTEGER, region_id INTEGER, product_id INTEGER, amount INTEGER)',
        name: 'sales',
        gen: (i, rnd) => [i, rnd(64), rnd(200), 1 + rnd(1000)],
        count: (n) => n,
      },
    ],
    query:
      'SELECT region.zone AS zone, product.category AS category, COUNT(*) AS n, SUM(sales.amount) AS revenue, MAX(sales.amount) AS biggest\nFROM sales JOIN region ON sales.region_id = region.id JOIN product ON sales.product_id = product.id\nGROUP BY region.zone, product.category\nORDER BY zone, category',
    defaultRows: 200000,
  },
  {
    id: 'rollup',
    label: 'Hash-aggregate roll-up',
    blurb:
      'No join — a single scan rolled up into ~1 000 groups with seven aggregates at once. This isolates the aggregation engine: the interpreter dispatches through a list of generic accumulator objects per row; the compiler emits the COUNT/SUM/AVG/MIN/MAX updates as inlined local-field arithmetic, so each group state is a plain object the JIT keeps hot. The largest win in the suite.',
    tables: [
      {
        ddl: 'CREATE TABLE metrics (bucket INTEGER, a INTEGER, b INTEGER, c INTEGER)',
        name: 'metrics',
        gen: (i, rnd) => [i % 1000, rnd(500), rnd(5000), rnd(50000)],
        count: (n) => n,
      },
    ],
    query:
      'SELECT bucket, COUNT(*) AS n, SUM(a) AS sa, SUM(b) AS sb, AVG(c) AS avg_c, MIN(a) AS min_a, MAX(c) AS max_c\nFROM metrics\nGROUP BY bucket\nORDER BY bucket',
    defaultRows: 200000,
  },
]

export function scenarioById(id: string): BenchScenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]
}

/** Build a fresh engine, create the scenario tables and bulk-load rows straight
 *  into the heaps (bypassing the SQL path for speed). */
export function buildDataset(scenario: BenchScenario, n: number, seed = 0x51c0): Engine {
  const engine = new Engine(new Database())
  for (const t of scenario.tables) {
    engine.execute(t.ddl)
    const table = engine.db.getTable(t.name)
    const rnd = makeRng(seed ^ hashStr(t.name))
    const rows = t.count(n)
    for (let i = 0; i < rows; i++) table.insertRawRow(t.gen(i, rnd))
  }
  return engine
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h >>> 0
}

/** A stable multiset signature of a result, independent of row order. */
export function rowsSignature(rows: Row[]): string {
  return rows
    .map((r) => r.map(formatValue).join(''))
    .sort()
    .join('')
}

function firstSelect(sql: string): SelectStmt {
  const s = parse(sql).find((x: Statement) => x.kind === 'select')
  if (!s) throw new Error('benchmark query is not a SELECT')
  return s as SelectStmt
}

function bestOf(times: number, fn: () => number): number {
  let best = Infinity
  for (let t = 0; t < times; t++) best = Math.min(best, fn())
  return best
}

export interface BenchResult {
  scenarioId: string
  inputRows: number
  outputRows: number
  /** Volcano interpreter execution time (best-of-N). */
  volcanoMs: number
  /** Compiled function execution time (best-of-N), excluding codegen. */
  compiledMs: number
  /** One-time cost to generate + JIT the source. */
  compileMs: number
  speedup: number
  /** True when both engines produced the identical result multiset. */
  identical: boolean
  /** The generated source + the human-readable fused pipeline. */
  source: string
  pipeline: string[]
  columnNames: string[]
  /** A small preview of the (shared) result, for the Lab. */
  preview: Row[]
}

const REPEATS = 3

export function runBenchmark(scenarioId: string, n: number): BenchResult {
  const scenario = scenarioById(scenarioId)
  const engine = buildDataset(scenario, n)
  const stmt = firstSelect(scenario.query)

  const prep = prepareCompiled(stmt, engine.db)
  if ('reason' in prep) {
    throw new Error(`scenario "${scenarioId}" is not compilable: ${prep.reason}`)
  }
  const compiled: CompiledQuery = prep.prepared

  // Materialize the heaps once — the one-time "load" a real store pays at
  // ingest, kept out of the per-run exec timing (the Vectorize Lab amortizes its
  // columnar transpose the same way).
  const rels = compiled.gather(engine.db)

  // Correctness gate: identical multiset. Both paths skip parsing (they share
  // `stmt`) so the timing compares execution, not the lexer/parser.
  const volcanoRows = engine.queryRows(stmt).rows
  const compiledRun = compiled.exec(rels)
  const identical = rowsSignature(volcanoRows) === rowsSignature(compiledRun.rows)

  // Timing — best-of-N to suppress GC / scheduler noise.
  const volcanoMs = bestOf(REPEATS, () => {
    const t = performance.now()
    engine.queryRows(stmt)
    return performance.now() - t
  })
  const compiledMs = bestOf(REPEATS, () => {
    const t = performance.now()
    compiled.exec(rels)
    return performance.now() - t
  })

  const inputRows = compiledRun.inputRows
  const preview = volcanoRows.slice(0, 12)

  return {
    scenarioId,
    inputRows,
    outputRows: compiledRun.outputRows,
    volcanoMs,
    compiledMs,
    compileMs: compiled.compileMs,
    speedup: compiledMs > 0 ? volcanoMs / compiledMs : 0,
    identical,
    source: compiled.source,
    pipeline: compiled.pipeline,
    columnNames: compiled.columnNames,
    preview,
  }
}
