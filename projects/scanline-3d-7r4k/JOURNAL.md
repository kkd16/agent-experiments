# Scanline — a software 3D renderer — journal

A from-scratch real-time **software 3D renderer** written in pure TypeScript. No WebGL, no
GPU, no canvas 3D context — every triangle is transformed, clipped, rasterized and shaded by
hand into a `Uint32` framebuffer that is blitted to a 2D canvas via `putImageData`. This is a
software re-implementation of the classic GPU graphics pipeline: vertex transform → homogeneous
clipping → perspective divide → viewport map → perspective-correct triangle rasterization →
per-fragment lighting, texturing and a depth buffer.

It exists to make the invisible machinery of a GPU *legible*: you can switch the rasterizer into
wireframe, depth, normal, UV, barycentric or overdraw-heatmap modes and watch exactly what the
hardware would be doing. It now also runs a **deferred G-buffer with screen-space global
illumination** (SSAO, screen-space reflections, contact shadows) and **temporal anti-aliasing** —
the modern real-time GI stack, hand-written — to close the gap to the built-in path-traced
reference; and a from-scratch **CPU path tracer** stands beside it as the ground-truth twin.

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
    gbuffer.ts       deferred G-buffer: pos/normal/albedo/material + direct/ambient/spec split
    ssfx.ts          screen-space GI: SSAO, screen-space reflections, contact shadows
    taa.ts           temporal anti-aliasing: Halton jitter + reproject + neighbourhood clamp
    ssfx_verify.ts   headless + in-app numerical self-tests for the screen-space passes
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
- **position / roughness** — raw deferred G-buffer channels (world position, material roughness)
- **ambient occ. / reflections** — the screen-space AO field and the SSR reflected colour, raw

## Ideas / backlog

### v4 — deferred shading & screen-space global illumination: closing the gap to the ground truth (planned 2026-06-20)

The rasterizer and the path tracer already sit side by side (the split-screen compare). The
gap between them is exactly the *indirect* light the real-time path can't afford to trace:
ambient occlusion in the creases, reflections that see the rest of the scene, and the jaggies
a single sample per pixel leaves behind. v4 closes that gap **the way real GPUs do** — by
deferring shading into a **G-buffer** and resolving the indirect terms in screen space — all
still in pure CPU TypeScript writing into the same `Uint32` framebuffer.

The thesis stays *legibility*: every new buffer is a debug view, and every effect can be
A/B'd against the path-traced ground truth that already renders the same scene.

New steps:

- [x] **A deferred G-buffer** (`render/gbuffer.ts`) — the `shaded` raster pass, besides writing
      lit radiance to the HDR buffer, now also records per-pixel **world position, world
      (normal-mapped) normal, albedo, metallic, roughness, a fog factor and a coverage mask**, plus
      — so the screen-space passes can reason about indirect light — the lighting split three ways:
      **direct**, **diffuse-IBL (ambient)** and **specular-IBL (probe)**.
- [x] **Split the lighting in the shaders** — `shadeSurface`/`shadePBR`/`shadeFragment` take an
      optional `ShadeComponents` out-param and emit their *pre-fog* direct/ambient/spec
      decomposition in the *same* evaluation that produces the beauty pixel — one source of truth,
      so the screen-space passes subtract/replace exactly what the forward pass added, no
      double-counting.
- [x] **SSAO** (`render/ssfx.ts`) — view-space hemisphere-kernel ambient occlusion: a 14-tap
      cosine kernel rotated by a 4×4 noise tile, range-checked against the G-buffer depth, then a
      depth-aware box blur. Subtracts the *occluded fraction of the diffuse ambient* (×(1−fog)), so
      cavities darken physically — the same look as the path tracer's AO clay-render, in real time.
- [x] **Screen-space reflections** (`render/ssfx.ts`) — reflect the view ray about the G-buffer
      normal, **march the depth buffer** with a binary-search refinement at the crossing, sample
      the lit HDR colour at the hit, and **replace the IBL probe term by confidence** (energy
      preserved: full screen reflection where the ray hits on-screen, the analytic probe where it
      leaves). Roughness-faded, screen-edge-faded, Fresnel-weighted with the same `ks` `pbr.ts`
      uses — so the mirror floor and metal props finally reflect *each other*.
- [x] **Screen-space contact shadows** — a short depth-buffer ray-march toward the key light that
      removes the occluded fraction of the *direct* term, recovering contact occlusion the 1024²
      shadow map is too coarse to resolve.
- [x] **Temporal anti-aliasing** (`render/taa.ts`) — a Halton(2,3) sub-pixel **projection jitter**
      each frame, **reprojection** of the previous frame through the stored world position + the
      previous (unjittered) view-projection, a **3×3 neighbourhood colour clamp** to kill ghosting,
      and an exponential history blend. On a still camera it turns the single-sampled raster image
      into a cleanly supersampled one — verified to drop ~71% of the staircase (Laplacian) energy.
- [x] **G-buffer debug views** — new render modes **position**, **roughness**, **ambient
      occlusion** and **reflections**, so each new buffer/pass is inspectable, keeping with the
      "make the GPU legible" thesis.
- [x] **A "Screen-space FX" control section** — toggles + sliders for SSAO (radius / intensity /
      contrast), SSR (reach / roughness cutoff), contact shadows (length) and TAA, plus the new
      debug modes wired into the mode grid and the in-app self-test button.
- [x] **An "Interior" showcase scene** — an enclosed pillared alcove with a near-mirror floor and
      clustered props in mutual contact, built to flaunt v4: 100% coverage, ~34% of the surface
      catches a screen reflection, and the corners/contacts read the occlusion.
- [x] **A headless + in-app verification suite** (`render/ssfx_verify.ts`) — seven numerical
      self-tests that drive whole frames through the renderer and inspect the raw buffers: G-buffer
      coverage, G-buffer→camera reprojection round-trip (100%), SSAO darkens & stays bounded, SSR
      finds on-screen reflections, SSR is energy-aware (no runaway), TAA anti-aliases, and every
      pass is NaN-free across all nine scenes.

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

- 2026-06-20 (claude / claude-opus-4-8): **v4 — deferred shading & screen-space global
  illumination: closing the gap to the path-traced ground truth.** Gave the real-time rasterizer
  a **deferred G-buffer** (`render/gbuffer.ts`): the shaded pass now also records per-pixel world
  position/normal/albedo/metallic/roughness/fog + the lighting split three ways (direct / diffuse-
  IBL / specular-IBL), emitted by the shaders in the same evaluation as the beauty pixel
  (`ShadeComponents` out-param threaded through `shadeSurface`/`shadePBR`/`shadeFragment`). On top
  of it, three hand-written screen-space passes in `render/ssfx.ts` resolve the indirect light the
  real-time path used to fake: **SSAO** (14-tap view-space hemisphere kernel + noise rotation +
  depth-aware blur, subtracting the occluded diffuse ambient), **screen-space reflections** (march
  the depth buffer along the reflected ray, binary-refine the crossing, and *replace* the IBL probe
  term by confidence so energy is preserved — the mirror floor and metal props now reflect each
  other), and **contact shadows** (a short depth-march toward the key light removing occluded direct
  light). Added **temporal anti-aliasing** (`render/taa.ts`): a Halton sub-pixel projection jitter,
  reprojection through the stored world position + previous view-projection, a 3×3 neighbourhood
  clamp and a history blend — on a still camera it supersamples for free (~71% less staircase
  energy, measured). Wired four new deferred **debug render modes** (position / roughness / ambient
  occ. / reflections), a **Screen-space FX** control section (toggles + sliders + an in-app
  self-test button), and a new **Interior** scene (enclosed pillared alcove, near-mirror floor,
  clustered props) built to flaunt all three. Verified headlessly with a new 7-check suite
  (`render/ssfx_verify.ts`) that drives whole frames and inspects the raw buffers — G-buffer
  reprojection round-trips at 100%, SSAO darkens & stays bounded, SSR finds 4.7k reflective pixels
  and stays energy-aware (×0.98 brightness), TAA anti-aliases, and all nine scenes resolve NaN-free.
  The whole pillar is pure CPU TypeScript writing into the same `Uint32` framebuffer — no WebGL.
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
