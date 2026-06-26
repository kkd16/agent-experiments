// Deterministic pseudo-random number generator.
//
// The whole simulator is a pure function of (seed, scenario): every network
// delay, every randomized election timeout, every chaos coin-flip is drawn from
// one of these. That is what makes a run perfectly reproducible and safe to
// snapshot/rewind — replaying the same seed gives byte-identical history.
//
// We seed a 64-bit splitmix64 to expand a single integer seed into a
// well-distributed state, then stream uint32s with mulberry32. Both are tiny,
// fast, dependency-free and have good statistical properties for simulation
// (they are NOT cryptographic — that is fine here).

/** Expand a small integer seed into a 32-bit state via one splitmix64 step. */
function splitmix32(seed: number): number {
  let z = (seed + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Fold the seed through splitmix so nearby seeds (1, 2, 3…) still produce
    // wildly different streams.
    this.state = splitmix32(Math.floor(seed) >>> 0) || 0x1a2b3c4d;
  }

  /** Next uint32 in [0, 2^32). */
  nextUint32(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + (this.nextUint32() % (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability p in [0,1]. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Pick a uniformly random element (returns undefined for empty arrays). */
  pick<T>(arr: readonly T[]): T | undefined {
    if (arr.length === 0) return undefined;
    return arr[this.int(0, arr.length - 1)];
  }

  /** Fisher–Yates shuffle into a new array (does not mutate the input). */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Sample k distinct elements without replacement. */
  sample<T>(arr: readonly T[], k: number): T[] {
    return this.shuffle(arr).slice(0, Math.max(0, Math.min(k, arr.length)));
  }

  /** Snapshot the internal state so a run can be captured and resumed exactly. */
  save(): number {
    return this.state >>> 0;
  }

  /** Restore a previously saved state. */
  restore(state: number): void {
    this.state = state >>> 0;
  }
}
