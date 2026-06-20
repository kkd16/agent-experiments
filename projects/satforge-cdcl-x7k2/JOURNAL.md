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
- `src/sat/modelCount.ts` — exact #SAT: DPLL with component decomposition + Cachet-style caching.
- `src/sat/ddnnf.ts` — **knowledge compilation** (Session 14). Compiles a CNF into a *smooth,
  deterministic, decomposable* DNNF circuit (sd-DNNF) — the DPLL search recorded as a shared DAG —
  then answers, each in one linear pass: exact `ddnnfCount`, `ddnnfWmc` (weighted model counting),
  `ddnnfMarginals` (every variable's exact marginal via the arithmetic-circuit derivative, one
  forward + backward sweep), `ddnnfMpe` (the most-probable explanation by a max-product pass),
  `ddnnfEnumerate`, `verifyCircuit` (structural sd-DNNF certificates) and `toNnf` (the standard
  c2d/Dsharp `.nnf` export).
- `src/sat/maxsat.ts` — weighted MaxSAT engine: linear SAT-UNSAT and core-guided WPM1, both
  on the same CDCL core (which now supports `solveAssuming` — incremental solving under
  assumptions with unsat-core extraction).
- `src/smt/*` — the DPLL(T) SMT solver: EUF, LIA/LRA simplex, arrays, datatypes, strings,
  Ackermann reduction, an SMT-LIB 2 parser, and the OMT/MaxSMT optimization layer; `src/smt/bv/*`
  is the eager QF_BV bit-blaster.
- `src/imc/*` — **Craig interpolation + model checking** (Session 11). `proofSolver.ts` is a
  proof-logging CDCL that records a resolution refutation for UNSAT; `interpolant.ts` reads a
  McMillan interpolant off that proof; `formula.ts` is a Boolean circuit layer that both
  Tseitin-encodes to CNF and evaluates concretely; `modelcheck.ts` is the interpolation-based
  safety model checker plus k-induction plus an **independent explicit-state BFS reachability
  oracle**. `pdr.ts` (Session 13) is a from-scratch **IC3 / PDR** engine — property-directed
  reachability with recursive proof-obligation blocking, Bradley's inductive generalization (MIC),
  and clause propagation — a *third* unbounded-safety prover that never unrolls `Trans`.
- `src/qbf/*` — **QBF: the full quantifier hierarchy** (Session 15). `qdimacs.ts` is the prenex
  QBF model + a tolerant QDIMACS parser/serializer; `solver.ts` decides arbitrary alternation by
  **counterexample-guided expansion** (the RAReQS idea) — a quantifier game played one block at a
  time, every candidate move proposed and every counter-move refuted by the *same CDCL core*;
  `eval.ts` is an independent exhaustive Shannon-expansion oracle; `encoders.ts` carries curated
  examples plus scalable families with values known by construction (the copy game, the parity
  ladder) and a random generator; `selfcheck.ts` cross-checks 1500+ instances solver-vs-oracle.
- `src/bdd/*` — **Binary Decision Diagrams** (Session 16). `bdd.ts` is a from-scratch ROBDD
  package: a unique-table-interned, canonical representation built around the universal `ite(f,g,h)`
  apply (memoized), with every connective, cofactor/restrict, ∃/∀ quantification, functional
  `compose`, exact BigInt `satCount`, and cube enumeration as thin wrappers — equivalence is a
  pointer compare. `reorder.ts` rebuilds a function under any variable order by Shannon
  reconstruction (the cofactor identity, provably function-preserving) and layers **Rudell sifting**
  on top to shrink a diagram. `expr.ts` is a precedence-climbing Boolean-expression front-end;
  `build.ts` compiles CNFs into BDDs and carries a gallery of order-sensitive classics (the
  bit-match blow-up, word equality, the adder carry, parity, thresholds); `zdd.ts` is the dual
  **Zero-suppressed BDD** for set families (∪/∩/∖, count, combinations); `layout.ts` positions a
  diagram for SVG. `selfcheck.ts` pins the engine against a truth-table oracle, the project's OWN
  CDCL + #SAT engines (a BDD from a CNF must agree on SAT/UNSAT and the model count), and closed-form
  combinatorics for the ZDD.
- `src/worker/solver.worker.ts` + `src/useSolver.ts` — runs the solver off the main thread.
- `src/components/*` — Solution boards, statistics + search-dynamics chart, implication-graph
  view, step-through trace, CNF/DIMACS inspector, the #SAT Count view, the **Compile** view
  (`CompileView.tsx` — sd-DNNF stats, verified property badges, an interactive weight "tilt"
  slider, a live variable-marginal bar chart, and a `.nnf` download), the SMT Studio, the
  **QBF Studio** (`QbfStudio.tsx` — QDIMACS editor, examples + random generator, the verdict with
  its brute-force agreement badge, a verified winning-move certificate, and a live refinement
  trace), the Model Checker studio (`ModelChecker.tsx`), and the **BDD Studio**
  (`BddStudio.tsx` — a gallery + Boolean-expression editor, a live SVG of the diagram with the
  1-edge/0-edge convention, node-count/model-count/status stats, and one-click reordering
  — sift / reverse / shuffle / good-vs-bad order — that visibly grows or collapses the diagram).

## Correctness

`selftest.ts` (run with `node runtest.mjs`) is the safety net. The strongest check is a
**brute-force cross-check**: 4000 random CNFs are solved both by SatForge and by exhaustive
truth-table enumeration, asserting the verdicts match and every reported model truly satisfies
its formula. It also checks N-Queens (4–12), Sudoku, 3-colorability, and the pigeonhole UNSAT
family — plus DRAT proofs, #SAT counts, MUS minimality, MaxSAT optima (Session 4), the DPLL(T)
SMT theories (Session 5), the QF_BV bit-blaster (Session 6), the QF_AX theory of arrays
(Session 7) and the QF_DT theory of algebraic datatypes (Session 8) and the QF_S bounded theory of strings (Session 9),
the OMT/MaxSMT optimizer (Session 10), and the Craig-interpolation + model-checking subsystem
(Session 11 — the proof-logging solver vs. brute force *and* the main engine, interpolants vs.
exhaustive verification of all three Craig properties, and the model checker vs. an independent
explicit-state BFS oracle, plus a k-induction proof rule that must agree) and the **IC3/PDR
engine** (Session 13 — its verdicts, inductive invariants and shortest counterexamples
cross-checked against BFS, IMC *and* k-induction on hundreds of random systems and the curated
gallery) and the **knowledge-compilation engine** (Session 14 — over 1200 random CNFs the compiled
sd-DNNF is checked for the three structural properties, its model count is matched against #SAT and
brute force, its weighted model count and its one-pass differential marginals against brute force,
and its enumeration against the exact model set with no duplicates) all compared against independent
references — and (Session 16) the **BDD/ZDD** engine (a truth-table oracle for every apply,
cofactor, quantifier and reorder; a BDD compiled from a CNF cross-checked against the project's own
CDCL solver and #SAT counter; the ZDD set algebra against closed-form combinatorics). All **412
assertions** pass.

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
- [x] **Cactus plot: solve many instances and chart time-to-solve** (Session 12 — the Solver Lab)
- [x] **Compare heuristics side-by-side (VSIDS vs. random, restarts on/off, …)** (Session 12)
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

### Session 7 — from *bits* to *memory*: a complete QF_AX theory of arrays

The DPLL(T) core already decides EUF and linear arithmetic. The classic next theory is
**arrays** (McCarthy `select`/`store`) — the logic of memory, the backbone of every program
verifier. The plan keeps the project's signature move: **add a whole theory without touching a
single theory solver**, by *reducing* arrays to the EUF + arithmetic the engine already has —
and then **certify it by brute force** against an independent finite-model enumerator that
shares no code with the reduction.

The decision procedure (eager, complete for the ground fragment):

- [x] **Array sorts & terms** (`src/smt/term.ts`): parametric `(Array I E)` sorts, and
      first-class `select`, `store`, and **constant-array** term constructors, interned like
      every other term, with pretty `a[i]` / `a[i↦v]` / `const(v)` rendering.
- [x] **Read-over-write purification** (`src/smt/arrays.ts`): recursively rewrite every
      `select(store(a,i,v), j)` into a fresh element symbol `e` pinned by the McCarthy axioms
      `(i=j → e=v) ∧ (i≠j → e=read(a,j))` — eliminating all writes from under reads. Plain
      reads become an uninterpreted binary function the existing **congruence closure** already
      reasons about. The result is an ordinary EUF(+arith) formula — both existing theories
      inherit arrays for free, exactly like `arithTrichotomy` layers on today.
- [x] **Extensionality** (`(Array I E)` equality): encode each array-equality atom `a=b` with a
      Skolem **witness index** `k` and a saturated index set so `a≠b` forces a differing read
      and `a=b` forces agreement on every relevant index — the Stump–Barrett–Dill scheme, made
      finite and ground. Certified separately so the **non-extensional** guarantee stands alone.
- [x] **SMT-LIB parser** (`src/smt/parse.ts`): `(Array I E)` sorts in `declare-const`/
      `declare-fun`, the `select`/`store` operators, `((as const (Array I E)) v)`, and array
      `=`/`distinct`.
- [x] **Independent brute-force oracle** (`src/smt/arrayref.ts`): decide a QF array formula by
      enumerating *every* function `I→E` over small finite index/element domains for each array
      variable — a totally different algorithm, so agreement is real evidence.
- [x] **Self-checks**: hand cases (read-over-write 1 & 2, swap-via-store, extensionality,
      const arrays, McCarthy congruence) **plus thousands of random array formulas**
      cross-checked against the finite-model oracle, both non-extensional and extensional. Grew
      the assertion count **208 → 231**.
- [x] **Example library + Studio UI**: curated `QF_AX`/`QF_ALIA` scripts (read-over-write,
      array swap, const-array, extensionality witness), routed and rendered with an **array
      model view** (per-array cell tables the solver committed to) and new `QF_AX`/`QF_ALIA`
      logic badges.

### Session 8 — from *memory* to *structure*: a complete QF_DT theory of algebraic datatypes

Arrays gave the engine memory; this session gives it **structure** — a from-scratch theory of
**algebraic datatypes** (constructors, selectors, testers): lists, trees, pairs, enums, `Nat`.
This is the logic of every functional program, every AST, every term language — and it is the
classic SMT theory that needs more than EUF, because it must rule out **infinite/cyclic values**
(`x = cons(h, x)` is *unsatisfiable*: a finite list is never its own tail). The plan keeps the
project's signature move once more: **add a whole theory without writing a single theory solver**,
by *reducing* datatypes to the EUF + linear-integer-arithmetic the DPLL(T) engine already has —
and then **certify it by brute force** against an independent finite-tree-model enumerator that
shares no code with the reduction.

The decision procedure (eager, ground; an Oppen/Barrett–Shikanian–Tinelli-style reduction):

- [x] **Datatype declarations in `term.ts`** — a datatype registry (`declareDatatypes`, two-phase
      so mutually-recursive sorts can reference each other), interning each constructor, selector
      and tester as ordinary declared function symbols, plus query helpers
      (`isDatatypeSort`/`getDatatype`/`allDatatypes`).
- [x] **The reduction** (`src/smt/datatypes.ts`, `reduceDatatypes`) — purely *additive*: every
      datatype operation is already an ordinary term, so we only *add* the theory axioms that pin
      the uninterpreted symbols to behave like a free term algebra, instantiated on the ground
      terms (closed under selectors via the tester link, with a finite instantiation bound):
  - **Exhaustiveness + disjointness** — every datatype term satisfies *exactly one* tester.
  - **Constructor pinning** — a literal `C(a₁…aₖ)` term forces `is_C` true, `selᵢ(C(…)) = aᵢ`
    (this gives **injectivity** for free through congruence on the selectors), and disjointness
    falsifies every other tester.
  - **Tester link** — `is_C(t) → t = C(sel₁(t), …, selₖ(t))`, materialising a term's children
    when it is known to be a `C` (the rule that makes selectors on variables sound).
  - **Acyclicity by integer rank** — the one genuinely non-EUF ingredient: a fresh
    `rank : D → Int` with `rank(t) > rank(child)` on every constructor edge. Over a *finite* set
    of ground terms a strict `>` ordering is exactly "no term is its own subterm", so the
    existing **simplex / branch-and-bound** rules out cyclic (infinite) values — datatypes reduce
    to **QF_UFLIA**, Ackermann-combined like UFLIA/QF_ALIA already are.
- [x] **SMT-LIB parser** (`src/smt/parse.ts`) — `declare-datatype` and `declare-datatypes`
      (single + mutually recursive), nullary-constructor shorthand, constructor/selector
      applications (free via the existing `app` path), and the tester `((_ is C) t)`.
- [x] **Independent brute-force oracle** (`src/smt/dtref.ts`) — decide a QF datatype formula by
      enumerating *honest finite tree models*: each datatype variable ranges over the finite set
      of constructor-trees up to the small-model depth bound, constructors build real trees,
      testers read the real root and equality is structural — a totally different algorithm, so
      agreement is real evidence (catches cyclicity, injectivity and disjointness bugs).
- [x] **Self-checks** (`src/smt/selfcheck.ts`) — hand cases (read-back of a constructor, tester
      disjointness/exhaustiveness, injectivity, `nil ≠ cons`, the **acyclicity** refutation, a
      `Nat`/enum, `Pair`) **plus thousands of random datatype formulas** cross-checked against the
      finite-tree oracle. Target: grow the harness past **231** assertions.
- [x] **Example library + Studio UI** — curated `QF_DT`/`QF_UFDT`/`QF_DTLIA` scripts (list
      read-back, injectivity, the impossible cyclic list, an enum, a `Nat` order) with new logic
      badges.

### Session 9 — from *structure* to *text*: a bounded QF_S theory of strings

The one classic SMT theory the engine still can't speak is **strings** — the hardest of the
lot, because unbounded string/word equations are undecidable in general. So we add the
**decidable, certifiable** core of it: the quantifier-free theory of strings over a **bounded
length** `L`, in exactly the project's recurring style — *reduce* a whole new logic to the
EUF + linear-integer arithmetic the DPLL(T) engine already has, add **zero** new theory solvers,
then certify the reduction by brute force against a totally independent oracle. Each string term
becomes a length `0 ≤ |s| ≤ L` (the existing `str.len` symbol *is* that length) plus `L` integer
**code-unit** functions `str.char$(s, k)` (an uninterpreted `String × Int → Int`, so EUF gives
congruence for free and Ackermann already combines it with the simplex). Padding past the length
is pinned to a sentinel, so a string's value is exactly its code-units — and the McCarthy-style
per-operator axioms unfold every operation over the `≤ L` positions into ordinary `eq` / `arith`
atoms. Because the alphabet is only constrained up to *equality*, the small-model property makes
this sound and complete **within the length bound** — and the oracle, enumerating concrete
strings over a finite alphabet sized by that same property, agrees verdict-for-verdict.

- [x] **`String` sort + string literals** — register `String` as a first-class sort; tokenize
      SMT-LIB `"…"` literals (with `""` escaping) and intern each as a value-carrying constant,
      rendered back as `"…"` in models and the unsat core.
- [x] **The bounded char model** (`src/smt/strings.ts`) — for every string subterm emit the
      well-formedness axioms: `0 ≤ |s| ≤ L`, in-range code-units `≥ 0`, and padding `= -1` past
      the end (so equal code-units ⟺ equal strings, and a real char never collides with padding).
- [x] **Reduce `str.++` (concatenation)** — `|a·b| = |a| + |b|`, with each result position
      defined by an `ite` over the split point `|a|` (unfolded across `0..L`), so concatenation
      becomes pure integer arithmetic + position equalities.
- [x] **Reduce `str.len`** — the user's `str.len` symbol is reused *as* the length variable, so a
      length constraint is already a linear-integer atom the simplex solves directly.
- [x] **Reduce `str.at` and `str.substr`** — single-character access and SMT-LIB-faithful
      substring (offset/clamping/out-of-range → empty), unfolded over the symbolic offset and
      length across `0..L`.
- [x] **Reduce `str.contains` / `str.prefixof` / `str.suffixof`** — each a Boolean ⇔ the
      existence of a matching window: a length guard plus position-wise code-unit equalities,
      unfolded over the candidate offset (so suffix's symbolic `|s|−|t|` shift stays ground).
- [x] **String equality as content equality** — keep `=`/`distinct` over `String` as EUF atoms
      (so uninterpreted functions over strings still get congruence) **and** conjoin the
      biconditional tying each to position-wise code-unit agreement, so equality means *value*
      equality (`"ab"·"c" = "abc"`), not term identity.
- [x] **Wire it into `checkSat`** — run the string reduction first (outermost), feeding its EUF +
      integer output through the existing datatypes/arrays/Ackermann/trichotomy pipeline unchanged.
- [x] **Independent brute-force oracle** (`src/smt/strref.ts`) — decide a QF_S formula by
      enumerating concrete strings (length `≤ L` over a finite alphabet sized by the small-model
      property) and evaluating every operator with plain JavaScript string semantics — a totally
      different algorithm from the reduction, so agreement is real evidence; out-of-bound results
      are excluded exactly as the `|t| ≤ L` axioms exclude them.
- [x] **Self-checks** (`src/smt/selfcheck.ts`) — hand cases (concat associativity/identity, a
      `x·y = "ab"` split, contains/prefix/suffix, the **no-fixpoint** `x = "a"·x` refuted by the
      length bound, an at/substr read-back) **plus ~1000 random string formulas** cross-checked
      against the oracle. Target: grow the harness past **259** assertions.
- [x] **Example library + Studio UI** — curated `QF_S` scripts (concat split, the impossible
      self-append, a substring read-back, prefix/suffix/contains, value-vs-identity equality) with
      a `QF_S` badge and a reconstructed **string model** view (each variable's solved text).
- [ ] **Stretch (future):** `str.indexof` / `str.replace` (return-position unfolding),
      lexicographic `str.<` / `str.<=` (an order-preserving alphabet embedding), `str.to_int` /
      `str.from_int`, and regular-membership `str.in_re` over a bounded NFA.

### Session 10 — from *deciding* to *optimizing modulo theories*: OMT + MaxSMT

SatForge already had two kinds of "best answer" machinery that lived on opposite
ends of the project: a **MaxSAT** optimizer (over the propositional CDCL core,
Session 4) and a full **DPLL(T) SMT** decision procedure (Session 5+). This
session unifies them — it adds the optimization layer *on top of SMT*, so the
solver stops only answering "is there a model?" and starts answering **"what is
the best model?"** over any combination of its theories (EUF, LIA/LRA, arrays,
datatypes, strings). This is **Optimization Modulo Theories (OMT)** — the
technology behind cost-optimal program synthesis, scheduling, and verification —
and its weighted-soft-constraint specialization, **MaxSMT**. The whole layer is
*additive*: it drives the existing `checkSat` (and the existing simplex) and
changes no theory `check`, so every prior assertion is untouched.

The two engines are chosen so each is **exact and terminating**:

- [x] **Exact integer-objective OMT** (`src/smt/omt.ts`) — an integer-valued
      objective (every QF_LIA objective, and *every* MaxSMT cost, since a sum of
      integer weights is integral) is optimized by an **exponential bracket +
      binary search** on the objective bound. Each probe is one `checkSat` of
      `φ ∧ (obj ≤ k)`; because the objective is integer the search is finite and
      returns the *true* optimum — no tolerance, no floating point. Unboundedness
      is detected when the bracket runs away past a huge cap.
- [x] **Exact real-objective OMT** (`src/smt/omt-lra.ts`) — a QF_LRA objective can
      sit at a rational vertex, or at an **open infimum** a strict inequality
      never lets it reach, so a bound search would not terminate. Instead we
      optimize the way real OMT solvers do — **theory optimization inside the
      Boolean search**: ask DPLL(T) for any model better than the incumbent, jump
      to that branch's *exact* vertex optimum with a new simplex LP routine,
      tighten the strict bound, and repeat until UNSAT. Each round strictly
      improves the incumbent and the reachable values are finitely many vertices,
      so it terminates; attainment (open vs. closed) is then settled by one
      `obj = best` query.
- [x] **A phase-2 bounded-variable simplex optimizer** (`SimplexSolver.optimize`)
      — a textbook primal simplex *on the existing feasibility tableau*: reduced
      costs over the non-basic variables, smallest-index improving entering
      variable (Bland's rule ⇒ no cycling), a min-ratio test that either flips a
      variable to its opposite bound or pivots out the first blocking basic. Exact
      Rational/δ-rational throughout, so the optimum is an exact rational vertex
      and a non-zero δ-coefficient certifies an *open* optimum. Purely additive —
      `check()` is unchanged.
- [x] **Weighted MaxSMT** (`maxsmt`) — soft constraints with integer weights,
      reduced to integer OMT: each soft `fᵢ` gets a 0/1 penalty `pᵢ` with
      `fᵢ ∨ pᵢ ≥ 1`, minimizing `Σ wᵢ·pᵢ`. Works over **every theory**, because
      `fᵢ` may be any formula — only the penalty bookkeeping is arithmetic. The
      known bounds `[0, Σwᵢ]` make the search pure binary.
- [x] **SMT-LIB 2 surface syntax** (`src/smt/parse.ts`) — `(minimize t)`,
      `(maximize t)`, and `(assert-soft f :weight w :id g)`, with `get-objectives`
      tolerated. The studio routes on them automatically.
- [x] **`arithModel` on `FullSmtResult`** — the exact numeric assignment (term id →
      Rational) is now exposed from `checkSat` (it was already computed); OMT reads
      it to evaluate objectives and the UI can render exact rationals.
- [x] **`prepareSmt` refactor** — the reduction/trichotomy/theory-wiring pipeline
      is factored out of `checkSat` (behaviour identical) so the LRA optimizer can
      drive the *same* pipeline and reach into the simplex.
- [x] **Studio UI** — eight curated OMT/MaxSMT examples (coin change, 0/1 knapsack,
      a production LP, conflicting weighted preferences, MaxSMT modulo equality, a
      disjunctive min-cost plan, an open infimum, an unbounded objective). The SMT
      Studio detects an objective or soft constraints and shows the optimum (with
      an "open"/not-attained marker), the engine + solver-call count, a
      bound-tightening **search trace**, a **soft-constraint table** (kept vs.
      dropped), and the full optimizing model.
- [x] **Correctness** (`src/smt/selfcheck.ts`) — **200 random QF_LIA programs**
      whose true min *and* max are computed by exhaustive enumeration (the solver
      must match both exactly), **200 random MaxSMT instances** vs. brute-force
      minimum violated weight, exact QF_LRA cases (a vertex LP with an
      `obj > opt ⇒ UNSAT` optimality certificate, an open infimum, an unbounded
      objective, a disjunctive minimum), and end-to-end parser checks (coin change
      → 5 coins; MaxSMT modulo equality → cost 3). All fold into the headless
      `node runtest.mjs` gate.

#### Verified

- Integer OMT returns the *exact* brute-force optimum on every one of 200 random
  LIA programs (both directions) and 200 MaxSMT instances; the LRA simplex finds
  exact rational vertex optima, flags open infima, and detects unboundedness, with
  an independent `obj-beyond-optimum ⇒ UNSAT` certificate. lint + tsc + build +
  the full self-test gate green.

#### Future ideas

- [ ] **Lexicographic / Pareto multi-objective** OMT (the parser already collects
      every `(minimize)`/`(maximize)`; only the first is optimized today).
- [ ] **Core-guided MaxSMT** (an OLL/RC2-style lower-bound loop) alongside the
      model-guided binary search, cross-checking each other as MaxSAT already does.
- [ ] **MILP** (mixed integer + real objectives) via branch-and-bound on the LP
      optimizer — the one case currently reported `unknown`.
- [ ] Run OMT off the main thread via the existing worker/task runner.

### Session 11 — from *deciding* to *proving programs safe*: Craig interpolation + model checking

Every prior session made SatForge decide harder questions about a *single* formula.
This one closes a different loop: it makes the solver reason about **all reachable
states of a system, for all time**. The bridge is **Craig interpolation** — the
quiet theorem that an unsatisfiable `A ∧ B` always has a "summary" `I` that talks
only about the vocabulary `A` and `B` share — and its killer application,
**McMillan-style SAT-based unbounded model checking**. SatForge can now take a
finite-state transition system `(Init, Trans, Bad)` and *prove* the bad state is
unreachable on every execution, returning a machine-checked **inductive
invariant**; or, when it is reachable, a concrete **counterexample trace**. The
whole subsystem is new and self-contained (`src/imc/`), so nothing the prior 277
assertions cover is touched.

The reason this is honest and not hand-wavy is the **two independent oracles** it
is held to — the project's signature move:

- [x] **A proof-logging CDCL solver** (`src/imc/proofSolver.ts`) — a compact
      two-watched-literal CDCL (1-UIP analysis, activity bumping, geometric
      restarts) that, unlike the speed-tuned main engine, **records a resolution
      refutation** when it answers UNSAT: a DAG of leaves (input clauses, tagged
      with their interpolation partition) and resolution steps (with pivots),
      plus the level-0 chain that derives the empty clause. Cross-checked against
      *both* exhaustive truth tables *and* the main SatForge solver on 800 random
      CNFs, with every returned model verified.
- [x] **Craig interpolation by McMillan's system** (`src/imc/interpolant.ts`) —
      partial interpolants are attached to every clause (`⊤` for a B-clause, the
      shared-variable sub-clause for an A-clause) and combined at each resolution
      step (∨ if the pivot is A-local, ∧ otherwise); the empty clause's partial
      interpolant *is* the interpolant. Reads straight off the recorded proof,
      with auxiliary Tseitin variables kept side-local so `vars(I)` stays within
      the shared vocabulary.
- [x] **A from-scratch interpolation-based model checker** (`src/imc/modelcheck.ts`)
      — bounded model checking unrolls `Init ∧ Trans^k ∧ Bad`; when bound *k* is
      UNSAT, the interpolant of `(R ∧ Trans | rest)` over-approximates the one-step
      image while *still* excluding Bad, and iterating it converges to an inductive
      invariant (McMillan 2003). Returns `SAFE` + invariant, `UNSAFE` + shortest
      counterexample, with spurious-abstraction detection that widens the bound.
- [x] **A second, independent proof rule — k-induction** (`kInduction`) —
      base case `Init ∧ Trans^k ∧ ⋁Bad` unsat (no short counterexample) plus an
      inductive step over a **simple path** (`Trans^{k+1} ∧ ⋀¬Bad ∧ Bad_{k+1}` with
      all states pairwise distinct). The simple-path restriction makes it *complete*
      for finite systems, with a completeness shortcut (`k+2 > 2^stateBits ⇒ SAFE`,
      since no longer simple path exists) that also keeps the lightweight solver away
      from the pigeonhole-hard distinct-state UNSAT. The studio runs it beside IMC so
      two independent proofs and the BFS oracle must all agree.
- [x] **A Boolean formula/circuit layer** (`src/imc/formula.ts`) — one
      representation that both **Tseitin-encodes** to CNF (for the SAT engine) and
      **evaluates** under a concrete assignment (for the oracle), plus variable
      renaming (priming/unpriming), constant-folding simplification, and an infix
      pretty-printer for the UI.
- [x] **An independent explicit-state BFS oracle** (`bfsReachability`) — brute-force
      reachability over the whole `2^stateBits` state graph, sharing **no code**
      with the SAT/interpolation path. The self-test asserts the model checker's
      `SAFE`/`UNSAFE` verdict matches it, that every reported invariant is genuinely
      inductive (`Init ⟹ Inv`, `Inv ∧ Trans ⟹ Inv′`, `Inv ⟹ ¬Bad`), and that every
      counterexample replays through `Trans` *and* has the shortest possible length.
- [x] **A "Model Checker" studio** (`src/components/ModelChecker.tsx`, third top-bar
      mode) — a gallery of transition systems (modulo-6 counter, a saturating
      counter that overflows, a mutual-exclusion protocol and its broken variant, a
      traffic-light controller, a token ring), each run live with its verdict, the
      independent-oracle cross-check shown side by side, the discovered inductive
      invariant (or counterexample table), and the interpolation search trace. A
      second **Interpolation** panel computes and exhaustively verifies the
      interpolant of any editable `A`/`B` clause pair.
- [x] **Correctness** (`src/imc/selfcheck.ts`, folded into `selftest.ts`) — 800
      random CNFs (solver vs. brute force vs. main engine + model validity), ~300
      random UNSAT partitions whose interpolants are checked against all three
      Craig properties by exhaustive enumeration, 200 random *total* transition
      systems where the model checker must match the BFS oracle (verdict, inductive
      invariant, and shortest counterexample), and the full curated gallery (matched
      by *both* IMC and k-induction against the oracle). The headless self-test grew
      **277 → 285 assertions**.

#### Verified

- The proof-logging solver agrees with brute force *and* the main solver on 800
  random CNFs; every interpolant produced for ~300 random UNSAT partitions passes
  `A ⟹ I`, `I ∧ B` unsat, and the vocabulary containment by exhaustive check; the
  model checker matches the explicit-state BFS oracle on 200 random total systems
  and the whole gallery (where the independent k-induction proof rule agrees too),
  with every `SAFE` invariant confirmed inductive and every `UNSAFE` counterexample
  confirmed valid and shortest. lint + tsc + build + the full self-test gate green.

#### Future ideas

- [ ] **Lift interpolation to the theories** — interpolants for EUF and LRA (the
      DPLL(T) core already produces theory conflicts), so model checking can run
      over infinite-state systems with arithmetic/array state.
- [ ] **IC3 / PDR** alongside interpolation — incremental, frame-based induction,
      cross-checking the same SAFE/UNSAFE verdict.
- [ ] **A transition-system DSL / editor** in the studio so users can author their
      own circuits and properties (registers, latches, guards) instead of picking
      from the gallery.
- [x] **k-induction** as a second proof rule beside the interpolation fixpoint —
      each certifying the other (added this session).
- [ ] **Liveness** properties (fairness, eventually) as a further proof obligation.
- [ ] Emit the interpolation **resolution proof** in the existing Proof tab and
      DRAT-check it with `src/sat/drat.ts`.

### Session 12 — from *one answer* to *which heuristic wins*: the Solver Lab

For eleven sessions SatForge answered the question "is this formula satisfiable?" — but
*how fast* it answers depends entirely on its heuristics, and a real solver is a stack of
competing folklore (restarts, clause deletion, phase saving, branching order, decay rates)
whose value is established **empirically**, on benchmark suites, with cactus plots. Session 12
makes that science a first-class part of the studio: a **Solver Lab** that races the same
proved-correct CDCL engine against itself under different heuristic settings and scores the
field the way the SAT Competition does — while doubling as a *soundness oracle*, because every
configuration must reach the **same verdict** on every instance it decides.

The pitch: the Lab is the rare benchmark that can fail. If flipping a heuristic ever changed
an answer (SAT ↔ UNSAT), or produced a model that didn't satisfy its formula, the soundness
banner turns red — so the same panel that says "restarts make us 3× faster" also continuously
re-proves that none of these knobs can make us *wrong*.

**Solver knobs (turn the heuristics into parameters).** The engine already exposed `varDecay`,
`clauseDecay`, `restartBase`, `randomFreq` and `minimize`; this session adds the missing toggles
and fixes a latent bug so the comparison is honest:

- [x] `phaseSaving?: boolean` — when off, decisions always branch false-first (the MiniSat
      default polarity) instead of re-using each variable's last value.
- [x] `restarts?: boolean` — when off, the Luby restart machinery is disabled entirely.
- [x] `reduceDb?: boolean` — when off, learnt clauses are never deleted (the database grows
      without bound — great for showing why deletion matters).
- [x] `branch?: 'vsids' | 'random'` — a genuinely **uniform** random variable choice. (The old
      `randomFreq` "random" branch actually still popped the VSIDS max — a no-op; fixed by a new
      `VarOrderHeap.removeRandom(r)` that removes a uniformly-random element while keeping the
      heap and its position map consistent.)
- [x] All toggles default to *on*, so every prior session's 285 self-tests run the identical
      code path and are unaffected.

**The benchmark engine (`src/sat/lab.ts`) — pure functions, no UI.**

- [x] **A curated configuration matrix** (`PRESET_CONFIGS`): the full solver plus ten single-knob
      ablations (no restarts / no clause deletion / no minimization / no phase saving / random
      branching / fast & slow VSIDS decay / aggressive & lazy restarts), each carrying a one-line
      explanation shown in the UI.
- [x] **A reproducible suite generator** (`generateSuite`) — a pure function of `{ seed, scale,
      families }` mixing easy and hard, SAT and UNSAT, random and structured instances:
      random 3-SAT swept across the α ≈ 4.26 phase transition, pigeonhole `PHP(n+1→n)` (the
      classic exponential-resolution UNSAT family), random graph k-coloring near the threshold,
      and Langford pairings (with their `n ≡ 0,3 (mod 4)` SAT oracle). Instances carry an
      `expected` verdict where it's known a priori.
- [x] **A budgeted runner** (`runOne` / `benchSteps` / `runBench`) — solves each (config ×
      instance) cell under a conflict + time budget, recording status, time, conflicts,
      decisions, propagations, restarts and learnt count, and **re-verifying every SAT model**.
- [x] **SAT-Competition scoring** (`summarize`) — solved counts and the standard **PAR-2** score
      (a timed-out instance is charged twice the cap), plus **cactus-plot data** (`cactus`):
      each config's solved-instance times sorted and accumulated, so a curve that reaches further
      right and stays lower is the strictly better solver.
- [x] **The soundness oracle** (`agreementErrors`) — cross-checks all configurations against each
      other and against ground truth: a SAT-vs-UNSAT split, a contradicted `expected`, or an
      invalid model are each flagged. On a healthy build it returns `[]`.

**Off-thread execution.** A dedicated `src/worker/lab.worker.ts` streams one progress message per
cell so the sweep never freezes the page, with a chunked main-thread fallback (for the sandboxed
catalog thumbnail) that yields between cells — mirroring the project's existing worker+fallback
pattern.

**The Solver Lab studio (`src/components/SolverLab.tsx`), a fourth top-level mode.**

- [x] Controls: family checkboxes, a difficulty/size dial, a suite seed, conflict & time caps,
      and a configuration picker with color swatches and hover descriptions.
- [x] A **soundness banner** (green "every configuration agrees / red violation list") computed
      live from `agreementErrors`.
- [x] A from-scratch **SVG cactus plot** with axes, gridlines, a legend and a linear/log-time
      toggle.
- [x] A **leaderboard** ranked by solved-then-PAR-2, with per-config solved bars, PAR-2, total
      time and mean conflicts/decisions, best row highlighted.
- [x] A **per-instance heatmap** — every cell colored by speed relative to the fastest solver on
      that instance (green → red), `✕` for budget timeouts, with a rich tooltip per cell.

**Correctness (the Lab tests *itself*).** Five new self-test assertions in `selftest.ts`:

- [x] All eleven preset configurations match **exhaustive truth-table brute force** on 200 small
      random CNFs (verdict + every returned model verified) — the direct proof that the new
      toggles preserve soundness *and* completeness.
- [x] On the generated suite, `agreementErrors` is empty (configs agree + respect ground truth),
      every instance gets a **unanimous** verdict, every SAT result anywhere in the matrix
      re-verified its model, and the `summarize`/`cactus` aggregations are well-formed and mutually
      consistent (PAR-2 ≥ solved time, cactus length = solved count, cumulative times monotone).
- [x] lint + tsc + build + the full self-test gate green (**290** assertions).

#### Future ideas

- [ ] Persist suites + results to `localStorage` and diff two runs ("did my change regress?").
- [ ] A per-instance **search-dynamics overlay** (conflicts/sec, restart cadence) for two configs
      side by side, reusing the existing history-sample chart.
- [ ] Import a folder of DIMACS files as a custom suite; export results as CSV.
- [ ] A "tournament" mode that auto-tunes one knob (e.g. `restartBase`) by bisection on PAR-2.
- [ ] Wire the same harness over the **MaxSAT** and **SMT** engines (strategy/theory ablations).

### Session 13 — from *one safety proof* to *three*: IC3 / PDR

Session 11 gave SatForge its first unbounded-safety prover (Craig interpolation) and a second
proof rule (k-induction). Session 13 adds the algorithm that actually dethroned interpolation in
practice and powers every modern hardware model checker: **IC3 / PDR — Property-Directed
Reachability** (Bradley, *VMCAI 2011*; Eén–Mishchenko–Brayton, *FMCAD 2011*). It is a genuinely
different idea, not a variation on what we had: where interpolation derives an invariant from a
*global* resolution proof of a bounded unrolling, **IC3 never unrolls `Trans` at all**. It grows a
ladder of over-approximating frames F₀=Init ⊆ F₁ ⊆ … ⊆ Fₖ — each a conjunction of CNF clauses —
and strengthens them using nothing but *single-step* SAT queries, blocking each reachable bad
state with a freshly *learned, inductively generalized* clause. When two adjacent frames coincide,
their conjunction is an inductive invariant: a checkable proof of safety for executions of *any*
length.

This is the real algorithm, built from scratch on the project's existing pieces — the `Formula`
layer, the Tseitin `CnfBuilder`, and the proof-logging `solveCnf` SAT backend — not a toy.

**The engine (`src/imc/pdr.ts`).**

- [x] **Monotone CNF frames** F₀=Init ⊆ F₁ ⊆ … with Bradley's representation: a clause learned at
      frame *i* is added to every frame ≤ *i*, so `Fᵢ ⊇ Fᵢ₊₁` as clause sets is an invariant — and
      a fixpoint is detected by a simple set-equality of two adjacent frames.
- [x] **Recursive proof-obligation blocking** with a min-frame-first priority queue: a bad cube at
      Fₖ spawns predecessor obligations at lower frames; a chain that reaches F₀ (an initial state)
      is a counterexample, otherwise each obligation is discharged by a learned blocking clause.
- [x] **Relative-induction queries** `SAT(Fᵢ ∧ ¬s ∧ Trans ∧ s′)` — the one-step heart of PDR — for
      both predecessor extraction and "is ¬s inductive relative to Fᵢ?".
- [x] **Inductive generalization (MIC)** — Bradley's minimal-inductive-clause: drop literals from a
      blocking cube as long as ¬s stays inductive relative to the previous frame *and* excludes
      Init, so a single query prunes an exponential set of states. (The self-test shows it routinely
      drops a third of the literals.)
- [x] **Clause propagation / pushing** — after each frame extension, push every clause as far
      forward as it stays inductive; coincident adjacent frames ⇒ SAFE with an inductive invariant.
- [x] **Counterexample materialization** — IC3 establishes *unsafety* by reaching F₀; the shortest
      concrete witness is then produced by an honest bounded unrolling (`Init ∧ Tᴸ ∧ Bad`) and is
      validated by the same `checkCounterexample` gate the other engines use.
- [x] **Instrumentation** — per-run stats (frames, clauses, SAT queries, obligations, literals
      dropped by MIC, clauses pushed) and a structured search trace, surfaced in the UI.

**Cross-checks (`src/imc/selfcheck.ts`) — PDR has to earn its verdict three times over.**

- [x] On **220 random transition systems**, PDR's verdict matches the explicit-state **BFS oracle**,
      every SAFE result carries a *genuinely inductive* invariant (re-checked by `checkInvariant`),
      every UNSAFE result a *valid and shortest* counterexample, and PDR's verdict **agrees with both
      IMC and k-induction** on every decided instance (a four-way cross-check).
- [x] On the **curated gallery**, PDR matches BFS on every example with all invariants/counter­
      examples machine-checked.
- [x] Six new assertions; the full gate is now **296 assertions, all green**.

**New gallery examples (`src/imc/examples.ts`).** A real-hardware **maximal-length 4-bit LFSR**
(taps x⁴+x³+1) — the workhorse of scramblers and PRNGs — whose safety property "never latches up in
the all-zero state" is proven by PDR with the one-clause invariant *register ≠ 0*; plus a **broken,
mis-wired variant** that *can* shift in all zeros, for which all three engines return the concrete
lock-up sequence.

**UI (`src/components/ModelChecker.tsx`).** The Model Checker now presents **four** verdicts side by
side (IMC, IC3/PDR, k-induction, BFS oracle) and only shows "✓ all four agree" when they do. A new
**IC3/PDR proof panel** visualizes the algorithm: a live **frame ladder** (clauses learned per
frame), a stats grid (frames / SAT queries / obligations / literals dropped by MIC / clauses
pushed), and PDR's *own* inductive invariant with its three machine-checked conditions — a proof
discovered by a completely different route than the interpolation invariant shown above it.

#### Future ideas

- [ ] **Ternary simulation / lifting** of predecessor cubes (drop don't-care state bits before MIC)
      to cut SAT queries on wider systems.
- [ ] **CTG-guided generalization** (Hassan–Bradley–Somenzi) — block counterexamples-to-generalization
      to learn stronger clauses.
- [ ] Let the studio accept a **user-typed transition system** (DIMACS-style Init/Trans/Bad) and run
      all four engines on it live.
- [ ] An **animated frame-ladder replay** that steps through blocking/propagation events from the trace.

### Session 14 — from *counting* to *compiling*: knowledge compilation to sd-DNNF

Session 3 added a #SAT counter that returns a *number*. Knowledge compilation goes one level deeper:
it pays for the search **once**, recording it as a circuit, and then a whole family of otherwise
#P-hard queries collapses to a single linear-time pass over that circuit. Same DPLL search — but
instead of a count you keep the *structure*, and it answers question after question for free.

**The compiler (`src/sat/ddnnf.ts`).**

- [x] **Compile CNF → smooth d-DNNF** (`compileDdnnf`). The recursion is the #SAT search recorded
      as a shared DAG: unit propagation → an AND of forced-literal leaves; a vanished variable →
      a free `OR(x, ¬x)` "coin-flip"; independent sub-formulas → a *decomposable* AND (children share
      no variables); a branch on the busiest variable → a *deterministic* OR (the arms disagree on
      that variable, so their model sets are disjoint). Unsatisfiable branches are collapsed away.
- [x] **Component caching** keyed by the canonical clause set, so a sub-formula that recurs across
      the search is compiled once and *shared* — the circuit is a DAG, not a tree (the c2d/Dsharp idea).
- [x] **Smooth by construction** — emitting forced and free literals explicitly makes both arms of
      every OR mention exactly the same variables, which is what lets the queries be a clean ∏ / Σ.
- [x] **A reachability GC** compacts the node table into a still-topological array (children before
      parents) after the search leaves cached-but-unused branches behind.

**Linear-time queries over the compiled circuit.**

- [x] **Exact model count** (`ddnnfCount`) — one BigInt pass: AND multiplies, OR adds.
- [x] **Weighted model counting** (`ddnnfWmc`) — arbitrary per-literal weights; the partition
      function behind exact probabilistic inference. Uniform weights tie it to #SAT: `Z = count / 2ⁿ`.
- [x] **Exact variable marginals in one forward + backward sweep** (`ddnnfMarginals`) — the
      Darwiche *differential of an arithmetic circuit*: `w[ℓ]·∂Z/∂w[ℓ] = WMC(f ∧ ℓ)`, so every
      variable's exact `Pr(xᵢ = true)` falls out of a single backpropagation. Exact precisely
      because the circuit is decomposable + deterministic + smooth.
- [x] **Most-probable explanation** (`ddnnfMpe`) — the single likeliest assignment, by a max-product
      pass (the OR's Σ becomes max); exact because the circuit is deterministic + decomposable, and
      complete because it is smooth.
- [x] **Model enumeration** (`ddnnfEnumerate`) straight off the circuit — each model produced once
      (determinism) by AND cross-products and OR unions.
- [x] **Structural certificates** (`verifyCircuit`) — independently *proves* the compiled circuit is
      smooth, decomposable and deterministic; surfaced in the UI as three verified badges.
- [x] **`.nnf` export** (`toNnf`) in the standard c2d/Dsharp format, downloadable.

**UI (`src/components/CompileView.tsx`, a new "Compile" tab).** Compiles off-thread (new `compile`
worker op + `compileDdnnfTask`), then shows the verified sd-DNNF property badges, a circuit-stats grid
(nodes / edges / decision / AND / literal / sub-formula reuse / compile time), the exact model count,
and a **weighted-inference panel**: a "tilt" slider sets each variable's positive-literal weight `p`
(negative `1−p`) and the **weighted model count**, a **live variable-marginal bar chart**, and the
**most-probable explanation** all recompute in real time — each a single linear pass over the same
compiled circuit. At `p = 0.5` the bars are the exact fraction of solutions in which each variable is
true.

**Cross-checks (folded into `selftest.ts`).** On **1200 random CNFs** (2–12 vars): the compiled count
equals both #SAT and brute force; every circuit is verified smooth + decomposable + deterministic; the
weighted model count matches brute force under random per-literal weights (and `count/2ⁿ` under uniform
weights); the one-pass differential marginals match brute force exactly (including the partition `Z`);
the max-product **MPE** matches brute force and its returned assignment is a genuine satisfying model of
that weight; and the enumeration equals the exact model set with **no duplicates**. Plus hand cases
(empty formula `2ⁿ`, contradiction `0`, forced-literal marginal `1`, free-literal marginal `0.5`,
N-Queens counts off the circuit, `.nnf` header consistency). **17 new assertions; the gate is now 313,
all green.**

#### Future ideas

- [ ] **Compile larger encoders** (Sudoku, graph coloring) with a smarter dtree/min-fill variable
      order so the DAG stays small on structured instances.
- [ ] **Conditioning & projection** on the compiled circuit (clamp literals / forget variables) to
      answer follow-up queries without recompiling.
- [x] **MPE / most-probable explanation** (a max-product pass) alongside the sum-product marginals —
      `ddnnfMpe`, surfaced in the Compile tab and cross-checked against brute force.
- [ ] A **circuit visualization** (the sd-DNNF DAG) in the Compile tab, like the implication graph.

### Session 15 — from *one quantifier* to *all of them*: a QBF solver (PSPACE)

Every engine SatForge has built so far lives in **NP / co-NP**: SAT, #SAT, MaxSAT, the theories,
even unbounded model checking (which it discharges with NP-sized SAT queries). **QBF** —
Quantified Boolean Formulas, where the variables come in alternating ∃/∀ blocks — is the canonical
**PSPACE-complete** problem, a strict step up the hierarchy. A QBF is not a search for *an*
assignment; it is a two-player **game**: ∃ tries to satisfy the matrix, ∀ tries to break it, and
the formula is *true* exactly when ∃ has a winning strategy against every ∀ response. One ∃∀
alternation already captures "∃ a robust solution that survives *every* adversarial input" —
synthesis, planning under uncertainty, two-player games — that plain SAT simply cannot phrase.

The point of this session: decide the **whole quantifier hierarchy** on the *same CDCL core*, with
the same "watch it think" honesty, and prove it correct against an independent oracle.

**The model + front-end (`src/qbf/qdimacs.ts`).**

- [x] A prenex QBF type: a quantifier **prefix** (outermost-first ∃/∀ blocks) over a CNF **matrix**,
      sharing the exact DIMACS-literal convention as the rest of SatForge.
- [x] A tolerant **QDIMACS** parser + serializer (the standard `e …/a …/0` prefix lines), and a
      `normalizeQbf` that merges adjacent same-quantifier blocks and binds free variables ∃-outermost.
- [x] `prefixString` / `alternations` for the UI.

**The solver (`src/qbf/solver.ts`) — counterexample-guided expansion (the RAReQS idea).**

- [x] The quantifier game is played **one block at a time**. At an ∃ block the solver searches for an
      X-move τ that *wins the rest of the game*; at a ∀ block, for an X-move that *refutes* it.
- [x] Candidates are proposed by a **SAT call** over a growing set of **blocking clauses** (the moves
      already shown to fail), then checked **exactly** by recursing on the block-stripped subgame —
      each recursive call substitutes the chosen move into the matrix, so the recursion is
      well-founded and the per-block loop is a genuine CEGAR loop driven by the CDCL engine.
- [x] When a candidate fails, the recursion hands back the **opponent's winning counter-move**, which
      is recorded and rules that candidate out — until the searching player either wins or provably
      runs out of moves (the SAT call goes UNSAT), which decides the block.
- [x] Single-block base cases: ∃X.φ is a plain SAT query; ∀X.φ is decided by **validity** (every
      clause a tautology), returning a concrete falsifying assignment otherwise.
- [x] Returns a **decisive certificate** for the outer block — the winning ∃ assignment (SAT) or the
      refuting ∀ assignment (UNSAT) — plus a full per-iteration **refinement trace** and search stats.
- [x] Explicit refinement / conflict budgets → a clean `'unknown'` instead of hanging.

**The oracle + encoders (`src/qbf/eval.ts`, `src/qbf/encoders.ts`).**

- [x] An independent **exhaustive evaluator** — recursive Shannon expansion over the prefix
      (∃ = OR, ∀ = AND, short-circuited) — the QBF analog of the DRAT checker and the BFS oracle:
      a second, dumber procedure the solver must always agree with.
- [x] **Scalable families with values known by construction:** the *copy game*
      (∀ū ∃ȳ. ⋀ yᵢ↔uᵢ is TRUE because ∃ reacts; the ∃∀ swap is FALSE because ∃ commits) and the
      *parity ladder* (alternating single-bit blocks over an XOR-is-even matrix — TRUE iff the
      innermost block is ∃), both checkable far past brute-force range.
- [x] A seeded **random prenex QBF** generator, and a curated example set with explanations.

**The studio (`src/components/QbfStudio.tsx`).** A new **QBF Studio** mode: a QDIMACS editor with a
live prefix/alternation readout, the example list + a random generator, the **TRUE/FALSE/UNKNOWN**
verdict with its **brute-force agreement badge**, a **verified winning-move** certificate (re-checked
by substituting it back and re-evaluating the residual with the oracle), search-effort stats, and a
colour-coded **refinement trace** of the outermost block (candidate → win/refute/block → exhausted).

**Cross-checks (folded into `selftest.ts`).** The headline test is a **1500-instance random
cross-check** — RAReQS verdict vs. the exhaustive oracle over random QBFs of 1–4 alternating blocks —
with **zero mismatches**, plus: every returned witness re-verified as a genuine winning move; the
copy-game and parity-ladder families at every width 1–9; a QDIMACS serialize→parse round-trip; and
determinism. **62 new assertions; the gate is now 375, all green.** (The first design — dualizing the
whole formula at each ∀ via Tseitin negation — was scrapped when it failed to terminate: the
auxiliary blocks accumulated and got re-flipped. The block-at-a-time game formulation is both
correct and obviously well-founded; the oracle caught the bug instantly.)

#### Future ideas

- [ ] **Universal/existential expansion generalization** (drop the blocking clause down to a learned
      *reason* over a subset of the block) so the per-node loop beats its 2^|X| worst case.
- [ ] **Long-distance Q-resolution proofs** with an independent checker — the QBF analog of the
      DRAT tab, certifying FALSE the way DRAT certifies UNSAT (and a Skolem-function certificate for TRUE).
- [ ] **Dependency schemes / mini-scoping** preprocessing to shrink the prefix before solving.
- [ ] A **game encoder** (Generalized Geography / a bounded positional game) cross-checked against a
      from-scratch retrograde game solver, turning the abstract verdict into "does Player 1 win?".
- [ ] Run QBF off the main thread via the existing worker/task runner for larger instances.

## Session log

- 2026-06-20 (claude): Climbed from NP/co-NP to **PSPACE** — a from-scratch **QBF solver** for the
  full quantifier hierarchy on the same CDCL core (`src/qbf/*`). Decides arbitrary prenex QBF by
  **counterexample-guided expansion** (the RAReQS idea): the quantifier game is played one block at
  a time, candidates proposed by SAT over a growing blocking-clause set and the opponent's
  counter-moves learned from the exact, block-stripped recursion. Added a tolerant **QDIMACS**
  front-end, an independent exhaustive **Shannon-expansion oracle**, scalable families with values
  known by construction (copy game, parity ladder), a random generator, and a new **QBF Studio**
  tab — verdict + brute-force agreement badge, a verified winning-move certificate, search stats,
  and a colour-coded refinement trace. Test harness **313 → 375** (62 new), headlined by a
  1500-instance random solver-vs-oracle cross-check with zero mismatches and per-witness
  verification. (Scrapped a first whole-formula-dualization design that didn't terminate; the
  block-at-a-time game formulation is well-founded and the oracle caught the bug immediately.)
  Lint + build + full gate green.
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
- 2026-06-16 (claude): Went from *bits* to **memory** — a complete **QF_AX theory of arrays**
  (McCarthy `select`/`store`, constant arrays, and full **extensionality**) added with **zero
  new theory solvers**, by *reducing* arrays to the EUF + arithmetic the DPLL(T) engine already
  has (`src/smt/arrays.ts`). **Read-over-write purification** recursively rewrites every
  `select(store(a,i,v), j)` into a fresh element pinned by the McCarthy axioms `(i=j→e=v) ∧
  (i≠j→e=read(a,j))` — recursing through nested writes and constant arrays — so surviving reads
  become an uninterpreted function the existing **congruence closure** handles, and reads of Int
  cells flow straight into the **simplex** (so QF_ALIA just works, Ackermann-combined like
  UFLIA). **Extensionality** encodes each array-equality atom with a Skolem **witness index**
  plus agreement clauses over a **saturated index set** (the Stump–Barrett–Dill scheme, finite
  and ground); dropping those clauses leaves a sound, complete procedure for the non-extensional
  fragment. New first-class array terms in `term.ts` (`(Array I E)` sorts, `select`/`store`/
  constant arrays with `a[i]` / `a[i↦v]` / `const(v)` rendering); the SMT-LIB parser learned
  `(Array I E)` sorts, `select`/`store` and `((as const …) v)`; the **SMT Studio** renders the
  array contents the solver committed to as **per-array cell tables** and got `QF_AX`/`QF_ALIA`
  badges, plus 6 array examples (read-over-write ×2, commuting writes, extensionality, constant
  array, QF_ALIA). Made Ackermann name its fresh constants after the term they stand for (`a[0]`,
  `f(x)`) so every mixed-theory **model stays legible**. Certified the project's way — an
  **independent finite-model enumerator** (`src/smt/arrayref.ts`, sized by the array small-model
  property, sharing no code with the reduction) cross-checked against ~3700 random array formulas
  in two batches: **2500 non-extensional** (reads/writes/const arrays only) and **1200
  extensional** (array `=`/`distinct`), verdicts always agreeing — caught two real bugs (an
  unsaturated index set for stores hidden in array equalities; an under-sized element domain in
  the oracle) before they could mislead. Harness grew **208 → 231 assertions**. Lint + build +
  full gate green.
- 2026-06-16 (claude): Went from *memory* to **structure** — a complete **QF_DT theory of
  algebraic datatypes** (constructors, selectors, testers: lists, trees, pairs, enums, `Nat`)
  added with **zero new theory solvers**, by *reducing* datatypes to the EUF + linear-integer
  arithmetic the DPLL(T) engine already has (`src/smt/datatypes.ts`). The reduction is purely
  *additive* — every datatype operation is already an ordinary term, so it only conjoins the
  free-term-algebra axioms instantiated on the ground terms: **exactly-one-tester**
  (exhaustiveness + disjointness), **constructor pinning** (`is_C(C(…))`, `selᵢ(C(a))=aᵢ` — which
  gives **injectivity** for free through selector congruence), the **tester link**
  `is_C(t) → t = C(sel₁(t),…)` (instantiated to a bounded selector depth so recursive types stay
  finite), and the one genuinely non-EUF ingredient, **acyclicity by integer rank**: a fresh
  `rank : D → Int` with `rank(t) > rank(child)` on every constructor edge, so over a *finite* set
  of ground terms a strict `>` ordering is exactly "no term is its own subterm" — `x = cons(a,x)`
  is refuted by the existing **simplex / branch-and-bound**. Datatypes thus become QF_UFLIA,
  Ackermann-combined like UFLIA / QF_ALIA already are (so QF_DTLIA — datatypes with integer
  fields — just works). New first-class datatype registry in `term.ts`
  (`declareDatatypes`, two-phase for mutual recursion); the SMT-LIB parser learned
  `declare-datatype`/`declare-datatypes`, nullary-constructor shorthand, constructor/selector
  applications and the tester `((_ is C) t)`; the **SMT Studio** gained `QF_DT`/`QF_UFDT`/
  `QF_DTLIA` badges and 8 datatype examples (list read-back, injectivity, the impossible cyclic
  list, enum exhaustiveness, a Peano successor, a branching tree, a typed Int-list head). Certified
  the project's way — an **independent finite-tree-model enumerator** (`src/smt/dtref.ts`, sized by
  the term-algebra small-model property, sharing no code with the reduction: every value is a real
  constructor tree, testers read the real root, equality is structural) cross-checked against
  ~1500 random datatype formulas, verdicts always agreeing — which caught a real bug in the oracle
  (nullary constructors like `nil` mis-read as free variables) before it could mislead. Harness
  grew **231 → 259 assertions**. Lint + build + full gate green.
- 2026-06-17 (claude): Went from *structure* to **text** — a complete **QF_S bounded theory of
  strings**, the hardest classic SMT theory (unbounded string/word equations are undecidable),
  added with **zero new theory solvers** by *reducing* it to the EUF + linear-integer arithmetic
  the DPLL(T) engine already has (`src/smt/strings.ts`). Every string term is modelled by its
  length `|s|` — the engine's own `str.len` symbol, **reused** as the length variable so a length
  constraint is *already* a simplex atom — plus `L` integer **code-units** `str.char$(s,k)`, an
  uninterpreted `String×Int→Int` function (so EUF gives congruence for free, `s = t ⇒
  char(s,k)=char(t,k)`, and the existing **Ackermann** combination folds it into the simplex —
  exactly the QF_ALIA pattern). Well-formedness pins padding past the end to a `−1` sentinel, so a
  string's value *is* its code-units and equal code-units ⟺ equal strings. **McCarthy-style
  per-operator axioms** unfold each operation over the `≤ L` positions into ordinary `eq` / `arith`
  atoms: `str.++` (`|a·b| = |a|+|b|` with each result slot an `ite` over the split point),
  `str.at`, SMT-LIB-faithful `str.substr` (offset/length clamping), `str.contains` /
  `str.prefixof` / `str.suffixof` (a length guard + position-wise code-unit equalities over the
  candidate window), and `str.indexof` (the result pinned by a per-value biconditional over the
  occurrence predicate: least matching offset, or `−1`). **String equality is kept as an EUF atom**
  (so uninterpreted functions over strings still get congruence) **and** tied to position-wise
  code-unit agreement, so `=` means *value* equality (`"ab"·"c" = "abc"`), not term identity. The
  alphabet is constrained only up to equality, so the **small-model property** makes the procedure
  sound and complete **within the length bound** — `x = "a"·x` is refuted by the simplex straight
  from `|x| = 1 + |x|` (acyclicity, for free, just like the datatype `rank`). The string reduction
  runs first (outermost) in `checkSat`, feeding its EUF + integer output through the unchanged
  datatypes/arrays/Ackermann/trichotomy pipeline. The **SMT-LIB parser** learned the `String` sort,
  double-quoted literals (`""`-escaping) and the `str.*` operators (n-ary `str.++` folded to the
  binary symbol); the **SMT Studio** got a `QF_S` badge, eight `QF_S` examples (concat split, the
  impossible self-append, a substring read-back, prefix/suffix/contains, value-vs-identity
  equality, `str.indexof`) and a reconstructed **string-model** view (each variable's solved text,
  read back from the numeric length + code-units). Certified the project's way — an **independent
  concrete-string enumerator** (`src/smt/strref.ts`, sized by the small-model property, evaluating
  every operator with plain JavaScript string semantics, sharing no decision code with the
  reduction) cross-checked against **~900 random string formulas** in two batches (bound 2 with two
  variables; a deeper bound 3 with one variable), verdicts always agreeing, plus 21 hand cases and
  two model-readback checks (the concat split reads back `x="a", y="b"`; the commuting append
  `x="aa"`). Harness grew **259 → 267 assertions**. Lint + build + full gate green.
- 2026-06-18 (claude): Went from *deciding* to **optimizing modulo theories** — added an **OMT +
  MaxSMT** optimization layer on top of the existing DPLL(T) engine (`src/smt/omt.ts`,
  `omt-lra.ts`), unifying the project's MaxSAT (Session 4) and SMT (Session 5+) crowns. SatForge
  now answers *"what is the best model?"* over any theory combination. Two exact, terminating
  engines: **integer-objective OMT** by an exponential-bracket + binary search on the objective
  bound (every QF_LIA objective and every MaxSMT cost is integral, so the search is finite and the
  optimum exact — no floating point), and **real-objective OMT (QF_LRA)** by *theory optimization
  inside the Boolean search* — each round asks DPLL(T) for a model beating the incumbent, then
  jumps to that branch's exact rational vertex with a new from-scratch **phase-2 bounded-variable
  simplex** (`SimplexSolver.optimize`: reduced costs, Bland's-rule entering, min-ratio bound-flip /
  pivot, exact δ-rationals so open infima/suprema and unboundedness are detected), tightens the
  strict bound, and repeats to UNSAT (terminating over the finitely-many vertices). **Weighted
  MaxSMT** reduces to integer OMT (a 0/1 penalty per soft constraint, minimize Σwᵢpᵢ) and so works
  over *every* theory — EUF, LIA/LRA, arrays, datatypes, strings — since only the penalty
  bookkeeping is arithmetic. The simplex gained `optimize` and `checkSat` now exposes the exact
  numeric `arithModel`, both purely additive (no theory `check` changed); `prepareSmt` was factored
  out of `checkSat` (identical behaviour) so the LRA optimizer drives the same pipeline. The
  **SMT-LIB parser** learned `(minimize t)` / `(maximize t)` / `(assert-soft f :weight w :id g)`,
  and the **SMT Studio** auto-routes on them, showing the optimum (with an open/not-attained
  marker), the engine + solver-call count, a bound-tightening **search trace**, a kept-vs-dropped
  **soft-constraint table**, and the full optimizing model — with eight new examples (coin change,
  0/1 knapsack, a production LP, conflicting weighted preferences, MaxSMT modulo equality, a
  disjunctive min-cost plan, an open infimum, an unbounded objective). Certified the project's way:
  **200 random QF_LIA programs** whose true min *and* max come from exhaustive enumeration (the
  solver must match both exactly), **200 random MaxSMT instances** vs. brute-force minimum violated
  weight, exact QF_LRA cases (a vertex LP with an `obj > opt ⇒ UNSAT` optimality certificate, an
  open infimum, an unbounded objective, a disjunctive minimum) and end-to-end parser checks. Harness
  grew **267 → 277 assertions**. Lint + build + full gate green.
- 2026-06-18 (claude): Went from *deciding formulas* to **proving programs safe** — added a
  from-scratch **Craig interpolation** engine and an **interpolation-based safety model checker**
  (McMillan 2003), a whole new self-contained subsystem (`src/imc/`) that leaves the prior 277
  assertions untouched. Built a **proof-logging CDCL** (`proofSolver.ts`: two-watched literals,
  1-UIP analysis, restarts) that records a full **resolution refutation** — a DAG of partition-
  tagged leaves and pivoted resolution steps plus the level-0 empty-clause chain — so McMillan's
  algorithm (`interpolant.ts`) can read an interpolant straight off it (⊤ for B-clauses, the
  shared sub-clause for A-clauses, ∨/∧ at each step by pivot locality), with Tseitin aux vars kept
  side-local so `vars(I)` stays in the shared vocabulary. On top, a model checker
  (`modelcheck.ts`) unrolls bounded model checking and iterates the interpolant of `(R∧Trans | rest)`
  into an **inductive invariant** proving the bad state unreachable *for all time* — or returns a
  shortest **counterexample** — with spurious-abstraction detection that widens the bound. A
  one-representation Boolean **formula/circuit layer** (`formula.ts`) both Tseitin-encodes to CNF
  and evaluates concretely, which is what lets an **independent explicit-state BFS oracle**
  (`bfsReachability`, sharing no code with the SAT path) certify every verdict. New **Model Checker**
  studio mode (`ModelChecker.tsx`): a gallery (modulo-6 counter, overflow counter, mutual exclusion
  + a broken variant, traffic-light controller, token ring) run live with verdict, the BFS
  cross-check shown beside it, the discovered invariant or counterexample table and the
  interpolation search trace; plus an **Interpolation** panel that computes and exhaustively
  verifies the interpolant of any editable A/B clause pair. Also added a **second, independent
  proof rule — simple-path k-induction** (`kInduction`, with a `k+2 > 2^stateBits ⇒ SAFE`
  completeness shortcut that dodges the pigeonhole-hard distinct-state UNSAT), run beside IMC in
  the studio so two proofs and the oracle must all agree. Certified the project's way: the proof
  solver agrees with brute force **and** the main engine on **800 random CNFs** (models verified),
  **~300 random UNSAT partitions** whose interpolants pass all three Craig properties by exhaustive
  enumeration, **200 random total transition systems** where the checker must match the BFS oracle
  on verdict, inductive invariant, *and* shortest counterexample, plus the full curated gallery
  (matched by both IMC and k-induction). Harness grew **277 → 285 assertions**. Lint + build +
  full gate green.
- 2026-06-19 (claude): Went from *one answer* to **which heuristic wins** — a **Solver Lab** that
  races the same proved-correct CDCL engine against itself across a reproducible benchmark suite,
  scoring the field the SAT-Competition way (cactus plot + PAR-2) while doubling as a soundness
  oracle. Turned the engine's folklore into parameters: new `phaseSaving` / `restarts` / `reduceDb`
  toggles and a `branch: 'vsids' | 'random'` mode, the latter backed by a new
  `VarOrderHeap.removeRandom` that fixes a latent bug (the old `randomFreq` "random" branch still
  popped the VSIDS max, a no-op) — all defaulting *on*, so the prior 285 tests run unchanged. New
  pure engine `src/sat/lab.ts`: a curated 11-config single-knob ablation matrix, a seed+scale
  reproducible suite generator (random 3-SAT at the α ≈ 4.26 phase transition, pigeonhole UNSAT,
  graph coloring, Langford), a budgeted runner that re-verifies every SAT model, SAT-Competition
  scoring (`summarize` PAR-2 + `cactus`), and `agreementErrors` — the cross-config soundness check
  that flags any SAT-vs-UNSAT split, contradicted ground truth, or invalid model. A dedicated
  `lab.worker.ts` streams progress off-thread (chunked main-thread fallback for the sandboxed
  thumbnail). New **Solver Lab** studio mode (`SolverLab.tsx`, fourth top-level tab): suite/budget/
  config controls, a live green/red **soundness banner**, a from-scratch SVG **cactus plot**
  (linear/log toggle), a PAR-2 **leaderboard**, and a **per-instance heatmap** colored by relative
  speed. Harness grew **285 → 290 assertions**: all 11 configs matched exhaustive brute force on
  200 random CNFs (verdicts + models), the suite decided unanimously and matched ground truth,
  every SAT result re-verified its model, and the summary/cactus aggregations checked well-formed
  and mutually consistent. Lint + build + full gate green.
- 2026-06-19 (claude): Gave SatForge its **third independent unbounded-safety prover — IC3 / PDR**
  (`src/imc/pdr.ts`), built from scratch on the existing `Formula`/`CnfBuilder`/`solveCnf` stack.
  Property-directed reachability: monotone over-approximating CNF frames F₀=Init ⊆ F₁ ⊆ …, recursive
  proof-obligation blocking with a min-frame priority queue, relative-induction one-step SAT queries
  (`Fᵢ ∧ ¬s ∧ Trans ∧ s′`), Bradley's inductive generalization (MIC — drops ~⅓ of literals),
  clause propagation with adjacent-frame fixpoint detection ⇒ inductive invariant, and shortest
  counterexamples materialized by an honest bounded unrolling. It never unrolls `Trans`. Wired into
  the Model Checker UI as a fourth side-by-side verdict (IMC / PDR / k-induction / BFS, "✓ all four
  agree") with a new proof panel: a live frame-ladder bar chart, a stats grid (frames / SAT queries /
  obligations / MIC literal drops / clauses pushed), and PDR's own machine-checked inductive
  invariant. Added a real-hardware **maximal-length LFSR** gallery example (invariant *register ≠ 0*)
  plus a mis-wired lock-up variant. Six new self-test assertions cross-check PDR's verdicts,
  invariants and shortest counterexamples against the BFS oracle, IMC *and* k-induction on 220 random
  systems + the curated gallery — harness now **290 → 296 assertions**. Lint + tsc + build + full
  gate green.
- 2026-06-19 (claude): Took SatForge from *counting* solutions to **compiling knowledge** — a
  from-scratch **knowledge-compilation engine** (`src/sat/ddnnf.ts`) that turns a CNF into a
  **smooth, deterministic, decomposable DNNF** circuit (sd-DNNF), then answers a family of #P-hard
  queries in a single linear pass each. The compiler records the #SAT DPLL search as a *shared DAG*
  (forced literals → AND leaves, free vars → `OR(x,¬x)`, independent sub-formulas → decomposable AND,
  a branch → deterministic OR; repeated sub-formulas cached/shared; unsat branches collapsed; a
  reachability GC compacts the table). On the circuit: exact `ddnnfCount` (BigInt), `ddnnfWmc`
  (weighted model counting — the partition function), `ddnnfMarginals` (every variable's exact
  marginal in one forward+backward sweep, by the Darwiche arithmetic-circuit differential —
  `w[ℓ]·∂Z/∂w[ℓ] = WMC(f∧ℓ)`), `ddnnfMpe` (the most-probable explanation by a max-product pass),
  `ddnnfEnumerate`, `verifyCircuit` (independent sd-DNNF certificates),
  and `toNnf` (the standard c2d/Dsharp `.nnf` export). New off-thread `compile` worker op +
  `compileDdnnfTask`, and a new **Compile** tab (`CompileView.tsx`): verified property badges, a
  circuit-stats grid, the exact count, and a **weighted-inference panel** with a "tilt" slider that
  recomputes the weighted model count, a **live variable-marginal bar chart**, and the
  **most-probable explanation** in real time. Found
  & fixed a bug where an UNSAT circuit's GC dropped the variable count (so marginals indexed out of
  range) — the circuit now carries the input's `numVars`. Added **17 cross-check assertions**: over
  1200 random CNFs the compiled count matches #SAT and brute force, every circuit is verified
  smooth+decomposable+deterministic, WMC, the one-pass marginals and the max-product MPE match brute
  force (random and uniform weights), and enumeration equals the exact model set with no duplicates —
  harness now **296 → 313 assertions**. Lint + tsc + build + full gate green.

### Session 16 — Binary Decision Diagrams (a fifth studio)

Gave SatForge the other canonical form of a Boolean function. Where d-DNNF compiles for *counting*,
a **BDD compiles for *equivalence*** — interned in a unique table with the two reduction rules, two
formulas are equivalent **iff they are the same node**, so SAT, tautology and equivalence are a
pointer compare.

- [x] **`src/bdd/bdd.ts` — a from-scratch ROBDD package.** One universal memoized operator
      `ite(f,g,h)` (Shannon's if-then-else) computes every connective; `not/and/or/xor/nand/nor/
      implies/iff`, `restrict` (cofactor), `existsVar/forallVar` + `exists/forall`, functional
      `compose`, `support`, `size`/`sharedSize`, exact **BigInt `satCount`** (skipped levels count as
      ×2), `anySat`, cube enumeration and `evaluate` are all thin wrappers. Canonicity is real:
      equality is `===` on node ids.
- [x] **`src/bdd/reorder.ts` — variable reordering, the whole point.** `reorder` rebuilds a function
      under any order by Shannon reconstruction (provably function-preserving — the cofactor
      identity), and **`sift` (Rudell)** slides each variable to its best level to minimize the
      diagram. Plus `reverseOrder`, `interleave`, seeded `randomOrder`. *Verified on the bit-match
      function: grouped order 62 nodes → sift → 10; word-equality 93 → 15; parity stays 15 in every
      order.* Caught + fixed a self-inflicted infinite recursion (an `ite(f,0,1)→¬f` shortcut that
      called itself) before it shipped.
- [x] **`src/bdd/expr.ts`** — a precedence-climbing Boolean-expression front-end (`! & | ^ -> <->`,
      bare-name variables) with an AST evaluator used as the oracle.
- [x] **`src/bdd/build.ts`** — `bddFromCnf` (conjoin shortest-first) and a gallery of order-sensitive
      classics (bit-match, word equality, adder carry, parity, majority, thresholds) carrying their
      good/bad orders.
- [x] **`src/bdd/zdd.ts` — the dual Zero-suppressed BDD** for set families: union/intersect/diff,
      count, `allSubsets` (2ⁿ), `combinations` (C(n,k)), `single`.
- [x] **`src/bdd/layout.ts` + `BddStudio.tsx`** — a fifth studio: gallery/expression input, a live
      SVG of the diagram (solid 1-edge, dashed 0-edge, terminal boxes), node-count/model-count/status
      stats, and one-click **Sift / Reverse / Shuffle / Good / Bad** reordering that visibly grows or
      collapses the picture, with a sift shrink-percentage readout and the live variable order as chips.
- [x] **99 new cross-check assertions** (`src/bdd/selfcheck.ts`, folded into `selftest.ts`):
      canonicity + Boolean identities; apply/satCount/cofactor/∃∀/compose vs a truth-table oracle over
      hundreds of random functions; reorder + sift preserve the function and the count; the bit-match
      blow-up is real and sift recovers it; **a BDD from a random CNF agrees with the project's own
      CDCL solver (SAT/UNSAT) and #SAT counter (exact count)**; the expression compiler matches its
      evaluator; and the ZDD set algebra matches 2ⁿ, C(n,k) and bit-mask set arithmetic. Harness
      **313 → 412 assertions**, all green. Lint + tsc + build + full gate green.
