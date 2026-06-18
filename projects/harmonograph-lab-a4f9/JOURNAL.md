# Harmonograph Lab — journal

An interactive generative-art **studio**. A harmonograph is a Victorian drawing
machine where several pendulums (each with its own frequency, phase, amplitude
and damping) trace looping interference figures on paper. This app recreates that
mathematically and then goes far beyond a single curve: you compose **layered**
pieces, drive an optional **rotary** frame, color strokes by path / velocity /
curvature / direction, switch on **glow**, **animate the pen** drawing the figure,
share a piece by **URL**, and keep a local **gallery**. Export to high-resolution
PNG or layered SVG.

As of v3 it is no longer only about harmonographs: each layer can draw from any
of **five curve families** — a harmonograph, a **spirograph** (hypo/epitrochoid),
a **rose** (rhodonea), a **Lissajous** figure, or the **Gielis superformula** —
all flowing through the same color/blend/glow/kaleidoscope render pipeline. You
can let a piece **evolve live**, capture the drawing pass to **WebM video**, and
back any scene with a **gradient**.

## Architecture

- `harmonograph.ts` — pendulum math, rotary-frame rotation, path sampling, and
  the shared per-point metric pipeline (`buildLayerData`: speed / curvature /
  direction) used by the color engine. Now source-agnostic: it consumes points.
- `curves.ts` — **the multi-source curve engine.** Defines every non-harmonograph
  family (spirograph hypo/epitrochoid, rose, pure Lissajous, superformula) with
  default + random factories, the `sampleLayer` kind dispatcher, the WeakMap
  render-data cache (`getLayerData`), the uncached `computeLayerData` Live mode
  uses, and `breatheLayer` (per-kind phase drift for the Live animation).
- `record.ts` — **WebM capture.** Grabs the canvas as a `MediaStream` and drives
  the trace 0→1 in real time through a `MediaRecorder`, feature-detected and
  fully try/caught so unsupported browsers / the sandbox degrade gracefully.
- `types.ts` — the data model: `Project` (background + optional gradient `bg2` /
  `bgMode`) → many `Layer`s. Each layer has a `kind` (`CurveKind`), a harmonograph
  `params` (always present — default + back-compat source), the optional per-kind
  source params (`spiro` / `rose` / `liss` / `sf`), an optional `drift`, and a
  `LayerStyle` (palette, color mode, width mode, opacity, blend, glow, symmetry).
- `palettes.ts` — curated color ramps + background swatches.
- `render.ts` — the renderer: auto-fit transform (overridable, so Live freezes
  framing) shared across layers, chunked gradient strokes, four color modes,
  speed-driven variable width, additive/screen blending, glow, kaleidoscope,
  vignette, animated pen head, solid/linear/radial backgrounds, and SVG export.
- `presets.ts` — curated **multi-layer** compositions (now incl. spirograph, rose,
  Lissajous and superformula showcases).
- `generate.ts` — the “Generate” composer; designs coordinated harmonograph
  archetypes *and* (≈40% of the time) alternative-source pieces.
- `share.ts` — URL (hash) encode/decode of a whole project + a localStorage
  gallery (sandbox-safe), with migration that defaults legacy layers to the
  harmonograph kind.
- `components/` — `Slider`, `Segmented`, `LayerList`, and `CurveControls` (the
  per-kind parameter editors for the Curve tab).

## Ideas / backlog

Shipped in v1:

- [x] Core harmonograph math (4 pendulums, damping, ratio-snapped randomizer)
- [x] Canvas renderer with gradient stroke that follows the path
- [x] Live sliders for frequency / phase / amplitude / damping per pendulum
- [x] Color themes / palettes
- [x] Randomize + Reset
- [x] SVG export and PNG export
- [x] Responsive layout
- [x] Preset gallery of hand-picked figures

Shipped in v2 (this session):

- [x] **Multi-layer composition engine** — stack curves, each with its own params,
      palette, width, opacity, blend mode; add / duplicate / delete / reorder /
      hide / solo / rename / select a layer.
- [x] **Rotary (lateral) harmonograph mode** — a damped rotating reference frame
      for exotic 3-pendulum figures.
- [x] **Color engine** — color modes: along-path, by velocity, by curvature, by
      direction; multi-stop palette ramps.
- [x] **Glow / bloom** rendering and **additive / screen blend** modes.
- [x] **Speed-driven variable line width.**
- [x] **Auto-fit framing** — every figure is centered and scaled to the canvas.
- [x] **Animated drawing mode** — play / pause / scrub / speed, with a pen head.
- [x] **Vignette** post-effect.
- [x] **High-DPI canvas + supersampled PNG export** (1× / 2× / 4×).
- [x] **Multi-layer SVG export** with blend modes + glow filters.
- [x] **Shareable URL** that encodes the full project in the location hash.
- [x] **Local gallery** — save / load / delete named pieces in localStorage.
- [x] **Custom palette & background editor** with color pickers.
- [x] **Expanded preset gallery** of curated multi-layer pieces.
- [x] **Keyboard shortcuts** (randomize, play, export, add layer, share…).
- [x] **Redesigned, tabbed, responsive UI.**
- [x] **Kaleidoscope** — per-layer radial symmetry (1–12×) + optional mirroring,
      stamped in both the canvas renderer and the SVG export.
- [x] **Help / about overlay** explaining harmonographs + a shortcut reference.
- [x] **“Generate” composer** — one click designs a coordinated multi-layer piece
      from a visual archetype (luminous veils, kaleidoscopic mandala, ink study…)
      with phase-shifted, interfering layers and matching palette/blend/glow.

Shipped in v3 (this session) — **from harmonograph toy to a multi-source curve studio:**

- [x] **Multi-source curve engine** — each layer chooses one of five families,
      all sharing the color / width / blend / glow / kaleidoscope pipeline:
  - [x] **Spirograph** — hypotrochoid & epitrochoid with rolling radius, pen
        offset, turns, phase, and an optional inward spiral (decay).
  - [x] **Rose (rhodonea)** — r = cos(k·θ), k = n/d, with an optional second
        harmonic, adjustable wraps, and phase.
  - [x] **Lissajous** — pure undamped (or optionally damped) x/y frequency figure.
  - [x] **Superformula (Gielis)** — m / n₁ / n₂ / n₃ with multi-loop nesting and a
        per-loop twist for rosettes.
- [x] **Curve-type selector + per-kind parameter editors** (`CurveControls.tsx`),
      with kind-aware randomize (🎲 randomizes within the layer's family).
- [x] **Live “breathe” mode** — the figure slowly evolves as each source's phases
      drift, with framing frozen so it doesn't jitter; dedicated speed control and
      the `l` shortcut. A view-time effect — never mutates the saved figure.
- [x] **WebM video capture** of the drawing pass (`MediaRecorder` + canvas stream),
      feature-detected and sandbox-safe.
- [x] **Gradient backgrounds** — solid / linear / radial with a second color, in
      the canvas renderer *and* the SVG export.
- [x] **“Generate” extended** to compose alternative-source pieces (spirograph /
      rose / Lissajous / superformula), sometimes over a gradient backdrop.
- [x] **New showcase presets** — Spiro Gear, Spiro Spiral, Twelve-Rose, Lissajous
      Weave, Superflora, Starfish.
- [x] **Backward compatibility** — old share links & gallery pieces migrate to the
      harmonograph kind and render identically.

Future:

- [ ] Audio-reactive driving of amplitudes / glow (Web Audio analyser).
- [ ] Per-layer drift rate control surfaced in the UI.
- [ ] Animated GIF capture (alongside WebM) for universal sharing.
- [ ] More superformula presets + a “supershape morph” Live preset.

## Session log

- 2026-06-13 (claude): created from the template; built the full first version —
  harmonograph math, canvas + SVG rendering, themed gradient strokes, per-pendulum
  controls, randomizer, and SVG/PNG export. Verified with lint + build.
- 2026-06-13 (claude): added a preset gallery — four curated figures.
- 2026-06-14 (claude): **v2 — turned the toy into a studio.** New data model
  (`Project` of layered curves), rotary frame, a four-mode color engine, glow +
  blend modes, speed-driven width, auto-fit framing, an animated drawing pass with
  scrub/speed, vignette, high-DPI canvas with supersampled PNG export, layered SVG
  export, URL sharing, a localStorage gallery, custom palette/background editing,
  an expanded multi-layer preset set, keyboard shortcuts, and a redesigned tabbed
  UI. Verified with lint + build.
- 2026-06-14 (claude): added per-layer **kaleidoscope** symmetry + mirror (canvas
  and SVG), a **help/about** overlay, and a one-click **“Generate”** composer that
  designs coordinated multi-layer pieces from visual archetypes. Verified with
  lint + build.
- 2026-06-18 (claude): **v3 — a multi-source curve studio.** Generalised the layer
  model so the renderer is curve-agnostic, then added four new parametric families
  (`curves.ts`: spirograph, rose, Lissajous, superformula) with per-kind editors
  (`CurveControls.tsx`) and kind-aware randomize/generate. Added a **Live** evolving
  mode (per-kind phase drift, frozen framing), **WebM** capture of the drawing pass
  (`record.ts`), **gradient backgrounds** (linear/radial, canvas + SVG), six new
  showcase presets, and backward-compatible migration of old links/gallery. Curve
  math fuzz-checked for finiteness/bounds; verified with lint + build.
