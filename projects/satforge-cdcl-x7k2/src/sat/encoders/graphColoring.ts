// Graph k-coloring as SAT: assign one of k colors to each vertex so that no
// edge joins two equally-colored vertices.
import type { CNF } from '../cnf'
import { CnfBuilder } from './util'

export interface Graph {
  numVertices: number
  edges: [number, number][] // 0-based vertex pairs
}

export interface ColoringSolution {
  numVertices: number
  k: number
  colors: number[] // colors[v] in 0..k-1, or -1
}

export function encodeGraphColoring(
  g: Graph,
  k: number,
): { cnf: CNF; decode: (model: boolean[]) => ColoringSolution } {
  const b = new CnfBuilder()
  const n = g.numVertices
  // x(v,c): vertex v has color c (c in 0..k-1).
  const v = (vertex: number, color: number) => vertex * k + color + 1
  b.reserve(n * k)
  b.comments.push(`Graph ${k}-coloring: ${n} vertices, ${g.edges.length} edges`)

  for (let vtx = 0; vtx < n; vtx++) {
    const opts: number[] = []
    for (let c = 0; c < k; c++) opts.push(v(vtx, c))
    b.atLeastOne(opts)
    b.atMostOnePairwise(opts) // each vertex gets exactly one color
  }
  for (const [a, c2] of g.edges)
    for (let color = 0; color < k; color++) b.add(-v(a, color), -v(c2, color))

  return {
    cnf: b.build(),
    decode: (model) => {
      const colors = new Array<number>(n).fill(-1)
      for (let vtx = 0; vtx < n; vtx++)
        for (let c = 0; c < k; c++) if (model[v(vtx, c)]) colors[vtx] = c
      return { numVertices: n, k, colors }
    },
  }
}

/** A deterministic Erdős–Rényi-style random graph (seeded). */
export function randomGraph(n: number, edgeProb: number, seed = 1): Graph {
  let s = seed >>> 0
  const rand = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 100000) / 100000
  }
  const edges: [number, number][] = []
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) if (rand() < edgeProb) edges.push([i, j])
  return { numVertices: n, edges }
}
