// Canonical conjunctive-query **shapes** and seeded instance generators. These
// are the fixtures the self-tests and the Lab share: the triangle (the AGM
// witness), the 4-cycle, a path, a star, and the k-clique — each with a random
// generator and an adversarial *dense grid* generator that drives a binary join
// to its worst case while a WCOJ stays optimal.

import { Rng } from '../fuzz/rng'
import { relation, type Tuple } from './relation'
import type { Atom } from './triejoin'

export type ShapeId = 'triangle' | 'cycle4' | 'path' | 'star' | 'clique4'

export interface Shape {
  id: ShapeId
  label: string
  /** The atoms' variable schemas (the hypergraph edges). */
  edges: Array<{ name: string; vars: string[] }>
  blurb: string
}

export const SHAPES: Shape[] = [
  {
    id: 'triangle',
    label: 'Triangle',
    edges: [
      { name: 'R', vars: ['a', 'b'] },
      { name: 'S', vars: ['b', 'c'] },
      { name: 'T', vars: ['a', 'c'] },
    ],
    blurb: 'R(a,b) ⋈ S(b,c) ⋈ T(a,c) — the classic AGM witness: output ≤ N^{3/2}, cover ρ*=3/2.',
  },
  {
    id: 'cycle4',
    label: '4-cycle',
    edges: [
      { name: 'R', vars: ['a', 'b'] },
      { name: 'S', vars: ['b', 'c'] },
      { name: 'U', vars: ['c', 'd'] },
      { name: 'W', vars: ['a', 'd'] },
    ],
    blurb: 'A 4-cycle a–b–c–d–a; cover ρ*=2, output ≤ N².',
  },
  {
    id: 'path',
    label: 'Path',
    edges: [
      { name: 'R', vars: ['a', 'b'] },
      { name: 'S', vars: ['b', 'c'] },
      { name: 'U', vars: ['c', 'd'] },
    ],
    blurb: 'An acyclic path a–b–c–d; ρ*=2. Acyclic queries are already optimal via Yannakakis.',
  },
  {
    id: 'star',
    label: 'Star',
    edges: [
      { name: 'R', vars: ['c', 'x'] },
      { name: 'S', vars: ['c', 'y'] },
      { name: 'U', vars: ['c', 'z'] },
    ],
    blurb: 'A star: a hub c joined to leaves x,y,z; ρ*=3 (each leaf needs its own edge).',
  },
  {
    id: 'clique4',
    label: '4-clique',
    edges: [
      { name: 'Rab', vars: ['a', 'b'] },
      { name: 'Rac', vars: ['a', 'c'] },
      { name: 'Rad', vars: ['a', 'd'] },
      { name: 'Rbc', vars: ['b', 'c'] },
      { name: 'Rbd', vars: ['b', 'd'] },
      { name: 'Rcd', vars: ['c', 'd'] },
    ],
    blurb: 'All 6 edges of K4; cover ρ*=2, output ≤ N². Binary plans blow up hard.',
  },
]

export function shape(id: ShapeId): Shape {
  const s = SHAPES.find((x) => x.id === id)
  if (!s) throw new Error(`unknown shape ${id}`)
  return s
}

/** A random instance: each edge gets `n` random binary/tuples over `[0, dom)`. */
export function randomInstance(sh: Shape, rng: Rng, n: number, dom: number): Atom[] {
  return sh.edges.map((e) => {
    const rows: Tuple[] = []
    for (let i = 0; i < n; i++) rows.push(e.vars.map(() => rng.int(0, dom - 1)))
    return { name: e.name, relation: relation(e.vars, rows) }
  })
}

/**
 * The adversarial **dense-grid** instance for the triangle (and its analogue for
 * other shapes): each relation is a "spoke" — one attribute ranges over a small
 * core `{0..k-1}`, the other is pinned to `0`. Then `R⋈S` (a binary step) is a
 * full `k×k` product on the shared core (≈ `N²/…`) while the *triangle* output
 * is tiny. This is the instance where a WCOJ's optimality is visible.
 */
export function denseInstance(sh: Shape, k: number): Atom[] {
  return sh.edges.map((e, ei) => {
    const rows: Tuple[] = []
    // Give every edge the same "fan": value 0 on one endpoint, 0..k-1 on the other.
    for (let i = 0; i < k; i++) {
      const t = e.vars.map((_, j) => (j === ei % e.vars.length ? i : 0))
      rows.push(t)
    }
    // Plus the all-zero tuple so the triangle {a=b=c=0} is a real answer.
    rows.push(e.vars.map(() => 0))
    return { name: e.name, relation: relation(e.vars, rows) }
  })
}
