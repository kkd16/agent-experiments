// t-digest — mergeable, tail-accurate approximate quantiles.
//
// `PERCENTILE_CONT(0.99)` normally buffers and sorts the whole column. A
// t-digest (Dunning 2019) summarises a distribution in a bounded set of
// *centroids* — (mean, weight) clusters — chosen so they are FINE at the tails
// and coarse in the middle. That is exactly the shape you want for p50/p99/p999:
// a handful of kilobytes gives sub-percent error at the extreme quantiles where
// equal-width histograms are useless.
//
// The trick is a scale function k(q) = (δ/2π)·asin(2q−1) mapping the quantile q
// into a warped "k-space" where the tails are stretched. A centroid may absorb
// weight only while it spans ≤ 1 unit of k-space; near q = 0 or 1 the derivative
// of asin blows up, so centroids there are forced small (tight), while near
// q = 0.5 they grow large (coarse). δ (compression) trades size for accuracy.
//
// Two digests MERGE by concatenating their centroids and re-clustering under the
// same scale function — the monoid — so partial quantile state combines across
// partitions, which is why t-digest is the quantile of choice in Druid/Spark.

export interface Centroid {
  mean: number
  weight: number
}

export class TDigest {
  readonly compression: number
  private merged: Centroid[] = [] // sorted by mean, re-clustered
  private buffer: Centroid[] = [] // unmerged incoming points
  private totalWeight = 0
  private minValue = Infinity
  private maxValue = -Infinity

  constructor(compression = 100) {
    if (compression < 20) throw new Error('t-digest compression should be ≥ 20')
    this.compression = compression
  }

  /** Add one value with an optional integer weight. */
  add(x: number, w = 1): void {
    if (!Number.isFinite(x) || w <= 0) return
    this.buffer.push({ mean: x, weight: w })
    this.totalWeight += w
    if (x < this.minValue) this.minValue = x
    if (x > this.maxValue) this.maxValue = x
    // Flush when the buffer would dominate the merged set (amortised O(1)).
    if (this.buffer.length > 10 * this.compression) this.compress()
  }

  count(): number {
    return this.totalWeight
  }

  centroidCount(): number {
    return this.merged.length + this.buffer.length
  }

  byteSize(): number {
    // A centroid is a mean + weight ≈ 16 bytes.
    return (this.merged.length + this.buffer.length) * 16
  }

  /** Fold the buffer into the merged, re-clustered centroid set. */
  compress(): void {
    if (this.buffer.length === 0) return
    const all = this.merged.concat(this.buffer)
    this.buffer = []
    all.sort((a, b) => a.mean - b.mean)
    const total = this.totalWeight
    if (total === 0) {
      this.merged = []
      return
    }
    const out: Centroid[] = []
    let wSoFar = 0
    let cur: Centroid = { mean: all[0].mean, weight: all[0].weight }
    let qLimit = this.qInv(this.qNorm(0) + 1)
    for (let i = 1; i < all.length; i++) {
      const c = all[i]
      const projected = (wSoFar + cur.weight + c.weight) / total
      if (projected <= qLimit) {
        // Absorb c into the current centroid (weighted mean).
        cur.weight += c.weight
        cur.mean += ((c.mean - cur.mean) * c.weight) / cur.weight
      } else {
        wSoFar += cur.weight
        out.push(cur)
        cur = { mean: c.mean, weight: c.weight }
        qLimit = this.qInv(this.qNorm(wSoFar / total) + 1)
      }
    }
    out.push(cur)
    this.merged = out
  }

  /** The scale function k(q). */
  private qNorm(q: number): number {
    const clamped = Math.min(1, Math.max(0, q))
    return (this.compression / (2 * Math.PI)) * Math.asin(2 * clamped - 1)
  }

  /** Its inverse k⁻¹. */
  private qInv(k: number): number {
    return (Math.sin((k * 2 * Math.PI) / this.compression) + 1) / 2
  }

  /** The estimated value at quantile q ∈ [0, 1]. */
  quantile(q: number): number {
    this.compress()
    const cs = this.merged
    if (cs.length === 0) return NaN
    if (cs.length === 1) return cs[0].mean
    if (q <= 0) return this.minValue
    if (q >= 1) return this.maxValue
    const target = q * this.totalWeight
    // Walk centroids, interpolating between adjacent centroid means. Each
    // centroid "owns" the interval centred on its cumulative half-weight.
    let cum = 0
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]
      const centre = cum + c.weight / 2
      if (target < centre) {
        if (i === 0) {
          // Between the true min and the first centroid's centre.
          const denom = centre
          const t = denom === 0 ? 0 : target / denom
          return this.minValue + t * (c.mean - this.minValue)
        }
        const prev = cs[i - 1]
        const prevCentre = cum - prev.weight / 2
        const denom = centre - prevCentre
        const t = denom === 0 ? 0 : (target - prevCentre) / denom
        return prev.mean + t * (c.mean - prev.mean)
      }
      cum += c.weight
    }
    // Past the last centroid's centre → interpolate to the true max.
    const last = cs[cs.length - 1]
    const lastCentre = this.totalWeight - last.weight / 2
    const denom = this.totalWeight - lastCentre
    const t = denom === 0 ? 0 : (target - lastCentre) / denom
    return last.mean + t * (this.maxValue - last.mean)
  }

  /** The estimated fraction of values ≤ x (the CDF). */
  cdf(x: number): number {
    this.compress()
    const cs = this.merged
    if (cs.length === 0) return NaN
    if (x < this.minValue) return 0
    if (x >= this.maxValue) return 1
    let cum = 0
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]
      if (x < c.mean) {
        const prevMean = i === 0 ? this.minValue : cs[i - 1].mean
        const prevCum = i === 0 ? 0 : cum - cs[i - 1].weight / 2
        const centre = cum + c.weight / 2
        const denom = c.mean - prevMean
        const t = denom === 0 ? 0 : (x - prevMean) / denom
        return (prevCum + t * (centre - prevCum)) / this.totalWeight
      }
      cum += c.weight
    }
    return 1
  }

  /** Merge another digest into this one (concatenate + re-cluster). */
  merge(other: TDigest): void {
    other.compress()
    for (const c of other.merged) {
      this.buffer.push({ mean: c.mean, weight: c.weight })
    }
    this.totalWeight += other.totalWeight
    if (other.minValue < this.minValue) this.minValue = other.minValue
    if (other.maxValue > this.maxValue) this.maxValue = other.maxValue
    this.compress()
  }

  clone(): TDigest {
    const c = new TDigest(this.compression)
    this.compress()
    c.merged = this.merged.map((x) => ({ ...x }))
    c.totalWeight = this.totalWeight
    c.minValue = this.minValue
    c.maxValue = this.maxValue
    return c
  }

  centroids(): Centroid[] {
    this.compress()
    return this.merged.map((c) => ({ ...c }))
  }
}
