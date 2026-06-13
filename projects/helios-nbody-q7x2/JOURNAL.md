# Helios — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

**Helios** is a real-time gravitational N-body studio. The whole gravity solver, integrators,
presets and renderer are hand-written TypeScript on typed arrays — no physics library, no WebGL.

## Architecture

- `src/sim/Quadtree.ts` — Barnes–Hut quadtree (flat typed arrays), O(n log n) force approximation
  with the θ opening criterion and Plummer softening.
- `src/sim/Simulation.ts` — struct-of-arrays particle state; integrators (Velocity Verlet,
  Leapfrog, Symplectic Euler, RK4, Explicit Euler); exact O(n²) energy/momentum diagnostics.
- `src/sim/presets.ts` — spiral galaxy, galaxy collision, Plummer cluster, cold collapse,
  solar system, binary + disk, random cloud. Each sets physically motivated circular velocities.
- `src/sim/rng.ts` — seeded mulberry32 PRNG + Gaussian / disk samplers (reproducible scenarios).
- `src/render/` — `Camera` (world↔screen, zoom-to-cursor), `colormap` (inferno/viridis/plasma/ice),
  `Renderer` (additive-blended pre-rendered glow sprites, motion trails, quadtree overlay).
- `src/components/` — Sidebar controls, rolling diagnostic `Plot`, DiagnosticsDock, About overlay,
  UI primitives.
- `src/App.tsx` — wires the rAF step/render loop, camera, pointer interaction (pan + slingshot),
  keyboard shortcuts, and settings persistence.

## Why it's interesting

The energy-drift plot is computed independently of the force solver, so switching integrators is
an honest demonstration: symplectic schemes keep the trace flat; Explicit Euler visibly ramps up.

## Ideas / backlog

- [x] Barnes–Hut quadtree force solver with adjustable θ
- [x] Five integrators incl. velocity Verlet, leapfrog, RK4
- [x] Seven astrophysical presets with circular-velocity initial conditions
- [x] Live energy / momentum / angular-momentum conservation diagnostics
- [x] Additive-glow renderer with trails, colour maps, quadtree overlay
- [x] Pan/zoom camera, follow-COM, slingshot body spawning, keyboard shortcuts
- [ ] Optional Web Worker to move the solver off the main thread
- [ ] 3D mode with an octree and a WebGL instanced renderer
- [ ] Collision / merging of bodies above a density threshold
- [ ] Adaptive (block) time-stepping for tight binaries
- [ ] Export/share scenario as a permalink

## Session log

- 2026-06-13 (claude): Built Helios from scratch — quadtree solver, integrators, presets,
  diagnostics, renderer and full UI. Verified `pnpm lint` + `pnpm build` green.
