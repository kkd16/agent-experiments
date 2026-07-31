# Datum — Parametric Sketch Solver — journal

A from-scratch 2D geometric constraint solver, in the spirit of Ivan Sutherland's *Sketchpad*
(1963). Draw points, lines, circles, arcs and cubic Bézier splines; declare relations between them;
a Levenberg–Marquardt least-squares solver assembles the geometry. Drive a parameter and watch
mechanisms move.

## Architecture

- `model/` — the sketch model. Everything reduces to **points** (SolveSpace-style): lines,
  circles, arcs and splines reference points, so only point coords and circle/arc radii carry
  free parameters.
  - `types.ts` — entities (point, line, circle, arc, cubic Bézier spline) + the 24 constraint kinds
    (incl. `pointOnSpline` and `splineLength`, which carry auxiliary curve parameters).
  - `sketch.ts` — mutable model, free-parameter vector assembly, geometry helpers.
  - `constraintRules.ts` — which constraints apply to a given selection.
  - `examples.ts` — sixteen worked sketches (incl. Peaucellier + Hoeken + arc & spline showcases,
    the driven Bead-on-a-Curve and the fixed-length Ribbon) plus animatable driver specs.
  - `curve.ts` (in `solver/`) — cubic-Bézier calculus: Gauss–Legendre quadrature, point/derivative,
    a dense reference arc length, and nearest-parameter projection (seeds a point-on-spline's `t`).
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
  - `multibody.ts` — **multi-DOF constrained dynamics** (the Lagrange-multiplier DAE): takes the free
    point coords as generalized coordinates and marches the FULL system `M q̈ = f + Cᵀλ`, `c(q)=0` with
    no single-DOF reduction, so open chains and free-floating bodies run. Each step is one KKT saddle-point
    solve `[[M,−Cᵀ],[C,0]][q̈;λ]=[f;γ]` built from the exact constraint Jacobian `C` and the hyper-dual
    `γ=−q̇ᵀ∇²c q̇`, RK4-marched with a post-step coordinate projection (position re-solve + mass-metric
    velocity projection). Reports energy + linear/angular momentum. Pure (solver injected).
  - `jacobian.ts` — assembles the exact residual + Jacobian (and the symmetry-broken generic one).
  - `linalg.ts` — Gaussian elimination (normal equations) + rank (for DOF).
  - `solver.ts` — **Levenberg–Marquardt**: Gauss–Newton + adaptive Marquardt damping, an **exact
    (autodiff) Jacobian**, and step accept/reject on the least-squares cost.
  - `dof.ts` — degree-of-freedom analysis via Jacobian rank (under/well/over-constrained).
  - `conflicts.ts` — pinpoints the specific redundant/conflicting constraints by row-reduction.
  - `probes.ts` / `selftest.ts` — a live correctness suite (51 checks) that re-derives every claim,
    including analytic-vs-finite-difference differential tests, closed-form kinematics, the
    closed-form simple pendulum for the dynamics, energy conservation, and export fidelity.
- `render/` — Canvas2D CAD renderer: grid, geometry, constraint glyphs + dimension annotations,
  coupler-curve traces, DOF-aware highlighting, plus `view.ts` (camera) and `picking.ts` (hit-test).
- `ui/components.tsx` — toolbar, contextual constraint palette, DOF/solver/constraint panel,
  driver bar, value prompt, diagnostics modal.
- `App.tsx` — wiring: tools, pointer interaction (drag-to-solve, pan, zoom), the animation loop.

## Shipped

- [x] Point-reduced sketch model with 24 constraint kinds (incl. arcs, cubic Bézier splines & curve-parameter relations)
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

### Session 7 (claude) — Datum measures its curves: auxiliary solver parameters

Every free scalar Datum has ever solved for has been a **point coordinate or a circle/arc
radius** — the whole "everything reduces to points" philosophy. Session 7 introduces the first
parameter that is *neither*: a **curve parameter** `t ∈ ℝ` owned by a **constraint** rather than an
entity. That one architectural move (flagged in the backlog as "the first thing in Datum that isn't a
point coord or a radius") unlocks two capabilities a real sketcher can't do without — a point that
**rides a spline** at a solved location, and a spline held to a **true arc length** — and it flows
through *all four* AD backends (plain · gradient · hyper-dual · cubic-dual) with no new derivative
code, exactly the discipline the rest of the solver already keeps.

The idea. A constraint may now declare **auxiliary parameters** `aux: number[]`. They are appended to
the solver's free-parameter vector after every coordinate, addressed by the owning constraint's id, so
they are ordinary columns in the Jacobian — the LM solver, DOF/rank analysis, conflict diagnosis and
the exact velocity/acceleration/jerk kinematics all pick them up unchanged. The two new relations use
one aux each:

- **`pointOnSpline`** — a point `P` lies on the cubic `B(t)` at a solved parameter `t` (the aux). Two
  residuals `B(t) − P = 0`; because a Bézier is a polynomial its value and every derivative are exact
  over the abstract algebra `Alg<T>`, so the analytic Jacobian (incl. the `∂/∂t` column) is machine-exact.
- **`splineLength`** — a dimensional constraint fixing the spline's **true arc length**
  `L = ∫₀¹ |B′(t)| dt`, evaluated by fixed **Gauss–Legendre quadrature** (a constant-weighted sum of
  `hypot(B′ₓ, B′_y)` at fixed nodes), which is likewise differentiable over `Alg<T>` — the length and its
  gradient come from one source of truth. Drivable and editable on canvas like any dimension.

Planned and to be built end-to-end:

- [x] **Auxiliary parameters in the solver core** (`sketch.ts`) — a discriminated `ParamRef`
      (`coord` | `aux`) + a shared `paramKey`, `readParams`/`writeParams`/`freeParams` extended, a
      constraint-by-id index + `auxValue`, and deep-copied `aux[]` through `load`/`toData`/`clone`.
- [x] **The aux accessor threaded through every backend** — `Vars<T>.aux(constraintId, index)` added to
      the plain reference (`residuals.ts`), the sparse-gradient AD (`jacobian.ts`), and the hyper-dual /
      cubic-dual seeds (`kinematics.ts`), with `paramKey` columns and aux-skip guards in the scatter.
- [x] **`solver/curve.ts`** — Gauss–Legendre nodes/weights on `[0,1]` (generated, not transcribed),
      cubic-Bézier point & derivative, a dense reference arc length, and nearest-parameter projection
      (to seed a new `pointOnSpline`'s `t`).
- [x] **The two residuals over `Alg<T>`** (`residualsCore.ts`) — `bezierComponent` / `bezierDerivative`
      helpers + the `pointOnSpline` and `splineLength` cases, so the plain and all three AD backends
      share the code and the load-bearing differential self-test covers them automatically.
- [x] **Model, persistence & DOF bookkeeping** — new `ConstraintKind`s, `residualCount`, `addConstraint`
      auto-seeding `t` by projection, and `persist.ts` validating an optional numeric `aux[]`.
- [x] **UI end-to-end** — palette options (point + spline → *On Spline*; a spline → *Length*), a
      `length` value kind, the constraint-list label, a canvas glyph for point-on-spline, a length
      **dimension** drawn along the curve, and double-click-to-edit that length.
- [x] **Two showcases** — **Bead on a Curve** (a follower riding a fixed spline, its position *driven*
      by a distance so it slides along the profile and traces it — the first driven mechanism with an
      aux DOF, which exercises `t` through the kinematics) and **Ribbon of Fixed Length** (a cubic whose
      endpoints are pinned and whose arc length is dimensioned — drag a handle and it re-fairs while
      keeping its length).
- [x] **Self-tests (41 → 48)** re-deriving every new claim independently: point-on-spline exactness
      (`B(t*) = P` to machine precision, `t` in range) and its DOF; Gauss–Legendre **exact on a
      straight spline** (length = chord) and matching a dense reference on a curved one; a driven
      `splineLength` hitting its target; the **driven-aux velocity field** vs a finite-difference of a
      full re-solve (proving `t` threads through the exact kinematics); plus the new residuals folded
      into the existing differential-Jacobian, AD-equals-plain, and persistence-round-trip checks.

### Verified (Session 7)
- **Auxiliary parameters are first-class solver coordinates.** The Bead-on-a-Curve's exact velocity
  field — which includes `dt/dθ` for the curve parameter, solved from the very same Jacobian — matches
  a central finite difference of a full re-solve across the sweep (worst |Δẋ| ≈ 2.6e-2), so `t` is
  differentiated exactly like any point coordinate through the kinematics.
- **Point-on-spline is exact.** After the solve, `|B(t*) − F| ≈ 1.8e-11`, `t*` is interior, and the
  driven mechanism reports fully constrained (3 free scalars incl. `t`, 3 residuals, 0 DOF). A bead
  constrained *only* to the curve keeps exactly 1 DOF (it slides).
- **Gauss–Legendre length is exact where it must be and accurate everywhere.** A straight (evenly
  spaced) spline has constant speed, so the 24-point rule returns the chord to ~1e-14 and the
  `splineLength` residual vanishes; on a curved cubic it agrees with a dense composite-trapezoid
  reference to ≈1.7e-6. The Ribbon solves to length 210 and stays at 210 after a handle is dragged.
- **The new residuals ride the existing load-bearing checks for free.** Because both showcases join
  the example set, the analytic-Jacobian-vs-finite-difference differential test (worst ≈6e-9 for the
  new examples), the AD-equals-plain-values test (exact), and the save/load/share round-trip all now
  cover the curve-parameter constraints — and the auxiliary `t` round-trips losslessly.
- In-browser self-test suite **41 → 48**, all green; `pnpm lint` + `tsc` + `vite build` pass (the exact
  CI gate), and a headless Chromium smoke of both new examples (drove the bead) reported **0 console
  errors**.

### Session 8 (claude) — Datum cuts its curves: de Casteljau spline splitting

Session 7 gave a point a place *on* a curve; Session 8 lets you cut the curve *there*. **Splitting a
cubic Bézier at a parameter** is the one editing operation a spline tool can't do without, and the
elegant way to do it exactly is the **de Casteljau** construction — the same repeated-lerp that
evaluates the curve, read off as two new control polygons. The two halves together **retrace the
original curve to machine precision** (the left over [0,t], the right over [t,1]) and meet with
matching tangent (**C1**) at the cut, all from pure geometry — no solve, no new residual.

- [x] **`splitCubic(p0,c0,c1,p1,t)`** (`solver/curve.ts`) — the de Casteljau split, returning the two
      control-point quadruples (the shared split point is `left[3] === right[0]`).
- [x] **`Sketch.splitSpline(id, t, atPoint?)`** — the model operation: replace a spline with two cubics
      that share the split point (so dragging it moves both halves together), reusing the two endpoints
      so chained neighbours stay attached, and removing the original spline, its two interior handles,
      and any constraint that referenced them. If `atPoint` is given — a point-on-spline **bead** riding
      the curve at `t` — that bead *becomes* the shared join (Session 7 and Session 8 composing: cut the
      curve exactly where the bead sits, and the bead's now-meaningless rider constraint is dropped).
- [x] **A "Split" palette action** — shown whenever a spline is selected. Split a lone spline at its
      midpoint; select a spline **and its bead** to split precisely at the bead.
- [x] **Self-tests (48 → 51)** — the de Casteljau halves sample-match the original to ~1e-14 with an
      exact shared point and a C1 join; the `splitSpline` model op reproduces the curve, reuses its
      endpoints, and adds exactly the six expected free scalars; and splitting at a bead reuses that
      bead as the join (without moving it) and drops its rider.

Verified: suite **48 → 51**, all green; `pnpm lint` + `tsc` + `vite build` pass; a headless Chromium
smoke selected the ribbon's spline, hit **Split**, and confirmed the two-curve result with **0 console
errors**.

### Session 9 (claude) — Datum lets everything go: multi-DOF constrained dynamics (Lagrange-multiplier DAE)

Session 6 let go of the crank for a **single**-degree-of-freedom mechanism: one generalized coordinate
θ, one scalar ODE (the Eksergian equation of motion). But a double pendulum, an open chain, a
free-floating body — anything with **two or more** free degrees of freedom, or none of them driven —
falls outside that reduction. Session 9 removes the restriction entirely: it runs the **full**
constrained rigid-body dynamics of the sketch as a system of point masses connected by *any* of Datum's
holonomic constraints, with **no generalized-coordinate reduction at all**.

The formulation is the classical **Lagrange-multiplier differential-algebraic equation (DAE)**, and it
falls out of machinery Datum already owns. Take the free point coordinates as the generalized
coordinates `q` (mass lives at points — the same lumped-rod model Session 6 uses). The constraints are
`c(q) = 0` with Jacobian `C = ∂c/∂q` — **exactly the autodiff Jacobian the solver already assembles.**
Newton + d'Alembert give the equations of motion with the constraint forces as multipliers `λ`:

```
  M q̈ = f(q, q̇) + Cᵀ λ          (constraint force is Cᵀλ, normal to the manifold)
  c(q) = 0
```

Differentiating `c(q)=0` twice gives the acceleration-level constraint `C q̈ = −Ċ q̇ =: γ`, and
`(Ċ q̇)_k = q̇ᵀ ∇²c_k q̇` is **precisely the second directional derivative the hyper-dual backend
(`ad2.ts`) already delivers in one pass** — the very term Session 5's acceleration field is built from.
So the whole step is one **saddle-point (KKT) solve**

```
  ⎡ M   −Cᵀ ⎤ ⎡ q̈ ⎤   ⎡ f ⎤
  ⎣ C    0  ⎦ ⎣ λ  ⎦ = ⎣ γ ⎦
```

for `q̈` (and, as a bonus, the joint-reaction multipliers `λ`), then an **RK4** march of `(q, q̇)`. To
kill the secular drift every index-1 DAE integrator suffers, each full step is followed by a **coordinate
projection**: re-solve the positions back onto the manifold with the existing LM solver, then remove the
constraint-violating component of the velocity in the **mass metric** (`q̇ ← q̇ − M⁻¹Cᵀ(CM⁻¹Cᵀ)⁻¹Cq̇`),
which is energy-consistent, so the conservation tests stay razor-sharp. This is a strict generalization:
a single-DOF driven mechanism, released, must reproduce Session 6's Eksergian result exactly.

Planned and shipped, end to end:

- [x] **`solver/multibody.ts`** — the point-mass DAE core. `buildSystem` (dynamic coords = free point
      coords, lumped masses, released-constraint set, an `ndof = n − rank(C)` count, and an honest
      `supported` flag), `mbAccel` (assemble `C`, `f`, `γ`, solve the KKT system for `q̈` and the joint
      reactions `λ`), an RK4 `mbStepAdvance` with post-step position re-solve + mass-metric velocity
      projection, and `mbReadout` (kinetic, potential, total energy + linear & angular momentum). Pure —
      the LM solver is injected, exactly like `dynamics.ts`, so it carries no import cycle and is exercised
      end-to-end by the live self-test suite.
- [x] **Reuses the exact-derivative stack with zero new derivative code** — `C` from
      `residualsAndJacobian`, `γ` from the hyper-dual `directionalDerivatives` (`ad2.ts`); the KKT solve
      and both projections use only `linalg.ts`.
- [x] **Live "Free-Body Dynamics" panel** in the app: a release button that runs the *whole* sketch
      (dropping any driver) under gravity as a multi-DOF system — per-point velocity streamed back each
      frame (drawn by the existing velocity overlay), a DOF badge, live kinetic/potential/total energy +
      linear/angular-momentum read-outs, gravity / density / point-mass / damping sliders, and the
      energy-vs-time plot (T and V trade off; total stays flat ⇒ conserved). Falls back with an honest
      message when the sketch has non-point free params (a free radius / curve parameter), which the
      point-mass model does not cover, and when the sketch is fully constrained (0 DOF).
- [x] **Three showcases** — a **double pendulum** (the canonical 2-DOF chaotic system; energy conserved,
      links held rigid), a **triple-pendulum chain** (3-DOF open chain), and a **free-floating dumbbell /
      spinner** (no anchor: it drifts and spins, conserving linear *and* angular momentum — the "floating
      bodies run too" goal made visible).
- [x] **Joint-reaction validation** — the Lagrange multipliers `λ` the KKT solve produces *are* the
      physical link tensions: a hanging pendulum at rest gives `|λ| = mg` (it holds up the weight), and one
      swinging through the bottom at rate ω gives `|λ| = m(g + Lω²)` (gravity plus the centripetal demand)
      — Newton's second law in the radial direction, recovered exactly from the multiplier.
- [x] **Self-tests (51 → 62)** re-deriving every claim independently: a **projectile** (no constraints)
      matching the closed-form parabola (err ≈1.3e-13); a **simple pendulum** whose DAE angular
      acceleration equals the closed form `θ̈=−(g/L)cosθ` (≈9e-16) **and** agrees with Session 6's
      single-DOF Eksergian `evalDynamics` at ω≠0 (≈1.4e-8, the two formulations cross-checked);
      **double-pendulum energy conservation** (≈3.3e-11·2mgL) and **bounded constraint drift** (≈1e-9)
      over a 2-second RK4 march; a **free dumbbell** conserving linear momentum (≈1e-13), angular momentum
      (≈1.5e-15) and energy (≈1.4e-13) — floating-body correctness; and **monotone energy dissipation**
      under damping.

### Verified (Session 9)
- **The two dynamics formulations agree.** For a simple pendulum at a *moving* state (ω≠0, so the
  velocity-dependent term γ is live), the multi-DOF DAE's angular acceleration and Session 6's single-DOF
  Eksergian equation of motion — completely independent code paths — give the same θ̈ to ≈1.4e-8. The DAE
  is a strict generalization: released, a 1-DOF driven mechanism reproduces the Eksergian result.
- **Energy and momentum are conserved to machine precision.** A double pendulum released horizontal
  conserves total mechanical energy to ≈3.3e-11·(2mgL) over a 2-second RK4 march while both links stay
  rigid to ≈1e-9 (the coordinate projection doing its job); a free-floating dumbbell (no anchor, no
  gravity), translating while spinning, holds its linear momentum to ≈1e-13, its angular momentum to
  ≈1.5e-15 and its energy to ≈1.4e-13 — the invariants a closed mechanical system must keep.
- **The point-mass model is honest about its domain.** `buildSystem` reports `supported=false` (with a
  reason) for a sketch carrying a free radius or curve parameter — the free-body panel shows that message
  rather than fabricating a run — and `ndof=0` for a fully-constrained sketch.
- In-browser self-test suite **51 → 62**, all green; `pnpm lint` + `tsc` + `vite build` pass (the exact
  CI gate via `node scripts/verify-project.mjs`), and the physics core was validated in a throwaway
  pure-JS oracle first (double pendulum, floating dumbbell, projectile, pendulum) before porting onto the
  real exact-derivative stack.

## Backlog / ideas

- [x] Arcs as first-class entities *(Session 3)*
- [x] Splines / Béziers as first-class entities (with tangency to lines & arcs) *(Session 4)*
- [x] Exact velocity & acceleration kinematics via second-order AD *(Session 5)*
- [x] Hodograph & mechanical-advantage / velocity-ratio readout *(Session 6)*
- [x] Time-domain dynamics — release the driver, run the mechanism under gravity via the single-DOF
      Eksergian equation of motion (RK4), with live energy read-out *(Session 6)*
- [x] Jerk (third-order) coefficient via a cubic-dual `{v,d1,d2,d3}` backend *(Session 6)*
- [x] Export the sketch to SVG / DXF and the motion profile to CSV *(Session 6)*
- [x] **Multi-DOF rigid-body dynamics via a Lagrange-multiplier DAE** — open chains and floating bodies
      run too (double / triple pendulum, free dumbbell); `[[M,−Cᵀ],[C,0]][q̈;λ]=[f;γ]` per step, RK4 +
      coordinate projection *(Session 9)*
- [ ] **Dynamics, still to come** — contact / joint limits (inequality constraints), a torque-driven
      "motor" preset for the free-body mode, and per-point applied forces (drag with the mouse while it runs).
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
- [x] Split a spline at a parameter via de Casteljau (incl. at a point-on-spline bead) *(Session 8)*
- [ ] Trim / extend / fillet-in-place tools that cut real geometry at line/arc/spline **intersections**
      (the parameter-split half is done; the remaining work is finding the cut parameter from a picked
      intersection, and trimming lines/arcs).
- [ ] **Offset curves** — a construction offset of a line/arc/spline at a driven distance.
- [ ] Constraint groups / layers, and a per-entity construction toggle in the UI.
- [ ] Pantograph / other coupler-curve mechanisms.
- [ ] `localStorage` autosave with an explicit "restore last session".
- [ ] **Export** the solved sketch to SVG / DXF (splines → cubic path segments).

## Session log

- 2026-07-31 (claude): **Datum lets everything go — multi-DOF constrained dynamics (Lagrange-multiplier
  DAE).** Session 6 released a *single*-DOF mechanism and marched one scalar ODE (the Eksergian equation of
  motion). Session 9 removes the restriction entirely: `solver/multibody.ts` runs the FULL constrained
  rigid-body dynamics of the sketch as point masses joined by any holonomic constraint, with no
  generalized-coordinate reduction — so a double pendulum, an open chain, or a free-floating body all run.
  The formulation is the classical Lagrange-multiplier DAE `M q̈ = f + Cᵀλ`, `c(q)=0`, and it falls out of
  machinery Datum already owns: `C = ∂c/∂q` is the exact autodiff Jacobian the solver assembles, and the
  acceleration-level term `γ = −Ċq̇ = −q̇ᵀ∇²c q̇` is precisely the hyper-dual second directional derivative
  Session 5's acceleration field is built from — so the whole step is one KKT saddle-point solve
  `[[M,−Cᵀ],[C,0]][q̈;λ]=[f;γ]` (which also yields the joint-reaction multipliers λ) with **zero new
  derivative code**, RK4-marched with a post-step coordinate projection (LM position re-solve + mass-metric
  velocity projection) that kills the index-1 drift so the conservation checks stay razor-sharp. A live
  **Free-Body Dynamics** panel releases the whole sketch under gravity — DOF badge, kinetic/potential/total
  energy + linear/angular-momentum read-outs, gravity/density/mass/damping sliders, per-point velocity
  overlay and an energy-vs-time plot — with an honest fallback when the sketch has non-point free params.
  Three showcases: **double pendulum** (2-DOF chaos), **triple pendulum** (3-DOF open chain), and a
  **floating dumbbell** (no anchor — it drifts and spins). Validated in a throwaway pure-JS oracle first,
  then ported. Self-test suite **51 → 62**: projectile vs the closed-form parabola (1.3e-13), simple
  pendulum vs closed-form `θ̈=−(g/L)cosθ` (9e-16) *and* vs Session 6's single-DOF Eksergian at ω≠0 (1.4e-8,
  the two formulations cross-checked), double-pendulum energy conservation (3.3e-11·2mgL) + rigid-link
  drift (1e-9), free-dumbbell linear (1e-13) / angular (1.5e-15) momentum + energy (1.4e-13) conservation,
  monotone damped dissipation, and the **Lagrange multipliers validated as physical joint reactions**
  (a hanging pendulum's link tension `|λ|=mg`; swinging through the bottom `|λ|=m(g+Lω²)`). Verified via
  `node scripts/verify-project.mjs` (scope + conformance + lint + build all green) and the real self-tests
  run headlessly (62/62) through a Vite SSR bundle.
- 2026-07-31 (claude): **Datum cuts its curves — de Casteljau spline splitting.** Added the one
  editing operation a spline tool can't do without: split a cubic Bézier at a parameter, exactly. The
  **de Casteljau** construction (`splitCubic` in `solver/curve.ts`) reads the two half-curves off the
  repeated-lerp that evaluates the curve, so the two halves retrace the original to machine precision
  (~1e-14) and meet C1 at the cut — no solve, no new residual. `Sketch.splitSpline(id, t, atPoint?)`
  makes it a model op: two cubics sharing the split point, endpoints reused so chained neighbours stay
  attached, the original spline + interior handles + referencing constraints removed. When a
  point-on-spline **bead** is passed as `atPoint`, the bead *becomes* the shared join and its rider
  constraint is dropped — Session 7 and Session 8 composing. A "Split" palette action splits a lone
  spline at its midpoint, or precisely at a selected bead. Validated in a throwaway oracle first, then
  ported. Self-test suite **48 → 51**: de Casteljau reproduces the curve with an exact shared point and
  a C1 join; the model op reproduces the curve, reuses endpoints and adds exactly +6 DOF; split-at-bead
  reuses the bead (no drift) and drops its rider. Verified headless in Chromium (selected the ribbon's
  spline, hit Split, two curves, 0 console errors) plus `node scripts/verify-project.mjs` (scope +
  conformance + lint + build all green).
- 2026-07-31 (claude): **Datum measures its curves — auxiliary solver parameters.** Introduced the
  first free scalar in Datum that is neither a point coordinate nor a radius: a **curve parameter `t`**
  owned by a *constraint*, appended to the free-parameter vector and keyed by the constraint's id so
  the LM solver, DOF/rank analysis, conflict diagnosis and the exact velocity/acceleration/jerk
  kinematics all treat it as an ordinary Jacobian column. A discriminated `ParamRef` (`coord` | `aux`)
  + a shared `paramKey`, extended `readParams`/`writeParams`/`freeParams`, a constraint-by-id index +
  `auxValue`, and deep-copied `aux[]` through `load`/`toData` carry it; a new `Vars<T>.aux` accessor
  threads it through the plain reference, the sparse-gradient AD, and the hyper-dual/cubic-dual seeds —
  **no new derivative code**. Two constraints use it: **`pointOnSpline`** (a point rides a cubic at the
  solved `t`; two polynomial residuals `B(t) − P`, exact in every backend) and **`splineLength`** (a
  dimensional constraint fixing the true arc length `∫₀¹|B′|` by a generated 24-point **Gauss–Legendre**
  rule — `solver/curve.ts`). Wired end-to-end: palette (point + spline → *On Spline*; a spline →
  *Length*), a `length` value kind, the constraint-list label, a canvas glyph and a length dimension
  along the curve with double-click-to-edit, and persistence validation of an optional numeric `aux[]`.
  Two showcases — **Bead on a Curve** (a follower riding a fixed spline profile, *driven* to slide, the
  first mechanism whose motion runs through an aux DOF) and **Ribbon of Fixed Length** (a cubic pinned
  at both ends and held to a dimensioned arc length — drag a handle, it re-fairs while keeping its
  length). Validated the whole thing in a throwaway oracle first (GL exact on polynomials, straight
  spline length = chord, curved GL vs a dense reference), then ported. Self-test suite **41 → 48**:
  point-on-spline exactness (`|B(t)−F|≈1.8e-11`) + its DOF, free-bead 1-DOF slide, GL-exact-on-straight
  + curved-vs-dense, driven `splineLength` target met and drag-preserved, the **driven-aux velocity
  field vs a finite-difference re-solve** (`|Δẋ|≈2.6e-2`, proving `t` threads through the kinematics),
  and lossless `aux` round-tripping — plus the new residuals folded into the existing differential-
  Jacobian (~6e-9), AD-equals-plain (exact) and persistence checks. Verified headless in Chromium
  (loaded both new examples, drove the bead, 0 console errors) plus `node scripts/verify-project.mjs`
  (scope + conformance + lint + build all green).
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
