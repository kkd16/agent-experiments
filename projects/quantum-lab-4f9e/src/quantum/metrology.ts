import { Complex, C } from './Complex';
import { matMul, dagger, type Matrix } from './Matrix';
import { QuantumState } from './QuantumState';
import { DensityMatrix } from './DensityMatrix';
import { hermitianEig } from './Hermitian';
import { krausOps } from './noise';

/**
 * Quantum metrology — estimating a phase θ imprinted by U(θ) = e^{−iθG} as precisely as
 * quantum mechanics allows, built from scratch on the lab's existing linear-algebra engine.
 *
 * The central object is the QUANTUM FISHER INFORMATION F_Q of the probe state and the generator
 * G: it sets the QUANTUM CRAMÉR–RAO BOUND on the achievable uncertainty,
 *
 *     Δθ ≥ 1 / √(ν · F_Q),
 *
 * where ν is the number of repetitions. F_Q is an intrinsic property of the state — the most
 * information ANY measurement could extract — so it is the right yardstick for a quantum advantage.
 *
 * For N independent probes F_Q scales as N (the STANDARD QUANTUM LIMIT, Δθ ∝ 1/√N); for an
 * N-qubit GHZ "cat" probe it scales as N² (the HEISENBERG LIMIT, Δθ ∝ 1/N) — a genuine √N
 * advantage. This file proves both, the saturation of the bound by an optimal measurement, and
 * the famous fragility of the GHZ advantage under dephasing (Huelga et al.).
 *
 * Everything is anchored on the collective generator G = J_z = ½ Σ_i Z_i, which is diagonal in
 * the computational basis, so every headline number comes out an exact rational that the Tests
 * tab checks to machine precision.
 */

// ───────────────────────────── generator & probes ─────────────────────────────

/**
 * Diagonal of the collective generator G = J_z = ½ Σ_i Z_i in the computational basis.
 * Z|0⟩ = +|0⟩, Z|1⟩ = −|1⟩, so the eigenvalue on basis state b is (n − 2·popcount(b))/2.
 * (The per-qubit bit assignment is irrelevant — J_z is symmetric in the qubits.)
 */
export function jzDiagonal(n: number): number[] {
  const size = 1 << n;
  const d = new Array<number>(size);
  for (let b = 0; b < size; b++) {
    let pop = 0;
    for (let x = b; x; x >>= 1) pop += x & 1;
    d[b] = (n - 2 * pop) / 2;
  }
  return d;
}

/** N-qubit GHZ probe (|0…0⟩ + |1…1⟩)/√2 — the maximally phase-sensitive "cat" state. */
export function ghzState(n: number): QuantumState {
  const size = 1 << n;
  const amps = Array.from({ length: size }, () => C(0));
  const a = 1 / Math.SQRT2;
  amps[0] = C(a);
  amps[size - 1] = C(a);
  return QuantumState.fromAmplitudes(amps);
}

/** N independent |+⟩ probes — the optimal *separable* strategy (the standard quantum limit). */
export function productPlusState(n: number): QuantumState {
  const size = 1 << n;
  const a = 1 / Math.sqrt(size);
  return QuantumState.fromAmplitudes(Array.from({ length: size }, () => C(a)));
}

// ───────────────────────────── pure-state QFI ─────────────────────────────

/**
 * QFI of a pure state under unitary encoding: F_Q = 4·Var_ψ(G) = 4(⟨G²⟩ − ⟨G⟩²).
 * For a diagonal generator this is an exact sum over amplitudes — no eigensolver needed.
 */
export function varianceQFI(state: QuantumState, gDiag: number[]): number {
  let e = 0;
  let e2 = 0;
  const a = state.amplitudes;
  for (let i = 0; i < a.length; i++) {
    const p = a[i].abs2();
    e += p * gDiag[i];
    e2 += p * gDiag[i] * gDiag[i];
  }
  return 4 * (e2 - e * e);
}

// ───────────────────────────── mixed-state SLD QFI ─────────────────────────────

/**
 * General (open-system) quantum Fisher information of a density matrix ρ under the unitary
 * family ρ_θ = e^{−iθG} ρ e^{+iθG}, via the symmetric-logarithmic-derivative formula
 *
 *     F_Q = Σ_{i,j : λᵢ+λⱼ>0}  2 |⟨i|∂_θρ|j⟩|² / (λᵢ + λⱼ),
 *
 * with {λ, |i⟩} the eigensystem of ρ and ∂_θρ = −i[G, ρ]. For a diagonal G the derivative is
 * (∂ρ)_{ij} = −i(gᵢ − gⱼ)ρ_{ij}; by unitary covariance F_Q is θ-independent, so we evaluate at
 * θ = 0. On a pure state this reduces exactly to 4·Var(G).
 */
export function sldQFI(rho: Matrix, gDiag: number[]): number {
  const d = rho.length;
  // ∂_θρ = −i[G, ρ]  ⇒  (∂ρ)_{ij} = −i(gᵢ − gⱼ)ρ_{ij};  −i·f·(re + i·im) = f·im − i·f·re.
  const dRho: Matrix = Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => {
      const f = gDiag[i] - gDiag[j];
      const z = rho[i][j];
      return new Complex(f * z.im, -f * z.re);
    }),
  );
  const eig = hermitianEig(rho);
  const V = eig.vectors; // columns are eigenvectors: V[i][k] = component i of eigenvector k
  const lam = eig.values;
  // Rotate ∂ρ into ρ's eigenbasis: M = V† (∂ρ) V.
  const M = matMul(matMul(dagger(V), dRho), V);
  let fq = 0;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      const s = lam[i] + lam[j];
      if (s > 1e-12) fq += (2 / s) * M[i][j].abs2();
    }
  }
  return fq;
}

// ───────────────────────────── classical Fisher information ─────────────────────────────

/**
 * Classical Fisher information of a dichotomic (±1, M² = I) measurement M performed on the
 * encoded state ρ_θ = U(θ)ρU(θ)†:
 *
 *     F_C(θ) = (d⟨M⟩/dθ)² / (1 − ⟨M⟩²),
 *
 * because the two outcome probabilities are p± = (1 ± ⟨M⟩)/2. This is the information a SPECIFIC
 * readout extracts; the quantum Cramér–Rao theorem guarantees F_C(θ) ≤ F_Q for every M and θ, with
 * equality for the optimal measurement. For diagonal G the encoded matrix is
 * ρ_θ[i][k] = e^{−iθ(gᵢ−g_k)} ρ[i][k].
 */
export function cfiObservable(rho: Matrix, gDiag: number[], M: Matrix, theta: number): number {
  const d = rho.length;
  let mExp = 0; // ⟨M⟩ = Tr(ρ_θ M)
  let dExp = 0; // d⟨M⟩/dθ = Tr(∂_θρ_θ M)
  for (let i = 0; i < d; i++) {
    for (let k = 0; k < d; k++) {
      const mik = M[k][i];
      if (mik.re === 0 && mik.im === 0) continue;
      const phase = -theta * (gDiag[i] - gDiag[k]);
      const z = rho[i][k];
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      // ρ_θ[i][k] = ρ[i][k]·e^{i·phase}
      const rt = new Complex(z.re * cos - z.im * sin, z.re * sin + z.im * cos);
      mExp += rt.mul(mik).re;
      // ∂_θρ_θ[i][k] = −i(gᵢ − g_k)·ρ_θ[i][k]
      const f = gDiag[i] - gDiag[k];
      const drt = new Complex(f * rt.im, -f * rt.re);
      dExp += drt.mul(mik).re;
    }
  }
  const denom = 1 - mExp * mExp;
  if (denom < 1e-12) return 0; // measurement deterministic here ⇒ no local information
  return (dExp * dExp) / denom;
}

/** Parity observable X^⊗N (antidiagonal) — the OPTIMAL readout of a GHZ phase probe. */
export function parityX(n: number): Matrix {
  const size = 1 << n;
  const mask = size - 1;
  const M: Matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => C(0)));
  for (let i = 0; i < size; i++) M[i][i ^ mask] = C(1);
  return M;
}

/** Observable Z^⊗N (diagonal (−1)^popcount) — the *generator-basis* readout, which is useless. */
export function parityZ(n: number): Matrix {
  const size = 1 << n;
  const M: Matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => C(0)));
  for (let i = 0; i < size; i++) {
    let pop = 0;
    for (let x = i; x; x >>= 1) pop += x & 1;
    M[i][i] = C(pop & 1 ? -1 : 1);
  }
  return M;
}

// ───────────────────────────── density-matrix probes & noise ─────────────────────────────

export function ghzDensity(n: number): Matrix {
  return DensityMatrix.fromPureState(ghzState(n)).rho;
}

export function productDensity(n: number): Matrix {
  return DensityMatrix.fromPureState(productPlusState(n)).rho;
}

/** Apply independent single-qubit phase damping (T₂ dephasing) of strength λ to every qubit. */
export function dephaseEachQubit(rho: Matrix, n: number, lambda: number): Matrix {
  const dm = new DensityMatrix(n);
  dm.rho = rho.map((r) => r.map((z) => new Complex(z.re, z.im)));
  const k = krausOps('phase-damping', lambda);
  for (let q = 0; q < n; q++) dm.applyChannel(k, [q]);
  return dm.rho;
}

// ───────────────────────────── analytic limits & the CRB ─────────────────────────────

/** Standard quantum limit: N independent probes give F_Q = N (Δθ ∝ 1/√N). */
export const sqlQFI = (n: number): number => n;
/** Heisenberg limit: an N-qubit GHZ probe gives F_Q = N² (Δθ ∝ 1/N). */
export const heisenbergQFI = (n: number): number => n * n;
/** GHZ QFI under independent dephasing λ: F_Q = N²(1−λ)^N (coherence ↓ √(1−λ) per qubit). */
export const noisyGhzQFI = (n: number, lambda: number): number => n * n * Math.pow(1 - lambda, n);
/** Product-probe QFI under the same dephasing: F_Q = N(1−λ). */
export const noisyProductQFI = (n: number, lambda: number): number => n * (1 - lambda);
/** Quantum Cramér–Rao bound on the standard deviation of any unbiased estimator. */
export const crbUncertainty = (fq: number, nu = 1): number => 1 / Math.sqrt(nu * fq);
/** Metrological advantage of GHZ over product = F_Q(GHZ)/F_Q(product) = N (√N in Δθ). */
export const advantageRatio = (n: number): number => heisenbergQFI(n) / sqlQFI(n);

// ───────────────────────────── curves for the UI ─────────────────────────────

export interface ScalingPoint {
  n: number;
  sql: number; // F_Q product
  heisenberg: number; // F_Q GHZ
  dThetaSQL: number;
  dThetaHeis: number;
}

/** Δθ-vs-N for the SQL (1/√N) and Heisenberg (1/N) scalings, from the exact QFIs. */
export function scalingCurve(nMax: number, nu = 1): ScalingPoint[] {
  const out: ScalingPoint[] = [];
  for (let n = 1; n <= nMax; n++) {
    out.push({
      n,
      sql: sqlQFI(n),
      heisenberg: heisenbergQFI(n),
      dThetaSQL: crbUncertainty(sqlQFI(n), nu),
      dThetaHeis: crbUncertainty(heisenbergQFI(n), nu),
    });
  }
  return out;
}

export interface NoisePoint {
  n: number;
  ghz: number; // F_Q GHZ under dephasing
  product: number; // F_Q product under dephasing
}

/**
 * F_Q vs N for GHZ and product probes under fixed dephasing λ. GHZ starts ahead (N² vs N) but its
 * advantage is multiplied by (1−λ)^N and crosses BELOW the product line past a critical N — the
 * Huelga et al. result that Markovian dephasing erases the Heisenberg advantage.
 */
export function noiseCrossover(nMax: number, lambda: number): NoisePoint[] {
  const out: NoisePoint[] = [];
  for (let n = 1; n <= nMax; n++) {
    out.push({ n, ghz: noisyGhzQFI(n, lambda), product: noisyProductQFI(n, lambda) });
  }
  return out;
}

/** The N at which the dephased product probe overtakes the dephased GHZ probe (∞ if never). */
export function noiseCrossoverN(nMax: number, lambda: number): number {
  for (let n = 1; n <= nMax; n++) {
    if (noisyProductQFI(n, lambda) > noisyGhzQFI(n, lambda)) return n;
  }
  return Infinity;
}

export interface CfiPoint {
  theta: number;
  fcParity: number; // classical Fisher info of the X^⊗N parity readout
  fcZ: number; // classical Fisher info of the Z^⊗N generator-basis readout
  qfi: number; // the quantum bound (constant N²)
}

/**
 * Classical Fisher information of the parity readout vs the generator-basis readout across a phase
 * sweep θ ∈ (0, π/N), for the N-qubit GHZ probe. Parity saturates F_C = N² (= the QFI) everywhere;
 * the generator-basis readout extracts exactly zero.
 */
export function cfiSweep(n: number, samples = 121): CfiPoint[] {
  const rho = ghzDensity(n);
  const g = jzDiagonal(n);
  const X = parityX(n);
  const Z = parityZ(n);
  const qfi = heisenbergQFI(n);
  const out: CfiPoint[] = [];
  const tMax = Math.PI / n;
  for (let s = 0; s < samples; s++) {
    const theta = (tMax * (s + 0.5)) / samples; // avoid the endpoints where sin(Nθ)=0
    out.push({
      theta,
      fcParity: cfiObservable(rho, g, X, theta),
      fcZ: cfiObservable(rho, g, Z, theta),
      qfi,
    });
  }
  return out;
}
