// Linear Temporal Logic (LTL) — the object language of the Temporal Studio.
//
// Formulas are a discriminated union. The *surface* language carries every
// convenient operator (implication, equivalence, the derived temporals F/G and
// the weak-until W); the tableau construction in `buchi.ts` first rewrites a
// formula into **negation normal form** over the reduced core
// {true, false, atom, ¬atom, ∧, ∨, X, U, R} (see `nnf.ts`). Keeping the rich
// surface form around means the *independent* word-level semantics in
// `ltleval.ts` can interpret operators directly, sharing no code with the
// automaton — the whole point of the cross-check.

export type Ltl =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'atom'; name: string }
  | { k: 'not'; a: Ltl }
  | { k: 'and'; a: Ltl; b: Ltl }
  | { k: 'or'; a: Ltl; b: Ltl }
  | { k: 'imp'; a: Ltl; b: Ltl }
  | { k: 'iff'; a: Ltl; b: Ltl }
  | { k: 'X'; a: Ltl } // next
  | { k: 'F'; a: Ltl } // eventually
  | { k: 'G'; a: Ltl } // globally
  | { k: 'U'; a: Ltl; b: Ltl } // (strong) until
  | { k: 'R'; a: Ltl; b: Ltl } // release
  | { k: 'W'; a: Ltl; b: Ltl } // weak until

export const TRUE: Ltl = { k: 'true' }
export const FALSE: Ltl = { k: 'false' }
export const atom = (name: string): Ltl => ({ k: 'atom', name })
export const not = (a: Ltl): Ltl => ({ k: 'not', a })
export const and = (a: Ltl, b: Ltl): Ltl => ({ k: 'and', a, b })
export const or = (a: Ltl, b: Ltl): Ltl => ({ k: 'or', a, b })
export const imp = (a: Ltl, b: Ltl): Ltl => ({ k: 'imp', a, b })
export const iff = (a: Ltl, b: Ltl): Ltl => ({ k: 'iff', a, b })
export const next = (a: Ltl): Ltl => ({ k: 'X', a })
export const eventually = (a: Ltl): Ltl => ({ k: 'F', a })
export const globally = (a: Ltl): Ltl => ({ k: 'G', a })
export const until = (a: Ltl, b: Ltl): Ltl => ({ k: 'U', a, b })
export const release = (a: Ltl, b: Ltl): Ltl => ({ k: 'R', a, b })
export const wuntil = (a: Ltl, b: Ltl): Ltl => ({ k: 'W', a, b })

/** A canonical string that is equal exactly when two formulas are structurally
 * identical — the key used in the tableau's formula sets and the oracle's memo. */
export function key(f: Ltl): string {
  switch (f.k) {
    case 'true':
      return 'T'
    case 'false':
      return 'F'
    case 'atom':
      return 'a:' + f.name
    case 'not':
      return '!(' + key(f.a) + ')'
    case 'X':
      return 'X(' + key(f.a) + ')'
    case 'F':
      return 'F(' + key(f.a) + ')'
    case 'G':
      return 'G(' + key(f.a) + ')'
    case 'and':
      return '&(' + key(f.a) + ',' + key(f.b) + ')'
    case 'or':
      return '|(' + key(f.a) + ',' + key(f.b) + ')'
    case 'imp':
      return '>(' + key(f.a) + ',' + key(f.b) + ')'
    case 'iff':
      return '=(' + key(f.a) + ',' + key(f.b) + ')'
    case 'U':
      return 'U(' + key(f.a) + ',' + key(f.b) + ')'
    case 'R':
      return 'R(' + key(f.a) + ',' + key(f.b) + ')'
    case 'W':
      return 'W(' + key(f.a) + ',' + key(f.b) + ')'
  }
}

/** All atomic-proposition names occurring in `f`, in first-seen order. */
export function atomsOf(f: Ltl): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const walk = (g: Ltl): void => {
    switch (g.k) {
      case 'atom':
        if (!seen.has(g.name)) {
          seen.add(g.name)
          out.push(g.name)
        }
        return
      case 'true':
      case 'false':
        return
      case 'not':
      case 'X':
      case 'F':
      case 'G':
        walk(g.a)
        return
      default:
        walk(g.a)
        walk(g.b)
    }
  }
  walk(f)
  return out
}

/** Node count — a rough size used to bound random generation and the tableau. */
export function size(f: Ltl): number {
  switch (f.k) {
    case 'true':
    case 'false':
    case 'atom':
      return 1
    case 'not':
    case 'X':
    case 'F':
    case 'G':
      return 1 + size(f.a)
    default:
      return 1 + size(f.a) + size(f.b)
  }
}

// Binding power for pretty-printing: higher binds tighter. Atoms/constants are
// atomic (never parenthesised); everything else parenthesises a child whose
// precedence is lower than its own.
const PREC: Record<Ltl['k'], number> = {
  atom: 100,
  true: 100,
  false: 100,
  not: 90,
  X: 90,
  F: 90,
  G: 90,
  U: 70,
  R: 70,
  W: 70,
  and: 60,
  or: 50,
  imp: 40,
  iff: 30,
}

/** Render a formula with minimal parentheses. */
export function printLtl(f: Ltl): string {
  switch (f.k) {
    case 'true':
      return 'true'
    case 'false':
      return 'false'
    case 'atom':
      return f.name
    case 'not':
      return '!' + wrapUnary(f.a)
    case 'X':
      return 'X ' + wrapUnary(f.a)
    case 'F':
      return 'F ' + wrapUnary(f.a)
    case 'G':
      return 'G ' + wrapUnary(f.a)
    case 'and':
      return bin(f.a, '&', f.b, PREC.and)
    case 'or':
      return bin(f.a, '|', f.b, PREC.or)
    case 'imp':
      return binR(f.a, '->', f.b, PREC.imp)
    case 'iff':
      return bin(f.a, '<->', f.b, PREC.iff)
    case 'U':
      return binR(f.a, 'U', f.b, PREC.U)
    case 'R':
      return binR(f.a, 'R', f.b, PREC.R)
    case 'W':
      return binR(f.a, 'W', f.b, PREC.W)
  }
}

function wrapUnary(child: Ltl): string {
  const s = printLtl(child)
  return PREC[child.k] >= 90 ? s : '(' + s + ')'
}

function bin(a: Ltl, op: string, b: Ltl, prec: number): string {
  const ls = PREC[a.k] < prec ? '(' + printLtl(a) + ')' : printLtl(a)
  const rs = PREC[b.k] <= prec ? '(' + printLtl(b) + ')' : printLtl(b)
  return `${ls} ${op} ${rs}`
}

function binR(a: Ltl, op: string, b: Ltl, prec: number): string {
  // right-associative: left child strictly greater, right child >= keeps flat
  const ls = PREC[a.k] <= prec ? '(' + printLtl(a) + ')' : printLtl(a)
  const rs = PREC[b.k] < prec ? '(' + printLtl(b) + ')' : printLtl(b)
  return `${ls} ${op} ${rs}`
}
