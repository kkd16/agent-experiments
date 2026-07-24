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
  soft shadows, tonemapping) around the generated `map()`.
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

### Later / backlog

- [ ] Depth-of-field (accumulate a thin-lens jitter over frames)
- [ ] Per-node "elongation" and "symmetry-plane" modifiers
- [ ] Temporal accumulation / progressive refinement for path-traced soft shadows
- [ ] Import/export scene JSON to a file (not just localStorage)
- [ ] Node groups / sub-trees with their own local blend
- [ ] Emissive objects that actually light the scene (area lights)

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
