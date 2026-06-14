# Aether

A complete, statically-typed functional **programming language and toolchain that runs entirely in
your browser** — no server, no WebAssembly, no parser generators, no runtime libraries beyond React
for the UI. You write Aether source in the playground; it is lexed, parsed, type-inferred,
optimized, and compiled **two ways** — to bytecode for a custom stack VM *and* to self-contained
JavaScript — with every intermediate stage inspectable, an interactive time-travel debugger, and a
live Hindley–Milner derivation tree.

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
- **do-notation** — `do { x <- e; …; r }` is pure sugar over a `bind` in scope
  (`do { x <- e; rest }` ⇒ `bind e (fn x -> rest)`), so the same block expresses Option
  short-circuiting or List non-determinism depending on the monad you bind — and both backends run
  it with no special support.
- **Type inference** — full Hindley–Milner (Algorithm W) with let-generalization; no type
  annotations anywhere. `let id = fn x -> x` is `∀ a. a -> a`.
- **Type classes** — `class Disp a where disp : a -> String in …` and
  `instance Disp Int where disp = … in …` add *principled overloading*. Inference produces
  **qualified types** (`∀a. Disp a => a -> String`), resolves each constraint to an instance
  (instances may carry a context, e.g. `instance Disp a => Disp (List a)`), and compiles classes to
  **dictionary passing** — entirely as an elaboration into the core language, so both backends run
  them unchanged. The **Classes** tab shows the elaborated core.

### Property-based testing (Aether Check)

The **Check** tab is from-scratch QuickCheck, driven entirely by the type checker. Write a
`prop_…` function returning `Bool`; Aether reads its **inferred type** and builds a random-value
generator straight from that type — `Int`/`Float`/`Bool`/`String`/`Unit`, lists, tuples, records,
and **your own ADTs**, recursively, with a size budget that guarantees recursive types like `Tree`
terminate. It runs hundreds of cases through the real VM and, on a failure, performs **integrated
shrinking** (ints toward zero, lists dropped & halved, ADTs replaced by sub-terms) down to a
*minimal* counterexample. A runtime crash is caught and reported with the exact input that caused
it. Leftover polymorphism defaults to `Int`, and the RNG is seeded so every report is reproducible.

```
let prop_rev = fn xs -> reverse (reverse xs) == xs in   // ✓ passes 200 cases
let prop_bad = fn xs -> reverse xs == xs in             // ✗ falsified, shrinks to [0, -1]
prop_rev
```

### Two backends

The same type-checked AST is compiled two independent ways, which share the front end and agree on
every program:

- **Bytecode VM** — lowered to a stack machine run by a hand-written, iterative VM, with a
  time-travel debugger.
- **JavaScript** — lowered to readable, self-contained JavaScript and run in your browser. A tiny
  runtime mirrors the VM's value model exactly (tagged ints/floats, structural comparison, the
  turtle effect log), so the result, printed output and drawing match the VM **byte-for-byte** —
  there's a live equivalence check in the JavaScript tab.

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
source ─▶ lexer ─▶ parser ─▶ HM inference ─▶ optimizer        └─▶ time-travel trace
              │                    │           └─▶ JS backend ─▶ run in browser (≡ VM)
              │                    ├─▶ derivation tree (the HM proof)
              │                    └─▶ Aether Check (generate from types, run, shrink)
              └─▶ list comprehensions & do-notation desugar here
```

| File | Responsibility |
|---|---|
| `src/lang/lexer.ts` | hand-written scanner; precise source spans, nested block comments |
| `src/lang/ast.ts` | the typed AST, patterns, and type-expression syntax |
| `src/lang/parser.ts` | Pratt (precedence-climbing) parser; application is juxtaposition |
| `src/lang/types.ts` | type representation (incl. rows), pretty-printing |
| `src/lang/infer.ts` | Algorithm W: unification (with row unification), let-generalization, type-class constraint solving |
| `src/lang/classes.ts` | type-class evidence + dictionary-passing elaboration into core AST |
| `src/lang/unparse.ts` | core-AST pretty-printer (renders the elaborated dictionaries) |
| `src/lang/exhaustive.ts` | Maranget's pattern-usefulness algorithm (exhaustiveness + redundancy) |
| `src/lang/optimize.ts` | constant folding, dead-branch elimination, short-circuit simplification |
| `src/lang/bytecode.ts` | opcodes + disassembler |
| `src/lang/compiler.ts` | AST → bytecode; clox-style upvalues; tail-call detection |
| `src/lang/vm.ts` | iterative stack VM; closures, currying, tail calls, snapshot trace |
| `src/lang/jsBackend.ts` | AST → self-contained JavaScript (second backend); runs in the browser |
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
