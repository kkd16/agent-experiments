// Aether — a kind system for higher-kinded types
//
// A *kind* classifies a type the way a type classifies a value. `Int` and
// `List Int` are proper types of kind `*`; a type constructor like `List` or
// `Option` that still needs an argument has kind `* -> *`; `Either` has kind
// `* -> * -> *`. Kinds are what make higher-kinded type classes principled: a
// `Monad m` constrains an `m` of kind `* -> *`, and `instance Monad Int` is
// rejected because `Int : *` ≠ `* -> *`.
//
// Kinds are inferred exactly like types — by unification of mutable kind
// variables — so a class never declares its parameter's kind; it is read off how
// the methods use it (`bind : m a -> (a -> m b) -> m b` forces `m : * -> *`).

import type { Span } from './lexer.ts'

export interface KStar {
  k: 'star'
}
export interface KArrow {
  k: 'arrow'
  from: Kind
  to: Kind
}
export interface KVar {
  k: 'kvar'
  id: number
  ref: Kind | null
}

export type Kind = KStar | KArrow | KVar

export const kStar: KStar = { k: 'star' }

export function kArrow(from: Kind, to: Kind): KArrow {
  return { k: 'arrow', from, to }
}

let kindCounter = 0
export function freshKVar(): KVar {
  return { k: 'kvar', id: kindCounter++, ref: null }
}
export function resetKindCounter(): void {
  kindCounter = 0
}

/** Build the kind `k1 -> k2 -> … -> result`. */
export function kArrowN(args: Kind[], result: Kind): Kind {
  let acc = result
  for (let i = args.length - 1; i >= 0; i--) acc = kArrow(args[i], acc)
  return acc
}

export class KindError extends Error {
  span: Span | null
  constructor(message: string, span: Span | null) {
    super(message)
    this.name = 'KindError'
    this.span = span
  }
}

/** Follow kind-variable links to the representative kind. */
export function pruneKind(k: Kind): Kind {
  if (k.k === 'kvar' && k.ref !== null) {
    const rep = pruneKind(k.ref)
    k.ref = rep
    return rep
  }
  return k
}

function occursKind(v: KVar, k: Kind): boolean {
  const p = pruneKind(k)
  if (p.k === 'kvar') return p.id === v.id
  if (p.k === 'arrow') return occursKind(v, p.from) || occursKind(v, p.to)
  return false
}

/** Unify two kinds by mutation, throwing `KindError` on a clash. */
export function unifyKind(a: Kind, b: Kind, span: Span | null): void {
  const pa = pruneKind(a)
  const pb = pruneKind(b)
  if (pa.k === 'kvar' && pb.k === 'kvar' && pa.id === pb.id) return
  if (pa.k === 'kvar') {
    if (occursKind(pa, pb)) throw new KindError('cyclic kind', span)
    pa.ref = pb
    return
  }
  if (pb.k === 'kvar') {
    unifyKind(pb, pa, span)
    return
  }
  if (pa.k === 'star' && pb.k === 'star') return
  if (pa.k === 'arrow' && pb.k === 'arrow') {
    unifyKind(pa.from, pb.from, span)
    unifyKind(pa.to, pb.to, span)
    return
  }
  throw new KindError(
    `kind mismatch: ${kindToString(pa)} is not ${kindToString(pb)}`,
    span,
  )
}

/** Resolve a kind, replacing any still-unconstrained kind variable with `*`
 * (the standard kind-defaulting rule — an unused parameter is a proper type). */
export function defaultKind(k: Kind): Kind {
  const p = pruneKind(k)
  if (p.k === 'kvar') return kStar
  if (p.k === 'arrow') return kArrow(defaultKind(p.from), defaultKind(p.to))
  return kStar
}

export function kindToString(k: Kind): string {
  const p = pruneKind(k)
  if (p.k === 'star') return '*'
  if (p.k === 'kvar') return '*' // defaulted for display
  // left-associativity: `(* -> *) -> *` keeps its parens, `* -> * -> *` doesn't
  const from = p.from.k === 'arrow' ? `(${kindToString(p.from)})` : kindToString(p.from)
  return `${from} -> ${kindToString(p.to)}`
}

/** The number of arguments a kind takes before reaching `*` (its arity). */
export function kindArity(k: Kind): number {
  let p = pruneKind(k)
  let n = 0
  while (p.k === 'arrow') {
    n++
    p = pruneKind(p.to)
  }
  return n
}
