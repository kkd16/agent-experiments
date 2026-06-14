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
      { syntax: 'CREATE TABLE t (col TYPE [PRIMARY KEY] [NOT NULL] [UNIQUE], …)', note: 'Types: INTEGER, REAL, TEXT, BOOLEAN. PK/UNIQUE auto-create a B+Tree index.' },
      { syntax: 'CREATE [UNIQUE] INDEX name ON t (col)', note: 'Builds a B+Tree the planner can use for equality/range scans.' },
      { syntax: 'DROP TABLE [IF EXISTS] t', note: 'Removes a table and its indexes.' },
    ],
  },
  {
    title: 'Data manipulation',
    entries: [
      { syntax: 'INSERT INTO t (cols…) VALUES (…), (…)', note: 'Multi-row inserts. Omitted columns default to NULL.' },
      { syntax: 'INSERT INTO t (cols…) SELECT …', note: 'Populate a table from any query (joins, CTEs, subqueries included).' },
      { syntax: 'UPDATE t SET col = expr [, …] [WHERE pred]', note: 'Assignments may reference other columns of the same row.' },
      { syntax: 'DELETE FROM t [WHERE pred]', note: 'Index entries are maintained automatically.' },
    ],
  },
  {
    title: 'Queries',
    entries: [
      { syntax: 'SELECT [DISTINCT] items FROM t [alias]', note: 'items can be *, table.*, expressions, or aggregates with AS aliases.' },
      { syntax: '[INNER | LEFT | RIGHT | FULL] JOIN t2 ON pred · CROSS JOIN t2', note: 'Equijoins become HashJoins; everything else NestedLoop. Outer joins null-extend.' },
      { syntax: 'FROM (SELECT …) alias', note: 'Derived tables (subqueries in FROM) are materialized and scanned like a base table.' },
      { syntax: 'WHERE pred', note: 'Conjuncts are pushed down and may trigger index scans.' },
      { syntax: 'GROUP BY exprs [HAVING pred]', note: 'COUNT, SUM, AVG, MIN, MAX — with optional DISTINCT.' },
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
      { syntax: '(SELECT … WHERE t.c = outer.c)', note: 'Correlated subqueries see the enclosing row; uncorrelated ones are executed once and cached.' },
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
      { syntax: 'FIRST_VALUE(x) · LAST_VALUE(x) · NTH_VALUE(x,n)', note: 'Pick a value from the partition.' },
      { syntax: 'SUM/AVG/COUNT/MIN/MAX(x) OVER (…)', note: 'Ordered ⇒ running total; unordered ⇒ whole-partition aggregate.' },
    ],
  },
  {
    title: 'Expressions',
    entries: [
      { syntax: 'AND OR NOT · = <> < <= > >= · + - * / %', note: 'Full SQL three-valued logic — NULL is "unknown".' },
      { syntax: 'x BETWEEN a AND b · x IN (…) · x LIKE \'a%_\'', note: 'LIKE: % = any run, _ = any single character.' },
      { syntax: 'x IS [NOT] NULL · a || b · CAST(x AS TYPE)', note: '|| concatenates text.' },
      { syntax: 'CASE WHEN … THEN … [ELSE …] END', note: 'Both searched and simple CASE forms.' },
      { syntax: 'UPPER LOWER INITCAP TRIM LTRIM RTRIM LPAD RPAD REPEAT REVERSE', note: 'String functions.' },
      { syntax: 'LEFT RIGHT SUBSTR INSTR REPLACE CONCAT CONCAT_WS LENGTH ASCII CHR', note: 'More string functions.' },
      { syntax: 'ABS SIGN ROUND TRUNC CEIL FLOOR SQRT EXP LN LOG LOG10 POWER MOD', note: 'Numeric functions.' },
      { syntax: 'PI SIN COS TAN ASIN ACOS ATAN ATAN2 RADIANS DEGREES RANDOM', note: 'Trig & misc math.' },
      { syntax: 'COALESCE IFNULL NVL NULLIF IIF GREATEST LEAST TYPEOF', note: 'Conditional / null-handling.' },
      { syntax: 'NOW DATE DATETIME DATE_PART EXTRACT STRFTIME JULIANDAY DATEDIFF DATE_ADD', note: 'Date/time over ISO-8601 text or epoch-ms.' },
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
