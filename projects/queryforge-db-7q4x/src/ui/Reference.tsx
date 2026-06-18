// Static reference for the QueryForge SQL dialect.

interface Entry {
  syntax: string
  note: string
}
interface Section {
  title: string
  entries: Entry[]
}

const SECTIONS: Section[] = [
  {
    title: 'Data definition',
    entries: [
      { syntax: 'CREATE TABLE t (col TYPE [PRIMARY KEY] [NOT NULL] [UNIQUE] [DEFAULT e] [CHECK (e)] [REFERENCES p(c) …], …)', note: 'Types: INTEGER, REAL, DECIMAL(p,s), TEXT, BOOLEAN, DATE/TIME/TIMESTAMP/INTERVAL, JSON, TSVECTOR, TSQUERY. PK/UNIQUE auto-create a B+Tree index; USING GIN builds an inverted index over a TSVECTOR column.' },
      { syntax: 'CREATE [UNIQUE] INDEX name ON t (col1 [, col2, …])', note: 'Single- or multi-column B+Tree. A composite index answers an equality prefix plus one trailing range from one tree; a covering index can be read index-only (no heap fetch). Separate single-column indexes combine via a bitmap AND, and an IN-list scans one index via a bitmap OR.' },
      { syntax: 'ALTER TABLE t ADD [COLUMN] col TYPE … · ADD [CONSTRAINT n] CHECK/UNIQUE/FOREIGN KEY …', note: 'Evolve a table in place: a new column backfills existing rows with its DEFAULT; an added constraint is validated against the current data before it takes effect.' },
      { syntax: 'ALTER TABLE t RENAME [TO new | COLUMN c TO new] · DROP COLUMN c', note: 'Rename a table/column (referencing foreign keys are updated) or drop a column (refused while an index or constraint still needs it).' },
      { syntax: 'ANALYZE [t]', note: 'Gather column statistics (distinct/null counts, min/max, equi-depth histograms, MCV list) that drive cost-based row estimates.' },
      { syntax: 'DROP TABLE [IF EXISTS] t', note: 'Removes a table and its indexes; refused while another table’s FOREIGN KEY still references it.' },
    ],
  },
  {
    title: 'Views',
    entries: [
      { syntax: 'CREATE [OR REPLACE] VIEW v [(c1, c2, …)] AS SELECT …', note: 'A named query the planner inlines wherever the view appears — usable in FROM, JOIN, subqueries and inside other views. Optional column names rename the output. OR REPLACE swaps the definition; the body is validated when you create it.' },
      { syntax: 'SELECT … FROM v · JOIN v ON …', note: 'A view behaves like a table: it filters, sorts, groups, joins and feeds aggregates, always reflecting the current rows (it is re-evaluated each time, not materialized).' },
      { syntax: 'CREATE VIEW IF NOT EXISTS v AS … · DROP VIEW [IF EXISTS] v', note: 'A view and a table may not share a name; a directly- or indirectly-recursive view definition is rejected.' },
    ],
  },
  {
    title: 'Constraints & referential integrity',
    entries: [
      { syntax: 'col TYPE NOT NULL · col TYPE DEFAULT expr', note: 'NOT NULL rejects a NULL; DEFAULT supplies the value when the column is omitted on INSERT (e.g. DEFAULT 0, DEFAULT CURRENT_TIMESTAMP).' },
      { syntax: 'PRIMARY KEY (a [, b, …]) · UNIQUE (a [, b, …])', note: 'Single- or multi-column keys, enforced by a UNIQUE B+Tree. PK columns are implicitly NOT NULL; a UNIQUE key with any NULL component never collides (SQL semantics).' },
      { syntax: '[CONSTRAINT name] CHECK (expr)', note: 'A row is rejected only when the predicate evaluates to FALSE — a NULL (unknown) result passes. Enforced on every INSERT and UPDATE.' },
      { syntax: 'FOREIGN KEY (a, …) REFERENCES parent (x, …)', note: 'Every non-NULL child key must match a parent PRIMARY KEY / UNIQUE row (MATCH SIMPLE: a key with any NULL is exempt). Checked on INSERT and UPDATE of the child.' },
      { syntax: 'REFERENCES p(c) ON DELETE … ON UPDATE …', note: 'Referential actions when a referenced parent row is deleted or its key updated: NO ACTION · RESTRICT · CASCADE · SET NULL · SET DEFAULT. Cascades recurse (and are cycle-guarded).' },
      { syntax: '— statement atomicity —', note: 'Every INSERT/UPDATE/DELETE/DDL is all-or-nothing: if any row, cascade, or constraint fails part-way, the whole statement rolls back to its pre-statement state.' },
    ],
  },
  {
    title: 'Data manipulation',
    entries: [
      { syntax: 'INSERT INTO t (cols…) VALUES (…), (…)', note: 'Multi-row inserts. Omitted columns default to NULL.' },
      { syntax: 'INSERT INTO t (cols…) SELECT …', note: 'Populate a table from any query (joins, CTEs, subqueries included).' },
      { syntax: 'INSERT … ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET … [WHERE …]', note: 'Upsert: on a UNIQUE/PRIMARY KEY collision, skip the row (DO NOTHING) or update the existing one (DO UPDATE). EXCLUDED.col refers to the row proposed for insertion; the optional WHERE can decline an individual update. Without a target, any unique constraint arbitrates.' },
      { syntax: 'UPDATE t SET col = expr [, …] [WHERE pred]', note: 'Assignments may reference other columns of the same row.' },
      { syntax: 'DELETE FROM t [WHERE pred]', note: 'Index entries are maintained automatically.' },
    ],
  },
  {
    title: 'Queries',
    entries: [
      { syntax: 'SELECT [DISTINCT] items FROM t [alias]', note: 'items can be *, table.*, expressions, or aggregates with AS aliases.' },
      { syntax: '[INNER | LEFT | RIGHT | FULL] JOIN t2 ON pred · CROSS JOIN t2', note: 'Equijoins use a HashJoin or, for large balanced inputs, a sort–merge join (cost-based); everything else NestedLoop. Outer joins null-extend.' },
      { syntax: 'a JOIN b ON … JOIN c ON …', note: 'A chain of INNER joins is reordered by a cost-based subset DP (Selinger-style) to pick the cheapest left-deep order; SELECT * column order is preserved.' },
      { syntax: 'FROM (SELECT …) alias (c1, c2, …)', note: 'Derived tables (subqueries in FROM) are materialized and scanned like a base table; optional column aliases rename their output.' },
      { syntax: 'VALUES (…), (…) · FROM (VALUES …) AS t(cols)', note: 'A row-set literal — usable as a top-level query or an inline table to join against. Column types unify across rows.' },
      { syntax: 'WHERE pred', note: 'Conjuncts are pushed down, drive index scans, and feed histogram-based selectivity estimates.' },
      { syntax: 'GROUP BY exprs [HAVING pred]', note: 'COUNT, SUM, AVG, MIN, MAX, STDDEV[_POP], VARIANCE/VAR_POP, MEDIAN, STRING_AGG/GROUP_CONCAT — with optional DISTINCT.' },
      { syntax: 'GROUP BY ROLLUP(a, b) · CUBE(a, b) · GROUPING SETS ((a), ())', note: 'Multidimensional grouping: hierarchical subtotals (ROLLUP), every combination (CUBE), or an explicit list — all in one pass.' },
      { syntax: 'GROUPING(col [, …]) · GROUPING_ID(col, …)', note: 'In a ROLLUP/CUBE/GROUPING SETS query, returns 1 where a column was rolled up to a subtotal (NULL), else 0; GROUPING_ID packs several columns into one integer bitmap.' },
      { syntax: 'PERCENTILE_CONT(f) · PERCENTILE_DISC(f) · MODE() WITHIN GROUP (ORDER BY x)', note: 'Ordered-set aggregates: interpolated percentile, discrete percentile, and most-frequent value.' },
      { syntax: 'agg(x) FILTER (WHERE pred)', note: 'Aggregate only the rows matching pred — e.g. COUNT(*) FILTER (WHERE country = \'UK\').' },
      { syntax: 'ORDER BY expr [ASC|DESC] [, …] LIMIT n [OFFSET m]', note: 'Sort keys may reference output aliases or ordinal positions.' },
      { syntax: 'EXPLAIN [ANALYZE] SELECT …', note: 'Show the physical plan; ANALYZE also runs it and reports actual rows.' },
    ],
  },
  {
    title: 'Subqueries',
    entries: [
      { syntax: 'WHERE x > (SELECT …)', note: 'Scalar subquery — must return one row / one column (0 rows → NULL).' },
      { syntax: 'WHERE x [NOT] IN (SELECT …)', note: 'Membership test with SQL NULL semantics.' },
      { syntax: 'WHERE [NOT] EXISTS (SELECT …)', note: 'True if the subquery yields ≥ 1 row.' },
      { syntax: 'WHERE x <op> ANY|SOME|ALL (SELECT …)', note: 'Quantified comparison against every value the subquery returns.' },
      { syntax: '(SELECT … WHERE t.c = outer.c)', note: 'Correlated subqueries see the enclosing row; uncorrelated ones are executed once and cached.' },
      { syntax: 'WHERE [NOT] EXISTS (SELECT … WHERE inner.k = outer.k AND …)  →  Semi/Anti join', note: 'The optimizer decorrelates a correlated [NOT] EXISTS into a single hash SemiJoin (or AntiJoin) — building the inner side once and probing it — instead of re-running the subquery per outer row. EXPLAIN shows the rewrite. Shapes it can’t prove equivalent fall back to per-row evaluation.' },
    ],
  },
  {
    title: 'CTEs & set operations',
    entries: [
      { syntax: 'WITH a AS (…), b AS (…) SELECT …', note: 'Named subqueries; later CTEs may reference earlier ones.' },
      { syntax: 'WITH RECURSIVE r AS (anchor UNION [ALL] recursive) …', note: 'Semi-naive fixpoint iteration — sequences, graphs, hierarchies.' },
      { syntax: 'q1 UNION [ALL] q2', note: 'Combine; UNION dedupes, UNION ALL keeps multiplicities.' },
      { syntax: 'q1 INTERSECT [ALL] q2 · q1 EXCEPT [ALL] q2', note: 'Set / multiset intersection and difference.' },
    ],
  },
  {
    title: 'Window functions  —  fn(…) OVER (PARTITION BY … ORDER BY …)',
    entries: [
      { syntax: 'ROW_NUMBER() · RANK() · DENSE_RANK() · NTILE(k)', note: 'Ranking within each partition’s order.' },
      { syntax: 'PERCENT_RANK() · CUME_DIST()', note: 'Relative position of the row within its partition.' },
      { syntax: 'LAG(x[,n[,def]]) · LEAD(x[,n[,def]])', note: 'Value from a row n positions away in the partition order.' },
      { syntax: 'FIRST_VALUE(x) · LAST_VALUE(x) · NTH_VALUE(x,n) [IGNORE NULLS]', note: 'Pick a value from the frame; IGNORE NULLS skips nulls (RESPECT NULLS is the default). LAG/LEAD honour IGNORE NULLS too.' },
      { syntax: 'SUM/AVG/COUNT/MIN/MAX/STDDEV/VARIANCE(x) OVER (…)', note: 'Ordered ⇒ running total; unordered ⇒ whole-partition aggregate. The statistical family works as a window too.' },
      { syntax: 'PERCENTILE_CONT/PERCENTILE_DISC(f) WITHIN GROUP (ORDER BY x) OVER (…) · MODE() … OVER (…)', note: 'Ordered-set aggregates as window functions — e.g. a per-partition running median.' },
      { syntax: 'fn(x) FILTER (WHERE …) OVER (…)', note: 'Only rows in the frame matching the predicate feed the aggregate.' },
      { syntax: 'fn(x) OVER (ORDER BY … ROWS|RANGE|GROUPS BETWEEN a AND b [EXCLUDE …])', note: 'ROWS = physical rows, RANGE = value offsets (numbers, exact DECIMAL, or DATE/TIMESTAMP ± INTERVAL), GROUPS = peer groups. Bounds: UNBOUNDED PRECEDING, n PRECEDING, CURRENT ROW, n FOLLOWING, UNBOUNDED FOLLOWING. EXCLUDE NO OTHERS | CURRENT ROW | GROUP | TIES.' },
      { syntax: 'fn(x) OVER w … WINDOW w AS (PARTITION BY …), w2 AS (w ORDER BY …)', note: 'Name a window once and reuse it; a referencing spec inherits PARTITION BY and may add ORDER BY / a frame.' },
    ],
  },
  {
    title: 'Expressions',
    entries: [
      { syntax: 'AND OR NOT · = <> < <= > >= · + - * / %', note: 'Full SQL three-valued logic — NULL is "unknown".' },
      { syntax: 'x BETWEEN a AND b · x IN (…) · x LIKE \'a%_\'', note: 'LIKE: % = any run, _ = any single character.' },
      { syntax: 'x IS [NOT] NULL · a || b · CAST(x AS TYPE) · x::TYPE', note: '|| concatenates text (or, between two JSON values, concatenates/merges them). Postgres-style ::TYPE is a postfix cast that binds tightest.' },
      { syntax: 'CASE WHEN … THEN … [ELSE …] END', note: 'Both searched and simple CASE forms.' },
      { syntax: 'UPPER LOWER INITCAP TRIM LTRIM RTRIM LPAD RPAD REPEAT REVERSE', note: 'String functions.' },
      { syntax: 'LEFT RIGHT SUBSTR INSTR REPLACE CONCAT CONCAT_WS LENGTH ASCII CHR', note: 'More string functions.' },
      { syntax: 'ABS SIGN ROUND TRUNC CEIL FLOOR SQRT EXP LN LOG LOG10 POWER MOD', note: 'Numeric functions. ABS/SIGN/ROUND/TRUNC/CEIL/FLOOR/MOD stay exact on a DECIMAL.' },
      { syntax: 'PI SIN COS TAN ASIN ACOS ATAN ATAN2 RADIANS DEGREES RANDOM', note: 'Trig & misc math.' },
      { syntax: 'COALESCE IFNULL NVL NULLIF IIF GREATEST LEAST TYPEOF', note: 'Conditional / null-handling.' },
      { syntax: 'NOW DATE DATETIME STRFTIME JULIANDAY DATEDIFF DATE_ADD', note: 'Legacy SQLite-style date helpers over ISO-8601 text or epoch-ms.' },
    ],
  },
  {
    title: 'Temporal types  —  DATE · TIME · TIMESTAMP · INTERVAL',
    entries: [
      { syntax: "DATE '2026-06-15' · TIME '13:45:30' · TIMESTAMP '2026-06-15 13:45:30'", note: 'First-class typed literals (UTC, no time zone). Sub-second precision to milliseconds.' },
      { syntax: "INTERVAL '1 year 2 months 3 days' · INTERVAL '90 minutes' · INTERVAL '1 day 04:05:06'", note: 'Calendar-aware durations: year…millisecond phrases, weeks, and a clock segment.' },
      { syntax: 'CREATE TABLE t (d DATE, ts TIMESTAMP, iv INTERVAL) · CAST(x AS DATE)', note: 'Use them as column types; strings coerce on INSERT and in comparisons (date = \'2026-06-15\').' },
      { syntax: "date + interval → timestamp · date + int → date · date − date → int days", note: 'Adding a month clamps the day-of-month (Jan 31 + 1 month → Feb 28).' },
      { syntax: 'timestamp − timestamp → interval · interval ± interval · interval * n · −interval', note: 'Full interval algebra; intervals sort and aggregate (MIN/MAX) like any value.' },
      { syntax: 'EXTRACT(field FROM x) · DATE_PART(field, x)', note: 'Fields: year month day hour minute second dow isodow doy week quarter decade century epoch.' },
      { syntax: "DATE_TRUNC('month', ts) · AGE(end, start) · AGE(ts)", note: 'Truncate to a unit; AGE yields a calendar interval of whole years/months/days.' },
      { syntax: 'CURRENT_DATE · CURRENT_TIME · CURRENT_TIMESTAMP / NOW', note: 'Niladic — usable without parentheses, per the SQL standard.' },
      { syntax: 'MAKE_DATE(y,m,d) · MAKE_TIME(h,mi,s) · MAKE_TIMESTAMP(…) · MAKE_INTERVAL(…)', note: 'Build temporal values from numeric parts. TO_DATE/TO_TIMESTAMP parse text.' },
      { syntax: "TO_CHAR(x, 'Dy, DD Mon YYYY HH24:MI')", note: 'Postgres-style templates: YYYY MM DD HH24 HH12 MI SS MS · Mon/Month · Dy/Day · AM/PM · Q · IW. Double-quoted text is literal.' },
    ],
  },
  {
    title: 'Exact numerics  —  DECIMAL / NUMERIC',
    entries: [
      { syntax: "DECIMAL '19.99' · NUMERIC '0.1' · DEC '1.5e3'", note: 'Arbitrary-precision exact decimals (BigInt-backed). 0.1 + 0.2 is exactly 0.3 — no binary-float drift.' },
      { syntax: 'CREATE TABLE t (price DECIMAL(10,2)) · CAST(x AS DECIMAL(12,4))', note: 'DECIMAL(precision, scale): values round to the declared scale on store / cast (half-up).' },
      { syntax: 'a + b · a − b  (scale = max)   ·   a * b  (scale = sum)   ·   a / b  (scale ≥ 6)', note: 'Exact against DECIMAL/INTEGER; mixing with a REAL degrades to floating point. ÷0 → NULL.' },
      { syntax: 'SUM(col) · AVG(col)  over a DECIMAL column', note: 'Stay exact — SUM of money never loses a cent; AVG carries ≥ 6 fractional digits.' },
      { syntax: "DECIMAL '1.50' = DECIMAL '1.5' = 1.5 = 2−0.5", note: 'Scale-independent comparison; equal values share one identity in GROUP BY / DISTINCT / joins.' },
      { syntax: 'TYPEOF(x) · SCALE(d) · PRECISION(d) · TO_NUMBER(t) · DECIMAL(x [, scale])', note: 'Introspect and construct exact numerics.' },
      { syntax: "TO_CHAR(1234.5, 'FM$999,999.00') → $1,234.50", note: "Numeric templates: 9 0 . , (or D G), S MI PR sign forms, $ / L currency, FM fill, # on overflow." },
    ],
  },
  {
    title: 'JSON  —  jsonb-style structured values',
    entries: [
      { syntax: "'{\"a\":1}'::JSON · CAST(t AS JSON) · CREATE TABLE d (body JSON)", note: 'JSON (alias JSONB) is a first-class value: text parses on cast, and object keys are normalized (sorted, duplicates → last wins). JSON columns index in the B+Tree, sort, GROUP BY, DISTINCT, join and persist like any other type.' },
      { syntax: "j -> 'key' · j -> n · j ->> 'key'", note: 'Extract a member: -> returns JSON, ->> returns text. An integer index addresses arrays (negative counts from the end). A missing key/index → NULL. Binds tighter than arithmetic.' },
      { syntax: "j #> '{a,1,b}' · j #>> '{a,1,b}'", note: 'Follow a text path (a Postgres {…} array literal): #> returns JSON, #>> returns text.' },
      { syntax: 'a @> b · a <@ b · j ? \'key\'', note: 'Containment (does a contain b?), contained-by, and top-level key existence — all boolean, usable directly in WHERE.' },
      { syntax: 'a || b  (JSON)', note: 'Concatenate two arrays, or merge two objects (right side wins on duplicate keys).' },
      { syntax: "TO_JSON(x) · JSON(t) · JSON_BUILD_OBJECT(k,v,…) · JSON_BUILD_ARRAY(…)", note: 'Construct JSON: wrap a scalar, parse text, or build an object/array from arguments.' },
      { syntax: 'JSON_TYPEOF(j) · JSON_ARRAY_LENGTH(j) · JSON_OBJECT_KEYS(j) · JSON_VALID(t)', note: 'Introspection: the JSON type name, an array’s length, an object’s keys (as a JSON array), and whether text is valid JSON.' },
      { syntax: "JSON_EXTRACT_PATH(j, k1, k2, …) · JSON_EXTRACT_PATH_TEXT(…)", note: 'Variadic path access — the function form of #> / #>>.' },
      { syntax: "JSONB_SET(j, '{path}', value [, create]) · JSON_STRIP_NULLS(j) · JSON_PRETTY(j) · JSON_CONTAINS(a,b)", note: 'Transform: set/insert at a path (the value is itself JSON), drop null members, pretty-print, or test containment as a function.' },
      { syntax: 'JSON_AGG(x) · JSON_OBJECT_AGG(k, v)', note: 'Aggregate rows into a JSON array (NULLs preserved, input order kept) or a JSON object.' },
      { syntax: 'FROM JSON_ARRAY_ELEMENTS(j) · JSON_EACH(j) · JSON_EACH_TEXT(j) · JSON_OBJECT_KEYS(j)', note: 'Set-returning table functions: expand a JSON array/object into rows (value, or key+value) that compose with joins, WHERE, GROUP BY. (Arguments must be constant — LATERAL is not supported.)' },
    ],
  },
  {
    title: 'Full-text search  —  TSVECTOR · TSQUERY',
    entries: [
      { syntax: "vec @@ query", note: 'The match operator: true when the TSVECTOR document satisfies the TSQUERY. Symmetric (query @@ vec works), and either side may be text — it is coerced (to_tsvector / to_tsquery). First-class values: both index, sort, GROUP BY, DISTINCT, join and persist like any type.' },
      { syntax: "to_tsvector([cfg,] text)", note: 'Tokenize → lowercase → drop stop-words → Porter-stem, recording each lexeme’s 1-based positions. Renders as ‘lexeme’:pos[weight] … e.g. ‘cat’:3 ‘fat’:2A.' },
      { syntax: "to_tsquery(text) · plainto_tsquery(text) · phraseto_tsquery(text) · websearch_to_tsquery(text)", note: 'Build a query: full operator syntax; a plain AND of words; a <-> phrase of words; or Google-style ("quoted phrases", bare OR, leading - to exclude).' },
      { syntax: "a & b · a | b · !a · a <-> b · a <N> b · word:* · word:AB", note: 'Query operators: AND, OR, NOT, FOLLOWED-BY (phrase, distance 1), distance N, prefix match, and a weight filter (match only A/B-weighted positions). Precedence: | < & < <-> < !.' },
      { syntax: "ts_rank([weights,] vec, query [, norm]) · ts_rank_cd(…)", note: 'Relevance: weighted by A/B/C/D term weights; ts_rank_cd is cover-density (tighter matches score higher). The optional norm bitmask divides by document length, unique words, etc.' },
      { syntax: "ts_headline(document, query) · setweight(vec, 'A') · strip(vec) · a || b", note: 'Highlight the matched words of the original text; label every position with a weight; drop positions; or concatenate two vectors (the right side’s positions are shifted past the left).' },
      { syntax: "numnode(q) · querytree(q) · tsvector_length(v) · q1 && q2 · q1 || q2 · !!q", note: 'Count query nodes; render the query; count distinct lexemes; and combine queries (AND / OR / NOT) as functions.' },
      { syntax: "CREATE INDEX i ON t USING GIN (vec_col)", note: 'A GIN inverted index (lexeme → row list) over a TSVECTOR column. The planner turns col @@ <constant query> into a posting-list probe + exact recheck — a GinScan in EXPLAIN — instead of a sequential scan.' },
    ],
  },
  {
    title: 'Transactions',
    entries: [
      { syntax: 'BEGIN; … COMMIT;', note: 'Snapshot taken at BEGIN; COMMIT keeps changes.' },
      { syntax: 'BEGIN; … ROLLBACK;', note: 'Restores the snapshot, undoing every change since BEGIN.' },
    ],
  },
]

export function Reference() {
  return (
    <div className="doc">
      <h1>SQL dialect reference</h1>
      <p className="doc-lead">
        QueryForge implements a focused SQL dialect end-to-end in the browser — no server, no WASM, just
        TypeScript. Everything below is parsed, planned, optimized and executed locally.
      </p>
      {SECTIONS.map((s) => (
        <section key={s.title} className="doc-section">
          <h2>{s.title}</h2>
          <div className="doc-grid">
            {s.entries.map((e, i) => (
              <div key={i} className="doc-entry">
                <code>{e.syntax}</code>
                <p>{e.note}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
