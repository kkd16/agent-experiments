// Curated 2-SAT examples + seeded generators for the studio and the self-test.

import type { CNF } from '../sat/cnf'

export interface TwoSatExample {
  name: string
  blurb: string
  cnf: CNF
}

/** A small deterministic PRNG (mulberry32) for reproducible random instances. */
export function mulberry32(seed: number): () => number {
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
 * A random 2-CNF: `m` distinct, non-tautological binary clauses over `n`
 * variables. Random 2-SAT has a sharp satisfiability threshold at the
 * clause/variable ratio m/n = 1 (Chvátal–Reed / Goerdt), which the studio's
 * phase-transition explorer draws live.
 */
export function randomTwoSat(n: number, m: number, seed: number): CNF {
  const rng = mulberry32(seed)
  const clauses: number[][] = []
  const seen = new Set<string>()
  let guard = 0
  const maxClauses = 2 * n * (2 * n - 1) // distinct unordered binary clauses available
  const target = Math.min(m, maxClauses)
  while (clauses.length < target && guard < target * 50 + 200) {
    guard++
    let a = 1 + Math.floor(rng() * n)
    let b = 1 + Math.floor(rng() * n)
    if (a === b) continue // avoid (x ∨ x) and the tautology (x ∨ ¬x)
    if (rng() < 0.5) a = -a
    if (rng() < 0.5) b = -b
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = `${lo},${hi}`
    if (seen.has(key)) continue
    seen.add(key)
    clauses.push([a, b])
  }
  return { numVars: n, clauses }
}

/**
 * Encode graph 2-colouring as 2-SAT: variable v_i true ⇒ vertex i is colour A.
 * Every edge (i,j) forbids equal colours: (¬xi ∨ ¬xj) ∧ (xi ∨ xj). The formula
 * is satisfiable iff the graph is bipartite, so an odd cycle is the canonical
 * UNSAT witness.
 */
export function twoColoringCnf(n: number, edges: [number, number][]): CNF {
  const clauses: number[][] = []
  for (const [i, j] of edges) {
    const xi = i + 1
    const xj = j + 1
    clauses.push([-xi, -xj]) // not both colour A
    clauses.push([xi, xj]) // not both colour B
  }
  return { numVars: n, clauses }
}

/** A simple cycle graph on `n` vertices (edges i—i+1, wrapping). */
export function cycleEdges(n: number): [number, number][] {
  const edges: [number, number][] = []
  for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n])
  return edges
}

export const TWO_SAT_EXAMPLES: TwoSatExample[] = [
  {
    name: 'Implication chain',
    blurb:
      'A chain of implications x1 ⇒ x2 ⇒ x3 ⇒ x4 (each clause ¬xi ∨ xi+1) anchored by the unit (x1). ' +
      'Propagation forces every variable true — the whole chain is one path in the implication graph, and each node becomes part of the backbone.',
    cnf: {
      numVars: 4,
      clauses: [[1], [-1, 2], [-2, 3], [-3, 4]],
    },
  },
  {
    name: 'Equivalent literals',
    blurb:
      'x ⇔ y ⇔ z, written as the four implications (¬x∨y)(¬y∨x)(¬y∨z)(¬z∨y). The three variables collapse into one strongly-connected component — they are provably equal in every model, the substitution a real solver performs to shrink the formula.',
    cnf: {
      numVars: 3,
      clauses: [
        [-1, 2],
        [-2, 1],
        [-2, 3],
        [-3, 2],
      ],
    },
  },
  {
    name: 'Contradiction (UNSAT)',
    blurb:
      'All four combinations of two variables are forbidden: (x∨y)(x∨¬y)(¬x∨y)(¬x∨¬y). The implication graph closes x and ¬x into the same SCC — x ⇔ ¬x — which is the linear-time certificate of unsatisfiability.',
    cnf: {
      numVars: 2,
      clauses: [
        [1, 2],
        [1, -2],
        [-1, 2],
        [-1, -2],
      ],
    },
  },
  {
    name: 'Bipartite 2-colouring',
    blurb:
      'Graph 2-colouring as 2-SAT over a 6-cycle (an even cycle is bipartite). The formula is satisfiable and the model is a proper 2-colouring — vertices alternate between the two colours.',
    cnf: twoColoringCnf(6, cycleEdges(6)),
  },
  {
    name: 'Odd cycle (UNSAT)',
    blurb:
      'The same 2-colouring encoding over a 5-cycle. An odd cycle is not bipartite, so the 2-SAT instance is unsatisfiable — and the SCC test pinpoints exactly which variable equals its own negation.',
    cnf: twoColoringCnf(5, cycleEdges(5)),
  },
  {
    name: 'Forced backbone',
    blurb:
      'A satisfiable instance with several forced literals: a unit and one-way implications pin x1, x2 and x4 in every model, while x3 stays free. The backbone panel shows the implication path that forces each one.',
    cnf: {
      numVars: 4,
      clauses: [
        [1], // x1 forced true
        [-1, 2], // x1 ⇒ x2  ⇒ x2 forced true
        [3, 4], // x3 ∨ x4
        [-3, 4], // ¬x3 ⇒ x4, with x3∨x4 ⇒ x4 forced true
      ],
    },
  },
]
