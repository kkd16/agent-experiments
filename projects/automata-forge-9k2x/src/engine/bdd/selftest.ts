// The Symbolic mode's in-app verification suite — the whole reason to trust a hand-rolled BDD engine.
// As everywhere else in the lab the headline check is **differential**: the symbolic CTL checker
// (`symbolic.ts`, BDD fixpoints) is run against the completely independent explicit checker
// (`ctl/modelcheck.ts`, boolean-array fixpoints) over hundreds of random (Kripke model, CTL formula)
// pairs, and the decoded `Sat` sets must agree at EVERY state. Underneath that sit the BDD engine's own
// laws — `ite` against brute-force truth tables, De Morgan / involution / commutativity by canonical
// id-equality, `satCount` against enumeration, `anySat` soundness, the quantifier identities — plus the
// propositional parser round-trip and symbolic reachability against explicit BFS. All of it runs live,
// in the browser, in the Verify tab.

import type { Ctl } from '../ctl/formula'
import { satVector, totalize } from '../ctl/modelcheck'
import type { CtlModel } from '../ctl/modelcheck'
import { Bdd } from './bdd'
import type { BddId } from './bdd'
import { parseBool, showBool, toBdd, evalBool } from './bool'
import type { Bool } from './bool'
import { SymbolicModel, symbolicLabel, symbolicSatVector, symbolicReachable } from './symbolic'
import { SYMBOLIC_EXAMPLES } from './examples'
import { parseCtl } from '../ctl/parser'
import { parseKripke } from '../ltl/kripke'

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
const pick = <T,>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length) % xs.length]

/** Evaluate a BDD under a full assignment (index = variable level). */
function evalBdd(m: Bdd, f: BddId, assign: boolean[]): boolean {
  let cur = f
  while (!m.isTerminal(cur)) {
    const lvl = m.levelOf(cur)
    cur = assign[lvl] ? m.hi(cur) : m.lo(cur)
  }
  return cur === 1
}

// --- random generators ------------------------------------------------------

/** A random propositional formula over `vars`, depth-bounded. */
function genBool(rng: () => number, vars: string[], depth: number): Bool {
  if (depth <= 0 || rng() < 0.35) {
    if (rng() < 0.1) return { k: 'const', val: rng() < 0.5 }
    return { k: 'var', name: pick(rng, vars) }
  }
  const r = rng()
  if (r < 0.2) return { k: 'not', a: genBool(rng, vars, depth - 1) }
  const a = genBool(rng, vars, depth - 1)
  const b = genBool(rng, vars, depth - 1)
  if (r < 0.4) return { k: 'and', a, b }
  if (r < 0.6) return { k: 'or', a, b }
  if (r < 0.75) return { k: 'xor', a, b }
  if (r < 0.9) return { k: 'imp', a, b }
  return { k: 'iff', a, b }
}

const CTL_ATOMS = ['p', 'q', 'r']
/** A random small total Kripke model (every state has 1–3 successors, so no deadlocks). */
function genModel(rng: () => number): CtlModel {
  const n = 2 + Math.floor(rng() * 6) // 2..7
  const props = Array.from({ length: n }, () => new Set(CTL_ATOMS.filter(() => rng() < 0.5)))
  const succ = Array.from({ length: n }, () => {
    const kk = 1 + Math.floor(rng() * 3)
    const set = new Set<number>()
    for (let i = 0; i < kk; i++) set.add(Math.floor(rng() * n))
    return [...set]
  })
  return {
    n,
    succ,
    initial: [0],
    props,
    names: Array.from({ length: n }, (_, i) => 's' + i),
    addedSelfLoops: [],
  }
}

/** A random CTL formula over the atoms, depth-bounded. */
function genCtl(rng: () => number, depth: number): Ctl {
  if (depth <= 0 || rng() < 0.3) {
    const r = rng()
    if (r < 0.12) return { k: 'true' }
    if (r < 0.24) return { k: 'false' }
    return { k: 'atom', name: pick(rng, CTL_ATOMS) }
  }
  const unary: Ctl['k'][] = ['not', 'EX', 'AX', 'EF', 'AF', 'EG', 'AG']
  const binary: Ctl['k'][] = ['and', 'or', 'imp', 'iff', 'EU', 'AU', 'ER', 'AR']
  if (rng() < 0.5) {
    const k = pick(rng, unary)
    return { k, a: genCtl(rng, depth - 1) } as Ctl
  }
  const k = pick(rng, binary)
  return { k, a: genCtl(rng, depth - 1), b: genCtl(rng, depth - 1) } as Ctl
}

const sameVec = (a: boolean[], b: boolean[]) => a.length === b.length && a.every((v, i) => v === b[i])

// --- the checks -------------------------------------------------------------

/** ite against a brute-force truth table over up to 4 variables. */
function checkIte(): CheckResult {
  const rng = mulberry32(0x1234)
  const nVars = 4
  const m = new Bdd(['a', 'b', 'c', 'd'])
  const randBdd = (): BddId => toBdd(genBool(rng, m.vars, 3), m, (name) => m.vars.indexOf(name))
  for (let t = 0; t < 400; t++) {
    const f = randBdd()
    const g = randBdd()
    const h = randBdd()
    const r = m.ite(f, g, h)
    for (let mask = 0; mask < 1 << nVars; mask++) {
      const asn = Array.from({ length: nVars }, (_, i) => ((mask >> i) & 1) === 1)
      const want = evalBdd(m, f, asn) ? evalBdd(m, g, asn) : evalBdd(m, h, asn)
      if (evalBdd(m, r, asn) !== want) {
        return { name: 'ITE ≡ truth table', pass: false, detail: `mismatch on assignment ${mask}` }
      }
    }
  }
  return { name: 'ITE ≡ truth table', pass: true, detail: '400 random ternary combinations, all 16 rows each' }
}

/** The algebraic laws that canonicity buys us — equal functions are the SAME id. */
function checkLaws(): CheckResult {
  const rng = mulberry32(0x99)
  const m = new Bdd(['a', 'b', 'c', 'd'])
  const randBdd = (): BddId => toBdd(genBool(rng, m.vars, 3), m, (name) => m.vars.indexOf(name))
  for (let t = 0; t < 300; t++) {
    const f = randBdd()
    const g = randBdd()
    if (m.not(m.not(f)) !== f) return { name: 'BDD algebra laws (by id-equality)', pass: false, detail: '¬¬f ≠ f' }
    if (m.and(f, g) !== m.and(g, f)) return { name: 'BDD algebra laws (by id-equality)', pass: false, detail: 'and not commutative' }
    if (m.or(f, g) !== m.or(g, f)) return { name: 'BDD algebra laws (by id-equality)', pass: false, detail: 'or not commutative' }
    // De Morgan: ¬(f∧g) = ¬f ∨ ¬g
    if (m.not(m.and(f, g)) !== m.or(m.not(f), m.not(g)))
      return { name: 'BDD algebra laws (by id-equality)', pass: false, detail: 'De Morgan fails' }
    // Absorption & idempotence
    if (m.and(f, f) !== f || m.or(f, f) !== f)
      return { name: 'BDD algebra laws (by id-equality)', pass: false, detail: 'idempotence fails' }
    if (m.or(f, m.and(f, g)) !== f)
      return { name: 'BDD algebra laws (by id-equality)', pass: false, detail: 'absorption fails' }
    // Excluded middle / contradiction
    if (m.or(f, m.not(f)) !== 1 || m.and(f, m.not(f)) !== 0)
      return { name: 'BDD algebra laws (by id-equality)', pass: false, detail: '¬-complement fails' }
  }
  return { name: 'BDD algebra laws (by id-equality)', pass: true, detail: '¬¬, commutativity, De Morgan, absorption, complement — 300 pairs' }
}

/** satCount against explicit enumeration; anySat soundness; quantifier identities. */
function checkCountAndQuantify(): CheckResult {
  const rng = mulberry32(0x2718)
  const nVars = 5
  const m = new Bdd(['a', 'b', 'c', 'd', 'e'])
  for (let t = 0; t < 300; t++) {
    const f = toBdd(genBool(rng, m.vars, 4), m, (name) => m.vars.indexOf(name))
    let brute = 0
    for (let mask = 0; mask < 1 << nVars; mask++) {
      const asn = Array.from({ length: nVars }, (_, i) => ((mask >> i) & 1) === 1)
      if (evalBdd(m, f, asn)) brute++
    }
    if (m.satCount(f, nVars) !== brute) return { name: 'satCount, anySat & quantifiers', pass: false, detail: `satCount ${m.satCount(f, nVars)} ≠ ${brute}` }
    const wit = m.anySat(f, nVars)
    if ((wit === null) !== (brute === 0)) return { name: 'satCount, anySat & quantifiers', pass: false, detail: 'anySat null-ness wrong' }
    if (wit && !evalBdd(m, f, wit)) return { name: 'satCount, anySat & quantifiers', pass: false, detail: 'anySat witness does not satisfy f' }
    // ∃xᵢ f ≡ f|₀ ∨ f|₁ ; ∀ = ¬∃¬ ; both idempotent
    const i = Math.floor(rng() * nVars)
    if (m.existsVar(f, i) !== m.or(m.restrict(f, i, false), m.restrict(f, i, true)))
      return { name: 'satCount, anySat & quantifiers', pass: false, detail: '∃ identity fails' }
    if (m.forallVar(f, i) !== m.not(m.existsVar(m.not(f), i)))
      return { name: 'satCount, anySat & quantifiers', pass: false, detail: '∀ = ¬∃¬ fails' }
  }
  return { name: 'satCount, anySat & quantifiers', pass: true, detail: 'exact model count, sound witnesses, ∃/∀ identities — 300 formulas' }
}

/** The propositional parser + pretty-printer round-trip (parse∘show preserves the function). */
function checkParser(): CheckResult {
  const rng = mulberry32(0x555)
  const names = ['a', 'b', 'c', 'd']
  const m = new Bdd(names)
  for (let t = 0; t < 300; t++) {
    const ast = genBool(rng, names, 4)
    const shown = showBool(ast)
    const re = parseBool(shown)
    if (!re.ok) return { name: 'propositional parser round-trip', pass: false, detail: `re-parse failed on “${shown}”` }
    const f1 = toBdd(ast, m, (n) => names.indexOf(n))
    const f2 = toBdd(re.formula, m, (n) => names.indexOf(n))
    if (f1 !== f2) return { name: 'propositional parser round-trip', pass: false, detail: `parse(show(f)) ≠ f on “${shown}”` }
    // The BDD and the direct evaluator agree on every row.
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const asn = Array.from({ length: names.length }, (_, i) => ((mask >> i) & 1) === 1)
      const env = (n: string) => asn[names.indexOf(n)]
      if (evalBdd(m, f1, asn) !== evalBool(ast, env))
        return { name: 'propositional parser round-trip', pass: false, detail: `BDD ≠ evaluator on “${shown}”` }
    }
  }
  return { name: 'propositional parser round-trip', pass: true, detail: 'parse∘show ≡ id and BDD ≡ direct evaluator — 300 formulas' }
}

/** THE headline: symbolic CTL ≡ explicit CTL at every state, over random models × formulas. */
function checkSymbolicVsExplicit(): CheckResult {
  const rng = mulberry32(0xbeef)
  let checked = 0
  for (let t = 0; t < 250; t++) {
    const model = genModel(rng)
    const formula = genCtl(rng, 3)
    const explicit = satVector(formula, model)
    const symbolic = symbolicSatVector(formula, model)
    checked++
    if (!sameVec(explicit, symbolic)) {
      return {
        name: 'symbolic CTL ≡ explicit CTL (every state)',
        pass: false,
        detail: `disagreement after ${checked} pairs`,
      }
    }
  }
  return {
    name: 'symbolic CTL ≡ explicit CTL (every state)',
    pass: true,
    detail: `${checked} random (model, formula) pairs — Sat sets identical at every state`,
  }
}

/** Symbolic forward reachability ≡ explicit BFS. */
function checkReachable(): CheckResult {
  const rng = mulberry32(0xf00d)
  for (let t = 0; t < 200; t++) {
    const model = genModel(rng)
    const sm = new SymbolicModel(model)
    const sym = new Set(symbolicReachable(sm).states)
    // explicit BFS
    const seen = new Set<number>(model.initial)
    const queue = [...model.initial]
    while (queue.length) {
      const s = queue.shift()!
      for (const j of model.succ[s]) if (!seen.has(j)) {
        seen.add(j)
        queue.push(j)
      }
    }
    if (sym.size !== seen.size || [...seen].some((s) => !sym.has(s)))
      return { name: 'symbolic reachability ≡ explicit BFS', pass: false, detail: `mismatch on pair ${t}` }
  }
  return { name: 'symbolic reachability ≡ explicit BFS', pass: true, detail: '200 models — μZ.(init ∨ post∃Z) equals the BFS-reachable set' }
}

/** The gallery verdicts must match the explicit checker. */
function checkGallery(): CheckResult {
  for (const ex of SYMBOLIC_EXAMPLES) {
    const pf = parseCtl(ex.formula)
    const pm = parseKripke(ex.model)
    if (!pf.ok || !pm.model) return { name: 'gallery verdicts (symbolic ≡ expected)', pass: false, detail: `“${ex.name}” failed to parse` }
    const model = totalize(pm.model)
    const sym = symbolicLabel(pf.formula, new SymbolicModel(model))
    const explicit = satVector(pf.formula, model)
    const symVec = symbolicSatVector(pf.formula, model)
    if (!sameVec(symVec, explicit)) return { name: 'gallery verdicts (symbolic ≡ expected)', pass: false, detail: `“${ex.name}” Sat set differs` }
    if ((ex.expect === 'holds') !== sym.holds) return { name: 'gallery verdicts (symbolic ≡ expected)', pass: false, detail: `“${ex.name}” expected ${ex.expect}` }
  }
  return { name: 'gallery verdicts (symbolic ≡ expected)', pass: true, detail: `all ${SYMBOLIC_EXAMPLES.length} examples: symbolic verdict = explicit = documented` }
}

export function runSelfTest(): SelfTestReport {
  const results = [
    checkIte(),
    checkLaws(),
    checkCountAndQuantify(),
    checkParser(),
    checkReachable(),
    checkSymbolicVsExplicit(),
    checkGallery(),
  ]
  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}
