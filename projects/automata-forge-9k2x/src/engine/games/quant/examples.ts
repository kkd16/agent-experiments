// Curated weighted arenas — one hand-drawn quantitative game per idea, each with a story the
// mean-payoff values make visible. Every example's stated values are re-derived and cross-checked
// in the Verify harness (value iteration ≡ brute force), so nothing here is asserted on faith.

import type { WArena, Player } from './types'
import type { WEdge } from './rational'

export interface WExample {
  id: string
  name: string
  blurb: string
  arena: WArena
}

interface Spec {
  owner: number[]
  /** edges[v] = list of [to, weight]. */
  edges: [number, number][][]
  labels?: string[]
  pos: [number, number][]
}

function build(s: Spec): WArena {
  const n = s.owner.length
  const out: WEdge[][] = s.edges.map((es) => es.map(([to, w]) => ({ to, w })))
  return {
    n,
    owner: s.owner.map((o) => o as Player),
    out,
    labels: s.labels ?? Array.from({ length: n }, (_, i) => String(i)),
    pos: s.pos.map(([x, y]) => ({ x, y })),
  }
}

export const QUANT_EXAMPLES: WExample[] = [
  {
    id: 'tempting-detour',
    name: 'The tempting detour',
    blurb:
      'Max (circles) starts at s. The fat +3 edge to the left looks best — but it hands the token to Min (squares), ' +
      'who loops on −4 forever. The dull −1 edge to the right reaches a +1 self-loop Max controls. Optimal play ' +
      'walks away from the shiny reward: ν(s)=+1, not −4. Long-run average, not the next step, is what a value sees.',
    arena: build({
      owner: [0, 1, 0],
      edges: [
        [[1, 3], [2, -1]],
        [[1, -4]],
        [[2, 1]],
      ],
      labels: ['s', 'trap', 'safe'],
      pos: [
        [20, 50],
        [78, 22],
        [78, 78],
      ],
    }),
  },
  {
    id: 'battle-of-averages',
    name: 'Battle of averages',
    blurb:
      'A four-vertex ring where Max and Min alternate control and both have a real choice every move. Neither can ' +
      'force a pure cycle; the value is the equilibrium average the two optimal positional strategies settle into. ' +
      'Solve it and read ν off each node, then watch both strategies (bold arrows) realise exactly that number.',
    arena: build({
      owner: [0, 1, 0, 1],
      edges: [
        [[1, 1], [3, -1]],
        [[0, 2], [2, -3]],
        [[1, 4], [3, 1]],
        [[0, -2], [2, 1]],
      ],
      labels: ['a', 'b', 'c', 'd'],
      pos: [
        [26, 26],
        [74, 26],
        [74, 74],
        [26, 74],
      ],
    }),
  },
  {
    id: 'energy-battery',
    name: 'Keep the battery charged',
    blurb:
      'An energy game: Max must keep the running sum ≥ 0 forever. The costly hop into the middle drains −3, so Max ' +
      'needs a starting credit before daring it; the solver reports that least sufficient credit per vertex. Every ' +
      'vertex here is survivable (ν ≥ 0), but not for free — the credits show exactly how much runway each demands.',
    arena: build({
      owner: [0, 1, 0, 0],
      edges: [
        [[0, 1], [1, -3]],
        [[2, 2]],
        [[3, 1], [2, -1]],
        [[0, 1]],
      ],
      labels: ['hub', 'gate', 'far', 'ret'],
      pos: [
        [20, 50],
        [45, 22],
        [72, 50],
        [45, 78],
      ],
    }),
  },
  {
    id: 'losing-region',
    name: 'A doomed corner',
    blurb:
      'Not every vertex is winnable. On the right, Min can pin the token in a −2 sink no matter what Max does — those ' +
      'vertices have ν < 0 and, as an energy game, demand ⊤ (unbounded) credit. On the left Max escapes to a positive ' +
      'loop. The partition into ν ≥ 0 and ν < 0 is the threshold-0 decision the energy certificate proves exact.',
    arena: build({
      owner: [0, 1, 1, 0],
      edges: [
        [[0, 2], [1, -1]],
        [[2, -2], [0, -1]],
        [[1, -2]],
        [[3, 3], [0, 0]],
      ],
      labels: ['up', 'x', 'y', 'top'],
      pos: [
        [30, 40],
        [70, 30],
        [70, 70],
        [30, 75],
      ],
    }),
  },
]

export const DEFAULT_QUANT = QUANT_EXAMPLES[0]

export function findQuantExample(id: string): WExample | undefined {
  return QUANT_EXAMPLES.find((e) => e.id === id)
}
