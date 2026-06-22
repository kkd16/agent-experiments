// Thompson's construction: compile a regex AST into an ε-NFA.
//
// Each AST node compiles to a "fragment" with exactly one start and one accept state, wired
// together with ε-transitions. This keeps the construction compositional and the proof of
// correctness obvious — every operator just glues fragments with ε edges.

import type { Ast, Nfa, NfaEdge, Sym } from './types'
import { deriveAlphabet, matchedSymbols } from './alphabet'
import type { Alphabet } from './alphabet'

interface Fragment {
  start: number
  accept: number
}

class Builder {
  edges: NfaEdge[] = []
  private count = 0

  state(): number {
    return this.count++
  }

  get numStates(): number {
    return this.count
  }

  eps(from: number, to: number): void {
    this.edges.push({ from, to, sym: null })
  }

  sym(from: number, to: number, sym: Sym): void {
    this.edges.push({ from, to, sym })
  }
}

function build(node: Ast, b: Builder, alpha: Alphabet): Fragment {
  switch (node.type) {
    case 'epsilon': {
      const s = b.state()
      const a = b.state()
      b.eps(s, a)
      return { start: s, accept: a }
    }
    case 'char': {
      const s = b.state()
      const a = b.state()
      // One edge per concrete alphabet symbol the predicate matches.
      for (const sym of matchedSymbols(node.pred, alpha)) b.sym(s, a, sym)
      return { start: s, accept: a }
    }
    case 'concat': {
      if (node.parts.length === 0) {
        const s = b.state()
        const a = b.state()
        b.eps(s, a)
        return { start: s, accept: a }
      }
      const frags = node.parts.map((p) => build(p, b, alpha))
      for (let i = 0; i + 1 < frags.length; i++) {
        b.eps(frags[i].accept, frags[i + 1].start)
      }
      return { start: frags[0].start, accept: frags[frags.length - 1].accept }
    }
    case 'alt': {
      const s = b.state()
      const a = b.state()
      for (const opt of node.options) {
        const f = build(opt, b, alpha)
        b.eps(s, f.start)
        b.eps(f.accept, a)
      }
      return { start: s, accept: a }
    }
    case 'star': {
      const s = b.state()
      const a = b.state()
      const f = build(node.node, b, alpha)
      b.eps(s, f.start)
      b.eps(s, a) // skip (zero copies)
      b.eps(f.accept, f.start) // loop
      b.eps(f.accept, a)
      return { start: s, accept: a }
    }
    case 'plus': {
      const s = b.state()
      const a = b.state()
      const f = build(node.node, b, alpha)
      b.eps(s, f.start)
      b.eps(f.accept, f.start) // loop (one or more)
      b.eps(f.accept, a)
      return { start: s, accept: a }
    }
    case 'opt': {
      const s = b.state()
      const a = b.state()
      const f = build(node.node, b, alpha)
      b.eps(s, f.start)
      b.eps(s, a) // skip
      b.eps(f.accept, a)
      return { start: s, accept: a }
    }
  }
}

/**
 * Compile an AST into an ε-NFA. By default the alphabet is derived from the AST itself; pass an
 * explicit `alpha` to compile *over a wider alphabet* (used by the product construction, where two
 * regexes must be built over their shared alphabet so every concrete character is handled the same
 * way by both machines). Widening is semantics-preserving: a symbol that is "OTHER" for this AST
 * but explicit in the shared alphabet is matched by exactly the predicates that would have matched
 * OTHER (`.` and negated classes), so the recognized language over real strings is unchanged.
 */
export function buildNfa(ast: Ast, alpha: Alphabet = deriveAlphabet(ast)): Nfa {
  const b = new Builder()
  const frag = build(ast, b, alpha)
  return {
    numStates: b.numStates,
    start: frag.start,
    accept: frag.accept,
    edges: b.edges,
    alphabet: alpha.symbols,
  }
}

/** Adjacency helpers used by simulation and subset construction. */
export interface NfaIndex {
  /** epsilonOut[s] = states reachable from s via a single ε edge. */
  epsilonOut: number[][]
  /** symOut[s].get(sym) = states reachable from s on that symbol. */
  symOut: Map<Sym, number[]>[]
}

export function indexNfa(nfa: Nfa): NfaIndex {
  const epsilonOut: number[][] = Array.from({ length: nfa.numStates }, () => [])
  const symOut: Map<Sym, number[]>[] = Array.from({ length: nfa.numStates }, () => new Map())
  for (const e of nfa.edges) {
    if (e.sym === null) {
      epsilonOut[e.from].push(e.to)
    } else {
      const m = symOut[e.from]
      const arr = m.get(e.sym)
      if (arr) arr.push(e.to)
      else m.set(e.sym, [e.to])
    }
  }
  return { epsilonOut, symOut }
}

/** ε-closure of a set of states (the set plus everything reachable on ε edges only). */
export function epsilonClosure(states: Iterable<number>, idx: NfaIndex): Set<number> {
  const result = new Set<number>()
  const stack: number[] = []
  for (const s of states) {
    if (!result.has(s)) {
      result.add(s)
      stack.push(s)
    }
  }
  while (stack.length) {
    const s = stack.pop()!
    for (const t of idx.epsilonOut[s]) {
      if (!result.has(t)) {
        result.add(t)
        stack.push(t)
      }
    }
  }
  return result
}

/** States reachable from a set on a given symbol (no ε-closure applied). */
export function move(states: Iterable<number>, sym: Sym, idx: NfaIndex): Set<number> {
  const out = new Set<number>()
  for (const s of states) {
    const ts = idx.symOut[s].get(sym)
    if (ts) for (const t of ts) out.add(t)
  }
  return out
}
