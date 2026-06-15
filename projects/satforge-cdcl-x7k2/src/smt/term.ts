// The SMT term/formula language with hash-consing (structural interning).
//
// Two layers:
//   • Term     — a sorted expression: a numeric literal, or an application of a
//                function symbol to argument terms (a 0-ary application is a
//                constant). Builtin arithmetic operators (+ - *) are applications
//                too, tagged `arith`. Every distinct term is interned once and
//                gets a stable integer id, so the EUF theory can reason about
//                term identity and congruence by id alone.
//   • Formula  — the Boolean skeleton over *atoms*. An atom is a leaf the SAT
//                solver gets a Boolean variable for: a predicate (a Bool-sorted
//                term), a term equality (EUF), or an arithmetic relation. The
//                connectives (¬ ∧ ∨ → ↔ ⊕ ite) sit above the atoms.
//
// Interning makes equal subformulas share a node, so the Tseitin abstraction
// introduces one Boolean variable per *distinct* atom — exactly what DPLL(T) wants.

import { Rational } from './rational'

export type Sort = string // 'Bool' | 'Int' | 'Real' | a user-declared sort name

export interface FunSig {
  name: string
  argSorts: Sort[]
  retSort: Sort
}

// ---- Terms -------------------------------------------------------------------
export interface Term {
  id: number
  kind: 'num' | 'app'
  op: string // function symbol, or a builtin '+', '-', '*' (arith), or '' for num
  args: Term[]
  sort: Sort
  num?: Rational // present iff kind === 'num'
  arith: boolean // true iff op is a builtin arithmetic operator
}

// A canonical linear combination Σ coeffs[v]·x_v + constant over arithmetic
// "variables" (leaf arithmetic terms, keyed by their term id).
export interface LinExpr {
  coeffs: Map<number, Rational>
  constant: Rational
}

// ---- Formulas ----------------------------------------------------------------
export type Formula =
  | { id: number; kind: 'const'; val: boolean }
  | { id: number; kind: 'not'; arg: Formula }
  | { id: number; kind: 'and'; args: Formula[] }
  | { id: number; kind: 'or'; args: Formula[] }
  | { id: number; kind: 'imp'; a: Formula; b: Formula }
  | { id: number; kind: 'iff'; a: Formula; b: Formula }
  | { id: number; kind: 'xor'; a: Formula; b: Formula }
  | { id: number; kind: 'ite'; c: Formula; t: Formula; e: Formula }
  // ---- atoms (leaves that receive a Boolean abstraction variable) ----
  | { id: number; kind: 'pred'; term: Term } // a Bool-sorted term (Bool const or predicate app)
  | { id: number; kind: 'eq'; a: Term; b: Term } // EUF term equality (non-arithmetic sorts)
  | { id: number; kind: 'arith'; rel: 'le' | 'lt' | 'eq0'; lin: LinExpr } // canonical: lin {≤,<,=} 0

export type Atom = Extract<Formula, { kind: 'pred' | 'eq' | 'arith' }>

const ARITH_SORTS = new Set(['Int', 'Real'])

export class TermManager {
  private sorts = new Set<Sort>(['Bool', 'Int', 'Real'])
  private funs = new Map<string, FunSig>()
  private termByKey = new Map<string, Term>()
  private terms: Term[] = []
  private formByKey = new Map<string, Formula>()
  private nextFormId = 0
  /** Leaf arithmetic terms that act as variables in LinExprs (id → term). */
  readonly arithVars = new Map<number, Term>()

  // ---- declarations ----------------------------------------------------------
  declareSort(name: Sort): void {
    this.sorts.add(name)
  }
  hasSort(name: Sort): boolean {
    return this.sorts.has(name)
  }
  declareFun(sig: FunSig): void {
    this.funs.set(sig.name, sig)
  }
  getFun(name: string): FunSig | undefined {
    return this.funs.get(name)
  }
  allFuns(): FunSig[] {
    return [...this.funs.values()]
  }

  // ---- term construction (interned) -----------------------------------------
  private internTerm(t: Omit<Term, 'id'>): Term {
    const key =
      t.kind === 'num' ? `#${t.num!.toString()}:${t.sort}` : `${t.op}(${t.args.map((a) => a.id).join(',')})`
    const hit = this.termByKey.get(key)
    if (hit) return hit
    const full: Term = { ...t, id: this.terms.length }
    this.terms.push(full)
    this.termByKey.set(key, full)
    // Track arithmetic leaf "variables": arithmetic-sorted terms that are not
    // builtin arithmetic operators nor numeric literals (i.e. consts / uf-apps).
    if (ARITH_SORTS.has(full.sort) && full.kind === 'app' && !full.arith) {
      this.arithVars.set(full.id, full)
    }
    return full
  }

  num(value: Rational, sort: Sort = 'Int'): Term {
    return this.internTerm({ kind: 'num', op: '', args: [], sort, num: value, arith: false })
  }

  /** Apply a *declared* function symbol; sort is taken from its signature. */
  app(name: string, args: Term[] = []): Term {
    const sig = this.funs.get(name)
    if (!sig) throw new Error(`unknown function symbol: ${name}`)
    if (sig.argSorts.length !== args.length)
      throw new Error(`${name}: expected ${sig.argSorts.length} args, got ${args.length}`)
    for (let i = 0; i < args.length; i++)
      if (args[i].sort !== sig.argSorts[i])
        throw new Error(`${name}: arg ${i} has sort ${args[i].sort}, expected ${sig.argSorts[i]}`)
    return this.internTerm({ kind: 'app', op: name, args, sort: sig.retSort, arith: false })
  }

  /** A builtin arithmetic operator application (+ - *), result sort inferred. */
  private arithApp(op: string, args: Term[]): Term {
    const sort: Sort = args.some((a) => a.sort === 'Real') ? 'Real' : 'Int'
    return this.internTerm({ kind: 'app', op, args, sort, arith: true })
  }

  add(a: Term, b: Term): Term {
    return this.arithApp('+', [a, b])
  }
  sub(a: Term, b: Term): Term {
    return this.arithApp('-', [a, b])
  }
  mul(a: Term, b: Term): Term {
    return this.arithApp('*', [a, b])
  }
  negTerm(a: Term): Term {
    return this.arithApp('-', [a]) // unary minus
  }

  // ---- linearization ---------------------------------------------------------
  /** Flatten an arithmetic term into a canonical Σ cᵢ·xᵢ + k. Throws on nonlinear. */
  linearize(t: Term): LinExpr {
    if (t.kind === 'num') return { coeffs: new Map(), constant: t.num! }
    if (t.arith) {
      if (t.op === '+') {
        return t.args.map((a) => this.linearize(a)).reduce((x, y) => addLin(x, y))
      }
      if (t.op === '-') {
        if (t.args.length === 1) return scaleLin(this.linearize(t.args[0]), Rational.of(-1n))
        return t.args
          .map((a, i) => (i === 0 ? this.linearize(a) : scaleLin(this.linearize(a), Rational.of(-1n))))
          .reduce((x, y) => addLin(x, y))
      }
      if (t.op === '*') {
        // Linear only if at most one factor is non-constant.
        const parts = t.args.map((a) => this.linearize(a))
        let acc: LinExpr = { coeffs: new Map(), constant: Rational.ONE }
        for (const p of parts) {
          if (p.coeffs.size === 0) acc = scaleLin(acc, p.constant)
          else if (acc.coeffs.size === 0) acc = scaleLin(p, acc.constant)
          else throw new Error('nonlinear multiplication is not supported')
        }
        return acc
      }
      throw new Error(`unknown arithmetic op ${t.op}`)
    }
    // A leaf arithmetic variable (constant symbol or uninterpreted application).
    this.arithVars.set(t.id, t)
    return { coeffs: new Map([[t.id, Rational.ONE]]), constant: Rational.ZERO }
  }

  // ---- formula construction (interned) --------------------------------------
  private internFormula(make: () => Formula, key: string): Formula {
    const hit = this.formByKey.get(key)
    if (hit) return hit
    const f = make()
    this.formByKey.set(key, f)
    return f
  }

  readonly tt: Formula = { id: -1, kind: 'const', val: true }
  readonly ff: Formula = { id: -2, kind: 'const', val: false }
  bool(v: boolean): Formula {
    return v ? this.tt : this.ff
  }

  not(f: Formula): Formula {
    if (f.kind === 'const') return this.bool(!f.val)
    if (f.kind === 'not') return f.arg
    return this.internFormula(() => ({ id: this.nextFormId++, kind: 'not', arg: f }), `!${fid(f)}`)
  }
  and(args: Formula[]): Formula {
    const flat: Formula[] = []
    for (const a of args) {
      if (a.kind === 'const') {
        if (!a.val) return this.ff
        continue
      }
      if (a.kind === 'and') flat.push(...a.args)
      else flat.push(a)
    }
    if (flat.length === 0) return this.tt
    if (flat.length === 1) return flat[0]
    const ids = flat.map(fid).sort((x, y) => x - y)
    return this.internFormula(() => ({ id: this.nextFormId++, kind: 'and', args: flat }), `&${ids.join(',')}`)
  }
  or(args: Formula[]): Formula {
    const flat: Formula[] = []
    for (const a of args) {
      if (a.kind === 'const') {
        if (a.val) return this.tt
        continue
      }
      if (a.kind === 'or') flat.push(...a.args)
      else flat.push(a)
    }
    if (flat.length === 0) return this.ff
    if (flat.length === 1) return flat[0]
    const ids = flat.map(fid).sort((x, y) => x - y)
    return this.internFormula(() => ({ id: this.nextFormId++, kind: 'or', args: flat }), `|${ids.join(',')}`)
  }
  imp(a: Formula, b: Formula): Formula {
    return this.or([this.not(a), b])
  }
  iff(a: Formula, b: Formula): Formula {
    if (a.kind === 'const') return a.val ? b : this.not(b)
    if (b.kind === 'const') return b.val ? a : this.not(a)
    const [x, y] = fid(a) <= fid(b) ? [a, b] : [b, a]
    return this.internFormula(
      () => ({ id: this.nextFormId++, kind: 'iff', a: x, b: y }),
      `<=>${fid(x)},${fid(y)}`,
    )
  }
  xor(a: Formula, b: Formula): Formula {
    return this.not(this.iff(a, b))
  }
  ite(c: Formula, t: Formula, e: Formula): Formula {
    if (c.kind === 'const') return c.val ? t : e
    return this.internFormula(
      () => ({ id: this.nextFormId++, kind: 'ite', c, t, e }),
      `ite${fid(c)},${fid(t)},${fid(e)}`,
    )
  }

  // ---- atoms -----------------------------------------------------------------
  pred(term: Term): Formula {
    if (term.sort !== 'Bool') throw new Error('pred() requires a Bool-sorted term')
    return this.internFormula(() => ({ id: this.nextFormId++, kind: 'pred', term }), `p${term.id}`)
  }

  /** Equality of two terms. Bool → iff; arithmetic → arithmetic equality; else EUF. */
  eq(a: Term, b: Term): Formula {
    if (a.sort !== b.sort) throw new Error(`= sort mismatch: ${a.sort} vs ${b.sort}`)
    if (a.sort === 'Bool') return this.iff(this.pred(a), this.pred(b))
    if (ARITH_SORTS.has(a.sort)) {
      return this.arithAtom('eq0', addLin(this.linearize(a), scaleLin(this.linearize(b), Rational.of(-1n))))
    }
    const [x, y] = a.id <= b.id ? [a, b] : [b, a]
    return this.internFormula(() => ({ id: this.nextFormId++, kind: 'eq', a: x, b: y }), `eq${x.id},${y.id}`)
  }

  distinct(terms: Term[]): Formula {
    const conj: Formula[] = []
    for (let i = 0; i < terms.length; i++)
      for (let j = i + 1; j < terms.length; j++) conj.push(this.not(this.eq(terms[i], terms[j])))
    return this.and(conj)
  }

  /** Arithmetic relation a ⋈ b, canonicalized to (lin ≤ 0) or (lin < 0). */
  rel(op: 'le' | 'lt' | 'ge' | 'gt', a: Term, b: Term): Formula {
    // a ≤ b  ⇔  a - b ≤ 0 ; a ≥ b ⇔ b - a ≤ 0 ; strict similarly.
    let lhs: Term, rhs: Term, strict: boolean
    if (op === 'le' || op === 'lt') {
      lhs = a
      rhs = b
      strict = op === 'lt'
    } else {
      lhs = b
      rhs = a
      strict = op === 'gt'
    }
    const diff = addLin(this.linearize(lhs), scaleLin(this.linearize(rhs), Rational.of(-1n)))
    return this.arithAtom(strict ? 'lt' : 'le', diff)
  }

  /**
   * Intern an arithmetic atom (lin {≤,<,=} 0) from a raw LinExpr. Equalities are
   * sign-normalized (so L=0 and −L=0 share an atom); inequalities keep their
   * orientation but are scaled to small integer coefficients.
   */
  arithAtom(rel: 'le' | 'lt' | 'eq0', lin: LinExpr): Formula {
    const norm = rel === 'eq0' ? canonicalSign(lin).lin : normalizeKeepOrient(lin)
    const prefix = rel === 'eq0' ? 'a=' : rel === 'lt' ? 'al' : 'ale'
    return this.internFormula(
      () => ({ id: this.nextFormId++, kind: 'arith', rel, lin: norm }),
      `${prefix}${linKey(norm)}`,
    )
  }

  termToString(t: Term): string {
    if (t.kind === 'num') return t.num!.toString()
    if (t.args.length === 0) return t.op
    if (t.arith && t.args.length === 1) return `(- ${this.termToString(t.args[0])})`
    if (t.arith) return `(${t.op} ${t.args.map((a) => this.termToString(a)).join(' ')})`
    return `${t.op}(${t.args.map((a) => this.termToString(a)).join(', ')})`
  }
}

function fid(f: Formula): number {
  return f.id
}

// ---- LinExpr helpers ---------------------------------------------------------
export function addLin(a: LinExpr, b: LinExpr): LinExpr {
  const coeffs = new Map(a.coeffs)
  for (const [v, c] of b.coeffs) {
    const cur = coeffs.get(v)
    const sum = cur ? cur.add(c) : c
    if (sum.isZero()) coeffs.delete(v)
    else coeffs.set(v, sum)
  }
  return { coeffs, constant: a.constant.add(b.constant) }
}
export function scaleLin(a: LinExpr, k: Rational): LinExpr {
  if (k.isZero()) return { coeffs: new Map(), constant: Rational.ZERO }
  const coeffs = new Map<number, Rational>()
  for (const [v, c] of a.coeffs) coeffs.set(v, c.mul(k))
  return { coeffs, constant: a.constant.mul(k) }
}

/** Canonical key for a LinExpr (sorted by variable id). */
export function linKey(l: LinExpr): string {
  const parts = [...l.coeffs.entries()].sort((x, y) => x[0] - y[0]).map(([v, c]) => `${v}:${c.toString()}`)
  return `${parts.join('+')}|${l.constant.toString()}`
}

// For equalities, the canonical form is sign-normalized (first nonzero coeff > 0)
// so that L=0 and (-L)=0 intern to the same atom.
function canonicalSign(l: LinExpr): { lin: LinExpr } {
  const keys = [...l.coeffs.keys()].sort((a, b) => a - b)
  if (keys.length === 0) return { lin: normalizeKeepOrient(l) }
  const lead = l.coeffs.get(keys[0])!
  const oriented = lead.sign() < 0 ? scaleLin(l, Rational.of(-1n)) : l
  return { lin: normalizeKeepOrient(oriented) }
}

// Clear denominators and divide by the gcd of integer coefficients, preserving
// orientation (valid for inequalities). Keeps the LinExpr as small integers when
// possible without changing the satisfying set.
function normalizeKeepOrient(l: LinExpr): LinExpr {
  const vals = [...l.coeffs.values(), l.constant].filter((r) => !r.isZero())
  if (vals.length === 0) return { coeffs: new Map(), constant: Rational.ZERO }
  // Multiply by lcm of denominators.
  let lcm = 1n
  for (const r of vals) lcm = (lcm / gcd(lcm, r.d)) * r.d
  let scaled = scaleLin(l, Rational.of(lcm))
  // Divide by gcd of numerators (all integers now).
  let g = 0n
  for (const [, c] of scaled.coeffs) g = gcd(g, c.n)
  g = gcd(g, scaled.constant.n)
  if (g > 1n) scaled = scaleLin(scaled, Rational.of(1n, g))
  return scaled
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}
