import { Complex, C } from './Complex';
import type { Matrix } from './Matrix';
import { svdFlat } from './SVD';
import { vonNeumannEntropy } from './Hermitian';
import type { GateOp } from './QuantumState';
import { gateMatrixFor } from './gateMatrix';
import { getSingleGateMatrix } from './gates/single';

/**
 * Matrix Product State (MPS) simulator — a fourth, *tensor-network* simulation
 * paradigm built from scratch, alongside the state-vector, density-matrix and
 * stabilizer engines.
 *
 * A pure state of n qubits is written as a chain of rank-3 tensors
 *
 *     |ψ⟩ = Σ  A⁰[a₀] A¹[a₁] … Aⁿ⁻¹[aₙ₋₁] · |a₀ a₁ … aₙ₋₁⟩
 *
 * where each Aˢ is a (χₛ × 2 × χₛ₊₁) tensor and χ is the *bond dimension* — the rank of
 * the Schmidt decomposition across that cut. For a product state χ=1 everywhere; for a
 * volume-law state χ grows like 2^(n/2) and the MPS is no cheaper than the full vector.
 * But an enormous and important class of states — anything with bounded entanglement:
 * GHZ/cluster/graph states, gapped 1-D ground states, shallow circuits — has χ that
 * stays small, and there the MPS stores the state in O(n·χ²) numbers and applies a gate
 * in O(χ³) time. That is how this engine simulates 40-qubit circuits the 2ⁿ state vector
 * can never hold.
 *
 * Two-qubit gates are applied by contracting the two tensors, applying the gate, and
 * re-splitting with an SVD whose smallest Schmidt values are truncated to a chosen
 * maximum bond dimension χ_max — a controlled, *quantifiable* approximation. The bond
 * singular values ARE the Schmidt coefficients, so the entanglement entropy across any
 * cut falls straight out, and perfect (uncorrelated) sampling is one sequential sweep.
 *
 * Tensors are held in flat Float64Array re/im buffers (index(l,p,r) = (l·2+p)·dr+r) so
 * the inner contraction and SVD loops never allocate — fast enough for thousands of
 * gates interactively. Site s carries qubit s (qubit q ↔ bit q, matching the
 * state-vector engine's little-endian convention) so reconstructed amplitudes line up
 * byte-for-byte with `QuantumState` for cross-checking.
 */

interface SiteTensor {
  dl: number;
  dr: number;
  re: Float64Array; // index (l*2 + p)*dr + r
  im: Float64Array;
}

const SVD_TOL = 1e-12;

export class MPS {
  readonly n: number;
  maxBond: number;
  private sites: SiteTensor[];
  /** Orthogonality centre: sites < centre are left-canonical, sites > centre right-canonical. */
  private centre: number;
  /** Cumulative discarded Schmidt weight Σσ² from every truncating split. */
  truncationError = 0;

  constructor(n: number, maxBond = 64) {
    this.n = n;
    this.maxBond = maxBond;
    this.centre = 0;
    this.sites = Array.from({ length: n }, () => ({
      dl: 1, dr: 1,
      re: Float64Array.from([1, 0]), // |0⟩
      im: new Float64Array(2),
    }));
  }

  bondDims(): number[] {
    return [1, ...this.sites.map((t) => t.dr)];
  }

  maxBondDim(): number {
    return Math.max(...this.sites.map((t) => t.dr), 1);
  }

  /** Number of complex parameters stored, vs the 2ⁿ a dense vector would need. */
  paramCount(): number {
    return this.sites.reduce((s, t) => s + t.dl * 2 * t.dr, 0);
  }

  // ---- single-qubit gate: contract on the physical leg, O(χ²) ----------------------
  applySingle(g: Matrix, site: number): void {
    const t = this.sites[site];
    const g00r = g[0][0].re, g00i = g[0][0].im, g01r = g[0][1].re, g01i = g[0][1].im;
    const g10r = g[1][0].re, g10i = g[1][0].im, g11r = g[1][1].re, g11i = g[1][1].im;
    const re = t.re, im = t.im, dr = t.dr;
    for (let l = 0; l < t.dl; l++) {
      for (let r = 0; r < dr; r++) {
        const i0 = (l * 2 + 0) * dr + r, i1 = (l * 2 + 1) * dr + r;
        const a0r = re[i0], a0i = im[i0], a1r = re[i1], a1i = im[i1];
        re[i0] = g00r * a0r - g00i * a0i + g01r * a1r - g01i * a1i;
        im[i0] = g00r * a0i + g00i * a0r + g01r * a1i + g01i * a1r;
        re[i1] = g10r * a0r - g10i * a0i + g11r * a1r - g11i * a1i;
        im[i1] = g10r * a0i + g10i * a0r + g11r * a1i + g11i * a1r;
      }
    }
  }

  /** Number of leading singular values to keep (prefix; S is descending) and book-keeping. */
  private chooseRank(S: Float64Array, cap: number): number {
    let total = 0;
    for (let i = 0; i < S.length; i++) total += S[i] * S[i];
    if (total === 0) return 1;
    const thresh = SVD_TOL * SVD_TOL * total;
    let chi = 0;
    while (chi < S.length && chi < cap && S[chi] * S[chi] >= thresh) chi++;
    if (chi === 0) chi = 1;
    let discarded = 0;
    for (let i = chi; i < S.length; i++) discarded += S[i] * S[i];
    this.truncationError += discarded / total;
    return chi;
  }

  // ---- canonical-form gauge moves ---------------------------------------------------
  /** Move the centre right via an SVD; returns the Schmidt spectrum of that bond. */
  private splitRight(cap = Infinity): Float64Array {
    const s = this.centre;
    const t = this.sites[s];
    const rows = t.dl * 2, cols = t.dr;
    // reshape A (dl,2,dr) → matrix (dl*2) × dr (already row-major in this layout)
    const f = svdFlat(t.re, t.im, rows, cols, SVD_TOL);
    const chi = this.chooseRank(f.S, cap);
    const k = f.k;

    // new A_s = U[:, :chi]  (dl,2,chi) left-canonical
    const are = new Float64Array(t.dl * 2 * chi), aim = new Float64Array(t.dl * 2 * chi);
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < chi; c++) { are[row * chi + c] = f.Ure[row * k + c]; aim[row * chi + c] = f.Uim[row * k + c]; }
    }
    this.sites[s] = { dl: t.dl, dr: chi, re: are, im: aim };

    // fold (S·Vh) into the left bond of site s+1:  next'[c,q,r] = Σ_m (S[c]Vh[c][m]) next[m,q,r]
    const next = this.sites[s + 1];
    const nd = next.dr;
    const nre = new Float64Array(chi * 2 * nd), nim = new Float64Array(chi * 2 * nd);
    for (let c = 0; c < chi; c++) {
      const sig = f.S[c];
      for (let q = 0; q < 2; q++) {
        for (let r = 0; r < nd; r++) {
          let accr = 0, acci = 0;
          for (let m = 0; m < next.dl; m++) {
            const svr = sig * f.Vhre[c * cols + m], svi = sig * f.Vhim[c * cols + m];
            const ni = (m * 2 + q) * nd + r, br = next.re[ni], bi = next.im[ni];
            accr += svr * br - svi * bi;
            acci += svr * bi + svi * br;
          }
          nre[(c * 2 + q) * nd + r] = accr; nim[(c * 2 + q) * nd + r] = acci;
        }
      }
    }
    this.sites[s + 1] = { dl: chi, dr: nd, re: nre, im: nim };
    this.centre = s + 1;
    return f.S.slice(0, chi);
  }

  /** Move the centre left via an SVD; returns the Schmidt spectrum of that bond. */
  private splitLeft(cap = Infinity): Float64Array {
    const s = this.centre;
    const t = this.sites[s];
    const rows = t.dl, cols = 2 * t.dr, dr = t.dr;
    // reshape A (dl,2,dr) → matrix dl × (2*dr), col = p*dr + r
    const Mre = new Float64Array(rows * cols), Mim = new Float64Array(rows * cols);
    for (let l = 0; l < rows; l++) {
      for (let p = 0; p < 2; p++) {
        for (let r = 0; r < dr; r++) {
          const src = (l * 2 + p) * dr + r, dst = l * cols + (p * dr + r);
          Mre[dst] = t.re[src]; Mim[dst] = t.im[src];
        }
      }
    }
    const f = svdFlat(Mre, Mim, rows, cols, SVD_TOL);
    const chi = this.chooseRank(f.S, cap);
    const k = f.k;

    // new A_s = Vh[:chi, :] reshaped (chi,2,dr) right-canonical
    const are = new Float64Array(chi * 2 * dr), aim = new Float64Array(chi * 2 * dr);
    for (let c = 0; c < chi; c++) {
      for (let p = 0; p < 2; p++) {
        for (let r = 0; r < dr; r++) {
          const col = p * dr + r;
          are[(c * 2 + p) * dr + r] = f.Vhre[c * cols + col];
          aim[(c * 2 + p) * dr + r] = f.Vhim[c * cols + col];
        }
      }
    }
    this.sites[s] = { dl: chi, dr, re: are, im: aim };

    // fold (U·S) into the right bond of site s-1: prev'[l,p,c] = Σ_m prev[l,p,m] (U[m][c]S[c])
    const prev = this.sites[s - 1];
    const pre = new Float64Array(prev.dl * 2 * chi), pim = new Float64Array(prev.dl * 2 * chi);
    for (let l = 0; l < prev.dl; l++) {
      for (let p = 0; p < 2; p++) {
        for (let c = 0; c < chi; c++) {
          let accr = 0, acci = 0;
          const sig = f.S[c];
          for (let m = 0; m < prev.dr; m++) {
            const ur = f.Ure[m * k + c] * sig, ui = f.Uim[m * k + c] * sig;
            const pi = (l * 2 + p) * prev.dr + m, ar = prev.re[pi], ai = prev.im[pi];
            accr += ar * ur - ai * ui;
            acci += ar * ui + ai * ur;
          }
          pre[(l * 2 + p) * chi + c] = accr; pim[(l * 2 + p) * chi + c] = acci;
        }
      }
    }
    this.sites[s - 1] = { dl: prev.dl, dr: chi, re: pre, im: pim };
    this.centre = s - 1;
    return f.S.slice(0, chi);
  }

  moveCentre(target: number): void {
    while (this.centre < target) this.splitRight();
    while (this.centre > target) this.splitLeft();
  }

  normSq(): number {
    const t = this.sites[this.centre];
    let s = 0;
    for (let i = 0; i < t.re.length; i++) s += t.re[i] * t.re[i] + t.im[i] * t.im[i];
    return s;
  }

  renormalize(): void {
    const norm = Math.sqrt(this.normSq());
    if (norm > 1e-300) {
      const t = this.sites[this.centre];
      const inv = 1 / norm;
      for (let i = 0; i < t.re.length; i++) { t.re[i] *= inv; t.im[i] *= inv; }
    }
  }

  // ---- two-qubit gate on adjacent sites (lo, lo+1) ---------------------------------
  /** `g` is indexed by (bit_lo << 1) | bit_hi. Truncates to `maxBond`. */
  private applyAdjacent(lo: number, g: Matrix): void {
    this.moveCentre(lo);
    const A = this.sites[lo], B = this.sites[lo + 1];
    const dl = A.dl, dmid = A.dr, dr = B.dr;
    const gre = new Float64Array(16), gim = new Float64Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { gre[i * 4 + j] = g[i][j].re; gim[i * 4 + j] = g[i][j].im; }

    const rows = dl * 2, cols = 2 * dr;
    const Mre = new Float64Array(rows * cols), Mim = new Float64Array(rows * cols);
    const thr = new Float64Array(4), thi = new Float64Array(4);
    for (let l = 0; l < dl; l++) {
      for (let r = 0; r < dr; r++) {
        // raw theta over (p,q): θ[(p<<1)|q] = Σ_m A[l,p,m] B[m,q,r]
        thr.fill(0); thi.fill(0);
        for (let p = 0; p < 2; p++) {
          for (let q = 0; q < 2; q++) {
            let accr = 0, acci = 0;
            for (let m = 0; m < dmid; m++) {
              const ai = (l * 2 + p) * dmid + m, bi = (m * 2 + q) * dr + r;
              const ar = A.re[ai], aii = A.im[ai], br = B.re[bi], bii = B.im[bi];
              accr += ar * br - aii * bii;
              acci += ar * bii + aii * br;
            }
            thr[(p << 1) | q] = accr; thi[(p << 1) | q] = acci;
          }
        }
        // apply gate: θ'[(p'<<1)|q'] = Σ g[..][..] θ[..]
        for (let pp = 0; pp < 2; pp++) {
          for (let qq = 0; qq < 2; qq++) {
            const gi = ((pp << 1) | qq) * 4;
            let vr = 0, vi = 0;
            for (let idx = 0; idx < 4; idx++) {
              vr += gre[gi + idx] * thr[idx] - gim[gi + idx] * thi[idx];
              vi += gre[gi + idx] * thi[idx] + gim[gi + idx] * thr[idx];
            }
            const dst = (l * 2 + pp) * cols + (qq * dr + r);
            Mre[dst] = vr; Mim[dst] = vi;
          }
        }
      }
    }
    const f = svdFlat(Mre, Mim, rows, cols, SVD_TOL);
    const chi = this.chooseRank(f.S, this.maxBond);
    const k = f.k;

    const are = new Float64Array(dl * 2 * chi), aim = new Float64Array(dl * 2 * chi);
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < chi; c++) { are[row * chi + c] = f.Ure[row * k + c]; aim[row * chi + c] = f.Uim[row * k + c]; }
    }
    const bre = new Float64Array(chi * 2 * dr), bim = new Float64Array(chi * 2 * dr);
    for (let c = 0; c < chi; c++) {
      const sig = f.S[c];
      for (let q = 0; q < 2; q++) {
        for (let r = 0; r < dr; r++) {
          const col = q * dr + r;
          bre[(c * 2 + q) * dr + r] = sig * f.Vhre[c * cols + col];
          bim[(c * 2 + q) * dr + r] = sig * f.Vhim[c * cols + col];
        }
      }
    }
    this.sites[lo] = { dl, dr: chi, re: are, im: aim };
    this.sites[lo + 1] = { dl: chi, dr, re: bre, im: bim };
    this.centre = lo + 1;
  }

  private static bitSwap(g: Matrix): Matrix {
    const perm = [0, 2, 1, 3];
    return Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => g[perm[i]][perm[j]]));
  }

  private static readonly SWAP: Matrix = [
    [C(1), C(0), C(0), C(0)],
    [C(0), C(0), C(1), C(0)],
    [C(0), C(1), C(0), C(0)],
    [C(0), C(0), C(0), C(1)],
  ];

  /**
   * Apply a two-qubit gate to arbitrary (possibly distant) qubits q0,q1. The gate is
   * indexed by (bit_q0 << 1) | bit_q1. Distant pairs are brought adjacent with a SWAP
   * network and restored afterwards.
   */
  applyTwoQubit(g: Matrix, q0: number, q1: number): void {
    const lo = Math.min(q0, q1), hi = Math.max(q0, q1);
    const q0Lo = q0 === lo;
    if (hi - lo === 1) { this.applyAdjacent(lo, q0Lo ? g : MPS.bitSwap(g)); return; }
    for (let j = hi - 1; j >= lo + 1; j--) this.applyAdjacent(j, MPS.SWAP);
    this.applyAdjacent(lo, q0Lo ? g : MPS.bitSwap(g));
    for (let j = lo + 1; j <= hi - 1; j++) this.applyAdjacent(j, MPS.SWAP);
  }

  applyGate(op: GateOp): void {
    if (op.qubits.length === 1) {
      const g = getSingleGateMatrix(op.name, op.params);
      if (g) this.applySingle(g, op.qubits[0]);
      return;
    }
    if (op.qubits.length === 2) {
      const g = gateMatrixFor(op);
      if (g) {
        this.applyTwoQubit(g, op.qubits[0], op.qubits[1]);
        if (this.maxBond < Infinity) this.renormalize();
        return;
      }
    }
    throw new Error(`MPS engine supports 1- and 2-qubit gates only (got ${op.name} on ${op.qubits.length})`);
  }

  applyCircuit(ops: GateOp[]): void {
    for (const op of ops) this.applyGate(op);
  }

  // ---- observables & read-out ------------------------------------------------------
  /** Amplitude ⟨a₀a₁…|ψ⟩ for a basis bitstring (bits[s] is the value at site s). */
  amplitude(bits: number[]): Complex {
    let vr = [1], vi = [0];
    for (let s = 0; s < this.n; s++) {
      const t = this.sites[s];
      const p = bits[s];
      const nr = new Array(t.dr).fill(0), ni = new Array(t.dr).fill(0);
      for (let r = 0; r < t.dr; r++) {
        let ar = 0, ai = 0;
        for (let l = 0; l < t.dl; l++) {
          const idx = (l * 2 + p) * t.dr + r;
          ar += vr[l] * t.re[idx] - vi[l] * t.im[idx];
          ai += vr[l] * t.im[idx] + vi[l] * t.re[idx];
        }
        nr[r] = ar; ni[r] = ai;
      }
      vr = nr; vi = ni;
    }
    return new Complex(vr[0], vi[0]);
  }

  /** Dense state vector (only for small n) in the engine's little-endian convention. */
  toStateVector(): Complex[] {
    const size = 1 << this.n;
    const out: Complex[] = [];
    const bits = new Array(this.n).fill(0);
    for (let idx = 0; idx < size; idx++) {
      for (let s = 0; s < this.n; s++) bits[s] = (idx >> s) & 1;
      out[idx] = this.amplitude(bits);
    }
    return out;
  }

  /** Schmidt spectrum (descending, normalised) across the bond left of `site`. */
  schmidtSpectrum(site: number): number[] {
    if (site <= 0 || site >= this.n) return [1];
    this.moveCentre(site - 1);
    const S = this.splitRight();
    let nrm = 0; for (let i = 0; i < S.length; i++) nrm += S[i] * S[i];
    nrm = Math.sqrt(nrm) || 1;
    return Array.from(S, (s) => s / nrm);
  }

  entropyAt(site: number): number {
    const s = this.schmidtSpectrum(site);
    return vonNeumannEntropy(s.map((x) => x * x));
  }

  /** Entanglement entropy across every internal cut, in one sweep. */
  entropyProfile(): number[] {
    this.moveCentre(0);
    const out: number[] = [];
    for (let b = 0; b < this.n - 1; b++) {
      const S = this.splitRight();
      let nrm = 0; for (let i = 0; i < S.length; i++) nrm += S[i] * S[i];
      nrm = nrm || 1;
      out.push(vonNeumannEntropy(Array.from(S, (x) => (x * x) / nrm)));
    }
    return out;
  }

  expectationZ(site: number): number {
    this.moveCentre(site);
    const t = this.sites[site];
    let acc = 0;
    for (let l = 0; l < t.dl; l++) {
      for (let r = 0; r < t.dr; r++) {
        const i0 = (l * 2 + 0) * t.dr + r, i1 = (l * 2 + 1) * t.dr + r;
        acc += t.re[i0] * t.re[i0] + t.im[i0] * t.im[i0] - t.re[i1] * t.re[i1] - t.im[i1] * t.im[i1];
      }
    }
    return acc / this.normSq();
  }

  expectationX(site: number): number {
    this.moveCentre(site);
    const t = this.sites[site];
    let acc = 0;
    for (let l = 0; l < t.dl; l++) {
      for (let r = 0; r < t.dr; r++) {
        const i0 = (l * 2 + 0) * t.dr + r, i1 = (l * 2 + 1) * t.dr + r;
        acc += 2 * (t.re[i0] * t.re[i1] + t.im[i0] * t.im[i1]);
      }
    }
    return acc / this.normSq();
  }

  /** Perfect (exact, uncorrelated) sampling of one outcome in O(n·χ²). */
  sample(): number[] {
    this.moveCentre(0);
    const bits: number[] = [];
    let lr = [1], li = [0];
    for (let s = 0; s < this.n; s++) {
      const t = this.sites[s];
      const wr: number[][] = [new Array(t.dr).fill(0), new Array(t.dr).fill(0)];
      const wi: number[][] = [new Array(t.dr).fill(0), new Array(t.dr).fill(0)];
      const prob = [0, 0];
      for (let p = 0; p < 2; p++) {
        for (let r = 0; r < t.dr; r++) {
          let ar = 0, ai = 0;
          for (let l = 0; l < t.dl; l++) {
            const idx = (l * 2 + p) * t.dr + r;
            ar += lr[l] * t.re[idx] - li[l] * t.im[idx];
            ai += lr[l] * t.im[idx] + li[l] * t.re[idx];
          }
          wr[p][r] = ar; wi[p][r] = ai;
          prob[p] += ar * ar + ai * ai;
        }
      }
      const tot = prob[0] + prob[1] || 1;
      const outcome = Math.random() < prob[0] / tot ? 0 : 1;
      bits.push(outcome);
      const inv = 1 / Math.sqrt(prob[outcome] || 1);
      lr = wr[outcome].map((x) => x * inv);
      li = wi[outcome].map((x) => x * inv);
    }
    return bits;
  }

  sampleCounts(shots: number): Map<number, number> {
    const counts = new Map<number, number>();
    for (let i = 0; i < shots; i++) {
      const bits = this.sample();
      let idx = 0;
      for (let s = 0; s < this.n; s++) idx |= bits[s] << s;
      counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    return counts;
  }
}

/** Build an MPS by replaying a circuit at a chosen maximum bond dimension. */
export function simulateMPS(n: number, ops: GateOp[], maxBond = 64): MPS {
  const mps = new MPS(n, maxBond);
  mps.applyCircuit(ops);
  return mps;
}
