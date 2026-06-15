// Problem → MaxSAT encoders, plus a tolerant WCNF (weighted-CNF) parser/serializer so
// real MaxSAT-competition benchmarks drop straight in.
import type { MaxSatInstance } from '../maxsat'

export interface WeightedGraph {
  numVertices: number
  edges: { u: number; v: number; w: number }[]
  /** Optional per-vertex weights (default 1) for weighted cover / independent set. */
  vertexWeights?: number[]
}

export interface MaxCutSolution {
  side: boolean[] // side[v] — which of the two partitions vertex v is on
  cutWeight: number // total weight of edges crossing the cut
  totalWeight: number
}

export interface VertexSubsetSolution {
  chosen: boolean[] // chosen[v] — vertex v is in the cover / independent set
  weight: number // total weight of the chosen vertices
}

const vw = (g: WeightedGraph, v: number) => g.vertexWeights?.[v] ?? 1

/**
 * Max-Cut: partition the vertices into two sides maximizing the weight of crossing edges.
 * Each edge {u,v,w} contributes two soft clauses (x_u ∨ x_v) and (¬x_u ∨ ¬x_v), each of
 * weight w: a *cut* edge satisfies both, an *uncut* edge violates exactly one. So the
 * minimum violated weight = totalWeight − maxCut.
 */
export function encodeMaxCut(g: WeightedGraph): {
  instance: MaxSatInstance
  totalWeight: number
  decode: (model: boolean[]) => MaxCutSolution
} {
  const soft = g.edges.flatMap(({ u, v, w }) => [
    { lits: [u + 1, v + 1], weight: w },
    { lits: [-(u + 1), -(v + 1)], weight: w },
  ])
  const totalWeight = g.edges.reduce((s, e) => s + e.w, 0)
  return {
    instance: { numVars: g.numVertices, hard: [], soft },
    totalWeight,
    decode: (model) => {
      const side = new Array<boolean>(g.numVertices)
      for (let v = 0; v < g.numVertices; v++) side[v] = !!model[v + 1]
      let cutWeight = 0
      for (const { u, v, w } of g.edges) if (side[u] !== side[v]) cutWeight += w
      return { side, cutWeight, totalWeight }
    },
  }
}

/**
 * Minimum (weighted) Vertex Cover: choose a smallest-weight set of vertices touching every
 * edge. Hard: each edge needs an endpoint (x_u ∨ x_v). Soft: each vertex prefers to be out
 * (¬x_v) at weight w_v. Minimum violated weight = the cover's weight.
 */
export function encodeVertexCover(g: WeightedGraph): {
  instance: MaxSatInstance
  decode: (model: boolean[]) => VertexSubsetSolution
} {
  const hard = g.edges.map(({ u, v }) => [u + 1, v + 1])
  const soft = Array.from({ length: g.numVertices }, (_, v) => ({ lits: [-(v + 1)], weight: vw(g, v) }))
  return { instance: { numVars: g.numVertices, hard, soft }, decode: (model) => chosenSubset(g, model) }
}

/**
 * Maximum (weighted) Independent Set: choose a largest-weight set of mutually non-adjacent
 * vertices. Hard: no edge inside the set (¬x_u ∨ ¬x_v). Soft: each vertex prefers to be in
 * (x_v) at weight w_v. Minimum violated weight = totalVertexWeight − maxWeight.
 */
export function encodeIndependentSet(g: WeightedGraph): {
  instance: MaxSatInstance
  decode: (model: boolean[]) => VertexSubsetSolution
} {
  const hard = g.edges.map(({ u, v }) => [-(u + 1), -(v + 1)])
  const soft = Array.from({ length: g.numVertices }, (_, v) => ({ lits: [v + 1], weight: vw(g, v) }))
  return { instance: { numVars: g.numVertices, hard, soft }, decode: (model) => chosenSubset(g, model) }
}

function chosenSubset(g: WeightedGraph, model: boolean[]): VertexSubsetSolution {
  const chosen = new Array<boolean>(g.numVertices)
  let weight = 0
  for (let v = 0; v < g.numVertices; v++) {
    chosen[v] = !!model[v + 1]
    if (chosen[v]) weight += vw(g, v)
  }
  return { chosen, weight }
}

/** A deterministic weighted random graph (seeded), for the encoders above. */
export function randomWeightedGraph(n: number, edgeProb: number, maxWeight: number, seed = 1): WeightedGraph {
  const rand = mulberry(seed)
  const edges: { u: number; v: number; w: number }[] = []
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (rand() < edgeProb) edges.push({ u: i, v: j, w: 1 + Math.floor(rand() * maxWeight) })
  return { numVertices: n, edges }
}

/** Random weighted MAX-2-SAT: `m` random 2-literal soft clauses over `n` variables. */
export function randomWeightedMax2Sat(n: number, m: number, maxWeight: number, seed = 1): MaxSatInstance {
  const rand = mulberry(seed)
  const soft = []
  for (let k = 0; k < m; k++) {
    const a = 1 + Math.floor(rand() * n)
    let b = 1 + Math.floor(rand() * n)
    while (b === a && n > 1) b = 1 + Math.floor(rand() * n)
    const la = rand() < 0.5 ? a : -a
    const lb = rand() < 0.5 ? b : -b
    soft.push({ lits: a === b ? [la] : [la, lb], weight: 1 + Math.floor(rand() * maxWeight) })
  }
  return { numVars: n, hard: [], soft }
}

function mulberry(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface WcnfParse {
  instance: MaxSatInstance
  top: number
  warnings: string[]
}

/**
 * Parse the WCNF format. Supports both the classic header form
 *   `p wcnf <nvars> <nclauses> <top>` with lines `<weight> l1 l2 … 0`
 * (a clause whose weight equals `top` is hard), and the newer headerless form where hard
 * clauses begin with `h` and soft clauses with their integer weight.
 */
export function parseWcnf(text: string): WcnfParse {
  const warnings: string[] = []
  const hard: number[][] = []
  const soft: { lits: number[]; weight: number }[] = []
  let top = Infinity
  let maxVar = 0
  let declaredVars = 0

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('c')) continue
    if (line.startsWith('p')) {
      const parts = line.split(/\s+/)
      if (parts[1] === 'wcnf') {
        declaredVars = Number(parts[2]) || 0
        if (parts.length >= 5) top = Number(parts[4])
      }
      continue
    }
    const toks = line.split(/\s+/)
    let isHard: boolean
    let weight = 0
    let rest: string[]
    if (toks[0] === 'h') {
      isHard = true
      rest = toks.slice(1)
    } else {
      weight = Number(toks[0])
      if (!Number.isFinite(weight)) {
        warnings.push(`skipped malformed line: "${line}"`)
        continue
      }
      isHard = Number.isFinite(top) && weight >= top
      rest = toks.slice(1)
    }
    const lits: number[] = []
    for (const t of rest) {
      const n = Number(t)
      if (n === 0) break
      if (!Number.isInteger(n)) {
        warnings.push(`non-integer literal "${t}" ignored`)
        continue
      }
      lits.push(n)
      if (Math.abs(n) > maxVar) maxVar = Math.abs(n)
    }
    if (isHard) hard.push(lits)
    else if (weight > 0) soft.push({ lits, weight })
  }

  const numVars = Math.max(declaredVars, maxVar)
  if (!Number.isFinite(top)) top = soft.reduce((s, c) => s + c.weight, 0) + 1
  return { instance: { numVars, hard, soft }, top, warnings }
}

/** Serialize a MaxSAT instance back to classic WCNF text. */
export function toWcnf(inst: MaxSatInstance, top?: number): string {
  const t = top ?? inst.soft.reduce((s, c) => s + c.weight, 0) + 1
  const out: string[] = [`p wcnf ${inst.numVars} ${inst.hard.length + inst.soft.length} ${t}`]
  for (const c of inst.hard) out.push(`${t} ${c.join(' ')} 0`)
  for (const s of inst.soft) out.push(`${s.weight} ${s.lits.join(' ')} 0`)
  return out.join('\n') + '\n'
}
