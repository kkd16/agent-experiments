// Engine self-tests. These run in the browser (the "Tests" panel) and can be
// executed head-less in CI. Keeping them in src means the exact same engine
// build is what gets verified.

import { Engine, type RowsResult } from './engine'
import { SEED_SQL } from './sampleData'
import type { Row } from './catalog'
import type { SqlValue } from './types'

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
test('derived', 'derived table preserves numeric types', () => {
  const e = seeded()
  // If materialization coerced to TEXT, SUM would concatenate / error.
  assert(scalar(e, 'SELECT SUM(p) FROM (SELECT price AS p FROM products) d') === 2203.4, 'derived numeric type lost')
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
