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

- [ ] **Predicates in the type system** — `Pred { cls, type }`, qualified schemes
      (`∀a. (Disp a) => a -> String`), and qualified pretty-printing in the Types panel.
- [ ] **Surface syntax** — `class C a where m : τ ; … in body`, `instance C T where m = e ; … in
      body`, the `=>` constraint arrow, and `class`/`instance`/`where` keywords. New AST nodes
      `classdecl` / `instancedecl`; every AST walk (label, children, optimizer, derivation)
      learns them.
- [ ] **Constraint solving + instance resolution** (`classes.ts`) — context reduction for a
      single-parameter class system: ground heads resolve to instance dictionaries (recursively
      through instance contexts like `Disp a => Disp (List a)`); type-variable heads defer to a
      dictionary parameter, captured at the nearest enclosing generalization. Clear errors for
      missing/overlapping/ambiguous instances.
- [ ] **Dictionary-passing elaboration** — turn the typed program into core AST: instance dicts
      as records, constrained bindings as dictionary-abstracted lambdas, method uses as field
      accesses, use sites as evidence applications. Identity on programs that use no classes.
- [ ] **Both backends, unchanged** — the VM compiles the elaborated core; the JS backend lowers
      the elaborated user AST, so overloaded programs still pass the byte-for-byte JS≡VM badge.
- [ ] **A standard `class` library** — built-in `Disp` (overloaded show), `Eq`, `Ord`, and
      `Semigroup`, with instances for `Int`/`Float`/`Bool`/`String`/`Unit`, lists, and tuples
      (the recursive ones genuinely pass dictionaries).
- [ ] **A "Classes" inspector panel** — show declared classes & instances, and the elaborated
      core (dictionaries made visible) so the dictionary-passing is no longer a black box.
- [ ] **Examples** — a shapes `area` class, an overloaded `disp`, a `Semigroup`/`combine`
      showcase, and a constrained-polymorphism example that needs a passed dictionary.
- [ ] **Docs + verification** — Tour/About/README writeups; extend the Node strip-types harness
      to cover instance resolution, dictionary passing, JS≡VM over class programs, and error cases.

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
