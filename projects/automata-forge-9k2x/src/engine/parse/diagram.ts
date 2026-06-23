// Adapt an LR automaton to the shared `GraphModel` so the existing layered layout + pan/zoom/export
// SVG renderer draws the canonical item-set machine for free. A node is a state (its item set shown
// as the sub-label); an edge `I --X--> J` is the goto on grammar symbol X.

import type { GraphModel } from '../types'
import type { LrAutomaton } from './lr-items'
import { showItem } from './lr-items'

export interface LrGraph {
  graph: GraphModel
  /** Per-state multi-line item listing (for a side panel / tooltip). */
  itemText: string[]
}

export function lrToGraph(automaton: LrAutomaton): LrGraph {
  const withLa = automaton.kind !== 'LR0'
  const itemText = automaton.states.map((st) =>
    st.items.map((it) => showItem(automaton.aug, it, withLa)).join('\n'),
  )

  // Merge transition labels per (from,to) pair.
  const byPair = new Map<string, string[]>()
  for (const st of automaton.states) {
    for (const [X, to] of automaton.goto.get(st.id) ?? []) {
      const k = `${st.id} ${to}`
      const arr = byPair.get(k)
      if (arr) arr.push(X)
      else byPair.set(k, [X])
    }
  }
  const edges = [...byPair.entries()].map(([k, syms]) => {
    const [from, to] = k.split(' ').map(Number)
    return { from, to, label: syms.join(', ') }
  })

  // An "accepting" ring marks states that contain the augmented accept item S' -> S •.
  const accepting = new Set<number>()
  for (const st of automaton.states) {
    if (st.items.some((it) => it.prod === 0 && it.dot === automaton.aug.prods[0].rhs.length)) {
      accepting.add(st.id)
    }
  }

  const graph: GraphModel = {
    numStates: automaton.states.length,
    start: 0,
    accepting,
    edges,
    stateSub: automaton.states.map((st) => `I${st.id}`),
  }
  return { graph, itemText }
}
