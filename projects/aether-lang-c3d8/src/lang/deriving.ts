// Aether — `deriving`
//
// A `type` declaration may carry a `deriving (C1, C2, …)` clause. Rather than
// teach inference, the compiler or either backend anything new, `deriving`
// **desugars at parse time** into ordinary `instance` declarations nested in the
// type's body — exactly the shape a user would write by hand. So the synthesised
// instances are type-checked, kind-checked, context-inferred and elaborated to
// dictionaries by the existing machinery, and the bytecode VM and the JavaScript
// backend run them like any other code: a derived instance is indistinguishable
// from a hand-written one.
//
// The generator builds each method body as real surface AST (`match`, string
// concat, comparisons, recursive class-method calls). Leaf/structural recursion
// goes *through the class method* (e.g. derived `eq` calls `eq` on each field),
// so the instance's context — `(Eq a, Eq b) =>` — is whatever inference deduces,
// and recursive data types resolve through their own (self-referential) instance.

import type { ConstraintExpr, CtorDecl, Expr, MatchCase, MethodImpl, Pattern, TypeExpr } from './ast.ts'
import type { Span } from './lexer.ts'
import { ParseError } from './parser.ts'

/** The classes `deriving` knows how to synthesise. */
export const DERIVABLE = ['Eq', 'Ord', 'Show', 'Enum', 'Bounded', 'Functor', 'Foldable'] as const
export type Derivable = (typeof DERIVABLE)[number]

export function isDerivable(name: string): name is Derivable {
  return (DERIVABLE as readonly string[]).includes(name)
}

interface InstanceSpec {
  cls: string
  head: TypeExpr
  context: ConstraintExpr[]
  methods: MethodImpl[]
}

/**
 * Wrap `body` in a chain of synthesised `instance` declarations, one per class in
 * `clauses`, for the data type `typeName params = ctors`. The first-listed class
 * becomes the outermost instance; all are in scope for `body`.
 */
export function deriveInstances(
  typeName: string,
  params: string[],
  ctors: CtorDecl[],
  clauses: { cls: string; span: Span }[],
  sp: Span,
  body: Expr,
): Expr {
  const g = new Generator(typeName, params, ctors, sp)
  const specs = clauses.map((c) => g.build(c.cls, c.span))
  let acc = body
  for (let i = specs.length - 1; i >= 0; i--) {
    const s = specs[i]
    acc = {
      kind: 'instancedecl',
      cls: s.cls,
      head: s.head,
      context: s.context,
      methods: s.methods,
      derived: true,
      body: acc,
      span: sp,
    }
  }
  return acc
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

class Generator {
  private readonly typeName: string
  private readonly params: string[]
  private readonly ctors: CtorDecl[]
  private readonly sp: Span
  private fresh = 0

  constructor(typeName: string, params: string[], ctors: CtorDecl[], sp: Span) {
    this.typeName = typeName
    this.params = params
    this.ctors = ctors
    this.sp = sp
  }

  build(cls: string, span: Span): InstanceSpec {
    switch (cls) {
      case 'Eq':
        return this.simple('Eq', [{ name: 'eq', value: this.eqBody() }])
      case 'Ord':
        return this.simple('Ord', [{ name: 'compare', value: this.compareBody() }])
      case 'Show':
        return this.simple('Show', [{ name: 'show', value: this.showBody() }])
      case 'Enum':
        return this.enumInstance()
      case 'Bounded':
        return this.boundedInstance()
      case 'Functor':
        return this.functorInstance()
      case 'Foldable':
        return this.foldableInstance()
      default:
        throw new ParseError(
          `cannot derive '${cls}'; derivable classes are ${DERIVABLE.join(', ')}`,
          span,
        )
    }
  }

  // ---- node builders (all stamped with the type declaration's span) ----
  private v(name: string): Expr {
    return { kind: 'var', name, span: this.sp }
  }
  private str(value: string): Expr {
    return { kind: 'str', value, span: this.sp }
  }
  private int(value: number): Expr {
    return { kind: 'int', value, span: this.sp }
  }
  private apply(fn: Expr, ...args: Expr[]): Expr {
    return args.reduce<Expr>((f, a) => ({ kind: 'app', fn: f, arg: a, span: this.sp }), fn)
  }
  private lam(ps: string[], bodyE: Expr): Expr {
    return ps.reduceRight<Expr>((b, p) => ({ kind: 'lambda', param: p, body: b, span: this.sp }), bodyE)
  }
  private match(scrutinee: Expr, cases: MatchCase[]): Expr {
    return { kind: 'match', scrutinee, cases, span: this.sp }
  }
  private tuple(elements: Expr[]): Expr {
    return { kind: 'tuple', elements, span: this.sp }
  }
  private ifE(cond: Expr, then: Expr, els: Expr): Expr {
    return { kind: 'if', cond, then, else: els, span: this.sp }
  }
  private letE(name: string, value: Expr, bodyE: Expr): Expr {
    return { kind: 'let', name, value, recursive: false, body: bodyE, span: this.sp }
  }
  private pvar(name: string): Pattern {
    return { kind: 'pvar', name, span: this.sp }
  }
  private pwild(): Pattern {
    return { kind: 'pwild', span: this.sp }
  }
  private pint(value: number): Pattern {
    return { kind: 'pint', value, span: this.sp }
  }
  private pcon(name: string, args: Pattern[]): Pattern {
    return { kind: 'pcon', name, args, span: this.sp }
  }
  private ptuple(elements: Pattern[]): Pattern {
    return { kind: 'ptuple', elements, span: this.sp }
  }
  private tvar(name: string): TypeExpr {
    return { kind: 'tvar', name, span: this.sp }
  }

  /** The fully-applied head `T a b …` (all parameters as variables). */
  private fullHead(): TypeExpr {
    return { kind: 'tcon', name: this.typeName, args: this.params.map((p) => this.tvar(p)), span: this.sp }
  }

  /** Which parameters appear in some field — the ones the context must constrain. */
  private usedParams(): string[] {
    return this.params.filter((p) => this.ctors.some((c) => c.args.some((a) => mentions(a, p))))
  }

  /** An instance whose head is the fully-applied type and whose context is
   * `cls p` for every parameter used in a field (`(Eq a, Eq b) => Eq (Pair a b)`). */
  private simple(cls: string, methods: { name: string; value: Expr }[]): InstanceSpec {
    const context: ConstraintExpr[] = this.usedParams().map((p) => ({ cls, param: p, span: this.sp }))
    return {
      cls,
      head: this.fullHead(),
      context,
      methods: methods.map((m) => ({ ...m, span: this.sp })),
    }
  }

  // ---- Eq: structural equality through the class method ----
  private eqBody(): Expr {
    const cases: MatchCase[] = this.ctors.map((c) => {
      const k = c.args.length
      const xs = range(k).map((i) => `x${i}`)
      const ys = range(k).map((i) => `y${i}`)
      const pattern = this.ptuple([
        this.pcon(c.name, xs.map((n) => this.pvar(n))),
        this.pcon(c.name, ys.map((n) => this.pvar(n))),
      ])
      const body =
        k === 0
          ? ({ kind: 'bool', value: true, span: this.sp } as Expr)
          : range(k)
              .map((i) => this.apply(this.v('eq'), this.v(xs[i]), this.v(ys[i])))
              .reduce((acc, e) => ({ kind: 'binop', op: '&&', left: acc, right: e, span: this.sp }))
      return { pattern, body }
    })
    // distinct constructors are unequal — only needed (and only non-redundant)
    // when there is more than one constructor
    if (this.ctors.length > 1) {
      cases.push({ pattern: this.pwild(), body: { kind: 'bool', value: false, span: this.sp } })
    }
    return this.lam(['lhs', 'rhs'], this.match(this.tuple([this.v('lhs'), this.v('rhs')]), cases))
  }

  // ---- Ord: compare : a -> a -> Int  (-1 / 0 / 1) ----
  private compareBody(): Expr {
    const cases: MatchCase[] = this.ctors.map((c) => {
      const k = c.args.length
      const xs = range(k).map((i) => `x${i}`)
      const ys = range(k).map((i) => `y${i}`)
      const pattern = this.ptuple([
        this.pcon(c.name, xs.map((n) => this.pvar(n))),
        this.pcon(c.name, ys.map((n) => this.pvar(n))),
      ])
      let body: Expr
      if (k === 0) {
        body = this.int(0)
      } else {
        // c0 = compare x0 y0; if c0 == 0 then (c1 = …; …) else c0
        body = range(k).reduceRight<Expr>((rest, i) => {
          const cmp = this.apply(this.v('compare'), this.v(xs[i]), this.v(ys[i]))
          if (i === k - 1) return cmp
          const cn = `c${i}`
          return this.letE(
            cn,
            cmp,
            this.ifE({ kind: 'binop', op: '==', left: this.v(cn), right: this.int(0), span: this.sp }, rest, this.v(cn)),
          )
        }, this.int(0))
      }
      return { pattern, body }
    })
    if (this.ctors.length > 1) {
      // different constructors compare by declaration order (their tag index)
      const tagCases: MatchCase[] = this.ctors.map((c, idx) => ({
        pattern: this.pcon(c.name, c.args.map(() => this.pwild())),
        body: this.int(idx),
      }))
      const tagOf = this.lam(['z'], this.match(this.v('z'), tagCases))
      const cross = this.letE(
        'tagOf',
        tagOf,
        this.ifE(
          {
            kind: 'binop',
            op: '<',
            left: this.apply(this.v('tagOf'), this.v('lhs')),
            right: this.apply(this.v('tagOf'), this.v('rhs')),
            span: this.sp,
          },
          this.int(-1),
          this.int(1),
        ),
      )
      cases.push({ pattern: this.pwild(), body: cross })
    }
    return this.lam(['lhs', 'rhs'], this.match(this.tuple([this.v('lhs'), this.v('rhs')]), cases))
  }

  // ---- Show: Haskell-style `(Ctor f1 f2 …)` ----
  private showBody(): Expr {
    const cat = (l: Expr, r: Expr): Expr => ({ kind: 'binop', op: '^', left: l, right: r, span: this.sp })
    const cases: MatchCase[] = this.ctors.map((c) => {
      const k = c.args.length
      const xs = range(k).map((i) => `x${i}`)
      const pattern = this.pcon(c.name, xs.map((n) => this.pvar(n)))
      let body: Expr
      if (k === 0) {
        body = this.str(c.name)
      } else {
        let acc: Expr = this.str('(' + c.name)
        for (const x of xs) acc = cat(cat(acc, this.str(' ')), this.apply(this.v('show'), this.v(x)))
        body = cat(acc, this.str(')'))
      }
      return { pattern, body }
    })
    return this.lam(['val'], this.match(this.v('val'), cases))
  }

  // ---- Enum / Bounded: C-style enumerations only ----
  private requireNullary(cls: string): void {
    if (this.ctors.some((c) => c.args.length > 0)) {
      throw new ParseError(
        `deriving ${cls}: '${this.typeName}' has constructors with fields — ${cls} is only derivable for an enumeration (all-nullary constructors)`,
        this.sp,
      )
    }
  }

  private enumInstance(): InstanceSpec {
    this.requireNullary('Enum')
    const fromCases: MatchCase[] = this.ctors.map((c, idx) => ({
      pattern: this.pcon(c.name, []),
      body: this.int(idx),
    }))
    const toCases: MatchCase[] = this.ctors.map((c, idx) => ({
      pattern: this.pint(idx),
      body: this.v(c.name),
    }))
    // out-of-range indices fall back to the first constructor (keeps toEnum total)
    toCases.push({ pattern: this.pwild(), body: this.v(this.ctors[0].name) })
    return {
      cls: 'Enum',
      head: this.fullHead(),
      context: [],
      methods: [
        { name: 'fromEnum', value: this.lam(['val'], this.match(this.v('val'), fromCases)), span: this.sp },
        { name: 'toEnum', value: this.lam(['i'], this.match(this.v('i'), toCases)), span: this.sp },
      ],
    }
  }

  private boundedInstance(): InstanceSpec {
    this.requireNullary('Bounded')
    return {
      cls: 'Bounded',
      head: this.fullHead(),
      context: [],
      methods: [
        { name: 'minBound', value: this.v(this.ctors[0].name), span: this.sp },
        { name: 'maxBound', value: this.v(this.ctors[this.ctors.length - 1].name), span: this.sp },
      ],
    }
  }

  // ---- Functor: fmap over the last type parameter ----
  private functorInstance(): InstanceSpec {
    if (this.params.length === 0) {
      throw new ParseError(
        `deriving Functor: '${this.typeName}' has no type parameter to map over`,
        this.sp,
      )
    }
    const last = this.params[this.params.length - 1]
    const fixed = this.params.slice(0, -1)
    // head is the type applied to all-but-the-last parameter, so its kind is `* -> *`
    const head: TypeExpr = { kind: 'tcon', name: this.typeName, args: fixed.map((p) => this.tvar(p)), span: this.sp }
    const cases: MatchCase[] = this.ctors.map((c) => {
      const k = c.args.length
      const xs = range(k).map((i) => `x${i}`)
      const pattern = this.pcon(c.name, xs.map((n) => this.pvar(n)))
      let body: Expr = this.v(c.name)
      c.args.forEach((argTy, i) => {
        body = this.apply(body, this.mapField(argTy, this.v(xs[i]), last, fixed))
      })
      return { pattern, body }
    })
    return {
      cls: 'Functor',
      head,
      context: [],
      methods: [{ name: 'fmap', value: this.lam(['g', 'val'], this.match(this.v('val'), cases)), span: this.sp }],
    }
  }

  /** Apply the mapping function `g` everywhere the functorial parameter `last`
   * occurs in a field of type `te`. Supports the textbook shapes; rejects the rest. */
  private mapField(te: TypeExpr, e: Expr, last: string, fixed: string[]): Expr {
    if (!mentions(te, last)) return e // parameter-free field: untouched
    if (te.kind === 'tvar' && te.name === last) return this.apply(this.v('g'), e)
    if (te.kind === 'tcon' && te.name === 'List' && te.args.length === 1) {
      // map the inner mapping over the list
      return this.apply(this.v('map'), this.lam(['it'], this.mapField(te.args[0], this.v('it'), last, fixed)), e)
    }
    if (te.kind === 'ttuple') {
      const ns = te.elements.map((_, i) => `t${i}`)
      const mapped = this.tuple(te.elements.map((el, i) => this.mapField(el, this.v(ns[i]), last, fixed)))
      return this.match(e, [{ pattern: this.ptuple(ns.map((n) => this.pvar(n))), body: mapped }])
    }
    if (te.kind === 'tcon' && te.name === this.typeName) {
      // a recursive occurrence `T <fixed…> last` maps via this very instance
      const args = te.args
      const lastArg = args[args.length - 1]
      const fixedOk =
        args.length === this.params.length &&
        lastArg.kind === 'tvar' &&
        lastArg.name === last &&
        args.slice(0, -1).every((a, i) => a.kind === 'tvar' && a.name === fixed[i])
      if (fixedOk) return this.apply(this.v('fmap'), this.v('g'), e)
    }
    throw new ParseError(
      `deriving Functor: '${this.typeName}' has a field whose type uses '${last}' in a shape that cannot be mapped automatically`,
      this.sp,
    )
  }

  // ---- Foldable: foldr over the last type parameter ----
  private foldableInstance(): InstanceSpec {
    if (this.params.length === 0) {
      throw new ParseError(
        `deriving Foldable: '${this.typeName}' has no type parameter to fold over`,
        this.sp,
      )
    }
    const last = this.params[this.params.length - 1]
    const fixed = this.params.slice(0, -1)
    const head: TypeExpr = { kind: 'tcon', name: this.typeName, args: fixed.map((p) => this.tvar(p)), span: this.sp }
    const cases: MatchCase[] = this.ctors.map((c) => {
      const k = c.args.length
      const xs = range(k).map((i) => `x${i}`)
      const pattern = this.pcon(c.name, xs.map((n) => this.pvar(n)))
      // fold the fields right-to-left into the seed `z` (standard DeriveFoldable
      // order: `foldr f (f x (foldr f z r)) l` for `Node l x r`)
      let acc: Expr = this.v('z')
      for (let i = k - 1; i >= 0; i--) acc = this.foldField(c.args[i], this.v(xs[i]), acc, last, fixed)
      return { pattern, body: acc }
    })
    return {
      cls: 'Foldable',
      head,
      context: [],
      methods: [
        { name: 'foldr', value: this.lam(['f', 'z', 'val'], this.match(this.v('val'), cases)), span: this.sp },
      ],
    }
  }

  /** Fold the occurrences of `last` inside a value `e` of field type `te` into
   * `acc`, returning the new accumulator (right fold). */
  private foldField(te: TypeExpr, e: Expr, acc: Expr, last: string, fixed: string[]): Expr {
    if (!mentions(te, last)) return acc // parameter-free field contributes nothing
    if (te.kind === 'tvar' && te.name === last) return this.apply(this.v('f'), e, acc)
    if (te.kind === 'tcon' && te.name === 'List' && te.args.length === 1) {
      // The inline list fold below cannot host a class-method recursion (a
      // recursive `foldr` call inside its own `let rec` is not supported by
      // inference). That only arises when the list's elements re-enter this very
      // type, so reject just that shape with a clear message.
      if (mentionsCon(te.args[0], this.typeName)) {
        throw new ParseError(
          `deriving Foldable: '${this.typeName}' nests itself inside a list — this shape is not supported; fold it by hand`,
          this.sp,
        )
      }
      // an inline right fold over the list — no `Foldable List` instance needed
      const go = `go${this.fresh++}`
      const ys = `ys${this.fresh++}`
      const a2 = `a${this.fresh++}`
      const step = this.foldField(
        te.args[0],
        this.apply(this.v('head'), this.v(ys)),
        this.apply(this.v(go), this.apply(this.v('tail'), this.v(ys)), this.v(a2)),
        last,
        fixed,
      )
      const goLam = this.lam(
        [ys, a2],
        this.ifE(this.apply(this.v('empty'), this.v(ys)), this.v(a2), step),
      )
      const goRec: Expr = {
        kind: 'letrec',
        bindings: [{ name: go, value: goLam }],
        body: this.v(go),
        span: this.sp,
      }
      return this.apply(goRec, e, acc)
    }
    if (te.kind === 'ttuple') {
      const ns = te.elements.map(() => `u${this.fresh++}`)
      let a: Expr = acc
      for (let i = te.elements.length - 1; i >= 0; i--) a = this.foldField(te.elements[i], this.v(ns[i]), a, last, fixed)
      return this.match(e, [{ pattern: this.ptuple(ns.map((n) => this.pvar(n))), body: a }])
    }
    if (te.kind === 'tcon' && te.name === this.typeName) {
      const args = te.args
      const lastArg = args[args.length - 1]
      const fixedOk =
        args.length === this.params.length &&
        lastArg.kind === 'tvar' &&
        lastArg.name === last &&
        args.slice(0, -1).every((a, i) => a.kind === 'tvar' && a.name === fixed[i])
      if (fixedOk) return this.apply(this.v('foldr'), this.v('f'), acc, e)
    }
    throw new ParseError(
      `deriving Foldable: '${this.typeName}' has a field whose type uses '${last}' in a shape that cannot be folded automatically`,
      this.sp,
    )
  }
}

/** Does the syntactic type `te` use the type constructor named `name`? */
function mentionsCon(te: TypeExpr, name: string): boolean {
  switch (te.kind) {
    case 'tvar':
      return false
    case 'tcon':
      return te.name === name || te.args.some((a) => mentionsCon(a, name))
    case 'tarrow':
      return mentionsCon(te.from, name) || mentionsCon(te.to, name)
    case 'ttuple':
      return te.elements.some((a) => mentionsCon(a, name))
    case 'tapp':
      return mentionsCon(te.fn, name) || mentionsCon(te.arg, name)
  }
}

/** Does the syntactic type `te` mention the type variable `name`? */
function mentions(te: TypeExpr, name: string): boolean {
  switch (te.kind) {
    case 'tvar':
      return te.name === name
    case 'tcon':
      return te.args.some((a) => mentions(a, name))
    case 'tarrow':
      return mentions(te.from, name) || mentions(te.to, name)
    case 'ttuple':
      return te.elements.some((a) => mentions(a, name))
    case 'tapp':
      return mentions(te.fn, name) || mentions(te.arg, name)
  }
}
