// Relativistic emission-line profile from a thin Keplerian disk around a Kerr black hole.
//
// This is the classic "double-horned, red-skewed" line shape (the shape X-ray astronomers fit to
// the broad iron Kα line to *measure* black-hole spin). For every patch of the disk we compute the
// combined frequency-shift factor g = ν_obs / ν_emit from three exact ingredients evaluated on the
// equatorial Kerr metric — the gravitational/time-dilation lapse, the transverse + longitudinal
// Doppler from the orbital velocity in the local ZAMO frame, and the frame-dragging that tilts that
// frame — then histogram the boosted line flux (∝ g³, emissivity ∝ r⁻³) by g. Light bending is the
// one effect left out, which is what keeps this cheap enough to recompute live on the CPU.

import { M, chargeQ2 } from '../state'

export interface LineProfile {
  /** Normalised flux per bin (peak = 1). */
  flux: Float32Array
  /** g value at the centre of each bin. */
  g: Float32Array
  gMin: number
  gMax: number
}

/**
 * @param spin  dimensionless a/M ∈ [0, 1)
 * @param incDeg inclination between the line of sight and the disk plane, in degrees
 *               (0 = face-on … 90 = edge-on). We convert to the usual "from the normal" angle.
 * @param rIn   inner disk radius (rs units)
 * @param rOut  outer disk radius (rs units)
 * @param bins  number of g-bins
 * @param charge dimensionless charge Q/M ∈ [0, 1) — a Kerr–Newman disk (0 = uncharged Kerr)
 */
export function computeLineProfile(spin: number, incDeg: number, rIn: number, rOut: number, bins = 96, charge = 0): LineProfile {
  const a = Math.min(Math.max(spin, 0), 0.9995) * M
  const q2 = chargeQ2(charge)
  // The renderer's "inclination" is elevation above the disk plane; the disk-normal angle used by
  // the Doppler projection is its complement. Edge-on (elevation→0) gives the strongest shifts.
  const iNormal = (90 - Math.abs(incDeg)) * (Math.PI / 180)
  const sinI = Math.sin(iNormal)

  const flux = new Float32Array(bins)
  const gMin = 0.35
  const gMax = 1.45
  const inv = bins / (gMax - gMin)

  const nR = 140
  const nPhi = 260
  const lo = Math.max(rIn, 0.2)
  const hi = Math.max(rOut, lo + 0.5)

  for (let ir = 0; ir < nR; ir++) {
    // log-spaced radii concentrate resolution where emissivity (∝ r⁻³) dominates
    const fr = (ir + 0.5) / nR
    const r = lo * Math.pow(hi / lo, fr)
    const dr = r * Math.log(hi / lo) / nR

    // equatorial Kerr–Newman metric (θ = π/2): the mass function 2Mr becomes 2Mr − Q², Δ gains +Q²
    const r2 = r * r
    const Delta = r2 - 2 * M * r + a * a + q2
    const MR = 2 * M * r - q2
    const gtp = -MR * a / r2
    const gpp = r2 + a * a + MR * a * a / r2
    const A = (r2 + a * a) * (r2 + a * a) - a * a * Delta // = A at sinθ=1
    if (Delta <= 0 || A <= 0) continue

    const lapse = Math.sqrt((Delta * r2) / A) // α
    const omega = -gtp / gpp // ZAMO frame-dragging angular velocity
    const rootMr = Math.sqrt(Math.max(M * r - q2, 0))
    const Omega = rootMr / (r2 + a * rootMr) // prograde Kerr–Newman orbital Ω
    let v = ((Omega - omega) * Math.sqrt(gpp)) / lapse // physical orbital speed in the ZAMO frame
    v = Math.min(Math.max(v, 0), 0.9995)
    const gamma = 1 / Math.sqrt(1 - v * v)

    const emis = Math.pow(r, -3) * dr * r // emissivity ∝ r⁻³, area weight r·dr·dφ (dφ folded below)

    for (let ip = 0; ip < nPhi; ip++) {
      const phi = (ip + 0.5) * (2 * Math.PI / nPhi)
      // line-of-sight component of the orbital velocity; φ measured so cos φ is the approaching node
      const los = v * sinI * Math.cos(phi)
      const doppler = 1 / (gamma * (1 - los)) // special-relativistic Doppler in the ZAMO frame
      const g = lapse * doppler // total observed/emitted frequency ratio
      const boosted = emis * Math.pow(g, 3) // specific-intensity boost for a line
      const bin = Math.floor((g - gMin) * inv)
      if (bin >= 0 && bin < bins) flux[bin] += boosted
    }
  }

  // normalise
  let peak = 0
  for (let i = 0; i < bins; i++) peak = Math.max(peak, flux[i])
  if (peak > 0) for (let i = 0; i < bins; i++) flux[i] /= peak

  const g = new Float32Array(bins)
  for (let i = 0; i < bins; i++) g[i] = gMin + (i + 0.5) / inv
  return { flux, g, gMin, gMax }
}
