// ftle.ts — Finite-Time Lyapunov Exponents & Lagrangian Coherent Structures.
//
// A velocity field tells you where the fluid is going *now*; it does not tell you
// how a blob of dye will be pulled apart over the next second. That is a
// *Lagrangian* question, and its answer is the **flow map** φ_τ: the function that
// carries each point to where it lands after integrating the velocity for a time
// τ. Two initially-neighbouring tracers separate at a rate governed by the
// gradient of that map. The **finite-time Lyapunov exponent** (FTLE) measures the
// maximum such stretching:
//
//     σ(x) = √λ_max(C),   C = (∇φ_τ)ᵀ (∇φ_τ)   (the right Cauchy–Green tensor)
//     FTLE(x) = (1/|τ|) · ln σ(x)
//
// where λ_max is the larger eigenvalue of the 2×2 symmetric tensor C. Ridges
// (local maxima) of the FTLE field are **Lagrangian Coherent Structures** — the
// material curves that organise transport. Forward-time FTLE ridges are
// *repelling* manifolds (a watershed two parcels fall off either side of);
// backward-time ridges are *attracting* manifolds — exactly the filaments where
// dye and floating debris collect. They are the hidden skeleton of a flow, and
// you cannot see them from a single velocity snapshot.
//
// We integrate the flow map over a *frozen* velocity snapshot (the instantaneous
// FTLE), which is the standard real-time visualisation: each frame's structures
// are computed from that frame's field. The flow-map gradient is taken by central
// differences of neighbouring tracers' landing points, and λ_max comes from the
// closed-form eigenvalue of the symmetric 2×2 Cauchy–Green tensor.
//
// Velocity scale: the solver stores a normalised velocity (u ≈ 1 ⇒ one domain
// width per second), so a tracer's speed in *grid cells* per second is N·u — the
// same factor the semi-Lagrangian advection back-traces by (dt·N·u cells). We
// integrate the flow map in cell coordinates with that scaling, so the FTLE is a
// true per-second rate. The pure FTLE *value* is invariant to this scale (∇φ is a
// dimensionless ratio of displacements), which is what lets the closed-form
// verification checks pin it to an analytic strain rate.

export interface FtleOptions {
  /** Integration horizon in seconds (always integrated over |tau| substeps). */
  tau: number;
  /** Integrate backward in time (reveals *attracting* LCS — where dye collects). */
  backward: boolean;
  /** Number of RK4 substeps over the horizon. */
  steps: number;
}

/**
 * Computes the FTLE field of a frozen velocity field on demand, reusing its
 * scratch buffers between frames. The output is an N×N field in row-major
 * interior order (`out[j*N + i]` ↔ grid cell `(i+1, j+1)`), matching the
 * renderer's pixel layout.
 */
export class FtleComputer {
  N: number;
  // Flow-map landing coordinates (in grid-cell space) for each interior seed.
  private endX: Float32Array;
  private endY: Float32Array;
  /** The most recent FTLE field, interior row-major. */
  readonly field: Float32Array;

  constructor(N: number) {
    this.N = N;
    this.endX = new Float32Array(N * N);
    this.endY = new Float32Array(N * N);
    this.field = new Float32Array(N * N);
  }

  /** Bilinear velocity sample at fractional grid coord (x, y), clamped in-domain. */
  private sample(f: Float32Array, x: number, y: number): number {
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
    const S = N + 2;
    const i1 = i0 + 1;
    const j1 = j0 + 1;
    return (
      s0 * (t0 * f[i0 + S * j0] + t1 * f[i0 + S * j1]) +
      s1 * (t0 * f[i1 + S * j0] + t1 * f[i1 + S * j1])
    );
  }

  /**
   * Integrate the flow map and fill the FTLE field. `u`, `v` are the solver's
   * `(N+2)²` velocity arrays. `solid`, when given, marks an FTLE value of 0 at
   * wall cells (no material there).
   */
  compute(u: Float32Array, v: Float32Array, opts: FtleOptions, solid?: Uint8Array): Float32Array {
    const N = this.N;
    const steps = Math.max(1, Math.round(opts.steps));
    const dir = opts.backward ? -1 : 1;
    const h = (dir * opts.tau) / steps; // signed substep, seconds
    const endX = this.endX;
    const endY = this.endY;

    // RK4 flow map for every interior seed. Velocity in cell-space is N·sample.
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        let x = i;
        let y = j;
        for (let s = 0; s < steps; s++) {
          const k1x = N * this.sample(u, x, y);
          const k1y = N * this.sample(v, x, y);
          const k2x = N * this.sample(u, x + 0.5 * h * k1x, y + 0.5 * h * k1y);
          const k2y = N * this.sample(v, x + 0.5 * h * k1x, y + 0.5 * h * k1y);
          const k3x = N * this.sample(u, x + 0.5 * h * k2x, y + 0.5 * h * k2y);
          const k3y = N * this.sample(v, x + 0.5 * h * k2x, y + 0.5 * h * k2y);
          const k4x = N * this.sample(u, x + h * k3x, y + h * k3y);
          const k4y = N * this.sample(v, x + h * k3x, y + h * k3y);
          x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
          y += (h / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
          // Keep tracers in the domain (a no-penetration clamp at the walls).
          if (x < 1) x = 1;
          else if (x > N) x = N;
          if (y < 1) y = 1;
          else if (y > N) y = N;
        }
        endX[(j - 1) * N + (i - 1)] = x;
        endY[(j - 1) * N + (i - 1)] = y;
      }
    }

    // FTLE from the flow-map gradient (central differences over the seed grid).
    const out = this.field;
    const invTau = 1 / Math.abs(opts.tau);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        if (solid && solid[(i + 1) + (N + 2) * (j + 1)]) {
          out[idx] = 0;
          continue;
        }
        // One-sided differences at the edges, central in the interior.
        const il = i > 0 ? i - 1 : i;
        const ir = i < N - 1 ? i + 1 : i;
        const jd = j > 0 ? j - 1 : j;
        const ju = j < N - 1 ? j + 1 : j;
        const dxi = ir - il; // 2 in the interior, 1 at an edge
        const dyj = ju - jd;
        const F11 = (endX[j * N + ir] - endX[j * N + il]) / dxi;
        const F21 = (endY[j * N + ir] - endY[j * N + il]) / dxi;
        const F12 = (endX[ju * N + i] - endX[jd * N + i]) / dyj;
        const F22 = (endY[ju * N + i] - endY[jd * N + i]) / dyj;
        // Right Cauchy–Green tensor C = Fᵀ F (symmetric, positive-definite).
        const C11 = F11 * F11 + F21 * F21;
        const C12 = F11 * F12 + F21 * F22;
        const C22 = F12 * F12 + F22 * F22;
        // Larger eigenvalue of the symmetric 2×2 tensor, in closed form.
        const tr = 0.5 * (C11 + C22);
        const dd = 0.5 * (C11 - C22);
        const lambdaMax = tr + Math.sqrt(dd * dd + C12 * C12);
        // FTLE = (1/|τ|) ln √λ_max = (1/(2|τ|)) ln λ_max.
        out[idx] = lambdaMax > 1e-12 ? 0.5 * invTau * Math.log(lambdaMax) : 0;
      }
    }
    return out;
  }
}

/**
 * One-shot convenience wrapper (allocates) — used by the verification suite. For
 * per-frame rendering use a persistent {@link FtleComputer}.
 */
export function computeFTLE(
  u: Float32Array,
  v: Float32Array,
  N: number,
  opts: FtleOptions,
  solid?: Uint8Array,
): Float32Array {
  return new FtleComputer(N).compute(u, v, opts, solid);
}
