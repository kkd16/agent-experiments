import { Complex, C } from './Complex';

/**
 * Thin singular value decomposition of a complex m×n matrix, A = U Σ V†.
 *
 * Built from scratch. The trick: the singular values/vectors of A are the eigenpairs of
 * a Gram matrix.
 *
 *   - if n ≤ m we diagonalise the small n×n Gram   G = A†A = V Σ² V†, then U = A V Σ⁻¹;
 *   - if m < n we diagonalise the small m×m Gram     G = A A† = U Σ² U†, then V† = Σ⁻¹ U† A.
 *
 * Either way we only ever eigendecompose the *smaller* Gram matrix, and the eigenvalues
 * come back sorted descending — exactly the order singular values want. Columns whose
 * singular value underflows `tol` are projected out (their vectors are otherwise
 * undetermined); harmless, and precisely what an MPS bond truncation wants.
 *
 * The core works entirely on flat Float64Array real/imag buffers with no per-element
 * object allocation — that is what makes the Matrix Product State engine fast enough to
 * run thousands of two-qubit gates interactively. A thin `svd()` wrapper exposes the
 * familiar `Complex[][]` form for the test-suite cross-checks.
 */

const TOL = 1e-12;

export interface SVDFlat {
  /** Left singular vectors, m×k row-major (re/im). */
  Ure: Float64Array; Uim: Float64Array;
  /** Singular values, descending, length k. */
  S: Float64Array;
  /** Right singular vectors V†, k×n row-major (re/im). */
  Vhre: Float64Array; Vhim: Float64Array;
  k: number;
}

/**
 * Eigendecomposition of an n×n complex Hermitian matrix held in flat row-major
 * Float64Arrays, via the cyclic complex Jacobi method (same algorithm as Hermitian.ts,
 * specialised to flat buffers with no allocation in the sweep). Eigenvalues descending;
 * eigenvectors returned as vre/vim with vre[i*n+k] = component i of the k-th vector.
 */
function eigHermitianFlat(are: Float64Array, aim: Float64Array, n: number, maxSweeps = 100) {
  const vre = new Float64Array(n * n);
  const vim = new Float64Array(n * n);
  for (let i = 0; i < n; i++) vre[i * n + i] = 1;

  const offNorm = () => {
    let s = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const idx = p * n + q;
      s += are[idx] * are[idx] + aim[idx] * aim[idx];
    }
    return Math.sqrt(2 * s);
  };

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    if (offNorm() < 1e-14) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const pq = p * n + q;
        const wre = are[pq], wim = aim[pq];
        const wabs = Math.hypot(wre, wim);
        if (wabs < 1e-300) continue;
        const app = are[p * n + p], aqq = are[q * n + q];
        const tau = (aqq - app) / (2 * wabs);
        const t = Math.abs(tau) < 1e-300 ? 1 : Math.sign(tau) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const ca = wre / wabs, sa = wim / wabs; // e^{iα}
        const jpp_r = c, jpq_r = s * ca, jpq_i = s * sa, jqp_r = -s * ca, jqp_i = s * sa, jqq_r = c;

        // Row update A ← J† A
        for (let k = 0; k < n; k++) {
          const pk = p * n + k, qk = q * n + k;
          const apr = are[pk], api = aim[pk], aqr = are[qk], aqi = aim[qk];
          are[pk] = (jpp_r * apr) + (jqp_r * aqr + jqp_i * aqi);
          aim[pk] = (jpp_r * api) + (jqp_r * aqi - jqp_i * aqr);
          are[qk] = (jpq_r * apr + jpq_i * api) + (jqq_r * aqr);
          aim[qk] = (jpq_r * api - jpq_i * apr) + (jqq_r * aqi);
        }
        // Column update A ← A J, plus eigenvector accumulation V ← V J
        for (let k = 0; k < n; k++) {
          const kp = k * n + p, kq = k * n + q;
          const apr = are[kp], api = aim[kp], aqr = are[kq], aqi = aim[kq];
          are[kp] = (apr * jpp_r) + (aqr * jqp_r - aqi * jqp_i);
          aim[kp] = (api * jpp_r) + (aqr * jqp_i + aqi * jqp_r);
          are[kq] = (apr * jpq_r - api * jpq_i) + (aqr * jqq_r);
          aim[kq] = (apr * jpq_i + api * jpq_r) + (aqi * jqq_r);
          const vpr = vre[kp], vpi = vim[kp], vqr = vre[kq], vqi = vim[kq];
          vre[kp] = (vpr * jpp_r) + (vqr * jqp_r - vqi * jqp_i);
          vim[kp] = (vpi * jpp_r) + (vqr * jqp_i + vqi * jqp_r);
          vre[kq] = (vpr * jpq_r - vpi * jpq_i) + (vqr * jqq_r);
          vim[kq] = (vpr * jpq_i + vpi * jpq_r) + (vqi * jqq_r);
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => are[b * n + b] - are[a * n + a]);
  const values = order.map((i) => are[i * n + i]);
  return { values, order, vre, vim };
}

/** Flat-buffer SVD. A is m×n row-major (Are/Aim). Returns U (m×k), S (k), V† (k×n). */
export function svdFlat(Are: Float64Array, Aim: Float64Array, m: number, n: number, tol = TOL): SVDFlat {
  if (m === 0 || n === 0) {
    return { Ure: new Float64Array(0), Uim: new Float64Array(0), S: new Float64Array(0), Vhre: new Float64Array(0), Vhim: new Float64Array(0), k: 0 };
  }
  const k = Math.min(m, n);

  if (n <= m) {
    // Gram G = A†A (n×n): G[i][j] = Σ_l conj(A[l][i]) A[l][j]
    const gre = new Float64Array(n * n), gim = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let re = 0, im = 0;
        for (let l = 0; l < m; l++) {
          const ai = l * n + i, aj = l * n + j;
          const a_r = Are[ai], a_i = Aim[ai], b_r = Are[aj], b_i = Aim[aj];
          re += a_r * b_r + a_i * b_i;
          im += a_r * b_i - a_i * b_r;
        }
        gre[i * n + j] = re; gim[i * n + j] = im;
        gre[j * n + i] = re; gim[j * n + i] = -im;
      }
    }
    const { values, order, vre, vim } = eigHermitianFlat(gre, gim, n);
    const S = new Float64Array(k);
    const Ure = new Float64Array(m * k), Uim = new Float64Array(m * k);
    const Vhre = new Float64Array(k * n), Vhim = new Float64Array(k * n);
    for (let c = 0; c < k; c++) {
      const sigma = Math.sqrt(Math.max(values[c], 0));
      S[c] = sigma;
      const ec = order[c];
      // Vh row c = conj(v_c)^T : Vh[c][r] = conj(V[r][ec])
      for (let r = 0; r < n; r++) { Vhre[c * n + r] = vre[r * n + ec]; Vhim[c * n + r] = -vim[r * n + ec]; }
      if (sigma > tol) {
        const inv = 1 / sigma;
        for (let l = 0; l < m; l++) {
          let re = 0, im = 0;
          for (let r = 0; r < n; r++) {
            const al = l * n + r, vr = r * n + ec;
            const a_r = Are[al], a_i = Aim[al], v_r = vre[vr], v_i = vim[vr];
            re += a_r * v_r - a_i * v_i;
            im += a_r * v_i + a_i * v_r;
          }
          Ure[l * k + c] = re * inv; Uim[l * k + c] = im * inv;
        }
      }
    }
    return { Ure, Uim, S, Vhre, Vhim, k };
  }

  // m < n: Gram G = A A† (m×m): G[i][j] = Σ_l A[i][l] conj(A[j][l])
  const gre = new Float64Array(m * m), gim = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      let re = 0, im = 0;
      for (let l = 0; l < n; l++) {
        const ai = i * n + l, aj = j * n + l;
        const a_r = Are[ai], a_i = Aim[ai], b_r = Are[aj], b_i = Aim[aj];
        re += a_r * b_r + a_i * b_i;
        im += a_i * b_r - a_r * b_i;
      }
      gre[i * m + j] = re; gim[i * m + j] = im;
      gre[j * m + i] = re; gim[j * m + i] = -im;
    }
  }
  const { values, order, vre, vim } = eigHermitianFlat(gre, gim, m);
  const S = new Float64Array(k);
  const Ure = new Float64Array(m * k), Uim = new Float64Array(m * k);
  const Vhre = new Float64Array(k * n), Vhim = new Float64Array(k * n);
  for (let c = 0; c < k; c++) {
    const sigma = Math.sqrt(Math.max(values[c], 0));
    S[c] = sigma;
    const ec = order[c];
    for (let l = 0; l < m; l++) { Ure[l * k + c] = vre[l * m + ec]; Uim[l * k + c] = vim[l * m + ec]; }
    if (sigma > tol) {
      const inv = 1 / sigma;
      // Vh[c][col] = (1/σ) Σ_l conj(U[l][c]) A[l][col]
      for (let col = 0; col < n; col++) {
        let re = 0, im = 0;
        for (let l = 0; l < m; l++) {
          const ul = l * m + ec, al = l * n + col;
          const u_r = vre[ul], u_i = vim[ul], a_r = Are[al], a_i = Aim[al];
          re += u_r * a_r + u_i * a_i;
          im += u_r * a_i - u_i * a_r;
        }
        Vhre[c * n + col] = re * inv; Vhim[c * n + col] = im * inv;
      }
    }
  }
  return { Ure, Uim, S, Vhre, Vhim, k };
}

export interface SVDResult {
  U: Complex[][];
  S: number[];
  Vh: Complex[][];
}

/** `Complex[][]` wrapper around the flat core (used by the verification suite). */
export function svd(A: Complex[][], tol = TOL): SVDResult {
  const m = A.length;
  const n = m === 0 ? 0 : A[0].length;
  const Are = new Float64Array(m * n), Aim = new Float64Array(m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) { Are[i * n + j] = A[i][j].re; Aim[i * n + j] = A[i][j].im; }
  const f = svdFlat(Are, Aim, m, n, tol);
  const U: Complex[][] = Array.from({ length: m }, (_, i) =>
    Array.from({ length: f.k }, (_, j) => C(f.Ure[i * f.k + j], f.Uim[i * f.k + j])));
  const Vh: Complex[][] = Array.from({ length: f.k }, (_, i) =>
    Array.from({ length: n }, (_, j) => C(f.Vhre[i * n + j], f.Vhim[i * n + j])));
  return { U, S: Array.from(f.S), Vh };
}
