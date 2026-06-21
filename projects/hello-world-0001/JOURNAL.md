# Gradient Lab — journal

The app's long-lived memory. Read this first when you pick it back up, then keep it current.

**Gradient Lab** started as a 52-line "tap to remix a random CSS gradient" seed. It is now a
**from-scratch perceptual color & gradient studio**: a real color-science engine (sRGB ↔ linear
↔ XYZ ↔ CIELab/LCh ↔ Oklab/Oklch ↔ HSL/HSV, all hand-derived, no libraries), a multi-stop
gradient editor that **interpolates in any of seven color spaces** with **per-segment easing**,
an **Oklch gamut-boundary visualizer** with **CSS Color 4 gamut mapping**, **ΔE color-difference
metrics (76 / 94 / CIEDE2000 / OK)**, **animated gradients** (hue-cycle / sweep / conic-spin), mesh
gradients rendered on a canvas, palette-harmony generation, WCAG + APCA contrast checking,
color-vision-deficiency simulation, and lossless export to CSS / SVG / PNG / JSON / shareable URL.

## Architecture (where things live)

- `src/color/types.ts` — the color & gradient data model (RGBA, OkLab, OkLCh, Lab, LCh, HSL, HSV,
  `Gradient`, `Stop`, `InterpSpace`, `HueMode`, plus `GamutMode` and per-stop `Easing`).
- `src/color/convert.ts` — every conversion, derived from first principles: sRGB transfer
  function, linear↔XYZ (D65) matrices, XYZ↔CIELab, Oklab (Ottosson) LMS pipeline, HSL/HSV, and
  hex/CSS parsing + formatting. `isOutOfGamut` flags off-screen colors.
- `src/color/difference.ts` — color-difference metrics from scratch: ΔE76 (Euclidean Lab), ΔE94
  (CIE94), **ΔE2000 (CIEDE2000** — full hue-rotation + blue-region term), and ΔE-OK (Euclidean
  Oklab). CIEDE2000 is verified against the Sharma–Wu–Dalal (2005) reference set.
- `src/color/gamut.ts` — `inGamut`, the **CSS Color 4 gamut-mapping** (`gamutMapOklch` — binary
  chroma reduction holding L/h until the clip is within a ΔE-OK JND), and the boundary tools the
  Gamut studio draws with (`maxChromaForLh`, `gamutSlice`, `cuspForHue`).
- `src/color/easing.ts` — per-segment easing: a real cubic-bézier solver (WebKit UnitBezier)
  backing the CSS keyword curves, plus smoothstep & step.
- `src/color/names.ts` — the 148 CSS named colors + `nearestNamedColor` (by ΔE2000).
- `src/color/animate.ts` — animated gradients: `hueRotated`/`frameAt` for live preview and
  `toKeyframesCss` (stepped hue-cycle, `background-position` sweep, `@property` conic spin).
- `src/color/interpolate.ts` — space-aware mixing with four hue-interpolation modes, gamut
  recovery (clip **or** map), per-segment easing in `sampleAt`, raw (pre-recovery) sampling +
  `outOfGamutFraction`, gradient sampling + ramp generation.
- `src/color/gradient.ts` — the gradient model → densified CSS (`linear`/`radial`/`conic`), SVG,
  and `ImageData`; bakes perceptual interpolation, easing and gamut-mapping into portable CSS.
- `src/color/harmony.ts` — palette harmonies (complementary, analogous, triadic, tetradic,
  split-complementary, monochromatic) via Oklch hue rotation.
- `src/color/contrast.ts` — relative luminance, WCAG 2.1 ratio + level, and an APCA-style Lc.
- `src/color/cvd.ts` — color-vision-deficiency simulation (Viénot–Brettel LMS projection, severity).
- `src/color/random.ts` — seeded RNG + a tasteful random-gradient generator (works in Oklch so it
  never produces mud).
- `src/color/extract.ts` — k-means (in Oklab) palette extraction from an uploaded image.
- `src/color/selftest.ts` — an in-app self-test suite (round-trips, known values, invariants).
- `src/state/store.ts` — gradient (de)serialization to the URL hash + a localStorage gallery.
- `src/ui/*` — the studio: gradient canvas + draggable stops, a from-scratch HSV color picker,
  the interpolation-space comparison strip, per-segment easing + gamut switch, export panel,
  the **Gamut** studio (`Gamut.tsx`), the **Animate** studio (`Animate.tsx`), mesh studio,
  palette studio, gallery, tests, about.

## Backlog / plan for this session

### Color-science engine (from scratch, no deps)
- [x] sRGB ↔ linear transfer function + linear↔XYZ (D65) matrices
- [x] XYZ ↔ CIELab ↔ LCh
- [x] Oklab ↔ Oklch (Ottosson LMS pipeline) and inverse
- [x] HSL & HSV conversions
- [x] hex (#rgb/#rrggbb/#rrggbbaa) + CSS string parse/format
- [x] Gamut clamping + out-of-gamut detection
- [x] Space-aware interpolation in srgb / linear / oklab / oklch / lab / lch / hsl
- [x] Four hue-interpolation modes (shorter / longer / increasing / decreasing)

### Gradient model + rendering
- [x] Multi-stop `Gradient` model: linear / radial / conic, angle, center, space, hue mode
- [x] Densified CSS export that bakes perceptual interpolation into a portable gradient
- [x] SVG export (linear + radial)
- [x] PNG export via canvas (with ordered dithering to kill banding)
- [x] Live preview with draggable, add/remove/recolor stops
- [x] Side-by-side "interpolation space" comparison strip

### Studios
- [x] Mesh-gradient studio — N draggable color points, inverse-distance blended on a canvas
- [x] Palette studio — harmonies from a base color + extract a palette from an image (k-means)
- [x] Random "muse" generator (seeded, tasteful)

### Color intelligence
- [x] WCAG 2.1 contrast ratio + AA/AAA badges between adjacent stops / against a bg
- [x] APCA-style lightness-contrast readout
- [x] Color-vision-deficiency preview (protan / deutan / tritan, severity slider)

### Persistence, sharing, UX
- [x] From-scratch HSV color picker (saturation/value square + hue + alpha + hex/oklch fields)
- [x] Hash-routed pages (`#/studio`, `#/mesh`, `#/palette`, `#/gallery`, `#/tests`, `#/about`)
- [x] Shareable `#g=` URL state + localStorage gallery with thumbnails
- [x] In-app self-test suite page (engine invariants, runnable live)
- [x] Keyboard + responsive layout, dark studio theme
- [x] Import a gradient by pasting CSS (`src/color/parseCss.ts`) — the inverse of export:
      parses linear/radial/conic, angle / "to side" / "from deg" / "at x% y%", and
      hex/rgb()/rgba()/hsl()/hsla()/oklch() stops with optional positions (12 self-tests)

### Perception & gamut (v3.0 — shipped this session)
- [x] Color-difference engine: ΔE76, ΔE94, **CIEDE2000**, ΔE-OK (verified vs Sharma et al. 2005)
- [x] **CSS Color 4 gamut mapping** (Oklch chroma reduction to a ΔE-OK JND) + clip/map switch
- [x] **Oklch gamut-boundary visualizer** — interactive L–C slice, sRGB boundary, stops plotted,
      clip-vs-map ramp comparison, out-of-gamut % of the interpolated gradient
- [x] **Per-segment easing** — real cubic-bézier curves (+ smoothstep/step), baked into export
- [x] **Animated gradients** — hue-cycle / sweep / conic-spin, live preview + `@keyframes` export
- [x] **Nearest CSS named color** (148 names, by ΔE2000) in the Gamut studio
- [x] Easing + gamut mode round-trip through the shareable URL (back-compatible with old links)

### Future ideas
- [ ] Custom cubic-bézier editor (drag the two control handles) for arbitrary easing
- [ ] Display-P3 / Rec.2020 gamuts in the visualizer (wide-gamut export via `color()`)
- [ ] A ΔE "color picker target" — nudge a stop until it's a set distance from another
- [ ] Per-frame PNG/APNG/WebM capture of an animated gradient
- [ ] Bezier-spline color paths through Oklab (Catmull–Rom across ≥3 stops)

## Session log

- 2026-06-21 (claude): **Gradient Lab 3.0 — "Perception & Gamut".** A big, coherent expansion in
  five from-scratch engine modules + two new studio pages, every piece headlessly verified.
  • **`difference.ts`** — ΔE76 / ΔE94 / **CIEDE2000** / ΔE-OK. The CIEDE2000 implementation
    (G-correction, hue rotation, T-weighting, blue-region interaction term Rt) is checked against
    the canonical **Sharma–Wu–Dalal (2005) 34-pair reference set to 1e-4** in the self-tests.
  • **`gamut.ts`** — `inGamut`, the **CSS Color 4 gamut-mapping algorithm** (binary chroma
    reduction in Oklch, holding L & h, accepting when the clipped result is within a ΔE-OK JND of
    0.02), and `maxChromaForLh` / `gamutSlice` / `cuspForHue` to draw the sRGB boundary.
  • **`easing.ts`** — a real WebKit-UnitBezier cubic-bézier solver backing the CSS keyword curves,
    plus smoothstep & step; threaded into `sampleAt` so each segment can re-time independently.
  • **`names.ts`** — the 148 CSS named colors + `nearestNamedColor` by ΔE2000.
  • **`animate.ts`** — hue-cycle (stepped, baked frames), sweep (`background-position`), and conic
    spin (`@property --angle`), with `frameAt` for the live preview and `toKeyframesCss` for export.
  • **Model + interpolation** — added `Stop.easing` and `Gradient.gamut`; refactored `mix` into
    `mixRaw` (pre-recovery) + gamut recovery (clip **or** map); added `rawSampleAt` /
    `outOfGamutFraction`; densify now bakes easing/gamut even in sRGB; serialization carries both
    fields back-compatibly (legacy links still decode to clip/linear).
  • **UI** — a new **Gamut** studio (the L–C slice canvas with the boundary curve, plotted stops,
    a clip/map toggle + ramp comparison, a ΔE matrix with a 76/94/2000/OK switch, and nearest-name
    readout), a new **Animate** studio (rAF live preview + copy-paste `@keyframes`), and Studio
    gained a per-segment easing dropdown + a clip/map gamut switch.
  Grew the self-test suite **38 → 67** (all green): the Sharma CIEDE2000 set, gamut-mapping
  invariants, the bézier/easing curves, animation, and a serialization round-trip for the new
  fields. `verify-project.mjs` (scope + conformance + lint + build) green.

- 2026-06-12 (claude): seeded the app — random gradient + copy, proves the build pipeline end to end.
- 2026-06-15 (claude): **Gradient Lab 2.0.** Rebuilt the seed into a full perceptual color &
  gradient studio. New from-scratch color engine (7 color spaces, all conversions hand-derived),
  multi-stop editor interpolating in any space with 4 hue modes, densified-CSS/SVG/PNG/JSON/URL
  export, a mesh-gradient canvas studio, palette harmonies + image k-means extraction, WCAG+APCA
  contrast, CVD simulation, a from-scratch HSV picker, hash routing, a localStorage gallery, and a
  live self-test suite. Verified: engine self-tests green, `verify-project.mjs` (lint + build) green.
- 2026-06-15 (claude): added **CSS gradient import** — paste any `linear/radial/conic-gradient(…)`
  and it becomes editable stops (the inverse of the densified-CSS export). New `parseCss.ts` with a
  paren-aware splitter + color parser; 12 new self-tests (38/38 total). Gate green.
