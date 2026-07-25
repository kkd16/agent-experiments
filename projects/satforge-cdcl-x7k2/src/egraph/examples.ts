// Curated demonstrations plus a seeded random-term generator. The examples are
// split into two kinds: *optimize* (saturate one term and extract a cheaper
// equivalent) and *prove* (saturate two terms and check they collide). The
// generator feeds the differential oracle — see selfcheck.ts.

import type { Term } from './term'
import { parseTerm } from './term'

export interface OptExample {
  name: string
  src: string
  note: string
}

export const OPT_EXAMPLES: OptExample[] = [
  {
    name: 'Strength reduction',
    src: 'a * 2',
    note: 'Doubling is a left shift. The extractor prefers a << 1 because a shift is cheaper than a multiply.',
  },
  {
    name: 'Constant folding',
    src: '2 * 3 * a',
    note: 'The e-class analysis folds 2 * 3 into 6 inside the graph — the same machinery as the rewrites.',
  },
  {
    name: 'Identity collapse',
    src: 'a * 0 + b * 1',
    note: 'a * 0 annihilates to 0, b * 1 is just b, and the +0 vanishes — the term is really only b.',
  },
  {
    name: 'Factoring',
    src: 'a * b + a * c',
    note: 'Sharing a factor removes a multiplication: a * (b + c). The cost model makes that a win.',
  },
  {
    name: 'Negation cancels',
    src: 'a + (b - a)',
    note: 'b - a is b + (-a); reassociating pairs a with -a, which cancels to 0, leaving b.',
  },
  {
    name: 'Nested identities',
    src: '(a + 0) * (1 * c)',
    note: 'Two neutral elements peel away to leave the bare product a * c.',
  },
  {
    name: 'Triple sum',
    src: 'x + x + x',
    note: 'x + x fuses to x * 2 then a shift; the trailing + x has nothing to factor with, so it survives — saturation optimizes what it can.',
  },
]

export interface ProveExample {
  name: string
  lhs: string
  rhs: string
  note: string
}

export const PROVE_EXAMPLES: ProveExample[] = [
  {
    name: 'Commutativity',
    lhs: 'a + b * c',
    rhs: 'c * b + a',
    note: 'Reorder the sum and the product — pure commutativity.',
  },
  {
    name: 'Distributivity',
    lhs: '(a + b) * c',
    rhs: 'a * c + b * c',
    note: 'The ring distributive law, needing commutativity to line the factors up.',
  },
  {
    name: 'Antisymmetry of subtraction',
    lhs: 'a - b',
    rhs: '-(b - a)',
    note: 'a - b and -(b - a) are the same element once negation is pushed through the sum.',
  },
  {
    name: 'The binomial square',
    lhs: '(a + b) * (a + b)',
    rhs: 'a * a + 2 * (a * b) + b * b',
    note: 'Expand, collect the two cross terms into 2·ab, and the two sides meet — the classic egg showpiece.',
  },
  {
    name: 'Shift equals doubling',
    lhs: 'a << 1',
    rhs: 'a + a',
    note: 'Strength reduction is an equivalence: the shift and the self-sum share a class.',
  },
]

// --- seeded RNG ---------------------------------------------------------------

/** Deterministic mulberry32 PRNG (shared style with the other subsystems). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VARS = ['a', 'b', 'c']

/**
 * A random term over {a,b,c}, small constants and the operators {+,*,neg,shl}.
 * Shift amounts are small non-negative constants so evaluation stays bounded and
 * always defined — the oracle never has to skip a shift.
 */
export function randomTerm(rng: () => number, depth: number): Term {
  if (depth <= 0 || rng() < 0.32) {
    if (rng() < 0.5) return { op: VARS[Math.floor(rng() * VARS.length)], args: [] }
    return { op: String(Math.floor(rng() * 5)), args: [] } // 0..4
  }
  const r = rng()
  if (r < 0.32) return { op: '+', args: [randomTerm(rng, depth - 1), randomTerm(rng, depth - 1)] }
  if (r < 0.6) return { op: '*', args: [randomTerm(rng, depth - 1), randomTerm(rng, depth - 1)] }
  if (r < 0.78) return { op: 'neg', args: [randomTerm(rng, depth - 1)] }
  // subtraction, parsed via the surface form so it desugars to + / neg
  if (r < 0.9) return { op: '+', args: [randomTerm(rng, depth - 1), { op: 'neg', args: [randomTerm(rng, depth - 1)] }] }
  // shift by a small constant amount
  return { op: 'shl', args: [randomTerm(rng, depth - 1), { op: String(Math.floor(rng() * 3)), args: [] }] }
}

/** Parse helper used by the studio (kept here so the UI imports one module). */
export function tryParse(src: string): { ok: true; term: Term } | { ok: false; error: string } {
  try {
    return { ok: true, term: parseTerm(src) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
  }
}
