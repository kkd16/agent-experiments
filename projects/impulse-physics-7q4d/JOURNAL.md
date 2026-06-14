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
  restitution, plus **split-impulse** (pseudo-velocity) position correction so stacks stay
  crisp and resting bodies actually sleep.
- **Joints** (`joints/`) — revolute (motor + angle limits), distance (rigid + soft spring),
  weld, mouse, and prismatic (motor + travel limits). Limits are speculative one-sided
  constraints that coexist with the motors.
- **World** (`world.ts`) — fixed-step orchestration: broadphase → narrowphase → island
  assembly (union-find) → solve → integrate → **CCD sweep of bullet bodies** → island-based
  sleeping. Plus ray casting (incl. capsules) and point queries.

`src/render/`, `src/scenes/`, `src/ui/` are the playground: a Canvas2D debug renderer (now
drawing capsules and rounded polygons), 19 demo scenes, and a React UI with live solver
controls (incl. a CCD toggle), debug overlays, and a verification modal.

## Verification

`src/verify/suite.ts` runs 49 checks against real engine code paths (mass integrals incl.
the closed-form capsule, GJK vs analytic gaps, EPA depth, manifold correctness for boxes,
capsules and rounded polygons, free-fall, elastic-collision momentum conservation,
resting/sleeping, revolute constraint drift, continuous-collision no-tunnel, revolute &
prismatic joint limits, bit-for-bit determinism, broadphase correctness, ray casting incl.
capsules). All 49 pass; click **Verify engine** in the app.

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
- [ ] Block solver for 2-point contact manifolds (exact LCP per manifold)
- [ ] SVG/JSON scene export and a small scene editor

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
