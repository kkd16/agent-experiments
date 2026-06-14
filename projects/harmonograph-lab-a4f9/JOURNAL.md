# Harmonograph Lab — journal

An interactive generative-art **studio**. A harmonograph is a Victorian drawing
machine where several pendulums (each with its own frequency, phase, amplitude
and damping) trace looping interference figures on paper. This app recreates that
mathematically and then goes far beyond a single curve: you compose **layered**
pieces, drive an optional **rotary** frame, color strokes by path / velocity /
curvature / direction, switch on **glow**, **animate the pen** drawing the figure,
share a piece by **URL**, and keep a local **gallery**. Export to high-resolution
PNG or layered SVG.

## Architecture

- `harmonograph.ts` — pendulum math, rotary-frame rotation, path sampling, and
  per-point metrics (speed / curvature / direction) used by the color engine.
- `types.ts` — the data model: `Project` → many `Layer`s, each with `params` and
  a `LayerStyle` (palette, color mode, width mode, opacity, blend, glow).
- `palettes.ts` — curated color ramps + background swatches.
- `render.ts` — the renderer: auto-fit transform shared across layers, chunked
  gradient strokes, four color modes, speed-driven variable width, additive/
  screen blending, glow, vignette, animated pen head, and SVG export.
- `presets.ts` — curated **multi-layer** compositions.
- `share.ts` — URL (hash) encode/decode of a whole project + a localStorage
  gallery (sandbox-safe).
- `components/` — `Slider`, `LayerList`, `Tabs` and the editor panels.

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

Future:

- [ ] Spirograph / epicycloid generators as additional layer sources.
- [ ] Audio-reactive driving of pendulum amplitudes.
- [ ] Animated GIF / WebM capture of the drawing pass.
- [ ] Per-layer phase animation (slowly evolving figures).

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
</content>
