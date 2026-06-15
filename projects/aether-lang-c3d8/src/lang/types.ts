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

/**
 * The application of one type to another, `fn arg`. Used only when the head of
 * an application is (or may become) a *type variable* — e.g. `m a` in
 * `bind : m a -> (a -> m b) -> m b`. Concrete, saturated constructor
 * applications (`List a`, `Option a`, `a -> b`) stay as `TCon`s; unification
 * bridges the two representations (a `TCon` of arity ≥ 1 decomposes into a
 * `TApp` spine on demand). This is what makes Aether *higher-kinded*: a type
 * variable can stand for a type constructor like `Option` or `List` and be
 * applied to arguments, so genuine `Functor`/`Monad` classes are expressible.
 */
export interface TApp {
  kind: 'app'
  fn: Type
  arg: Type
}

export type Type = TVar | TCon | TApp

export function tapp(fn: Type, arg: Type): TApp {
  return { kind: 'app', fn, arg }
}

/** Apply `head` to a list of arguments, left-associatively (`head a b c`). */
export function tappN(head: Type, args: Type[]): Type {
  return args.reduce<Type>((f, a) => tapp(f, a), head)
}

/**
 * Collect an application spine into its ultimate head and the arguments applied
 * to it, looking through both `TApp` nodes and `TCon` arguments. So `Option a`
 * (a `TCon`), `m a` (a `TApp`) and `((m a) b)` all yield a head + arg list.
 */
export function spineOf(t: Type): { head: TVar | TCon; args: Type[] } {
  const args: Type[] = []
  let cur = prune(t)
  while (cur.kind === 'app') {
    args.unshift(prune(cur.arg))
    cur = prune(cur.fn)
  }
  // `cur` is now a var or con (the loop consumed every application node)
  if (cur.kind === 'con' && cur.args.length > 0) {
    return { head: tcon(cur.name), args: [...cur.args.map(prune), ...args] }
  }
  return { head: cur, args }
}

/**
 * A class-constraint predicate, e.g. `Disp a` or `Eq (List b)`. Used by the
 * type-class machinery: a qualified scheme carries the predicates that must be
 * satisfied (with a dictionary) before its body type can be used.
 */
export interface Pred {
  /** the class name (e.g. `Disp`, `Eq`, `Ord`) */
  cls: string
  /** the type the class is applied to */
  type: Type
}

export interface Scheme {
  /** quantified type-variable ids */
  vars: number[]
  type: Type
  /** class constraints qualifying the body type (`(Disp a, Eq a) => …`) */
  preds?: Pred[]
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
export const RECORD = 'Record'
export const ROW_EMPTY = '{}'
const ROW_PREFIX = 'row:'

export function tRecord(row: Type): TCon {
  return tcon(RECORD, [row])
}
export const tRowEmpty: TCon = tcon(ROW_EMPTY)
export function rowExtend(label: string, field: Type, rest: Type): TCon {
  return tcon(ROW_PREFIX + label, [field, rest])
}
export function isRow(t: Type): boolean {
  return t.kind === 'con' && (t.name === ROW_EMPTY || t.name.startsWith(ROW_PREFIX))
}
export function rowLabelOf(name: string): string {
  return name.slice(ROW_PREFIX.length)
}
export function isRowExtend(t: Type): t is TCon {
  return t.kind === 'con' && t.name.startsWith(ROW_PREFIX)
}

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
  } else if (p.kind === 'app') {
    freeVars(p.fn, acc)
    freeVars(p.arg, acc)
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
    if (p.kind === 'app') {
      const { head, args } = spineOf(p)
      if (args.length === 0) return go(head, prec)
      const s = `${go(head, 3)} ${args.map((a) => go(a, 3)).join(' ')}`
      return prec >= 3 ? `(${s})` : s
    }
    // A constructor may now legitimately appear *unsaturated* (e.g. bare `List`,
    // kind `* -> *`, when it stands in for a higher-kinded type variable), so the
    // special syntactic forms apply only at their exact arity; otherwise the type
    // prints in generic `Head args…` form (the `default` case below).
    switch (p.name) {
      case ARROW: {
        if (p.args.length !== 2) break
        const [from, to] = p.args
        const s = `${go(from, 2)} -> ${go(to, 1)}`
        return prec >= 2 ? `(${s})` : s
      }
      case LIST: {
        if (p.args.length !== 1) break
        const s = `List ${go(p.args[0], 3)}`
        return prec >= 3 ? `(${s})` : s
      }
      case TUPLE: {
        if (p.args.length === 0) return '()'
        const s = p.args.map((a) => go(a, 2)).join(', ')
        return `(${s})`
      }
      case RECORD: {
        if (p.args.length !== 1) break
        const fields: string[] = []
        let row = prune(p.args[0])
        let tail = ''
        while (row.kind === 'con' && row.name.startsWith('row:')) {
          fields.push(`${row.name.slice(4)}: ${go(row.args[0], 0)}`)
          row = prune(row.args[1])
        }
        if (row.kind === 'var') tail = ` | ${nameOf(row.id)}`
        if (fields.length === 0 && !tail) return '{}'
        return `{ ${fields.join(', ')}${tail} }`
      }
      default:
        break
    }
    // generic application form, also reached by an unsaturated special
    // constructor (bare `List`, a partially-applied `->`, …)
    if (p.args.length === 0) return p.name
    const s = `${p.name} ${p.args.map((a) => go(a, 3)).join(' ')}`
    return prec >= 3 ? `(${s})` : s
  }
  return go(t, 0)
}

function nextName(i: number): string {
  // 0->a, 25->z, 26->a1, …
  const letter = String.fromCharCode(97 + (i % 26))
  const suffix = Math.floor(i / 26)
  return suffix === 0 ? letter : `${letter}${suffix}`
}

/** Pretty-print a single predicate (`Disp a`, `Eq (List b)`). */
export function predToString(p: Pred, names: Map<number, string> = new Map()): string {
  const t = prune(p.type)
  // parenthesise applied constructors so `Disp (List a)` reads right
  const arg = t.kind === 'con' && t.args.length > 0 ? `(${typeToString(t, names)})` : typeToString(t, names)
  return `${p.cls} ${arg}`
}

export function schemeToString(s: Scheme): string {
  const names = new Map<number, string>()
  // pre-seed quantified vars so they print first as a, b, c…
  s.vars.forEach((id) => {
    const i = names.size
    names.set(id, nextName(i))
  })
  const preds = s.preds && s.preds.length > 0 ? s.preds : null
  const ctx = preds
    ? (preds.length === 1
        ? predToString(preds[0], names)
        : `(${preds.map((p) => predToString(p, names)).join(', ')})`) + ' => '
    : ''
  const body = ctx + typeToString(s.type, names)
  if (s.vars.length === 0) return body
  const quant = s.vars.map((id) => names.get(id)).join(' ')
  return `∀ ${quant}. ${body}`
}
