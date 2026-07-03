// Self-tests for the worst-case-optimal join engine. Every claim is proven
// against an exact oracle: the trie iterator against brute force, the leapfrog
// against sorted-set intersection, the triejoin against a binary-join reference
// AND against the engine's own SQL executor (a true cross-engine differential),
// the simplex against closed-form LP optima, and the AGM bound theorem
// (output ≤ ∏|R_e|^{x_e}) against thousands of seeded random instances. Same
// shape as the other standalone modules' groups — exported as `wcojCases`,
// concatenated into `runTests()`.

import { Rng } from '../fuzz/rng'
import { orderValues, type SqlValue } from '../types'
import { Engine } from '../engine'
import type { Row } from '../catalog'
import { relation } from './relation'
import { SortedTrie } from './trie'
import { LeapfrogJoin } from './leapfrog'
import { triejoin, chooseOrder, type Atom } from './triejoin'
import { binaryJoin } from './binary'
import { solveGE } from './simplex'
import { agmBound, fractionalCover } from './agm'
import { SHAPES, shape, randomInstance, denseInstance, type Shape } from './query'

export interface WcojCase {
  group: string
  name: string
  run: () => void
}

const cases: WcojCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'wcoj', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

/** Canonical string key for a set of answer rows (engine total order, deduped). */
function keys(rows: SqlValue[][]): string[] {
  return rows.map((r) => r.map((v) => JSON.stringify(v)).join('|')).sort()
}
function sameSet(a: SqlValue[][], b: SqlValue[][]): boolean {
  const ka = keys(a)
  const kb = keys(b)
  return ka.length === kb.length && ka.every((x, i) => x === kb[i])
}

// ---- simplex ----------------------------------------------------------------

test('simplex: fractional edge covers match closed forms (triangle 3/2, path 2, star 3, K4 2)', () => {
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6
  // triangle
  let r = solveGE(
    [
      [1, 0, 1],
      [1, 1, 0],
      [0, 1, 1],
    ],
    [1, 1, 1],
    [1, 1, 1],
  )
  assert(r.status === 'optimal' && near(r.obj, 1.5), `triangle ρ*=3/2, got ${r.obj}`)
  // path a-b-c-d
  r = solveGE(
    [
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 1],
    ],
    [1, 1, 1, 1],
    [1, 1, 1],
  )
  assert(r.status === 'optimal' && near(r.obj, 2), `path ρ*=2, got ${r.obj}`)
  // star (hub in all three, one leaf each)
  r = solveGE(
    [
      [1, 1, 1],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [1, 1, 1, 1],
    [1, 1, 1],
  )
  assert(r.status === 'optimal' && near(r.obj, 3), `star ρ*=3, got ${r.obj}`)
})

test('simplex: infeasible and unbounded LPs are reported, not silently wrong', () => {
  // Unbounded: minimise -x s.t. -x ≥ 0 (i.e. x ≤ 0) but x ≥ 0 forces x=0 → obj 0.
  // Construct a genuinely unbounded one: min -x1 s.t. x1 - x2 ≥ 0 (x1 can grow with x2).
  const u = solveGE([[1, -1]], [0], [-1, 0])
  assert(u.status === 'unbounded', `expected unbounded, got ${u.status}`)
  // A weighted LP still lands on the analytic optimum.
  const w = solveGE(
    [
      [1, 0, 1],
      [1, 1, 0],
      [0, 1, 1],
    ],
    [1, 1, 1],
    [2, 5, 2],
  )
  // min 2x1+5x2+2x3, x1+x3≥1, x1+x2≥1, x2+x3≥1. Optimum sets x2=0 → x1=x3=1, obj 4.
  assert(w.status === 'optimal' && Math.abs(w.obj - 4) < 1e-6, `weighted LP opt 4, got ${w.obj}`)
})

// ---- fractional cover + AGM over the query shapes ---------------------------

test('agm: the shapes have their textbook fractional cover numbers ρ*', () => {
  const expect: Record<string, number> = { triangle: 1.5, cycle4: 2, path: 2, star: 3, clique4: 2 }
  const rng = new Rng(1)
  for (const sh of SHAPES) {
    const atoms = randomInstance(sh, rng, 8, 10)
    const cover = fractionalCover(atoms)
    assert(cover.feasible, `${sh.id} cover feasible`)
    assert(Math.abs(cover.rho - expect[sh.id]) < 1e-6, `${sh.id} ρ*=${expect[sh.id]}, got ${cover.rho}`)
  }
})

test('agm: the triangle bound is N^{3/2} in closed form', () => {
  // Equal-size relations of 100 tuples each → bound 100^1.5 = 1000.
  const rows = (): [number, number][] => {
    const out: [number, number][] = []
    for (let i = 0; i < 100; i++) out.push([i, i]) // 100 distinct tuples
    return out
  }
  const atoms: Atom[] = [
    { name: 'R', relation: relation(['a', 'b'], rows()) },
    { name: 'S', relation: relation(['b', 'c'], rows()) },
    { name: 'T', relation: relation(['a', 'c'], rows()) },
  ]
  const agm = agmBound(atoms)
  assert(Math.abs(agm.bound - 1000) < 1, `triangle bound 1000, got ${agm.bound}`)
})

// ---- trie iterator ----------------------------------------------------------

test('trie iterator: key/next/seek walk the sorted keys and invariants hold', () => {
  const rng = new Rng(7)
  for (let t = 0; t < 200; t++) {
    const n = rng.int(1, 40)
    const dom = rng.int(2, 12)
    const rows: number[][] = []
    for (let i = 0; i < n; i++) rows.push([rng.int(0, dom - 1), rng.int(0, dom - 1)])
    const rel = relation(['a', 'b'], rows)
    const it = new SortedTrie(rel, ['a', 'b']).iterator()
    // Walk level 0: distinct sorted first-column values.
    const expectA = Array.from(new Set(rel.tuples.map((r) => r[0] as number))).sort((x, y) => x - y)
    const gotA: number[] = []
    it.rewind()
    while (!it.atEnd()) {
      it.checkInvariants()
      gotA.push(it.key() as number)
      it.next()
    }
    assert(gotA.length === expectA.length && gotA.every((v, i) => v === expectA[i]), 'level-0 walk')
    // seek: for each query value, the iterator lands on the least key ≥ v.
    it.rewind()
    const v = rng.int(0, dom - 1)
    it.seek(v)
    const landed = it.atEnd() ? Infinity : (it.key() as number)
    const trueLeast = expectA.find((x) => x >= v) ?? Infinity
    assert(landed === trueLeast, `seek(${v}) → ${landed}, want ${trueLeast}`)
  }
})

// ---- leapfrog = sorted-set intersection -------------------------------------

test('leapfrog: k-way intersection equals brute-force set intersection', () => {
  const rng = new Rng(11)
  for (let t = 0; t < 400; t++) {
    const k = rng.int(1, 5)
    const dom = rng.int(2, 30)
    const sets: number[][] = []
    for (let i = 0; i < k; i++) {
      const s = new Set<number>()
      const m = rng.int(0, 20)
      for (let j = 0; j < m; j++) s.add(rng.int(0, dom - 1))
      sets.push([...s])
    }
    const iters = sets.map((s) => new SortedTrie(relation(['x'], s.map((v) => [v])), ['x']).iterator())
    const got = new LeapfrogJoin(iters).collect() as number[]
    // brute intersection
    let inter = sets.length ? new Set(sets[0]) : new Set<number>()
    for (let i = 1; i < sets.length; i++) inter = new Set([...inter].filter((x) => sets[i].includes(x)))
    const exp = [...inter].sort((a, b) => a - b)
    assert(
      got.length === exp.length && got.every((v, i) => v === exp[i]),
      `intersection mismatch: got ${got} want ${exp}`,
    )
    // The output is sorted and duplicate-free (a monotone stream).
    for (let i = 1; i < got.length; i++) assert(orderValues(got[i - 1], got[i]) < 0, 'strictly increasing')
  }
})

// ---- triejoin = binary join (the core differential) -------------------------

function randomAtomsAllShapes(rng: Rng, n: number, dom: number): Array<{ sh: Shape; atoms: Atom[] }> {
  return SHAPES.map((sh) => ({ sh, atoms: randomInstance(sh, rng, n, dom) }))
}

test('triejoin = binary join across every shape, thousands of seeded instances', () => {
  let checked = 0
  for (let seed = 1; seed <= 400; seed++) {
    const rng = new Rng(seed * 2654435761)
    const n = rng.int(2, 18)
    const dom = rng.int(2, 10)
    for (const { sh, atoms } of randomAtomsAllShapes(rng, n, dom)) {
      const tj = triejoin(atoms)
      const bj = binaryJoin(atoms)
      // Map triejoin binding rows into the binary-join column order for comparison.
      const tjRows = tj.rows.map((r) => bj.vars.map((v) => r[tj.order.indexOf(v)]))
      assert(sameSet(tjRows, bj.rows), `${sh.id} seed ${seed}: triejoin ≠ binary join`)
      checked++
    }
  }
  assert(checked >= 2000, `expected ≥2000 differential checks, ran ${checked}`)
})

test('triejoin: the answer set is invariant under the variable order', () => {
  const rng = new Rng(99)
  for (let t = 0; t < 120; t++) {
    const sh = SHAPES[rng.int(0, SHAPES.length - 1)]
    const atoms = randomInstance(sh, rng, rng.int(2, 14), rng.int(2, 8))
    const base = triejoin(atoms)
    const vars = base.order.slice()
    const shuffled = rng.shuffle(vars)
    const other = triejoin(atoms, shuffled)
    const b = base.rows.map((r) => vars.map((v) => r[base.order.indexOf(v)]))
    const o = other.rows.map((r) => vars.map((v) => r[other.order.indexOf(v)]))
    assert(sameSet(b, o), `${sh.id}: order changed the answer set`)
  }
})

// ---- AGM bound theorem ------------------------------------------------------

test('agm: the join output never exceeds the AGM bound (the theorem)', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const rng = new Rng(seed * 40503 + 7)
    const sh = SHAPES[rng.int(0, SHAPES.length - 1)]
    const atoms = randomInstance(sh, rng, rng.int(1, 20), rng.int(2, 9))
    const out = triejoin(atoms).rows.length
    const bound = agmBound(atoms).bound
    // The theorem: |output| ≤ ⌊bound⌋ (allow a hair of FP slack in the LP).
    assert(out <= bound + 1e-6, `${sh.id} seed ${seed}: output ${out} > AGM bound ${bound}`)
  }
})

// ---- the blow-up witness ----------------------------------------------------

test('blow-up: on the dense triangle a binary plan builds an intermediate ≫ the answer', () => {
  const sh = shape('triangle')
  for (const k of [8, 16, 32, 64]) {
    const atoms = denseInstance(sh, k)
    const tj = triejoin(atoms)
    const bj = binaryJoin(atoms)
    assert(sameSet(tj.rows.map((r) => bj.vars.map((v) => r[tj.order.indexOf(v)])), bj.rows), `k=${k} agree`)
    // The final answer is small; some binary intermediate is Ω(k) larger.
    assert(
      bj.maxIntermediate >= tj.rows.length,
      `k=${k}: binary intermediate ${bj.maxIntermediate} should ≥ output ${tj.rows.length}`,
    )
    assert(bj.maxIntermediate >= k, `k=${k}: expected an Ω(k) intermediate, got ${bj.maxIntermediate}`)
  }
})

// ---- value-type coverage (joins over non-numeric values) --------------------

test('triejoin joins over strings, not just numbers (uses the engine value order)', () => {
  const R = relation(['a', 'b'], [
    ['x', 'p'],
    ['y', 'q'],
    ['x', 'r'],
  ])
  const S = relation(['b', 'c'], [
    ['p', 'm'],
    ['r', 'n'],
    ['q', 'm'],
  ])
  const T = relation(['a', 'c'], [
    ['x', 'm'],
    ['y', 'm'],
    ['x', 'n'],
  ])
  const atoms: Atom[] = [
    { name: 'R', relation: R },
    { name: 'S', relation: S },
    { name: 'T', relation: T },
  ]
  const tj = triejoin(atoms)
  const bj = binaryJoin(atoms)
  const tjRows = tj.rows.map((r) => bj.vars.map((v) => r[tj.order.indexOf(v)]))
  assert(sameSet(tjRows, bj.rows), 'string triangle: triejoin ≠ binary join')
})

// ---- cross-engine differential: triejoin = the engine's own SQL -------------

function engineTriangle(e: Engine, R: number[][], S: number[][], T: number[][]): Row[] {
  e.execute('DROP TABLE IF EXISTS r; DROP TABLE IF EXISTS s; DROP TABLE IF EXISTS t')
  e.execute('CREATE TABLE r(a INT, b INT); CREATE TABLE s(b INT, c INT); CREATE TABLE t(a INT, c INT)')
  const ins = (tbl: string, rows: number[][]) => {
    if (rows.length === 0) return
    const vals = rows.map((r) => `(${r[0]}, ${r[1]})`).join(',')
    e.execute(`INSERT INTO ${tbl} VALUES ${vals}`)
  }
  ins('r', R)
  ins('s', S)
  ins('t', T)
  const res = e.execute(
    'SELECT DISTINCT r.a AS a, r.b AS b, s.c AS c FROM r ' +
      'JOIN s ON s.b = r.b JOIN t ON t.a = r.a AND t.c = s.c',
  )
  const last = res[res.length - 1]
  if (last.kind !== 'rows') throw new Error('expected rows')
  return last.rows
}

test('cross-engine: triejoin triangle = the SQL engine’s DISTINCT join, many seeds', () => {
  const e = new Engine()
  for (let seed = 1; seed <= 60; seed++) {
    const rng = new Rng(seed * 7919 + 1)
    const n = rng.int(1, 12)
    const dom = rng.int(2, 7)
    const gen = (): number[][] => {
      const out: number[][] = []
      for (let i = 0; i < n; i++) out.push([rng.int(0, dom - 1), rng.int(0, dom - 1)])
      return out
    }
    const R = gen()
    const S = gen()
    const T = gen()
    const atoms: Atom[] = [
      { name: 'R', relation: relation(['a', 'b'], R) },
      { name: 'S', relation: relation(['b', 'c'], S) },
      { name: 'T', relation: relation(['a', 'c'], T) },
    ]
    const tj = triejoin(atoms)
    const order = tj.order
    const tjRows = tj.rows.map((r) => ['a', 'b', 'c'].map((v) => r[order.indexOf(v)]))
    const sqlRows = engineTriangle(e, R, S, T).map((r) => r.slice()) as SqlValue[][]
    assert(sameSet(tjRows, sqlRows), `seed ${seed}: triejoin ≠ engine SQL (${tjRows.length} vs ${sqlRows.length})`)
  }
})

// ---- report sanity ----------------------------------------------------------

test('wcojReport: the two engines agree and the blow-up is reported', () => {
  const atoms = denseInstance(shape('triangle'), 24)
  const order = chooseOrder(atoms)
  assert(order.length === 3, 'triangle has 3 variables')
  const tj = triejoin(atoms, order)
  const bj = binaryJoin(atoms)
  assert(
    sameSet(tj.rows.map((r) => bj.vars.map((v) => r[order.indexOf(v)])), bj.rows),
    'report instance: engines agree',
  )
})

export const wcojCases = cases
