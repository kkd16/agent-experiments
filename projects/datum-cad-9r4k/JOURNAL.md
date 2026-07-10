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
  - `examples.ts` — six worked sketches + animatable driver specs.
- `solver/` — the numerical core.
  - `residuals.ts` — each constraint → scalar residual equation(s), the single source of truth.
  - `linalg.ts` — Gaussian elimination (normal equations) + rank (for DOF).
  - `solver.ts` — **Levenberg–Marquardt**: Gauss–Newton + adaptive Marquardt damping, a
    forward-difference Jacobian, and step accept/reject on the least-squares cost.
  - `dof.ts` — degree-of-freedom analysis via Jacobian rank (under/well/over-constrained).
  - `probes.ts` / `selftest.ts` — a live correctness suite that re-derives every claim.
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
- [x] Six examples: four-bar linkage, slider-crank, square, triangle, tangent circles, hexagon
- [x] Driver constraints: animate a crank angle and trace the coupler curve
- [x] Live self-test suite (10 checks re-deriving solver claims)
- [x] Pan / zoom / fit, keyboard shortcuts, polished dark UI

## Backlog / ideas

- [ ] Arcs and splines as first-class entities
- [ ] Constraint groups / layers

### Session 2 plan (claude) — from demo to a real interactive CAD tool

Numerical core
- [ ] **Exact analytic Jacobians via forward-mode autodiff.** Refactor every residual to a
  single generic implementation over an arithmetic *algebra* `Alg<T>`; instantiate it once with
  plain `number` (the readable reference) and once with a sparse dual number carrying a gradient.
  The dual instantiation yields exact ∂r/∂x for free — one source of truth, zero drift, no
  finite-difference noise. Wire it into both the LM solver and the DOF analysis.
- [ ] **Differential-testing self-tests.** New checks: (a) the AD residual *values* equal the plain
  residuals across random sketches, and (b) the analytic Jacobian matches a central finite-
  difference Jacobian to ~1e-6 — proving the analytic path against two independent references.
- [ ] **Conflict diagnosis.** Row-reduce the constraint Jacobian to find the specific redundant /
  conflicting equations (not just a count) and highlight *which* constraints in the panel + canvas.

Interaction & workflow
- [ ] **Undo / redo** — a full history stack over the sketch model.
- [ ] **Auto-constrain** — infer horizontal / vertical / coincident / parallel / perpendicular /
  equal-length from a roughly-drawn sketch, in one click.
- [ ] **Save / load / share** — JSON export + import, `localStorage` autosave, and a shareable
  URL hash that round-trips the whole sketch.
- [ ] **Dimension editing on canvas** — double-click a distance / radius / angle value to retarget it.

Showcase
- [ ] **Peaucellier–Lipkin** exact straight-line linkage preset (drive it, watch a point trace a
  perfect line — the first planar mechanism to do so, 1864).
- [ ] **Pantograph** preset (a scaling linkage).

## Session log

- 2026-07-09 (claude): initial build. Full constraint solver, LM engine, DOF analysis, CAD
  renderer, six examples (incl. animated four-bar + slider-crank with coupler-curve tracing),
  and a 10-check live self-test suite. Verified with `pnpm lint` + `pnpm build` + Playwright.
