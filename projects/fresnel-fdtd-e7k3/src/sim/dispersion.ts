/**
 * Frequency-dispersive materials for the FDTD solver via the
 * Auxiliary-Differential-Equation (ADE) method.
 *
 * A non-dispersive Yee cell has a fixed relative permittivity `εr`. Real metals
 * and resonant dielectrics have a permittivity that depends on frequency, which
 * is what makes a mirror reflective at optical frequencies, gives a prism its
 * colour, and lets a metal surface carry a *surface plasmon polariton*. FDTD
 * cannot store `ε(ω)` directly — the field lives in the time domain — so we add
 * an auxiliary *polarization current* `J` per dispersive cell and advance it
 * with its own difference equation in lock-step with the Yee update. This is the
 * exact technique production photonics codes (Meep, Lumerical) use.
 *
 * Two pole models are supported, both special cases of a Lorentzian:
 *
 *   Drude    ε(ω) = ε∞ − ωp² / (ω² + iγω)
 *   Lorentz  ε(ω) = ε∞ + Δε·ω0² / (ω0² − ω² + iγω)
 *
 * ── Units ──────────────────────────────────────────────────────────────────
 * The host solver uses Schneider's normalized formulation: dx = 1, c = 1, so
 * one timestep is `dt = Sc` (the Courant number) and ε0 = 1/η0, μ0 = η0. All
 * angular frequencies here are therefore in *radians per normalized time unit*:
 * a wave of wavelength λ cells has ω = 2π/λ. So a "plasma wavelength" of λp
 * cells means ωp = 2π/λp — an intuitive knob (below λp the metal is reflective).
 */

/** Free-space impedance used by the host normalization (must match FDTD.ts). */
const IMP0 = 377;

export type DispersionModel =
  | { kind: 'drude'; wp: number; gamma: number }
  | { kind: 'lorentz'; wp: number; gamma: number; w0: number; deltaEps: number };

/**
 * Precomputed per-material ADE update coefficients, specialized for the host's
 * timestep `Sc` and a given ε∞. Reduces exactly to the non-dispersive update as
 * ωp → 0 (a sanity check baked into the derivation and the verification lab).
 */
export interface DispEntry {
  model: DispersionModel;
  epsInf: number;
  /** Ez update: ez' = eA·ez + eB·curl − eC·J   (Drude)  */
  eA: number;
  eB: number;
  eC: number;
  /** J update: J' = jA·J + jB·(ez' + ez)   (Drude) */
  jA: number;
  jB: number;
  /** Lorentz polarization recursion: P' = pA·P + pB·Pprev + pC·ez, then
   *  ez' = ez + eB·curl − eB_over_dt·(P' − P). Reuses eB as the curl coeff. */
  lorentz: boolean;
  pA: number;
  pB: number;
  pC: number;
  /** (1/(ε0·ε∞)) — converts a polarization increment to a field decrement. */
  invEps0EpsInf: number;
}

/**
 * Build the ADE coefficients for a dispersion model at Courant number `Sc`.
 *
 * Drude (semi-implicit, trapezoidal — unconditionally stable):
 *   dJ/dt + γJ = ε0 ωp² E, discretized centered at n+½ with J,E co-located:
 *     J^{n+1} = jA·J^n + jB·(E^{n+1}+E^n),
 *       jA = (1 − γΔt/2)/(1 + γΔt/2),  jB = (ε0 ωp² Δt/2)/(1 + γΔt/2).
 *   Ampère ε0ε∞ ∂E/∂t = ∇×H − J, centered at n+½ and back-substituting J^{n+1}:
 *     E^{n+1} = eA·E^n + eB·(∇×H) − eC·J^n,
 *       D = ε0ε∞/Δt + jB/2,  eA = (ε0ε∞/Δt − jB/2)/D,
 *       eB = 1/D,  eC = ((jA+1)/2)/D.
 *
 * Lorentz (explicit 2nd-order ADE on the polarization P, J = dP/dt):
 *   d²P/dt² + γ dP/dt + ω0² P = ε0 Δε ω0² E, central differences →
 *     P^{n+1} = pA·P^n + pB·P^{n−1} + pC·E^n,
 *       den = 1 + γΔt/2,  pA = (2 − ω0²Δt²)/den,
 *       pB = (γΔt/2 − 1)/den,  pC = (ε0 Δε ω0² Δt²)/den.
 *   Ampère with ∂P/∂t: E^{n+1} = E^n + eB·(∇×H) − (P^{n+1}−P^n)/(ε0ε∞).
 */
export function buildDispEntry(model: DispersionModel, epsInf: number, Sc: number): DispEntry {
  const dt = Sc;
  const eps0 = 1 / IMP0;
  const G = (eps0 * epsInf) / dt; // ε0·ε∞/Δt
  const invEps0EpsInf = 1 / (eps0 * epsInf);

  if (model.kind === 'drude') {
    const { wp, gamma } = model;
    const den = 1 + (gamma * dt) / 2;
    const jA = (1 - (gamma * dt) / 2) / den;
    const jB = (eps0 * wp * wp * dt) / 2 / den;
    const D = G + jB / 2;
    const eA = (G - jB / 2) / D;
    const eB = 1 / D;
    const eC = ((jA + 1) / 2) / D;
    return {
      model,
      epsInf,
      eA,
      eB,
      eC,
      jA,
      jB,
      lorentz: false,
      pA: 0,
      pB: 0,
      pC: 0,
      invEps0EpsInf,
    };
  }

  // Lorentz
  const { w0, gamma, deltaEps } = model;
  const den = 1 + (gamma * dt) / 2;
  const pA = (2 - w0 * w0 * dt * dt) / den;
  const pB = ((gamma * dt) / 2 - 1) / den;
  const pC = (eps0 * deltaEps * w0 * w0 * dt * dt) / den;
  return {
    model,
    epsInf,
    eA: 1,
    eB: 1 / G, // = Δt/(ε0ε∞) — same curl coefficient as the non-dispersive cell
    eC: 0,
    jA: 0,
    jB: 0,
    lorentz: true,
    pA,
    pB,
    pC,
    invEps0EpsInf,
  };
}

/** A complex number as a 2-tuple [re, im]. */
export type Complex = [number, number];

/**
 * Analytic complex relative permittivity ε(ω) of a dispersion model, for the
 * verification lab and UI readouts. ω is in radians per normalized time unit.
 */
export function epsilonOfOmega(model: DispersionModel, epsInf: number, omega: number): Complex {
  if (model.kind === 'drude') {
    const { wp, gamma } = model;
    // ε = ε∞ − ωp²/(ω² + iγω) = ε∞ − ωp²(ω² − iγω)/(ω²+γ²ω²)... rationalize:
    // denominator ω² + iγω → multiply by conjugate (ω² − iγω)? careful: the pole
    // is (ω² + iγω) in the standard sign convention e^{−iωt}. Rationalize:
    const dr = omega * omega; // Re part of (ω² + iγω)
    const di = gamma * omega; // Im part
    const denom = dr * dr + di * di;
    if (denom === 0) return [epsInf - Infinity, 0];
    const re = epsInf - (wp * wp * dr) / denom;
    const im = (wp * wp * di) / denom;
    return [re, im];
  }
  // Lorentz: ε = ε∞ + Δε·ω0²/(ω0² − ω² + iγω)
  const { w0, gamma, deltaEps } = model;
  const dr = w0 * w0 - omega * omega;
  const di = gamma * omega;
  const denom = dr * dr + di * di;
  if (denom === 0) return [epsInf, 0];
  const num = deltaEps * w0 * w0;
  const re = epsInf + (num * dr) / denom;
  const im = (num * di) / denom;
  return [re, im];
}

/** Complex square root, principal branch (Im ≥ 0 for a passive medium). */
export function complexSqrt([a, b]: Complex): Complex {
  const r = Math.hypot(a, b);
  let re = Math.sqrt((r + a) / 2);
  let im = Math.sqrt((r - a) / 2);
  if (b < 0) im = -im;
  // Choose the branch with non-negative real part (physical refractive index).
  if (re < 0) {
    re = -re;
    im = -im;
  }
  return [re, im];
}

/**
 * Normal-incidence power reflectance |r|² of a half-space of complex index n
 * against vacuum: r = (1 − n)/(1 + n).
 */
export function fresnelReflectance(model: DispersionModel, epsInf: number, omega: number): number {
  const eps = epsilonOfOmega(model, epsInf, omega);
  const n = complexSqrt(eps);
  const num: Complex = [1 - n[0], -n[1]];
  const den: Complex = [1 + n[0], n[1]];
  const dm = den[0] * den[0] + den[1] * den[1];
  const rre = (num[0] * den[0] + num[1] * den[1]) / dm;
  const rim = (num[1] * den[0] - num[0] * den[1]) / dm;
  return rre * rre + rim * rim;
}
