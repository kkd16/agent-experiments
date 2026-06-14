# Lumen — journal

The app's long-lived memory. Read this first when you pick it back up.

**Lumen** is a from-scratch, physically based **Monte-Carlo path tracer** that runs entirely on
the CPU (no WebGL/WebGPU) across a Web Worker pool, rendering into a `<canvas>` with progressive
accumulation. It solves the rendering equation with next-event estimation + multiple importance
sampling, GGX microfacet BSDFs, smooth dielectrics, a SAH BVH, ACES tone mapping, and an
edge-avoiding À-Trous denoiser.

## Architecture

- `src/engine/vec3.ts` — vector algebra, ONB (Duff 2017), reflect/refract.
- `src/engine/rng.ts` — sfc32 RNG + splitmix32 seeding; cosine/disk/GGX samplers; power heuristic.
- `src/engine/ray.ts` — rays, AABB slab test, hit record.
- `src/engine/material.ts` — Lambert / GGX metal (VNDF sampling, Smith G2) / smooth dielectric
  (exact Fresnel) / emissive; `sampleBSDF`/`evalBSDF`/`pdfBSDF`.
- `src/engine/primitive.ts` — sphere + triangle (Möller–Trumbore), triangle area-light sampling.
- `src/engine/bvh.ts` — binned SAH build, stack traversal (nearest + any-hit).
- `src/engine/scene.ts` — scene assembly, intersection, NEE light sampler + MIS light pdf, env.
- `src/engine/integrator.ts` — the path tracer: NEE + MIS (power heuristic) + Russian roulette.
- `src/engine/tonemap.ts` — ACES / filmic / Reinhard / linear + sRGB encode.
- `src/engine/denoise.ts` — À-Trous edge-avoiding wavelet filter, albedo/normal guided.
- `src/engine/scenes.ts` — Cornell box, Weekend daylight, Material gallery, Caustic room.
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
- [ ] Textures / normal maps / procedural checker material
- [ ] Triangle meshes via OBJ import; smooth (interpolated) normals
- [ ] Rough (microfacet) dielectric + Beer–Lambert volumetric absorption
- [ ] Bidirectional path tracing / light tracing for hard caustics
- [ ] Adaptive sampling guided by per-pixel variance
- [ ] Spectral rendering / dispersion through glass
- [ ] WebGPU compute backend behind the same scene API

## Session log

- 2026-06-14 (claude): Built Lumen end to end — full CPU path tracer (BVH, microfacet BSDFs,
  NEE+MIS, RR), worker pool with single-thread fallback, denoiser, tone mapping, 4 scenes, orbit
  camera/DoF, verification suite, and the React studio UI. Lints + builds clean via the CI gate.
