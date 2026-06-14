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
- [ ] Bidirectional path tracing / light tracing for hard caustics
- [ ] WebGPU compute backend behind the same scene API
- [ ] Image (bitmap) textures + tangent-space normal maps (needs UV plumbing)

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
