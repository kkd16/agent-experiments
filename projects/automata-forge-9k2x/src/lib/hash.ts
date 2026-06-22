// Shareable permalinks: the whole workspace round-trips through the URL hash, so any configuration
// is a link. Hash routing (rather than the History API) is also what keeps the app working under
// the catalog's relative subpath, where path-based routes 404 on refresh.

import { decodeEdit, encodeEdit, emptyAutomaton } from '../engine/edit'
import type { EditAutomaton } from '../engine/edit'

export type Mode = 'explore' | 'compare' | 'build' | 'grammar' | 'machine'

export interface AppState {
  mode: Mode
  explore: { regex: string; tab: string; input: string }
  compare: { a: string; b: string; op: string; input: string }
  build: { automaton: EditAutomaton; tab: string; input: string }
  grammar: { text: string; tab: string; input: string }
  machine: { source: string; tab: string; input: string }
}

export function encodeHash(s: AppState): string {
  const q = new URLSearchParams()
  if (s.mode === 'compare') {
    q.set('a', s.compare.a)
    q.set('b', s.compare.b)
    q.set('op', s.compare.op)
    if (s.compare.input) q.set('i', s.compare.input)
    return `#/compare?${q.toString()}`
  }
  if (s.mode === 'build') {
    q.set('m', encodeEdit(s.build.automaton))
    q.set('t', s.build.tab)
    if (s.build.input) q.set('i', s.build.input)
    return `#/build?${q.toString()}`
  }
  if (s.mode === 'grammar') {
    q.set('g', s.grammar.text)
    q.set('t', s.grammar.tab)
    if (s.grammar.input) q.set('i', s.grammar.input)
    return `#/grammar?${q.toString()}`
  }
  if (s.mode === 'machine') {
    q.set('tm', s.machine.source)
    q.set('t', s.machine.tab)
    if (s.machine.input) q.set('i', s.machine.input)
    return `#/machine?${q.toString()}`
  }
  q.set('r', s.explore.regex)
  q.set('t', s.explore.tab)
  if (s.explore.input) q.set('i', s.explore.input)
  return `#/explore?${q.toString()}`
}

export function decodeHash(raw: string, fallback: AppState): AppState {
  try {
    let h = raw.startsWith('#') ? raw.slice(1) : raw
    if (h.startsWith('/')) h = h.slice(1)
    const qIdx = h.indexOf('?')
    const path = qIdx >= 0 ? h.slice(0, qIdx) : h
    const q = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '')
    if (path === 'compare') {
      return {
        ...fallback,
        mode: 'compare',
        compare: {
          a: q.get('a') ?? fallback.compare.a,
          b: q.get('b') ?? fallback.compare.b,
          op: q.get('op') ?? fallback.compare.op,
          input: q.get('i') ?? '',
        },
      }
    }
    if (path === 'build') {
      const m = q.get('m')
      const automaton = (m && decodeEdit(m)) || fallback.build.automaton || emptyAutomaton()
      return {
        ...fallback,
        mode: 'build',
        build: {
          automaton,
          tab: q.get('t') ?? fallback.build.tab,
          input: q.get('i') ?? '',
        },
      }
    }
    if (path === 'grammar') {
      return {
        ...fallback,
        mode: 'grammar',
        grammar: {
          text: q.get('g') ?? fallback.grammar.text,
          tab: q.get('t') ?? fallback.grammar.tab,
          input: q.get('i') ?? '',
        },
      }
    }
    if (path === 'machine') {
      return {
        ...fallback,
        mode: 'machine',
        machine: {
          source: q.get('tm') ?? fallback.machine.source,
          tab: q.get('t') ?? fallback.machine.tab,
          input: q.get('i') ?? '',
        },
      }
    }
    if (path === 'explore') {
      return {
        ...fallback,
        mode: 'explore',
        explore: {
          regex: q.get('r') ?? fallback.explore.regex,
          tab: q.get('t') ?? fallback.explore.tab,
          input: q.get('i') ?? '',
        },
      }
    }
  } catch {
    /* malformed hash — fall through to defaults */
  }
  return fallback
}
