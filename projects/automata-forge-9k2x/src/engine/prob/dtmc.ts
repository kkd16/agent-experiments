// The DTMC model-checking engine. Everything a PCTL formula needs over a Markov chain lives here:
// the graph pre-analysis (which states reach the goal at all / with certainty), exact unbounded
// reachability by a rational linear solve, step-bounded reachability by exact matrix iteration, the
// "next" operator, expected hitting times, and long-run (steady-state) probabilities via bottom SCCs.
//
// The naming follows the classic constrained-reachability question Pr(φ U ψ): stay inside φ-states
// until you hit a ψ-state. F ψ is the special case φ = true; that is what the marquee "probability of
// eventually reaching the goal" query compiles to.

import type { DTMC } from './types.ts'
import type { Frac } from './frac.ts'
import { F0, F1, fadd, fmul, ftoNumber } from './frac.ts'
import { solve } from './linalg.ts'

const ALL = (n: number): boolean[] => new Array<boolean>(n).fill(true)

/** Reverse adjacency: `pred[t]` lists every state with a positive-probability edge into `t`. */
export function predecessors(m: DTMC): number[][] {
  const pred: number[][] = Array.from({ length: m.n }, () => [])
  for (let s = 0; s < m.n; s++) for (const e of m.trans[s]) pred[e.to].push(s)
  return pred
}

/**
 * Constrained reachability set: the states from which a ψ-state is reachable along a path whose
 * interior stays in φ. These are exactly the states with Pr(φ U ψ) > 0. Backward fixpoint from ψ.
 */
export function constrainedReach(m: DTMC, phi: boolean[], psi: boolean[], pred = predecessors(m)): boolean[] {
  const reach = psi.slice()
  const work = [...psi.keys()].filter((s) => psi[s])
  while (work.length) {
    const t = work.pop() as number
    for (const s of pred[t]) {
      if (!reach[s] && phi[s]) {
        reach[s] = true
        work.push(s)
      }
    }
  }
  return reach
}

/** Pr(φ U ψ) = 0 states — the complement of constrained reachability. */
export function prob0(m: DTMC, phi: boolean[], psi: boolean[], pred = predecessors(m)): boolean[] {
  const reach = constrainedReach(m, phi, psi, pred)
  return reach.map((r) => !r)
}

/**
 * Pr(φ U ψ) = 1 states. A state has probability < 1 exactly when it can slip — with positive
 * probability, along a path staying in (φ ∧ ¬ψ) — into a Pr = 0 state. Backward fixpoint from the
 * no-set through (φ ∧ ¬ψ) predecessors; everything it cannot taint has probability 1.
 */
export function prob1(m: DTMC, phi: boolean[], psi: boolean[], pred = predecessors(m)): boolean[] {
  const no = prob0(m, phi, psi, pred)
  const tainted = no.slice()
  const work = [...no.keys()].filter((s) => no[s])
  while (work.length) {
    const t = work.pop() as number
    for (const s of pred[t]) {
      if (!tainted[s] && phi[s] && !psi[s]) {
        tainted[s] = true
        work.push(s)
      }
    }
  }
  return tainted.map((x) => !x)
}

/**
 * Exact Pr(φ U ψ) for every state, as rationals. ψ-states are 1, Pr = 0 states are 0, and the
 * remaining "maybe" states solve the linear system x_s = Σ_t P(s,t)·x_t (with the settled values
 * substituted) — one equation per maybe state, solved exactly over BigInt fractions.
 */
export function untilExact(m: DTMC, phi: boolean[], psi: boolean[]): Frac[] {
  const pred = predecessors(m)
  const reach = constrainedReach(m, phi, psi, pred)
  const out: Frac[] = new Array(m.n).fill(F0)
  for (let s = 0; s < m.n; s++) if (psi[s]) out[s] = F1

  const maybe: number[] = []
  const id = new Array<number>(m.n).fill(-1)
  for (let s = 0; s < m.n; s++) {
    if (reach[s] && !psi[s]) {
      id[s] = maybe.length
      maybe.push(s)
    }
  }
  if (maybe.length === 0) return out

  const k = maybe.length
  // A = I − P_maybe, one row per maybe state; b_i = Σ_{t∈ψ} P(s,t) (the settled ψ mass).
  const A: Frac[][] = Array.from({ length: k }, (_, i) => {
    const row = new Array<Frac>(k).fill(F0)
    row[i] = F1
    return row
  })
  const b: Frac[] = new Array(k).fill(F0)
  for (let i = 0; i < k; i++) {
    const s = maybe[i]
    for (const e of m.trans[s]) {
      const t = e.to
      if (psi[t]) b[i] = fadd(b[i], e.p)
      else if (id[t] >= 0) A[i][id[t]] = subFrac(A[i][id[t]], e.p)
    }
  }
  const x = solve(A, b)
  if (!x) return out // should not happen: the maybe system is non-singular by construction
  for (let i = 0; i < k; i++) out[maybe[i]] = x[i]
  return out
}

function gcdBig(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) [a, b] = [b, a % b]
  return a || 1n
}
function subFrac(a: Frac, b: Frac): Frac {
  const n = a.n * b.d - b.n * a.d
  const d = a.d * b.d
  const g = gcdBig(n, d) || 1n
  const sd = d < 0n ? -1n : 1n
  return { n: (n / g) * sd, d: (d / g) * sd }
}

/** Exact Pr(F ψ) — eventually reach ψ (unconstrained). */
export function reachExact(m: DTMC, psi: boolean[]): Frac[] {
  return untilExact(m, ALL(m.n), psi)
}

/**
 * Floating-point Pr(φ U ψ) by value iteration — the least fixed point of x_s = ψ ? 1 : (¬φ ? 0 :
 * Σ P(s,t) x_t), reached from below. This is the STRUCTURALLY INDEPENDENT witness the Verify tab pins
 * against the exact rational solve: two engines that share no arithmetic, one answer.
 */
export function untilFloat(m: DTMC, phi: boolean[], psi: boolean[], maxIter = 100000, tol = 1e-12): { value: number[]; iters: number } {
  let x = new Array<number>(m.n).fill(0)
  for (let s = 0; s < m.n; s++) if (psi[s]) x[s] = 1
  const P: { to: number; p: number }[][] = m.trans.map((d) => d.map((e) => ({ to: e.to, p: ftoNumber(e.p) })))
  let iters = 0
  for (; iters < maxIter; iters++) {
    const next = new Array<number>(m.n)
    let delta = 0
    for (let s = 0; s < m.n; s++) {
      let v: number
      if (psi[s]) v = 1
      else if (!phi[s]) v = 0
      else {
        v = 0
        for (const e of P[s]) v += e.p * x[e.to]
      }
      next[s] = v
      const d = Math.abs(v - x[s])
      if (d > delta) delta = d
    }
    x = next
    if (delta < tol) {
      iters++
      break
    }
  }
  return { value: x, iters }
}

export function reachFloat(m: DTMC, psi: boolean[]): { value: number[]; iters: number } {
  return untilFloat(m, ALL(m.n), psi)
}

/** Exact step-bounded Pr(φ U^{≤k} ψ) for every state — k exact matrix–vector products. */
export function boundedUntilExact(m: DTMC, phi: boolean[], psi: boolean[], k: number): Frac[] {
  let x: Frac[] = new Array(m.n).fill(F0)
  for (let s = 0; s < m.n; s++) if (psi[s]) x[s] = F1
  for (let step = 0; step < k; step++) {
    const next: Frac[] = new Array(m.n).fill(F0)
    for (let s = 0; s < m.n; s++) {
      if (psi[s]) {
        next[s] = F1
        continue
      }
      if (!phi[s]) {
        next[s] = F0
        continue
      }
      let acc = F0
      for (const e of m.trans[s]) acc = fadd(acc, fmul(e.p, x[e.to]))
      next[s] = acc
    }
    x = next
  }
  return x
}

/** Exact Pr(X ψ) — the probability the very next state satisfies ψ. */
export function nextExact(m: DTMC, psi: boolean[]): Frac[] {
  const out: Frac[] = new Array(m.n).fill(F0)
  for (let s = 0; s < m.n; s++) {
    let acc = F0
    for (const e of m.trans[s]) if (psi[e.to]) acc = fadd(acc, e.p)
    out[s] = acc
  }
  return out
}

/**
 * Exact expected number of steps to reach `target`, or `null` for states that do not reach it with
 * probability 1 (expectation ∞). E_s = 0 on the target, else 1 + Σ P(s,t) E_t; solved exactly over the
 * states that reach the target almost surely (whose successors are all such states, so the system closes).
 */
export function expectedStepsExact(m: DTMC, target: boolean[]): (Frac | null)[] {
  const one = prob1(m, ALL(m.n), target)
  const out: (Frac | null)[] = new Array(m.n).fill(null)
  for (let s = 0; s < m.n; s++) if (target[s]) out[s] = F0

  const maybe: number[] = []
  const id = new Array<number>(m.n).fill(-1)
  for (let s = 0; s < m.n; s++) {
    if (one[s] && !target[s]) {
      id[s] = maybe.length
      maybe.push(s)
    }
  }
  if (maybe.length === 0) return out
  const k = maybe.length
  const A: Frac[][] = Array.from({ length: k }, (_, i) => {
    const row = new Array<Frac>(k).fill(F0)
    row[i] = F1
    return row
  })
  const b: Frac[] = new Array(k).fill(F1)
  for (let i = 0; i < k; i++) {
    const s = maybe[i]
    for (const e of m.trans[s]) {
      if (id[e.to] >= 0) A[i][id[e.to]] = subFrac(A[i][id[e.to]], e.p)
    }
  }
  const x = solve(A, b)
  if (!x) return out
  for (let i = 0; i < k; i++) out[maybe[i]] = x[i]
  return out
}

// ---------------------------------------------------------------------------
// Long-run / steady-state analysis via bottom strongly-connected components.
// ---------------------------------------------------------------------------

/** Tarjan's SCCs of the chain's underlying digraph, as lists of state indices. */
export function sccs(m: DTMC): number[][] {
  const index = new Array<number>(m.n).fill(-1)
  const low = new Array<number>(m.n).fill(0)
  const onStack = new Array<boolean>(m.n).fill(false)
  const stack: number[] = []
  const comps: number[][] = []
  let idx = 0
  for (let s0 = 0; s0 < m.n; s0++) {
    if (index[s0] !== -1) continue
    const work: { v: number; i: number }[] = [{ v: s0, i: 0 }]
    index[s0] = low[s0] = idx++
    stack.push(s0)
    onStack[s0] = true
    while (work.length) {
      const top = work[work.length - 1]
      const v = top.v
      if (top.i < m.trans[v].length) {
        const w = m.trans[v][top.i++].to
        if (index[w] === -1) {
          index[w] = low[w] = idx++
          stack.push(w)
          onStack[w] = true
          work.push({ v: w, i: 0 })
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w])
        }
      } else {
        if (low[v] === index[v]) {
          const comp: number[] = []
          for (;;) {
            const w = stack.pop() as number
            onStack[w] = false
            comp.push(w)
            if (w === v) break
          }
          comps.push(comp)
        }
        work.pop()
        if (work.length) {
          const parent = work[work.length - 1].v
          low[parent] = Math.min(low[parent], low[v])
        }
      }
    }
  }
  return comps
}

/** The bottom SCCs (no transition leaves the component) — the chain's long-run "traps". */
export function bsccs(m: DTMC): number[][] {
  const out: number[][] = []
  for (const comp of sccs(m)) {
    const set = new Set(comp)
    let bottom = true
    for (const v of comp) {
      for (const e of m.trans[v]) {
        if (!set.has(e.to)) {
          bottom = false
          break
        }
      }
      if (!bottom) break
    }
    if (bottom) out.push(comp)
  }
  return out
}

/**
 * The exact stationary distribution of one bottom SCC: the unique π with π = πP over the component
 * and Σπ = 1. Solved by replacing one balance equation with the normalisation row.
 */
export function stationaryOfBSCC(m: DTMC, comp: number[]): Frac[] {
  const k = comp.length
  const id = new Map<number, number>()
  comp.forEach((s, i) => id.set(s, i))
  // Balance: for each j, π_j = Σ_i π_i P(i,j)  ⇒  Σ_i π_i P(i,j) − π_j = 0.
  // Build A (k×k), row j is that equation; replace the last row with Σ π = 1.
  const A: Frac[][] = Array.from({ length: k }, () => new Array<Frac>(k).fill(F0))
  const b: Frac[] = new Array(k).fill(F0)
  for (let j = 0; j < k; j++) {
    A[j][j] = subFrac(A[j][j], F1)
    const sj = comp[j]
    for (let i = 0; i < k; i++) {
      const si = comp[i]
      for (const e of m.trans[si]) if (e.to === sj) A[j][i] = fadd(A[j][i], e.p)
    }
  }
  for (let i = 0; i < k; i++) A[k - 1][i] = F1
  b[k - 1] = F1
  const x = solve(A, b)
  if (!x) return new Array(k).fill(F0)
  return x
}

/**
 * Exact long-run (steady-state) probability of being in `target`, per starting state. It is the sum
 * over bottom SCCs of Pr(absorbed into that BSCC) times the BSCC's stationary mass on target — the
 * classic decomposition PRISM reports as S=? [ target ].
 */
export function steadyStateExact(m: DTMC, target: boolean[]): Frac[] {
  const comps = bsccs(m)
  const out: Frac[] = new Array(m.n).fill(F0)
  for (const comp of comps) {
    const inComp = new Array<boolean>(m.n).fill(false)
    for (const s of comp) inComp[s] = true
    const absorb = reachExact(m, inComp) // Pr(reach this BSCC) from each state (BSCCs are absorbing)
    const pi = stationaryOfBSCC(m, comp)
    let mass = F0
    comp.forEach((s, i) => {
      if (target[s]) mass = fadd(mass, pi[i])
    })
    if (mass.n === 0n) continue
    for (let s = 0; s < m.n; s++) out[s] = fadd(out[s], fmul(absorb[s], mass))
  }
  return out
}
