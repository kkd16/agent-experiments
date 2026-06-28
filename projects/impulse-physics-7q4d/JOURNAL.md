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
- **Finite elements** (`fem/`, v8) — the engine's first *continuum* solver, a fourth physics
  paradigm beside rigid, XPBD and SPH: **co-rotational linear FEM** on constant-strain
  triangles, stepped with an **implicit (backward-Euler)** integrator. Each step factors out
  every element's rigid rotation via a closed-form 2-D polar decomposition (so large rotations
  cost no spurious energy — the failure that breaks plain linear FEM) and solves one SPD system
  `M + hC + h²K′` with a matrix-free, Jacobi-preconditioned **conjugate gradient** that never
  assembles the global stiffness; pinned nodes are Dirichlet boundaries via a projected CG.
  Materials carry real Young's modulus / Poisson ratio / Rayleigh damping; the von-Mises stress
  field is recovered for a live heatmap; nodes couple two-ways to the rigid world through the same
  `collideParticle` bridge. Builders `makeFemBeam`, `makeFemBox`, `makeFemDisk`. The headline
  validation: a clamped cantilever **converges to the Euler–Bernoulli tip deflection** as the mesh
  refines. **As of v10 the same elements are elastoplastic**: enable `plastic` on the material and a
  corotational **J2 (von-Mises) plasticity** corrector (radial return + isotropic hardening +
  viscoplastic creep, with an isochoric deviatoric flow) relaxes over-yield stress into *permanent*
  plastic strain — so the body keeps its bent/forged shape instead of springing back — and optional
  **ductile damage** softens an over-strained element until it necks and tears. Plastic-strain and
  damage heatmaps (`FemRender.heatmap`) join the stress one. Off by default, so a plain `young`/`ν`
  material is exactly the old linear-elastic solid.
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
- **Material Point Method** (`mpm/`, v9) — the engine's **fifth physics paradigm** and second
  *continuum* solver, but a hybrid Eulerian–Lagrangian one: material lives on a particle cloud
  while a transient **background grid** is borrowed each step for forces and collisions, then
  discarded — so one solver runs materials that genuinely *flow, split and merge*, which the fixed
  FEM mesh cannot. This is **MLS-MPM** (Hu et al. 2018): a single quadratic-B-spline scatter/gather
  folds the stress into the affine **APIC** transfer (Jiang et al. 2015), which is
  *angular-momentum conserving by construction*. `mat2.ts` is a from-scratch dense 2×2 matrix +
  closed-form **2×2 SVD** (the linear-algebra kernel every constitutive model needs);
  `material.ts` carries four laws behind one interface — **fixed-corotated** elastic, **Stomakhin
  (2013) snow** (singular-value clamping + hardening), **Drucker–Prager sand** (Klár et al. 2016 —
  a Hencky-strain return-mapping onto a friction cone, so a pile settles at its angle of repose and
  carries no tension), and a weakly-compressible **fluid**; `mpm.ts` is the `MpmSystem` (reset →
  P2G → grid update with separating/frictional walls → G2P → two-way rigid coupling through the
  same `collideParticle` bridge the soft/SPH solvers use). Builders `fillBox`/`fillDisc`, a
  per-material point renderer, and a 🏖/❄/🟢/💧 paint tool.

`src/render/`, `src/scenes/`, `src/ui/` are the playground: a Canvas2D debug renderer (drawing
capsules, rounded polygons, animated water, dashed sensors, pulley ropes, conveyor flow
arrows, **fracture impact sparks**, a **speed-shaded SPH metaball fluid** and a **per-material MPM
point cloud**), 60 demo scenes, and a React UI with live solver controls (incl. CCD and
block-solver toggles), **Shatter**, **💧 water** &amp; **🏖 sand / ❄ snow / 🟢 jelly** pointer
tools, debug overlays, a live fluid + MPM telemetry HUD, and a verification modal.

## Verification

`src/verify/suite.ts` runs 202 checks against real engine code paths (mass integrals incl.
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
equalisation, two-way buoyancy (float vs sink) + a jet pushing a body, and fluid determinism),
and **finite-element elasticity** (co-rotational rotation invariance, the rest/translation
energy null space, the plane-stress patch test, cantilever convergence to Euler–Bernoulli beam
theory, the doubling-E-halves-deflection linearity, free-body momentum conservation, FEM
determinism, two-way coupling and a stable jelly drop), and the **Material Point Method** (the
closed-form 2×2 SVD reconstructing every matrix to 1e-15 with U,V proper rotations; the corotated
stress vanishing under a pure rotation; quadratic B-spline weights forming a partition of unity;
the MLS-MPM transfer conserving linear momentum and **APIC conserving angular momentum to 1e-14**;
the affine transfer round-tripping a rigid velocity field and reconstructing C = skew(ω);
bit-for-bit determinism; **Drucker–Prager sand settling at a finite angle of repose**; Stomakhin
snow compacting plastically; an elastic jelly staying bounded and coming to rest; and
**MPM↔rigid coupling conserving total momentum to 1e-14**). All 202 pass; click **Verify engine** in
the app.

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
- [x] **Finite-element elasticity — co-rotational FEM (v8)** — a fourth physics paradigm and the
      first true continuum solver: constant-strain triangles, implicit backward-Euler with a
      matrix-free Jacobi-preconditioned conjugate-gradient solve, closed-form 2-D polar
      decomposition for the co-rotational frame, real E/ν/Rayleigh materials, a von-Mises stress
      heatmap, two-way rigid coupling and pointer node-grabbing; 4 scenes and 16 new verification
      checks (incl. cantilever convergence to Euler–Bernoulli beam theory)
- [x] **Material Point Method — MLS-MPM (v9)** — a fifth physics paradigm and second continuum
      solver (Hu et al. 2018): a hybrid Eulerian–Lagrangian method on a particle cloud + transient
      background grid. A from-scratch closed-form **2×2 SVD**, four constitutive laws behind one
      interface (**fixed-corotated** elastic, **Stomakhin snow**, **Drucker–Prager sand**,
      weakly-compressible **fluid**), the angular-momentum-conserving **APIC** transfer, two-way
      rigid coupling through `collideParticle`, a per-material point renderer, a 🏖/❄/🟢/💧 paint
      tool, 10 scenes (a new MPM category) and 20 new verification checks (incl. APIC angular-momentum
      conservation to 1e-14 and a Drucker–Prager angle of repose)
- [ ] **MPM plasticity dial-up**: a volume-correction / cohesion term so the realised sand angle of
      repose tracks the friction angle φ more tightly (it currently settles a touch below)
- [ ] **MPM↔FEM / MPM↔soft** coupling, and MPM particles colliding with the SPH fluid
- [ ] A **multigrid or APIC-PolyPIC** higher-order transfer, and CFL-adaptive MPM substepping
- [ ] Run the MPM grid sweep off the main thread / typed-array SoA particles for 50k+ points
- [ ] Self-collision *within* a FEM body (node-vs-node contacts) and FEM↔FEM / FEM↔soft collision
- [x] **FEM elastoplasticity (v10)** — corotational **J2 (von-Mises) plasticity**: a per-element
      radial-return corrector relaxes over-yield stress into permanent plastic strain, with
      **isotropic hardening**, a creep rate (rate-independent ↔ viscoplastic), an isochoric
      (area-preserving) deviatoric flow, a ductility cap, **ductile damage** that necks and tears,
      plastic-strain & damage heatmaps, 4 scenes (a new Plastic category) and 13 new verification
      checks (closed-form return, yield plateau, permanent set, hardening law, monotone damage)
- [ ] **Brittle FEM fracture** — split elements along the maximum-principal-stress direction (the
      other half of the old "FEM plasticity *and* fracture" item; plasticity is now done)
- [ ] **Consistent plane-stress J2 return** — the current yield/flow live in deviatoric-strain
      space (the standard real-time model, exact for in-plane deviatoric loading); a full
      plane-stress return map would also yield under in-plane *hydrostatic* stress (σ_zz coupling)
- [ ] **Plastic-strain–driven Voronoi seeding** — bias brittle fracture toward the most-damaged
      elements so a ductile tear and a brittle crack can coexist on one body
- [ ] **Live plasticity controls** — expose yield stress / hardening / damage in the ControlPanel so
      a running FEM scene can be re-annealed and re-loaded without an edit-rebuild
- [ ] A larger-deformation **Neo-Hookean / St-Venant–Kirchhoff** energy (the corotational model is
      linear-strain per element; a true hyperelastic energy removes the small-strain assumption)
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

## v10 — the elastoplasticity release (corotational J2 plasticity + ductile damage) ✅ shipped

The tenth upgrade grows the **finite-element solver up from linear-elastic to a full elastoplastic
continuum**. Until now every FEM body was a perfect spring: load it, it deforms; unload it, it
returns *exactly* to its rest shape. Real materials don't — bend a paperclip and it stays bent.
v10 adds that permanence: a from-scratch **corotational additive J2 (von-Mises) plasticity** model,
**isotropic hardening**, and **ductile damage** that lets an overloaded body neck and tear. It is a
small, surgical change to the solver's force assembly (no new paradigm, no new integrator) but it
turns the continuum solver from "elastic jelly" into "metal, clay and foam", and — crucially — it is
**proven correct from the inside** with closed-form unit tests run against the real engine.

### The model (why it slots cleanly into the existing solver)

The existing element already computes the corotational small-strain displacement `u = Rᵀx − X` and
the linear stiffness `Ke = area·Bᵀ·D·B`. Plasticity is the textbook **additive split**
`ε = ε_e + ε_p`: stress comes only from the *elastic* part `ε_e = ε − ε_p`, so the internal force
gains a single **plastic pre-stress** term,

```
f_local = −Ke·u + area·Bᵀ·D·ε_p          (elastic restoring force + plastic offset)
```

— i.e. the element's stress-free configuration *shifts* to the permanently-strained shape. The 6×3
matrix `btd = area·Bᵀ·D` is precomputed once alongside `Ke` (and satisfies `Ke = btd·B`, a nice
internal consistency check). Because `ε_p = 0` by default, **a non-plastic body is bit-for-bit the
old elastic solid** — the back-compat test confirms zero plastic strain after stepping.

Each step, after the polar-decomposition frames refresh and **before** the force assembly, a
**plastic corrector** runs the **radial return**:

1. elastic trial strain `ε_e = ε − ε_p`, take its deviator (tensor, engineering shear γ = 2ε_xy);
2. equivalent stress `σ̄ = 2√2·μ·‖dev ε_e‖` with `μ = E/(2(1+ν))` — calibrated so a uniaxial
   stress state yields exactly at `σ̄ = σ_Y`;
3. if `σ̄ > σ_Y + H·ε̄_p` (the hardened yield surface), relax the excess deviatoric strain into
   `ε_p` by the `creep` fraction (1 = instant return, < 1 = viscoplastic creep), accumulate the
   equivalent plastic strain `ε̄_p`, and cap `‖ε_p‖` at the ductility limit.

The tangent stiffness is held fixed across the implicit solve (semi-implicit / elastic-predictor),
so the existing matrix-free CG is untouched. Plastic flow is **deviatoric ⇒ traceless ⇒
area-preserving** — exactly how real metal plasticity is isochoric.

**Ductile damage** (continuum-damage mechanics) rides on `ε̄_p`: `d = clamp(ε̄_p / failStrain, 0, 1)`
softens an element's stiffness, force and read-out stress by `1 − (1−minStiffness)·d`, so plastic
strain localises into a **neck** that softens, draws in more strain, and finally **tears** — a
continuum failure, not a pre-scored crack.

### Plan (this session) — all shipped ✅

- [x] Extend `FemMaterial` with `plastic`, `yieldStress`, `hardening`, `creep`, `maxPlasticStrain`,
      `damage`, `failStrain`, `minStiffness` (all defaulted off → zero behavioural change)
- [x] Precompute the plastic-coupling matrix `btd = area·Bᵀ·D` per element; store `ε_p`, `ε̄_p`, `d`
- [x] Add the plastic pre-stress term + damage softening to `internalForce`, `applyStiffness`, and
      the stress read-outs (`_stress` now uses the *elastic* strain so a yielded region relaxes onto
      the von-Mises plateau)
- [x] Add the `updatePlasticity` radial-return corrector and call it once per `step`
- [x] Public accessors: `computePlasticStrain`, `computeDamage`, `peakPlasticStrain`, `hasYielded`,
      `plasticStrainOf`, `equivalentPlasticStrain`, `damageOf`, `equivalentStress`,
      `relaxPlasticity` (single-pass corrector for tests/annealing), `resetPlastic`
- [x] Renderer: `FemRender.heatmap` enum (`stress` / `plastic` / `damage`) with new colour ramps
- [x] Four scenes in a new **Plastic** category — **Bend & Set** (elastic vs plastic cantilever),
      **Plasticine** (dentable clay blobs), **Forge Press** (a scripted kinematic hammer that
      permanently forges a billet) and **Ductile Tear** (a clamped bar that necks and tears)
- [x] 13 new verification checks in a `Finite elements · plasticity` section

### Verified — all shipped ✅

Run against the **real engine** headlessly (Node type-stripping + a tiny `.ts` resolver hook), then
in the in-app suite (now **215 checks, 0 failures**):

- **Radial return matches its closed form** — a single CST element under uniaxial strain returns the
  exact `ε_p = ((n−n_Y)/n)·(e/2)` (agreement to 1e-9).
- **Perfect-plasticity plateau** — after the return the element sits *exactly* on the yield surface,
  `σ̄ = σ_Y` (to 1e-4).
- **Isochoric flow** — `ε_pₓ + ε_pᵧ = 0` to 1e-12 (plastic deformation preserves area).
- **Sub-yield stays elastic** — below σ_Y no plastic strain accumulates at all.
- **Hardening law** — ramping the strain lifts the residual stress to `σ_Y + H·ε̄_p` (within the
  one-step lag, ratio 0.977) and far above the base σ_Y.
- **Permanent set under full dynamics** — a plastic cantilever loaded then **unloaded** keeps a 4 m
  residual droop; the identical elastic beam springs back to 0.006 m; **work-hardening shrinks the
  set** (3.7 m vs 4.1 m).
- **Ductile damage** — an overloaded both-ends-clamped bar reaches `d = 1` (full tear), damage is
  **monotonic** (irreversible), the solve stays finite, and a lightly-loaded bar takes **zero**
  damage.
- **Back-compat** — with plasticity off, a stepped body accumulates exactly zero plastic strain.

### The design choice the headless harness pinned down

The yield/flow live in **deviatoric-strain space** (the standard real-time continuum-plasticity
model, à la O'Brien–Hodgins / Müller), not a full plane-stress return map. The harness made the
trade-off concrete: I calibrated `σ̄ = 2√2·μ·‖dev ε_e‖` so a *uniaxial stress* state yields at
`σ̄ = σ_Y` and confirmed the residual lands on the plateau to 1e-4 — but the same model treats an
in-plane *hydrostatic* state as non-yielding (no σ_zz coupling). That's a documented, deliberate
limitation (logged as a follow-up), and writing the closed-form test *first* is what forced the
constant `2√2·μ` to be exactly right instead of approximately right.

### Session log

- 2026-06-28 (claude / claude-opus-4-8): **v10 — corotational J2 plasticity + ductile damage.**
  Took the FEM solver from linear-elastic to a full **elastoplastic continuum**. Added an additive
  von-Mises plasticity corrector (radial return, isotropic hardening, viscoplastic creep, isochoric
  flow, ductility cap) as a plastic pre-stress term `+area·Bᵀ·D·ε_p` on the existing corotational
  internal force, plus **continuum-damage** softening that necks and tears an overloaded element.
  New plastic/damage heatmaps, four scenes in a new **Plastic** category (incl. a scripted
  kinematic **Forge Press**), and a 13-check `plasticity` verification section. Validated against the
  real engine headlessly with closed-form unit tests before any UI; the full suite is **215/215**.
  Plasticity is **off by default**, so every existing elastic scene and test is unchanged.

## v9 — the Material Point Method release (MLS-MPM, four materials, APIC) ✅ shipped

The ninth major upgrade adds a **fifth physics paradigm** and the engine's **second continuum
solver** — but where FEM discretises elasticity on a *fixed* triangle mesh, the **Material Point
Method** is mesh-free: the material is a cloud of **particles** carrying all state (mass, velocity,
the deformation gradient `F`), and a **background grid** is created fresh each step purely to
compute forces and resolve collisions, then thrown away. That is exactly what lets one solver run
materials that *flow, split and merge* — a poured sand pile, a splatting snowball, a wobbling jelly,
a sloshing liquid — which a connected FEM mesh fundamentally cannot represent.

**Why MLS-MPM + APIC (and not vanilla MPM/PIC).** Classic PIC transfers are catastrophically
dissipative (they average velocity onto the grid and lose all the fine motion); FLIP fixes the
dissipation but rings and goes unstable. **APIC** (Jiang et al. 2015) stores a per-particle affine
velocity matrix `C` so the particle↔grid transfer reproduces any *affine* field exactly and is
**angular-momentum conserving by construction** — the verifier confirms the grid's angular momentum
equals the particles' APIC angular momentum (orbital `Σm·x×v` **plus** the affine spin
`Σm·(dx²/4)(C₂₁−C₁₂)`) to 1e-14. **MLS-MPM** (Hu et al. 2018) then folds the constitutive stress
into that *same* affine transfer, so the whole step is one quadratic-B-spline scatter (P2G) and
gather (G2P) — no separate force grid, no APIC/stress bookkeeping split.

**Four materials, one transfer.** Everything but the constitutive law `P·Fᵀ` is shared:

- **fixed-corotated elastic** (jelly/rubber) — the rotation-aware energy `ψ = μ‖F−R‖² + ½λ(J−1)²`,
  so a tumbling block stores no phantom stress (the same defect co-rotational FEM fixes, here on a
  point cloud). The verifier checks the stress is exactly zero for a pure rotation.
- **Stomakhin (2013) snow** — fixed-corotated elasticity whose singular values are clamped to a
  brittle `[1−θc, 1+θs]` box (the removed stretch becomes *permanent* plastic compaction `Jp`) and
  whose moduli harden as `e^{ξ(1−Jp)}`, so snow packs into a dense crust and crumbles elsewhere.
- **Drucker–Prager sand** (Klár et al. 2016) — a Hencky (log-strain) elastic law with a
  **return-mapping onto a friction cone**: net stretch is projected to the cone tip (sand carries
  no tension) and excess shear is scaled back onto the cone (the plastic flow that lets a poured
  column collapse to a finite **angle of repose**). The verifier releases a column and measures a
  finite repose slope.
- **weakly-compressible fluid** — shear memory is discarded each step (`F ← √J·I`) leaving only an
  equation-of-state volume pressure `λJ(J−1)`, the MPM cousin of the project's SPH water.

**The linear-algebra kernel.** Every model is written in the SVD of `F`, so v9 ships a from-scratch
closed-form **2×2 SVD** (`mat2.ts`) that returns `U`,`V` as *proper rotations* with a signed second
singular value — reconstructing every matrix to ~1e-15 (verified over thousands of random matrices).
The first attempt used the textbook `E,F,G,H` phase formula and reconstructed `Aᵀ` for half the
inputs; the shipped version diagonalises `AᵀA` analytically, which is robust to singular and
reflected matrices alike.

**Two-way coupling for free.** MPM particles depenetrate from and exchange restitution+friction
impulses with every rigid body through the *exact same* `collideParticle` bridge the SPH and soft
solvers use — so a heavy boulder punches a crater into a sand bed and the ejecta rains back, and the
verifier confirms total (MPM + rigid) momentum is conserved to **1e-14** in a zero-gravity collision.

Shipped `src/engine/mpm/` (`mat2.ts`, `material.ts`, `mpm.ts`), wired the system into the world
step (after the SPH fluid), a per-material point renderer, a new **MPM** scene category with ten
scenes (Sand Pile, Hourglass, Snow Splat, Jelly Blocks, Impact Crater, Sand Dam Break, Material
Garden, Sinking Crates, Sand Seesaw, MPM Sandbox), 🏖/❄/🟢/💧 paint tools, and an MPM telemetry HUD
line. Grew the verification suite **182 → 202 checks** (all green). Whole thing developed against a
headless Vite-lib harness so every claim was measured before shipping — which also caught the stiff
`rubber` preset blowing past the explicit CFL limit at fine grids (cured by raising that scene's
substeps) and two over-dense sand beds (>6k points, ~220 ms/step) trimmed to a smooth 60 fps. Lint
+ tsc + build + the exact CI gate all green.

## v8 — the finite-element release (co-rotational FEM, implicit, two-way coupled) ✅ shipped

The eighth major upgrade adds a **fourth physics paradigm** and the engine's **first true continuum
solver**. Rigid bodies, XPBD soft bodies and SPH fluid are all *particle/constraint* methods; v8
discretises the actual elasticity PDE on a triangle mesh and solves it with the machinery real-time
FEM engines use: **co-rotational linear finite elements** advanced by an **implicit backward-Euler**
integrator. The pay-off is *physical fidelity you can check against a textbook* — a clamped beam
sags to the deflection **Euler–Bernoulli beam theory** predicts, materials are parameterised by real
**Young's modulus / Poisson ratio**, and the **von-Mises stress** field is recoverable and drawn as a
live heatmap that traces the load path.

**Why co-rotational + implicit (and not the obvious alternatives).** Plain *linear* FEM is fast but
catastrophically wrong under rotation: rotate an element rigidly and the small-strain energy reports a
huge phantom force (a spinning beam inflates). The **co-rotational** trick factors each element's rigid
rotation `R` out of the deformation gradient `F = Ds·Dm⁻¹` (a closed-form 2-D polar decomposition,
`θ = atan2(F₁₀−F₀₁, F₀₀+F₁₁)`) so the linear stiffness `Ke` only ever sees the genuinely small elastic
strain. And *explicit* integration of a stiff material needs a microscopic timestep to stay stable;
**implicit backward-Euler** is unconditionally stable at the engine's fixed 1/60 step. Treating `R` as
fixed within the step (stiffness warping) makes the implicit update a single **SPD** linear system

```
(M + h·C + h²·K′)·Δv = h·(f_int + f_ext − h·K′·v),   C = α·M + β·K′ (Rayleigh damping)
```

with the warped global stiffness `K′ = Σ Rₑ·Kₑ·Rₑᵀ`. It is never assembled densely — a **matrix-free,
Jacobi-preconditioned conjugate gradient** evaluates its action element-by-element (rotate by Rᵀ, apply
the 6×6 `Ke`, rotate back, scatter-add). Pinned nodes become **Dirichlet boundaries** via a projected
CG that zeros their DOFs each iteration.

### Plan (this session) — all shipped

1. **The FEM body** (`fem/fembody.ts`). `FemBody` stores node positions/velocities/masses as flat
   `Float64Array`s so the CG operates on plain length-2N vectors with zero per-node allocation. Per
   element it precomputes the **constant-strain-triangle (CST)** 6×6 stiffness `Ke = area·Bᵀ·D·B`
   (plane stress) and the rest edge-matrix inverse for `F`. The step: refresh rotations →
   assemble internal force + gravity → projected PCG solve → integrate → collide with the rigid world.
2. **Builders** (`fem/builders.ts`). `makeFemBeam` (structured rectangular mesh, union-jack diagonals
   so the discretisation has no directional bias, with a `pin` predicate), `makeFemBox`, and
   `makeFemDisk` (a clean radial mesh fanned from a centre node).
3. **The subsystem stepper** (`fem/solver.ts`) and wiring into `World` (`femBodies`, stepped right
   after the soft bodies against the freshly-integrated rigid poses — the same one-step co-simulation
   coupling, so FEM solids, soft bodies and fluid share a scene).
4. **Rendering** (`render/renderer.ts`). The deformed triangle mesh, either a flat translucent fill or
   a **von-Mises stress heatmap** (navy → teal → amber → red over the live peak stress), plus the
   wireframe and the pinned Dirichlet anchors. Stresses are computed in a single O(elements) pass.
5. **Interaction** (`ui/Simulation.tsx`). Grab the nearest FEM node with the pointer — it becomes a
   movable Dirichlet anchor and is released with the flick's momentum (the soft-grab pattern, for FEM).
6. **Scenes** — FEM Cantilever (two beams of different E, heatmap), FEM Load Bridge (pinned both ends,
   crates rain on the deck and the bending stress lights up), FEM Jelly (squishy elastic discs/blocks),
   and FEM Springboard (a diving board flexes and flings a heavy ball back). 46 → **50 scenes**.
7. **Verification** — a 16-check FEM section, growing the suite **166 → 182** (all green).

### Verified — all shipped ✅

- **Co-rotational rotation invariance** — a *large* (1.2 rad) rigid rotation of a beam stores strain
  energy ≈ 0 (to 1e-6). This is the property plain linear FEM gets catastrophically wrong; it's the
  whole reason for the polar-decomposition machinery.
- **Exact symmetries** — rest configuration has zero strain energy *and* zero internal force; a rigid
  translation stores zero energy (the stiffness' translational null space).
- **Plane-stress patch test** — a uniform uniaxial strain reproduces the analytic von-Mises stress
  `√(σₓ²−σₓσy+σy²)`, `σₓ = E/(1−ν²)·ε`, `σy = ν·σₓ`, to 1%.
- **Euler–Bernoulli beam theory** — a clamped cantilever sagging under self-weight converges to the
  textbook tip deflection `δ = ρ·H·g·L⁴/(8·E·I)` (`I = H³/12`) as the mesh refines: measured
  **0.52 → 0.79 → 0.94 → 0.97** of theory at nx=12/24/48/64 — the monotone-from-below convergence CST
  elements are known for. The suite asserts the coarse→fine convergence and that the refined mesh is
  within ~20%.
- **Linear elasticity** — doubling Young's modulus exactly halves the deflection (ratio 2.00).
- **Conservation & determinism** — a free elastic body conserves linear momentum (to 1e-6) through the
  implicit solve; identical setups evolve bit-for-bit identically.
- **Two-way coupling & stability** — a dense FEM disc pushes a free rigid box down without either
  tunnelling; a FEM jelly dropped on the floor stays finite, rests on the surface and stays ~volume
  preserving. All 50 scenes smoke-tested 700/200 steps headless — no NaN; FEM steps run ~1.4–3.2 ms.

### The subtlety the headless harness caught

The first cut of the "doubling E halves deflection" check compared the *theory-normalised* ratios
`δ/δ_theory` of the two runs — but since `δ_theory ∝ 1/E`, that ratio is **E-independent by
construction** (it came out 1.01, not 2). The fix: compare the *absolute* deflections. A good reminder
that a verification check is only as honest as the quantity it actually compares.

### Session log

- 2026-06-27 (claude): Shipped **v8 — the finite-element release**, a fourth physics paradigm and the
  first continuum solver. From-scratch **co-rotational linear FEM** (constant-strain triangles, plane
  stress) with an **implicit backward-Euler** step solved by a **matrix-free, Jacobi-preconditioned,
  projected conjugate gradient** over the warped stiffness `M + hC + h²K′` — closed-form 2-D polar
  decomposition for the per-element rotation, real Young's/Poisson/Rayleigh materials, a recovered
  **von-Mises stress heatmap**, two-way rigid coupling through `collideParticle`, and pointer
  node-grabbing. Builders `makeFemBeam/Box/Disk`; 4 scenes (Cantilever, Load Bridge, Jelly,
  Springboard) for **50 total**; suite **166 → 182** (all green). The headline: the cantilever
  converges to **Euler–Bernoulli** beam theory (0.52→0.79→0.94→0.97 of δ as the mesh refines).
  Optimised the CG hot path to zero allocations (reused length-6 scratch), so a 640-element beam steps
  in a few ms. All scenes smoke-tested headless (no NaN). Lint + build + the exact CI gate green.

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

- 2026-06-28 (claude): Shipped **v9 — the Material Point Method release** (`src/engine/mpm/`), a
  fifth physics paradigm and second continuum solver. Implemented a from-scratch closed-form **2×2
  SVD** (`mat2.ts`), four MLS-MPM constitutive models behind one interface (`material.ts` —
  fixed-corotated elastic, Stomakhin snow, Drucker–Prager sand, weakly-compressible fluid), and the
  `MpmSystem` (`mpm.ts`) — quadratic-B-spline **APIC** P2G/G2P, separating/frictional grid walls,
  and two-way rigid coupling through the engine's own `collideParticle`. Wired it into the world
  step, added a per-material point renderer, a new **MPM** scene category (10 scenes), 🏖/❄/🟢/💧
  paint tools and an MPM HUD line. Developed against a headless Vite-lib harness (plus a per-scene
  smoke test), which caught three real issues before they shipped: the first 2×2 SVD (textbook
  `E,F,G,H` phase formula) reconstructed
  `Aᵀ` for ~half the inputs — replaced with an analytic `AᵀA` diagonalisation that reconstructs to
  1e-15; and the APIC angular-momentum check failed by exactly the affine-spin term until I added
  `apicAngularMomentum` (the grid conserves orbital **plus** `Σm·(dx²/4)(C₂₁−C₁₂)`, matched to
  1e-14). Calibrated the Drucker–Prager sand to a stable ~21° angle of repose (explicit cohesionless
  DP-MPM characteristically settles a little below φ), and the per-scene smoke test then flagged the
  stiff `rubber` preset exploding past the CFL limit at dx=0.2 (cured by raising that scene's
  substeps 10→18) and two over-dense sand beds (>6k points, ~220 ms/step) trimmed to ≤43 ms (≈60 fps
  in the production build). Grew the suite **182 → 202 checks** (all 202 green, incl. APIC
  linear+angular momentum to 1e-14 and MPM↔rigid momentum conservation to 1e-14). Caught one lint
  failure (a zero-width space in a doc comment) and fixed it. Lint + tsc + build + the exact CI gate
  all green.
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
