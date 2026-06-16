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
    body: 'Rule-based rewrites: predicate pushdown places filters as early as the schema allows; sargable predicates on indexed columns become B+Tree IndexScans — including composite indexes (equality prefix plus one trailing range from a single tree), index-only scans when an index covers every column the query needs, and bitmap-AND scans that intersect several single-column indexes for a multi-predicate filter. A chain of INNER joins is reordered by a Selinger-style left-deep subset DP that keeps the cheapest order (and a transparent projection preserves SELECT * column order). Equijoins pick between a HashJoin and a sort–merge join by cost; everything else is NestedLoop. GROUP BY/HAVING compile to a HashAggregate — ROLLUP/CUBE/GROUPING SETS run as a single multi-set aggregate carrying a grouping bitmap for GROUPING(). A PlanEnv carries an overlay of named relations (CTEs and derived tables, materialized through the same executor) plus a stack of enclosing scopes that resolves correlated subqueries. A VIEW is resolved here too — its body is inlined as a derived table wherever the view name appears (in the catalog scope, with a cycle guard). And a correlated [NOT] EXISTS in WHERE is decorrelated into a hash SemiJoin / AntiJoin (build the inner side once, probe it) when its correlation reduces to equi-keys — falling back to per-row evaluation otherwise, so an answer never changes.',
  },
  {
    n: 4,
    name: 'Statistics & cardinality estimation',
    file: 'db/stats.ts',
    body: 'ANALYZE (and a lazy on-demand gather) builds per-column statistics — distinct/null counts, min/max, an equi-depth histogram and a most-common-value list. The optimizer turns those into selectivity estimates for equality, range, IN, BETWEEN and IS NULL predicates, so every operator’s estimated row count in EXPLAIN reflects the actual data distribution. The cache is dropped on any mutation.',
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
    body: 'Physical operators implement open()/next()/close() and pull rows one at a time from their children. SeqScan, IndexScan, IndexOnlyScan, BitmapAnd, BitmapOr, Filter, Project, HashJoin, MergeJoin, NestedLoopJoin, HashSemiJoin (semi/anti, from EXISTS decorrelation), HashAggregate (with ROLLUP/CUBE/GROUPING SETS), Window, SetOp (UNION/INTERSECT/EXCEPT), Sort, Distinct and Limit compose into the tree EXPLAIN renders. The Sort spills to an external (run-generating, k-way) merge sort past a threshold; a WindowExec partitions and orders its buffered input to evaluate ranking, offset and running-aggregate window functions over explicit ROWS/RANGE frames; ordered-set aggregates (PERCENTILE_CONT/DISC, MODE) buffer and order their WITHIN GROUP key.',
  },
  {
    n: 7,
    name: 'Storage',
    file: 'db/storage/btree.ts',
    body: 'Tables are heaps keyed by rowid; secondary indexes are real B+Trees with internal/leaf nodes, node splitting, and a chained leaf list for range scans. Keys are tuples, so one structure backs both single-column and composite indexes — a shorter bound is treated as a key prefix. EXPLAIN reports each tree’s height and node count.',
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
    body: 'BEGIN snapshots the catalog; ROLLBACK restores it. Snapshots round-trip the full schema — columns, indexes and every constraint (PK/UNIQUE/CHECK/DEFAULT/FOREIGN KEY) — so integrity survives a reload. After every successful statement the database is serialized to localStorage so your work survives a refresh (and degrades gracefully when sandboxed).',
  },
]

export function Internals() {
  return (
    <div className="doc">
      <h1>How a query flows through QueryForge</h1>
      <p className="doc-lead">
        A complete relational database — lexer, parser, cost-aware planner, compiled expression engine, an
        iterator-model executor, and a B+Tree storage layer — built from scratch in TypeScript. It speaks a
        broad SQL dialect: joins, aggregation, subqueries (correlated too), CTEs (including <code>WITH
        RECURSIVE</code>), set operations, window functions, and declarative integrity — primary/foreign
        keys, <code>CHECK</code>/<code>DEFAULT</code>, and <code>ON DELETE/UPDATE</code> referential actions.
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
