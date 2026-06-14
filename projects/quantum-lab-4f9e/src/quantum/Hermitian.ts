import { Complex, C } from './Complex';

/**
 * Eigendecomposition of a complex Hermitian matrix via the cyclic Jacobi method.
 *
 * Every density matrix and reduced density matrix in this app is Hermitian, so a
 * single robust Hermitian eigensolver powers exact von Neumann entropy, purity,
 * Schmidt spectra and density-matrix diagonalisation — no external math library.
 *
 * The algorithm repeatedly applies 2x2 unitary rotations U(p,q) that annihilate the
 * off-diagonal element (p,q) of a Hermitian block
 *
 *     [ a_pp        c     ]            c = |c| e^{iφ},  a_pp, a_qq real
 *     [ conj(c)     a_qq  ]
 *
 * by first rotating away the phase φ and then applying a real symmetric Jacobi
 * rotation. Off-diagonal mass decreases monotonically, converging to a diagonal of
 * real eigenvalues. Eigenvectors are accumulated as the product of the rotations.
 */
export interface HermitianEig {
  /** Eigenvalues, sorted descending. */
  values: number[];
  /** Eigenvectors as columns: vectors[i][k] is component i of the k-th eigenvector. */
  vectors: Complex[][];
}

export function hermitianEig(input: Complex[][], maxSweeps = 100): HermitianEig {
  const n = input.length;
  if (n === 0) return { values: [], vectors: [] };
  if (n === 1) return { values: [input[0][0].re], vectors: [[C(1)]] };

  // Working copies as separate real/imag arrays for speed and clarity.
  const are: number[][] = Array.from({ length: n }, (_, i) => input[i].map((z) => z.re));
  const aim: number[][] = Array.from({ length: n }, (_, i) => input[i].map((z) => z.im));
  // Eigenvector accumulator V, starts as identity.
  const vre: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  const vim: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));

  const offNorm = () => {
    let s = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) s += are[p][q] * are[p][q] + aim[p][q] * aim[p][q];
    }
    return Math.sqrt(2 * s);
  };

  // Each step applies the unitary J = [[c, s·e^{iα}], [-s·e^{-iα}, c]] on the (p,q)
  // subspace, where α=arg(A[p][q]) aligns the phase and (c,s) is the real Jacobi
  // rotation chosen so J† A J annihilates the (p,q) element. Because c²+s²=1 holds by
  // construction, J is *exactly* unitary for every block — including near-degenerate
  // ones — so the similarity A → J† A J preserves the trace and off-norm decreases
  // monotonically. Eigenvectors accumulate as V → V J.
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    if (offNorm() < 1e-14) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const wre = are[p][q];
        const wim = aim[p][q];
        const wabs = Math.hypot(wre, wim);
        if (wabs < 1e-300) continue;

        const app = are[p][p];
        const aqq = are[q][q];
        const tau = (aqq - app) / (2 * wabs);
        const t = Math.abs(tau) < 1e-300 ? 1 : Math.sign(tau) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const ca = wre / wabs, sa = wim / wabs; // e^{iα}

        // J entries: jpp=c, jpq=s·e^{iα}, jqp=-s·e^{-iα}, jqq=c.
        const jpp_r = c, jpp_i = 0;
        const jpq_r = s * ca, jpq_i = s * sa;
        const jqp_r = -s * ca, jqp_i = s * sa;
        const jqq_r = c, jqq_i = 0;

        // Row update: A ← J† A (rows p,q). J† has columns conj(J[*][·]).
        // (U† A)[p][k] = conj(jpp)·A[p][k] + conj(jqp)·A[q][k]
        // (U† A)[q][k] = conj(jpq)·A[p][k] + conj(jqq)·A[q][k]
        for (let k = 0; k < n; k++) {
          const apr = are[p][k], api = aim[p][k];
          const aqr = are[q][k], aqi = aim[q][k];
          // conj(jpp)=jpp_r-i jpp_i, etc.
          are[p][k] = (jpp_r * apr + jpp_i * api) + (jqp_r * aqr + jqp_i * aqi);
          aim[p][k] = (jpp_r * api - jpp_i * apr) + (jqp_r * aqi - jqp_i * aqr);
          are[q][k] = (jpq_r * apr + jpq_i * api) + (jqq_r * aqr + jqq_i * aqi);
          aim[q][k] = (jpq_r * api - jpq_i * apr) + (jqq_r * aqi - jqq_i * aqr);
        }
        // Column update: A ← A U (cols p,q).
        // (A U)[k][p] = A[k][p]·jpp + A[k][q]·jqp
        // (A U)[k][q] = A[k][p]·jpq + A[k][q]·jqq
        for (let k = 0; k < n; k++) {
          const apr = are[k][p], api = aim[k][p];
          const aqr = are[k][q], aqi = aim[k][q];
          are[k][p] = (apr * jpp_r - api * jpp_i) + (aqr * jqp_r - aqi * jqp_i);
          aim[k][p] = (apr * jpp_i + api * jpp_r) + (aqr * jqp_i + aqi * jqp_r);
          are[k][q] = (apr * jpq_r - api * jpq_i) + (aqr * jqq_r - aqi * jqq_i);
          aim[k][q] = (apr * jpq_i + api * jpq_r) + (aqr * jqq_i + aqi * jqq_r);
        }
        // Eigenvector accumulation: V ← V U (cols p,q).
        for (let k = 0; k < n; k++) {
          const vpr = vre[k][p], vpi = vim[k][p];
          const vqr = vre[k][q], vqi = vim[k][q];
          vre[k][p] = (vpr * jpp_r - vpi * jpp_i) + (vqr * jqp_r - vqi * jqp_i);
          vim[k][p] = (vpr * jpp_i + vpi * jpp_r) + (vqr * jqp_i + vqi * jqp_r);
          vre[k][q] = (vpr * jpq_r - vpi * jpq_i) + (vqr * jqq_r - vqi * jqq_i);
          vim[k][q] = (vpr * jpq_i + vpi * jpq_r) + (vqr * jqq_i + vqi * jqq_r);
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => are[b][b] - are[a][a]);
  const values = order.map((i) => are[i][i]);
  const vectors: Complex[][] = Array.from({ length: n }, (_, i) =>
    order.map((k) => new Complex(vre[i][k], vim[i][k])),
  );
  return { values, vectors };
}

/** Shannon/von Neumann entropy (base-2) of a list of eigenvalues (probabilities). */
export function vonNeumannEntropy(eigenvalues: number[]): number {
  let s = 0;
  for (const p of eigenvalues) {
    if (p > 1e-12) s -= p * Math.log2(p);
  }
  return Math.max(0, s);
}
