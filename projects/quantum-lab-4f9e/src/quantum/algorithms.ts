import type { GateOp } from './QuantumState';

export type AlgoCategory = 'Entanglement' | 'Oracle' | 'Transforms' | 'Protocols' | 'Error correction' | 'Variational';

export interface Algorithm {
  name: string;
  description: string;
  numQubits: number;
  ops: GateOp[];
  interpretation: string;
  category?: AlgoCategory;
}

/** Inverse QFT acting on an explicit list of qubits (qs[0] = least significant). */
export function inverseQFTOps(qs: number[]): GateOp[] {
  const n = qs.length;
  const ops: GateOp[] = [];
  for (let i = 0; i < Math.floor(n / 2); i++) {
    ops.push({ name: 'SWAP', qubits: [qs[i], qs[n - 1 - i]] });
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const k = i - j + 1;
      ops.push({ name: 'CPhase', qubits: [qs[i], qs[j]], params: [-Math.PI / (1 << (k - 1))] });
    }
    ops.push({ name: 'H', qubits: [qs[i]] });
  }
  return ops;
}

// Quantum Phase Estimation: estimate the eigenphase φ of a phase gate (U|1⟩ = e^{2πiφ}|1⟩)
// to t bits of precision. Counting register = qubits 1..t, eigenstate = qubit 0 (|1⟩).
export function phaseEstimation(t: number, phi: number): Algorithm {
  const ops: GateOp[] = [];
  const counting = Array.from({ length: t }, (_, k) => k + 1); // LSB-first
  ops.push({ name: 'X', qubits: [0] });                         // eigenstate |1⟩
  for (const q of counting) ops.push({ name: 'H', qubits: [q] });
  // Controlled-U^{2^k}: phase kickback via CPhase by 2^k·(2πφ).
  for (let k = 0; k < t; k++) {
    const angle = (1 << k) * 2 * Math.PI * phi;
    ops.push({ name: 'CPhase', qubits: [counting[k], 0], params: [angle] });
  }
  ops.push(...inverseQFTOps(counting));
  const est = Math.round(phi * (1 << t)) / (1 << t);
  return {
    name: `Phase Estimation (φ=${phi})`,
    description: `Estimates the eigenphase φ of a unitary to ${t} bits using phase kickback + inverse QFT — the engine behind Shor's factoring and quantum chemistry.`,
    numQubits: t + 1,
    ops,
    category: 'Transforms',
    interpretation: `The counting register q1…q${t} (read as a binary fraction) collapses to ≈${est} = φ. Reading bits b₁…b_t gives φ ≈ 0.b₁b₂…b_t. Exact when φ is a dyadic ${1 << t}-th.`,
  };
}

// 3-qubit bit-flip code: protects against a single X error using reversible majority vote.
export function bitFlipCode(): Algorithm {
  return {
    name: 'Bit-Flip Code (3-qubit)',
    description: 'Encodes one logical qubit across three physical qubits and reversibly corrects a single bit-flip (X) error via a majority-vote (Toffoli) decoder — no measurement needed.',
    numQubits: 3,
    ops: [
      { name: 'Ry', qubits: [0], params: [Math.PI / 3] }, // arbitrary data state
      { name: 'CNOT', qubits: [0, 1] },
      { name: 'CNOT', qubits: [0, 2] },                   // encoded: α|000⟩+β|111⟩
      { name: 'X', qubits: [1] },                          // injected error on qubit 1
      { name: 'CNOT', qubits: [0, 1] },
      { name: 'CNOT', qubits: [0, 2] },
      { name: 'Toffoli', qubits: [2, 1, 0] },              // majority vote corrects q0
    ],
    category: 'Error correction',
    interpretation: 'Despite an X error on qubit 1, qubit 0 is restored to the original α|0⟩+β|1⟩. The Toffoli flips the data qubit only when both ancillas flag the error (syndrome 11).',
  };
}

// 3-qubit phase-flip code: the bit-flip code conjugated by Hadamards.
export function phaseFlipCode(): Algorithm {
  return {
    name: 'Phase-Flip Code (3-qubit)',
    description: 'Protects against a single phase (Z) error by working in the |±⟩ (Hadamard) basis — the dual of the bit-flip code and a building block of the 9-qubit Shor code.',
    numQubits: 3,
    ops: [
      { name: 'Ry', qubits: [0], params: [Math.PI / 3] },
      { name: 'CNOT', qubits: [0, 1] },
      { name: 'CNOT', qubits: [0, 2] },
      { name: 'H', qubits: [0] }, { name: 'H', qubits: [1] }, { name: 'H', qubits: [2] },
      { name: 'Z', qubits: [1] },                          // injected phase error
      { name: 'H', qubits: [0] }, { name: 'H', qubits: [1] }, { name: 'H', qubits: [2] },
      { name: 'CNOT', qubits: [0, 1] },
      { name: 'CNOT', qubits: [0, 2] },
      { name: 'Toffoli', qubits: [2, 1, 0] },
    ],
    category: 'Error correction',
    interpretation: 'A Z error becomes detectable as a bit flip in the Hadamard basis and is corrected by the same majority vote. Composing this with the bit-flip code gives the Shor code.',
  };
}

// 9-qubit Shor code: corrects an ARBITRARY single-qubit error (bit, phase, or both).
export function shorCode(): Algorithm {
  const ops: GateOp[] = [];
  ops.push({ name: 'Ry', qubits: [0], params: [Math.PI / 3] }); // data on qubit 0
  // Phase-flip encode across blocks (qubits 0,3,6)
  ops.push({ name: 'CNOT', qubits: [0, 3] });
  ops.push({ name: 'CNOT', qubits: [0, 6] });
  for (const b of [0, 3, 6]) ops.push({ name: 'H', qubits: [b] });
  // Bit-flip encode within each block
  for (const b of [0, 3, 6]) {
    ops.push({ name: 'CNOT', qubits: [b, b + 1] });
    ops.push({ name: 'CNOT', qubits: [b, b + 2] });
  }
  // Inject an arbitrary error (Y = bit+phase) on one physical qubit
  ops.push({ name: 'Y', qubits: [4] });
  // Bit-flip decode within each block
  for (const b of [0, 3, 6]) {
    ops.push({ name: 'CNOT', qubits: [b, b + 1] });
    ops.push({ name: 'CNOT', qubits: [b, b + 2] });
    ops.push({ name: 'Toffoli', qubits: [b + 2, b + 1, b] });
  }
  // Phase-flip decode across blocks
  for (const b of [0, 3, 6]) ops.push({ name: 'H', qubits: [b] });
  ops.push({ name: 'CNOT', qubits: [0, 3] });
  ops.push({ name: 'CNOT', qubits: [0, 6] });
  ops.push({ name: 'Toffoli', qubits: [6, 3, 0] });
  return {
    name: 'Shor Code (9-qubit)',
    description: 'The first quantum error-correcting code (Shor 1995): nests the phase-flip and bit-flip codes to correct ANY single-qubit error — bit flip, phase flip, or a continuous rotation — on 9 physical qubits.',
    numQubits: 9,
    ops,
    category: 'Error correction',
    interpretation: 'Even with a Y (combined bit+phase) error on a physical qubit, the logical state on qubit 0 is fully recovered. This demonstrates the discretization of errors — correcting X and Z suffices to correct everything.',
  };
}

// Bell state: maximally entangled pair
export function bellState(): Algorithm {
  return {
    name: 'Bell State |Φ⁺⟩',
    description: 'Creates a maximally entangled Bell state (EPR pair). Measuring one qubit instantly determines the other.',
    numQubits: 2,
    ops: [
      { name: 'H', qubits: [1] },
      { name: 'CNOT', qubits: [1, 0] },
    ],
    interpretation: 'Result: (|00⟩ + |11⟩)/√2. The two qubits are perfectly correlated — measuring 0 always gives 0, measuring 1 always gives 1.',
  };
}

// GHZ state: 3-qubit maximally entangled state
export function ghzState(): Algorithm {
  return {
    name: 'GHZ State',
    description: 'Greenberger-Horne-Zeilinger state — 3-qubit maximal entanglement. Used in quantum secret sharing and tests of non-locality.',
    numQubits: 3,
    ops: [
      { name: 'H', qubits: [2] },
      { name: 'CNOT', qubits: [2, 1] },
      { name: 'CNOT', qubits: [1, 0] },
    ],
    interpretation: 'Result: (|000⟩ + |111⟩)/√2. All three qubits are maximally entangled. Measuring one collapses all three.',
  };
}

// W state: another 3-qubit entanglement class
export function wState(): Algorithm {
  return {
    name: 'W State',
    description: 'W state is a genuinely tripartite entangled state of a different class than GHZ. Robust to qubit loss.',
    numQubits: 3,
    // Exact W₃ preparation: split q2 to P(1)=1/3, then a controlled-on-|0⟩ Ry(π/2)
    // (decomposed as Ry·CNOT·Ry·CNOT) balances q1, and a doubly-controlled X seeds
    // the last excitation on q0 when q2=q1=0.
    ops: [
      { name: 'Ry', qubits: [2], params: [2 * Math.asin(1 / Math.sqrt(3))] },
      { name: 'X', qubits: [2] },
      { name: 'Ry', qubits: [1], params: [Math.PI / 4] },
      { name: 'CNOT', qubits: [2, 1] },
      { name: 'Ry', qubits: [1], params: [-Math.PI / 4] },
      { name: 'CNOT', qubits: [2, 1] },
      { name: 'X', qubits: [2] },
      { name: 'X', qubits: [2] }, { name: 'X', qubits: [1] },
      { name: 'Toffoli', qubits: [2, 1, 0] },
      { name: 'X', qubits: [2] }, { name: 'X', qubits: [1] },
    ],
    interpretation: 'Result: (|001⟩ + |010⟩ + |100⟩)/√3. Exactly one qubit is |1⟩ but we don\'t know which one.',
  };
}

// Deutsch-Jozsa: determine if f is constant or balanced in one query
export function deutschJozsa(balanced: boolean): Algorithm {
  const n = 3;
  const ops: GateOp[] = [];

  // Initialize: ancilla qubit in |1⟩
  ops.push({ name: 'X', qubits: [0] });

  // Hadamard on all qubits
  for (let i = 0; i <= n; i++) ops.push({ name: 'H', qubits: [i] });

  // Oracle
  if (balanced) {
    // Balanced oracle: f(x) = x0 XOR x1
    ops.push({ name: 'CNOT', qubits: [2, 0] });
    ops.push({ name: 'CNOT', qubits: [3, 0] });
  }
  // Constant oracle: f(x) = 0, do nothing (identity)

  // Hadamard on input qubits
  for (let i = 1; i <= n; i++) ops.push({ name: 'H', qubits: [i] });

  return {
    name: `Deutsch-Jozsa (${balanced ? 'Balanced' : 'Constant'})`,
    description: `Determines if a function f:{0,1}³→{0,1} is constant (same output) or balanced (50/50 outputs) in exactly ONE quantum query vs 2^(n-1)+1 classical queries.`,
    numQubits: n + 1,
    ops,
    interpretation: balanced
      ? 'Measuring |1⟩ on ANY input qubit reveals f is BALANCED. Classical computers need up to 5 queries; quantum needs just 1.'
      : 'Measuring |000⟩ on input qubits reveals f is CONSTANT. The quantum speedup is exponential for large n.',
  };
}

// Grover's search: find marked element in O(√N) queries
export function grover(numQubits: number, target: number): Algorithm {
  const N = 1 << numQubits;
  const optimalIter = Math.round(Math.PI / 4 * Math.sqrt(N));
  const ops: GateOp[] = [];

  // Initialize superposition
  for (let q = 0; q < numQubits; q++) ops.push({ name: 'H', qubits: [q] });

  for (let iter = 0; iter < optimalIter; iter++) {
    // Phase oracle: flip sign of target state
    // Decompose oracle into CNOT + X gates
    for (let q = 0; q < numQubits; q++) {
      if (!((target >> q) & 1)) ops.push({ name: 'X', qubits: [q] });
    }
    if (numQubits === 2) {
      ops.push({ name: 'CZ', qubits: [1, 0] });
    } else if (numQubits === 3) {
      ops.push({ name: 'H', qubits: [0] });
      ops.push({ name: 'Toffoli', qubits: [2, 1, 0] });
      ops.push({ name: 'H', qubits: [0] });
    }
    for (let q = 0; q < numQubits; q++) {
      if (!((target >> q) & 1)) ops.push({ name: 'X', qubits: [q] });
    }

    // Diffusion operator: 2|s⟩⟨s| - I
    for (let q = 0; q < numQubits; q++) ops.push({ name: 'H', qubits: [q] });
    for (let q = 0; q < numQubits; q++) ops.push({ name: 'X', qubits: [q] });
    if (numQubits === 2) {
      ops.push({ name: 'CZ', qubits: [1, 0] });
    } else if (numQubits === 3) {
      ops.push({ name: 'H', qubits: [0] });
      ops.push({ name: 'Toffoli', qubits: [2, 1, 0] });
      ops.push({ name: 'H', qubits: [0] });
    }
    for (let q = 0; q < numQubits; q++) ops.push({ name: 'X', qubits: [q] });
    for (let q = 0; q < numQubits; q++) ops.push({ name: 'H', qubits: [q] });
  }

  return {
    name: `Grover's Search (target: |${target.toString(2).padStart(numQubits, '0')}⟩)`,
    description: `Finds target state |${target.toString(2).padStart(numQubits, '0')}⟩ among ${N} states in √${N} ≈ ${optimalIter} iterations. Classical search needs O(N) queries; Grover's needs O(√N) — a quadratic speedup.`,
    numQubits,
    ops,
    interpretation: `After ${optimalIter} Grover iteration(s), the amplitude of |${target.toString(2).padStart(numQubits, '0')}⟩ is amplified. Measuring will find the target with high probability (~${Math.round(100 * Math.sin((2 * optimalIter + 1) * Math.asin(1 / Math.sqrt(N))) ** 2)}%).`,
  };
}

// Quantum Fourier Transform
export function quantumFourierTransform(numQubits: number): Algorithm {
  const ops: GateOp[] = [];

  for (let i = numQubits - 1; i >= 0; i--) {
    ops.push({ name: 'H', qubits: [i] });
    for (let j = i - 1; j >= 0; j--) {
      const k = i - j + 1;
      ops.push({ name: 'CPhase', qubits: [i, j], params: [Math.PI / (1 << (k - 1))] });
    }
  }

  // Swap to correct output order
  for (let i = 0; i < Math.floor(numQubits / 2); i++) {
    ops.push({ name: 'SWAP', qubits: [i, numQubits - 1 - i] });
  }

  return {
    name: `QFT (${numQubits} qubits)`,
    description: `Quantum Fourier Transform — the heart of Shor's factoring algorithm. Performs DFT on quantum amplitudes. Input: computational basis state. Output: frequency-domain amplitudes.`,
    numQubits,
    ops,
    interpretation: 'QFT maps |j⟩ → (1/√N) Σ_k e^(2πijk/N)|k⟩. The phase patterns encode frequency information. Used in period-finding for factoring and quantum phase estimation.',
  };
}

// Bernstein-Vazirani: learn a hidden string in 1 query
export function bernsteinVazirani(secret: number, numQubits: number): Algorithm {
  const ops: GateOp[] = [];
  ops.push({ name: 'X', qubits: [0] });
  for (let q = 0; q <= numQubits; q++) ops.push({ name: 'H', qubits: [q] });

  // Oracle: CNOT on each bit of secret
  for (let q = 0; q < numQubits; q++) {
    if ((secret >> q) & 1) ops.push({ name: 'CNOT', qubits: [q + 1, 0] });
  }

  for (let q = 1; q <= numQubits; q++) ops.push({ name: 'H', qubits: [q] });

  const secretStr = secret.toString(2).padStart(numQubits, '0');
  return {
    name: `Bernstein-Vazirani (s=${secretStr})`,
    description: `Finds hidden bitstring s=${secretStr} (f(x) = s·x mod 2) in exactly 1 quantum query. Classically requires n queries.`,
    numQubits: numQubits + 1,
    ops,
    interpretation: `After measurement, input register directly reveals s=${secretStr}. This is a linear speedup from n classical queries to 1 quantum query.`,
  };
}

// Quantum teleportation
export function quantumTeleportation(): Algorithm {
  return {
    name: 'Quantum Teleportation',
    description: 'Teleports an arbitrary qubit state from Alice to Bob using a shared Bell pair + 2 classical bits. No faster-than-light signaling — classical channel required.',
    numQubits: 3,
    ops: [
      // Prepare state to teleport (qubit 2): apply Ry for interesting state
      { name: 'Ry', qubits: [2], params: [Math.PI / 3] },

      // Create Bell pair (qubits 0, 1)
      { name: 'H', qubits: [1] },
      { name: 'CNOT', qubits: [1, 0] },

      // Alice's operations (qubits 1, 2)
      { name: 'CNOT', qubits: [2, 1] },
      { name: 'H', qubits: [2] },

      // Corrections (classically controlled — simulated unconditionally)
      { name: 'CNOT', qubits: [1, 0] },
      { name: 'CZ', qubits: [2, 0] },
    ],
    interpretation: 'Qubit 2 state is teleported to qubit 0. The original (qubit 2) is destroyed in the process, satisfying no-cloning. Requires 2 classical bits for corrections.',
  };
}

// Simon's algorithm
export function simonsAlgorithm(): Algorithm {
  // f(x) = f(x XOR s) for hidden period s=011 (3 qubits input)
  return {
    name: "Simon's Algorithm (s=011)",
    description: "Finds hidden period s of a 2-to-1 function in O(n) quantum queries vs O(2^n/2) classical. Exponential speedup. Inspired Shor's algorithm.",
    numQubits: 4, // 2 input + 2 output qubits
    ops: [
      // Input superposition
      { name: 'H', qubits: [2] },
      { name: 'H', qubits: [3] },

      // Oracle for f with period s=11 (2-bit version)
      { name: 'CNOT', qubits: [2, 0] },
      { name: 'CNOT', qubits: [3, 1] },
      { name: 'CNOT', qubits: [3, 0] },

      // Hadamard again
      { name: 'H', qubits: [2] },
      { name: 'H', qubits: [3] },
    ],
    interpretation: "Measuring input register gives y where y·s=0 (mod 2). Run n-1 times and solve linear system to find s. Exponential speedup over classical.",
  };
}

function withCategory(a: Algorithm, category: AlgoCategory): Algorithm {
  return { ...a, category };
}

export const ALGORITHMS: Algorithm[] = [
  withCategory(bellState(), 'Entanglement'),
  withCategory(ghzState(), 'Entanglement'),
  withCategory(wState(), 'Entanglement'),
  withCategory(deutschJozsa(true), 'Oracle'),
  withCategory(deutschJozsa(false), 'Oracle'),
  withCategory(grover(2, 3), 'Oracle'),
  withCategory(grover(3, 5), 'Oracle'),
  withCategory(bernsteinVazirani(5, 3), 'Oracle'),
  withCategory(simonsAlgorithm(), 'Oracle'),
  withCategory(quantumFourierTransform(3), 'Transforms'),
  phaseEstimation(3, 0.25),
  phaseEstimation(4, 0.3125),
  withCategory(quantumTeleportation(), 'Protocols'),
  bitFlipCode(),
  phaseFlipCode(),
  shorCode(),
];

export const ALGO_CATEGORY_ORDER: AlgoCategory[] = [
  'Entanglement', 'Oracle', 'Transforms', 'Protocols', 'Error correction', 'Variational',
];
