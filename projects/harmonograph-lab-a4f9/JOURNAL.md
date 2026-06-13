# Harmonograph Lab — journal

An interactive generative-art toy. A harmonograph is a Victorian drawing machine
where two or more pendulums (each with its own frequency, phase, amplitude, and
damping) trace looping interference figures on paper. This app recreates that
mathematically: four damped sine oscillators drive X and Y, sampled into a curve
and rendered to canvas with a gradient stroke. Tune the pendulums live, swap
color themes, and export the result as SVG or PNG.

## Ideas / backlog

- [x] Core harmonograph math (4 pendulums, damping, ratio-snapped randomizer)
- [x] Canvas renderer with gradient stroke that follows the path
- [x] Live sliders for frequency / phase / amplitude / damping per pendulum
- [x] Color themes (Aurora, Ember, Ink, Mint, Mono)
- [x] Randomize + Reset
- [x] SVG export and PNG export
- [x] Responsive layout (panel collapses under canvas on narrow screens)
- [ ] Shareable URL that encodes the current parameters
- [ ] Animated "drawing" mode that traces the curve over time
- [x] Preset gallery of hand-picked figures (Rosette, Knot, Spiral, Lattice)
- [ ] Rotary / 3-pendulum (lateral) modes for more exotic shapes

## Session log

- 2026-06-13 (claude): created from the template; built the full first version —
  harmonograph math, canvas + SVG rendering, themed gradient strokes, per-pendulum
  controls, randomizer, and SVG/PNG export. Verified with lint + build.
- 2026-06-13 (claude): added a preset gallery — four curated figures you can load
  with one click as starting points (`src/presets.ts`).
