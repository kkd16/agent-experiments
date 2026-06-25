// A tree-walking evaluator. It owns the operator semantics (numeric coercion,
// `#DIV/0!`, string comparison rules, error propagation) and delegates named
// functions to the registry in functions.ts. Ranges evaluate to matrices; the
// helpers below are what functions use to flatten, coerce, and matrixify args.

import type { Node, BinaryOp } from './ast'
import type { Coord } from './address'
import { boxOf } from './address'
import type { RuntimeValue, Scalar, ErrorValue, MatrixValue, LambdaValue } from './values'
import { BLANK, err, isError, isMatrix, isSparkline, isLambda, matrix, asScalar, toNumber, toText } from './values'
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
  /** Resolve a spill-range reference (`A1#`): the matrix of the dynamic array
   *  anchored at `coord`, or null when that cell is not a spilling array anchor. */
  getSpillRange?(sheetId: string, coord: Coord): MatrixValue | null
  /** Map a sheet name (case-insensitive) to its id, or null when no such sheet exists. */
  resolveSheetId(name: string): string | null
  /** Resolve a defined name (upper-cased) to its binding, or null. */
  resolveName?(name: string): NameBinding | null
  /** Names currently being expanded — guards against self-referential definitions. */
  readonly nameStack?: ReadonlySet<string>
  /** Lexical bindings introduced by LET / LAMBDA parameters (upper-cased → value).
   *  Checked before defined names so a local binding shadows a workbook name. */
  readonly locals?: ReadonlyMap<string, RuntimeValue>
  /** Lambda-application nesting depth, for the recursion guard (recursive named
   *  lambdas terminate at #NUM! rather than overflowing the stack). */
  readonly depth?: number
}

export interface FnHelpers {
  readonly ctx: EvalContext
  eval(node: Node): RuntimeValue
  scalarOf(node: Node): Scalar
  flatten(nodes: Node[]): Scalar[]
  asMatrix(node: Node): MatrixValue | ErrorValue
  /** Coerce a node to a lambda value (for higher-order functions like MAP/REDUCE). */
  asLambda(node: Node): LambdaValue | ErrorValue
  /** Evaluate a node with extra lexical bindings layered on top of the current ones. */
  evalWith(node: Node, extra: ReadonlyMap<string, RuntimeValue>): RuntimeValue
  /** Apply a lambda to a list of already-evaluated argument values. */
  applyLambda(fn: LambdaValue, argVals: RuntimeValue[]): RuntimeValue
}

export type FnImpl = (args: Node[], h: FnHelpers) => RuntimeValue

const inBounds = (c: Coord, ctx: EvalContext): boolean =>
  c.row >= 0 && c.col >= 0 && c.row < ctx.rows && c.col < ctx.cols

/** Hard ceiling on recursive lambda depth — terminates runaway recursion with
 *  #NUM! instead of a stack overflow. Generous enough for any sane recursion. */
const MAX_LAMBDA_DEPTH = 600

export function evaluate(node: Node, ctx: EvalContext): RuntimeValue {
  const helpers = makeHelpers(ctx)
  return helpers.eval(node)
}

function mergeLocals(
  base: ReadonlyMap<string, RuntimeValue> | undefined,
  extra: ReadonlyMap<string, RuntimeValue>,
): Map<string, RuntimeValue> {
  const merged = new Map<string, RuntimeValue>(base ?? [])
  for (const [k, v] of extra) merged.set(k, v)
  return merged
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
        } else if (isSparkline(v) || isLambda(v)) {
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
      if (isSparkline(v) || isLambda(v)) return err('#VALUE!')
      if (isError(v)) return v
      return matrix([[v]])
    },
    asLambda(node) {
      const v = ev(node)
      if (isLambda(v)) return v
      if (isError(v)) return v
      return err('#VALUE!', 'expected a LAMBDA')
    },
    evalWith(node, extra) {
      return evaluate(node, { ...ctx, locals: mergeLocals(ctx.locals, extra) })
    },
    applyLambda(fn, argVals) {
      if (argVals.length > fn.params.length) return err('#N/A', 'too many arguments to the lambda')
      const depth = (ctx.depth ?? 0) + 1
      if (depth > MAX_LAMBDA_DEPTH) return err('#NUM!', 'lambda recursion too deep')
      const bound = new Map<string, RuntimeValue>(fn.closure)
      fn.params.forEach((p, i) => bound.set(p, i < argVals.length ? argVals[i] : BLANK))
      return evaluate(fn.body, { ...ctx, locals: bound, depth })
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

    case 'spillref': {
      const sheetId = node.ref.sheet ? ctx.resolveSheetId(node.ref.sheet) : ctx.currentSheet
      if (sheetId === null) return err('#REF!', `unknown sheet "${node.ref.sheet}"`)
      const coord: Coord = { row: node.ref.row, col: node.ref.col }
      if (!inBounds(coord, ctx)) return err('#REF!', 'reference outside the sheet')
      const region = ctx.getSpillRange?.(sheetId, coord) ?? null
      if (region) return region
      return err('#REF!', 'the # operator needs a spilled array anchor')
    }

    case 'name': {
      const key = node.name.toUpperCase()
      // A lexical binding (LET / lambda parameter) shadows everything else.
      const local = ctx.locals?.get(key)
      if (local !== undefined) return local
      const binding = ctx.resolveName?.(key)
      if (!binding) {
        // A bare builtin name (`SUM`, `AVERAGE`) is "eta-reduced" to a first-class
        // lambda, so it can be passed to GROUPBY / BYROW / MAP as a function value.
        const eta = etaReduce(key)
        if (eta) return eta
        return err('#NAME?', `unknown name "${node.name}"`)
      }
      if (ctx.nameStack?.has(key)) return err('#CIRC!', `name "${node.name}" refers to itself`)
      const sub: EvalContext = {
        ...ctx,
        currentSheet: binding.scopeSheet,
        nameStack: new Set([...(ctx.nameStack ?? []), key]),
        locals: undefined, // a workbook name is its own scope — caller locals don't leak in
      }
      return evaluate(binding.ast, sub)
    }

    case 'unary': {
      const v = h.eval(node.operand)
      const op = (s: Scalar): Scalar => {
        const n = toNumber(s)
        return isError(n) ? n : node.op === '-' ? -n : n
      }
      return isMatrix(v) ? mapMatrix(v, op) : op(asScalar(v))
    }

    case 'percent': {
      const v = h.eval(node.operand)
      const op = (s: Scalar): Scalar => {
        const n = toNumber(s)
        return isError(n) ? n : n / 100
      }
      return isMatrix(v) ? mapMatrix(v, op) : op(asScalar(v))
    }

    case 'binary':
      return evalBinary(node.op, node.left, node.right, h)

    case 'call': {
      const impl = FUNCTIONS[node.name]
      if (impl) return impl(node.args, h)
      // Not a builtin — maybe it's a user lambda bound to a LET name or a workbook
      // name, e.g. `=LET(sq, LAMBDA(x, x*x), sq(9))` or a defined name holding a LAMBDA.
      const callable = resolveCallable(node.name, ctx)
      if (isError(callable)) return callable
      if (callable && isLambda(callable)) {
        const argVals = node.args.map((a) => h.eval(a))
        return h.applyLambda(callable, argVals)
      }
      return err('#NAME?', `unknown function ${node.name}`)
    }

    case 'apply': {
      const fnVal = h.eval(node.fn)
      if (isError(fnVal)) return fnVal
      if (!isLambda(fnVal)) return err('#VALUE!', 'only a LAMBDA can be applied to arguments')
      return h.applyLambda(fnVal, node.args.map((a) => h.eval(a)))
    }
  }
}

/** Eta-reduce a bare builtin name to a callable lambda value: `SUM` becomes
 *  `LAMBDA(_x1,_x2,_x3, SUM(_x1,_x2,_x3))`. This lets aggregators be passed by name
 *  to higher-order functions (GROUPBY, PIVOTBY, BYROW, MAP). Three parameters cover
 *  the realistic uses; unsupplied ones bind to BLANK, which aggregators ignore. */
const ETA_PARAMS = ['_X1', '_X2', '_X3']
const etaCache = new Map<string, LambdaValue>()
function etaReduce(upperName: string): LambdaValue | null {
  if (!(upperName in FUNCTIONS)) return null
  let lam = etaCache.get(upperName)
  if (!lam) {
    const args: Node[] = ETA_PARAMS.map((p) => ({ type: 'name', name: p }))
    const body: Node = { type: 'call', name: upperName, args }
    lam = { kind: 'lambda', params: [...ETA_PARAMS], body, closure: new Map() }
    etaCache.set(upperName, lam)
  }
  return lam
}

/** Resolve a call target that isn't a builtin: a lexical binding or a defined name
 *  whose definition evaluates to a lambda. Returns null when the name is unknown. */
function resolveCallable(name: string, ctx: EvalContext): RuntimeValue | ErrorValue | null {
  const key = name.toUpperCase()
  const local = ctx.locals?.get(key)
  if (local !== undefined) return local
  const binding = ctx.resolveName?.(key)
  if (!binding) return null
  if (ctx.nameStack?.has(key)) return err('#CIRC!', `name "${name}" refers to itself`)
  return evaluate(binding.ast, {
    ...ctx,
    currentSheet: binding.scopeSheet,
    nameStack: new Set([...(ctx.nameStack ?? []), key]),
    locals: undefined,
  })
}

function evalBinary(op: BinaryOp, leftNode: Node, rightNode: Node, h: FnHelpers): RuntimeValue {
  const lv = h.eval(leftNode)
  const rv = h.eval(rightNode)
  // Implicit array arithmetic: when either side is a range/array, the operator is
  // applied element-wise with broadcasting — `A1:A4>6` yields a boolean array, the
  // backbone of FILTER and friends. Mismatched cells pad with #N/A, as Excel does.
  if (isMatrix(lv) || isMatrix(rv)) return broadcastBinary(op, lv, rv)
  return scalarBinary(op, asScalar(lv), asScalar(rv))
}

function mapMatrix(m: MatrixValue, f: (s: Scalar) => Scalar): MatrixValue {
  return matrix(m.data.map((row) => row.map(f)))
}

function broadcastBinary(op: BinaryOp, lv: RuntimeValue, rv: RuntimeValue): RuntimeValue {
  if (isLambda(lv) || isLambda(rv) || isSparkline(lv) || isSparkline(rv)) return err('#VALUE!')
  const L = isMatrix(lv) ? lv : matrix([[asScalar(lv)]])
  const R = isMatrix(rv) ? rv : matrix([[asScalar(rv)]])
  const rows = Math.max(L.rows, R.rows)
  const cols = Math.max(L.cols, R.cols)
  const pick = (m: MatrixValue, r: number, c: number): Scalar => {
    const rr = m.rows === 1 ? 0 : r
    const cc = m.cols === 1 ? 0 : c
    return rr < m.rows && cc < m.cols ? m.data[rr][cc] : err('#N/A')
  }
  const data: Scalar[][] = []
  for (let r = 0; r < rows; r++) {
    const row: Scalar[] = []
    for (let c = 0; c < cols; c++) row.push(scalarBinary(op, pick(L, r, c), pick(R, r, c)))
    data.push(row)
  }
  return matrix(data)
}

function scalarBinary(op: BinaryOp, l: Scalar, r: Scalar): Scalar {
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
