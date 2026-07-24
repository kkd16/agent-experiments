// Aether — parser
//
// A Pratt (precedence-climbing) parser. Function application is juxtaposition
// (`f x y`) and binds tighter than every binary operator; `let`, `fn` and `if`
// are prefix forms whose bodies extend as far right as possible. Multi-argument
// `fn a b -> e` and `let f a b = e` desugar to curried single-argument lambdas.

import type {
  BinaryOp,
  ConstraintExpr,
  CtorDecl,
  Expr,
  MatchCase,
  MethodImpl,
  MethodSig,
  Pattern,
  TypeExpr,
  UnaryOp,
} from './ast.ts'
import type { Span, Token } from './lexer.ts'
import { tokenize } from './lexer.ts'
import { DERIVABLE, deriveInstances, isDerivable } from './deriving.ts'

// A list-comprehension qualifier. Three forms, mirroring Haskell:
//   • a generator `pat <- src` — draw elements from a list, keeping only the
//     ones that match `pat` (a refutable pattern silently drops non-matches, the
//     list-monad `fail`);
//   • a `let pat = rhs` binding, in scope for every qualifier to its right;
//   • a boolean guard — any expression, filtering the elements seen so far.
type Qualifier =
  | { kind: 'gen'; pat: Pattern; src: Expr }
  | { kind: 'let'; pat: Pattern; rhs: Expr }
  | { kind: 'guard'; test: Expr }

export class ParseError extends Error {
  span: Span
  constructor(message: string, span: Span) {
    super(message)
    this.name = 'ParseError'
    this.span = span
  }
}

// Left binding power for each infix operator. Higher binds tighter.
const INFIX_BP: Record<string, number> = {
  ';': 1,
  '|>': 2,
  '||': 3,
  '&&': 4,
  '==': 5,
  '!=': 5,
  '<': 5,
  '>': 5,
  '<=': 5,
  '>=': 5,
  '::': 6,
  '^': 6,
  '++': 6,
  '+': 7,
  '-': 7,
  '+.': 7,
  '-.': 7,
  '*': 8,
  '/': 8,
  '%': 8,
  '*.': 8,
  '/.': 8,
}

// Right-associative operators recurse with a slightly lower minimum bp.
const RIGHT_ASSOC = new Set([';', '::', '^', '++'])

const UNARY_BP = 8

class Parser {
  private toks: Token[]
  private pos = 0
  // counter for fresh names synthesised when desugaring pattern binders
  // (`let (a, b) = …`, `fn { x } -> …`). `$`-prefixed names can't be lexed, so
  // they never collide with source identifiers.
  private synthId = 0

  constructor(toks: Token[]) {
    this.toks = toks
  }

  private freshName(): string {
    return `$pat_${this.synthId++}`
  }

  /** A pattern-binder position (`let`/`fn` param) starts with `(`, `{` or `[`. */
  private startsPatternBinder(): boolean {
    const t = this.peek()
    return t.kind === 'punc' && (t.value === '(' || t.value === '[' || t.value === '{')
  }

  private peek(): Token {
    return this.toks[this.pos]
  }
  private next(): Token {
    return this.toks[this.pos++]
  }
  private at(kind: Token['kind'], value?: string): boolean {
    const t = this.peek()
    return t.kind === kind && (value === undefined || t.value === value)
  }
  private expect(kind: Token['kind'], value: string): Token {
    if (!this.at(kind, value)) {
      const t = this.peek()
      throw new ParseError(`expected ${JSON.stringify(value)} but found ${JSON.stringify(t.value)}`, t.span)
    }
    return this.next()
  }

  private spanFrom(start: Span, end: Span): Span {
    return { start: start.start, end: end.end, line: start.line, col: start.col }
  }

  parseProgram(): Expr {
    const e = this.parseExpr(0)
    if (!this.at('eof')) {
      const t = this.peek()
      throw new ParseError(`unexpected trailing input ${JSON.stringify(t.value)}`, t.span)
    }
    return e
  }

  parseExpr(minBp: number): Expr {
    let left = this.parsePrefix()
    for (;;) {
      const t = this.peek()
      const opStr = t.value
      const isInfix =
        (t.kind === 'op' && opStr in INFIX_BP) || (t.kind === 'punc' && opStr === ';')
      if (!isInfix) break
      const lbp = INFIX_BP[opStr]
      if (lbp <= minBp) break
      this.next()
      const rbp = RIGHT_ASSOC.has(opStr) ? lbp - 1 : lbp
      const right = this.parseExpr(rbp)
      const span = this.spanFrom(left.span, right.span)
      if (opStr === ';') {
        left = { kind: 'seq', first: left, rest: right, span }
      } else if (opStr === '|>') {
        // pipe: `x |> f` desugars to the application `f x`
        left = { kind: 'app', fn: right, arg: left, span }
      } else {
        left = { kind: 'binop', op: opStr as BinaryOp, left, right, span }
      }
    }
    return left
  }

  private parsePrefix(): Expr {
    const t = this.peek()

    if (t.kind === 'keyword') {
      if (t.value === 'let') return this.parseLet()
      if (t.value === 'fn') return this.parseLambda()
      if (t.value === 'if') return this.parseIf()
      if (t.value === 'match') return this.parseMatch()
      if (t.value === 'type') return this.parseTypeDecl()
      if (t.value === 'class') return this.parseClassDecl()
      if (t.value === 'instance') return this.parseInstanceDecl()
      if (t.value === 'do') return this.parseDo()
    }

    if (t.kind === 'op' && (t.value === '-' || t.value === '!')) {
      this.next()
      const operand = this.parseExpr(UNARY_BP)
      return { kind: 'unop', op: t.value as UnaryOp, operand, span: this.spanFrom(t.span, operand.span) }
    }

    return this.parseApp()
  }

  // application: a head atom followed by zero or more argument atoms
  private parseApp(): Expr {
    let head = this.parseAtom()
    while (this.startsAtom()) {
      const arg = this.parseAtom()
      head = { kind: 'app', fn: head, arg, span: this.spanFrom(head.span, arg.span) }
    }
    return head
  }

  private startsAtom(): boolean {
    const t = this.peek()
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'string' || t.kind === 'ident') return true
    if (t.kind === 'keyword' && (t.value === 'true' || t.value === 'false')) return true
    if (t.kind === 'punc' && (t.value === '(' || t.value === '[' || t.value === '{')) return true
    return false
  }

  // an atom plus any trailing `.field` accesses (which bind tightest)
  private parseAtom(): Expr {
    let e = this.parsePrimary()
    while (this.at('punc', '.')) {
      this.next()
      if (!this.at('ident')) {
        throw new ParseError('expected a field name after "."', this.peek().span)
      }
      const name = this.next()
      e = { kind: 'field', record: e, label: name.value, span: this.spanFrom(e.span, name.span) }
    }
    return e
  }

  private parsePrimary(): Expr {
    const t = this.peek()
    switch (t.kind) {
      case 'int':
        this.next()
        return { kind: 'int', value: parseInt(t.value, 10), span: t.span }
      case 'float':
        this.next()
        return { kind: 'float', value: parseFloat(t.value), span: t.span }
      case 'string':
        this.next()
        return { kind: 'str', value: t.value, span: t.span }
      case 'ident':
        this.next()
        return { kind: 'var', name: t.value, span: t.span }
      case 'keyword':
        if (t.value === 'true' || t.value === 'false') {
          this.next()
          return { kind: 'bool', value: t.value === 'true', span: t.span }
        }
        throw new ParseError(`unexpected keyword ${JSON.stringify(t.value)}`, t.span)
      case 'punc':
        if (t.value === '(') return this.parseParen()
        if (t.value === '[') return this.parseList()
        if (t.value === '{') return this.parseRecord()
        throw new ParseError(`unexpected ${JSON.stringify(t.value)}`, t.span)
      default:
        throw new ParseError(`unexpected ${JSON.stringify(t.value)}`, t.span)
    }
  }

  private parseFieldAssignments(): { label: string; value: Expr }[] {
    const fields: { label: string; value: Expr }[] = []
    for (;;) {
      if (!this.at('ident')) {
        throw new ParseError('expected a field label', this.peek().span)
      }
      const label = this.next().value
      this.expect('op', '=')
      const value = this.parseExpr(0)
      fields.push({ label, value })
      if (this.at('punc', ',')) {
        this.next()
        continue
      }
      break
    }
    return fields
  }

  private parseRecord(): Expr {
    const open = this.expect('punc', '{')
    if (this.at('punc', '}')) {
      const close = this.next()
      return { kind: 'record', fields: [], span: this.spanFrom(open.span, close.span) }
    }
    // record literal `{ label = … }` — an ident immediately followed by '='
    const lookahead = this.toks[this.pos + 1]
    if (this.at('ident') && lookahead && lookahead.kind === 'op' && lookahead.value === '=') {
      const fields = this.parseFieldAssignments()
      const close = this.expect('punc', '}')
      return { kind: 'record', fields, span: this.spanFrom(open.span, close.span) }
    }
    // functional update `{ expr | label = …, … }`
    const base = this.parseExpr(0)
    this.expect('op', '|')
    const fields = this.parseFieldAssignments()
    const close = this.expect('punc', '}')
    return { kind: 'recordUpdate', record: base, fields, span: this.spanFrom(open.span, close.span) }
  }

  private parseParen(): Expr {
    const open = this.expect('punc', '(')
    // unit literal: ()
    if (this.at('punc', ')')) {
      const close = this.next()
      return { kind: 'unit', span: this.spanFrom(open.span, close.span) }
    }
    // operator sections and the bare-operator function — all pure sugar for a
    // lambda, so nothing downstream ever sees them:
    //   (+)        the binary operator as a first-class function
    //   (+ 1)      a right section:  fn x -> x + 1
    //   (.field)   a field accessor: fn r -> r.field   (chains: (.a.b))
    const section = this.tryOperatorSection(open)
    if (section) return section

    const first = this.parseExpr(0)
    if (this.at('punc', ',')) {
      const elements = [first]
      while (this.at('punc', ',')) {
        this.next()
        elements.push(this.parseExpr(0))
      }
      const close = this.expect('punc', ')')
      return { kind: 'tuple', elements, span: this.spanFrom(open.span, close.span) }
    }
    // type ascription: `(e : T)`. Desugared to a one-shot signatured binding
    // `let $asc : T = e in $asc`, so it reuses the exact `let`-signature checking
    // path (skolemised, GADT-aware). The name is used immediately, so a fixed
    // reserved name is safe even when ascriptions nest (inner simply shadows).
    if (this.at('op', ':')) {
      this.next()
      const sig = this.parseTypeExpr()
      const close = this.expect('punc', ')')
      const span = this.spanFrom(open.span, close.span)
      const nm = '$asc'
      return {
        kind: 'let',
        name: nm,
        value: first,
        body: { kind: 'var', name: nm, span },
        recursive: false,
        sig,
        span,
      }
    }
    this.expect('punc', ')')
    return first
  }

  private parseList(): Expr {
    const open = this.expect('punc', '[')
    if (this.at('punc', ']')) {
      const close = this.next()
      return { kind: 'list', elements: [], span: this.spanFrom(open.span, close.span) }
    }
    const first = this.parseExpr(0)
    // list comprehension: `[ e | qual, qual, … ]`
    if (this.at('op', '|')) {
      this.next()
      const quals = this.parseQualifiers()
      const close = this.expect('punc', ']')
      const span = this.spanFrom(open.span, close.span)
      return this.desugarComprehension(first, quals, 0, span)
    }
    // range literal `[ a .. b ]` — the inclusive Int enumeration a, a+1, …, b.
    if (this.at('op', '..')) {
      this.next()
      const to = this.parseExpr(0)
      const close = this.expect('punc', ']')
      const span = this.spanFrom(open.span, close.span)
      return this.enumApp('enumFromTo', [first, to], span)
    }
    // ordinary list literal — or a stepped range `[ a, s .. b ]`.
    const elements: Expr[] = [first]
    while (this.at('punc', ',')) {
      this.next()
      const next = this.parseExpr(0)
      // stepped range: `[ a, s .. b ]` enumerates a, s, s+(s-a), …, ≤ b (or ≥ b
      // when the step is negative). Only the *second* element may precede `..`.
      if (elements.length === 1 && this.at('op', '..')) {
        this.next()
        const to = this.parseExpr(0)
        const close = this.expect('punc', ']')
        const span = this.spanFrom(open.span, close.span)
        return this.enumApp('enumFromThenTo', [first, next, to], span)
      }
      elements.push(next)
    }
    const close = this.expect('punc', ']')
    return { kind: 'list', elements, span: this.spanFrom(open.span, close.span) }
  }

  // Build the saturated application of a prelude enumeration helper to its
  // range bounds, e.g. `enumFromTo a b` ⇒ ((enumFromTo a) b).
  private enumApp(fn: string, args: Expr[], span: Span): Expr {
    let acc: Expr = { kind: 'var', name: fn, span }
    for (const a of args) {
      acc = { kind: 'app', fn: acc, arg: a, span }
    }
    return acc
  }

  // Try to read an operator section or a field accessor immediately after `(`.
  // Returns the desugared lambda, or null if the parens hold an ordinary
  // expression. Left sections (`(x +)`) are deliberately not offered — they read
  // ambiguously against a partial application — so the common point-free shapes
  // are `(op)`, `(op e)` and `(.field)`.
  private tryOperatorSection(open: Token): Expr | null {
    const t = this.peek()

    // field accessor: (.field), or a chain (.a.b) — one lambda projecting through.
    if (t.kind === 'punc' && t.value === '.' && this.toks[this.pos + 1]?.kind === 'ident') {
      const labels: string[] = []
      while (this.at('punc', '.')) {
        this.next()
        if (!this.at('ident')) {
          throw new ParseError('expected a field name after "." in a section', this.peek().span)
        }
        labels.push(this.next().value)
      }
      const close = this.expect('punc', ')')
      const span = this.spanFrom(open.span, close.span)
      const p = this.freshName()
      let body: Expr = { kind: 'var', name: p, span }
      for (const label of labels) body = { kind: 'field', record: body, label, span }
      return { kind: 'lambda', param: p, body, span }
    }

    // operator section — only for an infix operator (never `;`, the sequencer).
    if (t.kind === 'op' && t.value in INFIX_BP && t.value !== ';') {
      const op = t.value
      const after = this.toks[this.pos + 1]
      // the bare operator as a function: (op)
      if (after && after.kind === 'punc' && after.value === ')') {
        this.next() // op
        const close = this.next() // )
        const span = this.spanFrom(open.span, close.span)
        const l = this.freshName()
        const r = this.freshName()
        const body = this.applyInfix(op, { kind: 'var', name: l, span }, { kind: 'var', name: r, span }, span)
        return { kind: 'lambda', param: l, body: { kind: 'lambda', param: r, body, span }, span }
      }
      // right section: (op e) ⇒ fn x -> x op e. A leading `-` (or `!`) is unary
      // negation/not, not a section, so let it fall through to the normal parse
      // — `(- 1)` is negative one; write `(subtract 1)` for the subtract section.
      if (op !== '-' && op !== '!') {
        this.next() // op
        const e = this.parseExpr(0)
        const close = this.expect('punc', ')')
        const span = this.spanFrom(open.span, close.span)
        const x = this.freshName()
        const body = this.applyInfix(op, { kind: 'var', name: x, span }, e, span)
        return { kind: 'lambda', param: x, body, span }
      }
    }
    return null
  }

  // Build the node an infix operator denotes — mirroring the Pratt loop, so a
  // section means exactly what the operator means inline: `|>` is reverse
  // application, everything else is an ordinary `binop`.
  private applyInfix(op: string, left: Expr, right: Expr, span: Span): Expr {
    if (op === '|>') return { kind: 'app', fn: right, arg: left, span }
    return { kind: 'binop', op: op as BinaryOp, left, right, span }
  }

  // comprehension qualifiers: a `,`-separated list of generators (`pat <- xs`),
  // `let pat = rhs` bindings and boolean guards (any expression).
  private parseQualifiers(): Qualifier[] {
    const quals: Qualifier[] = []
    for (;;) {
      if (this.at('keyword', 'let')) {
        // `let pat = rhs` — a binding scoped over the qualifiers to its right.
        this.next()
        const pat = this.parsePattern()
        this.expect('op', '=')
        const rhs = this.parseExpr(0)
        quals.push({ kind: 'let', pat, rhs })
      } else if (this.generatorAhead()) {
        // `pat <- src` — a generator. `pat` may be any pattern; refutable
        // patterns drop the elements that don't match.
        const pat = this.parsePattern()
        this.expect('op', '<-')
        const src = this.parseExpr(0)
        quals.push({ kind: 'gen', pat, src })
      } else {
        quals.push({ kind: 'guard', test: this.parseExpr(0) })
      }
      if (this.at('punc', ',')) {
        this.next()
        continue
      }
      break
    }
    return quals
  }

  // Is the next qualifier a generator? True iff a top-level `<-` appears before
  // the qualifier ends (a `,` at depth 0, or the closing `]`). Scanning at
  // bracket depth lets an arbitrary pattern precede the arrow without a parse
  // attempt — `(a, b) <- ps`, `Just x <- opts`, `h :: t <- rows` all qualify,
  // while a plain guard such as `a * a == c * c` has no depth-0 `<-` and falls
  // through to the guard branch.
  private generatorAhead(): boolean {
    let depth = 0
    for (let j = this.pos; j < this.toks.length; j++) {
      const t = this.toks[j]
      if (t.kind === 'eof') return false
      if (t.kind === 'punc') {
        if (t.value === '(' || t.value === '[' || t.value === '{') depth++
        else if (t.value === ')' || t.value === '}') depth--
        else if (t.value === ']') {
          if (depth === 0) return false
          depth--
        } else if (t.value === ',' && depth === 0) return false
      } else if (t.kind === 'op' && t.value === '<-' && depth === 0) {
        return true
      }
    }
    return false
  }

  // Desugar `[ e | q0, q1, … ]` into core AST using `concat`, `map`, `if`, `let`
  // and (for refutable patterns) `match`:
  //   [ e | ]              ⇒  [e]
  //   [ e | b, Q ]         ⇒  if b then [ e | Q ] else []
  //   [ e | let p = r, Q ] ⇒  let p = r in [ e | Q ]            (via `match` if p isn't a name)
  //   [ e | x <- xs, Q ]   ⇒  concat (map (fn x -> [ e | Q ]) xs)
  //   [ e | p <- xs, Q ]   ⇒  concat (map (fn v -> match v with p -> [e|Q] | _ -> []) xs)
  private desugarComprehension(
    elem: Expr,
    quals: Qualifier[],
    i: number,
    span: Span,
  ): Expr {
    if (i >= quals.length) {
      return { kind: 'list', elements: [elem], span: elem.span }
    }
    const q = quals[i]
    const rest = this.desugarComprehension(elem, quals, i + 1, span)
    if (q.kind === 'guard') {
      const empty: Expr = { kind: 'list', elements: [], span }
      return { kind: 'if', cond: q.test, then: rest, else: empty, span }
    }
    if (q.kind === 'let') {
      // an irrefutable `let`: bind a name directly, or destructure via a
      // single-arm `match` (products stay exhaustive, so no spurious warning).
      if (q.pat.kind === 'pvar') {
        return { kind: 'let', name: q.pat.name, value: q.rhs, body: rest, recursive: false, span }
      }
      return {
        kind: 'match',
        scrutinee: q.rhs,
        cases: [{ pattern: q.pat, body: rest }],
        span,
      }
    }
    // a generator. A plain-name (or wildcard) pattern is irrefutable, so we can
    // map a bare lambda over the source; any other pattern needs a `match` whose
    // wildcard arm drops the elements that don't fit.
    const lambda = this.generatorLambda(q.pat, rest, span)
    const mapVar: Expr = { kind: 'var', name: 'map', span }
    const concatVar: Expr = { kind: 'var', name: 'concat', span }
    const mapped: Expr = {
      kind: 'app',
      fn: { kind: 'app', fn: mapVar, arg: lambda, span },
      arg: q.src,
      span,
    }
    return { kind: 'app', fn: concatVar, arg: mapped, span }
  }

  // Build the per-element lambda for a generator over pattern `pat` producing
  // `rest` (already the [e|Q] tail). Irrefutable binders skip the `match`.
  private generatorLambda(pat: Pattern, rest: Expr, span: Span): Expr {
    if (pat.kind === 'pvar') {
      return { kind: 'lambda', param: pat.name, body: rest, span }
    }
    if (pat.kind === 'pwild') {
      return { kind: 'lambda', param: this.freshName(), body: rest, span }
    }
    const v = this.freshName()
    const empty: Expr = { kind: 'list', elements: [], span }
    const body: Expr = {
      kind: 'match',
      scrutinee: { kind: 'var', name: v, span },
      cases: [
        { pattern: pat, body: rest },
        { pattern: { kind: 'pwild', span }, body: empty },
      ],
      span,
    }
    return { kind: 'lambda', param: v, body, span }
  }

  private parseLambda(): Expr {
    const start = this.expect('keyword', 'fn')
    // each parameter is either a plain name or a destructuring pattern (a `(`/`{`/
    // `[`-headed atom); a pattern param desugars to a fresh name whose lambda body
    // opens with `match <fresh> with <pattern> -> …`.
    const params: { name: string; pat?: Pattern }[] = []
    for (;;) {
      if (this.at('ident')) {
        params.push({ name: this.next().value })
      } else if (this.startsPatternBinder()) {
        const pat = this.parsePatternArg()
        params.push({ name: this.freshName(), pat })
      } else {
        break
      }
    }
    if (params.length === 0) {
      throw new ParseError('fn needs at least one parameter', this.peek().span)
    }
    this.expect('op', '->')
    const body = this.parseExpr(0)
    const span = this.spanFrom(start.span, body.span)
    // curry right-to-left into nested single-parameter lambdas
    let acc: Expr = body
    for (let k = params.length - 1; k >= 0; k--) {
      const p = params[k]
      if (p.pat) {
        acc = {
          kind: 'match',
          scrutinee: { kind: 'var', name: p.name, span },
          cases: [{ pattern: p.pat, body: acc }],
          span,
        }
      }
      acc = { kind: 'lambda', param: p.name, body: acc, span }
    }
    return acc
  }

  // Monadic do-notation. `do { p <- e ; … ; r }` is a pure desugaring into the
  // overloaded `bind` method (resolved through the type-class machinery), so no
  // inference/compiler/VM/JS-backend changes are needed:
  //   do { x <- e ; rest }  ⇒  bind e (fn x  -> <rest>)
  //   do { e ; rest }       ⇒  bind e (fn _  -> <rest>)
  //   do { e }              ⇒  e
  private parseDo(): Expr {
    const start = this.expect('keyword', 'do')
    this.expect('punc', '{')
    const stmts: { name: string | null; expr: Expr; span: Span }[] = []
    while (!this.at('punc', '}')) {
      const sStart = this.peek().span
      let name: string | null = null
      const t = this.peek()
      const ahead = this.toks[this.pos + 1]
      if (t.kind === 'ident' && ahead && ahead.kind === 'op' && ahead.value === '<-') {
        name = this.next().value
        this.next() // '<-'
      }
      const expr = this.parseExpr(1) // bp 1 stops at the ';' separator
      stmts.push({ name, expr, span: this.spanFrom(sStart, expr.span) })
      if (this.at('punc', ';')) {
        this.next()
      } else {
        break
      }
    }
    const close = this.expect('punc', '}')
    if (stmts.length === 0) {
      throw new ParseError('an empty do block has no value', start.span)
    }
    const last = stmts[stmts.length - 1]
    if (last.name !== null) {
      throw new ParseError('the last statement of a do block must be an expression', last.span)
    }
    let acc = last.expr
    for (let i = stmts.length - 2; i >= 0; i--) {
      const s = stmts[i]
      const span = this.spanFrom(s.span, close.span)
      const lam: Expr = { kind: 'lambda', param: s.name ?? '_', body: acc, span }
      const bindVar: Expr = { kind: 'var', name: 'bind', span: s.span }
      const applied: Expr = { kind: 'app', fn: bindVar, arg: s.expr, span }
      acc = { kind: 'app', fn: applied, arg: lam, span }
    }
    return acc
  }

  // one binding: `name params = value` (params desugar to curried lambdas)
  private parseBinding(): { name: string; value: Expr; sig?: TypeExpr } {
    if (!this.at('ident')) {
      throw new ParseError('expected a name', this.peek().span)
    }
    const name = this.next().value
    const params: string[] = []
    while (this.at('ident')) {
      params.push(this.next().value)
    }
    // optional type signature `let f : T = …`. The signature is the full type of
    // the binding name; it is not allowed together with sugar parameters (write
    // the lambda explicitly so the annotation and the value line up).
    let sig: TypeExpr | undefined
    if (this.at('op', ':')) {
      if (params.length > 0) {
        throw new ParseError(
          'a type signature `let f : T = …` cannot be combined with parameters; ' +
            'write the value as an explicit `fn` instead',
          this.peek().span,
        )
      }
      this.next()
      sig = this.parseTypeExpr()
    }
    this.expect('op', '=')
    let value = this.parseExpr(0)
    for (let k = params.length - 1; k >= 0; k--) {
      value = { kind: 'lambda', param: params[k], body: value, span: value.span }
    }
    return { name, value, sig }
  }

  private parseLet(): Expr {
    const start = this.expect('keyword', 'let')
    let recursive = false
    if (this.at('keyword', 'rec')) {
      this.next()
      recursive = true
    }
    // pattern-binding: `let (a, b) = e in body` / `let { x, y } = e in body`
    // desugars to a one-arm `match` (refutable shapes like `[a, b]` are allowed
    // but flagged non-exhaustive, exactly as a match would be).
    if (!recursive && this.startsPatternBinder()) {
      const pattern = this.parsePattern()
      this.expect('op', '=')
      const value = this.parseExpr(0)
      this.expect('keyword', 'in')
      const body = this.parseExpr(0)
      return {
        kind: 'match',
        scrutinee: value,
        cases: [{ pattern, body }],
        span: this.spanFrom(start.span, body.span),
      }
    }
    const first = this.parseBinding()
    // `let rec f = … and g = … in …` — a mutually recursive group
    if (recursive && this.at('keyword', 'and')) {
      const bindings = [first]
      while (this.at('keyword', 'and')) {
        this.next()
        bindings.push(this.parseBinding())
      }
      this.expect('keyword', 'in')
      const body = this.parseExpr(0)
      return { kind: 'letrec', bindings, body, span: this.spanFrom(start.span, body.span) }
    }
    this.expect('keyword', 'in')
    const body = this.parseExpr(0)
    return {
      kind: 'let',
      name: first.name,
      value: first.value,
      body,
      recursive,
      sig: first.sig,
      span: this.spanFrom(start.span, body.span),
    }
  }

  private parseMatch(): Expr {
    const start = this.expect('keyword', 'match')
    const scrutinee = this.parseExpr(0)
    this.expect('keyword', 'with')
    const cases: MatchCase[] = []
    // an optional leading '|' before the first case
    if (this.at('op', '|')) this.next()
    for (;;) {
      const pattern = this.parsePattern()
      let guard: Expr | undefined
      if (this.at('keyword', 'when')) {
        this.next()
        guard = this.parseExpr(0)
      }
      this.expect('op', '->')
      const body = this.parseExpr(0)
      cases.push({ pattern, guard, body })
      if (this.at('op', '|')) {
        this.next()
        continue
      }
      break
    }
    if (cases.length === 0) {
      throw new ParseError('match needs at least one case', start.span)
    }
    const last = cases[cases.length - 1].body
    return { kind: 'match', scrutinee, cases, span: this.spanFrom(start.span, last.span) }
  }

  // pattern grammar (loosest → tightest):
  //   or-pattern    p | p | …        (lowest; a disjunction of alternatives)
  //   as-pattern    p as x           (binds the whole matched value to x)
  //   cons-pattern  a :: p           (right-associative, the only infix form)
  //   atom          Con a…, {…}, (…), […], literal, var, _
  private parsePattern(): Pattern {
    const first = this.parseAsPattern()
    if (!this.at('op', '|')) return first
    const alternatives = [first]
    while (this.at('op', '|')) {
      this.next()
      alternatives.push(this.parseAsPattern())
    }
    const last = alternatives[alternatives.length - 1]
    return { kind: 'por', alternatives, span: this.spanFrom(first.span, last.span) }
  }

  private parseAsPattern(): Pattern {
    const inner = this.parseConsPattern()
    if (this.at('keyword', 'as')) {
      this.next()
      if (!this.at('ident') || isUpper(this.peek().value)) {
        throw new ParseError('expected a lowercase name after `as`', this.peek().span)
      }
      const nameTok = this.next()
      return { kind: 'pas', inner, name: nameTok.value, span: this.spanFrom(inner.span, nameTok.span) }
    }
    return inner
  }

  private parseConsPattern(): Pattern {
    const left = this.parsePatternAtom()
    if (this.at('op', '::')) {
      this.next()
      const tail = this.parseConsPattern()
      return { kind: 'pcons', head: left, tail, span: this.spanFrom(left.span, tail.span) }
    }
    return left
  }

  // an atom may be a constructor application `Some x` (uppercase head + args)
  private parsePatternAtom(): Pattern {
    const t = this.peek()
    if (t.kind === 'ident' && isUpper(t.value)) {
      this.next()
      const args: Pattern[] = []
      let end = t.span
      while (this.startsPatternArg()) {
        const arg = this.parsePatternArg()
        args.push(arg)
        end = arg.span
      }
      return { kind: 'pcon', name: t.value, args, span: this.spanFrom(t.span, end) }
    }
    return this.parsePatternArg()
  }

  private startsPatternArg(): boolean {
    const t = this.peek()
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'string' || t.kind === 'ident') return true
    if (t.kind === 'keyword' && (t.value === 'true' || t.value === 'false')) return true
    if (t.kind === 'punc' && (t.value === '(' || t.value === '[' || t.value === '{')) return true
    return false
  }

  // a single, atomic pattern (constructor arguments must be atomic — use parens)
  private parsePatternArg(): Pattern {
    const t = this.peek()
    switch (t.kind) {
      case 'int':
        this.next()
        return { kind: 'pint', value: parseInt(t.value, 10), span: t.span }
      case 'float':
        this.next()
        return { kind: 'pfloat', value: parseFloat(t.value), span: t.span }
      case 'string':
        this.next()
        return { kind: 'pstr', value: t.value, span: t.span }
      case 'ident':
        this.next()
        if (isUpper(t.value)) return { kind: 'pcon', name: t.value, args: [], span: t.span }
        return t.value === '_'
          ? { kind: 'pwild', span: t.span }
          : { kind: 'pvar', name: t.value, span: t.span }
      case 'keyword':
        if (t.value === 'true' || t.value === 'false') {
          this.next()
          return { kind: 'pbool', value: t.value === 'true', span: t.span }
        }
        throw new ParseError(`unexpected keyword ${JSON.stringify(t.value)} in pattern`, t.span)
      case 'punc':
        if (t.value === '(') return this.parsePatternParen()
        if (t.value === '[') return this.parsePatternList()
        if (t.value === '{') return this.parsePatternRecord()
        throw new ParseError(`unexpected ${JSON.stringify(t.value)} in pattern`, t.span)
      default:
        throw new ParseError(`unexpected ${JSON.stringify(t.value)} in pattern`, t.span)
    }
  }

  private parsePatternParen(): Pattern {
    const open = this.expect('punc', '(')
    if (this.at('punc', ')')) {
      const close = this.next()
      return { kind: 'punit', span: this.spanFrom(open.span, close.span) }
    }
    const first = this.parsePattern()
    if (this.at('punc', ',')) {
      const elements = [first]
      while (this.at('punc', ',')) {
        this.next()
        elements.push(this.parsePattern())
      }
      const close = this.expect('punc', ')')
      return { kind: 'ptuple', elements, span: this.spanFrom(open.span, close.span) }
    }
    this.expect('punc', ')')
    return first
  }

  // [a, b, c] desugars to a :: b :: c :: []
  private parsePatternList(): Pattern {
    const open = this.expect('punc', '[')
    const elements: Pattern[] = []
    if (!this.at('punc', ']')) {
      elements.push(this.parsePattern())
      while (this.at('punc', ',')) {
        this.next()
        elements.push(this.parsePattern())
      }
    }
    const close = this.expect('punc', ']')
    const span = this.spanFrom(open.span, close.span)
    let acc: Pattern = { kind: 'pnil', span }
    for (let i = elements.length - 1; i >= 0; i--) {
      acc = { kind: 'pcons', head: elements[i], tail: acc, span }
    }
    return acc
  }

  // record pattern `{ label = p, … }` with field punning `{ x }` ≡ `{ x = x }`.
  // Matching is by the listed fields only, so it destructures a record that may
  // carry further fields (the row stays open during inference).
  private parsePatternRecord(): Pattern {
    const open = this.expect('punc', '{')
    const fields: { label: string; pattern: Pattern }[] = []
    const seen = new Set<string>()
    if (!this.at('punc', '}')) {
      for (;;) {
        if (!this.at('ident') || isUpper(this.peek().value)) {
          throw new ParseError('expected a lowercase field label in the record pattern', this.peek().span)
        }
        const labelTok = this.next()
        if (seen.has(labelTok.value)) {
          throw new ParseError(`field ${labelTok.value} appears twice in the record pattern`, labelTok.span)
        }
        seen.add(labelTok.value)
        let pattern: Pattern
        if (this.at('op', '=')) {
          this.next()
          pattern = this.parsePattern()
        } else {
          // punning: `{ x }` binds field `x` to a variable named `x`
          pattern = { kind: 'pvar', name: labelTok.value, span: labelTok.span }
        }
        fields.push({ label: labelTok.value, pattern })
        if (this.at('punc', ',')) {
          this.next()
          continue
        }
        break
      }
    }
    const close = this.expect('punc', '}')
    if (fields.length === 0) {
      throw new ParseError('an empty record pattern `{}` matches nothing useful — use `_`', this.spanFrom(open.span, close.span))
    }
    return { kind: 'precord', fields, span: this.spanFrom(open.span, close.span) }
  }

  // type Name p1 p2 = C1 t.. | C2 t.. in body
  private parseTypeDecl(): Expr {
    const start = this.expect('keyword', 'type')
    if (!this.at('ident') || !isUpper(this.peek().value)) {
      throw new ParseError('expected an uppercase type name after `type`', this.peek().span)
    }
    const name = this.next().value
    const params: string[] = []
    while (this.at('ident') && !isUpper(this.peek().value)) {
      params.push(this.next().value)
    }
    // empty / phantom type: `type Zero in …` declares a type with no
    // constructors (handy as a type-level index for GADTs).
    if (this.at('keyword', 'in')) {
      this.next()
      const body = this.parseExpr(0)
      return { kind: 'typedecl', name, params, ctors: [], body, span: this.spanFrom(start.span, body.span) }
    }
    // GADT form: `type T a where | K : t1 -> … -> T … | … `. Each constructor
    // carries a full type signature whose result may fix the datatype's indices
    // (e.g. `IntLit : Int -> Expr Int`), so different constructors can return
    // different indices of the same type.
    if (this.at('keyword', 'where')) {
      this.next()
      const ctors = this.parseGadtCtors(name, params)
      this.expect('keyword', 'in')
      const body = this.parseExpr(0)
      return { kind: 'typedecl', name, params, ctors, body, span: this.spanFrom(start.span, body.span) }
    }
    this.expect('op', '=')
    const ctors: CtorDecl[] = []
    if (this.at('op', '|')) this.next()
    for (;;) {
      if (!this.at('ident') || !isUpper(this.peek().value)) {
        throw new ParseError('expected an uppercase constructor name', this.peek().span)
      }
      const ctorTok = this.next()
      const args: TypeExpr[] = []
      let end = ctorTok.span
      while (this.startsTypeAtom()) {
        const a = this.parseTypeAtom()
        args.push(a)
        end = a.span
      }
      ctors.push({ name: ctorTok.value, args, span: this.spanFrom(ctorTok.span, end) })
      if (this.at('op', '|')) {
        this.next()
        continue
      }
      break
    }
    // optional `deriving (C1, C2, …)` clause — desugared into synthesised instances
    const derived = this.parseDerivingClause()
    this.expect('keyword', 'in')
    let body = this.parseExpr(0)
    if (derived.length > 0) {
      const tdSpan = this.spanFrom(start.span, body.span)
      body = deriveInstances(name, params, ctors, derived, tdSpan, body)
    }
    return { kind: 'typedecl', name, params, ctors, body, span: this.spanFrom(start.span, body.span) }
  }

  // Parse the constructor signatures of a GADT (`where` form). Each is
  // `Name : t1 -> … -> tn -> Result`, which we split into argument types plus an
  // explicit `result`. The result's head constructor must be the datatype being
  // declared. Constructors are separated by `|` (a leading `|` is optional).
  private parseGadtCtors(typeName: string, params: string[]): CtorDecl[] {
    const ctors: CtorDecl[] = []
    if (this.at('op', '|')) this.next()
    for (;;) {
      if (!this.at('ident') || !isUpper(this.peek().value)) {
        throw new ParseError('expected an uppercase constructor name', this.peek().span)
      }
      const ctorTok = this.next()
      this.expect('op', ':')
      const sig = this.parseTypeExpr()
      // split the arrow chain into arguments + final result type
      const args: TypeExpr[] = []
      let cur: TypeExpr = sig
      while (cur.kind === 'tarrow') {
        args.push(cur.from)
        cur = cur.to
      }
      const result = cur
      const resultHead = result.kind === 'tcon' ? result.name : null
      if (resultHead !== typeName) {
        throw new ParseError(
          `constructor ${ctorTok.value} must return ${typeName}, but its signature returns ` +
            `a different type`,
          result.span,
        )
      }
      void params
      ctors.push({
        name: ctorTok.value,
        args,
        result,
        span: this.spanFrom(ctorTok.span, result.span),
      })
      if (this.at('op', '|')) {
        this.next()
        continue
      }
      break
    }
    return ctors
  }

  // optional `deriving (C1, C2, …)` after a type's constructors. Returns [] when
  // absent. Each class must be one Aether knows how to derive, with no repeats.
  private parseDerivingClause(): { cls: string; span: Span }[] {
    if (!this.at('keyword', 'deriving')) return []
    this.next()
    this.expect('punc', '(')
    const out: { cls: string; span: Span }[] = []
    const seen = new Set<string>()
    for (;;) {
      if (!this.at('ident') || !isUpper(this.peek().value)) {
        throw new ParseError('expected a class name inside `deriving (…)`', this.peek().span)
      }
      const tok = this.next()
      if (!isDerivable(tok.value)) {
        throw new ParseError(
          `cannot derive '${tok.value}'; derivable classes are ${DERIVABLE.join(', ')}`,
          tok.span,
        )
      }
      if (seen.has(tok.value)) {
        throw new ParseError(`duplicate class '${tok.value}' in deriving clause`, tok.span)
      }
      seen.add(tok.value)
      out.push({ cls: tok.value, span: tok.span })
      if (this.at('punc', ',')) {
        this.next()
        continue
      }
      break
    }
    this.expect('punc', ')')
    if (out.length === 0) {
      throw new ParseError('`deriving (…)` needs at least one class', this.peek().span)
    }
    return out
  }

  // class [Super p, … =>] Name a where m1 : τ ; m2 : τ ; … in body
  private parseClassDecl(): Expr {
    const start = this.expect('keyword', 'class')
    // an optional superclass context: `class Functor f => Monad f where …`
    const context = this.tryParseInstanceContext()
    if (!this.at('ident') || !isUpper(this.peek().value)) {
      throw new ParseError('expected an uppercase class name after `class`', this.peek().span)
    }
    const name = this.next().value
    if (!this.at('ident') || isUpper(this.peek().value)) {
      throw new ParseError('expected a lowercase class parameter (e.g. `class Disp a`)', this.peek().span)
    }
    const param = this.next().value
    const supers: string[] = []
    for (const c of context) {
      if (c.param !== param) {
        throw new ParseError(
          `superclass constraint '${c.cls} ${c.param}' must constrain the class parameter '${param}'`,
          c.span,
        )
      }
      supers.push(c.cls)
    }
    this.expect('keyword', 'where')
    const methods: MethodSig[] = []
    while (!this.at('keyword', 'in')) {
      if (!this.at('ident') || isUpper(this.peek().value)) {
        throw new ParseError('expected a lowercase method name', this.peek().span)
      }
      const mtok = this.next()
      this.expect('op', ':')
      const type = this.parseTypeExpr()
      // an optional default implementation: `m : τ = <expr>`
      let dflt: Expr | undefined
      let end = type.span
      if (this.at('op', '=')) {
        this.next()
        dflt = this.parseExpr(0)
        end = dflt.span
      }
      methods.push({ name: mtok.value, type, default: dflt, span: this.spanFrom(mtok.span, end) })
      if (this.at('punc', ',')) this.next()
      else break
    }
    if (methods.length === 0) {
      throw new ParseError('a class needs at least one method signature', start.span)
    }
    this.expect('keyword', 'in')
    const body = this.parseExpr(0)
    return { kind: 'classdecl', name, param, supers, methods, body, span: this.spanFrom(start.span, body.span) }
  }

  // instance [Ctx =>] Cls Head where m1 = e1 ; … in body
  private parseInstanceDecl(): Expr {
    const start = this.expect('keyword', 'instance')
    const context = this.tryParseInstanceContext()
    if (!this.at('ident') || !isUpper(this.peek().value)) {
      throw new ParseError('expected a class name in the instance head', this.peek().span)
    }
    const cls = this.next().value
    const head = this.parseTypeApp()
    this.expect('keyword', 'where')
    const methods: MethodImpl[] = []
    while (!this.at('keyword', 'in')) {
      if (!this.at('ident') || isUpper(this.peek().value)) {
        throw new ParseError('expected a lowercase method name', this.peek().span)
      }
      const mtok = this.next()
      const params: string[] = []
      while (this.at('ident')) params.push(this.next().value)
      this.expect('op', '=')
      // methods are `,`-separated; `,` is never infix, so a method body parses
      // greedily and stops cleanly at the next method (or `in`)
      let value = this.parseExpr(0)
      for (let k = params.length - 1; k >= 0; k--) {
        value = { kind: 'lambda', param: params[k], body: value, span: value.span }
      }
      methods.push({ name: mtok.value, value, span: this.spanFrom(mtok.span, value.span) })
      if (this.at('punc', ',')) this.next()
      else break
    }
    this.expect('keyword', 'in')
    const body = this.parseExpr(0)
    return {
      kind: 'instancedecl',
      cls,
      head,
      context,
      methods,
      body,
      span: this.spanFrom(start.span, body.span),
    }
  }

  // Optional `C a, D b =>` (or `(C a, D b) =>`) prefix on an instance. Restores
  // and returns [] if what follows is the instance head itself, not a context.
  private tryParseInstanceContext(): ConstraintExpr[] {
    const save = this.pos
    const ctx: ConstraintExpr[] = []
    const paren = this.at('punc', '(')
    if (paren) this.next()
    for (;;) {
      if (!this.at('ident') || !isUpper(this.peek().value)) {
        this.pos = save
        return []
      }
      const clsTok = this.next()
      if (!this.at('ident') || isUpper(this.peek().value)) {
        this.pos = save
        return []
      }
      const paramTok = this.next()
      ctx.push({ cls: clsTok.value, param: paramTok.value, span: this.spanFrom(clsTok.span, paramTok.span) })
      if (this.at('punc', ',')) {
        this.next()
        continue
      }
      break
    }
    if (paren) {
      if (!this.at('punc', ')')) {
        this.pos = save
        return []
      }
      this.next()
    }
    if (this.at('op', '=>')) {
      this.next()
      return ctx
    }
    this.pos = save
    return []
  }

  private startsTypeAtom(): boolean {
    const t = this.peek()
    if (t.kind === 'ident') return true
    if (t.kind === 'punc' && (t.value === '(' || t.value === '[')) return true
    return false
  }

  private parseTypeAtom(): TypeExpr {
    const t = this.peek()
    if (t.kind === 'ident') {
      this.next()
      return isUpper(t.value)
        ? { kind: 'tcon', name: t.value, args: [], span: t.span }
        : { kind: 'tvar', name: t.value, span: t.span }
    }
    if (t.kind === 'punc' && t.value === '(') return this.parseTypeParen()
    if (t.kind === 'punc' && t.value === '[') {
      const open = this.next()
      const inner = this.parseTypeExpr()
      const close = this.expect('punc', ']')
      return { kind: 'tcon', name: 'List', args: [inner], span: this.spanFrom(open.span, close.span) }
    }
    throw new ParseError(`expected a type, found ${JSON.stringify(t.value)}`, t.span)
  }

  private parseTypeParen(): TypeExpr {
    const open = this.expect('punc', '(')
    if (this.at('punc', ')')) {
      const close = this.next()
      return { kind: 'tcon', name: 'Unit', args: [], span: this.spanFrom(open.span, close.span) }
    }
    const first = this.parseTypeExpr()
    if (this.at('punc', ',')) {
      const elements = [first]
      while (this.at('punc', ',')) {
        this.next()
        elements.push(this.parseTypeExpr())
      }
      const close = this.expect('punc', ')')
      return { kind: 'ttuple', elements, span: this.spanFrom(open.span, close.span) }
    }
    this.expect('punc', ')')
    return first
  }

  // full type expression (only valid inside parens / list / arrows)
  private parseTypeExpr(): TypeExpr {
    const left = this.parseTypeApp()
    if (this.at('op', '->')) {
      this.next()
      const to = this.parseTypeExpr()
      return { kind: 'tarrow', from: left, to, span: this.spanFrom(left.span, to.span) }
    }
    return left
  }

  private parseTypeApp(): TypeExpr {
    const head = this.parseTypeAtom()
    const extra: TypeExpr[] = []
    while (this.startsTypeAtom()) extra.push(this.parseTypeAtom())
    if (extra.length === 0) return head
    // a constructor head absorbs its arguments directly (`List a`, `Either a b`)
    if (head.kind === 'tcon') {
      const args = [...head.args, ...extra]
      return { kind: 'tcon', name: head.name, args, span: this.spanFrom(head.span, extra[extra.length - 1].span) }
    }
    // a variable- (or otherwise non-constructor-) headed application is built as
    // a left-associative `tapp` spine: `m a b` ⇒ ((m a) b). This is what lets a
    // method signature mention `m a` for a higher-kinded class parameter `m`.
    let acc = head
    for (const a of extra) acc = { kind: 'tapp', fn: acc, arg: a, span: this.spanFrom(head.span, a.span) }
    return acc
  }

  private parseIf(): Expr {
    const start = this.expect('keyword', 'if')
    const cond = this.parseExpr(0)
    this.expect('keyword', 'then')
    const thenE = this.parseExpr(0)
    this.expect('keyword', 'else')
    const elseE = this.parseExpr(0)
    return { kind: 'if', cond, then: thenE, else: elseE, span: this.spanFrom(start.span, elseE.span) }
  }
}

function isUpper(name: string): boolean {
  return /^[A-Z]/.test(name)
}

export function parse(src: string): Expr {
  const toks = tokenize(src)
  return new Parser(toks).parseProgram()
}

export function parseTokens(toks: Token[]): Expr {
  return new Parser(toks).parseProgram()
}
