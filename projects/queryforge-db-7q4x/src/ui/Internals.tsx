// Architecture explainer — walks through the pipeline a query takes.

interface Stage {
  n: number
  name: string
  file: string
  body: string
}

const STAGES: Stage[] = [
  {
    n: 1,
    name: 'Tokenizer',
    file: 'db/lexer.ts',
    body: 'A hand-written scanner turns SQL text into typed tokens (keywords, identifiers, numbers, strings, operators). The same tokenizer drives the editor’s syntax highlighting, so the colours always match the grammar.',
  },
  {
    n: 2,
    name: 'Parser',
    file: 'db/parser.ts',
    body: 'Recursive descent for statements, with a Pratt (precedence-climbing) sub-parser for expressions. Produces a fully typed AST — including BETWEEN/IN/LIKE/CASE/CAST, typed temporal literals (DATE/TIME/TIMESTAMP/INTERVAL ‘…’), the EXTRACT(field FROM x) spelling, niladic CURRENT_DATE/TIME/TIMESTAMP, and the full join grammar.',
  },
  {
    n: 2.5,
    name: 'Value system, temporal & exact-numeric types',
    file: 'db/temporal.ts · db/decimal.ts',
    body: 'The runtime value space is deliberately tiny and JS-native (null, number, string, boolean) so a whole database serializes to localStorage. DATE, TIME, TIMESTAMP and INTERVAL join it as plain tagged objects — {t:\'date\', days}, {t:\'timestamp\', ms}, {t:\'interval\', months, days, ms} — which survive a JSON round-trip untouched, with one set of helpers for comparison/ordering/hashing (so they flow through indexes, ORDER BY, GROUP BY, DISTINCT and joins for free) plus calendar-aware arithmetic and EXTRACT/DATE_TRUNC/AGE, all in UTC. DECIMAL/NUMERIC joins the same way as {t:\'decimal\', d, s} — the unscaled integer is a BigInt rendered to a string (BigInt itself isn\'t JSON-serializable), so arithmetic is exact to arbitrary precision: 0.1 + 0.2 is exactly 0.3, SUMming a money column never loses a cent, and 1.50 = 1.5 = the integer-equal value share one hash identity. Threading both types through the six central value functions (valueTypeOf / coerceTo / compareValues / orderValues / hashKey / formatValue) is all it took to make them work everywhere.',
  },
  {
    n: 2.7,
    name: 'JSON — a jsonb-style structured value',
    file: 'db/json.ts',
    body: 'JSON joins the value space the same way as {t:\'json\', v} — a plain tagged object that survives a JSON round-trip, so a column of JSON serializes to localStorage with zero special-casing. It uses jsonb semantics: on the way in, object keys are normalized (sorted and de-duplicated, last value winning), which makes equality a deep structural test, hashing a canonical string, and gives every JSON value a place in one total order — so JSON indexes in the B+Tree, sorts, GROUP BYs, DISTINCTs, joins and persists for free, again just by threading it through the same six central value functions. On top sits the operator and function surface: extraction (-> ->> #> #>>), containment/existence (@> <@ ?), concat/merge (||), a library of scalar functions (TO_JSON, JSON_BUILD_OBJECT/ARRAY, JSON_TYPEOF, JSON_EXTRACT_PATH, JSONB_SET, JSON_PRETTY, …), the JSON_AGG/JSON_OBJECT_AGG aggregates, and set-returning table functions (JSON_ARRAY_ELEMENTS, JSON_EACH, …) that the planner materializes into a synthetic relation so unnested JSON composes with the rest of SQL.',
  },
  {
    n: 2.8,
    name: 'Full-text search — tsvector / tsquery + a GIN index',
    file: 'db/fts.ts',
    body: 'Search joins the value space as two more tagged objects — {t:\'tsvector\', lex} and {t:\'tsquery\', node} — threaded through the same six central value functions, so a search document indexes, sorts, GROUP BYs, joins and persists for free. The linguistics are from scratch and deterministic: a full Porter (1980) stemmer (all five steps), an English stop-word list, and a normalizer that lowercases, splits on word boundaries, drops stop-words and records each lexeme’s 1-based positions and an A/B/C/D weight. A tsquery is parsed with operator precedence (| < & < <-> < !) into a boolean+phrase AST supporting prefix (:*) and weight-filtered (:AB) terms; plainto/phraseto/websearch builders cover plain, phrase and Google-style input. Matching (@@) is a positional set-executor: a phrase a <-> b returns the set of end positions where b follows a at the right distance, so distances chain and !/&/| compose around it. ts_rank / ts_rank_cd score relevance by term weight and cover density; ts_headline highlights the original text. The capstone is a GIN inverted index (lexeme → rowid set, maintained on every insert/update/delete and rebuilt on snapshot restore): the planner walks a constant query to a conservative candidate set (postings union/intersection, falling back to all rows under a top-level NOT) and emits a GinScan that rechecks @@ exactly — lossy index, precise answer — so search is sublinear yet identical to the sequential-scan filter.',
  },
  {
    n: 3,
    name: 'Planner & cost-based optimizer',
    file: 'db/planner.ts',
    body: 'Rule-based rewrites: predicate pushdown places filters as early as the schema allows; sargable predicates on indexed columns become B+Tree IndexScans — including composite indexes (equality prefix plus one trailing range from a single tree), index-only scans when an index covers every column the query needs, and bitmap-AND scans that intersect several single-column indexes for a multi-predicate filter. A chain of INNER joins is reordered by a Selinger-style left-deep subset DP that keeps the cheapest order — costed with the v15 distinct-value join-cardinality model, and replayable in the Optimizer Lab — (and a transparent projection preserves SELECT * column order). Equijoins pick by cost between a HashJoin, a sort–merge join, and an index nested-loop join (a tiny outer driver probing a large inner table indexed on the join key — one B+Tree descent per outer row instead of hashing the whole inner side); everything else is NestedLoop. GROUP BY/HAVING compile to a HashAggregate — ROLLUP/CUBE/GROUPING SETS run as a single multi-set aggregate carrying a grouping bitmap for GROUPING(). A PlanEnv carries an overlay of named relations (CTEs and derived tables, materialized through the same executor) plus a stack of enclosing scopes that resolves correlated subqueries. A VIEW is resolved here too — its body is inlined as a derived table wherever the view name appears (in the catalog scope, with a cycle guard). And a correlated [NOT] EXISTS in WHERE is decorrelated into a hash SemiJoin / AntiJoin (build the inner side once, probe it) when its correlation reduces to equi-keys — falling back to per-row evaluation otherwise, so an answer never changes.',
  },
  {
    n: 4,
    name: 'Statistics & cardinality estimation',
    file: 'db/stats.ts',
    body: 'ANALYZE (and a lazy on-demand gather) builds per-column statistics — distinct/null counts, min/max, an equi-depth histogram and a most-common-value list. The optimizer turns those into selectivity estimates for equality, range, IN, BETWEEN and IS NULL predicates, so every operator’s estimated row count in EXPLAIN reflects the actual data distribution. The cache is dropped on any mutation. As of v15 the same distinct-value counts drive a System-R join-cardinality model: an equijoin is estimated at |L|·|R| / max(V(L,key), V(R,key)) — and crucially each key’s *effective* distinct count is capped by its input’s surviving row estimate (V_eff = min(ndistinct, inputRows)), so a selective filter on one side finally propagates through the join instead of being forgotten, sharpening the cost of every multi-join plan.',
  },
  {
    n: 4.5,
    name: 'What-if Index Advisor & Optimizer Lab',
    file: 'db/advisor.ts · ui/OptimizerLab.tsx',
    body: 'The advisor answers "which index should I create?" the way a DBA’s tuning tool does (PostgreSQL’s HypoPG, SQL Server’s DTA): it enumerates candidate indexes from a query’s sargable equalities, range bounds, equijoin keys and ORDER BY columns (single columns plus leading-equality composites), then for each candidate builds the index *hypothetically* — a genuine, backfilled B+Tree so the planner costs it for real, retracted the instant the plan is read, so your data is never changed — re-plans, and keeps only the candidates the optimizer actually adopts at a lower cost, ranked by the cost drop. The Optimizer Lab makes the whole optimizer legible: it shows the chosen plan with per-operator cost, replays the join-order subset-DP search (every relation subset, its cheapest sub-plan, and the order the search settled on), and lists the advisor’s recommendations with a one-click Apply that creates the index and re-plans so you watch the winning plan change.',
  },
  {
    n: 5,
    name: 'Expression compiler',
    file: 'db/eval.ts',
    body: 'Each expression is compiled once into a closure over a pre-resolved schema, so per-row evaluation is just a chain of function calls — with correct SQL three-valued (NULL = unknown) logic throughout.',
  },
  {
    n: 6,
    name: 'Execution (Volcano model)',
    file: 'db/operators.ts',
    body: 'Physical operators implement open()/next()/close() and pull rows one at a time from their children. SeqScan, IndexScan, IndexOnlyScan, BitmapAnd, BitmapOr, Filter, Project, HashJoin, MergeJoin, NestedLoopJoin, LateralJoin (a correlated nested loop that re-evaluates its right side per outer row, for FROM … LATERAL), HashSemiJoin (semi/anti, from EXISTS decorrelation), HashAggregate (with ROLLUP/CUBE/GROUPING SETS), Window, SetOp (UNION/INTERSECT/EXCEPT), Sort, Distinct and Limit compose into the tree EXPLAIN renders. The Sort spills to an external (run-generating, k-way) merge sort past a threshold; a WindowExec partitions and orders its buffered input to evaluate ranking, offset and aggregate window functions over standard frames — ROWS (physical), RANGE (value offsets over numbers, exact DECIMAL and DATE/TIMESTAMP±INTERVAL) and GROUPS (peer groups), each with the EXCLUDE clause (NO OTHERS / CURRENT ROW / GROUP / TIES), aggregate FILTER (WHERE …), IGNORE NULLS value functions, the statistical and ordered-set (PERCENTILE_CONT/DISC, MODE) families as windows, and a named WINDOW clause with reference inheritance.',
  },
  {
    n: 7,
    name: 'Storage — a self-balancing B+Tree',
    file: 'db/storage/btree.ts · ui/StorageLab.tsx',
    body: 'Tables are heaps keyed by rowid; secondary indexes are real B+Trees with internal/leaf nodes and a doubly-chained leaf list for range scans. Keys are tuples, so one structure backs both single-column and composite indexes — a shorter bound is treated as a key prefix. The tree is balanced on the way *down and up*: an insert splits a full leaf and grows the root; a delete that drops a node below ⌈order/2⌉ slots borrows a key from a fuller sibling, or merges with one and pulls the separator down, collapsing the root when it is left with a single child — so a tree that grew to height 4 under load returns to height 1 when emptied, and every non-root node stays at least half full (no lazy tombstones). A bottom-up bulkLoad packs a sorted run into leaves at a target fill factor (how a real CREATE INDEX builds), and checkInvariants() verifies the whole structure — balance, key order, separator routing, equal leaf depth and a sorted leaf chain — after every mutation. The Storage Lab makes it visible: insert, delete, bulk-load and range-scan a live tree and watch it split, borrow, merge and collapse, each step narrated from the tree’s own structural trace and re-proven valid. The differential self-tests run thousands of seeded random insert/delete operations against a brute-force reference, checking both the answers and the invariants at every step. EXPLAIN reports each tree’s height and node count.',
  },
  {
    n: 7.5,
    name: 'Declarative integrity & referential actions',
    file: 'db/catalog.ts',
    body: 'Constraints are first-class. The Table enforces its own-row rules — NOT NULL, CHECK (compiled to the same closure form as any predicate; a NULL result passes), and UNIQUE/PRIMARY KEY via its B+Trees (a NULL component never collides). Cross-table referential integrity is orchestrated by the Database, which owns every table: a child INSERT/UPDATE verifies its FOREIGN KEY parents exist (MATCH SIMPLE — a NULL key is exempt), and a parent DELETE/UPDATE drives the configured action — NO ACTION/RESTRICT (refuse), CASCADE (recurse), SET NULL or SET DEFAULT — across the dependent rows, recursively and cycle-guarded. DEFAULT expressions fill omitted columns. Statements are atomic: each INSERT/UPDATE/DELETE/DDL snapshots first and rolls back wholesale if any row or cascade fails, so a constraint never leaves a half-applied change.',
  },
  {
    n: 8,
    name: 'Transactions & persistence',
    file: 'db/engine.ts',
    body: 'BEGIN snapshots the catalog; ROLLBACK restores it. Snapshots round-trip the full schema — columns, indexes and every constraint (PK/UNIQUE/CHECK/DEFAULT/FOREIGN KEY) — so integrity survives a reload. After every successful statement the database is serialized to localStorage so your work survives a refresh (and degrades gracefully when sandboxed). SAVEPOINT / ROLLBACK TO / RELEASE add nested rollback points inside a transaction by stacking the same snapshots — ROLLBACK TO restores a savepoint and discards the later ones (keeping the named point so you can rewind to it again).',
  },
  {
    n: 8.5,
    name: 'Productive DML — RETURNING, MERGE, TRUNCATE',
    file: 'db/engine.ts',
    body: 'The write surface goes beyond plain INSERT/UPDATE/DELETE. RETURNING turns any mutation into a result set: each DML loop captures the rows it touched (the new image for INSERT/UPDATE, the old one for DELETE) and projects them through a select-list bound to the target — so INSERT … RETURNING id reads a generated key and DELETE … RETURNING * audits what left. MERGE folds a source set (table, derived table or VALUES) into a target in one pass: the ON predicate is compiled over the combined [target | source] row, each source row finds its matched targets under a no-double-touch guard, the first applicable WHEN arm fires (UPDATE/DELETE/INSERT/DO NOTHING), unmatched source rows fall to WHEN NOT MATCHED THEN INSERT, and WHEN NOT MATCHED BY SOURCE reaches the target rows no source row hit — all evaluated against the target image at statement start, and atomic like every mutation. TRUNCATE empties one or more tables by clearing the heap and rebuilding empty indexes (optionally RESTART IDENTITY), following CASCADE to FK children.',
  },
  {
    n: 9,
    name: 'PL/QF — a procedural language & triggers',
    file: 'db/pl.ts · db/parser.ts · db/engine.ts',
    body: 'The database is programmable. A stored FUNCTION/PROCEDURE is written in a real procedural language — DECLARE’d typed variables, IF/ELSIF, WHILE/LOOP, integer FOR ranges and FOR-query loops, EXIT/CONTINUE, RAISE, RETURN, and embedded SQL — whose body is carried as one dollar-quoted ($$ … $$) token the lexer hands back opaque, then re-tokenized and parsed by a dedicated PL grammar that reuses the SQL parser for embedded statements. The interpreter runs a body in a chain of variable frames; the one interesting trick is how embedded SQL sees those variables — before a statement like INSERT INTO audit VALUES (NEW.id, now()) reaches the engine, every bare identifier that names an in-scope variable (and every NEW/OLD record field) is substituted as a literal, so the entire query pipeline stays unaware that PL exists. A single hook in the expression compiler lets an unknown scalar-function call resolve to a stored routine, so a function invoked inside a WHERE/SELECT runs the interpreter transparently (and the planner reads its declared return type through the same hook). Triggers fire inside the engine’s per-row INSERT/UPDATE/DELETE loops: a BEFORE trigger may rewrite the row (assign NEW.col, RETURN NEW) or cancel it (RETURN NULL); an AFTER trigger sees the final image; a WHEN clause gates firing; and a recursion guard bounds trigger→DML→trigger cascades. Routines and triggers live in the catalog next to tables and views, so they snapshot/restore with transactions and persist to localStorage for free.',
  },
  {
    n: 10,
    name: 'Durability — ARIES write-ahead logging & crash recovery',
    file: 'db/recovery/wal.ts · db/recovery/recovery.ts',
    body: 'A self-contained model of how a disk-backed database survives a crash, the ARIES way (Mohan et al., 1992). Pages each carry a pageLSN; every change is logged before the page may be written (write-ahead), the log is split into a volatile tail and a forced on-disk log, and a commit forces the tail so the decision is durable. The buffer pool runs STEAL (a dirty, uncommitted page may be written to disk) and NO-FORCE (a committed page need not be) — exactly the two policies that make recovery non-trivial: STEAL is why UNDO is needed, NO-FORCE is why REDO is. Restart runs three passes: ANALYSIS replays from the last fuzzy checkpoint to rebuild the dirty-page and transaction tables and find where REDO must start; REDO repeats history — replaying winners’ and losers’ changes alike (the pageLSN test keeping it idempotent) to reconstruct the exact crash state; UNDO rolls the losers back in reverse-LSN order, writing a redo-only Compensation Log Record (CLR) per change so that a crash during recovery itself loses no progress — the restart redoes the CLRs and resumes undo from their undoNextLSN. The Recovery Lab animates all of it, and the recovery self-tests prove each scenario restores the one provably-correct state.',
  },
  {
    n: 11,
    name: 'Memory-bounded execution — work_mem & spilling',
    file: 'db/operators.ts · db/aggregate.ts · db/planner.ts',
    body: 'Every blocking operator has a memory budget — the session’s work_mem (rows) — and degrades gracefully past it instead of materialising an unbounded working set. A Sort with a LIMIT becomes a top-N heapsort: only the top k + offset rows are kept in a bounded max-heap (O(k) memory, O(n·log k) time), provably identical to a full sort then slice because ties break on input position. A Sort without a LIMIT that exceeds the budget runs an external merge sort whose run size is work_mem, so a tighter budget yields more runs and more merge passes. A GROUP BY past work_mem groups becomes a grace hash aggregate: once the in-memory hash table is full, the rows of any further new key are partitioned by a salted hash and spilled, then each partition is re-aggregated independently (recursing on skew) — and because all rows of a group share a key, no group is ever split, so COUNT(DISTINCT …) and ordered aggregates stay exact. A HashJoin whose build side overflows becomes a grace hash join: both inputs are partitioned by the join-key hash and joined partition-by-partition, with NULL keys (which never equijoin) streamed separately so every outer-join flavour is preserved. EXPLAIN ANALYZE carries per-operator memory accounting — peak rows held, rows spilled, partitions, passes — surfaced as bars in the Execution Lab, which runs each query twice (bounded vs unbounded) and proves the results are identical multiset for multiset. The safety invariant: the default budget is generous, so ordinary queries run the exact in-memory paths they always did; spilling only engages when you lower work_mem.',
  },
  {
    n: 12,
    name: 'Vectorized execution — a second, columnar engine',
    file: 'db/vectorized/* · ui/VectorLab.tsx',
    body: 'The whole pipeline above is Volcano: a tree of operators, each pulling one row at a time through next(). That composes beautifully but is the textbook slow path for analytics — a row threads through several virtual calls, every value is a boxed SqlValue, comparisons go through a generic comparator, and a GROUP BY builds a string hash key per row. So QueryForge ships a second, independent execution engine for the analytic subset (single table; numeric WHERE / GROUP BY / aggregates), built the way MonetDB/X100 and DuckDB are: vectorized and columnar. A relation is transposed once into per-column arrays (numeric columns into a packed Float64Array); the pipeline pushes batches (≈1–2k values) of a column through tight, type-specialized kernels compiled as closures over the captured typed arrays — col[i] directly, no boxing, no generic comparator — and a filter narrows an Int32Array selection vector instead of copying rows. GROUP BY hashes the numeric key tuple with an open-addressing table and accumulates COUNT/SUM/AVG/MIN/MAX into flat typed arrays (no per-row string key), preserving row order so even a floating-point SUM matches the row engine bit-for-bit. A conservative analyzer accepts only what the kernels provably match — everything else declines and runs on Volcano — and a differential self-test group runs a battery of queries through both engines asserting identical multisets. The Vectorize Lab races them live: same SQL, identical answer, a measured 20×+ speedup on group-by roll-ups, with a vector-width sweep that shows the cache-residency sweet spot.',
  },
  {
    n: 13,
    name: 'Metamorphic fuzzing — the engine tests itself',
    file: 'db/fuzz/* · ui/FuzzLab.tsx',
    body: 'Every stage above is exercised by hand-written tests — but those only check the queries we thought to write. The Fuzz Lab finds the bugs we didn’t: it generates a random database from a 32-bit seed (mulberry32 — no Math.random, so a run replays byte-for-byte) and throws thousands of random queries at the engine, each checked against a metamorphic oracle. An oracle needs no “right answer” — it is an identity that must hold for any sound engine. TLP (Ternary Logic Partitioning): every row falls in exactly one of p / NOT p / p IS NULL, so a scan equals the multiset-union of the three partitions, and an aggregate over the whole equals the aggregate over the parts. NoREC: COUNT(*) … WHERE p (which the optimizer may answer with an index) must equal SUM(CASE WHEN p THEN 1 ELSE 0 END) (a plain scan it can’t optimize). DISTINCT must equal a ground-truth dedup; and the same query under SET optimizer = on vs off must return an identical multiset. A violation is a guaranteed bug, automatically delta-debugged (Zeller) to a minimal, paste-able repro. This is SQLancer’s technique (Rigger & Su, 2020), which found 450+ real bugs in production databases — and on its very first run it found three in QueryForge: an index range scan that swept NULL keys into c < v, a pair of range bounds on one column where the looser overwrote the tighter, and the same NULL leak through a BitmapAnd. All three are fixed (db/planner.ts) and frozen as regression tests; the fuzz self-test group then re-runs seven fixed seeds (~1,750 queries) on every CI build, so they can never come back.',
  },
]

export function Internals() {
  return (
    <div className="doc">
      <h1>How a query flows through QueryForge</h1>
      <p className="doc-lead">
        A complete relational database — lexer, parser, cost-aware planner, compiled expression engine, an
        iterator-model executor, and a B+Tree storage layer — built from scratch in TypeScript. It speaks a
        broad SQL dialect: joins (including <code>LATERAL</code>), aggregation, subqueries (correlated too),
        CTEs (including <code>WITH RECURSIVE</code>), set operations, window functions, productive DML
        (<code>RETURNING</code>, <code>MERGE</code>, <code>TRUNCATE</code>, savepoints), declarative
        integrity — primary/foreign keys, <code>CHECK</code>/<code>DEFAULT</code>, and
        <code>ON DELETE/UPDATE</code> referential actions — and a procedural language with stored
        functions, procedures and triggers (<code>PL/QF</code>).
      </p>
      <ol className="pipeline">
        {STAGES.map((s, i) => (
          <li key={s.name} className="pipeline-stage">
            <div className="stage-num">{i + 1}</div>
            <div className="stage-body">
              <h3>
                {s.name} <code className="stage-file">{s.file}</code>
              </h3>
              <p>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="doc-note">
        Try <code>EXPLAIN ANALYZE</code> on any query to watch these layers cooperate — the plan tree shows the
        operators the optimizer chose and, side by side, its estimated vs. actual row counts.
      </div>
    </div>
  )
}
