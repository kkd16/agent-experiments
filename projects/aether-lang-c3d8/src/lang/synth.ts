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

// Every synthesized variable is named `x` (the argument) or `h`/`acc` (lambda
// parameters), and no component keyword contains those as a whole word — so a
// term reads a variable iff its rendered source mentions one.
const HASVAR = /\b(?:x|h|acc)\b/

/** Build a term, deriving `vec` and `usesVar` from the pieces. */
function term(src: string, atom: boolean, ty: STy, size: number, fn: Sem, rows: Env[]): Term {
  return { src, atom, ty, size, fn, vec: evalVec(fn, rows), usesVar: HASVAR.test(src) }
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
    if (!hit && opts.goal && opts.goal(t)) hit = t
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
  input: Value
  output: Value
  inputSrc: string
  outputSrc: string
}

export interface Spec {
  examples: Example[]
  typeHint: string | null
}

export interface SynthResult {
  ok: boolean
  program: string | null
  /** a self-contained snippet (helpers + `solve` + a sample call) for the Playground */
  playgroundSrc: string | null
  paramName: string
  type: string | null
  goalType: string
  size: number | null
  candidates: number
  classes: number
  millis: number
  verified: boolean
  message: string
  rows: { input: string; expected: string; got: string; ok: boolean }[]
}

const OUTER_X = 0 // env index of the argument variable
const IN_HEAD = 1 // inner lambda parameters
const IN_ACC = 2

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

export function synthesize(spec: Spec, limitsIn?: Partial<SearchLimits>): SynthResult {
  const t0 = nowMs()
  const limits = { ...DEFAULT_LIMITS, ...limitsIn }
  const empty: SynthResult = {
    ok: false,
    program: null,
    playgroundSrc: null,
    paramName: 'x',
    type: null,
    goalType: '',
    size: null,
    candidates: 0,
    classes: 0,
    millis: 0,
    verified: false,
    message: '',
    rows: [],
  }

  if (spec.examples.length === 0) return { ...empty, message: 'Add at least one example (input => output).' }

  // goal shape
  let inShape: STy = TANY
  let outShape: STy = TANY
  try {
    for (const ex of spec.examples) {
      inShape = mergeTy(inShape, shapeOf(ex.input))
      outShape = mergeTy(outShape, shapeOf(ex.output))
    }
  } catch (e) {
    return { ...empty, message: (e as Error).message }
  }
  inShape = groundTy(inShape)
  outShape = groundTy(outShape)
  const goalType = `${styToString(inShape)} -> ${styToString(outShape)}`

  const rows: Env[] = spec.examples.map((ex) => {
    const env: Env = []
    env[OUTER_X] = ex.input
    return env
  })
  const targets = spec.examples.map((ex) => ex.output)

  // integer constants worth trying: those literally appearing in outputs
  const extraInts = collectInts(targets)

  const bank = new Bank()
  const xFn: Sem = (env) => env[OUTER_X]
  bank.add(term('x', true, inShape, 1, xFn, rows))
  seedConstants(bank, outShape, rows, extraInts)
  seedConstants(bank, inShape, rows, extraInts)

  const argReps = spec.examples.map((ex) => ex.input)
  const innerSearch = makeInner(argReps)
  const deadline = t0 + limits.timeBudgetMs
  const outKey = tyKey(outShape)
  const goal = (t: Term): boolean => tyKey(t.ty) === outKey && vecMatches(t.vec, targets)
  const opts: GrowOpts = {
    rows,
    maxTermSize: limits.maxTermSize,
    perTypeCap: limits.perTypeCap,
    fanout: limits.fanout,
    allowHof: true,
    deadline,
    goal,
    hofInner: (el, res) => innerSearch([el], res),
    hofInner2: (el, acc) => innerSearch([el, acc], acc),
  }

  // Maybe a seeded/constant term already matches.
  let hit: Term | null = null
  for (const t of bank.of(outShape))
    if (vecMatches(t.vec, targets)) {
      hit = t
      break
    }
  let round = 0
  while (!hit && round < limits.maxRounds && bank.size < limits.maxCandidates && nowMs() < deadline) {
    const res = growPass(bank, opts)
    hit = res.hit
    round++
    if (res.added === 0) break
  }
  // Only if no straight-line program exists do we resort to learning a
  // piecewise `if` — this keeps clean solutions from being upstaged by an
  // over-fit conditional that merely happens to match the examples.
  if (!hit) hit = learnConditional(bank, outShape, rows, targets)

  const millis = Math.round(nowMs() - t0)
  if (!hit) {
    return {
      ...empty,
      goalType,
      candidates: bank.size,
      classes: bank.size,
      millis,
      message: `No program found within the budget (${bank.size} candidates, ${millis} ms). Try adding or simplifying examples.`,
    }
  }

  const body = hit.src
  const def = definition(body)
  const verify = verifyProgram(def, spec.examples)
  const sample = spec.examples[0]
  return {
    ok: verify.ok,
    program: prettyProgram(body),
    playgroundSrc: `${def.replace(/ in solve$/, ' in')}\nsolve (${sample.inputSrc})`,
    paramName: 'x',
    type: verify.type ?? goalType,
    goalType,
    size: hit.size,
    candidates: bank.size,
    classes: bank.size,
    millis,
    verified: verify.ok,
    message: verify.ok
      ? `Found in ${millis} ms after ${bank.size} candidates.`
      : `Found a candidate but the compiler rejected it: ${verify.message}`,
    rows: verify.rows,
  }
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

/** A self-contained, runnable definition of `solve` (ending in `solve`). */
function definition(body: string): string {
  const pre = neededHelpers(body)
  return [...pre, `let solve = fn x -> ${body} in solve`].join('\n')
}

/** The headline the UI shows — helper `let`s plus a clausal `solve x = …`. */
function prettyProgram(body: string): string {
  const pre = neededHelpers(body)
  return [...pre, `solve x = ${body}`].join('\n')
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
    // `program` is `let solve = fn x -> body in solve`; apply it to the input.
    const call = `${program.replace(/ in solve$/, ' in')} solve (${ex.inputSrc})`
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
    rows.push({ input: ex.inputSrc, expected: ex.outputSrc, got, ok })
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
  const lines = text.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('--')) {
      const h = line.replace(/^--\s*/, '')
      if (h.includes('->')) typeHint = h
      continue
    }
    const arrow = splitArrow(line)
    if (!arrow) return { spec: null, error: `Expected "input => output": ${line}` }
    const [lhs, rhs] = arrow
    const inV = evalExpr(lhs)
    if (inV.error) return { spec: null, error: `Bad input ${lhs}: ${inV.error}` }
    const outV = evalExpr(rhs)
    if (outV.error) return { spec: null, error: `Bad output ${rhs}: ${outV.error}` }
    examples.push({
      input: inV.value as Value,
      output: outV.value as Value,
      inputSrc: lhs,
      outputSrc: rhs,
    })
  }
  if (examples.length === 0) return { spec: null, error: 'No examples found.' }
  return { spec: { examples, typeHint }, error: null }
}

function splitArrow(line: string): [string, string] | null {
  const i = line.indexOf('=>')
  if (i < 0) return null
  return [line.slice(0, i).trim(), line.slice(i + 2).trim()]
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
]
