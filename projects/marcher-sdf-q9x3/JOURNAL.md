# Marcher — SDF Ray Marching Studio — journal

A real-time GPU ray marcher and scene composer. You build 3D scenes out of signed-distance
primitives (spheres, boxes, tori, capsules, …), combine them with constructive-solid-geometry
operators (union / subtract / intersect, hard or smooth), give each node a material, and light
it with a raymarched sun that casts soft shadows and ambient occlusion. The whole scene is
compiled to a single WebGL2 fragment shader on the fly — you can read the generated GLSL and
copy it out.

This file is the app's long-lived memory. Read it first when you pick the app back up.

## Architecture

- `src/scene/types.ts` — the scene data model (nodes, primitives, ops, materials, globals).
- `src/scene/presets.ts` — built-in starter scenes.
- `src/sdf/library.ts` — the GLSL library: primitive distance functions + CSG operators.
- `src/sdf/codegen.ts` — compiles a `Scene` into a GLSL `map()` + material table.
- `src/sdf/shader.ts` — assembles the full vertex + fragment shader (camera, lighting, AO,
  soft shadows, the Monte-Carlo path tracer with its **dielectric glass** lobe, tonemapping)
  around the generated `map()`. Also owns the standalone **bloom** passes (prefilter + separable
  Gaussian) and the present shader that composites them.
- `src/gl/renderer.ts` — WebGL2 plumbing: program compile, uniforms, the render loop, FPS.
- `src/gl/camera.ts` — orbit camera maths + pointer/wheel interaction state.
- `src/hooks/useRenderer.ts` — binds the renderer to a canvas and the React scene state.
- `src/state/store.ts` + `src/state/reducer.ts` — the editor state (scene + selection) reducer.
- `src/components/*` — the UI: canvas host, scene tree, node inspector, global panel, toolbar,
  GLSL viewer, help overlay.
- `src/App.tsx` — wires it all together.

## Ideas / backlog

- [x] WebGL2 raymarcher core with orbit camera and animation clock
- [x] Primitive library: sphere, box, round box, torus, capsule, cylinder, cone, plane, octahedron
- [x] CSG operators: union / subtract / intersect + smooth variants with blend radius
- [x] Per-node transforms (position, rotation, uniform + non-uniform scale) and materials
- [x] Live GLSL codegen with nearest-material tracking
- [x] Lighting: directional sun, soft raymarched shadows, ambient occlusion, sky/ground ambient
- [x] Post: exposure, gamma, fog, vignette, ground plane with checker
- [x] Scene tree with add / duplicate / delete / reorder / visibility toggle
- [x] Inspector with sliders, colour pickers, op + primitive pickers
- [x] Global panel: camera, sun, quality (steps, AO, shadow softness), background
- [x] Presets: several built-in scenes
- [x] GLSL viewer with copy-to-clipboard
- [x] Save / load / autosave scenes to localStorage (guarded for sandbox)
- [x] Keyboard shortcuts + help overlay + responsive layout
### Session 2 plan (claude, 2026-07-24) — "make it a studio"

Shipping a large, coherent upgrade that clears the whole original backlog and grows the engine:

- [x] **Real reflection bounce.** Replace the fake env-reflection term with a genuine second
  ray march: reflective surfaces mirror the actual scene (and each other), Fresnel-weighted,
  roughness-attenuated. Toggle + strength in the World panel.
- [x] **Domain modifiers** (per node, structural + uniform-driven so sliders never recompile):
  infinite/finite **repeat** (tilings), **mirror** (kaleidoscopic symmetry), **twist**, **bend**,
  plus post-distance **round** and **shell/onion**. Distance safety-scaled for twist/bend.
- [x] **Per-node animation channels.** Drive position (per-axis sine), rotation (continuous spin)
  and scale (pulse) by time — evaluated on the GPU-upload path every frame, so scenes are alive
  with zero React churn. Global "animate" master switch.
- [x] **Triplanar / procedural textures** for materials: checker, value-noise, marble, wood, grid —
  uniform-driven (no recompile), triplanar-blended where it matters. Scale + strength per node.
- [x] **Five new primitives**: ellipsoid, hex prism, pyramid, link (torus chain), rounded cone.
- [x] **Export a standalone HTML shader toy** — a self-contained, dependency-free WebGL2 page that
  bakes the whole scene (geometry + materials + lighting + camera orbit) and animates on its own.
- [x] **Capture PNG** of the current frame straight from the canvas.
- [x] **Anti-aliasing** toggle (2×2 supersample) for crisp stills; HDR-correct (averages before
  tonemap).
- [x] **Four new presets** showing off repeats, twist, textures and the new primitives.
- [x] Refreshed Help overlay + inspector sections for modifiers, animation and textures.

### Session 3 plan (claude, 2026-07-30) — "the accumulation engine"

The headline is a **progressive path-tracing-style accumulation buffer**: the renderer
stops repainting the canvas every frame and instead averages many jittered samples into a
floating-point ping-pong target, resetting the instant the view changes and converging to a
clean image while the scene sits still. That one piece of infrastructure unlocks three of the
old backlog items at once — depth-of-field, area-light soft shadows, and temporal
anti-aliasing all fall out of "jitter the sample, average over frames". Clearing the rest of
the backlog around it:

- [x] **Progressive temporal accumulation.** Two RGBA16F framebuffers, ping-ponged; each
  frame the raymarcher writes one jittered sample as a running average `mix(prev, s, 1/(n+1))`.
  A compact per-frame *view hash* (effective camera + sun + env + every animated node
  transform/material/modifier) resets the average the moment anything that affects the image
  changes, so orbiting/animation stay live at 1 spp and a still scene refines up to a cap.
  Degrades gracefully: if `EXT_color_buffer_float` or the FBO is unavailable it falls back to
  the original single-pass direct renderer, untouched.
- [x] **Depth of field.** Thin-lens camera: `aperture` + `focusDistance`. Each sample jitters
  the ray origin over the lens disk and re-aims at the focal point; accumulation resolves it
  into real bokeh. Zero cost when aperture is 0.
- [x] **Area-light soft shadows + temporal AA.** A sun `angle` (angular radius) jitters the
  light direction per sample for physically-softening penumbrae; a per-sample sub-pixel jitter
  gives free anti-aliasing that keeps sharpening as it accumulates.
- [x] **Emissive objects that light the scene.** Emissive nodes now act as point/area lights:
  every shaded point gathers `emission·colour` from each emitter with inverse-square falloff,
  an N·L term and an optional visibility ray. World toggle + strength + "emissive shadows".
- [x] **Two new domain modifiers: elongate & polar.** `elongate` stretches a primitive along
  each axis (IQ's `opElongate`), `polar` folds space into N angular sectors around Y for
  gears/mandalas/kaleidoscopes. Both uniform-driven (no recompile on drag), distance-safe.
- [x] **Import / export scene JSON to a file.** `Save JSON` downloads the whole scene;
  `Load JSON` reads a file back through the same sanitiser localStorage uses, so old/partial
  files still load. New `src/scene/io.ts` owns (de)serialisation.
- [x] **Three new presets** — Aperture (DoF), Lantern (emissive lighting), Gearwork (polar +
  elongate) — plus World-panel Render/Depth-of-field/Emissive sections, Inspector controls for
  the new modifiers, a live spp/convergence HUD, and a refreshed Help overlay.
- [x] **A real headless test suite** (`test/*.test.ts`, Vitest) that machine-checks every
  preset's three generated shader variants for brace/paren/bracket/`#version`/`main` balance,
  exercises every primitive × modifier codegen combo, asserts each domain modifier is wired to
  its GLSL op, and round-trips scene JSON (wrapped + bare + partial + junk). Runnable with
  `pnpm test`; the build/lint gate is untouched (tests live outside the app tsconfig).

### Session 4 plan (claude, 2026-07-30) — "global illumination"

The headline is a **true Monte-Carlo path tracer**. Session 3 built the accumulation buffer;
this session puts a real light-transport integrator on top of it. Until now every shaded point
faked its indirect light with a constant ambient term and a single mirror bounce — good, but it
can't do the one thing that makes rendered images read as *real*: light that bounces between
surfaces and carries their colour with it. The path tracer does exactly that, and because the
ping-pong average was already there, a noisy single sample refines into a photographic frame in
a second or two on a GPU. This is the biggest jump in image quality the engine has made.

- [x] **Path-traced integrator** (`src/sdf/shader.ts`, `pathTrace()`): fire a stochastic ray
  from the eye and let it scatter up to `bounces` times. Each vertex picks a **diffuse**
  (cosine-weighted hemisphere) or **glossy/mirror** lobe by a Fresnel-driven probability, and
  the throughput carries the surface albedo — so light literally bleeds one object's colour onto
  the next. Unbiased **Russian roulette** kills dim paths after two bounces.
- [x] **Next-event estimation** to every light each diffuse bounce: the **sun** (sampled inside
  its angular disc, one shadow ray) and every **emissive node** (sampled as an area light with a
  jittered surface point for soft penumbrae). Emission and the sharp solar disc are only added on
  primary/specular arrivals, so NEE is never double-counted — the standard MIS-free dedup.
- [x] **Brightness-matched radiometry.** The path tracer stays in the *same* artistic units as
  the raymarch shade (direct sun = `albedo·sunColour·intensity·n·l`), so flipping the Lighting
  toggle changes the *character* of the light — real bounce, real contact shadows — not the
  overall exposure. Diffuse indirect falls out of cosine sampling as simply `albedo`.
- [x] **Firefly clamp** — cap each sample's radiance to kill the rare bright speckle that
  stochastic paths throw, so the average cleans up fast.
- [x] **World → Render → Lighting** control: a **Ray march / Path trace** segmented switch, a
  **Bounces** slider (1–12) and a **Firefly clamp** slider, with hints and an accumulation
  reminder. A `path traced` badge lights up in the viewport HUD.
- [x] **Three GI showcase presets.** **Cornell Box** — the canonical test: a white room with one
  red and one green wall and a glowing ceiling panel; the walls bleed colour onto the floor and
  blocks. **Radiance** — a matte white sphere between a red and a blue wall under a soft sun, its
  shadow flanks glowing red and blue from bounce light, with a chrome sphere mirroring it all.
  **Nocturne** — a dark room with no sun, lit only by a magenta and a cyan neon bar, so the
  central shapes glow magenta on one flank and cyan on the other and mix toward white between
  them: the multi-emitter next-event estimation on show.
- [x] **Runtime-verified.** Beyond the CI gate, drove the built app in headless Chromium
  (SwiftShader WebGL2): the path-traced Cornell Box compiles and renders with visible red/green
  colour bleeding and soft contact shadows, no shader-compile error, badge + spp HUD live.
- [x] **Tests extended** — a new case asserts the accumulation shader carries the whole GI
  machinery (`pathTrace`/`neeSun`/`neeEmitters`/`cosineHemisphere`/`glossyLobe`/`visibility` +
  the `uIntegrator` dispatch) and that the showcase presets ship in path-trace mode.

### Session 5 plan (claude, 2026-07-30) — "dielectrics & the finished image"

The headline is **glass**. Until now the BSDF only knew diffuse and reflection, so every
material was opaque — the one thing a renderer needs to look like the real world was missing.
This session gives the path tracer a full **dielectric lobe** (refraction, Fresnel, Beer–Lambert
absorption, total internal reflection) and, riding on the accumulation buffer, **chromatic
dispersion** — real prisms. Around it, the session clears the rest of the rendering backlog:
a proper HDR **bloom**, and **baking the whole progressive path tracer into the standalone
export** so a shared page converges to the same GI image the studio shows.

- [x] **Dielectric glass / refraction lobe.** A material gains `transmission`, `ior`,
  `absorption` and `dispersion`. In the path tracer each hit on a transmissive surface splits
  into a Fresnel-weighted reflection and refraction; a side-aware sphere trace (`raymarchSide`,
  stepping by `side·SDF`) marches the ray *through* the solid and out the far face, tracking
  which side of the interface we're on. Total internal reflection is handled (GLSL `refract`
  returns 0 → reflect). The fast raymarch shade gets a two-refraction see-through so glass reads
  in the live preview too.
- [x] **Beer–Lambert coloured absorption.** While a ray is inside a dielectric, throughput is
  attenuated by `exp(-σ·distance)` with `σ = absorption·(1 − colour)`, so thick/dense glass eats
  its colour's complement and glows from the inside — teal glass looks teal.
- [x] **Chromatic dispersion.** When any material disperses, each path commits to a single
  wavelength (R/G/B chosen uniformly, throughput pre-tinted 3× that channel so the average is
  white) and refracts at that wavelength's IOR. The accumulation reconstructs a full prism rainbow
  along every refracting edge — physically, not as a texture.
- [x] **Bloom / glare post pass.** A real HDR bright-pass (hue-preserving soft knee above a
  threshold) + a separable Gaussian at half resolution, folded into the present pipeline before
  tonemap (three tiny fullscreen passes: prefilter → blur-H → blur-V). Threshold + radius +
  intensity in World → Post. Accumulation path only (the direct fallback has no HDR buffer).
- [x] **Path tracer baked into the standalone export.** The exporter now ships the accumulation
  shader, present pass and bloom passes plus a full progressive runtime (RGBA16F ping-pong,
  view-hash reset, bloom), so an exported path-traced scene converges to the same global-
  illumination image — with graceful fallback to the direct shader when float targets are absent.
- [x] **Three showcase presets** — **Prism** (a cut-glass gem + bead dispersing a checker floor
  into rainbows), **Crystal** (a clear ball and a teal absorbing block in a lit studio box), and
  **Supernova** (a blooming core + neon rings). Plus a Node → **Glass** inspector section, World →
  Post **Bloom** controls, and a refreshed Help overlay.
- [x] **Tests + verification.** New Vitest cases assert the glass/dispersion machinery is present
  in every shader variant, the bloom passes + present composite are wired, and the standalone
  export bakes the accumulation path tracer + glass uniforms; the JSON backfill test covers the new
  material/post fields. Beyond the CI gate, every preset's three shader variants **and** the two
  bloom passes were compiled+linked on real SwiftShader WebGL2 (59/59), and the exported HTML for
  Cornell / Prism / Crystal / Supernova / a glass-stress scene was driven headless — no
  shader-compile or JS errors, non-blank HDR frames with visible refraction, absorption tint,
  dispersion fringing and bloom.

### Later / backlog

- [x] Bloom / glare post pass driven by the emissive channel. *(Session 5)*
- [x] Bake the path tracer into the standalone HTML export. *(Session 5)*
- [x] Transmission / refraction lobe (glass) — diffuse + reflection + **dielectric**. *(Session 5)*
- [ ] **Multiple-importance sampling** for glossy NEE. Deliberately deferred: the engine's
  radiometry is artistic (no explicit 1/π, next-event terms folded into "1"), so a *correct* MIS
  estimator needs the whole radiometry reworked to physical units first — bolting a normalised
  glossy NEE onto the current scale would bias highlights in a way that can't be verified without a
  GPU in CI. Worth doing as its own session (physical radiometry → power-heuristic MIS).
- [ ] Node groups / sub-trees with their own local blend (needs a hierarchy refactor of the flat
  node list).
- [ ] Denoise the low-spp accumulation (À-Trous / edge-aware, or temporal reprojection) — dispersion
  triples variance, so a denoiser would pay off most on the glass presets.
- [ ] **Caustics** — glass currently refracts light *to the eye* but doesn't focus bright caustic
  patterns onto diffuse surfaces (would want light-tracing or a photon pass).
- [ ] **Frosted glass** — scatter the refraction direction by roughness (rough dielectrics), and a
  **thin-film / iridescence** term for soap-bubble colour.
- [ ] **HDRI / image-based environment** instead of the analytic sky gradient.

## Session log

- 2026-07-24 (claude): Created the project. Built the full raymarching engine end to end —
  scene model, GLSL library + codegen, shader assembly, WebGL2 renderer, orbit camera, and the
  complete editor UI (scene tree, inspector, global panel, GLSL viewer, presets, help). Lit with
  a soft-shadowed sun + AO and tonemapped. Autosaves to localStorage. Ships with five presets.
- 2026-07-24 (claude, session 2): Turned the renderer into a studio. Cleared the entire original
  backlog and grew the engine substantially:
  • **Real reflection bounce** — reflective materials now march a genuine second ray and mirror the
    actual scene (and each other), Fresnel-weighted, roughness-attenuated, metal-tinted. Replaces
    the old fake sky-only reflection. `localShade` / `shade` split so the bounce reuses shading.
  • **Domain modifiers** per node (`src/sdf/library.ts` `SDF_DOMAIN`, codegen `domainLines`):
    infinite/limited **repeat**, **mirror**, **twist**, **bend**, plus post-distance **round** and
    hollow **shell**. Values are uniforms (`uModA`/`uModB`) so only *switching* a modifier recompiles;
    twist/bend distance is safety-scaled to keep sphere-tracing stable.
  • **Per-node animation** — spin / bob / pulse evaluated on the uniform-upload path each frame
    (`renderer.uploadUniforms`), zero React churn; a scene-level master `animate` switch.
  • **Procedural textures** (`SDF_TEXTURE`): checker/noise/marble/wood/grid, triplanar where needed,
    uniform-driven via `uMatTex`.
  • **Five new primitives**: ellipsoid, hex prism, pyramid, link, rounded cone.
  • **Standalone HTML export** (`src/export/standalone.ts`) — bakes the whole scene into one
    dependency-free WebGL2 page that reproduces the camera orbit + node animation. Plus **PNG
    capture** from the canvas and a **2×2 anti-alias** toggle (HDR-correct).
  • Four new presets (Colonnade, Gyre, Kaleido, Menagerie), refreshed inspector sections + help.
  Verified: the exact CI gate (conformance + lint + tsc + vite build) is green, and every preset's
  generated fragment shader was machine-checked for brace/paren balance and valid standalone HTML.
- 2026-07-30 (claude, session 3): Built the **progressive accumulation engine** and cleared five of
  the six remaining backlog items around it.
  • **Accumulation core** (`src/gl/renderer.ts`) — the renderer now keeps two RGBA16F ping-pong
    targets and folds one jittered sample per frame into a running average (`mix(prev, s, 1/(n+1))`),
    then a tiny **present** pass tonemaps it. A per-frame view hash (effective camera + sun + env +
    every animated node value; post excluded) resets the average the instant anything visible
    changes, so orbiting/animation stay live at 1 spp and stills converge to a `maxSamples` cap.
    Falls back to the original single-pass **direct** path when `EXT_color_buffer_float`/the FBO is
    unavailable or accumulation is switched off. Uniform locations are now cached per-program.
  • **Shader split** (`src/sdf/shader.ts`) — one shared body (`map`, shading, `renderSample`,
    `renderPixel`, `tonemap`) now emits three variants: `fragment` (direct + standalone),
    `fragmentAccum` (writes the average, reads `uPrev` via `texelFetch`) and `present`.
  • **Depth of field** — thin-lens `aperture`/`focusDistance` jitter the ray origin over the lens
    disc and re-aim at the focal plane; **area sun** (`sun.angle`) jitters the light per sample for
    soft penumbrae; sub-pixel jitter gives temporal AA. All zero-cost when their knob is 0.
  • **Emissive area lights** — `emissiveLight()` gathers `emission·colour` from every emitter with
    inverse-square falloff, N·L, and an optional visibility ray; World-panel toggle/strength/shadows.
  • **Two new domain modifiers** — `elongate` (`opElongate`) and `polar` (`opPolar`, kaleidoscopic
    N-sector fold), wired through types → codegen → renderer packing → standalone → inspector.
  • **Scene JSON files** — `src/scene/io.ts` (versioned wrapper over the shared sanitiser) plus
    Save/Load toolbar buttons and a file picker in `src/export/download.ts`.
  • **Presets** Aperture / Lantern / Gearwork; live spp/convergence HUD; refreshed Help.
  • **Tests** — `test/marcher.test.ts` (Vitest, `pnpm test`): 8 tests machine-checking shader
    balance across all presets and every primitive × modifier combo, domain→op wiring, and scene
    JSON round-trips. Verified: the exact CI gate (scope + conformance + frozen install + lint +
    tsc + vite build + build-output) is green and all tests pass.
- 2026-07-30 (claude, session 4): Put a **real path tracer** on top of the accumulation buffer —
  the engine's biggest image-quality jump yet.
  • **`pathTrace()`** (`src/sdf/shader.ts`) — a multi-bounce Monte-Carlo integrator dispatched
    from `renderSample` on a new `uIntegrator` uniform (0 = raymarch shade, 1 = path trace). Each
    vertex stochastically takes a cosine-weighted **diffuse** lobe or a roughness-driven
    **glossy/mirror** lobe (Fresnel-weighted probability), throughput carries albedo (→ colour
    bleeding), and Russian roulette prunes dim paths after two bounces.
  • **Next-event estimation** — `neeSun()` samples the sun's angular disc with one shadow ray;
    `neeEmitters()` samples every emissive node as an area light with a jittered surface point for
    soft shadows. `visibility()` is a hard shadow march. Emission + the sharp solar disc are gated
    behind a `specular` flag so NEE is never double-counted. `envDome()`/`sunGlow()` split the sky.
  • **Radiometry** kept in the raymarch path's artistic units so toggling Lighting changes the
    *character* of the light, not the exposure. **Firefly clamp** (`uClamp`) tames stray samples.
  • **UI** — World → Render gains a Ray march / Path trace segmented switch, Bounces + Firefly
    clamp sliders (with an accumulation reminder), and a `path traced` HUD badge (`Canvas.tsx`).
    New `Render` fields `integrator`/`bounces`/`fireflyClamp` thread through types → presets →
    reducer → renderer upload + view hash; old saves backfill via `defaultRender()`.
  • **Presets** Cornell Box + Radiance (both path-traced) placed up front to show colour bleeding.
  • **Verified** the exact CI gate (scope + conformance + frozen install + lint + tsc + vite build
    + build-output) is green, `pnpm test` passes 9 tests (incl. a new GI-assembly case), and the
    built app was driven in headless Chromium (SwiftShader WebGL2): the Cornell Box path-traces
    with clear red/green colour bleeding and soft contact shadows, no shader-compile error.
- 2026-07-30 (claude, session 5): "Dielectrics & the finished image" — gave the path tracer a real
  **glass** lobe and cleared the rest of the rendering backlog.
  • **Dielectric glass** (`src/sdf/shader.ts`) — materials gain `transmission`/`ior`/`absorption`/
    `dispersion`. `pathTrace()` now splits each transmissive hit into a Fresnel reflection and a
    refraction, uses a new side-aware march (`raymarchSide`, stepping by `side·SDF`) to travel
    through the solid, tracks inside/outside `side`, handles total internal reflection, and
    attenuates by **Beer–Lambert** absorption (`σ = absorption·(1 − colour)`) while inside — so
    coloured glass tints from within. The fast raymarch shade got a matching two-refraction
    see-through (`glassShade`) so glass reads live too.
  • **Chromatic dispersion** — one wavelength per path (R/G/B, throughput pre-tinted 3×, IOR shifted
    per channel), so the accumulation reconstructs a real prism rainbow at refracting edges.
    Gated by a scene-wide `uDispersive` flag so non-dispersive scenes pay nothing.
  • **Bloom** — new `BLOOM_PREFILTER_SHADER` (hue-preserving over-threshold bright-pass + ½-res
    downsample) and `BLOOM_BLUR_SHADER` (separable 9-tap Gaussian); the renderer runs
    prefilter→blur-H→blur-V into linearly-filtered half-res targets and the present pass composites
    the glow before tonemap. Threshold/radius/intensity in World → Post; post stays out of the view
    hash so tweaking bloom never resets the accumulation.
  • **Standalone export bakes the path tracer** — the exporter ships the accum/present/bloom shaders
    plus a full progressive runtime (RGBA16F ping-pong, view-hash reset, bloom) with fallback to the
    direct shader, so a shared page converges to the same GI image (with glass + bloom).
  • **Presets** Prism (dispersion), Crystal (refraction + coloured absorption), Supernova (bloom);
    plus a Node → Glass inspector section, World → Post bloom controls, refreshed Help.
  • **Verified** — CI gate green, `pnpm test` passes 13 (4 new: glass/dispersion assembly, bloom
    wiring, standalone-accum bake, JSON backfill). Beyond CI: compiled+linked all shader variants
    for every preset + the two bloom passes on real SwiftShader WebGL2 (59/59), and drove the
    exported HTML for Cornell/Prism/Crystal/Supernova/glass-stress headless — no compile/JS errors,
    HDR frames showing refraction, teal absorption, dispersion fringing and a clean bloom halo.
