# Aether — journal

Aether is a complete, from-scratch programming-language toolchain that runs entirely in the
browser — no server, no parser generators, no compiler libraries (it even assembles its own
WebAssembly, with no `wabt`/`binaryen`), no external runtime libraries. You write code in a small
ML-family functional language; the app lexes it, parses it, infers its types with Hindley–Milner,
and compiles it **three ways** — to bytecode for a stack VM, to JavaScript, and to a real
WebAssembly module — letting you scrub through execution with a time-travel debugger. Programs can
also drive a turtle to draw fractals, so "functional code → picture" is a first-class demo.

## Architecture

```
source -> lexer -> parser -> HM inference -> elaborate -> optimizer -+-> bytecode compiler -> stack VM -> turtle canvas
                                                                      |                            \-> time-travel trace
                                                                      +-> JavaScript backend -> run in browser (≡ VM)
                                                                      +-> WebAssembly backend -> assemble .wasm -> instantiate & run (≡ VM)
                                                                      \-> derivation tree (the HM proof)
```

The **optimizing middle-end** (`optimize.ts`) sits between elaboration and the backends, so all three
compile the same optimized core — and the equivalence checks prove it preserves every answer.

- `src/lang/lexer.ts` — hand-written scanner; precise source spans, nested block comments.
- `src/lang/parser.ts` — Pratt parser; application is juxtaposition; curried lambdas.
- `src/lang/types.ts` + `infer.ts` — Algorithm W: unification by mutation, occurs-check,
  let-generalisation (real parametric polymorphism, zero annotations).
- `src/lang/optimize.ts` — the optimizing middle-end: a multi-pass, fixpoint rewriter over the core
  (const-fold + algebra, β/η, capture-avoiding inlining, dead-binding elimination, known-constructor
  `match` reduction, field projection, local CSE) plus a top-down **global value numbering** pass
  (available-expressions CSE across binders, Aether 14.0) whose output every backend compiles.
- `src/lang/compiler.ts` + `bytecode.ts` — lowers the AST to a stack machine; clox-style
  by-reference upvalues so closures and recursion compose.
- `src/lang/vm.ts` — iterative stack VM (recursion bounded by memory, not the JS stack);
  curried native builtins; optional per-instruction snapshot trace for the debugger.
- `src/lang/jsBackend.ts` — second backend: lowers the same typed AST to self-contained
  JavaScript + a tagged runtime that mirrors the VM value model; runs in the browser and
  matches the VM byte-for-byte.
- `src/wasm/` — third backend: a from-scratch WebAssembly binary encoder (`encoder.ts`), a
  tagged linear-memory heap layout (`layout.ts`) shared with a host bridge (`bridge.ts`) that
  reuses the VM's own print/show/compare, closure-converting codegen with tail calls
  (`codegen.ts`), and a driver (`run.ts`) that assembles, instantiates and runs the `.wasm`.
- `src/lang/derivation.ts` — reconstructs the HM proof tree from the inferred per-node types.
- `src/lang/prelude.ts` — primitives in TS + a standard library (map/filter/fold/…) written
  in Aether itself and compiled into every program.
- `src/lang/turtle.ts` — folds VM draw effects into line segments for the canvas.
- UI: a 2-pane playground (editor + tabbed inspectors: Result, Canvas, Tokens, AST, Types,
  Bytecode, Debugger), plus Examples / Language / Internals pages.

## Ideas / backlog

- [x] Lexer, Pratt parser, full AST with source spans
- [x] Hindley–Milner type inference with let-polymorphism
- [x] Bytecode compiler with clox-style upvalues + recursion
- [x] Iterative stack VM with curried native builtins
- [x] Time-travel debugger (scrub stack + call frames per instruction)
- [x] Turtle graphics with animated canvas reveal
- [x] Aether-source prelude (map/filter/fold/range/reverse/…)
- [x] Syntax-highlighted editor with live type-checking + error squiggles
- [x] Live visualisers: tokens, SVG AST (hover for inferred type), bytecode disassembly
- [x] Example gallery (tour, fibonacci, quicksort, fractal tree, Koch, spiral, Church numerals)
- [x] Pattern matching (`match … with`) over literals, tuples, and lists
- [x] Tail-call optimisation in the VM (constant-space tail recursion)
- [x] Persist the editor buffer to localStorage + shareable `?c=` URLs
- [x] User-defined algebraic data types (`type Option a = None | Some a`) + constructor patterns
- [x] `let rec … and …` mutually recursive bindings (TCO works across them)
- [x] Exhaustiveness + redundancy checking for `match` (Maranget, with witnesses)
- [x] **Compiling pattern matching to good decision trees** (Maranget 2008) — a core-to-core
      middle-end pass that shares tests across arms so all three backends run the shared tree
      (Aether 12.0)
- [x] **Size-change termination** (Lee–Jones–Ben-Amram, POPL 2001) — a from-scratch analyzer that
      proves recursive functions halt on the structural subterm order, upgrading the optimizer's
      effect-&-totality analysis so CSE/DCE can share/drop *recursive* pure calls; with a Termination
      panel that draws each function's descending ↓ thread (Aether 13.0)
- [x] **Global value numbering** — a top-down, dominator-style *available-expressions* pass that
      shares a pure, costly expression recomputed *across* binders (a `let`, a `λ` body, a `match`),
      hoisting it into one shared `let` at the dominating node when it is guaranteed-evaluated ≥ 2
      times (so VM steps only fall); closes the oldest deferred optimizer item — "CSE across a `let`"
      (Aether 14.0)
- [x] Optimizer pass: constant folding, dead-branch elimination, short-circuit simplification
- [x] A full **optimizing middle-end** over the core (β/η, inlining, dead code, known-`match`,
      field projection) feeding all three backends — abstraction melts away (Aether 10.0)
- [x] Records with row polymorphism (`{ x = 1 }`, `r.x`, inferred `{ x: a | ρ } -> a`)
- [x] Functional record update (`{ r | x = 5 }`, type-safe, row-polymorphic)
- [x] A REPL mode that keeps top-level bindings between runs

### Aether 14.0 — global value numbering: common-subexpression elimination across binders (planned + shipping this session)

Aether 11.0 added **common-subexpression elimination**, but it is deliberately *local*: `tryCse`
only shares an expression among the children on a single node's **binder-free strict frontier**. That
keeps it trivially sound (the hoist crosses no binder, so every occurrence is in scope and guaranteed
to run) — but it leaves on the table the most valuable redundancy, the same pure work recomputed on
either side of a `let`, inside a `λ` body, or across a `match`. The 11.0 deferred list named exactly
this gap: *"CSE across a `let` — the frontier walk stops at every binder … a dominator-based
available-expressions pass would catch those."* 14.0 ships that pass.

**Global value numbering** is a top-down, dominator-style **available-expressions** optimizer over the
core. For a node `N` it scans the subtree for a pure, costly expression `s` that (1) is
**guaranteed-evaluated ≥ 2 times** within `N` and (2) has every free variable bound *above* `N`, then
hoists `s` into one fresh `let gvn = s in N[every occurrence ↦ gvn]` at that dominating node —
rewriting the conditional occurrences (a `match`/`if` arm, a `λ` body) too, which is pure bonus. The
crux is the same one that gives Aether its other middle-end wins for free: it emits an **ordinary
`let`**, so the bytecode VM, the JavaScript backend and the WebAssembly backend compile it with **zero
changes**, and the project's byte-for-byte equivalence checks (run on every example through all three
backends, optimizer on vs off) **re-prove automatically that the answer never changed** — while the
harness's "optimizer never increases VM steps" gate proves the hoist is never worse and the showcase
proves it is strictly better.

The whole feature rests on three safety invariants, each mechanically guarded by the harness:

1. **Effect safety.** Only an **effect-free, terminating** `s` is ever moved (the existing `isPure`,
   powered by the 11.0/13.0 effect-&-totality + size-change analyses). Moving a pure, total
   computation *earlier* on a guaranteed path is observationally invisible in a strict language, so
   reordering it before a later `print`/divergence cannot change behaviour.
2. **No speculation (the step-count invariant).** The hoist only fires when `s` is guaranteed-
   evaluated **at least twice** — the `guaranteed` count, computed by descending only through
   guaranteed-evaluation positions (a `let` value+body, a strict operand, an `app` spine — *not* an
   `if`/`match` arm, a `&&`/`||` right operand or a `λ` body). Two guaranteed evaluations mean the
   value would have been computed at least twice anyway, so the shared `let` strictly cannot add a
   step. Redundancy split across two `if`-arms, or one guaranteed plus one conditional evaluation, is
   **deliberately left alone** — sharing it could add work on a path that did not need it.
3. **Scope & capture safety.** Occurrences are gathered **by identity** while tracking the names bound
   on the way down to each, so an occurrence under a binder that re-binds one of `s`'s free variables
   is excluded (it would denote a different value). The bound name is `$`-fresh and every free variable
   of `s` is in scope at the hoist point, so nothing is captured or shadowed — no α-renaming needed.

Plan / steps:

- [x] **`globalValueNumber` driver** (`optimize.ts`) — a top-down pass run to a fixpoint between the
      first fixpoint and the decision-tree phase (so abstraction has already melted, exposing more
      redundancy), re-running the bottom-up fixpoint afterwards to clean up what it uncovers.
- [x] **`tryHoist(N)`** — scans `N`'s descendants with a `scopedChildren` walk that tags each child
      *guaranteed?* (the `minCost`/frontier cost model) and with the names bound inside `N` so far;
      records every pure, cost-≥ 3 node whose free vars are disjoint from those inside-bound names
      (so it is hoistable to `N`), grouped by `canon`; picks the group with the largest **guaranteed**
      saving (≥ 2 guaranteed occurrences), and hoists it.
- [x] **`replaceNodes` by identity** + a fresh `$gvn`-bound `let`; the conditional occurrences are
      replaced too (a free win). `mapAllChildren`/`mapChildrenScoped` are the generic structural
      rebuilders the pass needs (the existing `rebuildFrontier` was frontier-only).
- [x] **Optimizer panel** — the rewrite table lists the new `gvn` rule, and a dedicated **"Global
      value numbering"** section shows each hoisted expression and how many sites collapsed into the
      shared binding (`gvnHoists` on `OptimizeStats`).
- [x] A **`gvn` gallery example** — a numeric kernel that recomputes a pure window
      `sq n + sq (n+1) + sq (n+2)` as the value of three different `let`s (work the frontier CSE never
      sees); GVN shares it once (1 rewrite, 3 sites) and the VM steps roughly halve. It also showcases
      GVN cooperating with the 11.0 effect-&-totality analysis (`sq` is proven pure, so its repeated
      *calls* are shareable).
- [x] **Verification** — the new example auto-flows through the JS / WASM / GC-stress / disassembler /
      optimizer batteries (so GVN ≡ naive on result + output + effects + never-increased steps across
      all three backends); a focused **GVN battery** asserts it fires, cuts real steps, shares the
      right number of sites, and — the safety half — declines to speculate across `if`-arms, declines
      when only one evaluation is guaranteed, and never moves an effect; plus a 3-case in-app self-test
      group. Keep the full CI gate (scope + conformance + lint + tsc + build) green.
- [x] **Docs** — Tour / About / README / `project.json` writeups for global value numbering.

### Aether 13.0 — size-change termination: proving recursion halts (planned + shipping this session)

Since 11.0 the optimizer has carried an **effect-&-totality analysis** so CSE can share — and
dead-code elimination can drop — a *call* to a pure helper. But its notion of "total" was blunt:
a function counted as total **only if it was non-recursive** (`if (recursive && freeVars(value).has(name)) return`).
That excluded essentially every interesting function — `length`, `append`, `reverse`, a tree fold —
so a program that computes `length xs + length xs` still walked the list twice. The backlog item
*"totality is approximated by 'non-recursive'; a structural argument…"* named exactly this gap.

13.0 closes it with the **size-change principle for program termination** (Lee, Jones &
Ben-Amram, *POPL 2001*). A program cannot loop forever when, on every potential infinite call
sequence, some value drawn from a **well-founded order** would have to descend without end. Aether's
order is the **structural subterm order** on finite data: a value peeled out of a constructor,
cons-cell or tuple by a `match` is *strictly smaller* (a ↓ arc) than the whole — and because Aether
is strict, all data is finite, so that order is genuinely well-founded. For every call `f → g` the
analysis builds a **size-change graph** (arcs from `f`'s parameters to `g`'s arguments, labelled ↓
strict-subterm or ↓= alias, read straight off the destructurings in scope), finds the call graph's
**strongly-connected components**, closes each component's graphs under composition, and proves it
terminating when **every idempotent self-graph carries a strict in-situ arc** `p ↓ p` — a parameter
that descends on every way around the loop.

The cut-off is deliberately **first-order**, and that is exactly what keeps the result *sound for the
optimizer too*: a function that applies one of its own parameters (`map`, `foldr`) is never admitted,
because both its termination **and** its effect-freedom depend on the function it is handed at
runtime — invisible to the first-order call graph and to `isPure`. So the analysis is honest in both
directions: it proves `length` / `append` / `reverse` / tree folds / mutually-recursive `even`/`odd`
/ a Peano-`Nat` factorial, and it *correctly declines* an unbounded `Int` countdown (which really can
diverge on a negative input) and every higher-order combinator. Once a recursive function is proven
effect-free **and** terminating it joins the pure set; CSE then shares a repeated recursive call and
DCE drops an unused one — and the project's byte-for-byte VM≡JS≡WASM equivalence checks re-prove, on
every example, that the answer never changed.

Plan / steps:

- [x] `src/lang/termination.ts` — a from-scratch size-change termination analyzer. Collects the
      program's named, never-shadowed, first-order functions; for each call site builds a size-change
      graph by walking the body under a **size environment** (`match`/`let` destructurings record
      `var ↦ (parameter, strict?)`); composes and closes the graphs per SCC (Tarjan), with a safety
      cap; and applies the idempotent-self-graph test. Returns per-function verdicts + witnesses.
- [x] **Structural well-founded order**, done right: a pattern variable directly bound to the
      scrutinee aliases it (↓=); one nested under ≥1 constructor/cons/tuple is a strict subterm (↓),
      and a subterm-of-a-subterm stays strict — so deep destructuring still descends.
- [x] **Lexicographic descent, for free** — a *reconstruction* fact (`match m with S p -> …` makes
      `S p` rebuild `m` exactly, a ↓= arc) lets the composition closure discover when a *pair* of
      arguments descends lexicographically. The canonical example, **Ackermann on `Nat`**, is proven:
      either `m` shrinks, or `m` stays equal while `n` shrinks. Reconstruction facts are invalidated
      the moment any field variable is rebound, so the refinement stays sound (verified adversarially:
      `f m = f (S p)` on `m = S p`, and a rebinding that regrows the argument, are *not* proven).
- [x] **Sound `match` totality** in the optimizer (`matchTotal`) — a Maranget *usefulness* check
      specialised to Aether's pattern domain with a signature oracle from `CTORS`/`SIBLINGS`
      (built-ins for bool/unit/list/tuple, the declared sibling set for ADTs; Int/Float/String and
      any unknown constructor are infinite ⇒ only a wildcard covers). A match whose *unguarded*
      patterns are exhaustive cannot `MATCH_FAIL`, so `isPure` now accepts a total, all-pure match on
      an **unknown** scrutinee — which is what lets a function that matches its own parameter be pure.
- [x] **Admit recursive groups into the pure set** (`analyzePurity`): gather the proven-terminating
      cyclic SCCs and commit each **all-or-nothing** — tentatively assume the whole group pure (so
      members' own recursive calls resolve), check every body is effect-free, keep them only if all
      check out, else roll the group back. Termination from the proof, effect-freedom from the body
      check; together, totality. The non-recursive path and every existing safety invariant are
      untouched, and `minCost`/`bodyCost`'s cycle guard already tolerates recursive pure bodies.
- [x] **Termination panel** (a new tab) — per-function verdict cards (terminates / higher-order /
      not proven) with the plain-language reason, the **↓ descending thread** drawn as the self
      size-change graph, the trivially-terminating non-recursive functions, and the first-order call
      graph. The Optimizer panel cross-links to it.
- [x] A `termination` gallery example (recursive `len`, a tree fold, and a Peano-`Nat` factorial,
      with `len`/`sumTree` shared by CSE and `map` left pointedly unproven); an in-app self-test
      group (`termination`); and a headless battery proving VM≡JS≡WASM and optimize-on ≡ optimize-off
      across **every** example, that the soundness direction holds (idle loops, integer countdowns and
      growing arguments are *never* claimed to terminate), and that higher-order functions stay out.
- [x] Docs (About "Internals" card, `project.json`) updated.

### Aether 12.0 — compiling pattern matching to good decision trees (planned + shipping this session)

Aether has cited **Maranget** since 1.0 — but only for *exhaustiveness* (`exhaustive.ts`). The
*compiler* itself lowered `match` naively: for every arm in turn it flattened the pattern into a
flat list of tests and re-navigated the scrutinee, so two arms that share a constructor prefix
(`Cons a (Cons b r)` then `Cons a Nil`) **re-test that outer `Cons` twice**. 12.0 closes the gap
with the companion algorithm — *Compiling Pattern Matching to Good Decision Trees* (Maranget,
2008): a real pattern-matrix compiler that tests each scrutinee position **once**, sharing the
decision across every arm that needs it.

The decisive design choice (the same one that gave 10.0/11.0 three backends "for free"): decision
trees are produced as a **core-to-core transformation in the optimizing middle-end**, lowering a
multi-arm nested `match` into a tree of **single-column** `match`es (`match o with Cons s1 s2 ->
match s2 with …`) plus join-points for shared arm bodies. Because the output is ordinary core, the
bytecode VM, the JavaScript backend and the WebAssembly backend compile it with **zero changes**,
and the project's existing byte-for-byte equivalence checks re-prove on every program that the
answer never changed — and the harness's per-example "optimizer never increases VM steps" gate
proves the tree is never worse, while the showcase proves it is strictly better.

Plan / steps:

- [x] `src/lang/decisiontree.ts` — a from-scratch pattern-matrix compiler. A `compile(occs, rows)`
      that, on a column whose row-0 pattern is refutable (chosen by a sharing heuristic — the
      column tested by the most rows), **switches once** on that occurrence: one arm per head
      constructor present (`pcon` / `::` / `[]` / tuple / literal / bool), specializing the matrix
      (constructor rows expand their sub-patterns into new columns; wildcard/var rows propagate into
      every arm), plus a default arm for the remaining rows when the column's signature is
      incomplete. Bottoms out when row-0 is all-irrefutable (a leaf), threading variable bindings
      `patVar ↦ occurrence` down the tree.
- [x] **Guards, correctly.** A guarded leaf becomes `if guard then body else <compile the rest of
      the still-live matrix>`, so a failing `when` falls through to exactly the arms it would have
      under the naive compiler — preserving non-exhaustive `MATCH_FAIL` behaviour by *omitting* the
      default arm (a non-exhaustive switch fails at runtime just as the source did).
- [x] **No code blow-up, no step regressions.** A row reached from one leaf is inlined directly
      (its `patVar ↦ occ` bindings are trivial `let`s the existing copy-propagation erases); a row
      duplicated across arms (a wildcard row) is shared through a **join-point** lambda so its body
      appears once. DT only fires on matches that actually share work — nested refutable
      sub-patterns or a repeated head constructor — so flat enum/`Option` matches (already optimal)
      are left untouched.
- [x] Wire it into `optimizeCore` as a phase between two fixpoints (fixpoint → DT → fixpoint, so
      the introduced `let`s/join-points are cleaned up), with a `dt` rewrite count, per-match
      tree statistics, and a serializable tree view for the panel. Both the full program (VM) and
      the user portion (JS/WASM + panel) get it, keeping the backends in lock-step.
- [x] **Optimizer panel — a "Decision trees" section** that renders each compiled match's tree
      (switch nodes labelled by occurrence, edges by constructor, leaves by arm) and reports the
      static *pattern tests* it shares away (naive vs tree), beside the existing live VM-step
      measurement.
- [x] A `decision-tree` gallery example (a list-merge / expression-simplifier with shared
      constructor prefixes) whose VM steps drop measurably; an in-app self-test group; and a
      harness battery that asserts DT ≡ naive (result + output + effects + steps-never-up) across
      every example, fires on the nested cases, cuts real steps on the showcase, preserves
      `MATCH_FAIL`, and handles guards.
- [x] Docs (Tour / About / README / `project.json`) updated.

### Aether 2.0 — a second backend & deeper insight (shipped this session)

- [x] **JavaScript backend** (`jsBackend.ts`) — a whole second compilation target beside the
  bytecode VM: lower the typed AST to readable, self-contained JavaScript (a tiny tagged
  runtime that mirrors the VM's value model exactly), then *run it* in the browser and show
  the output. Alpha-renames every binder so Aether's free shadowing never collides.
- [x] Prove the JS backend correct: its result + printed output + turtle drawing match the
  VM byte-for-byte across every example (a live "matches the VM ✓" badge in the JS tab).
- [x] The JS backend emits the same turtle effect log, so a functional fractal compiles to JS
  and produces an identical drawing (effect counts compared in the equivalence check).
- [x] **List comprehensions** — `[ e | x <- xs, guard, y <- ys ]`, lexer `<-` token + a
  pure parser desugaring into `concat`/`map`/`if`, so both backends get it for free.
- [x] **Type-derivation tree** (the long-standing backlog item) — reconstruct the HM proof
  tree from the inferred per-node types and render it as an interactive, collapsible
  natural-deduction derivation (Var / Abs / App / Let / If / Op / … rules).
- [x] New examples: a comprehension-based primes sieve & Pythagorean triples; a "compile me
  to JS" showcase; the landing tour now opens with a comprehension.
- [x] Update the Tour / Internals (About) pages and README to cover the JS backend,
  comprehensions, and the derivation view.
- [x] Verify with an expanded Node type-stripping harness (106 checks: JS≡VM across every
  example, comprehension semantics, shadowing, int-wrap/div, ADT/record show) + a
  react-dom/server render smoke test for the new panels + the CI gate.

### Aether 3.0 — Type classes (planned + shipping this session)

The headline gap in an ML-family language: **principled overloading**. Aether already has
Hindley–Milner with let-polymorphism, ADTs, records with row polymorphism, two backends and a
proof-tree view — but no way to say "this works for any type that supports `disp`/`eq`/…". This
session adds **type classes with dictionary-passing**, the same machinery Haskell uses, done so
that *both* existing backends (bytecode VM + JavaScript) get it for free.

The key design choice: type classes are implemented as a **type-directed elaboration into the
existing core AST**. After inference resolves which instance each constraint needs, an
elaboration pass rewrites the program so that

- every `instance` becomes a **dictionary** (a record of its method implementations),
- every constrained binding gains extra **dictionary parameters** (`fn $d -> …`),
- every method call becomes a **field access** on the right dictionary (`$d.disp x`),
- every use site **applies** the resolved dictionaries (concrete instance dicts, or a dictionary
  parameter passed down).

Because elaboration produces ordinary core AST (lets, lambdas, records, field access), the
bytecode compiler, the stack VM and the JavaScript backend need **zero changes** — they compile
and run the dictionaries like any other code, and the JS≡VM equivalence check still holds.

Plan / steps:

- [x] **Predicates in the type system** — `Pred { cls, type }`, qualified schemes
      (`∀a. (Disp a) => a -> String`), and qualified pretty-printing in the Types panel.
- [x] **Surface syntax** — `class C a where m : τ, … in body`, `instance Ctx => C T where m = e, …
      in body`, the `=>` constraint arrow, `:` for method signatures, and `class`/`instance`/`where`
      keywords. New AST nodes `classdecl` / `instancedecl`; every AST walk (label, children,
      optimizer, derivation, unparser) learns them.
- [x] **Constraint solving + instance resolution** (in `infer.ts`, evidence in `classes.ts`) —
      context reduction for a single-parameter class system: ground heads resolve to instance
      dictionaries (recursively through written instance contexts like `Disp a => Disp (List a)`,
      including *self-referential* recursive instances such as `Disp (Tree a)`); type-variable heads
      defer to a dictionary parameter, captured at the nearest enclosing generalization. Clear
      errors for missing / duplicate / ambiguous instances and missing contexts.
- [x] **Dictionary-passing elaboration** (`classes.ts`) — turns the typed program into core AST:
      instance dicts as records (a recursive `let`), constrained bindings as dictionary-abstracted
      lambdas, method uses as field accesses, use sites as evidence applications, recursive
      self-calls re-threading their own dictionaries. Identity on programs that use no classes.
- [x] **Both backends, unchanged** — the VM compiles the elaborated core; the JS backend lowers
      the elaborated user AST, so overloaded programs still pass the byte-for-byte JS≡VM badge.
- [x] **A "Classes" inspector panel** — declared classes & instances, plus the elaborated core
      (dictionaries made visible via a new core pretty-printer) so dictionary-passing isn't a black
      box.
- [x] **Examples** — `Type classes` (overloaded `disp` over Int/Bool/List/tuple + a constrained
      helper), `Shape` (ad-hoc polymorphism across distinct Circle/Rect types), and `Semigroup`
      (an associative `combine` with a generic `mconcat` fold). All three double as a showcase of a
      small standard class library; users declare their own classes too.
- [x] **Docs + verification** — Tour/About/README writeups; a Node strip-types harness covering
      instance resolution, contexts, recursive/self-referential instances, dictionary passing
      through recursion, JS≡VM over every class program, and the error cases.

- [x] **Default methods** — a class method may declare a default body (`ne : a -> a -> Bool =
      fn x y -> not (eq x y)`); instances inherit it unless they override. Each instance clones the
      default (`cloneExpr`) so its dictionary-passing elaboration is independent, and the default
      resolves the class's other methods against the instance being defined (a recursive dict).

Deferred (future): superclasses & `=>` on method signatures; multi-parameter classes; class
constraints inside `let rec … and …` groups (currently rejected with a clear message); an
always-on standard prelude of classes (kept as examples for now to guarantee zero regression).

### Aether 4.0 — property-based testing & monadic `do`-notation (this session)

A language is only as trustworthy as the evidence you can produce *about programs written in
it*. Aether 3.0 could infer rich types; 4.0 turns those types into **machine-checked evidence
about behaviour**. Two headline features, both leaning on machinery the language already has:

1. **Aether Check** — a from-scratch, type-directed property-based testing engine (QuickCheck in
   the browser). You write `prop_*` functions returning `Bool`; the engine reads each property's
   *inferred* type, **generates random inputs from the type itself** (Int/Float/Bool/String/Unit,
   lists, tuples, records and **your own ADTs** — recursively, with a size budget that guarantees
   termination on recursive types like `Tree`), runs hundreds of cases through the real VM, and on
   a failure performs **integrated shrinking** down to a minimal counterexample. It is fully
   deterministic (seeded RNG) so the same code always produces the same report. This is the first
   feature that *consumes* inference rather than just displaying it.

2. **`do`-notation** — Haskell-style monadic sequencing as a pure parser desugaring
   (`do { x <- e; …; r }` ⇒ `bind e (fn x -> …)`, `do { e; … }` ⇒ `then e (…)`), resolved through
   the existing type-class + dictionary-passing machinery. No inference, compiler, VM or JS-backend
   changes — a `Monad` class and its instances are ordinary Aether, so both backends run monadic
   code and the JS≡VM badge still holds.

Plan / steps:

- [x] **Expose constructor & type tables** from inference (`ctorInfo`, `typeCtors` on
      `InferResult`) so the property engine can build generators for user-declared ADTs.
- [x] **`executeProgram(ast)`** in the pipeline — an AST-level entry (infer → elaborate →
      compile → run) so the property runner reuses the *exact* execution path, not a copy.
- [x] **`property.ts` — the generator core**: `GType`/`GValue` model; type→generator
      (defaulting leftover polymorphism to `Int`); size-bounded recursive ADT/list/record
      generation; a seeded `mulberry32` RNG for reproducibility.
- [x] **Integrated shrinking** — per-shape `shrink` (ints toward 0, lists drop/half + element
      shrinks, tuples/records componentwise, ADTs to sub-terms of the same type), driving a
      greedy minimisation loop to the smallest still-failing input.
- [x] **The runner** — discover `prop_*` bindings whose type is `… -> Bool`; batch-execute N
      cases per property in a single VM run for speed, fall back to per-case search to attribute a
      runtime error, then shrink. Graceful `skip` for higher-order/ungeneratable arguments.
- [x] **`do`-notation** end to end — lexer `do`/`<-` tokens, a parser desugaring into
      `bind`/`then`, and a `Monad`/`Functor` example library (Option, List, a `State` monad).
- [x] **UI** — a "Check" inspector panel (per-property pass/fail, case count, shrunk
      counterexample, shrink count) and a dedicated `#/check`-style surfacing on the Tests page.
- [x] **Examples** — `Property testing` (reverse/sort/insert laws, a deliberately *buggy* sort
      so shrinking shines), and `do-notation` (safe division pipeline + list non-determinism).
- [x] **Function generation** — generate random *function* arguments too (rendered as a finite
      `fn x -> if x == k then v … else default` table), so higher-order laws like map fusion and
      `filter`-length are testable; the table shrinks to fewer entries. Domains that contain a
      function are rejected (they'd need `==` on functions).
- [x] **Docs + verification** — Tour/About/README writeups; grow the self-test suite with
      generator, shrinker and `do`-desugaring cases (all still proving JS≡VM where they produce a
      value), keep the CI gate green.

Design note (monads & HKT): a *type-class* `Monad m` needs **higher-kinded** type variables
(`m a -> (a -> m b) -> m b`), but Aether's `Type` is first-order — a `TCon`'s head is a string, not
a unifiable variable — so `m := Opt` can't be expressed without adding kinds. Rather than risk that
large change, `do`-notation desugars to a **plain `bind` in scope** (exactly how `do` is sugar for
`>>=`). That's fully general at the value level: bind Option's `bind` and the block short-circuits,
bind List's and it branches. Real higher-kinded type classes stay on the deferred list.

Deferred (future, restated): higher-kinded types → genuine `Functor`/`Monad`/`Applicative` classes;
superclasses & `=>` on method signatures; multi-parameter classes; shrinking that mutates several
arguments at once (the current shrinker is per-argument greedy).

### Aether 5.0 — a kind system & higher-kinded types (this session)

The headline gap every previous session deferred: Aether's `Type` was *first-order* — a `TCon`'s
head was a plain string, never a unifiable variable — so `Monad m` (where `m a -> (a -> m b) -> m b`
abstracts over a **type constructor** `m`) could not be expressed, and `do`-notation could only fake
it by binding a `bind` in scope. 5.0 makes the type language **higher-kinded**: a type variable can
stand for a constructor like `Option`/`List`/`Either e` and be applied to arguments, so genuine
`Functor`/`Applicative`/`Monad` classes — and polymorphic combinators over *any* monad — type-check,
elaborate, run on the bytecode VM, and stay byte-for-byte equal on the JavaScript backend.

The crux is a small, surgical representation change plus a from-scratch **kind checker**. Concrete
saturated applications (`List a`, `a -> b`) keep the old `TCon{name,args}` shape; only a
variable-headed application introduces a new `TApp{fn,arg}` node, and unification *bridges* the two
(a `TCon` of arity ≥ 1 decomposes into a `TApp` spine on demand, so `m a` unifies with `Option a` by
binding `m := Option`). Because dictionary-passing elaboration is keyed on AST node identity, not on
types, both backends inherited HKT with **zero** changes.

Plan / steps:

- [x] **`TApp` in the type representation** — a `fn arg` node used only for (possibly) variable-headed
      applications; `spineOf` collapses an application chain (through both `TApp` and `TCon` args) to a
      head + argument list. `freeVars`/`occurs`/`subst`/`prune` and the type pretty-printer all learn it;
      the printer became **arity-aware** so an unsaturated constructor (bare `List`, kind `* -> *`) prints
      as `List` rather than crashing. A pure no-op until the parser can produce a `TApp`.
- [x] **Unification of applications** — `m a` vs `Option a`, `f a` vs `g b`: decompose both sides to
      `fn`/`arg` and unify componentwise; a higher-kinded variable binds to a *partially applied*
      constructor (`m := Option`, represented as a 0-arg `TCon`). Instance selection (`evidenceFor`,
      `reduceConWanted`) keys on the application *spine head*, so `Option`, `Option a` and `m a` all
      resolve through the same machinery.
- [x] **Surface syntax for `m a`** — a `tapp` `TypeExpr` node; `parseTypeApp` builds a left-associative
      application spine when the head is a type variable (constructor heads still absorb their args).
      Every `TypeExpr` walker (the two converters + the core unparser) learns it; bare `List` now
      respects the written arity (the unsaturated `* -> *` constructor) instead of auto-saturating.
- [x] **A kind system** (`kinds.ts`) — first-order kinds `Kind = * | k -> k` with kind *inference* by
      unification: every type expression in a `class`/`instance`/`type` declaration is kind-checked, the
      class parameter's kind is **inferred** from how its methods use it (`Monad m` ⇒ `m : * -> *`), and
      an instance head must match that kind. Ill-kinded programs (`instance Monad Int`, inconsistent
      variable kinds, applying a `*` type) are rejected with a clear message during inference.
- [x] **Superclasses** — `class Functor f => Monad f where …`; the superclass dictionary is reachable
      from the subclass dictionary (a `$super_<cls>` field), so a `Monad` instance requires (and embeds)
      its `Functor` instance, and a `Monad m` constraint **entails** a `Functor m` one — discharged by
      projecting through the dictionary, so the inferred scheme reads `Monad m =>` (not `(Functor m,
      Monad m) =>`). Constraint *roots* are kept as dict params; entailed supers project from them.
      (Deferred still: `=>` contexts on individual method signatures; multi-parameter classes.)
- [x] **A real standard class library (as examples)** — two flagship gallery examples: the full
      `Functor`/`Applicative`/`Monad` hierarchy over `Option` and `List` with a single generic `mapM`
      that runs in both, and a **`State s` monad** (a *partially-applied* user constructor as a monad).
      `do`-notation now resolves through the genuine `Monad` class — the same block is the Option, List
      or State monad by *type*, not by shadowing a local `bind`.
- [x] **Tooling, docs & verification** — the Classes panel shows each class's inferred **kind** and its
      superclass context (`Functor m ⇒`); Tour/About/README + `project.json` writeups; the in-app
      self-test suite grew a `higher-kinded` group (+ kind/superclass error cases), and the committed
      Node harness (`tools/harness.mjs`) now runs the whole self-test + property suites *and* a focused
      HKT battery (polymorphic monadic code at multiple instances, superclass entailment, the State
      monad, JS≡VM throughout, and the rejection cases) — 82 checks, all green.

### Aether 6.0 — `deriving` (this session)

For three releases Aether's type classes have been hand-written: every instance, even the rote
structural `Eq`/`Ord`/`Show`, was typed out by hand. 6.0 adds **`deriving`** — the one piece of
class machinery a real ML/Haskell-family language is judged on. A `type` declaration can now carry
a `deriving (…)` clause and the compiler **synthesises the instances for you**, generating the
method bodies from the data type's shape: structural equality, lexicographic ordering, Haskell-style
`show`, enumeration, bounds, and — the headline — a position-aware **`deriving Functor`** that maps
over a type's last parameter (recursing through itself, lists and tuples).

The crux is that this is *pure front-end desugaring*, exactly the pattern that has paid off every
session: `deriving` runs at **parse time** and emits ordinary `instance` AST nodes nested in the
type's body, so inference type-checks them, kind-checks their heads, infers their contexts and
elaborates them to dictionaries — and the bytecode VM **and** the JavaScript backend inherited the
whole feature with **zero** changes. A derived instance is byte-for-byte indistinguishable from a
hand-written one; the only new code outside the generator is one keyword and a parser hook.

Plan / steps:

- [x] **`deriving` keyword + parser hook** — lex `deriving`; parse an optional
      `deriving (C1, C2, …)` clause after a type's constructors. The clause desugars at parse time
      into a chain of synthesised `instance` declarations wrapping the type's body, so the rest of
      the pipeline never learns a new node. An optional `derived?: boolean` marker on `instancedecl`
      lets the Classes panel badge them.
- [x] **The generator (`deriving.ts`)** — from a type's parameters + constructors, build the
      `instance` AST for each requested class. Each method body is real surface AST (`match`,
      `^`, comparisons, recursive class-method calls) so it flows through inference unchanged, and
      the instance context (`(Eq a, Eq b) =>`) is computed from which parameters the fields use.
- [x] **`deriving Eq`** — `eq` by structural recursion: equal constructors compare their fields
      with `eq` (`&&`-folded; `true` for nullary), unequal constructors are `false`. Recursive and
      parametric types work via the self-instance + an inferred `(Eq a, …) =>` context. Generated
      `match`es are exhaustive **and** non-redundant (no spurious warnings).
- [x] **`deriving Ord`** — `compare : a -> a -> Int` (−1/0/1): same constructor ⇒ lexicographic
      field comparison, different constructors ⇒ by declaration order (constructor index). No `Ord
      Int` needed — the tag comparison uses primitive `<`.
- [x] **`deriving Show`** — Haskell-style `show`: a nullary constructor prints its name, an applied
      one prints `(Ctor f1 f2 …)` with each field shown recursively through the class.
- [x] **`deriving Enum` / `deriving Bounded`** — for all-nullary (C-style) enums: `fromEnum`/`toEnum`
      round-trip a constructor through its index; `minBound`/`maxBound` are the first/last
      constructors. Rejected (with a clear message) on a type that carries fields.
- [x] **`deriving Functor` / `deriving Foldable`** (headline) — synthesise `fmap : (a -> b) -> f a -> f b` mapping over the
      type's **last** parameter: a field that *is* the parameter gets `g` applied; a recursive
      `T … a` field recurses via `fmap`; a `List a` field maps; a tuple maps componentwise; a
      parameter-free field is untouched. The instance head is the type applied to all-but-the-last
      parameter (kind `* -> *`), unified against the class through the 5.0 `TApp`/`TCon` bridge.
      Unsupported field shapes are rejected by name. The companion **`deriving Foldable`** writes
      `foldr : (a -> b -> b) -> b -> t a -> b` over the same last parameter (standard DeriveFoldable
      order), folding `List` fields with an inline right fold (no `Foldable List` instance needed), so a
      derived `Foldable` hands you `toList`/`sum`/`length` for free.
- [x] **Gallery examples** — a `deriving (Eq, Ord, Show)` showcase over a sum-of-products type, a
      weekday `enum` driving a generic `allValues` via `Enum`/`Bounded`, and a `deriving (Functor,
      Foldable)` tree mapped and folded generically (plus a rose tree) — each runs on both backends.
- [x] **Tooling, docs & verification** — the Classes panel badges derived instances; `deriving` is a
      highlighter keyword; Tour/About/README + `project.json` writeups. A new `deriving` self-test
      group (in `testSuite.ts`) and a focused `deriving` battery in the Node harness check every
      derived method's behaviour, JS≡VM throughout, and the rejection cases (non-derivable class,
      `Enum` on a type with fields, `Functor`/`Foldable` on a nullary type, an unfoldable nested-in-list shape).

### Aether 7.0 — a native WebAssembly backend (planned + shipping this session)

For six releases Aether has had two execution targets — the bytecode VM and the JavaScript
backend — kept byte-for-byte equal by a live equivalence check. 7.0 adds the headline a
language toolchain is judged on: a **third, *native* compilation target that emits real
WebAssembly bytecode**. Aether now lowers the same type-checked, dictionary-elaborated core AST
to a hand-assembled `.wasm` module — produced by a from-scratch WebAssembly binary encoder (no
`wabt`, no `binaryen`, no libraries) — which the browser **instantiates and runs** through
`WebAssembly.instantiate`. You can download the `.wasm` and run it in any WebAssembly engine.

The design keeps the project's hard-won invariant: a third "✓ matches the VM" badge. WASM
genuinely *executes the program* — it owns allocation (a bump allocator over linear memory),
control flow, closures via `call_indirect`, integer/float arithmetic, structural comparison,
list/tuple/record/ADT construction, and `match` dispatch. A handful of inherently host-side
operations (printing, `show`'s text formatting, `sin`/`sqrt`, string ops, and the side-effecting
turtle) are delegated to **imported JS functions that decode WASM heap pointers into the VM's
exact `Value` model and reuse the VM's own formatter/comparator** — so the WASM backend's result,
printed output and drawing match the bytecode VM byte-for-byte, by construction.

The crux is closure conversion + a tagged heap that mirrors `values.ts` cell-for-cell, so a JS
"bridge" can read and write the same value model on both sides of the WebAssembly boundary.

Plan / steps:

- [x] **WASM binary encoder** (`wasm/encoder.ts`) — from-scratch LEB128 (unsigned/signed/f64)
      and every module section (type, import, function, table, memory, global, export, element,
      code) with a small typed instruction builder. Pure and independently testable; emits bytes
      a real engine accepts.
- [x] **A tagged linear-memory heap + JS bridge** (`wasm/bridge.ts`) — heap-cell layout mirroring
      `Value` (int/float/bool/unit/nil/cons/tuple/data/record/closure/native/ctor/str); `decode`
      (read a pointer into a `Value`) and `encode` (write a `Value` via the exported allocator),
      a string-intern table, a constructor-name table and a record-label table shared with codegen.
- [x] **The runtime, emitted as WASM** — a bump allocator (`__alloc`, grows memory on demand), a
      generic `apply` (user closures via `call_indirect`, partially-applied natives, partially-
      applied constructors), structural `cmp` (the `<`/`==` family), list `++`, and boxing helpers.
- [x] **Codegen** (`wasm/codegen.ts`) — closure conversion with free-variable analysis: each
      `lambda` becomes a WASM function `(env, arg) -> i32`; top-level `let`/`letrec` become WASM
      globals (with back-patched self/mutual recursion); `if`/`match`/`binop`/`unop`/`list`/`tuple`/
      `record`/`field`/`recordUpdate`/`seq` all lower to WASM; constructors become curried builders;
      the hot natives (`head`/`tail`/`empty`, comparisons, `min`/`max`) inline, the rest call imports.
- [x] **Driver** (`wasm/run.ts`) — assemble + instantiate with the import object, run `main`,
      collect output/effects/result decoded through the bridge, and surface the real module bytes
      (size, function count, a WAT-style disassembly, a download).
- [x] **A "WASM" inspector panel** — compile → instantiate → run → compare to the VM with a live
      "✓ matches the VM" badge, module statistics, the disassembly, and a download for the `.wasm`.
- [x] **Examples** — a "compile me to WebAssembly" showcase that runs identically on all three
      backends.
- [x] **Verification** — a Node battery (`tools/harness.mjs`) that instantiates the *real* emitted
      module under Node's `WebAssembly` and asserts **WASM ≡ VM** (result + output) across the
      supported gallery and a focused feature battery (closures/recursion, ADTs, records, `match`,
      higher-order prelude, floats, the turtle). Keep the CI gate green.
- [x] **Docs** — Tour/About/README/`project.json` writeups for the third backend.

### Aether 8.0 — a self-describing WebAssembly backend: a from-scratch WAT disassembler, a `name` section & a measured small-integer cache (planned + shipping this session)

For one release the WebAssembly backend has been a black box you could only read as a **hex dump**.
8.0 makes it *self-describing and measurably leaner*, knocking out the two oldest items on the 7.x
deferred list and adding a runtime win the panel can prove with numbers. Three headline pieces, all
confined to `src/wasm/`, the WASM panel and the harness — and all kept honest by the existing
WASM ≡ VM equivalence check that already guards every gallery example:

1. **A from-scratch WAT *disassembler*** (`wasm/disasm.ts`) — the exact mirror image of the
   from-scratch *encoder*. It is a real WebAssembly **binary decoder**: it re-reads the bytes the
   encoder just produced (magic/version, then the type / import / function / table / memory / global
   / export / element / code / **name** sections), and renders canonical, indented **WAT text** — a
   full opcode table covering every instruction the `Code` builder can emit, structured
   `block`/`loop`/`if`/`else`/`end` nesting, decoded `memarg`s and immediates, and call/global/local
   targets resolved to **`$names`**. No `wabt`, no `wasm2wat`, no libraries — the same rule the
   encoder lives by. The module now reads as a program, not a hex blob.

2. **An emitted `name` custom section** (`encoder.ts`) — function names (imports, the runtime
   helpers `__alloc`/`boxInt`/`apply`/…, every compiled lambda, `main`), a locals sub-section
   (`$env`/`$arg` on every closure body), and a globals sub-section (`$heap`, the singletons,
   each native builtin by its Aether name, every top-level binding by its source name). The
   disassembler reads it back, so the WAT reads `(call $map)` and `(global.get $heap)` instead of
   raw indices — the deferred "read by name instead of as a hex dump" goal, end to end.

3. **A measured small-integer cache + live heap accounting** — `boxInt` boxed a *fresh* cell for
   **every** integer result (the single hottest allocation in arithmetic-heavy code). 8.0 pins a
   contiguous block of pre-built `INT` cells for a small range at module init and has `boxInt`
   return the shared cell for any in-range value, allocating only outside it. Because Aether is pure
   and every value is compared **structurally** (never by pointer), sharing is invisible to results
   — the WASM ≡ VM badge still holds byte-for-byte. The runtime now also *counts* what it does
   (`__allocCount`/`__allocBytes`/`__cacheHits` exports), so the panel and harness report a concrete
   allocation reduction (e.g. a `range`/`fold` workload drops a large fraction of its boxes).

The crux, as ever: the disassembler and the cache change *how the module is presented and how much it
allocates*, never *what it computes* — so the project's hard-won invariant (three backends, one
answer) is preserved and re-proven by the harness.

Plan / steps:

- [x] **`name` section in the encoder** — `addFunc`/`addGlobal`/`importFunc` carry an optional debug
      name (+ a local-names list for closure params); `Module.nameSection()` serialises WebAssembly
      custom section `"name"` (sub-sections 1: functions, 2: locals, 7: globals) after the code
      section. Pure addition; the module still validates and runs (all 207 harness checks stay green).
- [x] **Codegen threads names** — the runtime helpers (`__alloc`/`boxInt`/`apply`/…), every compiled
      `lambda` (named after its binding via a hint — so prelude `map`/`filter`/… and user functions read
      by name), `main`, the singleton/native/top-level globals (`$heap`, `$b_print`, `$g_fib`, …), and
      `$env`/`$arg` on closure bodies are all named.
- [x] **`wasm/disasm.ts` — the decoder** — a from-scratch binary reader (LEB128/`f64`/UTF-8) that
      parses every section the encoder emits (incl. the name section) and renders WAT: types, imports,
      memory, globals with their (instruction-decoded) init exprs, exports, and each function as
      `(func $name (param…) (result…) (local…) <body>)` with a complete, indented instruction stream.
- [x] **Opcode coverage** — a decode table for exactly the instructions `Code` emits (consts,
      locals/globals, calls + `call_indirect`/`return_call`, control flow with block-type immediates,
      `memarg` loads/stores, `memory.size`/`grow`, the i32/f64 arithmetic & comparison & conversion
      ops). An unknown byte is surfaced loudly (`;; unknown …`) and the harness asserts none ever appears.
- [x] **Small-integer cache + accounting** — the cache region sits at the base of memory (the bump
      pointer starts just past it); `main` inits the cells in a tight WASM loop; `boxInt` serves
      in-range values from it; `__allocCount`/`__allocBytes`/`__cacheHits` globals + exported getters are
      surfaced through the driver (`runWasm(...).heap`).
- [x] **WASM panel** — the disassembled **WAT** is now the default module view (header + a collapsible
      `(func …)` per function), with the hex dump + download kept behind a second toggle, and the live
      allocation stats (cells, bytes, cache hits) shown under the WASM column after a run. The
      "✓ matches the VM" badge is unchanged.
- [x] **Verification** — `tools/harness.mjs` grew a **disassembler battery** (every gallery + feature
      module: no unknown opcodes, balanced `(module …)`, one named `(func …)` per defined function,
      the named runtime helpers/entry present) and a **cache battery** (WASM ≡ VM preserved *and* a
      minimum number of integers served from the cache on integer-heavy workloads): 207 checks, green.
      The CI gate (conformance + lint + build) stays green.
- [x] **Docs** — Tour/About/README/`project.json` writeups for the disassembler, the name section and
      the cache.

Deferred (future, Aether 8.x+):

- [ ] Move the heap onto the **WasmGC** proposal (typed structs/arrays) so the engine manages
      memory and the host bridge reads real GC objects instead of raw cells.
- [ ] A **WASI** entry so the same module runs under `wasmtime`/`node --experimental-wasi` from a
      file, with `print` wired to stdout (blocked today by `show`/`print` living in the host bridge).
- [ ] Specialise saturated direct calls (skip the generic `apply` tag-dispatch when the arity is
      statically known) to cut per-call work.
- [ ] String values as real linear-memory byte arrays (UTF-8) rather than a host-side string pool,
      so a downloaded module is self-contained without the JS bridge for `^`/literals.

### Aether 9.0 — a real tracing garbage collector for the WASM heap (planned + shipping this session)

For eight releases the WebAssembly backend has had **one** memory-management strategy: a bump
allocator that *never frees*. The small-int cache (8.0) cut how much it boxes, but the heap still
grew without bound — run a long enough program and it climbs forever. 9.0 closes the oldest, hardest
deferred item on the list: a **sound, precise, non-moving tracing garbage collector** that actually
reclaims dead cells, written from scratch in hand-assembled WebAssembly — no host help, no WasmGC,
the same rule the encoder and disassembler live by.

The crux is the problem the 8.0 note flagged: a tracing GC needs to find **every root**, but in
WebAssembly the live pointers sit in the operand stack and in function locals, which the collector
(itself running as wasm) cannot introspect. The solution is a **shadow stack** — a second stack in
linear memory that codegen keeps in lock-step with the real one, holding exactly the heap pointers
that must survive an allocation. The collector marks from the shadow stack plus the module's value
globals, then sweeps the heap into a coalesced free list. Because the collector is **non-moving**,
objects never change address, so the pointers already sitting in wasm locals/operand-stack stay
valid across a collection — the shadow stack exists only to keep reachable objects *marked*, never
to rewrite them. That single design choice is what keeps the codegen surgery bounded.

The hard-won invariant is preserved and, in fact, *strengthened*: a new **GC stress mode** forces a
full collection before **every single allocation**, and the harness runs the entire WASM≡VM battery
under it — so every example is proven to compute the identical answer even when the collector is
firing maximally and reclaiming aggressively between every cell. If a single root were missing, a
live object would be swept and the answer would diverge; it does not.

Design (the root discipline, which is the whole game):

- **Shadow stack**: a region of i32 root slots with a `$shadowSp` global. `gcPush(p)` stores `p`
  and bumps `$shadowSp` in one step (a slot is never left reserved-but-unwritten, so the marker
  never reads garbage). Each compiled function captures `fp = $shadowSp` on entry and restores
  `$shadowSp = fp` at **every** exit (normal return *and* before every `return_call`), reclaiming
  its whole frame at once — a per-function activation record, robust to `match`/`if` control flow.
- **What gets rooted**: a lambda's `env`+`arg` on entry; every `let`/`letrec`/`type`-bound pointer
  for its lifetime; a `match` scrutinee (pattern-bound vars need no rooting — they point *into* the
  rooted scrutinee, and the collector is non-moving). Compound builders (`tuple`/`record`/`list`/
  record-update/`::`/`++`/compare/application) switch to **evaluate-then-construct**: every
  sub-value is pushed to the shadow stack *before* the cell is allocated, so a collection triggered
  mid-construction can never reclaim a sibling. Scalar-extracting paths (`a + b`, `a < b` loads the
  unboxed int/float, `^` loads the string id) need no rooting — nothing live is a pointer.
- **Self-protecting runtime helpers**: `mkCons`/`listAppend`/`recCopy`/`apply` root their pointer
  parameters on entry, and `apply` roots the partially-applied cell across the host `callNative`.
- **GC lock**: the wasm sets a `$gcLock` global around the `callNative`/`strConcat` imports, so the
  bridge's multi-step `encode` (which holds intermediate pointers only in JS locals) can never be
  interrupted by a collection. Pure-wasm execution always runs unlocked.

Plan / steps:

- [x] **Heap layout for a collector** (`layout.ts`) — a `FREE` block tag, a `MARK` bit stolen from
      the high bits of the tag word, a shadow-stack region and a 16-byte minimum/aligned cell so a
      freed cell always has room for a free-list node `{tag, size, next}`.
- [x] **The collector, in hand-written wasm** (`codegen.ts` runtime) — `gcPush`; a recursive
      `gcMark` that loops along cons spines (constant stack for long lists) and recurses through
      tuples/data/records/closures/pap cells, idempotent on shared/cyclic graphs; a `gcMarkRoots`
      that scans the shadow stack and every value global; a `gcSweep`/`gcCollect` that walks the
      heap linearly, coalesces adjacent dead/free runs into a free list, clears marks, and
      adaptively resizes the GC threshold from the measured live set.
- [x] **A free-list allocator** — `__alloc` rounds to a 16-byte-aligned cell, triggers a collection
      when the bytes-since-GC threshold (or stress mode) says so, serves first-fit-with-split from
      the free list, and falls back to bumping (growing memory) — all unchanged for callers.
- [x] **Codegen root discipline** — `fp` capture + frame pop at every function exit; root `env`/
      `arg`/`let`/`letrec`/`type`/`match`-scrutinee; evaluate-then-construct for every compound
      builder and two-pointer operator; the `$gcLock` wrapper around the allocating imports.
- [x] **GC accounting + controls** — globals/exports for collections run, bytes reclaimed, live
      bytes, peak heap, free-list reuse count, plus `__gcCollect`, `__setGcStress`, and the
      `$gcLock` setters, surfaced through `run.ts` into `WasmRunResult.heap`.
- [x] **The WASM panel** — show the new GC stats (collections, reclaimed, peak vs final, reuse) and
      a "Stress GC" toggle that re-runs the program collecting before every allocation, proving the
      result is identical.
- [x] **An allocation-heavy example** — build and discard many intermediate lists in a fold so the
      collector visibly reclaims (peak heap ≫ live heap), runnable on all three backends.
- [x] **Verification** — the headline: a **GC stress battery** in `tools/harness.mjs` that re-runs
      the entire WASM≡VM example + feature corpus with stress mode on (collect before every alloc),
      asserting byte-for-byte agreement; plus targeted tests that a long allocator loop's peak heap
      stays bounded (memory is genuinely reclaimed) and that the disassembler still names the new
      runtime functions with zero unknown opcodes. Keep the CI gate (conformance + lint + build)
      green.
- [x] **Docs** — Tour/About/README/`project.json` writeups for the garbage collector.

Shipped & measured: the harness grew from 207 → **249 checks, all green** (a 38-test GC battery: every
gallery example + the feature programs re-run under stress mode agree byte-for-byte, and the long
allocator loop is asserted to keep a bounded peak). Concretely, the `Garbage collector` example
allocates tens of MB over its run yet the **peak heap stays ~130 KB** — the collector reclaims and the
free list reuses cells — and the identical result under "collect before every allocation" is the proof
that the shadow-stack root set is complete. The CI gate (conformance + lint + build) stays green.

Notes for the next session: the collector is precise but *non-moving*, so the heap can fragment under
adversarial size mixes (the free list coalesces adjacent runs each sweep, but never compacts). A
natural follow-on is a **compacting / copying** collector (now that a precise root set exists, roots
*can* be rewritten — the cost is reloading pointers from the shadow stack after each safepoint), or
**generational** collection to cut the cost of the stress/threshold marking on long-lived data. The
`gcPush` per-root call could also be inlined to shave the shadow-stack overhead.

### Deferred (future, Aether 9.x+)

- [ ] A **compacting** collector (slide/Cheney) that returns memory to a single contiguous region and
      removes fragmentation — feasible now that the root set is precise, at the cost of pointer fixups
      and reloading locals from the shadow stack across safepoints.
- [ ] **Generational** GC (a nursery + promotion) so the common short-lived churn is collected cheaply
      without scanning the whole heap.
- [ ] **Inline** `gcPush`/frame push-pop (today a runtime call per root) to cut the shadow-stack cost.

### Aether 10.0 — an optimizing middle-end (planned + shipping this session)

For nine releases Aether grew *outward*: more of the front end (inference, kinds, type classes,
`deriving`), more ways to *run* a program (the bytecode VM, the JavaScript backend, the native
WebAssembly backend with its own garbage collector). The one stage that never grew was the bit *in
the middle*: a toy `optimize.ts` did literal constant folding and branch elimination on the surface
AST and nothing else — every backend faithfully compiled all the abstraction the front end piled on
(type-class dictionaries, `deriving` instances, `do`/comprehension/`|>` desugarings) exactly as
written. 10.0 closes that gap with the piece a serious compiler is judged on: a **real optimizing
middle-end** — a multi-pass, fixpoint rewriter over the *core* (the dictionary-passed, class-free
program) that all three backends then compile, so **one optimizer makes the VM, the JavaScript and
the WebAssembly faster at once**.

The crux, and the reason it fits Aether's hard-won invariant, is *where* it runs and *how it stays
honest*. It sits after elaboration and before every backend, so the bytecode VM compiles the
optimized core, and the JS/WASM backends lower the optimized user core — which means the project's
existing byte-for-byte equivalence checks (`✓ matches the VM`, run on every gallery example and
feature program) **re-prove, automatically, that the optimizer never changed an answer**. The harness
was pointed at the optimized core for exactly this reason: the same 249-check corpus now exercises
the shipping path, and a new battery runs every program *twice* (optimizer on/off) asserting identical
result, output and effect order plus a never-increasing VM-step count.

Every rewrite is semantics-preserving **for a strict, effectful language** — Aether is pure except
`print` and the turtle, whose effects are observable in order — so the whole engine rests on two
conservative predicates: `isValue` (evaluating it does no work and cannot diverge or raise; includes
saturated constructor applications of values) and `isPure` (no observable effect, terminates;
division/`%` only with a nonzero-literal divisor, a `match` only on a pure static scrutinee with a
definite pure arm). Inlining is **capture-avoiding** (binders that would capture a free variable of
the inlined term are α-renamed with `$opt_`-fresh names the lexer can never produce).

Plan / steps:

- [x] **A capture-avoiding core toolkit** (`optimize.ts`) — `freeVars` (memoised), `countUses`
      (shadowing-aware), `rename` (consistent, fresh-target so capture is impossible) and a full
      capture-avoiding `subst` that α-renames any `lambda`/`let`/`letrec`/`match`-pattern binder that
      would capture a free variable of the replacement. Plus `isValue`/`isPure` and a program-wide
      constructor-arity table so the analyses can recognise (saturated) constructor applications as
      data.
- [x] **A fixpoint pass manager** — one combined bottom-up rewriter (`step`) optimises children then
      fires at most one local rule per node, attributing each firing to a named counter; the driver
      re-runs it to a fixpoint (a round that performs zero rewrites), with a `MAX_ROUNDS` safety cap.
      Every rule is non-increasing on a well-founded measure, so it terminates well inside the cap.
- [x] **Constant folding + algebra** — integer/float arithmetic, comparison, boolean and string ops
      over literals (never folding a trap like `÷0`); unary `-`/`!` and `!!x`; identity & short-circuit
      laws (`x+0`, `0+x`, `x*1`, `x++[]`, `[]++x`, `x^""`, `true && x`, `false || x`) that keep the
      surviving operand evaluated exactly once.
- [x] **Branch elimination** — `if true … / if false …`, `if c then e else e` (pure `c`), and
      `if c then true else false ⇒ c` / `… false else true ⇒ !c`.
- [x] **β-reduction + let-floating + η-contraction** — `(fn x -> b) a ⇒ let x = a in b` (the exact
      operational meaning: sound, and it removes a closure allocation + call); `(let x = v in f) a ⇒
      let x = v in (f a)` so curried applications keep peeling (guarded against capture, and sound
      because both the VM and the JS backend evaluate the function position before the argument); and
      `fn x -> f x ⇒ f` when `x ∉ fv(f)`.
- [x] **Inlining, copy-propagation & dead-binding elimination** — substitute a `let`-bound *value*
      (atoms always; a `lambda`/compound value only when used once, so code never blows up); drop a
      pure, unused binding; turn an unused-but-effectful binding into a `seq`; a non-self-recursive
      `let rec` is **de-recursivised** to a plain `let` and a wholly non-recursive `letrec` group is
      **split** into a chain of `let`s — which is exactly how an instance dictionary (elaborated as a
      recursive `let`/`letrec` of method records) becomes inlinable.
- [x] **Known-constructor `match` reduction** — when the scrutinee is a statically-known, *pure* shape
      (a literal, tuple, list, `::`, or a saturated known-constructor application), test each arm
      statically: drop arms that provably cannot match, and reduce a definite, unguarded match to its
      arm with the pattern variables bound by `let`s (order-preserving, since the scrutinee evaluated
      once). The purity guard is what keeps a discarded sub-expression's effect alive
      (`match (Some (print 1)) with Some _ -> 0` is *not* reduced).
- [x] **Record field projection** — `{ a = e1, b = e2, … }.a ⇒ e1` when the dropped fields are pure
      (dictionaries are records of pure lambdas, so a method projection reduces to the method body,
      which β-reduction then applies — the link that lets a type-class call collapse).
- [x] **Wire it through the pipeline** — inference runs on the raw user AST (so the Types/AST/
      Derivation panels reflect the source); after elaboration the optimizer rewrites both the full
      program (compiled by the VM) and the user portion (lowered by the JS/WASM backends + shown in
      the panel). `coreAst` stays *unoptimized* (the Classes panel keeps showing raw dictionary
      passing); a new `optimizedCoreAst` + `optimization` stats feed the rest.
- [x] **An Optimizer inspector panel** — the rewrites broken down by rule (with a friendly
      description each), the node-count reduction (before → after, %), the optimized core
      pretty-printed (toggle to the before core), and a one-click **Measure VM steps** that runs the
      program with the optimizer on and off and shows the step reduction + a `✓ identical result`
      badge. The JS/WASM tabs now compile the *optimized* core (what ships).
- [x] **A gallery example** — *"The optimizing middle-end"*: a `class Area` whose method, applied to
      a literal `Circle`, melts from a dictionary lookup all the way to the single `Float` literal
      `12.56636` (user core 41 → 4 nodes), beside a folded, β-reduced `|>` pipe and an eliminated
      dead binding.
- [x] **Verification** — the harness now exercises the optimized core through JS *and* WASM (the
      shipping path), and a dedicated **optimizer battery** runs every gallery example + a dozen
      targeted per-pass programs twice (on/off): identical result/output/effects, never more VM steps,
      a minimum rewrite count and node-budget where stated, plus adversarial **soundness** cases
      (effect under a discarded field, print ordering, dead-but-effectful binding, capture avoidance,
      β under shadowing, an effectful scrutinee not optimized away). 249 → **304 checks, all green**;
      full CI gate (scope + conformance + lint + tsc + build) green.

Deferred (future, Aether 10.x+):

- [ ] **Multi-use dictionary specialization** — a value binding used more than once is not inlined
      (to avoid code blow-up), so a dictionary threaded to several call sites stays a record lookup;
      a targeted "duplicate-then-collapse" or per-instance method specialization would melt those too.
- [ ] **Inlining across `let`-bound non-values** when a single use is in strict, effect-free position
      (today only syntactic values are inlined), and **common-subexpression elimination**.
- [ ] **Type-directed optimization** — the optimizer is untyped; feeding inferred types in would
      enable e.g. specialising `show`/`compare` to a known monomorphic type, or unboxing.
- [ ] **A worst-case-cost / fuel view** in the panel, and per-pass before/after diffs.

### Aether 11.0 — common-subexpression elimination + a from-scratch effect-&-totality analysis (planned + shipping this session)

Aether 10.0 made *single-use* abstraction melt: a dictionary used once is inlined, its method
projected, β-reduced and folded away. But it left the oldest performance item on the list — a
program that computes the **same thing twice** still computes it twice. 11.0 closes that gap with
the optimization a serious compiler is judged on: **common-subexpression elimination (CSE)** — when
a program evaluates an identical expression more than once on a guaranteed path, compute it *once*
into a fresh binding and share the result. It is the dual of 10.0's story: 10.0 removed *abstraction*
overhead; 11.0 removes *recomputation*.

CSE in a strict, effectful language is subtle, and the whole feature rests on getting three safety
predicates exactly right — this is where the real work is:

1. **Effect safety.** Sharing two evaluations of `print x` would print once instead of twice, so CSE
   may only ever touch *effect-free* expressions. Aether's existing `isPure` predicate already means
   "no observable effect **and** terminates" — but it was deliberately conservative, treating *every*
   function application as impure. That throws away the most valuable CSE targets (repeated calls to a
   pure helper). So 11.0 first adds a **from-scratch interprocedural effect-&-totality analysis**: a
   fixpoint that discovers which user functions are *effect-free and total* (a non-recursive `let`/
   `letrec`-bound lambda whose body is pure, transitively — calling only other already-proven-pure
   functions and never itself), then teaches `isPure` that a *saturated* application of such a
   function to pure arguments is itself pure. Recursion (possible non-termination) or any call to an
   unknown/effectful function makes a candidate impure — conservative, so it can never be wrong.

2. **No speculation (the step-count invariant).** Hoisting a pure-but-conditional computation out of
   a branch would *add* work on paths that didn't need it — and the harness asserts the optimizer
   *never increases VM steps*. So CSE only ever shares occurrences that are **guaranteed to be
   evaluated**: it walks only the strict, binder-free evaluation frontier of a node (both sides of a
   strict binop, all tuple/record/list/application operands, `seq` halves, an `if`'s condition — but
   *not* an `if`'s arms, a `match`'s arms, a `&&`/`||` right operand, or a lambda body), so every
   occurrence it merges already ran on every path that reached the others. Because a non-recursive
   `let` costs exactly one extra VM instruction over evaluating its value and body (verified against
   the compiler), sharing an expression of evaluation-cost ≥ 4 is a *strict* step win; the pass is
   gated on that, so it can only ever reduce — never increase — runtime work.

3. **Capture safety.** The shared binding is hoisted to wrap the node whose frontier the occurrences
   live on. Because the frontier-walk crosses **no binder**, every occurrence denotes the same value
   and all its free variables are already in scope at the hoist point — so wrapping the node in
   `let cse = s in …` is scope-safe by construction (no α-renaming needed, unlike inlining).

Because CSE emits an ordinary `let` + `var` references, the bytecode VM, the JavaScript backend and
the WebAssembly backend compile it with **zero** changes — and the project's hard-won invariant does
the rest: the existing `✓ matches the VM` equivalence checks, run on every gallery example through
all three backends, **re-prove automatically that CSE never changed an answer**, and the optimizer
battery re-proves it never added a VM step.

Plan / steps:

- [x] **Interprocedural effect-&-totality analysis** (`optimize.ts`) — a fixpoint `analyzePurity`
      that returns the set of `let`/`letrec`-bound function names (with arities) that are provably
      effect-free *and* total: a non-recursive lambda whose body is pure under the growing set, with
      mutual-recursion groups excluded wholesale. Store it module-wide like the constructor table.
- [x] **Extend `isPure`** so a *saturated* application of a proven-pure function to pure arguments is
      pure (partial applications are values already; over-application stays conservative). This alone
      strengthens dead-binding elimination and `if c then e else e` collapse for free — re-proven by
      the existing soundness battery.
- [x] **The CSE pass** — a `tryCse(node)` that fires only on strict combinator nodes; collect the
      pure, cost-≥4 subexpressions on the node's binder-free strict frontier (canonicalised, ignoring
      spans); when one occurs ≥ 2 times, hoist it into a fresh `let cse$opt_n = s in node'` and
      replace exactly those frontier occurrences with the new variable. Capture-safe by construction;
      strictly non-increasing on VM steps; terminates (each firing removes a duplicate).
- [x] **Wire CSE into the fixpoint** rewriter and the per-rule rewrite counter, with a friendly label
      in the Optimizer panel.
- [x] **A round-by-round optimization trace** — `optimizeCore` records each fixpoint round's rewrite
      count and node total; the Optimizer panel renders the *melt* as a step-by-step trace, so the
      multi-pass nature (CSE exposing a dead binding exposing a fold, …) is legible, not a black box.
- [x] **A flagship gallery example** (`cse`) — a numeric kernel that evaluates a sizeable pure
      sub-expression several times (and a pure helper called repeatedly), so CSE visibly shares the
      work; runnable identically on all three backends.
- [x] **Verification** — a dedicated CSE battery in `tools/harness.mjs`: targeted programs where CSE
      must fire, strictly cut VM steps, and keep the identical result/output across JS + WASM; the new
      gallery example auto-flows through the JS/WASM/GC/disassembler batteries; and adversarial
      soundness cases (CSE must **not** merge two effectful calls, must **not** hoist out of a branch,
      must respect a mis-analysed-as-pure boundary). Plus an in-app self-test group. Keep the full CI
      gate (scope + conformance + lint + tsc + build) green.
- [x] **Docs** — Tour/About/README/`project.json` writeups for CSE, the effect analysis and the trace.

Shipped & measured: the harness grew 304 → **322 checks, all green** (the new `cse` gallery example
flows through the JS / WASM / GC-stress / disassembler / optimizer batteries; an 8-test CSE battery
covers firing, real step cuts, the proven-pure set, and the adversarial soundness cases — no effect
merged, no speculation across branches, recursive and effectful functions never admitted; plus 3
in-app self-tests). Concretely the `cse` example's `dist2 ox oy px py`, written four times, is
computed **once** (4 CSE rewrites; VM steps 219 → 99), and `dist2` is reported as proven-pure in the
panel. The full CI gate (scope + conformance + lint + tsc + build) stays green.

Deferred (future, Aether 11.x+):

- [ ] **CSE across a `let`** — the frontier walk stops at every binder, so a subexpression repeated
      across a `let` boundary (but with all free vars in scope above it) is not yet shared; a
      dominator-based available-expressions pass would catch those.
- [x] **Effect-free *but partial* calls** — totality was approximated by "non-recursive"; **Aether
      13.0** replaces that with a real **size-change termination** analysis (`termination.ts`), so CSE
      now shares pure-but-recursive calls (`length`, tree folds, a Peano-`Nat` factorial, …). Honest
      and first-order: an unbounded `Int` countdown and higher-order combinators are left unproven.
- [x] **Whitelisting total, effect-free *natives*** (`sqrt`/`sin`/`cos`/`floor`/`toFloat`/`abs`/
      `strlen`/`toUpper`/`toLower`/`parseInt`/`min`/`max`) so their repeated calls are shareable too —
      trusted only when the name is *not* shadowed by a user binding (the partial `head`/`tail` and the
      effectful `print`/turtle natives are deliberately excluded).

## Standard library

- list: `map filter foldl foldr length append reverse sum range take drop elem all any concat zip replicate`
- string: `strlen toUpper toLower chars join parseInt` (+ `show`, `^`)
- primitives: `head tail empty print sqrt sin cos floor toFloat pi abs min max`
- operators: `+ - * / % | +. -. *. /. | == != < > <= >= | && || ! | :: ++ ^ | |> | ;`

## Session log

- 2026-06-13 (claude): Built the whole thing from scratch. Implemented the full pipeline
  (lexer -> parser -> HM inference -> bytecode compiler -> stack VM -> turtle), verified the
  core with a Node type-stripping harness (20 unit cases + all 7 examples), then built the
  React playground and content pages. Passes the CI gate (conformance + lint + build).
- 2026-06-13 (claude): Added pattern matching (`match`) end to end — patterns for literals,
  wildcards, tuples and lists (`[]`, `h :: t`, `[a, b]`), typed in the inferencer and compiled
  to a constructor-test/extract decision sequence (new VM ops IS_NIL/IS_CONS/HEAD/TAIL/
  TUPLE_GET/MATCH_FAIL). Added tail-call optimisation (TAILCALL reuses the current frame →
  constant-space tail recursion, visible in the debugger). Added editor persistence +
  shareable `?c=` links and a run-length-encoding example. Verified (11 match cases + TCO
  depth checks + example regressions); gate green.
- 2026-06-13 (claude): Added user-defined algebraic data types: `type Name p.. = C t.. | …`
  declarations with a small type-expression grammar, constructor schemes fed into HM inference,
  constructors as first-class curried values (`data`/`ctor` runtime values), and constructor
  patterns in `match` (new ops CTOR_TAG/CTOR_GET). Fixed type pretty-printing to parenthesise
  applied type constructors as arguments. Added an expression-interpreter example and an
  Option/safe-lookup example. Verified (11 ADT cases incl. recursive Tree, Either, polymorphic
  None, ctor-as-function, nested patterns, type errors); gate green.
- 2026-06-13 (claude): Added mutually recursive bindings (`let rec f = … and g = …`). New
  `letrec` AST node; inference types the whole group monomorphically then generalises each;
  the compiler reserves every slot up front so closures capture their siblings by reference
  (forward references included). Tail calls between mutually recursive functions stay
  constant-space. Added a mutual-recursion example + Tour note. Verified (even/odd, three-way,
  forward refs, ADT, polymorphism, single-let-rec regression, TCO depth = 2); gate green.
- 2026-06-13 (claude): Added match exhaustiveness + redundancy checking — Maranget's usefulness
  algorithm (`exhaustive.ts`) specialised to our pattern domain (literals, bool/unit, lists,
  tuples, user ADTs). Reports non-exhaustive matches with a concrete witness pattern (e.g.
  `_ :: _`, `None`, `_ :: _ :: _`) and flags unreachable clauses, as non-fatal warnings —
  surfaced with amber squiggles in the editor and a warnings strip in the status bar. Verified
  (15 coverage cases incl. nested lists, ADTs, finite/infinite types, redundancy) and all 11
  examples stay warning-clean; gate green.
- 2026-06-13 (claude): Added an optimizer pass (`optimize.ts`) run before compilation — constant
  folding (int/float/comparison/boolean/string), dead-branch elimination (`if true …`), and
  short-circuit simplification (`true && x` → `x`). Semantics-preserving (never folds e.g.
  division by zero). Toggle in the playground; the status bar shows how many nodes were folded.
  Verified results are identical optimized vs not across all examples (fractal tree drops
  ~2000 VM steps); gate green.
- 2026-06-13 (claude): Added records with row polymorphism. Record literals `{ x = 1, y = 2 }`,
  field access `r.x`, and a structural record type backed by rows (`Record` over a row of
  `row:label` extensions ending in a closed `{}` or a row variable). Unification gained the
  Rémy/Leijen row algorithm (rewrite-row + tail-variable extension) so `fn r -> r.x` infers
  `{ x: a | ρ } -> a` and works on any record with that field. New VM ops MAKE_RECORD/FIELD_GET;
  record runtime value with structural equality. Added a records example + Tour/Internals notes.
  Verified (11 cases incl. row polymorphism, nested records, records-in-lists, ADT fields,
  structural equality, missing-field & type-mismatch errors); all examples regress clean; gate
  green.
- 2026-06-13 (claude): Added functional record update `{ r | x = … }` — produces a new record
  from an existing one with fields replaced (immutable; original untouched). Type-safe via row
  unification (updated fields must already exist with a matching type) and row-polymorphic, so
  `fn r -> { r | x = r.x + 1 }` works on any record carrying x and preserves the rest. New VM op
  RECORD_UPDATE; parser disambiguates literal vs update with a 2-token lookahead. Verified
  (8 cases incl. row-polymorphic update, chaining, immutability, nested base, type errors);
  examples regress clean; gate green.
- 2026-06-13 (claude): Added a REPL page (`#/repl`). Keeps top-level `let`/`type` definitions as
  source and re-wraps them as nested `let … in` / `type … in` around each new input, reusing the
  whole pipeline (no special VM support). Each submission is tried as an expression first, then as
  a bare definition; results print with their inferred type, the prelude stays in scope, and
  errors are reported. History recall (↑/↓), a sample-session button, and reset. Verified a full
  session (functions, recursion, an ADT + match, records, update, prelude, errors); gate green.
- 2026-06-13 (claude): Expanded the standard library — native string ops (strlen, toUpper,
  toLower, chars, join, parseInt) and Aether-source list functions (take, drop, elem, all, any,
  concat, zip, replicate). Added a FizzBuzz example (divisibility via integer division, map +
  join). Verified each function's value & inferred type; examples regress clean; gate green.
- 2026-06-13 (claude): Added the pipe operator `|>` (`x |> f` desugars to `f x`, so no inference/
  VM changes), an integer modulo operator `%` (new MOD opcode, constant-folded), and numeric
  natives `abs` plus polymorphic `min`/`max` (via structural compare). Rewrote FizzBuzz to use
  `%` and a `|>` pipeline. Verified pipe chaining/precedence, modulo (+ by-zero error), and
  min/max at Int/String/Float; examples regress clean; gate green.
- 2026-06-13 (claude): Added two showcase turtle fractals — a Sierpinski arrowhead (an L-system
  written as two mutually recursive functions, `let rec a … and b …`) and the Heighway dragon
  curve (a tiny sign-flipping recursion, 2^13 segments). Example-only addition; gate green.
- 2026-06-13 (claude): Added pattern guards (`| pat when cond -> body`). The guard is typed as
  Bool in the pattern's bindings; the match compiler evaluates it after binding and, on failure,
  pops the bindings and falls through to the next clause. Exhaustiveness was updated so guarded
  clauses don't count toward coverage (a `when` might be false) while still being checked for
  redundancy. Added a guards example + Tour note. Verified (fall-through, bindings-in-guard,
  recursion w/ guard cleanup, exhaustiveness/redundancy interaction, non-bool guard error);
  examples regress clean; gate green.
- 2026-06-14 (claude): **Aether 2.0 — a second backend & deeper insight.** Three substantial
  additions, all sharing the existing front end:
  (1) **JavaScript backend** (`jsBackend.ts`): the same type-checked AST is lowered to readable,
  self-contained JavaScript paired with a tiny runtime that mirrors the VM's value model exactly
  (tagged ints/floats so `show` formats identically, the same structural comparison driving
  `==`/`<`, the same turtle effect log). Functions become curried arrow functions, `let`/`type`
  flatten into a `const` spine, `match` becomes pattern tests with block-scoped bindings, and
  every binder is alpha-renamed to a unique JS identifier so Aether's free shadowing (and prelude
  overrides) never collide. A new JavaScript tab shows the generated code and runs it in-browser
  via `new Function`, comparing result + stdout + draw-command count against the bytecode VM with
  a live "matches the VM ✓" badge.
  (2) **List comprehensions**: a `<-` lexer token plus a pure parser desugaring of
  `[ e | x <- xs, guard, y <- ys ]` into `concat`/`map`/`if`, so they type-check under HM and run
  on *both* backends with zero inference/compiler/VM changes.
  (3) **Type-derivation tree** (`derivation.ts`, the long-open backlog item): reconstructs the HM
  proof tree from the per-node types inference already records, rendered as a collapsible
  natural-deduction derivation (one typing rule per step, premises justifying `expr : τ`).
  Added comprehensions + JS-backend examples (primes, Pythagorean triples), refreshed the
  Tour/About pages, README and card metadata. Verified with a 106-check Node type-stripping
  harness (JS≡VM across every gallery example, comprehension semantics incl. dependent
  generators, prelude/let shadowing, integer wraparound & truncating division, ADT/record `show`)
  plus a react-dom/server render smoke test for the two new panels; full CI gate green.
- 2026-06-14 (claude): **Aether 3.0 — Type classes.** Added principled overloading on top of
  Hindley–Milner, the headline missing feature for an ML-family language, implemented as a
  *type-directed translation into the existing core* so **both backends got it with zero changes**.
  New surface syntax — `class C a where m : τ, … in body`, `instance Ctx => C Head where m = e, …
  in body`, the `=>` arrow and `:` for signatures (new `classdecl`/`instancedecl` AST nodes wired
  through every AST walk). Types gained predicates and qualified schemes (`∀a. Disp a => a ->
  String`). Inference (`infer.ts`) now does constraint generation + context reduction for a
  single-parameter class system: a method/constrained binding instantiates to fresh obligations;
  ground-headed obligations resolve to instance dictionaries (recursing through written instance
  contexts, *including self-referential recursive instances* like `Disp (Tree a)`); variable-headed
  ones defer to a dictionary parameter captured at the nearest `let` generalization, with recursive
  self-calls re-threading their own dictionaries. A new `classes.ts` carries the evidence
  representation and the **dictionary-passing elaboration**: instances → records (a recursive
  `let`), constrained bindings → dictionary-abstracted lambdas, method calls → field accesses, use
  sites → evidence applications — and it's the identity on class-free programs (so every existing
  example is byte-for-byte unchanged). Added a **Classes** inspector tab (declared classes +
  instances + the elaborated core, via a new core pretty-printer `unparse.ts`), three examples
  (overloaded `Disp`, ad-hoc `Shape` across distinct types, `Semigroup` + a generic `mconcat`),
  REPL recognition of `class`/`instance` definitions, highlighter keywords, and Tour/About/README
  writeups. Verified with a Node strip-types harness: 13 targeted cases (basic overloading,
  constrained polymorphism, recursive `List`/nested/`Tuple`/`Tree` instances, multi-method classes,
  dictionaries threaded through `let rec`, methods as first-class values, and the no-instance /
  missing-method / ambiguous-constraint errors) **plus all 21 gallery examples run on both backends
  with JS≡VM matching**. Full CI gate (conformance + lint + tsc + build) green.
- 2026-06-14 (claude): **Default methods.** A class method can now carry a default implementation
  (`ne : a -> a -> Bool = fn x y -> if eq x y then false else true`); an instance need only supply
  what it overrides. Each instance clones the default so its elaboration is independent, and the
  default's calls to the class's other methods resolve against the instance being defined (the
  instance dictionary is a recursive `let`, so this just works). Added a `default-methods` example
  (an `Eq` class over `Int` and a `Colour` enum, plus a generic `member`), a "has default" marker in
  the Classes panel, and Tour notes. Verified with a 4-case strip-types harness (default used,
  overridden, shared across instances, default calling another method) plus all 22 gallery examples
  green on both backends; full gate green.
- 2026-06-14 (claude): **In-browser self-test suite.** Added a `testSuite.ts` (18 cases across core
  language, type classes, default methods and rejected-error cases) and a **Tests** page that runs
  it live: each case flows through the whole pipeline and, when it yields a value, is run on the VM
  *and* the JavaScript backend, so a green row proves the two backends agree byte-for-byte. The same
  module backs the offline Node check. Full gate green (18/18 in-app, all 22 gallery examples).
- 2026-06-14 (claude): **Aether 4.0 — property-based testing + do-notation.** Shipped *Aether
  Check* (`property.ts`): a from-scratch QuickCheck that reads each `prop_*`'s inferred type,
  generates random inputs from it (numbers/strings/lists/tuples/records + recursive user ADTs with a
  size budget so `Tree` terminates), batches hundreds of cases through the real VM (one compile per
  round, with a per-case fallback to attribute a crash), and shrinks any failure to a minimal
  counterexample — deterministic via a seeded mulberry32 RNG. Exposed `ctorInfo`/`typeCtors` from
  inference and added `executeProgram` so the runner reuses the exact pipeline. Added a **Check**
  tab, a `property` example (3 laws pass, a buggy dup-dropping sort is falsified at a 2-element
  list) and an engine self-test suite (`propertySuite.ts`, 11 cases) surfaced on the Tests page.
  Also added **`do`-notation** — a `do` keyword + a pure parser desugaring to `bind`
  (`do { x <- e; rest }` ⇒ `bind e (fn x -> rest)`), so the same block is the Option or List monad
  depending on the `bind` in scope; no inference/compiler/VM/JS changes, and the new do cases prove
  JS≡VM. Docs (Tour/About/README) updated. Full gate green (22/22 pipeline + 11/11 engine
  self-tests; 24 gallery examples).
- 2026-06-14 (claude): Extended Aether Check to **generate random function arguments** — a
  generated `A -> B` is a finite table desugared to `fn x -> if x == k1 then v1 else … else dflt`,
  so higher-order laws (map fusion, `length (filter p xs) <= length xs`) are now tested instead of
  skipped, and a false one like `f (f x) == f x` is falsified with a concrete little function
  (e.g. `{-1→0, _→-1}` at `0`) and shrunk to fewer entries. Engine self-tests now 12/12; gate green.
- 2026-06-15 (claude): **Aether 5.0 — a kind system & higher-kinded types.** Closed the headline gap
  every prior session deferred: type classes now range over **type constructors**, so genuine
  `Functor`/`Applicative`/`Monad` classes are expressible and a single generic combinator (`mapM`)
  runs in *every* monad. Surgical representation change — a new `TApp{fn,arg}` node for
  (variable-headed) type application alongside the existing first-order `TCon`, with unification
  bridging them (a `TCon` of arity ≥ 1 decomposes into an application spine, so `m a` unifies with
  `Option a` by binding `m := Option`); `spineOf`/`freeVars`/`occurs`/`subst` and an arity-aware type
  printer all learned it. Added a from-scratch **kind system** (`kinds.ts`): kinds `* | k -> k`
  inferred by unification, so each class parameter's kind is read off its method signatures
  (`Monad m ⇒ m : * -> *`), every `class`/`instance`/`type` declaration is kind-checked, and
  `instance Monad Int` is rejected (`Int : * ≠ * -> *`). Added **superclasses**
  (`class Functor f => Monad f`) with superclass dictionaries (`$super_Functor` fields) and
  **constraint entailment** — a `Monad m` constraint discharges a `Functor m` one by projecting
  through the dictionary, so the inferred scheme reads `Monad m =>` and an instance requires its
  superclass instance. `do`-notation now resolves through the real `Monad` class (the same block is
  the Option / List / State monad by type). Two new gallery examples (the Functor→Applicative→Monad
  hierarchy + a `State s` monad as a partially-applied constructor), the Classes panel shows each
  class's inferred kind + superclass context, and a committed Node harness (`tools/harness.mjs`) runs
  the gallery, the in-app self-test + property suites, and a focused HKT battery — 82 checks green;
  full CI gate (scope + conformance + lint + tsc + build) green.
- 2026-06-16 (claude): **Aether 6.0 — `deriving`.** Closed the last "real ML/Haskell-family language"
  gap: a `type` declaration may now end with `deriving (Eq, Ord, Show, Enum, Bounded, Functor,
  Foldable)` and the compiler **synthesises the instances**, generating each method from the data
  type's shape. `Eq`/`Ord`/`Show` recurse structurally *through the class method* (so a parametric or
  recursive type gets an inferred context like `Eq a => Eq (Tree a)`, bottoming out at the leaves'
  own instances): `Eq` is `&&`-folded field equality, `Ord` is `compare : a -> a -> Int` (constructor
  declaration order, then lexicographic fields), `Show` prints Haskell-style `(Ctor f1 f2 …)`.
  `Enum`/`Bounded` index and fence a C-style enum (`fromEnum`/`toEnum`, `minBound`/`maxBound`). The
  headline is position-aware **`deriving Functor`** and **`deriving Foldable`**: `fmap`/`foldr` written
  by walking the type's *last* parameter — applied where it sits directly, and recursing through the
  type itself, through `List` (an inline right fold for `Foldable`, so no `Foldable List` instance is
  needed) and through tuples; the instance head is the type applied to its other parameters (kind
  `* -> *`), unified against the class through the 5.0 `TApp`/`TCon` bridge. The whole feature is
  **pure parse-time desugaring** into ordinary `instance` declarations nested in the type's body
  (`deriving.ts`; one new keyword + a parser hook + an optional `derived` marker on `instancedecl`),
  so inference type-checks, kind-checks, *infers each instance's context* and elaborates them exactly
  like hand-written ones — and the bytecode VM and the JavaScript backend run derived instances with
  **zero** added code. Generated `match`es are exhaustive and non-redundant (no spurious warnings).
  Rejected with clear messages: a non-derivable class, `Enum` on a type with fields, `Functor`/
  `Foldable` on a parameterless type (or a parameter in a function-argument position), and the one
  unfoldable shape (a type nested inside a list under `Foldable`). Added three gallery examples
  (`deriving (Eq, Ord, Show)` sorting a hand of cards by the derived order; an `Enum`/`Bounded`
  weekday enum; a `deriving (Functor, Foldable)` tree mapped and folded generically), a `deriving`
  self-test group (8 cases) + 3 rejection cases on the Tests page, a Classes-panel **derived** badge,
  the `deriving` highlighter keyword, and Tour/About/README/`project.json` writeups. The Node harness
  grew a focused `deriving` battery (every synthesised method, JS≡VM throughout, the rejection cases)
  — **126 checks green**; full CI gate (scope + conformance + lint + tsc + build) green.
- 2026-06-16 (claude): **Aether 7.0 — a native WebAssembly backend.** Added the headline a language
  toolchain is judged on: a *third* compilation target that emits **real WebAssembly bytecode**. The
  same type-checked, dictionary-elaborated core AST is now hand-assembled into a `.wasm` module by a
  from-scratch binary encoder (`src/wasm/encoder.ts` — LEB128 + every module section + a typed
  instruction builder; **no `wabt`, no `binaryen`**), which the browser **instantiates and runs**.
  WASM genuinely executes the program: a tagged linear-memory heap (`layout.ts`) over a bump
  allocator (`__alloc`, grows on demand); each `lambda` is a WASM function and closures dispatch
  through `call_indirect`; **tail calls use the WebAssembly tail-call proposal (`return_call`)** so
  deep/mutual recursion runs in constant stack, matching the VM's TCO; arithmetic, number/bool
  comparison, list/tuple/record/ADT construction and `match` (block-structured tests + `br_if`) all
  lower to native WASM. The inherently host-side operations — printing, `show`'s formatting,
  structural/lexicographic comparison, `sin`/`sqrt`, string ops and the turtle — are **three imports
  that decode WASM heap pointers into the VM's exact `Value` model and reuse the VM's own code**
  (`bridge.ts`), so the WASM result, output and drawing match the bytecode VM **byte-for-byte by
  construction**. Codegen (`codegen.ts`) does closure conversion with free-variable analysis
  (top-level bindings become WASM globals so top-level recursion needs no back-patching; nested
  `let rec` ties the knot by filling a closure's own env slot after allocation), routes `head`/`tail`/
  `empty` inline for speed, and threads tail position. The driver (`run.ts`) assembles, instantiates
  and runs, and surfaces the module's section table, a hex dump and a **download** for the real
  `.wasm`. Added a **WebAssembly** inspector tab (run → compare → live "✓ matches the VM" badge +
  module stats), a "Compile me to WebAssembly" gallery example, and Tour/About/README/`project.json`
  writeups. The Node harness (`tools/harness.mjs`) now instantiates the *real* emitted module under
  Node's `WebAssembly` and asserts **WASM ≡ VM** across **all 31 gallery examples** plus a focused
  feature battery (int/float arithmetic, closures & currying, the higher-order prelude, deep tail
  recursion at depth 100k, mutual recursion, ADT/`match`/guards, records + update + row polymorphism,
  strings + `show`, the nested-`let rec` knot, comprehensions, print ordering, polymorphic ADT
  compare) — **171 checks green**; full CI gate (scope + conformance + lint + tsc + build) green.
- 2026-06-16 (claude): **Aether 8.0 — a self-describing WebAssembly backend.** Knocked out the two
  oldest items on the 7.x deferred list and added a measured runtime win, all inside `src/wasm/`,
  the WASM panel and the harness. (1) **A from-scratch WAT disassembler** (`wasm/disasm.ts`) — the
  mirror image of the from-scratch encoder: a real WebAssembly *binary decoder* (LEB128/`f64`/UTF-8
  reader; type/import/function/memory/global/export/code/`name` section parsing) that renders the
  module the encoder just produced back into canonical, indented **WAT text**, with a complete opcode
  table for exactly the instructions `Code` can emit and structured `block`/`loop`/`if`/`end` nesting.
  (2) **An emitted `name` custom section** (`encoder.ts`) — function, local (`$env`/`$arg`) and global
  names, so the WAT reads `call $map` / `global.get $heap` instead of raw indices; codegen threads a
  name through every runtime helper, compiled lambda (named after its binding), `main` and global.
  (3) **A measured small-integer cache + live heap accounting** — the bump allocator now reserves a
  block of shared pre-built `INT` cells at the base of memory and `boxInt` returns them for in-range
  values (invisible to results: Aether is pure and values compare structurally), and the module
  exports `__allocCount`/`__allocBytes`/`__cacheHits` so the panel and harness report the allocations
  saved (e.g. a `range 0 500` fold serves 500+ ints from the cache). The WASM panel now defaults to the
  disassembled WAT (collapsible per function) with hex + download behind a toggle, and shows the heap
  stats after a run. Harness grew a disassembler battery (every module: no unknown opcodes, balanced
  parens, one named `(func …)` per defined function) and a cache battery (WASM ≡ VM preserved *and*
  the cache demonstrably serves a minimum number of ints) — **207 checks green**; full CI gate
  (scope + conformance + lint + tsc + build) green.
- 2026-06-18 (claude): **Aether 10.0 — an optimizing middle-end.** Replaced the toy surface-AST
  constant folder with a real, multi-pass, fixpoint **optimizer over the elaborated core** that all
  three backends compile — so one optimizer speeds up the bytecode VM, the JavaScript backend and the
  WebAssembly backend at once, and the project's existing byte-for-byte equivalence checks re-prove on
  every program that the answer never changed. New `optimize.ts`: a capture-avoiding core toolkit
  (memoised `freeVars`, shadowing-aware `countUses`, fresh-target `rename`, full α-renaming `subst`),
  conservative `isValue`/`isPure` predicates (a saturated constructor application of values is data;
  `÷0`/`%0` and effectful/partial `match`es are impure) and a program-wide constructor-arity table,
  driving a bottom-up `step` rewriter to a fixpoint. The passes: constant folding + algebraic
  identities + short-circuits; branch elimination; β-reduction (`(fn x -> b) a ⇒ let x = a in b`) with
  let-floating for curried calls and η-contraction; capture-avoiding inlining / copy-propagation of
  value bindings (atoms always, lambdas/compounds only single-use); dead-binding elimination;
  de-recursivising a non-recursive `let rec` and splitting a non-recursive `letrec` group (so instance
  dictionaries become inlinable); **known-constructor `match` reduction** (a `match` on a pure
  statically-known literal/tuple/list/constructor collapses to its arm, binding fields with `let`s and
  dropping impossible arms); and **record field projection** (`{ a = e, … }.a ⇒ e` when the dropped
  fields are pure). Together these make abstraction *melt away*: a `class` method call on a literal
  constructor inlines the dictionary, projects the method, β-reduces, picks the `match` arm and folds
  the arithmetic — the new *"The optimizing middle-end"* gallery example reduces `area (Circle 2.0)`
  to the single literal `12.56636` (core 41 → 4 nodes, VM steps 135 → 31). Wired through the pipeline
  (inference now runs on the raw user AST so the Types/AST/Derivation panels reflect the source; a new
  `optimizedCoreAst` + per-rule `optimization` stats feed the backends and a new **Optimizer** tab that
  shows the rewrite breakdown, node-count reduction, before/after core and a one-click VM-step
  measurement). Tour/About/README/`project.json` updated. The harness now drives the *optimized* core
  through JS and WASM (the shipping path) and adds an optimizer battery — every example + targeted
  per-pass programs run twice (on/off) for identical result/output/effects and never-more steps, plus
  adversarial soundness cases (effect under a discarded ctor field, print ordering, dead-but-effectful
  binding, capture avoidance, β under shadowing, an effectful scrutinee left intact): **304 checks
  green**; full CI gate (scope + conformance + lint + tsc + build) green.
- 2026-06-19 (claude): **Aether 11.0 — common-subexpression elimination + an effect-&-totality
  analysis.** Where 10.0 made *abstraction* melt, 11.0 removes *recomputation*: a new **CSE** pass in
  the optimizing middle-end finds an expression a node's strict, binder-free evaluation frontier
  computes more than once and hoists it into a single fresh `let`, sharing the result — so the bytecode
  VM, the JavaScript backend and the WebAssembly backend all run the shared program (it emits an
  ordinary `let`, so zero backend changes) and the existing byte-for-byte equivalence checks re-prove,
  on every example, that the answer never changed. The whole feature rests on three safety invariants:
  CSE only ever touches **effect-free, terminating** expressions (so a `print` is never merged); it
  only merges occurrences **guaranteed to be evaluated** — it walks only the strict frontier (both
  sides of a strict binop, all tuple/record/list/application operands, `seq` halves, an `if`'s
  condition, but never an arm, a `&&`/`||` right operand or a lambda body) — so VM steps can only fall
  (a shared `let` is exactly one extra instruction, verified against the compiler, so sharing a
  cost-≥3 expression is provably non-increasing); and the hoist crosses **no binder**, so it is
  scope-safe with no α-renaming. To reach the most valuable targets — repeated *calls* to a pure
  helper — the existing conservative `isPure` (which treated every application as impure) is now backed
  by a from-scratch **interprocedural effect-&-totality analysis** (`analyzePurity`): a monotone
  fixpoint that proves which never-shadowed, non-recursive `let`/`letrec`-bound functions are
  effect-free and total, so a *saturated* call to one (on pure args) is itself pure and shareable —
  conservative by construction (recursion, shadowing, or any unknown/effectful call disqualifies a
  candidate), which also strengthens dead-binding elimination for free. A small whitelist of total,
  effect-free *natives* (`sqrt`/`floor`/`min`/… — never the partial `head`/`tail` or the effectful
  `print`/turtle) is trusted too, but only when the name is not user-shadowed. The Optimizer panel gained the
  `cse` rule, a **round-by-round fixpoint trace** (watch the core melt), and a list of the functions
  proven pure. Added a `cse` gallery example (`dist2 ox oy px py` written four times collapses to one;
  steps 219 → 99). Verification: the harness grew 304 → **322** — the new example auto-flows through
  the JS / WASM / GC-stress / disassembler / optimizer batteries, a 10-test CSE battery asserts CSE
  fires (incl. a shared total-native call), cuts real steps, reports the proven-pure set, and — the
  safety half — never merges an effect, never speculates across a branch, never admits a recursive or
  effectful function, and distrusts a shadowed native; plus 3 in-app self-tests. Full CI gate (scope +
  conformance + lint + tsc + build) green.
- 2026-06-19 (claude): **Aether 12.0 — compiling pattern matching to good decision trees.** Aether had
  cited **Maranget** since 1.0, but only for *exhaustiveness* — the compiler itself lowered `match`
  naively, re-testing a shared constructor prefix once per arm (two arms `Cons a (Cons b r)` /
  `Cons a Nil` test the outer `Cons` twice). 12.0 ships the companion algorithm — *Compiling Pattern
  Matching to Good Decision Trees* (Maranget, 2008) — as a new middle-end pass (`src/lang/decisiontree.ts`):
  a pattern-matrix compiler that tests each scrutinee position **once**. `compile(occs, rows)` switches on
  the column whose row-0 pattern is refutable and that the most rows test (a sharing heuristic), emitting
  one arm per head constructor present (`pcon`/`::`/`[]`/tuple/literal/bool), specializing the matrix per
  constructor (constructor rows expand their sub-patterns into new columns; var/wildcard rows propagate
  into every arm), with a default arm only when the column's signature is incomplete — bottoming out at a
  leaf when row 0 is all-irrefutable, threading `patVar ↦ occurrence` bindings down the tree. **Guards**
  keep the naive "first matching, guard-passing arm wins" semantics (a guarded leaf is `if g then body
  else <compile the rest of the still-live matrix>`), and a non-exhaustive switch is emitted *without* a
  default arm so it `MATCH_FAIL`s at runtime exactly where the source did. The decisive choice (the one
  that gave 10.0/11.0 three backends for free): it's a **core-to-core** transformation — the tree lowers
  into a nest of *single-column* `match`es plus `let`-bound **join-points** for arm bodies reached from
  more than one leaf (so the tree never blows up code size; single-use bodies are inlined and their
  `let v = occ` aliases copy-prop away), so the bytecode VM, the JavaScript backend and the WebAssembly
  backend compile it **unchanged**. Wired into `optimizeCore` as a phase between two fixpoints (fixpoint →
  DT → fixpoint, to clean up the introduced bindings), gated by a `worthDecisionTree` check so already-flat
  enum/`Option` matches (where the naive compiler is optimal) are left byte-identical. The **Optimizer
  panel** gained a "Decision trees" section that draws each compiled match's tree (switch nodes by
  occurrence, edges by constructor, leaves by arm) and reports the pattern tests shared away; a
  `decision-tree` gallery example (an expression-peephole simplifier whose rules share `Add`/`Mul`
  prefixes — VM steps 1972 → 1802) showcases it. Verification: the harness grew 322 → **343** — the new
  example auto-flows through the JS / WASM / GC-stress / disassembler / optimizer batteries (so DT ≡ naive
  on result + output + effects + never-increased steps across all three backends), plus a focused DT
  battery that fires on nested/shared-prefix/guarded/literal/tuple cases, cuts ≥ 80 steps on the showcase,
  exercises the join-point path, preserves `MATCH_FAIL` on a guard fall-through, and is *skipped* on flat
  matches; plus a 5-case in-app self-test group. Full CI gate (scope + conformance + lint + tsc + build)
  green.
- 2026-06-22 (claude): **Aether 14.0 — global value numbering: CSE across binders.** Aether's
  common-subexpression elimination (11.0) is *local* — `tryCse` only shares an expression among the
  children on a single node's binder-free strict frontier, so the same pure work recomputed on either
  side of a `let`, inside a `λ` body, or across a `match` survives. 14.0 closes the oldest deferred
  optimizer item ("CSE across a `let` … a dominator-based available-expressions pass") with a new
  top-down **global value numbering** pass in `optimize.ts`. For a node `N`, `tryHoist` scans the
  subtree (a `scopedChildren` walk tagging each child *guaranteed-evaluated?* per the `minCost`/frontier
  cost model and tracking the names bound inside `N`), records every pure, cost-≥ 3 expression whose
  free variables are all bound *above* `N` (so it is hoistable there) grouped by `canon`, and — when one
  is **guaranteed-evaluated ≥ 2 times** — hoists it into a single fresh `let gvn = e in N[every
  occurrence ↦ gvn]`, replacing the conditional occurrences (a `match`/`if` arm, a `λ` body) too as a
  free bonus. Three safety invariants, each guarded by the existing harness: only **effect-free,
  terminating** `e` is moved (`isPure`, so reordering it earlier is invisible in a strict language); the
  **≥ 2 guaranteed evaluations** mean the value would have been computed twice anyway, so VM steps can
  only fall (redundancy split across two `if`-arms, or one guaranteed plus one conditional evaluation,
  is *not* hoisted — that would speculate); and occurrences are gathered **by identity** with the
  inside-bound names, with a `$`-fresh binder, so nothing is captured or shadowed. Because it emits an
  ordinary `let`, the bytecode VM, the JavaScript backend and the WebAssembly backend compile it
  **unchanged**, and the byte-for-byte equivalence checks re-prove the answer never changed. Wired into
  `optimizeCore` as a phase between the first fixpoint and the decision-tree phase (re-running the
  fixpoint to clean up). The **Optimizer panel** gained the `gvn` rule and a "Global value numbering"
  section listing each shared expression and its site count (`gvnHoists`). Added a `gvn` gallery example
  — a kernel that recomputes a pure window `sq n + sq (n+1) + sq (n+2)` as the value of three different
  `let`s; GVN shares it once (1 rewrite, 3 sites) and the VM steps roughly **halve** (3197 → 1597),
  showcasing GVN cooperating with the 11.0 effect-&-totality analysis (`sq` is proven pure). Verification:
  the harness grew 354 → **367** — the new example auto-flows through the JS / WASM / GC-stress /
  disassembler / optimizer batteries (so GVN ≡ naive on result + output + effects + never-increased steps
  across all three backends), plus a focused GVN battery that fires on the cross-`let` cases, cuts real
  steps, shares the right number of sites, and — the safety half — declines to speculate across `if`-arms,
  declines when only one evaluation is guaranteed, and never moves an effect; plus a 3-case in-app
  self-test group. Full CI gate (scope + conformance + lint + tsc + build) green.
