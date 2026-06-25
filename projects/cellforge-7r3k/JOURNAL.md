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
  values.ts            CellValue lattice (number|string|bool|error|matrix|lambda) + coercion
  lexer.ts             hand-written tokenizer for the formula grammar
  ast.ts               AST node types (union, no classes) — incl. apply (lambda call)
  parser.ts            Pratt / precedence-climbing parser -> AST, postfix application
  functions.ts         the function library (~190 fns: math … dynamic arrays … LAMBDA)
  evaluator.ts         tree-walking evaluator: error propagation, array broadcasting, closures
  workbook.ts          the model: cells, dep graph, topo recalc, cycle detection, SPILL engine
  solver.ts            1-D root finder (secant + bisection) behind Goal Seek
  selftest.ts          assertions exercising every layer (159, runs in-app)
src/components/        ← React, presentational
  Grid (+ spill outline), FormulaBar, Toolbar, Inspector, SelfTestPanel, Sparkline,
  SheetTabs, ChartLayer/View, NameManager, FindReplace, FormatBar, GoalSeek
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

## v3 — "from a spreadsheet to a *programmable* spreadsheet" (this session)

v2 was a real workbook. v3 brings the three ideas that define a *modern* spreadsheet:
results that **spill** out of one cell into a region, a **functional layer** (LAMBDA +
higher-order functions) so the grid becomes programmable, and **what-if analysis**
(Goal Seek) that solves the model backwards. Everything stays in the pure, React-free
engine; the in-app self-test suite grows from 123 to **159** assertions.

### Dynamic arrays + spilling *(the marquee feature)*
- [x] New `#SPILL!` / `#CALC!` error codes in the value lattice
- [x] The recompute engine spills a formula's matrix result into the cells below/right of
  its anchor; the anchor holds the top-left value, the rest are "spilled-into" cells
- [x] Obstruction detection: a value (or another array) in the path → `#SPILL!`, with the
  whole array re-appearing the instant the obstruction clears
- [x] Spilled-into cells are first-class **readable** by other formulas — the recalc injects
  anchor→reader dependency edges and runs to a fixpoint so topological order stays correct
- [x] Off-the-edge guard (an array that won't fit the sheet errors instead of truncating)
- [x] `Workbook.spillInfo()` exposes anchor / region membership to the UI
- [x] The grid tints spilled cells, marks the anchor with a corner tab, and frames the active
  array with the signature blue **spill outline**; the status bar names the array / its source
- [x] Implicit **array broadcasting** in every binary operator (`A1:A9 > 6` → a boolean array)
  — the backbone of FILTER; mismatched shapes pad with `#N/A`, exactly like Excel

### Dynamic-array function family
- [x] Generators: `SEQUENCE`, `RANDARRAY`
- [x] Query: `UNIQUE` (by row/col, exactly-once), `SORT`, `SORTBY`, `FILTER`
- [x] Shape: `TRANSPOSE`, `HSTACK`, `VSTACK`, `TOROW`, `TOCOL`, `TAKE`, `DROP`, `EXPAND`,
  `CHOOSEROWS`, `CHOOSECOLS`, `ROWS`, `COLUMNS`, `FREQUENCY`

### LAMBDA — a real functional layer
- [x] First-class `LambdaValue` (params + body + captured closure) in the value lattice
- [x] `LAMBDA(p…, body)` builds a closure; lexical bindings shadow workbook names
- [x] Call a lambda three ways: bound to a name, bound by `LET`, or applied inline
  (`=LAMBDA(x, x*x)(7)`) via a new postfix-application AST node
- [x] `LET(name, value, …, expr)` for readable local bindings (each sees the prior ones)
- [x] Higher-order: `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL`, `MAKEARRAY`

### What-if analysis — Goal Seek
- [x] `solver.ts`: a black-box 1-D root finder — secant iteration with a bracketing +
  bisection fallback for non-smooth targets — fully unit-tested in isolation
- [x] `Workbook.goalSeek(target, value, changing)` drives it over real recalcs, then restores
  the model so the caller decides whether to apply
- [x] A Goal Seek dialog (set cell · to value · by changing cell) with solve/apply, jump-to-cell

### Demo + tests
- [x] A new flagship **"Dynamic Arrays"** demo: SEQUENCE/MAP/REDUCE, a dataset queried live
  with UNIQUE/SORT/FILTER, a LET summary, and a break-even model wired for Goal Seek
- [x] +36 self-tests across `array`, `lambda`, `spill`, `goalseek` groups (123 → 159)

### Forward backlog (handled in v4 below)
- [x] Spilled-range reference operator (`A1#`) so formulas can name a whole dynamic array
- [x] `WRAPROWS`/`WRAPCOLS`, multi-key `SORTBY`, `XMATCH`, `GROUPBY`/`PIVOTBY`
- [x] A Data Table (one/two-variable what-if grid) and a Solver (multi-cell, constrained) — *Data Table shipped; multi-cell Solver still open*
- [x] A pivot-table builder over a range; structured table references — *pivot builder shipped; structured table refs still open*
- [x] Recursive lambdas with a depth guard (e.g. a from-scratch `FACT` via self-reference)

## v4 — "from a programmable spreadsheet to an analysis engine" (this session)

v3 made the grid programmable. v4 makes it *analytical*: results that whole formulas
can name (`A1#`), one-formula **pivot tables** (`GROUPBY`/`PIVOTBY`), functions you can
pass **by name** to higher-order operators, **recursive** lambdas, and two new what-if
tools (a **Pivot Table builder** and a **Data Table**). The engine stays pure and
React-free; the in-app self-test suite grows from 162 to **188** sub-assertions.

### Spilled-range references — `A1#` *(marquee engine feature)*
- [x] Lexer emits a context-sensitive `#` (spill) operator only right after a reference,
  so `A1#` parses while `#REF!` error literals still lex unchanged
- [x] New `spillref` AST node; parser produces it; `collectRefs`/`collectPrecedents` make
  the reader depend on the array's anchor so it is ordered after the array is committed
- [x] Evaluator resolves `A1#` to the matrix of the live dynamic array via a new
  `getSpillRange` context hook; `#REF!` when the anchor isn't a spilling array
- [x] Workbook publishes the in-progress spill regions during the eval pass so a reader
  sees the array the instant its anchor has spilled; `=A1#` itself re-spills as a live alias
- [x] Fill/paste rewriting preserves `#` verbatim; self-tests cover sum/rows/resize/alias

### One-formula pivots — `GROUPBY` / `PIVOTBY`
- [x] `GROUPBY(row_fields, values, function, [sort_order])` collapses rows by a key tuple,
  aggregating every value column; default ascending-by-key, `sort_order < 0` descending
- [x] `PIVOTBY(row_fields, col_fields, values, function, [sort_order])` builds a 2-D pivot
  with a header row of column keys and a leading column of row keys
- [x] Both accept a real `LAMBDA` **or** an eta-reduced builtin (`SUM`, `AVERAGE`, …)

### Eta-reduced function references + recursive lambdas
- [x] A bare builtin name (`SUM`) evaluates to a first-class lambda, so functions can be
  passed by name to `GROUPBY`/`PIVOTBY`/`BYROW`/`MAP` — `=SUM(BYROW(rng, SUM))`
- [x] Recursive lambdas via defined names (`FACT`, `FIB`) now resolve and recurse, bounded
  by a `MAX_LAMBDA_DEPTH` guard that returns `#NUM!` instead of overflowing the stack

### More array functions
- [x] Multi-key `SORTBY(array, by1, [order1], by2, [order2], …)` with per-key direction
- [x] `XMATCH(lookup, array, [match_mode], [search_mode])` — exact / next-smaller /
  next-larger / wildcard, searched first→last or last→first
- [x] `WRAPROWS` / `WRAPCOLS` — fold a vector into a 2-D grid with a pad value

### What-if tooling (UI)
- [x] **Pivot Table builder**: map each field to Rows / Columns / Values, pick an
  aggregate, and Cellforge writes a single spilling `GROUPBY`/`PIVOTBY` — a *live* pivot
- [x] **Data Table**: a one- or two-variable sensitivity grid; `Workbook.computeDataTable`
  sweeps the input cell(s) over real recalcs and materializes the answers
- [x] New flagship **"Analysis Lab"** demo (now the default) tying pivots, the `A1#` grand
  total, recursive lambdas, `XMATCH` and a Data-Table-ready profit model into one sheet
- [x] +26 self-tests across `groupby`, `xmatch`, `array2`, `spillref`, `recursion` (162 → 188)

### Forward backlog (next sessions)
- [ ] A constrained multi-cell **Solver** (the other half of the v3 what-if backlog)
- [ ] **Structured table references** (`Table[Column]`) over a named data region
- [ ] `GROUPBY` totals/subtotals + `field_headers`, and a `filter_array` argument
- [ ] Persist the Data Table as a live array (re-runs on model edits) rather than a snapshot

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
- 2026-06-24 (claude): **v3 — a programmable spreadsheet.** Planned and shipped the whole v3
  roadmap above. Marquee: **dynamic arrays** — a formula's matrix result now *spills* into a
  region (anchor + spilled cells, `#SPILL!` on obstruction, a fixpoint recalc that keeps
  spilled-into cells readable by other formulas, and a blue spill outline in the grid). Added
  implicit **array broadcasting** to every operator, ~25 array functions (SEQUENCE, UNIQUE,
  SORT, FILTER, HSTACK/VSTACK, TAKE/DROP, CHOOSEROWS/COLS, FREQUENCY, …), a full **LAMBDA**
  layer (closures, `LET`, inline application `LAMBDA(x,x)(5)`, and MAP/REDUCE/SCAN/BYROW/
  BYCOL/MAKEARRAY), and **Goal Seek** (a from-scratch secant+bisection solver in `solver.ts`
  driven over real recalcs, with a dialog). New "Dynamic Arrays" demo. The library passed ~190
  functions; the self-test suite grew 123 → 159. Gate green (scope + conformance + lint + build).
- 2026-06-25 (claude): **v4 — an analysis engine.** Planned and shipped the whole v4 roadmap
  above. Marquee: **spilled-range references** (`A1#`) — a new context-sensitive `#` operator,
  a `spillref` AST node, and a `getSpillRange` eval hook let a formula name a whole live dynamic
  array (`=SUM(A1#)`), with the workbook publishing in-progress spill regions mid-pass so the
  reader is always ordered after the array commits. Added one-formula **pivots** (`GROUPBY`,
  `PIVOTBY`), **eta-reduced function references** (pass `SUM` by name to `BYROW`/`GROUPBY`),
  **recursive lambdas** via defined names bounded by a depth guard (`FACT`, `FIB` → `#NUM!` on
  runaway), and new array functions (multi-key `SORTBY`, `XMATCH`, `WRAPROWS`/`WRAPCOLS`). Two
  new what-if tools: a **Pivot Table builder** (field → Rows/Cols/Values → a live spilling
  pivot) and a **Data Table** (`Workbook.computeDataTable` sweeps one/two inputs over real
  recalcs). New flagship **"Analysis Lab"** demo (now default). The in-app self-test suite grew
  162 → 188; verified end-to-end in a real browser (pivot East=18/West=27, no console errors).
  Gate green (scope + conformance + lint + build).
