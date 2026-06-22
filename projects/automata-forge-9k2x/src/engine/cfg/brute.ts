// Brute-force language enumeration by expanding leftmost nonterminals. Two uses:
//   • the UI's "shortest accepted words" sampler, and
//   • an independent membership oracle for differential testing (it shares no code with Earley/CYK).
//
// Termination on infinite grammars comes from a length lower-bound: precompute the minimum terminal
// length each nonterminal can yield, and prune any sentential form whose best-case length already
// exceeds the bound.

import type { Grammar } from './grammar'
import { ntSetOf, bodiesOf } from './grammar'

const INF = Infinity

/** Minimum terminal-string length each nonterminal can derive (∞ if it derives nothing). */
export function minLengths(g: Grammar): Map<string, number> {
  const nt = ntSetOf(g)
  const min = new Map<string, number>()
  for (const n of g.nonterminals) min.set(n, INF)
  let changed = true
  while (changed) {
    changed = false
    for (const p of g.productions) {
      let len = 0
      for (const s of p.rhs) {
        len += nt.has(s) ? min.get(s)! : 1
        if (len === INF) break
      }
      if (len < (min.get(p.lhs) ?? INF)) {
        min.set(p.lhs, len)
        changed = true
      }
    }
  }
  return min
}

/** Lower bound on the terminal length any completion of `form` can have. */
function lowerBound(form: string[], nt: Set<string>, min: Map<string, number>): number {
  let len = 0
  for (const s of form) {
    len += nt.has(s) ? min.get(s)! : 1
    if (len === INF) return INF
  }
  return len
}

export interface EnumerateOptions {
  maxLen: number
  /** Stop once this many distinct words are found (Infinity = exhaustive up to maxLen). */
  limit?: number
  /** Safety valve on the number of sentential forms explored. */
  expansionCap?: number
}

/**
 * Enumerate accepted words of length ≤ `maxLen`, sorted by length then lexicographically. Expands
 * the leftmost nonterminal of each sentential form, pruning by the length lower bound.
 */
export function enumerateLanguage(g: Grammar, opts: EnumerateOptions): string[] {
  const nt = ntSetOf(g)
  const min = minLengths(g)
  const limit = opts.limit ?? INF
  const cap = opts.expansionCap ?? 200_000
  const found = new Set<string>()
  const visited = new Set<string>()
  // Process by increasing lower bound so words come out shortest-first and we can stop early.
  let frontier: string[][] = [[g.start]]
  visited.add(g.start)
  let expansions = 0

  while (frontier.length > 0 && found.size < limit && expansions < cap) {
    const next: string[][] = []
    for (const form of frontier) {
      if (expansions >= cap) break
      // Leftmost nonterminal.
      const idx = form.findIndex((s) => nt.has(s))
      if (idx === -1) {
        const word = form.join('')
        if (word.length <= opts.maxLen) found.add(word)
        continue
      }
      const A = form[idx]
      for (const rhs of bodiesOf(g, A)) {
        expansions++
        const child = [...form.slice(0, idx), ...rhs, ...form.slice(idx + 1)]
        if (lowerBound(child, nt, min) > opts.maxLen) continue
        const k = child.join('')
        if (visited.has(k)) continue
        visited.add(k)
        next.push(child)
      }
    }
    frontier = next
  }

  return [...found].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Independent membership oracle: is `w` in `L(g)`? Enumerates words up to `|w|` and checks set
 * membership. Only meant for small strings (differential testing) — Earley is the real engine.
 */
export function bruteAccepts(g: Grammar, w: string): boolean {
  const words = enumerateLanguage(g, { maxLen: w.length, limit: INF })
  return words.includes(w)
}
