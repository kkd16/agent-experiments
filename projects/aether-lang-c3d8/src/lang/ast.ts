// Aether — abstract syntax tree
//
// A small, fully-typed expression language (ML family). Every node carries a
// source `span` so the type checker and VM can attribute results and errors
// back to exact source ranges. Each binary/unary operator is its own node
// (rather than desugared into calls) so the AST view mirrors what you wrote.

import type { Span } from './lexer.ts'

export type BinaryOp =
  // integer arithmetic
  | '+'
  | '-'
  | '*'
  | '/'
  // floating arithmetic
  | '+.'
  | '-.'
  | '*.'
  | '/.'
  // comparison (polymorphic, structural)
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  // boolean (short-circuit)
  | '&&'
  | '||'
  // list cons / append / string concat
  | '::'
  | '++'
  | '^'

export type UnaryOp = '-' | '!'

/**
 * A syntactic type expression, as written in a `type` declaration's
 * constructor arguments. Converted to a real `Type` when building constructor
 * schemes. `tcon` covers builtins (Int, List, …) and user-declared types.
 */
export type TypeExpr =
  | { kind: 'tvar'; name: string; span: Span }
  | { kind: 'tcon'; name: string; args: TypeExpr[]; span: Span }
  | { kind: 'tarrow'; from: TypeExpr; to: TypeExpr; span: Span }
  | { kind: 'ttuple'; elements: TypeExpr[]; span: Span }

export interface CtorDecl {
  name: string
  args: TypeExpr[]
  span: Span
}

/**
 * Patterns used by `match`. `plist` is normalised into nested `pcons`/`pnil`
 * by the parser, so the compiler only ever sees cons-cells.
 */
export type Pattern =
  | { kind: 'pwild'; span: Span }
  | { kind: 'pvar'; name: string; span: Span }
  | { kind: 'pint'; value: number; span: Span }
  | { kind: 'pfloat'; value: number; span: Span }
  | { kind: 'pbool'; value: boolean; span: Span }
  | { kind: 'pstr'; value: string; span: Span }
  | { kind: 'punit'; span: Span }
  | { kind: 'pnil'; span: Span }
  | { kind: 'pcons'; head: Pattern; tail: Pattern; span: Span }
  | { kind: 'ptuple'; elements: Pattern[]; span: Span }
  | { kind: 'pcon'; name: string; args: Pattern[]; span: Span }

export interface MatchCase {
  pattern: Pattern
  body: Expr
}

export type Expr =
  | { kind: 'int'; value: number; span: Span }
  | { kind: 'float'; value: number; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'str'; value: string; span: Span }
  | { kind: 'unit'; span: Span }
  | { kind: 'var'; name: string; span: Span }
  | { kind: 'lambda'; param: string; body: Expr; span: Span }
  | { kind: 'app'; fn: Expr; arg: Expr; span: Span }
  | { kind: 'let'; name: string; value: Expr; body: Expr; recursive: boolean; span: Span }
  | { kind: 'if'; cond: Expr; then: Expr; else: Expr; span: Span }
  | { kind: 'binop'; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { kind: 'unop'; op: UnaryOp; operand: Expr; span: Span }
  | { kind: 'list'; elements: Expr[]; span: Span }
  | { kind: 'tuple'; elements: Expr[]; span: Span }
  | { kind: 'seq'; first: Expr; rest: Expr; span: Span }
  | { kind: 'match'; scrutinee: Expr; cases: MatchCase[]; span: Span }
  | { kind: 'typedecl'; name: string; params: string[]; ctors: CtorDecl[]; body: Expr; span: Span }

/** A short human-readable label for a node, used by the AST visualiser. */
export function nodeLabel(e: Expr): string {
  switch (e.kind) {
    case 'int':
      return `int ${e.value}`
    case 'float':
      return `float ${e.value}`
    case 'bool':
      return `bool ${e.value}`
    case 'str':
      return `str ${JSON.stringify(e.value)}`
    case 'unit':
      return 'unit ()'
    case 'var':
      return `var ${e.name}`
    case 'lambda':
      return `fn ${e.param} ->`
    case 'app':
      return 'apply'
    case 'let':
      return e.recursive ? `let rec ${e.name}` : `let ${e.name}`
    case 'if':
      return 'if'
    case 'binop':
      return `(${e.op})`
    case 'unop':
      return `unary ${e.op}`
    case 'list':
      return `list [${e.elements.length}]`
    case 'tuple':
      return `tuple (${e.elements.length})`
    case 'seq':
      return 'seq ;'
    case 'match':
      return `match (${e.cases.length})`
    case 'typedecl':
      return `type ${e.name}`
  }
}

/** A short human-readable label for a pattern, used by the AST visualiser. */
export function patternLabel(p: Pattern): string {
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
      return `${patternLabel(p.head)} :: ${patternLabel(p.tail)}`
    case 'ptuple':
      return `(${p.elements.map(patternLabel).join(', ')})`
    case 'pcon':
      return p.args.length === 0 ? p.name : `${p.name} ${p.args.map(patternLabel).join(' ')}`
  }
}

/** Ordered children of a node (for tree walks / rendering). */
export function children(e: Expr): Expr[] {
  switch (e.kind) {
    case 'lambda':
      return [e.body]
    case 'app':
      return [e.fn, e.arg]
    case 'let':
      return [e.value, e.body]
    case 'if':
      return [e.cond, e.then, e.else]
    case 'binop':
      return [e.left, e.right]
    case 'unop':
      return [e.operand]
    case 'list':
    case 'tuple':
      return e.elements
    case 'seq':
      return [e.first, e.rest]
    case 'match':
      return [e.scrutinee, ...e.cases.map((c) => c.body)]
    case 'typedecl':
      return [e.body]
    default:
      return []
  }
}
