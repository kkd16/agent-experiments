/**
 * Smoothed-particle-hydrodynamics smoothing kernels, in **2-D**.
 *
 * An SPH field A is reconstructed at a point from its neighbours as
 * `A(x) = Σ_j (m_j / ρ_j) A_j W(x − x_j, h)`, where `W` is a smooth, compactly
 * supported kernel that integrates to 1 over the plane. Position-Based Fluids
 * (Macklin & Müller 2013) uses two of them: the **poly6** kernel for the density
 * estimate (smooth, cheap, but with a vanishing gradient at the origin) and the
 * **spiky** kernel's gradient for the constraint forces (its gradient does *not*
 * vanish at the origin, which is exactly what keeps particles from clustering
 * into clumps under attractive pressure).
 *
 * The 2-D normalisation constants below are derived so that `∫ W dA = 1`:
 *   poly6 :  W(r,h) = 4/(π h⁸) (h² − r²)³            for 0 ≤ r ≤ h
 *   spiky :  W(r,h) = 10/(π h⁵) (h − r)³             for 0 ≤ r ≤ h
 * (the spiky form is given for completeness; PBF only needs its gradient).
 *
 * Every constant is checked in the verification suite — including a numerical
 * integral of poly6 over the disc, which confirms the `4/(π h⁸)` factor.
 */
import { Vec2 } from '../math';

/**
 * Precomputed kernel coefficients for a fixed smoothing length `h`. Computing
 * the `1/h^k` powers once per system (not per pair) keeps the hot neighbour loop
 * to a multiply and a couple of subtractions.
 */
export class Kernels {
  readonly h: number;
  readonly h2: number;
  /** poly6 value coefficient: 4/(π h⁸). */
  private readonly poly6: number;
  /** spiky value coefficient: 10/(π h⁵). */
  private readonly spiky: number;
  /** spiky gradient coefficient: 30/(π h⁵). */
  private readonly spikyGrad: number;

  constructor(h: number) {
    this.h = h;
    this.h2 = h * h;
    const h5 = h ** 5;
    this.poly6 = 4 / (Math.PI * h ** 8);
    this.spiky = 10 / (Math.PI * h5);
    this.spikyGrad = 30 / (Math.PI * h5);
  }

  /** poly6 density kernel evaluated at distance `r` (returns 0 outside support). */
  W(r: number): number {
    if (r >= this.h) return 0;
    const d = this.h2 - r * r;
    return this.poly6 * d * d * d;
  }

  /** poly6 from a squared distance — saves a `sqrt` in the density sum. */
  Wsq(r2: number): number {
    if (r2 >= this.h2) return 0;
    const d = this.h2 - r2;
    return this.poly6 * d * d * d;
  }

  /** spiky kernel value at distance `r` (used by the artificial-pressure term). */
  Wspiky(r: number): number {
    if (r >= this.h) return 0;
    const d = this.h - r;
    return this.spiky * d * d * d;
  }

  /**
   * Gradient (w.r.t. `p_i`) of the spiky kernel at displacement `rij = p_i − p_j`.
   * The kernel decreases with distance, so the gradient points *toward* the
   * neighbour `j` (i.e. along `−rij`), with magnitude `30/(π h⁵)(h−r)²` — vanishing
   * at `r = h` and, crucially, *non-zero* as `r → 0` (the property that stops
   * particle clustering). Returns the zero vector at the exact origin (no defined
   * direction) and outside the support.
   *
   * The sign matters: in the PBF position update `Δp_i ∝ Σ(λ_i+λ_j)∇W`, a
   * compressed pair (ρ > ρ₀ ⇒ λ < 0) must move *apart* — which only happens with
   * the true, inward-pointing gradient. Flipping it collapses the fluid.
   */
  gradSpiky(rij: Vec2): Vec2 {
    const r = rij.length();
    if (r >= this.h || r < 1e-12) return Vec2.ZERO;
    const d = this.h - r;
    const coeff = -(this.spikyGrad * d * d) / r;
    return rij.mul(coeff);
  }

  /**
   * The scalar `c` such that `∇W(rij) = c · rij` for a displacement of length `r`
   * (`r > 0`). The hot fluid loops call this and form the gradient components by
   * hand (`gx = c·dx`, `gy = c·dy`), avoiding a `Vec2` allocation per neighbour —
   * the difference between a smooth and a stuttering thousand-particle sim. Returns
   * 0 outside the support or at the origin.
   */
  gradCoeff(r: number): number {
    if (r >= this.h || r < 1e-12) return 0;
    const d = this.h - r;
    return -(this.spikyGrad * d * d) / r;
  }
}
