// A tiny, fully deterministic pseudo-random number generator (mulberry32). A single
// 32-bit integer seed reproduces an entire fuzz run byte-for-byte: the schema, the
// data, and every generated query. There is deliberately **no** `Math.random()`
// anywhere in the fuzzer — reproducibility is the whole point of a metamorphic
// tester (a counterexample you can't replay is a counterexample you can't fix).

export class Rng {
  private s: number
  constructor(seed: number) {
    // Keep zero out of the state (mulberry32 is weak from 0); fold the seed in.
    this.s = (seed >>> 0) || 0x9e3779b9
  }

  /** A float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** An integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    if (hi < lo) return lo
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  /** True with probability p (default 1/2). */
  chance(p = 0.5): boolean {
    return this.next() < p
  }

  /** A uniformly chosen element of a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)]
  }

  /** A random non-empty subset (preserving order) of an array. */
  subset<T>(arr: readonly T[]): T[] {
    const out = arr.filter(() => this.chance())
    if (out.length === 0) out.push(this.pick(arr))
    return out
  }

  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
}
