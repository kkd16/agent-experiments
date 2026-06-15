import { Complex, C } from './Complex';
import type { Matrix } from './Matrix';
import { tensorProduct } from './Matrix';
import { GATE_X, GATE_Z, GATE_I } from './gates/single';
import { hermitianEig } from './Hermitian';
import { MPS } from './MPS';
import { QuantumState } from './QuantumState';

/**
 * Time-Evolving Block Decimation (TEBD) — real-time dynamics of a 1-D quantum
 * many-body system, run on the Matrix Product State engine.
 *
 * The model is the transverse-field Ising chain (the canonical quantum-quench system):
 *
 *     H = −J Σᵢ Zᵢ Zᵢ₊₁  −  h Σᵢ Xᵢ
 *
 * We split H into nearest-neighbour bond terms, exponentiate each 4×4 bond Hamiltonian
 * *exactly* with the app's Hermitian eigensolver (exp(−iτH) = V e^{−iτΛ} V†), and apply
 * them to the MPS in a second-order Strang (even/odd) Trotter sweep. Each two-site gate
 * is followed by an SVD truncation to bond dimension χ — so the simulation cost stays
 * O(n·steps·χ³) even as the state explores a 2ⁿ Hilbert space.
 *
 * Starting from the fully-polarised |0…0⟩ and quenching with h≠0 reproduces the famous
 * physics of a global quench: the transverse magnetisation oscillates and the half-chain
 * entanglement entropy grows *linearly* in time (a light-cone of correlations) until it
 * saturates at the bond-dimension ceiling — the precise regime where an honest, bounded-χ
 * MPS is the right tool and a 2ⁿ state vector is hopeless.
 */

export interface TEBDParams {
  n: number;
  J: number;
  h: number;
  dt: number;
  steps: number;
  maxBond: number;
}

export interface TEBDFrame {
  t: number;
  /** Half-chain von Neumann entanglement entropy (bits). */
  entropy: number;
  /** Mean ⟨Zᵢ⟩ (longitudinal magnetisation). */
  mz: number;
  /** Mean ⟨Xᵢ⟩ (transverse magnetisation). */
  mx: number;
  /** Largest bond dimension currently in the MPS. */
  maxBond: number;
  /** Cumulative discarded Schmidt weight up to this step. */
  trunc: number;
}

export interface TEBDResult {
  frames: TEBDFrame[];
  entropyProfile: number[];
}

/** exp(−iτH) for a 4×4 Hermitian bond Hamiltonian, via exact diagonalisation. */
function expBond(H: Matrix, tau: number): Matrix {
  const { values, vectors } = hermitianEig(H);
  const k = values.length;
  const out: Matrix = Array.from({ length: k }, () => Array.from({ length: k }, () => C(0)));
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      let re = 0, im = 0;
      for (let m = 0; m < k; m++) {
        const phase = -tau * values[m];
        const ec = Math.cos(phase), es = Math.sin(phase);
        // V[a][m] · (cos+i sin) · conj(V[b][m])
        const va = vectors[a][m], vb = vectors[b][m];
        // e^{iphase} where phase = -tau*lambda
        const er = ec, ei = es;
        // t1 = va * e
        const t1r = va.re * er - va.im * ei;
        const t1i = va.re * ei + va.im * er;
        // t1 * conj(vb)
        re += t1r * vb.re + t1i * vb.im;
        im += t1i * vb.re - t1r * vb.im;
      }
      out[a][b] = new Complex(re, im);
    }
  }
  return out;
}

function scaleMat(M: Matrix, s: number): Matrix {
  return M.map((row) => row.map((z) => z.scale(s)));
}
function addMat(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((z, j) => z.add(B[i][j])));
}

/** Bond Hamiltonian for the bond (i, i+1) with on-site fields shared by site degree. */
function bondHamiltonian(i: number, n: number, J: number, h: number): Matrix {
  const ZZ = tensorProduct(GATE_Z, GATE_Z);
  const XI = tensorProduct(GATE_X, GATE_I);
  const IX = tensorProduct(GATE_I, GATE_X);
  const degL = i === 0 ? 1 : 2; // bonds touching site i
  const degR = i + 1 === n - 1 ? 1 : 2;
  let H = scaleMat(ZZ, -J);
  H = addMat(H, scaleMat(XI, -h / degL));
  H = addMat(H, scaleMat(IX, -h / degR));
  return H;
}

function observables(mps: MPS, n: number): { mz: number; mx: number } {
  let mz = 0, mx = 0;
  for (let i = 0; i < n; i++) { mz += mps.expectationZ(i); mx += mps.expectationX(i); }
  return { mz: mz / n, mx: mx / n };
}

export function tebdQuench(p: TEBDParams): TEBDResult {
  const { n, J, h, dt, steps, maxBond } = p;
  const mps = new MPS(n, maxBond); // |0…0⟩

  // Precompute even/odd bond gates for full and half steps.
  const evenBonds: number[] = [], oddBonds: number[] = [];
  for (let i = 0; i + 1 < n; i++) (i % 2 === 0 ? evenBonds : oddBonds).push(i);
  const gateHalf: Record<number, Matrix> = {};
  const gateFull: Record<number, Matrix> = {};
  for (let i = 0; i + 1 < n; i++) {
    const H = bondHamiltonian(i, n, J, h);
    gateHalf[i] = expBond(H, dt / 2);
    gateFull[i] = expBond(H, dt);
  }

  const frames: TEBDFrame[] = [];
  const record = (t: number) => {
    const { mz, mx } = observables(mps, n);
    frames.push({
      t,
      entropy: mps.entropyAt(n >> 1),
      mz, mx,
      maxBond: mps.maxBondDim(),
      trunc: mps.truncationError,
    });
  };
  record(0);

  for (let step = 0; step < steps; step++) {
    // second-order Strang: even(dt/2) · odd(dt) · even(dt/2)
    for (const i of evenBonds) mps.applyTwoQubit(gateHalf[i], i, i + 1);
    for (const i of oddBonds) mps.applyTwoQubit(gateFull[i], i, i + 1);
    for (const i of evenBonds) mps.applyTwoQubit(gateHalf[i], i, i + 1);
    mps.renormalize();
    record((step + 1) * dt);
  }

  return { frames, entropyProfile: mps.entropyProfile() };
}

/**
 * Exact transverse-field-Ising evolution on the dense state vector, for cross-checking
 * the TEBD result on small chains. Returns the time series of ⟨Zₜₒₜ⟩/n and ⟨Xₜₒₜ⟩/n.
 */
export function exactTFIM(n: number, J: number, h: number, dt: number, steps: number): { mz: number; mx: number }[] {
  const size = 1 << n;
  // Build full Hamiltonian H (2ⁿ × 2ⁿ) as a dense Hermitian matrix.
  const H: Matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => C(0)));
  const addDiag = (idx: number, v: number) => { H[idx][idx] = H[idx][idx].add(C(v)); };
  for (let idx = 0; idx < size; idx++) {
    // −J Σ Zᵢ Zᵢ₊₁ (diagonal: Z eigenvalue is +1 for bit 0, −1 for bit 1)
    for (let i = 0; i + 1 < n; i++) {
      const zi = ((idx >> i) & 1) ? -1 : 1;
      const zj = ((idx >> (i + 1)) & 1) ? -1 : 1;
      addDiag(idx, -J * zi * zj);
    }
    // −h Σ Xᵢ (off-diagonal: flips bit i)
    for (let i = 0; i < n; i++) {
      const flipped = idx ^ (1 << i);
      H[idx][flipped] = H[idx][flipped].add(C(-h));
    }
  }
  const { values, vectors } = hermitianEig(H);
  // |0…0⟩ in the eigenbasis: c_m = conj(V[0][m]) (component 0 of eigenvector m)
  const series: { mz: number; mx: number }[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s * dt;
    // ψ(t)[a] = Σ_m V[a][m] e^{−i t λ_m} conj(V[0][m])
    const psi: Complex[] = Array.from({ length: size }, () => C(0));
    for (let m = 0; m < size; m++) {
      const ph = -t * values[m];
      const e = new Complex(Math.cos(ph), Math.sin(ph));
      const c0 = vectors[0][m].conj();
      const coeff = e.mul(c0);
      for (let a = 0; a < size; a++) psi[a] = psi[a].add(vectors[a][m].mul(coeff));
    }
    const st = QuantumState.fromAmplitudes(psi);
    let mz = 0, mx = 0;
    for (let i = 0; i < n; i++) {
      const [x, , z] = st.blochVector(i);
      mx += x; mz += z;
    }
    series.push({ mz: mz / n, mx: mx / n });
  }
  return series;
}
