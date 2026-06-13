// Aether — stack virtual machine
//
// Executes the compiled bytecode. Iterative (its own explicit frame stack), so
// recursion depth is bounded by memory rather than the JS call stack. Closures
// capture variables through clox-style upvalues that start "open" (pointing at a
// live stack slot) and are "closed" (copied out) when the slot is reclaimed.
// `execute` can record a per-instruction snapshot trace to drive the
// time-travel debugger.

import type { FnProto } from './bytecode.ts'
import { Op } from './bytecode.ts'
import type { Span } from './lexer.ts'
import type { NativeCtx, TurtleCmd, Value } from './values.ts'
import {
  AetherRuntimeError,
  FALSE,
  NIL,
  TRUE,
  UNIT,
  Upvalue,
  compareValues,
  listFromArray,
  listToArray,
  vfloat,
  vint,
  vstr,
} from './values.ts'

interface Frame {
  closure: Extract<Value, { tag: 'closure' }>
  ip: number
  base: number
}

export interface FrameView {
  name: string
  ip: number
  base: number
}

export interface Snapshot {
  step: number
  protoName: string
  ip: number
  opName: string
  span: Span | null
  stack: Value[]
  frames: FrameView[]
  outputLen: number
  effectsLen: number
}

export interface RunResult {
  result: Value | null
  output: string[]
  effects: TurtleCmd[]
  snapshots: Snapshot[] | null
  steps: number
  error: string | null
  errorSpan: Span | null
}

const DEFAULT_MAX_STEPS = 5_000_000

export class VM {
  private stack: Value[] = []
  private frames: Frame[] = []
  private openUpvalues: Upvalue[] = []
  private globals: Value[]
  private output: string[] = []
  private effects: TurtleCmd[] = []
  private ctx: NativeCtx

  constructor(main: FnProto, globals: Value[]) {
    this.globals = globals
    const mainClosure: Extract<Value, { tag: 'closure' }> = {
      tag: 'closure',
      proto: main,
      upvalues: [],
    }
    this.stack.push(mainClosure)
    this.frames.push({ closure: mainClosure, ip: 0, base: 1 })
    this.ctx = {
      print: (s) => this.output.push(s),
      emit: (cmd) => this.effects.push(cmd),
    }
  }

  execute(record: boolean, maxSteps = DEFAULT_MAX_STEPS): RunResult {
    const snapshots: Snapshot[] | null = record ? [] : null
    let steps = 0
    let result: Value | null = null
    let error: string | null = null
    const errorSpan: Span | null = null
    const recordCap = 60_000

    try {
      for (;;) {
        if (this.frames.length === 0) {
          result = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null
          break
        }
        if (steps >= maxSteps) {
          throw new AetherRuntimeError(
            `step limit reached (${maxSteps.toLocaleString()}) — possible infinite loop`,
          )
        }
        if (snapshots && snapshots.length < recordCap) {
          snapshots.push(this.snapshot(steps))
        }
        this.step()
        steps++
      }
    } catch (err) {
      if (err instanceof AetherRuntimeError) {
        error = err.message
      } else if (err instanceof RangeError) {
        error = 'stack overflow'
      } else {
        throw err
      }
    }

    return { result, output: this.output, effects: this.effects, snapshots, steps, error, errorSpan }
  }

  private snapshot(step: number): Snapshot {
    const frame = this.frames[this.frames.length - 1]
    const code = frame.closure.proto.code
    const op = code[frame.ip]
    return {
      step,
      protoName: frame.closure.proto.name,
      ip: frame.ip,
      opName: opName(op),
      span: frame.closure.proto.spans[frame.ip] ?? null,
      stack: this.stack.slice(),
      frames: this.frames.map((f) => ({ name: f.closure.proto.name, ip: f.ip, base: f.base })),
      outputLen: this.output.length,
      effectsLen: this.effects.length,
    }
  }

  private captureUpvalue(location: number): Upvalue {
    for (const uv of this.openUpvalues) {
      if (uv.location === location) return uv
    }
    const uv = new Upvalue(location)
    this.openUpvalues.push(uv)
    return uv
  }

  private closeUpvalues(from: number): void {
    for (const uv of this.openUpvalues) {
      if (uv.location !== null && uv.location >= from) {
        uv.closed = this.stack[uv.location]
        uv.location = null
      }
    }
    this.openUpvalues = this.openUpvalues.filter((uv) => uv.location !== null)
  }

  private step(): void {
    const frame = this.frames[this.frames.length - 1]
    const code = frame.closure.proto.code
    const proto = frame.closure.proto
    const op = code[frame.ip++]
    const stack = this.stack

    switch (op) {
      case Op.CONST:
        stack.push(proto.constants[code[frame.ip++]])
        return
      case Op.TRUE:
        stack.push(TRUE)
        return
      case Op.FALSE:
        stack.push(FALSE)
        return
      case Op.UNIT:
        stack.push(UNIT)
        return
      case Op.NIL:
        stack.push(NIL)
        return
      case Op.GET_LOCAL:
        stack.push(stack[frame.base + code[frame.ip++]])
        return
      case Op.SET_LOCAL: {
        const slot = code[frame.ip++]
        stack[frame.base + slot] = stack.pop() as Value
        return
      }
      case Op.GET_UPVAL: {
        const uv = frame.closure.upvalues[code[frame.ip++]]
        stack.push(uv.location !== null ? stack[uv.location] : uv.closed)
        return
      }
      case Op.GET_GLOBAL:
        stack.push(this.globals[code[frame.ip++]])
        return
      case Op.POP:
        stack.pop()
        return
      case Op.POP_BELOW: {
        const n = code[frame.ip++]
        const top = stack.pop() as Value
        const start = stack.length - n
        this.closeUpvalues(start)
        stack.length = start
        stack.push(top)
        return
      }
      case Op.JUMP:
        frame.ip += code[frame.ip] + 1
        return
      case Op.JUMP_IF_FALSE: {
        const rel = code[frame.ip++]
        const cond = stack.pop() as Value
        if (cond.tag === 'bool' && !cond.b) frame.ip += rel
        return
      }
      case Op.CALL:
        this.doCall(code[frame.ip++])
        return
      case Op.TAILCALL:
        this.doTailCall(frame, code[frame.ip++])
        return
      case Op.CLOSURE:
        this.doClosure(frame, code[frame.ip++])
        return
      case Op.RETURN:
        this.doReturn(frame)
        return
      case Op.ADD:
        return this.intBin((a, b) => vint(a + b))
      case Op.SUB:
        return this.intBin((a, b) => vint(a - b))
      case Op.MUL:
        return this.intBin((a, b) => vint(a * b))
      case Op.DIV:
        return this.intBin((a, b) => {
          if (b === 0) throw new AetherRuntimeError('division by zero')
          return vint(Math.trunc(a / b))
        })
      case Op.NEG: {
        const v = stack.pop() as Value
        stack.push(vint(-(v as { n: number }).n))
        return
      }
      case Op.FADD:
        return this.floatBin((a, b) => vfloat(a + b))
      case Op.FSUB:
        return this.floatBin((a, b) => vfloat(a - b))
      case Op.FMUL:
        return this.floatBin((a, b) => vfloat(a * b))
      case Op.FDIV:
        return this.floatBin((a, b) => vfloat(a / b))
      case Op.EQ:
        return this.cmp((c) => c === 0)
      case Op.NEQ:
        return this.cmp((c) => c !== 0)
      case Op.LT:
        return this.cmp((c) => c < 0)
      case Op.GT:
        return this.cmp((c) => c > 0)
      case Op.LE:
        return this.cmp((c) => c <= 0)
      case Op.GE:
        return this.cmp((c) => c >= 0)
      case Op.NOT: {
        const v = stack.pop() as Value
        stack.push(v.tag === 'bool' && v.b ? FALSE : TRUE)
        return
      }
      case Op.CONS: {
        const tail = stack.pop() as Value
        const head = stack.pop() as Value
        stack.push({ tag: 'cons', head, tail })
        return
      }
      case Op.CONCAT_STR: {
        const b = stack.pop() as Value
        const a = stack.pop() as Value
        stack.push(vstr((a as { s: string }).s + (b as { s: string }).s))
        return
      }
      case Op.CONCAT_LIST: {
        const b = stack.pop() as Value
        const a = stack.pop() as Value
        stack.push(listFromArray([...listToArray(a), ...listToArray(b)]))
        return
      }
      case Op.MAKE_LIST: {
        const n = code[frame.ip++]
        const items = stack.splice(stack.length - n, n)
        stack.push(listFromArray(items))
        return
      }
      case Op.MAKE_TUPLE: {
        const n = code[frame.ip++]
        const items = stack.splice(stack.length - n, n)
        stack.push({ tag: 'tuple', items })
        return
      }
      case Op.IS_NIL: {
        const v = stack.pop() as Value
        stack.push(v.tag === 'nil' ? TRUE : FALSE)
        return
      }
      case Op.IS_CONS: {
        const v = stack.pop() as Value
        stack.push(v.tag === 'cons' ? TRUE : FALSE)
        return
      }
      case Op.HEAD: {
        const v = stack.pop() as Value
        if (v.tag !== 'cons') throw new AetherRuntimeError('head of non-cons in match')
        stack.push(v.head)
        return
      }
      case Op.TAIL: {
        const v = stack.pop() as Value
        if (v.tag !== 'cons') throw new AetherRuntimeError('tail of non-cons in match')
        stack.push(v.tail)
        return
      }
      case Op.TUPLE_GET: {
        const k = code[frame.ip++]
        const v = stack.pop() as Value
        if (v.tag !== 'tuple') throw new AetherRuntimeError('tuple access on non-tuple')
        stack.push(v.items[k])
        return
      }
      case Op.MATCH_FAIL:
        throw new AetherRuntimeError('match: no pattern matched the value')
      case Op.CTOR_TAG: {
        const v = stack.pop() as Value
        if (v.tag !== 'data') throw new AetherRuntimeError('constructor tag of non-data value')
        stack.push(vstr(v.name))
        return
      }
      case Op.CTOR_GET: {
        const k = code[frame.ip++]
        const v = stack.pop() as Value
        if (v.tag !== 'data') throw new AetherRuntimeError('field access on non-data value')
        stack.push(v.args[k])
        return
      }
      case Op.MAKE_RECORD: {
        const n = code[frame.ip++]
        const slice = stack.splice(stack.length - 2 * n, 2 * n)
        const fields: Record<string, Value> = {}
        for (let i = 0; i < slice.length; i += 2) {
          fields[(slice[i] as { s: string }).s] = slice[i + 1]
        }
        stack.push({ tag: 'record', fields })
        return
      }
      case Op.FIELD_GET: {
        const label = (proto.constants[code[frame.ip++]] as { s: string }).s
        const rec = stack.pop() as Value
        if (rec.tag !== 'record') throw new AetherRuntimeError('field access on non-record')
        stack.push(rec.fields[label])
        return
      }
      default:
        throw new AetherRuntimeError(`bad opcode ${op}`)
    }
  }

  private doCall(argc: number): void {
    const stack = this.stack
    const fnIndex = stack.length - argc - 1
    const callee = stack[fnIndex]
    if (callee.tag === 'closure') {
      this.frames.push({ closure: callee, ip: 0, base: fnIndex + 1 })
      return
    }
    if (callee.tag === 'native') {
      const arg = stack[fnIndex + 1]
      const applied = [...callee.applied, arg]
      stack.length = fnIndex
      if (applied.length === callee.arity) {
        stack.push(callee.fn(applied, this.ctx))
      } else {
        stack.push({ tag: 'native', name: callee.name, arity: callee.arity, applied, fn: callee.fn })
      }
      return
    }
    if (callee.tag === 'ctor') {
      const arg = stack[fnIndex + 1]
      const args = [...callee.args, arg]
      stack.length = fnIndex
      if (args.length === callee.arity) {
        stack.push({ tag: 'data', name: callee.name, args })
      } else {
        stack.push({ tag: 'ctor', name: callee.name, arity: callee.arity, args })
      }
      return
    }
    throw new AetherRuntimeError(`cannot call a ${callee.tag}`)
  }

  // Tail call: if the callee is a closure, reuse the current frame instead of
  // pushing a new one, giving constant-space tail recursion. Native callees
  // fall back to a normal call (the following RETURN cleans up).
  private doTailCall(frame: Frame, argc: number): void {
    const stack = this.stack
    const fnIndex = stack.length - argc - 1
    const callee = stack[fnIndex]
    if (callee.tag !== 'closure') {
      this.doCall(argc)
      return
    }
    this.closeUpvalues(frame.base)
    // slide [callee, args] down so the callee sits where the current fn was
    const window = stack.slice(fnIndex)
    stack.length = frame.base - 1
    for (const v of window) stack.push(v)
    // base is unchanged: the callee now sits at base-1, its arg at base (slot 0)
    frame.closure = callee
    frame.ip = 0
  }

  private doClosure(frame: Frame, protoIdx: number): void {
    const child = frame.closure.proto.childProtos[protoIdx]
    const upvalues: Upvalue[] = []
    for (const desc of child.upvalues) {
      if (desc.fromLocal) {
        upvalues.push(this.captureUpvalue(frame.base + desc.index))
      } else {
        upvalues.push(frame.closure.upvalues[desc.index])
      }
    }
    this.stack.push({ tag: 'closure', proto: child, upvalues })
  }

  private doReturn(frame: Frame): void {
    const result = this.stack.pop() as Value
    this.closeUpvalues(frame.base)
    this.stack.length = frame.base - 1
    this.stack.push(result)
    this.frames.pop()
  }

  private intBin(f: (a: number, b: number) => Value): void {
    const b = this.stack.pop() as Value
    const a = this.stack.pop() as Value
    this.stack.push(f((a as { n: number }).n, (b as { n: number }).n))
  }

  private floatBin(f: (a: number, b: number) => Value): void {
    const b = this.stack.pop() as Value
    const a = this.stack.pop() as Value
    this.stack.push(f((a as { n: number }).n, (b as { n: number }).n))
  }

  private cmp(pred: (c: number) => boolean): void {
    const b = this.stack.pop() as Value
    const a = this.stack.pop() as Value
    this.stack.push(pred(compareValues(a, b)) ? TRUE : FALSE)
  }
}

function opName(op: number): string {
  for (const [k, v] of Object.entries(Op)) if (v === op) return k
  return `?${op}`
}
