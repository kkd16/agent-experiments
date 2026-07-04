// The positive dependency graph — the structure that explains *where* loop
// formulas come from.
//
// Draw an edge a → b whenever some rule that can derive a has b in its
// *positive* body. The strongly-connected components of this graph are exactly
// the program's positive loops, and a deep theorem (Fages 1994) ties them to the
// solver: a program with no positive loop is **tight**, and for a tight program
// Clark's completion already characterises the answer sets — so the unfounded
// check never fires and no loop formula is ever needed. Every unfounded set the
// solver can encounter lives entirely inside these SCCs. This module computes the
// graph, its SCCs (iterative Tarjan), the loop components and a layered layout
// for the studio's SVG, and `selfcheck.ts` cross-checks all of it — including the
// tightness ⇒ zero-loop-formulas prediction against the live solver.

import type { GroundProgram } from './program'

export interface DepEdge {
  from: number
  to: number
}

export interface DepGraph {
  /** atom ids that appear as a head somewhere or are depended upon. */
  nodes: number[]
  edges: DepEdge[]
  /** sccOf[atom] = its SCC index (0-based), or -1 for atoms not in the graph. */
  sccOf: number[]
  /** SCC index -> its atom ids. */
  sccs: number[][]
  /** SCC indices that are loops: size > 1, or a single atom with a self-edge. */
  loops: number[]
  /** SCC indices in topological order of the condensation (sources first). */
  order: number[]
  /** True when the program is tight (no positive loop at all). */
  tight: boolean
}

/** Build the positive dependency graph of a ground program. */
export function positiveDependencyGraph(prog: GroundProgram): DepGraph {
  const N = prog.numAtoms
  const succ: Set<number>[] = Array.from({ length: N + 1 }, () => new Set<number>())
  const present = new Uint8Array(N + 1)
  for (const r of prog.rules) {
    if (r.kind === 'constraint') continue
    const heads = r.kind === 'normal' ? [r.head] : r.heads
    for (const h of heads) {
      present[h] = 1
      for (const p of r.pos) {
        present[p] = 1
        succ[h].add(p) // self-edges (a :- a) are kept — they are one-atom loops
      }
    }
  }
  const nodes: number[] = []
  for (let a = 1; a <= N; a++) if (present[a]) nodes.push(a)
  const edges: DepEdge[] = []
  for (let a = 1; a <= N; a++) for (const b of succ[a]) edges.push({ from: a, to: b })

  const { sccOf, sccs, order } = tarjan(N, succ)
  const loops: number[] = []
  for (let i = 0; i < sccs.length; i++) {
    const members = sccs[i]
    if (members.length > 1) loops.push(i)
    else {
      const a = members[0]
      if (succ[a].has(a)) loops.push(i)
    }
  }
  return { nodes, edges, sccOf, sccs, loops, order, tight: loops.length === 0 }
}

/** Iterative Tarjan SCC over nodes 1..N (0 unused). Returns SCCs; `order` is the
 *  condensation in topological order (sources before targets). */
function tarjan(
  N: number,
  succ: Set<number>[],
): { sccOf: number[]; sccs: number[][]; order: number[] } {
  const index = new Int32Array(N + 1).fill(-1)
  const low = new Int32Array(N + 1)
  const onStack = new Uint8Array(N + 1)
  const sccOf = new Array<number>(N + 1).fill(-1)
  const sccs: number[][] = []
  const stack: number[] = []
  let counter = 0

  // Tarjan discovers SCCs in reverse topological order; we reverse at the end.
  for (let s = 1; s <= N; s++) {
    if (index[s] !== -1) continue
    // explicit DFS stack of frames {node, iterator position}
    const work: { v: number; it: number; nbrs: number[] }[] = [{ v: s, it: 0, nbrs: [...succ[s]] }]
    index[s] = low[s] = counter++
    stack.push(s)
    onStack[s] = 1
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const v = frame.v
      if (frame.it < frame.nbrs.length) {
        const w = frame.nbrs[frame.it++]
        if (index[w] === -1) {
          index[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = 1
          work.push({ v: w, it: 0, nbrs: [...succ[w]] })
        } else if (onStack[w]) {
          if (index[w] < low[v]) low[v] = index[w]
        }
      } else {
        // done with v: if it is a root, pop an SCC
        if (low[v] === index[v]) {
          const comp: number[] = []
          for (;;) {
            const w = stack.pop()!
            onStack[w] = 0
            sccOf[w] = sccs.length
            comp.push(w)
            if (w === v) break
          }
          comp.sort((a, b) => a - b)
          sccs.push(comp)
        }
        work.pop()
        if (work.length > 0) {
          const parent = work[work.length - 1].v
          if (low[v] < low[parent]) low[parent] = low[v]
        }
      }
    }
  }
  // sccs are in reverse topological order → topological order is the reverse.
  const order: number[] = []
  for (let i = sccs.length - 1; i >= 0; i--) order.push(i)
  return { sccOf, sccs, order }
}

export interface NodePos {
  atom: number
  x: number
  y: number
  scc: number
  loop: boolean
}
export interface DepLayout {
  nodes: NodePos[]
  edges: DepEdge[]
  width: number
  height: number
  loopCount: number
}

/** A layered layout: SCCs are placed in columns by condensation depth (longest
 *  path from a source), atoms stacked within each column. Good enough for the
 *  small programs a studio grounds; keeps loop members visually clustered. */
export function layoutDepGraph(g: DepGraph): DepLayout {
  const colW = 150
  const rowH = 46
  const padX = 40
  const padY = 34
  const loopSet = new Set(g.loops)

  // longest-path layering over the condensation (sources at depth 0).
  const depth = new Array<number>(g.sccs.length).fill(0)
  // adjacency between SCCs
  const sccAdj: Set<number>[] = Array.from({ length: g.sccs.length }, () => new Set<number>())
  for (const e of g.edges) {
    const a = g.sccOf[e.from]
    const b = g.sccOf[e.to]
    if (a !== b) sccAdj[a].add(b)
  }
  for (const i of g.order) {
    for (const j of sccAdj[i]) if (depth[i] + 1 > depth[j]) depth[j] = depth[i] + 1
  }
  const maxDepth = depth.reduce((m, d) => Math.max(m, d), 0)

  // group atoms by column, then stack.
  const byCol: number[][] = Array.from({ length: maxDepth + 1 }, () => [])
  for (let i = 0; i < g.sccs.length; i++) for (const a of g.sccs[i]) byCol[depth[i]].push(a)

  const pos = new Map<number, NodePos>()
  let maxRows = 1
  byCol.forEach((atoms, col) => {
    atoms.sort((a, b) => g.sccOf[a] - g.sccOf[b] || a - b)
    maxRows = Math.max(maxRows, atoms.length)
    atoms.forEach((atom, row) => {
      pos.set(atom, {
        atom,
        x: padX + col * colW,
        y: padY + row * rowH,
        scc: g.sccOf[atom],
        loop: loopSet.has(g.sccOf[atom]),
      })
    })
  })

  return {
    nodes: [...pos.values()],
    edges: g.edges,
    width: padX * 2 + maxDepth * colW + 60,
    height: padY * 2 + (maxRows - 1) * rowH + 30,
    loopCount: g.loops.length,
  }
}
