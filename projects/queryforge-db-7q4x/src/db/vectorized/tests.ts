// Differential self-tests for the vectorized engine. Each case runs a query
// through BOTH engines (Volcano via `engine.execute`, and the vectorized engine)
// over a small dataset and asserts the result multisets are identical. This is
// the contract that lets the Lab claim equivalence: if a kernel ever drifts from
// `eval.ts`/`aggregate.ts` semantics, one of these turns red.

import { Engine } from '../engine'
import { Database } from '../catalog'
import type { Row } from '../catalog'
import type { SelectStmt, Statement } from '../ast'
import { parse } from '../parser'
import { formatValue } from '../types'
import { prepareVectorized } from './engine'

export interface VecCase {
  group: string
  name: string
  run: () => void
}

const cases: VecCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'vectorized', name, run })
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

/** Build a small engine with a `t` table from inline rows. `cols` is the DDL
 *  column list (e.g. 'a INTEGER, b INTEGER, label TEXT'). */
function engineWith(colsDdl: string, rows: Row[]): Engine {
  const e = new Engine(new Database())
  e.execute(`CREATE TABLE t (${colsDdl})`)
  const table = e.db.getTable('t')
  for (const r of rows) table.insertRawRow(r)
  return e
}

/** Assert the vectorized engine is SUPPORTED for the query and matches Volcano. */
function assertEquiv(engine: Engine, query: string) {
  const stmt = firstSelect(query)
  const prep = prepareVectorized(stmt, engine.db)
  assert(!('reason' in prep), `expected vectorized support but got: ${'reason' in prep ? prep.reason : ''}`)
  if ('reason' in prep) return
  const vec = prep.prepared.run(engine.db)
  const vol = engine.execute(query)[0]
  assert(vol.kind === 'rows', 'volcano produced rows')
  if (vol.kind !== 'rows') return
  assert(vec.outputRows === vol.rows.length, `row count ${vec.outputRows} vs ${vol.rows.length} for: ${query}`)
  assert(sig(vec.rows) === sig(vol.rows), `multiset mismatch for: ${query}`)
}

/** Assert the analyzer correctly DECLINES a query (falls back to Volcano). */
function assertUnsupported(engine: Engine, query: string) {
  const prep = prepareVectorized(firstSelect(query), engine.db)
  assert('reason' in prep, `expected the analyzer to decline: ${query}`)
}

// --- a reusable mixed dataset (ints, a real-ish column via division, nulls) ---
function sampleEngine(): Engine {
  const rows: Row[] = []
  for (let i = 0; i < 240; i++) {
    const g = i % 7
    const v = i % 5 === 0 ? null : (i * 37) % 200
    const w = (i * 13) % 1000
    rows.push([g, v, w, `row${i % 11}`])
  }
  // a couple of all-null-in-group edge rows
  rows.push([99, null, 5, 'edge'])
  rows.push([99, null, 7, 'edge'])
  return engineWith('g INTEGER, v INTEGER, w INTEGER, label TEXT', rows)
}

test('group-by COUNT/SUM/AVG/MIN/MAX matches Volcano', () => {
  assertEquiv(sampleEngine(), 'SELECT g, COUNT(*), COUNT(v), SUM(v), AVG(v), MIN(v), MAX(v) FROM t GROUP BY g')
})

test('all-NULL group ⇒ SUM/AVG/MIN/MAX NULL, COUNT(*) counts rows', () => {
  // group 99 has only NULL v.
  assertEquiv(sampleEngine(), 'SELECT g, COUNT(*), COUNT(v), SUM(v), AVG(v), MIN(v) FROM t GROUP BY g')
})

test('ungrouped aggregate over the whole relation', () => {
  assertEquiv(sampleEngine(), 'SELECT COUNT(*), SUM(v), AVG(v), MIN(w), MAX(w) FROM t')
})

test('ungrouped aggregate over an empty table ⇒ one row', () => {
  const e = engineWith('a INTEGER, b INTEGER', [])
  assertEquiv(e, 'SELECT COUNT(*), SUM(a), AVG(b), MIN(a), MAX(b) FROM t')
})

test('GROUP BY over an empty table ⇒ zero rows', () => {
  const e = engineWith('a INTEGER, b INTEGER', [])
  assertEquiv(e, 'SELECT a, COUNT(*) FROM t GROUP BY a')
})

test('WHERE with conjunction + comparison', () => {
  assertEquiv(sampleEngine(), 'SELECT g, SUM(w) FROM t WHERE w > 200 AND g < 5 GROUP BY g')
})

test('WHERE with OR, NOT and IS NULL three-valued logic', () => {
  assertEquiv(sampleEngine(), 'SELECT g, COUNT(*) FROM t WHERE v IS NULL OR NOT (w < 500) GROUP BY g')
})

test('BETWEEN and NOT BETWEEN', () => {
  assertEquiv(sampleEngine(), 'SELECT COUNT(*) FROM t WHERE w BETWEEN 100 AND 300')
  assertEquiv(sampleEngine(), 'SELECT COUNT(*) FROM t WHERE w NOT BETWEEN 100 AND 300')
})

test('IN and NOT IN with NULL semantics', () => {
  assertEquiv(sampleEngine(), 'SELECT COUNT(*) FROM t WHERE g IN (1, 3, 5)')
  assertEquiv(sampleEngine(), 'SELECT g, COUNT(*) FROM t WHERE v NOT IN (37, 74) GROUP BY g')
})

test('arithmetic in predicate (modulo, divide-by-zero → NULL)', () => {
  assertEquiv(sampleEngine(), 'SELECT COUNT(*) FROM t WHERE w % 7 = 0')
  // divide by (g-g) is always /0 → NULL → row excluded; both engines agree.
  assertEquiv(sampleEngine(), 'SELECT COUNT(*) FROM t WHERE w / (g - g) > 0')
})

test('multi-column GROUP BY', () => {
  const rows: Row[] = []
  for (let i = 0; i < 300; i++) rows.push([i % 4, i % 3, (i * 17) % 90])
  const e = engineWith('a INTEGER, b INTEGER, m INTEGER', rows)
  assertEquiv(e, 'SELECT a, b, COUNT(*), SUM(m), MAX(m) FROM t GROUP BY a, b')
})

test('projection of mixed columns with ORDER BY … LIMIT', () => {
  assertEquiv(sampleEngine(), 'SELECT g, w, label FROM t WHERE w > 100 ORDER BY w LIMIT 20')
})

test('projection with a computed numeric column', () => {
  assertEquiv(sampleEngine(), 'SELECT g, w * 2 + 1 AS w2 FROM t WHERE g = 3 ORDER BY w2')
})

test('SELECT * projection path', () => {
  assertEquiv(sampleEngine(), 'SELECT * FROM t WHERE g = 2 ORDER BY w LIMIT 5')
})

test('GROUP BY with ORDER BY on an aggregate alias + LIMIT', () => {
  assertEquiv(sampleEngine(), 'SELECT g, SUM(w) AS total FROM t GROUP BY g ORDER BY total DESC LIMIT 3')
})

test('boolean GROUP BY is declined (stays correct via Volcano)', () => {
  const rows: Row[] = []
  for (let i = 0; i < 200; i++) rows.push([i, i % 3 === 0, i % 250])
  const e = engineWith('id INTEGER, flag BOOLEAN, v INTEGER', rows)
  // A boolean key must render TRUE/FALSE, so the analyzer declines it.
  assertUnsupported(e, 'SELECT flag, COUNT(*), SUM(v) FROM t GROUP BY flag')
  // But an INTEGER projection alongside is fine.
  assertEquiv(e, 'SELECT id, v FROM t WHERE v > 100 ORDER BY id LIMIT 10')
})

test('analyzer declines unsupported queries (falls back to Volcano)', () => {
  const e = sampleEngine()
  assertUnsupported(e, 'SELECT DISTINCT g FROM t')
  assertUnsupported(e, 'SELECT label, COUNT(*) FROM t GROUP BY label') // non-numeric key
  assertUnsupported(e, 'SELECT g, COUNT(DISTINCT v) FROM t GROUP BY g') // distinct agg
  assertUnsupported(e, 'SELECT g FROM t a JOIN t b ON a.g = b.g') // join
  assertUnsupported(e, 'SELECT g, STRING_AGG(label, \',\') FROM t GROUP BY g') // unsupported agg
})

export const vectorizedCases = cases
