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
- `attractors3d.ts` — **the 3D flow engine (v7, expanded v8).** Fourteen continuous
  strange-attractor vector fields, an RK4 integrator (`integrateFlow`), and an
  **orbit camera** (`buildProjector`: auto-centre/scale cached by flow shape,
  yaw+pitch rotation, pinhole perspective) that projects the 3D orbit onto the 2D
  model plane so the existing renderers consume it unchanged. v8 extracted the
  reusable core — `makeProjector` (the pure pinhole closure) + `geometryFromPoints`
  (centre/scale of any point cloud) — so the spatial harmonograph shares the exact
  same camera. `sample3DPolyline` feeds the line/auto-fit path; `density.ts` calls
  `integrateFlow` + the projector directly for the depth-cued nebula. A full 2π of
  yaw is the identity, which is what makes the orbiting-camera loop seamless.
- `harmonograph3d.ts` — **the spatial-harmonograph engine (v8).** A 3D curve family:
  three axes, each the sum of two damped sinusoids, tracing a knotted 3-D Lissajous
  figure (an exact closed form, not a chaotic flow). Geometry cached by curve shape;
  projects through `attractors3d`'s shared orbit camera so it inherits line/density/
  SVG/GIF rendering, drag-to-orbit, Live spin, depth cue, stereo and seamless loops.
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
- `fourier.ts` — **the Fourier / epicycle engine (v9).** A from-scratch complex
  **Discrete Fourier Transform** that decomposes a closed shape into a chain of
  rotating vectors (*epicycles*). Ten built-in centred shapes (smooth parametric +
  arc-length-resampled sharp polygons), `dft` (O(N²), N = 512, memoised per
  shape), `reconstructAt` (the inverse DFT — sums the top-*K* amplitude terms, the
  optimal *K*-term L² approximation), and `chainAt` (the nested vector tips for the
  overlay). Shapes are mean-centred so a global phase shift is a rigid rotation
  (clean Live spin + seamless loop). Feeds the same point pipeline as every family.
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

Shipped in v6 (this session) — **density & growth: a histogram renderer, four
new chaotic maps, branching plants, seamless loops, and beat-reactive reseeding:**

- [x] **Density-field render style** (`density.ts`) — a per-layer switch (Color
      tab → *Render style*) that, instead of connecting the iterates into a
      polyline, **splats up to 4 million orbit points into a per-pixel histogram**
      and tone-maps it (log compression → gamma → palette LUT, alpha tracking
      brightness) into the luminous nebula attractors are famous for. Renders into
      a resolution-capped offscreen canvas, then blits + scales through the same
      blend / opacity / **kaleidoscope** stamping as a stroke. Exposure, tone
      (gamma) and a quality (point-budget) slider; live/animation frames use a
      reduced budget for smooth playback, and the **SVG export embeds the
      tone-mapped field as a base64 PNG `<image>`** so vector exports stay faithful.
- [x] **Four new strange-attractor maps** — **Hopalong** (Barry Martin),
      **Gumowski–Mira**, **Bedhead**, and **Tinkerbell**. Unlike the first four
      these are *not* bounded by construction, so they're framed by **robust
      percentile bounds** (`robustBounds`, drops the extreme 0.4% per side) that
      clip the few runaway iterates instead of letting one collapse auto-fit; the
      iterator carries a divergence guard that re-seeds rather than poisons a run.
      Per-map default constants + slider ranges, kind-aware randomize, and Live
      morphing all wired. (Net: 8 attractors.)
- [x] **Shared attractor iterator** (`iterateAttractor` / `stepAttractor`) so the
      density renderer can splat millions of iterates without ever materialising a
      giant point array, and `sampleAttractor` reuses it for the line/transform set.
- [x] **Branching L-systems** — a `[`/`]` push-pop **turtle stack** (`turtleFull`)
      turns the L-system family into real **plants & trees**: five new systems
      (Lindenmayer's fractal **Plant**, **Bush**, **Tree**, **Twig**, **Seaweed**),
      drawn skyward. This needed genuine **multi-stroke (pen-up) path support**: a
      `breaks[]` channel threaded `SampledCurve → buildLayerData → LayerData` and
      honoured by both the canvas renderer (moveTo at a break) and the SVG export
      (`M` at a break), with the metric pipeline treating a break as a
      discontinuity. (Net: 18 L-systems.)
- [x] **Seamless looping capture** — `loopLayer` oscillates every parameter by
      amp·sin(k·phase) with integer k (so phase 0 ≡ 2π exactly); with **Live** on,
      the GIF and WebM exporters sweep one full phase and emit a **flawless,
      seam-free loop** of the figure evolving, for every curve family — instead of
      the drawing pass.
- [x] **Beat-reactive reseeding** — the audio reactor gained spectral-flux **onset
      detection** on the bass band (adaptive threshold + refractory window);
      ticking *beat reseed* in audio mode re-rolls the whole piece on every beat.
- [x] **Six new presets** — *Hopalong Nebula*, *de Jong Dust*, *Tinkerbell Wing*,
      *Gumowski Shells* (density nebulae) and *Fractal Plant*, *Twin Trees*.
- [x] **"Generate" extended** to compose density-nebula attractor pieces.
- [x] **Self-tests extended** (`selftest.ts`) — the four unbounded maps stay finite
      & robustly framed across 800 param sets, and every branching plant is finite
      and genuinely multi-stroke (pen-up breaks present); the original
      bounds/growth-law checks still hold. Re-verified headlessly, plus a
      density-pipeline coverage check on the splat math.

### v7 — into the third dimension (3D strange attractors + orbit camera)

The big one. The whole studio was 2D: every source emitted a list of (x, y)
model points. v7 adds a genuinely **three-dimensional** curve family — continuous
**strange-attractor flows** dx/dt = f(x, y, z) — and a way to *see* them, without
the renderer ever learning it's looking at a 3D object. The trick is a single
projection step: an **orbit camera** turns the 3D orbit into the same 2D model
points the line / density / SVG / GIF pipeline already consumes. Drag the canvas
to rotate; turn on Live and it orbits; export a looping GIF and a full 2π camera
revolution is, by construction, a flawless seamless loop.

- [x] **`attractors3d.ts` — the 3D flow engine.** Nine canonical chaotic flows
      (Lorenz, Rössler, Aizawa, Thomas, Halvorsen, Chen, Dadras, Sprott–Linz F,
      Lorenz-84), each a hand-written vector field whose four sliders a/b/c/d reshape
      it (per-flow meaning; unexposed constants fixed at canonical values), traced by
      a **4th-order Runge–Kutta** integrator with a per-flow integration step (stiff
      Chen/Lorenz need a far smaller `dt` than gentle Thomas) and a divergence guard
      that re-seeds rather than poisoning the run.
- [x] **Off-axis seed.** Several flows (notably **Dadras**) keep `y=z=0` as an
      invariant manifold whose only orbit is a fixed point — a seed *on* it never
      reaches the attractor. Seeding off every axis-plane lands in the chaotic basin.
- [x] **Orbit camera.** The orbit is auto-centred and scaled into a unit ball
      (cached by flow shape, so a spinning camera never re-runs the geometry pass),
      rotated by **yaw + pitch**, and projected with a **pinhole perspective**
      (distance + field-of-view). A full 2π of yaw is the identity ⇒ seamless loops.
- [x] **Depth-cued volumetric density.** The density renderer gained a 3D path: it
      integrates the flow fresh for millions of RK4 steps and splats the *projected*
      points, accumulating a parallel **depth buffer** so each pixel is coloured by
      the average depth of the orbit there (near filaments one end of the palette,
      far the other) while brightness still tracks density — a real volumetric read
      of the 3D structure, not a flat histogram. Nearer points also splat brighter.
- [x] **Drag-to-orbit.** Pointer-drag across the canvas spins the selected 3D
      layer's camera (absolute from the gesture start, so no drift; pitch clamped).
- [x] **Live orbit + seamless looping capture.** `breatheLayer` advances yaw
      monotonically (and bobs pitch) so Live *orbits* the nebula; `loopLayer` sweeps
      yaw exactly 0→2π over the loop so the GIF/WebM exporter captures one flawless
      revolution.
- [x] **Full pipeline wiring** — new `attractor3d` `CurveKind` threaded through
      types, `curves.ts` (dispatch / sourceParams / breathe / loop / randomize), the
      Curve-tab editor (`CurveAttractor3D`: flow picker, per-flow a–d ranges, camera
      yaw/pitch/distance/FOV, auto-spin, depth-cue toggle), kind-switch defaults,
      duplicate, the **Generate** composer (3D nebulae), and three showcase presets
      (*Lorenz Butterfly*, *Aizawa Orb*, *Thomas Lattice*).
- [x] **Self-tests extended** (`selftest.ts`) — every flow integrates to a finite,
      non-degenerate 3D extent (the anti-collapse / anti-Dadras-trap tripwire),
      projects to a finite well-framed 2D polyline (auto-fit divides by that box),
      and its yaw is verified **2π-periodic** to round-off (the seamless-loop
      guarantee). Re-verified numerically out of band across all nine flows.

Future:

- [ ] Per-channel (RGB) density accumulation to colour by *which* basin a point
      came from, not just by density.
- [ ] Stochastic L-systems (per-rule probabilities) for naturalistic plant variety.
- [x] **3D harmonograph** (a spatial Lissajous / pendulum) flown through the same
      orbit camera, reusing the v7 projector. → **shipped in v8**
- [x] **Depth fog** for the 3D nebulae, to read depth even more strongly.
      → **shipped in v8** (exponential depth fog on both 3D families)
- [ ] A **ground-plane shadow** under the 3D nebulae (the other half of that idea).
- [x] **Scroll-wheel / pinch dolly** on the canvas to drive camera distance.
      → **shipped in v8**
- [ ] WebGL density accumulation for real-time million-point fields at 60fps
      (the CPU splatter already carries the 3D flows; a GPU path would lift the
      iteration ceiling by an order of magnitude).
- [x] A **stereographic / anaglyph** mode for the 3D scenes. → **shipped in v8**
      (red-cyan anaglyph + side-by-side / cross-eye pairs, live and in every export).

### v8 — depth made real (spatial harmonograph · stereoscopy · five new flows)

v7 lifted the studio into 3-space with strange-attractor flows and an orbit
camera. v8 makes that third dimension *land*: a brand-new 3D curve family, true
**stereoscopic** output you can view with red-cyan glasses, a turntable **dolly**,
volumetric **depth fog**, and **five more** canonical chaotic flows — all reusing
(and generalising) the v7 camera so they inherit drag-to-orbit, Live spin, the
depth cue, and the seamless looping export for free.

- [x] **3D harmonograph (`harmonograph3d.ts`)** — the spatial pendulum. Each of
      the three axes is driven by its own *pair* of damped sinusoids, so the pen
      traces a knotted 3-D Lissajous figure (an exact closed form, not a chaotic
      flow). It is sampled and flown through the **same orbit camera** as the
      flows, so the renderer never learns it's 3D — line, density, SVG, GIF, drag,
      Live, loop and stereo all work unchanged.
- [x] **Generalised orbit camera.** Extracted `makeProjector` + `geometryFromPoints`
      in `attractors3d.ts` so *any* 3D point set (an integrable flow **or** an
      explicit space curve) projects through the identical yaw/pitch/dist/fov
      pinhole. Geometry is cached by curve *shape* (not camera), so spinning costs
      only the cheap re-projection. Central `is3dKind` / `layerCamera` /
      `patchLayerCamera` helpers (`curves.ts`) let the app, renderer and density
      splatter treat "the 3D layer's camera" uniformly across both families.
- [x] **Stereoscopic 3D (`render.ts`).** Any scene with a 3D layer can render from
      two eye viewpoints (a small yaw offset per eye, sharing the auto-fit transform
      so the pair stays registered) and composite them: a colour **anaglyph**
      (left-eye red + right-eye cyan), or a half-width **side-by-side** / **cross-eye**
      pair. Works live and in every raster export; degrades gracefully to mono if the
      offscreen buffers can't be created (the sandbox).
- [x] **Scroll / pinch dolly + reset camera.** The canvas is now a turntable: drag
      orbits, the **scroll wheel** (exponential, so each notch feels equal) and a
      **two-finger pinch** drive camera distance, and a one-click **reset** restores
      the framing. All routed through `patchLayerCamera`, so they drive either 3D
      family.
- [x] **Exponential depth fog.** A per-layer **fog** control fades far filaments
      toward the void (`w·e^{-fog·k·(1−depth)}`) in the density renderer, giving the
      nebulae genuine front-to-back ordering — on both the flows and the spatial
      harmonograph.
- [x] **Five new strange-attractor flows** (9 → 14): **Sprott-B**, **Nosé–Hoover**
      (Sprott A thermostat), the **Rikitake** two-disk geodynamo, **Chen–Lee**
      (a rigid-body Euler top), and the mirror-symmetric **Burke–Shaw** double helix
      — each with canonical constants, a stable per-flow `dt`, per-flow slider ranges,
      and a one-line note. Numerically pre-validated (bounded, non-degenerate) before
      wiring.
- [x] **Full pipeline wiring** — new `harmonograph3d` `CurveKind` and the camera /
      stereo / fog fields threaded through `types.ts`, `curves.ts` (dispatch /
      sourceParams / breathe / loop / randomize / camera helpers), the Curve-tab
      editors (`CurveHarmonograph3D` + a shared `OrbitCameraControls` with the new
      fog + reset), kind-switch defaults, duplicate, the **Generate** composer (3D
      harmonographs, occasional auto-anaglyph), and **five new presets** — *Spatial
      Knot*, *Spatial Nebula*, *Lorenz in 3D (anaglyph)*, *Burke–Shaw Helix*,
      *Rikitake Dynamo*. Scene tab gained a **Stereoscopic 3D** panel (mode + eye
      separation).
- [x] **Self-tests extended** (`selftest.ts`) — the 3D-flow tripwire now covers all
      **14** flows, and a new **3D-harmonograph** check asserts 120 spatial figures
      project finite, well-framed, with valid normalised depth, and **2π-periodic**
      yaw (the seamless-loop guarantee). Re-verified headlessly, plus a render-path
      smoke test across every new preset × all four stereo modes (no throws).

### v9 — Fourier: any shape as a sum of rotating circles (the epicycle engine)

A harmonograph *is* a sum of sinusoids — so the studio has, all along, been one
half of the Fourier story (synthesis: pile up frequencies, watch the figure
emerge). v9 ships the **other half — analysis**. Hand it a closed shape (a
heart, a star, a square) and a from-scratch **Discrete Fourier Transform** breaks
it into a chain of rotating vectors (*epicycles*). Slide the **harmonics**
control and watch the celebrated **convergence** happen live: one circle draws an
off-centre ellipse, a handful rough out the silhouette, a few dozen snap the
sharp corners into focus — the **Gibbs phenomenon** ringing visibly around every
corner of the square and triangle. Press **Play** and the nested circles spin and
*draw the shape with their pen*, the most famous animation in mathematical art —
now flowing through the studio's whole colour / glow / kaleidoscope / Live /
GIF / WebM / SVG pipeline like every other curve family.

- [x] **`fourier.ts` — the DFT epicycle engine (from scratch).** A complex
      Discrete Fourier Transform (`dft`, O(N²), N = 512) turns a closed shape's
      512 complex samples into 512 **epicycles** — each a signed harmonic
      frequency `k`, an amplitude (circle radius) and a phase — sorted by
      amplitude so the first *K* are the provably-optimal *K*-term least-squares
      approximation. `reconstructAt(eps, K, u, δ)` sums the first *K* rotating
      vectors at draw-parameter `u∈[0,1)` (the inverse DFT); `chainAt` returns the
      nested vector-tip positions for the overlay (re-sorted by |k| for the
      classic nested look — the sum is order-independent). Shapes are **mean-
      centred** so a global phase offset `δ` is a clean rigid **rotation** (every
      coefficient times `e^{iδ}`), which is what lets Live spin the figure and the
      looping exporter return to itself byte-for-byte. Epicycle sets are memoised
      by shape id, so dragging the harmonics slider only re-slices a cached array.
- [x] **Ten built-in shapes**, each a centred closed loop resampled to 512 points:
      smooth parametric (`heart`, `infinity` lemniscate, `flower`, `gear`,
      `moth`, `blob`) and **sharp-cornered** polylines resampled by arc length
      (`square`, `triangle`, `star`, `pentagon`) — the corners are the whole
      point: they make Fourier convergence and Gibbs ringing impossible to miss.
- [x] **Wired the new `fourier` kind end-to-end** — `types.ts` (`FourierParams`),
      `curves.ts` (dispatch / `sourceParams` cache key / `breatheLayer` +
      `loopLayer` rotate via the global phase / `randomSourceFor` / `CURVE_KINDS`),
      `App.tsx` (kind-switch default, `updateFourier`, editor mount), and a new
      `CurveFourier` editor (shape picker, harmonics slider with a live "K of N"
      read-out, show-epicycles toggle).
- [x] **The epicycle overlay (`render.ts`).** When a Fourier layer has *show
      circles* on, the renderer draws the nested chain — faint circles, radial
      arms, a glowing pen dot — at draw-parameter `u = trace`, so it rides the
      existing **Play** pen-drawing animation for free: the circles orbit and
      trace the shape. Drawn once (never per kaleidoscope copy), guarded, and
      suppressed in PNG/SVG exports so art output stays clean.
- [x] **Self-tests (`selftest.ts`) — the DFT, proven.** Four new invariant checks
      across all ten shapes: (1) **inverse-DFT exactness** — `K = N`
      reconstruction reproduces the original samples to < 1e-9; (2) **monotone
      convergence** — mean-square error is non-increasing as harmonics are added
      (orthogonality of the basis), the mathematical heart of the convergence
      slider; (3) **finiteness** — every shape × every `K` yields finite, sanely
      bounded points; (4) **closed loop** — `u = 0` and `u = 1` coincide (the
      reconstruction is exactly 1-periodic).
- [x] **A Fourier showcase preset** + a Generate path that occasionally designs a
      Fourier piece, so the new family surfaces in the gallery and the dice.

## Session log

- 2026-06-23 (claude): **v9 — Fourier: any shape as a sum of rotating circles.**
  Shipped the eighth curve family and the studio's first *analysis* engine. New
  `fourier.ts`: a from-scratch complex **Discrete Fourier Transform** (O(N²),
  N = 512, memoised per shape) decomposes a closed shape into rotating
  **epicycles**, sorted by amplitude so the first *K* are the optimal *K*-term
  least-squares approximation — `reconstructAt` is the inverse transform and
  `chainAt` returns the nested vector tips for the overlay. Ten centred built-in
  shapes (smooth parametric `heart`/`infinity`/`flower`/`gear`/`moth`/`blob` +
  arc-length-resampled sharp `square`/`triangle`/`star`/`pentagon`, whose corners
  make Fourier convergence and **Gibbs ringing** vivid). Shapes are mean-centred,
  so a global phase offset is a rigid rotation — which is how Live spins the
  figure and the looping export returns to itself. Wired the new `fourier` kind
  end-to-end through `types.ts`, `curves.ts` (dispatch / cache key / breathe +
  loop / randomize / `CURVE_KINDS`), `App.tsx`, a new `CurveFourier` editor
  (shape picker, harmonics slider, show-circles toggle), two presets (`Fourier
  Heart`, `Fourier Square (Gibbs)`) and a Generate path. The **epicycle overlay**
  in `render.ts` draws the nested circles + arms + glowing pen at draw-parameter
  `u = trace`, so it rides the existing **Play** animation — the circles orbit and
  draw the shape — drawn once, guarded, suppressed in still exports. Four new
  self-tests prove the engine: inverse-DFT exactness (round-trip err **1.9e-13**),
  monotone MSE convergence, finiteness, and a closed loop. Verified: the Fourier
  engine tested headlessly (all pass, exact), a render smoke test drew **all 42
  presets × 3 trace states (126) with no throw**, and the full CI gate (scope +
  conformance + lint + build) is green.
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
- 2026-06-21 (claude): **v6 — density & growth.** Built a **density-field renderer**
  (`density.ts`): a per-layer render style that splats up to 4M attractor iterates
  into a per-pixel histogram and tone-maps it (log → gamma → palette LUT) into a
  luminous nebula, blitted through the existing blend/opacity/kaleidoscope path and
  embedded as a PNG `<image>` in SVG export. Added **four new chaotic maps**
  (Hopalong, Gumowski–Mira, Bedhead, Tinkerbell) — the first attractors that aren't
  bounded by construction — framed by **robust percentile bounds** that clip
  outliers, with a shared `iterateAttractor`/`stepAttractor` core (8 maps total).
  Turned the L-system family into **branching plants & trees** via a `[`/`]` turtle
  stack and real **multi-stroke (pen-up) path support** (`breaks[]` threaded through
  the data + canvas + SVG renderers); 5 new plant systems (18 total). Added
  **seamless looping GIF/WebM capture** of the Live evolution (`loopLayer`,
  amp·sin(k·phase) so phase 0 ≡ 2π), **beat-reactive reseeding** (spectral-flux
  onset detection in `audio.ts`), six new presets, density-aware Generate, and
  extended self-tests (unbounded maps finite & framed; plants finite & multi-stroke).
  Verified: self-tests pass headlessly, a density-splat coverage check passes, and
  the full CI gate (scope + conformance + lint + build) is green.
- 2026-06-21 (claude): **v7 — into the third dimension.** Added a genuinely 3D
  curve family: nine continuous **strange-attractor flows** (Lorenz, Rössler,
  Aizawa, Thomas, Halvorsen, Chen, Dadras, Sprott–Linz F, Lorenz-84) in a new
  `attractors3d.ts` — hand-written vector fields traced by a 4th-order **Runge–Kutta**
  integrator (per-flow `dt`; divergence-guarded; off-axis seed so the Dadras
  fixed-point trap is avoided) and flown through a from-scratch **orbit camera**
  (auto-centre/scale cached by flow shape, yaw+pitch, pinhole perspective) that
  projects the 3D orbit onto the 2D model plane — so the *entire* existing line /
  density / SVG / GIF pipeline renders it unchanged. The density renderer gained a
  **depth-cued volumetric path**: it integrates the flow fresh for millions of RK4
  steps, splats the projected points, and accumulates a parallel depth buffer so
  each pixel is coloured by average depth (near vs far ends of the palette) while
  brightness tracks density. Added **drag-to-orbit** on the canvas, **Live** camera
  orbiting, and — because a full 2π yaw turn is the identity — a **flawless seamless
  looping** GIF/WebM of one revolution. Wired the new `attractor3d` kind through
  types / `curves.ts` (dispatch, breathe, loop, randomize) / a Curve-tab editor
  (`CurveAttractor3D`) / Generate / three showcase presets, and extended the
  self-tests (every flow finite, non-degenerate, well-framed, and yaw 2π-periodic).
  Verified: all nine flows checked numerically out of band; full CI gate (scope +
  conformance + lint + build) is green.
- 2026-06-22 (claude): **v8 — depth made real.** Built on v7's orbit camera with a
  whole new 3D curve family and true stereoscopy. **3D harmonograph**
  (`harmonograph3d.ts`): three axes, each two damped pendulums, tracing a knotted
  spatial Lissajous figure — an exact closed form flown through a **generalised**
  orbit camera (extracted `makeProjector` + `geometryFromPoints` so any 3D point
  cloud or flow projects identically; geometry cached by shape, not camera).
  **Stereoscopic 3D** in `render.ts`: render both eyes (yaw-offset, shared
  transform) and composite as a red-cyan **anaglyph** or a half-width
  **side-by-side / cross-eye** pair — live and in every raster export, sandbox-safe.
  Added a turntable **scroll/pinch dolly** + **reset camera**, exponential
  **depth fog** for the nebulae, and **five new flows** (Sprott-B, Nosé–Hoover,
  Rikitake dynamo, Chen–Lee, Burke–Shaw, 9 → 14). Central `is3dKind` /
  `layerCamera` / `patchLayerCamera` helpers unify the two 3D families across the
  app, renderer and density splatter. Wired the new kind + camera/stereo/fog fields
  through types / `curves.ts` / Curve-tab editors (`CurveHarmonograph3D` + shared
  `OrbitCameraControls`) / kind-switch / duplicate / Generate / Scene-tab stereo
  panel, plus five new presets. Self-tests now cover all 14 flows and 120 spatial
  harmonograph figures (finite, well-framed, depth-valid, 2π-periodic). Verified:
  self-tests pass headlessly, a render-path smoke test runs every new preset × all
  four stereo modes with no throws, and the full CI gate (scope + conformance +
  lint + build) is green.
