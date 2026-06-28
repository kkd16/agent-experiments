// compressible.ts — a from-scratch finite-volume solver for the COMPRESSIBLE
// Euler equations (gas dynamics), the one physics every other solver in this
// studio deliberately avoids.
//
// Stable Fluids, the lattice-Boltzmann labs and the Shan–Chen models are all
// *incompressible* (or, for the kinetic solvers, low-Mach): the velocity field is
// held divergence-free by a Hodge projection, so no sound waves, no shocks. This
// solver throws that away. It marches the conservation laws for mass, momentum
// and energy of an ideal gas directly — a hyperbolic system whose solutions form
// genuine DISCONTINUITIES (shock waves and contact surfaces) in finite time. You
// cannot reach a shock with a smooth, central-difference scheme; you need a
// *Godunov* method that solves a little Riemann problem at every cell face and
// lets the discrete entropy do the upwinding. That is what lives here.
//
//   ∂U/∂t + ∂F(U)/∂x + ∂G(U)/∂y = S          (the 2-D Euler equations)
//
// with the vector of CONSERVED variables and its physical fluxes
//
//   U = [ ρ,  ρu,   ρv,   E      ]
//   F = [ ρu, ρu²+p, ρuv,  u(E+p) ]            (x-flux)
//   G = [ ρv, ρuv,   ρv²+p, v(E+p) ]           (y-flux)
//
// closed by the ideal-gas equation of state p = (γ−1)(E − ½ρ(u²+v²)) and total
// energy E = ρe + ½ρ|u|², e = p/((γ−1)ρ). The scheme is:
//
//   • a MUSCL-Hancock reconstruction (Toro §14): minmod-limited slopes give a
//     second-order, oscillation-free interface state, evolved a half step by the
//     primitive's own flux (the Hancock predictor) for second order in time too;
//   • an HLLC approximate Riemann flux at every face (Toro §10.4) — the
//     three-wave solver that, unlike plain HLL/Rusanov, resolves the CONTACT and
//     shear waves exactly, so a contact discontinuity stays crisp;
//   • Strang dimensional splitting (½X · Y · ½X) so the 2-D update keeps the 1-D
//     scheme's second order;
//   • a CFL-limited explicit time step from the true signal speed |u|+a;
//   • transmissive / reflective / periodic boundaries and an optional gravity
//     source (for Rayleigh–Taylor).
//
// The companion `exactRiemann` below is the *analytic* solution of the 1-D
// Riemann problem (Toro §4): an iterative solve of the pressure function for the
// star-region pressure, then a self-similar sampler. It is both a selectable
// reference profile in the lab and the ground truth the Verify suite measures the
// finite-volume solver against (the Sod shock tube converges to it in L1).
//
// Everything is pure float64 TypeScript — no GPU, no libraries — in the same
// spirit as the rest of Eddy.

export const GAMMA_DEFAULT = 1.4; // diatomic ideal gas (air)

/** A primitive (physical) gas state in one direction: density, normal &
 *  tangential velocity, pressure. */
export interface Prim {
  rho: number;
  u: number; // velocity along the sweep direction
  v: number; // velocity transverse to the sweep direction
  p: number;
}

/** Speed of sound a = √(γ p / ρ). */
export function soundSpeed(rho: number, p: number, gamma: number): number {
  return Math.sqrt((gamma * p) / rho);
}

// ---------------------------------------------------------------------------
// Exact Riemann solver for the 1-D Euler equations (ideal gas).
//
// Given a left and a right constant state separated by a membrane at x=0 that is
// removed at t=0, the solution is self-similar in ξ = x/t and consists of (left
// to right): the left state, a left wave (shock or rarefaction), the contact
// discontinuity, a right wave, the right state. The two unknowns are the pressure
// p* and velocity u* in the "star" region between the waves; they are found by
// solving f_L(p) + f_R(p) + (u_R − u_L) = 0 for p*, where f_K is the pressure
// function across the K-wave (Toro eq. 4.5–4.7).
// ---------------------------------------------------------------------------

export interface RiemannStar {
  pStar: number;
  uStar: number;
  /** Sample the self-similar solution at speed S = x/t → primitive (ρ,u,p). */
  sample: (S: number) => { rho: number; u: number; p: number };
}

/** The pressure function f_K(p) across one wave and its derivative, for the
 *  Newton iteration. K is the left or right data state. */
function pressureFunction(
  p: number,
  rhoK: number,
  pK: number,
  aK: number,
  gamma: number,
): { f: number; df: number } {
  if (p > pK) {
    // Shock branch.
    const AK = 2 / ((gamma + 1) * rhoK);
    const BK = ((gamma - 1) / (gamma + 1)) * pK;
    const q = Math.sqrt(AK / (BK + p));
    const f = (p - pK) * q;
    const df = q * (1 - (p - pK) / (2 * (BK + p)));
    return { f, df };
  }
  // Rarefaction branch.
  const pr = p / pK;
  const f = ((2 * aK) / (gamma - 1)) * (Math.pow(pr, (gamma - 1) / (2 * gamma)) - 1);
  const df = (1 / (rhoK * aK)) * Math.pow(pr, -(gamma + 1) / (2 * gamma));
  return { f, df };
}

/**
 * Solve the 1-D Riemann problem exactly. Returns p*, u* and a self-similar
 * sampler. Handles the vacuum-generating case (when the two rarefactions cannot
 * meet) by clamping to a near-vacuum pressure — enough for the demo and tests
 * here, which never start a true vacuum.
 */
export function exactRiemann(
  left: { rho: number; u: number; p: number },
  right: { rho: number; u: number; p: number },
  gamma: number = GAMMA_DEFAULT,
): RiemannStar {
  const { rho: rhoL, u: uL, p: pL } = left;
  const { rho: rhoR, u: uR, p: pR } = right;
  const aL = soundSpeed(rhoL, pL, gamma);
  const aR = soundSpeed(rhoR, pR, gamma);

  // Two-rarefaction / PVRS initial guess for p*, clamped positive.
  const pvrs = 0.5 * (pL + pR) - 0.125 * (uR - uL) * (rhoL + rhoR) * (aL + aR);
  let p = Math.max(1e-8, pvrs);

  // Newton–Raphson on f(p) = f_L + f_R + Δu.
  for (let it = 0; it < 100; it++) {
    const L = pressureFunction(p, rhoL, pL, aL, gamma);
    const R = pressureFunction(p, rhoR, pR, aR, gamma);
    const f = L.f + R.f + (uR - uL);
    const df = L.df + R.df;
    const pNew = p - f / df;
    const change = 2 * Math.abs((pNew - p) / (pNew + p));
    p = pNew > 0 ? pNew : 1e-8;
    if (change < 1e-12) break;
  }
  const pStar = p;
  const fL = pressureFunction(pStar, rhoL, pL, aL, gamma).f;
  const fR = pressureFunction(pStar, rhoR, pR, aR, gamma).f;
  const uStar = 0.5 * (uL + uR) + 0.5 * (fR - fL);

  const g1 = (gamma - 1) / (2 * gamma);
  const g2 = (gamma + 1) / (2 * gamma);

  const sample = (S: number): { rho: number; u: number; p: number } => {
    if (S <= uStar) {
      // Left of the contact.
      if (pStar > pL) {
        // Left shock.
        const SL = uL - aL * Math.sqrt(g2 * (pStar / pL) + g1);
        if (S <= SL) return { rho: rhoL, u: uL, p: pL };
        // Star-left (post-shock) density (Rankine–Hugoniot).
        const r = pStar / pL;
        const rhoSL = rhoL * (r + (gamma - 1) / (gamma + 1)) / (((gamma - 1) / (gamma + 1)) * r + 1);
        return { rho: rhoSL, u: uStar, p: pStar };
      }
      // Left rarefaction fan.
      const aStarL = aL * Math.pow(pStar / pL, g1);
      const SHL = uL - aL; // head
      const STL = uStar - aStarL; // tail
      if (S <= SHL) return { rho: rhoL, u: uL, p: pL };
      if (S >= STL) {
        const rhoSL = rhoL * Math.pow(pStar / pL, 1 / gamma);
        return { rho: rhoSL, u: uStar, p: pStar };
      }
      // Inside the fan.
      const c = (2 / (gamma + 1)) + (((gamma - 1) / ((gamma + 1) * aL)) * (uL - S));
      const rho = rhoL * Math.pow(c, 2 / (gamma - 1));
      const u = (2 / (gamma + 1)) * (aL + ((gamma - 1) / 2) * uL + S);
      const pp = pL * Math.pow(c, (2 * gamma) / (gamma - 1));
      return { rho, u, p: pp };
    }
    // Right of the contact.
    if (pStar > pR) {
      // Right shock.
      const SR = uR + aR * Math.sqrt(g2 * (pStar / pR) + g1);
      if (S >= SR) return { rho: rhoR, u: uR, p: pR };
      const r = pStar / pR;
      const rhoSR = rhoR * (r + (gamma - 1) / (gamma + 1)) / (((gamma - 1) / (gamma + 1)) * r + 1);
      return { rho: rhoSR, u: uStar, p: pStar };
    }
    // Right rarefaction fan.
    const aStarR = aR * Math.pow(pStar / pR, g1);
    const SHR = uR + aR;
    const STR = uStar + aStarR;
    if (S >= SHR) return { rho: rhoR, u: uR, p: pR };
    if (S <= STR) {
      const rhoSR = rhoR * Math.pow(pStar / pR, 1 / gamma);
      return { rho: rhoSR, u: uStar, p: pStar };
    }
    const c = (2 / (gamma + 1)) - (((gamma - 1) / ((gamma + 1) * aR)) * (uR - S));
    const rho = rhoR * Math.pow(c, 2 / (gamma - 1));
    const u = (2 / (gamma + 1)) * (-aR + ((gamma - 1) / 2) * uR + S);
    const pp = pR * Math.pow(c, (2 * gamma) / (gamma - 1));
    return { rho, u, p: pp };
  };

  return { pStar, uStar, sample };
}

// ---------------------------------------------------------------------------
// Conserved-variable helpers. A conserved cell is the 4-tuple stored as a flat
// stride of a Float64Array: [ρ, ρu, ρv, E].
// ---------------------------------------------------------------------------

/** Pressure from a conserved 4-vector via the ideal-gas EOS. */
export function pressureFromU(
  rho: number,
  mx: number,
  my: number,
  E: number,
  gamma: number,
): number {
  const ke = 0.5 * (mx * mx + my * my) / rho;
  return (gamma - 1) * (E - ke);
}

/** Physical x-direction flux F(U) from a conserved 4-vector (out into `out`). */
function fluxX(rho: number, mx: number, my: number, E: number, gamma: number, out: number[]): void {
  const u = mx / rho;
  const p = pressureFromU(rho, mx, my, E, gamma);
  out[0] = mx;
  out[1] = mx * u + p;
  out[2] = my * u;
  out[3] = u * (E + p);
}

/**
 * HLLC approximate Riemann flux in the sweep direction. Inputs are the
 * reconstructed *primitive* left/right states at one face (u = normal velocity,
 * v = transverse). Returns the 4-component conserved flux. This is Toro's
 * three-wave HLLC solver: estimate the fastest left/right signal speeds (SL, SR)
 * with the pressure-based wave-speed estimate, the contact speed S*, then pick
 * the flux of whichever of the four regions straddles the face (x/t = 0).
 */
export function hllcFlux(qL: Prim, qR: Prim, gamma: number, out: number[]): void {
  const { rho: rL, u: uL, v: vL, p: pL } = qL;
  const { rho: rR, u: uR, v: vR, p: pR } = qR;
  const aL = soundSpeed(rL, pL, gamma);
  const aR = soundSpeed(rR, pR, gamma);

  // Conserved states.
  const EL = pL / (gamma - 1) + 0.5 * rL * (uL * uL + vL * vL);
  const ER = pR / (gamma - 1) + 0.5 * rR * (uR * uR + vR * vR);

  // Pressure-based (PVRS) star-pressure estimate → adaptive wave speeds (Toro
  // §10.5.2, the "right" way to make HLLC robust through strong rarefactions).
  const rhoBar = 0.5 * (rL + rR);
  const aBar = 0.5 * (aL + aR);
  const pPvrs = 0.5 * (pL + pR) - 0.5 * (uR - uL) * rhoBar * aBar;
  const pStar = Math.max(0, pPvrs);
  const qK = (pK: number): number =>
    pStar <= pK ? 1 : Math.sqrt(1 + ((gamma + 1) / (2 * gamma)) * (pStar / pK - 1));
  const SL = uL - aL * qK(pL);
  const SR = uR + aR * qK(pR);

  // Contact speed (Toro eq. 10.37).
  const Sstar =
    (pR - pL + rL * uL * (SL - uL) - rR * uR * (SR - uR)) /
    (rL * (SL - uL) - rR * (SR - uR));

  if (SL >= 0) {
    fluxX(rL, rL * uL, rL * vL, EL, gamma, out);
    return;
  }
  if (SR <= 0) {
    fluxX(rR, rR * uR, rR * vR, ER, gamma, out);
    return;
  }

  if (Sstar >= 0) {
    // Left star state U*L (Toro eq. 10.39) and flux F*L = FL + SL(U*L − UL).
    fluxX(rL, rL * uL, rL * vL, EL, gamma, out);
    const factor = rL * (SL - uL) / (SL - Sstar);
    const uStar0 = factor; // ρ*
    const uStar1 = factor * Sstar; // ρu*
    const uStar2 = factor * vL; // ρv*
    const uStar3 = factor * (EL / rL + (Sstar - uL) * (Sstar + pL / (rL * (SL - uL))));
    out[0] += SL * (uStar0 - rL);
    out[1] += SL * (uStar1 - rL * uL);
    out[2] += SL * (uStar2 - rL * vL);
    out[3] += SL * (uStar3 - EL);
    return;
  }

  // Right star state U*R and flux F*R = FR + SR(U*R − UR).
  fluxX(rR, rR * uR, rR * vR, ER, gamma, out);
  const factor = rR * (SR - uR) / (SR - Sstar);
  const uStar0 = factor;
  const uStar1 = factor * Sstar;
  const uStar2 = factor * vR;
  const uStar3 = factor * (ER / rR + (Sstar - uR) * (Sstar + pR / (rR * (SR - uR))));
  out[0] += SR * (uStar0 - rR);
  out[1] += SR * (uStar1 - rR * uR);
  out[2] += SR * (uStar2 - rR * vR);
  out[3] += SR * (uStar3 - ER);
}

// ---------------------------------------------------------------------------
// minmod slope limiter.
// ---------------------------------------------------------------------------
function minmod(a: number, b: number): number {
  if (a * b <= 0) return 0;
  return Math.abs(a) < Math.abs(b) ? a : b;
}

export type BC = 'transmissive' | 'reflective' | 'periodic';

export interface CompressibleParams {
  nx: number;
  ny: number;
  gamma?: number;
  cfl?: number;
  bcX?: BC;
  bcY?: BC;
  gravityY?: number; // body acceleration in −y (Rayleigh–Taylor); 0 by default
  dx?: number; // physical cell size (square cells); defaults to 1 (lattice units)
}

const G = 2; // ghost-cell layers (MUSCL needs the cell ±1 of each face cell)

/**
 * The 2-D compressible Euler solver. Stores the four conserved fields on a
 * collocated grid padded by `G` ghost cells on every side, and advances them by
 * Strang-split, MUSCL-Hancock + HLLC Godunov sweeps.
 */
export class CompressibleEuler {
  readonly nx: number;
  readonly ny: number;
  readonly gamma: number;
  readonly cfl: number;
  readonly bcX: BC;
  readonly bcY: BC;
  readonly gravityY: number;
  readonly dx: number;

  // Padded grid dimensions and the conserved fields (flat, row-major).
  readonly NX: number;
  readonly NY: number;
  rho: Float64Array;
  mx: Float64Array;
  my: Float64Array;
  E: Float64Array;

  // Scratch for a sweep strip (reconstruction + fluxes), sized to the longer axis.
  private scratch: Float64Array;
  time = 0;
  steps = 0;

  constructor(p: CompressibleParams) {
    this.nx = p.nx;
    this.ny = p.ny;
    this.gamma = p.gamma ?? GAMMA_DEFAULT;
    this.cfl = p.cfl ?? 0.4;
    this.bcX = p.bcX ?? 'transmissive';
    this.bcY = p.bcY ?? 'transmissive';
    this.gravityY = p.gravityY ?? 0;
    this.dx = p.dx ?? 1;
    this.NX = p.nx + 2 * G;
    this.NY = p.ny + 2 * G;
    const n = this.NX * this.NY;
    this.rho = new Float64Array(n);
    this.mx = new Float64Array(n);
    this.my = new Float64Array(n);
    this.E = new Float64Array(n);
    this.scratch = new Float64Array(0);
  }

  /** Flat index into the padded grid for interior coordinates i∈[0,nx), j∈[0,ny). */
  idx(i: number, j: number): number {
    return i + G + this.NX * (j + G);
  }

  /** Set a cell from primitive variables. */
  setPrim(i: number, j: number, rho: number, u: number, v: number, p: number): void {
    const k = this.idx(i, j);
    this.rho[k] = rho;
    this.mx[k] = rho * u;
    this.my[k] = rho * v;
    this.E[k] = p / (this.gamma - 1) + 0.5 * rho * (u * u + v * v);
  }

  /** Initialise every interior cell from a primitive field function. */
  initField(fn: (i: number, j: number) => { rho: number; u: number; v: number; p: number }): void {
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const s = fn(i, j);
        this.setPrim(i, j, s.rho, s.u, s.v, s.p);
      }
  }

  pressureAt(k: number): number {
    return pressureFromU(this.rho[k], this.mx[k], this.my[k], this.E[k], this.gamma);
  }

  /** Largest stable time step from the CFL condition over the whole grid. */
  maxDt(): number {
    let smax = 1e-30;
    const { NX, NY, gamma } = this;
    for (let j = G; j < NY - G; j++)
      for (let i = G; i < NX - G; i++) {
        const k = i + NX * j;
        const rho = this.rho[k];
        const u = this.mx[k] / rho;
        const v = this.my[k] / rho;
        const p = this.pressureAt(k);
        const a = soundSpeed(rho, Math.max(p, 1e-12), gamma);
        const s = Math.max(Math.abs(u), Math.abs(v)) + a;
        if (s > smax) smax = s;
      }
    return (this.cfl * this.dx) / smax;
  }

  /** Fill the ghost layers according to the boundary conditions for the X edges. */
  private applyBCx(): void {
    const { NX, NY } = this;
    for (let j = 0; j < NY; j++) {
      const row = NX * j;
      for (let g = 0; g < G; g++) {
        // Left edge.
        if (this.bcX === 'periodic') {
          const src = row + (NX - 2 * G + g);
          const dst = row + g;
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.mx[src];
          this.my[dst] = this.my[src];
          this.E[dst] = this.E[src];
        } else {
          const src = row + (this.bcX === 'reflective' ? 2 * G - 1 - g : G);
          const dst = row + g;
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.bcX === 'reflective' ? -this.mx[src] : this.mx[src];
          this.my[dst] = this.my[src];
          this.E[dst] = this.E[src];
        }
        // Right edge.
        if (this.bcX === 'periodic') {
          const src = row + (G + g);
          const dst = row + (NX - G + g);
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.mx[src];
          this.my[dst] = this.my[src];
          this.E[dst] = this.E[src];
        } else {
          const src = row + (this.bcX === 'reflective' ? NX - G - 1 - g : NX - G - 1);
          const dst = row + (NX - G + g);
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.bcX === 'reflective' ? -this.mx[src] : this.mx[src];
          this.my[dst] = this.my[src];
          this.E[dst] = this.E[src];
        }
      }
    }
  }

  /** Fill the ghost layers for the Y edges. */
  private applyBCy(): void {
    const { NX, NY } = this;
    for (let i = 0; i < NX; i++) {
      for (let g = 0; g < G; g++) {
        // Bottom edge.
        if (this.bcY === 'periodic') {
          const src = i + NX * (NY - 2 * G + g);
          const dst = i + NX * g;
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.mx[src];
          this.my[dst] = this.my[src];
          this.E[dst] = this.E[src];
        } else {
          const sj = this.bcY === 'reflective' ? 2 * G - 1 - g : G;
          const src = i + NX * sj;
          const dst = i + NX * g;
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.mx[src];
          this.my[dst] = this.bcY === 'reflective' ? -this.my[src] : this.my[src];
          this.E[dst] = this.E[src];
        }
        // Top edge.
        if (this.bcY === 'periodic') {
          const src = i + NX * (G + g);
          const dst = i + NX * (NY - G + g);
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.mx[src];
          this.my[dst] = this.my[src];
          this.E[dst] = this.E[src];
        } else {
          const sj = this.bcY === 'reflective' ? NY - G - 1 - g : NY - G - 1;
          const src = i + NX * sj;
          const dst = i + NX * (NY - G + g);
          this.rho[dst] = this.rho[src];
          this.mx[dst] = this.mx[src];
          this.my[dst] = this.bcY === 'reflective' ? -this.my[src] : this.my[src];
          this.E[dst] = this.E[src];
        }
      }
    }
  }

  /**
   * One MUSCL-Hancock + HLLC sweep along X for time `dt`. `axis` selects which
   * momentum component is the "normal" one; for the Y sweep we transpose the
   * roles of mx/my by passing the column stride. Implemented generically with a
   * `stride` between successive cells in the sweep line and a `count` of interior
   * cells, reading/writing the conserved fields through accessor closures so the
   * exact same code serves both directions.
   */
  private sweep(dt: number, dir: 'x' | 'y'): void {
    const { NX, NY, gamma } = this;
    const stride = dir === 'x' ? 1 : NX;
    const lineCount = dir === 'x' ? NY : NX; // number of strips
    const cells = dir === 'x' ? NX : NY; // cells along a strip (incl. ghosts)
    const interior = cells - 2 * G;

    // Normal/transverse momentum selectors.
    const norm = dir === 'x' ? this.mx : this.my;
    const tang = dir === 'x' ? this.my : this.mx;
    const idtdx = dt / this.dx; // the only place the cell size enters the update

    // Scratch holds, per strip: primitive L/R reconstructed face states already
    // half-step evolved, plus the interface fluxes. We allocate transient arrays
    // sized to the strip; reused across strips via class scratch.
    const need = cells * 4; // primitive evolved-left + evolved-right interleaved would be more; keep simple
    if (this.scratch.length < need) this.scratch = new Float64Array(need);

    // Per-strip temporaries.
    const wL = new Float64Array(cells * 4); // half-evolved left face value of each cell
    const wR = new Float64Array(cells * 4); // half-evolved right face value of each cell
    const flux = new Float64Array((interior + 1) * 4); // interface fluxes
    const fbuf: number[] = [0, 0, 0, 0];

    for (let line = 0; line < lineCount; line++) {
      const base = dir === 'x' ? NX * line : line;

      // --- 1) reconstruct + half-step-evolve each cell that has neighbours ---
      // We need cells from index 1 .. cells-2 (so faces G-1 .. cells-G exist).
      for (let c = 1; c < cells - 1; c++) {
        const k = base + c * stride;
        const km = base + (c - 1) * stride;
        const kp = base + (c + 1) * stride;
        // Primitive at the three cells.
        const r0 = this.rho[k];
        const un0 = norm[k] / r0;
        const ut0 = tang[k] / r0;
        const p0 = pressureFromU(this.rho[k], this.mx[k], this.my[k], this.E[k], gamma);

        const rm = this.rho[km];
        const unm = norm[km] / rm;
        const utm = tang[km] / rm;
        const pm = pressureFromU(this.rho[km], this.mx[km], this.my[km], this.E[km], gamma);

        const rp = this.rho[kp];
        const unp = norm[kp] / rp;
        const utp = tang[kp] / rp;
        const pp = pressureFromU(this.rho[kp], this.mx[kp], this.my[kp], this.E[kp], gamma);

        // minmod-limited slopes on primitive variables.
        const dRho = minmod(r0 - rm, rp - r0);
        const dUn = minmod(un0 - unm, unp - un0);
        const dUt = minmod(ut0 - utm, utp - ut0);
        const dP = minmod(p0 - pm, pp - p0);

        // Face values.
        let rhoL = r0 - 0.5 * dRho;
        let unLv = un0 - 0.5 * dUn;
        let utLv = ut0 - 0.5 * dUt;
        let pLv = p0 - 0.5 * dP;
        let rhoR = r0 + 0.5 * dRho;
        let unRv = un0 + 0.5 * dUn;
        let utRv = ut0 + 0.5 * dUt;
        let pRv = p0 + 0.5 * dP;

        // Positivity safeguard: if the reconstruction produced a non-physical
        // face state, drop this cell to first order (piecewise constant).
        if (rhoL <= 0 || pLv <= 0 || rhoR <= 0 || pRv <= 0) {
          rhoL = rhoR = r0;
          unLv = unRv = un0;
          utLv = utRv = ut0;
          pLv = pRv = p0;
        }

        // Hancock half-step evolution by the cell's own physical flux:
        //   w ← w + ½(dt/dx)[F(wL) − F(wR)]   (dx = 1)
        // computed in conserved variables, then converted back to primitive.
        const UL0 = rhoL, UL1 = rhoL * unLv, UL2 = rhoL * utLv,
          ULe = pLv / (gamma - 1) + 0.5 * rhoL * (unLv * unLv + utLv * utLv);
        const UR0 = rhoR, UR1 = rhoR * unRv, UR2 = rhoR * utRv,
          URe = pRv / (gamma - 1) + 0.5 * rhoR * (unRv * unRv + utRv * utRv);
        fluxX(UL0, UL1, UL2, ULe, gamma, fbuf);
        const FL0 = fbuf[0], FL1 = fbuf[1], FL2 = fbuf[2], FL3 = fbuf[3];
        fluxX(UR0, UR1, UR2, URe, gamma, fbuf);
        const dF0 = 0.5 * idtdx * (FL0 - fbuf[0]);
        const dF1 = 0.5 * idtdx * (FL1 - fbuf[1]);
        const dF2 = 0.5 * idtdx * (FL2 - fbuf[2]);
        const dF3 = 0.5 * idtdx * (FL3 - fbuf[3]);
        // Evolve both face states by the same increment.
        const eL0 = UL0 + dF0, eL1 = UL1 + dF1, eL2 = UL2 + dF2, eL3 = ULe + dF3;
        const eR0 = UR0 + dF0, eR1 = UR1 + dF1, eR2 = UR2 + dF2, eR3 = URe + dF3;

        // Convert back to primitive; if the half-step went unphysical, fall back
        // to the un-evolved (still limited) face values.
        const o = c * 4;
        const pL2 = pressureFromU(eL0, eL1, eL2, eL3, gamma);
        if (eL0 > 0 && pL2 > 0) {
          wL[o] = eL0; wL[o + 1] = eL1 / eL0; wL[o + 2] = eL2 / eL0; wL[o + 3] = pL2;
        } else {
          wL[o] = rhoL; wL[o + 1] = unLv; wL[o + 2] = utLv; wL[o + 3] = pLv;
        }
        const pR2 = pressureFromU(eR0, eR1, eR2, eR3, gamma);
        if (eR0 > 0 && pR2 > 0) {
          wR[o] = eR0; wR[o + 1] = eR1 / eR0; wR[o + 2] = eR2 / eR0; wR[o + 3] = pR2;
        } else {
          wR[o] = rhoR; wR[o + 1] = unRv; wR[o + 2] = utRv; wR[o + 3] = pRv;
        }
      }

      // --- 2) HLLC flux at each interior face f between cell (G-1+f) and (G+f) ---
      const qL: Prim = { rho: 0, u: 0, v: 0, p: 0 };
      const qR: Prim = { rho: 0, u: 0, v: 0, p: 0 };
      for (let f = 0; f <= interior; f++) {
        const cl = G - 1 + f; // left cell of the face
        const cr = G + f; // right cell
        const ol = cl * 4;
        const or_ = cr * 4;
        qL.rho = wR[ol]; qL.u = wR[ol + 1]; qL.v = wR[ol + 2]; qL.p = wR[ol + 3];
        qR.rho = wL[or_]; qR.u = wL[or_ + 1]; qR.v = wL[or_ + 2]; qR.p = wL[or_ + 3];
        hllcFlux(qL, qR, gamma, fbuf);
        const of = f * 4;
        flux[of] = fbuf[0]; flux[of + 1] = fbuf[1]; flux[of + 2] = fbuf[2]; flux[of + 3] = fbuf[3];
      }

      // --- 3) conservative update of interior cells ---
      for (let ci = 0; ci < interior; ci++) {
        const c = G + ci;
        const k = base + c * stride;
        const fl = ci * 4; // face to the left of the cell
        const fr = (ci + 1) * 4; // face to the right
        // Conservative update with the cell size folded in. Normal momentum is
        // `norm`, transverse is `tang`.
        this.rho[k] += idtdx * (flux[fl] - flux[fr]);
        norm[k] += idtdx * (flux[fl + 1] - flux[fr + 1]);
        tang[k] += idtdx * (flux[fl + 2] - flux[fr + 2]);
        this.E[k] += idtdx * (flux[fl + 3] - flux[fr + 3]);
      }
    }
  }

  /** Apply the gravity source (acts in −y) over a step dt, energy-consistent. */
  private applyGravity(dt: number): void {
    if (this.gravityY === 0) return;
    const { NX, NY } = this;
    const g = this.gravityY;
    for (let j = G; j < NY - G; j++)
      for (let i = G; i < NX - G; i++) {
        const k = i + NX * j;
        const rho = this.rho[k];
        const vOld = this.my[k] / rho;
        this.my[k] -= dt * rho * g; // momentum gains downward (−y) impulse
        const vNew = this.my[k] / rho;
        // Work done by gravity on the fluid: ρ g · v (midpoint).
        this.E[k] -= dt * rho * g * 0.5 * (vOld + vNew);
      }
  }

  /** Advance the whole field by one Strang-split step of size dt. */
  step(dt: number): void {
    // Strang: ½X · Y · ½X with the gravity source bracketing symmetrically.
    if (this.gravityY !== 0) this.applyGravity(0.5 * dt);
    this.applyBCx();
    this.sweep(0.5 * dt, 'x');
    this.applyBCy();
    this.sweep(dt, 'y');
    this.applyBCx();
    this.sweep(0.5 * dt, 'x');
    if (this.gravityY !== 0) this.applyGravity(0.5 * dt);
    this.time += dt;
    this.steps++;
  }

  /** Advance by the largest CFL-stable step, returning the dt taken. */
  stepCFL(dtCap = Infinity): number {
    const dt = Math.min(this.maxDt(), dtCap);
    this.step(dt);
    return dt;
  }

  // --- field extractors for rendering / measurement -------------------------

  /** Total conserved quantities over the interior (for conservation checks). */
  totals(): { mass: number; momX: number; momY: number; energy: number } {
    const { NX, NY } = this;
    let mass = 0, momX = 0, momY = 0, energy = 0;
    for (let j = G; j < NY - G; j++)
      for (let i = G; i < NX - G; i++) {
        const k = i + NX * j;
        mass += this.rho[k];
        momX += this.mx[k];
        momY += this.my[k];
        energy += this.E[k];
      }
    return { mass, momX, momY, energy };
  }

  /** True if every interior cell has positive density and pressure. */
  isPhysical(): boolean {
    const { NX, NY } = this;
    for (let j = G; j < NY - G; j++)
      for (let i = G; i < NX - G; i++) {
        const k = i + NX * j;
        if (!(this.rho[k] > 0)) return false;
        if (!(this.pressureAt(k) > 0)) return false;
      }
    return true;
  }
}

/**
 * Drive a purely 1-D Sod-style shock tube to a final time on a grid of `n`
 * cells (domain [0,1], membrane at x=0.5), and return the cell-centred density
 * profile. Used by the lab's 1-D mode and the convergence verification. Uses the
 * full 2-D solver with ny=1 and periodic-in-y so only the X scheme is exercised.
 */
export function runShockTube1D(
  n: number,
  tEnd: number,
  left: { rho: number; u: number; p: number },
  right: { rho: number; u: number; p: number },
  gamma: number = GAMMA_DEFAULT,
): { x: Float64Array; rho: Float64Array; u: Float64Array; p: Float64Array; steps: number } {
  const sim = new CompressibleEuler({ nx: n, ny: 1, gamma, bcX: 'transmissive', bcY: 'periodic', cfl: 0.4, dx: 1 / n });
  sim.initField((i) => {
    const xc = (i + 0.5) / n;
    return xc < 0.5 ? { ...left, v: 0 } : { ...right, v: 0 };
  });
  let t = 0;
  let guard = 0;
  while (t < tEnd && guard < 200000) {
    const dt = Math.min(sim.maxDt(), tEnd - t);
    if (dt <= 0) break;
    sim.step(dt);
    t += dt;
    guard++;
  }
  const x = new Float64Array(n);
  const rho = new Float64Array(n);
  const u = new Float64Array(n);
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = sim.idx(i, 0);
    x[i] = (i + 0.5) / n;
    rho[i] = sim.rho[k];
    u[i] = sim.mx[k] / sim.rho[k];
    p[i] = sim.pressureAt(k);
  }
  return { x, rho, u, p, steps: sim.steps };
}

/**
 * The exact density/velocity/pressure profile of a 1-D Riemann problem at time
 * `tEnd`, sampled at the same cell centres as `runShockTube1D` (membrane at
 * x=0.5). The lab overlays this on the finite-volume result.
 */
export function exactShockTubeProfile(
  n: number,
  tEnd: number,
  left: { rho: number; u: number; p: number },
  right: { rho: number; u: number; p: number },
  gamma: number = GAMMA_DEFAULT,
): { x: Float64Array; rho: Float64Array; u: Float64Array; p: Float64Array } {
  const star = exactRiemann(left, right, gamma);
  const x = new Float64Array(n);
  const rho = new Float64Array(n);
  const u = new Float64Array(n);
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const xc = (i + 0.5) / n;
    const S = (xc - 0.5) / tEnd;
    const s = star.sample(S);
    x[i] = xc;
    rho[i] = s.rho;
    u[i] = s.u;
    p[i] = s.p;
  }
  return { x, rho, u, p };
}
