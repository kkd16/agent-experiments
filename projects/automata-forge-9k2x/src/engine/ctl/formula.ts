// Computation Tree Logic (CTL) — the formula model that drives the Branching mode.
//
// This is the *branching-time* sibling of the LTL in the Logic mode. Where an LTL formula constrains
// a single infinite path (and `M ⊨ φ` quantifies "for all paths"), a CTL formula reasons about the
// *tree* of futures rooted at a state: every temporal operator is paired with a path quantifier —
// `E` ("for some path …") or `A` ("for every path …"). So the ten temporal modalities are
//
//     EX AX   — some / every successor
//     EF AF   — some / every path eventually
//     EG AG   — some / every path always
//     E[·U·] A[·U·]   — some / every path: until
//     E[·R·] A[·R·]   — some / every path: release
//
// (with `W` weak-until as sugar over release). The headline payoff is that CTL can say things LTL
// cannot — `AG EF restart` ("from every reachable state the system can be reset") has no LTL
// equivalent — and it is checked by a completely different algorithm: iterated fixpoints over the set
// of states (`modelcheck.ts`), not the automata-theoretic product of the Logic mode.

// ---------------------------------------------------------------------------
// Surface AST
// ---------------------------------------------------------------------------

/** The CTL syntax tree. `atom` names are propositional variables (lower-case by convention). */
export type Ctl =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'atom'; name: string }
  | { k: 'not'; a: Ctl }
  | { k: 'and'; a: Ctl; b: Ctl }
  | { k: 'or'; a: Ctl; b: Ctl }
  | { k: 'imp'; a: Ctl; b: Ctl } // a → b
  | { k: 'iff'; a: Ctl; b: Ctl } // a ↔ b
  | { k: 'EX'; a: Ctl } // ∃ a successor where a
  | { k: 'AX'; a: Ctl } // ∀ successors a
  | { k: 'EF'; a: Ctl } // ∃ path eventually a
  | { k: 'AF'; a: Ctl } // ∀ paths eventually a
  | { k: 'EG'; a: Ctl } // ∃ path always a
  | { k: 'AG'; a: Ctl } // ∀ paths always a
  | { k: 'EU'; a: Ctl; b: Ctl } // ∃ path: a U b
  | { k: 'AU'; a: Ctl; b: Ctl } // ∀ paths: a U b
  | { k: 'ER'; a: Ctl; b: Ctl } // ∃ path: a R b
  | { k: 'AR'; a: Ctl; b: Ctl } // ∀ paths: a R b

/** Operator glyphs used throughout the UI (and accepted, alongside ASCII, by the parser). */
export const GLYPH = {
  not: '¬',
  and: '∧',
  or: '∨',
  imp: '→',
  iff: '↔',
  E: 'E',
  A: 'A',
  X: 'X',
  F: 'F',
  G: 'G',
  U: 'U',
  R: 'R',
  W: 'W',
  top: '⊤',
  bot: '⊥',
} as const

/** The temporal/quantified node kinds, for quick classification. */
export const TEMPORAL = new Set<Ctl['k']>(['EX', 'AX', 'EF', 'AF', 'EG', 'AG', 'EU', 'AU', 'ER', 'AR'])
const BINARY_TEMPORAL = new Set<Ctl['k']>(['EU', 'AU', 'ER', 'AR'])

// ---------------------------------------------------------------------------
// Canonical keys, subformulas, atoms
// ---------------------------------------------------------------------------

/** A canonical string for a CTL formula — structural equality is key equality. */
export function ctlKey(c: Ctl): string {
  switch (c.k) {
    case 'true':
      return 'T'
    case 'false':
      return 'F'
    case 'atom':
      return 'p:' + c.name
    case 'not':
      return '!(' + ctlKey(c.a) + ')'
    case 'and':
      return '&(' + ctlKey(c.a) + ',' + ctlKey(c.b) + ')'
    case 'or':
      return '|(' + ctlKey(c.a) + ',' + ctlKey(c.b) + ')'
    case 'imp':
      return '>(' + ctlKey(c.a) + ',' + ctlKey(c.b) + ')'
    case 'iff':
      return '=(' + ctlKey(c.a) + ',' + ctlKey(c.b) + ')'
    case 'EX':
    case 'AX':
    case 'EF':
    case 'AF':
    case 'EG':
    case 'AG':
      return c.k + '(' + ctlKey(c.a) + ')'
    case 'EU':
    case 'AU':
    case 'ER':
    case 'AR':
      return c.k + '(' + ctlKey(c.a) + ',' + ctlKey(c.b) + ')'
  }
}

/** Immediate children of a node (0, 1 or 2 of them). */
export function childrenOf(c: Ctl): Ctl[] {
  switch (c.k) {
    case 'true':
    case 'false':
    case 'atom':
      return []
    case 'not':
    case 'EX':
    case 'AX':
    case 'EF':
    case 'AF':
    case 'EG':
    case 'AG':
      return [c.a]
    default:
      return [c.a, c.b]
  }
}

/**
 * Every distinct subformula of `c`, in **post-order** (children before parents) and deduped by
 * canonical key. This is exactly the order the labelling algorithm computes `Sat` in, and the order
 * the Labelling tab lists rows.
 */
export function subformulas(c: Ctl): Ctl[] {
  const out: Ctl[] = []
  const seen = new Set<string>()
  const walk = (x: Ctl) => {
    for (const ch of childrenOf(x)) walk(ch)
    const k = ctlKey(x)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(x)
    }
  }
  walk(c)
  return out
}

/** All atomic-proposition names mentioned in a formula (sorted, deduped). */
export function atomsOf(c: Ctl): string[] {
  const set = new Set<string>()
  const walk = (x: Ctl) => {
    if (x.k === 'atom') set.add(x.name)
    for (const ch of childrenOf(x)) walk(ch)
  }
  walk(c)
  return [...set].sort()
}

// ---------------------------------------------------------------------------
// Negation normal form & negation (the CTL dualities)
// ---------------------------------------------------------------------------

/** The negation of `c`, pushed inward to the atoms using the CTL dualities (returns a fresh tree). */
export function negate(c: Ctl): Ctl {
  return nnf({ k: 'not', a: c })
}

/**
 * Negation-normal form: `¬` survives only directly in front of an atom. The propositional De Morgan
 * laws and the temporal dualities
 *
 *     ¬EX a = AX ¬a      ¬AX a = EX ¬a
 *     ¬EF a = AG ¬a      ¬AF a = EG ¬a
 *     ¬EG a = AF ¬a      ¬AG a = EF ¬a
 *     ¬E[a U b] = A[¬a R ¬b]    ¬A[a U b] = E[¬a R ¬b]
 *     ¬E[a R b] = A[¬a U ¬b]    ¬A[a R b] = E[¬a U ¬b]
 *
 * are folded in so the recursion never leaves a `¬` over a compound. →, ↔ desugar on the way.
 */
export function nnf(c: Ctl): Ctl {
  const push = (x: Ctl, neg: boolean): Ctl => {
    switch (x.k) {
      case 'true':
        return neg ? { k: 'false' } : { k: 'true' }
      case 'false':
        return neg ? { k: 'true' } : { k: 'false' }
      case 'atom':
        return neg ? { k: 'not', a: x } : x
      case 'not':
        return push(x.a, !neg)
      case 'and':
        return neg
          ? { k: 'or', a: push(x.a, true), b: push(x.b, true) }
          : { k: 'and', a: push(x.a, false), b: push(x.b, false) }
      case 'or':
        return neg
          ? { k: 'and', a: push(x.a, true), b: push(x.b, true) }
          : { k: 'or', a: push(x.a, false), b: push(x.b, false) }
      case 'imp':
        // a → b ≡ ¬a ∨ b
        return push({ k: 'or', a: { k: 'not', a: x.a }, b: x.b }, neg)
      case 'iff':
        return push({ k: 'and', a: { k: 'imp', a: x.a, b: x.b }, b: { k: 'imp', a: x.b, b: x.a } }, neg)
      case 'EX':
        return neg ? { k: 'AX', a: push(x.a, true) } : { k: 'EX', a: push(x.a, false) }
      case 'AX':
        return neg ? { k: 'EX', a: push(x.a, true) } : { k: 'AX', a: push(x.a, false) }
      case 'EF':
        return neg ? { k: 'AG', a: push(x.a, true) } : { k: 'EF', a: push(x.a, false) }
      case 'AF':
        return neg ? { k: 'EG', a: push(x.a, true) } : { k: 'AF', a: push(x.a, false) }
      case 'EG':
        return neg ? { k: 'AF', a: push(x.a, true) } : { k: 'EG', a: push(x.a, false) }
      case 'AG':
        return neg ? { k: 'EF', a: push(x.a, true) } : { k: 'AG', a: push(x.a, false) }
      case 'EU':
        return neg
          ? { k: 'AR', a: push(x.a, true), b: push(x.b, true) }
          : { k: 'EU', a: push(x.a, false), b: push(x.b, false) }
      case 'AU':
        return neg
          ? { k: 'ER', a: push(x.a, true), b: push(x.b, true) }
          : { k: 'AU', a: push(x.a, false), b: push(x.b, false) }
      case 'ER':
        return neg
          ? { k: 'AU', a: push(x.a, true), b: push(x.b, true) }
          : { k: 'ER', a: push(x.a, false), b: push(x.b, false) }
      case 'AR':
        return neg
          ? { k: 'EU', a: push(x.a, true), b: push(x.b, true) }
          : { k: 'AR', a: push(x.a, false), b: push(x.b, false) }
    }
  }
  return push(c, false)
}

// ---------------------------------------------------------------------------
// Reduction to the adequate basis {¬, ∧, EX, EU, EG}
// ---------------------------------------------------------------------------

/**
 * Rewrite a formula using only the minimal adequate set of CTL operators — `¬`, `∧`, `EX`, `E[·U·]`
 * and `EG` — the basis the textbook labelling algorithm is built on. Everything else is derived:
 *
 *     a ∨ b      = ¬(¬a ∧ ¬b)              a → b = ¬a ∨ b        a ↔ b = (a→b) ∧ (b→a)
 *     AX a       = ¬EX ¬a                  EF a  = E[⊤ U a]      AF a  = ¬EG ¬a
 *     AG a       = ¬EF ¬a = ¬E[⊤ U ¬a]
 *     A[a U b]   = ¬( E[¬b U (¬a ∧ ¬b)] ∨ EG ¬b )
 *     E[a R b]   = ¬A[¬a U ¬b]             A[a R b] = ¬E[¬a U ¬b]
 *
 * Used only for the Formula tab's "adequate basis" display — `modelcheck.ts` evaluates every operator
 * directly with its own fixpoint, which is both faster and nicer to visualize.
 */
export function toAdequate(c: Ctl): Ctl {
  const r = toAdequate
  switch (c.k) {
    case 'true':
    case 'false':
    case 'atom':
      return c
    case 'not':
      return { k: 'not', a: r(c.a) }
    case 'and':
      return { k: 'and', a: r(c.a), b: r(c.b) }
    case 'or':
      return { k: 'not', a: { k: 'and', a: { k: 'not', a: r(c.a) }, b: { k: 'not', a: r(c.b) } } }
    case 'imp':
      return r({ k: 'or', a: { k: 'not', a: c.a }, b: c.b })
    case 'iff':
      return r({ k: 'and', a: { k: 'imp', a: c.a, b: c.b }, b: { k: 'imp', a: c.b, b: c.a } })
    case 'EX':
      return { k: 'EX', a: r(c.a) }
    case 'AX':
      return { k: 'not', a: { k: 'EX', a: { k: 'not', a: r(c.a) } } }
    case 'EF':
      return { k: 'EU', a: { k: 'true' }, b: r(c.a) }
    case 'AF':
      return { k: 'not', a: { k: 'EG', a: { k: 'not', a: r(c.a) } } }
    case 'EG':
      return { k: 'EG', a: r(c.a) }
    case 'AG':
      return { k: 'not', a: { k: 'EU', a: { k: 'true' }, b: { k: 'not', a: r(c.a) } } }
    case 'EU':
      return { k: 'EU', a: r(c.a), b: r(c.b) }
    case 'AU': {
      // A[a U b] = ¬( E[¬b U (¬a ∧ ¬b)] ∨ EG ¬b )
      const na = { k: 'not', a: c.a } as Ctl
      const nb = { k: 'not', a: c.b } as Ctl
      return r({
        k: 'not',
        a: {
          k: 'or',
          a: { k: 'EU', a: nb, b: { k: 'and', a: na, b: nb } },
          b: { k: 'EG', a: nb },
        },
      })
    }
    case 'ER':
      // E[a R b] = ¬A[¬a U ¬b]
      return r({ k: 'not', a: { k: 'AU', a: { k: 'not', a: c.a }, b: { k: 'not', a: c.b } } })
    case 'AR':
      // A[a R b] = ¬E[¬a U ¬b]
      return r({ k: 'not', a: { k: 'EU', a: { k: 'not', a: c.a }, b: { k: 'not', a: c.b } } })
  }
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

// Binding power for parenthesisation: higher binds tighter. Matches the parser's precedence. The
// quantified temporal operators bind like unary prefixes (tightest, with the binaries bracketed).
const PREC: Record<Ctl['k'], number> = {
  iff: 1,
  imp: 2,
  or: 3,
  and: 4,
  not: 5,
  EX: 5,
  AX: 5,
  EF: 5,
  AF: 5,
  EG: 5,
  AG: 5,
  EU: 5,
  AU: 5,
  ER: 5,
  AR: 5,
  atom: 6,
  true: 6,
  false: 6,
}

const RIGHT_ASSOC = new Set<Ctl['k']>(['imp', 'iff'])

/** The two-letter operator name for a quantified node, e.g. `EX`, `AF`, or `E[·U·]`. */
function quantPair(k: Ctl['k']): { q: string; t: string } {
  return { q: k[0], t: k[1] }
}

/** Render a CTL formula with the operator glyphs, parenthesising only where precedence requires it. */
export function showCtl(f: Ctl): string {
  const wrap = (child: Ctl, parent: Ctl, side: 'l' | 'r'): string => {
    const cp = PREC[child.k]
    const pp = PREC[parent.k]
    const rightAssoc = RIGHT_ASSOC.has(parent.k)
    const sameSideOk = rightAssoc ? side === 'r' : side === 'l'
    const need = cp < pp || (cp === pp && parent.k !== child.k && !sameSideOk)
    const s = showCtl(child)
    return need ? `(${s})` : s
  }
  const binaryProp = (g: string) =>
    `${wrap((f as { a: Ctl }).a, f, 'l')} ${g} ${wrap((f as { b: Ctl }).b, f, 'r')}`
  switch (f.k) {
    case 'true':
      return GLYPH.top
    case 'false':
      return GLYPH.bot
    case 'atom':
      return f.name
    case 'not':
      return `${GLYPH.not}${wrap(f.a, f, 'r')}`
    case 'and':
      return binaryProp(GLYPH.and)
    case 'or':
      return binaryProp(GLYPH.or)
    case 'imp':
      return binaryProp(GLYPH.imp)
    case 'iff':
      return binaryProp(GLYPH.iff)
    case 'EX':
    case 'AX':
    case 'EF':
    case 'AF':
    case 'EG':
    case 'AG': {
      const { q, t } = quantPair(f.k)
      return `${q}${t} ${wrap(f.a, f, 'r')}`
    }
    case 'EU':
    case 'AU':
    case 'ER':
    case 'AR': {
      const { q, t } = quantPair(f.k)
      return `${q}[${showCtl(f.a)} ${t} ${showCtl(f.b)}]`
    }
  }
}

/** A short human label for a node kind, used in the syntax-tree and labelling views. */
export function opLabel(k: Ctl['k']): string {
  const names: Record<Ctl['k'], string> = {
    true: GLYPH.top,
    false: GLYPH.bot,
    atom: '',
    not: `${GLYPH.not} not`,
    and: `${GLYPH.and} and`,
    or: `${GLYPH.or} or`,
    imp: `${GLYPH.imp} implies`,
    iff: `${GLYPH.iff} iff`,
    EX: 'EX · some-next',
    AX: 'AX · all-next',
    EF: 'EF · some-eventually',
    AF: 'AF · all-eventually',
    EG: 'EG · some-always',
    AG: 'AG · all-always',
    EU: 'E[· U ·] · some-until',
    AU: 'A[· U ·] · all-until',
    ER: 'E[· R ·] · some-release',
    AR: 'A[· R ·] · all-release',
  }
  return names[k]
}

export { BINARY_TEMPORAL }
