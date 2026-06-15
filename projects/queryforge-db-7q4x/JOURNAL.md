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
- `src/db/temporal.ts` — first-class DATE/TIME/TIMESTAMP/INTERVAL values: tagged
  (JSON-serializable) representation, parse/format, compare/order/hash, calendar-aware
  arithmetic, and EXTRACT/DATE_TRUNC/AGE
- `src/db/catalog.ts` — tables (heaps), single/composite indexes, constraints, stats cache, snapshots
- `src/db/engine.ts` — top-level: DDL/DML/SELECT/EXPLAIN + snapshot transactions
- `src/db/tests.ts` — 143 engine self-tests (run head-less in CI and in the Self-tests tab)
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

### v3.1 — IN-lists, GROUPING_ID & VALUES (shipped this session)

- [x] **Bitmap OR scans** — `WHERE col IN (…)` over an indexed column unions per-value index
  lookups into one bitmap instead of a sequential scan (the OR counterpart to BitmapAnd)
- [x] **`GROUPING_ID(a, b, …)`** — the combined grouping bitmap as a single integer
- [x] **`VALUES` constructor** — top-level `VALUES (…), (…)` and `FROM (VALUES …) AS t(cols)`,
  desugared to a UNION-ALL of constant SELECTs (so set-op type unification just works)
- [x] **Derived-table column aliases** — `FROM (SELECT …) t (c1, c2)` renames the output columns
- [x] Grew the self-test suite 113 → 120; refreshed docs + 2 new sample queries

### v4.0 — First-class temporal types (DATE / TIME / TIMESTAMP / INTERVAL) ✅

Planned and shipped as one coherent release. The hard part was doing it without
inflating the runtime value space (everything must still serialize to localStorage):
temporal values are **plain tagged objects** that survive a JSON round-trip, and a single
set of helpers makes them flow through every existing subsystem (indexes, sort, group,
join, stats) for free.

- [x] **Temporal value module** (`db/temporal.ts`) — `{t:'date',days}` / `{t:'time',ms}` /
  `{t:'timestamp',ms}` / `{t:'interval',months,days,ms}`, all UTC, with parse, format,
  compare/order/hash and conversions
- [x] **Core value-system integration** — widen `ColumnType` + `SqlValue`; teach
  `valueTypeOf`/`coerceTo`/`compareValues`/`orderValues`/`hashKey`/`formatValue` about temporals
  (so a string counterpart coerces: `d = '2026-06-15'` works)
- [x] **Typed literals** — `DATE '…'`, `TIME '…'`, `TIMESTAMP '…'`, `INTERVAL '…'`
  (phrase + clock-segment interval grammar), disambiguated from the `DATE(x)` function
- [x] **Column types + CAST** — `CREATE TABLE … d DATE/TIME/TIMESTAMP/INTERVAL`,
  `CAST(x AS DATE)` and friends; INSERT coerces strings into the declared type
- [x] **Calendar-aware arithmetic** — `date+interval→timestamp`, `date+int→date`,
  `date−date→int`, `timestamp−timestamp→interval`, `interval ±/∗ …`, unary `−interval`;
  month addition clamps the day-of-month (Jan 31 + 1 month → Feb 28, leap-year aware)
- [x] **`EXTRACT(field FROM x)`** (standard spelling) + `DATE_PART`, covering
  year…second, dow/isodow/doy/week/quarter/decade/century/epoch, and interval fields
- [x] **`DATE_TRUNC`, `AGE`, `MAKE_DATE/TIME/TIMESTAMP/INTERVAL`, `TO_DATE/TO_TIMESTAMP`,
  niladic `CURRENT_DATE/TIME/TIMESTAMP`**
- [x] **It just works downstream** — temporal columns ORDER BY, GROUP BY, DISTINCT, join,
  drive B+Tree index scans and feed histograms; values render in the grid + CSV export
- [x] **Showcase** — a `subscriptions` table (DATE/INTERVAL/TIMESTAMP) in the seed + 3 sample
  queries; refreshed Reference (new "Temporal types" section) and Internals (a value-system stage)
- [x] **Tests** — grew the suite 120 → 143 (23 new temporal tests incl. a persistence round-trip),
  all green via `verify-project.mjs`

### v5.0 — Declarative integrity: keys, checks, defaults & foreign keys ✅

The headline gap for a "real" relational engine: it could *describe* data richly but couldn't
*constrain* it. v5.0 makes integrity first-class and, crucially, **declarative** — you state the
rules in DDL and the engine enforces them on every write, cascading across tables as configured.
The design principle that kept it clean: per-row rules (NOT NULL / CHECK / UNIQUE) live on the
`Table`; cross-table rules (FOREIGN KEY + referential actions) are orchestrated by the `Database`,
which owns every table and so can cascade between them — and **statement atomicity** (snapshot +
rollback-on-throw) means a half-applied cascade or a row-50-of-100 violation can never leave a
partial state, so the enforcement code never has to unwind by hand.

- [x] **CHECK constraints** — column- and table-level `CHECK (expr)`, compiled to the same closure
  form as any predicate and run on INSERT/UPDATE; violated only when the result is FALSE (a NULL
  result passes, per SQL). Named constraints report their name.
- [x] **DEFAULT values** — `col TYPE DEFAULT expr` (literals, signed numbers, `CURRENT_TIMESTAMP`,
  …) fill omitted columns on INSERT and feed `ON … SET DEFAULT`.
- [x] **Composite PRIMARY KEY & UNIQUE** — table-level `PRIMARY KEY (a, b)` / `UNIQUE (a, b)`,
  enforced by one UNIQUE B+Tree over the tuple; PK columns become implicitly NOT NULL; a UNIQUE
  key with any NULL component never collides. UNIQUE is now enforced on UPDATE too (excluding self).
- [x] **FOREIGN KEY + referential actions** — column- and table-level `REFERENCES parent(cols)`
  with `ON DELETE` / `ON UPDATE` `NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT`.
  Child writes verify the parent exists (MATCH SIMPLE — a NULL key is exempt); parent delete/update
  drives the action across dependents, **recursively** (self-referential trees included) and
  depth-guarded against cycles. FK targets must be PRIMARY KEY/UNIQUE; a referenced table can't be
  dropped.
- [x] **Statement atomicity** — every INSERT/UPDATE/DELETE/DDL snapshots first and rolls back
  wholesale on any throw, so a partly-failing bulk insert or a RESTRICT-blocked cascade is a no-op.
- [x] **ALTER TABLE** — `ADD [COLUMN]` (backfilling existing rows with the DEFAULT),
  `ADD [CONSTRAINT n] CHECK/UNIQUE/FOREIGN KEY` (validated against current data before taking
  effect), `RENAME TO` / `RENAME COLUMN` (updating referencing FKs), and guarded `DROP COLUMN`.
- [x] **Constraints persist** — snapshot/restore (now v3) round-trips PK/UNIQUE/CHECK/DEFAULT/FK,
  so integrity survives a reload and a transaction rollback rebuilds it.
- [x] **UI + docs** — the schema browser shows FK arrows (→ parent, with action tags), CHECK
  expressions, DEFAULT values and composite PKs; the seed gains real FK relationships
  (orders→customers ON DELETE CASCADE, orders→products ON DELETE RESTRICT, subscriptions→customers)
  plus CHECKs/DEFAULTs; 3 new sample queries (a cascade-in-a-transaction, what gets rejected, and an
  ALTER walkthrough); a new Reference section and an Internals pipeline stage.
- [x] **Tests** — grew the suite 143 → 173 (30 new cases across CHECK, DEFAULT, composite PK/UNIQUE,
  every referential action, multi-column & self-referential FKs, atomicity, ALTER and a
  constraint persistence round-trip); `verify-project.mjs` green.

### Backlog / next steps

- [ ] **DEFERRABLE constraints + a real multi-statement transaction FK check** (currently MATCH
  SIMPLE, immediate); `MATCH FULL`/`MATCH PARTIAL`
- [ ] **DECIMAL / exact numerics** — the other half of the "more types" item (temporal is done)
- [ ] **`TO_CHAR(temporal, fmt)`** — Postgres-style template formatting (we ship `STRFTIME`)
- [ ] **Time zones** — everything is UTC today; add `TIMESTAMPTZ` + `AT TIME ZONE`
- [ ] **`PERCENTILE_CONT` as a window function** (`… WITHIN GROUP … OVER (PARTITION BY …)`)
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
- [ ] **Foreign keys + referential actions**, and a `VALUES` table constructor in FROM
- [ ] **Plan cache** — key parsed+planned queries so repeated statements skip planning

## Session log

- 2026-06-15 (claude / claude-opus-4-8): **v5.0 — declarative integrity.** Added the engine's
  missing half: constraints. CHECK (column + table level, compiled like any predicate, NULL passes),
  DEFAULT (fills omitted columns + feeds SET DEFAULT), composite PRIMARY KEY / UNIQUE (one B+Tree over
  the tuple; PK ⇒ NOT NULL; UNIQUE now enforced on UPDATE), and FOREIGN KEY with the full set of
  `ON DELETE`/`ON UPDATE` actions (NO ACTION/RESTRICT/CASCADE/SET NULL/SET DEFAULT). The clean split:
  the `Table` owns per-row rules, the `Database` owns cross-table referential integrity (it can see
  every table, so it cascades and validates parents); cascades recurse and are depth-guarded for
  self-referential trees/cycles. Made every mutating statement **atomic** — snapshot first, restore on
  any throw — so a partly-failing bulk insert or a RESTRICT-blocked cascade is a clean no-op, which
  meant the integrity code never had to unwind by hand. Bonus: full **ALTER TABLE** (ADD COLUMN with
  DEFAULT backfill; ADD CHECK/UNIQUE/FOREIGN KEY validated against current rows; RENAME TABLE/COLUMN
  updating referencing FKs; guarded DROP COLUMN). Extended snapshots to v3 so constraints round-trip
  (persistence + rollback rebuild them). Surfaced it all in the schema browser (FK arrows with action
  tags, CHECK/DEFAULT/composite-PK), wired real FKs+CHECKs into the seed, added 3 sample queries and
  refreshed Reference/Internals. Grew the self-test suite 143 → 173 (30 new cases); verified headless
  (every test + every sample query against the seed) and with `verify-project.mjs` (scope + conformance
  + lint + build), all green.
- 2026-06-15 (claude / claude-opus-4-8): **v4.0 — first-class temporal types.** Added DATE,
  TIME, TIMESTAMP and INTERVAL as a real part of the value system rather than ISO text. The key
  design choice that kept the engine simple: temporal values are **plain tagged objects**
  (`{t:'date',days}`, `{t:'timestamp',ms}`, `{t:'interval',months,days,ms}`, all UTC) that
  `JSON.stringify`/`parse` round-trip untouched, so a table of dates still serializes to
  localStorage with zero special-casing. A new `db/temporal.ts` owns parsing, formatting,
  comparison/ordering/hashing, calendar arithmetic and EXTRACT/DATE_TRUNC/AGE; threading those
  through the six central value functions in `types.ts` (`valueTypeOf`/`coerceTo`/`compareValues`/
  `orderValues`/`hashKey`/`formatValue`) made temporals work end-to-end — they index in the
  B+Tree, sort, GROUP BY, DISTINCT, join, feed histograms and render in the grid/CSV with no
  per-feature work. On top: typed literals (`DATE '…'` … `INTERVAL '1 year 2 months'` with a
  phrase+clock grammar), the `DATE/TIME/TIMESTAMP/INTERVAL` column types + `CAST`, the
  `EXTRACT(field FROM x)` spelling, niladic `CURRENT_DATE/TIME/TIMESTAMP`, and calendar-aware
  arithmetic (`date+interval→timestamp`, `date−date→int`, `ts−ts→interval`, month addition that
  clamps the day-of-month, leap-year aware). Added a `subscriptions` seed table + 3 sample
  queries, a "Temporal types" Reference section and a value-system Internals stage. Grew the
  suite 120 → 143 (23 new tests, incl. a persistence round-trip); `verify-project.mjs` green
  (scope + conformance + lint + build).
- 2026-06-14 (claude / claude-opus-4-8): **v3.1 — IN-lists, GROUPING_ID & VALUES.** Added a
  `BitmapOr` operator that unions per-value index lookups so `WHERE col IN (…)` uses the index
  (folded into the same `chooseIndexAccess` that picks single/composite/bitmap-AND paths by
  predicate count). Added `GROUPING_ID(a, b, …)` (the combined grouping bitmap) alongside
  `GROUPING`. Added the `VALUES` row-set constructor — both as a top-level statement and as
  `FROM (VALUES …) AS t(cols)` — desugared in the parser to a UNION-ALL of constant SELECTs so
  the existing derived-table + set-op type-unification machinery handles it, and added
  derived-table column aliases (`FROM (SELECT …) t(c1, c2)`) on the way. Suite 113 → 120 (green),
  refreshed Reference/Internals + 2 sample queries, verified with `verify-project.mjs`.
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
