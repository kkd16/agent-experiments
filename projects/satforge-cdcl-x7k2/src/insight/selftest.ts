// Self-tests for the Insight engine.
//
// Every routine here is cross-checked against a brute-force oracle that enumerates
// the truth table directly. If the from-scratch SAT-based algorithms and the naive
// oracle ever disagree, a test fails — so the studio can prove, live, that its
// answers are exactly right (not merely plausible). Kept to tiny instances so the
// 2ⁿ / 2ᵐ oracles stay instant.

import type { CNF } from '../sat/cnf'
import { countModels } from '../sat/modelCount'
import { allModels, backbone, minimalModel } from './enumerate'
import { marco, deletionMus, quickXplainMus } from './mus'
import { SoftSolver } from './core'
import type { SoftSystem } from './core'
import { approxModelCount } from './approxmc'
import { uniGen, naiveSample } from './sampling'
import { uniformityReport, marginalComparison } from './uniformity'

export interface TestCase {
  name: string
  passed: boolean
  detail: string
}

export interface SelfTestReport {
  cases: TestCase[]
  passed: number
  failed: number
}

// ---------- brute-force oracles ----------

function clauseTrue(clause: number[], assign: boolean[]): boolean {
  for (const l of clause) {
    const v = Math.abs(l)
    if (l > 0 ? assign[v] : !assign[v]) return true
  }
  return false
}

function cnfTrue(clauses: number[][], assign: boolean[]): boolean {
  for (const c of clauses) if (!clauseTrue(c, assign)) return false
  return true
}

/** Every satisfying full assignment of a CNF, by table enumeration (n ≤ ~18). */
function bruteModels(cnf: CNF): boolean[][] {
  const out: boolean[][] = []
  const n = cnf.numVars
  for (let mask = 0; mask < 1 << n; mask++) {
    const assign = new Array<boolean>(n + 1).fill(false)
    for (let v = 1; v <= n; v++) assign[v] = (mask & (1 << (v - 1))) !== 0
    if (cnfTrue(cnf.clauses, assign)) out.push(assign.slice())
  }
  return out
}

/** Backbone by brute force: a literal is backbone iff its variable takes a single
 *  value across every model. */
function bruteBackbone(cnf: CNF): number[] {
  const models = bruteModels(cnf)
  if (models.length === 0) return []
  const lits: number[] = []
  for (let v = 1; v <= cnf.numVars; v++) {
    const val0 = models[0][v]
    if (models.every((m) => m[v] === val0)) lits.push(val0 ? v : -v)
  }
  return lits.sort((a, b) => Math.abs(a) - Math.abs(b))
}

function key(subset: number[]): string {
  return [...subset].sort((a, b) => a - b).join(',')
}

/** Is hard ∪ {soft[i] : i ∈ subset} satisfiable, by brute force over problem vars? */
function bruteSoftSat(sys: SoftSystem, subset: number[]): boolean {
  const clauses = sys.hard.concat(subset.map((i) => sys.soft[i]))
  const n = sys.numVars
  for (let mask = 0; mask < 1 << n; mask++) {
    const assign = new Array<boolean>(n + 1).fill(false)
    for (let v = 1; v <= n; v++) assign[v] = (mask & (1 << (v - 1))) !== 0
    if (cnfTrue(clauses, assign)) return true
  }
  return false
}

/** All MUSes and MCSes by brute force over the 2ᵐ soft-clause subsets. */
function bruteMusMcs(sys: SoftSystem): { muses: Set<string>; mcses: Set<string> } {
  const m = sys.soft.length
  const sat: boolean[] = new Array(1 << m)
  const idx = (mask: number): number[] => {
    const s: number[] = []
    for (let i = 0; i < m; i++) if (mask & (1 << i)) s.push(i)
    return s
  }
  for (let mask = 0; mask < 1 << m; mask++) sat[mask] = bruteSoftSat(sys, idx(mask))

  const muses = new Set<string>()
  const mcses = new Set<string>()
  for (let mask = 0; mask < 1 << m; mask++) {
    if (!sat[mask]) {
      // MUS: unsat, and dropping any single member becomes sat.
      let minimal = true
      for (let i = 0; i < m; i++) {
        if (mask & (1 << i)) {
          if (!sat[mask & ~(1 << i)]) {
            minimal = false
            break
          }
        }
      }
      if (minimal) muses.add(key(idx(mask)))
    } else {
      // MSS: sat, and adding any absent member becomes unsat. Its complement is an MCS.
      let maximal = true
      for (let i = 0; i < m; i++) {
        if (!(mask & (1 << i))) {
          if (sat[mask | (1 << i)]) {
            maximal = false
            break
          }
        }
      }
      if (maximal) {
        const comp: number[] = []
        for (let i = 0; i < m; i++) if (!(mask & (1 << i))) comp.push(i)
        mcses.add(key(comp))
      }
    }
  }
  return { muses, mcses }
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

// ---------- test instances ----------

// x1 ∨ x2 ; ¬x1 ∨ x3 ; a couple more — a small satisfiable formula with structure.
const CNF_A: CNF = { numVars: 4, clauses: [[1, 2], [-1, 3], [-2, 4], [1, -3, 4]] }
// An unsatisfiable formula: forces contradictions (has a backbone until it breaks).
const CNF_B: CNF = { numVars: 3, clauses: [[1], [-1, 2], [-2, 3], [-3]] }
// A formula with a clear backbone: x1 forced true, x2 forced false, x3 free.
const CNF_C: CNF = { numVars: 3, clauses: [[1], [-2], [1, 3, -2]] }

// An over-constrained soft system with multiple overlapping MUSes:
//   soft:  (a) (¬a) (b) (¬a∨¬b)  over vars a=1,b=2.
// {a,¬a} is an MUS; {a,¬a∨¬b,b} chain too. The oracle settles the truth.
const SOFT_1: SoftSystem = {
  numVars: 2,
  hard: [],
  soft: [[1], [-1], [2], [-1, -2]],
  labels: ['a', '¬a', 'b', '¬a∨¬b'],
}
// Pigeonhole-flavoured soft system: three "at least one" plus mutual exclusions.
const SOFT_2: SoftSystem = {
  numVars: 3,
  hard: [],
  soft: [[1], [2], [3], [-1, -2], [-1, -3], [-2, -3]],
  labels: ['p1', 'p2', 'p3', '¬(p1∧p2)', '¬(p1∧p3)', '¬(p2∧p3)'],
}

// ---------- the suite ----------

export function runSelfTests(): SelfTestReport {
  const cases: TestCase[] = []
  const record = (name: string, passed: boolean, detail: string) => cases.push({ name, passed, detail })

  // AllSAT vs brute force.
  for (const [nm, cnf] of [
    ['A', CNF_A],
    ['B', CNF_B],
    ['C', CNF_C],
  ] as const) {
    const got = allModels(cnf).models
    const brute = bruteModels(cnf)
    const gk = new Set(got.map((m) => m.slice(1).map((b) => (b ? 1 : 0)).join('')))
    const bk = new Set(brute.map((m) => m.slice(1).map((b) => (b ? 1 : 0)).join('')))
    record(`AllSAT(${nm}) = brute force`, setEq(gk, bk) && got.length === brute.length,
      `enumerated ${got.length}, oracle ${brute.length}`)
  }

  // Backbone vs brute force.
  for (const [nm, cnf] of [
    ['A', CNF_A],
    ['C', CNF_C],
  ] as const) {
    const got = backbone(cnf).literals
    const brute = bruteBackbone(cnf)
    record(`Backbone(${nm}) = brute force`, key(got) === key(brute),
      `engine {${got.join(',')}} vs oracle {${brute.join(',')}}`)
  }

  // Minimal model is genuinely a model and subset-minimal in its true variables.
  {
    const mm = minimalModel(CNF_A)
    let ok = mm.status === 'sat' && mm.model !== null && cnfTrue(CNF_A.clauses, mm.model)
    // Turning off any single true var must break satisfiability.
    if (ok && mm.model) {
      for (const v of mm.trueVars) {
        const flip = mm.model.slice()
        flip[v] = false
        if (cnfTrue(CNF_A.clauses, flip)) ok = false
      }
    }
    record('Minimal model is a subset-minimal model', ok, `true vars {${mm.trueVars.join(',')}}`)
  }

  // MUS extraction: deletion & QuickXplain both return genuine MUSes of the full set.
  for (const [nm, sys] of [
    ['SOFT_1', SOFT_1],
    ['SOFT_2', SOFT_2],
  ] as const) {
    const solver = new SoftSolver(sys)
    const full = Array.from({ length: sys.soft.length }, (_, i) => i)
    const oracle = bruteMusMcs(sys)
    const dm = deletionMus(solver, full)
    const qx = quickXplainMus(solver, full)
    record(`deletionMus(${nm}) is a real MUS`, oracle.muses.has(key(dm)), `{${dm.join(',')}}`)
    record(`quickXplainMus(${nm}) is a real MUS`, oracle.muses.has(key(qx)), `{${qx.join(',')}}`)
  }

  // MARCO enumerates *exactly* the set of all MUSes and all MCSes.
  for (const [nm, sys] of [
    ['SOFT_1', SOFT_1],
    ['SOFT_2', SOFT_2],
  ] as const) {
    const oracle = bruteMusMcs(sys)
    const res = marco(sys)
    const gotMus = new Set(res.muses.map(key))
    const gotMcs = new Set(res.mcses.filter((c) => c.length > 0).map(key))
    // A fully-satisfiable system reports one empty MCS; our oracle would too — filter both.
    const oracleMcs = new Set([...oracle.mcses].filter((s) => s !== ''))
    record(`MARCO(${nm}) MUSes = oracle`, setEq(gotMus, oracle.muses),
      `engine ${gotMus.size}, oracle ${oracle.muses.size}`)
    record(`MARCO(${nm}) MCSes = oracle`, setEq(gotMcs, oracleMcs),
      `engine ${gotMcs.size}, oracle ${oracleMcs.size}`)
  }

  // ApproxMC lands within a comfortable factor of the exact count (deterministic seed).
  {
    // A moderate formula: 8 vars, a scattering of clauses ⇒ dozens of models.
    const cnf: CNF = {
      numVars: 8,
      clauses: [[1, 2, 3], [-1, 4], [-2, 5], [3, -6], [4, 5, -7], [-3, 6, 8], [1, -4, 7], [-5, -8, 2]],
    }
    const exact = countModels(cnf).count!
    const approx = approxModelCount(cnf, { epsilon: 0.9, delta: 0.3, seed: 12345 })
    const est = approx.estimate
    const lo = Number(exact) / 3
    const hi = Number(exact) * 3
    record('ApproxMC within 3× of exact', est >= lo && est <= hi,
      `exact ${exact}, estimate ${est.toFixed(1)} (thresh ${approx.thresh}, ${approx.rounds} rounds)`)
  }

  // ---------- UniGen almost-uniform sampling ----------
  // The whole solution space is enumerable here, so uniformity is checked *exactly*
  // against the flat 1/K target — not merely asserted. Seeds are fixed for
  // reproducibility. See ./sampling and ./uniformity.

  // A lopsided "implication chain": 14 models with a few hub solutions the naive
  // solver over-serves. 14 ≤ the accept-band ceiling ⇒ UniGen's exact fast path.
  const CHAIN: CNF = { numVars: 8, clauses: [[-1, 2], [-2, 3], [-3, 4], [-4, 5], [1, 6], [6, 7], [-7, 8], [8, 1]] }
  // A bigger "two clusters" formula (70 models) that forces the hashing path.
  const CLUSTERS: CNF = {
    numVars: 10,
    clauses: [[1, 2, 3, 4], [-1, -2], [-3, -4], [5, 6], [-5, -6, 7], [8, -9], [9, -10], [10, -8], [1, 5, 8]],
  }

  {
    const seed = 1234
    const ug = uniGen(CHAIN, { numSamples: 1000, seed })
    const rep = uniformityReport(CHAIN, ug.samplingVars, ug.samples)
    // Fast path taken, every draw is a genuine solution, all 14 reached, and the χ²
    // sits near its dof (≈ perfectly uniform; generous 2.5× envelope absorbs noise).
    const ok = ug.fastPath && rep.outOfSupport === 0 && rep.coverage === 1 && rep.chiSquare <= 2.5 * rep.chiDof
    record('UniGen fast path is exactly uniform (chain)', ok,
      `χ²=${rep.chiSquare.toFixed(1)}/${rep.chiDof}, TV=${rep.tvDistance.toFixed(3)}, cover ${rep.distinct}/${rep.support}, out-of-support ${rep.outOfSupport}`)

    // The χ² goodness-of-fit test *accepts* the uniform null for UniGen (large p).
    record('χ² test accepts UniGen as uniform (chain)', rep.looksUniform === true && rep.pValue > 0.05,
      `p=${rep.pValue.toFixed(3)} ≥ 0.01 ⇒ consistent with uniform`)

    // Sampled marginals must track the exact per-variable marginals.
    const mg = marginalComparison(CHAIN, ug.samplingVars, ug.samples)
    record('UniGen marginals match exact (chain)', mg.maxError < 0.06,
      `max |exact − sampled| = ${mg.maxError.toFixed(3)}`)

    // The naive baseline, on the same instance and seed, is provably far more biased:
    // both are *sound* (only real solutions), but its χ² dwarfs UniGen's.
    const nv = naiveSample(CHAIN, { numSamples: 1000, seed })
    const nrep = uniformityReport(CHAIN, nv.samplingVars, nv.samples)
    record('Naive sampler is sound but skewed vs UniGen (chain)',
      nrep.outOfSupport === 0 && nrep.chiSquare > 4 * rep.chiSquare && nrep.tvDistance > 2 * rep.tvDistance,
      `naive χ²=${nrep.chiSquare.toFixed(0)} vs UniGen ${rep.chiSquare.toFixed(0)}; naive TV=${nrep.tvDistance.toFixed(3)} vs ${rep.tvDistance.toFixed(3)}`)

    // …and the χ² test *rejects* the naive sampler decisively (vanishing p-value).
    record('χ² test rejects the naive sampler (chain)', nrep.looksUniform === false && nrep.pValue < 1e-6,
      `p=${nrep.pValue.toExponential(1)} ≪ 0.01 ⇒ significantly non-uniform`)
  }

  {
    const seed = 1234
    const ug = uniGen(CLUSTERS, { numSamples: 800, seed })
    const rep = uniformityReport(CLUSTERS, ug.samplingVars, ug.samples)
    // Hashing path (q>0): still sound, still reaches every model, and stays within a
    // loose χ² envelope consistent with UniGen's (1+κ)-almost-uniform guarantee.
    const ok = !ug.fastPath && ug.hashBits > 0 && rep.outOfSupport === 0 && rep.coverage === 1 && rep.chiSquare <= 3 * rep.chiDof
    record('UniGen hashing path is sound & near-uniform (clusters)', ok,
      `q=${ug.hashBits}, χ²=${rep.chiSquare.toFixed(1)}/${rep.chiDof}, cover ${rep.distinct}/${rep.support}, out-of-support ${rep.outOfSupport}`)
  }

  const passed = cases.filter((c) => c.passed).length
  return { cases, passed, failed: cases.length - passed }
}
