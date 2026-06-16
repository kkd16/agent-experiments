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
import { jacobiConstant, omegaGradient, solveLagrangeNormalized } from './restricted3body'
import { accelAndVariational, analyzeChaos } from './chaos'
import { fft, ifft } from './fft'
import { naff, frequencyDiffusion } from './naff'
import { poincareSection, toRotating } from './poincare'
import { measurePrecession, precessionTheory, mercuryArcsecPerCentury } from './relativity'
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

  const passed = cases.filter((c) => c.pass).length
  return { cases, passed, total: cases.length, ok: passed === cases.length }
}
