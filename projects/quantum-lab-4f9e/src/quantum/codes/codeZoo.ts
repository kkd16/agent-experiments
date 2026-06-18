/**
 * A catalogue of stabilizer codes defined purely by their generator Pauli strings and logical
 * operators. Every code here is run through `StabilizerCode.validity()` and `distance()` in the
 * self-test suite, so a typo in any generator is caught mechanically.
 *
 * The headline addition is the **perfect five-qubit code** [[5,1,3]] — the smallest code that
 * corrects an *arbitrary* single-qubit error, and the first genuinely non-CSS (X- and Z-mixing,
 * truly entangling) stabilizer code in the lab. Its four generators are cyclic shifts of XZZXI,
 * and it is *perfect*: its 2⁴ = 16 syndromes are in exact bijection with the 15 single-qubit
 * errors plus the identity, saturating the quantum Hamming bound with nothing wasted.
 */

import { StabilizerCode } from './StabilizerCode';

export interface CodeSpec {
  key: string;
  title: string;
  blurb: string;
  build: () => StabilizerCode;
}

/** The perfect five-qubit code [[5,1,3]] — cyclic generators, X̄ = X⊗⁵, Z̄ = Z⊗⁵. */
export function fiveQubitCode(): StabilizerCode {
  return new StabilizerCode(
    'Five-qubit [[5,1,3]]', 5,
    ['XZZXI', 'IXZZX', 'XIXZZ', 'ZXIXZ'],
    ['XXXXX'],
    ['ZZZZZ'],
  );
}

/** The Steane code [[7,1,3]] — two copies of the classical [7,4,3] Hamming code (a CSS code). */
export function steaneCode(): StabilizerCode {
  return new StabilizerCode(
    'Steane [[7,1,3]]', 7,
    [
      'IIIXXXX', 'IXXIIXX', 'XIXIXIX', // X-checks
      'IIIZZZZ', 'IZZIIZZ', 'ZIZIZIZ', // Z-checks
    ],
    ['XXXXXXX'],
    ['ZZZZZZZ'],
  );
}

/** The Shor code [[9,1,3]] — a bit-flip code concatenated inside a phase-flip code. */
export function shorCode(): StabilizerCode {
  return new StabilizerCode(
    'Shor [[9,1,3]]', 9,
    [
      'ZZIIIIIII', 'IZZIIIIII', 'IIIZZIIII', 'IIIIZZIII', 'IIIIIIZZI', 'IIIIIIIZZ', // intra-block Z
      'XXXXXXIII', 'IIIXXXXXX', // inter-block X
    ],
    ['XXXXXXXXX'],
    ['ZZZZZZZZZ'],
  );
}

/** The [[4,2,2]] code — the smallest error-*detecting* code, encoding two logical qubits. */
export function code422(): StabilizerCode {
  return new StabilizerCode(
    '[[4,2,2]] detection', 4,
    ['XXXX', 'ZZZZ'],
    ['XXII', 'XIXI'],
    ['ZIZI', 'ZZII'],
  );
}

/** The three-qubit bit-flip repetition code [[3,1,1]] — corrects X but is blind to Z (distance 1). */
export function bitFlipCode(): StabilizerCode {
  return new StabilizerCode(
    '3-qubit bit-flip [[3,1,1]]', 3,
    ['ZZI', 'IZZ'],
    ['XXX'],
    ['ZII'],
  );
}

export const CODE_ZOO: CodeSpec[] = [
  {
    key: 'five',
    title: 'Five-qubit [[5,1,3]] — perfect',
    blurb: 'The smallest code correcting an arbitrary single-qubit error. Non-CSS (entangling) and '
      + 'perfect: its 16 syndromes are a bijection onto the 15 single-qubit errors + identity.',
    build: fiveQubitCode,
  },
  {
    key: 'steane',
    title: 'Steane [[7,1,3]] — CSS',
    blurb: 'Two classical Hamming codes glued into a CSS code with transversal Clifford gates.',
    build: steaneCode,
  },
  {
    key: 'shor',
    title: 'Shor [[9,1,3]] — concatenated',
    blurb: 'A bit-flip repetition code nested inside a phase-flip repetition code: the first QEC code.',
    build: shorCode,
  },
  {
    key: 'c422',
    title: '[[4,2,2]] — detection, k=2',
    blurb: 'Two logical qubits, distance 2: it detects any single error but cannot uniquely correct it.',
    build: code422,
  },
  {
    key: 'bitflip',
    title: '3-qubit bit-flip [[3,1,1]]',
    blurb: 'Corrects bit-flips by majority vote but is blind to phase errors — distance 1.',
    build: bitFlipCode,
  },
];
