// A compact, mutable working representation of a CNF tuned for *incremental*
// local search: each variable carries its clause-occurrence list (with the sign
// of its literal), so a single variable flip can be applied — and its effect on
// the per-clause true-literal counts undone — in time proportional to the
// variable's degree rather than the size of the whole formula.
//
// This is the substrate shared by every incomplete solver in the Phys Studio
// (GSAT / WalkSAT / ProbSAT / Novelty, simulated annealing). Survey propagation
// works on the factor graph directly (see `surveyprop.ts`) and only borrows the
// deterministic RNG and the model verifier from here.

import type { CNF } from '../sat/cnf'

/** One appearance of a variable inside a clause. */
export interface Occurrence {
  /** Index of the clause in the working formula. */
  clause: number
  /** True when the variable appears as a positive literal (`+v`) in that clause. */
  positive: boolean
}

/** A deterministic, reproducible PRNG (mulberry32) — the project's house RNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The immutable shape of a formula for local search: clauses (each an array of
 * signed DIMACS literals) plus, for every variable, the list of clauses it
 * touches and the polarity of its literal there. Construct it once per instance;
 * the mutable assignment lives in {@link SearchState}.
 */
export class WorkingFormula {
  readonly numVars: number
  /** Clauses as signed DIMACS literals, e.g. `[1, -3, 4]`. Empty clauses dropped. */
  readonly clauses: number[][]
  /** `occ[v]` (1-based) — every clause `v` appears in, with its sign. */
  readonly occ: Occurrence[][]

  constructor(cnf: CNF) {
    this.numVars = cnf.numVars
    // Drop empty clauses (an empty clause is trivially unsatisfiable and would
    // wedge the search); callers that care about UNSAT use the complete solver.
    this.clauses = cnf.clauses.filter((c) => c.length > 0).map((c) => c.slice())
    this.occ = Array.from({ length: cnf.numVars + 1 }, () => [] as Occurrence[])
    for (let c = 0; c < this.clauses.length; c++) {
      for (const lit of this.clauses[c]) {
        const v = Math.abs(lit)
        if (v >= 1 && v <= cnf.numVars) this.occ[v].push({ clause: c, positive: lit > 0 })
      }
    }
  }

  /** True iff this formula contains a (syntactically) empty clause. */
  get hasEmptyClause(): boolean {
    return false // empties are filtered in the constructor
  }
}

/**
 * The mutable state of a single local-search trajectory over a {@link WorkingFormula}:
 * the current 0/1 assignment, the per-clause count of satisfied literals, and the
 * set of currently-unsatisfied clauses kept as a swap-to-back array for O(1)
 * membership and uniform random selection.
 */
export class SearchState {
  readonly f: WorkingFormula
  /** `assign[v]` (1-based) — 1 = true, 0 = false. Index 0 is unused. */
  readonly assign: Uint8Array
  /** `trueLits[c]` — number of literals satisfied in clause `c`. */
  readonly trueLits: Int32Array
  /** The unsatisfied clauses, as a dense array (order is arbitrary). */
  readonly unsat: number[] = []
  /** `unsatPos[c]` — index of clause `c` inside {@link unsat}, or -1. */
  private readonly unsatPos: Int32Array

  constructor(f: WorkingFormula) {
    this.f = f
    this.assign = new Uint8Array(f.numVars + 1)
    this.trueLits = new Int32Array(f.clauses.length)
    this.unsatPos = new Int32Array(f.clauses.length).fill(-1)
  }

  /** Number of currently-unsatisfied clauses (the search "energy"). */
  get energy(): number {
    return this.unsat.length
  }

  /** Is literal `lit` (signed DIMACS) currently true under the assignment? */
  litTrue(lit: number): boolean {
    const v = Math.abs(lit)
    return lit > 0 ? this.assign[v] === 1 : this.assign[v] === 0
  }

  /** Reset to a fresh random assignment and recompute all derived structure. */
  randomize(rand: () => number): void {
    for (let v = 1; v <= this.f.numVars; v++) this.assign[v] = rand() < 0.5 ? 1 : 0
    this.recompute()
  }

  /** Reset to a given assignment (1-based boolean[]) and recompute. */
  setAssignment(model: boolean[]): void {
    for (let v = 1; v <= this.f.numVars; v++) this.assign[v] = model[v] ? 1 : 0
    this.recompute()
  }

  /** Recompute `trueLits` and the unsat set from scratch for the current assignment. */
  private recompute(): void {
    this.unsat.length = 0
    this.unsatPos.fill(-1)
    for (let c = 0; c < this.f.clauses.length; c++) {
      let t = 0
      for (const lit of this.f.clauses[c]) if (this.litTrue(lit)) t++
      this.trueLits[c] = t
      if (t === 0) {
        this.unsatPos[c] = this.unsat.length
        this.unsat.push(c)
      }
    }
  }

  private markUnsat(c: number): void {
    if (this.unsatPos[c] !== -1) return
    this.unsatPos[c] = this.unsat.length
    this.unsat.push(c)
  }

  private markSat(c: number): void {
    const p = this.unsatPos[c]
    if (p === -1) return
    const last = this.unsat.pop()!
    if (last !== c) {
      this.unsat[p] = last
      this.unsatPos[last] = p
    }
    this.unsatPos[c] = -1
  }

  /**
   * Number of clauses that would become unsatisfied if `v` were flipped — i.e.
   * clauses currently satisfied *only* by `v`'s literal. This is the WalkSAT
   * "break-count", computed on demand in O(deg(v)).
   */
  breakCount(v: number): number {
    let b = 0
    for (const o of this.f.occ[v]) {
      // v's literal is currently true here iff (positive == assign==1).
      const litTrue = o.positive === (this.assign[v] === 1)
      if (litTrue && this.trueLits[o.clause] === 1) b++
    }
    return b
  }

  /** Number of currently-unsatisfied clauses that flipping `v` would satisfy. */
  makeCount(v: number): number {
    let m = 0
    for (const o of this.f.occ[v]) {
      const litTrue = o.positive === (this.assign[v] === 1)
      if (!litTrue && this.trueLits[o.clause] === 0) m++
    }
    return m
  }

  /** Net change in energy (unsat count) from flipping `v`: break − make. */
  delta(v: number): number {
    return this.breakCount(v) - this.makeCount(v)
  }

  /** Flip variable `v`, updating clause counts and the unsat set incrementally. */
  flip(v: number): void {
    const nowTrue = this.assign[v] === 0 // value after the flip
    this.assign[v] = nowTrue ? 1 : 0
    for (const o of this.f.occ[v]) {
      const litNowTrue = o.positive === nowTrue
      const c = o.clause
      if (litNowTrue) {
        // this literal just became true
        if (this.trueLits[c] === 0) this.markSat(c)
        this.trueLits[c]++
      } else {
        // this literal just became false
        this.trueLits[c]--
        if (this.trueLits[c] === 0) this.markUnsat(c)
      }
    }
  }

  /** A copy of the current assignment as a 1-based boolean[] (for verifyModel). */
  model(): boolean[] {
    const m = new Array<boolean>(this.f.numVars + 1).fill(false)
    for (let v = 1; v <= this.f.numVars; v++) m[v] = this.assign[v] === 1
    return m
  }
}
