# SatForge — journal

A from-scratch **CDCL SAT solver** (Conflict-Driven Clause Learning) written in TypeScript,
wrapped in an interactive studio that lets you encode classic combinatorial problems, solve
them, and *watch the solver think* — implication graphs, learnt clauses, restarts and all.

This is the app's long-lived memory. Read it first when picking the project back up.

## Why this is interesting

Modern SAT solvers are one of computer science's quiet triumphs: the same engine that decides
a Sudoku in milliseconds verifies hardware, plans logistics, and proves theorems. SatForge
implements the real algorithm — not a toy DPLL — so you can see *why* it is fast: how a single
conflict teaches the solver a new clause that prunes an exponential swath of the search space.

## Architecture

- `src/sat/cnf.ts` — CNF model, tolerant DIMACS parser/serializer, model verifier.
- `src/sat/heap.ts` — binary max-heap variable order (powers VSIDS).
- `src/sat/luby.ts` — Luby restart sequence.
- `src/sat/solver.ts` — the CDCL engine (the heart): two-watched literals, VSIDS, first-UIP
  analysis, recursive minimization, non-chronological backjumping, Luby restarts, LBD-based
  clause-database reduction, plus an optional event trace + conflict snapshot for the UI.
- `src/sat/encoders/*` — problem → CNF encoders: N-Queens, Sudoku, graph coloring, pigeonhole,
  uniform random k-SAT.
- `src/worker/solver.worker.ts` + `src/useSolver.ts` — runs the solver off the main thread.
- `src/components/*` — Solution boards, statistics + search-dynamics chart, implication-graph
  view, step-through trace, CNF/DIMACS inspector.

## Correctness

`selftest.ts` (run with `node runtest.mjs`) is the safety net. The strongest check is a
**brute-force cross-check**: 4000 random CNFs are solved both by SatForge and by exhaustive
truth-table enumeration, asserting the verdicts match and every reported model truly satisfies
its formula. It also checks N-Queens (4–12), Sudoku, 3-colorability, and the pigeonhole UNSAT
family. All 31 assertions pass.

## Ideas / backlog

- [x] Tolerant DIMACS parser + serializer + model verifier
- [x] Two-watched-literals unit propagation
- [x] VSIDS branching with a binary-heap variable order + activity decay/rescale
- [x] First-UIP conflict analysis with non-chronological backjumping
- [x] Recursive (self-subsumption) learnt-clause minimization with abstract-level pruning
- [x] Phase saving
- [x] Luby-sequenced restarts
- [x] LBD-based learnt-clause database reduction
- [x] Encoders: N-Queens, Sudoku, graph coloring, pigeonhole, random k-SAT
- [x] Web Worker execution with a synchronous fallback
- [x] Solution renderers: queen board, Sudoku grid, circular graph coloring, raw model
- [x] Statistics dashboard + SVG search-dynamics chart
- [x] Implication-graph view (backward cone of the first conflict)
- [x] Step-through trace with scrubber, filters and live counters
- [x] CNF/DIMACS inspector with shape metrics
- [x] Brute-force correctness harness (4000-instance cross-check) — all green
- [ ] Live animation: replay the trace step-by-step on the board, not just the log
- [ ] DRAT proof emission for UNSAT, with an in-app proof checker
- [ ] Incremental solving (assumptions) + a small SMT-style theory hook
- [ ] More encoders: Hamiltonian path, Langford pairs, Einstein's zebra puzzle, factoring
- [ ] Watch-list / clause-database heatmap visualization
- [ ] Cactus plot: solve many instances and chart time-to-solve
- [ ] Compare heuristics side-by-side (VSIDS vs. random, restarts on/off)
- [ ] Phase-transition explorer: sweep α and chart P(SAT) and median hardness

## Session log

- 2026-06-15 (claude): Created the project. Implemented the full CDCL solver from scratch
  (two-watched literals, VSIDS, first-UIP learning + recursive minimization, Luby restarts,
  LBD reduction), five problem encoders, a Web-Worker runner, and the complete studio UI
  (solution boards, stats + chart, implication graph, trace stepper, CNF inspector). Added a
  brute-force correctness harness — 31/31 assertions pass, including a 4000-instance random
  cross-check against exhaustive enumeration. Lint + build green.
