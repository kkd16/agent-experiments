// The REGION automaton — Alur & Dill's proof that a timed automaton, whose
// concrete state space is infinite, has a FINITE time-abstract bisimulation
// quotient. Two clock valuations are region-equivalent when they agree on
//   (1) the integer part of every clock, clamped at that clock's max constant
//       M(x) (beyond M(x) the exact value can never be tested again),
//   (2) which clocks sit exactly on an integer (fractional part 0), and
//   (3) the ORDER of the fractional parts of the remaining clocks.
// Equivalent valuations satisfy the same guards forever and stay equivalent as
// time elapses, so the quotient is a finite automaton whose reachable control
// locations are exactly those of the timed automaton. This module builds it
// from scratch — and it shares no code with the DBM zone engine, so the two
// agreeing (see selftest) is a genuine differential proof.

import type { CmpOp, Constraint, TimedAutomaton, Valuation } from './types'
import { maxConstants } from './types'

/**
 * A clock region, described canonically. `above[i]` marks a clock past its max
 * constant (its exact value is irrelevant); otherwise `intp[i]` is its integer
 * part and `frac0[i]` says whether its fractional part is exactly 0. `order` is
 * a partition of the remaining (below-max, non-integer) clocks into groups of
 * equal fractional part, listed by increasing fractional part.
 */
export interface Region {
  above: boolean[]
  intp: number[]
  frac0: boolean[]
  /** groups of clock indices sharing a fractional value, ascending; each group sorted */
  order: number[][]
}

/** Put a region into canonical form: above-clocks carry no int/frac/order data, empty groups dropped. */
function canonRegion(r: Region): Region {
  const above = r.above.slice()
  const intp = r.intp.slice()
  const frac0 = r.frac0.slice()
  for (let i = 0; i < above.length; i++) {
    if (above[i]) {
      intp[i] = 0
      frac0[i] = false
    }
  }
  const order = r.order
    .map((g) => g.filter((i) => !above[i]).sort((a, b) => a - b))
    .filter((g) => g.length > 0)
  return { above, intp, frac0, order }
}

/** A canonical string signature; region-equal ⟺ equal signatures. */
export function regionSig(r: Region): string {
  const c = canonRegion(r)
  return JSON.stringify([c.above, c.intp, c.frac0, c.order])
}

/** The region of a concrete valuation, given each clock's max constant. */
export function regionOf(v: Valuation, max: number[]): Region {
  const n = v.length
  const above: boolean[] = new Array(n)
  const intp: number[] = new Array(n)
  const frac0: boolean[] = new Array(n)
  const fracOf: { i: number; f: number }[] = []
  for (let i = 0; i < n; i++) {
    if (v[i] > max[i] + 1e-9) {
      above[i] = true
      intp[i] = 0
      frac0[i] = false
    } else {
      above[i] = false
      const fl = Math.floor(v[i] + 1e-9)
      intp[i] = fl
      const f = v[i] - fl
      if (f < 1e-9) {
        frac0[i] = true
      } else {
        frac0[i] = false
        fracOf.push({ i, f })
      }
    }
  }
  fracOf.sort((a, b) => a.f - b.f)
  const order: number[][] = []
  for (const { i, f } of fracOf) {
    const last = order[order.length - 1]
    if (last !== undefined && Math.abs(f - fracRep(last, fracOf)) < 1e-9) last.push(i)
    else order.push([i])
  }
  return canonRegion({ above, intp, frac0, order })
}

// helper: the fractional value represented by an existing group (its first member's f)
function fracRep(group: number[], fracOf: { i: number; f: number }[]): number {
  const first = group[0]
  const e = fracOf.find((x) => x.i === first)
  return e ? e.f : 0
}

/** A concrete representative valuation of a region (useful for display + round-trip tests). */
export function representative(r: Region, max: number[]): Valuation {
  const c = canonRegion(r)
  const n = c.above.length
  const v: Valuation = new Array(n).fill(0)
  const G = c.order.length
  for (let i = 0; i < n; i++) {
    if (c.above[i]) v[i] = max[i] + 0.5
    else if (c.frac0[i]) v[i] = c.intp[i]
    else v[i] = c.intp[i] // filled below with fractional offset
  }
  c.order.forEach((group, g) => {
    const f = (g + 1) / (G + 1)
    for (const i of group) v[i] = c.intp[i] + f
  })
  return v
}

/** Does every valuation in the region satisfy the atomic constraint `x op c`? (diagonal-free ⟹ well-defined) */
function satRegionAtom(r: Region, ci: number, op: CmpOp, c: number): boolean {
  if (r.above[ci]) {
    // clock value > max ≥ c  ⟹ strictly greater than c
    return op === '>' || op === '>='
  }
  const n = r.intp[ci]
  const z = r.frac0[ci]
  switch (op) {
    case '=':
      return n === c && z
    case '<':
      return n < c
    case '<=':
      return n < c || (n === c && z)
    case '>':
      return n > c || (n === c && !z)
    case '>=':
      return n >= c
  }
}

/** Does the region satisfy a whole conjunction? */
export function satRegion(ta: TimedAutomaton, r: Region, c: Constraint): boolean {
  for (const a of c) {
    const ci = ta.clocks.indexOf(a.clock)
    if (ci < 0) continue
    if (!satRegionAtom(r, ci, a.op, a.bound)) return false
  }
  return true
}

/**
 * The immediate time-successor region: the next distinct region reached by
 * letting time elapse. Returns the SAME region when it is time-stable (all
 * clocks already above their max — time can no longer change any test outcome).
 */
export function timeSucc(r0: Region, max: number[]): Region {
  const r = canonRegion(r0)
  const n = r.above.length
  const below: number[] = []
  for (let i = 0; i < n; i++) if (!r.above[i]) below.push(i)
  if (below.length === 0) return r // time-stable

  const zeros = below.filter((i) => r.frac0[i])
  const above = r.above.slice()
  const intp = r.intp.slice()
  const frac0 = r.frac0.slice()
  let order = r.order.map((g) => g.slice())

  if (zeros.length > 0) {
    // integer clocks tick just above their integer: those already at their max
    // cross it and become "above"; the rest form a new lowest fractional group.
    const newLow: number[] = []
    for (const i of zeros) {
      frac0[i] = false
      if (intp[i] >= max[i]) {
        above[i] = true
      } else {
        newLow.push(i)
      }
    }
    order = newLow.length > 0 ? [newLow.sort((a, b) => a - b), ...order] : order
  } else {
    // no integer clock: advance until the largest-fraction group reaches the
    // next integer (fraction → 0). They leave the fractional order.
    const top = order[order.length - 1]
    order = order.slice(0, order.length - 1)
    for (const i of top) {
      intp[i] += 1
      frac0[i] = true
    }
  }
  return canonRegion({ above, intp, frac0, order })
}

/** Reset a clock to 0 within a region. */
export function resetRegion(r0: Region, ci: number): Region {
  const r = canonRegion(r0)
  const above = r.above.slice()
  const intp = r.intp.slice()
  const frac0 = r.frac0.slice()
  above[ci] = false
  intp[ci] = 0
  frac0[ci] = true
  const order = r.order.map((g) => g.filter((i) => i !== ci)).filter((g) => g.length > 0)
  return canonRegion({ above, intp, frac0, order })
}

export function resetRegionMany(r: Region, cis: number[]): Region {
  let cur = r
  for (const ci of cis) cur = resetRegion(cur, ci)
  return cur
}

// ─────────────────────────── the region automaton ───────────────────────────

export interface RegionState {
  loc: string
  region: Region
}

export interface RegionEdge {
  from: number
  to: number
  /** 'τ' for a delay edge, otherwise the discrete action */
  label: string
  kind: 'delay' | 'action'
}

export interface RegionGraph {
  states: RegionState[]
  edges: RegionEdge[]
  /** control locations reachable in the timed automaton */
  reachableLocations: Set<string>
  max: number[]
}

/**
 * Build the reachable part of the region automaton by BFS from `(initial, all
 * clocks = 0)`, interleaving delay edges (time-successor regions inside the
 * invariant) and discrete edges (guarded, reset, target-invariant-respecting).
 */
export function buildRegionGraph(ta: TimedAutomaton, cap = 4000): RegionGraph {
  const max = maxConstants(ta)
  const states: RegionState[] = []
  const edges: RegionEdge[] = []
  const index = new Map<string, number>()
  const reachableLocations = new Set<string>()

  const key = (loc: string, sig: string) => `${loc} ${sig}`
  const intern = (loc: string, region: Region): { id: number; isNew: boolean } => {
    const sig = regionSig(region)
    const k = key(loc, sig)
    const existing = index.get(k)
    if (existing !== undefined) return { id: existing, isNew: false }
    const id = states.length
    states.push({ loc, region })
    index.set(k, id)
    return { id, isNew: true }
  }

  const invOf = (loc: string): Constraint => {
    const l = ta.locations.find((x) => x.name === loc)
    return l ? l.invariant : []
  }

  const zeros = ta.clocks.map(() => 0)
  const r0 = regionOf(zeros, max)
  if (!satRegion(ta, r0, invOf(ta.initial))) {
    return { states, edges, reachableLocations, max }
  }
  const start = intern(ta.initial, r0)
  reachableLocations.add(ta.initial)

  const queue = [start.id]
  while (queue.length > 0 && states.length < cap) {
    const id = queue.shift()!
    const { loc, region } = states[id]

    // delay: single immediate time-successor inside the invariant
    const nxt = timeSucc(region, max)
    if (regionSig(nxt) !== regionSig(region) && satRegion(ta, nxt, invOf(loc))) {
      const nid = intern(loc, nxt)
      edges.push({ from: id, to: nid.id, label: 'τ', kind: 'delay' })
      if (nid.isNew) queue.push(nid.id)
    }

    // discrete edges
    for (const e of ta.edges) {
      if (e.from !== loc) continue
      if (!satRegion(ta, region, e.guard)) continue
      const cis = e.resets.map((c) => ta.clocks.indexOf(c)).filter((i) => i >= 0)
      const r2 = resetRegionMany(region, cis)
      if (!satRegion(ta, r2, invOf(e.to))) continue
      const nid = intern(e.to, r2)
      reachableLocations.add(e.to)
      edges.push({ from: id, to: nid.id, label: e.action || 'ε', kind: 'action' })
      if (nid.isNew) queue.push(nid.id)
    }
  }
  return { states, edges, reachableLocations, max }
}
