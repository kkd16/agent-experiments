# Scanline — a software 3D renderer — journal

A from-scratch real-time **software 3D renderer** written in pure TypeScript. No WebGL, no
GPU, no canvas 3D context — every triangle is transformed, clipped, rasterized and shaded by
hand into a `Uint32` framebuffer that is blitted to a 2D canvas via `putImageData`. This is a
software re-implementation of the classic GPU graphics pipeline: vertex transform → homogeneous
clipping → perspective divide → viewport map → perspective-correct triangle rasterization →
per-fragment lighting, texturing and a depth buffer.

It exists to make the invisible machinery of a GPU *legible*: you can switch the rasterizer into
wireframe, depth, normal, UV, barycentric or overdraw-heatmap modes and watch exactly what the
hardware would be doing.

## Architecture

```
src/
  math/        vec2/3/4, mat4 (lookAt, perspective, ortho, normal matrix), scalar helpers
  geometry/
    mesh.ts          Mesh type + parametric generators + Lengyel tangent solver
    obj.ts           Wavefront OBJ importer (auto-normals, auto-fit) + sample model
  render/
    framebuffer.ts   color (Uint32 ABGR) + depth (Float32) + HDR (Float32×3) buffers
    clip.ts          Sutherland–Hodgman near-plane clip in homogeneous clip space
    raster.ts        edge-function scan conversion, perspective-correct interp, TBN, HDR out
    texture.ts       procedural albedo textures + procedural tangent-space normal maps
    shading.ts       model dispatch: Blinn–Phong + shared fog; PBR lives in pbr.ts
    pbr.ts           Cook–Torrance metallic-roughness BRDF + image-based-lighting ambient
    environment.ts   analytic HDR sky → skybox + diffuse irradiance + specular probe
    shadow.ts        orthographic depth pass from the key light + PCF sampler
    post.ts          HDR resolve: exposure, tone mapping, bloom, FXAA, vignette
    pipeline.ts      per-object vertex stage → clip → rasterize / wireframe
  raytrace/          the ground-truth twin (engine = 'rt')
    intersect.ts     Möller–Trumbore ray/triangle + branchless ray/AABB slab
    bvh.ts           binned-SAH bounding volume hierarchy + closest/any-hit traversal
    rtscene.ts       live scene → world-space triangle soup + material/area-light tables
    sampling.ts      RNG + cosine/GGX/cone/sphere importance sampling + Fresnel
    tracer.ts        microfacet path tracer (NEE + GI) and an ambient-occlusion estimator
    raytracer.ts     progressive accumulation, jittered-ray AA, shared HDR resolve
    verify.ts        in-app numerical self-test (incl. the furnace energy test)
  scene/
    camera.ts        orbit camera (yaw/pitch/distance) → view + projection
    scene.ts         scene description: objects, lights, materials, sky, presets
  engine/
    renderer.ts      stateful renderer: owns buffers, builds the env, runs a frame
    useEngine.ts     React hook: rAF loop, resize, input, OBJ load, PNG capture
  ui/            React control panel components
  App.tsx        layout: canvas + controls + stats HUD
```

## Render modes (debug views into the pipeline)

- **shaded** — full HDR beauty pass: Blinn–Phong *or* Cook–Torrance PBR, image-based
  lighting, normal maps, shadows, fog, then bloom + tone mapping + FXAA + vignette
- **albedo** — unlit base/texture colour
- **wireframe** — triangle edges only (Bresenham)
- **depth** — linearised depth as greyscale
- **normals** — world-space normals mapped to RGB
- **uv** — texture coordinates as colour
- **overdraw** — heatmap of how many triangles touched each pixel
- **clip** — highlights triangles that were near-plane clipped

## Ideas / backlog

### v3 — the ray-traced reference path: a from-scratch software path tracer (planned 2026-06-19)

A third major pass that gives the rasterizer a **ground-truth twin**. The same scene,
meshes, materials, lights and analytic environment are fed to a from-scratch CPU **ray
tracer / path tracer** so you can flip — or split the screen — between the real-time
raster approximation (shadow map, IBL probe, screen-space AA) and a physically-correct
reference image (true ray-traced shadows, mirror reflections, ambient occlusion and full
global illumination with colour bleeding). This is exactly the hybrid raster+RT split that
modern GPUs do, written by hand into the same `Uint32` framebuffer — no WebGL, no GPU.

New steps:

- [x] **Möller–Trumbore ray–triangle intersection** (`raytrace/intersect.ts`) returning the
      hit distance + barycentric coordinates, plus a branchless ray–AABB slab test.
- [x] **A binned-SAH bounding volume hierarchy** (`raytrace/bvh.ts`) — surface-area-heuristic
      split over 12 bins per axis, an iterative traversal stack for the closest hit and a
      cheap any-hit `occluded()` for shadow rays. O(log n) instead of O(n) per ray.
- [x] **World-space triangle soup builder** (`raytrace/rtscene.ts`) — flattens the live
      animated scene (every mesh × its model matrix) into cache-friendly typed arrays with
      per-vertex normals/uv/tangent and a material table, so the tracer sees exactly what the
      rasterizer drew.
- [x] **Monte-Carlo sampling kit** (`raytrace/sampling.ts`) — a per-pixel xorshift RNG seeded
      by a hash, cosine-weighted hemisphere sampling, GGX/​VNDF microfacet importance sampling,
      a branchless orthonormal basis (Duff et al.) and Fresnel–Schlick.
- [x] **A microfacet path tracer** (`raytrace/tracer.ts`) consistent with `pbr.ts`: a
      metallic-roughness BSDF (Lambert diffuse + GGX specular), **next-event estimation** to
      punctual *and* emissive-area lights with multiple-bounce indirect light, Russian-roulette
      termination, and the analytic sky as an infinite emitter — so diffuse colour bleeds
      between surfaces.
- [x] **A Whitted/direct mode and a pure ambient-occlusion mode** sharing the same BVH — fast,
      low-noise reference shadows + recursive mirror reflections, and a hemisphere-AO render.
- [x] **Soft shadows** — cone-sampled directional lights and radius-sampled point lights give
      real penumbrae the shadow map can't.
- [x] **Progressive accumulation** (`raytrace/raytracer.ts`) — a Float32 sample-accumulation
      buffer refined a slice per frame while the camera is still, tone-mapped through the same
      HDR resolve (exposure / ACES / bloom / vignette); it resets the instant the camera or
      scene changes, exactly like a viewport renderer.
- [x] **Split-screen compare** — rasterizer on the left, path tracer on the right, with a
      draggable divider, so the approximations and the ground truth sit side by side.
- [x] **Emissive materials + a Cornell box & a reflections scene** that only read correctly
      under global illumination (colour bleeding, soft contact shadows, true inter-reflection).
- [x] **An in-app RT verification suite** (`raytrace/verify.ts`) — Möller–Trumbore vs analytic
      hits, BVH-vs-brute-force agreement on random rays, the cosine/GGX sampling statistics,
      orthonormal-basis & Fresnel identities, and the **furnace test** (a white surface in a
      uniform white environment re-emits exactly its lit radiance — energy conservation), run
      live in the browser.

### v2 — physically based rendering, image-based lighting & post FX (planned 2026-06-19)

A second major pass that turns the renderer from a Blinn–Phong toy into a small but
real PBR engine with an HDR pipeline. New steps:

- [x] **Metallic-roughness PBR** — Cook–Torrance microfacet BRDF (GGX/Trowbridge–Reitz
      NDF, Smith height-correlated geometry, Fresnel–Schlick) in `render/pbr.ts`,
      selectable against Blinn–Phong from the panel so you can A/B them live.
- [x] **Procedural environment / image-based lighting** — `render/environment.ts`: an
      analytic HDR sky (zenith / horizon / ground gradient + a sharp sun disk) that
      drives a real per-pixel skybox, diffuse irradiance ambient, and a
      roughness-blurred specular reflection. Makes metals read as metal.
- [x] **Tangent-space normal mapping** — `computeTangents` (Lengyel) on every mesh, a
      tangent threaded through the clip/raster pipeline, a per-fragment TBN basis, and
      four procedural normal maps (bumps, ripples, brick relief, scales).
- [x] **HDR framebuffer + filmic tone mapping** — shading writes *linear* radiance into
      a Float32 HDR buffer; `render/post.ts` applies exposure + ACES/Reinhard/Filmic
      tone mapping before gamma.
- [x] **Bloom** — threshold bright-pass + separable 9-tap Gaussian on a half-res
      buffer, composited back additively.
- [x] **FXAA** — luma-edge anti-aliasing as a cheap full-screen post pass.
- [x] **Vignette** — radial falloff in the resolve pass.
- [x] **OBJ paste-import** — `geometry/obj.ts`: real Wavefront parser (v / vn / vt /
      polygon `f`, negative indices, fan triangulation), auto-normals + auto-fit, fed
      through a "Custom mesh" scene, with a built-in icosahedron sample.
- [x] **PNG screenshot export** — `canvas.toDataURL` download (try/catch for the
      sandboxed thumbnail).
- [x] **New PBR show scenes** — a metalness×roughness sweep grid that only reads
      correctly under PBR + IBL.
- [x] **Expanded control panel** — shading-model switch, environment + exposure +
      tone-map controls, a post-FX section, normal-map toggle, and the OBJ importer.

### v1 — original pipeline

- [x] Math library: vec2/3/4, mat4, perspective/lookAt/normal-matrix
- [x] Parametric mesh generators (cube, sphere, torus, plane, knot, helix)
- [x] Framebuffer: Uint32 colour + Float32 depth, clear + blit to canvas
- [x] Vertex transform pipeline (model/view/proj, normal matrix)
- [x] Homogeneous near-plane clipping (Sutherland–Hodgman)
- [x] Perspective-correct barycentric triangle rasterizer with top-left fill rule
- [x] Z-buffer depth test
- [x] Backface culling (screen-space winding)
- [x] Blinn–Phong shading, multiple directional + point lights, ambient
- [x] Procedural textures (checker, grid, bricks, uv) + bilinear sampling
- [x] Perspective-correct UV interpolation
- [x] Orbit camera with mouse drag + wheel zoom
- [x] Debug render modes (wireframe / depth / normals / uv / overdraw / clip)
- [x] Scene presets + multiple objects + ground plane
- [x] Control panel UI + live stats HUD (FPS, triangles, fill)
- [x] Resolution scale + supersampling for crisper edges
- [x] Spinning auto-rotate + per-object animation
- [x] Shadow mapping (orthographic depth pass from the key light, PCF + slope bias)
- [x] Exotic parametric meshes (Klein bottle, Möbius band, spring) + auto finite-difference normals
- [ ] Tangent-space normal mapping  — stretch
- [ ] OBJ paste-import  — stretch
- [ ] Triangle MSAA via coverage masks  — stretch

## Session log

- 2026-06-19 (claude / claude-opus-4-8): created the project. Built the full pipeline from
  scratch — math, meshes, framebuffer, homogeneous clipper, perspective-correct rasterizer,
  z-buffer, Blinn–Phong with multiple lights, procedural textures, orbit camera, eight debug
  render modes, scene presets and a full control panel + stats HUD. Pure TS, no WebGL.
- 2026-06-19 (claude / claude-opus-4-8): added **real-time shadow mapping**. New
  `render/shadow.ts` renders scene depth from the key directional light through an
  orthographic frustum (auto-fit to the scene bounds) into a 1024² depth texture, then the
  fragment stage reprojects each point into light space and does a 3×3 PCF comparison with a
  slope-scaled bias. Added `orthographic()` to the math lib and a "Shadow map" toggle.
  Verified with offline PNG renders: every object now casts a soft, grounded shadow.
- 2026-06-19 (claude / claude-opus-4-8): added a **math exhibit** — three new exotic
  parametric meshes (figure-8 Klein bottle, Möbius band, helical spring) and a fourth scene
  preset showing them off. `parametricSurface` now estimates vertex normals from central
  differences (∂P/∂u × ∂P/∂v) when a generator doesn't supply analytic ones, so adding new
  surfaces is one function. Normals view confirms the Möbius normal-flip across its twist.
- 2026-06-19 (claude / claude-opus-4-8): **v3 — gave the rasterizer a ground-truth twin: a
  from-scratch CPU path tracer.** New `raytrace/` module: `intersect.ts` (Möller–Trumbore +
  branchless ray/AABB slab), `bvh.ts` (a binned-SAH bounding volume hierarchy, 12 bins/axis,
  iterative closest-hit + any-hit shadow traversal in flat typed arrays), `rtscene.ts` (flattens
  the live animated scene into a cache-friendly world-space triangle soup with a material table
  and area-light list), `sampling.ts` (xorshift RNG, cosine/GGX/cone/sphere importance sampling,
  Duff orthonormal basis, Fresnel), `tracer.ts` (a metallic-roughness BSDF identical to `pbr.ts`,
  next-event estimation to punctual + emissive-area lights, multi-bounce GI, Russian roulette,
  plus an ambient-occlusion estimator), `raytracer.ts` (progressive Float32 accumulation refined
  a budgeted slice per frame, jittered-ray AA, tone-mapped through the shared HDR resolve), and
  `verify.ts` (an in-app self-test). Wired an **Engine** switch (Rasterizer / Ray tracer) and a
  full RT control panel into the UI, a **split-screen compare** (raster left, path tracer right,
  draggable divider), emissive materials, per-scene camera framing, and two GI showcase scenes —
  a **Cornell box** (colour bleeding, soft contact shadows) and a **hall of mirrors** (true
  inter-reflection). Verified headlessly: the BVH matches brute force on 20k random rays with
  zero mismatches and zero Δt; the furnace test returns 0.9996 of the unit environment (energy
  conserving); all 8 self-tests pass; offline PNGs show the Cornell box, the mirror spheres, the
  raster↔RT split and the AO clay-render all rendering correctly.
- 2026-06-19 (claude / claude-opus-4-8): **v2 — turned the Blinn–Phong toy into a small PBR
  engine with an HDR pipeline.** New modules `render/pbr.ts` (Cook–Torrance metallic-roughness:
  GGX + Smith + Fresnel), `render/environment.ts` (analytic HDR sky → skybox + diffuse
  irradiance + roughness-blurred specular IBL), `render/post.ts` (HDR resolve with
  exposure, ACES/Reinhard/Filmic tone mapping, half-res separable bloom, FXAA, vignette),
  and `geometry/obj.ts` (Wavefront OBJ importer with auto-normals/auto-fit + an icosahedron
  sample). Threaded a per-vertex **tangent** through the whole pipeline (Lengyel's method in
  `computeTangents`, interpolated in the clipper + rasterizer) to support **tangent-space
  normal mapping** off four procedural maps. The framebuffer grew a Float32 **HDR buffer**:
  the `shaded` beauty pass writes linear radiance there and the resolve pass tone-maps it;
  all debug views still pack straight to the LDR buffer. Two lighting models are now live-
  switchable, plus an Environment/IBL toggle, normal-map toggle, full Post-FX section, a PBR
  metalness×roughness **sweep scene**, an OBJ import box and a **Save PNG** button. Verified
  with a headless harness across all 6 scenes × 8 modes × {phong,pbr} × {env on/off} (zero
  NaNs) and by rendering reference PNGs offline — the metals reflect the sky and sun, the
  brick/bump normal maps catch the light, and the PBR sweep reads as the canonical chart.
