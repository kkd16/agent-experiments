// Aether — type-and-example-directed program synthesis ("Aether Sketch").
//
// You give a handful of input→output examples; this module *writes the program*
// for you. It is a from-scratch **bottom-up (observational-equivalence)
// enumerative synthesizer** — the same family of algorithm behind Escher /
// Transit / EUSolver, built here with no solver and no external library.
//
// How it works, end to end:
//
//   1. Each example's input and output is evaluated to a real runtime `Value`
//      through the ordinary pipeline, and a *structural* monomorphic type is
//      read off those values (`Int`, `Bool`, `Str`, `List a`, tuples). The goal
//      type is `shape(input) -> shape(output)`.
//   2. A **term bank** is grown bottom-up. Level 0 holds the argument variable
//      and a few constants; each round applies a library of typed components
//      (arithmetic, comparisons, `if`, list ops) and — crucially — the
//      higher-order combinators `map`/`filter`/`foldr`/`foldl`, whose function
//      arguments are themselves synthesized by a nested bottom-up search. Every
//      new term is evaluated on all the example inputs and kept only if its
//      result *vector* is one no cheaper term already produces (observational
//      equivalence — the pruning that makes enumeration tractable).
//   3. The search stops the instant a term's result vector equals the example
//      outputs. That term is rendered to Aether source.
//   4. The candidate is then **re-checked through the real pipeline** (lexer →
//      Hindley–Milner → bytecode → VM): we only ever present a program the
//      genuine compiler accepts and runs to the right answers. The internal
//      evaluator is just a fast oracle for the search; the compiler has the
//      final say.
//
// Because the found program is ordinary Aether, you can send it to the
// Playground and watch all three backends (VM ≡ JS ≡ WASM) agree on it.

import type { Value } from './values.ts'
import {
  NIL,
  compareValues,
  listFromArray,
  listToArray,
  valueToString,
  vbool,
  vint,
  vstr,
} from './values.ts'
import { runPipeline } from './pipeline.ts'

// ---------------------------------------------------------------------------
// Structural (monomorphic) types read off concrete example values.
// ---------------------------------------------------------------------------

export type STy =
  | { k: 'int' }
  | { k: 'bool' }
  | { k: 'str' }
  | { k: 'unit' }
  | { k: 'list'; el: STy }
  | { k: 'tuple'; items: STy[] }
  | { k: 'any' } // unknown element (an empty list before another example refines it)

const TINT: STy = { k: 'int' }
const TBOOL: STy = { k: 'bool' }
const TSTR: STy = { k: 'str' }
const TANY: STy = { k: 'any' }
const tList = (el: STy): STy => ({ k: 'list', el })

export function tyKey(t: STy): string {
  switch (t.k) {
    case 'list':
      return `[${tyKey(t.el)}]`
    case 'tuple':
      return `(${t.items.map(tyKey).join(',')})`
    default:
      return t.k
  }
}

export function styToString(t: STy): string {
  switch (t.k) {
    case 'int':
      return 'Int'
    case 'bool':
      return 'Bool'
    case 'str':
      return 'String'
    case 'unit':
      return 'Unit'
    case 'any':
      return 'a'
    case 'list':
      return `List ${styToString(t.el)}`
    case 'tuple':
      return `(${t.items.map(styToString).join(', ')})`
  }
}

function styEq(a: STy, b: STy): boolean {
  return tyKey(a) === tyKey(b)
}

/** The structural shape of a runtime value. Empty lists yield `List a`. */
export function shapeOf(v: Value): STy {
  switch (v.tag) {
    case 'int':
      return TINT
    case 'float':
      return TINT // synthesis stays in the integer world
    case 'bool':
      return TBOOL
    case 'str':
      return TSTR
    case 'unit':
      return { k: 'unit' }
    case 'nil':
      return tList(TANY)
    case 'cons': {
      let el: STy = TANY
      for (const item of listToArray(v)) el = mergeTy(el, shapeOf(item))
      return tList(el)
    }
    case 'tuple':
      return { k: 'tuple', items: v.items.map(shapeOf) }
    default:
      return TANY
  }
}

/** Unify two shapes, letting `any` stand for anything. Throws on a real clash. */
export function mergeTy(a: STy, b: STy): STy {
  if (a.k === 'any') return b
  if (b.k === 'any') return a
  if (a.k === 'list' && b.k === 'list') return tList(mergeTy(a.el, b.el))
  if (a.k === 'tuple' && b.k === 'tuple' && a.items.length === b.items.length)
    return { k: 'tuple', items: a.items.map((x, i) => mergeTy(x, (b as typeof a).items[i])) }
  if (styEq(a, b)) return a
  throw new SynthError(`inconsistent example types: ${styToString(a)} vs ${styToString(b)}`)
}

/** Replace any residual `any` with `Int` so the bank is fully concrete. */
function groundTy(t: STy): STy {
  switch (t.k) {
    case 'any':
      return TINT
    case 'list':
      return tList(groundTy(t.el))
    case 'tuple':
      return { k: 'tuple', items: t.items.map(groundTy) }
    default:
      return t
  }
}

export class SynthError extends Error {}

// ---------------------------------------------------------------------------
// Terms. Each carries a JS closure so it can be evaluated at any environment
// (the argument variable plus any lambda-bound variables), and a source
// rendering. `vec` caches the closure over the current row set for dedup.
// ---------------------------------------------------------------------------

type Env = (Value | undefined)[]
type Sem = (env: Env) => Value | undefined

interface Term {
  src: string
  atom: boolean
  ty: STy
  size: number
  fn: Sem
  vec: (Value | undefined)[]
  /** does this term read the argument (or a lambda variable)? Constant-only
   * sub-terms are pruned: at least one operand of every op must use a variable,
   * else we'd endlessly re-derive constants already in the bank. */
  usesVar: boolean
  /** recursion candidates carry `rec: true` and the recursed argument's name so
   * the rendering + verification helpers emit a `let rec … = match …` instead of
   * a plain `fn`. Absent (falsy) on every ordinary straight-line/fold term. */
  rec?: boolean
  rName?: string
}

const wrap = (t: Term): string => (t.atom ? t.src : `(${t.src})`)

function evalVec(fn: Sem, rows: Env[]): (Value | undefined)[] {
  const out: (Value | undefined)[] = []
  for (const env of rows) {
    let r: Value | undefined
    try {
      r = fn(env)
    } catch {
      r = undefined
    }
    out.push(r)
  }
  return out
}

function valKey(v: Value | undefined): string {
  if (v === undefined) return '⊥'
  return valueToString(v)
}

/** Total structural equality (never throws on shape/tag mismatch). */
function sameValue(a: Value, b: Value): boolean {
  return valueToString(a) === valueToString(b)
}

const vecKey = (vec: (Value | undefined)[]): string => vec.map(valKey).join('§')

// ---------------------------------------------------------------------------
// The term bank: type-key → terms, with a global observational-equivalence set.
// ---------------------------------------------------------------------------

class Bank {
  byType = new Map<string, Term[]>()
  private seen = new Set<string>()
  size = 0

  add(t: Term): boolean {
    const key = tyKey(t.ty) + '::' + vecKey(t.vec)
    if (this.seen.has(key)) return false
    this.seen.add(key)
    const bucket = this.byType.get(tyKey(t.ty))
    if (bucket) bucket.push(t)
    else this.byType.set(tyKey(t.ty), [t])
    this.size++
    return true
  }

  of(t: STy): Term[] {
    return this.byType.get(tyKey(t)) ?? []
  }

  ofKey(k: string): Term[] {
    return this.byType.get(k) ?? []
  }

  types(): STy[] {
    const out: STy[] = []
    for (const b of this.byType.values()) if (b.length) out.push(b[0].ty)
    return out
  }
}

// ---------------------------------------------------------------------------
// Value rendering as Aether source (for the final program and its literals).
// ---------------------------------------------------------------------------

export function litSrc(v: Value): string {
  switch (v.tag) {
    case 'int':
    case 'float':
      return String(v.n)
    case 'bool':
      return v.b ? 'true' : 'false'
    case 'str':
      return JSON.stringify(v.s)
    case 'unit':
      return '()'
    case 'nil':
      return '[]'
    case 'cons':
      return '[' + listToArray(v).map(litSrc).join(', ') + ']'
    case 'tuple':
      return '(' + v.items.map(litSrc).join(', ') + ')'
    default:
      return valueToString(v)
  }
}

// ---------------------------------------------------------------------------
// Component library. Each generator inspects the bank and offers new terms of a
// given size; the driver keeps the observationally novel ones.
// ---------------------------------------------------------------------------

const asInt = (v: Value | undefined): number | undefined =>
  v && (v.tag === 'int' || v.tag === 'float') ? v.n : undefined

// A term reads a variable iff its rendered source mentions one of the names in
// scope. For a single-argument goal that's `x` (plus the lambda params `h`/`acc`);
// a multi-argument goal (`fn a b -> …`) puts several argument names in scope, so
// the regex is rebuilt per run by `setVarNames`. No component keyword contains any
// of these as a whole word, so the whole-word test stays exact.
let VAR_RE = /\b(?:x|h|acc)\b/

/** Reset the in-scope variable names (the goal's argument names + lambda params).
 * The recursion sub-search overrides `extra` with `['h', 't', 'rec']` so a step
 * body reading the head/tail/recursive-result counts as variable-using. */
function setVarNames(argNames: string[], extra: string[] = ['h', 'acc']): void {
  const names = [...argNames, ...extra].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  VAR_RE = new RegExp(`\\b(?:${names.join('|')})\\b`)
}

/** Build a term, deriving `vec` and `usesVar` from the pieces. */
function term(src: string, atom: boolean, ty: STy, size: number, fn: Sem, rows: Env[]): Term {
  return { src, atom, ty, size, fn, vec: evalVec(fn, rows), usesVar: VAR_RE.test(src) }
}

function mkBinInt(
  op: string,
  f: (a: number, b: number) => number | undefined,
  rows: Env[],
  a: Term,
  b: Term,
): Term {
  const fn: Sem = (env) => {
    const x = asInt(a.fn(env))
    const y = asInt(b.fn(env))
    if (x === undefined || y === undefined) return undefined
    const r = f(x, y)
    return r === undefined ? undefined : vint(r)
  }
  return term(`${wrap(a)} ${op} ${wrap(b)}`, false, TINT, 1 + a.size + b.size, fn, rows)
}

const absSem = (v: Value): Value | undefined =>
  v.tag === 'int' || v.tag === 'float' ? vint(Math.abs(v.n)) : undefined

/** A prelude-style binary integer function rendered as `name a b` (e.g. `max`). */
function mkBinIntFn(
  name: string,
  f: (a: number, b: number) => number,
  rows: Env[],
  a: Term,
  b: Term,
): Term {
  const fn: Sem = (env) => {
    const x = asInt(a.fn(env))
    const y = asInt(b.fn(env))
    if (x === undefined || y === undefined) return undefined
    return vint(f(x, y))
  }
  return term(`${name} ${wrap(a)} ${wrap(b)}`, false, TINT, 1 + a.size + b.size, fn, rows)
}

function mkCmp(op: string, f: (c: number) => boolean, rows: Env[], a: Term, b: Term): Term {
  const fn: Sem = (env) => {
    const x = a.fn(env)
    const y = b.fn(env)
    if (x === undefined || y === undefined) return undefined
    try {
      return vbool(f(compareValues(x, y)))
    } catch {
      return undefined
    }
  }
  return term(`${wrap(a)} ${op} ${wrap(b)}`, false, TBOOL, 1 + a.size + b.size, fn, rows)
}

function mkUnary(name: string, ty: STy, sem: (v: Value) => Value | undefined, rows: Env[], a: Term): Term {
  const fn: Sem = (env) => {
    const x = a.fn(env)
    if (x === undefined) return undefined
    try {
      return sem(x)
    } catch {
      return undefined
    }
  }
  return term(`${name} ${wrap(a)}`, false, ty, 1 + a.size, fn, rows)
}

interface GrowOpts {
  rows: Env[]
  maxTermSize: number
  perTypeCap: number
  /** cap on how many (smallest) terms of a type feed a binary combinator */
  fanout: number
  allowHof: boolean
  deadline: number
  /** the search target — matched against each freshly built term */
  goal?: (t: Term) => boolean
  /** called for *every* freshly built term that meets the goal (before the
   * per-type cap can evict it) — lets the driver harvest all solutions, not
   * just the first, for ranking and ambiguity detection */
  collect?: (t: Term) => void
  /** synthesize a unary lambda `elemTy -> resultTy` (for map / filter) */
  hofInner: (elemTy: STy, resultTy: STy) => HofFn[]
  /** synthesize a binary lambda `elemTy -> accTy -> accTy` (for foldr / foldl) */
  hofInner2: (elemTy: STy, accTy: STy) => HofFn[]
}

/** The `n` smallest terms of a bucket — bounds the combinatorial fan-out. */
function smallest(terms: Term[], n: number): Term[] {
  if (terms.length <= n) return terms
  return terms.slice().sort((a, b) => a.size - b.size).slice(0, n)
}

/** One bottom-up growth pass. Admits new terms and reports any goal match. */
function growPass(bank: Bank, opts: GrowOpts): { added: number; hit: Term | null } {
  const { rows, maxTermSize: MAX, fanout: FAN } = opts
  const before = bank.size
  const additions: Term[] = []
  const push = (t: Term): void => {
    if (t.size <= MAX) additions.push(t)
  }
  // combine two operands only if the result fits AND at least one reads a
  // variable (else the result is a constant already derivable by folding).
  const fits = (a: Term, b: Term): boolean => 1 + a.size + b.size <= MAX && (a.usesVar || b.usesVar)
  const un = (a: Term): boolean => 1 + a.size <= MAX && a.usesVar

  const ints = smallest(bank.of(TINT), FAN)
  // unary integer ops
  for (const a of ints) if (un(a)) push(mkUnary('abs', TINT, absSem, rows, a))
  // arithmetic + comparisons
  for (const a of ints)
    for (const b of ints) {
      if (!fits(a, b)) continue
      push(mkBinInt('+', (x, y) => x + y, rows, a, b))
      push(mkBinInt('-', (x, y) => x - y, rows, a, b))
      push(mkBinInt('*', (x, y) => x * y, rows, a, b))
      push(mkBinInt('%', (x, y) => (y === 0 ? undefined : x % y), rows, a, b))
      push(mkBinIntFn('max', (x, y) => Math.max(x, y), rows, a, b))
      push(mkBinIntFn('min', (x, y) => Math.min(x, y), rows, a, b))
      push(mkCmp('==', (c) => c === 0, rows, a, b))
      push(mkCmp('<', (c) => c < 0, rows, a, b))
      push(mkCmp('<=', (c) => c <= 0, rows, a, b))
      push(mkCmp('>', (c) => c > 0, rows, a, b))
    }
  // equality on strings/bools
  for (const t of [TSTR, TBOOL]) {
    const xs = smallest(bank.of(t), FAN)
    for (const a of xs) for (const b of xs) if (fits(a, b)) push(mkCmp('==', (c) => c === 0, rows, a, b))
  }
  // booleans
  const bools = smallest(bank.of(TBOOL), FAN)
  for (const a of bools) {
    if (un(a)) push(mkUnary('!', TBOOL, (v) => (v.tag === 'bool' ? vbool(!v.b) : undefined), rows, a))
    for (const b of bools)
      if (fits(a, b)) {
        push(boolBin('&&', (x, y) => x && y, rows, a, b))
        push(boolBin('||', (x, y) => x || y, rows, a, b))
      }
  }
  // per-type list & tuple operators
  for (const ty of bank.types()) {
    if (ty.k === 'list') {
      const lists = smallest(bank.of(ty), FAN)
      const el = ty.el
      const elems = smallest(bank.of(el), FAN)
      for (const l of lists) {
        if (!un(l)) continue
        push(mkUnary('length', TINT, listLen, rows, l))
        push(mkUnary('reverse', ty, listRev(), rows, l))
        push(mkUnary('head', el, listHead, rows, l))
        push(mkUnary('tail', ty, listTail(), rows, l))
        if (styEq(el, TINT)) push(mkUnary('sum', TINT, listSum, rows, l))
      }
      for (const e of elems)
        for (const l of lists) if (fits(e, l)) push(consTerm(ty, rows, e, l))
      for (const a of lists) for (const b of lists) if (fits(a, b)) push(appendTerm(ty, rows, a, b))
      for (const e of elems) for (const l of lists) if (fits(e, l)) push(elemTerm(rows, e, l))
    }
    if (ty.k === 'tuple' && ty.items.length === 2) {
      for (const tp of bank.of(ty))
        if (un(tp)) for (let i = 0; i < ty.items.length; i++) push(projTerm(ty, i, rows, tp))
    }
  }
  // string concat
  const strs = smallest(bank.of(TSTR), FAN)
  for (const a of strs) for (const b of strs) if (fits(a, b)) push(strConcat(rows, a, b))

  // higher-order combinators
  if (opts.allowHof) growHof(bank, opts, additions)

  // admit, smallest first, respecting the per-type cap. The goal is checked
  // against *every* freshly generated term (smallest first) before the cap can
  // evict it — so a large solution isn't lost to a flood of cheaper siblings.
  additions.sort((a, b) => a.size - b.size)
  let hit: Term | null = null
  const perType = new Map<string, number>()
  for (const t of additions) {
    if (opts.goal && opts.goal(t)) {
      if (!hit) hit = t
      opts.collect?.(t)
    }
    const k = tyKey(t.ty)
    const n = perType.get(k) ?? bank.ofKey(k).length
    if (n >= opts.perTypeCap) continue
    if (bank.add(t)) perType.set(k, n + 1)
  }
  return { added: bank.size - before, hit }
}

function boolBin(op: string, f: (a: boolean, b: boolean) => boolean, rows: Env[], a: Term, b: Term): Term {
  const fn: Sem = (env) => {
    const x = a.fn(env)
    const y = b.fn(env)
    if (x === undefined || y === undefined || x.tag !== 'bool' || y.tag !== 'bool') return undefined
    return vbool(f(x.b, y.b))
  }
  return term(`${wrap(a)} ${op} ${wrap(b)}`, false, TBOOL, 1 + a.size + b.size, fn, rows)
}

const listLen = (v: Value): Value => vint(listToArray(v).length)
const listSum = (v: Value): Value => vint(listToArray(v).reduce((s, x) => s + (asInt(x) ?? 0), 0))
const listRev = (): ((v: Value) => Value) => (v) => listFromArray(listToArray(v).slice().reverse())
const listHead = (v: Value): Value | undefined => (v.tag === 'cons' ? v.head : undefined)
const listTail = (): ((v: Value) => Value | undefined) => (v) => (v.tag === 'cons' ? v.tail : undefined)

function consTerm(ty: STy, rows: Env[], e: Term, l: Term): Term {
  const fn: Sem = (env) => {
    const h = e.fn(env)
    const t = l.fn(env)
    if (h === undefined || t === undefined) return undefined
    return { tag: 'cons', head: h, tail: t }
  }
  return term(`${wrap(e)} :: ${wrap(l)}`, false, ty, 1 + e.size + l.size, fn, rows)
}

function appendTerm(ty: STy, rows: Env[], a: Term, b: Term): Term {
  const fn: Sem = (env) => {
    const x = a.fn(env)
    const y = b.fn(env)
    if (x === undefined || y === undefined) return undefined
    return listFromArray([...listToArray(x), ...listToArray(y)])
  }
  return term(`${wrap(a)} ++ ${wrap(b)}`, false, ty, 1 + a.size + b.size, fn, rows)
}

function elemTerm(rows: Env[], e: Term, l: Term): Term {
  const fn: Sem = (env) => {
    const x = e.fn(env)
    const y = l.fn(env)
    if (x === undefined || y === undefined) return undefined
    return vbool(listToArray(y).some((it) => sameValue(it, x)))
  }
  return term(`elem ${wrap(e)} ${wrap(l)}`, false, TBOOL, 1 + e.size + l.size, fn, rows)
}

function projTerm(ty: Extract<STy, { k: 'tuple' }>, i: number, rows: Env[], tp: Term): Term {
  const name = i === 0 ? 'fst' : 'snd'
  const fn: Sem = (env) => {
    const v = tp.fn(env)
    if (v === undefined || v.tag !== 'tuple') return undefined
    return v.items[i]
  }
  return term(`${name} ${wrap(tp)}`, false, ty.items[i], 1 + tp.size, fn, rows)
}

function strConcat(rows: Env[], a: Term, b: Term): Term {
  const fn: Sem = (env) => {
    const x = a.fn(env)
    const y = b.fn(env)
    if (x === undefined || y === undefined || x.tag !== 'str' || y.tag !== 'str') return undefined
    return vstr(x.s + y.s)
  }
  return term(`${wrap(a)} ^ ${wrap(b)}`, false, TSTR, 1 + a.size + b.size, fn, rows)
}

function ifTerm(ty: STy, rows: Env[], c: Term, t: Term, e: Term): Term {
  const fn: Sem = (env) => {
    const cv = c.fn(env)
    if (cv === undefined || cv.tag !== 'bool') return undefined
    return cv.b ? t.fn(env) : e.fn(env)
  }
  return term(`if ${wrap(c)} then ${wrap(t)} else ${wrap(e)}`, false, ty, 1 + c.size + t.size + e.size, fn, rows)
}

// ---------------------------------------------------------------------------
// Higher-order combinators. Their function argument is drawn from a nested
// bottom-up search (`opts.hofInner`) over the combinator's bound variables.
// ---------------------------------------------------------------------------

function growHof(bank: Bank, opts: GrowOpts, out: Term[]): void {
  const { rows, maxTermSize: MAX } = opts
  if (nowMs() > opts.deadline) return
  for (const ty of bank.types()) {
    if (ty.k !== 'list') continue
    const el = ty.el
    const lists = bank.of(ty).filter((l) => l.size <= 3)
    if (lists.length === 0) continue

    // map : (el -> R) -> List el -> List R
    for (const resultEl of candidateElemTypes(bank)) {
      const fs = opts.hofInner(el, resultEl).filter((f) => 1 + f.size + 1 <= MAX).slice(0, 96)
      for (const f of fs)
        for (const l of lists) {
          const term = mapTerm(tList(resultEl), rows, f, l)
          if (term.size <= MAX) out.push(term)
        }
    }

    // filter : (el -> Bool) -> List el -> List el
    {
      const ps = opts.hofInner(el, TBOOL).filter((f) => 1 + f.size + 1 <= MAX).slice(0, 96)
      for (const p of ps)
        for (const l of lists) {
          const term = filterTerm(ty, rows, p, l)
          if (term.size <= MAX) out.push(term)
        }
    }

    // foldr / foldl : (el -> R -> R) -> R -> List el -> R  (accumulator type R)
    for (const acc of candidateElemTypes(bank)) {
      const zs = bank.of(acc).filter((z) => z.size <= 2).slice(0, 8)
      if (zs.length === 0) continue
      const fs = opts.hofInner2(el, acc).filter((f) => f.size <= 5).slice(0, 64)
      for (const f of fs)
        for (const z of zs)
          for (const l of lists) {
            if (1 + f.size + z.size + l.size > MAX) continue
            out.push(foldrTerm(acc, rows, f, z, l))
            out.push(foldlTerm(acc, rows, f, z, l))
          }
    }
  }
}

/** Element/accumulator types worth trying: the ones already in the bank plus Int/Bool. */
function candidateElemTypes(bank: Bank): STy[] {
  const seen = new Set<string>()
  const out: STy[] = []
  const add = (t: STy): void => {
    if (t.k === 'unit') return
    if (!seen.has(tyKey(t))) {
      seen.add(tyKey(t))
      out.push(t)
    }
  }
  add(TINT)
  add(TBOOL)
  for (const t of bank.types()) {
    add(t)
    if (t.k === 'list') add(t.el)
  }
  return out
}

function mapTerm(ty: STy, rows: Env[], f: HofFn, l: Term): Term {
  const fn: Sem = (env) => {
    const xs = l.fn(env)
    if (xs === undefined) return undefined
    const arr = listToArray(xs)
    const res: Value[] = []
    for (const x of arr) {
      const r = f.apply(env, [x])
      if (r === undefined) return undefined
      res.push(r)
    }
    return listFromArray(res)
  }
  return term(`map ${f.src} ${wrap(l)}`, false, ty, 1 + f.size + l.size, fn, rows)
}

function filterTerm(ty: STy, rows: Env[], p: HofFn, l: Term): Term {
  const fn: Sem = (env) => {
    const xs = l.fn(env)
    if (xs === undefined) return undefined
    const res: Value[] = []
    for (const x of listToArray(xs)) {
      const r = p.apply(env, [x])
      if (r === undefined || r.tag !== 'bool') return undefined
      if (r.b) res.push(x)
    }
    return listFromArray(res)
  }
  return term(`filter ${p.src} ${wrap(l)}`, false, ty, 1 + p.size + l.size, fn, rows)
}

function foldrTerm(ty: STy, rows: Env[], f: HofFn, z: Term, l: Term): Term {
  const fn: Sem = (env) => {
    const xs = l.fn(env)
    const zv = z.fn(env)
    if (xs === undefined || zv === undefined) return undefined
    const arr = listToArray(xs)
    let acc = zv
    for (let i = arr.length - 1; i >= 0; i--) {
      const r = f.apply(env, [arr[i], acc])
      if (r === undefined) return undefined
      acc = r
    }
    return acc
  }
  return term(`foldr ${f.src} ${wrap(z)} ${wrap(l)}`, false, ty, 1 + f.size + z.size + l.size, fn, rows)
}

function foldlTerm(ty: STy, rows: Env[], f: HofFn, z: Term, l: Term): Term {
  const fn: Sem = (env) => {
    const xs = l.fn(env)
    const zv = z.fn(env)
    if (xs === undefined || zv === undefined) return undefined
    let acc = zv
    for (const x of listToArray(xs)) {
      // foldl's function is (acc -> el -> acc); we synthesized (el -> acc -> acc),
      // so swap to keep one inner search shape.
      const r = f.apply(env, [x, acc])
      if (r === undefined) return undefined
      acc = r
    }
    return acc
  }
  const src = `foldl (fn acc0 x0 -> ${f.body('x0', 'acc0')}) ${wrap(z)} ${wrap(l)}`
  return term(src, false, ty, 1 + f.size + z.size + l.size, fn, rows)
}

// A synthesized lambda passed to a combinator. `apply` runs it at an outer
// environment with its parameters bound; `body` re-renders the body with the
// caller's chosen parameter names (so `foldl` can flip the argument order).
interface HofFn {
  src: string
  size: number
  apply: (outer: Env, args: Value[]) => Value | undefined
  body: (p0: string, p1: string) => string
}

// ---------------------------------------------------------------------------
// The driver.
// ---------------------------------------------------------------------------

export interface Example {
  /** one value per goal argument (length 1 for a single-argument goal) */
  inputs: Value[]
  output: Value
  /** the source text of each argument, for rendering + re-running */
  inputSrcs: string[]
  outputSrc: string
}

export interface Spec {
  examples: Example[]
  typeHint: string | null
  /** an optional reference function (an oracle) driving the Auto-CEGIS loop:
   * whenever the examples are ambiguous it is evaluated on the distinguishing
   * input to auto-label a new example, so the search converges with no hand-labelling. */
  ref: string | null
}

/** One ranked candidate program that reproduces every example. */
export interface Candidate {
  program: string
  size: number
  /** VM instruction count summed over the examples (null if not measured) */
  steps: number | null
}

/**
 * A distinguishing witness proving the examples are ambiguous: an input on which
 * two candidate programs (each consistent with every example) disagree.
 */
export interface Ambiguity {
  /** the rendered input the candidates disagree on (`a, b` for multi-arg) */
  inputSrc: string
  /** each distinct answer at that input, and the smallest program giving it */
  options: { outputSrc: string; program: string }[]
}

export interface SynthResult {
  ok: boolean
  program: string | null
  /** a self-contained snippet (helpers + `solve` + a sample call) for the Playground */
  playgroundSrc: string | null
  paramName: string
  /** the goal's argument names (`['x']`, or `['x','y']` for a multi-argument goal) */
  paramNames: string[]
  type: string | null
  goalType: string
  size: number | null
  candidates: number
  classes: number
  millis: number
  verified: boolean
  message: string
  rows: { input: string; expected: string; got: string; ok: boolean }[]
  /** other distinct programs that also fit, ranked after the chosen one */
  alternatives: Candidate[]
  /** a distinguishing input if the examples are ambiguous, else null */
  ambiguity: Ambiguity | null
}

const OUTER_X = 0 // env index of the (first) argument variable
const IN_HEAD = 1 // inner lambda parameters
const IN_ACC = 2

/** Argument names for a k-argument goal — none clash with `h`/`acc` or a component. */
const ARG_NAMES = ['x', 'y', 'z', 'w', 'u', 'v']
const MAX_ARGS = ARG_NAMES.length

/** Small deterministic probe values per type for the inner (lambda) search. */
function probeValues(t: STy): Value[] {
  switch (t.k) {
    case 'int':
      return [vint(0), vint(1), vint(2), vint(-1), vint(3)]
    case 'bool':
      return [vbool(true), vbool(false)]
    case 'str':
      return [vstr(''), vstr('a'), vstr('ab')]
    case 'list':
      return [NIL, listFromArray([probeValues(t.el)[0]]), listFromArray(probeValues(t.el).slice(0, 2))]
    case 'tuple':
      return [{ tag: 'tuple', items: t.items.map((it) => probeValues(it)[0]) }]
    default:
      return [vint(0)]
  }
}

function seedConstants(bank: Bank, ty: STy, rows: Env[], extraInts: number[]): void {
  const add = (src: string, atom: boolean, t: STy, v: Value): void => {
    const fn: Sem = () => v
    bank.add(term(src, atom, t, 1, fn, rows))
  }
  const seedT = (t: STy): void => {
    switch (t.k) {
      case 'int': {
        const ints = new Set<number>([0, 1, 2, ...extraInts])
        for (const n of ints) add(String(n), n >= 0, TINT, vint(n))
        break
      }
      case 'bool':
        add('true', true, TBOOL, vbool(true))
        add('false', true, TBOOL, vbool(false))
        break
      case 'str':
        add('""', true, TSTR, vstr(''))
        break
      case 'list':
        add('[]', true, t, NIL)
        seedT(t.el)
        break
      case 'tuple':
        for (const it of t.items) seedT(it)
        break
    }
  }
  seedT(ty)
  // always have the integer world available for lengths, counters, comparisons
  const ints = new Set<number>([0, 1, 2, ...extraInts])
  if (!bank.byType.has('int')) for (const n of ints) add(String(n), n >= 0, TINT, vint(n))
}

interface SearchLimits {
  maxTermSize: number
  perTypeCap: number
  fanout: number
  maxRounds: number
  maxCandidates: number
  timeBudgetMs: number
}

const DEFAULT_LIMITS: SearchLimits = {
  maxTermSize: 8,
  perTypeCap: 110,
  fanout: 200,
  maxRounds: 6,
  maxCandidates: 60000,
  timeBudgetMs: 4000,
}

/** Nested bottom-up search producing candidate lambdas for the combinators. */
function makeInner(
  argVar: Value[], // one representative per outer example (x seen inside the lambda)
): (paramTys: STy[], resultTy: STy) => HofFn[] {
  const cache = new Map<string, HofFn[]>()
  return (paramTys, resultTy) => {
    const cacheKey = paramTys.map(tyKey).join('|') + '=>' + tyKey(resultTy)
    const cached = cache.get(cacheKey)
    if (cached) return cached
    // probe rows: cartesian-ish product of param probes, x held at representatives
    const probes = paramTys.map(probeValues)
    const rows: Env[] = []
    const xs = argVar.length ? argVar : [vint(0)]
    for (const xv of xs.slice(0, 1)) {
      cartesian(probes, (vals) => {
        const env: Env = []
        env[OUTER_X] = xv
        if (paramTys.length >= 1) env[IN_HEAD] = vals[0]
        if (paramTys.length >= 2) env[IN_ACC] = vals[1]
        rows.push(env)
      })
    }
    const bank = new Bank()
    // seed inner variables
    const addVar = (idx: number, name: string, t: STy): void => {
      const fn: Sem = (env) => env[idx]
      bank.add(term(name, true, t, 1, fn, rows))
    }
    if (paramTys.length >= 1) addVar(IN_HEAD, 'h', paramTys[0])
    if (paramTys.length >= 2) addVar(IN_ACC, 'acc', paramTys[1])
    // also let the lambda see the outer argument
    seedConstants(bank, resultTy, rows, [])
    for (const pt of paramTys) seedConstants(bank, pt, rows, [])

    const inner: GrowOpts = {
      rows,
      maxTermSize: 5,
      perTypeCap: 60,
      fanout: 26,
      allowHof: false,
      deadline: Infinity,
      hofInner: () => [],
      hofInner2: () => [],
    }
    for (let i = 0; i < 3; i++) if (growPass(bank, inner).added === 0) break

    const bodies = bank.of(resultTy)
    const names = paramTys.length >= 2 ? ['h', 'acc'] : ['h']
    const out: HofFn[] = []
    for (const b of bodies) {
      const paramList = names.join(' ')
      out.push({
        src: `(fn ${paramList} -> ${b.src})`,
        size: b.size,
        apply: (outer, args) => {
          const env = outer.slice()
          if (paramTys.length >= 1) env[IN_HEAD] = args[0]
          if (paramTys.length >= 2) env[IN_ACC] = args[1]
          return b.fn(env)
        },
        body: (p0, p1) => renameBody(b.src, p0, p1),
      })
    }
    // smallest bodies first
    out.sort((a, b) => a.size - b.size)
    cache.set(cacheKey, out)
    return out
  }
}

function renameBody(src: string, p0: string, p1: string): string {
  // Replace whole-word `h`/`acc` with the caller's parameter names.
  return src.replace(/\bh\b/g, p0).replace(/\bacc\b/g, p1)
}

function cartesian(lists: Value[][], f: (vals: Value[]) => void): void {
  const rec = (i: number, acc: Value[]): void => {
    if (i === lists.length) {
      f(acc)
      return
    }
    for (const v of lists[i]) rec(i + 1, [...acc, v])
  }
  rec(0, [])
}

/** How long to keep searching *after* the first solution, to harvest alternatives. */
const HARVEST_MS = 700
/** How many distinct solutions to collect before stopping the harvest. */
const HARVEST_TARGET = 48

export function synthesize(spec: Spec, limitsIn?: Partial<SearchLimits>): SynthResult {
  const t0 = nowMs()
  const limits = { ...DEFAULT_LIMITS, ...limitsIn }
  const empty: SynthResult = {
    ok: false,
    program: null,
    playgroundSrc: null,
    paramName: 'x',
    paramNames: ['x'],
    type: null,
    goalType: '',
    size: null,
    candidates: 0,
    classes: 0,
    millis: 0,
    verified: false,
    message: '',
    rows: [],
    alternatives: [],
    ambiguity: null,
  }

  if (spec.examples.length === 0) return { ...empty, message: 'Add at least one example (input => output).' }

  // Every example must supply the same number of arguments.
  const argCount = spec.examples[0].inputs.length
  if (argCount < 1) return { ...empty, message: 'Each example needs at least one input.' }
  if (argCount > MAX_ARGS) return { ...empty, message: `At most ${MAX_ARGS} arguments are supported.` }
  for (const ex of spec.examples)
    if (ex.inputs.length !== argCount)
      return { ...empty, message: `All examples must take the same number of arguments (${argCount}).` }
  const argNames = ARG_NAMES.slice(0, argCount)
  setVarNames(argNames)

  // goal shape — one input shape per argument, plus the output shape
  const inShapes: STy[] = argNames.map(() => TANY as STy)
  let outShape: STy = TANY
  try {
    for (const ex of spec.examples) {
      for (let i = 0; i < argCount; i++) inShapes[i] = mergeTy(inShapes[i], shapeOf(ex.inputs[i]))
      outShape = mergeTy(outShape, shapeOf(ex.output))
    }
  } catch (e) {
    return { ...empty, message: (e as Error).message }
  }
  for (let i = 0; i < argCount; i++) inShapes[i] = groundTy(inShapes[i])
  outShape = groundTy(outShape)
  const goalType = [...inShapes.map(styToString), styToString(outShape)].join(' -> ')

  const rows: Env[] = spec.examples.map((ex) => {
    const env: Env = []
    for (let i = 0; i < argCount; i++) env[i] = ex.inputs[i]
    return env
  })
  const targets = spec.examples.map((ex) => ex.output)

  // integer constants worth trying: those literally appearing in the examples
  const extraInts = collectInts([...targets, ...spec.examples.flatMap((ex) => ex.inputs)])

  const bank = new Bank()
  for (let i = 0; i < argCount; i++) {
    const idx = i
    bank.add(term(argNames[i], true, inShapes[i], 1, (env) => env[idx], rows))
  }
  seedConstants(bank, outShape, rows, extraInts)
  for (const s of inShapes) seedConstants(bank, s, rows, extraInts)

  const argReps = spec.examples.map((ex) => ex.inputs[0])
  const innerSearch = makeInner(argReps)
  const deadline = t0 + limits.timeBudgetMs
  const outKey = tyKey(outShape)
  const goal = (t: Term): boolean => tyKey(t.ty) === outKey && vecMatches(t.vec, targets)

  // Harvest *all* solutions (not just the first) so we can rank them and detect
  // ambiguity. Distinct by rendered source; capped so a flood of trivial
  // siblings can't crowd the buffer.
  const collected: Term[] = []
  const collectedSrc = new Set<string>()
  const collect = (t: Term): void => {
    if (collectedSrc.has(t.src) || collectedSrc.size >= 400) return
    collectedSrc.add(t.src)
    collected.push(t)
  }

  const opts: GrowOpts = {
    rows,
    maxTermSize: limits.maxTermSize,
    perTypeCap: limits.perTypeCap,
    fanout: limits.fanout,
    allowHof: true,
    deadline,
    goal,
    collect,
    hofInner: (el, res) => innerSearch([el], res),
    hofInner2: (el, acc) => innerSearch([el, acc], acc),
  }

  // Maybe a seeded/constant term already matches.
  for (const t of bank.of(outShape)) if (goal(t)) collect(t)

  let firstHit = collected.length > 0
  let deadline2 = firstHit ? Math.min(deadline, nowMs() + HARVEST_MS) : deadline
  let round = 0
  while (round < limits.maxRounds && bank.size < limits.maxCandidates && nowMs() < deadline2) {
    const res = growPass(bank, opts)
    if (res.hit && !firstHit) {
      firstHit = true
      deadline2 = Math.min(deadline, nowMs() + HARVEST_MS)
    }
    round++
    if (res.added === 0) break
    if (firstHit && collected.length >= HARVEST_TARGET) break
  }
  // Only if no straight-line program exists do we resort to learning a
  // piecewise `if` — this keeps clean solutions from being upstaged by an
  // over-fit conditional that merely happens to match the examples.
  if (collected.length === 0) {
    const cond = learnConditional(bank, outShape, rows, targets)
    if (cond) collect(cond)
  }
  // Still nothing? Reach for genuine recursion — a `let rec` over a list argument
  // that the fold combinators cannot express (paramorphisms that read the tail,
  // guarded/polyadic recursion). Kept last, on its own budget, so a straight-line
  // or fold solution is never upstaged by a heavier recursive one.
  if (collected.length === 0) {
    const recDeadline = nowMs() + 3000
    for (const rc of synthRecursion(argNames, inShapes, outShape, spec.examples, extraInts, recDeadline))
      collect(rc)
  }

  const millis = Math.round(nowMs() - t0)
  if (collected.length === 0) {
    return {
      ...empty,
      goalType,
      paramName: argNames[0],
      paramNames: argNames,
      candidates: bank.size,
      classes: bank.size,
      millis,
      message: `No program found within the budget (${bank.size} candidates, ${millis} ms). Try adding or simplifying examples.`,
    }
  }

  // Rank the harvested solutions: prefer ones that actually compile + run, then
  // smaller ASTs, then fewer VM steps (a genuine dynamic-cost tie-break).
  const distinct = uniqueBy(collected, (t) => t.src).sort((a, b) => a.size - b.size).slice(0, 24)
  const ranked = distinct
    .slice(0, 8)
    .map((t) => ({ t, steps: measureSteps(argNames, t.src, spec.examples, t.rec) }))
  ranked.sort((a, b) => {
    const ac = a.steps === null ? 1 : 0
    const bc = b.steps === null ? 1 : 0
    if (ac !== bc) return ac - bc
    if (a.t.size !== b.t.size) return a.t.size - b.t.size
    return (a.steps ?? 0) - (b.steps ?? 0)
  })
  const best = ranked[0].t

  const alternatives: Candidate[] = ranked
    .slice(1)
    .filter((r) => r.t.src !== best.src)
    .slice(0, 4)
    .map((r) => ({ program: prettyProgram(argNames, r.t.src, r.t.rec), size: r.t.size, steps: r.steps }))

  // Anti-overfitting: do any two consistent programs disagree on an unseen input?
  const ambiguity = detectAmbiguity(distinct.slice(0, 12), inShapes, argNames)

  const body = best.src
  const def = definition(argNames, body, best.rec)
  const verify = verifyProgram(def, spec.examples)
  const sample = spec.examples[0]
  const sampleCall = sample.inputSrcs.map((s) => `(${s})`).join(' ')
  return {
    ok: verify.ok,
    program: prettyProgram(argNames, body, best.rec),
    playgroundSrc: `${def.replace(/ in solve$/, ' in')}\nsolve ${sampleCall}`,
    paramName: argNames[0],
    paramNames: argNames,
    type: verify.type ?? goalType,
    goalType,
    size: best.size,
    candidates: bank.size,
    classes: collectedSrc.size,
    millis,
    verified: verify.ok,
    message: verify.ok
      ? `Found in ${millis} ms after ${bank.size} candidates${
          alternatives.length ? ` (and ${alternatives.length} more that fit)` : ''
        }.`
      : `Found a candidate but the compiler rejected it: ${verify.message}`,
    rows: verify.rows,
    alternatives,
    ambiguity,
  }
}

// ---------------------------------------------------------------------------
// Auto-CEGIS: close the disambiguation loop with a reference oracle.
//
// Plain `synthesize` surfaces a distinguishing input when the examples are
// ambiguous and asks *you* to label it. If you can supply a reference function
// (a slow/obvious implementation, a spec you want re-expressed, …), the loop
// below labels those inputs *for you*: synthesize → if ambiguous, evaluate the
// reference on the witness → add that as a new example → repeat, until the
// program is pinned down or a step budget runs out. This is counterexample-
// guided inductive synthesis with the reference as the verification oracle.
// ---------------------------------------------------------------------------

export interface CegisStep {
  input: string
  output: string
}

export interface CegisResult {
  result: SynthResult
  /** the examples the loop auto-labelled from the reference, in order */
  added: CegisStep[]
  iterations: number
  /** ended with a verified program and no residual ambiguity */
  converged: boolean
}

export function synthesizeWithOracle(
  spec: Spec,
  limitsIn?: Partial<SearchLimits>,
  maxIters = 6,
): CegisResult {
  const base = synthesize(spec, limitsIn)
  if (!spec.ref) return { result: base, added: [], iterations: 0, converged: base.ambiguity === null }

  const examples = spec.examples.slice()
  const added: CegisStep[] = []
  const seenWitness = new Set<string>()
  let result = base
  let iter = 0
  while (result.ok && result.ambiguity && iter < maxIters) {
    const amb = result.ambiguity
    if (seenWitness.has(amb.inputSrc)) break // no progress — the oracle already answered this
    seenWitness.add(amb.inputSrc)

    const argSrcs = splitTopLevel(amb.inputSrc)
    const refOut = evalExpr(`(${spec.ref}) ${argSrcs.map((s) => `(${s})`).join(' ')}`)
    if (refOut.error || !refOut.value) break // the reference can't answer — stop cleanly

    const inputs: Value[] = []
    let inputsOk = true
    for (const s of argSrcs) {
      const v = evalExpr(s)
      if (v.error || !v.value) {
        inputsOk = false
        break
      }
      inputs.push(v.value)
    }
    if (!inputsOk) break

    const outSrc = litSrc(refOut.value)
    examples.push({ inputs, output: refOut.value, inputSrcs: argSrcs, outputSrc: outSrc })
    added.push({ input: amb.inputSrc, output: outSrc })
    iter++
    result = synthesize({ ...spec, examples }, limitsIn)
  }
  return { result, added, iterations: iter, converged: result.ok && result.ambiguity === null }
}

/** Deduplicate, keeping first occurrence, by a string key. */
function uniqueBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of xs) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

/**
 * Run a candidate through the real pipeline on each example and sum the VM
 * instruction count — a *dynamic* cost used to break AST-size ties (so an O(n)
 * fold outranks an O(n²) one of equal source size). Returns null if the program
 * fails to compile or run, which also lets ranking prefer programs that stand up
 * to the genuine compiler.
 */
function measureSteps(argNames: string[], body: string, examples: Example[], rec = false): number | null {
  const def = definition(argNames, body, rec).replace(/ in solve$/, ' in')
  let total = 0
  for (const ex of examples.slice(0, 4)) {
    const call = `${def} solve ${ex.inputSrcs.map((s) => `(${s})`).join(' ')}`
    const res = runPipeline(call, { execute: true })
    if (res.error || !res.run || res.run.error || res.run.result === null) return null
    if (!sameValue(res.run.result, ex.output)) return null
    total += res.run.steps
  }
  return total
}

// ---------------------------------------------------------------------------
// Anti-overfitting: a distinguishing input (CEGIS witness).
//
// Every harvested program agrees on the given examples by construction. If two
// of them nevertheless disagree on some *other* input, the examples don't pin
// the function down — so we surface that input and both interpretations, and the
// user labels it to disambiguate. This is what kills the classic over-fit (a
// spurious `x % 2` that only coincides with `sign` on the handful of examples).
// ---------------------------------------------------------------------------

/** Richer per-type probes, tuned to expose disagreements between candidates. */
function distinguishProbe(t: STy): Value[] {
  switch (t.k) {
    case 'int':
      return [0, 1, 2, 3, 5, 7, -1, -2, -4].map(vint)
    case 'bool':
      return [vbool(true), vbool(false)]
    case 'str':
      return [vstr(''), vstr('a'), vstr('ab'), vstr('abc')]
    case 'unit':
      return [{ tag: 'unit' }]
    case 'list': {
      const p = distinguishProbe(t.el)
      const one = p[Math.min(1, p.length - 1)]
      const two = p[Math.min(2, p.length - 1)]
      const arrs: Value[][] = [[], [p[0]], [one], [p[0], one], [one, p[0]], [p[0], one, two]]
      return arrs.map(listFromArray)
    }
    case 'tuple': {
      const per = t.items.map((it) => distinguishProbe(it).slice(0, 3))
      const out: Value[] = []
      boundedCartesian(per, 12, (vals) => out.push({ tag: 'tuple', items: vals }))
      return out
    }
    default:
      return [vint(0)]
  }
}

/** Cartesian product of `lists`, calling `f` for at most `cap` tuples. */
function boundedCartesian(lists: Value[][], cap: number, f: (vals: Value[]) => void): void {
  let n = 0
  const rec = (i: number, acc: Value[]): void => {
    if (n >= cap) return
    if (i === lists.length) {
      n++
      f(acc)
      return
    }
    for (const v of lists[i]) {
      if (n >= cap) return
      rec(i + 1, [...acc, v])
    }
  }
  rec(0, [])
}

function detectAmbiguity(cands: Term[], inShapes: STy[], argNames: string[]): Ambiguity | null {
  if (cands.length < 2) return null
  // Only weigh *near-minimal* programs against each other: a distinguishing input
  // is only interesting if a comparably-simple alternative disagrees, not a
  // baroque over-fit that no one would prefer. `cands` arrives smallest-first.
  const bound = cands[0].size + 2
  cands = cands.filter((c) => c.size <= bound)
  if (cands.length < 2) return null
  const perArg = inShapes.map(distinguishProbe)
  let result: Ambiguity | null = null
  boundedCartesian(perArg, 400, (vals) => {
    if (result) return
    const env: Env = []
    for (let i = 0; i < vals.length; i++) env[i] = vals[i]
    // group candidates by their (defined) output at this input
    const byOut = new Map<string, Term>()
    for (const c of cands) {
      let v: Value | undefined
      try {
        v = c.fn(env)
      } catch {
        v = undefined
      }
      if (v === undefined) continue
      const k = valueToString(v)
      if (!byOut.has(k)) byOut.set(k, c)
    }
    if (byOut.size < 2) return
    // a genuine disagreement — take up to three interpretations, smallest first
    const opts = [...byOut.entries()]
      .map(([out, c]) => ({ out, c }))
      .sort((a, b) => a.c.size - b.c.size)
      .slice(0, 3)
    result = {
      inputSrc: vals.map(litSrc).join(', '),
      options: opts.map(({ out, c }) => ({ outputSrc: out, program: prettyProgram(argNames, c.src) })),
    }
  })
  return result
}

/** Source helpers the emitted program may reference (`fst`/`snd` on pairs). */
const HELPERS: Record<string, string> = {
  fst: 'let fst = fn p -> match p with (a, b) -> a in',
  snd: 'let snd = fn p -> match p with (a, b) -> b in',
}

/** The helper `let`s a body actually uses, in a stable order. */
function neededHelpers(body: string): string[] {
  const out: string[] = []
  for (const name of Object.keys(HELPERS)) if (new RegExp(`\\b${name}\\b`).test(body)) out.push(HELPERS[name])
  return out
}

/** A self-contained, runnable definition of `solve` (ending in `solve`). When
 * `rec` is set, `body` is already a self-referential `match` expression and we
 * emit `let rec solve … = body` so the recursive call resolves. */
function definition(argNames: string[], body: string, rec = false): string {
  const pre = neededHelpers(body)
  const decl = rec
    ? `let rec solve ${argNames.join(' ')} = ${body} in solve`
    : `let solve = fn ${argNames.join(' ')} -> ${body} in solve`
  return [...pre, decl].join('\n')
}

/** The headline the UI shows — helper `let`s plus a clausal `solve x y = …`. */
function prettyProgram(argNames: string[], body: string, rec = false): string {
  const pre = neededHelpers(body)
  const head = rec
    ? `let rec solve ${argNames.join(' ')} = ${body}`
    : `solve ${argNames.join(' ')} = ${body}`
  return [...pre, head].join('\n')
}

function vecMatches(vec: (Value | undefined)[], targets: Value[]): boolean {
  if (vec.length !== targets.length) return false
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]
    if (v === undefined || !sameValue(v, targets[i])) return false
  }
  return true
}

/** True on exactly the example rows selected by `pick`. */
function matchesOn(vec: (Value | undefined)[], targets: Value[], pick: (i: number) => boolean): boolean {
  for (let i = 0; i < targets.length; i++) {
    if (!pick(i)) continue
    const v = vec[i]
    if (v === undefined || !sameValue(v, targets[i])) return false
  }
  return true
}

/**
 * Learn a top-level `if c then t else e` that reproduces the examples: find a
 * boolean term whose truth value splits the rows, then a branch matching each
 * side. This is decision-list learning — far cheaper than blind c×t×e
 * enumeration, and it's how piecewise functions (clamp, sign, …) are found.
 */
function learnConditional(bank: Bank, outShape: STy, rows: Env[], targets: Value[]): Term | null {
  const outs = smallest(bank.of(outShape), 120)
  const conds = smallest(bank.of(TBOOL), 160)
  for (const c of conds) {
    const cv = c.vec
    let anyT = false
    let anyF = false
    let usable = true
    for (const v of cv) {
      if (v === undefined || v.tag !== 'bool') {
        usable = false
        break
      }
      if (v.b) anyT = true
      else anyF = true
    }
    if (!usable || !anyT || !anyF) continue // require a genuine split
    const pickT = (i: number): boolean => (cv[i] as { b: boolean }).b
    const pickF = (i: number): boolean => !(cv[i] as { b: boolean }).b
    let tT: Term | null = null
    let tF: Term | null = null
    for (const t of outs) {
      if (!tT && matchesOn(t.vec, targets, pickT)) tT = t
      if (!tF && matchesOn(t.vec, targets, pickF)) tF = t
      if (tT && tF) break
    }
    if (tT && tF && tT !== tF) {
      const term = ifTerm(outShape, rows, c, tT, tF)
      if (vecMatches(term.vec, targets)) return term
    }
  }
  return null
}

/**
 * Like {@link learnConditional} but returns *several* distinct guarded programs
 * (one per splitting condition), smallest first. The recursion tier uses this so
 * a spurious over-fit guard doesn't crowd out the clean one — every survivor is
 * re-checked by true recursion, and the smallest that survives wins.
 */
function learnConditionals(
  bank: Bank,
  outShape: STy,
  rows: Env[],
  targets: Value[],
  maxOut: number,
): Term[] {
  const outs = smallest(bank.of(outShape), 120)
  const conds = smallest(bank.of(TBOOL), 220)
  const res: Term[] = []
  const seen = new Set<string>()
  for (const c of conds) {
    const cv = c.vec
    let anyT = false
    let anyF = false
    let usable = true
    for (const v of cv) {
      if (v === undefined || v.tag !== 'bool') {
        usable = false
        break
      }
      if (v.b) anyT = true
      else anyF = true
    }
    if (!usable || !anyT || !anyF) continue
    const pickT = (i: number): boolean => (cv[i] as { b: boolean }).b
    const pickF = (i: number): boolean => !(cv[i] as { b: boolean }).b
    let tT: Term | null = null
    let tF: Term | null = null
    for (const t of outs) {
      if (!tT && matchesOn(t.vec, targets, pickT)) tT = t
      if (!tF && matchesOn(t.vec, targets, pickF)) tF = t
      if (tT && tF) break
    }
    if (tT && tF && tT !== tF) {
      const t = ifTerm(outShape, rows, c, tT, tF)
      if (vecMatches(t.vec, targets) && !seen.has(t.src)) {
        seen.add(t.src)
        res.push(t)
      }
    }
    if (res.length >= maxOut) break
  }
  return res.sort((a, b) => a.size - b.size)
}

// ---------------------------------------------------------------------------
// Structural recursion — `let rec solve … = match xs with [] -> … | h :: t -> …`.
//
// The fold combinators express *catamorphisms* (a strict right/left fold), but
// many everyday functions are not folds: a **paramorphism** needs the raw tail
// `t` (not merely the recursive result), and a **guarded / polyadic** recursion
// needs an inner `if` and/or a second decreasing argument (`take n`, `drop n`).
// This tier synthesizes those, extending the engine past every fold scheme.
//
// The method is a specialised bottom-up PBE:
//   • Split the examples on whether the recursed list argument is [] (base) or
//     h :: t (step). For every step example the recursive call's argument tuple
//     is looked up among the examples themselves — an *angelic* value for the
//     `rec = solve …` term (⊥ when that sub-problem isn't given as an example).
//   • Enumerate base bodies (over the other arguments) and step bodies (over
//     h, t, rec and the arguments) bottom-up, plus a decision-list `if` for a
//     guarded step.
//   • For every (base, step) pair, build the *true* recursive closure and test
//     it on ALL examples — the angelic oracle only seeds the search; genuine
//     recursion (and, downstream, the real compiler) has the final say.
// Recursion always descends on the structurally-smaller tail, so it is total.
// ---------------------------------------------------------------------------

interface RecScheme {
  label: string
  /** the argument tuple of the recursive `solve …` call, given the caller's args + the tail */
  recArgs: (args: Env, t: Value) => Env
  /** the rendered argument list of that recursive call (`t`, `(n - 1) t`, …) */
  recArgsSrc: string
}

/** The recursion schemes worth trying for a given list argument. */
function recSchemes(argNames: string[], inShapes: STy[], rIdx: number): RecScheme[] {
  const plainSrc = argNames.map((n, i) => (i === rIdx ? 't' : n)).join(' ')
  const out: RecScheme[] = [
    { label: 'tail', recArgs: (args, t) => args.map((a, i) => (i === rIdx ? t : a)), recArgsSrc: plainSrc },
  ]
  // a leading Int argument that decreases each step (take / drop / replicate …)
  for (let j = 0; j < inShapes.length; j++) {
    if (j === rIdx || inShapes[j].k !== 'int') continue
    const src = argNames.map((n, i) => (i === rIdx ? 't' : i === j ? `(${n} - 1)` : n)).join(' ')
    out.push({
      label: `dec ${argNames[j]}`,
      recArgs: (args, t) => args.map((a, i) => (i === rIdx ? t : i === j ? vint((asInt(a) ?? 0) - 1) : a)),
      recArgsSrc: src,
    })
    break // one decreasing counter covers the functions we target
  }
  return out
}

/** A few bottom-up growth rounds on a local bank (no combinators). */
function growLocal(bank: Bank, rows: Env[], rounds: number, maxTermSize: number): void {
  const g: GrowOpts = {
    rows,
    maxTermSize,
    perTypeCap: 90,
    fanout: 60,
    allowHof: false,
    deadline: Infinity,
    hofInner: () => [],
    hofInner2: () => [],
  }
  for (let i = 0; i < rounds; i++) if (growPass(bank, g).added === 0) break
}

/** The genuine recursive closure for a hypothesised (base, step) pair. Descends
 * on the tail, so it terminates; the depth guard is belt-and-braces. */
function makeRecClosure(
  baseFn: Sem,
  stepFn: Sem,
  scheme: RecScheme,
  rIdx: number,
  H: number,
  T: number,
  REC: number,
): (args: Env) => Value | undefined {
  const self = (args: Env, depth: number): Value | undefined => {
    if (depth > 5000) return undefined
    const lst = args[rIdx]
    if (lst === undefined) return undefined
    if (lst.tag === 'nil') return baseFn(args)
    if (lst.tag !== 'cons') return undefined
    const rv = self(scheme.recArgs(args, lst.tail), depth + 1)
    if (rv === undefined) return undefined
    const env = args.slice()
    env[H] = lst.head
    env[T] = lst.tail
    env[REC] = rv
    return stepFn(env)
  }
  return (args) => self(args, 0)
}

function synthRecursion(
  argNames: string[],
  inShapes: STy[],
  outShape: STy,
  examples: Example[],
  extraInts: number[],
  deadline: number,
): Term[] {
  const kArgs = argNames.length
  const H = kArgs
  const T = kArgs + 1
  const REC = kArgs + 2
  const results: Term[] = []
  const seenBody = new Set<string>()

  const listArgs: number[] = []
  for (let i = 0; i < kArgs; i++) if (inShapes[i].k === 'list') listArgs.push(i)
  if (listArgs.length === 0) return results

  // example lookup by argument-tuple, for the angelic `rec` oracle
  const argsKey = (vs: Env): string => vs.map(valKey).join('¦')
  const exampleMap = new Map<string, Value>()
  for (const ex of examples) exampleMap.set(argsKey(ex.inputs), ex.output)

  for (const rIdx of listArgs) {
    if (nowMs() > deadline) break
    const listTy = inShapes[rIdx]
    if (listTy.k !== 'list') continue
    const elemTy = listTy.el
    const baseEx = examples.filter((ex) => ex.inputs[rIdx]?.tag === 'nil')
    const stepEx = examples.filter((ex) => ex.inputs[rIdx]?.tag === 'cons')
    if (stepEx.length === 0) continue

    for (const scheme of recSchemes(argNames, inShapes, rIdx)) {
      if (nowMs() > deadline) break

      // ---- base bodies (the [] branch) ----
      setVarNames(argNames)
      const baseTargets = baseEx.map((ex) => ex.output)
      let baseCands: Term[]
      if (baseEx.length > 0) {
        const baseRows: Env[] = baseEx.map((ex) => ex.inputs.slice())
        const bbank = new Bank()
        for (let i = 0; i < kArgs; i++) {
          const idx = i
          bbank.add(term(argNames[i], true, inShapes[i], 1, (env) => env[idx], baseRows))
        }
        seedConstants(bbank, outShape, baseRows, extraInts)
        for (const s of inShapes) seedConstants(bbank, s, baseRows, extraInts)
        growLocal(bbank, baseRows, 3, 6)
        baseCands = bbank
          .of(outShape)
          .filter((t) => vecMatches(t.vec, baseTargets))
          .sort((a, b) => a.size - b.size)
          .slice(0, 6)
      } else {
        const bbank = new Bank()
        seedConstants(bbank, outShape, [[]], extraInts)
        baseCands = bbank.of(outShape).sort((a, b) => a.size - b.size).slice(0, 4)
      }
      if (baseCands.length === 0) continue

      // ---- step bodies (the h :: t branch), with an angelic `rec` ----
      setVarNames(argNames, ['h', 't'])
      const stepRows: Env[] = []
      const stepTargets: Value[] = []
      const wildcard = new Set<number>()
      stepEx.forEach((ex, i) => {
        const lst = ex.inputs[rIdx] as Extract<Value, { tag: 'cons' }>
        const env: Env = ex.inputs.slice()
        env[H] = lst.head
        env[T] = lst.tail
        const rv = exampleMap.get(argsKey(scheme.recArgs(ex.inputs, lst.tail)))
        env[REC] = rv
        if (rv === undefined) wildcard.add(i)
        stepRows.push(env)
        stepTargets.push(ex.output)
      })

      const sbank = new Bank()
      for (let i = 0; i < kArgs; i++) {
        const idx = i
        sbank.add(term(argNames[i], true, inShapes[i], 1, (env) => env[idx], stepRows))
      }
      sbank.add(term('h', true, elemTy, 1, (env) => env[H], stepRows))
      sbank.add(term('t', true, listTy, 1, (env) => env[T], stepRows))
      sbank.add(term(`solve ${scheme.recArgsSrc}`, false, outShape, 1, (env) => env[REC], stepRows))
      seedConstants(sbank, outShape, stepRows, extraInts)
      seedConstants(sbank, elemTy, stepRows, extraInts)
      for (const s of inShapes) seedConstants(sbank, s, stepRows, extraInts)
      growLocal(sbank, stepRows, 4, 8)

      const matchStep = (vec: (Value | undefined)[]): boolean => {
        for (let i = 0; i < stepTargets.length; i++) {
          if (wildcard.has(i)) continue
          const v = vec[i]
          if (v === undefined || !sameValue(v, stepTargets[i])) return false
        }
        return true
      }
      const plainStep = sbank
        .of(outShape)
        .filter((t) => matchStep(t.vec))
        .sort((a, b) => a.size - b.size)
        .slice(0, wildcard.size === stepTargets.length ? 30 : 80)
      // guarded steps (decision-list `if`), smallest first — only when every row
      // is pinned. Tried *before* the plain bodies so a clean guard wins by size.
      const guards = wildcard.size === 0 ? learnConditionals(sbank, outShape, stepRows, stepTargets, 12) : []
      const stepCands = [...guards, ...plainStep]
      if (stepCands.length === 0) continue

      // ---- assemble each (base, step) pair and test by *true* recursion ----
      // every survivor is checked by genuine recursion on ALL examples; the
      // angelic oracle above only ordered the search.
      let attempts = 0
      for (const step of stepCands) {
        if (attempts >= 900 || nowMs() > deadline || results.length >= 40) break
        for (const base of baseCands) {
          if (attempts >= 900 || nowMs() > deadline) break
          attempts++
          const bodySrc = `match ${argNames[rIdx]} with | [] -> ${base.src} | h :: t -> ${step.src}`
          if (seenBody.has(bodySrc)) continue
          seenBody.add(bodySrc)
          const self = makeRecClosure(base.fn, step.fn, scheme, rIdx, H, T, REC)
          const vec: (Value | undefined)[] = []
          let ok = true
          for (const ex of examples) {
            const got = self(ex.inputs)
            vec.push(got)
            if (got === undefined || !sameValue(got, ex.output)) {
              ok = false
              break
            }
          }
          if (!ok) continue
          results.push({
            src: bodySrc,
            atom: false,
            ty: outShape,
            size: base.size + step.size + 2,
            fn: (env) => self(env.slice(0, kArgs)),
            vec,
            usesVar: true,
            rec: true,
            rName: argNames[rIdx],
          })
        }
      }
    }
  }
  setVarNames(argNames) // restore the module regex for anything downstream
  return results.sort((a, b) => a.size - b.size).slice(0, 8)
}

function collectInts(vs: Value[]): number[] {
  const out = new Set<number>()
  const walk = (v: Value): void => {
    if (v.tag === 'int' || v.tag === 'float') out.add(v.n | 0)
    else if (v.tag === 'cons') for (const it of listToArray(v)) walk(it)
    else if (v.tag === 'tuple') for (const it of v.items) walk(it)
  }
  for (const v of vs) walk(v)
  return [...out].filter((n) => Math.abs(n) <= 1000)
}

// ---------------------------------------------------------------------------
// Verification through the real compiler.
// ---------------------------------------------------------------------------

interface VerifyOut {
  ok: boolean
  type: string | null
  message: string
  rows: { input: string; expected: string; got: string; ok: boolean }[]
}

function verifyProgram(program: string, examples: Example[]): VerifyOut {
  // type of the function
  let type: string | null = null
  const tRes = runPipeline(program, { execute: false })
  if (!tRes.error) type = tRes.programType

  const rows: VerifyOut['rows'] = []
  let allOk = true
  let message = ''
  for (const ex of examples) {
    // `program` is `let solve = fn x y -> body in solve`; apply it to the args.
    const call = `${program.replace(/ in solve$/, ' in')} solve ${ex.inputSrcs
      .map((s) => `(${s})`)
      .join(' ')}`
    const res = runPipeline(call, { execute: true })
    let got = '⟨error⟩'
    let ok = false
    if (res.error) {
      message = res.error.message
      got = `error: ${res.error.message}`
    } else if (res.run && res.run.result) {
      got = valueToString(res.run.result)
      ok = sameValue(res.run.result, ex.output)
    }
    if (!ok) allOk = false
    rows.push({ input: ex.inputSrcs.join(', '), expected: ex.outputSrc, got, ok })
  }
  return { ok: allOk && !tRes.error, type, message, rows }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// ---------------------------------------------------------------------------
// Spec parsing: lines of `input => output`, an optional `-- type` hint.
// ---------------------------------------------------------------------------

export function parseSpec(text: string): { spec: Spec | null; error: string | null } {
  const examples: Example[] = []
  let typeHint: string | null = null
  let ref: string | null = null
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    // a reference oracle: `ref: <function>` (with or without a leading `--`).
    const refMatch = line.match(/^(?:--\s*)?ref:\s*(.+)$/)
    if (refMatch) {
      ref = refMatch[1].trim()
      continue
    }
    if (line.startsWith('--')) {
      const h = line.replace(/^--\s*/, '')
      if (h.includes('->')) typeHint = h
      continue
    }
    const arrow = splitArrow(line)
    if (!arrow) return { spec: null, error: `Expected "input => output": ${line}` }
    const [lhs, rhs] = arrow
    // The left side is one or more arguments separated by *top-level* commas
    // (commas inside (), [] or a string stay together, so `(2, 3)` is one tuple
    // argument while `2, 3` is two arguments).
    const inputSrcs = splitTopLevel(lhs)
    const inputs: Value[] = []
    for (const src of inputSrcs) {
      const inV = evalExpr(src)
      if (inV.error) return { spec: null, error: `Bad input ${src}: ${inV.error}` }
      inputs.push(inV.value as Value)
    }
    const outV = evalExpr(rhs)
    if (outV.error) return { spec: null, error: `Bad output ${rhs}: ${outV.error}` }
    examples.push({
      inputs,
      output: outV.value as Value,
      inputSrcs,
      outputSrc: rhs,
    })
  }
  if (examples.length === 0) return { spec: null, error: 'No examples found.' }
  return { spec: { examples, typeHint, ref }, error: null }
}

function splitArrow(line: string): [string, string] | null {
  const i = line.indexOf('=>')
  if (i < 0) return null
  return [line.slice(0, i).trim(), line.slice(i + 2).trim()]
}

/** Split on commas that are not nested in (), [] or a string literal. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inStr = false
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push(src.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(src.slice(start).trim())
  return parts.filter((p) => p.length > 0)
}

function evalExpr(src: string): { value: Value | null; error: string | null } {
  const res = runPipeline(src, { execute: true })
  if (res.error) return { value: null, error: res.error.message }
  if (!res.run || res.run.error) return { value: null, error: res.run?.error ?? 'no result' }
  if (!res.run.result) return { value: null, error: 'no value produced' }
  return { value: res.run.result, error: null }
}

// ---------------------------------------------------------------------------
// A curated gallery of tasks (all solved by the engine — used in the UI).
// ---------------------------------------------------------------------------

export interface GalleryTask {
  id: string
  title: string
  blurb: string
  spec: string
}

export const GALLERY: GalleryTask[] = [
  {
    id: 'double',
    title: 'Double',
    blurb: 'A first-order arithmetic function.',
    spec: `-- Int -> Int
3 => 6
5 => 10
0 => 0`,
  },
  {
    id: 'abs',
    title: 'Absolute value',
    blurb: 'Needs a synthesized `if`.',
    spec: `-- Int -> Int
3 => 3
0 => 0
-4 => 4
-1 => 1`,
  },
  {
    id: 'sum',
    title: 'Sum a list',
    blurb: 'foldr (+) 0 — an accumulator fold.',
    spec: `-- List Int -> Int
[] => 0
[5] => 5
[1, 2, 3] => 6
[10, 20] => 30`,
  },
  {
    id: 'length',
    title: 'Length',
    blurb: 'A fold that ignores the element.',
    spec: `-- List Int -> Int
[] => 0
[9] => 1
[3, 3, 3] => 3
[1, 2] => 2`,
  },
  {
    id: 'doubleAll',
    title: 'Double every element',
    blurb: 'map with a synthesized body.',
    spec: `-- List Int -> List Int
[] => []
[1, 2, 3] => [2, 4, 6]
[5] => [10]`,
  },
  {
    id: 'evens',
    title: 'Keep the evens',
    blurb: 'filter with a synthesized predicate.',
    spec: `-- List Int -> List Int
[1, 2, 3, 4] => [2, 4]
[7] => []
[2, 4, 6] => [2, 4, 6]`,
  },
  {
    id: 'reverse',
    title: 'Reverse',
    blurb: 'A one-token library match.',
    spec: `-- List Int -> List Int
[1, 2, 3] => [3, 2, 1]
[] => []
[9, 8] => [8, 9]`,
  },
  {
    id: 'maxInList',
    title: 'Running maximum (foldl)',
    blurb: 'A left fold with a compare-and-pick body.',
    spec: `-- List Int -> Int
[3, 1, 4, 1, 5] => 5
[2] => 2
[7, 7, 2] => 7`,
  },
  {
    id: 'sumPair',
    title: 'Add a pair',
    blurb: 'Tuple projection with fst/snd.',
    spec: `-- (Int, Int) -> Int
(2, 3) => 5
(10, 1) => 11
(0, 0) => 0`,
  },
  {
    id: 'count',
    title: 'Count the evens',
    blurb: 'filter, then length — a composition.',
    spec: `-- List Int -> Int
[1, 2, 3, 4] => 2
[2, 4, 6] => 3
[1, 3] => 0`,
  },
  {
    id: 'product',
    title: 'Product of a list',
    blurb: 'A multiplying fold, base case 1.',
    spec: `-- List Int -> Int
[] => 1
[5] => 5
[2, 3] => 6
[2, 2, 2] => 8`,
  },
  {
    id: 'negate',
    title: 'Negate every element',
    blurb: 'map with a subtraction body.',
    spec: `-- List Int -> List Int
[1, 2, 3] => [-1, -2, -3]
[5] => [-5]
[] => []`,
  },
  {
    id: 'clampPos',
    title: 'Clamp below at zero',
    blurb: 'Discovers the library `max`.',
    spec: `-- Int -> Int
-3 => 0
5 => 5
0 => 0
-1 => 0`,
  },
  {
    id: 'hasZero',
    title: 'Contains a zero?',
    blurb: 'A membership test → Bool.',
    spec: `-- List Int -> Bool
[1, 0, 2] => true
[1, 2] => false
[0] => true`,
  },
  {
    id: 'isEmpty',
    title: 'Is the list empty?',
    blurb: 'A fold that collapses to a Bool.',
    spec: `-- List Int -> Bool
[] => true
[1] => false
[3, 4] => false`,
  },
  {
    id: 'add2',
    title: 'Add two numbers',
    blurb: 'Two arguments — no tupling.',
    spec: `-- Int -> Int -> Int
2, 3 => 5
10, 1 => 11
0, 0 => 0
7, -2 => 5`,
  },
  {
    id: 'max2',
    title: 'Larger of two',
    blurb: 'Discovers the library `max` on two args.',
    spec: `-- Int -> Int -> Int
3, 5 => 5
9, 2 => 9
4, 4 => 4
-1, -6 => -1`,
  },
  {
    id: 'scale',
    title: 'Scale then offset',
    blurb: 'Three arguments: a·x + b.',
    spec: `-- Int -> Int -> Int -> Int
2, 3, 1 => 7
1, 0, 5 => 5
3, 2, 2 => 8`,
  },
  {
    id: 'consFront',
    title: 'Prepend an element',
    blurb: 'An Int and a List argument, no tupling.',
    spec: `-- Int -> List Int -> List Int
0, [1, 2] => [0, 1, 2]
5, [] => [5]
9, [8, 7] => [9, 8, 7]`,
  },
  {
    id: 'member',
    title: 'Is x in the list?',
    blurb: 'Two args: an element and a list → Bool.',
    spec: `-- Int -> List Int -> Bool
3, [1, 2, 3] => true
0, [1, 2] => false
5, [5] => true
0, [0] => true
4, [1, 2] => false`,
  },
  {
    id: 'ambiguous',
    title: 'Ambiguous by design',
    blurb: 'Identity and squaring agree here — watch the ambiguity warning fire.',
    spec: `-- Int -> Int
0 => 0
1 => 1`,
  },
  {
    id: 'countOcc',
    title: 'Count occurrences (recursive)',
    blurb: 'let rec — a guarded count no fold can express (the lambda can’t see x).',
    spec: `-- Int -> List Int -> Int
2, [] => 0
2, [2] => 1
2, [3] => 0
2, [3,2] => 1
2, [2,3] => 1
5, [] => 0
5, [5] => 1
5, [4] => 0
5, [5,5] => 2
5, [4,5] => 1`,
  },
  {
    id: 'dropLast',
    title: 'Drop the last element (recursive)',
    blurb: 'let rec — the [] base case rescues what head/tail can’t do.',
    spec: `-- List Int -> List Int
[] => []
[7] => []
[3,0] => [3]
[0,3] => [0]
[1,2,3] => [1,2]
[2,3] => [2]
[3] => []
[0] => []
[5,5,5] => [5,5]
[5,5] => [5]
[5] => []`,
  },
  {
    id: 'takeWhilePos',
    title: 'Take while non-negative (recursive)',
    blurb: 'let rec — a guarded early stop; the recursion halts at the first negative.',
    spec: `-- List Int -> List Int
[] => []
[3] => [3]
[6] => [6]
[7] => [7]
[5] => [5]
[-1] => []
[-2] => []
[3,6] => [3,6]
[6,7] => [6,7]
[3,-1] => [3]
[-1,3] => []
[-2,6] => []
[5,-2,6] => [5]
[6,7,5] => [6,7,5]
[7,5] => [7,5]`,
  },
  {
    id: 'cegisSquare',
    title: 'Auto-CEGIS: pin down squaring',
    blurb: 'A reference oracle auto-labels the ambiguous inputs until only x*x fits.',
    spec: `-- Int -> Int
ref: fn x -> x * x
0 => 0
1 => 1`,
  },
]

// ---------------------------------------------------------------------------
// Engine self-check. Runs a battery of specs end-to-end (the full search + the
// real-compiler verification) and asserts the expected outcome, so the app can
// prove the synthesizer still works after any change — and so it can be driven
// headlessly from Node. Pure logic, no DOM.
// ---------------------------------------------------------------------------

export interface SynthSelfCase {
  name: string
  spec: string
  /** 'found' → a verified program; 'none' → nothing should be found */
  expect: 'found' | 'none'
  /** if set, the reported ambiguity flag must equal this */
  ambiguous?: boolean
  /** if true, the found program must be recursive (`let rec …`) */
  rec?: boolean
  /** if set, run the Auto-CEGIS loop; the final program's clause must end with this */
  cegisExpect?: string
}

export interface SynthSelfResult {
  name: string
  ok: boolean
  detail: string
}

export const SYNTH_SELF_CASES: SynthSelfCase[] = [
  { name: 'double (arithmetic)', spec: '3 => 6\n5 => 10\n0 => 0', expect: 'found' },
  { name: 'sum (foldr)', spec: '[] => 0\n[5] => 5\n[1,2,3] => 6', expect: 'found' },
  { name: 'reverse (library)', spec: '[1,2,3] => [3,2,1]\n[] => []\n[9,8] => [8,9]', expect: 'found' },
  { name: 'double each (map)', spec: '[] => []\n[1,2,3] => [2,4,6]\n[5] => [10]', expect: 'found' },
  { name: 'keep evens (filter)', spec: '[1,2,3,4] => [2,4]\n[7] => []\n[2,4,6] => [2,4,6]', expect: 'found' },
  { name: 'abs (learned if)', spec: '3 => 3\n0 => 0\n-4 => 4\n-1 => 1', expect: 'found' },
  { name: 'add (two args)', spec: '2,3 => 5\n10,1 => 11\n0,0 => 0\n7,-2 => 5', expect: 'found' },
  { name: 'max (two args)', spec: '3,5 => 5\n9,2 => 9\n4,4 => 4\n-1,-6 => -1', expect: 'found' },
  { name: 'first of two (proj)', spec: '4,9 => 4\n1,2 => 1\n8,3 => 8', expect: 'found' },
  { name: 'ambiguity detected', spec: '0 => 0\n1 => 1', expect: 'found', ambiguous: true },
  // Negation covers the whole Bool domain, so no distinguishing input exists.
  { name: 'no ambiguity on negation', spec: 'true => false\nfalse => true', expect: 'found', ambiguous: false },
  { name: 'impossible spec', spec: '1 => "a"\n2 => 5', expect: 'none' },
  // Structural recursion — programs the fold combinators cannot express.
  {
    name: 'count occurrences (let rec)',
    spec: '2,[] => 0\n2,[2] => 1\n2,[3] => 0\n2,[3,2] => 1\n2,[2,3] => 1\n5,[] => 0\n5,[5] => 1\n5,[4] => 0\n5,[5,5] => 2\n5,[4,5] => 1',
    expect: 'found',
    rec: true,
  },
  {
    name: 'drop last (let rec)',
    spec: '[] => []\n[7] => []\n[3,0] => [3]\n[0,3] => [0]\n[1,2,3] => [1,2]\n[2,3] => [2]\n[3] => []\n[0] => []\n[5,5,5] => [5,5]\n[5,5] => [5]\n[5] => []',
    expect: 'found',
    rec: true,
  },
  {
    name: 'take while non-negative (let rec)',
    spec: '[] => []\n[3] => [3]\n[6] => [6]\n[7] => [7]\n[5] => [5]\n[-1] => []\n[-2] => []\n[3,6] => [3,6]\n[6,7] => [6,7]\n[3,-1] => [3]\n[-1,3] => []\n[-2,6] => []\n[5,-2,6] => [5]\n[6,7,5] => [6,7,5]\n[7,5] => [7,5]',
    expect: 'found',
    rec: true,
  },
  // Auto-CEGIS — a reference oracle steers past the ambiguity to the intended program.
  {
    name: 'Auto-CEGIS pins x*x',
    spec: 'ref: fn x -> x * x\n0 => 0\n1 => 1',
    expect: 'found',
    cegisExpect: 'x * x',
  },
  {
    name: 'Auto-CEGIS pins identity',
    spec: 'ref: fn x -> x\n0 => 0\n1 => 1',
    expect: 'found',
    cegisExpect: 'x',
  },
]

/** Run the self-check battery; each row reports pass/fail with a detail string. */
export function runSynthSelfTests(cases: SynthSelfCase[] = SYNTH_SELF_CASES): SynthSelfResult[] {
  return cases.map((c) => {
    const parsed = parseSpec(c.spec)
    if (!parsed.spec) {
      // A spec that fails to parse only "passes" when we expected nothing found.
      return { name: c.name, ok: c.expect === 'none', detail: `parse: ${parsed.error}` }
    }
    // Auto-CEGIS cases run the reference-oracle loop and assert the clause it lands on.
    if (c.cegisExpect !== undefined) {
      let cg: CegisResult
      try {
        cg = synthesizeWithOracle(parsed.spec)
      } catch (e) {
        return { name: c.name, ok: false, detail: `threw: ${(e as Error).message}` }
      }
      const clause = (cg.result.program ?? '').split('\n').pop()?.trim() ?? ''
      const ok = cg.result.ok && cg.result.verified && clause.endsWith(c.cegisExpect)
      return {
        name: c.name,
        ok,
        detail: ok
          ? `${clause} · +${cg.added.length} labelled · ${cg.iterations} iters`
          : `expected …${c.cegisExpect}, got ${clause || '(none)'}`,
      }
    }

    let r: SynthResult
    try {
      r = synthesize(parsed.spec)
    } catch (e) {
      return { name: c.name, ok: false, detail: `threw: ${(e as Error).message}` }
    }
    if (c.expect === 'none') {
      const ok = !r.ok
      return { name: c.name, ok, detail: ok ? 'correctly found nothing' : `unexpected: ${r.program}` }
    }
    if (!r.ok || !r.verified) {
      return { name: c.name, ok: false, detail: r.message || 'not found / not verified' }
    }
    if (c.rec && !(r.program ?? '').startsWith('let rec')) {
      return { name: c.name, ok: false, detail: `expected a recursive program, got: ${r.program}` }
    }
    if (c.ambiguous !== undefined) {
      const got = r.ambiguity !== null
      if (got !== c.ambiguous) {
        return {
          name: c.name,
          ok: false,
          detail: `ambiguity expected ${c.ambiguous}, got ${got}`,
        }
      }
    }
    return { name: c.name, ok: true, detail: `${(r.program ?? '').split('\n').pop()} · ${r.millis}ms` }
  })
}
