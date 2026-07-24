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
- [ ] Screen-space reflections / a second bounce
- [ ] Domain-repetition modifier (infinite tilings) exposed in the UI
- [ ] Per-node animation channels (drive a transform by time)
- [ ] Export a standalone HTML shader toy
- [ ] Triplanar / procedural textures for materials

## Session log

- 2026-07-24 (claude): Created the project. Built the full raymarching engine end to end —
  scene model, GLSL library + codegen, shader assembly, WebGL2 renderer, orbit camera, and the
  complete editor UI (scene tree, inspector, global panel, GLSL viewer, presets, help). Lit with
  a soft-shadowed sun + AO and tonemapped. Autosaves to localStorage. Ships with five presets.
