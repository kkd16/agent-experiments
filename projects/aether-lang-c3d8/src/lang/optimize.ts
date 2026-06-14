// Aether — optimizer
//
// A small, semantics-preserving AST→AST rewrite run before compilation:
//   • constant folding for arithmetic, comparison, boolean and string ops
//   • unary folding (negate / not)
//   • short-circuit simplification (`true && x` → `x`, `false || x` → `x`, …)
//   • dead-branch elimination (`if true then a else b` → `a`)
// It never folds anything whose evaluation could differ at runtime (e.g.
// division by zero is left intact). Returns the rewritten tree and a count of
// the rewrites performed, which the UI surfaces.

import type { BinaryOp, Expr } from './ast.ts'

export interface OptimizeResult {
  expr: Expr
  folded: number
}

export function optimize(expr: Expr): OptimizeResult {
  let folded = 0
  const bump = (): void => {
    folded++
  }
  const result = opt(expr, bump)
  return { expr: result, folded }
}

function opt(e: Expr, bump: () => void): Expr {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'var':
      return e
    case 'lambda':
      return { ...e, body: opt(e.body, bump) }
    case 'app':
      return { ...e, fn: opt(e.fn, bump), arg: opt(e.arg, bump) }
    case 'let':
      return { ...e, value: opt(e.value, bump), body: opt(e.body, bump) }
    case 'letrec':
      return {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: opt(b.value, bump) })),
        body: opt(e.body, bump),
      }
    case 'typedecl':
      return { ...e, body: opt(e.body, bump) }
    case 'classdecl':
      return { ...e, body: opt(e.body, bump) }
    case 'instancedecl':
      return {
        ...e,
        methods: e.methods.map((m) => ({ ...m, value: opt(m.value, bump) })),
        body: opt(e.body, bump),
      }
    case 'seq':
      return { ...e, first: opt(e.first, bump), rest: opt(e.rest, bump) }
    case 'list':
      return { ...e, elements: e.elements.map((x) => opt(x, bump)) }
    case 'tuple':
      return { ...e, elements: e.elements.map((x) => opt(x, bump)) }
    case 'match':
      return {
        ...e,
        scrutinee: opt(e.scrutinee, bump),
        cases: e.cases.map((c) => ({
          pattern: c.pattern,
          guard: c.guard ? opt(c.guard, bump) : undefined,
          body: opt(c.body, bump),
        })),
      }
    case 'record':
      return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: opt(f.value, bump) })) }
    case 'field':
      return { ...e, record: opt(e.record, bump) }
    case 'recordUpdate':
      return {
        ...e,
        record: opt(e.record, bump),
        fields: e.fields.map((f) => ({ label: f.label, value: opt(f.value, bump) })),
      }
    case 'if':
      return optIf(e, bump)
    case 'unop':
      return optUnop(e, bump)
    case 'binop':
      return optBinop(e, bump)
  }
}

function optIf(e: Extract<Expr, { kind: 'if' }>, bump: () => void): Expr {
  const cond = opt(e.cond, bump)
  const thenE = opt(e.then, bump)
  const elseE = opt(e.else, bump)
  if (cond.kind === 'bool') {
    bump()
    return cond.value ? thenE : elseE
  }
  return { ...e, cond, then: thenE, else: elseE }
}

function optUnop(e: Extract<Expr, { kind: 'unop' }>, bump: () => void): Expr {
  const operand = opt(e.operand, bump)
  if (e.op === '-' && operand.kind === 'int') {
    bump()
    return { kind: 'int', value: -operand.value, span: e.span }
  }
  if (e.op === '!' && operand.kind === 'bool') {
    bump()
    return { kind: 'bool', value: !operand.value, span: e.span }
  }
  return { ...e, operand }
}

function optBinop(e: Extract<Expr, { kind: 'binop' }>, bump: () => void): Expr {
  const left = opt(e.left, bump)
  const right = opt(e.right, bump)
  const span = e.span

  // short-circuit boolean simplification (works even when one side is dynamic)
  if (e.op === '&&') {
    if (left.kind === 'bool') {
      bump()
      return left.value ? right : { kind: 'bool', value: false, span }
    }
    if (right.kind === 'bool' && right.value) {
      bump()
      return left
    }
  }
  if (e.op === '||') {
    if (left.kind === 'bool') {
      bump()
      return left.value ? { kind: 'bool', value: true, span } : right
    }
    if (right.kind === 'bool' && !right.value) {
      bump()
      return left
    }
  }

  const folded = foldBinop(e.op, left, right, span)
  if (folded) {
    bump()
    return folded
  }
  return { ...e, left, right }
}

function foldBinop(op: BinaryOp, l: Expr, r: Expr, span: Expr['span']): Expr | null {
  // integer arithmetic
  if (l.kind === 'int' && r.kind === 'int') {
    switch (op) {
      case '+':
        return { kind: 'int', value: (l.value + r.value) | 0, span }
      case '-':
        return { kind: 'int', value: (l.value - r.value) | 0, span }
      case '*':
        return { kind: 'int', value: Math.trunc(l.value * r.value), span }
      case '/':
        return r.value === 0 ? null : { kind: 'int', value: Math.trunc(l.value / r.value), span }
      case '%':
        return r.value === 0 ? null : { kind: 'int', value: l.value % r.value, span }
    }
  }
  // float arithmetic (leave division by zero alone)
  if (l.kind === 'float' && r.kind === 'float') {
    switch (op) {
      case '+.':
        return { kind: 'float', value: l.value + r.value, span }
      case '-.':
        return { kind: 'float', value: l.value - r.value, span }
      case '*.':
        return { kind: 'float', value: l.value * r.value, span }
      case '/.':
        return r.value === 0 ? null : { kind: 'float', value: l.value / r.value, span }
    }
  }
  // string concat
  if (op === '^' && l.kind === 'str' && r.kind === 'str') {
    return { kind: 'str', value: l.value + r.value, span }
  }
  // comparisons over matching literal kinds
  const cmp = compareLiterals(l, r)
  if (cmp !== null) {
    switch (op) {
      case '==':
        return { kind: 'bool', value: cmp === 0, span }
      case '!=':
        return { kind: 'bool', value: cmp !== 0, span }
      case '<':
        return { kind: 'bool', value: cmp < 0, span }
      case '>':
        return { kind: 'bool', value: cmp > 0, span }
      case '<=':
        return { kind: 'bool', value: cmp <= 0, span }
      case '>=':
        return { kind: 'bool', value: cmp >= 0, span }
    }
  }
  return null
}

// compare two constant literals of the same kind; null if not comparable here
function compareLiterals(l: Expr, r: Expr): number | null {
  if ((l.kind === 'int' || l.kind === 'float') && (r.kind === 'int' || r.kind === 'float')) {
    return Math.sign(l.value - r.value)
  }
  if (l.kind === 'str' && r.kind === 'str') {
    return l.value < r.value ? -1 : l.value > r.value ? 1 : 0
  }
  if (l.kind === 'bool' && r.kind === 'bool') {
    return (l.value ? 1 : 0) - (r.value ? 1 : 0)
  }
  if (l.kind === 'unit' && r.kind === 'unit') return 0
  return null
}
