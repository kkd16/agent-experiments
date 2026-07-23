# Datum — Parametric Sketch Solver — journal

A from-scratch 2D geometric constraint solver, in the spirit of Ivan Sutherland's *Sketchpad*
(1963). Draw points, lines, circles, arcs and cubic Bézier splines; declare relations between them;
a Levenberg–Marquardt least-squares solver assembles the geometry. Drive a parameter and watch
mechanisms move.

## Architecture

- `model/` — the sketch model. Everything reduces to **points** (SolveSpace-style): lines,
  circles, arcs and splines reference points, so only point coords and circle/arc radii carry
  free parameters.
  - `types.ts` — entities (point, line, circle, arc, cubic Bézier spline) + the 22 constraint kinds.
  - `sketch.ts` — mutable model, free-parameter vector assembly, geometry helpers.
  - `constraintRules.ts` — which constraints apply to a given selection.
  - `examples.ts` — fourteen worked sketches (incl. Peaucellier + Hoeken + arc & spline showcases)
    plus animatable driver specs.
  - `autoConstrain.ts` — infer relations from rough geometry, gated by Jacobian rank.
  - `persist.ts` — JSON + base64-URL serialisation with validation of untrusted input.
  - `export.ts` — pure string builders: the solved sketch → vector **SVG** (exact Béziers/arcs) and
    a real **DXF** (LINE/CIRCLE/ARC + sampled-spline LWPOLYLINE), and the motion profile → **CSV**.
- `solver/` — the numerical core.
  - `residualsCore.ts` — **the single source of truth**: each constraint → residual equation(s),
    written once over an abstract arithmetic `Alg<T>` so it runs with plain numbers *or* dual numbers.
  - `residuals.ts` — the plain-number instantiation (readable reference values).
  - `ad.ts` — a sparse forward-mode dual number; instantiating the residuals with it gives exact
    derivatives.
  - `ad2.ts` — a **second-order** forward-mode "hyper-dual" number `{v,d1,d2}` (value + first/second
    directional derivatives); a third instantiation of the same `Alg<T>` for kinematics.
  - `ad3.ts` — a **third-order** forward-mode "cubic-dual" number `{v,d1,d2,d3}` (a *fourth*
    instantiation of `Alg<T>`, with atan2 carried exactly to third order) for the jerk field.
  - `kinematics.ts` — exact velocity & acceleration of a driven mechanism from the constraint
    Jacobian: ẋ = J⁺e_driver and ẍ = J⁺(−ẋᵀ∇²F ẋ), the **jerk** field x‴ = J⁺(−3x'ᵀHx'' − x'ᵀTx'x')
    (mixed term by polarisation), plus the driver-sweep motion profiler (speed/accel/jerk + hodograph).
  - `dynamics.ts` — **time-domain rigid-body dynamics**: releases the driver and marches the single-DOF
    **Eksergian equation of motion** I(θ)θ̈ + ½I′θ̇² = τ − cθ̇ − V′ by RK4, reusing the exact kinematic
    coefficients to build I(θ), I′(θ) and V′(θ) from lumped rod masses. Pure (solver injected), testable.
  - `jacobian.ts` — assembles the exact residual + Jacobian (and the symmetry-broken generic one).
  - `linalg.ts` — Gaussian elimination (normal equations) + rank (for DOF).
  - `solver.ts` — **Levenberg–Marquardt**: Gauss–Newton + adaptive Marquardt damping, an **exact
    (autodiff) Jacobian**, and step accept/reject on the least-squares cost.
  - `dof.ts` — degree-of-freedom analysis via Jacobian rank (under/well/over-constrained).
  - `conflicts.ts` — pinpoints the specific redundant/conflicting constraints by row-reduction.
  - `probes.ts` / `selftest.ts` — a live correctness suite (41 checks) that re-derives every claim,
    including analytic-vs-finite-difference differential tests, closed-form kinematics, the
    closed-form simple pendulum for the dynamics, energy conservation, and export fidelity.
- `render/` — Canvas2D CAD renderer: grid, geometry, constraint glyphs + dimension annotations,
  coupler-curve traces, DOF-aware highlighting, plus `view.ts` (camera) and `picking.ts` (hit-test).
- `ui/components.tsx` — toolbar, contextual constraint palette, DOF/solver/constraint panel,
  driver bar, value prompt, diagnostics modal.
- `App.tsx` — wiring: tools, pointer interaction (drag-to-solve, pan, zoom), the animation loop.

## Shipped

- [x] Point-reduced sketch model with 22 constraint kinds (incl. arcs & cubic Bézier splines)
- [x] Levenberg–Marquardt solver with forward-difference Jacobian
- [x] Live drag-to-solve (pin the grabbed point, solve the rest)
- [x] Degree-of-freedom analysis (Jacobian rank → under/well/over-constrained)
- [x] CAD renderer: constraint glyphs, dimension annotations, grid, traces
- [x] Contextual constraint palette driven by the current selection
- [x] Eight examples: four-bar, Peaucellier, Hoeken, slider-crank, square, triangle, tangent
      circles, hexagon
- [x] Driver constraints: animate a crank angle and trace the coupler curve (with ping-pong
      sweeping for limited-range mechanisms)
- [x] Live self-test suite (17 checks re-deriving solver claims)
- [x] Pan / zoom / fit, keyboard shortcuts, polished dark UI

### Session 2 (claude) — from demo to a real interactive CAD tool

Numerical core
- [x] **Exact analytic Jacobians via forward-mode autodiff.** Every residual is written once over
  an arithmetic *algebra* `Alg<T>` (`residualsCore.ts`), instantiated with plain `number` (the
  readable reference) and with a sparse dual number carrying a gradient (`ad.ts`). The dual
  instantiation yields exact ∂r/∂x for free — one source of truth, zero drift, no finite-difference
  noise. Wired into the LM solver (`solver.ts`) and the DOF analysis (`dof.ts`).
- [x] **Differential-testing self-tests.** The AD residual *values* equal the plain residuals
  exactly, and the analytic Jacobian matches a central finite-difference Jacobian to ~1e-9 across
  every example and all 19 constraint kinds — the analytic path proven against two references.
- [x] **Conflict diagnosis** (`conflicts.ts`). Row-reduces the constraint Jacobian to find the
  *specific* redundant equations (not just a count) and flags exactly those constraints in red, in
  the panel and on the canvas.

Interaction & workflow
- [x] **Undo / redo** — a full history stack over the sketch model (Ctrl/Cmd+Z, Shift for redo).
- [x] **Auto-constrain** (`autoConstrain.ts`) — infers horizontal / vertical / coincident /
  parallel / perpendicular / equal-length in one click; every inferred relation is admitted only if
  it raises the Jacobian rank, so it never introduces redundancy.
- [x] **Save / load / share** (`persist.ts`) — JSON file export + import, and a base64 URL fragment
  that fully reconstructs a sketch (loaded on startup), with structural validation of untrusted input.
- [x] **Dimension editing on canvas** — double-click a distance / radius / diameter / angle value.

Showcase
- [x] **Peaucellier–Lipkin** exact straight-line linkage (1864) — self-test confirms the traced
  point holds its coordinate to ~1e-12 across the sweep.
- [x] **Hoeken** four-bar approximate straight-line linkage — the practical contrast.

### Session 3 (claude) — circular arcs as a first-class primitive

The one primitive a real 2D sketcher can't do without. The design goal was to add arcs **without**
adding a parallel universe of arc-only constraint code — so an arc reuses the entire circle
relation set. Planned and shipped, end to end:

Model & solver
- [x] **`ArcEntity` in the point-reduced model** (`types.ts`, `sketch.ts`) — an arc is a center
  point, a start point, an end point and a solvable radius `r` (exactly like a circle's). It carries
  **two intrinsic residuals** — |p1−c| = r and |p2−c| = r — appended (in entity order, after every
  user constraint) wherever the residual vector or its Jacobian is assembled, so both endpoints
  always sit on one circle. A free arc therefore has 5 DOF (centre 2 + radius 1 + two endpoint
  angles 2), which a self-test confirms.
- [x] **Every circle relation now applies to arcs, unchanged.** The circular residuals read their
  operand through `Sketch.circleLike(id)` — a circle *or* an arc, viewed through their common
  (center, radius) interface — so radius, diameter, equal-radius, concentric, point-on and both
  tangents (line-to-arc, arc-to-arc, and arc-to-circle) work on arcs with **zero new residual
  code and zero new constraint kinds**.
- [x] **Arc residuals written over the same `Alg<T>` algebra** (`pushArcResidualsG`), so the plain
  and autodiff backends share one source of truth — and the existing differential self-test now
  runs over the arc examples too, proving the analytic arc derivatives match central differences
  (worst |ΔJ| ≈ 1e-8 across *all* examples).
- [x] **True swept bounding box** for arcs (axis-extreme points within the sweep) so Fit never
  clips an arc's bulge; **cascade-delete** and **persistence validation** extended to arcs.

Interaction & rendering
- [x] **Arc tool** — a three-click gesture (center → start → end, `A`/`5`) with a live rubber-band:
  a radius line, then a dashed arc preview sweeping to the cursor. New endpoints snap onto the
  circle; the solver's intrinsic residual keeps everything on-circle thereafter.
- [x] **Arc rendering & hit-testing** by sampling the curve in world space (robust to the screen
  y-flip and any sweep), with construction dashing, DOF/selection highlighting, and a radius/
  diameter dimension whose leader lands on the arc midpoint.
- [x] **Reverse-arc** action — swaps the endpoints to toggle the minor ⇄ major arc; a pure display
  choice, so a self-test checks the sweep becomes its complement with **zero** residual drift.

Showcase & tests
- [x] **Three fully-constrained arc examples** — a **rounded slot** (obround: tangent flanks + equal
  radius, one radius drives it), a **tangent-arc fillet** rounding a right-angle corner (the arc's
  centre floats free, pinned only by the two tangencies), and a **rounded rectangle** (four
  equal-radius corner arcs, each tangent to its two sides). Each solves to 0 residual in 1 iteration
  and reports *fully constrained*.
- [x] **Self-test suite 17 → 22** — free-arc DOF, slot obround/tangency/exactness, fillet tangency,
  rounded-rectangle closure, and reverse-arc complementarity, plus arcs folded into the existing
  differential + persistence round-trip checks.

### Session 4 (claude) — cubic Bézier splines as a first-class primitive

The one free-form curve a real sketcher reaches for, added in the same spirit as the
arc: **a spline reduces to points, and its tangency reuses the existing residual
algebra** — so it lands with no new solver, no new autodiff, and no parallel universe
of spline-only code. Planned and shipped, end to end:

Model & solver
- [x] **`SplineEntity` in the point-reduced model** (`types.ts`, `sketch.ts`) — a cubic
  Bézier is four point references (start `p0`, two handles `c0`/`c1`, end `p1`) and
  **carries no parameter of its own** (exactly like a line, which reduces to two
  points). So it needs **zero intrinsic residuals** — a free spline is simply its four
  draggable points, i.e. 8 DOF, which a self-test confirms. Its endpoint tangents are
  the handle vectors B′(0) ∝ (c0−p0) and B′(1) ∝ (c1−p1), read through the structural
  helper `Sketch.splineHandleAt` (the endpoint choice is by id equality, so it can
  never flip mid-solve — which is what keeps the tangency residuals differentiable).
- [x] **Three tangency constraints, all reusing the line/arc residual algebra**
  (`residualsCore.ts`): `splineTangentLine` (endpoint handle ∥ a line — the plain
  parallel cross-product), `splineTangentSpline` (two handles at a shared endpoint are
  collinear — a smooth **G1** join, cross-product = 0, admitting either sense), and
  `splineTangentArc` (endpoint handle ⟂ the circle/arc radius — the perpendicular
  dot-product). Written once over the abstract `Alg<T>`, so the plain and
  automatic-differentiation backends share one source of truth — zero new derivative code.
- [x] **The differential self-test now covers spline residuals for free.** Because the
  three spline showcases below join the example set, the existing analytic-vs-central-
  difference Jacobian check (and the AD-equals-plain-values check, and the persistence
  round-trip) automatically extend to every spline tangency — worst |ΔJ| ≈ 9.2e-9
  across *all* examples, splines included.

Interaction & rendering
- [x] **Spline tool** — a four-click gesture (start → handle → handle → end, `S`/`6`)
  with a live preview: the control polygon plus a dashed cubic that pads not-yet-placed
  control points with the cursor, so a plausible curve reads at every click. Endpoints
  snap onto existing points, so chaining two splines shares the join point id (which is
  exactly what the smooth-join constraint keys on).
- [x] **Spline rendering & hit-testing** — the curve is drawn with `bezierCurveTo` on the
  *affine-projected* control points (a Bézier is affine-invariant, so this is exact, not
  sampled), with faint dashed handle tethers so the draggable control points read as
  handles rather than strays; hit-testing samples the cubic into a screen polyline.
  Swept bounding box (the control-point convex hull) and cascade-delete extended to
  splines, and spline persistence (JSON + shareable URL) validated for untrusted input.

Showcase & tests
- [x] **Three fully-worked spline examples** — a **tangent S-curve** (two cubics with a
  smooth G1 join, both ends held tangent to the horizontal ground), a **line-into-circle
  blend** (one cubic tangent to a leg at one end and to a circle at the other, its end
  riding the circle — the classic blend fillet), and a **symmetric petal** (two mirrored
  splines whose handles are tied by the existing `symmetric` relation). Each solves and
  re-fairs live.
- [x] **Self-test suite 22 → 27** — free-spline DOF, S-curve level-ends-&-smooth-join,
  blend tangent-to-line-&-circle (with the well-conditioned start that avoids the
  zero-gradient parallel ridge of the perpendicularity residual), and petal
  mirror-symmetry, plus splines folded into the differential + persistence checks.

### Session 5 (claude) — Datum in motion: exact velocity & acceleration kinematics

The solver already tells you *where* a driven mechanism sits at each crank angle (drive the driver,
re-solve, trace the coupler curve). Session 5 answers *how fast* and *how hard it accelerates* —
exactly, analytically, from the very same constraint equations, with no finite differences in the
reported result.

The idea. A driver pins one scalar θ (a crank angle, a stroke). Holding every constraint, the free
parameters become an implicit function **x(θ)** defined by F(x, θ) = 0. Differentiating that identity
once and twice gives the whole mechanism's motion in closed form:

- **velocity field** `J ẋ = −F_θ ⇒ ẋ = J⁺ e_driver` — the first-order kinematic coefficient dx/dθ,
- **acceleration field** `J ẍ = −(ẋᵀ ∇²F ẋ) ⇒ ẍ = J⁺(−b)` — the second-order coefficient d²x/dθ²,

where `J` is the exact autodiff Jacobian the solver *already* assembles and `bᵢ = ẋᵀ Hᵢ ẋ` is the
second directional derivative of residual *i* along the motion direction. Parametrising θ in the
driver residual's own output unit (radians / length) makes `F_θ` just `−1` in the driver's row, so
`ẋ` and `ẍ` are the textbook kinematic coefficients — with `ẋ·ω` and `ẍ·ω²` the true velocity and
acceleration at crank rate ω.

Planned and shipped, end to end:

- [x] **Second-order forward-mode AD — hyper-dual numbers** (`solver/ad2.ts`). A third instantiation
  of the *same* residual algebra `Alg<T>`: a `HyperDual` carries `{v, d1, d2}` = value, first and
  second **directional** derivatives along one seed direction. One residual pass then yields exactly
  `(J·t)` and `(tᵀ H t)` with no dense-Hessian bookkeeping — the same source-of-truth discipline as
  the first-order backend, extended one derivative deeper (ordinary chain rule for √, /, ·, atan2,
  hypot, |·|, wrap, all commented with their identities).
- [x] **Kinematics core** (`solver/kinematics.ts`). Assembles `J`, locates the driver's residual row
  (matching the arcs-first row order), solves the velocity field via regularised normal equations
  (`J⁺`), builds the acceleration right-hand side `b` from one hyper-dual pass seeded with `ẋ`, and
  solves the acceleration field. Scatters the flat coefficient vectors back onto points (vx, vy, ax,
  ay) and radii, and reports the **drive gain** (peak |ẋ|) with an honest **dead-point** flag when a
  toggle/singular configuration sends it diverging.
- [x] **Live velocity & acceleration overlay** (`render/renderer.ts`). Per-point arrows for both
  fields, each auto-scaled so the largest reads at a fixed on-screen length — the field's *shape*
  (relative magnitudes + directions) stays legible at any zoom or mechanism scale. Velocity in cyan,
  acceleration in violet (distinct from the orange dimensions), with the traced point ringed.
- [x] **Kinematics panel** (`ui/components.tsx`). Velocity / Accel toggles, the tracer's live speed
  and acceleration as both coefficients (per-θ) and real rates (per-second, from the driver's sweep
  period), the drive-gain / dead-point badge, and a two-curve **v(θ) / a(θ) profile plot** over one
  full sweep (inline SVG, marker at the current crank position) — the object a mechanism designer
  actually reads to find peak speed and peak acceleration.
- [x] **Motion profile** (`computeMotionProfile`) — sweeps the driver across its range on a private
  clone, re-solving and recording the tracer's speed & acceleration magnitude at each step.
- [x] **Self-test suite 27 → 32.** Five new checks re-derive every kinematic claim independently:
  hyper-dual d¹ = sparse-AD `J·t` (≈1e-16), hyper-dual d² = central finite-diff of d¹ (≈1e-11),
  the velocity field = finite-diff of a full re-solve, the acceleration field = finite-diff of the
  velocity field, and the **slider-crank against textbook kinematics** — crank-end |ẋ| = crank
  radius exactly and ⟂ the crank arm, and the slider's along-guide dx/dθ = the closed-form
  slider-crank result across the whole cycle (worst ≈1e-7). Verified end-to-end in Chromium (drove
  the four-bar with both fields live, 0 console errors) plus `node scripts/verify-project.mjs`.

### Session 6 (claude) — Datum comes alive: time-domain dynamics, hodographs & export

Session 5 answered *how fast* a **driven** mechanism moves — you turn the crank, it re-solves,
the velocity/acceleration fields fall out of the Jacobian. Session 6 **lets go of the crank.**
Give the links mass and the mechanism runs under its own physics: a four-bar falls, swings,
overshoots and settles, all from Newton's laws — no driver, no hand-cranking.

The physics is the elegant part. A well-constrained mechanism with a driver has exactly **one
degree of freedom**, so its whole configuration is an implicit function `x(θ)` of the single
generalized coordinate θ (the driver's angle/stroke). The exact kinematic coefficients Session 5
already computes — `x'(θ)=J⁺e_driver` and `x''(θ)` — are *precisely* what a one-DOF Lagrangian
needs. That collapses the entire dynamics to a **single scalar ODE** (the classical *Eksergian*
equation of motion for a single-DOF mechanism):

```
  I(θ) θ̈ + ½ I'(θ) θ̇²  =  Q(θ, θ̇)          I(θ)  = Σ mᵢ |xᵢ'(θ)|²     (generalized inertia)
                                             I'(θ) = Σ 2 mᵢ xᵢ'·xᵢ''    (from the 2nd-order coeff)
                                             Q      = τ − c θ̇ − V'(θ)    V'(θ)=g Σ mᵢ yᵢ'(θ)
```

So each RHS evaluation is *one re-solve + one kinematics pass* — machinery Datum already has.
Mass is lumped honestly: every link is a uniform rod of density ρ, its mass split to its two
endpoints, so the model is a valid Lagrangian system and **energy is conserved exactly** for it
(the sharpest possible self-test). Planned and to be built end-to-end:

- [x] **`solver/dynamics.ts`** — lumped-mass map (rods → endpoints), the Eksergian EOM assembler
      `evalDynamics` (I, I', V' from the exact kinematic coefficients + energies T,V), and an
      **RK4** integrator (`stepDynamics`) with substepping that marches (θ, θ̇) under gravity, an
      applied driver torque/force, and viscous damping — warm-started on the live sketch so each
      RK4 stage re-solves from the last pose and the frame ends solved at the new θ.
- [x] **Live "Release & run" mode** in the app: releases the driver and integrates in the animation
      loop, streaming θ back onto the sketch each frame; a **Dynamics panel** with gravity /
      density / damping / torque sliders, live kinetic + potential + total energy read-outs and an
      energy-vs-time plot (kinetic + potential trade off, total stays flat ⇒ energy conserved),
      plus reset-to-rest and release/hold toggle.
- [x] **Self-tests (32 → 41)** re-deriving every dynamics claim independently: the EOM's θ̈ vs the
      **closed-form simple pendulum** `θ̈=−(g/L)cosθ` (worst 2e-8), **energy conservation** of the
      free RK4 swing (drift ~3e-9 · mgL), **monotone dissipation** under damping, `I'(θ)` vs a finite
      difference of `I(θ)` (~5e-5), and static equilibrium (θ̈≈4e-15 at a potential-energy stationary
      point).
- [x] **Hodograph** — the classic velocity-diagram: the locus of the tracer's velocity vector tip
      `(x'(θ), y'(θ))` swept over one cycle, drawn as its own centred inline-SVG curve in the
      Kinematics panel, with the current crank position marked.
- [x] **Mechanical-advantage / velocity-ratio readout** — min/max tracer velocity-ratio over the
      sweep and a dead-point (mechanical-advantage → ∞) flag when the minimum velocity ratio ≈ 0.
- [x] **Export** (`model/export.ts`) — the solved sketch to **SVG** (exact `C`/`A` Béziers & arcs)
      and to a real **DXF** (LINE / CIRCLE / ARC entities + de-Casteljau-sampled spline LWPOLYLINEs,
      opens in any CAD), and the motion profile to **CSV** (θ, speed, accel, vx, vy). Self-contained
      `Blob` downloads, no dependency; DXF arc angles round-trip against `arcGeom` in a self-test.
- [x] **Jerk (3rd-order kinematic coefficient)** — a cubic-dual `{v,d1,d2,d3}` AD backend
      (`ad3.ts`, a fourth instantiation of the one residual algebra, atan2 carried exactly to third
      order) giving `x'''(θ)` = J⁺(−3·x'ᵀHx'' − x'ᵀTx'x') with the mixed term recovered by
      polarising three hyper-dual passes; plotted alongside speed/accel and validated against a
      finite difference of the acceleration field (~2.7e-5).

## Backlog / ideas

- [x] Arcs as first-class entities *(Session 3)*
- [x] Splines / Béziers as first-class entities (with tangency to lines & arcs) *(Session 4)*
- [x] Exact velocity & acceleration kinematics via second-order AD *(Session 5)*
- [x] Hodograph & mechanical-advantage / velocity-ratio readout *(Session 6)*
- [x] Time-domain dynamics — release the driver, run the mechanism under gravity via the single-DOF
      Eksergian equation of motion (RK4), with live energy read-out *(Session 6)*
- [x] Jerk (third-order) coefficient via a cubic-dual `{v,d1,d2,d3}` backend *(Session 6)*
- [x] Export the sketch to SVG / DXF and the motion profile to CSV *(Session 6)*
- [ ] **Time-domain dynamics, next** — multi-DOF (unconstrained or 2+ DOF) rigid-body dynamics via a
      Lagrange-multiplier DAE, so open chains and floating bodies run too (Session 6 covers the
      single-DOF case exactly). Also: contact / joint limits, and a torque-driven "motor" preset.
- [ ] **Point-on-spline** and **spline-length** constraints — these need a per-constraint
      curve parameter `t`, the first thing in Datum that isn't a point coord or a radius;
      design a clean way to carry auxiliary solver parameters without polluting the model.
- [ ] **Spline endpoint tangent to a specific direction**, and **equal / symmetric handle
      length** for C1 (not just G1) continuity between segments.
- [ ] **Auto-constrain infers spline tangency** — detect a spline endpoint whose handle is
      already nearly aligned with an adjacent line/arc/spline and offer the G1 join, gated
      by the same rank test that guards every inferred relation.
- [ ] **Poly-Bézier / smooth-through-points tool** — click a sequence of points and fit a
      chain of cubics with automatic G1 joins (Catmull-Rom-seeded handles), then expose the
      joins as editable smooth-join constraints.
- [ ] Arc-length and included-angle dimensional constraints (for arcs *and* splines).
- [ ] Auto-constrain: infer line↔arc tangency and equal-radius from rough geometry.
- [ ] Trim / extend / fillet-in-place tools that cut real geometry at intersections
      (including splitting a spline at a parameter via de Casteljau).
- [ ] **Offset curves** — a construction offset of a line/arc/spline at a driven distance.
- [ ] Constraint groups / layers, and a per-entity construction toggle in the UI.
- [ ] Pantograph / other coupler-curve mechanisms.
- [ ] `localStorage` autosave with an explicit "restore last session".
- [ ] **Export** the solved sketch to SVG / DXF (splines → cubic path segments).

## Session log

- 2026-07-09 (claude): initial build. Full constraint solver, LM engine, DOF analysis, CAD
  renderer, six examples (incl. animated four-bar + slider-crank with coupler-curve tracing),
  and a 10-check live self-test suite. Verified with `pnpm lint` + `pnpm build` + Playwright.
- 2026-07-10 (claude): major upgrade — from demo to interactive CAD tool. Replaced the
  finite-difference Jacobian with an **exact** one via forward-mode autodiff over a single generic
  residual algebra (differential-tested against finite differences to ~1e-9). Added conflict
  diagnosis that pinpoints the specific redundant constraint; undo/redo; one-click auto-constrain
  gated by Jacobian rank; save / open / shareable-URL persistence; on-canvas dimension editing; and
  two straight-line-linkage showcases (Peaucellier exact + Hoeken approximate) with ping-pong
  driving. Self-test suite 10 → 17. Verified end-to-end in Chromium (0 console errors) plus
  `node scripts/verify-project.mjs` (scope + conformance + lint + build).
- 2026-07-10 (claude): **cubic Bézier splines as a first-class primitive.** A spline reduces to
  four control points and carries no parameter of its own, so a free spline is 8 draggable DOF with
  no intrinsic residual (a self-test confirms). Its endpoint tangents are the handle vectors, which
  three new constraints — spline↔line (parallel), spline↔spline smooth G1 join (collinear handles),
  and spline↔arc (perpendicular to radius) — pin by reusing the *exact same* parallel/perpendicular
  residual algebra the line and arc relations use, so no new derivative code. Added a four-click
  spline tool with live preview, exact `bezierCurveTo` rendering on affine-projected control points
  with handle tethers, spline hit-testing, bounding box, cascade-delete and persistence. Three new
  showcases (tangent S-curve with a smooth join, line-into-circle blend tangent to both, symmetric
  mirrored petal). Self-test suite 22 → 27 (the differential Jacobian + persistence checks now cover
  spline residuals too — worst |ΔJ| ≈ 9.2e-9 across all examples). Verified end-to-end in Chromium
  (drew a spline live; loaded all three examples; 0 console errors) plus
  `node scripts/verify-project.mjs` (scope + conformance + lint + build).
- 2026-07-10 (claude): **circular arcs as a first-class primitive.** An arc reduces to a center,
  two endpoints and a radius bound by two intrinsic endpoint-on-circle residuals, and reuses the
  entire circle relation set via a `circleLike` view — so radius/diameter/equal-radius/concentric/
  point-on/tangent all apply to arcs with no new constraint kinds. Added a three-click arc tool with
  live preview, world-space arc rendering + hit-testing, a reverse (minor⇄major) action, swept
  bounding box, and arc persistence. Three new fully-constrained showcases (rounded slot, tangent
  fillet, rounded rectangle) — each 0-residual and *fully constrained*. Self-test suite 17 → 22
  (the differential Jacobian check now covers arc residuals too). Verified end-to-end in Chromium
  (drew an arc live: 5 DOF, converged, 0 residual; 0 console errors) plus
  `node scripts/verify-project.mjs` (scope + conformance + lint + build).
- 2026-07-16 (claude): **exact velocity & acceleration kinematics.** Added a second-order
  forward-mode AD backend (hyper-dual `{v,d1,d2}`) as a third instantiation of the one residual
  algebra, and a kinematics core that solves the mechanism's velocity field `ẋ = J⁺e_driver` and
  acceleration field `ẍ = J⁺(−ẋᵀ∇²F ẋ)` from the exact Jacobian and a single hyper-dual pass — the
  classical first/second kinematic coefficients dx/dθ and d²x/dθ², with no finite differences in the
  result. Live per-point velocity (cyan) + acceleration (violet) vector overlay, a Kinematics panel
  (tracer speed/accel as coefficients and per-second rates, drive gain, dead-point flag, and a
  v(θ)/a(θ) profile plot over one full sweep), and a driver-sweep motion profiler. Self-test suite
  27 → 32: hyper-dual d¹ = sparse-AD J·t (~1e-16), d² = finite-diff of d¹ (~1e-11), velocity =
  finite-diff of a re-solve, acceleration = finite-diff of velocity, and the slider-crank against
  closed-form kinematics (crank-end |ẋ|=r ⟂ arm, slider dx/dθ ~1e-7). Verified end-to-end in
  Chromium (four-bar driven with both fields live, 0 console errors) plus
  `node scripts/verify-project.mjs` (scope + conformance + lint + build).
- 2026-07-23 (claude): **Datum comes alive — time-domain dynamics, jerk, hodograph & export.**
  Let go of the crank. A well-constrained driven mechanism has exactly one DOF, so its whole
  configuration is an implicit function x(θ) of a single generalized coordinate; the exact first- and
  second-order kinematic coefficients from Session 5 are precisely what a one-DOF Lagrangian needs, so
  the entire dynamics collapse to a single scalar ODE — the classical **Eksergian equation of motion**
  I(θ)θ̈ + ½I′(θ)θ̇² = τ − cθ̇ − V′(θ), with I(θ)=Σmᵢ|xᵢ′|² and I′(θ)=Σ2mᵢxᵢ′·xᵢ″ built directly from
  those coefficients and V′(θ)=gΣmᵢyᵢ′. New `solver/dynamics.ts`: lumped rod masses (each link a
  uniform rod, mass split to its endpoints — a genuine Lagrangian system, so energy is conserved
  *exactly* for it), `evalDynamics` assembling the EOM + energies, and a substepped **RK4** integrator
  `stepDynamics` that marches (θ,θ̇) on the live sketch (each stage warm-started). Live **Dynamics
  panel** with gravity / density / damping / torque sliders, kinetic+potential+total energy read-outs
  and an energy-vs-time plot (T and V trade off while E stays flat — the visual proof of conservation),
  released via "Release & run". Added a **jerk** (third-order kinematic coefficient) via a new
  cubic-dual `{v,d1,d2,d3}` backend (`ad3.ts`, a *fourth* instantiation of the one residual algebra
  with atan2 carried exactly to third order): x‴ = J⁺(−3x'ᵀHx″ − x'ᵀTx'x'), the mixed term recovered by
  polarising three hyper-dual passes — plotted alongside speed/accel. Added a **hodograph** (the
  tracer's velocity-vector-tip locus over a cycle) with min/max velocity-ratio + dead-point flag, and
  **export** (`model/export.ts`): the solved sketch to vector SVG (exact C/A Béziers & arcs) and a real
  DXF (LINE/CIRCLE/ARC + sampled-spline LWPOLYLINE, opens in any CAD), plus the motion profile to CSV.
  Self-test suite **32 → 41**: the dynamics EOM vs the closed-form simple pendulum θ̈=−(g/L)cosθ (2e-8),
  energy conservation of the free swing (3e-9·mgL), monotone damped dissipation, I′(θ) vs finite-diff
  of I(θ) (5e-5), static equilibrium (4e-15), jerk vs finite-diff of acceleration (2.7e-5), and SVG/DXF/
  CSV fidelity (DXF arc angles round-tripped against arcGeom). Verified end-to-end headless in Chromium
  (four-bar swings under gravity, energy plot live, all three exports download valid files, hodograph +
  jerk curve render, 0 console errors) plus `node scripts/verify-project.mjs` (scope + conformance +
  lint + build all green).
