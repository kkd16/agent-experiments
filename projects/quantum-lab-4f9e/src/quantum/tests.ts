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
import { svd } from './SVD';
import { MPS, simulateMPS } from './MPS';
import type { GateOp } from './QuantumState';
import { tebdQuench, exactTFIM } from './tebd';
import { tfimMPO, heisenbergMPO, exactGroundEnergyMPO, mpoToDense } from './MPO';
import { runDMRG } from './dmrg';
import {
  solveTFIM, solveXY, entropyProfile, pfeutyEnergyDensity,
  thermalEnergyPerSite, centralCharge, blockEntropy, mutualInformation,
} from './FreeFermion';
import { ffQuench, exactQuenchDense } from './ffQuench';
import {
  loschmidtFiniteN, loschmidtDense, loschmidtRate, criticalModes,
  criticalTimes, quenchCrosses, dtop, groundEnergyDensity,
} from './xyChain';
import {
  gcd, modpow, multiplicativeOrder, isPrime, perfectPower, convergents, recoverOrder,
  orderFindFull, orderFindIterative, idealOrderDistribution, shorFactor, shorRng,
} from './shor';
import {
  PatternBuilder, buildExample, runPattern, oracleApply, fidelity, randomInput,
  mbqcRng, clusterState, stabilizerGenerator, pauliExpectation, type ExampleId,
} from './mbqc';
import { minWeightPerfectMatching, type Edge } from './surface/blossom';
import { buildSurfaceCode, correctRound, logicalErrorRate, mulberry32 } from './surface/SurfaceCode';
import { decodeMWPM, decodeUF } from './surface/decoder';
import {
  buildCodeCapacityGraph, buildSpaceTimeGraph, phenomLogicalErrorRate,
  codeCapacityRate, lambdaRatios, collapseFit,
} from './surface/spacetime';
import {
  type SU2, su2Mul, su2Dag, su2Neg, su2Rot, su2Dist, gcDecompose, getNet,
  basicApproximation, solovayKitaev, compileGate, sequenceToU2,
  rzTarget, rxTarget, seededTarget, GATES, GATE_SU2,
} from './solovay';
import {
  weightEnumerator, distill, exactThreshold, LEADING_THRESHOLD,
  distillCascade, distillMonteCarlo,
} from './distillation';
import {
  makhlinInvariants, canonicalGate,
} from './kak';
import {
  synthesize, faultTolerant, NAMED_GATES, seededSU4,
} from './kakCircuit';

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

  // --- Tensor networks (SVD + Matrix Product State + TEBD) ---
  {
    const randC = () => new Complex(Math.random() * 2 - 1, Math.random() * 2 - 1);
    // SVD reconstruction A = U Σ V† for both tall and wide matrices
    let worstSvd = 0, worstOrth = 0;
    for (let trial = 0; trial < 6; trial++) {
      const m = 2 + (trial % 4), n = 2 + ((trial + 2) % 4);
      const A: Complex[][] = Array.from({ length: m }, () => Array.from({ length: n }, randC));
      const { U, S, Vh } = svd(A);
      for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
        let re = 0, im = 0;
        for (let t = 0; t < S.length; t++) { const p = U[i][t].mul(Vh[t][j]).scale(S[t]); re += p.re; im += p.im; }
        worstSvd = Math.max(worstSvd, Math.abs(re - A[i][j].re), Math.abs(im - A[i][j].im));
      }
      for (let a = 0; a < S.length; a++) for (let b = 0; b < S.length; b++) {
        if (S[a] < 1e-9 || S[b] < 1e-9) continue;
        let re = 0, im = 0;
        for (let i = 0; i < m; i++) { const x = U[i][a].conj().mul(U[i][b]); re += x.re; im += x.im; }
        worstOrth = Math.max(worstOrth, Math.abs(re - (a === b ? 1 : 0)), Math.abs(im));
      }
    }
    add('Tensor networks', 'SVD reconstructs A = U Σ V†', worstSvd < 1e-9, `max err ${worstSvd.toExponential(1)}`);
    add('Tensor networks', 'SVD left singular vectors are orthonormal', worstOrth < 1e-9, `max err ${worstOrth.toExponential(1)}`);

    // random 1- and 2-qubit circuit (with long-range gates exercising the SWAP network)
    const randomCircuit = (nq: number, depth: number): GateOp[] => {
      const ops: GateOp[] = [];
      const singles = ['H', 'X', 'Y', 'Z', 'S', 'T', 'SX'];
      for (let d = 0; d < depth; d++) {
        for (let q = 0; q < nq; q++) {
          ops.push({ name: singles[Math.floor(Math.random() * singles.length)], qubits: [q] });
          ops.push({ name: 'Rz', qubits: [q], params: [Math.random() * 6] });
        }
        for (let q = d % 2; q + 1 < nq; q += 2) ops.push({ name: Math.random() < 0.5 ? 'CNOT' : 'CZ', qubits: [q, q + 1] });
        if (nq >= 4) { ops.push({ name: 'CNOT', qubits: [0, nq - 1] }); ops.push({ name: 'CPhase', qubits: [1, nq - 2], params: [Math.random() * 6] }); }
      }
      return ops;
    };

    // MPS at full bond dimension reproduces the exact state vector amplitude-for-amplitude
    let worstAmp = 0, worstEnt = 0;
    for (let trial = 0; trial < 4; trial++) {
      const nq = 6, ops = randomCircuit(nq, 3);
      const sv = new QuantumState(nq); ops.forEach((o) => sv.applyGate(o)); sv.normalize();
      const mps = simulateMPS(nq, ops, 1024);
      const vec = mps.toStateVector();
      const norm = Math.sqrt(vec.reduce((s, z) => s + z.abs2(), 0));
      for (let i = 0; i < (1 << nq); i++) worstAmp = Math.max(worstAmp, vec[i].scale(1 / norm).sub(sv.amplitudes[i]).abs());
      // bond entropy must match the state-vector's reduced-density-matrix entropy.
      // (engine cut convention: MPS cut at `c` = qubits {c..n-1} = QuantumState cut n−c.)
      for (let c = 1; c < nq; c++) worstEnt = Math.max(worstEnt, Math.abs(mps.entropyAt(c) - sv.entanglementEntropy(nq - c)));
    }
    add('Tensor networks', 'MPS (χ=∞) reproduces the exact state vector', worstAmp < 1e-9, `max amp err ${worstAmp.toExponential(1)}`);
    add('Tensor networks', 'MPS bond entropy = exact entanglement entropy', worstEnt < 1e-7, `max err ${worstEnt.toExponential(1)}`);

    // GHZ: the textbook χ=2 / 1-bit-everywhere state
    {
      const nq = 8;
      const ops: GateOp[] = [{ name: 'H', qubits: [0] }];
      for (let q = 0; q + 1 < nq; q++) ops.push({ name: 'CNOT', qubits: [q, q + 1] });
      const mps = simulateMPS(nq, ops, 8);
      const prof = mps.entropyProfile();
      add('Tensor networks', 'GHZ needs only bond dimension 2', mps.maxBondDim() === 2, `χmax=${mps.maxBondDim()}`);
      add('Tensor networks', 'GHZ has exactly 1 bit of entanglement at every cut', prof.every((e) => close(e, 1, 1e-9)), `S=[${prof.map((e) => e.toFixed(2)).join(',')}]`);
      // truncating GHZ to χ=1 must discard ≈ half the Schmidt weight
      const trunc = new MPS(nq, 1); trunc.applyCircuit(ops);
      add('Tensor networks', 'χ=1 truncation of GHZ records the discarded weight', trunc.truncationError > 0.1, `Σσ²=${trunc.truncationError.toFixed(3)}`);
    }

    // perfect sampling reproduces the Born distribution
    {
      const nq = 4, ops = randomCircuit(nq, 2);
      const sv = new QuantumState(nq); ops.forEach((o) => sv.applyGate(o)); sv.normalize();
      const probs = sv.probabilities();
      const mps = simulateMPS(nq, ops, 1024);
      const shots = 20000, counts = mps.sampleCounts(shots);
      let tv = 0; for (let i = 0; i < (1 << nq); i++) tv += Math.abs((counts.get(i) ?? 0) / shots - probs[i]);
      add('Tensor networks', 'MPS perfect sampling reproduces the Born rule', tv / 2 < 0.06, `total-variation ${(tv / 2).toFixed(3)}`);
    }

    // TEBD real-time dynamics matches exact dense evolution of the Ising chain
    {
      const nq = 6, J = 1, h = 0.8, dt = 0.05, steps = 30;
      const res = tebdQuench({ n: nq, J, h, dt, steps, maxBond: 32 });
      const exact = exactTFIM(nq, J, h, dt, steps);
      let worstX = 0; for (let s = 0; s <= steps; s++) worstX = Math.max(worstX, Math.abs(res.frames[s].mx - exact[s].mx));
      add('Tensor networks', 'TEBD evolution matches exact dynamics', worstX < 5e-3, `max ⟨X⟩ err ${worstX.toExponential(1)}`);
      add('Tensor networks', 'global quench grows entanglement from zero', res.frames[0].entropy < 1e-9 && res.frames[steps].entropy > 0.2, `S: ${res.frames[0].entropy.toExponential(0)} → ${res.frames[steps].entropy.toFixed(2)}`);
    }
  }

  // --- DMRG (variational MPS ground state via MPO environments + Lanczos) ---
  {
    // Transverse-field Ising ground energy vs exact diagonalisation of the same MPO.
    let worstTfim = 0;
    for (const [n, h] of [[6, 1.0], [8, 0.7]] as [number, number][]) {
      const mpo = tfimMPO(n, 1, h);
      const res = runDMRG(mpo, { maxBond: 16, sweeps: 8, lanczosIters: 12, seed: 3 });
      worstTfim = Math.max(worstTfim, Math.abs(res.energy - exactGroundEnergyMPO(mpo)));
    }
    add('DMRG', 'TFIM ground energy matches exact diagonalisation', worstTfim < 1e-6, `max err ${worstTfim.toExponential(1)}`);

    // Heisenberg / XXZ (including anisotropy Δ≠1) vs exact diagonalisation.
    let worstHeis = 0;
    for (const [n, d] of [[8, 1.0], [6, 0.5]] as [number, number][]) {
      const mpo = heisenbergMPO(n, 1, d);
      const res = runDMRG(mpo, { maxBond: 16, sweeps: 10, lanczosIters: 14, seed: 7 });
      worstHeis = Math.max(worstHeis, Math.abs(res.energy - exactGroundEnergyMPO(mpo)));
    }
    add('DMRG', 'Heisenberg/XXZ ground energy matches exact diagonalisation', worstHeis < 1e-5, `max err ${worstHeis.toExponential(1)}`);

    // The ground state's entanglement-entropy profile matches the exact eigenstate's.
    {
      const n = 6, mpo = tfimMPO(n, 1, 1);
      const res = runDMRG(mpo, { maxBond: 16, sweeps: 8, lanczosIters: 12, seed: 3 });
      const { values, vectors } = hermitianEig(mpoToDense(mpo));
      const gi = values.length - 1;
      const amps = Array.from({ length: 1 << n }, (_, a) => vectors[a][gi]);
      const gs = QuantumState.fromAmplitudes(amps);
      let worst = 0;
      for (let c = 0; c < n - 1; c++) worst = Math.max(worst, Math.abs(res.entropyProfile[c] - gs.entanglementEntropy(c + 1)));
      add('DMRG', 'ground-state entanglement profile matches exact', worst < 1e-4, `max err ${worst.toExponential(1)}`);
    }

    // Energy variance ⟨H²⟩−⟨H⟩² (double-layer MPO contraction) vanishes at convergence —
    // the basis-independent certificate that the state really is an eigenstate. Gapped chain
    // so the bond dimension suffices for an exact representation.
    {
      const res = runDMRG(tfimMPO(12, 1, 2), { maxBond: 16, sweeps: 10, lanczosIters: 14, seed: 3 });
      add('DMRG', 'energy variance ⟨H²⟩−⟨H⟩² vanishes at convergence', res.variance < 1e-8, `var ${res.variance.toExponential(1)}`);
    }

    // The ground state diagnoses a quantum phase transition: the gapped ferromagnetic XXZ
    // (Δ < −1) is a separable product state, while the gapless critical region (|Δ| < 1) is
    // highly entangled. (Multi-start makes the symmetry-broken ferromagnet converge robustly.)
    {
      const ferro = runDMRG(heisenbergMPO(10, 1, -1.4), { maxBond: 16, sweeps: 8, lanczosIters: 14, seed: 3, restarts: 2 });
      const crit = runDMRG(heisenbergMPO(10, 1, 0), { maxBond: 16, sweeps: 10, lanczosIters: 14, seed: 3, restarts: 2 });
      const sFerro = ferro.entropyProfile[4], sCrit = crit.entropyProfile[4];
      add('DMRG', 'XXZ phase transition: ferromagnet separable, critical region entangled', sFerro < 0.05 && sCrit > 0.5, `S(Δ=−1.4)=${sFerro.toFixed(3)} S(Δ=0)=${sCrit.toFixed(3)}`);
    }
  }

  // --- Surface code & MWPM (Edmonds' blossom) decoder ---
  {
    // Blossom min-weight perfect matching == brute force on random complete graphs.
    const bruteMWPM = (n: number, w: number[][]): number => {
      const used = new Array(n).fill(false);
      const rec = (): number => {
        let i = 0; while (i < n && used[i]) i++;
        if (i === n) return 0;
        used[i] = true; let best = Infinity;
        for (let j = i + 1; j < n; j++) if (!used[j]) { used[j] = true; best = Math.min(best, w[i][j] + rec()); used[j] = false; }
        used[i] = false; return best;
      };
      return rec();
    };
    const rng = mulberry32(123);
    let blossomWorst = 0;
    for (let trial = 0; trial < 120; trial++) {
      const n = 2 * (1 + Math.floor(rng() * 4));
      const w: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
      const edges: Edge[] = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const x = 1 + Math.floor(rng() * 20); w[i][j] = w[j][i] = x; edges.push([i, j, x]); }
      const mate = minWeightPerfectMatching(n, edges);
      let tot = 0, perfect = true;
      for (let i = 0; i < n; i++) { if (mate[i] < 0) perfect = false; else if (i < mate[i]) tot += w[i][mate[i]]; }
      if (!perfect) blossomWorst = Infinity;
      blossomWorst = Math.max(blossomWorst, Math.abs(tot - bruteMWPM(n, w)));
    }
    add('Surface code', 'blossom MWPM matches brute force (120 random graphs)', blossomWorst === 0, `max Δ ${blossomWorst}`);

    // Code structure: d²−1 commuting stabilizers, anticommuting logicals.
    let structOk = true, commOk = true, logOk = true;
    for (const d of [3, 5, 7]) {
      const code = buildSurfaceCode(d);
      if (code.stabs.length !== d * d - 1) structOk = false;
      for (const xi of code.xStabIdx) for (const zi of code.zStabIdx) {
        const xs = new Set(code.stabs[xi].qubits); let n = 0;
        for (const q of code.stabs[zi].qubits) if (xs.has(q)) n++;
        if (n % 2 !== 0) commOk = false;
      }
      const lz = new Set(code.logicalZ); let inter = 0;
      for (const q of code.logicalX) if (lz.has(q)) inter++;
      if (inter % 2 !== 1) logOk = false;
    }
    add('Surface code', 'rotated code has d²−1 stabilizers (d=3,5,7)', structOk, '');
    add('Surface code', 'every X- and Z-check commutes', commOk, '');
    add('Surface code', 'logical X and Z anticommute (single overlap)', logOk, '');

    // The MWPM decoder corrects every error up to the code distance.
    let correctOk = true;
    for (const d of [3, 5, 7]) {
      const code = buildSurfaceCode(d);
      for (let q = 0; q < code.nData && correctOk; q++) if (correctRound(code, new Set([q]), new Set([q])).failure) correctOk = false;
      const rg = mulberry32(31 + d), t = Math.floor((d - 1) / 2);
      for (let trial = 0; trial < 80 && correctOk; trial++) {
        const e = new Set<number>(); while (e.size < t) e.add(Math.floor(rg() * code.nData));
        if (correctRound(code, e, new Set()).logicalXFailure) correctOk = false;
      }
    }
    add('Surface code', 'MWPM corrects all errors of weight ≤ ⌊(d−1)/2⌋', correctOk, '');

    // The threshold ordering: below p_th a bigger code wins, above it loses.
    const rg2 = mulberry32(99);
    const lo3 = logicalErrorRate(3, 0.04, 600, rg2), lo7 = logicalErrorRate(7, 0.04, 600, rg2);
    add('Surface code', 'below threshold (p=4%): d=7 beats d=3', lo7 < lo3, `d3=${lo3.toFixed(3)} d7=${lo7.toFixed(3)}`);
    const hi3 = logicalErrorRate(3, 0.22, 600, rg2), hi7 = logicalErrorRate(7, 0.22, 600, rg2);
    add('Surface code', 'above threshold (p=22%): d=7 worse than d=3', hi7 > hi3, `d3=${hi3.toFixed(3)} d7=${hi7.toFixed(3)}`);
  }

  // --- Space-time fault tolerance: Union-Find decoder + phenomenological noise ---
  {
    const anticom = (sup: number[], err: Set<number>): boolean => {
      let n = 0; for (const q of sup) if (err.has(q)) n++; return (n & 1) === 1;
    };

    // The Union-Find decoder corrects every error up to the code distance (code capacity).
    let ufCorrects = true;
    for (const d of [3, 5, 7]) {
      const code = buildSurfaceCode(d);
      const { graph, sector } = buildCodeCapacityGraph(code, 'Z');
      const t = Math.floor((d - 1) / 2);
      const rg = mulberry32(7 + d);
      for (let trial = 0; trial < 200 && ufCorrects; trial++) {
        const e = new Set<number>(); while (e.size < t) e.add(Math.floor(rg() * code.nData));
        const defects: number[] = [];
        sector.detGlobal.forEach((gi, l) => { let n = 0; for (const q of code.stabs[gi].qubits) if (e.has(q)) n++; if (n & 1) defects.push(l); });
        const corr = decodeUF(graph, defects);
        const res = new Set<number>(e); for (const q of corr) { if (res.has(q)) res.delete(q); else res.add(q); }
        if (anticom(sector.logicalSupport, res)) ufCorrects = false;
      }
    }
    add('Space-time FT', 'Union-Find corrects all errors of weight ≤ ⌊(d−1)/2⌋', ufCorrects, '');

    // Union-Find agrees with optimal MWPM on the logical verdict for the vast majority of
    // random errors (it is provably ≥ MWPM up to distance, near-optimal beyond).
    {
      const d = 5, code = buildSurfaceCode(d);
      const { graph, sector } = buildCodeCapacityGraph(code, 'Z');
      const rg = mulberry32(42); let agree = 0; const total = 600;
      for (let s = 0; s < total; s++) {
        const e = new Set<number>(); for (let q = 0; q < code.nData; q++) if (rg() < 0.08) e.add(q);
        const defects: number[] = [];
        sector.detGlobal.forEach((gi, l) => { let n = 0; for (const q of code.stabs[gi].qubits) if (e.has(q)) n++; if (n & 1) defects.push(l); });
        const verdict = (corr: Set<number>) => { const res = new Set<number>(e); for (const q of corr) { if (res.has(q)) res.delete(q); else res.add(q); } return anticom(sector.logicalSupport, res); };
        if (verdict(decodeMWPM(graph, defects)) === verdict(decodeUF(graph, defects))) agree++;
      }
      add('Space-time FT', 'Union-Find agrees with MWPM ≥ 90% (d=5, p=8%)', agree >= 0.9 * total, `${agree}/${total}`);
    }

    // The 3-D space-time graph: T+1 layers of the 2-D graph plus time (measurement) edges.
    {
      const code = buildSurfaceCode(5), layers = 6;
      const { graph, sector } = buildSpaceTimeGraph(code, 'Z', layers);
      const timeEdges = graph.edges.filter((e) => e.qubit < 0).length;
      const spaceEdges = graph.edges.filter((e) => e.qubit >= 0).length;
      const ok = graph.nNodes === layers * sector.nChecks
        && timeEdges === (layers - 1) * sector.nChecks
        && spaceEdges > 0;
      add('Space-time FT', 'space-time graph: layers×checks nodes + measurement-edge layer', ok,
        `nodes=${graph.nNodes} time=${timeEdges} space=${spaceEdges}`);
    }

    // Phenomenological threshold: below it a bigger code wins; above it loses (MWPM + UF).
    {
      const rg = mulberry32(99);
      const lo3 = phenomLogicalErrorRate(3, 0.015, 1000, rg, { kind: 'mwpm' });
      const lo7 = phenomLogicalErrorRate(7, 0.015, 1000, rg, { kind: 'mwpm' });
      add('Space-time FT', 'phenomenological MWPM below p_th (p=1.5%): d=7 beats d=3', lo7 < lo3, `d3=${lo3.toFixed(3)} d7=${lo7.toFixed(3)}`);
      const hi3 = phenomLogicalErrorRate(3, 0.08, 800, rg, { kind: 'mwpm' });
      const hi7 = phenomLogicalErrorRate(7, 0.08, 800, rg, { kind: 'mwpm' });
      add('Space-time FT', 'phenomenological MWPM above p_th (p=8%): d=7 worse than d=3', hi7 > hi3, `d3=${hi3.toFixed(3)} d7=${hi7.toFixed(3)}`);
      const uf3 = phenomLogicalErrorRate(3, 0.08, 800, rg, { kind: 'uf' });
      const uf7 = phenomLogicalErrorRate(7, 0.08, 800, rg, { kind: 'uf' });
      add('Space-time FT', 'phenomenological Union-Find above p_th (p=8%): d=7 worse than d=3', uf7 > uf3, `d3=${uf3.toFixed(3)} d7=${uf7.toFixed(3)}`);
    }

    // Finite-size scaling: Λ_d = p_L(d)/p_L(d+2) > 1 below threshold (the code is working).
    {
      const { pairs } = lambdaRatios({ distances: [3, 5, 7], p: 0.05, samples: 3000, seed: 1 });
      const allOver1 = pairs.every((x) => x.lambda > 1);
      add('Space-time FT', 'Λ = p_L(d)/p_L(d+2) > 1 below threshold (p=5%)', allOver1, pairs.map((x) => `d${x.d}:${x.lambda.toFixed(2)}`).join(' '));
    }

    // Universal data collapse recovers the code-capacity threshold (~10%).
    {
      const distances = [3, 5, 7], ps = [0.08, 0.09, 0.10, 0.11, 0.12, 0.13];
      const rg = mulberry32(5); const pts: { d: number; p: number; pL: number }[] = [];
      for (const d of distances) for (const p of ps) pts.push({ d, p, pL: codeCapacityRate(d, p, 1200, rg, 'mwpm') });
      const c = collapseFit(pts, { pthRange: [0.07, 0.13], nuRange: [0.8, 1.8], grid: 36 });
      add('Space-time FT', 'finite-size collapse recovers p_th ≈ 10% (code capacity)', c.pth >= 0.07 && c.pth <= 0.12, `p_th=${(c.pth * 100).toFixed(1)}% ν=${c.nu.toFixed(2)}`);
    }
  }

  // --- Free fermions (Jordan–Wigner + Bogoliubov–de Gennes) for the TFIM ---
  {
    // Exact ground energy vs the lab's own TFIM MPO dense diagonalisation. The free-fermion
    // solver works in the Hadamard-rotated convention (H = −JΣXX − hΣZ), whose spectrum is
    // identical to the lab's −JΣZZ − hΣX, so this is a true cross-engine check.
    let worstE = 0;
    for (const [n, h] of [[6, 0.5], [8, 1.0], [7, 1.6]] as [number, number][]) {
      worstE = Math.max(worstE, Math.abs(solveTFIM(n, 1, h).groundEnergy - exactGroundEnergyMPO(tfimMPO(n, 1, h))));
    }
    add('Free fermions', 'TFIM ground energy matches exact diagonalisation', worstE < 1e-9, `max err ${worstE.toExponential(1)}`);

    // Block entanglement entropy (Majorana covariance) vs the exact reduced-density-matrix
    // entropy of the lab's TFIM ground state, at every cut.
    let worstS = 0;
    for (const [n, h] of [[8, 0.7], [8, 1.0], [6, 1.5]] as [number, number][]) {
      const prof = entropyProfile(solveTFIM(n, 1, h));
      const { values, vectors } = hermitianEig(mpoToDense(tfimMPO(n, 1, h)));
      const gi = values.length - 1;
      const gs = QuantumState.fromAmplitudes(Array.from({ length: 1 << n }, (_, a) => vectors[a][gi]));
      for (let L = 1; L < n; L++) worstS = Math.max(worstS, Math.abs(prof[L - 1] - gs.entanglementEntropy(L)));
    }
    add('Free fermions', 'block entanglement entropy matches exact RDM', worstS < 1e-7, `max err ${worstS.toExponential(1)}`);

    // The quasiparticle gap closes at the quantum critical point h = J and stays open off it.
    const gCrit = solveTFIM(160, 1, 1).gap, gOff = solveTFIM(60, 1, 1.8).gap;
    add('Free fermions', 'gap closes at the critical field h = J', gCrit < 0.1 && gOff > 1, `gap(h=1)=${gCrit.toFixed(3)} gap(h=1.8)=${gOff.toFixed(2)}`);

    // The Ising central charge c = ½ from the Calabrese–Cardy entanglement scaling at h = J.
    const cFit = centralCharge(48, 1, 1, 4);
    add('Free fermions', 'critical entanglement recovers central charge c = ½', Math.abs(cFit.c - 0.5) < 0.045, `c = ${cFit.c.toFixed(4)}`);

    // Ground energy per site converges to the closed-form Pfeuty thermodynamic integral.
    const eFF = solveTFIM(220, 1, 1.3).energyPerSite, ePf = pfeutyEnergyDensity(1, 1.3);
    add('Free fermions', 'energy/site matches the Pfeuty thermodynamic limit', Math.abs(eFF - ePf) < 3e-3, `ff=${eFF.toFixed(5)} pfeuty=${ePf.toFixed(5)}`);

    // Thermal energy recovers the ground energy as T → 0.
    const solT = solveTFIM(40, 1, 0.9);
    add('Free fermions', 'thermal energy → ground energy as T → 0', Math.abs(thermalEnergyPerSite(solT, 1e-10) - solT.energyPerSite) < 1e-9, '');

    // Real-time quench: ⟨Z⟩(t) and half-chain entropy vs independent exact dense evolution.
    let wZ = 0, wQS = 0;
    for (const [n, hi, hf] of [[6, 4, 0.5], [8, 0.2, 1.5]] as [number, number, number][]) {
      const q = ffQuench(n, 1, hi, hf, 0.25, 8);
      const d = exactQuenchDense(n, 1, hi, hf, 0.25, 8);
      for (let s = 0; s <= 8; s++) { wZ = Math.max(wZ, Math.abs(q.frames[s].mZ - d[s].mZ)); wQS = Math.max(wQS, Math.abs(q.frames[s].entropy - d[s].entropy)); }
    }
    add('Free fermions', 'quench dynamics match exact dense evolution', wZ < 1e-5 && wQS < 1e-5, `⟨Z⟩ err ${wZ.toExponential(1)}, S err ${wQS.toExponential(1)}`);

    // A global quench from a near-product state (large h_i, deep in the paramagnet) grows
    // half-chain entanglement from ≈0 — the quasiparticle light-cone.
    const lc = ffQuench(24, 1, 8, 1.0, 0.2, 24);
    add('Free fermions', 'global quench grows entanglement (light-cone)', lc.frames[0].entropy < 0.02 && lc.frames[24].entropy > lc.frames[0].entropy + 0.5, `S: ${lc.frames[0].entropy.toFixed(3)} → ${lc.frames[24].entropy.toFixed(2)}`);
  }

  // --- XY model, periodic free fermions & dynamical quantum phase transitions (9.0) ---
  {
    // solveXY at γ = 1 reduces EXACTLY to the Ising solveTFIM (energy + gap).
    let wXY = 0;
    for (const [n, h] of [[20, 0.7], [32, 1.3]] as [number, number][]) {
      const a = solveXY(n, 1, h, 1), b = solveTFIM(n, 1, h);
      wXY = Math.max(wXY, Math.abs(a.groundEnergy - b.groundEnergy), Math.abs(a.gap - b.gap));
    }
    add('XY & DQPT', 'solveXY(γ=1) reduces to the Ising solveTFIM', wXY < 1e-12, `max err ${wXY.toExponential(1)}`);

    // Open XY ground energy vs an independent dense diagonalisation of the same Hamiltonian
    //   H = −J Σ [ (1+γ)/2 XᵢXᵢ₊₁ + (1−γ)/2 YᵢYᵢ₊₁ ] − h Σ Zᵢ  (open boundaries).
    const denseOpenXY = (n: number, J: number, h: number, g: number): number => {
      const N = 1 << n;
      const cxx = -J * (1 + g) / 2, cyy = -J * (1 - g) / 2;
      const H: Complex[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => C(0)));
      for (let s = 0; s < N; s++) {
        let diag = 0;
        for (let i = 0; i < n; i++) diag += -h * (((s >> i) & 1) ? -1 : 1);
        H[s][s] = H[s][s].add(C(diag));
        for (let i = 0; i + 1 < n; i++) {
          const f = s ^ (1 << i) ^ (1 << (i + 1));
          const fi = ((s >> i) & 1) ? -1 : 1, fj = ((s >> (i + 1)) & 1) ? -1 : 1;
          H[f][s] = H[f][s].add(C(cxx + cyy * -(fi * fj)));
        }
      }
      const v = hermitianEig(H).values;
      return Math.min(...v);
    };
    let wOpen = 0;
    for (const [n, h, g] of [[6, 0.8, 0.5], [8, 1.4, 0.3], [6, 0.5, 0.0]] as [number, number, number][]) {
      wOpen = Math.max(wOpen, Math.abs(solveXY(n, 1, h, g).groundEnergy - denseOpenXY(n, 1, h, g)));
    }
    add('XY & DQPT', 'open XY ground energy matches exact diagonalisation', wOpen < 1e-9, `max err ${wOpen.toExponential(1)}`);

    // THE headline cross-check: the exact finite-N Loschmidt rate (anti-periodic momentum product)
    // vs an independent dense 2ⁿ time evolution of the periodic XY chain.
    let wL = 0;
    const times = [0.3, 0.7, 1.0, 1.5, 2.0, 2.5, 3.0];
    for (const [n, hi, hf, g] of [[6, 2, 0.5, 1], [8, 2, 0.5, 1], [8, 1.8, 0.6, 0.3], [6, 0.4, 1.6, 1]] as [number, number, number, number][]) {
      const a = loschmidtFiniteN(n, 1, hi, hf, g, times);
      const b = loschmidtDense(n, 1, hi, hf, g, times);
      for (let i = 0; i < times.length; i++) wL = Math.max(wL, Math.abs(a[i] - b[i]));
    }
    add('XY & DQPT', 'Loschmidt return-rate matches exact dense evolution', wL < 1e-8, `max err ${wL.toExponential(1)}`);

    // A DQPT occurs iff the quench crosses the critical point (a critical mode exists).
    const cross = quenchCrosses(1, 2, 0.5, 1), noCross = quenchCrosses(1, 2, 1.4, 1);
    add('XY & DQPT', 'DQPT ⇔ quench crosses the critical point', cross && !noCross && criticalModes(1, 2, 0.5, 1).length === 1, `crossing=${cross}, non-crossing=${noCross}`);

    // The critical times are local maxima (cusps) of the rate function.
    const ct = criticalTimes(1, 2, 0.5, 1, 7);
    let cuspsOK = ct.length === 3;
    for (const t of ct) {
      const lm = loschmidtRate(1, 2, 0.5, 1, [t - 0.05, t, t + 0.05], 2000);
      if (!(lm[1] > lm[0] && lm[1] > lm[2])) cuspsOK = false;
    }
    add('XY & DQPT', 'rate function has cusps exactly at the critical times', cuspsOK, `t* = ${ct.map((t) => t.toFixed(3)).join(', ')}`);

    // The dynamical topological order parameter is an integer that jumps +1 at each DQPT,
    // counting 1, 2, 3, …, and is identically 0 for a non-crossing quench.
    let dtopOK = Math.abs(dtop(1, 2, 0.5, 1, 0.02).raw) < 1e-6;
    for (let i = 0; i < ct.length; i++) {
      const after = dtop(1, 2, 0.5, 1, ct[i] + 0.05).nu;
      if (after !== i + 1) dtopOK = false;
    }
    let dtopZero = true;
    for (const t of [0.5, 1.5, 3, 5, 7]) if (dtop(1, 2, 1.4, 1, t).nu !== 0) dtopZero = false;
    add('XY & DQPT', 'dynamical topological order parameter ν_D jumps 0→1→2→3', dtopOK && dtopZero, dtopOK && dtopZero ? 'integer winding, +1 per DQPT' : 'mismatch');

    // The infinite-chain ground-energy density agrees with the open-chain energy per site at large n.
    let wE = 0;
    for (const [h, g] of [[1.3, 1], [0.7, 0.5], [1.6, 0.4]] as [number, number][]) {
      wE = Math.max(wE, Math.abs(groundEnergyDensity(1, h, g) - solveXY(240, 1, h, g).energyPerSite));
    }
    add('XY & DQPT', 'thermodynamic ground-energy density vs open chain', wE < 4e-3, `max err ${wE.toExponential(1)}`);

    // Mutual information: non-negative, and for COMPLEMENTARY blocks I(A:B) = 2·S(L) (pure-state
    // identity) — ties the disjoint-region entropy machinery to the verified contiguous blockEntropy.
    const solMI = solveXY(16, 1, 1.0, 1);
    const L = 6;
    const A = Array.from({ length: L }, (_, i) => i);
    const B = Array.from({ length: 16 - L }, (_, i) => L + i);
    const Icomp = mutualInformation(solMI, A, B);
    const id = Math.abs(Icomp - 2 * blockEntropy(solMI, L));
    // And it decays: deep paramagnet ≈ 0 between two well-separated blocks, larger at criticality.
    const Ipara = mutualInformation(solveXY(24, 1, 3.0, 1), [4, 5], [16, 17]);
    const Icrit = mutualInformation(solveXY(24, 1, 1.0, 1), [4, 5], [16, 17]);
    add('XY & DQPT', 'mutual information: I(A:Ā)=2S(L), ≥0, peaks at criticality', id < 1e-9 && Ipara >= 0 && Icrit > Ipara && Ipara < 1e-4, `id ${id.toExponential(1)}, para ${Ipara.toExponential(1)} < crit ${Icrit.toFixed(3)}`);
  }

  // --- Shor's algorithm (order-finding factoring) ---
  {
    // Classical number theory the algorithm rests on.
    const ntOK = gcd(48, 36) === 12 && modpow(7, 13, 15) === 7 && modpow(2, 10, 1000) === 24
      && isPrime(97) && !isPrime(91) && perfectPower(27)?.base === 3 && perfectPower(15) === null;
    add('Shor', 'classical number theory: gcd, modpow, primality, perfect power', ntOK,
      'gcd/modpow exact, Miller–Rabin & perfect-power detection correct');

    // Multiplicative order matches brute force across many coprime (a, N).
    let ordOK = true;
    for (const N of [15, 21, 33, 35]) {
      for (let a = 2; a < N; a++) {
        if (gcd(a, N) !== 1) continue;
        const r = multiplicativeOrder(a, N);
        if (r === 0 || modpow(a, r, N) !== 1) { ordOK = false; break; }
        for (let k = 1; k < r; k++) if (modpow(a, k, N) === 1) { ordOK = false; break; }
      }
    }
    add('Shor', 'multiplicative order is the true minimal period (a^r≡1, none smaller)', ordOK);

    // Continued-fraction convergents reconstruct known rationals.
    const cv = convergents(3, 8);
    const cvOK = cv.some((c) => c.p === 3 && c.q === 8)
      && convergents(85, 256).some((c) => c.q === 3) // 85/256 ≈ 1/3
      && recoverOrder(64, 8, 7, 15) === 4 && recoverOrder(192, 8, 7, 15) === 4;
    add('Shor', 'continued fractions recover the period from a measured phase', cvOK,
      '3/8 convergents include 3/8; y/2⁸ for a=7,N=15 → r=4');

    // The genuine full-register output distribution matches the exact analytic comb to
    // machine precision — validating the whole quantum circuit (controlled modular
    // multiplication + inverse QFT) against a closed-form reference, with no knowledge of r.
    let maxErr = 0, sumErr = 0;
    for (const [a, N] of [[7, 15], [2, 15], [4, 15], [2, 21], [5, 21]] as [number, number][]) {
      const f = orderFindFull(a, N);
      const ideal = idealOrderDistribution(a, N);
      let s = 0;
      for (let y = 0; y < f.dist.length; y++) { maxErr = Math.max(maxErr, Math.abs(f.dist[y] - ideal.dist[y])); s += f.dist[y]; }
      sumErr = Math.max(sumErr, Math.abs(s - 1));
    }
    add('Shor', 'full-register QPE distribution = analytic comb (and normalised)', maxErr < 1e-9 && sumErr < 1e-9,
      `max |P_sim − P_ideal| = ${maxErr.toExponential(1)}, |Σ−1| = ${sumErr.toExponential(1)}`);

    // The iterative (1-ancilla) sampler recovers the correct order a healthy fraction of the time.
    let itOK = true, itDetail = '';
    for (const [a, N] of [[7, 15], [2, 21], [2, 33]] as [number, number][]) {
      const r = multiplicativeOrder(a, N);
      const rng = shorRng(98765);
      let good = 0; const trials = 40;
      for (let i = 0; i < trials; i++) if (orderFindIterative(a, N, rng).order === r) good++;
      if (good / trials < 0.3) itOK = false;
      itDetail += `a=${a},N=${N}: ${good}/${trials}  `;
    }
    add('Shor', 'iterative (1-ancilla) order-finding samples the right period', itOK, itDetail.trim());

    // End-to-end: Shor's algorithm actually factors composites into correct factors.
    let facOK = true, facDetail = '';
    for (const N of [15, 21, 33, 35, 39, 55]) {
      const res = shorFactor(N, { rng: shorRng(2024), maxAttempts: 40 });
      const f = res.factors;
      const good = !!f && f[0] * f[1] === N && f[0] > 1 && f[1] > 1;
      if (!good) facOK = false;
      facDetail += f ? `${N}=${f[0]}×${f[1]} ` : `${N}=✗ `;
    }
    // And the classical guards: prime → no factor, even → 2.
    facOK = facOK && shorFactor(13).factors === null && shorFactor(14).factors?.[0] === 2;
    add('Shor', "Shor's algorithm factors 15, 21, 33, 35, 39, 55 (primes rejected)", facOK, facDetail.trim());
  }

  // --- Measurement-Based Quantum Computation (the one-way quantum computer) ---
  {
    // Every named-gate / example pattern, run on the real cluster engine with random
    // inputs and random measurement outcomes, must equal an INDEPENDENT dense
    // circuit-model oracle — up to global phase — to machine precision.
    const rng = mbqcRng(12345);
    let worstEx = 1;
    for (const ex of ['h', 's', 't', 'rz', 'rx', 'u', 'cnot', 'circuit'] as ExampleId[]) {
      for (let trial = 0; trial < 24; trial++) {
        const pat = buildExample(ex, 0.3 + trial * 0.17);
        const inp = randomInput(pat.nWires, rng);
        const res = runPattern(pat, inp, rng);
        const got = res.state.amplitudes(pat.outputs);
        const want = oracleApply(pat.logical, pat.nWires, inp);
        worstEx = Math.min(worstEx, fidelity(got, want));
      }
    }
    add('MBQC', 'every measurement pattern = independent circuit oracle (H/S/T/Rz/Rx/U/CNOT/Bell)',
      worstEx > 1 - 1e-10, `min fidelity ${worstEx.toFixed(13)} over 8 patterns × 24 random inputs/outcomes`);

    // The headline property: the CORRECTED logical output is independent of which
    // random measurement outcomes occurred — i.e. measurement-driven computation is
    // deterministic once the byproduct Pauli frame is undone.
    let worstDet = 1;
    for (const ex of ['u', 'rx', 'cnot', 'circuit'] as ExampleId[]) {
      const pat = buildExample(ex, 1.1);
      const inp = randomInput(pat.nWires, mbqcRng(7));
      const base = runPattern(pat, inp, mbqcRng(1)).state.amplitudes(pat.outputs);
      for (let s = 2; s < 40; s++) {
        const other = runPattern(pat, inp, mbqcRng(s)).state.amplitudes(pat.outputs);
        worstDet = Math.min(worstDet, fidelity(base, other));
      }
    }
    add('MBQC', 'computation is deterministic up to a correctable Pauli frame (outcome-independent)',
      worstDet > 1 - 1e-10, `min fidelity ${worstDet.toFixed(13)} across 38 distinct outcome strings`);

    // Composition under load: random multi-gate two-wire circuits compile to a single
    // cluster (dozens of physical qubits) yet keep the live register tiny.
    const rng2 = mbqcRng(2024);
    let worstRand = 1, maxPhys = 0;
    for (let trial = 0; trial < 24; trial++) {
      const b = new PatternBuilder(2);
      const gates = 6 + Math.floor(rng2() * 6);
      for (let g = 0; g < gates; g++) {
        const w = rng2() < 0.5 ? 0 : 1; const pick = rng2();
        if (pick < 0.2) b.h(w); else if (pick < 0.35) b.t(w); else if (pick < 0.5) b.s(w);
        else if (pick < 0.65) b.rz(w, rng2() * 6.28); else if (pick < 0.8) b.rx(w, rng2() * 6.28);
        else b.cnot(w, w ^ 1);
      }
      const pat = b.build();
      maxPhys = Math.max(maxPhys, pat.nodes.length);
      const inp = randomInput(2, rng2);
      const res = runPattern(pat, inp, rng2);
      worstRand = Math.min(worstRand, fidelity(res.state.amplitudes(pat.outputs), oracleApply(pat.logical, 2, inp)));
    }
    add('MBQC', 'random multi-gate 2-wire circuits = oracle (cluster of dozens of qubits)',
      worstRand > 1 - 1e-10, `min fidelity ${worstRand.toFixed(13)}, up to ${maxPhys} physical qubits, live register ≤ 3`);

    // A deep single-wire chain: T^8 = identity (8 gadgets, 16 measurements).
    {
      const b = new PatternBuilder(1); for (let i = 0; i < 8; i++) b.t(0);
      const pat = b.build();
      const inp = randomInput(1, mbqcRng(3));
      const res = runPattern(pat, inp, mbqcRng(99));
      add('MBQC', 'deep chain T⁸ = I (16 adaptive measurements collapse to identity)',
        fidelity(res.state.amplitudes(pat.outputs), inp) > 1 - 1e-10);
    }

    // The cluster state really is a graph state: every generator K_v = X_v∏Z_w stabilises it.
    let worstStab = 1;
    const graphs = [
      { n: 3, edges: [[0, 1], [1, 2]] as [number, number][] },
      { n: 4, edges: [[0, 1], [1, 2], [2, 3], [3, 0]] as [number, number][] },
      { n: 5, edges: [[0, 1], [0, 2], [0, 3], [0, 4]] as [number, number][] },
    ];
    for (const g of graphs) {
      const st = clusterState(g);
      for (let v = 0; v < g.n; v++) {
        worstStab = Math.min(worstStab, pauliExpectation(st, stabilizerGenerator(g, v).paulis));
      }
    }
    add('MBQC', 'cluster states are graph states: ⟨K_v⟩ = +1 for every generator (line/ring/star)',
      worstStab > 1 - 1e-10, `min ⟨K_v⟩ = ${worstStab.toFixed(13)}`);

    // The Bell circuit (H ; CNOT) measured out gives a maximally-entangled output.
    {
      const pat = buildExample('circuit');
      const res = runPattern(pat, [{ re: 1, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }], mbqcRng(42));
      const a = res.state.amplitudes(pat.outputs);
      const p = a.map((x) => x.re * x.re + x.im * x.im);
      add('MBQC', 'Bell pattern yields P(00)=P(11)=½, P(01)=P(10)=0',
        Math.abs(p[0] - 0.5) < 1e-9 && Math.abs(p[3] - 0.5) < 1e-9 && p[1] < 1e-9 && p[2] < 1e-9,
        `p = [${p.map((x) => x.toFixed(3)).join(', ')}]`);
    }
  }

  // ── Solovay–Kitaev: compiling arbitrary gates to {H, T} + Clifford ──
  {
    const seed = (() => { let s = 0xC0FFEE >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
    const randSU2 = (maxAngle: number): SU2 => {
      const u: [number, number, number] = [seed() - 0.5, seed() - 0.5, seed() - 0.5];
      const nn = Math.hypot(u[0], u[1], u[2]);
      return su2Rot([u[0] / nn, u[1] / nn, u[2] / nn], seed() * maxAngle);
    };
    const net = getNet();

    // The SU(2) lift of each discrete gate matches its genuine U(2) matrix up to global phase.
    {
      let worst = 0;
      for (const g of GATES) {
        const M = sequenceToU2([g]);            // genuine U(2)
        const det = M[0][0].mul(M[1][1]).sub(M[0][1].mul(M[1][0]));
        const ph = Complex.fromPolar(1, det.phase() / 2);
        const su: SU2 = { a: M[0][0].div(ph), b: M[0][1].div(ph) };
        worst = Math.max(worst, Math.min(su2Dist(su, GATE_SU2[g]), su2Dist(su, su2Neg(GATE_SU2[g]))));
      }
      add('Solovay–Kitaev', 'gate SU(2) lifts match the genuine U(2) gates up to global phase', worst < 1e-12, `max err ${worst.toExponential(1)}`);
    }

    // gc-decompose: V W V† W† reconstructs Δ exactly for rotations near the identity.
    {
      let worst = 0;
      for (let t = 0; t < 200; t++) {
        const D = randSU2(0.7);
        const { V, W } = gcDecompose(D);
        const C = su2Mul(su2Mul(V, W), su2Mul(su2Dag(V), su2Dag(W)));
        worst = Math.max(worst, su2Dist(C, D));
      }
      add('Solovay–Kitaev', 'group commutator V W V† W† reconstructs Δ (200 random near-identity rotations)', worst < 1e-9, `max err ${worst.toExponential(1)}`);
    }

    // The base net is a genuine ε₀-net: a few thousand words covering SU(2) finely.
    {
      let worst = 0;
      for (let t = 0; t < 60; t++) { const U = randSU2(2 * Math.PI); worst = Math.max(worst, su2Dist(U, basicApproximation(U, net).U)); }
      add('Solovay–Kitaev', `base net (${net.length} words ≤ length 16) covers SU(2) with radius < 0.25`, net.length > 5000 && worst < 0.25, `cover radius ${worst.toFixed(3)}`);
    }

    // SK converges: depth-3 error is small, and error strictly decreases with depth.
    {
      let worst3 = 0, monotone = true;
      const targets = [rzTarget(Math.PI / 5), rxTarget(1), seededTarget(7), seededTarget(99)];
      for (const U of targets) {
        let prevErr = Infinity;
        for (let n = 0; n <= 3; n++) {
          const err = su2Dist(U, solovayKitaev(U, n, net).U);
          if (n > 0 && err > prevErr + 1e-12) monotone = false;
          prevErr = err;
          if (n === 3) worst3 = Math.max(worst3, err);
        }
      }
      add('Solovay–Kitaev', 'SK error decreases with depth and reaches < 5e-3 at depth 3 (4 targets)', monotone && worst3 < 5e-3, `worst depth-3 err ${worst3.toExponential(2)}`);
    }

    // Honest reconstruction: the compiled discrete word, multiplied out in genuine U(2),
    // reproduces the target up to a physically-irrelevant global phase.
    {
      const U = rzTarget(Math.PI / 5);
      const res = compileGate(U, 3);
      const M = sequenceToU2(res.reduced);
      const det = M[0][0].mul(M[1][1]).sub(M[0][1].mul(M[1][0]));
      const ph = Complex.fromPolar(1, det.phase() / 2);
      const su: SU2 = { a: M[0][0].div(ph), b: M[0][1].div(ph) };
      const d = Math.min(su2Dist(U, su), su2Dist(U, su2Neg(su)));
      add('Solovay–Kitaev', 'compiled {H,T} word multiplies back out to the target (genuine U(2), up to phase)', d < 5e-3 && res.length > 0, `‖word − target‖ = ${d.toExponential(2)}, ${res.length} gates, T-count ${res.tCount}`);
    }

    // A gate already in the set compiles to (near) zero error at depth 0.
    {
      const res = compileGate(GATE_SU2['T'], 0);
      add('Solovay–Kitaev', 'an exact gate (T) is found by the base net at depth 0 (error ≈ 0)', res.error < 1e-9, `err ${res.error.toExponential(1)}`);
    }
  }

  // ── Magic-state distillation: the 15-to-1 routine via the [15,11,3] Hamming code ──
  {
    // The Hamming code has the textbook weight enumerator (A₀=1, A₃=35, A₄=105, …).
    {
      const A = weightEnumerator();
      const total = A.reduce((a, b) => a + b, 0);
      add('Distillation', 'Hamming[15,11,3] code: 2048 codewords with the textbook weight enumerator',
        total === 2048 && A[0] === 1 && A[3] === 35 && A[4] === 105 && A[12] === 35 && A[15] === 1,
        `A₃=${A[3]}, A₄=${A[4]}, total ${total}`);
    }

    // The 15-to-1 routine suppresses error cubically: p_out / p³ → 35 as p → 0.
    {
      const c1 = distill(0.01).pOut / 1e-6;
      const c2 = distill(0.002).pOut / 8e-9;
      add('Distillation', 'output error suppressed cubically — p_out/p³ → 35 (the 35 weight-3 logicals)',
        Math.abs(c1 - 35) < 1.5 && Math.abs(c2 - 35) < 0.6, `p_out/p³ = ${c1.toFixed(2)} (p=.01), ${c2.toFixed(2)} (p=.002)`);
    }

    // Distillation helps below threshold and hurts above it.
    {
      const below = distill(0.02), above = distill(0.25);
      const thr = exactThreshold();
      add('Distillation', `distillable below threshold p* ≈ ${thr.toFixed(3)} (helps at 2%, hurts at 25%)`,
        below.improves && !above.improves && thr > 0.1 && thr < 0.18, `p* = ${thr.toFixed(4)}, 1/√35 = ${LEADING_THRESHOLD.toFixed(4)}`);
    }

    // Iterating the routine drives the error down super-exponentially.
    {
      const casc = distillCascade(0.05, 3);
      const monotone = casc[1].p < casc[0].p && casc[2].p < casc[1].p && casc[3].p < casc[2].p;
      add('Distillation', 'cascading rounds drive the error down doubly-exponentially (5% → 3 rounds)',
        monotone && casc[3].p < 1e-9, `5% → ${casc[1].p.toExponential(1)} → ${casc[2].p.toExponential(1)} → ${casc[3].p.toExponential(1)}`);
    }

    // The Monte-Carlo post-selected protocol agrees with the exact enumeration.
    {
      const mc = distillMonteCarlo(0.1, 400000, 7);
      const exact = distill(0.1).pOut;
      add('Distillation', 'Monte-Carlo post-selected protocol matches the exact code enumeration (p=0.1)',
        Math.abs(mc.pOut - exact) < 3e-3, `MC ${mc.pOut.toExponential(3)} vs exact ${exact.toExponential(3)} (${mc.accepted} accepted)`);
    }
  }

  // ── Two-qubit synthesis: the KAK / Cartan decomposition ──
  {
    // The synthesised {Rz,Ry,CNOT} circuit reproduces every named gate, and both local
    // layers really are single-qubit (tensor) products — the heart of the decomposition.
    {
      let worstRecon = 0, worstLoc = 0;
      for (const g of NAMED_GATES) {
        const s = synthesize(g.make());
        worstRecon = Math.max(worstRecon, s.reconError);
        worstLoc = Math.max(worstLoc, s.localityError);
      }
      add('Two-qubit synthesis', 'KAK synthesis reconstructs every named gate from {Rz, Ry, CNOT}, both layers local',
        worstRecon < 1e-9 && worstLoc < 1e-9, `worst recon ${worstRecon.toExponential(1)}, worst non-locality ${worstLoc.toExponential(1)}`);
    }

    // Reconstruction holds over a sweep of random SU(4) gates.
    {
      let worst = 0;
      for (let s = 1; s <= 64; s++) worst = Math.max(worst, synthesize(seededSU4(s * 2654435761)).reconError);
      add('Two-qubit synthesis', 'synthesis reproduces 64 random SU(4) gates to machine precision',
        worst < 1e-8, `worst reconstruction ‖circuit − U‖ = ${worst.toExponential(2)}`);
    }

    // The Weyl-chamber coordinates land on the textbook canonical classes.
    {
      const sC = synthesize(NAMED_GATES.find((g) => g.id === 'cnot')!.make()).canonCoords;
      const sS = synthesize(NAMED_GATES.find((g) => g.id === 'swap')!.make()).canonCoords;
      const sI = synthesize(NAMED_GATES.find((g) => g.id === 'iswap')!.make()).canonCoords;
      const k = Math.PI / 4;
      const near = (a: readonly number[], b: number[]) => a.every((v, i) => Math.abs(Math.abs(v) - b[i]) < 1e-6);
      add('Two-qubit synthesis', 'canonical coordinates match the textbook classes: CNOT (π/4,0,0), iSWAP (π/4,π/4,0), SWAP (π/4,π/4,π/4)',
        near(sC, [k, 0, 0]) && near(sI, [k, k, 0]) && near(sS, [k, k, k]),
        `CNOT (${sC.map((v) => (v / k).toFixed(2)).join(',')})·π/4, SWAP (${sS.map((v) => (v / k).toFixed(2)).join(',')})·π/4`);
    }

    // The optimal CNOT cost is geometric and correct for the named gates.
    {
      const counts = Object.fromEntries(NAMED_GATES.map((g) => [g.id, synthesize(g.make()).optimalCnots]));
      const ok = counts.cnot === 1 && counts.cz === 1 && counts.iswap === 2 && counts.sqrtiswap === 2
        && counts.b === 2 && counts.sqrtswap === 3 && counts.swap === 3 && counts.random === 3;
      add('Two-qubit synthesis', 'minimum CNOT count is correct: CNOT/CZ→1, iSWAP/√iSWAP/B→2, √SWAP/SWAP/generic→3',
        ok, `CNOT ${counts.cnot}, iSWAP ${counts.iswap}, B ${counts.b}, √SWAP ${counts.sqrtswap}, SWAP ${counts.swap}`);
    }

    // The Makhlin local invariants take their famous values.
    {
      const gC = makhlinInvariants(NAMED_GATES.find((g) => g.id === 'cnot')!.make());
      const gS = makhlinInvariants(NAMED_GATES.find((g) => g.id === 'swap')!.make());
      const gI = makhlinInvariants(NAMED_GATES.find((g) => g.id === 'iswap')!.make());
      const cl = (z: Complex, re: number, im: number) => Math.abs(z.re - re) < 1e-9 && Math.abs(z.im - im) < 1e-9;
      add('Two-qubit synthesis', 'Makhlin invariants: CNOT (G₁=0,G₂=1), iSWAP (G₁=0,G₂=−1), SWAP (G₁=−1,G₂=−3)',
        cl(gC.G1, 0, 0) && Math.abs(gC.G2.re - 1) < 1e-9 && cl(gI.G1, 0, 0) && Math.abs(gI.G2.re + 1) < 1e-9 && cl(gS.G1, -1, 0) && Math.abs(gS.G2.re + 3) < 1e-9,
        `CNOT G₂=${gC.G2.re.toFixed(2)}, iSWAP G₂=${gI.G2.re.toFixed(2)}, SWAP G₁=${gS.G1.re.toFixed(2)}`);
    }

    // The recovered coordinates rebuild a gate with the SAME local invariants (chirality and
    // all) — an independent, gauge-invariant check of the whole pipeline over random gates.
    {
      let worst = 0;
      for (let s = 1; s <= 64; s++) {
        const U = seededSU4(s * 40503);
        const c = synthesize(U).canonCoords;
        const mu = makhlinInvariants(U), mc = makhlinInvariants(canonicalGate(c[0], c[1], c[2]));
        worst = Math.max(worst, mu.G1.sub(mc.G1).abs() + mu.G2.sub(mc.G2).abs());
      }
      add('Two-qubit synthesis', 'recovered Weyl coordinates rebuild the same Makhlin invariants (chirality preserved)',
        worst < 1e-7, `worst |ΔG₁|+|ΔG₂| over 64 random gates = ${worst.toExponential(2)}`);
    }

    // End to end: the fully discrete {H,T,CNOT} circuit reproduces the gate; Clifford gates
    // cost zero T, a generic gate costs thousands.
    {
      const ftR = faultTolerant(seededSU4(123456789), 3);
      const ftS = faultTolerant(NAMED_GATES.find((g) => g.id === 'swap')!.make(), 3);
      add('Two-qubit synthesis', 'fault-tolerant {H,T,CNOT} compile: generic gate reproduced (≤depth-3 SK), SWAP is Clifford (0 T)',
        ftR.error < 2e-2 && ftR.tCount > 100 && ftS.tCount === 0 && ftS.error < 1e-9,
        `random: err ${ftR.error.toExponential(1)}, ${ftR.tCount} T, ${ftR.cnots} CNOT · SWAP: ${ftS.tCount} T`);
    }
  }

  return r;
}

export function testSummary(results: TestResult[]): { passed: number; total: number } {
  return { passed: results.filter((t) => t.pass).length, total: results.length };
}
