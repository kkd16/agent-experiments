import { Complex, C } from './Complex';
import { hermitianEig, vonNeumannEntropy } from './Hermitian';
import { svdFlat } from './SVD';

/**
 * Exact free-fermion engine for the transverse-field Ising chain.
 *
 * The TFIM is the one non-trivial model in this lab that is *secretly free*: the
 * Jordan–Wigner transform maps the spin chain onto NON-INTERACTING fermions, so the
 * 2ⁿ-dimensional problem collapses to a quadratic fermionic Hamiltonian that
 * diagonalises in **O(n³)** — exactly, at chain lengths (n = 256) where the 2ⁿ state
 * vector cannot even be stored and DMRG only ever approximates. That makes this engine
 * an *exact oracle*: it validates the tensor-network engines (MPS/DMRG/TEBD) at scale,
 * and recovers genuine universal physics — the Ising-CFT central charge c = ½ from the
 * entanglement scaling, and the closed-form Pfeuty thermodynamic energy.
 *
 * # Convention
 * We solve  H = −J Σ XᵢXᵢ₊₁ − h Σ Zᵢ  (open boundaries). This is the standard
 * Jordan–Wigner-friendly form; the rest of the lab writes the TFIM as
 * H = −J Σ ZᵢZᵢ₊₁ − h Σ Xᵢ. The two are related by a Hadamard on every site (X↔Z), an
 * ON-SITE product unitary — so the **spectrum**, the **ground energy** and every
 * **spatial bipartite entanglement entropy** are byte-for-byte identical between the two
 * (a Hadamard on each site cannot move entanglement between regions). That is exactly
 * why this engine can be cross-checked against `exactGroundEnergyMPO` (the lab's TFIM
 * MPO) and against `QuantumState.entanglementEntropy`. Only single-site observables are
 * swapped: ⟨Zᵢ⟩ here ≙ ⟨Xᵢ⟩ (the field-direction magnetisation) in the lab's convention.
 *
 * # Method
 * Jordan–Wigner sends the open TFIM to a quadratic fermion Hamiltonian
 *   H = Σ cᵢ† Aᵢⱼ cⱼ + ½ Σ (cᵢ† Bᵢⱼ cⱼ† + h.c.) + K,
 * with A symmetric, B antisymmetric (real). Lieb–Schultz–Mattis diagonalise it with the
 * single-particle matrices φ, ψ obeying φ(A−B)(A+B) = Λ²φ. Because (A+B) = (A−B)ᵀ here,
 * setting R = A − B makes this *exactly an SVD*: R = U Σ Vᵀ gives the Bogoliubov energies
 * Λ_k = σ_k (singular values), φ = U, ψ = V — so we reuse the app's from-scratch complex
 * SVD verbatim. The many-body ground energy is E₀ = K + ½ Tr A − ½ Σ_k Λ_k (for the TFIM
 * the spin→fermion constant makes K + ½ Tr A = 0, so E₀ = −½ Σ_k Λ_k).
 *
 * Entanglement entropy of a block comes from the ground state's MAJORANA COVARIANCE
 * matrix (Peschel): for a Gaussian state it is built from the two-point functions
 * ⟨cᵢ†cⱼ⟩, ⟨cᵢcⱼ⟩, restricted to the block, and its ± eigenvalue pairs ±λ_m give
 * S = Σ_m H₂((1+λ_m)/2) — exact, O(L³), at any chain length.
 */

export interface FFSolution {
  n: number;
  J: number;
  h: number;
  /** Anisotropy γ of the XY model (γ = 1 is the transverse-field Ising chain). */
  gamma: number;
  /** Bogoliubov single-particle energies Λ_k ≥ 0, ascending (for display/gap). */
  spectrum: number[];
  /** Per-mode energies aligned with `g`/`hAmp` mode index k (SVD order). */
  modeEnergy: Float64Array;
  /** Many-body ground-state energy E₀. */
  groundEnergy: number;
  /** E₀ / n. */
  energyPerSite: number;
  /** Single-quasiparticle gap = min_k Λ_k (closes at the critical field h = J). */
  gap: number;
  /** ⟨cᵢ†cⱼ⟩ in the ground state, flat row-major n×n (real). */
  P: Float64Array;
  /** ⟨cᵢcⱼ⟩ in the ground state, flat row-major n×n (real). */
  Q: Float64Array;
  /** g[k·n+i] = (φ_{ki}+ψ_{ki})/2 — quasiparticle annihilation amplitudes. */
  g: Float64Array;
  /** h[k·n+i] = (φ_{ki}−ψ_{ki})/2 — quasiparticle creation amplitudes. */
  hAmp: Float64Array;
}

/**
 * Diagonalise the open TFIM H = −J Σ XᵢXᵢ₊₁ − h Σ Zᵢ on n sites, returning the
 * Bogoliubov spectrum, ground energy and the ground-state correlation matrices.
 * This is the γ = 1 (isotropic) point of the anisotropic XY model — see `solveXY`.
 */
export function solveTFIM(n: number, J: number, h: number): FFSolution {
  return solveXY(n, J, h, 1);
}

/**
 * Diagonalise the open **anisotropic XY chain** in a transverse field
 *   H = −J Σᵢ [ (1+γ)/2 XᵢXᵢ₊₁ + (1−γ)/2 YᵢYᵢ₊₁ ] − h Σᵢ Zᵢ      (open boundaries)
 * on n sites. γ = 1 is the transverse-field Ising chain (only XX coupling); γ = 0 is the
 * isotropic XX model; 0 < γ < 1 interpolates. The Jordan–Wigner image is again quadratic,
 * H = Σ cᵢ†Aᵢⱼcⱼ + ½Σ(cᵢ†Bᵢⱼcⱼ† + h.c.), with A symmetric and B antisymmetric. The ONLY
 * change from the Ising case is the anisotropy splitting the hopping/pairing across the bond:
 *   A[i,i] = 2h,  A[i,i±1] = −J  (hopping),  B[i,i+1] = −Jγ,  B[i+1,i] = +Jγ  (pairing).
 * So R = A − B has R[i,i] = 2h, R[i,i+1] = −J(1−γ), R[i+1,i] = −J(1+γ) — and because A is
 * symmetric and B antisymmetric, Rᵀ = A + B for ANY γ, so the Lieb–Schultz–Mattis problem is
 * still exactly the SVD R = U Σ Vᵀ. The whole correlator/entropy machinery is γ-agnostic.
 */
export function solveXY(n: number, J: number, h: number, gamma: number): FFSolution {
  const Rre = new Float64Array(n * n);
  const Rim = new Float64Array(n * n); // identically zero — R is real
  for (let i = 0; i < n; i++) Rre[i * n + i] = 2 * h;
  for (let i = 0; i + 1 < n; i++) {
    Rre[i * n + (i + 1)] = -J * (1 - gamma); // A−B upper: (−J) − (−Jγ)
    Rre[(i + 1) * n + i] = -J * (1 + gamma); // A−B lower: (−J) − (+Jγ)
  }

  const { Ure, S, Vhre } = svdFlat(Rre, Rim, n, n);
  // φ_{ki} = U[i][k] = Ure[i*n+k] ; ψ_{ki} = V[i][k] = conj(Vh[k][i]) = Vhre[k*n+i] (real).
  const g = new Float64Array(n * n);
  const hAmp = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const phi = Ure[i * n + k];
      const psi = Vhre[k * n + i];
      g[k * n + i] = (phi + psi) / 2;
      hAmp[k * n + i] = (phi - psi) / 2;
    }
  }

  // Per-mode Bogoliubov energy Λ_k = φ_kᵀ R ψ_k (since Rψ_k = σ_k φ_k and φ_kᵀφ_k = 1).
  // Computing it from each mode's OWN vectors guarantees it stays aligned with g/hAmp —
  // the time-evolution phases in a quench must attach to the right mode.
  const modeEnergy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let lam = 0;
    for (let i = 0; i < n; i++) {
      let rv = 0;
      for (let j = 0; j < n; j++) rv += Rre[i * n + j] * Vhre[k * n + j];
      lam += Ure[i * n + k] * rv;
    }
    modeEnergy[k] = Math.abs(lam);
  }

  // P_ij = Σ_k h_ki h_kj ; Q_ij = Σ_k g_ki h_kj
  const P = new Float64Array(n * n);
  const Q = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let p = 0, q = 0;
      for (let k = 0; k < n; k++) {
        p += hAmp[k * n + i] * hAmp[k * n + j];
        q += g[k * n + i] * hAmp[k * n + j];
      }
      P[i * n + j] = p;
      Q[i * n + j] = q;
    }
  }

  let sum = 0;
  for (let k = 0; k < n; k++) sum += S[k];
  const groundEnergy = -0.5 * sum;
  const spectrum = Array.from(S).sort((a, b) => a - b);

  return {
    n, J, h, gamma, spectrum,
    modeEnergy,
    groundEnergy,
    energyPerSite: groundEnergy / n,
    gap: spectrum[0],
    P, Q, g, hAmp,
  };
}

/**
 * Von Neumann entanglement entropy (bits) of an arbitrary set of fermionic modes from
 * the Majorana covariance matrix of a Gaussian state. The two-point functions are passed
 * as flat n×n real/imag buffers (imag may be null for the real ground state); `sites` is
 * the list of physical sites in the block. Used both for static blocks and for the
 * complex correlation matrices that arise after a quench.
 */
export function covarianceEntropy(
  n: number,
  Pre: Float64Array, Pim: Float64Array | null,
  Qre: Float64Array, Qim: Float64Array | null,
  sites: number[],
): number {
  const L = sites.length;
  const dim = 2 * L;
  // (M − I) is Hermitian (M_{μν} = ⟨γ_μ γ_ν⟩); its eigenvalues are the ±λ_m pairs.
  const M: Complex[][] = Array.from({ length: dim }, () => Array.from({ length: dim }, () => C(0)));
  const pr = (a: number, b: number) => Pre[a * n + b];
  const pi = (a: number, b: number) => (Pim ? Pim[a * n + b] : 0);
  const qr = (a: number, b: number) => Qre[a * n + b];
  const qi = (a: number, b: number) => (Qim ? Qim[a * n + b] : 0);

  for (let a = 0; a < L; a++) {
    for (let b = 0; b < L; b++) {
      const i = sites[a], j = sites[b];
      const d = i === j ? 1 : 0;
      // complex correlators (re, im)
      const cij: [number, number] = [qr(i, j), qi(i, j)];                 // ⟨cᵢ cⱼ⟩
      const cidj: [number, number] = [d - pr(j, i), -pi(j, i)];           // ⟨cᵢ cⱼ†⟩ = δ − ⟨cⱼ† cᵢ⟩
      const cdij: [number, number] = [pr(i, j), pi(i, j)];                // ⟨cᵢ† cⱼ⟩
      const cdidj: [number, number] = [qr(j, i), -qi(j, i)];              // ⟨cᵢ† cⱼ†⟩ = conj⟨cⱼ cᵢ⟩
      // γ_{2a}=aᵢ=cᵢ+cᵢ†, γ_{2a+1}=bᵢ=i(cᵢ†−cᵢ)
      const Maa: [number, number] = [cij[0] + cidj[0] + cdij[0] + cdidj[0], cij[1] + cidj[1] + cdij[1] + cdidj[1]];
      const tAB: [number, number] = [cidj[0] - cij[0] + cdidj[0] - cdij[0], cidj[1] - cij[1] + cdidj[1] - cdij[1]];
      const tBA: [number, number] = [cdij[0] + cdidj[0] - cij[0] - cidj[0], cdij[1] + cdidj[1] - cij[1] - cidj[1]];
      const Mbb: [number, number] = [-(cdidj[0] - cdij[0] - cidj[0] + cij[0]), -(cdidj[1] - cdij[1] - cidj[1] + cij[1])];
      const ai = 2 * a, bi = 2 * a + 1, aj = 2 * b, bj = 2 * b + 1;
      M[ai][aj] = new Complex(Maa[0] - d, Maa[1]);
      M[bi][bj] = new Complex(Mbb[0] - d, Mbb[1]);
      M[ai][bj] = new Complex(-tAB[1], tAB[0]); // i·tAB
      M[bi][aj] = new Complex(-tBA[1], tBA[0]); // i·tBA
    }
  }
  const vals = hermitianEig(M).values; // sorted descending
  let S = 0;
  for (let m = 0; m < L; m++) {
    const lam = Math.min(Math.max(vals[m], 0), 1); // the L positive partners
    const x = (1 + lam) / 2;
    S += vonNeumannEntropy([x, 1 - x]);
  }
  return S;
}

/** Entanglement entropy (bits) of the contiguous block of sites [0..L−1]. */
export function blockEntropy(sol: FFSolution, L: number): number {
  const sites = Array.from({ length: L }, (_, i) => i);
  return covarianceEntropy(sol.n, sol.P, null, sol.Q, null, sites);
}

/** Entanglement entropy at every cut 1..n−1 (block = first L sites). */
export function entropyProfile(sol: FFSolution): number[] {
  return Array.from({ length: sol.n - 1 }, (_, i) => blockEntropy(sol, i + 1));
}

/** Entanglement entropy (bits) of an arbitrary set of sites of the ground state. */
export function entropyOfSites(sol: FFSolution, sites: number[]): number {
  return covarianceEntropy(sol.n, sol.P, null, sol.Q, null, sites);
}

/**
 * Quantum **mutual information** I(A:B) = S_A + S_B − S_{A∪B} (bits) between two disjoint
 * blocks of sites of the ground state. It is non-negative, bounds all correlations between
 * the regions, and — unlike a single block's entropy — measures genuine *two-region*
 * correlation. Off criticality it decays exponentially with the gap-set separation between
 * A and B; at the quantum critical point (h = J) it decays only algebraically.
 */
export function mutualInformation(sol: FFSolution, A: number[], B: number[]): number {
  const sA = entropyOfSites(sol, A);
  const sB = entropyOfSites(sol, B);
  const sAB = entropyOfSites(sol, [...A, ...B].sort((x, y) => x - y));
  return Math.max(0, sA + sB - sAB);
}

/**
 * Mutual information between two equal blocks of width `w` as a function of the gap `d`
 * between them (A = sites [a0..a0+w), B = [a0+w+d .. a0+2w+d)), centred in an n-site chain.
 * Returns one point per separation d, for the disjoint-region correlation-decay plot.
 */
export function mutualInfoVsSeparation(sol: FFSolution, w: number): { d: number; I: number }[] {
  const n = sol.n;
  const out: { d: number; I: number }[] = [];
  for (let d = 1; 2 * w + d < n; d++) {
    const start = Math.max(0, Math.floor((n - (2 * w + d)) / 2));
    const A = Array.from({ length: w }, (_, i) => start + i);
    const B = Array.from({ length: w }, (_, i) => start + w + d + i);
    out.push({ d, I: mutualInformation(sol, A, B) });
  }
  return out;
}

/** Field-direction magnetisation ⟨Zᵢ⟩ = 1 − 2⟨cᵢ†cᵢ⟩ at every site. */
export function magnetization(sol: FFSolution): number[] {
  return Array.from({ length: sol.n }, (_, i) => 1 - 2 * sol.P[i * sol.n + i]);
}

/**
 * Closed-form thermodynamic-limit ground energy per site (Pfeuty 1970):
 *   e₀(J,h) = −(1/π) ∫₀^π √(J² + h² − 2 J h cos k) dk
 * The single-particle dispersion is ε_k = 2√(J²+h²−2Jh cos k); the gap 2|J−h| closes at
 * the quantum critical point h = J. The finite open chain converges to this as n → ∞.
 */
export function pfeutyEnergyDensity(J: number, h: number): number {
  const M = 20000;
  let integ = 0;
  for (let i = 0; i < M; i++) {
    const k = (i + 0.5) * Math.PI / M;
    integ += Math.sqrt(J * J + h * h - 2 * J * h * Math.cos(k));
  }
  integ *= Math.PI / M;
  return -integ / Math.PI;
}

/**
 * Thermal energy per site at temperature T (kʙ = 1) from the free-fermion modes:
 *   E(T)/n = −(1/2n) Σ_k Λ_k tanh(Λ_k / 2T)   (TFIM, where K + ½Tr A = 0).
 * Recovers the ground energy as T → 0 and → 0 as T → ∞.
 */
export function thermalEnergyPerSite(sol: FFSolution, T: number): number {
  if (T <= 1e-9) return sol.energyPerSite;
  let e = 0;
  for (const lam of sol.spectrum) e += lam * Math.tanh(lam / (2 * T));
  return -e / (2 * sol.n);
}

export interface CentralChargePoint { L: number; S: number; x: number; }
export interface CentralChargeFit { c: number; points: CentralChargePoint[]; }

/**
 * Recover the Ising-CFT central charge from the entanglement scaling at the critical
 * field h = J. For a block of length L at the boundary of an open critical chain, the
 * Calabrese–Cardy formula gives (in NATS):
 *   S(L) = (c/6) ln[ (2n/π) sin(πL/n) ] + const.
 * A linear fit of S (converted to nats) against x = (1/6) ln[(2n/π) sin(πL/n)] has slope
 * exactly c — which for the transverse-field Ising universality class is **½**.
 */
export function centralCharge(n: number, J = 1, h = 1, step = 2, margin = 6): CentralChargeFit {
  const sol = solveTFIM(n, J, h);
  const points: CentralChargePoint[] = [];
  for (let L = margin; L <= n - margin; L += step) {
    const sBits = blockEntropy(sol, L);
    const x = Math.log((2 * n / Math.PI) * Math.sin((Math.PI * L) / n)) / 6;
    points.push({ L, S: sBits, x });
  }
  // least-squares slope of S(nats) vs x
  const m = points.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const y = p.S * Math.LN2; // bits → nats
    sx += p.x; sy += y; sxx += p.x * p.x; sxy += p.x * y;
  }
  const c = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  return { c, points };
}
