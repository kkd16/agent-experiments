# Harmonograph Lab — journal

An interactive generative-art **studio**. A harmonograph is a Victorian drawing
machine where several pendulums (each with its own frequency, phase, amplitude
and damping) trace looping interference figures on paper. This app recreates that
mathematically and then goes far beyond a single curve: you compose **layered**
pieces, drive an optional **rotary** frame, color strokes by path / velocity /
curvature / direction, switch on **glow**, **animate the pen** drawing the figure,
share a piece by **URL**, and keep a local **gallery**. Export to high-resolution
PNG or layered SVG.

As of v4 it is no longer only about harmonographs: each layer can draw from any
of **six curve families** — a harmonograph, a **spirograph** (hypo/epitrochoid),
a **rose** (rhodonea), a **Lissajous** figure, the **Gielis superformula**, or a
chaotic **strange attractor** (de Jong / Clifford / Svensson) — all flowing
through the same color/blend/glow/kaleidoscope render pipeline. You can let a
piece **evolve live** (per-layer drift), **pulse it to your microphone**, capture
the drawing pass to a universal **animated GIF** or **WebM video**, and back any
scene with a **gradient**.

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
- `gif.ts` — **a from-scratch animated-GIF89a encoder.** Median-cut color
  quantization to a shared 256-entry palette, a 15-bit nearest-color cache,
  variable-width **LZW** compression (with the standard code-size growth + 4096
  table reset, packed LSB-first), GCE/image-descriptor framing and a
  NETSCAPE2.0 loop block. `recordGif` renders the drawing pass into an offscreen
  canvas frame by frame and `assembleGif` (pure, DOM-free, unit-tested) emits the
  bytes. Universal: plays anywhere WebM/`captureStream` can't.
- `audio.ts` — **Web Audio reactor.** Taps the mic through an `AnalyserNode` and
  exposes a smoothed overall `level` + low-frequency `bass`, used to pulse glow
  and stroke width. Feature-detected, permission-guarded and fully try/caught so
  it no-ops (rather than throws) when unavailable or sandboxed.
- `lsystem.ts` — **the L-system fractal engine** (seventh curve family). A
  catalog of 13 classic *single-stroke* Lindenmayer systems (Heighway dragon,
  Koch curve + snowflake, quadratic Koch, Lévy C, terdragon, Hilbert, Moore,
  Peano, Gosper flowsnake, Sierpinski arrowhead + triangle, McWorter pentigree),
  a string-rewriting `expandLSystem` (memoised by system+iterations), and a
  `turtle` interpreter that walks the string into one connected polyline. The
  expansion is angle-independent, so Live can sweep the fold angle every frame and
  re-run only the cheap turtle pass — the fractal morphs in real time. `maxIter`
  per system is capped so the full curve always renders (never truncated).
- `selftest.ts` — **dev-time invariant checks** for the curve engine: every
  strange attractor stays finite & bounded for *any* slider value (2 400 random
  param sets), and every L-system yields a finite polyline whose segment count
  matches its exact growth law where one exists (dragon 2ⁿ, Koch 4ⁿ, snowflake
  3·4ⁿ, terdragon 3ⁿ, …). Runs once in dev (logged), exposed on
  `window.__harmonographSelfTest`, tree-shaken from production.
- `components/` — `Slider`, `Segmented`, `LayerList`, and `CurveControls` (the
  per-kind parameter editors for the Curve tab, incl. the strange-attractor map
  selector + a/b/c/d constants and the L-system rule-set / iterations / fold-angle
  editor).

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

Shipped in v4 (this session) — **chaos, universal capture, and sound:**

- [x] **Strange-attractor curve family** (6th source) — three chaotic iterated
      maps (**de Jong**, **Clifford**, **Svensson**) feeding the same color /
      blend / glow / kaleidoscope / Live pipeline. Each is written to stay
      bounded for *every* constant, so framing never blows up and Live can morph
      the constants freely. A map selector + a/b/c/d editors live in the Curve
      tab, with kind-aware randomize and a Live "breathe" that oscillates two
      constants so the web reshapes and returns instead of wandering off.
- [x] **Universal animated-GIF export** — a dependency-free **GIF89a encoder**
      (`gif.ts`): median-cut quantization, nearest-color cache, variable-width
      **LZW**, looping NETSCAPE2.0 block. Captures the drawing pass and plays in
      every viewer (where WebM/`captureStream` can't). The LZW round-trip and the
      full container were both verified against a from-scratch decoder.
- [x] **Audio-reactive mode** (`audio.ts`) — the microphone's envelope pulses
      glow and stroke width in real time (frozen framing, like Live), with a
      sensitivity control. Feature-detected, permission-guarded, sandbox-safe;
      releases the mic on stop / unmount / before recording.
- [x] **Per-layer drift-rate control** surfaced in the Curve tab, so Live evolves
      each layer at its own pace (they drift out of, and back into, phase).
- [x] **New presets** — *de Jong Web*, *Clifford Drift*, *Svensson Bloom*, and a
      *Supershape Morph* tuned to be watched evolving in Live.
- [x] **"Generate" extended** to compose attractor pieces (hairline, solo).
- [x] Shortcuts: **A** audio-reactive, **I** export GIF; help overlay updated.

Shipped in v5 (this session) — **fractals: an L-system curve family + verified bounds:**

- [x] **L-system fractal family** (`lsystem.ts`) — a seventh curve source wired
      through the whole pipeline (sample / dispatch / breathe / randomize /
      generate / preset / share-migrate). 13 classic single-stroke systems: the
      Heighway **dragon**, **Koch** curve & **snowflake**, quadratic Koch, **Lévy
      C**, **terdragon**, **Hilbert** & **Moore** space-fillers, **Peano**,
      **Gosper** flowsnake, **Sierpinski** arrowhead & triangle, and McWorter's
      **pentigree** — each colourable / glowing / kaleidoscopic like everything else.
- [x] **Live fold-angle morphing** — because the rewritten string is
      angle-independent, Live sweeps each L-system's turn angle every frame
      (re-running only the O(n) turtle), so a dragon unfolds and a Hilbert curve
      ripples in real time. Expansion is memoised by system+iterations.
- [x] **Curve-tab L-system editor** — rule-set selector (resets depth + angle to
      that fractal's canonical values), iterations, and a degree-readout fold-angle
      slider, with a per-system explainer.
- [x] **New strange attractor — "Dream"** (Clifford Pickover's Fractal Dream),
      pure-trig so it's provably bounded; added to the map selector, randomizer and
      generator.
- [x] **Numerical self-tests** (`selftest.ts`) — attractor finiteness/bounds over
      2 400 random parameter sets and L-system finiteness + exact segment-count
      growth laws, run in dev and exposed for headless checks. Independently
      re-verified here: all 13 L-systems finite with correct counts, and all four
      attractors bounded (max |coord| = 4.0) across 80 000 random param sets.
- [x] **Six new presets** — *Fractal Dream*, *Dragon Fold*, *Hilbert Weave*,
      *Gosper Snow*, *Koch Crown*, and a kaleidoscopic *Arrowhead Mandala*.
- [x] **"Generate" extended** to compose L-system pieces (solo, path/angle colour).

Future:

- [ ] Animated-GIF capture of the Live evolution (not just the drawing pass).
- [ ] Attractor point-density shading (accumulate a heatmap instead of a polyline).
- [ ] More attractor families (Hopalong / Bedhead — need a robust auto-fit that
      ignores outliers, since those maps aren't bounded by construction).
- [ ] Branching L-systems (plants/trees) — needs multi-segment (pen-up) path support.
- [ ] Beat detection so audio mode can also re-seed / randomize on transients.

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
- 2026-06-19 (claude): **v4 — chaos, universal capture, sound.** Added a sixth
  curve family, **strange attractors** (de Jong / Clifford / Svensson) wired through
  the whole pipeline (sample/dispatch/breathe/randomize/generate + a Curve-tab map
  selector and a/b/c/d editors); the maps are written to stay bounded for any
  constant. Wrote a **from-scratch animated-GIF89a encoder** (`gif.ts`: median-cut
  quantization, LZW, looping block) and a universal **Export GIF** action — its LZW
  round-trip and full container were verified end-to-end against a hand-written
  decoder, and the attractor bounds/finiteness were checked across 2000 random
  parameter sets. Added an **audio-reactive** mode (`audio.ts`, Web Audio analyser →
  glow/width pulse, sandbox-safe), surfaced the **per-layer drift rate**, four new
  presets, and **A**/**I** shortcuts. Verified with the full CI gate (scope +
  conformance + lint + build).
- 2026-06-20 (claude): **v5 — fractals.** Added an **L-system fractal curve
  family** (`lsystem.ts`): 13 classic single-stroke systems (dragon, Koch +
  snowflake, quadratic Koch, Lévy C, terdragon, Hilbert, Moore, Peano, Gosper,
  Sierpinski arrowhead + triangle, pentigree) with a memoised string-rewriter and a
  turtle interpreter, wired end-to-end (types, dispatch, Curve-tab editor,
  randomize, generate, presets, share migration). The expansion is
  angle-independent, so **Live sweeps the fold angle** every frame (cheap turtle
  re-run) and the fractal morphs — a dragon unfolds, a Hilbert curve ripples. Also
  added a fourth, provably-bounded strange attractor (**Fractal Dream**), six new
  presets, and a **numerical self-test module** (`selftest.ts`, dev-only) asserting
  attractor bounds and exact L-system segment-count growth laws. Validated the
  L-system catalog (segment counts, finiteness, spans) and attractor boundedness
  (max |coord| = 4.0 over 80 000 random param sets) out of band, then passed the
  full CI gate (scope + conformance + lint + build).
