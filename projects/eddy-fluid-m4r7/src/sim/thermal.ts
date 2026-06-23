// thermal.ts — a from-scratch *coupled* thermal Lattice Boltzmann (D2Q9) solver.
//
// `lbm.ts` evolves one nine-velocity distribution f and the incompressible
// Navier–Stokes equations emerge from it (the Chapman–Enskog bridge). Heat is a
// *second* conserved field, so the textbook kinetic route to thermal convection
// is the **double-distribution model**: carry a *second* D2Q9 distribution g
// whose single conserved moment is the temperature,
//
//     T(x) = Σ_i g_i(x),
//
// and which relaxes toward the advection–diffusion equilibrium
//
//     g^eq_i = w_i T (1 + e_i·u / c_s²).
//
// A Chapman–Enskog expansion of g's stream+collide gives the advection–diffusion
// equation  ∂_t T + u·∇T = α ∇²T  with a thermal diffusivity fixed only by g's
// relaxation time,  α = c_s² (τ_g − ½)  — the exact scalar twin of  ν = c_s²(τ−½).
//
// The two lattices are coupled *both* ways:
//   • g is **advected** by u (which it reads from f's equilibrium), and
//   • f feels a per-node **Boussinesq buoyancy** body force  F = ρ gβ (T − T_ref) ĝ
//     (hot fluid is lighter, so it rises), injected with the exact second-order
//     Guo (2002) forcing already used in `lbm.ts`.
//
// That tiny addition is enough to make the two most iconic instabilities in fluid
// dynamics fall out of nothing but stream + collide: **Rayleigh–Bénard convection
// rolls** and a **buoyant thermal plume** — plus the canonical
// differentially-heated-cavity benchmark. And because the model is so clean it is
// *quantitatively* checkable: the Verify page recovers α from a decaying thermal
// wave, the conduction state's Nusselt number is exactly 1, the onset of
// convection lands on the textbook critical Rayleigh number Ra_c ≈ 1708, and the
// heated-cavity Nusselt number matches the de Vahl Davis (1983) reference.
//
// Thermal boundary conditions are first-class here:
//   • a fixed-temperature (Dirichlet) wall via **anti-bounce-back**
//        g_i = −g*_ī + 2 w_i T_wall,
//     which pins T to T_wall half-way between nodes (second-order accurate);
//   • an adiabatic (zero normal flux) wall via plain **bounce-back** of g;
//   • and a fully **periodic** direction.
// The flow f sees a no-slip half-way bounce-back at every solid wall.

import { EX, EY, W, OPP, Q, CS2, INV_CS2, INV_CS4, feq, tauFromViscosity, viscosityFromTau } from './lbm';

export { CS2, viscosityFromTau };

/** A boundary condition on one side of the box.
 *  - `periodic`     — wraps (must match the opposite side).
 *  - `adiabatic`    — no-slip flow wall + zero-flux scalar wall (bounce-back g).
 *  - `temperature`  — no-slip flow wall + Dirichlet scalar wall T = `T` (anti-bounce-back g). */
export type ThermalBC =
  | { kind: 'periodic' }
  | { kind: 'adiabatic' }
  | { kind: 'temperature'; T: number };

export interface ThermalSides {
  xMinus: ThermalBC;
  xPlus: ThermalBC;
  yMinus: ThermalBC;
  yPlus: ThermalBC;
}

export interface ThermalConfig {
  nx: number;
  ny: number;
  /** Kinematic viscosity ν (lattice units) → τ_f via ν = c_s²(τ−½). */
  viscosity: number;
  /** Thermal diffusivity α (lattice units) → τ_g via α = c_s²(τ_g−½). */
  diffusivity: number;
  /** Buoyancy coefficient gβ: the vertical body force is gβ·(T − T_ref). */
  buoyancy: number;
  /** Boussinesq reference temperature (the buoyancy force vanishes at T_ref). */
  tRef: number;
  /** Flow collision operator. BGK is single-rate; TRT splits even/odd for an
   *  exactly-placed no-slip wall (the de Vahl Davis cavity benefits). */
  collision: 'bgk' | 'trt';
  /** TRT magic parameter Λ = (1/ω⁺−½)(1/ω⁻−½). 3/16 fixes the wall half-way. */
  magic: number;
  bc: ThermalSides;
}

export const DEFAULT_THERMAL: ThermalConfig = {
  nx: 200,
  ny: 100,
  viscosity: 0.02,
  diffusivity: 0.02,
  buoyancy: 1e-6,
  tRef: 0,
  collision: 'trt',
  magic: 3 / 16,
  bc: {
    xMinus: { kind: 'periodic' },
    xPlus: { kind: 'periodic' },
    yMinus: { kind: 'temperature', T: 0.5 },
    yPlus: { kind: 'temperature', T: -0.5 },
  },
};

/** α = c_s²(τ_g − ½) ⇒ τ_g = α/c_s² + ½. (Shares the form of ν’s τ.) */
export function tauFromDiffusivity(alpha: number): number {
  return alpha * INV_CS2 + 0.5;
}
export function diffusivityFromTau(tauG: number): number {
  return CS2 * (tauG - 0.5);
}

/** The advection–diffusion equilibrium for the scalar distribution g (first order
 *  in u — all that the advection–diffusion equation needs). Σ_i g^eq_i = T and
 *  Σ_i e_i g^eq_i = T u, the two moments Chapman–Enskog requires. */
export function geq(i: number, T: number, ux: number, uy: number): number {
  return W[i] * T * (1 + INV_CS2 * (EX[i] * ux + EY[i] * uy));
}

export class ThermalLbm {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  cfg: ThermalConfig;

  // Two distributions, structure-of-arrays: x[i*n + node].
  f: Float64Array;
  ftmp: Float64Array;
  g: Float64Array;
  gtmp: Float64Array;

  // Cached macroscopic fields (refreshed each step).
  rho: Float64Array;
  ux: Float64Array;
  uy: Float64Array;
  temp: Float64Array;

  solid: Uint8Array;

  tauF = 1;
  tauG = 1;
  omegaPlus = 1;
  omegaMinus = 1;
  omegaG = 1;
  steps = 0;

  private readonly periodicX: boolean;
  private readonly periodicY: boolean;

  constructor(cfg: Partial<ThermalConfig> = {}) {
    this.cfg = { ...DEFAULT_THERMAL, ...cfg, bc: { ...DEFAULT_THERMAL.bc, ...(cfg.bc ?? {}) } };
    this.nx = this.cfg.nx;
    this.ny = this.cfg.ny;
    this.n = this.nx * this.ny;
    this.f = new Float64Array(Q * this.n);
    this.ftmp = new Float64Array(Q * this.n);
    this.g = new Float64Array(Q * this.n);
    this.gtmp = new Float64Array(Q * this.n);
    this.rho = new Float64Array(this.n);
    this.ux = new Float64Array(this.n);
    this.uy = new Float64Array(this.n);
    this.temp = new Float64Array(this.n);
    this.solid = new Uint8Array(this.n);
    this.periodicX = this.cfg.bc.xMinus.kind === 'periodic';
    this.periodicY = this.cfg.bc.yMinus.kind === 'periodic';
    this.refreshRelaxation();
    this.initEquilibrium(() => ({ ux: 0, uy: 0, T: this.cfg.tRef }));
  }

  idx(i: number, j: number): number {
    return i + this.nx * j;
  }

  /** Recompute every relaxation rate from ν, α and the magic parameter. */
  refreshRelaxation(): void {
    this.tauF = tauFromViscosity(this.cfg.viscosity);
    this.tauG = tauFromDiffusivity(this.cfg.diffusivity);
    this.omegaPlus = 1 / this.tauF;
    this.omegaG = 1 / this.tauG;
    if (this.cfg.collision === 'bgk') {
      this.omegaMinus = this.omegaPlus;
    } else {
      const tauMinus = 0.5 + this.cfg.magic / (1 / this.omegaPlus - 0.5);
      this.omegaMinus = 1 / tauMinus;
    }
  }

  /** Initialise both lattices from per-node velocity & temperature callbacks. */
  initEquilibrium(fn: (i: number, j: number) => { ux: number; uy: number; T: number }): void {
    const { f, g, n, nx, ny } = this;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        const { ux, uy, T } = fn(i, j);
        for (let k = 0; k < Q; k++) {
          f[k * n + node] = feq(k, 1, ux, uy);
          g[k * n + node] = geq(k, T, ux, uy);
        }
      }
    this.refreshMacro();
    this.steps = 0;
  }

  /** Stamp a warm/cool disc into the temperature field (a buoyant "thermal"). */
  addHeatBlob(cx: number, cy: number, r: number, T: number): void {
    const { g, n } = this;
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const dx = i - cx;
        const dy = j - cy;
        if (dx * dx + dy * dy <= r * r) {
          const node = this.idx(i, j);
          const ux = this.ux[node];
          const uy = this.uy[node];
          for (let k = 0; k < Q; k++) g[k * n + node] = geq(k, T, ux, uy);
        }
      }
    this.refreshMacro();
  }

  /** Recompute ρ, u (with the Guo half-force shift) and T from the distributions. */
  refreshMacro(): void {
    const { f, g, n, rho, ux, uy, temp, cfg } = this;
    const buoy = cfg.buoyancy;
    const tRef = cfg.tRef;
    for (let node = 0; node < n; node++) {
      if (this.solid[node]) {
        rho[node] = 1;
        ux[node] = 0;
        uy[node] = 0;
        // A solid still carries a temperature moment so adjacent fluid can read it.
        let t = 0;
        for (let i = 0; i < Q; i++) t += g[i * n + node];
        temp[node] = t;
        continue;
      }
      let r = 0;
      let mx = 0;
      let my = 0;
      let t = 0;
      for (let i = 0; i < Q; i++) {
        const fi = f[i * n + node];
        r += fi;
        mx += EX[i] * fi;
        my += EY[i] * fi;
        t += g[i * n + node];
      }
      temp[node] = t;
      const fy = buoy * (t - tRef);
      rho[node] = r;
      ux[node] = mx / r;
      uy[node] = (my + 0.5 * fy) / r; // half the body force enters the momentum (Guo)
    }
  }

  /** One coupled lattice step: collide both, stream both, swap, refresh. */
  step(): void {
    this.collide();
    this.stream();
    let t = this.f;
    this.f = this.ftmp;
    this.ftmp = t;
    t = this.g;
    this.g = this.gtmp;
    this.gtmp = t;
    this.refreshMacro();
    this.steps++;
  }

  // --- collision -----------------------------------------------------------

  private collide(): void {
    const { f, g, n, cfg } = this;
    const buoy = cfg.buoyancy;
    const tRef = cfg.tRef;
    const op = this.omegaPlus;
    const om = this.omegaMinus;
    const og = this.omegaG;
    const trt = cfg.collision === 'trt';
    const fl = new Float64Array(Q);
    const eq = new Float64Array(Q);
    const gl = new Float64Array(Q);

    for (let node = 0; node < n; node++) {
      if (this.solid[node]) continue;

      let rho = 0;
      let mx = 0;
      let my = 0;
      let T = 0;
      for (let i = 0; i < Q; i++) {
        const fi = f[i * n + node];
        fl[i] = fi;
        gl[i] = g[i * n + node];
        rho += fi;
        mx += EX[i] * fi;
        my += EY[i] * fi;
        T += gl[i];
      }
      const fy = buoy * (T - tRef); // Boussinesq buoyancy (vertical only)
      const ux = mx / rho;
      const uy = (my + 0.5 * fy) / rho;

      // --- flow distribution f: relax toward feq + inject the buoyancy force ---
      for (let i = 0; i < Q; i++) eq[i] = feq(i, rho, ux, uy);

      if (!trt) {
        for (let i = 0; i < Q; i++) {
          let post = fl[i] - op * (fl[i] - eq[i]);
          if (fy !== 0) post += (1 - 0.5 * op) * this.guoSourceY(i, ux, uy, fy);
          f[i * n + node] = post;
        }
      } else {
        for (let i = 0; i < Q; i++) {
          const io = OPP[i];
          const fPlus = 0.5 * (fl[i] + fl[io]);
          const fMinus = 0.5 * (fl[i] - fl[io]);
          const ePlus = 0.5 * (eq[i] + eq[io]);
          const eMinus = 0.5 * (eq[i] - eq[io]);
          let post = fl[i] - op * (fPlus - ePlus) - om * (fMinus - eMinus);
          if (fy !== 0) {
            const si = this.guoSourceY(i, ux, uy, fy);
            const sio = this.guoSourceY(io, ux, uy, fy);
            post += (1 - 0.5 * op) * (0.5 * (si + sio)) + (1 - 0.5 * om) * (0.5 * (si - sio));
          }
          f[i * n + node] = post;
        }
      }

      // --- scalar distribution g: BGK advection–diffusion toward geq(T, u) ---
      for (let i = 0; i < Q; i++) {
        const ge = geq(i, T, ux, uy);
        g[i * n + node] = gl[i] - og * (gl[i] - ge);
      }
    }
  }

  /** Guo (2002) source for a purely vertical body force F = (0, fy), without the
   *  discrete (1 − ω/2) prefactor (the caller applies it, split per TRT rate). */
  private guoSourceY(i: number, ux: number, uy: number, fy: number): number {
    const eu = EX[i] * ux + EY[i] * uy;
    const cy = INV_CS2 * (EY[i] - uy) + INV_CS4 * eu * EY[i];
    return W[i] * cy * fy;
  }

  // --- streaming + boundaries ----------------------------------------------

  private stream(): void {
    const { f, ftmp, g, gtmp, n, nx, ny } = this;
    const { bc } = this.cfg;
    const periodicX = this.periodicX;
    const periodicY = this.periodicY;

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) continue;

        for (let k = 0; k < Q; k++) {
          // Pull scheme: the population arriving along k came from x − e_k.
          let si = i - EX[k];
          let sj = j - EY[k];
          let outX = false;
          let outY = false;
          if (si < 0 || si >= nx) {
            if (periodicX) si = (si + nx) % nx;
            else outX = true;
          }
          if (sj < 0 || sj >= ny) {
            if (periodicY) sj = (sj + ny) % ny;
            else outY = true;
          }

          if (outX || outY) {
            // Streamed in from outside a domain wall.
            const io = OPP[k];
            // Flow: no-slip half-way bounce-back (every solid wall is static here).
            ftmp[k * n + node] = f[io * n + node];
            // Scalar: pick the boundary this link crossed and apply its rule. (A
            // corner diagonal crosses both; resolve it on the x-side.)
            let side: ThermalBC;
            if (outX) side = i - EX[k] < 0 ? bc.xMinus : bc.xPlus;
            else side = j - EY[k] < 0 ? bc.yMinus : bc.yPlus;
            if (side.kind === 'temperature') {
              // Anti-bounce-back → Dirichlet wall temperature (second order).
              gtmp[k * n + node] = -g[io * n + node] + 2 * W[k] * side.T;
            } else {
              // Adiabatic (and periodic-but-mismatched) → zero-flux bounce-back.
              gtmp[k * n + node] = g[io * n + node];
            }
            continue;
          }

          const src = si + nx * sj;
          if (this.solid[src]) {
            // Neighbour is a solid obstacle → bounce-back both lattices (the scalar
            // bounce-back makes the obstacle adiabatic).
            ftmp[k * n + node] = f[OPP[k] * n + node];
            gtmp[k * n + node] = g[OPP[k] * n + node];
          } else {
            ftmp[k * n + node] = f[k * n + src];
            gtmp[k * n + node] = g[k * n + src];
          }
        }
      }
    }
  }

  // --- diagnostics ---------------------------------------------------------

  speedAt(i: number, j: number): number {
    const node = this.idx(i, j);
    return Math.hypot(this.ux[node], this.uy[node]);
  }

  tempAt(i: number, j: number): number {
    return this.temp[this.idx(i, j)];
  }

  /** z-vorticity ω = ∂v/∂x − ∂u/∂y by central differences (lattice units). */
  vorticityAt(i: number, j: number): number {
    const { ux, uy, nx, ny } = this;
    const ip = Math.min(i + 1, nx - 1);
    const im = Math.max(i - 1, 0);
    const jp = Math.min(j + 1, ny - 1);
    const jm = Math.max(j - 1, 0);
    const dvdx = (uy[this.idx(ip, j)] - uy[this.idx(im, j)]) / (ip - im || 1);
    const dudy = (ux[this.idx(i, jp)] - ux[this.idx(i, jm)]) / (jp - jm || 1);
    return dvdx - dudy;
  }

  maxSpeed(): number {
    let m = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      const s = Math.hypot(this.ux[node], this.uy[node]);
      if (s > m) m = s;
    }
    return m;
  }

  kineticEnergy(): number {
    let e = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      e += 0.5 * this.rho[node] * (this.ux[node] * this.ux[node] + this.uy[node] * this.uy[node]);
    }
    return e;
  }

  /** Mean over the fluid of the vertical convective flux ⟨u_y · T⟩ (the engine of
   *  the Nusselt number for a vertically-stratified cell). */
  meanVerticalHeatFlux(): number {
    let s = 0;
    let cnt = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      s += this.uy[node] * this.temp[node];
      cnt++;
    }
    return cnt ? s / cnt : 0;
  }

  meanHorizontalHeatFlux(): number {
    let s = 0;
    let cnt = 0;
    for (let node = 0; node < this.n; node++) {
      if (this.solid[node]) continue;
      s += this.ux[node] * this.temp[node];
      cnt++;
    }
    return cnt ? s / cnt : 0;
  }

  /** The Nusselt number — the ratio of total to purely-conductive heat transport.
   *  Nu = 1 + ⟨u_d·T⟩·L_d/(α·ΔT), where d is the transport axis. Nu = 1 means
   *  pure conduction (no convection); Nu > 1 measures the convective boost. */
  nusselt(axis: 'x' | 'y', deltaT: number, length: number): number {
    const alpha = this.cfg.diffusivity;
    if (alpha <= 0 || deltaT === 0) return NaN;
    const flux = axis === 'y' ? this.meanVerticalHeatFlux() : this.meanHorizontalHeatFlux();
    return 1 + (flux * length) / (alpha * deltaT);
  }

  /** Horizontally-averaged temperature profile T̄(j) over the fluid rows. Used by
   *  the conduction-profile verification (it must be linear between the plates). */
  meanTemperatureProfile(): Float64Array {
    const { nx, ny } = this;
    const prof = new Float64Array(ny);
    for (let j = 0; j < ny; j++) {
      let s = 0;
      let cnt = 0;
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) continue;
        s += this.temp[node];
        cnt++;
      }
      prof[j] = cnt ? s / cnt : 0;
    }
    return prof;
  }

  /** Total heat Σ_fluid T — conserved exactly by stream+collide under adiabatic
   *  (zero-flux) walls (a sanity invariant for the scalar transport). */
  totalHeat(): number {
    let s = 0;
    for (let node = 0; node < this.n; node++) if (!this.solid[node]) s += this.temp[node];
    return s;
  }
}

// --- non-dimensional driver --------------------------------------------------

export interface ThermalScaling {
  viscosity: number;
  diffusivity: number;
  buoyancy: number;
}

/** Derive the lattice transport coefficients (ν, α) and the buoyancy gβ from the
 *  dimensionless control parameters at a fixed low-Mach **free-fall velocity**
 *  U_f = √(gβ·ΔT·H). This is the standard thermal-LBM non-dimensionalisation:
 *
 *      ν = U_f·H·√(Pr/Ra),   α = U_f·H/√(Pr·Ra),   gβ = U_f²/(ΔT·H).
 *
 *  so that  Ra = gβ·ΔT·H³/(ν·α)  and  Pr = ν/α  hold exactly, while U_f stays a
 *  fixed small fraction of c_s (keeping the simulation safely incompressible). */
export function scalingFromRaPr(Ra: number, Pr: number, H: number, deltaT: number, uFree: number): ThermalScaling {
  const nu = (uFree * H * Math.sqrt(Pr / Ra));
  const alpha = (uFree * H) / Math.sqrt(Pr * Ra);
  const buoyancy = (uFree * uFree) / (deltaT * H);
  return { viscosity: nu, diffusivity: alpha, buoyancy };
}
