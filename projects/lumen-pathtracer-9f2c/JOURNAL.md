# Lumen — journal

The app's long-lived memory. Read this first when you pick it back up.

**Lumen** is a from-scratch, physically based **Monte-Carlo path tracer** that runs entirely on
the CPU (no WebGL/WebGPU) across a Web Worker pool, rendering into a `<canvas>` with progressive
accumulation. It solves the rendering equation with next-event estimation + multiple importance
sampling, GGX microfacet BSDFs, smooth **and frosted** dielectrics, **spectral dispersion**,
**Beer–Lambert volumetric absorption**, **procedural textures**, **adaptive variance-guided
sampling** with a live noise heatmap, a SAH BVH, ACES tone mapping, and an edge-avoiding À-Trous
denoiser.

## Architecture

- `src/engine/vec3.ts` — vector algebra, ONB (Duff 2017), reflect/refract.
- `src/engine/rng.ts` — sfc32 RNG + splitmix32 seeding; cosine/disk/GGX samplers; power heuristic.
- `src/engine/ray.ts` — rays, AABB slab test, hit record.
- `src/engine/material.ts` — Lambert / GGX metal (VNDF sampling, Smith G2) / smooth + rough
  dielectric (exact Fresnel, microfacet refraction) / emissive; `sampleBSDF`/`evalBSDF`/`pdfBSDF`
  plus `resolveMaterial` (bakes textures + dispersion at a vertex).
- `src/engine/texture.ts` — procedural world-space textures (checker / grid / value-noise marble).
- `src/engine/spectrum.ts` — Cauchy dispersion IOR + white-point-normalised wavelength→RGB.
- `src/engine/primitive.ts` — sphere + triangle (Möller–Trumbore w/ barycentrics + smooth
  vertex normals), triangle area-light sampling, degenerate-thin AABB padding.
- `src/engine/mesh.ts` — indexed mesh generators (icosphere / uv-sphere / torus / surface of
  revolution), affine transforms (inverse-transpose normals), area-weighted normal recovery.
- `src/engine/obj.ts` — Wavefront OBJ parser (v/vn/f, polygon fans, auto-fit to a unit box).
- `src/engine/sky.ts` — Preetham analytic daylight (Perez distribution + zenith chromaticity).
- `src/engine/bvh.ts` — binned SAH build, stack traversal (nearest + any-hit).
- `src/engine/scene.ts` — scene assembly, intersection, NEE light sampler + MIS light pdf, env.
- `src/engine/integrator.ts` — the path tracer: NEE + MIS (power heuristic) + Russian roulette,
  Beer–Lambert medium tracking, and hero-wavelength spectral sampling.
- `src/engine/tonemap.ts` — ACES / filmic / Reinhard / linear + sRGB encode.
- `src/engine/denoise.ts` — À-Trous edge-avoiding wavelet filter, albedo/normal guided.
- `src/engine/scenes.ts` — Cornell box, Weekend daylight, Material gallery, Caustic room, Prism
  (dispersion), Glass Menagerie (roughness + absorption), Textured Studio (procedural textures).
- `src/engine/selftest.ts` — invariant checks (furnace, BVH-vs-brute-force, pdf consistency…).
- `src/render/worker.ts` — one render worker owning a horizontal band.
- `src/render/renderer.ts` — worker-pool orchestrator + single-thread fallback + compositing.
- `src/App.tsx` + `src/ui/` — the studio UI (orbit camera, controls, stats, verify, about).

## Ideas / backlog

- [x] Vec / RNG / sampling core
- [x] GGX VNDF microfacet metal + smooth dielectric + Fresnel
- [x] SAH BVH (build + nearest + shadow traversal)
- [x] Path tracer with NEE + MIS + Russian roulette
- [x] Multi-threaded worker pool + progressive accumulation
- [x] Single-thread sandbox fallback (for the catalog thumbnail)
- [x] ACES tone mapping + exposure + operators
- [x] À-Trous albedo/normal-guided denoiser
- [x] Orbit camera, depth of field, 4 preset scenes
- [x] In-app verification suite + PNG export
- [x] Procedural textures — world-space checker / grid / marble (value-noise fBm) albedo
- [x] Rough (microfacet) dielectric — GGX VNDF reflect/refract for frosted glass
- [x] Beer–Lambert volumetric absorption — physically coloured thick glass
- [x] Spectral rendering / dispersion through glass — hero-wavelength Cauchy IOR, prism rainbows
- [x] Adaptive sampling guided by per-pixel variance + live noise (relative-error) heatmap
- [x] Three new scenes: Prism, Glass Menagerie, Textured Studio
- [x] Eight new correctness proofs in the verification suite for the above
- [x] Triangle meshes with smooth (barycentric-interpolated) vertex normals
- [x] Procedural mesh library — icosphere, UV-sphere, torus, surface-of-revolution
- [x] OBJ import (paste-in) with area-weighted normal recovery + auto-fit
- [x] Physically based **Preetham sky** (turbidity + sun position)
- [x] **Environment / sun next-event estimation** — the sky is now a sampled light (MIS)
- [x] **Bidirectional path tracing (BDPT)** — full Veach/Guibas connections + balance-heuristic MIS
- [ ] WebGPU compute backend behind the same scene API
- [ ] Image (bitmap) textures + tangent-space normal maps (needs UV plumbing)
- [x] **Participating media** — bounded homogeneous volumes with Henyey–Greenstein
      scattering, distance sampling, in-scattering NEE + phase-function MIS (fog, smoke, god rays)
- [x] **Thin-film interference** — spectral Airy reflectance for iridescent coatings
      (soap-bubble / oil-slick / beetle-shell colour from interference, via the hero-wavelength path)
- [x] **Low-discrepancy (quasi-Monte-Carlo) primary sampling** — scrambled Halton
      sequence with Cranley–Patterson rotation for the camera sub-pixel + lens dimensions

## Roadmap — 2026-06-15 Lumen 5.0: bidirectional path tracing (claude)

Lumen 4.0 made the *space between* surfaces physical. 5.0 attacks the last and
hardest gap in the *transport algorithm itself*. So far Lumen has been a pure
**unidirectional** path tracer: it only ever grows paths from the camera and
finds light by next-event estimation. That estimator is provably correct but
becomes badly inefficient whenever the light that matters is *hard to reach from
the surfaces you can see* — light bounced off a wall (indirect-only rooms),
emitters tucked inside fixtures, glossy interreflection. **Bidirectional path
tracing (BDPT)** — the Veach–Guibas algorithm — fixes this by also growing a
path *from a light* and then **connecting** every camera-path vertex to every
light-path vertex, weighting all the resulting sampling techniques together with
**multiple importance sampling (balance heuristic)** so the best technique for
each light-transport regime dominates automatically.

The headline is that BDPT has a *built-in correctness oracle*: it is an unbiased
estimator of the **same** rendering equation as the existing path tracer, so the
two must converge to the **same image**. The verification suite exploits this
directly — it renders a box scene with both integrators at high sample counts
and asserts their means agree to within Monte-Carlo error. That is a far
stronger proof than any single invariant.

**Design decision (why it fits the architecture).** The render is a pool of
workers, each owning a *band* of the image and computing every pixel
independently. Full BDPT's `t = 1` "light-tracing" strategy splats a light-path
vertex onto an *arbitrary* pixel, which would need a shared full-frame buffer and
a new worker protocol. Instead Lumen implements **BDPT without light tracing**
(camera-subpath length `t ≥ 2`): every connection contributes to the *current*
pixel, so it drops into the existing band-worker model with **zero protocol
changes**. Marking the camera (lens) vertex as a delta endpoint removes the
`t = 1` technique from the MIS partition as well, keeping every remaining
technique's weights a valid partition of unity — so the estimator stays unbiased
and still matches the path tracer (the only paths lost are those reachable
*solely* by light tracing, e.g. a caustic seen directly, which neither this nor
plain NEE captures well anyway). It also sidesteps the error-prone
camera-importance `Wₑ` math entirely: the camera vertex's own densities provably
never enter the MIS sum for `t ≥ 2`, so the primary ray simply carries weight 1
exactly as the path tracer's does.

Plan / steps:

- [x] `bdpt.ts` — a self-contained bidirectional integrator behind the same
      `(scene, ray, settings, rng, stats, gbuf)` contract as `radiance`:
  - [x] a `Vertex` record (position, geometric + shading normals, throughput β,
        forward/reverse **area-measure** pdfs, delta flag, resolved material),
  - [x] `randomWalk` shared by both subpaths — converts each bounce's directional
        pdf to an area density at the next vertex and back-fills the previous
        vertex's reverse density (the bookkeeping the MIS recurrence needs),
  - [x] a camera subpath (eye vertex marked delta, primary β = 1) and a light
        subpath (emitter point + cosine-emission direction, β = Lₑ·cos/(p·p·p)),
  - [x] the geometry term `G` (both cosines, inverse-square, visibility) and the
        solid-angle→area density conversion,
  - [x] `connect(s,t)` for every strategy: `s=0` (camera path hits an emitter),
        `s=1` (connect to a freshly sampled light point ≡ NEE), and the general
        `s≥2` vertex-to-vertex connection, each through delta vertices correctly
        (skipped, never connected),
  - [x] `misWeight(s,t)` — a faithful port of the pbrt balance-heuristic
        recurrence with the four connection-time reverse-density overrides,
        restored after each connection.
- [x] Triangle-only light sampling for BDPT (`bdptSampleLight`) consistent with
      the light-subpath emitter selection, so `s=0/1/≥2` share one MIS partition;
      the environment is gathered on camera escape (weight 1, unbiased).
- [x] `integrate(...)` dispatcher in `integrator.ts`; `IntegratorSettings.integrator`
      (`'pt' | 'bdpt'`); worker + single-thread fallback both route through it.
- [x] UI — an **Integrator** segmented control (Path Tracer | Bidirectional) in
      the Sampling panel, threaded through `ControlState`, the render key, and
      `setSettings`; an About card explaining BDPT and the oracle.
- [x] New scene — **Cove** (an uplight bouncing off the ceiling; the room is lit
      almost entirely by indirect light — the textbook case where BDPT crushes
      the path tracer's variance), registered in `SCENES`.
- [x] Verification — four new proofs: BDPT white-furnace energy conservation;
      **BDPT mean == path-tracer mean** on a diffuse box (the oracle);
      MIS technique weights sum to 1 over a fixed path; solid-angle→area density
      conversion round-trip.

## Roadmap — 2026-06-15 Lumen 4.0: participating media, thin-film iridescence & QMC (claude)

Lumen 3.0 made the *geometry* and the *sky* physical. 4.0 makes the **space between
surfaces** physical and adds a **wave-optics** material — the two largest gaps left in a
"physically based" renderer that so far only transported light along vacuum segments and
modelled reflection as pure ray optics. Three headline additions, each wired through the
engine, the worker protocol (`SceneDef` is structured-clone-serialised, so every new field
is plain data), the verification suite, the scene registry, and the UI:

1. **Participating media** (`phase.ts`, `MediumDef`, integrator + scene) — bounded
   homogeneous volumes (fog, smoke, clouds, milky jade). The integrator samples a free-flight
   distance from the medium's transmittance; if a collision falls before the next surface the
   path *scatters* inside the volume: it next-event-estimates the lights through the
   **Henyey–Greenstein** phase function (with phase↔light MIS and media-attenuated shadow
   rays, so light shafts and volumetric shadows — "god rays" — emerge), then importance-samples
   a new direction from the same phase function. A scalar extinction with a coloured
   single-scattering albedo keeps the distance estimator unbiased with no spectral MIS, and the
   analytic boundary weights cancel so surfaces seen *through* a volume need no explicit
   transmittance multiply on the camera path. Shadow rays from ordinary surfaces are attenuated
   by the media too, so fog darkens the room, not just the volume.

2. **Thin-film interference** (`thinfilm.ts`, a new `Material` kind) — the iridescent colour of
   soap bubbles, oil on water, anodised titanium and beetle shells, which is *wave optics*, not a
   pigment: two reflections (off the top and bottom of a nm-thin film) interfere, and the path
   difference `δ = 4π n₁ d cosθ₁ / λ` makes the reflectance a function of wavelength. We evaluate
   the exact two-interface **Airy reflectance** per polarisation at the path's committed hero
   wavelength, so the existing spectral machinery turns per-λ reflectance into a full iridescent
   colour for free — a delta-specular coating that fans white light into interference colours the
   way the prism fans it into a rainbow.

3. **Low-discrepancy primary sampling** (`qmc.ts`) — the camera sub-pixel jitter and the lens
   (depth-of-field) disk now come from a **scrambled Halton** sequence with a per-pixel
   **Cranley–Patterson rotation** instead of white-noise `rng.next()`. Low-discrepancy points
   cover the pixel footprint far more evenly, so anti-aliasing and bokeh converge visibly faster
   for the same sample count, while every deeper bounce keeps its decorrelated pseudo-random
   stream (so global illumination is unbiased).

Plan / steps:

- [x] `phase.ts` — Henyey–Greenstein phase value + importance sampler (PBRT `wo`-convention),
      with normalisation, sampler↔pdf and mean-cosine proofs.
- [x] `MediumDef` on `SceneDef`; `Scene` builds the medium list and exposes
      `sampleMediumScatter` (nearest free-flight collision across bounded spheres) and
      `mediaTransmittance` (optical depth along a shadow segment).
- [x] Integrator: medium-scatter branch (albedo throughput, phase NEE + MIS, phase sampling),
      plus media-attenuated surface NEE. Surfaces seen through a volume keep weight 1 (analytic
      cancellation).
- [x] `thinfilm.ts` — two-interface Airy reflectance (s+p averaged); a `thinfilm` `Material`
      resolved to the hero wavelength; delta-specular BSDF; `isDelta`/`resolveMaterial` updated.
- [x] `qmc.ts` — radical-inverse Halton/Sobol + scramble + Cranley–Patterson; camera + worker
      wired to draw the primary 4 dimensions (pixel x/y, lens x/y) from it.
- [x] New scenes — **Cathedral** (god rays through haze), **Iridescence** (a thin-film thickness
      sweep), **Nebula** (a coloured scattering orb beside an iridescent sphere).
- [x] UI — a fog-density control for volumetric scenes; About cards for media, thin-film and QMC.
- [x] Verification — HG normalisation / sampler↔pdf / mean-cosine; homogeneous transmittance =
      e^(−σ_t·L); pure-scattering volume conserves energy (radiance = 1 in a unit field);
      absorbing volume = e^(−σ_t·chord); thin-film R∈[0,1], d→0 collapses to the bare-interface
      Fresnel, and R(blue)≠R(red) (iridescence); Halton L2-discrepancy below random.

## Roadmap — 2026-06-14 Lumen 3.0: meshes, sky & sun NEE (claude)

This pass turns Lumen from a sphere-and-flat-triangle tracer into a real geometry
+ daylight renderer. Each step is wired through the engine, the worker protocol, the
scene registry, the verification suite, and the UI so it is observable and proven:

1. **Smooth shading normals** — the triangle primitive carries optional per-vertex
   normals; `intersectTriangle` returns barycentrics; `Scene.intersect` blends them
   into a shading normal oriented to the geometric hemisphere (the geometric normal
   still drives ray-offsets and front-face). Curved surfaces from flat triangles.
2. **Mesh library** (`mesh.ts`) — indexed generators with exact/area-weighted
   normals (icosphere via recursive subdivision, UV-sphere, torus, surface-of-
   revolution) plus an affine transform (translate/scale/rotate; normals by the
   inverse-transpose) and a triangle-soup emitter into `PrimDef`s.
3. **OBJ importer** (`obj.ts`) — parses `v/vn/f` (triangulates polygon fans),
   recovers area-weighted normals when absent, and fits the mesh to a unit box so
   any pasted model drops straight into a scene.
4. **Preetham sky** (`sky.ts`) — the analytic all-weather daylight model (Perez
   distribution + zenith chromaticity from turbidity & sun elevation), xyY→linear
   RGB, plus a sun disc. A new `sky` environment kind.
5. **Environment light + sun NEE** — any environment with a sun (the daylight
   gradient or the Preetham sky) becomes a *sampled* light: NEE importance-samples
   the sun cone and MIS-weights it against BSDF sampling, and escaped rays are
   MIS-weighted back. Daylight scenes converge dramatically faster; full-sphere
   cone sampling reduces exactly to the white furnace (a new energy proof).
6. **Showcase scenes** — Sky Studio (meshes under the Preetham sky), Revolution
   (lathed goblets + torus), and a paste-your-own Custom OBJ stage.
7. **Verification** — new proofs: smooth-normal interpolation, icosphere normals +
   Euler characteristic, OBJ cube round-trip, torus normal sanity, sky radiance
   positivity/ordering, env-sun sampler↔pdf + cone solid angle, and an
   env-importance-sampled white furnace.
8. **UI / About** — interactive sun (azimuth/elevation/turbidity) for sky scenes,
   an OBJ paste box, and About cards for the new physics.

## Roadmap — 2026-06-14 substantial-improvement pass (claude)

The plan, broken into shippable steps. Each is wired through the engine, the
verification suite, the scene registry, and the UI so it is observable and proven:

1. `texture.ts` — serialisable procedural `Texture` (checker / grid / marble) evaluated
   in world space; diffuse + metal carry an optional `tex`. Resolved per-vertex so the
   BSDF math is untouched. Self-tests for pattern parity and range.
2. `spectrum.ts` — `cauchyIor(base, B, λ)` dispersion + `wavelengthToRGB` with a
   white-point normalisation so a flat spectrum reconstructs to neutral white. Self-tests
   for the white point and that blue refracts more than red.
3. Rough dielectric in `material.ts` — GGX-VNDF microfacet reflect/refract, stochastic
   Fresnel, height-correlated Smith throughput (frosted glass). Energy-bound self-test.
4. Beer–Lambert in `integrator.ts` — track the interior medium, attenuate β by
   exp(−σ·t) across glass; spectral hero-wavelength sampling lazily on the first
   dispersive interaction. Attenuation self-test.
5. `scenes.ts` — Prism (dispersion), Glass Menagerie (roughness + absorption sweeps),
   Textured Studio (checker floor + marble sphere).
6. Per-pixel variance: the renderer keeps Σx², derives a relative-error map, exposes a
   live **noise heatmap** display mode and a convergence read-out, and stops dispatching
   to bands that have converged below an adjustable threshold (adaptive early-out).
7. UI + About + verification copy updated to cover the new physics.

## Session log

- 2026-06-15 (claude/claude-opus-4-8): **Lumen 5.0 — bidirectional path tracing.** Added a second,
  selectable light-transport integrator alongside the unidirectional path tracer: a full
  **Veach–Guibas BDPT** (`bdpt.ts`). It grows a camera subpath and a light subpath, then forms every
  connection strategy — `s=0` (camera path hits an emitter), `s=1` (≡ next-event estimation) and the
  general `s≥2` vertex-to-vertex connection — and weights them all with a faithful port of pbrt's
  **balance-heuristic MIS recurrence** (per-vertex area-measure forward/reverse densities, the four
  connection-time reverse-density overrides, delta vertices transported but never connected). It is
  "BDPT without light tracing" (camera-subpath length `t≥2`): every connection lands in the current
  pixel, so it dropped into the band-worker render loop with **zero protocol changes**, and marking
  the lens vertex as a delta endpoint removes the `t=1` technique from the MIS partition (still a
  valid partition of unity, still unbiased, still matching the path tracer — and it sidesteps the
  camera-importance `Wₑ` math, which provably never enters the weight for `t≥2`). While wiring it up
  I also fixed a latent inconsistency in the unidirectional integrator: BSDF-hit **emission is now
  one-sided** (winding-front only), matching what the NEE light sampler already required, so the two
  estimators agree term for term. New **Cove** scene — an emitter hidden in an uplight cove so the
  room is lit almost entirely by bounced light, the textbook regime where BDPT crushes the path
  tracer's variance (measured ≈3× lower per-sample variance at equal settings). UI: an **Integrator**
  segmented control (Path Tracer | Bidirectional) + an About card. **Four new correctness proofs
  (33 total):** BDPT white-furnace energy (ρ recovered to 0.8000); the **oracle** — BDPT's mean image
  equals the path tracer's on a diffuse box (1.0% at 280 spp, shrinking as 1/√n); **MIS weights
  partition to 1** on a fixed path (residual = 0, exactly); and the solid-angle→area density
  conversion. Verified end to end in Node by bundling the engine with rolldown — all 33 self-tests
  pass and BDPT↔PT agree to <0.5% at 3000 spp on both the diffuse box and the full Cornell box (with
  mirror + glass), no NaNs; `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-14 (claude): Built Lumen end to end — full CPU path tracer (BVH, microfacet BSDFs,
  NEE+MIS, RR), worker pool with single-thread fallback, denoiser, tone mapping, 4 scenes, orbit
  camera/DoF, verification suite, and the React studio UI. Lints + builds clean via the CI gate.
- 2026-06-14 (claude): Substantial physics pass. Added (1) procedural world-space textures
  (`texture.ts`: checker / grid / value-noise marble), (2) rough microfacet dielectrics for frosted
  glass (GGX-VNDF reflect/refract), (3) Beer–Lambert volumetric absorption for physically coloured
  glass (medium tracking in the integrator), (4) spectral dispersion (`spectrum.ts`: Cauchy IOR +
  white-point-normalised wavelength→RGB, hero-wavelength sampling) producing prism rainbows, and
  (5) adaptive variance-guided sampling with a live per-pixel noise (relative-error) heatmap and a
  convergence read-out. Three new scenes (Prism, Glass Menagerie, Textured Studio) and six new
  correctness proofs (16 total) — all pass. Verified numerically in Node by bundling the engine with
  rolldown and running the self-tests + a 7-scene render smoke test (no NaNs); `pnpm lint`/`build`
  green via the CI gate.
- 2026-06-14 (claude/claude-opus-4-8): **Lumen 3.0 — meshes, sky & sun NEE.** Turned the
  sphere-and-flat-triangle tracer into a real geometry + daylight renderer. Added (1) **smooth
  triangle meshes**: the triangle primitive now carries per-vertex normals, `intersectTriangle`
  returns barycentrics, and `Scene.intersect` blends them into a shading normal oriented to the
  geometric hemisphere (geometric normal still drives offsets/front-face). (2) A **mesh library**
  (`mesh.ts`) — icosphere (recursive subdivision), uv-sphere, torus and surface-of-revolution with
  exact/area-weighted normals, an affine transform with inverse-transpose normal handling, and a
  smooth-tri emitter. (3) An **OBJ importer** (`obj.ts`) — v/vn/f with polygon-fan triangulation,
  area-weighted normal recovery, and auto-fit to a unit box. (4) The **Preetham analytic sky**
  (`sky.ts`) — Perez distribution + zenith chromaticity from turbidity & sun elevation, xyY→linear
  RGB, plus a solar disc; a new `sky` env. (5) **Environment / sun next-event estimation** — any
  env with a sun (the daylight gradient or the sky) is now a *sampled* light: NEE importance-samples
  the sun cone and MIS-weights it against BSDF sampling, with escaped rays MIS-weighted back, so
  daylight scenes converge in a handful of spp. (6) Three scenes — **Sky Studio**, **Revolution**
  (lathed goblets), **Custom OBJ** (paste your own). (7) **Fixed a latent BVH robustness bug**:
  axis-aligned planar faces (floor/wall quads, coplanar facets) had zero-thickness AABBs that the
  slab test rejected, so such a face only rendered when its BVH leaf happened to also hold a
  non-coplanar primitive — now degenerate-thin bounds are padded. (8) Seven new correctness proofs
  (23 total): smooth-normal interpolation, icosphere radial normals + Euler χ=2, OBJ cube
  round-trip, torus normals, Preetham positivity/ordering, env-sun sampler↔pdf + cone solid angle,
  and an env-importance-sampled white furnace (ρ recovered exactly). (9) UI: interactive sun
  (azimuth/elevation/turbidity) for sky scenes, an OBJ paste box, and new About cards. Verified
  numerically in Node by bundling the engine with Vite and running all 23 self-tests (23/23) + a
  10-scene render smoke test (no NaNs, all lit); `pnpm lint`/`build` green via the CI gate.
- 2026-06-15 (claude/claude-opus-4-8): **Lumen 4.0 — participating media, thin-film iridescence
  & quasi-Monte-Carlo sampling.** Made the *space between surfaces* and a *wave-optics* material
  physical. (1) **Participating media** (`phase.ts`, `MediumDef`, scene + integrator): bounded
  homogeneous volumes (fog/smoke/cloud). The integrator samples a free-flight distance from the
  medium's transmittance; a collision before the next surface makes the path scatter *inside* the
  volume — in-scattering NEE through the **Henyey–Greenstein** phase function (phase↔light MIS, with
  shadow rays attenuated by `mediaTransmittance` so volumetric shadows/god-rays form), then a
  phase-importance-sampled new direction. A scalar extinction with a coloured single-scattering
  albedo keeps the distance estimator unbiased (no spectral MIS) and the analytic boundary weights
  cancel, so surfaces *seen through* a volume need no transmittance multiply on the camera path.
  Surface NEE is media-attenuated too. (2) **Thin-film interference** (`thinfilm.ts`, a `thinfilm`
  `Material`): the iridescence of soap bubbles / oil / anodised metal as exact two-interface **Airy
  reflectance** (s+p averaged) at the path's committed hero wavelength — a delta-specular coating
  whose reflectance is wavelength-dependent, so the existing dispersion machinery turns it into a
  full iridescent colour (`isSpectral` now drives the wavelength commit for both dispersive glass
  and films). (3) **Low-discrepancy primary sampling** (`qmc.ts`): the camera sub-pixel jitter and
  the depth-of-field lens are now drawn from a **scrambled Halton** sequence with a per-pixel
  Cranley–Patterson rotation (deeper bounces keep their RNG stream), so AA and bokeh converge
  faster. Three new scenes — **Cathedral** (banded god-rays through forward-scattering haze),
  **Iridescence** (a thin-film thickness sweep — soap-bubble to beetle-shell colour), **Nebula** (a
  coloured single-scattering orb beside an iridescent sphere). UI: a live fog-density control for
  volumetric scenes + three new About cards. **Six new correctness proofs (29 total):** HG phase
  normalisation/sampler↔pdf/mean-cosine (E[cosθ]=−g), homogeneous transmittance = e^(−σ_t·L), a
  pure-scattering volume conserving energy (radiance = 1 in a unit field), an absorbing volume =
  e^(−σ_t·chord), thin-film R∈[0,1] with the d→0 limit collapsing to the bare-interface Fresnel
  (err 5.6e-17) and R(λ) iridescent, and Halton L2 star-discrepancy 4× below random. Verified in
  Node (29/29 self-tests + a 13-scene render smoke test: no NaNs, all lit); `pnpm lint`/`tsc`/`build`
  green via the CI gate.
