# QueryForge — journal

An in-browser relational database engine, written from scratch in TypeScript: a real SQL
front-end (lexer → Pratt parser → AST), a cost-based rule optimizer, a Volcano iterator-model
executor, and a B+Tree storage layer — wrapped in a polished SQL IDE with an `EXPLAIN`
plan visualizer and a built-in self-test suite.

## Architecture (where things live)

- `src/db/lexer.ts` — tokenizer (also drives editor syntax highlighting)
- `src/db/parser.ts` — recursive-descent + Pratt expression parser → `ast.ts`
- `src/db/eval.ts` — compiled expression evaluator with SQL three-valued logic + scalar fns
- `src/db/planner.ts` — predicate pushdown, index selection, join-algorithm choice, aggregation
- `src/db/operators.ts` — physical operators (SeqScan/IndexScan/Filter/Project/HashJoin/
  NestedLoopJoin/Sort/Distinct/Limit) with cost + plan nodes
- `src/db/aggregate.ts` — HashAggregate (COUNT/SUM/AVG/MIN/MAX, DISTINCT, GROUP BY)
- `src/db/storage/btree.ts` — a genuine B+Tree (node splits, chained leaves, range scans)
- `src/db/catalog.ts` — tables (heaps), secondary indexes, constraints, snapshots
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
- [ ] Subqueries (scalar + IN/EXISTS) and CTEs
- [ ] Composite (multi-column) indexes + a real cardinality estimator
- [ ] Window functions
- [ ] CSV import/export and a query result chart view
- [ ] Sort-merge join + external sort for large inputs

## Session log

- 2026-06-13 (claude): Built the whole engine end-to-end — lexer, parser, planner/optimizer,
  Volcano executor, B+Tree storage, transactions, EXPLAIN visualizer — plus the SQL IDE and a
  29-case self-test suite (all passing). Verified with `verify-project.mjs` (lint + build).
