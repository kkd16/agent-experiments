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
  price REAL CHECK (price >= 0),
  in_stock INTEGER DEFAULT 0
);

-- orders references both parents declaratively: deleting a customer cascades to
-- their orders, while a product that still has orders cannot be deleted.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER CHECK (quantity > 0),
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

-- A subscriptions table with first-class temporal columns: DATE, INTERVAL and
-- TIMESTAMP. These exercise date arithmetic, EXTRACT, DATE_TRUNC and AGE.
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  plan TEXT DEFAULT 'Starter',
  started DATE,
  term INTERVAL,
  last_active TIMESTAMP
);

INSERT INTO subscriptions (id, customer_id, plan, started, term, last_active) VALUES
  (1, 1, 'Pro',     DATE '2024-01-15', INTERVAL '1 year',   TIMESTAMP '2026-06-14 18:22:00'),
  (2, 2, 'Team',    DATE '2024-03-01', INTERVAL '1 month',  TIMESTAMP '2026-06-15 09:05:30'),
  (3, 3, 'Pro',     DATE '2023-11-20', INTERVAL '1 year',   TIMESTAMP '2026-05-30 14:40:10'),
  (4, 4, 'Starter', DATE '2025-02-10', INTERVAL '1 month',  TIMESTAMP '2026-06-15 23:59:00'),
  (5, 5, 'Team',    DATE '2024-07-04', INTERVAL '3 months', TIMESTAMP '2026-04-18 07:15:00'),
  (6, 6, 'Pro',     DATE '2025-09-30', INTERVAL '1 year',   TIMESTAMP '2026-06-13 11:00:00'),
  (7, 7, 'Starter', DATE '2026-01-31', INTERVAL '1 month',  TIMESTAMP '2026-06-15 16:48:20'),
  (8, 8, 'Team',    DATE '2024-12-25', INTERVAL '3 months', TIMESTAMP '2026-06-09 21:30:00');

-- Money is exact here: DECIMAL columns never lose a cent to binary floating
-- point. subtotal × tax_rate is computed and stored exactly; SUM/AVG over these
-- columns stay exact, and they index, sort and group like any other value.
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  issued DATE,
  subtotal DECIMAL(12,2),
  tax_rate DECIMAL(5,4),
  total DECIMAL(12,2)
);

INSERT INTO invoices (id, customer_id, issued, subtotal, tax_rate, total) VALUES
  (1, 1, DATE '2026-01-31', 1299.00, 0.2000, 1558.80),
  (2, 2, DATE '2026-02-15',  549.50, 0.2000,  659.40),
  (3, 3, DATE '2026-02-28',  897.00, 0.0875,  975.49),
  (4, 4, DATE '2026-03-10',  399.00, 0.0825,  431.92),
  (5, 5, DATE '2026-03-22', 1158.00, 0.0875, 1259.33),
  (6, 6, DATE '2026-04-05',  249.50, 0.0625,  265.09),
  (7, 7, DATE '2026-04-19',  238.00, 0.2000,  285.60),
  (8, 1, DATE '2026-05-02',  459.00, 0.2000,  550.80);

-- Semi-structured data: a JSON (jsonb-style) column. JSON is a first-class
-- value here — it indexes, sorts, GROUP BYs and persists like any other type,
-- and object keys are normalized (sorted, de-duplicated).
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  body JSON
);

INSERT INTO documents (id, customer_id, body) VALUES
  (1, 1, '{"kind":"order","priority":"high","tags":["vip","rush"],"items":[{"sku":"A1","qty":2},{"sku":"B2","qty":1}],"shipping":{"country":"US","express":true}}'),
  (2, 2, '{"kind":"order","priority":"low","tags":["bulk"],"items":[{"sku":"A1","qty":10}],"shipping":{"country":"GB","express":false}}'),
  (3, 3, '{"kind":"ticket","priority":"high","tags":["billing"],"sentiment":-2,"shipping":null}'),
  (4, 4, '{"kind":"order","priority":"med","tags":["vip"],"items":[{"sku":"C3","qty":3}],"shipping":{"country":"US","express":false}}'),
  (5, 5, '{"kind":"ticket","priority":"low","tags":["howto","docs"],"sentiment":1}');

-- A full-text search corpus. The search column is a first-class TSVECTOR: the
-- title is weighted 'A' and the body 'D', concatenated with || so ranking
-- favours a title hit. A GIN inverted index (below) makes search @@ query fast.
CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  title TEXT,
  body TEXT,
  search TSVECTOR
);

INSERT INTO articles (id, title, body, search) VALUES
  (1, 'Cost-based query optimization',
      'The optimizer estimates the cost of each plan from column statistics and chooses the cheapest, switching between a sequential scan and an index scan based on selectivity.',
      setweight(to_tsvector('Cost-based query optimization'), 'A') || setweight(to_tsvector('The optimizer estimates the cost of each plan from column statistics and chooses the cheapest, switching between a sequential scan and an index scan based on selectivity.'), 'D')),
  (2, 'Building a B+Tree index',
      'A balanced tree keeps keys sorted so range scans are fast; leaves are chained for sequential traversal and splits keep the tree shallow.',
      setweight(to_tsvector('Building a B+Tree index'), 'A') || setweight(to_tsvector('A balanced tree keeps keys sorted so range scans are fast; leaves are chained for sequential traversal and splits keep the tree shallow.'), 'D')),
  (3, 'How GIN inverted indexes work',
      'A generalized inverted index maps every lexeme to the list of rows that contain it, so a full-text match probes a handful of posting lists instead of scanning the whole table.',
      setweight(to_tsvector('How GIN inverted indexes work'), 'A') || setweight(to_tsvector('A generalized inverted index maps every lexeme to the list of rows that contain it, so a full-text match probes a handful of posting lists instead of scanning the whole table.'), 'D')),
  (4, 'Joins: hash, merge and nested loop',
      'A hash join builds a table on one input and probes it with the other; a merge join exploits sorted inputs; a nested loop wins for tiny relations.',
      setweight(to_tsvector('Joins: hash, merge and nested loop'), 'A') || setweight(to_tsvector('A hash join builds a table on one input and probes it with the other; a merge join exploits sorted inputs; a nested loop wins for tiny relations.'), 'D')),
  (5, 'Transactions and snapshots',
      'A snapshot captures the database so a transaction can roll back cleanly; the engine restores it wholesale when a statement fails or you issue ROLLBACK.',
      setweight(to_tsvector('Transactions and snapshots'), 'A') || setweight(to_tsvector('A snapshot captures the database so a transaction can roll back cleanly; the engine restores it wholesale when a statement fails or you issue ROLLBACK.'), 'D')),
  (6, 'Window functions explained',
      'Window functions compute a value over a frame of related rows without collapsing them, so you can rank, run totals and take moving averages in one pass.',
      setweight(to_tsvector('Window functions explained'), 'A') || setweight(to_tsvector('Window functions compute a value over a frame of related rows without collapsing them, so you can rank, run totals and take moving averages in one pass.'), 'D'));

-- A secondary index the planner can exploit for range scans.
CREATE INDEX idx_products_price ON products (price);
CREATE INDEX idx_invoices_total ON invoices (total);
CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_subs_started ON subscriptions (started);

-- A GIN inverted index over the article search vectors: the planner turns
-- a search @@ query predicate into a posting-list probe, not a sequential scan.
CREATE INDEX idx_articles_search ON articles USING GIN (search);

-- A saved analytical query: revenue per customer. A VIEW is a named query the
-- planner inlines wherever it's used — so you can SELECT, JOIN, GROUP and filter
-- it exactly like a table, and it always reflects the current rows.
CREATE VIEW customer_revenue AS
  SELECT c.id AS customer_id, c.name AS customer, c.country,
         SUM(p.price * o.quantity) AS revenue,
         COUNT(*) AS orders
  FROM orders o
  JOIN customers c ON o.customer_id = c.id
  JOIN products  p ON o.product_id = p.id
  GROUP BY c.id, c.name, c.country;
`.trim()

export const SAMPLE_QUERIES: SampleQuery[] = [
  {
    title: 'Full-text search — match & rank',
    sql: `-- @@ matches a TSVECTOR against a TSQUERY; ts_rank scores relevance
-- (the title is weighted 'A', so a title hit outranks a body hit).
SELECT id, title, ts_rank(search, to_tsquery('index | scan')) AS rank
FROM articles
WHERE search @@ to_tsquery('index | scan')
ORDER BY rank DESC;`,
  },
  {
    title: 'Full-text search — boolean & phrase operators',
    sql: `-- & (AND), | (OR), ! (NOT) and <-> (FOLLOWED BY, a phrase) compose.
-- 'sequential <-> scan' only matches the two words *adjacent*.
SELECT id, title
FROM articles
WHERE search @@ to_tsquery('join & !merge')
   OR search @@ phraseto_tsquery('sequential scan')
ORDER BY id;`,
  },
  {
    title: 'Full-text search — websearch + headline',
    sql: `-- websearch_to_tsquery parses Google-style input ("quoted phrases",
-- bare OR, leading - to exclude). ts_headline highlights the hit.
SELECT id, title,
       ts_headline(body, websearch_to_tsquery('inverted index -btree')) AS snippet
FROM articles
WHERE search @@ websearch_to_tsquery('inverted index -btree');`,
  },
  {
    title: 'Full-text search — the GIN index path (EXPLAIN)',
    sql: `-- With a GIN inverted index on articles.search, the planner walks the
-- query to a small candidate set and rechecks @@ — no sequential scan.
EXPLAIN SELECT id FROM articles WHERE search @@ to_tsquery('hash & join');`,
  },
  {
    title: 'Full-text search — build a tsvector / tsquery',
    sql: `-- to_tsvector tokenizes, lowercases, drops stop-words and Porter-stems;
-- positions and A/B/C/D weights make phrase search and ranking possible.
SELECT to_tsvector('The Quick brown foxes were jumping!') AS vector,
       to_tsquery('quick & jump:*')                       AS query,
       to_tsvector('The Quick brown foxes were jumping!')
         @@ to_tsquery('quick & jump:*')                  AS matches;`,
  },
  {
    title: 'Views — query a saved query',
    sql: `-- customer_revenue is a VIEW (a named query). Use it like a table:
-- filter it, sort it, even join it — it always reflects the live rows.
SELECT customer, country, revenue, orders
FROM customer_revenue
WHERE revenue > 300
ORDER BY revenue DESC;`,
  },
  {
    title: 'Views — define & compose one',
    sql: `-- A view can build on a table, and another view can build on it.
CREATE OR REPLACE VIEW big_spenders AS
  SELECT customer, country, revenue FROM customer_revenue WHERE revenue >= 500;
SELECT country, COUNT(*) AS whales, ROUND(AVG(revenue), 0) AS avg_spend
FROM big_spenders
GROUP BY country
ORDER BY avg_spend DESC;`,
  },
  {
    title: 'UPSERT — idempotent price feed (ON CONFLICT)',
    sql: `-- Re-running a feed is safe: an existing id UPDATEs, a new one INSERTs.
-- EXCLUDED is the row proposed for insertion. Run it twice — same result.
INSERT INTO products (id, name, category, price, in_stock) VALUES
  (1,  'Mechanical Keyboard', 'Hardware',    139.0,  50),
  (99, 'Desk Mat',            'Accessories',  24.0, 200)
ON CONFLICT (id) DO UPDATE
  SET price = EXCLUDED.price, in_stock = EXCLUDED.in_stock;
SELECT id, name, price, in_stock FROM products WHERE id IN (1, 99) ORDER BY id;`,
  },
  {
    title: 'UPSERT — running totals with a conditional update',
    sql: `-- A counters table accumulates per key. ON CONFLICT folds the new value
-- into the stored one; the WHERE only updates when the delta is positive.
CREATE TABLE IF NOT EXISTS hits (page TEXT PRIMARY KEY, n INTEGER DEFAULT 0);
INSERT INTO hits (page, n) VALUES ('/home', 3), ('/docs', 1), ('/home', 2)
ON CONFLICT (page) DO UPDATE SET n = hits.n + EXCLUDED.n WHERE EXCLUDED.n > 0;
SELECT page, n FROM hits ORDER BY n DESC, page;`,
  },
  {
    title: 'Decorrelation — EXISTS becomes a SemiJoin (EXPLAIN)',
    sql: `-- A correlated EXISTS is rewritten into a single hash SemiJoin instead of
-- re-running the subquery once per outer row. (NOT EXISTS → AntiJoin.)
EXPLAIN
SELECT c.name FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.quantity >= 2);`,
  },
  {
    title: 'Decorrelation — customers with no orders (AntiJoin)',
    sql: `EXPLAIN ANALYZE
SELECT c.name, c.country
FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
ORDER BY c.name;`,
  },
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
    title: 'Exact money — invoice totals (DECIMAL)',
    sql: `-- SUM/AVG over DECIMAL columns are exact to the cent (no float drift).
-- Compare TYPEOF: the totals are 'decimal', not 'real'.
SELECT COUNT(*)        AS invoices,
       SUM(subtotal)   AS subtotal,
       SUM(total)      AS billed,
       AVG(total)      AS avg_invoice,
       TYPEOF(SUM(total)) AS sum_type
FROM invoices;`,
  },
  {
    title: 'Decimal arithmetic vs. float (0.1 + 0.2)',
    sql: `-- DECIMAL is exact; the same sum in REAL famously is not.
SELECT DECIMAL '0.1' + DECIMAL '0.2'  AS exact_decimal,
       0.1 + 0.2                      AS binary_float,
       DECIMAL '19.99' * 3            AS price_times_three,
       DECIMAL '10' / DECIMAL '3'     AS one_third;`,
  },
  {
    title: 'Recompute tax exactly + verify stored total',
    sql: `-- subtotal × (1 + tax_rate), rounded to cents, equals the stored total.
SELECT id,
       subtotal,
       tax_rate,
       ROUND(subtotal * tax_rate, 2)        AS tax,
       ROUND(subtotal * (1 + tax_rate), 2)  AS computed_total,
       total,
       ROUND(subtotal * (1 + tax_rate), 2) = total AS matches
FROM invoices
ORDER BY id;`,
  },
  {
    title: 'TO_CHAR — formatted currency report',
    sql: `-- TO_CHAR's numeric templates: grouping, currency, fixed decimals.
SELECT i.id,
       c.name AS customer,
       TO_CHAR(i.subtotal, 'FM$999,999.00') AS subtotal,
       TO_CHAR(i.tax_rate * 100, 'FM990.00') || '%' AS tax_pct,
       TO_CHAR(i.total, 'FM$999,999.00')    AS total
FROM invoices i
JOIN customers c ON i.customer_id = c.id
ORDER BY i.total DESC;`,
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
    title: 'Dates & intervals — renewal schedule',
    sql: `-- DATE + INTERVAL is calendar-aware (a TIMESTAMP, Postgres-style);
-- the day-of-month is clamped, so Jan 31 + 1 month lands on the 28th/29th.
SELECT plan,
       started,
       term,
       started + term                      AS renews_on,
       EXTRACT(YEAR FROM started)          AS started_year,
       AGE(DATE '2026-06-15', started)     AS age
FROM subscriptions
ORDER BY started;`,
  },
  {
    title: 'Activity by month — DATE_TRUNC + EXTRACT',
    sql: `-- Bucket TIMESTAMP activity into calendar months and read fields out.
SELECT DATE_TRUNC('month', last_active)      AS month,
       COUNT(*)                              AS sessions,
       MIN(last_active)                      AS earliest,
       MAX(last_active)                      AS latest
FROM subscriptions
GROUP BY DATE_TRUNC('month', last_active)
ORDER BY month;`,
  },
  {
    title: 'Time-travel filter — typed comparisons & an index',
    sql: `-- A DATE column drives the B+Tree index; string literals coerce to dates.
EXPLAIN
SELECT id, plan, started
FROM subscriptions
WHERE started BETWEEN DATE '2024-01-01' AND '2024-12-31'
ORDER BY started;`,
  },
  {
    title: 'Referential integrity — cascade in a transaction',
    sql: `-- orders.customer_id REFERENCES customers(id) ON DELETE CASCADE.
-- Deleting Ada (id 1) inside a transaction removes her orders too; we read the
-- counts, then ROLLBACK so the seed is untouched.
BEGIN;
SELECT COUNT(*) AS adas_orders_before FROM orders WHERE customer_id = 1;
DELETE FROM customers WHERE id = 1;
SELECT COUNT(*) AS adas_orders_after FROM orders WHERE customer_id = 1;
SELECT COUNT(*) AS customers_left FROM customers;
ROLLBACK;
SELECT COUNT(*) AS customers_after_rollback FROM customers;`,
  },
  {
    title: 'Constraints — what gets rejected',
    sql: `-- Each of these would be refused (uncomment one to see the error):
--   a dangling foreign key:
-- INSERT INTO orders (id, customer_id, product_id, quantity) VALUES (999, 404, 1, 1);
--   a CHECK violation (quantity must be > 0):
-- INSERT INTO orders (id, customer_id, product_id, quantity) VALUES (999, 1, 1, 0);
--   deleting a product that still has orders (ON DELETE RESTRICT):
-- DELETE FROM products WHERE id = 1;
-- A FOREIGN KEY with a NULL component is exempt (MATCH SIMPLE):
INSERT INTO subscriptions (id, customer_id, plan) VALUES (99, NULL, 'Trial');
SELECT id, customer_id, plan FROM subscriptions WHERE id = 99;
DELETE FROM subscriptions WHERE id = 99;`,
  },
  {
    title: 'Evolve a schema — ALTER TABLE',
    sql: `-- Add a column with a DEFAULT (existing rows are backfilled), attach a CHECK,
-- then read it back. (Re-run resets via the seed.)
ALTER TABLE customers ADD COLUMN tier TEXT DEFAULT 'standard';
ALTER TABLE customers ADD CONSTRAINT tier_known
  CHECK (tier IN ('standard', 'gold', 'platinum'));
UPDATE customers SET tier = 'gold' WHERE country = 'UK';
SELECT name, country, tier FROM customers ORDER BY tier, name;`,
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
  {
    title: 'JSON — extract fields with -> and ->>',
    sql: `-- -> returns JSON, ->> returns text; chain them to dig in, and use a text
-- path with #>>. Arrows bind tighter than arithmetic, like a field access.
SELECT id,
       body ->> 'kind'                AS kind,
       body ->> 'priority'            AS priority,
       body #>> '{shipping,country}'  AS ships_to,
       body -> 'tags' -> 0            AS first_tag
FROM documents
ORDER BY id;`,
  },
  {
    title: 'JSON — containment (@>) filtering, served like any predicate',
    sql: `-- @> asks "does the left JSON contain the right?" — great for matching a
-- shape. Here: high-priority orders shipping express.
SELECT d.id, c.name, d.body ->> 'priority' AS priority
FROM documents d
JOIN customers c ON c.id = d.customer_id
WHERE d.body @> '{"kind":"order","shipping":{"express":true}}'
ORDER BY d.id;`,
  },
  {
    title: 'JSON — unnest an array in FROM (json_array_elements)',
    sql: `-- A set-returning function expands a JSON array into rows, which then
-- compose with the rest of SQL — GROUP BY, aggregates, ORDER BY, joins.
SELECT item ->> 'sku'                       AS sku,
       SUM(CAST(item ->> 'qty' AS INTEGER)) AS total_qty
FROM json_array_elements(
       '[{"sku":"A1","qty":2},{"sku":"B2","qty":1},{"sku":"A1","qty":10}]'
     ) AS line(item)
GROUP BY item ->> 'sku'
ORDER BY total_qty DESC;`,
  },
  {
    title: 'JSON — json_each unrolls an object into key/value rows',
    sql: `-- json_each turns the top-level members of an object into rows
-- (key TEXT, value JSON). KEY is a usable column name here.
SELECT key, value
FROM json_each('{"a":1,"b":[2,3],"c":{"nested":true}}')
ORDER BY key;`,
  },
  {
    title: 'JSON — build & aggregate (JSON_BUILD_OBJECT / JSON_AGG)',
    sql: `-- Roll each customer's documents up into one JSON array of summaries.
SELECT c.name,
       JSON_AGG(JSON_BUILD_OBJECT('kind', d.body ->> 'kind',
                                  'priority', d.body ->> 'priority')) AS docs
FROM customers c
JOIN documents d ON d.customer_id = c.id
GROUP BY c.name
ORDER BY c.name;`,
  },
  {
    title: 'JSON — reshape values (JSONB_SET, ||, JSON_PRETTY)',
    sql: `-- Patch a stored document: bump priority and merge in an audit stamp.
SELECT JSON_PRETTY(
         JSONB_SET(body, '{priority}', '"urgent"')
         || JSON_BUILD_OBJECT('reviewed', TRUE)
       ) AS patched
FROM documents
WHERE id = 3;`,
  },
]
