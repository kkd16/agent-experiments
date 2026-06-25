// A small layered graph-layout engine (Sugiyama-style, minus the heavy machinery).
//
//  1. Rank every state by its BFS distance from the start state -> x position (left to right).
//  2. Order states within each rank, then run a few barycenter sweeps to reduce edge crossings.
//  3. Assign y positions from the final per-rank order.
//
// It's deterministic and good enough to make NFAs/DFAs of a few dozen states legible.

import type { GraphModel } from '../engine/types'

export interface Point {
  x: number
  y: number
}

export interface Layout {
  pos: Point[]
  width: number
  height: number
}

export interface LayoutOptions {
  dx?: number // horizontal gap between ranks
  dy?: number // vertical gap between states in a rank
  margin?: number
}

export function layout(graph: GraphModel, opts: LayoutOptions = {}): Layout {
  const dx = opts.dx ?? 130
  const dy = opts.dy ?? 84
  const margin = opts.margin ?? 56
  const n = graph.numStates

  // Adjacency (ignore self-loops for ranking/ordering).
  const out: number[][] = Array.from({ length: n }, () => [])
  const inc: number[][] = Array.from({ length: n }, () => [])
  for (const e of graph.edges) {
    if (e.from === e.to) continue
    out[e.from].push(e.to)
    inc[e.to].push(e.from)
  }

  // --- 1. BFS ranks from the start state(s) ---------------------------------
  // Most models have a single `start`; automata with several initial states (a Büchi automaton) seed
  // the BFS from all of them so each lands at rank 0 rather than being treated as unreachable.
  const rank = new Array<number>(n).fill(-1)
  const seeds = (graph.initial && graph.initial.length ? graph.initial : [graph.start]).filter(
    (s) => s >= 0 && s < n,
  )
  const queue: number[] = seeds.length ? [...seeds] : [graph.start]
  for (const s of queue) rank[s] = 0
  while (queue.length) {
    const s = queue.shift()!
    for (const t of out[s]) {
      if (rank[t] === -1) {
        rank[t] = rank[s] + 1
        queue.push(t)
      }
    }
  }
  // Any unreachable states (shouldn't happen post-prune) go in rank 0.
  let maxRank = 0
  for (let s = 0; s < n; s++) {
    if (rank[s] === -1) rank[s] = 0
    if (rank[s] > maxRank) maxRank = rank[s]
  }

  // --- 2. Group by rank, order, barycenter sweeps ---------------------------
  const ranks: number[][] = Array.from({ length: maxRank + 1 }, () => [])
  for (let s = 0; s < n; s++) ranks[rank[s]].push(s)
  // Stable initial order = ascending id.
  ranks.forEach((r) => r.sort((a, b) => a - b))

  const orderInRank = new Array<number>(n)
  const reindex = () => ranks.forEach((r) => r.forEach((s, i) => (orderInRank[s] = i)))
  reindex()

  const barycenter = (s: number, neighbors: number[][]): number => {
    const ns = neighbors[s]
    if (ns.length === 0) return orderInRank[s]
    let sum = 0
    for (const t of ns) sum += orderInRank[t]
    return sum / ns.length
  }

  for (let sweep = 0; sweep < 6; sweep++) {
    const downward = sweep % 2 === 0
    const order = downward
      ? [...Array(ranks.length).keys()]
      : [...Array(ranks.length).keys()].reverse()
    for (const r of order) {
      const neighbors = downward ? inc : out
      ranks[r] = ranks[r]
        .map((s) => ({ s, key: barycenter(s, neighbors) }))
        .sort((a, b) => a.key - b.key)
        .map((o) => o.s)
      reindex()
    }
  }

  // --- 3. Positions ---------------------------------------------------------
  const maxInRank = Math.max(1, ...ranks.map((r) => r.length))
  const fullHeight = (maxInRank - 1) * dy
  const pos: Point[] = new Array(n)
  ranks.forEach((r, ri) => {
    const colHeight = (r.length - 1) * dy
    const yOffset = (fullHeight - colHeight) / 2 // center each column vertically
    r.forEach((s, i) => {
      pos[s] = { x: margin + ri * dx, y: margin + yOffset + i * dy }
    })
  })

  return {
    pos,
    width: margin * 2 + maxRank * dx,
    height: margin * 2 + fullHeight,
  }
}
