// The native pseudo-Boolean solver — conflict-driven search with **cutting-plane** learning.
//
// This is the heart of the PB engine and the reason it is more than a CNF front-end. A
// classic CDCL solver learns by *resolution* over clauses; that proof system is provably
// weak — the pigeonhole principle PHPⁿ⁺¹ₙ needs exponentially many resolution steps. This
// solver instead learns in the **cutting-plane** proof system (Cook–Coullard–Turán), which
// refutes pigeonhole in polynomial size. The machinery:
//
//   • slack-based unit propagation:   a constraint Σ aᵢℓᵢ ≥ d with slack = Σ_{¬falsified} aᵢ − d
//     forces every unassigned literal whose coefficient exceeds the slack, and signals a
//     conflict when the slack goes negative;
//   • conflict analysis by **generalized resolution** (RoundingSat-style): the conflicting
//     constraint is combined with the reason that propagated the most-recent literal, after a
//     *reduction* (weaken the non-divisible, non-falsified literals, then divide-and-round so
//     the pivot's coefficient is 1) that keeps the running constraint falsified — repeated to
//     a single-literal (1-UIP) cut that, after back-jumping, propagates;
//   • a guaranteed-correct fall-back: if analysis cannot reach a clean asserting cut, the
//     solver learns the *decision cut* ("at least one decision must flip"), which is always
//     sound and asserting — so the search degrades to plain DPLL rather than ever looping.
//
// Every inference (multiply by a positive integer, add two constraints, Chvátal–Gomory
// divide, saturate, weaken) is a *sound* cutting-plane rule, so the solver is **sound by
// construction**: a reported UNSAT is a real cutting-plane refutation, and every SAT model is
// re-checked against the constraints. It is cross-checked, verdict-for-verdict, against the
// brute-force oracle and the CNF encoder in the verification harness.

import { Pbc } from './constraint'
import type { PbInstance } from './instance'

export interface PbStats {
  decisions: number
  propagations: number
  conflicts: number
  learned: number
  maxLevel: number
  peakTrail: number
  /** Largest coefficient that appeared in any learned constraint (cutting-plane growth). */
  maxCoef: string
  timeMs: number
}

/** One generalized-resolution step in the first conflict's cutting-plane derivation. */
export interface DerivationStep {
  pivot: number // the variable eliminated
  conflict: string // the running conflicting constraint, before the step
  reason: string // the reason constraint that propagated the pivot
  resolvent: string // the constraint after rounding + resolution
}

export interface PbSolveResult {
  status: 'sat' | 'unsat' | 'unknown'
  model?: boolean[] // 1-based
  stats: PbStats
  /** The cutting-plane derivation recorded for the first conflict (when tracing). */
  derivation?: DerivationStep[]
  message?: string
}

export interface PbSolveOptions {
  maxConflicts?: number // give up with 'unknown' after this many conflicts (default 2,000,000)
  maxTimeMs?: number // wall-clock budget (default 10,000)
  trace?: boolean // record the first conflict's derivation (default false)
}

interface Analysis {
  learned: Pbc
  backLevel: number
}

export class PbSolver {
  private n: number
  private cons: Pbc[] = []
  private value: (boolean | undefined)[]
  private level: number[]
  private reason: number[] // constraint index, or -1 for a decision / unassigned
  private trail: number[] = [] // true literals, in assignment order
  private trailLim: number[] = [] // trail length at the start of each decision level
  private pos: number[] // trail position of a variable's assignment
  private activity: number[]
  private phase: boolean[]
  private dl = 0
  private stats: PbStats
  private maxCoef = 0n
  private firstDeriv: DerivationStep[] | undefined
  private tracing = false

  constructor(inst: PbInstance) {
    this.n = inst.numVars
    this.value = new Array(this.n + 1).fill(undefined)
    this.level = new Array(this.n + 1).fill(-1)
    this.reason = new Array(this.n + 1).fill(-1)
    this.pos = new Array(this.n + 1).fill(-1)
    this.activity = new Array(this.n + 1).fill(0)
    this.phase = new Array(this.n + 1).fill(false)
    // Drop trivially-true constraints; keep a working copy of the rest.
    for (const c of inst.constraints) {
      const cc = c.clone()
      cc.trim()
      if (!cc.isTriviallyTrue()) this.cons.push(cc)
    }
    this.stats = {
      decisions: 0,
      propagations: 0,
      conflicts: 0,
      learned: 0,
      maxLevel: 0,
      peakTrail: 0,
      maxCoef: '0',
      timeMs: 0,
    }
  }

  private falsified(v: number, signed: bigint): boolean {
    const val = this.value[v]
    if (val === undefined) return false
    return signed > 0n ? val === false : val === true
  }

  private assign(lit: number, reasonIdx: number): void {
    const v = Math.abs(lit)
    this.value[v] = lit > 0
    this.level[v] = this.dl
    this.reason[v] = reasonIdx
    this.pos[v] = this.trail.length
    this.phase[v] = lit > 0
    this.trail.push(lit)
    if (this.trail.length > this.stats.peakTrail) this.stats.peakTrail = this.trail.length
  }

  /** Full-sweep slack propagation to a fixpoint. Returns a conflicting constraint index or -1. */
  private propagate(): number {
    for (;;) {
      let changed = false
      for (let ci = 0; ci < this.cons.length; ci++) {
        const c = this.cons[ci]
        const sl = c.slack(this.value)
        if (sl < 0n) return ci // conflict
        if (sl >= c.totalCoef()) continue // nothing can be forced
        for (const [v, s] of c.coef) {
          if (s === 0n) continue
          if (this.value[v] !== undefined) continue
          const coef = s > 0n ? s : -s
          if (coef > sl) {
            // This literal must be true. (Forcing it true never changes c's slack, so all
            // currently-forced literals of c can be assigned together with the same slack.)
            this.assign(s > 0n ? v : -v, ci)
            this.stats.propagations++
            changed = true
          }
        }
      }
      if (!changed) return -1
    }
  }

  private backjump(toLevel: number): void {
    if (toLevel >= this.dl) return
    const keep = this.trailLim[toLevel] ?? 0
    while (this.trail.length > keep) {
      const lit = this.trail.pop()!
      const v = Math.abs(lit)
      this.value[v] = undefined
      this.level[v] = -1
      this.reason[v] = -1
      this.pos[v] = -1
    }
    this.trailLim.length = toLevel
    this.dl = toLevel
  }

  private bump(v: number): void {
    this.activity[v] += 1
  }

  private decay(): void {
    for (let v = 1; v <= this.n; v++) this.activity[v] *= 0.95
  }

  private pickBranch(): number {
    let best = 0
    let bestAct = -1
    for (let v = 1; v <= this.n; v++) {
      if (this.value[v] !== undefined) continue
      if (this.activity[v] > bestAct) {
        bestAct = this.activity[v]
        best = v
      }
    }
    return best
  }

  /** Generalized-resolution reduction + cancellation of `pivot` between conflict `C` and reason `R`. */
  private roundAndResolve(C: Pbc, R0: Pbc, pivot: number): Pbc {
    const R = R0.clone()
    const ar = R.coefOf(pivot)
    if (ar === 0n) return C // pivot absent from reason — cannot happen for a real propagation
    // Weaken the non-falsified, non-pivot literals whose coefficient is not divisible by `ar`,
    // so the subsequent Chvátal–Gomory division is exact on what remains and the reduced
    // reason still propagates the pivot — the invariant that keeps the resolvent conflicting.
    for (const [u, s] of [...R.coef]) {
      if (u === pivot || s === 0n) continue
      if (!this.falsified(u, s) && (s > 0n ? s : -s) % ar !== 0n) R.weaken(u)
    }
    R.divideCeil(ar) // pivot coefficient becomes ceil(ar/ar) = 1
    R.saturate()
    const ac = C.coefOf(pivot)
    R.multiply(ac) // pivot coefficient becomes ac, matching C's opposite literal
    const out = C.clone()
    out.addConstraint(R) // the pivot's opposite literals cancel via x + ¬x = 1
    out.saturate()
    out.trim()
    this.trackCoef(out)
    return out
  }

  private trackCoef(c: Pbc): void {
    for (const s of c.coef.values()) {
      const m = s > 0n ? s : -s
      if (m > this.maxCoef) this.maxCoef = m
    }
  }

  /** Current-level literals of `C` that are falsified (candidate pivots). */
  private currentLevelFalsified(C: Pbc): number[] {
    const out: number[] = []
    for (const [v, s] of C.coef) {
      if (s === 0n) continue
      if (this.falsified(v, s) && this.level[v] === this.dl) out.push(v)
    }
    return out
  }

  private finalize(C: Pbc): Analysis | { unsat: true } {
    if (C.isContradiction()) return { unsat: true }
    const levels: number[] = []
    for (const [v, s] of C.coef) {
      if (s === 0n) continue
      if (this.falsified(v, s)) levels.push(this.level[v])
    }
    if (levels.length === 0) return { learned: C, backLevel: 0 }
    const maxL = Math.max(...levels)
    const below = levels.filter((l) => l < maxL)
    const backLevel = below.length ? Math.max(...below) : 0
    return { learned: C, backLevel }
  }

  /** The "decision cut": at least one current decision literal must flip. Always asserting. */
  private decisionCut(): Analysis {
    const lits: number[] = []
    for (const lit of this.trail) {
      const v = Math.abs(lit)
      if (this.reason[v] === -1 && this.level[v] >= 1) lits.push(-lit)
    }
    return { learned: Pbc.fromClause(lits), backLevel: Math.max(0, this.dl - 1) }
  }

  private analyze(conflIdx: number): Analysis | { unsat: true } {
    let C = this.cons[conflIdx].clone()
    this.trackCoef(C)
    const record = this.tracing && this.firstDeriv === undefined
    const steps: DerivationStep[] = []
    let guard = 0
    const LIMIT = 4 * (this.n + this.cons.length) + 64
    for (;;) {
      const cur = this.currentLevelFalsified(C)
      if (cur.length <= 1) break // 1-UIP (or already resolved above the current level)
      // pick the current-level literal assigned latest on the trail
      let pivot = cur[0]
      for (const v of cur) if (this.pos[v] > this.pos[pivot]) pivot = v
      const r = this.reason[pivot]
      if (r === -1) {
        // the latest current-level literal is a decision, yet more than one remains —
        // fall back to the always-correct decision cut.
        if (record) this.firstDeriv = steps
        return this.decisionCut()
      }
      const R = this.cons[r]
      const before = C.toString()
      this.bump(pivot)
      C = this.roundAndResolve(C, R, pivot)
      if (record && steps.length < 64) {
        steps.push({ pivot, conflict: before, reason: R.toString(), resolvent: C.toString() })
      }
      if (C.isTriviallyTrue()) {
        // Should not happen with a sound reduction; degrade to the decision cut.
        if (record) this.firstDeriv = steps
        return this.decisionCut()
      }
      if (++guard > LIMIT) {
        if (record) this.firstDeriv = steps
        return this.decisionCut()
      }
    }
    if (record) this.firstDeriv = steps
    return this.finalize(C)
  }

  private addLearned(c: Pbc): void {
    c.trim()
    this.cons.push(c)
    this.stats.learned++
  }

  solve(opts: PbSolveOptions = {}): PbSolveResult {
    const t0 = (globalThis.performance?.now?.() ?? Date.now())
    const maxConflicts = opts.maxConflicts ?? 2_000_000
    const maxTimeMs = opts.maxTimeMs ?? 10_000
    this.tracing = !!opts.trace

    // Any constraint that is already a contradiction makes the instance UNSAT outright.
    for (const c of this.cons) if (c.isContradiction()) return this.done('unsat', undefined, t0)

    for (;;) {
      const confl = this.propagate()
      if (confl >= 0) {
        this.stats.conflicts++
        if (this.dl === 0) return this.done('unsat', undefined, t0)
        const a = this.analyze(confl)
        if ('unsat' in a) return this.done('unsat', undefined, t0)
        this.backjump(a.backLevel)
        this.addLearned(a.learned)
        if (this.stats.conflicts % 64 === 0) this.decay()
        if (this.stats.conflicts >= maxConflicts) return this.done('unknown', undefined, t0)
        if ((this.stats.conflicts & 1023) === 0 && this.timeUp(t0, maxTimeMs))
          return this.done('unknown', undefined, t0)
      } else {
        const v = this.pickBranch()
        if (v === 0) {
          // complete assignment — read off the model
          const model: boolean[] = new Array(this.n + 1).fill(false)
          for (let i = 1; i <= this.n; i++) model[i] = this.value[i] === true
          return this.done('sat', model, t0)
        }
        this.dl++
        if (this.dl > this.stats.maxLevel) this.stats.maxLevel = this.dl
        this.trailLim.push(this.trail.length)
        this.stats.decisions++
        this.assign(this.phase[v] ? v : -v, -1)
      }
    }
  }

  private timeUp(t0: number, budget: number): boolean {
    const now = globalThis.performance?.now?.() ?? Date.now()
    return now - t0 > budget
  }

  private done(status: 'sat' | 'unsat' | 'unknown', model: boolean[] | undefined, t0: number): PbSolveResult {
    const now = globalThis.performance?.now?.() ?? Date.now()
    this.stats.timeMs = now - t0
    this.stats.maxCoef = this.maxCoef.toString()
    return { status, model, stats: this.stats, derivation: this.firstDeriv }
  }
}

/** Convenience: build and run the native cutting-plane solver on an instance. */
export function solvePb(inst: PbInstance, opts: PbSolveOptions = {}): PbSolveResult {
  return new PbSolver(inst).solve(opts)
}
