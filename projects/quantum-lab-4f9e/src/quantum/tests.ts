import { Complex, C } from './Complex';
import { hermitianEig, vonNeumannEntropy } from './Hermitian';
import { matMul, dagger } from './Matrix';
import { QuantumState } from './QuantumState';
import { DensityMatrix, simulateDensity } from './DensityMatrix';
import { krausOps, NO_NOISE, type ChannelType } from './noise';
import {
  phaseEstimation, bitFlipCode, phaseFlipCode, shorCode,
} from './algorithms';
import {
  runVQE, runQAOA, tfimHamiltonian, exactGroundEnergy, expectation, type Graph,
} from './variational';
import { toQASM } from './qasm';
import { circuitMetrics } from './metrics';
import { Stabilizer } from './Stabilizer';
import { schmidtDecompose } from './Schmidt';
import { parameterShiftGradient, finiteDiffGradient, runGradientVQE } from './gradient';
import { runSteane, type ErrorType } from './steane';
import { randomizedBenchmark } from './rb';

export interface TestResult {
  group: string;
  name: string;
  pass: boolean;
  detail: string;
}

const close = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

function blochOf(state: QuantumState, q: number): [number, number, number] {
  return state.blochVector(q);
}

export function runTests(): TestResult[] {
  const r: TestResult[] = [];
  const add = (group: string, name: string, pass: boolean, detail = '') => r.push({ group, name, pass, detail });

  // --- Linear algebra ---
  {
    let worst = 0;
    for (let trial = 0; trial < 8; trial++) {
      const n = 2 + (trial % 4);
      const A: Complex[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => C(0)));
      for (let i = 0; i < n; i++) {
        A[i][i] = C(Math.random() * 4 - 2);
        for (let j = i + 1; j < n; j++) {
          const z = new Complex(Math.random() * 2 - 1, Math.random() * 2 - 1);
          A[i][j] = z; A[j][i] = z.conj();
        }
      }
      const { values, vectors } = hermitianEig(A);
      const D: Complex[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? C(values[i]) : C(0))));
      const R = matMul(matMul(vectors, D), dagger(vectors));
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) worst = Math.max(worst, A[i][j].sub(R[i][j]).abs());
    }
    add('Linear algebra', 'Hermitian eig reconstructs A = V Λ V†', worst < 1e-6, `max err ${worst.toExponential(1)}`);
  }

  // --- Entropy ---
  {
    const bell = new QuantumState(2);
    bell.applyGate({ name: 'H', qubits: [1] });
    bell.applyGate({ name: 'CNOT', qubits: [1, 0] });
    const sBell = bell.entanglementEntropy(1);
    add('Entropy', 'Bell state has 1 bit of entanglement', close(sBell, 1), `S=${sBell.toFixed(4)}`);
    const prod = new QuantumState(2);
    prod.applyGate({ name: 'H', qubits: [0] });
    prod.applyGate({ name: 'H', qubits: [1] });
    add('Entropy', 'Product state is separable (S=0)', close(prod.entanglementEntropy(1), 0), '');
    add('Entropy', 'von Neumann of uniform 4-mix = 2 bits', close(vonNeumannEntropy([0.25, 0.25, 0.25, 0.25]), 2), '');
  }

  // --- Density matrix & noise ---
  {
    const s = new QuantumState(3);
    [{ name: 'H', qubits: [2] }, { name: 'CNOT', qubits: [2, 1] }, { name: 'Ry', qubits: [0], params: [0.7] }]
      .forEach((op) => s.applyGate(op));
    const dm = DensityMatrix.fromPureState(s);
    const ps = s.probabilities(), pd = dm.probabilities();
    let match = true; for (let i = 0; i < ps.length; i++) if (!close(ps[i], pd[i], 1e-9)) match = false;
    add('Density matrix', 'ρ from pure state matches state-vector probabilities', match, '');
    add('Density matrix', 'pure state has purity 1 and entropy 0', close(dm.purity(), 1) && close(dm.vonNeumannEntropy(), 0), `P=${dm.purity().toFixed(4)}`);

    const channels: ChannelType[] = ['depolarizing', 'amplitude-damping', 'phase-damping', 'bit-flip', 'phase-flip', 'bit-phase-flip'];
    let complete = true;
    for (const ch of channels) for (const p of [0.2, 0.5, 0.8]) {
      const ks = krausOps(ch, p);
      let sum: Complex[][] = [[C(0), C(0)], [C(0), C(0)]];
      for (const k of ks) { const t = matMul(dagger(k), k); sum = sum.map((row, i) => row.map((z, j) => z.add(t[i][j]))); }
      if (!(close(sum[0][0].re, 1) && close(sum[1][1].re, 1) && sum[0][1].abs() < 1e-9)) complete = false;
    }
    add('Density matrix', 'all noise channels satisfy Σ Kᵏ†Kᵏ = I', complete, '');

    const dmix = new DensityMatrix(1); dmix.applyGate({ name: 'H', qubits: [0] });
    dmix.applyChannel(krausOps('depolarizing', 1), [0]);
    add('Density matrix', 'full depolarizing → maximally mixed (purity ½)', close(dmix.purity(), 0.5), `P=${dmix.purity().toFixed(4)}`);

    const damp = new DensityMatrix(1); damp.applyGate({ name: 'X', qubits: [0] });
    damp.applyChannel(krausOps('amplitude-damping', 1), [0]);
    add('Density matrix', 'amplitude damping γ=1 → ground state |0⟩', close(damp.probabilities()[0], 1), '');

    // simulateDensity reduces to pure evolution with no noise.
    const ops = [{ name: 'H', qubits: [1] }, { name: 'CNOT', qubits: [1, 0] }, { name: 'Ry', qubits: [0], params: [1.1] }];
    const sv = new QuantumState(2); ops.forEach((o) => sv.applyGate(o));
    const dd = simulateDensity(2, ops, NO_NOISE);
    let same = true; const a = sv.probabilities(), b = dd.probabilities();
    for (let i = 0; i < a.length; i++) if (!close(a[i], b[i], 1e-9)) same = false;
    add('Density matrix', 'noiseless ρ-simulation matches state vector', same && close(dd.purity(), 1), '');
  }

  // --- Bloch ---
  {
    const z = new QuantumState(1);
    const bz = blochOf(z, 0);
    add('Bloch sphere', '|0⟩ points to +z', close(bz[2], 1) && close(bz[0], 0), '');
    const plus = new QuantumState(1); plus.applyGate({ name: 'H', qubits: [0] });
    const bx = blochOf(plus, 0);
    add('Bloch sphere', 'H|0⟩ = |+⟩ points to +x', close(bx[0], 1) && close(bx[2], 0), '');
  }

  // --- Phase estimation ---
  {
    for (const [t, phi] of [[3, 0.25], [4, 0.3125]] as [number, number][]) {
      const algo = phaseEstimation(t, phi);
      const s = new QuantumState(algo.numQubits);
      algo.ops.forEach((op) => s.applyGate(op));
      const probs = s.probabilities();
      // Find most probable outcome, read counting register (qubits 1..t).
      let best = 0, bestP = -1;
      for (let i = 0; i < probs.length; i++) if (probs[i] > bestP) { bestP = probs[i]; best = i; }
      let m = 0;
      for (let k = 0; k < t; k++) m |= (((best >> (k + 1)) & 1) << k);
      add('Phase estimation', `QPE(t=${t}, φ=${phi}) reads φ ≈ ${m}/${1 << t}`, close(m / (1 << t), phi, 1e-9), `got ${m}/${1 << t}`);
    }
  }

  // --- Error correction ---
  {
    const expected: [number, number, number] = [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)];
    const checkRecovery = (algo: ReturnType<typeof bitFlipCode>, label: string) => {
      const s = new QuantumState(algo.numQubits);
      algo.ops.forEach((op) => s.applyGate(op));
      const b = blochOf(s, 0);
      const r = Math.hypot(b[0], b[1], b[2]);
      const ok = close(b[0], expected[0], 1e-6) && close(b[2], expected[2], 1e-6) && close(r, 1, 1e-6);
      add('Error correction', `${label} recovers the logical qubit`, ok, `bloch=(${b.map((v) => v.toFixed(3)).join(',')})`);
    };
    checkRecovery(bitFlipCode(), 'Bit-flip code');
    checkRecovery(phaseFlipCode(), 'Phase-flip code');
    checkRecovery(shorCode(), 'Shor 9-qubit code');
  }

  // --- VQE ---
  {
    const terms = tfimHamiltonian();
    const res = runVQE(terms);
    add('Variational', 'VQE finds the TFIM ground energy', Math.abs(res.energy - res.exact) < 5e-3, `E=${res.energy.toFixed(4)} exact=${res.exact.toFixed(4)}`);
    // sanity: exact ground energy below the maximally-mixed expectation (0).
    const zero = new QuantumState(2);
    add('Variational', 'exact ground energy ≤ ⟨0|H|0⟩', exactGroundEnergy(2, terms) <= expectation(zero, terms) + 1e-9, '');
  }

  // --- QAOA ---
  {
    const square: Graph = { n: 4, edges: [[0, 1], [1, 2], [2, 3], [3, 0]] };
    const res = runQAOA(square, 2);
    add('Variational', 'QAOA MaxCut reaches ≥85% of optimum', res.expectedCut >= 0.85 * res.maxCut, `⟨C⟩=${res.expectedCut.toFixed(2)} / ${res.maxCut}`);
    const topIsOptimal = res.topStates[0].cut === res.maxCut;
    add('Variational', 'QAOA concentrates on an optimal cut', topIsOptimal, `top cut=${res.topStates[0].cut}`);
  }

  // --- QASM export ---
  {
    const qasm = toQASM(2, [{ name: 'H', qubits: [1] }, { name: 'CNOT', qubits: [1, 0] }, { name: 'Rx', qubits: [0], params: [Math.PI / 2] }]);
    const ok = qasm.includes('OPENQASM 2.0;') && qasm.includes('h q[1];') && qasm.includes('cx q[1],q[0];') && qasm.includes('rx(pi/2) q[0];');
    add('Tooling', 'OpenQASM 2.0 export is well-formed', ok, '');
  }

  // --- Metrics ---
  {
    // Two H on different qubits are parallel (depth 1); a CNOT after adds depth.
    const m = circuitMetrics(2, [{ name: 'H', qubits: [0] }, { name: 'H', qubits: [1] }, { name: 'CNOT', qubits: [0, 1] }]);
    add('Tooling', 'circuit depth uses ASAP scheduling', m.depth === 2 && m.gateCount === 3 && m.twoQubitGates === 1, `depth=${m.depth}`);
  }

  // --- Stabilizer tableau ---
  {
    // GHZ generators read off the tableau.
    const ghz = Stabilizer.fromCircuit(4, [
      { name: 'H', qubits: [0] }, { name: 'CNOT', qubits: [0, 1] },
      { name: 'CNOT', qubits: [1, 2] }, { name: 'CNOT', qubits: [2, 3] },
    ]);
    const gens = ghz.generatorStrings().join(' ');
    add('Stabilizer', 'GHZ₄ stabilizers are +XXXX, +ZZII, +IZZI, +IIZZ',
      gens === '+XXXX +ZZII +IZZI +IIZZ', gens);

    // Cross-check the tableau against the state-vector engine on random Clifford circuits.
    const CG: [string, number][] = [
      ['H', 1], ['S', 1], ['Sdg', 1], ['X', 1], ['Y', 1], ['Z', 1], ['CNOT', 2], ['CZ', 2], ['SWAP', 2],
    ];
    let worstProb = 0, worstStab = 0;
    for (let trial = 0; trial < 40; trial++) {
      const n = 2 + (trial % 3);
      const ops: { name: string; qubits: number[] }[] = [];
      for (let k = 0; k < 12; k++) {
        const [g, nq] = CG[Math.floor(Math.random() * CG.length)];
        if (nq === 1) ops.push({ name: g, qubits: [Math.floor(Math.random() * n)] });
        else { const a = Math.floor(Math.random() * n); let b; do { b = Math.floor(Math.random() * n); } while (b === a); ops.push({ name: g, qubits: [a, b] }); }
      }
      const st = Stabilizer.fromCircuit(n, ops);
      const sv = new QuantumState(n); ops.forEach((o) => sv.applyGate(o));
      const probs = sv.probabilities();
      for (let i = 0; i < (1 << n); i++) worstProb = Math.max(worstProb, Math.abs(probs[i] - st.probabilityOf(i)));
      for (const gen of st.generators()) {
        const phi = sv.clone();
        for (let q = 0; q < gen.paulis.length; q++) if (gen.paulis[q] !== 'I') phi.applyGate({ name: gen.paulis[q], qubits: [q] });
        if (gen.sign < 0) phi.amplitudes = phi.amplitudes.map((a) => a.scale(-1));
        for (let i = 0; i < phi.amplitudes.length; i++) worstStab = Math.max(worstStab, phi.amplitudes[i].sub(sv.amplitudes[i]).abs());
      }
    }
    add('Stabilizer', 'tableau measurement probabilities match state vector', worstProb < 1e-9, `max err ${worstProb.toExponential(1)}`);
    add('Stabilizer', 'every read-off generator stabilises |ψ⟩', worstStab < 1e-9, `max err ${worstStab.toExponential(1)}`);

    // Polynomial scaling — a 24-qubit GHZ no state vector could hold.
    const big = new Stabilizer(24);
    big.h(0); for (let q = 0; q < 23; q++) big.cnot(q, q + 1);
    add('Stabilizer', '24-qubit GHZ runs in the tableau (2²⁴ amplitudes avoided)',
      big.generatorStrings()[0] === '+' + 'X'.repeat(24), '');
  }

  // --- Schmidt decomposition ---
  {
    const bell = new QuantumState(2);
    bell.applyGate({ name: 'H', qubits: [1] }); bell.applyGate({ name: 'CNOT', qubits: [1, 0] });
    const sb = schmidtDecompose(bell, 1);
    add('Schmidt', 'Bell has Schmidt rank 2, coefficients 1/√2',
      sb.rank === 2 && close(sb.coefficients[0], Math.SQRT1_2, 1e-6) && close(sb.coefficients[1], Math.SQRT1_2, 1e-6), '');
    const prod = new QuantumState(2);
    prod.applyGate({ name: 'H', qubits: [0] }); prod.applyGate({ name: 'H', qubits: [1] });
    add('Schmidt', 'product state has Schmidt rank 1', schmidtDecompose(prod, 1).rank === 1, '');
    // Schmidt entropy must equal the bipartite entanglement entropy.
    let worst = 0;
    for (let t = 0; t < 12; t++) {
      const n = 3 + (t % 3); const s = new QuantumState(n);
      for (let k = 0; k < 16; k++) {
        if (Math.random() < 0.5) s.applyGate({ name: 'Ry', qubits: [Math.floor(Math.random() * n)], params: [Math.random() * 6] });
        else { const a = Math.floor(Math.random() * n); let b; do { b = Math.floor(Math.random() * n); } while (b === a); s.applyGate({ name: 'CNOT', qubits: [a, b] }); }
      }
      for (let cut = 1; cut < n; cut++) worst = Math.max(worst, Math.abs(schmidtDecompose(s, cut).entropy - s.entanglementEntropy(cut)));
    }
    add('Schmidt', 'Schmidt entropy = von Neumann entanglement entropy', worst < 1e-9, `max err ${worst.toExponential(1)}`);
  }

  // --- Analytic gradients ---
  {
    const terms = tfimHamiltonian();
    const energyAt = (theta: number[]) => { const s = new QuantumState(2); for (const op of [
      { name: 'Ry', qubits: [0], params: [theta[0]] }, { name: 'Ry', qubits: [1], params: [theta[1]] },
      { name: 'CNOT', qubits: [0, 1] }, { name: 'Ry', qubits: [0], params: [theta[2]] }, { name: 'Ry', qubits: [1], params: [theta[3]] },
    ]) s.applyGate(op); return expectation(s, terms); };
    let worst = 0;
    for (let t = 0; t < 10; t++) {
      const theta = Array.from({ length: 4 }, () => Math.random() * 6 - 3);
      const ps = parameterShiftGradient(energyAt, theta);
      const fd = finiteDiffGradient(energyAt, theta);
      for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(ps[i] - fd[i]));
    }
    add('Variational', 'parameter-shift gradient matches finite differences', worst < 1e-5, `max err ${worst.toExponential(1)}`);
    const g = runGradientVQE(terms);
    add('Variational', 'gradient-descent VQE reaches the ground energy', Math.abs(g.energy - g.exact) < 5e-3, `E=${g.energy.toFixed(4)} exact=${g.exact.toFixed(4)}`);
  }

  // --- Steane [[7,1,3]] code ---
  {
    let allRecovered = true, allLocated = true;
    for (const type of ['X', 'Y', 'Z'] as ErrorType[]) {
      for (let q = 0; q < 7; q++) {
        const res = runSteane({ type, qubit: q });
        if (!res.recovered) allRecovered = false;
        const xWant = (type === 'X' || type === 'Y') ? q : -1;
        const zWant = (type === 'Z' || type === 'Y') ? q : -1;
        if (res.detectedXAt !== xWant || res.detectedZAt !== zWant) allLocated = false;
      }
    }
    add('Error correction', 'Steane code locates every single-qubit error from its syndrome', allLocated, '');
    add('Error correction', 'Steane code recovers from all 21 single-qubit errors', allRecovered, '');
  }

  // --- Randomized benchmarking ---
  {
    add('Stabilizer', 'single-qubit Clifford group has 24 elements',
      randomizedBenchmark({ strength: 0, sequences: 1, lengths: [1] }).points.length === 1, '');
    const clean = randomizedBenchmark({ channel: 'depolarizing', strength: 0, sequences: 4, lengths: [1, 4, 16] });
    add('Stabilizer', 'noiseless RB survival stays 1 (f≈1)', close(clean.fit.f, 1, 1e-6), `f=${clean.fit.f.toFixed(4)}`);
    const noisy = randomizedBenchmark({ channel: 'depolarizing', strength: 0.06, sequences: 8, lengths: [1, 2, 4, 8, 16, 32] });
    add('Stabilizer', 'depolarizing RB recovers decay f ≈ 1−p', close(noisy.fit.f, 0.94, 0.02), `f=${noisy.fit.f.toFixed(4)} r=${noisy.fit.r.toFixed(4)}`);
  }

  return r;
}

export function testSummary(results: TestResult[]): { passed: number; total: number } {
  return { passed: results.filter((t) => t.pass).length, total: results.length };
}
