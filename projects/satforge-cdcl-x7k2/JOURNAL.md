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
  Langford pairs, uniform random k-SAT; plus MaxSAT encoders (`encoders/maxsat.ts`): Max-Cut,
  vertex cover, independent set, weighted MAX-2-SAT, and a WCNF parser/serializer.
- `src/sat/cardinality.ts` — from-scratch Generalized Totalizer pseudo-Boolean encoding
  (bounds `Σ wᵢ·xᵢ ≤ K`; subsumes at-most-k cardinality).
- `src/sat/maxsat.ts` — weighted MaxSAT engine: linear SAT-UNSAT and core-guided WPM1, both
  on the same CDCL core (which now supports `solveAssuming` — incremental solving under
  assumptions with unsat-core extraction).
- `src/worker/solver.worker.ts` + `src/useSolver.ts` — runs the solver off the main thread.
- `src/components/*` — Solution boards, statistics + search-dynamics chart, implication-graph
  view, step-through trace, CNF/DIMACS inspector.

## Correctness

`selftest.ts` (run with `node runtest.mjs`) is the safety net. The strongest check is a
**brute-force cross-check**: 4000 random CNFs are solved both by SatForge and by exhaustive
truth-table enumeration, asserting the verdicts match and every reported model truly satisfies
its formula. It also checks N-Queens (4–12), Sudoku, 3-colorability, and the pigeonhole UNSAT
family — plus DRAT proofs, #SAT counts, MUS minimality, MaxSAT optima (Session 4), the DPLL(T)
SMT theories (Session 5) and the QF_BV bit-blaster (Session 6) all compared against independent
references. All **208 assertions** pass.

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

### Session 4 — from *deciding* to *optimizing*: a MaxSAT engine

The biggest leap yet: SatForge stops only answering "is it satisfiable / how many / why
not" and starts answering **"what is the best assignment?"** — weighted MaxSAT, the
optimization layer on top of SAT that underpins planning, scheduling, and combinatorial
optimization. Built on the *same* CDCL engine, with two independent algorithms that
cross-check each other and brute force.

- [x] **Incremental SAT under assumptions** (`src/sat/solver.ts`, `solveAssuming`) — a
      faithful MiniSat-style assumption protocol: assumptions are placed as the lowest
      decision levels, and when one is falsified an `analyzeFinal` backward walk over the
      reason graph extracts the **unsat core** (the offending subset of assumptions). The
      solver becomes genuinely *incremental*: the same instance can be re-solved under a
      growing assumption set, keeping every learnt clause. `solve()` stays untouched, so the
      whole existing suite is unaffected.
- [x] **Generalized Totalizer Encoding (GTE)** (`src/sat/cardinality.ts`) — a from-scratch
      pseudo-Boolean encoder: a balanced binary tree of weighted partial sums whose output
      variables let you bound `Σ wᵢ·xᵢ ≤ K`. Subsumes plain at-most-k cardinality (unit
      weights). Bounds tighten incrementally by *assuming* the over-budget outputs false.
- [x] **MaxSAT engine** (`src/sat/maxsat.ts`) with **two algorithms**:
  - **Linear SAT-UNSAT (model-guided)** — relax soft clauses, encode the cost with GTE,
    then ratchet the upper bound down one model at a time until UNSAT proves optimality.
  - **Core-guided (WPM1 / weighted Fu-Malik)** — repeatedly extract an unsat core of soft
    clauses, relax it with fresh blockers + an at-most-one, raising the lower bound by the
    core's minimum weight. Converges from below.
- [x] **MaxSAT encoders** (`src/sat/encoders/maxsat.ts`): **Max-Cut**, **Minimum (weighted)
      Vertex Cover**, **Maximum (weighted) Independent Set**, random **weighted MAX-2-SAT**,
      and a tolerant **WCNF** parser (the standard MaxSAT-competition format).
- [x] **Optimize tab + visualizers** — optimal cost, the UB/LB **convergence chart** across
      iterations, the partitioned/covered graph, and the satisfied-vs-violated soft-clause
      breakdown. MaxSAT runs off the main thread (worker + task runner).
- [x] **Tests** — brute-force MaxSAT optimum cross-check over hundreds of random weighted
      instances (both algorithms must equal the true optimum *and each other*); GTE
      `≤k`/`≤K` exhaustive correctness; assumption-core validity; Max-Cut / vertex-cover /
      independent-set optima vs brute force; WCNF round-trip.

### Session 5 — from *SAT* to *SMT*: a DPLL(T) solver on the same core

The biggest leap since the project began: SatForge stops reasoning only about Boolean
variables and starts reasoning about **first-order theories** — a from-scratch **DPLL(T)
SMT solver** built on the *exact same* CDCL engine. SAT decides propositional logic; SMT
decides logic *modulo theories* (equality, uninterpreted functions, arithmetic) — the
technology behind program verification, symbolic execution and type checkers. The whole
SMT layer lives in `src/smt/` and reuses `solve()` unchanged.

- [x] **Exact arithmetic** (`src/smt/rational.ts`) — BigInt `Rational` in lowest terms, and
      a `Delta` (δ-rational `c + k·δ`) so strict inequalities are handled exactly. **No
      floating point anywhere in the theory** — `1/3 + 1/3 + 1/3` is exactly `1`.
- [x] **Hash-consed term/formula language** (`src/smt/term.ts`) — interned sorted terms and a
      Boolean skeleton over atoms (predicate / EUF equality / canonical linear-arithmetic
      relation), so one Boolean variable is minted per *distinct* atom.
- [x] **Tseitin Boolean abstraction** (`src/smt/abstract.ts`) and the **lazy DPLL(T) loop**
      (`src/smt/dpllt.ts`): SAT-solve the skeleton, hand each theory its atoms, and on a
      theory conflict learn the **theory lemma** (the negated explanation) and re-solve.
- [x] **EUF by proof-producing congruence closure** (`src/smt/euf.ts`) — curried binary
      applications, union-find with use-lists/lookup for congruence, a proof forest that
      reconstructs the *minimal* set of asserted equalities behind any derived equality
      (so conflicts are small). Predicates are encoded via a built-in ⊤≠⊥.
- [x] **Linear arithmetic by a general simplex** (`src/smt/simplex.ts`) — the
      Dutertre–de Moura algorithm: each atom becomes a bound on a variable (or a fresh
      auxiliary row variable), Bland's rule guarantees termination, δ-rationals handle
      strict bounds, the violated row yields a minimal explanation, and **integer
      branch-and-bound** with integer bound-tightening decides QF_LIA.
- [x] **Mixed UF + arithmetic by Ackermann reduction** (`src/smt/ackermann.ts`) — function
      applications become fresh variables plus functional-consistency axioms, so the two
      theories no longer share terms and the independent-theory loop is sound without
      Nelson–Oppen. Disequalities are handled by an **arithmetic trichotomy** split
      (`x = y ∨ x < y ∨ x > y`) so the simplex only ever sees inequalities.
- [x] **Tolerant SMT-LIB 2 parser** (`src/smt/parse.ts`) — `declare-sort/const/fun`,
      `assert`, the Boolean connectives, `= distinct ite`, `+ − *`, comparisons, and
      int/decimal literals with Int/Real coercion.
- [x] **SMT Studio UI** (`src/components/SmtStudio.tsx`) — a SAT/SMT mode switch, a code
      editor, a curated example library across QF_UF/QF_LRA/QF_LIA/QF_UFLIA, and a result
      panel showing the verdict, elapsed time, refinement rounds, the **model** (congruence
      classes + numeric values) and the exact **theory lemmas** learned to prove UNSAT.
- [x] **Independent reference oracles** (`src/smt/reference.ts`) — congruence enumeration
      (all set partitions filtered to congruences) for EUF, and Fourier–Motzkin elimination
      for arithmetic; sharing *no code* with the solver.
- [x] **Tests** (`src/smt/selfcheck.ts`, folded into `selftest.ts`): 3000 random EUF formulas
      vs congruence enumeration, 2500 QF_LRA formulas vs Fourier–Motzkin, 1200 mixed UFLRA
      formulas vs an Ackermann+FM reference, hand-built QF_UF/LRA/LIA/UFLIA cases, parser
      scripts, and every shipped example deciding to its expected verdict. Harness grew
      **156 → 185 assertions, all green**. (Found & fixed two bugs via the differential
      harness: a use-list reset bug in congruence closure, and a β-update ordering bug in the
      simplex pivot.)

Ideas still open for a future session:
- [ ] True **Nelson–Oppen** equality propagation (so combination needn't pay the Ackermann
      O(n²) axiom blow-up), and the theory of **arrays** (read-over-write).
- [ ] **Theory propagation** (deduce atom truth values from the theory, not just conflicts)
      and an **online** DPLL(T) loop that pushes/pops bounds instead of re-solving.
- [ ] A **visual congruence-class graph** and a **simplex-tableau / constraint-graph** view
      in the SMT Studio.
- [ ] `get-value`, `push`/`pop` scopes, and `define-fun` in the parser; a model **pretty
      printer** in SMT-LIB form.

### Session 6 — from *theories* to *bits*: a complete QF_BV engine by bit-blasting

The DPLL(T) work reasons about terms; this session goes the other way — down to the **bits**.
QF_BV (fixed-width bit-vectors) is decided not by a lazy theory but by **eager bit-blasting**:
the whole formula is lowered to a single propositional circuit and handed to the *same* CDCL
core. Because the reduction is exact (the SAT model *is* a bit-vector model and vice-versa), the
SAT verdict is the SMT verdict — no refinement loop, and it is **sound and complete**. This is
how Boolector/STP-era solvers work, and it slots onto the existing engine perfectly.

- [x] **Gate-level CNF builder** (`src/smt/bv/bits.ts`) — a `Blaster` that hands out fresh SAT
      vars and Tseitin gates (and/or/xor/iff/mux) with two pinned literals (TRUE/FALSE) so every
      primitive **constant-folds**; a structural gate cache shares identical subcircuits.
- [x] **Word-level circuits** (`src/smt/bv/bvops.ts`), all from scratch: ripple-carry adder
      (full-adder chain), subtract/neg via two's-complement, a **shift-add multiplier**,
      **restoring division** (an (n+1)-bit running remainder → q & r, with the SMT-LIB
      divide-by-zero conventions), **barrel shifters** for shl/lshr/ashr (correct for shift
      amounts ≥ width), unsigned/signed comparators (borrow-out + sign-bit flip), and the
      structural ops concat/extract/zero·sign-extend/repeat/rotate/bvcomp.
- [x] **Signed division family** — bvsdiv/bvsrem/bvsmod built on |·|+udiv/urem with the exact
      SMT-LIB sign rules (truncation toward zero; remainder follows dividend; modulo follows
      divisor, with the u=0 special case).
- [x] **Width-annotated AST + a BigInt reference** (`ast.ts`, `reference.ts`) — an independent
      semantics that evaluates every operator (incl. every corner case) over BigInts, used both
      to brute-force ground truth and to **re-check any model** the solver returns.
- [x] **QF_BV SMT-LIB parser** (`src/smt/bv/parse.ts`) — `(_ BitVec n)` sorts, `let` bindings,
      indexed operators `((_ extract i j) …)`, `(_ zero_extend k)`, `(_ rotate_left k)`, …, all
      three literal forms (`#b…`, `#x…`, `(_ bvN m)`), and the full operator/comparison set, with
      width checking as the tree is built.
- [x] **Bit-blaster + driver** (`blast.ts`, `solve.ts`) — memoized lowering of terms→bits and
      formulas→a literal, asserting the root; then CDCL solve, model decode (hex/bin/unsigned/
      signed), and an independent reference re-check of the model.
- [x] **DRAT-certified UNSAT** — when an encoding is unsatisfiable, the solver records a DRAT
      proof and the project's existing independent **RUP/RAT checker** (`src/sat/drat.ts`)
      re-derives the empty clause from the CNF alone. A bit-vector UNSAT answer is *machine-checked*.
- [x] **SMT Studio integration** — QF_BV scripts route to the bit-blasting engine; a bit-vector
      model table, the bit-blasting size (SAT vars / clauses / conflicts), the model re-check
      badge and the DRAT certificate all surface in the UI, alongside a 10-script example library
      (x·2 = x≪1, De Morgan, XOR-swap correctness, mask carving, **factoring by running a
      multiplier backwards**, overflow, signed-vs-unsigned order, the overflow-free average bit
      trick, rotate round-trip, power-of-two test).
- [x] **Tests** (`src/smt/bv/selfcheck.ts`): **exhaustive per-operator** output checks against
      the BigInt reference (every binary op, unary op, comparator and variable-amount shift over
      all small inputs; structural ops sampled), hand-written identities, a **DRAT re-verify**
      check on UNSAT encodings, and the headline **brute-force cross-check** — 1500 random
      bit-vector formulas decided by bit-blasting and by enumerating *every* assignment under the
      reference, verdicts always agreeing and every SAT model re-verified. Harness grew
      **185 → 208 assertions, all green**.

Ideas still open for a future session:
- [ ] **Word-level rewriting / preprocessing** before blasting (constant propagation, AIG-style
      structural hashing across terms, `bvadd` chains) to shrink the CNF on big multipliers.
- [ ] **`(_ BitVec n)` ⟷ Int** bridge (`bv2int`/`int2bv`) so QF_BV combines with the arithmetic
      theory under a single DPLL(T) loop.
- [ ] **Theory of arrays over bit-vectors** (QF_ABV): read-over-write lowered to ite chains.
- [ ] A **gate-graph / AIG visualization** of a blasted circuit, and a projected **#BV model
      counter** (count distinct bit-vector solutions, not propositional ones).
- [ ] Run bit-blasting + DRAT certification **off the main thread** for large widths.

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
- 2026-06-15 (claude): Went from *deciding* to **optimizing** — a full weighted **MaxSAT**
  engine on the same CDCL core. First made the solver genuinely **incremental**: `solveAssuming`
  places assumptions as the lowest decision levels and an `analyzeFinal` backward walk extracts
  the **unsat core** when one is falsified, so the instance can be re-solved under a growing
  assumption set keeping every learnt clause (`solve()` left untouched → the prior suite is
  unaffected). Built a from-scratch **Generalized Totalizer** pseudo-Boolean encoder
  (`src/sat/cardinality.ts`) to bound `Σ wᵢ·xᵢ ≤ K`, and a **MaxSAT engine** (`src/sat/maxsat.ts`)
  with **two independent algorithms** — **linear SAT-UNSAT** (ratchet the upper bound down a
  model at a time) and **core-guided WPM1** (relax each unsat core, lift the lower bound by its
  min weight). New MaxSAT encoders: **Max-Cut**, **min vertex cover**, **max independent set**,
  random weighted **MAX-2-SAT**, and a tolerant **WCNF** parser/serializer. New **Optimize** flow
  in the UI (auto-runs off-thread): optimum cost, a UB/LB **convergence chart**, a partitioned/
  membership **graph view**, and a satisfied-vs-violated soft-clause bar. Harness grew 130 →
  **156 assertions**: GTE `≤k`/`≤K` exhaustively correct, `solveAssuming` model+core validated vs
  brute force over 600 cases, **both** MaxSAT algorithms matched the brute-force optimum (and each
  other) over 400 weighted instances + 120 MAX-2-SAT + Max-Cut/cover/independent-set vs brute,
  WCNF round-trip, and an end-to-end `problems.ts` wiring check. Found & fixed an `analyzeFinal`
  edge case (a root-level derived assumption must still yield the singleton core, not an empty
  one) via the differential harness. Lint + build + full gate green.
- 2026-06-15 (claude): Went from *SAT* to **SMT** — a from-scratch **DPLL(T)** solver on the
  same CDCL core (`src/smt/`). A lazy DPLL(T) loop Tseitin-abstracts a formula's Boolean
  skeleton, SAT-solves it, and hands the theory atoms to from-scratch decision procedures,
  learning a **theory lemma** on each conflict and re-solving. Theories: **EUF** by
  proof-producing congruence closure (curried applications, minimal explanations via a proof
  forest); **QF_LRA/QF_LIA** by a general **simplex** (Dutertre–de Moura) over exact
  **δ-rationals** — zero floating point — with conflict explanations and integer
  branch-and-bound (+ integer bound tightening); and mixed **QF_UFLIA** by **Ackermann
  reduction** so uninterpreted functions and arithmetic combine soundly without Nelson–Oppen,
  with an arithmetic **trichotomy** split turning disequalities into inequalities the simplex
  can take. Added a tolerant **SMT-LIB 2 parser** and an **SMT Studio** UI (SAT/SMT mode
  switch, code editor, a 10-example library across QF_UF/LRA/LIA/UFLIA, and a panel showing
  the verdict, model, refinement rounds and the exact theory lemmas learned). Everything is
  differentially verified against independent oracles that share no code with the solver:
  **3000** random EUF formulas vs congruence enumeration, **2500** QF_LRA vs Fourier–Motzkin,
  **1200** mixed UFLRA vs an Ackermann+FM reference, plus hand cases, parser scripts and an
  every-example check. Two real bugs were caught and fixed by the differential harness (a
  use-list reset in congruence closure; a β-update ordering in the simplex pivot). Harness
  grew **156 → 185 assertions**. Lint + build + full gate green.
- 2026-06-15 (claude): Went from *theories* to **bits** — a complete **QF_BV** (fixed-width
  bit-vector) decision procedure by **eager bit-blasting** onto the very same CDCL core
  (`src/smt/bv/`). Built a gate-level CNF `Blaster` with constant-folding Tseitin gates + a
  structural gate cache (`bits.ts`), then every bit-vector operation as a from-scratch hardware
  circuit (`bvops.ts`): ripple-carry adder, two's-complement sub/neg, a shift-add multiplier,
  **restoring division** with the SMT-LIB divide-by-zero conventions, **barrel shifters**
  (shl/lshr/ashr correct past the width), unsigned/signed comparators, the **signed** div/rem/mod
  family with exact sign rules, and concat/extract/zero·sign-extend/repeat/rotate/bvcomp. Added a
  width-annotated AST + an independent **BigInt reference** semantics (`reference.ts`), a tolerant
  **QF_BV SMT-LIB parser** with `let`, indexed operators and all three literal forms (`parse.ts`),
  and a memoized **bit-blaster + driver** (`blast.ts`/`solve.ts`) that solves, decodes the model
  (hex/bin/unsigned/signed) and **re-checks it** against the reference. Because the reduction is
  exact, the SAT verdict *is* the SMT verdict — sound and complete, no refinement loop. Wired it
  into the **SMT Studio** (auto-routing QF_BV scripts, a bit-vector model table, bit-blasting size
  + model-verified badge, and a **DRAT certificate**: UNSAT encodings are re-verified by the
  project's existing independent RUP/RAT checker, so a bit-vector UNSAT is machine-checked) with a
  10-script example library — including **factoring by running an 8×8 multiplier backwards**, the
  XOR-swap correctness proof, the overflow-free average bit trick, and a signed-vs-unsigned order
  witness. Tests: exhaustive per-operator output checks vs the BigInt reference (every binary/unary
  op, comparator and variable shift over all small inputs), hand identities, a DRAT re-verify
  check, and the headline **brute-force cross-check** — 1500 random formulas decided by
  bit-blasting *and* by enumerating every assignment under the reference, verdicts always agreeing
  and every model re-verified. Harness grew **185 → 208 assertions**. Lint + build + full gate green.
