// The pumping lemma for regular languages, made concrete and playable.
//
// If a DFA has p states, then any accepted word w with |w| ≥ p must, in its first p steps, visit
// p + 1 states — so by the pigeonhole principle some state repeats. The repeat is a *loop* in the
// run, and the slice of w consumed while going around it is a non-empty middle y that can be pumped:
// writing w = x y z with |xy| ≤ p and y ≠ ε, every wᵢ = x yⁱ z (i ≥ 0) is also accepted, because the
// loop can be taken any number of times. This module finds that canonical decomposition and the
// pumped words, turning the textbook lemma into something you can scrub through.

import type { Dfa, Sym } from './types'
import { completeDfa, acceptsSyms } from './product'

/** The pumping length p = number of states of the (minimal) DFA. */
export function pumpingLength(minDfa: Dfa): number {
  return minDfa.numStates
}

export interface Decomposition {
  ok: boolean
  /** Why a decomposition could not be produced (word too short / not accepted / language finite). */
  reason?: string
  p: number
  word: Sym[]
  x: Sym[]
  y: Sym[]
  z: Sym[]
}

/** Run a word through a total DFA, returning the sequence of visited states (length |w| + 1). */
function runStates(dfa: Dfa, word: Sym[]): number[] {
  const states = [dfa.start]
  let s = dfa.start
  for (const sym of word) {
    const c = dfa.alphabet.indexOf(sym)
    s = dfa.trans[s][c]
    states.push(s)
  }
  return states
}

/**
 * Decompose an accepted word w (with |w| ≥ p) into x·y·z with |xy| ≤ p and y ≠ ε, using the first
 * repeated state in w's run over the totalised minimal DFA.
 */
export function decompose(minDfa: Dfa, word: Sym[]): Decomposition {
  const p = pumpingLength(minDfa)
  const total = completeDfa(minDfa)
  const base: Decomposition = { ok: false, p, word, x: [], y: [], z: [] }
  if (!acceptsSyms(minDfa, word)) return { ...base, reason: 'word is not in the language' }
  if (word.length < p) return { ...base, reason: `word is shorter than p = ${p}` }

  const states = runStates(total, word)
  // Find the first repeated state among the first p + 1 visited (indices 0..p).
  const firstSeenAt = new Map<number, number>()
  for (let i = 0; i <= p; i++) {
    const st = states[i]
    const prev = firstSeenAt.get(st)
    if (prev !== undefined) {
      return {
        ok: true,
        p,
        word,
        x: word.slice(0, prev),
        y: word.slice(prev, i),
        z: word.slice(i),
      }
    }
    firstSeenAt.set(st, i)
  }
  // Pigeonhole guarantees a repeat when |w| ≥ p, so this is unreachable for a valid input.
  return { ...base, reason: 'no repeated state found' }
}

/** Build the pumped word wᵢ = x·yⁱ·z. */
export function pump(d: Decomposition, i: number): Sym[] {
  const out = [...d.x]
  for (let k = 0; k < i; k++) out.push(...d.y)
  out.push(...d.z)
  return out
}

/**
 * Find a shortest accepted word with length ≥ p (a good candidate to pump). Returns null when the
 * language is finite with every word shorter than p — in which case the lemma is vacuous.
 */
export function findPumpableWord(dfa: Dfa, p: number): Sym[] | null {
  // BFS by length; the first accepted path of length ≥ p wins. If the language is infinite there is
  // always an accepted word of length in [p, 2p-1] (pump a short one), so this depth cap suffices,
  // while the guard keeps a pathological alphabet from blowing up.
  const maxDepth = Math.min(2 * p + 1, 36)
  const queue: { state: number; path: Sym[] }[] = [{ state: dfa.start, path: [] }]
  let guard = 0
  while (queue.length && guard++ < 300000) {
    const { state, path } = queue.shift()!
    if (path.length >= p && dfa.accepting.has(state)) return path
    if (path.length >= maxDepth) continue
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[state][c]
      if (t === undefined || t < 0) continue
      queue.push({ state: t, path: [...path, dfa.alphabet[c]] })
    }
  }
  return null
}
