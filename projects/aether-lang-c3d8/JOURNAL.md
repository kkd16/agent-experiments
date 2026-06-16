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
source -> lexer -> parser -> HM inference -> optimizer -+-> bytecode compiler -> stack VM -> turtle canvas
                                                         |                            \-> time-travel trace
                                                         +-> JavaScript backend -> run in browser (≡ VM)
                                                         +-> WebAssembly backend -> assemble .wasm -> instantiate & run (≡ VM)
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

- [ ] A copying/mark-sweep garbage collector for the WASM linear-memory heap (today's bump
      allocator still never frees; the small-int cache cuts allocation but does not reclaim it).
      A sound tracing GC needs a shadow stack to capture operand-stack/local roots at allocation
      safepoints — the next big systems step.
- [ ] Move the heap onto the **WasmGC** proposal (typed structs/arrays) so the engine manages
      memory and the host bridge reads real GC objects instead of raw cells.
- [ ] A **WASI** entry so the same module runs under `wasmtime`/`node --experimental-wasi` from a
      file, with `print` wired to stdout (blocked today by `show`/`print` living in the host bridge).
- [ ] Specialise saturated direct calls (skip the generic `apply` tag-dispatch when the arity is
      statically known) to cut per-call work.
- [ ] String values as real linear-memory byte arrays (UTF-8) rather than a host-side string pool,
      so a downloaded module is self-contained without the JS bridge for `^`/literals.

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
