# Fathom — journal

A GPU deep-zoom explorer for the Mandelbrot and Julia sets. The whole point is
**precision**: WebGL only promises 32-bit floats, so a naive shader dissolves
into blocky pixels around a zoom of ~1e4. Fathom stores every coordinate as a
`vec2(hi, lo)` "double-single" pair (~48-bit mantissa) and does all the escape-time
arithmetic with error-free transformations, pushing the crisp-zoom limit to
roughly 1e11 — about ten million times deeper — with everything still running on
the GPU.

## Architecture

- `src/webgl/shaders.ts` — vertex (attributeless fullscreen triangle) + fragment
  shader. The fragment shader carries the df64 primitives (`ds_add`, `ds_sub`,
  `ds_mul`) and the escape-time loop with continuous (smooth) iteration colouring.
- `src/webgl/renderer.ts` — `FractalRenderer`: program/uniform setup, palette
  texture upload, and a `render(FrameState)` call. Splits JS doubles into the
  (hi, lo) float32 pair the shader needs.
- `src/webgl/palettes.ts` — cosine (Inigo Quilez) and gradient-stop palettes,
  baked into a 1-D RGBA texture; CSS-gradient helper for the UI swatches.
- `src/fractal/useFractalEngine.ts` — the React hook wiring canvas events
  (drag-pan, wheel/double-click zoom around the cursor, shift-click to seed a
  Julia set), the render loop, colour cycling, PNG export, and HUD state.
- `src/fractal/bookmarks.ts` — curated Mandelbrot/Julia locations, including a
  5e-11 seahorse dive that only stays sharp because of df64.
- `src/components/` — `ControlPanel`, `Hud`, `BookmarkBar`.

## Ideas / backlog

- [x] WebGL2 renderer with emulated double precision (df64) escape-time loop
- [x] Smooth (continuous) iteration colouring, no visible bands
- [x] Pan (drag), zoom-to-cursor (wheel + double-click)
- [x] Julia mode + shift-click on the Mandelbrot to seed its constant
- [x] Eight cosine/gradient palettes with live swatches
- [x] Colour density, shift, and animated cycling controls
- [x] Auto iteration count that scales with zoom depth (with manual override)
- [x] 1x-3x supersampling anti-aliasing
- [x] Curated bookmark tour, including a deep-zoom demonstration
- [x] Live HUD: coordinates, magnification, iterations, fps
- [x] High-resolution PNG export
- [x] Graceful fallback card when WebGL2 is unavailable (safe in the sandboxed thumbnail)
- [ ] Perturbation-theory reference orbit for zoom beyond the df64 floor (~1e11)
- [ ] URL hash encoding of the current view for shareable deep links
- [ ] Distance-estimator colouring and interior stripe/orbit-trap shading
- [ ] Pinch-to-zoom for touch devices
- [ ] Smooth animated fly-in when jumping to a bookmark

## Session log

- 2026-07-17 (claude): Created Fathom from the template. Built the full df64 WebGL2
  pipeline, renderer, palettes, interaction hook, control panel, HUD, bookmark tour,
  and PNG export. Verified lint + build pass the project gate.
