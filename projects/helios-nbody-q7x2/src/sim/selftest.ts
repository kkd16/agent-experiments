// In-app numerical self-test.
//
// Helios makes physical claims — that its orbit solver reconstructs real Kepler
// elements, that the Yoshida integrator beats Verlet at conserving energy, that
// the Lagrange points it draws are genuine equilibria, and that the solver
// conserves momentum. Rather than assert that in prose, this module *checks* it
// at runtime and reports the numbers. The About panel runs it on demand and
// shows every case with its measured residual, so the demonstration is honest
// and reproducible by anyone, in their own browser.

import { Simulation } from './Simulation'
import { fmmAccel, directAccel, forceError, kernelTaylor } from './fmm'
import { orbitElements } from './orbit'
import { jacobiConstant, omegaGradient, solveLagrangeNormalized } from './restricted3body'
import { accelAndVariational, analyzeChaos } from './chaos'
import { fft, ifft } from './fft'
import { naff, frequencyDiffusion } from './naff'
import { poincareSection, toRotating } from './poincare'
import { measurePrecession, precessionTheory, mercuryArcsecPerCentury } from './relativity'
import {
  simulateInspiral,
  integratePeters,
  radiationReactionAccel,
  strainTT,
  quadrupoleLuminosityCircular,
  gwFrequencyCircular,
} from './gravwave'
import {
  criticalImpactParameter,
  shadowImpactParameter,
  circularAngularMomentumSq,
  deflectionAngle,
  bozzaStrongDeflection,
  circularPrecessionPerOrbit,
  integrateCircularPrecession,
  diskRedshiftFactor,
  shadowAngularRadius,
  kerrShadowRim,
  kerrEquatorialPhotonRadius,
} from './geodesic'
import {
  kerrMetricCo,
  kerrMetricContra,
  hamiltonian2,
  geodesicRHS,
  rk4Step,
  initRay,
  carterConstant,
  kerrHorizonRadius,
  kerrHorizonOmega,
  kerrErgosphere,
  kerrIscoRadius,
  diskRedshiftKerr,
  kerrShadowAlphaAtBeta0,
} from './kerr'
import {
  computeCell,
  effectivePotential,
  effectivePotentialGradient,
  frequencyProfile,
  recordOrbit,
} from './fma'
import type { AtlasModel } from './fma'
import { spectrogram } from './spectrogram'
import { keplerStep, lagrangeIdentityResidual } from './kepler'
import type { KeplerState } from './kepler'
import {
  WisdomHolman,
  toBarycentric,
  totalEnergy,
  momentumMagnitude,
  angularMomentum,
  runComparison,
  LAB_PRESETS,
} from './whfast'
import type { IntegratorId } from './types'
import {
  anosovaState,
  scatter as scatterThreeBody,
  recordTrajectory as recordThreeBody,
  angularMomentum as angularMomentum3,
  inRegion as inRegionD,
  DEFAULT_OPTS as TB_OPTS,
  MAP_OPTS as TB_MAP_OPTS,
} from './threebody'

export interface TestCase {
  name: string
  pass: boolean
  detail: string
}

export interface SelfTestReport {
  cases: TestCase[]
  passed: number
  total: number
  ok: boolean
}

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

/** Seed a fixed two-body system: a heavy primary at rest + one orbiting body. */
function twoBody(
  g: number,
  primaryMass: number,
  bodyMass: number,
  a: number,
  e: number,
): Simulation {
  const sim = new Simulation(8)
  const M = primaryMass + bodyMass
  const mu = g * M
  const rp = a * (1 - e) // periapsis separation
  const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e))) // relative speed at periapsis
  // Split the relative state across the two bodies barycentrically: separation
  // along x, the relative velocity along y. This puts the centre of mass exactly
  // at rest at the origin (zero total momentum) for clean bookkeeping, and gives
  // a correct two-body orbit for any mass ratio — including equal masses.
  const x1 = -(bodyMass / M) * rp
  const x2 = (primaryMass / M) * rp
  const vy1 = -(bodyMass / M) * vp
  const vy2 = (primaryMass / M) * vp
  const posX = Float64Array.from([x1, x2])
  const posY = Float64Array.from([0, 0])
  const velX = Float64Array.from([0, 0])
  const velY = Float64Array.from([vy1, vy2])
  const mass = Float64Array.from([primaryMass, bodyMass])
  sim.setBodies(2, posX, posY, velX, velY, mass)
  sim.params = { ...sim.params, g, softening: 0.05, theta: 0 }
  return sim
}

/** Run a sim for `steps` and return the maximum fractional energy excursion. */
function maxEnergyDrift(sim: Simulation, integrator: IntegratorId, dt: number, steps: number): number {
  sim.params = { ...sim.params, integrator, dt }
  sim.resetEnergyBaseline()
  const e0 = sim.diagnostics(true).total
  let maxRel = 0
  for (let s = 0; s < steps; s++) {
    sim.step()
    if (s % 16 === 0) {
      const e = sim.diagnostics(true).total
      const rel = Math.abs((e - e0) / e0)
      if (rel > maxRel) maxRel = rel
    }
  }
  return maxRel
}

export function runSelfTest(): SelfTestReport {
  const cases: TestCase[] = []
  const add = (name: string, pass: boolean, detail: string) => cases.push({ name, pass, detail })

  // 1 — Orbit solver recovers a circular orbit.
  {
    const mu = 1000
    const r = 100
    const v = Math.sqrt(mu / r)
    const el = orbitElements(r, 0, 0, v, mu)
    const T = 2 * Math.PI * Math.sqrt((r * r * r) / mu)
    const pass =
      approx(el.eccentricity, 0, 2e-3) &&
      approx(el.semiMajor, r, 1e-6) &&
      el.period != null &&
      approx(el.period, T, 1e-6) &&
      el.shape === 'circular'
    add(
      'Orbit solver — circular orbit',
      pass,
      `e=${el.eccentricity.toExponential(1)} (≈0), a=${el.semiMajor.toFixed(2)} (=100), T=${el.period?.toFixed(2)} (=${T.toFixed(2)}), shape=${el.shape}`,
    )
  }

  // 2 — Orbit solver recovers an eccentric orbit launched from periapsis.
  {
    const mu = 1000
    const a = 100
    const e = 0.5
    const rp = a * (1 - e)
    const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e)))
    const el = orbitElements(rp, 0, 0, vp, mu)
    const pass =
      approx(el.eccentricity, e, 1e-6) &&
      approx(el.semiMajor, a, 1e-6) &&
      approx(el.periapsis, rp, 1e-6) &&
      el.apoapsis != null &&
      approx(el.apoapsis, a * (1 + e), 1e-6) &&
      approx(el.argPeriapsis, 0, 1e-6)
    add(
      'Orbit solver — eccentric (e=0.5)',
      pass,
      `e=${el.eccentricity.toFixed(4)}, a=${el.semiMajor.toFixed(2)}, peri=${el.periapsis.toFixed(2)} (=50), apo=${el.apoapsis?.toFixed(2)} (=150)`,
    )
  }

  // 3 — A hyperbolic flyby is classified unbound with e > 1.
  {
    const mu = 1000
    const r = 100
    const vEsc = Math.sqrt((2 * mu) / r)
    const el = orbitElements(r, 0, 0, vEsc * 1.3, mu)
    const pass = el.eccentricity > 1 && !el.bound && el.shape === 'hyperbolic' && el.apoapsis == null
    add(
      'Orbit solver — hyperbolic flyby',
      pass,
      `e=${el.eccentricity.toFixed(3)} (>1), bound=${el.bound}, shape=${el.shape}`,
    )
  }

  // 4 — Yoshida 4 conserves energy far better than Verlet at equal Δt.
  {
    const dt = 0.06
    const steps = 4000
    const vSim = twoBody(1, 2000, 1, 100, 0.6)
    const verlet = maxEnergyDrift(vSim, 'velocity-verlet', dt, steps)
    const ySim = twoBody(1, 2000, 1, 100, 0.6)
    const yoshida = maxEnergyDrift(ySim, 'yoshida4', dt, steps)
    // Both are symplectic (bounded), but 4th order should be dramatically smaller.
    const pass = yoshida < verlet * 0.2 && yoshida < 1e-2
    add(
      'Yoshida 4 beats Verlet (energy)',
      pass,
      `max |ΔE/E|: Verlet=${verlet.toExponential(2)}, Yoshida4=${yoshida.toExponential(2)} — ${(verlet / Math.max(yoshida, 1e-30)).toFixed(0)}× better`,
    )
  }

  // 5 — Explicit Euler visibly *gains* energy (the cautionary tale holds).
  {
    const dt = 0.06
    const steps = 1500
    const sim = twoBody(1, 2000, 1, 100, 0.3)
    const euler = maxEnergyDrift(sim, 'euler', dt, steps)
    const sim2 = twoBody(1, 2000, 1, 100, 0.3)
    const verlet = maxEnergyDrift(sim2, 'velocity-verlet', dt, steps)
    const pass = euler > verlet * 5
    add(
      'Explicit Euler drifts (control)',
      pass,
      `max |ΔE/E|: Euler=${euler.toExponential(2)} ≫ Verlet=${verlet.toExponential(2)}`,
    )
  }

  // 6 — Every Lagrange point is a true equilibrium: ∇Ω ≈ 0.
  {
    const mu = 0.01 // a Sun–planet-like ratio
    const pts = solveLagrangeNormalized(mu)
    let worst = 0
    for (const [x, y] of pts) {
      const [gx, gy] = omegaGradient(x, y, mu)
      worst = Math.max(worst, Math.hypot(gx, gy))
    }
    const pass = worst < 1e-6
    add('Lagrange points are equilibria', pass, `max |∇Ω| over L1–L5 = ${worst.toExponential(2)} (≈0)`)
  }

  // 7 — Triangular points sit exactly at the equilateral apices.
  {
    const mu = 0.01
    const pts = solveLagrangeNormalized(mu)
    const l4 = pts[3]
    const ok = approx(l4[0], 0.5 - mu, 1e-9) && approx(l4[1], Math.sqrt(3) / 2, 1e-9)
    add('L4 at equilateral apex', ok, `L4=(${l4[0].toFixed(4)}, ${l4[1].toFixed(4)}) = (½−μ, √3/2)`)
  }

  // 8 — The Barnes–Hut solver conserves total momentum (θ = 0 ⇒ exact).
  {
    const sim = new Simulation(64)
    const n = 40
    const px = new Float64Array(n)
    const py = new Float64Array(n)
    const vx = new Float64Array(n)
    const vy = new Float64Array(n)
    const m = new Float64Array(n)
    let s = 123456789 >>> 0
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < n; i++) {
      px[i] = (rnd() - 0.5) * 200
      py[i] = (rnd() - 0.5) * 200
      vx[i] = (rnd() - 0.5) * 2
      vy[i] = (rnd() - 0.5) * 2
      m[i] = 1 + rnd() * 4
    }
    sim.setBodies(n, px, py, vx, vy, m)
    sim.params = { ...sim.params, g: 1, theta: 0, softening: 4, dt: 0.05, integrator: 'velocity-verlet' }
    const p0 = sim.diagnostics(false)
    const pm0 = Math.hypot(p0.momentumX, p0.momentumY)
    for (let i = 0; i < 300; i++) sim.step()
    const p1 = sim.diagnostics(false)
    const drift = Math.hypot(p1.momentumX - p0.momentumX, p1.momentumY - p0.momentumY)
    const rel = drift / (pm0 + 1e-9)
    const pass = rel < 1e-9
    add('Momentum conserved (θ=0)', pass, `|Δp|/|p| = ${rel.toExponential(2)} after 300 steps`)
  }

  // 9 — Virial ratio of a near-equilibrium two-body orbit averages toward 1.
  {
    const sim = twoBody(1, 1000, 1000, 120, 0.0) // equal-mass circular binary
    sim.params = { ...sim.params, integrator: 'yoshida4', dt: 0.02 }
    let sum = 0
    let cnt = 0
    for (let i = 0; i < 2000; i++) {
      sim.step()
      if (i % 20 === 0) {
        const v = sim.diagnostics(true).virial
        if (Number.isFinite(v)) {
          sum += v
          cnt++
        }
      }
    }
    const mean = cnt > 0 ? sum / cnt : NaN
    const pass = Number.isFinite(mean) && approx(mean, 1, 0.15)
    add('Virial theorem (2T/|U| → 1)', pass, `time-averaged 2T/|U| = ${mean.toFixed(3)} (≈1)`)
  }

  // 10 — The Jacobi constant is (nearly) conserved for a test particle orbiting a
  // Sun–planet binary, as the restricted three-body problem demands.
  {
    const sim = new Simulation(8)
    const g = 1
    const sun = 20000
    const R = 200
    const planet = 12
    const vP = Math.sqrt((g * sun) / R)
    // Sun (recoiled), planet on a circular orbit, and a co-orbital test particle.
    const rPart = R * 1.18
    const vPart = Math.sqrt((g * sun) / rPart)
    const px = Float64Array.from([0, R, 0])
    const py = Float64Array.from([0, 0, rPart])
    const vx = Float64Array.from([0, 0, -vPart])
    const vy = Float64Array.from([-(planet * vP) / sun, vP, 0])
    const mass = Float64Array.from([sun, planet, 1e-6])
    sim.setBodies(3, px, py, vx, vy, mass)
    sim.params = { ...sim.params, g, theta: 0, softening: 0.5, dt: 0.01, integrator: 'yoshida4' }
    const cj = () =>
      jacobiConstant(
        sim.mass[0], sim.posX[0], sim.posY[0], sim.velX[0], sim.velY[0],
        sim.mass[1], sim.posX[1], sim.posY[1], sim.velX[1], sim.velY[1],
        g,
        sim.posX[2], sim.posY[2], sim.velX[2], sim.velY[2],
      ) ?? NaN
    const c0 = cj()
    for (let i = 0; i < 6000; i++) sim.step()
    const c1 = cj()
    const rel = Math.abs((c1 - c0) / c0)
    const pass = Number.isFinite(rel) && rel < 5e-3
    add('Jacobi constant conserved', pass, `|ΔC/C| = ${rel.toExponential(2)} over 6000 steps`)
  }

  // 11 — Yoshida 6 conserves energy dramatically better than Yoshida 4 (its
  // error scales as Δt⁶ vs Δt⁴), and both stay symplectically bounded.
  {
    const dt = 0.06
    const steps = 4000
    const y4Sim = twoBody(1, 2000, 1, 100, 0.6)
    const y4 = maxEnergyDrift(y4Sim, 'yoshida4', dt, steps)
    const y6Sim = twoBody(1, 2000, 1, 100, 0.6)
    const y6 = maxEnergyDrift(y6Sim, 'yoshida6', dt, steps)
    const pass = y6 < y4 * 0.1 && y6 < 1e-6
    add(
      'Yoshida 6 beats Yoshida 4 (energy)',
      pass,
      `max |ΔE/E|: Yoshida4=${y4.toExponential(2)}, Yoshida6=${y6.toExponential(2)} — ${(y4 / Math.max(y6, 1e-30)).toFixed(0)}× better`,
    )
  }

  // 12 — Velocity Verlet is time-reversible: integrate forward, flip every
  // velocity, integrate the same number of steps, and the system retraces its
  // path back to the start. (This is the discrete time-symmetry that underlies
  // symplecticity — a property explicit Euler and RK4 both lack.)
  {
    const dt = 0.04
    const K = 3000
    const a = 100
    const sim = twoBody(1, 2000, 1, a, 0.3)
    sim.params = { ...sim.params, integrator: 'velocity-verlet', dt }
    const x0 = Float64Array.from(sim.posX.subarray(0, sim.count))
    const y0 = Float64Array.from(sim.posY.subarray(0, sim.count))
    for (let i = 0; i < K; i++) sim.step()
    for (let i = 0; i < sim.count; i++) {
      sim.velX[i] = -sim.velX[i]
      sim.velY[i] = -sim.velY[i]
    }
    sim.invalidateAccel()
    for (let i = 0; i < K; i++) sim.step()
    let worst = 0
    for (let i = 0; i < sim.count; i++) {
      worst = Math.max(worst, Math.hypot(sim.posX[i] - x0[i], sim.posY[i] - y0[i]))
    }
    const rel = worst / a
    const pass = rel < 1e-7
    add('Velocity Verlet is time-reversible', pass, `return error / orbit size = ${rel.toExponential(2)} after ±${K} steps`)
  }

  // 13 — The variational (tidal) tensor that drives the chaos analysis is the
  // exact gradient of the force: its analytic deviation-acceleration matches a
  // central finite difference of the real acceleration to O(h²).
  {
    const n = 5
    const g = 1
    const eps2 = 3 * 3
    let s = 42 >>> 0
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    const X = new Float64Array(n), Y = new Float64Array(n), M = new Float64Array(n)
    const DX = new Float64Array(n), DY = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      X[i] = (rnd() - 0.5) * 100
      Y[i] = (rnd() - 0.5) * 100
      M[i] = 1 + rnd() * 5
      DX[i] = rnd() - 0.5
      DY[i] = rnd() - 0.5
    }
    const z = new Float64Array(n)
    const AX = new Float64Array(n), AY = new Float64Array(n)
    const DAX = new Float64Array(n), DAY = new Float64Array(n)
    accelAndVariational(n, X, Y, M, DX, DY, AX, AY, DAX, DAY, g, eps2)
    const accelAt = (sx: Float64Array, sy: Float64Array): [Float64Array, Float64Array] => {
      const ax = new Float64Array(n), ay = new Float64Array(n)
      const da = new Float64Array(n), db = new Float64Array(n)
      accelAndVariational(n, sx, sy, M, z, z, ax, ay, da, db, g, eps2)
      return [ax, ay]
    }
    const h = 1e-5
    const xp = new Float64Array(n), yp = new Float64Array(n)
    const xm = new Float64Array(n), ym = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      xp[i] = X[i] + h * DX[i]; yp[i] = Y[i] + h * DY[i]
      xm[i] = X[i] - h * DX[i]; ym[i] = Y[i] - h * DY[i]
    }
    const [axp, ayp] = accelAt(xp, yp)
    const [axm, aym] = accelAt(xm, ym)
    let worst = 0
    let scale = 0
    for (let i = 0; i < n; i++) {
      const fdx = (axp[i] - axm[i]) / (2 * h)
      const fdy = (ayp[i] - aym[i]) / (2 * h)
      worst = Math.max(worst, Math.hypot(fdx - DAX[i], fdy - DAY[i]))
      scale = Math.max(scale, Math.hypot(DAX[i], DAY[i]))
    }
    const rel = worst / (scale + 1e-30)
    const pass = rel < 1e-5
    add('Tidal tensor = ∇(force) [finite-diff]', pass, `analytic vs central-difference variational accel: rel err ${rel.toExponential(2)}`)
  }

  // 14 & 15 — The chaos engine tells order from chaos. A regular (integrable
  // two-body) orbit has MEGNO ⟨Y⟩ → 2 and a Lyapunov exponent that decays toward
  // 0; the Pythagorean three-body problem is famously chaotic — MEGNO grows far
  // past 2, it is classified chaotic, and its Lyapunov exponent exceeds the
  // regular orbit's. (Softened so the linearised flow stays finite.)
  {
    const regSim = twoBody(1, 2000, 1, 100, 0.5)
    const reg = analyzeChaos(
      regSim.count, regSim.posX, regSim.posY, regSim.velX, regSim.velY, regSim.mass,
      { g: 1, softening: 0.05, dt: 0.02, steps: 20000 },
    )
    add(
      'MEGNO → 2 for a regular orbit',
      approx(reg.megno, 2, 0.7) && reg.classification === 'regular',
      `⟨Y⟩=${reg.megno.toFixed(3)} (≈2), λ=${reg.lyapunov.toExponential(2)}, ${reg.classification}`,
    )

    const L = 40
    const mf = 80
    const px = Float64Array.from([1 * L, -2 * L, 1 * L])
    const py = Float64Array.from([3 * L, -1 * L, -1 * L])
    const vx = Float64Array.from([0, 0, 0])
    const vy = Float64Array.from([0, 0, 0])
    const mass = Float64Array.from([3 * mf, 4 * mf, 5 * mf])
    const ch = analyzeChaos(3, px, py, vx, vy, mass, { g: 1, softening: 2, dt: 0.01, steps: 30000 })
    add(
      'Chaos detected in the Pythagorean 3-body',
      ch.megno > 3.5 && ch.classification === 'chaotic' && ch.lyapunov > reg.lyapunov,
      `⟨Y⟩=${ch.megno.toFixed(2)} (≫2), λ=${ch.lyapunov.toExponential(2)} > regular ${reg.lyapunov.toExponential(2)}, ${ch.classification}`,
    )
  }

  // 16 — The from-scratch FFT is correct: it inverts exactly and agrees with a
  // direct DFT bin, so the spectral analyser's coarse search rests on solid ground.
  {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    let s = 7 >>> 0
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < n; i++) {
      re[i] = rnd() - 0.5
      im[i] = rnd() - 0.5
    }
    const r0 = Float64Array.from(re)
    const i0 = Float64Array.from(im)
    const R = Float64Array.from(re)
    const I = Float64Array.from(im)
    fft(R, I)
    // Direct DFT at bin m = 5 for cross-validation.
    const m = 5
    let nr = 0
    let ni = 0
    for (let k = 0; k < n; k++) {
      const a = (-2 * Math.PI * m * k) / n
      nr += r0[k] * Math.cos(a) - i0[k] * Math.sin(a)
      ni += r0[k] * Math.sin(a) + i0[k] * Math.cos(a)
    }
    const dftErr = Math.hypot(R[m] - nr, I[m] - ni)
    ifft(R, I)
    let round = 0
    for (let k = 0; k < n; k++) round = Math.max(round, Math.hypot(R[k] - r0[k], I[k] - i0[k]))
    const pass = round < 1e-12 && dftErr < 1e-12
    add('FFT inverts & matches direct DFT', pass, `round-trip err ${round.toExponential(2)}, vs DFT ${dftErr.toExponential(2)}`)
  }

  // 17 — NAFF recovers a synthetic two-tone complex signal: both frequencies (one
  // prograde, one retrograde, neither on an FFT bin) and both complex amplitudes,
  // far below bin resolution.
  {
    const N = 4096
    const dt = 0.1
    const w1 = 0.7234
    const w2 = -1.531
    const a1r = Math.cos(0.3)
    const a1i = Math.sin(0.3)
    const a2r = 0.4 * Math.cos(-1.2)
    const a2i = 0.4 * Math.sin(-1.2)
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let k = 0; k < N; k++) {
      const t = k * dt
      const c1 = Math.cos(w1 * t)
      const s1 = Math.sin(w1 * t)
      const c2 = Math.cos(w2 * t)
      const s2 = Math.sin(w2 * t)
      re[k] = a1r * c1 - a1i * s1 + (a2r * c2 - a2i * s2)
      im[k] = a1r * s1 + a1i * c1 + (a2r * s2 + a2i * c2)
    }
    const res = naff(re, im, dt, { maxTerms: 4 })
    const near = (w: number) =>
      res.lines.reduce((b, l) => (Math.abs(l.omega - w) < Math.abs(b.omega - w) ? l : b), res.lines[0])
    const l1 = near(w1)
    const l2 = near(w2)
    const fErr = Math.max(Math.abs(l1.omega - w1), Math.abs(l2.omega - w2))
    const aErr = Math.max(Math.abs(l1.amp - 1), Math.abs(l2.amp - 0.4))
    const pass = fErr < 1e-5 && aErr < 1e-3 && res.reconError < 1e-4
    add(
      'NAFF recovers a two-tone signal',
      pass,
      `freq err ${fErr.toExponential(2)}, amp err ${aErr.toExponential(2)}, recon ${res.reconError.toExponential(2)}`,
    )
  }

  // 18 — Super-resolution: a tone placed exactly half an FFT bin off-grid (the
  // worst case for an FFT) is recovered to a tiny fraction of one bin width.
  {
    const N = 2048
    const dt = 0.2
    const dW = (2 * Math.PI) / (N * dt)
    const w0 = (17 + 0.5) * dW
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let k = 0; k < N; k++) {
      const t = k * dt
      re[k] = Math.cos(w0 * t)
      im[k] = Math.sin(w0 * t)
    }
    const res = naff(re, im, dt, { maxTerms: 2 })
    const ratio = Math.abs(res.lines[0].omega - w0) / dW
    const pass = ratio < 1e-3
    add('NAFF beats FFT bin resolution', pass, `frequency error = ${ratio.toExponential(2)} × one FFT bin`)
  }

  // 19 — NAFF reads a real orbit's mean motion off the simulator: the fundamental
  // of a circular two-body orbit equals n = √(μ/a³), and the orbit's frequency is
  // frozen (frequency-map diffusion → machine zero ⇒ classified regular).
  {
    const sim = twoBody(1, 2000, 1, 100, 0.0) // circular, μ = 2001, a = 100
    sim.params = { ...sim.params, integrator: 'yoshida4', dt: 0.04 }
    const n = Math.sqrt(2001 / 1e6)
    const tr = sim.recordComplexTrack(1, 8192, 2, 'heaviest')
    const res = tr ? naff(tr.re, tr.im, tr.dt, { maxTerms: 4 }) : null
    const diff = tr ? frequencyDiffusion(tr.re, tr.im, tr.dt, 4) : null
    const rel = res ? Math.abs(res.fundamental - n) / n : Infinity
    const pass = !!res && !!diff && rel < 5e-4 && diff.classification === 'regular'
    add(
      'NAFF recovers Kepler mean motion',
      pass,
      `fundamental ν=${res?.fundamental.toExponential(4)} vs n=${n.toExponential(4)} (rel ${rel.toExponential(2)}), diffusion ${diff?.classification}`,
    )
  }

  // 20 — Frequency-map analysis tells order from chaos: the Pythagorean three-body
  // problem's fundamental frequency drifts by orders of magnitude more than the
  // frozen circular orbit's, and is flagged non-regular.
  {
    const reg = twoBody(1, 2000, 1, 100, 0.0)
    reg.params = { ...reg.params, integrator: 'yoshida4', dt: 0.04 }
    const trReg = reg.recordComplexTrack(1, 8192, 2, 'heaviest')
    const dReg = trReg ? frequencyDiffusion(trReg.re, trReg.im, trReg.dt, 4) : null

    const L = 40
    const mf = 80
    const chSim = new Simulation(8)
    chSim.setBodies(
      3,
      Float64Array.from([1 * L, -2 * L, 1 * L]),
      Float64Array.from([3 * L, -1 * L, -1 * L]),
      Float64Array.from([0, 0, 0]),
      Float64Array.from([0, 0, 0]),
      Float64Array.from([3 * mf, 4 * mf, 5 * mf]),
    )
    chSim.params = { ...chSim.params, g: 1, softening: 2, theta: 0, dt: 0.01, integrator: 'yoshida4' }
    const trCh = chSim.recordComplexTrack(0, 8192, 2, 'barycenter')
    const dCh = trCh ? frequencyDiffusion(trCh.re, trCh.im, trCh.dt, 5) : null

    const pass =
      !!dReg && !!dCh && dReg.valid && dCh.valid &&
      dReg.classification === 'regular' &&
      dCh.classification !== 'regular' &&
      dCh.logDiffusion > dReg.logDiffusion + 4
    add(
      'Frequency diffusion flags chaos',
      pass,
      `log₁₀|Δν/ν|: regular ${dReg?.logDiffusion.toFixed(1)} (${dReg?.classification}) ≪ Pythagorean ${dCh?.logDiffusion.toFixed(1)} (${dCh?.classification})`,
    )
  }

  // 21 — The co-rotating-frame transform (transport theorem) is exact: a point
  // that rigidly co-rotates with the binary has zero velocity in the rotating
  // frame. Equal-mass binary on the x-axis spinning at ω about the origin, plus a
  // test point at (2,0) carried along at ω·ẑ×r — it should sit still in the frame.
  {
    const w = 0.37
    const rot = toRotating(
      1, -1, 0, 0, -w, // m1 at (−1,0), v = ω ẑ×r
      1, 1, 0, 0, w, //  m2 at (+1,0)
      2, 0, 0, 2 * w, //  test point at (2,0), v = ω ẑ×r
    )
    const pass =
      approx(rot.xi, 2, 1e-12) && approx(rot.eta, 0, 1e-12) &&
      approx(rot.xidot, 0, 1e-12) && approx(rot.etadot, 0, 1e-12) &&
      approx(rot.omega, w, 1e-12)
    add(
      'Co-rotating frame transform is exact',
      pass,
      `ξ=${rot.xi.toFixed(3)} (=2), ξ̇=${rot.xidot.toExponential(1)} (≈0), η̇=${rot.etadot.toExponential(1)} (≈0), ω=${rot.omega.toFixed(3)} (=${w})`,
    )
  }

  // 22 — The Poincaré section is physically consistent: along a genuine
  // restricted-3-body trajectory (a Sun, a circular planet and an outer test
  // particle), the Jacobi constant sampled at every section crossing is the same
  // — the section lies on a single energy surface, as it must.
  {
    const sim = new Simulation(8)
    const g = 1
    const sun = 20000
    const R = 200
    const planet = 12
    const vP = Math.sqrt((g * sun) / R)
    const rPart = R * 1.6
    const vPart = Math.sqrt((g * sun) / rPart)
    sim.setBodies(
      3,
      Float64Array.from([0, R, rPart]),
      Float64Array.from([0, 0, 0]),
      Float64Array.from([0, 0, 0]),
      Float64Array.from([-(planet * vP) / sun, vP, vPart]),
      Float64Array.from([sun, planet, 1e-6]),
    )
    sim.params = { ...sim.params, g, theta: 0, softening: 0.5, dt: 0.02, integrator: 'yoshida4' }
    const sec = poincareSection(sim, 2, { maxCrossings: 300, maxSteps: 200000 })
    const pass = sec.valid && sec.count > 10 && sec.jacobiSpread < 5e-3
    add(
      'Poincaré section conserves Jacobi',
      pass,
      `${sec.count} crossings, Jacobi spread = ${Number.isFinite(sec.jacobiSpread) ? sec.jacobiSpread.toExponential(2) : 'n/a'} (≈0)`,
    )
  }

  // 23 — General relativity: the measured apsidal precession of a body integrated
  // with the 1PN correction matches the closed-form Δϖ = 6πμ/(c²a(1−e²)) per
  // orbit. Measured in a weak field (large c) so the leading-order formula is
  // essentially exact and the agreement is tight.
  {
    const res = measurePrecession({ mu: 8000, a: 200, e: 0.15, c: 400, orbits: 16, stepsPerOrbit: 6000 })
    const pass = res.valid && Number.isFinite(res.ratio) && Math.abs(res.ratio - 1) < 0.01 && res.measuredPerOrbit > 0
    add(
      'GR precession matches 6πμ/(c²a(1−e²))',
      pass,
      `measured ${(res.measuredPerOrbit * 180 / Math.PI).toFixed(4)}°/orbit vs theory ${(res.theoryPerOrbit * 180 / Math.PI).toFixed(4)}° (ratio ${res.ratio.toFixed(4)}), prograde=${res.measuredPerOrbit > 0}`,
    )
  }

  // 24 — Newtonian limit: as c → ∞ the relativistic correction vanishes and the
  // orbit closes (zero precession). The formula and the measurement agree at both
  // a finite c (a clear, prograde precession) and c → ∞ (none).
  {
    const huge = measurePrecession({ mu: 8000, a: 120, e: 0.45, c: 1e6, orbits: 14, stepsPerOrbit: 5000 })
    const finite = measurePrecession({ mu: 8000, a: 120, e: 0.45, c: 300, orbits: 14, stepsPerOrbit: 5000 })
    const pass =
      huge.valid && finite.valid &&
      Math.abs(huge.measuredPerOrbit) < 1e-5 &&
      finite.measuredPerOrbit > 1e-2 &&
      precessionTheory(8000, 120, 0.45, 1e6) < 1e-6
    add(
      'GR vanishes in the Newtonian limit (c→∞)',
      pass,
      `precession: c=300 → ${(finite.measuredPerOrbit * 180 / Math.PI).toFixed(3)}°/orbit, c=10⁶ → ${huge.measuredPerOrbit.toExponential(1)} rad (≈0)`,
    )
  }

  // 25 — The full simulation engine reproduces the precession. A star + planet
  // two-body system integrated through the engine's own force loop (Barnes–Hut +
  // 1PN) precesses at the predicted rate, measured by detecting the planet's
  // periapsis passages — proof the velocity-dependent force is wired into the
  // integrators correctly, not just the standalone reference solver.
  {
    const g = 1, M = 8000, m = 1, a = 120, e = 0.45, c = 130
    const mu = g * (M + m)
    const rp = a * (1 - e)
    const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e)))
    const sim = new Simulation(8)
    sim.setBodies(
      2,
      Float64Array.from([0, rp]),
      Float64Array.from([0, 0]),
      Float64Array.from([0, 0]),
      Float64Array.from([-(m * vp) / M, vp]),
      Float64Array.from([M, m]),
    )
    sim.params = { ...sim.params, g, theta: 0, softening: 0, dt: 0.02, integrator: 'yoshida6', gr: true, c }
    let prevRdot = 1, totalPhi = 0, prevAngle: number | null = null
    const peri: number[] = []
    for (let i = 0; i < 200000 && peri.length < 16; i++) {
      sim.step()
      const rx = sim.posX[1] - sim.posX[0], ry = sim.posY[1] - sim.posY[0]
      const vx = sim.velX[1] - sim.velX[0], vy = sim.velY[1] - sim.velY[0]
      const ang = Math.atan2(ry, rx)
      if (prevAngle !== null) {
        let d = ang - prevAngle
        if (d > Math.PI) d -= 2 * Math.PI
        else if (d < -Math.PI) d += 2 * Math.PI
        totalPhi += d
      }
      prevAngle = ang
      const rdot = rx * vx + ry * vy
      if (prevRdot < 0 && rdot >= 0) peri.push(totalPhi)
      prevRdot = rdot
    }
    let sum = 0
    for (let k = 1; k < peri.length; k++) sum += peri[k] - peri[k - 1] - 2 * Math.PI
    const measured = peri.length > 1 ? sum / (peri.length - 1) : NaN
    const theory = precessionTheory(mu, a, e, c)
    const ratio = measured / theory
    // Engine integration at v/c ≈ 0.1 carries a genuine higher-order PN deficit
    // (~3%); accept a band around the leading-order theory.
    const pass = Number.isFinite(ratio) && ratio > 0.9 && ratio < 1.03 && peri.length >= 10
    add(
      'Engine integrates GR precession',
      pass,
      `measured ${(measured * 180 / Math.PI).toFixed(3)}°/orbit vs theory ${(theory * 180 / Math.PI).toFixed(3)}° (ratio ${ratio.toFixed(3)}) over ${peri.length} periapses`,
    )
  }

  // 26 — Momentum is conserved with GR on. The 1PN correction applies an
  // equal-and-opposite reaction to the dominant body, so a closed two-body system
  // that starts with zero total momentum keeps it to machine precision.
  {
    const g = 1, M = 8000, m = 1, a = 120, e = 0.45, c = 130
    const mu = g * (M + m)
    const rp = a * (1 - e)
    const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e)))
    const x1 = -(m / (M + m)) * rp, x2 = (M / (M + m)) * rp
    const vy1 = -(m / (M + m)) * vp, vy2 = (M / (M + m)) * vp
    const sim = new Simulation(8)
    sim.setBodies(
      2,
      Float64Array.from([x1, x2]),
      Float64Array.from([0, 0]),
      Float64Array.from([0, 0]),
      Float64Array.from([vy1, vy2]),
      Float64Array.from([M, m]),
    )
    sim.params = { ...sim.params, g, theta: 0, softening: 0, dt: 0.02, integrator: 'velocity-verlet', gr: true, c }
    const p0 = sim.diagnostics(false)
    for (let i = 0; i < 20000; i++) sim.step()
    const p1 = sim.diagnostics(false)
    const drift = Math.hypot(p1.momentumX - p0.momentumX, p1.momentumY - p0.momentumY)
    const scale = M * vp
    const rel = drift / scale
    const pass = rel < 1e-12
    add(
      'Momentum conserved with GR (back-reaction)',
      pass,
      `|Δp|/(M·v_p) = ${rel.toExponential(2)} after 20000 GR steps`,
    )
  }

  // 27 — The same formula, fed Mercury's real orbital numbers (a, e, GM_sun, c),
  // returns the historical anomalous perihelion advance: 43″ per century.
  {
    const arcsec = mercuryArcsecPerCentury()
    const pass = Math.abs(arcsec - 43) < 1.5
    add(
      "Mercury's perihelion advance ≈ 43″/century",
      pass,
      `formula on real Mercury values → ${arcsec.toFixed(2)}″/century (observed/GR ≈ 43″)`,
    )
  }

  // 28 — Gravitational waves: a circular binary integrated with the 2.5PN
  // radiation reaction inspirals in exactly the time Peters (1964) predicts,
  // t_c = 5c⁵a⁴/(256 G³m₁m₂M). The radiation-reaction force and the closed-form
  // merger time are derived independently, so their agreement validates both.
  {
    const res = simulateInspiral({
      m1: 1, m2: 0.8, g: 1, c: 1.3, a0: 36, e0: 0,
      inclination: Math.PI / 6, distance: 100, stepsPerOrbit: 120, endFraction: 0.2,
    })
    const pass =
      res.valid && Number.isFinite(res.ratioMergerTime) && Math.abs(res.ratioMergerTime - 1) < 0.02
    add(
      'GW inspiral matches Peters merger time',
      pass,
      `measured ${res.mergerTimeMeasured.toFixed(0)} vs Peters ${res.mergerTimePeters.toFixed(0)} (ratio ${res.ratioMergerTime.toFixed(4)}), ${res.cycles.toFixed(0)} GW cycles`,
    )
  }

  // 29 — Energy balance: the work the 2.5PN reaction force does on the relative
  // orbit, dE/dt = μ·(a_RR·v), equals minus the quadrupole gravitational
  // luminosity L = (32/5)G⁴m₁²m₂²M/(c⁵a⁵) for a circular orbit. A direct check
  // that the radiation reaction drains energy at exactly the radiated rate.
  {
    const g = 1, c = 1.3, m1 = 1, m2 = 0.8, a = 30
    const M = m1 + m2, mu = (m1 * m2) / M, gm = g * M
    const vy = Math.sqrt(gm / a)
    const [ax, ay] = radiationReactionAccel(a, 0, 0, vy, M, mu, g, c)
    const dEdt = mu * (0 * ax + vy * ay)
    const L = quadrupoleLuminosityCircular(g, c, m1, m2, a)
    const ratio = dEdt / -L
    const pass = Number.isFinite(ratio) && Math.abs(ratio - 1) < 1e-9
    add(
      'GW energy balance: dE/dt = −L_quad',
      pass,
      `dE/dt=${dEdt.toExponential(3)} vs −L=${(-L).toExponential(3)} (ratio ${ratio.toFixed(6)})`,
    )
  }

  // 30 — The gravitational-wave frequency is exactly twice the orbital frequency
  // (the quadrupole radiates at the second harmonic), matching Kepler's
  // f_orb = (1/2π)√(GM/a³).
  {
    const g = 1, m1 = 1, m2 = 0.8, a = 30
    const gm = g * (m1 + m2)
    const fgw = gwFrequencyCircular(g, m1, m2, a)
    const forb = (1 / (2 * Math.PI)) * Math.sqrt(gm / (a * a * a))
    const ratio = fgw / (2 * forb)
    const pass = Math.abs(ratio - 1) < 1e-12
    add(
      'GW frequency = 2 × orbital frequency',
      pass,
      `f_gw=${fgw.toExponential(4)} vs 2·f_orb=${(2 * forb).toExponential(4)} (ratio ${ratio.toFixed(6)})`,
    )
  }

  // 31 — An eccentric inspiral circularises. The radiation-reaction integration
  // is run from e₀ = 0.5, and the resulting a(t), e(t) are compared head-to-head
  // with an independent integration of Peters' coupled da/dt, de/dt equations.
  // Gravitational radiation famously bleeds eccentricity faster than energy.
  {
    const g = 1, c = 1.5, m1 = 1, m2 = 1, a0 = 36, e0 = 0.5
    const res = simulateInspiral({
      m1, m2, g, c, a0, e0, inclination: 0, distance: 100,
      stepsPerOrbit: 200, endFraction: 0.45,
    })
    const aMeas = res.aTrack[res.aTrack.length - 1]
    const eMeas = res.eTrack[res.eTrack.length - 1]
    const pet = integratePeters(g, c, m1, m2, a0, e0, res.mergerTimeMeasured, 6000)
    const aOk = Math.abs(aMeas / pet.a - 1) < 0.03
    const eOk = eMeas < e0 - 0.2 && Math.abs(eMeas / pet.e - 1) < 0.06
    const pass = res.valid && aOk && eOk
    add(
      'GW eccentric inspiral matches Peters a(t), e(t)',
      pass,
      `e: ${e0} → measured ${eMeas.toFixed(3)} vs Peters ${pet.e.toFixed(3)}; a: ${a0} → ${aMeas.toFixed(2)} vs ${pet.a.toFixed(2)}`,
    )
  }

  // 32 — Newtonian limit: as c → ∞ the radiation reaction (∝ 1/c⁵) vanishes and
  // the orbit does not inspiral at all — the semi-major axis is frozen.
  {
    const res = simulateInspiral({
      m1: 1, m2: 0.8, g: 1, c: 1e6, a0: 36, e0: 0,
      inclination: 0, distance: 100, stepsPerOrbit: 120, endFraction: 0.1, maxSteps: 40000,
    })
    const shrink = res.aTrack[res.aTrack.length - 1] / res.aTrack[0]
    const pass = res.valid && Math.abs(shrink - 1) < 1e-3
    add(
      'GW vanishes in the Newtonian limit (c→∞)',
      pass,
      `a(end)/a(0) = ${shrink.toFixed(6)} (≈1 — no inspiral)`,
    )
  }

  // 33 — The transverse-traceless strain reproduces the analytic inclination
  // dependence of the quadrupole formula: for a circular binary the plus
  // polarisation amplitude scales as (1+cos²ι)/2 and the cross as cosι (relative
  // to face-on), and the cross polarisation vanishes edge-on (ι = 90°).
  {
    const g = 1, c = 2, m1 = 1, m2 = 0.8, a = 30
    const M = m1 + m2, mu = (m1 * m2) / M, gm = g * M, sp = Math.sqrt(gm / a)
    const ampOverCycle = (incl: number) => {
      let hp = 0, hx = 0
      const N = 360
      for (let k = 0; k < N; k++) {
        const th = (k / N) * 2 * Math.PI
        const px = a * Math.cos(th), py = a * Math.sin(th)
        const pvx = -sp * Math.sin(th), pvy = sp * Math.cos(th)
        const [a1, a2] = strainTT(px, py, pvx, pvy, mu, g, M, c, 100, incl)
        hp = Math.max(hp, Math.abs(a1))
        hx = Math.max(hx, Math.abs(a2))
      }
      return { hp, hx }
    }
    const face = ampOverCycle(0)
    const i60 = ampOverCycle(Math.PI / 3)
    const edge = ampOverCycle(Math.PI / 2)
    const plusOk = Math.abs(i60.hp / face.hp - (1 + 0.25) / 2) < 1e-3 // (1+cos²60)/2 = 0.625
    const crossOk = Math.abs(i60.hx / face.hx - 0.5) < 1e-3 // cos60 = 0.5
    const edgeOk = edge.hx / face.hx < 1e-6 // cross vanishes edge-on
    const pass = plusOk && crossOk && edgeOk
    add(
      'GW strain has the (1+cos²ι)/2cosι pattern',
      pass,
      `h₊(60°)/h₊(0)=${(i60.hp / face.hp).toFixed(3)} (=0.625), h×(60°)/h×(0)=${(i60.hx / face.hx).toFixed(3)} (=0.5), h×(90°)≈${(edge.hx / face.hx).toExponential(1)}`,
    )
  }

  // ----- Strong-field gravity: Schwarzschild geodesics & the black-hole shadow -----

  // 34 — The critical impact parameter b_c = 3√3 M, the apparent radius of a
  // black hole's shadow. The closed form is cross-checked against an independent
  // bisection on the ray tracer's capture/escape boundary.
  {
    const bcClosed = criticalImpactParameter(1)
    const bcNum = shadowImpactParameter(1)
    const exact = 3 * Math.sqrt(3)
    const pass = approx(bcClosed, exact, 1e-9) && approx(bcNum, exact, 2e-3)
    add(
      'Shadow: critical impact parameter b_c = 3√3 M',
      pass,
      `closed=${bcClosed.toFixed(6)}, ray-trace bisection=${bcNum.toFixed(6)} (=3√3=${exact.toFixed(6)})`,
    )
  }

  // 35 — The photon sphere r = 3M is the pole of the circular-orbit angular
  // momentum L²(r) = M r²/(r−3M), and a photon with b just under b_c is captured
  // while b just over it escapes — the shadow edge.
  {
    const big = circularAngularMomentumSq(3 + 1e-4, 1) // → ∞ as r → 3M
    const finite = circularAngularMomentumSq(10, 1)
    const bc = criticalImpactParameter(1)
    const capIn = deflectionAngle(bc * 0.999, 1).captured
    const capOut = deflectionAngle(bc * 1.001, 1).captured
    const pass = big > 1e3 && Number.isFinite(finite) && capIn && !capOut
    add(
      'Shadow: photon sphere at r = 3M (capture boundary)',
      pass,
      `L²(3M⁺)=${big.toExponential(1)} (→∞), b<b_c captured=${capIn}, b>b_c captured=${capOut}`,
    )
  }

  // 36 — The ISCO r = 6M is the minimum of L²(r): inside it no stable circular
  // orbit exists. Recover it by scanning the closed-form curve for its minimum.
  {
    let minR = 0
    let minV = Infinity
    for (let r = 3.5; r < 12; r += 0.0005) {
      const v = circularAngularMomentumSq(r, 1)
      if (v < minV) { minV = v; minR = r }
    }
    const pass = approx(minR, 6, 2e-3) && approx(minV, 12, 5e-3)
    add(
      'Innermost stable circular orbit at r = 6M',
      pass,
      `argmin L²(r) = ${minR.toFixed(4)} (=6), L²_min = ${minV.toFixed(4)} (=12 M²)`,
    )
  }

  // 37 — Light deflection in the weak field tends to Einstein's α → 4M/b. We
  // check the ratio approaches 1 as the impact parameter grows.
  {
    const a50 = deflectionAngle(50, 1).deflection
    const a200 = deflectionAngle(200, 1).deflection
    const r50 = a50 / (4 / 50)
    const r200 = a200 / (4 / 200)
    // Larger b ⇒ closer to 1, and the residual shrinks with b.
    const pass = r200 < r50 && Math.abs(r200 - 1) < 0.03
    add(
      'Light deflection → Einstein 4M/b in the weak field',
      pass,
      `α(50M)/(4M/50)=${r50.toFixed(4)}, α(200M)/(4M/200)=${r200.toFixed(4)} (→1)`,
    )
  }

  // 38 — In the strong field α(b) diverges logarithmically as b → b_c⁺, matching
  // the Bozza (2002) coefficient α ≈ −ln(b/b_c − 1) + b̄. We compare the
  // integrated deflection to that closed form very close to b_c.
  {
    const bc = criticalImpactParameter(1)
    const b = bc * (1 + 1e-4)
    const aInt = deflectionAngle(b, 1, { dPhi: 1e-4 }).deflection
    const aBozza = bozzaStrongDeflection(b, 1)
    const pass = Number.isFinite(aInt) && aInt > 2 * Math.PI && Math.abs(aInt - aBozza) < 0.02
    add(
      'Strong-field log divergence matches Bozza (2002)',
      pass,
      `α(b_c·1.0001)=${aInt.toFixed(4)} rad (>2π), Bozza=${aBozza.toFixed(4)}, Δ=${Math.abs(aInt - aBozza).toExponential(1)}`,
    )
  }

  // 39 — A near-circular timelike orbit precesses by exactly 2π(1/√(1−6M/r)−1)
  // per revolution — the strong-field generalisation of the 1PN 6πM/r. The
  // closed form is verified by integrating the orbit ODE, and shown to exceed
  // the weak-field value and tend to it far out.
  {
    const r = 30
    const measured = integrateCircularPrecession(r, 1)
    const closed = circularPrecessionPerOrbit(r, 1)
    const oneP = precessionTheory(1, r, 0, 1) // 6πM/r
    const farRatio = circularPrecessionPerOrbit(2000, 1) / precessionTheory(1, 2000, 0, 1)
    const pass =
      approx(measured / closed, 1, 2e-3) && closed > oneP && Math.abs(farRatio - 1) < 1e-2
    add(
      'Exact GR precession 2π(1/√(1−6M/r)−1) vs 1PN',
      pass,
      `integrated=${measured.toFixed(5)} vs closed=${closed.toFixed(5)} (ratio ${(measured / closed).toFixed(4)}); >1PN ${oneP.toFixed(5)}; far ratio→${farRatio.toFixed(4)}`,
    )
  }

  // 40 — The apparent angular radius of the shadow for a static observer at
  // coordinate radius D is sin θ = b_c√(1−2M/D)/D — tending to the b_c disc as
  // D → ∞. Check the relation and its large-D limit.
  {
    const D = 30
    const theta = shadowAngularRadius(D, 1)
    const bc = criticalImpactParameter(1)
    const expected = Math.asin((bc * Math.sqrt(1 - 2 / D)) / D)
    const farTheta = shadowAngularRadius(1e7, 1)
    const farApparent = Math.sin(farTheta) * 1e7 // → b_c
    const pass = approx(theta, expected, 1e-9) && approx(farApparent, bc, 1e-2)
    add(
      'Apparent shadow radius sin θ = b_c√(1−2M/D)/D',
      pass,
      `θ(30M)=${(theta * 180 / Math.PI).toFixed(3)}°; D→∞ apparent=${farApparent.toFixed(4)} (=b_c=${bc.toFixed(4)})`,
    )
  }

  // 41 — The Keplerian-disc redshift g = √(1−3M/r)/(1−Ωℓ): with no Doppler
  // (ℓ=0) it is the circular-orbit time dilation √(1−3M/r), giving exactly √½ at
  // the ISCO (r=6M); and g → 1 far from the hole.
  {
    const gIsco = diskRedshiftFactor(6, 0, 1)
    const gFar = diskRedshiftFactor(1e6, 0, 1)
    // Doppler: a co-rotating photon (ℓ>0) is blueshifted relative to ℓ<0.
    const gApproach = diskRedshiftFactor(10, 4, 1)
    const gRecede = diskRedshiftFactor(10, -4, 1)
    const pass =
      approx(gIsco, Math.SQRT1_2, 1e-9) && approx(gFar, 1, 1e-5) && gApproach > gRecede
    add(
      'Accretion-disc redshift g(6M,0) = √½, g→1, Doppler asymmetry',
      pass,
      `g(ISCO)=${gIsco.toFixed(6)} (=√½=${Math.SQRT1_2.toFixed(6)}), g(∞)=${gFar.toFixed(6)}, g₊=${gApproach.toFixed(3)}>g₋=${gRecede.toFixed(3)}`,
    )
  }

  // 42 — The Kerr shadow's vertical extent (edge-on, i=90°) is 2·3√3 M for any
  // spin, and reduces to the Schwarzschild 3√3 M circle radius as a → 0.
  {
    const k = kerrShadowRim(0.02, Math.PI / 2, 1, 600)
    const halfHeight = k.heightBeta / 2
    const exact = 3 * Math.sqrt(3)
    const pass = approx(halfHeight, exact, 5e-3)
    add(
      'Kerr shadow → 3√3 M circle as spin a → 0',
      pass,
      `edge-on half-height (a=0.02) = ${halfHeight.toFixed(4)} (=3√3=${exact.toFixed(4)})`,
    )
  }

  // 43 — Bardeen's equatorial photon-orbit radii: prograde → M, retrograde → 4M
  // as a → M; both equal 3M at a = 0. Check known values at a = 0.9.
  {
    const rPro = kerrEquatorialPhotonRadius(0.9, 1, true)
    const rRetro = kerrEquatorialPhotonRadius(0.9, 1, false)
    const rPro0 = kerrEquatorialPhotonRadius(1e-6, 1, true)
    const pass = approx(rPro, 1.5579, 2e-3) && approx(rRetro, 3.9103, 2e-3) && approx(rPro0, 3, 1e-3)
    add(
      'Kerr equatorial photon radii (Bardeen)',
      pass,
      `a=0.9: prograde=${rPro.toFixed(4)} (=1.558), retrograde=${rRetro.toFixed(4)} (=3.910); a→0: ${rPro0.toFixed(4)} (=3)`,
    )
  }

  // 44 — Frame dragging displaces and flattens the Kerr shadow: its centroid
  // shifts further from centre as spin grows (zero for a Schwarzschild hole).
  {
    const lo = kerrShadowRim(0.2, Math.PI / 2, 1, 600)
    const hi = kerrShadowRim(0.95, Math.PI / 2, 1, 600)
    const tiny = kerrShadowRim(0.02, Math.PI / 2, 1, 600)
    const pass = Math.abs(hi.centroidAlpha) > Math.abs(lo.centroidAlpha) && Math.abs(tiny.centroidAlpha) < 0.1
    add(
      'Kerr frame-dragging displaces the shadow with spin',
      pass,
      `centroid α: a=0.02→${tiny.centroidAlpha.toFixed(3)}, a=0.2→${lo.centroidAlpha.toFixed(3)}, a=0.95→${hi.centroidAlpha.toFixed(3)} M`,
    )
  }

  // 45 — Universal-variable Kepler propagator reproduces the analytic two-body
  // flow. Launch an e=0.6 ellipse from periapsis, propagate by the universal
  // solver, and compare to the position obtained by solving Kepler's equation
  // E − e·sinE = M directly. Agreement to machine precision validates the
  // Stumpff functions, the χ root-find and the Lagrange f,g coefficients.
  {
    const mu = 1
    const a = 1.7
    const e = 0.6
    const rp = a * (1 - e)
    const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e)))
    const s0: KeplerState = { r: { x: rp, y: 0 }, v: { x: 0, y: vp } }
    const T = 2 * Math.PI * Math.sqrt((a * a * a) / mu)
    const n = Math.sqrt(mu / (a * a * a))
    let worst = 0
    for (const frac of [0.13, 0.5, 0.77, 1.4]) {
      const t = frac * T
      const got = keplerStep(s0, mu, t)
      // Analytic: solve Kepler's equation, then x = a(cosE − e), y = a√(1−e²)sinE.
      let E = n * t
      for (let k = 0; k < 80; k++) {
        const dE = (E - e * Math.sin(E) - n * t) / (1 - e * Math.cos(E))
        E -= dE
        if (Math.abs(dE) < 1e-15) break
      }
      const ex = a * (Math.cos(E) - e)
      const ey = a * Math.sqrt(1 - e * e) * Math.sin(E)
      worst = Math.max(worst, Math.hypot(got.r.x - ex, got.r.y - ey))
    }
    const pass = worst < 1e-9
    add('Kepler propagator matches analytic orbit', pass, `max position error vs E−e·sinE=M: ${worst.toExponential(2)} (≈0)`)
  }

  // 46 — A Kepler step is an exact symplectic map: the Lagrange coefficients
  // satisfy f·ġ − ḟ·g = 1 identically, for ellipse, parabola-grazing and
  // hyperbola alike. This is checked independently of the propagation above.
  {
    const mu = 1
    let worst = 0
    const states: KeplerState[] = [
      { r: { x: 1.2, y: 0.3 }, v: { x: -0.2, y: 0.9 } }, // bound ellipse
      { r: { x: 0.5, y: 0 }, v: { x: 0, y: Math.sqrt(2 * mu / 0.5) } }, // ~parabolic
      { r: { x: 0.6, y: -0.1 }, v: { x: 0.4, y: 1.9 } }, // hyperbolic
    ]
    for (const s of states) for (const dt of [0.05, 1.3, 7, -3]) {
      worst = Math.max(worst, Math.abs(lagrangeIdentityResidual(s, mu, dt)))
    }
    const pass = worst < 1e-10
    add('Kepler step is exactly symplectic (f·ġ − ḟ·g = 1)', pass, `max |f·ġ − ḟ·g − 1| = ${worst.toExponential(2)}`)
  }

  // 47 — For a single planet (the pure two-body problem) Wisdom–Holman is
  // essentially EXACT: the only approximated term (the inter-planet interaction)
  // is absent, so energy holds to machine precision over ~950 orbits.
  {
    const G = 1
    const bary = toBarycentric([
      { m: 1, x: 0, y: 0, vx: 0, vy: 0 },
      { m: 1e-3, x: 1, y: 0, vx: 0, vy: Math.sqrt(G * 1.001) },
    ])
    const E0 = totalEnergy(bary, G)
    const wh = new WisdomHolman(bary, G)
    let maxErr = 0
    for (let i = 0; i < 30000; i++) {
      wh.step(0.2, 2)
      if (i % 200 === 0) maxErr = Math.max(maxErr, Math.abs((wh.energy() - E0) / E0))
    }
    const pass = maxErr < 1e-8
    add('Wisdom–Holman is exact for two bodies', pass, `max |ΔE/E| = ${maxErr.toExponential(2)} over ~950 orbits`)
  }

  // 48 — THE headline claim: on a near-Keplerian multi-planet system, at a
  // deliberately coarse step, Wisdom–Holman conserves energy orders of magnitude
  // better than velocity Verlet — and stays bounded, where the non-symplectic
  // RK4 drifts secularly. All three integrate the identical unsoftened Hamiltonian.
  {
    const p = LAB_PRESETS[0]
    const res = runComparison({
      bodies: p.build(), G: p.G, dt: 0.3, duration: 360, samples: 240,
      methods: ['wh2', 'verlet', 'rk4'],
    })
    const wh = res.traces.find((t) => t.id === 'wh2')!
    const ve = res.traces.find((t) => t.id === 'verlet')!
    const rk = res.traces.find((t) => t.id === 'rk4')!
    const ratio = ve.maxEnergyErr / Math.max(wh.maxEnergyErr, 1e-30)
    const rkEarly = Math.max(...rk.energyErr.slice(0, 15))
    const rkLate = Math.max(...rk.energyErr.slice(-15))
    const pass = wh.maxEnergyErr < ve.maxEnergyErr * 0.05 && wh.maxEnergyErr < 1e-5 && rkLate > rkEarly * 8
    add(
      'Wisdom–Holman crushes Verlet on energy',
      pass,
      `max |ΔE/E|: WH=${wh.maxEnergyErr.toExponential(2)} ≪ Verlet=${ve.maxEnergyErr.toExponential(2)} (${ratio.toFixed(0)}×); RK4 drifts ${rkEarly.toExponential(1)}→${rkLate.toExponential(1)}`,
    )
  }

  // 49 — The 4th-order Wisdom–Holman composition (a Yoshida triple-jump of the
  // 2nd-order map) is markedly more accurate than the 2nd-order map at the same Δt.
  {
    const G = 1
    const bary = toBarycentric(LAB_PRESETS[2].build())
    const E0 = totalEnergy(bary, G)
    const run = (order: 2 | 4) => {
      const wh = new WisdomHolman(bary, G)
      let m = 0
      for (let i = 0; i < 4000; i++) { wh.step(0.25, order); if (i % 25 === 0) m = Math.max(m, Math.abs((wh.energy() - E0) / E0)) }
      return m
    }
    const e2 = run(2)
    const e4 = run(4)
    const pass = e4 < e2 * 0.5
    add('Wisdom–Holman 4th order beats 2nd', pass, `max |ΔE/E|: WH2=${e2.toExponential(2)}, WH4=${e4.toExponential(2)} — ${(e2 / Math.max(e4, 1e-30)).toFixed(1)}× better`)
  }

  // 50 — The Wisdom–Holman map is time-reversible and conserves total linear and
  // angular momentum: integrate forward N steps then backward N, and the system
  // retraces to the start; meanwhile |p| stays zero in the barycentre frame.
  {
    const G = 1
    const bary = toBarycentric(LAB_PRESETS[1].build())
    const L0 = angularMomentum(bary)
    const wh = new WisdomHolman(bary, G)
    for (let i = 0; i < 600; i++) wh.step(0.3, 2)
    const mid = wh.toInertial()
    const pMag = momentumMagnitude(mid)
    const Ldrift = Math.abs((angularMomentum(mid) - L0) / L0)
    for (let i = 0; i < 600; i++) wh.step(-0.3, 2)
    const end = wh.toInertial()
    let ret = 0
    for (let i = 0; i < bary.length; i++) ret = Math.max(ret, Math.hypot(end[i].x - bary[i].x, end[i].y - bary[i].y))
    const pass = ret < 1e-7 && pMag < 1e-12 && Ldrift < 1e-10
    add(
      'Wisdom–Holman is reversible & conserves p, L',
      pass,
      `return error=${ret.toExponential(2)}, |p|=${pMag.toExponential(1)}, |ΔL/L|=${Ldrift.toExponential(1)}`,
    )
  }

  // 51 — The Resonance Atlas's analytic effective-potential gradient ∇Ω matches a
  // central finite difference of Ω (the position-force the rotating-frame solver uses).
  {
    const mu = 0.01
    const h = 1e-6
    let maxRel = 0
    for (const [x, y] of [[0.3, 0.2], [-0.4, 0.5], [0.8, -0.3]] as Array<[number, number]>) {
      const [gx, gy] = effectivePotentialGradient(x, y, mu)
      const fdx = (effectivePotential(x + h, y, mu) - effectivePotential(x - h, y, mu)) / (2 * h)
      const fdy = (effectivePotential(x, y + h, mu) - effectivePotential(x, y - h, mu)) / (2 * h)
      maxRel = Math.max(maxRel, Math.abs(gx - fdx) / (Math.abs(fdx) + 1), Math.abs(gy - fdy) / (Math.abs(fdy) + 1))
    }
    add('FMA ∇Ω matches a central finite difference', maxRel < 1e-6, `max rel error = ${maxRel.toExponential(2)}`)
  }

  // 52 — That same ∇Ω is consistent (to machine precision) with the restricted-3-body
  // module's independently-written omegaGradient — two derivations, one answer.
  {
    const mu = 0.0123
    let maxAbs = 0
    for (const [x, y] of [[0.25, 0.15], [-0.6, 0.4], [1.1, -0.2]] as Array<[number, number]>) {
      const [gx, gy] = effectivePotentialGradient(x, y, mu)
      const [ox, oy] = omegaGradient(x, y, mu)
      maxAbs = Math.max(maxAbs, Math.abs(gx - ox), Math.abs(gy - oy))
    }
    add('FMA ∇Ω agrees with restricted3body.omegaGradient', maxAbs < 1e-12, `max |Δ| = ${maxAbs.toExponential(2)}`)
  }

  // 53 — The RK4 rotating-frame integrator conserves the Jacobi constant along a
  // regular orbit (the lone integral of the restricted three-body problem).
  {
    const rec = recordOrbit(0.6, 0.05, 0.001, { samples: 256, periods: 30, minSub: 10 })
    add(
      'FMA RK4 integrator conserves the Jacobi constant',
      rec.valid && rec.jacobiDrift < 1e-6,
      `relative Jacobi drift over 30 orbits = ${rec.jacobiDrift.toExponential(2)}`,
    )
  }

  // 54 — The Kepler frequency law recovered end-to-end (IC construction + RK4 +
  // rotating→inertial map + NAFF): the measured mean motion of a near-Keplerian
  // orbit (μ→0) is n = a^{-3/2}.
  {
    let maxRel = 0
    for (const [a, e] of [[0.6, 0.0], [0.7, 0.05], [0.5, 0.1]] as Array<[number, number]>) {
      const c = computeCell(a, e, 1e-6, { samples: 256, periods: 30, minSub: 10 })
      const nExp = Math.pow(a, -1.5)
      maxRel = Math.max(maxRel, Math.abs(c.freq - nExp) / nExp)
    }
    add('FMA recovers the Kepler frequency law n = a^{-3/2}', maxRel < 1e-3, `max rel error vs a^{-3/2} = ${maxRel.toExponential(2)}`)
  }

  // 55 — Frequency-map diffusion separates a regular orbit from a chaotic one by
  // many decades — the whole point of the Atlas. A near-circular orbit away from
  // resonance is regular; a resonant eccentric orbit under a heavy perturber is chaotic.
  {
    const reg = computeCell(0.54, 0.0, 0.01, { samples: 256, periods: 30, minSub: 10 })
    const cha = computeCell(0.72, 0.3, 0.01, { samples: 256, periods: 30, minSub: 10 })
    const sep = cha.logDiffusion - reg.logDiffusion
    const pass = reg.valid && cha.valid && reg.logDiffusion < -4 && cha.logDiffusion > -2.5 && sep > 3
    add(
      'FMA diffusion separates regular from chaotic',
      pass,
      `regular log|Δn/n|=${reg.logDiffusion.toFixed(2)} vs chaotic ${cha.logDiffusion.toFixed(2)} — ${sep.toFixed(1)} decades apart`,
    )
  }

  // 56 — The time-frequency spectrogram's NAFF ridge is dead-flat for a pure tone
  // and tracks a linear chirp upward — frequency drift made visible.
  {
    const N = 2048
    const dt = 0.05
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    const w0 = 1.3
    for (let k = 0; k < N; k++) { const t = k * dt; re[k] = Math.cos(w0 * t); im[k] = Math.sin(w0 * t) }
    const tone = spectrogram(re, im, dt, { window: 256, hop: 64 })
    let rmin = Infinity
    let rmax = -Infinity
    for (let c = 0; c < tone.cols; c++) { const f = tone.ridge[c]; if (Number.isFinite(f)) { rmin = Math.min(rmin, f); rmax = Math.max(rmax, f) } }
    const toneFlat = tone.valid && rmax - rmin < 1e-3 && Math.abs(0.5 * (rmin + rmax) - w0) < 1e-2

    const re2 = new Float64Array(N)
    const im2 = new Float64Array(N)
    const alpha = 0.0009
    let ph = 0
    for (let k = 0; k < N; k++) { ph += (0.8 + alpha * k * dt) * dt; re2[k] = Math.cos(ph); im2[k] = Math.sin(ph) }
    const chirp = spectrogram(re2, im2, dt, { window: 256, hop: 64 })
    let first = NaN
    let last = NaN
    for (let c = 0; c < chirp.cols; c++) if (Number.isFinite(chirp.ridge[c])) { first = chirp.ridge[c]; break }
    for (let c = chirp.cols - 1; c >= 0; c--) if (Number.isFinite(chirp.ridge[c])) { last = chirp.ridge[c]; break }
    const rising = last - first > 0.05

    add(
      'Spectrogram ridge: flat for a tone, rising for a chirp',
      toneFlat && rising,
      `tone ridge spread=${(rmax - rmin).toExponential(1)}; chirp ridge ${first.toFixed(3)}→${last.toFixed(3)} (+${(last - first).toFixed(3)})`,
    )
  }

  // 57 — The 1-D frequency map (Laskar's cross-section): at small μ the measured
  // mean motion n(a) is a strictly decreasing staircase matching the Kepler law
  // n = a^{-3/2} — the resonance-plateau backbone the diffusion spikes sit on.
  {
    const model: AtlasModel = { id: 't', name: 't', blurb: '', mu: 1e-6, aMin: 0.45, aMax: 0.75, eMin: 0, eMax: 0.5 }
    const pts = frequencyProfile(model, 0.0, 24, { samples: 256, periods: 30, minSub: 10 })
    let mono = true
    let maxRel = 0
    let prev = Infinity
    let nValid = 0
    for (const p of pts) {
      if (!p.valid) continue
      nValid++
      const exp = Math.pow(p.a, -1.5)
      maxRel = Math.max(maxRel, Math.abs(p.freq - exp) / exp)
      if (p.freq > prev + 1e-9) mono = false
      prev = p.freq
    }
    add(
      'FMA 1-D frequency map is the Kepler staircase n = a^{-3/2}',
      nValid === pts.length && mono && maxRel < 1e-3,
      `${nValid}/${pts.length} valid, monotone=${mono}, max rel error = ${maxRel.toExponential(2)}`,
    )
  }

  // ── Kerr: the spinning black hole, ray-traced (Helios 9.0) ────────────────

  // 58 — The contravariant Kerr metric is the genuine inverse of the covariant
  // one: gᵘᵛ g_νσ = δᵘ_σ on the (t,φ) block and the r,θ diagonal.
  {
    const r = 8
    const th = 1.1
    const a = 0.7
    const co = kerrMetricCo(r, th, a)
    const ct = kerrMetricContra(r, th, a)
    const Itt = ct.gtt * co.gtt + ct.gtp * co.gtp
    const Itp = ct.gtt * co.gtp + ct.gtp * co.gpp
    const Ipt = ct.gtp * co.gtt + ct.gpp * co.gtp
    const Ipp = ct.gtp * co.gtp + ct.gpp * co.gpp
    const Irr = ct.grr * co.grr
    const Ith = ct.gthth * co.gthth
    const err = Math.max(
      Math.abs(Itt - 1),
      Math.abs(Ipp - 1),
      Math.abs(Itp),
      Math.abs(Ipt),
      Math.abs(Irr - 1),
      Math.abs(Ith - 1),
    )
    add('Kerr contravariant metric is the exact inverse (gᵘᵛg_νσ=δ)', err < 1e-9, `max |gᵘᵛg_νσ − δ| = ${err.toExponential(2)}`)
  }

  // 59 — The null condition H = ½ gᵘᵛpᵤpᵥ = 0 is preserved along an integrated
  // geodesic, and 60 — Carter's hidden constant Q stays constant. We launch a
  // fly-by photon (large impact parameter) and adaptively step it past the hole.
  {
    const a = 0.8
    const M = 1
    const ray = initRay(7.0, 4.0, 40, Math.PI * 0.45, a, M)
    const st = ray.state
    const { pt, pphi } = ray
    const E = -pt
    const Lz = pphi
    const tmp = new Float64Array(5)
    const q0 = carterConstant(st.theta, st.pth, Lz, E, a)
    let maxH = 0
    let maxdQ = 0
    let plunged = false
    for (let i = 0; i < 20000; i++) {
      geodesicRHS(st, pt, pphi, a, M, tmp)
      const rate = Math.abs(tmp[0]) / Math.max(1, st.r) + Math.abs(tmp[1]) + Math.abs(tmp[2]) + 1e-3
      const dλ = Math.min(2.0, Math.max(2e-3, 0.05 / rate))
      rk4Step(st, pt, pphi, a, M, dλ)
      if (st.r < kerrHorizonRadius(a) * 1.05) {
        plunged = true
        break
      }
      if (st.r > 80 && tmp[0] > 0) break
      maxH = Math.max(maxH, Math.abs(0.5 * hamiltonian2(st.r, st.theta, pt, st.pr, st.pth, pphi, a, M)))
      maxdQ = Math.max(maxdQ, Math.abs((carterConstant(st.theta, st.pth, Lz, E, a) - q0) / q0))
    }
    add('Kerr null condition H≈0 holds along the integrated geodesic', !plunged && maxH < 1e-6, `max |H| = ${maxH.toExponential(2)}`)
    add("Carter's constant Q is conserved along the geodesic", !plunged && maxdQ < 1e-5, `max |ΔQ/Q| = ${maxdQ.toExponential(2)}`)
  }

  // 61 — As the spin vanishes the ray-traced shadow collapses onto the
  // Schwarzschild circle: both β = 0 edges → b_c = 3√3 M.
  {
    const bc = 3 * Math.sqrt(3)
    const eP = kerrShadowAlphaAtBeta0(1e-4, Math.PI / 2, 1)
    const eM = kerrShadowAlphaAtBeta0(1e-4, Math.PI / 2, -1)
    add(
      'Kerr shadow → Schwarzschild b_c = 3√3 M as a → 0',
      Math.abs(Math.abs(eP) - bc) < 0.02 && Math.abs(Math.abs(eM) - bc) < 0.02,
      `traced edges ±(${Math.abs(eP).toFixed(3)}, ${Math.abs(eM).toFixed(3)}) vs ${bc.toFixed(3)}`,
    )
  }

  // 62 — The integrated shadow lands exactly on the analytic Bardeen/Teo rim, and
  // 63 — frame dragging makes it asymmetric (the famous D-shape). At i = π/2 the
  // β = 0 edges are α = −ξ(r) at the prograde / retrograde equatorial photon
  // orbits; the bisected ray tracer must reproduce both.
  {
    const a = 0.9
    const i = Math.PI / 2
    const eP = kerrShadowAlphaAtBeta0(a, i, 1)
    const eM = kerrShadowAlphaAtBeta0(a, i, -1)
    const xi = (r: number) => (r * r * (3 - r) - a * a * (r + 1)) / (a * (r - 1))
    const rPro = 2 * (1 + Math.cos((2 / 3) * Math.acos(-a)))
    const rRetro = 2 * (1 + Math.cos((2 / 3) * Math.acos(a)))
    const aPro = -xi(rPro) // the negative-α edge
    const aRetro = -xi(rRetro) // the positive-α edge
    const match = Math.abs(eP - aRetro) < 0.03 && Math.abs(eM - aPro) < 0.03
    add(
      'Integrated Kerr shadow matches the analytic Bardeen rim (a=0.9, i=90°)',
      match,
      `traced (+${eP.toFixed(3)}, ${eM.toFixed(3)}) vs analytic (+${aRetro.toFixed(3)}, ${aPro.toFixed(3)})`,
    )
    // The shadow is displaced toward +α (the retrograde side reaches farther out).
    const centroid = 0.5 * (eP + eM)
    add(
      'Frame dragging displaces the shadow (D-shape, not a disc)',
      centroid > 0.5 && Math.abs(eP) > Math.abs(eM),
      `centroid α = ${centroid.toFixed(3)} M > 0 (retro edge ${eP.toFixed(2)} vs pro ${eM.toFixed(2)})`,
    )
  }

  // 64 — The Bardeen ISCO closed form: 6M at a = 0; M (prograde) and 9M
  // (retrograde) at the extremal a = M.
  {
    const i0 = kerrIscoRadius(0, 1, true)
    const iPro = kerrIscoRadius(1, 1, true)
    const iRetro = kerrIscoRadius(1, 1, false)
    add(
      'Kerr ISCO: 6M (a=0), M / 9M (a=M, pro/retro)',
      approx(i0, 6, 1e-6) && approx(iPro, 1, 1e-6) && approx(iRetro, 9, 1e-6),
      `r_ISCO = ${i0.toFixed(3)} | ${iPro.toFixed(3)} | ${iRetro.toFixed(3)} M`,
    )
  }

  // 65 — The Kerr disc-redshift factor reduces to geodesic.ts's Schwarzschild
  // g = √(1−3M/r)/(1−Ωℓ) as the spin vanishes.
  {
    let maxd = 0
    for (const r of [7, 10, 15, 25]) {
      for (const xi of [-4, -2, 0, 2, 4]) {
        const gk = diskRedshiftKerr(r, xi, 1e-7, 1)
        const gs = diskRedshiftFactor(r, xi, 1)
        maxd = Math.max(maxd, Math.abs(gk - gs))
      }
    }
    add('Kerr disc redshift → Schwarzschild √(1−3M/r)/(1−Ωℓ) as a → 0', maxd < 1e-6, `max |g_Kerr − g_Schw| = ${maxd.toExponential(2)}`)
  }

  // 66 — Horizon & ergosphere structure: r₊ is real for |a| ≤ M, the ergosphere
  // encloses the horizon (= 2M at the equator), and Ω_H = a/(r₊²+a²).
  {
    const a = 0.9
    const rp = kerrHorizonRadius(a)
    const ergoEq = kerrErgosphere(Math.PI / 2, a)
    const omH = kerrHorizonOmega(a)
    const omHref = a / (rp * rp + a * a)
    add(
      'Kerr horizon/ergosphere/Ω_H structure',
      approx(rp, 1 + Math.sqrt(1 - 0.81), 1e-12) && approx(ergoEq, 2, 1e-12) && ergoEq >= rp && approx(omH, omHref, 1e-12),
      `r₊=${rp.toFixed(3)}, r_E(eq)=${ergoEq.toFixed(3)}, Ω_H=${omH.toFixed(4)}`,
    )
  }

  // ---- the Three-Body Chaos Atlas (the Agekyan–Anosova free-fall map) --------

  // 67 — Three equal masses released from rest have ZERO total angular momentum
  // (and it is conserved exactly, the planar central-force invariant). This is the
  // exact symmetry the at-rest map is built on.
  {
    const L = angularMomentum3(anosovaState(0.3, 0.4))
    add('Free-fall triple: total angular momentum is exactly zero', approx(L, 0, 1e-15), `L = ${L.toExponential(2)}`)
  }

  // 68 — The 4th-order Hermite integrator conserves energy across a violent
  // chaotic scattering (dozens of close passages) to a part in ~10⁴ — the honest
  // proof that the map's outcomes are physical, not numerical noise.
  {
    const r = scatterThreeBody(anosovaState(0.3, 0.4), TB_OPTS)
    add(
      'Hermite conserves energy through a chaotic scattering',
      r.energyError < 1e-4 && r.outcome === 'escape',
      `max |ΔE/E| = ${r.energyError.toExponential(2)} over ${r.steps} steps, ${r.interplays} interplays → ${r.outcome}`,
    )
  }

  // 69 — The map is DETERMINISTIC: the same release triangle always yields the same
  // outcome (the prerequisite for a fractal — sensitivity, not randomness).
  {
    const a = scatterThreeBody(anosovaState(0.31, 0.27), TB_MAP_OPTS)
    const b = scatterThreeBody(anosovaState(0.31, 0.27), TB_MAP_OPTS)
    add(
      'Agekyan–Anosova map is deterministic',
      a.outcome === b.outcome && a.escaper === b.escaper && a.tEscape === b.tEscape,
      `(${a.outcome}, escaper ${a.escaper}, t=${a.tEscape.toFixed(3)}) reproduced exactly`,
    )
  }

  // 70 — An isosceles release (third body on the perpendicular bisector) keeps its
  // mirror symmetry to machine precision forever — body 3 never leaves the axis.
  {
    const tr = recordThreeBody(anosovaState(0, 0.45), 400, TB_MAP_OPTS)
    let maxX = 0
    for (let k = 0; k < tr.px[2].length; k++) maxX = Math.max(maxX, Math.abs(tr.px[2][k]))
    add('Isosceles release stays mirror-symmetric', maxX < 1e-8, `max |x₃| = ${maxX.toExponential(2)}`)
  }

  // 71 — A perfect equilateral release collapses HOMOTHETICALLY: all three pairwise
  // distances stay equal (the Lagrange central configuration) on the way down.
  {
    const tr = recordThreeBody(anosovaState(0, Math.sqrt(3) / 2), 3000, { ...TB_MAP_OPTS, softening: 0.01, tMax: 5 })
    let dev = 0, n = 0
    for (let k = 0; k < tr.sep[0].length; k++) {
      const a = tr.sep[0][k], b = tr.sep[1][k], c = tr.sep[2][k]
      const mn = Math.min(a, b, c)
      if (mn < 0.5) break
      dev = Math.max(dev, (Math.max(a, b, c) - mn) / Math.max(a, b, c))
      n++
    }
    add('Equilateral release collapses homothetically', dev < 1e-9 && n > 5, `max shape deviation = ${dev.toExponential(2)} over ${n} samples`)
  }

  // 72 — The region-D mask is correct: inside the unit circle about m₁ counts,
  // outside does not.
  {
    add('Agekyan–Anosova region D mask', inRegionD(0.2, 0.3) && !inRegionD(0.45, 0.85), 'inside ✓ / outside ✓')
  }

  // ---- Fast Multipole Method (fmm.ts) -------------------------------------
  // A deterministic random plummer-ish blob, reused across the FMM cases.
  const fmmSystem = (n: number, seed: number) => {
    let s = seed >>> 0
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff)
    const posX = new Float64Array(n)
    const posY = new Float64Array(n)
    const mass = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      // Two overlapping clusters, so the tree is genuinely adaptive.
      const off = i < n / 2 ? -60 : 60
      posX[i] = off + (rng() - 0.5) * 160
      posY[i] = (rng() - 0.5) * 160
      mass[i] = 0.4 + rng() * 2
    }
    return { posX, posY, mass }
  }

  // 73 — The kernel's Taylor coefficients (the heart of every cell-to-cell
  // transfer) reproduce the true derivatives of 1/√(r²+ε²). Checked against
  // finite differences up to third order, where the stencil is still clean.
  {
    const eps2 = 0.7
    const rx = 1.3
    const ry = -0.8
    const p = 3
    const a = kernelTaylor(rx, ry, eps2, p)
    const G = (x: number, y: number) => 1 / Math.sqrt(x * x + y * y + eps2)
    const h = 1e-3
    const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1))
    type F2 = (x: number, y: number) => number
    // Build the (i,j)-th derivative by nested central differences in x then y.
    const ddx = (g: F2, ord: number): F2 => (ord === 0 ? g : ((gp) => (x: number, y: number) => (gp(x + h, y) - gp(x - h, y)) / (2 * h))(ddx(g, ord - 1)))
    const ddy = (g: F2, ord: number): F2 => (ord === 0 ? g : ((gp) => (x: number, y: number) => (gp(x, y + h) - gp(x, y - h)) / (2 * h))(ddy(g, ord - 1)))
    const finiteDiff = (i: number, j: number) => ddy(ddx(G, i), j)(rx, ry)
    let worst = 0
    for (let d = 0; d <= p; d++) {
      for (let i = 0; i <= d; i++) {
        const j = d - i
        const raw = a[(d * (d + 1)) / 2 + i] * fact(i) * fact(j)
        const fd = finiteDiff(i, j)
        worst = Math.max(worst, Math.abs(raw - fd) / (Math.abs(fd) + 1e-9))
      }
    }
    add('FMM — kernel Taylor recurrence vs finite differences', worst < 5e-3, `worst relative error = ${worst.toExponential(2)} (≤ 5e-3)`)
  }

  // 74 — The whole O(N) solve reproduces the O(N²) direct sum it accelerates.
  // At order 6 / θ=0.35 the worst body is within ~1e-3 of the exact force.
  {
    const n = 900
    const eps2 = 4
    const g = 1
    const { posX, posY, mass } = fmmSystem(n, 7)
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)
    const dx = new Float64Array(n)
    const dy = new Float64Array(n)
    fmmAccel(n, posX, posY, mass, { order: 6, theta: 0.35, eps2, g, ncrit: 16 }, fx, fy)
    directAccel(n, posX, posY, mass, eps2, g, dx, dy)
    const e = forceError(n, fx, fy, dx, dy)
    add('FMM — O(N) force matches direct O(N²) sum', e.max < 5e-3 && e.rms < 5e-4, `max rel err = ${e.max.toExponential(2)}, rms = ${e.rms.toExponential(2)}`)
  }

  // 75 — Spectral convergence: raising the expansion order strictly sharpens the
  // approximation. Order 6 must beat order 2 by orders of magnitude.
  {
    const n = 700
    const eps2 = 4
    const g = 1
    const { posX, posY, mass } = fmmSystem(n, 99)
    const dx = new Float64Array(n)
    const dy = new Float64Array(n)
    directAccel(n, posX, posY, mass, eps2, g, dx, dy)
    const errAt = (p: number) => {
      const fx = new Float64Array(n)
      const fy = new Float64Array(n)
      fmmAccel(n, posX, posY, mass, { order: p, theta: 0.4, eps2, g, ncrit: 16 }, fx, fy)
      return forceError(n, fx, fy, dx, dy).rms
    }
    const e2 = errAt(2)
    const e6 = errAt(6)
    add('FMM — error falls geometrically with order', e6 < e2 / 30, `rms: p2 = ${e2.toExponential(2)} → p6 = ${e6.toExponential(2)} (${(e2 / e6).toFixed(0)}× sharper)`)
  }

  // 76 — Momentum is (almost) conserved: Σ mᵢ aᵢ vanishes to the expansion
  // error, even though the FMM never forms forces symmetrically.
  {
    const n = 800
    const eps2 = 4
    const g = 1
    const { posX, posY, mass } = fmmSystem(n, 31)
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)
    fmmAccel(n, posX, posY, mass, { order: 6, theta: 0.35, eps2, g, ncrit: 16 }, fx, fy)
    let mx = 0
    let my = 0
    let scale = 0
    for (let i = 0; i < n; i++) {
      mx += mass[i] * fx[i]
      my += mass[i] * fy[i]
      scale += Math.abs(mass[i]) * Math.hypot(fx[i], fy[i])
    }
    const rel = Math.hypot(mx, my) / scale
    add('FMM — conserves total momentum (Σ mᵢ aᵢ ≈ 0)', rel < 1e-4, `|Σ m a| / Σ|m a| = ${rel.toExponential(2)}`)
  }

  // 77 — It really is sub-quadratic: the actual cell-to-cell + near-field work
  // is a small fraction of the N² a direct sum would pay.
  {
    const n = 4000
    const eps2 = 4
    const g = 1
    const { posX, posY, mass } = fmmSystem(n, 5)
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)
    const stats = fmmAccel(n, posX, posY, mass, { order: 4, theta: 0.5, eps2, g, ncrit: 32 }, fx, fy)
    const work = stats.m2l + stats.p2p
    const ratio = work / (n * n)
    add('FMM — interaction work is sub-quadratic', ratio < 0.25, `(M2L + P2P) / N² = ${(ratio * 100).toFixed(1)}% of the direct sum (N=${n})`)
  }

  // 78 — Driving the *live* integrator with the FMM solver conserves energy just
  // as the Barnes–Hut backend does: the FMM is a genuine physics engine, not only
  // a one-shot force probe. Same warm blob, same symplectic integrator, both
  // backends — the FMM's energy drift tracks Barnes–Hut's to within a small factor.
  {
    const n = 300
    let s = 2024 >>> 0
    const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff)
    const posX = new Float64Array(n)
    const posY = new Float64Array(n)
    const velX = new Float64Array(n)
    const velY = new Float64Array(n)
    const mass = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const r = 30 * Math.sqrt(rng())
      const th = rng() * 2 * Math.PI
      posX[i] = r * Math.cos(th)
      posY[i] = r * Math.sin(th)
      velX[i] = (rng() - 0.5) * 0.6
      velY[i] = (rng() - 0.5) * 0.6
      mass[i] = 1
    }
    const makeSim = (solver: 'barnes-hut' | 'fmm') => {
      const sim = new Simulation(512)
      sim.setBodies(n, posX, posY, velX, velY, mass)
      sim.params = { ...sim.params, g: 1, softening: 4, theta: 0.4, forceSolver: solver, fmmOrder: 6 }
      return sim
    }
    const bhDrift = maxEnergyDrift(makeSim('barnes-hut'), 'velocity-verlet', 0.02, 300)
    const fmmDrift = maxEnergyDrift(makeSim('fmm'), 'velocity-verlet', 0.02, 300)
    const ok = Number.isFinite(fmmDrift) && fmmDrift < 5e-3 && fmmDrift < bhDrift * 5 + 1e-4
    add('FMM — live solver conserves energy like Barnes–Hut', ok, `drift: FMM = ${fmmDrift.toExponential(2)}, Barnes–Hut = ${bhDrift.toExponential(2)} (300 steps)`)
  }

  const passed = cases.filter((c) => c.pass).length
  return { cases, passed, total: cases.length, ok: passed === cases.length }
}
