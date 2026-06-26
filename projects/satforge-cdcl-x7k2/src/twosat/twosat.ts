// 2-SAT in linear time, on the binary implication graph.
//
// A 2-CNF clause (a ∨ b) is logically two implications: ¬a → b and ¬b → a.
// Collect them all into a directed graph over the 2n *literal* nodes and the
// whole satisfiability question collapses to strongly-connected components
// (Aspvall–Plass–Tarjan, 1979):
//
//   • the formula is UNSAT  iff  some variable v has v and ¬v in the SAME SCC
//     (then v → ¬v and ¬v → v, so v ↔ ¬v — a contradiction);
//   • otherwise a model is read straight off the SCC condensation: Tarjan emits
//     SCCs in reverse topological order, so set a literal TRUE when its SCC is
//     closer to a sink (smaller component id) than its negation's.
//
// On top of the decision this module also reports the structure the picture is
// made of: the equivalent-literal classes (each non-trivial SCC), the BACKBONE
// (literals forced in every model — exactly those ℓ with a path ¬ℓ →* ℓ) with a
// concrete implication-path witness, and the condensation DAG with a longest-
// path layering for drawing.
//
// Everything here is O(n + m): one Tarjan pass decides and assigns; the
// condensation reachability used for the backbone is over the (small) component
// DAG. The same SCC collapse is the kernel of equivalent-literal substitution
// in the preprocessor (src/preprocess), promoted here to a first-class,
// visual procedure and cross-checked against the full CDCL solver.

import type { CNF } from '../sat/cnf'

/** Node index of a DIMACS literal: var v>0 → 2(v−1), ¬v → 2(v−1)+1. */
export function litToNode(lit: number): number {
  const v = Math.abs(lit) - 1
  return lit > 0 ? 2 * v : 2 * v + 1
}

/** The DIMACS literal a node stands for (inverse of {@link litToNode}). */
export function nodeToLit(node: number): number {
  const v = (node >> 1) + 1
  return (node & 1) === 0 ? v : -v
}

/** The node of the negation of `node` (flips the polarity bit). */
export function negNode(node: number): number {
  return node ^ 1
}

export interface ImplEdge {
  /** Source literal node. */
  from: number
  /** Target literal node. */
  to: number
  /** Index of the binary/unit clause this implication came from. */
  clause: number
}

export interface Condensation {
  /** comps[c] = the literal nodes belonging to component c. */
  comps: number[][]
  /** adj[c] = the distinct components reachable from c in one step. */
  adj: number[][]
  /** A longest-path layer per component (sources at layer 0), for layout. */
  topoLayer: number[]
}

export interface Backbone {
  /** The forced literal (DIMACS), true in every model. */
  lit: number
  /** A witness path of literals ¬lit → … → lit proving it is forced. */
  path: number[]
}

export interface TwoSatResult {
  numVars: number
  sat: boolean
  /** 1-based truth values (model[v]); null when UNSAT. */
  model: boolean[] | null
  /** comp[node] = component id (Tarjan order: smaller = nearer a sink). */
  comp: Int32Array
  numComps: number
  /** Deduplicated implication edges over literal nodes. */
  edges: ImplEdge[]
  /** Unit clauses, as DIMACS literals (each contributes a ¬ℓ→ℓ edge). */
  units: number[]
  /** When UNSAT, a variable whose two polarities share an SCC. */
  conflictVar: number | null
  /** Non-trivial SCCs as lists of equivalent DIMACS literals (size ≥ 2). */
  equivClasses: number[][]
  /** Forced literals (the backbone) with implication-path witnesses. */
  backbones: Backbone[]
  condensation: Condensation
  stats: {
    nodes: number
    edges: number
    comps: number
    nontrivialComps: number
    backbones: number
  }
}

/** Is every clause of `cnf` of width ≤ 2 (a genuine 2-CNF)? */
export function is2Cnf(cnf: CNF): boolean {
  return cnf.clauses.every((c) => c.length <= 2)
}

/** The clauses of `cnf` that are too wide for 2-SAT (width > 2). */
export function wideClauses(cnf: CNF): number[][] {
  return cnf.clauses.filter((c) => c.length > 2)
}

/**
 * Iterative Tarjan SCC over `n` nodes with adjacency `adj`. Returns a component
 * id per node; ids increase in REVERSE topological order (a sink SCC gets the
 * smallest id), which is exactly what the 2-SAT model-extraction rule wants.
 */
function tarjanScc(n: number, adj: number[][]): { comp: Int32Array; count: number } {
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const comp = new Int32Array(n).fill(-1)
  const sccStack: number[] = []
  // Explicit DFS stack of frames {node, next-neighbour-index}.
  const call: { v: number; pi: number }[] = []
  let counter = 0
  let compCount = 0

  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue
    call.push({ v: s, pi: 0 })
    while (call.length > 0) {
      const frame = call[call.length - 1]
      const v = frame.v
      if (frame.pi === 0) {
        index[v] = low[v] = counter++
        sccStack.push(v)
        onStack[v] = 1
      }
      const nbrs = adj[v]
      if (frame.pi < nbrs.length) {
        const w = nbrs[frame.pi]
        frame.pi++
        if (index[w] === -1) {
          call.push({ v: w, pi: 0 })
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w]
        }
      } else {
        if (low[v] === index[v]) {
          // v is a root: pop its whole SCC.
          for (;;) {
            const w = sccStack.pop() as number
            onStack[w] = 0
            comp[w] = compCount
            if (w === v) break
          }
          compCount++
        }
        call.pop()
        if (call.length > 0) {
          const parent = call[call.length - 1].v
          if (low[v] < low[parent]) low[parent] = low[v]
        }
      }
    }
  }
  return { comp, count: compCount }
}

/** Reconstruct a shortest literal path src → dst in the implication graph, or null. */
function bfsPath(n: number, adj: number[][], src: number, dst: number): number[] | null {
  if (src === dst) return [nodeToLit(src)]
  const prev = new Int32Array(n).fill(-2)
  prev[src] = -1
  const queue = [src]
  let head = 0
  while (head < queue.length) {
    const u = queue[head++]
    for (const w of adj[u]) {
      if (prev[w] === -2) {
        prev[w] = u
        if (w === dst) {
          const path: number[] = []
          let cur = dst
          while (cur !== -1) {
            path.push(nodeToLit(cur))
            cur = prev[cur]
          }
          path.reverse()
          return path
        }
        queue.push(w)
      }
    }
  }
  return null
}

/**
 * Decide a 2-CNF and report the full implication-graph structure. Throws if the
 * formula contains a clause of width > 2 (it is not a 2-CNF).
 */
export function decide2Sat(cnf: CNF): TwoSatResult {
  const wide = wideClauses(cnf)
  if (wide.length > 0) {
    throw new Error(
      `not a 2-CNF: ${wide.length} clause${wide.length === 1 ? '' : 's'} have more than 2 literals`,
    )
  }
  const n = cnf.numVars
  const nodes = 2 * n
  const adj: number[][] = Array.from({ length: nodes }, () => [])
  const edgeSet = new Set<number>()
  const edges: ImplEdge[] = []
  const units: number[] = []
  let emptyClause = false

  const addEdge = (from: number, to: number, clause: number) => {
    adj[from].push(to)
    const key = from * nodes + to
    if (!edgeSet.has(key)) {
      edgeSet.add(key)
      edges.push({ from, to, clause })
    }
  }

  for (let ci = 0; ci < cnf.clauses.length; ci++) {
    const c = cnf.clauses[ci]
    if (c.length === 0) {
      emptyClause = true
      continue
    }
    if (c.length === 1) {
      // (a)  ≡  ¬a → a   (a unit forces a).
      const a = c[0]
      units.push(a)
      addEdge(litToNode(-a), litToNode(a), ci)
      continue
    }
    // (a ∨ b)  ≡  ¬a → b  and  ¬b → a.
    const [a, b] = c
    addEdge(litToNode(-a), litToNode(b), ci)
    addEdge(litToNode(-b), litToNode(a), ci)
  }

  const { comp, count } = tarjanScc(nodes, adj)

  // Decision: UNSAT iff v and ¬v share a component.
  let conflictVar: number | null = null
  for (let v = 1; v <= n; v++) {
    if (comp[litToNode(v)] === comp[litToNode(-v)]) {
      conflictVar = v
      break
    }
  }
  const sat = !emptyClause && conflictVar === null

  // Model: a literal is true when its SCC is nearer a sink (smaller id) than
  // its negation's. Ties cannot happen for a satisfiable formula.
  let model: boolean[] | null = null
  if (sat) {
    model = new Array(n + 1).fill(false)
    for (let v = 1; v <= n; v++) {
      model[v] = comp[litToNode(v)] < comp[litToNode(-v)]
    }
  }

  // Component membership lists + condensation adjacency.
  const comps: number[][] = Array.from({ length: count }, () => [])
  for (let node = 0; node < nodes; node++) comps[comp[node]].push(node)

  const condAdjSet: Set<number>[] = Array.from({ length: count }, () => new Set())
  for (const e of edges) {
    const cu = comp[e.from]
    const cw = comp[e.to]
    if (cu !== cw) condAdjSet[cu].add(cw)
  }
  const condAdj = condAdjSet.map((s) => [...s])

  // Longest-path layering of the condensation (a DAG) for drawing left→right.
  // Edges go cu → cw; process in topological order (decreasing Tarjan id, since
  // ids are reverse-topological) so a node's layer is set before its successors.
  const topoLayer = new Array(count).fill(0)
  const order = Array.from({ length: count }, (_, c) => c).sort((a, b) => b - a)
  for (const cu of order) {
    for (const cw of condAdj[cu]) {
      if (topoLayer[cu] + 1 > topoLayer[cw]) topoLayer[cw] = topoLayer[cu] + 1
    }
  }

  // Equivalent-literal classes: the non-trivial SCCs.
  const equivClasses: number[][] = []
  for (const members of comps) {
    if (members.length >= 2) {
      equivClasses.push(members.map(nodeToLit).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b))
    }
  }

  // Backbone: literal ℓ is forced TRUE iff ¬ℓ →* ℓ. With SAT guaranteed, ℓ and
  // ¬ℓ are in different components; report a literal-path witness for each.
  const backbones: Backbone[] = []
  if (sat) {
    const reach = condReachability(count, condAdj)
    for (let v = 1; v <= n; v++) {
      for (const lit of [v, -v]) {
        const cNeg = comp[litToNode(-lit)]
        const cPos = comp[litToNode(lit)]
        if (cNeg !== cPos && reach[cNeg].has(cPos)) {
          const path = bfsPath(nodes, adj, litToNode(-lit), litToNode(lit))
          if (path) backbones.push({ lit, path })
        }
      }
    }
    backbones.sort((a, b) => Math.abs(a.lit) - Math.abs(b.lit) || a.lit - b.lit)
  }

  const nontrivial = comps.filter((m) => m.length >= 2).length

  return {
    numVars: n,
    sat,
    model,
    comp,
    numComps: count,
    edges,
    units,
    conflictVar,
    equivClasses,
    backbones,
    condensation: { comps, adj: condAdj, topoLayer },
    stats: {
      nodes,
      edges: edges.length,
      comps: count,
      nontrivialComps: nontrivial,
      backbones: backbones.length,
    },
  }
}

/** Transitive reachability sets over the (small) condensation DAG. */
function condReachability(count: number, adj: number[][]): Set<number>[] {
  const reach: Set<number>[] = Array.from({ length: count }, () => new Set<number>())
  // Tarjan ids increase toward sources, so an edge c→w has id(c) > id(w): a
  // component's successors have SMALLER ids. Process in INCREASING id order so
  // every successor's reach set is final before we fold it into c's.
  for (let c = 0; c < count; c++) {
    for (const w of adj[c]) {
      reach[c].add(w)
      for (const r of reach[w]) reach[c].add(r)
    }
  }
  return reach
}

/** Convenience: just the SAT/UNSAT verdict (used by the phase-transition sweep). */
export function isSat2(cnf: CNF): boolean {
  return decide2Sat(cnf).sat
}

export interface BinaryCore {
  /** The 2-CNF of all unit and binary clauses (the implication-graph skeleton). */
  cnf: CNF
  /** How many wider clauses (width > 2) were dropped. */
  dropped: number
}

/**
 * The BINARY CORE of an arbitrary CNF: keep every unit and binary clause, drop
 * the wider ones. This is the sub-formula the implication graph is built from
 * even for general SAT, and it is a sound *one-way* test: if the binary core is
 * UNSAT then the whole formula is UNSAT (dropping clauses only weakens), but a
 * satisfiable core says nothing — the dropped clauses may still kill it.
 */
export function binaryCore(cnf: CNF): BinaryCore {
  const clauses: number[][] = []
  let dropped = 0
  for (const c of cnf.clauses) {
    if (c.length <= 2) clauses.push(c)
    else dropped++
  }
  return { cnf: { numVars: cnf.numVars, clauses }, dropped }
}
