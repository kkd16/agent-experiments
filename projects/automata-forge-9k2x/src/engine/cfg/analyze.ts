// The fixpoint analyses that every later stage (normalisation, parsing tables, the UI) leans on.
//
// All four are least-fixpoint computations: start empty and keep adding until nothing changes.

import type { Grammar } from './grammar'
import { ntSetOf } from './grammar'

/** Nonterminals that can derive the empty word ε. */
export function nullableSet(g: Grammar): Set<string> {
  const nt = ntSetOf(g)
  const nullable = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const p of g.productions) {
      if (nullable.has(p.lhs)) continue
      // A -> α is nullable when every symbol of α is a nullable nonterminal.
      if (p.rhs.every((s) => nt.has(s) && nullable.has(s))) {
        nullable.add(p.lhs)
        changed = true
      }
    }
  }
  return nullable
}

/** Symbols (terminals and nonterminals) that derive at least one terminal string. */
export function generatingSet(g: Grammar): Set<string> {
  const nt = ntSetOf(g)
  const gen = new Set<string>()
  for (const t of g.terminals) gen.add(t)
  let changed = true
  while (changed) {
    changed = false
    for (const p of g.productions) {
      if (gen.has(p.lhs)) continue
      if (p.rhs.every((s) => gen.has(s) || !nt.has(s))) {
        // every RHS symbol is generating (terminals are always generating)
        gen.add(p.lhs)
        changed = true
      }
    }
  }
  return gen
}

/** Symbols reachable from the start symbol by following productions. */
export function reachableSet(g: Grammar): Set<string> {
  const reach = new Set<string>([g.start])
  let changed = true
  while (changed) {
    changed = false
    for (const p of g.productions) {
      if (!reach.has(p.lhs)) continue
      for (const s of p.rhs) {
        if (!reach.has(s)) {
          reach.add(s)
          changed = true
        }
      }
    }
  }
  return reach
}

export interface Usefulness {
  nullable: Set<string>
  generating: Set<string>
  reachable: Set<string>
  /** Nonterminals that are not both generating and reachable. */
  uselessNts: string[]
}

export function analyzeUsefulness(g: Grammar): Usefulness {
  const nullable = nullableSet(g)
  const generating = generatingSet(g)
  const reachable = reachableSet(g)
  const uselessNts = g.nonterminals.filter((n) => !(generating.has(n) && reachable.has(n)))
  return { nullable, generating, reachable, uselessNts }
}

const EPS = '' // marker inside FIRST sets meaning "ε is in FIRST"

export interface FirstFollow {
  /** FIRST(X) for every symbol X. ε is represented by the empty-string member `''`. */
  first: Map<string, Set<string>>
  /** FOLLOW(A) for every nonterminal A. The end-marker is `'$'`. */
  follow: Map<string, Set<string>>
}

/** FIRST of a string of symbols, given per-symbol FIRST sets. Includes ε iff the whole string is nullable. */
export function firstOfSeq(seq: string[], first: Map<string, Set<string>>, nt: Set<string>): Set<string> {
  const out = new Set<string>()
  let allNullable = true
  for (const s of seq) {
    const fs = nt.has(s) ? first.get(s) ?? new Set<string>() : new Set([s])
    for (const x of fs) if (x !== EPS) out.add(x)
    const sNullable = nt.has(s) ? fs.has(EPS) : false
    if (!sNullable) {
      allNullable = false
      break
    }
  }
  if (allNullable) out.add(EPS)
  return out
}

/** Compute FIRST and FOLLOW sets. `'$'` marks end-of-input in FOLLOW; `''` marks ε in FIRST. */
export function firstFollow(g: Grammar): FirstFollow {
  const nt = ntSetOf(g)
  const first = new Map<string, Set<string>>()
  for (const n of g.nonterminals) first.set(n, new Set())

  // FIRST fixpoint.
  let changed = true
  while (changed) {
    changed = false
    for (const p of g.productions) {
      const target = first.get(p.lhs)!
      const before = target.size
      // FIRST of the body.
      let allNullable = true
      for (const s of p.rhs) {
        if (nt.has(s)) {
          const fs = first.get(s)!
          for (const x of fs) if (x !== EPS) target.add(x)
          if (!fs.has(EPS)) {
            allNullable = false
            break
          }
        } else {
          target.add(s)
          allNullable = false
          break
        }
      }
      if (allNullable) target.add(EPS)
      if (target.size !== before) changed = true
    }
  }

  // FOLLOW fixpoint.
  const follow = new Map<string, Set<string>>()
  for (const n of g.nonterminals) follow.set(n, new Set())
  follow.get(g.start)!.add('$')

  changed = true
  while (changed) {
    changed = false
    for (const p of g.productions) {
      for (let i = 0; i < p.rhs.length; i++) {
        const B = p.rhs[i]
        if (!nt.has(B)) continue
        const fol = follow.get(B)!
        const before = fol.size
        const rest = p.rhs.slice(i + 1)
        const firstRest = firstOfSeq(rest, first, nt)
        for (const x of firstRest) if (x !== EPS) fol.add(x)
        if (firstRest.has(EPS) || rest.length === 0) {
          for (const x of follow.get(p.lhs)!) fol.add(x)
        }
        if (fol.size !== before) changed = true
      }
    }
  }

  return { first, follow }
}
