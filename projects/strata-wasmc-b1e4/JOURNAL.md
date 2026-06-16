# Strata — journal

The app's long-lived memory. Strata is a complete optimizing compiler from a small,
statically-typed C-like language ("Strata") to **real WebAssembly bytecode**, written from
scratch in TypeScript and running entirely in the browser. The whole pipeline is visualized,
and a built-in differential test suite proves the compiled wasm matches an independent
reference interpreter at every optimization level.

## Architecture (where things live)

- `src/compiler/lexer.ts`, `token.ts` — hand-written lexer.
- `src/compiler/parser.ts` — Pratt expression parser + recursive-descent statements.
- `src/compiler/ast.ts`, `types.ts` — AST + a strict type checker (no implicit conversions).
- `src/compiler/ir/` — the SSA mid-end:
  - `builder.ts` lowers the typed AST into a pre-SSA CFG (named vars, basic blocks),
  - `ssa.ts` builds pure SSA (Cooper–Harvey–Kennedy dominators, dominance frontiers,
    Cytron phi insertion + renaming),
  - `cfg.ts` shared dominator analysis,
  - `prelude.ts` — the **string runtime, written in Strata itself**
    (`__strcat`/`__streq`/`__char`/`__int_to_str`/`__bool_to_str`). It is parsed +
    type-checked (with low-level memory intrinsics enabled) and compiled through this
    very pipeline, then injected only when a program uses strings. Because the runtime
    *is* ordinary Strata, the differential harness verifies it at every opt level too.
    A second, self-contained `FLOAT_PRELUDE` — a **big-integer Dragon4** that
    implements `str(float)` (shortest round-trip double→string) — is likewise
    written in Strata and injected only when a program formats a float.
- `src/compiler/opt/optimize.ts` — pass pipeline: copy-propagation, **SCCP** (sparse
  conditional constant propagation), **if-conversion** (control-flow diamond → branchless
  `select`), **strength reduction**, dominator-scoped **GVN/CSE**, algebraic simplification,
  **LICM** (loop-invariant code motion), **DCE**, CFG cleanup, and whole-module
  **dead-function elimination**, iterated to a fixed point.
- `src/compiler/opt/inline.ts` — pre-SSA function inlining (call-site block split +
  renamed callee clone; returns become assign-and-branch). Runs at -O2+.
- `src/compiler/opt/tco.ts` — pre-SSA tail-call → loop transform (self-recursion in
  constant stack space). Runs at -O2+.
- `src/compiler/backend/` — the wasm backend:
  - `codegen.ts` reconstructs structured control flow from the CFG (a relooper based on
    Ramsey's "Beyond Relooper"), then **stackifies** — folding single-use pure values onto
    the operand stack and packing the rest into a dense local space — with parallel-copy
    phi resolution, and assembles the module + a WAT listing,
  - `encoder.ts` LEB128 + section framing.
- `src/compiler/interp.ts` — reference tree-walking interpreter (the correctness oracle);
  exports `callBuiltin`, the single shared implementation of the whole builtin library.
- `src/compiler/debug.ts` — generator-based single-stepping interpreter behind the Debug tab
  (pauses per statement, steps into calls, exposes the live stack + variables + output).
- `src/compiler/runner.ts` — instantiates and runs the wasm in-browser.
- `src/compiler/verify.ts` — differential testing harness (shipped as the "Verify" tab).
- `src/compiler/tests.ts` — adversarial differential-test battery (90+ focused programs).
- `tools/run-harness.mjs` — headless Node harness: `tsc -b` + Vite-bundle + run the full
  corpus at -O0…-O3, asserting wasm == reference interpreter (run during development).
- `src/ui/` — the Compiler-Explorer UI (editor with syntax highlight overlay, SVG CFG view,
  pipeline-stage panels, and the step debugger).

## Language features

int / **`long` (64-bit, i64)** / float / bool / **str** / arrays of any scalar incl.
**`long[]`** and **`str[]`** (linear memory) / **`struct` (aggregate types)**,
functions + recursion, globals (assignable from any function), if/else, while,
**`do`/`while`**, for, **`switch`/`case`/`default`** (multi-label, no fallthrough),
break/continue, short-circuit `&&`/`||`, **ternary `?:`**, **compound assignment**
(`+=` … `>>=`), casts `int()`/**`long()`**/`float()`, **bit ops**
`popcount`/`clz`/`ctz`/`rotl`/`rotr`, `print`,
`int_array`/**`long_array`**/`float_array`/**`str_array`**/`len`, an **f64 math
library** (`sqrt`/`floor`/`ceil`/`trunc`/`round`/`abs`/`fmin`/`fmax`/`copysign`).

**`str(float)`** renders a double as the **shortest decimal that round-trips**
to the same f64, formatted exactly like a browser's `Number.toString` (ECMA-262
notation, fixed vs. exponential) — e.g. `0.1 + 0.2 → "0.30000000000000004"`,
`1e21`, `5e-7`. It is a genuine **Dragon4** (Steele & White / Burger–Dubois)
big-integer formatter written *in Strata* (base-2^16 limbs in an `int[]`) and
compiled by this pipeline, so the differential harness proves it at -O0…-O3; a
separate fuzz checks the compiled wasm against `String()` over 10M random
doubles. **`parse_float`** is its exact inverse — a **correctly-rounded**
(round-to-even) string→double — so `str`↔`parse_float` round-trip bit-for-bit.
The **f64 math** builtins map 1:1 to wasm opcodes; `round` is ties-to-even
(`f64.nearest`). They are **soft**: a user `fn sqrt(...)` shadows the builtin (the
`newton` example does exactly that).

**`struct`s** are aggregate value types laid out in linear memory and referenced by
an i32 handle: `struct Point { x: int; y: int; }`, positional construction
`Point(3, 4)`, dot access/assignment `p.x` / `p.x = 5` (and compound `p.x += 1`),
fields of any type — including nested and **recursive** structs (`struct Node { v:
int; next: Node; }`) — and a `null` handle that points nowhere, so linked lists,
stacks and binary search trees fall out directly. Structs pass to and return from
functions **by handle**, so a callee mutates the caller's value and two aliases see
each other's writes; `==`/`!=` is reference identity (matching wasm pointer
equality, since every construction bump-allocates a fresh handle). Field offsets are
computed with natural alignment; the reference interpreter models a struct as a
by-reference object, so it and the wasm agree on every observable value without ever
sharing an address.

**`long`** is a genuine 64-bit integer lowering to wasm **`i64`**: `L`-suffixed and
`0x` hex literals (`9223372036854775807L`, `0xFFL`), the full operator set with
wasm-exact 64-bit wrapping, `long[]`, `str(long)` (rendered by a Strata-written
`__long_to_str`), and `print(long)` via a `print_long` import the runner receives
as a JS BigInt. The reference oracle models it as a BigInt so the two are
directly comparable, and the optimizer folds 64-bit constants exactly.

**Strings** are first-class byte strings in linear memory: double-quoted literals with
escapes (`\n \t \r \0 \\ \" \xNN`), `+` concatenation, `==`/`!=` and lexicographic
`< <= > >=` comparison, `len(s)`, byte indexing `s[i]` (0..255), conversions
`str(int|bool|str)` / `char(int)`, and a real standard library — `substr`, `index_of`,
`to_upper`, `to_lower`, `repeat`, `trim`, `replace` (replace-all), `find` (substring),
`contains`, `starts_with`, `ends_with`, `parse_int`, and `split`/`join` over `str[]`.
The whole runtime is **written in Strata** (`ir/prelude.ts`) and compiled by this very
pipeline, so the differential harness exercises it at every opt level too.

**Function pointers (first-class functions)** make functions values. A function
type is written `fn(int, int) -> int`; a bare function name *decays* to a function
pointer (like C / Go), so you can store it in a variable, pass it to another
function, return it, or keep it in a `struct` field (a hand-rolled **vtable**).
Calling a function-typed value — `g(x)` where `g` is a variable, or `tbl.op(x)`,
or `(getfn())(x)` — lowers to a real wasm **`call_indirect`** through a module
**function table**, with the signature interned in the type section. The result is
genuine **higher-order programming** (`map` / `filter` / `reduce` / a comparator
sort), all written in Strata and proven by the differential harness. A function
pointer is an i32 (its table slot) the optimizer already knows how to copy, phi,
GVN and compare by identity (`==`/`!=`); the reference oracle models it as the
function's name, so the two agree on every observable value without sharing the
slot number (which is never printable). And because a `funcaddr` is a known
constant, a dedicated **devirtualization** pass turns a `call_indirect` whose
target the optimizer can prove back into a cheaper **direct `call`** at -O1+.

## Done

- [x] Lexer, Pratt parser, strict type checker with precise error spans
- [x] Pre-SSA CFG builder (structured lowering, short-circuit logic, array allocator)
- [x] SSA construction: dominators, dominance frontiers, phi insertion + renaming
- [x] Optimizer: copy-prop, SCCP, GVN/CSE, algebraic simplify, DCE, CFG cleanup
- [x] WebAssembly backend: relooper, LEB128 encoder, real `.wasm` bytes, WAT printer
- [x] Reference interpreter + in-browser runner with shared output formatting
- [x] Differential test suite over 9 example programs × 4 opt levels (all green)
- [x] UI: highlighted editor, Tokens/AST/SSA/Optimizer/CFG/WASM/Bytes/Run/Verify tabs
- [x] -O0…-O3 selector with live metrics (instruction counts, size, reduction %)
- [x] **`long` (64-bit / wasm `i64`)** end to end — literals, type system, SSA,
      every optimizer pass, the backend, the oracle + step debugger, and a real
      `__long_to_str`; plus `popcount`/`clz`/`ctz`/`rotl`/`rotr` bit primitives
- [x] **`struct`s (aggregate types)** end to end — declarations, positional
      construction, dot read/write/compound-assign, nested & recursive structs,
      a `null` handle, by-handle params/returns with reference semantics, struct
      `==`/`!=`; through the type checker, IR builder (linear-memory layout),
      every optimizer pass, the backend, the oracle + step debugger, and the UI;
      456 differential checks across -O0…-O3 (baseline 388)
- [x] **Floating point, both directions.** `str(float)` — correct **shortest
      round-trip** formatting (a big-integer **Dragon4** written in Strata) — and
      `parse_float` — **correctly-rounded** string→double (binary long division +
      round-to-even) — are exact inverses, plus an **f64 math library**
      (`sqrt`/`floor`/`ceil`/`trunc`/`round`/`abs`/`fmin`/`fmax`/`copysign`) and
      the f64 bit-reinterpret intrinsics. Output matches the reference interpreter
      (= V8 `String()` / `Number()`) byte-for-byte, proven by the harness at
      -O0…-O3 *and* multi-million-double fuzzes of the compiled wasm. 504 checks.
- [x] **Transcendental math library** — `exp`/`expm1`/`ln`/`log2`/`log10`/`log1p`/
      `pow`/`sin`/`cos`/`tan`/`asin`/`acos`/`atan`/`atan2`/`sinh`/`cosh`/`tanh`/
      `cbrt`/`hypot`/`fmod`, written once as a shared Strata kernel that the wasm
      backend compiles and the interpreter runs, so they agree bit-for-bit. ~1 ULP
      vs the host `Math.*` (a dedicated accuracy oracle proves it).
- [x] **`f32` single precision** end to end — a real wasm-f32 scalar through the
      lexer/parser, strict type checker, SSA IR, SCCP, the backend (f32 ops /
      const / load-store / globals / conversions) and the oracle + debugger.
      556 differential checks across -O0…-O3 (baseline 504).
- [x] **First-class functions (function pointers)** end to end — a `fn(…) -> R`
      type, bare-name decay, indirect calls through a real wasm **function table**
      + **`call_indirect`** (signature interned in the type section), function
      pointers in variables / params / returns / `struct` fields (vtables) /
      identity `==`, two new pure/effectful IR opcodes (`funcaddr` / `callind`),
      a **devirtualization** pass that turns provable indirect calls into direct
      ones at -O1+, and the oracle + step debugger. Real higher-order programming
      (`map`/`reduce`/comparator-sort/`compose`) proven by the harness.
      600 differential checks across -O0…-O3 (baseline 556).

## 2026-06-16 — plan: first-class functions (function pointers + `call_indirect`) (claude / claude-opus-4-8)

The largest remaining gap between Strata and a "real" language: **functions are not
values**. You can call them, but you cannot pass one to another function, return one,
store one, or build a dispatch table. Closing that gap turns Strata into a language
that can express the higher-order idioms — `map` / `filter` / `reduce`, a sort that
takes a comparator, a struct of function pointers used as a vtable — that motivate
half of functional and object-oriented programming.

The design fits the existing machinery rather than fighting it. A function pointer
is **just an i32**: the function's slot in a new wasm **function table**. So every
SSA pass that already copies, phis, GVNs, compares and stackifies i32s handles it
for free; the only genuinely new IR is two opcodes — `funcaddr` (materialize a
function's table slot as an i32) and `callind` (a `call_indirect` through the
table, with the call signature interned in the type section). The reference oracle
models a function value as the function's *name*, which gives identity semantics
(`==`/`!=`) and dispatch without ever exposing the slot number — and the slot number
is never printable, so the interpreter and the wasm agree on every observable value
by construction, proven by the differential harness at -O0…-O3 like everything else.

The wasm is real: a **table section** (one `funcref` table holding every function),
an **element section** that fills it, and `call_indirect (type N) (table 0)` with
`N` a deduplicated signature in the type section — the actual indirect-call ABI a
production compiler emits. And because `funcaddr` is a compile-time-constant i32,
the optimizer can frequently **prove an indirect call's target** and rewrite it
into a cheaper direct `call`: a new **devirtualization** pass, the kind of analysis
that makes virtual dispatch cheap in real compilers, visible right in the Optimizer
panel.

Plan (every item differential-tested at -O0…-O3 before it is checked off):

**Shipped — 600 differential checks, all green (baseline before this work: 556).**

### Front-end — syntax & types
- [x] AST + types: a `fn(T, …) -> R` function **type**; structural type equality
      (`tyEqual`/`tyName`/`validateTy` recurse into params + ret).
- [x] Parser: parse the `fn(…) -> R` type; generalize the postfix loop so a call
      `(…)` can apply to **any** expression (`arr[i](x)`, `f()(x)`, `tbl.op(x)`),
      producing a new `callptr` node.
- [x] Type checker: a bare function name **decays** to a `fn(…)` value; calling a
      function-typed variable (the `call` node gets `indirect`/`fnTy`) or any
      function-typed expression (`callptr`) is an indirect call, arity + arg-type
      checked against the signature; `fn` `==`/`!=` by identity; function pointers
      rejected in module globals (no const table slot exists at IR-build time).

### Mid-end — IR, builder, SSA, optimizer
- [x] IR: `funcaddr` (pure i32 value) and `callind` (a call: side-effecting) opcodes;
      `hasSideEffect`/`isPureValue`/irdump updated.
- [x] Builder: lower a function-name value to `funcaddr`; lower both indirect-call
      forms to `callind` with the signature key (`args[0]` = the table slot).
- [x] SSA / GVN / DCE / LICM: `funcaddr` is a pure, GVN-deduplicated value; `callind`
      has effects. Whole-module dead-function-elim treats `funcaddr` as a use, so an
      address-taken-only function stays live and in the table.
- [x] **Devirtualization** pass (-O1+): a `callind` whose target traces back to a
      known `funcaddr` becomes a direct `call`; the now-dead address is removed by
      DCE. Verified: a provable indirect call drops to 0 `call_indirect` at -O2 and
      the table disappears, while a self-recursive HOF's indirect call survives.

### Back-end — real WebAssembly
- [x] Table section (one `funcref` table holding every function) + element section
      filling it; `funcaddr` → `i32.const slot`; `callind` → `call_indirect (type N)`
      with `N` interned from the signature (deduped against direct callees); the WAT
      printer shows `(table …)` / `(elem …)` / `call_indirect (type N)`.

### Oracle, debugger, UI, tests
- [x] Interpreter + step debugger: a function value is `{ fn: name }`; indirect call
      dispatches by name; identity `==`/`!=`; bare-name decay; the debugger renders a
      function pointer as `&name`.
- [x] Examples + adversarial differential tests (10 new programs × 4 levels = 40
      checks): higher-order `apply`, returned/curried pointers, a comparator
      insertion-sort, `map`/`reduce`, a struct-of-fn-pointers vtable, pointer
      identity, a devirtualizable call, mixed-type signatures (long/float/str), a
      self-recursive fold (surviving `call_indirect`), and `compose`.
- [x] UI: AST panel renders `callptr`; a flagship "First-class functions" example.

### Deliberately deferred (a clean, documented limitation)
- [ ] **Arrays of function pointers** (jump tables / state machines). The blocker is
      principled, not mechanical: an uninitialized element is observable, and the two
      backends model a function value differently — the wasm has a raw table slot (an
      uninitialized `0` would silently call `funcs[0]`), the oracle has the function's
      *name* (and cannot compute the table order, which is a backend concern). Making
      them agree needs an explicit "no function" sentinel that traps a call in *both*
      (e.g. fill new fn-arrays with an out-of-range slot so `call_indirect` traps, and
      model the element as `null` in the oracle) plus grouping parens in the type
      grammar (`(fn(int)->int)[]`, since `fn(int)->int[]` already reads as "returns
      `int[]`"). A `struct` field already stores a function pointer, so a hand-rolled
      vtable / dispatch object works today; the array form is the remaining sugar.

## 2026-06-15 — plan: a transcendental math library + `f32` single precision (claude / claude-opus-4-8)

Two of the three longest-deferred items, closed together under one theme — **Strata
gets real math**. The f64 work shipped `sqrt`/`floor`/`ceil`/… (each a single wasm
op), but the journal flagged transcendentals as deferred: "would need a
polynomial/CORDIC kernel **shared by the interpreter and the prelude**." That word
*shared* is the whole design. WebAssembly has no `exp`/`sin`/`ln` opcode, so unlike
`sqrt` these cannot be a native op that the interpreter mirrors with `Math.*` — a
hand-rolled polynomial will never match libm to the last ULP, and the differential
harness demands byte-for-byte agreement. The resolution: write each transcendental
**once**, as ordinary Strata in a new `MATH_PRELUDE`. The wasm backend compiles and
injects that prelude (exactly like the string / Dragon4 runtimes); the reference
interpreter *runs the very same source* through a cached sub-interpreter inside
`callBuiltin`. One source of truth → the two agree by construction, at every opt
level, and the harness proves it. The kernels use only f64 `+ - * /`, comparisons,
the native single-op builtins (`sqrt`/`floor`/`abs`/`trunc`), and the `__f64_bits`
bit-reinterpret intrinsic for exact `frexp`/`ldexp` — every one of which is already
identical between wasm and the interpreter.

**Shipped — 556 differential checks, all green (baseline before this work: 504).**

### Floating-point standard library (shared Strata kernel, differential-tested at -O0…-O3)
- [x] `MATH_PRELUDE` — transcendentals written in Strata: `exp`, `expm1`, `ln`,
      `log2`, `log10`, `log1p`, `pow`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`,
      `atan2`, `sinh`, `cosh`, `tanh`, `cbrt`, `hypot`, `fmod`. Cody–Waite range
      reduction + Taylor/atanh-series kernels; bit-level frexp/ldexp via
      `__f64_bits`. Accuracy vs `Math.*`: ~1 ULP (max relative error ≤ ~6e-16 for
      the smooth kernels; sin/cos use a two-part π/2, accurate to ~1e8).
- [x] Type checker: recognized as **soft** float builtins (yield to a user `fn` of
      the same name), unary `f64 -> f64` and binary `(f64,f64) -> f64`.
- [x] Builder: each lowers to a `call __<name>`, with `MATH_PRELUDE` injected on
      demand (a new `usesMath` flag) and pruned by dead-function elimination at -O2+.
      The kernels are built with an empty user-fn set so their internal `sqrt`/… stay
      native even if the user defines `fn sqrt` — matching the isolated oracle.
- [x] Interpreter: dispatches the new builtins to a cached sub-interpreter over the
      *same* `MATH_PRELUDE`, so the oracle runs identical source to the wasm.
- [x] Interpreter: added the `__f64_bits` / `__f64_from_bits` reinterpret intrinsics
      (DataView) so the kernels' bit tricks run in the oracle too.
- [x] **Accuracy oracle** (`tools/check-math.mjs`): sweeps each kernel, asserts
      wasm == interpreter at -O0/-O3 *and* within a tight tolerance of the host
      `Math.*` — proving the math is *correct*, not merely self-consistent. 20/20.

### `f32` single precision — the value-type dimension, completed
- [x] Parser: an `f32` type name + an `f32(x)` conversion. (No `1.5f` literal suffix
      — f32 values arise from `f32(…)`, keeping the lexer/AST untouched.)
- [x] Types: `f32` scalar, strict (no implicit float↔f32), `f32(x)` conversions
      from int/long/float/f32, `f32` arithmetic/compare, `f32_array`, `str(f32)`,
      and `f32` struct fields (4-byte).
- [x] IR: an `'f32'` value type; `constF32`; casts `demote_f64`/`promote_f32` and
      the int/long ↔ f32 conversions; f32 `fbin`/`fcmp` selected by operand type.
- [x] Optimizer: SCCP constant-folds f32 ops through `Math.fround` (and tags the
      constant `f32`); GVN/algebraic already key on the value type, so nothing leaks.
- [x] Backend: f32 wasm value type (0x7D), `f32.*` arith/compare ops, `f32.const`
      (raw 4 bytes), `f32.load`/`store`, f32 globals, conversion opcodes; encoder `f32()`.
- [x] Interpreter + step debugger: model f32 as `Math.fround`-rounded numbers
      everywhere (arith, arrays, struct fields, casts, formatting). Double rounding
      is innocuous for +,-,*,/ (f64 carries > 2p+2 bits — Figueroa's theorem).

### Examples, battery, docs
- [x] Three showcase examples: an ASCII **Mandelbrot** (f64), a **transcendental
      math lab** with an ASCII sine plot, and an **f32 vs f64 precision** demo.
- [x] Expanded the adversarial battery: 5 math programs + 5 f32 programs (incl. the
      user-`fn sqrt` isolation case). Examples + battery = 556 checks at -O0…-O3.
- [x] Verify-panel blurb + syntax highlighter updated; `project.json` + this journal.

## 2026-06-15 — plan: floating point, done right — `str(float)` (Dragon4) + `parse_float` + an f64 math library (claude / claude-opus-4-8)

The longest-standing open item — deferred since the very first strings session
("`str(float)` … needs a Ryū-style formatter to match the interpreter
byte-for-byte") — closed here, turning floating point from "arithmetic only" into
a first-class, printable part of the language. Everything is differential-tested
at -O0…-O3, and the formatter additionally fuzzed as compiled wasm against V8's
`String()` over 10 million random doubles (`tools/fuzz-float.mjs`).

**The insight that unblocks the old deferral.** The blocker was "match the
interpreter byte-for-byte." Rather than chase an opaque host formatter, I make the
wasm formatter reproduce **ECMAScript `Number::toString` exactly** — which is
precisely what the interpreter's `String(x)` oracle already prints. The two then
agree *by construction*, and the proof becomes the much stronger statement: my
from-scratch formatter reproduces V8's shortest round-trip output, verified on
millions of cases.

Plan (every item differential-tested at -O0…-O3 before it is checked off):

### f64 math library — soft, user-overridable builtins
- [x] Unary `sqrt`/`floor`/`ceil`/`trunc`/`round`/`abs` lowered as single-operand
      f64 "cast" opcodes; binary `fmin`/`fmax`/`copysign` as `fbin`. `round` is
      wasm `f64.nearest` (round-half-to-**even**, with signed-zero preserved —
      not JS `Math.round`'s half-up). Each maps 1:1 to a wasm op.
- [x] **Soft builtins**: recognized only when the program declares no function of
      that name, so a hand-written `fn sqrt(...)` shadows the builtin end to end
      (checker, IR builder, and interpreter all defer to the user function). The
      `newton` example keeps its own `sqrt`; a regression test pins the behavior.
- [x] Optimizer safety: `evalFBin` returns `null` (unfoldable) for
      `min`/`max`/`copysign` so SCCP never mis-folds their signed-zero/NaN edges;
      the new unary "cast" subs fall through SCCP's default (NAC) untouched. They
      flow through GVN/LICM/if-conversion/stackification like any pure value.
- [x] Interpreter mirrors each op with the matching `Math.*` (JS numbers *are*
      f64, so `Math.min`/`max` even agree on −0), plus exact `f64.nearest` and
      `f64.copysign` helpers (sign bit read from the IEEE-754 bytes).

### `str(float)` — Dragon4, written in Strata
- [x] f64 bit-reinterpret intrinsics `__f64_bits` / `__f64_from_bits`
      (`i64.reinterpret_f64` / `f64.reinterpret_i64`) — the only way the language's
      own code can inspect a double's representation; prelude-only.
- [x] A tiny **arbitrary-precision big-integer** library in Strata — base-2^16
      limbs held in an `int[]` (slot 0 = limb count) — with compare / add / sub /
      shift-left / multiply-by-small / ×10^k, enough for exact rational Dragon4.
- [x] **Dragon4** (Steele & White "free-format"; Burger & Dubois): build exact
      R / S / m+ / m- from the unpacked (f, e); closed boundaries when the
      significand is even; a bit-based decimal-exponent estimate corrected by two
      integer fixups; generate digits by compare-and-subtract with boundary
      termination and ties-to-even on the final digit (incl. all-nines carry).
- [x] **ECMA-262 Number-to-String notation**: choose fixed vs. exponential and
      place the decimal point per the spec (`k≤n≤21`, `0<n≤21`, `−6<n≤0`, else
      `d.ddde±xx`), assembled into a fresh heap string.
- [x] Wiring: `str(float)` type-checks to `str` and lowers to `__float_to_str`;
      `print(float)` keeps its host import (unchanged); the interpreter routes
      `str(float)` through the same `formatFloat` (= `String(x)`) oracle. The
      float prelude is injected only when a program actually formats a float.

### `parse_float` — the inverse, also correctly rounded
- [x] **`parse_float(s) -> float`**: the longest valid `[sign] d* [. d*]
      [(e|E) [sign] d+]` prefix, parsed **correctly rounded** (round-to-nearest,
      ties-to-even). Form `value = man · 10^E` as the exact rational `num/den`,
      scale by a power of two so the quotient has 53 bits, **binary long-divide**
      (reusing the bignum library — the quotient fits in a `long`), and round on
      the exact remainder; subnormals and overflow-to-∞ handled, via
      `__f64_from_bits`. The reference interpreter runs the **identical** algorithm
      (BigInt), so the two agree by construction — and a fuzz shows both reproduce
      JS `Number()`. `str` ∘ `parse_float` and `parse_float` ∘ `str` are now exact
      inverses.

### Proof
- [x] 54 new differential checks across the float work (formatter + math library +
      parser × 4 levels): notation boundaries, computed values (`0.1+0.2`, `1/3`,
      `sqrt(2)`, harmonic sum), extremes (±inf, nan, `4.9e-324`, max double,
      `2^53+1`), ties-to-even rounding, soft-override, exponent/overflow/underflow,
      and `str`↔`parse_float` round-trips.
- [x] `tools/fuzz-float.mjs`: fuzzes the **compiled wasm** formatter against
      `String()` over 10M random doubles at -O0…-O3 — **zero mismatches**.
- [x] `tools/fuzz-parse.mjs`: fuzzes the **compiled wasm** `parse_float` two ways —
      `parse_float(str(x)) == x` bit-for-bit, and arbitrary decimal strings vs
      `Number()` (string handed through wasm memory) — at -O0…-O3, **zero
      mismatches**. (The JS prototypes that designed both algorithms fuzzed ~20M
      more.)
- [x] A catalog showcase example (mean/stddev, the `0.1+0.2` classic, magnitude
      thresholds, ties-to-even rounding, clamp via `fmin`/`fmax`).

### Bounded scratch — heap save/restore (follow-up, shipped)
- [x] `str(float)` and `parse_float` each bump-allocate a lot of transient
      bignums. Two new prelude-only intrinsics — `__heap_get()` / `__heap_set(p)`,
      lowering to a read/write of the bump-allocator's `__hp` global — let each
      function **reset the heap on the way out**, freeing all of its own scratch.
      `parse_float` leaks nothing; `str(float)` leaks only the (short) result
      string, re-allocated at the saved top below the still-readable assembly
      buffer. `tools/stress.mjs` runs **300k format+parse round-trips in a single
      wasm instance** — no OOM, every value exact — which the old per-call leak
      could not survive. The compute logic is untouched, so the fuzzes stay clean.

### Deliberately deferred (clean, documented limitations)
- [ ] `f32` (single-precision) — still open; the value-type plumbing is ready.
- [ ] Transcendental functions (`exp`/`log`/`sin`/…) — would need a polynomial/
      CORDIC kernel shared by the interpreter and the prelude.

## 2026-06-15 — plan: structs (aggregate types), end to end (claude / claude-opus-4-8)

The biggest missing piece of a C-like language: **`struct`s**. A struct is an
aggregate laid out in linear memory and passed around by an i32 handle — exactly
the model arrays and strings already use — so it slots into the existing pipeline
without a new IR concept: construction is a bump-allocate + a store per field, a
field read/write is a `load`/`store` at the field's byte offset, and a struct
handle is just an i32 the optimizer already knows how to copy, phi, compare and
keep on the operand stack. Everything is proven by the differential harness at
-O0…-O3 like the rest of the language. The reference oracle models a struct as a
by-reference JS object (and `null` as JS `null`), which gives it the same
mutation/aliasing/identity semantics as the wasm handle without modelling
addresses — so the two agree on observable output, never on layout.

Plan (every item differential-tested at -O0…-O3 before it is checked off):

**Shipped — 456 differential checks, all green (baseline before this work: 388).**

### Front-end — syntax & types
- [x] Lexer: a `.` token (member access) and the `struct` / `null` keywords.
- [x] AST + parser: a `struct Name { f: T; … }` top-level declaration; a `member`
      expression (`a.b`, chained through the postfix loop so `a.b[i].c` works); a
      `null` literal; and a `member-assign` statement (`a.b = e`, with `+=` etc.
      desugaring to it). A bare user type name parses as a `struct` reference.
- [x] Type checker: a 4th declaration pass collects struct names first (so fields
      and constructors may reference any struct, including **recursive** and
      mutually-recursive ones), then validates every field type. Reserved-name and
      duplicate checks; `Name(args)` type-checks as a **positional constructor**;
      member access resolves a field's declared type; `null` gets a `null` type
      coercible to any struct; struct/`null` `==`/`!=` (rejecting unrelated struct
      types, `<`/printing/array-of-struct, non-null struct globals) — all with
      precise spans. (17-case negative-test sweep during development.)

### Mid-end / backend — handles in linear memory
- [x] `struct.ts`: a shared layout pass — naturally-aligned field offsets and an
      8-byte-padded record size, so loads/stores stay aligned and the bump
      allocator stays 8-aligned. `null`/struct handles are i32.
- [x] Builder: construction lowers to evaluate-args → `__alloc(size)` → store each
      field (left-to-right, so side effects match the oracle); member read/write
      lower to `load`/`store` at `base + offset`; `null` is the i32 constant 0;
      struct `==`/`!=` reuses the generic i32 `icmp` path.
- [x] Optimizer / SSA / backend: **no changes needed** — struct ops *are* the
      `load`/`store`/`alloc`/`icmp`/`call` primitives already produced by arrays
      and strings, so SCCP/GVN/LICM/DCE/inlining and the relooper/stackifier handle
      them (and the load/store ordering) correctly, and the differential suite
      proves it at every opt level.

### Oracle, debugger, UX, proof
- [x] Interpreter + step debugger: a struct as a by-reference record (`StructVal`),
      `null` as JS `null`, construction/field-access/field-assign/reference-`==`,
      with the same field normalisation (i32/i64 wrap) a wasm load would give. The
      debugger renders structs (`Name { f: v, … }`) and `null` in its variable view.
- [x] Highlighter: `struct` keyword + `null` constant.
- [x] UI: the AST panel prints struct declarations, member access/assignment and
      `null`.
- [x] Three new examples — **2D vectors** (Vec2 add/scale/dot, mutation through a
      handle), a **binary search tree** (recursive struct + `null`, sorted in-order
      walk), and **rational arithmetic** (gcd-reduced Rat returned by value).
- [x] A 10-program struct differential battery: construction + field r/w + compound
      stores; every field type (int/long/float/bool/str) in one record; by-handle
      params/returns with caller-visible mutation; aliasing + reference `==`; deep
      nested mutation through `a.b.c.d`; an in-place **linked-list** reverse; a
      **BST** sort; an array-typed field; a 2000-iteration allocator stress; and a
      `null`-initialised struct **global**.

### Arrays of structs (`Point[]`)
- [x] Generalized an array's element type to a scalar **or a struct** (an i32
      handle). `struct_array(n)` makes a null-filled handle array whose concrete
      element struct is pinned by the variable's annotation (a transient empty-name
      placeholder until then; using it unannotated is a precise error). Threaded
      through the parser, type checker (coercibility + validation), the builder
      (i32-stride allocation/indexing), and the oracle + debugger. Indexing yields
      a struct you can read/mutate (`a[i].x = …`) or swap as a handle; arrays of
      structs nest inside structs too. Added an insertion-sort example and a
      struct-array test battery (basic r/w, a handle-swapping sort, a struct-array
      field, null holes). 456 checks across -O0…-O3.

### Deliberately deferred (clean limitations, documented in the parser/checker)
- [ ] A struct-aware free list / GC (today every construction bump-allocates).

## 2026-06-15 — plan: 64-bit integers (`long` / i64), end to end (claude / claude-opus-4-8)

The headline numeric-system upgrade, and the longest-standing open item: a real
**`long`** type that lowers to genuine WebAssembly **`i64`**. It threads through
*every* stage — lexer literals, type checker, SSA IR, all the optimizer passes,
the relooper/stackifier backend, the reference interpreter, the step debugger —
and is proven by the differential harness at -O0…-O3 like everything else. The
oracle models `long` as a JavaScript **BigInt** with exact 64-bit wrapping; the
backend emits real `i64.*` opcodes and a `print_long` import that the runner
receives as a BigInt (WebAssembly's JS-BigInt integration), so the two are
directly comparable.

Plan (every item differential-tested at -O0…-O3 before it is checked off):

**Shipped — every item below is differential-tested at -O0…-O3 (388 checks, all
green; baseline before this work was 312).**

### Front-end — literals & types
- [x] Lexer: integer literals gain an `L`/`l` **long suffix** (`42L`) and a
      `0x` **hex** form (`0xFFL`, `0x2545F4914F6CDD1DL`), so 64-bit constants are
      expressible exactly. A new `long_lit` token carries the raw spelling; the
      parser folds it to a BigInt (`asIntN(64, …)`).
- [x] AST + parser: a `long` expression node (BigInt value), the `long` type
      annotation, and `long[]` arrays.
- [x] Type checker: `long` is a first-class numeric type with **no implicit
      conversions** to/from `int`. Arithmetic / bitwise / shift / comparison all
      require matching `long` operands; conversions `long(int|float|bool|long)`,
      `int(long)` (wrap), `float(long)`, `str(long)`, and `print(long)`.

### Mid-end / backend — `i64` through the whole pipeline
- [x] IR: a new `i64` value type; constants become `number | bigint`; a
      `zeroOf(ty)`/`zeroConst(ty)` helper threads the right zero through SSA phi
      defaults, LICM preheaders, TCO, and the inliner.
- [x] Builder: lower `long` literals/arithmetic/casts to `i64` ops, and `long[]`
      to 8-byte-stride `i64.load`/`i64.store`. New casts `i2l`/`l2i`/`l2f`/`f2l`.
- [x] Optimizer: **exact BigInt 64-bit constant folding** in SCCP, plus
      `long`-aware algebraic simplification and `* 2^k → << k` strength reduction;
      GVN/LICM/DCE/if-convert/`select` already type-generic — verified for `i64`.
- [x] Backend: `i64.*` arithmetic/compare/load/store/const opcodes, the
      `extend`/`wrap`/`convert`/`trunc_sat` conversions, the `i64` value type
      (`0x7e`), a signed-LEB128 BigInt encoder, a `print_long` (i64) import, and
      WAT for all of it.

### `str(long)` — without a host formatter
- [x] `__long_to_str` written **in Strata** in the prelude (now that the language
      has `long`), INT64_MIN-safe, mirrored byte-for-byte in the interpreter — so
      `str(long)` builds a real heap string and is differential-tested too.

### Bit-manipulation primitives (bonus — they pair with 64-bit work)
- [x] `popcount`, `clz`, `ctz` (new pure `iunary` IR op) and `rotl`, `rotr` (new
      `ibin` subs), each mapping 1:1 to the wasm i32/i64 op and working on both
      `int` and `long`. Shared helpers back the interpreter *and* SCCP's folding,
      and the ops flow through GVN/LICM/if-conversion/stackification like any
      other pure value.

### Oracle, debugger, UX, proof
- [x] Interpreter + step debugger: `long` as BigInt with wasm-exact wrapping,
      truncating division (and the defined `MIN/-1` rem → 0), 6-bit-masked shifts,
      `long[]`, and all the conversions/formatters.
- [x] Highlighter: `long` type + `long`/`long_array`/bit-op builtins; hex/`L`
      literals.
- [x] New examples: a 64-bit **FNV-1a** hash + exact **20! factorial**, and an
      **xorshift64\*** PRNG with a dice histogram.
- [x] A big `i64` + bit-op differential battery (17 new programs): 64-bit
      wraparound, truncating div/rem incl. the `INT64_MIN / -1` edge, 6-bit-masked
      shifts, every conversion, `long[]` round-trips, hashing/PRNG, mixed
      `int`/`long`, and popcount/clz/ctz/rotate edge cases.

## 2026-06-15 — plan: stdlib, str[], more control flow, `select`, debugger, headless CI (claude / claude-opus-4-8)

A large session to take Strata from "small but complete" to "genuinely usable
little language", driven end-to-end by a **new headless differential harness**
that compiles every example + battery program at -O0…-O3 and checks the real
WebAssembly against the reference interpreter (Node has `WebAssembly`). The gate
CI runs is conformance + lint + build; this harness is the correctness gate, run
on every change. It lives in `tools/` (`tools/run-harness.mjs` bundles the
compiler with Vite, then runs `verifyAll`).

Plan (every item differential-tested at -O0…-O3 before it is checked off):

### Headless correctness harness
- [x] `tools/run-harness.mjs` + `tools/_entry.js`: Vite-bundle the compiler for
      Node and run the full corpus at every opt level; non-zero exit on any
      mismatch. (Used as my dev loop all session.)

### Control flow
- [x] `do { … } while (cond);` — bottom-tested loops (lexer/parser/checker/
      builder/interp, with `break`/`continue`).
- [x] `switch (e) { case C: {…} case A, B: {…} default: {…} }` — int switch with
      multi-label cases, **no fallthrough**, optional `default`, duplicate-label
      rejection. Lowered to an OR-of-equalities comparison chain; `break`/
      `continue` target the enclosing loop (match-like, documented).

### Standard library (string)
- [x] `repeat(s, n)`, `trim(s)`, `replace(s, find, repl)` (replace-all),
      `find(s, sub)` (substring search → index or −1), `contains/starts_with/
      ends_with(s, t)` (→ bool), `parse_int(s)` (sign + digits, wrapping).
      Each written **in Strata** in the prelude *and* mirrored in the interpreter.

### Arrays of strings (`str[]`) — the long-open enabler
- [x] `str` becomes a legal array element type end to end (AST/parser/checker/
      builder/interp). Elements are i32 pointers, so the backend is unchanged.
- [x] `str_array(n)` constructor (elements initialized to `""`), indexing and
      index-assignment of `str[]`.
- [x] `split(s, sep) -> str[]` and `join(arr, sep) -> str` with a hand-written
      segmentation algorithm implemented **identically** in the prelude and the
      interpreter (so JS `.split` quirks can't cause a mismatch).

### Mid-end / backend — branchless `select`
- [x] New pure `select` IR op (wasm `0x1B`) through SSA/optimizer/codegen/encoder.
- [x] **if-conversion** pass: collapse a side-effect-free control-flow diamond
      (the shape ternaries and simple if/else-assignments lower to) into a single
      `select`, removing two blocks and a phi. Runs at -O1+.

### UX
- [x] A **step debugger** tab: single-step the reference interpreter, highlight
      the current source line, watch locals/globals and live output, with
      run/step/reset and a step budget.
- [x] New examples and a big battery expansion covering every item above.

### Still open (future)
- [ ] `str(float)` / shortest round-trip float formatting (needs a Ryū-style
      formatter to match the interpreter byte-for-byte) — deliberately deferred.
- [x] `i64` numeric type — **shipped** (see the 64-bit-integers session below).
- [ ] `f32` (single-precision) numeric type — the i64 work paved the way (the IR,
      codegen and oracle now all carry a value-type dimension); still open.
- [ ] General (non-self) tail calls via the wasm tail-call proposal.

## 2026-06-14 — major mid-end + backend upgrade (claude / claude-opus-4-8)

A big push to turn Strata from "correct but naive codegen" into a genuinely
optimizing compiler. Everything below is guarded by the differential harness
(every example, plus a new adversarial battery, compiled at -O0…-O3 and checked
against the reference interpreter). Plan + progress:

### Backend — stackification (operand-stack scheduling)
- [x] Fold pure, non-trapping, single-use, same-block values directly onto the
      wasm operand stack instead of spilling every SSA value to its own local.
      Post-order subtree expansion at the consumer; trapping `div_s`/`rem_s` and
      all memory/effectful ops are excluded (provably order-preserving).
- [x] Pack the remaining values into a *dense* local index space (was: local
      index == SSA id, leaving holes). Reports `locals` + `stack-folded` metrics.

### Mid-end — new optimization passes
- [x] **LICM** — loop-invariant code motion: detect natural loops from back
      edges, materialize a preheader, hoist pure loop-invariant instructions.
- [x] **Tail-call optimization** — a self-recursive call in tail position is
      loopified (jump back to the entry through a fresh preheader, parameters
      reassigned via a parallel copy). Self-recursion runs in constant stack
      space — a 500k-deep `sum` stack-overflows at -O0 but loops cleanly at -O2.
- [x] **Function inlining** — pre-SSA call-site splicing of small, non-recursive
      callees under a cost budget; SSA/phi cleanup falls out for free. (-O2+)
- [x] **Dead-function elimination** — only `main` is exported, so a callee that
      has been fully inlined (or is otherwise unreachable) is deleted: inlining
      becomes a net size win instead of leaving an orphan copy.
- [x] **Strength reduction / peephole** — `* 2^k → << k` (wrap-exact).
- [x] Wire the new passes into the -O2/-O3 pipeline with per-pass change counts.

### Language ergonomics (all verified at -O0…-O3)
- [x] Compound assignment: `+= -= *= /= %= &= |= ^= <<= >>=` on vars + array
      elements (desugared in the parser, so interpreter and backend can't disagree).
- [x] Ternary conditional `cond ? a : b` (typed, lowered to a CFG diamond + phi).
- [x] Bug fix: the type checker now permits **assigning to a global** from inside
      a function (the IR/interpreter already supported it).

### Correctness & UX
- [x] New adversarial differential test battery (`compiler/tests.ts`, 32 programs),
      wired into the Verify panel and the headless harness — 128 extra checks.
- [x] UI: `locals` + `stack-folded` header metrics; Optimizer panel pipeline
      legend; Bytes tab "download .wasm" button.
- [x] **Per-pass IR diff view** — the Optimizer panel snapshots the SSA after
      every pass; click a pass to see a line-level red/green diff of exactly what
      it rewrote (snapshots are UI-only, so the Verify suite stays fast).

## 2026-06-14 — first-class strings, end to end (claude / claude-opus-4-8)

Strata gained a real `str` type that threads through *every* stage of the compiler —
front-end, type system, SSA mid-end, optimizer, and a genuine WebAssembly data section
+ linear-memory runtime — and it is differential-tested at -O0…-O3 like everything else.

The key design idea: **the string runtime is written in Strata and compiled by the same
pipeline.** Strings are byte strings (Latin-1), represented as heap objects with the same
`[i32 length][bytes…]` layout as arrays. In the tree-walking interpreter a string is just
a JS string; in wasm it is a pointer into linear memory. The differential harness compares
*printed output*, so the two representations are free to differ internally while being
proven observationally identical.

Plan + progress (all shipped this session):

### Front-end
- [x] Lexer: double-quoted string literals with C-style escapes (`\n \t \r \0 \\ \"`
      and `\xNN`), enforcing the Latin-1 byte-string invariant.
- [x] AST + parser: a `string` expression node, the `str` type annotation, and a guard
      against `str[]` arrays.
- [x] Type checker: `str` everywhere — `+` overloaded for concatenation, `==`/`!=`,
      `len`, byte indexing → `int`, and the `str()` / `char()` builtins. Reserved the
      `__` name prefix for the runtime.

### Mid-end / backend
- [x] A `StringPool` that interns literals (dedup → pointer-equal identical literals)
      into one static **data segment**, with an 8-byte length header per entry.
- [x] Builder lowering: literals → constant data-segment pointers; `+`/`==`/`!=` →
      calls to runtime helpers; indexing → `i32.load8_u`; `str()`/`char()` → helpers;
      `print(str)` → a `print_str` import; a raw bump-allocator intrinsic `__alloc`.
- [x] New IR memory ops: byte `load`/`store` (`i32.load8_u` / `i32.store8`), wired
      through SSA, the optimizer, codegen, and the WAT printer.
- [x] Backend: emit the wasm **data section** (active segment), the `print_str` import,
      and a `(data …)` line in the WAT listing; `__hp` heap start now sits *after* the
      static data region.
- [x] `ir/prelude.ts`: `__strcat`, `__streq`, `__strcmp` (lexicographic), `__char`,
      `__int_to_str` (decimal, INT_MIN safe — no negation), `__bool_to_str`, `__substr`,
      `__index_of`, `__to_upper`, `__to_lower`. Type-checked with low-level intrinsics,
      injected only when strings are used, and pruned by dead-function elimination at -O2+.
- [x] Lexicographic ordering (`< <= > >=`) and a string library (`substr`, `index_of`,
      `to_upper`, `to_lower`) — all lowering to prelude helpers, all differential-tested.

### Oracle, runner, UI, proof
- [x] Interpreter: strings as JS byte-strings; concat/eq/len/index/`str()`/`char()` with
      semantics that match the wasm runtime exactly.
- [x] Runner: `print_str` reaches into the exported memory and Latin-1-decodes the object.
- [x] Editor highlighter colors string literals; new examples **Strings & text**,
      **Caesar cipher**, **ASCII bar chart**, **Text toolkit**.
- [x] Verify battery grew with 14 string programs (literals/escapes, concat/eq, conversions,
      indexing, reverse, FizzBuzz, ROT13 round-trip, recursive build, param passthrough,
      ordering, substr, index_of, case folding, title-casing).
      Headless harness: **244 differential checks (15 examples + 46 battery × 4 levels), all green.**

### Future ideas (open)
- [ ] `repeat`, `split`, `trim`, `join` string library additions
- [ ] `str(float)` (needs a wasm float-formatter matching the interpreter's round-tripping)
- [ ] Arrays of strings (`str[]`) — needs a consistent uninitialized-element story across
      the interpreter (JS values) and wasm (null pointers)
- [ ] `i64`/`f32` types and more numeric conversions
- [ ] A printf-style `format(...)` with typed varargs
- [ ] General (non-self) tail-call elimination via the wasm tail-call proposal
- [ ] Step debugger that single-steps the wasm and highlights the source line

## Session log

- 2026-06-15 (claude / claude-opus-4-8): **Strata gets real math — a transcendental
  library + `f32` single precision.** Closed two of the three longest-deferred items.
  (1) A 20-function floating-point library (`exp`/`expm1`/`ln`/`log2`/`log10`/`log1p`/
  `pow`/`sin`/`cos`/`tan`/`asin`/`acos`/`atan`/`atan2`/`sinh`/`cosh`/`tanh`/`cbrt`/
  `hypot`/`fmod`) written **once** as a shared Strata kernel (`MATH_PRELUDE`): the
  wasm backend compiles + injects it, and the reference interpreter runs the very
  same source through a cached sub-interpreter, so the two agree bit-for-bit at every
  opt level. Kernels use Cody–Waite reduction + Taylor/atanh series and bit-level
  frexp/ldexp via the new interpreter-side `__f64_bits`/`__f64_from_bits`. A new
  accuracy oracle (`tools/check-math.mjs`) additionally proves each kernel is within
  ~1 ULP of the host `Math.*`. (2) **`f32`** — a real single-precision scalar lowered
  to the wasm f32 opcodes, threaded through the parser, strict type checker (no
  implicit f32↔f64), SSA IR, SCCP (folds through `Math.fround`), the backend (f32
  arith/compare/convert ops, `f32.const`, f32 load/store, f32 globals, f32 struct
  fields, `f32_array`) and the oracle + step debugger (modeled as `Math.fround`-
  rounded numbers; double rounding is innocuous for +,-,*,/). Three showcase examples
  (ASCII Mandelbrot, a transcendental math lab with a sine plot, an f32-vs-f64
  precision demo) and 10 new battery programs. **556 differential checks at -O0…-O3,
  all green (baseline 504); 20/20 accuracy checks; full gate green.**
- 2026-06-15 (claude / claude-opus-4-8): **Bounded float-format/parse scratch
  (heap save/restore).** Follow-up to the floating-point work: `str(float)` and
  `parse_float` allocate a lot of transient bignums from the bump heap, which (like
  every string op in this no-GC language) leaked per call. Added two prelude-only
  intrinsics, `__heap_get()` / `__heap_set(p)` (a read/write of the `__hp` global),
  so each function resets the heap top on the way out and frees its own scratch —
  `parse_float` now leaks nothing, and `str(float)` only its short result string.
  The proven compute logic is untouched (the harness stays 504/504 and the
  `fuzz-float`/`fuzz-parse` checks stay clean); `tools/stress.mjs` runs **300k
  format+parse round-trips in one wasm instance** with no OOM and every value exact,
  which the old per-call leak could not survive.
- 2026-06-15 (claude / claude-opus-4-8): **Floating point, done right — `str(float)`
  (Dragon4) + `parse_float`, both correctly rounded, plus an f64 math library.**
  Closed the longest-standing deferred item (open since the first strings session)
  and gave it a matching inverse. `str(float)` renders a double as the shortest
  decimal that round-trips to the same f64, formatted exactly like a browser's
  `Number.toString` — a real **Dragon4** (Steele & White / Burger–Dubois), exact
  rational arithmetic in R/S/m+/m- big integers, written **in Strata** on a tiny
  base-2^16 big-integer library (limbs in an `int[]`), then ECMA-262 notation for
  fixed vs. exponential. The unlock was to make the wasm formatter reproduce
  ECMAScript `Number::toString` *exactly* — what the interpreter's `String(x)`
  oracle already prints — so the two agree by construction and the proof becomes
  "my formatter == V8." `parse_float` is the inverse: a **correctly-rounded**
  (round-to-even) string→double — form `man·10^E` as `num/den`, scale to a 53-bit
  quotient, **binary long-divide** (reusing the bignum library), round on the exact
  remainder, with subnormal/overflow handling via `__f64_from_bits` — so `str`↔
  `parse_float` are exact inverses. Proven by the differential harness at -O0…-O3
  (**504 checks**, up from 456) *and* two compiled-wasm fuzzes: `tools/fuzz-float.mjs`
  (formatter vs `String()`, 10M doubles) and `tools/fuzz-parse.mjs` (`parse(str(x))==x`
  bit-for-bit, plus arbitrary strings vs `Number()`) — zero mismatches. Also an
  **f64 math library** — `sqrt`/`floor`/`ceil`/`trunc`/`round`/`abs`/`fmin`/`fmax`/
  `copysign`, 1:1 to wasm opcodes (`round` = ties-to-even `f64.nearest`) — as
  **soft, user-overridable** builtins (a hand-written `fn sqrt` shadows the builtin,
  as the `newton` example does), plus the f64 bit-reinterpret intrinsics. New catalog
  example "Floating point & str(float)". Gate (conformance + lint + build) green.
- 2026-06-15 (claude / claude-opus-4-8): **Structs (aggregate types), end to end.**
  The biggest missing C feature — a real `struct` — threaded through the whole
  pipeline and proven by the differential harness at -O0…-O3 (**456 checks, all
  green**, up from 388). A struct is laid out in linear memory and referenced by an
  i32 handle (the model arrays/strings already use), so it needed **no new IR
  concept and no optimizer/backend changes**: construction is a bump-allocate plus a
  store per field, a field read/write is a `load`/`store` at the field's offset, and
  a handle is an i32 the existing passes copy, phi, compare and stackify. Shipped:
  `struct` declarations with fields of any type incl. **nested & recursive** structs;
  a `null` handle (→ i32 `0`) so linked lists, stacks and BSTs work; positional
  construction `Point(3,4)`; dot read/write/compound-assign (`p.x`, `p.x = e`,
  `p.x += 1`); by-handle params/returns with caller-visible mutation; struct/`null`
  `==`/`!=` as reference identity. New `struct.ts` computes naturally-aligned field
  offsets. The type checker gained a struct-collection pass (forward/mutual recursion),
  constructor/member/`null` checking and a 17-case negative sweep; the reference oracle
  + step debugger model a struct as a by-reference object (and `null` as JS `null`),
  so they share mutation/aliasing/identity with the wasm without modelling addresses.
  Added 3 examples (2D vectors, a binary search tree, rational arithmetic) and a
  10-program struct test battery. Then generalized arrays to hold structs too —
  `struct_array(n)` (a null-filled handle array whose element struct is fixed by the
  variable's annotation), so `a[i].x = …` and handle-swapping sorts work and struct
  arrays nest inside structs; added an insertion-sort example and 3 more tests.
  Verified green end to end: `tsc -b` + lint + Vite build + the headless harness
  (**456/456** across -O0…-O3) + `verify-project.mjs`.

- 2026-06-15 (claude / claude-opus-4-8): **64-bit integers (`long` → wasm `i64`),
  end to end — plus a bit-manipulation toolkit.** The longest-standing open item,
  threaded through every stage and proven by the differential harness at
  -O0…-O3 (**388 checks, all green**, up from 312). The new `long` type lowers to
  real `i64`: `L`-suffixed and `0x` hex literals folded to BigInts; a strict
  numeric type (no implicit int↔long); the full operator set with wasm-exact
  64-bit wrapping, truncating division (incl. the `INT64_MIN / -1` trap) and
  6-bit-masked shifts; `long[]` arrays at an 8-byte stride; conversions
  `long()`/`int(long)`/`float(long)`; `str(long)` rendered by a Strata-written,
  INT64_MIN-safe `__long_to_str` prelude function; and `print(long)` via a
  `print_long` import the runner receives as a JS BigInt (WebAssembly's BigInt
  integration). The mid-end carries `i64` everywhere: a `number | bigint` constant
  representation, **exact 64-bit BigInt constant folding** in SCCP, `long`-aware
  algebraic simplification and `* 2^k → << k` strength reduction, with GVN/LICM/
  DCE/if-conversion/stackification all verified on `i64`. The backend gained the
  `i64.*` opcode tables, the `extend`/`wrap`/`convert`/`trunc_sat` conversions, a
  signed-LEB128 BigInt encoder, and WAT for all of it. The reference interpreter
  and the step debugger model `long` as a BigInt so the oracle is directly
  comparable. As a bonus that pairs naturally with 64-bit work, a bit-manipulation
  family — `popcount`/`clz`/`ctz` (a new pure `iunary` IR op) and `rotl`/`rotr`
  (new `ibin` subs) — maps 1:1 to the wasm i32/i64 ops on both `int` and `long`,
  with shared helpers backing the interpreter and SCCP's folder. New examples
  (64-bit FNV-1a + 20! factorial; an xorshift64\* PRNG with a dice histogram) and
  17 new adversarial battery programs cover wraparound, div/rem edges, conversions,
  hashing/PRNG and every bit-op corner.

- 2026-06-15 (claude / claude-opus-4-8): **Stdlib + str[] + control flow + branchless select +
  a step debugger + a headless correctness gate.** Six shipments, each proven by the differential
  harness at -O0…-O3 (now **312 checks, all green**):
  (1) **Headless harness** (`tools/run-harness.mjs` + `tools/_entry.js`): Vite-bundles the compiler
  for Node, type-checks it (`tsc -b`, catching strict-TS errors the bundler tolerates), then compiles
  every example + battery program and diff-checks the real WebAssembly against the reference
  interpreter — my correctness gate all session.
  (2) **`do`/`while`** desugared in the parser into a once-flag `while` (so the interpreter and backend
  share one CFG shape — the relooper-friendly top-tested loop — and can't disagree); **`switch`** with
  multi-label cases, no fallthrough, optional `default`, duplicate-label rejection, lowered to an
  OR-of-equalities chain.
  (3) **String standard library** — `repeat`, `trim`, `replace` (replace-all), `find`, `contains`,
  `starts_with`, `ends_with`, `parse_int` — each written in Strata in the prelude *and* mirrored in
  the interpreter via a single shared `callBuiltin`.
  (4) **`str[]` arrays** (the long-open enabler): `str` is now a legal array element type end to end;
  elements are i32 pointers so the backend is untouched, and an uninitialized element reads as `""`
  (pointer 0 → length word in the reserved [0,16) region → empty) which matches the interpreter's
  default. Added `str_array(n)`, indexing/assignment, and `split`/`join` with a hand-written
  segmentation algorithm duplicated verbatim in interpreter and prelude.
  (5) **If-conversion → `select`**: a new pure `select` IR op (wasm `0x1B`) and an optimizer pass that
  collapses a side-effect-free control-flow diamond — the shape ternaries and if/else-assignments
  lower to — into one branchless `select`, hoisting both arms into the predecessor (sound because the
  arms are pure and non-trapping). Fires at -O1+ (e.g. a `clamp` loop: 41→27 wasm instrs).
  (6) **Step debugger** (`compiler/debug.ts` + Debug tab): a generator-based interpreter that pauses
  before each statement and steps *into* user calls, exposing the live call stack, every variable in
  scope (typed), globals, and output as it is produced, with run/step/restart and the current source
  line highlighted in the editor. It shares the builtin library with the reference interpreter, so it
  stays faithful. Refactored `interp.ts` to extract `callBuiltin` for that reuse (harness stayed green).
  Also: four new showcase examples and a big battery expansion (do-while, switch, the whole stdlib,
  `str[]`, split/join, select). CI gate (conformance + lint + build) green.
- 2026-06-14 (claude / claude-opus-4-8): **First-class strings, end to end.** Added a `str`
  type that runs through the whole compiler. Front-end: string literals with escapes (Latin-1
  byte strings), a `string` AST node, `str` annotations, and type rules for `+` (concat),
  `==`/`!=`, `len`, byte indexing, and the `str()`/`char()` builtins. Backend: literals are
  interned into a single static **data section** (8-byte length header per object, identical
  literals deduplicated to pointer equality); added byte `load`/`store` IR ops
  (`i32.load8_u`/`i32.store8`); emitted the data section, a `print_str` import, and a `(data …)`
  WAT line; the heap pointer now starts after the static region. The string **runtime is written
  in Strata** (`ir/prelude.ts`: `__strcat`/`__streq`/`__char`/`__int_to_str`/`__bool_to_str`) and
  compiled through the same pipeline (low-level memory intrinsics gated behind a `lowLevel`
  type-check flag), injected only when needed and pruned by dead-function elimination at -O2+.
  The interpreter models strings as JS byte-strings with matching semantics; the runner
  Latin-1-decodes `print_str` out of exported memory. Also added lexicographic ordering
  (`< <= > >=` via `__strcmp`) and a string library (`substr`, `index_of`, `to_upper`,
  `to_lower`). Four new examples (Strings & text, Caesar cipher, ASCII bar chart, Text
  toolkit) and 14 new battery programs. Headless harness now runs **244 differential checks
  (15 examples + 46 battery × 4 levels), all green**; CI gate (conformance + lint + build) green.
- 2026-06-14 (claude / claude-opus-4-8): Major optimizing-compiler upgrade. **Backend
  stackification**: single-use, pure, non-trapping, same-block values are now folded directly
  onto the wasm operand stack (post-order subtree expansion at the consumer) instead of every
  SSA value getting its own local; the survivors are packed into a dense local index space.
  Trapping `div_s`/`rem_s` and all memory/effectful ops are excluded so observable trap/effect
  order is preserved — proven by the differential harness staying green at every level (e.g.
  `cse` -O0 went from one-local-per-value to a single local with 12 values stack-folded).
  **New mid-end passes**: LICM (natural-loop detection from back edges + preheader insertion +
  invariant hoisting, never hoisting trapping ops past a zero-trip guard), tail-call → loop
  optimization (self-recursion in constant stack space — a 500k-deep `sum` overflows at -O0 but
  loops cleanly at -O2), pre-SSA function inlining of small non-recursive callees under a budget,
  strength reduction (`*2^k → <<k`), and whole-module dead-function elimination (only `main` is
  exported, so a fully-inlined callee is deleted — making inlining a net size win). **Language**: ternary `?:`, all ten compound
  assignment operators, and a fix so globals are assignable from functions. **Correctness**: a
  32-program adversarial battery (`tests.ts`) wired into the Verify panel and a private headless
  Node harness; 172 differential checks (11 examples + 32 battery × 4 levels) all pass. **UI**:
  `locals`/`stack-folded` header metrics, refreshed Optimizer legend, and a Bytes-tab
  download-`.wasm` button. Gate (conformance + lint + build) green.
- 2026-06-14 (claude): Built the whole compiler end-to-end from the template. Wrote a Node
  differential harness early (Node has `WebAssembly`), which caught three real bugs before
  any UI existed: call/print/global indices were resolved with the wrong defaults because
  codegen built its body before the resolvers were wired; SCCP's `pruneUnreachable` removed
  CFG-reachable blocks and left dangling branch targets; and SCCP left function parameters
  as UNDEF instead of NAC, which made loops look unreachable and folded `collatz` to 0.
  All nine examples now pass at -O0…-O3. Shipped the visual Compiler Explorer UI and the
  in-app Verify suite. CI gate (conformance + lint + build) green.
