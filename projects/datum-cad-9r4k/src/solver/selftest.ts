import { Sketch } from '../model/sketch'
import { solve } from './solver'
import { analyzeDof } from './dof'
import { fourBarProbe, sliderProbe } from './probes'
import { EXAMPLES } from '../model/examples'

export type TestResult = { name: string; pass: boolean; detail: string }

const approx = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol

// A battery of checks that re-derives each solver claim from an independent
// reference — the same spirit as the physics engine's live correctness suite.
export function runSelfTests(): TestResult[] {
  const out: TestResult[] = []
  const check = (name: string, pass: boolean, detail: string) => out.push({ name, pass, detail })

  // 1. A single distance constraint drives to its exact target.
  {
    const s = new Sketch()
    const a = s.addPoint(0, 0, { fixed: true })
    const b = s.addPoint(40, 10)
    s.addConstraint('distance', [a.id, b.id], 100)
    const r = solve(s)
    const d = Math.hypot(s.point(b.id).x, s.point(b.id).y)
    check('distance → exact length', r.converged && approx(d, 100), `d=${d.toFixed(4)} (want 100)`)
  }

  // 2. Perpendicular makes the dot product vanish.
  {
    const s = new Sketch()
    const o = s.addPoint(0, 0, { fixed: true })
    const a = s.addPoint(50, 0, { fixed: true })
    const b = s.addPoint(30, 40)
    const l1 = s.addLine(o.id, a.id)
    const l2 = s.addLine(o.id, b.id)
    s.addConstraint('perpendicular', [l1.id, l2.id])
    const r = solve(s)
    const d1 = s.lineDir(l1)
    const d2 = s.lineDir(l2)
    const dot = d1.dx * d2.dx + d1.dy * d2.dy
    check('perpendicular → dot=0', r.converged && approx(dot, 0, 1e-3), `dot=${dot.toFixed(4)}`)
  }

  // 3. Parallel makes the cross product vanish.
  {
    const s = new Sketch()
    const p1 = s.addPoint(0, 0, { fixed: true })
    const p2 = s.addPoint(60, 0, { fixed: true })
    const p3 = s.addPoint(10, 40)
    const p4 = s.addPoint(70, 55)
    const l1 = s.addLine(p1.id, p2.id)
    const l2 = s.addLine(p3.id, p4.id)
    s.addConstraint('parallel', [l1.id, l2.id])
    const r = solve(s)
    const d1 = s.lineDir(l1)
    const d2 = s.lineDir(l2)
    const cross = d1.dx * d2.dy - d1.dy * d2.dx
    check('parallel → cross=0', r.converged && approx(cross, 0, 1e-2), `cross=${cross.toFixed(4)}`)
  }

  // 4. Rigid triangle: a free triangular body has exactly 3 DOF (x, y, θ).
  {
    const b = EXAMPLES.find((e) => e.id === 'triangle')!.build()
    const dof = analyzeDof(b.sketch)
    check('rigid triangle DOF = 3', dof.dof === 3 && dof.status === 'under', `dof=${dof.dof}, status=${dof.status}`)
  }

  // 5. Rigid triangle keeps its edge lengths after a solve from a perturbed start.
  {
    const b = EXAMPLES.find((e) => e.id === 'triangle')!.build()
    const s = b.sketch
    // Nudge a vertex and re-solve; edges must return to spec.
    const pts = s.entities.filter((e) => e.kind === 'point')
    ;(pts[0] as { x: number }).x += 30
    ;(pts[2] as { y: number }).y -= 25
    const r = solve(s)
    const lens = s.entities.filter((e) => e.kind === 'line').map((l) => s.lineDir(s.line(l.id)).len)
    const ok = r.converged && approx(lens[0], 120, 1e-2) && approx(lens[1], 122, 1e-2) && approx(lens[2], 122, 1e-2)
    check('triangle edges preserved', ok, lens.map((v) => v.toFixed(2)).join(', '))
  }

  // 6. Parametric square: after solving, all sides equal and corners square.
  {
    const b = EXAMPLES.find((e) => e.id === 'square')!.build()
    const s = b.sketch
    const r = solve(s)
    const lines = s.entities.filter((e) => e.kind === 'line')
    const lens = lines.map((l) => s.lineDir(s.line(l.id)).len)
    const equal = lens.every((v) => approx(v, lens[0], 1e-2))
    // Base is horizontal.
    const base = s.lineDir(s.line(lines[0].id))
    check('square → equal sides & level base', r.converged && equal && approx(base.dy, 0, 1e-2), `sides ${lens.map((v) => v.toFixed(1)).join('/')}`)
  }

  // 7. Tangent circles: centre distance equals the sum of radii.
  {
    const b = EXAMPLES.find((e) => e.id === 'tangent')!.build()
    const s = b.sketch
    const r = solve(s)
    const circs = s.entities.filter((e) => e.kind === 'circle')
    const c0 = s.circle(circs[0].id)
    const c1 = s.circle(circs[1].id)
    const a = s.point(c0.c)
    const bb = s.point(c1.c)
    const d = Math.hypot(a.x - bb.x, a.y - bb.y)
    check('tangent circles → d = r₁+r₂', r.converged && approx(d, c0.r + c1.r, 1e-2), `d=${d.toFixed(2)}, r₁+r₂=${(c0.r + c1.r).toFixed(2)}`)
  }

  // 8. Four-bar linkage stays assembled through a full crank rotation.
  {
    const probe = fourBarProbe()
    check('four-bar closes over full turn', probe.ok, probe.detail)
  }

  // 9. Slider-crank keeps the slider on its guide through a full rotation.
  {
    const probe = sliderProbe()
    check('slider stays on guide', probe.ok, probe.detail)
  }

  // 10. Regular hexagon: every edge ends up equal length.
  {
    const b = EXAMPLES.find((e) => e.id === 'hexagon')!.build()
    const s = b.sketch
    const r = solve(s, { maxIterations: 120 })
    const lens = s.entities.filter((e) => e.kind === 'line').map((l) => s.lineDir(s.line(l.id)).len)
    const equal = lens.every((v) => approx(v, lens[0], 5e-2))
    check('hexagon → equal edges', r.converged && equal, `edges ${lens.map((v) => v.toFixed(1)).join('/')}`)
  }

  return out
}
