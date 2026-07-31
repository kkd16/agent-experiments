// A gallery of curated model-checking scenarios and the seeded random
// generators the self-check fuzzes against the oracle.

import type { Ltl } from './ast'
import { and, atom, eventually, FALSE, globally, iff, imp, next, not, or, release, TRUE, until, wuntil } from './ast'
import type { Kripke } from './kripke'

export interface Example {
  name: string
  description: string
  /** Kripke structure in the DSL. */
  kripke: string
  /** LTL specification. */
  formula: string
  /** Whether the spec is expected to hold on every run. */
  holds: boolean
}

export const EXAMPLES: Example[] = [
  {
    name: 'Mutual exclusion — safety',
    description: 'An abstract two-process lock lets at most one process into its critical section. The safety property G ¬(c1 ∧ c2) holds: the "both critical" state is unreachable.',
    kripke: `state idle [] init
state p1 [c1]
state p2 [c2]
idle -> p1, p2
p1 -> idle
p2 -> idle`,
    formula: 'G !(c1 & c2)',
    holds: true,
  },
  {
    name: 'Starvation — liveness fails',
    description: 'Same lock, but does process 1 get in infinitely often? G F c1 FAILS — the scheduler is free to keep choosing process 2 forever. The counterexample loops through p2 and never sets c1.',
    kripke: `state idle [] init
state p1 [c1]
state p2 [c2]
idle -> p1, p2
p1 -> idle
p2 -> idle`,
    formula: 'G F c1',
    holds: false,
  },
  {
    name: 'Broken mutex — safety fails',
    description: 'Now both processes can enter together, reaching a state where c1 and c2 are both set. G ¬(c1 ∧ c2) FAILS, and the counterexample is the path into that "both" state.',
    kripke: `state idle [] init
state a1 [c1]
state a2 [c2]
state both [c1, c2]
idle -> a1, a2
a1 -> both
a2 -> both
both -> idle`,
    formula: 'G !(c1 & c2)',
    holds: false,
  },
  {
    name: 'Request → response',
    description: 'Every request is answered: from the request state the only move is to an acknowledgement. Both the immediate form G(req → X ack) and the eventual form G(req → F ack) hold.',
    kripke: `state idle [] init
state req [req]
state ack [ack]
idle -> idle, req
req -> ack
ack -> idle`,
    formula: 'G (req -> F ack)',
    holds: true,
  },
  {
    name: 'Request with no answer',
    description: 'A request can be raised but is never acknowledged (there is no ack anywhere). G(req → F ack) FAILS; the counterexample raises req and then spins forever.',
    kripke: `state idle [] init
state req [req]
state busy []
idle -> idle, req
req -> busy
busy -> busy`,
    formula: 'G (req -> F ack)',
    holds: false,
  },
  {
    name: 'Traffic light — fairness',
    description: 'A light cycles red → green → yellow → red deterministically. Green appears infinitely often, so G F green holds, as does the phase rule G(red → X green).',
    kripke: `state red [red] init
state green [green]
state yellow [yellow]
red -> green
green -> yellow
yellow -> red`,
    formula: 'G F green',
    holds: true,
  },
  {
    name: 'Until — stability then goal',
    description: 'p holds until q becomes true and sticks: the run is p, p, then q forever. The spec p U q holds — a strong until requires q to actually occur, and here it does.',
    kripke: `state s0 [p] init
state s1 [p]
state s2 [q]
s0 -> s1
s1 -> s2
s2 -> s2`,
    formula: 'p U q',
    holds: true,
  },
  {
    name: 'Weak until distinguishes',
    description: 'Here p holds forever and q never does. The strong p U q FAILS (q never occurs) but the weak p W q holds — weak-until permits p to persist forever. A clean demonstration of the U/W difference on one model.',
    kripke: `state s0 [p] init
s0 -> s0`,
    formula: 'p W q',
    holds: true,
  },
  {
    name: 'Weak until — strong form fails',
    description: 'Same p-forever model, but the strong until p U q FAILS because q is never reached. Its shortest counterexample is the self-loop on the single state.',
    kripke: `state s0 [p] init
s0 -> s0`,
    formula: 'p U q',
    holds: false,
  },
  {
    name: 'Infinitely often ⇒ infinitely often',
    description: 'On an alternating a/b cycle, "a infinitely often implies b infinitely often" holds. This GF a → GF b pattern is the canonical strong-fairness assumption of concurrent systems.',
    kripke: `state sa [a] init
state sb [b]
sa -> sb
sb -> sa`,
    formula: 'G F a -> G F b',
    holds: true,
  },
]

// ── seeded RNG + random generators for the fuzz oracle ───────────────────────

/** Deterministic 32-bit PRNG (Tommy Ettinger's mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length)]

/** A random LTL formula over `aps`, bounded by `depth`. */
export function randomLtl(rng: () => number, depth: number, aps: string[]): Ltl {
  if (depth <= 0 || rng() < 0.32) {
    const r = rng()
    if (r < 0.08) return TRUE
    if (r < 0.16) return FALSE
    return atom(pick(rng, aps))
  }
  const sub = () => randomLtl(rng, depth - 1, aps)
  const op = pick(rng, ['not', 'and', 'or', 'imp', 'iff', 'X', 'F', 'G', 'U', 'R', 'W'])
  switch (op) {
    case 'not':
      return not(sub())
    case 'X':
      return next(sub())
    case 'F':
      return eventually(sub())
    case 'G':
      return globally(sub())
    case 'and':
      return and(sub(), sub())
    case 'or':
      return or(sub(), sub())
    case 'imp':
      return imp(sub(), sub())
    case 'iff':
      return iff(sub(), sub())
    case 'U':
      return until(sub(), sub())
    case 'R':
      return release(sub(), sub())
    default:
      return wuntil(sub(), sub())
  }
}

/** A random ultimately-periodic word over `aps`. */
export function randomLassoWord(rng: () => number, aps: string[]): { letters: Set<string>[]; loopStart: number } {
  const stem = Math.floor(rng() * 3) // 0..2
  const loop = 1 + Math.floor(rng() * 3) // 1..3
  const n = stem + loop
  const letters: Set<string>[] = []
  for (let i = 0; i < n; i++) {
    const s = new Set<string>()
    for (const p of aps) if (rng() < 0.5) s.add(p)
    letters.push(s)
  }
  return { letters, loopStart: stem }
}

/** A random small *total* Kripke structure (every state has a successor). */
export function randomKripke(rng: () => number, aps: string[], maxStates = 5): Kripke {
  const n = 2 + Math.floor(rng() * (maxStates - 1))
  const states = []
  for (let i = 0; i < n; i++) {
    const labels = aps.filter(() => rng() < 0.5)
    states.push({ id: i, name: 's' + i, labels })
  }
  const edges: number[][] = []
  for (let i = 0; i < n; i++) {
    const deg = 1 + Math.floor(rng() * 2) // 1..2 successors
    const targets = new Set<number>()
    while (targets.size < deg) targets.add(Math.floor(rng() * n))
    edges.push([...targets].sort((a, b) => a - b))
  }
  const allAps = [...new Set(states.flatMap((s) => s.labels))].sort()
  return { states, init: [0], edges, aps: allAps }
}
