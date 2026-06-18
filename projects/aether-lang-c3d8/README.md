# Aether

A complete, statically-typed functional **programming language and toolchain that runs entirely in
your browser** — no server, no parser generators, no compiler libraries (no `wabt`, no `binaryen`),
no runtime libraries beyond React for the UI. You write Aether source in the playground; it is
lexed, parsed, type-inferred, optimized, and compiled **three ways** — to bytecode for a custom
stack VM, to self-contained JavaScript, *and* to a real **WebAssembly** module hand-assembled to
bytes and run by the engine (with its linear-memory heap collected by a from-scratch **tracing
garbage collector**) — with every intermediate stage inspectable, an interactive time-travel
debugger, and a live Hindley–Milner derivation tree.

Live: <https://kkd16.github.io/agent-experiments/projects/aether-lang-c3d8/>

```
// functional code that draws — a fractal tree
let rec tree len depth =
  if depth == 0 then ()
  else (
    forward len;
    push (); turn 28.0;  tree (len *. 0.72) (depth - 1); pop ();
    push (); turn (0.0 -. 32.0); tree (len *. 0.72) (depth - 1); pop ();
    back len
  ) in
tree 120.0 10
```

## The language

Aether is an ML-family expression language. Everything is an expression; there are no statements.

- **Literals** — `Int` (`42`), `Float` (`3.14`), `Bool` (`true`/`false`), `String` (`"hi"`),
  `Unit` (`()`), lists (`[1, 2, 3]`), tuples (`(1, "a", true)`).
- **Functions are curried** — `fn a b -> …`; `let f a b = …` is sugar for `let f = fn a b -> …`.
  Partial application just works.
- **Bindings** — `let x = e in body`, recursive `let rec f = … in …`, and mutually recursive
  `let rec f = … and g = … in …`.
- **Conditionals** — `if c then a else b`.
- **Pattern matching** — `match e with | pat -> … | …`, over literals, `_`, variables, tuples,
  lists (`[]`, `h :: t`, `[a, b]`), and constructors; clauses may carry a `when` guard. Matches
  are checked for **exhaustiveness** (missing cases reported with a witness) and **redundancy**.
- **Algebraic data types** — `type Option a = None | Some a in …`; polymorphic and recursive.
  Constructors are ordinary curried functions.
- **Records with row polymorphism** — `{ x = 1, y = 2 }`, field access `r.x`, and functional
  update `{ r | x = 10 }`. A function like `fn r -> r.x` is inferred as `{ x: a | ρ } -> a`, so it
  works on any record carrying that field.
- **List comprehensions** — `[ e | x <- xs, guard, y <- ys ]` with generators and guards, pure
  sugar over `concat` / `map` / `if`, so they're fully inferred and run on both backends.
- **do-notation** — `do { x <- e; …; r }` is sugar for `bind`
  (`do { x <- e; rest }` ⇒ `bind e (fn x -> rest)`). Bind the genuine `Monad` class method and the
  *same* block is the Option, List or State monad **by type** — both backends run it with no special
  support.
- **Type inference** — full Hindley–Milner (Algorithm W) with let-generalization; no type
  annotations anywhere. `let id = fn x -> x` is `∀ a. a -> a`.
- **Type classes** — `class Disp a where disp : a -> String in …` and
  `instance Disp Int where disp = … in …` add *principled overloading*. Inference produces
  **qualified types** (`∀a. Disp a => a -> String`), resolves each constraint to an instance
  (instances may carry a context, e.g. `instance Disp a => Disp (List a)`), and compiles classes to
  **dictionary passing** — entirely as an elaboration into the core language, so both backends run
  them unchanged. The **Classes** tab shows the elaborated core.
- **Higher-kinded types & a kind system** — type classes range over **type constructors**, not just
  proper types. `class Monad m where bind : m a -> (a -> m b) -> m b` abstracts over an `m` of kind
  `* -> *`, so a single generic combinator (`mapM`, `sequence`, …) runs in *every* monad — `Option`,
  `List`, even the partially-applied `State s`. Kinds are **inferred** (no annotations): each class
  parameter's kind is read off how its methods use it, and ill-kinded programs like
  `instance Monad Int` are rejected with a clear message. Internally a type variable can now stand
  for a constructor (a `TApp` node bridges to ordinary `TCon`s during unification), and the **Classes**
  tab shows each class's inferred kind.
- **Superclasses** — `class Functor f => Monad f where …`. A subclass dictionary embeds its
  superclass dictionaries (as `$super_…` fields), so a `Monad m` constraint *entails* a `Functor m`
  one: you write `Monad m =>` and get `fmap` for free, discharged by projecting through the dictionary.
  Declaring a `Monad` instance requires (and references) the corresponding `Functor` instance.
- **`deriving`** — a data type may end with `deriving (Eq, Ord, Show, Enum, Bounded, Functor, Foldable)`
  and the compiler **writes the instances for you**, generating each method from the type's shape:

  ```
  type Suit = Clubs | Diamonds | Hearts | Spades deriving (Eq, Ord, Show) in
  type Card = Card Suit Int                       deriving (Eq, Ord, Show) in
  compare (Card Clubs 14) (Card Spades 3)         // Clubs < Spades ⇒ -1
  ```

  - `Eq` compares constructors structurally; `Ord` orders by constructor declaration order, then
    lexicographically by fields (`compare : a -> a -> Int`); `Show` prints Haskell-style
    `(Ctor f₁ f₂ …)`. Structural recursion goes *through the class method*, so a recursive or
    parametric type's instance carries an **inferred context** (`Eq a => Eq (Tree a)`) and bottoms
    out at the leaves' own instances.
  - `Enum`/`Bounded` work on C-style enums: `fromEnum`/`toEnum` index each constructor and
    `minBound`/`maxBound` fence the type.
  - **`deriving Functor`** synthesises `fmap` by mapping over the type's **last** parameter —
    applying the function where the parameter sits directly, and **recursing** through the type
    itself, through `List`, and through tuples; the instance head is the type applied to its other
    parameters (kind `* -> *`).
  - **`deriving Foldable`** synthesises `foldr` over the same last parameter (in the standard
    DeriveFoldable order), recursing through the type and tuples and folding `List` fields with an
    inline right fold — so a derived `Foldable` gives you `toList`, `sum`, `length`, … for free.

  It's all **pure parse-time desugaring** into ordinary `instance` declarations nested in the type's
  body, so inference type-checks, kind-checks and elaborates them like hand-written ones — and the
  bytecode VM and the JavaScript backend run derived instances with **zero** added code. The
  **Classes** tab badges the synthesised instances `derived`. Non-derivable classes, `Enum` on a type
  with fields, and `Functor` on a type with no parameter (or a parameter in a function-argument
  position) are all rejected with a clear message.

### Property-based testing (Aether Check)

The **Check** tab is from-scratch QuickCheck, driven entirely by the type checker. Write a
`prop_…` function returning `Bool`; Aether reads its **inferred type** and builds a random-value
generator straight from that type — `Int`/`Float`/`Bool`/`String`/`Unit`, lists, tuples, records,
**your own ADTs** (recursively, with a size budget that guarantees recursive types like `Tree`
terminate), and even **functions** (generated as a finite table `fn x -> if x == k then v … else d`,
so higher-order laws like map fusion are testable). It runs hundreds of cases through the real VM
and, on a failure, performs **integrated shrinking** (ints toward zero, lists dropped & halved, ADTs
replaced by sub-terms, functions reduced to fewer entries) down to a *minimal* counterexample. A runtime crash is caught and reported with the exact input that caused
it. Leftover polymorphism defaults to `Int`, and the RNG is seeded so every report is reproducible.

```
let prop_rev = fn xs -> reverse (reverse xs) == xs in   // ✓ passes 200 cases
let prop_bad = fn xs -> reverse xs == xs in             // ✗ falsified, shrinks to [0, -1]
prop_rev
```

### The optimizing middle-end

Between the front end and the backends sits a real, multi-pass **optimizing middle-end** that
rewrites the elaborated *core* (the dictionary-passed, class-free program) into a smaller, faster
equivalent — which **all three backends then compile**, so a single optimizer makes the VM, the
JavaScript and the WebAssembly outputs faster at once, and the existing equivalence checks re-prove
on every program that the answer never changed. It runs to a fixpoint and includes constant folding
+ algebraic identities (`x + 0`, `x * 1`, `x ++ []`, short-circuits), branch elimination,
β-reduction (`(fn x -> b) a` ⇒ `let x = a in b`, with let-floating for curried calls) and
η-contraction, inlining / copy-propagation of value bindings (capture-avoiding), dead-binding
elimination, **known-constructor `match` reduction** (a `match` on a statically-known literal /
tuple / list / constructor collapses to its arm), and record **field projection**. Every rewrite is
semantics-preserving *for a strict, effectful language*: two predicates (`isValue`, `isPure`) keep it
from ever reordering, duplicating or dropping a computation that could `print`, diverge or raise.

Together these make the abstraction the front end adds **melt away**: a type-class method call on a
concrete value inlines the dictionary, projects the method out of its record, β-reduces, and — if the
value is a literal constructor — selects the `match` arm and folds the arithmetic. The gallery's
*"The optimizing middle-end"* example reduces `area (Circle 2.0)` (a `class Area` method call) all the
way to the single literal `12.56636`; its whole core shrinks from 41 nodes to 4. The **Optimizer**
tab shows the rewrite breakdown by rule, the node-count reduction, the before/after core, and a
one-click VM-step measurement.

### Three backends

The same type-checked, **optimized** AST is compiled three independent ways, which share the front
end and agree on every program:

- **Bytecode VM** — lowered to a stack machine run by a hand-written, iterative VM, with a
  time-travel debugger.
- **JavaScript** — lowered to readable, self-contained JavaScript and run in your browser. A tiny
  runtime mirrors the VM's value model exactly (tagged ints/floats, structural comparison, the
  turtle effect log), so the result, printed output and drawing match the VM **byte-for-byte** —
  there's a live equivalence check in the JavaScript tab.
- **WebAssembly** — lowered to a *real* `.wasm` module by a from-scratch binary encoder (no `wabt`,
  no `binaryen`), instantiated and run by the engine. Values are tagged cells in linear memory over
  a bump allocator; closures dispatch through `call_indirect`; tail calls use the WebAssembly
  tail-call proposal (`return_call`) for the VM's constant-space recursion; arithmetic, comparison
  of numbers, list/tuple/record/ADT building and `match` all run as native WASM, while printing,
  `show`, structural comparison, string ops and the turtle are **imports that reuse the VM's own
  code** — so the result matches the VM byte-for-byte by construction. The bump allocator keeps a
  **shared small-integer cache** (one pre-built `INT` cell per value in a small range) so
  arithmetic-heavy code reuses cells instead of boxing fresh ones — invisible to results because
  every value is compared structurally, and the module *counts* what it does
  (`__allocCount`/`__allocBytes`/`__cacheHits`). The module also carries a **`name` section**, and the
  WebAssembly tab disassembles its own bytes back into readable **WAT text** — a from-scratch binary
  *decoder* (the mirror of the encoder) that resolves every call/global/local to a `$name` — alongside
  the module's sections, live allocation stats, and a **download for the `.wasm`** to run anywhere.
  That heap is **garbage-collected**: a precise, non-moving **mark-sweep collector** (hand-written in
  WebAssembly) reclaims dead cells. Because wasm hides the operand stack and locals from the
  collector, codegen keeps a **shadow stack** of roots in linear memory — each function roots its
  arguments and `let`/`match` bindings and pops its whole frame at every exit, and compound values are
  built parts-first — so the collector marks from the shadow stack plus the value globals (cons spines
  iterate, so long lists mark in constant stack) and sweeps the heap into a coalesced free list the
  allocator reuses. Nothing moves, so the pointers in wasm locals stay valid across a collection. A
  **GC stress mode** collects before *every* allocation: the result is byte-for-byte identical (a live
  proof the root set is complete) while a long allocator loop keeps a *bounded* peak heap. The tab
  reports collections, bytes reclaimed, cells reused and the peak heap.

### Operators

| | |
|---|---|
| `+ - * / %` | integer arithmetic (`%` is modulo) |
| `+. -. *. /.` | floating-point arithmetic |
| `== != < > <= >=` | structural, polymorphic comparison |
| `&& \|\|` | short-circuiting boolean |
| `:: ++ ^` | list cons / list append / string concat |
| `\|>` | pipe: `x \|> f` means `f x` |
| `;` | sequence (evaluate, discard, continue) |

### Standard library

Written partly as TypeScript primitives and partly in Aether itself (compiled into every program):

- **lists** — `map filter foldl foldr length append reverse sum range take drop elem all any concat zip replicate`
- **strings** — `strlen toUpper toLower chars join parseInt` (plus `show`, `^`)
- **numeric** — `abs min max sqrt sin cos floor toFloat pi`
- **primitives** — `head tail empty print`
- **turtle graphics** — `forward back turn penUp penDown push pop color width clear`

## Architecture

```
                                                            ┌─▶ compiler ─▶ stack VM ─▶ turtle canvas
source ─▶ lexer ─▶ parser ─▶ HM inference ─▶ elaborate ─▶ optimizer        └─▶ time-travel trace
              │                    │                        ├─▶ JS backend   ─▶ run in browser (≡ VM)
              │                    │                        ├─▶ WASM backend ─▶ assemble .wasm ─▶ instantiate & run (≡ VM)
              │                    ├─▶ derivation tree (the HM proof)
              │                    └─▶ Aether Check (generate from types, run, shrink)
              └─▶ list comprehensions & do-notation desugar here
```

| File | Responsibility |
|---|---|
| `src/lang/lexer.ts` | hand-written scanner; precise source spans, nested block comments |
| `src/lang/ast.ts` | the typed AST, patterns, and type-expression syntax |
| `src/lang/parser.ts` | Pratt (precedence-climbing) parser; application is juxtaposition |
| `src/lang/types.ts` | type representation (incl. rows + higher-kinded `TApp`), pretty-printing |
| `src/lang/kinds.ts` | the kind system: kinds, kind unification, kind inference for HKT |
| `src/lang/infer.ts` | Algorithm W: unification (rows + applications), let-generalization, kind checking, type-class + superclass constraint solving |
| `src/lang/classes.ts` | type-class evidence (incl. superclass projection) + dictionary-passing elaboration into core AST |
| `src/lang/unparse.ts` | core-AST pretty-printer (renders the elaborated dictionaries) |
| `src/lang/exhaustive.ts` | Maranget's pattern-usefulness algorithm (exhaustiveness + redundancy) |
| `src/lang/optimize.ts` | the optimizing middle-end: a fixpoint of const-folding, algebra, β/η, capture-avoiding inlining, dead-binding elimination, known-constructor `match` reduction & field projection over the core AST (feeds all three backends) |
| `src/lang/bytecode.ts` | opcodes + disassembler |
| `src/lang/compiler.ts` | AST → bytecode; clox-style upvalues; tail-call detection |
| `src/lang/vm.ts` | iterative stack VM; closures, currying, tail calls, snapshot trace |
| `src/lang/jsBackend.ts` | AST → self-contained JavaScript (second backend); runs in the browser |
| `src/wasm/encoder.ts` | from-scratch WebAssembly binary encoder (LEB128, sections, instruction builder) |
| `src/wasm/layout.ts` | the tagged linear-memory heap layout (+ GC bits, shadow stack, free-list nodes) shared by codegen and the host bridge |
| `src/wasm/codegen.ts` | AST → WebAssembly (third backend): closure conversion, tail calls, `match`, the shadow-stack root discipline + mark-sweep GC runtime |
| `src/wasm/bridge.ts` | host imports that decode/encode heap cells and reuse the VM's print/show/compare |
| `src/wasm/run.ts` | assemble → instantiate → run the `.wasm`; section summary, hex dump, heap stats |
| `src/wasm/disasm.ts` | from-scratch WAT disassembler — decodes the emitted bytes back to readable, named WAT |
| `src/lang/derivation.ts` | reconstructs the HM proof tree from the inferred per-node types |
| `src/lang/values.ts` | runtime values, structural equality, upvalues |
| `src/lang/prelude.ts` | primitive type schemes + native impls + the Aether-source library |
| `src/lang/turtle.ts` | folds turtle effects into line segments for the canvas |
| `src/lang/pipeline.ts` | orchestrates all stages and collects every artifact |
| `src/lang/property.ts` | type-directed property testing: generators, shrinking, the runner |
| `src/lang/testSuite.ts` | the pipeline self-test battery (proves JS ≡ VM per case) |
| `src/lang/propertySuite.ts` | self-tests for the property engine's own behaviour |
| `src/repl.ts` | REPL evaluation (re-wraps accumulated definitions) |

### Notable implementation points

- **Closures & recursion** use clox-style upvalues (captured by reference), so mutual and
  self-recursion compose; the VM is iterative with its own frame stack, so recursion depth is
  bounded by memory rather than the JS call stack.
- **Tail-call optimization** reuses the current frame for calls in tail position — constant-space
  tail recursion, visible as a flat call-frame count in the debugger.
- **Row unification** (Rémy/Leijen) gives row-polymorphic records with no annotations.
- The **WebAssembly garbage collector** is precise and non-moving (mark-sweep). Its root finder is a
  **shadow stack** codegen keeps in lock-step with the real one — the only sound way to trace a heap
  when wasm hides the operand stack and locals. Choosing *non-moving* is what keeps the codegen
  surgery bounded: objects never move, so wasm locals stay valid across a collection and the shadow
  stack only has to keep reachable objects *marked*, never rewrite them. Correctness is proved by a
  stress mode that collects before every allocation with byte-for-byte identical results.
- The **prelude** (`map`, `filter`, `fold`, …) is written in Aether and compiled into every
  program; the visualizers show only your own source.

## The app

A two-pane **playground**: a syntax-highlighted editor with live type-checking, error squiggles,
and exhaustiveness warnings, beside tabbed inspectors for every stage — Result, Canvas, Tokens,
AST (hover for inferred types), Types, a **Classes** view, a **Check** tab (property-based testing
that generates inputs from inferred types and shrinks failures), an interactive **Derivation** tree,
Bytecode disassembly, a **JavaScript** backend (generated code + a one-click "run & compare against
the VM"), and a **time-travel Debugger** that scrubs through execution showing the stack and frames.
Plus an interactive **REPL**, an **examples** gallery, a **language tour**, and an **internals**
writeup. Programs are autosaved and shareable via URL.

## Develop

```bash
pnpm install
pnpm dev      # playground at localhost
pnpm build    # type-check + production build
pnpm lint
```

The whole language core is plain TypeScript with erasable types, so it can also be exercised
outside the browser with Node's type stripping (`node --experimental-strip-types`).

See [JOURNAL.md](./JOURNAL.md) for the development log and backlog.
