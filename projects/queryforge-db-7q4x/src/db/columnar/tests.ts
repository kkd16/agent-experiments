// Self-tests for the column store. Held to the same differential + invariant
// bar as the other standalone modules (storage / lsm / sketch / wcoj):
//
//   • every encoding is a byte-for-byte round-trip (decode == original),
//     across seeded columns of every value type, with NULLs;
//   • the bit-packer round-trips at every width, incl. random access;
//   • the auto-encoder picks the smallest legal encoding and never beats a
//     lossy shortcut (it is always ≤ PLAIN and equal to the true minimum);
//   • the zone map equals a brute-force min/max/null/distinct;
//   • **zone-map pruning is sound** — a pruned group provably holds zero
//     matches (decode it and check), so pruning can never change an answer;
//   • **a full predicate scan equals a brute-force filter** over the original
//     rows, in the same order, over thousands of seeded predicate conjunctions
//     and projections — the headline differential;
//   • the cost metrics are internally consistent (scanned+pruned == groups,
//     decoded ≤ full-scan, matched == the oracle count).
//
// Exported as `columnarCases`, concatenated into `runTests()`.

import { Rng } from '../fuzz/rng'
import { asTemporalKind } from '../temporal'
import { parseDecimal } from '../decimal'
import { jsonOf } from '../json'
import { orderValues, hashKey, type SqlValue } from '../types'
import { bitsFor, packBits, unpackBits, readAt, zigzag, unzigzag } from './bitpack'
import {
  encodeColumn,
  encodeColumnAs,
  decodeColumn,
  decodePresent,
  presentAt,
  availableEncodings,
  computeZone,
} from './encodings'
import { ColumnStore, canMatch, matchRow as matchRowExport, type Predicate } from './store'
import { runBench, generateDataset } from './bench'

export interface ColumnarCase {
  group: string
  name: string
  run: () => void
}

const cases: ColumnarCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'columnar', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

/** Deep equality of two columns of SqlValues (via the engine's total order). */
function colsEqual(a: SqlValue[], b: SqlValue[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const an = a[i] === null
    const bn = b[i] === null
    if (an || bn) {
      if (an !== bn) return false
    } else if (orderValues(a[i], b[i]) !== 0) return false
  }
  return true
}

function rowsEqual(a: SqlValue[][], b: SqlValue[][]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!colsEqual(a[i], b[i])) return false
  return true
}

// ---- column generators (seeded, one per value shape) -----------------------

type Gen = (rng: Rng) => SqlValue

const GENS: Record<string, Gen> = {
  smallint: (r) => (r.chance(0.1) ? null : r.int(0, 20)), // low card, dict/rle-friendly
  wideint: (r) => (r.chance(0.1) ? null : 1_000_000 + r.int(0, 500)), // FOR-friendly
  real: (r) => (r.chance(0.1) ? null : Math.round(r.next() * 1e4) / 100),
  text: (r) => (r.chance(0.1) ? null : r.pick(['alpha', 'beta', 'gamma', 'delta'])), // dict/rle
  bigtext: (r) => (r.chance(0.1) ? null : `k${r.int(0, 1 << 20).toString(36)}`), // high card
  bool: (r) => (r.chance(0.1) ? null : r.chance()),
}

function genColumn(rng: Rng, gen: Gen, n: number): SqlValue[] {
  return Array.from({ length: n }, () => gen(rng))
}

/** A monotone integer column (exercises DELTA). */
function genMonotone(rng: Rng, n: number): SqlValue[] {
  let x = rng.int(0, 1000)
  return Array.from({ length: n }, () => {
    x += rng.int(0, 4)
    return rng.chance(0.05) ? null : x
  })
}

// ---- bitpack ---------------------------------------------------------------

test('bitpack: round-trips at every width, incl. random access & width 0', () => {
  const rng = new Rng(1)
  for (let trial = 0; trial < 200; trial++) {
    const width = rng.int(0, 24)
    const cap = width === 0 ? 1 : 2 ** width
    const n = rng.int(0, 40)
    const vals = Array.from({ length: n }, () => rng.int(0, cap - 1))
    const packed = packBits(vals, width)
    const back = unpackBits(packed, width, n)
    assert(back.length === n && back.every((v, i) => v === vals[i]), `unpack != pack at width ${width}`)
    for (let i = 0; i < n; i++) assert(readAt(packed, width, i) === vals[i], `readAt mismatch @${i} width ${width}`)
    // packed size is tight
    assert(packed.length === ((n * width + 7) >> 3), `packed size not tight at width ${width}`)
  }
})

test('bitpack: zigzag is a bijection over a signed range', () => {
  for (let n = -5000; n <= 5000; n++) assert(unzigzag(zigzag(n)) === n, `zigzag broke at ${n}`)
  assert(zigzag(0) === 0 && zigzag(-1) === 1 && zigzag(1) === 2, 'zigzag base cases')
})

test('bitsFor: exact bit widths', () => {
  assert(bitsFor(0) === 0, 'bitsFor(0)')
  assert(bitsFor(1) === 1, 'bitsFor(1)')
  assert(bitsFor(255) === 8, 'bitsFor(255)')
  assert(bitsFor(256) === 9, 'bitsFor(256)')
})

// ---- encoding round-trips --------------------------------------------------

test('every encoding round-trips byte-for-byte over every column shape', () => {
  const rng = new Rng(7)
  for (const [name, gen] of Object.entries(GENS)) {
    for (let trial = 0; trial < 30; trial++) {
      const col = genColumn(rng, gen, rng.int(0, 200))
      for (const kind of availableEncodings(col)) {
        const chunk = encodeColumnAs(kind, col)
        assert(colsEqual(decodeColumn(chunk), col), `decode(${kind}) != original for ${name}`)
      }
      // the auto-encoder round-trips too
      assert(colsEqual(decodeColumn(encodeColumn(col)), col), `auto-decode != original for ${name}`)
    }
  }
})

test('DELTA & BITPACK round-trip a monotone integer column', () => {
  const rng = new Rng(11)
  for (let trial = 0; trial < 40; trial++) {
    const col = genMonotone(rng, rng.int(1, 300))
    for (const kind of availableEncodings(col)) {
      assert(colsEqual(decodeColumn(encodeColumnAs(kind, col)), col), `decode(${kind}) != monotone original`)
    }
    // a monotone integer column should prefer DELTA (smallest)
    assert(availableEncodings(col).includes('delta'), 'monotone column should offer DELTA')
  }
})

test('rich value types (DECIMAL / DATE / JSON) round-trip through the store', () => {
  const decs: SqlValue[] = ['1.50', '2.25', null, '1.50', '99.99'].map((s) => (s === null ? null : parseDecimal(s)))
  const dates: SqlValue[] = ['2026-01-05', '2026-01-05', '2026-03-30', null, '2025-12-31'].map((s) =>
    s === null ? null : asTemporalKind('date', s),
  )
  const jsons: SqlValue[] = [jsonOf({ a: 1 }), jsonOf([1, 2]), null, jsonOf({ a: 1 }), jsonOf('x')]
  for (const col of [decs, dates, jsons]) {
    assert(colsEqual(decodeColumn(encodeColumn(col)), col), 'rich-type column did not round-trip')
    for (const kind of availableEncodings(col)) {
      assert(colsEqual(decodeColumn(encodeColumnAs(kind, col)), col), `rich-type decode(${kind}) mismatch`)
    }
  }
})

test('presentAt random access == the dense decoded present order', () => {
  const rng = new Rng(13)
  for (const gen of Object.values(GENS)) {
    const col = genColumn(rng, gen, rng.int(1, 150))
    for (const kind of availableEncodings(col)) {
      const chunk = encodeColumnAs(kind, col)
      const present = decodePresent(chunk)
      for (let t = 0; t < 30; t++) {
        const j = rng.int(0, Math.max(0, present.length - 1))
        if (present.length === 0) continue
        assert(orderValues(presentAt(chunk, j), present[j]) === 0, `presentAt(${kind}) mismatch @${j}`)
      }
    }
  }
})

// ---- auto-encoder + zone map ----------------------------------------------

test('auto-encoder picks the true minimum and never loses to PLAIN', () => {
  const rng = new Rng(17)
  for (let trial = 0; trial < 120; trial++) {
    const gen = rng.pick(Object.values(GENS))
    const col = genColumn(rng, gen, rng.int(0, 200))
    const chosen = encodeColumn(col)
    let min = Infinity
    for (const k of availableEncodings(col)) min = Math.min(min, encodeColumnAs(k, col).byteSize)
    assert(chosen.byteSize === min, 'auto-encoder did not pick the minimum')
    assert(chosen.byteSize <= encodeColumnAs('plain', col).byteSize, 'chosen encoding is larger than PLAIN')
  }
})

test('zone map == brute-force min/max/null/distinct', () => {
  const rng = new Rng(19)
  for (let trial = 0; trial < 120; trial++) {
    const gen = rng.pick(Object.values(GENS))
    const col = genColumn(rng, gen, rng.int(0, 200))
    const present = col.filter((v) => v !== null)
    const z = computeZone(col, present, col.length - present.length)
    // brute force
    let min: SqlValue = null
    let max: SqlValue = null
    const seen = new Set<string>()
    for (const v of present) {
      if (min === null || orderValues(v, min) < 0) min = v
      if (max === null || orderValues(v, max) > 0) max = v
      seen.add(hashKey([v]))
    }
    assert(z.count === col.length, 'zone count')
    assert(z.nullCount === col.length - present.length, 'zone nullCount')
    assert(z.distinct === seen.size, 'zone distinct')
    assert((z.min === null && min === null) || orderValues(z.min, min) === 0, 'zone min')
    assert((z.max === null && max === null) || orderValues(z.max, max) === 0, 'zone max')
  }
})

// ---- zone-map pruning soundness -------------------------------------------

test('zone-map pruning is sound: a pruned group holds zero matches', () => {
  const rng = new Rng(23)
  const cols = ['a', 'b']
  for (let trial = 0; trial < 60; trial++) {
    const n = rng.int(1, 600)
    const rows: SqlValue[][] = []
    const genA = rng.pick([GENS.smallint, GENS.wideint, GENS.text, GENS.real])
    const genB = rng.pick([GENS.smallint, GENS.text, GENS.bool])
    for (let i = 0; i < n; i++) rows.push([genA(rng), genB(rng)])
    const store = new ColumnStore(cols, rows, rng.pick([8, 32, 128]))
    for (let q = 0; q < 8; q++) {
      const pred = randomPredicate(rng, store, cols)
      for (const g of store.groups) {
        if (canMatch(pred, g.chunks[pred.col].zone)) continue
        // pruned ⇒ NO row in the group may match
        const decoded = decodeColumn(g.chunks[pred.col])
        assert(decoded.every((cell) => !matchRowExport(pred, cell)), `unsound prune: ${JSON.stringify(pred)}`)
      }
    }
  }
})

// ---- the headline differential: scan == brute force ------------------------

function randomPredicate(rng: Rng, store: ColumnStore, cols: string[]): Predicate {
  const col = rng.pick(cols)
  // sample a domain value from the store (bias toward in-range so some match)
  const sample = () => {
    const g = rng.pick(store.groups)
    const decoded = decodeColumn(g.chunks[col]).filter((v) => v !== null)
    if (decoded.length === 0) return 0 as SqlValue
    return rng.pick(decoded)
  }
  const roll = rng.int(0, 9)
  if (roll === 0) return { kind: 'isnull', col }
  if (roll === 1) return { kind: 'notnull', col }
  if (roll === 2) {
    const vals = [sample(), sample(), sample()]
    return { kind: 'in', col, values: vals }
  }
  if (roll === 3) {
    let lo = sample()
    let hi = sample()
    if (lo !== null && hi !== null && orderValues(lo, hi) > 0) [lo, hi] = [hi, lo]
    return { kind: 'between', col, lo, hi }
  }
  const op = rng.pick(['=', '<>', '<', '<=', '>', '>='] as const)
  return { kind: 'cmp', col, op, value: sample() }
}

test('scan == brute-force filter+project over thousands of seeded predicates', () => {
  const rng = new Rng(29)
  const cols = ['a', 'b', 'c']
  for (let trial = 0; trial < 120; trial++) {
    const n = rng.int(0, 500)
    const gens = [rng.pick(Object.values(GENS)), rng.pick(Object.values(GENS)), rng.pick(Object.values(GENS))]
    const rows: SqlValue[][] = []
    for (let i = 0; i < n; i++) rows.push(gens.map((g) => g(rng)))
    const store = new ColumnStore(cols, rows, rng.pick([8, 16, 64]))

    for (let q = 0; q < 6; q++) {
      const k = rng.int(0, 2)
      const preds: Predicate[] = Array.from({ length: k }, () => randomPredicate(rng, store, cols))
      const project = rng.subset(cols)
      const res = store.scan(preds, project)

      // oracle: filter the ORIGINAL rows, project the same columns, same order
      const projIdx = project.map((c) => cols.indexOf(c))
      const expected: SqlValue[][] = []
      let matched = 0
      for (const r of rows) {
        if (preds.every((p) => matchRowExport(p, r[cols.indexOf(p.col)]))) {
          matched++
          expected.push(projIdx.map((i) => r[i]))
        }
      }
      assert(rowsEqual(res.rows, expected), `scan != oracle: preds=${JSON.stringify(preds)} proj=${project}`)
      assert(res.metrics.matched === matched, 'metrics.matched != oracle count')
      assert(
        res.metrics.groupsScanned + res.metrics.groupsPruned === res.metrics.totalGroups,
        'scanned+pruned != totalGroups',
      )
      assert(res.metrics.valuesDecoded <= res.metrics.fullScanValues, 'decoded more than a full row-store scan')
    }
  }
})

test('compressed execution: scanCompressed == scan across seeded predicates', () => {
  const rng = new Rng(41)
  const cols = ['a', 'b', 'c']
  for (let trial = 0; trial < 120; trial++) {
    const n = rng.int(0, 500)
    // bias toward dict/rle-friendly columns so pushdown actually fires
    const gens = [
      rng.pick([GENS.smallint, GENS.text, GENS.bool]),
      rng.pick(Object.values(GENS)),
      rng.pick([GENS.smallint, GENS.text]),
    ]
    const rows: SqlValue[][] = []
    for (let i = 0; i < n; i++) rows.push(gens.map((g) => g(rng)))
    const store = new ColumnStore(cols, rows, rng.pick([8, 16, 64]))

    for (let q = 0; q < 6; q++) {
      const k = rng.int(0, 2)
      const preds: Predicate[] = Array.from({ length: k }, () => randomPredicate(rng, store, cols))
      const project = rng.subset(cols)
      const plain = store.scan(preds, project)
      const comp = store.scanCompressed(preds, project)
      assert(rowsEqual(comp.rows, plain.rows), `scanCompressed != scan: preds=${JSON.stringify(preds)} proj=${project}`)
      assert(comp.metrics.matched === plain.metrics.matched, 'compressed matched != scan matched')
      assert(
        comp.metrics.groupsScanned + comp.metrics.groupsPruned === comp.metrics.totalGroups,
        'compressed group accounting',
      )
    }
  }
})

test('compressed execution pushes a predicate to the dictionary, not the rows', () => {
  // A low-cardinality column across many rows: a filter must compare the handful
  // of distinct values, not every row (predEvaluations ≪ fullScanCompares).
  const rng = new Rng(43)
  const n = 4000
  const rows: SqlValue[][] = []
  for (let i = 0; i < n; i++) rows.push([rng.pick(['active', 'churned', 'trial', 'new']), rng.int(0, 1_000_000)])
  const store = new ColumnStore(['status', 'v'], rows, 256)
  const comp = store.scanCompressed([{ kind: 'cmp', col: 'status', op: '=', value: 'active' }], ['v'])
  assert(comp.metrics.pushedGroups === comp.metrics.groupsScanned, 'every scanned group should push down a dict/rle predicate')
  // 16 groups × ≤4 distinct ≈ ≤64 evals vs 4000 row compares
  assert(comp.metrics.predEvaluations < comp.metrics.fullScanCompares * 0.1, 'pushdown did not cut predicate evaluations')
  // and it still returns exactly the matching rows
  const expected = rows.filter((r) => r[0] === 'active').length
  assert(comp.metrics.matched === expected, `compressed matched ${comp.metrics.matched} != ${expected}`)
})

test('projection + pruning genuinely decode less than a full scan', () => {
  // A monotone key across many groups: a top-slice predicate must prune most
  // groups and a 1-column projection must read far fewer than every cell.
  const rng = new Rng(31)
  const n = 4000
  const rows: SqlValue[][] = []
  let id = 0
  for (let i = 0; i < n; i++) {
    id += rng.int(1, 3)
    rows.push([id, rng.pick(['x', 'y', 'z']), 1_000_000 + rng.int(0, 255)])
  }
  const store = new ColumnStore(['id', 'g', 'v'], rows, 256)
  const cut = (rows[rows.length - 1][0] as number) - 100
  const res = store.scan([{ kind: 'cmp', col: 'id', op: '>=', value: cut }], ['v'])
  assert(res.metrics.groupsPruned > res.metrics.totalGroups * 0.5, 'expected >50% of groups pruned')
  assert(res.metrics.valuesDecoded < res.metrics.fullScanValues * 0.5, 'expected <50% of cells decoded')
})

// ---- the bench -------------------------------------------------------------

test('bench: columnar beats a row store & the auto-encoder specialises per column', () => {
  const b = runBench(0xc0_1d, 6000, 1024)
  assert(b.columnarBytes < b.rowStoreBytes, 'columnar not smaller than the row store')
  assert(b.ratio > 1, 'compression ratio ≤ 1')
  const by = Object.fromEntries(b.perColumn.map((c) => [c.name, c.chosen]))
  assert(by.id === 'delta', `id column should pick DELTA, got ${by.id}`)
  assert(by.region === 'dict' || by.region === 'rle', `region should pick DICT/RLE, got ${by.region}`)
  assert(by.status === 'rle' || by.status === 'dict', `status should pick RLE/DICT, got ${by.status}`)
  assert(b.groupsPruned > 0, 'the selective bench predicate pruned no groups')
  assert(b.groupsScanned + b.groupsPruned === b.totalGroups, 'bench group accounting')
})

test('bench: pruned + scanned scan still returns exactly the matching rows', () => {
  const b = runBench(0xbeef, 3000, 512)
  // matched must equal a brute-force count on the same generated data
  const { rows } = generateDataset(0xbeef, 3000)
  const cut = Number(b.prunePredicate.split('>= ')[1])
  const expected = rows.filter((r) => (r[0] as number) >= cut).length
  assert(b.matched === expected, `bench matched ${b.matched} != oracle ${expected}`)
})

export const columnarCases = cases
