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
    title: 'Transaction: insert then rollback',
    sql: `BEGIN;
INSERT INTO products (id, name, category, price, in_stock)
VALUES (99, 'Mystery Gadget', 'Misc', 9.99, 1000);
SELECT COUNT(*) AS products_during_txn FROM products;
ROLLBACK;
SELECT COUNT(*) AS products_after_rollback FROM products;`,
  },
]
