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
  joints** → integrate → **CCD sweep of bullet bodies** → island-based sleeping. Plus ray casting,
  point queries, AABB region queries, a convex **`shapeCast`**, a **radial-impulse / explosion**
  field (`applyRadialImpulse`, with distance falloff + static-geometry occlusion), and **sensor**
  bodies (detected, never solved).

`src/render/`, `src/scenes/`, `src/ui/` are the playground: a Canvas2D debug renderer (drawing
capsules, rounded polygons, animated water, dashed sensors, pulley ropes and conveyor flow
arrows), 28 demo scenes, and a React UI
with live solver controls (incl. CCD and block-solver toggles), debug overlays, and a
verification modal.

## Verification

`src/verify/suite.ts` runs 109 checks against real engine code paths (mass integrals incl.
the closed-form capsule, GJK vs analytic gaps, EPA depth, manifold correctness for boxes,
capsules and rounded polygons, free-fall, elastic-collision momentum conservation,
resting/sleeping, revolute constraint drift, continuous-collision no-tunnel, revolute &
prismatic joint limits, the block-LCP complementarity conditions, buoyancy submerged-area &
floating-equilibrium integrals, AABB queries & shape-cast fractions, the wheel-joint
suspension, sensor pass-through & contact-event counts, **conveyor surface speed**, **radial-
impulse symmetry / falloff / occlusion**, **pulley length conservation**, **gear ratio &
rack-and-pinion travel**, **motor-joint targeting & stall**, **breakable-joint thresholds**,
bit-for-bit determinism, broadphase correctness, ray casting incl. capsules). All 109 pass;
click **Verify engine** in the app.

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
- [ ] SVG/JSON scene export and a small scene editor
- [ ] Self-collision *within* a soft body (intra-body particle contacts)
- [ ] Pressure (rest-area > natural) without the energy it currently feeds a confined body

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
