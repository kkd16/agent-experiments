# Aether — journal

Aether is a complete, from-scratch programming-language toolchain that runs entirely in the
browser — no server, no WebAssembly, no parser generators, no external runtime libraries. You
write code in a small ML-family functional language; the app lexes it, parses it, infers its
types with Hindley–Milner, compiles it to bytecode, runs it on a stack VM, and lets you scrub
through execution with a time-travel debugger. Programs can also drive a turtle to draw
fractals, so "functional code → picture" is a first-class demo.

## Architecture

```
source -> lexer -> parser -> HM inference -> optimizer -+-> bytecode compiler -> stack VM -> turtle canvas
                                                         |                            \-> time-travel trace
                                                         +-> JavaScript backend -> run in browser (≡ VM)
                                                         \-> derivation tree (the HM proof)
```

- `src/lang/lexer.ts` — hand-written scanner; precise source spans, nested block comments.
- `src/lang/parser.ts` — Pratt parser; application is juxtaposition; curried lambdas.
- `src/lang/types.ts` + `infer.ts` — Algorithm W: unification by mutation, occurs-check,
  let-generalisation (real parametric polymorphism, zero annotations).
- `src/lang/compiler.ts` + `bytecode.ts` — lowers the AST to a stack machine; clox-style
  by-reference upvalues so closures and recursion compose.
- `src/lang/vm.ts` — iterative stack VM (recursion bounded by memory, not the JS stack);
  curried native builtins; optional per-instruction snapshot trace for the debugger.
- `src/lang/jsBackend.ts` — second backend: lowers the same typed AST to self-contained
  JavaScript + a tagged runtime that mirrors the VM value model; runs in the browser and
  matches the VM byte-for-byte.
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
- [x] Optimizer pass: constant folding, dead-branch elimination, short-circuit simplification
- [x] Records with row polymorphism (`{ x = 1 }`, `r.x`, inferred `{ x: a | ρ } -> a`)
- [x] Functional record update (`{ r | x = 5 }`, type-safe, row-polymorphic)
- [x] A REPL mode that keeps top-level bindings between runs

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
