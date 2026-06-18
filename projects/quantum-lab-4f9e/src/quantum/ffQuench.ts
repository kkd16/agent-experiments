import { Complex, C } from './Complex';
import { hermitianEig, vonNeumannEntropy } from './Hermitian';
import { solveTFIM, covarianceEntropy, type FFSolution } from './FreeFermion';

/**
 * Exact real-time **quantum quench** of the transverse-field Ising chain, in O(n³) per
 * time step — far past where TEBD (truncation-limited) or exact dense evolution (2ⁿ)
 * can reach. Prepare the ground state of H(J, h_i), then evolve it under a DIFFERENT
 * Hamiltonian H(J, h_f). The state stays Gaussian forever, so we never touch a 2ⁿ
 * vector: we evolve the fermionic two-point functions directly.
 *
 * In the Heisenberg picture each final-Hamiltonian Bogoliubov mode rotates by a pure
 * phase e^{−iΛ_k t}, so cⱼ(t) = Σ_i [ F_{ji}(t) cᵢ + G_{ji}(t) cᵢ† ] with F, G built from
 * the final modes. The time-dependent correlation matrices follow as four matrix
 * products of F, G against the (static) initial-state correlators P^i = ⟨cᵢ†cⱼ⟩₀,
 * Q^i = ⟨cᵢcⱼ⟩₀ — O(n³) total, no exponential of a 2ⁿ operator. Observables: the
 * field-direction magnetisation ⟨Zᵢ⟩(t) = 1 − 2 Re P_{ii}(t) and the half-chain
 * entanglement entropy from the (now complex) covariance matrix — reproducing the
 * textbook **entanglement light-cone** (linear growth, then saturation).
 */

// --- flat complex n×n matrix algebra (row-major re/im) -----------------------
interface CM { re: Float64Array; im: Float64Array; }
const zeros = (n: number): CM => ({ re: new Float64Array(n * n), im: new Float64Array(n * n) });

/** C = A·B for n×n complex matrices. */
function matmul(A: CM, B: CM, n: number): CM {
  const out = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const ar = A.re[i * n + k], ai = A.im[i * n + k];
      if (ar === 0 && ai === 0) continue;
      for (let j = 0; j < n; j++) {
        const br = B.re[k * n + j], bi = B.im[k * n + j];
        out.re[i * n + j] += ar * br - ai * bi;
        out.im[i * n + j] += ar * bi + ai * br;
      }
    }
  }
  return out;
}

/** C = A + B. */
function add(A: CM, B: CM, n: number): CM {
  const out = zeros(n);
  for (let t = 0; t < n * n; t++) { out.re[t] = A.re[t] + B.re[t]; out.im[t] = A.im[t] + B.im[t]; }
  return out;
}

/** Complex conjugate of every entry. */
function conj(A: CM, n: number): CM {
  const out = zeros(n);
  for (let t = 0; t < n * n; t++) { out.re[t] = A.re[t]; out.im[t] = -A.im[t]; }
  return out;
}

export interface QuenchFrame {
  t: number;
  /** mean field-direction magnetisation (1/n) Σ ⟨Zᵢ⟩(t). */
  mZ: number;
  /** half-chain entanglement entropy (bits). */
  entropy: number;
}

export interface QuenchResult {
  frames: QuenchFrame[];
  /** ⟨Zᵢ⟩(t) per site per frame — the spatial profile (for a light-cone heat strip). */
  zProfile: number[][];
}

/**
 * Quench the n-site chain: ground state of H(J, h_i) evolved under H(J, h_f) for
 * `steps` steps of `dt`. Returns magnetisation and half-chain entropy vs time.
 */
export function ffQuench(n: number, J: number, hi: number, hf: number, dt: number, steps: number): QuenchResult {
  const init = solveTFIM(n, J, hi);
  const fin = solveTFIM(n, J, hf);

  // Static initial-state correlators as complex matrices (real).
  const Pi: CM = { re: init.P.slice(), im: new Float64Array(n * n) };
  const Qi: CM = { re: init.Q.slice(), im: new Float64Array(n * n) };
  // QiT (transpose) and (I − PiT)
  const QiT = zeros(n), ImPiT = zeros(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    QiT.re[i * n + j] = init.Q[j * n + i];
    ImPiT.re[i * n + j] = (i === j ? 1 : 0) - init.P[j * n + i];
  }

  const half = Array.from({ length: n >> 1 }, (_, i) => i);
  const frames: QuenchFrame[] = [];
  const zProfile: number[][] = [];

  for (let s = 0; s <= steps; s++) {
    const t = s * dt;
    // Build F, G (symmetric) from the final-Hamiltonian modes.
    const F = zeros(n), G = zeros(n);
    for (let k = 0; k < n; k++) {
      const c = Math.cos(fin.modeEnergy[k] * t), sn = Math.sin(fin.modeEnergy[k] * t);
      for (let i = 0; i < n; i++) {
        const gki = fin.g[k * n + i], hki = fin.hAmp[k * n + i];
        for (let a = i; a < n; a++) {
          const gka = fin.g[k * n + a], hka = fin.hAmp[k * n + a];
          const fr = (gki * gka + hki * hka) * c;
          const fi = (-gki * gka + hki * hka) * sn;
          const gr = (gki * hka + hki * gka) * c;
          const gi = (-gki * hka + hki * gka) * sn;
          F.re[i * n + a] += fr; F.im[i * n + a] += fi;
          G.re[i * n + a] += gr; G.im[i * n + a] += gi;
          // F is symmetric in both parts; G has a symmetric real part but an
          // ANTISYMMETRIC imaginary part — so its mirror carries −gi.
          if (a !== i) { F.re[a * n + i] += fr; F.im[a * n + i] += fi; G.re[a * n + i] += gr; G.im[a * n + i] -= gi; }
        }
      }
    }
    // F is symmetric, but G is not: Gᵀ = conj(G) (its real part is symmetric, its
    // imaginary part antisymmetric). The j-row factor in the correlator sums is G_{jb} =
    // (Gᵀ)_{bj}, so the inner G must be transposed = conjugated (Gc) for a matrix product.
    const Fc = conj(F, n), Gc = conj(G, n);
    // X1 = Pi·F + QiT·Gᵀ ; X2 = Qi·F + ImPiT·Gᵀ   (Gᵀ = Gc)
    const X1 = add(matmul(Pi, F, n), matmul(QiT, Gc, n), n);
    const X2 = add(matmul(Qi, F, n), matmul(ImPiT, Gc, n), n);
    // P(t) = Fc·X1 + Gc·X2 ; Q(t) = F·X2 + G·X1
    const Pt = add(matmul(Fc, X1, n), matmul(Gc, X2, n), n);
    const Qt = add(matmul(F, X2, n), matmul(G, X1, n), n);

    const zs: number[] = [];
    let mZ = 0;
    for (let i = 0; i < n; i++) { const z = 1 - 2 * Pt.re[i * n + i]; zs.push(z); mZ += z; }
    const entropy = covarianceEntropy(n, Pt.re, Pt.im, Qt.re, Qt.im, half);
    frames.push({ t, mZ: mZ / n, entropy });
    zProfile.push(zs);
  }
  return { frames, zProfile };
}

/**
 * Independent dense reference for the quench (n ≤ ~9): build the 2ⁿ Hamiltonians for
 * H = −J Σ XᵢXᵢ₊₁ − h Σ Zᵢ, take the exact ground state of H(J,h_i), evolve it under
 * H(J,h_f) by exact diagonalisation, and read off ⟨Z⟩ and the half-chain entropy at each
 * step. Shares NO code with the free-fermion path — the cross-check the engine is graded
 * against in the self-test suite.
 */
export function exactQuenchDense(n: number, J: number, hi: number, hf: number, dt: number, steps: number): { mZ: number; entropy: number }[] {
  const N = 1 << n;
  const build = (h: number): Complex[][] => {
    const H: Complex[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => C(0)));
    for (let s = 0; s < N; s++) {
      let diag = 0;
      for (let i = 0; i < n; i++) diag += -h * (((s >> i) & 1) ? -1 : 1); // −h Σ Zᵢ
      H[s][s] = H[s][s].add(C(diag));
      for (let i = 0; i + 1 < n; i++) {
        const u = s ^ (1 << i) ^ (1 << (i + 1)); // −J Σ XᵢXᵢ₊₁ flips bits i, i+1
        H[u][s] = H[u][s].add(C(-J));
      }
    }
    return H;
  };
  const ei = hermitianEig(build(hi));
  const gi = ei.values.length - 1; // smallest eigenvalue (ascending index from the end)
  const psi0 = ei.vectors.map((row) => row[gi]); // ground state of H_i
  const ef = hermitianEig(build(hf));
  // overlaps ⟨m|ψ₀⟩
  const ov = ef.values.map((_, m) => {
    let re = 0, im = 0;
    for (let a = 0; a < N; a++) { const v = ef.vectors[a][m]; re += v.re * psi0[a].re + v.im * psi0[a].im; im += v.re * psi0[a].im - v.im * psi0[a].re; }
    return new Complex(re, im);
  });

  const out: { mZ: number; entropy: number }[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s * dt;
    const psi: Complex[] = Array.from({ length: N }, () => C(0));
    for (let m = 0; m < N; m++) {
      const ph = -ef.values[m] * t;
      const e = new Complex(Math.cos(ph), Math.sin(ph)).mul(ov[m]);
      for (let a = 0; a < N; a++) psi[a] = psi[a].add(ef.vectors[a][m].mul(e));
    }
    let mZ = 0;
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let a = 0; a < N; a++) z += psi[a].abs2() * (((a >> i) & 1) ? -1 : 1);
      mZ += z;
    }
    // half-chain entropy: block = qubits [0..L−1]
    const L = n >> 1, bl = 1 << L, env = 1 << (n - L);
    const rho: Complex[][] = Array.from({ length: bl }, () => Array.from({ length: bl }, () => C(0)));
    for (let x = 0; x < bl; x++) for (let y = 0; y < bl; y++) {
      let re = 0, im = 0;
      for (let e = 0; e < env; e++) {
        const ix = x | (e << L), iy = y | (e << L);
        re += psi[ix].re * psi[iy].re + psi[ix].im * psi[iy].im;
        im += psi[ix].im * psi[iy].re - psi[ix].re * psi[iy].im;
      }
      rho[x][y] = new Complex(re, im);
    }
    out.push({ mZ: mZ / n, entropy: vonNeumannEntropy(hermitianEig(rho).values.map((v) => Math.max(v, 0))) });
  }
  return out;
}

/** Re-export for convenience in labs/tests. */
export type { FFSolution };
