// Presburger arithmetic — first-order linear integer arithmetic with FULL
// quantifier alternation (∀/∃), decided by COOPER'S ALGORITHM (D.C. Cooper,
// 1972). The Omega test next door decides the *quantifier-free* fragment; this
// lifts the same theory to arbitrary ∀/∃ prefixes, which is a strictly larger
// language: "for every x there is a y with 2y = x or 2y = x+1" (every integer is
// even or odd) is a Presburger truth no QF_LIA query can state.
//
// Cooper eliminates one quantifier at a time from the inside out. To remove ∃x
// from a quantifier-free body it:
//   1. normalizes the coefficient of x to ±1 (multiplying each literal up to the
//      lcm of x's coefficients and re-variabling x ↦ ℓ·x, which adds a literal
//      `ℓ | x`);
//   2. forms the "−∞" formula F₋∞ — what the body becomes for sufficiently small
//      x (lower bounds fail, upper bounds hold, divisibilities stay periodic);
//   3. returns  ⋁_{j=1..δ} ( F₋∞[j] ∨ ⋁_{b∈B} F[b+j] ),  where δ is the lcm of
//      every divisor and B the set of lower-bound terms. Intuitively: either the
//      body holds arbitrarily far left (some residue j mod δ works), or there is
//      a least solution sitting just above some lower bound b, within δ of it.
// ∀x.φ is handled as ¬∃x.¬φ. Closed sentences collapse to ⊤/⊥; open formulas
// come back as an equivalent quantifier-free formula over the free variables.
//
// Everything is BigInt and exact. Divisibility literals `d | t` are first-class
// (Cooper manufactures them), so the result language is linear (in)equalities ∧
// modular constraints — exactly Presburger's quantifier-free normal form. The
// self-check cross-validates Cooper two independent ways: against the Omega test
// on existential conjunctions, and against an exhaustive bounded evaluator on
// box-guarded sentences and open formulas (where the bound makes brute force a
// complete oracle).

import {
  type Lin,
  addConst,
  coeff,
  constant,
  dropVar,
  evalLin,
  gcdBig,
  scale,
  variable,
  add as addLin,
} from './lin'

export type Formula =
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'lt'; t: Lin } // t < 0
  | { kind: 'dvd'; d: bigint; t: Lin } // d | t   (d > 0)
  | { kind: 'ndvd'; d: bigint; t: Lin } // d ∤ t
  | { kind: 'and'; xs: Formula[] }
  | { kind: 'or'; xs: Formula[] }
  | { kind: 'not'; x: Formula }
  | { kind: 'exists'; v: number; body: Formula }
  | { kind: 'forall'; v: number; body: Formula }

export class PresburgerBudgetError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'PresburgerBudgetError'
  }
}

// ----- builders --------------------------------------------------------------

export const T: Formula = { kind: 'true' }
export const F: Formula = { kind: 'false' }
export const ltF = (t: Lin): Formula => ({ kind: 'lt', t })
export const dvdF = (d: bigint, t: Lin): Formula => ({ kind: 'dvd', d: d < 0n ? -d : d, t })
export const ndvdF = (d: bigint, t: Lin): Formula => ({ kind: 'ndvd', d: d < 0n ? -d : d, t })
export const andF = (...xs: Formula[]): Formula => ({ kind: 'and', xs })
export const orF = (...xs: Formula[]): Formula => ({ kind: 'or', xs })
export const notF = (x: Formula): Formula => ({ kind: 'not', x })
export const existsF = (v: number, body: Formula): Formula => ({ kind: 'exists', v, body })
export const forallF = (v: number, body: Formula): Formula => ({ kind: 'forall', v, body })

// Comparison constructors, all reduced to the single strict atom `t < 0` over ℤ.
const sub = (a: Lin, b: Lin): Lin => addLin(a, scale(b, -1n))
export const lt = (a: Lin, b: Lin): Formula => ltF(sub(a, b)) // a < b
export const le = (a: Lin, b: Lin): Formula => ltF(addConst(sub(a, b), -1n)) // a ≤ b ⇔ a−b−1 < 0
export const gt = (a: Lin, b: Lin): Formula => lt(b, a)
export const ge = (a: Lin, b: Lin): Formula => le(b, a)
export const eq = (a: Lin, b: Lin): Formula => andF(le(a, b), le(b, a))
export const ne = (a: Lin, b: Lin): Formula => orF(lt(a, b), lt(b, a))

function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n
  const g = gcdBig(a, b)
  const r = (a / g) * b
  return r < 0n ? -r : r
}

// ----- negation-normal form --------------------------------------------------

/** NNF of ¬φ assuming φ is already in NNF (no `not` nodes). */
function negNNF(f: Formula): Formula {
  switch (f.kind) {
    case 'true':
      return F
    case 'false':
      return T
    case 'lt':
      // ¬(t < 0) ≡ t ≥ 0 ≡ −t − 1 < 0
      return ltF(addConst(scale(f.t, -1n), -1n))
    case 'dvd':
      return { kind: 'ndvd', d: f.d, t: f.t }
    case 'ndvd':
      return { kind: 'dvd', d: f.d, t: f.t }
    case 'and':
      return { kind: 'or', xs: f.xs.map(negNNF) }
    case 'or':
      return { kind: 'and', xs: f.xs.map(negNNF) }
    case 'exists':
      return { kind: 'forall', v: f.v, body: negNNF(f.body) }
    case 'forall':
      return { kind: 'exists', v: f.v, body: negNNF(f.body) }
    case 'not':
      return toNNF(f.x)
  }
}

/** Rewrite any formula into NNF (`not` pushed to atoms, none left over). */
export function toNNF(f: Formula): Formula {
  switch (f.kind) {
    case 'true':
    case 'false':
    case 'lt':
    case 'dvd':
    case 'ndvd':
      return f
    case 'and':
      return { kind: 'and', xs: f.xs.map(toNNF) }
    case 'or':
      return { kind: 'or', xs: f.xs.map(toNNF) }
    case 'not':
      return negNNF(toNNF(f.x))
    case 'exists':
      return { kind: 'exists', v: f.v, body: toNNF(f.body) }
    case 'forall':
      return { kind: 'forall', v: f.v, body: toNNF(f.body) }
  }
}

// ----- simplification --------------------------------------------------------

function isConst(t: Lin): boolean {
  return t.t.size === 0
}
function bmod(a: bigint, m: bigint): bigint {
  return ((a % m) + m) % m
}

/** Constant-fold a QF NNF formula; flatten and/or; drop ⊤/⊥. */
export function simplify(f: Formula): Formula {
  switch (f.kind) {
    case 'true':
    case 'false':
      return f
    case 'lt':
      if (isConst(f.t)) return f.t.c < 0n ? T : F
      return f
    case 'dvd':
      if (f.d === 1n) return T
      if (isConst(f.t)) return bmod(f.t.c, f.d) === 0n ? T : F
      return f
    case 'ndvd':
      if (f.d === 1n) return F
      if (isConst(f.t)) return bmod(f.t.c, f.d) !== 0n ? T : F
      return f
    case 'and': {
      const out: Formula[] = []
      for (const x of f.xs) {
        const s = simplify(x)
        if (s.kind === 'false') return F
        if (s.kind === 'true') continue
        if (s.kind === 'and') out.push(...s.xs)
        else out.push(s)
      }
      if (out.length === 0) return T
      if (out.length === 1) return out[0]
      return { kind: 'and', xs: out }
    }
    case 'or': {
      const out: Formula[] = []
      for (const x of f.xs) {
        const s = simplify(x)
        if (s.kind === 'true') return T
        if (s.kind === 'false') continue
        if (s.kind === 'or') out.push(...s.xs)
        else out.push(s)
      }
      if (out.length === 0) return F
      if (out.length === 1) return out[0]
      return { kind: 'or', xs: out }
    }
    case 'not':
      return simplify(negNNF(toNNF(f.x)))
    case 'exists':
    case 'forall':
      return f
  }
}

// ----- Cooper's existential elimination --------------------------------------

interface Budget {
  nodes: number
  max: number
}

/** Substitute `v ↦ value` (a v-free Lin) across a QF NNF formula. */
function substVar(f: Formula, v: number, value: Lin): Formula {
  switch (f.kind) {
    case 'true':
    case 'false':
      return f
    case 'lt': {
      const a = coeff(f.t, v)
      if (a === 0n) return f
      return ltF(addLin(dropVar(f.t, v), scale(value, a)))
    }
    case 'dvd': {
      const a = coeff(f.t, v)
      if (a === 0n) return f
      return { kind: 'dvd', d: f.d, t: addLin(dropVar(f.t, v), scale(value, a)) }
    }
    case 'ndvd': {
      const a = coeff(f.t, v)
      if (a === 0n) return f
      return { kind: 'ndvd', d: f.d, t: addLin(dropVar(f.t, v), scale(value, a)) }
    }
    case 'and':
      return { kind: 'and', xs: f.xs.map((x) => substVar(x, v, value)) }
    case 'or':
      return { kind: 'or', xs: f.xs.map((x) => substVar(x, v, value)) }
    default:
      throw new PresburgerBudgetError('substVar on a non-QF formula')
  }
}

/** The −∞ instance: lower bounds on v fail, upper bounds hold, mods stay. */
function minusInf(f: Formula, v: number): Formula {
  switch (f.kind) {
    case 'true':
    case 'false':
      return f
    case 'lt': {
      const a = coeff(f.t, v)
      if (a === 0n) return f
      // a·v + r < 0.  As v → −∞:  a>0 ⇒ true (v < −r/a holds); a<0 ⇒ false.
      return a > 0n ? T : F
    }
    case 'dvd':
    case 'ndvd':
      return f // periodic — kept verbatim
    case 'and':
      return { kind: 'and', xs: f.xs.map((x) => minusInf(x, v)) }
    case 'or':
      return { kind: 'or', xs: f.xs.map((x) => minusInf(x, v)) }
    default:
      throw new PresburgerBudgetError('minusInf on a non-QF formula')
  }
}

/** Collect every nonzero coefficient of v over the atoms of a QF NNF formula. */
function coeffsOf(f: Formula, v: number, out: bigint[]): void {
  switch (f.kind) {
    case 'lt':
    case 'dvd':
    case 'ndvd': {
      const a = coeff(f.t, v)
      if (a !== 0n) out.push(a < 0n ? -a : a)
      return
    }
    case 'and':
    case 'or':
      for (const x of f.xs) coeffsOf(x, v, out)
      return
    default:
      return
  }
}

/** Rescale v's coefficient to ±1 in every atom (×k); divisors scale with it. */
function unitize(f: Formula, v: number, ell: bigint): Formula {
  const fix = (t: Lin, scaleDivisor: bigint | null): { t: Lin; d?: bigint } => {
    const a = coeff(t, v)
    const k = ell / (a < 0n ? -a : a)
    const scaled = scale(t, k) // v-coeff is now ±ell
    const sgn = a < 0n ? -1n : 1n
    // Replace ±ell·v with ±1·v (the x ↦ ell·x re-variabling).
    const unit = addLin(dropVar(scaled, v), scale(variable(v), sgn))
    return scaleDivisor === null ? { t: unit } : { t: unit, d: scaleDivisor * k }
  }
  switch (f.kind) {
    case 'true':
    case 'false':
      return f
    case 'lt': {
      if (coeff(f.t, v) === 0n) return f
      return ltF(fix(f.t, null).t)
    }
    case 'dvd': {
      if (coeff(f.t, v) === 0n) return f
      const r = fix(f.t, f.d)
      return { kind: 'dvd', d: r.d!, t: r.t }
    }
    case 'ndvd': {
      if (coeff(f.t, v) === 0n) return f
      const r = fix(f.t, f.d)
      return { kind: 'ndvd', d: r.d!, t: r.t }
    }
    case 'and':
      return { kind: 'and', xs: f.xs.map((x) => unitize(x, v, ell)) }
    case 'or':
      return { kind: 'or', xs: f.xs.map((x) => unitize(x, v, ell)) }
    default:
      throw new PresburgerBudgetError('unitize on a non-QF formula')
  }
}

/** lcm of every divisor in dvd/ndvd atoms that mention v. */
function divisorLcm(f: Formula, v: number): bigint {
  let acc = 1n
  const walk = (g: Formula): void => {
    switch (g.kind) {
      case 'dvd':
      case 'ndvd':
        if (coeff(g.t, v) !== 0n) acc = lcm(acc, g.d)
        return
      case 'and':
      case 'or':
        for (const x of g.xs) walk(x)
        return
      default:
        return
    }
  }
  walk(f)
  return acc
}

/** Lower-bound terms b (from `−v + b < 0` ⇔ b < v) after unit-ization. */
function lowerBounds(f: Formula, v: number, out: Map<string, Lin>): void {
  switch (f.kind) {
    case 'lt': {
      const a = coeff(f.t, v)
      if (a === -1n) {
        const b = dropVar(f.t, v) // f.t = −v + b  ⇒ b = drop
        out.set(keyLin(b), b)
      }
      return
    }
    case 'and':
    case 'or':
      for (const x of f.xs) lowerBounds(x, v, out)
      return
    default:
      return
  }
}

function keyLin(t: Lin): string {
  const ids = [...t.t.keys()].sort((a, b) => a - b)
  return `${t.c}|${ids.map((i) => `${i}:${t.t.get(i)}`).join(',')}`
}

/** Eliminate ∃v from a quantifier-free NNF formula, returning QF NNF. */
function cooperExists(v: number, phi: Formula, budget: Budget): Formula {
  const f0 = simplify(phi)
  const cs: bigint[] = []
  coeffsOf(f0, v, cs)
  if (cs.length === 0) return f0 // v does not occur

  let ell = 1n
  for (const c of cs) ell = lcm(ell, c)
  let f1 = unitize(f0, v, ell)
  if (ell > 1n) f1 = { kind: 'and', xs: [f1, dvdF(ell, variable(v))] }

  const delta = divisorLcm(f1, v)
  const B = new Map<string, Lin>()
  lowerBounds(f1, v, B)
  const bounds = [...B.values()]

  // Budget guard against pathological δ·|B| blow-up.
  const work = Number(delta) * (bounds.length + 1)
  budget.nodes += work
  if (!Number.isFinite(work) || budget.nodes > budget.max) {
    throw new PresburgerBudgetError('Cooper elimination exceeded the in-browser budget')
  }

  const fMinusInf = minusInf(f1, v)
  const disjuncts: Formula[] = []
  for (let j = 1n; j <= delta; j++) {
    disjuncts.push(simplify(substVar(fMinusInf, v, constant(j))))
    for (const b of bounds) {
      disjuncts.push(simplify(substVar(f1, v, addConst(b, j))))
    }
  }
  return simplify({ kind: 'or', xs: disjuncts })
}

// ----- public driver ---------------------------------------------------------

export interface ElimResult {
  formula: Formula // quantifier-free NNF over the remaining free variables
  nodes: number
}

/**
 * Eliminate every quantifier from `f`, innermost first, returning an equivalent
 * quantifier-free formula. A closed sentence collapses to ⊤/⊥.
 */
export function eliminate(f: Formula, maxNodes = 2_000_000): ElimResult {
  const budget: Budget = { nodes: 0, max: maxNodes }
  const go = (g: Formula): Formula => {
    switch (g.kind) {
      case 'true':
      case 'false':
      case 'lt':
      case 'dvd':
      case 'ndvd':
        return g
      case 'and':
        return { kind: 'and', xs: g.xs.map(go) }
      case 'or':
        return { kind: 'or', xs: g.xs.map(go) }
      case 'exists':
        return cooperExists(g.v, go(g.body), budget)
      case 'forall':
        // ∀v.φ ≡ ¬∃v.¬φ
        return negNNF(cooperExists(g.v, negNNF(go(g.body)), budget))
      case 'not':
        throw new PresburgerBudgetError('eliminate expects NNF input')
    }
  }
  const formula = simplify(go(toNNF(f)))
  return { formula, nodes: budget.nodes }
}

/** Decide a *closed* Presburger sentence: true / false. */
export function decide(f: Formula, maxNodes = 2_000_000): { value: boolean; nodes: number } {
  const r = eliminate(f, maxNodes)
  if (r.formula.kind === 'true') return { value: true, nodes: r.nodes }
  if (r.formula.kind === 'false') return { value: false, nodes: r.nodes }
  throw new PresburgerBudgetError('decide() called on a formula with free variables')
}

// ----- bounded evaluator (the independent oracle) ----------------------------

/**
 * Evaluate any formula directly by enumerating quantifiers over [lo, hi]. Exact
 * for ℤ exactly when every quantified variable is provably confined to that box
 * (e.g. guarded by `lo ≤ x ≤ hi`), which the self-check arranges — so this is a
 * complete oracle there, sharing no logic with Cooper.
 */
export function evalFormula(f: Formula, env: Map<number, bigint>, lo: bigint, hi: bigint): boolean {
  switch (f.kind) {
    case 'true':
      return true
    case 'false':
      return false
    case 'lt':
      return evalLin(f.t, env) < 0n
    case 'dvd':
      return bmod(evalLin(f.t, env), f.d) === 0n
    case 'ndvd':
      return bmod(evalLin(f.t, env), f.d) !== 0n
    case 'and':
      return f.xs.every((x) => evalFormula(x, env, lo, hi))
    case 'or':
      return f.xs.some((x) => evalFormula(x, env, lo, hi))
    case 'not':
      return !evalFormula(f.x, env, lo, hi)
    case 'exists': {
      for (let x = lo; x <= hi; x++) {
        env.set(f.v, x)
        if (evalFormula(f.body, env, lo, hi)) {
          env.delete(f.v)
          return true
        }
      }
      env.delete(f.v)
      return false
    }
    case 'forall': {
      for (let x = lo; x <= hi; x++) {
        env.set(f.v, x)
        if (!evalFormula(f.body, env, lo, hi)) {
          env.delete(f.v)
          return false
        }
      }
      env.delete(f.v)
      return true
    }
  }
}

// ----- pretty-printing -------------------------------------------------------

export function formatFormula(f: Formula, name: (v: number) => string): string {
  const fmtTerm = (t: Lin): string => formatTerm(t, name)
  switch (f.kind) {
    case 'true':
      return '⊤'
    case 'false':
      return '⊥'
    case 'lt': {
      // Render `a·v + r < 0` more readably as `lhs < rhs` when single-sided.
      return `${fmtTerm(f.t)} < 0`
    }
    case 'dvd':
      return `${f.d} | (${fmtTerm(f.t)})`
    case 'ndvd':
      return `${f.d} ∤ (${fmtTerm(f.t)})`
    case 'and':
      return f.xs.length === 0 ? '⊤' : f.xs.map((x) => wrap(x, formatFormula(x, name))).join(' ∧ ')
    case 'or':
      return f.xs.length === 0 ? '⊥' : f.xs.map((x) => wrap(x, formatFormula(x, name))).join(' ∨ ')
    case 'not':
      return `¬${wrap(f.x, formatFormula(f.x, name))}`
    case 'exists':
      return `∃${name(f.v)}. ${formatFormula(f.body, name)}`
    case 'forall':
      return `∀${name(f.v)}. ${formatFormula(f.body, name)}`
  }
}

function wrap(f: Formula, s: string): string {
  if (f.kind === 'and' || f.kind === 'or') return `(${s})`
  return s
}

function formatTerm(t: Lin, name: (v: number) => string): string {
  const parts: string[] = []
  const ids = [...t.t.keys()].sort((a, b) => a - b)
  for (const v of ids) {
    const k = t.t.get(v)!
    const mag = k < 0n ? -k : k
    const sign = k < 0n ? '−' : parts.length ? '+' : ''
    const body = mag === 1n ? name(v) : `${mag}${name(v)}`
    parts.push(parts.length ? `${sign} ${body}` : `${k < 0n ? '−' : ''}${body}`)
  }
  if (t.c !== 0n || parts.length === 0) {
    const mag = t.c < 0n ? -t.c : t.c
    if (parts.length === 0) parts.push(`${t.c}`)
    else parts.push(`${t.c < 0n ? '−' : '+'} ${mag}`)
  }
  return parts.join(' ')
}

/** Free variables of a formula (not bound by an enclosing quantifier). */
export function freeVars(f: Formula, bound: Set<number> = new Set()): Set<number> {
  const out = new Set<number>()
  const walk = (g: Formula, b: Set<number>): void => {
    switch (g.kind) {
      case 'lt':
      case 'dvd':
      case 'ndvd':
        for (const v of g.t.t.keys()) if (!b.has(v)) out.add(v)
        return
      case 'and':
      case 'or':
        for (const x of g.xs) walk(x, b)
        return
      case 'not':
        walk(g.x, b)
        return
      case 'exists':
      case 'forall': {
        const nb = new Set(b)
        nb.add(g.v)
        walk(g.body, nb)
        return
      }
      default:
        return
    }
  }
  walk(f, bound)
  return out
}
