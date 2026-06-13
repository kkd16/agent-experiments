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
      { syntax: 'UPDATE t SET col = expr [, …] [WHERE pred]', note: 'Assignments may reference other columns of the same row.' },
      { syntax: 'DELETE FROM t [WHERE pred]', note: 'Index entries are maintained automatically.' },
    ],
  },
  {
    title: 'Queries',
    entries: [
      { syntax: 'SELECT [DISTINCT] items FROM t [alias]', note: 'items can be *, table.*, expressions, or aggregates with AS aliases.' },
      { syntax: '[INNER | LEFT] JOIN t2 ON pred / CROSS JOIN t2', note: 'Equijoins become HashJoins; everything else NestedLoop.' },
      { syntax: 'WHERE pred', note: 'Conjuncts are pushed down and may trigger index scans.' },
      { syntax: 'GROUP BY exprs [HAVING pred]', note: 'COUNT, SUM, AVG, MIN, MAX — with optional DISTINCT.' },
      { syntax: 'ORDER BY expr [ASC|DESC] [, …] LIMIT n [OFFSET m]', note: 'Sort keys may reference output aliases.' },
      { syntax: 'EXPLAIN [ANALYZE] SELECT …', note: 'Show the physical plan; ANALYZE also runs it and reports actual rows.' },
    ],
  },
  {
    title: 'Expressions',
    entries: [
      { syntax: 'AND OR NOT · = <> < <= > >= · + - * / %', note: 'Full SQL three-valued logic — NULL is "unknown".' },
      { syntax: 'x BETWEEN a AND b · x IN (…) · x LIKE \'a%_\'', note: 'LIKE: % = any run, _ = any single character.' },
      { syntax: 'x IS [NOT] NULL · a || b · CAST(x AS TYPE)', note: '|| concatenates text.' },
      { syntax: 'CASE WHEN … THEN … [ELSE …] END', note: 'Both searched and simple CASE forms.' },
      { syntax: 'UPPER LOWER LENGTH TRIM SUBSTR REPLACE CONCAT', note: 'String functions.' },
      { syntax: 'ABS ROUND CEIL FLOOR SQRT POW MOD · COALESCE IFNULL IIF TYPEOF', note: 'Numeric & utility functions.' },
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
