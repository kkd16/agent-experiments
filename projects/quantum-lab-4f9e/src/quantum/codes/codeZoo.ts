/**
 * The **code zoo** — famous stabilizer codes, each given as nothing more than its list of
 * generators. Everything else ([[n, k, d]], the logical operators, the syndrome table, the
 * threshold) is *derived* by `StabilizerCode` from these strings, so a catalogue entry is only
 * the physics, never the bookkeeping.
 *
 * Qubit order in a generator string is qubit 0 (leftmost) … qubit n−1.
 */

export interface ZooEntry {
  key: string;
  name: string;
  /** Human-facing [[n, k, d]] the code is *known* to have — the engine recomputes and must agree. */
  claim: string;
  family: 'repetition' | 'detecting' | 'perfect' | 'css' | 'concatenated';
  blurb: string;
  stabilizers: string[];
}

export const CODE_ZOO: ZooEntry[] = [
  {
    key: 'rep3x',
    name: 'Bit-flip repetition',
    claim: '[[3, 1, 1]]',
    family: 'repetition',
    blurb:
      'The simplest code: |0⟩→|000⟩, |1⟩→|111⟩. Two Z-parity checks catch a single X (bit-flip) ' +
      'error and locate it by majority vote — but a single Z is an undetected logical, so the ' +
      'true quantum distance is 1. The seed of every larger code.',
    stabilizers: ['ZZI', 'IZZ'],
  },
  {
    key: 'rep3z',
    name: 'Phase-flip repetition',
    claim: '[[3, 1, 1]]',
    family: 'repetition',
    blurb:
      'The Hadamard-dual of the bit-flip code: |±⟩→|±±±⟩. Its X-parity checks catch a single Z ' +
      '(phase) error. Concatenating a bit-flip code inside a phase-flip code is exactly how the ' +
      'nine-qubit Shor code is born.',
    stabilizers: ['XXI', 'IXX'],
  },
  {
    key: 'iso422',
    name: '[[4,2,2]] error-detecting',
    claim: '[[4, 2, 2]]',
    family: 'detecting',
    blurb:
      'The smallest genuinely quantum code: two logical qubits, distance 2. XXXX and ZZZZ flag ' +
      'any single-qubit error (odd parity) without being able to locate it — the canonical ' +
      'detect-one, correct-none code, and a favourite for small fault-tolerance demos.',
    stabilizers: ['XXXX', 'ZZZZ'],
  },
  {
    key: 'perfect513',
    name: '[[5,1,3]] perfect code',
    claim: '[[5, 1, 3]]',
    family: 'perfect',
    blurb:
      'The smallest code that corrects an ARBITRARY single-qubit error, and it does so perfectly: ' +
      'its 2⁴ = 16 syndromes are in exact bijection with the 1 + 3·5 = 16 errors of weight ≤ 1, ' +
      'wasting nothing (the quantum Hamming bound is met with equality). Four cyclic shifts of ' +
      'XZZXI. Not a CSS code — X and Z protection are entangled together.',
    stabilizers: ['XZZXI', 'IXZZX', 'XIXZZ', 'ZXIXZ'],
  },
  {
    key: 'steane713',
    name: 'Steane [[7,1,3]]',
    claim: '[[7, 1, 3]]',
    family: 'css',
    blurb:
      'A CSS code from two copies of the classical [7,4,3] Hamming code. The smallest code with a ' +
      'FULLY transversal logical Clifford group — every logical H, S and CNOT is just the physical ' +
      'gate applied bitwise — which is why it anchors so many fault-tolerant architectures.',
    stabilizers: [
      'IIIXXXX', 'IXXIIXX', 'XIXIXIX', // X-checks (detect Z errors)
      'IIIZZZZ', 'IZZIIZZ', 'ZIZIZIZ', // Z-checks (detect X errors)
    ],
  },
  {
    key: 'shor913',
    name: 'Shor [[9,1,3]]',
    claim: '[[9, 1, 3]]',
    family: 'concatenated',
    blurb:
      'The first quantum code ever written down (1995): a phase-flip code with each qubit itself a ' +
      'bit-flip codeword. Six Z-checks catch bit-flips within the triples; two big X-checks catch ' +
      'phase-flips between them. A concatenation you can read straight off the generators.',
    stabilizers: [
      'ZZIIIIIII', 'IZZIIIIII', 'IIIZZIIII', 'IIIIZZIII', 'IIIIIIZZI', 'IIIIIIIZZ',
      'XXXXXXIII', 'IIIXXXXXX',
    ],
  },
];

export function zooEntry(key: string): ZooEntry {
  const e = CODE_ZOO.find((c) => c.key === key);
  if (!e) throw new Error(`unknown code "${key}"`);
  return e;
}
