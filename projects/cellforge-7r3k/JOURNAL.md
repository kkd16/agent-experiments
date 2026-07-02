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
  functions.ts         the function library (~230 fns: math … dynamic arrays … LAMBDA … regression)
  evaluator.ts         tree-walking evaluator: error propagation, array broadcasting, closures
  workbook.ts          the model: cells, dep graph, topo recalc, cycle detection, SPILL engine
  solver.ts            1-D root finder (secant + bisection) behind Goal Seek
  optimizer.ts         two-phase simplex + branch & bound + Nelder–Mead behind the Solver
  linalg.ts            dense linear algebra (LU, Householder QR) + OLS regression (the LINEST core)
  distributions.ts     special fns (incomplete Γ/Β, erf) + Normal/t/χ²/F distributions
  selftest.ts          assertions exercising every layer (290, runs in-app)
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

### Forward backlog (handled in v5 below)
- [x] A constrained multi-cell **Solver** (the other half of the v3 what-if backlog)
- [ ] **Structured table references** (`Table[Column]`) over a named data region
- [ ] `GROUPBY` totals/subtotals + `field_headers`, and a `filter_array` argument
- [ ] Persist the Data Table as a live array (re-runs on model edits) rather than a snapshot

## v5 — "from an analysis engine to an *optimization* engine" (this session)

v4 made the grid analytical. v5 makes it *prescriptive*: it doesn't just report what the
numbers are, it finds the numbers that are **best**. The marquee is a from-scratch,
genuinely-correct **Solver** — the multi-cell, constrained optimizer that was the last open
item of the v3 what-if backlog — backed by a real **two-phase simplex** for linear models
and a derivative-free **Nelder–Mead + penalty** search for nonlinear ones. Alongside it,
**structured table references** (`Table[Column]`) turn a named data region into a
self-describing table, and **GROUPBY/PIVOTBY** grow totals, headers and a filter argument.
The engine stays pure and React-free; the in-app self-test suite grows from 188 to **222**.

### The Solver — constrained multi-cell optimization *(the marquee)*
- [x] `src/engine/optimizer.ts` — a pure, React-free optimizer (knows nothing about
  spreadsheets, exactly like `solver.ts`), unit-tested in isolation:
  - [x] **`solveLP`** — an EXACT two-phase primal **simplex**. Handles ≤ / ≥ / = constraints
    and arbitrary lower/upper bounds (finite, one-sided, or free) by substituting onto the
    non-negative orthant; phase-1 drives out artificials, phase-2 optimizes the real
    objective, **Bland's rule** prevents cycling. Detects **infeasible** and **unbounded**.
  - [x] **`nelderMead`** — the downhill-simplex method (reflect / expand / contract / shrink).
  - [x] **`minimizeConstrained`** — a quadratic **penalty method** wrapped around Nelder–Mead
    with an escalating weight μ and **multi-start** (a deterministic mulberry32 RNG) to escape
    local minima. The GRG-Nonlinear / Evolutionary analogue, needing no gradients.
  - [x] **`optimize`** — the front door: the exact LP path when a linear extraction is
    supplied, else the nonlinear search; `'value'` goals minimize squared distance to a target.
- [x] **`Workbook.solve`** — wraps the optimizer around the *real* model: each candidate point
  sets the changing cells, recomputes the whole workbook, and reads the objective + constraint
  cells back (a memoized one-recompute-per-point sampler). It **auto-detects linearity** by
  probing the model at the origin and unit vectors, verifies the affine prediction at a fresh
  test point, and routes a linear model to the exact simplex (otherwise the nonlinear search).
  The workbook is fully **restored** before returning, so the caller decides whether to apply.
- [x] Constraints accept a literal or a **cell** as the right-hand side; a report says which
  constraints bind. RHS-as-cell models fold the dependence into the linear extraction too.
- [x] A **Solver dialog** (objective · Max/Min/Value · changing cells as refs or ranges · a
  dynamic constraint list with ≤/=/≥ · a "make non-negative" toggle) that shows the status,
  the method used (simplex *exact* vs nonlinear), the objective, every variable's value, and a
  per-constraint ✓/✗ report, then writes the solution back on "Keep solution".
- [x] New flagship **"Optimization Lab"** demo (now the default): a linear production-mix LP
  (solved exactly to chairs 24 / tables 14 / $2,200) **and** a nonlinear least-squares line fit
  the Solver minimizes to the exact OLS slope/intercept.
- [x] +12 `solver` self-tests (LP optimum + exactness, simplex-vs-Nelder-Mead routing, model
  restoration, a nonlinear constrained optimum, a value goal, infeasibility, an equality blend).
- [x] Verified end-to-end in a real browser: the LP returns the exact vertex (simplex, 2 iters,
  both resources binding) and the nonlinear fit recovers m≈1.93, b≈0.27 — no console errors.

### Structured table references — `Table[Column]`
- [x] A workbook **table registry**: a named rectangular region with a header row; serialized
  (and pruned when its sheet is deleted).
- [x] Lexer/parser/AST: the lexer reads a balanced `Name[…]` into one `tableref` token; the
  parser produces a `table` node for `Table[Column]`, `Table[#All]`, `Table[#Data]`,
  `Table[#Headers]`, `Table[#Totals]`, `Table[[Quoted Column]]`, and `Table[@Column]` (the
  *this-row* implicit intersection).
- [x] Evaluator resolves a table reference to the live matrix of the right region (a column is
  matched to its header case-insensitively; `@` outside the body → `#VALUE!`, an unknown column
  → `#REF!`); the dependency graph adds exactly the cells each selector reads (the `@` form
  depends only on the formula's own row) so edits recompute correctly.
- [x] A **Tables manager** dialog (define from the selection, list, jump-to the region, delete).
- [x] +11 `tables` self-tests; verified live in the Analysis Lab demo (`Σ Deals[Sales]` = 360).

### GROUPBY / PIVOTBY enhancements
- [x] `GROUPBY(row_fields, values, function, [sort_order], [field_headers], [total_depth], [filter_array])`
  — `field_headers` peels the inputs' first row off as labels and prepends a header row;
  `total_depth` adds a **grand-total** row (positive → top, negative → bottom); `filter_array`
  is a boolean column that selects source rows before grouping. `PIVOTBY` gains `field_headers`
  (with the row-field header as the corner label) and `filter_array`. Old call sites keep
  working — the new args slot in *after* `sort_order`. +11 `groupby` self-tests.

### Forward backlog (next sessions)
- [ ] Persist the Data Table as a live array (re-runs on model edits) rather than a snapshot
- [x] Solver: integer / binary variables (branch-and-bound) and sensitivity (shadow prices) → **shipped in v6**
- [ ] Structured refs across the full `Table[[#Data],[Col1]:[Col2]]` column-span syntax

## v6 — "the Solver grows up: integer programming + a sensitivity report" (this session)

v5 gave the grid a Solver that finds the *best* continuous answer. But two things every real
operations-research model needs were still missing. First, the world is **discrete**: you fund a
project or you don't, you build 3 trucks not 2.7. Second, an optimum is only half the story — a
decision-maker wants the **shadow prices**: *what is one more hour of labour actually worth?*
v6 ships both — plus an Excel-style report writer — building straight on the existing two-phase
simplex, and the engine stays pure / React-free with every claim re-derived in the in-app suite
(222 → **246**).

### Mixed-integer programming — branch & bound *(marquee #1)*
- [x] **`solveMILP(p, integer[])`** in `optimizer.ts` — classic LP-based **branch & bound**:
  solve the continuous relaxation; if an integer variable comes back fractional, branch into two
  subproblems (`xⱼ ≤ ⌊xⱼ⌋` and `xⱼ ≥ ⌈xⱼ⌉`) by tightening that variable's bounds and recursing.
  An incumbent integer solution **prunes** any subtree whose relaxation can't beat it (the
  "bound"), so the exponential lattice is never enumerated in full. Most-fractional branching with
  a depth-first stack keeps memory flat and finds incumbents fast; a node cap (`feasible` vs
  `optimal`) backstops pathological trees. Reports nodes explored.
- [x] **Binary variables** are integers boxed to `[0, 1]`; **integer variables** keep their bounds.
  Detects integer-infeasible models (e.g. `2a = 3` over ℤ) and unbounded relaxations.
- [x] Wired through `optimize` (a linear model with any integer flag routes to `solveMILP`) and
  **`Workbook.solve`** (a new `integers` / `binaries` coord list maps onto variable indices, sets
  the binary box, and echoes node count + integrality back). The Solver dialog grows two new
  constraint relations — **`int`** and **`bin`** — whose LHS is a cell *list/range* of changing
  cells (RHS disabled), and reports "branch & bound (exact MILP) · N nodes".
- [x] Flagship **"Integer Programming Lab"** demo (now the default): a 0/1 **capital-budgeting
  knapsack** — pick which projects to fund to maximise value under a budget — beside the carpenter
  LP. The branch & bound finds the exact best subset where the fractional LP relaxation can't.

### Post-optimal sensitivity — the shadow-price report *(marquee #2)*
- [x] **`solveLPFull(p)`** returns the LP optimum **plus a sensitivity report**, read straight off
  the optimal simplex tableau: the **dual / shadow price** of each constraint is `±` the reduced
  cost of its slack (≤), surplus (≥) or artificial (=) column, mapped back through the variable
  substitution and the max/min sense to give `∂z/∂bᵢ`; **reduced costs** for the (clean,
  lower-bounded) variables come the same way.
- [x] **RHS ranging** and **objective-coefficient ranging** — the intervals over which a shadow
  price (resp. the optimal basis) stays put — are found by a robust **parametric re-solve**: walk
  the parameter out by geometric steps until the dual (resp. the variable's optimal value) breaks,
  then bisect the kink. Skipped for big models; exact for the rest.
- [x] `Workbook.solve` maps the report onto cell coordinates (`SolverSensitivity`) and the Solver
  dialog renders a collapsible **Sensitivity report**: per-variable (value · reduced cost · obj
  coefficient · allowable range) and per-constraint (shadow price · allowable increase/decrease),
  with `∞` for open directions. Only shown for pure-continuous models (Excel disables it for MILP).
- [x] **`Workbook.writeSolverReport`** — a "Report ▸ sheet" button spills an Excel-style **Answer +
  Sensitivity report** into a brand-new sheet (status/method/nodes, the decision cells, a
  per-constraint status table with slacks, and the full sensitivity tables), as static literals.

### Proving it — the house way
- [x] +24 self-tests (`solver` 12 → **36**): a 0/1 knapsack to its exact optimum (220, integral,
  branch & bound, nodes counted); an ILP whose integer optimum (33 at `(0,3)`) is **not** the
  rounded LP relaxation; an integer-infeasible model; the carpenter LP's shadow prices
  (wood = 1, labour = 4) with **strong duality** (`z = b·y`), zero reduced cost for basic
  variables, a **finite-difference cross-check** of the shadow price, and a check the shadow price
  holds across its reported RHS range; an unprofitable product staying out with a **negative
  reduced cost** and a non-binding constraint reading **shadow price 0**; and the report writer
  carrying the objective, decision values and shadow prices into a new sheet's cells.
- [x] Validated outside the browser too: an isolated harness over `solveLP`/`solveLPFull`/`solveMILP`
  cross-checked shadow prices vs finite differences, strong duality, and **40 random MILPs against
  brute-force enumeration** (all matched). Then verified end-to-end in a **real browser** (Playwright):
  the knapsack solves to $1.3M via branch & bound (21 nodes) and the carpenter LP's Sensitivity
  report prints the exact textbook shadow prices and ranges — no console errors.

### Forward backlog (next sessions)
- [ ] **Gomory fractional cuts** / branch-and-**cut** to tighten the relaxation before branching
- [ ] **Objective ranging for basic variables** read exactly off the tableau (alongside the re-solve)
- [x] A **written-to-sheet** sensitivity report (spill the dual table into the grid like a pivot) → shipped
- [ ] Let the report **link back** to the model with live formulas (today it's a static snapshot)
- [ ] **Special-ordered-set** (SOS1/SOS2) and **semi-continuous** variable branching rules
- [ ] **Integer Data Table** / scenario sweep that re-runs the MILP across a parameter
- [ ] **Warm-start** the child LPs from the parent basis (dual simplex) for far fewer iterations

## v7 — "from an optimization engine to a *statistics & linear-algebra* engine" (this session)

v6 made the grid prescriptive (it finds the *best* numbers). v7 makes it *inferential and
analytical in the textbook sense*: it fits models to data, quantifies the uncertainty, and does
real matrix algebra. The marquee is a from-scratch, genuinely-correct **regression engine** —
`LINEST` returns the complete Excel statistics block (coefficients, standard errors, R², the
standard error of the estimate, the F statistic, the residual degrees of freedom, and the
regression/residual sums of squares), all read off the *same* numerically-stable **Householder
QR** decomposition used to solve the least-squares system. Alongside it: a dense **linear-algebra
core** (`MMULT`/`MINVERSE`/`MDETERM`/`MUNIT` over LU with partial pivoting) and a full set of
**statistical distributions** (Normal, Student's t, χ², Fisher's F — each with CDF, PDF and
inverse) built on hand-rolled incomplete gamma/beta functions. Two new pure, React-free modules
(`linalg.ts`, `distributions.ts`) join the family; the in-app self-test suite grows 246 → **290**,
every value cross-checked against the known textbook answer.

### A real regression engine — `LINEST` & friends *(the marquee)*
- [x] `src/engine/linalg.ts` — a pure, React-free numerical core, unit-tested in isolation:
  - [x] dense ops: `matMul`, `transpose`, `identity`
  - [x] **LU with partial pivoting** → `determinant`, `inverse`, `solve` (singular-aware)
  - [x] a thin **Householder QR** → `lstsq`, a numerically-stable least-squares solver
  - [x] **`regress`** — ordinary least squares returning coefficients **and** the full LINEST
    statistics block; the coefficient covariance is `σ²·R⁻¹R⁻ᵀ` read straight off the QR factor R
- [x] **`LINEST(known_ys, [known_xs], [const], [stats])`** — multiple linear regression that
  *spills* a single coefficient row, or the full 5-row stats block, in Excel's reversed-`m` order
  with `#N/A` padding — exactly matching Excel's layout. Infers row/column orientation; an omitted
  `known_xs` defaults to `{1,2,…,n}`; `const = FALSE` forces a zero intercept.
- [x] **`TREND`** / **`FORECAST.LINEAR`** (predict from a fitted line) and **`LOGEST`** /
  **`GROWTH`** (the exponential-model analogues, fit on `ln y`).
- [x] Simple-regression scalars: `SLOPE`, `INTERCEPT`, `RSQ`, `CORREL` (= `PEARSON`), `STEYX`,
  `COVARIANCE.P`/`.S` (= `COVAR`), `DEVSQ`, `SKEW`/`SKEW.P`, `KURT`, `FISHER`/`FISHERINV`.

### Dense matrix algebra
- [x] `MMULT` (dimension-checked), `MINVERSE` (singular → `#NUM!`, non-square → `#VALUE!`),
  `MDETERM`, `MUNIT(n)` — all returning matrices that spill, so `=MMULT(MINVERSE(A),b)` solves a
  linear system live in the grid.

### Statistical distributions
- [x] `src/engine/distributions.ts` — hand-rolled **log-gamma** (Lanczos), **regularized
  incomplete gamma** (series + continued fraction) and **incomplete beta**, and the **error
  function**, all accurate to ~1e-12; robust monotone inverters for the inverse CDFs.
- [x] **Normal**: `NORM.DIST`, `NORM.S.DIST`, `NORM.INV`, `NORM.S.INV`, `PHI`, `GAUSS`,
  `CONFIDENCE.NORM`/`.T` (+ legacy `NORMDIST`/`NORMSDIST`/`NORMINV`/`NORMSINV`/`CONFIDENCE`).
- [x] **Student's t**: `T.DIST`, `T.DIST.RT`, `T.DIST.2T`, `T.INV`, `T.INV.2T` (+ legacy `TDIST`/`TINV`).
- [x] **chi-square**: `CHISQ.DIST`, `CHISQ.DIST.RT`, `CHISQ.INV`, `CHISQ.INV.RT` (+ legacy `CHIDIST`/`CHIINV`).
- [x] **Fisher's F**: `F.DIST`, `F.DIST.RT`, `F.INV`, `F.INV.RT` (+ legacy `FDIST`/`FINV`).
- [x] Special functions: `GAMMA`, `GAMMALN`(`.PRECISE`), `ERF` (one- and two-arg), `ERFC`.

### Demo + tests
- [x] New flagship **"Statistics Lab"** demo (now the default): a live **multiple regression**
  (`LINEST` spilling the full stats block, with `TREND` forecasts beyond the data and a scatter
  chart), a real **one-sample t-test** (t statistic → two-tailed p via `T.DIST.2T`, a 95% CI via
  `CONFIDENCE.T`, and a reject/can't-reject verdict), and a **3×3 linear system** solved with
  `MINVERSE`/`MMULT` to the exact `(1, 2, 3)`.
- [x] +44 self-tests across `linalg` (10), `regression` (18) and `dist` (16) — 246 → **290**:
  MMULT·MINVERSE = I, MDETERM of a singular matrix = 0, simple & multiple regression recovered
  exactly (`y = 1 + 2x₁ + 3x₂`), the LINEST stats block (R² 0.996709, F 908.5122, SE, df, SS), and
  every distribution checked against its textbook value (NORM.S.INV(0.975)=1.95996, T.INV.2T,
  CHISQ.INV.RT, F.INV.RT, GAMMA(½)=√π, ERF(1)) plus round-trip inverses.
- [x] Validated outside the browser too: an isolated tsx harness cross-checked all 26 core numerics
  against known reference values (erf, the four distribution CDFs/inverses, gamma, LU det/inverse,
  QR regression coefficients & standard errors) before a single self-test was written.

### Forward backlog (next sessions)
- [ ] A **Regression / Data-Analysis dialog** (pick y & x ranges → drop a labelled LINEST block + a
  residual plot), the natural UI marquee on top of this engine
- [x] Polynomial / weighted regression helpers and **prediction intervals** for `TREND`/`FORECAST`
  → prediction-interval band shipped in the Inference Lab demo (STEYX · leverage · T.INV)
- [x] Eigenvalues & SVD (a QR-algorithm iteration on the existing Householder core)
- [x] Two-sample / paired **`T.TEST`**, **`Z.TEST`**, **`F.TEST`**, **`CHISQ.TEST`** and an ANOVA
- [x] Trendlines on scatter charts (fit with `regress`, draw the line + R² on the SVG renderer)

## v8 — inferential statistics + spectral linear algebra (planned this session)

The v7 forward backlog named eigenvalues/SVD, the four hypothesis tests, trendlines and
prediction intervals. v8 ships all of them: a spectral layer bolted onto the existing
Householder/LU core, the inferential-statistics functions that turn the v7 distribution CDFs
into real decisions, an "Inference Lab" flagship demo, and OLS trendlines on the SVG charts.
Everything stays pure/React-free in `src/engine/` and is cross-checked in the in-app self-test
suite plus an isolated Node harness before wiring, in the house style.

### Engine — spectral linear algebra (`linalg.ts`)
- [x] **Symmetric eigendecomposition** — cyclic **Jacobi rotations** to `A = QΛQᵀ`: real
  eigenvalues + an orthonormal eigenvector basis, unconditionally convergent for symmetric input.
- [x] **Singular Value Decomposition** — **one-sided Jacobi** on the columns → `U`, `Σ`, `V` for
  any m×n (tall or wide), singular values non-negative and descending.
- [x] **General real eigenvalues** — **Hessenberg reduction + Francis double-shift QR** to the real
  Schur form; 1×1 blocks give real eigenvalues, 2×2 blocks give complex-conjugate pairs.
- [x] Derived from the above: numerical **rank** (σ tolerance), the **2-norm** and **condition
  number** (σ_max/σ_min), the **Moore–Penrose pseudo-inverse** `A⁺ = VΣ⁺Uᵀ`, and the Frobenius /
  1 / ∞ matrix norms.

### Functions (`functions.ts`)
- [x] **`EIGVALS(A)`** — eigenvalues: a real descending column for a symmetric matrix, an n×2
  `[re, im]` block for a general one (via the QR algorithm).
- [x] **`EIGVECS(A)`** — the orthonormal eigenvectors of a symmetric matrix (one per column, aligned
  with `EIGVALS`).
- [x] **`SVDVALS(A)`** — the singular values (descending column).
- [x] **`MPINV(A)`** — the Moore–Penrose pseudo-inverse (the exact least-squares solver for any
  shape/rank).
- [x] **`MRANK(A)`**, **`MCOND(A)`**, **`MNORM(A,[type])`** — numerical rank, 2-norm condition
  number, and the 2 / 1 / inf / Frobenius norms.
- [x] **`T.TEST`/`TTEST`** — paired (1), two-sample equal-variance/pooled (2), and two-sample
  unequal-variance/Welch (3), returning the 1- or 2-tailed p-value (exact Excel semantics).
- [x] **`Z.TEST`/`ZTEST`** — the one-sample right-tail z probability with a known or sample σ.
- [x] **`F.TEST`/`FTEST`** — the two-tailed variance-ratio p-value.
- [x] **`CHISQ.TEST`/`CHITEST`** — Pearson's χ² from an observed vs expected table, df from the
  table shape, returning the upper-tail p-value.

### Demo + charts
- [x] New flagship **"Inference Lab"** demo (default): a two-sample Welch **T.TEST** beside the
  pooled variant, a **paired** T.TEST, an **F.TEST** for equal variances gating the pooled test,
  a **Z.TEST**, and a **χ² test of independence** on a 2×3 contingency table — each with a p-value
  and a reject/can't-reject verdict; a **spectral block** (symmetric eigenvalues + eigenvectors,
  singular values, rank, condition number, and a rank-deficient least-squares solve via `MPINV`);
  and a **prediction-interval band** around a `TREND` forecast (STEYX · leverage · `T.INV`).
- [x] **Trendlines** — an optional OLS fit line + R² label on line/scatter charts (`chart.ts`
  spec flag, drawn in `ChartView.tsx`, toggled from the chart toolbar in `ChartLayer.tsx`).

### Tests
- [x] New `spectral` + `inference` self-test sections cross-checking: Jacobi eigenvalues vs the
  2×2/3×3 characteristic polynomial and known matrices, `A = QΛQᵀ` reconstruction and eigenvector
  orthonormality, SVD reconstruction `A = UΣVᵀ` and σ = √eig(AᵀA), the pseudo-inverse identities
  (`A A⁺ A = A`, `MPINV` least-squares = `LINEST`), rank/condition on singular and well-conditioned
  matrices, general QR eigenvalues agreeing with Jacobi on symmetric input and giving a rotation's
  `e^{±iθ}`, and every hypothesis test against its hand-computed / Excel-documented value.
- [x] Re-validated the spectral numerics outside the browser in an isolated Node harness before
  wiring (Jacobi/SVD/QR-eig reconstruction, orthogonality, pinv identities) — the house rule.

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
- 2026-06-26 (claude): **v5 — an optimization engine.** Planned and shipped the whole v5
  roadmap above. Marquee: a from-scratch, genuinely-correct **Solver** — the constrained
  multi-cell optimizer that was the last open item of the v3 what-if backlog. New pure
  `optimizer.ts` carries an EXACT **two-phase primal simplex** (≤/≥/= constraints, finite/
  one-sided/free bounds, Bland's rule, infeasible/unbounded detection) and a derivative-free
  **Nelder–Mead + quadratic-penalty + multi-start** search for nonlinear models; `Workbook.solve`
  wraps either around the *real* model (set cells → recompute → read back, memoized),
  **auto-detects linearity** by probing, routes a linear model to the exact simplex, and
  restores the workbook before returning. A Solver dialog (Max/Min/Value · changing cells ·
  a constraint editor · non-negativity toggle) reports the method, objective, variable values
  and a per-constraint ✓/✗; new flagship **"Optimization Lab"** demo (now default) with a
  linear production-mix LP and a nonlinear least-squares fit. Also shipped **structured table
  references** (`Sales[Amount]`, `[#All]`, `[#Headers]`, `[@Column]`) end-to-end through the
  lexer/parser/evaluator/graph with a Tables manager, and **GROUPBY/PIVOTBY** `field_headers`,
  `total_depth` (grand totals) and `filter_array` arguments. The in-app self-test suite grew
  188 → **222** (+12 `solver`, +11 `tables`, +11 `groupby`). Verified end-to-end in a real
  browser: the LP solves to the exact vertex (chairs 24 / tables 14 / $2,200, simplex, both
  resources binding), the nonlinear fit recovers the exact OLS line (m≈1.93, b≈0.27), and the
  `Deals[Sales]` table sum reads 360 — no console errors. Gate green (scope + conformance +
  lint + build).
- 2026-06-26 (claude): **v6 — integer programming + a sensitivity report.** Planned and shipped
  the whole v6 roadmap above, building on v5's simplex. Marquee #1: **mixed-integer programming**
  — `solveMILP` is LP-based **branch & bound** (relax → branch on a fractional integer var by
  tightening its bounds → prune any subtree that can't beat the incumbent), with binary variables
  as `[0,1]` integers, integer-infeasible / unbounded detection, most-fractional branching, a
  depth-first stack and a node cap. Wired through `optimize` and `Workbook.solve` (new
  `integers`/`binaries` coord lists; node count + integrality echoed back) and two new Solver
  constraint relations **`int`** / **`bin`** that take a range of changing cells. Marquee #2:
  **post-optimal sensitivity** — `solveLPFull` reads the **shadow prices** straight off the
  optimal tableau (`±` reduced cost of each constraint's slack/surplus/artificial column, mapped
  back through the variable substitution and the max/min sense to `∂z/∂b`), the **reduced costs**
  of the variables, and **RHS / objective-coefficient ranges** by a robust parametric re-solve
  (walk-out + bisect the kink). `Workbook.solve` maps it onto cells; the Solver dialog renders a
  collapsible **Sensitivity report** (per-variable value/reduced-cost/coef/range, per-constraint
  shadow-price/allowable-increase/decrease) — shown only for pure-continuous models. A
  "Report ▸ sheet" button (`writeSolverReport`) spills an Excel-style Answer + Sensitivity report
  into a brand-new sheet. New flagship
  **"Integer Programming Lab"** demo (now default): a 0/1 capital-budgeting knapsack beside the
  carpenter LP. The suite grew 222 → **246** (`solver` 12 → 36): a knapsack to its exact integral
  optimum, an ILP whose integer optimum ≠ the rounded relaxation, integer-infeasibility, the
  carpenter shadow prices (wood 1 / labour 4) with strong duality `z=b·y`, a finite-difference
  cross-check, zero reduced cost for basic vars, a negative reduced cost for an idle product, a
  non-binding constraint reading shadow price 0, and the report writer carrying answers into a
  sheet. Validated in an isolated Node harness (shadow
  prices vs finite differences, strong duality, **40 random MILPs vs brute force**) and end-to-end
  in a real browser (Playwright): the knapsack solves to $1.3M via branch & bound (21 nodes) and
  the carpenter Sensitivity report prints the exact textbook shadow prices and ranges — no console
  errors. Gate green (scope + conformance + lint + build).
- 2026-06-28 (claude): **v7 — a statistics & linear-algebra engine.** Planned and shipped the whole
  v7 roadmap above. Two new pure, React-free modules: `linalg.ts` (dense ops, **LU with partial
  pivoting** → determinant/inverse/solve, a thin **Householder QR** → a stable least-squares solver,
  and an OLS **`regress`** that returns coefficients *plus* the full statistics block, its covariance
  read off the QR factor R) and `distributions.ts` (hand-rolled **log-gamma**, **regularized
  incomplete gamma & beta**, **erf**, and the **Normal / Student-t / χ² / F** distributions with CDF,
  PDF and inverse). Wired ~60 new functions into the library (now ~230): the marquee **`LINEST`**
  (multiple regression spilling Excel's exact 5-row stats block in reversed-`m` order with `#N/A`
  padding), `TREND`/`FORECAST`/`LOGEST`/`GROWTH`, the simple-regression scalars
  (`SLOPE`/`INTERCEPT`/`RSQ`/`CORREL`/`STEYX`/`COVARIANCE.*`/`DEVSQ`/`SKEW`/`KURT`/`FISHER`), dense
  matrix algebra (`MMULT`/`MINVERSE`/`MDETERM`/`MUNIT`), and the full distribution family
  (`NORM.*`, `T.*`, `CHISQ.*`, `F.*`, `CONFIDENCE.*`, `GAMMA`/`GAMMALN`/`ERF`) with their legacy
  aliases. New flagship **"Statistics Lab"** demo (now default): a live multiple regression with a
  spilling LINEST block + TREND forecasts + a scatter chart, a one-sample t-test (t → two-tailed p
  via `T.DIST.2T`, 95% CI via `CONFIDENCE.T`), and a 3×3 system solved with `MINVERSE`/`MMULT` to the
  exact `(1, 2, 3)`. The in-app self-test suite grew 246 → **290** (+10 `linalg`, +18 `regression`,
  +16 `dist`), every value cross-checked against the textbook answer; also validated in an isolated
  tsx harness (26 core numerics vs known references) before wiring. Gate green (scope + conformance +
  lint + build).
- 2026-07-02 (claude): **v8 — inferential statistics + a spectral linear-algebra layer.** Planned
  and shipped the whole v8 roadmap above, clearing the v7 forward backlog (eigenvalues/SVD, the four
  hypothesis tests, trendlines, prediction intervals). **Spectral core** (added to `linalg.ts`,
  still pure/React-free): a symmetric **Jacobi eigendecomposition** (`A = QΛQᵀ`, real eigenvalues +
  an orthonormal eigenvector basis), a **one-sided-Jacobi SVD** for any shape, a **general
  eigenvalue** path (Faddeev–LeVerrier characteristic polynomial → Durand–Kerner roots, returning
  complex-conjugate pairs), and everything they unlock — numerical **rank**, the **2-norm** and its
  **condition number**, the Frobenius/1/∞ norms, and the **Moore–Penrose pseudo-inverse**
  `A⁺ = VΣ⁺Uᵀ`. Wired **7 spectral functions** (`EIGVALS` — real column for symmetric, n×2 `[re,im]`
  for general; `EIGVECS`, `SVDVALS`, `MPINV`, `MRANK`, `MCOND`, `MNORM`) and **the four hypothesis
  tests** — `T.TEST`/`TTEST` (paired / pooled / Welch), `Z.TEST`/`ZTEST`, `F.TEST`/`FTEST`,
  `CHISQ.TEST`/`CHITEST` — turning the v7 distribution CDFs into real decisions with exact Excel
  semantics (library now ~245 fns). Added **OLS trendlines** to the SVG charts: a `trendline` flag
  on `ChartSpec`, a pure `trendFit` (slope/intercept/R²) in `chart.ts`, a dashed fit line + R² label
  drawn in `ChartView` for line/area/scatter, and a **T** toggle in the chart toolbar. New flagship
  **"Inference Lab"** demo (now default): an F-test gating a pooled-vs-Welch two-sample **T.TEST**,
  a **paired** T.TEST, a **χ² test of independence** on a 2×3 table with expected counts built from
  the margins, the **spectral block** (eigenvalues + eigenvectors + singular values + rank +
  condition number of a symmetric matrix) and a rank-flexible **MPINV** least-squares fit, plus a
  **95% prediction-interval** band (STEYX · leverage · `T.INV`) and a scatter chart with the live
  OLS trendline. The in-app self-test suite grew **290 → 330** (+26 `spectral`, +14 `inference`):
  eigenvalues cross-checked against the characteristic polynomial, `ΣΠλ` = trace/det, `QᵀQ = I` and
  the eigen-equation `A·v = λ·v`, `σ = √λ(AᵀA)`, the pseudo-inverse identities and its agreement with
  `SLOPE`, rank/cond on singular vs well-conditioned matrices, a rotation's complex `e^{±iθ}`, and
  every test against its Excel-documented value (paired **T.TEST = 0.196016**, **F.TEST = 0.648318**,
  **Z.TEST = 0.090574**, χ² df logic against `CHISQ.DIST.RT`). Re-validated the spectral numerics
  first in an isolated Node harness (43 reconstruction/orthogonality/pinv checks), then end-to-end in
  a headless Chromium: the Inference Lab paints with **zero error cells**, the self-test panel reads
  **330/330 passing**, and the chart draws its dashed trendline at **R² = 0.997** — no app console
  errors. Gate green (scope + conformance + lint + build).
