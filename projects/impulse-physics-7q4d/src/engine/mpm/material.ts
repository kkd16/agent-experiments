/**
 * Constitutive models for the Material Point Method — the stress laws and
 * plastic return-mappings that turn a particle's deformation gradient `F` into
 * the force it pushes onto the background grid. Four materials share one
 * interface so a single MLS-MPM transfer drives all of them:
 *
 * - **elastic**  — a fixed-corotated hyperelastic solid (jelly / rubber). The
 *   classic Stomakhin-style energy `ψ = μ‖F−R‖² + ½λ(J−1)²` whose first
 *   Piola–Kirchhoff stress is rotation-aware, so a spinning blob stores no
 *   phantom energy (the same defect co-rotational FEM fixes, here for MPM).
 * - **snow**     — elastoplastic snow (Stomakhin et al., SIGGRAPH 2013): the
 *   elastic part is fixed-corotated, hardened by the plastic compaction `Jp`,
 *   and the singular values are clamped to a brittle `[1−θc, 1+θs]` box so snow
 *   packs, cracks and crumbles.
 * - **sand**     — Drucker–Prager elastoplasticity (Klár et al., SIGGRAPH 2016):
 *   a Hencky (log-strain) elastic law with a return-mapping onto a friction
 *   cone, so a poured column collapses to its **angle of repose** and carries no
 *   tension. This is the granular headline.
 * - **fluid**    — a weakly-compressible liquid: shear memory is discarded each
 *   step (`F ← √J·I`) and only an equation-of-state volume pressure `λJ(J−1)`
 *   remains, the MPM cousin of the project's SPH water.
 *
 * Every model returns the term `P·Fᵀ` (a Kirchhoff-stress-like 2×2 matrix) that
 * the MLS-MPM particle-to-grid scatter multiplies by `−dt·V₀·(4/dx²)`. The two
 * plastic models also return the corrected elastic `F` and updated `Jp`, which
 * the solver writes back to the particle — that write-back *is* the plasticity.
 */
import { Mat2, svd2 } from './mat2';

/** Which constitutive law a particle obeys. */
export type MpmModel = 'elastic' | 'snow' | 'sand' | 'fluid';

/** A material: a constitutive model plus its physical parameters. */
export interface MpmMaterial {
  model: MpmModel;
  /** Young's modulus E (stiffness, Pa-like). */
  young: number;
  /** Poisson ratio ν (∈ (−1, 0.5)). */
  poisson: number;
  /** Mass density ρ₀ (drives particle mass = ρ₀·V₀). */
  density: number;
  /** Snow: plastic hardening coefficient ξ (0 = perfectly plastic, no hardening). */
  hardening: number;
  /** Snow: critical compression θc — singular values clamp at 1−θc. */
  criticalCompression: number;
  /** Snow: critical stretch θs — singular values clamp at 1+θs. */
  criticalStretch: number;
  /** Sand: internal friction angle in degrees (sets the angle of repose). */
  frictionAngle: number;
  /** Render tint. */
  color: string;
}

/** Lamé parameters (μ shear modulus, λ first parameter) derived from E and ν. */
export interface Lame {
  mu: number;
  lambda: number;
}

/** Convert Young's modulus / Poisson ratio to Lamé parameters. */
export function lame(young: number, poisson: number): Lame {
  const mu = young / (2 * (1 + poisson));
  const lambda = (young * poisson) / ((1 + poisson) * (1 - 2 * poisson));
  return { mu, lambda };
}

/** Sensible material presets, each a self-consistent parameter set. */
export const MATERIALS: Record<string, MpmMaterial> = {
  jelly: {
    model: 'elastic',
    young: 4.0e3,
    poisson: 0.32,
    density: 1.2,
    hardening: 0,
    criticalCompression: 0,
    criticalStretch: 0,
    frictionAngle: 0,
    color: '#7CFFCB',
  },
  rubber: {
    model: 'elastic',
    young: 1.4e4,
    poisson: 0.4,
    density: 1.4,
    hardening: 0,
    criticalCompression: 0,
    criticalStretch: 0,
    frictionAngle: 0,
    color: '#c792ea',
  },
  snow: {
    model: 'snow',
    young: 7.0e3,
    poisson: 0.2,
    density: 1.0,
    hardening: 10,
    criticalCompression: 0.025,
    criticalStretch: 0.0075,
    frictionAngle: 0,
    color: '#eaf2ff',
  },
  sand: {
    model: 'sand',
    young: 6.0e3,
    poisson: 0.3,
    density: 1.6,
    hardening: 0,
    criticalCompression: 0,
    criticalStretch: 0,
    frictionAngle: 38,
    color: '#e3b56b',
  },
  water: {
    model: 'fluid',
    young: 0,
    poisson: 0,
    density: 1.0,
    hardening: 0,
    criticalCompression: 0,
    criticalStretch: 0,
    // Bulk modulus for the equation of state (stored in `young` slot via stressFluid).
    frictionAngle: 0,
    color: '#5fb6ff',
  },
};

/** Build a material from a preset name, optionally overriding a few fields. */
export function material(name: keyof typeof MATERIALS, over: Partial<MpmMaterial> = {}): MpmMaterial {
  return { ...MATERIALS[name], ...over };
}

/**
 * Fixed-corotated `P·Fᵀ` (Kirchhoff stress) for the deformation gradient `F`.
 *
 *     P = 2μ(F − R) + λ(J−1)J·F⁻ᵀ
 *     P·Fᵀ = 2μ(F − R)·Fᵀ + λ·J(J−1)·I
 *
 * where `R = U·Vᵀ` is the polar rotation. Vanishes for a pure rotation
 * (`F = R`, `J = 1`) — the property the verifier checks.
 */
export function corotatedPF(F: Mat2, mu: number, lambda: number): Mat2 {
  const { u, s1, s2, v } = svd2(F);
  const R = u.mul(v.transpose());
  const J = s1 * s2;
  const shear = F.sub(R).mul(F.transpose()).scale(2 * mu);
  const vol = lambda * J * (J - 1);
  return new Mat2(shear.a + vol, shear.b, shear.c, shear.d + vol);
}

/** The result of a per-particle constitutive evaluation. */
export interface StressResult {
  /** `P·Fᵀ`, the term scattered to the grid. */
  pf: Mat2;
  /** The corrected elastic deformation gradient (after any plastic flow). */
  F: Mat2;
  /** The updated plastic compaction `Jp` (1 = no plasticity). */
  Jp: number;
}

/** Clamp helper local to this module (avoids importing the engine's). */
function clampNum(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Evaluate a material at a trial deformation gradient `F` (already advected by
 * `(I + dt·C)`), returning the grid stress `P·Fᵀ`, the corrected elastic `F`,
 * and the new `Jp`. Plastic models project `F` back onto their yield surface;
 * elastic and fluid models leave it (fluid discards shear).
 *
 * @param bulk equation-of-state bulk modulus for the fluid model.
 */
export function evaluate(F: Mat2, Jp: number, mat: MpmMaterial, bulk = 5e3): StressResult {
  switch (mat.model) {
    case 'elastic': {
      const { mu, lambda } = lame(mat.young, mat.poisson);
      return { pf: corotatedPF(F, mu, lambda), F, Jp };
    }
    case 'fluid': {
      // Weakly compressible: keep only volume. Reset to an isotropic stretch so
      // no shear memory accumulates (the standard MLS-MPM liquid treatment).
      const J = F.det();
      const Jc = Math.max(J, 0.05);
      const s = Math.sqrt(Jc);
      const Fe = Mat2.diag(s, s);
      const vol = bulk * Jc * (Jc - 1);
      return { pf: new Mat2(vol, 0, 0, vol), F: Fe, Jp };
    }
    case 'snow':
      return snow(F, Jp, mat);
    case 'sand':
      return sand(F, Jp, mat);
  }
}

/**
 * Stomakhin snow: hardened fixed-corotated elasticity with singular-value
 * clamping. Compaction past `1−θc` or stretch past `1+θs` is made *permanent*
 * (folded into `Jp`), and the remaining elastic moduli are scaled up by
 * `e^{ξ(1−Jp)}` so packed snow stiffens — the recipe behind cohesive snowballs
 * that still crumble.
 */
function snow(F: Mat2, Jp: number, mat: MpmMaterial): StressResult {
  const base = lame(mat.young, mat.poisson);
  const e = Math.exp(mat.hardening * (1 - Jp));
  const mu = base.mu * e;
  const lambda = base.lambda * e;

  const { u, s1, s2, v } = svd2(F);
  const lo = 1 - mat.criticalCompression;
  const hi = 1 + mat.criticalStretch;
  const c1 = clampNum(s1, lo, hi);
  const c2 = clampNum(s2, lo, hi);

  // Plastic determinant accumulates the volume the clamp removed.
  const JpNew = clampNum((Jp * (s1 * s2)) / (c1 * c2), 0.1, 20);
  const Fe = u.mul(Mat2.diag(c1, c2)).mul(v.transpose());

  const Re = u.mul(v.transpose());
  const Je = c1 * c2;
  const shear = Fe.sub(Re).mul(Fe.transpose()).scale(2 * mu);
  const vol = lambda * Je * (Je - 1);
  return { pf: new Mat2(shear.a + vol, shear.b, shear.c, shear.d + vol), F: Fe, Jp: JpNew };
}

/**
 * Drucker–Prager sand: a Hencky (log-strain) elastic law with a return-mapping
 * onto a friction cone. Working in the principal log-strains `ε = log Σ`, the
 * Kirchhoff stress is the diagonal `τ_i = 2μ·ε_i + λ·tr(ε)` rotated by `U`, so
 *
 *     P·Fᵀ = U · diag(2μ ε̃₀ + λ tr ε̃, 2μ ε̃₁ + λ tr ε̃) · Uᵀ
 *
 * with `ε̃` the strain *after* the return map. The cone half-angle is set by the
 * internal friction angle φ via `α = √(2/3)·2 sinφ/(3 − sinφ)`. Net stretch
 * (`tr ε > 0`) is projected to the cone tip — sand carries no tension — while
 * shear beyond the cone is scaled back onto it, the plastic flow that lets a
 * poured pile settle exactly at its angle of repose.
 */
function sand(F: Mat2, Jp: number, mat: MpmMaterial): StressResult {
  const { mu, lambda } = lame(mat.young, mat.poisson);
  const { u, s1, s2, v } = svd2(F);

  // Log-strains (guard tiny/negative singular values from the SVD sign carry).
  const a1 = Math.abs(s1) < 1e-8 ? 1e-8 : Math.abs(s1);
  const a2 = Math.abs(s2) < 1e-8 ? 1e-8 : Math.abs(s2);
  let eps0 = Math.log(a1);
  let eps1 = Math.log(a2);
  const trEps = eps0 + eps1;

  const dev0 = eps0 - trEps * 0.5;
  const dev1 = eps1 - trEps * 0.5;
  const devNorm = Math.hypot(dev0, dev1);

  const phi = (mat.frictionAngle * Math.PI) / 180;
  const sinp = Math.sin(phi);
  const alpha = Math.sqrt(2 / 3) * ((2 * sinp) / (3 - sinp));

  if (devNorm <= 1e-12 || trEps > 0) {
    // Hydrostatic, or net expansion: project to the cone tip (zero stress, all
    // strain becomes plastic). Cohesionless sand cannot pull.
    eps0 = 0;
    eps1 = 0;
  } else {
    // d = 2: coefficient (d·λ + 2μ)/(2μ) = (2λ + 2μ)/(2μ).
    const dgamma = devNorm + ((2 * lambda + 2 * mu) / (2 * mu)) * trEps * alpha;
    if (dgamma > 0) {
      // Plastic: slide the strain back along the deviatoric direction onto the cone.
      eps0 -= (dgamma * dev0) / devNorm;
      eps1 -= (dgamma * dev1) / devNorm;
    }
    // dgamma ≤ 0 ⇒ inside the cone ⇒ purely elastic, strains unchanged.
  }

  const se0 = Math.exp(eps0);
  const se1 = Math.exp(eps1);
  const Fe = u.mul(Mat2.diag(se0, se1)).mul(v.transpose());
  const JpNew = clampNum((Jp * (s1 * s2)) / (se0 * se1), 0.05, 20);

  const t0 = 2 * mu * eps0 + lambda * (eps0 + eps1);
  const t1 = 2 * mu * eps1 + lambda * (eps0 + eps1);
  const pf = u.mul(Mat2.diag(t0, t1)).mul(u.transpose());
  return { pf, F: Fe, Jp: JpNew };
}
