// Structural invariants of the syntactic monoid. Each corresponds to a *variety* of finite monoids
// and hence, by Eilenberg's correspondence, to a class of regular languages. The headline one is
// **aperiodicity**: a monoid is aperiodic iff it contains no non-trivial group, iff every H-class
// is trivial. Schützenberger's theorem then equates aperiodicity with *star-freeness*.

import type { Monoid } from './monoid'
import type { GreenClasses } from './green'

export interface PowerInfo {
  /** m¹, m², … as element ids, up to (and including) the first repeat. */
  seq: number[]
  /** Index in `seq` where the cycle closes. */
  cycleStart: number
  /** Length of the eventual cycle. period = 1 ⟺ this element is aperiodic. */
  period: number
}

/** Iterate the powers of an element until they repeat, exposing the cycle. */
export function powerSequence(mon: Monoid, a: number): PowerInfo {
  const pos = new Map<number, number>()
  const seq: number[] = []
  let cur = a
  while (!pos.has(cur)) {
    pos.set(cur, seq.length)
    seq.push(cur)
    cur = mon.mult[cur][a]
  }
  const cycleStart = pos.get(cur)!
  return { seq, cycleStart, period: seq.length - cycleStart }
}

export interface MonoidProps {
  order: number
  idempotents: number[]
  /** No non-trivial subgroup — the star-free / group-free / counter-free property. */
  aperiodic: boolean
  /** A witness element whose powers cycle (period > 1), if the monoid is *not* aperiodic. */
  aperiodicWitness?: PowerInfo & { element: number }
  /** Smallest n with mⁿ = mⁿ⁺¹ for every m (the aperiodicity/stability index); only if aperiodic. */
  aperiodicIndex?: number
  commutative: boolean
  commutativeWitness?: [number, number]
  /** The monoid is a group (a unique idempotent — the identity). */
  group: boolean
  /** Every element is idempotent. */
  band: boolean
  /** A commutative band. */
  semilattice: boolean
  trivial: boolean
  jTrivial: boolean
  rTrivial: boolean
  lTrivial: boolean
  /** H-trivial ⟺ aperiodic. */
  hTrivial: boolean
  counts: { r: number; l: number; j: number; h: number }
}

export function analyzeMonoid(mon: Monoid, g: GreenClasses): MonoidProps {
  const m = mon.order
  const mult = mon.mult
  const idempotents = mon.elements.filter((e) => e.idempotent).map((e) => e.id)

  // Aperiodicity via the powers of each element.
  let aperiodic = true
  let witness: (PowerInfo & { element: number }) | undefined
  let index = 1
  for (let a = 0; a < m; a++) {
    const p = powerSequence(mon, a)
    if (p.period > 1) {
      aperiodic = false
      if (!witness) witness = { ...p, element: a }
    } else {
      // period 1: mⁿ = mⁿ⁺¹ first holds at n = seq.length.
      if (p.seq.length > index) index = p.seq.length
    }
  }

  // Commutativity.
  let commutative = true
  let commWitness: [number, number] | undefined
  outer: for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      if (mult[a][b] !== mult[b][a]) {
        commutative = false
        commWitness = [a, b]
        break outer
      }
    }
  }

  const trivial = m === 1
  const group = idempotents.length === 1 // finite monoid ⇒ group ⟺ the identity is its only idempotent
  const band = idempotents.length === m
  const jTrivial = g.jClasses.length === m
  const rTrivial = g.rClasses.length === m
  const lTrivial = g.lClasses.length === m
  const hTrivial = g.hClasses.length === m

  return {
    order: m,
    idempotents,
    aperiodic,
    aperiodicWitness: witness,
    aperiodicIndex: aperiodic ? index : undefined,
    commutative,
    commutativeWitness: commWitness,
    group,
    band,
    semilattice: band && commutative,
    trivial,
    jTrivial,
    rTrivial,
    lTrivial,
    hTrivial,
    counts: {
      r: g.rClasses.length,
      l: g.lClasses.length,
      j: g.jClasses.length,
      h: g.hClasses.length,
    },
  }
}
