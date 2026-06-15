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
  clause-database reduction, plus an optional event trace + conflict snapshot for the UI, and
  optional **DRAT proof recording** (learnt clauses, deletions, the closing empty clause).
- `src/sat/drat.ts` — a from-scratch **DRAT proof checker**: two-watched-literal RUP
  propagation, the general RAT rule, DRAT text (de)serialization, and unsat-core extraction by
  a backward walk over each derivation's reason graph. Independent of the solver — it re-derives
  the contradiction from scratch, so verifying a proof genuinely re-checks the UNSAT answer.
- `src/sat/encoders/*` — problem → CNF encoders: N-Queens, Sudoku, graph coloring, pigeonhole,
  Langford pairs, uniform random k-SAT.
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
- [x] **DRAT proof emission for UNSAT** — the solver records every learnt clause (`a`) and
      LBD-reduction deletion (`d`), capped off with the empty clause (`src/sat/solver.ts`)
- [x] **Independent in-app DRAT proof checker** (`src/sat/drat.ts`) — two-watched-literal
      RUP verification, the general RAT rule (resolution asymmetric tautology), DRAT
      text serialize/parse, all from scratch
- [x] **Unsat-core extraction** — backward dependency-graph walk from the empty clause
      recovers the minimal-ish subset of original clauses that forces the contradiction
- [x] **Proof tab** — verification verdict, per-rule step counts, the unsat core (clause
      grid + donut), `.drat` / core `.cnf` downloads, and a collapsible proof listing
- [x] **Langford pairs encoder** (`src/sat/encoders/langford.ts`) — solvable iff n ≡ 0/3
      (mod 4); a clean source of small, certifiable UNSAT refutations
- [x] DRAT correctness: differential vs. an independent naive RUP checker over 1200 random
      UNSAT instances, every emitted core re-solved to confirm it is itself UNSAT, RAT
      accept/reject unit tests, PHP + triangle proofs verified — all green
- [ ] Live animation: replay the trace step-by-step on the board, not just the log
- [ ] Watch-list / clause-database heatmap visualization
- [ ] Cactus plot: solve many instances and chart time-to-solve
- [ ] Compare heuristics side-by-side (VSIDS vs. random, restarts on/off)
- [ ] Run proof verification off the main thread for very large refutations

### Session 3 — counting, cores, and three new encoders

Going from "decide SAT/UNSAT" to **counting and explaining** the answer, plus three
showcase encoders that turn famous problems into CNF.

- [x] **Exact model counter (#SAT)** — `src/sat/modelCount.ts`. A from-scratch DPLL
      counter with unit propagation, **connected-component decomposition** (disjoint
      sub-formulas multiply) and **formula caching** (Cachet-style) keyed by the canonical
      clause set. BigInt-exact. Answers "how many solutions?" — proves Sudoku uniqueness,
      counts N-Queens solutions, shows the zebra puzzle has exactly one model.
- [x] **Minimal Unsatisfiable Subset (MUS)** — `src/sat/mus.ts`. Deletion-based MUS over the
      real CDCL solver: a guaranteed-**minimal** unsat core (removing *any* clause makes it
      SAT) — strictly stronger than the DRAT-derived core, which is only sufficient.
- [x] **Factoring encoder** — `src/sat/encoders/factoring.ts`. A from-scratch binary
      shift-and-add **multiplier circuit** in Tseitin CNF (and/xor/or full-adder gates),
      constrained so a·b = N with a,b ≥ 2. Factor a semiprime — or get UNSAT as a certificate
      that N is prime.
- [x] **Hamiltonian cycle encoder** — `src/sat/encoders/hamiltonian.ts`. Position-based
      encoding (vertex-at-position matrix + adjacency constraints) over a random graph.
- [x] **Einstein's Zebra puzzle encoder** — `src/sat/encoders/zebra.ts`. The classic 5-house
      logic puzzle as SAT, with a decoder that reads off who owns the zebra and who drinks
      water; #SAT confirms the solution is unique.
- [x] **Off-thread analysis tasks** — extended the worker with `count` / `mus` operations and a
      one-shot task runner (`src/tasks.ts`) so counting and core extraction never block the UI.
- [x] **UI**: new problem kinds + controls (factoring N + presets, Hamiltonian graph, zebra),
      new solution renderers (factorization, highlighted tour, zebra grid), a **Count** tab
      (#SAT), and a **minimal core (MUS)** panel in the Proof tab.
- [x] **Tests**: #SAT differential vs. brute-force enumeration over 1500 random CNFs + exact
      N-Queens/coloring counts + cache check; MUS minimality checks (core UNSAT + every single
      deletion SAT) over PHP/coloring/random families; factoring self-checks (a·b = N over 11
      semiprimes, 6 primes → UNSAT, #SAT of factor pairs); Hamiltonian tour validation; zebra
      unique-solution check. Harness now at **130 assertions, all green**.

## Session log

- 2026-06-15 (claude): Created the project. Implemented the full CDCL solver from scratch
  (two-watched literals, VSIDS, first-UIP learning + recursive minimization, Luby restarts,
  LBD reduction), five problem encoders, a Web-Worker runner, and the complete studio UI
  (solution boards, stats + chart, implication graph, trace stepper, CNF inspector). Added a
  brute-force correctness harness — 31/31 assertions pass, including a 4000-instance random
  cross-check against exhaustive enumeration. Lint + build green.
- 2026-06-15 (claude): Shipped end-to-end **DRAT proofs**. The solver now emits a DRAT
  certificate for every UNSAT verdict, and a brand-new from-scratch checker (`src/sat/drat.ts`)
  re-verifies it in the browser with RUP + RAT and extracts the unsat core. New **Proof** tab
  shows the verification verdict, RUP/RAT step counts, the core (clause grid + donut), and
  `.drat` / core-`.cnf` downloads. Added a **Langford pairs** encoder (small, certifiable UNSAT
  instances). Hardened the test harness to 66 assertions: a differential cross-check of the real
  checker against an independent naive RUP checker over 1200 random UNSAT proofs, every extracted
  core re-solved to confirm it is itself UNSAT, RAT accept/reject cases, and PHP/triangle/Langford
  proofs — all green. (Found & fixed a watch-list indexing bug in the checker via the differential
  harness.) Lint + build + full gate green.
- 2026-06-15 (claude): Went from *deciding* formulas to **counting and explaining** them.
  Added a from-scratch **exact #SAT model counter** (`src/sat/modelCount.ts`) — DPLL with
  connected-component decomposition (disjoint sub-formulas multiply) and Cachet-style formula
  caching, BigInt-exact — and **deletion-based MUS extraction** (`src/sat/mus.ts`) that returns
  a guaranteed-minimal unsat core (drop any clause → SAT), strictly stronger than the
  DRAT-derived core. Three new showcase encoders: **integer factoring** via a hand-built binary
  shift-and-add multiplier circuit in Tseitin CNF (factor a semiprime, or UNSAT = a primality
  certificate), **Hamiltonian cycle** (position-based encoding), and **Einstein's Zebra puzzle**
  (15 clues → who drinks water / owns the zebra; #SAT confirms it's unique). Wired them into the
  UI: new problem kinds + controls, solution renderers (factorization, highlighted tour, zebra
  grid), a **Count** tab, and a **minimal-core (MUS)** panel in the Proof tab — both run off the
  main thread via new worker ops + a one-shot task runner (`src/tasks.ts`). Test harness grew
  from 66 → **130 assertions**: #SAT differential vs. brute force over 1500 random CNFs plus
  exact N-Queens/coloring counts and a cache-hit check, MUS minimality certified over
  PHP/coloring/random families, factoring round-trips over 11 semiprimes + 6 primes→UNSAT, and
  Hamiltonian/zebra validation. All presets solve in <70 ms. Lint + build + full gate green.
