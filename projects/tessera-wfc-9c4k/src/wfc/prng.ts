// A small, fast, seedable PRNG so every Tessera run is exactly reproducible from a seed.
// mulberry32 for the stream; a splitmix-style avalanche to turn a human-typed seed string
// into a well-distributed 32-bit state.

export type Rng = {
  /** Next float in [0, 1). */
  next(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  /** Pick an index from a list of non-negative weights, proportional to weight. */
  weighted(weights: number[], total: number): number;
};

/** Hash an arbitrary string seed into a 32-bit unsigned integer. */
export function hashSeed(seed: string): number {
  let h = 0x9e3779b9 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x85ebca6b);
    h = (h ^ (h >>> 13)) >>> 0;
  }
  // final avalanche
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function makeRng(seed32: number): Rng {
  let a = seed32 >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    weighted: (weights, total) => {
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
      }
      // fallback for floating-point drift: return the last non-zero weight
      for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
      return 0;
    },
  };
}

/** A short, friendly random seed string (e.g. "amber-koi-3f7"). */
export function randomSeedString(): string {
  const a = ['amber', 'cobalt', 'jade', 'coral', 'slate', 'ivory', 'crimson', 'azure', 'lunar', 'ember', 'mossy', 'frost'];
  const b = ['koi', 'fox', 'wren', 'lynx', 'moth', 'orca', 'ibis', 'hart', 'crow', 'newt', 'asp', 'roe'];
  const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];
  const tag = Math.floor(Math.random() * 0xfff)
    .toString(16)
    .padStart(3, '0');
  return `${pick(a)}-${pick(b)}-${tag}`;
}
