// lbm.ts — a from-scratch Lattice Boltzmann (D2Q9) kinetic solver.
//
// The rest of this studio solves the incompressible Navier–Stokes equations the
// *macroscopic* way: it carries a velocity field and marches the PDE directly
// (Stable Fluids). This file takes the **opposite** route. It never writes down
// Navier–Stokes at all. Instead it tracks a cloud of fictitious particles
// through their one-particle distribution f(x, e, t) — "how much fluid at x is
// moving along lattice direction e" — and evolves it with the discrete
// Boltzmann equation:
//
//     f_i(x + e_i Δt, t + Δt) = f_i(x, t) − Ω_i        (stream + collide)
//
// on the **D2Q9** lattice (nine velocities). The collision Ω relaxes f toward a
// local Maxwellian f^eq. That is *all* the physics that goes in — local, linear,
// embarrassingly parallel, no global pressure solve. Yet a Chapman–Enskog
// multi-scale expansion proves that the slow moments of this kinetic update obey
// the incompressible Navier–Stokes equations to second order, with a viscosity
// fixed *only* by the relaxation time τ:
//
//     ν = c_s² (τ − ½),     c_s² = 1/3   (lattice units).
//
// So the same physics falls out of a completely different numerical universe.
// The `Verify` page measures that ν back out of a decaying shear wave and checks
// it against the formula — the Chapman–Enskog bridge, confirmed live.
//
// Implemented here, all from scratch:
//   • D2Q9 lattice with the Hermite-consistent equilibrium f^eq.
//   • BGK (single-relaxation-time) AND TRT (two-relaxation-time) collision — TRT
//     pins the bounce-back wall to a viscosity-independent location (the "magic"
//     parameter Λ), curing BGK's notorious slip.
//   • Guo (2002) forcing — a body force with the exact second-order correction,
//     so a periodic channel reproduces analytic Poiseuille flow.
//   • Half-way bounce-back for no-slip walls and arbitrary solid obstacles, with
//     a moving-wall variant for the lid-driven cavity.
//   • Zou–He velocity inlet + a stable extrapolation outflow → an open channel.
//   • A Smagorinsky LES sub-grid model whose strain rate is read *locally* from
//     the non-equilibrium stress Π^neq — a quantity LBM gives you for free —
//     letting the cylinder wake stay stable into the turbulent-shedding regime.
//   • Momentum-exchange force on solids → a drag coefficient, from scratch.

export const CS2 = 1 / 3; // lattice speed of sound squared, c_s² = 1/3
export const INV_CS2 = 3;
export const INV_CS4 = 9;

// D2Q9 lattice. Direction 0 is rest; 1–4 axial; 5–8 diagonal.
//        6   2   5
//          \ | /
//        3 — 0 — 1
//          / | \
//        7   4   8
export const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
// Opposite direction of each link (used by bounce-back and TRT's symmetric split).
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
export const Q = 9;

export type Collision = 'bgk' | 'trt' | 'mrt';

// --- MRT (multiple-relaxation-time) moment space -----------------------------
//
// The orthogonal moment basis of Lallemand & Luo (2000) for D2Q9, in this file's
// velocity ordering. Rows: {ρ, e, ε, jx, qx, jy, qy, pxx, pxy}. MRT maps f into
// these physical moments, relaxes EACH toward its own equilibrium at its OWN
// rate, and maps back — so the kinematic shear modes (pxx, pxy) carry the
// viscosity while the unphysical "ghost" modes are damped hard for stability.
// BGK is the special case where every rate equals 1/τ; TRT lies in between.
export const MRT_M: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1], // ρ
  [-4, -1, -1, -1, -1, 2, 2, 2, 2], // e (energy)
  [4, -2, -2, -2, -2, 1, 1, 1, 1], // ε (energy²)
  [0, 1, 0, -1, 0, 1, -1, -1, 1], // jx
  [0, -2, 0, 2, 0, 1, -1, -1, 1], // qx (energy flux)
  [0, 0, 1, 0, -1, 1, 1, -1, -1], // jy
  [0, 0, -2, 0, 2, 1, 1, -1, -1], // qy
  [0, 1, -1, 1, -1, 0, 0, 0, 0], // pxx (normal stress)
  [0, 0, 0, 0, 0, 1, -1, 1, -1], // pxy (shear stress)
];

/** Invert a small dense matrix by Gauss–Jordan (done once at module load, so
 *  the MRT transform matrix is never transcribed by hand and can't drift). */
function invert(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r) => r.slice(n));
}

export const MRT_MINV: number[][] = invert(MRT_M);

// Relaxation rates for the non-hydrodynamic moments (Lallemand–Luo "optimal"
// values). Conserved moments (ρ, jx, jy) have rate 0; the stress moments
// pxx, pxy take 1/τ (the viscosity), set per-node at collision time.
const MRT_S_E = 1.64; // energy
const MRT_S_EPS = 1.54; // energy²
const MRT_S_Q = 1.7; // energy flux

export interface LbmConfig {
  nx: number;
  ny: number;
  /** Kinematic viscosity in lattice units → sets τ via ν = c_s²(τ−½). */
  viscosity: number;
  collision: Collision;
  /** TRT "magic" parameter Λ = (1/ω⁺ − ½)(1/ω⁻ − ½). 3/16 fixes the bounce-back
   *  wall half-way between nodes independent of ν; ¼ maximises stability. */
  magic: number;
  /** Smagorinsky sub-grid eddy viscosity (0 disables the LES model). */
  smagorinsky: number;
  // Boundary handling on each side of the box.
  bcX: 'periodic' | 'channel' | 'wall'; // channel = Zou–He inlet (left) + outflow (right); wall = bounce-back
  bcY: 'periodic' | 'wall'; // wall = bounce-back top & bottom
  inletU: number; // x-velocity imposed at a channel inlet
  lidU: number; // x-velocity of a moving top wall (lid-driven cavity); 0 = static
  forceX: number; // Guo body force
  forceY: number;
}

export const DEFAULT_LBM: LbmConfig = {
  nx: 256,
  ny: 96,
  viscosity: 0.02,
  collision: 'trt',
  magic: 3 / 16,
  smagorinsky: 0,
  bcX: 'channel',
  bcY: 'wall',
  inletU: 0.08,
  lidU: 0,
  forceX: 0,
  forceY: 0,
};

/** ν = c_s²(τ − ½)  ⇒  τ = ν/c_s² + ½. */
export function tauFromViscosity(nu: number): number {
  return nu * INV_CS2 + 0.5;
}
export function viscosityFromTau(tau: number): number {
  return CS2 * (tau - 0.5);
}

/** The D2Q9 equilibrium f^eq_i for a single direction — the lattice's truncated
 *  Maxwell–Boltzmann, exact through second order in u. */
export function feq(i: number, rho: number, ux: number, uy: number): number {
  const eu = EX[i] * ux + EY[i] * uy;
  const usqr = ux * ux + uy * uy;
  return W[i] * rho * (1 + INV_CS2 * eu + 0.5 * INV_CS4 * eu * eu - 0.5 * INV_CS2 * usqr);
}

export class Lbm {
  readonly nx: number;
  readonly ny: number;
  readonly n: number;
  cfg: LbmConfig;

  // Distribution functions, structure-of-arrays: f[i*n + node].
  f: Float64Array;
  ftmp: Float64Array;

  // Cached macroscopic fields (refreshed each step for rendering / probes).
  rho: Float64Array;
  ux: Float64Array;
  uy: Float64Array;

  // Geometry: solid[node] = 1 marks a wall/obstacle (bounce-back). Domain-edge
  // walls (bcY = 'wall') are handled by the streamer, not by this mask.
  solid: Uint8Array;

  tau: number;
  omegaPlus: number;
  omegaMinus: number;
  steps = 0;

  constructor(cfg: Partial<LbmConfig> = {}) {
    this.cfg = { ...DEFAULT_LBM, ...cfg };
    this.nx = this.cfg.nx;
    this.ny = this.cfg.ny;
    this.n = this.nx * this.ny;
    this.f = new Float64Array(Q * this.n);
    this.ftmp = new Float64Array(Q * this.n);
    this.rho = new Float64Array(this.n);
    this.ux = new Float64Array(this.n);
    this.uy = new Float64Array(this.n);
    this.solid = new Uint8Array(this.n);
    this.tau = 1;
    this.omegaPlus = 1;
    this.omegaMinus = 1;
    this.refreshRelaxation();
    this.initEquilibrium(1, 0, 0);
  }

  idx(i: number, j: number): number {
    return i + this.nx * j;
  }

  /** Recompute the two relaxation rates from ν and the magic parameter. */
  refreshRelaxation(): void {
    this.tau = tauFromViscosity(this.cfg.viscosity);
    this.omegaPlus = 1 / this.tau; // even moments → viscosity
    if (this.cfg.collision === 'bgk') {
      this.omegaMinus = this.omegaPlus;
    } else {
      // Λ = (1/ω⁺ − ½)(1/ω⁻ − ½) ⇒ 1/ω⁻ = ½ + Λ/(1/ω⁺ − ½).
      const tauMinus = 0.5 + this.cfg.magic / (1 / this.omegaPlus - 0.5);
      this.omegaMinus = 1 / tauMinus;
    }
  }

  setViscosity(nu: number): void {
    this.cfg.viscosity = nu;
    this.refreshRelaxation();
  }

  /** Reset every node to f^eq at a uniform density and velocity. */
  initEquilibrium(rho: number, ux: number, uy: number): void {
    const { f, n } = this;
    for (let i = 0; i < Q; i++) {
      const fi = feq(i, rho, ux, uy);
      for (let node = 0; node < n; node++) f[i * n + node] = fi;
    }
    this.refreshMacro();
    this.steps = 0;
  }

  /** Initialise from per-node density & velocity callbacks (used for analytic
   *  test fields like a decaying shear wave). */
  initField(fn: (i: number, j: number) => { rho: number; ux: number; uy: number }): void {
    const { f, n, nx, ny } = this;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        const { rho, ux, uy } = fn(i, j);
        for (let k = 0; k < Q; k++) f[k * n + node] = feq(k, rho, ux, uy);
      }
    this.refreshMacro();
    this.steps = 0;
  }

  /** Stamp a solid disc (cylinder cross-section) into the obstacle mask. */
  addDisc(cx: number, cy: number, r: number): void {
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const dx = i - cx;
        const dy = j - cy;
        if (dx * dx + dy * dy <= r * r) this.solid[this.idx(i, j)] = 1;
      }
  }

  clearSolids(): void {
    this.solid.fill(0);
  }

  /** Recompute ρ, u from the distributions (with the Guo half-force shift). */
  refreshMacro(): void {
    const { f, n, rho, ux, uy, cfg } = this;
    const gx = cfg.forceX;
    const gy = cfg.forceY;
    for (let node = 0; node < n; node++) {
      if (this.solid[node]) {
        rho[node] = 1;
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
      rho[node] = r;
      // Half the body force is added to the momentum (Guo).
      ux[node] = (mx + 0.5 * gx) / r;
      uy[node] = (my + 0.5 * gy) / r;
    }
  }

  /** One lattice time step: collide (in place) then stream (into ftmp), swap. */
  step(): void {
    this.collide();
    this.stream();
    const t = this.f;
    this.f = this.ftmp;
    this.ftmp = t;
    this.applyMomentBoundaries();
    this.refreshMacro();
    this.steps++;
  }

  // --- collision -----------------------------------------------------------

  private collide(): void {
    const { f, n, cfg } = this;
    const gx = cfg.forceX;
    const gy = cfg.forceY;
    const hasForce = gx !== 0 || gy !== 0;
    const les = cfg.smagorinsky > 0;
    const op = this.omegaPlus;
    const om = this.omegaMinus;
    const bgk = cfg.collision === 'bgk' && !les;

    const mrt = cfg.collision === 'mrt';
    // Scratch for one node.
    const fl = new Float64Array(Q);
    const eq = new Float64Array(Q);
    const mom = new Float64Array(Q); // MRT: moments
    const meq = new Float64Array(Q); // MRT: moment equilibria
    const fhat = new Float64Array(Q); // MRT: force in moment space

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
      const ux = (mx + 0.5 * gx) / rho;
      const uy = (my + 0.5 * gy) / rho;

      for (let i = 0; i < Q; i++) eq[i] = feq(i, rho, ux, uy);

      // Effective relaxation: optionally add a Smagorinsky eddy viscosity read
      // from the local non-equilibrium momentum-flux tensor Π^neq.
      let opEff = op;
      let omEff = om;
      if (les) {
        let pxx = 0;
        let pyy = 0;
        let pxy = 0;
        for (let i = 0; i < Q; i++) {
          const neq = fl[i] - eq[i];
          pxx += EX[i] * EX[i] * neq;
          pyy += EY[i] * EY[i] * neq;
          pxy += EX[i] * EY[i] * neq;
        }
        const pmag = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
        const cd = cfg.smagorinsky * cfg.smagorinsky; // (Cs·Δ)², Δ = 1
        // τ_total = ½(τ + √(τ² + 2√2·C/(ρ c_s⁴)·|Π|)) — Hou et al. closed form.
        const tau0 = this.tau;
        const tauT = 0.5 * (tau0 + Math.sqrt(tau0 * tau0 + (2 * Math.SQRT2 * cd * INV_CS4 * pmag) / rho));
        opEff = 1 / tauT;
        // Keep TRT's magic relationship with the eddy-augmented τ⁺.
        if (cfg.collision === 'trt') {
          const tauMinus = 0.5 + cfg.magic / (tauT - 0.5);
          omEff = 1 / tauMinus;
        } else {
          omEff = opEff;
        }
      }

      if (mrt) {
        // MRT: relax in moment space, each moment at its own rate (the stress
        // moments pxx, pxy carry the viscosity = opEff; ghost modes damped hard).
        const sNu = opEff;
        const S0 = 0,
          S1 = MRT_S_E,
          S2 = MRT_S_EPS,
          S4 = MRT_S_Q,
          S7 = sNu,
          S8 = sNu;
        // Forward transform f → moments and the Guo source → moment space.
        for (let k = 0; k < Q; k++) {
          const row = MRT_M[k];
          let mk = 0;
          let fk = 0;
          for (let i = 0; i < Q; i++) {
            mk += row[i] * fl[i];
            if (hasForce) fk += row[i] * this.guoSource(i, ux, uy, gx, gy);
          }
          mom[k] = mk;
          fhat[k] = fk;
        }
        const rhoM = mom[0];
        const jx = ux * rhoM; // = (Σf·ex + ½gx), the force-shifted momentum
        const jy = uy * rhoM;
        const j2 = (jx * jx + jy * jy) / rhoM;
        meq[0] = rhoM;
        meq[1] = -2 * rhoM + 3 * j2;
        meq[2] = rhoM - 3 * j2;
        meq[3] = jx;
        meq[4] = -jx;
        meq[5] = jy;
        meq[6] = -jy;
        meq[7] = (jx * jx - jy * jy) / rhoM;
        meq[8] = (jx * jy) / rhoM;
        // Relax (conserved ρ, jx, jy have rate 0) + project the force.
        const S = [S0, S1, S2, S0, S4, S0, S4, S7, S8];
        for (let k = 0; k < Q; k++) {
          mom[k] += -S[k] * (mom[k] - meq[k]) + (1 - 0.5 * S[k]) * fhat[k];
        }
        // Inverse transform back to populations.
        for (let i = 0; i < Q; i++) {
          const row = MRT_MINV[i];
          let fi = 0;
          for (let k = 0; k < Q; k++) fi += row[k] * mom[k];
          f[i * n + node] = fi;
        }
      } else if (bgk) {
        for (let i = 0; i < Q; i++) {
          let post = fl[i] - opEff * (fl[i] - eq[i]);
          if (hasForce) post += (1 - 0.5 * opEff) * this.guoSource(i, ux, uy, gx, gy);
          f[i * n + node] = post;
        }
      } else {
        // TRT: relax symmetric (even) and antisymmetric (odd) parts separately.
        // The Guo source is split the same way — its antisymmetric part carries
        // the injected momentum and must relax with ω⁻, or a steady shear flow
        // comes out under-forced (the force recovers as F only with this split).
        for (let i = 0; i < Q; i++) {
          const io = OPP[i];
          const fPlus = 0.5 * (fl[i] + fl[io]);
          const fMinus = 0.5 * (fl[i] - fl[io]);
          const ePlus = 0.5 * (eq[i] + eq[io]);
          const eMinus = 0.5 * (eq[i] - eq[io]);
          let post = fl[i] - opEff * (fPlus - ePlus) - omEff * (fMinus - eMinus);
          if (hasForce) {
            const si = this.guoSource(i, ux, uy, gx, gy);
            const sio = this.guoSource(io, ux, uy, gx, gy);
            const sPlus = 0.5 * (si + sio);
            const sMinus = 0.5 * (si - sio);
            post += (1 - 0.5 * opEff) * sPlus + (1 - 0.5 * omEff) * sMinus;
          }
          f[i * n + node] = post;
        }
      }
    }
  }

  /** Raw Guo (2002) forcing source S_i for link i (without the discrete
   *  (1 − ω/2) prefactor — the caller applies that, split per TRT rate). */
  private guoSource(i: number, ux: number, uy: number, gx: number, gy: number): number {
    const eu = EX[i] * ux + EY[i] * uy;
    const cx = INV_CS2 * (EX[i] - ux) + INV_CS4 * eu * EX[i];
    const cy = INV_CS2 * (EY[i] - uy) + INV_CS4 * eu * EY[i];
    return W[i] * (cx * gx + cy * gy);
  }

  // --- streaming + bounce-back --------------------------------------------

  private stream(): void {
    const { f, ftmp, n, nx, ny, cfg } = this;
    const periodicX = cfg.bcX === 'periodic';
    const periodicY = cfg.bcY === 'periodic';
    const lidU = cfg.lidU;

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) continue;

        for (let k = 0; k < Q; k++) {
          // Pull scheme: the population arriving along k came from x − e_k.
          let si = i - EX[k];
          let sj = j - EY[k];
          let wrapped = true;

          if (si < 0 || si >= nx) {
            if (periodicX) si = (si + nx) % nx;
            else wrapped = false;
          }
          if (sj < 0 || sj >= ny) {
            if (periodicY) sj = (sj + ny) % ny;
            else wrapped = false;
          }

          if (!wrapped) {
            // Streamed in from outside a solid domain wall → half-way bounce-back:
            // reflect this node's own opposite-going population. A moving top wall
            // (lid) injects momentum via the standard u_wall correction.
            const io = OPP[k];
            let bb = f[io * n + node];
            if (lidU !== 0 && sj >= ny) {
              // top wall moving with +x velocity lidU, ρ_w ≈ 1
              bb -= 2 * W[io] * 1 * INV_CS2 * (EX[io] * lidU);
            }
            ftmp[k * n + node] = bb;
            continue;
          }

          const src = si + nx * sj;
          if (this.solid[src]) {
            // Neighbour is a solid obstacle → bounce-back off it.
            ftmp[k * n + node] = f[OPP[k] * n + node];
          } else {
            ftmp[k * n + node] = f[k * n + src];
          }
        }
      }
    }
  }

  // --- macroscopic (Zou–He) boundaries on the open channel -----------------

  /** Applied after streaming: a Zou–He velocity inlet on the left edge and a
   *  stable zeroth-order extrapolation outflow on the right edge. Only active
   *  when bcX = 'channel'. */
  private applyMomentBoundaries(): void {
    if (this.cfg.bcX !== 'channel') return;
    const { f, n, nx, ny } = this;
    const uIn = this.cfg.inletU;

    // Left inlet (i = 0): impose (uIn, 0), solve for the three unknown
    // east-going populations f1, f5, f8 and the density (Zou & He, 1997).
    for (let j = 0; j < ny; j++) {
      const node = this.idx(0, j);
      if (this.solid[node]) continue;
      const f0 = f[0 * n + node];
      const f2 = f[2 * n + node];
      const f3 = f[3 * n + node];
      const f4 = f[4 * n + node];
      const f6 = f[6 * n + node];
      const f7 = f[7 * n + node];
      const rho = (f0 + f2 + f4 + 2 * (f3 + f6 + f7)) / (1 - uIn);
      f[1 * n + node] = f3 + (2 / 3) * rho * uIn;
      f[5 * n + node] = f7 - 0.5 * (f2 - f4) + (1 / 6) * rho * uIn;
      f[8 * n + node] = f6 + 0.5 * (f2 - f4) + (1 / 6) * rho * uIn;
    }

    // Right outflow (i = nx−1): copy the unknown west-going populations from the
    // neighbour upstream — a simple, robust open boundary that lets wakes leave.
    const last = nx - 1;
    for (let j = 0; j < ny; j++) {
      const node = this.idx(last, j);
      if (this.solid[node]) continue;
      const up = this.idx(last - 1, j);
      f[3 * n + node] = f[3 * n + up];
      f[6 * n + node] = f[6 * n + up];
      f[7 * n + node] = f[7 * n + up];
    }
  }

  // --- diagnostics ---------------------------------------------------------

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

  speedAt(i: number, j: number): number {
    const node = this.idx(i, j);
    return Math.hypot(this.ux[node], this.uy[node]);
  }

  /** Total mass Σρ over fluid nodes — conserved exactly by stream+collide on a
   *  periodic domain (a sanity invariant). */
  totalMass(): number {
    let s = 0;
    for (let node = 0; node < this.n; node++) if (!this.solid[node]) s += this.rho[node];
    return s;
  }

  /** Local strain-rate magnitude |S| read from the non-equilibrium stress —
   *  S_αβ = −1/(2 ρ c_s² τ) Π^neq_αβ. This is the quantity the LES model uses,
   *  and it lets us check the kinetic moments against an analytic velocity
   *  gradient with no finite differencing. Returns {sxx, sxy, syy}. */
  strainFromMoments(i: number, j: number): { sxx: number; sxy: number; syy: number } {
    const { f, n } = this;
    const node = this.idx(i, j);
    let rho = 0;
    let mx = 0;
    let my = 0;
    for (let k = 0; k < Q; k++) {
      const fk = f[k * n + node];
      rho += fk;
      mx += EX[k] * fk;
      my += EY[k] * fk;
    }
    const ux = mx / rho;
    const uy = my / rho;
    let pxx = 0;
    let pyy = 0;
    let pxy = 0;
    for (let k = 0; k < Q; k++) {
      const neq = f[k * n + node] - feq(k, rho, ux, uy);
      pxx += EX[k] * EX[k] * neq;
      pyy += EY[k] * EY[k] * neq;
      pxy += EX[k] * EY[k] * neq;
    }
    const c = -1 / (2 * rho * CS2 * this.tau);
    return { sxx: c * pxx, syy: c * pyy, sxy: c * pxy };
  }

  /** Net force on all solid nodes by the Ladd/Mei momentum-exchange method.
   *  Across every boundary link (fluid node x_f whose e_k-neighbour is solid)
   *  the bounce-back swaps populations f_k ↔ f_{opp k}, depositing momentum
   *  e_k·(f_k + f_{opp k}) on the wall. Summed over the obstacle this is the
   *  hydrodynamic force → a drag coefficient, all from the distributions. */
  solidForce(): { fx: number; fy: number } {
    const { f, n, nx, ny } = this;
    let fx = 0;
    let fy = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const node = this.idx(i, j);
        if (this.solid[node]) continue;
        for (let k = 1; k < Q; k++) {
          const si = i + EX[k];
          const sj = j + EY[k];
          if (si < 0 || si >= nx || sj < 0 || sj >= ny) continue;
          if (!this.solid[si + nx * sj]) continue;
          // x_f + e_k is solid: this link bounces. Post-stream, the two opposite
          // populations along the link both sit on the fluid node.
          const momentum = f[k * n + node] + f[OPP[k] * n + node];
          fx += momentum * EX[k];
          fy += momentum * EY[k];
        }
      }
    return { fx, fy };
  }
}
