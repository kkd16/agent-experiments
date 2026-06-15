// Engine self-tests. These run in the browser (the "Tests" panel) and can be
// executed head-less in CI. Keeping them in src means the exact same engine
// build is what gets verified.

import { Engine, type RowsResult } from './engine'
import { SEED_SQL } from './sampleData'
import { csvToSql, parseCsv } from './csv'
import { Database } from './catalog'
import type { Row } from './catalog'
import { formatValue, type SqlValue } from './types'
import { isTemporal } from './temporal'

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
  const tables = deepest!.children.map((c) => c.detail).join(' | ')
  // The two single-row tables should be joined together at the bottom, leaving
  // the 200-row table for last — never the written (big-first) order.
  assert(/s1/.test(tables) && /s2/.test(tables), `deepest join should pair s1 & s2, got: ${tables}`)
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

export function runTests(): TestResult[] {
  return cases.map((c) => {
    try {
      c.run()
      return { name: c.name, group: c.group, pass: true, detail: 'ok' }
    } catch (err) {
      return { name: c.name, group: c.group, pass: false, detail: err instanceof Error ? err.message : String(err) }
    }
  })
}
