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

export interface EdgeCurve {
  i: number; // input node
  j: number; // output node
  xs: Float64Array; // sample abscissae over [lo, hi]
  ys: Float64Array; // φ_{j,i}(xs)
  importance: number; // mean |φ| over the samples — drives diagram opacity / pruning
}

export class KANLayer {
  readonly inF: number;
  readonly outF: number;
  grid: SplineGrid;
  base: Tensor; // [inF, outF]  SiLU residual weights
  coeff: Tensor; // [inF*outF, numBasis]  spline coefficients per edge
  bias: Tensor; // [1, outF]

  constructor(inF: number, outF: number, grid: SplineGrid, rng: () => number, noisyCoeff = 0.1) {
    this.inF = inF;
    this.outF = outF;
    this.grid = grid;
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
        // spread this input's contribution onto every output node
        for (let j = 0; j < outF; j++) {
          const e = i * outF + j;
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
          const cacheBase = (b * inF + i) * N;
          let gxi = 0;
          for (let j = 0; j < outF; j++) {
            const gy = g[b * outF + j];
            if (gy === 0) continue;
            const e = i * outF + j;
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
    const wb = this.base.data[i * this.outF + j];
    let imp = 0;
    for (let s = 0; s < samples; s++) {
      const x = lo + ((hi - lo) * s) / (samples - 1);
      xs[s] = x;
      const y = wb * silu(x) + this.splineAt(e, x, tmpV, tmpD);
      ys[s] = y;
      imp += Math.abs(y);
    }
    return { i, j, xs, ys, importance: imp / samples };
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
