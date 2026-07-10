// SYMBOLIC forward reachability with ZONES — the algorithm a real model checker
// (UPPAAL and friends) actually runs. Instead of Alur–Dill's exponentially many
// regions, it explores (location, zone) symbolic states, where each zone is a
// DBM standing for a convex set of valuations. One symbolic step is: intersect
// with the guard, reset, let time elapse under the target invariant, then
// EXTRAPOLATE so only finitely many zones ever appear. The set of reachable
// locations it computes is provably identical to the region automaton's — which
// is exactly what the Verify tab checks, live.

import type { Constraint, TimedAutomaton } from './types'
import { clockIndex, maxConstants } from './types'
import type { DBM } from './dbm'
import {
  applyAtom,
  canonicalize,
  cloneDBM,
  extrapolate,
  includes,
  isEmpty,
  resetMany,
  up,
  zeroZone,
} from './dbm'

/** Intersect a DBM with a whole constraint (conjunction of atomic clock bounds). */
export function applyConstraint(ta: TimedAutomaton, d: DBM, c: Constraint): DBM {
  let r = d
  for (const a of c) {
    r = applyAtom(r, clockIndex(ta, a.clock), a.op, a.bound)
    if (isEmpty(r)) return r
  }
  return r
}

export interface ZoneState {
  loc: string
  zone: DBM
}

export interface ZoneEdge {
  from: number
  to: number
  label: string
  kind: 'action'
}

export interface ZoneGraph {
  states: ZoneState[]
  edges: ZoneEdge[]
  reachableLocations: Set<string>
  max: number[]
  /** true if exploration hit the state cap before closing (should not happen with extrapolation) */
  truncated: boolean
}

/** The initial symbolic state: all clocks 0, delayed under the initial invariant, extrapolated. */
function initialZone(ta: TimedAutomaton, max: number[]): DBM | null {
  const inv = locInv(ta, ta.initial)
  let z = zeroZone(ta.clocks.length)
  z = applyConstraint(ta, z, inv) // 0 must satisfy the invariant
  if (isEmpty(z)) return null
  z = canonicalize(up(cloneDBM(z)))
  z = applyConstraint(ta, z, inv) // delay bounded by the invariant
  if (isEmpty(z)) return null
  return extrapolate(z, max)
}

function locInv(ta: TimedAutomaton, loc: string): Constraint {
  const l = ta.locations.find((x) => x.name === loc)
  return l ? l.invariant : []
}

/**
 * The successor zone of taking edge `e` from `(loc, zone)`:
 *   reset( zone ∧ guard ) ∧ inv(to), then delay under inv(to), then extrapolate.
 * Returns null when the composite zone is empty (the edge is disabled).
 */
export function stepZone(ta: TimedAutomaton, zone: DBM, e: TimedAutomaton['edges'][number], max: number[]): DBM | null {
  let z = applyConstraint(ta, zone, e.guard)
  if (isEmpty(z)) return null
  const cis = e.resets.map((c) => clockIndex(ta, c))
  z = canonicalize(resetMany(z, cis))
  const inv = locInv(ta, e.to)
  z = applyConstraint(ta, z, inv) // entry satisfies invariant
  if (isEmpty(z)) return null
  z = canonicalize(up(z))
  z = applyConstraint(ta, z, inv) // delay bounded by invariant
  if (isEmpty(z)) return null
  return extrapolate(z, max)
}

/**
 * Explore the reachable symbolic state space. Visited zones per location are
 * kept as an inclusion-pruned frontier: a new zone contained in a seen one is
 * dropped, and seen zones contained in the new one are subsumed.
 */
export function buildZoneGraph(ta: TimedAutomaton, cap = 4000): ZoneGraph {
  const max = maxConstants(ta)
  const states: ZoneState[] = []
  const edges: ZoneEdge[] = []
  const reachableLocations = new Set<string>()
  const byLoc = new Map<string, number[]>() // loc -> state ids (the frontier)

  const z0 = initialZone(ta, max)
  if (!z0) return { states, edges, reachableLocations, max, truncated: false }

  const addState = (loc: string, zone: DBM): number => {
    const id = states.length
    states.push({ loc, zone })
    const arr = byLoc.get(loc)
    if (arr) arr.push(id)
    else byLoc.set(loc, [id])
    reachableLocations.add(loc)
    return id
  }

  // Returns the state id if the zone is genuinely new (else -1 when subsumed).
  const insert = (loc: string, zone: DBM): number => {
    const arr = byLoc.get(loc)
    if (arr) {
      for (const sid of arr) {
        if (includes(states[sid].zone, zone)) return -1 // zone ⊆ existing → nothing new
      }
    }
    return addState(loc, zone)
  }

  const start = addState(ta.initial, z0)
  const queue = [start]
  let truncated = false
  while (queue.length > 0) {
    if (states.length >= cap) {
      truncated = true
      break
    }
    const id = queue.shift()!
    const { loc, zone } = states[id]
    for (const e of ta.edges) {
      if (e.from !== loc) continue
      const succ = stepZone(ta, zone, e, max)
      if (!succ || isEmpty(succ)) continue
      const nid = insert(e.to, succ)
      // even when subsumed we still want the edge for the graph, pointing at the
      // subsuming state; find it.
      if (nid >= 0) {
        edges.push({ from: id, to: nid, label: e.action || 'ε', kind: 'action' })
        queue.push(nid)
      } else {
        const arr = byLoc.get(e.to)!
        const target = arr.find((sid) => includes(states[sid].zone, succ))
        if (target !== undefined) edges.push({ from: id, to: target, label: e.action || 'ε', kind: 'action' })
      }
    }
  }
  return { states, edges, reachableLocations, max, truncated }
}

/** Convenience: the set of location names reachable via the zone algorithm. */
export function reachableByZones(ta: TimedAutomaton): Set<string> {
  return buildZoneGraph(ta).reachableLocations
}
