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
                 (Hodge/Poisson), + an alternative matrix-free Jacobi-PRECONDITIONED
                 CONJUGATE-GRADIENT projection (applyPoisson/projectCG), a reactive
                 COMBUSTION model (advected `fuel` field, ignition, heat release —
                 combust()), VARIABLE-DENSITY (non-Boussinesq) buoyancy, vorticity
                 confinement, a Boussinesq TEMPERATURE field, splat/splatHeat/
                 splatFuel, paintSolid, sampleField/sampleVelocity, diagnostics,
                 projectVelocity{,CG} (test hooks), step().
    scenes.ts    Eleven curated scenes: blank, vortex street, plume, jets, stirred
                 ink, obstacle course, Rayleigh–Bénard convection, buoyant thermal
                 plume, Kelvin–Helmholtz shear, lid-driven cavity, + a self-
                 sustaining FIRE (combustion) scene.
    particles.ts ParticleSystem — passive tracer ensemble advected by the flow,
                 recycled on death/escape, drawn as velocity-aligned streaks.
    selftest.ts  runSelfTest() — the numerical verification suite (25 invariant /
                 closed-form checks across 9 groups, incl. CG, combustion, LIC,
                 Q-criterion). Pure, DOM-free, deterministic.
    engine.ts    FluidEngine — rAF loop, pointer→force plumbing, scene state,
                 tracer-particle update, HOVER-PROBE readout, LIC phase advance,
                 live diagnostics, FPS/step-time stats.
  render/
    colormaps.ts inferno / viridis / ice / magma / heat ramps + diverging map.
    lic.ts       makeNoise + computeLIC — pure Line Integral Convolution core
                 (noise smeared along RK2 streamlines, travelling-cosine kernel).
    renderer.ts  Field → ImageData at grid res, upscaled by the canvas; dye /
                 speed / vorticity / pressure / TEMPERATURE / LIC / SCHLIEREN /
                 Q-CRITERION modes, plus velocity-arrow, STREAMLINE (RK2),
                 tracer-PARTICLE overlays and the hover-probe crosshair.
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
- **Two pressure solvers, one system.** The projection can use red-black SOR *or*
  matrix-free Jacobi-preconditioned **Conjugate Gradients**. CG applies the exact
  same 5-point Neumann/obstacle Laplacian SOR relaxes (`applyPoisson`), so they
  converge to the same field; CG just gets there in far fewer iterations (Krylov vs
  stationary). The CG RHS is shifted mean-zero first — the compatibility condition
  for the singular pure-Neumann system — and only ∇p is used, so the constant
  null-space mode is irrelevant. A divergence guard stops the finite-precision
  breakdown that pure CG hits if iterated far past convergence.
- **Reactive flow.** A `fuel` field is advected like dye; `combust()` burns it above
  `ignition` at a first-order rate (`1−e^{−rate·(1+ΔT)·dt}`), adds `heatRelease·burn`
  to T, and deposits flame/soot dye. `smokeBuoyancy` is a variable-density
  (non-Boussinesq) lift ∝ local dye mass, separate from the thermal Boussinesq term.
- **Known limitation (measured, not hidden):** on a collocated grid the divergence
  and pressure-gradient stencils compose to a wide one, so projection removes the
  smooth divergence (~5–6× in RMS) but leaves a small odd/even checkerboard residual
  — *independent of solver* (CG and SOR hit the same floor). The verify suite tests
  the *linear solver's* true convergence (mean-zero residual) to sidestep it.

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
- [x] **Conjugate-Gradient (Jacobi-preconditioned) pressure solver** — a Krylov alternative to
      red-black SOR, selectable in the UI; converges the Poisson residual orders of magnitude
      faster per iteration and to the same projected field (verified)
- [x] **Line-Integral-Convolution (LIC) render** for a dense, texture-like flow image —
      animated (the texture streams downstream), with a pure, DOM-free core so it's verifiable
- [x] **Schlieren / shadowgraph render mode** — |∇ρ| of the dye field, the classic
      density-gradient flow-visualisation look
- [x] **Q-criterion vortex render mode** — Q = ½(‖Ω‖²−‖S‖²) lights up true vortex cores
      (rotation beating strain) where raw vorticity can't separate a vortex from plain shear
- [x] **Fuel brush tool** — paint fuel directly and ignite it interactively
- [x] **Hover probe** — read u, v, |u|, ω, p, T (and fuel) at the cursor, live in the HUD,
      with an on-canvas crosshair
- [x] **Reactive flow: a combustion model + Fire scene** — an advected `fuel` field that ignites
      above a threshold temperature, releases heat (Arrhenius-lite), is consumed, and deposits
      flame/soot dye; **variable-density (non-Boussinesq) buoyancy** lifts the hot products
- [ ] Move the solver into a Web Worker so the UI never stutters at high res
- [ ] WebGL2 render path (texture upload) for 512²+ at 60fps
- [ ] A true MAC (staggered) grid pressure solve to kill the collocated checkerboard residual
- [ ] Geometric multigrid V-cycle Poisson solver (open-domain) for O(N) pressure solves
- [ ] Multigrid-preconditioned CG (combine the two solvers above for the best of both)
- [ ] Inflow/outflow (open) boundary conditions so the vortex street isn't recirculating

## Roadmap — 2026-06-18 Eddy 3.0: reactive flow, real solvers, dense visualisation (claude)

Eddy 2.0 made a solver you can *trust*. Eddy 3.0 makes it a solver that's *fast where it counts*,
*reactive*, and *legible at a glance* — three new axes, every one of them backed by the verify suite:

1. **A real Krylov solver.** The pressure Poisson system is symmetric positive-(semi)definite — the
   textbook case for **Conjugate Gradients**. Eddy now offers Jacobi-preconditioned CG alongside
   red-black SOR, matrix-free over the exact same 5-point Neumann/obstacle stencil. The verify page
   proves it: at an equal iteration budget CG leaves a residual several times lower than SOR (and
   keeps converging toward machine precision with more iterations), while landing on the *same*
   projected velocity field — a faster road to the same physics, not a different answer. The RHS is
   made mean-zero first so the Neumann null space can't poison CG.
2. **Reactive flow.** A new advected **fuel** field ignites above a threshold temperature, burns at
   a first-order (Arrhenius-lite) rate, releases heat back into the temperature field, and is
   consumed — depositing flame + soot dye as it goes. Coupled with **variable-density buoyancy**
   (lift proportional to local smoke concentration, distinct from the thermal Boussinesq term) it
   produces a genuine candle/bonfire **Fire** scene. Verified: no burn below ignition, fuel strictly
   decreases while heat strictly increases, fuel is conserved by pure advection when the rate is 0.
3. **Dense, animated visualisation.** **Line Integral Convolution** convolves a white-noise texture
   along the streamlines, so the *whole* field reads as flowing fabric (and it animates downstream).
   **Schlieren** shading shows |∇ρ| like a real shadowgraph, and the **Q-criterion** mode lights up
   true vortex cores (rotation beating strain) where raw vorticity can't tell a vortex from shear. A
   **hover probe** reads the actual field values (u, v, |u|, ω, p, T, fuel) under the cursor. The LIC
   core is a pure function, so the suite checks it too (maximum principle, identity under no flow,
   streamwise anisotropy under shear).

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
- 2026-06-18 (claude): **Eddy 3.0.** Three new axes (see roadmap above): (1) a matrix-free
  **Jacobi-preconditioned Conjugate-Gradient** pressure solver selectable beside red-black SOR —
  same 5-point Neumann/obstacle operator, mean-zero RHS for the singular Neumann system, and a
  finite-precision divergence guard; (2) a **reactive combustion model** — an advected `fuel`
  field that ignites above a threshold, burns first-order, releases heat and deposits flame/soot
  dye — plus **variable-density (non-Boussinesq) buoyancy** and a self-sustaining **Fire** scene;
  (3) dense flow visualisation — animated **Line Integral Convolution** (pure `lic.ts` core),
  **schlieren** |∇ρ| shading, a **Q-criterion** vortex-core mode, and a **hover probe** reading
  u/v/|u|/ω/p/T/fuel under the cursor with an on-canvas crosshair; plus an interactive **Fuel
  brush**. Extended the verification suite from **14→25 checks (6→9 groups)**: CG beats SOR per
  iteration / converges / respects obstacles / lands on the same field; combustion doesn't ignite
  below threshold / consumes fuel while releasing heat / conserves fuel when off; LIC is the
  identity under no flow / obeys a maximum principle / streaks along the flow; the Q-criterion
  separates a pure rotation (Q=Ω²) from a pure shear (Q=0). Ran the full suite under Node (25/25
  green) and smoke-tested the Fire scene with both solvers (stable, bounded). Updated Controls
  (solver picker, combustion panel, LIC/Schlieren/Q-vortex modes, fuel + probe toggle), the HUD
  probe readout, and the About page. Full gate green (scope + conformance + lint + build).
