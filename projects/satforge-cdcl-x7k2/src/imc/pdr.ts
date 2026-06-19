// IC3 / PDR — Property-Directed Reachability (Bradley 2011; Eén–Mishchenko–
// Brayton 2011). A third, *completely independent* unbounded-safety engine for
// the same finite-state transition systems the interpolation checker and
// k-induction already decide. Where interpolation derives an invariant from a
// global resolution proof of a bounded unrolling, IC3/PDR never unrolls the
// transition relation at all: it incrementally strengthens a *sequence of
// over-approximating frames* F₀=Init ⊆ F₁ ⊆ … ⊆ Fₖ, each a conjunction of
// CNF clauses, using only single-step (one-`Trans`) SAT queries. A bad state is
// blocked by learning a clause that excludes it; the clause is *inductively
// generalized* (Bradley's MIC — drop literals while the clause stays inductive
// relative to the previous frame) so one query prunes an exponential set of
// states at once; clauses are then *pushed* forward, and when two adjacent
// frames coincide their conjunction is an inductive invariant — a checkable
// proof of safety.
//
// The whole engine rests on the one-step queries below; it shares the project's
// `Formula` layer, the Tseitin `CnfBuilder`, and the proof-logging `solveCnf`
// SAT backend. Its verdicts, invariants and counterexamples are cross-checked
// in `selfcheck.ts` against the explicit-state BFS oracle, k-induction, and the
// interpolation checker — they must all agree, and every invariant it reports
// must pass the same `checkInvariant`/`checkCounterexample` gate.
//
// Variable layout (shared with `modelcheck.ts`): a state variable j ∈ {1..n}
// is the *current* copy; n+j is its *next* (primed) copy. `init`/`bad` are over
// 1..n; `trans` is over 1..2n.

import type { Formula } from './formula'
import { CnfBuilder, mapVars, fvar, fnot, fand, for_, TRUE } from './formula'
import { solveCnf } from './proofSolver'
import type { TransitionSystem } from './modelcheck'

export interface PdrStep {
  /** Frame depth k at the time of this event. */
  k: number
  kind: 'init' | 'block' | 'generalize' | 'propagate' | 'fixpoint' | 'cex' | 'extend'
  message: string
}

export interface PdrStats {
  /** Number of frames F₁..F_k at termination. */
  frames: number
  /** Total clauses stored across all frames (with multiplicity per frame). */
  clauses: number
  /** SAT queries issued to the backend. */
  satQueries: number
  /** Proof obligations popped from the priority queue. */
  obligations: number
  /** Literals removed by inductive generalization (MIC). */
  litsDropped: number
  /** Clauses pushed forward by the propagation phase. */
  pushed: number
}

export interface PdrResult {
  result: 'SAFE' | 'UNSAFE' | 'UNKNOWN'
  /** Inductive invariant proving safety (present iff SAFE). */
  invariant?: Formula
  /** Counterexample as states (each a boolean[] over 1..stateBits); present iff UNSAFE. */
  counterexample?: boolean[][]
  /** The frame at which the proof/refutation completed. */
  depth: number
  /** Per-frame clause sets at termination (each clause a literal list over 1..n). */
  frameClauses: number[][][]
  stats: PdrStats
  trace: PdrStep[]
}

export interface PdrOptions {
  /** Hard cap on frame depth (defensive; finite systems terminate well within). */
  maxFrames?: number
}

// A cube/clause is a sorted literal list; we key them for set membership.
const sortLits = (xs: number[]): number[] => [...xs].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)
const litsKey = (xs: number[]): string => sortLits(xs).join(',')

/** Map a current-state literal (±v, v∈1..n) to its primed (next) copy. */
const prime = (l: number, n: number): number => (l > 0 ? l + n : l - n)

/**
 * One PDR engine instance over a fixed transition system. All reasoning is via
 * single-step SAT queries built freshly per call (the CNFs are tiny). Frames are
 * stored as clause sets; a clause in frame i is the negation of a blocked cube
 * and — by Bradley's monotone-frame invariant — is added to every frame ≤ i.
 */
class Pdr {
  private n: number
  private init: Formula
  private trans: Formula
  private bad: Formula
  // frames[i] for i≥1: the clauses of Fᵢ. frames[0] is unused (F₀ = Init).
  private frames: { clauses: number[][]; keys: Set<string> }[] = []
  private trace: PdrStep[] = []
  private stats: PdrStats = { frames: 0, clauses: 0, satQueries: 0, obligations: 0, litsDropped: 0, pushed: 0 }

  constructor(ts: TransitionSystem) {
    this.n = ts.stateBits
    this.init = ts.init
    this.trans = ts.trans
    this.bad = ts.bad
    // F₀ placeholder (never read as clauses), F₁ starts empty (= ⊤).
    this.frames.push({ clauses: [], keys: new Set() })
    this.frames.push({ clauses: [], keys: new Set() })
  }

  private get depth(): number {
    return this.frames.length - 1
  }

  // ---- SAT query primitives ------------------------------------------------

  /**
   * Solve a CNF assembled by `build` over a budget of `reserved` low ids
   * (1..n current, n+1..2n next); Tseitin auxiliaries are allocated above.
   * Returns the model (indexed by var id) or null if unsatisfiable.
   */
  private query(build: (b: CnfBuilder) => void): boolean[] | null {
    const b = new CnfBuilder(2 * this.n)
    build(b)
    this.stats.satQueries++
    const r = solveCnf(b.numVars, b.clauses)
    return r.status === 'sat' ? r.model! : null
  }

  /** Assert the clauses of frame i (i≥1) over current vars; F₀ asserts Init. */
  private assertFrame(b: CnfBuilder, i: number): void {
    if (i === 0) {
      b.assert(this.init)
      return
    }
    for (const c of this.frames[i].clauses) b.add(...c)
  }

  /** Extract a full current-state cube from a model (every state bit pinned). */
  private stateCube(model: boolean[]): number[] {
    const cube: number[] = []
    for (let v = 1; v <= this.n; v++) cube.push(model[v] ? v : -v)
    return cube
  }

  /** Does cube `s` intersect the initial states? (SAT(Init ∧ s)) */
  private intersectsInit(s: number[]): boolean {
    return (
      this.query((b) => {
        b.assert(this.init)
        for (const l of s) b.add(l)
      }) !== null
    )
  }

  /** Is there a bad initial state? (SAT(Init ∧ Bad)) — the k=0 refutation. */
  private initAndBadSat(): boolean {
    return (
      this.query((b) => {
        b.assert(this.init)
        b.assert(this.bad)
      }) !== null
    )
  }

  /** A bad state still present in frame k: a model of F_k ∧ Bad, or null. */
  private getBadCube(k: number): number[] | null {
    const m = this.query((b) => {
      this.assertFrame(b, k)
      b.assert(this.bad)
    })
    return m ? this.stateCube(m) : null
  }

  /**
   * Relative-induction query: is cube `s` reachable in one `Trans` step from a
   * state of F_level that is *not* already in `s`?  SAT(F_level ∧ ¬s ∧ T ∧ s′).
   * Returns the predecessor's current-state cube, or null if `s` is inductive
   * relative to F_level (so ¬s can be safely added to F_{level+1}).
   */
  private predecessor(level: number, s: number[]): number[] | null {
    const m = this.query((b) => {
      this.assertFrame(b, level)
      b.add(...s.map((l) => -l)) // ¬s on the current state
      b.assert(this.trans)
      for (const l of s) b.add(prime(l, this.n)) // s′ on the next state
    })
    return m ? this.stateCube(m) : null
  }

  /** Is ¬s inductive relative to F_level *and* excluded by Init? (for generalization) */
  private inductiveRelative(level: number, s: number[]): boolean {
    if (this.intersectsInit(s)) return false // ¬s would drop an initial state
    return this.predecessor(level, s) === null
  }

  // ---- frame bookkeeping ---------------------------------------------------

  /** Add clause ¬cube to frames 1..upto (Bradley's monotone frames). */
  private addBlockingClause(cube: number[], upto: number): void {
    const clause = sortLits(cube.map((l) => -l))
    const key = litsKey(clause)
    for (let i = 1; i <= upto; i++) {
      if (!this.frames[i].keys.has(key)) {
        this.frames[i].keys.add(key)
        this.frames[i].clauses.push(clause)
      }
    }
  }

  /**
   * Inductive generalization (MIC): shrink cube `s` by dropping literals while
   * ¬s stays inductive relative to F_level and excludes Init. A smaller cube is
   * a *stronger* learnt clause that blocks exponentially more states.
   */
  private generalize(level: number, s: number[]): number[] {
    let lits = sortLits(s)
    for (const l of [...lits]) {
      if (lits.length <= 1) break
      const cand = lits.filter((x) => x !== l)
      if (this.inductiveRelative(level, cand)) {
        this.stats.litsDropped += lits.length - cand.length
        lits = cand
      }
    }
    return lits
  }

  // ---- recursive blocking --------------------------------------------------

  /**
   * Block cube `s0` at frame `k`. Maintains a min-frame-first priority queue of
   * proof obligations (cube, frame). Returns true if the cube is blocked, or
   * false if a chain back to Init is found (the system is UNSAFE).
   */
  private recBlock(s0: number[], k: number): boolean {
    // Obligations as a simple array kept sorted by frame ascending (small).
    const queue: { cube: number[]; frame: number }[] = [{ cube: s0, frame: k }]
    const pop = (): { cube: number[]; frame: number } => {
      let bi = 0
      for (let i = 1; i < queue.length; i++) if (queue[i].frame < queue[bi].frame) bi = i
      return queue.splice(bi, 1)[0]
    }

    while (queue.length > 0) {
      const { cube: s, frame: i } = pop()
      this.stats.obligations++

      // Already excluded from Fᵢ by an earlier learnt clause? Nothing to do.
      if (
        this.query((b) => {
          this.assertFrame(b, i)
          for (const l of s) b.add(l)
        }) === null
      )
        continue

      if (i === 0) return false // s sits in F₀ = Init: a genuine counterexample.

      const pred = this.predecessor(i - 1, s)
      if (pred) {
        if (this.intersectsInit(pred)) {
          this.trace.push({ k: this.depth, kind: 'cex', message: `Predecessor of a bad cube is an initial state — counterexample found.` })
          return false
        }
        queue.push({ cube: pred, frame: i - 1 }) // block the predecessor first…
        queue.push({ cube: s, frame: i }) // …then retry s.
      } else {
        const g = this.generalize(i - 1, s)
        this.addBlockingClause(g, i)
        this.trace.push({
          k: this.depth,
          kind: 'generalize',
          message: `Blocked a cube at F${i}; inductive clause has ${g.length} literal${g.length === 1 ? '' : 's'} (from ${s.length}).`,
        })
        if (i < k) queue.push({ cube: s, frame: i + 1 }) // push the obligation forward.
      }
    }
    return true
  }

  // ---- propagation / fixpoint ----------------------------------------------

  /**
   * Push every clause as far forward as it stays inductive. If, afterward, two
   * adjacent frames are identical, their conjunction is an inductive invariant
   * and the system is SAFE. Returns the invariant frame index, or -1.
   */
  private propagate(): number {
    const top = this.depth
    for (let i = 1; i < top; i++) {
      // Snapshot: pushing into i+1 must not affect this loop over Fᵢ.
      for (const c of [...this.frames[i].clauses]) {
        if (this.frames[i + 1].keys.has(litsKey(c))) continue
        // c holds at i+1 iff F_i ∧ T ⟹ c′, i.e. SAT(F_i ∧ T ∧ ¬c′) is UNSAT.
        const cti = this.query((b) => {
          this.assertFrame(b, i)
          b.assert(this.trans)
          for (const l of c) b.add(-prime(l, this.n)) // ¬c′ as unit literals
        })
        if (cti === null) {
          this.frames[i + 1].keys.add(litsKey(c))
          this.frames[i + 1].clauses.push(c)
          this.stats.pushed++
        }
      }
      if (this.frames[i].keys.size === this.frames[i + 1].keys.size) {
        // F_i ≡ F_{i+1}: F_i is closed under Trans and excludes Bad → invariant.
        return i + 1
      }
    }
    return -1
  }

  // ---- driver --------------------------------------------------------------

  private finish(result: 'SAFE' | 'UNSAFE' | 'UNKNOWN', depth: number, invariant?: Formula, counterexample?: boolean[][]): PdrResult {
    this.stats.frames = this.depth
    this.stats.clauses = this.frames.reduce((acc, f) => acc + f.clauses.length, 0)
    return {
      result,
      invariant,
      counterexample,
      depth,
      frameClauses: this.frames.map((f) => f.clauses.map((c) => [...c])),
      stats: this.stats,
      trace: this.trace,
    }
  }

  /** The current invariant candidate: ⋀ of Fᵢ's clauses as a Formula. */
  private frameFormula(i: number): Formula {
    const clauses = this.frames[i].clauses
    if (clauses.length === 0) return TRUE
    const asFormula = (c: number[]): Formula => for_(...c.map((l) => (l > 0 ? fvar(l) : fnot(fvar(-l)))))
    return fand(...clauses.map(asFormula))
  }

  /**
   * Reconstruct a concrete counterexample once UNSAFE is established. IC3 proves
   * unsafety by reaching F₀; the shortest concrete witness is then materialised
   * by a clean bounded unrolling (Init ∧ Tᴸ ∧ Bad), which `checkCounterexample`
   * validates. This keeps the witness honest and independent of the frame data.
   */
  private buildCounterexample(maxLen: number): boolean[][] {
    const n = this.n
    const atStep = (f: Formula, step: number): Formula => mapVars(f, (v) => step * n + v)
    const transAt = (step: number): Formula => mapVars(this.trans, (v) => (v <= n ? step * n + v : (step + 1) * n + (v - n)))
    for (let L = 0; L <= maxLen; L++) {
      const b = new CnfBuilder((L + 1) * n)
      b.assert(atStep(this.init, 0))
      for (let s = 0; s < L; s++) b.assert(transAt(s))
      b.assert(atStep(this.bad, L))
      this.stats.satQueries++
      const r = solveCnf(b.numVars, b.clauses)
      if (r.status === 'sat') {
        const states: boolean[][] = []
        for (let s = 0; s <= L; s++) {
          const st: boolean[] = new Array(n + 1).fill(false)
          for (let j = 1; j <= n; j++) st[j] = r.model![s * n + j] ?? false
          states.push(st)
        }
        return states
      }
    }
    return [] // unreachable for a genuinely unsafe finite system
  }

  run(opts: PdrOptions = {}): PdrResult {
    const n = this.n
    const maxFrames = opts.maxFrames ?? (1 << n) + 4

    // k = 0: a bad initial state is an immediate counterexample.
    if (this.initAndBadSat()) {
      this.trace.push({ k: 0, kind: 'cex', message: 'Init ∧ Bad is satisfiable — the bad state is initial.' })
      return this.finish('UNSAFE', 0, undefined, this.buildCounterexample(0))
    }
    this.trace.push({ k: 0, kind: 'init', message: 'Init excludes Bad; frame F₁ initialised to ⊤.' })

    for (let iter = 0; iter < maxFrames; iter++) {
      const k = this.depth
      // Blocking phase: drive all bad states out of the top frame F_k.
      for (;;) {
        const bad = this.getBadCube(k)
        if (!bad) break
        if (!this.recBlock(bad, k)) {
          // UNSAFE: materialise the shortest concrete counterexample.
          const cex = this.buildCounterexample((1 << n) + 1)
          return this.finish('UNSAFE', k, undefined, cex)
        }
      }
      this.trace.push({ k, kind: 'block', message: `F${k} now excludes every bad state; extending to F${k + 1}.` })

      // Extend with a fresh empty top frame, then push clauses forward.
      this.frames.push({ clauses: [], keys: new Set() })
      this.trace.push({ k: k + 1, kind: 'extend', message: `Opened frame F${k + 1}.` })
      const inv = this.propagate()
      if (inv !== -1) {
        this.trace.push({ k: this.depth, kind: 'fixpoint', message: `F${inv - 1} ≡ F${inv}: their conjunction is an inductive invariant. SAFE.` })
        return this.finish('SAFE', inv, this.frameFormula(inv))
      }
      this.trace.push({ k: this.depth, kind: 'propagate', message: `Propagated clauses forward; no two frames coincide yet.` })
    }
    return this.finish('UNKNOWN', this.depth)
  }
}

/**
 * Run IC3 / PDR on a finite-state transition system. Returns SAFE with an
 * inductive invariant, UNSAFE with a concrete shortest counterexample, or
 * UNKNOWN if the (defensive) frame budget is exhausted.
 */
export function pdr(ts: TransitionSystem, opts: PdrOptions = {}): PdrResult {
  return new Pdr(ts).run(opts)
}
