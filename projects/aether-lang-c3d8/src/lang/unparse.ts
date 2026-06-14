// Aether — a source pretty-printer for the AST.
//
// Used by the Classes inspector to render the *elaborated* core program, so the
// dictionary-passing that type classes compile down to is visible as readable
// Aether source: instance dictionaries become records, constrained functions
// gain dictionary parameters, and method calls become field accesses.

import type { Expr, Pattern, TypeExpr } from './ast.ts'

/** Render a syntactic type expression (method signatures, instance heads). */
export function typeExprToString(te: TypeExpr, arg = false): string {
  switch (te.kind) {
    case 'tvar':
      return te.name
    case 'tarrow':
      return wrap(`${typeExprToString(te.from, true)} -> ${typeExprToString(te.to)}`, arg)
    case 'ttuple':
      return `(${te.elements.map((x) => typeExprToString(x)).join(', ')})`
    case 'tcon': {
      if (te.args.length === 0) return te.name
      const s = `${te.name} ${te.args.map((x) => typeExprToString(x, true)).join(' ')}`
      return arg ? `(${s})` : s
    }
  }
}

const INDENT = '  '

export function unparse(e: Expr): string {
  return go(e, 0, false)
}

function pad(depth: number): string {
  return INDENT.repeat(depth)
}

// `arg` requests parenthesisation when the expression is a compound operand.
function go(e: Expr, depth: number, arg: boolean): string {
  switch (e.kind) {
    case 'int':
      return String(e.value)
    case 'float':
      return String(e.value)
    case 'bool':
      return String(e.value)
    case 'str':
      return JSON.stringify(e.value)
    case 'unit':
      return '()'
    case 'var':
      return e.name
    case 'lambda':
      return wrap(`fn ${e.param} -> ${go(e.body, depth, false)}`, arg)
    case 'app':
      return wrap(`${go(e.fn, depth, false)} ${go(e.arg, depth, true)}`, arg)
    case 'let': {
      const kw = e.recursive ? 'let rec' : 'let'
      const v = go(e.value, depth + 1, false)
      return `${kw} ${e.name} = ${v} in\n${pad(depth)}${go(e.body, depth, false)}`
    }
    case 'letrec': {
      const binds = e.bindings
        .map((b, i) => `${i === 0 ? 'let rec' : pad(depth) + 'and'} ${b.name} = ${go(b.value, depth + 1, false)}`)
        .join('\n')
      return `${binds} in\n${pad(depth)}${go(e.body, depth, false)}`
    }
    case 'if':
      return wrap(
        `if ${go(e.cond, depth, false)} then ${go(e.then, depth, false)} else ${go(e.else, depth, false)}`,
        arg,
      )
    case 'binop':
      return wrap(`${go(e.left, depth, true)} ${e.op} ${go(e.right, depth, true)}`, arg)
    case 'unop':
      return wrap(`${e.op}${go(e.operand, depth, true)}`, arg)
    case 'list':
      return `[${e.elements.map((x) => go(x, depth, false)).join(', ')}]`
    case 'tuple':
      return `(${e.elements.map((x) => go(x, depth, false)).join(', ')})`
    case 'seq':
      return wrap(`${go(e.first, depth, false)}; ${go(e.rest, depth, false)}`, arg)
    case 'match': {
      const cases = e.cases
        .map(
          (c) =>
            `\n${pad(depth + 1)}| ${unparsePattern(c.pattern)}${
              c.guard ? ` when ${go(c.guard, depth + 1, false)}` : ''
            } -> ${go(c.body, depth + 1, false)}`,
        )
        .join('')
      return wrap(`match ${go(e.scrutinee, depth, false)} with${cases}`, arg)
    }
    case 'typedecl':
      return `type ${e.name}${e.params.length ? ' ' + e.params.join(' ') : ''} = … in\n${pad(depth)}${go(e.body, depth, false)}`
    case 'record':
      return `{ ${e.fields.map((f) => `${f.label} = ${go(f.value, depth, false)}`).join(', ')} }`
    case 'field':
      return `${go(e.record, depth, true)}.${e.label}`
    case 'recordUpdate':
      return `{ ${go(e.record, depth, false)} | ${e.fields
        .map((f) => `${f.label} = ${go(f.value, depth, false)}`)
        .join(', ')} }`
    case 'classdecl':
      return `class ${e.name} ${e.param} where … in\n${pad(depth)}${go(e.body, depth, false)}`
    case 'instancedecl':
      return `instance ${e.cls} … where … in\n${pad(depth)}${go(e.body, depth, false)}`
  }
}

function unparsePattern(p: Pattern): string {
  switch (p.kind) {
    case 'pwild':
      return '_'
    case 'pvar':
      return p.name
    case 'pint':
      return String(p.value)
    case 'pfloat':
      return String(p.value)
    case 'pbool':
      return String(p.value)
    case 'pstr':
      return JSON.stringify(p.value)
    case 'punit':
      return '()'
    case 'pnil':
      return '[]'
    case 'pcons':
      return `${unparsePattern(p.head)} :: ${unparsePattern(p.tail)}`
    case 'ptuple':
      return `(${p.elements.map(unparsePattern).join(', ')})`
    case 'pcon':
      return p.args.length === 0 ? p.name : `${p.name} ${p.args.map(unparsePattern).join(' ')}`
  }
}

function wrap(s: string, arg: boolean): string {
  return arg ? `(${s})` : s
}
