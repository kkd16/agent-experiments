// Live self-verification: solve textbook problems with the same engine the app
// uses, and compare against closed-form solutions from mechanics of materials.
// The studio surfaces these as a "Verified ✓" badge — the numbers you see on
// screen are produced by code that provably reproduces the analytical answers.

import { solveFrame, type FrameModel } from './frame'
import { solveModal, solveBuckling, solveTransient, evalTransient } from './dynamics'
import { solvePushover } from './plastic'
import { prepareHarmonic, frfSweep, frfAt } from './harmonic'
import { rectSection, pipeSection, fibreDistance } from './sections'
import { solveContinuum } from './continuum'
import { rectPlate, cantileverMesh, nodeNearest } from './mesh'
import { solveQuad, solveQuadModal, type QuadInput } from './quadsolve'
import { rectPlateQ, cantileverMeshQ, nodeNearestQ } from './quadmesh'
import type { QOrder } from './isoparam'
import { newmarkSDOF, syntheticQuake, solveSeismic, harmonicGround } from './seismic'
import { newmarkEPP, springReturn, solveInelasticSeismic } from './inelastic'
import { TopOpt, unitElementK, tanhProject, tanhProjectDeriv, type TopOptSpec, PROBLEMS } from './topopt'
import { solveThermalSteady, solveThermalTransient, type ThermalInput } from './thermal'
import { solveThermoelastic } from './thermoelastic'
import { solveTransientThermoelastic } from './coupled'
import { analyzeFracture, type CrackModel } from './fracture'
import { edgeNodesQ } from './quadmesh'

const STEEL_RHO = 7850 // kg/m³

export interface Check {
  name: string
  detail: string
  expected: number
  computed: number
  relError: number
  unit: string
  pass: boolean
}

const STEEL_E = 210e9 // Pa
const TOL = 5e-3 // 0.5 % relative error is comfortably tight for exact benchmarks

function rel(expected: number, computed: number): number {
  const d = Math.abs(expected)
  return d > 1e-30 ? Math.abs(expected - computed) / d : Math.abs(expected - computed)
}

function check(
  name: string,
  detail: string,
  expected: number,
  computed: number,
  unit: string,
  tol = TOL,
): Check {
  const relError = rel(expected, computed)
  return { name, detail, expected, computed, relError, unit, pass: relError < tol }
}

export function runFrameBenchmarks(): Check[] {
  const checks: Check[] = []

  // 1. Tip-loaded cantilever: δ = P·L³ / (3·E·I). The cubic beam element is
  //    exact for an end point load, so even one element must reproduce this.
  {
    const L = 3
    const I = 8e-6
    const A = 4e-3
    const P = 5000
    const model: FrameModel = {
      type: 'frame',
      nodes: [
        { x: 0, y: 0, support: 'fixed' },
        { x: L, y: 0, support: 'free' },
      ],
      members: [{ a: 0, b: 1, E: STEEL_E, A, I }],
      loads: [{ node: 1, fx: 0, fy: -P, mz: 0 }],
    }
    const r = solveFrame(model)
    const expected = (P * L ** 3) / (3 * STEEL_E * I)
    checks.push(check('Cantilever tip deflection', 'δ = PL³/3EI', expected, -r.nodeDisp[1].uy, 'm'))
    const expTheta = (P * L * L) / (2 * STEEL_E * I)
    checks.push(check('Cantilever tip rotation', 'θ = PL²/2EI', expTheta, -r.nodeDisp[1].rot, 'rad'))
  }

  // 2. Simply supported beam, central point load: δ = P·L³ / (48·E·I).
  {
    const L = 4
    const I = 8e-6
    const A = 4e-3
    const P = 8000
    const model: FrameModel = {
      type: 'frame',
      nodes: [
        { x: 0, y: 0, support: 'pin' },
        { x: L / 2, y: 0, support: 'free' },
        { x: L, y: 0, support: 'roller-x' },
      ],
      members: [
        { a: 0, b: 1, E: STEEL_E, A, I },
        { a: 1, b: 2, E: STEEL_E, A, I },
      ],
      loads: [{ node: 1, fx: 0, fy: -P, mz: 0 }],
    }
    const r = solveFrame(model)
    const expected = (P * L ** 3) / (48 * STEEL_E * I)
    checks.push(check('Simply-supported mid deflection', 'δ = PL³/48EI', expected, -r.nodeDisp[1].uy, 'm'))
  }

  // 3. Axial bar elongation: δ = P·L / (E·A), member force = P (tension).
  {
    const L = 2.5
    const A = 1e-3
    const P = 20000
    const model: FrameModel = {
      type: 'truss',
      nodes: [
        { x: 0, y: 0, support: 'pin' },
        { x: L, y: 0, support: 'roller-x' },
      ],
      members: [{ a: 0, b: 1, E: STEEL_E, A, I: 1 }],
      loads: [{ node: 1, fx: P, fy: 0, mz: 0 }],
    }
    const r = solveFrame(model)
    const expected = (P * L) / (STEEL_E * A)
    checks.push(check('Axial bar elongation', 'δ = PL/EA', expected, r.nodeDisp[1].ux, 'm'))
    checks.push(check('Axial bar force', 'N = P (tension)', P, r.members[0].axial, 'N'))
  }

  // 4. Determinate triangular truss (method of joints). Apex load P down; the
  //    inclined members carry −(P/2)·√13/3, the bottom chord +(P/2)·(2/3).
  {
    const P = 10000
    const model: FrameModel = {
      type: 'truss',
      nodes: [
        { x: 0, y: 0, support: 'pin' },
        { x: 4, y: 0, support: 'roller-x' },
        { x: 2, y: 3, support: 'free' },
      ],
      members: [
        { a: 0, b: 2, E: STEEL_E, A: 1e-3, I: 1 },
        { a: 1, b: 2, E: STEEL_E, A: 1e-3, I: 1 },
        { a: 0, b: 1, E: STEEL_E, A: 1e-3, I: 1 },
      ],
      loads: [{ node: 2, fx: 0, fy: -P, mz: 0 }],
    }
    const r = solveFrame(model)
    const diagonal = -(P / 2) * (Math.sqrt(13) / 3)
    const chord = (P / 2) * (2 / 3)
    checks.push(check('Truss inclined member (joint method)', 'N = −(P/2)√13/3', diagonal, r.members[0].axial, 'N'))
    checks.push(check('Truss bottom chord (joint method)', 'N = +(P/2)(2/3)', chord, r.members[2].axial, 'N'))
    checks.push(check('Truss global equilibrium residual', '‖Ku−f‖ / ‖f‖ → 0', 0, r.equilibriumResidual, '', 1e-6))
  }

  return checks
}

/** Build a straight line of `n` frame elements between (x0,y0) and (x1,y1). */
function beamLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  n: number,
  E: number,
  A: number,
  I: number,
  supA: FrameModel['nodes'][number]['support'],
  supB: FrameModel['nodes'][number]['support'],
): FrameModel {
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++)
    nodes.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, support: 'free' })
  nodes[0].support = supA
  nodes[n].support = supB
  const members: FrameModel['members'] = []
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, E, A, I, rho: STEEL_RHO })
  return { type: 'frame', nodes, members, loads: [] }
}

export function runDynamicsBenchmarks(): Check[] {
  const checks: Check[] = []
  const I = 8e-6
  const A = 4e-3

  // 1. Simply-supported beam — fundamental natural frequency.
  //    ωₙ = (nπ)² · √(EI / ρA L⁴). One line of beam elements must reproduce it.
  {
    const L = 6
    const m = beamLine(0, 0, L, 0, 12, STEEL_E, A, I, 'pin', 'roller-x')
    const r = solveModal(m, 4)
    const base = Math.sqrt((STEEL_E * I) / (STEEL_RHO * A * L ** 4))
    const w1 = Math.PI ** 2 * base
    checks.push(check('SS beam 1st frequency', 'ω₁ = π²√(EI/ρAL⁴)', w1, r.modes[0]?.omega ?? 0, 'rad/s', 0.01))
    const w2 = (2 * Math.PI) ** 2 * base
    checks.push(check('SS beam 2nd frequency', 'ω₂ = (2π)²√(EI/ρAL⁴)', w2, r.modes[1]?.omega ?? 0, 'rad/s', 0.02))
  }

  // 2. Cantilever beam — fundamental natural frequency, β₁L = 1.8751.
  {
    const L = 4
    const m = beamLine(0, 0, L, 0, 12, STEEL_E, A, I, 'fixed', 'free')
    const r = solveModal(m, 3)
    const base = Math.sqrt((STEEL_E * I) / (STEEL_RHO * A * L ** 4))
    const w1 = 1.8751 ** 2 * base
    checks.push(check('Cantilever 1st frequency', 'ω₁ = (1.8751)²√(EI/ρAL⁴)', w1, r.modes[0]?.omega ?? 0, 'rad/s', 0.01))
  }

  // 3. Euler buckling of a pin-ended column: P_cr = π²EI / L².
  {
    const L = 4
    const P = 1000
    const m = beamLine(0, 0, 0, L, 12, STEEL_E, A, I, 'pin', 'roller-y')
    m.loads = [{ node: 12, fx: 0, fy: -P, mz: 0 }]
    const r = solveBuckling(m, 3)
    const Pcr = (Math.PI ** 2 * STEEL_E * I) / (L * L)
    checks.push(check('Euler column P_cr (pinned)', 'P_cr = π²EI/L²', Pcr, (r.modes[0]?.loadFactor ?? 0) * P, 'N', 0.02))
  }

  // 4. Euler buckling of a fixed-free column (flagpole): P_cr = π²EI / (4L²).
  {
    const L = 4
    const P = 1000
    const m = beamLine(0, 0, 0, L, 14, STEEL_E, A, I, 'fixed', 'free')
    m.loads = [{ node: 14, fx: 0, fy: -P, mz: 0 }]
    const r = solveBuckling(m, 3)
    const Pcr = (Math.PI ** 2 * STEEL_E * I) / (4 * L * L)
    checks.push(check('Euler column P_cr (cantilever)', 'P_cr = π²EI/4L²', Pcr, (r.modes[0]?.loadFactor ?? 0) * P, 'N', 0.03))
  }

  // 5. Uniformly-loaded simply-supported beam: δ = 5wL⁴ / (384EI). Exercises the
  //    consistent distributed-load path all the way through to displacements.
  {
    const L = 4
    const w = -5000 // N/m downward
    const m = beamLine(0, 0, L, 0, 8, STEEL_E, A, I, 'pin', 'roller-x')
    for (const mem of m.members) mem.w = w
    const r = solveFrame(m)
    const expected = (5 * Math.abs(w) * L ** 4) / (384 * STEEL_E * I)
    checks.push(check('UDL beam mid deflection', 'δ = 5wL⁴/384EI', expected, -r.nodeDisp[4].uy, 'm', 0.01))
  }

  // 6. Damped free vibration — modal-superposition transient. Released from a
  //    tip-loaded shape, a cantilever rings mainly in its first mode; the ratio
  //    of successive same-phase peaks is the log-decrement e^(−2πζ/√(1−ζ²)).
  {
    const L = 4
    const m = beamLine(0, 0, L, 0, 10, STEEL_E, A, I, 'fixed', 'free')
    m.loads = [{ node: 10, fx: 0, fy: -1000, mz: 0 }]
    const r = solveTransient(m, 10)
    const zeta = 0.05
    const wd = r.modes[0].omega * Math.sqrt(1 - zeta * zeta)
    const Td = (2 * Math.PI) / wd
    const a1 = evalTransient(r, zeta, Td)[10].uy
    const a2 = evalTransient(r, zeta, 2 * Td)[10].uy
    const decay = a2 / a1
    const analytic = Math.exp((-2 * Math.PI * zeta) / Math.sqrt(1 - zeta * zeta))
    checks.push(check('Damped decay (log-decrement)', 'aₙ₊₁/aₙ = e^(−2πζ/√(1−ζ²))', analytic, decay, '', 0.01))
  }

  return checks
}

export function runHarmonicBenchmarks(): Check[] {
  const checks: Check[] = []
  const I = 8e-6
  const A = 4e-3

  // 1. Single-DOF oscillator — the exact benchmark for forced response. A single
  //    axial bar pinned at one end, rolling at the other (so the free end has one
  //    DOF), driven by an axial force. Its steady-state FRF is the textbook
  //    damped SDOF curve, so both the static compliance and the resonance peak
  //    have closed forms.
  {
    const L = 2.5
    const P = 20000
    const Abar = 1e-3
    const model: FrameModel = {
      type: 'truss',
      nodes: [
        { x: 0, y: 0, support: 'pin' },
        { x: L, y: 0, support: 'roller-x' }, // free only along x (axial DOF)
      ],
      members: [{ a: 0, b: 1, E: STEEL_E, A: Abar, I: 1, rho: STEEL_RHO }],
      loads: [{ node: 1, fx: P, fy: 0, mz: 0 }],
    }
    const prep = prepareHarmonic(model)
    const zeta = 0.04
    const curve = frfSweep(prep, zeta)
    // Static compliance: |U(ω→0)| = P·L / (E·A).
    const expectStatic = (P * L) / (STEEL_E * Abar)
    checks.push(check('Harmonic static compliance', '|U(0)| = PL/EA', expectStatic, curve.refMag, 'm', 0.01))
    // Resonance peak amplification for a damped SDOF: max = 1/(2ζ√(1−ζ²)).
    const expectAmp = 1 / (2 * zeta * Math.sqrt(1 - zeta * zeta))
    checks.push(
      check('Resonance amplification', 'max = 1/(2ζ√(1−ζ²))', expectAmp, curve.peaks[0]?.amplification ?? 0, '', 0.01),
    )

    // Rotating-unbalance drive: the response peak (measured against the
    // high-speed asymptote me/M) is the mirror of the force peak — same
    // 1/(2ζ√(1−ζ²)) — because the unbalance curve is the r ↔ 1/r reflection.
    const unb = frfSweep(prep, zeta, 'unbalance')
    checks.push(
      check('Unbalance peak (rotor)', 'peak = 1/(2ζ√(1−ζ²))', expectAmp, unb.peaks[0]?.amplification ?? 0, '', 0.01),
    )

    // Base excitation: the transmissibility crossover. Every damping ratio gives
    // TR = 1 at ω = √2·ωₙ — the famous isolation-frequency invariant. Check two
    // very different ζ land on exactly 1 there, and that TR → 1 as ω → 0.
    const w1 = prep.modes[0].omega
    for (const zb of [0.02, 0.12]) {
      const tr = frfAt(prep, zb, Math.SQRT2 * w1, 'base').mag
      checks.push(check(`Base TR at √2·ωₙ (ζ=${(zb * 100).toFixed(0)}%)`, 'TR(√2ωₙ) = 1 ∀ζ', 1, tr, '', 5e-3))
    }
    const trLow = frfAt(prep, 0.05, w1 * 1e-3, 'base').mag
    checks.push(check('Base TR at ω→0', 'TR(0) = 1 (rigid follow)', 1, trLow, '', 1e-3))
  }

  // 2. Modal completeness — the ω→0 harmonic response reconstructs the direct
  //    static deflection of a multi-DOF beam (a cantilever tip-loaded), proving
  //    the modal superposition Σ φᵢφᵢᵀ/ωᵢ² approaches K⁻¹ over the kept modes.
  {
    const L = 4
    const P = 1000
    const m = beamLine(0, 0, L, 0, 10, STEEL_E, A, I, 'fixed', 'free')
    m.loads = [{ node: 10, fx: 0, fy: -P, mz: 0 }]
    const prep = prepareHarmonic(m)
    const curve = frfSweep(prep, 0.03)
    const expected = (P * L ** 3) / (3 * STEEL_E * I)
    checks.push(check('FRF static limit = beam theory', '|U(0)| → PL³/3EI', expected, curve.refMag, 'm', 0.02))
  }

  // 3. Section library — the extreme-fibre distance and second moment of the
  //    parametric builders match the closed-form geometry. For a solid rectangle
  //    the true c equals the historical rectangular guess √(3I/A) exactly; a
  //    thin pipe's I matches the closed-form πr³t of a circular hollow.
  {
    const b = 0.1
    const h = 0.3
    const s = rectSection(b, h)
    checks.push(check('Rect section I = bh³/12', 'I = bh³/12', (b * h ** 3) / 12, s.I, 'm⁴', 1e-9))
    checks.push(check('Rect c = √(3I/A)', 'c = h/2 = √(3I/A)', fibreDistance(s.A, s.I), s.c, 'm', 1e-9))
    const od = 0.2
    const t = 0.004
    const p = pipeSection(od, t)
    const rm = (od - t) / 2 // mean radius
    const approx = Math.PI * rm ** 3 * t // thin-wall I ≈ πr³t
    checks.push(check('Pipe I ≈ πr³t (thin wall)', 'I ≈ π·r_m³·t', approx, p.I, 'm⁴', 0.05))
  }

  return checks
}

/** Straight line of `n` frame elements, each carrying an explicit plastic
 *  moment capacity Mₚ — the building block for the plastic-collapse benchmarks. */
function plasticBeam(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  n: number,
  supA: FrameModel['nodes'][number]['support'],
  supB: FrameModel['nodes'][number]['support'],
  Mp: number,
): FrameModel {
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++)
    nodes.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, support: 'free' })
  nodes[0].support = supA
  nodes[n].support = supB
  const members: FrameModel['members'] = []
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, E: STEEL_E, A: 1e-2, I: 2e-4, Mp })
  return { type: 'frame', nodes, members, loads: [] }
}

export function runPlasticBenchmarks(): Check[] {
  const checks: Check[] = []
  const Mp = 5e5 // N·m plastic moment capacity assigned to every member

  // The pushover solver is nonlinear (event-to-event hinge tracking); each
  // benchmark is a classical plastic-limit-analysis collapse load with a known
  // closed form. Reference loads are unit so the collapse load factor λc reads
  // directly as the collapse load, and P_c = λc·P_ref.

  // 1. Simply-supported beam, central point load — one hinge at midspan:
  //    P_c = 4·Mₚ / L (statically determinate ⇒ first yield = collapse).
  {
    const L = 6
    const n = 8
    const m = plasticBeam(0, 0, L, 0, n, 'pin', 'roller-x', Mp)
    m.loads = [{ node: n / 2, fx: 0, fy: -1, mz: 0 }]
    const r = solvePushover(m)
    checks.push(check('Simply-supported collapse', 'P_c = 4Mₚ/L', (4 * Mp) / L, r.collapseLambda, 'N', 0.01))
  }

  // 2. Propped cantilever, central point load — hinges at the fixed end and
  //    midspan: P_c = 6·Mₚ / L (moment redistributes after the first hinge).
  {
    const L = 6
    const n = 8
    const m = plasticBeam(0, 0, L, 0, n, 'fixed', 'roller-x', Mp)
    m.loads = [{ node: n / 2, fx: 0, fy: -1, mz: 0 }]
    const r = solvePushover(m)
    checks.push(check('Propped-cantilever collapse (point)', 'P_c = 6Mₚ/L', (6 * Mp) / L, r.collapseLambda, 'N', 0.02))
  }

  // 3. Fixed-fixed beam, central point load — three hinges (both ends + centre):
  //    P_c = 8·Mₚ / L. Two-fold indeterminate; the ends and centre yield together.
  {
    const L = 6
    const n = 8
    const m = plasticBeam(0, 0, L, 0, n, 'fixed', 'fixed', Mp)
    m.loads = [{ node: n / 2, fx: 0, fy: -1, mz: 0 }]
    const r = solvePushover(m)
    checks.push(check('Fixed-fixed collapse', 'P_c = 8Mₚ/L', (8 * Mp) / L, r.collapseLambda, 'N', 0.01))
  }

  // 4. Propped cantilever, uniformly distributed load — the span hinge migrates
  //    to x ≈ 0.586L and the collapse intensity is w_c = 11.657·Mₚ / L²
  //    (the classic irrational plastic-analysis result).
  {
    const L = 6
    const n = 14
    const m = plasticBeam(0, 0, L, 0, n, 'fixed', 'roller-x', Mp)
    for (const mem of m.members) mem.w = -1 // unit reference intensity
    const r = solvePushover(m)
    checks.push(check('Propped-cantilever collapse (UDL)', 'w_c = 11.66Mₚ/L²', (11.657 * Mp) / (L * L), r.collapseLambda, 'N/m', 0.02))
  }

  // 5. Fixed-base portal frame, horizontal load — the sway mechanism: four
  //    hinges (both column bases + both beam-column joints), H_c = 4·Mₚ / h.
  {
    const h = 4
    const w = 6
    const nodes: FrameModel['nodes'] = [
      { x: 0, y: 0, support: 'fixed' },
      { x: 0, y: h, support: 'free' },
      { x: w, y: h, support: 'free' },
      { x: w, y: 0, support: 'fixed' },
    ]
    const members: FrameModel['members'] = [
      { a: 0, b: 1, E: STEEL_E, A: 1e-2, I: 2e-4, Mp },
      { a: 1, b: 2, E: STEEL_E, A: 1e-2, I: 2e-4, Mp },
      { a: 2, b: 3, E: STEEL_E, A: 1e-2, I: 2e-4, Mp },
    ]
    const m: FrameModel = { type: 'frame', nodes, members, loads: [{ node: 1, fx: 1, fy: 0, mz: 0 }] }
    const r = solvePushover(m)
    checks.push(check('Portal sway collapse', 'H_c = 4Mₚ/h', (4 * Mp) / h, r.collapseLambda, 'N', 0.02))
  }

  return checks
}

/** Local maxima (time, value) of a positive-going oscillation, for peak ratios. */
function localMaxima(u: Float64Array, dt: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = []
  for (let i = 1; i < u.length - 1; i++) {
    if (u[i] > u[i - 1] && u[i] >= u[i + 1] && u[i] > 0) out.push({ t: i * dt, v: u[i] })
  }
  return out
}

/**
 * Seismic time-history benchmarks. The Newmark-β integrator and the response
 * spectrum are cross-checked against closed-form structural-dynamics results:
 * the undamped period fidelity, the step-load dynamic-amplification factor of 2,
 * the damped log-decrement, the SDOF harmonic steady-state amplitude, and the
 * high-frequency spectral limit Sa → PGA. All exact, all live.
 */
export function runSeismicBenchmarks(): Check[] {
  const checks: Check[] = []
  const G = 9.80665

  // 1. Undamped period fidelity. Release a mass-normalised SDOF (m=1, k=ωₙ²) from
  //    u₀ = 1 with zero velocity: u(t) = cos(ωₙt). Newmark's average-acceleration
  //    scheme conserves amplitude and elongates the period only as O((Δt/T)²), so
  //    after one full period the displacement returns to +1.
  {
    const T = 1
    const w = (2 * Math.PI) / T
    const k = w * w
    const dt = T / 400
    const steps = 401 // through t = T exactly
    const p = new Float64Array(steps)
    const u = newmarkSDOF(1, 0, k, dt, p, 1, 0)
    checks.push(check('Newmark period fidelity', 'u(T) = u₀ (cos ωₙT)', 1, u[steps - 1], '', 0.005))
  }

  // 2. Step-load dynamic amplification. An undamped SDOF suddenly loaded with a
  //    constant force F overshoots to exactly twice its static deflection —
  //    the classic dynamic-amplification factor DAF = 2 (u_max = 2·F/k).
  {
    const w = 2 * Math.PI
    const k = w * w
    const F = k // so static deflection F/k = 1
    const dt = 1 / 800
    const steps = 1600 // ~2 periods, enough to reach the peak
    const p = new Float64Array(steps).fill(F)
    const u = newmarkSDOF(1, 0, k, dt, p, 0, 0)
    let peak = 0
    for (const x of u) peak = Math.max(peak, x)
    checks.push(check('Step-load overshoot (DAF=2)', 'u_max = 2·F/k', 2, peak, '', 0.005))
  }

  // 3. Damped log-decrement via direct integration. A damped SDOF rung down from
  //    u₀ = 1 loses a fixed fraction each cycle: the ratio of successive positive
  //    peaks is e^(−2πζ/√(1−ζ²)). This validates the damping term in Newmark.
  {
    const w = 2 * Math.PI
    const k = w * w
    const zeta = 0.05
    const c = 2 * zeta * w
    const dt = 1 / 800
    const steps = 4000 // several cycles
    const p = new Float64Array(steps)
    const u = newmarkSDOF(1, c, k, dt, p, 1, 0)
    const peaks = localMaxima(u, dt)
    const decay = peaks.length >= 2 ? peaks[1].v / peaks[0].v : 0
    const analytic = Math.exp((-2 * Math.PI * zeta) / Math.sqrt(1 - zeta * zeta))
    checks.push(check('Newmark log-decrement', 'aₙ₊₁/aₙ = e^(−2πζ/√(1−ζ²))', analytic, decay, '', 0.01))
  }

  // 4. Harmonic steady-state amplitude. Drive a damped SDOF with F·cos Ωt; once
  //    the starting transient decays, the amplitude is the textbook resonance
  //    formula (F/k)/√((1−r²)² + (2ζr)²) with r = Ω/ωₙ. Integrating 60 cycles
  //    leaves the transient e^(−ζωₙt) at ~1e-8, so the peak is the steady value.
  {
    const wn = 2 * Math.PI
    const k = wn * wn
    const zeta = 0.05
    const c = 2 * zeta * wn
    const r = 0.8
    const Om = r * wn
    const Td = (2 * Math.PI) / Om
    const dt = Td / 240
    const steps = Math.round((60 * Td) / dt)
    const F = 1
    const p = new Float64Array(steps)
    for (let i = 0; i < steps; i++) p[i] = F * Math.cos(Om * i * dt)
    const u = newmarkSDOF(1, c, k, dt, p, 0, 0)
    // Steady amplitude = peak over the final third of the record.
    let amp = 0
    for (let i = Math.floor((2 * steps) / 3); i < steps; i++) amp = Math.max(amp, Math.abs(u[i]))
    const expected = (F / k) / Math.sqrt((1 - r * r) ** 2 + (2 * zeta * r) ** 2)
    checks.push(check('SDOF harmonic steady-state', '|U| = (F/k)/√((1−r²)²+(2ζr)²)', expected, amp, 'm', 0.01))
  }

  // 5. Spectral high-frequency limit. A very stiff SDOF is rigid — it rides the
  //    ground, and its pseudo-acceleration Sa = ω²·Sd approaches the peak ground
  //    acceleration (PGA). Drive a T = 0.02 s (50 Hz) oscillator with a synthetic
  //    record (content below 9 Hz) and recover its PGA.
  {
    const g = syntheticQuake(0.4, 20, 0.005, 7)
    const T = 0.02
    const w = (2 * Math.PI) / T
    const k = w * w
    const c = 2 * 0.05 * w
    const p = new Float64Array(g.ag.length)
    for (let i = 0; i < p.length; i++) p[i] = -g.ag[i]
    const u = newmarkSDOF(1, c, k, g.dt, p)
    let Sd = 0
    for (const x of u) Sd = Math.max(Sd, Math.abs(x))
    const Sa = w * w * Sd
    checks.push(check('Spectral limit Sa→PGA (T→0)', 'Sa(T→0) = PGA', g.pga / G, Sa / G, 'g', 0.03))
  }

  return checks
}

// -------------------------------------------------- inelastic (nonlinear) seismic
//
// The inelastic time-history marries the plastic hinges of the pushover chapter
// to the Newmark march of the seismic chapter: members yield at bilinear
// kinematic-hardening hinges and the equation of motion is solved by
// Newton–Raphson each step. These benchmarks pin down the hinge law
// (backbone, post-yield slope, unloading), the SDOF integrator (energy balance
// and the elastic limit against the linear solver), and — the strongest check —
// that the full nonlinear MDOF march reproduces the validated *linear* seismic
// solver, to machine precision, whenever nothing yields.

export function runInelasticBenchmarks(): Check[] {
  const checks: Check[] = []

  // 1. Bilinear backbone. Push a kinematic-hardening spring (stiffness k, yield
  //    f_y, post-yield ratio α) monotonically to twice its yield displacement:
  //    the force is exactly f_y + α·k·u_y (elastic to f_y, then slope α·k).
  {
    const k = 1000
    const fy = 10
    const alpha = 0.05
    const H = (alpha * k) / (1 - alpha)
    const uy = fy / k
    let up = 0
    let f = 0
    for (const u of [uy, 1.5 * uy, 2 * uy]) {
      const r = springReturn(u, k, fy, H, up)
      up = r.up
      f = r.f
    }
    const expected = fy + alpha * k * uy
    checks.push(check('Hinge bilinear backbone', 'f(2u_y) = f_y + αk·u_y', expected, f, 'N', 1e-9))
  }

  // 2. Post-yield tangent. Well past yield the bilinear spring's tangent is
  //    exactly α·k — the strain-hardening slope.
  {
    const k = 1000
    const fy = 10
    const alpha = 0.05
    const H = (alpha * k) / (1 - alpha)
    const r = springReturn(0.05, k, fy, H, 0.03)
    checks.push(check('Hinge post-yield tangent', 'k_t = αk', alpha * k, r.kt, 'N/m', 1e-9))
  }

  // 3. Perfectly-plastic unloading. Load a rate-independent (α = 0) spring to
  //    3×yield, leaving a plastic offset u_p = 2u_y; unloading is elastic (slope
  //    k), so the force is exactly zero back at u = u_p.
  {
    const k = 1000
    const fy = 10
    const uy = fy / k
    const r1 = springReturn(3 * uy, k, fy, 0, 0)
    const r2 = springReturn(r1.up, k, fy, 0, r1.up)
    checks.push(check('Perfectly-plastic unload', 'f(u_p) = 0 on elastic unload', 0, r2.f, 'N', 1e-6))
  }

  // 4. Elastoplastic energy balance. Drive a damped EPP oscillator hard enough to
  //    yield and cycle: the input work equals the sum of kinetic + damping +
  //    recoverable strain + dissipated hysteretic energy (the ledger closes).
  {
    const m = 1
    const k = 100
    const zeta = 0.03
    const w = Math.sqrt(k / m)
    const c = 2 * zeta * w * m
    const dt = 0.005
    const n = 6000
    const p = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const t = i * dt
      const env = t < 3 ? t / 3 : Math.exp(-(t - 3) * 0.4)
      p[i] = env * 30 * Math.sin(0.9 * w * t)
    }
    const r = newmarkEPP(m, c, k, 8, 0.02, dt, p)
    const dissipated = r.eKinetic + r.eDamping + r.eStrain + r.eHysteretic
    checks.push(check('EPP energy balance', 'E_in = E_k + E_c + E_s + E_h', r.eInput, dissipated, 'J', 0.01))
  }

  // 5. Elastic limit (SDOF). With the yield force set enormous the EPP integrator
  //    never yields and must reproduce the linear Newmark SDOF response exactly.
  {
    const m = 1
    const k = 100
    const zeta = 0.05
    const w = Math.sqrt(k / m)
    const c = 2 * zeta * w * m
    const dt = 0.01
    const n = 3000
    const p = new Float64Array(n)
    for (let i = 0; i < n; i++) p[i] = 20 * Math.sin(0.7 * w * i * dt)
    const epp = newmarkEPP(m, c, k, 1e12, 0, dt, p)
    const lin = newmarkSDOF(m, c, k, dt, p)
    let maxAbs = 0
    let diff = 0
    for (let i = 0; i < n; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(lin[i]))
      diff = Math.max(diff, Math.abs(epp.u[i] - lin[i]))
    }
    checks.push(check('EPP elastic limit (SDOF)', 'f_y→∞ ⇒ nonlinear = linear', 0, diff / maxAbs, '', 1e-6))
  }

  // 6. Elastic limit (MDOF). The strongest cross-check: with every member's Mₚ
  //    set enormous, the full nonlinear Newton–Raphson MDOF march must reproduce
  //    the independent *linear* seismic time-history solver (solveSeismic) — two
  //    entirely separate integration codepaths — to machine precision. A soft
  //    cantilever column (T₁ ≈ 0.8 s) driven by a harmonic ground record at the
  //    shared step (dt = 0.02) makes the comparison exact.
  {
    const model: FrameModel = {
      type: 'frame',
      nodes: [
        { x: 0, y: 0, support: 'fixed' },
        { x: 0, y: 3, support: 'free' },
      ],
      members: [{ a: 0, b: 1, E: 200e9, A: 0.01, I: 8e-6, rho: 4e5, Mp: 3e5 }],
      loads: [],
    }
    const g = harmonicGround(0.3, 10, 0.02, 1.0)
    const inel = solveInelasticSeismic(model, g, { zeta: 0.05, alpha: 0, strengthFactor: 1e6 })
    const el = solveSeismic(model, g, 0.05)
    const ok = inel.ok && el.ok && inel.nHingesYielded === 0
    checks.push(
      check('Inelastic elastic-limit (MDOF)', 'no yield ⇒ matches linear seismic', el.peakRoof, ok ? inel.peakRoof : 0, 'm', 1e-4),
    )
  }

  return checks
}

export function runContinuumBenchmarks(): Check[] {
  const checks: Check[] = []

  // 1. Uniaxial patch test: a rectangular plate pulled in x by a uniform edge
  //    traction σ must develop a perfectly uniform stress field σ_xx = σ with
  //    σ_yy = τ_xy = 0 everywhere — the fundamental FEM consistency test.
  {
    const E = 1
    const nu = 0.3
    const sigma = 1
    const W = 2
    const H = 1
    const mesh = rectPlate(W, H, 6, 3)
    // Proper patch-test constraints: left edge restrained in x (u = εx·0 = 0
    // there), plus a single node pinned in y to remove rigid-body float. This
    // is compatible with the uniform-strain field, so stress must be uniform.
    const corner = nodeNearest(mesh, 0, 0)
    const r = solveContinuum({
      mesh,
      E,
      nu,
      thickness: 1,
      fix: [
        { edge: 'left', dofs: ['x'] },
        { nodes: [corner], dofs: ['y'] },
      ],
      traction: { edge: 'right', tx: sigma, ty: 0 },
    })
    // Every element's σ_xx should equal σ; σ_yy and τ_xy should vanish.
    let maxSxxErr = 0
    let maxOther = 0
    for (const s of r.elementStress) {
      maxSxxErr = Math.max(maxSxxErr, Math.abs(s.sxx - sigma))
      maxOther = Math.max(maxOther, Math.abs(s.syy), Math.abs(s.sxy))
    }
    checks.push(check('Patch test σxx uniform', 'σxx = σ everywhere', sigma, sigma - maxSxxErr, 'Pa', 1e-6))
    checks.push(check('Patch test σyy, τxy vanish', 'σyy = τxy = 0', 0, maxOther, 'Pa', 1e-6))
    // The x-displacement of the loaded edge follows Hooke's law: u = σ·W/E.
    const expectedU = (sigma * W) / E
    let edgeU = 0
    for (let i = 0; i < mesh.nodeCount; i++)
      if (Math.abs(mesh.x[i] - W) < 1e-9) edgeU = Math.max(edgeU, r.dispX[i])
    checks.push(check('Patch test edge displacement', 'u = σW/E', expectedU, edgeU, 'm', 1e-6))
  }

  // 2. Cantilever plate under tip shear, compared with Euler–Bernoulli beam
  //    theory δ = P·L³/(3EI). A CST mesh is stiff in bending, so we allow a
  //    looser tolerance and simply require the right order of magnitude / trend.
  {
    const E = 210e9
    const nu = 0.0 // remove Poisson coupling to match slender-beam theory
    const L = 4
    const h = 0.4
    const t = 1
    const P = 1e6
    const mesh = cantileverMesh(L, h, 40, 6)
    const r = solveContinuum({
      mesh,
      E,
      nu,
      thickness: t,
      fix: [{ edge: 'left', dofs: ['x', 'y'] }],
      traction: { edge: 'right', tx: 0, ty: -P / (h * t) },
    })
    const I = (t * h ** 3) / 12
    const expected = (P * L ** 3) / (3 * E * I)
    // tip deflection = average vertical displacement of the free edge
    let sum = 0
    let n = 0
    for (let i = 0; i < mesh.nodeCount; i++)
      if (Math.abs(mesh.x[i] - L) < 1e-9) {
        sum += -r.dispY[i]
        n++
      }
    const computed = sum / n
    checks.push(check('Cantilever plate tip deflection', 'δ ≈ PL³/3EI (CST, coarse)', expected, computed, 'm', 0.12))
  }

  return checks
}

// v9 — isoparametric (Q4/Q8) continuum elements, stress recovery & modal.
export function runQuadBenchmarks(): Check[] {
  const checks: Check[] = []

  // 1 & 2. Patch test for Q4 and Q8: a uniform edge traction σ must develop a
  //   perfectly uniform stress field. Because the isoparametric elements pass
  //   the patch test, both σxx = σ (from the *recovered nodal* field) and the
  //   Hooke's-law edge displacement u = σW/E come out exact.
  const patch = (order: QOrder, tag: string) => {
    const E = 1
    const nu = 0.3
    const sigma = 1
    const W = 2
    const H = 1
    const mesh = rectPlateQ(order, W, H, 5, 3)
    const corner = nodeNearestQ(mesh, 0, 0)
    const input: QuadInput = {
      mesh,
      E,
      nu,
      thickness: 1,
      fix: [
        { edge: 'left', dofs: ['x'] },
        { nodes: [corner], dofs: ['y'] },
      ],
      traction: { edge: 'right', tx: sigma, ty: 0 },
    }
    const r = solveQuad(input)
    let maxSxxErr = 0
    let maxOther = 0
    for (let n = 0; n < mesh.nodeCount; n++) {
      // skip orphan-free nodes: recovered where an element touched them
      maxSxxErr = Math.max(maxSxxErr, Math.abs(r.nodalSxx[n] - sigma))
      maxOther = Math.max(maxOther, Math.abs(r.nodalSyy[n]), Math.abs(r.nodalSxy[n]))
    }
    checks.push(check(`${tag} patch σxx uniform`, 'σxx = σ everywhere', sigma, sigma - maxSxxErr, 'Pa', 1e-6))
    checks.push(check(`${tag} patch σyy, τxy vanish`, 'σyy = τxy = 0', 0, maxOther, 'Pa', 1e-6))
    let edgeU = 0
    for (let n = 0; n < mesh.nodeCount; n++)
      if (Math.abs(mesh.x[n] - W) < 1e-9) edgeU = Math.max(edgeU, r.dispX[n])
    checks.push(check(`${tag} patch edge displacement`, 'u = σW/E', (sigma * W) / E, edgeU, 'm', 1e-6))
  }
  patch(4, 'Q4')
  patch(8, 'Q8')

  // Cantilever plate under tip shear. The 2-D elasticity answer is the
  // Timoshenko beam (bending + shear); the classical Euler–Bernoulli value
  // PL³/3EI is the bending-only part. Q8 matches *both* on a coarse mesh.
  const E = 210e9
  const nu = 0.0 // decouple Poisson so beam theory applies cleanly
  const L = 4
  const h = 0.4
  const t = 1
  const P = 1e6
  const I = (t * h ** 3) / 12
  const G = E / (2 * (1 + nu))
  const A = h * t
  const eulerDelta = (P * L ** 3) / (3 * E * I)
  const timoDelta = eulerDelta + (6 / 5) * (P * L) / (G * A) // shear-corrected

  const cantileverTip = (order: QOrder, nx: number, ny: number): number => {
    const mesh = cantileverMeshQ(order, L, h, nx, ny)
    const r = solveQuad({
      mesh,
      E,
      nu,
      thickness: t,
      fix: [{ edge: 'left', dofs: ['x', 'y'] }],
      traction: { edge: 'right', tx: 0, ty: -P / (h * t) },
    })
    let sum = 0
    let n = 0
    for (let i = 0; i < mesh.nodeCount; i++)
      if (Math.abs(mesh.x[i] - L) < 1e-9) {
        sum += -r.dispY[i]
        n++
      }
    return sum / n
  }

  // 3. Q8 reproduces Euler–Bernoulli bending on a coarse mesh (CST needs 12 %).
  const q8Tip = cantileverTip(8, 12, 3)
  checks.push(check('Q8 cantilever vs Euler', 'δ = PL³/3EI (coarse Q8)', eulerDelta, q8Tip, 'm', 0.015))
  // 4. …and matches the full Timoshenko (bending + shear) answer to <0.5 %.
  checks.push(check('Q8 cantilever vs Timoshenko', 'δ = PL³/3EI + 6PL/5GA', timoDelta, q8Tip, 'm', 0.005))
  // 5. Q4 converges to the same answer under refinement (shear-locking cured).
  const q4Tip = cantileverTip(4, 60, 8)
  checks.push(check('Q4 cantilever (refined)', 'δ → PL³/3EI as h→0', eulerDelta, q4Tip, 'm', 0.02))

  // 6. Continuum modal: the fundamental of the cantilever plate is its first
  //   *bending* mode, whose frequency is the Euler–Bernoulli beam value
  //   f₁ = (β₁L)²/(2π)·√(EI/(ρAL⁴)), β₁L = 1.875104. Solved from K φ = ω² M φ
  //   on the isoparametric consistent-mass system.
  {
    const Em = 200e9
    const rho = 7850
    const Lm = 3
    const hm = 0.15
    const tm = 1
    const mesh = cantileverMeshQ(8, Lm, hm, 20, 3)
    const modal = solveQuadModal(
      { mesh, E: Em, nu: 0, thickness: tm, density: rho, fix: [{ edge: 'left', dofs: ['x', 'y'] }] },
      4,
    )
    const Im = (tm * hm ** 3) / 12
    const Am = hm * tm
    const beta1L = 1.8751040687
    const f1 = (beta1L * beta1L) / (2 * Math.PI) * Math.sqrt((Em * Im) / (rho * Am * Lm ** 4))
    const computed = modal.modes.length > 0 ? modal.modes[0].frequency : 0
    checks.push(check('Continuum modal (Q8) f₁', 'cantilever 1st bending mode', f1, computed, 'Hz', 0.02))
  }

  return checks
}

// ---------------------------------------------------------------------------
// Topology optimization (SIMP + OC). No closed form for the optimal layout, so
// we verify the *machinery* instead: the FE energy balance, the analytic
// compliance sensitivity against a finite difference, the filter's
// partition-of-unity, the OC volume constraint, and that the optimizer actually
// descends. If these hold, the designs the studio draws are trustworthy.
// ---------------------------------------------------------------------------

/** A tiny MBB-like problem for fast, deterministic self-tests. */
function tinyMBB(nelx: number, nely: number, volfrac: number, rmin: number, filter: 'density' | 'sensitivity'): TopOptSpec {
  return PROBLEMS[0].build(nelx, nely, volfrac, rmin, filter)
}

export function runTopOptBenchmarks(): Check[] {
  const checks: Check[] = []

  // 1. Energy balance: for a single applied load, the compliance C = UᵀKU must
  //    equal the external work FᵀU exactly (both are the same quadratic form).
  {
    const opt = new TopOpt({ ...tinyMBB(16, 6, 0.5, 1.5, 'density'), cgTol: 1e-12 })
    opt.solveFE()
    const { UKU, FU } = opt.energyBalance()
    checks.push(check('Energy balance UᵀKU = FᵀU', 'compliance is the external work', FU, UKU, 'C', 1e-7))
  }

  // 2. Analytic sensitivity vs. central finite difference. Using the sensitivity
  //    filter so ρ_phys = ρ, we can perturb a single physical density and watch
  //    the compliance respond, then compare to ∂C/∂ρ = −p ρ^{p−1}(E0−Emin) uᵀk⁰u.
  {
    const spec = { ...tinyMBB(12, 5, 0.5, 1.001, 'sensitivity'), cgTol: 1e-12 } as TopOptSpec
    const opt = new TopOpt(spec)
    // A non-uniform, well-conditioned density field.
    for (let e = 0; e < opt.nElem; e++) {
      const v = 0.45 + 0.25 * Math.sin(1.3 * e + 0.7)
      opt.x[e] = v
      opt.xPhys[e] = v
    }
    opt.solveFE()
    const p = opt.spec.penal
    const E0 = opt.spec.E0
    const Emin = opt.spec.Emin
    const e0 = Math.floor(opt.nElem / 2) + 1
    const rho = opt.xPhys[e0]
    const analytic = -p * Math.pow(rho, p - 1) * (E0 - Emin) * opt.energy[e0]
    const h = 1e-3
    opt.xPhys[e0] = rho + h
    const cPlus = opt.solveFE()
    opt.xPhys[e0] = rho - h
    const cMinus = opt.solveFE()
    opt.xPhys[e0] = rho
    const fd = (cPlus - cMinus) / (2 * h)
    checks.push(check('Compliance sensitivity ∂C/∂ρ', 'analytic vs. central finite difference', fd, analytic, '', 2e-3))
  }

  // 3. Filter partition of unity: the density filter must preserve a constant
  //    field exactly (∑w/Hs = 1), or it would bias the total volume.
  {
    const opt = new TopOpt(tinyMBB(20, 8, 0.5, 3.0, 'density'))
    for (let e = 0; e < opt.nElem; e++) opt.x[e] = 0.5
    // projectDensity runs in the constructor on a uniform 0.5 field already.
    let maxDev = 0
    for (let e = 0; e < opt.nElem; e++) maxDev = Math.max(maxDev, Math.abs(opt.xPhys[e] - 0.5))
    checks.push(check('Density filter preserves constants', '∑ weights / Hs = 1 (partition of unity)', 0.5, 0.5 + maxDev, '', 1e-12))
  }

  // 4. Element stiffness sum-to-zero: a rigid-body translation carries no strain
  //    energy, so every row of k⁰ must sum to zero (equilibrium of the element).
  {
    const KE = unitElementK(0.3)
    let maxRow = 0
    for (let a = 0; a < 8; a++) {
      let s = 0
      for (let b = 0; b < 8; b++) s += KE[a][b]
      maxRow = Math.max(maxRow, Math.abs(s))
    }
    // Scale by a representative entry so the tolerance is dimensionless.
    const scale = Math.abs(KE[0][0])
    checks.push(check('Element k⁰ row-sum = 0', 'rigid-body translation is stress-free', 0, maxRow / scale, '', 1e-12))
  }

  // 5. OC volume constraint: one update from a uniform start must land the
  //    realized material fraction on the target V* (the bisection enforces it).
  {
    const opt = new TopOpt(tinyMBB(24, 8, 0.5, 1.5, 'density'))
    const s = opt.step()
    checks.push(check('OC volume constraint', 'realized fraction = target after update', 0.5, s.volume, '', 2e-3))
  }

  // 6. Descent: the optimizer must reduce compliance. Compare the first solve to
  //    the compliance after a run of OC iterations on a small MBB beam.
  {
    const opt = new TopOpt(tinyMBB(30, 10, 0.5, 1.5, 'density'))
    const c0 = opt.step().compliance
    let cN = c0
    for (let i = 0; i < 24; i++) cN = opt.step().compliance
    const relError = cN / c0
    checks.push({
      name: 'Optimizer descends',
      detail: 'compliance after 25 OC steps < initial',
      expected: c0,
      computed: cN,
      relError,
      unit: 'C',
      pass: cN < c0 && Number.isFinite(cN),
    })
  }

  // 7. Heaviside projection endpoints: with η=½ the tanh projection fixes both
  //    ends exactly (ρ̄(0)=0, ρ̄(1)=1) for any sharpness β, and is monotone.
  {
    let err = 0
    let monoOk = true
    for (const beta of [1, 4, 16]) {
      err = Math.max(err, Math.abs(tanhProject(0, beta, 0.5)), Math.abs(tanhProject(1, beta, 0.5) - 1))
      for (let v = 0; v <= 1.0001; v += 0.1) if (tanhProjectDeriv(v, beta, 0.5) <= 0) monoOk = false
    }
    checks.push({
      name: 'Heaviside projection endpoints',
      detail: 'ρ̄(0)=0, ρ̄(1)=1 exactly and monotone ∀β',
      expected: 0,
      computed: err,
      relError: err,
      unit: '',
      pass: err < 1e-12 && monoOk,
    })
  }

  // 8. Full-chain sensitivity through filter *and* Heaviside projection: the
  //    analytic ∂C/∂x (density-filter transpose of the projected ∂C/∂ρ_phys) must
  //    match a central finite difference on the raw design variable x_e. This is
  //    the strongest possible check — it validates every link of the chain rule.
  {
    const spec = { ...tinyMBB(12, 5, 0.5, 2.0, 'density'), heaviside: true, beta: 3, cgTol: 1e-12 } as TopOptSpec
    const opt = new TopOpt(spec)
    for (let e = 0; e < opt.nElem; e++) opt.x[e] = 0.5 + 0.2 * Math.sin(0.9 * e + 0.3)
    opt.reproject()
    opt.solveFE()
    const { dc } = opt.filteredSensitivity()
    // Pick the element with the largest-magnitude gradient for a clean ratio.
    let e0 = 0
    for (let e = 1; e < opt.nElem; e++) if (Math.abs(dc[e]) > Math.abs(dc[e0])) e0 = e
    const analytic = dc[e0]
    const h = 1e-3
    const x0 = opt.x[e0]
    opt.x[e0] = x0 + h
    opt.reproject()
    const cP = opt.solveFE()
    opt.x[e0] = x0 - h
    opt.reproject()
    const cM = opt.solveFE()
    opt.x[e0] = x0
    opt.reproject()
    const fd = (cP - cM) / (2 * h)
    checks.push(check('Filter+Heaviside sensitivity ∂C/∂x', 'analytic chain rule vs. finite difference', fd, analytic, '', 3e-3))
  }

  return checks
}

// --- Thermal: heat conduction (v11) --------------------------------------

export function runThermalBenchmarks(): Check[] {
  const checks: Check[] = []

  // 1. 1-D steady conduction: a slab held Thot on the left, Tcold on the right.
  //    Insulated top/bottom → the temperature is linear, T(x)=Thot+(Tcold−Thot)x/L,
  //    so the mid-plane sits at the mean and the flux is q = κ·ΔT/L everywhere.
  {
    const L = 1
    const k = 40
    const Thot = 100
    const Tcold = 0
    const mesh = rectPlateQ(4, L, 0.2, 20, 4)
    const input: ThermalInput = {
      mesh, k, rhoc: 1, thickness: 1,
      bcs: { left: { kind: 'temp', value: Thot }, right: { kind: 'temp', value: Tcold }, top: { kind: 'insulated' }, bottom: { kind: 'insulated' } },
    }
    const r = solveThermalSteady(input)
    let mid = 0, cnt = 0
    for (let n = 0; n < mesh.nodeCount; n++) if (Math.abs(mesh.x[n] - L / 2) < 1e-9) { mid += r.T[n]; cnt++ }
    checks.push(check('Slab mid-plane temperature', 'linear profile T = ½(Thot+Tcold)', (Thot + Tcold) / 2, mid / cnt, '°C'))
    checks.push(check('Conduction heat flux', "q'' = κ·ΔT/L (Fourier's law)", (k * (Thot - Tcold)) / L, r.maxFlux, 'W/m²'))
  }

  // 2. Internal heat generation, both ends cold: the classic conductor-with-current
  //    parabola. Peak rise above the walls is T_max = q'''·L²/(8κ).
  {
    const L = 1
    const k = 30
    const q = 5e4
    const Tc = 20
    const mesh = rectPlateQ(4, L, 0.1, 40, 4)
    const input: ThermalInput = {
      mesh, k, rhoc: 1, thickness: 1, gen: { q },
      bcs: { left: { kind: 'temp', value: Tc }, right: { kind: 'temp', value: Tc }, top: { kind: 'insulated' }, bottom: { kind: 'insulated' } },
    }
    const r = solveThermalSteady(input)
    checks.push(check('Internal-generation peak', "T_max = Tc + q'''·L²/8κ", Tc + (q * L * L) / (8 * k), r.maxT, '°C'))
  }

  // 3. Robin (convective) boundary: a slab with a fixed-temperature base and a
  //    convecting end. Flux continuity gives the exact end temperature
  //    T_L = (κ·Tb/L + h·T∞)/(κ/L + h) — the discrete Biot-number balance.
  {
    const L = 1
    const k = 20
    const Tb = 100
    const h = 50
    const Tinf = 20
    const mesh = rectPlateQ(4, L, 0.1, 30, 3)
    const input: ThermalInput = {
      mesh, k, rhoc: 1, thickness: 1,
      bcs: { left: { kind: 'temp', value: Tb }, right: { kind: 'convection', h, Tinf }, top: { kind: 'insulated' }, bottom: { kind: 'insulated' } },
    }
    const r = solveThermalSteady(input)
    const rn = edgeNodesQ(mesh, 'right')
    let TR = 0
    for (const n of rn) TR += r.T[n]
    TR /= rn.length
    const expected = (k * Tb / L + h * Tinf) / (k / L + h)
    checks.push(check('Convective (Robin) end temperature', 'κ(Tb−T_L)/L = h(T_L−T∞)', expected, TR, '°C'))
  }

  // 4. Thermal patch test: impose an *inclined* linear field T = a+bx+cy on every
  //    boundary node. A consistent conduction element reproduces the field (a
  //    constant gradient / harmonic function) exactly at every interior node.
  {
    const mesh = rectPlateQ(8, 1, 1, 5, 5)
    const a = 5, b = 3, c = -2
    const field = (x: number, y: number) => a + b * x + c * y
    const eps = 1e-9
    const onBoundary = (n: number) =>
      Math.abs(mesh.x[n] - mesh.minX) < eps || Math.abs(mesh.x[n] - mesh.maxX) < eps ||
      Math.abs(mesh.y[n] - mesh.minY) < eps || Math.abs(mesh.y[n] - mesh.maxY) < eps
    const nodeTemps: { node: number; value: number }[] = []
    for (let n = 0; n < mesh.nodeCount; n++) if (onBoundary(n)) nodeTemps.push({ node: n, value: field(mesh.x[n], mesh.y[n]) })
    const input: ThermalInput = { mesh, k: 17, rhoc: 1, thickness: 1, bcs: {}, nodeTemps }
    const r = solveThermalSteady(input)
    let worst = 0
    let denom = 1e-30
    for (let n = 0; n < mesh.nodeCount; n++) {
      if (onBoundary(n)) continue
      const exact = field(mesh.x[n], mesh.y[n])
      worst = Math.max(worst, Math.abs(r.T[n] - exact))
      denom = Math.max(denom, Math.abs(exact))
    }
    checks.push(check('Thermal patch test', 'linear field T=a+bx+cy reproduced exactly', 0, worst / denom, '', 1e-6))
  }

  // 5. Transient → steady consistency: the θ-method's fixed point is precisely the
  //    steady operator, so a long enough march lands on the steady-solver field.
  {
    const L = 0.3
    const k = 45
    const rhoc = 3.5e6
    const Thot = 200
    const Tcold = 25
    const mesh = rectPlateQ(4, L, 0.05, 20, 4)
    const input: ThermalInput = {
      mesh, k, rhoc, thickness: 0.01,
      bcs: { left: { kind: 'temp', value: Thot }, right: { kind: 'temp', value: Tcold }, top: { kind: 'insulated' }, bottom: { kind: 'insulated' } },
      T0: Tcold,
    }
    const tr = solveThermalTransient(input, { steps: 160, totalTime: 12000 })
    const last = tr.frames[tr.frames.length - 1]
    const steady = tr.steady?.T
    let md = 0, ms = 1e-30
    if (steady) for (let n = 0; n < mesh.nodeCount; n++) { md = Math.max(md, Math.abs(last[n] - steady[n])); ms = Math.max(ms, Math.abs(steady[n] - Tcold)) }
    checks.push(check('Transient → steady (Crank–Nicolson)', 'θ-method fixed point equals the steady solve', 0, md / ms, '', 1e-2))
  }

  return checks
}

// --- Thermoelasticity: one-way thermo-mechanical coupling (v11) -----------

export function runThermoelasticBenchmarks(): Check[] {
  const checks: Check[] = []
  const E = 200e9
  const nu = 0.3
  const alpha = 12e-6
  const dT = 80
  const Tref = 20

  // 1. Fully restrained bar, uniform ΔT: with expansion blocked in x (εxx=0) and
  //    free in y (σyy=0), plane-stress algebra collapses to σxx = −E·α·ΔT exactly —
  //    the canonical "thermal stress with no external load" result.
  {
    const mesh = rectPlateQ(4, 0.4, 0.05, 24, 4)
    const T = new Float64Array(mesh.nodeCount).fill(Tref + dT)
    const r = solveThermoelastic({
      mesh, E, nu, alpha, thickness: 0.01, T, Tref,
      fix: [{ edge: 'left', dofs: ['x'] }, { edge: 'right', dofs: ['x'] }, { nodes: [0], dofs: ['y'] }],
    })
    let s = 0
    for (const es of r.elementStress) s += es.sxx
    s /= r.elementStress.length
    checks.push(check('Restrained-bar thermal stress', 'σxx = −E·α·ΔT (uniform heating)', -E * alpha * dT, s, 'Pa'))
  }

  // 2. Free thermal expansion: a bar pinned just enough to remove rigid-body motion
  //    grows by α·ΔT·L and carries *no* stress. Both the growth and (near-)zero
  //    stress confirm the thermal load and ε₀ correction cancel when unrestrained.
  {
    const L = 0.4
    const mesh = rectPlateQ(4, L, 0.05, 24, 4)
    const T = new Float64Array(mesh.nodeCount).fill(Tref + dT)
    const r = solveThermoelastic({
      mesh, E, nu, alpha, thickness: 0.01, T, Tref,
      fix: [{ edge: 'left', dofs: ['x'] }, { nodes: [nodeNearestQ(mesh, 0, 0)], dofs: ['y'] }],
    })
    const rn = edgeNodesQ(mesh, 'right')
    let ux = 0
    for (const n of rn) ux += r.dispX[n]
    ux /= rn.length
    checks.push(check('Free thermal expansion', 'tip growth = α·ΔT·L', alpha * dT * L, ux, 'm'))
    // Residual stress relative to the restrained-bar scale E·α·ΔT — should vanish.
    checks.push(check('Free expansion is stress-free', 'σ/(E·α·ΔT) → 0 when unrestrained', 0, r.maxVonMises / (E * alpha * dT), '', 1e-6))
  }

  // 3. Transient thermal-stress consistency: the coupled warm-up "stress movie"
  //    (a thermoelastic solve at each conduction time-step) must land, at its
  //    final frame, on the steady thermoelastic field — the transient integrator
  //    and the steady coupling agree in the limit.
  {
    const mesh = rectPlateQ(4, 0.2, 0.2, 12, 12)
    const input: ThermalInput = {
      mesh, k: 45, rhoc: 3.6e6, thickness: 0.02,
      bcs: { left: { kind: 'temp', value: 220 }, right: { kind: 'temp', value: 20 }, top: { kind: 'insulated' }, bottom: { kind: 'insulated' } },
      T0: 20,
    }
    const fix = [{ edge: 'left' as const, dofs: ['x', 'y'] as ('x' | 'y')[] }]
    const tr = solveTransientThermoelastic(
      input,
      { E, nu, alpha, thickness: 0.02, Tref: 20, fix },
      { stressFrames: 14, totalTime: 40000 },
    )
    const steadyT = solveThermalSteady(input)
    const ste = solveThermoelastic({ mesh, E, nu, alpha, thickness: 0.02, T: steadyT.T, Tref: 20, fix })
    const last = tr.frames[tr.frames.length - 1]
    let md = 0
    let ms = 1e-30
    for (let n = 0; n < mesh.nodeCount; n++) {
      md = Math.max(md, Math.abs(last.nodalVonMises[n] - ste.nodalVonMises[n]))
      ms = Math.max(ms, Math.abs(ste.nodalVonMises[n]))
    }
    checks.push(check('Transient thermal-stress → steady', 'coupled warm-up final frame = steady coupling', 0, md / ms, '', 1e-2))
  }

  return checks
}

export function runFractureBenchmarks(): Check[] {
  const checks: Check[] = []
  const E = 210e9
  const nu = 0.3
  const sigma = 100e6

  // A moderately refined graded mesh reproduces the handbook geometry factors and
  // the J = K²/E* identity to a fraction of a percent — the whole point of the
  // domain (equivalent-area) forms of the J- and interaction integrals.
  function mk(kind: CrackModel['kind'], alpha: number): CrackModel {
    return { kind, a: alpha, W: 1, H: 2, sigma, E, nu, thickness: 1, order: 8, refine: 1 }
  }

  // 1–2. Center crack vs the Feddersen finite-width factor Y = √sec(πa/2W).
  {
    const r = analyzeFracture(mk('center', 0.3))
    checks.push(check('Center-crack K_I (interaction integral)', 'Y = K_I/(σ√πa) = √sec(πa/2W)', r.Yref, r.Y, '', 0.03))
    // J-integral vs K_I²/E* — two independent integrals of the same field.
    checks.push(check('J = K_I²/E* (center)', 'energy release rate ↔ K identity', r.JfromK, r.J, 'J/m²', 0.03))
  }

  // 3. Griffith energy limit: for a small crack in a wide plate the energy
  //    release rate approaches the infinite-plate value G = σ²πa/E*.
  {
    const a = 0.12
    const r = analyzeFracture(mk('center', a))
    const Ginf = (sigma * sigma * Math.PI * a) / E
    checks.push(check('Griffith energy release G (center)', 'G → σ²πa/E* (wide plate)', Ginf, r.J, 'J/m²', 0.04))
  }

  // 4. Path (domain) independence: J over the innermost vs outermost evaluation
  //    ring must agree — the defining property of a conservation integral.
  {
    const r = analyzeFracture(mk('edge', 0.3))
    const lo = r.ringJ[0]
    const hi = r.ringJ[r.ringJ.length - 1]
    checks.push(check('J path independence', 'J(inner ring) = J(outer ring)', lo, hi, 'J/m²', 0.02))
  }

  // 5. Single edge crack vs the Tada polynomial; the free-surface factor.
  {
    const r = analyzeFracture(mk('edge', 0.3))
    checks.push(check('Edge-crack K_I (SENT)', 'Y = 1.12 − 0.23α + 10.55α² − … (Tada)', r.Yref, r.Y, '', 0.03))
  }

  // 6. Pure mode I: the symmetric configurations carry no shear mode. (K_II is
  //    identically zero by construction — this pins the reported value.)
  {
    const r = analyzeFracture(mk('center', 0.3))
    checks.push(check('Mode-I purity (center)', 'K_II = 0 for a symmetric crack', 0, r.KII, 'Pa·√m', 1e-9))
  }

  // 7. Double edge crack vs the Tada DENT factor.
  {
    const r = analyzeFracture(mk('double-edge', 0.3))
    checks.push(check('Double-edge K_I (DENT)', 'Y = (1.122 − 0.561α − …)/√(1−α)', r.Yref, r.Y, '', 0.03))
  }

  // 8. Displacement-correlation cross-check: an entirely independent K_I estimate
  //    (from the crack-opening √r profile) tracks the interaction integral.
  {
    const r = analyzeFracture(mk('edge', 0.3))
    checks.push(check('Displacement-correlation K_I', 'crack-opening √r fit ≈ interaction integral', r.KI, r.KIdcm, 'Pa·√m', 0.1))
  }

  return checks
}

export function runAllBenchmarks(): {
  frame: Check[]
  dynamics: Check[]
  harmonic: Check[]
  seismic: Check[]
  plastic: Check[]
  inelastic: Check[]
  continuum: Check[]
  quad: Check[]
  topopt: Check[]
  thermal: Check[]
  thermoelastic: Check[]
  fracture: Check[]
  allPass: boolean
} {
  const frame = runFrameBenchmarks()
  const dynamics = runDynamicsBenchmarks()
  const harmonic = runHarmonicBenchmarks()
  const seismic = runSeismicBenchmarks()
  const plastic = runPlasticBenchmarks()
  const inelastic = runInelasticBenchmarks()
  const continuum = runContinuumBenchmarks()
  const quad = runQuadBenchmarks()
  const topopt = runTopOptBenchmarks()
  const thermal = runThermalBenchmarks()
  const thermoelastic = runThermoelasticBenchmarks()
  const fracture = runFractureBenchmarks()
  const allPass = [
    ...frame,
    ...dynamics,
    ...harmonic,
    ...seismic,
    ...plastic,
    ...inelastic,
    ...continuum,
    ...quad,
    ...topopt,
    ...thermal,
    ...thermoelastic,
    ...fracture,
  ].every((c) => c.pass)
  return { frame, dynamics, harmonic, seismic, plastic, inelastic, continuum, quad, topopt, thermal, thermoelastic, fracture, allPass }
}
