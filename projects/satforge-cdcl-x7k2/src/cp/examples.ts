// The model gallery: each entry is a *declarative* constraint model plus a hint
// for how to draw a solution. These read like specifications — the point of the
// modelling layer — and double as the self-test's known-answer fixtures.

import { Model } from './model.ts'
import type { OptSense } from './search.ts'

export type RenderSpec =
  | { kind: 'queens'; n: number; cols: number[] }
  | {
      kind: 'grid'
      rows: number
      cols: number
      cells: number[] // var id per cell (row-major)
      box?: [number, number]
      display: 'sudoku' | 'number' | 'latin' | 'langford'
      offset?: number // added to a var's value when displaying
    }
  | {
      kind: 'coloring'
      nodes: { x: number; y: number; label: string }[]
      edges: [number, number][]
      vars: number[]
      colors: number
    }
  | { kind: 'crypt'; lines: string[]; letters: string[]; letterVar: Record<string, number> }
  | { kind: 'ruler'; marks: number[]; span: number }
  | { kind: 'knap'; items: { label: string; weight: number; value: number; v: number }[]; capacity: number; valueVar: number }

export interface Built {
  model: Model
  render: RenderSpec
  objective?: { v: number; sense: OptSense; label: string; display?: (best: number) => string }
  mode: 'first' | 'all' | 'count' | 'optimize'
  /** Optional pinned answer for the cross-check badge. */
  known?: { count?: number; optimum?: number; note: string }
}

export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  default: number
}

export interface CpExample {
  id: string
  title: string
  blurb: string
  category: 'classic' | 'optimization'
  tags: string[]
  params: ParamSpec[]
  build(p: Record<string, number>): Built
}

// ---------- N-Queens ----------

function buildQueens(n: number): Built {
  const m = new Model()
  const q: number[] = []
  for (let i = 0; i < n; i++) q.push(m.newVar(`q${i}`, 0, n - 1))
  const up: number[] = []
  const down: number[] = []
  for (let i = 0; i < n; i++) {
    up.push(m.newVar(`u${i}`, i, n - 1 + i))
    down.push(m.newVar(`d${i}`, -(n - 1), n - 1))
    m.addLinear([1, -1], [up[i], q[i]], '=', i)
    m.addLinear([1, -1], [down[i], q[i]], '=', -i)
  }
  m.addAllDifferent(q)
  m.addAllDifferent(up)
  m.addAllDifferent(down)
  const queenCounts: Record<number, number> = { 1: 1, 4: 2, 5: 10, 6: 4, 7: 40, 8: 92, 9: 352, 10: 724 }
  const known = queenCounts[n] !== undefined ? { count: queenCounts[n], note: `OEIS A000170: ${n}-Queens has ${queenCounts[n]} solutions` } : undefined
  return {
    model: m,
    render: { kind: 'queens', n, cols: q },
    mode: n <= 10 ? 'count' : 'first',
    known,
  }
}

// ---------- Sudoku ----------

const SUDOKU_GIVENS =
  '53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79'

function buildSudoku(): Built {
  const m = new Model()
  const cell: number[] = []
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) cell.push(m.newVar(`c${r}${c}`, 1, 9))
  for (let i = 0; i < 81; i++) {
    const ch = SUDOKU_GIVENS[i]
    if (ch >= '1' && ch <= '9') m.fix(cell[i], Number(ch))
  }
  for (let r = 0; r < 9; r++) m.addAllDifferent(Array.from({ length: 9 }, (_, c) => cell[r * 9 + c]))
  for (let c = 0; c < 9; c++) m.addAllDifferent(Array.from({ length: 9 }, (_, r) => cell[r * 9 + c]))
  for (let br = 0; br < 3; br++)
    for (let bc = 0; bc < 3; bc++) {
      const box: number[] = []
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) box.push(cell[(br * 3 + r) * 9 + (bc * 3 + c)])
      m.addAllDifferent(box)
    }
  return {
    model: m,
    render: { kind: 'grid', rows: 9, cols: 9, cells: cell, box: [3, 3], display: 'sudoku' },
    mode: 'first',
    known: { count: 1, note: 'A well-posed Sudoku has exactly one solution' },
  }
}

// ---------- Latin square ----------

function buildLatin(n: number): Built {
  const m = new Model()
  const cell: number[] = []
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) cell.push(m.newVar(`c${r}${c}`, 0, n - 1))
  for (let r = 0; r < n; r++) m.addAllDifferent(Array.from({ length: n }, (_, c) => cell[r * n + c]))
  for (let c = 0; c < n; c++) m.addAllDifferent(Array.from({ length: n }, (_, r) => cell[r * n + c]))
  const latinCounts: Record<number, number> = { 1: 1, 2: 2, 3: 12, 4: 576 }
  return {
    model: m,
    render: { kind: 'grid', rows: n, cols: n, cells: cell, display: 'latin', offset: 1 },
    mode: n <= 4 ? 'count' : 'first',
    known: latinCounts[n] !== undefined ? { count: latinCounts[n], note: `There are ${latinCounts[n]} Latin squares of order ${n} (OEIS A002860)` } : undefined,
  }
}

// ---------- Magic square ----------

function buildMagic(n: number): Built {
  const m = new Model()
  const cell: number[] = []
  for (let i = 0; i < n * n; i++) cell.push(m.newVar(`c${i}`, 1, n * n))
  m.addAllDifferent(cell)
  const M = (n * (n * n + 1)) / 2
  for (let r = 0; r < n; r++) m.addSum(Array.from({ length: n }, (_, c) => cell[r * n + c]), '=', M)
  for (let c = 0; c < n; c++) m.addSum(Array.from({ length: n }, (_, r) => cell[r * n + c]), '=', M)
  m.addSum(Array.from({ length: n }, (_, i) => cell[i * n + i]), '=', M)
  m.addSum(Array.from({ length: n }, (_, i) => cell[i * n + (n - 1 - i)]), '=', M)
  const magicCounts: Record<number, number> = { 3: 8 }
  return {
    model: m,
    render: { kind: 'grid', rows: n, cols: n, cells: cell, display: 'number' },
    mode: n <= 3 ? 'count' : 'first',
    known: magicCounts[n] !== undefined ? { count: magicCounts[n], note: `The order-3 magic square is unique up to its 8 symmetries` } : { note: `Magic constant = ${M}` },
  }
}

// ---------- Graph coloring (Petersen) ----------

const PETERSEN_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 0], // outer pentagon
  [0, 5], [1, 6], [2, 7], [3, 8], [4, 9], // spokes
  [5, 7], [7, 9], [9, 6], [6, 8], [8, 5], // inner pentagram
]

function petersenNodes(): { x: number; y: number; label: string }[] {
  const out: { x: number; y: number; label: string }[] = []
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 2 * Math.PI - Math.PI / 2
    out.push({ x: Math.cos(a), y: Math.sin(a), label: String(i) })
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 2 * Math.PI - Math.PI / 2
    out.push({ x: 0.5 * Math.cos(a), y: 0.5 * Math.sin(a), label: String(i + 5) })
  }
  return out
}

function buildColoring(k: number): Built {
  const m = new Model()
  const col: number[] = []
  for (let i = 0; i < 10; i++) col.push(m.newVar(`n${i}`, 0, k - 1))
  for (const [a, b] of PETERSEN_EDGES) m.addNotEqual(col[a], col[b])
  // Symmetry break: node 0 uses colour 0.
  m.fix(col[0], 0)
  return {
    model: m,
    render: { kind: 'coloring', nodes: petersenNodes(), edges: PETERSEN_EDGES, vars: col, colors: k },
    mode: 'first',
    known: { note: k >= 3 ? `The Petersen graph is 3-chromatic — ${k} colours suffice` : `The Petersen graph needs 3 colours — ${k} is infeasible` },
  }
}

// ---------- SEND + MORE = MONEY ----------

function buildSendMoreMoney(): Built {
  const m = new Model()
  const letters = ['S', 'E', 'N', 'D', 'M', 'O', 'R', 'Y']
  const lv: Record<string, number> = {}
  for (const L of letters) lv[L] = m.newVar(L, 0, 9)
  m.bound(lv['S'], 1, 9)
  m.bound(lv['M'], 1, 9)
  m.addAllDifferent(letters.map((L) => lv[L]))
  // SEND + MORE = MONEY
  const send = [1000, 100, 10, 1]
  const S = lv['S'], E = lv['E'], N = lv['N'], D = lv['D'], M = lv['M'], O = lv['O'], R = lv['R'], Y = lv['Y']
  m.addLinear(
    [send[0], send[1], send[2], send[3], send[0], send[1], send[2], send[3], -10000, -1000, -100, -10, -1],
    [S, E, N, D, M, O, R, E, M, O, N, E, Y],
    '=',
    0,
  )
  return {
    model: m,
    render: { kind: 'crypt', lines: ['SEND', 'MORE', 'MONEY'], letters, letterVar: lv },
    mode: 'count',
    known: { count: 1, note: 'The classic cryptarithm has the unique solution 9567 + 1085 = 10652' },
  }
}

// ---------- Golomb ruler (optimization) ----------

function buildGolomb(mMarks: number): Built {
  const m = new Model()
  const ub = mMarks * mMarks
  const x: number[] = []
  for (let i = 0; i < mMarks; i++) x.push(m.newVar(`m${i}`, 0, ub))
  m.fix(x[0], 0)
  for (let i = 0; i + 1 < mMarks; i++) m.addLinear([1, -1], [x[i], x[i + 1]], '<', 0) // strictly increasing
  const diffs: number[] = []
  for (let i = 0; i < mMarks; i++)
    for (let j = i + 1; j < mMarks; j++) {
      const d = m.newVar(`d${i}_${j}`, 1, ub)
      m.addLinear([1, -1, -1], [x[j], x[i], d], '=', 0) // d = x[j] - x[i]
      diffs.push(d)
    }
  m.addAllDifferent(diffs)
  const optimal: Record<number, number> = { 2: 1, 3: 3, 4: 6, 5: 11, 6: 17, 7: 25 }
  return {
    model: m,
    render: { kind: 'ruler', marks: x, span: x[mMarks - 1] },
    objective: { v: x[mMarks - 1], sense: 'min', label: 'ruler length', display: (b) => `${b}` },
    mode: 'optimize',
    known: optimal[mMarks] !== undefined ? { optimum: optimal[mMarks], note: `The optimal Golomb ruler with ${mMarks} marks has length ${optimal[mMarks]}` } : undefined,
  }
}

// ---------- Langford pairs ----------

function buildLangford(n: number): Built {
  const m = new Model()
  // first[k] = position (1..2n) of the first copy of number k+1; second = first + (k+1) + 1
  const first: number[] = []
  const second: number[] = []
  for (let k = 0; k < n; k++) {
    const num = k + 1
    const f = m.newVar(`f${num}`, 1, 2 * n - num - 1)
    const s = m.newVar(`s${num}`, 1, 2 * n)
    m.addLinear([1, -1], [s, f], '=', num + 1) // s = f + num + 1
    first.push(f)
    second.push(s)
  }
  m.addAllDifferent([...first, ...second])
  return {
    model: m,
    render: { kind: 'grid', rows: 1, cols: 2 * n, cells: [], display: 'langford' },
    mode: 'count',
    known: langfordNote(n),
  }
}

function langfordNote(n: number): { count?: number; note: string } | undefined {
  // Every arrangement AND its mirror are counted, so the totals are 2×A014552:
  // 3→2, 4→2, 5→0, 6→0, 7→52, 8→300.
  const counts: Record<number, number> = { 3: 2, 4: 2, 5: 0, 6: 0, 7: 52, 8: 300 }
  if (counts[n] !== undefined) return { count: counts[n], note: `L(${n}) has ${counts[n]} arrangements (2×A014552 — each solution and its mirror)` }
  return undefined
}

// ---------- 0/1 Knapsack (optimization) ----------

const KNAP_ITEMS = [
  { label: 'map', weight: 9, value: 150 },
  { label: 'compass', weight: 13, value: 35 },
  { label: 'water', weight: 153, value: 200 },
  { label: 'sandwich', weight: 50, value: 160 },
  { label: 'glucose', weight: 15, value: 60 },
  { label: 'tin', weight: 68, value: 45 },
  { label: 'banana', weight: 27, value: 60 },
  { label: 'apple', weight: 39, value: 40 },
  { label: 'cheese', weight: 23, value: 30 },
  { label: 'beer', weight: 52, value: 10 },
]

function buildKnapsack(capacity: number): Built {
  const m = new Model()
  const x: number[] = []
  for (const it of KNAP_ITEMS) x.push(m.newBool(`x_${it.label}`))
  m.addLinear(KNAP_ITEMS.map((it) => it.weight), x, '<=', capacity)
  const totalVal = m.newVar('value', 0, KNAP_ITEMS.reduce((s, it) => s + it.value, 0))
  m.addLinear([...KNAP_ITEMS.map((it) => it.value), -1], [...x, totalVal], '=', 0)
  return {
    model: m,
    render: {
      kind: 'knap',
      items: KNAP_ITEMS.map((it, i) => ({ ...it, v: x[i] })),
      capacity,
      valueVar: totalVal,
    },
    objective: { v: totalVal, sense: 'max', label: 'total value', display: (b) => `${b}` },
    mode: 'optimize',
    known: { note: `Maximise value packed under a ${capacity}-weight budget` },
  }
}

// ---------- registry ----------

export const CP_EXAMPLES: CpExample[] = [
  {
    id: 'queens',
    title: 'N-Queens',
    blurb: 'Place n non-attacking queens. All-different on columns, ↗ and ↘ diagonals.',
    category: 'classic',
    tags: ['all-different', 'diagonals'],
    params: [{ key: 'n', label: 'board size', min: 4, max: 12, default: 8 }],
    build: (p) => buildQueens(p.n),
  },
  {
    id: 'sudoku',
    title: 'Sudoku',
    blurb: '27 all-different constraints (rows, columns, boxes). Watch GAC solve it with almost no search.',
    category: 'classic',
    tags: ['all-different', 'gac'],
    params: [],
    build: () => buildSudoku(),
  },
  {
    id: 'latin',
    title: 'Latin square',
    blurb: 'Fill an n×n grid so every symbol appears once per row and column.',
    category: 'classic',
    tags: ['all-different', 'counting'],
    params: [{ key: 'n', label: 'order', min: 2, max: 6, default: 4 }],
    build: (p) => buildLatin(p.n),
  },
  {
    id: 'magic',
    title: 'Magic square',
    blurb: 'All-different 1…n² with every row, column and diagonal summing to the magic constant.',
    category: 'classic',
    tags: ['all-different', 'linear'],
    params: [{ key: 'n', label: 'order', min: 3, max: 4, default: 3 }],
    build: (p) => buildMagic(p.n),
  },
  {
    id: 'coloring',
    title: 'Graph colouring',
    blurb: 'Colour the Petersen graph so adjacent nodes differ. It is 3-chromatic — try k = 2 vs 3.',
    category: 'classic',
    tags: ['not-equal', 'graph'],
    params: [{ key: 'k', label: 'colours', min: 2, max: 4, default: 3 }],
    build: (p) => buildColoring(p.k),
  },
  {
    id: 'sendmore',
    title: 'SEND + MORE = MONEY',
    blurb: 'The classic cryptarithm: distinct digits, no leading zeros, one exact sum.',
    category: 'classic',
    tags: ['all-different', 'linear', 'cryptarithm'],
    params: [],
    build: () => buildSendMoreMoney(),
  },
  {
    id: 'langford',
    title: 'Langford pairs',
    blurb: 'Arrange two each of 1…n so k numbers sit between the two k’s. All-different on positions.',
    category: 'classic',
    tags: ['all-different', 'counting'],
    params: [{ key: 'n', label: 'n', min: 3, max: 10, default: 4 }],
    build: (p) => buildLangford(p.n),
  },
  {
    id: 'golomb',
    title: 'Golomb ruler',
    blurb: 'Place m marks so all pairwise distances are distinct — and the ruler is as short as possible.',
    category: 'optimization',
    tags: ['all-different', 'branch-and-bound'],
    params: [{ key: 'm', label: 'marks', min: 3, max: 7, default: 5 }],
    build: (p) => buildGolomb(p.m),
  },
  {
    id: 'knapsack',
    title: '0/1 Knapsack',
    blurb: 'Pack the most valuable subset of items under a weight budget. Linear + branch-and-bound.',
    category: 'optimization',
    tags: ['linear', 'branch-and-bound', 'boolean'],
    params: [{ key: 'capacity', label: 'weight budget', min: 100, max: 400, default: 250 }],
    build: (p) => buildKnapsack(p.capacity),
  },
]

/** Reconstruct the Langford slot→number layout from a solution assignment. */
export function langfordLayout(n: number, _model: Model, assignment: number[]): number[] {
  const slots = new Array(2 * n).fill(0)
  // Vars were created in order: f1,s1,f2,s2,… so first[k] is var index 2k, second 2k+1.
  for (let k = 0; k < n; k++) {
    const f = assignment[2 * k]
    const s = assignment[2 * k + 1]
    slots[f - 1] = k + 1
    slots[s - 1] = k + 1
  }
  return slots
}
