// Adapt a Presburger `PDfa` to the shared `GraphModel` so the app's hand-written layered layout and
// pan/zoom/export SVG renderer draw it for free. Edge letters are bit-vectors over the variable
// tracks; a set of them on one edge is compressed to a subcube pattern (e.g. `1·` = track 0 is 1,
// track 1 is anything) when possible, else listed. The universally-rejecting sink is hidden to keep
// the diagram about the language, not the trap.

import type { GraphModel } from '../types'
import type { PDfa } from './automaton'
import { alphabetSize } from './automaton'

/** Render one letter as a string of per-track bits (track 0 leftmost). */
function letterToStr(letter: number, k: number): string {
  let s = ''
  for (let j = 0; j < k; j++) s += (letter >> j) & 1 ? '1' : '0'
  return s || 'ε'
}

/** Compress a set of letters on one edge to a compact label (subcube pattern, `Σ`, or a list). */
function edgeLabel(letters: number[], k: number): string {
  const A = alphabetSize(k)
  if (k === 0) return '' // single empty letter — no useful label
  if (letters.length === A) return 'Σ'
  const has0 = new Array(k).fill(false)
  const has1 = new Array(k).fill(false)
  for (const L of letters)
    for (let j = 0; j < k; j++) {
      if ((L >> j) & 1) has1[j] = true
      else has0[j] = true
    }
  let free = 0
  const pat: string[] = new Array(k)
  for (let j = 0; j < k; j++) {
    if (has0[j] && has1[j]) {
      pat[j] = '·'
      free++
    } else pat[j] = has1[j] ? '1' : '0'
  }
  if (1 << free === letters.length) return pat.join('')
  return letters
    .slice()
    .sort((a, b) => a - b)
    .map((L) => letterToStr(L, k))
    .join('/')
}

export interface PresburgerGraph {
  graph: GraphModel
  /** Map an original PDfa state id to its node index in the graph (−1 if hidden). */
  indexOf: (state: number) => number
}

export function presburgerToGraph(d: PDfa, opts: { hideTrap?: boolean } = {}): PresburgerGraph {
  const A = alphabetSize(d.k)
  const hideTrap = opts.hideTrap ?? true

  // A trap = a non-accepting state whose every transition self-loops.
  const isTrap = (s: number): boolean => {
    if (d.accept[s]) return false
    for (let a = 0; a < A; a++) if (d.trans[s][a] !== s) return false
    return true
  }
  const hidden = new Set<number>()
  if (hideTrap) for (let s = 0; s < d.numStates; s++) if (isTrap(s) && s !== d.start) hidden.add(s)

  const keep: number[] = []
  for (let s = 0; s < d.numStates; s++) if (!hidden.has(s)) keep.push(s)
  const remap = new Map<number, number>()
  keep.forEach((s, i) => remap.set(s, i))
  const idx = (s: number) => remap.get(s) ?? -1

  // Merge letters per surviving (from,to) pair.
  const byPair = new Map<string, { from: number; to: number; letters: number[] }>()
  for (const s of keep) {
    for (let a = 0; a < A; a++) {
      const t = d.trans[s][a]
      if (hidden.has(t)) continue
      const key = s + '->' + t
      let g = byPair.get(key)
      if (!g) {
        g = { from: idx(s), to: idx(t), letters: [] }
        byPair.set(key, g)
      }
      g.letters.push(a)
    }
  }
  const edges = [...byPair.values()].map((g) => ({ from: g.from, to: g.to, label: edgeLabel(g.letters, d.k) }))
  const accepting = new Set<number>()
  keep.forEach((s, i) => {
    if (d.accept[s]) accepting.add(i)
  })
  const graph: GraphModel = {
    numStates: keep.length,
    start: idx(d.start),
    accepting,
    edges,
  }
  return { graph, indexOf: idx }
}
