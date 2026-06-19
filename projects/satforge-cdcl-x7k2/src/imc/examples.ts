// A gallery of finite-state transition systems for the Model-Checking studio.
// Each is small enough that the explicit-state BFS oracle can confirm the
// interpolation-based verdict live in the browser.

import type { Formula } from './formula'
import { fvar, fnot, fand, for_, fiff, TRUE, FALSE } from './formula'
import type { TransitionSystem } from './modelcheck'

// Build the minterm "current state == value v" over state bits 1..n.
const minterm = (v: number, n: number, base = 0): Formula => {
  const parts: Formula[] = []
  for (let j = 1; j <= n; j++) {
    const bitSet = (v & (1 << (j - 1))) !== 0
    const x = fvar(base + j)
    parts.push(bitSet ? x : fnot(x))
  }
  return parts.reduce((a, b) => fand(a, b))
}

// Trans relation from a (possibly multivalued) next-state function on integers.
const fromNextFn = (n: number, nextFn: (s: number) => number[]): Formula => {
  const N = 1 << n
  const disjuncts: Formula[] = []
  for (let s = 0; s < N; s++) {
    for (const t of nextFn(s)) {
      disjuncts.push(fand(minterm(s, n, 0), minterm(t, n, n)))
    }
  }
  return disjuncts.length ? for_(...disjuncts) : FALSE
}

// Predicate over the integer value of the state.
const pred = (n: number, keep: (v: number) => boolean): Formula => {
  const N = 1 << n
  const ms: Formula[] = []
  for (let v = 0; v < N; v++) if (keep(v)) ms.push(minterm(v, n, 0))
  return ms.length ? for_(...ms) : FALSE
}

function modCounter(): TransitionSystem {
  // 3-bit value; counts 0→1→…→5→0 (mod 6). Values 6,7 self-loop.
  const n = 3
  const next = (s: number): number[] => [s <= 4 ? s + 1 : s === 5 ? 0 : s]
  return {
    name: 'Modulo-6 counter',
    description:
      'A 3-bit register counting 0→1→…→5→0. Starting at 0, can it ever hold the value 6? The interpolant discovers the invariant value ≤ 5 — bad state 6 is unreachable.',
    stateBits: n,
    bitNames: ['b0', 'b1', 'b2'],
    init: minterm(0, n),
    trans: fromNextFn(n, next),
    bad: pred(n, (v) => v === 6),
  }
}

function overflowCounter(): TransitionSystem {
  // 3-bit up-counter that saturates at 7. Starting at 0 it WILL reach 6.
  const n = 3
  const next = (s: number): number[] => [s < 7 ? s + 1 : 7]
  return {
    name: 'Up-counter overflow (buggy)',
    description:
      'A saturating up-counter from 0. The bad value 6 IS reachable — model checking returns a concrete 6-step counterexample trace.',
    stateBits: n,
    bitNames: ['b0', 'b1', 'b2'],
    init: minterm(0, n),
    trans: fromNextFn(n, next),
    bad: pred(n, (v) => v === 6),
  }
}

function mutex(buggy: boolean): TransitionSystem {
  // State: x0 = proc0 in critical section, x1 = proc1 in critical section.
  const x0 = fvar(1)
  const x1 = fvar(2)
  const x0n = fvar(3)
  const x1n = fvar(4)
  const eq0 = fiff(x0n, x0)
  const eq1 = fiff(x1n, x1)
  // stutter (keeps the relation total), enter, and leave for each process.
  const stutter = fand(eq0, eq1)
  // proc0 enters: requires proc1 not in CS (unless buggy), proc1 unchanged.
  const enter0 = fand(fnot(x0), buggy ? TRUE : fnot(x1), x0n, eq1)
  const leave0 = fand(x0, fnot(x0n), eq1)
  const enter1 = fand(fnot(x1), fnot(x0), x1n, eq0)
  const leave1 = fand(x1, fnot(x1n), eq0)
  return {
    name: buggy ? 'Mutual exclusion (broken)' : 'Mutual exclusion',
    description: buggy
      ? "Process 0 enters its critical section without checking process 1 — mutual exclusion is violated. A counterexample reaches the state where both are critical."
      : 'Two processes guard a critical section with a simple enter-if-free protocol. The bad state "both in the critical section at once" is proven unreachable; the interpolant is the safety monitor ¬(x0 ∧ x1).',
    stateBits: 2,
    bitNames: ['x0', 'x1'],
    init: fand(fnot(x0), fnot(x1)),
    trans: for_(stutter, enter0, leave0, enter1, leave1),
    bad: fand(x0, x1),
  }
}

function trafficLight(): TransitionSystem {
  // Two directions, each a 2-bit phase: 0=red,1=green,2=yellow. We pack as a
  // 4-bit value (dir A low 2 bits, dir B high 2 bits) and let A cycle while B is
  // red, then B cycle while A is red — never green together.
  const n = 4
  const phaseA = (v: number) => v & 3
  const phaseB = (v: number) => (v >> 2) & 3
  const mk = (a: number, b: number) => (a & 3) | ((b & 3) << 2)
  const next = (s: number): number[] => {
    const a = phaseA(s)
    const b = phaseB(s)
    // 0 red -> 1 green -> 2 yellow -> 0 red. Only advance A when B is red and
    // vice versa; the controller alternates ownership.
    if (b === 0) {
      // A's turn
      if (a === 0) return [mk(1, 0)]
      if (a === 1) return [mk(2, 0)]
      if (a === 2) return [mk(0, 1)] // hand over to B
    }
    if (a === 0) {
      if (b === 1) return [mk(0, 2)]
      if (b === 2) return [mk(1, 0)] // hand back to A
    }
    return [mk(0, 0)] // any illegal combo collapses to all-red
  }
  return {
    name: 'Traffic-light controller',
    description:
      'Two perpendicular signals cycle red→green→yellow→red, handing off the road so they are never green at the same time. Model checking proves the crash state (both green) unreachable.',
    stateBits: n,
    bitNames: ['A0', 'A1', 'B0', 'B1'],
    init: pred(n, (v) => v === 0),
    trans: fromNextFn(n, next),
    bad: pred(n, (v) => phaseA(v) === 1 && phaseB(v) === 1),
  }
}

function ringToken(): TransitionSystem {
  // 4-station token ring: exactly one token circulates. State = one-hot 4 bits.
  // Safety: the token is never lost (at least one station holds it) — here we
  // check the dual reachable bad state "no token" is unreachable from one-hot.
  const n = 4
  const next = (s: number): number[] => {
    // rotate the bits left by one (token passes to the next station)
    const rotated = ((s << 1) | (s >> (n - 1))) & ((1 << n) - 1)
    return [rotated]
  }
  return {
    name: 'Token-ring rotation',
    description:
      'A token rotates around a 4-station ring (a rotating one-hot register). Starting from a single token, the "token lost" state (all stations empty) is proven unreachable.',
    stateBits: n,
    bitNames: ['s0', 's1', 's2', 's3'],
    init: pred(n, (v) => v === 1), // token at station 0
    trans: fromNextFn(n, next),
    bad: pred(n, (v) => v === 0), // no token anywhere
  }
}

function lfsr(broken: boolean): TransitionSystem {
  // A 4-bit Fibonacci linear-feedback shift register with taps at bits 3 and 2
  // (polynomial x⁴+x³+1), which is *maximal-length*: from any nonzero seed it
  // cycles through all 15 nonzero states and never reaches 0 — the all-zero
  // word is a fixed point outside the cycle. PDR discovers exactly the invariant
  // "register ≠ 0". The broken variant XORs the wrong taps (a single mis-wired
  // gate) and *can* shift in all zeros, so the lock-up state 0 becomes reachable.
  const n = 4
  const next = (s: number): number[] => {
    const b3 = (s >> 3) & 1
    const b2 = (s >> 2) & 1
    const b0 = s & 1
    const fb = broken ? b3 & b0 : b3 ^ b2
    return [((s << 1) | fb) & 0b1111]
  }
  return {
    name: broken ? 'LFSR lock-up (mis-wired)' : 'Maximal-length LFSR',
    description: broken
      ? 'A 4-bit shift register whose feedback gate is wired wrong. From the seed 0001 it can shift in all zeros and latch up in the dead state 0 — model checking returns the concrete sequence that kills it.'
      : 'A 4-bit Fibonacci LFSR (taps x⁴+x³+1) — the workhorse of pseudo-random generators and scramblers. From a nonzero seed it tours all 15 nonzero words and never hits the lock-up state 0. PDR proves it with the one-clause invariant "register ≠ 0".',
    stateBits: n,
    bitNames: ['b0', 'b1', 'b2', 'b3'],
    init: minterm(1, n), // seed 0001
    trans: fromNextFn(n, next),
    bad: pred(n, (v) => v === 0), // the all-zero lock-up state
  }
}

export const TS_EXAMPLES: TransitionSystem[] = [
  modCounter(),
  overflowCounter(),
  mutex(false),
  mutex(true),
  trafficLight(),
  ringToken(),
  lfsr(false),
  lfsr(true),
]
