// Curated arenas — one hand-drawn game per idea, each with a story the winning regions make visible.

import type { Arena, Condition, Player } from './types'

export interface GameExample {
  id: string
  name: string
  condition: Condition
  blurb: string
  arena: Arena
}

interface Spec {
  owner: number[] // 0 or 1 per vertex
  edges: number[][]
  priority?: number[]
  accent?: number[] // indices of the coloured (target / bad / accepting) vertices
  labels?: string[]
  pos: [number, number][]
}

function build(s: Spec): Arena {
  const n = s.owner.length
  const accent = new Array(n).fill(false)
  for (const i of s.accent ?? []) accent[i] = true
  return {
    n,
    owner: s.owner.map((o) => o as Player),
    edges: s.edges,
    priority: s.priority ?? new Array(n).fill(0),
    accent,
    labels: s.labels ?? Array.from({ length: n }, (_, i) => String(i)),
    pos: s.pos.map(([x, y]) => ({ x, y })),
  }
}

export const GAME_EXAMPLES: GameExample[] = [
  {
    id: 'reach-pursuit',
    name: 'Reachability · escort',
    condition: 'reachability',
    blurb:
      'Player 0 (circles) must escort the token to the flag ⚑; Player 1 (squares) tries to steer it into the ' +
      'sink and loop there forever. The winning region is exactly Attr₀(flag) — the states from which Player 0 ' +
      'can force arrival no matter how the adversary branches.',
    arena: build({
      owner: [0, 1, 0, 1, 0, 1],
      edges: [[1, 2], [2, 5], [4, 3], [5, 1], [4], [5]],
      accent: [4],
      labels: ['s', 'a', 'b', 'c', '⚑', '∅'],
      pos: [
        [12, 50],
        [34, 22],
        [34, 78],
        [58, 22],
        [82, 78],
        [82, 22],
      ],
    }),
  },
  {
    id: 'safety-ridge',
    name: 'Safety · stay on the ridge',
    condition: 'safety',
    blurb:
      'The dual game: Player 0 must keep the token out of the hazard ☠ forever, while Player 1 tries to force it ' +
      'in. Player 0 wins exactly the complement of Attr₁(hazard); on that region a single trap-strategy keeps the ' +
      'play safe for all time.',
    arena: build({
      owner: [0, 1, 0, 1, 0, 1],
      edges: [[1, 5], [2, 0], [1, 3], [2, 5], [4], [5]],
      accent: [5],
      labels: ['p', 'q', 'r', 't', 'safe', '☠'],
      pos: [
        [12, 50],
        [36, 24],
        [36, 76],
        [60, 50],
        [84, 76],
        [84, 24],
      ],
    }),
  },
  {
    id: 'buchi-arbiter',
    name: 'Büchi · a fair arbiter',
    condition: 'buchi',
    blurb:
      'A liveness game. The accepting state ✓ is a "grant"; Player 0 wins only by returning to it infinitely often. ' +
      'From the live region Player 0 re-attracts to ✓ again and again; from the dead region Player 1 escapes into a ' +
      'sink and starves the grant forever. This is reactive synthesis in miniature — the winning strategy *is* the controller.',
    arena: build({
      owner: [0, 1, 0, 1, 1],
      edges: [[2, 1], [0, 3], [0], [3], [1, 3]],
      accent: [2],
      labels: ['idle', 'req', '✓grant', 'stuck', 'div'],
      pos: [
        [20, 30],
        [50, 20],
        [20, 74],
        [80, 74],
        [80, 30],
      ],
    }),
  },
  {
    id: 'parity-three',
    name: 'Parity · three colours',
    condition: 'parity',
    blurb:
      'The general condition: Player 0 (Even) wins a play iff the highest priority seen infinitely often is even. ' +
      'Priorities are shown inside each node. Zielonka’s recursion peels the arena apart by top priority; the ' +
      'certificate then pins both memoryless strategies and proves no player can force a cycle of the wrong parity.',
    arena: build({
      owner: [0, 1, 0, 1, 0],
      edges: [[1, 2], [0, 3], [2], [4, 3], [1]],
      priority: [1, 2, 0, 1, 2],
      pos: [
        [16, 50],
        [40, 24],
        [40, 78],
        [66, 24],
        [88, 50],
      ],
    }),
  },
  {
    id: 'parity-greedy',
    name: 'Parity · why greed fails',
    condition: 'parity',
    blurb:
      'A trap for the naive "always chase the biggest even priority" heuristic. Reaching the priority-4 node looks ' +
      'winning, but from there the adversary forces an odd-dominated cycle. Real optimal play must sometimes walk ' +
      'away from the shiniest colour — the winning regions here make that non-locality concrete.',
    arena: build({
      owner: [0, 1, 1, 0, 1, 0],
      edges: [[1, 3], [0, 2], [1, 4], [5], [4, 5], [3, 0]],
      priority: [4, 3, 3, 0, 1, 2],
      pos: [
        [14, 50],
        [38, 24],
        [38, 78],
        [62, 78],
        [62, 24],
        [86, 50],
      ],
    }),
  },
  {
    id: 'parity-mu',
    name: 'Parity ≡ µ-calculus',
    condition: 'parity',
    blurb:
      'Model checking a fixpoint-alternating µ-calculus formula on a transition system *is* solving a parity game: ' +
      'the priorities encode the alternation depth of µ (least, odd) and ν (greatest, even). This little arena is ' +
      'the game for νX. µY. (◇even ∧ ◇X) ∨ ◇Y — Player 0’s region is precisely where the formula holds.',
    arena: build({
      owner: [0, 0, 1, 1, 0, 1],
      edges: [[2, 4], [3, 0], [1, 4], [5, 0], [4], [3, 5]],
      priority: [2, 1, 3, 2, 0, 1],
      pos: [
        [18, 30],
        [18, 72],
        [50, 20],
        [50, 82],
        [82, 30],
        [82, 72],
      ],
    }),
  },
]

export const DEFAULT_EXAMPLE = GAME_EXAMPLES[0]

export function findExample(id: string): GameExample | undefined {
  return GAME_EXAMPLES.find((e) => e.id === id)
}
