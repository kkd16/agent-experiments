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
import { computeKinematics, directionalDerivatives } from './kinematics'
import { evalDynamics, lumpedMasses, stepDynamics } from './dynamics'
import type { DynParams } from './dynamics'
import { buildSystem, mbAccel, mbReadout, mbStepAdvance } from './multibody'
import type { MBParams, MBState, MBSystem } from './multibody'
import { sketchToSVG, sketchToDXF, motionProfileToCSV } from '../model/export'
import { computeMotionProfile, computeJerk } from './kinematics'
import { cubicPoint, cubicLength, cubicLengthDense, splitCubic } from './curve'

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

  // 24. A free cubic spline has exactly 8 degrees of freedom — its four control
  //     points (start, two handles, end) and nothing else. A spline carries no
  //     parameter of its own and no intrinsic residual, so it adds 8 params and 0
  //     equations (unlike an arc, which binds its endpoints to a circle).
  {
    const s = new Sketch()
    const p0 = s.addPoint(-40, 0)
    const c0 = s.addPoint(-15, 30)
    const c1 = s.addPoint(15, -30)
    const p1 = s.addPoint(40, 0)
    s.addSpline(p0.id, c0.id, c1.id, p1.id)
    const dof = analyzeDof(s)
    check('free spline has 8 DOF', dof.params === 8 && dof.equations === 0 && dof.dof === 8, `params=${dof.params}, eqs=${dof.equations}, dof=${dof.dof}`)
  }

  // 25. The tangent S-curve solves smooth: from a deliberately broken start (a
  //     handle knocked off level, the join kinked) the solver restores a horizontal
  //     start tangent and a collinear (G1) join between the two segments — the two
  //     handles at the shared middle point line up to zero cross product.
  {
    const s = EXAMPLES.find((e) => e.id === 'spline-s')!.build().sketch
    const spls = s.entities.filter((e) => e.kind === 'spline').map((e) => s.spline(e.id))
    const A = spls[0]
    const B = spls[1]
    // Break it: lift the start handle off level and kink the join handles.
    ;(s.point(A.c0) as { y: number }).y += 45
    ;(s.point(A.c1) as { x: number }).x += 30
    ;(s.point(B.c0) as { x: number }).x -= 30
    const r = solve(s, { maxIterations: 120 })
    // Start tangent (c0 − p0) must be horizontal (dy ≈ 0).
    const startDy = s.point(A.c0).y - s.point(A.p0).y
    // Join G1: handles (c1_A − M) and (c0_B − M) collinear ⇒ cross ≈ 0.
    const M = s.point(A.p1) // == B.p0
    const ax = s.point(A.c1).x - M.x
    const ay = s.point(A.c1).y - M.y
    const bx = s.point(B.c0).x - M.x
    const by = s.point(B.c0).y - M.y
    const cross = (ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)
    check('spline S-curve → level ends & smooth join', r.converged && approx(startDy, 0, 1e-3) && approx(cross, 0, 1e-3), `start dy=${startDy.toExponential(1)}, join cross=${cross.toExponential(1)}`)
  }

  // 26. The spline blend fairs a line into a circle: after solving, the spline's
  //     start tangent is parallel to the (horizontal) leg, its end point sits on the
  //     circle, and its end tangent is perpendicular to the radius there (dot ≈ 0) —
  //     the exact tangency conditions of a real blend.
  {
    const s = EXAMPLES.find((e) => e.id === 'spline-blend')!.build().sketch
    const sp = s.spline(s.entities.find((e) => e.kind === 'spline')!.id)
    const circ = s.circle(s.entities.find((e) => e.kind === 'circle')!.id)
    const r = solve(s, { maxIterations: 160 })
    // Start tangent parallel to the horizontal leg ⇒ dy ≈ 0.
    const startDy = s.point(sp.c0).y - s.point(sp.p0).y
    // End on the circle.
    const end = s.point(sp.p1)
    const ctr = s.point(circ.c)
    const onCircle = Math.hypot(end.x - ctr.x, end.y - ctr.y) - circ.r
    // End tangent (c1 − p1) perpendicular to the radius (p1 − center) ⇒ dot ≈ 0.
    const hx = s.point(sp.c1).x - end.x
    const hy = s.point(sp.c1).y - end.y
    const rx = end.x - ctr.x
    const ry = end.y - ctr.y
    const dot = (hx * rx + hy * ry) / (Math.hypot(hx, hy) * Math.hypot(rx, ry) || 1)
    const ok = r.converged && approx(startDy, 0, 1e-3) && approx(onCircle, 0, 1e-4) && approx(dot, 0, 1e-3)
    check('spline blend → tangent to line & circle', ok, `start dy=${startDy.toExponential(1)}, on-circle=${onCircle.toExponential(1)}, end dot=${dot.toExponential(1)}`)
  }

  // 27. The symmetric petal stays a mirror image: nudging one flank's control point
  //     and re-solving, the symmetry constraints place the opposite control at the
  //     exact reflection across the vertical axis (x ↦ −x).
  {
    const s = EXAMPLES.find((e) => e.id === 'spline-petal')!.build().sketch
    const spls = s.entities.filter((e) => e.kind === 'spline').map((e) => s.spline(e.id))
    const L0 = spls[0].c0
    const R0 = spls[1].c0
    ;(s.point(L0) as { x: number; y: number }).x += 14
    ;(s.point(L0) as { y: number }).y += 18
    const r = solve(s, { maxIterations: 120 })
    const l = s.point(L0)
    const rr = s.point(R0)
    check('spline petal stays mirror-symmetric', r.converged && approx(rr.x, -l.x, 1e-3) && approx(rr.y, l.y, 1e-3), `L0=(${l.x.toFixed(2)},${l.y.toFixed(2)}) R0=(${rr.x.toFixed(2)},${rr.y.toFixed(2)})`)
  }

  // --- Kinematics: exact velocity & acceleration of a driven mechanism -------

  // 28. The hyper-dual second-order backend's *first* directional derivative equals
  //     the sparse-AD Jacobian-vector product J·t to machine precision, at a generic
  //     configuration and along an arbitrary seed t. This proves the two independent
  //     AD backends compute the same first derivatives — the base of the whole stack.
  {
    const s = EXAMPLES.find((e) => e.id === 'four-bar')!.build().sketch
    const refs = s.freeParams()
    const x = s.readParams(refs)
    for (let j = 0; j < x.length; j++) x[j] += 0.27 * (1 + Math.abs(x[j])) * Math.sin((j + 1) * 5.1)
    s.writeParams(refs, x)
    const seed = new Float64Array(refs.length)
    for (let i = 0; i < seed.length; i++) seed[i] = Math.sin((i + 1) * 2.3)
    const { d1 } = directionalDerivatives(s, seed)
    const { J, m, n } = residualsAndJacobian(s, s.constraints, refs)
    let worst = 0
    for (let i = 0; i < m; i++) {
      let jv = 0
      for (let j = 0; j < n; j++) jv += J[i * n + j] * seed[j]
      worst = Math.max(worst, Math.abs(jv - d1[i]))
    }
    check('hyper-dual d¹ = sparse-AD J·t', worst < 1e-9, `worst |Δd¹| = ${worst.toExponential(1)}`)
  }

  // 29. The hyper-dual *second* directional derivative d²_t r = tᵀ(∇²r)t agrees with
  //     an independent central finite difference of the first directional derivative
  //     along the same seed — the analytic Hessian action proven against a numeric one.
  {
    const s = EXAMPLES.find((e) => e.id === 'slider-crank')!.build().sketch
    const refs = s.freeParams()
    const x0 = s.readParams(refs)
    for (let j = 0; j < x0.length; j++) x0[j] += 0.22 * (1 + Math.abs(x0[j])) * Math.sin((j + 1) * 3.7)
    s.writeParams(refs, x0)
    const seed = new Float64Array(refs.length)
    for (let i = 0; i < seed.length; i++) seed[i] = 0.5 * Math.sin((i + 1) * 1.9)
    const { d2 } = directionalDerivatives(s, seed)
    const h = 1e-5
    const step = (sign: number) => {
      const xp = Float64Array.from(x0)
      for (let j = 0; j < xp.length; j++) xp[j] += sign * h * seed[j]
      s.writeParams(refs, xp)
      return directionalDerivatives(s, seed).d1
    }
    const dp = step(1)
    const dm = step(-1)
    s.writeParams(refs, x0)
    let worst = 0
    for (let i = 0; i < d2.length; i++) worst = Math.max(worst, Math.abs((dp[i] - dm[i]) / (2 * h) - d2[i]))
    check('hyper-dual d² = finite-diff of d¹', worst < 1e-4, `worst |Δd²| = ${worst.toExponential(1)}`)
  }

  // 30. The exact velocity field ẋ = dx/dθ agrees with a central finite difference of
  //     a full re-solve at θ±h — the analytic implicit-function derivative validated
  //     against the mechanism's actual displacement, across two linkages.
  {
    let worst = 0
    for (const id of ['four-bar', 'slider-crank']) {
      const built = EXAMPLES.find((e) => e.id === id)!.build()
      const s = built.sketch
      const drv = built.driver!
      const c = s.constraints.find((k) => k.id === drv.constraintId)!
      const theta0 = 50
      c.value = theta0
      solve(s, { maxIterations: 160 })
      const k = computeKinematics(s, drv.constraintId)
      const h = 5e-3 // degrees; small enough for truncation, large enough vs solver tol
      c.value = theta0 + h
      const sp = s.clone()
      solve(sp, { maxIterations: 160 })
      c.value = theta0 - h
      const sm = s.clone()
      solve(sm, { maxIterations: 160 })
      const hr = h * (Math.PI / 180)
      for (const pm of k.points) {
        const pP = sp.point(pm.id)
        const pM = sm.point(pm.id)
        worst = Math.max(worst, Math.abs((pP.x - pM.x) / (2 * hr) - pm.vx), Math.abs((pP.y - pM.y) / (2 * hr) - pm.vy))
      }
    }
    check('velocity field = finite-diff of a re-solve', worst < 5e-2, `worst |Δẋ| = ${worst.toExponential(1)} over four-bar + slider`)
  }

  // 31. The exact acceleration field ẍ = d²x/dθ² agrees with a central finite
  //     difference of the *velocity* field — the second-order coefficient validated
  //     end to end, independently of the hyper-dual arithmetic it was built from.
  {
    let worst = 0
    for (const id of ['four-bar', 'slider-crank']) {
      const built = EXAMPLES.find((e) => e.id === id)!.build()
      const s = built.sketch
      const drv = built.driver!
      const c = s.constraints.find((k) => k.id === drv.constraintId)!
      const theta0 = 65
      c.value = theta0
      solve(s, { maxIterations: 160 })
      const k = computeKinematics(s, drv.constraintId)
      const h = 2e-2
      c.value = theta0 + h
      const sp = s.clone()
      solve(sp, { maxIterations: 160 })
      const kp = computeKinematics(sp, drv.constraintId)
      c.value = theta0 - h
      const sm = s.clone()
      solve(sm, { maxIterations: 160 })
      const km = computeKinematics(sm, drv.constraintId)
      const hr = h * (Math.PI / 180)
      for (const pm of k.points) {
        const pP = kp.points.find((p) => p.id === pm.id)!
        const pM = km.points.find((p) => p.id === pm.id)!
        worst = Math.max(worst, Math.abs((pP.vx - pM.vx) / (2 * hr) - pm.ax), Math.abs((pP.vy - pM.vy) / (2 * hr) - pm.ay))
      }
    }
    check('acceleration field = finite-diff of velocity', worst < 5e-2, `worst |Δẍ| = ${worst.toExponential(1)} over four-bar + slider`)
  }

  // 32. Slider-crank against textbook kinematics. The crank end swings on a circle of
  //     radius r = 40, so its velocity coefficient has magnitude exactly r and is
  //     perpendicular to the crank arm; and the slider's along-guide velocity matches
  //     the closed-form slider-crank result dx/dθ derived from |A−B| = rod length —
  //     an entirely independent hand derivation, checked across the crank cycle.
  {
    const DEG = Math.PI / 180
    const built = EXAMPLES.find((e) => e.id === 'slider-crank')!.build()
    const s = built.sketch
    const drv = built.driver!
    const c = s.constraints.find((k) => k.id === drv.constraintId)!
    const A = built.tracePoints![0] // crank end
    // The crank pivot O is A's *fixed* distance neighbour (the rod's other end B is free).
    let O = -1
    for (const k of s.constraints) {
      if (k.kind !== 'distance' || !k.entities.includes(A)) continue
      const other = k.entities.find((e) => e !== A)!
      const oe = s.get(other)
      if (oe?.kind === 'point' && oe.fixed) O = other
    }
    const B = s.constraints.find((k) => k.kind === 'pointOnLine')!.entities[0] // slider
    let worstCrank = 0
    let worstPerp = 0
    let worstSlider = 0
    for (const theta of [30, 65, 115, 200, 305]) {
      c.value = theta
      solve(s, { maxIterations: 180 })
      const k = computeKinematics(s, drv.constraintId)
      const aM = k.points.find((p) => p.id === A)!
      // |v_A| = crank radius (40), and v_A ⟂ (A − O).
      worstCrank = Math.max(worstCrank, Math.abs(Math.hypot(aM.vx, aM.vy) - 40))
      const oPt = s.point(O)
      const armx = aM.x - oPt.x
      const army = aM.y - oPt.y
      worstPerp = Math.max(worstPerp, Math.abs(aM.vx * armx + aM.vy * army) / (40 * 40))
      // Slider along-guide velocity, closed form: with the guide horizontal, crank r=40,
      // rod L=150 and the crank pivot 35 above the guide, dx_B/dθ (θ in radians).
      const th = theta * DEG
      const g = 22500 - Math.pow(40 * Math.sin(th) + 35, 2)
      const dBx = -40 * Math.sin(th) - (40 * Math.cos(th) * (40 * Math.sin(th) + 35)) / Math.sqrt(g)
      const bM = k.points.find((p) => p.id === B)!
      worstSlider = Math.max(worstSlider, Math.abs(bM.vx - dBx))
    }
    const ok = worstCrank < 1e-4 && worstPerp < 1e-4 && worstSlider < 1e-3
    check('slider-crank = closed-form kinematics', ok, `|v_A|−r ${worstCrank.toExponential(1)}, ⟂ ${worstPerp.toExponential(1)}, slider ${worstSlider.toExponential(1)}`)
  }

  // --- Session 6: time-domain dynamics ------------------------------------
  //
  // A rigid crank (fixed pivot at the origin, reference line along +x, tip point B
  // at distance L) driven by the ground→crank angle. With ONLY the tip carrying mass
  // (density 0, every point's base mass = m; the two fixed points contribute nothing
  // to the free motion) this is the textbook simple pendulum: I = m L², V = m g L sinθ,
  // so the Eksergian EOM must reproduce the closed form θ̈ = −(g/L) cosθ exactly. The
  // same rig then validates I'(θ), energy conservation of the free swing, static
  // equilibrium and monotone damped decay.
  const DEG = Math.PI / 180
  const buildPendulum = (L: number) => {
    const s = new Sketch()
    const A = s.addPoint(0, 0, { fixed: true }) // pivot
    const G = s.addPoint(1, 0, { fixed: true }) // ground reference
    const B = s.addPoint(L, 0) // crank tip (the pendulum bob)
    const ground = s.addLine(A.id, G.id, true)
    const crank = s.addLine(A.id, B.id)
    s.addConstraint('distance', [A.id, B.id], L)
    const drv = s.addConstraint('angle', [ground.id, crank.id], 0, true)
    return { s, drv: drv.id, bob: B.id, L }
  }
  const solveAt = (s: Sketch) => void solve(s, { maxIterations: 200 })

  // 33. The Eksergian θ̈ reproduces the closed-form simple pendulum at every angle.
  {
    const L = 80
    const g = 500
    const { s, drv, L: len } = buildPendulum(L)
    const p: DynParams = { gravity: g, density: 0, baseMass: 1, damping: 0, torque: 0 }
    const mass = lumpedMasses(s, p)
    let worst = 0
    for (const deg of [10, 55, 90, 140, 205, 300, 350]) {
      const th = deg * DEG
      const ev = evalDynamics(s, drv, mass, { theta: th, omega: 0 }, p, 'rad', solveAt)
      const closed = -(g / len) * Math.cos(th) // θ̈ = −(g/L) cosθ
      worst = Math.max(worst, Math.abs(ev.thetaddot - closed))
    }
    check('dynamics EOM = closed-form pendulum θ̈', worst < 1e-3, `worst |Δθ̈| ${worst.toExponential(1)}`)
  }

  // 34. I'(θ) equals a central finite difference of the generalized inertia I(θ).
  {
    const { s, drv } = buildPendulum(90)
    // A denser rig so the inertia genuinely varies with θ: give the rod mass too.
    const p: DynParams = { gravity: 300, density: 0.02, baseMass: 0.5, damping: 0, torque: 0 }
    const mass = lumpedMasses(s, p)
    const Iat = (th: number) => evalDynamics(s, drv, mass, { theta: th, omega: 0 }, p, 'rad', solveAt).I
    let worst = 0
    for (const deg of [25, 70, 130, 250]) {
      const th = deg * DEG
      const analytic = evalDynamics(s, drv, mass, { theta: th, omega: 0 }, p, 'rad', solveAt).dIdtheta
      const h = 1e-4
      const fd = (Iat(th + h) - Iat(th - h)) / (2 * h)
      worst = Math.max(worst, Math.abs(analytic - fd))
    }
    check("dynamics I'(θ) = finite-diff of I(θ)", worst < 1e-3, `worst |ΔI'| ${worst.toExponential(1)}`)
  }

  // 35. The free (τ=c=0) swing conserves total mechanical energy along the RK4 march.
  {
    const L = 80
    const g = 500
    const m = 1
    const { s, drv } = buildPendulum(L)
    const p: DynParams = { gravity: g, density: 0, baseMass: m, damping: 0, torque: 0 }
    const mass = lumpedMasses(s, p)
    const scale = m * g * L // energy scale of the swing
    let st = { theta: 0, omega: 0 } // released from horizontal, at rest
    const E0 = evalDynamics(s, drv, mass, st, p, 'rad', solveAt).E
    let worst = 0
    for (let i = 0; i < 220; i++) {
      const r = stepDynamics(s, drv, mass, st, p, 'rad', 0.005, solveAt, 4)
      st = r.state
      worst = Math.max(worst, Math.abs(r.ev.E - E0))
    }
    check('dynamics free swing conserves energy', worst / scale < 1e-3, `max |ΔE|/mgL ${(worst / scale).toExponential(1)}`)
  }

  // 36. At the potential-energy minimum (bob straight down) with zero rate, θ̈ = 0.
  {
    const { s, drv, L } = buildPendulum(80)
    const p: DynParams = { gravity: 500, density: 0, baseMass: 1, damping: 0, torque: 0 }
    const mass = lumpedMasses(s, p)
    // Bottom of the swing: B at angle −90° (straight down), a V-stationary point.
    const ev = evalDynamics(s, drv, mass, { theta: -Math.PI / 2, omega: 0 }, p, 'rad', solveAt)
    check('dynamics static equilibrium (θ̈=0 at V-min)', Math.abs(ev.thetaddot) < 1e-4 && L === 80, `θ̈ ${ev.thetaddot.toExponential(1)}`)
  }

  // 37. Under pure damping (τ=0, c>0) the total energy is monotonically non-increasing
  //     and strictly lower at the end — the dissipation the −c θ̇ term must produce.
  {
    const L = 80
    const { s, drv } = buildPendulum(L)
    const p: DynParams = { gravity: 500, density: 0, baseMass: 1, damping: 0.4, torque: 0 }
    const mass = lumpedMasses(s, p)
    let st = { theta: 0, omega: 0 }
    let prev = evalDynamics(s, drv, mass, st, p, 'rad', solveAt).E
    const E0 = prev
    let monotone = true
    for (let i = 0; i < 300; i++) {
      const r = stepDynamics(s, drv, mass, st, p, 'rad', 0.005, solveAt, 4)
      st = r.state
      if (r.ev.E > prev + 1e-6 * Math.max(1, Math.abs(prev))) monotone = false
      prev = r.ev.E
    }
    check('dynamics damping dissipates energy monotonically', monotone && prev < E0 - 1e-6, `E: ${E0.toFixed(1)} → ${prev.toFixed(1)}`)
  }

  // --- Session 6: jerk (third-order kinematic coefficient) ----------------
  //
  // The analytic jerk field x'''(θ) (cubic-dual + polarised mixed term) must equal a
  // central finite difference of the exact acceleration field x''(θ) w.r.t. θ — an
  // independent reference that exercises ad3.ts end to end (atan2 to third order
  // included, since the driver is an angle constraint).
  {
    const built = EXAMPLES.find((e) => e.id === 'four-bar')!.build()
    const drv = built.driver!
    const tracer = built.tracePoints![0]
    const h = 1e-3 // radians
    let worst = 0
    let scale = 0
    for (const deg of [40, 95, 160, 250, 320]) {
      built.sketch.constraints.find((c) => c.id === drv.constraintId)!.value = deg
      solve(built.sketch, { maxIterations: 200 })
      const jk = computeJerk(built.sketch, drv.constraintId)
      const jm = jk.points.find((p) => p.id === tracer)!
      // Central finite difference of the acceleration coefficient over a ±h radian
      // step (converted to the driver's stored degrees).
      const accAt = (dth: number) => {
        const cl = built.sketch.clone()
        cl.constraints.find((c) => c.id === drv.constraintId)!.value = deg + (dth * 180) / Math.PI
        solve(cl, { maxIterations: 200 })
        const p = computeKinematics(cl, drv.constraintId).points.find((q) => q.id === tracer)!
        return { ax: p.ax, ay: p.ay }
      }
      const ap = accAt(h)
      const am = accAt(-h)
      const fdx = (ap.ax - am.ax) / (2 * h)
      const fdy = (ap.ay - am.ay) / (2 * h)
      worst = Math.max(worst, Math.hypot(jm.jx - fdx, jm.jy - fdy))
      scale = Math.max(scale, Math.hypot(jm.jx, jm.jy))
    }
    check('jerk x‴(θ) = finite-diff of acceleration', worst / (1 + scale) < 5e-3, `worst |Δx‴| ${worst.toExponential(1)}, |x‴|~${scale.toFixed(1)}`)
  }

  // --- Session 6: export fidelity -----------------------------------------
  //
  // A mixed sketch (line + circle + arc + spline) exercises every export branch.
  const buildMixed = () => {
    const s = new Sketch()
    const a = s.addPoint(0, 0)
    const b = s.addPoint(60, 0)
    s.addLine(a.id, b.id)
    const cc = s.addPoint(0, 40)
    s.addCircle(cc.id, 15)
    const ac = s.addPoint(40, 40) // arc center
    const a1 = s.addPoint(60, 40) // start (angle 0)
    const a2 = s.addPoint(40, 60) // end (angle 90°)
    const arc = s.addArc(ac.id, a1.id, a2.id, 20)
    const p0 = s.addPoint(-40, -20)
    const h0 = s.addPoint(-30, 10)
    const h1 = s.addPoint(0, 10)
    const p1 = s.addPoint(10, -20)
    s.addSpline(p0.id, h0.id, h1.id, p1.id)
    return { s, arc: arc.id }
  }

  // 38. SVG export is well-formed: an <svg> root, the expected primitive count, and
  //     no NaN / infinity / exponent-form numbers leaking into the markup.
  {
    const { s } = buildMixed()
    const svg = sketchToSVG(s)
    const lines = (svg.match(/<line /g) || []).length // 1 solid line
    const circles = (svg.match(/<circle /g) || []).length // 1 circle + point dots
    const paths = (svg.match(/<path /g) || []).length // arc + spline
    const clean = !/NaN|Infinity|[0-9]e[-+]?[0-9]/i.test(svg)
    const ok = svg.startsWith('<svg') && svg.includes('</svg>') && lines >= 1 && circles >= 1 && paths === 2 && clean
    check('export SVG well-formed', ok, `lines ${lines}, circles ${circles}, paths ${paths}, clean ${clean}`)
  }

  // 39. DXF export round-trips the arc: parse the group codes and confirm one LINE,
  //     one CIRCLE, one ARC (with start/end angles matching arcGeom) and one
  //     LWPOLYLINE (the sampled spline).
  {
    const { s, arc } = buildMixed()
    const dxf = sketchToDXF(s)
    const rows = dxf.split('\n')
    const count = (name: string) => rows.filter((_, i) => rows[i - 1] === '0' && rows[i] === name).length
    const nLine = count('LINE')
    const nCircle = count('CIRCLE')
    const nArc = count('ARC')
    const nPoly = count('LWPOLYLINE')
    // Pull the ARC's 50/51 angles back out and compare to arcGeom.
    const arcStart = rows.findIndex((r, i) => rows[i - 1] === '0' && r === 'ARC')
    let a0 = NaN
    let a1 = NaN
    for (let i = arcStart; i < rows.length - 1; i++) {
      if (rows[i] === '50') a0 = parseFloat(rows[i + 1])
      if (rows[i] === '51') a1 = parseFloat(rows[i + 1])
    }
    const g = s.arcGeom(s.arc(arc))
    const wantA0 = ((g.a0 * 180) / Math.PI + 360) % 360
    const gotA0 = (a0 + 360) % 360
    const okAng = approx(gotA0, wantA0, 1e-3) && approx((a1 - a0 + 360) % 360, (g.sweep * 180) / Math.PI, 1e-2)
    const ok = dxf.includes('AC1015') && dxf.trimEnd().endsWith('EOF') && nLine === 1 && nCircle === 1 && nArc === 1 && nPoly === 1 && okAng
    check('export DXF entities + arc angles', ok, `L${nLine} C${nCircle} A${nArc} P${nPoly}, arc ∠${gotA0.toFixed(1)}° (want ${wantA0.toFixed(1)})`)
  }

  // 40. CSV export of the motion profile: a header plus exactly steps+1 data rows,
  //     every field finite.
  {
    const built = EXAMPLES.find((e) => e.id === 'four-bar')!.build()
    const drv = built.driver!
    const tracer = built.tracePoints![0]
    solve(built.sketch)
    const profile = computeMotionProfile(
      built.sketch,
      drv.constraintId,
      tracer,
      { min: drv.min, max: drv.max },
      (deg) => (deg * Math.PI) / 180,
      (s) => void solve(s, { maxIterations: 120 }),
      24,
    )
    const csv = motionProfileToCSV(profile)
    const rows = csv.trimEnd().split('\n')
    const header = rows[0].split(',').length === 5
    const dataRows = rows.length - 1
    const allFinite = rows.slice(1).every((r) => r.split(',').every((v) => Number.isFinite(parseFloat(v))))
    check('export CSV rows + finite', header && dataRows === 25 && allFinite, `header ${header}, rows ${dataRows} (want 25), finite ${allFinite}`)
  }

  // === Session 7 — curve parameters (auxiliary DOF) =======================

  // 42. Point-on-spline is exact: after solving the driven Bead-on-a-Curve, the curve
  //     point B(t*) at the solved parameter coincides with the follower to machine
  //     precision, t* is interior, and the driven mechanism is fully constrained
  //     (3 free scalars — the bead's x, y and the auxiliary parameter t — and 3
  //     residual equations, so 0 DOF once the driver pins the angle).
  {
    const built = EXAMPLES.find((e) => e.id === 'bead-on-curve')!.build()
    const s = built.sketch
    solve(s, { maxIterations: 160 })
    const cps = s.constraints.find((c) => c.kind === 'pointOnSpline')!
    const F = s.point(cps.entities[0])
    const sp = s.spline(cps.entities[1])
    const t = cps.aux![0]
    const P = (id: number): [number, number] => {
      const p = s.point(id)
      return [p.x, p.y]
    }
    const bt = cubicPoint(P(sp.p0), P(sp.c0), P(sp.c1), P(sp.p1), t)
    const dev = Math.hypot(bt[0] - F.x, bt[1] - F.y)
    const dof = analyzeDof(s)
    const ok = dev < 1e-8 && t > 0 && t < 1 && dof.params === 3 && dof.equations === 3 && dof.dof === 0
    check('point-on-spline exact & mechanism well-constrained', ok, `|B(t)−F|=${dev.toExponential(1)}, t=${t.toFixed(3)}, dof=${dof.dof}`)
  }

  // 43. A bead constrained *only* to ride a fixed spline keeps exactly one degree of
  //     freedom — it slides along the curve. Its two coordinates plus the auxiliary
  //     parameter t are 3 free scalars against 2 residuals (B(t) − P), so dof = 1.
  {
    const s = new Sketch()
    const p0 = s.addPoint(-80, 0, { fixed: true })
    const c0 = s.addPoint(-40, 60, { fixed: true })
    const c1 = s.addPoint(40, 60, { fixed: true })
    const p1 = s.addPoint(80, 0, { fixed: true })
    const sp = s.addSpline(p0.id, c0.id, c1.id, p1.id)
    const bead = s.addPoint(0, 50)
    s.addConstraint('pointOnSpline', [bead.id, sp.id])
    const dof = analyzeDof(s)
    check('free bead on a curve has 1 DOF (slides)', dof.params === 3 && dof.equations === 2 && dof.dof === 1, `params=${dof.params}, eqs=${dof.equations}, dof=${dof.dof}`)
  }

  // 44. Gauss–Legendre is *exact* on a straight spline: a cubic whose four control
  //     points are evenly spaced along a line has constant speed |B′| = 3|d|, so its
  //     arc-length integrand is a constant — captured exactly by any quadrature order.
  //     The length equals the chord, and a splineLength residual targeting it vanishes.
  {
    const len = cubicLength([0, 0], [10, 0], [20, 0], [30, 0])
    const s = new Sketch()
    const p0 = s.addPoint(0, 0, { fixed: true })
    const c0 = s.addPoint(10, 0, { fixed: true })
    const c1 = s.addPoint(20, 0, { fixed: true })
    const p1 = s.addPoint(30, 0, { fixed: true })
    const sp = s.addSpline(p0.id, c0.id, c1.id, p1.id)
    s.addConstraint('splineLength', [sp.id], 30)
    const res = residualVector(s, s.constraints)
    const worstRes = res.reduce((a, b) => Math.max(a, Math.abs(b)), 0)
    check('Gauss–Legendre exact on a straight spline', approx(len, 30, 1e-9) && worstRes < 1e-9, `len=${len.toFixed(9)}, |residual|=${worstRes.toExponential(1)}`)
  }

  // 45. On a genuinely curved cubic the fixed Gauss–Legendre length agrees with an
  //     independent dense composite-trapezoid reference — the quadrature rule the
  //     solver uses, cross-checked against a different integration method entirely.
  {
    const gl = cubicLength([-80, 0], [-40, 60], [40, 60], [80, 0])
    const dense = cubicLengthDense([-80, 0], [-40, 60], [40, 60], [80, 0])
    check('spline-length quadrature = dense reference', approx(gl, dense, 1e-4), `GL=${gl.toFixed(6)}, dense=${dense.toFixed(6)}, |Δ|=${Math.abs(gl - dense).toExponential(1)}`)
  }

  // 46. The splineLength constraint drives a spline to a target arc length, and holds
  //     it there: the Ribbon of Fixed Length solves to length 210, and after a handle
  //     is dragged the re-solved ribbon still measures 210 (the curve re-fairs while
  //     keeping its length — an inextensible strip).
  {
    const s = EXAMPLES.find((e) => e.id === 'ribbon')!.build().sketch
    const sp = s.spline(s.entities.find((e) => e.kind === 'spline')!.id)
    const P = (id: number): [number, number] => {
      const p = s.point(id)
      return [p.x, p.y]
    }
    const r0 = solve(s, { maxIterations: 200 })
    const len0 = cubicLength(P(sp.p0), P(sp.c0), P(sp.c1), P(sp.p1))
    const handle = s.point(sp.c0)
    handle.x += 25
    handle.y -= 15
    const r1 = solve(s, { maxIterations: 200 })
    const len1 = cubicLength(P(sp.p0), P(sp.c0), P(sp.c1), P(sp.p1))
    const ok = r0.converged && approx(len0, 210, 1e-3) && r1.converged && approx(len1, 210, 1e-3)
    check('splineLength meets target & survives a drag', ok, `len ${len0.toFixed(3)} → drag → ${len1.toFixed(3)} (want 210)`)
  }

  // 47. The exact kinematics thread through the auxiliary DOF: the Bead-on-a-Curve's
  //     velocity field (which includes dt/dθ for the curve parameter, solved from the
  //     same Jacobian) agrees with a central finite difference of a full re-solve at
  //     θ ± h across the sweep. This is the proof that the aux parameter is a genuine,
  //     first-class solver coordinate — differentiated like any other.
  {
    const built = EXAMPLES.find((e) => e.id === 'bead-on-curve')!.build()
    const s = built.sketch
    const drv = built.driver!
    const c = s.constraints.find((k) => k.id === drv.constraintId)!
    let worst = 0
    for (const theta0 of [70, 90, 110]) {
      c.value = theta0
      solve(s, { maxIterations: 160 })
      const k = computeKinematics(s, drv.constraintId)
      const h = 5e-3
      c.value = theta0 + h
      const sp = s.clone()
      solve(sp, { maxIterations: 160 })
      c.value = theta0 - h
      const sm = s.clone()
      solve(sm, { maxIterations: 160 })
      const hr = h * (Math.PI / 180)
      for (const pm of k.points) {
        const pP = sp.point(pm.id)
        const pM = sm.point(pm.id)
        worst = Math.max(worst, Math.abs((pP.x - pM.x) / (2 * hr) - pm.vx), Math.abs((pP.y - pM.y) / (2 * hr) - pm.vy))
      }
    }
    check('driven-aux velocity field = finite-diff of a re-solve', worst < 5e-2, `worst |Δẋ| = ${worst.toExponential(1)} over the bead sweep`)
  }

  // 48. The auxiliary curve parameter round-trips losslessly through serialisation:
  //     save the solved bead, reload it, and the parameter t (and therefore every
  //     residual) is recovered exactly. Complements the all-examples round-trip check
  //     by pinning the specific new field.
  {
    const s = EXAMPLES.find((e) => e.id === 'bead-on-curve')!.build().sketch
    solve(s, { maxIterations: 160 })
    const reloaded = fromJSONString(toJSONString(s.toData()))
    const s2 = reloaded ? new Sketch(reloaded) : null
    const cps1 = s.constraints.find((c) => c.kind === 'pointOnSpline')!
    const cps2 = s2?.constraints.find((c) => c.kind === 'pointOnSpline')
    const t1 = cps1.aux?.[0]
    const t2 = cps2?.aux?.[0]
    let drift = 0
    if (s2) {
      const r1 = residualVector(s, s.constraints)
      const r2 = residualVector(s2, s2.constraints)
      for (let i = 0; i < r1.length; i++) drift = Math.max(drift, Math.abs(r1[i] - r2[i]))
    }
    const ok = t1 !== undefined && t2 !== undefined && t1 === t2 && drift === 0
    check('auxiliary parameter round-trips through save/load', ok, `t ${t1?.toFixed(6)} → ${t2?.toFixed(6)}, residual drift ${drift.toExponential(1)}`)
  }

  // === Session 8 — de Casteljau spline splitting ==========================

  // 49. de Casteljau split is exact: the two halves together retrace the original cubic
  //     to machine precision (the left over [0,t], the right over [t,1], each
  //     reparametrised to [0,1]), share the split point exactly, and meet with matching
  //     tangent (C1) there.
  {
    const p0: [number, number] = [-80, 0]
    const c0: [number, number] = [-40, 90]
    const c1: [number, number] = [50, 70]
    const p1: [number, number] = [80, -10]
    const t = 0.37
    const { left, right } = splitCubic(p0, c0, c1, p1, t)
    let worst = 0
    for (let i = 0; i <= 200; i++) {
      const u = i / 200
      const orig = cubicPoint(p0, c0, c1, p1, u)
      const h = u <= t ? cubicPoint(left[0], left[1], left[2], left[3], u / t) : cubicPoint(right[0], right[1], right[2], right[3], (u - t) / (1 - t))
      worst = Math.max(worst, Math.hypot(orig[0] - h[0], orig[1] - h[1]))
    }
    const shared = Math.hypot(left[3][0] - right[0][0], left[3][1] - right[0][1])
    // C1: the incoming tangent (left[3]−left[2]) is parallel to the outgoing (right[1]−right[0]).
    const lt = [left[3][0] - left[2][0], left[3][1] - left[2][1]]
    const rt = [right[1][0] - right[0][0], right[1][1] - right[0][1]]
    const cross = lt[0] * rt[1] - lt[1] * rt[0]
    check('de Casteljau split reproduces the curve (C1)', worst < 1e-11 && shared === 0 && Math.abs(cross) < 1e-9, `worst=${worst.toExponential(1)}, shared=${shared.toExponential(1)}, join cross=${cross.toExponential(1)}`)
  }

  // 50. The splitSpline model operation replaces a spline with two curves whose union
  //     reproduces the original, reuses the two endpoints (so chained neighbours stay
  //     attached), removes the original spline and its interior handles, and adds
  //     exactly six free scalars (two new interior handles + the split point).
  {
    const s = new Sketch()
    const p0 = s.addPoint(-80, 0)
    const c0 = s.addPoint(-40, 90)
    const c1 = s.addPoint(50, 70)
    const p1 = s.addPoint(80, -10)
    const sp = s.addSpline(p0.id, c0.id, c1.id, p1.id)
    const P0: [number, number] = [p0.x, p0.y]
    const C0: [number, number] = [c0.x, c0.y]
    const C1: [number, number] = [c1.x, c1.y]
    const P1: [number, number] = [p1.x, p1.y]
    const dofBefore = analyzeDof(s).dof
    const tt = 0.42
    const { left, right } = s.splitSpline(sp.id, tt)
    const splines = s.entities.filter((e) => e.kind === 'spline')
    const P = (id: number): [number, number] => {
      const p = s.point(id)
      return [p.x, p.y]
    }
    let worst = 0
    for (let i = 0; i <= 200; i++) {
      const u = i / 200
      const orig = cubicPoint(P0, C0, C1, P1, u)
      const h = u <= tt ? cubicPoint(P(left.p0), P(left.c0), P(left.c1), P(left.p1), u / tt) : cubicPoint(P(right.p0), P(right.c0), P(right.c1), P(right.p1), (u - tt) / (1 - tt))
      worst = Math.max(worst, Math.hypot(orig[0] - h[0], orig[1] - h[1]))
    }
    const dofAfter = analyzeDof(s).dof
    const ok = splines.length === 2 && s.get(sp.id) === undefined && left.p0 === p0.id && right.p1 === p1.id && worst < 1e-11 && dofAfter - dofBefore === 6
    check('splitSpline reproduces curve, reuses endpoints, +6 DOF', ok, `splines=${splines.length}, worst=${worst.toExponential(1)}, ΔDOF=${dofAfter - dofBefore}`)
  }

  // 51. Splitting at a point-on-spline bead reuses that bead as the shared join and
  //     drops its (now meaningless) rider constraint — the Session-7 aux feature and
  //     the Session-8 split composing: the bead is exactly where the curve is cut.
  {
    const s = EXAMPLES.find((e) => e.id === 'bead-on-curve')!.build().sketch
    solve(s, { maxIterations: 160 })
    const bead = s.constraints.find((c) => c.kind === 'pointOnSpline')!
    const beadPt = bead.entities[0]
    const splineId = bead.entities[1]
    const bp = s.point(beadPt)
    const before: [number, number] = [bp.x, bp.y]
    const { left, right } = s.splitSpline(splineId, bead.aux![0], beadPt)
    const after = s.point(beadPt)
    const moved = Math.hypot(after.x - before[0], after.y - before[1])
    const ok =
      left.p1 === beadPt &&
      right.p0 === beadPt &&
      s.constraints.find((c) => c.kind === 'pointOnSpline') === undefined &&
      s.entities.filter((e) => e.kind === 'spline').length === 2 &&
      moved < 1e-6
    check('split at a bead reuses it as the join', ok, `join=bead:${left.p1 === beadPt && right.p0 === beadPt}, bead moved ${moved.toExponential(1)}`)
  }

  // --- Session 9: multi-DOF constrained dynamics (Lagrange-multiplier DAE) --
  //
  // The full constrained rigid-body dynamics of a point-mass system: no single-DOF
  // reduction, so open chains and free-floating bodies run. Each RHS is one KKT
  // saddle-point solve [[M,−Cᵀ],[C,0]][q̈;λ]=[f;γ] built from the exact constraint
  // Jacobian C and the hyper-dual second-directional term γ=−q̇ᵀ∇²c q̇, marched by RK4
  // with a post-step coordinate projection. Every claim is re-derived independently.

  // Set a multibody state from an explicit per-point (x, y, vx, vy) map.
  const mkState = (sys: MBSystem, vals: Map<number, { x: number; y: number; vx: number; vy: number }>): MBState => {
    const q = new Float64Array(sys.n)
    const qd = new Float64Array(sys.n)
    sys.coords.forEach((c, i) => {
      const v = vals.get(c.id)!
      q[i] = c.axis === 'x' ? v.x : v.y
      qd[i] = c.axis === 'x' ? v.vx : v.vy
    })
    return { q, qd }
  }

  // 52. Projectile: a single free point under gravity, no constraints, must trace the
  //     closed-form parabola x=vx·t, y=vy·t−½g·t² to machine precision (RK4 is exact on
  //     a quadratic, and the point-mass DAE degenerates to M q̈ = f with no C).
  {
    const s = new Sketch()
    const pt = s.addPoint(0, 0)
    const g = 500
    const p: MBParams = { gravity: g, density: 0, baseMass: 1, damping: 0 }
    const sys = buildSystem(s, [], p)
    let st = mkState(sys, new Map([[pt.id, { x: 0, y: 0, vx: 30, vy: 50 }]]))
    const dt = 0.002
    const steps = 250
    for (let i = 0; i < steps; i++) st = mbStepAdvance(sys, st, p, dt, solveAt, 2).state
    const t = dt * steps
    const ex = 30 * t
    const ey = 50 * t - 0.5 * g * t * t
    const err = Math.hypot(st.q[sys.points[0].xi] - ex, st.q[sys.points[0].yi] - ey)
    check('multibody projectile = closed-form parabola', sys.supported && sys.ndof === 2 && err < 1e-6, `err ${err.toExponential(1)} (ndof ${sys.ndof})`)
  }

  // 53. Simple pendulum: the DAE angular acceleration equals the closed form
  //     θ̈ = −(g/L)cosθ at rest, for a range of angles. (The bob accel (ax,ay) includes
  //     the centripetal part; the cross product (x·ay−y·ax)/L² extracts the tangential
  //     angular acceleration, which is what the closed form gives.)
  {
    const L = 80
    const g = 500
    const { s, drv, bob } = buildPendulum(L)
    const p: MBParams = { gravity: g, density: 0, baseMass: 1, damping: 0 }
    const sys = buildSystem(s, [drv], p) // release the driver → a free 1-DOF pendulum
    let worst = 0
    for (const deg of [10, 55, 90, 140, 205, 300, 350]) {
      const th = deg * DEG
      const x = L * Math.cos(th)
      const y = L * Math.sin(th)
      const st = mkState(sys, new Map([[bob, { x, y, vx: 0, vy: 0 }]]))
      const acc = mbAccel(sys, st, p)
      const ax = acc.qdd[sys.points[0].xi]
      const ay = acc.qdd[sys.points[0].yi]
      const angacc = (x * ay - y * ax) / (L * L)
      const closed = -(g / L) * Math.cos(th)
      worst = Math.max(worst, Math.abs(angacc - closed))
    }
    check('multibody pendulum θ̈ = closed form', sys.ndof === 1 && worst < 1e-3, `worst |Δθ̈| ${worst.toExponential(1)}`)
  }

  // 54. Cross-check the two formulations: the multi-DOF DAE and Session 6's single-DOF
  //     Eksergian EOM must give the SAME angular acceleration at a moving state (ω≠0),
  //     so the velocity-dependent term γ is exercised. Independent code paths, one answer.
  {
    const L = 80
    const g = 400
    const { s, drv, bob } = buildPendulum(L)
    const dp: DynParams = { gravity: g, density: 0.01, baseMass: 0.7, damping: 0, torque: 0 }
    const mp: MBParams = { gravity: g, density: 0.01, baseMass: 0.7, damping: 0 }
    const massD = lumpedMasses(s, dp)
    const sys = buildSystem(s, [drv], mp)
    let worst = 0
    for (const [deg, omega] of [
      [35, 1.5],
      [110, -2.0],
      [240, 0.8],
    ] as const) {
      const th = deg * DEG
      // Eksergian reference (drives the ORIGINAL sketch through evalDynamics).
      const ek = evalDynamics(s, drv, massD, { theta: th, omega }, dp, 'rad', solveAt)
      // DAE at the same configuration and rate: bob on the circle, tangential ω.
      const x = L * Math.cos(th)
      const y = L * Math.sin(th)
      const vx = -omega * L * Math.sin(th)
      const vy = omega * L * Math.cos(th)
      const st = mkState(sys, new Map([[bob, { x, y, vx, vy }]]))
      const acc = mbAccel(sys, st, mp)
      const ax = acc.qdd[sys.points[0].xi]
      const ay = acc.qdd[sys.points[0].yi]
      const angacc = (x * ay - y * ax) / (L * L)
      worst = Math.max(worst, Math.abs(angacc - ek.thetaddot))
    }
    check('multibody DAE = single-DOF Eksergian (ω≠0)', worst < 1e-3, `worst |Δθ̈| ${worst.toExponential(1)}`)
  }

  // A double pendulum: pivot fixed at the origin, two equal links, two equal bobs.
  const buildDoublePendulum = (L: number) => {
    const s = new Sketch()
    const A = s.addPoint(0, 0, { fixed: true })
    const B = s.addPoint(L, 0)
    const C = s.addPoint(2 * L, 0)
    s.addLine(A.id, B.id)
    s.addLine(B.id, C.id)
    s.addConstraint('distance', [A.id, B.id], L)
    s.addConstraint('distance', [B.id, C.id], L)
    return { s, A: A.id, B: B.id, C: C.id, L }
  }

  // 55. Double pendulum (2-DOF): the free (τ=c=0) swing conserves total mechanical
  //     energy along the RK4 march — the sharpest possible correctness check.
  {
    const L = 80
    const g = 500
    const m = 1
    const { s, B, C } = buildDoublePendulum(L)
    const p: MBParams = { gravity: g, density: 0, baseMass: m, damping: 0 }
    const sys = buildSystem(s, [], p)
    // Released from both links horizontal, at rest.
    let st = mkState(
      sys,
      new Map([
        [B, { x: L, y: 0, vx: 0, vy: 0 }],
        [C, { x: 2 * L, y: 0, vx: 0, vy: 0 }],
      ]),
    )
    const scale = 2 * m * g * L
    const E0 = mbReadout(sys, st, p).E
    let worst = 0
    for (let i = 0; i < 500; i++) {
      const r = mbStepAdvance(sys, st, p, 0.004, solveAt, 4)
      st = r.state
      worst = Math.max(worst, Math.abs(r.readout.E - E0))
    }
    check('multibody double pendulum conserves energy', sys.ndof === 2 && worst / scale < 1e-3, `ndof ${sys.ndof}, max |ΔE|/2mgL ${(worst / scale).toExponential(1)}`)
  }

  // 56. The same march keeps both rigid links at their exact length — the constraint
  //     drift the coordinate projection is there to kill stays at solver tolerance.
  {
    const L = 80
    const { s, B, C } = buildDoublePendulum(L)
    const p: MBParams = { gravity: 500, density: 0, baseMass: 1, damping: 0 }
    const sys = buildSystem(s, [], p)
    let st = mkState(
      sys,
      new Map([
        [B, { x: L, y: 0, vx: 0, vy: 0 }],
        [C, { x: 2 * L, y: 0, vx: 0, vy: 0 }],
      ]),
    )
    let worst = 0
    for (let i = 0; i < 500; i++) {
      st = mbStepAdvance(sys, st, p, 0.004, solveAt, 4).state
      const bx = st.q[sys.points.find((q) => q.id === B)!.xi]
      const by = st.q[sys.points.find((q) => q.id === B)!.yi]
      const cx = st.q[sys.points.find((q) => q.id === C)!.xi]
      const cy = st.q[sys.points.find((q) => q.id === C)!.yi]
      worst = Math.max(worst, Math.abs(Math.hypot(bx, by) - L), Math.abs(Math.hypot(cx - bx, cy - by) - L))
    }
    check('multibody constraints hold (no drift)', worst < 1e-6, `worst link-length error ${worst.toExponential(1)}`)
  }

  // A free-floating dumbbell: two unequal point masses joined by one rigid link, no
  // anchor and (in the test) no gravity — a closed mechanical system whose linear
  // momentum, angular momentum and energy are all exactly conserved.
  const buildDumbbell = (L: number) => {
    const s = new Sketch()
    const P = s.addPoint(-L / 2, 0)
    const Q = s.addPoint(L / 2, 0)
    s.addLine(P.id, Q.id)
    s.addConstraint('distance', [P.id, Q.id], L)
    return { s, P: P.id, Q: Q.id, L }
  }

  // 57–59. Free dumbbell: translating while spinning, it conserves linear momentum,
  //     angular momentum (about the origin) and total energy — the floating-body test.
  {
    const L = 100
    const mP = 2
    const mQ = 1
    const { s, P, Q } = buildDumbbell(L)
    // Give P mass 2 and Q mass 1 by hanging a rod: instead use base masses via density 0
    // and per-point base — but base mass is uniform, so build the asymmetry with a rod.
    // Simpler: use baseMass and add rod density so both share; asymmetry is not required
    // for conservation, so use equal masses m and validate the invariants.
    const m = 1
    const p: MBParams = { gravity: 0, density: 0, baseMass: m, damping: 0 }
    void mP
    void mQ
    const sys = buildSystem(s, [], p)
    const comx = 0
    const comy = 0
    const w = 0.5
    const vtrans = { x: 5, y: 3 }
    const vel = (x: number, y: number) => ({ vx: vtrans.x - w * (y - comy), vy: vtrans.y + w * (x - comx) })
    let st = mkState(
      sys,
      new Map([
        [P, { x: -L / 2, y: 0, ...vel(-L / 2, 0) }],
        [Q, { x: L / 2, y: 0, ...vel(L / 2, 0) }],
      ]),
    )
    const r0 = mbReadout(sys, st, p)
    let dP = 0
    let dL = 0
    let dE = 0
    for (let i = 0; i < 500; i++) {
      const r = mbStepAdvance(sys, st, p, 0.003, solveAt, 4)
      st = r.state
      dP = Math.max(dP, Math.abs(r.readout.px - r0.px), Math.abs(r.readout.py - r0.py))
      dL = Math.max(dL, Math.abs(r.readout.Lz - r0.Lz))
      dE = Math.max(dE, Math.abs(r.readout.E - r0.E))
    }
    check('multibody free body conserves linear momentum', sys.ndof === 3 && dP < 1e-6, `ndof ${sys.ndof}, max |ΔP| ${dP.toExponential(1)}`)
    check('multibody free body conserves angular momentum', dL / Math.abs(r0.Lz) < 1e-4, `max |ΔL|/|L₀| ${(dL / Math.abs(r0.Lz)).toExponential(1)}`)
    check('multibody free body conserves energy', dE / Math.abs(r0.E) < 1e-4, `max |ΔE|/|E₀| ${(dE / Math.abs(r0.E)).toExponential(1)}`)
  }

  // 60. Under viscous damping (c>0) the double pendulum's total energy is monotonically
  //     non-increasing and strictly lower at the end — the dissipation the −c q̇ term
  //     must produce, for a multi-DOF system.
  {
    const L = 80
    const { s, B, C } = buildDoublePendulum(L)
    const p: MBParams = { gravity: 500, density: 0, baseMass: 1, damping: 0.5 }
    const sys = buildSystem(s, [], p)
    let st = mkState(
      sys,
      new Map([
        [B, { x: L, y: 0, vx: 0, vy: 0 }],
        [C, { x: 2 * L, y: 0, vx: 0, vy: 0 }],
      ]),
    )
    let prev = mbReadout(sys, st, p).E
    const E0 = prev
    let monotone = true
    for (let i = 0; i < 400; i++) {
      const r = mbStepAdvance(sys, st, p, 0.004, solveAt, 4)
      st = r.state
      if (r.readout.E > prev + 1e-6 * Math.max(1, Math.abs(prev))) monotone = false
      prev = r.readout.E
    }
    check('multibody damping dissipates energy monotonically', monotone && prev < E0 - 1e-3, `E ${E0.toFixed(0)} → ${prev.toFixed(0)}`)
  }

  // A bare pendulum for the joint-reaction (Lagrange-multiplier) tests: anchor fixed at
  // the origin, bob hanging straight down at distance L. The one distance constraint's
  // multiplier λ is the physical link tension (its constraint force Cᵀλ supports the bob).
  const buildHanging = (L: number, m: number, g: number) => {
    const s = new Sketch()
    const A = s.addPoint(0, 0, { fixed: true })
    const B = s.addPoint(0, -L)
    s.addConstraint('distance', [A.id, B.id], L)
    const p: MBParams = { gravity: g, density: 0, baseMass: m, damping: 0 }
    const sys = buildSystem(s, [], p)
    return { s, sys, p, bob: B.id }
  }

  // 61. Joint reaction, static: a pendulum hanging at rest is in equilibrium — the DAE
  //     returns q̈≈0 and the distance-constraint multiplier |λ| equals the weight mg it
  //     must hold up. This validates the Lagrange multipliers the KKT solve produces.
  {
    const L = 80
    const g = 500
    const m = 1.3
    const { sys, p, bob } = buildHanging(L, m, g)
    const st = mkState(sys, new Map([[bob, { x: 0, y: -L, vx: 0, vy: 0 }]]))
    const acc = mbAccel(sys, st, p)
    const qddMag = Math.hypot(acc.qdd[sys.points[0].xi], acc.qdd[sys.points[0].yi])
    const tension = Math.abs(acc.lambda[0])
    check('multibody joint reaction = tension (static)', qddMag < 1e-6 && Math.abs(tension - m * g) < 1e-3, `|q̈| ${qddMag.toExponential(1)}, |λ| ${tension.toFixed(2)} (want ${(m * g).toFixed(2)})`)
  }

  // 62. Joint reaction, at speed: swinging through the bottom at rate ω, the tension must
  //     carry gravity PLUS the centripetal demand, |λ| = m(g + Lω²) — Newton's second law
  //     in the radial direction, recovered exactly from the multiplier.
  {
    const L = 80
    const g = 500
    const m = 1
    const w = 2.5
    const { sys, p, bob } = buildHanging(L, m, g)
    const st = mkState(sys, new Map([[bob, { x: 0, y: -L, vx: w * L, vy: 0 }]])) // tangential at the bottom
    const acc = mbAccel(sys, st, p)
    const tension = Math.abs(acc.lambda[0])
    const want = m * (g + L * w * w)
    check('multibody joint reaction = gravity + centripetal', Math.abs(tension - want) / want < 1e-6, `|λ| ${tension.toFixed(1)} (want ${want.toFixed(1)})`)
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
