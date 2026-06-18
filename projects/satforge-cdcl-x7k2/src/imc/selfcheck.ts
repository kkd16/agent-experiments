// Correctness harness for the interpolation + model-checking subsystem, folded
// into the project's main self-test. Three independent cross-checks, in the
// project's brute-force tradition:
//   1. the proof-logging SAT solver vs. exhaustive truth tables AND the main
//      SatForge solver, on thousands of random CNFs (+ model validity);
//   2. Craig interpolants vs. exhaustive verification of their three defining
//      properties, on hundreds of random UNSAT partitions;
//   3. the interpolation-based model checker vs. an independent explicit-state
//      BFS reachability oracle, on hundreds of random total transition systems
//      plus the curated gallery (matching SAFE/UNSAFE, inductive invariants,
//      and shortest counterexamples).

import { solveCnf } from './proofSolver'
import { interpolate, checkInterpolant } from './interpolant'
import { verifyModel } from '../sat/cnf'
import { solve } from '../sat/solver'
import { fvar, fnot, fand, for_, fxor, fiff, type Formula } from './formula'
import { imc, kInduction, bfsReachability, checkInvariant, checkCounterexample, type TransitionSystem } from './modelcheck'
import { TS_EXAMPLES } from './examples'

export interface ImcCheckReport {
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

function bruteSat(numVars: number, clauses: number[][]): boolean {
  for (let mask = 0; mask < 1 << numVars; mask++) {
    const a: boolean[] = [false]
    for (let v = 1; v <= numVars; v++) a[v] = (mask & (1 << (v - 1))) !== 0
    if (clauses.every((c) => c.some((l) => (l > 0 ? a[l] : !a[-l])))) return true
  }
  return false
}

export function runImcChecks(): ImcCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // 1. Proof-logging solver vs. brute force + main solver, with model validity.
  {
    const rng = mulberry32(0x5a7f)
    let agree = 0
    let modelsOk = true
    const trials = 800
    for (let i = 0; i < trials; i++) {
      const nv = 3 + Math.floor(rng() * 6)
      const nc = Math.floor(rng() * (nv * 4))
      const clauses: number[][] = []
      for (let c = 0; c < nc; c++) {
        const len = 1 + Math.floor(rng() * 3)
        const cl: number[] = []
        for (let k = 0; k < len; k++) {
          const v = 1 + Math.floor(rng() * nv)
          cl.push(rng() < 0.5 ? v : -v)
        }
        clauses.push(cl)
      }
      const mine = solveCnf(nv, clauses)
      const brute = bruteSat(nv, clauses)
      const main = solve({ numVars: nv, clauses }).status === 'sat'
      if ((mine.status === 'sat') === brute && brute === main) agree++
      if (mine.status === 'sat' && !verifyModel({ numVars: nv, clauses }, mine.model!).ok) modelsOk = false
    }
    check('proof-logging solver agrees with brute force + main solver', agree === trials, `${agree}/${trials}`)
    check('proof-logging solver returns valid models', modelsOk)
  }

  // 2. Craig interpolants: verify the three properties exhaustively.
  {
    const rng = mulberry32(0xc0ffee)
    let tried = 0
    let unsat = 0
    let good = 0
    const mkClauses = (nv: number, n: number) => {
      const cs: number[][] = []
      for (let c = 0; c < n; c++) {
        const len = 1 + Math.floor(rng() * 3)
        const cl: number[] = []
        for (let k = 0; k < len; k++) {
          const v = 1 + Math.floor(rng() * nv)
          cl.push(rng() < 0.5 ? v : -v)
        }
        cs.push(cl)
      }
      return cs
    }
    while (tried < 4000 && unsat < 300) {
      tried++
      const nv = 4 + Math.floor(rng() * 5)
      const A = mkClauses(nv, 2 + Math.floor(rng() * nv))
      const B = mkClauses(nv, 2 + Math.floor(rng() * nv))
      const r = interpolate(nv, A, B)
      if (r.status === 'sat') continue
      unsat++
      if (checkInterpolant(nv, A, B, r.interpolant, new Set(r.shared)).ok) good++
    }
    check('McMillan interpolants satisfy all three Craig properties', good === unsat && unsat > 100, `${good}/${unsat}`)
  }

  // 3. IMC vs. explicit-state BFS on random total transition systems.
  {
    const rng = mulberry32(0xbeef)
    const randFormula = (vars: number[], depth: number): Formula => {
      if (depth <= 0 || rng() < 0.3) {
        const v = vars[Math.floor(rng() * vars.length)]
        return rng() < 0.5 ? fvar(v) : fnot(fvar(v))
      }
      const r = rng()
      const a = randFormula(vars, depth - 1)
      const b = randFormula(vars, depth - 1)
      if (r < 0.3) return fand(a, b)
      if (r < 0.6) return for_(a, b)
      if (r < 0.8) return fxor(a, b)
      return fnot(a)
    }
    const mkSystem = (n: number, i: number): TransitionSystem => {
      const cur = Array.from({ length: n }, (_, j) => j + 1)
      const transParts: Formula[] = []
      for (let j = 1; j <= n; j++) transParts.push(fiff(fvar(n + j), randFormula(cur, 2)))
      return {
        name: `rand${i}`,
        stateBits: n,
        init: randFormula(cur, 2),
        trans: transParts.reduce((acc, x) => fand(acc, x)),
        bad: randFormula(cur, 2),
      }
    }

    let agree = true
    let invOk = true
    let cexOk = true
    let decided = 0
    const trials = 200
    for (let i = 0; i < trials; i++) {
      const n = 3 + Math.floor(rng() * 2) // 3..4 state bits (keeps unrolled CNFs small)
      const ts = mkSystem(n, i)
      const ref = bfsReachability(ts)
      const res = imc(ts, { maxBound: 20, maxRounds: 60 })
      if (res.result === 'UNKNOWN') continue
      decided++
      if ((res.result === 'SAFE') !== ref.safe) agree = false
      if (res.result === 'SAFE' && !checkInvariant(ts, res.invariant!)) invOk = false
      if (res.result === 'UNSAFE') {
        if (!checkCounterexample(ts, res.counterexample!) || res.counterexample!.length - 1 !== ref.distance) cexOk = false
      }
    }
    check('IMC verdict matches BFS oracle on random systems', agree && decided > 150, `decided=${decided}`)
    check('IMC safety invariants are genuinely inductive', invOk)
    check('IMC counterexamples are valid and shortest', cexOk)
  }

  // 4. Curated gallery: every example matches the BFS oracle.
  {
    let ok = true
    let kiOk = true
    for (const ts of TS_EXAMPLES) {
      const ref = bfsReachability(ts)
      const res = imc(ts, { maxBound: 40, maxRounds: 200 })
      if (res.result === 'UNKNOWN' || (res.result === 'SAFE') !== ref.safe) ok = false
      else if (res.result === 'SAFE' && !checkInvariant(ts, res.invariant!)) ok = false
      else if (res.result === 'UNSAFE' && (!checkCounterexample(ts, res.counterexample!) || res.counterexample!.length - 1 !== ref.distance)) ok = false
      const ki = kInduction(ts, 64)
      if (ki.result === 'UNKNOWN' || (ki.result === 'SAFE') !== ref.safe) kiOk = false
      else if (ki.result === 'UNSAFE' && !checkCounterexample(ts, ki.counterexample!)) kiOk = false
    }
    check('curated model-checking gallery matches the BFS oracle', ok)
    check('curated gallery: k-induction agrees with IMC and BFS', kiOk)
  }

  return { pass, fail, messages }
}
