// Turn an NFA or DFA into the renderer-friendly GraphModel: merge parallel transitions into a
// single labelled edge and compress symbol sets into readable labels (ranges, Σ, ∗).

import type { Dfa, GraphModel, Nfa, Sym } from './types'
import { OTHER, showChar } from './types'

/** Compress a set of alphabet symbols into a compact label like `0-9, _` or `Σ` or `a, ∗`. */
export function formatSymbols(syms: Sym[], alphabet: Sym[]): string {
  const set = new Set(syms)
  if (set.size === alphabet.length && alphabet.length > 1) return 'Σ'

  const hasOther = set.has(OTHER)
  const chars = [...set].filter((s) => s !== OTHER).sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0))

  const parts: string[] = []
  let i = 0
  while (i < chars.length) {
    let j = i
    while (j + 1 < chars.length && chars[j + 1].charCodeAt(0) === chars[j].charCodeAt(0) + 1) j++
    if (j - i >= 2) {
      parts.push(`${showChar(chars[i])}-${showChar(chars[j])}`)
    } else {
      for (let k = i; k <= j; k++) parts.push(showChar(chars[k]))
    }
    i = j + 1
  }
  if (hasOther) parts.push('∗')
  return parts.join(',')
}

export function nfaToGraph(nfa: Nfa): GraphModel {
  // Group edges by (from,to); split ε from symbols so the label reads "ε" or a symbol set.
  const groups = new Map<string, { from: number; to: number; syms: Sym[]; eps: boolean }>()
  for (const e of nfa.edges) {
    const k = `${e.from}->${e.to}`
    let g = groups.get(k)
    if (!g) {
      g = { from: e.from, to: e.to, syms: [], eps: false }
      groups.set(k, g)
    }
    if (e.sym === null) g.eps = true
    else g.syms.push(e.sym)
  }
  const edges = [...groups.values()].map((g) => {
    const labels: string[] = []
    if (g.eps) labels.push('ε')
    if (g.syms.length) labels.push(formatSymbols(g.syms, nfa.alphabet))
    return { from: g.from, to: g.to, label: labels.join(', ') }
  })
  return {
    numStates: nfa.numStates,
    start: nfa.start,
    accepting: new Set([nfa.accept]),
    edges,
  }
}

export function dfaToGraph(dfa: Dfa): GraphModel {
  const groups = new Map<string, { from: number; to: number; syms: Sym[] }>()
  for (let s = 0; s < dfa.numStates; s++) {
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[s][c]
      if (t === undefined || t < 0) continue // partial DFA (pruned dead sink)
      const k = `${s}->${t}`
      let g = groups.get(k)
      if (!g) {
        g = { from: s, to: t, syms: [] }
        groups.set(k, g)
      }
      g.syms.push(dfa.alphabet[c])
    }
  }
  const edges = [...groups.values()].map((g) => ({
    from: g.from,
    to: g.to,
    label: formatSymbols(g.syms, dfa.alphabet),
  }))

  // Optional sub-labels: the subset (or merged states) each DFA state represents, when short.
  const stateSub = dfa.label?.map((l) => {
    if (!l) return undefined
    const inner = l.join(',')
    return inner.length <= 9 ? `{${inner}}` : `{${l.length}}`
  })

  return {
    numStates: dfa.numStates,
    start: dfa.start,
    accepting: dfa.accepting,
    edges,
    stateSub,
  }
}
