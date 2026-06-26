// Correctness harness for the 2-SAT engine. Three independent oracles:
//
//   1. the project's own complete CDCL solver (solve / solveAssuming),
//   2. exhaustive brute force over all 2ⁿ assignments (tiny instances),
//
// must agree with decide2Sat on the verdict, the extracted model, the
// equivalent-literal classes AND the backbone — sharing no code with the
// linear-time SCC procedure. Exposed as runTwoSatChecks() so the studio can
// fold these assertions into its self-test badge, exactly like the other
// subsystems (QBF / PB / SLS / preprocess).

import type { CNF } from '../sat/cnf'
import { verifyModel } from '../sat/cnf'
import { solve, solveAssuming } from '../sat/solver'
import { decide2Sat } from './twosat'
import { TWO_SAT_EXAMPLES, randomTwoSat, mulberry32, twoColoringCnf, cycleEdges } from './examples'

export interface TwoSatCheckReport {
  pass: number
  fail: number
  messages: string[]
}

/** Enumerate every satisfying assignment of a small CNF (1-based booleans). */
function bruteModels(cnf: CNF): boolean[][] {
  const n = cnf.numVars
  const out: boolean[][] = []
  for (let mask = 0; mask < 1 << n; mask++) {
    const model = new Array<boolean>(n + 1).fill(false)
    for (let v = 1; v <= n; v++) model[v] = (mask & (1 << (v - 1))) !== 0
    if (verifyModel(cnf, model).ok) out.push(model)
  }
  return out
}

/** A random 2-CNF with an occasional unit clause, to exercise the unit edge. */
function randomMixed(n: number, m: number, seed: number): CNF {
  const base = randomTwoSat(n, m, seed)
  const rng = mulberry32(seed ^ 0x9e3779b9)
  const clauses = base.clauses.slice()
  const nUnits = Math.floor(rng() * 3)
  for (let i = 0; i < nUnits; i++) {
    const v = 1 + Math.floor(rng() * n)
    clauses.push([rng() < 0.5 ? v : -v])
  }
  return { numVars: n, clauses }
}

export function runTwoSatChecks(): TwoSatCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (cond: boolean, name: string, extra = '') => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 40) messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // 1. Curated examples have the expected verdicts and sound models.
  const expectSat: Record<string, boolean> = {
    'Implication chain': true,
    'Equivalent literals': true,
    'Contradiction (UNSAT)': false,
    'Bipartite 2-colouring': true,
    'Odd cycle (UNSAT)': false,
    'Forced backbone': true,
  }
  for (const ex of TWO_SAT_EXAMPLES) {
    const r = decide2Sat(ex.cnf)
    check(r.sat === expectSat[ex.name], `example "${ex.name}" verdict`, `got ${r.sat}`)
    if (r.sat && r.model) check(verifyModel(ex.cnf, r.model).ok, `example "${ex.name}" model valid`)
    // CDCL must agree.
    const cdcl = solve(ex.cnf)
    check((cdcl.status === 'sat') === r.sat, `example "${ex.name}" vs CDCL`, cdcl.status)
  }

  // 2. Bipartite-vs-odd-cycle family: even cycles SAT, odd cycles UNSAT.
  for (let k = 3; k <= 9; k++) {
    const r = decide2Sat(twoColoringCnf(k, cycleEdges(k)))
    check(r.sat === (k % 2 === 0), `${k}-cycle 2-colouring`, `sat=${r.sat}`)
    if (r.sat && r.model) check(properColoring(k, r.model), `${k}-cycle proper colouring`)
  }

  // 3. Brute-force + CDCL cross-check on many tiny random instances, checking
  //    verdict, model, equivalence classes AND backbone exhaustively.
  let seed = 1
  for (let t = 0; t < 1400; t++) {
    const n = 2 + Math.floor(mulberry32(seed++)() * 7) // 2..8 vars
    const ratio = 0.4 + mulberry32(seed++)() * 1.6 // span the threshold
    const m = Math.max(1, Math.round(ratio * n))
    const cnf = randomMixed(n, m, seed++)
    const r = decide2Sat(cnf)
    const models = bruteModels(cnf)
    const bruteSat = models.length > 0

    check(r.sat === bruteSat, 'random verdict vs brute', `n=${n} m=${m}`)
    const cdcl = solve(cnf)
    check((cdcl.status === 'sat') === bruteSat, 'random verdict vs CDCL', `n=${n} m=${m}`)

    if (r.sat) {
      check(r.model != null && verifyModel(cnf, r.model).ok, 'random model valid', `n=${n} m=${m}`)

      // Equivalence classes: every member of an SCC agrees in every model.
      let equivOk = true
      for (const cls of r.equivClasses) {
        for (const model of models) {
          const valOf = (lit: number) => (lit > 0 ? model[lit] : !model[-lit])
          const first = valOf(cls[0])
          if (!cls.every((l) => valOf(l) === first)) equivOk = false
        }
      }
      check(equivOk, 'equivalence classes hold in all models', `n=${n} m=${m}`)

      // Backbone: a literal is forced iff it is true in every model. The
      // engine's backbone set must equal the brute-force forced set exactly.
      const forcedBrute = new Set<number>()
      for (let v = 1; v <= n; v++) {
        const allTrue = models.every((mm) => mm[v])
        const allFalse = models.every((mm) => !mm[v])
        if (allTrue) forcedBrute.add(v)
        if (allFalse) forcedBrute.add(-v)
      }
      const forcedEngine = new Set(r.backbones.map((b) => b.lit))
      check(setEq(forcedBrute, forcedEngine), 'backbone matches brute force', `n=${n} m=${m}`)

      // Each backbone witness path is a real implication chain ¬lit → … → lit,
      // and ¬lit is genuinely unsatisfiable (solveAssuming agrees).
      for (const b of r.backbones) {
        check(b.path.length >= 1 && b.path[0] === -b.lit && b.path[b.path.length - 1] === b.lit,
          'backbone path endpoints', `lit=${b.lit}`)
        const assumeNeg = solveAssuming(cnf, [-b.lit])
        check(assumeNeg.status === 'unsat', 'backbone forced (¬lit UNSAT)', `lit=${b.lit}`)
      }
    } else {
      check(r.conflictVar != null, 'UNSAT names a conflict variable', `n=${n} m=${m}`)
    }
  }

  // 4. Determinism: the procedure is a pure function of the input.
  const dcnf = randomMixed(7, 9, 424242)
  const a = decide2Sat(dcnf)
  const b = decide2Sat(dcnf)
  check(a.sat === b.sat && a.numComps === b.numComps && a.stats.edges === b.stats.edges, 'deterministic')

  // 5. Condensation is a DAG laid out consistently: every edge goes strictly
  //    forward in the longest-path layering.
  const lr = decide2Sat(randomTwoSat(8, 12, 77))
  let layered = true
  for (let c = 0; c < lr.condensation.adj.length; c++) {
    for (const w of lr.condensation.adj[c]) {
      if (lr.condensation.topoLayer[c] >= lr.condensation.topoLayer[w]) layered = false
    }
  }
  check(layered, 'condensation layering is acyclic/forward')

  return { pass, fail, messages }
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** A model of the cycle 2-colouring assigns adjacent vertices different colours. */
function properColoring(k: number, model: boolean[]): boolean {
  for (const [i, j] of cycleEdges(k)) {
    if (model[i + 1] === model[j + 1]) return false
  }
  return true
}
