// Aether — WebAssembly code generator
//
// Aether's *third* compilation target. Where `compiler.ts` lowers the typed,
// dictionary-elaborated core AST to bytecode and `jsBackend.ts` lowers it to
// JavaScript, this module lowers the very same AST to a real WebAssembly module
// (assembled by `encoder.ts`). The output instantiates and runs in any engine.
//
// Strategy — closure conversion over a tagged linear-memory heap (`layout.ts`):
//   • every value is an i32 pointer to a heap cell; a bump allocator (`__alloc`)
//     hands out memory and grows it on demand;
//   • each `lambda` becomes a WASM function `(env, arg) -> i32`; its free
//     variables are captured into a heap "closure" cell and read back from `env`;
//   • application is uniform: a runtime `apply` dispatches on the callee's tag —
//     user closures via `call_indirect`, partially-applied natives/constructors
//     by accumulating arguments;
//   • top-level `let`/`letrec`/`type` bindings become WASM globals (so top-level
//     recursion needs no back-patching); nested recursion ties the knot by
//     filling a closure's own env slot after allocation;
//   • arithmetic, comparison of numbers/bools, list/tuple/record/ADT building and
//     `match` dispatch all run in WASM; printing, `show`, structural/lexicographic
//     comparison, float math, string ops and the turtle are delegated to imports
//     that reuse the VM's own implementations (see `bridge.ts`), so the result is
//     byte-for-byte identical to the bytecode VM.

import type { BinaryOp, Expr, Pattern } from '../lang/ast.ts'
import { parse } from '../lang/parser.ts'
import { PRELUDE_DEFS } from '../lang/prelude.ts'
import { Code, F64, I32, Module } from './encoder.ts'
import { NATIVE_GLOBALS } from './bridge.ts'
import {
  CACHE_BASE,
  FREE_OFF,
  HEAP_BASE,
  INITIAL_PAGES,
  MARK,
  MIN_CELL,
  OFF,
  SHADOW_BASE,
  SHADOW_END,
  SIZE,
  SMALLINT_COUNT,
  SMALLINT_HI,
  SMALLINT_LO,
  TAG,
  TAG_MASK,
  closureSize,
  dataSize,
  papSize,
  recordSize,
  tupleSize,
} from './layout.ts'

// Import function indices (declared first, so they take indices 0..2).
const IMP_CALLNATIVE = 0
const IMP_VALUECMP = 1
const IMP_STRCONCAT = 2

// Runtime function indices (defined immediately after the imports, in this order).
const F_ALLOC = 3
const F_BOXINT = 4
const F_BOXFLOAT = 5
const F_BOXBOOL = 6
const F_BOXSTR = 7
const F_MKCONS = 8
const F_ASF64 = 9
const F_CMPVALS = 10
const F_LISTAPPEND = 11
const F_RECGET = 12
const F_RECSET = 13
const F_RECCOPY = 14
const F_APPLY = 15
// — garbage-collector runtime (defined immediately after `apply`) —
const F_GCPUSH = 16 // push a root onto the shadow stack
const F_GCMARK = 17 // recursively mark a reachable object
const F_GCMARKROOTS = 18 // mark from the shadow stack + every value global
const F_GCCOLLECT = 19 // a full mark-sweep collection

/** The smallest collection trigger: collect once the heap has grown this much
 *  since the last GC (the threshold then tracks 2× the live set). */
const GC_MIN_THRESHOLD = 128 * 1024

const INLINE_BUILTINS = new Set(['head', 'tail', 'empty'])

export interface WasmModule {
  bytes: Uint8Array
  stringLiterals: string[]
  ctorNames: string[]
  labels: string[]
  stats: { funcCount: number; importCount: number; globalCount: number; byteLength: number }
}

// ---------------------------------------------------------------------------
// Variable locations & per-function context
// ---------------------------------------------------------------------------

type VarLoc =
  | { kind: 'global'; idx: number }
  | { kind: 'arg' }
  | { kind: 'local'; idx: number }
  | { kind: 'env'; idx: number }

type Scope = Map<string, VarLoc>

class FuncCtx {
  localTypes: number[] = []
  nextLocal: number
  /** The wasm local holding this function's shadow-stack frame pointer (the
   *  value of `$shadowSp` on entry). The whole frame is reclaimed by restoring
   *  `$shadowSp = fp` at every exit. `-1` until `emitFrameEnter` runs. */
  fp = -1
  constructor(nextLocal: number) {
    this.nextLocal = nextLocal
  }
  newLocal(): number {
    this.localTypes.push(I32)
    return this.nextLocal++
  }
}

// ---------------------------------------------------------------------------
// Free-variable analysis (drives closure capture)
// ---------------------------------------------------------------------------

function patternVars(p: Pattern, into: Set<string>): void {
  switch (p.kind) {
    case 'pvar':
      into.add(p.name)
      return
    case 'pcons':
      patternVars(p.head, into)
      patternVars(p.tail, into)
      return
    case 'ptuple':
      for (const el of p.elements) patternVars(el, into)
      return
    case 'pcon':
      for (const a of p.args) patternVars(a, into)
      return
    default:
      return
  }
}

function freeVars(e: Expr): Set<string> {
  const u = (...sets: Set<string>[]): Set<string> => {
    const out = new Set<string>()
    for (const s of sets) for (const x of s) out.add(x)
    return out
  }
  switch (e.kind) {
    case 'var':
      return new Set([e.name])
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
      return new Set()
    case 'lambda': {
      const s = freeVars(e.body)
      s.delete(e.param)
      return s
    }
    case 'app':
      return u(freeVars(e.fn), freeVars(e.arg))
    case 'let': {
      const sv = freeVars(e.value)
      if (e.recursive) sv.delete(e.name)
      const sb = freeVars(e.body)
      sb.delete(e.name)
      return u(sv, sb)
    }
    case 'letrec': {
      const s = u(...e.bindings.map((b) => freeVars(b.value)), freeVars(e.body))
      for (const b of e.bindings) s.delete(b.name)
      return s
    }
    case 'if':
      return u(freeVars(e.cond), freeVars(e.then), freeVars(e.else))
    case 'binop':
      return u(freeVars(e.left), freeVars(e.right))
    case 'unop':
      return freeVars(e.operand)
    case 'list':
    case 'tuple':
      return u(...e.elements.map(freeVars))
    case 'seq':
      return u(freeVars(e.first), freeVars(e.rest))
    case 'match': {
      let s = freeVars(e.scrutinee)
      for (const c of e.cases) {
        const bound = new Set<string>()
        patternVars(c.pattern, bound)
        let cs = freeVars(c.body)
        if (c.guard) cs = u(cs, freeVars(c.guard))
        for (const n of bound) cs.delete(n)
        s = u(s, cs)
      }
      return s
    }
    case 'typedecl': {
      const s = freeVars(e.body)
      for (const ctor of e.ctors) s.delete(ctor.name)
      return s
    }
    case 'record':
      return u(...e.fields.map((f) => freeVars(f.value)))
    case 'field':
      return freeVars(e.record)
    case 'recordUpdate':
      return u(freeVars(e.record), ...e.fields.map((f) => freeVars(f.value)))
    case 'classdecl':
    case 'instancedecl':
      throw new Error(`internal: ${e.kind} survived elaboration before WASM codegen`)
  }
}

// ---------------------------------------------------------------------------
// Top-level binding flattening (shared with the prelude)
// ---------------------------------------------------------------------------

type TopBinding =
  | { kind: 'let'; name: string; value: Expr; recursive: boolean }
  | { kind: 'letrec'; bindings: { name: string; value: Expr }[] }
  | { kind: 'type'; ctors: { name: string; arity: number }[] }

const PRELUDE_PARSED = PRELUDE_DEFS.map((d) => ({ name: d.name, recursive: d.recursive, value: parse(d.src) }))

function flattenUser(ast: Expr): { bindings: TopBinding[]; final: Expr } {
  const bindings: TopBinding[] = []
  let cur = ast
  for (;;) {
    if (cur.kind === 'let') {
      bindings.push({ kind: 'let', name: cur.name, value: cur.value, recursive: cur.recursive })
      cur = cur.body
    } else if (cur.kind === 'letrec') {
      bindings.push({ kind: 'letrec', bindings: cur.bindings.map((b) => ({ name: b.name, value: b.value })) })
      cur = cur.body
    } else if (cur.kind === 'typedecl') {
      bindings.push({ kind: 'type', ctors: cur.ctors.map((c) => ({ name: c.name, arity: c.args.length })) })
      cur = cur.body
    } else {
      return { bindings, final: cur }
    }
  }
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

class Gen {
  module = new Module()
  applyType = this.module.typeIndex([I32, I32], [I32])

  // interned tables shared with the bridge
  stringLiterals: string[] = []
  strId = new Map<string, number>()
  ctorNames: string[] = []
  ctorId = new Map<string, number>()
  labels: string[] = []
  labelId = new Map<string, number>()

  globalScope: Scope = new Map()
  // WASM global indices for the runtime singletons
  gHeap = 0
  gUnit = 0
  gNil = 0
  gTrue = 0
  gFalse = 0
  gPi = 0
  gAllocCount = 0
  gAllocBytes = 0
  gCacheHits = 0
  // — garbage collector state —
  gShadowSp = 0 // next free shadow-stack slot (the root finder's domain)
  gFreeList = 0 // head of the free-list (swept cells available for reuse)
  gLock = 0 // when ≠ 0, `__alloc` never collects (guards host import callbacks)
  gStress = 0 // when ≠ 0, collect before *every* allocation (correctness stress)
  gBytesSinceGc = 0 // bytes handed out since the last collection
  gThreshold = 0 // collect once `gBytesSinceGc` exceeds this (tracks 2× live)
  gCollections = 0 // number of collections run
  gReclaimed = 0 // total bytes swept back to the free list
  gLiveBytes = 0 // live bytes at the last collection
  gPeakHeap = 0 // high-water mark of the bump pointer (bytes)
  gReuse = 0 // allocations satisfied from the free list (cells reused)
  gNative: number[] = []
  // inline-builtin global indices (to confirm they are still the builtin)
  builtinGlobalIdx = new Map<string, number>()

  internStr(s: string): number {
    const e = this.strId.get(s)
    if (e !== undefined) return e
    const id = this.stringLiterals.length
    this.stringLiterals.push(s)
    this.strId.set(s, id)
    return id
  }
  internCtor(name: string): number {
    const e = this.ctorId.get(name)
    if (e !== undefined) return e
    const id = this.ctorNames.length
    this.ctorNames.push(name)
    this.ctorId.set(name, id)
    return id
  }
  internLabel(label: string): number {
    const e = this.labelId.get(label)
    if (e !== undefined) return e
    const id = this.labels.length
    this.labels.push(label)
    this.labelId.set(label, id)
    return id
  }

  // Pre-collect every constructor, string literal and record label so their ids
  // are assigned before any code (the bridge tables must agree with the module).
  collect(e: Expr): void {
    switch (e.kind) {
      case 'str':
        this.internStr(e.value)
        return
      case 'typedecl':
        for (const c of e.ctors) this.internCtor(c.name)
        this.collect(e.body)
        return
      case 'record':
        for (const f of e.fields) {
          this.internLabel(f.label)
          this.collect(f.value)
        }
        return
      case 'field':
        this.internLabel(e.label)
        this.collect(e.record)
        return
      case 'recordUpdate':
        this.collect(e.record)
        for (const f of e.fields) {
          this.internLabel(f.label)
          this.collect(f.value)
        }
        return
      case 'match':
        this.collect(e.scrutinee)
        for (const c of e.cases) {
          this.collectPattern(c.pattern)
          if (c.guard) this.collect(c.guard)
          this.collect(c.body)
        }
        return
      case 'lambda':
        this.collect(e.body)
        return
      case 'app':
        this.collect(e.fn)
        this.collect(e.arg)
        return
      case 'let':
        this.collect(e.value)
        this.collect(e.body)
        return
      case 'letrec':
        for (const b of e.bindings) this.collect(b.value)
        this.collect(e.body)
        return
      case 'if':
        this.collect(e.cond)
        this.collect(e.then)
        this.collect(e.else)
        return
      case 'binop':
        this.collect(e.left)
        this.collect(e.right)
        return
      case 'unop':
        this.collect(e.operand)
        return
      case 'list':
      case 'tuple':
        for (const el of e.elements) this.collect(el)
        return
      case 'seq':
        this.collect(e.first)
        this.collect(e.rest)
        return
      default:
        return
    }
  }
  collectPattern(p: Pattern): void {
    switch (p.kind) {
      case 'pstr':
        this.internStr(p.value)
        return
      case 'pcon':
        this.internCtor(p.name)
        for (const a of p.args) this.collectPattern(a)
        return
      case 'pcons':
        this.collectPattern(p.head)
        this.collectPattern(p.tail)
        return
      case 'ptuple':
        for (const el of p.elements) this.collectPattern(el)
        return
      default:
        return
    }
  }

  // — variable access —
  loadVar(name: string, scope: Scope, code: Code): void {
    const loc = scope.get(name)
    if (!loc) throw new Error(`unbound variable in WASM codegen: ${name}`)
    switch (loc.kind) {
      case 'global':
        code.global_get(loc.idx)
        return
      case 'arg':
        code.local_get(1)
        return
      case 'local':
        code.local_get(loc.idx)
        return
      case 'env':
        code.local_get(0).i32_load(OFF.CLOSURE_ENV + 4 * loc.idx)
        return
    }
  }

  // ---------------------------------------------------------------------------
  // Shadow-stack root discipline (the GC's precise root set)
  // ---------------------------------------------------------------------------
  //
  // A function captures `$shadowSp` into `ctx.fp` on entry and restores it at
  // every exit, so its whole set of roots is reclaimed at once. Because the
  // collector never moves objects, the pointers in wasm locals stay valid across
  // a collection — pushing them here only keeps them *marked*.

  /** Capture the frame pointer (and allocate the local that holds it). */
  emitFrameEnter(ctx: FuncCtx, code: Code): void {
    ctx.fp = ctx.newLocal()
    code.global_get(this.gShadowSp).local_set(ctx.fp)
  }

  /** Push the pointer on top of the operand stack as a GC root (consumes it). */
  emitRoot(code: Code): void {
    code.call(F_GCPUSH)
  }

  /** Reclaim the whole frame: `$shadowSp = fp`. Safe before a value is returned
   *  (no allocation happens between the restore and the return). */
  emitFramePop(ctx: FuncCtx, code: Code): void {
    code.local_get(ctx.fp).global_set(this.gShadowSp)
  }

  /** The function-return epilogue: result-on-stack → reclaim frame → result. */
  emitReturn(ctx: FuncCtx, code: Code): void {
    const ret = ctx.newLocal()
    code.local_set(ret)
    this.emitFramePop(ctx, code)
    code.local_get(ret)
  }

  /** Evaluate `e` and root the result, recording the shadow slot it landed in
   *  into a fresh local; returns that local so the value can be read back later
   *  (robust to allocations — and interleaved root pushes — in between). */
  evalRooted(e: Expr, scope: Scope, ctx: FuncCtx, code: Code): number {
    const slot = ctx.newLocal()
    this.compileExpr(e, scope, ctx, code)
    code.global_get(this.gShadowSp).local_set(slot)
    code.call(F_GCPUSH)
    return slot
  }

  // — compile a lambda's body into a fresh WASM function —
  compileLambda(
    node: Extract<Expr, { kind: 'lambda' }>,
    enclosing: Scope,
    nameHint = 'lambda',
  ): { funcIdx: number; captured: string[] } {
    const free = freeVars(node.body)
    free.delete(node.param)
    const captured = [...free].filter((n) => enclosing.get(n)?.kind !== 'global').sort()

    const inner: Scope = new Map(this.globalScope)
    inner.set(node.param, { kind: 'arg' })
    captured.forEach((n, i) => inner.set(n, { kind: 'env', idx: i }))

    const ctx = new FuncCtx(2)
    const body = new Code()
    // Enter a shadow frame and root the two incoming pointers (the closure env
    // and the argument) for the body's whole lifetime: once a tail-call chain
    // pops the caller frames, this body is the only thing keeping `env`/`arg`
    // reachable.
    this.emitFrameEnter(ctx, body)
    body.local_get(0).call(F_GCPUSH)
    body.local_get(1).call(F_GCPUSH)
    this.compileTail(node.body, inner, ctx, body)
    // Epilogue (reached on every non-tail-call return; dead — but valid — after a
    // `return_call`): stash the result, reclaim the frame, return the result.
    this.emitReturn(ctx, body)
    // locals 0/1 are the params (the closure env + the argument); name them so the
    // disassembler reads `local.get $env` / `local.get $arg`.
    const localNames: (string | null)[] = ['env', 'arg']
    const funcIdx = this.module.addFunc([I32, I32], [I32], ctx.localTypes, body, undefined, `λ_${nameHint}`, localNames)
    return { funcIdx, captured }
  }

  // — emit a closure cell for a lambda, filling env from `srcScope` —
  emitClosure(
    node: Extract<Expr, { kind: 'lambda' }>,
    defScope: Scope,
    srcScope: Scope,
    ctx: FuncCtx,
    code: Code,
    nameHint = 'lambda',
  ): void {
    const { funcIdx, captured } = this.compileLambda(node, defScope, nameHint)
    const tmp = ctx.newLocal()
    code.i32_const(closureSize(captured.length)).call(F_ALLOC).local_set(tmp)
    code.local_get(tmp).i32_const(TAG.CLOSURE).i32_store(OFF.TAG)
    code.local_get(tmp).i32_const(funcIdx).i32_store(OFF.CLOSURE_FUNC)
    code.local_get(tmp).i32_const(captured.length).i32_store(OFF.CLOSURE_NFREE)
    captured.forEach((n, i) => {
      code.local_get(tmp)
      this.loadVar(n, srcScope, code)
      code.i32_store(OFF.CLOSURE_ENV + 4 * i)
    })
    code.local_get(tmp)
  }

  // — a nested recursive binding group: allocate cells, then tie the knot —
  emitRecGroup(group: { name: string; value: Expr }[], scope: Scope, ctx: FuncCtx, code: Code): Scope {
    const locals = group.map(() => ctx.newLocal())
    const inner: Scope = new Map(scope)
    group.forEach((b, i) => inner.set(b.name, { kind: 'local', idx: locals[i] }))
    // Phase A: compile each lambda function & allocate its (header-only) closure.
    const infos = group.map((b) => {
      if (b.value.kind !== 'lambda') throw new Error('recursive binding must be a function')
      return this.compileLambda(b.value, inner, b.name)
    })
    infos.forEach((info, i) => {
      code.i32_const(closureSize(info.captured.length)).call(F_ALLOC).local_set(locals[i])
      code.local_get(locals[i]).i32_const(TAG.CLOSURE).i32_store(OFF.TAG)
      code.local_get(locals[i]).i32_const(info.funcIdx).i32_store(OFF.CLOSURE_FUNC)
      code.local_get(locals[i]).i32_const(info.captured.length).i32_store(OFF.CLOSURE_NFREE)
      // Root it immediately: allocating the *next* closure may collect, and these
      // sit only in wasm locals (invisible to the marker). They stay rooted for
      // the binding group's lifetime (the enclosing frame reclaims them).
      code.local_get(locals[i]).call(F_GCPUSH)
    })
    // Phase B: fill env fields (siblings/self now live in their locals).
    infos.forEach((info, i) => {
      info.captured.forEach((n, j) => {
        code.local_get(locals[i])
        this.loadVar(n, inner, code)
        code.i32_store(OFF.CLOSURE_ENV + 4 * j)
      })
    })
    return inner
  }

  // — the core expression compiler —
  compileExpr(e: Expr, scope: Scope, ctx: FuncCtx, code: Code): void {
    switch (e.kind) {
      case 'int':
        code.i32_const(e.value).call(F_BOXINT)
        return
      case 'float':
        code.f64_const(e.value).call(F_BOXFLOAT)
        return
      case 'bool':
        code.global_get(e.value ? this.gTrue : this.gFalse)
        return
      case 'str':
        code.i32_const(this.internStr(e.value)).call(F_BOXSTR)
        return
      case 'unit':
        code.global_get(this.gUnit)
        return
      case 'var':
        this.loadVar(e.name, scope, code)
        return
      case 'lambda':
        this.emitClosure(e, scope, scope, ctx, code)
        return
      case 'app':
        this.compileApp(e, scope, ctx, code)
        return
      case 'if':
        this.compileExpr(e.cond, scope, ctx, code)
        code.i32_load(OFF.BOOL_VAL).if_(I32)
        this.compileExpr(e.then, scope, ctx, code)
        code.else_()
        this.compileExpr(e.else, scope, ctx, code)
        code.end()
        return
      case 'let': {
        if (e.recursive) {
          const inner = this.emitRecGroup([{ name: e.name, value: e.value }], scope, ctx, code)
          this.compileExpr(e.body, inner, ctx, code)
        } else {
          const l = ctx.newLocal()
          this.compileExpr(e.value, scope, ctx, code)
          code.local_tee(l).call(F_GCPUSH) // bind in a local *and* root for the body's lifetime
          const inner: Scope = new Map(scope)
          inner.set(e.name, { kind: 'local', idx: l })
          this.compileExpr(e.body, inner, ctx, code)
        }
        return
      }
      case 'letrec': {
        const inner = this.emitRecGroup(e.bindings, scope, ctx, code)
        this.compileExpr(e.body, inner, ctx, code)
        return
      }
      case 'typedecl': {
        const inner: Scope = new Map(scope)
        for (const c of e.ctors) {
          const l = ctx.newLocal()
          this.emitCtorValue(c.name, c.args.length, ctx, code)
          code.local_tee(l).call(F_GCPUSH) // root the constructor cell for the body
          inner.set(c.name, { kind: 'local', idx: l })
        }
        this.compileExpr(e.body, inner, ctx, code)
        return
      }
      case 'binop':
        this.compileBinop(e.op, e.left, e.right, scope, ctx, code)
        return
      case 'unop':
        if (e.op === '-') {
          code.i32_const(0)
          this.compileExpr(e.operand, scope, ctx, code)
          code.i32_load(OFF.INT_VAL).i32_sub().call(F_BOXINT)
        } else {
          this.compileExpr(e.operand, scope, ctx, code)
          code.i32_load(OFF.BOOL_VAL).i32_eqz().call(F_BOXBOOL)
        }
        return
      case 'list': {
        // Evaluate-then-construct: root every element on the shadow stack first,
        // then fold `mkCons` from the right. `mkCons` roots its own arguments, so
        // the running accumulator survives each allocation; the elements survive
        // via their shadow slots. Finally reclaim the construction's roots.
        const base = ctx.newLocal()
        code.global_get(this.gShadowSp).local_set(base)
        const slots = e.elements.map((el) => this.evalRooted(el, scope, ctx, code))
        const acc = ctx.newLocal()
        code.global_get(this.gNil).local_set(acc)
        for (let i = slots.length - 1; i >= 0; i--) {
          code.local_get(slots[i]).i32_load(0)
          code.local_get(acc)
          code.call(F_MKCONS).local_set(acc)
        }
        code.local_get(base).global_set(this.gShadowSp)
        code.local_get(acc)
        return
      }
      case 'tuple': {
        const base = ctx.newLocal()
        code.global_get(this.gShadowSp).local_set(base)
        const slots = e.elements.map((el) => this.evalRooted(el, scope, ctx, code))
        const tmp = ctx.newLocal()
        code.i32_const(tupleSize(e.elements.length)).call(F_ALLOC).local_set(tmp)
        code.local_get(tmp).i32_const(TAG.TUPLE).i32_store(OFF.TAG)
        code.local_get(tmp).i32_const(e.elements.length).i32_store(OFF.TUPLE_LEN)
        slots.forEach((slot, i) => {
          code.local_get(tmp)
          code.local_get(slot).i32_load(0)
          code.i32_store(OFF.TUPLE_ITEMS + 4 * i)
        })
        code.local_get(base).global_set(this.gShadowSp)
        code.local_get(tmp)
        return
      }
      case 'seq':
        this.compileExpr(e.first, scope, ctx, code)
        code.drop()
        this.compileExpr(e.rest, scope, ctx, code)
        return
      case 'record': {
        const base = ctx.newLocal()
        code.global_get(this.gShadowSp).local_set(base)
        const slots = e.fields.map((f) => this.evalRooted(f.value, scope, ctx, code))
        const tmp = ctx.newLocal()
        code.i32_const(recordSize(e.fields.length)).call(F_ALLOC).local_set(tmp)
        code.local_get(tmp).i32_const(TAG.RECORD).i32_store(OFF.TAG)
        code.local_get(tmp).i32_const(e.fields.length).i32_store(OFF.RECORD_COUNT)
        e.fields.forEach((f, i) => {
          code.local_get(tmp).i32_const(this.internLabel(f.label)).i32_store(OFF.RECORD_PAIRS + 8 * i)
          code.local_get(tmp).local_get(slots[i]).i32_load(0).i32_store(OFF.RECORD_PAIRS + 8 * i + 4)
        })
        code.local_get(base).global_set(this.gShadowSp)
        code.local_get(tmp)
        return
      }
      case 'field':
        this.compileExpr(e.record, scope, ctx, code)
        code.i32_const(this.internLabel(e.label)).call(F_RECGET)
        return
      case 'recordUpdate': {
        const base = ctx.newLocal()
        code.global_get(this.gShadowSp).local_set(base)
        const tmp = ctx.newLocal()
        // `recCopy` roots its argument while it allocates; then root the fresh copy
        // for the duration of the (allocating) field-value evaluations.
        this.compileExpr(e.record, scope, ctx, code)
        code.call(F_RECCOPY).local_tee(tmp).call(F_GCPUSH)
        for (const f of e.fields) {
          const v = this.evalRooted(f.value, scope, ctx, code)
          code.local_get(tmp).i32_const(this.internLabel(f.label)).local_get(v).i32_load(0).call(F_RECSET)
        }
        code.local_get(base).global_set(this.gShadowSp)
        code.local_get(tmp)
        return
      }
      case 'match':
        this.compileMatch(e, scope, ctx, code, false)
        return
      case 'classdecl':
      case 'instancedecl':
        throw new Error(`internal: ${e.kind} survived elaboration before WASM codegen`)
    }
  }

  // Build a constructor value (nullary → DATA cell; arity>0 → CTOR pap cell) into
  // a fresh local and leave its pointer on the stack.
  emitCtorValue(name: string, arity: number, ctx: FuncCtx, code: Code): void {
    const nameId = this.internCtor(name)
    const tmp = ctx.newLocal()
    if (arity === 0) {
      code.i32_const(dataSize(0)).call(F_ALLOC).local_set(tmp)
      code.local_get(tmp).i32_const(TAG.DATA).i32_store(OFF.TAG)
      code.local_get(tmp).i32_const(nameId).i32_store(OFF.DATA_NAME)
      code.local_get(tmp).i32_const(0).i32_store(OFF.DATA_ARGC)
    } else {
      code.i32_const(papSize(arity)).call(F_ALLOC).local_set(tmp)
      code.local_get(tmp).i32_const(TAG.CTOR).i32_store(OFF.TAG)
      code.local_get(tmp).i32_const(nameId).i32_store(OFF.PAP_ID)
      code.local_get(tmp).i32_const(arity).i32_store(OFF.PAP_ARITY)
      code.local_get(tmp).i32_const(0).i32_store(OFF.PAP_COLLECTED)
    }
    code.local_get(tmp)
  }

  compileApp(e: Extract<Expr, { kind: 'app' }>, scope: Scope, ctx: FuncCtx, code: Code): void {
    // inline the hot, structural builtins when applied directly & unshadowed
    if (e.fn.kind === 'var' && INLINE_BUILTINS.has(e.fn.name)) {
      const loc = scope.get(e.fn.name)
      const builtinIdx = this.builtinGlobalIdx.get(e.fn.name)
      if (loc && loc.kind === 'global' && loc.idx === builtinIdx) {
        if (e.fn.name === 'head') {
          this.compileExpr(e.arg, scope, ctx, code)
          code.i32_load(OFF.CONS_HEAD)
          return
        }
        if (e.fn.name === 'tail') {
          this.compileExpr(e.arg, scope, ctx, code)
          code.i32_load(OFF.CONS_TAIL)
          return
        }
        // empty
        this.compileExpr(e.arg, scope, ctx, code)
        code.i32_load(OFF.TAG).i32_const(TAG.NIL).i32_eq().call(F_BOXBOOL)
        return
      }
    }
    // Root the callee across the argument's (allocating) evaluation, then hand
    // both to `apply` (which re-roots them on entry).
    const base = ctx.newLocal()
    code.global_get(this.gShadowSp).local_set(base)
    const fnSlot = this.evalRooted(e.fn, scope, ctx, code)
    const argSlot = this.evalRooted(e.arg, scope, ctx, code)
    code.local_get(fnSlot).i32_load(0)
    code.local_get(argSlot).i32_load(0)
    code.local_get(base).global_set(this.gShadowSp)
    code.call(F_APPLY)
  }

  compileBinop(op: BinaryOp, left: Expr, right: Expr, scope: Scope, ctx: FuncCtx, code: Code): void {
    const intArith = (emit: (c: Code) => void): void => {
      this.compileExpr(left, scope, ctx, code)
      code.i32_load(OFF.INT_VAL)
      this.compileExpr(right, scope, ctx, code)
      code.i32_load(OFF.INT_VAL)
      emit(code)
      code.call(F_BOXINT)
    }
    const floatArith = (emit: (c: Code) => void): void => {
      this.compileExpr(left, scope, ctx, code)
      code.f64_load(OFF.FLOAT_VAL)
      this.compileExpr(right, scope, ctx, code)
      code.f64_load(OFF.FLOAT_VAL)
      emit(code)
      code.call(F_BOXFLOAT)
    }
    // Two heap pointers coexist across an allocating sub-evaluation, so root the
    // left operand while the right is computed; reload both for the call. (`++`,
    // `::` and the comparisons all share this shape.)
    const twoPointer = (after: (c: Code) => void): void => {
      const base = ctx.newLocal()
      code.global_get(this.gShadowSp).local_set(base)
      const l = this.evalRooted(left, scope, ctx, code)
      const r = this.evalRooted(right, scope, ctx, code)
      code.local_get(l).i32_load(0)
      code.local_get(r).i32_load(0)
      code.local_get(base).global_set(this.gShadowSp)
      after(code)
    }
    const compareThen = (emit: (c: Code) => void): void => {
      twoPointer((c) => {
        c.call(F_CMPVALS)
        emit(c)
        c.call(F_BOXBOOL)
      })
    }
    switch (op) {
      case '+':
        return intArith((c) => c.i32_add())
      case '-':
        return intArith((c) => c.i32_sub())
      case '*':
        return intArith((c) => c.i32_mul())
      case '/':
        return intArith((c) => c.i32_div_s())
      case '%':
        return intArith((c) => c.i32_rem_s())
      case '+.':
        return floatArith((c) => c.f64_add())
      case '-.':
        return floatArith((c) => c.f64_sub())
      case '*.':
        return floatArith((c) => c.f64_mul())
      case '/.':
        return floatArith((c) => c.f64_div())
      case '==':
        return compareThen((c) => c.i32_eqz())
      case '!=':
        return compareThen((c) => c.i32_const(0).i32_ne())
      case '<':
        return compareThen((c) => c.i32_const(0).i32_lt_s())
      case '>':
        return compareThen((c) => c.i32_const(0).i32_gt_s())
      case '<=':
        return compareThen((c) => c.i32_const(0).i32_le_s())
      case '>=':
        return compareThen((c) => c.i32_const(0).i32_ge_s())
      case '&&':
        this.compileExpr(left, scope, ctx, code)
        code.i32_load(OFF.BOOL_VAL).if_(I32)
        this.compileExpr(right, scope, ctx, code)
        code.else_().global_get(this.gFalse).end()
        return
      case '||':
        this.compileExpr(left, scope, ctx, code)
        code.i32_load(OFF.BOOL_VAL).if_(I32).global_get(this.gTrue).else_()
        this.compileExpr(right, scope, ctx, code)
        code.end()
        return
      case '::':
        return twoPointer((c) => c.call(F_MKCONS))
      case '++':
        return twoPointer((c) => c.call(F_LISTAPPEND))
      case '^':
        // Both operands collapse to integer string-pool ids (never pointers), so
        // no rooting is needed; lock the collector around the host `strConcat`
        // import so its allocation can't be interrupted mid-flight.
        this.compileExpr(left, scope, ctx, code)
        code.i32_load(OFF.STR_ID)
        this.compileExpr(right, scope, ctx, code)
        code.i32_load(OFF.STR_ID)
        code.i32_const(1).global_set(this.gLock)
        code.call(IMP_STRCONCAT)
        code.i32_const(0).global_set(this.gLock)
        return
    }
  }

  compileMatch(e: Extract<Expr, { kind: 'match' }>, scope: Scope, ctx: FuncCtx, code: Code, tail: boolean): void {
    const s = ctx.newLocal()
    this.compileExpr(e.scrutinee, scope, ctx, code)
    // Root the scrutinee for the arms' lifetime. Pattern-bound variables point
    // *into* it, so the non-moving collector keeps them reachable for free.
    code.local_tee(s).call(F_GCPUSH)
    code.block(I32) // RESULT
    for (const c of e.cases) {
      code.block() // FAIL_i (empty)
      const caseScope: Scope = new Map(scope)
      // tests: each failed test does `br_if 0` to FAIL_i; binds set locals
      this.compilePattern(c.pattern, () => code.local_get(s), caseScope, ctx, code)
      if (c.guard) {
        this.compileExpr(c.guard, caseScope, ctx, code)
        code.i32_load(OFF.BOOL_VAL).i32_eqz().br_if(0)
      }
      // a tail body may emit a `return_call`; the following `br 1` is then dead
      // but still validates (stack-polymorphic after an unconditional transfer).
      if (tail) this.compileTail(c.body, caseScope, ctx, code)
      else this.compileExpr(c.body, caseScope, ctx, code)
      code.br(1) // → RESULT
      code.end() // FAIL_i
    }
    code.unreachable()
    code.end() // RESULT
  }

  // Compile in *tail position*: applications become `return_call` so deeply
  // recursive Aether (including the prelude's folds) runs in constant stack —
  // matching the bytecode VM's tail-call optimisation. Non-tail shapes fall back
  // to `compileExpr`, leaving the value for the enclosing function to return.
  compileTail(e: Expr, scope: Scope, ctx: FuncCtx, code: Code): void {
    switch (e.kind) {
      case 'app': {
        if (e.fn.kind === 'var' && INLINE_BUILTINS.has(e.fn.name)) {
          const loc = scope.get(e.fn.name)
          if (loc && loc.kind === 'global' && loc.idx === this.builtinGlobalIdx.get(e.fn.name)) {
            this.compileExpr(e, scope, ctx, code)
            return
          }
        }
        // Root callee + argument while they are computed, then reclaim the whole
        // frame (a tail call abandons it) and hand both to `apply`, which re-roots
        // them on entry — no allocation occurs between the pop and the call.
        const fnSlot = this.evalRooted(e.fn, scope, ctx, code)
        const argSlot = this.evalRooted(e.arg, scope, ctx, code)
        code.local_get(fnSlot).i32_load(0)
        code.local_get(argSlot).i32_load(0)
        this.emitFramePop(ctx, code)
        code.return_call(F_APPLY)
        return
      }
      case 'if':
        this.compileExpr(e.cond, scope, ctx, code)
        code.i32_load(OFF.BOOL_VAL).if_(I32)
        this.compileTail(e.then, scope, ctx, code)
        code.else_()
        this.compileTail(e.else, scope, ctx, code)
        code.end()
        return
      case 'let':
        if (e.recursive) {
          const inner = this.emitRecGroup([{ name: e.name, value: e.value }], scope, ctx, code)
          this.compileTail(e.body, inner, ctx, code)
        } else {
          const l = ctx.newLocal()
          this.compileExpr(e.value, scope, ctx, code)
          code.local_tee(l).call(F_GCPUSH) // bind + root for the body
          const inner: Scope = new Map(scope)
          inner.set(e.name, { kind: 'local', idx: l })
          this.compileTail(e.body, inner, ctx, code)
        }
        return
      case 'letrec': {
        const inner = this.emitRecGroup(e.bindings, scope, ctx, code)
        this.compileTail(e.body, inner, ctx, code)
        return
      }
      case 'typedecl': {
        const inner: Scope = new Map(scope)
        for (const c of e.ctors) {
          const l = ctx.newLocal()
          this.emitCtorValue(c.name, c.args.length, ctx, code)
          code.local_tee(l).call(F_GCPUSH) // root the constructor cell for the body
          inner.set(c.name, { kind: 'local', idx: l })
        }
        this.compileTail(e.body, inner, ctx, code)
        return
      }
      case 'seq':
        this.compileExpr(e.first, scope, ctx, code)
        code.drop()
        this.compileTail(e.rest, scope, ctx, code)
        return
      case 'match':
        this.compileMatch(e, scope, ctx, code, true)
        return
      default:
        this.compileExpr(e, scope, ctx, code)
    }
  }

  // Emit a pattern's tests (`br_if 0` to the enclosing FAIL block on mismatch)
  // and its variable bindings. `loadPtr` pushes the sub-value's pointer.
  compilePattern(p: Pattern, loadPtr: () => void, scope: Scope, ctx: FuncCtx, code: Code): void {
    switch (p.kind) {
      case 'pwild':
      case 'punit':
        return
      case 'pvar': {
        const l = ctx.newLocal()
        loadPtr()
        code.local_set(l)
        scope.set(p.name, { kind: 'local', idx: l })
        return
      }
      case 'pint':
        loadPtr()
        code.i32_load(OFF.INT_VAL).i32_const(p.value).i32_ne().br_if(0)
        return
      case 'pfloat':
        loadPtr()
        code.f64_load(OFF.FLOAT_VAL).f64_const(p.value).f64_eq().i32_eqz().br_if(0)
        return
      case 'pbool':
        loadPtr()
        code.i32_load(OFF.BOOL_VAL).i32_const(p.value ? 1 : 0).i32_ne().br_if(0)
        return
      case 'pstr':
        loadPtr()
        code.i32_const(this.internStr(p.value)).call(F_BOXSTR).call(IMP_VALUECMP).br_if(0)
        return
      case 'pnil':
        loadPtr()
        code.i32_load(OFF.TAG).i32_const(TAG.NIL).i32_ne().br_if(0)
        return
      case 'pcons':
        loadPtr()
        code.i32_load(OFF.TAG).i32_const(TAG.CONS).i32_ne().br_if(0)
        this.compilePattern(
          p.head,
          () => {
            loadPtr()
            code.i32_load(OFF.CONS_HEAD)
          },
          scope,
          ctx,
          code,
        )
        this.compilePattern(
          p.tail,
          () => {
            loadPtr()
            code.i32_load(OFF.CONS_TAIL)
          },
          scope,
          ctx,
          code,
        )
        return
      case 'ptuple':
        p.elements.forEach((el, i) =>
          this.compilePattern(
            el,
            () => {
              loadPtr()
              code.i32_load(OFF.TUPLE_ITEMS + 4 * i)
            },
            scope,
            ctx,
            code,
          ),
        )
        return
      case 'pcon':
        loadPtr()
        code.i32_load(OFF.DATA_NAME).i32_const(this.internCtor(p.name)).i32_ne().br_if(0)
        p.args.forEach((a, i) =>
          this.compilePattern(
            a,
            () => {
              loadPtr()
              code.i32_load(OFF.DATA_ARGS + 4 * i)
            },
            scope,
            ctx,
            code,
          ),
        )
        return
    }
  }

  // ===========================================================================
  // Garbage-collector runtime (hand-assembled WebAssembly)
  // ===========================================================================

  /** `__alloc(size) -> ptr` — round to a 16-aligned cell, maybe collect, then
   *  serve from the free list (first-fit + split) or bump the heap. */
  runtimeAllocBody(): Code {
    const c = new Code()
    const SIZE_L = 0,
      PREV = 1,
      CUR = 2,
      BLK = 3,
      REM = 4,
      NXT = 5,
      RB = 6,
      PTR = 7
    // size = (size + 15) & ~15  (≥ MIN_CELL, so a freed cell holds a free node)
    c.local_get(SIZE_L).i32_const(15).i32_add().i32_const(-16).i32_and().local_set(SIZE_L)
    // collect? (never while locked; always under stress; otherwise on threshold)
    c.global_get(this.gLock).i32_eqz().if_()
    c.global_get(this.gStress)
    c.global_get(this.gBytesSinceGc).local_get(SIZE_L).i32_add().global_get(this.gThreshold).i32_gt_s()
    c.i32_or()
    c.if_()
    c.call(F_GCCOLLECT)
    c.end()
    c.end()
    // live accounting
    c.global_get(this.gAllocCount).i32_const(1).i32_add().global_set(this.gAllocCount)
    c.global_get(this.gAllocBytes).local_get(SIZE_L).i32_add().global_set(this.gAllocBytes)
    c.global_get(this.gBytesSinceGc).local_get(SIZE_L).i32_add().global_set(this.gBytesSinceGc)
    // first-fit over the free list, splitting an oversized block
    c.i32_const(0).local_set(PREV)
    c.global_get(this.gFreeList).local_set(CUR)
    c.block()
    c.loop()
    c.local_get(CUR).i32_eqz().br_if(1)
    c.local_get(CUR).i32_load(FREE_OFF.SIZE).local_set(BLK)
    c.local_get(BLK).local_get(SIZE_L).i32_ge_s().if_()
    c.local_get(CUR).i32_load(FREE_OFF.NEXT).local_set(NXT)
    c.local_get(BLK).local_get(SIZE_L).i32_sub().local_set(REM)
    c.local_get(REM).i32_const(MIN_CELL).i32_ge_s().if_()
    // split: a remainder block at cur+size replaces cur in the list
    c.local_get(CUR).local_get(SIZE_L).i32_add().local_set(RB)
    c.local_get(RB).i32_const(TAG.FREE).i32_store(OFF.TAG)
    c.local_get(RB).local_get(REM).i32_store(FREE_OFF.SIZE)
    c.local_get(RB).local_get(NXT).i32_store(FREE_OFF.NEXT)
    c.local_get(PREV).i32_eqz().if_()
    c.local_get(RB).global_set(this.gFreeList)
    c.else_()
    c.local_get(PREV).local_get(RB).i32_store(FREE_OFF.NEXT)
    c.end()
    c.else_()
    // exact-ish fit: unlink the whole block
    c.local_get(PREV).i32_eqz().if_()
    c.local_get(NXT).global_set(this.gFreeList)
    c.else_()
    c.local_get(PREV).local_get(NXT).i32_store(FREE_OFF.NEXT)
    c.end()
    c.end()
    c.global_get(this.gReuse).i32_const(1).i32_add().global_set(this.gReuse)
    c.local_get(CUR).return_()
    c.end()
    c.local_get(CUR).local_set(PREV)
    c.local_get(CUR).i32_load(FREE_OFF.NEXT).local_set(CUR)
    c.br(0)
    c.end()
    c.end()
    // bump
    c.global_get(this.gHeap).local_set(PTR)
    c.local_get(PTR).local_get(SIZE_L).i32_add().global_set(this.gHeap)
    c.global_get(this.gHeap).global_get(this.gPeakHeap).i32_gt_s().if_()
    c.global_get(this.gHeap).global_set(this.gPeakHeap)
    c.end()
    c.loop()
    c.global_get(this.gHeap)
    c.memory_size().i32_const(16).i32_shl()
    c.i32_gt_u()
    c.if_()
    c.i32_const(1).memory_grow().drop()
    c.br(1)
    c.end()
    c.end()
    c.local_get(PTR)
    return c
  }

  /** `gcPush(p)` — store a root on the shadow stack (trap on overflow). */
  runtimeGcPushBody(): Code {
    const c = new Code()
    c.global_get(this.gShadowSp).i32_const(SHADOW_END).i32_ge_s().if_()
    c.unreachable()
    c.end()
    c.global_get(this.gShadowSp).local_get(0).i32_store(0)
    c.global_get(this.gShadowSp).i32_const(4).i32_add().global_set(this.gShadowSp)
    return c
  }

  /** Emit a counted loop that marks `count` pointer children of `p`. */
  private emitMarkChildren(c: Code, countOff: number, baseOff: number, stride: number, valOff: number): void {
    const CNT = 3,
      I = 4
    c.local_get(0).i32_load(countOff).local_set(CNT)
    c.i32_const(0).local_set(I)
    c.block()
    c.loop()
    c.local_get(I).local_get(CNT).i32_ge_s().br_if(1)
    c.local_get(0).i32_const(baseOff).i32_add().local_get(I).i32_const(stride).i32_mul().i32_add().i32_load(valOff)
    c.call(F_GCMARK)
    c.local_get(I).i32_const(1).i32_add().local_set(I)
    c.br(0)
    c.end()
    c.end()
  }

  /** `gcMark(p)` — non-moving recursive mark. Cons spines iterate (constant
   *  stack for long lists); other shapes recurse by nesting depth. Idempotent on
   *  shared and cyclic graphs (a marked cell returns immediately). */
  runtimeGcMarkBody(): Code {
    const c = new Code()
    const TW = 1,
      TAGL = 2
    c.loop()
    c.local_get(0).i32_const(HEAP_BASE).i32_lt_s().if_() // below the managed heap (int cache / null)
    c.return_()
    c.end()
    c.local_get(0).i32_load(OFF.TAG).local_set(TW)
    c.local_get(TW).i32_const(MARK).i32_and().if_() // already reachable
    c.return_()
    c.end()
    c.local_get(0).local_get(TW).i32_const(MARK).i32_or().i32_store(OFF.TAG)
    c.local_get(TW).i32_const(TAG_MASK).i32_and().local_set(TAGL)
    // CONS — mark head, then loop along the tail (no recursion for long lists)
    c.local_get(TAGL).i32_const(TAG.CONS).i32_eq().if_()
    c.local_get(0).i32_load(OFF.CONS_HEAD).call(F_GCMARK)
    c.local_get(0).i32_load(OFF.CONS_TAIL).local_set(0)
    c.br(1)
    c.end()
    c.local_get(TAGL).i32_const(TAG.TUPLE).i32_eq().if_()
    this.emitMarkChildren(c, OFF.TUPLE_LEN, OFF.TUPLE_ITEMS, 4, 0)
    c.return_()
    c.end()
    c.local_get(TAGL).i32_const(TAG.DATA).i32_eq().if_()
    this.emitMarkChildren(c, OFF.DATA_ARGC, OFF.DATA_ARGS, 4, 0)
    c.return_()
    c.end()
    c.local_get(TAGL).i32_const(TAG.RECORD).i32_eq().if_()
    this.emitMarkChildren(c, OFF.RECORD_COUNT, OFF.RECORD_PAIRS, 8, 4)
    c.return_()
    c.end()
    c.local_get(TAGL).i32_const(TAG.CLOSURE).i32_eq().if_()
    this.emitMarkChildren(c, OFF.CLOSURE_NFREE, OFF.CLOSURE_ENV, 4, 0)
    c.return_()
    c.end()
    c.local_get(TAGL).i32_const(TAG.CTOR).i32_eq().local_get(TAGL).i32_const(TAG.NATIVE).i32_eq().i32_or().if_()
    this.emitMarkChildren(c, OFF.PAP_COLLECTED, OFF.PAP_ARGS, 4, 0)
    c.return_()
    c.end()
    c.return_() // leaf (int / float / bool / unit / nil / str)
    c.end()
    return c
  }

  /** Compute the (16-rounded) footprint of the cell at `pL` with real tag `tagL`
   *  into `szL` — the size the linear sweep must advance by. */
  private emitBlockSize(c: Code, pL: number, tagL: number, szL: number): void {
    c.i32_const(MIN_CELL).local_set(szL) // fixed cells (int/float/bool/unit/nil/str/cons) → 16
    c.local_get(tagL).i32_const(TAG.TUPLE).i32_eq().if_()
    c.local_get(pL).i32_load(OFF.TUPLE_LEN).i32_const(4).i32_mul().i32_const(OFF.TUPLE_ITEMS).i32_add().local_set(szL)
    c.end()
    c.local_get(tagL).i32_const(TAG.DATA).i32_eq().if_()
    c.local_get(pL).i32_load(OFF.DATA_ARGC).i32_const(4).i32_mul().i32_const(OFF.DATA_ARGS).i32_add().local_set(szL)
    c.end()
    c.local_get(tagL).i32_const(TAG.RECORD).i32_eq().if_()
    c.local_get(pL).i32_load(OFF.RECORD_COUNT).i32_const(8).i32_mul().i32_const(OFF.RECORD_PAIRS).i32_add().local_set(szL)
    c.end()
    c.local_get(tagL).i32_const(TAG.CLOSURE).i32_eq().if_()
    c.local_get(pL).i32_load(OFF.CLOSURE_NFREE).i32_const(4).i32_mul().i32_const(OFF.CLOSURE_ENV).i32_add().local_set(szL)
    c.end()
    c.local_get(tagL).i32_const(TAG.CTOR).i32_eq().local_get(tagL).i32_const(TAG.NATIVE).i32_eq().i32_or().if_()
    c.local_get(pL).i32_load(OFF.PAP_ARITY).i32_const(4).i32_mul().i32_const(OFF.PAP_ARGS).i32_add().local_set(szL)
    c.end()
    c.local_get(tagL).i32_const(TAG.FREE).i32_eq().if_()
    c.local_get(pL).i32_load(FREE_OFF.SIZE).local_set(szL)
    c.end()
    c.local_get(szL).i32_const(15).i32_add().i32_const(-16).i32_and().local_set(szL) // round (no-op for free/fixed)
  }

  /** Flush a pending coalesced run `[runStart, runStart+runLen)` into the free list. */
  private emitFlushRun(c: Code, runStart: number, runLen: number): void {
    c.local_get(runStart).if_()
    c.local_get(runStart).i32_const(TAG.FREE).i32_store(OFF.TAG)
    c.local_get(runStart).local_get(runLen).i32_store(FREE_OFF.SIZE)
    c.local_get(runStart).global_get(this.gFreeList).i32_store(FREE_OFF.NEXT)
    c.local_get(runStart).global_set(this.gFreeList)
    c.i32_const(0).local_set(runStart)
    c.i32_const(0).local_set(runLen)
    c.end()
  }

  /** `gcCollect()` — mark from the roots, then sweep the heap into a coalesced
   *  free list, clearing marks and updating the adaptive threshold. */
  runtimeCollectBody(): Code {
    const c = new Code()
    const P = 0,
      RUNS = 1,
      RUNL = 2,
      LIVE = 3,
      FREED = 4,
      TW = 5,
      TAGL = 6,
      SZ = 7,
      T = 8
    c.call(F_GCMARKROOTS)
    c.i32_const(0).global_set(this.gFreeList)
    c.i32_const(HEAP_BASE).local_set(P)
    c.i32_const(0).local_set(RUNS)
    c.i32_const(0).local_set(RUNL)
    c.i32_const(0).local_set(LIVE)
    c.i32_const(0).local_set(FREED)
    c.block()
    c.loop()
    c.local_get(P).global_get(this.gHeap).i32_ge_s().br_if(1)
    c.local_get(P).i32_load(OFF.TAG).local_set(TW)
    c.local_get(TW).i32_const(TAG_MASK).i32_and().local_set(TAGL)
    this.emitBlockSize(c, P, TAGL, SZ)
    c.local_get(TW).i32_const(MARK).i32_and().if_()
    // live: clear the mark, flush any pending free run, tally
    c.local_get(P).local_get(TAGL).i32_store(OFF.TAG)
    this.emitFlushRun(c, RUNS, RUNL)
    c.local_get(LIVE).local_get(SZ).i32_add().local_set(LIVE)
    c.else_()
    // dead (or already free): extend the coalescing run
    c.local_get(TAGL).i32_const(TAG.FREE).i32_ne().if_()
    c.local_get(FREED).local_get(SZ).i32_add().local_set(FREED)
    c.end()
    c.local_get(RUNS).i32_eqz().if_()
    c.local_get(P).local_set(RUNS)
    c.i32_const(0).local_set(RUNL)
    c.end()
    c.local_get(RUNL).local_get(SZ).i32_add().local_set(RUNL)
    c.end()
    c.local_get(P).local_get(SZ).i32_add().local_set(P)
    c.br(0)
    c.end()
    c.end()
    this.emitFlushRun(c, RUNS, RUNL)
    c.global_get(this.gCollections).i32_const(1).i32_add().global_set(this.gCollections)
    c.global_get(this.gReclaimed).local_get(FREED).i32_add().global_set(this.gReclaimed)
    c.local_get(LIVE).global_set(this.gLiveBytes)
    c.i32_const(0).global_set(this.gBytesSinceGc)
    // threshold = max(GC_MIN_THRESHOLD, 2 × live)
    c.local_get(LIVE).i32_const(1).i32_shl().local_set(T)
    c.local_get(T).i32_const(GC_MIN_THRESHOLD).i32_lt_s().if_()
    c.i32_const(GC_MIN_THRESHOLD).local_set(T)
    c.end()
    c.local_get(T).global_set(this.gThreshold)
    return c
  }

  /** `mkCons(head, tail)` — roots both arguments across its single allocation. */
  runtimeMkConsBody(): Code {
    const c = new Code()
    const HEAD = 0,
      TAIL = 1,
      CELL = 2,
      FP = 3
    c.global_get(this.gShadowSp).local_set(FP)
    c.local_get(HEAD).call(F_GCPUSH)
    c.local_get(TAIL).call(F_GCPUSH)
    c.i32_const(SIZE.CONS).call(F_ALLOC).local_set(CELL)
    c.local_get(CELL).i32_const(TAG.CONS).i32_store(OFF.TAG)
    c.local_get(CELL).local_get(HEAD).i32_store(OFF.CONS_HEAD)
    c.local_get(CELL).local_get(TAIL).i32_store(OFF.CONS_TAIL)
    c.local_get(FP).global_set(this.gShadowSp)
    c.local_get(CELL)
    return c
  }

  /** `listAppend(a, b)` — `a` is rooted, so `a.head` survives the recursive
   *  call's allocations even while it sits on the operand stack. */
  runtimeListAppendBody(): Code {
    const c = new Code()
    const A = 0,
      B = 1,
      FP = 2
    c.global_get(this.gShadowSp).local_set(FP)
    c.local_get(A).call(F_GCPUSH)
    c.local_get(B).call(F_GCPUSH)
    c.local_get(A).i32_load(OFF.TAG).i32_const(TAG.NIL).i32_eq().if_(I32)
    c.local_get(B)
    c.else_()
    c.local_get(A).i32_load(OFF.CONS_HEAD)
    c.local_get(A).i32_load(OFF.CONS_TAIL).local_get(B).call(F_LISTAPPEND)
    c.call(F_MKCONS)
    c.end()
    c.local_get(FP).global_set(this.gShadowSp)
    return c
  }

  /** `recCopy(rec)` — roots `rec` across its single allocation; the field copy
   *  loop allocates nothing. */
  runtimeRecCopyBody(): Code {
    const c = new Code()
    const REC = 0,
      CNT = 1,
      SZ = 2,
      NP = 3,
      I = 4,
      FP = 5
    c.global_get(this.gShadowSp).local_set(FP)
    c.local_get(REC).call(F_GCPUSH)
    c.local_get(REC).i32_load(OFF.RECORD_COUNT).local_set(CNT)
    c.i32_const(OFF.RECORD_PAIRS).local_get(CNT).i32_const(8).i32_mul().i32_add().local_set(SZ)
    c.local_get(SZ).call(F_ALLOC).local_set(NP)
    c.local_get(NP).i32_const(TAG.RECORD).i32_store(OFF.TAG)
    c.local_get(NP).local_get(CNT).i32_store(OFF.RECORD_COUNT)
    c.i32_const(0).local_set(I)
    c.block()
    c.loop()
    c.local_get(I).local_get(CNT).i32_ge_s().br_if(1)
    c.local_get(NP).i32_const(OFF.RECORD_PAIRS).i32_add().local_get(I).i32_const(8).i32_mul().i32_add()
    c.local_get(REC).i32_const(OFF.RECORD_PAIRS).i32_add().local_get(I).i32_const(8).i32_mul().i32_add().i32_load(0)
    c.i32_store(0)
    c.local_get(NP).i32_const(OFF.RECORD_PAIRS).i32_add().local_get(I).i32_const(8).i32_mul().i32_add()
    c.local_get(REC).i32_const(OFF.RECORD_PAIRS).i32_add().local_get(I).i32_const(8).i32_mul().i32_add().i32_load(4)
    c.i32_store(4)
    c.local_get(I).i32_const(1).i32_add().local_set(I)
    c.br(0)
    c.end()
    c.end()
    c.local_get(FP).global_set(this.gShadowSp)
    c.local_get(NP)
    return c
  }

  /** `apply(f, x)` — roots `f`/`x` (and the partial-application cell across the
   *  host `callNative`); pops the frame before the closure tail-dispatch. */
  runtimeApplyBody(applyType: number): Code {
    const c = new Code()
    const F = 0,
      X = 1,
      TG = 2,
      ARITY = 3,
      COLL = 4,
      NP = 5,
      I = 6,
      DP = 7,
      J = 8,
      FP = 9
    c.global_get(this.gShadowSp).local_set(FP)
    c.local_get(F).call(F_GCPUSH)
    c.local_get(X).call(F_GCPUSH)
    c.local_get(F).i32_load(OFF.TAG).local_set(TG)
    // closure → tail-dispatch (abandon the frame first)
    c.local_get(TG).i32_const(TAG.CLOSURE).i32_eq().if_()
    c.local_get(FP).global_set(this.gShadowSp)
    c.local_get(F).local_get(X).local_get(F).i32_load(OFF.CLOSURE_FUNC).return_call_indirect(applyType)
    c.end()
    // native / ctor: accumulate one argument into a fresh pap cell
    c.local_get(F).i32_load(OFF.PAP_ARITY).local_set(ARITY)
    c.local_get(F).i32_load(OFF.PAP_COLLECTED).local_set(COLL)
    c.i32_const(OFF.PAP_ARGS).local_get(ARITY).i32_const(4).i32_mul().i32_add().call(F_ALLOC).local_set(NP)
    c.local_get(NP).local_get(TG).i32_store(OFF.TAG)
    c.local_get(NP).local_get(F).i32_load(OFF.PAP_ID).i32_store(OFF.PAP_ID)
    c.local_get(NP).local_get(ARITY).i32_store(OFF.PAP_ARITY)
    c.local_get(NP).local_get(COLL).i32_const(1).i32_add().i32_store(OFF.PAP_COLLECTED)
    c.i32_const(0).local_set(I)
    c.block()
    c.loop()
    c.local_get(I).local_get(COLL).i32_ge_s().br_if(1)
    c.local_get(NP).i32_const(OFF.PAP_ARGS).i32_add().local_get(I).i32_const(4).i32_mul().i32_add()
    c.local_get(F).i32_const(OFF.PAP_ARGS).i32_add().local_get(I).i32_const(4).i32_mul().i32_add().i32_load(0)
    c.i32_store(0)
    c.local_get(I).i32_const(1).i32_add().local_set(I)
    c.br(0)
    c.end()
    c.end()
    c.local_get(NP).i32_const(OFF.PAP_ARGS).i32_add().local_get(COLL).i32_const(4).i32_mul().i32_add().local_get(X).i32_store(0)
    c.local_get(NP).call(F_GCPUSH) // root the new pap cell (DATA build / callNative below allocate)
    c.local_get(COLL).i32_const(1).i32_add().local_get(ARITY).i32_eq().if_(I32)
    c.local_get(TG).i32_const(TAG.NATIVE).i32_eq().if_(I32)
    c.i32_const(1).global_set(this.gLock)
    c.local_get(NP).call(IMP_CALLNATIVE)
    c.i32_const(0).global_set(this.gLock)
    c.else_()
    c.i32_const(OFF.DATA_ARGS).local_get(ARITY).i32_const(4).i32_mul().i32_add().call(F_ALLOC).local_set(DP)
    c.local_get(DP).i32_const(TAG.DATA).i32_store(OFF.TAG)
    c.local_get(DP).local_get(NP).i32_load(OFF.PAP_ID).i32_store(OFF.DATA_NAME)
    c.local_get(DP).local_get(ARITY).i32_store(OFF.DATA_ARGC)
    c.i32_const(0).local_set(J)
    c.block()
    c.loop()
    c.local_get(J).local_get(ARITY).i32_ge_s().br_if(1)
    c.local_get(DP).i32_const(OFF.DATA_ARGS).i32_add().local_get(J).i32_const(4).i32_mul().i32_add()
    c.local_get(NP).i32_const(OFF.PAP_ARGS).i32_add().local_get(J).i32_const(4).i32_mul().i32_add().i32_load(0)
    c.i32_store(0)
    c.local_get(J).i32_const(1).i32_add().local_set(J)
    c.br(0)
    c.end()
    c.end()
    c.local_get(DP)
    c.end()
    c.else_()
    c.local_get(NP)
    c.end()
    c.local_get(FP).global_set(this.gShadowSp)
    return c
  }
}

// ---------------------------------------------------------------------------
// Runtime function bodies
// ---------------------------------------------------------------------------

function runtimeBoxInt(gCacheHits: number): Code {
  const c = new Code()
  // in the small-int range? return the shared, pre-built cell at CACHE_BASE + (n-LO)*SIZE.INT
  c.local_get(0).i32_const(SMALLINT_LO).i32_ge_s()
  c.local_get(0).i32_const(SMALLINT_HI).i32_lt_s()
  c.i32_and()
  c.if_(I32)
  c.global_get(gCacheHits).i32_const(1).i32_add().global_set(gCacheHits)
  // SIZE.INT is 8 ⇒ shift left by 3
  c.local_get(0).i32_const(SMALLINT_LO).i32_sub().i32_const(3).i32_shl().i32_const(CACHE_BASE).i32_add()
  c.else_()
  c.i32_const(SIZE.INT).call(F_ALLOC).local_set(1)
  c.local_get(1).i32_const(TAG.INT).i32_store(OFF.TAG)
  c.local_get(1).local_get(0).i32_store(OFF.INT_VAL)
  c.local_get(1)
  c.end()
  return c
}
function runtimeBoxFloat(): Code {
  const c = new Code()
  c.i32_const(SIZE.FLOAT).call(F_ALLOC).local_set(1)
  c.local_get(1).i32_const(TAG.FLOAT).i32_store(OFF.TAG)
  c.local_get(1).local_get(0).f64_store(OFF.FLOAT_VAL)
  c.local_get(1)
  return c
}
function runtimeBoxBool(gTrue: number, gFalse: number): Code {
  const c = new Code()
  c.local_get(0).if_(I32).global_get(gTrue).else_().global_get(gFalse).end()
  return c
}
function runtimeBoxStr(): Code {
  const c = new Code()
  c.i32_const(SIZE.STR).call(F_ALLOC).local_set(1)
  c.local_get(1).i32_const(TAG.STR).i32_store(OFF.TAG)
  c.local_get(1).local_get(0).i32_store(OFF.STR_ID)
  c.local_get(1)
  return c
}
function runtimeAsF64(): Code {
  const c = new Code()
  c.local_get(0).i32_load(OFF.TAG).i32_const(TAG.FLOAT).i32_eq()
  c.if_(F64)
  c.local_get(0).f64_load(OFF.FLOAT_VAL)
  c.else_()
  c.local_get(0).i32_load(OFF.INT_VAL).f64_convert_i32_s()
  c.end()
  return c
}
function runtimeCmpVals(): Code {
  const c = new Code()
  c.local_get(0).i32_load(OFF.TAG).local_set(2) // ta
  c.local_get(1).i32_load(OFF.TAG).local_set(3) // tb
  // numeric on both sides?
  c.local_get(2).i32_const(TAG.INT).i32_eq().local_get(2).i32_const(TAG.FLOAT).i32_eq().i32_or()
  c.local_get(3).i32_const(TAG.INT).i32_eq().local_get(3).i32_const(TAG.FLOAT).i32_eq().i32_or()
  c.i32_and()
  c.if_(I32)
  c.local_get(0).call(F_ASF64).local_set(4) // af
  c.local_get(1).call(F_ASF64).local_set(5) // bf
  c.local_get(4).local_get(5).f64_lt()
  c.if_(I32)
  c.i32_const(-1)
  c.else_()
  c.local_get(5).local_get(4).f64_lt()
  c.if_(I32).i32_const(1).else_().i32_const(0).end()
  c.end()
  c.else_()
  // both bool?
  c.local_get(2).i32_const(TAG.BOOL).i32_eq().local_get(3).i32_const(TAG.BOOL).i32_eq().i32_and()
  c.if_(I32)
  c.local_get(0).i32_load(OFF.BOOL_VAL).local_get(1).i32_load(OFF.BOOL_VAL).i32_sub()
  c.else_()
  c.local_get(0).local_get(1).call(IMP_VALUECMP)
  c.end()
  c.end()
  return c
}
function runtimeRecGet(): Code {
  // params: rec(0), labelId(1); locals: count(2), i(3), base(4)
  const c = new Code()
  c.local_get(0).i32_load(OFF.RECORD_COUNT).local_set(2)
  c.i32_const(0).local_set(3)
  c.block(I32)
  c.loop()
  // base = rec + RECORD_PAIRS + i*8
  c.local_get(0).i32_const(OFF.RECORD_PAIRS).i32_add().local_get(3).i32_const(8).i32_mul().i32_add().local_set(4)
  c.local_get(4).i32_load(0).local_get(1).i32_eq()
  c.if_()
  c.local_get(4).i32_load(4).br(2)
  c.end()
  c.local_get(3).i32_const(1).i32_add().local_set(3)
  c.local_get(3).local_get(2).i32_lt_s().br_if(0)
  c.end()
  c.unreachable()
  c.end()
  return c
}
function runtimeRecSet(): Code {
  // params rec(0), labelId(1), val(2); locals count(3), i(4), base(5)
  const c = new Code()
  c.local_get(0).i32_load(OFF.RECORD_COUNT).local_set(3)
  c.i32_const(0).local_set(4)
  c.block()
  c.loop()
  c.local_get(0).i32_const(OFF.RECORD_PAIRS).i32_add().local_get(4).i32_const(8).i32_mul().i32_add().local_set(5)
  c.local_get(5).i32_load(0).local_get(1).i32_eq()
  c.if_()
  c.local_get(5).local_get(2).i32_store(4).br(2)
  c.end()
  c.local_get(4).i32_const(1).i32_add().local_set(4)
  c.local_get(4).local_get(3).i32_lt_s().br_if(0)
  c.end()
  c.end()
  return c
}
export function compileToWasm(userCoreAst: Expr): WasmModule {
  const gen = new Gen()
  const m = gen.module

  // 1. imports (indices 0..2)
  m.importFunc('env', 'callNative', [I32], [I32])
  m.importFunc('env', 'valueCmp', [I32, I32], [I32])
  m.importFunc('env', 'strConcat', [I32, I32], [I32])

  // 2. pre-collect ctor/string/label ids over prelude + user
  for (const d of PRELUDE_PARSED) gen.collect(d.value)
  gen.collect(userCoreAst)

  // every emitted module needs at least enough memory for the int cache + the
  // shadow stack before the first allocation grows it.
  m.setMinPages(INITIAL_PAGES)

  // 3. WASM globals
  gen.gHeap = m.addGlobal(I32, true, new Code().i32_const(HEAP_BASE), 'heap')
  gen.gUnit = m.addGlobal(I32, true, new Code().i32_const(0), 'unit')
  gen.gNil = m.addGlobal(I32, true, new Code().i32_const(0), 'nil')
  gen.gTrue = m.addGlobal(I32, true, new Code().i32_const(0), 'true_')
  gen.gFalse = m.addGlobal(I32, true, new Code().i32_const(0), 'false_')
  gen.gPi = m.addGlobal(I32, true, new Code().i32_const(0), 'pi')
  // live heap accounting (read back through exported getters after `main`)
  gen.gAllocCount = m.addGlobal(I32, true, new Code().i32_const(0), 'allocCount')
  gen.gAllocBytes = m.addGlobal(I32, true, new Code().i32_const(0), 'allocBytes')
  gen.gCacheHits = m.addGlobal(I32, true, new Code().i32_const(0), 'cacheHits')
  // garbage-collector state
  gen.gShadowSp = m.addGlobal(I32, true, new Code().i32_const(SHADOW_BASE), 'shadowSp')
  gen.gFreeList = m.addGlobal(I32, true, new Code().i32_const(0), 'freeList')
  gen.gLock = m.addGlobal(I32, true, new Code().i32_const(0), 'gcLock')
  gen.gStress = m.addGlobal(I32, true, new Code().i32_const(0), 'gcStress')
  gen.gBytesSinceGc = m.addGlobal(I32, true, new Code().i32_const(0), 'bytesSinceGc')
  gen.gThreshold = m.addGlobal(I32, true, new Code().i32_const(GC_MIN_THRESHOLD), 'gcThreshold')
  gen.gCollections = m.addGlobal(I32, true, new Code().i32_const(0), 'gcCollections')
  gen.gReclaimed = m.addGlobal(I32, true, new Code().i32_const(0), 'gcReclaimed')
  gen.gLiveBytes = m.addGlobal(I32, true, new Code().i32_const(0), 'gcLiveBytes')
  gen.gPeakHeap = m.addGlobal(I32, true, new Code().i32_const(HEAP_BASE), 'gcPeakHeap')
  gen.gReuse = m.addGlobal(I32, true, new Code().i32_const(0), 'gcReuse')
  gen.gNative = NATIVE_GLOBALS.map((g) => m.addGlobal(I32, true, new Code().i32_const(0), `b_${g.name}`))

  // 4. runtime functions (indices 3..19, in the fixed order the constants expect)
  m.addFunc([I32], [I32], [I32, I32, I32, I32, I32, I32, I32], gen.runtimeAllocBody(), '__alloc')
  m.addFunc([I32], [I32], [I32], runtimeBoxInt(gen.gCacheHits), undefined, 'boxInt')
  m.addFunc([F64], [I32], [I32], runtimeBoxFloat(), undefined, 'boxFloat')
  m.addFunc([I32], [I32], [], runtimeBoxBool(gen.gTrue, gen.gFalse), undefined, 'boxBool')
  m.addFunc([I32], [I32], [I32], runtimeBoxStr(), undefined, 'boxStr')
  m.addFunc([I32, I32], [I32], [I32, I32], gen.runtimeMkConsBody(), undefined, 'mkCons')
  m.addFunc([I32], [F64], [], runtimeAsF64(), undefined, 'asF64')
  m.addFunc([I32, I32], [I32], [I32, I32, F64, F64], runtimeCmpVals(), undefined, 'cmpVals')
  m.addFunc([I32, I32], [I32], [I32], gen.runtimeListAppendBody(), undefined, 'listAppend')
  m.addFunc([I32, I32], [I32], [I32, I32, I32], runtimeRecGet(), undefined, 'recGet')
  m.addFunc([I32, I32, I32], [], [I32, I32, I32], runtimeRecSet(), undefined, 'recSet')
  m.addFunc([I32], [I32], [I32, I32, I32, I32, I32], gen.runtimeRecCopyBody(), undefined, 'recCopy')
  m.addFunc([I32, I32], [I32], [I32, I32, I32, I32, I32, I32, I32, I32], gen.runtimeApplyBody(gen.applyType), undefined, 'apply')
  // the garbage collector (indices 16..19)
  m.addFunc([I32], [], [], gen.runtimeGcPushBody(), undefined, 'gcPush')
  m.addFunc([I32], [], [I32, I32, I32, I32], gen.runtimeGcMarkBody(), undefined, 'gcMark')
  const markRootsCode = new Code()
  m.addFunc([], [], [I32], markRootsCode, undefined, 'gcMarkRoots')
  m.addFunc([], [], [I32, I32, I32, I32, I32, I32, I32, I32, I32], gen.runtimeCollectBody(), '__gcCollect', 'gcCollect')

  // 5. global scope: builtins, pi, and every top-level binding/ctor name
  NATIVE_GLOBALS.forEach((g, i) => {
    gen.globalScope.set(g.name, { kind: 'global', idx: gen.gNative[i] })
    if (INLINE_BUILTINS.has(g.name)) gen.builtinGlobalIdx.set(g.name, gen.gNative[i])
  })
  gen.globalScope.set('pi', { kind: 'global', idx: gen.gPi })

  const preludeBindings: TopBinding[] = PRELUDE_PARSED.map((d) => ({
    kind: 'let',
    name: d.name,
    value: d.value,
    recursive: d.recursive,
  }))
  const { bindings: userBindings, final } = flattenUser(userCoreAst)
  const allBindings = [...preludeBindings, ...userBindings]

  // declare a WASM global for every top-level binding / constructor up front
  const topGlobals = new Map<string, number>()
  const declareName = (name: string): void => {
    if (!topGlobals.has(name)) {
      const idx = m.addGlobal(I32, true, new Code().i32_const(0), `g_${name}`)
      topGlobals.set(name, idx)
      gen.globalScope.set(name, { kind: 'global', idx })
    }
  }
  for (const b of allBindings) {
    if (b.kind === 'let') declareName(b.name)
    else if (b.kind === 'letrec') for (const x of b.bindings) declareName(x.name)
    else for (const c of b.ctors) declareName(c.name)
  }

  // Now that every value global is known, fill in `gcMarkRoots`: scan the whole
  // shadow stack, then mark each global that holds a heap pointer (the singletons,
  // pi, native cells, and every top-level binding / constructor).
  markRootsCode.i32_const(SHADOW_BASE).local_set(0)
  markRootsCode.block()
  markRootsCode.loop()
  markRootsCode.local_get(0).global_get(gen.gShadowSp).i32_ge_s().br_if(1)
  markRootsCode.local_get(0).i32_load(0).call(F_GCMARK)
  markRootsCode.local_get(0).i32_const(4).i32_add().local_set(0)
  markRootsCode.br(0)
  markRootsCode.end()
  markRootsCode.end()
  const valueGlobals = [gen.gUnit, gen.gNil, gen.gTrue, gen.gFalse, gen.gPi, ...gen.gNative, ...topGlobals.values()]
  for (const g of valueGlobals) markRootsCode.global_get(g).call(F_GCMARK)

  // 6. main: initialise the small-int cache + singletons + natives, assign globals, return final value
  const mainCtx = new FuncCtx(0)
  const main = new Code()

  // Disable the collector while the runtime bootstraps (the singletons/natives it
  // allocates are stored straight into globals, which only become scannable roots
  // once set); then capture `main`'s shadow frame and re-enable collection.
  main.i32_const(1).global_set(gen.gLock)
  gen.emitFrameEnter(mainCtx, main)

  // small-integer cache: pre-build one shared INT cell per value in [LO, HI).
  // cell `i` at CACHE_BASE + i*8 holds INT (LO + i); `boxInt` returns these directly.
  {
    const ci = mainCtx.newLocal()
    const addr = mainCtx.newLocal()
    main.i32_const(0).local_set(ci)
    main.block()
    main.loop()
    main.local_get(ci).i32_const(SMALLINT_COUNT).i32_ge_s().br_if(1)
    main.i32_const(CACHE_BASE).local_get(ci).i32_const(3).i32_shl().i32_add().local_set(addr)
    main.local_get(addr).i32_const(TAG.INT).i32_store(OFF.TAG)
    main.local_get(addr).i32_const(SMALLINT_LO).local_get(ci).i32_add().i32_store(OFF.INT_VAL)
    main.local_get(ci).i32_const(1).i32_add().local_set(ci)
    main.br(0)
    main.end()
    main.end()
  }

  // singletons
  const initSingleton = (tag: number, size: number, glob: number, extra?: (c: Code, tmp: number) => void): void => {
    const tmp = mainCtx.newLocal()
    main.i32_const(size).call(F_ALLOC).local_set(tmp)
    main.local_get(tmp).i32_const(tag).i32_store(OFF.TAG)
    if (extra) extra(main, tmp)
    main.local_get(tmp).global_set(glob)
  }
  initSingleton(TAG.UNIT, SIZE.UNIT, gen.gUnit)
  initSingleton(TAG.NIL, SIZE.NIL, gen.gNil)
  initSingleton(TAG.BOOL, SIZE.BOOL, gen.gTrue, (c, t) => c.local_get(t).i32_const(1).i32_store(OFF.BOOL_VAL))
  initSingleton(TAG.BOOL, SIZE.BOOL, gen.gFalse, (c, t) => c.local_get(t).i32_const(0).i32_store(OFF.BOOL_VAL))
  // pi
  {
    const tmp = mainCtx.newLocal()
    main.i32_const(SIZE.FLOAT).call(F_ALLOC).local_set(tmp)
    main.local_get(tmp).i32_const(TAG.FLOAT).i32_store(OFF.TAG)
    main.local_get(tmp).f64_const(Math.PI).f64_store(OFF.FLOAT_VAL)
    main.local_get(tmp).global_set(gen.gPi)
  }
  // native builtin cells
  NATIVE_GLOBALS.forEach((g, i) => {
    if (g.value.tag !== 'native') return
    const arity = g.value.arity
    const tmp = mainCtx.newLocal()
    main.i32_const(papSize(arity)).call(F_ALLOC).local_set(tmp)
    main.local_get(tmp).i32_const(TAG.NATIVE).i32_store(OFF.TAG)
    main.local_get(tmp).i32_const(i).i32_store(OFF.PAP_ID)
    main.local_get(tmp).i32_const(arity).i32_store(OFF.PAP_ARITY)
    main.local_get(tmp).i32_const(0).i32_store(OFF.PAP_COLLECTED)
    main.local_get(tmp).global_set(gen.gNative[i])
  })

  // bootstrap done — the collector may now run between user allocations.
  main.i32_const(0).global_set(gen.gLock)

  // top-level bindings → global assignments
  const emitCtorGlobal = (name: string, arity: number): void => {
    const glob = topGlobals.get(name)!
    const nameId = gen.internCtor(name)
    const tmp = mainCtx.newLocal()
    if (arity === 0) {
      main.i32_const(dataSize(0)).call(F_ALLOC).local_set(tmp)
      main.local_get(tmp).i32_const(TAG.DATA).i32_store(OFF.TAG)
      main.local_get(tmp).i32_const(nameId).i32_store(OFF.DATA_NAME)
      main.local_get(tmp).i32_const(0).i32_store(OFF.DATA_ARGC)
    } else {
      main.i32_const(papSize(arity)).call(F_ALLOC).local_set(tmp)
      main.local_get(tmp).i32_const(TAG.CTOR).i32_store(OFF.TAG)
      main.local_get(tmp).i32_const(nameId).i32_store(OFF.PAP_ID)
      main.local_get(tmp).i32_const(arity).i32_store(OFF.PAP_ARITY)
      main.local_get(tmp).i32_const(0).i32_store(OFF.PAP_COLLECTED)
    }
    main.local_get(tmp).global_set(glob)
  }

  // a binding's value, naming the WASM function after the binding when it is a lambda
  const compileNamedValue = (value: Expr, name: string): void => {
    if (value.kind === 'lambda') gen.emitClosure(value, gen.globalScope, gen.globalScope, mainCtx, main, name)
    else gen.compileExpr(value, gen.globalScope, mainCtx, main)
  }

  for (const b of allBindings) {
    if (b.kind === 'let') {
      compileNamedValue(b.value, b.name)
      main.global_set(topGlobals.get(b.name)!)
    } else if (b.kind === 'letrec') {
      // top-level mutual recursion: each value is a lambda referencing the others
      // via globals, so we can compile and assign independently.
      for (const x of b.bindings) {
        compileNamedValue(x.value, x.name)
        main.global_set(topGlobals.get(x.name)!)
      }
    } else {
      for (const c of b.ctors) emitCtorGlobal(c.name, c.arity)
    }
  }

  // final expression → return value (tail position), then reclaim main's frame
  gen.compileTail(final, gen.globalScope, mainCtx, main)
  gen.emitReturn(mainCtx, main)
  m.addFunc([], [I32], mainCtx.localTypes, main, 'main')

  // exported getters for the live heap accounting (read back by the driver after `main`)
  m.addFunc([], [I32], [], new Code().global_get(gen.gAllocCount), '__allocCount')
  m.addFunc([], [I32], [], new Code().global_get(gen.gAllocBytes), '__allocBytes')
  m.addFunc([], [I32], [], new Code().global_get(gen.gCacheHits), '__cacheHits')
  // garbage-collector stats + controls (read/driven by the runner)
  m.addFunc([], [I32], [], new Code().global_get(gen.gCollections), '__gcCollections')
  m.addFunc([], [I32], [], new Code().global_get(gen.gReclaimed), '__gcReclaimed')
  m.addFunc([], [I32], [], new Code().global_get(gen.gLiveBytes), '__gcLiveBytes')
  m.addFunc([], [I32], [], new Code().global_get(gen.gPeakHeap), '__gcPeakHeap')
  m.addFunc([], [I32], [], new Code().global_get(gen.gReuse), '__gcReuse')
  // toggle stress mode (collect before every allocation) — used to prove that no
  // root is ever missed: the result must be identical with the collector firing
  // maximally between allocations.
  m.addFunc([I32], [], [], new Code().local_get(0).global_set(gen.gStress), '__setGcStress')

  const bytes = m.emit()
  return {
    bytes,
    stringLiterals: gen.stringLiterals,
    ctorNames: gen.ctorNames,
    labels: gen.labels,
    stats: {
      funcCount: m.definedFuncCount,
      importCount: m.importCount,
      globalCount: 20 + gen.gNative.length + topGlobals.size,
      byteLength: bytes.length,
    },
  }
}
