// The algebraic heart of the lab: the **transition monoid** of a DFA and, when the DFA is the
// minimal one, the **syntactic monoid** of its language.
//
// Every word w over the alphabet acts on the state set of a complete DFA as a *transformation*
// t_w : Q → Q, where t_w(q) = δ*(q, w). The set of all these transformations, under composition,
// is a finite monoid — the transition monoid. Composition follows *word order*: reading u then v
// gives t_{uv} = t_v ∘ t_u, i.e. (a·b)(q) = b(a(q)).
//
// A classical theorem (Myhill; see Pin, *Mathematical Foundations of Automata Theory*) says the
// transition monoid of the **minimal complete DFA** of a regular language L is isomorphic to the
// *syntactic monoid* M(L) — the smallest monoid recognising L, the algebraic counterpart of the
// Myhill–Nerode automaton. So we compute one object and read the whole algebraic theory off it.

import { parse } from '../parser'
import { deriveAlphabet } from '../alphabet'
import { buildNfa } from '../nfa'
import { minimizeDfa, subsetConstruction } from '../dfa'
import type { Dfa, Sym } from '../types'

/** A transformation of the DFA state set: `transform[q]` is the state reached from `q`. */
export type Transform = number[]

export interface MonoidElement {
  id: number
  /** The transformation this element induces on the DFA states. */
  transform: Transform
  /** A shortest word inducing this transformation (BFS order). Empty array = the identity. */
  word: Sym[]
  /** Whether words mapping to this element are in the language: `transform[start] ∈ F`. */
  accepting: boolean
  /** e·e = e. Idempotents are the skeleton of Green's structure. */
  idempotent: boolean
}

export interface Monoid {
  /** Number of states of the complete DFA the monoid acts on. */
  n: number
  /** The complete DFA used (the minimal one, re-totalised with a trap if needed). */
  dfa: Dfa
  start: number
  accepting: Set<number>
  alphabet: Sym[]
  elements: MonoidElement[]
  /** Element id of the identity transformation (the image of the empty word ε). */
  identity: number
  /** For each alphabet symbol, the element id of its generator transformation. */
  gens: number[]
  /** Cayley table in word order: `mult[a][b]` is the id of the product a·b. */
  mult: number[][]
  /** |M|. */
  order: number
  /** True if the monoid exceeded the size cap and was not fully built (never for teaching inputs). */
  truncated: boolean
}

const canon = (t: Transform): string => t.join(',')

/**
 * Re-totalise a (possibly partial) DFA. `minimizeDfa` prunes the dead sink for a tidy diagram,
 * leaving `-1` transitions; the syntactic monoid needs the *complete* minimal DFA, so we add the
 * single trap back. Adding the unique dead sink to a minimal partial DFA yields the minimal
 * complete DFA — exactly the automaton whose transition monoid is the syntactic monoid.
 */
export function completeDfa(dfa: Dfa): Dfa {
  let partial = false
  for (const row of dfa.trans) {
    for (const t of row) if (t < 0) { partial = true; break }
    if (partial) break
  }
  if (!partial) return dfa
  const trap = dfa.numStates
  const trans = dfa.trans.map((row) => row.map((t) => (t < 0 ? trap : t)))
  trans.push(new Array(dfa.alphabet.length).fill(trap))
  return {
    ...dfa,
    numStates: dfa.numStates + 1,
    trans,
    label: dfa.label ? [...dfa.label, undefined] : undefined,
    trap,
  }
}

/** Build the transition monoid of a complete DFA by BFS over the generators from the identity. */
export function buildMonoid(dfaIn: Dfa, cap = 4000): Monoid {
  const dfa = completeDfa(dfaIn)
  const n = dfa.numStates
  const A = dfa.alphabet.length

  const elements: MonoidElement[] = []
  const index = new Map<string, number>()

  const intern = (t: Transform, word: Sym[]): number => {
    const k = canon(t)
    const existing = index.get(k)
    if (existing !== undefined) return existing
    const id = elements.length
    index.set(k, id)
    elements.push({
      id,
      transform: t,
      word,
      accepting: dfa.accepting.has(t[dfa.start]),
      idempotent: false,
    })
    return id
  }

  const identity: Transform = Array.from({ length: n }, (_, i) => i)
  const identityId = intern(identity, [])

  // Generator transformations: t_s(q) = δ(q, s).
  const genT: Transform[] = dfa.alphabet.map((_, s) =>
    Array.from({ length: n }, (_, q) => dfa.trans[q][s]),
  )

  // BFS from the identity: for element a and symbol s, a·s reads a's word then s.
  let truncated = false
  const queue = [identityId]
  while (queue.length) {
    const a = queue.shift()!
    const ta = elements[a].transform
    for (let s = 0; s < A; s++) {
      const g = genT[s]
      const comp: Transform = new Array(n)
      for (let q = 0; q < n; q++) comp[q] = g[ta[q]] // (a·s)(q) = s(a(q))
      const k = canon(comp)
      if (index.has(k)) continue
      if (elements.length >= cap) { truncated = true; continue }
      const e = intern(comp, [...elements[a].word, dfa.alphabet[s]])
      queue.push(e)
    }
  }

  const gens: number[] = genT.map((g) => index.get(canon(g))!)

  // Cayley table.
  const m = elements.length
  const mult: number[][] = Array.from({ length: m }, () => new Array<number>(m))
  for (let a = 0; a < m; a++) {
    const ta = elements[a].transform
    for (let b = 0; b < m; b++) {
      const tb = elements[b].transform
      const comp = new Array<number>(n)
      for (let q = 0; q < n; q++) comp[q] = tb[ta[q]] // (a·b)(q) = b(a(q))
      const found = index.get(canon(comp))
      mult[a][b] = found ?? a // `found` is defined whenever the monoid is closed (not truncated)
    }
  }

  for (let a = 0; a < m; a++) elements[a].idempotent = mult[a][a] === a

  return {
    n,
    dfa,
    start: dfa.start,
    accepting: dfa.accepting,
    alphabet: dfa.alphabet,
    elements,
    identity: identityId,
    gens,
    mult,
    order: m,
    truncated,
  }
}

/** Fold a word into its monoid element via the generators (−1 if a symbol is off-alphabet). */
export function wordToElement(mon: Monoid, word: Sym[]): number {
  let cur = mon.identity
  for (const s of word) {
    const si = mon.alphabet.indexOf(s)
    if (si < 0) return -1
    cur = mon.mult[cur][mon.gens[si]]
  }
  return cur
}

export interface BuildResult {
  ok: boolean
  error?: string
  monoid?: Monoid
  /** The minimal DFA (display-pruned) — handy for showing the recogniser alongside its algebra. */
  minimal?: Dfa
}

/** The full pipeline: regex → minimal DFA → syntactic monoid. */
export function syntacticMonoidFromRegex(regex: string): BuildResult {
  const res = parse(regex)
  if (!res.ok) return { ok: false, error: res.error.message }
  const alpha = deriveAlphabet(res.ast)
  const nfa = buildNfa(res.ast, alpha)
  const minimal = minimizeDfa(subsetConstruction(nfa))
  const monoid = buildMonoid(minimal)
  return { ok: true, monoid, minimal }
}
