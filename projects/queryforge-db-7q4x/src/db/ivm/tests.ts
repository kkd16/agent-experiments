// Self-tests for the incremental view-maintenance engine.
//
// Held to the suite's differential bar: the contents an incrementally-maintained
// materialized view *stores* must always equal a from-scratch recompute of the
// same query — the engine's own SELECT, an independent implementation. We assert
// that invariant after targeted edge cases (group-key moves, min/max retraction,
// FK cascades, rollback) and after **every** step of thousands of seeded random
// insert/update/delete sequences across five different view shapes (filter,
// group-by aggregate, join, join+group-by, and DISTINCT). If incremental
// maintenance ever diverged from a recompute by a single row, a seed would catch
// it and print a replayable counterexample.

import { Engine, type RowsResult } from '../engine'
import { Database, type Row } from '../catalog'
import { bagEqual, bagDiff } from './zset'
import { Rng } from '../fuzz/rng'

export interface IvmCase {
  group: string
  name: string
  run: () => void
}

const cases: IvmCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'ivm', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}
function throws(e: Engine, sql: string, frag?: string): void {
  try {
    e.execute(sql)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    if (frag && !m.includes(frag)) throw new Error(`threw, but message lacked "${frag}": ${m}`, { cause: err })
    return
  }
  throw new Error(`expected "${sql}" to throw`)
}

function fresh(ddl: string): Engine {
  const e = new Engine()
  e.execute(ddl)
  return e
}
function rowsOf(e: Engine, sql: string): Row[] {
  const results = e.execute(sql)
  const last = results[results.length - 1] as RowsResult | undefined
  return last && last.kind === 'rows' ? last.rows : []
}

/** The core IVM oracle: a view's stored contents == a fresh recompute. */
function matches(e: Engine, mv: string, query: string): boolean {
  const stored = rowsOf(e, `SELECT * FROM ${mv}`)
  const recomputed = rowsOf(e, query)
  return bagEqual(stored, recomputed)
}
function assertMatches(e: Engine, mv: string, query: string, label: string): void {
  const stored = rowsOf(e, `SELECT * FROM ${mv}`)
  const recomputed = rowsOf(e, query)
  assert(
    bagEqual(stored, recomputed),
    `${label}: materialized view diverged from recompute — ${JSON.stringify(bagDiff(stored, recomputed))} ` +
      `(stored ${stored.length}, recomputed ${recomputed.length})`,
  )
}

// ---------------------------------------------------------------------------
// Targeted cases
// ---------------------------------------------------------------------------

test('filter/project view stays exact through insert/update/delete', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT, v INTEGER)')
  e.execute("INSERT INTO t VALUES (1,'a',10),(2,'b',20),(3,'a',5)")
  e.execute('CREATE MATERIALIZED VIEW mv AS SELECT id, k, v FROM t WHERE v > 6')
  const q = 'SELECT id, k, v FROM t WHERE v > 6'
  assertMatches(e, 'mv', q, 'init')
  e.execute("INSERT INTO t VALUES (4,'c',100),(5,'a',1)")
  assertMatches(e, 'mv', q, 'after insert')
  e.execute('UPDATE t SET v = 7 WHERE id = 5') // crosses the predicate into the view
  assertMatches(e, 'mv', q, 'update into view')
  e.execute('UPDATE t SET v = 0 WHERE id = 1') // crosses out of the view
  assertMatches(e, 'mv', q, 'update out of view')
  e.execute('DELETE FROM t WHERE id = 4')
  assertMatches(e, 'mv', q, 'after delete')
})

test('SELECT * over a materialized view scans its stored contents', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)')
  e.execute('INSERT INTO t VALUES (1,5),(2,15),(3,25)')
  e.execute('CREATE MATERIALIZED VIEW mv AS SELECT id, v FROM t WHERE v >= 15')
  assert(rowsOf(e, 'SELECT COUNT(*) FROM mv')[0][0] === 2, 'view should hold 2 rows')
  // A query *on* the view composes like a table (here, an aggregate over it).
  const total = rowsOf(e, 'SELECT SUM(v) FROM mv')[0][0]
  assert(total === 40, `expected 40, got ${String(total)}`)
})

test('group-by COUNT/SUM/AVG/MIN/MAX maintained incrementally', () => {
  const e = fresh('CREATE TABLE s (id INTEGER PRIMARY KEY, dept TEXT, sal INTEGER)')
  e.execute("INSERT INTO s VALUES (1,'eng',100),(2,'eng',200),(3,'ops',50)")
  e.execute('CREATE MATERIALIZED VIEW g AS SELECT dept, COUNT(*), SUM(sal), AVG(sal), MIN(sal), MAX(sal) FROM s GROUP BY dept')
  const q = 'SELECT dept, COUNT(*), SUM(sal), AVG(sal), MIN(sal), MAX(sal) FROM s GROUP BY dept'
  assertMatches(e, 'g', q, 'init')
  e.execute("INSERT INTO s VALUES (4,'ops',75),(5,'hr',9)") // 'hr' is a brand-new group
  assertMatches(e, 'g', q, 'new group appears')
  e.execute('UPDATE s SET sal = 300 WHERE id = 1') // changes sum/avg/max of eng
  assertMatches(e, 'g', q, 'aggregate value changes')
  e.execute("UPDATE s SET dept = 'eng' WHERE id = 3") // moves a row between groups
  assertMatches(e, 'g', q, 'group-key move')
  e.execute('DELETE FROM s WHERE id = 5') // the 'hr' group empties and must vanish
  assertMatches(e, 'g', q, 'group vanishes')
})

test('MIN/MAX recover the next extreme when the current one is deleted', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, g TEXT, v INTEGER)')
  e.execute("INSERT INTO t VALUES (1,'a',5),(2,'a',9),(3,'a',1),(4,'a',7)")
  e.execute('CREATE MATERIALIZED VIEW m AS SELECT g, MIN(v), MAX(v) FROM t GROUP BY g')
  const q = 'SELECT g, MIN(v), MAX(v) FROM t GROUP BY g'
  assertMatches(e, 'm', q, 'init')
  e.execute('DELETE FROM t WHERE id = 3') // remove current MIN (1) → next MIN is 5
  assertMatches(e, 'm', q, 'min retracted')
  e.execute('DELETE FROM t WHERE id = 2') // remove current MAX (9) → next MAX is 7
  assertMatches(e, 'm', q, 'max retracted')
})

test('un-grouped aggregate yields one row even over an empty table', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)')
  e.execute('CREATE MATERIALIZED VIEW tot AS SELECT COUNT(*), SUM(v), MAX(v) FROM t')
  const q = 'SELECT COUNT(*), SUM(v), MAX(v) FROM t'
  assertMatches(e, 'tot', q, 'empty')
  assert(rowsOf(e, 'SELECT * FROM tot').length === 1, 'COUNT(*) over empty must still be one row')
  assert(rowsOf(e, 'SELECT * FROM tot')[0][0] === 0, 'COUNT(*) over empty must be 0')
  e.execute('INSERT INTO t VALUES (1,5),(2,7)')
  assertMatches(e, 'tot', q, 'filled')
  e.execute('DELETE FROM t')
  assertMatches(e, 'tot', q, 'emptied again')
  assert(rowsOf(e, 'SELECT * FROM tot')[0][1] === null, 'SUM over empty must be NULL')
})

test('two-table join view follows inserts on either side and FK key-moves', () => {
  const e = fresh('CREATE TABLE cust (cid INTEGER PRIMARY KEY, name TEXT)')
  e.execute('CREATE TABLE ord (oid INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER)')
  e.execute("INSERT INTO cust VALUES (1,'ann'),(2,'bob')")
  e.execute('INSERT INTO ord VALUES (10,1,5),(11,1,7),(12,2,3)')
  e.execute('CREATE MATERIALIZED VIEW j AS SELECT c.name, o.amt FROM cust c JOIN ord o ON o.cid = c.cid')
  const q = 'SELECT c.name, o.amt FROM cust c JOIN ord o ON o.cid = c.cid'
  assertMatches(e, 'j', q, 'init')
  e.execute("INSERT INTO cust VALUES (3,'cat')")
  e.execute('INSERT INTO ord VALUES (13,3,9),(14,1,1)')
  assertMatches(e, 'j', q, 'inserts on both sides')
  e.execute('UPDATE ord SET cid = 2 WHERE oid = 10') // re-points an order to a new parent
  assertMatches(e, 'j', q, 'join key moved')
})

test('join + group-by maintained when a dimension row moves between groups', () => {
  const e = fresh('CREATE TABLE cust (cid INTEGER PRIMARY KEY, region TEXT)')
  e.execute('CREATE TABLE ord (oid INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER)')
  e.execute("INSERT INTO cust VALUES (1,'n'),(2,'s'),(3,'n')")
  e.execute('INSERT INTO ord VALUES (10,1,5),(11,2,7),(12,3,3),(13,1,4)')
  e.execute('CREATE MATERIALIZED VIEW jg AS SELECT c.region, COUNT(*), SUM(o.amt) FROM cust c JOIN ord o ON o.cid=c.cid GROUP BY c.region')
  const q = 'SELECT c.region, COUNT(*), SUM(o.amt) FROM cust c JOIN ord o ON o.cid=c.cid GROUP BY c.region'
  assertMatches(e, 'jg', q, 'init')
  e.execute("UPDATE cust SET region='s' WHERE cid=1") // two orders move n→s
  assertMatches(e, 'jg', q, 'dimension move re-buckets its fact rows')
})

test('DISTINCT view flips a value out only when its last copy leaves', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, c TEXT)')
  e.execute("INSERT INTO t VALUES (1,'x'),(2,'x'),(3,'y')")
  e.execute('CREATE MATERIALIZED VIEW d AS SELECT DISTINCT c FROM t')
  const q = 'SELECT DISTINCT c FROM t'
  assertMatches(e, 'd', q, 'init')
  e.execute('DELETE FROM t WHERE id=1') // one 'x' remains — 'x' must stay
  assertMatches(e, 'd', q, 'one copy remains')
  assert(matches(e, 'd', q) && rowsOf(e, 'SELECT * FROM d').length === 2, "'x' must still be present")
  e.execute('DELETE FROM t WHERE id=2') // last 'x' gone — 'x' must disappear
  assertMatches(e, 'd', q, 'last copy leaves')
})

test('ON DELETE CASCADE maintains views on both the parent and child', () => {
  const e = fresh('CREATE TABLE p (id INTEGER PRIMARY KEY)')
  e.execute('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE CASCADE, amt INTEGER)')
  e.execute('INSERT INTO p VALUES (1),(2)')
  e.execute('INSERT INTO c VALUES (10,1,5),(11,1,6),(12,2,7)')
  e.execute('CREATE MATERIALIZED VIEW cv AS SELECT p.id, SUM(c.amt) FROM p JOIN c ON c.pid=p.id GROUP BY p.id')
  const q = 'SELECT p.id, SUM(c.amt) FROM p JOIN c ON c.pid=p.id GROUP BY p.id'
  assertMatches(e, 'cv', q, 'init')
  e.execute('DELETE FROM p WHERE id=1') // a single statement deletes p(1) and cascades to c(10),c(11)
  assertMatches(e, 'cv', q, 'after cascading delete')
})

test('a transaction ROLLBACK restores the materialized view exactly', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)')
  e.execute('INSERT INTO t VALUES (1,1),(2,2)')
  e.execute('CREATE MATERIALIZED VIEW mv AS SELECT id, v FROM t WHERE v > 0')
  const q = 'SELECT id, v FROM t WHERE v > 0'
  e.execute('BEGIN')
  e.execute('INSERT INTO t VALUES (3,3)')
  e.execute('DELETE FROM t WHERE id=1')
  assertMatches(e, 'mv', q, 'mid-transaction')
  e.execute('ROLLBACK')
  assertMatches(e, 'mv', q, 'after rollback')
  assert(rowsOf(e, 'SELECT COUNT(*) FROM mv')[0][0] === 2, 'rollback should restore the 2 original rows')
})

test('a snapshot round-trip rebuilds the view from its definition', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, g TEXT, v INTEGER)')
  e.execute("INSERT INTO t VALUES (1,'a',5),(2,'a',7),(3,'b',2)")
  e.execute('CREATE MATERIALIZED VIEW m AS SELECT g, COUNT(*), SUM(v) FROM t GROUP BY g')
  const snap = JSON.parse(JSON.stringify(e.db.snapshot()))
  // Reconstruct a fresh engine from the serialized snapshot.
  const restored = new Engine(Database.restore(snap))
  assertMatches(restored, 'm', 'SELECT g, COUNT(*), SUM(v) FROM t GROUP BY g', 'restored view')
  // And it keeps maintaining incrementally after restore.
  restored.execute("INSERT INTO t VALUES (4,'b',10)")
  assertMatches(restored, 'm', 'SELECT g, COUNT(*), SUM(v) FROM t GROUP BY g', 'restored view stays live')
})

test('a table read by a materialized view cannot be dropped', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)')
  e.execute('CREATE MATERIALIZED VIEW mv AS SELECT id FROM t WHERE v > 0')
  throws(e, 'DROP TABLE t', 'MATERIALIZED VIEW')
  e.execute('DROP MATERIALIZED VIEW mv')
  e.execute('DROP TABLE t') // now it drops cleanly
})

test('non-maintainable queries are rejected with a clear reason', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)')
  e.execute('CREATE TABLE u (id INTEGER PRIMARY KEY, v INTEGER)')
  throws(e, 'CREATE MATERIALIZED VIEW a AS SELECT id FROM t ORDER BY v LIMIT 3', 'LIMIT')
  throws(e, 'CREATE MATERIALIZED VIEW b AS SELECT v FROM t UNION SELECT v FROM u', 'set operation')
  throws(e, 'CREATE MATERIALIZED VIEW c AS SELECT t1.id FROM t t1 JOIN t t2 ON t1.id=t2.id', 'more than once')
  throws(e, 'CREATE MATERIALIZED VIEW d AS SELECT id FROM t LEFT JOIN u ON t.id=u.id', 'LEFT JOIN')
  // SUM/AVG over a non-integer column is rejected (would risk float-order drift).
  e.execute('CREATE TABLE r (id INTEGER PRIMARY KEY, x REAL)')
  throws(e, 'CREATE MATERIALIZED VIEW f AS SELECT SUM(x) FROM r', 'INTEGER')
})

// ---------------------------------------------------------------------------
// Differential fuzz — incremental maintenance == recompute, after every step
// ---------------------------------------------------------------------------

const FUZZ_VIEWS: { name: string; def: string }[] = [
  { name: 'fz_filter', def: 'SELECT id, cid, amt FROM ord WHERE amt > 10' },
  { name: 'fz_grp', def: 'SELECT cid, COUNT(*), SUM(amt), MIN(amt), MAX(amt) FROM ord GROUP BY cid' },
  { name: 'fz_join', def: 'SELECT c.region, o.amt FROM cust c JOIN ord o ON o.cid=c.cid WHERE o.amt < 50' },
  { name: 'fz_joingrp', def: 'SELECT c.region, COUNT(*), SUM(o.amt), MAX(o.amt) FROM cust c JOIN ord o ON o.cid=c.cid GROUP BY c.region' },
  { name: 'fz_dist', def: 'SELECT DISTINCT cid FROM ord' },
]

function fuzzSeed(seed: number, steps: number): void {
  const rng = new Rng(seed)
  const regions = ['n', 's', 'e', 'w']
  const e = new Engine()
  e.execute('CREATE TABLE cust (cid INTEGER PRIMARY KEY, region TEXT)')
  e.execute('CREATE TABLE ord (id INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER)')
  for (let c = 1; c <= 4; c++) e.execute(`INSERT INTO cust VALUES (${c}, '${rng.pick(regions)}')`)
  for (const v of FUZZ_VIEWS) e.execute(`CREATE MATERIALIZED VIEW ${v.name} AS ${v.def}`)
  let nextId = 1
  const live: number[] = []
  for (let step = 0; step < steps; step++) {
    const op = live.length === 0 ? 0 : rng.int(0, 2)
    if (op === 0) {
      const id = nextId++
      e.execute(`INSERT INTO ord VALUES (${id}, ${rng.int(1, 4)}, ${rng.int(0, 80)})`)
      live.push(id)
    } else if (op === 1) {
      const id = rng.pick(live)
      e.execute(`UPDATE ord SET amt = ${rng.int(0, 80)}, cid = ${rng.int(1, 4)} WHERE id = ${id}`)
    } else {
      const idx = rng.int(0, live.length - 1)
      const id = live[idx]
      live.splice(idx, 1)
      e.execute(`DELETE FROM ord WHERE id = ${id}`)
    }
    for (const v of FUZZ_VIEWS) {
      assertMatches(e, v.name, v.def, `fuzz seed=${seed} step=${step} view=${v.name}`)
    }
  }
}

// A handful of fixed seeds, each re-checking all five views after every one of
// 40 random mutations (≈200 differential comparisons per seed).
for (const seed of [1, 7, 42, 101, 256, 1009]) {
  test(`differential fuzz — seed ${seed} (5 views × 40 random mutations)`, () => fuzzSeed(seed, 40))
}

export const ivmCases = cases
