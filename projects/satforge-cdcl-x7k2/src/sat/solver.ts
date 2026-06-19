// A from-scratch CDCL (Conflict-Driven Clause Learning) SAT solver.
//
// Implemented techniques, all from first principles:
//   • two-watched-literals unit propagation
//   • VSIDS branching with exponential activity decay (binary-heap var order)
//   • first-UIP clause learning with non-chronological backjumping
//   • recursive conflict-clause minimization (self-subsumption)
//   • phase saving
//   • Luby-sequenced restarts
//   • LBD-based learnt-clause database reduction
//
// The solver optionally records a full event trace (capped) and a snapshot of
// the first conflict's implication graph for visualization.

import type { CNF } from './cnf'
import type { ProofStep } from './drat'
import { VarOrderHeap } from './heap'
import { luby } from './luby'

// ---- internal literal encoding -------------------------------------------------
// lit = (var << 1) | sign,  var ∈ [0, numVars),  sign 0 = positive, 1 = negative.
const litVar = (l: number) => l >> 1
const neg = (l: number) => l ^ 1
const dimacsToLit = (d: number) => ((Math.abs(d) - 1) << 1) | (d < 0 ? 1 : 0)
const litToDimacs = (l: number) => ((l >> 1) + 1) * (l & 1 ? -1 : 1)

export interface SolverOptions {
  varDecay?: number // VSIDS variable activity decay (default 0.95)
  clauseDecay?: number // learnt-clause activity decay (default 0.999)
  restartBase?: number // conflicts in the first Luby restart (default 100)
  randomSeed?: number // RNG seed for tie-breaking / random decisions
  randomFreq?: number // probability of a random decision (default 0)
  branch?: 'vsids' | 'random' // branching heuristic (default 'vsids'); 'random' = uniform var choice
  phaseSaving?: boolean // re-use each variable's last truth value as its branch polarity (default true)
  restarts?: boolean // Luby-sequenced restarts (default true); false = never restart
  reduceDb?: boolean // periodic LBD-based learnt-clause database reduction (default true)
  minimize?: boolean // recursive learnt-clause minimization (default true)
  trace?: boolean // record a full event trace (default false)
  maxTrace?: number // cap on recorded trace events (default 30000)
  maxConflicts?: number // abort with 'unknown' after this many conflicts (0 = ∞)
  maxTimeMs?: number // abort with 'unknown' after this wall time (0 = ∞)
  proof?: boolean // record a DRAT proof of UNSAT (default false)
  maxProof?: number // cap on recorded proof steps (default 500000)
}

export type TraceEvent =
  | { t: 'decision'; lit: number; level: number }
  | { t: 'propagate'; lit: number; level: number; reason: number }
  | { t: 'conflict'; clause: number; level: number }
  | { t: 'learn'; lits: number[]; lbd: number; backLevel: number }
  | { t: 'backjump'; level: number }
  | { t: 'restart'; conflicts: number }
  | { t: 'reduce'; removed: number }
  | { t: 'unit'; lit: number } // a learnt unit fact

export interface ImplNode {
  lit: number // DIMACS literal that is TRUE
  level: number
  reason: number // clause index, or -1 for a decision
  reasonLits: number[] // antecedent clause as DIMACS lits (empty for decisions)
}

export interface ConflictSnapshot {
  conflictClause: number[] // DIMACS lits of the falsified clause
  nodes: ImplNode[] // every currently-assigned literal, with antecedents
  level: number
}

export interface SolveStats {
  decisions: number
  propagations: number
  conflicts: number
  learned: number
  removed: number
  restarts: number
  minimizedLits: number
  maxLevel: number
  peakTrail: number
  learntLiterals: number
  timeMs: number
}

export interface HistorySample {
  conflicts: number
  level: number
  learnt: number
  trail: number
}

export interface SolveResult {
  status: 'sat' | 'unsat' | 'unknown'
  model?: boolean[] // 1-based; model[v] is the truth value of variable v
  stats: SolveStats
  trace?: TraceEvent[]
  traceTruncated?: boolean
  firstConflict?: ConflictSnapshot
  history: HistorySample[]
  message?: string
  proof?: ProofStep[] // DRAT proof of UNSAT (only when opts.proof and status === 'unsat')
  proofTruncated?: boolean
}

// A tiny deterministic PRNG (mulberry32) so runs are reproducible.
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

export class CdclSolver {
  private numVars: number
  private clauseLits: number[][] = []
  private clauseLearnt: boolean[] = []
  private clauseActivity: number[] = []
  private clauseLbd: number[] = []
  private clauseDeleted: boolean[] = []
  private numOriginal = 0

  // watch[l] = clause indices whose watched literal ~? ... clauses registered in
  // watch[neg(w)] for each watched literal w (positions 0 and 1 in clauseLits[c]).
  private watch: number[][] = []

  // per-variable assignment state
  private value: Int8Array // 0 unknown, 1 true, -1 false
  private level: Int32Array
  private reason: Int32Array // clause index, or -1 for decision/none
  private polarity: Int8Array // saved phase: 1 -> try true first, -1 -> false
  private activity: Float64Array

  private trail: number[] = []
  private trailLim: number[] = []
  private qhead = 0

  private order: VarOrderHeap
  private varInc = 1
  private clauseInc = 1
  private readonly varDecay: number
  private readonly clauseDecay: number
  private readonly restartBase: number
  private readonly minimize: boolean
  private readonly trace: boolean
  private readonly maxTrace: number
  private readonly maxConflicts: number
  private readonly maxTimeMs: number
  private readonly proofOn: boolean
  private readonly maxProof: number
  private proof: ProofStep[] = []
  private proofTruncated = false
  private rng: () => number
  private readonly randomFreq: number
  private readonly branchRandom: boolean
  private readonly phaseSaving: boolean
  private readonly restartsOn: boolean
  private readonly reduceOn: boolean

  private seen: Uint8Array
  private events: TraceEvent[] = []
  private traceTruncated = false
  private history: HistorySample[] = []
  private firstConflict?: ConflictSnapshot
  private maxLevelSeen = 0
  private peakTrail = 0
  private ok = true // becomes false once a top-level conflict makes the formula UNSAT

  private stats: SolveStats = {
    decisions: 0,
    propagations: 0,
    conflicts: 0,
    learned: 0,
    removed: 0,
    restarts: 0,
    minimizedLits: 0,
    maxLevel: 0,
    peakTrail: 0,
    learntLiterals: 0,
    timeMs: 0,
  }

  constructor(cnf: CNF, opts: SolverOptions = {}) {
    this.numVars = Math.max(0, cnf.numVars)
    this.varDecay = opts.varDecay ?? 0.95
    this.clauseDecay = opts.clauseDecay ?? 0.999
    this.restartBase = opts.restartBase ?? 100
    this.minimize = opts.minimize ?? true
    this.trace = opts.trace ?? false
    this.maxTrace = opts.maxTrace ?? 30000
    this.maxConflicts = opts.maxConflicts ?? 0
    this.maxTimeMs = opts.maxTimeMs ?? 0
    this.proofOn = opts.proof ?? false
    this.maxProof = opts.maxProof ?? 500000
    this.randomFreq = opts.randomFreq ?? 0
    this.branchRandom = opts.branch === 'random'
    this.phaseSaving = opts.phaseSaving ?? true
    this.restartsOn = opts.restarts ?? true
    this.reduceOn = opts.reduceDb ?? true
    this.rng = mulberry32(opts.randomSeed ?? 0x9e3779b9)

    const n = this.numVars
    this.value = new Int8Array(n)
    this.level = new Int32Array(n).fill(-1)
    this.reason = new Int32Array(n).fill(-1)
    this.polarity = new Int8Array(n).fill(-1) // default: branch false first (MiniSat default)
    this.activity = new Float64Array(n)
    this.seen = new Uint8Array(n)
    this.watch = Array.from({ length: 2 * n }, () => [])
    this.order = new VarOrderHeap(n, this.activity)

    const vars: number[] = []
    for (let v = 0; v < n; v++) vars.push(v)
    this.order.rebuild(vars)

    for (const clause of cnf.clauses) {
      if (!this.addInitialClause(clause)) {
        this.ok = false // empty clause or root conflict -> immediately UNSAT
        break
      }
    }
  }

  // ---- literal value helpers ---------------------------------------------------
  private litValue(l: number): number {
    const vv = this.value[litVar(l)]
    if (vv === 0) return 0
    return l & 1 ? -vv : vv
  }

  // ---- trace helper ------------------------------------------------------------
  private emit(e: TraceEvent): void {
    if (!this.trace) return
    if (this.events.length >= this.maxTrace) {
      this.traceTruncated = true
      return
    }
    this.events.push(e)
  }

  // ---- DRAT proof helpers ------------------------------------------------------
  /** Record a derived (added) clause — a learnt clause or the final empty clause. */
  private proofAdd(lits: number[]): void {
    if (!this.proofOn) return
    if (this.proof.length >= this.maxProof) {
      this.proofTruncated = true
      return
    }
    this.proof.push({ a: 'a', lits })
  }

  /** Record a clause deletion (learnt-database reduction). */
  private proofDel(lits: number[]): void {
    if (!this.proofOn) return
    if (this.proof.length >= this.maxProof) {
      this.proofTruncated = true
      return
    }
    this.proof.push({ a: 'd', lits })
  }

  // ---- clause construction -----------------------------------------------------
  /** Add an original clause (DIMACS lits). Returns false if it makes the CNF UNSAT. */
  private addInitialClause(dimacs: number[]): boolean {
    // Normalize: dedupe, drop tautologies, drop already-true / false literals.
    const lits: number[] = []
    const present = new Set<number>()
    for (const d of dimacs) {
      if (d === 0) continue
      const l = dimacsToLit(d)
      if (present.has(neg(l))) return true // tautology x ∨ ¬x — trivially satisfied, skip
      if (present.has(l)) continue // duplicate literal
      present.add(l)
      lits.push(l)
    }
    if (lits.length === 0) return false // empty clause -> UNSAT
    if (lits.length === 1) {
      // Unit clause: enqueue as a level-0 fact.
      const v = this.litValue(lits[0])
      if (v === 1) return true
      if (v === -1) return false
      this.enqueue(lits[0], -1)
      return true
    }
    this.attachClause(lits, false, 0)
    this.numOriginal++
    return true
  }

  private attachClause(lits: number[], learnt: boolean, lbd: number): number {
    const idx = this.clauseLits.length
    this.clauseLits.push(lits)
    this.clauseLearnt.push(learnt)
    this.clauseActivity.push(0)
    this.clauseLbd.push(lbd)
    this.clauseDeleted.push(false)
    this.watch[neg(lits[0])].push(idx)
    this.watch[neg(lits[1])].push(idx)
    return idx
  }

  // ---- assignment --------------------------------------------------------------
  private enqueue(lit: number, reason: number): void {
    const v = litVar(lit)
    this.value[v] = lit & 1 ? -1 : 1
    this.level[v] = this.decisionLevel()
    this.reason[v] = reason
    this.trail.push(lit)
    if (this.trail.length > this.peakTrail) this.peakTrail = this.trail.length
  }

  private decisionLevel(): number {
    return this.trailLim.length
  }

  // ---- VSIDS -------------------------------------------------------------------
  private bumpVar(v: number): void {
    this.activity[v] += this.varInc
    if (this.activity[v] > 1e100) {
      // rescale to avoid overflow
      for (let i = 0; i < this.numVars; i++) this.activity[i] *= 1e-100
      this.varInc *= 1e-100
    }
    this.order.increase(v)
  }

  private decayVar(): void {
    this.varInc /= this.varDecay
  }

  private bumpClause(c: number): void {
    this.clauseActivity[c] += this.clauseInc
    if (this.clauseActivity[c] > 1e20) {
      for (let i = 0; i < this.clauseLits.length; i++)
        if (this.clauseLearnt[i]) this.clauseActivity[i] *= 1e-20
      this.clauseInc *= 1e-20
    }
  }

  private decayClause(): void {
    this.clauseInc /= this.clauseDecay
  }

  // ---- unit propagation (two-watched literals) --------------------------------
  /** Propagate until fixpoint. Returns conflicting clause index, or -1. */
  private propagate(): number {
    let conflict = -1
    while (this.qhead < this.trail.length) {
      const p = this.trail[this.qhead++] // p is now TRUE
      this.stats.propagations++
      const ws = this.watch[p] // clauses with watched literal ~p (now false)
      const falseLit = neg(p)
      let i = 0
      let j = 0
      scan: while (i < ws.length) {
        const cidx = ws[i]
        const clause = this.clauseLits[cidx]
        // Make sure the falsified literal is at position 1.
        if (clause[0] === falseLit) {
          clause[0] = clause[1]
          clause[1] = falseLit
        }
        const first = clause[0]
        if (this.litValue(first) === 1) {
          ws[j++] = cidx // clause already satisfied by the other watch — keep
          i++
          continue
        }
        // Look for a new, non-false literal to watch.
        for (let k = 2; k < clause.length; k++) {
          if (this.litValue(clause[k]) !== -1) {
            clause[1] = clause[k]
            clause[k] = falseLit
            this.watch[neg(clause[1])].push(cidx)
            i++
            continue scan // moved watch; drop from this list
          }
        }
        // No new watch: clause is unit or conflicting.
        ws[j++] = cidx
        i++
        if (this.litValue(first) === -1) {
          // conflict — keep the rest of the list intact and bail out
          while (i < ws.length) ws[j++] = ws[i++]
          ws.length = j
          this.qhead = this.trail.length
          conflict = cidx
          this.emit({ t: 'conflict', clause: cidx, level: this.decisionLevel() })
          return conflict
        } else {
          this.enqueue(first, cidx)
          this.emit({ t: 'propagate', lit: litToDimacs(first), level: this.decisionLevel(), reason: cidx })
        }
      }
      ws.length = j
    }
    return conflict
  }

  // ---- conflict analysis (first-UIP) ------------------------------------------
  private analyze(confl: number): { learnt: number[]; backLevel: number; lbd: number } {
    const learnt: number[] = [0] // reserve slot 0 for the asserting literal
    const dl = this.decisionLevel()
    let pathC = 0
    let p = -1
    let index = this.trail.length - 1
    const touched: number[] = []

    do {
      if (this.clauseLearnt[confl]) this.bumpClause(confl)
      const clause = this.clauseLits[confl]
      for (let j = p === -1 ? 0 : 1; j < clause.length; j++) {
        const q = clause[j]
        const v = litVar(q)
        if (!this.seen[v] && this.level[v] > 0) {
          this.bumpVar(v)
          this.seen[v] = 1
          touched.push(v)
          if (this.level[v] >= dl) pathC++
          else learnt.push(q)
        }
      }
      while (!this.seen[litVar(this.trail[index])]) index--
      p = this.trail[index]
      confl = this.reason[litVar(p)]
      this.seen[litVar(p)] = 0
      index--
      pathC--
    } while (pathC > 0)

    learnt[0] = neg(p) // asserting literal (negated UIP)

    // Recursive conflict-clause minimization (self-subsumption, MiniSat-style).
    // Precondition: `seen[v]` is set for exactly the vars in learnt[1..].
    const toClear: number[] = []
    for (let i = 1; i < learnt.length; i++) toClear.push(litVar(learnt[i]))
    let minimized = 0
    if (this.minimize && learnt.length > 1) {
      let abstractLevels = 0
      for (let i = 1; i < learnt.length; i++) abstractLevels |= 1 << (this.level[litVar(learnt[i])] & 31)
      const before = learnt.length
      const out: number[] = [learnt[0]]
      for (let i = 1; i < learnt.length; i++) {
        const v = litVar(learnt[i])
        if (this.reason[v] === -1 || !this.litRedundant(learnt[i], abstractLevels, toClear)) out.push(learnt[i])
      }
      learnt.length = 0
      for (const l of out) learnt.push(l)
      minimized = before - learnt.length
    }
    this.stats.minimizedLits += minimized

    // Clear every seen flag we touched (main analysis + minimization).
    for (const v of touched) this.seen[v] = 0
    for (const v of toClear) this.seen[v] = 0

    // Order learnt[1] to be the literal with the highest level (for correct watch /
    // backjump) and compute the backjump level + LBD.
    let backLevel = 0
    if (learnt.length > 1) {
      let maxI = 1
      for (let i = 2; i < learnt.length; i++) {
        if (this.level[litVar(learnt[i])] > this.level[litVar(learnt[maxI])]) maxI = i
      }
      const tmp = learnt[1]
      learnt[1] = learnt[maxI]
      learnt[maxI] = tmp
      backLevel = this.level[litVar(learnt[1])]
    }

    // LBD = number of distinct decision levels among learnt literals.
    const levels = new Set<number>()
    for (const l of learnt) levels.add(this.level[litVar(l)])
    const lbd = levels.size

    return { learnt, backLevel, lbd }
  }

  /**
   * Is literal `l` redundant — i.e. implied by the other learnt literals via its
   * implication ancestry? Faithful port of MiniSat's litRedundant with the
   * abstract-level pruning. `toClear` accumulates newly-seen vars for cleanup.
   */
  private litRedundant(l: number, abstractLevels: number, toClear: number[]): boolean {
    const stack: number[] = [l]
    const start = toClear.length
    while (stack.length) {
      const top = stack.pop()!
      const clause = this.clauseLits[this.reason[litVar(top)]]
      for (let i = 1; i < clause.length; i++) {
        const q = clause[i]
        const v = litVar(q)
        if (!this.seen[v] && this.level[v] > 0) {
          if (this.reason[v] !== -1 && (abstractLevels & (1 << (this.level[v] & 31))) !== 0) {
            this.seen[v] = 1
            stack.push(q)
            toClear.push(v)
          } else {
            // hit a decision or out-of-scope literal — not redundant; undo marks.
            for (let k = start; k < toClear.length; k++) this.seen[toClear[k]] = 0
            toClear.length = start
            return false
          }
        }
      }
    }
    return true
  }

  // ---- backtracking ------------------------------------------------------------
  private cancelUntil(level: number): void {
    if (this.decisionLevel() <= level) return
    for (let i = this.trail.length - 1; i >= this.trailLim[level]; i--) {
      const lit = this.trail[i]
      const v = litVar(lit)
      this.polarity[v] = this.value[v] // remember phase
      this.value[v] = 0
      this.reason[v] = -1
      this.level[v] = -1
      this.order.insert(v)
    }
    this.qhead = this.trailLim[level]
    this.trail.length = this.trailLim[level]
    this.trailLim.length = level
    this.emit({ t: 'backjump', level })
  }

  // ---- branching ---------------------------------------------------------------
  private pickBranch(): number {
    let v = -1
    // `branch: 'random'` forces a uniform variable choice on every decision;
    // `randomFreq` mixes in random decisions probabilistically (Biere/MiniSat style).
    const useRandom = this.branchRandom || (this.randomFreq > 0 && this.rng() < this.randomFreq)
    if (useRandom) {
      // A genuinely uniform pick over the unassigned order set, removing the
      // chosen variable (mirrors `removeMax`) so the heap stays consistent.
      while (this.order.size > 0) {
        const cand = this.order.removeRandom(this.rng())
        if (this.value[cand] === 0) {
          v = cand
          break
        }
      }
    } else {
      while (this.order.size > 0) {
        const cand = this.order.removeMax()
        if (this.value[cand] === 0) {
          v = cand
          break
        }
      }
    }
    if (v === -1) return -1
    // phase saving: re-use the variable's last value; without it, branch false
    // first (the MiniSat default polarity).
    const sign = this.phaseSaving && this.polarity[v] === 1 ? 0 : 1
    return (v << 1) | sign
  }

  // ---- learnt-clause database reduction ---------------------------------------
  private reduceDB(): void {
    // Collect learnt, non-locked clauses with LBD > 2 and remove the worst half
    // by activity. Locked clauses (current reasons) and LBD<=2 are kept.
    const learntIdx: number[] = []
    for (let c = 0; c < this.clauseLits.length; c++) {
      if (this.clauseDeleted[c] || !this.clauseLearnt[c]) continue
      learntIdx.push(c)
    }
    const locked = new Uint8Array(this.clauseLits.length)
    for (let v = 0; v < this.numVars; v++) {
      const r = this.reason[v]
      if (r >= 0) locked[r] = 1
    }
    learntIdx.sort((a, b) => this.clauseActivity[a] - this.clauseActivity[b])
    const limit = learntIdx.length >> 1
    let removed = 0
    for (let i = 0; i < learntIdx.length; i++) {
      const c = learntIdx[i]
      if (locked[c]) continue
      if (this.clauseLbd[c] <= 2) continue
      if (i < limit) {
        this.proofDel(this.clauseLits[c].map(litToDimacs))
        this.clauseDeleted[c] = true
        removed++
      }
    }
    if (removed > 0) {
      this.rebuildWatches()
      this.stats.removed += removed
      this.emit({ t: 'reduce', removed })
    }
  }

  /** Rebuild all watch lists from scratch over non-deleted clauses (called at level 0). */
  private rebuildWatches(): void {
    for (let l = 0; l < this.watch.length; l++) this.watch[l].length = 0
    for (let c = 0; c < this.clauseLits.length; c++) {
      if (this.clauseDeleted[c]) continue
      const clause = this.clauseLits[c]
      // Choose two best literals to watch (unassigned > true > false) and place
      // them at positions 0 and 1 — guarantees no clause watches two false lits.
      let b0 = 0
      let b1 = 1
      if (this.rank(clause[b1]) > this.rank(clause[b0])) {
        b0 = 1
        b1 = 0
      }
      for (let k = 2; k < clause.length; k++) {
        const rk = this.rank(clause[k])
        if (rk > this.rank(clause[b0])) {
          b1 = b0
          b0 = k
        } else if (rk > this.rank(clause[b1])) {
          b1 = k
        }
      }
      if (b0 !== 0) {
        const t = clause[0]
        clause[0] = clause[b0]
        clause[b0] = t
        if (b1 === 0) b1 = b0
      }
      if (b1 !== 1) {
        const t = clause[1]
        clause[1] = clause[b1]
        clause[b1] = t
      }
      this.watch[neg(clause[0])].push(c)
      this.watch[neg(clause[1])].push(c)
    }
  }

  private rank(l: number): number {
    const vv = this.litValue(l)
    if (vv === 0) return 2 // unassigned
    if (vv === 1) return 1 // true
    return 0 // false
  }

  // ---- conflict-snapshot capture (for the implication-graph view) -------------
  private captureFirstConflict(confl: number): void {
    if (this.firstConflict) return
    const nodes: ImplNode[] = []
    for (const lit of this.trail) {
      const v = litVar(lit)
      const r = this.reason[v]
      nodes.push({
        lit: litToDimacs(lit),
        level: this.level[v],
        reason: r,
        reasonLits: r >= 0 ? this.clauseLits[r].map(litToDimacs) : [],
      })
    }
    this.firstConflict = {
      conflictClause: this.clauseLits[confl].map(litToDimacs),
      nodes,
      level: this.decisionLevel(),
    }
  }

  // ---- main solve loop ---------------------------------------------------------
  solve(): SolveResult {
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const finish = (status: SolveResult['status'], message?: string): SolveResult => {
      this.stats.maxLevel = this.maxLevelSeen
      this.stats.peakTrail = this.peakTrail
      this.stats.timeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start
      // Cap off a refutation: the empty clause follows by RUP from the database
      // at the moment we conclude UNSAT.
      if (status === 'unsat') this.proofAdd([])
      const res: SolveResult = { status, stats: this.stats, history: this.history, message }
      if (this.trace) {
        res.trace = this.events
        res.traceTruncated = this.traceTruncated
      }
      if (this.proofOn) {
        res.proof = this.proof
        res.proofTruncated = this.proofTruncated
      }
      if (this.firstConflict) res.firstConflict = this.firstConflict
      if (status === 'sat') res.model = this.extractModel()
      return res
    }

    if (!this.ok) return finish('unsat', 'A clause was empty or a root-level conflict was found.')

    // Propagate any initial unit clauses.
    if (this.propagate() !== -1) {
      this.ok = false
      return finish('unsat', 'Initial unit propagation produced a conflict.')
    }

    let restartNo = 0
    let conflictBudget = this.restartBase * luby(restartNo + 1)
    let conflictsSinceRestart = 0
    let reduceBudget = 2000 + (this.numOriginal >> 1)
    let conflictsSinceReduce = 0
    let checkCounter = 0

    for (;;) {
      const confl = this.propagate()
      if (confl !== -1) {
        // CONFLICT
        this.stats.conflicts++
        conflictsSinceRestart++
        conflictsSinceReduce++
        if (this.decisionLevel() > this.maxLevelSeen) this.maxLevelSeen = this.decisionLevel()
        this.captureFirstConflict(confl)

        if (this.decisionLevel() === 0) {
          this.ok = false
          return finish('unsat')
        }

        const { learnt, backLevel, lbd } = this.analyze(confl)
        this.stats.learned++
        this.stats.learntLiterals += learnt.length
        const learntDimacs = learnt.map(litToDimacs)
        this.emit({ t: 'learn', lits: learntDimacs, lbd, backLevel })
        this.proofAdd(learntDimacs) // every CDCL learnt clause is a RUP inference

        this.cancelUntil(backLevel)
        if (learnt.length === 1) {
          this.enqueue(learnt[0], -1)
          this.emit({ t: 'unit', lit: litToDimacs(learnt[0]) })
        } else {
          const cidx = this.attachClause(learnt, true, lbd)
          this.bumpClause(cidx)
          this.enqueue(learnt[0], cidx) // learnt[0] is now unit at backLevel
        }
        this.decayVar()
        this.decayClause()

        if (this.history.length < 4000 && (this.stats.conflicts & 7) === 0) {
          this.history.push({
            conflicts: this.stats.conflicts,
            level: this.decisionLevel(),
            learnt: this.stats.learned - this.stats.removed,
            trail: this.trail.length,
          })
        }

        // periodic abort checks
        if ((++checkCounter & 1023) === 0) {
          if (this.maxConflicts > 0 && this.stats.conflicts >= this.maxConflicts)
            return finish('unknown', `Conflict budget (${this.maxConflicts}) exhausted.`)
          if (this.maxTimeMs > 0) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
            if (now - start >= this.maxTimeMs) return finish('unknown', `Time budget (${this.maxTimeMs}ms) exhausted.`)
          }
        }

        // restart?
        if (this.restartsOn && conflictsSinceRestart >= conflictBudget) {
          this.cancelUntil(0)
          this.stats.restarts++
          restartNo++
          conflictBudget = this.restartBase * luby(restartNo + 1)
          conflictsSinceRestart = 0
          this.emit({ t: 'restart', conflicts: this.stats.conflicts })
        }
        // reduce learnt DB?
        if (this.reduceOn && conflictsSinceReduce >= reduceBudget) {
          this.cancelUntil(0)
          if (this.propagate() !== -1) {
            this.ok = false
            return finish('unsat')
          }
          this.reduceDB()
          conflictsSinceReduce = 0
          reduceBudget += 300
        }
      } else {
        // NO CONFLICT — decide.
        const lit = this.pickBranch()
        if (lit === -1) return finish('sat') // all variables assigned -> model found
        this.trailLim.push(this.trail.length)
        this.stats.decisions++
        this.enqueue(lit, -1)
        if (this.decisionLevel() > this.maxLevelSeen) this.maxLevelSeen = this.decisionLevel()
        this.emit({ t: 'decision', lit: litToDimacs(lit), level: this.decisionLevel() })
      }
    }
  }

  // ---- incremental solving under assumptions ---------------------------------
  // A faithful MiniSat-style assumption protocol. Assumptions (DIMACS literals) are forced
  // true by placing them as the lowest decision levels; if one is falsified by propagation
  // we run `analyzeFinal` to recover the *unsat core* — the subset of assumptions that
  // together with the (hard) clauses cannot all hold. Because no clauses are added between
  // calls, the same solver instance can be re-solved under a growing assumption set, reusing
  // every learnt clause: genuine incremental SAT. `solve()` above is left untouched.

  /**
   * Solve the current clause database under the given assumption literals (DIMACS).
   * Returns 'sat' with a model, 'unsat' with the assumption `core` (DIMACS literals — a
   * subset of `assumptions`), or 'unknown' if a budget is exhausted. Safe to call repeatedly.
   */
  solveAssuming(assumptions: number[]): { status: 'sat' | 'unsat' | 'unknown'; model?: boolean[]; core?: number[] } {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
    this.cancelUntil(0)
    if (!this.ok) return { status: 'unsat', core: [] }
    if (this.propagate() !== -1) {
      this.ok = false
      return { status: 'unsat', core: [] }
    }
    const assume = assumptions.map(dimacsToLit)

    let restartNo = 0
    let conflictBudget = this.restartBase * luby(restartNo + 1)
    let conflictsSinceRestart = 0
    let reduceBudget = 2000 + (this.numOriginal >> 1)
    let conflictsSinceReduce = 0
    let checkCounter = 0

    for (;;) {
      const confl = this.propagate()
      if (confl !== -1) {
        this.stats.conflicts++
        conflictsSinceRestart++
        conflictsSinceReduce++
        if (this.decisionLevel() > this.maxLevelSeen) this.maxLevelSeen = this.decisionLevel()
        if (this.decisionLevel() === 0) {
          this.ok = false
          return { status: 'unsat', core: [] } // UNSAT regardless of assumptions
        }
        const { learnt, backLevel, lbd } = this.analyze(confl)
        this.stats.learned++
        this.stats.learntLiterals += learnt.length
        this.cancelUntil(backLevel)
        if (learnt.length === 1) {
          this.enqueue(learnt[0], -1)
        } else {
          const cidx = this.attachClause(learnt, true, lbd)
          this.bumpClause(cidx)
          this.enqueue(learnt[0], cidx)
        }
        this.decayVar()
        this.decayClause()

        if ((++checkCounter & 1023) === 0) {
          if (this.maxConflicts > 0 && this.stats.conflicts >= this.maxConflicts) return { status: 'unknown' }
          if (this.maxTimeMs > 0) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
            if (now - start >= this.maxTimeMs) return { status: 'unknown' }
          }
        }
        // Restart only above the assumption levels, so assumptions are simply re-placed.
        if (this.restartsOn && conflictsSinceRestart >= conflictBudget) {
          this.cancelUntil(0)
          this.stats.restarts++
          restartNo++
          conflictBudget = this.restartBase * luby(restartNo + 1)
          conflictsSinceRestart = 0
        }
        if (this.reduceOn && conflictsSinceReduce >= reduceBudget) {
          this.cancelUntil(0)
          if (this.propagate() !== -1) {
            this.ok = false
            return { status: 'unsat', core: [] }
          }
          this.reduceDB()
          conflictsSinceReduce = 0
          reduceBudget += 300
        }
      } else {
        // Place the next assumption (assumptions occupy the lowest decision levels).
        let next = -1
        while (this.decisionLevel() < assume.length) {
          const p = assume[this.decisionLevel()]
          const v = this.litValue(p)
          if (v === 1) {
            this.trailLim.push(this.trail.length) // already implied — dummy level
          } else if (v === -1) {
            return { status: 'unsat', core: this.analyzeFinal(p) } // assumption conflict
          } else {
            next = p
            break
          }
        }
        if (next === -1) {
          next = this.pickBranch()
          if (next === -1) return { status: 'sat', model: this.extractModel() }
        }
        this.trailLim.push(this.trail.length)
        this.stats.decisions++
        this.enqueue(next, -1)
        if (this.decisionLevel() > this.maxLevelSeen) this.maxLevelSeen = this.decisionLevel()
      }
    }
  }

  /**
   * Backward walk over the reason graph from a falsified assumption `p` (internal literal),
   * collecting the assumption literals responsible. Returns the core as DIMACS literals (a
   * subset of the assumptions). Faithful port of MiniSat's analyzeFinal.
   */
  private analyzeFinal(p: number): number[] {
    const core: number[] = [litToDimacs(p)]
    // Even at the root, ¬p was *derived* (hard ⊨ ¬p), so {p} is a valid singleton core.
    if (this.decisionLevel() === 0) return core
    const touched: number[] = []
    const mark = (v: number) => {
      if (!this.seen[v]) {
        this.seen[v] = 1
        touched.push(v)
      }
    }
    mark(litVar(p))
    for (let i = this.trail.length - 1; i >= (this.trailLim[0] ?? 0); i--) {
      const x = litVar(this.trail[i])
      if (!this.seen[x]) continue
      const r = this.reason[x]
      if (r === -1) {
        // A decision literal on the trail is one of the placed assumptions itself.
        if (this.level[x] > 0) core.push(litToDimacs(this.trail[i]))
      } else {
        const clause = this.clauseLits[r]
        for (let j = 1; j < clause.length; j++) {
          if (this.level[litVar(clause[j])] > 0) mark(litVar(clause[j]))
        }
      }
    }
    for (const v of touched) this.seen[v] = 0
    return core
  }

  private extractModel(): boolean[] {
    const model: boolean[] = new Array(this.numVars + 1).fill(false)
    for (let v = 0; v < this.numVars; v++) {
      // Unassigned vars (don't-cares) default to false.
      model[v + 1] = this.value[v] === 1
    }
    return model
  }
}

/** Convenience: solve a CNF in one call. */
export function solve(cnf: CNF, opts: SolverOptions = {}): SolveResult {
  return new CdclSolver(cnf, opts).solve()
}

/** Convenience: solve a CNF once under a set of assumption literals (DIMACS). */
export function solveAssuming(cnf: CNF, assumptions: number[], opts: SolverOptions = {}) {
  return new CdclSolver(cnf, opts).solveAssuming(assumptions)
}
