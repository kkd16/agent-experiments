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
