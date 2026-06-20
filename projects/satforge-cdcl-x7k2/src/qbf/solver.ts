// A from-scratch QBF solver by **counterexample-guided expansion** — the core
// idea behind RAReQS (Janota, Klieber, Marques-Silva & Clarke, SAT 2012). It
// decides arbitrary prenex QBF with any number of quantifier alternations by
// reducing the problem to a sequence of ordinary SAT calls on the very same
// CDCL core that powers the rest of SatForge.
//
// The recursion is the quantifier game played one block at a time:
//
//   ∃X. Ψ   the existential player searches for an X-move τ that *wins* the rest
//           of the game (Ψ[τ] is true). It proposes candidates with a SAT solver
//           over a growing set of *blocking* clauses, recursively (and exactly)
//           checks each one, and on failure learns the opponent's refuting move —
//           ruling that candidate out — until it either wins or runs out of moves.
//
//   ∀X. Ψ   dually, the universal player searches for an X-move that *refutes* the
//           rest (Ψ[τ] is false); if no such move survives, the formula holds.
//
// Each recursive call strips one quantifier block (substituting the chosen move
// into the matrix), so the recursion is well-founded and the per-node loop
// terminates after at most 2^|X| candidates — exponential in the worst case, as
// QBF demands, but driven entirely by unit propagation and conflict learning in
// the underlying CDCL engine, and bounded by an explicit refinement budget.
//
// Correctness is not taken on faith: ./selfcheck.ts cross-checks every verdict
// against the exhaustive oracle in ./eval.ts on thousands of instances, and
// confirms that every returned winning move genuinely wins.

import { solve } from '../sat/solver'
import type { QBF, QBlock, Quant } from './qdimacs'
import { normalizeQbf } from './qdimacs'

export interface QbfOptions {
  /** Abort (→ 'unknown') after this many refinement iterations total. */
  maxIter?: number
  /** Per-SAT-call conflict budget (0 = ∞). */
  satConflicts?: number
  /** Cap on recorded trace events (default 4000). */
  maxTrace?: number
  /** Record the candidate/refinement trace of the outermost loop (default true). */
  trace?: boolean
}

export interface QbfStats {
  /** Number of leaf SAT solver invocations. */
  satCalls: number
  /** Total candidate moves proposed across all recursion levels. */
  candidates: number
  /** Total blocking refinements (learned counter-moves) across all levels. */
  refinements: number
  /** Deepest recursion level reached. */
  maxDepth: number
  /** Wall-clock time in milliseconds. */
  timeMs: number
}

export type QbfTraceEvent =
  | { t: 'candidate'; iter: number; move: Record<number, boolean> }
  | { t: 'win'; iter: number; move: Record<number, boolean> }
  | { t: 'refute'; iter: number; move: Record<number, boolean> }
  | { t: 'block'; iter: number; counter: Record<number, boolean>; blocked: number }
  | { t: 'exhausted'; iter: number; value: boolean }

export interface QbfResult {
  /** The truth value of the QBF, or 'unknown' if a budget was exhausted. */
  value: boolean | 'unknown'
  /** Quantifier of the outermost block. */
  topQuant: Quant
  /** Variables of the outermost block. */
  topVars: number[]
  /**
   * A decisive move for the outermost block, when one exists: the ∃ assignment
   * that wins (value true & top ∃), or the ∀ assignment that refutes (value
   * false & top ∀). Absent when the outer player loses (its certificate would be
   * a full Skolem/Herbrand function, not a single assignment).
   */
  witness?: Record<number, boolean>
  stats: QbfStats
  trace: QbfTraceEvent[]
}

// ---- internal machinery -----------------------------------------------------

type Assign = Map<number, boolean>

interface Ctx {
  satCalls: number
  candidates: number
  refinements: number
  maxDepth: number
  iter: number
  maxIter: number
  satConflicts: number
  aborted: boolean
  trace: QbfTraceEvent[]
  maxTrace: number
  recordDepth: number // depth of the outermost multi-block loop (-1 until entered)
  doTrace: boolean
}

interface Outcome {
  value: boolean
  witness: Assign // populated only when the top player of this call *wins*
}

function maxVarIn(clauses: number[][], floor: number): number {
  let m = floor
  for (const c of clauses) for (const l of c) {
    const v = l < 0 ? -l : l
    if (v > m) m = v
  }
  return m
}

/** SAT-solve a clause set; returns satisfiability and a 1-based model. */
function satSolve(ctx: Ctx, clauses: number[][], numVars: number): { sat: boolean; model: boolean[] } {
  ctx.satCalls++
  for (const c of clauses) {
    if (c.length === 0) return { sat: false, model: [] }
  }
  if (clauses.length === 0) {
    return { sat: true, model: new Array(numVars + 1).fill(false) }
  }
  const nv = maxVarIn(clauses, numVars)
  const res = solve({ numVars: nv, clauses }, { maxConflicts: ctx.satConflicts })
  if (res.status === 'unknown') {
    ctx.aborted = true
    return { sat: false, model: [] }
  }
  return { sat: res.status === 'sat', model: res.model ?? [] }
}

/** Restrict a CNF by a partial assignment, dropping satisfied clauses and false literals. */
function substitute(matrix: number[][], assign: Assign): number[][] {
  const out: number[][] = []
  for (const c of matrix) {
    let satisfied = false
    const lits: number[] = []
    for (const l of c) {
      const v = l < 0 ? -l : l
      const a = assign.get(v)
      if (a === undefined) {
        lits.push(l)
      } else if (l > 0 === a) {
        satisfied = true
        break
      }
      // else: literal is false under the assignment — drop it.
    }
    if (!satisfied) out.push(lits)
  }
  return out
}

/** Is clause `c` a tautology (contains some variable both positively and negatively)? */
function isTautology(c: number[]): boolean {
  const seen = new Set<number>()
  for (const l of c) {
    if (seen.has(-l)) return true
    seen.add(l)
  }
  return false
}

/**
 * A ∀-move over `vars` that falsifies a CNF known to be invalid: pick a
 * non-tautological clause and set each of its literals false. Remaining
 * variables default to false. The result makes that clause — hence the whole
 * matrix — false.
 */
function falsifyingMove(matrix: number[][], vars: number[]): Assign {
  const a: Assign = new Map()
  for (const v of vars) a.set(v, false)
  for (const c of matrix) {
    if (isTautology(c)) continue
    for (const l of c) a.set(l < 0 ? -l : l, l < 0) // make literal l false
    break
  }
  return a
}

function record(ctx: Ctx, depth: number, ev: QbfTraceEvent) {
  if (!ctx.doTrace || depth !== ctx.recordDepth) return
  if (ctx.trace.length >= ctx.maxTrace) return
  ctx.trace.push(ev)
}

function assignToObj(a: Assign): Record<number, boolean> {
  const o: Record<number, boolean> = {}
  for (const [k, v] of a) o[k] = v
  return o
}

/**
 * Decide (prefix, matrix). Returns the truth value and, when the top player of
 * this call *wins*, a winning move for the top block.
 */
function qsolve(prefix: QBlock[], matrix: number[][], ctx: Ctx, depth: number): Outcome {
  if (depth > ctx.maxDepth) ctx.maxDepth = depth
  if (ctx.aborted) return { value: false, witness: new Map() }

  // A clause already empty ⇒ matrix is false regardless of the remaining moves.
  for (const c of matrix) {
    if (c.length === 0) return { value: false, witness: new Map() }
  }
  // No clauses left ⇒ matrix is true.
  if (prefix.length === 0) return { value: true, witness: new Map() }

  const top = prefix[0]
  const X = top.vars
  const rest = prefix.slice(1)

  // ---- single quantifier block: a base case decided by SAT / validity -------
  if (rest.length === 0) {
    if (top.q === 'e') {
      const { sat, model } = satSolve(ctx, matrix, maxVarIn(matrix, 0))
      if (!sat) return { value: false, witness: new Map() }
      const w: Assign = new Map()
      for (const v of X) w.set(v, model[v] ?? false)
      return { value: true, witness: w }
    }
    // ∀X. matrix is valid iff every clause is a tautology.
    for (const c of matrix) {
      if (!isTautology(c)) return { value: false, witness: falsifyingMove(matrix, X) }
    }
    return { value: true, witness: new Map() }
  }

  // ---- multi-block: counterexample-guided candidate search ------------------
  if (ctx.recordDepth < 0) ctx.recordDepth = depth
  const wantInner = top.q === 'e' // ∃ seeks an inner-true move; ∀ seeks an inner-false move
  const blocking: number[][] = [] // clauses over X ruling out spent candidates
  const xMax = X.reduce((m, v) => (v > m ? v : m), 0)

  for (;;) {
    if (ctx.aborted) return { value: false, witness: new Map() }
    if (++ctx.iter > ctx.maxIter) {
      ctx.aborted = true
      return { value: false, witness: new Map() }
    }
    const localIter = ctx.iter
    ctx.candidates++

    // Propose a candidate move τ over X that has not been ruled out.
    const { sat, model } = satSolve(ctx, blocking, xMax)
    if (!sat) {
      // No candidate survives: the searching player has no winning move, so the
      // outcome is the opposite of what it was seeking.
      const value = !wantInner
      record(ctx, depth, { t: 'exhausted', iter: localIter, value })
      return { value, witness: new Map() }
    }
    const tau: Assign = new Map()
    for (const v of X) tau.set(v, model[v] ?? false)
    record(ctx, depth, { t: 'candidate', iter: localIter, move: assignToObj(tau) })

    // Exactly evaluate the rest of the game under τ.
    const r = qsolve(rest, substitute(matrix, tau), ctx, depth + 1)
    if (ctx.aborted) return { value: false, witness: new Map() }

    if (r.value === wantInner) {
      // τ achieves the searching player's goal — it is a decisive move.
      record(ctx, depth, { t: wantInner ? 'win' : 'refute', iter: localIter, move: assignToObj(tau) })
      return { value: wantInner, witness: tau }
    }

    // τ failed; the opponent's response r.witness explains why. Rule τ out with a
    // blocking clause (its negation over X) and keep searching.
    const clause: number[] = []
    for (const v of X) clause.push(tau.get(v) ? -v : v)
    blocking.push(clause)
    ctx.refinements++
    const counter: Assign = new Map()
    for (const v of rest[0].vars) if (r.witness.has(v)) counter.set(v, r.witness.get(v)!)
    record(ctx, depth, { t: 'block', iter: localIter, counter: assignToObj(counter), blocked: blocking.length })
  }
}

/** Decide a QBF. The headline entry point. */
export function solveQbf(input: QBF, opts: QbfOptions = {}): QbfResult {
  const qbf = normalizeQbf(input.prefix, input.matrix, input.comments)
  const ctx: Ctx = {
    satCalls: 0,
    candidates: 0,
    refinements: 0,
    maxDepth: 0,
    iter: 0,
    maxIter: opts.maxIter ?? 2_000_000,
    satConflicts: opts.satConflicts ?? 0,
    aborted: false,
    trace: [],
    maxTrace: opts.maxTrace ?? 4000,
    recordDepth: -1,
    doTrace: opts.trace ?? true,
  }
  const t0 = performance.now()
  const r = qsolve(qbf.prefix, qbf.matrix, ctx, 0)
  const timeMs = performance.now() - t0

  const topQuant: Quant = qbf.prefix[0]?.q ?? 'e'
  const topVars = qbf.prefix[0]?.vars ?? []
  const value: boolean | 'unknown' = ctx.aborted ? 'unknown' : r.value
  const stats: QbfStats = {
    satCalls: ctx.satCalls,
    candidates: ctx.candidates,
    refinements: ctx.refinements,
    maxDepth: ctx.maxDepth,
    timeMs,
  }

  let witness: Record<number, boolean> | undefined
  if (value !== 'unknown') {
    const outerWon = (topQuant === 'e' && value) || (topQuant === 'a' && !value)
    if (outerWon && r.witness.size > 0) witness = assignToObj(r.witness)
  }

  return { value, topQuant, topVars, witness, stats, trace: ctx.trace }
}
