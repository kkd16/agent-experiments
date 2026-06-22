// An editable automaton model: the data behind Build mode, where you draw your own machine and
// the whole regex pipeline runs on it. The model is deliberately permissive — it can be a DFA, an
// NFA, or an ε-NFA, with any number of accepting states — and `editToNfa` compiles it down to the
// engine's single-accept `Nfa` (by routing every accepting state to one synthetic accept via ε),
// so subset construction, minimization, simulation, sampling and regex reconstruction all just work.

import type { Nfa, NfaEdge, Sym } from './types'
import type { Alphabet } from './alphabet'

export interface EditState {
  id: number
  x: number
  y: number
  accepting: boolean
}

export interface EditTrans {
  from: number // state id
  to: number // state id
  /** A single-character symbol, or null for an ε-transition. */
  symbol: string | null
}

export interface EditAutomaton {
  states: EditState[]
  /** id of the start state, or null when there is none yet. */
  start: number | null
  transitions: EditTrans[]
  /** Monotonic id allocator so deleting + re-adding never reuses an id. */
  nextId: number
}

export function emptyAutomaton(): EditAutomaton {
  return { states: [], start: null, transitions: [], nextId: 0 }
}

// --- pure editing operations (each returns a new model) --------------------

export function addState(a: EditAutomaton, x: number, y: number): EditAutomaton {
  const id = a.nextId
  const states = [...a.states, { id, x, y, accepting: false }]
  return {
    ...a,
    states,
    nextId: id + 1,
    start: a.start === null ? id : a.start, // first state becomes the start
  }
}

export function removeState(a: EditAutomaton, id: number): EditAutomaton {
  const states = a.states.filter((s) => s.id !== id)
  const transitions = a.transitions.filter((t) => t.from !== id && t.to !== id)
  let start = a.start
  if (start === id) start = states.length ? states[0].id : null
  return { ...a, states, transitions, start }
}

export function moveState(a: EditAutomaton, id: number, x: number, y: number): EditAutomaton {
  return { ...a, states: a.states.map((s) => (s.id === id ? { ...s, x, y } : s)) }
}

export function toggleAccept(a: EditAutomaton, id: number): EditAutomaton {
  return {
    ...a,
    states: a.states.map((s) => (s.id === id ? { ...s, accepting: !s.accepting } : s)),
  }
}

export function setStart(a: EditAutomaton, id: number): EditAutomaton {
  return { ...a, start: id }
}

export function addTransition(
  a: EditAutomaton,
  from: number,
  to: number,
  symbol: string | null,
): EditAutomaton {
  // Dedupe exact duplicates.
  if (a.transitions.some((t) => t.from === from && t.to === to && t.symbol === symbol)) return a
  return { ...a, transitions: [...a.transitions, { from, to, symbol }] }
}

export function removeTransition(a: EditAutomaton, index: number): EditAutomaton {
  return { ...a, transitions: a.transitions.filter((_, i) => i !== index) }
}

// --- analysis --------------------------------------------------------------

/** The concrete alphabet (sorted, no OTHER sentinel) of the symbols the machine actually uses. */
export function editAlphabet(a: EditAutomaton): Sym[] {
  const set = new Set<string>()
  for (const t of a.transitions) if (t.symbol !== null) set.add(t.symbol)
  return [...set].sort((x, y) => x.charCodeAt(0) - y.charCodeAt(0))
}

/** Wrap a concrete symbol list in the engine's {@link Alphabet} shape (no OTHER in Build mode). */
export function editAlphabetObj(a: EditAutomaton): Alphabet {
  const symbols = editAlphabet(a)
  const index = new Map<Sym, number>()
  symbols.forEach((s, i) => index.set(s, i))
  return { symbols, index, truncated: false }
}

export type MachineKind = 'DFA' | 'NFA' | 'ε-NFA' | 'empty'

export interface Analysis {
  kind: MachineKind
  hasEpsilon: boolean
  nondeterministic: boolean
  /** A total DFA: deterministic, with a transition for every (state, symbol) and a non-empty Σ. */
  complete: boolean
  /** True when there is no start state to run from. */
  noStart: boolean
}

export function analyze(a: EditAutomaton): Analysis {
  if (a.states.length === 0) {
    return { kind: 'empty', hasEpsilon: false, nondeterministic: false, complete: false, noStart: true }
  }
  const hasEpsilon = a.transitions.some((t) => t.symbol === null)
  // Count distinct targets per (state, symbol) to detect nondeterminism.
  const targets = new Map<string, Set<number>>()
  for (const t of a.transitions) {
    if (t.symbol === null) continue
    const k = `${t.from}:${t.symbol}`
    const set = targets.get(k) ?? new Set<number>()
    set.add(t.to)
    targets.set(k, set)
  }
  const nondeterministic = hasEpsilon || [...targets.values()].some((s) => s.size > 1)
  const alphabet = editAlphabet(a)
  let complete = !nondeterministic && alphabet.length > 0
  if (complete) {
    for (const st of a.states) {
      for (const sym of alphabet) {
        if (!targets.get(`${st.id}:${sym}`)) {
          complete = false
          break
        }
      }
      if (!complete) break
    }
  }
  const kind: MachineKind = hasEpsilon ? 'ε-NFA' : nondeterministic ? 'NFA' : 'DFA'
  return { kind, hasEpsilon, nondeterministic, complete, noStart: a.start === null }
}

// --- compilation to the engine NFA -----------------------------------------

export interface CompiledEdit {
  nfa: Nfa
  alphabet: Alphabet
  /** Maps a compiled NFA state index back to the editor state id (synthetic accept maps to -1). */
  toEditId: number[]
}

/**
 * Compile the editable automaton into an engine ε-NFA. Editor state ids are renumbered to a dense
 * 0..n-1; a fresh synthetic accept state n collects ε-edges from every accepting state, satisfying
 * the engine's single-accept invariant while preserving the language. Returns null when there is no
 * start state (nothing to run).
 */
export function editToNfa(a: EditAutomaton): CompiledEdit | null {
  if (a.start === null || a.states.length === 0) return null
  const idToIdx = new Map<number, number>()
  a.states.forEach((s, i) => idToIdx.set(s.id, i))
  if (!idToIdx.has(a.start)) return null

  const n = a.states.length
  const accept = n // synthetic single accept
  const edges: NfaEdge[] = []
  for (const t of a.transitions) {
    const from = idToIdx.get(t.from)
    const to = idToIdx.get(t.to)
    if (from === undefined || to === undefined) continue
    edges.push({ from, to, sym: t.symbol })
  }
  for (const s of a.states) {
    if (s.accepting) edges.push({ from: idToIdx.get(s.id)!, to: accept, sym: null })
  }

  const alphabet = editAlphabetObj(a)
  const nfa: Nfa = {
    numStates: n + 1,
    start: idToIdx.get(a.start)!,
    accept,
    edges,
    alphabet: alphabet.symbols,
  }
  const toEditId = a.states.map((s) => s.id)
  toEditId.push(-1) // the synthetic accept
  return { nfa, alphabet, toEditId }
}

// --- serialization for permalinks ------------------------------------------
// Compact, delimiter-based and robust: symbols are stored as decimal char codes ('e' = ε), so no
// symbol can ever collide with a structural delimiter.

export function encodeEdit(a: EditAutomaton): string {
  const states = a.states
    .map((s) => `${Math.round(s.x)}.${Math.round(s.y)}.${s.accepting ? 1 : 0}`)
    .join(';')
  // Encode start/transition endpoints by *index* into the (renumbered) state list.
  const idToIdx = new Map<number, number>()
  a.states.forEach((s, i) => idToIdx.set(s.id, i))
  const start = a.start !== null ? idToIdx.get(a.start) ?? -1 : -1
  const trans = a.transitions
    .filter((t) => idToIdx.has(t.from) && idToIdx.has(t.to))
    .map((t) => {
      const sym = t.symbol === null ? 'e' : String(t.symbol.charCodeAt(0))
      return `${idToIdx.get(t.from)}.${idToIdx.get(t.to)}.${sym}`
    })
    .join(',')
  return `${states}~${start}~${trans}`
}

export function decodeEdit(raw: string): EditAutomaton | null {
  try {
    const [statesPart, startPart, transPart] = raw.split('~')
    const states: EditState[] = (statesPart ? statesPart.split(';') : [])
      .filter(Boolean)
      .map((chunk, id) => {
        const [x, y, acc] = chunk.split('.')
        return { id, x: Number(x), y: Number(y), accepting: acc === '1' }
      })
    if (states.some((s) => !Number.isFinite(s.x) || !Number.isFinite(s.y))) return null
    const startIdx = Number(startPart)
    const start = startIdx >= 0 && startIdx < states.length ? states[startIdx].id : null
    const transitions: EditTrans[] = (transPart ? transPart.split(',') : [])
      .filter(Boolean)
      .map((chunk) => {
        const [f, t, s] = chunk.split('.')
        const from = states[Number(f)]?.id
        const to = states[Number(t)]?.id
        const symbol = s === 'e' ? null : String.fromCharCode(Number(s))
        return { from, to, symbol }
      })
      .filter((t): t is EditTrans => t.from !== undefined && t.to !== undefined)
    return { states, start, transitions, nextId: states.length }
  } catch {
    return null
  }
}

// --- starter templates ------------------------------------------------------

/** A few machines worth loading: an NFA, an ε-NFA, and a DFA. */
export const BUILD_TEMPLATES: { name: string; note: string; make: () => EditAutomaton }[] = [
  {
    name: 'NFA · ends with “ab”',
    note: 'Nondeterministic: q0 loops on a,b and guesses when the final “ab” begins.',
    make: () => ({
      nextId: 3,
      start: 0,
      states: [
        { id: 0, x: 120, y: 120, accepting: false },
        { id: 1, x: 300, y: 120, accepting: false },
        { id: 2, x: 480, y: 120, accepting: true },
      ],
      transitions: [
        { from: 0, to: 0, symbol: 'a' },
        { from: 0, to: 0, symbol: 'b' },
        { from: 0, to: 1, symbol: 'a' },
        { from: 1, to: 2, symbol: 'b' },
      ],
    }),
  },
  {
    name: 'ε-NFA · a* then b*',
    note: 'Two loops joined by an ε-jump — Thompson-style, with ε-transitions to determinize away.',
    make: () => ({
      nextId: 2,
      start: 0,
      states: [
        { id: 0, x: 140, y: 140, accepting: true },
        { id: 1, x: 360, y: 140, accepting: true },
      ],
      transitions: [
        { from: 0, to: 0, symbol: 'a' },
        { from: 0, to: 1, symbol: null },
        { from: 1, to: 1, symbol: 'b' },
      ],
    }),
  },
  {
    name: 'DFA · binary, divisible by 3',
    note: 'A complete 3-state DFA tracking the remainder mod 3 of a binary numeral. Already minimal.',
    make: () => ({
      nextId: 3,
      start: 0,
      states: [
        { id: 0, x: 140, y: 160, accepting: true },
        { id: 1, x: 340, y: 80, accepting: false },
        { id: 2, x: 340, y: 260, accepting: false },
      ],
      transitions: [
        { from: 0, to: 0, symbol: '0' },
        { from: 0, to: 1, symbol: '1' },
        { from: 1, to: 2, symbol: '0' },
        { from: 1, to: 0, symbol: '1' },
        { from: 2, to: 1, symbol: '0' },
        { from: 2, to: 2, symbol: '1' },
      ],
    }),
  },
]
