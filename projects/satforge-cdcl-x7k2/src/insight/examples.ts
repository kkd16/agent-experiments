// Curated instances for the Insight Studio.
//
// Two families: over-constrained *soft systems* (to explore why they fail, via
// MUS/MCS) and plain *CNF formulas* (to explore their whole solution space, via
// backbones, AllSAT, and exact-vs-approximate counting).

import type { CNF } from '../sat/cnf'
import type { SoftSystem } from './core'

export interface SoftExample {
  name: string
  blurb: string
  sys: SoftSystem
}

export interface CnfExample {
  name: string
  blurb: string
  cnf: CNF
  /** Variable meanings for the model grid (index v → label). */
  varLabels?: string[]
}

// --- soft-constraint systems (MUS / MCS) ---

// Pigeonhole PHP(pigeons → holes): each pigeon needs a hole; no hole holds two.
function pigeonhole(pigeons: number, holes: number): SoftSystem {
  const v = (i: number, h: number) => (i - 1) * holes + h // 1-based pigeon/hole
  const soft: number[][] = []
  const labels: string[] = []
  for (let i = 1; i <= pigeons; i++) {
    const cl: number[] = []
    for (let h = 1; h <= holes; h++) cl.push(v(i, h))
    soft.push(cl)
    labels.push(`p${i} in some hole`)
  }
  for (let h = 1; h <= holes; h++) {
    for (let i = 1; i <= pigeons; i++) {
      for (let j = i + 1; j <= pigeons; j++) {
        soft.push([-v(i, h), -v(j, h)])
        labels.push(`p${i},p${j} ≠ hole ${h}`)
      }
    }
  }
  return { numVars: pigeons * holes, hard: [], soft, labels }
}

// 2-colouring a triangle: each edge demands its endpoints differ — impossible.
const triangle2col: SoftSystem = {
  numVars: 3,
  hard: [],
  soft: [
    [1, 2],
    [-1, -2],
    [2, 3],
    [-2, -3],
    [1, 3],
    [-1, -3],
  ],
  labels: ['1,2 differ⁺', '1,2 differ⁻', '2,3 differ⁺', '2,3 differ⁻', '1,3 differ⁺', '1,3 differ⁻'],
}

export const SOFT_EXAMPLES: SoftExample[] = [
  {
    name: 'Contradictory facts',
    blurb: 'Four assertions about a, b that cannot all hold. Two overlapping MUSes.',
    sys: { numVars: 2, hard: [], soft: [[1], [-1], [2], [-1, -2]], labels: ['a', '¬a', 'b', '¬a ∨ ¬b'] },
  },
  {
    name: 'Three-way exclusion',
    blurb: 'Pick each of three items, yet no two may coexist — three MUSes, seven MCSes.',
    sys: {
      numVars: 3,
      hard: [],
      soft: [[1], [2], [3], [-1, -2], [-1, -3], [-2, -3]],
      labels: ['pick 1', 'pick 2', 'pick 3', '¬(1∧2)', '¬(1∧3)', '¬(2∧3)'],
    },
  },
  {
    name: 'Pigeonhole 3→2',
    blurb: 'Three pigeons into two holes: the smallest classic contradiction.',
    sys: pigeonhole(3, 2),
  },
  {
    name: '2-colour a triangle',
    blurb: 'A 3-cycle cannot be 2-coloured; every edge constraint is part of the reason.',
    sys: triangle2col,
  },
]

// --- CNF formulas (backbone / AllSAT / counting) ---

export const CNF_EXAMPLES: CnfExample[] = [
  {
    name: 'Structured (strong backbone)',
    blurb: 'Some variables are forced by unit propagation; others stay free.',
    cnf: {
      numVars: 6,
      clauses: [[1], [-2], [-1, 3], [-3, 4], [4, 5], [-5, 6], [1, 6]],
    },
    varLabels: ['', 'a', 'b', 'c', 'd', 'e', 'f'],
  },
  {
    name: '5-cycle 3-colouring',
    blurb: 'Proper 3-colourings of a 5-cycle — many symmetric models, empty backbone.',
    cnf: cycleColoring(5, 3),
  },
  {
    name: 'Pigeonhole 4→3 (UNSAT)',
    blurb: 'No models at all: count 0, and no backbone to speak of.',
    cnf: pigeonholeCnf(4, 3),
  },
  {
    name: 'Loose 3-SAT (n=16)',
    blurb: 'Thousands of models — small enough to count exactly, big enough for hashing.',
    cnf: {
      numVars: 16,
      clauses: [
        [1, 2, 3],
        [-4, 5],
        [6, -7, 8],
        [9, 10, -11],
        [-12, 13, 14],
        [15, -16, 1],
        [-2, -9],
        [4, -13],
      ],
    },
  },
]

// --- CNF formulas curated for *sampling* (almost-uniform witness generation) ---
//
// These are deliberately small (their whole solution space is enumerable, so the
// studio can measure uniformity exactly) and chosen to tell the story: some have a
// lopsided solution landscape a naive "ask the solver" sampler collapses onto, others
// are symmetric enough that even the naive sampler looks fair — a useful contrast that
// shows UniGen matching the truth in *both* regimes.

export const SAMPLE_EXAMPLES: CnfExample[] = [
  {
    name: 'Implication chain (biased)',
    blurb:
      'A ring of implications with a few "hub" solutions. Naive solving piles onto the hubs; UniGen spreads flat. Small enough (14 models) to enumerate — the exact fast path, no hashing.',
    cnf: {
      numVars: 8,
      clauses: [[-1, 2], [-2, 3], [-3, 4], [-4, 5], [1, 6], [6, 7], [-7, 8], [8, 1]],
    },
    varLabels: ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  },
  {
    name: 'Parity ladder (hashed)',
    blurb:
      '20 models over three exclusive-or pairs plus a coupling clause — past the fast-path threshold, so UniGen must actually hash the space into cells.',
    cnf: {
      numVars: 8,
      clauses: [[1, 2], [-1, -2], [3, 4], [-3, -4], [5, 6], [-5, -6], [1, 3, 5], [-1, -3, -5, 7], [7, 8]],
    },
    varLabels: ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  },
  {
    name: 'Two clusters (hashed)',
    blurb:
      '70 models split across a dense region and a sparse one. The naive sampler over-serves the dense side; UniGen hashes into ~2³ cells and comes out uniform.',
    cnf: {
      numVars: 10,
      clauses: [[1, 2, 3, 4], [-1, -2], [-3, -4], [5, 6], [-5, -6, 7], [8, -9], [9, -10], [10, -8], [1, 5, 8]],
    },
  },
  {
    name: 'Symmetric 3-colouring',
    blurb:
      'Proper 3-colourings of a 5-cycle: 30 models related by symmetry, so even the naive sampler is roughly fair here — UniGen agrees, confirming the flat target.',
    cnf: cycleColoring(5, 3),
  },
]

// A proper k-colouring of an n-cycle, one-hot per vertex.
function cycleColoring(n: number, k: number): CNF {
  const v = (i: number, c: number) => (i - 1) * k + c // vertex i (1..n), colour c (1..k)
  const clauses: number[][] = []
  for (let i = 1; i <= n; i++) {
    const atLeast: number[] = []
    for (let c = 1; c <= k; c++) atLeast.push(v(i, c))
    clauses.push(atLeast)
    for (let c1 = 1; c1 <= k; c1++) for (let c2 = c1 + 1; c2 <= k; c2++) clauses.push([-v(i, c1), -v(i, c2)])
  }
  for (let i = 1; i <= n; i++) {
    const j = (i % n) + 1
    for (let c = 1; c <= k; c++) clauses.push([-v(i, c), -v(j, c)]) // adjacent differ
  }
  return { numVars: n * k, clauses }
}

function pigeonholeCnf(pigeons: number, holes: number): CNF {
  const v = (i: number, h: number) => (i - 1) * holes + h
  const clauses: number[][] = []
  for (let i = 1; i <= pigeons; i++) {
    const cl: number[] = []
    for (let h = 1; h <= holes; h++) cl.push(v(i, h))
    clauses.push(cl)
  }
  for (let h = 1; h <= holes; h++)
    for (let i = 1; i <= pigeons; i++)
      for (let j = i + 1; j <= pigeons; j++) clauses.push([-v(i, h), -v(j, h)])
  return { numVars: pigeons * holes, clauses }
}
