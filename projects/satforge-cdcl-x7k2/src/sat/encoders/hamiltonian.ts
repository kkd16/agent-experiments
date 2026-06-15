// Hamiltonian cycle as SAT: find a closed tour that visits every vertex exactly once.
//
// Position-based encoding. x(v, p) is true iff vertex v occupies position p in the tour
// (p = 0..n-1, wrapping around so position n-1 is adjacent to position 0). Constraints:
//   • each position holds exactly one vertex,
//   • each vertex takes exactly one position,
//   • consecutive positions must be joined by an edge: if u is at p and w is at p+1 then
//     (u, w) is an edge — encoded by forbidding non-adjacent pairs in consecutive slots.

import type { CNF } from '../cnf'
import { CnfBuilder } from './util'
import type { Graph } from './graphColoring'

export interface HamiltonianSolution {
  numVertices: number
  /** tour[p] = the vertex at position p; positions wrap (tour is a cycle). */
  tour: number[]
}

export function encodeHamiltonian(g: Graph): {
  cnf: CNF
  decode: (model: boolean[]) => HamiltonianSolution
} {
  const n = g.numVertices
  const b = new CnfBuilder()
  // x(v, p): vertex v at position p.
  const x = (v: number, p: number) => v * n + p + 1
  b.reserve(n * n)
  b.comments.push(`Hamiltonian cycle: ${n} vertices, ${g.edges.length} edges`)

  // Adjacency lookup (undirected).
  const adj: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  for (const [a, c] of g.edges) {
    if (a === c) continue
    adj[a][c] = true
    adj[c][a] = true
  }

  // Each position holds exactly one vertex; each vertex takes exactly one position.
  for (let p = 0; p < n; p++) {
    const col: number[] = []
    for (let v = 0; v < n; v++) col.push(x(v, p))
    b.exactlyOne(col)
  }
  for (let v = 0; v < n; v++) {
    const row: number[] = []
    for (let p = 0; p < n; p++) row.push(x(v, p))
    b.exactlyOne(row)
  }

  // Forbid placing two non-adjacent vertices in consecutive positions (cycle wraps).
  for (let p = 0; p < n; p++) {
    const q = (p + 1) % n
    for (let u = 0; u < n; u++)
      for (let w = 0; w < n; w++) {
        if (u === w) continue
        if (!adj[u][w]) b.add(-x(u, p), -x(w, q))
      }
  }

  return {
    cnf: b.build(),
    decode: (model) => {
      const tour = new Array<number>(n).fill(-1)
      for (let p = 0; p < n; p++)
        for (let v = 0; v < n; v++) if (model[x(v, p)]) tour[p] = v
      return { numVertices: n, tour }
    },
  }
}
