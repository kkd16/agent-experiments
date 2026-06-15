# Helios — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

**Helios** is a real-time gravitational N-body studio. The whole gravity solver, integrators,
presets and renderer are hand-written TypeScript on typed arrays — no physics library, no WebGL.

## Architecture

- `src/sim/Quadtree.ts` — Barnes–Hut quadtree (flat typed arrays), O(n log n) force approximation
  with the θ opening criterion and Plummer softening.
- `src/sim/Simulation.ts` — struct-of-arrays particle state; integrators (Velocity Verlet,
  Leapfrog, **Yoshida 4 & Yoshida 6 symplectic**, Symplectic Euler, RK4, Explicit Euler);
  exact O(n²) energy / momentum / **virial** diagnostics. The Verlet kick–drift–kick is
  factored into a `verletSub(dt)` base map that both Yoshida compositions reuse (a 3-substep
  triple-jump for 4th order, a 7-substep symmetric composition for 6th order).
- `src/sim/chaos.ts` — **chaos analysis** via the variational (tangent) equations: the exact
  analytic tidal tensor (gradient of the softened pair force), a symplectic Verlet that
  advances the real and tangent states together, the maximal Lyapunov exponent (Benettin)
  and MEGNO ⟨Y⟩ (Cincotta & Simó), plus an order/chaos classifier. Self-contained O(N²),
  exact (no Barnes–Hut approximation pollutes the measurement).
- `src/sim/orbit.ts` — pure osculating-orbit solver (eccentricity vector + vis-viva) and conic
  samplers used by both the inspector and the on-canvas ellipse overlay.
- `src/sim/restricted3body.ts` — circular restricted-three-body structure for the two heaviest
  bodies: Lagrange points L1–L5 and marching-squares zero-velocity (Hill-region) contours,
  mapped from the dimensionless co-rotating frame onto the live primary axis.
- `src/sim/selftest.ts` — in-app numerical self-test that re-derives Helios's physical claims.
- `src/sim/presets.ts` — spiral galaxy, galaxy collision, Plummer cluster, cold collapse,
  solar system, binary + disk, Saturn's rings, Trojans, figure-eight, **broken eight**,
  Pythagorean, Kepler showcase, horseshoe & tadpole, three-body waltz, random cloud. Each
  sets physically motivated initial conditions.
- `src/sim/rng.ts` — seeded mulberry32 PRNG + Gaussian / disk samplers (reproducible scenarios).
- `src/render/` — `Camera` (world↔screen, zoom-to-cursor), `colormap` (inferno/viridis/plasma/ice),
  `Renderer` (additive-blended pre-rendered glow sprites, motion trails, quadtree overlay).
- `src/components/` — Sidebar controls, rolling diagnostic `Plot`, DiagnosticsDock, the
  **Chaos Lab** panel (`ChaosPanel`), About overlay, UI primitives.
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
- [ ] Colour bodies by their finite-time Lyapunov contribution (per-body chaos map)
- [ ] Frequency-map analysis (FMA) of an orbit's fundamental frequencies
- [ ] Wisdom–Holman mixed-variable symplectic integrator for hierarchical systems

### Helios 3.0 — Chaos & Higher-Order Symplectic Integration (this session)

- [x] **Yoshida 6th-order symplectic integrator** (`yoshida6`) — a seven-substep
      symmetric composition of the leapfrog base map (Yoshida 1990 "Solution A"),
      O(Δt⁶) error yet exactly symplectic. The self-test measures ~40,000× lower
      energy drift than Yoshida 4 at equal Δt (≈1e-13, near machine precision).
- [x] **Chaos-analysis engine** (`src/sim/chaos.ts`) — integrates the variational
      (tangent) equations alongside the real trajectory using the exact analytic
      tidal tensor (the gradient of the softened pair force), advanced by a
      symplectic velocity-Verlet on an exact O(N²) force. Computes the maximal
      **Lyapunov exponent** (Benettin renormalisation) and **MEGNO** ⟨Y⟩
      (Cincotta & Simó) — which → 2 for regular orbits and grows as (λ/2)·t for
      chaotic ones — with a robust order/chaos classifier and a sampled history.
- [x] **Chaos Lab UI** (`src/components/ChaosPanel.tsx`) — a sidebar lab that runs
      the analysis on the live system and reports the verdict (Regular / Weakly
      chaotic / Chaotic), MEGNO ⟨Y⟩, λ, the Lyapunov (e-folding) time and the
      observed e-foldings, with MEGNO-vs-time and λ(t) plots. Key `y` runs it.
- [x] **"Broken Eight" preset** — the figure-eight choreography given a 0.4%
      velocity nudge: it traces the eight, then chaos unravels it. The perfect
      A/B with the pristine Figure-Eight in the Chaos Lab.
- [x] **Self-test grew 10 → 15 checks** — Yoshida 6 beats Yoshida 4 on energy;
      velocity Verlet is time-reversible (forward then velocity-reversed retrace
      to ~1e-15); the analytic tidal tensor matches a central finite difference of
      the force (~1e-10); MEGNO recovers ⟨Y⟩ → 2 on a regular orbit; and the
      Pythagorean three-body problem is flagged chaotic with λ above the regular
      orbit's. (All 15 green this session.)
- [x] **About + docs** — new sections on higher-order symplectic integration and
      reversibility, and on chaos (MEGNO, Lyapunov, the tidal tensor).

### Helios 2.0 — Precision & Analysis (this session)

- [x] **Yoshida 4th-order symplectic integrator** — a symmetric triple-jump
      composition of leapfrog substeps (θ = 1/(2 − 2^⅓)). Fourth-order accurate
      yet symplectic; the self-test measures ~10⁴× lower energy drift than Verlet
      at equal Δt on an eccentric two-body orbit. In the menu with eval/blurb.
- [x] **Classical orbital-element solver** (`src/sim/orbit.ts`) — from a body's
      relative state vector computes the full osculating Kepler orbit via the
      eccentricity vector and vis-viva: e, ϖ, a, p, periapsis/apoapsis, period,
      true anomaly, shape and prograde/retrograde. Pure functions, self-tested.
- [x] **Osculating-orbit overlay** — draws the instantaneous Kepler conic the
      selected body rides, around its chosen primary, with periapsis/apoapsis
      markers. Primary = heaviest body or barycentre. Toggle in Analysis / key o.
- [x] **Richer inspector** — separation, shape, eccentricity, semi-major axis,
      periapsis/apoapsis, period, ϖ, true anomaly, ε, h, direction, primary.
- [x] **Restricted three-body analysis overlay** (`src/sim/restricted3body.ts`)
      — for the two heaviest bodies solves the five Lagrange points (collinear
      L1–L3 by bisecting ∂Ω/∂x, triangular L4/L5 at the equilateral apices) and
      renders the zero-velocity (Hill-region) curves of the Jacobi integral as a
      marching-squares contour in the co-rotating frame. Toggle in Analysis/key l.
- [x] **Virial diagnostics** — live virial ratio 2T/|U| (→1 at equilibrium) in
      the dock, colour-graded by distance from 1.
- [x] **New presets** — an eccentric "Kepler Showcase", a co-orbital "Horseshoe
      & Tadpole" restricted-3-body demo, and a hierarchical "Three-Body Waltz".
- [x] **Jacobi constant readout** — the inspector reports a selected test
      particle's Jacobi constant in the two-heaviest-body co-rotating frame
      (un-normalized, sign-robust form C = n²ρ² + 2G(m₁/r₁+m₂/r₂) − v_rot²).
- [x] **Physics self-test harness** (`src/sim/selftest.ts`) — ten checks: the
      orbit solver recovers a/e/period for circular, eccentric and hyperbolic
      orbits; Yoshida4 beats Verlet on energy (~10⁴×); Euler drifts; the Lagrange
      points satisfy ∇Ω ≈ 0; L4 sits at the equilateral apex; momentum is
      conserved at θ=0; the virial ratio averages to 1; and the Jacobi constant
      is conserved along a test-particle path. Runs from About, shown in-app.
      (All 10 green this session.)
- [x] **More keyboard shortcuts & UI wiring** — o = osculating orbit, l =
      Lagrange/Hill overlay; new Analysis section in the sidebar.

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
- 2026-06-15 (claude): **Helios 2.0 — Precision & Analysis.** Added a 4th-order
  Yoshida symplectic integrator (measured ~10⁴× lower energy drift than Verlet at
  equal Δt); a from-scratch osculating-orbit solver (`orbit.ts`) that reconstructs
  the full Kepler conic of any selected body from its eccentricity vector and
  vis-viva energy, drawn on-canvas with periapsis/apoapsis markers and surfaced in
  a much richer inspector (e, a, p, periapsis/apoapsis, period, ϖ, ν, ε, h,
  prograde/retrograde) about a chosen primary (heaviest body or barycentre); a
  restricted-three-body analysis layer (`restricted3body.ts`) that solves the five
  Lagrange points and renders the Jacobi zero-velocity / Hill-region curves via
  marching squares in the co-rotating frame for the two heaviest bodies; a live
  virial-ratio diagnostic; three new presets (Kepler Showcase, Horseshoe & Tadpole,
  Three-Body Waltz); new keyboard shortcuts (o, l) and an Analysis sidebar section;
  and an in-app numerical self-test (`selftest.ts`, runnable from About) of nine
  checks — orbit-element recovery (circular/eccentric/hyperbolic), Yoshida-vs-Verlet
  energy, Euler drift, Lagrange equilibria ∇Ω≈0, L4 at the equilateral apex,
  momentum conservation at θ=0, the virial theorem, and Jacobi-constant
  conservation. Also added a Jacobi-constant readout in the inspector for test
  particles in the restricted-3-body frame. All ten self-test checks pass;
  verified `pnpm lint` + `pnpm build` green via `scripts/verify-project.mjs`.
- 2026-06-15 (claude/claude-opus-4-8): **Helios 3.0 — Chaos & Higher-Order Symplectic
  Integration.** Added a **6th-order Yoshida** symplectic integrator (`yoshida6`) — a
  seven-substep symmetric composition of the existing leapfrog base map (Solution A,
  Yoshida 1990) — measured at ~40,000× lower energy drift than Yoshida 4 at equal Δt
  (≈1e-13, near machine precision). Built a from-scratch **chaos-analysis engine**
  (`chaos.ts`) that integrates the variational (tangent) equations alongside the real
  trajectory using the exact analytic **tidal tensor** (the gradient of the softened pair
  force), advancing both with a symplectic velocity-Verlet on an exact O(N²) force, and
  computes the maximal **Lyapunov exponent** (Benettin renormalisation) and **MEGNO** ⟨Y⟩
  (Cincotta & Simó — →2 for regular orbits, growing as (λ/2)·t for chaotic ones) with a
  robust order/chaos classifier (which correctly separates regular vs polynomial-from
  -exponential growth by normalising the e-folding count by ln t) and a sampled history.
  Added a **Chaos Lab** sidebar panel (`ChaosPanel.tsx`) that runs the analysis on the live
  system and reports the verdict, MEGNO, λ, Lyapunov time, e-foldings and MEGNO/λ-vs-time
  plots (key `y`); a **"Broken Eight"** preset (the figure-eight nudged 0.4% — a chaotic
  twin of a regular orbit, for an A/B in the lab); and grew the in-app self-test from 10 to
  **15 checks** (Yoshida 6 ≫ Yoshida 4 on energy; velocity Verlet is time-reversible to
  ~1e-15; the analytic tidal tensor matches a central finite difference to ~1e-10; MEGNO
  recovers ⟨Y⟩→2 on a regular orbit; the Pythagorean three-body problem is flagged chaotic
  with λ above the regular orbit's). About/docs gained sections on higher-order symplectic
  integration, reversibility, and chaos. All 15 self-test checks pass; verified `pnpm lint`
  + `pnpm build` green via `scripts/verify-project.mjs`.
