// A hybrid DPLL(⊕) solver: ordinary clause reasoning *and* a Gaussian-elimination
// propagator working side by side on one partial assignment. This is the core
// idea behind CryptoMiniSat — parity structure that pure clause search must
// enumerate exponentially is annihilated by linear algebra in polynomial time.
//
// The loop alternates two propagators to a joint fixpoint:
//
//   1. **unit propagation** over the CNF part (a clause with one unassigned
//      literal and the rest false forces that literal; an all-false clause is a
//      conflict), and
//   2. **Gaussian propagation** over the XOR part: substitute the current
//      assignment into the parity equations, reduce the residual system to RREF,
//      and read off (a) an inconsistency — a `0 = 1` row is a conflict — and
//      (b) every equation that has collapsed to a single variable, which forces
//      that variable. Feeding those forced literals back to step 1 (and vice
//      versa) is what makes the two engines cooperate.
//
// When the fixpoint assigns nothing new and variables remain, we branch. The
// search is plain chronological DPLL — deliberately *not* CDCL — so its job is
// to be transparently **correct** (it agrees move-for-move with the project's
// clausal CDCL on the expanded formula), while the Gaussian propagator is what
// makes it *fast* on parity-heavy inputs. The contrast is the whole point.

import type { XorCnf } from './xor'
import { xorsToSystem } from './xor'
import { rref, type Gf2System } from './gf2'

export interface MixedStats {
  /** Branching decisions taken. */
  decisions: number
  /** Literals forced by unit propagation. */
  unitProps: number
  /** Literals forced by Gaussian propagation. */
  gaussProps: number
  /** Calls to the RREF reducer (the linear-algebra work). */
  gaussReductions: number
  /** Dead ends hit (either propagator's conflict). */
  conflicts: number
  /** Deepest decision level reached. */
  maxDepth: number
  timeMs: number
  /** True if the node budget was exhausted (result is then `unknown`). */
  budgetHit: boolean
}

export interface MixedResult {
  status: 'sat' | 'unsat' | 'unknown'
  /** 1-based; `model[v]` is the truth value of variable v (only when sat). */
  model?: boolean[]
  stats: MixedStats
}

export interface MixedOptions {
  /** Abort after this many decisions (returns `unknown`). Default 500_000. */
  budget?: number
}

const UNASSIGNED = 0

// The head-to-head "without linear reasoning" baseline never toggles a flag on
// this engine — doing so would silently *drop* the parity constraints and give
// a wrong answer. Instead the caller expands the XORs to their equivalent
// clauses (see `xorCnfToCnf`) and runs this same DPLL on the all-clause problem,
// so the two runs differ only in whether Gauss annihilates the parity structure.
export function solveMixed(p: XorCnf, opts: MixedOptions = {}): MixedResult {
  const budget = opts.budget ?? 500_000
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const start = now()
  const n = p.numVars

  // Clause store as flat literal arrays; assignment is 1-based (0 unassigned).
  const clauses = p.clauses
  // XOR rows as (0-based mask, rhs); we rebuild residuals against the assignment.
  const xsys: Gf2System = xorsToSystem(p.xors, n)

  const stats: MixedStats = {
    decisions: 0,
    unitProps: 0,
    gaussProps: 0,
    gaussReductions: 0,
    conflicts: 0,
    maxDepth: 0,
    timeMs: 0,
    budgetHit: false,
  }

  const assign = new Int8Array(n + 1) // 0 unassigned, 1 true, -1 false

  /** Unit-propagate the CNF to fixpoint. Returns false on a conflict. */
  function unitPropagate(): boolean {
    let changed = true
    while (changed) {
      changed = false
      for (const c of clauses) {
        let unassignedLit = 0
        let unassignedCount = 0
        let satisfied = false
        for (const lit of c) {
          const v = lit > 0 ? lit : -lit
          const a = assign[v]
          if (a === UNASSIGNED) {
            unassignedCount++
            unassignedLit = lit
            if (unassignedCount > 1) break
          } else if ((lit > 0 && a === 1) || (lit < 0 && a === -1)) {
            satisfied = true
            break
          }
        }
        if (satisfied) continue
        if (unassignedCount === 0) return false // all false ⇒ conflict
        if (unassignedCount === 1) {
          const v = unassignedLit > 0 ? unassignedLit : -unassignedLit
          assign[v] = unassignedLit > 0 ? 1 : -1
          stats.unitProps++
          changed = true
        }
      }
    }
    return true
  }

  /**
   * Gaussian-propagate the XOR part against the current assignment. Returns
   * false on a parity conflict; otherwise forces every variable a collapsed
   * (single-variable) equation pins, and reports whether it changed anything.
   */
  function gaussPropagate(): { ok: boolean; changed: boolean } {
    if (xsys.rows.length === 0) return { ok: true, changed: false }
    // Residual system over the unassigned variables only.
    const rows = xsys.rows.map((row) => {
      let mask = 0n
      let rhs = row.rhs
      let m = row.mask
      let v = 0
      while (m > 0n) {
        if ((m & 1n) !== 0n) {
          const a = assign[v + 1]
          if (a === UNASSIGNED) mask |= 1n << BigInt(v)
          else if (a === 1) rhs ^= 1
        }
        m >>= 1n
        v++
      }
      return { mask, rhs }
    })
    stats.gaussReductions++
    const rr = rref({ numVars: n, rows })
    if (rr.inconsistent) return { ok: false, changed: false }
    let changed = false
    for (let i = 0; i < rr.rank; i++) {
      const row = rr.rows[i]
      // A single-bit reduced row `x_c = rhs` forces variable c.
      if ((row.mask & (row.mask - 1n)) === 0n) {
        const c = rr.pivotCol[i] // lowest (only) set bit
        const val: 1 | -1 = row.rhs === 1 ? 1 : -1
        if (assign[c + 1] === UNASSIGNED) {
          assign[c + 1] = val
          stats.gaussProps++
          changed = true
        } else if (assign[c + 1] !== val) {
          return { ok: false, changed }
        }
      }
    }
    return { ok: true, changed }
  }

  /** Run both propagators to a joint fixpoint. Returns false on any conflict. */
  function propagate(): boolean {
    for (;;) {
      if (!unitPropagate()) return false
      const g = gaussPropagate()
      if (!g.ok) return false
      if (!g.changed) return true
    }
  }

  /** Pick an unassigned variable, or 0 if the assignment is total. */
  function pickVar(): number {
    for (let v = 1; v <= n; v++) if (assign[v] === UNASSIGNED) return v
    return 0
  }

  let done = false
  let sat = false

  function dpll(depth: number): void {
    if (done) return
    if (depth > stats.maxDepth) stats.maxDepth = depth
    if (stats.decisions > budget) {
      stats.budgetHit = true
      done = true
      return
    }
    if (!propagate()) {
      stats.conflicts++
      return
    }
    const v = pickVar()
    if (v === 0) {
      sat = true
      done = true
      return
    }
    // Snapshot so both polarities start from the propagated state.
    const snapshot = assign.slice()
    stats.decisions++
    for (const val of [1, -1] as const) {
      assign.set(snapshot)
      assign[v] = val
      dpll(depth + 1)
      if (done) return
    }
  }

  dpll(0)
  stats.timeMs = now() - start

  if (stats.budgetHit) return { status: 'unknown', stats }
  if (!sat) return { status: 'unsat', stats }
  const model = new Array<boolean>(n + 1).fill(false)
  for (let v = 1; v <= n; v++) model[v] = assign[v] === 1 // unassigned ⇒ don't-care ⇒ false
  return { status: 'sat', model, stats }
}
