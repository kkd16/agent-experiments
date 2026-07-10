# Datum — Parametric Sketch Solver — journal

A from-scratch 2D geometric constraint solver, in the spirit of Ivan Sutherland's *Sketchpad*
(1963). Draw points, lines and circles; declare relations between them; a Levenberg–Marquardt
least-squares solver assembles the geometry. Drive a parameter and watch mechanisms move.

## Architecture

- `model/` — the sketch model. Everything reduces to **points** (SolveSpace-style): lines and
  circles reference points, so only point coords and circle radii carry free parameters.
  - `types.ts` — entities + the 19 constraint kinds.
  - `sketch.ts` — mutable model, free-parameter vector assembly, geometry helpers.
  - `constraintRules.ts` — which constraints apply to a given selection.
  - `examples.ts` — eight worked sketches (incl. Peaucellier + Hoeken) + animatable driver specs.
  - `autoConstrain.ts` — infer relations from rough geometry, gated by Jacobian rank.
  - `persist.ts` — JSON + base64-URL serialisation with validation of untrusted input.
- `solver/` — the numerical core.
  - `residualsCore.ts` — **the single source of truth**: each constraint → residual equation(s),
    written once over an abstract arithmetic `Alg<T>` so it runs with plain numbers *or* dual numbers.
  - `residuals.ts` — the plain-number instantiation (readable reference values).
  - `ad.ts` — a sparse forward-mode dual number; instantiating the residuals with it gives exact
    derivatives.
  - `jacobian.ts` — assembles the exact residual + Jacobian (and the symmetry-broken generic one).
  - `linalg.ts` — Gaussian elimination (normal equations) + rank (for DOF).
  - `solver.ts` — **Levenberg–Marquardt**: Gauss–Newton + adaptive Marquardt damping, an **exact
    (autodiff) Jacobian**, and step accept/reject on the least-squares cost.
  - `dof.ts` — degree-of-freedom analysis via Jacobian rank (under/well/over-constrained).
  - `conflicts.ts` — pinpoints the specific redundant/conflicting constraints by row-reduction.
  - `probes.ts` / `selftest.ts` — a live correctness suite (17 checks) that re-derives every claim,
    including analytic-vs-finite-difference differential tests.
- `render/` — Canvas2D CAD renderer: grid, geometry, constraint glyphs + dimension annotations,
  coupler-curve traces, DOF-aware highlighting, plus `view.ts` (camera) and `picking.ts` (hit-test).
- `ui/components.tsx` — toolbar, contextual constraint palette, DOF/solver/constraint panel,
  driver bar, value prompt, diagnostics modal.
- `App.tsx` — wiring: tools, pointer interaction (drag-to-solve, pan, zoom), the animation loop.

## Shipped

- [x] Point-reduced sketch model with 19 constraint kinds
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

## Backlog / ideas

- [x] Arcs as first-class entities *(Session 3)*
- [ ] Splines / Béziers as first-class entities (with tangency to lines & arcs)
- [ ] Arc-length and included-angle dimensional constraints
- [ ] Auto-constrain: infer line↔arc tangency and equal-radius from rough geometry
- [ ] Trim / extend / fillet-in-place tools that cut real geometry at intersections
- [ ] Constraint groups / layers
- [ ] Pantograph / other coupler-curve mechanisms
- [ ] `localStorage` autosave with an explicit "restore last session"

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
