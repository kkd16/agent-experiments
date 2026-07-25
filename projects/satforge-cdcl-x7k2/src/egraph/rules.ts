// The rewrite rules the studio saturates with, grouped so you can toggle each
// family on and off and watch what it unlocks. **Every rule is an identity over
// the integers** — that is what lets the differential oracle re-evaluate the
// optimized term and demand it agree with the original on every assignment. The
// e-graph never has to trust the rules; the oracle re-derives the answer.

import type { Term } from './term'
import type { Rewrite } from './rewrite'

// --- tiny pattern constructors -------------------------------------------------
const pv = (n: string): Term => ({ op: `?${n}`, args: [] })
const lit = (n: number): Term => ({ op: String(n), args: [] })
const add = (a: Term, b: Term): Term => ({ op: '+', args: [a, b] })
const mul = (a: Term, b: Term): Term => ({ op: '*', args: [a, b] })
const neg = (a: Term): Term => ({ op: 'neg', args: [a] })
const shl = (a: Term, b: Term): Term => ({ op: 'shl', args: [a, b] })

const a = pv('a')
const b = pv('b')
const c = pv('c')

export interface RuleGroup {
  name: string
  blurb: string
  rules: Rewrite[]
}

export const RULE_GROUPS: RuleGroup[] = [
  {
    name: 'Commutativity & associativity',
    blurb:
      'The shape-shifting rules — they reassociate and reorder sums and products so the other families find their patterns. Powerful, but the usual source of e-graph blow-up.',
    rules: [
      { name: 'comm-+', lhs: add(a, b), rhs: add(b, a) },
      { name: 'comm-*', lhs: mul(a, b), rhs: mul(b, a) },
      { name: 'assoc-+', lhs: add(add(a, b), c), rhs: add(a, add(b, c)) },
      { name: 'assoc-*', lhs: mul(mul(a, b), c), rhs: mul(a, mul(b, c)) },
    ],
  },
  {
    name: 'Identities & annihilation',
    blurb: 'The unit and zero laws: +0 and ×1 vanish, ×0 collapses the whole product to zero.',
    rules: [
      { name: 'add-0', lhs: add(a, lit(0)), rhs: a },
      { name: 'mul-1', lhs: mul(a, lit(1)), rhs: a },
      { name: 'mul-0', lhs: mul(a, lit(0)), rhs: lit(0) },
    ],
  },
  {
    name: 'Distributivity & factoring',
    blurb:
      'The ring law both ways: expand a product over a sum, or factor a shared term back out. Factoring removes multiplications, which the cost model rewards.',
    rules: [
      { name: 'distribute', lhs: mul(a, add(b, c)), rhs: add(mul(a, b), mul(a, c)) },
      { name: 'factor', lhs: add(mul(a, b), mul(a, c)), rhs: mul(a, add(b, c)) },
    ],
  },
  {
    name: 'Negation',
    blurb: 'How unary minus moves through the ring: double negation, sum with its own negation, and pushing a negation inward.',
    rules: [
      { name: 'neg-neg', lhs: neg(neg(a)), rhs: a },
      { name: 'add-neg', lhs: add(a, neg(a)), rhs: lit(0) },
      { name: 'neg-of-add', lhs: neg(add(a, b)), rhs: add(neg(a), neg(b)) },
      { name: 'neg-as-mul', lhs: neg(a), rhs: mul(lit(-1), a) },
    ],
  },
  {
    name: 'Strength reduction',
    blurb:
      'The optimizer flourish: fuse a doubling into a single addition, then turn a multiply-by-two into a cheap left shift — exactly what a compiler back-end does.',
    rules: [
      { name: 'self-add', lhs: add(a, a), rhs: mul(a, lit(2)) },
      { name: 'mul2-shl', lhs: mul(a, lit(2)), rhs: shl(a, lit(1)) },
      { name: 'shl0', lhs: shl(a, lit(0)), rhs: a },
    ],
  },
]

export const ALL_RULES: Rewrite[] = RULE_GROUPS.flatMap((g) => g.rules)

/** Collect the active rules from a set of enabled group names. */
export function rulesFor(enabled: Set<string>): Rewrite[] {
  return RULE_GROUPS.filter((g) => enabled.has(g.name)).flatMap((g) => g.rules)
}
