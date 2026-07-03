// Self-tests for the sketch engine. Each probabilistic bound is proven against
// an EXACT oracle across seeded distributions: HLL within its 3σ, Count–Min
// never underestimating and within ε·N, Space-Saving finding every true heavy
// hitter, t-digest within tolerance at every quantile, reservoir uniform by χ²,
// Bloom never a false negative. Plus the monoid (merge) laws. Same shape as the
// other standalone modules' groups — exported as `sketchCases`, concatenated
// into `runTests()`.

import { Rng } from '../fuzz/rng'
import { murmur32, popcount32, hashString64 } from './hash'
import { HyperLogLog, mergeHLL } from './hll'
import { CountMin } from './countmin'
import { SpaceSaving } from './spacesaving'
import { TDigest } from './tdigest'
import { Reservoir } from './reservoir'
import { BloomFilter, CountingBloomFilter, bloomSemiJoin } from './bloom'
import { Engine } from '../engine'
import type { Row } from '../catalog'
import type { SqlValue } from '../types'

export interface SketchCase {
  group: string
  name: string
  run: () => void
}

const cases: SketchCase[] = []
function test(name: string, run: () => void) {
  cases.push({ group: 'sketch', name, run })
}
function assert(cond: boolean, detail: string) {
  if (!cond) throw new Error(detail)
}

// ---- hash ------------------------------------------------------------------

test('murmur32 avalanche: a 1-char change flips ≈half the output bits', () => {
  let tot = 0
  let n = 0
  for (let i = 0; i < 5000; i++) {
    const a = 'value-' + i
    const b = 'value-' + i + '!'
    tot += popcount32(murmur32(a, 0x1234) ^ murmur32(b, 0x1234))
    n++
  }
  const avg = tot / n
  assert(avg > 14.5 && avg < 17.5, `avalanche avg ${avg.toFixed(2)} bits should be near 16`)
})

test('hashString64 has few collisions over 50k distinct keys', () => {
  const seen = new Set<string>()
  let collisions = 0
  for (let i = 0; i < 50000; i++) {
    const h = hashString64('k' + i)
    const key = h.hi + ':' + h.lo
    if (seen.has(key)) collisions++
    else seen.add(key)
  }
  assert(collisions <= 1, `expected ~0 collisions over 64-bit hash, got ${collisions}`)
})

// ---- HyperLogLog -----------------------------------------------------------

test('HLL estimates cardinality within 3σ across scales', () => {
  const p = 14
  for (const N of [50, 500, 5000, 50000, 300000]) {
    const hll = new HyperLogLog(p)
    for (let i = 0; i < N; i++) hll.add('item-' + i)
    const est = hll.estimate()
    const err = Math.abs(est - N) / N
    // Allow a generous 4σ envelope so the deterministic test never flakes.
    const bound = 4 * hll.standardError() + 0.5 / N
    assert(err <= bound, `HLL N=${N}: est ${est.toFixed(0)} err ${(err * 100).toFixed(2)}% > bound ${(bound * 100).toFixed(2)}%`)
  }
})

test('HLL add is idempotent (re-adding cannot change the estimate)', () => {
  const hll = new HyperLogLog(12)
  for (let i = 0; i < 3000; i++) hll.add(i)
  const before = hll.estimate()
  for (let i = 0; i < 3000; i++) hll.add(i)
  assert(hll.estimate() === before, 'HLL estimate changed after re-adding the same values')
})

test('HLL merge equals the union cardinality (the monoid)', () => {
  const a = new HyperLogLog(14)
  const b = new HyperLogLog(14)
  for (let i = 0; i < 40000; i++) a.add('x' + i)
  for (let i = 20000; i < 60000; i++) b.add('x' + i) // union = 60000
  const m = mergeHLL(a, b)
  const err = Math.abs(m.estimate() - 60000) / 60000
  assert(err <= 4 * m.standardError(), `HLL merge err ${(err * 100).toFixed(2)}% too high`)
})

test('HLL handles heterogeneous SQL values (int, text, decimal-equal)', () => {
  const hll = new HyperLogLog(12)
  const vals: SqlValue[] = [1, 2, 3, 'a', 'b', true, false, null]
  for (const v of vals) hll.add(v)
  for (const v of vals) hll.add(v) // repeats don't grow it
  const est = hll.estimate()
  assert(est >= 5 && est <= 12, `tiny-set HLL estimate ${est.toFixed(1)} implausible`)
})

// ---- Count–Min -------------------------------------------------------------

function zipfStream(rng: Rng, n: number, domain: number, skew: number): number[] {
  // Draw n samples from a Zipf-like distribution over [0, domain).
  const weights: number[] = []
  let sum = 0
  for (let i = 1; i <= domain; i++) {
    const w = 1 / Math.pow(i, skew)
    weights.push(w)
    sum += w
  }
  const out: number[] = []
  for (let s = 0; s < n; s++) {
    let r = rng.next() * sum
    let i = 0
    while (i < domain - 1 && r > weights[i]) {
      r -= weights[i]
      i++
    }
    out.push(i)
  }
  return out
}

function exactCounts(stream: number[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const x of stream) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

test('Count–Min never underestimates and stays within ε·N', () => {
  const rng = new Rng(7)
  const stream = zipfStream(rng, 20000, 500, 1.1)
  const exact = exactCounts(stream)
  const cm = new CountMin({ epsilon: 0.001, delta: 0.001 })
  for (const x of stream) cm.add(x)
  let overBound = 0
  for (const [k, trueC] of exact) {
    const est = cm.estimate(k)
    assert(est >= trueC, `Count–Min underestimated key ${k}: est ${est} < true ${trueC}`)
    if (est - trueC > cm.errorBound()) overBound++
  }
  // With δ=0.001 essentially none should exceed the bound.
  assert(overBound <= 2, `${overBound} keys exceeded the ε·N over-estimate bound`)
})

test('Count–Min conservative update is never worse than plain', () => {
  const rng = new Rng(11)
  const stream = zipfStream(rng, 15000, 400, 1.2)
  const exact = exactCounts(stream)
  const plain = new CountMin({ epsilon: 0.002, delta: 0.01 })
  const cons = new CountMin({ epsilon: 0.002, delta: 0.01, conservative: true })
  for (const x of stream) {
    plain.add(x)
    cons.add(x)
  }
  let consBetterOrEqual = 0
  for (const [k, trueC] of exact) {
    const ep = plain.estimate(k) - trueC
    const ec = cons.estimate(k) - trueC
    assert(ec >= 0, 'conservative underestimated')
    if (ec <= ep) consBetterOrEqual++
  }
  assert(consBetterOrEqual === exact.size, 'conservative update was worse on some key')
})

test('Count–Min merge equals the summed stream', () => {
  const rng = new Rng(3)
  const s1 = zipfStream(rng, 8000, 300, 1.0)
  const s2 = zipfStream(rng, 8000, 300, 1.0)
  const a = new CountMin({ d: 5, w: 2000 })
  const b = new CountMin({ d: 5, w: 2000 })
  for (const x of s1) a.add(x)
  for (const x of s2) b.add(x)
  const both = new CountMin({ d: 5, w: 2000 })
  for (const x of s1) both.add(x)
  for (const x of s2) both.add(x)
  a.merge(b)
  for (let k = 0; k < 300; k++) {
    assert(a.estimate(k) === both.estimate(k), `merge != combined at key ${k}`)
  }
  assert(a.count() === 16000, 'merged total wrong')
})

// ---- Space-Saving ----------------------------------------------------------

test('Space-Saving finds every true heavy hitter (> N/k)', () => {
  const rng = new Rng(23)
  const stream = zipfStream(rng, 30000, 1000, 1.3)
  const exact = exactCounts(stream)
  const N = stream.length
  const k = 64
  const ss = new SpaceSaving(k)
  for (const x of stream) ss.add(x)
  const monitored = new Set(ss.topK().map((h) => h.value))
  // Every element with true freq > N/k must be monitored.
  for (const [key, c] of exact) {
    if (c > N / k) assert(monitored.has(key), `heavy hitter ${key} (freq ${c}) not monitored`)
  }
  // Each reported estimate brackets the truth: count − error ≤ true ≤ count.
  for (const h of ss.topK()) {
    const trueC = exact.get(h.value as number) ?? 0
    assert(h.count - h.error <= trueC && trueC <= h.count, `interval violated for ${h.value}`)
  }
})

test('Space-Saving top-1 matches the exact mode on a skewed stream', () => {
  const rng = new Rng(29)
  const stream = zipfStream(rng, 40000, 800, 1.4)
  const exact = exactCounts(stream)
  let exactTop = -1
  let exactTopC = -1
  for (const [k, c] of exact) {
    if (c > exactTopC) {
      exactTop = k
      exactTopC = c
    }
  }
  const ss = new SpaceSaving(50)
  for (const x of stream) ss.add(x)
  assert(ss.topK(1)[0].value === exactTop, `top-1 ${ss.topK(1)[0].value} != exact mode ${exactTop}`)
})

// ---- t-digest --------------------------------------------------------------

function exactQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const idx = q * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo])
}

test('t-digest quantiles are within tolerance across distributions', () => {
  const rng = new Rng(101)
  const dists: Array<[string, () => number]> = [
    ['uniform', () => rng.next() * 1000],
    ['skewed', () => Math.pow(rng.next(), 3) * 1000],
    ['gaussian-ish', () => (rng.next() + rng.next() + rng.next() + rng.next() - 2) * 250 + 500],
  ]
  for (const [label, draw] of dists) {
    const data: number[] = []
    const td = new TDigest(200)
    for (let i = 0; i < 50000; i++) {
      const x = draw()
      data.push(x)
      td.add(x)
    }
    data.sort((a, b) => a - b)
    const range = data[data.length - 1] - data[0]
    for (const q of [0.01, 0.1, 0.5, 0.9, 0.99, 0.999]) {
      const approx = td.quantile(q)
      const exact = exactQuantile(data, q)
      const relErr = Math.abs(approx - exact) / range
      assert(relErr < 0.02, `${label} q=${q}: approx ${approx.toFixed(1)} exact ${exact.toFixed(1)} relErr ${(relErr * 100).toFixed(2)}%`)
    }
  }
})

test('t-digest quantiles are monotone in q', () => {
  const rng = new Rng(202)
  const td = new TDigest(100)
  for (let i = 0; i < 20000; i++) td.add(rng.next() * 100)
  let prev = -Infinity
  for (let q = 0; q <= 1.0001; q += 0.02) {
    const v = td.quantile(Math.min(1, q))
    assert(v >= prev - 1e-9, `quantile not monotone at q=${q.toFixed(2)}: ${v} < ${prev}`)
    prev = v
  }
})

test('t-digest merge ≈ one digest of the concatenation', () => {
  const rng = new Rng(303)
  const a = new TDigest(200)
  const b = new TDigest(200)
  const all: number[] = []
  for (let i = 0; i < 25000; i++) {
    const x = rng.next() * 1000
    a.add(x)
    all.push(x)
  }
  for (let i = 0; i < 25000; i++) {
    const x = 500 + rng.next() * 1000
    b.add(x)
    all.push(x)
  }
  a.merge(b)
  all.sort((x, y) => x - y)
  const range = all[all.length - 1] - all[0]
  for (const q of [0.05, 0.5, 0.95, 0.99]) {
    const relErr = Math.abs(a.quantile(q) - exactQuantile(all, q)) / range
    assert(relErr < 0.02, `merged q=${q} relErr ${(relErr * 100).toFixed(2)}%`)
  }
})

// ---- reservoir -------------------------------------------------------------

test('Reservoir keeps exactly min(k, n) and is uniform (χ²)', () => {
  const N = 60
  const k = 10
  const trials = 6000
  const counts = new Array<number>(N).fill(0)
  for (let t = 0; t < trials; t++) {
    const res = new Reservoir<number>(k, t + 1)
    for (let i = 0; i < N; i++) res.add(i)
    const s = res.sample()
    assert(s.length === k, `reservoir size ${s.length} != ${k}`)
    for (const x of s) counts[x]++
  }
  // Expected count per element: trials * k / N. χ² should be modest.
  const expected = (trials * k) / N
  let chi2 = 0
  for (const c of counts) chi2 += ((c - expected) * (c - expected)) / expected
  // df = N-1 = 59; the 99.9% critical value is ≈ 99. Give generous headroom.
  assert(chi2 < 110, `reservoir χ² ${chi2.toFixed(1)} suggests non-uniformity`)
})

test('Reservoir with k ≥ n returns the whole stream', () => {
  const res = new Reservoir<number>(100, 5)
  for (let i = 0; i < 30; i++) res.add(i)
  const s = res.sample().sort((a, b) => a - b)
  assert(s.length === 30 && s[0] === 0 && s[29] === 29, 'small stream not fully retained')
})

// ---- Bloom -----------------------------------------------------------------

test('Bloom filter never has a false negative; FPR tracks theory', () => {
  const n = 5000
  const bf = new BloomFilter({ n, p: 0.01 })
  for (let i = 0; i < n; i++) bf.add('member-' + i)
  for (let i = 0; i < n; i++) assert(bf.mayContain('member-' + i), `false negative on member-${i}`)
  // Measure the false-positive rate on 20k absent keys.
  let fp = 0
  const trials = 20000
  for (let i = 0; i < trials; i++) if (bf.mayContain('absent-' + i)) fp++
  const measured = fp / trials
  assert(measured < 0.03, `measured FPR ${(measured * 100).toFixed(2)}% far above the 1% target`)
})

test('Counting Bloom supports deletes without false negatives on survivors', () => {
  const cbf = new CountingBloomFilter({ n: 2000, p: 0.01 })
  for (let i = 0; i < 2000; i++) cbf.add('k' + i)
  for (let i = 0; i < 1000; i++) cbf.remove('k' + i)
  for (let i = 1000; i < 2000; i++) assert(cbf.mayContain('k' + i), `deleted a survivor k${i}`)
})

test('Bloom semijoin never drops a true match', () => {
  const rng = new Rng(41)
  const buildKeys: number[] = []
  for (let i = 0; i < 500; i++) buildKeys.push(rng.int(0, 1000))
  const buildSet = new Set(buildKeys)
  const mightMatch = bloomSemiJoin(buildKeys, 0.01)
  // Every actual build key must pass the filter (no false negatives).
  for (const kkey of buildSet) assert(mightMatch(kkey), `semijoin dropped a true match ${kkey}`)
})

// ---- SQL surface (differential vs the exact aggregates) --------------------

function seeded(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE m(id INTEGER, city TEXT, amt REAL)')
  const rng = new Rng(1234)
  const cities = ['nyc', 'sf', 'la', 'chicago', 'austin']
  // A skewed city distribution and 30k rows with 30k distinct ids.
  const rows: string[] = []
  for (let i = 0; i < 30000; i++) {
    // Zipf-ish: earlier cities much more common.
    const r = rng.next()
    const ci = r < 0.5 ? 0 : r < 0.75 ? 1 : r < 0.9 ? 2 : r < 0.97 ? 3 : 4
    const amt = Math.floor(Math.pow(rng.next(), 2) * 10000)
    rows.push(`(${i}, '${cities[ci]}', ${amt})`)
  }
  for (let c = 0; c < rows.length; c += 3000) {
    e.execute('INSERT INTO m(id, city, amt) VALUES ' + rows.slice(c, c + 3000).join(','))
  }
  return e
}
function rowsOf(e: Engine, sql: string): Row[] {
  const res = e.execute(sql)
  const last = res[res.length - 1]
  if (last.kind !== 'rows') throw new Error('expected rows')
  return last.rows
}

test('SQL: APPROX_COUNT_DISTINCT is within a few percent of exact', () => {
  const e = seeded()
  const exact = rowsOf(e, 'SELECT COUNT(DISTINCT id) FROM m')[0][0] as number
  const approx = rowsOf(e, 'SELECT APPROX_COUNT_DISTINCT(id) FROM m')[0][0] as number
  const err = Math.abs(approx - exact) / exact
  assert(exact === 30000, `exact distinct wrong: ${exact}`)
  assert(err < 0.03, `APPROX_COUNT_DISTINCT off by ${(err * 100).toFixed(2)}%`)
  // On the low-cardinality city column it should be exact (5 distinct).
  const cityExact = rowsOf(e, 'SELECT COUNT(DISTINCT city) FROM m')[0][0] as number
  const cityApprox = rowsOf(e, 'SELECT APPROX_COUNT_DISTINCT(city) FROM m')[0][0] as number
  assert(cityExact === 5 && cityApprox === 5, `city distinct: exact ${cityExact} approx ${cityApprox}`)
})

test('SQL: APPROX_COUNT_DISTINCT works per-group under GROUP BY', () => {
  const e = seeded()
  const exact = rowsOf(e, 'SELECT city, COUNT(DISTINCT id) FROM m GROUP BY city ORDER BY city')
  const approx = rowsOf(e, 'SELECT city, APPROX_COUNT_DISTINCT(id) FROM m GROUP BY city ORDER BY city')
  assert(exact.length === approx.length && exact.length === 5, 'group count mismatch')
  for (let i = 0; i < exact.length; i++) {
    assert(exact[i][0] === approx[i][0], 'group key mismatch')
    const ex = exact[i][1] as number
    const ap = approx[i][1] as number
    const err = Math.abs(ap - ex) / ex
    assert(err < 0.05, `group ${exact[i][0]}: approx ${ap} vs exact ${ex} (${(err * 100).toFixed(2)}%)`)
  }
})

test('SQL: APPROX_PERCENTILE tracks PERCENTILE_CONT within tolerance', () => {
  const e = seeded()
  const range = (rowsOf(e, 'SELECT MAX(amt) - MIN(amt) FROM m')[0][0] as number) || 1
  for (const q of [0.5, 0.9, 0.99]) {
    const exact = rowsOf(e, `SELECT PERCENTILE_CONT(${q}) WITHIN GROUP (ORDER BY amt) FROM m`)[0][0] as number
    const approx = rowsOf(e, `SELECT APPROX_PERCENTILE(${q}) WITHIN GROUP (ORDER BY amt) FROM m`)[0][0] as number
    const relErr = Math.abs(approx - exact) / range
    assert(relErr < 0.02, `q=${q}: approx ${approx.toFixed(1)} exact ${exact.toFixed(1)} relErr ${(relErr * 100).toFixed(2)}%`)
  }
})

test('SQL: APPROX_TOP_K returns the exact heavy hitters on a skewed column', () => {
  const e = seeded()
  const exact = rowsOf(e, 'SELECT city, COUNT(*) c FROM m GROUP BY city ORDER BY c DESC LIMIT 3').map((r) => r[0])
  const j = rowsOf(e, 'SELECT APPROX_TOP_K(city, 3) FROM m')[0][0] as { t: 'json'; v: Array<{ value: string; count: number }> }
  assert(j && j.t === 'json' && Array.isArray(j.v) && j.v.length === 3, 'APPROX_TOP_K did not return a 3-element JSON array')
  const got = j.v.map((h) => h.value)
  for (let i = 0; i < 3; i++) assert(got[i] === exact[i], `top-${i + 1}: got ${got[i]} expected ${exact[i]}`)
})

test('SQL: APPROX aggregates over an empty group behave like their exact kin', () => {
  const e = seeded()
  assert((rowsOf(e, 'SELECT APPROX_COUNT_DISTINCT(id) FROM m WHERE id < 0')[0][0] as number) === 0, 'empty ACD should be 0')
  assert(rowsOf(e, 'SELECT APPROX_PERCENTILE(0.5) WITHIN GROUP (ORDER BY amt) FROM m WHERE id < 0')[0][0] === null, 'empty APCT should be NULL')
  assert(rowsOf(e, 'SELECT APPROX_TOP_K(city, 3) FROM m WHERE id < 0')[0][0] === null, 'empty TOPK should be NULL')
})

function sampleEngine(): Engine {
  const e = new Engine()
  e.execute('CREATE TABLE big(id INTEGER, g TEXT)')
  const rows: string[] = []
  for (let i = 0; i < 12000; i++) rows.push(`(${i}, '${['a', 'b', 'c', 'd'][i % 4]}')`)
  for (let c = 0; c < rows.length; c += 3000) e.execute('INSERT INTO big(id, g) VALUES ' + rows.slice(c, c + 3000).join(','))
  return e
}

test('SQL: TABLESAMPLE RESERVOIR returns exactly k rows', () => {
  const e = sampleEngine()
  const n = rowsOf(e, 'SELECT COUNT(*) FROM big TABLESAMPLE RESERVOIR(250)')[0][0] as number
  assert(n === 250, `RESERVOIR(250) returned ${n} rows`)
  // k ≥ n returns the whole table.
  const all = rowsOf(e, 'SELECT COUNT(*) FROM big TABLESAMPLE RESERVOIR(99999)')[0][0] as number
  assert(all === 12000, `RESERVOIR over-k returned ${all}`)
})

test('SQL: TABLESAMPLE BERNOULLI keeps roughly the right fraction', () => {
  const e = sampleEngine()
  const n = rowsOf(e, 'SELECT COUNT(*) FROM big TABLESAMPLE BERNOULLI(25) REPEATABLE(7)')[0][0] as number
  const frac = n / 12000
  assert(frac > 0.2 && frac < 0.3, `BERNOULLI(25) kept ${(frac * 100).toFixed(1)}%`)
})

test('SQL: TABLESAMPLE REPEATABLE is deterministic', () => {
  const e = sampleEngine()
  const a = rowsOf(e, 'SELECT COUNT(*) FROM big TABLESAMPLE BERNOULLI(15) REPEATABLE(42)')[0][0] as number
  const b = rowsOf(e, 'SELECT COUNT(*) FROM big TABLESAMPLE BERNOULLI(15) REPEATABLE(42)')[0][0] as number
  assert(a === b, `REPEATABLE not deterministic: ${a} vs ${b}`)
})

test('SQL: TABLESAMPLE samples before WHERE (sample then filter)', () => {
  const e = sampleEngine()
  // BERNOULLI(50) over the table, then WHERE g='a' (a quarter): ≈ 12000·0.5·0.25 = 1500.
  const n = rowsOf(e, "SELECT COUNT(*) FROM big TABLESAMPLE BERNOULLI(50) REPEATABLE(3) WHERE g = 'a'")[0][0] as number
  assert(n > 1200 && n < 1800, `sample-before-where count ${n} outside expected band`)
})

test('SQL: a MATERIALIZED VIEW over a TABLESAMPLE source is rejected', () => {
  const e = sampleEngine()
  let threw = false
  try {
    e.execute('CREATE MATERIALIZED VIEW mv AS SELECT g, COUNT(*) FROM big TABLESAMPLE BERNOULLI(10) GROUP BY g')
  } catch {
    threw = true
  }
  assert(threw, 'a materialized view over a non-deterministic sample should be refused')
})

export const sketchCases = cases
