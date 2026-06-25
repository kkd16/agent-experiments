// Differential self-tests for the query compiler. Each case runs a query
// through BOTH the Volcano interpreter (`engine.queryRows`) and the compiled
// function over a small dataset and asserts the result multisets are identical.
// This is the contract that lets the Lab claim equivalence: if the codegen ever
// drifts from `eval.ts` / `aggregate.ts` semantics, one of these turns red.

import { Engine } from '../engine'
import { Database } from '../catalog'
import type { Row } from '../catalog'
import type { SelectStmt, Statement } from '../ast'
import { parse } from '../parser'
import { formatValue } from '../types'
import { prepareCompiled } from './compile'

export interface CompiledCase {
  group: string
  name: string
  run: () => void
}

const cases: CompiledCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'compiler', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

function sig(rows: Row[]): string {
  return rows
    .map((r) => r.map(formatValue).join(''))
    .sort()
    .join('')
}

function firstSelect(sql: string): SelectStmt {
  const s = parse(sql).find((x: Statement) => x.kind === 'select')
  if (!s) throw new Error('not a select')
  return s as SelectStmt
}

/** Run `sql` through both engines over `engine` and assert identical results. */
function diff(engine: Engine, sql: string) {
  const stmt = firstSelect(sql)
  const prep = prepareCompiled(stmt, engine.db)
  if ('reason' in prep) throw new Error(`expected compilable, got fallback: ${prep.reason}`)
  const volcano = engine.queryRows(stmt).rows
  const compiled = prep.prepared.run(engine.db)
  assert(
    sig(volcano) === sig(compiled.rows),
    `mismatch for ${sql}\n  volcano:  ${sig(volcano).slice(0, 200)}\n  compiled: ${sig(compiled.rows).slice(0, 200)}`,
  )
  // The generated source must be non-trivial JS (the artifact claim).
  assert(compiled.rows !== undefined && prep.prepared.source.includes('return out;'), 'generated source present')
}

/** Assert a statement is rejected (falls back to Volcano) for a stated reason. */
function expectFallback(engine: Engine, sql: string) {
  const stmt = firstSelect(sql)
  const prep = prepareCompiled(stmt, engine.db)
  assert('reason' in prep, `expected fallback for ${sql}, but it compiled`)
}

// --- a small fixture: a star schema with NULLs and mixed types --------------

function fixture(): Engine {
  const e = new Engine(new Database())
  e.execute('CREATE TABLE region (id INTEGER, name TEXT, zone INTEGER)')
  e.execute('CREATE TABLE product (id INTEGER, label TEXT, category INTEGER)')
  e.execute('CREATE TABLE sales (id INTEGER, region_id INTEGER, product_id INTEGER, amount INTEGER, qty REAL, note TEXT)')
  e.execute("INSERT INTO region VALUES (1,'North',10),(2,'South',10),(3,'East',20),(4,'West',NULL)")
  e.execute("INSERT INTO product VALUES (1,'Widget',100),(2,'Gadget',100),(3,'Gizmo',200)")
  const sales: [number, number | null, number, number | null, number, string | null][] = [
    [1, 1, 1, 100, 1.5, 'a'],
    [2, 1, 2, 250, 2.0, 'b'],
    [3, 2, 1, 75, 3.5, null],
    [4, 2, 3, 500, 1.0, 'c'],
    [5, 3, 2, 320, 4.0, 'a'],
    [6, 3, 3, 90, 2.5, 'b'],
    [7, 4, 1, 60, 1.0, null],
    [8, 1, 3, 410, 3.0, 'c'],
    [9, null, 2, 30, 1.0, 'd'], // region_id NULL → must NOT join
    [10, 2, 2, null, 2.0, 'e'], // amount NULL → SUM/AVG skip, COUNT(*) counts
  ]
  for (const r of sales) {
    e.execute(
      `INSERT INTO sales VALUES (${r[0]}, ${r[1] ?? 'NULL'}, ${r[2]}, ${r[3] ?? 'NULL'}, ${r[4]}, ${r[5] === null ? 'NULL' : `'${r[5]}'`})`,
    )
  }
  return e
}

// --- projection / filter ----------------------------------------------------

test('projection: select *', () => diff(fixture(), 'SELECT * FROM sales'))
test('projection: column list', () => diff(fixture(), 'SELECT id, amount, note FROM sales'))
test('projection: scalar expressions', () =>
  diff(fixture(), "SELECT id, amount * qty AS total, upper(note) AS NOTE, amount IS NULL AS missing FROM sales"))
test('projection: CASE + coalesce', () =>
  diff(fixture(), "SELECT id, CASE WHEN amount > 200 THEN 'big' WHEN amount IS NULL THEN 'na' ELSE 'small' END AS bucket FROM sales"))
test('filter: conjunctive numeric', () => diff(fixture(), 'SELECT id, amount FROM sales WHERE amount > 80 AND qty < 3'))
test('filter: three-valued (NULL rejected)', () => diff(fixture(), 'SELECT id FROM sales WHERE amount > 100'))
test('filter: OR + modulo', () => diff(fixture(), 'SELECT id FROM sales WHERE amount % 2 = 0 OR note = \'a\''))
test('filter: text predicate', () => diff(fixture(), "SELECT id, note FROM sales WHERE note LIKE 'a%'"))
test('order by + limit + offset', () => diff(fixture(), 'SELECT id, amount FROM sales ORDER BY amount DESC LIMIT 4 OFFSET 1'))
test('order by expression / alias', () => diff(fixture(), 'SELECT id, amount * 2 AS dbl FROM sales ORDER BY dbl DESC, id'))

// --- aggregates (no join) ---------------------------------------------------

test('agg: global count/sum/avg/min/max', () =>
  diff(fixture(), 'SELECT COUNT(*) AS c, COUNT(amount) AS ca, SUM(amount) AS s, AVG(amount) AS a, MIN(amount) AS mn, MAX(amount) AS mx FROM sales'))
test('agg: empty input → one row', () => {
  const e = fixture()
  diff(e, 'SELECT COUNT(*) AS c, SUM(amount) AS s, AVG(amount) AS a, MIN(amount) AS mn FROM sales WHERE id < 0')
})
test('agg: group by single key', () =>
  diff(fixture(), 'SELECT product_id, COUNT(*) AS n, SUM(amount) AS rev, AVG(amount) AS av FROM sales GROUP BY product_id ORDER BY product_id'))
test('agg: group by key incl NULL bucket', () =>
  diff(fixture(), 'SELECT region_id, COUNT(*) AS n, SUM(amount) AS s FROM sales GROUP BY region_id ORDER BY region_id'))
test('agg: min/max over text', () =>
  diff(fixture(), 'SELECT product_id, MIN(note) AS lo, MAX(note) AS hi FROM sales GROUP BY product_id ORDER BY product_id'))
test('agg: sum over REAL', () =>
  diff(fixture(), 'SELECT region_id, SUM(qty) AS q, AVG(qty) AS aq FROM sales GROUP BY region_id ORDER BY region_id'))
test('agg: group by expression key', () =>
  diff(fixture(), 'SELECT amount % 100 AS bkt, COUNT(*) AS n FROM sales WHERE amount IS NOT NULL GROUP BY amount % 100 ORDER BY bkt'))

// --- joins ------------------------------------------------------------------

test('join: single equi-join projection', () =>
  diff(fixture(), 'SELECT sales.id AS sid, region.name AS rname FROM sales JOIN region ON sales.region_id = region.id ORDER BY sid'))
test('join: NULL key never matches', () =>
  diff(fixture(), 'SELECT COUNT(*) AS n FROM sales JOIN region ON sales.region_id = region.id'))
test('join: roll-up by dimension attr', () =>
  diff(fixture(), 'SELECT region.zone AS zone, COUNT(*) AS n, SUM(sales.amount) AS rev, AVG(sales.amount) AS av FROM sales JOIN region ON sales.region_id = region.id GROUP BY region.zone ORDER BY zone'))
test('join: two dimensions', () =>
  diff(
    fixture(),
    'SELECT region.zone AS z, product.category AS c, COUNT(*) AS n, SUM(sales.amount) AS rev, MAX(sales.amount) AS mx FROM sales JOIN region ON sales.region_id = region.id JOIN product ON sales.product_id = product.id GROUP BY region.zone, product.category ORDER BY z, c',
  ))
test('join: residual predicate in WHERE', () =>
  diff(fixture(), 'SELECT sales.id AS sid FROM sales JOIN region ON sales.region_id = region.id WHERE region.zone = 10 AND sales.amount > 100 ORDER BY sid'))
test('join: residual non-equi conjunct in ON', () =>
  diff(fixture(), 'SELECT sales.id AS sid FROM sales JOIN region ON sales.region_id = region.id AND sales.amount > 80 ORDER BY sid'))
test('join: qualified star', () =>
  diff(fixture(), 'SELECT region.* FROM sales JOIN region ON sales.region_id = region.id ORDER BY 1'))

// --- fallbacks (must NOT compile) -------------------------------------------

test('fallback: DISTINCT', () => expectFallback(fixture(), 'SELECT DISTINCT product_id FROM sales'))
test('fallback: HAVING', () =>
  expectFallback(fixture(), 'SELECT product_id, COUNT(*) FROM sales GROUP BY product_id HAVING COUNT(*) > 1'))
test('fallback: LEFT JOIN', () =>
  expectFallback(fixture(), 'SELECT sales.id FROM sales LEFT JOIN region ON sales.region_id = region.id'))
test('fallback: window function', () =>
  expectFallback(fixture(), 'SELECT id, SUM(amount) OVER (PARTITION BY region_id) FROM sales'))
test('fallback: subquery in WHERE', () =>
  expectFallback(fixture(), 'SELECT id FROM sales WHERE amount > (SELECT AVG(amount) FROM sales)'))
test('fallback: SUM over DECIMAL stays exact (declared)', () => {
  const e = new Engine(new Database())
  e.execute('CREATE TABLE money (id INTEGER, cents DECIMAL(12,2))')
  expectFallback(e, 'SELECT SUM(cents) FROM money')
})
test('fallback: STDDEV aggregate', () =>
  expectFallback(fixture(), 'SELECT STDDEV(amount) FROM sales'))
test('fallback: CTE', () =>
  expectFallback(fixture(), 'WITH t AS (SELECT * FROM sales) SELECT id FROM t'))
test('fallback: join with only a range ON predicate', () =>
  expectFallback(fixture(), 'SELECT sales.id FROM sales JOIN region ON sales.amount > region.zone'))

export const compiledCases: CompiledCase[] = cases
