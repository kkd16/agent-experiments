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
  (available-expressions CSE across binders, Aether 14.0), its dual **float-in** (sinking a pure binding
  past a conditional into the one branch that uses it, Aether 19.0), **dead-argument elimination**
  (dropping a parameter whose value never reaches the result, Aether 20.0), **case-of-case**
  (commuting a strict eliminator inward through an `if`/`match` producer so the intermediate value is never
  built, Aether 21.0), and **scalar replacement of aggregates** (devirtualizing a multi-use record's field
  projections to the field values — so a shared type-class dictionary's `d.disp x` becomes the direct call
  `show x` and the cell is dropped, Aether 24.0) — whose output every backend compiles.
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
- `src/lang/semantics.ts` — an in-process **language server**: a name-resolution walk over the typed
  AST that powers the editor's hovers, inlay hints, occurrence highlighting, go-to-definition,
  scope-aware completion and rename — re-reading inference, owning no type theory of its own.
- `src/lang/prelude.ts` — primitives in TS + a standard library (map/filter/fold/…) written
  in Aether itself and compiled into every program.
- `src/lang/turtle.ts` — folds VM draw effects into line segments for the canvas.
- UI: a 2-pane playground (an **IDE-grade editor** — hover types, inlay hints, completion,
  occurrence highlighting, go-to-definition and F2 rename — plus tabbed inspectors: Result, Canvas,
  Tokens, AST, Types, Bytecode, Debugger), plus Examples / Language / Internals pages.

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
- [x] **Equality saturation** — a from-scratch e-graph superoptimizer (no `egg`) for the
      integer-arithmetic islands: it applies every algebraic law (commutativity, associativity,
      factoring `u*x+u*y=u*(x+y)`, identities, cancellation) *non-destructively* until the graph
      saturates, then extracts the cheapest equivalent term — finding factorings (`a*2+a*3 ⟶ a*5`) a
      greedy pass can never reach. Each adopted rewrite is **differentially validated** by polynomial
      identity testing (Schwartz–Zippel) and gated to strictly-cheaper, so VM steps only fall
      (Aether 16.0)
- [x] **Call-site inlining of non-recursive functions** — lifts the inliner's single-use cap: a
      small, non-recursive function is copied into every *saturated call site* (deleting the call /
      closure overhead and exposing its body to const-folding) while partial applications and
      higher-order *escapes* keep one shared closure; monotone by construction, so the harness's
      "never increase VM steps" gate proves it is never worse (Aether 15.0)
- [x] **Static-argument transformation** (Santos 1995; Peyton Jones & Santos 1998) — a recursive
      function's *loop-invariant* parameter (the function arg of a recursive `map`, the limit of a
      counting loop) is lifted into a thin **wrapper** so the recursive **worker** loops on only the
      *dynamic* arguments, capturing the static ones as free variables. Each iteration passes one
      fewer argument (34–42 % fewer VM steps on the canonical loops). Because the wrapper is no longer
      recursive, a *known* function flowing into a lifted slot is then inlined and β-reduced into the
      loop — a SpecConstr-like specialisation reached by composition (`each (fn x -> x*x) xs` collapses
      to a bare first-order loop). Re-proved by the VM ≡ JS ≡ WASM checks (Aether 17.0)
- [x] **Short-cut fusion (deforestation)** — an algebraic rewrite system over the prelude combinators
      that *deletes the intermediate data structures* flowing between list passes: `map f (map g xs)` ⇒
      `map (f∘g) xs`, consumers (`foldr`/`foldl`/`sum`/`all`/`any`/`length`) pushed through a `map` or
      `filter`, `length (map g xs)` ⇒ `length xs`, `reverse (reverse xs)` ⇒ `xs`, `take n (map g xs)` ⇒
      `map g (take n xs)` — 14 laws (Wadler 1990; Gill–Launchbury–Peyton Jones 1993). Fires only on the
      *real* prelude combinator (scope-tracked) and only when the function whose call-timing changes is
      proven pure & total, so it never reorders an effect. A five-stage pipeline collapses to one
      `foldl` over the range; re-proved by VM ≡ JS ≡ WASM + a 400-program differential fuzz (Aether 18.0)
- [x] **Float-in (let-floating inward)** — sink a pure, non-value `let` binding past a conditional into
      the one branch that uses it, so the paths that don't take it skip the work entirely; the *dual* of
      GVN's hoist-to-share, gated so VM steps only fall, never moving an effect or capturing a binder
      (Peyton Jones, Partain & Santos, *Let-floating*, ICFP 1996; **Aether 19.0**)
- [x] **Dead-argument elimination** — drop a parameter whose value never reaches the result, either an
      *unused* parameter or a *useless accumulator* that only feeds its own recursive slot, from the
      function and every saturated call site; pure-argument-gated so it never loses an effect and VM steps
      only fall (**Aether 20.0**)
- [x] **Case-of-case (commuting conversions)** — push a strict eliminator (a `match` scrutinee, a
      `.field` projection, a `binop`/`unop` operand) inward through an `if`/`match` *producer* in its
      hole, so every branch meets the eliminator statically and the intermediate `Option`/record/boxed
      value is never built. Step-neutral by construction (the chosen branch runs either way), gated on
      *exposing a redex* (so it always buys a reduction and provably converges) and capture-avoiding;
      a 2000-program VM ≡ JS ≡ WASM differential fuzz proves it, with a companion *linear inliner* that
      inlines a single-use pure producer into its sole non-lambda use so the abstraction can't hide
      behind a `let` (Peyton Jones & Santos 1998; **Aether 21.0 / 21.1**)
- [x] Optimizer pass: constant folding, dead-branch elimination, short-circuit simplification
- [x] A full **optimizing middle-end** over the core (β/η, inlining, dead code, known-`match`,
      field projection) feeding all three backends — abstraction melts away (Aether 10.0)
- [x] Records with row polymorphism (`{ x = 1 }`, `r.x`, inferred `{ x: a | ρ } -> a`)
- [x] Functional record update (`{ r | x = 5 }`, type-safe, row-polymorphic)
- [x] A REPL mode that keeps top-level bindings between runs

### Aether 21.0 — case-of-case: pushing the eliminator past the producer (planned + shipped this session)

Every optimizer pass so far simplifies a value *once it is known*. But the most common reason abstraction
**fails** to melt is two pieces of control flow stuck back to back: a value is **produced** by an `if` or a
`match`, then immediately **consumed** by another eliminator. The producer's result is dynamic, so const-fold
and known-match both stall — and the intermediate `Option`, record or boxed value is built at runtime only to
be torn apart one step later. Before this session the optimizer left all of these completely untouched:

```
match (if c then Some x else None) with        (if c then { a = x } else { a = 0 }).a
  | None   -> 0
  | Some y -> y + 1
```

**Case-of-case** — the central *commuting conversion* of the Glasgow Haskell optimiser (Peyton Jones &
Santos, *A transformation-based optimiser for Haskell*, 1998) — unsticks them by pushing the consuming
eliminator **inward** into the producer's branches, so each branch meets the eliminator *statically*:

```
match (if c then Some x else None) with                if c then x + 1 else 0          (no Option built)
  | None -> 0 | Some y -> y + 1            ⇒
(if c then { a = x } else { a = 0 }).a                 if c then x else 0               (no record built)
(if c then 5 else 9) + 100                             if c then 105 else 109           (folded to consts)
```

Now the existing **known-match / field-projection / const-fold / algebra** rules fire on every branch, and the
constructor, record or boxed value is **never allocated**.

**The four frames and two producers.** A *frame* is a one-hole **strict** eliminator — Aether recognises four:
a `match` scrutinee, a `.field` projection, and a `binop` or `unop` operand. A *producer* is an `if` or a
`match`. When a frame's strict hole holds a producer, the frame is distributed over the producer's branches.

**Step-neutral by construction.** The frame is strict in its hole, so the producer's chosen branch is evaluated
either way and the eliminator still runs **exactly once** — the move alone never adds a VM step; only the
reductions it then unlocks remove them. So VM steps can only fall, the project's standing invariant.

**Two guards keep it principled.**
- **Exposure** — it fires only when ≥ 1 producer branch, placed in the hole, *immediately reduces* via the
  frame's own local rule (we literally trial-run `reduceMatch`/`reduceField`/`reduceBinop`/`reduceUnop`). So
  duplicating the eliminator into the branches always buys a reduction and never just bloats the core, and the
  rewrite **provably converges**: a reduced branch sheds its producer; a non-reduced one is left a plain
  eliminator whose hole is no longer a producer, so it can't re-fire.
- **Capture-avoidance & effects** — pushing a frame under a `match` arm that binds a variable the frame mentions
  would capture it, so any such arm binder is α-renamed fresh first (reusing the optimizer's `rename`/`subst`
  machinery — e.g. `Some y -> 2` becomes `Some y$opt_0 -> …` when the moved frame already mentions `y`). For a
  `binop` only the always-evaluated operand may host the producer (a short-circuit `&&`/`||` never moves work
  into its conditional right side) and the sibling operand must be a proven **value**, so no effect is ever
  duplicated or reordered.

**Aether 21.1 — linear inlining (the companion that stops the abstraction hiding behind a `let`).** β-reduction
leaves a passed-in conditional bound to a name: `f (if c then 5 else 9)` becomes `let z = if c then 5 else 9 in
z + 100`, and the `let` hides the producer from case-of-case. The value inliner only copies *values*, so it left
these. 21.1 inlines a **single-use, pure, non-value** binding into its sole occurrence — but **only when that
occurrence is not under a lambda** (an `occursUnderLambda` walk, shadow-aware), so the producer is evaluated at
most as often as the binding was, never more (a use under a `λ` would turn one evaluation into one-per-call). That
is exactly monotone, and it hands the now-exposed producer to case-of-case, which collapses `f (if c then 5 else
9)` all the way to `if c then 105 else 109`.

**Results.** The new `case-of-case` gallery example watches an `Option` and two records vanish from a function's
body, leaving plain arithmetic — VM steps **243 → 120**. Across a 2000-program differential fuzzer (random nested
`if`/`match`/projection/`binop` programs) **579 fire case-of-case**, every one agreeing across the VM, the
JavaScript backend and the WebAssembly backend with VM steps never rising. The Optimizer panel gains a
`case-of-case` rewrite row and a "Case-of-case — commuting conversions" section naming each eliminator it pushed
into which producer.

**Verification.** An 8-case in-app self-test group (match-into-`if`, match-into-`match`, projection-into-`if`,
binop-fold-into-`if`, capture-avoiding arm freshening, effect-runs-once, the two 21.1 linear-inline cases —
in-app suite 95 → **103**); the example auto-flowing through the VM ≡ JS ≡ WASM batteries; a 2000-program
case-of-case fuzz and a separate 600-program fuzz that specifically lands single-use producers *under lambdas* to
prove `occursUnderLambda` never lifts work into a loop (steps never increased in 2600 programs). That fuzzer is
also **institutionalised in the app** (`optFuzz.ts`): the Tests page now runs a deterministic 120-program
**optimizer differential-fuzz** group that re-proves, in the browser, opt-VM ≡ unopt-VM ≡ JS with VM steps never
rising on programs nobody wrote by hand (≈ 12 000 VM steps erased per batch, best single program 90 % fewer).
Full CI gate (scope + conformance + lint + tsc + build) green.

### Aether 20.0 — dead-argument elimination: dropping parameters that never reach the answer (planned + shipped this session)

The optimizer can now move work up (GVN) and down (float-in), and it can lift a *static* argument out of
a loop (SAT, 17.0) — but it had never asked the most basic question about a parameter: **does its value
matter at all?** Two shapes of parameter are pure overhead, and 20.0 strips both:

```
let rec go = fn audit -> fn tag -> fn n ->          let rec go = fn n ->
  if n == 0 then 0                              =>     if n == 0 then 0
  else n + go (audit + n * n) tag (n - 1) in          else n + go (n - 1) in
go 0 "trace" 60                                     go 60
```

- **An unused parameter** — `tag` here never appears in the body; it is passed through every call and
  read by none. (The 15.0 call-site inliner already deletes these for a *small, non-recursive* helper by
  copying it and letting dead-binding elimination drop the now-unused argument — but it cannot touch a
  recursive loop, and that is exactly where a threaded-through parameter hides.)
- **A useless accumulator** — `audit` is referenced, but *only* inside the argument `go` hands to its own
  `audit` slot. Its value is a pure dataflow dead-end: every iteration recomputes `audit + n * n` purely
  to feed the next iteration's copy of itself, and it never reaches the result. So the whole running
  multiply-add is dead, hundreds of iterations of arithmetic done for nothing.

**Detection.** Both shapes collapse to one test. The pass fires on a single self-recursive (or plain)
`let` binding whose every free occurrence is a **saturated call** (an escape or partial application would
observe the arity, so it declines — the same eligibility gate SAT uses). For each parameter `p_i` it
strips every self-call's slot-`i` argument out of the body (replacing it with `()`) and asks whether
`p_i` still occurs: if not, `p_i` was either wholly unused or only ever fed its own recursive position,
so its value cannot affect the answer. It drops the **first** such parameter and re-runs the fixpoint, so
a function with several dead parameters is cleaned one per round (the `go 5 5 10` test drops both `a` and
`b`).

**Soundness & the never-increase-steps invariant.** A dropped parameter is gone from the lambda and from
every saturated call site (self-calls *and* the outer entry calls). The only risk is losing the
*evaluation* of a dropped argument, so the pass drops `p_i` only when **every** argument ever passed in
slot `i` is **pure** — then not evaluating it is invisible in a strict language, no effect is lost, and
the skipped work means VM steps can only fall (the `go (print n; dead) …` test keeps the parameter,
because the argument prints). It emits ordinary core, so the VM, JS and WASM backends compile the
shrunken function unchanged and the equivalence checks re-prove the answer never changed.

**Results.** The `dead-arg` gallery example drops both threaded values and the per-iteration multiply-add,
cutting VM steps on the canonical loops by **40–58 %** (`go 0 200`: 3080 → 1834; the two-dead loop: 294 →
124). The Optimizer panel gains a `dead-param` rewrite row and a "Dead-argument elimination" section
naming each function and the parameters it shed. Verification: a 6-case in-app self-test group (useless
accumulator, unused recursive parameter, two-dead one-per-round, a kept live accumulator, a kept effectful
argument, the gallery — in-app suite 89 → **95**), the example auto-flowing through the VM ≡ JS ≡ WASM
batteries, and the differential harness (now **129 programs**, opt vs. naive across all three backends:
result + output identical, VM steps never increased). Full CI gate (scope + conformance + lint + tsc +
build) green.

### Aether 19.0 — float-in: let-floating inward, the dual of GVN (planned + shipped this session)

Aether's optimizer has spent five versions learning to move work **up**: common-subexpression
elimination (11.0) and global value numbering (14.0) both hoist a pure expression to a dominating
binder so the ≥ 2 evaluations below it share one computation. But the opposite move — pushing work
**down** — was missing, and it leaves a whole class of waste on the table. Consider a pure cost that is
bound once but used only on a rare path:

```
let audit = total ledger + total ledger in   -- an expensive, pure fold
let n     = size ledger in
match dispatch with
  | Peek  -> n            -- the common path: never looks at `audit`
  | Audit -> audit        -- the rare path: the only use
```

Aether is a **strict** language, so a top-level `let` is *always* evaluated: every `Peek` pays in full
for a fold it never reads. None of the existing passes help — `audit` is *used*, so dead-binding
elimination keeps it; it is computed once, so CSE/GVN have nothing to share; the dispatch is a recursive
call the optimizer cannot fold, so `if`-folding and known-match cannot collapse it. The fix is the
classic **let-floating** transformation (Peyton Jones, Partain & Santos, *Let-floating: moving bindings
to give faster programs*, ICFP 1996): **sink** a binding to the smallest subexpression that dominates
all of its uses. When that subexpression sits behind a conditional, every run that takes the *other*
branch skips the work entirely:

```
match dispatch with
  | Peek  -> n
  | Audit -> let audit = total ledger + total ledger in audit   -- evaluated only here
```

**The dual of GVN.** GVN floats a pure expression *up* to share it across guaranteed evaluations (steps
fall: no recomputation). Float-in floats a pure binding *down* into the one branch that uses it (steps
fall: no speculation). Together they place each pure `let` at exactly the scope its uses demand: no
higher (which would speculate), no lower (which, past a `λ`, would recompute). The two are deliberately
complementary — GVN's win is sharing, float-in's win is skipping.

**How it works.** A new `reduceLet` rule fires on a non-recursive `let x = e in body` whose value `e` is
**pure** (effect-free and terminating, via the 11.0/13.0 effect-&-totality analysis) and is *not* a
syntactic value (atoms and lambdas are copied or dropped by the existing inliners, never sunk). It calls
`sinkBinding`, which walks `body` through the scope-tracked child enumeration (`scopedChildren`, the same
machine GVN uses) following the chain of positions where `x` is the *sole* user, and re-binds `x` around
the deepest such position. It emits ordinary core, so the bytecode VM, the JavaScript backend and the
WebAssembly backend all compile the result unchanged, and the byte-for-byte equivalence checks re-prove
the answer never moved.

**Soundness & the never-increase-steps invariant** (all conservative, all reusing proven machinery):

- only a **pure** binding moves — in a strict language, delaying or skipping a computation that has no
  observable effect and is known to terminate is *invisible*: no effect is lost, no divergence introduced
  (the `(print "x"; 5)` case stays put, proving effects are never moved);
- the binding is sunk only through positions evaluated **at most once** per evaluation of the host
  (`if`/`match` arms & guards, `&&`/`||` right operands, `let`/`seq` sub-positions — every child
  `scopedChildren` exposes), and **never** inside a `λ` body, whose work would multiply by the call count;
- it is sunk only to a child that is the binder's **sole** user, so the value is never duplicated and
  stays evaluated ≤ once on any path;
- it is committed only when the sink path **crosses a conditional** (lands somewhere `scopedChildren`
  flags as not-guaranteed), so every float-in is a strict potential win and the pass never churns the
  AST for a neutral move that GVN would just undo;
- **capture is impossible**: a descent step into a position that binds a free variable of the moved value
  (a `λ` param or `match` pattern var) — or that re-binds `x` itself — ends the descent before that
  binder is crossed (the `match bx with Box b -> … h …` case, where `h`'s free `b` would be captured, is
  correctly declined).

So `steps(optimized) ≤ steps(unoptimized)` holds by construction, with equality only when the sink target
is reached on every path.

**Results.** The new `float-in` gallery example — a pure 800-element fold bound at the top but used only
on the rare `Audit` arm — drops **VM steps 60 883 → 25 645 (−58 %)** as the common `Peek` path stops
paying for the fold, identical on all three backends. The Optimizer panel gains a `float-in` rewrite row
and a **"Float-in"** section naming each binding sunk and the branch it landed in (flip *show before* to
watch `audit` move down into the `Audit` arm). Verification: a 7-case in-app self-test group (sinks into
an `if` branch / a `match` arm / the right of `&&`; declines when used in both branches; never moves an
effect; never captures a pattern variable; the gallery dispatch), plus the example auto-flowing through
the VM ≡ JS ≡ WASM batteries, plus a dev-time **differential harness** (122 programs run optimized vs.
naive across all three backends, asserting result + output identical and VM steps never increased — float-in
alone lifts the suite-wide step saving from 519 k to 565 k). Full CI gate (scope + conformance + lint +
tsc + build) green.

### Aether 18.0 — short-cut fusion: deleting the intermediate data structures (planned + shipped this session)

Every optimizer pass Aether has shipped — const-fold, β/η, inlining, CSE, GVN, equality saturation,
the static-argument transformation — simplifies **code**. Not one of them touches the thing a list
pipeline wastes the most: **data**. Write the most natural form of a computation,

```
sum (map (fn x -> x * x) (filter (fn x -> x > 10) (map (fn y -> y + 1) (range 1 30))))
```

and the naïve compilation allocates *four* throwaway lists — `range`'s, `map`'s, `filter`'s, the second
`map`'s — each one built cons-cell by cons-cell, walked exactly once by the next stage, and handed
straight to the garbage collector. The pipeline reads beautifully and runs like molasses. 18.0 adds the
classic cure: **short-cut fusion**, a.k.a. **deforestation** (Wadler, *Deforestation: transforming
programs to eliminate trees*, 1990; Gill, Launchbury & Peyton Jones, *A short cut to deforestation*,
1993) — implemented from scratch in `src/lang/fusion.ts` as an algebraic rewrite system over the
prelude combinators (GHC's `{-# RULES #-}` in miniature), and run as the optimizer's **Phase 0**.

**What it does.** A fusion law rewrites a *consumer applied to a producer* into a single pass that never
materialises the list in between. The 14 laws:

```
map f (map g xs)            ⇒  map (fn z -> f (g z)) xs          -- one traversal, no list between
filter p (filter q xs)      ⇒  filter (fn z -> q z && p z) xs
foldr k z (map g xs)        ⇒  foldr (fn x a -> k (g x) a) z xs
foldl k z (map g xs)        ⇒  foldl (fn a x -> k a (g x)) z xs
foldr k z (filter p xs)     ⇒  foldr (fn x a -> if p x then k x a else a) z xs
foldl k z (filter p xs)     ⇒  foldl (fn a x -> if p x then k a x else a) z xs
sum (map g xs)              ⇒  foldl (fn a x -> a + g x) 0 xs    -- never builds the mapped list
sum (filter p xs)           ⇒  foldl (fn a x -> if p x then a + x else a) 0 xs
all p (map g xs)            ⇒  all (fn z -> p (g z)) xs          -- (and any/map)
length (map g xs)           ⇒  length xs                         -- the entire map is dead
length (reverse xs)         ⇒  length xs
reverse (reverse xs)        ⇒  xs                                -- two traversals vanish
take n (map g xs)           ⇒  map g (take n xs)                 -- map only the n you keep
```

Run **bottom-up to a fixpoint**, the laws compose: the five-stage pipeline above collapses, law by law,
into a **single `foldl` over the range** with *zero* intermediate lists — a **68 % VM-step cut** on the
gallery example, identical on all three backends. A `map` chain three deep fuses to one composed pass; a
naïvely-quadratic `length (map …)` drops the map outright.

**Soundness — two guards, both load-bearing.**

- *Identity.* A law must fire on the **real** prelude combinator, never a user binding that happens to
  share the name. A use of `map` is "the prelude `map`" iff the binding in scope is structurally the
  canonical prelude definition (or the name is free — i.e. the prelude global, in the per-user-portion
  run the JS/WASM backends compile). A `let map = fn f xs -> []` shadows it and fusion declines — tracked
  with a scope environment threaded through the walk. (A test rebinds `map` to a different function and
  asserts nothing fuses and the answer is the shadowed one.)
- *Effects.* Aether is strict and **effectful** (`print`, the turtle), so the order and count of effects
  is observable. A law moves work across the boundary between two passes — interleaving what was batched,
  or dropping elements that were forced. Each law is therefore gated on **the function whose call-timing
  it changes** being proven **pure and total** by the optimizer's own effect-&-totality analysis (the
  same one that powers CSE): a pure-total function may be called fewer times, in a different order, or
  not at all with no observable difference — no effect to reorder, no exception to hoist, no divergence to
  skip. The *consumer's* own function (a fold's `k`, the downstream predicate) keeps its exact call
  sequence and is never gated. The purity oracle is even made transparent to the β-redexes fusion itself
  introduces, so a chain of lambda-maps fuses all the way down. (A test maps a *printing* function inside
  another `map` and asserts the law declines and the output is byte-identical to the unoptimized run.)

**Why it can never pessimise.** Each law deletes at least one full traversal plus the cons cells it
built, while the consumer's own work is unchanged — so VM steps strictly fall. Like every other pass it
emits **ordinary core** (the same combinators plus fresh composed lambdas the fixpoint then β-reduces),
so the bytecode VM, the JavaScript backend and the WebAssembly backend all compile it unchanged.

**Verification.** As with every pass, correctness is not argued — it is *re-proved on every example* by
the byte-for-byte VM ≡ JS ≡ WASM equivalence checks, and the harness's never-increase-VM-steps gate
proves it never made one slower. 25 targeted `checkOpt` cases assert each law fires with the exact rule
name, cuts real steps, and preserves result + output + effect count; three soundness cases prove it
*declines* on an effectful inner map, on a shadowed combinator, and where no sound law exists
(`length (filter …)`). A new **400-program differential fuzz** builds random pipelines (a `range`, a
random stack of map/filter stages — a quarter with an effectful map mixed in — and a random consumer) and
asserts on every one: fused ≡ unfused value, fused ≡ unfused output, equal effect count, and fused steps
≤ unfused. Full CI gate (scope + conformance + lint + tsc + build) green; the in-app suite and headless
harness are **451/451**. The Optimizer panel gains a **"Short-cut fusion"** section naming each law that
fired and how many times; the gallery's **Short-cut fusion** example fuses a five-combinator pipeline
into a single traversal.

### Aether 17.0 — the static-argument transformation: turning loops first-order (planned + shipped this session)

Every loop Aether compiles has been paying a tax we never named. Look at the hand-written recursive
`map` everyone writes:

```
let rec map = fn f -> fn xs ->
  match xs with [] -> [] | x :: t -> f x :: map f t
```

`f` never moves. Every single recursive call passes it straight back through — and the VM dutifully
re-binds it and re-pushes it on every iteration, forever, for a value that is the same on the first
element and the millionth. The argument is **static**; threading it round the loop is pure overhead.
17.0 adds the classic fix — the **static-argument transformation** (Santos, 1995; Peyton Jones &
Santos, *A transformation-based optimiser for Haskell*, 1998) — implemented from scratch in
`src/lang/optimize.ts` as a new core-to-core pass that the bytecode VM, the JavaScript backend and the
WebAssembly backend all run unchanged.

**What it does.** SAT splits a self-recursive function into two pieces:

```
let map = fn f -> fn xs ->                  -- wrapper: binds the static `f` ONCE
  let rec go = fn xs ->                      -- worker: recurses on the dynamic `xs` only
    match xs with [] -> [] | x :: t -> f x :: go t   -- `f` is now a captured FREE variable
  in go xs
```

The recursive *worker* `go` loops on only the dynamic argument; the static `f` is captured by the
enclosing wrapper closure, so each iteration passes one fewer argument. On the canonical loops (a
recursive `map`, a counting accumulator, a `foldl`) this is a measured **34–42 % drop in VM steps**,
identical on all three backends.

**The real prize — specialisation for free.** Because the wrapper is no longer recursive, it is now a
legal target for the Aether 15.0 call-site inliner. So when a *known* function flows into a lifted
slot, the passes compose into something much bigger than either alone:

```
each (fn x -> x * x) [1, 2, 3]
  -- SAT lifts `g` out of `each`;  the wrapper inlines at the call site;
  -- the literal lambda `fn x -> x*x` lands on the captured `g`;  `g x` β-reduces:
  ⟶  let rec go = fn xs -> match xs with [] -> 0 | x :: t -> (x * x) + go t in go [1,2,3]
```

`g` has vanished entirely — the higher-order loop has been **specialised into a first-order one** with
zero closure overhead. That is the effect the SpecConstr pass (Peyton Jones, ICFP 2007) is famous for,
reached here purely by composition of two simpler transformations. The optimized-core view shows it
directly: flip "show before" and watch `each` grow a wrapper, then collapse.

**Soundness (all conservative, and re-proved mechanically).** SAT fires on `let rec f = fn p0 … p_{k-1}
-> body` only when:

- `f` is genuinely self-recursive in `body`;
- **every** free occurrence of `f` in `body` is a *saturated* call (a spine of ≥ k arguments) — a bare
  or partially-applied `f` would escape, so the pass simply declines (the `map f` handed to a
  higher-order combinator, and any `apptwice g`-style escape, are left exactly as written);
- a position counts as *static* only if every recursive call passes precisely `var p_i` there **and**
  `p_i` is not shadowed at that call site (an inner `let a = a + 1` rebinding defeats staticness — a
  case in the test suite);
- at least one static **and** one dynamic parameter remain, so the worker is always a real loop on a
  varying argument (this is also the firing gate that keeps SAT from pessimising a never-recursing
  function — there is nothing to lift past if nothing varies).

The dynamic parameters are α-renamed to fresh names inside the worker so they never collide with the
wrapper's identically-named binders, and the whole rewrite is built on the optimizer's existing
capture-avoiding `rename`/`subst`/scoped-traversal machinery. As with every other pass, correctness is
not argued — it is **re-proved on every example** by the byte-for-byte VM ≡ JS ≡ WASM equivalence
checks; six new self-tests cover the canonical loops, the SpecConstr-style specialisation, multi-static
folds, the shadowing counter-case, an escaping recursive function (left untransformed), and guards in
the worker body. Full CI gate (scope + conformance + lint + tsc + build) green; the in-app suite is
**74/74**. The `tools/harness.mjs` semantic harness grew an 8-case SAT battery (SAT fires with the
*exact* static/dynamic split, cuts real steps, reaches the SpecConstr specialisation, and declines on
escapes / rebound parameters / non-recursive functions) plus a **differential fuzz** — 400 randomly
generated, well-typed-by-construction recursive integer loops with a random static/dynamic split per
parameter, each checked for identical optimized-vs-unoptimized value, never-increased VM steps, and a
classifier verdict matching how the program was actually built: **417 harness checks, all green, 0
mismatches.**

The Optimizer panel gains a **"Static-argument transformation"** section listing each function, the
parameter(s) it lifted, and the dynamic ones the worker still threads; the rewrite table counts `sat`.

### Aether 16.0 — equality saturation: an e-graph superoptimizer (planned + shipping this session)

Every middle-end pass Aether has shipped — const-fold, β/η, inlining, CSE, GVN — is **greedy**: it
walks the tree and commits to one rewrite per node. That is how every bottom-up simplifier works, and
it is also its blind spot. A greedy pass picks a *first* move and can never get back: it can simplify
`(x + 3) + 4` to `x + 7` only if it happens to reassociate the right way first, and it can **never**
factor `a*2 + a*3` into `a*5`, because seeing that rewrite means looking at the whole expression at
once, not one node at a time. 16.0 adds the technique that removes the choice: **equality saturation**
over an **e-graph**, implemented from scratch (no `egg`, no libraries) in `src/lang/egraph.ts`.

Instead of rewriting *destructively*, the pass grows an **e-graph** — a set of equivalence classes
("e-classes") of e-nodes — and applies every rewrite *non-destructively*, recording both the old and
the new form in the same class. Rules keep firing until the graph stops growing (it **saturates**), at
which point one e-class compactly represents an astronomically large set of equivalent programs; a
bottom-up, cost-driven **extraction** then pulls out the single cheapest program in the whole class at
once. The greedy ordering problem disappears — all rewrite orders are explored simultaneously.

**The domain — the integer-arithmetic island.** Equality saturation runs where it is both most
valuable and unconditionally an *integer identity*: maximal trees of `+`, `-`, `*` and unary negation.
Aether's type system guarantees (see `inferBinop`) that every operand of these is `Int`, so such a
tree is a polynomial in its leaves over ℤ. `/` and `%` are deliberately left out (they trap on a zero
divisor and truncate — neither total nor associative), and any non-arithmetic subterm becomes an
opaque **leaf**. A leaf may be shared, dropped (`a*0 → 0`), duplicated or reordered, so it is admitted
as a polynomial variable only when the optimizer's existing `isPure` oracle proves it **effect-free
and total** — an island holding a possibly-diverging or printing subterm is left untouched.

**The engine.** A union-find e-graph with a congruence-restoring `rebuild`; **commutativity is free**
(the hash-cons key sorts a `+`/`*`'s operands, so `a+b` and `b+a` are *the same e-node*); the rule set
then carries associativity, the factoring law `u*x + u*y = u*(x+y)`, the identities (`x+0`, `x*1`,
`x*0`, `x-0`), `x+x = 2*x`, double-negation and `neg`-pushing, and cancellation `x + neg x = 0`. The
distribution rule (the expanding direction) was tried and **dropped** — it never yields a cheaper form
and is the one rule that lets an island balloon — leaving only the contracting `factor`. Extraction is
a cost fixpoint (`×` dearer than `+`, every leaf *occurrence* counted so a duplicating rewrite can
never pay for itself) that picks the min-cost e-node per class and rebuilds an `Expr`, preferring
`x - y` to `x + (neg y)`.

**Soundness — polynomial identity testing (Schwartz–Zippel).** Each island is a multivariate
polynomial in ℤ[leaves]; two are equal as functions on ℤ iff equal as polynomials, and a Schwartz–
Zippel argument says two *distinct* low-degree polynomials agree on only a vanishing fraction of random
points. So before any extracted form is adopted it is **differentially validated**: the leaves are
assigned dozens of random integers (bounded so the island's own evaluation stays exact in 64-bit
floats) and original vs candidate are evaluated — a single disagreement vetoes the rewrite. This
certifies a genuine **integer identity**. Aether's `Int` is a double, exact within ±2^53, so within
that range — every realistic program — the rewrite is bit-for-bit unchanged on the VM; beyond it,
reassociating a product can re-round, exactly the overflow-free assumption GCC/LLVM make when *they*
reassociate signed-integer arithmetic. (A 4000-program differential fuzz confirmed this precisely:
zero divergences for in-range programs, and the only divergences were synthetic folds whose
intermediate products deliberately exceeded 2^53.) The cost gate only ever adopts a *strictly cheaper*
form, so — like every other pass — VM steps can only fall.

Plan / steps:

- [x] **`egraph.ts` — the e-graph** (union-find + hash-cons with free commutativity, a fixpoint
      `rebuild` restoring congruence), the island finder (top-down, rooting only at a `+ - *` binop so
      a unary `-` underneath is provably `Int`), the builder (normalising `a - b` to `a + neg b`), the
      rule engine, and budgets (`maxIters`, `maxNodes`, plus an in-sweep guard so a single pass can
      never balloon unboundedly).
- [x] **Cost-driven extraction** — a min-cost fixpoint over the saturated graph and a rebuilder back
      to core `Expr`, with the strictly-cheaper adoption gate (never worse by construction).
- [x] **Schwartz–Zippel differential validation** — evaluate the *original* island (leaves by unparse
      index) against the *extracted choice* (leaves by e-node index, straight on the graph) over fixed
      corner points + random integers; adopt only on unanimous agreement.
- [x] **Integration** (`optimize.ts`) — a Phase 4 stage after the greedy fixpoint + decision-tree
      cleanup, reusing the module's `isPure` so proven-pure leaves (incl. total recursive calls) are
      treated as polynomial variables; `eqsat` added to `OptimizeStats`, an `eqsat` rewrite row to the
      pass table.
- [x] **The Eq-Sat panel** (`EqSatPanel.tsx` + a new tab) — names each improved island, its
      before/after cost, the validation verdict + point count, the e-class/e-node/iteration counts and
      whether it saturated, a one-click VM-step measurement, and **draws the saturated e-graph itself**
      (e-classes as boxes of e-nodes referencing other classes, the extracted term and root
      highlighted).
- [x] **An `eqsat` gallery example** + a **6-case in-app self-test group** (factoring, reassociation,
      cancellation, three-term common factor, annihilation, and factoring inside a recursive body) —
      each row's value re-proves the superoptimized form computes the right answer and the JS backend
      agrees on it.
- [x] **Docs** — About ("How it works") card #16, this journal section, the backlog checkbox.
- [x] **Verification** — all 38 gallery examples agree optimizer on/off; the in-app suite grew
      62 → **68** cases (all pass, 0 JS-mismatches) and 12 property self-tests still pass; an in-range
      differential fuzz of 1500 random arithmetic programs fired eqsat on 513 of them with **zero
      mismatches and 26% fewer VM steps overall**. Full CI gate (scope + conformance + lint + tsc +
      build) green.

### Aether 15.0 — call-site inlining: the inliner grows up (planned + shipping this session)

Aether's optimizing middle-end has, since 10.0, inlined a `let`-bound function — but only when its
binding is used **exactly once**. That cap is the safe, blunt rule that guarantees code can never blow
up: copy a body that is referenced twice and you risk doubling it at every level. The cost is that the
single most common shape in real functional code — a small helper (`sq`, `lerp`, `dist`, a projection)
called from several places, or from inside a loop — is never inlined, so every call keeps paying the
closure-application + frame-push + return overhead, and the body never gets to fold against the
literals at the site. 15.0 lifts the cap the way a real compiler does: **size-bounded, call-site
inlining of non-recursive functions.**

The pass, in `reduceLet`, fires on a non-recursive `let f = λ… in body` when `f` is used more than
once, its body is at most `INLINE_SIZE_LIMIT` core nodes, and it is *not* match-bodied (those are left
for the decision-tree pass, 12.0, to own and share). It then copies `f` into each **saturated call
site** — an application spine `f e₁ … eₖ` of at least `f`'s arity — while every *other* occurrence (a
partial application like `add 1`, or an *escape* where `f` is handed to a higher-order function as a
value) keeps referring to a single retained closure. The three-step rewrite reuses the module's
already-proven machinery rather than hand-rolling capture avoidance:

1. **`markHeads`** rewrites each saturated call-spine head `f` to a globally fresh placeholder
   `inl$…`, leaving every non-head occurrence of `f` in place and stopping at any binder that
   re-binds `f` (so an inner shadow is never touched);
2. **`rename`** redirects the surviving (escape / partial) `f` occurrences to a fresh `alt`; and
3. **`subst`** replaces the placeholders with the lambda — and because `subst` already freshens any
   binder on the path that would capture one of the lambda's free variables, the inlined copies
   denote *exactly* what the call denoted (the harness's `inline avoids variable capture` case —
   `let n=100 in let f = fn x -> x+n in let n=999 in f 1` — proves the definition-site `n` wins).

If an escape survives, the lambda is re-bound to `alt` (one closure for all the escapes); if not, the
function is **fully inlined and no closure is ever built**. The placeholder-then-`subst` detour also
means the existing β-reduction (`(λx.b) a ⇒ let x = a in b`) and const-folding finish the job for
free: `sq 3 + sq 4 + sq 12` inlines to three immediately-applied lambdas, β-reduces to lets, folds to
`9 + 16 + 144`, and collapses to the literal `169` — `sq` vanishes entirely.

**The load-bearing property is monotonicity.** Every other middle-end win Aether ships is gated to
*provably* never raise the VM step count (CSE/GVN require ≥ 2 *guaranteed* evaluations; DCE only drops
*pure* work), and the harness enforces `steps(optimized) ≤ steps(unoptimized)` on every gallery
example and every targeted case. Call-site inlining keeps that contract by construction: an inlined
call (`let x = a in B`) executes strictly fewer instructions than the real call it replaces (no frame
push/pop, no closure application), the body `B` runs the *same number of times* either way (so no work
is duplicated at runtime — only source text is), and a copy that lands on a branch never taken costs
nothing. The one closure that *was* built for `f` is either still built once (an escape remains) or
never built at all (fully inlined), so even the allocation count only falls. Two design choices keep
the pass from fighting its neighbours: match-bodied functions are skipped (the decision-tree pass
compiles a `match` once and shares its arms via join-points — inlining would re-duplicate them), and
the inliner is switched **off** during the post-decision-tree cleanup fixpoint (that phase is reserved
for copy-propagating the tree's own bindings).

Because it emits ordinary core, the bytecode VM, the JavaScript backend and the WebAssembly backend
all compile the inlined program unchanged, and the byte-for-byte equivalence checks re-prove the
answer never changed. The **Optimizer panel** gained an "inline-fn" rewrite row and a "Call-site
inlining" section naming each inlined function, its call-site count, its body size, and whether an
escape closure was kept. A new `inline` gallery example showcases it: a numeric kernel whose helpers
fold away and whose hot loop sheds a call per iteration cuts VM steps **3727 → 2039 (−45%)**.
Verification: the harness grew 367 → **386** — the new example auto-flows through the JS / WASM /
GC-stress / disassembler / optimizer batteries (so inlined ≡ naive on result + output + effects +
never-increased steps across all three backends), plus a focused inlining battery (fires on the
multi-use cases, cuts real steps, keeps an escape binding when the function also escapes, avoids
capture, respects the size budget, and declines on recursive / match-bodied functions), plus a 5-case
in-app self-test group. Full CI gate (scope + conformance + lint + tsc + build) green.

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

- [x] **Multi-use dictionary specialization** — **shipped in Aether 24.0** as *scalar replacement of
      aggregates* (record-field SROA). A multi-use `let`-bound record (the exact shape a dictionary
      takes after elaboration) is a value but not an atom, so the inliner declines it and its `r.field`
      projections stay live; SROA rewrites each projection to the field's *value* directly and drops the
      cell once it is dead, so `d.disp x` devirtualizes to the direct call `show x` even across many
      shared call sites — the "duplicate-then-collapse" the deferred note wanted, done without
      duplicating (atoms substitute freely; a function field only moves, never multiplies). See
      Aether 24.0 below.
- [ ] **Inlining across `let`-bound non-values** when a single use is in strict, effect-free position
      (today only syntactic values are inlined), and **common-subexpression elimination**.
- [ ] **Type-directed optimization** — the optimizer is untyped; feeding inferred types in would
      enable e.g. specialising `show`/`compare` to a known monomorphic type, or unboxing.
- [ ] **A worst-case-cost / fuel view** in the panel, and per-pass before/after diffs.

Deferred (future, building on Aether 15.0 call-site inlining):

- [ ] **Recursion-aware inlining (one unrolling)** — the inliner skips recursive functions outright.
      A single controlled unroll of a self-recursive loop (peel one iteration into the call site, like
      GHC's loopification) would expose the first step to const-folding while staying terminating; gate
      it on the body fitting the size budget so it cannot blow up.
- [x] **Static argument transformation** (Santos / GHC's SAT) — **shipped in Aether 17.0.** A
      recursive function that threads a parameter *unchanged* through every self-call (the classic
      `fold`/`map`/`loop` function argument) is split into a thin **wrapper** that binds the static
      parameters once and a recursive **worker** that loops on only the *dynamic* ones, capturing the
      static ones as free variables — shedding one application per iteration (34–42 % fewer VM steps on
      the canonical loops). The firing gate the deferred note worried about turned out to be the
      *structure* itself: SAT only fires when there is ≥ 1 static **and** ≥ 1 dynamic parameter, so the
      worker is always a genuine loop on a varying argument; and it composes with the 15.0 inliner to
      reach SpecConstr-like specialisation for free (see Aether 17.0 below).
- [x] **Call-pattern specialisation** (Peyton Jones, *SpecConstr*, ICFP 2007) — **shipped in Aether
      23.0.** A recursive function that is repeatedly called with the *same constructor / tuple shape*
      in one argument slot — and destructures it with its own `match` — is specialised to recurse on
      that shape's *fields* directly, so the per-iteration box + projection both vanish (12–41 % fewer
      VM steps on the canonical shape-threaded loops). It reuses the known-constructor `match` reduction
      to finish the job and composes downstream of the 17.0 worker form (see Aether 23.0 below).
- [x] **Worker/wrapper for single-constructor arguments** — **shipped in Aether 23.0** as the
      tuple/single-constructor case of SpecConstr: a loop that immediately destructures a tuple/ADT
      argument (`fn p -> match p with (a, b) -> …`) recurses on the unpacked fields, and the rebuilt
      cell — single-use by the firing gate — inlines onto the `match` so the box never exists. The
      general non-immediately-driven case (keeping a re-boxing wrapper for unknown callers) is the
      multi-pattern follow-up below.
- [ ] **An inlining-budget / cost view in the Optimizer panel** — show, per candidate function, its
      body cost, its call-site count, and the size delta inlining would cost, so the size-budget
      decision is visible (a first cut of the long-deferred "worst-case-cost / fuel view").
- [x] **Dead-parameter elimination** — **shipped in Aether 20.0**, and generalised past the original
      note: it drops not only a parameter *never used in the body* but also a *useless accumulator* whose
      only uses feed its own recursive slot (a pure dataflow dead-end), from the lambda and every
      saturated call site; pure-argument-gated so VM steps only fall.

Deferred (future, building on Aether 17.0 static-argument transformation):

- [ ] **SAT for mutually-recursive groups (`let rec … and …`)** — the current pass handles a single
      self-recursive binding; extend the static/dynamic classification across a whole `letrec` SCC so a
      parameter passed unchanged through *every* call in the group (to itself and its siblings) is
      lifted into one shared wrapper enclosing the group's worker loop.
- [x] **Proper SpecConstr (call-pattern specialisation, Peyton Jones ICFP 2007)** — **shipped in Aether
      23.0** for the immediately-driven, single-call-pattern case: a worker whose dynamic argument is
      always the same tuple/constructor shape is specialised to recurse on its unpacked fields, the box
      never built and the scrutiny never run. The multi-pattern / per-constructor generalisation and a
      re-boxing wrapper for unknown callers are the follow-ups below.

Deferred (future, building on Aether 23.0 SpecConstr):

- [ ] **Multi-pattern SpecConstr (one worker per constructor)** — today the pass fires only when *one*
      shape flows through the slot. Generalise to a slot carrying several constructors of a sum type
      (`Leaf`/`Node`, `Nil`/`Cons`) by emitting a `letrec` of mutually-recursive specialised workers —
      one per call pattern seen at the recursive sites — and routing each recursive call to the worker
      for the shape it builds, falling back to a generic copy only for shapes never built in the loop.
- [ ] **Re-boxing wrapper for non-immediately-driven loops** — drop the "the `in`-body is a single
      saturated self-call" restriction by keeping the original `f` as a thin wrapper that boxes the seed
      and tail-calls the specialised worker, so a loop called from several sites, or whose seed is an
      opaque variable, still specialises. Needs the wrapper proven cheap enough not to pessimise a
      called-once loop (the SAT cost-model gate applies here too).
- [ ] **Specialise on a *partial* shape (known head, opaque fields)** — a slot always called with
      `Cons _ _` but with varying head/tail still pays the constructor tag test every iteration; strip
      just the tag (recurse on the fields, keep them boxed) when the fields themselves are not uniform,
      a lighter specialisation than the full unpack.
- [ ] **SpecConstr across the decision-tree lowering** — the 12.0 decision-tree pass may already have
      turned `match st with (a,b) -> …` into single-column switches by the time SpecConstr looks; teach
      `scSoleDestructure` to see through a decision-tree/join-point scrutiny so the two passes compose in
      either order rather than SpecConstr having to run first.
- [ ] **Lift the single-use restriction with a sharing let** — when the threaded value is used more than
      once (e.g. matched *and* returned whole in the base case), still specialise but bind the rebuilt
      cell once at the worker head and let GVN share it, trading one retained box for the deleted
      per-iteration scrutiny; gate on the retained box costing less than the scrutiny it removes.
- [ ] **Nested-shape unpacking in one pass** — a slot of shape `(a, (b, c))` is unpacked one level per
      fixpoint round today (outer tuple first, then the inner on the next round). Detect a fully-static
      nested shape and unpack all levels at once, so a record-of-tuples accumulator flattens to scalars
      in a single rewrite.
- [ ] **Measured step-delta + a "specialised on" badge in the Optimizer core view** — record the actual
      VM-step delta each SpecConstr produced (per-iteration alloc + projection × entry count) and render
      the unpacked fields inline on the optimized core, the same way the deferred SAT "wrapper/worker
      badge" wants to, so the box that vanished is legible at a glance.
- [ ] **Constructor-argument *strictness*-aware unpacking** — once a demand/strictness analysis exists,
      only unpack a field the worker actually forces; an unforced field threaded through the loop can stay
      boxed (or be dropped by dead-argument elimination), avoiding speculative field evaluation.
- [ ] **SpecConstr ⇄ fusion bridge** — a `foldl`/`foldr` worker that threads its accumulator as a tuple
      (a streaming `(sum, count)` mean, a parser state) is exactly the shape SpecConstr unpacks; wire the
      18.0 fusion output through SpecConstr so a fused pipeline's residual accumulator loop is also
      first-order, closing the gap between deforestation and unboxing.
- [x] **A `specConstr` differential-fuzzer battery in `optFuzz.ts`** — **shipped (23.0 follow-up).**
      `runSpecConstrFuzz` generates random self-recursive loops threading a 2/3-field tuple or
      single-constructor accumulator and re-proves specialised ≡ naive (VM + JS) with steps-never-rise
      on each; wired into the Tests page as its own live battery (150/150 by default, ~149 firing). The
      additive-update generator deliberately stays inside Int32 to isolate SpecConstr from the eqsat
      overflow gap below.
- [x] **eqsat overflow soundness gap (found by the 23.0 fuzzer) — FIXED.** The SpecConstr fuzzer
      surfaced that the equality-saturation pass could change a result for integer values **well inside
      ±2^53** (a loop multiplying its accumulators to ~1.4e9): the optimized VM and JS agreed with each
      other but *disagreed with the unoptimized VM*, and it reproduced with **no shape to specialise**,
      pinning it on the runtime, not SpecConstr. Root cause (deeper than the first guess): the VM/JS/
      folder computed Int `*` as `(a*b) | 0` / `Math.trunc(a*b)`, but two near-2^31 Int operands already
      make the *true* product exceed 2^53, so the double rounds **before** the wrap — making `*`
      order-dependent and breaking associativity/commutativity, so eqsat's (mathematically valid)
      reassociation observably changed the answer. The WASM backend was already correct (`i32.mul`). Fix:
      compute Int `*` with **`Math.imul`** (exact low-32-bit product) everywhere — VM `Op.MUL`, the JS
      runtime's `mulI`, the constant-folder, and the e-graph's constant fold — making `Int` a genuine
      **ℤ/2^32 ring** consistent across all three backends. The Schwartz–Zippel validator is untouched
      and stays sound: it certifies identities over ℤ, and the ring homomorphism ℤ → ℤ/2^32 carries each
      to a runtime identity at any magnitude. Identical to the old behaviour for every product ≤ 2^53 (so
      zero regression), and it also closed a latent VM/JS-vs-WASM disagreement. Verified by a multiplicative
      differential fuzzer (VM ≡ JS ≡ WASM ≡ unoptimized, monotone) over hundreds of overflowing loops.
- [ ] **Float the worker's loop-invariant *expressions* out too** — once SAT has captured the static
      arguments, any sub-expression of the worker body that depends only on them (not on a dynamic
      param) is loop-invariant and can be hoisted into the wrapper, computed once instead of per
      iteration; this is loop-invariant code motion riding on the static/dynamic split SAT computes.
- [ ] **A "wrapper/worker" badge in the Optimizer core view** — render the lifted vs. threaded
      parameters inline on the optimized core (greyed static binders on the wrapper, live ones on the
      worker) so the transformation is legible at a glance, not just in the rewrite table.
- [ ] **Cost-model gate + measured step delta per SAT** — record the actual VM-step delta each SAT
      produced (entry-count × args-saved − one-time wrapper cost) and surface it, so the rare
      "called-once, never-recurses" case that SAT could pessimise is visibly declined rather than
      argued away structurally.

Deferred (future, building on Aether 19.0 float-in):

- [ ] **Float-in of *impure but commutable* bindings into a single conditional arm** — today only
      `isPure` bindings sink. A binding whose only effect is `print` could still be sunk into the *sole*
      branch that uses it **iff** no other observable effect occurs between its old and new positions
      (an effect-ordering check, not just purity), widening the pass to the effectful programs it
      currently leaves alone.
- [ ] **Float-in past a `λ` when the lambda is *called at most once*** — the pass refuses every `λ`
      body to avoid multiplying work, but a one-shot continuation (a lambda applied exactly once on
      every path, e.g. the desugaring of `let`) could safely receive the binding; detecting linear
      (use-once) lambdas would unlock it without risking recomputation.
- [ ] **Full-laziness (the *other* let-float)** — its sibling from the same ICFP'96 paper: float a
      binding *out* of a lambda when it does **not** depend on the lambda's parameter, so a value
      recomputed on every call is computed once and shared. The dual risk to float-in (it can increase
      residency / change space behaviour) means it needs the cost-model gate below to fire safely.
- [ ] **A "scope ribbon" in the Optimizer core view** — draw each pure binding's original vs. final
      scope as a shrinking bracket so float-in (and GVN's hoist) are legible as *movement*, the way the
      decision-tree view already renders shared tests.
- [ ] **Sink into `match` *guards* before arm bodies** — a binding used only inside a `when` guard can
      sink onto the guard, so arms tested before it never evaluate it; the scope machinery already
      exposes guards as conditional positions, but the gallery lacks a guard-driven example to prove it.
- [ ] **A unified placement pass (GVN + float-in to a fixpoint)** — run hoist-to-share and
      sink-to-skip alternately until neither moves a binding, so a value used twice in one arm and never
      in another is first sunk into that arm *then* shared within it — the provably-optimal scope.
- [ ] **Cost-model gate shared by GVN, float-in and SAT** — a single `minCost`-driven oracle that
      predicts the VM-step delta of a proposed move and declines neutral or pessimising ones uniformly,
      replacing the three passes' separate structural heuristics with one measured decision (and a fuel
      view in the panel).

Deferred (future, building on Aether 20.0 dead-argument elimination):

- [ ] **Dead-argument elimination across mutually-recursive groups (`let rec … and …`)** — the pass
      handles a single self-recursive (or plain) binding; extend the dead-feed analysis across a whole
      `letrec` SCC so a parameter that only ever feeds its own slot through the group's *siblings* (not
      just direct self-calls) is dropped — the analogue, for DAE, of the deferred mutual-recursion SAT.
- [ ] **Dead *result* elimination** — the dual: a function in a `letrec` whose result is consumed by no
      reachable caller can be dropped wholesale; today only `reduceLetrec`'s reachability prunes whole
      bindings, not the finer "this tuple/record *field* of the result is never projected".
- [ ] **Constructor-field deadness (worker/wrapper on dead fields)** — if no `match` ever binds a given
      field of a one-constructor data type, the field is dead; a worker/wrapper split could stop building
      and threading it, the data-side analogue of dead-argument elimination.
- [ ] **Effectful-but-droppable arguments** — today a dead parameter is dropped only when every slot
      argument is pure; an argument whose sole effect is order-independent (e.g. a `print` with no
      following observable) could be hoisted to a `seq` at the call site and the parameter still dropped,
      widening DAE to the effectful loops it currently declines.
- [ ] **A measured step-delta per dead parameter** — record entry-count × per-call slot cost saved and
      surface it next to each dropped parameter, the same fuel accounting the GVN/float-in/SAT cost-model
      gate above would share.

Deferred (future, building on Aether 24.0 scalar replacement of aggregates):

- [ ] **SROA through a `let rec` (self-referential) record** — a recursive dictionary (`instance Disp a
      => Disp (List a)`, whose method closes over the dictionary itself) stays a `let rec` record and so
      is skipped by the pass; the `derec` rule only demotes non-self-referential ones. The projection
      `d.disp` could still be devirtualized to the method lambda (which keeps its recursive reference to
      `d`), since the binding survives — extend `scalarReplaceRecord` to the recursive branch.
- [ ] **Cost-gated substitution of non-capturing function fields used more than once** — today a
      function field is inlined only when projected ≤ once (so its closure *moves* rather than
      multiplying). A method whose body builds *no* closure (a η-reduced var like `show`, already an
      atom, or a small allocation-free lambda) could be duplicated across many sites with a measured
      cost gate, devirtualizing instances like `Disp Bool` (`fn b -> if b then "T" else "F"`) that are
      not atoms but are still cheaper inline than a projection-then-apply.
- [ ] **Tuple/cons scalar replacement** — the pass handles `record` aggregates; the same "replace the
      box with its scalars" applies to a multi-use `let`-bound tuple or cons cell projected by `match`
      (`let p = (a, b) in … match p with (x, y) -> …` across several uses). SpecConstr already covers
      the *loop-threaded* single-use case; this is its non-recursive, multi-use sibling.
- [ ] **`recordUpdate` scalar replacement** — `{ r with f = v }` builds a fresh record copying every
      other field; when the base `r` is a known record literal the update could be folded to one literal
      (`{ …r's fields…, f = v }`), then SROA'd, so a functional-update chain never allocates an
      intermediate.
- [ ] **Record-field deadness** — a `let`-bound record where some field is *never* projected (and the
      record never escapes whole) is building that field for nothing; drop the dead field from the
      literal (its value kept only as a `seq` if effectful), the record analogue of dead-argument
      elimination. Pairs with the constructor-field-deadness item above.
- [ ] **A measured step-delta + an "eliminated" badge per scalarised record** in the Optimizer core
      view — record the actual VM-step delta each SROA saved and whether the allocation was dropped, the
      same fuel accounting the other passes' cost-model gate would share.

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

### Aether 22.0 — the editor becomes a language server (`semantics.ts`)

Every release until now deepened the *compiler*; the *editor* stayed a syntax-highlighted textarea.
22.0 gives it IDE intelligence — built entirely on the artifacts inference already produces
(`nodeTypes`, `bindingSchemes`, `ctorInfo`) and the spans the parser already records, so a hover
shows exactly the type the three backends compile, never a second guess.

- [x] **Semantic query layer** (`src/lang/semantics.ts`) — a pure, in-process "language server":
      a lexical name-resolution walk that builds a binder table (def + every use, honouring
      shadowing) and cursor queries over it. Owns no type theory; only re-reads inference.
- [x] **Hover types** — hover any sub-expression for its inferred type; on a `var` it shows the
      binding's **generalised scheme** *and* the monomorphic type at that use site (`twice` →
      `∀ a. (a -> a) -> a -> a` with `at use: (Int -> Int) -> Int -> Int`), plus the binder's origin.
- [x] **Inlay type hints** — a faded `: type` ghost at the end of every `let`/`let rec` binding's
      line (toggleable from the toolbar), so the whole program's inferred types read inline.
- [x] **Occurrence highlighting** — putting the caret on a name lights up its definition and every
      use; a shadowing inner binding never leaks into an outer one (proved by the self-tests).
- [x] **Go-to-definition** — ⌘/Ctrl-click a name to jump to its binder and select it.
- [x] **Scope-aware completion** — ⌘/Ctrl-Space (or just type) for a ranked popup of in-scope
      locals/params/pattern-vars, user constructors, TypeScript primitives, the Aether prelude
      library and keywords — each annotated with its type/scheme; locals rank above globals.
- [x] **Rename refactoring** — F2 on a binding renames exactly the spans the resolver proved refer
      to it (right-to-left rewrite keeps offsets valid), so shadowed names elsewhere are untouched
      and the renamed program still type-checks.
- [x] **Hoverable diagnostics** — the existing error/warning squiggles now show their message on
      hover, not only in the status bar.
- [x] **Monospace geometry** — a hidden ruler measures the webfont's char width (re-measured on
      `document.fonts.ready` + resize); offsets ⟷ screen rows/cols drive every overlay, and an
      inlay layer glued to the scrolled text via a CSS transform avoids per-scroll React renders.
- [x] **Verification** — a 19-case **Editor-intelligence self-test** group (`semanticsSelfCheck.ts`)
      wired into the Tests page asserts hovers report the compiled type, occurrences/rename respect
      shadowing, completion filters + ranks correctly, and an unparseable buffer degrades instead of
      throwing. Driven live in a headless browser too (hover/inlay/occurrence/completion/rename all
      render). Full CI gate (scope + conformance + lint + tsc + build) green.

Future editor-intelligence ideas:

- [ ] **Signature help** — while typing arguments, show the callee's signature with the current
      parameter highlighted.
- [ ] **Record-field completion** after `.` driven by the record's inferred row type.
- [ ] **Document outline / breadcrumb** of top-level bindings, and a "find all references" panel.
- [ ] **Inlay hints for λ-parameters** (their domain type) and for `match` pattern variables.
- [ ] **Rename across a `deriving`/instance method** with class-aware scoping.

### Aether 23.0 — call-pattern specialisation (SpecConstr): recursing on the fields, not the box (planned + shipped this session)

The 17.0 static-argument transform lifts a loop-*invariant* argument out of a loop. SpecConstr
(Peyton Jones, *Call-pattern specialisation for Haskell programs*, ICFP 2007) is its dual: it
attacks a loop-*varying* argument that is rebuilt as the **same constructor / tuple shape** on every
iteration only to be torn straight back apart by the function's own `match` — pure box-then-project
churn, an allocation and a projection burned per turn for a cell that never escapes.

```
let rec loop = fn s ->                          -- a whole state threaded as one Acc
  match s with Acc i sum sumsq ->
    if i == 0 then (sum, sumsq)
    else loop (Acc (i - 1) (sum + i) (sumsq + i * i))   -- boxes a fresh Acc every iteration…
in loop (Acc 600 0 0)                            -- …only for `match s` to unbox it next turn
```

SpecConstr specialises the loop for that call pattern — it recurses on the three *fields* directly,
so no `Acc` is ever built and the seed is unpacked too. The load-bearing trick reuses machinery the
middle-end already proves correct: the specialised worker reconstructs the value once at its head as
`let s = Acc i sum sumsq in …`; because the pass fires **only** when `s` is used *exactly once* — as
that `match`'s destructuring scrutinee — the single-use value inliner copies the literal cell onto
the `match` and the 11.0 known-constructor rule then deletes the cell **and** the test, leaving a
clean first-order loop over the unpacked fields.

- [x] **The pass** (`specConstr` in `src/lang/optimize.ts`, wired into `reduceLet` after SAT) —
      detects a self-recursive, immediately-driven worker (`let rec f = fn p0 … -> body in f s0 …`),
      finds a slot carrying one fixed tuple/constructor shape at the seed *and* every recursive call,
      and — when that parameter is consumed exactly once as the destructuring `match` scrutinee —
      rewrites the loop to recurse on the unpacked fields, reconstructing the cell single-use at the
      worker head so the inliner + known-constructor rule melt it away.
- [x] **Soundness, conservative throughout** — reuses SAT's escape analysis (every free `f` must be a
      saturated call, else it declines); requires uniform shape across seed and all recursive calls
      (so the parameter is provably that shape at run time and rebuilding from its fields is exactly
      equal); fresh field/worker names everywhere so capture is impossible.
- [x] **Monotone by construction** — the per-iteration allocation and projection are removed and the
      rebuilt cell is single-use (so never built more often than before); nothing is duplicated, moved
      or made to run on a path it did not run before, so `steps(optimized) ≤ steps(unoptimized)` holds
      with no speculation gate. Measured **12–41 %** fewer VM steps on the canonical shape-threaded
      loops; the gallery example drops **~30 %**.
- [x] **Composition** — runs downstream of the 17.0 worker form, so a loop with *both* a static
      argument *and* a shape-threaded one has the first lifted into a wrapper and the second unpacked
      into the worker (verified: both passes fire, −37 % together). Terminates: an unpacked field is a
      scalar, so the specialised loop offers no uniform-shape slot to re-fire on.
- [x] **Three backends, re-proved** — emits ordinary core, so the VM, the JavaScript backend **and**
      the WebAssembly backend (incl. GC-stress mode) all compile the specialised program and the
      byte-for-byte VM ≡ JS ≡ WASM equivalence checks re-prove the answer is unchanged.
- [x] **Optimizer panel** — a `specconstr` rewrite row and a "Call-pattern specialisation (SpecConstr)"
      section naming each specialised loop, the parameter it unpacked and the shape it recognised.
- [x] **Verification** — a 7-case **`specconstr`** suite group (tuple / named-ADT / three-field /
      single-constructor countdown / composes-with-SAT, plus two *decline-but-correct* cases:
      two-different-constructors-per-call and a value kept whole), each proving VM(specialised) ≡
      JS(naive) ≡ expected; a standalone 600-program differential fuzzer of random tuple/constructor-
      threaded loops (594 fired, all VM ≡ JS, all monotone). Full CI gate (scope + conformance + lint +
      tsc + build) green.

## Standard library

- list: `map filter foldl foldr length append reverse sum range take drop elem all any concat zip replicate`
- string: `strlen toUpper toLower chars join parseInt` (+ `show`, `^`)
- primitives: `head tail empty print sqrt sin cos floor toFloat pi abs min max`
- operators: `+ - * / % | +. -. *. /. | == != < > <= >= | && || ! | :: ++ ^ | |> | ;`

## Session log

- 2026-06-28 (claude): **Integer multiplication made sound across all three backends (`Math.imul`) —
  fixing the eqsat overflow bug the SpecConstr fuzzer caught.** The 23.0 follow-up fuzzer turned up a
  divergence — optimized VM/JS disagreeing with the unoptimized VM for an accumulator loop reaching only
  ~1.4e9 — that reproduced with *no shape to specialise*, so it lived in the runtime, not SpecConstr.
  Root cause: the VM, the JS runtime and the constant-folder all computed Int `*` as `(a * b) | 0` /
  `Math.trunc(a * b)`, but two near-2^31 Int operands make the **true** product exceed 2^53, so the IEEE
  double rounds *before* the 32-bit wrap. That makes `*` order-dependent — associativity and commutativity
  fail — so the equality-saturation superoptimiser's mathematically-valid reassociation (`a*b - b*a → 0`,
  `(a*b)*c → a*(b*c)`) observably changed the answer. The WASM backend was already right, because it lowers
  `*` to `i32.mul` (exact low-32-bit). The fix makes the other backends agree with WASM: compute Int `*`
  with **`Math.imul`** at every value-producing site — the VM's `Op.MUL`, the JS runtime's `mulI`, the
  optimizer's constant-folder (`foldBinop`), and the e-graph's own constant fold (which now also wraps its
  `+` fold with `| 0`) — so `Int` is a genuine **ℤ/2^32 ring** identical on the bytecode VM, the JavaScript
  backend and the WebAssembly backend. The e-graph's Schwartz–Zippel validator needs no change and stays
  sound: it certifies an identity over ℤ (small leaves, exact), and the canonical ring homomorphism
  ℤ → ℤ/2^32 carries any ℤ-identity to a runtime identity — the previous bug was solely that the runtime
  was *not* a consistent ring, which `imul` repairs. Because `(a*b)|0` already equals `Math.imul(a,b)` for
  every product within ±2^53, the change is a no-op on all existing programs (zero regression: suite
  110/110, the 400-program optimizer fuzzer 400/400) and only corrects the overflow regime — and as a
  bonus it closes a latent VM/JS-vs-WASM disagreement that no prior test happened to exercise. Verified
  with a multiplicative differential fuzzer that builds random overflowing accumulator loops and checks
  VM(opt) ≡ VM(unopt) ≡ JS ≡ **WASM** with steps never rising (120/120 four-way, 500/500 VM≡JS); the
  in-app SpecConstr fuzzer's generator, previously held to additive updates to dodge this very bug, is
  restored to full `+ - *` arithmetic and stays green (300/300, ~299 firing). The eqsat panel's
  "overflow-free assumption" note is rewritten to state the stronger, now-true invariant. Full CI gate
  (scope + conformance + lint + tsc + build) green.
- 2026-06-28 (claude): **Aether 23.0 follow-up — an in-app SpecConstr differential fuzzer (and a real
  eqsat overflow bug it caught).** The 23.0 pass shipped validated by a curated 7-case suite group and a
  *standalone* 600-program fuzzer; this folds that fuzzer into the app so the Tests page proves SpecConstr
  soundness live. `runSpecConstrFuzz` (in `optFuzz.ts`) generates random self-recursive loops threading a
  2/3-field tuple or single-constructor accumulator they destructure each iteration — the exact call
  pattern SpecConstr unpacks — and for each proves the specialised program equals the naive one on the VM,
  re-equals it on the JavaScript backend, and never takes more VM steps; the Tests page renders it as its
  own "SpecConstr fuzz" battery (150/150, ~149 firing, best ~−74%, deterministic badge). Writing it caught
  something worth recording: an early version with multiplicative updates went **red** — but the divergence
  reproduced with *no shape to specialise at all* (a scalar version of the same recurrence, SpecConstr
  never firing), pinning it on the **equality-saturation** pass, not SpecConstr. The eqsat superoptimiser
  reassociates an integer-arithmetic island and re-rounds the result for values **well inside ±2^53**
  (~1.4e9) — the optimised VM and JS agree with each other but disagree with the unoptimised VM — most
  likely because the constant-folder wraps `+`/`-` with `| 0` (Int32) while `*` uses `Math.trunc` (no
  wrap), so a reassociated island whose partial product overflows Int32 lands on a different value than the
  left-to-right original. That is a genuine soundness gap relative to eqsat's stated "exact within ±2^53"
  guarantee; it is logged in the backlog with two fix options (consistent integer wrapping across the
  folder + VM, or a Schwartz–Zippel validation that samples the overflow regime so the rewrite is vetoed).
  The fuzzer's generator uses additive, bounded updates to stay inside Int32 and isolate the SpecConstr
  rewrite from that unrelated eqsat regime, so its specialise-≡-naive badge is honest. Full CI gate (scope
  + conformance + lint + tsc + build) green; the existing 400-program optimizer fuzzer stays 400/400.
- 2026-06-28 (claude): **Aether 23.0 — call-pattern specialisation (SpecConstr): recursing on the
  fields, not the box.** The 17.0 static-argument transform lifts a loop-*invariant* argument out of a
  recursive loop; its dual waste went untouched until now — a loop-*varying* argument that is rebuilt as
  the **same constructor / tuple shape** on every iteration only to be torn straight back apart by the
  function's own `match`. A state machine threaded as one `Acc i sum sumsq` value, an accumulator carried
  as a `(sum, product)` tuple, a zipper or parser state: every turn boxes a fresh cell on the heap and
  the next call's `match` immediately unboxes it — an allocation and a projection burned per iteration for
  a value that never escapes the loop. 23.0 adds the first-class **SpecConstr** pass (Peyton Jones,
  *Call-pattern specialisation for Haskell programs*, ICFP 2007), the marquee item the 17.0 notes deferred
  ("SAT + inlining already specialises a *known function*; the next step is to specialise a worker for the
  *constructor shape* its dynamic argument is repeatedly called with"). `specConstr` (in `optimize.ts`,
  wired into `reduceLet`'s recursive branch right after SAT) detects a self-recursive, *immediately driven*
  worker — `let rec f = fn p0 … p_{k-1} -> body in f s0 … s_{k-1}`, the same shape SAT seeds — and looks
  for a slot `j` that carries **one fixed shape** (a tuple of fixed arity, or one constructor) at the seed
  *and* at every recursive call. When it finds one whose parameter is consumed **exactly once**, as that
  shape's destructuring `match` scrutinee, it rewrites the loop to recurse on the shape's *fields* directly
  (`f (s+i, p*i) (i-1)` ⟶ `g (s+i) (p*i) (i-1)`) — no cell boxed — and reconstructs the whole value once at
  the worker's head as `let p_j = (s, p) in body`. The reconstruction is the load-bearing trick: because
  that binding is single-use, the value inliner copies the literal cell straight onto the `match` and the
  11.0 known-constructor rule then deletes **both** the cell and the test, leaving a clean first-order loop
  over the unpacked fields — the whole box/unbox pair evaporates by composing rewrites the middle-end
  already proves correct, exactly the way SAT leans on the existing inliner. Soundness is conservative and
  reuses SAT's own escape analysis: every free occurrence of `f` must be a saturated call (a bare or
  partial reference *escapes* and the pass declines); the slot's shape must be uniform across the seed and
  all recursive calls (so `p_j` is provably that shape at run time and rebuilding it from its fields is
  *exactly* equal); a value used twice, kept whole, or threaded as two different constructors is left
  untouched. The pass is **monotone by construction** — the per-iteration allocation and projection are
  removed and the rebuilt cell is single-use, so it is never built more often than before; nothing is
  duplicated, moved, or run on a path that did not run it — so `steps(optimized) ≤ steps(unoptimized)`
  holds with no speculation gate, and it composes *downstream* of SAT (a loop with both a static argument
  and a shape-threaded one has the first lifted into a wrapper and the second unpacked into the worker —
  both fire, −37 % together), terminating because an unpacked field is a scalar that offers no uniform-shape
  slot to re-fire on. Because it emits ordinary core, the bytecode VM, the JavaScript backend **and** the
  WebAssembly backend (including GC-stress mode, which collects before every allocation) all compile the
  specialised program and the byte-for-byte VM ≡ JS ≡ WASM equivalence checks re-prove the answer never
  moved. Measured **12–41 %** fewer VM steps on the canonical shape-threaded loops; a new `specconstr`
  gallery example — a countdown and two running totals carried as one `Acc` — drops **~30 %** (19 900 →
  13 845 steps) with the `Acc` gone entirely. The **Optimizer panel** gained a `specconstr` rewrite row and
  a "Call-pattern specialisation (SpecConstr)" section naming each specialised loop, its parameter and the
  shape it unpacked; the Tour and About pages gained first-class SpecConstr write-ups (the 17.0 sections,
  which advertised the effect "reached by composition", now point at the direct pass). Verification: the
  self-test suite grew **103 → 110** with a focused `specconstr` group — tuple / named-ADT / three-field /
  single-constructor-countdown / composes-with-SAT, plus two *declines-but-stays-correct* cases (two
  different constructors per call, and a state also kept whole) — each proving VM(specialised) ≡ JS(naive)
  ≡ expected; the existing 400-program optimizer fuzzer stays 400/400 monotone; and a standalone
  600-program differential fuzzer of random tuple/constructor-threaded loops (594 fired SpecConstr) found
  every one VM ≡ JS and `steps(on) ≤ steps(off)`. Full CI gate (scope + conformance + lint + tsc + build)
  green.
- 2026-06-27 (claude): **Aether 22.0 — the editor becomes a language server.** Twenty-one releases
  deepened the compiler; the editor stayed a syntax-highlighted `<textarea>`. 22.0 turns it into an
  IDE without adding a line of type theory — a new pure module `src/lang/semantics.ts` re-reads the
  artifacts inference *already* produces (`nodeTypes`, the per-`let` `bindingSchemes`, `ctorInfo`) and
  the char-offset `span` every parser node *already* carries, so its answers are the same types the
  three backends compile, never a parallel guess. The core is a lexical **name-resolution walk** that
  builds a binder table — for every `let`/`let rec`/λ-param/`match`-pattern/constructor/class-method
  binding, its definition span and every use, with a fresh scope `Map` per region so **shadowing** is
  honoured exactly. On top of that table the editor gained the full IDE surface: **hover** any
  sub-expression for its inferred type, and on a name the card shows both the binding's *generalised
  scheme* and the *monomorphic type at that use site* (`twice` → `∀ a. (a -> a) -> a -> a` plus
  `at use: (Int -> Int) -> Int -> Int`); **end-of-line inlay type ghosts** for every binding
  (toggleable); **occurrence highlighting** of a name's def + all uses from the caret; **go-to-def**
  on ⌘/Ctrl-click; **scope-aware completion** (⌘/Ctrl-Space or as-you-type) ranking in-scope
  locals/params/pattern-vars and user constructors above the TypeScript primitives, the Aether
  prelude library and keywords, each annotated with its type; **F2 rename** that rewrites exactly the
  spans the resolver proved refer to the binding (right-to-left so offsets stay valid) and so never
  disturbs a shadowed name elsewhere; and **hoverable diagnostics** on the existing squiggles. The
  overlays sit on the existing mirrored-`<pre>` editor: a hidden ruler measures the monospace
  webfont's char width (re-measured on `document.fonts.ready` and resize), offset⟷row/col arithmetic
  positions every popup, and the inlay layer is glued to the scrolled text by a CSS `transform` so
  scrolling never triggers a React render. Verification: a new **19-case Editor-intelligence
  self-test** group (`semanticsSelfCheck.ts`) on the Tests page drives the resolver over real,
  type-checked programs — a hover reports the compiled type, an inner binding never leaks past
  shadowing, rename touches the right spans and the result still type-checks, completion filters and
  ranks, and an unparseable buffer degrades without throwing — all 19 green alongside the existing
  batteries (the whole Tests page reads 19 groups, the new one included), and the features were also
  driven live in a headless Chromium (hover, inlays, occurrence highlight, completion and rename all
  render, zero app console errors). Additive by construction: no compiler/backend file changed, so the
  optimizer-fuzz and equivalence batteries are untouched. Full CI gate (scope + conformance + lint +
  tsc + build) green.

- 2026-06-26 (claude): **Aether 21.0 — case-of-case (commuting conversions) + 21.1 linear inlining.** The
  optimizer simplified values *once known*, but the commonest reason abstraction failed to melt was a producer
  (`if`/`match`) feeding straight into another eliminator: `match (if c then Some x else None) with None -> 0 |
  Some y -> y + 1`, `(if c then {a=x} else {a=0}).a`. The producer's result is dynamic, so const-fold and
  known-match stalled and the intermediate `Option`/record was built only to be torn apart — all left untouched.
  21.0 implements the central commuting conversion of the Glasgow Haskell optimiser (Peyton Jones & Santos 1998):
  a **strict eliminator** (a `match` scrutinee, a `.field` projection, a `binop`/`unop` operand) is pushed
  **inward** into the producer's branches so each branch meets it statically — the existing known-match /
  field-projection / fold rules then fire and the constructor/record/box is never allocated (`… ⇒ if c then x+1
  else 0`; `… ⇒ if c then x else 0`). It's **step-neutral by construction** (the frame is strict, so the chosen
  branch runs either way and the eliminator runs exactly once; only the unlocked reductions remove steps), gated
  on **exposing a redex** (it trial-runs the frame's own reducer on each branch, so it always buys a reduction
  and provably converges), and **capture-avoiding** (a `match` arm binder the moved frame mentions is α-renamed
  fresh; a short-circuit `&&`/`||` only hosts the producer in its strict left operand; a `binop`'s sibling must
  be a value, so no effect is duplicated or reordered). **21.1** adds a *linear inliner* so the abstraction can't
  hide behind a `let`: a single-use, pure, *non-value* binding is inlined into its sole occurrence — but only
  when that occurrence is **not under a lambda** (an `occursUnderLambda` walk), so it's evaluated at most as
  often as before — which exposes producers bound by β (`f (if c then 5 else 9)` ⇒ `if c then 105 else 109`).
  Wired into the fixpoint (`step`'s `match`/`field`/`binop`/`unop` cases) with a new `commutes` stat, an Optimizer
  panel section, a `case-of-case` gallery example (VM steps 243 → 120), a "How it works" card, an 8-case self-test
  group (in-app suite 95 → **103**, incl. capture-avoidance and an effect-runs-once case), and **two differential
  fuzzers** — 2000 random nested programs (579 fired case-of-case) and 600 lambda-crossing programs — every one
  agreeing across VM ≡ JS ≡ WASM with VM steps never rising. Also institutionalised that validation in the app
  (`optFuzz.ts`): the Tests page now runs a deterministic 120-program **optimizer differential-fuzz** group that
  re-proves opt-VM ≡ unopt-VM ≡ JS with VM steps never rising, in the browser (≈ 12 000 VM steps erased per
  batch). Full CI gate (scope + conformance + lint + tsc + build) green.
- 2026-06-26 (claude): **Aether 20.0 — dead-argument elimination.** The optimizer could move work up
  (GVN), down (float-in, 19.0) and lift a *static* loop argument out (SAT, 17.0), but had never asked
  whether a parameter's value *matters at all*. 20.0 drops two shapes of worthless parameter from a
  function and from every saturated call site: an **unused** parameter (never referenced — the 15.0
  inliner already deletes these for small non-recursive helpers, but cannot touch a recursive loop), and
  a **useless accumulator** (referenced *only* inside the argument the function feeds to its own slot, so
  its value is a pure dataflow dead-end that never reaches the result — a counter/sum threaded round a
  loop and thrown away). Both collapse to one test: strip every self-call's slot-`i` argument to `()` and
  check whether `p_i` still occurs; if not, it is dead. Eligibility mirrors SAT (a single self-recursive
  or plain `let` whose every free occurrence of the binder is a saturated call — an escape/partial
  application declines), it keeps ≥ 1 parameter, and it drops one parameter per fixpoint round (so a loop
  with several dead args is cleaned across rounds). Soundness: a parameter is dropped only when **every**
  argument ever passed in its slot is **pure**, so not evaluating the dropped argument loses no effect and
  the skipped arithmetic means VM steps can only fall (the `go (print n; dead) …` case keeps the
  parameter). It emits ordinary core, re-proved by the VM ≡ JS ≡ WASM equivalence checks. New `dead-param`
  rewrite row and a "Dead-argument elimination" panel section; a `dead-arg` gallery example drops two
  threaded values and the per-iteration multiply-add (canonical loops **−40 % to −58 %** VM steps). A
  6-case self-test group (in-app suite 89 → **95**), the example flowing through the JS / WASM / GC /
  disassembler / optimizer batteries, and the differential harness grown to **129 programs** (opt vs.
  naive on all three backends, result + output identical, steps never increased). Full CI gate green.
- 2026-06-26 (claude): **Aether 19.0 — float-in (let-floating inward), the dual of GVN.** Five versions
  taught the optimizer to move work *up* (CSE 11.0, GVN 14.0 — hoist a pure expression to a dominator so
  the evaluations below share it); the opposite move, pushing work *down*, was missing. In a **strict**
  language a top-level `let` is always evaluated, so a pure-but-expensive binding used only on a rare
  branch is paid for on every path. 19.0 adds the classic cure (Peyton Jones, Partain & Santos,
  *Let-floating: moving bindings to give faster programs*, ICFP 1996): a new `reduceLet` rule sinks a
  **pure, non-value** `let x = e in body` to the smallest subexpression of `body` that dominates all of
  `x`'s uses, via a `sinkBinding` walk over the existing scope-tracked child enumeration
  (`scopedChildren`, GVN's own machine). When that subexpression is behind a conditional, the branches
  that don't take it skip the work entirely. Soundness leans on proven machinery and is gated five ways:
  only `isPure` bindings move (skipping a pure, terminating computation is invisible in a strict
  language — the `(print "x"; 5)` case stays put); only positions evaluated ≤ once per host eval are
  entered, **never** a `λ` body (no work multiplication); only the binder's *sole* user is descended into
  (no duplication); the move is committed only when it **crosses a conditional** (a strict potential win,
  no neutral churn for GVN to undo); and a descent that would cross a binder shadowing `x` or capturing a
  free var of `e` is declined (the `match bx with Box b -> … h …` capture case). So
  `steps(optimized) ≤ steps(unoptimized)` by construction. Because it emits ordinary core, the VM, the
  JavaScript backend and the WebAssembly backend all compile it unchanged and the byte-for-byte
  equivalence checks re-prove the answer never moved. The **Optimizer panel** gained a `float-in` rewrite
  row and a "Float-in" section naming each binding sunk and the branch it landed in; a new `float-in`
  gallery example (a pure 800-element fold bound at the top but used only on the rare `Audit` arm) drops
  VM steps **60 883 → 25 645 (−58 %)** as the common `Peek` path stops paying for the fold, identical on
  all three backends. Verification: a 7-case in-app self-test group (sinks into an `if` branch / a
  `match` arm / the right of `&&`; declines when used in both branches; never moves an effect; never
  captures a pattern variable; the gallery dispatch — in-app suite 82 → **89**), the example
  auto-flowing through the JS / WASM / GC-stress / disassembler / optimizer batteries, and a dev-time
  differential harness (122 programs run optimized vs. naive across all three backends, asserting result
  + output identical and VM steps never increased — float-in lifts the suite-wide step saving from 519 k
  to 565 k). Full CI gate (scope + conformance + lint + tsc + build) green.
- 2026-06-26 (claude): **Aether 18.0 — short-cut fusion (deforestation).** Added a from-scratch fusion
  pass in a new module `src/lang/fusion.ts`, run as the optimizer's Phase 0 (before β/inlining/SAT can
  rewrite the prelude combinators out of recognisable shape). 14 algebraic laws delete the intermediate
  lists between list-combinator passes — map/map, filter/filter, the consumers (foldr/foldl/sum/all/any)
  pushed through a map or filter, length/map (drops the whole map), length/reverse, reverse/reverse, and
  take/map — run bottom-up to a fixpoint so a five-stage pipeline collapses to one `foldl` over the range
  (68 % VM-step cut on the gallery example). Two soundness guards: laws fire only on the *real* prelude
  combinator (scope-tracked structural recognition, so a user `let map = …` shadows it) and only when the
  function whose call-timing changes is proven pure & total by the optimizer's existing
  effect-&-totality analysis (the purity check is made transparent to the β-redexes fusion introduces, so
  lambda-map chains fuse fully). Emits ordinary core, so all three backends compile it unchanged and the
  VM ≡ JS ≡ WASM equivalence checks + never-increase-steps gate re-prove it. Wired `fuse` stats + a
  **"Short-cut fusion"** Optimizer-panel section, a `fusion` gallery example, Tour + About write-ups, an
  in-app `fusion` test group (8 cases), 25 targeted `checkOpt` cases (each law fires + cuts steps + 3
  decline cases) and a **400-program differential fuzzer**. Headless harness 417 → **451**, full CI gate
  green.
- 2026-06-23 (claude): **Aether 17.0 — the static-argument transformation.** Added a from-scratch SAT
  pass (Santos 1995; Peyton Jones & Santos 1998) to the optimizing middle-end (`src/lang/optimize.ts`),
  closing the long-deferred backlog item. A self-recursive `let rec f = fn p0 … p_{k-1} -> body` is
  analysed for *static* parameters — positions every recursive call passes as exactly `var p_i`
  (shadow-aware) — and split into a non-recursive **wrapper** binding the static args once and a
  recursive **worker** looping on only the dynamic ones, capturing the static ones as free variables.
  Conservative on escapes: any bare/partially-applied recursive occurrence declines the whole
  transform; fires only with ≥1 static and ≥1 dynamic param. Built entirely on the optimizer's existing
  capture-avoiding `rename`/`subst`/scoped-traversal helpers; dynamic params are α-renamed fresh inside
  the worker to avoid wrapper/worker name clashes. Wired `sat` rewrite stats + a new
  **"Static-argument transformation"** Optimizer-panel section, a `static-arg` gallery example, and 6
  self-tests (canonical map, SpecConstr-style specialisation, multi-static fold, the shadowing
  counter-case, an escaping fn left untransformed, guards). Verified headless across all three
  backends: the in-app suite is **74/74 (0 JS-mismatch)**, the WASM backend agrees byte-for-byte on
  every SAT'd loop, and SAT cuts **34–42 % of VM steps** on the canonical loops. The headline composition
  works: `each (fn x -> x*x) xs` optimizes to a bare first-order loop with `g` eliminated — SpecConstr's
  effect reached by SAT + the 15.0 inliner. `tools/harness.mjs` grew an 8-case SAT battery + a
  400-program differential fuzz of random static/dynamic splits (**417 checks, all green, 0
  mismatches**). Full CI gate (scope + conformance + lint + tsc + build) green.
- 2026-06-22 (claude): **Aether 16.0 — equality saturation.** Added a from-scratch e-graph
  superoptimizer (`src/lang/egraph.ts`, no `egg`/libraries) as a Phase-4 optimizer stage. It runs on
  the integer-arithmetic islands the type system guarantees are pure polynomials over their leaves:
  a union-find e-graph with free commutativity (sorted hash-cons keys) and a congruence-restoring
  `rebuild`; rules for associativity, factoring `u*x+u*y=u*(x+y)`, identities, `x+x=2x`, neg-pushing
  and cancellation; saturation under node/iteration budgets; and a cost-driven extraction of the
  cheapest equivalent term. Every adopted rewrite is differentially validated by **polynomial
  identity testing (Schwartz–Zippel)** and gated to strictly-cheaper, so it finds factorings
  (`a*2+a*3 ⟶ a*5`, `a*b-b*a ⟶ 0`) the greedy passes can never reach while VM steps only fall.
  Wired in `eqsat` stats, a new **Eq-Sat panel** that draws the saturated e-graph (e-classes/e-nodes,
  extracted term + root highlighted) with a one-click step measurement, an `eqsat` gallery example,
  an About card, and a 6-case self-test group (suite 62 → 68, all pass, 0 JS-mismatch). Verified all
  38 examples agree optimizer on/off, the 12 property self-tests pass, and a 1500-program in-range
  differential fuzz fired eqsat on 513 with **0 mismatches and 26% fewer VM steps**. A separate
  out-of-range fuzz pinned the soundness boundary exactly at 2^53 (the same overflow-free assumption
  GCC/LLVM make when they reassociate integer arithmetic). Full CI gate green.
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
- 2026-06-22 (claude): **Aether 15.0 — call-site inlining: the inliner grows up.** Since 10.0 the
  optimizing middle-end has inlined a `let`-bound function only when its binding is used *exactly once*
  — the blunt rule that keeps code from blowing up, at the price of never inlining the most common
  shape in real code: a small helper (`sq`, `lerp`, a projection) called from several places or inside
  a loop, which keeps paying the closure-application + frame overhead per call and never folds against
  the literals at the site. 15.0 lifts the cap with **size-bounded, call-site inlining of non-recursive
  functions** in `reduceLet`. It fires on a non-recursive `let f = λ… in body` where `f` is used more
  than once, its body is ≤ `INLINE_SIZE_LIMIT` (20) core nodes, and it is not match-bodied (those are
  left for the 12.0 decision-tree pass to own and share), and copies `f` into each **saturated call
  site** (`f e₁ … eₖ` of at least `f`'s arity) while every partial application or higher-order *escape*
  keeps one shared closure. The rewrite reuses the module's proven capture-avoiding machinery instead
  of hand-rolling it: `markHeads` rewrites each saturated call-spine head to a globally fresh
  placeholder (stopping at any binder that re-binds `f`), `rename` redirects the surviving escape
  occurrences to a fresh `alt`, and `subst` replaces the placeholders with the lambda — and because
  `subst` already freshens any binder on the path that would capture one of the lambda's free
  variables, the inlined copies denote exactly what the call did (proved by the `let n=100 in let f =
  fn x -> x+n in let n=999 in f 1` capture case → the definition-site `n=100` wins). If an escape
  survives, the lambda is re-bound to `alt`; if not, the function is fully inlined and **no closure is
  ever built**. The placeholder-then-`subst` detour also lets the existing β-reduction + const-folding
  finish the job: `sq 3 + sq 4 + sq 12` inlines, β-reduces to lets, folds to `9 + 16 + 144`, and
  collapses to `169` with `sq` gone entirely. The load-bearing property is **monotonicity**: an inlined
  call runs strictly fewer VM instructions than the real call it replaces, the body runs the *same
  number of times* either way (only source text is duplicated, never runtime work), and a copy on an
  un-taken branch costs nothing — so the harness's `steps(optimized) ≤ steps(unoptimized)` invariant
  holds by construction, with no speculation gate needed. Two choices keep the pass from fighting its
  neighbours: match-bodied functions are skipped (the decision-tree pass shares their arms via
  join-points — inlining would re-duplicate them), and the inliner is switched off during the
  post-decision-tree cleanup fixpoint (reserved for copy-propagating the tree's own bindings). Because
  it emits ordinary core, the VM, the JavaScript backend and the WebAssembly backend all compile the
  inlined program unchanged, and the byte-for-byte equivalence checks re-prove the answer never
  changed. The **Optimizer panel** gained an `inline-fn` rewrite row and a "Call-site inlining" section
  naming each inlined function, its site count, body size, and whether an escape closure was kept; a
  new `inline` gallery example (a numeric kernel whose helpers fold away and whose hot loop sheds a call
  per iteration) cuts VM steps **3727 → 2039 (−45%)**. Verification: the harness grew 367 → **386** —
  the new example auto-flows through the JS / WASM / GC-stress / disassembler / optimizer batteries (so
  inlined ≡ naive on result + output + effects + never-increased steps across all three backends), plus
  a focused inlining battery (fires on the multi-use cases, cuts real steps, keeps an escape binding
  when the function also escapes, avoids capture, respects the size budget, and declines on recursive /
  match-bodied functions), plus a 5-case in-app self-test group. Full CI gate (scope + conformance +
  lint + tsc + build) green.

- 2026-06-28 (claude): **Aether 24.0 — scalar replacement of aggregates: devirtualizing dictionaries.**
  Every prior optimizer session attacked *control* abstraction (inlining, SAT, SpecConstr, case-of-case,
  float-in) or shared *computation* (CSE, GVN, fusion, eqsat). One source of *data* abstraction had
  survived untouched: a record bound by `let` and used **more than once**. It is a value — it never
  repeats work or diverges — so the inliner is willing to move it, but it is not an **atom**, so copying
  it into each use would duplicate the heap allocation. The single-use value rule therefore declines it
  (`isValue && (isAtom || uses === 1)` is false for a multi-use record), and every `r.field` stays a
  *load plus a projection* at run time with the cell kept live. The case that makes this matter is
  **dictionary passing**: a constrained `let twice = fn x -> disp x ^ disp x` elaborates to a function
  taking a dictionary record `{ disp = show }`, and when the *same* dictionary feeds several call sites
  it is shared in one `let` — so `d.disp x` never devirtualizes and the type-class call stays an
  indirect projection-then-apply, the overhead real compilers spend a whole pass to remove. 24.0 is that
  pass: **record-field SROA** (`scalarReplaceRecord` in `optimize.ts`). At a `let x = { f₁ = v₁, … } in
  body` it classifies every use of `x` (per-label projection counts + whole-uses, shadow-aware), rewrites
  each eligible `x.fᵢ` straight to the field value `vᵢ`, and — once no use of `x` remains and the record
  is pure — drops the allocation outright. So a shared `{ disp = show }` collapses and `d.disp x` becomes
  the **direct call `show x`** across all six of the gallery example's sites, with the dictionary gone
  from the optimized core entirely; a plain `{ x = 3, y = 4 }` projected four times folds to the constant
  `25` with nothing allocated; and a config record read every loop iteration scalarises so `cfg.k`/`cfg.b`
  become literals inside the worker. **Monotonicity** (the standing "VM steps never rise" invariant) holds
  by construction from a two-case eligibility rule. An **atom** field (variable/literal) is free to
  duplicate and effect-free, and a single load never costs more than a load-then-project, so rewriting any
  number of its projections is a strict (weak) win whether or not the record survives. A **non-atom value**
  field (a small method lambda) is eligible only when `x` is used *solely* through projections (so
  substituting them all leaves the record dead and it is dropped) **and** that field is projected at most
  once (so its single closure **moves** to the call site rather than being built both in the record and
  inline) — either way the field is built no more often than before, minus a projection. The substitution
  (`substProjections`) is **capture-safe**: it stops descending into any binder that re-binds `x` (an inner
  `x` denotes a different value there) or that re-binds a free variable of the field it would substitute
  (which would steal it) — proven by a row that binds `let s = 7 in r.f` *inside* which `r.f` reads an
  outer `s = 100` and is correctly left as a projection, yielding `(100, 100)` rather than `(7, 100)`. The
  fix that made the first cut work was adding the missing `app` case to both the use-classifier and the
  substituter — projections living inside application arguments (`go (n-1) (acc + cfg.k * n)`) were
  otherwise invisible. Because it emits ordinary core, the bytecode VM, the JavaScript backend **and** the
  WebAssembly backend all run the scalarised program and the byte-for-byte VM ≡ JS ≡ WASM equivalence
  checks re-prove the answer never changed. The **Optimizer panel** gained a `sroa` rewrite row and a
  "Scalar replacement of aggregates — dictionary devirtualization" section naming each record, the
  projections it devirtualized, and whether the allocation was dropped; a new **`sroa` gallery example**
  shares one `Disp` dictionary across three `tag` calls and reads a `cfg` record in a hot loop and watches
  **both vanish** (cfg 2 sites + dict 6 sites, both fully eliminated, ~18% fewer VM steps). **Verification:**
  a new 150-program **SROA differential fuzzer** (`runSroaFuzz`) generates random `let`-bound records —
  atoms and small functions, the exact shape a dictionary takes — projected from many sites, half across a
  hot loop, and proves each sound three ways (scalarised VM ≡ naive VM ≡ JS backend) and **monotone** (no
  program took more steps): **150/150, 137 fired, 125 left the record dead, ~15k VM steps erased, best
  single program 80% fewer, zero failures**. A focused **8-case in-app `sroa` battery** covers the constant
  fold, a shared-dictionary devirtualization on real `class`/`instance` syntax, a config record read in a
  loop, a record used whole *and* projected, the capture-avoidance row, an effectful field whose effect is
  preserved (output `["x"]` re-checked), a function field projected twice that is correctly *not*
  duplicated, and a dictionary threaded through a recursive fold. The in-app suite grew 110 → **118**
  cases, all green, plus the new fuzzer badge on the Tests page; the existing 120-program optimizer fuzzer
  and 150-program SpecConstr fuzzer still pass unchanged (no regression). Full CI gate (scope + conformance
  + lint + tsc + build) green.
