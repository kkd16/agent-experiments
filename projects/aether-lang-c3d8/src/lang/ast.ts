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
  | '%'
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
  // application of a (typically variable-headed) type to an argument: `m a`,
  // the syntactic seed of higher-kinded types
  | { kind: 'tapp'; fn: TypeExpr; arg: TypeExpr; span: Span }

export interface CtorDecl {
  name: string
  args: TypeExpr[]
  span: Span
}

/** A method signature inside a `class` declaration: `name : <type>`, with an
 * optional default implementation used by instances that omit it. */
export interface MethodSig {
  name: string
  type: TypeExpr
  default?: Expr
  span: Span
}

/** One method implementation inside an `instance`: `name = <expr>`. */
export interface MethodImpl {
  name: string
  value: Expr
  span: Span
}

/** A `=>`-context entry written on an instance, e.g. the `Disp a` in
 * `instance Disp a => Disp (List a)`. Resolution derives the real context from
 * inference; this is kept for display. */
export interface ConstraintExpr {
  cls: string
  param: string
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
  // a record pattern `{ label = p, other }` — irrefutable at the record level;
  // it destructures a (possibly larger) record by projecting the named fields.
  | { kind: 'precord'; fields: { label: string; pattern: Pattern }[]; span: Span }
  // an as-pattern `p as x` — binds `x` to the whole matched value, then matches `p`.
  | { kind: 'pas'; inner: Pattern; name: string; span: Span }
  // an or-pattern `p1 | p2 | …` — matches when any alternative does. Every
  // alternative must bind the same variables (checked during inference).
  | { kind: 'por'; alternatives: Pattern[]; span: Span }

export interface MatchCase {
  pattern: Pattern
  /** optional `when` guard — the clause matches only if it evaluates true */
  guard?: Expr
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
  | { kind: 'letrec'; bindings: { name: string; value: Expr }[]; body: Expr; span: Span }
  | { kind: 'record'; fields: { label: string; value: Expr }[]; span: Span }
  | { kind: 'field'; record: Expr; label: string; span: Span }
  | { kind: 'recordUpdate'; record: Expr; fields: { label: string; value: Expr }[]; span: Span }
  | {
      kind: 'classdecl'
      name: string
      param: string
      /** superclass names constraining the same parameter (`Functor f => Monad f`) */
      supers: string[]
      methods: MethodSig[]
      body: Expr
      span: Span
    }
  | {
      kind: 'instancedecl'
      cls: string
      head: TypeExpr
      context: ConstraintExpr[]
      methods: MethodImpl[]
      /** true when this instance was synthesised by a `deriving` clause */
      derived?: boolean
      body: Expr
      span: Span
    }

/** Structurally deep-copy an expression, giving every node a fresh identity.
 * Used so a class default method can be elaborated independently per instance
 * (the side-tables are keyed by node identity). */
export function cloneExpr(e: Expr): Expr {
  switch (e.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'str':
    case 'unit':
    case 'var':
      return { ...e }
    case 'lambda':
      return { ...e, body: cloneExpr(e.body) }
    case 'app':
      return { ...e, fn: cloneExpr(e.fn), arg: cloneExpr(e.arg) }
    case 'let':
      return { ...e, value: cloneExpr(e.value), body: cloneExpr(e.body) }
    case 'if':
      return { ...e, cond: cloneExpr(e.cond), then: cloneExpr(e.then), else: cloneExpr(e.else) }
    case 'binop':
      return { ...e, left: cloneExpr(e.left), right: cloneExpr(e.right) }
    case 'unop':
      return { ...e, operand: cloneExpr(e.operand) }
    case 'list':
    case 'tuple':
      return { ...e, elements: e.elements.map(cloneExpr) }
    case 'seq':
      return { ...e, first: cloneExpr(e.first), rest: cloneExpr(e.rest) }
    case 'match':
      return {
        ...e,
        scrutinee: cloneExpr(e.scrutinee),
        cases: e.cases.map((c) => ({
          pattern: c.pattern,
          guard: c.guard ? cloneExpr(c.guard) : undefined,
          body: cloneExpr(c.body),
        })),
      }
    case 'typedecl':
      return { ...e, ctors: e.ctors.map((c) => ({ ...c })), body: cloneExpr(e.body) }
    case 'letrec':
      return {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: cloneExpr(b.value) })),
        body: cloneExpr(e.body),
      }
    case 'record':
      return { ...e, fields: e.fields.map((f) => ({ label: f.label, value: cloneExpr(f.value) })) }
    case 'field':
      return { ...e, record: cloneExpr(e.record) }
    case 'recordUpdate':
      return {
        ...e,
        record: cloneExpr(e.record),
        fields: e.fields.map((f) => ({ label: f.label, value: cloneExpr(f.value) })),
      }
    case 'classdecl':
      return {
        ...e,
        methods: e.methods.map((m) => ({ ...m, default: m.default ? cloneExpr(m.default) : undefined })),
        body: cloneExpr(e.body),
      }
    case 'instancedecl':
      return {
        ...e,
        methods: e.methods.map((m) => ({ ...m, value: cloneExpr(m.value) })),
        body: cloneExpr(e.body),
      }
  }
}

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
    case 'letrec':
      return `let rec…and (${e.bindings.length})`
    case 'record':
      return `record {${e.fields.map((f) => f.label).join(', ')}}`
    case 'field':
      return `.${e.label}`
    case 'recordUpdate':
      return `update {${e.fields.map((f) => f.label).join(', ')}}`
    case 'classdecl':
      return `class ${e.name} ${e.param}`
    case 'instancedecl':
      return `instance ${e.cls}`
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
    case 'precord':
      return `{ ${p.fields
        .map((f) => (f.pattern.kind === 'pvar' && f.pattern.name === f.label ? f.label : `${f.label} = ${patternLabel(f.pattern)}`))
        .join(', ')} }`
    case 'pas':
      return `${patternLabel(p.inner)} as ${p.name}`
    case 'por':
      return p.alternatives.map(patternLabel).join(' | ')
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
      return [e.scrutinee, ...e.cases.flatMap((c) => (c.guard ? [c.guard, c.body] : [c.body]))]
    case 'typedecl':
      return [e.body]
    case 'letrec':
      return [...e.bindings.map((b) => b.value), e.body]
    case 'record':
      return e.fields.map((f) => f.value)
    case 'field':
      return [e.record]
    case 'recordUpdate':
      return [e.record, ...e.fields.map((f) => f.value)]
    case 'classdecl':
      return [e.body]
    case 'instancedecl':
      return [...e.methods.map((m) => m.value), e.body]
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Pattern helpers for the record / as / or-pattern extensions.
//
// Or-patterns are *disjunctions*, which the flatten-based backends and the
// decision-tree lowering don't model directly. Rather than thread disjunction
// through every consumer, each backend expands an arm carrying an or-pattern
// into several or-free arms (the cartesian product of the alternatives at each
// nested position) that share a clone of the guard and body. This keeps the
// backends' pattern logic linear; only inference and exhaustiveness reason about
// `por` natively.
// ---------------------------------------------------------------------------

/** Does `p` contain an or-pattern anywhere? (drives whether expansion is needed) */
export function patternHasOr(p: Pattern): boolean {
  switch (p.kind) {
    case 'por':
      return true
    case 'pas':
      return patternHasOr(p.inner)
    case 'pcons':
      return patternHasOr(p.head) || patternHasOr(p.tail)
    case 'ptuple':
      return p.elements.some(patternHasOr)
    case 'pcon':
      return p.args.some(patternHasOr)
    case 'precord':
      return p.fields.some((f) => patternHasOr(f.pattern))
    default:
      return false
  }
}

/** Does `p` use any of the record / as / or extensions anywhere? Used by the
 *  decision-tree pass to fall back to the naive compiler for these arms. */
export function patternHasExtension(p: Pattern): boolean {
  switch (p.kind) {
    case 'por':
    case 'pas':
    case 'precord':
      return true
    case 'pcons':
      return patternHasExtension(p.head) || patternHasExtension(p.tail)
    case 'ptuple':
      return p.elements.some(patternHasExtension)
    case 'pcon':
      return p.args.some(patternHasExtension)
    default:
      return false
  }
}

function cartesian<T>(rows: T[][]): T[][] {
  let acc: T[][] = [[]]
  for (const row of rows) {
    const next: T[][] = []
    for (const prefix of acc) for (const x of row) next.push([...prefix, x])
    acc = next
  }
  return acc
}

/** Every or-free pattern an arm's pattern can take, i.e. the cartesian product of
 *  the alternatives at each nested or-pattern. Structure-preserving: when `p`
 *  contains no or-pattern the single original object is returned unchanged. */
export function expandOrPattern(p: Pattern): Pattern[] {
  switch (p.kind) {
    case 'por':
      return p.alternatives.flatMap(expandOrPattern)
    case 'pas':
      return expandOrPattern(p.inner).map((inner) => ({ ...p, inner }))
    case 'pcons': {
      const heads = expandOrPattern(p.head)
      const tails = expandOrPattern(p.tail)
      const out: Pattern[] = []
      for (const head of heads) for (const tail of tails) out.push({ ...p, head, tail })
      return out
    }
    case 'ptuple':
      return cartesian(p.elements.map(expandOrPattern)).map((elements) => ({ ...p, elements }))
    case 'pcon':
      return cartesian(p.args.map(expandOrPattern)).map((args) => ({ ...p, args }))
    case 'precord':
      return cartesian(p.fields.map((f) => expandOrPattern(f.pattern))).map((pats) => ({
        ...p,
        fields: p.fields.map((f, i) => ({ label: f.label, pattern: pats[i] })),
      }))
    default:
      return [p]
  }
}

/** Rewrite a list of match arms so no arm's pattern contains an or-pattern,
 *  cloning the guard/body for each alternative. Arms without or-patterns are
 *  passed through by identity, so or-free matches compile bit-for-bit as before. */
export function expandOrCases(cases: MatchCase[]): MatchCase[] {
  if (!cases.some((c) => patternHasOr(c.pattern))) return cases
  const out: MatchCase[] = []
  for (const c of cases) {
    if (!patternHasOr(c.pattern)) {
      out.push(c)
      continue
    }
    for (const pattern of expandOrPattern(c.pattern)) {
      out.push({
        pattern,
        guard: c.guard ? cloneExpr(c.guard) : undefined,
        body: cloneExpr(c.body),
      })
    }
  }
  return out
}
