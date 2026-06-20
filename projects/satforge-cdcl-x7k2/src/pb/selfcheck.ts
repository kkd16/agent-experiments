// Correctness harness for the pseudo-Boolean engine, in the project's house style: thousands
// of random instances cross-checked against a brute-force oracle (exhaustive enumeration) AND
// the independent CNF-encoding back-end, plus algebraic soundness of every cutting-plane rule,
// optimization optima against brute force, the pigeonhole separation, and an OPB round-trip.
//
// Exposed as `runPbChecks()` so the top-level `selftest.ts` folds these assertions into the
// project's running total, exactly like the SAT / SMT / QBF / BDD subsystems.

import { Pbc, normalizeLinear, type SignedTerm, type Cmp } from './constraint'
import type { PbInstance } from './instance'
import { feasible, objectiveValue } from './instance'
import { bruteForce } from './reference'
import { solveViaCnf } from './encode'
import { solvePb } from './solver'
import { optimize } from './optimize'
import { encodePigeonhole, encodeKnapsack, encodeSetCover, encodeDominatingSet, PETERSEN, randomPb } from './examples'
import { parseOpb, toOpb } from './opb'

export interface PbCheckReport {
  pass: number
  fail: number
  messages: string[]
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

function modelsOf(c: Pbc, n: number): boolean[] {
  const out: boolean[] = []
  for (let m = 0; m < 1 << n; m++) {
    const val: boolean[] = [false]
    for (let v = 1; v <= n; v++) val[v] = (m & (1 << (v - 1))) !== 0
    out.push(c.satisfiedBy(val))
  }
  return out
}
function impliesArr(a: boolean[], b: boolean[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] && !b[i]) return false
  return true
}

function randConstraint(rng: () => number, n: number): Pbc {
  const k = 1 + Math.floor(rng() * n)
  const used = new Set<number>()
  const terms: SignedTerm[] = []
  for (let j = 0; j < k; j++) {
    let v = 1 + Math.floor(rng() * n)
    while (used.has(v)) v = (v % n) + 1
    used.add(v)
    terms.push({ lit: (rng() < 0.5 ? 1 : -1) * v, coef: BigInt(1 + Math.floor(rng() * 5)) })
  }
  const total = terms.reduce((s, t) => s + Number(t.coef), 0)
  const c = Pbc.fromTerms(terms, BigInt(Math.floor(rng() * (total + 1))))
  c.saturate()
  return c
}

function randInstance(rng: () => number, n: number): PbInstance {
  const nc = 1 + Math.floor(rng() * 5)
  const constraints: Pbc[] = []
  for (let i = 0; i < nc; i++) constraints.push(randConstraint(rng, n))
  return { numVars: n, constraints }
}

export function runPbChecks(): PbCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 40) messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // ---- normalization preserves the solution set (vs brute force) -------------
  {
    const rng = mulberry32(0x1111)
    const cmps: Cmp[] = ['>=', '<=', '=', '>', '<']
    let mism = 0
    for (let iter = 0; iter < 3000; iter++) {
      const n = 1 + Math.floor(rng() * 4)
      const k = 1 + Math.floor(rng() * 4)
      const terms: SignedTerm[] = []
      for (let i = 0; i < k; i++) {
        const v = 1 + Math.floor(rng() * n)
        terms.push({ lit: (rng() < 0.5 ? 1 : -1) * v, coef: BigInt((rng() < 0.5 ? 1 : -1) * (1 + Math.floor(rng() * 4))) })
      }
      const cmp = cmps[Math.floor(rng() * cmps.length)]
      const rhs = BigInt(Math.floor(rng() * 9) - 2)
      const norm = normalizeLinear(terms, cmp, rhs)
      for (let m = 0; m < 1 << n; m++) {
        const val: boolean[] = [false]
        for (let v = 1; v <= n; v++) val[v] = (m & (1 << (v - 1))) !== 0
        let s = 0n
        for (const t of terms) {
          const truth = t.lit > 0 ? val[Math.abs(t.lit)] : !val[Math.abs(t.lit)]
          if (truth) s += t.coef
        }
        const want =
          cmp === '>=' ? s >= rhs : cmp === '<=' ? s <= rhs : cmp === '>' ? s > rhs : cmp === '<' ? s < rhs : s === rhs
        const got = norm.every((c) => c.satisfiedBy(val))
        if (want !== got) mism++
      }
    }
    check('normalizeLinear preserves the 0/1 solution set on 3000 random constraints', mism === 0, `${mism} mismatches`)
  }

  // ---- cutting-plane rules are sound -----------------------------------------
  {
    const rng = mulberry32(0x2222)
    let satBad = 0
    let divBad = 0
    let wkBad = 0
    let addBad = 0
    const n = 4
    for (let iter = 0; iter < 3000; iter++) {
      const c = randConstraint(rng, n)
      const before = modelsOf(c, n)
      const sat = c.clone()
      sat.saturate()
      const satM = modelsOf(sat, n)
      for (let i = 0; i < before.length; i++) if (before[i] !== satM[i]) satBad++
      const k = BigInt(2 + Math.floor(rng() * 3))
      const div = c.clone()
      div.divideCeil(k)
      div.saturate()
      if (!impliesArr(before, modelsOf(div, n))) divBad++
      const wk = c.clone()
      const vars = [...wk.coef.keys()]
      if (vars.length > 1) {
        wk.weaken(vars[Math.floor(rng() * vars.length)])
        if (!impliesArr(before, modelsOf(wk, n))) wkBad++
      }
      const c2 = randConstraint(rng, n)
      const sum = c.clone()
      sum.addConstraint(c2)
      const mB = modelsOf(c2, n)
      const mS = modelsOf(sum, n)
      for (let i = 0; i < mS.length; i++) if (before[i] && mB[i] && !mS[i]) addBad++
    }
    check('saturation preserves the solution set exactly', satBad === 0, `${satBad} bad`)
    check('Chvátal–Gomory division is sound (implied)', divBad === 0, `${divBad} bad`)
    check('weakening is sound (implied)', wkBad === 0, `${wkBad} bad`)
    check('constraint addition is sound (nonnegative combination)', addBad === 0, `${addBad} bad`)
  }

  // ---- native solver vs brute force AND the CNF oracle -----------------------
  {
    const rng = mulberry32(0x3333)
    let verdictBad = 0
    let modelBad = 0
    let oracleBad = 0
    let unknown = 0
    const TRIALS = 4000
    for (let iter = 0; iter < TRIALS; iter++) {
      const n = 1 + Math.floor(rng() * 7)
      const inst = randInstance(rng, n)
      const bf = bruteForce(inst)
      const pb = solvePb(inst, { maxConflicts: 500000 })
      if (pb.status === 'unknown') {
        unknown++
        continue
      }
      if ((bf.status === 'sat') !== (pb.status === 'sat')) verdictBad++
      else if (pb.status === 'sat' && !feasible(inst, pb.model!)) modelBad++
      const cnf = solveViaCnf(inst)
      if (cnf.status !== 'unknown' && (cnf.status === 'sat') !== (bf.status === 'sat')) oracleBad++
    }
    check('native cutting-plane solver agrees with brute force on 4000 random PB instances', verdictBad === 0, `${verdictBad} mismatches`)
    check('every native SAT model satisfies all constraints', modelBad === 0, `${modelBad} infeasible`)
    check('CNF oracle agrees with brute force (independent back-end)', oracleBad === 0, `${oracleBad} mismatches`)
    check('native solver never times out on small instances', unknown === 0, `${unknown} unknown`)
  }

  // ---- optimization optimum vs brute force -----------------------------------
  {
    const rng = mulberry32(0x4444)
    let optBad = 0
    let stepBad = 0
    let checked = 0
    for (let iter = 0; iter < 500; iter++) {
      const n = 2 + Math.floor(rng() * 5)
      const constraints: Pbc[] = []
      const nc = 1 + Math.floor(rng() * 4)
      for (let i = 0; i < nc; i++) {
        const k = 1 + Math.floor(rng() * n)
        const used = new Set<number>()
        const terms: SignedTerm[] = []
        for (let j = 0; j < k; j++) {
          let v = 1 + Math.floor(rng() * n)
          while (used.has(v)) v = (v % n) + 1
          used.add(v)
          terms.push({ lit: (rng() < 0.5 ? 1 : -1) * v, coef: BigInt(1 + Math.floor(rng() * 3)) })
        }
        const total = terms.reduce((s, t) => s + Number(t.coef > 0n ? t.coef : -t.coef), 0)
        constraints.push(...normalizeLinear(terms, '>=', BigInt(Math.floor(rng() * total))))
      }
      const objective: SignedTerm[] = []
      for (let v = 1; v <= n; v++) objective.push({ lit: (rng() < 0.5 ? 1 : -1) * v, coef: BigInt(1 + Math.floor(rng() * 4)) })
      const inst: PbInstance = { numVars: n, constraints, objective, objConst: 0n }
      const bf = bruteForce(inst)
      const opt = optimize(inst, { maxConflicts: 200000 })
      if (bf.status === 'unsat') {
        if (opt.status !== 'unsat') optBad++
      } else {
        if (opt.status !== 'optimal' || opt.optimum !== bf.optimum) optBad++
        else {
          if (opt.model && objectiveValue(inst, opt.model) !== opt.optimum) optBad++
          for (let i = 1; i < opt.steps.length; i++) if (!(opt.steps[i].value < opt.steps[i - 1].value)) stepBad++
        }
      }
      checked++
    }
    check(`PB optimization optimum matches brute force on ${checked} instances`, optBad === 0, `${optBad} bad`)
    check('optimization incumbents strictly improve', stepBad === 0, `${stepBad} bad`)
  }

  // ---- curated optimization examples -----------------------------------------
  {
    const ks = encodeKnapsack(
      [{ weight: 2, value: 3 }, { weight: 3, value: 4 }, { weight: 4, value: 5 }, { weight: 5, value: 6 }],
      5,
    )
    check('knapsack optimum matches brute force', optimize(ks).optimum === bruteForce(ks).optimum)
    const sc = encodeSetCover(5, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 2, 4]])
    check('set cover optimum matches brute force', optimize(sc).optimum === bruteForce(sc).optimum)
    const ds = encodeDominatingSet(PETERSEN)
    check('Petersen graph domination number is 3', optimize(ds, { maxConflicts: 500000 }).optimum === 3n)
  }

  // ---- pigeonhole: UNSAT, refuted by cutting planes --------------------------
  {
    for (let h = 2; h <= 8; h++) {
      const r = solvePb(encodePigeonhole(h + 1, h), { maxConflicts: 2_000_000 })
      check(`pigeonhole PHP(${h + 1}→${h}) is UNSAT`, r.status === 'unsat', `got ${r.status}`)
    }
    check('satisfiable pigeonhole PHP(3→3) is SAT', solvePb(encodePigeonhole(3, 3)).status === 'sat')
  }

  // ---- OPB parse + round-trip ------------------------------------------------
  {
    const rng = mulberry32(0x5555)
    let rtBad = 0
    for (let i = 0; i < 60; i++) {
      const inst = randomPb(i + 1, 4 + Math.floor(rng() * 3), 5 + Math.floor(rng() * 4))
      const re = parseOpb(toOpb(inst)).instance
      if (solvePb(inst).status !== solvePb(re).status) rtBad++
    }
    check('OPB serialize → parse preserves the verdict', rtBad === 0, `${rtBad} bad`)
    const p = parseOpb('* demo\nmin: +1 x1 +1 x2 ;\n+1 x1 +1 x2 +1 x3 >= 2 ;\n+2 x1 -1 x3 = 0 ;\n')
    check('OPB parser reads objective + constraints', p.sense === 'min' && p.instance.numVars === 3 && p.instance.constraints.length === 3)
  }

  // ---- determinism -----------------------------------------------------------
  {
    const inst = randInstance(mulberry32(0x6789), 6)
    check('native solver is deterministic', solvePb(inst).status === solvePb(inst).status)
  }

  return { pass, fail, messages }
}
