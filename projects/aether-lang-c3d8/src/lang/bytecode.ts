// Aether — bytecode definitions
//
// The compiler lowers the typed AST to bytecode for a small stack machine.
// Opcodes are plain numbers (no TS `enum`, to satisfy this repo's
// erasable-syntax rule). Each function compiles to its own `FnProto`; nested
// functions become child protos closed over via clox-style upvalues.

import type { Value } from './values.ts'
import type { Span } from './lexer.ts'

export const Op = {
  CONST: 0, // <const-index>  push a literal constant
  TRUE: 1,
  FALSE: 2,
  UNIT: 3,
  NIL: 4,
  GET_LOCAL: 5, // <slot>     push a local variable
  GET_UPVAL: 6, // <index>    push a captured variable
  GET_GLOBAL: 7, // <index>   push a primitive/global
  POP: 8,
  JUMP: 9, // <rel>           unconditional relative jump
  JUMP_IF_FALSE: 10, // <rel> pop, jump if false
  CALL: 11, // <argc>         call the function under argc args
  CLOSURE: 12, // <proto-idx> build a closure from a child proto
  RETURN: 13,
  ADD: 14,
  SUB: 15,
  MUL: 16,
  DIV: 17,
  NEG: 18,
  FADD: 19,
  FSUB: 20,
  FMUL: 21,
  FDIV: 22,
  EQ: 23,
  NEQ: 24,
  LT: 25,
  GT: 26,
  LE: 27,
  GE: 28,
  NOT: 29,
  CONS: 30,
  CONCAT_STR: 31,
  CONCAT_LIST: 32,
  MAKE_LIST: 33, // <n>
  MAKE_TUPLE: 34, // <n>
  SET_LOCAL: 35, // <slot>  pop and store into an existing local (for let rec)
  POP_BELOW: 36, // <n>      drop n slots beneath the top (end of a let scope)
  IS_NIL: 37, //             pop a list, push whether it is []
  IS_CONS: 38, //            pop a list, push whether it is a cons cell
  HEAD: 39, //               pop a cons, push its head
  TAIL: 40, //               pop a cons, push its tail
  TUPLE_GET: 41, // <k>      pop a tuple, push element k
  MATCH_FAIL: 42, //         raise: no pattern matched
  TAILCALL: 43, // <argc>    call in tail position, reusing the current frame
  CTOR_TAG: 44, //           pop a data value, push its constructor name (String)
  CTOR_GET: 45, // <k>       pop a data value, push its kth field
  MAKE_RECORD: 46, // <n>    pop n (label, value) pairs, push a record
  FIELD_GET: 47, // <ci>     pop a record, push field named constants[ci]
} as const

export type Op = (typeof Op)[keyof typeof Op]

export const OP_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(Op).map(([k, v]) => [v, k]),
)

// How many inline operand words follow each opcode.
const ONE_OPERAND = new Set<number>([
  Op.CONST,
  Op.GET_LOCAL,
  Op.GET_UPVAL,
  Op.GET_GLOBAL,
  Op.JUMP,
  Op.JUMP_IF_FALSE,
  Op.CALL,
  Op.CLOSURE,
  Op.MAKE_LIST,
  Op.MAKE_TUPLE,
  Op.SET_LOCAL,
  Op.POP_BELOW,
  Op.TUPLE_GET,
  Op.TAILCALL,
  Op.CTOR_GET,
  Op.MAKE_RECORD,
  Op.FIELD_GET,
])

export function operandCount(op: number): number {
  return ONE_OPERAND.has(op) ? 1 : 0
}

export interface UpvalueDesc {
  /** capture from the enclosing function's locals (true) or its upvalues (false) */
  fromLocal: boolean
  index: number
  /** original variable name, for debugging displays */
  name: string
}

export interface FnProto {
  name: string
  numParams: number
  /** total local slots reserved (params + lets) */
  numLocals: number
  code: number[]
  constants: Value[]
  upvalues: UpvalueDesc[]
  childProtos: FnProto[]
  /** source span per emitted opcode (indexed by instruction offset) */
  spans: (Span | null)[]
}

export interface DisasmLine {
  offset: number
  op: number
  name: string
  operand: number | null
  comment: string
}

/** Disassemble a single proto's code (not recursive into children). */
export function disassemble(proto: FnProto): DisasmLine[] {
  const out: DisasmLine[] = []
  const code = proto.code
  let i = 0
  while (i < code.length) {
    const offset = i
    const op = code[i++]
    const name = OP_NAME[op] ?? `?${op}`
    let operand: number | null = null
    let comment = ''
    if (operandCount(op) === 1) {
      operand = code[i++]
      switch (op) {
        case Op.CONST:
          comment = valuePreview(proto.constants[operand])
          break
        case Op.GET_GLOBAL:
          comment = `global #${operand}`
          break
        case Op.JUMP:
        case Op.JUMP_IF_FALSE:
          comment = `-> ${i + operand}`
          break
        case Op.CLOSURE: {
          const child = proto.childProtos[operand]
          comment = child ? `${child.name} (${child.upvalues.length} upvals)` : ''
          break
        }
        case Op.CALL:
        case Op.TAILCALL:
          comment = `${operand} arg${operand === 1 ? '' : 's'}`
          break
        case Op.FIELD_GET:
          comment = `.${valuePreview(proto.constants[operand])}`
          break
        case Op.MAKE_RECORD:
          comment = `${operand} field${operand === 1 ? '' : 's'}`
          break
      }
    }
    out.push({ offset, op, name, operand, comment })
  }
  return out
}

function valuePreview(v: Value | undefined): string {
  if (!v) return ''
  switch (v.tag) {
    case 'int':
    case 'float':
      return String(v.n)
    case 'str':
      return JSON.stringify(v.s)
    case 'bool':
      return String(v.b)
    default:
      return v.tag
  }
}

/** Walk a proto and all its descendants, depth-first. */
export function allProtos(root: FnProto): FnProto[] {
  const out: FnProto[] = []
  const visit = (p: FnProto): void => {
    out.push(p)
    p.childProtos.forEach(visit)
  }
  visit(root)
  return out
}
