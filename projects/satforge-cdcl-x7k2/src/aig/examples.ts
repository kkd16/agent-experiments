// A gallery of equivalence-checking problems — small hand-written Boolean identities
// you can read at a glance, and large *structural* equivalences (ripple vs
// carry-select adders, a·b vs b·a) where two very different circuits compute the
// same function and only a SAT sweep can see it. A few are deliberately *buggy* so
// the checker earns its keep by producing a concrete distinguishing input.

import { Aig, type Lit } from './aig'
import { inputBus, rippleAdder, carrySelectAdder, arrayMultiplier } from './build'

export interface AigExample {
  id: string
  title: string
  blurb: string
  /** The ground-truth verdict (for display and self-check). */
  expected: boolean
  kind: 'dsl' | 'gen'
  srcA?: string
  srcB?: string
  /** For generated circuits: build both into a shared AIG and return output pairs. */
  build?: (aig: Aig) => { name: string; a: Lit; b: Lit }[]
  genNote?: string
}

function pairsFromBuses(
  names: string[],
  a: Lit[],
  b: Lit[],
): { name: string; a: Lit; b: Lit }[] {
  return names.map((name, i) => ({ name, a: a[i], b: b[i] }))
}

export const AIG_EXAMPLES: AigExample[] = [
  {
    id: 'distributivity',
    title: 'Distributive law',
    blurb: 'a·b + a·c  =  a·(b + c). The textbook identity — sweeping merges the two into one node.',
    expected: true,
    kind: 'dsl',
    srcA: `# left-hand side\nout y = (a & b) | (a & c)`,
    srcB: `# right-hand side\nout y = a & (b | c)`,
  },
  {
    id: 'demorgan',
    title: "De Morgan's law",
    blurb: '¬(a·b)  =  ¬a + ¬b. In an AIG these are literally the same two nodes with inverters flipped.',
    expected: true,
    kind: 'dsl',
    srcA: `out y = ~(a & b)`,
    srcB: `out y = ~a | ~b`,
  },
  {
    id: 'mux',
    title: 'Multiplexer, two ways',
    blurb: 'The classic select — s ? t : e — written as an AND/OR tree versus the XOR form e ⊕ (s·(e⊕t)). Equal, but nothing structural gives it away.',
    expected: true,
    kind: 'dsl',
    srcA: `# AND/OR mux\nout y = (s & t) | (~s & e)`,
    srcB: `# XOR form\nout y = e ^ (s & (e ^ t))`,
  },
  {
    id: 'fulladder',
    title: 'Full adder — gate vs propagate/generate',
    blurb: 'Two carry formulas: (a·b)+(cin·(a⊕b)) versus the generate/propagate g + p·cin. Same function, different gates.',
    expected: true,
    kind: 'dsl',
    srcA: `out sum  = a ^ b ^ cin\nout cout = (a & b) | (cin & (a ^ b))`,
    srcB: `g = a & b\np = a | b\nout sum  = a ^ b ^ cin\nout cout = g | (p & cin)`,
  },
  {
    id: 'fulladder-bug',
    title: 'Full adder with a carry bug',
    blurb: 'The carry-out OR was fat-fingered into an AND. The checker finds the exact input that exposes it.',
    expected: false,
    kind: 'dsl',
    srcA: `out sum  = a ^ b ^ cin\nout cout = (a & b) | (cin & (a ^ b))`,
    srcB: `# BUG: '|' became '&'\nout sum  = a ^ b ^ cin\nout cout = (a & b) & (cin | (a ^ b))`,
  },
  {
    id: 'redundant',
    title: 'Redundant logic',
    blurb: 'A circuit padded with the always-false term a·¬a and a doubly-negated wire. It collapses to plain a·b.',
    expected: true,
    kind: 'dsl',
    srcA: `out y = (a & b) | (a & ~a & c)`,
    srcB: `t = ~(~(a & b))\nout y = t`,
  },
  {
    id: 'consensus',
    title: 'Consensus theorem',
    blurb: 'a·b + ¬a·c + b·c  =  a·b + ¬a·c — the middle term is logically implied and can be deleted.',
    expected: true,
    kind: 'dsl',
    srcA: `out y = (a & b) | (~a & c) | (b & c)`,
    srcB: `out y = (a & b) | (~a & c)`,
  },
  {
    id: 'adder-ripple-vs-select',
    title: 'Ripple-carry vs carry-select adder (8-bit)',
    blurb: 'Two 8-bit adders with completely different internal structure — one slow-and-small, one wide-and-shallow — proven bit-for-bit equal.',
    expected: true,
    kind: 'gen',
    genNote: '8-bit a + b, ripple-carry against a 3-bit-block carry-select adder.',
    build: (aig) => {
      const a = inputBus(aig, 'a', 8)
      const b = inputBus(aig, 'b', 8)
      const r = rippleAdder(aig, a, b)
      const s = carrySelectAdder(aig, a, b, 3)
      const names = [...Array.from({ length: 8 }, (_, i) => `sum${i}`), 'cout']
      const pa = [...r.sum, r.cout]
      const pb = [...s.sum, s.cout]
      const pairs = pairsFromBuses(names, pa, pb)
      for (const p of pairs) aig.addOutput(p.name, p.a)
      return pairs
    },
  },
  {
    id: 'adder-select-bug',
    title: 'Carry-select adder with a wiring bug',
    blurb: 'The same two adders, but the carry-select version reads one operand bit twice. The miter finds the operand that breaks it.',
    expected: false,
    kind: 'gen',
    genNote: '8-bit ripple vs a carry-select adder whose bit 5 was miswired to bit 4.',
    build: (aig) => {
      const a = inputBus(aig, 'a', 8)
      const b = inputBus(aig, 'b', 8)
      const r = rippleAdder(aig, a, b)
      const bBug = b.slice()
      bBug[5] = b[4] // wiring fault
      const s = carrySelectAdder(aig, a, bBug, 3)
      const names = [...Array.from({ length: 8 }, (_, i) => `sum${i}`), 'cout']
      const pairs = pairsFromBuses(names, [...r.sum, r.cout], [...s.sum, s.cout])
      for (const p of pairs) aig.addOutput(p.name, p.a)
      return pairs
    },
  },
  {
    id: 'mult-commute',
    title: 'Multiplier commutativity (4-bit)',
    blurb: 'a × b against b × a on the same array multiplier — a genuine 8-output equivalence that no amount of structural hashing can spot.',
    expected: true,
    kind: 'gen',
    genNote: '4-bit array multiplier: product of (a,b) vs product of (b,a).',
    build: (aig) => {
      const a = inputBus(aig, 'a', 4)
      const b = inputBus(aig, 'b', 4)
      const p1 = arrayMultiplier(aig, a, b)
      const p2 = arrayMultiplier(aig, b, a)
      const names = Array.from({ length: 8 }, (_, i) => `p${i}`)
      const pairs = pairsFromBuses(names, p1, p2)
      for (const p of pairs) aig.addOutput(p.name, p.a)
      return pairs
    },
  },
]

export function exampleById(id: string): AigExample | undefined {
  return AIG_EXAMPLES.find((e) => e.id === id)
}
