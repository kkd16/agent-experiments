# QueryForge — journal

An in-browser relational database engine, written from scratch in TypeScript: a real SQL
front-end (lexer → Pratt parser → AST), a cost-based rule optimizer, a Volcano iterator-model
executor, and a B+Tree storage layer — wrapped in a polished SQL IDE with an `EXPLAIN`
plan visualizer and a built-in self-test suite.

## Architecture (where things live)

- `src/db/lexer.ts` — tokenizer (also drives editor syntax highlighting)
- `src/db/parser.ts` — recursive-descent + Pratt expression parser → `ast.ts`
- `src/db/eval.ts` — compiled expression evaluator with SQL three-valued logic + scalar fns
- `src/db/planner.ts` — predicate pushdown, (composite) index selection, cost-based join &
  selectivity, aggregation, window planning
- `src/db/stats.ts` — column statistics (histograms, MCV, n-distinct) + selectivity estimators
- `src/db/operators.ts` — physical operators (SeqScan/IndexScan/Filter/Project/HashJoin/
  MergeJoin/NestedLoopJoin/Sort with external merge/Distinct/Limit) with cost + plan nodes
- `src/db/aggregate.ts` — HashAggregate (COUNT/SUM/AVG/MIN/MAX/STDDEV/VARIANCE/MEDIAN/
  STRING_AGG, DISTINCT, FILTER, GROUP BY)
- `src/db/window.ts` — window executor with explicit ROWS/RANGE frames
- `src/db/storage/btree.ts` — a genuine tuple-keyed B+Tree (node splits, chained leaves, range scans)
- `src/db/csv.ts` — CSV parser + type-inferring CREATE TABLE/INSERT generator
- `src/db/catalog.ts` — tables (heaps), single/composite indexes, constraints, stats cache, snapshots
- `src/db/engine.ts` — top-level: DDL/DML/SELECT/EXPLAIN + snapshot transactions
- `src/db/tests.ts` — 29 engine self-tests (run head-less in CI and in the Self-tests tab)
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
- [ ] Index-only (covering) scans that skip the heap fetch
- [ ] Bitmap-AND of multiple single-column indexes for multi-predicate filters
- [ ] `PERCENTILE_CONT`/`PERCENTILE_DISC` and `FILTER (WHERE …)` on aggregates

## Session log

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
