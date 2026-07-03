// The surface syntax of Presburger arithmetic: linear terms, atomic comparisons and divisibilities,
// the boolean connectives, and the two quantifiers. Kept deliberately small and JSON-serializable so
// the whole workspace round-trips through a permalink.

import type { Cmp } from './atoms'
import { CMP_GLYPH } from './atoms'

/** A linear term  Σ coeffs[v]·v + c  over integer variables. */
export interface LinTerm {
  coeffs: Record<string, number>
  c: number
}

export type Formula =
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'cmp'; op: Cmp; left: LinTerm; right: LinTerm }
  | { kind: 'div'; divisor: number; term: LinTerm; neg: boolean } // divisor | term  (neg ⇒ ∤)
  | { kind: 'not'; a: Formula }
  | { kind: 'and'; a: Formula; b: Formula }
  | { kind: 'or'; a: Formula; b: Formula }
  | { kind: 'imp'; a: Formula; b: Formula }
  | { kind: 'iff'; a: Formula; b: Formula }
  | { kind: 'exists'; v: string; a: Formula }
  | { kind: 'forall'; v: string; a: Formula }

// ---------------------------------------------------------------------------
// Linear-term helpers.
// ---------------------------------------------------------------------------

export const zeroTerm = (): LinTerm => ({ coeffs: {}, c: 0 })

export function addTerm(a: LinTerm, b: LinTerm, sign = 1): LinTerm {
  const coeffs: Record<string, number> = { ...a.coeffs }
  for (const [v, k] of Object.entries(b.coeffs)) {
    coeffs[v] = (coeffs[v] ?? 0) + sign * k
    if (coeffs[v] === 0) delete coeffs[v]
  }
  return { coeffs, c: a.c + sign * b.c }
}

export function scaleTerm(a: LinTerm, k: number): LinTerm {
  if (k === 0) return zeroTerm()
  const coeffs: Record<string, number> = {}
  for (const [v, c] of Object.entries(a.coeffs)) coeffs[v] = c * k
  return { coeffs, c: a.c * k }
}

export const varTerm = (v: string): LinTerm => ({ coeffs: { [v]: 1 }, c: 0 })
export const constTerm = (c: number): LinTerm => ({ coeffs: {}, c })

/** The difference `left − right`, dropping zero coefficients. */
export function diffCoeffs(left: LinTerm, right: LinTerm): Record<string, number> {
  const d = addTerm(left, scaleTerm(right, -1))
  return d.coeffs
}

// ---------------------------------------------------------------------------
// Variables.
// ---------------------------------------------------------------------------

const termVars = (t: LinTerm): string[] => Object.keys(t.coeffs)

/** All variables that appear free (not under a binding quantifier), in first-appearance order. */
export function freeVars(f: Formula): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  const add = (v: string) => {
    if (!seen.has(v)) {
      seen.add(v)
      order.push(v)
    }
  }
  const rec = (g: Formula, bound: Set<string>) => {
    switch (g.kind) {
      case 'true':
      case 'false':
        return
      case 'cmp':
        for (const v of [...termVars(g.left), ...termVars(g.right)]) if (!bound.has(v)) add(v)
        return
      case 'div':
        for (const v of termVars(g.term)) if (!bound.has(v)) add(v)
        return
      case 'not':
        rec(g.a, bound)
        return
      case 'and':
      case 'or':
      case 'imp':
      case 'iff':
        rec(g.a, bound)
        rec(g.b, bound)
        return
      case 'exists':
      case 'forall': {
        const next = new Set(bound)
        next.add(g.v)
        rec(g.a, next)
        return
      }
    }
  }
  rec(f, new Set())
  return order
}

// ---------------------------------------------------------------------------
// Pretty-printing.
// ---------------------------------------------------------------------------

export function showTerm(t: LinTerm): string {
  const entries = Object.entries(t.coeffs).filter(([, c]) => c !== 0)
  let out = ''
  entries.forEach(([v, c], i) => {
    const mag = Math.abs(c)
    const body = mag === 1 ? v : `${mag}·${v}`
    if (i === 0) out += (c < 0 ? '−' : '') + body
    else out += (c < 0 ? ' − ' : ' + ') + body
  })
  if (t.c !== 0 || entries.length === 0) {
    if (entries.length === 0) out += String(t.c)
    else out += (t.c < 0 ? ' − ' : ' + ') + Math.abs(t.c)
  }
  return out || '0'
}

const PREC: Record<string, number> = { iff: 1, imp: 2, or: 3, and: 4, not: 5, quant: 0 }

export function showFormula(f: Formula, parentPrec = 0): string {
  const wrap = (s: string, myPrec: number) => (myPrec < parentPrec ? `(${s})` : s)
  switch (f.kind) {
    case 'true':
      return '⊤'
    case 'false':
      return '⊥'
    case 'cmp':
      return `${showTerm(f.left)} ${CMP_GLYPH[f.op]} ${showTerm(f.right)}`
    case 'div':
      return `${f.neg ? '¬(' : ''}${f.divisor} ∣ ${showTerm(f.term)}${f.neg ? ')' : ''}`
    case 'not': {
      const inner =
        f.a.kind === 'cmp' || f.a.kind === 'div' ? `(${showFormula(f.a)})` : showFormula(f.a, PREC.not)
      return wrap(`¬${inner}`, PREC.not)
    }
    case 'and':
      return wrap(`${showFormula(f.a, PREC.and)} ∧ ${showFormula(f.b, PREC.and)}`, PREC.and)
    case 'or':
      return wrap(`${showFormula(f.a, PREC.or)} ∨ ${showFormula(f.b, PREC.or)}`, PREC.or)
    case 'imp':
      return wrap(`${showFormula(f.a, PREC.imp + 1)} → ${showFormula(f.b, PREC.imp)}`, PREC.imp)
    case 'iff':
      return wrap(`${showFormula(f.a, PREC.iff + 1)} ↔ ${showFormula(f.b, PREC.iff + 1)}`, PREC.iff)
    case 'exists':
      return wrap(`∃${f.v}. ${showFormula(f.a, PREC.quant)}`, PREC.quant + 1)
    case 'forall':
      return wrap(`∀${f.v}. ${showFormula(f.a, PREC.quant)}`, PREC.quant + 1)
  }
}

/** The immediate subformulas, for tree rendering. */
export function childrenOf(f: Formula): Formula[] {
  switch (f.kind) {
    case 'not':
    case 'exists':
    case 'forall':
      return [f.a]
    case 'and':
    case 'or':
    case 'imp':
    case 'iff':
      return [f.a, f.b]
    default:
      return []
  }
}
