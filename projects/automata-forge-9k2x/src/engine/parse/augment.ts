// The augmented grammar that every bottom-up (LR) construction starts from.
//
// LR parsing needs a unique production to *accept* on, so we mint a fresh start symbol `S'` and a
// single production `S' -> S` (the original start). Reducing by that production — equivalently,
// reaching the item `S' -> S •` on end-of-input `$` — is the accept action. The augmented
// production is always index 0, so callers can special-case "is this the accept production?" with a
// cheap `prod === 0` check.

import type { Grammar, Production } from '../cfg/grammar'
import { freshNamer } from '../cfg/grammar'

export interface AugGrammar {
  /** The original grammar, untouched. */
  g: Grammar
  /** The fresh start symbol `S'` (guaranteed distinct from every symbol of `g`). */
  start: string
  /** Productions with the augmented `S' -> S` prepended at index 0, then `g.productions`. */
  prods: Production[]
  /** Nonterminals including the augmented start. */
  nt: Set<string>
  /** The real terminals of `g` (the end-marker `$` is handled separately by the table builders). */
  terminals: string[]
}

/** Build the augmented grammar `S' -> S` + all of `g`'s productions. */
export function augment(g: Grammar): AugGrammar {
  const namer = freshNamer([...g.nonterminals, ...g.terminals])
  const start = namer(`${g.start}'`)
  const prods: Production[] = [{ lhs: start, rhs: [g.start] }, ...g.productions]
  const nt = new Set<string>([start, ...g.nonterminals])
  return { g, start, prods, nt, terminals: [...g.terminals] }
}

/** Render a production `A -> α` (with `ε` for an empty body) — shared by every parser view. */
export function showProd(p: Production): string {
  const body = p.rhs.length === 0 ? 'ε' : p.rhs.join(' ')
  return `${p.lhs} → ${body}`
}
