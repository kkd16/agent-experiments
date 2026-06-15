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

// A list-comprehension qualifier: a generator `name <- src` or a boolean guard.
type Qualifier =
  | { kind: 'gen'; name: string; src: Expr }
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

  constructor(toks: Token[]) {
    this.toks = toks
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
    // ordinary list literal
    const elements: Expr[] = [first]
    while (this.at('punc', ',')) {
      this.next()
      elements.push(this.parseExpr(0))
    }
    const close = this.expect('punc', ']')
    return { kind: 'list', elements, span: this.spanFrom(open.span, close.span) }
  }

  // comprehension qualifiers: a `,`-separated list of generators (`x <- xs`)
  // and boolean guards (any expression).
  private parseQualifiers(): Qualifier[] {
    const quals: Qualifier[] = []
    for (;;) {
      const t = this.peek()
      const ahead = this.toks[this.pos + 1]
      if (t.kind === 'ident' && ahead && ahead.kind === 'op' && ahead.value === '<-') {
        const name = this.next().value
        this.next() // '<-'
        const src = this.parseExpr(0)
        quals.push({ kind: 'gen', name, src })
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

  // Desugar `[ e | q0, q1, … ]` into core AST using `concat`, `map` and `if`:
  //   [ e | ]            ⇒  [e]
  //   [ e | b, Q ]       ⇒  if b then [ e | Q ] else []
  //   [ e | x <- xs, Q ] ⇒  concat (map (fn x -> [ e | Q ]) xs)
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
    const lambda: Expr = { kind: 'lambda', param: q.name, body: rest, span }
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

  private parseLambda(): Expr {
    const start = this.expect('keyword', 'fn')
    const params: string[] = []
    while (this.at('ident')) {
      params.push(this.next().value)
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
      acc = { kind: 'lambda', param: params[k], body: acc, span }
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
  private parseBinding(): { name: string; value: Expr } {
    if (!this.at('ident')) {
      throw new ParseError('expected a name', this.peek().span)
    }
    const name = this.next().value
    const params: string[] = []
    while (this.at('ident')) {
      params.push(this.next().value)
    }
    this.expect('op', '=')
    let value = this.parseExpr(0)
    for (let k = params.length - 1; k >= 0; k--) {
      value = { kind: 'lambda', param: params[k], body: value, span: value.span }
    }
    return { name, value }
  }

  private parseLet(): Expr {
    const start = this.expect('keyword', 'let')
    let recursive = false
    if (this.at('keyword', 'rec')) {
      this.next()
      recursive = true
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

  // pattern grammar: cons is right-associative and the only infix form
  private parsePattern(): Pattern {
    const left = this.parsePatternAtom()
    if (this.at('op', '::')) {
      this.next()
      const tail = this.parsePattern()
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
    if (t.kind === 'punc' && (t.value === '(' || t.value === '[')) return true
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
    this.expect('keyword', 'in')
    const body = this.parseExpr(0)
    return { kind: 'typedecl', name, params, ctors, body, span: this.spanFrom(start.span, body.span) }
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
