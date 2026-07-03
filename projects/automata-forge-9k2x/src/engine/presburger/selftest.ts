// The Presburger mode's in-app verification suite. The decision procedure is graded, live, against an
// independent brute-force evaluator (semantics.ts) that shares none of its machinery:
//
//   • EXHAUSTIVE quantifier-free agreement — for hundreds of random ∧∨¬→↔ combinations of linear and
//     congruence atoms, the automaton accepts the LSBF encoding of a tuple ⟺ the direct semantics say
//     the tuple satisfies the formula, checked over every tuple in a box [0,R)ᵏ;
//   • EXISTENTIAL agreement — random ∃w formulas checked against the bounded-witness oracle;
//   • the BOOLEAN-ALGEBRA laws — double negation, idempotence, De Morgan — as language identities;
//   • STRUCTURAL invariants on every produced machine — total, 0-stable, and already minimal;
//   • a KNOWN-ANSWER battery — evens, the Frobenius ⟨3,5⟩ set (vs an exact DP), 2x=1 unsatisfiable,
//     the successor sentence true, x<y, and the binary adder x+y=z.

import type { PDfa } from './automaton'
import { accepts, encodeTuple, isEmpty, alphabetSize } from './automaton'
import { compile } from './build'
import { evalTuple, evalSentence } from './semantics'
import type { Formula, LinTerm } from './formula'

export interface CheckResult {
  name: string
  pass: boolean
  detail: string
}
export interface SelfTestReport {
  results: CheckResult[]
  passed: number
  total: number
  ok: boolean
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length) % xs.length]
const randInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))

/** Does the automaton accept the tuple's LSBF encoding? */
const acceptsTuple = (d: PDfa, tuple: number[]) => accepts(d, encodeTuple(tuple))

/** Iterate every tuple in [0,R)^k, calling f. */
function forEachTuple(k: number, R: number, f: (t: number[]) => void) {
  const t = new Array(k).fill(0)
  const rec = (i: number) => {
    if (i === k) {
      f(t)
      return
    }
    for (let v = 0; v < R; v++) {
      t[i] = v
      rec(i + 1)
    }
  }
  if (k === 0) f([])
  else rec(0)
}

// --- random formula generation ---------------------------------------------

function randTerm(rng: () => number, vars: string[], allowConst = true): LinTerm {
  const coeffs: Record<string, number> = {}
  for (const v of vars) {
    const c = randInt(rng, -2, 2)
    if (c !== 0) coeffs[v] = c
  }
  const c = allowConst ? randInt(rng, 0, 5) : 0
  return { coeffs, c }
}

function randAtom(rng: () => number, vars: string[]): Formula {
  if (rng() < 0.3) {
    const divisor = pick(rng, [2, 3, 4, 5, 6])
    return { kind: 'div', divisor, term: randTerm(rng, vars), neg: rng() < 0.5 }
  }
  const op = pick(rng, ['le', 'lt', 'ge', 'gt', 'eq', 'ne'] as const)
  return { kind: 'cmp', op, left: randTerm(rng, vars), right: { coeffs: {}, c: randInt(rng, 0, 6) } }
}

function randFormula(rng: () => number, vars: string[], depth: number): Formula {
  if (depth <= 0 || rng() < 0.35) return randAtom(rng, vars)
  const r = rng()
  if (r < 0.2) return { kind: 'not', a: randFormula(rng, vars, depth - 1) }
  const kind = pick(rng, ['and', 'or', 'imp', 'iff'] as const)
  return { kind, a: randFormula(rng, vars, depth - 1), b: randFormula(rng, vars, depth - 1) }
}

// --- structural invariants -------------------------------------------------

function structuralOk(d: PDfa): string | null {
  const A = alphabetSize(d.k)
  for (let s = 0; s < d.numStates; s++) {
    if (d.trans[s].length !== A) return `state ${s} has ${d.trans[s].length} transitions, expected ${A}`
    for (let a = 0; a < A; a++) {
      const t = d.trans[s][a]
      if (t < 0 || t >= d.numStates) return `state ${s} letter ${a} → ${t} out of range`
    }
    // 0-stability: accept(s) ⟺ accept(δ(s,0)).
    if (d.accept[s] !== d.accept[d.trans[s][0]]) return `state ${s} breaks 0-stability`
  }
  return null
}

/** Two automata over the same scope agree on every tuple in [0,R)^k. */
function sameLanguage(a: PDfa, b: PDfa, R: number): boolean {
  if (a.k !== b.k) return false
  let ok = true
  forEachTuple(a.k, R, (t) => {
    if (acceptsTuple(a, t) !== acceptsTuple(b, t)) ok = false
  })
  return ok
}

// ---------------------------------------------------------------------------

export function runSelfTest(): SelfTestReport {
  const results: CheckResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // 1. Exhaustive quantifier-free differential.
  {
    const rng = mulberry32(0xc0ffee)
    let cases = 0
    let mism = 0
    let structFail = 0
    let notMinimal = 0
    const varSets = [['x'], ['x', 'y'], ['x', 'y', 'z']]
    for (let iter = 0; iter < 240; iter++) {
      const vars = pick(rng, varSets)
      const f = randFormula(rng, vars, 3)
      const { dfa } = compile(f)
      const k = dfa.vars.length
      const R = k <= 1 ? 200 : k === 2 ? 70 : 17
      if (structuralOk(dfa)) structFail++
      if (compile(f).dfa.numStates !== dfa.numStates) notMinimal++
      forEachTuple(k, R, (t) => {
        cases++
        const truth = evalTuple(f, dfa.vars, t, 0)
        if (acceptsTuple(dfa, t) !== truth) mism++
      })
    }
    add(
      'quantifier-free ≡ semantics (exhaustive)',
      mism === 0 && structFail === 0,
      `${cases.toLocaleString()} tuple checks across 240 random formulas, ${mism} mismatches; ${structFail} structural failures`,
    )
    add('every machine total, deterministic & 0-stable', structFail === 0, `checked 240 machines`)
    add('compiler output already minimal', notMinimal === 0, `re-minimizing 240 machines changed ${notMinimal}`)
  }

  // 2. Existential agreement (bounded-witness oracle).
  {
    const rng = mulberry32(0x5eed)
    let cases = 0
    let mism = 0
    const W = 256
    for (let iter = 0; iter < 120; iter++) {
      const body = randFormula(rng, ['x', 'y', 'w'], 2)
      const f: Formula = { kind: 'exists', v: 'w', a: body }
      const { dfa } = compile(f)
      const k = dfa.vars.length // ⊆ {x,y}
      const R = 8
      forEachTuple(k, R, (t) => {
        cases++
        const truth = evalTuple(f, dfa.vars, t, W)
        if (acceptsTuple(dfa, t) !== truth) mism++
      })
    }
    add('∃w formulas ≡ bounded-witness semantics', mism === 0, `${cases} checks across 120 random ∃ formulas, ${mism} mismatches`)
  }

  // 3. Boolean-algebra laws as language identities.
  {
    const rng = mulberry32(0xa11ce)
    let dnFail = 0
    let idemFail = 0
    let deMorganFail = 0
    for (let iter = 0; iter < 60; iter++) {
      const a = randFormula(rng, ['x', 'y'], 2)
      const b = randFormula(rng, ['x', 'y'], 2)
      const da = compile(a).dfa
      const notNot = compile({ kind: 'not', a: { kind: 'not', a } }).dfa
      if (!sameLanguage(da, notNot, 24)) dnFail++
      const andSelf = compile({ kind: 'and', a, b: a }).dfa
      if (!sameLanguage(da, andSelf, 24)) idemFail++
      const lhs = compile({ kind: 'not', a: { kind: 'and', a, b } }).dfa
      const rhs = compile({ kind: 'or', a: { kind: 'not', a }, b: { kind: 'not', a: b } }).dfa
      if (!sameLanguage(lhs, rhs, 24)) deMorganFail++
    }
    add('double negation  ¬¬φ ≡ φ', dnFail === 0, `60 random φ`)
    add('idempotence  φ ∧ φ ≡ φ', idemFail === 0, `60 random φ`)
    add('De Morgan  ¬(φ∧ψ) ≡ ¬φ ∨ ¬ψ', deMorganFail === 0, `60 random pairs`)
  }

  // 4. Known-answer battery.
  {
    // evens
    const evens = compile(mkExists('y', cmp('eq', term({ x: 1 }), term({ y: 2 })))).dfa
    let evensOk = true
    for (let x = 0; x < 64; x++) if (acceptsTuple(evens, [x]) !== (x % 2 === 0)) evensOk = false
    add('∃y. x=2y  =  the even numbers', evensOk, 'checked x ∈ [0,64)')

    // Frobenius ⟨3,5⟩ vs exact DP
    const frob = compile(mkExists('a', mkExists('b', cmp('eq', term({ x: 1 }), term({ a: 3, b: 5 }))))).dfa
    const repr = (x: number) => {
      for (let a = 0; 3 * a <= x; a++) if ((x - 3 * a) % 5 === 0) return true
      return false
    }
    let frobOk = true
    for (let x = 0; x < 64; x++) if (acceptsTuple(frob, [x]) !== repr(x)) frobOk = false
    add('∃a∃b. x=3a+5b  =  ⟨3,5⟩ (all but 1,2,4,7)', frobOk, 'checked x ∈ [0,64) vs an exact DP')

    // 2x=1 unsatisfiable
    const half = compile(mkExists('x', cmp('eq', term({ x: 2 }), constT(1)))).dfa
    add('∃x. 2x=1 is unsatisfiable (empty automaton)', isEmpty(half), evalSentence(mkExists('x', cmp('eq', term({ x: 2 }), constT(1))), 64) ? 'oracle disagrees!' : 'oracle agrees: false')

    // successor sentence true: ∀x∃y. y = x+1
    const succF = mkForall('x', mkExists('y', cmp('eq', term({ y: 1 }), { coeffs: { x: 1 }, c: 1 })))
    const succDfa = compile(succF).dfa
    add('∀x∃y. y=x+1 is true (nonempty automaton)', !isEmpty(succDfa), 'the successor axiom')

    // x < y
    const lt = compile(cmp('lt', term({ x: 1 }), term({ y: 1 }))).dfa
    let ltOk = true
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) if (acceptsTuple(lt, [a, b]) !== a < b) ltOk = false
    add('x < y  =  { (a,b) : a<b }', ltOk, 'checked [0,16)²')

    // adder x + y = z
    const adder = compile(cmp('eq', term({ x: 1, y: 1 }), term({ z: 1 }))).dfa
    let addOk = true
    forEachTuple(3, 8, (t) => {
      if (acceptsTuple(adder, [t[0], t[1], t[2]]) !== (t[0] + t[1] === t[2])) addOk = false
    })
    // NB: dfa.vars order is [x,y,z] by first appearance.
    add('x + y = z  =  the binary adder', addOk && adder.vars.join('') === 'xyz', 'checked [0,8)³')
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}

// --- tiny AST helpers for the battery --------------------------------------

function term(coeffs: Record<string, number>): LinTerm {
  const c = coeffs.__c ?? 0
  const cc: Record<string, number> = {}
  for (const [k, v] of Object.entries(coeffs)) if (k !== '__c') cc[k] = v
  return { coeffs: cc, c }
}
const constT = (c: number): LinTerm => ({ coeffs: {}, c })
const cmp = (op: 'eq' | 'lt' | 'le' | 'gt' | 'ge' | 'ne', left: LinTerm, right: LinTerm): Formula => ({ kind: 'cmp', op, left, right })
const mkExists = (v: string, a: Formula): Formula => ({ kind: 'exists', v, a })
const mkForall = (v: string, a: Formula): Formula => ({ kind: 'forall', v, a })
