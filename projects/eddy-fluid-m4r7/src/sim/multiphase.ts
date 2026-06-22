// multiphase.ts — a from-scratch Shan–Chen pseudopotential Lattice Boltzmann
// solver: TWO phases (liquid + vapour) of ONE fluid, with a real surface tension.
//
// The studio's `lbm.ts` already reaches incompressible Navier–Stokes from the
// kinetic bottom up (stream + collide a particle distribution f). This file adds
// the one ingredient that turns a single fluid into a *two-phase* one: a
// short-range attractive force between neighbouring lattice sites. That is the
// whole idea of the **Shan–Chen (1993) pseudopotential** model.
//
// Give every site a pseudopotential ψ(ρ) = ρ₀(1 − e^{−ρ/ρ₀}) (we take ρ₀ = 1) and
// add, as a body force, the cohesion
//
//     F(x) = −G · ψ(x) · Σ_i w_i ψ(x + e_i) e_i           (sum over the 8 links)
//
// — each site is pulled toward its denser neighbours. A Chapman–Enskog expansion
// shows this force gives the fluid a NON-IDEAL equation of state
//
//     p(ρ) = c_s² ρ + ½ c_s² G ψ(ρ)²
//
// For G below a critical value G_c, dp/dρ goes negative over a band of densities
// (a van-der-Waals loop): the fluid is mechanically unstable there and
// spontaneously **separates** into a dense liquid and a thin vapour, with a sharp
// interface ~3 cells wide and a genuine surface tension — no interface tracking,
// no level set, no front reconstruction. For ψ = 1 − e^{−ρ} the critical strength
// is **G_c = −4 exactly** (it is where dp/dρ AND d²p/dρ² vanish together, at
// ρ = ln 2). The `Verify` page pins all of this down: separation only below G_c,
// equal bulk pressures across a flat interface, and **Laplace's law Δp = σ/R**
// measured across droplets of several radii.
//
// Implemented here, all from scratch and reusing the D2Q9 lattice from `lbm.ts`:
//   • the pseudopotential ψ(ρ) and the non-ideal EOS pressure,
//   • the Shan–Chen cohesion force from the 8 neighbours (periodic, with
//     half-way bounce-back / fluid–solid ADHESION off a solid mask → wetting),
//   • Guo (2002) forcing of the spatially varying force, BGK + TRT collision,
//   • a mean-subtracted gravity so liquid drops fall while Σ momentum is still
//     conserved,
//   • droplet / flat-interface / noise / two-drop initialisers and density,
//     pressure and spurious-current diagnostics.
// Pure and DOM-free, so the whole thing is checkable headlessly.

import { EX, EY, W, OPP, Q, INV_CS2, INV_CS4, CS2, feq } from './lbm';

export type ScCollision = 'bgk' | 'trt';

/** The reference density ρ₀ in ψ(ρ) = ρ₀(1 − e^{−ρ/ρ₀}). With ρ₀ = 1 the critical
 *  interaction strength is exactly G_c = −4. */
export const RHO0 = 1;

/** Shan–Chen pseudopotential ψ(ρ) = ρ₀(1 − e^{−ρ/ρ₀}). Monotone, bounded by ρ₀,
 *  and ≈ ρ for small ρ — the standard choice that gives a finite critical G. */
export function psiOf(rho: number): number {
  return RHO0 * (1 - Math.exp(-rho / RHO0));
}

/** The non-ideal Shan–Chen equation of state p = c_s²ρ + ½c_s²G ψ². This is the
 *  *mechanical* pressure (ideal-gas part + the cohesion contribution); its
 *  difference inside vs outside a droplet is the Laplace pressure jump. */
export function pressureOf(rho: number, G: number): number {
  const p = psiOf(rho);
  return CS2 * rho + 0.5 * CS2 * G * p * p;
}

export interface ScConfig {
  nx: number;
  ny: number;
  /** Kinematic viscosity → τ via ν = c_s²(τ−½). τ ≈ 1 (ν = 1/6) is the stable default. */
  viscosity: number;
  /** Interaction strength G. G < −4 (= G_c) separates the fluid into two phases. */
  G: number;
  /** Fluid–solid adhesion (wetting). >0 attracts liquid to the wall (hydrophilic),
   *  <0 repels it (hydrophobic); 0 is a neutral contact angle. */
  Gads: number;
  /** Mean-subtracted vertical body force g (lattice units). Negative pulls dense
   *  fluid in the −y direction; the mean subtraction keeps Σ momentum conserved. */
  gravityY: number;
  collision: ScCollision;
  /** TRT "magic" parameter Λ (3/16 sharpens the interface; ¼ maximises stability). */
  magic: number;
}

export const DEFAULT_SC: ScConfig = {
  nx: 160,
  ny: 120,
  viscosity: 1 / 6, // τ = 1, ω = 1 — the classic stable Shan–Chen relaxation
  G: -5,
  Gads: 0,
  gravityY: 0,
  collision: 'bgk',
  magic: 1 / 4,
};

/** Raw Guo (2002) forcing source S_i for one link (without the (1−ω/2) prefactor,
 *  which the caller applies, split per TRT rate). Identical in spirit to the one
 *  in `lbm.ts`, but the force here varies from site to site (it is the cohesion). */
function guoSource(i: number, ux: number, uy: number, fx: number, fy: number): number {
  const eu = EX[i] * ux + EY[i] * uy;
  const cx = INV_CS2 * (EX[i] - ux) + INV_CS4 * eu * EX[i];
  const cy = INV_CS2 * (EY[i] - uy) + INV_CS4 * eu * EY[i];
  return W[i] * (cx * fx + cy * fy);
}

export class ShanChen {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  cfg: ScConfig;

  f: Float64Array;
  ftmp: Float64Array;

  rho: Float64Array;
  ux: Float64Array;
  uy: Float64Array;

  // Per-site pseudopotential ψ and cohesion+adhesion+gravity force, refreshed
  // each step (the force is the only non-local part of the update).
  psi: Float64Array;
  fx: Float64Array;
  fy: Float64Array;

  solid: Uint8Array;

  tau: number;
  omegaPlus: number;
  omegaMinus: number;
  steps = 0;

  constructor(cfg: Partial<ScConfig> = {}) {
    this.cfg = { ...DEFAULT_SC, ...cfg };
    this.nx = this.cfg.nx;
    this.ny = this.cfg.ny;
    this.n = this.nx * this.ny;
    this.f = new Float64Array(Q * this.n);
    this.ftmp = new Float64Array(Q * this.n);
    this.rho = new Float64Array(this.n);
    this.ux = new Float64Array(this.n);
    this.uy = new Float64Array(this.n);
    this.psi = new Float64Array(this.n);
    this.fx = new Float64Array(this.n);
    this.fy = new Float64Array(this.n);
    this.solid = new Uint8Array(this.n);
    this.tau = 1;
    this.omegaPlus = 1;
    this.omegaMinus = 1;
    this.refreshRelaxation();
    this.initUniform(1);
  }

  idx(i: number, j: number): number {
    return i + this.nx * j;
  }

  refreshRelaxation(): void {
    this.tau = this.cfg.viscosity * INV_CS2 + 0.5;
    this.omegaPlus = 1 / this.tau;
    if (this.cfg.collision === 'bgk') {
      this.omegaMinus = this.omegaPlus;
    } else {
      const tauMinus = 0.5 + this.cfg.magic / (1 / this.omegaPlus - 0.5);
      this.omegaMinus = 1 / tauMinus;
    }
  }

  setG(G: number): void {
    this.cfg.G = G;
  }

  /** Reset every fluid site to f^eq at a uniform density, zero velocity. */
  initUniform(rho: number): void {
    const { f, n } = this;
    for (let i = 0; i < Q; i++) {
      const fi = feq(i, rho, 0, 0);
      for (let node = 0; node < n; node++) f[i * n + node] = fi;
    }
    this.refreshMacro();
    this.steps = 0;
  }

  /** Set the density field from a callback (init at zero velocity, local f^eq). */
  initField(fn: (i: number, j: number) => number): void {
    const { f, n, nx, ny } = this;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        const rho = fn(i, j);
        for (let k = 0; k < Q; k++) f[k * n + node] = feq(k, rho, 0, 0);
      }
    this.refreshMacro();
    this.steps = 0;
  }

  /** A liquid droplet (density `rhoL`) in a vapour background (`rhoG`), with a
   *  smooth tanh interface of half-width ~`w` cells centred on radius `r`. */
  initDroplet(cx: number, cy: number, r: number, rhoL: number, rhoG: number, w = 1.5): void {
    this.initField((i, j) => {
      const d = Math.hypot(i - cx, j - cy) - r;
      const s = 0.5 * (1 - Math.tanh(d / w));
      return rhoG + (rhoL - rhoG) * s;
    });
  }

  /** A flat horizontal liquid slab (|y−cy| < half) in vapour — a flat interface
   *  test (its two bulk pressures must equilibrate, with NO Laplace jump). */
  initSlab(cy: number, half: number, rhoL: number, rhoG: number, w = 1.5): void {
    this.initField((_i, j) => {
      const d = Math.abs(j - cy) - half;
      const s = 0.5 * (1 - Math.tanh(d / w));
      return rhoG + (rhoL - rhoG) * s;
    });
  }

  /** A uniform mean density plus small deterministic noise — the spinodal seed. */
  initNoise(mean: number, amp: number, seed = 1): void {
    let s = seed >>> 0;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff - 0.5;
    };
    this.initField(() => mean + amp * rnd());
  }

  /** Overwrite a disc of sites with liquid at velocity (0, uy) — used to "drip"
   *  a fresh droplet into a running simulation (the rain scene). */
  stampDroplet(cx: number, cy: number, r: number, rho: number, uy = 0): void {
    const { f, n } = this;
    for (let j = Math.max(0, Math.floor(cy - r)); j < Math.min(this.ny, Math.ceil(cy + r) + 1); j++)
      for (let i = Math.max(0, Math.floor(cx - r)); i < Math.min(this.nx, Math.ceil(cx + r) + 1); i++) {
        if ((i - cx) * (i - cx) + (j - cy) * (j - cy) > r * r) continue;
        const node = this.idx(i, j);
        if (this.solid[node]) continue;
        for (let k = 0; k < Q; k++) f[k * n + node] = feq(k, rho, 0, uy);
      }
    this.refreshMacro();
  }

  /** Stamp a solid disc into the mask (an obstacle the fluid wets / bounces off). */
  addDisc(cx: number, cy: number, r: number): void {
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        if ((i - cx) * (i - cx) + (j - cy) * (j - cy) <= r * r) this.solid[this.idx(i, j)] = 1;
      }
  }

  /** Mark the bottom `h` rows (and optionally the top) as a solid floor/ceiling. */
  addFloor(h: number, ceiling = false): void {
    for (let i = 0; i < this.nx; i++) {
      for (let j = 0; j < h; j++) this.solid[this.idx(i, j)] = 1;
      if (ceiling) for (let j = this.ny - h; j < this.ny; j++) this.solid[this.idx(i, j)] = 1;
    }
  }

  clearSolids(): void {
    this.solid.fill(0);
  }

  /** ρ = Σf at every fluid site (the velocity is filled in by `refreshVel`). */
  refreshMacro(): void {
    const { f, n, rho } = this;
    for (let node = 0; node < n; node++) {
      if (this.solid[node]) {
        rho[node] = 0;
        continue;
      }
      let r = 0;
      for (let i = 0; i < Q; i++) r += f[i * n + node];
      rho[node] = r;
    }
  }

  /** ψ(ρ) at every site (solids carry ψ = 0; they act through the adhesion
   *  indicator, not their pseudopotential). */
  private refreshPsi(): void {
    const { rho, psi, n } = this;
    for (let node = 0; node < n; node++) psi[node] = this.solid[node] ? 0 : psiOf(rho[node]);
  }

  /** The Shan–Chen cohesion force + fluid–solid adhesion + mean-subtracted
   *  gravity at every fluid site, from the current ψ field. Periodic neighbours;
   *  a solid neighbour contributes to adhesion (indicator) not cohesion. */
  private refreshForce(): void {
    const { nx, ny, psi, fx, fy, cfg } = this;
    const G = cfg.G;
    const Gads = cfg.Gads;
    const g = cfg.gravityY;

    // Mean fluid density for the buoyant (mean-subtracted) gravity.
    let mean = 0;
    let cnt = 0;
    if (g !== 0) {
      for (let node = 0; node < this.n; node++)
        if (!this.solid[node]) {
          mean += this.rho[node];
          cnt++;
        }
      mean = cnt > 0 ? mean / cnt : 0;
    }

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) {
          fx[node] = 0;
          fy[node] = 0;
          continue;
        }
        let cohX = 0;
        let cohY = 0;
        let adsX = 0;
        let adsY = 0;
        for (let k = 1; k < Q; k++) {
          // Periodic wrap of the neighbour along link k.
          let ni = i + EX[k];
          let nj = j + EY[k];
          if (ni < 0) ni += nx;
          else if (ni >= nx) ni -= nx;
          if (nj < 0) nj += ny;
          else if (nj >= ny) nj -= ny;
          const nb = ni + nx * nj;
          if (this.solid[nb]) {
            adsX += W[k] * EX[k];
            adsY += W[k] * EY[k];
          } else {
            cohX += W[k] * psi[nb] * EX[k];
            cohY += W[k] * psi[nb] * EY[k];
          }
        }
        const pn = psi[node];
        // Cohesion pulls toward denser neighbours (G < 0). Adhesion pulls toward
        // (Gads > 0 → hydrophilic, wets) or away from (Gads < 0 → hydrophobic,
        // beads) solid neighbours.
        fx[node] = -G * pn * cohX + Gads * pn * adsX;
        fy[node] = -G * pn * cohY + Gads * pn * adsY;
        if (g !== 0) fy[node] += g * (this.rho[node] - mean);
      }
    }
  }

  /** One lattice step: refresh ψ + force, collide (Guo), stream, swap, bounce-back. */
  step(): void {
    this.refreshPsi();
    this.refreshForce();
    this.collide();
    this.stream();
    const t = this.f;
    this.f = this.ftmp;
    this.ftmp = t;
    this.refreshMacro();
    this.refreshVel();
    this.steps++;
  }

  // --- collision (BGK / TRT with Guo forcing of the local cohesion force) -----

  private collide(): void {
    const { f, n, fx, fy } = this;
    const op = this.omegaPlus;
    const om = this.omegaMinus;
    const bgk = this.cfg.collision === 'bgk';

    const fl = new Float64Array(Q);
    const eq = new Float64Array(Q);

    for (let node = 0; node < n; node++) {
      if (this.solid[node]) continue;

      let rho = 0;
      let mx = 0;
      let my = 0;
      for (let i = 0; i < Q; i++) {
        const fi = f[i * n + node];
        fl[i] = fi;
        rho += fi;
        mx += EX[i] * fi;
        my += EY[i] * fi;
      }
      const Fx = fx[node];
      const Fy = fy[node];
      // Force-shifted velocity (Guo): u = (Σf e + F/2)/ρ.
      const ux = (mx + 0.5 * Fx) / rho;
      const uy = (my + 0.5 * Fy) / rho;

      for (let i = 0; i < Q; i++) eq[i] = feq(i, rho, ux, uy);

      if (bgk) {
        for (let i = 0; i < Q; i++) {
          const post = fl[i] - op * (fl[i] - eq[i]) + (1 - 0.5 * op) * guoSource(i, ux, uy, Fx, Fy);
          f[i * n + node] = post;
        }
      } else {
        for (let i = 0; i < Q; i++) {
          const io = OPP[i];
          const fPlus = 0.5 * (fl[i] + fl[io]);
          const fMinus = 0.5 * (fl[i] - fl[io]);
          const ePlus = 0.5 * (eq[i] + eq[io]);
          const eMinus = 0.5 * (eq[i] - eq[io]);
          const si = guoSource(i, ux, uy, Fx, Fy);
          const sio = guoSource(io, ux, uy, Fx, Fy);
          const sPlus = 0.5 * (si + sio);
          const sMinus = 0.5 * (si - sio);
          f[i * n + node] =
            fl[i] - op * (fPlus - ePlus) - om * (fMinus - eMinus) + (1 - 0.5 * op) * sPlus + (1 - 0.5 * om) * sMinus;
        }
      }
    }
  }

  // --- streaming (periodic) with half-way bounce-back off solids ---------------

  private stream(): void {
    const { f, ftmp, n, nx, ny } = this;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) continue;
        for (let k = 0; k < Q; k++) {
          // Pull: the population arriving along k came from x − e_k (periodic).
          let si = i - EX[k];
          let sj = j - EY[k];
          if (si < 0) si += nx;
          else if (si >= nx) si -= nx;
          if (sj < 0) sj += ny;
          else if (sj >= ny) sj -= ny;
          const src = si + nx * sj;
          if (this.solid[src]) {
            // Source is solid → half-way bounce-back of this node's opposite link.
            ftmp[k * n + node] = f[OPP[k] * n + node];
          } else {
            ftmp[k * n + node] = f[k * n + src];
          }
        }
      }
    }
  }

  /** Fill ux, uy from the post-stream populations (for rendering / diagnostics),
   *  with the Guo half-force shift using the current force field. */
  private refreshVel(): void {
    const { f, n, ux, uy, fx, fy } = this;
    for (let node = 0; node < n; node++) {
      if (this.solid[node]) {
        ux[node] = 0;
        uy[node] = 0;
        continue;
      }
      let r = 0;
      let mx = 0;
      let my = 0;
      for (let i = 0; i < Q; i++) {
        const fi = f[i * n + node];
        r += fi;
        mx += EX[i] * fi;
        my += EY[i] * fi;
      }
      ux[node] = (mx + 0.5 * fx[node]) / r;
      uy[node] = (my + 0.5 * fy[node]) / r;
    }
  }

  // --- diagnostics -------------------------------------------------------------

  /** EOS pressure at a site (the mechanical pressure used by Laplace's law). */
  pressureAt(node: number): number {
    return pressureOf(this.rho[node], this.cfg.G);
  }

  /** Total mass Σρ over fluid sites (exactly conserved by stream + collide). */
  totalMass(): number {
    let s = 0;
    for (let node = 0; node < this.n; node++) if (!this.solid[node]) s += this.rho[node];
    return s;
  }

  /** Total momentum (Σρu) magnitude — an internal cohesion force is antisymmetric
   *  (ΣF = 0), so with no walls and no gravity this stays ≈ 0 (no self-propulsion). */
  totalMomentum(): { px: number; py: number } {
    let px = 0;
    let py = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      px += this.rho[node] * this.ux[node];
      py += this.rho[node] * this.uy[node];
    }
    return { px, py };
  }

  /** The largest "spurious current" — the parasitic velocity the Shan–Chen
   *  interface generates even at mechanical equilibrium (a known artefact; we
   *  report it honestly rather than hide it). */
  maxSpuriousSpeed(): number {
    let m = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      const s = Math.hypot(this.ux[node], this.uy[node]);
      if (s > m) m = s;
    }
    return m;
  }

  /** Robust bulk liquid / vapour densities: the means of the densities above /
   *  below the midpoint of the current [min,max] range (the two flat plateaus,
   *  excluding the thin interface). */
  bulkDensities(): { rhoL: number; rhoG: number; ratio: number } {
    let lo = Infinity;
    let hi = -Infinity;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      const r = this.rho[node];
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    let sL = 0;
    let nL = 0;
    let sG = 0;
    let nG = 0;
    // Bulk = within 15% of an extreme; the interface band in between is ignored.
    const band = 0.15 * (hi - lo);
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      const r = this.rho[node];
      if (r > hi - band) {
        sL += r;
        nL++;
      } else if (r < lo + band) {
        sG += r;
        nG++;
      }
    }
    const rhoL = nL > 0 ? sL / nL : hi;
    const rhoG = nG > 0 ? sG / nG : lo;
    return { rhoL, rhoG, ratio: rhoG > 1e-9 ? rhoL / rhoG : Infinity };
  }
}
