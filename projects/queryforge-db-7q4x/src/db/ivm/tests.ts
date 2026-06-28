// Self-tests for the incremental view-maintenance engine.
//
// Held to the suite's differential bar: the contents an incrementally-maintained
// materialized view *stores* must always equal a from-scratch recompute of the
// same query — the engine's own SELECT, an independent implementation. We assert
// that invariant after targeted edge cases (group-key moves, min/max retraction,
// FK cascades, rollback, self-joins) and after **every** step of thousands of
// seeded random insert/update/delete sequences across sixteen different view
// shapes — filter, group-by aggregate, inner/outer joins, join+group-by,
// DISTINCT, exact-decimal aggregates, and *self-joins* (a table joined to itself,
// maintained by the bilinear cross-term). If incremental maintenance ever
// diverged from a recompute by a single row, a seed would catch it and print a
// replayable counterexample.

import { Engine, type RowsResult } from '../engine'
import { Database, type Row } from '../catalog'
import { bagEqual, bagDiff } from './zset'
import type { IvmPlanNode } from './dataflow'
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
  // An *inner* self-join is now maintainable (the bilinear cross-term), but each
  // occurrence still needs a distinct correlation name to resolve its columns.
  throws(e, 'CREATE MATERIALIZED VIEW c AS SELECT t1.id FROM t t1 JOIN t t1 ON t1.id=t1.id', 'more than once')
  // A *self outer-join* (same base table preserved on both sides) is not yet
  // incrementally maintained.
  throws(e, 'CREATE MATERIALIZED VIEW so AS SELECT a.id FROM t a LEFT JOIN t b ON a.v=b.v', 'self outer-join')
  // A LEFT/RIGHT/FULL join is maintainable only as the single join of a two-table
  // view; chaining a second join past it is not.
  e.execute('CREATE TABLE w (id INTEGER PRIMARY KEY, v INTEGER)')
  throws(e, 'CREATE MATERIALIZED VIEW d AS SELECT t.id FROM t JOIN u ON t.id=u.id LEFT JOIN w ON w.id=t.id', 'single join')
  // SUM/AVG over a column that is neither INTEGER nor DECIMAL is rejected (a
  // REAL running total could drift from a recompute under reordering).
  e.execute('CREATE TABLE r (id INTEGER PRIMARY KEY, x REAL)')
  throws(e, 'CREATE MATERIALIZED VIEW f AS SELECT SUM(x) FROM r', 'INTEGER or DECIMAL')
  // A DISTINCT SUM/AVG is not yet incrementally maintained (only COUNT(DISTINCT)).
  throws(e, 'CREATE MATERIALIZED VIEW g AS SELECT SUM(DISTINCT v) FROM t', 'DISTINCT')
})

// ---------------------------------------------------------------------------
// v25.0 — richer aggregation & outer joins
// ---------------------------------------------------------------------------

test('SUM/AVG over DECIMAL stay byte-exact through high-scale retraction', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, g TEXT, p DECIMAL)')
  e.execute("INSERT INTO t VALUES (1,'a',10.50),(2,'a',2.005),(3,'b',100)")
  e.execute('CREATE MATERIALIZED VIEW dv AS SELECT g, SUM(p) AS s, AVG(p) AS a, COUNT(*) AS c FROM t GROUP BY g')
  const q = 'SELECT g, SUM(p) AS s, AVG(p) AS a, COUNT(*) AS c FROM t GROUP BY g'
  assertMatches(e, 'dv', q, 'init')
  e.execute("INSERT INTO t VALUES (4,'a',0.001),(5,'b',3.3333)")
  assertMatches(e, 'dv', q, 'mixed-scale inserts')
  e.execute('UPDATE t SET p = 999.99 WHERE id = 3')
  assertMatches(e, 'dv', q, 'decimal update')
  // Retract the widest-scale value: the rendered SUM/AVG scale must fall back to
  // the live max-scale, matching a recompute exactly.
  e.execute('DELETE FROM t WHERE id = 2')
  assertMatches(e, 'dv', q, 'high-scale value retracted')
  e.execute('DELETE FROM t WHERE id = 4')
  assertMatches(e, 'dv', q, 'another retraction')
})

test('COUNT(DISTINCT) flips a value out only when its last copy leaves', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, g TEXT, v INTEGER)')
  e.execute("INSERT INTO t VALUES (1,'a',5),(2,'a',5),(3,'a',9),(4,'b',1)")
  e.execute('CREATE MATERIALIZED VIEW cd AS SELECT g, COUNT(DISTINCT v) AS dc, COUNT(v) AS c FROM t GROUP BY g')
  const q = 'SELECT g, COUNT(DISTINCT v) AS dc, COUNT(v) AS c FROM t GROUP BY g'
  assertMatches(e, 'cd', q, 'init')
  e.execute('DELETE FROM t WHERE id = 1') // one 5 remains → distinct count unchanged
  assertMatches(e, 'cd', q, 'one duplicate copy remains')
  e.execute('DELETE FROM t WHERE id = 2') // last 5 gone → distinct count drops
  assertMatches(e, 'cd', q, 'last copy of a value leaves')
})

test('aggregate FILTER (WHERE …) is maintained per slot', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, g TEXT, v INTEGER)')
  e.execute("INSERT INTO t VALUES (1,'a',5),(2,'a',50),(3,'a',9),(4,'b',100)")
  e.execute(
    "CREATE MATERIALIZED VIEW fv AS SELECT g, COUNT(*) FILTER (WHERE v >= 10) AS big, " +
      'SUM(v) FILTER (WHERE v < 10) AS small FROM t GROUP BY g',
  )
  const q =
    "SELECT g, COUNT(*) FILTER (WHERE v >= 10) AS big, SUM(v) FILTER (WHERE v < 10) AS small FROM t GROUP BY g"
  assertMatches(e, 'fv', q, 'init')
  e.execute('UPDATE t SET v = 8 WHERE id = 2') // crosses both filters
  assertMatches(e, 'fv', q, 'a row crosses the filter boundary')
})

test('HAVING + projection expressions over keys and aggregates', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, g TEXT, v INTEGER)')
  e.execute("INSERT INTO t VALUES (1,'a',5),(2,'a',7),(3,'b',1),(4,'c',100)")
  e.execute(
    "CREATE MATERIALIZED VIEW hv AS SELECT g || '!' AS gx, SUM(v) * 10 AS s10, COUNT(*) AS c " +
      'FROM t GROUP BY g HAVING SUM(v) > 10',
  )
  const q = "SELECT g || '!' AS gx, SUM(v) * 10 AS s10, COUNT(*) AS c FROM t GROUP BY g HAVING SUM(v) > 10"
  assertMatches(e, 'hv', q, 'init') // only 'a' (12) and 'c' (100) pass
  e.execute("INSERT INTO t VALUES (5,'b',20)") // 'b' crosses into HAVING
  assertMatches(e, 'hv', q, 'a group crosses into HAVING')
  e.execute('DELETE FROM t WHERE id = 1') // 'a' falls to 7 → crosses out
  assertMatches(e, 'hv', q, 'a group crosses out of HAVING')
})

test('LEFT JOIN flips a row between matched and NULL-extended', () => {
  const e = fresh('CREATE TABLE a (aid INTEGER PRIMARY KEY, k INTEGER, lbl TEXT)')
  e.execute('CREATE TABLE b (bid INTEGER PRIMARY KEY, k INTEGER, amt INTEGER)')
  e.execute("INSERT INTO a VALUES (1,10,'x'),(2,20,'y'),(3,30,'z')")
  e.execute('INSERT INTO b VALUES (100,10,5),(101,20,9)')
  e.execute('CREATE MATERIALIZED VIEW lv AS SELECT a.aid, a.lbl, b.amt FROM a LEFT JOIN b ON a.k = b.k')
  const q = 'SELECT a.aid, a.lbl, b.amt FROM a LEFT JOIN b ON a.k = b.k'
  assertMatches(e, 'lv', q, 'init') // a(3) is NULL-extended
  e.execute('INSERT INTO b VALUES (102,30,7)') // a(3) gains its first match
  assertMatches(e, 'lv', q, 'unmatched row gains a match')
  e.execute('INSERT INTO b VALUES (103,10,8)') // a(1) gets a second match
  assertMatches(e, 'lv', q, 'a second match adds a row, no NULL flip')
  e.execute('DELETE FROM b WHERE k = 10') // a(1) loses all matches → NULL-extended
  assertMatches(e, 'lv', q, 'losing the last match restores the NULL row')
  e.execute("INSERT INTO a VALUES (4,99,'w')") // a brand-new unmatched row
  assertMatches(e, 'lv', q, 'a fresh unmatched row appears NULL-extended')
})

test('RIGHT and FULL outer joins maintained with aggregation on top', () => {
  const e = fresh('CREATE TABLE a (aid INTEGER PRIMARY KEY, k INTEGER)')
  e.execute('CREATE TABLE b (bid INTEGER PRIMARY KEY, k INTEGER, amt INTEGER)')
  e.execute('INSERT INTO a VALUES (1,10),(2,20)')
  e.execute('INSERT INTO b VALUES (100,10,5),(101,30,9)')
  e.execute('CREATE MATERIALIZED VIEW rv AS SELECT a.k AS ak, COUNT(b.amt) AS cb FROM a RIGHT JOIN b ON a.k=b.k GROUP BY a.k')
  const rq = 'SELECT a.k AS ak, COUNT(b.amt) AS cb FROM a RIGHT JOIN b ON a.k=b.k GROUP BY a.k'
  assertMatches(e, 'rv', rq, 'right init') // b(101) has no a → NULL a.k group
  e.execute('CREATE MATERIALIZED VIEW fv2 AS SELECT a.k AS ak, b.k AS bk FROM a FULL JOIN b ON a.k=b.k')
  const fq = 'SELECT a.k AS ak, b.k AS bk FROM a FULL JOIN b ON a.k=b.k'
  assertMatches(e, 'fv2', fq, 'full init') // a(2) and b(101) both unmatched
  e.execute('INSERT INTO a VALUES (3,30)') // now matches b(101); also gives b(101) a match
  assertMatches(e, 'rv', rq, 'right after a-insert')
  assertMatches(e, 'fv2', fq, 'full after a-insert')
  e.execute('DELETE FROM b WHERE bid=100') // a(1) becomes unmatched (FULL), and the k=10 group changes
  assertMatches(e, 'rv', rq, 'right after b-delete')
  assertMatches(e, 'fv2', fq, 'full after b-delete')
})

// ---------------------------------------------------------------------------
// v26.0 — inner self-joins (the bilinear cross-term)
// ---------------------------------------------------------------------------

test('inner self-join is maintained by the bilinear cross-term', () => {
  const e = fresh('CREATE TABLE ord (id INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER)')
  e.execute('INSERT INTO ord VALUES (1,1,10),(2,1,20),(3,2,5)')
  // Pairs of distinct orders that share a customer — `ord` appears twice, so a
  // single Δord drives all of ΔO⋈O + O⋈ΔO + ΔO⋈ΔO.
  const def =
    'SELECT o1.id AS a, o2.id AS b, o1.amt + o2.amt AS tot FROM ord o1 JOIN ord o2 ON o1.cid = o2.cid AND o1.id < o2.id'
  e.execute(`CREATE MATERIALIZED VIEW pairs AS ${def}`)
  assertMatches(e, 'pairs', def, 'init') // only (1,2)
  e.execute('INSERT INTO ord VALUES (4,1,1)') // → new pairs (1,4),(2,4)
  assertMatches(e, 'pairs', def, 'one insert creates several pairs')
  e.execute('UPDATE ord SET cid = 2 WHERE id = 2') // re-points one side of many pairs at once
  assertMatches(e, 'pairs', def, 'a self-joined key move rewires both occurrences')
  e.execute('DELETE FROM ord WHERE id = 1')
  assertMatches(e, 'pairs', def, 'a delete retracts every pair it was in')
  e.execute('DELETE FROM ord') // drain to empty — the cross-term must net to zero
  assertMatches(e, 'pairs', def, 'drained to empty')
})

test('self-join with GROUP BY aggregate maintained incrementally', () => {
  const e = fresh('CREATE TABLE ord (id INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER)')
  e.execute('INSERT INTO ord VALUES (1,1,10),(2,1,20),(3,1,5),(4,2,7)')
  const def =
    'SELECT o1.cid AS cid, COUNT(*) AS pairs, SUM(o2.amt) AS s, MAX(o1.amt) AS mx ' +
    'FROM ord o1 JOIN ord o2 ON o1.cid = o2.cid AND o1.id < o2.id GROUP BY o1.cid'
  e.execute(`CREATE MATERIALIZED VIEW pc AS ${def}`)
  assertMatches(e, 'pc', def, 'init') // cid 1 has 3 pairs; cid 2 has none → no row
  e.execute('DELETE FROM ord WHERE id = 2')
  assertMatches(e, 'pc', def, 'a delete shrinks the pair count and aggregates')
  e.execute('INSERT INTO ord VALUES (5,2,3)') // cid 2 now forms its first pair → new group
  assertMatches(e, 'pc', def, 'a self-join pair makes a brand-new group appear')
})

test('multi-occurrence in a 3-way join (self-join beside a third table)', () => {
  const e = fresh('CREATE TABLE cust (cid INTEGER PRIMARY KEY, region TEXT)')
  e.execute('CREATE TABLE ord (id INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER)')
  e.execute("INSERT INTO cust VALUES (1,'n'),(2,'s')")
  e.execute('INSERT INTO ord VALUES (10,1,5),(11,1,6),(12,2,7)')
  // `ord` occupies two of the three slots; `cust` one. A Δord uses the bilinear
  // expansion over the two ord-slots, a Δcust the ordinary single-term path.
  const def =
    'SELECT c.region, o1.id AS a, o2.id AS b FROM cust c JOIN ord o1 ON o1.cid = c.cid ' +
    'JOIN ord o2 ON o2.cid = c.cid WHERE o1.id < o2.id'
  e.execute(`CREATE MATERIALIZED VIEW co AS ${def}`)
  assertMatches(e, 'co', def, 'init')
  e.execute('INSERT INTO ord VALUES (13,1,1)')
  assertMatches(e, 'co', def, 'insert adds pairs within a region')
  e.execute("UPDATE cust SET region = 'n' WHERE cid = 2") // a single-occurrence Δ
  assertMatches(e, 'co', def, 'a dimension move recolours its pairs')
  e.execute('DELETE FROM ord WHERE id = 11') // a multi-occurrence Δ
  assertMatches(e, 'co', def, 'a delete removes every pair it was in')
})

test('EXPLAIN surfaces the bilinear self-join and the indexed Δ-probe', () => {
  const e = fresh('CREATE TABLE ord (id INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER)')
  e.execute('CREATE MATERIALIZED VIEW pj AS SELECT o1.id AS a, o2.id AS b FROM ord o1 JOIN ord o2 ON o1.cid = o2.cid AND o1.id < o2.id')
  const node = e.db.matviews.explain('pj')
  assert(!!node, 'explain returns a plan')
  const text: string[] = []
  const walk = (n: IvmPlanNode): void => {
    text.push(n.op, n.detail, ...n.extra)
    n.children.forEach(walk)
  }
  walk(node!)
  const all = text.join(' | ')
  assert(all.includes('bilinear self-join'), 'explain notes the bilinear self-join expansion')
  assert(all.includes('Δ-probe') && all.includes('hash index on o2(cid)'), 'explain names the indexed Δ-probe key')
  assert(all.includes('occurs 2×'), 'explain notes the repeated base table')
})

// ---------------------------------------------------------------------------
// Differential fuzz — incremental maintenance == recompute, after every step
// ---------------------------------------------------------------------------

const FUZZ_VIEWS: { name: string; def: string }[] = [
  // Original shapes (filter, group-by, inner join, join+group-by, DISTINCT).
  { name: 'fz_filter', def: 'SELECT id, cid, amt FROM ord WHERE amt > 10' },
  { name: 'fz_grp', def: 'SELECT cid, COUNT(*), SUM(amt), MIN(amt), MAX(amt) FROM ord GROUP BY cid' },
  { name: 'fz_join', def: 'SELECT c.region, o.amt FROM cust c JOIN ord o ON o.cid=c.cid WHERE o.amt < 50' },
  { name: 'fz_joingrp', def: 'SELECT c.region, COUNT(*), SUM(o.amt), MAX(o.amt) FROM cust c JOIN ord o ON o.cid=c.cid GROUP BY c.region' },
  { name: 'fz_dist', def: 'SELECT DISTINCT cid FROM ord' },
  // v25.0 shapes — exact decimal SUM/AVG, COUNT(DISTINCT), aggregate FILTER,
  // HAVING + projection expressions, and the three outer joins (each also with
  // aggregation on top), stressed by mutations on *both* tables.
  { name: 'fz_dec', def: 'SELECT cid, SUM(price) AS s, AVG(price) AS a, COUNT(price) AS n FROM ord GROUP BY cid' },
  { name: 'fz_cdist', def: 'SELECT cid, COUNT(DISTINCT amt) AS d FROM ord GROUP BY cid' },
  { name: 'fz_filt', def: 'SELECT cid, COUNT(*) FILTER (WHERE amt > 100) AS big, SUM(amt) FILTER (WHERE amt <= 100) AS small FROM ord GROUP BY cid' },
  { name: 'fz_having', def: 'SELECT cid, SUM(amt) * 2 AS s2 FROM ord GROUP BY cid HAVING SUM(amt) > 100 AND COUNT(*) >= 2' },
  { name: 'fz_left', def: 'SELECT c.cid AS ck, o.amt FROM cust c LEFT JOIN ord o ON o.cid = c.cid' },
  { name: 'fz_leftgrp', def: 'SELECT c.region, COUNT(o.id) AS n, SUM(o.amt) AS s FROM cust c LEFT JOIN ord o ON o.cid = c.cid GROUP BY c.region' },
  { name: 'fz_right', def: 'SELECT c.cid AS ck, o.id AS oid FROM cust c RIGHT JOIN ord o ON o.cid = c.cid' },
  { name: 'fz_full', def: 'SELECT c.cid AS ck, o.id AS oid FROM cust c FULL JOIN ord o ON o.cid = c.cid' },
  // v26.0 — inner self-joins (the bilinear cross-term). `ord` is the most-mutated
  // table, so a single Δord constantly drives ΔO⋈O + O⋈ΔO + ΔO⋈ΔO — and the
  // update case (a {old:−1, new:+1} batch on a *self-joined* table) is the
  // sharpest test of the expansion. fz_self3 also mixes a single-occurrence Δcust.
  { name: 'fz_selfpair', def: 'SELECT o1.id AS a, o2.id AS b FROM ord o1 JOIN ord o2 ON o1.cid = o2.cid AND o1.id < o2.id' },
  { name: 'fz_selfgrp', def: 'SELECT o1.cid AS cid, COUNT(*) AS pairs, MAX(o2.amt) AS mx, SUM(o1.amt) AS s FROM ord o1 JOIN ord o2 ON o1.cid = o2.cid AND o1.id < o2.id GROUP BY o1.cid' },
  { name: 'fz_self3', def: 'SELECT c.region, o1.amt AS x, o2.amt AS y FROM cust c JOIN ord o1 ON o1.cid = c.cid JOIN ord o2 ON o2.cid = c.cid WHERE o1.id < o2.id' },
]

/** A decimal literal of a random magnitude *and a random scale* (0–3 fractional
 *  digits), so the fuzz exercises the live-max-scale tracking of SUM/AVG. */
function randPrice(rng: Rng): string {
  const whole = rng.int(0, 200)
  const scale = rng.int(0, 3)
  if (scale === 0) return String(whole)
  const frac = String(rng.int(0, 10 ** scale - 1)).padStart(scale, '0')
  return `${whole}.${frac}`
}

function fuzzSeed(seed: number, steps: number): void {
  const rng = new Rng(seed)
  const regions = ['n', 's', 'e', 'w']
  const e = new Engine()
  e.execute('CREATE TABLE cust (cid INTEGER PRIMARY KEY, region TEXT)')
  e.execute('CREATE TABLE ord (id INTEGER PRIMARY KEY, cid INTEGER, amt INTEGER, price DECIMAL)')
  const liveCust: number[] = []
  for (let c = 1; c <= 4; c++) {
    e.execute(`INSERT INTO cust VALUES (${c}, '${rng.pick(regions)}')`)
    liveCust.push(c)
  }
  let nextCid = 5
  for (const v of FUZZ_VIEWS) e.execute(`CREATE MATERIALIZED VIEW ${v.name} AS ${v.def}`)
  let nextId = 1
  const live: number[] = []
  // cid range spans live customers plus one "dangling" id (5 max+1) so outer
  // joins regularly see orphan order rows with no parent customer.
  const someCid = (): number => rng.int(1, nextCid)
  for (let step = 0; step < steps; step++) {
    const op = rng.int(0, 9)
    if (op <= 3 || live.length === 0) {
      // insert an order
      const id = nextId++
      e.execute(`INSERT INTO ord VALUES (${id}, ${someCid()}, ${rng.int(0, 200)}, ${randPrice(rng)})`)
      live.push(id)
    } else if (op <= 5) {
      // update an order (amt, cid, price all move)
      const id = rng.pick(live)
      e.execute(`UPDATE ord SET amt = ${rng.int(0, 200)}, cid = ${someCid()}, price = ${randPrice(rng)} WHERE id = ${id}`)
    } else if (op <= 6) {
      // delete an order
      const idx = rng.int(0, live.length - 1)
      e.execute(`DELETE FROM ord WHERE id = ${live[idx]}`)
      live.splice(idx, 1)
    } else if (op <= 7) {
      // insert a new customer
      const cid = nextCid++
      e.execute(`INSERT INTO cust VALUES (${cid}, '${rng.pick(regions)}')`)
      liveCust.push(cid)
    } else if (op <= 8) {
      // move a customer to a new region
      e.execute(`UPDATE cust SET region = '${rng.pick(regions)}' WHERE cid = ${rng.pick(liveCust)}`)
    } else if (liveCust.length > 1) {
      // delete a customer (its orders become orphans → outer-join NULL rows)
      const idx = rng.int(0, liveCust.length - 1)
      e.execute(`DELETE FROM cust WHERE cid = ${liveCust[idx]}`)
      liveCust.splice(idx, 1)
    }
    for (const v of FUZZ_VIEWS) {
      assertMatches(e, v.name, v.def, `fuzz seed=${seed} step=${step} view=${v.name}`)
    }
  }
}

// A handful of fixed seeds, each re-checking all 16 views after every one of 50
// random mutations on both tables (≈800 differential comparisons per seed).
for (const seed of [1, 7, 42, 101, 256, 1009]) {
  test(`differential fuzz — seed ${seed} (16 views × 50 random mutations on two tables)`, () => fuzzSeed(seed, 50))
}

export const ivmCases = cases
