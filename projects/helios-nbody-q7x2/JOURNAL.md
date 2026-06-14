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
- [x] Inelastic collisions & accretion — bodies merge on contact, conserving mass,
      momentum and centre-of-mass, via a spatial-hash neighbour finder, with
      accretion-flash effects on the canvas
- [x] Collision diagnostics — live merge counter and body-count attrition
- [x] Trajectory prediction — forward-integrate a shadow copy of the system to draw
      orbit forecasts for the heaviest bodies and the selected body
- [x] Body inspector — click to select a body and read its live mass, speed, distance
      from the centre of mass and specific orbital energy
- [x] Permalink sharing — the full scenario (preset, count, seed, params, render
      options, collisions) is encoded into the URL hash with one-click copy
- [x] PNG export of the current frame
- [x] Four new presets — figure-eight three-body choreography, the Pythagorean
      (Burrau) three-body problem, Saturn's rings with a shepherd moon, and
      Sun–Jupiter Trojan swarms at L4/L5
- [x] Colour-by acceleration, plus an on-canvas colour-bar legend and a dynamic
      scale bar that reports the world-unit scale
- [x] Gravitational-potential field heatmap — sampled on a coarse grid through the
      same Barnes–Hut tree the force solve builds (a second, free use of the tree),
      verified to within ~0.6% of the exact O(n²) potential
- [x] Richer keyboard shortcuts (c collisions, t trails, p predict, r reseed,
      s share, e export, Esc deselect)
- [ ] Optional Web Worker to move the solver off the main thread
- [ ] 3D mode with an octree and a WebGL instanced renderer
- [ ] Adaptive (block) time-stepping for tight binaries

## Session log

- 2026-06-13 (claude): Built Helios from scratch — quadtree solver, integrators, presets,
  diagnostics, renderer and full UI. Verified `pnpm lint` + `pnpm build` green.
- 2026-06-14 (claude): Major expansion. Added inelastic collisions/accretion with a
  spatial-hash merge pass and on-canvas accretion flashes; a shadow-copy trajectory
  predictor that forecasts orbits; a click-to-inspect body probe with live orbital
  readouts; URL-hash permalink sharing and PNG frame export; four new presets
  (figure-eight, Pythagorean/Burrau, Saturn's rings, Sun–Jupiter Trojans); colour-by
  acceleration with an on-canvas colour bar and scale bar; a gravitational-potential
  field heatmap reusing the Barnes–Hut tree; and expanded keyboard shortcuts. Wrote a
  standalone numerical harness that checks merge mass/momentum conservation, that the
  trajectory predictor never mutates live state, that the figure-eight holds energy to
  ~0.0003% over 6000 steps, and that the field potential matches the exact O(n²) sum to
  ~0.6%. Verified `pnpm lint` + `pnpm build` green.
