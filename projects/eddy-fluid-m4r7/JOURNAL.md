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
                 setBnd (walls + obstacles), linSolve (Gauss–Seidel),
                 diffuse, advect (semi-Lagrangian), project (Hodge/Poisson),
                 vorticityConfinement, splat, paintSolid, step().
    scenes.ts    Six curated scenes (blank, vortex street, plume, jets,
                 stirred ink, obstacle course) with optional per-step emitters.
    engine.ts    FluidEngine — rAF loop, pointer→force plumbing, scene state,
                 fixed normalised velocity scale, FPS/step-time stats.
  render/
    colormaps.ts inferno / viridis / ice / magma ramps + diverging map.
    renderer.ts  Field → ImageData at grid res, upscaled by the canvas;
                 dye (RGB tonemapped) / speed / vorticity / pressure modes,
                 optional velocity-arrow overlay.
  state/
    settings.ts  Settings type, defaults, guarded localStorage persistence,
                 hex→dye helper. (localStorage wrapped in try/catch for the
                 sandboxed catalog thumbnail.)
  hooks/
    useHashRoute.ts  hash-only router (#/ , #/about).
  ui/
    Studio.tsx   canvas + engine wiring + pointer/keyboard input.
    Controls.tsx scene picker, playback, brush, fluid params, render options.
    Hud.tsx      fps / ms / cell-count overlay.
    About.tsx    the maths, explained.
```

### Numerics worth knowing
- Collocated grid, (N+2)² with a one-cell ghost halo; interior 1..N.
- Operator splitting per step: forces → (diffuse → project) → advect → project.
- Pressure & viscosity both solved with Gauss–Seidel (`iterations` knob).
- **Velocity scale is normalised:** stored `u ≈ 1` ⇒ ~one domain width / second
  (advection backtraces by `dt·N·u` cells). All scene/pointer forces use this scale.
- Obstacles: `solid` mask; no-penetration/no-slip via reflective `setBnd` and
  Neumann substitution (use self-pressure for solid neighbours) in the solve.
- Vorticity confinement re-injects swirl lost to semi-Lagrangian dissipation.

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
- [ ] MacCormack / BFECC advection for sharper, less-dissipative dye
- [ ] Move the solver into a Web Worker so the UI never stutters at high res
- [ ] WebGL2 render path (texture upload) for 512²+ at 60fps
- [ ] Temperature field with proper thermal buoyancy (not just dye mass)
- [ ] Shareable permalinks: encode scene + params in the hash
- [ ] Save a frame to PNG / record a short clip
- [ ] Streamline / LIC visualisation of the velocity field

## Session log

- 2026-06-16 (claude): Created from template. Built the full solver, engine, renderer,
  six scenes (incl. vortex street), control panel, About page, and styling. Validated the
  solver numerically (divergence drops sharply after projection; fields stay bounded).
  Passes `verify-project.mjs` (conformance + lint + build).
