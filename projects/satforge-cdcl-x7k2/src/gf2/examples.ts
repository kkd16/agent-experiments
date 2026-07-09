// Curated & generated XOR problems for the studio — chosen to show off exactly
// where linear reasoning wins.
//
//   • **Tseitin parity formulas** over a graph: one XOR per vertex (the incident
//     edges XOR to that vertex's charge). Because every edge touches two
//     vertices, summing all the equations cancels every variable — so the whole
//     system is satisfiable **iff the total charge is even**. That gives a free,
//     independent oracle for the answer, and over a well-connected graph these
//     are the textbook formulas that need *exponential* resolution (hence CDCL)
//     yet fall to Gaussian elimination in a single reduction.
//   • **Random k-XOR-SAT**, the parity analogue of random k-SAT, with its own
//     sharp satisfiability threshold.
//   • **Parity chains** — a minimal, scalable UNSAT/SAT family for the head-to-head.
//
// All generators are seeded (mulberry32) so every instance is reproducible.

import type { XorCnf, XorClause } from './xor'
import { makeXor } from './xor'

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

export interface Graph {
  n: number
  edges: [number, number][]
}

/**
 * A connected random graph on `n` vertices: a spanning path for connectivity,
 * then extra random edges up to roughly `degree · n / 2` total. More edges (a
 * denser, better-expanding graph) makes the Tseitin formula harder for
 * resolution while leaving Gaussian elimination untouched.
 */
export function randomConnectedGraph(n: number, degree: number, seed: number): Graph {
  const rng = mulberry32(seed)
  const edgeSet = new Set<string>()
  const edges: [number, number][] = []
  const add = (a: number, b: number) => {
    if (a === b) return
    const key = a < b ? `${a},${b}` : `${b},${a}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push(a < b ? [a, b] : [b, a])
  }
  // A random spanning tree (each new vertex attaches to an earlier one).
  const order = [...Array(n).keys()]
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  for (let i = 1; i < n; i++) add(order[i], order[Math.floor(rng() * i)])
  // Extra edges toward the target average degree.
  const target = Math.floor((degree * n) / 2)
  let guard = 0
  while (edges.length < target && guard++ < target * 20) {
    add(Math.floor(rng() * n), Math.floor(rng() * n))
  }
  return { n, edges }
}

export interface TseitinResult {
  problem: XorCnf
  /** The charge assigned to each vertex (its equation's rhs). */
  charges: number[]
  /** Satisfiable iff the total charge is even — an independent oracle. */
  satisfiable: boolean
  graph: Graph
}

/**
 * Build a Tseitin parity formula over `graph`. Variables are edges (1-based in
 * edge order). Each vertex v contributes `⊕ (edges at v) = charge[v]`. If
 * `odd` is true we force an odd total charge (guaranteeing UNSAT); otherwise we
 * pick an even total (SAT). This is a *pure* XOR problem — no ordinary clauses.
 */
export function tseitinFormula(graph: Graph, odd: boolean, seed: number): TseitinResult {
  const rng = mulberry32(seed)
  const m = graph.edges.length
  const incident: number[][] = Array.from({ length: graph.n }, () => [])
  graph.edges.forEach(([a, b], e) => {
    incident[a].push(e + 1)
    incident[b].push(e + 1)
  })
  const charges = new Array<number>(graph.n).fill(0)
  let total = 0
  for (let v = 0; v < graph.n; v++) {
    charges[v] = rng() < 0.5 ? 1 : 0
    total ^= charges[v]
  }
  // Fix the total-charge parity to the requested value by flipping one vertex.
  if ((total & 1) !== (odd ? 1 : 0)) {
    charges[0] ^= 1
    total ^= 1
  }
  const xors: XorClause[] = []
  for (let v = 0; v < graph.n; v++) {
    if (incident[v].length === 0) continue
    xors.push(makeXor(incident[v], charges[v]))
  }
  return {
    problem: { numVars: m, clauses: [], xors, comments: [`Tseitin formula, ${graph.n} vertices, ${m} edges`] },
    charges,
    satisfiable: (total & 1) === 0,
    graph,
  }
}

/**
 * Uniform random k-XOR-SAT: `m` parity constraints, each over `k` distinct
 * variables drawn from `n`, with a random right-hand side. The parity analogue
 * of random k-SAT — a genuinely random linear system whose consistency is
 * whatever the dice say (and always answerable in closed form by rank).
 */
export function randomKXorSat(n: number, m: number, k: number, seed: number): XorCnf {
  const rng = mulberry32(seed)
  const xors: XorClause[] = []
  for (let i = 0; i < m; i++) {
    const vs = new Set<number>()
    let guard = 0
    while (vs.size < Math.min(k, n) && guard++ < 100) vs.add(1 + Math.floor(rng() * n))
    xors.push(makeXor([...vs], rng() < 0.5 ? 1 : 0))
  }
  return { numVars: n, clauses: [], xors, comments: [`random ${k}-XOR-SAT, n=${n}, m=${m}`] }
}

/**
 * A minimal parity chain on `n` variables: `x₁⊕x₂=1, x₂⊕x₃=1, …` plus a closing
 * equation. With an even number of links the closing parity can be made
 * contradictory (UNSAT) or consistent (SAT). Small, scalable, and a clean
 * demonstration that clause search chases its tail while one reduction settles it.
 */
export function parityChain(n: number, unsat: boolean): XorCnf {
  const xors: XorClause[] = []
  for (let i = 1; i < n; i++) xors.push(makeXor([i, i + 1], 1))
  // Closing link x_n ⊕ x_1 = c. The chain forces x_1 ⊕ x_n = (n-1) mod 2;
  // choosing the opposite makes it UNSAT.
  const forced = (n - 1) & 1
  xors.push(makeXor([n, 1], unsat ? forced ^ 1 : forced))
  return { numVars: n, clauses: [], xors, comments: [`parity chain n=${n}, ${unsat ? 'UNSAT' : 'SAT'}`] }
}

export interface Gf2Example {
  name: string
  blurb: string
  make: () => XorCnf
}

/** The example menu shown in the studio. */
export const GF2_EXAMPLES: Gf2Example[] = [
  {
    name: 'Parity chain (SAT)',
    blurb: 'A ring of x⊕x=1 links that closes consistently — one reduction settles it.',
    make: () => parityChain(12, false),
  },
  {
    name: 'Parity chain (UNSAT)',
    blurb: 'The same ring closed with the wrong parity — a 0=1 contradiction Gauss spots at once.',
    make: () => parityChain(12, true),
  },
  {
    name: 'Tseitin, even charge (SAT)',
    blurb: 'Edge-parity constraints on a graph with an even total charge — satisfiable, but exponential for resolution.',
    make: () => tseitinFormula(randomConnectedGraph(9, 3, 7), false, 7).problem,
  },
  {
    name: 'Tseitin, odd charge (UNSAT)',
    blurb: 'The classic hard-for-resolution formula: odd total charge makes it UNSAT, and only linear algebra sees it fast.',
    make: () => tseitinFormula(randomConnectedGraph(9, 3, 11), true, 11).problem,
  },
  {
    name: 'Random 3-XOR-SAT',
    blurb: 'The parity analogue of random 3-SAT — a random linear system, answered by rank.',
    make: () => randomKXorSat(14, 12, 3, 5),
  },
  {
    name: 'Overdetermined (UNSAT)',
    blurb: 'More independent parity equations than variables — almost surely inconsistent.',
    make: () => randomKXorSat(8, 14, 3, 3),
  },
]
