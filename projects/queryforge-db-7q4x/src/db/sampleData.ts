// Seed datasets shipped with the playground. Each is plain QueryForge SQL run
// through the engine on load, so the data path is exercised exactly like a
// user's own scripts.

export interface SampleQuery {
  title: string
  sql: string
}

export const SEED_SQL = `
-- Northwind-style miniature schema
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  country TEXT,
  signup_year INTEGER
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  price REAL,
  in_stock INTEGER
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER,
  product_id INTEGER,
  quantity INTEGER,
  order_year INTEGER
);

INSERT INTO customers (id, name, city, country, signup_year) VALUES
  (1, 'Ada Lovelace',     'London',    'UK',     2019),
  (2, 'Alan Turing',      'Manchester','UK',     2020),
  (3, 'Grace Hopper',     'New York',  'USA',    2018),
  (4, 'Edsger Dijkstra',  'Austin',    'USA',    2021),
  (5, 'Donald Knuth',     'Stanford',  'USA',    2019),
  (6, 'Barbara Liskov',   'Boston',    'USA',    2022),
  (7, 'Tim Berners-Lee',  'London',    'UK',     2020),
  (8, 'Margaret Hamilton','Boston',    'USA',    2021);

INSERT INTO products (id, name, category, price, in_stock) VALUES
  (1, 'Mechanical Keyboard', 'Hardware',  129.0, 42),
  (2, 'Ultrawide Monitor',   'Hardware',  549.5, 12),
  (3, 'Noise-Cancel Phones', 'Audio',     299.0, 30),
  (4, 'USB-C Hub',           'Hardware',   49.9, 88),
  (5, 'Studio Microphone',   'Audio',     199.0, 17),
  (6, 'Standing Desk',       'Furniture', 399.0,  9),
  (7, 'Ergonomic Chair',     'Furniture', 459.0, 15),
  (8, 'Webcam 4K',           'Video',     119.0, 23);

INSERT INTO orders (id, customer_id, product_id, quantity, order_year) VALUES
  (1, 1, 1, 2, 2022), (2, 1, 3, 1, 2022), (3, 2, 2, 1, 2023),
  (4, 3, 5, 3, 2022), (5, 3, 1, 1, 2023), (6, 4, 7, 2, 2023),
  (7, 5, 6, 1, 2022), (8, 6, 4, 5, 2023), (9, 7, 8, 2, 2023),
  (10, 8, 3, 2, 2022), (11, 1, 7, 1, 2023), (12, 4, 2, 1, 2022),
  (13, 6, 5, 1, 2023), (14, 2, 8, 4, 2022), (15, 5, 1, 2, 2023);

-- A secondary index the planner can exploit for range scans.
CREATE INDEX idx_products_price ON products (price);
CREATE INDEX idx_orders_customer ON orders (customer_id);
`.trim()

export const SAMPLE_QUERIES: SampleQuery[] = [
  {
    title: 'Top spenders (join + group + order)',
    sql: `SELECT c.name AS customer, c.country,
       SUM(p.price * o.quantity) AS revenue,
       COUNT(*) AS orders
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products  p ON o.product_id = p.id
GROUP BY c.name, c.country
HAVING SUM(p.price * o.quantity) > 300
ORDER BY revenue DESC
LIMIT 5;`,
  },
  {
    title: 'Index range scan (EXPLAIN)',
    sql: `EXPLAIN ANALYZE
SELECT name, price FROM products
WHERE price >= 200 AND price <= 500
ORDER BY price DESC;`,
  },
  {
    title: 'Category breakdown',
    sql: `SELECT category,
       COUNT(*)        AS items,
       ROUND(AVG(price), 2) AS avg_price,
       MIN(price)      AS cheapest,
       MAX(price)      AS priciest
FROM products
GROUP BY category
ORDER BY avg_price DESC;`,
  },
  {
    title: 'LEFT JOIN — customers with no orders',
    sql: `SELECT c.name, COUNT(o.id) AS orders
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.name
ORDER BY orders ASC, c.name;`,
  },
  {
    title: 'CASE + string functions',
    sql: `SELECT UPPER(name) AS product,
       price,
       CASE WHEN price > 300 THEN 'premium'
            WHEN price > 100 THEN 'mid'
            ELSE 'budget' END AS tier
FROM products
ORDER BY price DESC;`,
  },
  {
    title: 'Filter with IN / LIKE / BETWEEN',
    sql: `SELECT name, city, country, signup_year
FROM customers
WHERE country IN ('UK', 'USA')
  AND name LIKE '%a%'
  AND signup_year BETWEEN 2019 AND 2021
ORDER BY signup_year, name;`,
  },
  {
    title: 'Window — rank within category',
    sql: `SELECT name, category, price,
       ROW_NUMBER() OVER (PARTITION BY category ORDER BY price DESC) AS rank_in_cat,
       RANK()       OVER (ORDER BY price DESC)                       AS overall_rank,
       ROUND(price - AVG(price) OVER (PARTITION BY category), 2)     AS vs_cat_avg
FROM products
ORDER BY category, rank_in_cat;`,
  },
  {
    title: 'Correlated subquery + scalar subquery',
    sql: `SELECT c.name,
       (SELECT COUNT(*)        FROM orders o WHERE o.customer_id = c.id) AS orders,
       (SELECT SUM(p.price * o.quantity)
          FROM orders o JOIN products p ON o.product_id = p.id
         WHERE o.customer_id = c.id)                                     AS spent
FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
ORDER BY spent DESC;`,
  },
  {
    title: 'CTE — running revenue by year',
    sql: `WITH yearly AS (
  SELECT o.order_year AS yr, SUM(p.price * o.quantity) AS revenue
  FROM orders o JOIN products p ON o.product_id = p.id
  GROUP BY o.order_year
)
SELECT yr, revenue,
       SUM(revenue) OVER (ORDER BY yr) AS cumulative
FROM yearly
ORDER BY yr;`,
  },
  {
    title: 'WITH RECURSIVE — generate a series',
    sql: `WITH RECURSIVE seq(n, fib, nxt) AS (
  SELECT 1, 0, 1
  UNION ALL
  SELECT n + 1, nxt, fib + nxt FROM seq WHERE n < 12
)
SELECT n, fib AS fibonacci FROM seq;`,
  },
  {
    title: 'Set operations — UNION / EXCEPT',
    sql: `-- Cities that have a customer, plus a couple of prospects, minus one
SELECT city FROM customers
UNION
SELECT 'Zurich'
UNION
SELECT 'Tokyo'
EXCEPT
SELECT 'London'
ORDER BY city;`,
  },
  {
    title: 'Window frame — 3-row moving average',
    sql: `-- An explicit ROWS frame: each row averages itself and its neighbours.
WITH yearly AS (
  SELECT o.order_year AS yr, SUM(p.price * o.quantity) AS revenue
  FROM orders o JOIN products p ON o.product_id = p.id
  GROUP BY o.order_year
)
SELECT yr, revenue,
       ROUND(AVG(revenue) OVER (ORDER BY yr ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), 1) AS moving_avg,
       SUM(revenue) OVER (ORDER BY yr ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
FROM yearly ORDER BY yr;`,
  },
  {
    title: 'Statistical aggregates per category',
    sql: `SELECT category,
       COUNT(*)               AS items,
       ROUND(AVG(price), 1)   AS mean,
       MEDIAN(price)          AS median,
       ROUND(STDDEV_POP(price), 1) AS stddev,
       GROUP_CONCAT(name)     AS products
FROM products
GROUP BY category
ORDER BY items DESC, category;`,
  },
  {
    title: 'ROLLUP — subtotals with GROUPING()',
    sql: `-- Revenue by country × category, with per-country subtotals and a grand
-- total. GROUPING() flags which rows are roll-ups (1) vs. detail (0).
SELECT c.country, p.category,
       ROUND(SUM(p.price * o.quantity), 0) AS revenue,
       GROUPING(c.country)  AS g_country,
       GROUPING(p.category) AS g_category
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products  p ON o.product_id = p.id
GROUP BY ROLLUP(c.country, p.category)
ORDER BY g_country, g_category, c.country, p.category;`,
  },
  {
    title: 'CUBE — every dimension combination',
    sql: `-- CUBE adds the all-region and all-year cross-tabs too.
SELECT c.country, o.order_year,
       COUNT(*) AS orders,
       ROUND(SUM(p.price * o.quantity), 0) AS revenue
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products  p ON o.product_id = p.id
GROUP BY CUBE(c.country, o.order_year)
ORDER BY c.country, o.order_year;`,
  },
  {
    title: 'Ordered-set aggregates — percentiles & mode',
    sql: `-- WITHIN GROUP (ORDER BY …) feeds the value to aggregate.
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) AS median_price,
       PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY price) AS p90_price,
       MODE()               WITHIN GROUP (ORDER BY category) AS top_category
FROM products;`,
  },
  {
    title: 'VALUES — inline lookup table (join)',
    sql: `-- A row-set literal joined against the catalog to relabel categories.
SELECT p.name, p.category, lbl.label AS shelf
FROM products p
JOIN (VALUES ('Hardware', 'Workstation'),
             ('Audio',    'Studio'),
             ('Video',    'Streaming')) AS lbl(cat, label)
  ON p.category = lbl.cat
ORDER BY shelf, p.name;`,
  },
  {
    title: 'Bitmap OR — IN-list via the index (EXPLAIN)',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_product ON orders (product_id);
-- An IN-list becomes a union of index lookups instead of a full scan.
EXPLAIN ANALYZE
SELECT id, customer_id FROM orders WHERE product_id IN (1, 5, 8);`,
  },
  {
    title: 'Index-only (covering) scan — EXPLAIN',
    sql: `CREATE INDEX IF NOT EXISTS idx_products_cat_price ON products (category, price);
-- category & price both live in the index, so the heap is never touched.
EXPLAIN ANALYZE
SELECT category, price FROM products WHERE category = 'Hardware';`,
  },
  {
    title: 'Bitmap AND of two indexes — EXPLAIN',
    sql: `CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
-- Two separate single-column indexes (category, price) are intersected.
EXPLAIN ANALYZE
SELECT name FROM products WHERE category = 'Hardware' AND price < 200;`,
  },
  {
    title: 'Cost-based join reordering — EXPLAIN',
    sql: `ANALYZE;
-- The planner searches left-deep join orders and keeps the cheapest;
-- the selective country filter shapes which table drives the join.
EXPLAIN
SELECT c.name, p.name
FROM orders o
JOIN customers c ON o.customer_id = c.id
JOIN products  p ON o.product_id = p.id
WHERE c.country = 'UK';`,
  },
  {
    title: 'Composite index + ANALYZE (EXPLAIN)',
    sql: `CREATE INDEX IF NOT EXISTS idx_orders_cy ON orders (customer_id, order_year);
ANALYZE;
-- One B+Tree serves the equality prefix AND the trailing range:
EXPLAIN ANALYZE
SELECT id, quantity FROM orders
WHERE customer_id = 1 AND order_year >= 2022;`,
  },
  {
    title: 'Chart this — revenue by category',
    sql: `-- Switch the result to the "Chart" tab to plot it.
SELECT category,
       ROUND(SUM(p.price * o.quantity), 0) AS revenue,
       COUNT(*) AS orders
FROM orders o JOIN products p ON o.product_id = p.id
GROUP BY category
ORDER BY revenue DESC;`,
  },
  {
    title: 'Transaction: insert then rollback',
    sql: `BEGIN;
INSERT INTO products (id, name, category, price, in_stock)
VALUES (99, 'Mystery Gadget', 'Misc', 9.99, 1000);
SELECT COUNT(*) AS products_during_txn FROM products;
ROLLBACK;
SELECT COUNT(*) AS products_after_rollback FROM products;`,
  },
]
