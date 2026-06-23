// Angluin's L* — active learning of the minimal DFA from membership + equivalence queries.
//
// The learner keeps an **observation table** (S, E, T):
//
//   • S  — a prefix-closed set of "access" strings, one per state it has discovered so far.
//   • E  — a set of "experiments" (suffixes); E always contains ε. Each experiment is a column.
//   • T  — the table itself: for every row r ∈ S ∪ S·Σ and column e ∈ E, the bit T[r·e] = member(r·e).
//
// A row's **signature** is its bit-vector over E. Two strings with the same signature are, *as far
// as every experiment tried so far can tell*, the same state. The learner grows the table until it
// is:
//
//   • CLOSED      — every boundary row s·a (s ∈ S, a ∈ Σ) has the signature of some row already in S
//                   (so the transition has somewhere to go); otherwise promote s·a into S.
//   • CONSISTENT  — rows with equal signatures stay equal after every symbol; otherwise some
//                   experiment a·e tells them apart, so add it to E.
//
// From a closed, consistent table it reads off a **hypothesis DFA** (states = distinct signatures)
// and asks the teacher an equivalence query. A counterexample is folded back into the table and the
// loop repeats. Angluin proved this converges to the unique minimal DFA in O(|Σ|·n² + n·log m)
// membership queries and ≤ n equivalence queries (n = states of the target, m = longest CE).
//
// Two ways to digest a counterexample w are offered:
//   • **Angluin's original** — add every prefix of w to S (simple; may need consistency repairs).
//   • **Rivest & Schapire (1993)** — a binary search over w finds one distinguishing suffix to add
//     to E. It needs only ⌈log₂ m⌉ membership queries per counterexample and keeps the table
//     consistent *by construction*, so consistency repairs vanish entirely.

import type { Dfa, Sym } from '../types'
import type { Teacher } from './teacher'

export type Strategy = 'angluin' | 'rivest-schapire'

/** A word rendered as a stable string key (OTHER = '' needs a real separator). */
const SEP = ''
const wkey = (w: Sym[]): string => w.join(SEP)

/** One discrete, animatable thing the learner does. */
export type LearnEvent =
  | { kind: 'init' }
  /** A boundary row was promoted into S to restore closedness. */
  | { kind: 'close'; promoted: Sym[]; signature: string }
  /** An experiment a·e was added to E to restore consistency. */
  | { kind: 'consistent'; added: Sym[]; s1: Sym[]; s2: Sym[]; symbol: Sym }
  /** A closed+consistent table produced a hypothesis; the teacher answered the equivalence query. */
  | { kind: 'conjecture'; hyp: Dfa; access: Sym[][]; counterexample: Sym[] | null }
  /** A counterexample was folded into the table. */
  | {
      kind: 'counterexample'
      word: Sym[]
      strategy: Strategy
      /** Angluin: the prefixes added to S. */
      addedRows?: Sym[][]
      /** Rivest–Schapire: the single suffix added to E and the breakpoint index it came from. */
      addedSuffix?: Sym[]
      breakpoint?: number
    }
  /** The hypothesis is exactly the target: learning is complete. */
  | { kind: 'done'; hyp: Dfa; access: Sym[][] }

/** A read-only snapshot of the observation table for rendering. */
export interface TableView {
  S: Sym[][]
  E: Sym[][]
  /** Boundary rows S·Σ that are not themselves in S, in a stable order. */
  boundary: Sym[][]
  /** Look up a cell value (already filled). */
  cell(row: Sym[], exp: Sym[]): boolean
  /** A row's signature over E. */
  signature(row: Sym[]): string
  /** Distinct signatures among S, in discovery order — these become hypothesis states. */
  classes: string[]
}

export interface Hypothesis {
  dfa: Dfa
  /** Per-state access string (the representative S-row that reaches it). */
  access: Sym[][]
}

/**
 * The L* learner as an explicit step machine, so a UI can drive it one atomic action at a time and
 * animate the table filling in. Call {@link step} repeatedly until it returns a `done` event.
 */
export class LStarLearner {
  readonly S: Sym[][] = [[]] // ε is always the first access string
  readonly E: Sym[][] = [[]] // ε is always the first experiment
  private readonly teacher: Teacher
  private readonly alphabet: Sym[]
  readonly strategy: Strategy

  private finished = false
  private finalHyp: Hypothesis | null = null
  /** A counterexample handed back by the teacher, awaiting digestion on the next step. */
  private pendingCE: Sym[] | null = null
  /** The hypothesis that produced `pendingCE` (Rivest–Schapire analyses against it). */
  private pendingHyp: Hypothesis | null = null
  private started = false

  constructor(teacher: Teacher, strategy: Strategy = 'rivest-schapire') {
    this.teacher = teacher
    this.alphabet = teacher.alphabet
    this.strategy = strategy
  }

  get done(): boolean {
    return this.finished
  }

  /** The final learned hypothesis once {@link done}. */
  get result(): Hypothesis | null {
    return this.finalHyp
  }

  // -- table primitives ------------------------------------------------------

  private cell(row: Sym[], exp: Sym[]): boolean {
    return this.teacher.member(exp.length ? [...row, ...exp] : row)
  }

  /** A row's signature: its bit-vector over the experiments E, as a compact string. */
  signature(row: Sym[]): string {
    let s = ''
    for (const e of this.E) s += this.cell(row, e) ? '1' : '0'
    return s
  }

  /** Boundary rows S·Σ that are not already in S, deduplicated, in a stable order. */
  private boundaryRows(): Sym[][] {
    const inS = new Set(this.S.map(wkey))
    const seen = new Set<string>()
    const out: Sym[][] = []
    for (const s of this.S) {
      for (const a of this.alphabet) {
        const r = [...s, a]
        const k = wkey(r)
        if (inS.has(k) || seen.has(k)) continue
        seen.add(k)
        out.push(r)
      }
    }
    return out
  }

  /** A read-only view for the renderer. */
  view(): TableView {
    const classes: string[] = []
    const seen = new Set<string>()
    for (const s of this.S) {
      const g = this.signature(s)
      if (!seen.has(g)) {
        seen.add(g)
        classes.push(g)
      }
    }
    return {
      S: this.S.map((s) => [...s]),
      E: this.E.map((e) => [...e]),
      boundary: this.boundaryRows(),
      cell: (row, exp) => this.cell(row, exp),
      signature: (row) => this.signature(row),
      classes,
    }
  }

  // -- defects ---------------------------------------------------------------

  /** A boundary row whose signature is not any S-row's signature breaks closedness. */
  private closednessDefect(): Sym[] | null {
    const sSigs = new Set(this.S.map((s) => this.signature(s)))
    for (const r of this.boundaryRows()) {
      if (!sSigs.has(this.signature(r))) return r
    }
    return null
  }

  /**
   * Two S-rows with equal signatures but a symbol after which they diverge break consistency. The
   * repair is the experiment a·e that exposes the divergence. (Rivest–Schapire never needs this.)
   */
  private consistencyDefect(): { added: Sym[]; s1: Sym[]; s2: Sym[]; symbol: Sym } | null {
    for (let i = 0; i < this.S.length; i++) {
      for (let j = i + 1; j < this.S.length; j++) {
        const s1 = this.S[i]
        const s2 = this.S[j]
        if (this.signature(s1) !== this.signature(s2)) continue
        for (const a of this.alphabet) {
          const r1 = [...s1, a]
          const r2 = [...s2, a]
          if (this.signature(r1) === this.signature(r2)) continue
          // Find the experiment e where r1·e and r2·e differ; a·e is the new experiment.
          for (const e of this.E) {
            if (this.cell(r1, e) !== this.cell(r2, e)) {
              return { added: [a, ...e], s1, s2, symbol: a }
            }
          }
        }
      }
    }
    return null
  }

  // -- hypothesis ------------------------------------------------------------

  /** Read a hypothesis DFA off a closed, consistent table. */
  buildHypothesis(): Hypothesis {
    const reps = new Map<string, Sym[]>()
    const order: string[] = []
    for (const s of this.S) {
      const g = this.signature(s)
      if (!reps.has(g)) {
        reps.set(g, s)
        order.push(g)
      }
    }
    const stateOf = new Map<string, number>()
    order.forEach((g, i) => stateOf.set(g, i))
    const n = order.length
    const access = order.map((g) => reps.get(g)!)

    const trans: number[][] = []
    for (let i = 0; i < n; i++) {
      const s = access[i]
      const row: number[] = []
      for (const a of this.alphabet) {
        // Closedness guarantees the successor's signature is one of the S-classes.
        row.push(stateOf.get(this.signature([...s, a]))!)
      }
      trans.push(row)
    }
    const accepting = new Set<number>()
    for (let i = 0; i < n; i++) if (this.cell(access[i], [])) accepting.add(i)

    const dfa: Dfa = {
      numStates: n,
      start: stateOf.get(this.signature([]))!,
      accepting,
      trans,
      alphabet: this.alphabet,
    }
    return { dfa, access }
  }

  /** Run a hypothesis from its start over a prefix, returning the access string of the state hit. */
  private accessAfter(hyp: Hypothesis, prefix: Sym[]): Sym[] {
    let state = hyp.dfa.start
    for (const sym of prefix) {
      const c = this.alphabet.indexOf(sym)
      state = hyp.dfa.trans[state][c]
    }
    return hyp.access[state]
  }

  // -- counterexample digestion ---------------------------------------------

  /** Angluin: add every prefix of the counterexample to S (those not already present). */
  private digestAngluin(ce: Sym[]): Sym[][] {
    const inS = new Set(this.S.map(wkey))
    const added: Sym[][] = []
    for (let i = 1; i <= ce.length; i++) {
      const pre = ce.slice(0, i)
      const k = wkey(pre)
      if (!inS.has(k)) {
        inS.add(k)
        this.S.push(pre)
        added.push(pre)
      }
    }
    return added
  }

  /**
   * Rivest–Schapire: binary-search the counterexample for the single breakpoint where the
   * hypothesis "lies", and add the suffix past it as one new experiment.
   *
   * For prefix length i let α(i) = access(state hyp reaches on ce[0:i]); define
   * β(i) = member(α(i) · ce[i:]). β(0) = member(ce) = target(ce); β(m) = member(access(final)) =
   * hyp(ce). Since the CE makes them disagree, β(0) ≠ β(m), so some i has β(i) ≠ β(i+1). The suffix
   * ce[i+1:] distinguishes two rows the table currently conflates — exactly the experiment to add.
   */
  private digestRivestSchapire(ce: Sym[], hyp: Hypothesis): { suffix: Sym[]; breakpoint: number } {
    const m = ce.length
    const beta = (i: number): boolean =>
      this.teacher.member([...this.accessAfter(hyp, ce.slice(0, i)), ...ce.slice(i)])
    const b0 = beta(0)
    // Invariant: beta(lo) === b0, beta(hi) !== b0. Shrink until hi = lo + 1.
    let lo = 0
    let hi = m
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (beta(mid) === b0) lo = mid
      else hi = mid
    }
    const suffix = ce.slice(lo + 1)
    if (!this.E.some((e) => wkey(e) === wkey(suffix))) this.E.push(suffix)
    return { suffix, breakpoint: lo }
  }

  // -- the step machine ------------------------------------------------------

  /** Perform the next atomic action and describe it. Returns a `done` event once converged. */
  step(): LearnEvent {
    if (this.finished) return { kind: 'done', hyp: this.finalHyp!.dfa, access: this.finalHyp!.access }

    if (!this.started) {
      this.started = true
      return { kind: 'init' }
    }

    // 1) Digest a pending counterexample before anything else.
    if (this.pendingCE) {
      const ce = this.pendingCE
      this.pendingCE = null
      if (this.strategy === 'angluin') {
        const addedRows = this.digestAngluin(ce)
        return { kind: 'counterexample', word: ce, strategy: 'angluin', addedRows }
      }
      const { suffix, breakpoint } = this.digestRivestSchapire(ce, this.pendingHyp!)
      return {
        kind: 'counterexample',
        word: ce,
        strategy: 'rivest-schapire',
        addedSuffix: suffix,
        breakpoint,
      }
    }

    // 2) Repair consistency (Angluin only — Rivest–Schapire keeps the table consistent).
    if (this.strategy === 'angluin') {
      const cons = this.consistencyDefect()
      if (cons) {
        this.E.push(cons.added)
        return { kind: 'consistent', added: cons.added, s1: cons.s1, s2: cons.s2, symbol: cons.symbol }
      }
    }

    // 3) Repair closedness.
    const defect = this.closednessDefect()
    if (defect) {
      this.S.push(defect)
      return { kind: 'close', promoted: defect, signature: this.signature(defect) }
    }

    // 4) Closed + consistent: conjecture and ask an equivalence query.
    const hyp = this.buildHypothesis()
    const ce = this.teacher.equiv(hyp.dfa)
    if (ce === null) {
      this.finished = true
      this.finalHyp = hyp
      return { kind: 'conjecture', hyp: hyp.dfa, access: hyp.access, counterexample: null }
    }
    this.pendingCE = ce
    this.pendingHyp = hyp
    return { kind: 'conjecture', hyp: hyp.dfa, access: hyp.access, counterexample: ce }
  }

  /** Drive to convergence, collecting the event trace. A safety bound guards against bugs. */
  run(maxSteps = 100_000): { events: LearnEvent[]; result: Hypothesis } {
    const events: LearnEvent[] = []
    for (let i = 0; i < maxSteps; i++) {
      const ev = this.step()
      events.push(ev)
      if (this.finished) {
        // Emit one final `done` so callers always see a terminal event.
        events.push(this.step())
        return { events, result: this.finalHyp! }
      }
    }
    throw new Error('L* did not converge within the step budget')
  }
}

/** Convenience: learn a target outright and return the hypothesis plus the learner (for stats). */
export function learn(
  teacher: Teacher,
  strategy: Strategy = 'rivest-schapire',
): { hyp: Hypothesis; learner: LStarLearner; events: LearnEvent[] } {
  const learner = new LStarLearner(teacher, strategy)
  const { events, result } = learner.run()
  return { hyp: result, learner, events }
}

// ---------------------------------------------------------------------------
// Frames — a fully materialized trace so a UI can scrub the learning backwards
// and forwards as a pure slider, without re-running the (mutating) learner.
// ---------------------------------------------------------------------------

export interface RowSnapshot {
  row: Sym[]
  section: 'S' | 'boundary'
  cells: boolean[]
  signature: string
  /** Index of this row's class among the S-classes, or -1 if its signature is new (a closedness defect). */
  classIndex: number
}

export interface TableSnapshot {
  E: Sym[][]
  rows: RowSnapshot[]
  /** Distinct S-class signatures in discovery order (hypothesis state count = classes.length). */
  classes: string[]
}

export interface LearnFrame {
  index: number
  event: LearnEvent
  table: TableSnapshot
  /** The most recent hypothesis built so far (persists across counterexample/repair frames). */
  hyp: Hypothesis | null
  membershipQueries: number
  equivalenceQueries: number
  cacheHits: number
}

interface CountedTeacher extends Teacher {
  membershipQueries: number
  equivalenceQueries: number
  cacheHits: number
}

function snapshot(learner: LStarLearner): TableSnapshot {
  const v = learner.view()
  const classOf = new Map<string, number>()
  v.classes.forEach((g, i) => classOf.set(g, i))
  const mk = (row: Sym[], section: 'S' | 'boundary'): RowSnapshot => {
    const sig = v.signature(row)
    return {
      row,
      section,
      cells: v.E.map((e) => v.cell(row, e)),
      signature: sig,
      classIndex: classOf.has(sig) ? classOf.get(sig)! : -1,
    }
  }
  return {
    E: v.E,
    rows: [...v.S.map((s) => mk(s, 'S')), ...v.boundary.map((b) => mk(b, 'boundary'))],
    classes: v.classes,
  }
}

/**
 * Run the learner to completion, capturing a materialized frame after every atomic step. The
 * returned frames are pure data — a UI can index into them freely to animate the learning.
 */
export function traceLearning(teacher: CountedTeacher, strategy: Strategy): LearnFrame[] {
  const learner = new LStarLearner(teacher, strategy)
  const frames: LearnFrame[] = []
  let hyp: Hypothesis | null = null
  for (let i = 0; i < 200_000; i++) {
    const event = learner.step()
    if (event.kind === 'conjecture') hyp = { dfa: event.hyp, access: event.access }
    else if (event.kind === 'done') hyp = { dfa: event.hyp, access: event.access }
    frames.push({
      index: frames.length,
      event,
      table: snapshot(learner),
      hyp,
      membershipQueries: teacher.membershipQueries,
      equivalenceQueries: teacher.equivalenceQueries,
      cacheHits: teacher.cacheHits,
    })
    if (event.kind === 'done') break
  }
  return frames
}
