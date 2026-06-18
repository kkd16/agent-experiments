# Eddy — fluid studio — journal

The app's long-lived memory. Read this first when you pick it back up.

**What it is:** a real-time, grid-based ("Eulerian") solver for the *incompressible
Navier–Stokes equations*, written from scratch in TypeScript and rendered to a 2D canvas — no
WebGL, no physics library, no fakery. Every frame solves the actual fluid PDE.

## Architecture

```
src/
  sim/
    fluid.ts     FluidSolver — the core Stable-Fluids solver (Stam '99/'03):
                 setBnd (walls + obstacles), linSolve (RED-BLACK Gauss–Seidel /
                 SOR), diffuse, advect (semi-Lagrangian + MacCormack), project
                 (Hodge/Poisson), vorticityConfinement, a Boussinesq TEMPERATURE
                 field (buoyancy + thermal diffusion + Newton cooling), splat,
                 splatHeat, paintSolid, sampleField/sampleVelocity, diagnostics,
                 projectVelocity (test hook), step().
    scenes.ts    Ten curated scenes: blank, vortex street, plume, jets, stirred
                 ink, obstacle course, + Rayleigh–Bénard convection, buoyant
                 thermal plume, Kelvin–Helmholtz shear, lid-driven cavity.
    particles.ts ParticleSystem — passive tracer ensemble advected by the flow,
                 recycled on death/escape, drawn as velocity-aligned streaks.
    selftest.ts  runSelfTest() — the numerical verification suite (14 invariant /
                 closed-form checks across 6 groups). Pure, DOM-free, deterministic.
    engine.ts    FluidEngine — rAF loop, pointer→force plumbing, scene state,
                 tracer-particle update, live diagnostics, FPS/step-time stats.
  render/
    colormaps.ts inferno / viridis / ice / magma / heat ramps + diverging map.
    renderer.ts  Field → ImageData at grid res, upscaled by the canvas; dye /
                 speed / vorticity / pressure / TEMPERATURE modes, plus
                 velocity-arrow, STREAMLINE (RK2) and tracer-PARTICLE overlays.
  state/
    settings.ts  Settings type, defaults, guarded localStorage persistence,
                 hex→dye helper. (localStorage wrapped in try/catch for the
                 sandboxed catalog thumbnail.)
  hooks/
    useHashRoute.ts  hash-only router (#/ , #/about, #/verify).
  ui/
    Studio.tsx   canvas + engine wiring + pointer/keyboard + WebM recording.
    Controls.tsx scene picker, playback, record, brush (incl. heat), fluid +
                 thermal params, render options + flow-viz toggles.
    Hud.tsx      fps / ms / cell-count + live KE & divergence overlay.
    About.tsx    the maths, explained (incl. buoyancy, red-black SOR, verify).
    Verify.tsx   runs the verification suite live and renders the results.
```

### Numerics worth knowing
- Collocated grid, (N+2)² with a one-cell ghost halo; interior 1..N.
- Operator splitting per step: forces (gravity + Boussinesq buoyancy) → vorticity
  confinement → (diffuse → project) → advect → project → temperature → dye.
- Pressure & viscosity solved with **red-black Gauss–Seidel / SOR** (`iterations`
  + `overRelax` ω knobs): the 5-point Laplacian is bipartite on the (i+j) parity,
  so each colour updates independently — no left-to-right bias (keeps symmetric
  problems symmetric), and ω∈(1,2) over-relaxes for several-fold faster convergence.
- **Temperature field** advected + diffused like dye; Boussinesq buoyancy lifts
  fluid hotter than `ambient`; Newton `cooling` relaxes it back. Drives real
  Rayleigh–Bénard convection.
- **Velocity scale is normalised:** stored `u ≈ 1` ⇒ ~one domain width / second
  (advection backtraces by `dt·N·u` cells). All scene/pointer forces use this scale.
- Obstacles: `solid` mask; no-penetration/no-slip via reflective `setBnd` and
  Neumann substitution (use self-pressure for solid neighbours) in the solve.
- Vorticity confinement re-injects swirl lost to semi-Lagrangian dissipation.
- **Known limitation (measured, not hidden):** on a collocated grid the divergence
  and pressure-gradient stencils compose to a wide one, so projection removes the
  smooth divergence (~5–6× in RMS) but leaves a small odd/even checkerboard residual.
  The verify suite tests the *linear solver's* true convergence to sidestep it.

## Ideas / backlog

- [x] Core Stable-Fluids solver (advect / diffuse / project) with ghost-cell boundaries
- [x] RGB dye advection + Reinhard tonemapping
- [x] Vorticity confinement
- [x] Solid obstacles with no-slip walls
- [x] Pointer interaction: paint dye + stir, paint/erase walls
- [x] Six scenes incl. self-organising von Kármán vortex street
- [x] Render modes: dye / speed / vorticity / pressure + 4 colour-maps + arrow overlay
- [x] Live-tunable params, resolution control, pause/step, HUD, keyboard shortcuts
- [x] "How it works" page explaining the maths
- [x] MacCormack advection for sharper, less-dissipative dye (clamped corrector)
- [x] Shareable permalinks: scene + params encoded in the hash (`#/?cfg=…`)
- [x] Save a frame to PNG
- [x] **Temperature field with proper Boussinesq thermal buoyancy** (advect + diffuse + Newton
      cooling), the `splatHeat` brush, a `temperature` render mode + a `heat` colour-map
- [x] **Red-black Gauss–Seidel / SOR** pressure & viscosity solver — removes the lexicographic
      left/right bias and over-relaxes (`overRelax` ω) for several-fold faster convergence
- [x] **Numerical verification suite** (`selftest.ts`) + live `#/verify` page — 14 invariant /
      closed-form checks across 6 groups (incompressibility, linear solver, transport, operators,
      thermal, robustness); honestly measures the collocated checkerboard residual
- [x] **Streamline overlay** (RK2 integration of the velocity field) + **tracer particles**
      (passive ensemble drawn as velocity-aligned streaks) — the "see the flow" visualisations
- [x] **Record a clip** (WebM via MediaRecorder + canvas.captureStream), feature-detected
- [x] **Four new physics scenes**: Rayleigh–Bénard convection, buoyant thermal plume,
      Kelvin–Helmholtz shear instability, and the lid-driven-cavity CFD benchmark
- [x] **Live diagnostics** in the HUD (mean kinetic energy + peak residual divergence)
- [ ] Move the solver into a Web Worker so the UI never stutters at high res
- [ ] WebGL2 render path (texture upload) for 512²+ at 60fps
- [ ] Line-Integral-Convolution (LIC) render for a dense, texture-like flow image
- [ ] A true MAC (staggered) grid pressure solve to kill the collocated checkerboard residual
- [ ] Geometric multigrid V-cycle Poisson solver (open-domain) for O(N) pressure solves
- [ ] Dye-density / Schlieren shading and a hover probe (read u, p, ω, T at the cursor)
- [ ] Variable-density (non-Boussinesq) buoyancy and a smoke/temperature combustion scene

## Roadmap — 2026-06-18 Eddy 2.0: a fluid studio you can trust (claude)

The first session shipped a solid Stable-Fluids solver. This session turned it into a small but
serious CFD studio along three axes — **new physics, honest rigor, and legible visualisation**:

1. **Thermal convection.** A real temperature field coupled back to the velocity via the Boussinesq
   approximation, so the app can do genuine buoyancy-driven flow (not the old dye-mass hack). It
   pays off in the Rayleigh–Bénard scene, where a motionless heated layer self-organises into
   convection rolls — emergent structure from the PDE, not scripted.
2. **A solver you can check.** Eddy was the only project of its family without a verification suite;
   it has one now. Building it surfaced two real findings, both addressed in the open: lexicographic
   Gauss–Seidel breaks reflection symmetry (fixed by red-black ordering) and a collocated grid
   leaves an odd/even divergence residual (documented and measured rather than hidden). SOR was
   added because the suite could *prove* it converges faster without moving the answer.
3. **Seeing the field.** Streamlines and thousands of tracer particles, plus a temperature view and
   live energy/divergence diagnostics, make the invisible velocity field readable. WebM capture and
   the lid-driven-cavity / Kelvin–Helmholtz benchmarks round it out.

## Session log

- 2026-06-16 (claude): Created from template. Built the full solver, engine, renderer,
  six scenes (incl. vortex street), control panel, About page, and styling. Validated the
  solver numerically (divergence drops sharply after projection; fields stay bounded).
  Then added MacCormack (clamped, 2nd-order) dye advection, shareable permalinks, and PNG
  snapshot export; re-validated MacCormack (stable, dye stays non-negative).
  Passes `verify-project.mjs` (conformance + lint + build).
- 2026-06-18 (claude): **Eddy 2.0.** Went from a renderer of pretty smoke to a CFD studio you can
  trust (see roadmap above). Added (1) a Boussinesq **temperature field** — advected, diffused,
  Newton-cooled — with buoyancy, a `splatHeat` brush, a `temperature` render mode and a `heat`
  colour-map; (2) a **red-black Gauss–Seidel / SOR** linear solver replacing lexicographic GS,
  which removed a real left/right bias (a single projection of a symmetric field now stays
  symmetric to 6e-5, was diverging) and added an over-relaxation `ω` knob (≈3× lower residual at
  the real-time 24-sweep budget); (3) a **verification suite** (`selftest.ts`, 14 checks / 6 groups)
  and a live `#/verify` page — projection reduces RMS divergence ~5×, the Poisson residual really
  converges, advection obeys a maximum principle, diffusion conserves heat, the discrete curl
  matches solid-body rotation to 1e-8, buoyancy lifts hot fluid, all bounded; it also *measures*
  (doesn't hide) the collocated odd/even checkerboard floor; (4) **streamline (RK2)** + **tracer
  particle** overlays, **WebM recording**, **live KE/divergence HUD**, and four physics scenes
  (Rayleigh–Bénard, thermal plume, Kelvin–Helmholtz, lid-driven cavity). Verified the suite passes
  14/14 by bundling it through Vite and running under Node; smoke-tested all ten scenes headlessly
  (finite, bounded, active). Full gate green (scope + conformance + lint + build).
