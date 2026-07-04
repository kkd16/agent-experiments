// The native answer-set solver — the piece that reuses SatForge's own CDCL core.
//
// Answer sets are *not* the models of a program read as a classical formula: a
// positive loop like `a :- b.  b :- a.` has the classical (supported) model
// {a, b}, yet the only answer set is {} because nothing *founds* a or b. The
// engine here is the real technique for bridging that gap, due to Lin & Zhao /
// the ASSAT system, layered on the project's CDCL solver:
//
//   1. **Clark's completion.** Turn the program into a CNF whose models are
//      exactly the *supported* models — each atom is true iff some rule body
//      that can derive it is true. A fresh variable reifies every rule body so
//      loop formulas (step 3) can name it.
//   2. **Unfounded check.** For each supported model M, compute the greatest
//      unfounded set U = M \ founded(M) by a least-fixpoint "what can M justify
//      without circular support" sweep. U = ∅ ⟺ M is a genuine answer set.
//   3. **Loop-formula refinement.** When U ≠ ∅, add the loop formula for U — a
//      clause that is a logical consequence of the stable semantics (so it never
//      discards a real answer set) but which forbids this circular model — and
//      re-solve. Enumeration blocks each answer set it accepts, so it terminates
//      and returns *every* answer set (up to a cap).
//
// Every model the enumerator accepts is additionally re-checked by the fully
// independent reduct oracle (`isAnswerSet`) before it is reported, so a bug in
// the completion or the unfounded check can only ever *lose* answer sets in a
// way the self-test catches against brute force — never invent a wrong one.

import type { CNF } from '../sat/cnf'
import { solve } from '../sat/solver'
import type { GroundProgram, AnswerSet } from './program'
import { answerSetKey } from './program'
import { isAnswerSet, normalizeForOracle } from './reduct'

// ---------------------------------------------------------------------------
// Clark's completion → CNF
// ---------------------------------------------------------------------------

export interface Completion {
  cnf: CNF
  /** bodyVar[i] = the SAT variable reifying rule i's body (null for constraints). */
  bodyVar: (number | null)[]
  numVars: number
  numAtoms: number
}

/** All size-k subsets of `arr`. Used to encode small cardinality bounds directly
 *  (clear and obviously correct; choice heads are few in practice). */
function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = []
  const pick: T[] = []
  const rec = (start: number, need: number) => {
    if (need === 0) {
      out.push(pick.slice())
      return
    }
    for (let i = start; i <= arr.length - need; i++) {
      pick.push(arr[i])
      rec(i + 1, need - 1)
      pick.pop()
    }
  }
  if (k >= 0 && k <= arr.length) rec(0, k)
  return out
}

/** Build the Clark completion of a ground program as a CNF plus body-var metadata. */
export function buildCompletion(prog: GroundProgram): Completion {
  const N = prog.numAtoms
  let nv = N
  const bodyVar: (number | null)[] = []
  const clauses: number[][] = []
  // atom -> the body vars that can support it (its completion's disjunction).
  const support: number[][] = Array.from({ length: N + 1 }, () => [])

  for (const r of prog.rules) {
    if (r.kind === 'constraint') {
      bodyVar.push(null)
      continue
    }
    bodyVar.push(++nv)
  }

  prog.rules.forEach((r, i) => {
    if (r.kind === 'constraint') {
      // The body must not hold: at least one positive literal false, or one
      // negative literal true.
      clauses.push([...r.pos.map((p) => -p), ...r.neg.map((n) => n)])
      return
    }
    const b = bodyVar[i]!
    // b ⇒ each positive body atom, b ⇒ ¬(each negative body atom)
    for (const p of r.pos) clauses.push([-b, p])
    for (const n of r.neg) clauses.push([-b, -n])
    // (all positive true ∧ all negative false) ⇒ b
    clauses.push([b, ...r.pos.map((p) => -p), ...r.neg.map((n) => n)])

    if (r.kind === 'normal') {
      clauses.push([-b, r.head]) // b ⇒ head (the rule fires)
      support[r.head].push(b)
    } else {
      // choice: heads are free when the body holds — they get support but are
      // not forced. Cardinality bounds are guarded by the body variable.
      for (const h of r.heads) support[h].push(b)
      if (r.hi !== null) {
        // at most hi of the heads: no (hi+1)-subset all true (given b).
        for (const S of combinations(r.heads, r.hi + 1)) {
          clauses.push([-b, ...S.map((a) => -a)])
        }
      }
      if (r.lo !== null && r.lo > 0) {
        if (r.lo > r.heads.length) {
          clauses.push([-b]) // impossible lower bound: the body can never hold.
        } else {
          // at least lo of the heads: every (|H|−lo+1)-subset has one true.
          for (const S of combinations(r.heads, r.heads.length - r.lo + 1)) {
            clauses.push([-b, ...S.map((a) => a)])
          }
        }
      }
    }
  })

  // Completion support clauses: an atom is true only if some body supports it.
  for (let a = 1; a <= N; a++) {
    if (support[a].length === 0) clauses.push([-a])
    else clauses.push([-a, ...support[a]])
  }

  return { cnf: { numVars: nv, clauses }, bodyVar, numVars: nv, numAtoms: N }
}

// ---------------------------------------------------------------------------
// Unfounded set + loop formula
// ---------------------------------------------------------------------------

/** The greatest unfounded set of M: the atoms true in M that no non-circular
 *  chain of rule applications can justify. Empty ⟺ M is a stable model. */
export function unfoundedSet(prog: GroundProgram, M: ReadonlyArray<number>): number[] {
  const N = prog.numAtoms
  const inM = new Uint8Array(N + 1)
  for (const a of M) inM[a] = 1
  const founded = new Uint8Array(N + 1)
  let changed = true
  while (changed) {
    changed = false
    for (const r of prog.rules) {
      if (r.kind === 'constraint') continue
      // external support: every positive body atom already founded, no negative
      // body atom true in M.
      let ok = true
      for (const p of r.pos) if (founded[p] !== 1) { ok = false; break }
      if (ok) for (const n of r.neg) if (inM[n] === 1) { ok = false; break }
      if (!ok) continue
      const heads = r.kind === 'normal' ? [r.head] : r.heads
      for (const h of heads) {
        if (inM[h] === 1 && founded[h] === 0) {
          founded[h] = 1
          changed = true
        }
      }
    }
  }
  const U: number[] = []
  for (const a of M) if (founded[a] === 0) U.push(a)
  return U
}

/** The loop formula clause for an unfounded set U: ¬(all of U) ∨ (some external
 *  supporting body). It is entailed by the stable semantics, so adding it prunes
 *  the circular model U witnesses without ever removing a real answer set. */
function loopFormula(prog: GroundProgram, U: number[], bodyVar: (number | null)[]): number[] {
  const Uset = new Set(U)
  const lits: number[] = U.map((a) => -a)
  prog.rules.forEach((r, i) => {
    const b = bodyVar[i]
    if (b == null) return
    const heads = r.kind === 'normal' ? [r.head] : r.kind === 'choice' ? r.heads : []
    if (!heads.some((h) => Uset.has(h))) return
    if (r.pos.some((p) => Uset.has(p))) return // not external — re-enters the loop
    lits.push(b)
  })
  return lits
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export interface AspSolveOptions {
  /** Stop after this many answer sets (default 5000). */
  maxAnswerSets?: number
  /** Abort (marking the result incomplete) after this many CDCL re-solves. */
  maxIterations?: number
  /** Per-solve conflict budget handed to the CDCL core. */
  maxConflicts?: number
  /** Per-solve wall-clock budget (ms). */
  maxTimeMs?: number
}

export interface AspStats {
  /** CDCL re-solves performed. */
  iterations: number
  /** supported models examined (answer-set candidates). */
  supportedModels: number
  /** loop formulas added during refinement. */
  loopFormulas: number
  bodyVars: number
  completionClauses: number
  timeMs: number
}

export interface AspSolveResult {
  /** 'sat' when at least one answer set exists. */
  status: 'sat' | 'unsat'
  answerSets: AnswerSet[]
  /** How many answer sets were returned (== answerSets.length; may be capped). */
  count: number
  /** True if the enumeration finished within all caps (so `count` is exact). */
  complete: boolean
  stats: AspStats
}

function atomsFromModel(model: boolean[], N: number): number[] {
  const out: number[] = []
  for (let v = 1; v <= N; v++) if (model[v]) out.push(v)
  return out
}

function blockingClause(M: ReadonlyArray<number>, N: number): number[] {
  const inM = new Set(M)
  const cl: number[] = []
  for (let v = 1; v <= N; v++) cl.push(inM.has(v) ? -v : v)
  return cl
}

/** Enumerate the answer sets of a ground program. */
export function solveAsp(prog: GroundProgram, opts: AspSolveOptions = {}): AspSolveResult {
  const t0 = Date.now()
  const maxAnswerSets = opts.maxAnswerSets ?? 5000
  const maxIterations = opts.maxIterations ?? 500000
  const maxConflicts = opts.maxConflicts ?? 2_000_000
  const maxTimeMs = opts.maxTimeMs ?? 20000
  const N = prog.numAtoms
  const base = buildCompletion(prog)
  const clauses = base.cnf.clauses.map((c) => c.slice())
  const numVars = base.numVars

  const answerSets: AnswerSet[] = []
  const seen = new Set<string>()
  let iterations = 0
  let supportedModels = 0
  let loopFormulas = 0
  let complete = true

  while (answerSets.length < maxAnswerSets) {
    if (iterations >= maxIterations || Date.now() - t0 > maxTimeMs) {
      complete = false
      break
    }
    iterations++
    const res = solve({ numVars, clauses }, { maxConflicts, maxTimeMs: 5000 })
    if (res.status === 'unknown') {
      complete = false
      break
    }
    if (res.status === 'unsat') break
    supportedModels++
    const M = atomsFromModel(res.model!, N)
    const U = unfoundedSet(prog, M)
    if (U.length === 0 && isAnswerSet(prog, M)) {
      const key = answerSetKey(M)
      if (!seen.has(key)) {
        seen.add(key)
        answerSets.push(M)
      }
      clauses.push(blockingClause(M, N))
    } else if (U.length > 0) {
      clauses.push(loopFormula(prog, U, base.bodyVar))
      loopFormulas++
    } else {
      // Unexpected (unfounded-free but the oracle rejected it): block and move on.
      clauses.push(blockingClause(M, N))
    }
  }

  if (answerSets.length >= maxAnswerSets) complete = false

  return {
    status: answerSets.length > 0 ? 'sat' : 'unsat',
    answerSets,
    count: answerSets.length,
    complete,
    stats: {
      iterations,
      supportedModels,
      loopFormulas,
      bodyVars: base.numVars - N,
      completionClauses: base.cnf.clauses.length,
      timeMs: Date.now() - t0,
    },
  }
}

// ---------------------------------------------------------------------------
// Well-founded model (van Gelder's alternating fixpoint)
// ---------------------------------------------------------------------------

export interface WellFounded {
  /** Atoms true in every answer set (the deterministic consequences). */
  trueAtoms: number[]
  /** Atoms false in every answer set. */
  falseAtoms: number[]
  /** Atoms left open — the genuine choices the search must resolve. */
  undefinedAtoms: number[]
}

/** The Gelfond–Lifschitz operator Γ(S): least model of the reduct of the
 *  normalised program w.r.t. S. Antimonotone in S; Γ² is monotone. */
function gamma(
  rules: { head: number; pos: number[]; neg: number[] }[],
  S: Uint8Array,
  total: number,
): Uint8Array {
  const lm = new Uint8Array(total + 1)
  const active = rules.filter((r) => r.neg.every((n) => S[n] === 0))
  let changed = true
  while (changed) {
    changed = false
    for (const r of active) {
      if (lm[r.head] === 0 && r.pos.every((p) => lm[p] === 1)) {
        lm[r.head] = 1
        changed = true
      }
    }
  }
  return lm
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The three-valued well-founded model, projected onto the program's real atoms. */
export function wellFoundedModel(prog: GroundProgram): WellFounded {
  const { totalAtoms, rules } = normalizeForOracle(prog)
  // Least fixpoint of Γ² from ∅ (monotone, so iterate to convergence).
  let L: Uint8Array = new Uint8Array(totalAtoms + 1)
  for (;;) {
    const next = gamma(rules, gamma(rules, L, totalAtoms), totalAtoms)
    if (eq(next, L)) break
    L = next
  }
  const upper = gamma(rules, L, totalAtoms) // atoms outside `upper` are false
  const trueAtoms: number[] = []
  const falseAtoms: number[] = []
  const undefinedAtoms: number[] = []
  for (let v = 1; v <= prog.numAtoms; v++) {
    if (L[v] === 1) trueAtoms.push(v)
    else if (upper[v] === 0) falseAtoms.push(v)
    else undefinedAtoms.push(v)
  }
  return { trueAtoms, falseAtoms, undefinedAtoms }
}
