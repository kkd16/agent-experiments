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
  conditional constant propagation), **auto-vectorization** (counted array loops → 4-wide
  `v128` SIMD, see `opt/vectorize.ts`), **loop unswitching** (a loop-invariant branch hoisted
  above the loop → two branch-free clones, see `opt/unswitch.ts`), **devirtualization**,
  **full loop unrolling**,
  **if-conversion** (control-flow diamond → branchless `select`), **strength reduction**,
  **SROA** (escape analysis + scalar replacement of aggregates), **memory optimization**,
  **reassociation** (canonicalize integer affine trees → `Σ cᵢ·xᵢ + K`, and bitwise monoids),
  dominator-scoped **GVN/CSE**, **operator strength reduction on induction variables (OSR)**,
  algebraic simplification, **LICM** (loop-invariant code
  motion), **code sinking** (a pure value used on only one branch arm pushed into it —
  partial dead-code elimination, see `opt/sink.ts`), **code hoisting** (a pure value computed in
  *both* arms pulled up above the branch — very-busy expressions, see `opt/hoist.ts`),
  **cross-jumping / tail merging** (the bottom dual: when every predecessor of a merge — or both
  arms before a `return` — ends in the *same* instruction tail, keep one shared copy and drop the
  per-path ones; side-effecting tails included, which hoisting can't move, see `opt/crossjump.ts`),
  **DCE**, **CFG simplification**, CFG cleanup,
  and whole-module **dead-function elimination**, iterated to a fixed point.
- `src/compiler/ir/loops.ts` — the **natural-loop forest** (headers, latches, bodies,
  nesting depth + immediate parent), discovered from back edges. One definition of "what a
  loop is" shared by LICM and the unroller (`findNaturalLoops` / `dominates` / `isInnermost`).
- `src/compiler/opt/unroll.ts` — **full loop unrolling** of counted loops at -O2+: an
  induction-variable + **trip-count analysis** (a header phi `i = [init, i ± c]` tested
  against an invariant constant bound; the trip count is found by *simulating the counter*
  with exact i32/i64 `icmp` semantics), then the loop is replaced by that many straight-line
  body clones with SSA threaded across iterations. Sound by precondition (single latch,
  two-pred header, single exit, header-phi-only live-outs, innermost, growth-bounded) — it
  declines whenever uncertain, so the differential oracle proves it never changes behaviour.
- `src/compiler/opt/unswitch.ts` — **loop unswitching** at -O2+: when a loop body contains a
  branch on a **loop-invariant** condition `C` (a runtime flag whose single SSA definition lies
  outside the loop, so it never changes across iterations), the test is hoisted *above* the loop
  and the loop is cloned into two versions — one with every `if (C)` collapsed to its then-arm,
  one to its else-arm — so the per-iteration branch (and, after the following DCE/CFG-simplify,
  the dead arm of each) vanishes. A LICM pass runs first to lift the invariant condition (the
  `a > b` an in-loop `if` lowers to) into the preheader so unswitching can see it. Sound by the
  same structured-loop precondition the unroller uses (single preheader, the header conditional
  is the loop's one exit) — which makes the exit SSA repair exact (every escaping value is a
  header def, merged back at the single exit with a fresh φ) — and it declines whenever a
  precondition is unmet, so the three-engine oracle proves it never changes behaviour.
- `src/compiler/opt/sink.ts` — **code sinking** (partial dead-code elimination) at -O2+, the dual
  of LICM: a **pure** value computed in a block that ends in a two-way branch but **used on only
  one arm** is pushed *down* into that arm, so the other path never computes it. Sound by
  precondition — the target arm must be entered only from the branch block (`S.preds == [B]`, so
  the value's operands, available at `B` which dominates `S`, are still available after the move),
  every use must be dominated by `S`, the value must not feed a φ (whose use is on a predecessor
  edge), and to never pessimize it refuses to sink into a deeper loop nest — so it only ever moves
  work off a path, never changes a result, as the three-engine oracle proves.
- `src/compiler/opt/hoist.ts` — **code hoisting** (very-busy / partially-redundant expressions) at
  -O2+, sinking's mirror: when *both* arms of a two-way branch begin by computing the same **pure**
  value, one copy is pulled *up* above the branch so it runs once instead of on each path. GVN/CSE
  can't — neither arm dominates the other, so the two copies are partial (not dominating)
  redundancies. Sound by the same single-pred precondition as sinking (each arm entered only from
  the branch block, so a value computed there is available wherever the originals were) and only
  pure instructions whose operands are all available at the branch block are eligible — so hoisting
  never adds a path, only removes a duplicate.
- `src/compiler/opt/partial-unroll.ts` — **partial loop unrolling** (unroll-by-K + remainder)
  at -O2+, for the runtime- and large-trip loops full unrolling declines: it prepends a
  **strided main loop** running `K` body copies per back edge — guarded by an exact,
  **overflow-blind** "K more iterations?" test (the real predicate evaluated at `i, i+c, …,
  i+(K−1)c`, ANDed) — and **reuses the original loop untouched as the remainder**, so every
  loop-exit value and live-out is still computed by the original machinery. Runs once after the
  fixpoint rounds (full unrolling has already taken the small constant-trip loops), then a
  cleanup round optimizes across the contiguous copies.
- `src/compiler/opt/vectorize.ts` — the **auto-vectorizer** at -O2+: recognizes a counted array
  loop `for (i…) a[i] = f(a[i], b[i], …)` whose every subscript is exactly the IV (offset 0),
  proves the four iterations independent, and — using the very same splice as partial unrolling —
  prepends a **4-wide vector main loop** (real `v128.load` → lanewise `i32x4`/`f32x4` arithmetic →
  `v128.store`) while **reusing the original loop as the scalar remainder** for the trailing `< 4`
  iterations. The "4 more?" guard (the real predicate at `i…i+3`, ANDed) means any widened array
  has ≥ 4 live elements, so distinct bump allocations can never collide across lanes — sound under
  aliasing, with genuine carriers (stencils, reductions, per-lane stores) declined up front.
- `src/compiler/loopAnalysis.ts` — best-effort, never-throwing induction-variable/loop
  classifier (counted / strided-main / general, with IV, step, bound, static trip count) that
  powers the **Loops** tab; descriptive only, never mutates the IR.
- `src/compiler/opt/simplifycfg.ts` — **CFG simplification** at -O1+: straight-line block
  coalescing (merge `A —br→ B` when `B`'s only pred is `A`) and branch-to-branch threading
  (splice out empty forwarding blocks), cleaning up after SCCP / if-conversion / inlining /
  unrolling.
- `src/compiler/opt/thread.ts` — **jump threading** (all levels): a pure merge block (phis only)
  ending in `condbr c, T, F` with `c` one of its own phis is bypassed on every predecessor whose
  phi-incoming for `c` is a constant — that edge is rewired straight to the decided arm and the
  merge is deleted once every edge is decided. The path-sensitive complement to SCCP; collapses
  materialized booleans and short-circuit `&&`/`||`. Sound by a local SSA-use guard, proven by the
  three-engine oracle. (The chained-merge CFGs it produces drove the largest-rpo-outermost nesting
  fix in `backend/codegen.ts`.)
- `src/compiler/opt/divrem.ts` — **division/remainder by a constant** strength reduction at
  -O1+: a `/ C` or `% C` with a runtime dividend lowers to multiply/shift/add. Power-of-two
  divisors become an arithmetic shift with a round-toward-zero bias (`(x>>w-1)&(2^k-1)`,
  written without a logical shift, which the IR lacks); general divisors use the signed
  **magic-number multiply** (Hacker's Delight) — for i32 the high word comes free from an i64
  widening multiply, and for i64 a full **64-bit high-multiply is synthesized from i64 ops
  alone** (schoolbook 32×32 limbs + signed correction), since wasm has no `mulhi`. Remainder
  reuses the quotient (`x - (x/C)*C`), so GVN shares it in a `divmod`. Fires only for
  `|C| >= 2` (where signed division cannot trap), so it can never erase a trap the program
  would raise; every rewrite is an exact identity, proven by the differential oracle and an
  offline fuzz of millions of dividends. See the 2026-06-19 plan (II).
- `src/compiler/opt/reassoc.ts` — **reassociation** at -O2+: reads an integer
  add/sub/×-constant/«-constant tree as a **linear combination** `Σ cᵢ·xᵢ + K`, then
  rebuilds the smallest expression that computes it — summing the coefficients of like
  terms (`a·x + b·x → (a+b)·x`), folding scattered constants into one, distributing a
  constant over a sum, folding multiplicative constant chains (`i*4*3 → i*12`) and
  cancelling commuted operands. The same pass reassociates **bitwise monoids**
  (`and`/`or`/`xor`: idempotence, xor self-inverse parity, absorbing elements, constant
  folding). Exact in the wrapping ring (coefficients combined with
  the backend's own `Math.imul` / i64 `asIntN`); floats excluded. Only single-use,
  same-block nodes are absorbed (no shared computation duplicated, SSA preserved), and a
  rewrite fires only when **strictly smaller** than the chain it replaces — so it can
  only improve code and is guaranteed to terminate. Runs before GVN and OSR, surfacing
  fresh `i·r` candidates for strength reduction and merging more equal expressions. See
  the 2026-06-22 plan.
- `src/compiler/opt/sroa.ts` — **SROA: escape analysis + scalar replacement of aggregates**
  at -O1+. Struct construction lowers to a first-class **`alloc` IR op** (`ir/ir.ts`); this
  pass traces each `alloc`'s handle (and every address derived from it by adding a *constant*),
  and if the handle never **escapes** — only ever the base of its own field `load`/`store`s,
  never a store *value*, return value, comparison/phi operand, call argument, or pointer
  arithmetic with a non-constant — the whole record is provably private and aliases nothing.
  It is then promoted out of memory by **full Cytron SSA construction**: each `(alloc, field
  offset)` is a variable, phi nodes are placed at the iterated **dominance frontier** of its
  store sites (computed here, Cooper–Harvey–Kennedy from the shared dominator tree), and a
  dominator-tree rename walk forwards every load to its reaching value — so a field written
  before a branch and read after the merge becomes a phi, and one accumulated in a loop becomes
  a header phi. Because the handle is proven non-escaping, a `call` between a store and a load
  cannot touch the field, so promotion forwards straight across calls (where `memopt` must stay
  conservative). An uninitialized read would force an undefined phi operand, so that one
  allocation's promotion is aborted cleanly (records built by the constructor never hit it).
  After cross-function inlining at -O2 a chain of vector temporaries melts entirely to scalar
  arithmetic. Every promotion is an exact rewrite, pinned bit-for-bit by the differential oracle.
- `src/compiler/ir/lower.ts` — **`lowerAllocs`**: expands any surviving (escaping) `alloc` to
  the concrete bump-allocator sequence (`gget`/`add`/`gset`) on a private clone *just before
  codegen*, so the optimizer and UI see records as first-class allocations while the backend
  stays a pure consumer of the heap primitives and never has to know what an allocation is.
- `src/compiler/opt/memopt.ts` — **memory optimization** at -O1+: an **alias analysis** plus
  **store→load forwarding**, **redundant-load elimination**, and **dead/silent-store
  elimination** over linear memory (`struct` fields, array elements, the runtime's raw
  `__load`/`__store`). Forwarding is a **forward available-memory dataflow** (MUST analysis,
  meet = intersection over predecessors, iterated to a fixpoint) so a value stored before a
  branch is still forwardable past the merge; a converged available fact holds on *every* path
  to the use, so its value dominates the use and the substitution is SSA-valid (a defensive
  dominator check backs that up). The alias analysis reduces each address to a *base SSA value
  + constant byte offset* and proves two accesses **disjoint** only when they share a base and
  their `[off, off+width)` ranges don't overlap — any *different* base is assumed to may-alias,
  so a write through one handle conservatively kills every fact about another (sound under both
  the flat-memory backend and the interpreter's object model). A `call`/`call_indirect` clears
  all facts (it may read/write anywhere); `print` reads but never writes memory, so it is
  transparent to forwarding yet still a barrier for dead-store elimination. `i8` stores are
  never forwarded (a byte store→byte load is a truncating round-trip). See the 2026-06-19 plan (III).
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
- `src/compiler/runner.ts` — instantiates and runs the wasm in-browser (host `WebAssembly`).
- `src/wasm/` — a **from-scratch WebAssembly virtual machine** (the third correctness oracle).
  `decode.ts` re-parses the assembled bytes back into a structured module (LEB128, all the
  sections the backend emits) *independently* of the encoder; `disasm.ts` decodes a function
  body into a flat instruction array with the structured-control-flow scopes resolved to jump
  targets + a human-readable listing; `vm.ts` is a hand-written stack machine that executes that
  — every numeric op on i32/i64/f32/f64, the conversions, 128-bit SIMD, structured control,
  memory, globals, the funcref table + `call_indirect`, and the `print_*` host imports — one
  instruction at a time. `runOnVm` is the oracle entry; `WasmVM.step()/state()` drive the
  time-travel debugger. i64 is a BigInt and f32 carries `Math.fround`, exactly as the reference
  interpreter models them, so V8, the interpreter and this VM agree bit-for-bit.
- `src/compiler/verify.ts` — differential testing harness (shipped as the "Verify" tab). Now a
  **three-engine** cross-check: host `WebAssembly` (V8) = reference interpreter = from-scratch VM.
- `src/compiler/tests.ts` — adversarial differential-test battery (90+ focused programs).
- `tools/run-harness.mjs` — headless Node harness: `tsc -b` + Vite-bundle + run the full
  corpus at -O0…-O3, asserting V8 == reference interpreter == VM (run during development).
- `tools/check-vm.mjs` — the VM's dedicated conscience: runs the corpus three ways and also
  tallies the distinct opcodes the VM exercised + instructions it retired.
- `src/ui/` — the Compiler-Explorer UI (editor with syntax highlight overlay, SVG CFG view,
  pipeline-stage panels, the source-level step debugger, and the **WASM VM** time-travel tab).

## Language features

int / **`long` (64-bit, i64)** / float / bool / **str** / arrays of any scalar incl.
**`long[]`** and **`str[]`** (linear memory) / **`struct` (aggregate types)** /
**arrays of function pointers** (`(fn(…)->…)[]`, a jump table) /
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
function, return it, keep it in a `struct` field (a hand-rolled **vtable**), or hold
a whole **array of them** — `(fn(int) -> int)[] = fn_array(n)` — for a real **jump
table / state machine** (function-table slot 0 is reserved as a null `funcref`, so an
unset element traps on call, and `fn == null` tests whether a slot is wired up yet).
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

**128-bit SIMD vectors** make data parallelism a first-class value type that lowers
to a single wasm **`v128`** register. Four shapes pack the lanes — **`int4`**
(i32x4), **`float4`** (f32x4), **`long2`** (i64x2), **`double2`** (f64x2) — and are
usable as locals, parameters, return values and loop-carried values (a v128 phi),
even as the result of if-conversion (a v128 *typed* `select`). Operators are
**elementwise**, one wasm lane op each: `+ - *` on every shape, `/` on the float
shapes, and whole-vector `& | ^ ~` on the integer shapes. A builtin library covers
the rest: `int4(a,b,c,d)` (or `int4(x)` to **splat**), **`lane(v,k)`** /
**`withlane(v,k,x)`** (constant lane immediates), **`hsum(v)`** (horizontal
reduction → a scalar), **`vmin`/`vmax`/`vsqrt`/`vabs`**, the six lanewise
comparisons **`veq`/`vne`/`vlt`/`vle`/`vgt`/`vge`** (each yields an integer
**mask**), **`vselect(mask, a, b)`** (a bit-exact `v128.bitselect`), and
**`to_float4`/`to_int4`** (saturating f32x4↔i32x4 convert). Vectors flow through the
optimizer untouched — GVN deduplicates lane ops, DCE drops dead vectors, the
stackifier folds a single-use vector straight onto the operand stack — and the
reference interpreter models each lane with the matching rounding (`Math.fround`
per f32 lane, i32/i64 wrap, byte-exact bitselect), so a branchless **SIMD
Mandelbrot** (four pixels per step, escape counts accumulated through a compare
mask) is proven identical to the wasm at every level. (Vectors are value-only: not
yet stored in arrays/structs/globals — extract their lanes for that.)

## Done

- [x] **Source-level debugger for the compiled WebAssembly — a DWARF-lite line table** (the
      WASM VM tab is now a real source debugger). The compiler threads AST source spans through
      the IR (`Inst.span`, `condbr`/`ret` spans), preserves them across SSA construction and the
      optimizer's `cloneModule`, and the backend emits a **line table** — one source location per
      emitted wasm instruction, built inside `encodeBody` so it is provably 1:1 with the
      disassembler's instruction stream (the encoder is the decoder's inverse). The from-scratch
      VM consumes it: stepping the *real, optimized* bytecode reports the current source line, the
      editor highlights it live, line-number / disassembly-badge clicks set **breakpoints**, and
      **⛒ continue** runs the machine until it hits one. The disassembly annotates every
      instruction with its source line (`Lnn`) and highlights the whole group of instructions a
      single source line compiled to — so you watch one line of source become N instructions, and
      watch the optimizer delete/merge them as you raise -O. Stepping into the Strata runtime
      library (`__strcat`, `__exp`, Dragon4 …) is shown as such instead of pointing at a phantom
      line. Proven by a new headless harness (`tools/check-debuginfo.mjs`): **6459 line-table
      checks across 4767 functions at -O0…-O3** — alignment, source-bounds, 84% -O0 coverage, plus
      a functional step/breakpoint test — all green, and the existing **1096 three-engine
      differential checks still agree byte-for-byte** (the feature is purely additive). See the
      2026-06-24 plan.
- [x] **Auto-vectorizer — counted array loops → 4-wide `v128` SIMD** (`opt/vectorize.ts`, -O2+) —
      the optimizer now **discovers** data parallelism instead of only honouring hand-written SIMD:
      a counted loop `for (i…) a[i] = f(a[i], b[i], …)` with every subscript exactly the IV is
      widened into a vector main loop (`v128.load` → lanewise `i32x4`/`f32x4` `+ - * & | ^` / `/`
      → `v128.store`) plus the original loop reused as a scalar remainder. New `vload`/`vstore` IR
      and `0xfd 0x00`/`0x0b` bytecode run on the backend, the disassembler and the from-scratch VM.
      Sound under aliasing by construction (the ≥ 4-element guard keeps distinct allocations from
      ever colliding across lanes); stencils, reductions and per-lane stores are declined. Corpus
      **1024 → 1068** (interp = V8 = VM at -O0…-O3) plus an **8,000-program** scalar≡vectorized
      fuzz with zero mismatches. See the 2026-06-23 plan.
- [x] **Partial loop unrolling (unroll-by-K + remainder loop)** (`opt/partial-unroll.ts`,
      -O2+) — the production complement to full unrolling: for a loop with a **runtime** or
      large trip count it prepends a **strided main loop** running `K` body copies per back edge
      (guarded by an exact, **overflow-blind** "K more iterations?" test) and **reuses the
      original loop untouched as the remainder**, so no live-out is ever disturbed. Handles
      i32/i64 IVs, any predicate (incl. `!=`), either step sign, side-effecting bodies,
      reductions, inner control flow and nested loops; declines (deferring to full unrolling)
      on small constant-trip loops. A **Loops** tab classifies every loop (counted /
      strided-main / general) with its IV, step, bound and trip count. Proven by the
      three-engine oracle (interp = wasm = VM) at -O0…-O3; corpus **884 → 948** checks. See the
      2026-06-21 plan.
- [x] **128-bit SIMD vectors (`v128`)** — first-class `int4`/`float4`/`long2`/
      `double2` value types lowering to one wasm SIMD register. Elementwise
      operators (one lane op each), splat/`lane`/`withlane`, `hsum`,
      `vmin`/`vmax`/`vsqrt`/`vabs`, six compares→mask + `vselect`
      (`v128.bitselect`), and saturating `to_float4`/`to_int4`. A new `'v128'`
      `IRType` + six pure SIMD IR families ride the existing pipeline (GVN, DCE,
      stackifier, SSA phis, the relooper) untouched; a **typed `select`** is
      emitted for if-converted v128 diamonds. The reference interpreter reproduces
      every lane (i32/i64 wrap, `Math.fround` per f32 lane, byte-exact bitselect),
      so the headline branchless **SIMD-Mandelbrot** is proven identical to the
      wasm. **836 differential checks across -O0…-O3.** See the 2026-06-20 plan.
- [x] **Memory optimization — alias analysis · store→load forwarding · RLE ·
      dead/silent-store elimination** (`opt/memopt.ts`, -O1+). The first pass to
      reason about *linear memory*: until now a `struct` field or array element
      written and read back did a real round-trip. An **alias analysis** (address →
      base SSA value + constant byte offset; same-base disjoint-range ⇒ no alias,
      any different base ⇒ may-alias) drives a **forward available-memory dataflow**
      (MUST, meet = intersection, fixpoint) that **forwards a stored value into a
      later load**, **eliminates a redundant load** of the same location, and a
      backward intra-block scan that **deletes a store overwritten before any read**;
      the forwarding walk also removes a **silent store** (writing the value a cell
      already holds). Conservative by precondition — a `call` clears all facts, a
      `print` is a read-only barrier, `i8` stores are never forwarded — so it can
      only ever miss, never miscompile, every rewrite proven by the differential
      oracle at -O0…-O3. **756 differential checks (baseline 716)**; the showcase
      `Memory optimization` example collapses a particle `step()`'s read-modify-write
      burst from 8 memory ops to 1 at -O1. See the 2026-06-19 plan (III).
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
- [x] **Loop-optimization suite** — a reusable natural-loop forest analysis
      (`ir/loops.ts`: headers, latches, bodies, nesting depth + parent, preheaders,
      exits), an **induction-variable & trip-count analysis**, **full loop
      unrolling** of counted loops (`opt/unroll.ts`), and a **CFG simplifier**
      (`opt/simplifycfg.ts`: straight-line block coalescing + branch-to-branch
      threading). Every transform fires only under conservative, provable
      preconditions, so the differential oracle proves it preserves behaviour at
      -O0…-O3. LICM refactored onto the shared loop forest. See the 2026-06-19 plan.
- [x] **Division/remainder by a constant — strength reduction** (`opt/divrem.ts`,
      -O1+). A `/ C` or `% C` with a runtime dividend is turned into the textbook
      multiply/shift/add — no hardware divide. Power-of-two divisors → an
      arithmetic shift with a round-toward-zero bias (expressed without the
      logical shift the IR lacks); general divisors → the signed **magic-number
      multiply** of Hacker's Delight, for both **i32** (high word via an i64
      widening multiply) and **i64** (a full 64-bit high-multiply **synthesized
      from i64 ops alone**, since wasm has no `mulhi`). Remainder reuses the
      quotient so GVN shares a `divmod`. Each rewrite is an **exact identity**,
      fires only where division can't trap (`|C| >= 2`), and is proven bit-for-bit
      by the oracle *and* an offline fuzz of millions of dividends (incl.
      INT_MIN/INT_MAX). **716 differential checks across -O0…-O3 (baseline 700).**
      See the 2026-06-19 plan (II).
- [x] **Operator Strength Reduction on induction variables (OSR)** (`opt/osr.ts`,
      -O2+). The classic Cooper–Simpson–Vick transformation: inside a loop, a
      multiply (or shift) of an induction variable by a loop-invariant **region
      constant** is replaced by a *new* induction variable advanced by an
      **addition** each iteration — the move that turns `base + i*stride` into a
      running pointer bump. It pays off precisely on the loops the unroller
      **can't** touch (runtime / large trip counts), where the multiply would
      otherwise run every iteration. Exact in the wrapping ring `Z/2^w`:
      `(i±c)*r ≡ i*r ± c*r (mod 2^w)`, with shifts handled as `r = 2^(k mod w)`;
      floats are excluded (FP doesn't distribute). Handles **i32 and i64** IVs,
      multiple latches, decrementing IVs, negative/variable region constants, and
      several candidates per loop; declines whenever a precondition is
      unrecognized, so it can only ever strengthen the code. Proven by the
      three-engine oracle (interp = wasm = VM) **and** an offline fuzz of **9,600
      random loops** (OSR firing on 71%, zero mismatches). **884 differential
      checks across -O0…-O3 (baseline 836)**; OSR fires on **91** of the 221
      corpus programs. See the 2026-06-21 plan.
- [x] **Reassociation — canonicalize integer affine expression trees**
      (`opt/reassoc.ts`, -O2+). A classic mid-end canonicalization (LLVM's
      `-reassociate`): an integer add / sub / ×-constant / «-constant tree is read
      as a **linear combination** `Σ cᵢ·xᵢ + K` over opaque atoms, then rebuilt as
      the smallest expression that computes it — summing the coefficients of **like
      terms** (`a·x + b·x → (a+b)·x`), folding every scattered constant into one,
      **distributing** a constant over a sum, folding **multiplicative constant
      chains** (`i*4*3 → i*12`), and **cancelling** commuted operands
      (`(a+b)-(b+a)+a → a`). Each rewrite is an exact identity in the wrapping ring
      `Z/2^w` (coefficients combined with the backend's own `Math.imul` / i64
      `asIntN`), so it can only canonicalize, never change a value; floats are
      excluded. Only **single-use, same-block** nodes are absorbed (no shared
      computation is duplicated, SSA stays valid), and the rewrite fires only when
      it is **strictly smaller** than the chain it replaces — which both guarantees
      improvement and makes the pass terminate. The same pass also reassociates
      **bitwise monoids** — `and`/`or`/`xor` chains — exploiting idempotence
      (`x & y & x → x & y`), self-inverse parity (`x ^ y ^ x → y`), absorbing
      elements (`x & 0 → 0`, `x | ~0 → ~0`) and constant folding (`x ^ 3 ^ 5 →
      x ^ 6`). It runs just before GVN and OSR, so both see the canonical form (it
      surfaces fresh `i·r` candidates for strength reduction and merges more equal
      expressions). Proven by the three-engine oracle (interp = wasm = VM) at
      -O0…-O3 **and** an offline fuzz of **≈33,000 random affine + bitwise programs**
      (i32+i64, reassociation firing on ~80%, zero mismatches). **948 → 1024
      differential checks.** See the 2026-06-22 plan.
- [x] **Jump threading** (`opt/thread.ts`, all levels) — the path-sensitive
      complement to SCCP. When a pure merge block (phis only) ends in
      `condbr c, T, F` with `c` one of its own phis, every predecessor whose
      incoming value for that phi is a **constant** has the branch already
      decided; the pass routes it straight to the taken arm and deletes the merge
      when every edge is decided. It collapses the materialized-boolean and
      short-circuit `&&`/`||` shapes that SCCP (not path-sensitive) leaves behind,
      under a strict SSA-safety guard (a merge's values may be used only by its own
      terminator and by `pred = B` incomings in its successors). Exposing it
      uncovered — and the same session **fixed** — a latent structurizer bug:
      `codegen.ts` nested sibling merge blocks smallest-rpo-outermost, so it
      couldn't enclose a forward branch from an earlier merge's body into a later
      one (the `if (a || b) { … }` chained-merge shape threading produces); the fix
      nests **largest-rpo outermost**, which also lays merge bodies out in rpo
      order. Across the battery at -O3 (already fully optimized) the pair removes
      **120 basic blocks** and **918 wasm bytes**; the pass fires on **46** of the
      238 corpus programs. Proven by the three-engine oracle (interp = wasm = VM)
      at -O0…-O3. **1096 → 1112 differential checks.** See the 2026-06-25 plan.

## 2026-06-26 — plan + shipped: generalized jump threading — fold a condition *cone* over a flag phi per-edge (claude / claude-opus-4-8)

The 2026-06-25 threader could decide a branch only when its condition `c` was *literally one of the
merge block's phis* carrying a constant on some edge. But the common boolean idiom puts an operation
*between* the phi and the branch — `if (flag == 0) …`, `if ((mask & 1) != 0) …`, `if (hot - 1 > 0)
…` — where `c` is a *comparison or arithmetic over* a per-edge-constant value. SCCP can't fold those
(the flag is a meet of two constants, so it sees `c` as unknown), and the bare-phi threader declined
(the merge block now has an instruction). This session generalizes the threader to fold a whole
**condition cone** per-edge. It was the journal's #1 listed control-flow follow-up.

### Design — the condition is a foldable expression cone, not just a phi

The threader now accepts a merge block `B` whose instructions form a pure **foldable cone**: every
instruction is an `ibin`/`icmp` whose operands are constants, `B`'s own phis, or earlier cone
results, and the branch condition `c` names a phi *or* a cone result. On the edge from a predecessor
`P`, it seeds each phi with its (constant) `P`-incoming and evaluates the cone in program order —
reusing **SCCP's exact-wasm-semantics evaluators** (`foldIntBinCmp`, newly shared from `optimize.ts`:
i32 wraparound, i64 BigInt, `MIN/-1` → null) — to obtain `c`'s value, hence the taken successor. The
bare-phi case is exactly the empty cone, so the previous behaviour is preserved verbatim — the
generalization only *adds* foldable-cone edges, never removes a phi edge.

### SSA safety — the cone may not escape

The safety guard is tightened in lockstep: `B` may define values only through its phis and its cone
instructions; each such value may be used *only* by `B`'s own cone, by `B`'s terminator, or — **for a
phi result only** — as a `pred = B` incoming in a successor. A cone result may never appear outside
`B` (it cannot be materialized on a threaded edge), and no instruction anywhere else may read a `B`
value. When any guard is unmet the pass declines, so the triple-differential oracle (interpreter ≡
V8 wasm ≡ from-scratch VM) proves the rewiring sound at every opt level.

### Plan — the checklist for this session (all shipped)

- [x] `opt/optimize.ts` — export `foldIntBinCmp`, a per-edge integer bin/cmp folder built on SCCP's
      own evaluators, so threading and SCCP fold a condition the same way (no second source of truth).
- [x] `opt/thread.ts` — generalize `jumpThread`: cone validation (all insts pure foldable `ibin`/`icmp`
      over consts/phis/earlier results), a per-edge cone evaluator, and the tightened SSA-escape guard.
      The bare-phi path is the empty cone, so the 2026-06-25 battery still threads identically.
- [x] `src/compiler/threadProbe.ts` + `tools/_threadentry.js` + `tools/check-thread.mjs` — the pass's
      first dedicated headless tool (an activity probe + a 240-program seeded differential fuzzer over
      the cone shape). **12/12 activity checks** (fires on comparison / arithmetic / two-level cones;
      declines on a genuinely runtime condition) and **960/960 fuzz checks** (threading fired in 368
      of the compiles), interpreter ≡ wasm ≡ VM.
- [x] Two adversarial battery programs (`jump-thread-cone-cmp`, `jump-thread-cone-multi`) covering a
      comparison cone, a bit-mask cone, a two-level cone, and a three-incoming flag phi. Battery
      241 → 243 programs; **1124 → 1132** triple-engine checks.
- [x] Measured impact (offline, at -O3 over the 281-program example+battery corpus): jump threading
      now fires on **67 programs / 335 edges** — a strict superset of the bare-phi threader's reach,
      since the cone case only adds edges. Found a subtle truth in testing: at -O2 a `for i in 0..8`
      loop *unrolls and inlines* `run(i)` with constant `i`, so a "runtime" `if (n == 0)` legitimately
      becomes per-edge foldable — the threader was right and the first negative test was naive.

### Next (planned follow-ups for jump threading)

- [ ] **`iunary` in the cone** once SCCP grows an `iunary` evaluator (boolean `not`/`eqz`, `neg`,
      `clz`/`ctz`/`popcnt`) — today the cone is `ibin`/`icmp` only.
- [ ] **Correlated-branch threading** — `if (x) …; if (x) …`: thread the second test from the
      dominating value of the first, not just a per-edge phi constant (a dominator walk of the cone).
- [ ] **Duplicable-tail threading** — when `B`'s cone result also escapes (feeds a `pred = B` successor
      phi), clone the cone onto the threaded edge instead of declining.

## 2026-06-26 — plan + shipped: cross-jumping / tail merging — the bottom dual of code hoisting (claude / claude-opus-4-8)

Strata's code-motion suite had three of its four corners: **LICM** lifts loop invariants *out*,
**sinking** pushes a one-arm value *down* into the arm that needs it, **hoisting** pulls a both-arms
value *up* above the branch. The missing corner is the *bottom* dual of hoisting — **cross-jumping**
(a.k.a. tail merging): where hoisting factors a redundant computation at the **start** of two arms,
cross-jumping factors one at the **end**. The journal's 2026-06-25 control-flow backlog named it
explicitly ("Cross-jumping / tail merging (the dual)"); this session ships it.

### Design — move the shared tail to where every path already runs it, let the oracle police SSA

The pass has two modes, both proven by precondition (it declines whenever a guard is unmet, so the
triple-differential oracle — reference interpreter ≡ V8 wasm ≡ from-scratch VM — proves it never
changes a result):

- **Merge-block tail merging.** When a merge block `M` has ≥2 predecessors that *each* end in an
  unconditional `br M`, and they share a common **instruction suffix**, that suffix runs once per
  `M`-entry no matter which predecessor is taken — so one copy at the *front* of `M` is exactly
  equivalent (loops included: `M` is entered once per `Pᵢ → M` traversal either way). The φ in `M`
  that selected the per-predecessor tail results collapses to the single kept value. This is the
  shape `if (c) { …; print(e) } else { …; print(e) } rest` — and crucially it merges
  **side-effecting** tails (`print`/`store`/`vstore`/`gset`) that hoisting, being pure-only, can
  never touch.
- **Return-tail merging.** Two arms of a branch that each end in `ret` with the same returned value
  and the same instruction tail are factored into one fresh shared exit block `R` (both arms `br R`;
  `R` runs the tail once and returns). This `if (c) { …; return e } else { …; return e }` shape has
  no common successor — a `ret` has none — so the merge-block scan can't reach it; the exit-side
  mode does. It is *cleaner* in SSA: the arms have no successors, so no φ anywhere reads their tail
  results, and the moved suffix travels intact into `R`.

### Soundness — three preconditions make the suffix movable

1. **Identical operands.** Two tail instructions match only when their operands are equal: the same
   constant, the same SSA id defined *above every arm* (so it dominates the merge and is live at the
   moved copy), or a matched earlier-suffix result. An operand defined *inside* an arm is rejected —
   it would differ per path. (Identical SSA ids across siblings already imply a dominating
   definition; the explicit guard makes the argument local.)
2. **Mergeable opcodes only.** Pure values (a function of their operands — one evaluation is
   identical, even a trapping `div_s`, which trapped identically on every path anyway) plus the
   *write-only* effects `print`/`store`/`vstore`/`gset`. Ops that **read** mutable state —
   `load`/`gget`/`call`/`callind` — are excluded (their result could differ between paths), and
   `alloc` is excluded (each must stay a distinct address).
3. **The merge φ collapses / no dangling use.** A φ over the per-arm tail results becomes uniform and
   is replaced; any φ that touches a moved/deleted result without collapsing, or any stray use of a
   deleted result outside the dropped suffix, makes the pass decline that site untouched.

### Plan — the checklist for this session (all shipped)

- [x] `opt/crossjump.ts` — the cross-jumping pass: longest-common-mergeable-suffix matching with an
      operand-correspondence map, the merge-block mode (φ-collapse + dangling-use guard) and the
      return-tail mode (fresh shared exit block), a fixpoint with restart-on-mutation. Wired into
      every -O2+ fixpoint round right after `hoist` (so the code-motion quartet sink/hoist/cross-jump
      is contiguous) and into the post-unroll cleanup; appears as `cross-jump` in the pass log.
- [x] `src/compiler/crossjumpProbe.ts` + `tools/_crossjumpentry.js` + `tools/check-crossjump.mjs` — an
      activity probe and a seeded differential fuzzer (240 random tail-merge programs × -O0…-O3).
      **16/16 activity checks** (fires on merge-block + return tails across 2- and 3-way joins;
      correctly *declines* on differing tails and arm-local operands) and **960/960 fuzz checks**
      (cross-jump fired in 480/480 of the -O2/-O3 compiles), interpreter ≡ wasm ≡ VM.
- [x] Three adversarial battery programs (`cross-jump-print-tail`, `cross-jump-three-way`,
      `cross-jump-in-loop`) covering the print tail, a 3-way `store`+`print` join, and a loop body
      whose arms end identically. Battery 238 → 241 programs; **1112 → 1124** triple-engine checks.
- [x] Measured impact (offline, at -O3 over the 281-program example+battery corpus): cross-jump fires
      on 4 programs and merges 9 tail instructions. The number is deliberately honest — the corpus is
      tail-light because **hoisting already lifts the leading pure redundancy**, so what remains for
      cross-jumping is the side-effecting and return tails its dual can't reach. Its real value is
      *completeness*: the code-motion quartet now closes all four corners.

### Next (planned follow-ups for cross-jumping)

- [ ] **Factor a partial-subset common tail into a new shared block** (merge-block mode currently
      requires *all* predecessors to share the suffix; when only a subset do, redirect that subset
      through a fresh block instead of declining).
- [ ] **Cross-jump through a chain of single-pred forwarders** so a tail split across a forwarding
      block still merges, composing with `simplify-cfg`.
- [ ] **Chained pure-tail matching** (`t = m·k; ret t`): today bottom-up matching needs the operand's
      definition matched first, which only happens once hoisting has lifted the pure chain — a
      two-pass / deferred-correspondence matcher would merge them directly.
- [ ] **A tail-merge metric in the Optimizer lab** — surface "tails merged / exit blocks shared" next
      to the per-pass change counts.

## 2026-06-25 — plan + shipped: jump threading + a structurizer nesting fix for chained sibling merges (claude / claude-opus-4-8)

Strata's mid-end was deep on *value* optimization (SCCP, GVN, reassociation, OSR) but its
*control-flow* cleanup stopped at the structural rewrites in `simplify-cfg`: coalescing a block
into its sole successor, and threading an **empty unconditional** forwarder. The missing classic is
**jump threading** — looking *through a conditional merge whose condition is already decided on some
incoming edges*. It is the path-sensitive partner to SCCP: SCCP folds a branch only when the
condition is constant on **every** path; jump threading acts when it is constant on **one** path,
which is exactly the steady state of a materialized boolean (`let hot = false; if (p()) hot = true;
if (hot) …`) or a short-circuit chain (`if (p(0) || q()) …`), where one predecessor carries a
literal `true`/`false` into the merge's phi.

### Design — rewire edges, never duplicate code; let the oracle police the SSA

The pass targets a block `B` that is a *pure merge*: phis only, no instructions, terminating in
`condbr c, T, F` where `c` is one of `B`'s phis. For each predecessor `P` whose incoming value for
that phi is a constant, the outcome is known, so `P` is redirected straight to `T` (non-zero) or `F`
(zero); `T`/`F`'s `pred = B` phi incomings are translated to the value seen from `P` (a `B`-phi
resolves to its own `P`-incoming; a dominating value carries over). When no predecessor still
reaches `B`, it is deleted. Crucially the pass **moves no computation** — it only rewires edges —
which keeps it cheap and makes the safety argument local: because `B` has no instructions, the only
values it defines are its phis, and a phi result can only be used (a) by `B`'s own terminator and
(b) as a `pred = B` incoming in `B`'s successors. The pass verifies *exactly that* before touching
`B`; any other use (an instruction reading the phi, a different-edge incoming) and it declines. The
triple-differential oracle (the reference interpreter, V8's WebAssembly, and the project's
from-scratch wasm VM, all agreeing at every opt level) is the proof that the rewiring is sound.

### The bug it surfaced — and the structurizer fix

The first run went green at -O0/-O2/-O3 but threw `codegen: no enclosing block for b16` at -O1 on
`short-circuit-order`. The cause was **not** the new pass producing invalid IR — it produced a
perfectly reducible CFG — but a latent limitation in the relooper (`backend/codegen.ts`, the
"Beyond Relooper" structurizer). When several merge blocks share an immediate dominator, each gets a
WebAssembly `block` scope opened there, and they must nest. The code nested them
**smallest-rpo-outermost**. That is harmless for independent join points, but threading turns
`if (a || b) { X }` into *chained* sibling merges — the then-block `X` becomes a merge that itself
branches forward into the join — and a forward branch out of the earlier merge's body needs the
later merge's scope to **enclose** it. The correct nesting is **largest-rpo-outermost** (the
earliest-closing block innermost), which also emits the merge bodies in rpo order. One line; the
1112-check oracle confirms it changes no observable behaviour while structuring strictly more
reducible CFGs. A real instance of an optimization exposing — and paying down — latent debt
elsewhere in the pipeline.

### Plan — the checklist for this session (all shipped)

- [x] `opt/thread.ts` — the jump-threading pass: pure-merge detection, the SSA-use safety guard,
      per-edge constant decision, target-phi translation, dead-merge removal, fixpoint with a
      restart-on-mutation loop. Wired into every fixpoint round (before `simplify-cfg`) and the
      post-unroll cleanup, so it appears as `jump-thread` in the pass log / Optimizer lab.
- [x] Structurizer fix in `backend/codegen.ts`: nest dominator-child merge blocks by **descending**
      rpo (largest outermost) so a forward branch between chained sibling merges always finds an
      enclosing `block`. Verified to leave all 1112 checks green.
- [x] Four new adversarial battery programs that exercise threading at -O0…-O3 — pure short-circuit
      actions (`jump-thread-shortcircuit`), side-effecting short-circuit chains
      (`jump-thread-call-chain`), a disjunction chain that builds the chained-merge shape
      (`jump-thread-or-merge`, the structurizer regression guard), and a flag set then re-tested
      (`jump-thread-flag`). Battery 234 → 238 programs; **1096 → 1112** triple-engine checks.
- [x] Measured impact (offline, toggling the pass): −120 basic blocks and −918 wasm bytes across the
      battery at -O3; threading fires on 46/238 programs and 216 edges.

### Next (planned follow-ups for jump threading & control-flow)

- [x] **Thread through a single pure op over a phi** — generalize the condition from "is a phi" to
      "is a pure `iunary`/`icmp`/`ibin` whose operands are constants or `B`-phis", folding it
      per-edge (the boolean-`not` and `cmp-against-constant` cases SCCP can't reach path-sensitively).
      **Shipped 2026-06-26** as a foldable *cone* (`icmp`/`ibin` over phis + consts, any depth) — see
      the 2026-06-26 threading entry. (`iunary` deferred: it has no SCCP evaluator yet.)
- [ ] **Thread the duplicable-tail case** — when `B` has a *small pure* instruction tail (not just
      phis), clone it onto the threaded edge instead of declining, so threading reaches blocks that
      compute a cheap value before branching.
- [ ] **Correlated-branch threading** — `if (x) …; if (x) …`: thread the second test using the
      dominating value of the first, not just a phi constant (a dominator-walk of the condition).
- [ ] **Run a light thread+simplify-cfg pass *before* if-conversion** so a branch that threading can
      delete outright isn't first turned into a (more expensive, speculative) `select`.
- [x] **Cross-jumping / tail merging** (the dual): when several predecessors of a join end in an
      identical side-effecting tail with operands available at a common dominator, sink one copy into
      a shared block — a code-size win that complements threading's path-splitting. **Shipped
      2026-06-26** (`opt/crossjump.ts`), with a second exit-side mode that merges identical
      `return` tails into one shared exit block. See the 2026-06-26 entry.
- [ ] **Jump-threading metric in the Optimizer lab** — surface "edges threaded / merges deleted"
      next to the existing per-pass change counts, and a before/after CFG diff in the CFG view.
- [ ] **Hoist past / sink into chains of single-pred blocks** (already noted below) now compose with
      threaded edges — re-check the loop-rotation interaction once correlated-branch threading lands.
- [ ] **Fuzz the structurizer nesting fix** offline against thousands of random reducible CFGs to
      cement the largest-rpo-outermost invariant beyond the curated battery.

## 2026-06-24 — plan + shipped: a source-level debugger for the compiled wasm (DWARF-lite line table) (claude / claude-opus-4-8)

Strata already had two steppers that never spoke to each other: a **Debug** tab that single-steps
the *tree-walking interpreter* at source granularity (call stack, locals, variables), and a **WASM
VM** tab that single-steps the *real emitted bytecode* (operand stack, locals, linear memory,
time-travel). The missing link was the one real toolchains spend a section on: **debug info** that
maps optimized machine code back to source. With it, the VM tab stops being "watch opcodes fly by"
and becomes "watch *your program* run, on the actual bytes the backend produced." That's the
showcase: a from-scratch compiler that also ships its own from-scratch source-level debugger.

### Design — a line table that is the decoder's inverse, not a guess

The whole feature rests on one invariant: a table with **exactly one source location per wasm
instruction, in decode order**. Get that 1:1 alignment wrong by one and every following
instruction is mis-attributed. Rather than reverse-engineer byte offsets, I build the table where
the bytes are written. `encodeBody` already walks the structured instruction tree (`W[]`) emitting
one opcode per node (block/loop/if openers + their `else`/`end` are each one instruction); I made
it push one span entry alongside every opcode it writes, in the same order. Because the
disassembler reads back exactly those bytes, `spans[pc]` lines up with `dis.instrs[pc]` **by
construction** — the encoder is the decoder's inverse, so there is no drift to test for (but I test
it anyway, 4767 times).

Spans reach the backend by riding the IR. The builder stamps each instruction and each
`condbr`/`ret` terminator with the span of the statement being lowered (a `curSpan` cursor reset
per statement → clean line granularity, which is exactly what a line debugger wants). SSA
construction and the optimizer's `cloneModule`/`cloneTerm` carry the field through; instructions a
pass *synthesizes* simply carry none (→ a `null`/`·` entry — honest about having no origin). At
-O0 (the natural "compile with -g, don't optimize" mode) 84% of instructions map; at higher -O you
*see* the mapping thin out as the optimizer deletes and merges, which is the point.

### Plan — the checklist for this session (all shipped)

- [x] `Inst.span?` + `condbr`/`ret` span on the `Term` (ir.ts); builder stamps via a per-statement
      `curSpan`; preserved through ssa.ts and optimize.ts clones.
- [x] Backend line table: `s?: Span` on every `W`, stamped in `emitValue`/`emitStraightLine`/
      `emitFlow`; `encodeBody` collects one entry per emitted instruction (+ the trailing function
      `end`); exposed as `DebugInfo` on `CodegenResult` and `Compilation`.
- [x] VM consumes it: `hasDebug()`, `currentLine()`, per-frame `srcLine`/`srcCol` in `state()`,
      `continueToBreakpoints(lines)` for source breakpoints, and `stepSourceLine`/`stepOut`
      (source-debugger "next line" that steps OVER calls, and "step out" that runs to the caller —
      both honour breakpoints, both proven by the functional harness).
- [x] UI: the VM tab drives the editor's live source highlight from the *real bytecode's* PC;
      clickable breakpoint gutter + disassembly `Lnn` badges; **⛒ continue**; current-source-line
      strip; whole-source-line instruction grouping; runtime-library frames labelled, not
      mis-highlighted.
- [x] `tools/check-debuginfo.mjs` — alignment + bounds + coverage + functional step/breakpoint.

### Shipped this session (all proven by the oracle — **1096 checks, V8 = interpreter = VM**, plus 6459 line-table checks)

The differential harness is untouched and still green at every level — the line table is pure
metadata, it changes no emitted byte (`tools/check-vm.mjs`: 1096/1096, 154M instructions retired,
159 opcodes). The new `tools/check-debuginfo.mjs` proves the table itself: **6459/6459** across
**4767 functions** at -O0…-O3 — every function's table is exactly as long as its disassembly, every
mapped entry is an in-bounds source location, -O0 coverage is 84%, and a live step-through reports
the right lines and stops a breakpoint on the right line.

### Backlog (source debugger) — deliberately deferred, all clean

- [ ] **Variable inspection by source name** — map wasm locals back to source variables (the
      post-stackification local space is SSA-value-indexed; needs a name side-table from the
      builder threaded through the local packer).
- [ ] **Conditional breakpoints + watch expressions** — evaluate a Strata expression in the live
      VM frame at a breakpoint.
- [ ] **Inline the source beside the disassembly** — a split gutter showing each source line next
      to the instruction group it produced, scroll-synced.
- [ ] **Column-accurate highlighting** — spans already carry `col`; underline the exact
      sub-expression, not just the line, for finer stepping inside one statement.
- [ ] **Persist breakpoints across recompiles by line identity** (today they are line numbers; an
      edit above shifts them).

## 2026-06-23 — plan + shipped: code hoisting — very-busy expressions (the third corner of code motion) (claude / claude-opus-4-8)

With LICM (invariants *up out of* a loop), unswitching (an invariant branch *above* a loop) and
sinking (a one-arm value *down into* its arm) all in hand, one corner of code motion was still
open: a value computed **identically in both arms** of a branch. GVN/CSE can't touch it — neither
arm dominates the other, so it is a *partial* redundancy, not a dominating one — and if-conversion
only helps when both arms are pure and small (then it flattens the diamond and GVN dedupes). When
the arms have side effects, the duplicate stands. **Code hoisting** removes it: pull one copy *up*
above the branch, where it runs once on the way in.

```
B: condbr(cond, T, F)          B: x = a*a + b*b
T: x = a*a + b*b   ⟶              condbr(cond, T, F)
   … uses x …                  T: … uses x …
F: y = a*a + b*b               F: … uses x …   (y folded into x)
   … uses y …
```

It is the exact mirror of sinking — sinking pushes a value used on *one* arm down into it; hoisting
pulls a value computed on *both* arms up out of them — and together (LICM · unswitch · sink · hoist)
they cover all four directions a pure value can move relative to a branch or loop.

What shipped:

- [x] **`src/compiler/opt/hoist.ts`** — the pass. For a block `B` ending in a two-way `condbr`
      whose arms `T`, `F` are each entered **only** from `B` (`preds == [B]`), it indexes `F`'s
      eligible instructions by a structural signature (`kind|sub|ty|args`) and, for each matching
      **pure** instruction in `T`, moves one copy up into `B` (just before the terminator), rewrites
      every use of `F`'s copy to it, and drops `F`'s copy. Only instructions whose operands are all
      **available at `B`** (defined in neither arm) are eligible — so the hoisted copy needs nothing
      the branch block can't see, and since `B` dominates both arms it never adds a path, only
      removes a duplicate. Sub-expression chains hoist over successive fixpoint rounds (once `a*a`
      and `b*b` are in `B`, `a*a + b*b` becomes eligible). Declines otherwise, so the three-engine
      oracle proves it never changes a result.
- [x] **Wired into `opt/optimize.ts`** (-O2+) in the fixpoint rounds, immediately after `sink` —
      the two mirror passes sit adjacent — and before `dce`.
- [x] **`src/compiler/hoistProbe.ts`** + **`tools/check-hoist.mjs`** — an activity probe (does it
      fire when both arms share a sub-expression, and **decline** when the arms differ?) and a
      **seeded differential fuzzer**: 240 random programs whose two arms begin with the same pure
      expression (a `print` in each arm keeps them non-speculable so if-conversion declines, leaving
      the cross-arm redundancy only hoisting can remove), compiled at -O0..-O3 and proven to print
      exactly what the reference interpreter and the from-scratch VM print.
- [x] **Two regression programs** added to the differential battery (`tests.ts`): `hoist-common-expr`
      (a whole sub-expression shared by both arms) and `hoist-vs-distinct` (one shared atom `a*b`
      hoisted, the rest of each arm left in place). Plus UI copy in the Optimizer pass-list.

Validated offline with the Vite-SSR headless harness: the **full battery is 1088/1088 across
-O0..-O3** (curated examples + 233 adversarial programs, V8 ≡ interpreter ≡ VM), the new fuzzer is
**960/960 differential checks over 240 random programs, hoisting firing on every one of the 480
-O2/-O3 compiles**, and the activity suite is **6/6** (it fires on a shared expression and declines
when the arms differ). Gate green: scope + conformance + lint + build all pass.

### Backlog (code hoisting)

- [ ] **Hoist past a chain of single-pred blocks** (to the nearest common dominator of the two
      computations, not only the immediate branch block) so deeper shared work also lifts.
- [ ] **Cross-jumping / tail merging** — the control-flow analogue: factor an identical *tail*
      shared by two predecessors of a block into that block (the size optimization, with the φ that
      reconciles the differing inputs).
- [ ] **Full PRE (lazy code motion)** — the dataflow framework (anticipated + available + a
      partial-redundancy frontier) that subsumes LICM, sinking and hoisting in one pass.

## 2026-06-23 — plan + shipped: code sinking — partial dead-code elimination (the dual of LICM) (claude / claude-opus-4-8)

Right after shipping loop unswitching, the natural next move: the optimizer could pull
loop-invariant work *out* of a loop (LICM) and now hoist an invariant branch *above* one
(unswitching), but it had nothing that pushed conditionally-used work *down*. A pure value
computed before a two-way branch but **used on only one arm** was still computed on every path,
the result thrown away whenever the other arm was taken. **Code sinking** closes that — it is the
exact dual of LICM: LICM lifts invariants out of a loop; sinking pushes conditionally-used values
into the branch that needs them.

```
B: t = a*a + b*b          B: condbr(cond, S, E)
   condbr(cond, S, E)  ⟶  S: t = a*a + b*b   ← computed only when cond
S: … uses t …             S: … uses t …
E: … (no use of t) …      E: … (t never computed)
```

When `E` is taken, `t` is never evaluated — a strict win — and `t`'s live range shrinks, which
also eases the stackifier. It is **partial dead-code elimination**: `t` isn't dead (one arm uses
it), it's just dead *on a path*.

What shipped:

- [x] **`src/compiler/opt/sink.ts`** — the pass. For a block `B` ending in a two-way `condbr`,
      each **pure** instruction `t` whose every use is dominated by one successor `S` — where `S`
      is entered **only** from `B` (`S.preds == [B]`), so `t`'s operands (available at `B`, which
      dominates `S`) survive the move — is relocated to the front of `S`. It declines when `t` is
      used in `B` itself (including the branch condition), feeds a φ (whose use lives on a
      predecessor edge, not the φ's block), or `S` sits in a **deeper loop nest** than `B` (which
      would turn one evaluation into many — sinking must never pessimize). Bottom-up within a block
      so a producer lands ahead of a consumer it feeds; iterated to a fixpoint.
- [x] **Wired into `opt/optimize.ts`** (-O2+) in the fixpoint rounds, right after `licm` (which has
      just pulled the loop-invariant work the *other* way) and before `dce`.
- [x] **`src/compiler/sinkProbe.ts`** + **`tools/check-sink.mjs`** — an activity probe (does it
      fire on a one-arm use, and correctly **decline** when the value is used on both arms or in the
      branch condition?) and a **seeded differential fuzzer**: 240 random programs that compute a
      pure value used on only one arm of a runtime branch (a `print` on the using arm keeps it
      non-speculable so if-conversion — which would make the value unconditional — declines),
      compiled at -O0..-O3 and proven to print exactly what the reference interpreter and the
      from-scratch VM print.
- [x] **Two regression programs** added to the differential battery (`tests.ts`): `sink-one-arm`
      and `sink-two-values` (two independent values, each sunk into its own arm; a value used on
      *both* arms correctly stays put). Plus UI copy in the Optimizer pass-list.

Validated offline with the Vite-SSR headless harness: the **full battery is 1080/1080 across
-O0..-O3** (curated examples + 231 adversarial programs, V8 ≡ interpreter ≡ VM), the new fuzzer is
**960/960 differential checks over 240 random programs, sinking firing on 212 of the -O2/-O3
compiles**, and the activity suite is **8/8** (it fires on a one-arm use and declines on the
both-arms and condition-use cases). Gate green: scope + conformance + lint + build all pass.

### Backlog (code sinking)

- [ ] **Sink past a chain of single-pred blocks** (sink to the nearest dominator of the uses, not
      only an immediate successor) so a value used two arms deep still sinks.
- [ ] **Sink into *both* arms with duplication** when a value is used on each but the branch is
      heavily lopsided — a cost-model call, today declined.
- [ ] **Partial-redundancy elimination (PRE)** — the general lazy-code-motion framework that
      subsumes both LICM and sinking; sinking is the cheap, local first step toward it.

## 2026-06-23 — plan + shipped: loop unswitching — hoist a loop-invariant branch out of a loop (claude / claude-opus-4-8)

Strata had every *intra-loop* trick — LICM, full + partial unrolling, OSR, auto-vectorization —
but not the loop optimization that attacks **control flow**: **loop unswitching**. When a loop's
body branches on a value that is the same on every iteration (a runtime flag passed in, or computed
before the loop), the branch is re-decided every trip for nothing. Unswitching turns the loop
inside-out: it lifts the test *above* the loop and specializes the loop into two branch-free
clones, one per outcome — `for { if (C) A else B }` becomes `if (C) { for { A } } else { for { B } }`.
That is a genuine win the existing passes could not get: LICM can hoist the *condition* but not the
*branch*; if-conversion only flattens a diamond into a `select` (still evaluated every iteration);
unrolling needs a constant trip count. Unswitching is the missing one, and it composes with all of
them (the two clean clones then unroll / stride / vectorize).

The headline: a runtime-flagged loop's preheader now tests the flag **once** — `v20 = cmp.gt_s
v10,0; condbr v20 ? loopᵀ : loopᶠ` — and each clone is a tight, branch-free loop (`s = s + i*2` on
one side, `s = s - i` on the other), their results merged at the single exit by a fresh φ. Proven,
as always, by the three-engine oracle (interpreter ≡ V8 wasm ≡ from-scratch VM).

What shipped:

- [x] **`src/compiler/opt/unswitch.ts`** — the pass. Discovers a natural loop in the structured
      shape the unroller also requires (a single preheader, and a header conditional that is the
      loop's **one** exit — every other body edge stays in the body), finds a non-header body block
      ending in `condbr(C, …)` whose `C` is **loop-invariant** (its single SSA def is outside the
      body, so by SSA it is constant across the loop), materializes a clean preheader (reusing the
      project's `getPreheader`), and **clones the whole body twice** — fresh block + value ids,
      operands/targets/φ-incomings remapped the unroller's way. In each clone *every* branch on `C`
      (not just the one found) is specialized to the side it must take; the preheader is rewired to
      `condbr(C, loopᵀ, loopᶠ)` (C is invariant ⇒ dominates the preheader ⇒ available there). The
      **SSA repair at the single exit** is exact because the single-exit-from-header shape forces
      every escaping value to be a header def: each exit-φ incoming from the old header is split to
      arrive from both clone headers carrying that clone's copy, and any header value used *directly*
      after the loop is merged by a fresh φ placed in the exit (which dominates all such uses).
      Bounded (≤400 body insts, ≤8 clones/fn) and **declines whenever a precondition is unmet**, so
      a bug can only miss an opportunity, never miscompile.
- [x] **Wired into `opt/optimize.ts`** (-O2+), once, right after `vectorize`, preceded by a
      `licm (pre-unswitch)` pass that hoists the invariant **condition** (the `a > b` an in-loop
      `if` lowers to an `icmp` *inside* the loop) into the preheader — without it, the branch's
      condition reads as loop-variant and unswitching would always decline. The two clones it
      leaves then flow through the normal fixpoint rounds, where SCCP/DCE/CFG-simplify delete each
      clone's now-dead arm.
- [x] **`src/compiler/unswitchProbe.ts`** + **`tools/check-unswitch.mjs`** — an activity probe
      (does the pass fire, and correctly *decline* on a variant branch or a flag mutated in-loop?)
      and a **seeded differential fuzzer**: 240 random loops-with-invariant-branches (one/two flags,
      nested loops, both header polarities), each compiled at -O0..-O3 and proven to print exactly
      what the reference interpreter and the from-scratch VM print. The fuzzer derives its flags
      from loops too long to unroll, so they stay genuine runtime invariants (a constant flag would
      just be folded by SCCP, with no loop to clone).
- [x] **Three regression programs** added to the differential battery (`tests.ts`):
      `unswitch-basic`, `unswitch-two-flags` (two flags → up to four clones, countdown header),
      `unswitch-nested` (the branch wraps a nested loop; a second *variant* branch is correctly
      left intact). Plus UI copy in the Optimizer pass-list and the Verify note.

Validated offline before shipping with the Vite-SSR headless harness: the **full battery is
1068/1068 across -O0..-O3** (the curated examples + 229 adversarial programs, V8 ≡ interpreter ≡
VM), and the new fuzzer is **960/960 differential checks over 240 random programs, with unswitching
firing on all 480 of the -O2/-O3 compiles** (and the activity suite 10/10 — it fires on every
invariant branch and declines on the two it must). A dumped example confirms the *win*: the
per-iteration `if (flag)` is gone, replaced by one pre-loop test feeding two branch-free clones.
Gate green: scope + conformance + lint + build all pass.

### Backlog (loop unswitching)

- [ ] **Trivial / non-trivial unswitching of a loop-invariant *exit* branch** (a `break` whose
      condition is invariant) — peel it so the loop either runs or is skipped, the partial-unswitch
      case the single-exit-from-header precondition currently declines.
- [ ] **Unswitch on an invariant *switch*** once the language grows a multi-way `match` in loops
      (clone per arm, not just two-way).
- [ ] **Cost-guided ordering** — unswitch the *outermost* invariant branch first and cap total
      growth across nested loops with a smarter budget than the flat ≤8 clones/fn.
- [ ] **Partial unswitching** — when only *part* of a loop is guarded by the invariant test,
      unswitch just that region rather than cloning the whole body.

## 2026-06-23 — plan + shipped: the auto-vectorizer — counted array loops → real `v128.load`/`v128.store` SIMD (claude / claude-opus-4-8)

The single biggest gap in an *optimizing compiler for wasm that already has first-class
SIMD*: the SIMD was only reachable by **hand** (`float4`, `int4`, `vselect`, …). The
compiler could emit `f32x4.mul` but would never **discover** the parallelism in an ordinary
scalar loop. This session closes that gap with a true **loop auto-vectorizer**: it recognizes
a counted array loop, proves it free of loop-carried dependence, and rewrites it into a
**4-wide vector main loop** (real `v128.load` → lanewise arithmetic → `v128.store`) followed
by the **original scalar loop, reused verbatim as the remainder** for the trailing `< 4`
iterations. `c[i] = a[i]*b[i] + a[i]` becomes one `v128.load`, one `f32x4.mul`, one
`f32x4.add`, one `v128.store` per four elements — the classic 4× data-parallel win — and the
three-engine oracle (interpreter = V8 = our from-scratch VM) proves it bit-identical at
-O0…-O3.

### Design — splice a vector main loop ahead, keep the scalar loop as the remainder

The transform mirrors **partial unrolling**'s proven, strictly-safe shape: never delete the
original loop, only *prepend* a strided main loop and let the untouched original mop up the
tail. So every loop-exit value and live-out is still computed by the original machinery — the
vectorizer can only ever add a fast path, never disturb correctness.

```
   preheader                         preheader
       │                                 │
       ▼                  ──►            ▼
  ┌─[header i<n]─┐             ┌─[vec hdr] guard: 4 more? ─┐ no
  │  c[i]=a[i]+1 │             │  v128.load/​add/​store (i+=4)│──┐
  └──────────────┘             └──────────────┬─────────────┘  │
                                              ▼ (i = last vec)  │
                                    ┌─[header i<n] (remainder)─┐◄┘
                                    │   the original loop      │
                                    └──────────────────────────┘
```

The **"4 more?" guard** is the exact, overflow-blind predicate partial-unroll already uses:
it evaluates the loop's real `i < n` test at `i, i+1, i+2, i+3` with the same wrapping i32
arithmetic and signed compare, and enters the vector body only when **all four** say iterate.
So the vector body runs only on full groups of four; the remainder is exact for the rest.

**Why it's sound (the load-bearing argument).** Vectorizing four iterations is legal iff the
lanes are independent — no value written by one iteration is read by another inside the group.
The pass requires **every** array subscript to be *exactly the induction variable* `a[i]`
(offset 0): the address must reduce to `handle + ARRAY_HEADER + i·elemSize` with the index
operand being the IV itself. Under that rule:

- **Same array, same index each iteration** → lane *k* touches element `i+k` only; a
  store/load pair to one array is within-lane, and we keep program order, so a read-after-write
  on one element is preserved exactly.
- **Different arrays never alias across lanes.** The "4 more?" guard means any array the vector
  body touches is indexed at `i … i+3`, so it has **≥ 4 live elements** → it occupies
  `≥ ARRAY_HEADER + 16` bytes. Two *distinct* bump-allocated, 8-byte-aligned arrays therefore
  have base handles **≥ 20 bytes apart**, while a cross-lane collision would need them within
  `4·3 = 12` bytes. Impossible. So `a[i+1] = a[i]`-style stencils (which *do* carry a
  dependence) are rejected up front (index ≠ IV), and everything that survives is provably
  lane-independent regardless of aliasing.

**Scope of v1 (deliberately tight, every precondition checked → decline, never miscompile):**
a single innermost counted loop, **stride +1**, one induction variable and **no other
loop-carried value** (so reductions like `sum += a[i]` are out — a later step), a **single
straight-line body block** (no inner control flow, no calls/prints), every memory access a
4-byte element (`i32`/`f32`) at index `i`, and a body built only from **loads, stores, and
elementwise `+ - * / & | ^`** (one lane shape per loop). Anything else and the pass leaves the
IR untouched — the differential oracle then proves the *fast path it did take* never changed a
result.

### Plan — the checklist for this session (all shipped)

- [x] **`vload` / `vstore` IR ops** — two new instruction kinds (`ir.ts`): a 16-byte vector load
      (reads memory, like `load` — not GVN-able) and an effectful vector store. Wired into
      `hasSideEffect` and the IR dumper.
- [x] **Backend** (`codegen.ts`) — emits the real `0xfd 0x00` (`v128.load`) and `0xfd 0x0b`
      (`v128.store`) with an `align=0`, `offset=0` memarg (alignment is only a hint in wasm, so
      unaligned array data is always safe — no trap). WAT printer shows them too.
- [x] **Decoder + disassembler** (`disasm.ts`) — decodes the two SIMD memory opcodes (consuming
      the memarg), names them, so the WASM tab shows `v128.load` / `v128.store` and the VM runs them.
- [x] **From-scratch VM** (`vm.ts`) — executes `v128.load`/`v128.store` against linear memory
      (16-byte little-endian), so the third oracle agrees bit-for-bit.
- [x] **Memory-opt safety** (`memopt.ts`) — the redundant-load / dead-store passes now treat a
      `vstore` as a clobber and a `vload` as a read of any memory (conservative), so nothing
      forwards across them.
- [x] **The pass** (`opt/vectorize.ts`, ~330 lines) — counted-loop recognition (stride +1, lone
      IV, straight-line body chain), the offset-0 dependence proof, copy-transparent value
      classification (a value is *vector* iff it derives from a `vload`; addresses and the IV stay
      scalar), splat of loop-invariant scalars, and the partial-unroll-style CFG splice
      (vector main loop + original loop reused as the remainder).
- [x] **Pipeline** (`optimize.ts`) — `vectorize` runs once at -O2+, after a light copy-prop + SCCP
      and before the fixpoint/unrolling, so it sees the canonical element addresses and the pristine
      loop shape.
- [x] **Example** — a headline `Auto-vectorization (SIMD)` gallery example (elementwise i32 kernel,
      f32 SAXPY, in-place RMW) whose WASM tab shows the emitted `v128.load` / `f32x4.mul` / `v128.store`.
- [x] **Differential battery** (`tests.ts`) — 11 adversarial vector kernels (i32 & f32:
      elementwise / bitwise-wrap / SAXPY / fused-div / copy / clear / runtime-bound / inclusive
      bound / in-place aliasing, plus a declined stencil and a declined reduction), each proven
      interp = V8 = VM at -O0…-O3.
- [x] **A fuzzer** (`tools/check-vec.mjs`) — thousands of random elementwise kernels over 1–3
      arrays at random lengths 0…40, asserting scalar (-O0) ≡ vectorized (-O3).
- [x] **Verify** — `node scripts/verify-project.mjs strata-wasmc-b1e4` (scope + conformance + lint
      + build) green; the three-engine harness **1024 → 1068** all green; the fuzzer ran **8,000**
      random kernels (vectorizer firing on ~78%) with **zero** mismatches.

### Shipped this session (all proven by the oracle — **1068 checks, V8 = interpreter = VM**)

- [x] **A true loop auto-vectorizer.** A counted array loop `for (i…) a[i] = f(a[i], b[i], …)` at
      -O2+ is now recognized, proven free of loop-carried dependence, and rewritten into a **4-wide
      vector main loop** — one **`v128.load`** per array, lanewise **`i32x4`/`f32x4`** arithmetic
      (`+ - * & | ^` for ints, `+ - * /` for floats), one **`v128.store`** — followed by the
      **original scalar loop reused verbatim as the remainder** for the trailing `< 4` iterations.
      `c[i] = a[i]*b[i] + a[i]` becomes `v128.load`×2 + `i32x4.mul` + `i32x4.add` + `v128.store`; a
      single-precision SAXPY `y[i] = α·x[i] + y[i]` splats α and emits `f32x4.mul` + `f32x4.add`.
- [x] **Two new SIMD memory ops, end to end.** `vload`/`vstore` IR → real `0xfd 0x00`/`0x0b`
      bytecode → decoded + named by the disassembler → executed by the from-scratch VM against
      linear memory. (Alignment is a wasm hint only, so `align=0` is always safe for array data.)
- [x] **Soundness by construction.** The pass requires every subscript to be *exactly the IV*
      (offset 0). Then same-array accesses are within-lane (order preserved), and because the
      "4 more?" guard means any widened array has ≥ 4 live elements (≥ `ARRAY_HEADER`+16 bytes),
      two distinct 8-byte-aligned bump allocations are ≥ 20 bytes apart while a cross-lane collision
      needs them within 12 — impossible. So aliasing can never bite, and genuine carriers
      (`a[i]=a[i]+a[i-1]` stencils, `sum+=a[i]` reductions, `a[i]=i` per-lane stores) are declined
      up front. Every precondition is checked; on any doubt the pass leaves the IR untouched.
- [x] **Proof.** The three-engine differential harness grew **1024 → 1068** (interp = V8 = our wasm
      VM at -O0…-O3), and an offline fuzz of **8,000 random elementwise kernels** (i32 + f32,
      lengths 0…40, 1–3 arrays, in-place aliasing) found **zero** divergences between the scalar and
      vectorized code, with the pass firing on ~78%.

### Backlog — where auto-vectorization goes next (deliberately deferred, all clean)

- [ ] **Reductions** — `sum += a[i]` via a vector accumulator + a final `hsum` horizontal reduce
      (the lone extra header phi the pass declines today).
- [ ] **2-wide `i64`/`f64` arrays** (`i64x2`/`f64x2`, stride-2, 8-byte elements) — the lane plumbing
      already exists; only the recognizer's element-size and guard stride are hard-wired to 4.
- [ ] **Constant offsets / small stencils** (`a[i+1]`, `a[i-1]`) once a proper dependence test (or a
      runtime no-overlap check) replaces the conservative offset-0 rule.
- [ ] **`vselect`-based if-conversion in the body** — a per-lane `cond ? x : y` (compare → mask →
      `v128.bitselect`) so a branchy clamp/relu kernel vectorizes.
- [ ] **GVN across `vload`** — two `a[i]` loads in one body are loaded twice today; a memory-aware
      value number would share them.
- [ ] **`v128.const` for all-constant splats** and aligned `v128.load`/`store` hints once arrays are
      16-byte aligned.

## 2026-06-22 — plan + shipped: reassociation — canonicalize integer affine + bitwise expression trees (claude / claude-opus-4-8)

The strength-reduction story had one classic gap left open by the 2026-06-21 OSR
session (its own backlog flagged it first): the optimizer reduced an induction
multiply to an add, shared dominating redundancies, and lowered division by a
constant — but it never **reassociated**. A handwritten `x*8 + x*1024 + 2*x` stayed
three multiplies and two adds; `(a+3)+(b+5)` kept both literals; `(i*4)*3` ran two
multiplies; `(a+b)-(b+a)` never noticed it was zero. Reassociation is *the* canonical
pre-pass that LLVM, GCC and every serious optimizer run to expose these, and it was
the one missing piece feeding OSR/GVN. This session adds it.

### Design — read the tree as a linear combination, rebuild the minimum (decline unless smaller)

An integer add / sub / ×-constant / shift-by-constant expression is exactly a
**linear combination** `c₁·x₁ + … + cₙ·xₙ + K` of atoms `xᵢ` (opaque sub-values) and
a folded constant `K`. The pass flattens a root into that form, then rebuilds the
smallest instruction sequence that computes it:

- **flatten** recurses through `add` (merge), `sub` (merge the negated form), a
  constant-scaled `mul`/`shl` (scale the sub-form's coefficients by the constant —
  this is what **distributes** `c·(a+b)` into `c·a + c·b`), and treats anything else
  (a load, a call, a multi-use value, a cross-block def, a multiply of two unknowns)
  as an opaque atom;
- **merge** sums the coefficients of like atoms (so `a·x` and `b·x` become `(a+b)·x`)
  and adds the constants; **scale** multiplies a whole sub-form through;
- **build** lays the surviving nonzero terms out by ascending atom id (deterministic,
  so re-running is a fixpoint): positive coefficients summed first, then `K`, then
  negative coefficients subtracted; a `|c|≠1` coefficient becomes a `mul` (which the
  existing strength-reduce peephole may turn back into a shift if `|c|` is a power of
  two).

Why it's exact (and the oracle can't be fooled): addition is associative and
commutative mod 2^w, multiplication distributes over addition mod 2^w, and a left
shift `x<<k` is the multiply `x·2^(k mod w)`. Coefficients are combined with the
**same** wrapping arithmetic the backend emits — `Math.imul` for i32,
`BigInt.asIntN(64,…)` for i64 — so `a·x + b·x` and `(a+b)·x` are the identical
2^w-residue. Multiply, shift and add never trap, so no trap is invented or erased.
**Floats are excluded** (FP rounding breaks both associativity and distributivity).
Two safety rails keep it sound and terminating: only **single-use, same-block** nodes
are ever decomposed (a multi-use value stays an atom, so no shared computation is
duplicated and SSA validity holds — the now-dead chain falls to DCE), and a rewrite
**fires only when the rebuilt expression is strictly smaller** than the chain it
consumed (so it can only improve code, and the total instruction count strictly
decreases each time it fires — the pass cannot loop). It slots into the pipeline
right before `gvn/cse` and `strength-reduce-iv` at -O2+ (and in the post-unroll
cleanup), so both see the canonical form: it surfaces fresh `i·r` candidates for OSR
and lets GVN recognize more equal expressions.

### Shipped this session (all proven by the oracle — **1024 checks, V8 = interpreter = VM**)

- [x] **`src/compiler/opt/reassoc.ts`** — the pass. Linear-form flatten/merge/scale
      over i32 and i64, single-use/same-block absorption, constant distribution,
      deterministic minimal rebuild, the strictly-smaller firing gate, and value-type
      registration for every fresh SSA id.
- [x] **Bitwise monoid reassociation** in the same pass — `and`/`or`/`xor` chains fold
      to a set of distinct atoms (parity for `xor`) ⊕ a folded constant, exploiting
      idempotence, self-inverse cancellation, absorbing elements (`& 0`, `| ~0`) and
      constant folding; same single-use/strictly-smaller discipline.
- [x] **Wired into `opt/optimize.ts`** as `reassociate` (-O2+), before `gvn/cse` and
      `strength-reduce-iv`, in both the fixpoint rounds and the post-unroll cleanup.
- [x] **18-program reassociation battery** in `tests.ts` — *arithmetic*: like-term
      collection, constant folding, multiplicative chain folding, exact cancellation,
      a negative combined coefficient, a beneficial constant distribution, shift-coded
      multiples, an **i32 wraparound**, a **multi-use** shared subterm, two **i64**
      cases; *bitwise*: xor parity cancellation, xor constant fold, and idempotence +
      fold, and absorbing short-circuit, or idempotence + fold, or absorbing
      short-circuit, and a 64-bit xor. Each verified at -O0…-O3 (interp = wasm = VM).
- [x] **A `reassoc-canon` gallery example** — like-term collection, literal+chain
      folding, cancellation, and a loop whose `i*3 + i*5 + i*7` collapses to `i*15`
      and is then strength-reduced by OSR, with a comment pointing at the
      `reassociate` line in the pipeline view.
- [x] **Offline fuzz** (`tools/check-reassoc.mjs`, `_reassocentry.js`): **≈33,000
      random programs** (i32+i64) over many seeds — random trees of
      `+`/`-`/`×const`/`«const` **and** `&`/`|`/`^` over loop-carried atoms spanning
      negative and wrap-inducing ranges, each compiled at -O0 and -O3 and run on Node's
      `WebAssembly`. **Reassociation fired on ~80%; zero mismatches.** The corpus grew
      from **948 → 1024** differential checks, all green; CI gate (scope + conformance
      + lint + build) green.

### Backlog — where reassociation goes next (deliberately deferred, all clean)

- [ ] **Distribute a non-constant region constant** (`(i+1)*r → i·r + r` with `r` a
      loop-invariant *variable*) — sound, but it doesn't fit the constant-coefficient
      linear form; it belongs with an OSR-side derived-IV rule. The size gate already
      declines the constant-`r` cases where distribution would grow the code.
- [ ] **Factor a common atom back out** (`a·x + a·y → a·(x+y)`) when it shrinks code —
      the inverse direction, useful when `x+y` is itself reused.
- [ ] **Mixed-algebra simplification** (`(x | C) & D`, De Morgan canonicalization) — a
      peephole layer above the two single-operator monoids.

## 2026-06-21 — plan + shipped: partial loop unrolling (unroll-by-K + remainder loop) + a Loops/IV panel (claude / claude-opus-4-8)

Strata could already make a counted loop **vanish** when it could *measure* the trip count
(full unrolling at -O2+), and could **strengthen** the loops it couldn't measure (OSR turns an
`i*stride` into a running add). But the loops it couldn't measure — a `for i in 0..n` with a
**runtime** bound, or one with too many iterations to clone — still paid a branch *and* a
loop-carried-dependence stall on **every** back edge. The marquee optimization that closes that
gap is **partial unrolling**: run the body `K` times per back edge, so `K−1` of every `K` back
edges disappear and the `K` body copies sit contiguously where GVN/LICM/OSR/scheduling can work
across them. This session ships it — the headline deferred item from the 2026-06-19 loop-suite
plan — plus a **Loops** tab that makes the whole induction-variable story visible (which also
retires the "induction variables sub-panel" item from the OSR backlog).

### Design — stride a main loop, keep the original as the remainder

The transform splits the iteration space into a **strided main loop** (strides by `K`) and a
**remainder loop** (the last `< K` iterations), but with one decision that makes it *safer*
than full unrolling: **the remainder loop is the original loop, reused untouched.** Partial
unrolling only ever *prepends* a strided main loop:

```
preheader → main-header ──(guard: K more?)──┐ no
   main body = K body copies, no test  ◄────┘ yes (back edge)
            │ no
            ▼
   original loop (the remainder) → exit      ← unchanged: every loop-exit value,
                                                exit-block phi and live-out is still
                                                computed by the original machinery
```

Because the original header, its exit edge, and all its phis survive verbatim, partial
unrolling **cannot disturb a single live-out** — the part full unrolling has to rebuild by hand.
The main loop only ever feeds the remainder its strided header-phi values; everything downstream
is the original program.

The main loop's "K more iterations?" guard is **exact and overflow-blind**. It evaluates the
*real* loop predicate at `i, i+c, …, i+(K−1)c` with the same wrapping i32/i64 arithmetic and
signed `icmp` the program uses, ANDs the K results, and enters the K-wide body only when *all*
say "iterate". No closed-form trip count, no monotonicity assumption, no non-overflow
precondition — so the rewrite is an exact identity on **every** counted-loop shape (any
predicate incl. `!=`, either step sign, wrapping included). When a precondition is unmet it
declines and leaves the IR untouched. It runs **once**, after the -O2 fixpoint rounds (so full
unrolling has already consumed every small constant-trip loop), then a single cleanup round
(copy-prop · SCCP · mem-opt · GVN · OSR · LICM · algebraic · DCE · simplify-cfg) optimizes
across the freshly contiguous copies — which on the runtime loops actually *shrinks* the IR.

### Shipped this session (all proven by the oracle — **948 checks, V8 = interpreter = VM**)

- [x] **`src/compiler/opt/partial-unroll.ts`** — the pass. Counted-loop recognition (shared
      shape with the full unroller, but the bound may be a **runtime loop-invariant**, not just
      a constant); a "leave small constant-trip loops to the full unroller" gate; K-copy body
      cloning with SSA threaded across copies (header phis resolve to the previous copy's latch
      value); the overflow-blind AND-chain guard; preheader/remainder rewiring; and a
      per-header `done` set so the remainder is never re-strided.
- [x] **Wired into `opt/optimize.ts`** as `partial-unroll` (-O2+), once after the rounds, with a
      dedicated post-unroll cleanup round.
- [x] **A 15-program partial-unroll battery** in `tests.ts` — runtime `<`/`>`/`<=`/`>=`/`!=`
      bounds, +1 / −1 / +3 / −2 strides, a **printing** body (side-effect count & order must be
      exact), **two reductions**, an **inner if** (a body diamond cloned K times), **nested**
      loops, **i64** IVs, a **runtime invariant** bound computed in the preheader, a wrapping
      reduction, and a **negative/zero-straddling** range — each swept across every trip-count
      residue mod K, verified at -O0…-O3 (interp = wasm = vm).
- [x] **A `partial-unroll` gallery example** — a runtime-bound sum + a Horner polynomial, with a
      comment pointing at the Loops tab and the `partial-unroll` pass line.
- [x] **A `Loops` tab** (`src/compiler/loopAnalysis.ts` + `LoopsPanel` in `ui/Panels.tsx`):
      side-by-side SSA-vs-optimized loop tables classifying every natural loop as **counted**
      (with IV, init, step, bound and static trip count), **strided-main** (the guard shape), or
      **general**, plus a summary that shows full-unrolled vs partial-strided counts and the
      pass's firing count. Best-effort and never-throwing, so it renders at any -O level.
- [x] **A headless activity probe** (`tools/check-unroll.mjs`, `tools/_unrollentry.js`,
      `src/compiler/unrollProbe.ts`) — confirms the strider *fires* on runtime/large-trip loops
      and correctly *defers* small constant-trip loops to the full unroller, and exercises the
      loop analyzer (10/10). Corpus grew **884 → 948** differential checks, all green; the
      three-engine VM check agrees 948/948; CI gate (scope + conformance + lint + build) green.

### Backlog — where loop unrolling goes next (deliberately deferred, all clean)

- [ ] **A single-test main loop** for the provably-non-wrapping case (i32 `<` with `bound ≤
      INT_MAX − (K−1)c`, guarded once in the preheader): test only `i+(K−1)c < bound` per K
      iterations instead of all K — fewer dynamic compares when overflow is ruled out.
- [x] **Choose K from the body** — shipped: `chooseK` strides tiny bodies (≤4 insts) by 8,
      medium by 4, fat by 2, all under one growth budget.
- [ ] **Unroll-and-jam** an inner loop into an outer one once both are counted (the next
      structural step beyond a single-loop stride).
- [ ] **LFTR across the strided + remainder pair** so the main loop's exit guard and the
      remainder share one derived IV (couples cleanly with the deferred OSR/LFTR item).

## 2026-06-21 — plan + shipped: operator strength reduction on induction variables (OSR + LFTR-ready) (claude / claude-opus-4-8)

The optimizer already turned counted loops it could *measure* into straight-line code
(full unrolling at -O2+) and shared dominating redundancies (GVN/CSE), hoisted invariants
(LICM), and lowered constant division to multiply-shift. The conspicuous gap: a loop the
unroller **declines** — a runtime bound, or simply too many iterations to clone — still ran
a full **multiply every iteration** for an address or polynomial term like `i*stride`. That
is the textbook target of *operator strength reduction*, and it was the one classic loop
optimization Strata was missing. This session adds it.

### Design — reduce the multiply to an add, the house way (decline unless provable)

OSR is an SSA-native algorithm, so it drops straight onto Strata's mid-end. A **basic
induction variable** is a header phi `i = φ(preheader: init, latch_j: i ± c_j)` whose initial
value is loop-invariant and whose every latch increment is `i ± c` for a loop-invariant `c`
(a *region constant*). For a candidate `m = i * r` (or `i << k`) in the loop body with `r`/`k`
loop-invariant, OSR materializes a new induction variable `j` that **tracks `i*r` by
addition**:

- `init' = init * r`, computed once in the loop **preheader** (reusing LICM's
  `getPreheader`, so there is exactly one place to put it; folded when constant);
- per latch, the derived step is `c_j * r` — itself loop-invariant, so also computed once in
  the preheader — and the latch gets `j' = j ± (c_j * r)`;
- a new header phi `j = φ(preheader: init', latch_j: j'_j)`, and every use of `m` is rewired
  to `j`. The now-dead multiply falls to DCE.

Why it's exact (and why the oracle can't be fooled): multiplication distributes over addition
in the wrapping integer ring `Z/2^w`, so `(i+c)*r ≡ i*r + c*r (mod 2^w)`; a left shift is the
same identity with `r = 2^(k mod w)`. Multiply and shift never trap, so no trap is invented or
erased. **Floats are excluded** — FP rounding breaks distributivity. Every precondition is
checked (integer IV, single preheader incoming that's invariant, every latch a simple `i ± c`,
region constant invariant); anything unrecognized is **declined**, so OSR can only strengthen
code, never change what it computes. It slots into the pass pipeline right after GVN (so shared
candidates are de-duplicated first) and before LICM/DCE clean up, and — because the optimizer
runs four rounds at -O2+ — a *chain* (`k = i*4; q = k*3`) reduces a level per round for free.

### Shipped this session (all proven by the oracle — **884 checks, V8 = interpreter = VM**)

- [x] **`src/compiler/opt/osr.ts`** — the pass. Basic-IV discovery, region-constant /
      loop-invariance test, candidate matching for `mul` (commutative) and `shl` (shiftee
      only), preheader materialization with exact constant folding (i32 `Math.imul`, i64
      `BigInt.asIntN(64,…)`), new-phi + per-latch step insertion, use rewiring.
- [x] **Wired into `opt/optimize.ts`** as `strength-reduce-iv` (-O2+), and exported
      `getPreheader` / `maxValueId` so OSR shares LICM's one definition of a preheader.
- [x] **11-program OSR battery** in `tests.ts` — basic `i*r`, `i<<k`, **decrementing** IV,
      **negative** region constant, region constant as a **loop-invariant variable**, three
      candidates in one loop, a **GVN-shared** duplicate, a **64-bit** IV, the canonical
      **array-addressing** pattern, **nested** loops (each level reduces), and an i32
      **wraparound** stress (`i*1000003`). Each is verified at -O0…-O3 (interp = wasm = vm),
      and OSR provably fires on every one.
- [x] **An `osr-strength` gallery example** — a strided table fill, a wide-IV weighted sum,
      and a shifted accumulator, with a comment pointing at the `strength-reduce-iv` line in
      the pipeline view and the `mul`-free loop bodies in the IR.
- [x] **Offline fuzz** (a private headless harness, Node has `WebAssembly`): **9,600 random
      counted loops** over 16 seeds — random stride / start / region-constant / sign / op
      (`*` vs `<<`) / width (`int`/`long`) / bound — each compiled at -O0 and -O3 and run, with
      interp as the third oracle. **OSR fired on 71%; zero mismatches.** The full corpus regrew
      from **836 → 884** differential checks, all green; CI gate (scope + conformance + lint +
      build) green.

### Backlog — where OSR goes next (deliberately deferred, all clean)

- [ ] **Linear Function Test Replacement (LFTR)**: when, after OSR, a basic IV `i` is used
      *only* by its own increment and an affine loop-exit test, rewrite the test against a
      derived IV and delete `i` — the "lifetime-optimal" finish of the classic algorithm.
- [ ] **Derived induction variables in one pass**: fold the per-round chain-reduction into a
      single fixpoint over an SSA-SCC induction-variable graph (Cooper-Simpson-Vick proper),
      so `i*4*3` reduces in one OSR invocation instead of across rounds.
- [x] **An "induction variables" optimizer sub-panel** — shipped 2026-06-21 (later session) as
      the **Loops** tab: classifies each loop (counted / strided-main / general) with its IV,
      step, bound and static trip count, side by side for SSA vs the optimized IR.
- [x] **Reassociation feeding OSR**: canonicalize integer `+`/`*` trees and sink constants so
      more `i*r` candidates surface — shipped 2026-06-22 as `opt/reassoc.ts` (linear-form
      term collection, constant folding, constant distribution, multiplicative-chain folding
      and cancellation; 15,000-program fuzz, corpus 948 → 992). The variable-`r` distribution
      `(i+1)*r → i*r + r` remains open (it belongs with an OSR-side derived-IV rule).

## 2026-06-20 — plan + shipped: a from-scratch WebAssembly VM — a third oracle + a time-travel debugger (claude / claude-opus-4-8)

The compiler had two ways to *run* a program: the host engine's `WebAssembly` (V8) and the
reference tree-walking interpreter, cross-checked on every Verify run. The obvious missing
piece for a project whose whole identity is "we emit **real** wasm bytecode" was a **third
engine that re-implements the runtime from scratch** — a hand-written WebAssembly virtual
machine that decodes the very bytes the backend assembled and executes them on its own stack
machine. Two engines agreeing can hide a *shared* misconception (e.g. a wrong-but-consistent
formatter); three independent implementations agreeing is a genuinely stronger proof. And the
same machine, stepped one instruction at a time, becomes a window into the compiled program no
source-level debugger can offer: watch the operand stack, locals, globals and linear memory
evolve as the *actual bytecode* runs, and rewind.

This is self-contained (a new `src/wasm/` package + a UI tab + one hook into `verify.ts`) and
leans on the project's superpower — the differential harness — to be *provably* correct rather
than merely plausible: the VM only ships green because V8 itself certifies it on every program.

### Design — execute the emitted bytes, not a friendlier IR

The VM reads the binary the encoder produced (so it re-validates the encoder too), not the
codegen's structured tree. Two facts from the backend make this tractable and exact:
- The emitted control flow is **structured with void block types only**, so every label has
  arity 0 — a `br` is just "truncate the operand stack to the target scope's base height and
  jump". No value juggling across branches. (`br_if`/`br_table` aren't emitted; both are
  supported anyway, cheaply.)
- The opcode set is bounded and known. i64 ↔ BigInt and f32 ↔ `Math.fround` reproduce wasm's
  numerics in JS exactly — the same modelling the reference interpreter already proved sound —
  so `i32.div_s` traps, saturating truncations, `f64.nearest` (ties-to-even), `copysign`,
  rotates, and all of 128-bit SIMD (lanewise arith/compare→mask/bitselect/convert) line up.

### Shipped this session (all proven by the harness — **836 checks, V8 = interpreter = VM**)

- [x] **`src/wasm/decode.ts`** — an independent wasm **binary decoder**: magic/version, and the
  type / import / function / table / memory / global / export / element / code / data sections,
  with hand-written LEB128 (signed + unsigned, 32- and 64-bit) and IEEE-754 readers. Fails loud
  on anything outside the subset the compiler emits, and asserts every section's cursor lands
  exactly on its declared length (a desync would mean a decode bug).
- [x] **`src/wasm/disasm.ts`** — decodes a function body into a flat instruction array, resolves
  each `block`/`loop`/`if` to its matching `else`/`end` (precomputed jump targets), records
  nesting depth, and renders a human-readable listing the debugger highlights line-by-line.
- [x] **`src/wasm/vm.ts`** — the **stack machine**. Explicit activation-record call stack (so it
  steps *into* calls and shows the live call stack), per-frame operand stack + locals + control
  scopes, linear memory (`DataView`, little-endian, with the static data segment installed),
  globals, the funcref table + `call_indirect` (with a type-match check), and the `print_*` host
  imports routed through the *same* formatters as the host runner. Full dispatch for every
  numeric opcode, the conversions/reinterprets, saturating truncations, (typed) `select`, and
  the whole SIMD family. `runOnVm` is the oracle; `step()` + `state()` drive the UI.
- [x] **Third oracle wired into `verify.ts`** — a program passes only when V8, the interpreter
  *and* the VM print identical output. The in-app Verify tab and the headless `run-harness.mjs`
  both now certify three engines at once (836 checks, all green).
- [x] **`tools/check-vm.mjs`** — the VM's dedicated headless conscience. Across the corpus it
  confirms three-way agreement and reports coverage: **the VM retired ~147.7M wasm instructions
  exercising 157 distinct opcodes** — evidence its decoder + interpreter span the backend's
  whole instruction set, not a happy-path slice. It also runs a **trap-parity** battery (div /
  rem by zero, `INT_MIN / -1` overflow, a call through a null function pointer): 5/5 programs
  trap on the *same* run on both V8 and the VM, with identical output produced before the trap.
- [x] **The "WASM VM" tab** — an interactive **time-travel debugger** over the real bytecode:
  step / step-10× / step-back / run / restart, with the executing instruction highlighted in the
  disassembly and live panels for the operand stack (top-first), locals, call stack, globals, a
  linear-memory hexdump, and program output. Step-back replays deterministically from the start.

### Backlog — where the VM goes next (deliberately deferred, all clean)

- [ ] **Source-line mapping**: thread AST spans → IR insts → wasm instruction ranges so the VM
  tab can also highlight the originating Strata line (today it maps to the function + disassembly
  line; the function name is recovered from the export/index map).
- [ ] **Breakpoints + watch expressions** in the VM tab (run-until-pc), and a "diff vs V8"
  button that single-steps both and stops at the first divergent state.
- [ ] **A fuel/▶ animation mode** that auto-advances at a chosen rate, and a sparkline of
  operand-stack depth over time.

## 2026-06-20 — plan: 128-bit SIMD vectors (`v128`) (claude / claude-opus-4-8)

The compiler had every scalar wasm type (i32, i64, f32, f64) but **not the fifth
one — `v128`**. An *optimizing compiler for wasm* with no SIMD was the obvious gap,
so this session adds first-class fixed-width vectors end-to-end. The whole design
leans on the project's superpower: the differential harness compiles each program
to wasm *and* runs the tree-walking interpreter, and asserts identical output at
-O0…-O3. SIMD lane semantics (i32/i64 wrap, single-precision rounding, saturating
convert, bitwise blend) are exactly reproducible in JS, so every vector op is
**provably correct**, not merely plausible. Headless, I bundled the pipeline with
esbuild and ran the wasm under Node to iterate to green before committing.

### Design — vectors as a value type, not a memory trick

Vectors are modelled as a new `Ty` (`{kind:'vec'; lanes}`) and a new `IRType`
(`'v128'`), so they ride the existing infrastructure: the type checker, SSA
construction (a v128 phi is just a phi with `ty:'v128'`), the stackifier, GVN, DCE,
locals/params/returns, and the relooper all treat them uniformly. Crucially `v128`
**never crosses the JS boundary** (the wasm/JS ABI forbids it), so vectors can't be
`print`ed or be array/struct/global members yet — you extract a lane (a scalar)
first. That single restriction kept the surface area tiny while covering all the
interesting compute.

### Front-end (`ast.ts`, `parser.ts`, `types.ts`, `interp.ts`)

- [x] Four shapes spelled `int4`/`float4`/`long2`/`double2`, with `VEC_INFO`
      metadata (lane count, lane scalar, float-ness) shared by every stage.
- [x] Type rules: elementwise `+ - *` (all shapes), `/` (float only), `& | ^ ~`
      (integer only); unary `-` (all) / `~` (integer). `tyEqual` distinguishes
      shapes (so `int4` ≠ `float4`); strict — no implicit lane coercion.
- [x] A builtin library, all reserved like other hard builtins: constructors +
      splat, `lane`/`withlane` (constant-immediate lane index, range-checked),
      `hsum`, `vmin`/`vmax`/`vsqrt`/`vabs`, six compares → mask, `vselect`,
      `to_float4`/`to_int4`.
- [x] The reference interpreter models a vector as a JS lane array with the lane
      type's normalization, `vselect` as a **byte-exact** bitselect over the 16-byte
      register image, and folds `hsum`/compares in the same lane order the wasm does.

### Back-end (`ir/ir.ts`, `ir/builder.ts`, `backend/codegen.ts`, `encoder.ts`)

- [x] New pure IR families `vbin`/`vunary`/`vsplat`/`vextract`/`vreplace`/`vselect`
      (GVN-able by `(kind, sub, args)`, DCE-able when dead, stackifiable).
- [x] `VT_V128 = 0x7b` value type; a `simd` instruction node carrying the
      `0xfd` prefix, a single-byte sub-opcode and an optional lane immediate; a
      **typed `select` (0x1c)** emitted whenever an if-converted `select` is v128
      (the untyped form is invalid for v128 — a real validation trap caught here).
- [x] The full opcode table: splats, extract/replace_lane, i32x4/i64x2/f32x4/f64x2
      arithmetic, whole-vector bitwise, lanewise comparisons, `v128.bitselect`, and
      `f32x4.convert_i32x4_s` / `i32x4.trunc_sat_f32x4_s`.

### Proof, examples, docs

- [x] 12 new battery programs in `tests.ts` (arith + wrap, lanes/bitwise, params +
      loop phi, vec ternary/select, compares + mask, convert + saturate, the
      SIMD-Mandelbrot row) — all green vs. the interpreter at -O0…-O3.
- [x] A `SIMD vectors (v128)` example (dot product, normalize, clamp via
      `vmin`/`vmax`, branchless 4-wide Mandelbrot escape-time) and a Verify-panel
      blurb. Total oracle coverage **836 checks across -O0…-O3**.

### Backlog — where SIMD goes next (deliberately deferred, all clean)

- [ ] **Vector arrays + aligned `v128.load`/`v128.store`** (`float4_array(n)`, a
      16-byte stride) so data-parallel *loops* over arrays become real, not just
      register-resident kernels. This is the gateway to everything below.
- [ ] **An auto-vectorizer pass**: recognize a counted loop whose body is a
      same-index elementwise map (`a[i] = f(b[i], c[i])`, no cross-lane dependence —
      always safe regardless of aliasing) and rewrite it to a v128 loop + a scalar
      remainder. The flagship optimizer feature once vector arrays land.
- [ ] **More lane ops**: `shuffle`/`swizzle` (`i8x16.shuffle` with a constant mask),
      lanewise shifts (`i32x4.shl` by a scalar), `i32x4.dot_i16x8_s`, `pmin`/`pmax`,
      `any_true`/`all_true` reductions, `bitmask`.
- [ ] **8- and 16-lane shapes** (`int8`=i8x16, `int16`=i16x8) with saturating
      add/sub — the natural fit for pixel/audio kernels.
- [ ] **i64x2 ↔ f64x2 conversions** and **f32x4↔f64x2 demote/promote pairs**
      (`f32x4.demote_f64x2_zero` / `f64x2.promote_low_f32x4`).
- [ ] **Constant folding of vector ops** in SCCP (a splat/arith of all-constant
      lanes → a `v128.const`), plus a v128 immediate in the encoder.
- [ ] **Let vectors live in memory** (array/struct/global members) once aligned
      load/store exists, lifting the value-only restriction.

## 2026-06-19 — plan (III): memory optimization — alias analysis · store→load forwarding · RLE · dead/silent-store elimination (claude / claude-opus-4-8)

The optimizer reasoned about *values* (SCCP, GVN, LICM, unrolling, div-by-const)
but treated **linear memory as opaque**: every `struct`-field write and read-back,
every array element touched twice, every raw `__load`/`__store` in the string and
array runtime survived verbatim. So a particle's `p.x = p.x + p.vx` did a real
load *and* store through memory even though the value was sitting right there.
This plan closes the last large mid-end gap — the **memory optimizations** every
production compiler ships — built on a single shared **alias analysis**.

The guiding rule is the project's usual **soundness by precondition**. Strata's
oracle is a tree-walking interpreter over the typed AST; the wasm is what runs, so
correctness means the *optimized* wasm matches the *unoptimized* wasm (which the
716-check harness already pins to the interpreter). The alias analysis is therefore
deliberately conservative: it reduces an address to a **base SSA value + constant
byte offset** and proves two accesses **disjoint** only when they share a base and
their `[off, off+width)` ranges don't overlap. *Any* pair of different bases is
assumed to may-alias — so a write through one handle conservatively kills every
fact about another. A bug can then only ever make the pass *miss* a rewrite, never
miscompile; the oracle proves the rest.

**Shipped — 756 differential checks, all green (baseline 716).** The `Memory
optimization` example's particle `step()` drops from **8 memory ops to 1** at -O1;
the read-modify-write chain `b.v += 1; b.v += 10; b.v *= 3` forwards every load and
keeps only the final store; the construction stores a field then overwrites it →
the initial store is dead. The conservative cases stay correct: two distinct struct
handles never cross-contaminate, a `call` between a store and load forces a re-read,
and a value re-stored in only one arm of an `if` is not forwarded past the merge.

### The analysis (`opt/memopt.ts`)
- [x] **Address resolution** — peel `copy` and `add(base, const)` chains to a
      `{ root, off }` descriptor; `width` from the access `sub` (i8→1, i32/f32→4,
      i64/f64→8). Folded constant array indices and struct field offsets become
      clean constant offsets from a shared base.
- [x] **may-alias / must-alias** — same base ⇒ exact byte-range overlap test;
      different bases ⇒ may-alias (no allocation/escape reasoning yet, see below).
- [x] **Forward available-memory dataflow** — a MUST analysis (meet = intersection
      over predecessors, ⊤-initialized back edges, iterated to a fixpoint). A
      surviving fact `(location → value)` holds on every path to the use ⇒ its value
      dominates the use ⇒ forwarding is SSA-valid; a defensive dominator check backs
      it up before any rewrite.

### The transforms
- [x] **Store→load forwarding (SLF)** — a `load [A]` with an available `store [A]=v`
      (must-alias, same access type, no aliasing write or call between) becomes `v`.
- [x] **Redundant-load elimination (RLE)** — a `load [A]` with an available earlier
      `load [A]` reuses the earlier value (loads gen their result as available).
- [x] **Dead-store elimination (DSE)** — a backward intra-block scan removes a store
      fully overwritten by a later store to the same location before any aliasing
      read (a load, `print`, or call all count as reads).
- [x] **Silent-store elimination** — a `store [A]=v` where the available state
      already proves `A` holds `v` writes the same bytes — a no-op — and is removed.
- [x] Barriers: a `call`/`call_indirect` clears all facts (may read/write anywhere);
      `print` reads but never writes memory (transparent to forwarding, a barrier
      for DSE); `i8` stores are never forwarded (a truncating byte round-trip).
- [x] Wired into the pass manager as `mem-opt` at **-O1+**, after strength
      reduction and before GVN, so forwarded values feed CSE and the freed loads
      are swept by the following DCE; re-run each round at -O2+.

### Proof, examples, docs
- [x] Nine **adversarial differential tests** (`mem-forward-chain`, `mem-dead-store`,
      `mem-rle-mixed`, `mem-distinct-bases`, `mem-call-barrier`, `mem-array-alias`
      with `i==j`/`i!=j`, `mem-branch-merge`, `mem-loop-body`, `mem-silent-store`) —
      every transform *and* every conservative case that must stay correct.
- [x] A new **example** (`Memory optimization`) that makes the win visible: compile
      at -O0, flip to -O1, watch the `i32.load`/`i32.store` opcodes drop in the WASM
      tab. The Optimizer panel's pipeline legend + Verify panel updated.
- [x] A dedicated **`tools/check-mem.mjs`** harness: compiles a memory-heavy battery
      at -O0/-O3, asserts wasm == wasm == interpreter, and counts the load/store
      opcodes removed (29 across the battery). Re-ran the headless harness
      (756/756 at -O0…-O3) and the CI gate (conformance + lint + build) — all green.

### Deliberately deferred (clean, documented limitations)
- [x] **Allocation / escape analysis** so two *distinct heap allocations* (or an
      allocation vs. a parameter) are proven non-aliasing — the analysis that would
      let writes through unrelated objects stop clobbering each other's facts. It was
      genuinely subtle here because the bump allocator's base was a bare `gget HEAP`,
      indistinguishable from the string runtime's `__heap_get` save/restore (which
      can return an *old* address), so "two `gget HEAP` values are distinct" is *not*
      sound in general. **Shipped 2026-06-19 (plan III):** the fix is to give struct
      construction a first-class **`alloc` IR op** (the string runtime keeps the raw
      bump sequence, so it is never confused for a fresh region) — now "two `alloc`
      results are distinct" *is* the monotonic-heap precondition done right, and
      `memopt` proves distinct allocations disjoint.
- [x] **Scalar replacement of a (loop-carried) location** — promote a non-escaping
      record's fields to SSA values + phis and delete the allocation entirely.
      **Shipped 2026-06-19 (plan III):** `opt/sroa.ts` does full Cytron SSA
      construction (dominance-frontier phi insertion + renaming) over the fields of
      every non-escaping `alloc`, including the loop-carried (header-phi) case.
- [ ] **Cross-block / partial dead-store elimination** (a store dead because the
      object is never read again on any path) — needs a backward memory-liveness
      dataflow; the intra-block case ships here. (For *non-escaping* records this is
      now moot — SROA deletes their stores outright — but it would still help records
      that escape.)

## 2026-06-19 — plan (III): SROA — escape analysis + scalar replacement of aggregates (claude / claude-opus-4-8)

The memory optimizer made *accesses* to a record cheaper; this plan makes the
record itself **disappear**. A `struct` is a bump-allocated block of linear memory
addressed by an i32 handle, its fields `store`/`load`-ed at constant byte offsets.
But the overwhelming majority of records a program builds are *local scratch* — a
`Vec2` temporary, a loop accumulator, a particle in a step function — whose handle
never leaves the function. For those, the allocation, every field store, and every
field load are pure overhead. The classic answer is **SROA**: prove the record
does not escape, then promote each field to an SSA value, deleting the record
outright. This is the JOURNAL's long-standing "next step on this foundation" —
the allocation/escape analysis the conservative `memopt` deliberately lacked, plus
the scalar-replacement (header-phi) win it flagged as "the single biggest remaining
loop win." This plan ships both.

**The subtlety that blocked it before, and the fix.** The old note correctly warned
that the bump allocator's base is a bare `gget HEAP`, *indistinguishable* from the
string runtime's `__heap_get` save/restore — which can hand back an **old** address —
so "two `gget HEAP` values are distinct allocations" is **not** sound in general.
The fix is structural: struct construction now lowers to a first-class **`alloc`
IR op** (`ir/ir.ts`), and *only* struct construction does — the string/array
runtime keeps using the raw bump sequence (`__alloc` → `gget`/`add`/`gset`). So an
`alloc` result is, by construction, a fresh region from the monotonic heap, never
an `__heap_get` rewind. "Two `alloc` results are distinct" is now exactly the
monotonic-heap precondition done right. A tiny pre-codegen pass (`ir/lower.ts`,
`lowerAllocs`) expands any *surviving* (escaping) `alloc` back into the bump
sequence on a private clone, so the backend never has to learn about allocation —
it stays a pure consumer of `gget`/`add`/`gset`, byte-for-byte as before.

**Soundness model** (same "soundness by precondition" discipline as the loop and
div/rem suites): the analysis only ever *declines*, never miscompiles, and every
promotion is an exact rewrite proven bit-for-bit against the reference interpreter
by the differential harness at -O0…-O3.

- [x] **`alloc` IR op** (`ir/ir.ts`): a first-class allocation (`args[0]` = byte
      size) that is *not* a pure value (never CSE-able — each yields a distinct
      address) and has *no observable side effect* (the heap-pointer bump is never
      read back in a user program, so a dead `alloc` is freely DCE-removable). Routed
      from `lowerStructNew` in the builder; threaded through `irdump`. Flows untouched
      through the pre-SSA inliner/TCO, `toSSA`, and every existing pass (they switch on
      `kind` and leave unknown kinds alone).
- [x] **`lowerAllocs`** (`ir/lower.ts`): expand surviving allocs → the bump sequence
      on a clone right before codegen (every level — an `alloc` reaches codegen at -O0
      too, where no SROA has run). A constant size is aligned at lowering time; a
      dynamic size gets the runtime `(+7) & ~7` rounding.
- [x] **Escape analysis** (`opt/sroa.ts`): one pass indexes every use of every value;
      then, per `alloc`, trace the handle and every address derived from it by adding a
      *constant* (`add base, C`) or copying it (`copy` — followed so promotion fires in
      a single pass, before copy-prop would clean it up). The record is promotable iff
      **every** use of **every** such address is the address operand of a `load`/`store`.
      Any other consumer — a store *value* (storing the handle), a return, a
      comparison/branch/phi operand, a call/print argument, or `add` with a non-constant
      (pointer arithmetic) — marks it escaped and it stays a real allocation. (So a
      handle compared to `null`, returned, linked into another record, or put in a
      `struct_array` keeps its memory; only genuinely local records melt.) Disjoint,
      non-overlapping field slots are required; `i8` (sub-word) fields decline.
- [x] **Promotion = full Cytron SSA construction**: each `(alloc, offset)` field is a
      variable; **dominance frontiers** (Cooper–Harvey–Kennedy from the shared dominator
      tree) drive iterated **phi placement** at the field's store sites, and a
      dominator-tree **rename** walk forwards every load to its reaching value and fills
      successor phi operands. A field written on both arms of a branch reconciles to a
      phi at the merge; one accumulated in a loop becomes a loop-header phi. An
      uninitialized read (no reaching def) aborts *that* allocation's promotion cleanly
      (speculatively-placed phis are rolled back), leaving it in memory.
- [x] **Allocation-aware aliasing in `memopt`**: two addresses rooted at two distinct
      `alloc` results are proven **disjoint**, so a write to one escaping record no
      longer clobbers `memopt`'s facts about another (the documented gap). Sound because
      each `alloc` is a fresh, non-overlapping region; a fresh root vs. a reloaded handle
      stays conservatively may-alias.
- [x] **Eight adversarial differential tests** (`sroa-local`, `sroa-phi-merge`,
      `sroa-loop-acc`, `sroa-alias`, `sroa-mixed-widths`, `sroa-escape-mix`,
      `sroa-inline-vec`) covering straight-line promotion, branch-merge phis,
      loop-carried phis, handle aliasing (`q = p`), mixed i32/i64/f64/f32 field widths,
      the escape boundary (one record returned, a sibling promoted), and the
      inline-then-melt vector chain. Plus a new **`SROA: records melt to registers`**
      example (a `Particle` step function with conditional "bounce" field writes).
- [x] **UI**: the Optimizer pass log now lists `sroa ×N`; the pipeline legend and the
      Verify-tab description document escape analysis + scalar replacement.
- [x] **Results.** The headline: the **`Structs: 2D vectors`** example at -O2 (helpers
      inlined) drops from **164 wasm instructions / 506 bytes to 12 / 139** — every one
      of its 4 allocations and all 21 memory ops vanish. The new `Particle` example goes
      from 1 alloc + 20 memory ops + 160 instrs at -O0 to **0 allocs / 0 memory ops / 94
      instrs** at -O1 (no inlining needed — it never escapes), conditional field writes
      and all. Differential harness **784/784** at -O0…-O3 (was 756; +7 SROA programs);
      `tsc`, `eslint`, and the CI gate all green.

## 2026-06-19 — plan (II): division/remainder by a constant — strength reduction (claude / claude-opus-4-8)

The arithmetic mid-end folds constants (SCCP), reassociates power-of-two
*multiplies* into shifts (peephole), and reduces strength on loops — but the one
genuinely expensive scalar op, **integer division**, was emitted verbatim even
when the divisor is a compile-time constant. Hardware `div` is ~10–40× a
multiply and isn't pipelined, so *every* production compiler replaces `x / C` and
`x % C` (constant `C`) with a multiply/shift/add sequence. This plan adds that
classic optimization, end to end, for both 32- and 64-bit integers.

The guiding rule is the same **soundness by precondition** as the loop suite:
each lowering is an *exact algebraic identity*, and the pass fires only when the
identity provably holds — so it can only ever miss an opportunity, never
miscompile. Two independent gates back this up: (1) an **offline fuzz** that runs
the exact IR lowering math (same i32/i64 wrapping, same arithmetic-shift bit
extraction) against a BigInt truncating-division reference over **>1.7M**
dividend/divisor pairs, including every corner (0, ±1, INT_MIN, INT_MAX); and
(2) the **differential oracle** (interpreter == compiled wasm at -O0…-O3) over a
new adversarial test battery.

**Trap discipline.** Signed division traps only on `x / 0` and `INT_MIN / -1`.
The pass fires only for `|C| >= 2` (and `C != INT_MIN`), a range in which the
original division *cannot* trap — so substituting non-trapping arithmetic can
never erase a trap the program would have raised. `C == 1` / `C == -1` are
handled as identities (with `x / -1` *declined* for division, to preserve the
INT_MIN trap); `C == 0` is left untouched so its trap survives.

**Shipped — 716 differential checks, all green (baseline 700).** At -O1+ the
`divmagic` example's six `i32.div_s`/`i32.rem_s` opcodes drop to **zero**; the
canonical base-10 `/10`,`%10` digit loop shares one multiply under GVN at -O2.

### The lowerings (`opt/divrem.ts`)
- [x] **Power of two**, i32 and i64: `q = (x + ((x >> w-1) & (2^k - 1))) >> k`
      (arithmetic shifts only — the bias is the sign-broadcast masked to `2^k-1`,
      so no logical shift is needed); negate for a negative divisor.
- [x] **General i32 divisor**: the signed magic-number multiply (Hacker's
      Delight fig. 10-1) — `magicS32` computes `(M, s)` in BigInt with 32-bit
      unsigned masking; the high word of `M * x` is the low 32 bits of
      `(i64)M * (i64)x >> 32` (widen, multiply, arithmetic-shift, wrap) — so it
      needs no `mulhi` opcode — then the `±x` correction, post-shift, and sign-bit
      add.
- [x] **General i64 divisor**: `magicS64` (the 64-bit recurrence), and a
      **64-bit signed high-multiply synthesized from i64 ops alone**
      (`smulhi64`): schoolbook 32×32 limb products with the high halves extracted
      by *arithmetic* shift + mask, summed with explicit carry, then the
      `hi − (a<0?b:0) − (b<0?a:0)` signed correction. Power-of-two i64 divisors
      take the cheaper shift path; only true 128-bit-mulhi-free magic remained,
      and this closes it.
- [x] **Remainder** = `x − (x / C) * C` for every case, so a function computing
      both `x / C` and `x % C` shares the single quotient under GVN.
- [x] Wired into the pass manager as `div-by-const` at **-O1+**, after
      strength-reduce and before GVN (so the produced subexpressions are CSE'd),
      with a fresh-id-safe straight-line emitter that retargets its final
      instruction onto the original SSA result (no leftover copies at -O2+).

### Proof, examples, docs
- [x] Offline fuzz harnesses mirroring the IR math exactly — i32 magic (1.19M
      checks), i32/i64 power-of-two (429K), i64 `smulhi` vs a 128-bit BigInt
      reference (168K) and i64 magic division (132K) — **all zero mismatches**.
- [x] Three new **adversarial differential tests** (`div-by-const-i32`,
      `div-by-const-i64`, `div-by-const-divmod`) sweeping pos/neg, pow2/non-pow2,
      small/large divisors over INT_MIN…INT_MAX dividends, plus the digit-loop
      divmod idiom.
- [x] A new **example** (`Division by a constant`) that makes the win visible:
      compile at -O0, flip to -O1, and watch the `div_s`/`rem_s` opcodes vanish
      from the WASM tab. Architecture note added above.
- [x] Re-ran the headless harness (716/716 at -O0…-O3) and the CI gate
      (conformance + lint + build) — all green.

### Deliberately deferred (clean, documented limitations)
- [ ] **Unsigned** division-by-constant — the language's ints are signed; an
      unsigned path (and `div_u`/`rem_u` opcodes) would need an unsigned type
      first.
- [ ] **Branchless `% 2` parity / known-power-of-two range** peeps — minor; the
      general path already covers them correctly.

## 2026-06-19 — plan: a loop-optimization suite (loop forest · induction variables · full unrolling · CFG simplification) (claude / claude-opus-4-8)

The optimizer is strong on *acyclic* code (SCCP, GVN, if-conversion, algebraic
simplification) and already hoists loop invariants (LICM) and turns self-recursion
into loops (TCO). The biggest remaining mid-end gap is **structural loop
optimization**: nothing yet *reasons about the trip count* of a counted loop, and
nothing cleans up the straight-line block chains that SCCP/if-conversion/inlining
leave behind. This plan closes both gaps with a coherent suite, every piece a pure
SSA→SSA transform guarded by the 636-check differential oracle.

The design principle is **soundness by precondition**: each transform inspects the
loop/CFG and only fires when a short list of structural facts holds; when anything
is uncertain it declines and leaves the IR untouched. So a bug can only ever make a
pass *miss* an opportunity — never miscompile — and the oracle (interpreter ==
wasm at every level) proves the rest. Correctness is not argued, it is *tested*.

**Shipped — 700 differential checks, all green (baseline before this work: 636).**
A pure constant-bound accumulation loop (`Σ i²`, `Σ i`, a descending factorial, a
two-accumulator Fibonacci) unrolls and then **collapses to a single constant**
(`opt=1`, ~90% fewer IR instructions, the CFG down to one block); a small
side-effecting vector loop (`T ≤ 8`) unrolls into straight-line loads/stores; and
the loops that *must not* unroll — a parameter bound, a `break`, a `long` IV that
overflows the limit — correctly decline, all proven identical at -O0…-O3.

### Shared analysis — the loop forest (`ir/loops.ts`)
- [x] Natural-loop discovery from back edges (a CFG edge `b → h` where `h`
      dominates `b`), unioning bodies per header, recording **all latches** and a
      structured `{ header, latches, body, depth, parent }` forest with nesting
      depth and the immediately-enclosing loop.
- [x] `dominates()` + `isInnermost()` helpers, and `findNaturalLoops()` shared by
      LICM and the new unroller — one definition of "what is a loop" for the whole
      mid-end.
- [x] Refactor **LICM** to consume the shared forest (behaviour-preserving: harness
      stays green; LICM's preheader synthesis is unchanged).

### Induction variables & trip count (in `opt/unroll.ts`)
- [x] Recognise a **basic induction variable**: a header phi `i = [init (from the
      preheader), i ± c (from the latch)]` with a constant step `c`.
- [x] Recognise the loop's **exit test**: the header's `condbr` on an `icmp`
      comparing the basic IV against a **loop-invariant constant** bound, on either
      operand side, for any predicate (`< <= > >= == !=`), signed.
- [x] Compute the **exact trip count** by *simulating the counter* with the very
      same i32/i64 wrapping + `icmp` semantics the interpreter and wasm use — no
      closed form, so off-by-ones and signed/unsigned corner cases are impossible.
      Bail (decline) if it does not converge within the unroll limit.

### Full loop unrolling (`opt/unroll.ts`)
- [x] When the trip count `T` is a known small constant, replace the loop with `T`
      straight-line clones of its body, threading SSA across iterations (each
      iteration's header-phi value is the previous iteration's latch value; the
      first is the preheader init), dropping the back-edge and the now-dead exit
      test, and rewiring live-out header-phi values to their **final** iteration
      value (a tiny LCSSA-style fixup at the single loop exit).
- [x] Conservative firing: single latch, a two-pred header (preheader + latch), a
      **single exit** (the header test is the loop's only way out — so a `break`
      declines), live-outs restricted to header phis, innermost loops only, and a
      code-growth budget. Unrolls a pure loop up to `T ≤ 64` (it then folds away via
      SCCP/GVN/DCE) and a side-effecting one only up to `T ≤ 8`.
- [x] The headline result: a constant-bound accumulation loop (`sum 1..n`) unrolls,
      then **collapses to a single constant** — visible live in the Optimizer panel.

### CFG simplification (`opt/simplifycfg.ts`)
- [x] **Block coalescing**: a block `A` ending in `br B` where `B`'s only pred is
      `A` is merged (B's trivial phis fold, its insts append to A, A takes B's
      terminator, B's successors re-point their phi incomings to A).
- [x] **Branch-to-branch threading**: an empty block (no phis, no insts) that only
      forwards `br C` is threaded out, its preds re-pointed straight at `C`.
- [x] Runs at -O1+ and cleans up after if-conversion, inlining, SCCP and unrolling —
      a visible drop in block count on essentially every program.

### Proof, examples, docs
- [x] New **adversarial differential tests** that stress counted loops, nested
      loops, zero-trip and reverse-step loops, early-`return`-inside-loop, IVs the
      simplifier must *not* unroll (variable bound, `break`), and `long` IVs.
- [x] Two new **examples** that make the wins visible (a fully-collapsing
      accumulation; an unrolled dot product) and a docs/Internals note.
- [x] Re-run the headless harness at -O0…-O3 — must stay 100% green — and the CI
      gate (conformance + lint + build).

### Deliberately deferred (clean, documented limitations)
- [x] **Partial unrolling** (unroll-by-K with a remainder loop) for *non-constant*
      trip counts — the production case. **Shipped 2026-06-21 (later session)**
      (`opt/partial-unroll.ts`): a strided main loop with an overflow-blind "K more?"
      guard, reusing the original loop verbatim as the remainder. See that plan.
- [ ] **Induction-variable strength reduction / LFTR** (derived IVs `j = a*i + b`
      reduced to additions) — the loop forest + basic-IV analysis here are the
      groundwork.

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
- [x] **Arrays of function pointers** (jump tables / state machines). **Shipped
      2026-06-16** — see the session below. The blocker described here was solved by a
      cleaner mechanism than the "out-of-range sentinel" sketched at the time:
      **reserve table slot 0 as a null `funcref`** and shift every real function to
      slots 1..N, so the i32 `0` that `null` (and a fresh `fn_array` element) already
      lowers to *is* the no-function value — calling it traps on the null reference in
      wasm exactly as the oracle traps on a `null` function value, and `fn == null`
      becomes a real, observable "is this slot set?" test in both backends.

## 2026-06-16 — plan: arrays of function pointers — jump tables & state machines (claude / claude-opus-4-8)

The last function-pointer item the previous session deliberately deferred: an
**array of function pointers**, the data structure behind a real interpreter's
*jump table* and a *finite-state machine*. First-class functions shipped last time
(pass them, return them, compare them, store one in a `struct` field), but you still
could not write `(fn(int) -> int)[]` and index it — so a dispatch table had to be a
chain of `struct` vtables. This session closes that, and proves it the way Strata
proves everything: byte-for-byte agreement between the compiled WebAssembly and the
reference interpreter, at every optimization level.

**The hard part — and a cleaner fix than last time's note.** The deferred entry
worried that the two backends model a function value differently (the wasm has a raw
i32 table slot, the oracle has the target's *name*), so an *uninitialized* array
element is observable and dangerous: a zero-filled slot would silently call
`funcs[0]`. The previous note proposed an out-of-range sentinel that traps. The fix
shipped here is simpler and stronger: **reserve function-table slot 0 as the default
null `funcref`** and emit every real function into slots 1..N (the element segment now
starts at offset 1, the table is sized N+1, and `funcSlot(name)` adds 1). Now the i32
`0` that the `null` literal — and therefore a zero-initialized `fn_array` element —
already lowers to *is* the "no function" value: calling it indexes table[0] and the
engine traps on the null reference, exactly as the interpreter traps on a `null`
function value. No fill loop, no special sentinel constant. Better still, because
`null` and a real function pointer (slot ≥ 1) are now distinguishable as plain i32s,
`fn == null` is a genuine, observable "has this slot been wired up yet?" test that
agrees in both backends — so the safety property is testable *without* tripping a trap
(trap messages differ between the engines, so they can't go in the differential corpus).

Verified out-of-band: calling an unset slot traps in **both** backends at -O0…-O3
(interpreter: "call through an invalid function pointer"; wasm: "null function or
function signature mismatch"), each halting at exactly the right instruction.

Plan (every item differential-tested at -O0…-O3 before it is checked off):

**Shipped — 636 differential checks, all green (baseline before this work: 600).**

### Front-end — syntax & types
- [x] AST: extend `ElemTy` with a function-pointer element `{ kind:'fn'; params; ret;
      hole? }`; `tyEqual` now compares fn-array element **signatures** (so
      `(fn(int)->int)[]` ≠ `(fn(str)->str)[]`); `tyName` prints `(fn(…)->…)[]`.
- [x] Parser: **grouping parens** in the type grammar. A bare `fn(int) -> int[]` still
      reads as "returns `int[]`"; an array *of* function pointers is the grouped form
      `(fn(int) -> int)[]`. `parseTypePrimary` handles `( T )` and rejects arrays-of-
      arrays; a bare `fn(…)` type stays deliberately non-array-suffixable.
- [x] Type checker: a new `fn_array(n)` intrinsic (the function-pointer analogue of
      `struct_array`) returns a placeholder `(fn…)[]` whose element signature is a
      `hole` until a `(fn(…)->…)[]` annotation pins it (same "annotate me" rule +
      error as `struct_array`); `null` is now coercible to any `fn` (a nullable /
      clearable function pointer); `fn == null` / `null == fn` type-check to `bool`;
      `validateTy` recurses into fn-array element signatures.

### Mid-end / back-end
- [x] Builder: `fn_array(n)` lowers to a zero-filled i32 array (every element is the
      null slot until assigned). No new IR — an `fn[]` is an i32 array, a stored
      function name is a `funcaddr`, a call through `arr[i]` is the existing `callind`.
- [x] Backend: **reserve table slot 0 as a null `funcref`**; functions occupy slots
      1..N (table size N+1, element segment offset 1, `funcSlot += 1`); WAT printer
      updated. This is the whole safety mechanism — uninitialized/`null` pointers trap.

### Oracle, debugger, UI, tests
- [x] Interpreter + step debugger: `ArrayVal` gains an `'fn'` element kind holding
      `FnVal | null`; `index-assign` stores it; `fn_array` builtin null-fills; the
      existing `null`-identity comparison already makes `fn == null` agree; the
      debugger renders an `fn[]` element as `&name` / `null`.
- [x] Examples + adversarial differential tests (8 new programs × 4 levels = 32 checks):
      a calculator **jump table**, a null-sentinel observation, a **state machine**, slot
      reassignment + identity, mixed signatures (incl. void-returning actions, `str`,
      `long`), the grammar `fn(…)->T[]` vs `(fn(…)->T)[]` distinction, a runtime-built
      table that never devirtualizes, and an fn-array **passed as a parameter** with a
      null-guarded dispatch.
- [x] UI: a flagship **"Bytecode VM (jump table)"** example — a stack machine whose
      fetch–decode–execute loop is a single `table[op](vm, imm)` indexing, lowering to a
      wasm `call_indirect` indexed by the opcode; `fn_array` added to the highlighter.

### Deliberately deferred (clean, documented limitations)
- [ ] **Function pointers in module globals / a global jump table.** Still rejected:
      a global needs a constant initializer, but a `funcaddr`'s table slot isn't known
      until backend layout. The slot-0-null trick makes a *null*-initialized global fn
      pointer representable in principle (init `0`); wiring a const `funcaddr` initializer
      through the global section is the remaining work.
- [ ] **A `len`-bounded "call all" / map over an `fn[]` in the standard library.**
      Trivial in user code today (a `while` loop); a builtin would be sugar.

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

- 2026-06-19 (claude / claude-opus-4-8): **SROA — escape analysis + scalar replacement of
  aggregates** (see plan III). Closed the two longest-standing deferred items at once: the
  allocation/escape analysis `memopt` lacked, and scalar replacement of a (loop-carried)
  location. Struct construction now lowers to a first-class **`alloc` IR op** — and *only*
  struct construction, so it is never confused with the string runtime's `__heap_get` rewind,
  which is exactly the soundness subtlety that blocked this before. A new pass (`opt/sroa.ts`)
  proves a record's handle non-escaping (used only as the base of its own field loads/stores —
  never stored, returned, compared, passed to a call, or merged through a phi) and promotes it
  out of memory by **full Cytron SSA construction**: dominance-frontier phi placement over each
  field's store sites + a dominator-tree rename, so branch-merged and loop-carried fields become
  phis, not memory round-trips. Because the handle provably aliases nothing, promotion forwards
  straight across calls. A pre-codegen `lowerAllocs` (`ir/lower.ts`) expands any *surviving*
  (escaping) alloc to the bump sequence so the backend is untouched; `memopt` additionally now
  proves two distinct `alloc`s disjoint. **The `Structs: 2D vectors` example at -O2 drops from
  164 wasm instrs / 506 bytes to 12 / 139** — all 4 allocations and 21 memory ops gone — and a
  new `Particle`-step example melts to 0 allocs / 0 memory ops at -O1 (conditional field writes
  and all). Added 7 adversarial differential tests + 1 showcase example; harness **784/784** at
  -O0…-O3; UI pass log / legend / Verify description updated. `tsc` + `eslint` + CI gate green.
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
