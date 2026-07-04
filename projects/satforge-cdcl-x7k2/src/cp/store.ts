// The constraint store + propagation engine.
//
// The store holds the current domain of every variable and a set of
// *propagators* (the runtime form of a constraint). Propagation is a fixpoint:
// whenever a variable's domain shrinks, every propagator watching that variable
// is re-scheduled; the loop runs until nothing changes (a fixpoint) or some
// domain becomes empty (a dead end). This is the classic AC-3-style engine,
// generalised from binary arcs to arbitrary propagators.
//
// Backtracking is O(1) per undo: domains are immutable arrays (see domain.ts),
// so a change is recorded on a trail as just the previous *reference*, and undo
// swaps it back — no copying of domain contents ever.

import type { Domain } from './domain.ts'

/** A propagator: the executable form of one constraint. */
export interface Propagator {
  /** The variables this propagator reads/narrows — used to build watch lists. */
  readonly scope: readonly number[]
  /** A short human label for the trace ("allDiff(row 0)", "3x+2y ≤ 7", …). */
  readonly label: string
  /**
   * Narrow the domains of variables in scope, calling `store.narrow`. Detecting
   * infeasibility is done by narrowing a domain to empty (the store notices).
   * Must be *idempotent* at a fixpoint (running it again changes nothing) and
   * *sound* (never remove a value that participates in a solution of this one
   * constraint given the current domains).
   */
  propagate(store: Store): void
}

interface TrailEntry {
  v: number
  prev: Domain
}

export class Store {
  doms: Domain[]
  readonly names: string[]
  readonly props: Propagator[] = []
  /** watchers[v] = indices into `props` of propagators whose scope includes v. */
  private watchers: number[][]
  private trail: TrailEntry[] = []
  private queue: number[] = []
  private inQueue: boolean[] = []
  failed = false
  propagations = 0
  /** Index of the propagator that emptied a domain on the last failure (or -1). */
  lastConflict = -1
  /** Optional hook fired after every domain change (drives the root-prop viz). */
  onNarrow: ((v: number, prop: number) => void) | null = null
  /** The propagator currently executing (for the onNarrow hook / trace). */
  private current = -1

  constructor(initial: Domain[], names: string[]) {
    this.doms = initial.slice()
    this.names = names
    this.watchers = initial.map(() => [])
  }

  get n(): number {
    return this.doms.length
  }

  /** Register a propagator; wires up its watch lists. Returns its index. */
  addPropagator(p: Propagator): number {
    const idx = this.props.length
    this.props.push(p)
    this.inQueue.push(false)
    for (const v of p.scope) {
      const w = this.watchers[v]
      if (w[w.length - 1] !== idx) w.push(idx)
    }
    return idx
  }

  /** Indices of propagators watching variable v (for the dom/wdeg heuristic). */
  watchersOf(v: number): readonly number[] {
    return this.watchers[v]
  }

  /** Current trail height — pass to `undoTo` to restore this exact state. */
  mark(): number {
    return this.trail.length
  }

  /** Undo every domain change made since `m`. */
  undoTo(m: number): void {
    const t = this.trail
    while (t.length > m) {
      const e = t.pop()!
      this.doms[e.v] = e.prev
    }
    this.failed = false
  }

  /**
   * Replace variable v's domain. Returns true if it actually changed. Records
   * the old reference on the trail, wakes the watching propagators, and flags
   * `failed` if the new domain is empty.
   */
  narrow(v: number, dom: Domain): boolean {
    const old = this.doms[v]
    // Every narrowing op in domain.ts returns the *same reference* when it
    // removes nothing, so reference identity is an exact "unchanged" test.
    if (dom === old) return false
    this.trail.push({ v, prev: old })
    this.doms[v] = dom
    this.propagations++
    if (this.onNarrow) this.onNarrow(v, this.current)
    if (dom.length === 0) this.failed = true
    // Wake watchers of v.
    const w = this.watchers[v]
    for (let i = 0; i < w.length; i++) {
      const q = w[i]
      if (!this.inQueue[q]) {
        this.inQueue[q] = true
        this.queue.push(q)
      }
    }
    return true
  }

  /** Declare the current state infeasible without narrowing a specific domain. */
  signalFail(): void {
    this.failed = true
  }

  /** Seed the queue with every propagator (used once at the root). */
  seedAll(): void {
    for (let i = 0; i < this.props.length; i++) {
      if (!this.inQueue[i]) {
        this.inQueue[i] = true
        this.queue.push(i)
      }
    }
  }

  /**
   * Run propagation to a fixpoint. Returns false if a domain went empty
   * (infeasible), true otherwise. Callers seed the queue first — either via
   * `seedAll()` at the root or implicitly via `narrow()` after a decision.
   */
  propagate(): boolean {
    const q = this.queue
    while (q.length > 0 && !this.failed) {
      const p = q.pop()!
      this.inQueue[p] = false
      this.current = p
      this.props[p].propagate(this)
      if (this.failed) {
        this.lastConflict = p
        break
      }
    }
    this.current = -1
    // If we bailed on failure, clear the queue so the next descent starts clean.
    if (this.failed) {
      for (const p of q) this.inQueue[p] = false
      q.length = 0
    }
    return !this.failed
  }

  /** True when every variable is fixed to a single value. */
  allFixed(): boolean {
    for (const d of this.doms) if (d.length !== 1) return false
    return true
  }

  /** Snapshot the current assignment (only valid when `allFixed`). */
  solution(): number[] {
    return this.doms.map((d) => d[0])
  }
}
