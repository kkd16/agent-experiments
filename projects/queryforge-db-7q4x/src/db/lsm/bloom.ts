// A Bloom filter — the read-amplification cure at the heart of every LSM.
//
// A point lookup in an LSM may have to touch one SSTable per level (the key
// could live in any of them). Most of those probes miss. A Bloom filter
// (Bloom, 1970) is a tiny per-SSTable bit array that answers "is this key
// *possibly* in here?" with **no false negatives**: if the filter says absent,
// the key is provably not in the table, and the (expensive) block read is
// skipped. It may say "present" for a key it doesn't hold (a false positive,
// tunable to a target rate ε), so a positive is always rechecked by the real
// lookup — but a database of mostly-missing probes turns O(levels) block reads
// into O(1)+ε.
//
// Sizing is the classic optimum: for n keys at target FPR ε, use
//   m = ceil(-n·ln ε / (ln 2)^2)   bits, and
//   k = round((m/n)·ln 2)          hash functions,
// which minimizes ε for the space. The k bit positions come from **double
// hashing** (Kirsch–Mitzenmacher, 2006): two independent 32-bit hashes h1, h2
// of the key's canonical encoding synthesize g_i = h1 + i·h2, statistically as
// good as k independent hashes for a fraction of the work.

/** Two independent 32-bit hashes of a string (the key's canonical encoding),
 *  built as FNV-1a variants with different offset bases — cheap, well-mixed,
 *  and dependency-free (each SSTable's filter is self-contained). */
export function hashPair(s: string): [number, number] {
  let h1 = 0x811c9dc5
  let h2 = 0xcbf29ce4 ^ 0x9e3779b9
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193)
    h2 = (h2 + c) | 0
    h2 = Math.imul(h2, 0x85ebca6b)
    h2 ^= h2 >>> 13
  }
  h1 >>>= 0
  h2 >>>= 0
  // A zero second hash would make every g_i collapse to h1; force it odd/nonzero.
  if (h2 === 0) h2 = 0x9e3779b9
  return [h1, h2]
}

export class BloomFilter {
  readonly bits: Uint8Array
  readonly m: number // number of bits
  readonly k: number // number of hash probes
  private n = 0 // keys added (for stats)

  /** Build a filter sized for `expected` keys at target false-positive rate
   *  `fpr`. Both are clamped to sane minimums so a tiny table still gets a
   *  usable filter. */
  constructor(expected: number, fpr = 0.01) {
    const n = Math.max(1, expected)
    const ln2 = Math.LN2
    const m = Math.max(8, Math.ceil((-n * Math.log(fpr)) / (ln2 * ln2)))
    // Round up to a whole byte.
    this.m = (m + 7) & ~7
    this.k = Math.max(1, Math.round((this.m / n) * ln2))
    this.bits = new Uint8Array(this.m >>> 3)
  }

  private setBit(i: number): void {
    this.bits[i >>> 3] |= 1 << (i & 7)
  }
  private getBit(i: number): boolean {
    return (this.bits[i >>> 3] & (1 << (i & 7))) !== 0
  }

  /** Record a key (by its canonical encoding). */
  add(encoded: string): void {
    const [h1, h2] = hashPair(encoded)
    for (let i = 0; i < this.k; i++) {
      const idx = (h1 + Math.imul(i, h2)) >>> 0
      this.setBit(idx % this.m)
    }
    this.n++
  }

  /** True if the key MIGHT be present. A false result is a guarantee of
   *  absence (no false negatives). */
  mightContain(encoded: string): boolean {
    const [h1, h2] = hashPair(encoded)
    for (let i = 0; i < this.k; i++) {
      const idx = (h1 + Math.imul(i, h2)) >>> 0
      if (!this.getBit(idx % this.m)) return false
    }
    return true
  }

  /** Fraction of bits set — feeds the analytic FPR estimate (1 - e^{-kn/m})^k
   *  ≈ fillRatio^k, surfaced in the Lab. */
  fillRatio(): number {
    let set = 0
    for (let i = 0; i < this.m; i++) if (this.getBit(i)) set++
    return set / this.m
  }

  /** The a-priori expected false-positive probability for the current load. */
  estimatedFpr(): number {
    return Math.pow(1 - Math.exp((-this.k * this.n) / this.m), this.k)
  }
}
