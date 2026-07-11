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

export function runAllBenchmarks(): {
  frame: Check[]
  dynamics: Check[]
  harmonic: Check[]
  plastic: Check[]
  continuum: Check[]
  allPass: boolean
} {
  const frame = runFrameBenchmarks()
  const dynamics = runDynamicsBenchmarks()
  const harmonic = runHarmonicBenchmarks()
  const plastic = runPlasticBenchmarks()
  const continuum = runContinuumBenchmarks()
  const allPass = [...frame, ...dynamics, ...harmonic, ...plastic, ...continuum].every((c) => c.pass)
  return { frame, dynamics, harmonic, plastic, continuum, allPass }
}
