// Driver for the Sketch Lab: generate a stream from a chosen distribution, run
// each sketch at a sweep of precision settings, and return the exact-vs-estimate
// error and the memory footprint as plain data the UI charts. Kept in the db
// layer (not the component) so the experiments are self-testable.

import { Rng } from '../fuzz/rng'
import { HyperLogLog, mergeHLL } from './hll'
import { CountMin } from './countmin'
import { SpaceSaving } from './spacesaving'
import { TDigest } from './tdigest'
import { BloomFilter } from './bloom'

export type Distribution = 'uniform' | 'zipf' | 'gaussian' | 'clustered'

export const DISTRIBUTIONS: Array<{ id: Distribution; label: string; blurb: string }> = [
  { id: 'uniform', label: 'Uniform', blurb: 'every value equally likely' },
  { id: 'zipf', label: 'Zipf (skewed)', blurb: 'a few values dominate — the heavy-hitter regime' },
  { id: 'gaussian', label: 'Gaussian', blurb: 'a bell around the mean — a classic quantile target' },
  { id: 'clustered', label: 'Clustered', blurb: 'a handful of tight clusters' },
]

export interface Stream {
  /** Integer keys for cardinality / frequency sketches. */
  keys: number[]
  /** Real values for quantile sketches. */
  values: number[]
  /** True distinct count of `keys`. */
  exactDistinct: number
  /** True per-key frequencies. */
  exactCounts: Map<number, number>
  /** `values` sorted ascending (for exact quantiles). */
  sorted: number[]
}

/** Generate a reproducible stream of `n` items over a `domain` of distinct keys. */
export function genStream(dist: Distribution, n: number, domain: number, seed = 1): Stream {
  const rng = new Rng(seed)
  const keys: number[] = []
  const values: number[] = []
  // Precompute a Zipf CDF when needed.
  let zcdf: number[] | null = null
  if (dist === 'zipf') {
    zcdf = []
    let sum = 0
    for (let i = 1; i <= domain; i++) sum += 1 / Math.pow(i, 1.1)
    let acc = 0
    for (let i = 1; i <= domain; i++) {
      acc += 1 / Math.pow(i, 1.1) / sum
      zcdf.push(acc)
    }
  }
  const clusterCentres = [0.1, 0.35, 0.6, 0.85].map((c) => c * domain)
  for (let i = 0; i < n; i++) {
    let key: number
    let val: number
    switch (dist) {
      case 'uniform':
        key = rng.int(0, domain - 1)
        val = rng.next() * domain
        break
      case 'zipf': {
        const r = rng.next()
        let lo = 0
        let hi = zcdf!.length - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (zcdf![mid] < r) lo = mid + 1
          else hi = mid
        }
        key = lo
        val = lo
        break
      }
      case 'gaussian': {
        // Irwin–Hall (sum of 6 uniforms) ≈ normal, centred in the domain.
        let s = 0
        for (let j = 0; j < 6; j++) s += rng.next()
        val = ((s - 3) / 3) * (domain / 6) + domain / 2
        key = Math.max(0, Math.min(domain - 1, Math.round(val)))
        break
      }
      case 'clustered': {
        const centre = clusterCentres[rng.int(0, clusterCentres.length - 1)]
        val = centre + (rng.next() - 0.5) * (domain * 0.04)
        key = Math.max(0, Math.min(domain - 1, Math.round(val)))
        break
      }
    }
    keys.push(key)
    values.push(val)
  }
  const exactCounts = new Map<number, number>()
  for (const k of keys) exactCounts.set(k, (exactCounts.get(k) ?? 0) + 1)
  const sorted = values.slice().sort((a, b) => a - b)
  return { keys, values, exactDistinct: exactCounts.size, exactCounts, sorted }
}

function exactQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const idx = q * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo])
}

// ---- HyperLogLog sweep -----------------------------------------------------

export interface HllPoint {
  p: number
  registers: number
  bytes: number
  estimate: number
  relErr: number
  stdErr: number
}
export interface HllResult {
  exact: number
  points: HllPoint[]
  mergeExact: number
  mergeEstimate: number
}

export function runHll(stream: Stream, precisions = [8, 10, 12, 14, 16]): HllResult {
  const points: HllPoint[] = []
  for (const p of precisions) {
    const hll = new HyperLogLog(p)
    for (const k of stream.keys) hll.add(k)
    const est = hll.estimate()
    points.push({
      p,
      registers: hll.m,
      bytes: hll.byteSize(),
      estimate: est,
      relErr: (est - stream.exactDistinct) / stream.exactDistinct,
      stdErr: hll.standardError(),
    })
  }
  // Merge demo: split the stream, sketch halves, merge → union cardinality.
  const half = stream.keys.length >> 1
  const a = new HyperLogLog(14)
  const b = new HyperLogLog(14)
  for (let i = 0; i < half; i++) a.add(stream.keys[i])
  for (let i = half; i < stream.keys.length; i++) b.add(stream.keys[i])
  const merged = mergeHLL(a, b)
  return { exact: stream.exactDistinct, points, mergeExact: stream.exactDistinct, mergeEstimate: merged.estimate() }
}

// ---- Count–Min sweep -------------------------------------------------------

export interface CmPoint {
  width: number
  depth: number
  bytes: number
  avgErr: number
  maxErr: number
  errBound: number
}
export interface CmResult {
  totalKeys: number
  distinct: number
  points: CmPoint[]
}

export function runCountMin(stream: Stream, widths = [64, 256, 1024, 4096], depth = 4): CmResult {
  const points: CmPoint[] = []
  for (const w of widths) {
    const cm = new CountMin({ d: depth, w, conservative: true })
    for (const k of stream.keys) cm.add(k)
    let sumErr = 0
    let maxErr = 0
    for (const [k, trueC] of stream.exactCounts) {
      const err = cm.estimate(k) - trueC
      sumErr += err
      if (err > maxErr) maxErr = err
    }
    points.push({
      width: w,
      depth,
      bytes: cm.byteSize(),
      avgErr: sumErr / Math.max(1, stream.exactCounts.size),
      maxErr,
      errBound: cm.errorBound(),
    })
  }
  return { totalKeys: stream.keys.length, distinct: stream.exactDistinct, points }
}

// ---- t-digest sweep --------------------------------------------------------

export interface QuantileRow {
  q: number
  exact: number
  approx: number
  relErr: number
}
export interface TdPoint {
  compression: number
  centroids: number
  bytes: number
  maxRelErr: number
}
export interface TdResult {
  range: number
  rows: QuantileRow[] // at the largest compression (the accurate one)
  points: TdPoint[]
}

const QUANTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]

export function runTDigest(stream: Stream, compressions = [20, 50, 100, 300]): TdResult {
  const range = (stream.sorted[stream.sorted.length - 1] - stream.sorted[0]) || 1
  const points: TdPoint[] = []
  let bestRows: QuantileRow[] = []
  for (const c of compressions) {
    const td = new TDigest(c)
    for (const v of stream.values) td.add(v)
    let maxRelErr = 0
    const rows: QuantileRow[] = QUANTILES.map((q) => {
      const exact = exactQuantile(stream.sorted, q)
      const approx = td.quantile(q)
      const relErr = Math.abs(approx - exact) / range
      if (relErr > maxRelErr) maxRelErr = relErr
      return { q, exact, approx, relErr }
    })
    points.push({ compression: c, centroids: td.centroidCount(), bytes: td.byteSize(), maxRelErr })
    bestRows = rows
  }
  return { range, rows: bestRows, points }
}

// ---- Space-Saving top-k ----------------------------------------------------

export interface TopKRow {
  rank: number
  value: number
  approxCount: number
  error: number
  exactCount: number
  correct: boolean
}
export interface TopKResult {
  k: number
  bytes: number
  rows: TopKRow[]
  exactRecall: number // fraction of true top-k that the sketch also placed in its top-k
}

export function runTopK(stream: Stream, k = 10, capacityFactor = 4): TopKResult {
  const ss = new SpaceSaving(k * capacityFactor)
  for (const key of stream.keys) ss.add(key)
  const exactSorted = [...stream.exactCounts.entries()].sort((a, b) => b[1] - a[1])
  const exactTop = exactSorted.slice(0, k)
  const exactTopSet = new Set(exactTop.map((e) => e[0]))
  const approx = ss.topK(k)
  const approxSet = new Set(approx.map((h) => h.value as number))
  let hit = 0
  for (const v of exactTopSet) if (approxSet.has(v)) hit++
  const rows: TopKRow[] = approx.map((h, i) => {
    const value = h.value as number
    return {
      rank: i + 1,
      value,
      approxCount: h.count,
      error: h.error,
      exactCount: stream.exactCounts.get(value) ?? 0,
      correct: exactTopSet.has(value),
    }
  })
  return { k, bytes: ss.byteSize(), rows, exactRecall: exactTop.length ? hit / exactTop.length : 1 }
}

// ---- Bloom filter sweep ----------------------------------------------------

export interface BloomPoint {
  bitsPerElem: number
  bytes: number
  hashes: number
  predictedFpr: number
  measuredFpr: number
}
export interface BloomResult {
  members: number
  points: BloomPoint[]
}

export function runBloom(stream: Stream, bitsPerElemStops = [4, 6, 8, 10, 12]): BloomResult {
  // Members = the distinct keys; probe absent keys drawn from a disjoint domain.
  const members = [...stream.exactCounts.keys()]
  const n = members.length
  const points: BloomPoint[] = []
  const probes = 20000
  const offset = 1_000_000 // guaranteed-absent key space
  for (const bpe of bitsPerElemStops) {
    const m = Math.max(8, n * bpe)
    const k = Math.max(1, Math.round(bpe * Math.LN2))
    const bf = new BloomFilter({ m, k })
    for (const key of members) bf.add(key)
    let fp = 0
    for (let i = 0; i < probes; i++) if (bf.mayContain(offset + i)) fp++
    points.push({
      bitsPerElem: bpe,
      bytes: bf.byteSize(),
      hashes: k,
      predictedFpr: Math.pow(1 - Math.exp((-k * n) / m), k),
      measuredFpr: fp / probes,
    })
  }
  return { members: n, points }
}
