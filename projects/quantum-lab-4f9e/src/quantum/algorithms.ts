import type { GateOp } from './QuantumState';

export interface Algorithm {
  name: string;
  description: string;
  numQubits: number;
  ops: GateOp[];
  interpretation: string;
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
    ops: [
      { name: 'Ry', qubits: [2], params: [2 * Math.acos(1 / Math.sqrt(3))] },
      { name: 'H', qubits: [1] },
      { name: 'CNOT', qubits: [2, 1] },
      { name: 'X', qubits: [2] },
      { name: 'CNOT', qubits: [2, 0] },
      { name: 'Ry', qubits: [1], params: [-Math.PI / 4] },
      { name: 'CNOT', qubits: [0, 1] },
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

export const ALGORITHMS: Algorithm[] = [
  bellState(),
  ghzState(),
  wState(),
  deutschJozsa(true),
  deutschJozsa(false),
  grover(2, 3),
  grover(3, 5),
  quantumFourierTransform(3),
  bernsteinVazirani(5, 3),
  quantumTeleportation(),
  simonsAlgorithm(),
];
