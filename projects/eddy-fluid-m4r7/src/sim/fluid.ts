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

export type Boundary = 0 | 1 | 2; // 0 = scalar, 1 = u (x-velocity), 2 = v (y-velocity)

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
}

export const DEFAULT_PARAMS: FluidParams = {
  viscosity: 0,
  velocityDissipation: 0.02,
  dyeDissipation: 0.12,
  sharpDye: true,
  vorticity: 6,
  iterations: 24,
  gravity: 0,
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

  // Solver scratch shared between the pressure & diffusion solves.
  p: Float32Array;
  div: Float32Array;
  curl: Float32Array;

  // Extra scratch for MacCormack advection (forward + back-traced estimates).
  private sA: Float32Array;
  private sB: Float32Array;

  // Obstacle mask. solid[i] !== 0 means the cell is a wall.
  solid: Uint8Array;

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
    this.p = z();
    this.div = z();
    this.curl = z();
    this.sA = z();
    this.sB = z();
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

  reset(): void {
    this.clearDye();
    this.clearVelocity();
    this.clearSolids();
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
        }
      }
    }
  }

  // --- Core operators -------------------------------------------------------

  /** Apply boundary conditions to a field. */
  private setBnd(bnd: Boundary, x: Float32Array): void {
    const N = this.N;
    const IX = (i: number, j: number) => i + (N + 2) * j;

    // Domain walls: reflect the normal velocity component, copy others.
    for (let i = 1; i <= N; i++) {
      x[IX(0, i)] = bnd === 1 ? -x[IX(1, i)] : x[IX(1, i)];
      x[IX(N + 1, i)] = bnd === 1 ? -x[IX(N, i)] : x[IX(N, i)];
      x[IX(i, 0)] = bnd === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
      x[IX(i, N + 1)] = bnd === 2 ? -x[IX(i, N)] : x[IX(i, N)];
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

  /** Gauss–Seidel linear solver shared by diffusion and pressure projection. */
  private linSolve(
    bnd: Boundary,
    x: Float32Array,
    x0: Float32Array,
    a: number,
    c: number,
    iters: number,
  ): void {
    const N = this.N;
    const invC = 1 / c;
    const solid = this.solid;
    const IX = (i: number, j: number) => i + (N + 2) * j;
    for (let k = 0; k < iters; k++) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          const idx = IX(i, j);
          if (solid[idx]) continue;
          // For solid neighbours, substitute this cell's own value, which
          // enforces a zero-gradient (Neumann) condition at the wall.
          const xl = solid[idx - 1] ? x[idx] : x[idx - 1];
          const xr = solid[idx + 1] ? x[idx] : x[idx + 1];
          const xd = solid[idx - (N + 2)] ? x[idx] : x[idx - (N + 2)];
          const xu = solid[idx + (N + 2)] ? x[idx] : x[idx + (N + 2)];
          x[idx] = (x0[idx] + a * (xl + xr + xd + xu)) * invC;
        }
      }
      this.setBnd(bnd, x);
    }
  }

  private diffuse(
    bnd: Boundary,
    x: Float32Array,
    x0: Float32Array,
    diff: number,
    dt: number,
    iters: number,
  ): void {
    const a = dt * diff * this.N * this.N;
    if (a === 0) {
      x.set(x0);
      this.setBnd(bnd, x);
      return;
    }
    this.linSolve(bnd, x, x0, a, 1 + 4 * a, iters);
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
  private project(u: Float32Array, v: Float32Array, p: Float32Array, div: Float32Array, iters: number): void {
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
    this.setBnd(0, div);
    this.setBnd(0, p);
    this.linSolve(0, p, div, 1, 4, iters);

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

  // --- Public step ----------------------------------------------------------

  step(dt: number, params: FluidParams): void {
    const { viscosity, velocityDissipation, dyeDissipation, vorticity, iterations, gravity } = params;
    const N = this.N;
    const IX = (i: number, j: number) => i + (N + 2) * j;

    // Gravity / buoyancy: dye-bearing cells feel a body force.
    if (gravity !== 0) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          const idx = IX(i, j);
          if (this.solid[idx]) continue;
          const mass = this.r[idx] + this.g[idx] + this.b[idx];
          this.v[idx] += gravity * dt * mass;
        }
      }
    }

    this.vorticityConfinement(vorticity, dt);

    // --- Velocity step ---
    // Diffuse (viscosity), project, advect, project.
    this.u0.set(this.u);
    this.v0.set(this.v);
    if (viscosity > 0) {
      this.diffuse(1, this.u, this.u0, viscosity, dt, iterations);
      this.diffuse(2, this.v, this.v0, viscosity, dt, iterations);
      this.project(this.u, this.v, this.p, this.div, iterations);
      this.u0.set(this.u);
      this.v0.set(this.v);
    }
    this.advect(1, this.u, this.u0, this.u0, this.v0, dt);
    this.advect(2, this.v, this.v0, this.u0, this.v0, dt);
    this.project(this.u, this.v, this.p, this.div, iterations);

    // Velocity damping.
    if (velocityDissipation > 0) {
      const decay = Math.max(0, 1 - velocityDissipation * dt * 6);
      for (let k = 0; k < this.size; k++) {
        this.u[k] *= decay;
        this.v[k] *= decay;
      }
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
}
