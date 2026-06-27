// CTL* — the full branching-time logic that sits *above* both LTL (the Logic mode) and CTL (the
// Branching mode), containing each as a fragment. Where CTL forces every temporal operator to be
// immediately wrapped in a path quantifier (`AG p`, `E[p U q]`), CTL* drops that restriction: a path
// quantifier `E`/`A` may bind an arbitrary *path formula* in which the temporal operators
// (X F G U R W) and the booleans nest freely. That is what lets CTL* express, in one formula,
// properties neither logic can state alone — e.g. `E[G F p]` ("some path visits p infinitely often")
// and `A[(G F req) → (G F ack)]` (strong-fairness response), the linear-time idioms, *and*
// `A G E F restart` (branching recoverability) at once.
//
// The grammar is the classic two-sorted one (Emerson, "Temporal and Modal Logic"):
//
//     Φ (state)  ::= ⊤ | ⊥ | p | ¬Φ | Φ∧Φ | Φ∨Φ | Φ→Φ | Φ↔Φ | E ρ | A ρ
//     ρ (path)   ::= Φ | ¬ρ | ρ∧ρ | ρ∨ρ | ρ→ρ | ρ↔ρ | X ρ | F ρ | G ρ | ρUρ | ρRρ | ρWρ
//
// We keep ONE unified AST (`Star`) — every node kind from the LTL surface syntax, plus `E`/`A` — and
// a `isStateFormula` well-formedness predicate that enforces "the formula is a state formula"
// (temporal operators only ever appear under a quantifier). This mirrors how the LTL and CTL modules
// each keep a single surface AST and is what lets the model checker reuse the GPVW Büchi machinery on
// the path subformulas verbatim.

import type { Ltl } from '../ltl/formula'
import type { Ctl } from '../ctl/formula'

// ---------------------------------------------------------------------------
// Unified CTL* AST
// ---------------------------------------------------------------------------

/** The CTL* syntax tree: the LTL surface operators, plus the two path quantifiers `E` and `A`. */
export type Star =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'atom'; name: string }
  | { k: 'not'; a: Star }
  | { k: 'and'; a: Star; b: Star }
  | { k: 'or'; a: Star; b: Star }
  | { k: 'imp'; a: Star; b: Star } // a → b
  | { k: 'iff'; a: Star; b: Star } // a ↔ b
  | { k: 'next'; a: Star } // X a
  | { k: 'fin'; a: Star } // F a — "eventually"
  | { k: 'glob'; a: Star } // G a — "always"
  | { k: 'until'; a: Star; b: Star } // a U b
  | { k: 'release'; a: Star; b: Star } // a R b
  | { k: 'wuntil'; a: Star; b: Star } // a W b — "weak until"
  | { k: 'E'; a: Star } // E ρ — along SOME path, ρ
  | { k: 'A'; a: Star } // A ρ — along EVERY path, ρ

/** Operator glyphs (and the ASCII the parser also accepts). */
export const GLYPH = {
  not: '¬',
  and: '∧',
  or: '∨',
  imp: '→',
  iff: '↔',
  next: 'X',
  fin: 'F',
  glob: 'G',
  until: 'U',
  release: 'R',
  wuntil: 'W',
  E: 'E',
  A: 'A',
  top: '⊤',
  bot: '⊥',
} as const

const TEMPORAL = new Set<Star['k']>(['next', 'fin', 'glob', 'until', 'release', 'wuntil'])
const BINARY = new Set<Star['k']>(['and', 'or', 'imp', 'iff', 'until', 'release', 'wuntil'])

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

/** Immediate children of a node (0, 1, or 2). */
export function childrenOf(c: Star): Star[] {
  switch (c.k) {
    case 'true':
    case 'false':
    case 'atom':
      return []
    case 'not':
    case 'next':
    case 'fin':
    case 'glob':
    case 'E':
    case 'A':
      return [c.a]
    default:
      return [c.a, c.b]
  }
}

/** A canonical string for a CTL* formula — structural equality is key equality. */
export function starKey(c: Star): string {
  switch (c.k) {
    case 'true':
      return 'T'
    case 'false':
      return 'F'
    case 'atom':
      return 'p:' + c.name
    case 'not':
    case 'next':
    case 'fin':
    case 'glob':
    case 'E':
    case 'A':
      return c.k + '(' + starKey(c.a) + ')'
    default:
      return c.k + '(' + starKey(c.a) + ',' + starKey(c.b) + ')'
  }
}

/** Every distinct subformula in post-order (children before parents), deduped by canonical key. */
export function subformulas(c: Star): Star[] {
  const out: Star[] = []
  const seen = new Set<string>()
  const walk = (x: Star) => {
    for (const ch of childrenOf(x)) walk(ch)
    const k = starKey(x)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(x)
    }
  }
  walk(c)
  return out
}

/** All atomic-proposition names mentioned (sorted, deduped). */
export function atomsOf(c: Star): string[] {
  const set = new Set<string>()
  const walk = (x: Star) => {
    if (x.k === 'atom') set.add(x.name)
    for (const ch of childrenOf(x)) walk(ch)
  }
  walk(c)
  return [...set].sort()
}

/** Does this subtree contain a path quantifier `E`/`A` anywhere? */
export function hasQuant(c: Star): boolean {
  if (c.k === 'E' || c.k === 'A') return true
  return childrenOf(c).some(hasQuant)
}

// ---------------------------------------------------------------------------
// Well-formedness — "this is a STATE formula"
// ---------------------------------------------------------------------------

/**
 * Is `c` a *state* formula? — the only thing CTL* semantics is defined for at the top level. A state
 * formula's temporal operators must all sit under a path quantifier; a bare `F p` or `p ∧ F q` is a
 * *path* formula and is rejected here with a pointer to wrap it (`A F p`, `p ∧ A F q`). Booleans
 * recurse; `E ρ`/`A ρ` are always state formulas (the body ρ may be any path formula); the temporal
 * operators are never state formulas on their own.
 */
export function isStateFormula(c: Star): boolean {
  switch (c.k) {
    case 'true':
    case 'false':
    case 'atom':
    case 'E':
    case 'A':
      return true
    case 'not':
      return isStateFormula(c.a)
    case 'and':
    case 'or':
    case 'imp':
    case 'iff':
      return isStateFormula(c.a) && isStateFormula(c.b)
    default:
      return false // a bare temporal operator is a path formula, not a state formula
  }
}

/** The outermost temporal operator that breaks state-formula-hood, for a friendly error message. */
export function offendingTemporal(c: Star): string | null {
  if (TEMPORAL.has(c.k)) return GLYPH[c.k as keyof typeof GLYPH] ?? c.k
  switch (c.k) {
    case 'not':
      return offendingTemporal(c.a)
    case 'and':
    case 'or':
    case 'imp':
    case 'iff':
      return offendingTemporal(c.a) ?? offendingTemporal(c.b)
    default:
      return null // E / A / atom / const — fine
  }
}

// ---------------------------------------------------------------------------
// Conversions to/from the LTL and CTL ASTs
// ---------------------------------------------------------------------------

/**
 * Lower a *quantifier-free* CTL* path formula to the LTL surface AST so the GPVW translation can
 * consume it. The model checker calls this only after every nested `E`/`A` has been replaced by a
 * fresh propositional label, so the input is guaranteed to be a pure path formula over atoms.
 */
export function starToLtl(c: Star): Ltl {
  switch (c.k) {
    case 'true':
      return { k: 'true' }
    case 'false':
      return { k: 'false' }
    case 'atom':
      return { k: 'atom', name: c.name }
    case 'not':
      return { k: 'not', a: starToLtl(c.a) }
    case 'and':
      return { k: 'and', a: starToLtl(c.a), b: starToLtl(c.b) }
    case 'or':
      return { k: 'or', a: starToLtl(c.a), b: starToLtl(c.b) }
    case 'imp':
      return { k: 'imp', a: starToLtl(c.a), b: starToLtl(c.b) }
    case 'iff':
      return { k: 'iff', a: starToLtl(c.a), b: starToLtl(c.b) }
    case 'next':
      return { k: 'next', a: starToLtl(c.a) }
    case 'fin':
      return { k: 'fin', a: starToLtl(c.a) }
    case 'glob':
      return { k: 'glob', a: starToLtl(c.a) }
    case 'until':
      return { k: 'until', a: starToLtl(c.a), b: starToLtl(c.b) }
    case 'release':
      return { k: 'release', a: starToLtl(c.a), b: starToLtl(c.b) }
    case 'wuntil':
      return { k: 'wuntil', a: starToLtl(c.a), b: starToLtl(c.b) }
    case 'E':
    case 'A':
      throw new Error('starToLtl: a path quantifier survived into a path formula (internal error)')
  }
}

/** Embed a CTL formula into CTL* (always possible — CTL is a syntactic fragment). */
export function ctlToStar(c: Ctl): Star {
  const s = ctlToStar
  switch (c.k) {
    case 'true':
      return { k: 'true' }
    case 'false':
      return { k: 'false' }
    case 'atom':
      return { k: 'atom', name: c.name }
    case 'not':
      return { k: 'not', a: s(c.a) }
    case 'and':
      return { k: 'and', a: s(c.a), b: s(c.b) }
    case 'or':
      return { k: 'or', a: s(c.a), b: s(c.b) }
    case 'imp':
      return { k: 'imp', a: s(c.a), b: s(c.b) }
    case 'iff':
      return { k: 'iff', a: s(c.a), b: s(c.b) }
    case 'EX':
      return { k: 'E', a: { k: 'next', a: s(c.a) } }
    case 'AX':
      return { k: 'A', a: { k: 'next', a: s(c.a) } }
    case 'EF':
      return { k: 'E', a: { k: 'fin', a: s(c.a) } }
    case 'AF':
      return { k: 'A', a: { k: 'fin', a: s(c.a) } }
    case 'EG':
      return { k: 'E', a: { k: 'glob', a: s(c.a) } }
    case 'AG':
      return { k: 'A', a: { k: 'glob', a: s(c.a) } }
    case 'EU':
      return { k: 'E', a: { k: 'until', a: s(c.a), b: s(c.b) } }
    case 'AU':
      return { k: 'A', a: { k: 'until', a: s(c.a), b: s(c.b) } }
    case 'ER':
      return { k: 'E', a: { k: 'release', a: s(c.a), b: s(c.b) } }
    case 'AR':
      return { k: 'A', a: { k: 'release', a: s(c.a), b: s(c.b) } }
  }
}

/**
 * If `c` lies in the *CTL fragment* — every quantifier `E`/`A` immediately wraps a single temporal
 * operator (`X`/`F`/`G`/`U`/`R`/`W`) whose operands are themselves CTL state formulas — return the
 * equivalent CTL AST, else `null`. Used to route CTL-shaped CTL* formulas to the (independent,
 * already-verified) CTL labelling engine.
 */
export function starToCtl(c: Star): Ctl | null {
  switch (c.k) {
    case 'true':
    case 'false':
      return { k: c.k }
    case 'atom':
      return { k: 'atom', name: c.name }
    case 'not': {
      const a = starToCtl(c.a)
      return a && { k: 'not', a }
    }
    case 'and':
    case 'or':
    case 'imp':
    case 'iff': {
      const a = starToCtl(c.a)
      const b = starToCtl(c.b)
      return a && b ? { k: c.k, a, b } : null
    }
    case 'E':
    case 'A':
      return quantToCtl(c.k, c.a)
    default:
      return null // a bare temporal operator outside a quantifier — not CTL
  }
}

function quantToCtl(q: 'E' | 'A', body: Star): Ctl | null {
  switch (body.k) {
    case 'next': {
      const a = starToCtl(body.a)
      return a && { k: q === 'E' ? 'EX' : 'AX', a }
    }
    case 'fin': {
      const a = starToCtl(body.a)
      return a && { k: q === 'E' ? 'EF' : 'AF', a }
    }
    case 'glob': {
      const a = starToCtl(body.a)
      return a && { k: q === 'E' ? 'EG' : 'AG', a }
    }
    case 'until': {
      const a = starToCtl(body.a)
      const b = starToCtl(body.b)
      return a && b ? { k: q === 'E' ? 'EU' : 'AU', a, b } : null
    }
    case 'release': {
      const a = starToCtl(body.a)
      const b = starToCtl(body.b)
      return a && b ? { k: q === 'E' ? 'ER' : 'AR', a, b } : null
    }
    case 'wuntil': {
      // a W b ≡ a R (a... ) — reuse CTL's release encoding: q[a W b] = q[b R (a ∨ b)].
      const a = starToCtl(body.a)
      const b = starToCtl(body.b)
      if (!a || !b) return null
      const rb: Ctl = { k: 'or', a, b }
      return { k: q === 'E' ? 'ER' : 'AR', a: b, b: rb }
    }
    default:
      return null // E/A wrapping a boolean, atom or another quantifier — proper CTL*, not CTL
  }
}

// ---------------------------------------------------------------------------
// Classification — which logic does this formula live in?
// ---------------------------------------------------------------------------

export type Fragment = 'ltl' | 'ctl' | 'star'

/**
 * Classify a (well-formed) CTL* formula:
 *   • `ltl`  — a single top-level `A ρ` (or `E ρ`) whose body has no nested quantifier: pure linear
 *              time wearing one outer quantifier.
 *   • `ctl`  — every quantifier hugs one temporal operator (the CTL fragment).
 *   • `star` — uses genuine CTL* nesting expressible in neither.
 */
export function classify(c: Star): Fragment {
  if (starToCtl(c) !== null) return 'ctl'
  if ((c.k === 'A' || c.k === 'E') && !hasQuant(c.a)) return 'ltl'
  return 'star'
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

// Binding power (higher binds tighter); mirrors the parser. Quantifiers and unary temporals bind like
// prefix operators (tightest); the binary temporals U/R/W bind tighter than ∧.
const PREC: Record<Star['k'], number> = {
  iff: 1,
  imp: 2,
  or: 3,
  and: 4,
  until: 5,
  release: 5,
  wuntil: 5,
  not: 6,
  next: 6,
  fin: 6,
  glob: 6,
  E: 6,
  A: 6,
  atom: 7,
  true: 7,
  false: 7,
}

const RIGHT_ASSOC = new Set<Star['k']>(['imp', 'iff', 'until', 'release', 'wuntil'])

/** Render a CTL* formula with operator glyphs, parenthesising only where precedence requires. */
export function showStar(f: Star): string {
  const wrap = (child: Star, parent: Star, side: 'l' | 'r'): string => {
    const cp = PREC[child.k]
    const pp = PREC[parent.k]
    const rightAssoc = RIGHT_ASSOC.has(parent.k)
    const sameSideOk = rightAssoc ? side === 'r' : side === 'l'
    const need = cp < pp || (cp === pp && BINARY.has(parent.k) && !sameSideOk)
    const s = showStar(child)
    return need ? `(${s})` : s
  }
  const unary = (g: string, sp: boolean) =>
    `${g}${sp ? ' ' : ''}${wrap((f as { a: Star }).a, f, 'r')}`
  const binary = (g: string) =>
    `${wrap((f as { a: Star }).a, f, 'l')} ${g} ${wrap((f as { b: Star }).b, f, 'r')}`
  switch (f.k) {
    case 'true':
      return GLYPH.top
    case 'false':
      return GLYPH.bot
    case 'atom':
      return f.name
    case 'not':
      return unary(GLYPH.not, false)
    case 'next':
      return unary(GLYPH.next, true)
    case 'fin':
      return unary(GLYPH.fin, true)
    case 'glob':
      return unary(GLYPH.glob, true)
    case 'E':
      return unary(GLYPH.E, true)
    case 'A':
      return unary(GLYPH.A, true)
    case 'and':
      return binary(GLYPH.and)
    case 'or':
      return binary(GLYPH.or)
    case 'imp':
      return binary(GLYPH.imp)
    case 'iff':
      return binary(GLYPH.iff)
    case 'until':
      return binary(GLYPH.until)
    case 'release':
      return binary(GLYPH.release)
    case 'wuntil':
      return binary(GLYPH.wuntil)
  }
}

/** A short human label for a node kind, used in the syntax-tree view. */
export function opLabel(k: Star['k']): string {
  const names: Record<Star['k'], string> = {
    true: GLYPH.top,
    false: GLYPH.bot,
    atom: '',
    not: '¬ not',
    and: '∧ and',
    or: '∨ or',
    imp: '→ implies',
    iff: '↔ iff',
    next: 'X · next',
    fin: 'F · eventually',
    glob: 'G · always',
    until: '· U · until',
    release: '· R · release',
    wuntil: '· W · weak-until',
    E: 'E · some path',
    A: 'A · all paths',
  }
  return names[k]
}

export { TEMPORAL, BINARY }
