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
- `src/db/window.ts` — window executor: ranking/offset/value/aggregate/ordered-set/statistical
  functions over ROWS/RANGE/GROUPS frames with EXCLUDE, typed RANGE offsets, FILTER, IGNORE NULLS
- `src/db/storage/btree.ts` — a genuine tuple-keyed B+Tree (node splits, chained leaves,
  range scans, key-yielding `rangeKeys` for index-only scans)
- `src/db/csv.ts` — CSV parser + type-inferring CREATE TABLE/INSERT generator
- `src/db/decimal.ts` — first-class exact numerics: DECIMAL/NUMERIC as a tagged,
  JSON-serializable value `{t:'decimal', d, s}` (unscaled BigInt rendered to a
  string + a scale). BigInt arithmetic (add/sub/mul/div/mod, round/trunc/floor/
  ceil, rescale), exact comparison, canonical hashing, parse/format, and
  Postgres-style numeric `TO_CHAR` template formatting.
- `src/db/temporal.ts` — first-class DATE/TIME/TIMESTAMP/INTERVAL values: tagged
  (JSON-serializable) representation, parse/format, compare/order/hash, calendar-aware
  arithmetic, and EXTRACT/DATE_TRUNC/AGE
- `src/db/json.ts` — first-class JSON (jsonb-style): a tagged, `JSON.stringify`-round-trippable
  value `{t:'json', v}` with normalized (sorted/de-duplicated) object keys, canonical + pretty
  serialization, deep-equal, a total order, canonical hash, path navigation, `@>` containment,
  `?` existence, `||` concat/merge, `jsonbSet`/`stripNulls`, and `toJson` — threaded through the
  six central value functions just like temporal/decimal
- `src/db/array.ts` — first-class ARRAY values: a tagged, `JSON.stringify`-round-trippable
  value `{t:'array', el, items}` (elements may be arrays → multi-dimensional), with a total order,
  containment/overlap, subscript/slice, the search/edit helpers, the `{…}` text formatter + parser,
  and shape introspection — threaded through the central value functions just like json/temporal
- `src/db/catalog.ts` — tables (heaps), single/composite indexes, constraints, stats cache, snapshots
- `src/db/fts.ts` — first-class full-text search: a from-scratch Porter (1980) stemmer + stop-words +
  positional tokenizer; the `tsvector` (`{t:'tsvector', lex}`) and `tsquery` (`{t:'tsquery', node}`)
  tagged values; an operator-precedence query parser; a positional `@@` match executor with true
  phrase (`<->`) semantics; `ts_rank`/`ts_rank_cd`; `ts_headline`; and the GIN candidate walker
- `src/db/engine.ts` — top-level: DDL/DML/SELECT/EXPLAIN, `RETURNING`, `MERGE`, `TRUNCATE`, and
  snapshot transactions with `SAVEPOINT`/`ROLLBACK TO`/`RELEASE`
- `src/db/pl.ts` — PL/QF: the procedural-language interpreter (variable frames, control flow,
  record NEW/OLD, variable→literal substitution into embedded SQL) for stored functions/procedures
  and trigger bodies; decoupled from the engine via a small `PlHost` interface
- `src/db/concurrency/*` — the MVCC engine, standalone from the SQL core:
  `mvcc.ts` (version chains, snapshot visibility, write-conflict + SSI logic),
  `runner.ts` (the deterministic schedule runner with lock-wait/deadlock handling and
  per-step world snapshots), `scenarios.ts` (the canonical anomaly library), `tests.ts`
  (the `concurrency` self-test group)
- `src/db/tests.ts` — 379 engine self-tests (run head-less in CI and in the Self-tests tab)
- `src/ui/*` — the IDE: editor, results grid, schema browser, plan tree, docs, Concurrency Lab

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
- [x] **ARIES write-ahead logging & crash recovery** (`db/recovery/*`) — a from-scratch WAL engine
      (pageLSN, forced log vs. volatile tail, STEAL/NO-FORCE buffer pool, fuzzy checkpoints) and the
      full three-pass restart algorithm (Analysis → Redo → Undo with CLRs + undoNextLSN), surfaced as
      a **Recovery Lab** (scrub a workload → crash → recovery) with 16 self-tests (v16.0)
- [ ] **Group commit** — batch several transactions' commit records into one log force.
- [ ] **Log-record granularity below the page** (slotted-page / physiological logging) so two txns
      can dirty the same page without the false WAL conflict a whole-page cell model implies.
- [ ] **Wire the WAL to the real engine** — emit log records from the heap/B+Tree mutators and add a
      `RECOVER` command that replays a persisted log instead of the localStorage snapshot.
- [ ] **Media recovery** — an archive log + a full restore-then-roll-forward from a page-image backup.

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

### v6.0 — First-class exact numerics (DECIMAL / NUMERIC) ✅

The other half of "more types" (temporal was v4.0): money and any value that must
be **exact**. The design mirrors temporal exactly — a single new tagged value that
flows through the whole engine by teaching the six central value functions about it,
so it indexes, sorts, groups, joins, aggregates and persists for free. The one twist
was serialization: a `BigInt` can't be `JSON.stringify`'d, so a DECIMAL stores its
unscaled integer as a **string** (`{t:'decimal', d:'-1999', s:2}` = -19.99) and lifts
it back to `BigInt` for arithmetic — keeping the localStorage round-trip intact while
arithmetic stays arbitrary-precision and exact.

- [x] **`db/decimal.ts`** — BigInt-backed value module: parse/format, exact
  `+ − × ÷ %`, `round`/`trunc`/`floor`/`ceil`/`rescale`/`abs`/`neg`/`sign`,
  scale-independent compare, canonical hashing, precision, and a numeric
  `TO_CHAR` template engine.
- [x] **Value-system integration** — widened `ColumnType` (+`DECIMAL`) and `SqlValue`;
  taught `valueTypeOf`/`coerceTo`/`compareValues`/`orderValues`/`hashKey`/`formatValue`
  about decimals, so `1.50 = 1.5 = 2 = the integer-equal value` all share one identity
  and a decimal indexes / sorts / groups / joins like any column.
- [x] **Literals & types** — `DECIMAL '…'` / `NUMERIC '…'` / `DEC '…'` typed literals
  (with exponent), `DECIMAL(precision, scale)` column types and `CAST(x AS DECIMAL(p,s))`,
  rounding to the declared scale on store / cast (half-up). `NUMERIC` / `DEC` aliases.
- [x] **Exact arithmetic with documented scale rules** — `+/−` → max scale, `×` → sum of
  scales, `÷` → ≥ 6 fractional digits (half-up), `÷0` → NULL. Exact against DECIMAL/INTEGER;
  a non-integer REAL degrades the expression to floating point (Postgres `numeric` vs `double`).
- [x] **Exact aggregates** — `SUM`/`AVG` over a DECIMAL stay exact (a money SUM never loses a
  cent); MIN/MAX/MEDIAN/percentiles and the **window** `SUM/AVG OVER` paths all handle decimals.
- [x] **Exact scalar functions** — `ABS/SIGN/ROUND/TRUNC/CEIL/FLOOR/MOD` keep a DECIMAL exact
  (incl. `ROUND(x, −n)`); new `TO_NUMBER`, `DECIMAL(x[,scale])`, `SCALE`, `PRECISION`; `TYPEOF`
  reports `'decimal'`.
- [x] **`TO_CHAR` numeric templates** — `9 0 . , (D G) S MI PR $ L FM` and `#`-on-overflow,
  e.g. `TO_CHAR(1234.5,'FM$999,999.00') → $1,234.50` (the existing temporal `TO_CHAR` still works).
- [x] **Stats & indexes** — histogram/MCV/ndistinct estimators read decimals (exact key + numeric
  position); B+Tree indexes them via the shared total order with zero new code.
- [x] **Showcase** — an `invoices` table with `DECIMAL(12,2)` money + `DECIMAL(5,4)` tax columns in
  the seed; 4 new sample queries (exact totals, float-vs-decimal, recomputed tax = stored total, a
  TO_CHAR currency report); a Reference section, an Internals stage, and `DECIMAL(p,s)` in the schema browser.
- [x] **Tests** — grew the suite 173 → 190 (16 decimal cases + a new "every sample query runs against
  the seed" guard + an invoices integrity check); `verify-project.mjs` green.

### v7.0 — Views, UPSERT & the optimizer learns to decorrelate ✅ (shipped this session)

The headline gaps for a "real" relational engine that the prior releases never closed: a query
couldn't be *named and reused* (no `VIEW`), an INSERT couldn't *reconcile* against an existing
row (no UPSERT), and a correlated `EXISTS` was always evaluated the slow way (re-running the
subquery per outer row) instead of being turned into a join. v7.0 ships all three, each
independently and with its own self-tests.

**A. Views — `CREATE VIEW` / `DROP VIEW`**
- [x] AST: `CreateViewStmt` (`OR REPLACE` / `IF NOT EXISTS`, optional column list) + `DropViewStmt`
- [x] Parser: `CREATE [OR REPLACE] VIEW name [(cols)] AS <query>` and `DROP VIEW [IF EXISTS] name`
- [x] Catalog: a `views` map on `Database` (`{name, columns?, select}`), name-collision checks against tables
- [x] Planner: resolve a view name in `relationFor` by materializing its body as a derived table —
      so a view works in FROM, JOIN, subqueries and inside other views, with a cycle guard
- [x] Engine: `create_view` / `drop_view` dispatch; validate the body plans at creation time
- [x] Persistence: snapshot bumped to v4 (round-trips views); make `loadDb` version-tolerant
      (fixes a latent bug where the loader was pinned to v1 and never restored anything)
- [x] UI: a "Views" section in the schema browser; Reference + Internals docs; a seed view + samples

**B. UPSERT — `INSERT … ON CONFLICT`**
- [x] AST: `InsertStmt.onConflict` (optional target columns + `DO NOTHING` | `DO UPDATE SET … [WHERE …]`)
- [x] Parser: the `ON CONFLICT [(cols)] DO …` tail, with `EXCLUDED.col` references in the SET/WHERE
- [x] Engine: detect a UNIQUE/PK conflict *before* inserting (via the existing unique B+Trees); on a
      hit, skip (`DO NOTHING`) or update the existing row (`DO UPDATE`) — `EXCLUDED.*` binds the
      proposed row, the table's own columns bind the existing row; statement atomicity already covers rollback
- [x] Tests + docs + a seed showcase (re-running a price feed idempotently)

**C. Subquery decorrelation — `[NOT] EXISTS` → hash SemiJoin / AntiJoin**
- [x] New physical operator: `HashSemiJoin` (with an `anti` flag) — build a hash set on the inner
      key tuples, probe with the outer keys; NULL keys never match (exactly `EXISTS` / `NOT EXISTS`
      semantics), and a key-less form degrades to "inner is (non-)empty"
- [x] Planner: rewrite a top-level `WHERE … [NOT] EXISTS (…)` conjunct into a semi/anti join when the
      correlation decomposes into equi-keys + inner-local predicates; **falls back** to the existing
      per-row evaluator for any shape it can't prove equivalent, so it can never change an answer
- [x] `EXPLAIN` shows `SemiJoin` / `AntiJoin (hash)` with the inner subplan as its right child
- [x] Tests (correlated & uncorrelated, NULL handling, fall-back cases) + docs + a sample EXPLAIN
 / next steps

### v8.0 — first-class JSON / JSONB (planned 2026-06-15)

The one glaring gap versus a real modern SQL engine: JSON. Build it the same way temporal and
decimal were built — a tagged, `JSON.stringify`-round-trippable value (`{t:'json', v}`) threaded
through the six central value functions in `types.ts`, so a JSON value indexes in the B+Tree,
sorts, GROUP BYs, DISTINCTs, joins, persists and renders for free — then add the operator and
function surface on top. jsonb semantics: object keys normalized (sorted, duplicates → last wins),
deep structural equality and a total order. Steps:

- [x] `src/db/json.ts` — the value module: strict parse, canonical (sorted-key) + pretty stringify,
      `jsonTypeof`, deep-equal, a total `jsonOrder`, canonical hash, path navigation (object key /
      array index, negative indices), `@>` containment, `?` key existence, `||` concat/merge,
      `jsonbSet`, `stripNulls`, and `toJson(SqlValue)`
- [x] `types.ts` — register `JSON` as a `ColumnType` + `JsonValue` in `SqlValue`; thread through
      `valueTypeOf` / `coerceTo` (TEXT⇄JSON) / `compareValues` / `orderValues` / `hashKey` /
      `formatValue` so JSON is a first-class value everywhere
- [x] `lexer.ts` — tokenize the JSON operators `->`, `->>`, `#>`, `#>>`, `@>`, `<@`, `?`, and the
      Postgres `::` cast (3-char-aware scanner). Also unreserved `KEY` (Postgres-non-reserved) so it
      can be a column name (e.g. the `key` column of `json_each`)
- [x] `parser.ts` — `JSON`/`JSONB` type name, `expr::TYPE` postfix cast (binds tightest), and the
      new infix operators with the right precedence (extraction tight, containment at comparison)
- [x] `eval.ts` — evaluate the new binary operators; a library of JSON scalar functions
      (`TO_JSON`, `JSON_BUILD_OBJECT/ARRAY`, `JSON_ARRAY_LENGTH`, `JSON_TYPEOF`, `JSON_OBJECT_KEYS`,
      `JSON_EXTRACT_PATH(_TEXT)`, `JSON_VALID`, `JSON_PRETTY`, `JSON_STRIP_NULLS`, `JSONB_SET`,
      `JSON_CONTAINS`) and extend `||` to JSON concat/merge
- [x] `aggregate.ts` + `planner.ts` — `JSON_AGG(x)` and `JSON_OBJECT_AGG(k, v)` (two-arg aggregate),
      and `inferType` for every JSON-returning op/function so result columns carry type `JSON`
- [x] **capstone:** set-returning table functions in FROM — `JSON_ARRAY_ELEMENTS`,
      `JSON_ARRAY_ELEMENTS_TEXT`, `JSON_EACH`, `JSON_EACH_TEXT`, `JSON_OBJECT_KEYS` — the planner
      materializes the produced rows into a synthetic relation, so JSON unnests into rows and composes
      with joins/where/group by for free (arguments must be constant — LATERAL is not supported)
- [x] seed a `documents` table with JSON, 6 sample queries, a Reference section, an Internals stage,
      and a 26-case self-test group; verified headless (246 tests green) + `verify-project.mjs`

### v9.0 — first-class full-text search (`tsvector` / `tsquery` + a GIN inverted index) (planned 2026-06-16)

The last big capability a modern SQL engine has that QueryForge didn't: **full-text search**. Build
it the exact same way JSON, temporal and decimal were built — a pair of tagged,
`JSON.stringify`-round-trippable values (`{t:'tsvector', …}`, `{t:'tsquery', …}`) threaded through
the six central value functions in `types.ts`, so a search document indexes, sorts, GROUP BYs,
DISTINCTs, joins, persists and renders for free — then layer the linguistic processing, the match
operator, ranking, headlines and a real inverted index on top. Everything from scratch, deterministic,
self-tested. Steps:

- [x] `src/db/fts.ts` — the engine: a from-scratch **Porter (1980) stemmer** (all five steps), an
      English stop-word list, and a text→lexeme normalizer that lowercases, splits on non-word
      boundaries, drops stop-words/over-long tokens and records 1-based positions
- [x] `TsVector` value — a sorted, de-duplicated lexeme list, each carrying its sorted positions and a
      parallel A/B/C/D weight per position; canonical Postgres-style text form `'fat':2A 'cat':3`
- [x] `TsQuery` value — a boolean AST over lexemes with `&` `|` `!`, the phrase/`<->` (FOLLOWED BY) and
      `<N>` distance operators, prefix (`:*`) and weight-filtered (`:AB`) terms, with full operator
      precedence + parentheses; canonical text form that round-trips
- [x] constructors — `to_tsvector`, `to_tsquery`, `plainto_tsquery`, `phraseto_tsquery`,
      `websearch_to_tsquery` (quotes → phrase, `or`, leading `-` → NOT), `setweight`, `strip`,
      `tsvector || tsvector` (position-shifted concat), `tsquery && / || / !!`, `numnode`, `querytree`
- [x] **match** — `tsvector @@ tsquery` with true positional **phrase** semantics (a position-set
      executor so `a <-> b <-> c` requires adjacency, distances chain, `!` and `&`/`|` compose), plus
      the convenience coercions `text @@ tsquery`, `tsvector @@ text`, `text @@ text`
- [x] **ranking** — `ts_rank` (weighted by A/B/C/D term weights, with the 0/1/2/4/8/16/32 length-
      normalization bitmask) and `ts_rank_cd` (Clarke-style cover-density over positions), plus
      `ts_headline(document, query)` that re-tokenizes the original text and wraps the matched words
- [x] `types.ts` — register `TSVECTOR`/`TSQUERY` as `ColumnType`s + in `SqlValue`; thread through
      `valueTypeOf` / `coerceTo` (TEXT⇄tsvector/tsquery) / `compareValues` / `orderValues` / `hashKey` /
      `formatValue` so both are first-class values everywhere
- [x] `lexer.ts` + `parser.ts` — tokenize `@@`; parse it at comparison precedence; recognize the
      `TSVECTOR`/`TSQUERY` type names for CAST and column declarations
- [x] `eval.ts` — evaluate `@@`; register the whole FTS scalar-function library; `inferType` so
      results carry the right type
- [x] **capstone — a GIN inverted index.** `CREATE INDEX … USING GIN (col)` builds a lexeme→rowids
      inverted index in the catalog; the planner detects `col @@ <const tsquery>`, walks the query AST
      to a conservative candidate rowset (postings union/intersection), and emits a `GinScan` that
      rechecks `@@` exactly — so search is sublinear and `EXPLAIN` shows the index path. Strictly
      additive: with no GIN index the same query is a correct seq-scan filter
- [x] seed a `posts` table with `tsvector` documents, add 6 sample queries, a Reference section, an
      Internals stage, and a self-test group; verify headless + `verify-project.mjs`

### v10.0 — window functions, to the SQL standard (shipped 2026-06-18)

QueryForge already ships ranking/offset/value/aggregate windows and explicit `ROWS|RANGE`
frames, but the window story stops short of the standard exactly where windows get powerful
(and where most engines are incomplete). v10.0 finishes it — a genuinely standard-grade window
engine — kept tightly contained to `ast.ts`, `parser.ts`, `planner.ts`, `window.ts` and
`eval.ts`/`tests.ts`, so it touches no storage/optimizer code and can't regress the rest. Each
step lands with its own self-tests, several differential (computed two independent ways). Steps:

- [x] **`GROUPS` frame mode** — `GROUPS BETWEEN n PRECEDING AND m FOLLOWING`: a third frame mode
      alongside `ROWS`/`RANGE` that counts *peer groups* (distinct ORDER BY values), not rows or
      values. A per-partition dense group index drives the bounds.
- [x] **The `EXCLUDE` clause** — `EXCLUDE NO OTHERS | CURRENT ROW | GROUP | TIES` on any frame,
      removing the current row, its whole peer group, or its peers-but-self from the frame before
      the function reads it (correct for every frame-sensitive function, including value funcs).
- [x] **`RANGE` frames over real value types** — typed offset arithmetic so
      `RANGE BETWEEN 5 PRECEDING AND CURRENT ROW` works over numbers *and* exact `DECIMAL`, and
      `RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW` works over `DATE`/`TIMESTAMP`
      order keys — value-based bounds (not numeric-coerced) honouring ASC/DESC direction.
- [x] **The `WINDOW` clause** — `… OVER w … WINDOW w AS (PARTITION BY …), w2 AS (w ORDER BY …)`:
      named window definitions plus window-reference *inheritance* (a spec may extend a named base,
      adding ORDER BY / a frame), resolved during binding.
- [x] **Ordered-set aggregates as window functions** — `PERCENTILE_CONT(0.5) WITHIN GROUP
      (ORDER BY x) OVER (PARTITION BY g)` and `PERCENTILE_DISC` / `MODE` as windows, plus
      `STDDEV`/`VARIANCE` window aggregates — all frame-aware.
- [x] **`IGNORE NULLS` / `RESPECT NULLS`** — null treatment for `FIRST_VALUE`/`LAST_VALUE`/
      `NTH_VALUE`/`LAG`/`LEAD` (skip nulls when selecting the value), the standard `FROM_FIRST`
      defaults preserved when omitted.
- [x] **Aggregate-window `FILTER (WHERE …)`** — carry the existing `FILTER` clause into window
      aggregates so only matching rows in the frame contribute.
- [x] **`QUALIFY` clause** — filter on window-function results without a wrapping subquery
      (`QUALIFY ROW_NUMBER() OVER (…) = 1`); a post-window `Filter` that also collects its window
      functions, running after the window stage and before DISTINCT/ORDER BY/LIMIT.
- [x] refresh the Reference + Internals docs and add showcase sample queries; grow the self-test
      suite and verify headless + `verify-project.mjs` (scope + conformance + lint + build).

### v11 — productive DML & transaction control (this session)

QueryForge can plan and read almost anything a grown-up SQL engine can, but its *write* surface
stopped at plain INSERT/UPDATE/DELETE (+ UPSERT) and all-or-nothing BEGIN/COMMIT/ROLLBACK. This
release closes that gap: the statements you reach for when you actually move data around — get the
rows you just changed back, fold a staging set into a table in one pass, undo part of a transaction,
empty a table fast — and, on the read side, the one correlated-FROM shape (`LATERAL`) the planner
explicitly refused. Each step lands with its own self-tests; several are differential (the same
effect computed a second, independent way). Strictly additive — the existing 288 tests stay green.

- [x] **`RETURNING`** on `INSERT` / `UPDATE` / `DELETE` (and `MERGE`) — a mutating statement can
      now produce a result set of the rows it touched. INSERT/UPDATE return the *new* row image
      (post-default, post-coercion, post-upsert), DELETE the *old* row; the clause is a full
      projection (expressions, `*`, `table.*`, aliases) bound to the target's schema, so
      `INSERT … RETURNING id` (read a generated key) and `DELETE … RETURNING *` (audit what left)
      both work. A new `RowsResult` path through the engine; affected rows captured in each DML loop.
- [x] **`MERGE`** — `MERGE INTO target USING source ON <cond> WHEN [NOT] MATCHED [AND p] THEN
      UPDATE/DELETE/INSERT/DO NOTHING …`: the SQL:2003 "upsert from a set" statement. Source is any
      table / derived table / `VALUES`; the ON condition is compiled over the combined
      `[target | source]` row; each source row finds its matched target rows (a no-double-touch guard),
      fires the first applicable WHEN clause, and unmatched source rows fall to the WHEN NOT MATCHED
      INSERT. Includes the `WHEN NOT MATCHED BY SOURCE` extension (act on target rows no source row
      hit) so MERGE can also prune. Set-based: matching reads the target image at statement start.
- [x] **`SAVEPOINT` / `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT`** — nested, named rollback
      points inside a transaction. Built on the existing snapshot machinery: a savepoint captures a
      DB snapshot; ROLLBACK TO restores it and discards later savepoints (but keeps the named one,
      per the standard); RELEASE merges it away; COMMIT/ROLLBACK clear the stack.
- [x] **`TRUNCATE TABLE t [, …] [RESTART IDENTITY] [CASCADE]`** — empty one or more tables in one
      statement, far faster than a scanning DELETE; `RESTART IDENTITY` resets the rowid counter,
      `CASCADE` truncates FK-referencing children too (and is *required* — like Postgres — when a
      child would otherwise be left dangling). Atomic with the rest of the engine.
- [x] **`LATERAL`** derived tables & table functions — `FROM a, LATERAL (SELECT … a.x …) b` and
      `… JOIN LATERAL fn(a.col) …`: a right-hand FROM item that may reference columns of the items
      to its left, evaluated per outer row by a new correlated nested-loop relation. Lifts the
      long-standing "LATERAL is not supported" restriction on table functions, so e.g.
      `json_array_elements(t.payload)` can finally unnest a *column* (not just a constant).
- [x] refresh the Reference + Internals docs and add showcase sample queries; grow the self-test
      suite and verify headless + `verify-project.mjs` (scope + conformance + lint + build).

### v12.0 — first-class ARRAY types (`T[]`) ✅ (shipped 2026-06-19)

The last big structural gap versus a real SQL engine: a composite column type. QueryForge already
proved its "tagged value" recipe four times (temporal, decimal, JSON, full-text) — a new value shape
threaded through six central functions in `types.ts` indexes, sorts, GROUP BYs, DISTINCTs, joins and
persists *for free*. v12 applies that recipe to **arrays**, built from scratch in `db/array.ts`, and
wires the surface a Postgres user expects. Strictly additive — the existing 319 tests stayed green,
and 17 new array tests (several differential — two spellings of `{1,2}` must hash to one value) landed
on top, for 336.

- [x] **`db/array.ts`** — the value module: a tagged `{t:'array', el, items}` (elements may be
      arrays, so multi-dimensional arrays are representable), with a Postgres-style element-wise total
      order (shorter prefix sorts first), containment/overlap, 1-based subscript + inclusive slice,
      the search/edit helpers (position(s)/remove/replace/append/prepend/cat/trim), shape
      introspection (length/cardinality/ndims/dims), and a `{…}` text **formatter + recursive parser**
      (quoting, `NULL`, nested arrays) that is its own inverse.
- [x] **Threaded through `types.ts`** — `ARRAY` added to `ColumnType`/`SqlValue`; `valueTypeOf`,
      `compareValues`, `orderValues`, `hashKey`, `formatValue` and `coerceTo` all learn arrays.
      `coerceTo` grew an `elemType` parameter so a declared `INT[]` column coerces each element on
      store — closing a real bug where `'{1,2}'` and `ARRAY[1,2]` would otherwise be *different*
      values (text vs. integer elements). Element coercion is recursive for nested arrays.
- [x] **Grammar** — the lexer learns `[` `]` `:` and the `&&` operator; the parser learns the
      `ARRAY[…]` constructor, postfix subscript/slice (`a[i]`, `a[lo:hi]`, `a[:hi]`, `a[lo:]`), the
      `T[]` type suffix on column defs and casts (`x::int[]`), and the **array-operand** form of
      `<op> ANY|ALL ( … )` (distinct from the subquery form).
- [x] **Operators** — `@>` / `<@` (containment) and `&&` (overlap) now branch on arrays; `||`
      concatenates array‖array, appends array‖elem and prepends elem‖array; `= ANY` / `<op> ALL` over
      an array run full three-valued logic (empty ⇒ ANY false / ALL true; a NULL element taints a
      no-match result to NULL).
- [x] **Function library** — `array_length`, `cardinality`, `array_ndims`, `array_dims`,
      `array_upper/lower`, `array_append/prepend/cat`, `array_remove/replace`,
      `array_position(s)`, `trim_array`, `array_to_string`, `string_to_array`; the **`array_agg`**
      aggregate (arrival order, NULLs kept, `DISTINCT` de-dupes, empty ⇒ NULL); and the
      set-returning **`unnest`** + **`generate_subscripts`** table functions (compose with joins /
      WHERE / GROUP BY, and unnest a *column* via `LATERAL`).
- [x] **Interop** — `to_json(array)` and `array::json` produce a JSON array (recursively);
      arrays render in the results grid and CSV export; new array nodes handled in every AST walker
      (planner column/aggregate/subquery collectors, the type inferencer, catalog's column-ref
      walker) and the type inferencer maps every new function to its result type.
- [x] **Docs + showcase** — a new Arrays section in the in-app Reference, two self-contained sample
      queries on the catalog card, and this journal entry. Verified headless + `verify-project.mjs`
      (scope + conformance + lint + build) all green.

#### v12 — next steps for arrays (backlog)
- [x] **A GIN index over an array column** (`CREATE INDEX … USING GIN (tags)`) — generalised the
      `GinIndexHandle` to extract array *elements* as posting keys (`keysOf` branches on the cell:
      tsvector lexemes or array elements via a canonical per-element key), and taught the planner a
      new `tryArrayGinScan` that turns `tags @> …` (AND of element postings), `tags && …` / `x =
      ANY(tags)` (OR), and the symmetric `array <@ tags` into a candidate probe + exact recheck — a
      GinScan in EXPLAIN, **byte-for-byte identical** to the sequential filter (5 differential
      self-tests over a 120-row table, incl. duplicate keys + a residual filter), maintained across
      INSERT/UPDATE/DELETE and snapshot restore. Mirrors the FTS GIN path.
- [ ] **`array_agg(x ORDER BY y)`** — an ordered aggregate (the WITHIN-GROUP-less ORDER BY form).
- [ ] **Element-typed schema bindings** — carry `elemType` on `Binding` so a subscript infers its
      element type (today a single subscript reports TEXT for display).
- [ ] **`SELECT unnest(a)` in the target list** (set-returning function in projection), and
      multi-array `unnest(a, b)` parallel expansion with `WITH ORDINALITY`.
- [ ] **`ANY`/`ALL` decorrelation** of `= ANY(array_subquery)` and an `ARRAY(SELECT …)` constructor.

- [ ] **DECIMAL division scale à la Postgres** — `select_div_scale` (derive rscale from operand
  precisions) instead of the fixed `max(s1,s2,6)`; expose a `SET extra_float_digits`-style knob.
- [ ] **Overflow vs. declared precision** — currently DECIMAL(p,s) only enforces *scale*; enforce
  `precision` (digit count) and raise a "numeric field overflow" instead of silently storing.
- [ ] **`SUM`/`AVG` `DECIMAL` window with explicit RANGE frames over decimals** (the running/ROWS
  frames are exact; verify RANGE-frame peer arithmetic on decimals).
- [ ] **CSV import → infer DECIMAL** for fixed-point money columns (today they infer REAL).
- [ ] **`ROUND`/`TO_CHAR` rounding modes** — half-even (banker's) option alongside half-up.

- [ ] **DEFERRABLE constraints + a real multi-statement transaction FK check** (currently MATCH
  SIMPLE, immediate); `MATCH FULL`/`MATCH PARTIAL`
- [ ] **DECIMAL / exact numerics** — the other half of the "more types" item (temporal is done)
- [ ] **`TO_CHAR(temporal, fmt)`** — Postgres-style template formatting (we ship `STRFTIME`)
- [ ] **Time zones** — everything is UTC today; add `TIMESTAMPTZ` + `AT TIME ZONE`
- [ ] **`PERCENTILE_CONT` as a window function** (`… WITHIN GROUP … OVER (PARTITION BY …)`)
- [x] **Better join cardinality** — estimate equijoin output as `|L|·|R| / max(V(L),V(R))`
  using per-key distinct-value counts, so a selective dimension filter propagates through the
  join (the current `max(|L|,|R|)` model under-rewards reordering) — **done in v15** (with the
  `V_eff = min(ndistinct, inputRows)` cap that makes the propagation actually fire)
- [x] **Index-nested-loop joins** (probe a B+Tree per outer row so a tiny driver can exploit the
  inner side's index) — **done in v15** (`IndexNestedLoopJoin`). Bushy / right-deep *shapes* (vs.
  left-deep) remain open.
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

### v13.0 — PL/QF: a procedural language + triggers (the active, *programmable* database) ✅ (this session)

Every prior release made the engine a better *declarative* query processor. v13 makes it
**programmable**: you can now write stored functions and procedures in a real procedural
sub-language, call them from inside SQL expressions, and wire them to fire automatically as
**row-level triggers** — the classic "active database" feature set, built end-to-end from the
lexer up. This is the largest behavioural surface added since the window engine, so it ships
with its own self-test group and demo schema.

Design spine (how it threads through the existing architecture without disturbing it):

- **Dollar-quoting in the lexer** (`$$ … $$`, `$tag$ … $tag$`) yields one opaque `string` token,
  so a function body never has to escape its own quotes; the body is re-tokenized and parsed by a
  dedicated PL grammar that *reuses the SQL parser* for embedded statements.
- **Routines & triggers live in the `Database`** next to tables/views, so they snapshot/restore
  with transactions and persist to localStorage for free (snapshot bumped to v6).
- **One small hook in `eval.ts`** lets an unknown scalar-function call resolve to a user routine;
  the engine installs it (pointing at its current db) at the top of every `execute()`, so a
  function invoked inside a `WHERE`/`SELECT` expression runs the interpreter transparently. The
  planner's `inferType` consults the same hook for the declared return type.
- **The interpreter** (`db/pl.ts`) runs a routine in a variable frame; embedded SQL is executed by
  *substituting* in-scope variables (and `NEW`/`OLD` record fields) as literals before handing the
  statement to the normal engine — so `INSERT INTO audit VALUES (NEW.id, now())` Just Works.
- **Triggers fire inside the engine's per-row INSERT/UPDATE/DELETE loops**: `BEFORE` triggers may
  rewrite the row or cancel the operation (`RETURN NULL`); `AFTER` triggers see the final image. A
  recursion guard bounds trigger→DML→trigger cascades.

Planned steps (all shipped this session unless noted):

- [x] **Lexer**: dollar-quoted string literals `$$…$$` / `$tag$…$tag$` + a `dollarBody()` extractor
- [x] **AST**: `create_function` / `create_procedure` / `drop_routine` / `create_trigger` /
  `drop_trigger` / `call` statements, a `PlStmt` procedural-statement union, and `SelectStmt.into`
- [x] **Parser — definitions**: `CREATE [OR REPLACE] FUNCTION/PROCEDURE name(params) RETURNS t AS $$…$$`,
  `CREATE [OR REPLACE] TRIGGER … {BEFORE|AFTER} {INSERT|UPDATE|DELETE} … FOR EACH ROW … EXECUTE FUNCTION f()`,
  `CALL p(args)`, and the `DROP` forms
- [x] **Parser — PL grammar**: `DECLARE` (typed vars + defaults), `BEGIN…END` blocks (nestable),
  `:=`/`=` assignment (incl. `NEW.col := …`), `IF/ELSIF/ELSE`, `WHILE`, `LOOP`, integer `FOR i IN a..b [BY s] [REVERSE]`,
  `FOR rec IN <query>`, `EXIT/CONTINUE [WHEN]`, `RETURN [expr]`, `RAISE` (EXCEPTION/NOTICE/WARNING/INFO),
  `PERFORM <query>`, `SELECT … INTO [STRICT] vars`, and embedded `INSERT/UPDATE/DELETE`
- [x] **eval.ts**: user-function resolution hook (call) + return-type hook (planner `inferType`)
- [x] **Interpreter** (`db/pl.ts`): variable frames, record (`NEW`/`OLD`) fields, three-valued
  control flow, variable→literal substitution into embedded SQL, `SELECT … INTO` (+ `STRICT`),
  query loops, recursion/▢loop-iteration guards, and notice collection for `RAISE NOTICE`
- [x] **Engine**: dispatch the new statements; install the eval hooks; fire `BEFORE`/`AFTER`
  row triggers around `INSERT`/`UPDATE`/`DELETE`; `CALL`; routine/trigger DDL; mark all as atomic
- [x] **Catalog**: store `routines` + `triggers` on the `Database`; snapshot/restore at version 6
- [x] **Tests**: a new `pl` self-test group (functions, procedures, control flow, recursion,
  records, `SELECT INTO`, `RAISE`, every trigger timing/event, BEFORE-row rewrite & cancel,
  audit-log demo, snapshot round-trip, error paths)
- [x] **Demo schema + samples**: a `compound_interest` function, an `apply_raise` procedure, and an
  audit-trigger pair in the seed, plus sample queries that exercise them
- [x] **UI**: a "Routines & triggers" section in the schema browser, a Reference chapter, and an
  Internals stage describing the PL pipeline
- [ ] **OUT/INOUT parameters** and `RETURNS TABLE`/set-returning functions (future)
- [ ] **Statement-level triggers** and `REFERENCING OLD/NEW TABLE` transition tables (future)
- [ ] **Exception handling** (`BEGIN … EXCEPTION WHEN … END`) and `GET DIAGNOSTICS` (future)

### v14 — Concurrency Lab: a real MVCC engine + isolation levels (planned this session)

QueryForge's "transactions" were coarse whole-DB snapshots — no concurrency, no isolation
levels, no version chains. This session adds a genuine **multi-version concurrency control
(MVCC) engine** the way PostgreSQL does it, plus an interactive lab to *see* concurrency
anomalies appear and disappear as you change the isolation level.

- [x] **MVCC store** (`db/concurrency/mvcc.ts`): per-key **version chains** with `xmin`/`xmax`,
  a transaction status table, commit-sequence timestamps, and snapshot-based visibility
  (`visibleValue`) — the exact "created-visible ∧ not-deleted-visible" rule a real heap uses
- [x] **Four isolation levels**: READ UNCOMMITTED (dirty reads), READ COMMITTED (per-statement
  snapshot), REPEATABLE READ (one snapshot at BEGIN + first-updater-wins write conflicts), and
  **SERIALIZABLE via SSI** (Serializable Snapshot Isolation) — Cahill's rw-antidependency graph
  with the PostgreSQL "dangerous structure" pivot rule
- [x] **Write-write conflicts & locking**: uncommitted writers hold a row lock; a second writer
  **blocks**; on the holder's commit the waiter gets a `could not serialize` abort (RR/SER) or
  overwrites the latest committed value (RC)
- [x] **Deadlock detection**: a waits-for graph with cycle detection that aborts a victim
- [x] **rw-antidependency tracking**: edges added at read-time (read a value a concurrent txn
  overwrote) and write-time (overwrite a value a concurrent txn read, incl. **predicate reads**
  for phantom/write-skew), feeding SSI and a serialization-precedence cycle check
- [x] **Deterministic schedule runner** (`runScenario`): executes an interleaved op schedule
  step-by-step, parks blocked ops and resumes them when locks free, and emits a full trace
  (per-step result, world snapshot, edges, aborts, verdict)
- [x] **Scenario library** (`db/concurrency/scenarios.ts`): dirty read, non-repeatable read,
  phantom, lost update, write skew, deadlock, and the read-only-transaction anomaly — each
  with the invariant it threatens and the lesson it teaches
- [x] **Concurrency Lab UI** (`ui/ConcurrencyLab.tsx`): scenario picker + isolation selector,
  a transaction-timeline (who did what, blocked/aborted), a **version-chain inspector**, a
  conflict-graph + serializability verdict, and live narration of every step
- [x] **Tests** (`db/concurrency/tests.ts`): a new `concurrency` self-test group asserting the
  exact anomaly behaviour at each level (RU shows dirty reads, RC prevents them; RR prevents
  non-repeatable/phantom reads; lost update lost under RC but aborted under RR; write skew
  allowed under RR but SSI-aborted under SERIALIZABLE; deadlock victim aborted)

### v15 — the optimizer, leveled up: a real cost model, a what-if Index Advisor & an Optimizer Lab (this session)

Every prior release grew what the engine *can express* (DML, arrays, PL, MVCC). v15 makes the
engine **smarter about how it runs what you already wrote** — it sharpens the cost-based optimizer,
then makes the optimizer's reasoning *interactive and teachable*. Three pillars, built end-to-end
from the cost model up, each with its own self-test group, mirroring the way the Concurrency Lab
turned an invisible subsystem into something you can watch.

**Why this is the right next pillar.** The planner already does predicate pushdown, index
selection, bitmap AND/OR, and a Selinger subset-DP join reorder — but it costed every equijoin at
`max(|L|,|R|)` output rows, a model the backlog itself flagged as "under-rewards reordering." A
join's *output* cardinality is what every operator *above* it is costed against, so a crude
estimate quietly degrades multi-join planning. Fixing the cardinality model is the highest-leverage
change in the whole optimizer, and once the costs mean something, two showpieces fall out of it: a
**what-if Index Advisor** that re-plans your query under *hypothetical* indexes and recommends the
one that helps most (HypoPG / SQL-Server-DTA style — no data is moved), and an **Optimizer Lab**
that visualises the join-order DP search and the advisor's verdict.

Design spine (how it threads through the architecture without disturbing it):

- **Stats already exist** (`db/stats.ts`: per-column `ndistinct`, histograms, MCV). The cardinality
  model just *reads* them — no new gathering. The key insight a textbook estimate needs but the old
  one lacked: a key column's *effective* distinct count after a selective filter is bounded by the
  filtered input's row estimate (`V_eff = min(ndistinct, inputRows)`), so a selective dimension
  filter finally propagates through the join.
- **Hypothetical indexes** reuse the real planner unchanged. The advisor injects a stub
  `IndexHandle` (empty B+Tree, `hypothetical: true`) into a table's index map, runs `planSelect`
  for cost **only** (EXPLAIN never traverses the tree, so the stub is never read), then removes it.
  The recommendation is only emitted if the re-plan *actually uses* the index and lowers cost.
- **The Optimizer Lab** is pure UI over data the engine already exposes (`EXPLAIN` plan nodes +
  the advisor's structured verdict), exactly like the Concurrency Lab sits over the MVCC runner.

Planned steps (this session):

- [x] **Cardinality model** (`db/planner.ts` + `db/operators.ts`): a System-R equijoin estimate
  `|L|·|R| / max(V(L,key), V(R,key))` with the `V_eff = min(ndistinct, inputRows)` cap; threaded
  through `extractEquiJoin` (now returns the key *exprs*) → `equiJoinCard` → `chooseEquiJoin` → an
  optional `estRows` arg on `HashJoin`/`MergeJoin`/`NestedLoopJoin` (falls back to the old heuristic
  when no stats). A single-table filtered scan already costs well; this fixes *joins of joins*.
- [x] **Index Nested-Loop Join** (`db/operators.ts` `IndexNestedLoopJoin` + planner
  `tryIndexNestedLoop`): when the inner side is a bare base-table scan with a single-column B+Tree on
  the join key, the outer (driver) is ≥4× smaller and the inner is worth indexing, probe the index
  per outer row instead of building a hash table — the classic "small driver exploits the inner
  index" plan, shown as `IndexNestedLoopJoin` in EXPLAIN. Taken only when it also costs less. INNER
  and LEFT; differentially tested against the hash form (incl. duplicate keys + LEFT null-extension).
- [x] **What-if Index Advisor** (`db/advisor.ts`): enumerates candidate indexes from a query's
  sargable equalities, range bounds, join keys and ORDER BY (single + leading-equality composites);
  costs the baseline plan; for each candidate injects a *hypothetical* index (a genuine backfilled
  B+Tree, retracted the instant the plan is read — data untouched), re-plans, and keeps those the
  planner actually adopts at a lower cost; ranks by % cost reduction; emits ready-to-run `CREATE
  INDEX` DDL. Surfaced as `engine.advise()`. It even recommends an index that flips a hash join into
  a cheaper index nested-loop join.
- [~] **Plan cache** — deferred. The headline trio (cardinality model + INLJ + advisor) plus the Lab
  is a complete, coherent release; a correct plan cache means re-using stateful Volcano operator
  trees, which is a separate, carefully-tested change. Left on the backlog rather than rushed.
- [x] **Optimizer Lab UI** (`ui/OptimizerLab.tsx` + `planner.planWithJoinTrace`): paste a query → the
  chosen plan with per-operator cost, the join-order subset-DP search (every relation subset, its
  cheapest sub-plan, and the order it settled on), and the Index Advisor's ranked recommendations
  with one-click **Apply** (`CREATE INDEX` then re-plan to show the new winning plan). A visual,
  hands-on tour of the optimizer — the Concurrency Lab's twin.
- [x] **Tests**: new `optimizer` (5), `advisor` (6) and `inlj` (7) self-test groups — differential
  (results never change), cardinality assertions (a selective filter shrinks the join estimate; the
  `V_eff` cap), the DP trace, INLJ chosen for a tiny driver over an indexed inner (and *not* for a
  balanced join / an unindexed inner), and the advisor recommends an index the planner then adopts
  (incl. the one that enables the INLJ). 379 → 397, all green.
- [x] **Docs + showcase**: an Optimizer chapter in the Reference, two Internals stages (cost model +
  advisor), two catalog sample queries, `project.json` tags + description, this journal.

### v16.0 — ARIES write-ahead logging & crash recovery + a Recovery Lab (this session)

Every release so far made the engine smarter about what runs *while the power is on*. QueryForge had
snapshot transactions and an MVCC concurrency story, but **no durability story**: the on-disk picture
was a localStorage snapshot taken after each statement, with nothing that models what a real
disk-backed database does to survive a mid-flight crash. v16 adds that missing pillar — a from-scratch
implementation of **ARIES** (Mohan, Haderle, Lindsay, Pirahesh & Schwarz, *ACM TODS* 1992), the
recovery method the textbooks teach and the commercial engines descend from — and an interactive
**Recovery Lab** that makes it legible the same way the Concurrency Lab makes isolation legible.

The model is a set of single-cell **pages**, each with a `pageLSN`; a **log** split into a durable
on-disk portion and a volatile tail; and a buffer pool that runs the two policies that make recovery
interesting — **STEAL** (a dirty *uncommitted* page may be written to disk) and **NO-FORCE** (a
committed page need not be flushed at commit). STEAL is precisely why a restart must be able to
**UNDO**; NO-FORCE is precisely why it must be able to **REDO**. The **write-ahead rule** is enforced
(a page is never flushed before the log up to its `pageLSN`), a **commit forces the log**, and a
**fuzzy checkpoint** brackets a snapshot of the transaction table + dirty-page table so recovery need
not scan the whole log.

Restart is the canonical three passes: **Analysis** (rebuild the DPT/TT from the last checkpoint, find
the RedoLSN, label winners vs. losers), **Redo** ("repeat history" — replay *every* logged change,
losers included, the per-page `pageLSN` test keeping each reapply idempotent), and **Undo** (roll the
losers back in reverse-LSN order, logging a redo-only **CLR** with an `undoNextLSN` per change). The
CLR design is what makes recovery itself **restartable**: a second crash *during* undo loses nothing —
the restart redoes the CLRs and resumes undo exactly where it stopped, never double-undoing a change.

Plan / steps:

- [x] `src/db/recovery/wal.ts` — the WAL log-record union (begin/update/commit/abort/clr/end +
      begin/end_checkpoint), the `AriesDb` normal-operation engine (buffer pool, durable disk + log,
      TT/DPT, write-ahead `flushPage`, log-forcing `commit`, fuzzy `checkpoint`, `crash()` that drops
      all volatile state), and a normal-operation `rollback` that uses the very same CLR machinery.
- [x] `src/db/recovery/recovery.ts` — the three-pass `recover()` (Analysis/Redo/Undo) producing a
      full scrubbable step trace, restartable via a `stopAfterUndo` "crash during recovery" hook.
- [x] `src/db/recovery/scenarios.ts` — six canonical scenarios: NO-FORCE⟹REDO, STEAL⟹UNDO,
      interleaved winners+losers, a fuzzy checkpoint bounding the scan, a crash *during* recovery
      (CLR idempotence), and a normal rollback replayed by redo.
- [x] `src/db/recovery/runner.ts` — drives a scenario (workload → crash → recovery) into one timeline,
      with a per-step snapshot of the log/pages/TT/DPT and an **independent oracle** that computes the
      one provably-correct post-recovery state, so every run carries its own consistency verdict.
- [x] `src/ui/RecoveryLab.tsx` (+ CSS) — a new "Recovery Lab" tab: scenario picker, a phase rail
      (normal → crash → analysis → redo → undo → recovered), a step scrubber/player, a live log view
      (durable vs. volatile vs. recovery-written), disk/buffer page images with pageLSNs, the rebuilt
      transaction & dirty-page tables, and a truth-vs-recovered verdict.
- [x] **Tests**: a new `recovery` self-test group (16 cases) — the master invariant that every
      scenario recovers to its oracle truth, plus targeted assertions for redo-after-commit,
      undo-of-a-stolen-page, repeat-history, checkpoint-bounded redo, crash-during-recovery (no double
      rollback), WAL ordering on flush, commit durability, and `recover()` idempotence. 397 → 413, all
      green (full suite run head-less).
- [x] **Docs**: an ARIES stage in Internals; `project.json` tags + description; this journal.

## Session log

- 2026-06-20 (claude / claude-opus-4-8): **v16.0 — ARIES write-ahead logging & crash recovery + a
  Recovery Lab.** Added the database pillar QueryForge was missing — durability — as a self-contained,
  from-scratch implementation of ARIES (Mohan et al., 1992). New `src/db/recovery/*`: a WAL engine
  (`wal.ts`) with pageLSNs, a forced log vs. a volatile tail, a STEAL/NO-FORCE buffer pool, the
  write-ahead rule on page flush, log-forcing commits, fuzzy checkpoints, and a CLR-based normal
  rollback; the three-pass restart algorithm (`recovery.ts`) — Analysis rebuilds the dirty-page and
  transaction tables from the last checkpoint and finds the RedoLSN; Redo *repeats history* (winners
  and losers alike, idempotent via the per-page pageLSN test) to reconstruct the exact crash state;
  Undo rolls the losers back in reverse-LSN order, logging a redo-only Compensation Log Record with an
  undoNextLSN so a crash *during* recovery resumes without double-undoing. A scenario library
  (`scenarios.ts`, six cases) and a runner (`runner.ts`) stitch workload → crash → recovery into one
  scrubbable timeline with an independent oracle that computes the only correct outcome, so each run
  self-verifies. New **Recovery Lab** tab (`ui/RecoveryLab.tsx`): a phase rail, a step player, a live
  log view (durable/volatile/recovery-written), disk+buffer page images with pageLSNs, the rebuilt
  TT/DPT, and a truth-vs-recovered verdict. New `recovery` self-test group (16 cases): 397 → 413, all
  green head-less. Added an ARIES stage to Internals and refreshed `project.json`. Verified with
  `verify-project.mjs` (scope + conformance + lint + build).
- 2026-06-20 (claude / claude-opus-4-8): **v15.0 — the optimizer, levelled up: a real cost model, an
  index nested-loop join, a what-if Index Advisor & an Optimizer Lab.** Every prior release grew what
  the engine could *express*; this one makes it smarter about how it *runs* what you already wrote.
  (1) **Cardinality model** — the planner costed every equijoin at `max(|L|,|R|)` output rows, a model
  the backlog itself flagged. Replaced it with the System-R estimate `|L|·|R| / max(V(L,key),
  V(R,key))`, reading the per-column distinct counts stats already gathered, with the textbook cap a
  good estimator needs but the old one lacked: a key's *effective* distinct count after a selective
  filter is bounded by the surviving row estimate (`V_eff = min(ndistinct, inputRows)`), so a
  selective filter on one table finally propagates through the join. Threaded `extractEquiJoin` (now
  returns the key exprs) → `equiJoinCard` → `chooseEquiJoin` → an optional `estRows` on the join
  operators (old heuristic kept as a fallback). A symmetric clique's orders become genuinely
  cost-equal under the accurate model — the old "small relations first" test was an artifact of the
  crude over-estimate, so it now asserts the real invariant (the clique is connected by equijoins,
  not a Cartesian), and a new `optimizer` group proves the selectivity propagation directly.
  (2) **Index nested-loop join** — a new `IndexNestedLoopJoin` operator: when a *tiny* outer driver
  meets a *large* inner base table that's B+Tree-indexed on the join key, descend the index once per
  outer row instead of scanning-and-hashing the whole inner side. Guarded to its sweet spot (inner a
  bare scan, outer ≥4× smaller, inner ≥50 rows) and taken only when it also costs less, so no
  existing plan flips; differentially tested against the hash form (INNER, LEFT null-extension,
  duplicate inner keys). (3) **What-if Index Advisor** (`db/advisor.ts`) — the headline: it
  enumerates candidate indexes from a query's equalities/ranges/join-keys/ORDER BY, builds each one
  *hypothetically* (a genuine backfilled B+Tree, retracted the instant the plan is costed — your data
  is never changed; EXPLAIN never traverses it), re-plans, and recommends only the indexes the
  optimizer actually adopts at a lower cost, ranked by the cost drop, each with ready-to-run DDL.
  HypoPG / SQL-Server-DTA, distilled. It even spots an index that flips a hash join into a cheaper
  index nested-loop join. (4) **Optimizer Lab** (`ui/OptimizerLab.tsx`, fed by `planWithJoinTrace`) —
  the Concurrency Lab's twin: paste a query and watch the chosen plan with per-operator cost, the
  join-order subset-DP search replayed (every relation subset, its cheapest sub-plan, the winning
  order), and the advisor's recommendations with a one-click Apply that creates the index and
  re-plans so the winning plan changes in front of you. Surfaced a Reference chapter, two Internals
  stages, two catalog samples. Grew the suite 379 → 397 (new `optimizer`/`advisor`/`inlj` groups);
  verified head-less and with `verify-project.mjs` (scope + conformance + lint + build), all green.
- 2026-06-19 (claude / claude-opus-4-8): **v14.0 — Concurrency Lab: a real MVCC engine.**
  QueryForge's only "transactions" were coarse whole-DB snapshots — no concurrency at all. This
  session built a genuine **multi-version concurrency control engine** from scratch, standalone
  from the SQL core (`src/db/concurrency/`). The store keeps per-key **version chains** with
  `xmin`/`xmax`, a transaction status table and commit-sequence timestamps, and a single
  `visibleVersion` rule (first creation-visible version wins; tombstones for deletes) that drives
  all four isolation levels: READ UNCOMMITTED reads the raw tip, READ COMMITTED takes a fresh
  snapshot per statement, REPEATABLE READ freezes one snapshot at BEGIN with first-updater-wins
  write conflicts, and **SERIALIZABLE** layers on Serializable Snapshot Isolation — Cahill's
  rw-antidependency graph (edges added at read- *and* write-time, including predicate reads for
  phantom/write-skew) with the PostgreSQL "dangerous structure" pivot rule that aborts the second
  committer. Uncommitted writers hold a row lock so a second writer **blocks**; a waits-for graph
  catches **deadlocks** and aborts a victim. A deterministic schedule runner parks blocked ops,
  resumes them when locks free, and emits a full per-step trace plus an after-each-step world
  snapshot. The **Concurrency Lab** UI ties it together: a scenario library (dirty read,
  non-repeatable read, phantom, lost update, write skew, deadlock, the read-only anomaly), an
  isolation selector, a scrubbable transaction timeline, a live version-chain inspector, the lock
  table, an SVG rw-conflict graph, a serializability verdict and step-by-step narration — so you
  watch each anomaly appear and vanish as you raise the level. Added an 11-case `concurrency`
  self-test group asserting the exact behaviour at each level (grew the suite 368 → 379, all
  green); verified headless and with `verify-project.mjs` (scope + conformance + lint + build).
- 2026-06-19 (claude / claude-opus-4-8): **v13.0 — PL/QF: a procedural language + triggers.**
  Made the engine *programmable*. Built a real procedural sub-language end-to-end from the lexer up:
  dollar-quoting (`$$ … $$`) so a function body is one opaque token; a PL grammar (DECLARE/BEGIN
  blocks, `:=` assignment incl. `NEW.col`, IF/ELSIF/ELSE, WHILE/LOOP, integer `FOR i IN a..b [BY][REVERSE]`,
  `FOR rec IN (query)`, EXIT/CONTINUE [WHEN], RETURN, RAISE EXCEPTION/NOTICE, PERFORM, `SELECT … INTO
  [STRICT]`, and embedded INSERT/UPDATE/DELETE) that *reuses the SQL parser* for embedded statements;
  and an interpreter (`db/pl.ts`) that runs a body in a chain of variable frames. The pivotal design
  choice that kept the SQL pipeline untouched: embedded statements see procedural variables by
  *substituting* every in-scope variable (and NEW/OLD record field) as a literal before the statement
  reaches the engine — so `INSERT INTO audit VALUES (NEW.id, now())` Just Works. A single hook in
  `eval.ts` resolves an unknown scalar-function call to a stored routine, so a function called inside a
  WHERE/SELECT runs the interpreter transparently (the planner reads its return type through the same
  hook). Triggers fire inside the engine's per-row INSERT/UPDATE/DELETE loops: BEFORE may rewrite the
  row or cancel it (RETURN NULL), AFTER sees the final image, WHEN gates firing, and a recursion guard
  bounds cascades. Routines + triggers live on the `Database` next to tables/views, so they snapshot,
  roll back with transactions and persist (snapshot bumped to v6). Surfaced it in the schema browser
  (Routines/Triggers sections), a Reference chapter, an Internals stage, and RAISE-notice rendering in
  the output. Added a seed demo (a `compound_interest` function, a `transfer` procedure, an audit
  trigger on `accounts`) + 3 sample queries. Grew the suite 341 → 364 (23 new PL cases: functions,
  procedures, recursion, every control-flow form, records, SELECT INTO, RAISE, all trigger
  timings/events, BEFORE-row rewrite & cancel, the audit demo, a snapshot round-trip, and error
  paths); verified head-less (all 364 + every sample against the seed) and with `verify-project.mjs`
  (scope + conformance + lint + build), all green.
- 2026-06-19 (claude / claude-opus-4-8): **v12.0 — first-class ARRAY types.** Applied the project's
  proven "tagged value" recipe a fifth time, this time to a *composite* type. New `db/array.ts`
  carries the value shape (`{t:'array', el, items}`, nestable → multi-dimensional), its element-wise
  total order, containment/overlap, subscript/slice, the search/edit helpers, shape introspection,
  and a `{…}` text formatter + recursive parser that round-trips itself. Threaded through the six
  central functions in `types.ts` so arrays index, sort, GROUP BY, DISTINCT, join and persist for
  free; `coerceTo` gained an `elemType` parameter (and every column-store call site now passes it) so
  a declared `INT[]` column coerces its elements — fixing a latent identity bug where `'{1,2}'` (text
  elements) and `ARRAY[1,2]` (integer elements) would otherwise be different values. Grammar grew the
  `ARRAY[…]` constructor, postfix subscript/slice, the `T[]` type suffix on columns and casts, the
  `&&` overlap operator, and the array-operand form of `ANY`/`ALL`. Operators `@>`/`<@`/`&&`/`||`
  branch on arrays; a full function library landed (`array_length`/`cardinality`/`ndims`/`dims`/
  `append`/`prepend`/`cat`/`remove`/`replace`/`position(s)`/`trim_array`/`array_to_string`/
  `string_to_array`), plus the `array_agg` aggregate and the set-returning `unnest` /
  `generate_subscripts` table functions (so `LATERAL unnest(t.col)` finally unnests a *column*).
  `to_json`/`::json` interop, results-grid + CSV rendering, and every AST walker were updated. All new
  AST node kinds compiled clean (TS exhaustiveness caught the value-returning switches; the
  void-returning walkers were updated by hand). 17 new differential self-tests; the suite went
  319 → 341, all green (incl. a GIN inverted index over array columns: @>, && and = ANY accelerated by a GinScan, byte-for-byte identical to the sequential filter), and `verify-project.mjs` (scope + conformance + lint + build) passes.
- 2026-06-18 (claude / claude-opus-4-8): **v11.0 — productive DML & transaction control.** Grew
  the *write* surface to match the read surface, kept contained to `ast.ts`, `lexer.ts`, `parser.ts`,
  `engine.ts`, `catalog.ts`, plus a new operator in `operators.ts` and one planner hook — no storage
  or optimizer rewrite, so the existing 288 tests stayed green. Five features, each self-tested
  (several differentially): **(1) `RETURNING`** on INSERT/UPDATE/DELETE *and* MERGE — each DML loop
  captures the rows it touched (the new image for INSERT/UPDATE incl. DEFAULT/coercion/upsert, the old
  one for DELETE) and projects them through a select-list bound to the target (`*`, `t.*`, expressions,
  aliases), turning a mutation into a `RowsResult`. **(2) `MERGE INTO … USING … ON … WHEN [NOT]
  MATCHED …`** — the SQL:2003 "upsert from a set": the ON predicate compiles over the combined
  `[target | source]` row, each source row finds its matched targets under a no-double-touch
  cardinality guard, the first applicable arm fires (UPDATE/DELETE/INSERT/DO NOTHING), unmatched source
  rows fall to WHEN NOT MATCHED THEN INSERT, and the `WHEN NOT MATCHED BY SOURCE` extension reaches
  target rows no source row hit — all matched against the target image at statement start, atomic like
  every mutation. **(3) `SAVEPOINT` / `ROLLBACK TO` / `RELEASE`** — nested rollback points stacked on
  the same snapshot machinery (ROLLBACK TO restores and discards later savepoints but keeps the named
  one). **(4) `TRUNCATE [TABLE] t [, …] [RESTART IDENTITY] [CASCADE]`** — clears the heap and rebuilds
  empty indexes, following CASCADE to FK children (required when one would dangle). **(5) `LATERAL`**
  derived tables & table functions (`FROM a, LATERAL (… a.x …)` / `JOIN LATERAL fn(a.col) …`) — a new
  `LateralJoin` correlated-nested-loop operator re-evaluates the right side per outer row through an
  outer scope over the left schema, lifting the long-standing "argument can't reference a column"
  restriction so e.g. `json_array_elements(t.payload)` finally unnests a *column*. Also added comma
  (SQL-89) joins on the way. Refreshed Reference (3 sections) + Internals (a new pipeline stage + the
  executor/lead updates), added 6 showcase sample queries, grew the self-test suite 288 → 319 (31 new:
  RETURNING/MERGE/SAVEPOINT/TRUNCATE/LATERAL, incl. a LATERAL-vs-correlated-scalar differential and a
  MERGE cardinality-violation rollback), and verified headless + `verify-project.mjs` (scope +
  conformance + lint + build), all green.
- 2026-06-18 (claude / claude-opus-4-8): **v10.0 — window functions, to the SQL standard.**
  Finished the window-function story where it stopped short of the standard, kept tightly contained
  to `ast.ts`, `parser.ts`, `planner.ts`, `eval.ts` (`exprKey`) and a substantially rewritten
  `window.ts` — no storage/optimizer code touched, so the existing 261 tests stayed green. Shipped
  seven features, each self-tested (several differentially): (1) the **`GROUPS`** frame mode (a
  per-partition dense peer-group index drives the bounds); (2) the **`EXCLUDE`** clause (NO OTHERS /
  CURRENT ROW / GROUP / TIES) applied to every frame-sensitive function via an explicit in-frame
  index list; (3) **`RANGE`** frames with *typed* value offsets — numeric, exact `DECIMAL`, and
  `DATE`/`TIMESTAMP` ± `INTERVAL` — honouring ASC/DESC direction (a from-scratch `shiftValue`); (4)
  the **`WINDOW`** clause with named definitions and reference *inheritance* (`OVER (w …)` resolved
  during binding, with cycle/override guards); (5) **ordered-set** (`PERCENTILE_CONT/DISC`, `MODE`)
  and **statistical** (`STDDEV`/`VARIANCE`) **windows**, validated against the GROUP BY aggregates;
  (6) **`IGNORE NULLS` / `RESPECT NULLS`** for the value/offset functions; (7) aggregate-window
  **`FILTER (WHERE …)`**. Reserved `WINDOW`/`GROUPS`/`EXCLUDE` as keywords (so `FROM t WINDOW …`
  no longer swallows the clause as a table alias). Refreshed Reference + Internals, added 5 showcase
  sample queries, grew the suite 261 → 288 (all green, incl. a QUALIFY clause), and verified with `verify-project.mjs`
  (scope + conformance + lint + build).
- 2026-06-16 (claude / claude-opus-4-8): **v9.0 — first-class full-text search (`tsvector` /
  `tsquery` + a GIN inverted index).** Added the last big capability a modern SQL engine has that
  QueryForge didn't, built the same way JSON/temporal/decimal were: a new `db/fts.ts` carrying two
  tagged values threaded through the six central value functions in `types.ts`, so a search document
  indexes, sorts, GROUP BYs, DISTINCTs, joins, persists and renders for free. From scratch and fully
  deterministic: a **Porter (1980) stemmer** (verified against the canonical reference vocabulary),
  an English stop-word list, and a positional tokenizer. The `@@` operator (new in lexer/parser at
  comparison precedence; symmetric, with text⇄tsvector/tsquery coercions) does boolean (`& | !`),
  prefix (`:*`), weight-filtered (`:A`) and **true positional phrase** search (`a <-> b`, `a <N> b`)
  via a position-set executor. Constructors `to_tsvector` / `to_tsquery` / `plainto_tsquery` /
  `phraseto_tsquery` / `websearch_to_tsquery`; ranking `ts_rank` / `ts_rank_cd` (A/B/C/D weights,
  length-normalization bitmask, cover density); `ts_headline`, `setweight`, `strip`, `numnode`,
  position-shifting `||`, and `tsquery` algebra. **Capstone — a GIN inverted index:** `CREATE INDEX
  … USING GIN (col)` builds a lexeme→rowids map (new `GinIndexHandle` in the catalog), maintained on
  every insert/update/delete and rebuilt on snapshot restore (snapshot bumped to v5). The planner's
  `tryGinScan` detects `col @@ <constant tsquery>`, walks the query AST to a conservative candidate
  rowset (postings union/intersection; falls back to all rows under a top-level `NOT`), and emits a
  `GinScan` operator that rechecks `@@` exactly — lossy index, precise answer — shown as a `GinScan`
  in `EXPLAIN`. Strictly additive: with no GIN index the same query is a correct seq-scan filter, and
  a property test asserts GIN and seq give identical answers across six query shapes. Seeded an
  `articles` corpus with weighted vectors + a GIN index, added 5 sample queries, a Reference section
  and an Internals stage. Grew the self-test suite 246 → 261 (all green, verified headless) plus
  `verify-project.mjs` (scope + conformance + lint + build).

- 2026-06-15 (claude / claude-opus-4-8): **v8.0 — first-class JSON / JSONB.** Closed the one glaring
  gap versus a modern SQL engine. Built `db/json.ts` and threaded JSON through the value system the
  exact same way temporal and decimal were done: a tagged, `JSON.stringify`-round-trippable value
  `{t:'json', v}` with **jsonb normalization** (object keys sorted + de-duplicated, last value wins),
  which makes equality a deep structural test, hashing a canonical string, and gives every JSON value
  a place in one total order — so a JSON column **indexes in the B+Tree, sorts, GROUP BYs, DISTINCTs,
  joins and persists to localStorage for free**, just by extending the six central value functions
  (`valueTypeOf`/`coerceTo`/`compareValues`/`orderValues`/`hashKey`/`formatValue`). On top: the
  `JSON`/`JSONB` column type + `CAST`, a **Postgres `::TYPE` postfix cast** (a 3-char-aware lexer for
  `->> #>>` and the 2-char `-> #> @> <@ ::`), the operator suite **`-> ->> #> #>> @> <@ ?`** with the
  right precedence (extraction binds tight, containment at comparison) and a JSON-aware **`||`**
  (array concat / object merge). A scalar library — `TO_JSON`, `JSON`, `JSON_BUILD_OBJECT/ARRAY`,
  `JSON_ARRAY_LENGTH`, `JSON_TYPEOF`, `JSON_OBJECT_KEYS`, `JSON_EXTRACT_PATH(_TEXT)`, `JSON_VALID`,
  `JSON_PRETTY`, `JSON_STRIP_NULLS`, `JSONB_SET`, `JSON_CONTAINS` — plus two aggregates
  (`JSON_AGG`, and a two-arg `JSON_OBJECT_AGG(k,v)` via a new `arg2` on `AggSpec`), with `inferType`
  taught every JSON-returning op/function so result columns carry type `JSON`. **Capstone:**
  set-returning **table functions in FROM** (`JSON_ARRAY_ELEMENTS`, `JSON_ARRAY_ELEMENTS_TEXT`,
  `JSON_EACH`, `JSON_EACH_TEXT`, `JSON_OBJECT_KEYS`) — the planner evaluates the (constant) argument
  and materializes the produced rows into a synthetic relation, so unnested JSON composes with joins /
  WHERE / GROUP BY exactly like a derived table (LATERAL, i.e. an argument referencing another FROM
  item, is explicitly unsupported and errors cleanly). Along the way **unreserved `KEY`** (it's a
  non-reserved word in Postgres too) so it can be a column name like `json_each`'s `key` — `PRIMARY
  KEY`/`FOREIGN KEY` still parse because the parser matches those by token value. Surfaced it in the
  grid (a `.cell-json` style), CSV export, a `documents` seed table + 6 sample queries, and a
  Reference section + Internals stage. Grew the self-test suite 220 → 246 (26 JSON cases: operators,
  containment, build/extract/transform functions, aggregates, table functions, deep equality &
  DISTINCT, B+Tree indexing and a snapshot round-trip), and verified headless + `verify-project.mjs`
  (scope + conformance + lint + build), all green.
- 2026-06-15 (claude / claude-opus-4-8): **v7.0 — views, UPSERT & EXISTS decorrelation.** Closed
  three long-standing relational gaps, each independently and self-tested. **(1) Views** —
  `CREATE [OR REPLACE] VIEW v [(cols)] AS …` / `DROP VIEW [IF EXISTS]`, stored on the `Database` as a
  plain-object `SelectStmt` (so they serialize to localStorage untouched) and resolved by the planner
  in `relationFor`: a view name is inlined as a derived table in the *catalog* scope (fresh env, no
  caller CTEs/correlations), so a view works in FROM/JOIN/subqueries and inside other views, with a
  trail-based cycle guard. Bodies are validated (planned) at create time; name collisions with tables
  are refused. **(2) UPSERT** — `INSERT … ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET … [WHERE …]`:
  the arbiter is the unique/PK B+Tree matching the target columns (or any unique index when omitted);
  on a hit we skip or update the existing row, with `EXCLUDED.*` bound to the proposed row and the
  table's own columns to the existing one (one combined-row evaluator). Statement atomicity already
  covers a DO UPDATE that triggers a fresh constraint violation. **(3) Decorrelation** — a new
  `HashSemiJoin` operator (with an `anti` flag) plus a planner rewrite that turns a top-level
  `WHERE [NOT] EXISTS (…)` into a single build-once/probe semi- or anti-join when the correlation
  decomposes into equi-keys + inner-local predicates (NULL keys never match — exactly EXISTS / NOT
  EXISTS semantics; a key-less form degrades to "inner (non-)empty"). It **falls back** to the existing
  per-row evaluator for any shape it can't prove equivalent, so an answer can never change; `EXPLAIN`
  shows the SemiJoin/AntiJoin with the inner subplan. Also fixed a latent persistence bug (the loader
  was pinned to snapshot v1 and silently never restored anything) — snapshots are now v4 (round-trip
  views) and the loader is version-tolerant. Surfaced views in the schema browser, added a seed view
  (`customer_revenue`) + 6 sample queries, and refreshed Reference/Internals. Grew the suite 190 → 220
  (12 view, 10 upsert, 9 decorrelation cases); `verify-project.mjs` (scope + conformance + lint +
  build) green, and the full self-test suite passes head-less.
- 2026-06-15 (claude / claude-opus-4-8): **v6.0 — first-class exact numerics (DECIMAL / NUMERIC).**
  Added the other half of the "more types" backlog item. Built `db/decimal.ts`: a BigInt-backed
  exact-decimal value stored as a tagged, JSON-serializable object `{t:'decimal', d, s}` (the
  unscaled integer is a BigInt *rendered to a string*, since BigInt itself can't be serialized —
  the trick that keeps the whole DB localStorage-round-trippable while arithmetic stays
  arbitrary-precision). Threaded it through the six central value functions exactly like temporal,
  so a decimal indexes, sorts, GROUP BYs, joins, aggregates and persists for free, and
  `1.50 = 1.5 = 2` share one hash identity. On top: typed literals (`DECIMAL/NUMERIC/DEC '…'`),
  `DECIMAL(p,s)` columns + `CAST` (rounding to scale on store, half-up), exact `+ − × ÷ %` with
  documented scale rules (÷ to ≥6 digits, ÷0→NULL, REAL contaminates to float), exact `SUM`/`AVG`
  in both the GROUP BY and window paths (money SUMs never lose a cent), decimal-exact
  `ABS/SIGN/ROUND/TRUNC/CEIL/FLOOR/MOD` + new `TO_NUMBER/DECIMAL()/SCALE/PRECISION`, and a
  Postgres-style **numeric `TO_CHAR`** template engine (`9 0 . , S MI PR $ L FM`, `#` overflow).
  Stats estimators and the B+Tree pick decimals up via the shared order/hash with ~no new code.
  Showcased with an `invoices` table (DECIMAL money + tax) in the seed, 4 sample queries, a
  Reference section, an Internals stage, and `DECIMAL(p,s)` in the schema browser. Grew the
  self-test suite 173 → 190 (decimal arithmetic/scale/comparison/coercion/aggregates/windows/index/
  rounding/TO_CHAR/persistence + a guard that every shipped sample query runs against the seed);
  verified headless and with `verify-project.mjs` (scope + conformance + lint + build), all green.
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
