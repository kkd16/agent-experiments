// A registry of named n-qubit unitaries to feed the Quantum Shannon Decomposition — from
// structured gates the optimiser can collapse (QFT, permutations, Grover's diffusion) to
// fully generic Haar-random SU(2ⁿ) that hit the worst-case CNOT count.

import { Complex, C } from './Complex';
import { type Mat, zeros } from './kak';

const eI = (t: number) => Complex.fromPolar(1, t);

function eye(n: number): Mat {
  const M = zeros(n, n);
  for (let i = 0; i < n; i++) M[i][i] = C(1);
  return M;
}

/** The n-qubit Quantum Fourier Transform, F_{jk} = e^{2πi·jk/N}/√N. */
export function qft(n: number): Mat {
  const N = 1 << n, w = (2 * Math.PI) / N, M = zeros(N, N), inv = 1 / Math.sqrt(N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) M[i][j] = eI(w * i * j).scale(inv);
  return M;
}

/** Permutation unitary from a basis-index map perm[i] = where |i⟩ goes (must be a bijection). */
function permGate(perm: number[]): Mat {
  const N = perm.length, M = zeros(N, N);
  for (let i = 0; i < N; i++) M[perm[i]][i] = C(1);
  return M;
}

/** Toffoli (CCX): flip qubit 2 iff qubits 0,1 are set. */
export function toffoli(): Mat {
  const M = eye(8);
  M[6][6] = C(0); M[7][7] = C(0); M[6][7] = C(1); M[7][6] = C(1);
  return M;
}

/** Fredkin (CSWAP): swap qubits 1,2 iff qubit 0 is set. |101⟩↔|110⟩. */
export function fredkin(): Mat {
  const M = eye(8);
  M[5][5] = C(0); M[6][6] = C(0); M[5][6] = C(1); M[6][5] = C(1);
  return M;
}

/** Multi-controlled X on n qubits (controls = top n−1, target = last): flip the all-ones state. */
function mcx(n: number): Mat {
  const N = 1 << n, M = eye(N);
  M[N - 1][N - 1] = C(0); M[N - 2][N - 2] = C(0); M[N - 1][N - 2] = C(1); M[N - 2][N - 1] = C(1);
  return M;
}

/** Grover diffusion operator 2|s⟩⟨s| − I on n qubits (s = uniform superposition). */
function groverDiffusion(n: number): Mat {
  const N = 1 << n, M = zeros(N, N), d = 2 / N;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) M[i][j] = C(d - (i === j ? 1 : 0));
  return M;
}

/** A modular increment |x⟩ → |x+1 mod N⟩ (a cyclic shift). */
function increment(n: number): Mat {
  const N = 1 << n;
  return permGate(Array.from({ length: N }, (_, i) => (i + 1) % N));
}

/** A reproducible Haar-random SU(2ⁿ): exponentiate a random anti-Hermitian via a power series
 *  on a small scale (good enough to be generic; we only need a unitary, not a specific one). */
export function seededUnitary(n: number, seed: number): Mat {
  const N = 1 << n;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  // Random complex matrix → Gram–Schmidt to a unitary (columns orthonormalised).
  const A: Mat = Array.from({ length: N }, () => Array.from({ length: N }, () => C(rnd() * 2 - 1, rnd() * 2 - 1)));
  const cols: Complex[][] = Array.from({ length: N }, (_, j) => A.map((r) => r[j]));
  const Q: Complex[][] = [];
  for (let j = 0; j < N; j++) {
    const v = cols[j].slice();
    for (let i = 0; i < j; i++) {
      let dot = C(0);
      for (let k = 0; k < N; k++) dot = dot.add(Q[i][k].conj().mul(v[k]));
      for (let k = 0; k < N; k++) v[k] = v[k].sub(dot.mul(Q[i][k]));
    }
    const nrm = Math.sqrt(v.reduce((acc, z) => acc + z.abs2(), 0));
    Q.push(v.map((z) => z.scale(1 / nrm)));
  }
  return Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => Q[j][i]));
}

export interface NamedNQubitGate {
  id: string;
  label: string;
  qubits: number;
  structured: boolean;       // does the optimiser meaningfully shrink it?
  desc: string;
  make: () => Mat;
}

export const SHANNON_GATES: NamedNQubitGate[] = [
  { id: 'qft2', label: 'QFT (2q)', qubits: 2, structured: true, desc: 'The 2-qubit Quantum Fourier Transform — the heart of phase estimation and Shor.', make: () => qft(2) },
  { id: 'qft3', label: 'QFT (3q)', qubits: 3, structured: true, desc: 'The 3-qubit QFT — a highly structured unitary the optimiser collapses well below the generic bound.', make: () => qft(3) },
  { id: 'qft4', label: 'QFT (4q)', qubits: 4, structured: true, desc: 'The 4-qubit QFT over 16 amplitudes.', make: () => qft(4) },
  { id: 'toffoli', label: 'Toffoli / CCX', qubits: 3, structured: true, desc: 'The doubly-controlled NOT — classically universal, the canonical 3-qubit gate.', make: () => toffoli() },
  { id: 'fredkin', label: 'Fredkin / CSWAP', qubits: 3, structured: true, desc: 'The controlled-SWAP — reversible-computing universal, conserves the number of 1s.', make: () => fredkin() },
  { id: 'ccz', label: 'C²Z (3q)', qubits: 3, structured: true, desc: 'A phase on |111⟩ only — locally equivalent to Toffoli.', make: () => { const M = eye(8); M[7][7] = C(-1); return M; } },
  { id: 'mcx4', label: 'C³X (4q)', qubits: 4, structured: true, desc: 'A triply-controlled NOT on four qubits.', make: () => mcx(4) },
  { id: 'grover3', label: 'Grover diffusion (3q)', qubits: 3, structured: true, desc: 'The inversion-about-the-mean reflection 2|s⟩⟨s|−I that powers Grover search.', make: () => groverDiffusion(3) },
  { id: 'incr3', label: 'Increment (3q)', qubits: 3, structured: true, desc: '|x⟩→|x+1 mod 8⟩ — a cyclic adder, a pure permutation.', make: () => increment(3) },
  { id: 'incr4', label: 'Increment (4q)', qubits: 4, structured: true, desc: '|x⟩→|x+1 mod 16⟩.', make: () => increment(4) },
  { id: 'rand2', label: 'Random SU(4)', qubits: 2, structured: false, desc: 'A generic Haar-ish 2-qubit gate — hits the worst-case CNOT count.', make: () => seededUnitary(2, 0x2026_0623) },
  { id: 'rand3', label: 'Random SU(8)', qubits: 3, structured: false, desc: 'A generic 3-qubit gate — the QSD spends the full (3/4)·4ⁿ−3·2ⁿ⁻¹ CNOTs.', make: () => seededUnitary(3, 0x2026_0623) },
  { id: 'rand4', label: 'Random SU(16)', qubits: 4, structured: false, desc: 'A generic 4-qubit gate over 16 amplitudes — 168 CNOTs, irreducible.', make: () => seededUnitary(4, 0x2026_0623) },
  { id: 'rand5', label: 'Random SU(32)', qubits: 5, structured: false, desc: 'A generic 5-qubit gate over 32 amplitudes — 720 CNOTs, the cost of universality.', make: () => seededUnitary(5, 0x2026_0623) },
];
