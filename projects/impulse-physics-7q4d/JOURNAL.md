# Impulse — journal

A 2D rigid-body physics engine written from scratch (no physics libraries), plus an
interactive playground that renders it. This is the app's long-lived memory — read it first
when picking the project back up.

## What it is

`src/engine/` is a self-contained, dependency-free physics engine. The architecture mirrors
the structure of a production engine (Box2D), implemented from first principles and verified:

- **Math** (`math.ts`, `aabb.ts`, `random.ts`) — immutable `Vec2`, `Rot`, `Transform`,
  `Mat22`, AABBs, and a deterministic mulberry32 PRNG so simulations are reproducible.
- **Shapes** (`shapes.ts`) — a unified **core + skin radius** model: circles (a point + r),
  capsules (a segment + r) and convex polygons (a hull + an optional rounding r). Polygons
  are built via Andrew's monotone-chain convex hull; mass/centroid/inertia come from the
  closed-form polygon integrals and a closed-form capsule (rectangle + two caps), each with a
  parallel-axis shift to the center of mass. `convexProxy` exposes any shape's world-space
  core (verts + face normals + radius) to the narrowphase.
- **Collision**
  - `collision/gjk.ts` — GJK distance (with witness points) + EPA penetration, with a `core`
    flag so it can measure either full skins (distance inspector) or bare cores (narrowphase,
    CCD).
  - `collision/manifold.ts` — the solver's collision path: analytic circle/circle and
    circle/capsule, plus one radius-aware `collideConvex` for every capsule/polygon pair. GJK
    supplies the exact normal for shallow contacts (catching cap-to-cap cases pure SAT
    misses), SAT the normal for deep overlap; reference/incident-face clipping offset by the
    two skin radii yields stable 1–2 point manifolds with feature ids for warm starting.
  - `collision/toi.ts` — a conservative-advancement **time-of-impact** solver on core GJK
    distance with a rotation-aware closing-speed bound; never skips past first contact.
- **Broadphase** (`broadphase.ts`) — a dynamic AABB tree (fat AABBs, surface-area-heuristic
  insertion, AVL-style rotations) with pair generation and ray casting.
- **Solver** (`contact.ts`) — warm-started sequential impulses with Coulomb friction and
  restitution, **split-impulse** (pseudo-velocity) position correction so stacks stay crisp
  and resting bodies actually sleep, **plus an exact two-point block LCP** (Box2D-Lite's
  four-case analysis) so wide stacks settle flat instead of rocking.
- **Fluids** (`fluid.ts`) — a `BuoyancyZone` water body. The submerged area + centre of
  buoyancy of any shape is integrated in closed form by clipping a world outline against the
  waterline; real Archimedes lift ρ_fluid·A·(−g) is applied there, with area-scaled drag.
- **Joints** (`joints/`) — the full Box2D family: revolute (motor + angle limits), distance
  (rigid + soft spring), weld, mouse, prismatic (motor + travel limits), **wheel** (rigid line +
  sprung suspension + drive motor), **pulley** (two ground anchors + length ratio), **gear**
  (couples two revolute/prismatic joints by a ratio — gear trains & rack-and-pinion), and
  **motor** (drives B's pose relative to A with a bounded, overpowerable force/torque). Limits
  are speculative one-sided constraints that coexist with the motors. The structural joints
  report their reaction force/torque, so any of them can be made **breakable** (a force/torque
  budget; the world removes it and fires `onJointBreak` when overloaded).
- **Materials** — a body can carry a `tangentSpeed` to act as a **conveyor belt**: the contact
  solver folds the relative surface velocity into the friction target so the belt drags whatever
  rests on it up to speed.
- **Soft bodies** (`soft/`, v5) — a second physics paradigm beside the rigid solver: **XPBD**
  (extended position-based dynamics). Point-mass particles held by compliant distance, bending
  and **area-preservation** constraints, advanced with the "small-steps" substep scheme so a
  body's *material* (compliance) is step-size independent. Particles collide with every rigid
  shape through the engine's own `core+radius` math (`collideParticle`) and exchange momentum
  two-ways, so a heavy blob shoves a light crate and a falling crate dents a hammock. Builders
  for blobs (pressurised rings), cloth/membranes, ropes and lattice solids (`makeBlob`,
  `makeCloth`, `makeRope`, `makeSoftBox`).
- **World** (`world.ts`) — fixed-step orchestration: broadphase → narrowphase (with begin/end
  **contact events**) → fluid forces → island assembly (union-find) → solve → **break overloaded
  joints** → **gather impact loads** → integrate → **CCD sweep of bullet bodies** → **shatter
  brittle bodies** → island-based sleeping. Plus ray casting, point queries, AABB region queries,
  a convex **`shapeCast`**, a **radial-impulse / explosion** field (`applyRadialImpulse`, with
  distance falloff + static-geometry occlusion), and **sensor** bodies (detected, never solved).
- **SPH fluid** (`sph/`, v7) — a third physics paradigm: an incompressible **Position-Based
  Fluid** (Macklin & Müller 2013). `kernels.ts` holds the 2-D poly6 / spiky-gradient SPH kernels;
  `hash.ts` a uniform spatial hash for O(n) neighbour finding; `fluid.ts` the `FluidSystem` — the
  density-constraint Jacobi solve (CFM relaxation, compression-only λ), XSPH viscosity, vorticity
  confinement, jet emitters, and **two-way rigid coupling** (particles depenetrate from shapes via
  the soft engine's `collideParticle`, and the body is pushed back inverse-mass-weighted, giving
  genuine hydrostatic buoyancy — a light body floats, a dense one sinks). Stepped after the soft
  bodies; one `world.fluid`. A metaball renderer colours particles by speed, and a 💧 spray tool
  paints water into any scene.
- **Fracture** (`fracture/`, v6) — real-time rigid-body destruction. A body can carry a
  `FractureMaterial` (toughness, seed count/pattern, generation cap) that makes it brittle.
  `clip.ts` is a Sutherland–Hodgman convex half-plane clip + signed area + convex point test;
  `voronoi.ts` builds a power-free **Voronoi partition** of the convex hull (clip against one
  perpendicular-bisector half-plane per seed) and scatters seeds (uniform / glass-style radial
  rings about the impact / jittered grid); `fracture.ts` turns the cells into shard bodies whose
  motion is the parent's rigid velocity field `vᵢ = v + ω×(cᵢ−C)`, so mass, **linear momentum**
  and **angular momentum** are conserved exactly. The world auto-shatters any brittle body whose
  strongest contact this step beat its toughness (ejecting shards in proportion to the blow),
  fires `onFracture`, and leaves a decaying impact spark for the renderer. A click-to-shatter
  pointer tool (the **Shatter** spawn tool) triggers it by hand.

`src/render/`, `src/scenes/`, `src/ui/` are the playground: a Canvas2D debug renderer (drawing
capsules, rounded polygons, animated water, dashed sensors, pulley ropes, conveyor flow
arrows, **fracture impact sparks** and a **speed-shaded SPH metaball fluid**), 46 demo scenes, and
a React UI with live solver controls (incl. CCD and block-solver toggles), **Shatter** &amp;
**💧 water** pointer tools, debug overlays, a live fluid telemetry HUD, and a verification modal.

## Verification

`src/verify/suite.ts` runs 166 checks against real engine code paths (mass integrals incl.
the closed-form capsule, GJK vs analytic gaps, EPA depth, manifold correctness for boxes,
capsules and rounded polygons, free-fall, elastic-collision momentum conservation,
resting/sleeping, revolute constraint drift, continuous-collision no-tunnel, revolute &
prismatic joint limits, the block-LCP complementarity conditions, buoyancy submerged-area &
floating-equilibrium integrals, AABB queries & shape-cast fractions, the wheel-joint
suspension, sensor pass-through & contact-event counts, **conveyor surface speed**, **radial-
impulse symmetry / falloff / occlusion**, **pulley length conservation**, **gear ratio &
rack-and-pinion travel**, **motor-joint targeting & stall**, **breakable-joint thresholds**,
bit-for-bit determinism, broadphase correctness, ray casting incl. capsules, **half-plane
clipping**, **Voronoi cells tiling their parent exactly + convexity + site-in-own-cell**, and
**fracture conservation** — Σ shard mass/area = parent, Σ linear momentum = parent, Σ angular
momentum about the COM = I·ω, deterministic shatters, live impact shatter + generation cap),
and **SPH fluids** (the poly6 kernel numerically integrating to 1, the spiky gradient's sign &
support, the spatial hash vs brute force, rest-density recovery, a settling column's
incompressibility / mass conservation / hydrostatic rest / no-escape, communicating-vessel level
equalisation, two-way buoyancy (float vs sink) + a jet pushing a body, and fluid determinism).
All 166 pass; click **Verify engine** in the app.

## Ideas / backlog

- [x] Core math, shapes, mass properties, convex hull
- [x] GJK distance + EPA penetration
- [x] SAT + clipping two-point manifolds with warm-start ids
- [x] Dynamic AABB-tree broadphase with ray casting
- [x] Sequential-impulse contact solver + split-impulse position correction
- [x] Revolute, distance/spring, weld, mouse, prismatic joints
- [x] Islands + sleeping
- [x] 15 demo scenes (pyramid, towers, arch, cradle, bridge, ragdoll, springs, motors,
      tumbler, dominoes, Galton board, friction, restitution, stress, sandbox)
- [x] Canvas renderer with debug overlays (AABBs, contacts, BVH, COM, velocities, joints)
- [x] In-app 31-check verification suite (all passing)
- [x] Block solver for 2-point contact manifolds (exact LCP per manifold) — shipped in v3
- [x] Conveyor surfaces — per-body `tangentSpeed` injected into the friction target (v4)
- [x] Radial impulse / explosion field (`World.applyRadialImpulse`) with line-of-sight occlusion (v4)
- [x] Pulley joint (two ground anchors, length ratio) (v4)
- [x] Gear joint (couples two revolute/prismatic joints by a ratio — gear trains & rack-and-pinion) (v4)
- [x] Motor joint (drives B's pose relative to A — overpowerable moving platforms) (v4)
- [x] Breakable joints (reaction-force/torque budget + `onJointBreak` event) (v4)
- [x] **Soft bodies (XPBD)** — particles + compliant distance/bend/area constraints, two-way
      coupled to the rigid world; blob/cloth/rope/lattice builders, 6 scenes, soft-body grabbing,
      14 new verification checks (v5)
- [x] **Rigid-body fracture (v6)** — from-scratch convex half-plane clip + power-free Voronoi
      partition, glass-style radial seed scatter, momentum-conserving shard decomposition,
      impact-triggered auto-shatter with a generation cap, a click-to-shatter pointer tool, an
      impact-spark renderer, 5 scenes and 23 new verification checks
- [x] **Position-Based Fluids — SPH (v7)** — a third physics paradigm: incompressible
      particle fluid (Macklin & Müller 2013). From-scratch 2-D SPH kernels (poly6 + spiky),
      a uniform spatial hash, the density-constraint Jacobi solve with CFM relaxation,
      artificial-pressure surface tension, XSPH viscosity, vorticity confinement, jet emitters,
      and two-way rigid coupling through the engine's own `collideParticle`; a metaball renderer,
      a "spray water" pointer tool, 7 scenes (a new Fluid category) and 20 new verification checks
- [ ] SVG/JSON scene export and a small scene editor
- [ ] Self-collision *within* a soft body (intra-body particle contacts)
- [ ] Pressure (rest-area > natural) without the energy it currently feeds a confined body
- [ ] **Persistent micro-cracks**: accumulate sub-toughness impacts so a body weakens and
      eventually shatters under repeated blows (fatigue), not just a single hard hit
- [ ] **Pre-scored / stress-field fracture**: bias the Voronoi seeds along a supplied crack
      pattern or the contact stress so breaks follow load paths, not just the impact point
- [ ] **Concave / compound fracture**: decompose a non-convex parent (or capsule/circle) before
      shattering so rounded and L-shaped bodies can break too
- [ ] **Debris budget & fade-out**: cull or merge the smallest shards after they settle to keep
      a long demolition session cheap
- [ ] Run the Voronoi build + shatter off the main thread for very large slabs

## v7 — the fluids release (Position-Based SPH, two-way coupled)

The seventh major upgrade adds a **third physics paradigm** beside the rigid solver and the
XPBD soft bodies: a genuine **incompressible particle fluid**. Where v3's `BuoyancyZone` is an
*analytic* water body (a half-plane that integrates the submerged area of a rigid shape and
applies Archimedes lift), v7 simulates the water itself as thousands of Lagrangian SPH particles
with **Position-Based Fluids** (Macklin & Müller, SIGGRAPH 2013) — the position-space cousin of
the soft engine, so it inherits the same unconditional stability and the same `collideParticle`
bridge into the rigid world. Fluid sloshes, splashes, makes waves, pours through funnels, drives
a waterwheel, and floats or sinks rigid bodies by their density — all from scratch, no libraries.

**Why PBF (and not SPH pressure forces).** Classic WCSPH/PCISPH push particles apart with a
stiff pressure force, which demands a tiny timestep. PBF instead treats incompressibility as a
*constraint* `C_i(p) = ρ_i/ρ₀ − 1 = 0` and solves it in position space with a few Jacobi
iterations per step — exactly the XPBD philosophy already proven in v5. It stays stable at the
engine's fixed 1/60 step, couples cleanly to the rigid solver (positions then a velocity pass),
and the incompressibility is *measurable* (average density → ρ₀), which makes it verifiable.

### Plan (this session)

1. **SPH kernels** (`sph/kernels.ts`). The 2-D **poly6** density kernel `W = 4/(πh⁸)(h²−r²)³`
   and the **spiky** gradient `∇W = −30/(πh⁵)(h−r)² r̂` (spiky's non-vanishing gradient at the
   origin is what stops particle clustering). Pure functions; the suite checks the analytic
   properties *and* numerically integrates poly6 over the disc to confirm it normalises to 1.
2. **Uniform spatial hash** (`sph/hash.ts`). A grid keyed by cell = `floor(p/h)`; `build` then
   `forEachNeighbor(i, cb)` visits the 3×3 cell block — O(n) neighbour finding. Cross-checked
   against brute force in the suite.
3. **The fluid system** (`sph/fluid.ts`). `FluidParticle` (position-primary, λ, density,
   accumulators) and `FluidSystem`:
   - predict positions (gravity, semi-implicit) → build the hash → cache the per-particle
     neighbour lists for the substep;
   - **density-constraint Jacobi solve** (`solverIterations` passes): density `ρ_i`, constraint
     `C_i`, the CFM-relaxed multiplier `λ_i = −C_i / (Σ|∇C|² + ε)`, then the symmetric position
     delta `Δp_i = 1/ρ₀ Σ(λ_i+λ_j+s_corr)∇W` with the **artificial-pressure** `s_corr` term
     (Δq, k, n) for surface tension / negative-pressure clustering control; depenetrate against
     the rigid candidates after each pass (positions, never a velocity bias — the v5 lesson);
   - derive velocities, then **XSPH viscosity** (cohesion) and **vorticity confinement** (puts
     back the swirl the constraint solve damps);
   - a final **velocity pass** that exchanges a restitution+friction impulse with each touched
     rigid body — the equal-and-opposite reaction is the two-way coupling — and clamps to an
     optional domain AABB (cheap walls so a tank needn't be boxed in rigid geometry);
   - **jet emitters** (origin, direction, speed, spread, rate) for fountains/hoses, a capacity
     cap, and metrics: count, average density, incompressibility error, mass, momentum, KE.
   - A `fillBox` builder packs a rectangle at rest spacing for scenes and tests.
4. **World integration** (`world.ts`). One optional `world.fluid: FluidSystem`; stepped right
   after the soft bodies (rigid poses already integrated → fixed colliders this step, reaction
   lands next step, the same stable one-step co-sim as v5). Particle count + average density
   added to `StepStats`; cleared in `clear()`.
5. **Renderer** (`renderer.ts`). A **metaball** look: each particle a radial-gradient disc,
   tinted by speed (deep blue at rest → cyan/white in fast jets), layered translucently so the
   field reads as a continuous surface; a `fluid` debug toggle, and a discrete-points mode.
6. **Interaction + scenes**. A **💧 water** pointer tool sprays fluid at the cursor (creating a
   default system if the scene has none). A new **Fluid** scene category: *Dam Break* (the
   canonical SPH benchmark), *Fountain* (an emitter raining back down), *Communicating Vessels*
   (levels equalise), *Splash Pool* (drop rigids: float vs sink by density), *Waterwheel* (a jet
   spins a revolute paddle wheel — coupling showcase), *Funnel* (draining through a gap) and a
   *Water Sandbox* for the spray tool.
7. **Verification** (`suite.ts`). A new **Fluids (SPH / PBF)** section, 20 checks: kernel
   sign/monotonicity/compact support + the **poly6 disc integral = 1**; spiky gradient zero at
   `r=h`; the spatial hash matching brute force exactly; **rest-density recovery** on a packed
   block (measured ρ ≈ ρ₀); **incompressibility** of a settled column (avg ρ ≈ ρ₀, bounded error,
   stays finite, no tunnelling out of the tank); **mass conservation**; **hydrostatic rest**
   (KE → 0); **communicating vessels** equalising; **two-way coupling** (a cork floats, an ingot
   sinks, the system stays finite); and **bit-for-bit determinism**.

Everything lives under `src/engine/sph/` + edits to the render/scene/verify/UI layer — no change
to the rigid or soft engine internals. Validated headlessly first (rest density, incompressibility,
coupling), then wired into the app. Target ≥ green on the exact CI gate (conformance + lint + build)
with the suite all-passing.

### Verified — all shipped ✅

- All four engine modules built (`kernels.ts`, `hash.ts`, `fluid.ts`, `sph/index.ts`), wired into
  `World` (one optional `world.fluid`, stepped after the soft bodies, particle count + average
  density surfaced in `StepStats`), the renderer (speed-shaded metaball fluid + a `fluidPoints`
  debug overlay), 7 scenes in a new **Fluid** category, the **💧 water** spray tool (works in any
  scene), the HUD fluid telemetry, and the verification suite.
- **20 new checks (146 → 166, all green).** Headline numbers from the headless harness: poly6
  integrates to **1.0000**; the spatial hash matches brute force with **0 misses**; a rest-packed
  block sits at **1.007 ρ₀**; a settling column ends at **0.996 ρ₀** with compression error
  **0.0027** and KE/n **0.04** (hydrostatic rest), never escaping the tank; communicating vessels
  equalise to **1.31 vs 1.25**; a light body floats (**y≈1.77**) while a dense one sinks
  (**y≈1.23**); a jet pushes a free block downstream; and two identical sims stay bit-for-bit
  identical.

### The two bugs the headless harness caught (before any UI)

1. **Spiky-gradient sign.** The first cut had `∇W` pointing *away* from the neighbour. In the PBF
   update `Δp ∝ Σ(λ_i+λ_j)∇W`, a compressed pair (λ < 0) then moved *together* — the column
   imploded to **avg density 12.6 ρ₀** and **KE ≈ 1.2 M**. The gradient must point *toward* the
   neighbour (`−rij`); one sign flip turned collapse into a stable fluid.
2. **Free-surface explosion.** With the constraint resolving both compression *and* rarefaction,
   sparse surface particles (a density deficit and a near-singular gradient sum) got an enormous λ
   and were flung at ~90 m/s. The robust standard fix — **resolve compression only** (`C = max(0,…)`)
   plus a spacing-relative correction clamp — settled it; cohesion is supplied instead by XSPH
   viscosity. A follow-on tuning find: the **artificial-pressure** term, on by default, holds the
   fluid ~0.74 ρ₀ (it's a repulsion); turning it off lets the fluid settle to a true **1.0 ρ₀**.

The one honest limitation: with a *velocity-only* (drag) coupling a small floating box drifts to
the floor (fluid escapes around it). Genuine buoyancy needed the **two-way position coupling** —
push the body out of the fluid, inverse-mass + inertia weighted — after which float-vs-sink became
robust and monotonic in density. A scalar-math rewrite of the hot neighbour loops (no `Vec2`
allocations) then ~halved the cost: **1075 particles at ~7 ms/step**.

### Session log
- 2026-06-22 (claude/claude-opus-4-8[1m]): **Impulse v7 — the fluids release (Position-Based SPH).**
  Added a third physics paradigm beside the rigid and soft solvers: an incompressible particle
  fluid (Macklin & Müller 2013), from scratch — 2-D SPH kernels, a uniform spatial hash, the
  density-constraint Jacobi solve, XSPH viscosity, vorticity confinement, jet emitters, and
  **two-way rigid coupling** that floats and sinks bodies by density. A speed-shaded metaball
  renderer, a 💧 spray tool, 7 scenes (Dam Break, Fountain, Communicating Vessels, Splash Pool,
  Waterwheel, Funnel, Water Sandbox) and 20 verification checks. Validated headlessly first (which
  caught the gradient-sign collapse and the free-surface explosion before any pixels), then wired
  into the app. Suite **146 → 166**, all green; scope + conformance + lint + build all pass.

## v6 — the fracture release (real-time Voronoi destruction) ✅ shipped

The sixth major upgrade lets rigid bodies **break**. A body marked brittle (it carries a
`FractureMaterial`) shatters into convex shards the moment a contact hits it hard enough — the
mechanism behind every glass pane, masonry wall and crumbling tower in the new scenes.

**The plan (all shipped this session):**

1. **Geometry foundation** (`fracture/clip.ts`). A Sutherland–Hodgman clip of a convex polygon
   against a single half-plane `{ p : n·p ≤ d }`, plus a signed polygon area and a convex
   point-in-polygon test. Three tiny pure functions, each verified directly.
2. **Power-free Voronoi** (`fracture/voronoi.ts`). The cell of a seed is the boundary clipped
   against one perpendicular-bisector half-plane per *other* seed — so on a convex boundary each
   cell is convex and the cells tile the parent exactly. Made robust to coincident seeds (the
   lowest index keeps the shared ground, the rest get an empty cell) so the partition stays
   exact — caught a real 1%-overlap bug in the radial pattern when two seeds collapsed onto the
   impact point. Three seed patterns: `uniform` (rejection sampling), `radial` (glass-style
   concentric rings about the impact, fine at the hole and coarse at the rim) and `grid`.
3. **Rigid decomposition** (`fracture/fracture.ts`). Each cell becomes a shard body sharing the
   parent's transform; its velocity is the parent's rigid velocity field sampled at the shard's
   own centre of mass, `vᵢ = v + ω×(cᵢ−C)`, with the parent's `ω`. This is provably
   conservative: Σ mᵢ = M, Σ mᵢvᵢ = M·v, and Σ (Iᵢωᵢ + mᵢ rᵢ×vᵢ) = I_parent·ω (parallel-axis).
   An optional outward `eject` impulse (a projectile's blow, intentionally *not* momentum-neutral)
   adds the scatter; a generation counter caps the cascade.
4. **World integration** (`world.ts`). After the velocity solve the world records the single
   largest contact normal-impulse landed on each brittle body; after integration it shatters any
   whose blow beat its `toughness` (ejecting shards ∝ the impulse), fires `onFracture`, and
   pushes a decaying impact spark. A public `world.fracture(body, point, opts)` exposes it.
5. **Interaction + render**. The **Shatter** spawn tool shatters a brittle body on click (and
   drops fresh brittle slabs on empty space); the renderer draws a fading shock ring + radial
   spark burst at each shatter.
6. **Scenes** — a new **Fracture** category: *Glass Pane* (a framed pane drilled by a bullet, the
   radial pattern spider-webbing from the hole), *Cannon & Wall* (a cannonball smashing a brittle
   wall into 100+ pieces of rubble), *Shatter Tower* (a heavy ball cascading down a brittle
   stack), *Crystal Gallery* (the same Voronoi carving triangles → octagons) and *Shatter Yard*
   (a sandbox for the click tool).
7. **Verification** — **23 new checks** (123 → 146, all green): clip area/whole/empty + point
   test; Voronoi area-partition (uniform & radial) + convexity + every seed inside its own cell;
   fracture conservation of mass, area, linear momentum and angular momentum (= I·ω); determinism;
   a non-polygon never fractures; a live impact actually shatters a slab and grows the body count;
   and the generation cap halts the cascade.

Subtle bug found & fixed via the headless harness: a fast **bullet** fired horizontally into the
wall froze at the CCD time-of-impact surface (no gravity to push it through, so the discrete
solver never formed a manifold and no impulse — hence no fracture — transferred). Dropping the
`bullet` flag on the cannonball lets it penetrate and deliver the blow; it can't tunnel since its
per-step travel (~0.57 m) is far under a block's width. Peak step ~3.4 ms with 102 bodies of
rubble. Lint + build + the exact CI gate all green.

## v5 — the soft-body release (XPBD deformables, two-way coupled) ✅ shipped

The fifth major upgrade adds a *second physics paradigm* alongside the rigid solver:
**deformable bodies**, built from scratch with **XPBD** (extended position-based dynamics).
Where the rigid engine reasons in velocities and impulses, the soft engine reasons in
*positions* — particles are moved to satisfy compliant constraints and their velocities are
*derived* from the motion, which is what makes it unconditionally stable no matter how stiff
the material. The two worlds are coupled two-ways: soft particles collide with every rigid
shape through the engine's existing `core+radius` collision math, and the reaction is fed back
into the rigid bodies, so a jelly can shove a crate and a crate can dent a hammock.

### Plan (this session) — all shipped

- [x] **Particle-vs-rigid collision** (`soft/collide.ts`) — treat a particle as a tiny disc and
      resolve it against circle / capsule / rounded-polygon with the same closest-feature analysis
      the narrowphase uses (a port of Box2D's polygon-circle, generalised to the skin radius).
      Verified against an analytic box face (normal & depth) in the suite.
- [x] **XPBD core** (`soft/softbody.ts`) — `Particle` (position-primary, derived velocity),
      compliant **distance**, **bending** and **area-preservation** constraints (the 2-D
      volume/pressure analogue, with the exact shoelace-area gradient), the four-phase substep, and
      momentum metrics (area, centroid, linear momentum, kinetic energy) used by the tests.
- [x] **The substep solver** (`soft/solver.ts`) — the "small-steps" scheme (Macklin 2019): N
      substeps × a short iterated position solve. Collisions live **in the position solve**
      (clamped depenetration interleaved with the constraints) so contact load propagates through
      the network to the anchors; momentum is then exchanged in a separate velocity pass. A uniform
      spatial hash resolves contacts *between* distinct soft bodies so jellies stack.
- [x] **Two-way rigid coupling** — a momentum-conserving normal+friction impulse at each
      particle–rigid contact, the reaction applied to the rigid body. Verified: a blob pushes a
      free crate down, a cloth hammock catches a falling ball, neither tunnels.
- [x] **Builders** — `makeBlob` (pressurised ring), `makeCloth` (pinnable membrane: top / corners /
      sides), `makeRope` (chain), `makeSoftBox` (lattice solid with per-cell area preservation).
- [x] **Renderer** — smooth filled blobs with a jelly highlight, filled cloth/solid meshes, thick
      round-capped ropes, pinned-anchor dots.
- [x] **Six scenes** (a new "Soft" category): Jelly Pit, Hammock, Jello Cubes, Trampoline, Water
      Balloons, Rope Swings — and **soft-body grabbing** in the playground (click a blob to pin a
      particle to the cursor; release to fling it).
- [x] **Verification** — 14 new checks (suite 109 → **123**, all green): the collision primitive vs
      an analytic face; free-blob **momentum conservation** (|Δp| ≈ 1e-11); area preservation on the
      ground; pressure-driven inflation; a pinned rope hanging vertically; two-way coupling (the
      crate reacts, never tunnels); a hammock catching a ball; and **bit-for-bit determinism**.

### The hard bug — and the fix that defines the architecture

The first cut put collision depenetration *after* the velocity-derivation phase. That looked
fine on a blob resting on the ground but **exploded** the instant a heavy rigid ball pressed a
stiff cloth: a particle swallowed by the large ball was shoved ~0.5 m out, and on the next
substep the stiff distance constraints yanked it straight back — and because velocity is
*derived from position change*, that 0.5 m correction became a ~240 m/s spurious velocity that
launched the ball to y≈260. The fix is the architecture above: **collisions belong in the
position solve, never as a velocity bias.** Position corrections add no kinetic energy, so a
packed tank of jelly settles instead of buzzing — whereas the velocity-bias (Baumgarte) version
pinned a confined scene at a steady, unphysical ~5 500 J forever (a perpetual-motion machine).
Two honest limitations fell out and are documented: a rigid *polygon* can still sink through a
*free* (unpinned) particle bed if it badly outweighs it — point-based coupling has no pinned
anchors to carry the load there (so the load demos use pinned cloth, and the lattice solid is a
self-deforming drop); and a *pressurised* blob (rest-area > natural) is a driven system that
keeps feeding energy when confined, so the scenes ship incompressible (pressure = 1, which is
what water actually is). Every scene now settles to KE ≈ 0; all six smoke-tested 1 000 steps.

## v4 — the mechanisms release (surfaces, force fields & the full joint family) ✅ shipped

The fourth major upgrade rounds the engine out into a *machine-builder's* toolkit.
It completes the Box2D joint family (pulley, gear, motor), adds the first
**contact-level material** (conveyor surface velocity, solved inside the friction
constraint), the first **field force** (a radial impulse / explosion with
line-of-sight occlusion), and the long-wanted **breakable joints** — constraints
that measure their own reaction load each step and snap when overloaded, firing a
break event. As always every new code path earns verification checks that
re-derive its claim from an analytic reference (the suite grows 83 → 100+).

### Conveyor surfaces (a contact material)

- [x] Add `Body.tangentSpeed`: a surface velocity along the body's local +x axis.
- [x] In the contact solver, fold the relative surface velocity
      `(convA − convB)·t` into the friction target so friction drags contacting
      bodies up to belt speed (Box2D's `tangentSpeed`, generalised to combine
      both bodies symmetrically regardless of contact A/B labelling).
- [x] Renderer draws a chevron flow arrow along any body with a surface speed.
- [x] Verify: a crate on a level belt accelerates to (and holds) belt speed; a
      belt with zero speed leaves the friction solve unchanged (regression guard).

### Radial impulse / explosion field

- [x] `World.applyRadialImpulse(center, strength, radius, { falloff, occlusion })`:
      an outward impulse on every dynamic body within `radius`, scaled by a linear
      (or none) distance falloff, optionally **ray-occluded** by static geometry
      so a blast doesn't reach through walls. Returns the bodies it pushed.
- [x] Verify: a symmetric ring of bodies gets symmetric outward momentum summing
      to ~zero; impulse magnitude falls off with distance; a static wall shadows
      the body behind it (occlusion).

### The rest of the joint family

- [x] **PulleyJoint**: `lengthA + ratio·lengthB = constant` over two fixed ground
      anchors — pull one side down, the other rises. A custom renderer draws the
      rope over both pulleys. Verify the conserved combined length holds.
- [x] **GearJoint**: couples two joints (each revolute or prismatic) sharing a
      ground body so `coordinate1 + ratio·coordinate2 = const` — a faithful port
      of Box2D's gear constraint (gear trains and rack-and-pinion). Verify two
      meshed gears hold the commanded angular-velocity ratio.
- [x] **MotorJoint**: drives bodyB to a target linear + angular offset from bodyA
      with bounded force/torque and a correction factor — an *overpowerable*
      moving platform (push back hard enough and it stalls). Verify it reaches its
      target offset, and that a too-heavy load stalls a force-limited motor.

### Breakable joints

- [x] Every structural joint reports its `reactionForce(invDt)` / `reactionTorque`;
      give the `Joint` interface optional `breakForce` / `breakTorque` budgets.
- [x] The world checks each joint's reaction against its budget after the velocity
      solve and removes it (firing `onJointBreak`) when exceeded.
- [x] Verify: a distance rod holding a light mass survives but snaps under a heavy
      one near the force its budget predicts; a torque-limited weld breaks.

### Scenes

- [x] **Pulley** — two platforms over a pulley; drop a weight on one, the other
      lifts.
- [x] **Gear Train** — a row of meshed gears (alternating ratios) driven by a
      motorised first gear, plus a rack-and-pinion sliding a carriage.
- [x] **Conveyor** — a circuit of belts at different speeds ferrying crates around.
- [x] **Demolition** — a brick tower wired to a timed charge: the radial impulse
      blows it apart (with wall occlusion shown).
- [x] **Breakable Bridge** — a plank bridge on breakable revolute pins that
      collapses as a heavy load rolls across.

## v3 — the fluids, queries & exact-solver release ✅ shipped

The next major upgrade. It deepens the solver (an exact 2-point LCP block solver),
adds a whole new force subsystem (**buoyancy & fluid drag** with closed-form
submerged-area integration), grows the engine's query surface (**AABB region
queries** and a **convex shape-cast**), introduces a new constraint type (a
Box2D-style **wheel joint** with suspension spring + drive motor → a drivable
car), and adds **sensors with contact begin/end events**. Every new code path
gets verification checks that re-derive its claim from an analytic reference, so
the engine stays inspectable, not just asserted.

### The exact contact solver (block LCP)

- [x] Add an exact **two-point block solver**: build the 2×2 coupling matrix `K`
      per manifold and solve the normal impulses as a true LCP (Box2D-Lite's
      four-case analysis) instead of point-by-point Gauss–Seidel. Keeps friction
      sequential; falls back to the per-point solve for 1-point manifolds.
- [x] Expose the LCP solve as a pure function and verify it satisfies the
      complementarity conditions (x ≥ 0, w = Kx + b ≥ 0, xᵀw = 0) on random SPD
      systems, and that a heavy plank on two supports rests flat with both
      contacts loaded.
- [x] A `blockSolver` config flag + a UI toggle so you can A/B it live.

### Buoyancy & fluid drag (a new force subsystem)

- [x] A `BuoyancyZone` (a body of water: surface height, x-extent, fluid density,
      linear & angular drag, optional current velocity).
- [x] Closed-form **submerged area + centroid** for any shape under the water's
      half-plane, via a uniform polygon-clip (Sutherland–Hodgman) of a world
      approximation of the shape (circle → n-gon, capsule → stadium, polygon →
      hull) against the surface line.
- [x] Per-step force application: Archimedes buoyancy = ρ_fluid · A_submerged · (−g)
      applied at the submerged centroid (so it produces a self-righting torque),
      plus area-scaled linear & angular drag — added straight to the force
      accumulators so settled floaters can still sleep.
- [x] Verify: half-density box floats with its centre exactly on the surface; the
      submerged area matches the analytic rectangle/segment; a dense block sinks;
      a tilted box rights itself.
- [x] Renderer draws the pool (animated wavy surface + translucent fill); a new
      **Buoyancy** scene (mixed-density boxes, a cork, a sinking ingot, a floating
      boat hull and capsules bobbing in a wave).

### Spatial queries

- [x] `World.queryAABB(box)` — every body overlapping a world-space region.
- [x] `World.shapeCast(shape, xf, translation)` — sweep a convex shape through the
      world (conservative advancement on GJK distance) and return the first body
      hit with point, normal and fraction. Verified against the analytic circle-
      vs-wall fraction.

### Wheel joint & a drivable car

- [x] A `WheelJoint`: a hard perpendicular line constraint + a soft suspension
      spring along the axis + an angular drive motor (Box2D's formulation).
- [x] A **Car** scene — chassis on two sprung, motorised wheels driving over
      bumpy terrain — and a verification that the suspension holds the car
      assembled and the motor drives it forward.

### Sensors & contact events

- [x] An `isSensor` body flag: sensor contacts are detected and reported but never
      solved (no impulse), so you can build trigger zones.
- [x] `World` begin/end contact events; a **Sensor Field** scene that counts and
      tints every body passing through a trigger gate, verified by a headless
      begin/end-event count.

## v2 — the swept-collision & advanced-shapes release ✅ shipped

A major upgrade that closes the three deepest backlog items at once — capsules &
rounded polygons, continuous collision detection, and joint limits — by
generalising the narrowphase around a *core + skin radius* model and adding a
time-of-impact solver. Every new code path got verification checks so the
engine stays inspectable, not just claimed. (Suite grew 31 → 49 checks.)

### Shapes — a unified core+radius model

- [x] Add a `Capsule` shape (a segment `p1→p2` swept by a radius — a stadium).
- [x] Give `Polygon` an optional skin `radius` so any polygon can be *rounded*
      (a `Polygon.rounded(hx, hy, r)` box factory + `fromVertices(pts, radius)`).
- [x] Closed-form capsule mass/centroid/inertia (rectangle + two end-caps), with
      a degenerate-length check that it collapses to the disc formula.
- [x] Capsule AABB, GJK *core* support (radius-free), bounding radius.
- [x] A `core`-vs-`full` flag through `shapeSupport`/`gjkDistance` so the
      narrowphase measures cores while the distance inspector measures full skins.

### Narrowphase — one radius-aware manifold generator for every convex pair

- [x] Analytic circle–circle and **circle–capsule** (closest point on segment).
- [x] Extend polygon–circle for a polygon skin radius.
- [x] A single GJK-driven, radius-aware clip builder `collideConvex` that handles
      capsule–capsule, capsule–polygon and polygon–polygon (rounded or not):
      GJK gives the exact normal for shallow contacts, SAT for deep overlap, then
      reference/incident face clipping offset by the two radii yields stable
      1–2 point manifolds with warm-start ids.
- [x] Wire `Capsule` through the AABB, ray-cast and point-query paths.

### Continuous collision detection (CCD)

- [x] Per-body sweeps (`center0/angle0` → `center1/angle1`) and a
      `sweepTransform(t)` interpolation.
- [x] A conservative-advancement `timeOfImpact` solver built on GJK core distance
      with a rotation-aware approach-speed bound (guaranteed never to tunnel).
- [x] A `bullet` body flag + a world CCD pass that advances fast bodies to their
      earliest time-of-impact so thin/fast bodies stop at the wall instead of
      teleporting through it.

### Joint limits & stops

- [x] Revolute angle limits (lower/upper) with a clamped accumulated impulse,
      coexisting with the motor; track a reference angle.
- [x] Prismatic translation limits (lower/upper) along the slider axis.

### Playground, rendering & verification

- [x] Render capsules (stadium outline) and rounded polygons (offset stroke).
- [x] Spawn capsules & rounded boxes; a Continuous (CCD) solver toggle; an
      auto-firing CCD-vs-no-CCD bullet-test scene.
- [x] New scenes: a CCD bullet test, a capsule pile, a rounded-box stack, and a
      "Joint Limits" scene (motorised crane against an angle limit, a piston bouncing
      between travel stops, weighted limited-swing flaps).
- [x] Grow the verification suite: capsule mass vs disc limit, capsule/polygon
      manifold correctness, CCD no-tunnel, revolute & prismatic limit clamping.

## Session log

- 2026-06-21 (claude): Shipped **v6 — the fracture release** (`src/engine/fracture/`). Added a
  from-scratch convex half-plane clip + signed-area + point-in-convex (`clip.ts`), a power-free
  **Voronoi** partition that tiles a convex hull exactly (`voronoi.ts`, with three seed patterns
  incl. a glass-style radial scatter focused on the impact), and a momentum-conserving rigid
  **shard decomposition** (`fracture.ts`) — each shard inherits the parent's velocity field
  `v + ω×r`, so Σ mass, Σ linear momentum and Σ angular momentum (= I·ω) all return the parent's,
  verified to 1e-9. Wired auto-shatter into the world step (the sharpest contact beyond a body's
  toughness shatters it, ejecting shards ∝ the blow, with a generation cap bounding the cascade),
  an `onFracture` hook + decaying impact-spark renderer, a public `world.fracture(...)`, and a
  click-to-shatter **Shatter** pointer tool. Authored a new **Fracture** scene category — Glass
  Pane, Cannon & Wall, Shatter Tower, Crystal Gallery, Shatter Yard (**34 → 39 scenes**) — and
  grew the suite **123 → 146 checks** (all green: clip/Voronoi geometry, exact area partition,
  cell convexity, every seed in its own cell, fracture conservation of mass/area/linear & angular
  momentum, determinism, live impact shatter + generation cap). Fixed a Voronoi overlap bug
  (coincident radial seeds doubling ~1% of the area) and a CCD-freeze (a horizontal bullet parking
  at the time-of-impact surface without transferring an impulse — dropped `bullet` on the
  cannonball). Headless-smoke-tested every new scene for 1 400 steps (no NaN; peak ~3.4 ms/step
  with 102 rubble bodies). Lint + build + the exact CI gate green.
- 2026-06-20 (claude): Shipped **v5 — the soft-body release**, a from-scratch **XPBD**
  deformable subsystem two-way coupled to the rigid solver (`src/engine/soft/`). Particles with
  compliant distance/bend/area constraints, the "small-steps" substep scheme, a particle-vs-rigid
  collision primitive reusing the engine's `core+radius` math, inter-body contacts via a spatial
  hash, and builders for blobs, cloth, ropes and lattice solids. Added a smooth jelly/cloth/rope
  renderer, six "Soft" scenes, and click-to-grab soft dragging in the playground. The whole thing
  was developed against a headless harness (Node `--experimental-strip-types` + a tiny resolver
  loader) so every claim was measured before it shipped: momentum conserved to ~1e-11, area
  preserved, fully deterministic. Hit — and fixed — a violent instability where post-velocity
  depenetration against stiff constraints became a ~240 m/s pop (a ball launched to y≈260); the
  cure was to move all collisions *into* the position solve and keep the velocity pass bias-free,
  which also stopped a confined jelly tank from idling at an unphysical ~5 500 J forever. Grew the
  verification suite 109 → **123 checks** (all green), smoke-tested all six scenes for 1 000 steps
  (finite, every one settles to KE ≈ 0). Lint + tsc + build + the CI gate all green.
- 2026-06-13 (claude): Built the engine end-to-end. Implemented math/shapes/hull, GJK+EPA,
  SAT manifold clipping, dynamic AABB-tree broadphase, the sequential-impulse solver, and all
  five joints. Hit one bug — resting bodies wouldn't sleep — and traced it to two causes:
  Baumgarte velocity bias polluting real velocity (fixed by switching to split-impulse
  position correction) and the island wake pass resetting awake bodies' sleep timers (fixed to
  only wake sleeping members). Wrote 31 verification checks (all green) and 15 scenes; smoke-
  tested every scene for 900 steps (no NaN, 354-body stress test peaks ~14 ms/step). Built the
  React/Canvas playground with live controls and a verification modal. Lint + build green.
- 2026-06-14 (claude): Shipped **v2 — the swept-collision & advanced-shapes release**,
  closing the three deepest backlog items. Added a **Capsule** shape and a polygon skin
  **radius** under one *core + skin radius* model (closed-form capsule mass verified to
  collapse to the disc formula), then rebuilt the narrowphase around a single GJK-driven,
  radius-aware `collideConvex` that handles every capsule/polygon pair — using GJK for the
  exact shallow normal (the cap-to-cap case pure SAT silently gets wrong) and SAT for deep
  overlap, with reference/incident clipping offset by the skin radii. Added **continuous
  collision detection**: per-body sweeps + a conservative-advancement `timeOfImpact` solver
  with a rotation-aware closing bound, and a `bullet` flag + world CCD pass so a 900 m/s round
  stops at a 0.1 m wall instead of tunnelling (proven both ways in the suite). Added
  **revolute angle limits** and **prismatic travel limits** as speculative one-sided
  constraints that coexist with the motors. Wired capsules through AABB/ray-cast/point-query,
  taught the renderer to draw stadiums and rounded polygons, added capsule/rounded spawn kinds
  and a CCD toggle, and authored 4 new scenes (CCD Bullet Test, Capsule Pile, Rounded Stack,
  Joint Limits) for 19 total. Grew the verification suite 31 → 49 checks (all green) and
  smoke-tested all 19 scenes for 900 steps — no NaN, stress peaks ~11 ms/step. Validated the
  whole engine headless (esbuild bundle → node) before pushing. Lint + build green.
- 2026-06-15 (claude): Shipped **v3 — the fluids, queries & exact-solver release**, the
  biggest single upgrade yet: five new subsystems, each with analytic verification.
  (1) An exact **two-point block LCP solver** (Box2D-Lite's four-case analysis), lifted out as
  a pure `solveBlockLcp()` and verified to satisfy the LCP complementarity conditions
  (x ≥ 0, w = Kx + b ≥ 0, xᵀw = 0) over 4 000 random SPD systems, plus a plank-on-two-supports
  test that rests dead level. (2) A from-scratch **buoyancy & fluid-drag** subsystem: the
  submerged area + centre of buoyancy of any shape is integrated in closed form by clipping a
  world outline against the waterline (Sutherland–Hodgman), and Archimedes lift
  ρ_fluid·A·(−g) is applied there with area-scaled drag — verified that a ρ=0.5 box floats with
  its centre exactly on the surface, a dense ingot sinks, and a cork rides high; plus animated
  water rendering and a Buoyancy scene. (3) **Spatial queries**: `queryAABB` (checked against a
  brute-force scan) and a conservative-advancement convex **`shapeCast`** (checked against the
  analytic circle-vs-wall fraction of 0.85). (4) A **wheel joint** — hard line constraint +
  sprung suspension + drive motor — powering a self-driving **Car** scene over bumpy terrain
  (verified the suspension holds wheels on their line to <5 cm, the motor drives forward, the
  car stays upright). (5) **Sensors + begin/end contact events**: a `isSensor` flag whose
  contacts are detected & reported but never solved (or swept by CCD, or used to build
  islands), driving a **Sensor Field** scene that lights up bodies passing through trigger
  gates — verified a body passes through firing exactly one begin and one end event. Added a
  Block-solver UI toggle. Verification suite grown **49 → 83 checks** (all green); all 22
  scenes smoke-tested for 1 500–6 000 steps headless — no NaN, stress peaks ~20 ms/step. Tuned
  the car out of a wheelie-flip (heavier low chassis, gentler torque) using the headless
  scene harness. Lint + build green.
- 2026-06-19 (claude): Shipped **v4 — the mechanisms release**, rounding the engine out into a
  machine-builder's toolkit. Completed the Box2D **joint family**: a **pulley** (two ground
  anchors, length ratio; verified the combined length `lengthA + ratio·lengthB` holds to <2 cm
  while a heavier side descends and a lighter rises), a **gear joint** that couples two
  revolute/prismatic joints by a ratio (verified two meshed gears hold `ωA + 2·ωB = 0` and
  counter-rotate, and a motorised rack-and-pinion actually slides its carriage), and a **motor
  joint** that drives B's pose relative to A with a bounded force/torque (verified it reaches a
  target offset + angle, and that a force-limited motor *stalls* under a heavy load while a
  strong one holds it — an overpowerable actuator, not a weld). Added the first **contact-level
  material**, a conveyor `tangentSpeed` folded into the friction target (verified a crate
  reaches belt speed, a reversed belt carries it the other way, and a zero-speed belt is an
  exact regression no-op), and the first **field force**, `applyRadialImpulse` — an explosion
  with linear distance falloff and **static-geometry ray occlusion** (verified a symmetric ring
  gets net-zero momentum, the near/far impulse ratio matches `1 − d/r`, and a wall shadows the
  body behind it). Made the structural joints **breakable**: each reports its reaction
  force/torque and the world snaps it (firing `onJointBreak`) past a budget — verified a
  distance rod and a weld hold within budget and break above it. Subtle bug found & fixed via
  the headless harness: the gear joint's Baumgarte position term exploded every half-turn
  because a revolute's coordinate is the body's *wrapping* angle — dropped the position bias
  (the velocity coupling already holds the ratio exactly). Taught the renderer to draw pulley
  ropes over their wheels and conveyor flow-chevrons. Authored 6 new scenes (Pulley, Gear Train,
  Powered Platform, Conveyor with recirculation, Demolition with a blast-proof bunker, Breakable
  Bridge with a wrecking ball) for **28 total**; grew the suite **83 → 109 checks** (all green)
  and smoke-tested every new scene headless for 600 steps (no NaN; bridge sheds 15/17 pins as
  the ball crosses; the occluded barrel never moves). Lint + build + the exact CI gate green.
