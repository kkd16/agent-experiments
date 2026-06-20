// fluid.ts — a from-scratch real-time incompressible fluid solver.
//
// This is a grid-based ("Eulerian") solver for the incompressible
// Navier–Stokes equations, following Jos Stam's "Stable Fluids" (1999) and
// "Real-Time Fluid Dynamics for Games" (2003), with three additions that make
// it feel alive: RGB dye advection (for colour mixing), vorticity confinement
// (to fight the numerical dissipation of semi-Lagrangian advection), and
// arbitrary internal solid obstacles (so the flow can break around a cylinder
// and shed a von Kármán vortex street).
//
// The grid is collocated with a one-cell halo of ghost cells, so a solver of
// resolution N stores (N+2)² samples per field. Interior cells are indexed
// 1..N; the ghost ring (index 0 and N+1) carries boundary conditions.

import { Multigrid } from './multigrid';

// Boundary codes for `setBnd`: 0 = scalar (dye/temp/divergence), 1 = u
// (x-velocity), 2 = v (y-velocity), 3 = pressure (so open *outflow* faces can take
// a Dirichlet p = 0 while walls/inflow stay Neumann).
export type Boundary = 0 | 1 | 2 | 3;

export type Side = 'left' | 'right' | 'top' | 'bottom';
/** A domain edge is a closed `wall`, an `inflow` (velocity imposed elsewhere), or
 *  an `outflow` (open: zero-gradient velocity + Dirichlet pressure that lets the
 *  flow leave the box instead of recirculating). */
export type EdgeKind = 'wall' | 'inflow' | 'outflow';
export type Boundaries = Record<Side, EdgeKind>;
const CLOSED_BOX: Boundaries = { left: 'wall', right: 'wall', top: 'wall', bottom: 'wall' };

export interface FluidParams {
  /** Kinematic viscosity. 0 = inviscid (crisp, turbulent). */
  viscosity: number;
  /** Velocity damping per second (0 = none, 1 = instant stop). */
  velocityDissipation: number;
  /** Dye fade per second. */
  dyeDissipation: number;
  /** Vorticity confinement strength (re-injects swirl). */
  vorticity: number;
  /** Jacobi/Gauss–Seidel iterations for the pressure & diffusion solves. */
  iterations: number;
  /** Gravity / buoyancy in grid units (positive pulls down on +y). */
  gravity: number;
  /** Use MacCormack (2nd-order, clamped) advection for dye — sharper, less smeared. */
  sharpDye: boolean;
  /**
   * Over-relaxation factor ω for the linear (pressure/diffusion) solves. ω = 1 is
   * plain Gauss–Seidel; ω ∈ (1, 2) is SOR (successive over-relaxation), which
   * converges markedly faster — the same number of sweeps drives divergence lower.
   */
  overRelax: number;
  /**
   * Boussinesq buoyancy: lift per unit (T − ambient). Positive ⇒ hot fluid rises.
   * This is *real* thermal buoyancy from a temperature field, distinct from the
   * dye-mass `gravity` body force.
   */
  buoyancy: number;
  /** Thermal diffusivity κ — how fast heat spreads (a diffusion of the T field). */
  thermalDiffusion: number;
  /** Newton cooling: relaxation of temperature back toward `ambient`, per second. */
  cooling: number;
  /** Reference temperature the buoyancy force and cooling are measured against. */
  ambient: number;
  /**
   * Which Poisson solver the projection uses, all over the *identical* 5-point
   * Neumann/obstacle stencil so they converge to the same field:
   *  - `'sor'`  — red-black successive over-relaxation (a stationary relaxation),
   *  - `'cg'`   — Jacobi-preconditioned Conjugate Gradients (a Krylov method),
   *  - `'mg'`   — geometric multigrid V-cycles (work-optimal O(N); convergence
   *               factor independent of grid size on open domains),
   *  - `'mgcg'` — multigrid-preconditioned Conjugate Gradients: a V-cycle as the
   *               CG preconditioner — grid-independent *and* robust to obstacles.
   */
  pressureSolver: 'sor' | 'cg' | 'mg' | 'mgcg';
  /**
   * Combustion reaction rate (first-order). 0 disables the reactive-flow path
   * entirely. When > 0, fuel hotter than `ignition` burns at this rate, releasing
   * heat and depositing flame/soot dye.
   */
  combustion: number;
  /** Temperature above which fuel ignites and sustains a flame. */
  ignition: number;
  /** Temperature released into the T field per unit fuel burned (exothermicity). */
  heatRelease: number;
  /**
   * Variable-density (non-Boussinesq) buoyancy: lift per unit local dye/smoke
   * mass. Positive ⇒ smoke is lighter than air and rises; negative ⇒ it is heavy
   * and sinks. Distinct from the thermal Boussinesq `buoyancy` term.
   */
  smokeBuoyancy: number;
  /**
   * Scalar (dye) diffusivity κ_s — molecular diffusion of the dye, decoupled from
   * the momentum viscosity ν. Their ratio is the **Schmidt number** Sc = ν/κ_s,
   * which controls how sharp the scalar's filaments stay relative to the velocity
   * field: high Sc (κ_s → 0) lets ink fold into ever-finer streaks, low Sc blurs
   * it. 0 = no diffusion (only numerical dissipation acts on the dye).
   */
  dyeDiffusion: number;
  /**
   * **Magnetohydrodynamics.** When true the solver evolves an in-plane magnetic
   * field B = (bx, by) coupled to the flow: the velocity feels the **Lorentz
   * force** (the divergence-free part of the magnetic tension (B·∇)B, the magnetic
   * pressure ∇(B²/2) being swept into the velocity's own pressure projection), and
   * B is advanced by the **induction equation** ∂ₜB = ∇×(u×B) + η∇²B = −(u·∇)B +
   * (B·∇)u + η∇²B and kept solenoidal (∇·B = 0) by the *same* Hodge projection that
   * keeps u incompressible. Setting this turns the Navier–Stokes studio into an
   * incompressible-MHD one (Alfvén waves, current sheets, reconnection).
   */
  mhd: boolean;
  /**
   * Magnetic diffusivity η (resistivity / Ohmic dissipation) for the induction
   * equation — the magnetic analogue of viscosity. 0 = **ideal MHD** (the field is
   * frozen into the fluid, Alfvén's theorem; reconnection happens only through the
   * grid's numerical resistivity). η > 0 lets field lines slip and reconnect.
   */
  resistivity: number;
}

export const DEFAULT_PARAMS: FluidParams = {
  viscosity: 0,
  velocityDissipation: 0.02,
  dyeDissipation: 0.12,
  sharpDye: true,
  vorticity: 6,
  iterations: 24,
  gravity: 0,
  overRelax: 1,
  buoyancy: 0,
  thermalDiffusion: 0,
  cooling: 0,
  ambient: 0,
  pressureSolver: 'sor',
  combustion: 0,
  ignition: 0.5,
  heatRelease: 2.5,
  smokeBuoyancy: 0,
  dyeDiffusion: 0,
  mhd: false,
  resistivity: 0,
};

export class FluidSolver {
  readonly N: number;
  readonly size: number;

  // Velocity (current + previous-step scratch).
  u: Float32Array;
  v: Float32Array;
  u0: Float32Array;
  v0: Float32Array;

  // Dye, three channels for colour. r/g/b are current, *0 are scratch.
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  r0: Float32Array;
  g0: Float32Array;
  b0: Float32Array;

  // Temperature field (Boussinesq buoyancy) + scratch.
  t: Float32Array;
  t0: Float32Array;

  // Fuel field for the reactive-flow (combustion) model + scratch.
  fuel: Float32Array;
  fuel0: Float32Array;

  // In-plane magnetic field B = (bx, by) for the magnetohydrodynamics (MHD) path,
  // with scratch, plus the out-of-plane current density jz = ∂ₓB_y − ∂_yB_x (a
  // diagnostic the renderer/probe read). Solenoidal (∇·B = 0) is enforced each
  // step by the same Hodge projection that keeps the velocity incompressible.
  bx: Float32Array;
  by: Float32Array;
  bx0: Float32Array;
  by0: Float32Array;
  jz: Float32Array;
  // Dedicated scratch for the magnetic divergence-clean (so the velocity `p`/`div`
  // diagnostics — and the pressure render mode — survive an MHD step intact).
  private mp: Float32Array;
  private mdiv: Float32Array;

  // Solver scratch shared between the pressure & diffusion solves.
  p: Float32Array;
  div: Float32Array;
  curl: Float32Array;

  // Extra scratch for MacCormack advection (forward + back-traced estimates).
  private sA: Float32Array;
  private sB: Float32Array;

  // Conjugate-Gradient scratch: residual, preconditioned residual, search
  // direction, and A·d. Allocated once and reused every projection.
  private cgR: Float32Array;
  private cgZ: Float32Array;
  private cgD: Float32Array;
  private cgQ: Float32Array;

  // Obstacle mask. solid[i] !== 0 means the cell is a wall.
  solid: Uint8Array;

  // Domain-edge conditions. Default is a fully closed box (reflective walls),
  // identical to the original behaviour; a scene can open an edge to outflow so
  // the wake leaves the domain (a true channel) instead of recirculating. Open
  // boundaries are supported on the SOR projection (`project`), which the open
  // scenes select.
  boundaries: Boundaries = { ...CLOSED_BOX };
  private anyOpen = false;

  // Geometric-multigrid hierarchy, built lazily the first time the `'mg'` or
  // `'mgcg'` solver is used (so the SOR/CG paths pay nothing for it).
  private mg: Multigrid | null = null;

  constructor(N: number) {
    this.N = N;
    this.size = (N + 2) * (N + 2);
    const z = () => new Float32Array(this.size);
    this.u = z();
    this.v = z();
    this.u0 = z();
    this.v0 = z();
    this.r = z();
    this.g = z();
    this.b = z();
    this.r0 = z();
    this.g0 = z();
    this.b0 = z();
    this.t = z();
    this.t0 = z();
    this.fuel = z();
    this.fuel0 = z();
    this.bx = z();
    this.by = z();
    this.bx0 = z();
    this.by0 = z();
    this.jz = z();
    this.mp = z();
    this.mdiv = z();
    this.p = z();
    this.div = z();
    this.curl = z();
    this.sA = z();
    this.sB = z();
    this.cgR = z();
    this.cgZ = z();
    this.cgD = z();
    this.cgQ = z();
    this.solid = new Uint8Array(this.size);
  }

  /** Flat index for grid coordinate (i, j). */
  IX(i: number, j: number): number {
    return i + (this.N + 2) * j;
  }

  clearDye(): void {
    this.r.fill(0);
    this.g.fill(0);
    this.b.fill(0);
  }

  clearVelocity(): void {
    this.u.fill(0);
    this.v.fill(0);
  }

  clearSolids(): void {
    this.solid.fill(0);
  }

  clearTemperature(value = 0): void {
    this.t.fill(value);
  }

  clearFuel(): void {
    this.fuel.fill(0);
  }

  clearMagnetic(): void {
    this.bx.fill(0);
    this.by.fill(0);
    this.jz.fill(0);
  }

  reset(): void {
    this.clearDye();
    this.clearVelocity();
    this.clearSolids();
    this.clearTemperature();
    this.clearFuel();
    this.clearMagnetic();
    this.boundaries = { ...CLOSED_BOX };
    this.anyOpen = false;
  }

  /** Set the domain-edge conditions (e.g. open the right edge to outflow). */
  setBoundaries(b: Partial<Boundaries>): void {
    this.boundaries = { ...this.boundaries, ...b };
    this.anyOpen =
      this.boundaries.left !== 'wall' ||
      this.boundaries.right !== 'wall' ||
      this.boundaries.top !== 'wall' ||
      this.boundaries.bottom !== 'wall';
  }

  /** Deposit dye + impulse at grid cell (i, j) within a soft radius. */
  splat(
    i: number,
    j: number,
    du: number,
    dv: number,
    color: [number, number, number],
    radius: number,
    amount: number,
  ): void {
    const N = this.N;
    const rad = Math.max(1, radius);
    const r2 = rad * rad;
    const lo = -Math.ceil(rad);
    const hi = Math.ceil(rad);
    for (let dj = lo; dj <= hi; dj++) {
      for (let di = lo; di <= hi; di++) {
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        const ci = i + di;
        const cj = j + dj;
        if (ci < 1 || ci > N || cj < 1 || cj > N) continue;
        const idx = this.IX(ci, cj);
        if (this.solid[idx]) continue;
        // Gaussian-ish falloff for a soft brush.
        const falloff = Math.exp(-d2 / (0.5 * r2 + 1e-6));
        this.u[idx] += du * falloff;
        this.v[idx] += dv * falloff;
        const a = amount * falloff;
        this.r[idx] += color[0] * a;
        this.g[idx] += color[1] * a;
        this.b[idx] += color[2] * a;
      }
    }
  }

  /** Deposit heat (a temperature increment) into a soft disc — drives buoyancy. */
  splatHeat(i: number, j: number, amount: number, radius: number): void {
    const N = this.N;
    const rad = Math.max(1, radius);
    const r2 = rad * rad;
    const lo = -Math.ceil(rad);
    const hi = Math.ceil(rad);
    for (let dj = lo; dj <= hi; dj++) {
      for (let di = lo; di <= hi; di++) {
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        const ci = i + di;
        const cj = j + dj;
        if (ci < 1 || ci > N || cj < 1 || cj > N) continue;
        const idx = this.IX(ci, cj);
        if (this.solid[idx]) continue;
        this.t[idx] += amount * Math.exp(-d2 / (0.5 * r2 + 1e-6));
      }
    }
  }

  /** Deposit fuel into a soft disc — feeds the combustion model. */
  splatFuel(i: number, j: number, amount: number, radius: number): void {
    const N = this.N;
    const rad = Math.max(1, radius);
    const r2 = rad * rad;
    const lo = -Math.ceil(rad);
    const hi = Math.ceil(rad);
    for (let dj = lo; dj <= hi; dj++) {
      for (let di = lo; di <= hi; di++) {
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        const ci = i + di;
        const cj = j + dj;
        if (ci < 1 || ci > N || cj < 1 || cj > N) continue;
        const idx = this.IX(ci, cj);
        if (this.solid[idx]) continue;
        this.fuel[idx] += amount * Math.exp(-d2 / (0.5 * r2 + 1e-6));
      }
    }
  }

  /** Mark / unmark a disc of solid cells. */
  paintSolid(i: number, j: number, radius: number, solid: boolean): void {
    const N = this.N;
    const rad = Math.max(0, radius);
    const r2 = rad * rad;
    const lo = -Math.ceil(rad);
    const hi = Math.ceil(rad);
    for (let dj = lo; dj <= hi; dj++) {
      for (let di = lo; di <= hi; di++) {
        if (di * di + dj * dj > r2) continue;
        const ci = i + di;
        const cj = j + dj;
        if (ci < 1 || ci > N || cj < 1 || cj > N) continue;
        const idx = this.IX(ci, cj);
        this.solid[idx] = solid ? 1 : 0;
        if (solid) {
          this.u[idx] = 0;
          this.v[idx] = 0;
          this.r[idx] = 0;
          this.g[idx] = 0;
          this.b[idx] = 0;
          this.t[idx] = 0;
          this.fuel[idx] = 0;
          this.bx[idx] = 0;
          this.by[idx] = 0;
        }
      }
    }
  }

  /** Paint a magnetic-field vector (bx, by) into a soft disc — the `mag` brush. */
  splatB(i: number, j: number, dbx: number, dby: number, radius: number): void {
    const N = this.N;
    const rad = Math.max(1, radius);
    const r2 = rad * rad;
    const lo = -Math.ceil(rad);
    const hi = Math.ceil(rad);
    for (let dj = lo; dj <= hi; dj++) {
      for (let di = lo; di <= hi; di++) {
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        const ci = i + di;
        const cj = j + dj;
        if (ci < 1 || ci > N || cj < 1 || cj > N) continue;
        const idx = this.IX(ci, cj);
        if (this.solid[idx]) continue;
        const falloff = Math.exp(-d2 / (0.5 * r2 + 1e-6));
        this.bx[idx] += dbx * falloff;
        this.by[idx] += dby * falloff;
      }
    }
  }

  // --- Core operators -------------------------------------------------------

  /** Apply boundary conditions to a field. */
  private setBnd(bnd: Boundary, x: Float32Array): void {
    const N = this.N;
    const IX = (i: number, j: number) => i + (N + 2) * j;
    const b = this.boundaries;

    if (!this.anyOpen) {
      // Closed box (the default fast path): reflect the normal velocity component
      // at every wall, copy everything else (Neumann). Pressure (bnd 3) ≡ scalar.
      for (let i = 1; i <= N; i++) {
        x[IX(0, i)] = bnd === 1 ? -x[IX(1, i)] : x[IX(1, i)];
        x[IX(N + 1, i)] = bnd === 1 ? -x[IX(N, i)] : x[IX(N, i)];
        x[IX(i, 0)] = bnd === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
        x[IX(i, N + 1)] = bnd === 2 ? -x[IX(i, N)] : x[IX(i, N)];
      }
    } else {
      // Open-aware ghosts. For a given edge with inward neighbour value `inner`:
      //  - velocity *normal* to the edge: −inner at a wall (no penetration),
      //    +inner at an open edge (zero-gradient, so flow can enter/leave);
      //  - pressure (bnd 3): −inner at an *outflow* edge (Dirichlet p = 0 at the
      //    face, which lets the box pass a net through-flow), +inner otherwise
      //    (Neumann at walls and inflow);
      //  - tangential velocity & passive scalars: +inner (Neumann) everywhere.
      const ghost = (axis: 1 | 2, side: Side, inner: number): number => {
        const kind = b[side];
        if (bnd === axis) return kind === 'wall' ? -inner : inner;
        if (bnd === 3) return kind === 'outflow' ? -inner : inner;
        return inner;
      };
      for (let i = 1; i <= N; i++) {
        x[IX(0, i)] = ghost(1, 'left', x[IX(1, i)]);
        x[IX(N + 1, i)] = ghost(1, 'right', x[IX(N, i)]);
        x[IX(i, 0)] = ghost(2, 'bottom', x[IX(i, 1)]);
        x[IX(i, N + 1)] = ghost(2, 'top', x[IX(i, N)]);
      }
    }
    // Corners average their two edge neighbours.
    x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
    x[IX(0, N + 1)] = 0.5 * (x[IX(1, N + 1)] + x[IX(0, N)]);
    x[IX(N + 1, 0)] = 0.5 * (x[IX(N, 0)] + x[IX(N + 1, 1)]);
    x[IX(N + 1, N + 1)] = 0.5 * (x[IX(N, N + 1)] + x[IX(N + 1, N)]);

    // Internal solid obstacles: enforce no-slip / no-penetration by reflecting
    // the relevant velocity component off the nearest fluid neighbour.
    const solid = this.solid;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        if (!solid[idx]) continue;
        if (bnd === 0) {
          // Scalar (pressure / dye): mirror an adjacent fluid value (Neumann).
          let sum = 0;
          let cnt = 0;
          if (!solid[IX(i - 1, j)]) { sum += x[IX(i - 1, j)]; cnt++; }
          if (!solid[IX(i + 1, j)]) { sum += x[IX(i + 1, j)]; cnt++; }
          if (!solid[IX(i, j - 1)]) { sum += x[IX(i, j - 1)]; cnt++; }
          if (!solid[IX(i, j + 1)]) { sum += x[IX(i, j + 1)]; cnt++; }
          x[idx] = cnt > 0 ? sum / cnt : 0;
        } else if (bnd === 1) {
          // x-velocity: oppose the horizontal fluid neighbour.
          const left = !solid[IX(i - 1, j)];
          const right = !solid[IX(i + 1, j)];
          if (left && !right) x[idx] = -x[IX(i - 1, j)];
          else if (right && !left) x[idx] = -x[IX(i + 1, j)];
          else x[idx] = 0;
        } else {
          // y-velocity: oppose the vertical fluid neighbour.
          const down = !solid[IX(i, j - 1)];
          const up = !solid[IX(i, j + 1)];
          if (down && !up) x[idx] = -x[IX(i, j - 1)];
          else if (up && !down) x[idx] = -x[IX(i, j + 1)];
          else x[idx] = 0;
        }
      }
    }
  }

  /**
   * Red-black Gauss–Seidel / SOR linear solver shared by diffusion and pressure
   * projection. With `omega = 1` this is Gauss–Seidel; with `omega ∈ (1, 2)` it
   * is successive over-relaxation, which accelerates convergence of this
   * (symmetric, diagonally dominant) Poisson system without moving its fixed
   * point. The 5-point Laplacian stencil is bipartite on the checkerboard
   * colouring `(i+j) mod 2`: every cell's four neighbours have the opposite
   * colour, so each colour can be swept independently of its own. That makes the
   * sweep order-independent within a colour — no left-to-right information bias —
   * which both parallelises cleanly and keeps a reflection-symmetric problem
   * symmetric (lexicographic Gauss–Seidel does not).
   */
  private linSolve(
    bnd: Boundary,
    x: Float32Array,
    x0: Float32Array,
    a: number,
    c: number,
    iters: number,
    omega = 1,
  ): void {
    const N = this.N;
    const invC = 1 / c;
    const solid = this.solid;
    const relax = omega !== 1;
    const IX = (i: number, j: number) => i + (N + 2) * j;
    for (let k = 0; k < iters; k++) {
      for (let color = 0; color < 2; color++) {
        for (let j = 1; j <= N; j++) {
          for (let i = 1; i <= N; i++) {
            if (((i + j) & 1) !== color) continue;
            const idx = IX(i, j);
            if (solid[idx]) continue;
            // For solid neighbours, substitute this cell's own value, which
            // enforces a zero-gradient (Neumann) condition at the wall.
            const xl = solid[idx - 1] ? x[idx] : x[idx - 1];
            const xr = solid[idx + 1] ? x[idx] : x[idx + 1];
            const xd = solid[idx - (N + 2)] ? x[idx] : x[idx - (N + 2)];
            const xu = solid[idx + (N + 2)] ? x[idx] : x[idx + (N + 2)];
            const gs = (x0[idx] + a * (xl + xr + xd + xu)) * invC;
            x[idx] = relax ? x[idx] + omega * (gs - x[idx]) : gs;
          }
        }
        this.setBnd(bnd, x);
      }
    }
  }

  private diffuse(
    bnd: Boundary,
    x: Float32Array,
    x0: Float32Array,
    diff: number,
    dt: number,
    iters: number,
    omega = 1,
  ): void {
    const a = dt * diff * this.N * this.N;
    if (a === 0) {
      x.set(x0);
      this.setBnd(bnd, x);
      return;
    }
    this.linSolve(bnd, x, x0, a, 1 + 4 * a, iters, omega);
  }

  /** Semi-Lagrangian advection: trace each cell backwards and sample. */
  private advect(
    bnd: Boundary,
    d: Float32Array,
    d0: Float32Array,
    u: Float32Array,
    v: Float32Array,
    dt: number,
  ): void {
    const N = this.N;
    const dt0 = dt * N;
    const solid = this.solid;
    const IX = (i: number, j: number) => i + (N + 2) * j;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        if (solid[idx]) {
          d[idx] = 0;
          continue;
        }
        let x = i - dt0 * u[idx];
        let y = j - dt0 * v[idx];
        if (x < 0.5) x = 0.5;
        if (x > N + 0.5) x = N + 0.5;
        if (y < 0.5) y = 0.5;
        if (y > N + 0.5) y = N + 0.5;
        const i0 = Math.floor(x);
        const i1 = i0 + 1;
        const j0 = Math.floor(y);
        const j1 = j0 + 1;
        const s1 = x - i0;
        const s0 = 1 - s1;
        const t1 = y - j0;
        const t0 = 1 - t1;
        d[idx] =
          s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) +
          s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
      }
    }
    this.setBnd(bnd, d);
  }

  /**
   * MacCormack advection: second-order accurate, much less dissipative than
   * plain semi-Lagrangian. We advect forward, advect that result backward, and
   * correct by half the round-trip error — then clamp to the source stencil's
   * min/max so the correction can't overshoot into ringing/negative dye.
   */
  private advectMacCormack(
    bnd: Boundary,
    d: Float32Array,
    d0: Float32Array,
    u: Float32Array,
    v: Float32Array,
    dt: number,
  ): void {
    const N = this.N;
    const fwd = this.sA; // φ̂ⁿ⁺¹ = A(φⁿ)
    const bak = this.sB; // φ̂ⁿ   = A⁻¹(φ̂ⁿ⁺¹)
    this.advect(bnd, fwd, d0, u, v, dt);
    this.advect(bnd, bak, fwd, u, v, -dt);

    const dt0 = dt * N;
    const solid = this.solid;
    const IX = (i: number, j: number) => i + (N + 2) * j;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        if (solid[idx]) {
          d[idx] = 0;
          continue;
        }
        // Re-trace the forward characteristic to find the source stencil.
        let x = i - dt0 * u[idx];
        let y = j - dt0 * v[idx];
        if (x < 0.5) x = 0.5;
        if (x > N + 0.5) x = N + 0.5;
        if (y < 0.5) y = 0.5;
        if (y > N + 0.5) y = N + 0.5;
        const i0 = Math.floor(x);
        const j0 = Math.floor(y);
        const c00 = d0[IX(i0, j0)];
        const c10 = d0[IX(i0 + 1, j0)];
        const c01 = d0[IX(i0, j0 + 1)];
        const c11 = d0[IX(i0 + 1, j0 + 1)];
        const lo = Math.min(c00, c10, c01, c11);
        const hi = Math.max(c00, c10, c01, c11);

        let val = fwd[idx] + 0.5 * (d0[idx] - bak[idx]);
        if (val < lo) val = lo; // clamp prevents the corrector from overshooting
        else if (val > hi) val = hi;
        d[idx] = val;
      }
    }
    this.setBnd(bnd, d);
  }

  /** Hodge projection: remove divergence so the field stays incompressible. */
  private project(u: Float32Array, v: Float32Array, p: Float32Array, div: Float32Array, iters: number, omega = 1): void {
    const N = this.N;
    const solid = this.solid;
    const IX = (i: number, j: number) => i + (N + 2) * j;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        if (solid[idx]) {
          div[idx] = 0;
          p[idx] = 0;
          continue;
        }
        div[idx] = -0.5 * (u[idx + 1] - u[idx - 1] + v[idx + (N + 2)] - v[idx - (N + 2)]) / N;
        p[idx] = 0;
      }
    }
    // Pressure boundary code: 3 (open-aware: Dirichlet at outflow) when any edge is
    // open, else 0 (pure Neumann) — identical to the original closed-box solve.
    const pb: Boundary = this.anyOpen ? 3 : 0;
    this.setBnd(0, div);
    this.setBnd(pb, p);
    this.linSolve(pb, p, div, 1, 4, iters, omega);

    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        if (solid[idx]) continue;
        const pl = solid[idx - 1] ? p[idx] : p[idx - 1];
        const pr = solid[idx + 1] ? p[idx] : p[idx + 1];
        const pd = solid[idx - (N + 2)] ? p[idx] : p[idx - (N + 2)];
        const pu = solid[idx + (N + 2)] ? p[idx] : p[idx + (N + 2)];
        u[idx] -= 0.5 * N * (pr - pl);
        v[idx] -= 0.5 * N * (pu - pd);
      }
    }
    this.setBnd(1, u);
    this.setBnd(2, v);
  }

  /**
   * Matrix-free application of the pressure Poisson operator A to a field x, over
   * the fluid interior. A is the 5-point graph Laplacian with homogeneous Neumann
   * conditions at domain walls *and* internal solid faces: a neighbour counts only
   * if it is in-domain and fluid, otherwise its contribution vanishes (zero normal
   * gradient). This is the *exact* operator the red-black SOR relaxes, so CG and
   * SOR converge to the same solution. A is symmetric positive-semidefinite (its
   * null space is the constants), which is what makes Conjugate Gradients valid.
   */
  private applyPoisson(x: Float32Array, out: Float32Array): void {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (solid[idx]) {
          out[idx] = 0;
          continue;
        }
        let acc = 0;
        if (i > 1 && !solid[idx - 1]) acc += x[idx] - x[idx - 1];
        if (i < N && !solid[idx + 1]) acc += x[idx] - x[idx + 1];
        if (j > 1 && !solid[idx - S]) acc += x[idx] - x[idx - S];
        if (j < N && !solid[idx + S]) acc += x[idx] - x[idx + S];
        out[idx] = acc;
      }
    }
  }

  /** Diagonal of A at (i, j): the count of valid (in-domain, fluid) neighbours. */
  private poissonDiag(i: number, j: number): number {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    const idx = i + S * j;
    let d = 0;
    if (i > 1 && !solid[idx - 1]) d++;
    if (i < N && !solid[idx + 1]) d++;
    if (j > 1 && !solid[idx - S]) d++;
    if (j < N && !solid[idx + S]) d++;
    return d > 0 ? d : 1;
  }

  /**
   * Hodge projection via Jacobi-preconditioned Conjugate Gradients. Solves the
   * same Poisson system as `project`, but with a Krylov method that converges the
   * residual far faster per iteration. The right-hand side (the divergence) is
   * shifted to be mean-zero first, which is the compatibility condition for the
   * singular pure-Neumann system — without it the constant null-space component
   * would make CG stall. Only the pressure *gradient* is used to correct the
   * velocity, so the arbitrary additive constant is irrelevant.
   */
  private projectCG(
    u: Float32Array,
    v: Float32Array,
    p: Float32Array,
    div: Float32Array,
    maxIters: number,
    tol = 1e-7,
  ): void {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    const r = this.cgR;
    const z = this.cgZ;
    const d = this.cgD;
    const q = this.cgQ;

    // Build the divergence RHS and zero the pressure guess.
    let mean = 0;
    let cells = 0;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (solid[idx]) {
          div[idx] = 0;
          p[idx] = 0;
          continue;
        }
        div[idx] = -0.5 * (u[idx + 1] - u[idx - 1] + v[idx + S] - v[idx - S]) / N;
        p[idx] = 0;
        mean += div[idx];
        cells++;
      }
    }
    if (cells === 0) return;
    // Neumann compatibility: shift the RHS to be mean-zero, in place, so the
    // singular constant mode can't make CG stall (and so `div` stores the actual
    // system the solve drives to zero — only the pressure gradient is used, which
    // a uniform shift leaves untouched).
    const m = mean / cells;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (!solid[idx]) div[idx] -= m;
      }

    // r = b − A·p = b (since p ≡ 0); z = M⁻¹r; d = z; rz = ⟨r, z⟩.
    let rz = 0;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        const ri = div[idx];
        r[idx] = ri;
        const zi = ri / this.poissonDiag(i, j);
        z[idx] = zi;
        d[idx] = zi;
        rz += ri * zi;
      }
    }
    let bestInf = Infinity;

    for (let k = 0; k < maxIters; k++) {
      if (!Number.isFinite(rz) || rz <= 0) break;
      this.applyPoisson(d, q);
      let dq = 0;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (!solid[idx]) dq += d[idx] * q[idx];
        }
      if (dq <= 1e-30) break;
      const alpha = rz / dq;
      let rInf = 0;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (solid[idx]) continue;
          p[idx] += alpha * d[idx];
          const ri = (r[idx] -= alpha * q[idx]);
          const a = ri < 0 ? -ri : ri;
          if (a > rInf) rInf = a;
        }
      if (rInf < tol) break;
      // Divergence guard: in finite precision, iterating far past convergence can
      // make ⟨d, Ad⟩ collapse and the residual blow up. Stop if it does.
      if (rInf < bestInf) bestInf = rInf;
      else if (rInf > 4 * bestInf) break;
      let rzNew = 0;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (solid[idx]) continue;
          const zi = r[idx] / this.poissonDiag(i, j);
          z[idx] = zi;
          rzNew += r[idx] * zi;
        }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (!solid[idx]) d[idx] = z[idx] + beta * d[idx];
        }
    }

    // Fill ghost pressures (Neumann), then subtract ∇p — identical to `project`.
    this.subtractPressureGradient(u, v, p);
  }

  /**
   * Build the divergence right-hand side b = −½ ∇·u / N over the fluid interior
   * (zeroing solids), exactly as `project`/`projectCG` do, into `div`, and zero
   * the pressure guess. Shared by the multigrid projections.
   */
  private buildDivergence(u: Float32Array, v: Float32Array, p: Float32Array, div: Float32Array): void {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (solid[idx]) {
          div[idx] = 0;
          p[idx] = 0;
          continue;
        }
        div[idx] = -0.5 * (u[idx + 1] - u[idx - 1] + v[idx + S] - v[idx - S]) / N;
        p[idx] = 0;
      }
    }
  }

  /**
   * Fill the ghost pressures (homogeneous Neumann) and subtract the pressure
   * gradient from the velocity — the second half of every Hodge projection,
   * identical across SOR / CG / multigrid (a solid neighbour contributes this
   * cell's own pressure, i.e. zero normal gradient at the wall).
   */
  private subtractPressureGradient(u: Float32Array, v: Float32Array, p: Float32Array): void {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    this.setBnd(0, p);
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        const pl = solid[idx - 1] ? p[idx] : p[idx - 1];
        const pr = solid[idx + 1] ? p[idx] : p[idx + 1];
        const pd = solid[idx - S] ? p[idx] : p[idx - S];
        const pu = solid[idx + S] ? p[idx] : p[idx + S];
        u[idx] -= 0.5 * N * (pr - pl);
        v[idx] -= 0.5 * N * (pu - pd);
      }
    }
    this.setBnd(1, u);
    this.setBnd(2, v);
  }

  private ensureMultigrid(): Multigrid {
    if (!this.mg) this.mg = new Multigrid(this.N);
    return this.mg;
  }

  /**
   * Hodge projection via geometric **multigrid** V-cycles. Multigrid solves the
   * pressure Poisson equation in work proportional to the number of cells (O(N)),
   * with a convergence rate per V-cycle that does not degrade as the grid is
   * refined — because smooth pressure error, which stalls a stationary relaxation
   * (or even CG), is resolved cheaply on a coarse grid where it looks oscillatory.
   * Best on open domains; with intricate obstacles prefer `'mgcg'`, which wraps
   * the same V-cycle in CG for robustness.
   */
  private projectMG(
    u: Float32Array,
    v: Float32Array,
    p: Float32Array,
    div: Float32Array,
    vcycles: number,
    nu1 = 2,
    nu2 = 2,
  ): void {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    const mg = this.ensureMultigrid();
    mg.setSolid(solid);
    this.buildDivergence(u, v, p, div);
    // Neumann compatibility: shift the RHS mean-zero in place (so `div` stores the
    // exact system the solve drives to zero — keeping the pressure diagnostic and
    // the verify suite honest — and only ∇p is used, which a uniform shift leaves
    // untouched). `mg.solve`'s own re-zeroing is then a no-op.
    let mean = 0;
    let cells = 0;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (!solid[idx]) {
          mean += div[idx];
          cells++;
        }
      }
    if (cells === 0) return;
    mean /= cells;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (!solid[idx]) div[idx] -= mean;
      }
    const L0 = mg.levels[0];
    L0.b.set(div);
    mg.solve(Math.max(1, vcycles), nu1, nu2, 1);
    // Copy the multigrid solution into the solver's pressure field.
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        p[idx] = this.solid[idx] ? 0 : L0.x[idx];
      }
    this.subtractPressureGradient(u, v, p);
  }

  /**
   * Hodge projection via **multigrid-preconditioned Conjugate Gradients**. CG over
   * the exact same Poisson operator as `projectCG`, but with a single symmetric
   * multigrid V-cycle replacing the Jacobi diagonal as the preconditioner. The
   * V-cycle is a near-perfect (grid-independent) approximate inverse, so CG reaches
   * machine-level residual in a handful of iterations whose count does not grow
   * with resolution — and, being CG, it stays robust where a bare V-cycle would
   * stumble (intricate embedded boundaries). This is the best of both solvers.
   */
  private projectMGCG(
    u: Float32Array,
    v: Float32Array,
    p: Float32Array,
    div: Float32Array,
    maxIters: number,
    tol = 1e-7,
  ): void {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    const mg = this.ensureMultigrid();
    mg.setSolid(solid);
    const L0 = mg.levels[0];

    this.buildDivergence(u, v, p, div);
    // Neumann compatibility: shift the RHS mean-zero (only ∇p is used downstream).
    let mean = 0;
    let cells = 0;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (!solid[idx]) {
          mean += div[idx];
          cells++;
        }
      }
    if (cells === 0) return;
    mean /= cells;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (!solid[idx]) div[idx] -= mean;
      }

    const r = this.cgR;
    const z = this.cgZ;
    const d = this.cgD;
    const q = this.cgQ;
    // r = b − A·p = b (p ≡ 0); z = M⁻¹r via one V-cycle; d = z; rz = ⟨r, z⟩.
    r.set(div);
    mg.precondition(r, z);
    d.set(z);
    let rz = 0;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (!solid[idx]) rz += r[idx] * z[idx];
      }

    for (let k = 0; k < maxIters; k++) {
      if (!Number.isFinite(rz) || rz === 0) break;
      mg.applyA(L0, d, q);
      let dq = 0;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (!solid[idx]) dq += d[idx] * q[idx];
        }
      if (dq <= 1e-30) break;
      const alpha = rz / dq;
      let rInf = 0;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (solid[idx]) continue;
          p[idx] += alpha * d[idx];
          const ri = (r[idx] -= alpha * q[idx]);
          const a = ri < 0 ? -ri : ri;
          if (a > rInf) rInf = a;
        }
      if (rInf < tol) break;
      mg.precondition(r, z);
      let rzNew = 0;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (!solid[idx]) rzNew += r[idx] * z[idx];
        }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = i + S * j;
          if (!solid[idx]) d[idx] = z[idx] + beta * d[idx];
        }
    }

    this.subtractPressureGradient(u, v, p);
  }

  /**
   * Reactive flow (combustion). Fuel is carried by the velocity field like any
   * scalar; wherever it is hotter than the ignition temperature it burns at a
   * first-order rate (Arrhenius-lite: rate scales with how far past ignition the
   * cell is), releasing heat into the temperature field and depositing flame +
   * soot dye. Conserves fuel exactly when `rate = 0` (advection only).
   */
  private combust(dt: number, ignition: number, rate: number, heatRelease: number): void {
    const N = this.N;
    const S = N + 2;
    const solid = this.solid;
    // Advect the fuel field through the flow.
    this.fuel0.set(this.fuel);
    this.advect(0, this.fuel, this.fuel0, this.u, this.v, dt);
    if (rate <= 0) return;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = i + S * j;
        if (solid[idx]) continue;
        const f = this.fuel[idx];
        if (f <= 1e-5) continue;
        const over = this.t[idx] - ignition;
        if (over <= 0) continue;
        // Fraction burned this step (bounded to [0, 1]); hotter ⇒ faster.
        const frac = 1 - Math.exp(-rate * (1 + over) * dt);
        const burn = f * frac;
        this.fuel[idx] = f - burn;
        this.t[idx] += heatRelease * burn;
        // Flame is bright and warm; the soot it leaves cools into smoke as the
        // dye advects and fades. Scaled so a vigorous flame reads at exposure 1.
        this.r[idx] += burn * 5.0;
        this.g[idx] += burn * 2.2;
        this.b[idx] += burn * 0.5;
      }
    }
  }

  /** Vorticity confinement: re-inject small-scale swirl lost to advection. */
  private vorticityConfinement(strength: number, dt: number): void {
    if (strength <= 0) return;
    const N = this.N;
    const u = this.u;
    const v = this.v;
    const curl = this.curl;
    const solid = this.solid;
    const IX = (i: number, j: number) => i + (N + 2) * j;

    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        if (solid[idx]) {
          curl[idx] = 0;
          continue;
        }
        // ω = ∂v/∂x − ∂u/∂y
        curl[idx] = 0.5 * (v[idx + 1] - v[idx - 1] - (u[idx + (N + 2)] - u[idx - (N + 2)]));
      }
    }

    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = IX(i, j);
        if (solid[idx]) continue;
        // Gradient of |ω| points toward higher vorticity.
        const dx = 0.5 * (Math.abs(curl[idx + 1]) - Math.abs(curl[idx - 1]));
        const dy = 0.5 * (Math.abs(curl[idx + (N + 2)]) - Math.abs(curl[idx - (N + 2)]));
        const len = Math.hypot(dx, dy) + 1e-5;
        const nx = dx / len;
        const ny = dy / len;
        const w = curl[idx];
        // Force = strength * (N × ω): push fluid back into the vortex core.
        u[idx] += strength * dt * ny * w;
        v[idx] += strength * dt * -nx * w;
      }
    }
  }

  // --- Magnetohydrodynamics -------------------------------------------------
  //
  // Incompressible 2-D MHD (in Alfvén units, ρ = μ₀ = 1) couples the flow to an
  // in-plane magnetic field B = (bx, by):
  //
  //   ∂ₜu + (u·∇)u = −∇P* + ν∇²u + (B·∇)B,            ∇·u = 0
  //   ∂ₜB + (u·∇)B = (B·∇)u + η∇²B,                   ∇·B = 0
  //
  // where P* = p + ½|B|² folds the magnetic pressure into the kinematic pressure.
  // The whole thing reuses the existing machinery: the Lorentz force is just a
  // body force on the velocity (its gradient part is removed by the *velocity*
  // projection, exactly reproducing (∇×B)×B = (B·∇)B − ∇(½|B|²)); the induction
  // equation is a semi-Lagrangian advection of B by u, an explicit field-line
  // **stretching** term (B·∇)u, optional Ohmic diffusion, and a final Hodge
  // projection of B that enforces ∇·B = 0 — the very same solver that keeps u
  // incompressible, now cleaning the magnetic field. No new linear algebra.

  /** Physical x-derivative ∂ₓf at (i,j) on the unit domain (cell size 1/N). */
  private dfdx(f: Float32Array, idx: number): number {
    return 0.5 * this.N * (f[idx + 1] - f[idx - 1]);
  }

  /** Physical y-derivative ∂_yf at (i,j) on the unit domain (cell size 1/N). */
  private dfdy(f: Float32Array, idx: number): number {
    return 0.5 * this.N * (f[idx + (this.N + 2)] - f[idx - (this.N + 2)]);
  }

  /**
   * Add the magnetic tension force (B·∇)B to the velocity over `dt`. The magnetic
   * *pressure* ∇(½|B|²) that completes the true Lorentz force (∇×B)×B is left out
   * on purpose: the velocity's Hodge projection (run right after) removes every
   * curl-free body force, so adding only the tension and projecting is identical to
   * adding the full Lorentz force and projecting — the two differ by a pure
   * gradient, which projection annihilates. One fewer field to differentiate, and
   * exact by construction.
   */
  private lorentzForce(dt: number): void {
    const N = this.N;
    const solid = this.solid;
    const bx = this.bx;
    const by = this.by;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = this.IX(i, j);
        if (solid[idx]) continue;
        const bxi = bx[idx];
        const byi = by[idx];
        // (B·∇)B = (bx ∂ₓbx + by ∂_ybx, bx ∂ₓby + by ∂_yby).
        const fx = bxi * this.dfdx(bx, idx) + byi * this.dfdy(bx, idx);
        const fy = bxi * this.dfdx(by, idx) + byi * this.dfdy(by, idx);
        this.u[idx] += dt * fx;
        this.v[idx] += dt * fy;
      }
    }
    this.setBnd(1, this.u);
    this.setBnd(2, this.v);
  }

  /**
   * Advance the magnetic field one step by the induction equation. Splitting:
   *  1. advect B by the (already incompressible) velocity — the −(u·∇)B term;
   *  2. add the explicit field-line **stretching** term (B·∇)u, which is what
   *     amplifies B when the flow stretches a field line and is the engine of the
   *     dynamo / flux-freezing;
   *  3. optional **Ohmic diffusion** η∇²B (implicit, on the shared red-black
   *     stencil — unconditionally stable for any η);
   *  4. a Hodge **projection of B** to restore ∇·B = 0 (numerical truncation in
   *     steps 1–2 injects a little monopole charge; this cleans it every step).
   * B obeys the same reflective wall ghosts as the velocity (codes 1 and 2).
   */
  private induction(dt: number, resistivity: number, iters: number, omega: number): void {
    const N = this.N;
    const solid = this.solid;
    // 1. Advect each magnetic component through the flow (treat like velocity).
    // MacCormack (2nd-order, clamped) keeps the field's numerical resistivity low —
    // so ideal MHD stays close to flux-frozen and current sheets stay thin.
    this.bx0.set(this.bx);
    this.by0.set(this.by);
    this.advectMacCormack(1, this.bx, this.bx0, this.u, this.v, dt);
    this.advectMacCormack(2, this.by, this.by0, this.u, this.v, dt);

    // 2. Stretching (B·∇)u. Read both B components first so the x-update can't feed
    // the y-update (the increments depend only on the velocity gradient).
    const bx = this.bx;
    const by = this.by;
    const u = this.u;
    const v = this.v;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = this.IX(i, j);
        if (solid[idx]) continue;
        const bxi = bx[idx];
        const byi = by[idx];
        const sbx = bxi * this.dfdx(u, idx) + byi * this.dfdy(u, idx);
        const sby = bxi * this.dfdx(v, idx) + byi * this.dfdy(v, idx);
        bx[idx] = bxi + dt * sbx;
        by[idx] = byi + dt * sby;
      }
    }
    this.setBnd(1, bx);
    this.setBnd(2, by);

    // 3. Ohmic (resistive) diffusion of B, implicit and stable for any η.
    if (resistivity > 0) {
      this.bx0.set(bx);
      this.diffuse(1, bx, this.bx0, resistivity, dt, iters, omega);
      this.by0.set(by);
      this.diffuse(2, by, this.by0, resistivity, dt, iters, omega);
    }

    // 4. Project B divergence-free with the *same* Hodge solver as the velocity,
    // into dedicated scratch so the velocity pressure diagnostic is untouched.
    this.project(bx, by, this.mp, this.mdiv, iters, omega);
  }

  /**
   * Restore ∇·B = 0 by one Hodge projection of the magnetic field (the cleaning
   * step of `induction`, exposed for the verification suite). Uses the dedicated
   * magnetic-pressure scratch so the velocity pressure field is left intact.
   */
  cleanMagneticDivergence(iters: number, omega = 1): void {
    this.project(this.bx, this.by, this.mp, this.mdiv, iters, omega);
  }

  /**
   * Public hook over the private induction step (advect B → stretch → Ohmic
   * diffuse → clean ∇·B), for the verification suite to exercise the magnetic
   * transport in isolation against the current velocity field.
   */
  inductionStep(dt: number, resistivity: number, iters: number, omega = 1): void {
    this.induction(dt, resistivity, iters, omega);
  }

  /** Recompute the out-of-plane current density jz = ∂ₓB_y − ∂_yB_x. */
  computeCurrent(): void {
    const N = this.N;
    const solid = this.solid;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = this.IX(i, j);
        if (solid[idx]) {
          this.jz[idx] = 0;
          continue;
        }
        this.jz[idx] = this.dfdx(this.by, idx) - this.dfdy(this.bx, idx);
      }
    }
  }

  /** Current density jz at interior cell (i, j) — used by the renderer/probe. */
  currentAt(i: number, j: number): number {
    const idx = this.IX(i, j);
    return this.dfdx(this.by, idx) - this.dfdy(this.bx, idx);
  }

  // --- Public step ----------------------------------------------------------

  /**
   * Advance the simulation by `dt`. For plain hydrodynamics this is a single core
   * step. For **MHD** the explicit magnetic terms (the Lorentz force and field-line
   * stretching) are forward-integrated, so they carry an **Alfvén-CFL limit**
   * v_A·dt·N ≲ 1 — a fast field on a fine grid at the live frame `dt` would
   * otherwise blow up. We measure the peak Alfvén speed (max|B|) and sub-cycle the
   * core step just enough to keep that number small, so the studio stays stable no
   * matter how hard the field is driven. Pure-fluid scenes pay nothing (one step).
   */
  step(dt: number, params: FluidParams): void {
    let nsub = 1;
    if (params.mhd === true) {
      const N = this.N;
      let bmax = 1e-6;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = this.IX(i, j);
          if (this.solid[idx]) continue;
          const m = this.bx[idx] * this.bx[idx] + this.by[idx] * this.by[idx];
          if (m > bmax) bmax = m;
        }
      // Alfvén CFL = v_A·dt·N with v_A = √bmax; keep the per-substep value ≲ 0.4.
      // The generous cap keeps even a fast field under a low-framerate stall stable.
      const cfl = Math.sqrt(bmax) * dt * N;
      nsub = Math.max(1, Math.min(32, Math.ceil(cfl / 0.4)));
    }
    const sub = dt / nsub;
    for (let k = 0; k < nsub; k++) this.stepCore(sub, params);
  }

  private stepCore(dt: number, params: FluidParams): void {
    const { viscosity, velocityDissipation, dyeDissipation, vorticity, iterations, gravity } = params;
    const omega = params.overRelax ?? 1;
    const { buoyancy, thermalDiffusion, cooling, ambient } = params;
    const combustion = params.combustion ?? 0;
    const smokeBuoyancy = params.smokeBuoyancy ?? 0;
    const solver = params.pressureSolver ?? 'sor';
    // The temperature field must be transported whenever anything reads or writes
    // it — buoyancy, diffusion, cooling, or the exothermic combustion reaction.
    const transportHeat = buoyancy !== 0 || thermalDiffusion > 0 || cooling > 0 || combustion > 0;
    const N = this.N;
    const IX = (i: number, j: number) => i + (N + 2) * j;

    // Body forces on the velocity.
    if (gravity !== 0 || buoyancy !== 0 || smokeBuoyancy !== 0) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          const idx = IX(i, j);
          if (this.solid[idx]) continue;
          const mass = this.r[idx] + this.g[idx] + this.b[idx];
          if (gravity !== 0) {
            // Dye-mass body force (legacy "smoke has weight" model).
            this.v[idx] += gravity * dt * mass;
          }
          if (smokeBuoyancy !== 0) {
            // Variable-density (non-Boussinesq) buoyancy: lift ∝ local smoke mass.
            this.v[idx] -= smokeBuoyancy * dt * mass;
          }
          if (buoyancy !== 0) {
            // Boussinesq buoyancy: hotter-than-ambient fluid rises (−y).
            this.v[idx] -= buoyancy * dt * (this.t[idx] - ambient);
          }
        }
      }
    }

    // --- Lorentz force (MHD) --- the magnetic field pushes back on the flow. Added
    // as a body force *before* the velocity projection so the projection removes the
    // magnetic pressure ∇(½|B|²) for free, leaving the divergence-free tension.
    const mhd = params.mhd === true;
    if (mhd) this.lorentzForce(dt);

    this.vorticityConfinement(vorticity, dt);

    // --- Velocity step ---
    // Diffuse (viscosity), project, advect, project.
    this.u0.set(this.u);
    this.v0.set(this.v);
    if (viscosity > 0) {
      this.diffuse(1, this.u, this.u0, viscosity, dt, iterations, omega);
      this.diffuse(2, this.v, this.v0, viscosity, dt, iterations, omega);
      this.projectWith(solver, iterations, omega);
      this.u0.set(this.u);
      this.v0.set(this.v);
    }
    this.advect(1, this.u, this.u0, this.u0, this.v0, dt);
    this.advect(2, this.v, this.v0, this.u0, this.v0, dt);
    this.projectWith(solver, iterations, omega);

    // Velocity damping.
    if (velocityDissipation > 0) {
      const decay = Math.max(0, 1 - velocityDissipation * dt * 6);
      for (let k = 0; k < this.size; k++) {
        this.u[k] *= decay;
        this.v[k] *= decay;
      }
    }

    // --- Induction step (MHD) --- advance B with the now-incompressible velocity:
    // advect, stretch, Ohmic-diffuse, and re-clean ∇·B = 0. Refresh the current jz.
    if (mhd) {
      this.induction(dt, params.resistivity ?? 0, iterations, omega);
      this.computeCurrent();
    }

    // --- Temperature step --- advect, diffuse, and Newton-cool the T field.
    if (transportHeat) {
      this.t0.set(this.t);
      this.advect(0, this.t, this.t0, this.u, this.v, dt);
      if (thermalDiffusion > 0) {
        this.t0.set(this.t);
        this.diffuse(0, this.t, this.t0, thermalDiffusion, dt, iterations, omega);
      }
      if (cooling > 0) {
        const k = Math.max(0, 1 - cooling * dt);
        for (let idx = 0; idx < this.size; idx++) {
          this.t[idx] = ambient + (this.t[idx] - ambient) * k;
        }
      }
    }

    // --- Combustion step --- advect fuel, then burn it where it's hot enough,
    // releasing heat into the (already-transported) temperature field above.
    if (combustion > 0) {
      this.combust(dt, params.ignition ?? 0.5, combustion, params.heatRelease ?? 2.5);
    }

    // --- Dye step --- advect each colour channel through the velocity field.
    this.r0.set(this.r);
    this.g0.set(this.g);
    this.b0.set(this.b);
    const advectDye = params.sharpDye
      ? (b: Boundary, d: Float32Array, d0: Float32Array) => this.advectMacCormack(b, d, d0, this.u, this.v, dt)
      : (b: Boundary, d: Float32Array, d0: Float32Array) => this.advect(b, d, d0, this.u, this.v, dt);
    advectDye(0, this.r, this.r0);
    advectDye(0, this.g, this.g0);
    advectDye(0, this.b, this.b0);

    // Scalar (molecular) diffusion of the dye — the Schmidt-number physics. Solved
    // implicitly on the same red-black stencil as heat/viscosity, so it is stable
    // for any κ_s and conserves total dye under insulating walls.
    const dyeDiffusion = params.dyeDiffusion ?? 0;
    if (dyeDiffusion > 0) {
      this.r0.set(this.r);
      this.diffuse(0, this.r, this.r0, dyeDiffusion, dt, iterations, omega);
      this.g0.set(this.g);
      this.diffuse(0, this.g, this.g0, dyeDiffusion, dt, iterations, omega);
      this.b0.set(this.b);
      this.diffuse(0, this.b, this.b0, dyeDiffusion, dt, iterations, omega);
    }

    if (dyeDissipation > 0) {
      const decay = Math.max(0, 1 - dyeDissipation * dt);
      for (let k = 0; k < this.size; k++) {
        this.r[k] *= decay;
        this.g[k] *= decay;
        this.b[k] *= decay;
      }
    }
  }

  // --- Diagnostics ----------------------------------------------------------

  /** Speed (velocity magnitude) at a cell — used by the renderer. */
  speedAt(idx: number): number {
    return Math.hypot(this.u[idx], this.v[idx]);
  }

  /** Curl (vorticity) at interior cell (i, j). */
  curlAt(i: number, j: number): number {
    const N = this.N;
    const idx = this.IX(i, j);
    return 0.5 * (this.v[idx + 1] - this.v[idx - 1] - (this.u[idx + (N + 2)] - this.u[idx - (N + 2)]));
  }

  /**
   * The Hunt **Q-criterion** at interior cell (i, j): Q = ½(‖Ω‖² − ‖S‖²), where Ω
   * and S are the antisymmetric (rotation) and symmetric (strain) parts of the
   * velocity gradient. Q > 0 marks regions where rotation dominates strain — the
   * standard objective definition of a *vortex core*, which a raw vorticity field
   * confuses with mere shear. Computed in grid units from central differences.
   */
  qCriterion(i: number, j: number): number {
    const N = this.N;
    const S = N + 2;
    const idx = this.IX(i, j);
    const ux = 0.5 * (this.u[idx + 1] - this.u[idx - 1]);
    const uy = 0.5 * (this.u[idx + S] - this.u[idx - S]);
    const vx = 0.5 * (this.v[idx + 1] - this.v[idx - 1]);
    const vy = 0.5 * (this.v[idx + S] - this.v[idx - S]);
    const omegaSq = 0.5 * (uy - vx) * (uy - vx); // ‖Ω‖_F²
    const strainSq = ux * ux + vy * vy + 0.5 * (uy + vx) * (uy + vx); // ‖S‖_F²
    return 0.5 * (omegaSq - strainSq);
  }

  /** Dispatch the projection to the chosen Poisson solver. */
  private projectWith(solver: 'sor' | 'cg' | 'mg' | 'mgcg', iters: number, omega: number): void {
    switch (solver) {
      case 'cg':
        this.projectCG(this.u, this.v, this.p, this.div, iters);
        break;
      case 'mg':
        // A few V-cycles match the SOR/CG sweep budget in cost but converge the
        // smooth pressure error far further; clamp to a sensible band.
        this.projectMG(this.u, this.v, this.p, this.div, Math.max(2, Math.min(10, Math.round(iters / 6))));
        break;
      case 'mgcg':
        this.projectMGCG(this.u, this.v, this.p, this.div, Math.max(4, Math.min(24, Math.round(iters / 2))));
        break;
      default:
        this.project(this.u, this.v, this.p, this.div, iters, omega);
    }
  }

  /**
   * Run one Hodge projection on the current velocity field, in place. A public
   * hook over the private `project` so the verification suite can exercise the
   * incompressibility solve in isolation.
   */
  projectVelocity(iters: number, omega = 1): void {
    this.project(this.u, this.v, this.p, this.div, iters, omega);
  }

  /**
   * Public hook over the private CG projection, for the verification suite — lets
   * it compare CG's convergence and result against red-black SOR directly.
   */
  projectVelocityCG(iters: number, tol = 1e-7): void {
    this.projectCG(this.u, this.v, this.p, this.div, iters, tol);
  }

  /**
   * Public hook over the private multigrid projection, for the verification suite
   * — `vcycles` V-cycles of geometric multigrid on the current velocity field.
   */
  projectVelocityMG(vcycles: number, nu1 = 2, nu2 = 2): void {
    this.projectMG(this.u, this.v, this.p, this.div, vcycles, nu1, nu2);
  }

  /** Public hook over the private multigrid-preconditioned CG projection. */
  projectVelocityMGCG(maxIters: number, tol = 1e-7): void {
    this.projectMGCG(this.u, this.v, this.p, this.div, maxIters, tol);
  }

  /** Bilinearly sample a field at fractional grid coordinate (x, y). */
  sampleField(f: Float32Array, x: number, y: number): number {
    const N = this.N;
    if (x < 0.5) x = 0.5;
    else if (x > N + 0.5) x = N + 0.5;
    if (y < 0.5) y = 0.5;
    else if (y > N + 0.5) y = N + 0.5;
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const s1 = x - i0;
    const s0 = 1 - s1;
    const t1 = y - j0;
    const t0 = 1 - t1;
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    return (
      s0 * (t0 * f[this.IX(i0, j0)] + t1 * f[this.IX(i0, j1)]) +
      s1 * (t0 * f[this.IX(i1, j0)] + t1 * f[this.IX(i1, j1)])
    );
  }

  /** Bilinearly sample the velocity field — used by tracers & streamlines. */
  sampleVelocity(x: number, y: number, out: { u: number; v: number }): void {
    out.u = this.sampleField(this.u, x, y);
    out.v = this.sampleField(this.v, x, y);
  }

  /** Is the fractional position inside (or on) a solid cell? */
  isSolidAt(x: number, y: number): boolean {
    const N = this.N;
    const i = Math.round(x);
    const j = Math.round(y);
    if (i < 1 || i > N || j < 1 || j > N) return false;
    return this.solid[this.IX(i, j)] !== 0;
  }

  /**
   * Global diagnostics, computed over the fluid (non-solid) interior:
   *  - kineticEnergy: mean ½|u|²,
   *  - enstrophy: mean ½ω² (a measure of swirl / small-scale activity),
   *  - maxDivergence: peak |∇·u| (how incompressible the field actually is),
   *  - meanTemp: mean temperature.
   * These are what the verification suite and the live readout watch.
   */
  diagnostics(): { kineticEnergy: number; enstrophy: number; maxDivergence: number; meanTemp: number; cells: number } {
    const N = this.N;
    const u = this.u;
    const v = this.v;
    let ke = 0;
    let ens = 0;
    let maxDiv = 0;
    let tSum = 0;
    let cells = 0;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = this.IX(i, j);
        if (this.solid[idx]) continue;
        ke += u[idx] * u[idx] + v[idx] * v[idx];
        const w = 0.5 * (v[idx + 1] - v[idx - 1] - (u[idx + (N + 2)] - u[idx - (N + 2)]));
        ens += w * w;
        const div = Math.abs(-0.5 * (u[idx + 1] - u[idx - 1] + v[idx + (N + 2)] - v[idx - (N + 2)]) / N);
        if (div > maxDiv) maxDiv = div;
        tSum += this.t[idx];
        cells++;
      }
    }
    const inv = cells > 0 ? 1 / cells : 0;
    return {
      kineticEnergy: 0.5 * ke * inv,
      enstrophy: 0.5 * ens * inv,
      maxDivergence: maxDiv,
      meanTemp: tSum * inv,
      cells,
    };
  }

  /**
   * MHD diagnostics over the fluid interior:
   *  - magneticEnergy: mean ½|B|² (the Alfvénic energy reservoir),
   *  - maxDivB: peak |∇·B| (how solenoidal the field actually is — should stay
   *    tiny, the magnetic analogue of `maxDivergence`),
   *  - crossHelicity: mean u·B (an ideal-MHD invariant, conserved when ν = η = 0),
   *  - totalEnergy: mean ½(|u|² + |B|²) (conserved in ideal MHD up to dissipation).
   */
  magneticDiagnostics(): {
    magneticEnergy: number;
    maxDivB: number;
    crossHelicity: number;
    totalEnergy: number;
    cells: number;
  } {
    const N = this.N;
    const S = N + 2;
    const u = this.u;
    const v = this.v;
    const bx = this.bx;
    const by = this.by;
    let me = 0;
    let ke = 0;
    let cross = 0;
    let maxDivB = 0;
    let cells = 0;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const idx = this.IX(i, j);
        if (this.solid[idx]) continue;
        me += bx[idx] * bx[idx] + by[idx] * by[idx];
        ke += u[idx] * u[idx] + v[idx] * v[idx];
        cross += u[idx] * bx[idx] + v[idx] * by[idx];
        const divB = Math.abs(-0.5 * (bx[idx + 1] - bx[idx - 1] + by[idx + S] - by[idx - S]) / N);
        if (divB > maxDivB) maxDivB = divB;
        cells++;
      }
    }
    const inv = cells > 0 ? 1 / cells : 0;
    return {
      magneticEnergy: 0.5 * me * inv,
      maxDivB,
      crossHelicity: cross * inv,
      totalEnergy: 0.5 * (ke + me) * inv,
      cells,
    };
  }
}
