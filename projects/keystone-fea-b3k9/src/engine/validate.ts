// Live self-verification: solve textbook problems with the same engine the app
// uses, and compare against closed-form solutions from mechanics of materials.
// The studio surfaces these as a "Verified ✓" badge — the numbers you see on
// screen are produced by code that provably reproduces the analytical answers.

import { solveFrame, type FrameModel } from './frame'
import { solveModal, solveBuckling } from './dynamics'
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
  continuum: Check[]
  allPass: boolean
} {
  const frame = runFrameBenchmarks()
  const dynamics = runDynamicsBenchmarks()
  const continuum = runContinuumBenchmarks()
  const allPass = [...frame, ...dynamics, ...continuum].every((c) => c.pass)
  return { frame, dynamics, continuum, allPass }
}
