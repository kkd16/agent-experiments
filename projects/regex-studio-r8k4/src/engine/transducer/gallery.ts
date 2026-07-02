// A hand-built gallery of transducers, chosen to cover the phenomena the theory
// cares about: a Mealy involution, a genuine subsequential machine with a carry,
// ε-outputs (deletion), multi-symbol writes, a state-driven Mealy counter, a
// *non-functional* transducer (one input, many outputs), and the textbook
// *functional-but-not-subsequentialisable* machine that breaks the twinning
// property.

import type { FST, FTrans } from './fst';

function mk(states: number, start: number, finals: [number, string[]][], trans: FTrans[]): FST {
  return { states, start, finals: new Map(finals), trans };
}
const t = (from: number, read: string, write: string, to: number): FTrans => ({ from, read, write, to });

export interface TransducerExample {
  id: string;
  title: string;
  blurb: string;
  /** Short descriptive tags shown as chips. */
  kind: string[];
  fst: FST;
  examples: string[];
}

// ROT13 over a symmetric 8-letter alphabet, so it is its own inverse (the
// compose demo shows ROT13 ∘ ROT13 = identity). One state, eight self-loops.
const ROT13_PAIRS: [string, string][] = [
  ['h', 'u'],
  ['e', 'r'],
  ['l', 'y'],
  ['o', 'b'],
];
const rot13Trans: FTrans[] = [];
for (const [a, b] of ROT13_PAIRS) {
  rot13Trans.push(t(0, a, b, 0), t(0, b, a, 0));
}

export const GALLERY: TransducerExample[] = [
  {
    id: 'rot13',
    title: 'ROT13 cipher',
    blurb:
      'A letter-to-letter Mealy machine: each symbol is replaced by its rotated partner. The alphabet is symmetric, so the map is its own inverse — ROT13 ∘ ROT13 is the identity (try it in the Compose panel).',
    kind: ['Mealy', 'letter-to-letter', 'subsequential', 'involution'],
    fst: mk(1, 0, [[0, ['']]], rot13Trans),
    examples: ['hello', 'help', 'boohoo'],
  },
  {
    id: 'swap-ab',
    title: 'Swap a ↔ b',
    blurb:
      'Every a becomes a b and vice-versa; c is echoed. A one-state Mealy machine — the simplest non-trivial length-preserving transduction.',
    kind: ['Mealy', 'length-preserving'],
    fst: mk(1, 0, [[0, ['']]], [t(0, 'a', 'b', 0), t(0, 'b', 'a', 0), t(0, 'c', 'c', 0)]),
    examples: ['abcabc', 'aaabbb', 'cba'],
  },
  {
    id: 'inc-binary',
    title: 'Binary increment (LSB-first)',
    blurb:
      'Add one to a binary number read least-significant-bit first. The classic subsequential transducer: a carry state emits nothing until it resolves, and the final output flushes the overflow bit. 0011 (=12, LSB-first) → 1011 (=13).',
    kind: ['subsequential', 'carry', 'final-output'],
    // state 0 = carrying (adding the +1), state 1 = settled.
    fst: mk(
      2,
      0,
      [
        [0, ['1']], // still carrying at end → overflow bit
        [1, ['']],
      ],
      [t(0, '0', '1', 1), t(0, '1', '0', 0), t(1, '0', '0', 1), t(1, '1', '1', 1)],
    ),
    examples: ['0011', '1111', '0101'],
  },
  {
    id: 'delete-x',
    title: 'Delete every x',
    blurb:
      'Erase every x, echo everything else — a transduction with ε-outputs (a transition that reads a symbol but writes nothing). The output is shorter than the input.',
    kind: ['ε-output', 'non-length-preserving'],
    fst: mk(1, 0, [[0, ['']]], [t(0, 'x', '', 0), t(0, 'a', 'a', 0), t(0, 'b', 'b', 0)]),
    examples: ['axbxxa', 'xxx', 'abab'],
  },
  {
    id: 'duplicate',
    title: 'Double every symbol',
    blurb:
      'Each input symbol is written twice — a transduction with multi-symbol writes, so the output is twice as long as the input. ab → aabb.',
    kind: ['multi-write', 'non-length-preserving'],
    fst: mk(1, 0, [[0, ['']]], [t(0, 'a', 'aa', 0), t(0, 'b', 'bb', 0)]),
    examples: ['ab', 'aba', 'bbb'],
  },
  {
    id: 'mod3',
    title: 'Running index mod 3',
    blurb:
      'A state-driven Mealy machine: it emits the running position counter modulo 3 before each symbol, then advances. The output depends on the *state*, not just the input — the essence of a Mealy machine. aaaa → 0120.',
    kind: ['Mealy', 'state-driven', 'counter'],
    fst: mk(
      3,
      0,
      [
        [0, ['']],
        [1, ['']],
        [2, ['']],
      ],
      [t(0, 'a', '0', 1), t(1, 'a', '1', 2), t(2, 'a', '2', 0)],
    ),
    examples: ['aaaa', 'aaaaaaa', 'aa'],
  },
  {
    id: 'optional-double',
    title: 'Optionally double (non-functional)',
    blurb:
      'Each a may be copied once *or* twice — a genuinely nondeterministic, non-functional transducer: one input yields a whole *set* of outputs. This is why a transducer computes a relation, not a function. aa → {aa, aaa, aaaa}.',
    kind: ['nondeterministic', 'non-functional', 'relation'],
    fst: mk(1, 0, [[0, ['']]], [t(0, 'a', 'a', 0), t(0, 'a', 'aa', 0)]),
    examples: ['a', 'aa', 'aaa'],
  },
  {
    id: 'delayed-choice',
    title: 'Delayed choice (not subsequentialisable)',
    blurb:
      'aⁿb → xⁿ, aⁿc → yⁿ. A functional transducer (each input has exactly one output) that a deterministic machine *cannot* compute: reading the a-run it cannot decide whether to emit x or y until the final b or c arrives — unbounded output delay, so the twinning property fails. Watch determinisation detect this.',
    kind: ['functional', 'nondeterministic', 'twinning fails'],
    fst: mk(
      4,
      0,
      [[3, ['']]],
      [
        t(0, 'a', 'x', 1),
        t(0, 'a', 'y', 2),
        t(1, 'a', 'x', 1),
        t(1, 'b', '', 3),
        t(2, 'a', 'y', 2),
        t(2, 'c', '', 3),
      ],
    ),
    examples: ['aaab', 'aac', 'ab'],
  },
];

export function galleryById(id: string): TransducerExample | undefined {
  return GALLERY.find((g) => g.id === id);
}
