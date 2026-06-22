// A small regular-expression *term* algebra with smart constructors and a precedence-aware
// renderer, shared by every state-elimination routine (DFA→regex and NFA→regex). Keeping ε/∅
// folding and trivial union dedup in the constructors is what stops the reconstructed pattern
// from exploding into walls of parentheses.

import type { Sym } from './types'
import { OTHER } from './types'

// Render a single alphabet symbol as a *regex atom* — escaping metacharacters so the
// reconstructed pattern is itself a valid, re-parseable regex (e.g. a literal '.' becomes '\.').
const META = new Set(['.', '*', '+', '?', '(', ')', '|', '[', ']', '\\'])
export function regexAtom(ch: string): string {
  if (ch === OTHER) return '∗' // the "any other char" sentinel has no source-text form
  if (ch === '\n') return '\\n'
  if (ch === '\t') return '\\t'
  if (ch === '\r') return '\\r'
  if (META.has(ch)) return '\\' + ch
  return ch
}

export type Re =
  | { k: 'empty' } // ∅ — matches nothing
  | { k: 'eps' } // ε — the empty string
  | { k: 'lit'; s: string } // a single alphabet symbol, already display-formatted
  | { k: 'concat'; a: Re; b: Re }
  | { k: 'union'; a: Re; b: Re }
  | { k: 'star'; a: Re }

export const EMPTY: Re = { k: 'empty' }
export const EPS: Re = { k: 'eps' }

export function eq(a: Re, b: Re): boolean {
  if (a.k !== b.k) return false
  switch (a.k) {
    case 'empty':
    case 'eps':
      return true
    case 'lit':
      return a.s === (b as { s: string }).s
    case 'star':
      return eq(a.a, (b as { a: Re }).a)
    case 'concat':
    case 'union': {
      const bb = b as { a: Re; b: Re }
      return eq(a.a, bb.a) && eq(a.b, bb.b)
    }
  }
}

// --- smart constructors ----------------------------------------------------
export function union(a: Re, b: Re): Re {
  if (a.k === 'empty') return b
  if (b.k === 'empty') return a
  if (eq(a, b)) return a
  return { k: 'union', a, b }
}

export function concat(a: Re, b: Re): Re {
  if (a.k === 'empty' || b.k === 'empty') return EMPTY
  if (a.k === 'eps') return b
  if (b.k === 'eps') return a
  return { k: 'concat', a, b }
}

export function star(a: Re): Re {
  if (a.k === 'empty' || a.k === 'eps') return EPS
  if (a.k === 'star') return a // (r*)* = r*
  return { k: 'star', a }
}

export function litUnion(syms: Sym[]): Re {
  let re: Re = EMPTY
  for (const s of syms) re = union(re, { k: 'lit', s: regexAtom(s) })
  return re
}

// --- rendering with precedence ---------------------------------------------
// union < concat < star < atom
const PREC: Record<Re['k'], number> = { union: 1, concat: 2, star: 3, empty: 4, eps: 4, lit: 4 }

// A postfix quantifier (`*` or `?`) binds at precedence 3, like an atom's suffix.
function renderQuant(inner: Re, q: string, parentMin: number): string {
  const s = render(inner, 3) + q
  return 3 < parentMin ? `(${s})` : s
}

export function render(re: Re, parentMin: number): string {
  const wrap = (s: string) => (PREC[re.k] < parentMin ? `(${s})` : s)
  switch (re.k) {
    case 'empty':
      return '∅'
    case 'eps':
      return 'ε'
    case 'lit':
      return re.s
    case 'star':
      return renderQuant(re.a, '*', parentMin)
    case 'concat':
      return wrap(render(re.a, 2) + render(re.b, 2))
    case 'union':
      // `(ε|r)` is exactly the optional `r?` — render it that way (standard and re-parseable).
      if (re.a.k === 'eps') return renderQuant(re.b, '?', parentMin)
      if (re.b.k === 'eps') return renderQuant(re.a, '?', parentMin)
      return wrap(render(re.a, 1) + '|' + render(re.b, 1))
  }
}

/**
 * The generic GNFA state-elimination core. `R` is an (n+2)×(n+2) matrix of regex terms over the
 * `n` real states plus two fresh nodes START = n and ACCEPT = n+1; callers fill in the real-state
 * edges and we wire the new start/accept, then rip the real states out one by one. Eliminating
 * state k rewrites every path i → k → j into  R(i,j) ∪ R(i,k)·R(k,k)*·R(k,j). When only START and
 * ACCEPT remain, their single label is a regex for the whole language.
 */
export function solveGnfa(n: number, start: number, accepting: Iterable<number>, R: Re[][]): string {
  const START = n
  const ACCEPT = n + 1

  R[START][start] = union(R[START][start], EPS)
  for (const a of accepting) R[a][ACCEPT] = union(R[a][ACCEPT], EPS)

  const present = new Set<number>([START, ACCEPT])
  for (let s = 0; s < n; s++) present.add(s)

  for (let k = 0; k < n; k++) {
    present.delete(k)
    const loop = star(R[k][k])
    for (const i of present) {
      if (eq(R[i][k], EMPTY)) continue
      for (const j of present) {
        if (eq(R[k][j], EMPTY)) continue
        R[i][j] = union(R[i][j], concat(concat(R[i][k], loop), R[k][j]))
      }
    }
  }

  return render(R[START][ACCEPT], 0)
}

/** Allocate an (n+2)×(n+2) matrix of ∅ terms for {@link solveGnfa}. */
export function emptyMatrix(n: number): Re[][] {
  return Array.from({ length: n + 2 }, () => new Array<Re>(n + 2).fill(EMPTY))
}
