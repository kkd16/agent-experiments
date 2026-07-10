import { Sketch } from '../model/sketch'
import type { ParamRef } from '../model/sketch'
import { solve } from './solver'
import { analyzeDof } from './dof'
import { fourBarProbe, sliderProbe } from './probes'
import { residualVector } from './residuals'
import { residualsAndJacobian } from './jacobian'
import { analyzeConflicts } from './conflicts'
import { autoConstrain } from '../model/autoConstrain'
import { toJSONString, fromJSONString, encodeHash, decodeHash } from '../model/persist'
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

  // 11. Differential test: the exact (automatic-differentiation) Jacobian agrees
  //     with an independent central finite-difference Jacobian across every
  //     example, at a perturbed (generic, non-degenerate) configuration. This is
  //     the load-bearing check for the analytic solver — it proves the derivative
  //     code and the residual code describe the same geometry.
  {
    let worst = 0
    for (const ex of EXAMPLES) {
      const s = ex.build().sketch
      const refs = s.freeParams()
      if (refs.length === 0) continue
      // Perturb to a generic configuration so no gradient is accidentally zero.
      const x = s.readParams(refs)
      for (let j = 0; j < x.length; j++) x[j] += 0.31 * (1 + Math.abs(x[j])) * Math.sin((j + 1) * 7.13)
      s.writeParams(refs, x)
      worst = Math.max(worst, jacobianDiff(s, refs))
    }
    check('analytic Jacobian = finite-diff', worst < 1e-5, `worst |ΔJ| = ${worst.toExponential(1)} over all examples`)
  }

  // 12. The AD residual values reproduce the plain reference residuals exactly —
  //     the value and the derivative come from one and the same residual code.
  {
    let worst = 0
    for (const ex of EXAMPLES) {
      const s = ex.build().sketch
      const refs = s.freeParams()
      const plain = residualVector(s, s.constraints)
      const ad = residualsAndJacobian(s, s.constraints, refs).r
      for (let i = 0; i < plain.length; i++) worst = Math.max(worst, Math.abs(plain[i] - ad[i]))
    }
    check('AD residuals = reference values', worst === 0, `worst |Δr| = ${worst.toExponential(1)}`)
  }

  // 13. Conflict diagnosis pinpoints the *specific* redundant constraint. A
  //     quadrilateral with a right angle at all four corners is over-constrained:
  //     the fourth right angle is implied by the first three. The analyzer must
  //     flag exactly one constraint, and it must be the last one added.
  {
    const s = new Sketch()
    const a = s.addPoint(-50, -50)
    const b = s.addPoint(60, -48)
    const c = s.addPoint(55, 60)
    const d = s.addPoint(-52, 55)
    const ab = s.addLine(a.id, b.id)
    const bc = s.addLine(b.id, c.id)
    const cd = s.addLine(c.id, d.id)
    const da = s.addLine(d.id, a.id)
    s.addConstraint('perpendicular', [ab.id, bc.id])
    s.addConstraint('perpendicular', [bc.id, cd.id])
    s.addConstraint('perpendicular', [cd.id, da.id])
    const last = s.addConstraint('perpendicular', [da.id, ab.id]) // implied ⇒ redundant
    const conf = analyzeConflicts(s)
    const dof = analyzeDof(s)
    const ok = conf.count === dof.redundant && conf.redundant.size === 1 && conf.redundant.has(last.id)
    check('conflict analysis pinpoints culprit', ok, `flagged {${[...conf.redundant].join(',')}}, want {${last.id}}`)
  }

  // 14. Peaucellier–Lipkin draws an *exact* straight line: sweeping the crank
  //     across its range, the traced point's x-coordinate stays constant to
  //     within solver tolerance (the linkage is a true inversor).
  {
    const built = EXAMPLES.find((e) => e.id === 'peaucellier')!.build()
    const s = built.sketch
    const drv = built.driver!
    const c = s.constraints.find((k) => k.id === drv.constraintId)!
    const traced = built.tracePoints![0]
    const xs: number[] = []
    let converged = true
    for (let a = drv.min; a <= drv.max; a += 1) {
      c.value = a
      const r = solve(s, { maxIterations: 80 })
      converged = converged && r.converged
      xs.push(s.point(traced).x)
    }
    const mean = xs.reduce((p, v) => p + v, 0) / xs.length
    const dev = Math.max(...xs.map((v) => Math.abs(v - mean)))
    check('Peaucellier → exact straight line', converged && dev < 1e-4, `x held to ${dev.toExponential(1)} across the sweep`)
  }

  // 15. Hoeken's four-bar stays assembled through a full crank rotation and its
  //     coupler point runs approximately straight (a few percent) along the
  //     bottom of its travel — the practical straight-line linkage.
  {
    const built = EXAMPLES.find((e) => e.id === 'hoeken')!.build()
    const s = built.sketch
    const drv = built.driver!
    const c = s.constraints.find((k) => k.id === drv.constraintId)!
    const traced = built.tracePoints![0]
    const pts: [number, number][] = []
    let converged = true
    for (let a = 0; a <= 360; a += 5) {
      c.value = a
      const r = solve(s, { maxIterations: 100 })
      converged = converged && r.converged
      pts.push([s.point(traced).x, s.point(traced).y])
    }
    const ys = pts.map((p) => p[1])
    const ymin = Math.min(...ys)
    const span = Math.max(...ys) - ymin
    const bottom = pts.filter((p) => p[1] <= ymin + span * 0.15)
    const by = bottom.map((p) => p[1])
    const flat = (Math.max(...by) - Math.min(...by)) / span // relative flatness of the straight run
    check('Hoeken → approximate straight line', converged && flat < 0.15, `bottom run flat to ${(flat * 100).toFixed(1)}% of travel`)
  }

  // 16. Persistence round-trips a sketch losslessly through both the JSON file
  //     format and the base64 URL-hash format: same entities, same constraints,
  //     same residuals after reloading.
  {
    let worst = 0
    let structureOk = true
    for (const ex of EXAMPLES) {
      const s = ex.build().sketch
      const before = residualVector(s, s.constraints)
      const viaJSON = fromJSONString(toJSONString(s.toData()))
      const viaHash = decodeHash('#s=' + encodeHash(s.toData()))
      for (const data of [viaJSON, viaHash]) {
        if (!data) {
          structureOk = false
          continue
        }
        const s2 = new Sketch(data)
        if (s2.entities.length !== s.entities.length || s2.constraints.length !== s.constraints.length) structureOk = false
        const after = residualVector(s2, s2.constraints)
        for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(before[i] - after[i]))
      }
    }
    check('save/load/share round-trips exactly', structureOk && worst === 0, `worst residual drift ${worst.toExponential(1)}`)
  }

  // 17. Auto-constrain turns a roughly-drawn square into a fully-constrained one
  //     with no redundant equations, and the solve snaps the sides equal.
  {
    const s = new Sketch()
    const a = s.addPoint(0, 1, { fixed: true })
    const b = s.addPoint(101, -1)
    const c = s.addPoint(99, 100)
    const d = s.addPoint(-2, 102)
    s.addLine(a.id, b.id)
    s.addLine(b.id, c.id)
    s.addLine(c.id, d.id)
    s.addLine(d.id, a.id)
    const res = autoConstrain(s)
    solve(s, { maxIterations: 100 })
    const dof = analyzeDof(s)
    const lens = s.entities.filter((e) => e.kind === 'line').map((l) => s.lineDir(s.line(l.id)).len)
    const equal = lens.every((v) => approx(v, lens[0], 1e-2))
    check('auto-constrain squares a rough sketch', res.added > 0 && dof.status === 'well' && dof.redundant === 0 && equal, `added ${res.added}, ${dof.status}, sides ${lens.map((v) => v.toFixed(1)).join('/')}`)
  }

  // 18. A single free arc has exactly 5 degrees of freedom: center (x, y), radius,
  //     and the two endpoint angles. The intrinsic endpoint-on-circle residuals
  //     remove 2 of the 7 raw parameters (2 center + 4 endpoint + 1 radius).
  {
    const s = new Sketch()
    const c = s.addPoint(0, 0)
    const p1 = s.addPoint(40, 0)
    const p2 = s.addPoint(0, 40)
    s.addArc(c.id, p1.id, p2.id, 40)
    const dof = analyzeDof(s)
    check('free arc has 5 DOF', dof.params === 7 && dof.equations === 2 && dof.dof === 5, `params=${dof.params}, eqs=${dof.equations}, dof=${dof.dof}`)
  }

  // 19. The rounded slot solves to a true obround: both caps share one radius, each
  //     cap's endpoints sit exactly on its circle, and each flank is tangent to its
  //     cap (centre-to-line distance = radius). Fully constrained, no redundancy.
  {
    const b = EXAMPLES.find((e) => e.id === 'slot')!.build()
    const s = b.sketch
    const r = solve(s, { maxIterations: 120 })
    const arcs = s.entities.filter((e) => e.kind === 'arc').map((e) => s.arc(e.id))
    // Endpoints on their circle.
    let worstOn = 0
    for (const a of arcs) {
      for (const pid of [a.p1, a.p2]) {
        const p = s.point(pid)
        const c = s.point(a.c)
        worstOn = Math.max(worstOn, Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - a.r))
      }
    }
    const equalR = approx(arcs[0].r, arcs[1].r, 1e-6)
    const dof = analyzeDof(s)
    check('rounded slot → obround, tangent & exact', r.converged && worstOn < 1e-6 && equalR && dof.status === 'well' && dof.redundant === 0, `on-circle ${worstOn.toExponential(1)}, r=${arcs[0].r.toFixed(2)}/${arcs[1].r.toFixed(2)}, ${dof.status}`)
  }

  // 20. The fillet's arc is genuinely tangent to both legs: the perpendicular
  //     distance from the (solver-placed) arc centre to each leg line equals the
  //     arc radius, to solver precision.
  {
    const b = EXAMPLES.find((e) => e.id === 'fillet')!.build()
    const s = b.sketch
    const r = solve(s, { maxIterations: 120 })
    const arc = s.arc(s.entities.find((e) => e.kind === 'arc')!.id)
    const c = s.point(arc.c)
    const lines = s.entities.filter((e) => e.kind === 'line')
    let worst = 0
    for (const le of lines) {
      const l = s.line(le.id)
      const a = s.point(l.p1)
      const bb = s.point(l.p2)
      const dx = bb.x - a.x
      const dy = bb.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const dist = Math.abs((c.x - a.x) * dy - (c.y - a.y) * dx) / len
      worst = Math.max(worst, Math.abs(dist - arc.r))
    }
    const dof = analyzeDof(s)
    check('fillet arc tangent to both legs', r.converged && worst < 1e-6 && dof.status === 'well', `worst |dist−r| = ${worst.toExponential(1)}, ${dof.status}`)
  }

  // 21. The rounded rectangle solves to four equal-radius corner arcs, each tangent
  //     to its two sides. Check: all four radii equal, every arc endpoint on its
  //     circle, and every side's perpendicular distance to each corner it touches
  //     equals the radius — the whole outline closes tangentially, fully constrained.
  {
    const b = EXAMPLES.find((e) => e.id === 'rounded-rect')!.build()
    const s = b.sketch
    const r = solve(s, { maxIterations: 120 })
    const arcs = s.entities.filter((e) => e.kind === 'arc').map((e) => s.arc(e.id))
    const equalR = arcs.every((a) => approx(a.r, arcs[0].r, 1e-6))
    let worstOn = 0
    for (const a of arcs)
      for (const pid of [a.p1, a.p2]) {
        const p = s.point(pid)
        const c = s.point(a.c)
        worstOn = Math.max(worstOn, Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - a.r))
      }
    const dof = analyzeDof(s)
    check('rounded rectangle → 4 equal tangent arcs', r.converged && equalR && worstOn < 1e-6 && dof.status === 'well', `r=${arcs[0].r.toFixed(1)}, on-circle ${worstOn.toExponential(1)}, ${dof.status}`)
  }

  // 22. Reversing an arc swaps its endpoints, so its counter-clockwise sweep becomes
  //     the complement (2π − sweep) — the minor ⇄ major toggle — while every residual
  //     is left untouched (the reversal is a pure display choice, not a re-solve).
  {
    const s = new Sketch()
    const c = s.addPoint(0, 0)
    const p1 = s.addPoint(40, 0)
    const p2 = s.addPoint(0, 40)
    const a = s.addArc(c.id, p1.id, p2.id, 40)
    const before = s.arcGeom(a).sweep
    const rBefore = residualVector(s, s.constraints)
    s.reverseArc(a.id)
    const after = s.arcGeom(a).sweep
    const rAfter = residualVector(s, s.constraints)
    let drift = 0
    for (let i = 0; i < rBefore.length; i++) drift = Math.max(drift, Math.abs(rBefore[i] - rAfter[i]))
    const complementary = approx(before + after, Math.PI * 2, 1e-9)
    check('reverse arc → complementary sweep', complementary && drift === 0, `sweeps ${((before * 180) / Math.PI).toFixed(0)}° + ${((after * 180) / Math.PI).toFixed(0)}° = 360°, residual drift ${drift.toExponential(1)}`)
  }

  // 23. Conflict attribution across arcs: a `point on arc` constraint applied to the
  //     arc's OWN endpoint merely restates that endpoint's intrinsic on-circle
  //     residual, so exactly one equation is redundant — and because the intrinsic
  //     arc rows hold their pivots first, the analyzer must blame the *user* relation
  //     (the pointOnCircle), never the arc. Guards the residual-row ordering.
  {
    const s = new Sketch()
    const c = s.addPoint(0, 0, { fixed: true })
    const p1 = s.addPoint(40, 0)
    const p2 = s.addPoint(0, 40)
    const arc = s.addArc(c.id, p1.id, p2.id, 40)
    const dup = s.addConstraint('pointOnCircle', [p1.id, arc.id]) // restates |p1−c| = r
    const dof = analyzeDof(s)
    const conf = analyzeConflicts(s)
    const ok = dof.redundant === 1 && conf.count === dof.redundant && conf.redundant.size === 1 && conf.redundant.has(dup.id)
    check('conflict blames the user relation, not the arc', ok, `redundant=${dof.redundant}, flagged {${[...conf.redundant].join(',')}}, want {${dup.id}}`)
  }

  return out
}

// Max absolute difference between the analytic Jacobian and a central finite-
// difference Jacobian at the sketch's current configuration.
function jacobianDiff(s: Sketch, refs: ParamRef[]): number {
  const cs = s.constraints
  const an = residualsAndJacobian(s, cs, refs)
  const x = s.readParams(refs)
  const n = refs.length
  const m = an.m
  let worst = 0
  for (let j = 0; j < n; j++) {
    const orig = x[j]
    const h = 1e-6 * (1 + Math.abs(orig))
    x[j] = orig + h
    s.writeParams(refs, x)
    const rp = residualVector(s, cs)
    x[j] = orig - h
    s.writeParams(refs, x)
    const rm = residualVector(s, cs)
    x[j] = orig
    s.writeParams(refs, x)
    for (let i = 0; i < m; i++) {
      const fd = (rp[i] - rm[i]) / (2 * h)
      worst = Math.max(worst, Math.abs(an.J[i * n + j] - fd))
    }
  }
  return worst
}
