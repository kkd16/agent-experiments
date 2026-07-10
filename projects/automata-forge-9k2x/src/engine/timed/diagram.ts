// Adapt timed automata and their region/zone quotients to the shared GraphModel
// so the app's layered layout + pan/zoom/export SVG renderer draws them for free.

import type { GraphModel } from '../types'
import type { Atom, Constraint, TimedAutomaton } from './types'
import type { RegionGraph } from './regions'
import { representative } from './regions'
import type { ZoneGraph } from './reach'
import { describeZone } from './dbm'

const NICE: Record<string, string> = { '<=': '≤', '>=': '≥', '<': '<', '>': '>', '=': '=' }

export function showAtom(a: Atom): string {
  return `${a.clock}${NICE[a.op]}${a.bound}`
}
export function showGuard(c: Constraint): string {
  return c.map(showAtom).join('∧')
}

/** Compact edge caption: `[guard] action {resets}`. */
function edgeCaption(guard: Constraint, action: string, resets: string[]): string {
  const parts: string[] = []
  if (guard.length) parts.push(showGuard(guard))
  if (action) parts.push(action)
  if (resets.length) parts.push(`{${resets.join(',')}}`)
  return parts.join(' ') || 'ε'
}

/** Merge parallel edges (same from→to) into one labelled entry. */
function mergeEdges(raw: { from: number; to: number; label: string }[]): { from: number; to: number; label: string }[] {
  const groups = new Map<string, { from: number; to: number; labels: string[] }>()
  for (const e of raw) {
    const k = `${e.from}->${e.to}`
    let g = groups.get(k)
    if (!g) {
      g = { from: e.from, to: e.to, labels: [] }
      groups.set(k, g)
    }
    if (!g.labels.includes(e.label)) g.labels.push(e.label)
  }
  return [...groups.values()].map((g) => ({ from: g.from, to: g.to, label: g.labels.join(' / ') }))
}

/** The timed automaton itself: locations → nodes (name + invariant as sub-label), edges captioned. */
export function timedToGraph(ta: TimedAutomaton): GraphModel {
  const idx = new Map<string, number>()
  ta.locations.forEach((l, i) => idx.set(l.name, i))
  const raw = ta.edges.map((e) => ({
    from: idx.get(e.from)!,
    to: idx.get(e.to)!,
    label: edgeCaption(e.guard, e.action, e.resets),
  }))
  const stateSub = ta.locations.map((l) => (l.invariant.length ? showGuard(l.invariant) : undefined))
  return {
    numStates: ta.locations.length,
    start: idx.get(ta.initial) ?? 0,
    accepting: new Set(ta.locations.map((l, i) => (l.accepting ? i : -1)).filter((i) => i >= 0)),
    edges: mergeEdges(raw),
    stateSub,
  }
}

/** The region automaton. Nodes carry the location as a sub-label; delay edges read `τ`. */
export function regionToGraph(rg: RegionGraph): GraphModel {
  const raw = rg.edges.map((e) => ({ from: e.from, to: e.to, label: e.label }))
  const stateSub = rg.states.map((s) => s.loc)
  return {
    numStates: rg.states.length,
    start: rg.states.length ? 0 : 0,
    accepting: new Set<number>(),
    edges: mergeEdges(raw),
    stateSub,
  }
}

/** The zone graph (symbolic reachability). Nodes carry the location as a sub-label. */
export function zoneToGraph(zg: ZoneGraph): GraphModel {
  const raw = zg.edges.map((e) => ({ from: e.from, to: e.to, label: e.label }))
  const stateSub = zg.states.map((s) => s.loc)
  return {
    numStates: zg.states.length,
    start: zg.states.length ? 0 : 0,
    accepting: new Set<number>(),
    edges: mergeEdges(raw),
    stateSub,
  }
}

/** A short human description of a region state, for the inspector list. */
export function describeRegionState(rg: RegionGraph, id: number, clocks: string[]): string {
  const s = rg.states[id]
  const v = representative(s.region, rg.max)
  const parts = clocks.map((c, i) => {
    const above = s.region.above[i]
    if (above) return `${c}>${rg.max[i]}`
    return `${c}≈${fmt(v[i])}`
  })
  return `${s.loc}: ${parts.join(', ')}`
}

/** A short human description of a zone state, for the inspector list. */
export function describeZoneState(zg: ZoneGraph, id: number, clocks: string[]): string {
  const s = zg.states[id]
  const cons = describeZone(s.zone, clocks)
  return `${s.loc}: ${cons.join(', ') || 'true'}`
}

function fmt(x: number): string {
  if (Number.isInteger(x)) return String(x)
  return x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}
