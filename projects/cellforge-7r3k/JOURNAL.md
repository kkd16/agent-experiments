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

## v2 — "from a calculator to a real spreadsheet" (this session)

v1 was a genuinely capable single-sheet engine. v2 turns it into a *workbook*: many
sheets that reference each other, an undo history, real cell formatting, a date system,
a much larger function library, named ranges, in-grid charts, and find/replace. Every
piece keeps the engine pure and React-free, and every layer earns new entries in the
in-app self-test suite (it grows from 65 to 123 assertions).

### Multi-sheet workbooks + cross-sheet references *(the marquee feature)*
- [x] Generalize the model: a `Workbook` owns many `Sheet`s; one global dependency
  graph + value store spans every sheet (keyed by a `sheetId␟ r,c` global key)
- [x] Lexer: a `!` (bang) token and quoted `'Sheet name'` sheet-name tokens
- [x] Parser + AST: sheet-qualified refs/ranges (`Sheet2!A1`, `'Q3 Data'!A1:C9`) — the
  qualifier rides on the `CellRef`, so fill/paste rewriting preserves it
- [x] Evaluator: resolve a ref's sheet by name → id → cross-sheet read; `#REF!` on a
  missing sheet; topological recalc now orders cells *across* sheets
- [x] Sheet tabs UI: switch, add, rename (double-click), duplicate, delete, reorder;
  the active sheet drives the grid, formula bar, and status bar
- [x] Cross-sheet self-tests (a value chain that hops between three sheets)

### Defined names / named ranges + a name manager
- [x] A workbook-global name table (`Tax = 0.0825`, `Sales = Sheet1!B2:B13`), each name
  carrying its definition AST and a scope sheet for unqualified refs
- [x] Parser emits `name` nodes; evaluator + precedent resolver expand them (with a
  recursion guard so a self-referential name degrades to `#REF!`, never hangs)
- [x] Name Manager dialog: add / edit / delete names, live validity check, jump-to-range
- [x] Use a name anywhere a value/range is expected, including inside other names

### Undo / redo
- [x] Whole-workbook snapshot history (serialize is cheap), capped, with redo cleared
  on a fresh edit; `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` + toolbar buttons
- [x] Every mutation (edit, fill, paste, clear, formatting, sheet ops, names) is undoable

### Cell formatting
- [x] Per-cell format record (number format, decimals, currency symbol, bold/italic/
  underline, horizontal align, text + fill color), stored per sheet, persisted
- [x] Number formats: auto, plain, thousands-separated, currency, percent, scientific,
  date, time, datetime, plain-text — applied at display time, CSV exports the formatted text
- [x] A formatting toolbar (B / I / U, align, number-format menu, decimals ±, currency,
  percent, swatches for text/fill color) that targets the whole selection
- [x] Grid renders styles (weight, slant, alignment, colors) live

### A real date system + a much larger function library
- [x] Serial-date core (Excel-compatible 1899-12-30 epoch) shared by formatting + functions
- [x] Date/time: `TODAY NOW DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY
  EDATE EOMONTH DATEDIF DAYS DATEVALUE`
- [x] Conditional aggregates: `SUMIFS COUNTIFS AVERAGEIFS MAXIFS MINIFS AVERAGEIF`
- [x] Lookup: `XLOOKUP`, plus `SUMPRODUCT`
- [x] Stats: `VARP STDEVP MODE LARGE SMALL RANK PERCENTILE QUARTILE GEOMEAN`
- [x] Math: `MROUND EVEN ODD FACT COMBIN PERMUT SUMSQ CEILING.MATH`
- [x] Logic/util: `IFS SWITCH IFNA`
- [x] Text/regex: `TEXT SPLIT REGEXMATCH REGEXEXTRACT REGEXREPLACE NUMBERVALUE UNICHAR UNICODE`

### In-grid charts (beyond inline sparklines)
- [x] Insert a chart from the selected range; floating, draggable chart cards over the grid
- [x] Hand-built SVG renderer: line, column, bar, area, scatter, pie — axes, gridlines,
  labels, legend, multi-series (first row = headers, first column = category labels)
- [x] Charts persist (range + type + title) per sheet and recompute live as data changes

### Find & replace
- [x] `Ctrl+F` panel: find across the sheet (raw or values), match navigation, replace /
  replace-all over raw inputs (undoable)

### Polish
- [x] A fourth demo — a multi-sheet "Sales Dashboard" showing cross-sheet refs, names,
  formatting and a chart in one workbook
- [x] Keyboard map + help refreshed; status bar shows the active sheet

## Session log

- 2026-06-23 (claude): created Cellforge from the template. Built the full engine
  (address algebra -> lexer -> Pratt parser -> evaluator -> function library -> dependency-graph
  workbook with topological recalc & cycle detection), the virtualized keyboard-driven grid,
  formula bar, toolbar, inline sparklines, color-scale conditional formatting, CSV/clipboard
  I/O, sandbox-safe persistence, dependency inspector, three demo sheets, and an in-app
  self-test suite. Verified green (scope + conformance + lint + build).
- 2026-06-23 (claude): **v2 — Cellforge becomes a real workbook.** Planned and shipped the
  whole v2 roadmap above: a multi-sheet model with cross-sheet references and a single
  topological recalc spanning every sheet, defined names + a name manager, whole-workbook
  undo/redo, per-cell formatting with a formatting toolbar and an Excel-compatible serial-date
  system, ~70 new functions lifting the library to 136 (dates, SUMIFS-family, XLOOKUP, regex/text, more stats & math),
  hand-built draggable SVG charts (line/column/bar/area/scatter/pie), find & replace, sheet
  tabs, and a multi-sheet "Sales Dashboard" demo. The engine stays pure/React-free; the in-app
  self-test suite grew from 65 to 123 assertions. Gate green (scope + conformance + lint + build).
