// Büchi automata — the ω-word ("infinite string") analogue of the finite-word NFA used everywhere
// else in the lab. A run is an *infinite* sequence of states; it is accepting when it visits an
// accepting state infinitely often. `translate.ts` turns an LTL formula into one of these.
//
// The GPVW tableau produces a *generalized* Büchi automaton (GBA): several acceptance sets, each of
// which must be hit infinitely often (one per "eventually" obligation). We keep that form for fidelity
// and then `degeneralize` it into an ordinary Büchi automaton (BA) with a single acceptance set, via
// the standard counter construction (Baier & Katoen, *Principles of Model Checking*, §4.3.3) — that
// single-set BA is what the graph view draws and what the model checker runs.
//
// Both forms are *state-labelled*: each state carries a propositional guard (`Lit[]`), and a run over
// a word σ₀σ₁… requires the letter σᵢ (the set of true atoms at step i) to satisfy state i's guard.

import type { GraphModel } from '../types'
import { GLYPH } from './formula'

/** A propositional literal: the atom must be true (`neg=false`) or false (`neg=true`). */
export interface Lit {
  atom: string
  neg: boolean
}

/** A generalized Büchi automaton (multiple acceptance sets), state-labelled. */
export interface GBA {
  states: GBAState[]
  initial: number[]
  /** Each set must be visited infinitely often. Empty array ⇒ every run is accepting. */
  acceptSets: Set<number>[]
  atoms: string[]
}

export interface GBAState {
  id: number
  label: Lit[] // propositional guard
  next: number[] // successor ids
  old: string[] // the GPVW Old-set, pretty-printed, for the inspector
}

/** An ordinary Büchi automaton: a single acceptance set, state-labelled. */
export interface BA {
  states: BAState[]
  initial: number[]
  accept: Set<number>
  atoms: string[]
}

export interface BAState {
  id: number
  label: Lit[]
  next: number[]
  gba: number // the GBA state this came from
  layer: number // the degeneralization counter layer
}

/** Does a letter (the set of true atoms) satisfy a guard? `true` for every literal it constrains. */
export function satGuard(label: Lit[], holds: (atom: string) => boolean): boolean {
  for (const l of label) {
    const t = holds(l.atom)
    if (l.neg ? t : !t) return false
  }
  return true
}

/** Pretty-print a guard: ⊤ for the empty (unconstrained) guard, else the literals joined by ∧. */
export function showGuard(label: Lit[]): string {
  if (label.length === 0) return GLYPH.top
  return label
    .map((l) => (l.neg ? GLYPH.not : '') + l.atom)
    .sort()
    .join(' ∧ ')
}

/**
 * Degeneralize a GBA into a single-acceptance Büchi automaton. With acceptance sets F₀…F_{k-1} the
 * BA tracks a layer counter i: it advances i→(i+1) mod k exactly when the current state lies in Fᵢ,
 * and accepts in layer 0 on the states of F₀. A run thus passes layer 0 infinitely often only if it
 * cycles through every Fᵢ infinitely often — exactly the generalized acceptance condition.
 */
export function degeneralize(g: GBA): BA {
  // No acceptance sets ⇒ every infinite run accepts; model that as one set containing all states.
  const sets = g.acceptSets.length > 0 ? g.acceptSets : [new Set(g.states.map((s) => s.id))]
  const k = sets.length

  const states: BAState[] = []
  const index = new Map<string, number>() // "gbaId#layer" -> BA id
  const queue: { q: number; i: number }[] = []

  const idOf = (q: number, i: number): number => {
    const key = `${q}#${i}`
    let id = index.get(key)
    if (id === undefined) {
      id = states.length
      index.set(key, id)
      states.push({ id, label: g.states[q].label, next: [], gba: q, layer: i })
      queue.push({ q, i })
    }
    return id
  }

  const initial = g.initial.map((q) => idOf(q, 0))

  while (queue.length) {
    const { q, i } = queue.shift()!
    const self = idOf(q, i)
    const advance = sets[i].has(q)
    const j = advance ? (i + 1) % k : i
    const seen = new Set<number>()
    for (const q2 of g.states[q].next) {
      const t = idOf(q2, j)
      if (!seen.has(t)) {
        seen.add(t)
        states[self].next.push(t)
      }
    }
  }

  const accept = new Set<number>()
  for (const s of states) if (s.layer === 0 && sets[0].has(s.gba)) accept.add(s.id)

  return { states, initial, accept, atoms: g.atoms }
}

/** Project a Büchi automaton onto the shared graph model. Guards show under each state. */
export function baToGraph(ba: BA): GraphModel {
  const edges: { from: number; to: number; label: string }[] = []
  for (const s of ba.states) for (const t of s.next) edges.push({ from: s.id, to: t, label: '' })
  return {
    numStates: ba.states.length,
    start: ba.initial[0] ?? 0,
    initial: ba.initial.slice(),
    accepting: new Set(ba.accept),
    edges,
    stateSub: ba.states.map((s) => showGuard(s.label)),
  }
}

/** Project a *generalized* Büchi automaton onto the graph model (no single acceptance ring). */
export function gbaToGraph(g: GBA): GraphModel {
  const edges: { from: number; to: number; label: string }[] = []
  for (const s of g.states) for (const t of s.next) edges.push({ from: s.id, to: t, label: '' })
  // A state shown "accepting" iff it is in *every* acceptance set (a reasonable single-ring summary).
  const accepting = new Set<number>()
  for (const s of g.states) {
    if (g.acceptSets.length === 0 || g.acceptSets.every((F) => F.has(s.id))) accepting.add(s.id)
  }
  return {
    numStates: g.states.length,
    start: g.initial[0] ?? 0,
    initial: g.initial.slice(),
    accepting,
    edges,
    stateSub: g.states.map((s) => showGuard(s.label)),
  }
}
