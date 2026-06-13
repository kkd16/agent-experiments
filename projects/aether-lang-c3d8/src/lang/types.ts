// Aether — type representations
//
// Types are either a mutable type variable (used for unification by mutation —
// the classic union-find-by-reference trick) or a type constructor applied to
// arguments (e.g. `Int`, `List a`, `a -> b`, tuples). A type scheme quantifies
// over a set of variable ids for let-polymorphism.

export interface TVar {
  kind: 'var'
  id: number
  /** when unified, points at the representative type; otherwise null */
  ref: Type | null
}

export interface TCon {
  kind: 'con'
  name: string
  args: Type[]
}

export type Type = TVar | TCon

export interface Scheme {
  /** quantified type-variable ids */
  vars: number[]
  type: Type
}

let varCounter = 0
export function resetVarCounter(): void {
  varCounter = 0
}
export function freshVar(): TVar {
  return { kind: 'var', id: varCounter++, ref: null }
}

export const ARROW = '->'
export const LIST = 'List'
export const TUPLE = '*'

export function tcon(name: string, args: Type[] = []): TCon {
  return { kind: 'con', name, args }
}
export const tInt = tcon('Int')
export const tFloat = tcon('Float')
export const tBool = tcon('Bool')
export const tString = tcon('String')
export const tUnit = tcon('Unit')
export function tArrow(from: Type, to: Type): TCon {
  return tcon(ARROW, [from, to])
}
export function tList(elem: Type): TCon {
  return tcon(LIST, [elem])
}
export function tTuple(elems: Type[]): TCon {
  return tcon(TUPLE, elems)
}

/** Follow variable links to the representative type (does not deep-resolve). */
export function prune(t: Type): Type {
  if (t.kind === 'var' && t.ref !== null) {
    const rep = prune(t.ref)
    t.ref = rep // path compression
    return rep
  }
  return t
}

/** Collect the ids of all free (unbound) variables reachable from `t`. */
export function freeVars(t: Type, acc: Set<number> = new Set()): Set<number> {
  const p = prune(t)
  if (p.kind === 'var') {
    acc.add(p.id)
  } else {
    for (const a of p.args) freeVars(a, acc)
  }
  return acc
}

/** Pretty-print a type, renaming free/quantified vars to a, b, c, … */
export function typeToString(t: Type, names: Map<number, string> = new Map()): string {
  let counter = names.size
  const nameOf = (id: number): string => {
    let n = names.get(id)
    if (n === undefined) {
      n = nextName(counter++)
      names.set(id, n)
    }
    return n
  }

  const go = (ty: Type, prec: number): string => {
    const p = prune(ty)
    if (p.kind === 'var') return nameOf(p.id)
    switch (p.name) {
      case ARROW: {
        const [from, to] = p.args
        const s = `${go(from, 2)} -> ${go(to, 1)}`
        return prec >= 2 ? `(${s})` : s
      }
      case LIST: {
        const s = `List ${go(p.args[0], 3)}`
        return prec >= 3 ? `(${s})` : s
      }
      case TUPLE: {
        if (p.args.length === 0) return '()'
        const s = p.args.map((a) => go(a, 2)).join(', ')
        return `(${s})`
      }
      default: {
        if (p.args.length === 0) return p.name
        const s = `${p.name} ${p.args.map((a) => go(a, 3)).join(' ')}`
        return prec >= 3 ? `(${s})` : s
      }
    }
  }
  return go(t, 0)
}

function nextName(i: number): string {
  // 0->a, 25->z, 26->a1, …
  const letter = String.fromCharCode(97 + (i % 26))
  const suffix = Math.floor(i / 26)
  return suffix === 0 ? letter : `${letter}${suffix}`
}

export function schemeToString(s: Scheme): string {
  const names = new Map<number, string>()
  // pre-seed quantified vars so they print first as a, b, c…
  s.vars.forEach((id) => {
    const i = names.size
    names.set(id, nextName(i))
  })
  const body = typeToString(s.type, names)
  if (s.vars.length === 0) return body
  const quant = s.vars.map((id) => names.get(id)).join(' ')
  return `∀ ${quant}. ${body}`
}
