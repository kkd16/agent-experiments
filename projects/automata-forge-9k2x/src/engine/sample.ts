// Enumerate the shortest strings a DFA accepts (breadth-first over the language) and test
// membership. Used by the language-sampler panel.

import type { Dfa, Sym } from './types'
import { showSym } from './types'
import type { Alphabet } from './alphabet'
import { symbolOf } from './alphabet'

const MAX_NODES = 40000

export interface Sample {
  /** The accepted string rendered symbol-by-symbol ("ε" for the empty string). */
  display: string
  /** Length in symbols. */
  length: number
}

/**
 * BFS over the DFA's transition graph, emitting accepted strings in nondecreasing length. A node
 * budget guarantees termination even for infinite languages; the first `limit` accepted strings
 * found are therefore among the shortest. Strings are rendered with {@link showSym}, so the
 * "any other character" symbol appears as `∗`.
 */
export function sampleLanguage(dfa: Dfa, limit: number): Sample[] {
  const out: Sample[] = []
  const seen = new Set<string>()
  // Sort symbol indices so output is deterministic; explicit chars before OTHER (already last).
  const symOrder = dfa.alphabet.map((_, i) => i)

  const queue: { state: number; path: Sym[] }[] = [{ state: dfa.start, path: [] }]
  let nodes = 0

  while (queue.length && out.length < limit && nodes < MAX_NODES) {
    const { state, path } = queue.shift()!
    nodes++
    if (state < 0) continue
    if (dfa.accepting.has(state)) {
      const display = path.length === 0 ? 'ε' : path.map(showSym).join('')
      if (!seen.has(display)) {
        seen.add(display)
        out.push({ display, length: path.length })
        if (out.length >= limit) break
      }
    }
    for (const c of symOrder) {
      const next = dfa.trans[state][c]
      if (next === undefined || next < 0) continue
      queue.push({ state: next, path: [...path, dfa.alphabet[c]] })
    }
  }
  return out
}

/** Does the DFA accept the given string? */
export function accepts(dfa: Dfa, input: string, alpha: Alphabet): boolean {
  let state = dfa.start
  for (const ch of input) {
    const symIdx = alpha.index.get(symbolOf(ch, alpha))!
    const next = dfa.trans[state][symIdx]
    if (next === undefined || next < 0) return false
    state = next
  }
  return dfa.accepting.has(state)
}
