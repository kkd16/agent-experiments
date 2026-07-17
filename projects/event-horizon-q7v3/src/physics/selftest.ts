// The verification suite. Event Horizon's whole premise is that the picture is *computed*, not
// faked — so this suite proves the computation, the way its sibling labs do: closed-form GR results
// reproduced to tolerance, conserved quantities held constant along real integrated geodesics, and
// the analytic shadow curve cross-checked against an independent capture test and against the
// renderer's own equatorial integrator. Everything runs in the browser (and headless in Node), so
// the claims are re-checkable on every load, not just asserted in a comment.

import { B_CRIT, M, ISCO, PHOTON_SPHERE, DEFAULT_PARAMS, kerrHorizon, kerrISCO, kerrPhotonOrbit, chargeQ2 } from '../state'
import type { Params } from '../types'
import { tracePhoton, cameraRay, aberrate, observerVelocity } from './probe'
import {
  horizons,
  photonRingRadius,
  xiOfR,
  etaOfR,
  radialPotential,
  shadowCurve,
  shadowMetrics,
  iscoRadius,
  spinA,
  isCaptured,
  rnPhotonSphere,
  rnCritical,
  knPhotonRings,
} from './kerr'
import {
  tracePhotonSchw,
  bisectSchwCritical,
  initKerrPhoton,
  traceKerr3D,
  bisectEquatorialShadowEdges,
} from './cpu-geodesic'

export interface TestResult {
  name: string
  detail: string
  /** Measured error against the target (dimensionless or absolute, see `tol`). */
  error: number
  tol: number
  pass: boolean
  group: string
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12)

/** Run the whole suite. Pure computation — no DOM, no GL — so it is Node- and headless-safe. */
export function runSelfTests(): TestResult[] {
  const out: TestResult[] = []
  const add = (name: string, detail: string, error: number, tol: number, group: string) =>
    out.push({ name, detail, error, tol, pass: error <= tol, group })

  // ---- Schwarzschild: light bending from the real integrator -----------------------------------
  {
    const bc = bisectSchwCritical()
    add(
      'Critical impact parameter b_crit',
      `bisected capture edge = ${bc.toFixed(6)} rs vs 3√3·M = ${B_CRIT.toFixed(6)} rs`,
      Math.abs(bc - B_CRIT),
      2e-3,
      'Light bending (Schwarzschild)',
    )
  }
  for (const b of [20, 40]) {
    const measured = tracePhotonSchw(b).deflection
    // Second-order Schwarzschild deflection: α = 4M/b + (15π/4)(M/b)².
    const predicted = (4 * M) / b + (15 * Math.PI) / 4 * (M / b) ** 2
    add(
      `Deflection at b = ${b} rs`,
      `integrated ${measured.toFixed(6)} rad vs GR series ${predicted.toFixed(6)} rad`,
      rel(measured, predicted),
      1.5e-2,
      'Light bending (Schwarzschild)',
    )
  }
  {
    // Bending must grow monotonically as the ray approaches the photon sphere.
    const d1 = tracePhotonSchw(B_CRIT + 0.4).deflection
    const d2 = tracePhotonSchw(B_CRIT + 0.1).deflection
    const d3 = tracePhotonSchw(B_CRIT + 0.03).deflection
    const monotone = d3 > d2 && d2 > d1 && d3 > Math.PI
    add(
      'Deflection diverges toward b_crit',
      `α(b_crit+0.4)=${d1.toFixed(2)} < α(+0.1)=${d2.toFixed(2)} < α(+0.03)=${d3.toFixed(2)} rad`,
      monotone ? 0 : 1,
      0.5,
      'Light bending (Schwarzschild)',
    )
  }

  // ---- Kerr Hamiltonian integrator: conserved quantities on real 3-D geodesics -----------------
  {
    const a = spinA(0.7)
    const rays: [number, number, number, number, number, number][] = [
      [0, 3, -30, 0.02, -0.05, 1],
      [0, 8, -25, -0.08, -0.02, 1],
      [2, 5, -20, 0.05, 0.03, 1],
      [-3, -4, -28, 0.06, 0.04, 1],
    ]
    let worstCarter = 0
    let worstNull = 0
    let traced = 0
    for (const [px, py, pz, dx, dy, dz] of rays) {
      const dl = Math.hypot(dx, dy, dz)
      const init = initKerrPhoton([px, py, pz], [dx / dl, dy / dl, dz / dl], a)
      const t = traceKerr3D(init, a, { steps: 5000, stepSize: 0.1 })
      if (!t.captured) {
        worstCarter = Math.max(worstCarter, t.maxCarterDrift)
        worstNull = Math.max(worstNull, t.maxNull)
        traced++
      }
    }
    add(
      "Carter's constant Q conserved (Kerr, a* = 0.7)",
      `max fractional drift over ${traced} integrated null geodesics = ${worstCarter.toExponential(2)}`,
      worstCarter,
      1e-3,
      'Kerr geodesic integrator',
    )
    add(
      'Null condition 2H = 0 held (Kerr, a* = 0.7)',
      `max |gᵘᵛ p_u p_v| along the same geodesics = ${worstNull.toExponential(2)}`,
      worstNull,
      1e-3,
      'Kerr geodesic integrator',
    )
  }

  // ---- Kerr shadow algebra: spherical photon orbits vs the radial potential --------------------
  {
    let worstR = 0
    let worstRp = 0
    const h = 1e-5
    for (const aStar of [0.2, 0.5, 0.8, 0.95]) {
      const a = spinA(aStar)
      const rPro = photonRingRadius(aStar, true)
      const rRet = photonRingRadius(aStar, false)
      for (let i = 0; i <= 8; i++) {
        const r = rPro + ((rRet - rPro) * i) / 8
        const xi = xiOfR(r, a)
        const eta = etaOfR(r, a)
        worstR = Math.max(worstR, Math.abs(radialPotential(r, a, xi, eta)))
        const rp = (radialPotential(r + h, a, xi, eta) - radialPotential(r - h, a, xi, eta)) / (2 * h)
        worstRp = Math.max(worstRp, Math.abs(rp))
      }
    }
    add(
      'Spherical photon orbits solve R(r) = 0',
      `max |R| at ξ(r),η(r) over 4 spins × 9 radii = ${worstR.toExponential(2)}`,
      worstR,
      1e-6,
      'Kerr shadow (analytic)',
    )
    add(
      "…and R'(r) = 0 (a true double root)",
      `max |dR/dr| at the same points = ${worstRp.toExponential(2)}`,
      worstRp,
      1e-4,
      'Kerr shadow (analytic)',
    )
  }
  {
    // The two equatorial light rings have Carter constant η = 0 exactly.
    let worst = 0
    for (const aStar of [0.3, 0.6, 0.9]) {
      const a = spinA(aStar)
      worst = Math.max(worst, Math.abs(etaOfR(photonRingRadius(aStar, true), a)))
      worst = Math.max(worst, Math.abs(etaOfR(photonRingRadius(aStar, false), a)))
    }
    add(
      'Equatorial light rings have η = 0',
      `max |η| at the prograde/retrograde photon orbits = ${worst.toExponential(2)}`,
      worst,
      1e-6,
      'Kerr shadow (analytic)',
    )
  }
  {
    // a → 0 shadow must be an exact circle of radius b_crit.
    const curve = shadowCurve(0.0015, Math.PI / 2, 400)
    let maxDev = 0
    for (const p of curve) maxDev = Math.max(maxDev, Math.abs(Math.hypot(p.alpha, p.beta) - B_CRIT))
    add(
      'Shadow → circle of radius b_crit as a → 0',
      `max |√(α²+β²) − 3√3·M| = ${maxDev.toExponential(2)} rs`,
      maxDev,
      3e-3,
      'Kerr shadow (analytic)',
    )
  }
  {
    // Independent capture test (radial potential) must agree with the parametric critical curve:
    // every boundary point sits on the escape/capture knife-edge.
    const aStar = 0.95
    const a = spinA(aStar)
    const thetaO = Math.PI / 2
    const curve = shadowCurve(aStar, thetaO, 300)
    const centroid = shadowMetrics(curve).displacement
    const delta = 0.05
    let disagreements = 0
    let tested = 0
    for (const p of curve) {
      // Offset along the ray from the shadow centroid (perpendicular-ish to the boundary even at
      // the displaced near-extremal cusp): just inside → captured, just outside → escapes.
      const rr = Math.hypot(p.alpha - centroid, p.beta)
      if (rr < 1e-3) continue
      const ua = (p.alpha - centroid) / rr
      const ub = p.beta / rr
      const inside = isCaptured(p.alpha - delta * ua, p.beta - delta * ub, a, thetaO)
      const outside = isCaptured(p.alpha + delta * ua, p.beta + delta * ub, a, thetaO)
      tested++
      if (!(inside && !outside)) disagreements++
    }
    add(
      'Critical curve = capture boundary (a* = 0.95)',
      `${tested - disagreements}/${tested} boundary points separate capture from escape`,
      disagreements / Math.max(tested, 1),
      0.02,
      'Kerr shadow (analytic)',
    )
  }

  // ---- Kerr shadow: analytic edges vs the renderer's own integrated geodesics ------------------
  for (const aStar of [0.3, 0.6, 0.9]) {
    const [numLo, numHi] = bisectEquatorialShadowEdges(aStar)
    const a = spinA(aStar)
    const anaPro = Math.abs(xiOfR(photonRingRadius(aStar, true), a))
    const anaRet = Math.abs(xiOfR(photonRingRadius(aStar, false), a))
    const [anaLo, anaHi] = anaPro <= anaRet ? [anaPro, anaRet] : [anaRet, anaPro]
    const err = Math.max(rel(numLo, anaLo), rel(numHi, anaHi))
    add(
      `Integrated shadow edges (a* = ${aStar})`,
      `bisected |b| = {${numLo.toFixed(3)}, ${numHi.toFixed(3)}} vs analytic |ξ| = {${anaLo.toFixed(3)}, ${anaHi.toFixed(3)}} rs`,
      err,
      2e-2,
      'Kerr shadow (integrated)',
    )
  }

  // ---- Closed-form observables self-consistency -----------------------------------------------
  {
    add(
      'Horizon r₊ → 1 rs as a → 0',
      `r₊(0) = ${horizons(0).rPlus.toFixed(6)} rs (Schwarzschild rs)`,
      Math.abs(horizons(0).rPlus - 1),
      1e-9,
      'Closed-form observables',
    )
    add(
      'Photon sphere → 1.5 rs as a → 0',
      `r_ph(0) = ${photonRingRadius(0, true).toFixed(6)} rs`,
      Math.abs(photonRingRadius(0, true) - PHOTON_SPHERE),
      1e-9,
      'Closed-form observables',
    )
    add(
      'ISCO → 6M = 3 rs as a → 0',
      `r_isco(0) = ${iscoRadius(0).toFixed(6)} rs`,
      Math.abs(iscoRadius(0) - ISCO),
      1e-9,
      'Closed-form observables',
    )
    // The physics-package observables must match the UI helpers in state.ts bit-for-bit.
    let worst = 0
    for (const aStar of [0, 0.25, 0.5, 0.75, 0.95]) {
      worst = Math.max(worst, Math.abs(iscoRadius(aStar) - kerrISCO(aStar)))
      worst = Math.max(worst, Math.abs(horizons(spinA(aStar)).rPlus - kerrHorizon(aStar)))
      worst = Math.max(worst, Math.abs(photonRingRadius(aStar, true) - kerrPhotonOrbit(aStar, true)))
      worst = Math.max(worst, Math.abs(photonRingRadius(aStar, false) - kerrPhotonOrbit(aStar, false)))
    }
    add(
      'Physics package agrees with UI helpers',
      `max discrepancy in r₊, ISCO, light rings across 5 spins = ${worst.toExponential(2)} rs`,
      worst,
      1e-9,
      'Closed-form observables',
    )
  }
  {
    // Shadow area and displacement behave: circle area at a = 0, monotone displacement with spin.
    const areaErr = Math.abs(shadowMetrics(shadowCurve(0.0015, Math.PI / 2, 600)).area - Math.PI * B_CRIT * B_CRIT)
    add(
      'Shadow area = π·b_crit² at a → 0',
      `area = ${shadowMetrics(shadowCurve(0.0015, Math.PI / 2, 600)).area.toFixed(4)} vs π·b_crit² = ${(Math.PI * B_CRIT * B_CRIT).toFixed(4)} rs²`,
      areaErr,
      5e-3,
      'Closed-form observables',
    )
    const d0 = shadowMetrics(shadowCurve(0.0015, Math.PI / 2, 400)).displacement
    const dHi = shadowMetrics(shadowCurve(0.95, Math.PI / 2, 400)).displacement
    const good = Math.abs(d0) < 3e-3 && dHi > 0.3
    add(
      'Shadow off-centre only when spinning',
      `centroid α: a→0 = ${d0.toFixed(4)} rs, a* = 0.95 (edge-on) = ${dHi.toFixed(3)} rs`,
      good ? 0 : 1,
      0.5,
      'Closed-form observables',
    )
  }

  // ---- Photon probe: the click-to-trace integrators recover the right physics ------------------
  {
    // A camera ray aimed dead-centre at a Schwarzschild hole is captured.
    const p: Params = { ...DEFAULT_PARAMS, spin: 0, cameraDistance: 20, fov: 55 }
    const c = cameraRay(p, 0, 0)
    const res = tracePhoton(c.pos, c.dir, p)
    add(
      'Probe: centre ray is captured (Schwarzschild)',
      `fate = ${res.fate}, closest approach r = ${res.rMin.toFixed(3)} rs`,
      res.captured ? 0 : 1,
      0.5,
      'Photon probe',
    )
  }
  {
    // The probe's own capture boundary (max b that still falls in) must equal b_crit = 3√3·M.
    const p: Params = { ...DEFAULT_PARAMS, spin: 0, cameraDistance: 30, fov: 40 }
    let maxCapturedB = 0
    for (let n = 0; n <= 240; n++) {
      const ndc = (n / 240) * 0.55
      const c = cameraRay(p, ndc, 0)
      const res = tracePhoton(c.pos, c.dir, p)
      if (res.captured) maxCapturedB = Math.max(maxCapturedB, res.b)
    }
    add(
      'Probe: capture edge = b_crit (Schwarzschild)',
      `max captured impact parameter = ${maxCapturedB.toFixed(4)} rs vs b_crit = ${B_CRIT.toFixed(4)} rs`,
      Math.abs(maxCapturedB - B_CRIT),
      6e-2,
      'Photon probe',
    )
  }
  {
    // An off-axis ray escapes to the sky and carries impact parameter b = |L| > b_crit.
    const p: Params = { ...DEFAULT_PARAMS, spin: 0, cameraDistance: 20, fov: 70 }
    const c = cameraRay(p, 0.85, 0)
    const res = tracePhoton(c.pos, c.dir, p)
    add(
      'Probe: off-axis ray escapes with b > b_crit',
      `fate = ${res.fate}, b = ${res.b.toFixed(3)} rs`,
      res.fate === 'sky' && res.b > B_CRIT ? 0 : 1,
      0.5,
      'Photon probe',
    )
  }
  {
    // The Kerr probe returns finite conserved quantities and a plausible captured central ray.
    const p: Params = { ...DEFAULT_PARAMS, spin: 0.9, cameraDistance: 16, fov: 55 }
    const c = cameraRay(p, 0.05, 0.03)
    const res = tracePhoton(c.pos, c.dir, p)
    const finite = Number.isFinite(res.E) && Number.isFinite(res.L) && Number.isFinite(res.Q) && Number.isFinite(res.b)
    add(
      'Probe: Kerr trace yields finite E, L, Q, b',
      `E = ${res.E.toFixed(3)}, L = ${res.L.toFixed(3)}, Q = ${res.Q.toFixed(3)}, b = ${res.b.toFixed(3)} rs, ${res.path.length} pts`,
      finite && res.path.length > 10 ? 0 : 1,
      0.5,
      'Photon probe',
    )
  }
  {
    // Free-fall aberration: a ray looking into the motion is blueshifted (D > 1), one looking away
    // is redshifted (D < 1), and it reduces to the identity at rest.
    const p: Params = { ...DEFAULT_PARAMS, freeFall: true, spin: 0, cameraDistance: 6 }
    const v = observerVelocity(p) // points radially inward at the camera
    const mag = Math.hypot(v[0], v[1], v[2])
    const vhat: [number, number, number] = [v[0] / mag, v[1] / mag, v[2] / mag]
    const inward = aberrate(vhat, v)
    const outward = aberrate([-vhat[0], -vhat[1], -vhat[2]], v)
    const rest = aberrate([0, 0, 1], [0, 0, 0])
    const ok = inward.D > 1.05 && outward.D < 0.95 && rest.D === 1
    add(
      'Probe: free-fall Doppler blueshifts ahead, redshifts behind',
      `D(into motion) = ${inward.D.toFixed(3)}, D(away) = ${outward.D.toFixed(3)}, D(at rest) = ${rest.D.toFixed(3)}`,
      ok ? 0 : 1,
      0.5,
      'Photon probe',
    )
  }

  // ---- Kerr–Newman: charge generalises the whole shadow story --------------------------------
  {
    // Reissner–Nordström (a → 0, charged): the shadow stays a circle, of radius r_ph²/√Δ(r_ph).
    const q2 = chargeQ2(0.6)
    const bc = rnCritical(q2)
    const curve = shadowCurve(0.0015, Math.PI / 2, 400, q2)
    let maxDev = 0
    for (const p of curve) maxDev = Math.max(maxDev, Math.abs(Math.hypot(p.alpha, p.beta) - bc))
    add(
      'Reissner–Nordström shadow → circle of r_ph²/√Δ',
      `Q* = 0.6: max |√(α²+β²) − ${bc.toFixed(4)}| = ${maxDev.toExponential(2)} rs, r_ph = ${rnPhotonSphere(q2).toFixed(4)} rs`,
      maxDev,
      3e-3,
      'Kerr–Newman (charge)',
    )
  }
  {
    // RN critical impact parameter recovers 3√3·M uncharged and 4M (= 2 rs) at the extremal Q = M
    // (whose photon sphere sits at r = 2M = 1 rs).
    const atZero = Math.abs(rnCritical(0) - B_CRIT)
    const atExtremal = Math.abs(rnCritical(chargeQ2(1)) - 4 * M)
    add(
      'RN critical b: 3√3·M uncharged → 4M extremal',
      `b(Q=0) = ${rnCritical(0).toFixed(5)} rs, b(Q=M) = ${rnCritical(chargeQ2(1)).toFixed(5)} rs (= 4M), r_ph = ${rnPhotonSphere(chargeQ2(1)).toFixed(4)} rs`,
      Math.max(atZero, atExtremal),
      1e-6,
      'Kerr–Newman (charge)',
    )
  }
  {
    // Charged spherical photon orbits still satisfy R(r) = R'(r) = 0 — the KN shadow algebra holds.
    let worstR = 0
    let worstRp = 0
    const h = 1e-5
    for (const [aStar, qStar] of [[0.3, 0.4], [0.5, 0.5], [0.6, 0.6], [0.8, 0.3]] as const) {
      const a = spinA(aStar)
      const q2 = chargeQ2(qStar)
      const [rlo, rhi] = knPhotonRings(a, q2)
      for (let i = 0; i <= 8; i++) {
        const r = rlo + ((rhi - rlo) * i) / 8
        const xi = xiOfR(r, a, q2)
        const eta = etaOfR(r, a, q2)
        worstR = Math.max(worstR, Math.abs(radialPotential(r, a, xi, eta, q2)))
        const rp = (radialPotential(r + h, a, xi, eta, q2) - radialPotential(r - h, a, xi, eta, q2)) / (2 * h)
        worstRp = Math.max(worstRp, Math.abs(rp))
      }
    }
    add(
      'Charged spherical orbits solve R(r) = R′(r) = 0',
      `max |R| = ${worstR.toExponential(2)}, max |dR/dr| = ${worstRp.toExponential(2)} over 4 (a*,Q*) × 9 radii`,
      Math.max(worstR, worstRp * 1e-2),
      1e-5,
      'Kerr–Newman (charge)',
    )
  }
  {
    // The KN photon-ring finder reduces to Bardeen's closed form exactly when uncharged.
    let worst = 0
    for (const aStar of [0.2, 0.5, 0.8, 0.95]) {
      const a = spinA(aStar)
      const [rlo, rhi] = knPhotonRings(a, 0)
      worst = Math.max(worst, Math.abs(rlo - photonRingRadius(aStar, true)))
      worst = Math.max(worst, Math.abs(rhi - photonRingRadius(aStar, false)))
    }
    add(
      'KN light-ring finder = Bardeen at Q = 0',
      `max |r_numeric − r_Bardeen| across 4 spins = ${worst.toExponential(2)} rs`,
      worst,
      1e-6,
      'Kerr–Newman (charge)',
    )
  }
  {
    // The two charged equatorial light rings still carry η = 0 exactly.
    let worst = 0
    for (const [aStar, qStar] of [[0.4, 0.4], [0.6, 0.5], [0.7, 0.4]] as const) {
      const a = spinA(aStar)
      const q2 = chargeQ2(qStar)
      const [rlo, rhi] = knPhotonRings(a, q2)
      worst = Math.max(worst, Math.abs(etaOfR(rlo, a, q2)))
      worst = Math.max(worst, Math.abs(etaOfR(rhi, a, q2)))
    }
    add(
      'Charged light rings have η = 0',
      `max |η| at the KN prograde/retrograde photon orbits = ${worst.toExponential(2)}`,
      worst,
      1e-6,
      'Kerr–Newman (charge)',
    )
  }
  {
    // The analytic KN shadow edges match the renderer's own integrated equatorial geodesics — the
    // charge is honoured identically by the closed form and by the ray tracer.
    const aStar = 0.6
    const q2 = chargeQ2(0.5)
    const a = spinA(aStar)
    const [numLo, numHi] = bisectEquatorialShadowEdges(aStar, q2)
    const [rlo, rhi] = knPhotonRings(a, q2)
    const anaPro = Math.abs(xiOfR(rlo, a, q2))
    const anaRet = Math.abs(xiOfR(rhi, a, q2))
    const [anaLo, anaHi] = anaPro <= anaRet ? [anaPro, anaRet] : [anaRet, anaPro]
    add(
      'Integrated charged shadow edges (a* = 0.6, Q* = 0.5)',
      `bisected |b| = {${numLo.toFixed(3)}, ${numHi.toFixed(3)}} vs analytic |ξ| = {${anaLo.toFixed(3)}, ${anaHi.toFixed(3)}} rs`,
      Math.max(rel(numLo, anaLo), rel(numHi, anaHi)),
      2e-2,
      'Kerr–Newman (charge)',
    )
  }
  {
    // Charge shrinks the shadow: at fixed spin, more charge ⇒ smaller enclosed area.
    const a0 = shadowMetrics(shadowCurve(0.6, Math.PI / 2, 600, 0)).area
    const aQ = shadowMetrics(shadowCurve(0.6, Math.PI / 2, 600, chargeQ2(0.6))).area
    add(
      'Charge shrinks the shadow at fixed spin',
      `area(Q=0) = ${a0.toFixed(3)} rs² → area(Q*=0.6) = ${aQ.toFixed(3)} rs² (${(((a0 - aQ) / a0) * 100).toFixed(1)}% smaller)`,
      aQ < a0 - 0.1 ? 0 : 1,
      0.5,
      'Kerr–Newman (charge)',
    )
  }
  {
    // The probe's Kerr–Newman path: a Reissner–Nordström centre ray is captured, and its capture
    // edge equals the RN critical impact parameter — the click-to-trace machinery honours charge.
    const q2 = chargeQ2(0.6)
    const bcRN = rnCritical(q2)
    const pc: Params = { ...DEFAULT_PARAMS, spin: 0, charge: 0.6, cameraDistance: 30, fov: 40 }
    const centre = tracePhoton(cameraRay(pc, 0, 0).pos, cameraRay(pc, 0, 0).dir, pc)
    let maxCapturedB = 0
    for (let n = 0; n <= 240; n++) {
      const ndc = (n / 240) * 0.5
      const c = cameraRay(pc, ndc, 0)
      const res = tracePhoton(c.pos, c.dir, pc)
      if (res.captured) maxCapturedB = Math.max(maxCapturedB, res.b)
    }
    const ok = centre.captured && Math.abs(maxCapturedB - bcRN) < 8e-2
    add(
      'Probe: RN capture edge = r_ph²/√Δ (Q* = 0.6)',
      `centre ${centre.fate}; max captured b = ${maxCapturedB.toFixed(4)} rs vs RN b_crit = ${bcRN.toFixed(4)} rs`,
      ok ? 0 : 1,
      0.5,
      'Kerr–Newman (charge)',
    )
  }

  return out
}

export interface SuiteSummary {
  results: TestResult[]
  passed: number
  total: number
  groups: string[]
}

export function summarize(results: TestResult[]): SuiteSummary {
  const groups: string[] = []
  for (const r of results) if (!groups.includes(r.group)) groups.push(r.group)
  return { results, passed: results.filter((r) => r.pass).length, total: results.length, groups }
}
