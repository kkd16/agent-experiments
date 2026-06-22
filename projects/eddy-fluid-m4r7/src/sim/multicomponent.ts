// multicomponent.ts — a from-scratch MULTI-COMPONENT Shan–Chen lattice Boltzmann
// solver: TWO DISTINCT, IMMISCIBLE FLUIDS (not two phases of one fluid), each
// with its own D2Q9 distribution, coupled by a short-range REPULSION.
//
// `multiphase.ts` already carries one fluid that splits into a dense liquid and a
// thin vapour (a van-der-Waals loop in ONE equation of state). This file carries
// the *other* canonical Shan–Chen model — Shan & Chen (1993) / Shan & Doolen
// (1995): two separate species, "red" and "blue", that each obey their own
// lattice-Boltzmann equation and feel a mutual cohesion
//
//     F_σ(x) = −ψ_σ(x) · Σ_{σ'≠σ} G_{σσ'} · Σ_i w_i ψ_{σ'}(x + e_i) e_i        (σ ∈ {1,2})
//
// With a single positive cross-coupling G (≡ G₁₂ = G₂₁) and the linear
// pseudopotential ψ_σ = ρ_σ, each species is pushed *away* from the other:
//
//     F_1(x) = −G · ρ_1(x) · Σ_i w_i ρ_2(x + e_i) e_i,
//     F_2(x) = −G · ρ_2(x) · Σ_i w_i ρ_1(x + e_i) e_i.
//
// Above a critical G the well-mixed state is unstable and the two fluids
// *demix* into nearly pure red and blue domains separated by a thin diffuse
// interface that carries a real, isotropic **surface tension** — no interface
// tracking, no level set, no front reconstruction. The total non-ideal pressure
// of the binary mixture is
//
//     p(x) = c_s² (ρ_1 + ρ_2) + c_s² G ρ_1 ρ_2,
//
// and the curvature jump across a circular drop of one fluid embedded in the
// other obeys Laplace's law Δp = σ/R (a measured, not assumed, σ — see the
// Verify page).
//
// Forcing is the classic Shan–Chen velocity-shift scheme (the one for which the
// model was first written down): the two species share a momentum-conserving
// **common velocity**
//
//     u' = (Σ_σ ω_σ Σ_i f^σ_i e_i) / (Σ_σ ω_σ ρ_σ),     ω_σ = 1/τ_σ,
//
// and each species relaxes toward its own equilibrium evaluated at the
// force-shifted velocity u^eq_σ = u' + τ_σ F_σ / ρ_σ. When both species share a
// relaxation time the interaction injects ZERO net momentum (the pairwise force
// is antisymmetric, ΣF = 0), which the self-tests pin down to round-off.
//
// On top of the cohesion this carries:
//   • per-species fluid–solid ADHESION (a wall pseudopotential): the *difference*
//     G_ads,1 − G_ads,2 sets which fluid wets the wall, i.e. the contact angle,
//   • a momentum-conserving, density-weighted BODY FORCE with a per-species
//     buoyancy weight so a heavy fluid can sit over a light one — the
//     Rayleigh–Taylor instability — without spuriously accelerating the box,
//   • two-layer / drop-in-fluid / liquid-thread (Rayleigh–Plateau) / mixed-noise
//     initialisers, and red/blue mass, momentum, phase-field, anti-correlation,
//     pressure and spurious-current diagnostics.
// Pure and DOM-free, so the whole thing is checkable headlessly.

import { EX, EY, W, OPP, Q, INV_CS2, CS2, feq } from './lbm';

export type McCollision = 'bgk';

export interface McConfig {
  nx: number;
  ny: number;
  /** Kinematic viscosity (shared by both species) → τ via ν = c_s²(τ−½).
   *  Sharing τ makes the inter-species force exactly momentum conserving. */
  viscosity: number;
  /** Cross-coupling G ≡ G₁₂. Positive G repels the species; above a critical
   *  value (≈ 1.5/ρ̄ for ψ = ρ) the mixed state demixes into pure domains. */
  G: number;
  /** Fluid-1 ↔ solid adhesion (a wall pseudopotential). */
  Gads1: number;
  /** Fluid-2 ↔ solid adhesion. The difference (Gads1 − Gads2) sets the contact angle. */
  Gads2: number;
  /** Vertical body-force scale (lattice units, negative = down). */
  gravityY: number;
  /** Per-species buoyancy weight multiplying gravity (heavy ≈ 1, light ≈ 0). */
  weight1: number;
  weight2: number;
  collision: McCollision;
}

export const DEFAULT_MC: McConfig = {
  nx: 200,
  ny: 140,
  viscosity: 1 / 6, // τ = 1, ω = 1 — the classic stable Shan–Chen relaxation
  G: 1.8,
  Gads1: 0,
  Gads2: 0,
  gravityY: 0,
  weight1: 1,
  weight2: 1,
  collision: 'bgk',
};

export class ShanChenMulti {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  cfg: McConfig;

  // Two interleaved-by-direction distributions (layout f[k*n + node]).
  f1: Float64Array;
  f2: Float64Array;
  f1tmp: Float64Array;
  f2tmp: Float64Array;

  rho1: Float64Array;
  rho2: Float64Array;
  // The barycentric (mixture) velocity, for rendering / diagnostics.
  ux: Float64Array;
  uy: Float64Array;

  // Per-species force fields (cohesion + adhesion + gravity), refreshed each step.
  fx1: Float64Array;
  fy1: Float64Array;
  fx2: Float64Array;
  fy2: Float64Array;

  solid: Uint8Array;

  tau: number;
  omega: number;
  steps = 0;

  constructor(cfg: Partial<McConfig> = {}) {
    this.cfg = { ...DEFAULT_MC, ...cfg };
    this.nx = this.cfg.nx;
    this.ny = this.cfg.ny;
    this.n = this.nx * this.ny;
    this.f1 = new Float64Array(Q * this.n);
    this.f2 = new Float64Array(Q * this.n);
    this.f1tmp = new Float64Array(Q * this.n);
    this.f2tmp = new Float64Array(Q * this.n);
    this.rho1 = new Float64Array(this.n);
    this.rho2 = new Float64Array(this.n);
    this.ux = new Float64Array(this.n);
    this.uy = new Float64Array(this.n);
    this.fx1 = new Float64Array(this.n);
    this.fy1 = new Float64Array(this.n);
    this.fx2 = new Float64Array(this.n);
    this.fy2 = new Float64Array(this.n);
    this.solid = new Uint8Array(this.n);
    this.tau = 1;
    this.omega = 1;
    this.refreshRelaxation();
  }

  idx(i: number, j: number): number {
    return i + this.nx * j;
  }

  refreshRelaxation(): void {
    this.tau = this.cfg.viscosity * INV_CS2 + 0.5;
    this.omega = 1 / this.tau;
  }

  setG(G: number): void {
    this.cfg.G = G;
  }

  // --- initialisers ------------------------------------------------------------

  /** Set both density fields from a callback (init at zero velocity, local f^eq). */
  initFields(fn: (i: number, j: number) => { r1: number; r2: number }): void {
    const { f1, f2, n, nx, ny } = this;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        const { r1, r2 } = fn(i, j);
        for (let k = 0; k < Q; k++) {
          f1[k * n + node] = feq(k, r1, 0, 0);
          f2[k * n + node] = feq(k, r2, 0, 0);
        }
      }
    this.refreshMacro();
    this.steps = 0;
  }

  /** A well-mixed binary fluid: both species present everywhere near `mean`, each
   *  with its OWN independent tiny density noise (so the initial species
   *  correlation is ≈ 0). This is the spinodal seed a demixing run grows domains
   *  from — above the critical coupling the two fluids separate into nearly pure
   *  regions; below it they stay blended. */
  initMixed(mean = 1, amp = 0.05, seed = 7): void {
    let s = seed >>> 0;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff - 0.5;
    };
    this.initFields(() => ({ r1: mean + amp * rnd(), r2: mean + amp * rnd() }));
  }

  /** Mean local purity ⟨|φ|⟩ over fluid sites, φ = (ρ1−ρ2)/(ρ1+ρ2). ≈ 0 when the
   *  fluids are blended, → 1 once they have demixed into pure domains. */
  meanPurity(): number {
    let s = 0;
    let n = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      s += Math.abs(this.phaseAt(node));
      n++;
    }
    return n > 0 ? s / n : 0;
  }

  /** Two stacked layers: fluid-1 fills the top, fluid-2 the bottom, with a smooth
   *  tanh interface of half-width `w` cells at height `cy`. A small sinusoidal
   *  ripple (`pert`) seeds the Rayleigh–Taylor instability deterministically. */
  initTwoLayer(cy: number, rho = 1, w = 1.5, pert = 0, kx = 1, top1 = true): void {
    const { nx } = this;
    this.initFields((i, j) => {
      const ripple = pert * Math.sin((2 * Math.PI * kx * i) / nx);
      const d = j - (cy + ripple);
      // s → 1 in the top layer, 0 in the bottom.
      const s = 0.5 * (1 + Math.tanh(d / w));
      const sTop = top1 ? s : 1 - s;
      return { r1: rho * sTop + 0.02 * (1 - sTop), r2: rho * (1 - sTop) + 0.02 * sTop };
    });
  }

  /** A circular drop of fluid-1 (radius `r` at `cx,cy`) embedded in fluid-2. */
  initDrop(cx: number, cy: number, r: number, rho = 1, w = 1.5): void {
    this.initFields((i, j) => {
      const d = Math.hypot(i - cx, j - cy) - r;
      const s = 0.5 * (1 - Math.tanh(d / w)); // 1 inside the drop
      return { r1: rho * s + 0.02 * (1 - s), r2: rho * (1 - s) + 0.02 * s };
    });
  }

  /** A horizontal liquid THREAD of fluid-1 (half-thickness `half` at row `cy`)
   *  surrounded by fluid-2, with a sinusoidal varicose pinch — the
   *  Rayleigh–Plateau setup, where surface tension breaks the thread into drops. */
  initThread(cy: number, half: number, rho = 1, w = 1.5, pert = 0, kx = 3): void {
    const { nx } = this;
    this.initFields((i, j) => {
      const local = half * (1 + pert * Math.cos((2 * Math.PI * kx * i) / nx));
      const d = Math.abs(j - cy) - local;
      const s = 0.5 * (1 - Math.tanh(d / w)); // 1 inside the thread
      return { r1: rho * s + 0.02 * (1 - s), r2: rho * (1 - s) + 0.02 * s };
    });
  }

  /** Overwrite a disc with fluid-1 at velocity (0, uy) (drip a fresh red drop). */
  stampDrop(cx: number, cy: number, r: number, rho: number, uy = 0): void {
    const { f1, f2, n } = this;
    for (let j = Math.max(0, Math.floor(cy - r)); j < Math.min(this.ny, Math.ceil(cy + r) + 1); j++)
      for (let i = Math.max(0, Math.floor(cx - r)); i < Math.min(this.nx, Math.ceil(cx + r) + 1); i++) {
        if ((i - cx) * (i - cx) + (j - cy) * (j - cy) > r * r) continue;
        const node = this.idx(i, j);
        if (this.solid[node]) continue;
        for (let k = 0; k < Q; k++) {
          f1[k * n + node] = feq(k, rho, 0, uy);
          f2[k * n + node] = feq(k, 0.02, 0, uy);
        }
      }
    this.refreshMacro();
  }

  addDisc(cx: number, cy: number, r: number): void {
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++)
        if ((i - cx) * (i - cx) + (j - cy) * (j - cy) <= r * r) this.solid[this.idx(i, j)] = 1;
  }

  addFloor(h: number, ceiling = false): void {
    for (let i = 0; i < this.nx; i++) {
      for (let j = 0; j < h; j++) this.solid[this.idx(i, j)] = 1;
      if (ceiling) for (let j = this.ny - h; j < this.ny; j++) this.solid[this.idx(i, j)] = 1;
    }
  }

  clearSolids(): void {
    this.solid.fill(0);
  }

  // --- macroscopic moments -----------------------------------------------------

  /** ρ_σ = Σf^σ at every fluid site. */
  refreshMacro(): void {
    const { f1, f2, n, rho1, rho2 } = this;
    for (let node = 0; node < n; node++) {
      if (this.solid[node]) {
        rho1[node] = 0;
        rho2[node] = 0;
        continue;
      }
      let r1 = 0;
      let r2 = 0;
      for (let i = 0; i < Q; i++) {
        r1 += f1[i * n + node];
        r2 += f2[i * n + node];
      }
      rho1[node] = r1;
      rho2[node] = r2;
    }
  }

  /** The Shan–Chen cross-cohesion (each species pulled away from the other),
   *  per-species fluid–solid adhesion, and a momentum-conserving body force.
   *  Periodic neighbours; a solid neighbour contributes to adhesion (indicator)
   *  not cohesion. With ψ_σ = ρ_σ. */
  private refreshForce(): void {
    const { nx, ny, rho1, rho2, fx1, fy1, fx2, fy2, cfg } = this;
    const G = cfg.G;
    const Ga1 = cfg.Gads1;
    const Ga2 = cfg.Gads2;
    const g = cfg.gravityY;

    // Mean body force (per direction) for momentum-conserving gravity: subtract
    // the average so the total injected momentum is exactly zero.
    let meanFy = 0;
    let cnt = 0;
    if (g !== 0) {
      for (let node = 0; node < this.n; node++)
        if (!this.solid[node]) {
          meanFy += g * (cfg.weight1 * rho1[node] + cfg.weight2 * rho2[node]);
          cnt++;
        }
      meanFy = cnt > 0 ? meanFy / cnt : 0;
    }

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) {
          fx1[node] = fy1[node] = fx2[node] = fy2[node] = 0;
          continue;
        }
        // Neighbour-weighted pseudopotential sums of each species, plus the solid
        // indicator (for adhesion).
        let s1x = 0;
        let s1y = 0;
        let s2x = 0;
        let s2y = 0;
        let solX = 0;
        let solY = 0;
        for (let k = 1; k < Q; k++) {
          let ni = i + EX[k];
          let nj = j + EY[k];
          if (ni < 0) ni += nx;
          else if (ni >= nx) ni -= nx;
          if (nj < 0) nj += ny;
          else if (nj >= ny) nj -= ny;
          const nb = ni + nx * nj;
          if (this.solid[nb]) {
            solX += W[k] * EX[k];
            solY += W[k] * EY[k];
          } else {
            s1x += W[k] * rho1[nb] * EX[k];
            s1y += W[k] * rho1[nb] * EY[k];
            s2x += W[k] * rho2[nb] * EX[k];
            s2y += W[k] * rho2[nb] * EY[k];
          }
        }
        const p1 = rho1[node];
        const p2 = rho2[node];
        // Cross-cohesion: species 1 feels neighbours' species-2 pseudopotential.
        const F1x = -G * p1 * s2x + Ga1 * p1 * solX;
        const F2x = -G * p2 * s1x + Ga2 * p2 * solX;
        let F1y = -G * p1 * s2y + Ga1 * p1 * solY;
        let F2y = -G * p2 * s1y + Ga2 * p2 * solY;
        if (g !== 0) {
          F1y += g * cfg.weight1 * p1 - (meanFy * cfg.weight1 * p1) / (cfg.weight1 * p1 + cfg.weight2 * p2 || 1);
          F2y += g * cfg.weight2 * p2 - (meanFy * cfg.weight2 * p2) / (cfg.weight1 * p1 + cfg.weight2 * p2 || 1);
        }
        fx1[node] = F1x;
        fy1[node] = F1y;
        fx2[node] = F2x;
        fy2[node] = F2y;
      }
    }
  }

  // --- one lattice step --------------------------------------------------------

  step(): void {
    this.refreshForce();
    this.collide();
    this.stream();
    let t = this.f1;
    this.f1 = this.f1tmp;
    this.f1tmp = t;
    t = this.f2;
    this.f2 = this.f2tmp;
    this.f2tmp = t;
    this.refreshMacro();
    this.refreshVel();
    this.steps++;
  }

  /** BGK collision with the Shan–Chen velocity-shift forcing: both species relax
   *  toward equilibria evaluated at the shared common velocity, each shifted by
   *  τ_σ F_σ/ρ_σ. */
  private collide(): void {
    const { f1, f2, n, fx1, fy1, fx2, fy2 } = this;
    const omega = this.omega;
    const tau = this.tau;
    const eq1 = new Float64Array(Q);
    const eq2 = new Float64Array(Q);

    for (let node = 0; node < n; node++) {
      if (this.solid[node]) continue;

      let r1 = 0;
      let m1x = 0;
      let m1y = 0;
      let r2 = 0;
      let m2x = 0;
      let m2y = 0;
      for (let i = 0; i < Q; i++) {
        const a = f1[i * n + node];
        const b = f2[i * n + node];
        r1 += a;
        m1x += EX[i] * a;
        m1y += EY[i] * a;
        r2 += b;
        m2x += EX[i] * b;
        m2y += EY[i] * b;
      }
      // Common velocity (equal ω): u' = (m1+m2)/(ρ1+ρ2).
      const rt = r1 + r2;
      const ucx = rt > 1e-12 ? (m1x + m2x) / rt : 0;
      const ucy = rt > 1e-12 ? (m1y + m2y) / rt : 0;

      // Force-shifted equilibrium velocity per species.
      const u1x = ucx + (tau * fx1[node]) / (r1 || 1);
      const u1y = ucy + (tau * fy1[node]) / (r1 || 1);
      const u2x = ucx + (tau * fx2[node]) / (r2 || 1);
      const u2y = ucy + (tau * fy2[node]) / (r2 || 1);

      for (let i = 0; i < Q; i++) {
        eq1[i] = feq(i, r1, u1x, u1y);
        eq2[i] = feq(i, r2, u2x, u2y);
      }
      for (let i = 0; i < Q; i++) {
        const o = i * n + node;
        f1[o] += -omega * (f1[o] - eq1[i]);
        f2[o] += -omega * (f2[o] - eq2[i]);
      }
    }
  }

  private stream(): void {
    const { f1, f2, f1tmp, f2tmp, n, nx, ny } = this;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) continue;
        for (let k = 0; k < Q; k++) {
          let si = i - EX[k];
          let sj = j - EY[k];
          if (si < 0) si += nx;
          else if (si >= nx) si -= nx;
          if (sj < 0) sj += ny;
          else if (sj >= ny) sj -= ny;
          const src = si + nx * sj;
          const dst = k * n + node;
          if (this.solid[src]) {
            // Half-way bounce-back of this node's opposite link.
            f1tmp[dst] = f1[OPP[k] * n + node];
            f2tmp[dst] = f2[OPP[k] * n + node];
          } else {
            f1tmp[dst] = f1[k * n + src];
            f2tmp[dst] = f2[k * n + src];
          }
        }
      }
    }
  }

  /** Barycentric velocity u = (m1 + m2 + ½(F1+F2)) / (ρ1+ρ2). */
  private refreshVel(): void {
    const { f1, f2, n, ux, uy, fx1, fy1, fx2, fy2 } = this;
    for (let node = 0; node < n; node++) {
      if (this.solid[node]) {
        ux[node] = 0;
        uy[node] = 0;
        continue;
      }
      let mx = 0;
      let my = 0;
      let rt = 0;
      for (let i = 0; i < Q; i++) {
        const a = f1[i * n + node];
        const b = f2[i * n + node];
        mx += EX[i] * (a + b);
        my += EY[i] * (a + b);
        rt += a + b;
      }
      const fxT = fx1[node] + fx2[node];
      const fyT = fy1[node] + fy2[node];
      ux[node] = rt > 1e-12 ? (mx + 0.5 * fxT) / rt : 0;
      uy[node] = rt > 1e-12 ? (my + 0.5 * fyT) / rt : 0;
    }
  }

  // --- diagnostics -------------------------------------------------------------

  /** Total non-ideal mixture pressure p = c_s²(ρ1+ρ2) + c_s² G ρ1 ρ2 at a site. */
  pressureAt(node: number): number {
    return CS2 * (this.rho1[node] + this.rho2[node]) + CS2 * this.cfg.G * this.rho1[node] * this.rho2[node];
  }

  /** Phase field φ = (ρ1 − ρ2)/(ρ1 + ρ2) ∈ [−1,1]: +1 pure fluid-1, −1 pure fluid-2. */
  phaseAt(node: number): number {
    const s = this.rho1[node] + this.rho2[node];
    return s > 1e-9 ? (this.rho1[node] - this.rho2[node]) / s : 0;
  }

  masses(): { m1: number; m2: number } {
    let m1 = 0;
    let m2 = 0;
    for (let node = 0; node < this.n; node++)
      if (!this.solid[node]) {
        m1 += this.rho1[node];
        m2 += this.rho2[node];
      }
    return { m1, m2 };
  }

  totalMomentum(): { px: number; py: number } {
    let px = 0;
    let py = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      const rt = this.rho1[node] + this.rho2[node];
      px += rt * this.ux[node];
      py += rt * this.uy[node];
    }
    return { px, py };
  }

  /** Pearson correlation between ρ1 and ρ2 over fluid sites. Demixing drives this
   *  strongly NEGATIVE (where one fluid is dense, the other is dilute). */
  speciesCorrelation(): number {
    let n = 0;
    let s1 = 0;
    let s2 = 0;
    let s11 = 0;
    let s22 = 0;
    let s12 = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      const a = this.rho1[node];
      const b = this.rho2[node];
      n++;
      s1 += a;
      s2 += b;
      s11 += a * a;
      s22 += b * b;
      s12 += a * b;
    }
    if (n === 0) return 0;
    const cov = s12 / n - (s1 / n) * (s2 / n);
    const v1 = s11 / n - (s1 / n) * (s1 / n);
    const v2 = s22 / n - (s2 / n) * (s2 / n);
    const d = Math.sqrt(v1 * v2);
    return d > 1e-12 ? cov / d : 0;
  }

  maxSpuriousSpeed(): number {
    let m = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      const s = Math.hypot(this.ux[node], this.uy[node]);
      if (s > m) m = s;
    }
    return m;
  }
}
