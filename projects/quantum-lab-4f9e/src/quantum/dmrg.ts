import { svdFlat } from './SVD';
import { vonNeumannEntropy } from './Hermitian';
import { hermitianEig } from './Hermitian';
import { C } from './Complex';
import type { MPO } from './MPO';

/**
 * Two-site Density Matrix Renormalization Group (DMRG) — the workhorse algorithm of
 * 1-D quantum many-body physics, built from scratch on top of this app's Matrix Product
 * State / Matrix Product Operator tensor-network engine and its complex SVD + Hermitian
 * eigensolver.
 *
 * DMRG finds the *ground state* of a local Hamiltonian (given as an MPO) variationally
 * over the manifold of bond-dimension-χ Matrix Product States. It sweeps back and forth
 * along the chain; at each step it fuses two neighbouring site tensors into a two-site
 * wavefunction Θ, builds the *effective* Hamiltonian Hₑff acting on Θ from the contracted
 * left/right environment blocks and the two local MPO tensors, and finds the lowest
 * eigenpair of Hₑff with a matrix-free **Lanczos** iteration (no dense Hₑff is ever
 * formed). The optimised Θ is split back into two tensors with an SVD truncated to χ —
 * the same controlled, discarded-weight-tracked approximation the MPS engine uses for
 * gates — moving the orthogonality centre one site along. A few sweeps drive the energy
 * to the variational minimum.
 *
 * Two things make this honest rather than a toy:
 *   • the converged energy is checked against exact diagonalisation of the *same* MPO
 *     (dense, small n) — DMRG matches it to machine-ish precision;
 *   • the energy **variance** ⟨H²⟩ − ⟨H⟩² is computed from a double-layer MPO contraction
 *     and goes to zero, the basis-independent certificate that the state really is an
 *     eigenstate (not merely low-energy). Both work at chain lengths far past where a 2ⁿ
 *     state vector could be diagonalised at all.
 *
 * Site/physical conventions match the MPS engine: site s ↔ qubit s, physical index 0 = |0⟩,
 * site tensor flat layout index(l,p,r) = (l·2+p)·dr + r.
 */

interface Site {
  dl: number;
  dr: number;
  re: Float64Array; // (l*2+p)*dr + r
  im: Float64Array;
}

/** Environment block: bra bond × mpo bond × ket bond, idx(a,b,c) = (a*w + b)*dKet + c. */
interface Env {
  da: number; // bra (= ket) bond dim
  w: number;  // mpo bond dim
  re: Float64Array;
  im: Float64Array;
}

const SVD_TOL = 1e-12;

export interface DMRGOptions {
  maxBond?: number;
  sweeps?: number;
  lanczosIters?: number;
  seed?: number;
  /** Stop early once |ΔE| between half-sweeps drops below this. */
  tol?: number;
}

export interface DMRGResult {
  energy: number;
  energyPerSite: number;
  /** Variational energy after each half-sweep (the convergence curve). */
  energyTrace: { step: number; energy: number }[];
  /** ⟨H²⟩ − ⟨H⟩²: the basis-independent "is it really an eigenstate" certificate. */
  variance: number;
  /** Entanglement entropy (bits) across every internal cut of the ground state. */
  entropyProfile: number[];
  bondDims: number[];
  maxBond: number;
  truncation: number;
  sweeps: number;
  converged: boolean;
}

// small deterministic PRNG so a run is reproducible from its seed
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMPS(n: number, startBond: number, rng: () => number): Site[] {
  const bond = [1];
  for (let s = 1; s < n; s++) bond.push(Math.min(startBond, 1 << Math.min(s, 30), 1 << Math.min(n - s, 30)));
  bond.push(1);
  const sites: Site[] = [];
  for (let s = 0; s < n; s++) {
    const dl = bond[s], dr = bond[s + 1], len = dl * 2 * dr;
    const re = new Float64Array(len), im = new Float64Array(len);
    for (let i = 0; i < len; i++) { re[i] = rng() - 0.5; im[i] = rng() - 0.5; }
    sites.push({ dl, dr, re, im });
  }
  return sites;
}

/** Choose how many leading singular values to keep; accumulate discarded Schmidt weight. */
function chooseRank(S: Float64Array, cap: number, acc: { trunc: number }): number {
  let total = 0;
  for (let i = 0; i < S.length; i++) total += S[i] * S[i];
  if (total === 0) return 1;
  const thresh = SVD_TOL * SVD_TOL * total;
  let chi = 0;
  while (chi < S.length && chi < cap && S[chi] * S[chi] >= thresh) chi++;
  if (chi === 0) chi = 1;
  let discarded = 0;
  for (let i = chi; i < S.length; i++) discarded += S[i] * S[i];
  acc.trunc += discarded / total;
  return chi;
}

/**
 * Right-canonicalise sites n-1 … 1 by SVD so every site but the first is right-canonical
 * and the orthogonality centre lands on site 0; then normalise. Returns the (now valid,
 * normalised) MPS ready for a left-to-right DMRG sweep.
 */
function rightCanonicalize(A: Site[]): void {
  const n = A.length;
  const dump = { trunc: 0 };
  for (let s = n - 1; s >= 1; s--) {
    const t = A[s];
    const rows = t.dl, cols = 2 * t.dr, dr = t.dr;
    // reshape (dl,2,dr) → dl × (2*dr), col = p*dr + r
    const Mre = new Float64Array(rows * cols), Mim = new Float64Array(rows * cols);
    for (let l = 0; l < rows; l++) for (let p = 0; p < 2; p++) for (let r = 0; r < dr; r++) {
      const src = (l * 2 + p) * dr + r, dst = l * cols + (p * dr + r);
      Mre[dst] = t.re[src]; Mim[dst] = t.im[src];
    }
    const f = svdFlat(Mre, Mim, rows, cols, SVD_TOL);
    const chi = chooseRank(f.S, Infinity, dump);
    const k = f.k;
    // A[s] = Vh[:chi] reshaped (chi,2,dr) right-canonical
    const are = new Float64Array(chi * 2 * dr), aim = new Float64Array(chi * 2 * dr);
    for (let c = 0; c < chi; c++) for (let p = 0; p < 2; p++) for (let r = 0; r < dr; r++) {
      const col = p * dr + r;
      are[(c * 2 + p) * dr + r] = f.Vhre[c * cols + col];
      aim[(c * 2 + p) * dr + r] = f.Vhim[c * cols + col];
    }
    A[s] = { dl: chi, dr, re: are, im: aim };
    // fold (U·S) into the right bond of site s-1
    const prev = A[s - 1];
    const pre = new Float64Array(prev.dl * 2 * chi), pim = new Float64Array(prev.dl * 2 * chi);
    for (let l = 0; l < prev.dl; l++) for (let p = 0; p < 2; p++) for (let c = 0; c < chi; c++) {
      let accr = 0, acci = 0; const sig = f.S[c];
      for (let m = 0; m < prev.dr; m++) {
        const ur = f.Ure[m * k + c] * sig, ui = f.Uim[m * k + c] * sig;
        const pi = (l * 2 + p) * prev.dr + m, ar = prev.re[pi], ai = prev.im[pi];
        accr += ar * ur - ai * ui; acci += ar * ui + ai * ur;
      }
      pre[(l * 2 + p) * chi + c] = accr; pim[(l * 2 + p) * chi + c] = acci;
    }
    A[s - 1] = { dl: prev.dl, dr: chi, re: pre, im: pim };
  }
  // normalise site 0
  const t0 = A[0];
  let nrm = 0; for (let i = 0; i < t0.re.length; i++) nrm += t0.re[i] * t0.re[i] + t0.im[i] * t0.im[i];
  nrm = Math.sqrt(nrm) || 1; const inv = 1 / nrm;
  for (let i = 0; i < t0.re.length; i++) { t0.re[i] *= inv; t0.im[i] *= inv; }
}

const trivialEnv = (): Env => ({ da: 1, w: 1, re: Float64Array.from([1]), im: new Float64Array(1) });

/** Grow the left environment across site s: L' = L · A* · W · A. */
function growLeft(L: Env, A: Site, W: MPO[number]): Env {
  const dl = A.dl, dr = A.dr, wL = W.wl, wM = W.wr;
  // Step 1: P[x,y,pin,c] = Σ_z L[x,y,z] A[z,pin,c]
  const P = new Float64Array(dl * wL * 2 * dr), Pi = new Float64Array(dl * wL * 2 * dr);
  for (let x = 0; x < dl; x++) for (let y = 0; y < wL; y++) for (let pin = 0; pin < 2; pin++) for (let c = 0; c < dr; c++) {
    let ar = 0, ai = 0;
    for (let z = 0; z < dl; z++) {
      const li = (x * wL + y) * dl + z, lr = L.re[li], lii = L.im[li];
      const ai2 = (z * 2 + pin) * dr + c, are = A.re[ai2], aim = A.im[ai2];
      ar += lr * are - lii * aim; ai += lr * aim + lii * are;
    }
    const idx = ((x * wL + y) * 2 + pin) * dr + c; P[idx] = ar; Pi[idx] = ai;
  }
  // Step 2: Q[x,b,p,c] = Σ_{y,pin} P[x,y,pin,c] W[y,b,p,pin]
  const Q = new Float64Array(dl * wM * 2 * dr), Qi = new Float64Array(dl * wM * 2 * dr);
  for (let x = 0; x < dl; x++) for (let b = 0; b < wM; b++) for (let p = 0; p < 2; p++) for (let c = 0; c < dr; c++) {
    let ar = 0, ai = 0;
    for (let y = 0; y < wL; y++) for (let pin = 0; pin < 2; pin++) {
      const pidx = ((x * wL + y) * 2 + pin) * dr + c, pr = P[pidx], pii = Pi[pidx];
      const widx = ((y * wM + b) * 2 + p) * 2 + pin, wr = W.re[widx], wi = W.im[widx];
      ar += pr * wr - pii * wi; ai += pr * wi + pii * wr;
    }
    const idx = ((x * wM + b) * 2 + p) * dr + c; Q[idx] = ar; Qi[idx] = ai;
  }
  // Step 3: L'[a,b,c] = Σ_{x,p} conj(A[x,p,a]) Q[x,b,p,c]
  const re = new Float64Array(dr * wM * dr), im = new Float64Array(dr * wM * dr);
  for (let a = 0; a < dr; a++) for (let b = 0; b < wM; b++) for (let c = 0; c < dr; c++) {
    let ar = 0, ai = 0;
    for (let x = 0; x < dl; x++) for (let p = 0; p < 2; p++) {
      const aidx = (x * 2 + p) * dr + a, acr = A.re[aidx], aci = -A.im[aidx]; // conj
      const qidx = ((x * wM + b) * 2 + p) * dr + c, qr = Q[qidx], qi = Qi[qidx];
      ar += acr * qr - aci * qi; ai += acr * qi + aci * qr;
    }
    const idx = (a * wM + b) * dr + c; re[idx] = ar; im[idx] = ai;
  }
  return { da: dr, w: wM, re, im };
}

/** Grow the right environment across site s: R' = A* · W · A · R. */
function growRight(R: Env, A: Site, W: MPO[number]): Env {
  const dl = A.dl, dr = A.dr, wL = W.wl, wR = W.wr;
  // Step 1: P[c,pin,x,y] = Σ_z A[c,pin,z] R[x,y,z]
  const P = new Float64Array(dl * 2 * dr * wR), Pi = new Float64Array(dl * 2 * dr * wR);
  for (let c = 0; c < dl; c++) for (let pin = 0; pin < 2; pin++) for (let x = 0; x < dr; x++) for (let y = 0; y < wR; y++) {
    let ar = 0, ai = 0;
    for (let z = 0; z < dr; z++) {
      const aidx = (c * 2 + pin) * dr + z, are = A.re[aidx], aim = A.im[aidx];
      const ridx = (x * wR + y) * dr + z, rr = R.re[ridx], ri = R.im[ridx];
      ar += are * rr - aim * ri; ai += are * ri + aim * rr;
    }
    const idx = ((c * 2 + pin) * dr + x) * wR + y; P[idx] = ar; Pi[idx] = ai;
  }
  // Step 2: Q[c,p,x,b] = Σ_{pin,y} P[c,pin,x,y] W[b,y,p,pin]
  const Q = new Float64Array(dl * 2 * dr * wL), Qi = new Float64Array(dl * 2 * dr * wL);
  for (let c = 0; c < dl; c++) for (let p = 0; p < 2; p++) for (let x = 0; x < dr; x++) for (let b = 0; b < wL; b++) {
    let ar = 0, ai = 0;
    for (let pin = 0; pin < 2; pin++) for (let y = 0; y < wR; y++) {
      const pidx = ((c * 2 + pin) * dr + x) * wR + y, pr = P[pidx], pii = Pi[pidx];
      const widx = ((b * wR + y) * 2 + p) * 2 + pin, wr = W.re[widx], wi = W.im[widx];
      ar += pr * wr - pii * wi; ai += pr * wi + pii * wr;
    }
    const idx = ((c * 2 + p) * dr + x) * wL + b; Q[idx] = ar; Qi[idx] = ai;
  }
  // Step 3: R'[a,b,c] = Σ_{p,x} conj(A[a,p,x]) Q[c,p,x,b]
  const re = new Float64Array(dl * wL * dl), im = new Float64Array(dl * wL * dl);
  for (let a = 0; a < dl; a++) for (let b = 0; b < wL; b++) for (let c = 0; c < dl; c++) {
    let ar = 0, ai = 0;
    for (let p = 0; p < 2; p++) for (let x = 0; x < dr; x++) {
      const aidx = (a * 2 + p) * dr + x, acr = A.re[aidx], aci = -A.im[aidx]; // conj
      const qidx = ((c * 2 + p) * dr + x) * wL + b, qr = Q[qidx], qi = Qi[qidx];
      ar += acr * qr - aci * qi; ai += acr * qi + aci * qr;
    }
    const idx = (a * wL + b) * dl + c; re[idx] = ar; im[idx] = ai;
  }
  return { da: dl, w: wL, re, im };
}

/**
 * Apply the two-site effective Hamiltonian to Θ (matrix-free), via the staged contraction
 *   Hₑff·Θ = L · W_s · W_{s+1} · R · Θ
 * over the environment + local MPO tensors. Θ has legs (aL, p1, p2, aR) flattened as
 * idx = ((aL*2+p1)*2+p2)*dR + aR.
 */
function applyHeff(
  tre: Float64Array, tim: Float64Array,
  L: Env, R: Env, Ws: MPO[number], Wsp1: MPO[number],
  dL: number, dR: number,
): { re: Float64Array; im: Float64Array } {
  const wLb = Ws.wl, wM = Ws.wr, wRb = Wsp1.wr;
  // C1[aL,bL,p1',p2',aR'] = Σ_{aL'} L[aL,bL,aL'] Θ[aL',p1',p2',aR']
  const C1 = new Float64Array(dL * wLb * 4 * dR), C1i = new Float64Array(dL * wLb * 4 * dR);
  for (let aL = 0; aL < dL; aL++) for (let bL = 0; bL < wLb; bL++) for (let k = 0; k < 4; k++) for (let aR = 0; aR < dR; aR++) {
    let ar = 0, ai = 0;
    for (let aLp = 0; aLp < dL; aLp++) {
      const lidx = (aL * wLb + bL) * dL + aLp, lr = L.re[lidx], li = L.im[lidx];
      const tidx = (aLp * 4 + k) * dR + aR, tr = tre[tidx], ti = tim[tidx];
      ar += lr * tr - li * ti; ai += lr * ti + li * tr;
    }
    const idx = ((aL * wLb + bL) * 4 + k) * dR + aR; C1[idx] = ar; C1i[idx] = ai;
  }
  // C2[aL,p1,bM,p2',aR'] = Σ_{bL,p1'} C1[aL,bL,(p1',p2'),aR'] W_s[bL,bM,p1,p1']
  const C2 = new Float64Array(dL * 2 * wM * 2 * dR), C2i = new Float64Array(dL * 2 * wM * 2 * dR);
  for (let aL = 0; aL < dL; aL++) for (let p1 = 0; p1 < 2; p1++) for (let bM = 0; bM < wM; bM++) for (let p2p = 0; p2p < 2; p2p++) for (let aR = 0; aR < dR; aR++) {
    let ar = 0, ai = 0;
    for (let bL = 0; bL < wLb; bL++) for (let p1p = 0; p1p < 2; p1p++) {
      const k = p1p * 2 + p2p;
      const cidx = ((aL * wLb + bL) * 4 + k) * dR + aR, cr = C1[cidx], ci = C1i[cidx];
      const widx = ((bL * wM + bM) * 2 + p1) * 2 + p1p, wr = Ws.re[widx], wi = Ws.im[widx];
      ar += cr * wr - ci * wi; ai += cr * wi + ci * wr;
    }
    const idx = (((aL * 2 + p1) * wM + bM) * 2 + p2p) * dR + aR; C2[idx] = ar; C2i[idx] = ai;
  }
  // C3[aL,p1,p2,bR,aR'] = Σ_{bM,p2'} C2[aL,p1,bM,p2',aR'] W_{s+1}[bM,bR,p2,p2']
  const C3 = new Float64Array(dL * 2 * 2 * wRb * dR), C3i = new Float64Array(dL * 2 * 2 * wRb * dR);
  for (let aL = 0; aL < dL; aL++) for (let p1 = 0; p1 < 2; p1++) for (let p2 = 0; p2 < 2; p2++) for (let bR = 0; bR < wRb; bR++) for (let aR = 0; aR < dR; aR++) {
    let ar = 0, ai = 0;
    for (let bM = 0; bM < wM; bM++) for (let p2p = 0; p2p < 2; p2p++) {
      const cidx = (((aL * 2 + p1) * wM + bM) * 2 + p2p) * dR + aR, cr = C2[cidx], ci = C2i[cidx];
      const widx = ((bM * wRb + bR) * 2 + p2) * 2 + p2p, wr = Wsp1.re[widx], wi = Wsp1.im[widx];
      ar += cr * wr - ci * wi; ai += cr * wi + ci * wr;
    }
    const idx = (((aL * 2 + p1) * 2 + p2) * wRb + bR) * dR + aR; C3[idx] = ar; C3i[idx] = ai;
  }
  // out[aL,p1,p2,aR] = Σ_{bR,aR'} C3[aL,p1,p2,bR,aR'] R[aR,bR,aR']
  const re = new Float64Array(dL * 4 * dR), im = new Float64Array(dL * 4 * dR);
  for (let aL = 0; aL < dL; aL++) for (let k = 0; k < 4; k++) for (let aR = 0; aR < dR; aR++) {
    let ar = 0, ai = 0;
    for (let bR = 0; bR < wRb; bR++) for (let aRp = 0; aRp < dR; aRp++) {
      const cidx = ((aL * 4 + k) * wRb + bR) * dR + aRp, cr = C3[cidx], ci = C3i[cidx];
      const ridx = (aR * wRb + bR) * dR + aRp, rr = R.re[ridx], ri = R.im[ridx];
      ar += cr * rr - ci * ri; ai += cr * ri + ci * rr;
    }
    const idx = (aL * 4 + k) * dR + aR; re[idx] = ar; im[idx] = ai;
  }
  return { re, im };
}

/** Σ conj(v1)·v2 over a complex flat vector. */
function cdot(r1: Float64Array, i1: Float64Array, r2: Float64Array, i2: Float64Array): [number, number] {
  let re = 0, im = 0;
  for (let k = 0; k < r1.length; k++) { re += r1[k] * r2[k] + i1[k] * i2[k]; im += r1[k] * i2[k] - i1[k] * r2[k]; }
  return [re, im];
}

/**
 * Matrix-free Lanczos: lowest eigenpair of Hₑff in the Krylov space seeded by the current
 * Θ (warm start). Full reorthogonalisation keeps the small Krylov basis numerically clean;
 * the tridiagonal projection is diagonalised with the app's Hermitian eigensolver.
 */
function lanczosGroundState(
  tre: Float64Array, tim: Float64Array,
  L: Env, R: Env, Ws: MPO[number], Wsp1: MPO[number],
  dL: number, dR: number, maxIters: number,
): { energy: number; re: Float64Array; im: Float64Array } {
  const D = tre.length;
  const m = Math.min(maxIters, D);
  const V: { re: Float64Array; im: Float64Array }[] = [];
  const alpha: number[] = [], beta: number[] = [];

  // normalise the seed
  let nrm = 0; for (let k = 0; k < D; k++) nrm += tre[k] * tre[k] + tim[k] * tim[k];
  nrm = Math.sqrt(nrm); if (nrm < 1e-300) { tre = new Float64Array(D); tre[0] = 1; nrm = 1; }
  const vr = new Float64Array(D), vi = new Float64Array(D);
  for (let k = 0; k < D; k++) { vr[k] = tre[k] / nrm; vi[k] = tim[k] / nrm; }
  V.push({ re: vr, im: vi });

  let mUsed = 0;
  for (let j = 0; j < m; j++) {
    mUsed = j + 1;
    const w = applyHeff(V[j].re, V[j].im, L, R, Ws, Wsp1, dL, dR);
    const [aRe] = cdot(V[j].re, V[j].im, w.re, w.im);
    alpha.push(aRe);
    // w ← w − α v_j − β_{j-1} v_{j-1}
    for (let k = 0; k < D; k++) { w.re[k] -= aRe * V[j].re[k]; w.im[k] -= aRe * V[j].im[k]; }
    if (j > 0) {
      const b = beta[j - 1];
      for (let k = 0; k < D; k++) { w.re[k] -= b * V[j - 1].re[k]; w.im[k] -= b * V[j - 1].im[k]; }
    }
    // full reorthogonalisation against all previous Krylov vectors
    for (let p = 0; p <= j; p++) {
      const [pr, pi] = cdot(V[p].re, V[p].im, w.re, w.im);
      for (let k = 0; k < D; k++) {
        w.re[k] -= pr * V[p].re[k] - pi * V[p].im[k];
        w.im[k] -= pr * V[p].im[k] + pi * V[p].re[k];
      }
    }
    let bn = 0; for (let k = 0; k < D; k++) bn += w.re[k] * w.re[k] + w.im[k] * w.im[k];
    bn = Math.sqrt(bn);
    if (bn < 1e-10 || j === m - 1) break;
    beta.push(bn);
    const nvr = new Float64Array(D), nvi = new Float64Array(D);
    for (let k = 0; k < D; k++) { nvr[k] = w.re[k] / bn; nvi[k] = w.im[k] / bn; }
    V.push({ re: nvr, im: nvi });
  }

  // diagonalise the real symmetric tridiagonal T (size mUsed)
  const T = Array.from({ length: mUsed }, () => Array.from({ length: mUsed }, () => C(0)));
  for (let i = 0; i < mUsed; i++) {
    T[i][i] = C(alpha[i]);
    if (i + 1 < mUsed) { T[i][i + 1] = C(beta[i]); T[i + 1][i] = C(beta[i]); }
  }
  const { values, vectors } = hermitianEig(T);
  const gi = values.length - 1; // smallest eigenvalue (descending order)
  const energy = values[gi];
  // ground vector in the full space: Θ = Σ_j c_j v_j
  const re = new Float64Array(D), im = new Float64Array(D);
  for (let j = 0; j < mUsed; j++) {
    const cr = vectors[j][gi].re, ci = vectors[j][gi].im;
    const vj = V[j];
    for (let k = 0; k < D; k++) {
      re[k] += cr * vj.re[k] - ci * vj.im[k];
      im[k] += cr * vj.im[k] + ci * vj.re[k];
    }
  }
  // normalise
  let n2 = 0; for (let k = 0; k < D; k++) n2 += re[k] * re[k] + im[k] * im[k];
  n2 = Math.sqrt(n2) || 1; const inv = 1 / n2;
  for (let k = 0; k < D; k++) { re[k] *= inv; im[k] *= inv; }
  return { energy, re, im };
}

/** Contract two neighbouring sites into the two-site Θ tensor. */
function formTheta(A: Site, B: Site): { re: Float64Array; im: Float64Array; dL: number; dR: number } {
  const dL = A.dl, dmid = A.dr, dR = B.dr;
  const re = new Float64Array(dL * 4 * dR), im = new Float64Array(dL * 4 * dR);
  for (let aL = 0; aL < dL; aL++) for (let p1 = 0; p1 < 2; p1++) for (let p2 = 0; p2 < 2; p2++) for (let aR = 0; aR < dR; aR++) {
    let ar = 0, ai = 0;
    for (let m = 0; m < dmid; m++) {
      const ai0 = (aL * 2 + p1) * dmid + m, arA = A.re[ai0], aiA = A.im[ai0];
      const bi = (m * 2 + p2) * dR + aR, brB = B.re[bi], biB = B.im[bi];
      ar += arA * brB - aiA * biB; ai += arA * biB + aiA * brB;
    }
    const idx = ((aL * 2 + p1) * 2 + p2) * dR + aR; re[idx] = ar; im[idx] = ai;
  }
  return { re, im, dL, dR };
}

/** Split Θ (rows dL*2 × cols 2*dR) back into two sites, moving the centre `right` or left. */
function splitTheta(
  re: Float64Array, im: Float64Array, dL: number, dR: number,
  cap: number, dir: 'right' | 'left', acc: { trunc: number },
): { A: Site; B: Site; S: Float64Array } {
  const rows = dL * 2, cols = 2 * dR;
  const f = svdFlat(re, im, rows, cols, SVD_TOL); // Θ is already row-major rows×cols
  const chi = chooseRank(f.S, cap, acc);
  const k = f.k;
  const are = new Float64Array(dL * 2 * chi), aim = new Float64Array(dL * 2 * chi);
  const bre = new Float64Array(chi * 2 * dR), bim = new Float64Array(chi * 2 * dR);
  for (let row = 0; row < rows; row++) for (let c = 0; c < chi; c++) {
    const sig = dir === 'left' ? f.S[c] : 1;
    are[row * chi + c] = f.Ure[row * k + c] * sig;
    aim[row * chi + c] = f.Uim[row * k + c] * sig;
  }
  for (let c = 0; c < chi; c++) for (let p = 0; p < 2; p++) for (let r = 0; r < dR; r++) {
    const col = p * dR + r, sig = dir === 'right' ? f.S[c] : 1;
    bre[(c * 2 + p) * dR + r] = sig * f.Vhre[c * cols + col];
    bim[(c * 2 + p) * dR + r] = sig * f.Vhim[c * cols + col];
  }
  return { A: { dl: dL, dr: chi, re: are, im: aim }, B: { dl: chi, dr: dR, re: bre, im: bim }, S: f.S.slice(0, chi) };
}

/** ⟨ψ|H|ψ⟩ for a normalised MPS by sweeping the left environment to the end. */
function energyExpectation(A: Site[], mpo: MPO): number {
  let L = trivialEnv();
  for (let s = 0; s < A.length; s++) L = growLeft(L, A[s], mpo[s]);
  return L.re[0];
}

/**
 * ⟨ψ|H²|ψ⟩ via a double-layer MPO environment (bra · W · W · ket), used for the energy
 * variance. Env idx(a,b1,b2,c) = ((a*w1 + b1)*w2 + b2)*dKet + c.
 */
function energySquared(A: Site[], mpo: MPO): number {
  let re = Float64Array.from([1]), im = new Float64Array(1);
  let da = 1, w1 = 1, w2 = 1;
  for (let s = 0; s < A.length; s++) {
    const W = mpo[s], dl = A[s].dl, dr = A[s].dr, wM = W.wr;
    // Step 1: P[x,y1,y2,pin,c] = Σ_z E[x,y1,y2,z] A[z,pin,c]
    const P = new Float64Array(da * w1 * w2 * 2 * dr), Pi = new Float64Array(da * w1 * w2 * 2 * dr);
    for (let x = 0; x < da; x++) for (let y1 = 0; y1 < w1; y1++) for (let y2 = 0; y2 < w2; y2++) for (let pin = 0; pin < 2; pin++) for (let c = 0; c < dr; c++) {
      let ar = 0, ai = 0;
      for (let z = 0; z < da; z++) {
        const eidx = ((x * w1 + y1) * w2 + y2) * da + z, er = re[eidx], ei = im[eidx];
        const aidx = (z * 2 + pin) * dr + c, arA = A[s].re[aidx], aiA = A[s].im[aidx];
        ar += er * arA - ei * aiA; ai += er * aiA + ei * arA;
      }
      const idx = (((x * w1 + y1) * w2 + y2) * 2 + pin) * dr + c; P[idx] = ar; Pi[idx] = ai;
    }
    // Step 2: Q[x,y1,b2,pmid,c] = Σ_{y2,pin} P[x,y1,y2,pin,c] W[y2,b2,pmid,pin]
    const Q = new Float64Array(da * w1 * wM * 2 * dr), Qi = new Float64Array(da * w1 * wM * 2 * dr);
    for (let x = 0; x < da; x++) for (let y1 = 0; y1 < w1; y1++) for (let b2 = 0; b2 < wM; b2++) for (let pmid = 0; pmid < 2; pmid++) for (let c = 0; c < dr; c++) {
      let ar = 0, ai = 0;
      for (let y2 = 0; y2 < w2; y2++) for (let pin = 0; pin < 2; pin++) {
        const pidx = (((x * w1 + y1) * w2 + y2) * 2 + pin) * dr + c, pr = P[pidx], pii = Pi[pidx];
        const widx = ((y2 * wM + b2) * 2 + pmid) * 2 + pin, wr = W.re[widx], wi = W.im[widx];
        ar += pr * wr - pii * wi; ai += pr * wi + pii * wr;
      }
      const idx = (((x * w1 + y1) * wM + b2) * 2 + pmid) * dr + c; Q[idx] = ar; Qi[idx] = ai;
    }
    // Step 3: Rr[x,b1,b2,p,c] = Σ_{y1,pmid} Q[x,y1,b2,pmid,c] W[y1,b1,p,pmid]
    const Rr = new Float64Array(da * wM * wM * 2 * dr), Rri = new Float64Array(da * wM * wM * 2 * dr);
    for (let x = 0; x < da; x++) for (let b1 = 0; b1 < wM; b1++) for (let b2 = 0; b2 < wM; b2++) for (let p = 0; p < 2; p++) for (let c = 0; c < dr; c++) {
      let ar = 0, ai = 0;
      for (let y1 = 0; y1 < w1; y1++) for (let pmid = 0; pmid < 2; pmid++) {
        const qidx = (((x * w1 + y1) * wM + b2) * 2 + pmid) * dr + c, qr = Q[qidx], qi = Qi[qidx];
        const widx = ((y1 * wM + b1) * 2 + p) * 2 + pmid, wr = W.re[widx], wi = W.im[widx];
        ar += qr * wr - qi * wi; ai += qr * wi + qi * wr;
      }
      const idx = (((x * wM + b1) * wM + b2) * 2 + p) * dr + c; Rr[idx] = ar; Rri[idx] = ai;
    }
    // Step 4: E'[a,b1,b2,c] = Σ_{x,p} conj(A[x,p,a]) Rr[x,b1,b2,p,c]
    const nre = new Float64Array(dr * wM * wM * dr), nim = new Float64Array(dr * wM * wM * dr);
    for (let a = 0; a < dr; a++) for (let b1 = 0; b1 < wM; b1++) for (let b2 = 0; b2 < wM; b2++) for (let c = 0; c < dr; c++) {
      let ar = 0, ai = 0;
      for (let x = 0; x < dl; x++) for (let p = 0; p < 2; p++) {
        const aidx = (x * 2 + p) * dr + a, acr = A[s].re[aidx], aci = -A[s].im[aidx];
        const ridx = (((x * wM + b1) * wM + b2) * 2 + p) * dr + c, rr = Rr[ridx], ri = Rri[ridx];
        ar += acr * rr - aci * ri; ai += acr * ri + aci * rr;
      }
      const idx = ((a * wM + b1) * wM + b2) * dr + c; nre[idx] = ar; nim[idx] = ai;
    }
    re = nre; im = nim; da = dr; w1 = wM; w2 = wM;
  }
  return re[0];
}

/**
 * Run two-site DMRG on an MPO. Returns the ground energy, the per-half-sweep convergence
 * curve, the energy variance, and the ground state's entanglement-entropy and bond-dimension
 * profiles.
 */
export function runDMRG(mpo: MPO, opts: DMRGOptions = {}): DMRGResult {
  const n = mpo.length;
  const maxBond = opts.maxBond ?? 32;
  const maxSweeps = opts.sweeps ?? 8;
  const lanczosIters = opts.lanczosIters ?? 12;
  const tol = opts.tol ?? 1e-9;
  const rng = mulberry32((opts.seed ?? 1) * 2654435761 + n);

  const acc = { trunc: 0 };

  if (n === 1) {
    // trivial: diagonalise the single-site 2×2 operator
    const W = mpo[0];
    const h00 = W.re[(0 * 1 + 0) * 4 + 0], h11 = W.re[(0 * 1 + 0) * 4 + 3];
    const h01r = W.re[(0 * 1 + 0) * 4 + 1], h01i = W.im[(0 * 1 + 0) * 4 + 1];
    const tr = (h00 + h11) / 2, d = (h00 - h11) / 2;
    const energy = tr - Math.hypot(d, Math.hypot(h01r, h01i));
    return { energy, energyPerSite: energy, energyTrace: [{ step: 0, energy }], variance: 0, entropyProfile: [], bondDims: [1, 1], maxBond: 1, truncation: 0, sweeps: 0, converged: true };
  }

  const A = randomMPS(n, Math.min(maxBond, 8), rng);
  rightCanonicalize(A);

  // right environments R[s] for s = n … 0 (R[n] trivial). Built once; updated during sweeps.
  const R: Env[] = new Array(n + 1);
  R[n] = trivialEnv();
  for (let s = n - 1; s >= 1; s--) R[s] = growRight(R[s + 1], A[s], mpo[s]);
  const L: Env[] = new Array(n + 1);
  L[0] = trivialEnv();

  const energyTrace: { step: number; energy: number }[] = [];
  let step = 0, lastE = Infinity, converged = false;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    // left-to-right
    for (let s = 0; s < n - 1; s++) {
      const theta = formTheta(A[s], A[s + 1]);
      const g = lanczosGroundState(theta.re, theta.im, L[s], R[s + 2], mpo[s], mpo[s + 1], theta.dL, theta.dR, lanczosIters);
      const { A: Anew, B: Bnew } = splitTheta(g.re, g.im, theta.dL, theta.dR, maxBond, 'right', acc);
      A[s] = Anew; A[s + 1] = Bnew;
      L[s + 1] = growLeft(L[s], A[s], mpo[s]);
      energyTrace.push({ step: step++, energy: g.energy });
      lastE = g.energy;
    }
    // right-to-left
    for (let s = n - 2; s >= 0; s--) {
      const theta = formTheta(A[s], A[s + 1]);
      const g = lanczosGroundState(theta.re, theta.im, L[s], R[s + 2], mpo[s], mpo[s + 1], theta.dL, theta.dR, lanczosIters);
      const { A: Anew, B: Bnew } = splitTheta(g.re, g.im, theta.dL, theta.dR, maxBond, 'left', acc);
      A[s] = Anew; A[s + 1] = Bnew;
      R[s + 1] = growRight(R[s + 2], A[s + 1], mpo[s + 1]);
      energyTrace.push({ step: step++, energy: g.energy });
      if (Math.abs(g.energy - lastE) < tol) converged = true;
      lastE = g.energy;
    }
    if (converged && sweep >= 1) break;
  }

  // The right-to-left sweep leaves the centre at site 0 (A is right-canonical for s≥1);
  // re-normalise site 0 so the state is a unit vector for the expectation values.
  const t0 = A[0];
  let nrm = 0; for (let i = 0; i < t0.re.length; i++) nrm += t0.re[i] * t0.re[i] + t0.im[i] * t0.im[i];
  nrm = Math.sqrt(nrm) || 1; const inv = 1 / nrm;
  for (let i = 0; i < t0.re.length; i++) { t0.re[i] *= inv; t0.im[i] *= inv; }

  const energy = energyExpectation(A, mpo);
  const h2 = energySquared(A, mpo);
  const variance = Math.max(0, h2 - energy * energy);

  // entropy + bond-dimension profiles from a clean left-to-right canonical sweep
  const entropyProfile: number[] = [];
  const bondDims: number[] = [1];
  {
    const dump = { trunc: 0 };
    // centre is at 0; sweep right, recording Schmidt spectra
    for (let s = 0; s < n - 1; s++) {
      const theta = formTheta(A[s], A[s + 1]);
      const { A: Anew, B: Bnew, S } = splitTheta(theta.re, theta.im, theta.dL, theta.dR, maxBond, 'right', dump);
      A[s] = Anew; A[s + 1] = Bnew;
      let z = 0; for (let i = 0; i < S.length; i++) z += S[i] * S[i];
      z = z || 1;
      entropyProfile.push(vonNeumannEntropy(Array.from(S, (x) => (x * x) / z)));
      bondDims.push(S.length);
    }
    bondDims.push(1);
  }

  const maxBondReached = Math.max(...bondDims, 1);
  return {
    energy, energyPerSite: energy / n, energyTrace, variance,
    entropyProfile, bondDims, maxBond: maxBondReached, truncation: acc.trunc,
    sweeps: Math.min(maxSweeps, energyTrace.length / (2 * (n - 1)) + 1) | 0,
    converged,
  };
}
