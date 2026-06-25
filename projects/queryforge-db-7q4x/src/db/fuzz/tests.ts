// The `fuzz` self-test group. Two kinds of test live here:
//
//  1. **Metamorphic sweeps** — run the fuzzer for several *fixed* seeds and assert
//     zero counterexamples. Because the seed is fixed, this is a deterministic,
//     perpetual, randomized regression guard over the *entire* engine: every future
//     change has to keep ~thousands of random queries metamorphically consistent.
//
//  2. **Targeted regressions** — the three real correctness bugs the fuzzer found on
//     its first run, frozen as minimal hand-checked cases so they can never silently
//     come back. Each was a NULL / index-range defect the deterministic suite missed.

import { Engine } from '../engine'
import type { Row } from '../catalog'
import { formatValue } from '../types'
import { runFuzz } from './runner'

export interface FuzzCase {
  group: string
  name: string
  run: () => void
}

const cases: FuzzCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'fuzz', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

function rows(e: Engine, sql: string): Row[] {
  const rs = e.execute(sql)
  const last = rs[rs.length - 1]
  if (!last || last.kind !== 'rows') throw new Error('expected rows')
  return last.rows
}
function scalar(e: Engine, sql: string): unknown {
  return rows(e, sql)[0]?.[0]
}
/** Run a query with the optimizer on and off; assert identical multisets. */
function assertOptInvariant(e: Engine, sql: string) {
  const sig = (rs: Row[]) =>
    rs
      .map((r) => r.map(formatValue).join(''))
      .sort()
      .join('')
  e.settings.optimizer = true
  const on = sig(rows(e, sql))
  e.settings.optimizer = false
  const off = sig(rows(e, sql))
  e.settings.optimizer = true
  assert(on === off, `optimizer changed the result of: ${sql}`)
}

// --- metamorphic sweeps (deterministic) -------------------------------------
// A handful of fixed seeds, a few hundred queries each. Kept modest so the whole
// suite stays fast in CI / the browser; the Fuzz Lab runs orders of magnitude more.
for (const seed of [1, 7, 42, 99, 123, 256, 1000]) {
  test(`metamorphic sweep — seed ${seed} (no counterexamples)`, () => {
    const r = runFuzz(seed, 250, { shrinkBugs: false, maxBugs: 1 })
    assert(
      r.counterexamples.length === 0 && r.errors.length === 0,
      r.counterexamples.length
        ? `seed ${seed}: ${r.counterexamples[0].oracle} — ${r.counterexamples[0].detail}\n` +
            r.counterexamples[0].reproSql.join('\n')
        : `seed ${seed}: engine error — ${r.errors[0]?.detail}`,
    )
    assert(r.queriesRun > 250, 'the run should execute many queries')
  })
}

// --- targeted regressions (the three bugs the fuzzer found) ------------------

test('regression: index range scan excludes NULL keys (open-low `<`)', () => {
  // NoREC found this: `c < v` over a NULL-keyed indexed column wrongly returned the
  // NULL row, because the open-low range swept the leading NULL run out of the index.
  const e = new Engine()
  e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, c REAL)')
  e.execute('INSERT INTO t (id, c) VALUES (1, NULL), (2, 1.0), (3, NULL), (4, 9.0)')
  e.execute('CREATE INDEX ix ON t (c)')
  assert(JSON.stringify(rows(e, 'SELECT id FROM t WHERE c < 4.5 ORDER BY id')) === '[[2]]', '`c < 4.5` must skip NULLs')
  assert(JSON.stringify(rows(e, 'SELECT id FROM t WHERE c <= 1.0 ORDER BY id')) === '[[2]]', '`c <= 1.0` must skip NULLs')
  // The optimizer must not change the answer.
  assertOptInvariant(e, 'SELECT id FROM t WHERE c < 4.5')
  // And the NoREC identity the fuzzer used:
  assert(scalar(e, 'SELECT COUNT(*) FROM t WHERE c < 4.5') === scalar(e, 'SELECT COALESCE(SUM(CASE WHEN c < 4.5 THEN 1 ELSE 0 END), 0) FROM t'), 'NoREC')
})

test('regression: multiple range bounds on one indexed column intersect (tightest wins)', () => {
  // TLP found this: `c <= 2 AND c < 4.5` kept only the last-written bound (`< 4.5`),
  // losing the tighter `<= 2`, so a row with c = 4 leaked through.
  const e = new Engine()
  e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, c REAL)')
  e.execute('INSERT INTO t (id, c) VALUES (1, 1.0), (2, 3.0), (3, 4.0), (4, 2.0)')
  e.execute('CREATE INDEX ix ON t (c)')
  assert(JSON.stringify(rows(e, 'SELECT id FROM t WHERE c <= 2 AND c < 4.5 ORDER BY id')) === '[[1],[4]]', 'tightest upper bound wins')
  assert(JSON.stringify(rows(e, 'SELECT id FROM t WHERE c > 1 AND c >= 3 ORDER BY id')) === '[[2],[3]]', 'tightest lower bound wins')
  assertOptInvariant(e, 'SELECT id FROM t WHERE c <= 2 AND c < 4.5')
})

test('regression: BitmapAnd of single-column indexes excludes NULL keys', () => {
  // NoREC found this: `c1 < 1 AND c0 >= FALSE` intersected two index bitmaps, but the
  // `< 1` bitmap was open-low and pulled in the NULL row.
  const e = new Engine()
  e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, c0 BOOLEAN, c1 REAL)')
  e.execute('INSERT INTO t (id, c0, c1) VALUES (1, TRUE, NULL), (2, TRUE, 0.5), (3, FALSE, 0.5)')
  e.execute('CREATE INDEX ix0 ON t (c0)')
  e.execute('CREATE INDEX ix1 ON t (c1)')
  assert(scalar(e, 'SELECT COUNT(*) FROM t WHERE c1 < 1 AND c0 >= FALSE') === 2, 'NULL row excluded from the AND')
  assertOptInvariant(e, 'SELECT id FROM t WHERE c1 < 1 AND c0 >= FALSE')
})

test('regression: comparison against NULL never uses the index', () => {
  // `c = NULL` / `c < NULL` are always unknown; the index must not turn them into a
  // probe that matches NULL-keyed rows.
  const e = new Engine()
  e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, c INTEGER)')
  e.execute('INSERT INTO t (id, c) VALUES (1, NULL), (2, 5)')
  e.execute('CREATE INDEX ix ON t (c)')
  assert(rows(e, 'SELECT id FROM t WHERE c = NULL').length === 0, '`c = NULL` is never true')
  assert(rows(e, 'SELECT id FROM t WHERE c < NULL').length === 0, '`c < NULL` is never true')
})

export const fuzzCases = cases
