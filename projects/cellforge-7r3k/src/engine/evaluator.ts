// A tree-walking evaluator. It owns the operator semantics (numeric coercion,
// `#DIV/0!`, string comparison rules, error propagation) and delegates named
// functions to the registry in functions.ts. Ranges evaluate to matrices; the
// helpers below are what functions use to flatten, coerce, and matrixify args.

import type { Node, BinaryOp } from './ast'
import type { Coord } from './address'
import { boxOf } from './address'
import type { RuntimeValue, Scalar, ErrorValue, MatrixValue } from './values'
import { err, isError, isMatrix, isSparkline, matrix, asScalar, toNumber, toText } from './values'
import { FUNCTIONS } from './functions'

/** A defined name's resolved definition: its parsed formula and the sheet that
 *  unqualified references inside it bind to. */
export interface NameBinding {
  readonly ast: Node
  readonly scopeSheet: string
}

export interface EvalContext {
  readonly rows: number
  readonly cols: number
  /** The cell being evaluated, for context-aware functions like ROW()/COLUMN(). */
  readonly current?: Coord
  /** Sheet id of the formula being evaluated — the home for unqualified references. */
  readonly currentSheet: string
  /** Current scalar value of a cell on a specific sheet, or BLANK if empty. */
  getCellAt(sheetId: string, coord: Coord): Scalar
  /** Map a sheet name (case-insensitive) to its id, or null when no such sheet exists. */
  resolveSheetId(name: string): string | null
  /** Resolve a defined name (upper-cased) to its binding, or null. */
  resolveName?(name: string): NameBinding | null
  /** Names currently being expanded — guards against self-referential definitions. */
  readonly nameStack?: ReadonlySet<string>
}

export interface FnHelpers {
  readonly ctx: EvalContext
  eval(node: Node): RuntimeValue
  scalarOf(node: Node): Scalar
  flatten(nodes: Node[]): Scalar[]
  asMatrix(node: Node): MatrixValue | ErrorValue
}

export type FnImpl = (args: Node[], h: FnHelpers) => RuntimeValue

const inBounds = (c: Coord, ctx: EvalContext): boolean =>
  c.row >= 0 && c.col >= 0 && c.row < ctx.rows && c.col < ctx.cols

export function evaluate(node: Node, ctx: EvalContext): RuntimeValue {
  const helpers = makeHelpers(ctx)
  return helpers.eval(node)
}

function makeHelpers(ctx: EvalContext): FnHelpers {
  const ev = (node: Node): RuntimeValue => evalNode(node, ctx, helpers)
  const helpers: FnHelpers = {
    ctx,
    eval: ev,
    scalarOf: (node) => asScalar(ev(node)),
    flatten(nodes) {
      const out: Scalar[] = []
      for (const n of nodes) {
        const v = ev(n)
        if (isMatrix(v)) {
          for (const row of v.data) for (const cell of row) out.push(cell)
        } else if (isSparkline(v)) {
          out.push(err('#VALUE!'))
        } else {
          out.push(v)
        }
      }
      return out
    },
    asMatrix(node) {
      const v = ev(node)
      if (isMatrix(v)) return v
      if (isSparkline(v)) return err('#VALUE!')
      if (isError(v)) return v
      return matrix([[v]])
    },
  }
  return helpers
}

function evalNode(node: Node, ctx: EvalContext, h: FnHelpers): RuntimeValue {
  switch (node.type) {
    case 'num':
      return node.value
    case 'str':
      return node.value
    case 'bool':
      return node.value
    case 'error':
      return err(node.code)

    case 'ref': {
      const sheetId = node.ref.sheet ? ctx.resolveSheetId(node.ref.sheet) : ctx.currentSheet
      if (sheetId === null) return err('#REF!', `unknown sheet "${node.ref.sheet}"`)
      const coord: Coord = { row: node.ref.row, col: node.ref.col }
      if (!inBounds(coord, ctx)) return err('#REF!', 'reference outside the sheet')
      return ctx.getCellAt(sheetId, coord)
    }

    case 'range': {
      const sheetId = node.from.sheet ? ctx.resolveSheetId(node.from.sheet) : ctx.currentSheet
      if (sheetId === null) return err('#REF!', `unknown sheet "${node.from.sheet}"`)
      const from: Coord = { row: node.from.row, col: node.from.col }
      const to: Coord = { row: node.to.row, col: node.to.col }
      if (!inBounds(from, ctx) || !inBounds(to, ctx)) return err('#REF!', 'range outside the sheet')
      const box = boxOf(from, to)
      const data: Scalar[][] = []
      for (let r = box.top; r <= box.bottom; r++) {
        const row: Scalar[] = []
        for (let c = box.left; c <= box.right; c++) row.push(ctx.getCellAt(sheetId, { row: r, col: c }))
        data.push(row)
      }
      return matrix(data)
    }

    case 'name': {
      const binding = ctx.resolveName?.(node.name.toUpperCase())
      if (!binding) return err('#NAME?', `unknown name "${node.name}"`)
      const key = node.name.toUpperCase()
      if (ctx.nameStack?.has(key)) return err('#CIRC!', `name "${node.name}" refers to itself`)
      const sub: EvalContext = {
        ...ctx,
        currentSheet: binding.scopeSheet,
        nameStack: new Set([...(ctx.nameStack ?? []), key]),
      }
      return evaluate(binding.ast, sub)
    }

    case 'unary': {
      const n = toNumber(asScalar(h.eval(node.operand)))
      if (isError(n)) return n
      return node.op === '-' ? -n : n
    }

    case 'percent': {
      const n = toNumber(asScalar(h.eval(node.operand)))
      if (isError(n)) return n
      return n / 100
    }

    case 'binary':
      return evalBinary(node.op, node.left, node.right, h)

    case 'call': {
      const impl = FUNCTIONS[node.name]
      if (!impl) return err('#NAME?', `unknown function ${node.name}`)
      return impl(node.args, h)
    }
  }
}

function evalBinary(op: BinaryOp, leftNode: Node, rightNode: Node, h: FnHelpers): RuntimeValue {
  const l = asScalar(h.eval(leftNode))
  const r = asScalar(h.eval(rightNode))
  if (isError(l)) return l
  if (isError(r)) return r

  if (op === '&') {
    const a = toText(l)
    if (isError(a)) return a
    const b = toText(r)
    if (isError(b)) return b
    return a + b
  }

  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    const cmp = compare(l, r)
    if (isError(cmp)) return cmp
    switch (op) {
      case '=':
        return cmp === 0
      case '<>':
        return cmp !== 0
      case '<':
        return cmp < 0
      case '>':
        return cmp > 0
      case '<=':
        return cmp <= 0
      case '>=':
        return cmp >= 0
    }
  }

  // Arithmetic.
  const a = toNumber(l)
  if (isError(a)) return a
  const b = toNumber(r)
  if (isError(b)) return b
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return b === 0 ? err('#DIV/0!') : a / b
    case '^': {
      const p = Math.pow(a, b)
      return Number.isFinite(p) || p === Infinity || p === -Infinity ? p : err('#NUM!')
    }
  }
  return err('#VALUE!')
}

const typeRank = (v: Scalar): number => {
  if (typeof v === 'number') return 0
  if (typeof v === 'string') return 1
  if (typeof v === 'boolean') return v ? 4 : 3
  return 0 // blank behaves like the number 0
}

/** Spreadsheet comparison: numbers numerically, text case-insensitively, then by type rank. */
function compare(l: Scalar, r: Scalar): number | ErrorValue {
  const blankL = typeof l === 'object' && (l as { kind?: string }).kind === 'blank'
  const blankR = typeof r === 'object' && (r as { kind?: string }).kind === 'blank'
  const a: Scalar = blankL ? 0 : l
  const b: Scalar = blankR ? 0 : r

  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b)
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1
  return Math.sign(typeRank(a) - typeRank(b))
}
