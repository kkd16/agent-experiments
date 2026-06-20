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
    raytracer.ts     progressive accumulation, jittered-ray AA, primary feature buffers,
                     per-pixel variance, denoise integration + RT debug views, shared HDR resolve
    denoise.ts       edge-avoiding À-Trous wavelet denoiser (Dammertz 2010) + SVGF (Schied 2017)
                     variance guidance — turns the noisy low-spp tracer into a clean image
    verify.ts        in-app numerical self-test (incl. the furnace energy test)
    denoise_verify.ts headless + in-app self-test for the denoiser (kernel, edges, variance, e2e)
  sdf/             implicit modelling: signed distance fields → marching cubes
    sdf.ts           SDF primitives + boolean/smooth CSG + domain transforms + gradient
    marchingcubes.ts Lorensen–Cline polygoniser (Bourke tables), vertex welding, fit/volume
    scenes.ts        the implicit scene gallery (metaballs, gyroid, machined part, …)
    verify.ts        in-app self-test (volume, Euler characteristic, gradient normals)
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

The **ray tracer** has its own view selector (v6 denoiser): **denoised** beauty, the raw **noisy**
average, a **wipe** that splits noisy↔denoised, and the feature buffers the filter reads —
**albedo**, **normal**, and the per-pixel **variance** heat field.

## Ideas / backlog

### v6 — real-time denoised path tracing: À-Trous + SVGF-lite (planned 2026-06-20)

The path tracer is the *ground truth*, but at the interactive sample counts it can afford while
you orbit (often **1 spp**) it is buried in Monte-Carlo noise — the one place the rasterizer still
looks better. v6 closes that the way a modern real-time path tracer does: a **denoiser** that
reconstructs a clean image from a handful of samples by blurring **only** along surfaces, never
across an edge, and only as hard as the local noise demands. It reuses the v3 tracer and borrows
the v4 idea of feature buffers, but for the *primary hit* of the path tracer rather than the
rasterizer.

The thesis stays *legibility and ground truth*: the denoiser is variance-aware, so as the image
converges it **decays to the exact progressive average** (no permanent over-blur), and it ships
with a self-test that re-derives every claim independently — kernel correctness against a hand-
computed wavelet, edge preservation against an edge-blind blur, **unbiased** variance reduction
(mean preserved), and a real path-traced frame end-to-end.

New steps:

- [x] **Primary feature buffers** (`raytrace/tracer.ts` `primaryFeature` + `raytracer.ts`
  `computeFeatures`) — one shading-free primary ray per pixel fills per-pixel **albedo / world
  normal / world position / hit-mask**, computed once per accumulation reset (they're a pure
  function of camera + geometry, which the reset key already tracks). These are the G-buffer the
  denoiser's edge-stopping functions read.
- [x] **Per-pixel Monte-Carlo variance** — the accumulator grows a second luminance moment
  (`accumSq` = Σ luma²), giving the sample variance and hence the **variance of the mean
  estimator** (÷ n) per pixel — SVGF's noise signal that drives how hard each pixel is filtered.
- [x] **SVGF spatial-variance bootstrap** (`raytracer.ts` `spatialVarianceBootstrap`) — with < 4
  samples the temporal variance is ~0 (one sample has no spread), so it's estimated instead from a
  5×5 **normal-gated** spatial neighbourhood. This is what lets the filter clean up the *first*
  frame (1 spp), exactly when the tracer is noisiest.
- [x] **The edge-avoiding À-Trous wavelet** (`raytrace/denoise.ts`) — the Dammertz et al. (2010)
  filter: a 5×5 cubic-B-spline (`[1 4 6 4 1]/16`) cross-bilateral convolution whose tap spacing
  **doubles** every level (the "à-trous"/holes trick — N levels reach a 2^(N+2)-wide footprint at
  N·25 taps). Each tap is reweighted by three edge-stopping functions: **luminance**
  `exp(−|Δl|/(σ_l·√Var+ε))` (SVGF's noise-aware term), **normal** `max(0,n_p·n_q)^σ_n` (creases),
  and **plane** `exp(−|n_p·(P_q−P_p)|/σ_p)` (depth cliffs). Variance rides along with the *squared*
  weights. Pure passes over typed arrays — no DOM, no hot-loop allocation.
- [x] **Albedo demodulation** — the filter operates on **irradiance = colour ÷ albedo** (guide
  clamped away from zero) and re-modulates after, so texture/material detail is divided out before
  the blur and never smeared. Toggleable.
- [x] **Engine integration + caching** (`raytracer.ts` resolve) — the resolve pass averages the
  accumulator into a `mean` buffer, estimates variance, optionally denoises, then composes the
  requested view. The (expensive) wavelet is **cached on a signature** (pass count + settings) so
  it re-runs only when its input actually changes, and it's **skipped past 512 spp** (the raw
  average is already exact there — interaction stays free and the ground truth is never over-blurred).
- [x] **RT view selector + UI** (`RTView`, `Controls.tsx`) — a **Denoiser** panel: enable, demodulate
  and variance-guided toggles, a **wavelet-levels / colour-σ / normal-σ / plane-σ** set of sliders,
  and a six-way view selector — **denoised** beauty, raw **noisy** average, a noisy↔denoised
  **wipe**, and the **albedo / normal / variance** feature buffers — that the RT blit honours.
- [x] **A denoiser self-test** (`raytrace/denoise_verify.ts`) — seven numerical checks: the
  demodulate∘modulate **round-trip**, the à-trous filter equals an independent **B-spline wavelet**
  reference (edge-stopping off), **unbiased variance reduction** on a flat noisy surface (variance
  ↓ while the mean is preserved), **normal** and **plane/depth** edge preservation vs an edge-blind
  blur, a **real Cornell frame** denoised end-to-end (≥ 40% less noise energy, brightness conserved),
  and NaN-free across four GI scenes × all six views. Verified headlessly: **7/7 pass**, and offline
  PNGs of a 1-spp Cornell box show the noise wipe collapse to a clean image with crisp box/sphere
  edges and intact colour bleeding.

### v5 — implicit modelling: signed distance fields → marching cubes (planned 2026-06-20)

Until now every object in the scene was either a hand-written parametric surface or an imported
OBJ — geometry authored *explicitly*, vertex by vertex. v5 adds the other half of the modelling
world: **implicit** geometry, where a shape is the zero set of a *signed distance field* and the
triangles are discovered, not authored. A complex solid becomes an algebra — `min`/`max` of
primitives for hard CSG, a smooth-minimum for melted blends, domain warps for twists and infinite
repeats — and a hand-written **marching cubes** polygoniser turns the field into a mesh that drops
straight into the *same* rasterizer **and** path tracer as any other.

The thesis stays *legibility and ground truth*: marching cubes is famously fiddly (the 256-case
lookup table, edge interpolation, vertex welding), so the subsystem ships with a self-test that
re-derives the hard claims from independent references — analytic primitive distances, the
smooth-min inequality, the enclosed **volume** against the closed form, and the **Euler
characteristic** that pins down the topology (a marched sphere must give χ=2, a marched torus
χ=0 / genus 1). If the tables are wrong, the topology test fails loudly.

New steps:

- [x] **An SDF algebra** (`sdf/sdf.ts`) — exact-bound distance primitives (sphere, box, rounded
  box, torus, capped cylinder, capsule, plane, **gyroid** TPMS), boolean CSG (union/intersect/
  subtract) **and** their smooth (`smin`-blended) counterparts, plus domain transforms
  (translate, uniform scale, rotate X/Y/Z, **twist**, **onion** shells, infinite **repeat**) and
  a central-difference gradient for normals. Every op is a plain closure over numbers — no
  allocation in the marcher's hot loop.
- [x] **Marching cubes** (`sdf/marchingcubes.ts`) — the Lorensen–Cline algorithm with Paul
  Bourke's verbatim 256-entry edge table + 256×16 triangle table. Samples the field on an n³
  grid, classifies each cell's 8 corners, interpolates a vertex onto every crossed edge, and
  **welds vertices across cells** by a global per-edge key so the output is a closed indexed
  manifold (not a triangle soup) with shared smooth normals taken from the field gradient.
- [x] **Watertightness, signed-volume & auto-fit helpers** — `isWatertight` (every edge shared by
  exactly two triangles), `signedVolume` (divergence theorem), and `fitMesh` (recentre + scale,
  mirroring the OBJ importer) so every implicit shape frames identically.
- [x] **A scene gallery** (`sdf/scenes.ts`) — seven fields exercising the whole algebra:
  **Metaballs** (seven smooth-unioned spheres), a **Machined Part** (three-axis drilled, chamfered
  block — pure boolean subtraction), a **Gyroid** shell clipped to a sphere, a **Twisted Bar**
  (domain warp), a **Critter** (blended character), a **Ring & Core** (topology that flips genus
  with the blend), and a **Carved** sphere. Smoothness and iso are live knobs.
- [x] **An "Implicit (SDF)" scene + control panel** — a framed plinth scene that feeds the
  renderer's custom-mesh slot, and a UI section with the field gallery, grid-resolution / blend /
  iso sliders, a live read-out (triangles · welded vertices · watertight · march time), and a
  "View in scene" button. Re-marches on change, debounced.
- [x] **A marching-cubes self-test** (`sdf/verify.ts`) — eight numerical checks: primitive
  distances vs closed form, the smooth-min identity, CSG sign algebra, a marched sphere
  (watertight + on-surface + outward-wound + analytic volume), the **Euler-characteristic
  topology test** (sphere χ=2, torus χ=0), gradient normals pointing radially, the analytic
  gradient magnitude, and an empty field → empty mesh. Wired into the panel like the RT/SSFX
  suites. Verified headlessly: **8/8 pass**, and offline PNG renders of the metaballs, gyroid and
  machined part show them shading correctly through the rasterizer with the dense mesh also
  building a BVH and rendering in the path tracer.

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

- 2026-06-20 (claude / claude-opus-4-8): **v6 — real-time denoised path tracing: an
  edge-avoiding À-Trous wavelet denoiser with SVGF-style variance guidance.** The path tracer is
  the ground truth but at interactive sample counts (often 1 spp) it's buried in Monte-Carlo noise;
  v6 reconstructs a clean image from a handful of samples by blurring **only** along surfaces.
  New `raytrace/denoise.ts` is the Dammertz et al. (2010) edge-avoiding À-Trous filter — a 5×5
  cubic-B-spline cross-bilateral whose tap spacing doubles each level (N levels → 2^(N+2)px at
  N·25 taps), reweighted by **luminance** `exp(−|Δl|/(σ_l·√Var+ε))` (the SVGF noise-aware term),
  **normal** `max(0,n·n)^σ_n` (creases) and **plane** `exp(−|n·ΔP|/σ_p)` (depth cliffs) edge stops,
  filtering **colour ÷ albedo** (demodulated irradiance) so texture never smears and carrying
  variance through with the squared weights. The tracer (`raytracer.ts`) grew **primary feature
  buffers** (albedo/normal/position/mask from one shading-free primary ray per pixel, via a new
  `primaryFeature` in `tracer.ts`), a **second luminance moment** (`accumSq`) for per-pixel
  Monte-Carlo variance, and an **SVGF spatial-variance bootstrap** (a 5×5 normal-gated estimate for
  the < 4-spp pixels where temporal variance is unavailable — this is what makes the *first* frame
  clean up). The resolve pass averages, estimates variance, denoises (cached on a pass+settings
  signature; skipped past 512 spp so the converged ground truth is never over-blurred) and composes
  a chosen **view**: denoised beauty, raw noisy average, a noisy↔denoised **wipe**, or the
  albedo/normal/variance feature buffers. A new **Denoiser** control panel exposes the toggles,
  σ sliders and the view selector, and `denoise_verify.ts` adds a 7-check self-test re-deriving the
  hard claims independently — the demodulate round-trip, the à-trous filter vs a hand-computed
  B-spline wavelet, **unbiased** variance reduction (mean preserved), normal & depth edge
  preservation vs an edge-blind blur, and a real Cornell frame end-to-end. Verified: **7/7** pass
  headlessly (a 1-spp Cornell frame loses 54% of its noise energy at ×0.98 brightness), the RT/SSFX
  suites still pass unchanged, and offline PNGs show the noisy↔denoised wipe collapse to a clean
  image with crisp edges and intact colour bleeding. Pure CPU TypeScript — no WebGL.
- 2026-06-20 (claude / claude-opus-4-8): **v5 — added an implicit-modelling pillar: signed
  distance fields polygonised by hand-written marching cubes.** New `sdf/` module. `sdf.ts` is a
  small SDF algebra — exact-bound primitives (sphere/box/rounded-box/torus/cylinder/capsule/plane/
  gyroid), boolean **and** smooth (`smin`) CSG, domain transforms (translate/scale/rotate/twist/
  onion/repeat) and a central-difference gradient. `marchingcubes.ts` is the Lorensen–Cline
  algorithm with Paul Bourke's verbatim 256-entry edge + 256×16 triangle tables: it samples the
  field on an n³ grid, interpolates a vertex onto each crossed cell edge, and **welds vertices
  across cells** by a global per-edge key so the result is a closed indexed manifold with smooth
  gradient normals — plus `isWatertight`, `signedVolume` and an OBJ-style `fitMesh`. `scenes.ts`
  ships seven fields (metaballs, a 3-axis-drilled machined part, a gyroid shell, a twisted bar, a
  blended critter, a genus-flipping ring, a carved sphere) with live smoothness/iso knobs, and a
  new **Implicit (SDF)** scene frames the marched mesh — which drops into the existing rasterizer
  *and* path tracer untouched (it builds a BVH over ~9k–59k triangles and renders). A control
  panel exposes the gallery, grid resolution, blend and iso, with a live triangles/vertices/
  watertight/time read-out, and `verify.ts` adds an 8-check self-test that re-derives the hard
  claims independently — analytic primitive distances, the smooth-min inequality, marched-sphere
  volume vs the closed form, and the **Euler characteristic** that fixes the topology (sphere
  χ=2, torus χ=0). Verified: 8/8 self-tests pass headlessly; offline PNGs of the metaballs, gyroid
  and machined part render correctly through the rasterizer; the dense mesh also path-traces.
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
