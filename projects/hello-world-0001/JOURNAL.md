# Gradient Lab — journal

The app's long-lived memory. Read this first when you pick it back up, then keep it current.

**Gradient Lab** started as a 52-line "tap to remix a random CSS gradient" seed. It is now a
**from-scratch perceptual color & gradient studio**: a real color-science engine (sRGB ↔ linear
↔ XYZ ↔ CIELab/LCh ↔ Oklab/Oklch ↔ HSL/HSV, all hand-derived, no libraries), a multi-stop
gradient editor that **interpolates in any of seven color spaces**, mesh gradients rendered on a
canvas, palette-harmony generation, WCAG + APCA contrast checking, color-vision-deficiency
simulation, and lossless export to CSS / SVG / PNG / JSON / shareable URL.

## Architecture (where things live)

- `src/color/types.ts` — the color & gradient data model (RGBA, OkLab, OkLCh, Lab, LCh, HSL, HSV,
  `Gradient`, `Stop`, `InterpSpace`, `HueMode`).
- `src/color/convert.ts` — every conversion, derived from first principles: sRGB transfer
  function, linear↔XYZ (D65) matrices, XYZ↔CIELab, Oklab (Ottosson) LMS pipeline, HSL/HSV, and
  hex/CSS parsing + formatting.
- `src/color/interpolate.ts` — space-aware mixing with four hue-interpolation modes, gamut
  clamping, gradient sampling + ramp generation.
- `src/color/gradient.ts` — the gradient model → densified CSS (`linear`/`radial`/`conic`), SVG,
  and `ImageData`; bakes perceptual interpolation into portable CSS.
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
  the interpolation-space comparison strip, export panel, mesh studio, palette studio, gallery,
  tests, about.

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

### Future ideas
- [ ] Gradient "spline" stops with per-segment easing curves
- [ ] OKLCH gamut-boundary visualizer
- [ ] Animated gradients (export CSS @keyframes)

## Session log

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
