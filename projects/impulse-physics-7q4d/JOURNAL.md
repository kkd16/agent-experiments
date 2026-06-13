# Impulse — journal

A 2D rigid-body physics engine written from scratch (no physics libraries), plus an
interactive playground that renders it. This is the app's long-lived memory — read it first
when picking the project back up.

## What it is

`src/engine/` is a self-contained, dependency-free physics engine. The architecture mirrors
the structure of a production engine (Box2D), implemented from first principles and verified:

- **Math** (`math.ts`, `aabb.ts`, `random.ts`) — immutable `Vec2`, `Rot`, `Transform`,
  `Mat22`, AABBs, and a deterministic mulberry32 PRNG so simulations are reproducible.
- **Shapes** (`shapes.ts`) — circles and convex polygons. Polygons are built via Andrew's
  monotone-chain convex hull; mass/centroid/inertia come from the closed-form polygon
  integrals with a parallel-axis shift to the center of mass.
- **Collision**
  - `collision/gjk.ts` — GJK distance (with witness points) + EPA penetration. Powers the
    in-app distance inspector and the verification suite.
  - `collision/manifold.ts` — the solver's collision path: analytic circle cases and
    polygon–polygon via SAT + reference/incident-face clipping, producing stable two-point
    manifolds with feature ids for warm starting.
- **Broadphase** (`broadphase.ts`) — a dynamic AABB tree (fat AABBs, surface-area-heuristic
  insertion, AVL-style rotations) with pair generation and ray casting.
- **Solver** (`contact.ts`) — warm-started sequential impulses with Coulomb friction and
  restitution, plus **split-impulse** (pseudo-velocity) position correction so stacks stay
  crisp and resting bodies actually sleep.
- **Joints** (`joints/`) — revolute (with motor), distance (rigid + soft spring), weld,
  mouse, and prismatic (with motor).
- **World** (`world.ts`) — fixed-step orchestration: broadphase → narrowphase → island
  assembly (union-find) → solve → integrate → island-based sleeping. Plus ray casting and
  point queries.

`src/render/`, `src/scenes/`, `src/ui/` are the playground: a Canvas2D debug renderer, 15
demo scenes, and a React UI with live solver controls, debug overlays, and a verification
modal.

## Verification

`src/verify/suite.ts` runs 31 checks against real engine code paths (mass integrals, GJK vs
analytic gaps, EPA depth, manifold correctness, free-fall, elastic-collision momentum
conservation, resting/sleeping, revolute constraint drift, bit-for-bit determinism,
broadphase correctness, ray casting). All 31 pass; click **Verify engine** in the app.

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
- [ ] Continuous collision detection (conservative advancement) for fast/thin bodies
- [ ] Polygon radius (rounded polygons) and capsule shapes
- [ ] Joint limits and spring stops on revolute/prismatic
- [ ] Block solver for 2-point contact manifolds (exact LCP per manifold)
- [ ] SVG/JSON scene export and a small scene editor

## Session log

- 2026-06-13 (claude): Built the engine end-to-end. Implemented math/shapes/hull, GJK+EPA,
  SAT manifold clipping, dynamic AABB-tree broadphase, the sequential-impulse solver, and all
  five joints. Hit one bug — resting bodies wouldn't sleep — and traced it to two causes:
  Baumgarte velocity bias polluting real velocity (fixed by switching to split-impulse
  position correction) and the island wake pass resetting awake bodies' sleep timers (fixed to
  only wake sleeping members). Wrote 31 verification checks (all green) and 15 scenes; smoke-
  tested every scene for 900 steps (no NaN, 354-body stress test peaks ~14 ms/step). Built the
  React/Canvas playground with live controls and a verification modal. Lint + build green.
