// A from-scratch Kolmogorov–Arnold Network (KAN), built on the same reverse-mode tensor
// autograd as every other lab. Where an MLP puts a fixed nonlinearity on each *node* and a
// learned scalar on each *edge*, a KAN (Liu et al., 2024) does the opposite: every edge carries
// a learned *univariate function* φ(x), and nodes simply sum. Each φ is a SiLU "base" plus a
// B-spline:
//
//     φ_{j,i}(x) = w_b · silu(x)  +  Σ_k c_{(j,i),k} · B_k(x)
//
// and a layer maps R^in → R^out by  y_j = bias_j + Σ_i φ_{j,i}(x_i).
//
// Everything here is hand-written — there are no spline libraries. The B-spline basis is the
// Cox–de Boor recursion (`evalSplineBasis`), its derivative is the exact analytic recursion,
// and the whole layer is ONE fused autograd op whose backward differentiates the output w.r.t.
// the base weights, every spline coefficient, the bias, *and the input x* (the chain rule
// through B'(x) — the part that lets KANs be stacked). All of it is gradchecked against finite
// differences in `selftest.ts`.
//
// The grid is also adaptive: `refitToGrid` re-solves the spline coefficients by least squares so
// the learned function is *preserved* when the knot vector changes — that is what lets a trained
// KAN be refined (G → 2G, "grid extension") or re-centred onto the data range without forgetting,
// the property that makes the architecture special.

import { Tensor } from './tensor';

// ---- B-spline grid + basis ----------------------------------------------------------

export interface SplineGrid {
  degree: number; // spline order k (k=3 ⇒ cubic)
  gridSize: number; // number of intervals G across [lo, hi]
  knots: Float64Array; // extended-uniform knot vector, length G + 2k + 1
  numBasis: number; // G + k basis functions
  lo: number;
  hi: number;
}

// Build an extended-uniform (open) knot vector over [lo, hi] with `gridSize` interior intervals
// and the given degree. The k extra knots padded on each side give the G+k basis functions that
// form a partition of unity across the whole [lo, hi] interior.
export function makeGrid(gridSize: number, degree: number, lo: number, hi: number): SplineGrid {
  const G = Math.max(1, Math.round(gridSize));
  const k = Math.max(1, Math.round(degree));
  const h = (hi - lo) / G;
  const K = G + 2 * k + 1;
  const knots = new Float64Array(K);
  for (let i = 0; i < K; i++) knots[i] = lo + (i - k) * h;
  return { degree: k, gridSize: G, knots, numBasis: G + k, lo, hi };
}

// Evaluate every B-spline basis value and its derivative at one point, filling `val` and `der`
// (both length grid.numBasis). The values come from the Cox–de Boor recursion; the derivatives
// from its exact analytic form  B'_{i,p}(x) = p·[B_{i,p-1}/(t_{i+p}-t_i) − B_{i+1,p-1}/(t_{i+p+1}-t_{i+1})].
// x is clamped into [lo, hi]; outside the grid the spline contributes its boundary value and the
// SiLU base carries the rest.
export function evalSplineBasis(grid: SplineGrid, xRaw: number, val: Float64Array, der: Float64Array): void {
  const { knots, degree: p, numBasis: N, lo, hi } = grid;
  const K = knots.length;
  let x = xRaw;
  if (x < lo) x = lo;
  const top = hi - (hi - lo) * 1e-9; // keep the right endpoint inside the last half-open interval
  if (x > top) x = top;

  // Degree-0 indicators.
  let B = new Float64Array(K - 1);
  for (let i = 0; i < K - 1; i++) B[i] = x >= knots[i] && x < knots[i + 1] ? 1 : 0;

  // Lift degree by degree; capture the degree p-1 array for the derivative.
  let dprev: Float64Array = B;
  for (let d = 1; d <= p; d++) {
    if (d === p) dprev = B; // B currently holds degree p-1
    const sz = K - d - 1;
    const nb = new Float64Array(sz);
    for (let i = 0; i < sz; i++) {
      const den1 = knots[i + d] - knots[i];
      const den2 = knots[i + d + 1] - knots[i + 1];
      let t = 0;
      if (den1 > 0) t += ((x - knots[i]) / den1) * B[i];
      if (den2 > 0) t += ((knots[i + d + 1] - x) / den2) * B[i + 1];
      nb[i] = t;
    }
    B = nb;
  }

  for (let i = 0; i < N; i++) val[i] = B[i];
  for (let i = 0; i < N; i++) {
    const den1 = knots[i + p] - knots[i];
    const den2 = knots[i + p + 1] - knots[i + 1];
    let t = 0;
    if (den1 > 0) t += (p * dprev[i]) / den1;
    if (den2 > 0) t -= (p * dprev[i + 1]) / den2;
    der[i] = t;
  }
}

// SiLU and its derivative (the residual "base" branch of every edge), matching the engine's silu.
function silu(x: number): number {
  return x / (1 + Math.exp(-x));
}
function siluDeriv(x: number): number {
  const s = 1 / (1 + Math.exp(-x));
  return s * (1 + x * (1 - s));
}

// ---- a small dense linear solver (for grid refitting) -------------------------------

// Solve A·z = b for a small square system by Gaussian elimination with partial pivoting.
// A is given as row arrays (mutated); returns z, or a zero vector if singular.
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue; // singular column — leave as 0
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

// ---- standard-normal sample (Box–Muller) for weight init ----------------------------

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- one KAN layer ------------------------------------------------------------------

// An edge is either a trained B-spline (the default), frozen to a symbolic form a·g(x)+b, or
// pruned to zero. The last two no longer receive parameter gradients — they are the trained
// KAN being *distilled* into a readable, sparse skeleton.
export type EdgeMode = 'spline' | 'symbolic' | 'pruned';

export interface EdgeCurve {
  i: number; // input node
  j: number; // output node
  xs: Float64Array; // sample abscissae over [lo, hi]
  ys: Float64Array; // φ_{j,i}(xs)
  importance: number; // mean |φ| over the samples — drives diagram opacity / pruning
  mode: EdgeMode; // spline (trained) · symbolic (frozen formula) · pruned (zero)
  symbol?: string; // the frozen form, when mode === 'symbolic', e.g. "1.98·sin(π·x) + 0.01"
}

export class KANLayer {
  readonly inF: number;
  readonly outF: number;
  grid: SplineGrid;
  base: Tensor; // [inF, outF]  SiLU residual weights
  coeff: Tensor; // [inF*outF, numBasis]  spline coefficients per edge
  bias: Tensor; // [1, outF]
  // Per-edge interpretability state (index e = i*outF + j). Default: every edge is a live spline.
  modes: EdgeMode[]; // 'spline' | 'symbolic' | 'pruned'
  symIdx: Int32Array; // symbolic library index when mode === 'symbolic' (else -1)
  symA: Float64Array; // frozen scale a  (φ = a·g(x) + b)
  symB: Float64Array; // frozen offset b

  constructor(inF: number, outF: number, grid: SplineGrid, rng: () => number, noisyCoeff = 0.1) {
    this.inF = inF;
    this.outF = outF;
    this.grid = grid;
    const E = inF * outF;
    this.modes = new Array(E).fill('spline');
    this.symIdx = new Int32Array(E).fill(-1);
    this.symA = new Float64Array(E);
    this.symB = new Float64Array(E);
    const N = grid.numBasis;
    // SiLU base: small Xavier-like init so a fresh layer is a gentle near-linear map.
    const bd = new Float64Array(inF * outF);
    const gain = 1 / Math.sqrt(inF);
    for (let i = 0; i < bd.length; i++) bd[i] = randn(rng) * gain;
    this.base = Tensor.fromFlat(bd, inF, outF, true).named('w_b');
    // Spline coefficients: small noise so the spline starts near zero (base carries the signal).
    const cd = new Float64Array(inF * outF * N);
    const cgain = noisyCoeff / Math.sqrt(N);
    for (let i = 0; i < cd.length; i++) cd[i] = randn(rng) * cgain;
    this.coeff = Tensor.fromFlat(cd, inF * outF, N, true).named('c');
    this.bias = Tensor.zeros(1, outF, true).named('b');
  }

  parameters(): Tensor[] {
    return [this.base, this.coeff, this.bias];
  }

  // Fused, differentiable forward: y = bias + Σ_i (w_b·silu(x_i) + spline_i(x_i)). The backward
  // accumulates gradients into the base weights, every spline coefficient, the bias, AND the
  // input x (so layers stack). All hand-derived; gradchecked in selftest.ts.
  forward(x: Tensor): Tensor {
    if (x.cols !== this.inF) throw new Error(`KANLayer expected ${this.inF} inputs, got ${x.cols}`);
    const B = x.rows;
    const inF = this.inF;
    const outF = this.outF;
    const N = this.grid.numBasis;
    const grid = this.grid;
    const xa = x.data;
    const ba = this.base.data;
    const ca = this.coeff.data;
    const bia = this.bias.data;

    // Per-(sample, input) caches reused by the backward pass.
    const sv = new Float64Array(B * inF); // silu(x)
    const sd = new Float64Array(B * inF); // silu'(x)
    const bv = new Float64Array(B * inF * N); // basis values
    const bd = new Float64Array(B * inF * N); // basis derivatives
    const tmpV = new Float64Array(N);
    const tmpD = new Float64Array(N);

    const out = Tensor.zeros(B, outF);
    const o = out.data;
    for (let b = 0; b < B; b++) {
      for (let j = 0; j < outF; j++) o[b * outF + j] = bia[j];
    }
    for (let b = 0; b < B; b++) {
      for (let i = 0; i < inF; i++) {
        const xv = xa[b * inF + i];
        const si = silu(xv);
        const sdi = siluDeriv(xv);
        sv[b * inF + i] = si;
        sd[b * inF + i] = sdi;
        evalSplineBasis(grid, xv, tmpV, tmpD);
        const cacheBase = (b * inF + i) * N;
        for (let k = 0; k < N; k++) {
          bv[cacheBase + k] = tmpV[k];
          bd[cacheBase + k] = tmpD[k];
        }
        // spread this input's contribution onto every output node, honouring each edge's mode:
        // a spline edge computes w·silu + Σc·B; a symbolic edge its frozen a·g(x)+b; a pruned
        // edge contributes nothing.
        for (let j = 0; j < outF; j++) {
          const e = i * outF + j;
          const m = this.modes[e];
          if (m === 'pruned') continue;
          if (m === 'symbolic') {
            const cand = SYMBOLIC_LIBRARY[this.symIdx[e]];
            o[b * outF + j] += this.symA[e] * cand.g(xv) + this.symB[e];
            continue;
          }
          let spline = 0;
          const cb = e * N;
          for (let k = 0; k < N; k++) spline += ca[cb + k] * tmpV[k];
          o[b * outF + j] += ba[i * outF + j] * si + spline;
        }
      }
    }

    out.op = 'kanLayer';
    out.prev = [x, this.base, this.coeff, this.bias];
    out.backwardFn = () => {
      const g = out.grad;
      const gx = x.grad;
      const gb = this.base.grad;
      const gc = this.coeff.grad;
      const gbias = this.bias.grad;
      for (let b = 0; b < B; b++) {
        for (let j = 0; j < outF; j++) gbias[j] += g[b * outF + j];
      }
      for (let b = 0; b < B; b++) {
        for (let i = 0; i < inF; i++) {
          const si = sv[b * inF + i];
          const sdi = sd[b * inF + i];
          const xv = xa[b * inF + i];
          const cacheBase = (b * inF + i) * N;
          let gxi = 0;
          for (let j = 0; j < outF; j++) {
            const gy = g[b * outF + j];
            if (gy === 0) continue;
            const e = i * outF + j;
            const m = this.modes[e];
            if (m === 'pruned') continue; // no output ⇒ no gradient anywhere
            if (m === 'symbolic') {
              // frozen edge: no param gradients, but the dx chain rule still flows so the layers
              // below a snapped edge keep training. dφ/dx = a·g'(x).
              const cand = SYMBOLIC_LIBRARY[this.symIdx[e]];
              gxi += gy * this.symA[e] * cand.dg(xv);
              continue;
            }
            const cb = e * N;
            // base weight + bias contributions
            gb[i * outF + j] += gy * si;
            // spline coefficient grads, and accumulate dx through both branches
            let dxSpline = 0;
            for (let k = 0; k < N; k++) {
              gc[cb + k] += gy * bv[cacheBase + k];
              dxSpline += ca[cb + k] * bd[cacheBase + k];
            }
            gxi += gy * (ba[i * outF + j] * sdi + dxSpline);
          }
          gx[b * inF + i] += gxi;
        }
      }
    };
    return out;
  }

  // Non-taped numeric forward for inference / heatmaps — same math, no caching, no graph.
  evalNumeric(xData: Float64Array, rows: number): Float64Array {
    const inF = this.inF;
    const outF = this.outF;
    const N = this.grid.numBasis;
    const ba = this.base.data;
    const ca = this.coeff.data;
    const bia = this.bias.data;
    const out = new Float64Array(rows * outF);
    const tmpV = new Float64Array(N);
    const tmpD = new Float64Array(N);
    for (let b = 0; b < rows; b++) {
      for (let j = 0; j < outF; j++) out[b * outF + j] = bia[j];
    }
    for (let b = 0; b < rows; b++) {
      for (let i = 0; i < inF; i++) {
        const xv = xData[b * inF + i];
        const si = silu(xv);
        evalSplineBasis(this.grid, xv, tmpV, tmpD);
        for (let j = 0; j < outF; j++) {
          const e = i * outF + j;
          const m = this.modes[e];
          if (m === 'pruned') continue;
          if (m === 'symbolic') {
            out[b * outF + j] += this.symA[e] * SYMBOLIC_LIBRARY[this.symIdx[e]].g(xv) + this.symB[e];
            continue;
          }
          const cb = e * N;
          let spline = 0;
          for (let k = 0; k < N; k++) spline += ca[cb + k] * tmpV[k];
          out[b * outF + j] += ba[i * outF + j] * si + spline;
        }
      }
    }
    return out;
  }

  // The spline-only part of edge (i,j) at x — the target preserved across a grid change.
  private splineAt(e: number, x: number, tmpV: Float64Array, tmpD: Float64Array): number {
    const N = this.grid.numBasis;
    evalSplineBasis(this.grid, x, tmpV, tmpD);
    const cb = e * N;
    let s = 0;
    for (let k = 0; k < N; k++) s += this.coeff.data[cb + k] * tmpV[k];
    return s;
  }

  // Sample the full learned function φ_{j,i} over [lo, hi] for the diagram / inspector.
  edgeCurve(i: number, j: number, samples = 48): EdgeCurve {
    const { lo, hi } = this.grid;
    const N = this.grid.numBasis;
    const xs = new Float64Array(samples);
    const ys = new Float64Array(samples);
    const tmpV = new Float64Array(N);
    const tmpD = new Float64Array(N);
    const e = i * this.outF + j;
    const mode = this.modes[e];
    const wb = this.base.data[i * this.outF + j];
    const cand = mode === 'symbolic' ? SYMBOLIC_LIBRARY[this.symIdx[e]] : null;
    let imp = 0;
    for (let s = 0; s < samples; s++) {
      const x = lo + ((hi - lo) * s) / (samples - 1);
      xs[s] = x;
      let y: number;
      if (mode === 'pruned') y = 0;
      else if (cand) y = this.symA[e] * cand.g(x) + this.symB[e];
      else y = wb * silu(x) + this.splineAt(e, x, tmpV, tmpD);
      ys[s] = y;
      imp += Math.abs(y);
    }
    const symbol = cand ? formatSymbolic(this.symIdx[e], this.symA[e], this.symB[e]) : undefined;
    return { i, j, xs, ys, importance: imp / samples, mode, symbol };
  }

  // ---- per-edge surgery (distilling the trained KAN) --------------------------------

  private edgeIndex(i: number, j: number): number {
    return i * this.outF + j;
  }

  // Sample the *current* spline φ over the grid (ignoring mode) — the target a snap fits against.
  private sampleSpline(e: number, samples: number): { xs: Float64Array; ys: Float64Array } {
    const { lo, hi } = this.grid;
    const N = this.grid.numBasis;
    const tmpV = new Float64Array(N);
    const tmpD = new Float64Array(N);
    const i = Math.floor(e / this.outF);
    const j = e % this.outF;
    const wb = this.base.data[i * this.outF + j];
    const xs = new Float64Array(samples);
    const ys = new Float64Array(samples);
    for (let s = 0; s < samples; s++) {
      const x = lo + ((hi - lo) * s) / (samples - 1);
      xs[s] = x;
      ys[s] = wb * silu(x) + this.splineAt(e, x, tmpV, tmpD);
    }
    return { xs, ys };
  }

  // Freeze edge (i,j) to its closest elementary function (or a named one), returning the fit.
  snapEdge(i: number, j: number, name?: string): SymbolicFit | null {
    const e = this.edgeIndex(i, j);
    const { xs, ys } = this.sampleSpline(e, 64);
    const fits = suggestSymbolic(xs, ys);
    if (fits.length === 0) return null;
    const fit = name ? fits.find((f) => f.name === name) ?? fits[0] : fits[0];
    this.modes[e] = 'symbolic';
    this.symIdx[e] = candidateIndex(fit.name);
    this.symA[e] = fit.a;
    this.symB[e] = fit.b;
    return fit;
  }

  // The ranked symbolic fits of this edge's current spline φ — the choices a snap picks from.
  fitCandidates(i: number, j: number, samples = 64): SymbolicFit[] {
    const { xs, ys } = this.sampleSpline(this.edgeIndex(i, j), samples);
    return suggestSymbolic(xs, ys);
  }

  pruneEdge(i: number, j: number): void {
    this.modes[this.edgeIndex(i, j)] = 'pruned';
  }

  resetEdge(i: number, j: number): void {
    const e = this.edgeIndex(i, j);
    this.modes[e] = 'spline';
    this.symIdx[e] = -1;
  }

  edgeMode(i: number, j: number): EdgeMode {
    return this.modes[this.edgeIndex(i, j)];
  }

  // Refit every spline coefficient so the spline function is preserved under a NEW grid
  // (different knot count and/or range), by least squares over densely sampled points. This is
  // "grid extension" / "grid adaptation": the learned curve survives a resolution or domain
  // change instead of being reset. A small ridge term keeps the solve well-posed.
  refitToGrid(newGrid: SplineGrid, ridge = 1e-6): void {
    const oldGrid = this.grid;
    const Nnew = newGrid.numBasis;
    const M = Math.max(64, Nnew * 4);
    const lo = newGrid.lo;
    const hi = newGrid.hi;
    // Basis matrix Φ [M, Nnew] at the sample points (shared by every edge), plus ΦᵀΦ + ridge.
    const Phi: Float64Array[] = [];
    const xs = new Float64Array(M);
    const tmpV = new Float64Array(Nnew);
    const tmpD = new Float64Array(Nnew);
    for (let m = 0; m < M; m++) {
      const x = lo + ((hi - lo) * m) / (M - 1);
      xs[m] = x;
      evalSplineBasis(newGrid, x, tmpV, tmpD);
      Phi.push(tmpV.slice());
    }
    const AtA: number[][] = Array.from({ length: Nnew }, () => new Array(Nnew).fill(0));
    for (let m = 0; m < M; m++) {
      const row = Phi[m];
      for (let a = 0; a < Nnew; a++) {
        const ra = row[a];
        if (ra === 0) continue;
        for (let b = a; b < Nnew; b++) AtA[a][b] += ra * row[b];
      }
    }
    for (let a = 0; a < Nnew; a++) {
      for (let b = a; b < Nnew; b++) AtA[b][a] = AtA[a][b]; // symmetric mirror
      AtA[a][a] += ridge;
    }
    // Solve once per edge with its own target (old spline sampled at xs).
    const oldV = new Float64Array(oldGrid.numBasis);
    const oldD = new Float64Array(oldGrid.numBasis);
    const newCoeff = new Float64Array(this.inF * this.outF * Nnew);
    for (let e = 0; e < this.inF * this.outF; e++) {
      const target = new Float64Array(M);
      for (let m = 0; m < M; m++) {
        // evaluate old spline at xs[m]
        evalSplineBasis(oldGrid, xs[m], oldV, oldD);
        const cb = e * oldGrid.numBasis;
        let s = 0;
        for (let k = 0; k < oldGrid.numBasis; k++) s += this.coeff.data[cb + k] * oldV[k];
        target[m] = s;
      }
      const Atb = new Array(Nnew).fill(0);
      for (let m = 0; m < M; m++) {
        const row = Phi[m];
        const t = target[m];
        for (let a = 0; a < Nnew; a++) Atb[a] += row[a] * t;
      }
      const c = solveLinear(
        AtA.map((r) => [...r]),
        Atb,
      );
      const nb = e * Nnew;
      for (let k = 0; k < Nnew; k++) newCoeff[nb + k] = c[k];
    }
    this.coeff = Tensor.fromFlat(newCoeff, this.inF * this.outF, Nnew, true).named('c');
    this.grid = newGrid;
  }
}

// ---- symbolic regression (interpretability) -----------------------------------------

export interface SymbolicFit {
  name: string; // human-readable form, e.g. "sin(x)"
  a: number; // best-fit scale
  b: number; // best-fit offset
  r2: number; // coefficient of determination over the sampled curve
}

interface Candidate {
  name: string;
  g: (x: number) => number; // the function value
  dg: (x: number) => number; // its analytic derivative (needed by a frozen edge's dx backward)
  tmpl: (inner: string) => string; // pretty-printer g(inner) for the whole-network compiler
}

// A tiny guard so √|x| / log derivatives stay finite at x = 0.
function sgn(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

// The library of elementary functions a learned edge φ(x) is matched against. Each is fit as
// y ≈ a·g(x) + b by ordinary 1-D least squares, and ranked by R² — turning an opaque spline into
// a readable formula, the headline interpretability move of the KAN paper. Each carries its exact
// derivative `dg` (so a *snapped* edge, frozen to a·g(x)+b, still passes the chain rule to its
// input and lets the layers below it keep training) and a string template `tmpl` (so the whole
// network can be printed as one closed-form equation once enough edges are symbolic).
export const SYMBOLIC_LIBRARY: Candidate[] = [
  { name: '1', g: () => 1, dg: () => 0, tmpl: () => '1' },
  { name: 'x', g: (x) => x, dg: () => 1, tmpl: (s) => s },
  { name: 'x²', g: (x) => x * x, dg: (x) => 2 * x, tmpl: (s) => `(${s})²` },
  { name: 'x³', g: (x) => x * x * x, dg: (x) => 3 * x * x, tmpl: (s) => `(${s})³` },
  { name: '|x|', g: (x) => Math.abs(x), dg: (x) => sgn(x), tmpl: (s) => `|${s}|` },
  { name: '√|x|', g: (x) => Math.sqrt(Math.abs(x)), dg: (x) => sgn(x) / (2 * Math.sqrt(Math.abs(x) + 1e-12)), tmpl: (s) => `√|${s}|` },
  { name: 'sin(πx)', g: (x) => Math.sin(Math.PI * x), dg: (x) => Math.PI * Math.cos(Math.PI * x), tmpl: (s) => `sin(π·${s})` },
  { name: 'cos(πx)', g: (x) => Math.cos(Math.PI * x), dg: (x) => -Math.PI * Math.sin(Math.PI * x), tmpl: (s) => `cos(π·${s})` },
  { name: 'sin(2πx)', g: (x) => Math.sin(2 * Math.PI * x), dg: (x) => 2 * Math.PI * Math.cos(2 * Math.PI * x), tmpl: (s) => `sin(2π·${s})` },
  { name: 'tanh(2x)', g: (x) => Math.tanh(2 * x), dg: (x) => 2 * (1 - Math.tanh(2 * x) ** 2), tmpl: (s) => `tanh(2·${s})` },
  { name: 'exp(x)', g: (x) => Math.exp(x), dg: (x) => Math.exp(x), tmpl: (s) => `exp(${s})` },
  {
    name: 'σ(4x)',
    g: (x) => 1 / (1 + Math.exp(-4 * x)),
    dg: (x) => {
      const s = 1 / (1 + Math.exp(-4 * x));
      return 4 * s * (1 - s);
    },
    tmpl: (s) => `σ(4·${s})`,
  },
  { name: 'exp(−x²)', g: (x) => Math.exp(-x * x), dg: (x) => -2 * x * Math.exp(-x * x), tmpl: (s) => `exp(−(${s})²)` },
  { name: 'log(|x|+1)', g: (x) => Math.log(Math.abs(x) + 1), dg: (x) => sgn(x) / (Math.abs(x) + 1), tmpl: (s) => `log(|${s}|+1)` },
];

export const SYMBOLIC_NAMES: string[] = SYMBOLIC_LIBRARY.map((c) => c.name);

export function candidateIndex(name: string): number {
  return SYMBOLIC_LIBRARY.findIndex((c) => c.name === name);
}

// Compact numeric formatter used in every printed formula.
export function fmtCoef(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 100 || a < 0.01)) return v.toExponential(1);
  return v.toFixed(2);
}

// Pretty-print a frozen edge a·g(x)+b in terms of a variable/expression name (default "x"),
// dropping the ·1 scale, folding a≈−1 into a leading minus, and hiding a ≈0 offset.
export function formatSymbolic(idx: number, a: number, b: number, varName = 'x'): string {
  const cand = SYMBOLIC_LIBRARY[idx];
  if (!cand) return '0';
  if (cand.name === '1' || Math.abs(a) < 1e-9) return fmtCoef(b);
  const gpart = cand.tmpl(varName);
  const scale = Math.abs(a - 1) < 1e-9 ? '' : Math.abs(a + 1) < 1e-9 ? '−' : `${fmtCoef(a)}·`;
  let s = `${scale}${gpart}`;
  if (Math.abs(b) >= 5e-3) s += `${b >= 0 ? ' + ' : ' − '}${fmtCoef(Math.abs(b))}`;
  return s;
}

// Fit every library function to a sampled curve (xs, ys) and return them best-R²-first. The fit
// y ≈ a·g(x)+b has the closed-form least-squares solution from the sums of g, y, g², gy.
export function suggestSymbolic(xs: Float64Array, ys: Float64Array): SymbolicFit[] {
  const n = xs.length;
  let meanY = 0;
  for (let i = 0; i < n; i++) meanY += ys[i];
  meanY /= n;
  let ssTot = 0;
  for (let i = 0; i < n; i++) ssTot += (ys[i] - meanY) ** 2;

  const out: SymbolicFit[] = [];
  for (const cand of SYMBOLIC_LIBRARY) {
    let sg = 0;
    let sy = 0;
    let sgg = 0;
    let sgy = 0;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const g = cand.g(xs[i]);
      if (!Number.isFinite(g)) {
        ok = false;
        break;
      }
      sg += g;
      sy += ys[i];
      sgg += g * g;
      sgy += g * ys[i];
    }
    if (!ok) continue;
    const denom = n * sgg - sg * sg;
    let a = 0;
    let b = meanY;
    if (cand.name === '1') {
      a = 0;
      b = meanY; // the constant model
    } else if (Math.abs(denom) > 1e-12) {
      a = (n * sgy - sg * sy) / denom;
      b = (sy - a * sg) / n;
    }
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const pred = cand.name === '1' ? b : a * cand.g(xs[i]) + b;
      ssRes += (ys[i] - pred) ** 2;
    }
    const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : cand.name === '1' ? 1 : 0;
    out.push({ name: cand.name, a, b, r2 });
  }
  out.sort((p, q) => q.r2 - p.r2);
  return out;
}

// ---- the network --------------------------------------------------------------------

export interface KANSpec {
  inDim: number;
  hidden: number[];
  outDim: number;
  gridSize: number;
  degree: number;
  domain: number; // input layer grid spans [-domain, domain]; hidden layers start wider
}

export interface LayerCurves {
  inF: number;
  outF: number;
  lo: number;
  hi: number;
  gridSize: number;
  edges: EdgeCurve[];
}

export interface ModeSummary {
  spline: number;
  symbolic: number;
  pruned: number;
  total: number;
}

export interface CompiledFormula extends ModeSummary {
  formulas: string[]; // one closed-form (or partly-symbolic) expression per output node
  coverage: number; // fraction of edges that are no longer opaque splines (symbolic + pruned) / total
}

// Wrap a sub-expression in parentheses unless it is a bare variable or number (so substituting it
// into a scaled/parenthesised template stays unambiguous).
function paren(expr: string): string {
  if (/^-?[a-zA-Z0-9.₀₁₂₃₄₅₆₇₈₉]+$/.test(expr)) return expr;
  if (expr.startsWith('(') && expr.endsWith(')')) return expr;
  return `(${expr})`;
}

// Join a list of edge terms and one folded constant into a readable sum, so the printed node reads
// "1.49·sin(π·x) − 0.30" rather than "−0.30 + 1.49·sin(π·x) + …". Leading-minus terms fold into a
// subtraction; the constant (all biases + symbolic offsets, summed) is appended once at the end.
function joinTerms(constant: number, terms: string[]): string {
  let s = '';
  for (const t of terms) {
    if (t === '' || t === '0') continue;
    if (s === '') s = t;
    else if (t.startsWith('−') || t.startsWith('-')) s += ` − ${t.slice(1)}`;
    else s += ` + ${t}`;
  }
  if (Math.abs(constant) >= 5e-3) {
    const c = fmtCoef(Math.abs(constant));
    if (s === '') s = fmtCoef(constant);
    else s += constant >= 0 ? ` + ${c}` : ` − ${c}`;
  }
  return s === '' ? '0' : s;
}

export class KAN {
  layers: KANLayer[] = [];
  readonly spec: KANSpec;

  constructor(spec: KANSpec, rng: () => number) {
    this.spec = spec;
    const dims = [spec.inDim, ...spec.hidden, spec.outDim];
    for (let l = 0; l < dims.length - 1; l++) {
      // The input layer is bounded by the data domain; hidden layers see wider pre-activations,
      // so give them a roomier initial grid (refittable to the real range later).
      const span = l === 0 ? spec.domain : spec.domain * 2;
      const grid = makeGrid(spec.gridSize, spec.degree, -span, span);
      this.layers.push(new KANLayer(dims[l], dims[l + 1], grid, rng));
    }
  }

  // Training forward: returns raw outputs [B, outDim] (logits for CE, value for MSE).
  forward(x: Tensor): Tensor {
    let h = x;
    for (const layer of this.layers) h = layer.forward(h);
    return h;
  }

  // Inference forward (no tape): returns the flat output and the per-layer pre-activations so
  // grid-fitting can recentre each layer onto the values it actually sees.
  infer(xData: Float64Array, rows: number): { out: Float64Array; acts: Float64Array[] } {
    let h = xData;
    let cols = this.spec.inDim;
    const acts: Float64Array[] = [h];
    for (const layer of this.layers) {
      h = layer.evalNumeric(h, rows);
      cols = layer.outF;
      acts.push(h);
    }
    void cols;
    return { out: h, acts };
  }

  // Sample every edge of every layer for the KAN diagram.
  layerCurves(samples = 48): LayerCurves[] {
    return this.layers.map((layer) => {
      const edges: EdgeCurve[] = [];
      for (let i = 0; i < layer.inF; i++) for (let j = 0; j < layer.outF; j++) edges.push(layer.edgeCurve(i, j, samples));
      return { inF: layer.inF, outF: layer.outF, lo: layer.grid.lo, hi: layer.grid.hi, gridSize: layer.grid.gridSize, edges };
    });
  }

  // Grid extension: change the spline resolution of every layer while preserving the learned
  // functions (the headline KAN capability). Returns the new per-layer grid size.
  setGridSize(gridSize: number): number {
    const G = Math.max(2, Math.min(48, Math.round(gridSize)));
    for (const layer of this.layers) {
      const ng = makeGrid(G, layer.grid.degree, layer.grid.lo, layer.grid.hi);
      layer.refitToGrid(ng);
    }
    return G;
  }

  // Re-centre each layer's grid onto the actual range of activations it receives (with a margin),
  // refitting coefficients to preserve the curves. Pass the inference activations from `infer`.
  fitGridToData(acts: Float64Array[], rows: number, margin = 0.1): void {
    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const a = acts[l];
      const cols = layer.inF;
      let lo = Infinity;
      let hi = -Infinity;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = a[r * cols + c];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-6) continue;
      const pad = (hi - lo) * margin;
      const ng = makeGrid(layer.grid.gridSize, layer.grid.degree, lo - pad, hi + pad);
      layer.refitToGrid(ng);
    }
  }

  // ---- interpretability: sparsify → prune → snap → compile ---------------------------

  // Structured (group-lasso) sparsification. For every *live spline* edge we add a sub-gradient of
  // λ·‖(w_b, c)‖₂ — the L2 norm of the whole edge's parameter group — which drives entire edges
  // (not just individual coefficients) toward zero, the structured sparsity that makes an edge
  // safely prunable. Applied straight to `.grad` after `backward()`, so it needs no new tape op;
  // returns the penalty value to fold into the reported loss. Frozen edges are left untouched.
  addGroupLassoGrad(lambda: number): number {
    if (lambda <= 0) return 0;
    let penalty = 0;
    for (const layer of this.layers) {
      const N = layer.grid.numBasis;
      const ba = layer.base.data;
      const gb = layer.base.grad;
      const ca = layer.coeff.data;
      const gc = layer.coeff.grad;
      const E = layer.inF * layer.outF;
      for (let e = 0; e < E; e++) {
        if (layer.modes[e] !== 'spline') continue;
        let sq = ba[e] * ba[e];
        const cb = e * N;
        for (let k = 0; k < N; k++) sq += ca[cb + k] * ca[cb + k];
        const norm = Math.sqrt(sq);
        penalty += lambda * norm;
        if (norm < 1e-12) continue;
        gb[e] += (lambda * ba[e]) / norm;
        for (let k = 0; k < N; k++) gc[cb + k] += (lambda * ca[cb + k]) / norm;
      }
    }
    return penalty;
  }

  // Prune every live spline edge whose importance (mean |φ| over the grid) falls below τ.
  autoPrune(tau: number): number {
    let n = 0;
    for (const layer of this.layers) {
      for (let i = 0; i < layer.inF; i++) {
        for (let j = 0; j < layer.outF; j++) {
          if (layer.edgeMode(i, j) !== 'spline') continue;
          if (layer.edgeCurve(i, j, 40).importance < tau) {
            layer.pruneEdge(i, j);
            n++;
          }
        }
      }
    }
    return n;
  }

  // Snap every live spline edge whose best elementary fit reaches R² ≥ r2min to that formula.
  autoSnap(r2min: number): number {
    let n = 0;
    for (const layer of this.layers) {
      for (let i = 0; i < layer.inF; i++) {
        for (let j = 0; j < layer.outF; j++) {
          if (layer.edgeMode(i, j) !== 'spline') continue;
          const fit = layer.snapEdge(i, j);
          if (fit && fit.r2 >= r2min) n++;
          else layer.resetEdge(i, j); // fit too poor — leave it a spline
        }
      }
    }
    return n;
  }

  resetAllEdges(): void {
    for (const layer of this.layers) {
      for (let i = 0; i < layer.inF; i++) for (let j = 0; j < layer.outF; j++) layer.resetEdge(i, j);
    }
  }

  modeSummary(): ModeSummary {
    const s: ModeSummary = { spline: 0, symbolic: 0, pruned: 0, total: 0 };
    for (const layer of this.layers) {
      for (const m of layer.modes) {
        s[m]++;
        s.total++;
      }
    }
    return s;
  }

  // Walk the layers, substituting each symbolic edge's printed form into its input expression and
  // dropping pruned edges, to render the whole network as one closed-form expression per output —
  // the KAN paper's promise, made literal. Spline edges that were never snapped stay as opaque
  // φ(...) placeholders, so the coverage bar tells you how much of the model is now readable.
  compileFormula(): CompiledFormula {
    const inDim = this.spec.inDim;
    const baseNames = ['x', 'y', 'z', 'u', 'v', 'w'];
    let exprs: string[] = Array.from({ length: inDim }, (_, i) => baseNames[i] ?? `x${i + 1}`);
    for (const layer of this.layers) {
      const next: string[] = [];
      for (let j = 0; j < layer.outF; j++) {
        const terms: string[] = [];
        let constant = layer.bias.data[j];
        for (let i = 0; i < layer.inF; i++) {
          const e = i * layer.outF + j;
          const mode = layer.modes[e];
          if (mode === 'pruned') continue;
          const inner = paren(exprs[i]);
          if (mode === 'symbolic') {
            const cand = SYMBOLIC_LIBRARY[layer.symIdx[e]];
            const a = layer.symA[e];
            constant += layer.symB[e]; // fold the edge's affine offset into the node constant
            if (cand.name === '1' || Math.abs(a) < 1e-9) continue; // pure constant, already folded
            const scale = Math.abs(a - 1) < 1e-9 ? '' : Math.abs(a + 1) < 1e-9 ? '−' : `${fmtCoef(a)}·`;
            terms.push(`${scale}${cand.tmpl(inner)}`);
          } else {
            terms.push(`φ(${exprs[i]})`);
          }
        }
        next.push(joinTerms(constant, terms));
      }
      exprs = next;
    }
    const s = this.modeSummary();
    const coverage = s.total > 0 ? (s.symbolic + s.pruned) / s.total : 0;
    return { formulas: exprs, coverage, ...s };
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.layers) ps.push(...l.parameters());
    return ps;
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }

  exportWeights(): number[] {
    const out: number[] = [];
    for (const p of this.parameters()) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
    return out;
  }

  importWeights(flat: number[]): boolean {
    const ps = this.parameters();
    let total = 0;
    for (const p of ps) total += p.size;
    if (flat.length !== total) return false;
    let k = 0;
    for (const p of ps) for (let i = 0; i < p.size; i++) p.data[i] = flat[k++];
    return true;
  }
}
