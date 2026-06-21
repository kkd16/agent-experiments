// Correctness harness for the preprocessing engine, in the project's house style:
// thousands of random instances behind each assertion, every claim cross-checked
// against an independent reference. The gold-standard tests are about
// *reconstruction*:
//
//   • Equisatisfiability — for every technique subset, SAT(simplify(F)) ⟺ SAT(F),
//     decided independently by the complete CDCL solver and (on small instances)
//     by exhaustive enumeration.
//   • Reconstruction soundness — *every* model of the simplified formula must
//     reconstruct to a model of the ORIGINAL formula. On small instances this is
//     checked exhaustively over all simplified assignments, not just one witness.
//   • Model-set preservation — subsumption and self-subsuming resolution change
//     no variables and must preserve the satisfying-assignment set *exactly*; the
//     two model sets are compared bit-for-bit.
//   • UNSAT preservation — preprocessing must never turn UNSAT into SAT or vice
//     versa; the pigeonhole family and high-ratio randoms pin this down.
//
// Following the rest of the project, each loop accumulates a single property over
// thousands of instances and emits ONE assertion, so the totals stay comparable.
// Exposed as `runPreprocessChecks()` and folded into the top-level `selftest.ts`.

import type { CNF } from '../sat/cnf'
import { verifyModel } from '../sat/cnf'
import { solve } from '../sat/solver'
import { randomKSat } from '../sat/encoders/random3sat'
import { encodePigeonhole } from '../sat/encoders/pigeonhole'
import { simplify, reconstruct, ALL_TECHNIQUES, type Technique, type SimplifyOptions } from './preprocess'
import { EXAMPLES } from './examples'

export interface PreprocessCheckReport {
  pass: number
  fail: number
  messages: string[]
}

function only(...t: Technique[]): SimplifyOptions {
  const techniques: Partial<Record<Technique, boolean>> = {}
  for (const x of ALL_TECHNIQUES) techniques[x] = false
  for (const x of t) techniques[x] = true
  return { techniques }
}

// A tiny deterministic PRNG so the suite is reproducible run-to-run.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

/** Decide SAT by exhaustive truth-table enumeration (n ≤ ~18). */
function bruteSat(cnf: CNF): boolean {
  const n = cnf.numVars
  const m = new Array<boolean>(n + 1).fill(false)
  for (let mask = 0; mask < 1 << n; mask++) {
    for (let v = 1; v <= n; v++) m[v] = (mask & (1 << (v - 1))) !== 0
    if (verifyModel(cnf, m).ok) return true
  }
  return false
}

/** The full set of satisfying assignments, each encoded as an integer bitmask (n ≤ ~16). */
function modelSet(cnf: CNF): Set<number> {
  const n = cnf.numVars
  const m = new Array<boolean>(n + 1).fill(false)
  const out = new Set<number>()
  for (let mask = 0; mask < 1 << n; mask++) {
    for (let v = 1; v <= n; v++) m[v] = (mask & (1 << (v - 1))) !== 0
    if (verifyModel(cnf, m).ok) out.add(mask)
  }
  return out
}

export function runPreprocessChecks(): PreprocessCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      messages.push(`FAIL [preprocess]: ${name} ${extra}`)
    }
  }

  // The technique subsets we exercise: the full pipeline, plus each technique
  // alone (so a bug can be localised to a single rule).
  const configs: { label: string; opts: SimplifyOptions }[] = [
    { label: 'full', opts: {} },
    ...ALL_TECHNIQUES.map((t) => ({ label: t, opts: only(t) })),
    { label: 'bve+growth', opts: { bveGrowth: 4 } },
  ]

  // One accumulator per (config, property); a single assertion is emitted per pair.
  const accActive = new Map<string, boolean>()
  const accEquisat = new Map<string, boolean>()
  const accRecon = new Map<string, boolean>()
  const accSatIff = new Map<string, boolean>()
  for (const { label } of configs) {
    accActive.set(label, true)
    accEquisat.set(label, true)
    accRecon.set(label, true)
    accSatIff.set(label, true)
  }
  let modelSetSubsume = true
  let modelSetStrengthen = true

  // --- exhaustive checks on small random instances --------------------------
  // For these we can enumerate the entire assignment space, so reconstruction is
  // checked for EVERY model of the simplified formula, not merely one witness.
  const r = rng(0xc0ffee)
  let exhaustiveInstances = 0
  for (let it = 0; it < 700; it++) {
    const n = 3 + Math.floor(r() * 8) // 3..10 vars
    const ratio = 1.5 + r() * 5.5 // span both sides of the threshold
    const cnf = randomKSat(n, ratio, 3, (r() * 1e9) | 0)
    const origSat = bruteSat(cnf)
    exhaustiveInstances++

    for (const { label, opts } of configs) {
      const res = simplify(cnf, opts)

      if (!res.activeVars.every((v) => v >= 1 && v <= n)) accActive.set(label, false)

      // status ⇒ equisatisfiability
      let equisat: boolean
      let simpSat: boolean
      if (res.status === 'unsat') {
        equisat = !origSat
        simpSat = false
      } else if (res.status === 'trivial-sat') {
        equisat = origSat
        simpSat = true
      } else {
        simpSat = bruteSat(res.cnf)
        equisat = simpSat === origSat
      }
      if (!equisat) accEquisat.set(label, false)
      if (simpSat !== origSat) accSatIff.set(label, false)

      // reconstruction soundness: every simplified model lifts to an original model
      if (res.status !== 'unsat') {
        const act = res.activeVars
        const k = act.length
        const m = new Array<boolean>(n + 1).fill(false)
        for (let mask = 0; mask < 1 << k; mask++) {
          for (let v = 1; v <= n; v++) m[v] = false
          for (let b = 0; b < k; b++) m[act[b]] = (mask & (1 << b)) !== 0
          if (!verifyModel(res.cnf, m).ok) continue
          const full = reconstruct(n, res.stack, m)
          if (!verifyModel(cnf, full).ok) {
            accRecon.set(label, false)
            break
          }
        }
      }
    }

    // model-set preservation for the two purely-equivalence-preserving rules
    const original = modelSet(cnf)
    for (const t of ['subsume', 'strengthen'] as Technique[]) {
      const res = simplify(cnf, only(t))
      let ok: boolean
      if (res.status === 'unsat') ok = original.size === 0
      else {
        const after = modelSet(res.cnf)
        ok = after.size === original.size && [...original].every((x) => after.has(x))
      }
      if (!ok) {
        if (t === 'subsume') modelSetSubsume = false
        else modelSetStrengthen = false
      }
    }
  }

  for (const { label } of configs) {
    check(`${label}: never invents a variable`, accActive.get(label)!)
    check(`${label}: equisatisfiable (exhaustive)`, accEquisat.get(label)!)
    check(`${label}: simplified SAT ⟺ original SAT`, accSatIff.get(label)!)
    check(`${label}: every simplified model reconstructs to an original model`, accRecon.get(label)!)
  }
  check('subsumption preserves the model set exactly', modelSetSubsume)
  check('self-subsuming resolution preserves the model set exactly', modelSetStrengthen)

  // --- larger instances: solver-decided equisat + a reconstructed witness ----
  const r2 = rng(0x5eed)
  let largeEquisat = true
  let largeRecon = true
  let largeShrink = true
  for (let it = 0; it < 500; it++) {
    const n = 12 + Math.floor(r2() * 26) // 12..37 vars
    const ratio = 2.5 + r2() * 3.5
    const cnf = randomKSat(n, ratio, 3, (r2() * 1e9) | 0)
    const groundUnsat = solve(cnf).status === 'unsat'
    const res = simplify(cnf, {})
    if (res.activeVars.length > n) largeShrink = false

    if (res.status === 'unsat') {
      if (!groundUnsat) largeEquisat = false
    } else {
      const sres = solve(res.cnf)
      if (sres.status === 'unsat') {
        if (!groundUnsat) largeEquisat = false
      } else if (sres.status === 'sat') {
        if (groundUnsat) largeEquisat = false
        const full = reconstruct(n, res.stack, sres.model!)
        if (!verifyModel(cnf, full).ok) largeRecon = false
      }
    }
  }
  check('large (12–37 vars): equisatisfiable vs. CDCL', largeEquisat)
  check('large: reconstructed model satisfies the original', largeRecon)
  check('large: variables only ever removed', largeShrink)

  // --- UNSAT must stay UNSAT: the pigeonhole family --------------------------
  let phpOk = true
  for (const holes of [3, 4, 5, 6]) {
    const { cnf } = encodePigeonhole(holes)
    for (const { opts } of configs) {
      const res = simplify(cnf, opts)
      if (res.status === 'unsat') continue
      if (solve(res.cnf).status !== 'unsat') phpOk = false
    }
  }
  check('pigeonhole family stays UNSAT under every technique subset', phpOk)

  // --- the curated studio examples all behave ------------------------------
  let examplesAgree = true
  let examplesRecon = true
  for (const ex of EXAMPLES) {
    const cnf = ex.build()
    const ground = solve(cnf)
    const res = simplify(cnf, {})
    if (res.status === 'unsat') {
      if (ground.status !== 'unsat') examplesAgree = false
    } else if (ground.status === 'sat') {
      const sres = res.status === 'trivial-sat' ? null : solve(res.cnf)
      if (!(res.status === 'trivial-sat' || sres!.status === 'sat')) examplesAgree = false
      const model = sres?.model ?? new Array<boolean>(cnf.numVars + 1).fill(false)
      const full = reconstruct(cnf.numVars, res.stack, model)
      if (!verifyModel(cnf, full).ok) examplesRecon = false
    } else {
      const sres = res.status === 'trivial-sat' ? { status: 'sat' as const } : solve(res.cnf)
      if (sres.status !== 'unsat') examplesAgree = false
    }
  }
  check('curated examples: verdict agrees with CDCL', examplesAgree)
  check('curated examples: reconstructed model satisfies the original', examplesRecon)

  // --- a structured equivalence chain: must collapse to ~one variable -------
  {
    const clauses: number[][] = []
    const N = 20
    for (let i = 1; i < N; i++) {
      clauses.push([-i, i + 1])
      clauses.push([i, -(i + 1)])
    }
    clauses.push([1, N])
    const cnf: CNF = { numVars: N, clauses }
    const res = simplify(cnf, only('equiv', 'unit', 'pure', 'subsume'))
    check('equivalence chain collapses to ≤ 1 active variable', res.activeVars.length <= 1)
    let ok = true
    if (res.status !== 'unsat') {
      const sres = res.status === 'trivial-sat' ? null : solve(res.cnf)
      const model = sres?.model ?? new Array<boolean>(N + 1).fill(false)
      ok = verifyModel(cnf, reconstruct(N, res.stack, model)).ok
    }
    check('equivalence chain reconstructs a valid original model', ok)
  }

  // --- idempotence: simplifying the simplified formula never enlarges it -----
  {
    const r3 = rng(0xabcd)
    let idem = true
    for (let it = 0; it < 200; it++) {
      const n = 4 + Math.floor(r3() * 8)
      const cnf = randomKSat(n, 2 + r3() * 3, 3, (r3() * 1e9) | 0)
      const a = simplify(cnf, {})
      if (a.status !== 'simplified') continue
      const b = simplify(a.cnf, {})
      if (b.stats.after.clauses > a.stats.after.clauses) idem = false
    }
    check('idempotence: re-simplifying never enlarges the formula', idem)
  }

  messages.unshift(
    `[preprocess] ${exhaustiveInstances} exhaustive + 500 large + PHP/examples behind ${pass + fail} assertions — ${pass} passed, ${fail} failed`,
  )
  return { pass, fail, messages }
}
