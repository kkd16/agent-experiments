// multigrid.ts — a from-scratch geometric multigrid solver for the pressure
// Poisson equation, with embedded solid obstacles.
//
// Stationary relaxation (Gauss–Seidel/SOR) and even Krylov methods (CG) share a
// weakness: they kill *high-frequency* error fast but crawl on the *smooth*,
// long-wavelength error — exactly the part of the pressure field that matters for
// incompressibility. Their convergence therefore slows as the grid grows: the
// number of sweeps to a fixed tolerance scales like O(N) (SOR) or O(N) for CG on
// the 2-D Poisson spectrum. **Multigrid** fixes this by recognising that smooth
// error on a fine grid looks *oscillatory* on a coarser one — where a cheap
// relaxation can knock it down. A V-cycle smooths on the fine grid, restricts the
// residual to a 2× coarser grid, recurses (so every error wavelength is resolved
// on the grid where it is oscillatory), prolongs the coarse correction back, and
// smooths again. The result is a solver whose convergence factor is bounded
// *independent of N* — the textbook O(N) (work-optimal) Poisson solver.
//
// This is a cell-centred geometric multigrid:
//   • smoother    — red-black Gauss–Seidel on the exact 5-point Neumann/obstacle
//                   Laplacian (the same operator `fluid.ts`'s SOR & CG relax),
//   • restriction — the transpose of the prolongation (R = Pᵀ), so a symmetric
//                   V-cycle is a symmetric operator — which lets it double as an
//                   SPD preconditioner inside Conjugate Gradients (MGCG),
//   • prolongation— cell-centred bilinear interpolation (the ¾/¼ weights),
//                   masked + renormalised at solid faces and domain walls,
//   • coarsening  — a 2×2 agglomeration; a coarse cell is fluid iff any of its
//                   four fine children is fluid, and the coarse operator is the
//                   graph Laplacian rediscretised on that coarsened mask.
//
// The pure-Neumann system is singular (its null space is the constants), so every
// right-hand side is projected to be mean-zero (the compatibility condition) and
// the coarse corrections have their mean removed before prolongation — only the
// pressure *gradient* is ever used downstream, so the constant mode is irrelevant.

export interface MGLevel {
  n: number; // interior cells per side at this level
  S: number; // stride = n + 2 (one ghost ring)
  solid: Uint8Array; // 1 = wall
  diag: Float32Array; // count of valid (in-domain, fluid) neighbours; ≥1 for fluid
  x: Float32Array; // solution / correction
  b: Float32Array; // right-hand side
  r: Float32Array; // residual scratch
}

export class Multigrid {
  readonly N: number;
  readonly levels: MGLevel[] = [];

  /** Sweeps used to "solve" the coarsest grid (a handful of cells). */
  coarseIters = 40;

  constructor(N: number, minCoarse = 4) {
    this.N = N;
    let n = N;
    for (;;) {
      const S = n + 2;
      this.levels.push({
        n,
        S,
        solid: new Uint8Array(S * S),
        diag: new Float32Array(S * S),
        x: new Float32Array(S * S),
        b: new Float32Array(S * S),
        r: new Float32Array(S * S),
      });
      if (n % 2 !== 0 || n / 2 < minCoarse) break;
      n = n / 2;
    }
  }

  get depth(): number {
    return this.levels.length;
  }

  /**
   * Rebuild the obstacle hierarchy from the fine grid's solid mask. A coarse cell
   * is solid only when *all four* of its fine children are solid, so fluid stays
   * connected across the coarsening (otherwise a thin channel could pinch shut on
   * a coarse grid and the correction couldn't carry information through it). Then
   * recompute each level's diagonal (its count of valid neighbours).
   */
  setSolid(fineSolid: Uint8Array): void {
    const L0 = this.levels[0];
    L0.solid.set(fineSolid);
    for (let l = 1; l < this.levels.length; l++) {
      const Lf = this.levels[l - 1];
      const Lc = this.levels[l];
      const sf = Lf.solid;
      const sc = Lc.solid;
      const Sf = Lf.S;
      const Sc = Lc.S;
      sc.fill(0);
      for (let J = 1; J <= Lc.n; J++) {
        for (let I = 1; I <= Lc.n; I++) {
          const fi = 2 * I - 1;
          const fj = 2 * J - 1;
          const a = sf[fi + Sf * fj];
          const b = sf[fi + 1 + Sf * fj];
          const c = sf[fi + Sf * (fj + 1)];
          const d = sf[fi + 1 + Sf * (fj + 1)];
          sc[I + Sc * J] = a && b && c && d ? 1 : 0;
        }
      }
    }
    for (const L of this.levels) this.computeDiag(L);
  }

  private computeDiag(L: MGLevel): void {
    const { n, S, solid, diag } = L;
    diag.fill(0);
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        let d = 0;
        if (i > 1 && !solid[idx - 1]) d++;
        if (i < n && !solid[idx + 1]) d++;
        if (j > 1 && !solid[idx - S]) d++;
        if (j < n && !solid[idx + S]) d++;
        diag[idx] = d > 0 ? d : 1; // isolated fluid cell: avoid divide-by-zero
      }
    }
  }

  /** out = A·x on level L, where A is the 5-point Neumann/obstacle Laplacian. */
  applyA(L: MGLevel, x: Float32Array, out: Float32Array): void {
    const { n, S, solid } = L;
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) {
          out[idx] = 0;
          continue;
        }
        let acc = 0;
        if (i > 1 && !solid[idx - 1]) acc += x[idx] - x[idx - 1];
        if (i < n && !solid[idx + 1]) acc += x[idx] - x[idx + 1];
        if (j > 1 && !solid[idx - S]) acc += x[idx] - x[idx - S];
        if (j < n && !solid[idx + S]) acc += x[idx] - x[idx + S];
        out[idx] = acc;
      }
    }
  }

  /** r = b − A·x over the fluid interior. */
  residual(L: MGLevel, x: Float32Array, b: Float32Array, r: Float32Array): void {
    const { n, S, solid } = L;
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) {
          r[idx] = 0;
          continue;
        }
        let acc = 0;
        if (i > 1 && !solid[idx - 1]) acc += x[idx] - x[idx - 1];
        if (i < n && !solid[idx + 1]) acc += x[idx] - x[idx + 1];
        if (j > 1 && !solid[idx - S]) acc += x[idx] - x[idx - S];
        if (j < n && !solid[idx + S]) acc += x[idx] - x[idx + S];
        r[idx] = b[idx] - acc;
      }
    }
  }

  /**
   * Red-black Gauss–Seidel smoothing of A·x = b. The checkerboard colouring makes
   * the sweep order-independent within a colour (the 5-point stencil is bipartite
   * on (i+j) parity). `reverse` swaps the colour order so that a forward pre-smooth
   * and a reverse post-smooth compose into a *symmetric* relaxation — the property
   * that makes the surrounding V-cycle a symmetric (SPD) operator.
   */
  smooth(L: MGLevel, x: Float32Array, b: Float32Array, iters: number, omega: number, reverse = false): void {
    const { n, S, solid, diag } = L;
    for (let k = 0; k < iters; k++) {
      for (let c = 0; c < 2; c++) {
        const color = reverse ? 1 - c : c;
        for (let j = 1; j <= n; j++) {
          for (let i = 1; i <= n; i++) {
            if (((i + j) & 1) !== color) continue;
            const idx = i + S * j;
            if (solid[idx]) continue;
            let sum = 0;
            if (i > 1 && !solid[idx - 1]) sum += x[idx - 1];
            if (i < n && !solid[idx + 1]) sum += x[idx + 1];
            if (j > 1 && !solid[idx - S]) sum += x[idx - S];
            if (j < n && !solid[idx + S]) sum += x[idx + S];
            const gs = (b[idx] + sum) / diag[idx];
            x[idx] = x[idx] + omega * (gs - x[idx]);
          }
        }
      }
    }
  }

  /** Subtract the fluid-mean of x (keep the singular system's solution bounded). */
  subtractMean(L: MGLevel, x: Float32Array): void {
    const { n, S, solid } = L;
    let sum = 0;
    let cnt = 0;
    for (let j = 1; j <= n; j++)
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        sum += x[idx];
        cnt++;
      }
    if (cnt === 0) return;
    const m = sum / cnt;
    for (let j = 1; j <= n; j++)
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (!solid[idx]) x[idx] -= m;
      }
  }

  /**
   * The four coarse cells (and bilinear weights) a fluid fine cell interpolates
   * from. Cell-centred geometry puts a fine centre ¼ of a coarse cell off its
   * parent's centre, giving the classic ¾/¼ weights per axis. Solid / out-of-range
   * coarse cells are dropped and the surviving weights renormalised, so the
   * transfer never reaches through a wall. Returns the number of contributors.
   */
  private stencil(
    Lc: MGLevel,
    i: number,
    j: number,
    outIdx: Int32Array,
    outW: Float32Array,
  ): number {
    const Sc = Lc.S;
    const nc = Lc.n;
    const sc = Lc.solid;
    const I = (i + 1) >> 1; // parent coarse column (ceil(i/2))
    const J = (j + 1) >> 1;
    const nbI = i & 1 ? I - 1 : I + 1; // odd fine col leans to I-1, even to I+1
    const nbJ = j & 1 ? J - 1 : J + 1;
    const cols = [I, nbI];
    const rows = [J, nbJ];
    const wcol = [0.75, 0.25];
    const wrow = [0.75, 0.25];
    let count = 0;
    let wsum = 0;
    for (let a = 0; a < 2; a++) {
      const ci = cols[a];
      if (ci < 1 || ci > nc) continue;
      for (let b = 0; b < 2; b++) {
        const cj = rows[b];
        if (cj < 1 || cj > nc) continue;
        const idx = ci + Sc * cj;
        if (sc[idx]) continue;
        const w = wcol[a] * wrow[b];
        outIdx[count] = idx;
        outW[count] = w;
        wsum += w;
        count++;
      }
    }
    if (count > 0 && wsum > 0) for (let k = 0; k < count; k++) outW[k] /= wsum;
    return count;
  }

  /** Restriction R = Pᵀ: scatter the fine residual onto the coarse RHS. */
  private restrict(Lf: MGLevel, Lc: MGLevel): void {
    const { n, S, solid } = Lf;
    Lc.b.fill(0);
    const idxBuf = this.idxBuf;
    const wBuf = this.wBuf;
    const r = Lf.r;
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        const val = r[idx];
        if (val === 0) continue;
        const c = this.stencil(Lc, i, j, idxBuf, wBuf);
        for (let k = 0; k < c; k++) Lc.b[idxBuf[k]] += wBuf[k] * val;
      }
    }
  }

  /** Prolongation P: add the bilinear interpolation of the coarse correction. */
  private prolongAdd(Lc: MGLevel, Lf: MGLevel): void {
    const { n, S, solid } = Lf;
    const idxBuf = this.idxBuf;
    const wBuf = this.wBuf;
    const cx = Lc.x;
    for (let j = 1; j <= n; j++) {
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        const c = this.stencil(Lc, i, j, idxBuf, wBuf);
        let acc = 0;
        for (let k = 0; k < c; k++) acc += wBuf[k] * cx[idxBuf[k]];
        Lf.x[idx] += acc;
      }
    }
  }

  private idxBuf = new Int32Array(4);
  private wBuf = new Float32Array(4);

  /**
   * One symmetric V-cycle starting at level `l`. Pre-smooth (forward colours),
   * restrict the residual, recurse, prolong the correction, post-smooth (reverse
   * colours). The coarsest grid is "solved" by many cheap sweeps.
   */
  private vcycle(l: number, nu1: number, nu2: number, omega: number): void {
    const L = this.levels[l];
    if (l === this.levels.length - 1) {
      this.smooth(L, L.x, L.b, this.coarseIters, omega);
      this.subtractMean(L, L.x);
      return;
    }
    const Lc = this.levels[l + 1];
    this.smooth(L, L.x, L.b, nu1, omega, false);
    this.residual(L, L.x, L.b, L.r);
    this.restrict(L, Lc);
    Lc.x.fill(0);
    this.makeMeanZero(Lc, Lc.b); // coarse Neumann compatibility
    this.vcycle(l + 1, nu1, nu2, omega);
    this.subtractMean(Lc, Lc.x);
    this.prolongAdd(Lc, L);
    this.smooth(L, L.x, L.b, nu2, omega, true);
  }

  private makeMeanZero(L: MGLevel, b: Float32Array): void {
    const { n, S, solid } = L;
    let sum = 0;
    let cnt = 0;
    for (let j = 1; j <= n; j++)
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        sum += b[idx];
        cnt++;
      }
    if (cnt === 0) return;
    const m = sum / cnt;
    for (let j = 1; j <= n; j++)
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (!solid[idx]) b[idx] -= m;
      }
  }

  /**
   * Solve A·x = b on the fine grid by repeated V-cycles, starting from x ≡ 0.
   * `b` must already be supplied in `levels[0].b`; the answer is left in
   * `levels[0].x`. The fine RHS is projected mean-zero for Neumann compatibility.
   */
  solve(vcycles: number, nu1 = 2, nu2 = 2, omega = 1): void {
    const L0 = this.levels[0];
    L0.x.fill(0);
    this.makeMeanZero(L0, L0.b);
    for (let v = 0; v < vcycles; v++) this.vcycle(0, nu1, nu2, omega);
    this.subtractMean(L0, L0.x);
  }

  /**
   * Apply one V-cycle as a linear preconditioner: given a residual `rIn`, return
   * z ≈ A⁻¹·rIn into `zOut` (zero initial guess, single symmetric V-cycle). Used
   * by the MGCG solver in `fluid.ts`. Operates on `levels[0]`.
   */
  precondition(rIn: Float32Array, zOut: Float32Array, nu1 = 1, nu2 = 1, omega = 1): void {
    const L0 = this.levels[0];
    L0.b.set(rIn);
    L0.x.fill(0);
    this.makeMeanZero(L0, L0.b);
    this.vcycle(0, nu1, nu2, omega);
    this.subtractMean(L0, L0.x);
    zOut.set(L0.x);
  }

  /** Peak |residual| of A·x = b over the fluid interior of `levels[0]`. */
  fineResidualInf(): number {
    const L0 = this.levels[0];
    this.residual(L0, L0.x, L0.b, L0.r);
    let m = 0;
    const { n, S, solid, r } = L0;
    for (let j = 1; j <= n; j++)
      for (let i = 1; i <= n; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        const a = Math.abs(r[idx]);
        if (a > m) m = a;
      }
    return m;
  }
}
