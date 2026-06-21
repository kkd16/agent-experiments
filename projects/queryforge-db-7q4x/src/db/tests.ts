// Engine self-tests. These run in the browser (the "Tests" panel) and can be
// executed head-less in CI. Keeping them in src means the exact same engine
// build is what gets verified.

import { Engine, type RowsResult } from './engine'
import { mvccCases } from './concurrency/tests'
import { recoveryCases } from './recovery/tests'
import { SEED_SQL, SAMPLE_QUERIES } from './sampleData'
import { csvToSql, parseCsv } from './csv'
import { Database } from './catalog'
import type { Row } from './catalog'
import { formatValue, type SqlValue } from './types'
import { isTemporal } from './temporal'
import {
  porterStem,
  toTsVector,
  toTsQuery,
  tsMatch,
  formatTsVector,
  formatTsQuery,
  plainToTsQuery,
  phraseToTsQuery,
  webSearchToTsQuery,
  parseTsVector,
  setWeight,
  stripTsVector,
  concatTsVector,
  tsRank,
  numNode,
} from './fts'

export interface TestResult {
  name: string
  group: string
  pass: boolean
  detail: string
}

function seeded(): Engine {
  const e = new Engine()
  e.execute(SEED_SQL)
  return e
}
function rowsOf(e: Engine, sql: string): Row[] {
  const results = e.execute(sql)
  const last = results[results.length - 1]
  if (last.kind !== 'rows') throw new Error('expected a rows result')
  return last.rows
}
function lastResult(e: Engine, sql: string) {
  const results = e.execute(sql)
  return results[results.length - 1]
}
function scalar(e: Engine, sql: string): SqlValue {
  return rowsOf(e, sql)[0][0]
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type Case = { name: string; group: string; run: () => void }

const cases: Case[] = []
function test(group: string, name: string, run: () => void) {
  cases.push({ group, name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}
/** Assert that running `sql` throws, optionally with `frag` in the message. */
function throws(e: Engine, sql: string, frag?: string): void {
  try {
    e.execute(sql)
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    if (frag && !m.includes(frag)) throw new Error(`threw, but message ${JSON.stringify(m)} lacks ${JSON.stringify(frag)}`, { cause: err })
    return
  }
  throw new Error(`expected ${JSON.stringify(sql)} to throw${frag ? ` (${frag})` : ''}`)
}
function fresh(ddl: string): Engine {
  const e = new Engine()
  e.execute(ddl)
  return e
}

// --- lexer / parser ---------------------------------------------------------
test('parser', 'tokenizes and parses a SELECT', () => {
  const e = seeded()
  const r = lastResult(e, 'SELECT 1 + 2 * 3 AS x') as RowsResult
  assert(r.kind === 'rows' && r.rows[0][0] === 7, 'precedence 1+2*3 should be 7')
})
test('parser', 'string-literal escapes', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT 'it''s ok' AS s") === "it's ok", "'' escape failed")
})
test('parser', 'unary minus + parentheses', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT -(2 + 3) AS v') === -5, 'unary/paren failed')
})

// --- expressions / 3-valued logic ------------------------------------------
test('expr', 'NULL propagation in arithmetic', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT 1 + NULL AS v') === null, '1 + NULL should be NULL')
})
test('expr', 'three-valued AND', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT (NULL AND FALSE) AS v') === false, 'NULL AND FALSE = FALSE')
  assert(scalar(e, 'SELECT (NULL AND TRUE) AS v') === null, 'NULL AND TRUE = NULL')
})
test('expr', 'CASE expression', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT CASE WHEN 2 > 1 THEN 'a' ELSE 'b' END AS v") === 'a', 'CASE failed')
})
test('expr', 'LIKE wildcards', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT 'hello' LIKE 'h_l%' AS v") === true, 'LIKE failed')
})
test('expr', 'IN list with NULL', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT 3 IN (1, 2, 3) AS v') === true, 'IN positive failed')
  assert(scalar(e, 'SELECT 9 IN (1, NULL) AS v') === null, 'IN with NULL should be NULL')
})
test('expr', 'scalar functions', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT UPPER('abc') AS v") === 'ABC', 'UPPER failed')
  assert(scalar(e, 'SELECT ROUND(3.14159, 2) AS v') === 3.14, 'ROUND failed')
  assert(scalar(e, "SELECT COALESCE(NULL, NULL, 'x') AS v") === 'x', 'COALESCE failed')
})

// --- DML / constraints ------------------------------------------------------
test('dml', 'INSERT / SELECT round trip', () => {
  const e = seeded()
  assert(scalar(e, 'SELECT COUNT(*) FROM customers') === 8, 'expected 8 customers')
})
test('dml', 'UPDATE with predicate', () => {
  const e = seeded()
  e.execute("UPDATE products SET price = price * 2 WHERE category = 'Audio'")
  assert(scalar(e, "SELECT price FROM products WHERE name = 'Studio Microphone'") === 398, 'update math failed')
})
test('dml', 'DELETE with predicate', () => {
  const e = seeded()
  e.execute('DELETE FROM orders WHERE quantity > 3')
  assert(scalar(e, 'SELECT COUNT(*) FROM orders') === 13, 'expected 13 orders after delete')
})
test('dml', 'NOT NULL constraint enforced', () => {
  const e = seeded()
  let threw = false
  try {
    e.execute('INSERT INTO customers (id, name) VALUES (99, NULL)')
  } catch {
    threw = true
  }
  assert(threw, 'NOT NULL violation should throw')
})
test('dml', 'PRIMARY KEY uniqueness enforced', () => {
  const e = seeded()
  let threw = false
  try {
    e.execute("INSERT INTO customers (id, name) VALUES (1, 'Dup')")
  } catch {
    threw = true
  }
  assert(threw, 'duplicate PK should throw')
})

// --- joins ------------------------------------------------------------------
test('join', 'INNER JOIN row count', () => {
  const e = seeded()
  assert(scalar(e, 'SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id = c.id') === 15, 'inner join count')
})
test('join', 'LEFT JOIN keeps unmatched rows', () => {
  const e = seeded()
  e.execute("INSERT INTO customers (id, name) VALUES (50, 'No Orders')")
  const rows = rowsOf(
    e,
    "SELECT c.name, COUNT(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.id = 50 GROUP BY c.name",
  )
  assert(rows.length === 1 && rows[0][1] === 0, 'LEFT JOIN should give 0 orders for new customer')
})
test('join', 'three-way join', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    `SELECT c.name, p.name FROM orders o
     JOIN customers c ON o.customer_id = c.id
     JOIN products p ON o.product_id = p.id`,
  )
  assert(rows.length === 15, 'three-way join should keep 15 rows')
})

test('join', 'RIGHT JOIN keeps unmatched right rows', () => {
  const e = seeded()
  e.execute("INSERT INTO customers (id, name) VALUES (90, 'Loner')")
  const rows = rowsOf(e, 'SELECT c.name, o.id FROM orders o RIGHT JOIN customers c ON o.customer_id = c.id WHERE c.id = 90')
  assert(rows.length === 1 && rows[0][1] === null, 'RIGHT JOIN should null-extend the order-less customer')
})
test('join', 'FULL JOIN keeps both sides', () => {
  const e = new Engine()
  e.execute('CREATE TABLE l (id INTEGER); CREATE TABLE r (id INTEGER)')
  e.execute('INSERT INTO l (id) VALUES (1), (2)')
  e.execute('INSERT INTO r (id) VALUES (2), (3)')
  const rows = rowsOf(e, 'SELECT l.id, r.id FROM l FULL JOIN r ON l.id = r.id')
  assert(rows.length === 3, `FULL JOIN of {1,2}×{2,3} should be 3 rows, got ${rows.length}`)
  const nullsLeft = rows.filter((x) => x[0] === null).length
  const nullsRight = rows.filter((x) => x[1] === null).length
  assert(nullsLeft === 1 && nullsRight === 1, 'FULL JOIN should produce one null on each side')
})
test('join', 'LEFT JOIN + WHERE on right side filters correctly', () => {
  const e = seeded()
  e.execute("INSERT INTO customers (id, name) VALUES (92, 'Quiet')")
  // The new customer has no orders; a WHERE on the right table must exclude it.
  const rows = rowsOf(e, 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.quantity > 100')
  assert(rows.length === 0, 'WHERE on the nullable side must not leak null-extended rows')
})
test('dml', 'INSERT … SELECT', () => {
  const e = seeded()
  e.execute('CREATE TABLE audio (id INTEGER, name TEXT)')
  const res = e.execute("INSERT INTO audio (id, name) SELECT id, name FROM products WHERE category = 'Audio'")[0]
  assert(res.kind === 'message' && res.rowCount === 2, 'INSERT … SELECT should copy 2 audio products')
  assert(scalar(e, 'SELECT COUNT(*) FROM audio') === 2, 'audio table should hold 2 rows')
})

// --- aggregation ------------------------------------------------------------
test('agg', 'GROUP BY + HAVING', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    'SELECT category, COUNT(*) AS n FROM products GROUP BY category HAVING COUNT(*) > 1 ORDER BY category',
  )
  assert(rows.length >= 1 && rows.every((r) => (r[1] as number) > 1), 'HAVING filter failed')
})
test('agg', 'COUNT DISTINCT', () => {
  const e = seeded()
  assert(scalar(e, 'SELECT COUNT(DISTINCT country) FROM customers') === 2, 'distinct countries should be 2')
})
test('agg', 'AVG / SUM / MIN / MAX', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT MIN(price), MAX(price) FROM products')
  assert(rows[0][0] === 49.9 && rows[0][1] === 549.5, 'min/max price wrong')
})
test('agg', 'empty-table COUNT(*) is 0', () => {
  const e = new Engine()
  e.execute('CREATE TABLE t (a INTEGER)')
  assert(scalar(e, 'SELECT COUNT(*) FROM t') === 0, 'empty count should be 0')
})

// --- ordering / distinct / limit -------------------------------------------
test('query', 'ORDER BY DESC + LIMIT', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT name, price FROM products ORDER BY price DESC LIMIT 2')
  assert(rows.length === 2 && rows[0][1] === 549.5, 'order/limit failed')
})
test('query', 'DISTINCT', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT DISTINCT country FROM customers')
  assert(rows.length === 2, 'distinct country count')
})
test('query', 'LIMIT with OFFSET', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT id FROM products ORDER BY id LIMIT 3 OFFSET 2')
  assert(eq(rows.map((r) => r[0]), [3, 4, 5]), 'limit/offset window wrong')
})

// --- index / planner --------------------------------------------------------
test('planner', 'index range scan is chosen', () => {
  const e = seeded()
  const r = e.execute('EXPLAIN SELECT name FROM products WHERE price >= 200 AND price <= 500')[0]
  assert(r.kind === 'explain', 'expected explain')
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('IndexScan'), 'planner should pick an IndexScan for a price range')
})
test('planner', 'hash join chosen for equijoin', () => {
  const e = seeded()
  const r = e.execute('EXPLAIN SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id')[0]
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('HashJoin'), 'planner should pick a HashJoin for an equijoin')
})
test('planner', 'EXPLAIN ANALYZE records actual rows', () => {
  const e = seeded()
  const r = e.execute('EXPLAIN ANALYZE SELECT * FROM products')[0]
  assert(r.kind === 'explain' && r.plan.actualRows === 8, 'analyze should count 8 rows')
})

// --- transactions -----------------------------------------------------------
test('txn', 'ROLLBACK undoes changes', () => {
  const e = seeded()
  e.execute("BEGIN; INSERT INTO products (id, name) VALUES (77, 'temp'); ROLLBACK;")
  assert(scalar(e, 'SELECT COUNT(*) FROM products') === 8, 'rollback should restore 8 products')
})
test('txn', 'COMMIT keeps changes', () => {
  const e = seeded()
  e.execute("BEGIN; INSERT INTO products (id, name) VALUES (78, 'kept'); COMMIT;")
  assert(scalar(e, 'SELECT COUNT(*) FROM products') === 9, 'commit should keep 9 products')
})

// --- scalar function library ------------------------------------------------
test('functions', 'string functions', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT LEFT('hello', 3)") === 'hel', 'LEFT failed')
  assert(scalar(e, "SELECT RIGHT('hello', 2)") === 'lo', 'RIGHT failed')
  assert(scalar(e, "SELECT LPAD('7', 4, '0')") === '0007', 'LPAD failed')
  assert(scalar(e, "SELECT REVERSE('abc')") === 'cba', 'REVERSE failed')
  assert(scalar(e, "SELECT INITCAP('the DB')") === 'The Db', 'INITCAP failed')
  assert(scalar(e, "SELECT INSTR('abcd', 'cd')") === 3, 'INSTR failed')
  assert(scalar(e, "SELECT REPEAT('ab', 3)") === 'ababab', 'REPEAT failed')
  assert(scalar(e, "SELECT CONCAT_WS('-', 'a', NULL, 'b')") === 'a-b', 'CONCAT_WS failed')
})
test('functions', 'numeric functions', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT SIGN(-4)') === -1, 'SIGN failed')
  assert(scalar(e, 'SELECT TRUNC(3.789, 1)') === 3.7, 'TRUNC failed')
  assert(scalar(e, 'SELECT POWER(2, 10)') === 1024, 'POWER failed')
  assert(Math.abs((scalar(e, 'SELECT LN(EXP(1))') as number) - 1) < 1e-9, 'LN/EXP failed')
  assert(scalar(e, 'SELECT LOG(2, 8)') === 3, 'LOG base 2 of 8 should be 3')
})
test('functions', 'conditional functions', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT NULLIF(5, 5)') === null, 'NULLIF equal should be NULL')
  assert(scalar(e, 'SELECT NULLIF(5, 6)') === 5, 'NULLIF unequal should be lhs')
  assert(scalar(e, 'SELECT GREATEST(3, 9, 2, NULL)') === 9, 'GREATEST failed')
  assert(scalar(e, 'SELECT LEAST(3, 9, 2)') === 2, 'LEAST failed')
})
test('functions', 'date/time functions', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT DATE_PART('year', '2021-07-04')") === 2021, 'DATE_PART year failed')
  assert(scalar(e, "SELECT DATE_PART('month', '2021-07-04')") === 7, 'DATE_PART month failed')
  assert(scalar(e, "SELECT STRFTIME('%Y/%m/%d', '2021-07-04')") === '2021/07/04', 'STRFTIME failed')
  assert(scalar(e, "SELECT DATEDIFF('2021-01-11', '2021-01-01')") === 10, 'DATEDIFF failed')
  assert(scalar(e, "SELECT DATE('2021-07-04 12:30:00')") === '2021-07-04', 'DATE truncation failed')
})

// --- subqueries -------------------------------------------------------------
test('subquery', 'scalar subquery in WHERE', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT name FROM products WHERE price > (SELECT AVG(price) FROM products)')
  assert(rows.length === 4, `expected 4 above-average products, got ${rows.length}`)
})
test('subquery', 'correlated scalar subquery in SELECT', () => {
  const e = seeded()
  assert(
    scalar(e, 'SELECT (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) FROM customers c WHERE c.id = 1') === 3,
    'customer 1 should have 3 orders',
  )
})
test('subquery', 'IN subquery', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE quantity >= 3)')
  assert(rows.length === 3, `expected 3 customers, got ${rows.length}`)
})
test('subquery', 'NOT IN subquery', () => {
  const e = seeded()
  e.execute("INSERT INTO customers (id, name) VALUES (60, 'Lonely')")
  const rows = rowsOf(e, 'SELECT name FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)')
  assert(rows.length === 1 && rows[0][0] === 'Lonely', 'NOT IN should isolate the order-less customer')
})
test('subquery', 'EXISTS / NOT EXISTS', () => {
  const e = seeded()
  assert(scalar(e, 'SELECT COUNT(*) FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)') === 8, 'all 8 customers have orders')
  e.execute("INSERT INTO customers (id, name) VALUES (61, 'NoOrders')")
  const rows = rowsOf(e, 'SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)')
  assert(rows.length === 1 && rows[0][0] === 'NoOrders', 'NOT EXISTS should find the new customer')
})

test('subquery', '> ALL quantified comparison', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT name FROM products WHERE price >= ALL (SELECT price FROM products)')
  assert(rows.length === 1 && rows[0][0] === 'Ultrawide Monitor', '>= ALL should find the single priciest product')
})
test('subquery', '= ANY quantified comparison', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT name FROM customers WHERE id = ANY (SELECT customer_id FROM orders WHERE quantity >= 4)')
  assert(rows.length === 2, `= ANY should match 2 customers, got ${rows.length}`)
})

// --- derived tables ---------------------------------------------------------
test('derived', 'derived table in FROM', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    'SELECT category, n FROM (SELECT category, COUNT(*) AS n FROM products GROUP BY category) t WHERE n > 1 ORDER BY category',
  )
  assert(rows.length === 3 && rows.every((r) => (r[1] as number) > 1), 'derived table filter failed')
})
test('derived', 'qualified projection is referenceable by bare name', () => {
  const e = seeded()
  // The inner query projects c.id / c.name (qualified); the outer must see them
  // under their unqualified names.
  const rows = rowsOf(
    e,
    'SELECT name FROM (SELECT c.id, c.name FROM customers c WHERE c.country = \'UK\') t WHERE id = 1',
  )
  assert(rows.length === 1 && rows[0][0] === 'Ada Lovelace', 'unqualified projection name lost')
})
test('derived', 'derived table preserves numeric types', () => {
  const e = seeded()
  // If materialization coerced to TEXT, SUM would concatenate / error.
  assert(scalar(e, 'SELECT SUM(p) FROM (SELECT price AS p FROM products) d') === 2203.4, 'derived numeric type lost')
})

// --- VALUES constructor -----------------------------------------------------
test('values', 'top-level VALUES row set', () => {
  const e = new Engine()
  const rows = rowsOf(e, "VALUES (1, 'a'), (2, 'b'), (3, 'c')")
  assert(rows.length === 3 && rows[1][1] === 'b', 'VALUES should yield the literal rows')
})
test('values', 'FROM (VALUES …) AS t(cols) with filter', () => {
  const e = new Engine()
  const rows = rowsOf(e, "SELECT x, y FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS t(x, y) WHERE x >= 2 ORDER BY x")
  assert(eq(rows, [[2, 'b'], [3, 'c']]), 'derived VALUES table with column aliases wrong')
})
test('values', 'VALUES joined against a base table', () => {
  const e = seeded()
  // Map category → display label via an inline VALUES table.
  const rows = rowsOf(
    e,
    `SELECT p.name, lbl.label
     FROM products p
     JOIN (VALUES ('Audio', 'Sound'), ('Hardware', 'Gear')) AS lbl(cat, label) ON p.category = lbl.cat
     ORDER BY p.name`,
  )
  assert(rows.length > 0 && rows.every((r) => r[1] === 'Sound' || r[1] === 'Gear'), 'VALUES join labels wrong')
})
test('values', 'VALUES type unification (INTEGER + REAL)', () => {
  const e = new Engine()
  const r = lastResult(e, 'SELECT n FROM (VALUES (1), (2.5), (3)) AS v(n) ORDER BY n') as RowsResult
  assert(r.kind === 'rows' && r.columns[0].type === 'REAL', 'mixed numeric VALUES column should widen to REAL')
  assert(eq(r.rows, [[1], [2.5], [3]]), 'VALUES rows wrong')
})
test('derived', 'derived table column aliases — FROM (SELECT …) t(cols)', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT label, total FROM (SELECT category, COUNT(*) FROM products GROUP BY category) AS s(label, total) WHERE total > 1 ORDER BY label')
  assert(rows.length === 3 && rows.every((r) => (r[1] as number) > 1), 'derived column aliasing failed')
})

// --- CTEs -------------------------------------------------------------------
test('cte', 'simple WITH', () => {
  const e = seeded()
  const rows = rowsOf(e, 'WITH big AS (SELECT * FROM products WHERE price > 200) SELECT COUNT(*) FROM big')
  assert(rows[0][0] === 4, 'expected 4 expensive products in CTE')
})
test('cte', 'multiple CTEs referencing each other', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    `WITH a AS (SELECT id, price FROM products WHERE price > 100),
          b AS (SELECT id FROM a WHERE price < 400)
     SELECT COUNT(*) FROM b`,
  )
  assert(rows[0][0] === 5, `expected 5 rows in chained CTE, got ${rows[0][0]}`)
})
test('cte', 'recursive sequence 1..5', () => {
  const e = new Engine()
  const rows = rowsOf(e, 'WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT n FROM seq')
  assert(eq(rows.map((r) => r[0]), [1, 2, 3, 4, 5]), 'recursive sequence wrong')
})
test('cte', 'recursive transitive closure', () => {
  const e = new Engine()
  e.execute('CREATE TABLE edge (src INTEGER, dst INTEGER)')
  e.execute('INSERT INTO edge (src, dst) VALUES (1, 2), (2, 3), (3, 4), (1, 5)')
  const rows = rowsOf(
    e,
    `WITH RECURSIVE reach(node) AS (
       SELECT dst FROM edge WHERE src = 1
       UNION
       SELECT e.dst FROM edge e JOIN reach r ON e.src = r.node
     )
     SELECT COUNT(*) FROM reach`,
  )
  assert(rows[0][0] === 4, `expected 4 reachable nodes, got ${rows[0][0]}`)
})

// --- set operations ---------------------------------------------------------
test('setop', 'UNION removes duplicates', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT country FROM customers UNION SELECT country FROM customers')
  assert(rows.length === 2, 'UNION should collapse to 2 distinct countries')
})
test('setop', 'UNION ALL keeps duplicates', () => {
  const e = new Engine()
  const rows = rowsOf(e, 'SELECT 1 UNION ALL SELECT 1 UNION ALL SELECT 2')
  assert(rows.length === 3, 'UNION ALL should keep 3 rows')
})
test('setop', 'INTERSECT', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    'SELECT customer_id FROM orders WHERE order_year = 2022 INTERSECT SELECT customer_id FROM orders WHERE order_year = 2023',
  )
  assert(rows.length === 5, `expected 5 customers active both years, got ${rows.length}`)
})
test('setop', 'EXCEPT', () => {
  const e = new Engine()
  const rows = rowsOf(e, 'SELECT 1 UNION SELECT 2 UNION SELECT 3 EXCEPT SELECT 2')
  assert(eq(rows.map((r) => r[0]).sort(), [1, 3]), 'EXCEPT should remove 2')
})
test('setop', 'EXCEPT ALL multiset', () => {
  const e = new Engine()
  const rows = rowsOf(e, 'SELECT 1 UNION ALL SELECT 1 UNION ALL SELECT 1 EXCEPT ALL SELECT 1')
  assert(rows.length === 2, 'EXCEPT ALL should leave two 1s')
})

// --- window functions -------------------------------------------------------
test('window', 'ROW_NUMBER partitioned', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    'SELECT name, ROW_NUMBER() OVER (PARTITION BY category ORDER BY price DESC) AS rn FROM products ORDER BY category, rn',
  )
  const audio = rows.filter((r) => r[1] === 1)
  assert(audio.length >= 4, 'each category should have a rank-1 row')
})
test('window', 'RANK with ties / DENSE_RANK', () => {
  const e = new Engine()
  e.execute('CREATE TABLE s (v INTEGER)')
  e.execute('INSERT INTO s (v) VALUES (10), (10), (20), (30)')
  const rows = rowsOf(e, 'SELECT v, RANK() OVER (ORDER BY v) AS r, DENSE_RANK() OVER (ORDER BY v) AS d FROM s ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [1, 1, 3, 4]), 'RANK ties wrong')
  assert(eq(rows.map((r) => r[2]), [1, 1, 2, 3]), 'DENSE_RANK ties wrong')
})
test('window', 'running SUM (ordered aggregate window)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE s (v INTEGER)')
  e.execute('INSERT INTO s (v) VALUES (1), (2), (3), (4)')
  const rows = rowsOf(e, 'SELECT v, SUM(v) OVER (ORDER BY v) AS running FROM s ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [1, 3, 6, 10]), 'running sum wrong')
})
test('window', 'LAG / LEAD', () => {
  const e = new Engine()
  e.execute('CREATE TABLE s (v INTEGER)')
  e.execute('INSERT INTO s (v) VALUES (10), (20), (30)')
  const rows = rowsOf(e, 'SELECT v, LAG(v) OVER (ORDER BY v) AS lg, LEAD(v) OVER (ORDER BY v) AS ld FROM s ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [null, 10, 20]), 'LAG wrong')
  assert(eq(rows.map((r) => r[2]), [20, 30, null]), 'LEAD wrong')
})
test('window', 'NTILE buckets', () => {
  const e = new Engine()
  e.execute('CREATE TABLE s (v INTEGER)')
  e.execute('INSERT INTO s (v) VALUES (1), (2), (3), (4)')
  const rows = rowsOf(e, 'SELECT v, NTILE(2) OVER (ORDER BY v) AS bucket FROM s ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [1, 1, 2, 2]), 'NTILE split wrong')
})
test('window', 'window over an aggregate', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    'SELECT category, COUNT(*) AS n, RANK() OVER (ORDER BY COUNT(*) DESC) AS rk FROM products GROUP BY category ORDER BY rk, category',
  )
  assert(rows[0][2] === 1 && (rows[0][1] as number) === 3, 'Hardware (3 items) should rank 1')
})

// --- regressions (from code review) ----------------------------------------
test('window', 'RANK with PARTITION BY but no ORDER BY is all 1', () => {
  const e = new Engine()
  e.execute('CREATE TABLE t (d TEXT, v INTEGER)')
  e.execute("INSERT INTO t (d, v) VALUES ('a', 1), ('a', 2), ('a', 3)")
  const rows = rowsOf(e, 'SELECT RANK() OVER (PARTITION BY d) AS r, DENSE_RANK() OVER (PARTITION BY d) AS dr FROM t')
  assert(rows.every((x) => x[0] === 1 && x[1] === 1), 'with no ORDER BY every row is a peer → rank 1')
})
test('window', 'LAST_VALUE follows the running frame when ordered', () => {
  const e = new Engine()
  e.execute('CREATE TABLE t (v INTEGER)')
  e.execute('INSERT INTO t (v) VALUES (5), (8), (3)')
  const rows = rowsOf(e, 'SELECT v, LAST_VALUE(v) OVER (ORDER BY v) AS l FROM t ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [3, 5, 8]), 'LAST_VALUE should equal the current row under the default frame')
})
test('setop', 'INTERSECT binds tighter than UNION', () => {
  const e = new Engine()
  const rows = rowsOf(e, 'SELECT 1 UNION SELECT 2 INTERSECT SELECT 2 ORDER BY 1')
  assert(eq(rows.map((r) => r[0]), [1, 2]), '1 UNION (2 INTERSECT 2) should be {1,2}')
})
test('cte', 'recursive CTE with an extra constant (anchor) branch terminates', () => {
  const e = new Engine()
  const rows = rowsOf(
    e,
    'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3 UNION ALL SELECT 99) SELECT n FROM t ORDER BY n',
  )
  assert(eq(rows.map((r) => r[0]), [1, 2, 3, 99]), 'non-recursive branch must run once, not every iteration')
})
test('query', 'ORDER BY ordinal in a plain SELECT', () => {
  const e = seeded()
  const rows = rowsOf(e, 'SELECT name, price FROM products ORDER BY 2 DESC LIMIT 1')
  assert(rows[0][1] === 549.5, 'ORDER BY 2 should sort by the 2nd output column')
})
test('subquery', 'nested subquery correlated to a grandparent row is not stale-cached', () => {
  const e = seeded()
  // The middle IN-subquery references only orders locally, but its inner scalar
  // subquery is correlated to c.signup_year — so the middle must re-run per c.
  const a = rowsOf(
    e,
    `SELECT c.name FROM customers c WHERE c.id IN (
       SELECT o.customer_id FROM orders o
       WHERE o.quantity > (SELECT AVG(quantity) FROM orders WHERE order_year = c.signup_year))`,
  ).map((r) => r[0])
  // Cross-check against the same logic written without the membership subquery.
  const b = rowsOf(
    e,
    `SELECT DISTINCT c.name FROM customers c JOIN orders o ON o.customer_id = c.id
     WHERE o.quantity > (SELECT AVG(quantity) FROM orders WHERE order_year = c.signup_year)`,
  ).map((r) => r[0])
  assert(eq([...a].sort(), [...b].sort()), 'correlated-through-nesting result must match the join form')
})
test('join', 'subquery in a JOIN ON predicate', () => {
  const e = seeded()
  const n = scalar(
    e,
    'SELECT COUNT(*) FROM orders o JOIN products p ON p.id = o.product_id AND p.price > (SELECT AVG(price) FROM products)',
  )
  assert(n === 7, `expected 7 orders of above-average products, got ${n}`)
})

// --- cost-based join reordering ---------------------------------------------
function deepestJoin(n: { op: string; children: { op: string; detail: string; children: unknown[] }[]; detail: string }): typeof n | null {
  for (const c of n.children) {
    const d = deepestJoin(c as typeof n)
    if (d) return d
  }
  return /Join/.test(n.op) ? n : null
}
test('reorder', 'small relations are joined first (clique)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE big (k INTEGER); CREATE TABLE s1 (k INTEGER); CREATE TABLE s2 (k INTEGER)')
  e.execute('INSERT INTO big (k) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<200) SELECT n FROM r')
  e.execute('INSERT INTO s1 (k) VALUES (1)')
  e.execute('INSERT INTO s2 (k) VALUES (1)')
  const r = e.execute(
    'EXPLAIN SELECT COUNT(*) FROM big b JOIN s1 ON b.k = s1.k JOIN s2 ON b.k = s2.k AND s1.k = s2.k',
  )[0]
  assert(r.kind === 'explain', 'expected explain')
  const deepest = r.kind === 'explain' ? deepestJoin(r.plan as never) : null
  assert(!!deepest, 'plan should contain a join')
  // The clique is fully connected (every pair shares b.k = s_.k), so a good plan
  // wires it with equijoins and never falls back to a Cartesian product + filter.
  // (With the v15 distinct-value cardinality model every join in this clique
  // collapses to a single row, so all left-deep orders are genuinely cost-equal —
  // what matters is that the optimizer connected them rather than crossing them.)
  const planText = r.kind === 'explain' ? JSON.stringify(r.plan) : ''
  assert(!/CrossJoin/.test(planText), `clique should connect via equijoins, not a Cartesian: ${planText}`)
  assert(/Join/.test(deepest!.op) && !/Cross/.test(deepest!.op), `deepest node should be an equijoin, got: ${deepest!.op}`)
})
test('reorder', 'reordered join produces the correct result', () => {
  const e = new Engine()
  e.execute('CREATE TABLE big (k INTEGER); CREATE TABLE s1 (k INTEGER); CREATE TABLE s2 (k INTEGER)')
  e.execute('INSERT INTO big (k) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<200) SELECT n FROM r')
  e.execute('INSERT INTO s1 (k) VALUES (1)')
  e.execute('INSERT INTO s2 (k) VALUES (1)')
  assert(
    scalar(e, 'SELECT COUNT(*) FROM big b JOIN s1 ON b.k = s1.k JOIN s2 ON b.k = s2.k AND s1.k = s2.k') === 1,
    'only k=1 should match across all three',
  )
})
test('reorder', 'SELECT * keeps written column order despite reordering', () => {
  const e = seeded()
  // Reordering must be transparent: columns appear in FROM/JOIN order.
  const res = lastResult(
    e,
    'SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id JOIN products p ON o.product_id = p.id LIMIT 1',
  ) as RowsResult
  const names = res.columns.map((c) => c.name)
  // orders cols, then customers cols, then products cols.
  assert(names[0] === 'id' && names.indexOf('city') > names.indexOf('quantity'), 'columns should stay in written order')
  assert(res.rows.length === 1, 'should still return rows')
})
test('reorder', 'three-way join result is order-independent', () => {
  const e = seeded()
  const n = scalar(
    e,
    "SELECT COUNT(*) FROM orders o JOIN customers c ON o.customer_id = c.id JOIN products p ON o.product_id = p.id WHERE c.country = 'UK'",
  )
  // Cross-check against a two-step formulation that can't be reordered the same way.
  const m = scalar(
    e,
    "SELECT COUNT(*) FROM orders o JOIN products p ON o.product_id = p.id WHERE o.customer_id IN (SELECT id FROM customers WHERE country = 'UK')",
  )
  assert(n === m, `reordered join (${n}) must match the subquery formulation (${m})`)
})

// --- v15: the cost-based cardinality model ----------------------------------
// A helper to make a facts/regions star with `nf` fact rows over `nr` regions.
function star(nf: number, nr: number): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE facts (id INTEGER, region_id INTEGER, amount INTEGER)')
  e.execute('CREATE TABLE regions (id INTEGER, name TEXT)')
  e.execute(
    `INSERT INTO facts (id, region_id, amount) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<${nf}) SELECT n, (n % ${nr}) + 1, n * 2 FROM r`,
  )
  e.execute(
    `INSERT INTO regions (id, name) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<${nr}) SELECT n, 'r' || n FROM r`,
  )
  return e
}
test('optimizer', 'distinct-value model: an unfiltered equijoin estimate matches |L|·|R|/V', () => {
  const e = star(500, 5)
  const r = e.execute('EXPLAIN SELECT * FROM facts f JOIN regions g ON f.region_id = g.id')[0]
  const est = r.kind === 'explain' ? r.plan.estRows : -1
  // V(facts.region_id) = V(regions.id) = 5, so card = 500·5 / 5 = 500.
  assert(Math.abs(est - 500) <= 50, `unfiltered fact⋈dim should estimate ~500 rows, got ${est}`)
})
test('optimizer', 'a selective dimension filter propagates through the join', () => {
  const e = star(500, 5)
  // Filtering regions to a single row means only that region's facts survive.
  const r = e.execute('EXPLAIN SELECT * FROM facts f JOIN regions g ON f.region_id = g.id WHERE g.id = 1')[0]
  const est = r.kind === 'explain' ? r.plan.estRows : -1
  // V_eff(regions.id) = min(5, 1 surviving row) = 1, so card = 500·1 / max(5,1) = 100.
  // The OLD max(|L|,|R|) model would have said 500 — it could not see the filter.
  assert(est < 250, `a selective dim filter should shrink the join estimate well below 500, got ${est}`)
  assert(Math.abs(est - 100) <= 60, `estimate should be ~100 (500 facts / 5 regions), got ${est}`)
  // And the *actual* result really is 100 rows — the estimate tracks reality.
  assert(scalar(e, 'SELECT COUNT(*) FROM facts f JOIN regions g ON f.region_id = g.id WHERE g.id = 1') === 100, 'actual count is 100')
})
test('optimizer', 'the join estimate never exceeds the cartesian product', () => {
  const e = star(40, 4)
  const r = e.execute('EXPLAIN SELECT * FROM facts f JOIN regions g ON f.region_id = g.id')[0]
  const est = r.kind === 'explain' ? r.plan.estRows : -1
  assert(est >= 1 && est <= 40 * 4, `estimate ${est} must lie within [1, |L|·|R|]`)
})

test('optimizer', 'the join-order DP search is recorded for the Optimizer Lab', () => {
  const e = seeded()
  const { trace } = e.planAndTrace(
    "SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id JOIN products p ON o.product_id = p.id WHERE c.country = 'UK'",
  )
  assert(trace !== null, 'a 3-way inner join should produce a join-order trace')
  assert(trace!.relations.length === 3, `expected 3 relations, got ${trace!.relations.length}`)
  assert(trace!.finalOrder.length === 3, 'the winning order should list all three relations')
  assert(new Set(trace!.finalOrder).size === 3, 'the winning order has no duplicates')
  assert(trace!.best.length >= 3, 'a best plan should be recorded for several subsets')
  assert(trace!.candidates.some((c) => c.accepted), 'at least one extension was accepted')
  assert(trace!.finalCost > 0, 'the final cost should be set')
})
test('optimizer', 'a two-relation join is not reordered, so it has no DP trace', () => {
  const e = seeded()
  const { trace } = e.planAndTrace('SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id')
  assert(trace === null, 'fewer than three relations → the subset-DP search does not run')
})

// --- v15: the what-if Index Advisor -----------------------------------------
test('advisor', 'recommends an index for a selective equality, and the planner adopts it', () => {
  const e = star(500, 50) // 500 facts over 50 regions → region_id = k keeps ~10 rows
  const a = e.advise('SELECT * FROM facts WHERE region_id = 7')
  assert(a.ok, `advice should succeed: ${a.message ?? ''}`)
  assert(a.recommendations.length >= 1, 'should recommend at least one index')
  const top = a.recommendations[0]
  assert(top.table === 'facts' && top.columns.join(',') === 'region_id', `top rec should be facts(region_id), got ${top.table}(${top.columns.join(',')})`)
  assert(top.adopted, 'the planner must actually adopt the recommended index')
  assert(top.newCost < top.baselineCost, `recommended index should lower cost (${top.newCost} < ${top.baselineCost})`)
  assert(top.improvementPct > 0, 'improvement should be positive')
})
test('advisor', 'applying the recommendation makes the planner use an IndexScan', () => {
  const e = star(500, 50)
  const a = e.advise('SELECT * FROM facts WHERE region_id = 7')
  e.execute(a.recommendations[0].ddl)
  const planText = explainText(e, 'SELECT * FROM facts WHERE region_id = 7')
  assert(planText.includes('IndexScan'), `after applying the DDL the plan should use an IndexScan: ${planText}`)
})
test('advisor', 'does not re-recommend an index that already exists', () => {
  const e = star(500, 50)
  e.execute('CREATE INDEX ix_region ON facts (region_id)')
  const a = e.advise('SELECT * FROM facts WHERE region_id = 7')
  assert(!a.recommendations.some((r) => r.columns.join(',') === 'region_id'), 'should not recommend an existing index')
  assert(a.alreadyIndexed.some((s) => s.includes('region_id')), 'region_id should be reported as already covered')
})
test('advisor', 'recommends a composite index for a multi-equality query', () => {
  const e = new Engine()
  e.execute('CREATE TABLE t (a INTEGER, b INTEGER, c INTEGER)')
  e.execute('INSERT INTO t (a,b,c) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<400) SELECT n % 40, n % 20, n FROM r')
  const a = e.advise('SELECT c FROM t WHERE a = 5 AND b = 5')
  assert(a.ok, 'advice ok')
  const cols = a.recommendations.map((r) => r.columns.join(','))
  assert(cols.some((c) => c === 'a' || c === 'b' || c === 'a,b'), `expected an a / b / (a,b) recommendation, got: ${cols.join(' | ')}`)
})
test('advisor', 'is read-only — no hypothetical index leaks into later plans', () => {
  const e = star(200, 20)
  const before = scalar(e, 'SELECT COUNT(*) FROM facts')
  e.advise('SELECT * FROM facts WHERE region_id = 3')
  const planText = explainText(e, 'SELECT * FROM facts WHERE region_id = 3')
  assert(!planText.includes('__hypo'), 'a hypothetical index must never leak into a later plan')
  assert(!planText.includes('IndexScan'), 'with no real index, a later plan is back to a SeqScan')
  assert(scalar(e, 'SELECT COUNT(*) FROM facts') === before, 'advise must never change data')
})
test('advisor', 'refuses a non-SELECT statement', () => {
  const e = star(50, 5)
  const a = e.advise('UPDATE facts SET amount = 0')
  assert(!a.ok, 'should refuse a non-SELECT statement')
})

// --- v15: index nested-loop join --------------------------------------------
// A tiny driver table joined to a big, key-indexed inner table.
function driverAndBig(driverKeys: number[], bigRows = 400, dupKeys = false): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE big (k INTEGER, v INTEGER)')
  e.execute('CREATE INDEX ix_big_k ON big (k)')
  e.execute('CREATE TABLE drv (k INTEGER)')
  const keyExpr = dupKeys ? `(n % ${Math.max(1, Math.floor(bigRows / 2))}) + 1` : 'n'
  e.execute(
    `INSERT INTO big (k, v) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<${bigRows}) SELECT ${keyExpr}, n*10 FROM r`,
  )
  e.execute(`INSERT INTO drv (k) VALUES ${driverKeys.map((k) => `(${k})`).join(', ')}`)
  return e
}
test('inlj', 'a tiny driver over a big indexed inner picks an index nested-loop join', () => {
  const e = driverAndBig([5, 17, 123])
  const planText = explainText(e, 'SELECT d.k, b.v FROM drv d JOIN big b ON b.k = d.k')
  assert(planText.includes('IndexNestedLoopJoin'), `expected an INLJ for a tiny driver, got: ${planText}`)
})
test('inlj', 'an index nested-loop join returns exactly the hash-join rows (INNER)', () => {
  const e = driverAndBig([5, 17, 123])
  const rows = rowsOf(e, 'SELECT d.k, b.v FROM drv d JOIN big b ON b.k = d.k ORDER BY d.k')
  assert(eq(rows, [[5, 50], [17, 170], [123, 1230]]), `INNER INLJ rows wrong: ${JSON.stringify(rows)}`)
})
test('inlj', 'an index nested-loop LEFT join null-extends unmatched outer rows', () => {
  const e = driverAndBig([5, 17, 99999])
  const planText = explainText(e, 'SELECT d.k, b.v FROM drv d LEFT JOIN big b ON b.k = d.k')
  assert(planText.includes('IndexNestedLoopJoin'), `expected a LEFT INLJ, got: ${planText}`)
  const rows = rowsOf(e, 'SELECT d.k, b.v FROM drv d LEFT JOIN big b ON b.k = d.k ORDER BY d.k')
  assert(eq(rows, [[5, 50], [17, 170], [99999, null]]), `LEFT INLJ rows wrong: ${JSON.stringify(rows)}`)
})
test('inlj', 'an index nested-loop join handles duplicate inner keys (multi-match)', () => {
  // dupKeys makes every key appear exactly twice in big.
  const e = driverAndBig([3, 8], 400, true)
  const rows = rowsOf(e, 'SELECT d.k, b.v FROM drv d JOIN big b ON b.k = d.k ORDER BY d.k, b.v')
  // Each driver key matches two inner rows.
  assert(rows.length === 4, `expected 2 matches per key (4 rows), got ${rows.length}`)
  assert(rows.every((r) => r[0] === 3 || r[0] === 8), 'only driver keys 3 and 8 appear')
})
test('inlj', 'no index nested-loop join when the inner key is unindexed', () => {
  const e = new Engine()
  e.execute('CREATE TABLE big (k INTEGER, v INTEGER)') // deliberately no index on k
  e.execute('CREATE TABLE drv (k INTEGER)')
  e.execute('INSERT INTO big (k, v) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<400) SELECT n, n*10 FROM r')
  e.execute('INSERT INTO drv (k) VALUES (5), (17), (123)')
  const planText = explainText(e, 'SELECT d.k, b.v FROM drv d JOIN big b ON b.k = d.k')
  assert(!planText.includes('IndexNestedLoopJoin'), `no inner index → must not be an INLJ: ${planText}`)
})
test('inlj', 'no index nested-loop join for a balanced join (no tiny driver)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE a (k INTEGER); CREATE INDEX ix_a ON a (k)')
  e.execute('CREATE TABLE b (k INTEGER); CREATE INDEX ix_b ON b (k)')
  e.execute('INSERT INTO a (k) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<300) SELECT n FROM r')
  e.execute('INSERT INTO b (k) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<300) SELECT n FROM r')
  const planText = explainText(e, 'SELECT a.k FROM a JOIN b ON a.k = b.k')
  assert(!planText.includes('IndexNestedLoopJoin'), `balanced 300×300 join should not use an INLJ: ${planText}`)
})
test('inlj', 'the Index Advisor recommends an index that enables an index nested-loop join', () => {
  // No index on big.k → a tiny driver still hash-joins; the advisor should spot
  // that an index on the inner key flips it to a cheaper index nested-loop join.
  const e = new Engine()
  e.execute('CREATE TABLE big (k INTEGER, v INTEGER)')
  e.execute('CREATE TABLE drv (k INTEGER)')
  e.execute('INSERT INTO big (k, v) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<400) SELECT n, n*10 FROM r')
  e.execute('INSERT INTO drv (k) VALUES (5), (17), (123)')
  const before = explainText(e, 'SELECT d.k, b.v FROM drv d JOIN big b ON b.k = d.k')
  assert(!before.includes('IndexNestedLoopJoin'), 'no index yet → not an INLJ')
  const a = e.advise('SELECT d.k, b.v FROM drv d JOIN big b ON b.k = d.k')
  const rec = a.recommendations.find((r) => r.table === 'big' && r.columns.join(',') === 'k')
  assert(!!rec, `advisor should recommend big(k); got: ${a.recommendations.map((r) => r.table + '(' + r.columns.join(',') + ')').join(' | ')}`)
  assert(rec!.adopted, 'the recommended big(k) index should be adopted')
  e.execute(rec!.ddl)
  const after = explainText(e, 'SELECT d.k, b.v FROM drv d JOIN big b ON b.k = d.k')
  assert(after.includes('IndexNestedLoopJoin'), `after creating big(k) the plan should use an INLJ: ${after}`)
})

// --- composite indexes ------------------------------------------------------
test('index', 'composite index is chosen over a single-column one', () => {
  const e = seeded()
  e.execute('CREATE INDEX idx_orders_cy ON orders (customer_id, order_year)')
  const r = e.execute('EXPLAIN SELECT * FROM orders WHERE customer_id = 1 AND order_year = 2022')[0]
  assert(r.kind === 'explain', 'expected explain')
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('IndexScan'), 'should use an IndexScan')
  assert(text.includes('customer_id, order_year'), 'should pick the 2-column index that covers both equalities')
})
test('index', 'composite equality-prefix correctness', () => {
  const e = seeded()
  e.execute('CREATE INDEX idx_orders_cy ON orders (customer_id, order_year)')
  const rows = rowsOf(e, 'SELECT id FROM orders WHERE customer_id = 1 AND order_year = 2022 ORDER BY id')
  assert(eq(rows.map((r) => r[0]), [1, 2]), 'customer 1 in 2022 should be orders 1 and 2')
})
test('index', 'composite prefix + trailing range correctness', () => {
  const e = seeded()
  e.execute('CREATE INDEX idx_orders_cy ON orders (customer_id, order_year)')
  const rows = rowsOf(e, 'SELECT id FROM orders WHERE customer_id = 1 AND order_year >= 2023 ORDER BY id')
  assert(eq(rows.map((r) => r[0]), [11]), 'customer 1 from 2023 onward should be order 11')
})

// --- bitmap AND of multiple indexes -----------------------------------------
function bitmapEngine(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)')
  e.execute(
    'INSERT INTO t (id, a, b) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<300) SELECT n, n % 10, n % 7 FROM r',
  )
  e.execute('CREATE INDEX idx_a ON t (a)')
  e.execute('CREATE INDEX idx_b ON t (b)')
  return e
}
test('index', 'bitmap AND combines two single-column indexes', () => {
  const e = bitmapEngine()
  const r = e.execute('EXPLAIN SELECT id FROM t WHERE a = 3 AND b = 2')[0]
  assert(r.kind === 'explain', 'expected explain')
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('BitmapAnd'), 'two separate single-column indexes should be combined with a BitmapAnd')
  assert(text.includes('idx_a') && text.includes('idx_b'), 'both index bitmaps should appear')
})
test('index', 'bitmap AND returns the correct rows', () => {
  const e = bitmapEngine()
  let expected = 0
  for (let n = 1; n <= 300; n++) if (n % 10 === 3 && n % 7 === 2) expected++
  assert(scalar(e, 'SELECT COUNT(*) FROM t WHERE a = 3 AND b = 2') === expected, `bitmap AND count should be ${expected}`)
  const rows = rowsOf(e, 'SELECT id FROM t WHERE a = 3 AND b = 2 ORDER BY id')
  assert(rows.every((row) => ((row[0] as number) % 10 === 3 && (row[0] as number) % 7 === 2)), 'every row must satisfy both predicates')
})
test('index', 'bitmap OR turns an IN-list into index lookups', () => {
  const e = bitmapEngine()
  const r = e.execute('EXPLAIN SELECT id FROM t WHERE a IN (1, 3, 5)')[0]
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('BitmapOr'), 'an IN-list over an indexed column should use a BitmapOr')
  let expected = 0
  for (let n = 1; n <= 300; n++) if ([1, 3, 5].includes(n % 10)) expected++
  assert(scalar(e, 'SELECT COUNT(*) FROM t WHERE a IN (1, 3, 5)') === expected, `bitmap OR count should be ${expected}`)
  const rows = rowsOf(e, 'SELECT a FROM t WHERE a IN (1, 3, 5)')
  assert(rows.every((row) => [1, 3, 5].includes(row[0] as number)), 'every row must be in the IN-list')
})
test('grouping', 'GROUPING_ID returns the combined bitmap', () => {
  const e = salesEngine()
  const rows = rowsOf(
    e,
    'SELECT region, product, GROUPING_ID(region, product) AS gid, SUM(amount) AS s FROM sales GROUP BY ROLLUP(region, product) ORDER BY gid, region, product',
  )
  const detail = rows.find((r) => r[0] === 'N' && r[1] === 'A')!
  assert(detail[2] === 0, 'detail row GROUPING_ID should be 0')
  const sub = rows.find((r) => r[0] === 'N' && r[1] === null)!
  assert(sub[2] === 1, 'region subtotal GROUPING_ID should be binary 01 = 1')
  const grand = rows.find((r) => r[0] === null && r[1] === null)!
  assert(grand[2] === 3, 'grand total GROUPING_ID should be binary 11 = 3')
})
test('index', 'a covering composite index is preferred over a bitmap AND', () => {
  const e = bitmapEngine()
  e.execute('CREATE INDEX idx_ab ON t (a, b)')
  const r = e.execute('EXPLAIN SELECT id FROM t WHERE a = 3 AND b = 2')[0]
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('IndexScan') && text.includes('a, b'), 'a single composite index should win the tie')
  assert(!text.includes('BitmapAnd'), 'no bitmap needed when one index covers both predicates')
})

// --- index-only (covering) scans --------------------------------------------
function coverEngine(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, c TEXT)')
  e.execute(
    "INSERT INTO t (id, a, b, c) WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<100) SELECT n, n % 10, n * 2, 'x' FROM r",
  )
  e.execute('CREATE INDEX idx_ab ON t (a, b)')
  return e
}
test('index', 'index-only scan when the index covers every needed column', () => {
  const e = coverEngine()
  const r = e.execute('EXPLAIN SELECT a, b FROM t WHERE a = 3')[0]
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('IndexOnlyScan'), 'SELECT a, b over an (a, b) index should be index-only')
  assert(text.includes('heap not touched'), 'plan should note the heap is skipped')
})
test('index', 'falls back to a heap IndexScan when a column is not covered', () => {
  const e = coverEngine()
  const text = JSON.stringify((e.execute('EXPLAIN SELECT a, c FROM t WHERE a = 3')[0] as { plan: unknown }).plan)
  assert(!text.includes('IndexOnlyScan'), 'selecting an unindexed column (c) must read the heap')
  assert(text.includes('IndexScan'), 'should still use the index for the predicate')
})
test('index', 'SELECT * is never index-only', () => {
  const e = coverEngine()
  const text = JSON.stringify((e.execute('EXPLAIN SELECT * FROM t WHERE a = 3')[0] as { plan: unknown }).plan)
  assert(!text.includes('IndexOnlyScan'), 'SELECT * needs every column, so it cannot be covered')
})
test('index', 'index-only scan returns correct values (incl. extra covered filter)', () => {
  const e = coverEngine()
  let expectCount = 0
  let expectSum = 0
  for (let n = 1; n <= 100; n++) {
    if (n % 10 === 3) {
      expectSum += n * 2
      if (n * 2 > 40) expectCount++
    }
  }
  assert(scalar(e, 'SELECT SUM(b) FROM t WHERE a = 3') === expectSum, 'covering SUM(b) wrong')
  assert(scalar(e, 'SELECT COUNT(*) FROM t WHERE a = 3 AND b > 40') === expectCount, 'covering filter on b wrong')
  const rows = rowsOf(e, 'SELECT a, b FROM t WHERE a = 3 ORDER BY b LIMIT 2')
  assert(eq(rows, [[3, 6], [3, 26]]), `index-only rows wrong: ${JSON.stringify(rows)}`)
})

// --- statistics / cardinality estimation -----------------------------------
test('stats', 'ANALYZE makes a selective predicate estimate few rows', () => {
  const e = seeded()
  e.execute('ANALYZE')
  const r = e.execute('EXPLAIN SELECT * FROM products WHERE price > 500')[0]
  assert(r.kind === 'explain', 'expected explain')
  const est = r.kind === 'explain' ? r.plan.estRows : 999
  assert(est >= 1 && est <= 3, `a >500 price filter should estimate ~1 row, got ${est}`)
})
test('stats', 'equality on a low-cardinality column estimates a fraction', () => {
  const e = seeded()
  const r = e.execute("EXPLAIN SELECT * FROM customers WHERE country = 'UK'")[0]
  const est = r.kind === 'explain' ? r.plan.estRows : 999
  // 3 of 8 customers are UK — estimate should be well under the table size.
  assert(est >= 1 && est < 8, `country = 'UK' should estimate < 8 rows, got ${est}`)
})

// --- sort–merge join + external sort ----------------------------------------
function withBig(rows: number): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE big_a (k INTEGER, v INTEGER)')
  e.execute('CREATE TABLE big_b (k INTEGER, w INTEGER)')
  const gen = `WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${rows})`
  e.execute(`INSERT INTO big_a (k, v) ${gen} SELECT n, n * 2 FROM s`)
  e.execute(`INSERT INTO big_b (k, w) ${gen} SELECT n, n * 3 FROM s`)
  return e
}
test('join', 'sort–merge join chosen for large, balanced inputs', () => {
  const e = withBig(600)
  const r = e.execute('EXPLAIN SELECT * FROM big_a a JOIN big_b b ON a.k = b.k')[0]
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('MergeJoin'), 'planner should pick a MergeJoin for two 600-row equijoin inputs')
})
test('join', 'merge join produces the correct result', () => {
  const e = withBig(600)
  assert(scalar(e, 'SELECT COUNT(*) FROM big_a a JOIN big_b b ON a.k = b.k') === 600, 'merge join count wrong')
  assert(scalar(e, 'SELECT SUM(b.w) FROM big_a a JOIN big_b b ON a.k = b.k WHERE a.k <= 3') === 18, '3*(1+2+3)=18')
})
test('join', 'merge join with an unmatched LEFT side null-extends', () => {
  const e = new Engine()
  e.execute('CREATE TABLE l (k INTEGER); CREATE TABLE r (k INTEGER)')
  e.execute('INSERT INTO l (k) VALUES (1), (2), (3)')
  e.execute('INSERT INTO r (k) VALUES (2), (2), (4)')
  // Force the merge-join path regardless of size by calling the operator via a
  // plain equijoin; correctness must match the hash-join semantics.
  const rows = rowsOf(e, 'SELECT l.k, r.k FROM l LEFT JOIN r ON l.k = r.k ORDER BY l.k, r.k')
  // 1→null, 2→{2,2}, 3→null  ⇒ 4 rows, two of them null on the right.
  assert(rows.length === 4, `expected 4 rows, got ${rows.length}`)
  assert(rows.filter((x) => x[1] === null).length === 2, 'unmatched lefts should null-extend')
})
test('sort', 'external merge sort kicks in past the run size', () => {
  const e = new Engine()
  e.execute('CREATE TABLE big_c (k INTEGER)')
  e.execute('INSERT INTO big_c (k) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 1500) SELECT 1501 - n FROM s')
  const r = e.execute('EXPLAIN SELECT k FROM big_c ORDER BY k')[0]
  const text = JSON.stringify(r.kind === 'explain' ? r.plan : {})
  assert(text.includes('external merge sort'), 'a 1500-row sort should spill to external merge sort')
  const rows = rowsOf(e, 'SELECT k FROM big_c ORDER BY k LIMIT 3')
  assert(eq(rows.map((x) => x[0]), [1, 2, 3]), 'external sort produced the wrong order')
})

// --- window frames ----------------------------------------------------------
test('window', 'ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING (sliding sum)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE w (v INTEGER)')
  e.execute('INSERT INTO w (v) VALUES (1), (2), (3), (4), (5)')
  const rows = rowsOf(e, 'SELECT v, SUM(v) OVER (ORDER BY v ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS s FROM w ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [3, 6, 9, 12, 9]), 'sliding window sum wrong')
})
test('window', 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW (running sum)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE w (v INTEGER)')
  e.execute('INSERT INTO w (v) VALUES (1), (2), (3), (4)')
  const rows = rowsOf(e, 'SELECT v, SUM(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM w ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [1, 3, 6, 10]), 'running sum via explicit frame wrong')
})
test('window', 'LAST_VALUE over the whole partition with an explicit frame', () => {
  const e = new Engine()
  e.execute('CREATE TABLE w (v INTEGER)')
  e.execute('INSERT INTO w (v) VALUES (5), (8), (3)')
  const rows = rowsOf(
    e,
    'SELECT v, LAST_VALUE(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS l FROM w ORDER BY v',
  )
  assert(rows.every((r) => r[1] === 8), 'LAST_VALUE over the full frame should be the max (8)')
})
test('window', 'RANGE CURRENT ROW groups peers', () => {
  const e = new Engine()
  e.execute('CREATE TABLE w2 (v INTEGER)')
  e.execute('INSERT INTO w2 (v) VALUES (1), (1), (2), (3)')
  const rows = rowsOf(e, 'SELECT v, SUM(v) OVER (ORDER BY v RANGE BETWEEN CURRENT ROW AND CURRENT ROW) AS s FROM w2 ORDER BY v')
  assert(eq(rows.map((r) => r[1]), [2, 2, 2, 3]), 'RANGE CURRENT ROW should sum peers')
})

// --- v10.0: window functions, to the standard ------------------------------
// A shared fixture: one partition of five values with a tie (20, 20).
function wf(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE wf (x INTEGER)')
  e.execute('INSERT INTO wf (x) VALUES (10), (20), (20), (30), (40)')
  return e
}
const col = (rows: Row[], i = 1) => rows.map((r) => r[i])

test('window-frame', 'GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING counts peer groups', () => {
  const rows = rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM wf ORDER BY x')
  assert(eq(col(rows), [50, 80, 80, 110, 70]), `GROUPS sliding sum wrong: ${JSON.stringify(col(rows))}`)
})
test('window-frame', 'GROUPS differs from ROWS across a tie', () => {
  // ROWS counts physical rows; over the (20, 20) tie the two windows differ.
  const g = col(rowsOf(wf(), 'SELECT x, COUNT(*) OVER (ORDER BY x GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM wf ORDER BY x'))
  const r = col(rowsOf(wf(), 'SELECT x, COUNT(*) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM wf ORDER BY x'))
  assert(eq(g, [1, 3, 3, 3, 2]), `GROUPS count wrong: ${JSON.stringify(g)}`)
  assert(eq(r, [1, 2, 2, 2, 2]), `ROWS count wrong: ${JSON.stringify(r)}`)
})
test('window-frame', 'EXCLUDE CURRENT ROW removes self from a full frame', () => {
  const rows = rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE CURRENT ROW) FROM wf ORDER BY x')
  assert(eq(col(rows), [110, 100, 100, 90, 80]), `EXCLUDE CURRENT ROW wrong: ${JSON.stringify(col(rows))}`)
})
test('window-frame', 'EXCLUDE GROUP removes the whole peer group', () => {
  const rows = rowsOf(wf(), 'SELECT x, COUNT(*) OVER (ORDER BY x GROUPS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE GROUP) FROM wf ORDER BY x')
  assert(eq(col(rows), [4, 3, 3, 4, 4]), `EXCLUDE GROUP wrong: ${JSON.stringify(col(rows))}`)
})
test('window-frame', 'EXCLUDE TIES keeps the current row but drops its peers', () => {
  const rows = rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE TIES) FROM wf ORDER BY x')
  assert(eq(col(rows), [120, 100, 100, 120, 120]), `EXCLUDE TIES wrong: ${JSON.stringify(col(rows))}`)
})
test('window-frame', 'EXCLUDE NO OTHERS is the default (no change)', () => {
  const a = col(rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM wf ORDER BY x'))
  const b = col(rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE NO OTHERS) FROM wf ORDER BY x'))
  assert(eq(a, b) && eq(a, [120, 120, 120, 120, 120]), 'EXCLUDE NO OTHERS should equal the unexcluded frame')
})
test('window-frame', 'RANGE numeric offset frames by value, not row count', () => {
  const rows = rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING) FROM wf ORDER BY x')
  assert(eq(col(rows), [50, 80, 80, 110, 70]), `RANGE numeric wrong: ${JSON.stringify(col(rows))}`)
})
test('window-frame', 'default frame equals an explicit RANGE running frame', () => {
  const dflt = col(rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x) FROM wf ORDER BY x'))
  const expl = col(rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM wf ORDER BY x'))
  assert(eq(dflt, expl) && eq(dflt, [10, 50, 50, 80, 120]), 'default frame must be RANGE UNBOUNDED PRECEDING .. CURRENT ROW')
})
test('window-frame', 'RANGE keeps DECIMAL money exact', () => {
  const e = new Engine()
  e.execute('CREATE TABLE m (amt DECIMAL(10,2))')
  e.execute("INSERT INTO m (amt) VALUES (10.00), (20.00), (30.00), (40.00)")
  const rows = rowsOf(e, 'SELECT amt, SUM(amt) OVER (ORDER BY amt RANGE BETWEEN 15.00 PRECEDING AND CURRENT ROW) FROM m ORDER BY amt')
  assert(eq(rows.map((r) => formatValue(r[1])), ['10.00', '30.00', '50.00', '70.00']), `RANGE decimal wrong: ${JSON.stringify(rows.map((r) => formatValue(r[1])))}`)
})
test('window-frame', 'RANGE over DATE uses an INTERVAL offset', () => {
  const e = new Engine()
  e.execute('CREATE TABLE d (dt DATE, amt INTEGER)')
  e.execute("INSERT INTO d (dt, amt) VALUES ('2024-01-01', 10), ('2024-01-03', 20), ('2024-01-08', 30), ('2024-01-09', 40)")
  const rows = rowsOf(e, "SELECT dt, SUM(amt) OVER (ORDER BY dt RANGE BETWEEN INTERVAL '2 days' PRECEDING AND CURRENT ROW) FROM d ORDER BY dt")
  assert(eq(col(rows), [10, 30, 30, 70]), `RANGE date/interval wrong: ${JSON.stringify(col(rows))}`)
})
test('window-frame', 'RANGE honours DESC ordering direction', () => {
  const rows = rowsOf(wf(), 'SELECT x, SUM(x) OVER (ORDER BY x DESC RANGE BETWEEN 10 PRECEDING AND CURRENT ROW) FROM wf ORDER BY x DESC')
  // Descending: "preceding" is the larger neighbour. 40→{40}, 30→{40,30}, 20→{30,20,20}, 10→{20,20,10}.
  assert(eq(col(rows), [40, 70, 70, 70, 50]), `RANGE DESC wrong: ${JSON.stringify(col(rows))}`)
})
test('window-clause', 'WINDOW clause defines a named window', () => {
  const rows = rowsOf(wf(), 'SELECT x, SUM(x) OVER w, AVG(x) OVER w FROM wf WINDOW w AS (ORDER BY x) ORDER BY x')
  assert(eq(col(rows, 1), [10, 50, 50, 80, 120]), 'named-window running sum wrong')
  assert(rows.length === 5, 'two functions can share one named window')
})
test('window-clause', 'a window may inherit a base and add a frame', () => {
  const rows = rowsOf(wf(), 'SELECT x, SUM(x) OVER (w ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM wf WINDOW w AS (ORDER BY x) ORDER BY x')
  assert(eq(col(rows), [10, 30, 40, 50, 70]), `inherited-base frame wrong: ${JSON.stringify(col(rows))}`)
})
test('window-clause', 'overriding a referenced window PARTITION BY is rejected', () => {
  throws(wf(), 'SELECT SUM(x) OVER (w PARTITION BY x) FROM wf WINDOW w AS (ORDER BY x)', 'PARTITION BY')
})
test('window-clause', 'a missing named window is an error', () => {
  throws(wf(), 'SELECT SUM(x) OVER nope FROM wf', 'does not exist')
})
test('window-clause', 'circular window references are rejected', () => {
  throws(wf(), 'SELECT SUM(x) OVER a FROM wf WINDOW a AS (b), b AS (a)', 'circular')
})
test('window-oset', 'PERCENTILE_CONT window matches the GROUP BY aggregate per partition', () => {
  const e = new Engine()
  e.execute('CREATE TABLE p (g TEXT, x INTEGER)')
  e.execute("INSERT INTO p (g, x) VALUES ('a',1),('a',2),('a',3),('a',4),('b',10),('b',30)")
  const win = rowsOf(e, 'SELECT DISTINCT g, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) OVER (PARTITION BY g) FROM p ORDER BY g')
  const grp = rowsOf(e, 'SELECT g, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) FROM p GROUP BY g ORDER BY g')
  assert(eq(win, grp), `window vs group-by percentile differ: ${JSON.stringify(win)} vs ${JSON.stringify(grp)}`)
  assert(eq(col(grp), [2.5, 20]), `median wrong: ${JSON.stringify(col(grp))}`)
})
test('window-oset', 'PERCENTILE_DISC and MODE as window functions', () => {
  const d = scalar(wf(), 'SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY x) OVER () FROM wf LIMIT 1')
  const m = scalar(wf(), 'SELECT MODE() WITHIN GROUP (ORDER BY x) OVER () FROM wf LIMIT 1')
  assert(d === 20, `PERCENTILE_DISC window wrong: ${d}`)
  assert(m === 20, `MODE window wrong: ${m}`)
})
test('window-oset', 'an ordered-set window without WITHIN GROUP is rejected', () => {
  throws(wf(), 'SELECT PERCENTILE_CONT(0.5) OVER () FROM wf', 'WITHIN GROUP')
})
test('window-oset', 'STDDEV_POP / VAR_POP windows match the aggregate', () => {
  const e = new Engine()
  e.execute('CREATE TABLE s (x INTEGER)')
  e.execute('INSERT INTO s (x) VALUES (2), (4), (4), (4), (5), (5), (7), (9)')
  const w = scalar(e, 'SELECT STDDEV_POP(x) OVER () FROM s LIMIT 1') as number
  const a = scalar(e, 'SELECT STDDEV_POP(x) FROM s') as number
  assert(Math.abs(w - a) < 1e-9 && Math.abs(w - 2) < 1e-9, `STDDEV_POP window=${w} agg=${a} (expected 2)`)
})
test('window-nulls', 'FIRST_VALUE / LAST_VALUE IGNORE NULLS skip nulls in the frame', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (id INTEGER, v INTEGER)')
  e.execute('INSERT INTO n (id, v) VALUES (1,NULL),(2,5),(3,NULL),(4,7),(5,NULL)')
  const first = rowsOf(e, 'SELECT id, FIRST_VALUE(v) IGNORE NULLS OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM n ORDER BY id')
  assert(eq(col(first), [null, 5, 5, 5, 5]), `FIRST_VALUE IGNORE NULLS wrong: ${JSON.stringify(col(first))}`)
  const last = rowsOf(e, 'SELECT id, LAST_VALUE(v) IGNORE NULLS OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM n ORDER BY id')
  assert(eq(col(last), [null, 5, 5, 7, 7]), `LAST_VALUE IGNORE NULLS wrong: ${JSON.stringify(col(last))}`)
})
test('window-nulls', 'LAG IGNORE NULLS walks past nulls', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (id INTEGER, v INTEGER)')
  e.execute('INSERT INTO n (id, v) VALUES (1,NULL),(2,5),(3,NULL),(4,7),(5,NULL)')
  const rows = rowsOf(e, 'SELECT id, LAG(v) IGNORE NULLS OVER (ORDER BY id) FROM n ORDER BY id')
  assert(eq(col(rows), [null, null, 5, 5, 7]), `LAG IGNORE NULLS wrong: ${JSON.stringify(col(rows))}`)
})
test('window-nulls', 'RESPECT NULLS is the default for value functions', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (id INTEGER, v INTEGER)')
  e.execute('INSERT INTO n (id, v) VALUES (1,NULL),(2,5),(3,NULL)')
  const a = col(rowsOf(e, 'SELECT id, LAG(v) OVER (ORDER BY id) FROM n ORDER BY id'))
  const b = col(rowsOf(e, 'SELECT id, LAG(v) RESPECT NULLS OVER (ORDER BY id) FROM n ORDER BY id'))
  assert(eq(a, b) && eq(a, [null, null, 5]), 'RESPECT NULLS should match the default')
})
test('window-filter', 'FILTER (WHERE …) restricts the rows a window aggregate sees', () => {
  const rows = rowsOf(wf(), 'SELECT x, COUNT(*) FILTER (WHERE x >= 20) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM wf ORDER BY x')
  assert(eq(col(rows), [0, 1, 2, 3, 4]), `window FILTER wrong: ${JSON.stringify(col(rows))}`)
})
function qf(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE q (cat TEXT, name TEXT, price INTEGER)')
  e.execute("INSERT INTO q (cat, name, price) VALUES ('a','a1',10),('a','a2',30),('a','a3',20),('b','b1',5),('b','b2',50)")
  return e
}
test('qualify', 'QUALIFY filters on a window function (top-1 per partition)', () => {
  const rows = rowsOf(qf(), 'SELECT cat, name FROM q QUALIFY ROW_NUMBER() OVER (PARTITION BY cat ORDER BY price DESC) = 1 ORDER BY cat')
  assert(eq(rows, [['a', 'a2'], ['b', 'b2']]), `QUALIFY top-1 wrong: ${JSON.stringify(rows)}`)
})
test('qualify', 'QUALIFY can reference an aggregate window', () => {
  const rows = rowsOf(qf(), 'SELECT name FROM q QUALIFY price > AVG(price) OVER () ORDER BY name')
  // overall average is 23 → only the 30 and 50 rows survive.
  assert(eq(rows.map((r) => r[0]), ['a2', 'b2']), `QUALIFY vs avg wrong: ${JSON.stringify(rows.map((r) => r[0]))}`)
})
test('qualify', 'QUALIFY runs before DISTINCT / ORDER BY / LIMIT', () => {
  const rows = rowsOf(qf(), 'SELECT cat FROM q QUALIFY ROW_NUMBER() OVER (PARTITION BY cat ORDER BY price) <= 2 ORDER BY cat')
  // a keeps its two cheapest, b keeps both → 2 + 2 rows.
  assert(rows.length === 4 && eq(rows.map((r) => r[0]), ['a', 'a', 'b', 'b']), `QUALIFY count wrong: ${JSON.stringify(rows.map((r) => r[0]))}`)
})

// --- set-operation type unification -----------------------------------------
test('setop', 'UNION unifies INTEGER + REAL to REAL', () => {
  const e = new Engine()
  const r = lastResult(e, 'SELECT 1 AS x UNION ALL SELECT 2.5') as RowsResult
  assert(r.kind === 'rows' && r.columns[0].type === 'REAL', 'mixed int/real column should report REAL')
})
test('setop', 'UNION unifies anything + TEXT to TEXT', () => {
  const e = new Engine()
  const r = lastResult(e, "SELECT 1 AS x UNION ALL SELECT 'two'") as RowsResult
  assert(r.kind === 'rows' && r.columns[0].type === 'TEXT', 'mixed int/text column should report TEXT')
})

// --- new aggregates ---------------------------------------------------------
test('agg', 'VAR_POP / STDDEV_POP', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (x INTEGER)')
  e.execute('INSERT INTO n (x) VALUES (2), (4), (4), (4), (5), (5), (7), (9)')
  assert(scalar(e, 'SELECT VAR_POP(x) FROM n') === 4, 'population variance should be 4')
  assert(scalar(e, 'SELECT STDDEV_POP(x) FROM n') === 2, 'population stddev should be 2')
  assert(Math.abs((scalar(e, 'SELECT VAR_SAMP(x) FROM n') as number) - 32 / 7) < 1e-9, 'sample variance wrong')
})
test('agg', 'MEDIAN (even and odd counts)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (x INTEGER)')
  e.execute('INSERT INTO n (x) VALUES (2), (4), (4), (4), (5), (5), (7), (9)')
  assert(scalar(e, 'SELECT MEDIAN(x) FROM n') === 4.5, 'median of 8 values should be 4.5')
  e.execute('INSERT INTO n (x) VALUES (100)')
  assert(scalar(e, 'SELECT MEDIAN(x) FROM n') === 5, 'median of 9 values should be the middle one')
})
test('agg', 'STRING_AGG / GROUP_CONCAT (incl. DISTINCT)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (x INTEGER)')
  e.execute('INSERT INTO n (x) VALUES (2), (4), (4), (5)')
  assert(scalar(e, 'SELECT GROUP_CONCAT(x) FROM n') === '2,4,4,5', 'GROUP_CONCAT default comma join wrong')
  assert(scalar(e, "SELECT STRING_AGG(x, '-') FROM n") === '2-4-4-5', 'STRING_AGG custom separator wrong')
  assert(scalar(e, 'SELECT GROUP_CONCAT(DISTINCT x) FROM n') === '2,4,5', 'GROUP_CONCAT DISTINCT wrong')
})
test('agg', 'aggregates group correctly', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    'SELECT category, COUNT(*) AS n, GROUP_CONCAT(name) AS names FROM products GROUP BY category ORDER BY category',
  )
  const audio = rows.find((r) => r[0] === 'Audio')
  assert(!!audio && audio[1] === 2, 'Audio should have 2 products')
  assert(typeof audio![2] === 'string' && (audio![2] as string).includes(','), 'GROUP_CONCAT should join names')
})

// --- ordered-set aggregates (WITHIN GROUP) ----------------------------------
test('agg', 'PERCENTILE_CONT interpolates', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (x INTEGER)')
  e.execute('INSERT INTO n (x) VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10)')
  assert(scalar(e, 'SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) FROM n') === 5.5, 'median (cont) of 1..10 should be 5.5')
  assert(
    Math.abs((scalar(e, 'SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY x) FROM n') as number) - 9.1) < 1e-9,
    'p90 (cont) of 1..10 should interpolate to 9.1',
  )
  assert(scalar(e, 'SELECT PERCENTILE_CONT(0) WITHIN GROUP (ORDER BY x) FROM n') === 1, 'p0 should be the min')
  assert(scalar(e, 'SELECT PERCENTILE_CONT(1) WITHIN GROUP (ORDER BY x) FROM n') === 10, 'p100 should be the max')
})
test('agg', 'PERCENTILE_DISC picks an actual value (any type)', () => {
  const e = new Engine()
  e.execute('CREATE TABLE n (x INTEGER, s TEXT)')
  e.execute("INSERT INTO n (x, s) VALUES (1, 'a'), (2, 'a'), (3, 'b'), (4, 'b'), (5, 'c')")
  assert(scalar(e, 'SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY x) FROM n') === 3, 'disc median of 1..5 should be 3')
  assert(scalar(e, 'SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY s) FROM n') === 'b', 'disc median over text should pick a real string')
})
test('agg', 'MODE returns the most frequent value', () => {
  const e = new Engine()
  e.execute('CREATE TABLE g (cat TEXT, v INTEGER)')
  e.execute("INSERT INTO g (cat, v) VALUES ('a', 1), ('a', 1), ('a', 2), ('b', 5), ('b', 6), ('b', 6)")
  const rows = rowsOf(e, 'SELECT cat, MODE() WITHIN GROUP (ORDER BY v) AS m FROM g GROUP BY cat ORDER BY cat')
  assert(eq(rows.map((r) => r[1]), [1, 6]), 'MODE per group wrong')
})
test('agg', 'ordered-set aggregate with DESC + GROUP BY', () => {
  const e = seeded()
  // Median product price per category (continuous).
  const rows = rowsOf(
    e,
    'SELECT category, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS med FROM products GROUP BY category ORDER BY category',
  )
  const audio = rows.find((r) => r[0] === 'Audio')!
  // Audio = {149.5, 199.5}? median is their average.
  assert(typeof audio[1] === 'number', 'median price should be numeric')
})

// --- grouping sets / rollup / cube ------------------------------------------
function salesEngine(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE sales (region TEXT, product TEXT, amount INTEGER)')
  e.execute(
    "INSERT INTO sales (region, product, amount) VALUES ('N','A',10),('N','B',20),('S','A',30),('S','B',40),('N','A',5)",
  )
  return e
}
test('grouping', 'ROLLUP produces hierarchical subtotals + grand total', () => {
  const e = salesEngine()
  const rows = rowsOf(
    e,
    'SELECT region, product, SUM(amount) AS s FROM sales GROUP BY ROLLUP(region, product) ORDER BY region, product',
  )
  // grand total + 2 region subtotals + 4 detail = 7 rows
  assert(rows.length === 7, `ROLLUP should yield 7 rows, got ${rows.length}`)
  const grand = rows.find((r) => r[0] === null && r[1] === null)!
  assert(grand[2] === 105, `grand total should be 105, got ${grand[2]}`)
  const north = rows.find((r) => r[0] === 'N' && r[1] === null)!
  assert(north[2] === 35, `north subtotal should be 35, got ${north[2]}`)
})
test('grouping', 'CUBE adds every dimension combination', () => {
  const e = salesEngine()
  const rows = rowsOf(e, 'SELECT region, product, SUM(amount) AS s FROM sales GROUP BY CUBE(region, product)')
  // grand + 2 region + 2 product + 4 detail = 9 rows
  assert(rows.length === 9, `CUBE should yield 9 rows, got ${rows.length}`)
  const prodA = rows.find((r) => r[0] === null && r[1] === 'A')!
  assert(prodA[2] === 45, `product A across regions should be 45, got ${prodA[2]}`)
})
test('grouping', 'explicit GROUPING SETS', () => {
  const e = salesEngine()
  const rows = rowsOf(
    e,
    'SELECT region, SUM(amount) AS s FROM sales GROUP BY GROUPING SETS ((region), ()) ORDER BY region',
  )
  assert(rows.length === 3, `two-set grouping should yield 3 rows, got ${rows.length}`)
  assert(rows.some((r) => r[0] === null && r[1] === 105), 'grand-total set missing')
})
test('grouping', 'GROUPING() flags rolled-up columns', () => {
  const e = salesEngine()
  const rows = rowsOf(
    e,
    `SELECT region, product, GROUPING(region) AS gr, GROUPING(product) AS gp,
            GROUPING(region, product) AS g2, SUM(amount) AS s
     FROM sales GROUP BY ROLLUP(region, product) ORDER BY g2, region, product`,
  )
  const detail = rows.find((r) => r[0] === 'N' && r[1] === 'A')!
  assert(detail[2] === 0 && detail[3] === 0 && detail[4] === 0, 'detail rows should have all GROUPING bits clear')
  const sub = rows.find((r) => r[0] === 'N' && r[1] === null)!
  assert(sub[2] === 0 && sub[3] === 1 && sub[4] === 1, 'region subtotal: product is rolled up (bit set)')
  const grand = rows.find((r) => r[2] === 1 && r[3] === 1)!
  assert(grand[4] === 3, 'grand total GROUPING(region,product) should be binary 11 = 3')
})
test('grouping', 'HAVING can filter on GROUPING()', () => {
  const e = salesEngine()
  // Keep only the per-region subtotals (product rolled up, region present).
  const rows = rowsOf(
    e,
    `SELECT region, SUM(amount) AS s FROM sales GROUP BY ROLLUP(region, product)
     HAVING GROUPING(product) = 1 AND GROUPING(region) = 0 ORDER BY region`,
  )
  assert(eq(rows.map((r) => r[0]), ['N', 'S']), 'should keep exactly the two region subtotals')
})

// --- aggregate FILTER -------------------------------------------------------
test('agg', 'aggregate FILTER (WHERE …)', () => {
  const e = seeded()
  const rows = rowsOf(e, "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE country = 'UK') AS uk FROM customers")
  assert(rows[0][0] === 8 && rows[0][1] === 3, `expected 8 total / 3 UK, got ${rows[0]}`)
})
test('agg', 'FILTER combines with GROUP BY', () => {
  const e = seeded()
  const rows = rowsOf(
    e,
    'SELECT category, COUNT(*) AS n, SUM(price) FILTER (WHERE price > 200) AS big FROM products GROUP BY category ORDER BY category',
  )
  const hw = rows.find((r) => r[0] === 'Hardware')!
  assert(hw[1] === 3 && hw[2] === 549.5, `Hardware filtered sum wrong: ${hw}`)
})

// --- CSV import -------------------------------------------------------------
test('csv', 'parses quotes, commas and embedded newlines', () => {
  const m = parseCsv('a,b\n"x,y","line1\nline2"\n1,2')
  assert(m.length === 3, `expected 3 rows, got ${m.length}`)
  assert(m[1][0] === 'x,y', 'quoted comma not handled')
  assert(m[1][1] === 'line1\nline2', 'embedded newline not handled')
})
test('csv', 'infers types and round-trips through the engine', () => {
  const csv = 'city,pop,coastal\nTokyo,37400068,false\nReykjavik,131000,true'
  const r = csvToSql(csv, { tableName: 'cities', hasHeader: true })
  assert(eq(r.columns.map((c) => c.type), ['TEXT', 'INTEGER', 'BOOLEAN']), `bad inferred types: ${r.columns.map((c) => c.type)}`)
  const e = new Engine()
  e.execute(r.sql)
  assert(scalar(e, 'SELECT COUNT(*) FROM cities') === 2, 'import row count wrong')
  assert(scalar(e, 'SELECT SUM(pop) FROM cities') === 37531068, 'numeric import lost precision')
  assert(scalar(e, 'SELECT COUNT(*) FROM cities WHERE coastal = TRUE') === 1, 'boolean import wrong')
})
test('csv', 'headerless import generates colN names', () => {
  const r = csvToSql('1,2\n3,4', { tableName: 't', hasHeader: false })
  assert(eq(r.columns.map((c) => c.name), ['col1', 'col2']), 'headerless column names wrong')
  assert(r.rowCount === 2, 'headerless row count wrong')
})

// --- temporal types: DATE / TIME / TIMESTAMP / INTERVAL ---------------------
// `fv` renders a scalar result through the engine's canonical formatter, so a
// first-class temporal value is checked by its textual form.
function fv(e: Engine, sql: string): string {
  return formatValue(scalar(e, sql))
}

test('temporal', 'typed literals parse and render canonically', () => {
  const e = new Engine()
  assert(fv(e, "SELECT DATE '2026-06-15'") === '2026-06-15', 'DATE literal')
  assert(fv(e, "SELECT TIMESTAMP '2026-06-15 13:45:30'") === '2026-06-15 13:45:30', 'TIMESTAMP literal')
  assert(fv(e, "SELECT TIME '13:45:30'") === '13:45:30', 'TIME literal')
  assert(fv(e, "SELECT TIME '09:05'") === '09:05:00', 'TIME without seconds')
  assert(fv(e, "SELECT TIMESTAMP '2026-06-15 13:45:30.250'") === '2026-06-15 13:45:30.250', 'sub-second TIMESTAMP')
})
test('temporal', 'interval literals: phrases and clock segments', () => {
  const e = new Engine()
  assert(fv(e, "SELECT INTERVAL '1 year 2 months 3 days'") === '1 year 2 mons 3 days', 'phrase interval')
  assert(fv(e, "SELECT INTERVAL '90 minutes'") === '01:30:00', 'minutes fold into clock')
  assert(fv(e, "SELECT INTERVAL '2 weeks'") === '14 days', 'weeks fold into days')
  assert(fv(e, "SELECT INTERVAL '1 day 04:05:06'") === '1 day 04:05:06', 'mixed day + clock')
  assert(fv(e, "SELECT INTERVAL '-3 days'") === '-3 days', 'negative interval')
})
test('temporal', 'invalid temporal literal is a parse error', () => {
  const e = new Engine()
  let threw = false
  try {
    e.execute("SELECT DATE 'not-a-date'")
  } catch {
    threw = true
  }
  assert(threw, 'bad DATE literal should throw')
})
test('temporal', 'date ± interval follows Postgres (yields timestamp)', () => {
  const e = new Engine()
  assert(fv(e, "SELECT DATE '2026-06-15' + INTERVAL '1 day'") === '2026-06-16 00:00:00', 'date + 1 day')
  assert(fv(e, "SELECT DATE '2026-06-15' - INTERVAL '1 day'") === '2026-06-14 00:00:00', 'date - 1 day')
})
test('temporal', 'month arithmetic clamps the day-of-month', () => {
  const e = new Engine()
  assert(fv(e, "SELECT DATE '2026-01-31' + INTERVAL '1 month'") === '2026-02-28 00:00:00', 'Jan 31 + 1 month → Feb 28')
  assert(fv(e, "SELECT DATE '2024-01-31' + INTERVAL '1 month'") === '2024-02-29 00:00:00', 'leap year → Feb 29')
})
test('temporal', 'date + integer shifts whole days (stays a date)', () => {
  const e = new Engine()
  assert(fv(e, "SELECT DATE '2026-06-15' + 10") === '2026-06-25', 'date + 10')
  assert(fv(e, "SELECT DATE '2026-06-15' - 20") === '2026-05-26', 'date - 20')
})
test('temporal', 'differences: date−date, timestamp−timestamp, time−time', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT DATE '2026-12-31' - DATE '2026-01-01'") === 364, 'date − date → int days')
  assert(fv(e, "SELECT TIMESTAMP '2026-06-15 12:00:00' - TIMESTAMP '2026-06-14 10:00:00'") === '1 day 02:00:00', 'ts − ts → interval')
  assert(fv(e, "SELECT TIME '10:00:00' - TIME '08:30:00'") === '01:30:00', 'time − time → interval')
})
test('temporal', 'interval algebra: add, scale, negate', () => {
  const e = new Engine()
  assert(fv(e, "SELECT INTERVAL '1 day' + INTERVAL '2 days'") === '3 days', 'interval + interval')
  assert(fv(e, "SELECT INTERVAL '1 day' * 3") === '3 days', 'interval * number')
  assert(fv(e, "SELECT 2 * INTERVAL '90 minutes'") === '03:00:00', 'number * interval')
  assert(fv(e, "SELECT -INTERVAL '5 days'") === '-5 days', 'unary minus on interval')
})
test('temporal', 'timestamp ± interval keeps a timestamp', () => {
  const e = new Engine()
  assert(fv(e, "SELECT TIMESTAMP '2026-06-15 13:00:00' - INTERVAL '2 hours'") === '2026-06-15 11:00:00', 'ts - 2h')
  assert(fv(e, "SELECT TIMESTAMP '2026-06-15 23:30:00' + INTERVAL '1 hour'") === '2026-06-16 00:30:00', 'ts crosses midnight')
})
test('temporal', 'EXTRACT (FROM syntax) reads calendar fields', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT EXTRACT(YEAR FROM DATE '2026-06-15')") === 2026, 'extract year')
  assert(scalar(e, "SELECT EXTRACT(MONTH FROM TIMESTAMP '2026-06-15 13:45:30')") === 6, 'extract month')
  assert(scalar(e, "SELECT EXTRACT(DOW FROM DATE '2026-06-15')") === 1, '2026-06-15 is a Monday (dow=1)')
  assert(scalar(e, "SELECT EXTRACT(QUARTER FROM DATE '2026-06-15')") === 2, 'Q2')
  assert(scalar(e, "SELECT EXTRACT(HOUR FROM TIME '13:45:30')") === 13, 'extract hour from time')
})
test('temporal', 'EXTRACT works on intervals', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT EXTRACT(DAY FROM INTERVAL '1 year 2 months 10 days')") === 10, 'interval day field')
  assert(scalar(e, "SELECT EXTRACT(YEAR FROM INTERVAL '14 months')") === 1, '14 months → 1 year')
  assert(scalar(e, "SELECT EXTRACT(MONTH FROM INTERVAL '14 months')") === 2, '14 months → 2 months remainder')
})
test('temporal', 'DATE_TRUNC zeroes finer fields', () => {
  const e = new Engine()
  assert(fv(e, "SELECT DATE_TRUNC('month', TIMESTAMP '2026-06-15 13:45:30')") === '2026-06-01 00:00:00', 'trunc month')
  assert(fv(e, "SELECT DATE_TRUNC('year', TIMESTAMP '2026-06-15 13:45:30')") === '2026-01-01 00:00:00', 'trunc year')
  assert(fv(e, "SELECT DATE_TRUNC('hour', TIMESTAMP '2026-06-15 13:45:30')") === '2026-06-15 13:00:00', 'trunc hour')
  // Monday-anchored week: 2026-06-15 is a Monday, so the week starts the same day.
  assert(fv(e, "SELECT DATE_TRUNC('week', TIMESTAMP '2026-06-17 09:00:00')") === '2026-06-15 00:00:00', 'trunc week to Monday')
})
test('temporal', 'AGE computes a calendar interval', () => {
  const e = new Engine()
  assert(fv(e, "SELECT AGE(DATE '2026-06-15', DATE '2000-01-01')") === '26 years 5 mons 14 days', 'age years/months/days')
  assert(fv(e, "SELECT AGE(DATE '2026-03-01', DATE '2026-02-28')") === '1 day', 'one-day age')
})
test('temporal', 'MAKE_* constructors', () => {
  const e = new Engine()
  assert(fv(e, 'SELECT MAKE_DATE(2026, 6, 15)') === '2026-06-15', 'make_date')
  assert(fv(e, 'SELECT MAKE_TIME(13, 45, 30)') === '13:45:30', 'make_time')
  assert(fv(e, 'SELECT MAKE_TIMESTAMP(2026, 6, 15, 13, 45, 30)') === '2026-06-15 13:45:30', 'make_timestamp')
  assert(fv(e, 'SELECT MAKE_INTERVAL(1, 2, 3, 4, 5, 6)') === '1 year 2 mons 3 days 04:05:06', 'make_interval')
})
test('temporal', 'CAST between temporal types and text', () => {
  const e = new Engine()
  assert(fv(e, "SELECT CAST('2026-06-15' AS DATE) + INTERVAL '1 month'") === '2026-07-15 00:00:00', 'text→date then arith')
  assert(fv(e, "SELECT CAST(DATE '2026-06-15' AS TIMESTAMP)") === '2026-06-15 00:00:00', 'date→timestamp')
  assert(fv(e, "SELECT CAST(TIMESTAMP '2026-06-15 13:45:30' AS DATE)") === '2026-06-15', 'timestamp→date')
  assert(scalar(e, "SELECT CAST(DATE '2026-06-15' AS TEXT)") === '2026-06-15', 'date→text')
})
test('temporal', 'comparison coerces a string counterpart', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT DATE '2026-06-15' = '2026-06-15'") === true, 'date = matching string')
  assert(scalar(e, "SELECT DATE '2026-06-15' < DATE '2026-06-16'") === true, 'date ordering')
  assert(scalar(e, "SELECT DATE '2026-06-15' BETWEEN '2026-01-01' AND '2026-12-31'") === true, 'date BETWEEN strings')
  assert(scalar(e, "SELECT TIMESTAMP '2026-06-15 00:00:00' = DATE '2026-06-15'") === true, 'date/timestamp cross-compare')
})
test('temporal', 'date columns: ORDER BY, GROUP BY and DISTINCT', () => {
  const e = new Engine()
  e.execute("CREATE TABLE evt (id INTEGER, at TIMESTAMP)")
  e.execute("INSERT INTO evt VALUES (1,'2026-06-15 10:00:00'),(2,'2026-06-14 09:00:00'),(3,'2026-06-15 23:00:00')")
  assert(eq(rowsOf(e, 'SELECT id FROM evt ORDER BY at').map((r) => r[0]), [2, 1, 3]), 'ORDER BY timestamp')
  const g = rowsOf(e, "SELECT DATE_TRUNC('day', at) d, COUNT(*) FROM evt GROUP BY DATE_TRUNC('day', at) ORDER BY d")
  assert(g.length === 2 && g[1][1] === 2, 'GROUP BY truncated day')
  assert(scalar(e, 'SELECT COUNT(DISTINCT at) FROM evt') === 3, 'DISTINCT timestamps')
})
test('temporal', 'a date column drives an index scan', () => {
  const e = new Engine()
  e.execute('CREATE TABLE bk (id INTEGER, day DATE)')
  const rows = Array.from({ length: 20 }, (_, i) => `(${i}, DATE '2026-01-01' + ${i})`).join(',')
  e.execute('INSERT INTO bk VALUES ' + rows)
  e.execute('CREATE INDEX idx_bk ON bk(day)')
  e.execute('ANALYZE bk')
  const plan = lastResult(e, "EXPLAIN SELECT id FROM bk WHERE day = DATE '2026-01-10'")
  const json = JSON.stringify(plan)
  assert(json.includes('IndexScan'), 'date equality should use the index')
  assert(scalar(e, "SELECT id FROM bk WHERE day = DATE '2026-01-10'") === 9, 'index lookup result')
  assert(scalar(e, "SELECT COUNT(*) FROM bk WHERE day BETWEEN DATE '2026-01-05' AND DATE '2026-01-09'") === 5, 'range count')
})
test('temporal', 'join on equal dates', () => {
  const e = new Engine()
  e.execute('CREATE TABLE a (id INTEGER, d DATE)')
  e.execute('CREATE TABLE b (d DATE, label TEXT)')
  e.execute("INSERT INTO a VALUES (1,'2026-03-03'),(2,'2026-04-04')")
  e.execute("INSERT INTO b VALUES ('2026-03-03','hit')")
  const rows = rowsOf(e, 'SELECT a.id, b.label FROM a JOIN b ON a.d = b.d')
  assert(rows.length === 1 && rows[0][0] === 1 && rows[0][1] === 'hit', 'date join')
})
test('temporal', 'INSERT coerces strings into the declared temporal type', () => {
  const e = new Engine()
  e.execute('CREATE TABLE t (d DATE, ts TIMESTAMP, iv INTERVAL)')
  e.execute("INSERT INTO t VALUES ('2026-06-15', '2026-06-15 13:00:00', '2 days')")
  assert(fv(e, 'SELECT d FROM t') === '2026-06-15', 'date stored and round-trips')
  assert(fv(e, 'SELECT d + iv FROM t') === '2026-06-17 00:00:00', 'stored date + stored interval')
  assert(fv(e, 'SELECT ts FROM t') === '2026-06-15 13:00:00', 'stored timestamp round-trips')
})
test('temporal', 'temporal values survive a JSON persistence round-trip', () => {
  const e = new Engine()
  e.execute('CREATE TABLE t (id INTEGER, d DATE, ts TIMESTAMP)')
  e.execute("INSERT INTO t VALUES (1,'2026-06-15','2026-06-15 13:45:30')")
  const snap = JSON.parse(JSON.stringify(e.db.snapshot()))
  const e2 = new Engine(Database.restore(snap))
  assert(fv(e2, 'SELECT d FROM t') === '2026-06-15', 'date survives reload')
  assert(fv(e2, 'SELECT ts FROM t') === '2026-06-15 13:45:30', 'timestamp survives reload')
  assert(scalar(e2, "SELECT id FROM t WHERE d = DATE '2026-06-15'") === 1, 'query after reload')
})
test('temporal', 'CURRENT_DATE / CURRENT_TIMESTAMP are sane and ordered', () => {
  const e = new Engine()
  assert(isTemporal(scalar(e, 'SELECT CURRENT_DATE')), 'CURRENT_DATE is a date value')
  assert(scalar(e, "SELECT CURRENT_DATE >= DATE '2020-01-01'") === true, 'today is after 2020')
  assert(scalar(e, 'SELECT CURRENT_TIMESTAMP >= CURRENT_DATE') === true, 'now ≥ midnight today')
})
test('temporal', 'TO_CHAR formats with Postgres-style templates', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT TO_CHAR(DATE '2026-06-15', 'YYYY-MM-DD')") === '2026-06-15', 'numeric template')
  assert(scalar(e, "SELECT TO_CHAR(DATE '2026-06-15', 'Dy, DD Mon YYYY')") === 'Mon, 15 Jun 2026', 'name template')
  assert(scalar(e, "SELECT TO_CHAR(TIMESTAMP '2026-06-15 13:45:30', 'HH24:MI:SS')") === '13:45:30', 'time 24h')
  assert(scalar(e, "SELECT TO_CHAR(TIMESTAMP '2026-06-15 13:45:30', 'HH12:MI AM')") === '01:45 PM', '12h with meridiem')
  assert(scalar(e, `SELECT TO_CHAR(DATE '2026-06-15', '"Q"Q YYYY')`) === 'Q2 2026', 'quoted literal + quarter')
  assert(scalar(e, "SELECT TO_CHAR(DATE '2026-01-05', 'Month')") === 'January', 'full month name')
})
test('temporal', 'CONCAT and || render temporal values', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT 'd=' || DATE '2026-06-15'") === 'd=2026-06-15', 'concat operator')
  assert(scalar(e, "SELECT CONCAT('t=', TIME '09:30:00')") === 't=09:30:00', 'CONCAT function')
})

// --- constraints: CHECK ----------------------------------------------------
test('constraint', 'CHECK rejects a false row, passes true & NULL', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0))')
  e.execute('INSERT INTO t VALUES (1, 30)')
  throws(e, 'INSERT INTO t VALUES (2, -5)', 'CHECK')
  e.execute('INSERT INTO t (id) VALUES (3)') // NULL age → check is unknown → passes
  assert(scalar(e, 'SELECT COUNT(*) FROM t') === 2, 'only the two valid rows survive')
})
test('constraint', 'table-level CHECK over several columns', () => {
  const e = fresh('CREATE TABLE t (lo INTEGER, hi INTEGER, CHECK (lo <= hi))')
  e.execute('INSERT INTO t VALUES (1, 5)')
  throws(e, 'INSERT INTO t VALUES (9, 2)', 'CHECK')
})
test('constraint', 'CHECK enforced on UPDATE', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, age INTEGER CHECK (age >= 0))')
  e.execute('INSERT INTO t VALUES (1, 30)')
  throws(e, 'UPDATE t SET age = -1 WHERE id = 1', 'CHECK')
  assert(scalar(e, 'SELECT age FROM t') === 30, 'failed update left the row unchanged')
})
test('constraint', 'named CHECK reports its name', () => {
  const e = fresh('CREATE TABLE t (n INTEGER, CONSTRAINT positive CHECK (n > 0))')
  throws(e, 'INSERT INTO t VALUES (-1)', 'positive')
})

// --- constraints: DEFAULT --------------------------------------------------
test('constraint', 'DEFAULT fills omitted columns', () => {
  const e = fresh("CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT DEFAULT 'new', n INTEGER DEFAULT 0)")
  e.execute('INSERT INTO t (id) VALUES (1)')
  assert(scalar(e, 'SELECT status FROM t') === 'new', 'text default')
  assert(scalar(e, 'SELECT n FROM t') === 0, 'int default')
  e.execute("INSERT INTO t (id, status) VALUES (2, 'old')")
  assert(scalar(e, 'SELECT status FROM t WHERE id = 2') === 'old', 'default overridden')
})
test('constraint', 'DEFAULT CURRENT_TIMESTAMP evaluates per row', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, made TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
  e.execute('INSERT INTO t (id) VALUES (1)')
  assert(scalar(e, 'SELECT made FROM t') !== null, 'timestamp default present')
})

// --- constraints: composite PK / UNIQUE ------------------------------------
test('constraint', 'composite PRIMARY KEY: uniqueness + NOT NULL', () => {
  const e = fresh('CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b))')
  e.execute('INSERT INTO t VALUES (1, 1), (1, 2)')
  throws(e, 'INSERT INTO t VALUES (1, 1)', 'UNIQUE')
  throws(e, 'INSERT INTO t (a) VALUES (5)', 'NOT NULL')
  // a single column may repeat as long as the pair is unique
  assert(scalar(e, 'SELECT COUNT(*) FROM t') === 2, 'two rows so far')
})
test('constraint', 'table-level UNIQUE (multi-column)', () => {
  const e = fresh('CREATE TABLE u (id INTEGER PRIMARY KEY, x INTEGER, y INTEGER, UNIQUE (x, y))')
  e.execute('INSERT INTO u VALUES (1, 1, 1)')
  throws(e, 'INSERT INTO u VALUES (2, 1, 1)', 'UNIQUE')
  e.execute('INSERT INTO u VALUES (3, 1, 2)') // differs in y → ok
  assert(scalar(e, 'SELECT COUNT(*) FROM u') === 2, 'distinct pair inserted')
})
test('constraint', 'UNIQUE allows repeated NULLs', () => {
  const e = fresh('CREATE TABLE u (id INTEGER PRIMARY KEY, code TEXT UNIQUE)')
  e.execute('INSERT INTO u (id) VALUES (1), (2)') // both code NULL → allowed
  assert(scalar(e, 'SELECT COUNT(*) FROM u') === 2, 'two NULL codes coexist')
})
test('constraint', 'UNIQUE enforced on UPDATE (excludes self)', () => {
  const e = fresh('CREATE TABLE u (id INTEGER PRIMARY KEY, code TEXT UNIQUE)')
  e.execute("INSERT INTO u VALUES (1, 'a'), (2, 'b')")
  throws(e, "UPDATE u SET code = 'a' WHERE id = 2", 'UNIQUE')
  e.execute("UPDATE u SET code = 'a' WHERE id = 1") // self-update is fine
  assert(scalar(e, "SELECT id FROM u WHERE code = 'a'") === 1, 'self-update allowed')
})

// --- constraints: FOREIGN KEY existence ------------------------------------
function parentChild(onDelete = '', onUpdate = ''): Engine {
  return fresh(
    'CREATE TABLE p (id INTEGER PRIMARY KEY);' +
      `CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ${onDelete} ${onUpdate})`,
  )
}
test('fk', 'a child must reference an existing parent', () => {
  const e = parentChild()
  e.execute('INSERT INTO p VALUES (1)')
  e.execute('INSERT INTO c VALUES (10, 1)')
  throws(e, 'INSERT INTO c VALUES (11, 99)', 'FOREIGN KEY')
  e.execute('INSERT INTO c VALUES (12, NULL)') // NULL fk → unenforced
  assert(scalar(e, 'SELECT COUNT(*) FROM c') === 2, 'valid + NULL child rows')
})
test('fk', 'UPDATE that orphans a child is rejected', () => {
  const e = parentChild()
  e.execute('INSERT INTO p VALUES (1)')
  e.execute('INSERT INTO c VALUES (10, 1)')
  throws(e, 'UPDATE c SET pid = 50 WHERE id = 10', 'FOREIGN KEY')
})
test('fk', 'FK must target a PRIMARY KEY / UNIQUE column', () => {
  const e = fresh('CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT)')
  throws(e, 'CREATE TABLE c (id INTEGER, pname TEXT REFERENCES p(name))', 'UNIQUE')
})
test('fk', 'cannot DROP a table still referenced', () => {
  const e = parentChild()
  throws(e, 'DROP TABLE p', 'referenced')
})

// --- constraints: referential actions --------------------------------------
test('fk', 'ON DELETE CASCADE removes dependents', () => {
  const e = parentChild('ON DELETE CASCADE')
  e.execute('INSERT INTO p VALUES (1), (2)')
  e.execute('INSERT INTO c VALUES (10, 1), (11, 1), (12, 2)')
  e.execute('DELETE FROM p WHERE id = 1')
  assert(scalar(e, 'SELECT COUNT(*) FROM c') === 1, 'two children cascaded away')
  assert(scalar(e, 'SELECT id FROM c') === 12, 'the unrelated child remains')
})
test('fk', 'ON DELETE RESTRICT blocks the delete', () => {
  const e = parentChild('ON DELETE RESTRICT')
  e.execute('INSERT INTO p VALUES (1)')
  e.execute('INSERT INTO c VALUES (10, 1)')
  throws(e, 'DELETE FROM p WHERE id = 1', 'RESTRICT')
  assert(scalar(e, 'SELECT COUNT(*) FROM p') === 1, 'parent untouched')
})
test('fk', 'ON DELETE SET NULL nulls the child key', () => {
  const e = parentChild('ON DELETE SET NULL')
  e.execute('INSERT INTO p VALUES (1)')
  e.execute('INSERT INTO c VALUES (10, 1)')
  e.execute('DELETE FROM p WHERE id = 1')
  assert(scalar(e, 'SELECT COUNT(*) FROM c') === 1, 'child kept')
  assert(scalar(e, 'SELECT pid FROM c') === null, 'fk set to NULL')
})
test('fk', 'ON UPDATE CASCADE follows the parent key', () => {
  const e = parentChild('', 'ON UPDATE CASCADE')
  e.execute('INSERT INTO p VALUES (1)')
  e.execute('INSERT INTO c VALUES (10, 1)')
  e.execute('UPDATE p SET id = 2 WHERE id = 1')
  assert(scalar(e, 'SELECT pid FROM c') === 2, 'child key followed the parent')
})
test('fk', 'self-referential ON DELETE CASCADE walks the tree', () => {
  const e = fresh('CREATE TABLE node (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES node(id) ON DELETE CASCADE)')
  e.execute('INSERT INTO node VALUES (1, NULL), (2, 1), (3, 2), (4, 1)')
  e.execute('DELETE FROM node WHERE id = 1')
  assert(scalar(e, 'SELECT COUNT(*) FROM node') === 0, 'whole subtree cascaded')
})
test('fk', 'multi-column FOREIGN KEY', () => {
  const e = fresh(
    'CREATE TABLE p (a INTEGER, b INTEGER, PRIMARY KEY (a, b));' +
      'CREATE TABLE c (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, FOREIGN KEY (a, b) REFERENCES p (a, b) ON DELETE CASCADE)',
  )
  e.execute('INSERT INTO p VALUES (1, 1), (1, 2)')
  e.execute('INSERT INTO c VALUES (10, 1, 1), (11, 1, 2)')
  throws(e, 'INSERT INTO c VALUES (12, 9, 9)', 'FOREIGN KEY')
  e.execute('DELETE FROM p WHERE a = 1 AND b = 1')
  assert(scalar(e, 'SELECT COUNT(*) FROM c') === 1, 'only the (1,1) child cascaded')
})

// --- statement atomicity ----------------------------------------------------
test('constraint', 'a partly-failing statement rolls back entirely', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER CHECK (n > 0))')
  throws(e, 'INSERT INTO t VALUES (1, 5), (2, 10), (3, -1)', 'CHECK')
  assert(scalar(e, 'SELECT COUNT(*) FROM t') === 0, 'no rows from the failed bulk insert')
})
test('constraint', 'a blocked cascade leaves everything unchanged', () => {
  const e = fresh(
    'CREATE TABLE p (id INTEGER PRIMARY KEY);' +
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE RESTRICT)',
  )
  e.execute('INSERT INTO p VALUES (1), (2)')
  e.execute('INSERT INTO c VALUES (10, 2)')
  throws(e, 'DELETE FROM p', 'RESTRICT')
  assert(scalar(e, 'SELECT COUNT(*) FROM p') === 2, 'no parent deleted despite p(1) being free')
})

// --- ALTER TABLE -----------------------------------------------------------
test('alter', 'ADD COLUMN backfills existing rows with the DEFAULT', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  e.execute('INSERT INTO t VALUES (1)')
  e.execute("ALTER TABLE t ADD COLUMN label TEXT DEFAULT 'x'")
  assert(scalar(e, 'SELECT label FROM t') === 'x', 'existing row backfilled')
})
test('alter', 'ADD COLUMN NOT NULL without DEFAULT rejected on non-empty table', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  e.execute('INSERT INTO t VALUES (1)')
  throws(e, 'ALTER TABLE t ADD COLUMN x INTEGER NOT NULL', 'DEFAULT')
})
test('alter', 'ADD CONSTRAINT CHECK applies to future rows', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)')
  e.execute('INSERT INTO t VALUES (1, 10)')
  e.execute('ALTER TABLE t ADD CONSTRAINT chk CHECK (a >= 0)')
  throws(e, 'INSERT INTO t VALUES (2, -1)', 'CHECK')
})
test('alter', 'ADD FOREIGN KEY validates the current rows', () => {
  const e = fresh('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER)')
  e.execute('INSERT INTO p VALUES (1)')
  e.execute('INSERT INTO c VALUES (10, 1)')
  e.execute('ALTER TABLE c ADD FOREIGN KEY (pid) REFERENCES p (id)')
  throws(e, 'INSERT INTO c VALUES (11, 99)', 'FOREIGN KEY')
  const bad = fresh('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER)')
  bad.execute('INSERT INTO p VALUES (1); INSERT INTO c VALUES (10, 99)')
  throws(bad, 'ALTER TABLE c ADD FOREIGN KEY (pid) REFERENCES p (id)', 'FOREIGN KEY')
})
test('alter', 'RENAME TABLE and RENAME COLUMN', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)')
  e.execute('INSERT INTO t VALUES (1, 10)')
  e.execute('ALTER TABLE t RENAME COLUMN a TO amount')
  assert(scalar(e, 'SELECT amount FROM t') === 10, 'column renamed')
  e.execute('ALTER TABLE t RENAME TO things')
  assert(scalar(e, 'SELECT COUNT(*) FROM things') === 1, 'table renamed')
})
test('alter', 'DROP COLUMN refuses a column an index needs', () => {
  const e = fresh('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER); CREATE INDEX ix ON t (a)')
  e.execute('INSERT INTO t VALUES (1, 2, 3)')
  throws(e, 'ALTER TABLE t DROP COLUMN a', 'index')
  e.execute('ALTER TABLE t DROP COLUMN b')
  throws(e, 'SELECT b FROM t', 'b')
})

// --- persistence of constraints --------------------------------------------
test('constraint', 'constraints survive a snapshot round-trip', () => {
  const e = fresh(
    'CREATE TABLE p (id INTEGER PRIMARY KEY);' +
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE CASCADE, n INTEGER CHECK (n > 0) DEFAULT 1)',
  )
  e.execute('INSERT INTO p VALUES (1)')
  e.execute('INSERT INTO c (id, pid) VALUES (10, 1)')
  const snap = JSON.parse(JSON.stringify(e.db.snapshot()))
  const e2 = new Engine(Database.restore(snap))
  assert(scalar(e2, 'SELECT n FROM c') === 1, 'DEFAULT round-tripped')
  throws(e2, 'INSERT INTO c (id, pid, n) VALUES (11, 1, -1)', 'CHECK')
  throws(e2, 'INSERT INTO c (id, pid) VALUES (12, 77)', 'FOREIGN KEY')
  e2.execute('DELETE FROM p WHERE id = 1')
  assert(scalar(e2, 'SELECT COUNT(*) FROM c') === 0, 'ON DELETE CASCADE round-tripped')
})

// --- exact numerics: DECIMAL / NUMERIC -------------------------------------
/** The formatted text of a single-cell scalar result (handy for DECIMALs). */
function fstr(e: Engine, sql: string): string {
  return formatValue(scalar(e, sql))
}

test('decimal', 'typed literal and exact addition (no float error)', () => {
  const e = new Engine()
  assert(fstr(e, "SELECT DECIMAL '0.1' + DECIMAL '0.2'") === '0.3', '0.1 + 0.2 must be exactly 0.3')
  // The same sum in binary floating point is famously *not* 0.3 — the contrast.
  assert(fstr(e, 'SELECT 0.1 + 0.2') === '0.30000000000000004', 'REAL keeps its float behaviour')
  assert(fstr(e, "SELECT NUMERIC '2' * DEC '3'") === '6', 'NUMERIC / DEC literal aliases work')
})
test('decimal', 'scale rules for + - * /', () => {
  const e = new Engine()
  assert(fstr(e, "SELECT DECIMAL '1.50' + DECIMAL '2.5'") === '4.00', 'add keeps max scale')
  assert(fstr(e, "SELECT DECIMAL '2.50' * DECIMAL '4.0'") === '10.000', 'mul adds scales')
  assert(fstr(e, "SELECT DECIMAL '10' / DECIMAL '4'") === '2.500000', 'div uses min scale 6')
  assert(fstr(e, "SELECT DECIMAL '1' / DECIMAL '3'") === '0.333333', 'div rounds half-up to scale 6')
})
test('decimal', 'mixing with INTEGER stays exact, REAL degrades', () => {
  const e = new Engine()
  assert(fstr(e, "SELECT DECIMAL '19.99' * 3") === '59.97', 'decimal * integer is exact decimal')
  assert(eq(scalar(e, "SELECT TYPEOF(DECIMAL '1.5' + 1)"), 'decimal'), 'decimal + int -> decimal')
  assert(eq(scalar(e, "SELECT TYPEOF(DECIMAL '1.5' + 0.25)"), 'real'), 'decimal + real -> real')
})
test('decimal', 'cross-type comparison and equality (1.50 = 1.5 = numeric)', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT DECIMAL '1.50' = DECIMAL '1.5'") === true, '1.50 = 1.5')
  assert(scalar(e, "SELECT DECIMAL '2.00' = 2") === true, 'decimal = integer')
  assert(scalar(e, "SELECT DECIMAL '0.50' = 0.5") === true, 'decimal = real')
  assert(scalar(e, "SELECT DECIMAL '10' > DECIMAL '9.99'") === true, 'ordering')
})
test('decimal', 'DECIMAL(p,s) column rounds on store; CAST honours scale', () => {
  const e = fresh('CREATE TABLE m (id INTEGER, bal DECIMAL(12,2))')
  e.execute('INSERT INTO m VALUES (1, 19.999), (2, 19.991), (3, 100)')
  assert(fstr(e, 'SELECT bal FROM m WHERE id = 1') === '20.00', '19.999 rounds to 20.00')
  assert(fstr(e, 'SELECT bal FROM m WHERE id = 2') === '19.99', '19.991 rounds to 19.99')
  assert(fstr(e, 'SELECT bal FROM m WHERE id = 3') === '100.00', 'integer stored at scale 2')
  assert(fstr(e, "SELECT CAST('3.14159' AS DECIMAL(10,2))") === '3.14', 'CAST(... DECIMAL(10,2))')
})
test('decimal', 'SUM and AVG are exact over a money column', () => {
  const e = fresh('CREATE TABLE t (x DECIMAL(12,2))')
  e.execute('INSERT INTO t VALUES (0.10), (0.20), (0.30)')
  assert(fstr(e, 'SELECT SUM(x) FROM t') === '0.60', 'exact SUM = 0.60 (not 0.6000000001)')
  assert(eq(scalar(e, 'SELECT TYPEOF(SUM(x)) FROM t'), 'decimal'), 'SUM stays DECIMAL')
  assert(fstr(e, 'SELECT AVG(x) FROM t') === '0.200000', 'exact AVG')
})
test('decimal', 'GROUP BY aggregates and ORDER BY on a DECIMAL column', () => {
  const e = fresh('CREATE TABLE s (g TEXT, v DECIMAL(10,2))')
  e.execute("INSERT INTO s VALUES ('a',1.11),('a',2.22),('b',10.00),('b',0.01)")
  const rows = rowsOf(e, 'SELECT g, SUM(v) FROM s GROUP BY g ORDER BY g')
  assert(eq([formatValue(rows[0][1]), formatValue(rows[1][1])], ['3.33', '10.01']), 'grouped exact sums')
  const ord = rowsOf(e, 'SELECT v FROM s ORDER BY v').map((r) => formatValue(r[0]))
  assert(eq(ord, ['0.01', '1.11', '2.22', '10.00']), 'numeric (not lexical) ordering')
})
test('decimal', 'window SUM/AVG OVER are exact', () => {
  const e = fresh('CREATE TABLE w (id INTEGER, amt DECIMAL(12,2))')
  e.execute('INSERT INTO w VALUES (1,10.10),(2,20.20),(3,0.01)')
  const run = rowsOf(e, 'SELECT SUM(amt) OVER (ORDER BY id) FROM w').map((r) => formatValue(r[0]))
  assert(eq(run, ['10.10', '30.30', '30.31']), 'running window SUM is exact')
  assert(fstr(e, 'SELECT AVG(amt) OVER () FROM w LIMIT 1') === '10.103333', 'window AVG exact')
})
test('decimal', 'B+Tree index scan over a DECIMAL column', () => {
  const e = fresh('CREATE TABLE p (id INTEGER, price DECIMAL(10,2)); CREATE INDEX ip ON p(price)')
  e.execute('INSERT INTO p VALUES (1,9.99),(2,19.99),(3,5.05),(4,5.05)')
  assert(scalar(e, 'SELECT COUNT(*) FROM p WHERE price = 5.05') === 2, 'index equality on decimal')
  const r = rowsOf(e, 'SELECT id FROM p WHERE price BETWEEN 5.00 AND 10.00 ORDER BY id').map((x) => x[0])
  assert(eq(r, [1, 3, 4]), 'index range on decimal')
})
test('decimal', 'rounding family: ROUND / TRUNC / FLOOR / CEIL / ABS / SIGN', () => {
  const e = new Engine()
  assert(fstr(e, "SELECT ROUND(DECIMAL '2.345', 2)") === '2.35', 'ROUND half-up')
  assert(fstr(e, "SELECT ROUND(DECIMAL '123.456', -1)") === '120', 'ROUND negative places')
  assert(fstr(e, "SELECT TRUNC(DECIMAL '2.789', 1)") === '2.7', 'TRUNC toward zero')
  assert(fstr(e, "SELECT FLOOR(DECIMAL '-2.1')") === '-3', 'FLOOR toward -inf')
  assert(fstr(e, "SELECT CEIL(DECIMAL '2.1')") === '3', 'CEIL toward +inf')
  assert(fstr(e, "SELECT ABS(DECIMAL '-5.25')") === '5.25', 'ABS')
  assert(scalar(e, "SELECT SIGN(DECIMAL '-5.25')") === -1, 'SIGN')
  assert(fstr(e, "SELECT MOD(DECIMAL '10.5', DECIMAL '3')") === '1.5', 'MOD keeps scale and dividend sign')
})
test('decimal', 'introspection: TYPEOF / SCALE / PRECISION / DECIMAL() / TO_NUMBER', () => {
  const e = new Engine()
  assert(eq(scalar(e, "SELECT TYPEOF(DECIMAL '1.5')"), 'decimal'), 'TYPEOF')
  assert(scalar(e, "SELECT SCALE(DECIMAL '1.500')") === 3, 'SCALE')
  assert(scalar(e, "SELECT PRECISION(DECIMAL '12.34')") === 4, 'PRECISION')
  assert(fstr(e, "SELECT DECIMAL('3.14159', 2)") === '3.14', 'DECIMAL(x, scale) function')
  assert(fstr(e, "SELECT TO_NUMBER('42.5')") === '42.5', 'TO_NUMBER parses text')
})
test('decimal', 'arbitrary precision beyond float (30+ digit integers)', () => {
  const e = new Engine()
  assert(
    fstr(e, "SELECT DECIMAL '123456789012345678901234567890' + 1") === '123456789012345678901234567891',
    'exact big-integer addition',
  )
  assert(fstr(e, "SELECT DECIMAL '0.0000000001' * DECIMAL '0.0000000001'") === '0.00000000000000000001', 'tiny exact product')
})
test('decimal', 'TO_CHAR numeric templates', () => {
  const e = new Engine()
  assert(fstr(e, "SELECT TO_CHAR(1234.5, 'FM999,999.00')") === '1,234.50', 'group + FM')
  assert(fstr(e, "SELECT TO_CHAR(1234.567, '$9,999.99')") === '$1,234.57', 'currency + rounding')
  assert(fstr(e, "SELECT TO_CHAR(7, '000')") === '007', 'zero padding')
  assert(fstr(e, "SELECT TO_CHAR(-42, 'FM9999MI')") === '42-', 'MI trailing sign')
  assert(fstr(e, "SELECT TO_CHAR(-7.5, 'FM999.99PR')") === '<7.50>', 'PR brackets')
  assert(fstr(e, "SELECT TO_CHAR(12345, '999')") === '###', 'overflow marks')
})
test('decimal', 'DECIMAL value survives a snapshot round-trip', () => {
  const e = fresh('CREATE TABLE acct (id INTEGER PRIMARY KEY, bal DECIMAL(14,4))')
  e.execute('INSERT INTO acct VALUES (1, 1234.5678), (2, 0.0001)')
  const snap = JSON.parse(JSON.stringify(e.db.snapshot()))
  const e2 = new Engine(Database.restore(snap))
  assert(fstr(e2, 'SELECT bal FROM acct WHERE id = 1') === '1234.5678', 'round-trips exactly')
  assert(fstr(e2, 'SELECT SUM(bal) FROM acct') === '1234.5679', 'still sums exactly after reload')
})
test('decimal', 'division by zero yields NULL (not an exception)', () => {
  const e = new Engine()
  assert(scalar(e, "SELECT DECIMAL '1' / DECIMAL '0'") === null, 'x / 0 -> NULL')
  assert(scalar(e, "SELECT MOD(DECIMAL '1', DECIMAL '0')") === null, 'mod 0 -> NULL')
})
test('decimal', 'seed invoices: recomputed tax matches stored totals exactly', () => {
  const e = seeded()
  const off = scalar(
    e,
    'SELECT COUNT(*) FROM invoices WHERE ROUND(subtotal * (1 + tax_rate), 2) <> total',
  )
  assert(off === 0, 'every stored total equals subtotal × (1 + tax_rate) to the cent')
  assert(eq(scalar(e, 'SELECT TYPEOF(SUM(total)) FROM invoices'), 'decimal'), 'SUM(total) is exact DECIMAL')
})

// --- v7.0: views -----------------------------------------------------------
function explainText(e: Engine, sql: string): string {
  const r = e.execute('EXPLAIN ' + sql)[0]
  return r.kind === 'explain' ? JSON.stringify(r.plan) : ''
}

test('view', 'CREATE VIEW then SELECT', () => {
  const e = seeded()
  e.execute(`CREATE VIEW uk_customers AS SELECT id, name FROM customers WHERE country = 'UK'`)
  const r = rowsOf(e, 'SELECT name FROM uk_customers ORDER BY name')
  assert(eq(r.map((x) => x[0]), ['Ada Lovelace', 'Alan Turing', 'Tim Berners-Lee']), 'view filters to UK customers')
})
test('view', 'a view aggregates and can itself be queried/grouped', () => {
  const e = seeded()
  e.execute(`CREATE VIEW order_value AS
    SELECT o.id AS oid, c.country AS country, p.price * o.quantity AS amount
    FROM orders o JOIN customers c ON o.customer_id = c.id JOIN products p ON o.product_id = p.id`)
  const total = scalar(e, 'SELECT COUNT(*) FROM order_value')
  assert(total === 15, 'view exposes all 15 orders')
  const byCountry = rowsOf(e, 'SELECT country, COUNT(*) FROM order_value GROUP BY country ORDER BY country')
  assert(byCountry.length === 2, 'group over a view works')
})
test('view', 'a view can be defined over another view', () => {
  const e = seeded()
  e.execute(`CREATE VIEW hardware AS SELECT id, name, price FROM products WHERE category = 'Hardware'`)
  e.execute(`CREATE VIEW cheap_hardware AS SELECT name FROM hardware WHERE price < 200`)
  const r = rowsOf(e, 'SELECT name FROM cheap_hardware ORDER BY name')
  assert(eq(r.map((x) => x[0]), ['Mechanical Keyboard', 'USB-C Hub']), 'nested view resolves')
})
test('view', 'a view joins against a base table', () => {
  const e = seeded()
  e.execute(`CREATE VIEW premium AS SELECT id, name FROM products WHERE price > 300`)
  const n = scalar(e, `SELECT COUNT(*) FROM orders o JOIN premium p ON o.product_id = p.id`)
  assert(typeof n === 'number' && n > 0, 'view participates in a join')
})
test('view', 'CREATE OR REPLACE VIEW redefines', () => {
  const e = seeded()
  e.execute(`CREATE VIEW v AS SELECT id FROM products WHERE price < 100`)
  const before = scalar(e, 'SELECT COUNT(*) FROM v')
  e.execute(`CREATE OR REPLACE VIEW v AS SELECT id FROM products WHERE price >= 100`)
  const after = scalar(e, 'SELECT COUNT(*) FROM v')
  assert(before !== after && (before as number) + (after as number) === 8, 'replace swaps the definition')
})
test('view', 'CREATE VIEW IF NOT EXISTS is idempotent', () => {
  const e = seeded()
  e.execute(`CREATE VIEW v AS SELECT id FROM products`)
  e.execute(`CREATE VIEW IF NOT EXISTS v AS SELECT id FROM customers`)
  assert(scalar(e, 'SELECT COUNT(*) FROM v') === 8, 'second create is skipped, original kept')
  throws(e, `CREATE VIEW v AS SELECT id FROM customers`, 'already exists')
})
test('view', 'declared column names rename the output', () => {
  const e = seeded()
  e.execute(`CREATE VIEW labelled (pid, label) AS SELECT id, name FROM products`)
  const r = lastResult(e, 'SELECT pid, label FROM labelled WHERE pid = 1') as RowsResult
  assert(r.rows[0][1] === 'Mechanical Keyboard', 'aliased columns resolve')
  throws(e, `CREATE VIEW bad (a, b) AS SELECT id FROM products`, 'declares 2 columns')
})
test('view', 'DROP VIEW (and IF EXISTS)', () => {
  const e = seeded()
  e.execute(`CREATE VIEW v AS SELECT id FROM products`)
  e.execute(`DROP VIEW v`)
  throws(e, `SELECT * FROM v`, 'unknown table')
  e.execute(`DROP VIEW IF EXISTS v`) // no-op
  throws(e, `DROP VIEW v`, 'unknown view')
})
test('view', 'a view and a table cannot share a name', () => {
  const e = seeded()
  e.execute(`CREATE VIEW shared AS SELECT id FROM products`)
  throws(e, `CREATE TABLE shared (id INTEGER)`, 'already exists as a view')
  throws(e, `CREATE VIEW customers AS SELECT id FROM products`, 'already exists as a table')
})
test('view', 'a recursive view definition is rejected', () => {
  const e = seeded()
  throws(e, `CREATE VIEW loop AS SELECT * FROM loop`, 'recursively')
  // an indirect cycle via OR REPLACE is caught at plan time and rolled back
  e.execute(`CREATE VIEW a AS SELECT id FROM products`)
  e.execute(`CREATE VIEW b AS SELECT id FROM a`)
  throws(e, `CREATE OR REPLACE VIEW a AS SELECT id FROM b`, 'recursively')
})
test('view', 'views survive a snapshot/restore round-trip', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`)
  e.execute(`INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)`)
  e.execute(`CREATE VIEW big AS SELECT id FROM t WHERE v >= 20`)
  const restored = Database.restore(e.db.snapshot())
  const e2 = new Engine(restored)
  assert(scalar(e2, 'SELECT COUNT(*) FROM big') === 2, 'the view is restored and still resolves')
})

// --- v7.0: UPSERT (INSERT … ON CONFLICT) -----------------------------------
function upsertEngine(): Engine {
  const e = new Engine()
  e.execute(`CREATE TABLE inv (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL DEFAULT 0, name TEXT UNIQUE)`)
  e.execute(`INSERT INTO inv VALUES ('A', 5, 'Widget'), ('B', 3, 'Gadget')`)
  return e
}
test('upsert', 'ON CONFLICT DO NOTHING leaves the existing row', () => {
  const e = upsertEngine()
  e.execute(`INSERT INTO inv VALUES ('A', 999, 'X') ON CONFLICT DO NOTHING`)
  assert(scalar(e, `SELECT qty FROM inv WHERE sku = 'A'`) === 5, 'conflicting row was skipped')
  assert(scalar(e, `SELECT COUNT(*) FROM inv`) === 2, 'no row added')
})
test('upsert', 'ON CONFLICT DO UPDATE with EXCLUDED', () => {
  const e = upsertEngine()
  e.execute(`INSERT INTO inv (sku, qty) VALUES ('A', 7) ON CONFLICT (sku) DO UPDATE SET qty = inv.qty + EXCLUDED.qty`)
  assert(scalar(e, `SELECT qty FROM inv WHERE sku = 'A'`) === 12, 'qty accumulates (5 + 7)')
})
test('upsert', 'a brand-new key is inserted; an existing one updates', () => {
  const e = upsertEngine()
  const r = e.execute(`INSERT INTO inv (sku, qty) VALUES ('A', 1), ('C', 9)
    ON CONFLICT (sku) DO UPDATE SET qty = EXCLUDED.qty`)
  assert(r[0].kind === 'message' && (r[0].rowCount === 2), 'two rows affected (1 update + 1 insert)')
  assert(scalar(e, `SELECT qty FROM inv WHERE sku = 'A'`) === 1, 'A updated to EXCLUDED.qty')
  assert(scalar(e, `SELECT qty FROM inv WHERE sku = 'C'`) === 9, 'C inserted')
})
test('upsert', 'conflict on a non-PK UNIQUE column', () => {
  const e = upsertEngine()
  e.execute(`INSERT INTO inv (sku, qty, name) VALUES ('Z', 100, 'Widget') ON CONFLICT (name) DO UPDATE SET qty = EXCLUDED.qty`)
  assert(scalar(e, `SELECT qty FROM inv WHERE name = 'Widget'`) === 100, 'matched on the UNIQUE name, updated A')
  assert(scalar(e, `SELECT COUNT(*) FROM inv`) === 2, 'no new row (it was a conflict)')
})
test('upsert', 'DO UPDATE … WHERE can decline the update', () => {
  const e = upsertEngine()
  e.execute(`INSERT INTO inv (sku, qty) VALUES ('A', 1) ON CONFLICT (sku) DO UPDATE SET qty = 999 WHERE EXCLUDED.qty > 100`)
  assert(scalar(e, `SELECT qty FROM inv WHERE sku = 'A'`) === 5, 'WHERE was false, row left unchanged')
})
test('upsert', 'no-target ON CONFLICT fires on any unique constraint', () => {
  const e = upsertEngine()
  e.execute(`INSERT INTO inv (sku, qty, name) VALUES ('Q', 1, 'Widget') ON CONFLICT DO NOTHING`)
  assert(scalar(e, `SELECT COUNT(*) FROM inv`) === 2, 'the UNIQUE(name) collision was skipped')
})
test('upsert', 'a target matching no constraint is rejected', () => {
  const e = upsertEngine()
  throws(e, `INSERT INTO inv (sku, qty) VALUES ('A', 1) ON CONFLICT (qty) DO NOTHING`, 'matches no UNIQUE')
})
test('upsert', 'ON CONFLICT needs a unique constraint to arbitrate', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE plain (a INTEGER, b INTEGER)`)
  e.execute(`INSERT INTO plain VALUES (1, 1)`)
  throws(e, `INSERT INTO plain VALUES (1, 2) ON CONFLICT DO NOTHING`, 'UNIQUE or PRIMARY KEY')
})
test('upsert', 'INSERT … SELECT … ON CONFLICT', () => {
  const e = upsertEngine()
  e.execute(`CREATE TABLE feed (sku TEXT, qty INTEGER)`)
  e.execute(`INSERT INTO feed VALUES ('A', 50), ('D', 4)`)
  e.execute(`INSERT INTO inv (sku, qty) SELECT sku, qty FROM feed ON CONFLICT (sku) DO UPDATE SET qty = EXCLUDED.qty`)
  assert(scalar(e, `SELECT qty FROM inv WHERE sku = 'A'`) === 50, 'A upserted from the feed')
  assert(scalar(e, `SELECT qty FROM inv WHERE sku = 'D'`) === 4, 'D inserted from the feed')
})
test('upsert', 'a DO UPDATE that creates a new conflict rolls back atomically', () => {
  const e = upsertEngine()
  // Updating A's name to 'Gadget' (B's name) would violate UNIQUE(name); the
  // whole statement must roll back, leaving A untouched.
  throws(e, `INSERT INTO inv (sku, qty, name) VALUES ('A', 1, 'Z') ON CONFLICT (sku) DO UPDATE SET name = 'Gadget'`, 'UNIQUE')
  assert(scalar(e, `SELECT name FROM inv WHERE sku = 'A'`) === 'Widget', "A's name is unchanged after rollback")
})

// --- v7.0: subquery decorrelation (EXISTS → semi/anti join) ----------------
test('decorrelate', 'correlated EXISTS matches the IN formulation', () => {
  const e = seeded()
  const a = rowsOf(e, `SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY c.name`)
  const b = rowsOf(e, `SELECT c.name FROM customers c WHERE c.id IN (SELECT customer_id FROM orders) ORDER BY c.name`)
  assert(eq(a, b), 'EXISTS and IN agree')
})
test('decorrelate', 'NOT EXISTS matches the NOT IN formulation', () => {
  const e = seeded()
  const a = rowsOf(e, `SELECT c.name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id) ORDER BY c.name`)
  const b = rowsOf(e, `SELECT c.name FROM customers c WHERE c.id NOT IN (SELECT customer_id FROM orders) ORDER BY c.name`)
  assert(eq(a, b), 'NOT EXISTS and NOT IN agree')
})
test('decorrelate', 'EXISTS becomes a SemiJoin, NOT EXISTS an AntiJoin', () => {
  const e = seeded()
  assert(explainText(e, `SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)`).includes('SemiJoin'), 'EXISTS → SemiJoin')
  assert(explainText(e, `SELECT c.id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)`).includes('AntiJoin'), 'NOT EXISTS → AntiJoin')
})
test('decorrelate', 'inner-local predicates stay inside the build side', () => {
  const e = seeded()
  const a = rowsOf(e, `SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.quantity > 2) ORDER BY c.name`)
  const b = rowsOf(e, `SELECT DISTINCT c.name FROM customers c JOIN orders o ON o.customer_id = c.id AND o.quantity > 2 ORDER BY c.name`)
  assert(eq(a, b), 'extra inner predicate is honored')
})
test('decorrelate', 'a NULL correlation key: anti keeps it, semi drops it', () => {
  const e = seeded()
  e.execute(`INSERT INTO subscriptions (id, customer_id, plan) VALUES (99, NULL, 'Trial')`)
  assert(eq(rowsOf(e, `SELECT s.id FROM subscriptions s WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = s.customer_id) ORDER BY s.id`), [[99]]), 'anti keeps the NULL-key row')
  assert(scalar(e, `SELECT COUNT(*) FROM subscriptions s WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = s.customer_id)`) === 8, 'semi drops it')
})
test('decorrelate', 'two-key correlation', () => {
  const e = seeded()
  const a = rowsOf(e, `SELECT o.id FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.signup_year = o.order_year) ORDER BY o.id`)
  const b = rowsOf(e, `SELECT DISTINCT o.id FROM orders o JOIN customers c ON c.id = o.customer_id AND c.signup_year = o.order_year ORDER BY o.id`)
  assert(eq(a, b), 'composite correlation key works')
})
test('decorrelate', 'a non-equi correlation falls back and stays correct', () => {
  const e = seeded()
  const sql = `SELECT COUNT(*) FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.quantity > c.signup_year)`
  assert(!explainText(e, sql).includes('SemiJoin'), 'non-equi correlation is not decorrelated')
  assert(scalar(e, sql) === 0, 'fallback per-row evaluation is correct (no order qty > a year)')
})
test('decorrelate', 'uncorrelated EXISTS: non-empty keeps all, empty drops all', () => {
  const e = seeded()
  assert(scalar(e, `SELECT COUNT(*) FROM customers WHERE EXISTS (SELECT 1 FROM orders)`) === 8, 'non-empty → all pass')
  assert(scalar(e, `SELECT COUNT(*) FROM customers WHERE EXISTS (SELECT 1 FROM orders WHERE quantity > 9999)`) === 0, 'empty → none pass')
})
test('decorrelate', 'EXISTS over a view decorrelates too', () => {
  const e = seeded()
  e.execute(`CREATE VIEW big_orders AS SELECT customer_id FROM orders WHERE quantity >= 3`)
  const sql = `SELECT c.name FROM customers c WHERE EXISTS (SELECT 1 FROM big_orders b WHERE b.customer_id = c.id) ORDER BY c.name`
  assert(explainText(e, sql).includes('SemiJoin'), 'a view in the EXISTS body still decorrelates')
  const b = rowsOf(e, `SELECT DISTINCT c.name FROM customers c JOIN orders o ON o.customer_id = c.id AND o.quantity >= 3 ORDER BY c.name`)
  assert(eq(rowsOf(e, sql), b), 'view-backed EXISTS is correct')
})

// --- v8.0: JSON / JSONB -----------------------------------------------------
// `text(e, sql)` reads the first cell as a string (a JSON value renders as its
// canonical serialization via formatValue).
function text(e: Engine, sql: string): string {
  return formatValue(scalar(e, sql))
}

test('json', 'CAST text → JSON normalizes (sorted keys, dedup last-wins)', () => {
  const e = new Engine()
  assert(text(e, `SELECT CAST('{"b":1,"a":2,"a":3}' AS JSON)`) === '{"a":3,"b":1}', 'normalize failed')
  assert(text(e, `SELECT '[1, 2,3 ]'::JSON`) === '[1,2,3]', 'array whitespace not canonicalized')
})
test('json', '::JSON postfix cast and JSONB alias', () => {
  const e = new Engine()
  assert(text(e, `SELECT '{"x":1}'::JSON`) === '{"x":1}', '::JSON failed')
  assert(text(e, `SELECT '{"x":1}'::JSONB`) === '{"x":1}', '::JSONB failed')
})
test('json', 'invalid JSON text is rejected', () => {
  throws(new Engine(), `SELECT '{bad'::JSON`, 'invalid JSON')
})
test('json', '-> extracts a member as JSON; ->> as text', () => {
  const e = new Engine()
  assert(text(e, `SELECT '{"a":{"b":7}}'::JSON -> 'a'`) === '{"b":7}', '-> object key')
  assert(scalar(e, `SELECT '{"a":7}'::JSON ->> 'a'`) === '7', '->> returns text')
  assert(scalar(e, `SELECT '{"a":"hi"}'::JSON ->> 'a'`) === 'hi', '->> unquotes a string')
  assert(scalar(e, `SELECT '{"a":7}'::JSON -> 'missing'`) === null, 'missing key → NULL')
})
test('json', '-> indexes arrays, including negative indices', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT '[10,20,30]'::JSON ->> 0`) === '10', 'index 0')
  assert(scalar(e, `SELECT '[10,20,30]'::JSON ->> -1`) === '30', 'negative index')
  assert(scalar(e, `SELECT '[10,20,30]'::JSON -> 9`) === null, 'out of range → NULL')
})
test('json', '#> / #>> follow a text path', () => {
  const e = new Engine()
  assert(text(e, `SELECT '{"a":{"b":[1,2]}}'::JSON #> '{a,b}'`) === '[1,2]', '#> path')
  assert(scalar(e, `SELECT '{"a":{"b":[1,2]}}'::JSON #>> '{a,b,1}'`) === '2', '#>> leaf')
})
test('json', 'chained extraction binds tighter than arithmetic', () => {
  const e = new Engine()
  // -> binds tighter than +, so this is (… ->> 'n')::int + 1 by coercion.
  assert(scalar(e, `SELECT CAST('{"n":4}'::JSON ->> 'n' AS INTEGER) + 1`) === 5, 'precedence')
})
test('json', '@> containment and <@ (object, array, scalar)', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT '{"a":1,"b":2}'::JSON @> '{"a":1}'`) === true, 'object contains')
  assert(scalar(e, `SELECT '{"a":1}'::JSON @> '{"a":2}'`) === false, 'value mismatch')
  assert(scalar(e, `SELECT '[1,2,3]'::JSON @> '[3,1]'`) === true, 'array contains')
  assert(scalar(e, `SELECT '{"a":1}'::JSON <@ '{"a":1,"b":2}'`) === true, '<@ contained-by')
})
test('json', '? key existence', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT '{"a":1}'::JSON ? 'a'`) === true, 'present')
  assert(scalar(e, `SELECT '{"a":1}'::JSON ? 'b'`) === false, 'absent')
  assert(scalar(e, `SELECT '["x","y"]'::JSON ? 'y'`) === true, 'array string element')
})
test('json', 'JSON_TYPEOF / JSON_ARRAY_LENGTH', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT JSON_TYPEOF('{}'::JSON)`) === 'object', 'object')
  assert(scalar(e, `SELECT JSON_TYPEOF('[]'::JSON)`) === 'array', 'array')
  assert(scalar(e, `SELECT JSON_TYPEOF('"s"'::JSON)`) === 'string', 'string')
  assert(scalar(e, `SELECT JSON_TYPEOF('null'::JSON)`) === 'null', 'null')
  assert(scalar(e, `SELECT JSON_ARRAY_LENGTH('[1,2,3,4]'::JSON)`) === 4, 'length')
  throws(e, `SELECT JSON_ARRAY_LENGTH('{}'::JSON)`, 'array')
})
test('json', 'JSON_BUILD_OBJECT / JSON_BUILD_ARRAY', () => {
  const e = new Engine()
  assert(text(e, `SELECT JSON_BUILD_ARRAY(1, 'two', TRUE, NULL)`) === '[1,"two",true,null]', 'build array')
  assert(text(e, `SELECT JSON_BUILD_OBJECT('id', 1, 'ok', TRUE)`) === '{"id":1,"ok":true}', 'build object')
  throws(e, `SELECT JSON_BUILD_OBJECT('id')`, 'even number')
})
test('json', 'JSON_EXTRACT_PATH(_TEXT) variadic', () => {
  const e = new Engine()
  assert(text(e, `SELECT JSON_EXTRACT_PATH('{"a":{"b":9}}'::JSON, 'a', 'b')`) === '9', 'path → json')
  assert(scalar(e, `SELECT JSON_EXTRACT_PATH_TEXT('{"a":{"b":"z"}}'::JSON, 'a', 'b')`) === 'z', 'path → text')
})
test('json', 'JSON_VALID / JSON_PRETTY / JSON_STRIP_NULLS', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT JSON_VALID('{"a":1}')`) === true, 'valid')
  assert(scalar(e, `SELECT JSON_VALID('{nope')`) === false, 'invalid')
  assert(text(e, `SELECT JSON_STRIP_NULLS('{"a":1,"b":null,"c":3}'::JSON)`) === '{"a":1,"c":3}', 'strip nulls')
  assert(text(e, `SELECT JSON_PRETTY('[1,2]'::JSON)`) === '[\n    1,\n    2\n]', 'pretty')
})
test('json', 'JSONB_SET inserts and replaces, with create flag', () => {
  const e = new Engine()
  assert(text(e, `SELECT JSONB_SET('{"a":1}'::JSON, '{a}', '5'::JSON)`) === '{"a":5}', 'replace')
  assert(text(e, `SELECT JSONB_SET('{"a":1}'::JSON, '{b}', '2'::JSON)`) === '{"a":1,"b":2}', 'insert')
  assert(text(e, `SELECT JSONB_SET('{"a":1}'::JSON, '{b}', '2'::JSON, FALSE)`) === '{"a":1}', 'no create')
  assert(text(e, `SELECT JSONB_SET('[1,2,3]'::JSON, '{1}', '9'::JSON)`) === '[1,9,3]', 'array element')
})
test('json', '|| concatenates arrays and merges objects', () => {
  const e = new Engine()
  assert(text(e, `SELECT '[1,2]'::JSON || '[3,4]'::JSON`) === '[1,2,3,4]', 'array concat')
  assert(text(e, `SELECT '{"a":1}'::JSON || '{"a":2,"b":3}'::JSON`) === '{"a":2,"b":3}', 'object merge, right wins')
})
test('json', 'TO_JSON wraps scalars; JSON parses text', () => {
  const e = new Engine()
  assert(text(e, `SELECT TO_JSON('hi')`) === '"hi"', 'string → json string')
  assert(text(e, `SELECT TO_JSON(42)`) === '42', 'number → json number')
  assert(text(e, `SELECT JSON('[1,2]')`) === '[1,2]', 'JSON() parses')
})
test('json', 'JSON is a first-class stored column (insert / filter / order)', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE docs (id INTEGER PRIMARY KEY, body JSON)`)
  e.execute(`INSERT INTO docs VALUES (1,'{"tag":"x","n":3}'),(2,'{"tag":"y","n":1}'),(3,'{"tag":"x","n":2}')`)
  assert(eq(rowsOf(e, `SELECT id FROM docs WHERE body @> '{"tag":"x"}' ORDER BY id`), [[1], [3]]), '@> filter')
  assert(scalar(e, `SELECT body ->> 'tag' FROM docs ORDER BY CAST(body ->> 'n' AS INTEGER) DESC LIMIT 1`) === 'x', 'order by extracted')
})
test('json', 'GROUP BY a JSON expression + JSON_AGG / JSON_OBJECT_AGG', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE docs (id INTEGER, body JSON)`)
  e.execute(`INSERT INTO docs VALUES (1,'{"tag":"x","n":3}'),(2,'{"tag":"y","n":1}'),(3,'{"tag":"x","n":2}')`)
  const r = rowsOf(e, `SELECT body ->> 'tag' AS tag, JSON_AGG(body -> 'n') AS ns FROM docs GROUP BY body ->> 'tag' ORDER BY tag`)
  assert(formatValue(r[0][1]) === '[3,2]' && formatValue(r[1][1]) === '[1]', 'json_agg per group')
  assert(text(e, `SELECT JSON_OBJECT_AGG(CAST(id AS TEXT), body -> 'n') FROM docs`) === '{"1":3,"2":1,"3":2}', 'json_object_agg')
})
test('json', 'JSON_AGG keeps NULL elements; empty group → NULL', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE t (v JSON)`)
  e.execute(`INSERT INTO t VALUES ('1'),('null'),('3')`)
  assert(text(e, `SELECT JSON_AGG(v) FROM t`) === '[1,null,3]', 'nulls kept')
  assert(scalar(e, `SELECT JSON_AGG(v) FROM t WHERE FALSE`) === null, 'no rows → NULL')
})
test('json', 'equality is deep & key-order independent; DISTINCT dedups', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT '{"a":1,"b":2}'::JSON = '{"b":2,"a":1}'::JSON`) === true, 'deep equal')
  e.execute(`CREATE TABLE t (v JSON)`)
  e.execute(`INSERT INTO t VALUES ('{"a":1,"b":2}'),('{"b":2,"a":1}'),('{"a":2}')`)
  assert(scalar(e, `SELECT COUNT(*) FROM (SELECT DISTINCT v FROM t) q`) === 2, 'DISTINCT over JSON')
})
test('json', 'JSON values index in the B+Tree and round-trip a snapshot', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE t (id INTEGER, v JSON)`)
  e.execute(`CREATE INDEX t_v ON t (v)`)
  e.execute(`INSERT INTO t VALUES (1,'{"a":1}'),(2,'[1,2]'),(3,'"z"')`)
  assert(scalar(e, `SELECT id FROM t WHERE v = '[1,2]'::JSON`) === 2, 'index lookup on JSON key')
  // A localStorage-style round-trip: serialize the snapshot to text and back.
  const snap = JSON.parse(JSON.stringify(e.db.snapshot()))
  e.db = Database.restore(snap)
  assert(scalar(e, `SELECT id FROM t WHERE v @> '{"a":1}'`) === 1, 'JSON survives a snapshot round-trip')
})

test('json', 'set-returning json_array_elements in FROM', () => {
  const e = new Engine()
  assert(eq(rowsOf(e, `SELECT CAST(value AS INTEGER) AS v FROM json_array_elements('[10,20,30]') ORDER BY v`), [[10], [20], [30]]), 'elements')
  assert(scalar(e, `SELECT SUM(CAST(value AS INTEGER)) FROM json_array_elements('[1,2,3,4]')`) === 10, 'aggregate over elements')
  assert(eq(rowsOf(e, `SELECT value FROM json_array_elements_text('["a","b"]') ORDER BY value`), [['a'], ['b']]), 'elements_text')
})
test('json', 'set-returning json_each / json_each_text / json_object_keys', () => {
  const e = new Engine()
  assert(eq(rowsOf(e, `SELECT key, value FROM json_each_text('{"a":"1","b":"x"}') ORDER BY key`), [['a', '1'], ['b', 'x']]), 'each_text')
  assert(scalar(e, `SELECT value FROM json_each('{"a":1,"b":2}') WHERE key = 'b'`) !== null, 'each value is JSON')
  assert(eq(rowsOf(e, `SELECT key FROM json_object_keys('{"z":1,"a":2}') ORDER BY key`), [['a'], ['z']]), 'object_keys')
})
test('json', 'a table function joins/aliases like any relation', () => {
  const e = new Engine()
  const r = rowsOf(e, `SELECT t.value ->> 'name' AS nm FROM json_array_elements('[{"name":"Ann"},{"name":"Bob"}]') AS t ORDER BY nm`)
  assert(eq(r, [['Ann'], ['Bob']]), 'alias + arrow on a function source')
})
test('json', 'json_array_elements over a non-array errors', () => {
  throws(new Engine(), `SELECT value FROM json_array_elements('{"a":1}')`, 'array')
})
test('json', 'KEY is a usable identifier (non-reserved)', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE kv (key TEXT, val INTEGER)`)
  e.execute(`INSERT INTO kv VALUES ('a', 1), ('b', 2)`)
  assert(scalar(e, `SELECT val FROM kv WHERE key = 'b'`) === 2, 'column named key works')
  // …and PRIMARY KEY / FOREIGN KEY still parse.
  e.execute(`CREATE TABLE pk (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES pk(id))`)
  assert(scalar(e, `SELECT COUNT(*) FROM pk`) === 0, 'PRIMARY/FOREIGN KEY still parse')
})

// --- full-text search -------------------------------------------------------
// A small post corpus shared by the FTS engine tests.
function ftsTable(): Engine {
  const e = new Engine()
  e.execute(`CREATE TABLE posts (id INTEGER PRIMARY KEY, body TSVECTOR)`)
  e.execute(`INSERT INTO posts VALUES
    (1, to_tsvector('The quick brown fox jumps over the lazy dog')),
    (2, to_tsvector('A fat cat sat on the mat')),
    (3, to_tsvector('Foxes are quick and clever animals')),
    (4, to_tsvector('Databases run queries quickly'))`)
  return e
}

test('fts', 'Porter stemmer matches the canonical reference vocabulary', () => {
  const pairs: [string, string][] = [
    ['running', 'run'], ['cats', 'cat'], ['ponies', 'poni'], ['caresses', 'caress'],
    ['national', 'nation'], ['relational', 'relat'], ['conditional', 'condit'],
    ['agreed', 'agre'], ['plastered', 'plaster'], ['motoring', 'motor'], ['sing', 'sing'],
    ['hopping', 'hop'], ['falling', 'fall'], ['controlling', 'control'],
    ['happily', 'happili'], ['probate', 'probat'], ['rate', 'rate'], ['cease', 'ceas'],
  ]
  for (const [w, want] of pairs) assert(porterStem(w) === want, `stem(${w})=${porterStem(w)} want ${want}`)
})

test('fts', 'to_tsvector normalizes, stems, drops stop-words and records positions', () => {
  assert(formatTsVector(toTsVector('The quick brown foxes jumped')) === "'brown':3 'fox':4 'jump':5 'quick':2", 'vector text')
})

test('fts', '@@ does boolean AND/OR/NOT matching', () => {
  const e = ftsTable()
  // 'quickly' stems to 'quickli' (Porter 1980 has no bare -ly rule), so only
  // posts 1 and 3 carry the lexeme 'quick'.
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('quick') ORDER BY id`).map((r) => r[0]), [1, 3]), 'quick')
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('fox & lazy')`).map((r) => r[0]), [1]), 'fox & lazy')
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('cat | clever') ORDER BY id`).map((r) => r[0]), [2, 3]), 'or')
  // Posts 1 and 3 carry 'quick', but both also carry 'fox'/'foxes' → none survive.
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('quick & !fox') ORDER BY id`).map((r) => r[0]), []), 'and not')
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('clever & !fox')`).map((r) => r[0]), []), 'clever but fox')
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('cat & !dog')`).map((r) => r[0]), [2]), 'cat not dog')
})

test('fts', 'phrase (<->) and distance (<N>) require positional adjacency', () => {
  assert(tsMatch(toTsVector('the fat cat'), toTsQuery('fat <-> cat')) === true, 'adjacent')
  assert(tsMatch(toTsVector('the cat is fat'), toTsQuery('fat <-> cat')) === false, 'not adjacent')
  assert(tsMatch(toTsVector('the fat lazy cat'), toTsQuery('fat <2> cat')) === true, 'distance 2')
  assert(tsMatch(toTsVector('quick brown fox'), toTsQuery('quick <-> brown <-> fox')) === true, 'chained phrase')
})

test('fts', 'prefix (:*) and weight-filtered (:A) lexemes match', () => {
  assert(tsMatch(toTsVector('postgresql rocks'), toTsQuery('postgr:*')) === true, 'prefix')
  assert(tsMatch(setWeight(toTsVector('cat'), 'A'), toTsQuery('cat:A')) === true, 'weight A matches')
  assert(tsMatch(setWeight(toTsVector('cat'), 'B'), toTsQuery('cat:A')) === false, 'weight B excluded')
})

test('fts', 'plainto / phraseto / websearch query builders', () => {
  assert(formatTsQuery(plainToTsQuery('the fat cats')) === "'fat' & 'cat'", 'plainto')
  assert(formatTsQuery(phraseToTsQuery('fat cats')) === "'fat' <-> 'cat'", 'phraseto')
  assert(formatTsQuery(webSearchToTsQuery('cats -dogs')) === "'cat' & !'dog'", 'websearch -')
  assert(formatTsQuery(webSearchToTsQuery('cat or dog')) === "'cat' | 'dog'", 'websearch or')
  assert(formatTsQuery(webSearchToTsQuery('"fat cat"')) === "'fat' <-> 'cat'", 'websearch phrase')
})

test('fts', 'ts_rank scores matches, weighted higher for A-labelled positions', () => {
  const plain = tsRank(toTsVector('fat cat'), toTsQuery('cat'))
  const heavy = tsRank(setWeight(toTsVector('cat'), 'A'), toTsQuery('cat'))
  assert(plain > 0 && heavy > plain, `rank ${plain} < ${heavy}`)
  const e = ftsTable()
  const ranked = rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('quick') ORDER BY ts_rank(body, to_tsquery('quick')) DESC, id`)
  assert(ranked.length === 2, 'ranked rows')
})

test('fts', 'ts_headline wraps the matched words in the original text', () => {
  assert(scalar(ftsTable(), `SELECT ts_headline('The fat cat sat', to_tsquery('cat'))`) === 'The fat <b>cat</b> sat', 'headline')
})

test('fts', 'tsvector concatenation shifts positions so phrases span the join', () => {
  const c = concatTsVector(toTsVector('fat cat'), toTsVector('big dog'))
  assert(tsMatch(c, toTsQuery('cat <-> big')) === true, 'phrase across join')
  assert(formatTsVector(stripTsVector(toTsVector('fat cat'))) === "'cat' 'fat'", 'strip drops positions')
})

test('fts', 'tsvector / tsquery casts, equality, ordering and numnode', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT 'fat cat'::tsvector @@ 'cat'::tsquery`) === true, 'cast + match')
  // strip() drops positions, so two documents with the same lexemes compare equal.
  assert(scalar(e, `SELECT strip(to_tsvector('a fat cat')) = strip(to_tsvector('cats and fat'))`) === true, 'equality after stemming')
  assert(numNode(toTsQuery('cat & dog | bird')) === 5, 'numnode')
  assert(formatTsVector(parseTsVector("'cat':3 'fat':2A,4")) === "'cat':3 'fat':2A,4", 'parse round-trip')
})

test('fts', 'tsvector is a first-class stored column (insert / filter / group / order)', () => {
  const e = ftsTable()
  assert(scalar(e, `SELECT COUNT(*) FROM posts WHERE body @@ to_tsquery('fox')`) === 2, 'count matches')
  // GROUP BY / DISTINCT over a tsvector column works through the value plumbing.
  assert(scalar(e, `SELECT COUNT(DISTINCT body) FROM posts`) === 4, 'distinct vectors')
})

test('fts', 'a GIN index gives the same answers as a sequential scan', () => {
  const queries = [
    `body @@ to_tsquery('quick')`,
    `body @@ to_tsquery('fox & lazy')`,
    `body @@ to_tsquery('cat | clever')`,
    `body @@ to_tsquery('quick & !fox')`,
    `body @@ to_tsquery('quick:*')`,
    `body @@ plainto_tsquery('quick database')`,
  ]
  const seq = ftsTable()
  const gin = ftsTable()
  gin.execute(`CREATE INDEX posts_gin ON posts USING GIN (body)`)
  for (const q of queries) {
    const a = rowsOf(seq, `SELECT id FROM posts WHERE ${q} ORDER BY id`).map((r) => r[0])
    const b = rowsOf(gin, `SELECT id FROM posts WHERE ${q} ORDER BY id`).map((r) => r[0])
    assert(eq(a, b), `GIN vs seq mismatch on "${q}": ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
})

test('fts', 'EXPLAIN chooses a GinScan once a GIN index exists', () => {
  const e = ftsTable()
  e.execute(`CREATE INDEX posts_gin ON posts USING GIN (body)`)
  const r = lastResult(e, `EXPLAIN SELECT id FROM posts WHERE body @@ to_tsquery('quick')`)
  const text = JSON.stringify(r)
  assert(text.includes('GinScan'), 'plan should contain GinScan')
})

test('fts', 'a GIN index is maintained across INSERT / UPDATE / DELETE', () => {
  const e = ftsTable()
  e.execute(`CREATE INDEX posts_gin ON posts USING GIN (body)`)
  e.execute(`UPDATE posts SET body = to_tsvector('now about penguins') WHERE id = 1`)
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('penguin')`).map((r) => r[0]), [1]), 'update reindexed')
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('fox') ORDER BY id`).map((r) => r[0]), [3]), 'old lexeme gone')
  e.execute(`INSERT INTO posts VALUES (5, to_tsvector('a quick penguin'))`)
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('penguin') ORDER BY id`).map((r) => r[0]), [1, 5]), 'insert indexed')
  e.execute(`DELETE FROM posts WHERE id = 1`)
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE body @@ to_tsquery('penguin')`).map((r) => r[0]), [5]), 'delete deindexed')
})

test('fts', 'a GIN index survives a snapshot round-trip', () => {
  const e = ftsTable()
  e.execute(`CREATE INDEX posts_gin ON posts USING GIN (body)`)
  const snap = JSON.parse(JSON.stringify(e.db.snapshot()))
  const e2 = new Engine(Database.restore(snap))
  const r = lastResult(e2, `EXPLAIN SELECT id FROM posts WHERE body @@ to_tsquery('fox')`)
  assert(JSON.stringify(r).includes('GinScan'), 'restored GIN index still planned')
  assert(eq(rowsOf(e2, `SELECT id FROM posts WHERE body @@ to_tsquery('fox') ORDER BY id`).map((r) => r[0]), [1, 3]), 'restored results')
})

// --- v11: RETURNING ---------------------------------------------------------
function retEngine(): Engine {
  const e = new Engine()
  e.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER DEFAULT 0)`)
  return e
}
test('returning', 'INSERT … RETURNING projects the inserted rows (incl. DEFAULT)', () => {
  const e = retEngine()
  const r = lastResult(e, `INSERT INTO t (id, name) VALUES (1,'a'),(2,'b') RETURNING id, name, qty`) as RowsResult
  assert(r.kind === 'rows', 'RETURNING yields a rows result')
  assert(eq(r.rows, [[1, 'a', 0], [2, 'b', 0]]), 'inserted rows with default qty=0 returned')
  assert(eq(r.columns.map((c) => c.name), ['id', 'name', 'qty']), 'column names from RETURNING list')
})
test('returning', 'INSERT … RETURNING * returns all columns', () => {
  const e = retEngine()
  const r = lastResult(e, `INSERT INTO t VALUES (1,'a',5) RETURNING *`) as RowsResult
  assert(eq(r.rows, [[1, 'a', 5]]), 'star returns every column')
})
test('returning', 'INSERT … RETURNING can compute expressions', () => {
  const e = retEngine()
  assert(scalar(e, `INSERT INTO t VALUES (1,'a',5) RETURNING qty * 2 AS d`) === 10, 'expression in RETURNING')
})
test('returning', 'UPDATE … RETURNING projects the NEW row image', () => {
  const e = retEngine()
  e.execute(`INSERT INTO t VALUES (1,'a',5),(2,'b',7)`)
  const r = lastResult(e, `UPDATE t SET qty = qty + 100 WHERE id = 1 RETURNING id, qty`) as RowsResult
  assert(eq(r.rows, [[1, 105]]), 'UPDATE RETURNING shows the post-update value')
})
test('returning', 'DELETE … RETURNING projects the OLD row image', () => {
  const e = retEngine()
  e.execute(`INSERT INTO t VALUES (1,'a',5),(2,'b',7)`)
  const r = lastResult(e, `DELETE FROM t WHERE id = 2 RETURNING id, name`) as RowsResult
  assert(eq(r.rows, [[2, 'b']]), 'DELETE RETURNING shows the deleted row')
  assert(scalar(e, `SELECT COUNT(*) FROM t`) === 1, 'row really gone')
})
test('returning', 'INSERT … SELECT … RETURNING', () => {
  const e = retEngine()
  e.execute(`CREATE TABLE src (id INTEGER, name TEXT)`)
  e.execute(`INSERT INTO src VALUES (1,'x'),(2,'y')`)
  const r = lastResult(e, `INSERT INTO t (id, name) SELECT id, name FROM src RETURNING id`) as RowsResult
  assert(eq(r.rows.map((row) => row[0]).sort(), [1, 2]), 'RETURNING over INSERT…SELECT')
})
test('returning', 'ON CONFLICT DO UPDATE … RETURNING returns the updated row', () => {
  const e = retEngine()
  e.execute(`INSERT INTO t VALUES (1,'a',5)`)
  const r = lastResult(e, `INSERT INTO t VALUES (1,'a',99) ON CONFLICT (id) DO UPDATE SET qty = EXCLUDED.qty RETURNING qty`) as RowsResult
  assert(eq(r.rows, [[99]]), 'upsert RETURNING shows the updated value')
})
test('returning', 'DELETE … RETURNING * with no match returns no rows', () => {
  const e = retEngine()
  e.execute(`INSERT INTO t VALUES (1,'a',5)`)
  const r = lastResult(e, `DELETE FROM t WHERE id = 999 RETURNING *`) as RowsResult
  assert(r.kind === 'rows' && r.rows.length === 0, 'empty RETURNING result')
})

// --- v11: MERGE -------------------------------------------------------------
function mergeEngine(): Engine {
  const e = new Engine()
  e.execute(`CREATE TABLE tgt (id INTEGER PRIMARY KEY, val INTEGER)`)
  e.execute(`INSERT INTO tgt VALUES (1,100),(2,200),(3,300)`)
  e.execute(`CREATE TABLE src (id INTEGER PRIMARY KEY, val INTEGER)`)
  e.execute(`INSERT INTO src VALUES (2,222),(3,0),(4,444)`)
  return e
}
test('merge', 'MERGE updates matched, inserts unmatched, deletes on a condition', () => {
  const e = mergeEngine()
  e.execute(`MERGE INTO tgt USING src ON tgt.id = src.id
    WHEN MATCHED AND src.val = 0 THEN DELETE
    WHEN MATCHED THEN UPDATE SET val = src.val
    WHEN NOT MATCHED THEN INSERT (id, val) VALUES (src.id, src.val)`)
  assert(eq(rowsOf(e, `SELECT * FROM tgt ORDER BY id`), [[1, 100], [2, 222], [4, 444]]), 'merge result: 1 kept, 2 updated, 3 deleted, 4 inserted')
})
test('merge', 'MERGE first-applicable WHEN wins', () => {
  const e = mergeEngine()
  e.execute(`MERGE INTO tgt USING src ON tgt.id = src.id
    WHEN MATCHED THEN UPDATE SET val = -1
    WHEN MATCHED AND src.val = 0 THEN DELETE`)
  // Every matched row hits the first arm (UPDATE) — the DELETE arm never fires.
  assert(scalar(e, `SELECT COUNT(*) FROM tgt WHERE val = -1`) === 2, 'rows 2 and 3 updated to -1')
  assert(scalar(e, `SELECT COUNT(*) FROM tgt`) === 3, 'nothing deleted')
})
test('merge', 'MERGE from a VALUES source', () => {
  const e = mergeEngine()
  e.execute(`MERGE INTO tgt USING (VALUES (1, 11), (9, 99)) AS s(id, val) ON tgt.id = s.id
    WHEN MATCHED THEN UPDATE SET val = s.val
    WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val)`)
  assert(scalar(e, `SELECT val FROM tgt WHERE id = 1`) === 11, 'updated from VALUES')
  assert(scalar(e, `SELECT val FROM tgt WHERE id = 9`) === 99, 'inserted from VALUES')
})
test('merge', 'WHEN NOT MATCHED BY SOURCE prunes target rows', () => {
  const e = mergeEngine()
  e.execute(`MERGE INTO tgt USING (SELECT 1 AS id) s ON tgt.id = s.id
    WHEN MATCHED THEN UPDATE SET val = 999
    WHEN NOT MATCHED BY SOURCE THEN DELETE`)
  assert(eq(rowsOf(e, `SELECT * FROM tgt ORDER BY id`), [[1, 999]]), 'only the matched row remains, updated')
})
test('merge', 'MERGE … RETURNING returns the affected rows', () => {
  const e = mergeEngine()
  const r = lastResult(e, `MERGE INTO tgt USING src ON tgt.id = src.id
    WHEN MATCHED AND src.val = 0 THEN DELETE
    WHEN MATCHED THEN UPDATE SET val = src.val
    WHEN NOT MATCHED THEN INSERT (id, val) VALUES (src.id, src.val)
    RETURNING id, val`) as RowsResult
  assert(r.kind === 'rows', 'MERGE RETURNING yields rows')
  // updated (2,222), deleted (3,300 old image), inserted (4,444).
  assert(eq([...r.rows].sort((a, b) => (a[0] as number) - (b[0] as number)), [[2, 222], [3, 300], [4, 444]]), 'affected rows returned')
})
test('merge', 'MERGE INSERT DEFAULT VALUES uses column defaults', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE tg (id INTEGER PRIMARY KEY, n INTEGER DEFAULT 7)`)
  e.execute(`CREATE TABLE sr (id INTEGER)`)
  e.execute(`INSERT INTO sr VALUES (1)`)
  e.execute(`MERGE INTO tg USING sr ON tg.id = sr.id WHEN NOT MATCHED THEN INSERT (id) VALUES (sr.id)`)
  assert(scalar(e, `SELECT n FROM tg WHERE id = 1`) === 7, 'default applied to omitted column')
})
test('merge', 'MERGE is atomic — a cardinality violation rolls back', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE tg (id INTEGER PRIMARY KEY, val INTEGER)`)
  e.execute(`INSERT INTO tg VALUES (1, 0)`)
  // Two source rows both match the single target row → cannot affect it twice.
  e.execute(`CREATE TABLE sr (k INTEGER)`)
  e.execute(`INSERT INTO sr VALUES (1), (2)`)
  throws(e, `MERGE INTO tg USING sr ON tg.id = 1 WHEN MATCHED THEN UPDATE SET val = sr.k`, 'more than once')
  assert(scalar(e, `SELECT val FROM tg WHERE id = 1`) === 0, 'target unchanged after rollback')
})
test('merge', 'MERGE INSERT cannot appear in a WHEN MATCHED clause', () => {
  const e = mergeEngine()
  throws(e, `MERGE INTO tgt USING src ON tgt.id = src.id WHEN MATCHED THEN INSERT (id) VALUES (1)`, 'WHEN NOT MATCHED')
})

// --- v11: SAVEPOINTs --------------------------------------------------------
test('savepoint', 'ROLLBACK TO SAVEPOINT undoes only the later work', () => {
  const e = fresh(`CREATE TABLE s (id INTEGER)`)
  e.execute(`BEGIN`)
  e.execute(`INSERT INTO s VALUES (1)`)
  e.execute(`SAVEPOINT sp1`)
  e.execute(`INSERT INTO s VALUES (2)`)
  e.execute(`ROLLBACK TO SAVEPOINT sp1`)
  e.execute(`INSERT INTO s VALUES (3)`)
  e.execute(`COMMIT`)
  assert(eq(rowsOf(e, `SELECT id FROM s ORDER BY id`).map((r) => r[0]), [1, 3]), 'savepoint rolled back the (2) insert')
})
test('savepoint', 'ROLLBACK TO can be used repeatedly (savepoint survives)', () => {
  const e = fresh(`CREATE TABLE s (id INTEGER)`)
  e.execute(`BEGIN; INSERT INTO s VALUES (1); SAVEPOINT sp`)
  e.execute(`INSERT INTO s VALUES (2); ROLLBACK TO sp`)
  e.execute(`INSERT INTO s VALUES (3); ROLLBACK TO sp`)
  e.execute(`COMMIT`)
  assert(eq(rowsOf(e, `SELECT id FROM s`).map((r) => r[0]), [1]), 'both later inserts rolled back')
})
test('savepoint', 'RELEASE SAVEPOINT keeps the work, drops the point', () => {
  const e = fresh(`CREATE TABLE s (id INTEGER)`)
  e.execute(`BEGIN; INSERT INTO s VALUES (1); SAVEPOINT sp; INSERT INTO s VALUES (2); RELEASE SAVEPOINT sp; COMMIT`)
  assert(scalar(e, `SELECT COUNT(*) FROM s`) === 2, 'released savepoint kept both rows')
  throws(e, `BEGIN; ROLLBACK TO sp`, 'does not exist')
})
test('savepoint', 'a final ROLLBACK still undoes everything', () => {
  const e = fresh(`CREATE TABLE s (id INTEGER)`)
  e.execute(`BEGIN; INSERT INTO s VALUES (1); SAVEPOINT sp; INSERT INTO s VALUES (2); ROLLBACK`)
  assert(scalar(e, `SELECT COUNT(*) FROM s`) === 0, 'outer ROLLBACK discards all')
})
test('savepoint', 'SAVEPOINT outside a transaction errors', () => {
  const e = fresh(`CREATE TABLE s (id INTEGER)`)
  throws(e, `SAVEPOINT sp`, 'transaction')
})

// --- v11: TRUNCATE ----------------------------------------------------------
test('truncate', 'TRUNCATE empties a table', () => {
  const e = fresh(`CREATE TABLE t (id INTEGER PRIMARY KEY)`)
  e.execute(`INSERT INTO t VALUES (1),(2),(3)`)
  e.execute(`TRUNCATE TABLE t`)
  assert(scalar(e, `SELECT COUNT(*) FROM t`) === 0, 'table emptied')
})
test('truncate', 'TRUNCATE RESTART IDENTITY resets the rowid counter', () => {
  // Indirectly observable: a UNIQUE index over the heap is rebuilt empty, so a
  // re-insert of a previously-present key succeeds.
  const e = fresh(`CREATE TABLE t (id INTEGER PRIMARY KEY)`)
  e.execute(`INSERT INTO t VALUES (1),(2)`)
  e.execute(`TRUNCATE TABLE t RESTART IDENTITY`)
  e.execute(`INSERT INTO t VALUES (1)`)
  assert(scalar(e, `SELECT COUNT(*) FROM t`) === 1, 're-insert after truncate works')
})
test('truncate', 'TRUNCATE of a referenced table needs CASCADE', () => {
  const e = fresh(`CREATE TABLE p (id INTEGER PRIMARY KEY)`)
  e.execute(`CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))`)
  e.execute(`INSERT INTO p VALUES (1),(2); INSERT INTO c VALUES (10,1)`)
  throws(e, `TRUNCATE TABLE p`, 'CASCADE')
  e.execute(`TRUNCATE TABLE p CASCADE`)
  assert(scalar(e, `SELECT COUNT(*) FROM p`) === 0 && scalar(e, `SELECT COUNT(*) FROM c`) === 0, 'parent and child both emptied')
})
test('truncate', 'TRUNCATE several tables at once', () => {
  const e = fresh(`CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER)`)
  e.execute(`INSERT INTO a VALUES (1); INSERT INTO b VALUES (1),(2)`)
  e.execute(`TRUNCATE a, b`)
  assert(scalar(e, `SELECT COUNT(*) FROM a`) === 0 && scalar(e, `SELECT COUNT(*) FROM b`) === 0, 'both truncated')
})
test('truncate', 'TRUNCATE keeps indexes usable', () => {
  const e = fresh(`CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER)`)
  e.execute(`CREATE INDEX idx_k ON t (k)`)
  e.execute(`INSERT INTO t VALUES (1,10),(2,20)`)
  e.execute(`TRUNCATE TABLE t`)
  e.execute(`INSERT INTO t VALUES (1,10)`)
  assert(scalar(e, `SELECT id FROM t WHERE k = 10`) === 1, 'index still works post-truncate')
})

// --- v11: LATERAL -----------------------------------------------------------
function latEngine(): Engine {
  const e = new Engine()
  e.execute(`CREATE TABLE emp (id INTEGER, name TEXT, salary INTEGER)`)
  e.execute(`INSERT INTO emp VALUES (1,'a',100),(2,'b',200),(3,'c',300)`)
  return e
}
test('lateral', 'LATERAL subquery sees the outer row (comma syntax)', () => {
  const e = latEngine()
  const rows = rowsOf(e, `SELECT name, hi FROM emp e, LATERAL (SELECT salary * 2 AS hi) x ORDER BY name`)
  assert(eq(rows, [['a', 200], ['b', 400], ['c', 600]]), 'lateral derived column from outer salary')
})
test('lateral', 'correlated JOIN LATERAL filters per outer row', () => {
  const e = latEngine()
  const rows = rowsOf(e,
    `SELECT e.name, peer.name AS cheaper
     FROM emp e JOIN LATERAL (SELECT name FROM emp p WHERE p.salary < e.salary) peer ON TRUE
     ORDER BY e.name, cheaper`)
  assert(eq(rows, [['b', 'a'], ['c', 'a'], ['c', 'b']]), 'each row paired with the cheaper peers')
})
test('lateral', 'LEFT JOIN LATERAL null-extends an empty right side', () => {
  const e = latEngine()
  const rows = rowsOf(e,
    `SELECT e.name, peer.name AS cheaper
     FROM emp e LEFT JOIN LATERAL (SELECT name FROM emp p WHERE p.salary < e.salary) peer ON TRUE
     ORDER BY e.name, cheaper`)
  assert(eq(rows, [['a', null], ['b', 'a'], ['c', 'a'], ['c', 'b']]), 'cheapest employee keeps a NULL peer')
})
test('lateral', 'LATERAL agrees with a correlated scalar subquery', () => {
  const e = latEngine()
  const viaLateral = rowsOf(e,
    `SELECT e.name, c.n FROM emp e JOIN LATERAL (SELECT COUNT(*) AS n FROM emp p WHERE p.salary <= e.salary) c ON TRUE ORDER BY e.name`)
  const viaScalar = rowsOf(e,
    `SELECT e.name, (SELECT COUNT(*) FROM emp p WHERE p.salary <= e.salary) AS n FROM emp e ORDER BY e.name`)
  assert(eq(viaLateral, viaScalar), 'lateral count matches the scalar-subquery count')
})
test('lateral', 'LATERAL table function unnests a column', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE docs (id INTEGER, tags JSON)`)
  e.execute(`INSERT INTO docs VALUES (1, '[10, 20]'), (2, '[30]')`)
  const rows = rowsOf(e,
    `SELECT d.id, elem.value FROM docs d, LATERAL json_array_elements(d.tags) elem ORDER BY d.id, elem.value`)
  assert(rows.length === 3, 'two tags from doc 1, one from doc 2')
  assert(JSON.stringify(rows[0]) === JSON.stringify([1, { t: 'json', v: 10 }]), 'first unnested element')
})

// --- arrays -----------------------------------------------------------------
test('arrays', 'ARRAY[…] constructor and text rendering', () => {
  const e = new Engine()
  assert(formatValue(scalar(e, 'SELECT ARRAY[1,2,3]')) === '{1,2,3}', 'array renders as {1,2,3}')
  assert(formatValue(scalar(e, `SELECT ARRAY['a','b c']`)) === '{a,"b c"}', 'text element with a space is quoted')
  assert(formatValue(scalar(e, 'SELECT ARRAY[]::int[]')) === '{}', 'empty array renders as {}')
})
test('arrays', '1-based subscript and slice', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT (ARRAY[10,20,30])[1]') === 10, 'subscript is 1-based')
  assert(scalar(e, 'SELECT (ARRAY[10,20,30])[3]') === 30, 'last element')
  assert(scalar(e, 'SELECT (ARRAY[10,20,30])[9]') === null, 'out-of-range subscript is NULL')
  assert(scalar(e, 'SELECT (ARRAY[10,20,30])[0]') === null, 'subscript 0 is NULL (1-based)')
  assert(formatValue(scalar(e, 'SELECT (ARRAY[1,2,3,4,5])[2:4]')) === '{2,3,4}', 'inclusive slice')
  assert(formatValue(scalar(e, 'SELECT (ARRAY[1,2,3])[2:]')) === '{2,3}', 'open-ended upper slice')
  assert(formatValue(scalar(e, 'SELECT (ARRAY[1,2,3])[:2]')) === '{1,2}', 'open-ended lower slice')
})
test('arrays', "text literal '{…}'::T[] parses and coerces elements", () => {
  const e = new Engine()
  assert(formatValue(scalar(e, `SELECT '{1,2,3}'::int[]`)) === '{1,2,3}', 'int array literal')
  // The elements are real integers (not text), so a numeric subscript compares.
  assert(scalar(e, `SELECT ('{1,2,3}'::int[])[2] + 100`) === 102, 'parsed elements are integers')
  assert(formatValue(scalar(e, `SELECT '{a,"b,c",NULL}'::text[]`)) === '{a,"b,c",NULL}', 'quoting + NULL round-trip')
})
test('arrays', 'length / cardinality / ndims / dims', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT array_length(ARRAY[1,2,3], 1)') === 3, 'array_length')
  assert(scalar(e, 'SELECT array_length(ARRAY[]::int[], 1)') === null, 'empty array length is NULL')
  assert(scalar(e, 'SELECT cardinality(ARRAY[ARRAY[1,2],ARRAY[3,4]])') === 4, 'cardinality counts all leaves')
  assert(scalar(e, 'SELECT array_ndims(ARRAY[ARRAY[1,2],ARRAY[3,4]])') === 2, 'nested array is 2-D')
  assert(scalar(e, 'SELECT array_dims(ARRAY[ARRAY[1,2,3],ARRAY[4,5,6]])') === '[1:2][1:3]', 'rectangular dims')
  assert(scalar(e, 'SELECT array_upper(ARRAY[5,6,7],1)') === 3 && scalar(e, 'SELECT array_lower(ARRAY[5,6,7],1)') === 1, 'bounds')
})
test('arrays', '|| concatenates (array, element, and mixed)', () => {
  const e = new Engine()
  assert(formatValue(scalar(e, 'SELECT ARRAY[1,2] || ARRAY[3,4]')) === '{1,2,3,4}', 'array || array')
  assert(formatValue(scalar(e, 'SELECT ARRAY[1,2] || 3')) === '{1,2,3}', 'array || element')
  assert(formatValue(scalar(e, 'SELECT 0 || ARRAY[1,2]')) === '{0,1,2}', 'element || array')
})
test('arrays', 'append / prepend / cat / remove / replace functions', () => {
  const e = new Engine()
  assert(formatValue(scalar(e, 'SELECT array_append(ARRAY[1,2], 3)')) === '{1,2,3}', 'append')
  assert(formatValue(scalar(e, 'SELECT array_prepend(0, ARRAY[1,2])')) === '{0,1,2}', 'prepend')
  assert(formatValue(scalar(e, 'SELECT array_cat(ARRAY[1], ARRAY[2,3])')) === '{1,2,3}', 'cat')
  assert(formatValue(scalar(e, 'SELECT array_remove(ARRAY[1,2,1,3], 1)')) === '{2,3}', 'remove all matches')
  assert(formatValue(scalar(e, 'SELECT array_replace(ARRAY[1,2,1], 1, 9)')) === '{9,2,9}', 'replace all matches')
  assert(formatValue(scalar(e, 'SELECT trim_array(ARRAY[1,2,3,4], 2)')) === '{1,2}', 'trim_array drops the tail')
  // array_append onto NULL yields a singleton, matching Postgres.
  assert(formatValue(scalar(e, 'SELECT array_append(NULL, 7)')) === '{7}', 'append onto NULL')
})
test('arrays', 'position / positions', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT array_position(ARRAY[10,20,30], 20)') === 2, 'position is 1-based')
  assert(scalar(e, 'SELECT array_position(ARRAY[10,20,30], 99)') === null, 'absent value is NULL')
  assert(formatValue(scalar(e, 'SELECT array_positions(ARRAY[1,2,1,3,1], 1)')) === '{1,3,5}', 'all positions')
})
test('arrays', 'array_to_string / string_to_array', () => {
  const e = new Engine()
  assert(scalar(e, `SELECT array_to_string(ARRAY[1,2,3], '-')`) === '1-2-3', 'join')
  assert(scalar(e, `SELECT array_to_string(ARRAY[1,NULL,3], '-', '?')`) === '1-?-3', 'NULL replacement string')
  assert(scalar(e, `SELECT array_to_string(ARRAY[1,NULL,3], '-')`) === '1-3', 'NULLs omitted without a null-string')
  assert(formatValue(scalar(e, `SELECT string_to_array('a,b,c', ',')`)) === '{a,b,c}', 'split')
  assert(formatValue(scalar(e, `SELECT string_to_array('axbxc', 'x')`)) === '{a,b,c}', 'multi-char delimiter')
})
test('arrays', '= ANY / ALL with three-valued logic', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT 2 = ANY(ARRAY[1,2,3])') === true, 'ANY hit')
  assert(scalar(e, 'SELECT 5 = ANY(ARRAY[1,2,3])') === false, 'ANY miss')
  assert(scalar(e, 'SELECT 9 > ALL(ARRAY[1,2,3])') === true, 'ALL greater')
  assert(scalar(e, 'SELECT 2 > ALL(ARRAY[1,2,3])') === false, 'ALL not all-greater')
  assert(scalar(e, 'SELECT 1 = ANY(ARRAY[]::int[])') === false, 'ANY over empty is false')
  assert(scalar(e, 'SELECT 1 <> ALL(ARRAY[]::int[])') === true, 'ALL over empty is true')
  assert(scalar(e, 'SELECT 5 = ANY(ARRAY[1,NULL,2])') === null, 'no match + a NULL element is NULL')
  assert(scalar(e, 'SELECT 2 = ANY(ARRAY[1,NULL,2])') === true, 'a hit short-circuits past NULLs')
})
test('arrays', 'containment (@>, <@) and overlap (&&)', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT ARRAY[1,2,3] @> ARRAY[2,3]') === true, 'contains')
  assert(scalar(e, 'SELECT ARRAY[1,2] @> ARRAY[2,3]') === false, 'not contains')
  assert(scalar(e, 'SELECT ARRAY[2,3] <@ ARRAY[1,2,3]') === true, 'contained by')
  assert(scalar(e, 'SELECT ARRAY[1,2] && ARRAY[2,3]') === true, 'overlap')
  assert(scalar(e, 'SELECT ARRAY[1,2] && ARRAY[3,4]') === false, 'no overlap')
})
test('arrays', 'ordering: element-wise then shorter-prefix-first', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT ARRAY[1,2,3] = ARRAY[1,2,3]') === true, 'equal arrays')
  assert(scalar(e, 'SELECT ARRAY[1,2] < ARRAY[1,2,3]') === true, 'a prefix sorts first')
  assert(scalar(e, 'SELECT ARRAY[1,3] > ARRAY[1,2,9]') === true, 'first differing element wins')
})
test('arrays', 'unnest and generate_subscripts in FROM', () => {
  const e = new Engine()
  const rows = rowsOf(e, `SELECT v FROM unnest(ARRAY[10,20,30]) AS t(v) ORDER BY v`)
  assert(eq(rows, [[10], [20], [30]]), 'unnest yields one row per element')
  const subs = rowsOf(e, `SELECT i FROM generate_subscripts(ARRAY[5,6,7], 1) AS g(i) ORDER BY i`)
  assert(eq(subs, [[1], [2], [3]]), 'generate_subscripts yields the index series')
  // unnest correlated via LATERAL over a real array column.
  e.execute(`CREATE TABLE post (id INT, tags TEXT[])`)
  e.execute(`INSERT INTO post VALUES (1, ARRAY['a','b']), (2, ARRAY['c'])`)
  const lat = rowsOf(e, `SELECT p.id, u.tag FROM post p, LATERAL unnest(p.tags) AS u(tag) ORDER BY p.id, u.tag`)
  assert(lat.length === 3, 'three (post, tag) pairs')
})
test('arrays', 'array_agg (ordered, DISTINCT, empty → NULL)', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE t(g INT, v INT)`)
  e.execute(`INSERT INTO t VALUES (1,10),(1,20),(2,30),(2,30)`)
  const r = rowsOf(e, `SELECT g, array_agg(v) FROM t GROUP BY g ORDER BY g`)
  assert(formatValue(r[0][1]) === '{10,20}' && formatValue(r[1][1]) === '{30,30}', 'array_agg keeps duplicates in order')
  const d = rowsOf(e, `SELECT g, array_agg(DISTINCT v) FROM t GROUP BY g ORDER BY g`)
  assert(formatValue(d[1][1]) === '{30}', 'array_agg(DISTINCT …) de-duplicates')
  assert(scalar(e, `SELECT array_agg(v) FROM t WHERE v > 999`) === null, 'array_agg over no rows is NULL')
})
test('arrays', 'arrays as first-class column values: store, equal, GROUP BY, index', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE arr(id INT, xs INT[])`)
  e.execute(`CREATE INDEX ix_xs ON arr(xs)`)
  // Two equivalent ways to write {1,2} must store identical values.
  e.execute(`INSERT INTO arr VALUES (1,'{1,2}'),(2, ARRAY[1,2]),(3, ARRAY[3])`)
  assert(scalar(e, `SELECT count(DISTINCT xs) FROM arr`) === 2, '{1,2} text and ARRAY[1,2] are one value')
  const grp = rowsOf(e, `SELECT xs, count(*) FROM arr GROUP BY xs ORDER BY xs`)
  assert(formatValue(grp[0][0]) === '{1,2}' && grp[0][1] === 2, 'GROUP BY collapses equal arrays')
  const idx = rowsOf(e, `SELECT id FROM arr WHERE xs = ARRAY[1,2] ORDER BY id`)
  assert(eq(idx, [[1], [2]]), 'equality predicate over an array column')
})
test('arrays', 'JSON interop: to_json and ::json', () => {
  const e = new Engine()
  assert(formatValue(scalar(e, 'SELECT to_json(ARRAY[1,2,3])')) === '[1,2,3]', 'to_json over an array')
  assert(formatValue(scalar(e, 'SELECT ARRAY[1,2,3]::json')) === '[1,2,3]', 'array ::json cast')
})
test('arrays', 'NULL propagation and error handling', () => {
  const e = new Engine()
  assert(scalar(e, 'SELECT (ARRAY[1,2,3])[NULL]') === null, 'NULL subscript is NULL')
  assert(scalar(e, 'SELECT array_length(NULL, 1)') === null, 'array_length(NULL) is NULL')
  assert(scalar(e, 'SELECT NULL || ARRAY[1,2]') === null, 'NULL || array is NULL')
  throws(e, 'SELECT (5)[1]', 'subscript')
})
test('arrays', 'persistence: arrays survive a snapshot round-trip', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE k(id INT, tags INT[])`)
  e.execute(`INSERT INTO k VALUES (1, ARRAY[3,1]), (2, ARRAY[1,2])`)
  const restored = Database.restore(e.db.snapshot())
  const e2 = new Engine(restored)
  const rows = rowsOf(e2, `SELECT id, tags FROM k ORDER BY id`)
  assert(formatValue(rows[0][1]) === '{3,1}' && formatValue(rows[1][1]) === '{1,2}', 'array cells restored intact')
})

// A table of int-arrays + a GIN index, and a twin with no index, for differential
// checks that the GinScan returns byte-for-byte what the sequential filter does.
function arrayGinPair(): { gin: Engine; seq: Engine } {
  const rows: string[] = []
  for (let i = 1; i <= 120; i++) rows.push(`(${i}, ARRAY[${i % 7}, ${i % 11}, ${i % 13}])`)
  const ddl = `CREATE TABLE posts (id INT, tags INT[]); INSERT INTO posts VALUES ${rows.join(',')};`
  const gin = new Engine()
  gin.execute(ddl)
  gin.execute(`CREATE INDEX posts_gin ON posts USING GIN (tags)`)
  const seq = new Engine()
  seq.execute(ddl)
  return { gin, seq }
}
test('arrays', 'a GIN index requires a TSVECTOR or array column', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE bad (id INT, n INT)`)
  throws(e, `CREATE INDEX g ON bad USING GIN (n)`, 'GIN index requires')
})
test('arrays', 'EXPLAIN chooses a GinScan for array predicates', () => {
  const { gin } = arrayGinPair()
  for (const pred of ['tags @> ARRAY[1,2]', 'tags && ARRAY[5,6]', '4 = ANY(tags)', 'ARRAY[3] <@ tags']) {
    const r = lastResult(gin, `EXPLAIN SELECT id FROM posts WHERE ${pred}`)
    assert(JSON.stringify(r).includes('GinScan'), `plan for "${pred}" should use a GinScan`)
  }
})
test('arrays', 'array GinScan is byte-for-byte identical to the sequential filter', () => {
  const { gin, seq } = arrayGinPair()
  const preds = [
    'tags @> ARRAY[1,2]',
    'ARRAY[3] <@ tags',
    'tags && ARRAY[5,6]',
    '4 = ANY(tags)',
    'tags @> ARRAY[0,0]', // duplicate keys
    'tags @> ARRAY[1] AND id > 50', // GIN + a residual filter
  ]
  for (const pred of preds) {
    const a = rowsOf(gin, `SELECT id FROM posts WHERE ${pred} ORDER BY id`)
    const b = rowsOf(seq, `SELECT id FROM posts WHERE ${pred} ORDER BY id`)
    assert(eq(a, b), `GinScan vs seq differ for "${pred}"`)
  }
})
test('arrays', 'array GIN index is maintained across INSERT / UPDATE / DELETE', () => {
  const e = new Engine()
  e.execute(`CREATE TABLE posts (id INT, tags INT[])`)
  e.execute(`CREATE INDEX posts_gin ON posts USING GIN (tags)`)
  e.execute(`INSERT INTO posts VALUES (1, ARRAY[1,2]), (2, ARRAY[2,3])`)
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE tags @> ARRAY[2] ORDER BY id`), [[1], [2]]), 'both contain 2')
  e.execute(`UPDATE posts SET tags = ARRAY[9] WHERE id = 1`)
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE tags @> ARRAY[2] ORDER BY id`), [[2]]), 'update removed id 1 from the 2-postings')
  assert(eq(rowsOf(e, `SELECT id FROM posts WHERE 9 = ANY(tags)`), [[1]]), 'and added it to the 9-postings')
  e.execute(`DELETE FROM posts WHERE id = 2`)
  assert(rowsOf(e, `SELECT id FROM posts WHERE tags @> ARRAY[2]`).length === 0, 'delete cleared the 2-postings')
})
test('arrays', 'array GIN survives a snapshot round-trip and still plans', () => {
  const { gin } = arrayGinPair()
  const e2 = new Engine(Database.restore(gin.db.snapshot()))
  const r = lastResult(e2, `EXPLAIN SELECT id FROM posts WHERE tags @> ARRAY[1,2]`)
  assert(JSON.stringify(r).includes('GinScan'), 'restored array GIN index still planned')
  const a = rowsOf(e2, `SELECT id FROM posts WHERE tags @> ARRAY[1,2] ORDER BY id`)
  assert(a.length > 0, 'and still returns rows')
})

// --- sample queries (catalog showcase) -------------------------------------
test('samples', 'every shipped sample query runs against the seed', () => {
  for (const q of SAMPLE_QUERIES) {
    const e = seeded()
    try {
      e.execute(q.sql)
    } catch (err) {
      throw new Error(`sample "${q.title}" failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  }
})

// --- PL/QF: stored functions, procedures & triggers ------------------------

/** A small engine with two helper tables for the procedural tests. */
function plBase(): Engine {
  const e = new Engine()
  e.execute(`
    CREATE TABLE nums(x INTEGER);
    INSERT INTO nums VALUES (10), (20), (30);
    CREATE TABLE accounts(id INTEGER PRIMARY KEY, bal INTEGER);
    INSERT INTO accounts VALUES (1, 100), (2, 50);
  `)
  return e
}

test('pl', 'scalar function returns a value and is callable in SELECT', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION add_tax(price REAL, rate REAL) RETURNS REAL AS $$
    BEGIN RETURN price * (1 + rate); END; $$;`)
  assert(scalar(e, 'SELECT add_tax(100, 0.25)') === 125, 'add_tax(100, 0.25) = 125')
})

test('pl', 'dollar-quoting tokenizes a body containing quotes', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION greet(who TEXT) RETURNS TEXT AS $$
    BEGIN RETURN 'hello, ' || who || '!'; END; $$;`)
  assert(scalar(e, `SELECT greet('world')`) === 'hello, world!', "embedded quotes survive")
})

test('pl', 'recursion: factorial', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION fact(n INTEGER) RETURNS INTEGER AS $$
    BEGIN IF n <= 1 THEN RETURN 1; END IF; RETURN n * fact(n - 1); END; $$;`)
  assert(scalar(e, 'SELECT fact(5)') === 120, '5! = 120')
})

test('pl', 'IF / ELSIF / ELSE branching', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION sign_of(n INTEGER) RETURNS TEXT AS $$
    BEGIN
      IF n > 0 THEN RETURN 'pos';
      ELSIF n < 0 THEN RETURN 'neg';
      ELSE RETURN 'zero'; END IF;
    END; $$;`)
  assert(scalar(e, 'SELECT sign_of(7)') === 'pos', 'pos')
  assert(scalar(e, 'SELECT sign_of(-3)') === 'neg', 'neg')
  assert(scalar(e, 'SELECT sign_of(0)') === 'zero', 'zero')
})

test('pl', 'FOR integer-range loop with a local variable', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION sum_to(n INTEGER) RETURNS INTEGER AS $$
    DECLARE total INTEGER := 0;
    BEGIN FOR i IN 1..n LOOP total := total + i; END LOOP; RETURN total; END; $$;`)
  assert(scalar(e, 'SELECT sum_to(10)') === 55, '1..10 sums to 55')
})

test('pl', 'REVERSE / BY step in a FOR range', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION evens_desc(n INTEGER) RETURNS INTEGER AS $$
    DECLARE c INTEGER := 0;
    BEGIN FOR i IN REVERSE n..0 BY 2 LOOP c := c + 1; END LOOP; RETURN c; END; $$;`)
  assert(scalar(e, 'SELECT evens_desc(10)') === 6, '10,8,6,4,2,0 -> 6 iterations')
})

test('pl', 'WHILE loop', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION countdown(n INTEGER) RETURNS INTEGER AS $$
    DECLARE c INTEGER := 0;
    BEGIN WHILE n > 0 LOOP n := n - 1; c := c + 1; END LOOP; RETURN c; END; $$;`)
  assert(scalar(e, 'SELECT countdown(7)') === 7, 'counts 7 iterations')
})

test('pl', 'LOOP with EXIT WHEN', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION find_div(n INTEGER) RETURNS INTEGER AS $$
    DECLARE i INTEGER := 2;
    BEGIN LOOP EXIT WHEN n % i = 0; i := i + 1; END LOOP; RETURN i; END; $$;`)
  assert(scalar(e, 'SELECT find_div(15)') === 3, 'smallest divisor of 15 is 3')
})

test('pl', 'SELECT … INTO binds a query result to a variable', () => {
  const e = plBase()
  e.execute(`CREATE FUNCTION total_x() RETURNS INTEGER AS $$
    DECLARE s INTEGER;
    BEGIN SELECT sum(x) INTO s FROM nums; RETURN s; END; $$;`)
  assert(scalar(e, 'SELECT total_x()') === 60, 'sum of 10+20+30')
})

test('pl', 'FOR rec IN <query> loop reads columns via the record', () => {
  const e = plBase()
  e.execute(`CREATE FUNCTION count_gt(t INTEGER) RETURNS INTEGER AS $$
    DECLARE c INTEGER := 0;
    BEGIN FOR r IN (SELECT x FROM nums) LOOP IF r.x > t THEN c := c + 1; END IF; END LOOP; RETURN c; END; $$;`)
  assert(scalar(e, 'SELECT count_gt(15)') === 2, '20 and 30 exceed 15')
})

test('pl', 'function usable in a WHERE predicate', () => {
  const e = plBase()
  e.execute(`CREATE FUNCTION is_big(x INTEGER) RETURNS BOOLEAN AS $$
    BEGIN RETURN x >= 20; END; $$;`)
  assert(scalar(e, 'SELECT count(*) FROM nums WHERE is_big(x)') === 2, 'two rows are big')
})

test('pl', 'procedure mutates via CALL with variable substitution', () => {
  const e = plBase()
  e.execute(`CREATE PROCEDURE transfer(from_id INTEGER, to_id INTEGER, amt INTEGER) AS $$
    BEGIN
      UPDATE accounts SET bal = bal - amt WHERE id = from_id;
      UPDATE accounts SET bal = bal + amt WHERE id = to_id;
    END; $$;`)
  e.execute('CALL transfer(1, 2, 30)')
  assert(eq(rowsOf(e, 'SELECT bal FROM accounts ORDER BY id'), [[70], [80]]), 'balances transferred')
})

test('pl', 'RAISE EXCEPTION aborts and rolls the statement back', () => {
  const e = plBase()
  e.execute(`CREATE PROCEDURE withdraw(acc INTEGER, amt INTEGER) AS $$
    DECLARE cur INTEGER;
    BEGIN
      SELECT bal INTO cur FROM accounts WHERE id = acc;
      IF cur < amt THEN RAISE EXCEPTION 'insufficient funds: have %, need %', cur, amt; END IF;
      UPDATE accounts SET bal = bal - amt WHERE id = acc;
    END; $$;`)
  throws(e, 'CALL withdraw(2, 999)', 'insufficient funds: have 50, need 999')
  assert(scalar(e, 'SELECT bal FROM accounts WHERE id = 2') === 50, 'balance unchanged after abort')
})

test('pl', 'RAISE NOTICE is collected and surfaced on the result', () => {
  const e = new Engine()
  e.execute(`CREATE PROCEDURE noisy() AS $$ BEGIN RAISE NOTICE 'value is %', 42; END; $$;`)
  const r = lastResult(e, 'CALL noisy()')
  assert(r.kind === 'message' && (r.notices ?? []).some((n) => n.includes('value is 42')), 'notice captured')
})

test('pl', 'BEFORE INSERT trigger rewrites the NEW row', () => {
  const e = new Engine()
  e.execute(`
    CREATE TABLE items(id INTEGER, name TEXT);
    CREATE FUNCTION upper_name() RETURNS TRIGGER AS $$
      BEGIN NEW.name := upper(NEW.name); RETURN NEW; END; $$;
    CREATE TRIGGER items_upper BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION upper_name();
    INSERT INTO items VALUES (1, 'widget');
  `)
  assert(scalar(e, 'SELECT name FROM items') === 'WIDGET', 'name upper-cased by the trigger')
})

test('pl', 'BEFORE INSERT trigger can cancel a row with RETURN NULL', () => {
  const e = new Engine()
  e.execute(`
    CREATE TABLE items(id INTEGER, name TEXT);
    CREATE FUNCTION reject_neg() RETURNS TRIGGER AS $$
      BEGIN IF NEW.id < 0 THEN RETURN NULL; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER items_guard BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION reject_neg();
    INSERT INTO items VALUES (-1, 'bad'), (2, 'ok'), (-3, 'nope');
  `)
  assert(scalar(e, 'SELECT count(*) FROM items') === 1, 'only the non-negative row survived')
  assert(scalar(e, 'SELECT id FROM items') === 2, 'and it is row 2')
})

test('pl', 'AFTER INSERT/DELETE trigger maintains an audit log', () => {
  const e = new Engine()
  e.execute(`
    CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE audit(action TEXT, pid INTEGER);
    CREATE FUNCTION log_change() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN INSERT INTO audit VALUES ('INSERT', NEW.id); RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN INSERT INTO audit VALUES ('DELETE', OLD.id); RETURN OLD; END IF;
        RETURN NULL;
      END; $$;
    CREATE TRIGGER products_audit AFTER INSERT OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION log_change();
    INSERT INTO products VALUES (1, 'Widget');
    DELETE FROM products WHERE id = 1;
  `)
  assert(eq(rowsOf(e, 'SELECT action, pid FROM audit'), [['INSERT', 1], ['DELETE', 1]]), 'audit recorded both ops')
})

test('pl', 'trigger WHEN clause gates the firing', () => {
  const e = new Engine()
  e.execute(`
    CREATE TABLE emp(id INTEGER PRIMARY KEY, salary INTEGER);
    INSERT INTO emp VALUES (1, 100), (2, 200);
    CREATE TABLE raises(id INTEGER, old_s INTEGER, new_s INTEGER);
    CREATE FUNCTION log_raise() RETURNS TRIGGER AS $$
      BEGIN INSERT INTO raises VALUES (NEW.id, OLD.salary, NEW.salary); RETURN NEW; END; $$;
    CREATE TRIGGER emp_raise AFTER UPDATE ON emp FOR EACH ROW WHEN (NEW.salary > OLD.salary) EXECUTE FUNCTION log_raise();
    UPDATE emp SET salary = salary + 50 WHERE id = 1;
    UPDATE emp SET salary = salary - 10 WHERE id = 2;
  `)
  assert(eq(rowsOf(e, 'SELECT id, old_s, new_s FROM raises'), [[1, 100, 150]]), 'only the genuine raise logged')
})

test('pl', 'routines and triggers survive a snapshot round-trip', () => {
  const e = new Engine()
  e.execute(`
    CREATE TABLE items(id INTEGER, name TEXT);
    CREATE FUNCTION fact(n INTEGER) RETURNS INTEGER AS $$
      BEGIN IF n <= 1 THEN RETURN 1; END IF; RETURN n * fact(n - 1); END; $$;
    CREATE FUNCTION upper_name() RETURNS TRIGGER AS $$
      BEGIN NEW.name := upper(NEW.name); RETURN NEW; END; $$;
    CREATE TRIGGER items_upper BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION upper_name();
  `)
  const e2 = new Engine(Database.restore(e.db.snapshot()))
  assert(scalar(e2, 'SELECT fact(4)') === 24, 'function restored & runs')
  e2.execute(`INSERT INTO items VALUES (1, 'hi')`)
  assert(scalar(e2, 'SELECT name FROM items') === 'HI', 'trigger restored & fires')
})

test('pl', 'DROP FUNCTION is refused while a trigger depends on it', () => {
  const e = new Engine()
  e.execute(`
    CREATE TABLE items(id INTEGER, name TEXT);
    CREATE FUNCTION upper_name() RETURNS TRIGGER AS $$ BEGIN RETURN NEW; END; $$;
    CREATE TRIGGER items_upper BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION upper_name();
  `)
  throws(e, 'DROP FUNCTION upper_name', 'depends on it')
  e.execute('DROP TRIGGER items_upper')
  e.execute('DROP FUNCTION upper_name') // now allowed
  assert(true, 'drop succeeds once the trigger is gone')
})

test('pl', 'calling a function with the wrong arity errors', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION add2(a INTEGER, b INTEGER) RETURNS INTEGER AS $$ BEGIN RETURN a + b; END; $$;`)
  throws(e, 'SELECT add2(1)', 'expects 2 argument')
})

test('pl', 'CREATE OR REPLACE FUNCTION redefines the body', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION f() RETURNS INTEGER AS $$ BEGIN RETURN 1; END; $$;`)
  assert(scalar(e, 'SELECT f()') === 1, 'first definition')
  e.execute(`CREATE OR REPLACE FUNCTION f() RETURNS INTEGER AS $$ BEGIN RETURN 2; END; $$;`)
  assert(scalar(e, 'SELECT f()') === 2, 'redefined')
})

test('pl', 'CALL of a non-void function surfaces its return value', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION twice(n INTEGER) RETURNS INTEGER AS $$ BEGIN RETURN n * 2; END; $$;`)
  assert(scalar(e, 'CALL twice(21)') === 42, 'returns 42')
})

test('pl', 'nested BEGIN blocks scope and shadow variables', () => {
  const e = new Engine()
  e.execute(`CREATE FUNCTION shadow() RETURNS INTEGER AS $$
    DECLARE x INTEGER := 1;
    BEGIN
      DECLARE x INTEGER := 100;
      BEGIN x := x + 5; END;       -- inner x becomes 105, outer untouched
      RETURN x;                    -- the outer x is still 1
    END; $$;`)
  assert(scalar(e, 'SELECT shadow()') === 1, 'inner shadow does not leak to the outer scope')
})

test('pl', 'one function composes another', () => {
  const e = new Engine()
  e.execute(`
    CREATE FUNCTION sq(n INTEGER) RETURNS INTEGER AS $$ BEGIN RETURN n * n; END; $$;
    CREATE FUNCTION sum_sq(a INTEGER, b INTEGER) RETURNS INTEGER AS $$ BEGIN RETURN sq(a) + sq(b); END; $$;`)
  assert(scalar(e, 'SELECT sum_sq(3, 4)') === 25, '9 + 16 = 25')
})

test('pl', 'SELECT … INTO STRICT errors when the query is not exactly one row', () => {
  const e = plBase()
  e.execute(`CREATE FUNCTION only_one() RETURNS INTEGER AS $$
    DECLARE v INTEGER;
    BEGIN SELECT x INTO STRICT v FROM nums; RETURN v; END; $$;`)
  throws(e, 'SELECT only_one()', 'expected exactly one row')
})

test('pl', 'BEFORE UPDATE trigger clamps the NEW row', () => {
  const e = new Engine()
  e.execute(`
    CREATE TABLE gauge(id INTEGER PRIMARY KEY, pct INTEGER);
    INSERT INTO gauge VALUES (1, 50);
    CREATE FUNCTION clamp_pct() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.pct > 100 THEN NEW.pct := 100; END IF;
        IF NEW.pct < 0 THEN NEW.pct := 0; END IF;
        RETURN NEW;
      END; $$;
    CREATE TRIGGER gauge_clamp BEFORE UPDATE ON gauge FOR EACH ROW EXECUTE FUNCTION clamp_pct();
    UPDATE gauge SET pct = 250 WHERE id = 1;
  `)
  assert(scalar(e, 'SELECT pct FROM gauge') === 100, 'over-range value clamped to 100 by the trigger')
})

// --- v17: memory-bounded execution (work_mem, top-N, spilling agg/join) -----

/** Generate a single-column big table via a recursive CTE (the corpus-tested
 *  row generator). `expr` is computed from the running counter `n` (1..count). */
function gen(e: Engine, ddl: string, table: string, cols: string, count: number, selectExpr: string) {
  e.execute(ddl)
  e.execute(
    `INSERT INTO ${table} (${cols}) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${count}) SELECT ${selectExpr} FROM s`,
  )
}
/** Run a query at a given work_mem and return its rows. */
function atMem(e: Engine, workMem: number | 'default', sql: string): Row[] {
  e.execute(workMem === 'default' ? 'RESET work_mem' : `SET work_mem = ${workMem}`)
  return rowsOf(e, sql)
}
/** The EXPLAIN ANALYZE plan JSON for a query at a given work_mem. */
function explainAt(e: Engine, workMem: number, sql: string): string {
  e.execute(`SET work_mem = ${workMem}`)
  const r = e.execute(`EXPLAIN ANALYZE ${sql}`)[0]
  return JSON.stringify(r.kind === 'explain' ? r.plan : {})
}

test('execution', 'SET / SHOW / RESET work_mem', () => {
  const e = new Engine()
  assert(scalar(e, 'SHOW work_mem') === 100000, 'default work_mem is 100000 rows')
  e.execute('SET work_mem = 256')
  assert(scalar(e, 'SHOW work_mem') === 256, 'SET work_mem = 256')
  e.execute('SET work_mem TO 64')
  assert(scalar(e, 'SHOW work_mem') === 64, 'SET work_mem TO 64')
  e.execute('RESET work_mem')
  assert(scalar(e, 'SHOW work_mem') === 100000, 'RESET restores the default')
  e.execute('SET work_mem TO DEFAULT')
  assert(scalar(e, 'SHOW work_mem') === 100000, 'SET … TO DEFAULT restores the default')
  throws(e, 'SET work_mem = 0', 'positive')
  throws(e, 'SET nonesuch = 1', 'unknown configuration')
  throws(e, 'SHOW nonesuch', 'unknown configuration')
})

test('execution', 'top-N heapsort equals a full sort then limit', () => {
  const e = new Engine()
  gen(e, 'CREATE TABLE tn (k INTEGER, g INTEGER)', 'tn', 'k, g', 1500, '(1500 - n) * 7 % 101, n % 13')
  // Differential: top-N (bounded) vs the full external sort then slice. Several
  // shapes incl. OFFSET, DESC, and a secondary key with ties.
  for (const q of [
    'SELECT k, g FROM tn ORDER BY k LIMIT 10',
    'SELECT k, g FROM tn ORDER BY k LIMIT 10 OFFSET 25',
    'SELECT k, g FROM tn ORDER BY k DESC, g ASC LIMIT 17',
    'SELECT k, g FROM tn ORDER BY g, k LIMIT 40 OFFSET 5',
  ]) {
    const bounded = atMem(e, 4, q)
    const full = atMem(e, 'default', q)
    assert(eq(bounded, full), `top-N must equal full sort for: ${q}`)
  }
  // The plan reports the heapsort method at a small budget.
  assert(explainAt(e, 4, 'SELECT k FROM tn ORDER BY k LIMIT 10').includes('top-N heapsort'), 'EXPLAIN should show top-N heapsort')
})

test('execution', 'work_mem caps the external merge-sort run size', () => {
  const e = new Engine()
  gen(e, 'CREATE TABLE ms (k INTEGER)', 'ms', 'k', 1200, '1201 - n')
  const tight = explainAt(e, 100, 'SELECT k FROM ms ORDER BY k')
  assert(tight.includes('external merge sort'), 'a tight budget forces an external sort')
  assert(tight.includes('run size 100'), 'the run size tracks work_mem')
  // Result is still correct.
  assert(eq(atMem(e, 100, 'SELECT k FROM ms ORDER BY k LIMIT 3').map((r) => r[0]), [1, 2, 3]), 'external sort order')
})

test('execution', 'spilling hash aggregate equals the in-memory aggregate', () => {
  const e = new Engine()
  // 1200 rows over 60 groups, with values that exercise SUM/COUNT/MIN/MAX and a
  // DISTINCT aggregate (whose per-group set must survive the spill intact).
  gen(e, 'CREATE TABLE agg (g INTEGER, v INTEGER)', 'agg', 'g, v', 1200, 'n % 60, n % 200')
  const q = 'SELECT g, COUNT(*), SUM(v), MIN(v), MAX(v), COUNT(DISTINCT v) FROM agg GROUP BY g ORDER BY g'
  const spilled = atMem(e, 8, q)
  const full = atMem(e, 'default', q)
  assert(eq(spilled, full), 'grace hash aggregate must match the in-memory result')
  assert(spilled.length === 60, 'all 60 groups present after spilling')
  const plan = explainAt(e, 8, 'SELECT g, COUNT(*) FROM agg GROUP BY g')
  assert(plan.includes('grace hash aggregate'), 'EXPLAIN should show a grace hash aggregate')
  assert(/spilled [1-9]/.test(plan), 'EXPLAIN should report spilled rows')
})

test('execution', 'array_agg stays in arrival order across an aggregate spill', () => {
  const e = new Engine()
  gen(e, 'CREATE TABLE ord (g INTEGER, v INTEGER)', 'ord', 'g, v', 400, 'n % 40, n')
  const q = 'SELECT g, array_agg(v) FROM ord GROUP BY g ORDER BY g'
  assert(eq(atMem(e, 4, q), atMem(e, 'default', q)), 'array_agg order preserved through spill')
})

test('execution', 'grace hash join equals the in-memory join (every flavour)', () => {
  const e = new Engine()
  // Unindexed join keys + under the merge-join threshold ⇒ the planner picks a
  // HashJoin; duplicates and NULL keys stress the partitioning + outer-join paths.
  gen(e, 'CREATE TABLE jl (id INTEGER, k INTEGER)', 'jl', 'id, k', 300, 'n, CASE WHEN n <= 6 THEN NULL ELSE n % 37 END')
  gen(e, 'CREATE TABLE jr (id INTEGER, k INTEGER)', 'jr', 'id, k', 280, 'n, CASE WHEN n <= 4 THEN NULL ELSE n % 41 END')
  for (const type of ['INNER', 'LEFT', 'RIGHT', 'FULL']) {
    const join = type === 'INNER' ? 'JOIN' : `${type} JOIN`
    const q = `SELECT jl.id, jl.k, jr.id, jr.k FROM jl ${join} jr ON jl.k = jr.k ORDER BY jl.id, jr.id, jl.k, jr.k`
    const spilled = atMem(e, 8, q)
    const full = atMem(e, 'default', q)
    assert(eq(spilled, full), `grace ${type} join must match in-memory`)
  }
  const plan = explainAt(e, 8, 'SELECT jl.id FROM jl JOIN jr ON jl.k = jr.k')
  assert(plan.includes('HashJoin') && plan.includes('grace hash join'), 'EXPLAIN should show a grace hash join')
})

test('execution', 'a deeply skewed aggregate still terminates and is correct', () => {
  const e = new Engine()
  // Few groups but many rows per group: spilling can re-spill a partition whose
  // keys collide; the recursion depth guard must still produce the right answer.
  gen(e, 'CREATE TABLE skew (g INTEGER, v INTEGER)', 'skew', 'g, v', 800, 'n % 3, n')
  const q = 'SELECT g, COUNT(*), SUM(v) FROM skew GROUP BY g ORDER BY g'
  assert(eq(atMem(e, 2, q), atMem(e, 'default', q)), 'highly skewed aggregate stays correct under a tiny budget')
})

test('execution', 'the statement parse cache serves repeated read-only queries', () => {
  const e = seeded()
  const before = e.parseCacheStats().hits
  const sql = 'SELECT id, name FROM products ORDER BY id LIMIT 3'
  const a = rowsOf(e, sql)
  const b = rowsOf(e, sql)
  const c = rowsOf(e, sql)
  assert(eq(a, b) && eq(b, c), 'cached parse yields identical results')
  assert(e.parseCacheStats().hits >= before + 2, 'repeated runs register cache hits')
  // A DML statement is never cached (so it can never serve a stale/mutated plan).
  const m0 = e.parseCacheStats().misses
  e.execute("UPDATE products SET price = price WHERE id = 1")
  e.execute("UPDATE products SET price = price WHERE id = 1")
  assert(e.parseCacheStats().misses >= m0 + 2, 'DML is re-parsed every time, never cached')
})

export function runTests(): TestResult[] {
  return cases.concat(mvccCases).concat(recoveryCases).map((c) => {
    try {
      c.run()
      return { name: c.name, group: c.group, pass: true, detail: 'ok' }
    } catch (err) {
      return { name: c.name, group: c.group, pass: false, detail: err instanceof Error ? err.message : String(err) }
    }
  })
}
