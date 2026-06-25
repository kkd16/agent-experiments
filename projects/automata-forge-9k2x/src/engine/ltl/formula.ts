// Linear Temporal Logic (LTL) — the formula model that drives the Logic mode.
//
// This is the rung *above* the Chomsky tower: the finite-word machines elsewhere in the app accept
// or reject a single string; an LTL formula instead constrains an *infinite* word (an ω-word) — the
// trace of a non-terminating reactive system. "the request is eventually granted", "two processes
// are never in their critical section together", "every press is followed by a release" are LTL
// properties, and a Büchi automaton (built in `translate.ts`) is the ω-word analogue of an NFA.
//
// We keep TWO representations:
//   * `Ltl`  — the rich surface AST, with F/G/W/→/↔ kept intact, used for display and the parse tree.
//   * `Core` — the desugared *negation-normal-form* (NNF) used by the GPVW translation: negation is
//              pushed to the atoms (so it survives only inside a literal) and every operator is one of
//              true / false / literal / ∧ / ∨ / X / U / R. Every other connective rewrites into these.
//
// Putting a formula in NNF is what lets the tableau construction stay finite and tidy: ¬ never sits
// in front of a temporal operator, so the expansion rules only ever look at a fixed handful of cases.

// ---------------------------------------------------------------------------
// Surface AST
// ---------------------------------------------------------------------------

/** The rich LTL syntax tree, before desugaring. `atom` names are propositional variables. */
export type Ltl =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'atom'; name: string }
  | { k: 'not'; a: Ltl }
  | { k: 'and'; a: Ltl; b: Ltl }
  | { k: 'or'; a: Ltl; b: Ltl }
  | { k: 'imp'; a: Ltl; b: Ltl } // a → b
  | { k: 'iff'; a: Ltl; b: Ltl } // a ↔ b
  | { k: 'next'; a: Ltl } // X a
  | { k: 'fin'; a: Ltl } // F a — "eventually"
  | { k: 'glob'; a: Ltl } // G a — "always"
  | { k: 'until'; a: Ltl; b: Ltl } // a U b
  | { k: 'release'; a: Ltl; b: Ltl } // a R b
  | { k: 'wuntil'; a: Ltl; b: Ltl } // a W b — "weak until"

/** Operator glyphs used throughout the UI (and accepted, alongside ASCII, by the parser). */
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
  top: '⊤',
  bot: '⊥',
} as const

// ---------------------------------------------------------------------------
// Core NNF formula (the translation target)
// ---------------------------------------------------------------------------

/** Negation-normal-form formula: ¬ survives only inside a `lit`. */
export type Core =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'lit'; atom: string; neg: boolean } // a literal: p (neg=false) or ¬p (neg=true)
  | { k: 'and'; a: Core; b: Core }
  | { k: 'or'; a: Core; b: Core }
  | { k: 'next'; a: Core }
  | { k: 'until'; a: Core; b: Core }
  | { k: 'release'; a: Core; b: Core }

/**
 * Convert a surface formula to Core NNF. `neg` requests the NNF of the *negation* of `f` — the dual
 * rules (De Morgan + the temporal dualities ¬X=X¬, ¬(aUb)=¬a R ¬b, ¬(aRb)=¬a U ¬b) are folded in, so
 * the recursion never has to build an explicit `not` over a compound. F/G/→/↔/W desugar on the way.
 */
export function toCore(f: Ltl, neg = false): Core {
  switch (f.k) {
    case 'true':
      return neg ? { k: 'false' } : { k: 'true' }
    case 'false':
      return neg ? { k: 'true' } : { k: 'false' }
    case 'atom':
      return { k: 'lit', atom: f.name, neg }
    case 'not':
      return toCore(f.a, !neg)
    case 'and':
      return neg
        ? { k: 'or', a: toCore(f.a, true), b: toCore(f.b, true) }
        : { k: 'and', a: toCore(f.a, false), b: toCore(f.b, false) }
    case 'or':
      return neg
        ? { k: 'and', a: toCore(f.a, true), b: toCore(f.b, true) }
        : { k: 'or', a: toCore(f.a, false), b: toCore(f.b, false) }
    case 'imp':
      // a → b  ≡  ¬a ∨ b
      return toCore({ k: 'or', a: { k: 'not', a: f.a }, b: f.b }, neg)
    case 'iff':
      // a ↔ b  ≡  (a → b) ∧ (b → a)
      return toCore(
        {
          k: 'and',
          a: { k: 'imp', a: f.a, b: f.b },
          b: { k: 'imp', a: f.b, b: f.a },
        },
        neg,
      )
    case 'next':
      // ¬X a ≡ X ¬a  (X is self-dual)
      return { k: 'next', a: toCore(f.a, neg) }
    case 'fin':
      // F a ≡ true U a
      return toCore({ k: 'until', a: { k: 'true' }, b: f.a }, neg)
    case 'glob':
      // G a ≡ false R a
      return toCore({ k: 'release', a: { k: 'false' }, b: f.a }, neg)
    case 'wuntil':
      // a W b ≡ (a U b) ∨ G a ≡ b R (a ∨ b)
      return toCore({ k: 'release', a: f.b, b: { k: 'or', a: f.a, b: f.b } }, neg)
    case 'until':
      return neg
        ? { k: 'release', a: toCore(f.a, true), b: toCore(f.b, true) }
        : { k: 'until', a: toCore(f.a, false), b: toCore(f.b, false) }
    case 'release':
      return neg
        ? { k: 'until', a: toCore(f.a, true), b: toCore(f.b, true) }
        : { k: 'release', a: toCore(f.a, false), b: toCore(f.b, false) }
  }
}

// ---------------------------------------------------------------------------
// Core utilities: canonical keys, sets, subformulas, atoms
// ---------------------------------------------------------------------------

/** A canonical string for a Core formula — structural equality is key equality. */
export function coreKey(c: Core): string {
  switch (c.k) {
    case 'true':
      return 'T'
    case 'false':
      return 'F'
    case 'lit':
      return (c.neg ? '!' : '') + 'p:' + c.atom
    case 'and':
      return '&(' + coreKey(c.a) + ',' + coreKey(c.b) + ')'
    case 'or':
      return '|(' + coreKey(c.a) + ',' + coreKey(c.b) + ')'
    case 'next':
      return 'X(' + coreKey(c.a) + ')'
    case 'until':
      return 'U(' + coreKey(c.a) + ',' + coreKey(c.b) + ')'
    case 'release':
      return 'R(' + coreKey(c.a) + ',' + coreKey(c.b) + ')'
  }
}

/** The literal that contradicts `lit`: p ↔ ¬p. */
export function negLitKey(c: Extract<Core, { k: 'lit' }>): string {
  return (c.neg ? '' : '!') + 'p:' + c.atom
}

/** Membership in a Core list, by canonical key. */
export function hasCore(list: Core[], c: Core): boolean {
  const k = coreKey(c)
  return list.some((x) => coreKey(x) === k)
}

/** Append `c` to `list` only if structurally absent; returns a new array. */
export function addCore(list: Core[], c: Core): Core[] {
  return hasCore(list, c) ? list : [...list, c]
}

/** Set-equality on two Core lists (order-independent). */
export function sameCoreSet(a: Core[], b: Core[]): boolean {
  if (a.length !== b.length) return false
  const ka = new Set(a.map(coreKey))
  return b.every((x) => ka.has(coreKey(x)))
}

/** A stable key for a *set* of Core formulas (used to memoise tableau nodes). */
export function coreSetKey(list: Core[]): string {
  return list
    .map(coreKey)
    .sort()
    .join('|')
}

/** Every `until` subformula appearing in `c` (deduped) — one acceptance set per eventuality. */
export function untilSubformulas(c: Core): Extract<Core, { k: 'until' }>[] {
  const out: Extract<Core, { k: 'until' }>[] = []
  const seen = new Set<string>()
  const walk = (x: Core) => {
    switch (x.k) {
      case 'until':
        if (!seen.has(coreKey(x))) {
          seen.add(coreKey(x))
          out.push(x)
        }
        walk(x.a)
        walk(x.b)
        break
      case 'release':
      case 'and':
      case 'or':
        walk(x.a)
        walk(x.b)
        break
      case 'next':
        walk(x.a)
        break
      case 'true':
      case 'false':
      case 'lit':
        break
    }
  }
  walk(c)
  return out
}

/** All atomic-proposition names mentioned in a surface formula (sorted, deduped). */
export function atomsOf(f: Ltl): string[] {
  const set = new Set<string>()
  const walk = (x: Ltl) => {
    switch (x.k) {
      case 'atom':
        set.add(x.name)
        break
      case 'true':
      case 'false':
        break
      case 'not':
      case 'next':
      case 'fin':
      case 'glob':
        walk(x.a)
        break
      default:
        walk(x.a)
        walk(x.b)
    }
  }
  walk(f)
  return [...set].sort()
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

// Binding power for parenthesisation: higher binds tighter. Matches the parser's precedence.
const PREC: Record<Ltl['k'], number> = {
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
  atom: 7,
  true: 7,
  false: 7,
}

// Binary operators are written `a OP b`; these are the ones that re-associate to the right.
const RIGHT_ASSOC = new Set<Ltl['k']>(['imp', 'iff', 'until', 'release', 'wuntil'])

/** Render a surface formula with the operator glyphs, parenthesising only where precedence needs it. */
export function showLtl(f: Ltl): string {
  // Parenthesise `child` when it binds looser than its parent, or equally but on the side that the
  // parent's associativity would otherwise re-bracket.
  const wrap = (child: Ltl, parent: Ltl, side: 'l' | 'r'): string => {
    const cp = PREC[child.k]
    const pp = PREC[parent.k]
    const rightAssoc = RIGHT_ASSOC.has(parent.k)
    const sameSideOk = rightAssoc ? side === 'r' : side === 'l'
    const need = cp < pp || (cp === pp && !sameSideOk)
    const s = showLtl(child)
    return need ? `(${s})` : s
  }
  const unary = (g: string, sp: boolean) => `${g}${sp ? ' ' : ''}${wrap((f as { a: Ltl }).a, f, 'r')}`
  const binary = (g: string) =>
    `${wrap((f as { a: Ltl }).a, f, 'l')} ${g} ${wrap((f as { b: Ltl }).b, f, 'r')}`
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

/** Render a Core (NNF) formula — literals show their negation, constants as ⊤/⊥. */
export function showCore(c: Core): string {
  const atomic = (x: Core) =>
    x.k === 'lit' || x.k === 'true' || x.k === 'false' || x.k === 'next'
  const wrap = (x: Core) => (atomic(x) ? showCore(x) : `(${showCore(x)})`)
  switch (c.k) {
    case 'true':
      return GLYPH.top
    case 'false':
      return GLYPH.bot
    case 'lit':
      return (c.neg ? GLYPH.not : '') + c.atom
    case 'and':
      return `${wrap(c.a)} ${GLYPH.and} ${wrap(c.b)}`
    case 'or':
      return `${wrap(c.a)} ${GLYPH.or} ${wrap(c.b)}`
    case 'next':
      return `${GLYPH.next} ${wrap(c.a)}`
    case 'until':
      return `${wrap(c.a)} ${GLYPH.until} ${wrap(c.b)}`
    case 'release':
      return `${wrap(c.a)} ${GLYPH.release} ${wrap(c.b)}`
  }
}
