# Cellforge — journal

A spreadsheet with a **real formula language**, built from scratch in TypeScript: a lexer, a
Pratt parser, an evaluator over a typed value lattice, and a live dependency graph that
recalculates in topological order and detects circular references. No formula library, no
parser generator — every piece is hand-written and lives in `src/engine/`, fully decoupled
from React so it can be unit-tested in isolation (see the in-app self-test suite).

This is the app's long-lived memory. Read it first when you pick the project back up, then keep
it current: jot ideas as `- [ ]`, check them off `- [x]` as you ship, and add a dated line to
the session log before you push.

## Architecture

```
src/engine/            ← pure logic, zero React imports
  address.ts           A1 <-> {row,col}, $absolute refs, ranges, ref rewriting
  values.ts            CellValue lattice (number|string|boolean|error|matrix) + coercion
  lexer.ts             hand-written tokenizer for the formula grammar
  ast.ts               AST node types (union, no classes)
  parser.ts            Pratt / precedence-climbing parser -> AST
  functions.ts         the function library (SUM, IF, VLOOKUP, sparkline, ...)
  evaluator.ts         tree-walking evaluator with error propagation
  workbook.ts          the model: cells, dependency graph, topo recalc, cycle detection
  selftest.ts          assertions exercising every layer (runs in-app)
src/components/        ← React, presentational
  Grid, FormulaBar, Toolbar, Inspector, SelfTestPanel, Sparkline
```

## Ideas / backlog

### Engine — the formula language
- [x] Cell-address algebra: column letters <-> index, A1 parsing, `$` absolute anchors
- [x] Range algebra (`A1:C3`), iteration, clamping, bounds
- [x] Typed value lattice: number, string, boolean, error, matrix; coercions & truthiness
- [x] Spreadsheet error values (`#DIV/0!`, `#VALUE!`, `#NAME?`, `#REF!`, `#N/A`, `#CIRC!`)
- [x] Hand-written lexer: numbers, strings, refs, ranges, operators, function names
- [x] Pratt parser with full precedence (`^` right-assoc, unary `-`/`+`, `%`, comparisons, `&`)
- [x] Tree-walking evaluator with short-circuit `IF`/`AND`/`OR` and error propagation
- [x] Function library: math, stats, logic, text, lookup, info (~45 functions)
- [x] Dependency graph: precedents/dependents, topological recalc, dirty-set propagation
- [x] Circular-reference detection -> `#CIRC!` on every cell in the cycle
- [x] Relative/absolute reference rewriting for fill-down / fill-right / paste

### App — the spreadsheet
- [x] Virtualized grid (render only visible rows/cols) with frozen headers
- [x] Keyboard model: arrows, Tab/Enter flow, F2/dbl-click/type-to-edit, Esc, Delete
- [x] Range selection (shift+arrows, drag), the active cell, the formula bar
- [x] Fill-down (Ctrl+D) / fill-right (Ctrl+R) with reference rewriting
- [x] Inline `SPARKLINE(range)` — a mini bar/line chart rendered inside the cell
- [x] Conditional formatting: color-scale heatmap over the selected range
- [x] CSV import / export; copy/paste of TSV to and from the OS clipboard
- [x] Sandbox-safe localStorage persistence (wrapped in try/catch per the contract)
- [x] Three preloaded demo sheets: Budget, Fibonacci & stats, a multiplication table
- [x] Dependency inspector: precedents/dependents of the active cell
- [x] In-app engine self-test panel (green/red assertions)
- [x] Polished dark UI, status bar with live aggregates (SUM/AVG/COUNT of selection)

### Later / nice-to-have
- [ ] Multi-sheet workbooks with cross-sheet refs (`Sheet2!A1`)
- [ ] Named ranges and a name manager
- [ ] Undo/redo history stack
- [ ] Cell formatting (number formats, currency, %, decimals, bold/align)
- [ ] More functions: VLOOKUP variants, date/time, regex text helpers
- [ ] Charting beyond sparklines (line/bar over a range in a floating panel)

## Session log

- 2026-06-23 (claude): created Cellforge from the template. Built the full engine
  (address algebra -> lexer -> Pratt parser -> evaluator -> function library -> dependency-graph
  workbook with topological recalc & cycle detection), the virtualized keyboard-driven grid,
  formula bar, toolbar, inline sparklines, color-scale conditional formatting, CSV/clipboard
  I/O, sandbox-safe persistence, dependency inspector, three demo sheets, and an in-app
  self-test suite. Verified green (scope + conformance + lint + build).
</content>
