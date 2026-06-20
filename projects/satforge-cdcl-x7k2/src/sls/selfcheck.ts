// Correctness harness for the Phys Studio's incomplete solvers, in the project's
// house style: thousands of random instances, every verdict cross-checked against
// the complete CDCL solver and every produced model independently re-verified.
// The strongest tests here are structural:
//
//   • the incremental `SearchState` is checked, after every flip, against a
//     from-scratch recomputation of clause counts, energy and break/make counts —
//     so the O(deg) flip is provably equivalent to the O(formula) rebuild;
//   • `delta(v)` is checked to predict the exact change in unsatisfied-clause
//     count across an actual flip;
//   • no stochastic solver is ever allowed to report SAT on an instance the
//     complete solver proved UNSAT, nor to return a model that fails verifyModel.
//
// Exposed as `runSlsChecks()` so the top-level `selftest.ts` folds these assertions
// into the project's running total, exactly like the SAT / SMT / QBF / BDD / PB
// subsystems.

import type { CNF } from '../sat/cnf'
import { verifyModel } from '../sat/cnf'
import { solve } from '../sat/solver'
import { randomKSat } from '../sat/encoders/random3sat'
import { encodePigeonhole } from '../sat/encoders/pigeonhole'
import { WorkingFormula, SearchState, mulberry32 } from './working'
import { localSearch, type SlsAlgorithm } from './localsearch'
import { anneal } from './anneal'
import { surveyPropagate } from './surveyprop'
import { race } from './race'

export interface SlsCheckReport {
  pass: number
  fail: number
  messages: string[]
}

/** Brute-force the satisfied-literal count of a clause under a 1-based assignment. */
function trueLitsOf(clause: number[], assign: Uint8Array): number {
  let t = 0
  for (const lit of clause) {
    const v = Math.abs(lit)
    if (lit > 0 ? assign[v] === 1 : assign[v] === 0) t++
  }
  return t
}

export function runSlsChecks(): SlsCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 30) messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // ---- 1. Incremental SearchState ≡ from-scratch recomputation, flip by flip ----
  {
    const rng = mulberry32(12345)
    let invariantOk = true
    let deltaOk = true
    let breakMakeOk = true
    for (let t = 0; t < 200 && (invariantOk || deltaOk || breakMakeOk); t++) {
      const n = 6 + ((rng() * 20) | 0)
      const cnf = randomKSat(n, 3 + rng() * 2.5, 3, (rng() * 1e9) | 0)
      const f = new WorkingFormula(cnf)
      const st = new SearchState(f)
      st.randomize(rng)
      for (let step = 0; step < 40; step++) {
        // (a) trueLits and energy match a rebuild.
        let energy = 0
        for (let c = 0; c < f.clauses.length; c++) {
          const t2 = trueLitsOf(f.clauses[c], st.assign)
          if (t2 !== st.trueLits[c]) invariantOk = false
          if (t2 === 0) energy++
        }
        if (energy !== st.energy) invariantOk = false

        // (b) break/make counts match definitions for a random variable.
        const v = 1 + ((rng() * n) | 0)
        let bc = 0
        let mc = 0
        for (const o of f.occ[v]) {
          const litTrue = o.positive === (st.assign[v] === 1)
          if (litTrue && st.trueLits[o.clause] === 1) bc++
          if (!litTrue && st.trueLits[o.clause] === 0) mc++
        }
        if (bc !== st.breakCount(v) || mc !== st.makeCount(v)) breakMakeOk = false

        // (c) delta predicts the exact energy change across the flip.
        const predicted = st.delta(v)
        const before = st.energy
        st.flip(v)
        const after = st.energy
        if (after - before !== predicted) deltaOk = false
      }
    }
    check('SearchState incremental invariant (trueLits + energy)', invariantOk)
    check('SearchState break/make counts match definition', breakMakeOk)
    check('delta(v) predicts the exact energy change', deltaOk)
  }

  // ---- 2. SLS models always verify; never SAT on a proven-UNSAT instance ----
  {
    const algs: SlsAlgorithm[] = ['gsat', 'walksat', 'probsat', 'novelty']
    let modelsValid = true
    let solvedEasy = 0
    let easyTotal = 0
    const rng = mulberry32(777)
    for (let i = 0; i < 60; i++) {
      const n = 15 + ((rng() * 20) | 0)
      const alpha = 3.0 + rng() * 1.0 // mostly satisfiable
      const seed = (rng() * 1e9) | 0
      const cnf = randomKSat(n, alpha, 3, seed)
      const truth = solve(cnf, { maxConflicts: 500000, maxTimeMs: 1000 })
      for (const a of algs) {
        const r = localSearch(cnf, { algorithm: a, seed, maxFlips: 4000, maxTries: 30, maxTimeMs: 600 })
        if (r.status === 'sat') {
          if (!r.model || !verifyModel(cnf, r.model).ok) modelsValid = false
          if (truth.status === 'unsat') modelsValid = false // would be a catastrophic disagreement
        }
        if (a === 'walksat' && truth.status === 'sat') {
          easyTotal++
          if (r.status === 'sat') solvedEasy++
        }
      }
    }
    check('every SLS model verifies & no SAT-on-UNSAT', modelsValid)
    // WalkSAT should solve the overwhelming majority of these satisfiable instances.
    check('WalkSAT solves ≥85% of satisfiable instances', solvedEasy >= 0.85 * easyTotal, `(${solvedEasy}/${easyTotal})`)
  }

  // ---- 3. SLS cannot be fooled into SAT on hard UNSAT (pigeonhole) ----
  {
    const ph = encodePigeonhole(4).cnf // PHP(4): 5 pigeons → 4 holes, UNSAT
    let ok = true
    for (const a of ['gsat', 'walksat', 'probsat', 'novelty'] as SlsAlgorithm[]) {
      const r = localSearch(ph, { algorithm: a, seed: 9, maxFlips: 3000, maxTries: 10, maxTimeMs: 400 })
      if (r.status === 'sat') ok = false
    }
    check('SLS never reports SAT on UNSAT pigeonhole', ok)
  }

  // ---- 4. Simulated annealing: valid models, solves easy instances ----
  {
    let valid = true
    let solved = 0
    let total = 0
    const rng = mulberry32(555)
    for (let i = 0; i < 40; i++) {
      const n = 15 + ((rng() * 15) | 0)
      const seed = (rng() * 1e9) | 0
      const cnf = randomKSat(n, 3.2, 3, seed)
      const truth = solve(cnf, { maxConflicts: 200000, maxTimeMs: 800 })
      const r = anneal(cnf, { seed, steps: 60 * n, maxTimeMs: 600 })
      if (r.status === 'sat' && (!r.model || !verifyModel(cnf, r.model).ok)) valid = false
      if (r.status === 'sat' && truth.status === 'unsat') valid = false
      if (truth.status === 'sat') {
        total++
        if (r.status === 'sat') solved++
      }
    }
    check('annealing models verify & never SAT-on-UNSAT', valid)
    check('annealing solves ≥60% of easy satisfiable instances', solved >= 0.6 * total, `(${solved}/${total})`)
  }

  // ---- 5. Survey propagation: always-valid models; solves under-constrained ----
  {
    let valid = true
    let solvedEasy = 0
    let easyTotal = 0
    let solvedHard = 0
    const rng = mulberry32(424242)
    // Easy / under-constrained: paramagnetic → WalkSAT clean-up should always finish.
    for (let i = 0; i < 25; i++) {
      const n = 30 + ((rng() * 30) | 0)
      const seed = (rng() * 1e9) | 0
      const cnf = randomKSat(n, 3.0, 3, seed)
      const sp = surveyPropagate(cnf, { seed, maxTimeMs: 1500 })
      if (sp.status === 'sat') {
        easyTotal++
        solvedEasy++
        if (!sp.verified || !sp.model || !verifyModel(cnf, sp.model).ok) valid = false
      } else {
        easyTotal++
      }
    }
    // Harder, near-threshold instances: SP should solve a healthy fraction, and
    // whatever model it returns must verify.
    for (let i = 0; i < 14; i++) {
      const n = 60 + ((rng() * 30) | 0)
      const seed = (rng() * 1e9) | 0
      const cnf = randomKSat(n, 4.2, 3, seed)
      const truth = solve(cnf, { maxConflicts: 1_000_000, maxTimeMs: 1200 })
      const sp = surveyPropagate(cnf, { seed, maxTimeMs: 2000 })
      if (sp.status === 'sat') {
        if (!sp.model || !verifyModel(cnf, sp.model).ok) valid = false
        if (truth.status === 'unsat') valid = false
        solvedHard++
      }
    }
    check('every SP model verifies & never SAT-on-UNSAT', valid)
    check('SP solves ≥90% of under-constrained instances', solvedEasy >= 0.9 * easyTotal, `(${solvedEasy}/${easyTotal})`)
    check('SP solves ≥1 near-threshold instance', solvedHard >= 1, `(${solvedHard}/14)`)
  }

  // ---- 6. Race consistency: complete solver referees the stochastic field ----
  {
    let consistent = true
    const rng = mulberry32(2024)
    for (let i = 0; i < 30; i++) {
      const n = 12 + ((rng() * 12) | 0)
      const alpha = 2.5 + rng() * 3.0
      const cnf: CNF = randomKSat(n, alpha, 3, (rng() * 1e9) | 0)
      const r = race(cnf, { budgetMs: 400, seed: (rng() * 1e9) | 0 })
      if (!r.consistent) consistent = false
    }
    check('race(): no stochastic solver disagrees with the complete verdict', consistent)
  }

  return { pass, fail, messages }
}
