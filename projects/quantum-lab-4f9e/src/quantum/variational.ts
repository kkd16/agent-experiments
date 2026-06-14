import { QuantumState, type GateOp } from './QuantumState';
import { hermitianEig } from './Hermitian';
import { Complex, C } from './Complex';
import { embedOperator } from './DensityMatrix';
import { GATE_X, GATE_Y, GATE_Z } from './gates/single';
import type { Algorithm } from './algorithms';

/**
 * Variational quantum algorithms: a Pauli-string expectation engine, a derivative-free
 * Nelder–Mead optimizer, a Variational Quantum Eigensolver (VQE) and QAOA for MaxCut.
 * Everything runs on the exact state-vector simulator — the "quantum hardware" — while
 * a classical optimizer drives the circuit parameters, exactly as on real devices.
 */

export type Pauli = 'I' | 'X' | 'Y' | 'Z';

/** A weighted Pauli term, e.g. 0.5 * X0 Z1. `ops` maps a qubit index to its Pauli. */
export interface PauliTerm {
  coeff: number;
  ops: Record<number, Pauli>;
}

/** ⟨ψ| Σ c_k P_k |ψ⟩ for a real Hamiltonian expressed as Pauli terms. */
export function expectation(state: QuantumState, terms: PauliTerm[]): number {
  let total = 0;
  for (const term of terms) {
    const phi = state.clone();
    for (const [qStr, p] of Object.entries(term.ops)) {
      const q = Number(qStr);
      if (p === 'X') phi.applyGate({ name: 'X', qubits: [q] });
      else if (p === 'Y') phi.applyGate({ name: 'Y', qubits: [q] });
      else if (p === 'Z') phi.applyGate({ name: 'Z', qubits: [q] });
    }
    // ⟨ψ|φ⟩ — Hermitian Pauli strings give a real result.
    let dot = 0;
    for (let i = 0; i < state.amplitudes.length; i++) {
      dot += state.amplitudes[i].conj().mul(phi.amplitudes[i]).re;
    }
    total += term.coeff * dot;
  }
  return total;
}

/** Exact ground-state energy by diagonalising the dense Hamiltonian matrix. */
export function exactGroundEnergy(numQubits: number, terms: PauliTerm[]): number {
  const size = 1 << numQubits;
  const H: Complex[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => C(0)));
  const paulis: Record<Pauli, Complex[][]> = {
    I: [[C(1), C(0)], [C(0), C(1)]], X: GATE_X, Y: GATE_Y, Z: GATE_Z,
  };
  for (const term of terms) {
    // Build the full operator as a product of single-qubit embeddings.
    let M: Complex[][] = identity(size);
    for (const [qStr, p] of Object.entries(term.ops)) {
      if (p === 'I') continue;
      M = matMulC(M, embedOperator(paulis[p], [Number(qStr)], numQubits));
    }
    for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) H[i][j] = H[i][j].add(M[i][j].scale(term.coeff));
  }
  const vals = hermitianEig(H).values;
  return vals[vals.length - 1]; // smallest eigenvalue (sorted descending)
}

function identity(n: number): Complex[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? C(1) : C(0))));
}
function matMulC(A: Complex[][], B: Complex[][]): Complex[][] {
  const n = A.length, m = B[0].length, k = B.length;
  const r: Complex[][] = Array.from({ length: n }, () => Array.from({ length: m }, () => C(0)));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) for (let l = 0; l < k; l++) r[i][j] = r[i][j].add(A[i][l].mul(B[l][j]));
  return r;
}

/**
 * Nelder–Mead simplex minimization (derivative-free). Returns the best point found.
 * Robust for the low-dimensional parameter spaces of small variational circuits.
 */
export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  opts: { maxIter?: number; step?: number } = {},
): { x: number[]; fx: number } {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 300;
  const step = opts.step ?? 0.6;
  // Build initial simplex.
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += step;
    simplex.push(p);
  }
  let fvals = simplex.map(f);
  const order = () => {
    const idx = simplex.map((_, i) => i).sort((a, b) => fvals[a] - fvals[b]);
    simplex = idx.map((i) => simplex[i]);
    fvals = idx.map((i) => fvals[i]);
  };
  for (let iter = 0; iter < maxIter; iter++) {
    order();
    if (Math.abs(fvals[n] - fvals[0]) < 1e-10) break;
    // Centroid of all but worst.
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const reflect = cen.map((c, j) => c + (c - worst[j]));
    const fr = f(reflect);
    if (fr < fvals[0]) {
      const expand = cen.map((c, j) => c + 2 * (c - worst[j]));
      const fe = f(expand);
      if (fe < fr) { simplex[n] = expand; fvals[n] = fe; } else { simplex[n] = reflect; fvals[n] = fr; }
    } else if (fr < fvals[n - 1]) {
      simplex[n] = reflect; fvals[n] = fr;
    } else {
      const contract = cen.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = f(contract);
      if (fc < fvals[n]) { simplex[n] = contract; fvals[n] = fc; }
      else {
        // Shrink toward best.
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          fvals[i] = f(simplex[i]);
        }
      }
    }
  }
  order();
  return { x: simplex[0], fx: fvals[0] };
}

// ---- VQE -----------------------------------------------------------------

/** Hardware-efficient 2-qubit ansatz: Ry–Ry · CNOT · Ry–Ry (4 parameters). */
export function vqeAnsatz(theta: number[]): GateOp[] {
  return [
    { name: 'Ry', qubits: [0], params: [theta[0]] },
    { name: 'Ry', qubits: [1], params: [theta[1]] },
    { name: 'CNOT', qubits: [0, 1] },
    { name: 'Ry', qubits: [0], params: [theta[2]] },
    { name: 'Ry', qubits: [1], params: [theta[3]] },
  ];
}

/** 2-site transverse-field Ising Hamiltonian H = J·Z0Z1 + h·(X0 + X1). */
export function tfimHamiltonian(J = 1, h = 0.6): PauliTerm[] {
  return [
    { coeff: J, ops: { 0: 'Z', 1: 'Z' } },
    { coeff: h, ops: { 0: 'X' } },
    { coeff: h, ops: { 1: 'X' } },
  ];
}

export interface VQEResult {
  energy: number;
  exact: number;
  theta: number[];
  iterations: { step: number; energy: number }[];
}

export function runVQE(terms: PauliTerm[] = tfimHamiltonian()): VQEResult {
  const energyAt = (theta: number[]) => {
    const s = new QuantumState(2);
    for (const op of vqeAnsatz(theta)) s.applyGate(op);
    return expectation(s, terms);
  };
  const trace: { step: number; energy: number }[] = [];
  let best = { x: [0, 0, 0, 0], fx: Infinity };
  // Multi-start to dodge local minima; record the best run's descent.
  const seeds = [
    [0.1, 0.1, 0.1, 0.1], [1.5, -1.5, 0.5, 0.5], [2.0, 2.0, -1.0, 1.0],
    [-1.0, 1.0, 2.0, -2.0], [0.8, -0.3, 1.2, 0.4],
  ];
  for (const seed of seeds) {
    const r = nelderMead(energyAt, seed, { maxIter: 250, step: 0.5 });
    if (r.fx < best.fx) best = r;
  }
  // Re-run from the best seed capturing a clean monotone-ish descent for display.
  let cur = best.x.slice();
  let curE = energyAt(cur);
  trace.push({ step: 0, energy: curE });
  for (let i = 1; i <= 20; i++) {
    const r = nelderMead(energyAt, cur, { maxIter: 12, step: 0.3 / i });
    cur = r.x; curE = Math.min(curE, r.fx);
    trace.push({ step: i, energy: curE });
  }
  return {
    energy: best.fx,
    exact: exactGroundEnergy(2, terms),
    theta: best.x,
    iterations: trace,
  };
}

// ---- QAOA for MaxCut -----------------------------------------------------

export type Graph = { n: number; edges: [number, number][] };

/** Cost of a cut (assignment given as a bitstring integer): #edges crossing the cut. */
export function cutValue(g: Graph, assignment: number): number {
  let c = 0;
  for (const [u, v] of g.edges) if (((assignment >> u) & 1) !== ((assignment >> v) & 1)) c++;
  return c;
}

/** One QAOA layer for MaxCut: cost unitary (ZZ rotations per edge) + mixer (Rx). */
export function qaoaLayerOps(g: Graph, gamma: number, beta: number): GateOp[] {
  const ops: GateOp[] = [];
  for (const [u, v] of g.edges) {
    ops.push({ name: 'CNOT', qubits: [u, v] });
    ops.push({ name: 'Rz', qubits: [v], params: [2 * gamma] });
    ops.push({ name: 'CNOT', qubits: [u, v] });
  }
  for (let q = 0; q < g.n; q++) ops.push({ name: 'Rx', qubits: [q], params: [2 * beta] });
  return ops;
}

export function qaoaCircuit(g: Graph, params: { gamma: number; beta: number }[]): GateOp[] {
  const ops: GateOp[] = [];
  for (let q = 0; q < g.n; q++) ops.push({ name: 'H', qubits: [q] });
  for (const { gamma, beta } of params) ops.push(...qaoaLayerOps(g, gamma, beta));
  return ops;
}

/** Expected cut value ⟨C⟩ for a QAOA state (probabilities × per-state cut). */
export function expectedCut(g: Graph, params: { gamma: number; beta: number }[]): number {
  const s = new QuantumState(g.n);
  for (const op of qaoaCircuit(g, params)) s.applyGate(op);
  const probs = s.probabilities();
  let e = 0;
  for (let i = 0; i < probs.length; i++) e += probs[i] * cutValue(g, i);
  return e;
}

export interface QAOAResult {
  params: { gamma: number; beta: number }[];
  expectedCut: number;
  maxCut: number;
  ops: GateOp[];
  topStates: { state: number; prob: number; cut: number }[];
}

export function runQAOA(g: Graph, layers = 1): QAOAResult {
  const flatToParams = (x: number[]) =>
    Array.from({ length: layers }, (_, l) => ({ gamma: x[2 * l], beta: x[2 * l + 1] }));
  const objective = (x: number[]) => -expectedCut(g, flatToParams(x));
  let best = { x: new Array(2 * layers).fill(0.4), fx: Infinity };
  // Coarse grid over the first layer's (γ,β) seeds the optimizer near a good basin,
  // then refine with multi-start Nelder–Mead — robust against QAOA's many local optima.
  const grid: number[][] = [];
  const gridN = 6;
  for (let a = 0; a < gridN; a++) {
    for (let b = 0; b < gridN; b++) {
      const seed = new Array(2 * layers).fill(0.3);
      seed[0] = (Math.PI * (a + 0.5)) / gridN;
      seed[1] = (Math.PI * (b + 0.5)) / gridN;
      grid.push(seed);
    }
  }
  const seeds = [...grid, ...Array.from({ length: 12 }, () => Array.from({ length: 2 * layers }, () => Math.random() * Math.PI))];
  for (const seed of seeds) {
    const res = nelderMead(objective, seed, { maxIter: 200, step: 0.5 });
    if (res.fx < best.fx) best = res;
  }
  const params = flatToParams(best.x);
  const s = new QuantumState(g.n);
  const ops = qaoaCircuit(g, params);
  for (const op of ops) s.applyGate(op);
  const probs = s.probabilities();
  const ranked = probs
    .map((prob, state) => ({ state, prob, cut: cutValue(g, state) }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 6);
  let maxCut = 0;
  for (let i = 0; i < (1 << g.n); i++) maxCut = Math.max(maxCut, cutValue(g, i));
  return { params, expectedCut: -best.fx, maxCut, ops, topStates: ranked };
}

/** Build an Algorithm card for a solved QAOA instance (for the algorithm gallery). */
export function qaoaAlgorithm(g: Graph, layers = 1): Algorithm {
  const res = runQAOA(g, layers);
  return {
    name: `QAOA MaxCut (${g.n} nodes, p=${layers})`,
    description: `Quantum Approximate Optimization solving MaxCut on a ${g.n}-vertex graph. A classical optimizer (Nelder–Mead) tunes the ${2 * layers} circuit angles to maximise the expected cut.`,
    numQubits: g.n,
    ops: res.ops,
    category: 'Variational',
    interpretation: `Optimal cut = ${res.maxCut}. QAOA reaches ⟨C⟩ ≈ ${res.expectedCut.toFixed(2)} and concentrates amplitude on the optimal cut bitstrings.`,
  };
}
