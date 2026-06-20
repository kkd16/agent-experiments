// Encoders — combinatorial problems lowered to pseudo-Boolean instances. These are the
// showcases: several are 0/1 *optimization* problems (knapsack, set cover, dominating set)
// that PB expresses natively, and the pigeonhole family is the classic separation between
// resolution and cutting planes — PHPⁿ⁺¹ₙ is exponentially hard for the CDCL/resolution core
// but polynomial for this solver's cutting-plane learning.

import { Pbc, normalizeLinear, type SignedTerm } from './constraint'
import type { PbInstance } from './instance'

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

/**
 * Pigeonhole PHP(pigeons → holes): place every pigeon in some hole, at most one pigeon per
 * hole. UNSAT exactly when pigeons > holes. The headline cutting-plane benchmark.
 */
export function encodePigeonhole(pigeons: number, holes: number): PbInstance {
  const labels: string[] = ['']
  const id = (i: number, h: number) => (i - 1) * holes + h // 1-based variable
  for (let i = 1; i <= pigeons; i++) for (let h = 1; h <= holes; h++) labels[id(i, h)] = `p${i}_${h}`
  const constraints: Pbc[] = []
  // each pigeon in ≥ 1 hole
  for (let i = 1; i <= pigeons; i++) {
    const lits: number[] = []
    for (let h = 1; h <= holes; h++) lits.push(id(i, h))
    constraints.push(Pbc.fromClause(lits))
  }
  // each hole holds ≤ 1 pigeon
  for (let h = 1; h <= holes; h++) {
    const terms: SignedTerm[] = []
    for (let i = 1; i <= pigeons; i++) terms.push({ lit: id(i, h), coef: 1n })
    constraints.push(...normalizeLinear(terms, '<=', 1n))
  }
  return {
    numVars: pigeons * holes,
    constraints,
    labels,
    note: `${pigeons} pigeons into ${holes} holes — UNSAT iff ${pigeons} > ${holes}; cutting planes refute it in polynomial size.`,
  }
}

export interface KnapsackItem {
  weight: number
  value: number
}

/**
 * 0/1 knapsack: choose items maximizing total value subject to a weight capacity. Modelled as
 * minimizing the *negated* value (so the engine's minimization yields the maximum).
 */
export function encodeKnapsack(items: KnapsackItem[], capacity: number): PbInstance {
  const n = items.length
  const labels: string[] = ['']
  for (let i = 1; i <= n; i++) labels[i] = `take${i}`
  const weightTerms: SignedTerm[] = items.map((it, i) => ({ lit: i + 1, coef: BigInt(it.weight) }))
  const constraints = normalizeLinear(weightTerms, '<=', BigInt(capacity))
  const objective: SignedTerm[] = items.map((it, i) => ({ lit: i + 1, coef: BigInt(-it.value) }))
  return {
    numVars: n,
    constraints,
    objective,
    objConst: 0n,
    labels,
    note: `Knapsack: ${n} items, capacity ${capacity}. Maximize value (engine minimizes −value).`,
  }
}

/**
 * Minimum set cover: pick the fewest subsets so that every element of the universe is covered.
 * `sets[j]` is the list of elements (0-based) that subset j covers.
 */
export function encodeSetCover(universe: number, sets: number[][]): PbInstance {
  const m = sets.length
  const labels: string[] = ['']
  for (let j = 1; j <= m; j++) labels[j] = `S${j}`
  const constraints: Pbc[] = []
  for (let e = 0; e < universe; e++) {
    const lits: number[] = []
    for (let j = 0; j < m; j++) if (sets[j].includes(e)) lits.push(j + 1)
    constraints.push(Pbc.fromClause(lits)) // element e covered by ≥ 1 chosen set
  }
  const objective: SignedTerm[] = []
  for (let j = 1; j <= m; j++) objective.push({ lit: j, coef: 1n })
  return {
    numVars: m,
    constraints,
    objective,
    objConst: 0n,
    labels,
    note: `Set cover: ${universe} elements, ${m} sets. Minimize the number of sets chosen.`,
  }
}

export interface Graph {
  n: number
  edges: [number, number][] // 0-based vertex pairs
}

/**
 * Minimum dominating set: choose vertices so every vertex is chosen or adjacent to a chosen
 * one, minimizing the count. Each vertex v contributes `x_v + Σ_{u~v} x_u ≥ 1`.
 */
export function encodeDominatingSet(g: Graph): PbInstance {
  const adj: number[][] = Array.from({ length: g.n }, () => [])
  for (const [a, b] of g.edges) {
    adj[a].push(b)
    adj[b].push(a)
  }
  const labels: string[] = ['']
  for (let v = 1; v <= g.n; v++) labels[v] = `v${v}`
  const constraints: Pbc[] = []
  for (let v = 0; v < g.n; v++) {
    const lits = [v + 1, ...adj[v].map((u) => u + 1)]
    constraints.push(Pbc.fromClause(lits))
  }
  const objective: SignedTerm[] = []
  for (let v = 1; v <= g.n; v++) objective.push({ lit: v, coef: 1n })
  return {
    numVars: g.n,
    constraints,
    objective,
    objConst: 0n,
    labels,
    note: `Dominating set on ${g.n} vertices / ${g.edges.length} edges. Minimize chosen vertices.`,
  }
}

/** A random feasible-ish PB instance for the studio's "Random" source. */
export function randomPb(seed: number, n: number, m: number, maxCoef = 4): PbInstance {
  const rng = mulberry32(seed)
  const constraints: Pbc[] = []
  for (let i = 0; i < m; i++) {
    const k = 2 + Math.floor(rng() * Math.max(1, n - 1))
    const used = new Set<number>()
    const terms: SignedTerm[] = []
    for (let j = 0; j < k; j++) {
      let v = 1 + Math.floor(rng() * n)
      while (used.has(v)) v = (v % n) + 1
      used.add(v)
      terms.push({ lit: (rng() < 0.5 ? 1 : -1) * v, coef: BigInt(1 + Math.floor(rng() * maxCoef)) })
    }
    const total = terms.reduce((s, t) => s + Number(t.coef > 0n ? t.coef : -t.coef), 0)
    const deg = BigInt(1 + Math.floor(rng() * Math.max(1, total - 1)))
    constraints.push(...normalizeLinear(terms, '>=', deg))
  }
  return { numVars: n, constraints, note: `Random PB: ${n} variables, ${m} constraints.` }
}

/** A small curated graph used by the dominating-set example. */
export const PETERSEN: Graph = {
  n: 10,
  edges: [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 0], // outer 5-cycle
    [5, 7], [7, 9], [9, 6], [6, 8], [8, 5], // inner pentagram
    [0, 5], [1, 6], [2, 7], [3, 8], [4, 9], // spokes
  ],
}
