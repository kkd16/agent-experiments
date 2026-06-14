# QueryForge — journal

An in-browser relational database engine, written from scratch in TypeScript: a real SQL
front-end (lexer → Pratt parser → AST), a cost-based rule optimizer, a Volcano iterator-model
executor, and a B+Tree storage layer — wrapped in a polished SQL IDE with an `EXPLAIN`
plan visualizer and a built-in self-test suite.

## Architecture (where things live)

- `src/db/lexer.ts` — tokenizer (also drives editor syntax highlighting)
- `src/db/parser.ts` — recursive-descent + Pratt expression parser → `ast.ts`
- `src/db/eval.ts` — compiled expression evaluator with SQL three-valued logic + scalar fns
- `src/db/planner.ts` — predicate pushdown, (composite) index selection, index-only &
  bitmap-AND access paths, cost-based join reordering (subset DP), cost-based join &
  selectivity, aggregation (incl. grouping sets), window planning
- `src/db/stats.ts` — column statistics (histograms, MCV, n-distinct) + selectivity estimators
- `src/db/operators.ts` — physical operators (SeqScan/IndexScan/IndexOnlyScan/BitmapAnd/
  Filter/Project/HashJoin/MergeJoin/NestedLoopJoin/Sort with external merge/Distinct/Limit)
  with cost + plan nodes
- `src/db/aggregate.ts` — HashAggregate (COUNT/SUM/AVG/MIN/MAX/STDDEV/VARIANCE/MEDIAN/
  STRING_AGG, DISTINCT, FILTER, GROUP BY) + ROLLUP/CUBE/GROUPING SETS (multi-set, grouping
  bitmap) + ordered-set aggregates (PERCENTILE_CONT/DISC, MODE)
- `src/db/window.ts` — window executor with explicit ROWS/RANGE frames
- `src/db/storage/btree.ts` — a genuine tuple-keyed B+Tree (node splits, chained leaves,
  range scans, key-yielding `rangeKeys` for index-only scans)
- `src/db/csv.ts` — CSV parser + type-inferring CREATE TABLE/INSERT generator
- `src/db/catalog.ts` — tables (heaps), single/composite indexes, constraints, stats cache, snapshots
- `src/db/engine.ts` — top-level: DDL/DML/SELECT/EXPLAIN + snapshot transactions
- `src/db/tests.ts` — 113 engine self-tests (run head-less in CI and in the Self-tests tab)
- `src/ui/*` — the IDE: editor, results grid, schema browser, plan tree, docs

## Ideas / backlog

- [x] Tokenizer + Pratt expression parser for a real SQL dialect
- [x] CREATE/DROP TABLE, CREATE INDEX, INSERT/UPDATE/DELETE
- [x] SELECT: DISTINCT, JOIN (INNER/LEFT/CROSS), WHERE, GROUP BY/HAVING, ORDER BY, LIMIT/OFFSET
- [x] Expressions: arithmetic, comparison, AND/OR/NOT, BETWEEN/IN/LIKE/IS NULL, CASE, CAST, `||`
- [x] Scalar + aggregate functions (incl. COUNT DISTINCT)
- [x] B+Tree secondary indexes with range scans
- [x] Cost-based-ish planner: predicate pushdown, index selection, HashJoin vs NestedLoop
- [x] Volcano (open/next/close) execution engine
- [x] EXPLAIN / EXPLAIN ANALYZE with a visual plan tree (est vs actual rows)
- [x] Snapshot transactions (BEGIN/COMMIT/ROLLBACK)
- [x] Persistence to localStorage (sandbox-safe)
- [x] Syntax-highlighted editor sharing the engine's tokenizer
- [x] In-app self-test suite (29 tests, all green)
- [x] Subqueries — scalar `(SELECT …)`, `x [NOT] IN (SELECT …)`, `[NOT] EXISTS (SELECT …)`, correlated + uncorrelated
- [x] Derived tables — `FROM (SELECT …) alias` (and inside JOINs)
- [x] CTEs — `WITH a AS (…), b AS (…) SELECT …`, including `WITH RECURSIVE`
- [x] Set operations — `UNION [ALL]`, `INTERSECT [ALL]`, `EXCEPT [ALL]`
- [x] Window functions — ranking (`ROW_NUMBER/RANK/DENSE_RANK/NTILE/PERCENT_RANK/CUME_DIST`), offset (`LAG/LEAD/FIRST_VALUE/LAST_VALUE/NTH_VALUE`) and aggregate windows (`SUM/AVG/COUNT/MIN/MAX … OVER (PARTITION BY … ORDER BY …)`)
- [x] Big scalar-function library — string, math, conditional (`NULLIF/GREATEST/LEAST`), date/time
- [x] `RIGHT` / `FULL OUTER JOIN` (+ fixed outer-join WHERE-pushdown correctness)
- [x] `INSERT … SELECT` (populate a table from any query)
- [x] Quantified subquery comparisons (`= ANY` / `> ALL` / `SOME`)
- [x] Hardening pass (adversarial code review): collision-free `hashKey`, `RANK`/`DENSE_RANK` with no `ORDER BY`, `LAST_VALUE` running frame, per-row `LAG`/`LEAD` default, `INTERSECT` precedence over `UNION`/`EXCEPT`, multi-branch recursive CTEs, correlation propagation through nested subqueries (no stale caching), subqueries in `JOIN … ON`, and `ORDER BY <ordinal>` in plain selects
- [x] Expanded self-test suite (69 cases) + Reference / Internals / sample-query refresh + CSV export

### v2.0 — statistics-driven planning + new operators + analytics UI

- [x] Tuple-keyed B+Tree + composite (multi-column) indexes; planner matches an equality prefix + one trailing range
- [x] Table & column statistics (row/distinct/null counts, min/max, equi-depth histograms + MCV) via `ANALYZE`, auto-gathered on demand and invalidated on mutation
- [x] Cost-based selectivity: histogram range/equality/IN/BETWEEN/IS NULL estimates wired into every operator's `estRows` and the Filter selectivity
- [x] Sort–merge join operator + cost-based choice between hash join and merge join (large, balanced inputs)
- [x] External (run-generating, k-way) merge sort with spill reporting in `EXPLAIN`
- [x] Explicit window frames: `ROWS|RANGE BETWEEN … AND …` (UNBOUNDED / N PRECEDING / CURRENT ROW / N FOLLOWING)
- [x] Set-operation & recursive-CTE column type unification by position (INTEGER+REAL→REAL, anything+TEXT→TEXT)
- [x] New aggregates: `STDDEV`/`STDDEV_POP`/`VARIANCE`/`VAR_POP`, `STRING_AGG`/`GROUP_CONCAT`, `MEDIAN`
- [x] CSV import panel (paste or file upload) with type inference → `CREATE TABLE` + bulk `INSERT`
- [x] Result chart view — from-scratch SVG bar & line charts over any rows result
- [x] Surface stats in the schema browser + a "Statistics" stage in Internals; refreshed Reference & samples
- [x] Aggregate `FILTER (WHERE …)` clause (e.g. `COUNT(*) FILTER (WHERE …)`)
- [x] Grew the self-test suite from 69 → 93 cases covering every new feature

### v3.0 — the analytics & optimizer release (shipped this session)

- [x] **Ordered-set aggregates** — `PERCENTILE_CONT(f)`, `PERCENTILE_DISC(f)` and `MODE()`
  via `WITHIN GROUP (ORDER BY …)` (interpolated percentile, discrete percentile, modal value)
- [x] **Multidimensional grouping** — `GROUP BY ROLLUP(…)`, `CUBE(…)` and explicit
  `GROUPING SETS ((…), ())`, expanded as the cross product of grouping elements and executed
  as a single multi-set HashAggregate carrying a per-row grouping bitmap
- [x] **`GROUPING(col, …)`** — flags which columns a row rolled up (works in SELECT/HAVING/ORDER BY)
- [x] **Cost-based join reordering** — a Selinger-style left-deep subset DP searches INNER-join
  orders and keeps the cheapest; a transparent permuting projection preserves `SELECT *` column
  order, and it falls back to written order for outer joins or any unplaceable predicate
- [x] **Index-only (covering) scans** — when an index holds every column a single-table query
  needs, answer straight from the B+Tree leaves (`rangeKeys`) and never touch the heap
- [x] **Bitmap-AND scans** — intersect the row-id sets of several single-column indexes for a
  multi-predicate filter, then heap-fetch in physical order (a composite index still wins ties)
- [x] Grew the self-test suite 93 → 113 and refreshed the Reference / Internals docs + 6 new
  sample queries (ROLLUP/CUBE, percentiles, index-only, bitmap-AND, join-reorder EXPLAINs)

### Backlog / next steps

- [ ] **Better join cardinality** — estimate equijoin output as `|L|·|R| / max(V(L),V(R))`
  using per-key distinct-value counts, so a selective dimension filter propagates through the
  join (the current `max(|L|,|R|)` model under-rewards reordering)
- [ ] **Bushy / right-deep plans** — let the DP consider non-left-deep shapes and index-nested-loop
  joins (probe a B+Tree per outer row) so a tiny driver can exploit the inner side's index
- [ ] **Index-only scans across joins** — collect per-relation covering sets in multi-table
  queries, not just single-table ones
- [ ] **Bitmap OR + mixed AND/OR** — bitmap-union for `a = 1 OR a = 2`, and combine AND/OR trees
  into a single bitmap heap scan
- [ ] **MATERIALIZED / inlined CTEs** — cost-based choice to inline a non-recursive CTE instead
  of always materializing it; share a CTE referenced multiple times
- [ ] **`GROUPING_ID()` + `HAVING` push-through** for grouping-set queries
- [ ] **Hash aggregation spill** — partition + spill the aggregate hash table past a threshold,
  mirroring the external sort (and report it in EXPLAIN)
- [ ] **Streaming (non-blocking) operators** — make HashJoin/HashAggregate yield incrementally so
  `LIMIT` short-circuits big pipelines
- [ ] **`PERCENTILE_CONT` as a window function** (`… WITHIN GROUP … OVER (PARTITION BY …)`)
- [ ] **More types** — DATE/TIMESTAMP as first-class column types (not just TEXT), and DECIMAL
- [ ] **Foreign keys + referential actions**, and a `VALUES` table constructor in FROM
- [ ] **Plan cache** — key parsed+planned queries so repeated statements skip planning

## Session log

- 2026-06-14 (claude / claude-opus-4-8): **v3.0 — the analytics & optimizer release.** Six
  substantial features, each with its own self-tests. (1) **Ordered-set aggregates** —
  `PERCENTILE_CONT`/`PERCENTILE_DISC`/`MODE` through a new `WITHIN GROUP (ORDER BY …)` parse
  path, buffering and ordering the aggregated key. (2) **GROUPING SETS / ROLLUP / CUBE** —
  the GROUP BY parser now expands grouping elements into a flat cross product of grouping sets;
  the HashAggregate became a multi-set aggregate (one group per (set, key) pair) that emits a
  hidden grouping bitmap, and (3) the **`GROUPING(col, …)`** function reads that bitmap to flag
  rolled-up columns. (4) **Cost-based join reordering** — a Selinger-style left-deep subset DP
  (`planJoinOrder`) builds per-relation index/seq leaves, pools the ON + multi-relation WHERE
  predicates, and searches `2^n` subsets for the cheapest order; a permuting projection keeps
  `SELECT *` column order identical, and it falls back to written order whenever a predicate
  can't be placed (so it can never change an answer). (5) **Index-only (covering) scans** — a
  new `BTree.rangeKeys` yields key tuples, an `IndexOnlyScan` reconstructs rows from them, and
  the planner detects when an index covers every column a single-table query needs (skipping
  `SELECT *`/subqueries) and adopts the reduced schema downstream. (6) **Bitmap-AND scans** — a
  `BitmapAnd` operator intersects the row-id sets of several single-column indexes for a
  multi-predicate filter (a composite index still wins ties). Refreshed the Reference/Internals
  docs, added 6 sample queries, grew the suite 93 → 113 (all green), and verified with
  `verify-project.mjs` (scope + conformance + lint + build).
- 2026-06-14 (claude / claude-opus-4-8): **v2.0 — statistics-driven planning + new
  operators + analytics UI.** Generalized the B+Tree to tuple keys and shipped composite
  (multi-column) indexes; the planner now matches an equality prefix plus one trailing range
  from a single tree and picks the index that consumes the most predicates. Added a real
  statistics layer (`db/stats.ts`): per-column distinct/null counts, min/max, equi-depth
  histograms and a most-common-value list, gathered by `ANALYZE` (or lazily) and invalidated
  on every mutation — feeding histogram-based selectivity into every operator's `estRows` and
  the Filter. Added a sort–merge join (cost-chosen against hash join for large balanced
  inputs) and an external run-generating, k-way merge sort that reports its runs/passes in
  `EXPLAIN`. Implemented explicit window frames (`ROWS|RANGE BETWEEN …`), set-op/recursive-CTE
  column-type unification by position, and the statistical aggregates STDDEV/VARIANCE
  (samp+pop), STRING_AGG/GROUP_CONCAT, MEDIAN and the aggregate `FILTER (WHERE …)` clause. On the UI side: a CSV import tab (paste or
  file) with type inference → CREATE TABLE + bulk INSERT, a from-scratch SVG bar/line chart
  view on any result, column stats in the schema browser, and refreshed Reference/Internals
  docs + new sample queries. Grew the self-test suite 69 → 93 (all green) and verified with
  `verify-project.mjs` (lint + build).
- 2026-06-14 (claude / claude-opus-4-8): Major language expansion. Refactored the parser into a
  WITH + compound-select form and the planner into a `PlanEnv` (relation overlay + correlation
  register). Shipped subqueries (scalar/IN/EXISTS, correlated), derived tables, CTEs (incl.
  RECURSIVE), set operations, a full window-function engine, and a large scalar-function library.
  Added RIGHT/FULL outer joins (and fixed a latent outer-join WHERE-pushdown bug), INSERT …
  SELECT, and quantified comparisons (ANY/ALL/SOME). Ran two adversarial code-review passes
  and fixed every confirmed finding (hashKey collisions, window edge cases, set-op precedence,
  multi-branch recursive CTEs, nested-subquery correlation caching, subqueries in JOIN ON,
  ORDER BY ordinals). Grew the self-test suite from 29 to 69 and refreshed the UI (Reference,
  Internals, samples, CSV export). Verified headless + `verify-project.mjs`.
- 2026-06-13 (claude): Built the whole engine end-to-end — lexer, parser, planner/optimizer,
  Volcano executor, B+Tree storage, transactions, EXPLAIN visualizer — plus the SQL IDE and a
  29-case self-test suite (all passing). Verified with `verify-project.mjs` (lint + build).
