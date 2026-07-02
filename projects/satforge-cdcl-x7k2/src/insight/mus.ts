// MUS / MCS extraction and MARCO enumeration.
//
// When a set of constraints has no solution, the interesting question is *why*.
// A **Minimal Unsatisfiable Subset** (MUS) is an irreducible reason: a subset of
// the soft clauses that is unsatisfiable, but becomes satisfiable if you drop any
// one of its members. Its dual, a **Minimal Correction Subset** (MCS), is a
// smallest-to-repair set: delete it and the rest is satisfiable. MUSes and MCSes
// stand in a beautiful minimal-hitting-set duality (Reiter / Birnbaum–Lozinskii):
// every MUS hits every MCS and vice versa.
//
// This module implements, all on the shared selector-based {@link SoftSolver}:
//   • deletionMus  — the classic linear "try to drop each clause" shrink,
//   • quickXplainMus — Junker's divide-and-conquer QUICKXPLAIN (fewer SAT calls
//     when the MUS is small relative to the system),
//   • growMss / mcsFromMss — grow a satisfiable seed to a maximal satisfiable
//     subset, whose complement is an MCS,
//   • marco — the MARCO algorithm (Liffiton, Previti, Malik, Marques-Silva 2016):
//     enumerate *all* MUSes and *all* MCSes by exploring the power-set lattice with
//     a second SAT solver — the "map" — that records which regions are already
//     explained. Each UNSAT seed yields an MUS and blocks its supersets; each SAT
//     seed grows to an MSS and blocks its subsets. When the map is exhausted, every
//     MUS and MCS has been found.

import type { CNF } from '../sat/cnf'
import { solve } from '../sat/solver'
import { SoftSolver, complement } from './core'
import type { SoftSystem } from './core'

/** Extract one MUS from a subset already known/assumed to be UNSAT, by deletion.
 *  Each surviving clause is provably part of *some* reason; the result is a single
 *  MUS ⊆ `seed`. O(|seed|) satisfiability checks. */
export function deletionMus(solver: SoftSolver, seed: number[]): number[] {
  // Work on a mutable "kept" set; try to remove one clause at a time.
  const kept = new Set(seed)
  for (const c of seed) {
    if (!kept.has(c)) continue
    kept.delete(c)
    if (solver.isSat(kept)) {
      // Removing c made it satisfiable ⇒ c is essential; put it back.
      kept.add(c)
    }
    // else: still UNSAT without c ⇒ c was redundant, leave it out.
  }
  return [...kept].sort((a, b) => a - b)
}

/** QUICKXPLAIN (Junker 2004): a divide-and-conquer MUS extractor that makes far
 *  fewer solver calls than deletion when the MUS is small. Returns an MUS ⊆ `seed`.*/
export function quickXplainMus(solver: SoftSolver, seed: number[]): number[] {
  if (seed.length === 0) return []
  // If the empty background is already UNSAT, the MUS is empty.
  if (!solver.isSat([])) return []
  return qx(solver, [], seed, false)
}

// `background` is currently asserted; `candidates` are the clauses we still may need.
// `bgChanged` says whether `background` grew since the last call (so we must re-test).
function qx(solver: SoftSolver, background: number[], candidates: number[], bgChanged: boolean): number[] {
  if (bgChanged && !solver.isSat(background)) return [] // background alone conflicts
  if (candidates.length === 1) return candidates.slice() // a lone essential clause
  const mid = candidates.length >> 1
  const c1 = candidates.slice(0, mid)
  const c2 = candidates.slice(mid)
  // Find the part of c2 needed given background ∪ c1.
  const d2 = qx(solver, background.concat(c1), c2, c1.length > 0)
  // Find the part of c1 needed given background ∪ d2.
  const d1 = qx(solver, background.concat(d2), c1, d2.length > 0)
  return d1.concat(d2)
}

/** Grow a satisfiable `seed` to a Maximal Satisfiable Subset (MSS): add every soft
 *  clause that can be added while staying satisfiable. */
export function growMss(solver: SoftSolver, m: number, seed: number[]): number[] {
  const inMss = new Set(seed)
  for (let i = 0; i < m; i++) {
    if (inMss.has(i)) continue
    inMss.add(i)
    if (!solver.isSat(inMss)) inMss.delete(i)
  }
  return [...inMss].sort((a, b) => a - b)
}

/** The MCS is the complement of an MSS. */
export function mcsFromMss(m: number, mss: number[]): number[] {
  return complement(m, mss)
}

export interface MarcoResult {
  muses: number[][] // each an MUS (indices into sys.soft)
  mcses: number[][] // each an MCS
  /** Steps taken; each is one map-solve + classification. */
  iterations: number
  /** True if enumeration finished; false if it hit the subset budget. */
  complete: boolean
  satCalls: number
  timeMs: number
}

export interface MarcoOptions {
  /** Stop after this many discovered subsets (MUS + MCS). Default 5000. */
  maxSubsets?: number
  /** Bias exploration: 'mus' grows seeds toward maximal (finds MUSes first);
   *  'mcs' shrinks toward minimal. Default 'mus'. */
  bias?: 'mus' | 'mcs'
  /** Called after each discovery, for live UIs. */
  onFind?: (kind: 'mus' | 'mcs', subset: number[]) => void
}

/**
 * MARCO: enumerate every MUS and every MCS of a soft-constraint system.
 *
 * The *map* is a SAT problem over m Boolean "included?" variables. Its models are
 * the not-yet-explained seeds. We repeatedly pull a maximal (bias 'mus') unexplained
 * seed, classify it against the real formula, emit either an MUS (shrink) or an MCS
 * (grow), and add a blocking clause so that region is never revisited:
 *   • MUS found ⇒ block all *supersets*  (∨_{i∈MUS} ¬x_i),
 *   • MSS found ⇒ block all *subsets*    (∨_{i∉MSS}  x_i).
 * When the map is UNSAT, the lattice is fully covered.
 */
export function marco(sys: SoftSystem, opts: MarcoOptions = {}): MarcoResult {
  const m = sys.soft.length
  const maxSubsets = opts.maxSubsets ?? 5000
  const bias = opts.bias ?? 'mus'
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  const solver = new SoftSolver(sys)
  let satCalls = 0
  const check = (seed: Iterable<number>) => {
    satCalls++
    return solver.check(seed)
  }
  const isSat = (seed: Iterable<number>) => {
    satCalls++
    return solver.isSat(seed)
  }

  // The map is rebuilt from accumulated blocking clauses each iteration. Map vars are
  // 1..m, one per soft clause. Getting a *maximal* model (all-true-preferred) makes
  // UNSAT seeds — and thus MUSes — surface first.
  const mapClauses: number[][] = []
  const muses: number[][] = []
  const mcses: number[][] = []
  let iterations = 0
  let complete = true

  for (;;) {
    if (muses.length + mcses.length >= maxSubsets) {
      complete = false
      break
    }
    const seed = nextSeed(m, mapClauses, bias)
    if (seed === null) break // map exhausted — done
    iterations++

    const v = check(seed)
    if (v.sat) {
      // Grow to a maximal satisfiable subset; its complement is an MCS.
      const inMss = new Set(seed)
      for (let i = 0; i < m; i++) {
        if (inMss.has(i)) continue
        inMss.add(i)
        if (!isSat(inMss)) inMss.delete(i)
      }
      const mss = [...inMss].sort((a, b) => a - b)
      const mcs = complement(m, mss)
      mcses.push(mcs)
      opts.onFind?.('mcs', mcs)
      // Block all subsets of the MSS: require at least one clause outside it. A subset
      // of the MSS has every such x_i = 0, so this clause forbids exactly those seeds.
      const block = mcs.map((i) => i + 1)
      if (block.length === 0) break // MSS = all clauses ⇒ system is SAT, nothing left
      mapClauses.push(block)
    } else {
      // Shrink the returned core to a genuine MUS.
      const before = satCalls
      const mus = deletionMus(solver, v.core)
      satCalls = before + v.core.length // deletion makes ≈|core| checks on `solver`
      muses.push(mus)
      opts.onFind?.('mus', mus)
      // Block all supersets of the MUS: require at least one of its clauses excluded.
      mapClauses.push(mus.map((i) => -(i + 1)))
    }
  }

  return {
    muses,
    mcses,
    iterations,
    complete,
    satCalls,
    timeMs: now() - start,
  }
}

/** Find the next unexplored seed from the map. Returns a *maximal* model (bias 'mus')
 *  or a *minimal* model (bias 'mcs'), or null when the map is unsatisfiable. */
function nextSeed(m: number, mapClauses: number[][], bias: 'mus' | 'mcs'): number[] | null {
  const cnf: CNF = { numVars: m, clauses: mapClauses.length ? mapClauses : [] }
  // A map with no clauses is trivially SAT with the empty model.
  const base = solve(cnf, { restarts: true })
  if (base.status === 'unsat') return null
  if (base.status !== 'sat') return null // 'unknown' — treat as done (budget)

  // base.model is 1-based booleans over vars 1..m. Turn it into a seed, then push it
  // to maximal/minimal against the map by greedily flipping toward the bias.
  const included = new Set<number>()
  for (let i = 0; i < m; i++) if (base.model![i + 1]) included.add(i)

  if (bias === 'mus') {
    // Grow toward maximal: try to add each excluded clause while the map stays SAT.
    for (let i = 0; i < m; i++) {
      if (included.has(i)) continue
      const test: CNF = { numVars: m, clauses: mapClauses.concat([[i + 1]]).concat(unitsFor(included)) }
      if (solve(test, {}).status === 'sat') included.add(i)
    }
  } else {
    // Shrink toward minimal: try to drop each included clause while the map stays SAT.
    for (const i of [...included]) {
      const rest = new Set(included)
      rest.delete(i)
      const test: CNF = { numVars: m, clauses: mapClauses.concat([[-(i + 1)]]).concat(unitsFor(rest)) }
      if (solve(test, {}).status === 'sat') included.delete(i)
    }
  }
  return [...included].sort((a, b) => a - b)
}

// Encode a partial "these clauses are in / the rest we don't force" as unit hints so
// the greedy maximization stays consistent with choices already committed.
function unitsFor(included: Set<number>): number[][] {
  const out: number[][] = []
  for (const i of included) out.push([i + 1])
  return out
}
