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
    body: 'Recursive descent for statements, with a Pratt (precedence-climbing) sub-parser for expressions. Produces a fully typed AST — including BETWEEN/IN/LIKE/CASE/CAST and the full join grammar.',
  },
  {
    n: 3,
    name: 'Planner & optimizer',
    file: 'db/planner.ts',
    body: 'Rule-based rewrites: predicate pushdown places filters as early as the schema allows; sargable predicates on indexed columns are turned into B+Tree IndexScans; equijoins become HashJoins, everything else NestedLoop. GROUP BY/HAVING compile to a HashAggregate. A PlanEnv carries an overlay of named relations (CTEs and derived tables, materialized through the same executor) plus a stack of enclosing scopes that resolves correlated subqueries.',
  },
  {
    n: 4,
    name: 'Expression compiler',
    file: 'db/eval.ts',
    body: 'Each expression is compiled once into a closure over a pre-resolved schema, so per-row evaluation is just a chain of function calls — with correct SQL three-valued (NULL = unknown) logic throughout.',
  },
  {
    n: 5,
    name: 'Execution (Volcano model)',
    file: 'db/operators.ts',
    body: 'Physical operators implement open()/next()/close() and pull rows one at a time from their children. SeqScan, IndexScan, Filter, Project, HashJoin, NestedLoopJoin, HashAggregate, Window, SetOp (UNION/INTERSECT/EXCEPT), Sort, Distinct and Limit compose into the tree EXPLAIN renders. A WindowExec partitions and orders its buffered input to evaluate ranking, offset and running-aggregate window functions.',
  },
  {
    n: 6,
    name: 'Storage',
    file: 'db/storage/btree.ts',
    body: 'Tables are heaps keyed by rowid; secondary indexes are real B+Trees with internal/leaf nodes, node splitting, and a chained leaf list for range scans. EXPLAIN reports each tree’s height and node count.',
  },
  {
    n: 7,
    name: 'Transactions & persistence',
    file: 'db/engine.ts',
    body: 'BEGIN snapshots the catalog; ROLLBACK restores it. After every successful statement the database is serialized to localStorage so your work survives a refresh (and degrades gracefully when sandboxed).',
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
        RECURSIVE</code>), set operations and window functions.
      </p>
      <ol className="pipeline">
        {STAGES.map((s) => (
          <li key={s.n} className="pipeline-stage">
            <div className="stage-num">{s.n}</div>
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
