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
import { orbitElements } from './orbit'
import { omegaGradient, solveLagrangeNormalized } from './restricted3body'
import type { IntegratorId } from './types'

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

  const passed = cases.filter((c) => c.pass).length
  return { cases, passed, total: cases.length, ok: passed === cases.length }
}
