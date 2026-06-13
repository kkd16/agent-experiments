// Aether — bytecode compiler
//
// Lowers the AST to stack-machine bytecode. Each lambda becomes its own
// `FnProto`; free variables of a lambda are captured as clox-style upvalues
// (by reference, so recursion and shared closures work). `let` is compiled with
// a real local slot that is closed and slid off the stack when its scope ends;
// `let rec` reserves the slot first so the closure can capture itself.

import type { BinaryOp, Expr, Pattern } from './ast.ts'
import type { Span } from './lexer.ts'
import type { FnProto, UpvalueDesc } from './bytecode.ts'
import { Op } from './bytecode.ts'
import { GLOBAL_INDEX } from './prelude.ts'
import type { Value } from './values.ts'
import { vbool, vfloat, vint, vstr } from './values.ts'

export class CompileError extends Error {
  span: Span | null
  constructor(message: string, span: Span | null) {
    super(message)
    this.name = 'CompileError'
    this.span = span
  }
}

interface Local {
  name: string
  slot: number
}

class FnCompiler {
  proto: FnProto
  enclosing: FnCompiler | null
  locals: Local[] = []
  /** current stack height relative to the frame base (mirrors the VM) */
  height = 0

  constructor(name: string, numParams: number, enclosing: FnCompiler | null) {
    this.enclosing = enclosing
    this.proto = {
      name,
      numParams,
      numLocals: numParams,
      code: [],
      constants: [],
      upvalues: [],
      childProtos: [],
      spans: [],
    }
    this.height = numParams
  }

  private emit(op: number, span: Span | null): void {
    this.proto.code.push(op)
    this.proto.spans.push(span)
  }

  // emit an opcode plus a single operand word, updating the simulated height
  op(op: number, span: Span | null, effect: number, operand?: number): void {
    this.emit(op, span)
    if (operand !== undefined) {
      this.proto.code.push(operand)
      this.proto.spans.push(span)
    }
    this.height += effect
    if (this.height > this.proto.numLocals) this.proto.numLocals = this.height
  }

  here(): number {
    return this.proto.code.length
  }

  constant(v: Value): number {
    this.proto.constants.push(v)
    return this.proto.constants.length - 1
  }

  declareLocal(name: string): number {
    const slot = this.height - 1
    this.locals.push({ name, slot })
    return slot
  }

  resolveLocal(name: string): number {
    for (let i = this.locals.length - 1; i >= 0; i--) {
      if (this.locals[i].name === name) return this.locals[i].slot
    }
    return -1
  }

  resolveUpvalue(name: string): number {
    if (!this.enclosing) return -1
    const localSlot = this.enclosing.resolveLocal(name)
    if (localSlot >= 0) return this.addUpvalue(localSlot, true, name)
    const up = this.enclosing.resolveUpvalue(name)
    if (up >= 0) return this.addUpvalue(up, false, name)
    return -1
  }

  private addUpvalue(index: number, fromLocal: boolean, name: string): number {
    const ups = this.proto.upvalues
    for (let i = 0; i < ups.length; i++) {
      if (ups[i].index === index && ups[i].fromLocal === fromLocal) return i
    }
    const desc: UpvalueDesc = { index, fromLocal, name }
    ups.push(desc)
    return ups.length - 1
  }
}

class Compiler {
  compileProgram(program: Expr): FnProto {
    const main = new FnCompiler('main', 0, null)
    this.compileExpr(main, program, true)
    main.op(Op.RETURN, program.span, 0)
    return main.proto
  }

  // `tail` marks expressions whose value is the enclosing function's result, so
  // calls there can reuse the current frame (tail-call optimisation).
  private compileExpr(c: FnCompiler, e: Expr, tail = false): void {
    switch (e.kind) {
      case 'int':
        c.op(Op.CONST, e.span, +1, c.constant(vint(e.value)))
        return
      case 'float':
        c.op(Op.CONST, e.span, +1, c.constant(vfloat(e.value)))
        return
      case 'str':
        c.op(Op.CONST, e.span, +1, c.constant(vstr(e.value)))
        return
      case 'bool':
        c.op(e.value ? Op.TRUE : Op.FALSE, e.span, +1)
        return
      case 'unit':
        c.op(Op.UNIT, e.span, +1)
        return
      case 'var':
        this.compileVar(c, e)
        return
      case 'lambda':
        this.compileLambda(c, e, 'lambda')
        return
      case 'app':
        this.compileExpr(c, e.fn)
        this.compileExpr(c, e.arg)
        c.op(tail ? Op.TAILCALL : Op.CALL, e.span, -1, 1)
        return
      case 'let':
        this.compileLet(c, e, tail)
        return
      case 'if':
        this.compileIf(c, e.cond, e.then, e.else, e.span, tail)
        return
      case 'binop':
        this.compileBinop(c, e)
        return
      case 'unop':
        this.compileExpr(c, e.operand)
        c.op(e.op === '-' ? Op.NEG : Op.NOT, e.span, 0)
        return
      case 'list': {
        for (const el of e.elements) this.compileExpr(c, el)
        c.op(Op.MAKE_LIST, e.span, 1 - e.elements.length, e.elements.length)
        return
      }
      case 'tuple': {
        for (const el of e.elements) this.compileExpr(c, el)
        c.op(Op.MAKE_TUPLE, e.span, 1 - e.elements.length, e.elements.length)
        return
      }
      case 'seq':
        this.compileExpr(c, e.first)
        c.op(Op.POP, e.first.span, -1)
        this.compileExpr(c, e.rest, tail)
        return
      case 'match':
        this.compileMatch(c, e, tail)
        return
      case 'typedecl':
        this.compileTypeDecl(c, e, tail)
        return
    }
  }

  private compileTypeDecl(c: FnCompiler, e: Extract<Expr, { kind: 'typedecl' }>, tail: boolean): void {
    // each constructor becomes a constant value bound as a local in the body's scope
    for (const ctor of e.ctors) {
      const v: Value =
        ctor.args.length === 0
          ? { tag: 'data', name: ctor.name, args: [] }
          : { tag: 'ctor', name: ctor.name, arity: ctor.args.length, args: [] }
      c.op(Op.CONST, e.span, +1, c.constant(v))
      c.declareLocal(ctor.name)
    }
    this.compileExpr(c, e.body, tail)
    if (e.ctors.length > 0) c.op(Op.POP_BELOW, e.span, -e.ctors.length, e.ctors.length)
    for (let k = 0; k < e.ctors.length; k++) c.locals.pop()
  }

  private compileMatch(c: FnCompiler, e: Extract<Expr, { kind: 'match' }>, tail: boolean): void {
    this.compileExpr(c, e.scrutinee)
    const sslot = c.declareLocal('$match')
    const baseHeight = c.height // scrutinee local only
    const endJumps: number[] = []

    for (const cs of e.cases) {
      const tests: PatTest[] = []
      const binds: PatBind[] = []
      analyzePattern(cs.pattern, [], tests, binds)
      const span = cs.pattern.span

      // tests — each fails to the next case
      const failJumps: number[] = []
      for (const t of tests) {
        this.navigate(c, sslot, t.path, span)
        if (t.kind === 'lit') {
          c.op(Op.CONST, span, +1, c.constant(t.value))
          c.op(Op.EQ, span, -1)
        } else if (t.kind === 'nil') {
          c.op(Op.IS_NIL, span, 0)
        } else if (t.kind === 'cons') {
          c.op(Op.IS_CONS, span, 0)
        } else {
          // constructor tag test: compare the value's tag name to the expected
          c.op(Op.CTOR_TAG, span, 0)
          c.op(Op.CONST, span, +1, c.constant(vstr(t.name)))
          c.op(Op.EQ, span, -1)
        }
        failJumps.push(c.here())
        c.op(Op.JUMP_IF_FALSE, span, -1, 0)
      }

      // bindings — extract each variable as a local
      for (const b of binds) {
        this.navigate(c, sslot, b.path, span)
        c.declareLocal(b.name)
      }

      this.compileExpr(c, cs.body, tail)
      if (binds.length > 0) c.op(Op.POP_BELOW, span, -binds.length, binds.length)
      for (let k = 0; k < binds.length; k++) c.locals.pop()

      endJumps.push(c.here())
      c.op(Op.JUMP, span, 0, 0)

      for (const j of failJumps) this.patch(c, j)
      c.height = baseHeight // fall-through arrives with only the scrutinee live
    }

    c.op(Op.MATCH_FAIL, e.span, 0)
    for (const j of endJumps) this.patch(c, j)
    c.height = baseHeight + 1 // a matched case left: scrutinee, result
    c.op(Op.POP_BELOW, e.span, -1, 1) // drop the scrutinee beneath the result
    c.locals.pop()
  }

  private navigate(c: FnCompiler, sslot: number, path: PatStep[], span: Span): void {
    c.op(Op.GET_LOCAL, span, +1, sslot)
    for (const step of path) {
      if (step === 'head') c.op(Op.HEAD, span, 0)
      else if (step === 'tail') c.op(Op.TAIL, span, 0)
      else if ('tuple' in step) c.op(Op.TUPLE_GET, span, 0, step.tuple)
      else c.op(Op.CTOR_GET, span, 0, step.ctor)
    }
  }

  private compileVar(c: FnCompiler, e: Extract<Expr, { kind: 'var' }>): void {
    const local = c.resolveLocal(e.name)
    if (local >= 0) {
      c.op(Op.GET_LOCAL, e.span, +1, local)
      return
    }
    const up = c.resolveUpvalue(e.name)
    if (up >= 0) {
      c.op(Op.GET_UPVAL, e.span, +1, up)
      return
    }
    const g = GLOBAL_INDEX.get(e.name)
    if (g !== undefined) {
      c.op(Op.GET_GLOBAL, e.span, +1, g)
      return
    }
    throw new CompileError(`unbound variable: ${e.name}`, e.span)
  }

  private compileLambda(c: FnCompiler, e: Extract<Expr, { kind: 'lambda' }>, name: string): void {
    const child = new FnCompiler(name, 1, c)
    child.declareLocal(e.param)
    this.compileExpr(child, e.body, true) // a lambda body is in tail position
    child.op(Op.RETURN, e.body.span, 0)
    const idx = c.proto.childProtos.length
    c.proto.childProtos.push(child.proto)
    c.op(Op.CLOSURE, e.span, +1, idx)
  }

  private compileLet(c: FnCompiler, e: Extract<Expr, { kind: 'let' }>, tail: boolean): void {
    if (e.recursive) {
      // reserve the slot with a placeholder so the closure can capture itself
      c.op(Op.UNIT, e.span, +1)
      const slot = c.declareLocal(e.name)
      if (e.value.kind === 'lambda') {
        this.compileLambda(c, e.value, e.name)
      } else {
        this.compileExpr(c, e.value)
      }
      c.op(Op.SET_LOCAL, e.span, -1, slot)
    } else {
      this.compileExpr(c, e.value)
      c.declareLocal(e.name)
    }
    this.compileExpr(c, e.body, tail)
    // close the binding's scope: drop the local slot beneath the result
    c.op(Op.POP_BELOW, e.span, -1, 1)
    c.locals.pop()
  }

  private compileIf(
    c: FnCompiler,
    cond: Expr,
    thenE: Expr,
    elseE: Expr,
    span: Span,
    tail = false,
  ): void {
    this.compileExpr(c, cond)
    const jifAt = c.here()
    c.op(Op.JUMP_IF_FALSE, span, -1, 0) // operand patched below
    const heightAfterCond = c.height
    this.compileExpr(c, thenE, tail)
    const jmpAt = c.here()
    c.op(Op.JUMP, span, 0, 0)
    // patch JUMP_IF_FALSE to land here (start of else)
    this.patch(c, jifAt)
    // both branches produce one value at the same height
    c.height = heightAfterCond
    this.compileExpr(c, elseE, tail)
    this.patch(c, jmpAt)
  }

  // patch a jump whose operand slot is at code[at+1] to jump to current end
  private patch(c: FnCompiler, at: number): void {
    const operandIndex = at + 1
    const target = c.proto.code.length
    const fromAfterOperand = operandIndex + 1
    c.proto.code[operandIndex] = target - fromAfterOperand
  }

  private compileBinop(c: FnCompiler, e: Extract<Expr, { kind: 'binop' }>): void {
    // short-circuit boolean operators desugar to control flow
    if (e.op === '&&') {
      this.compileIf(c, e.left, e.right, { kind: 'bool', value: false, span: e.span }, e.span)
      return
    }
    if (e.op === '||') {
      this.compileIf(c, e.left, { kind: 'bool', value: true, span: e.span }, e.right, e.span)
      return
    }
    this.compileExpr(c, e.left)
    this.compileExpr(c, e.right)
    const op = BINOP_OPCODE[e.op]
    c.op(op, e.span, -1)
  }
}

const BINOP_OPCODE: Record<Exclude<BinaryOp, '&&' | '||'>, number> = {
  '+': Op.ADD,
  '-': Op.SUB,
  '*': Op.MUL,
  '/': Op.DIV,
  '+.': Op.FADD,
  '-.': Op.FSUB,
  '*.': Op.FMUL,
  '/.': Op.FDIV,
  '==': Op.EQ,
  '!=': Op.NEQ,
  '<': Op.LT,
  '>': Op.GT,
  '<=': Op.LE,
  '>=': Op.GE,
  '::': Op.CONS,
  '^': Op.CONCAT_STR,
  '++': Op.CONCAT_LIST,
}

// A navigation step from the scrutinee value to a sub-value.
type PatStep = 'head' | 'tail' | { tuple: number } | { ctor: number }

type PatTest =
  | { path: PatStep[]; kind: 'lit'; value: Value }
  | { path: PatStep[]; kind: 'nil' }
  | { path: PatStep[]; kind: 'cons' }
  | { path: PatStep[]; kind: 'ctor'; name: string }

interface PatBind {
  path: PatStep[]
  name: string
}

// Flatten a pattern into the runtime tests it implies (outer constructors first)
// and the variables it binds, each with an access path from the scrutinee.
function analyzePattern(pat: Pattern, path: PatStep[], tests: PatTest[], binds: PatBind[]): void {
  switch (pat.kind) {
    case 'pwild':
    case 'punit':
      return
    case 'pvar':
      binds.push({ path, name: pat.name })
      return
    case 'pint':
      tests.push({ path, kind: 'lit', value: vint(pat.value) })
      return
    case 'pfloat':
      tests.push({ path, kind: 'lit', value: vfloat(pat.value) })
      return
    case 'pbool':
      tests.push({ path, kind: 'lit', value: vbool(pat.value) })
      return
    case 'pstr':
      tests.push({ path, kind: 'lit', value: vstr(pat.value) })
      return
    case 'pnil':
      tests.push({ path, kind: 'nil' })
      return
    case 'pcons':
      tests.push({ path, kind: 'cons' })
      analyzePattern(pat.head, [...path, 'head'], tests, binds)
      analyzePattern(pat.tail, [...path, 'tail'], tests, binds)
      return
    case 'ptuple':
      pat.elements.forEach((p, i) => analyzePattern(p, [...path, { tuple: i }], tests, binds))
      return
    case 'pcon':
      tests.push({ path, kind: 'ctor', name: pat.name })
      pat.args.forEach((p, i) => analyzePattern(p, [...path, { ctor: i }], tests, binds))
      return
  }
}

export function compile(program: Expr): FnProto {
  return new Compiler().compileProgram(program)
}
