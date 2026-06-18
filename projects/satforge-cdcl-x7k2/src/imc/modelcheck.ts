// Interpolation-based Model Checking (McMillan 2003). Given a finite-state
// transition system (Init, Trans, Bad) we prove the bad states *unreachable*
// for all time — unbounded safety — without ever computing the exact reachable
// set. The trick: run bounded model checking; when the bound-k unrolling is
// UNSAT, the Craig interpolant of (first step | rest) is an over-approximation
// of the one-step image that still cannot reach Bad. Iterating the interpolant
// converges to an inductive invariant, which is a checkable proof of safety.
//
// Variable layout: state variable j∈{1..stateBits} at unrolling step i lives at
// global id  i*stateBits + j.  `trans` is written over current vars (1..n) and
// next vars (n+1..2n); `init`/`bad` over current vars (1..n).

import type { Formula } from './formula'
import { CnfBuilder, mapVars, for_, fnot, evalFormula, fvar, fxor } from './formula'
import { solveCnf } from './proofSolver'
import { interpolate } from './interpolant'

export interface TransitionSystem {
  name: string
  description?: string
  stateBits: number
  bitNames?: string[]
  init: Formula
  trans: Formula
  bad: Formula
}

export interface ImcStep {
  round: number
  bound: number
  kind: 'frame' | 'bmc' | 'fixpoint' | 'spurious'
  message: string
}

export interface ImcResult {
  result: 'SAFE' | 'UNSAFE' | 'UNKNOWN'
  bound: number
  rounds: number
  /** Inductive invariant proving safety (present iff SAFE). */
  invariant?: Formula
  /** Counterexample as a list of states (each a boolean[] over 1..stateBits). */
  counterexample?: boolean[][]
  trace: ImcStep[]
}

const atStep = (f: Formula, step: number, stateBits: number): Formula =>
  mapVars(f, (v) => step * stateBits + v)

// Trans current var j -> step layer; next var (n+j) -> (step+1) layer.
const transAt = (trans: Formula, step: number, n: number): Formula =>
  mapVars(trans, (v) => (v <= n ? step * n + v : (step + 1) * n + (v - n)))

// Map an interpolant over step-1 state vars (n+1..2n) back to the base layer (1..n).
const unprimeStep1 = (f: Formula, n: number): Formula => mapVars(f, (v) => v - n)

/**
 * Encode two formula bundles into one partitioned CNF for interpolation. All
 * `aFormulas` clauses are tagged A, all `bFormulas` clauses B; auxiliary
 * variables stay local to their side. `reservedVars` keeps the low ids (the
 * unrolling state vars) below any fresh Tseitin variable.
 */
function partitionedCnf(reservedVars: number, aFormulas: Formula[], bFormulas: Formula[]) {
  const b = new CnfBuilder(reservedVars)
  for (const f of aFormulas) b.assert(f)
  const aLen = b.clauseCount
  b.newPartition()
  for (const f of bFormulas) b.assert(f)
  return {
    numVars: b.numVars,
    aClauses: b.clauses.slice(0, aLen),
    bClauses: b.clauses.slice(aLen),
  }
}

/** SAT-check a conjunction of formulas; return a model (over 1..numVars) or null. */
function satModel(reservedVars: number, formulas: Formula[]): boolean[] | null {
  const b = new CnfBuilder(reservedVars)
  for (const f of formulas) b.assert(f)
  const r = solveCnf(b.numVars, b.clauses)
  return r.status === 'sat' ? r.model! : null
}

/** Does `premise ⟹ concl` hold? (i.e. premise ∧ ¬concl unsatisfiable.) */
function implies(reservedVars: number, premise: Formula, concl: Formula): boolean {
  return satModel(reservedVars, [premise, fnot(concl)]) === null
}

function extractStates(model: boolean[], steps: number, n: number): boolean[][] {
  const out: boolean[][] = []
  for (let i = 0; i <= steps; i++) {
    const s: boolean[] = new Array(n + 1).fill(false)
    for (let j = 1; j <= n; j++) s[j] = model[i * n + j] ?? false
    out.push(s)
  }
  return out
}

export interface ImcOptions {
  maxBound?: number
  maxRounds?: number
}

/**
 * Run interpolation-based model checking. Returns SAFE with an inductive
 * invariant, UNSAFE with a concrete counterexample trace, or UNKNOWN if the
 * bound/round budget is exhausted.
 */
export function imc(ts: TransitionSystem, opts: ImcOptions = {}): ImcResult {
  const n = ts.stateBits
  const maxBound = opts.maxBound ?? 40
  const maxRounds = opts.maxRounds ?? (1 << n) + 4
  const trace: ImcStep[] = []
  let totalRounds = 0

  // k = 0: a bad initial state is an immediate counterexample.
  {
    const m = satModel(n, [atStep(ts.init, 0, n), atStep(ts.bad, 0, n)])
    if (m) {
      trace.push({ round: 0, bound: 0, kind: 'bmc', message: 'Init ∧ Bad is satisfiable — bad state is initial.' })
      return { result: 'UNSAFE', bound: 0, rounds: 0, counterexample: extractStates(m, 0, n), trace }
    }
  }

  for (let k = 1; k <= maxBound; k++) {
    const reserved = (k + 1) * n

    // Genuine BMC: is Bad reachable from Init within k steps?
    const bmcForms: Formula[] = [atStep(ts.init, 0, n)]
    for (let i = 0; i < k; i++) bmcForms.push(transAt(ts.trans, i, n))
    const badAny: Formula[] = []
    for (let i = 0; i <= k; i++) badAny.push(atStep(ts.bad, i, n))
    bmcForms.push(for_(...badAny))
    const cexModel = satModel(reserved, bmcForms)
    if (cexModel) {
      // Find the first step that is bad — that is the counterexample length.
      let badStep = k
      for (let i = 0; i <= k; i++) {
        if (evalFormula(atStep(ts.bad, i, n), (v) => cexModel[v] ?? false)) {
          badStep = i
          break
        }
      }
      trace.push({ round: totalRounds, bound: k, kind: 'bmc', message: `BMC found a length-${badStep} counterexample.` })
      return { result: 'UNSAFE', bound: k, rounds: totalRounds, counterexample: extractStates(cexModel, badStep, n), trace }
    }
    trace.push({ round: totalRounds, bound: k, kind: 'bmc', message: `No counterexample within ${k} step(s); searching for an invariant.` })

    // Interpolation fixpoint at this bound.
    let R: Formula = ts.init
    let spurious = false
    for (let round = 0; round < maxRounds; round++) {
      totalRounds++
      // A = R@0 ∧ Trans(0,1);  B = ⋀_{i=1}^{k-1} Trans(i,i+1) ∧ ⋁_{i=1}^{k} Bad@i
      const aForms: Formula[] = [atStep(R, 0, n), transAt(ts.trans, 0, n)]
      const bForms: Formula[] = []
      for (let i = 1; i < k; i++) bForms.push(transAt(ts.trans, i, n))
      const badside: Formula[] = []
      for (let i = 1; i <= k; i++) badside.push(atStep(ts.bad, i, n))
      bForms.push(for_(...badside))

      const { numVars, aClauses, bClauses } = partitionedCnf(reserved, aForms, bForms)
      const itp = interpolate(numVars, aClauses, bClauses)
      if (itp.status === 'sat') {
        // Over-approximation reached Bad. Genuine BMC was UNSAT, so this is
        // spurious — the abstraction is too coarse; widen the bound.
        spurious = true
        trace.push({ round: totalRounds, bound: k, kind: 'spurious', message: 'Over-approximation hit Bad (spurious); increasing bound.' })
        break
      }
      // Interpolant is over step-1 vars; bring it back to the base layer.
      const image = unprimeStep1(itp.interpolant, n)
      if (implies(n, image, R)) {
        // image ⊆ R: R is closed under Trans and excludes Bad — an inductive invariant.
        trace.push({ round: totalRounds, bound: k, kind: 'fixpoint', message: `Inductive invariant found after ${round + 1} interpolation round(s).` })
        return { result: 'SAFE', bound: k, rounds: totalRounds, invariant: R, trace }
      }
      R = for_(R, image)
    }
    if (!spurious) {
      // Round budget exhausted without convergence (should not happen for a
      // finite system); fall through to a larger bound defensively.
      trace.push({ round: totalRounds, bound: k, kind: 'frame', message: 'Round budget exhausted at this bound.' })
    }
  }
  return { result: 'UNKNOWN', bound: maxBound, rounds: totalRounds, trace }
}

// ---- k-induction: a second, independent safety proof rule ------------------

export interface KIndResult {
  result: 'SAFE' | 'UNSAFE' | 'UNKNOWN'
  /** Depth at which induction succeeded or the counterexample was found. */
  k: number
  counterexample?: boolean[][]
}

// States at steps i and j differ in at least one bit.
const distinct = (i: number, j: number, n: number): Formula => {
  const parts: Formula[] = []
  for (let b = 1; b <= n; b++) parts.push(fxor(fvar(i * n + b), fvar(j * n + b)))
  return for_(...parts)
}

/**
 * Prove safety by **k-induction**, completely independently of interpolation.
 *   base(k):  Init ∧ Trans^k ∧ ⋁ Bad@i  unsat  ⇒ no counterexample within k
 *   step(k):  Trans^{k+1} ∧ ⋀_{i≤k} ¬Bad@i ∧ Bad@{k+1} ∧ (all states distinct) unsat
 *             ⇒ ¬Bad is k-inductive
 * The simple-path (pairwise-distinct) restriction makes k-induction complete for
 * finite systems, so this always terminates with SAFE or UNSAFE. Used in the
 * self-test as a second oracle: its verdict must match both `imc` and BFS.
 */
export function kInduction(ts: TransitionSystem, maxK = 64): KIndResult {
  const n = ts.stateBits
  const stateCount = 1 << n
  for (let k = 0; k <= maxK; k++) {
    const reserved = (k + 2) * n
    // Base case: counterexample of length ≤ k?
    const base: Formula[] = [atStep(ts.init, 0, n)]
    for (let i = 0; i < k; i++) base.push(transAt(ts.trans, i, n))
    const badAny: Formula[] = []
    for (let i = 0; i <= k; i++) badAny.push(atStep(ts.bad, i, n))
    base.push(for_(...badAny))
    const cex = satModel(reserved, base)
    if (cex) {
      let badStep = k
      for (let i = 0; i <= k; i++) {
        if (evalFormula(atStep(ts.bad, i, n), (v) => cex[v] ?? false)) {
          badStep = i
          break
        }
      }
      return { result: 'UNSAFE', k, counterexample: extractStates(cex, badStep, n) }
    }
    // Completeness shortcut: the step asserts k+2 pairwise-distinct states, but a
    // system has only 2^n of them. Once k+2 > 2^n no such simple path exists, so —
    // the base case above having ruled out any counterexample within k (and the
    // shortest counterexample is always simple, hence ≤ 2^n−1 long) — the property
    // is proven. This also keeps the lightweight solver away from the
    // pigeonhole-hard distinct-state UNSAT at the recurrence-diameter boundary.
    if (k + 2 > stateCount) return { result: 'SAFE', k }
    // Inductive step over a simple path of length k+1.
    const step: Formula[] = []
    for (let i = 0; i <= k; i++) step.push(transAt(ts.trans, i, n))
    for (let i = 0; i <= k; i++) step.push(fnot(atStep(ts.bad, i, n)))
    step.push(atStep(ts.bad, k + 1, n))
    for (let i = 0; i <= k + 1; i++) for (let j = i + 1; j <= k + 1; j++) step.push(distinct(i, j, n))
    if (satModel(reserved, step) === null) {
      return { result: 'SAFE', k }
    }
  }
  return { result: 'UNKNOWN', k: maxK }
}

// ---- Independent explicit-state reachability oracle ------------------------

export interface BfsResult {
  safe: boolean
  /** Shortest distance from an init state to a bad state (−1 if safe). */
  distance: number
}

const stateAssign = (s: number, n: number): boolean[] => {
  const a: boolean[] = new Array(n + 1).fill(false)
  for (let j = 1; j <= n; j++) a[j] = (s & (1 << (j - 1))) !== 0
  return a
}

/**
 * Brute-force reachability over the explicit 2^stateBits state graph: BFS from
 * every initial state, reporting whether any bad state is reachable. Completely
 * independent of the SAT/interpolation machinery — the oracle the self-test
 * holds `imc` to. Only for small systems (stateBits ≤ ~12).
 */
export function bfsReachability(ts: TransitionSystem): BfsResult {
  const n = ts.stateBits
  const N = 1 << n
  const isInit = (s: number) => evalFormula(ts.init, (v) => (stateAssign(s, n)[v]))
  const isBad = (s: number) => evalFormula(ts.bad, (v) => (stateAssign(s, n)[v]))
  // Precompute successors using the trans relation over (current, next).
  const succ = (s: number): number[] => {
    const cur = stateAssign(s, n)
    const out: number[] = []
    for (let t = 0; t < N; t++) {
      const nxt = stateAssign(t, n)
      const ok = evalFormula(ts.trans, (v) => (v <= n ? cur[v] : nxt[v - n]))
      if (ok) out.push(t)
    }
    return out
  }

  const dist = new Int32Array(N).fill(-1)
  const queue: number[] = []
  for (let s = 0; s < N; s++) {
    if (isInit(s)) {
      if (isBad(s)) return { safe: false, distance: 0 }
      if (dist[s] === -1) {
        dist[s] = 0
        queue.push(s)
      }
    }
  }
  let qi = 0
  while (qi < queue.length) {
    const s = queue[qi++]
    for (const t of succ(s)) {
      if (dist[t] === -1) {
        dist[t] = dist[s] + 1
        if (isBad(t)) return { safe: false, distance: dist[t] }
        queue.push(t)
      }
    }
  }
  return { safe: true, distance: -1 }
}

/**
 * Check that `inv` is a genuine inductive invariant proving safety:
 *   Init ⟹ inv,   inv ∧ Trans ⟹ inv',   inv ⟹ ¬Bad.
 */
export function checkInvariant(ts: TransitionSystem, inv: Formula): boolean {
  const n = ts.stateBits
  const initOk = implies(n, ts.init, inv)
  const safeOk = implies(n, inv, fnot(ts.bad))
  // inv(cur) ∧ Trans(cur,next) ⟹ inv(next)
  const invNext = mapVars(inv, (v) => n + v)
  const consec = satModel(2 * n, [inv, ts.trans, fnot(invNext)]) === null
  return initOk && safeOk && consec
}

/** Verify a counterexample really walks Init → … → Bad through Trans. */
export function checkCounterexample(ts: TransitionSystem, cex: boolean[][]): boolean {
  const n = ts.stateBits
  if (cex.length === 0) return false
  const at = (s: boolean[], v: number) => s[v] ?? false
  if (!evalFormula(ts.init, (v) => at(cex[0], v))) return false
  if (!evalFormula(ts.bad, (v) => at(cex[cex.length - 1], v))) return false
  for (let i = 0; i + 1 < cex.length; i++) {
    const cur = cex[i]
    const nxt = cex[i + 1]
    if (!evalFormula(ts.trans, (v) => (v <= n ? at(cur, v) : at(nxt, v - n)))) return false
  }
  return true
}
