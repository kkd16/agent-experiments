// Aether — bytecode compiler
//
// Lowers the AST to stack-machine bytecode. Each lambda becomes its own
// `FnProto`; free variables of a lambda are captured as clox-style upvalues
// (by reference, so recursion and shared closures work). `let` is compiled with
// a real local slot that is closed and slid off the stack when its scope ends;
// `let rec` reserves the slot first so the closure can capture itself.

import type { BinaryOp, Expr } from './ast.ts'
import type { Span } from './lexer.ts'
import type { FnProto, UpvalueDesc } from './bytecode.ts'
import { Op } from './bytecode.ts'
import { GLOBAL_INDEX } from './prelude.ts'
import type { Value } from './values.ts'
import { vfloat, vint, vstr } from './values.ts'

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
    this.compileExpr(main, program)
    main.op(Op.RETURN, program.span, 0)
    return main.proto
  }

  private compileExpr(c: FnCompiler, e: Expr): void {
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
        c.op(Op.CALL, e.span, -1, 1)
        return
      case 'let':
        this.compileLet(c, e)
        return
      case 'if':
        this.compileIf(c, e.cond, e.then, e.else, e.span)
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
        this.compileExpr(c, e.rest)
        return
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
    this.compileExpr(child, e.body)
    child.op(Op.RETURN, e.body.span, 0)
    const idx = c.proto.childProtos.length
    c.proto.childProtos.push(child.proto)
    c.op(Op.CLOSURE, e.span, +1, idx)
  }

  private compileLet(c: FnCompiler, e: Extract<Expr, { kind: 'let' }>): void {
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
    this.compileExpr(c, e.body)
    // close the binding's scope: drop the local slot beneath the result
    c.op(Op.POP_BELOW, e.span, -1, 1)
    c.locals.pop()
  }

  private compileIf(c: FnCompiler, cond: Expr, thenE: Expr, elseE: Expr, span: Span): void {
    this.compileExpr(c, cond)
    const jifAt = c.here()
    c.op(Op.JUMP_IF_FALSE, span, -1, 0) // operand patched below
    const heightAfterCond = c.height
    this.compileExpr(c, thenE)
    const jmpAt = c.here()
    c.op(Op.JUMP, span, 0, 0)
    // patch JUMP_IF_FALSE to land here (start of else)
    this.patch(c, jifAt)
    // both branches produce one value at the same height
    c.height = heightAfterCond
    this.compileExpr(c, elseE)
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

export function compile(program: Expr): FnProto {
  return new Compiler().compileProgram(program)
}
