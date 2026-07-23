# Fathom — journal

A GPU deep-zoom explorer for the Mandelbrot and Julia sets. The whole point is
**depth**. WebGL only promises 32-bit floats, so a naive shader dissolves into
blocky pixels around a zoom of ~1e4. Fathom fights that on two fronts:

1. **df64 (emulated double precision)** — every coordinate is a `vec2(hi, lo)`
   "double-single" pair (~48-bit mantissa), pushing the crisp-zoom limit to
   roughly **1e13** entirely on the GPU.
2. **Perturbation theory** — past ~1e9 Fathom switches engines. A single
   high-precision reference orbit (computed in BigInt arbitrary precision on the
   CPU) lets the GPU iterate only a tiny per-pixel *delta* in plain float32, with
   Zhuoran rebasing to stay glitch-free. This lifts the floor to **~1e28+**, far
   past what any per-pixel float scheme can reach, because the deep digits live
   in how the reference was derived, not in the shader's floats.

## Architecture

### The deep-zoom core (session 2)

- `src/fractal/hp.ts` — **high-precision reals** as fixed-point BigInt values
  scaled by 2^224 (~67 decimal digits). A plain JS `number` caps zoom at ~1e-13
  no matter how clever the shader is; the view centre needs far more digits than
  that. Exact `fromNumber`/`toNumber`, decimal `fromString`/`toString` (with
  scientific-notation support for URLs), exact `addNumber`, and fixed-point
  `mul`. Validated by round-trip + deep-arithmetic tests.
- `src/fractal/refOrbit.ts` — iterates the Mandelbrot **reference orbit** `Z_n`
  from an HP centre in BigInt fixed-point, storing each `Z_n` as float32 for the
  GPU. ~2–5 ms for a few-thousand-iteration orbit, so it recomputes in real time.
- `src/webgl/shaders.ts` — now carries **two** fragment shaders sharing colour
  code: the df64 direct engine (`FRAG_SRC`) and the perturbation engine
  (`FRAG_PERTURB_SRC`). The perturbation shader reads `Z_n` from an RG32F texture
  (`texelFetch`), iterates `δz_{n+1} = 2·Z_n·δz_n + δz_n² + δc` in float32, and
  **rebases** whenever `|z| < |δz|` or the reference runs out — one orbit, no
  glitch hunting. Both shaders support optional **distance-estimation** shading
  (outline the filaments via `|z|·ln|z| / |dz/dc|`).
- `src/webgl/renderer.ts` — holds both programs and the orbit texture; picks the
  engine per frame. The perturbation program is a best-effort upgrade: if it
  fails to compile on a driver, `perturbationAvailable` stays false and Fathom
  clamps zoom to the df64 floor.
- `src/fractal/share.ts` — encodes the whole view (including a 40-digit centre)
  into the URL hash for shareable deep links, and decodes it back.

### The rest

- `src/fractal/useFractalEngine.ts` — the React hook: HP viewport, pointer +
  wheel + **pinch** interaction, auto-engagement of perturbation past the depth
  threshold, orbit lifecycle (recompute only when its inputs change), a
  **cinematic fly-in** to Mandelbrot bookmarks, colour cycling, PNG export, URL
  sync, and HUD state.
- `src/webgl/palettes.ts` — cosine (Inigo Quilez) and gradient-stop palettes,
  baked into a 1-D RGBA texture; CSS-gradient helper for the UI swatches.
- `src/fractal/bookmarks.ts` — curated locations, now including a **perturbation
  dive series** at the seahorse point down to a 5e-29 span.
- `src/components/` — `ControlPanel` (palette, colour, detail, DE, share), `Hud`
  (high-precision coords + live engine badge), `BookmarkBar`.

## The precision story (why this works)

The reason perturbation lets float32 reach 1e-30 is validated, not hand-waved:
a standalone harness (`scratchpad`, not shipped) compared the float32 delta
iteration against a BigInt fixed-point *ground truth* across grids at spans
1e-20 / 1e-28 / 1e-36 — **max escape-count difference: 0**. The float floor is
the delta-underflow point (~1e-35 per-pixel scale), so Fathom clamps there; the
BigInt reference itself is good to ~1e-67, so coordinate precision is never the
bottleneck. Going deeper still would need floatexp (mantissa+int-exponent)
deltas — noted below.

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
- [x] **Perturbation-theory reference orbit for zoom beyond the df64 floor** — to ~1e28+
- [x] **High-precision (BigInt fixed-point) view centre** — the prerequisite for the above
- [x] **URL hash encoding of the current view** for shareable deep links (+ copy button)
- [x] **Distance-estimator colouring** (exterior DE outline shading, both engines)
- [x] **Pinch-to-zoom** for touch devices
- [x] **Smooth animated fly-in** when jumping to a Mandelbrot bookmark
- [x] **Live engine badge** in the HUD (df64 ⟷ perturbation)
- [ ] floatexp (mantissa + int exponent) deltas to push perturbation past ~1e-35

### Session 3 — "Depth, speed, and beauty"

**A. Advanced colouring engine (flagship)** — shipped. The set had always been
rendered by escape-time alone; this adds the colouring algorithms that make
deep-zoom art look the way it does in the galleries.

- [x] A colouring **mode** selector shared by *both* engines: Smooth (current),
      **Stripe Average Colouring** (Jussi Härkönen's `0.5+0.5·sin(f·arg z)` running
      mean, mixed by the smooth fractional escape), **Orbit trap · point** (min |z|
      over the orbit), **Orbit trap · cross** (min distance to the axes).
- [x] An **interior shading** toggle — colour the set's interior by the same
      mode's statistic instead of flat black.
- [x] A **feature frequency** control (stripe density / trap scale), auto-labelled
      per mode, wired through the control panel and the HUD.
- [x] **Normal-map relief lighting** — Lambert shading of `u = z/(dz/dc)` as a
      surface normal, the classic embossed pseudo-3D look, across every mode.
- [x] Encode colouring + relief in the **share link** so deep-zoom art round-trips.
- [x] Validate every shader variant compiles in a real headless WebGL2 context
      (Chromium/SwiftShader harness) and that rendered frames are non-degenerate,
      including a full end-to-end app smoke test.

**D. Progressive rendering** — shipped.

- [x] Render at reduced internal resolution while the camera moves
      (drag / wheel / pinch / fly / auto-dive), full-quality pass once it settles.
- [x] A subtle "refining…" HUD hint; export always renders at full quality.

**E. Polish** — shipped.

- [x] Keyboard navigation (arrows pan, +/- zoom, `r` reset; `w` wallpaper mode).
- [x] Four new palettes (Aurora, Magma, Candy, Deep Sea) + colouring/relief
      showcase bookmarks; HUD colouring badge; refreshed help copy.
- [x] A cinematic **auto-dive** (continuous zoom to the precision floor) and a
      **wallpaper** mode that hides all UI. Gate green throughout.

**B. Perturbation for Julia sets** — researched, **deferred** (would ship glitches).
A Julia reference orbit + exact delta iteration (`δz_{n+1}=2·Z_n·δz_n+δz_n²`) was
validated in Node against a BigInt ground truth. It's clean for escaping/short
reference orbits, but **near Siegel-disk / interior-adjacent regions (long bounded
references) it glitches**: Zhuoran rebasing to index 0 assumes `Z_0=0` (true for
the Mandelbrot critical orbit, false for a Julia centre), and rebasing to the
reference's closest approach to the origin didn't fix it either (100+ escape-count
mismatches at 1e-14). Glitch-free deep Julia needs multiple reference orbits — out
of scope for now. Julia stays on the proven df64 engine (crisp to ~1e13).

- [ ] Deep-zoom Julia via **multi-reference** perturbation (the real fix).

**C. Series approximation** — researched, **deferred** (mainly a speed win, not
provably glitch-free here). The `A,B,C` series (`δz ≈ A·δc + B·δc² + C·δc³`) and a
corner-probe skip selector were built and checked in Node with emulated-float32
arithmetic vs a BigInt ground truth. The conservative skip criterion correctly
*declines to skip* in boundary-rich frames (adding zero error there), but proving a
useful positive skip stays glitch-free across all deep frames — separate from the
inherent escape-count sensitivity at the boundary — needs a stronger validation
than this session's escape-count metric supports. Held back rather than risk
occasional wrong-coloured regions.

- [ ] Series approximation with a rigorously-validated skip (revisit with a
      perturbation-domain error metric, not raw escape counts).

## Session log

- 2026-07-17 (claude): Created Fathom from the template. Built the full df64 WebGL2
  pipeline, renderer, palettes, interaction hook, control panel, HUD, bookmark tour,
  and PNG export. Verified lint + build pass the project gate.
- 2026-07-17 (claude), session 2 — **the deep-zoom release.** Added a whole
  perturbation-theory engine so Fathom dives past the df64 floor (~1e13) to
  ~1e28+: BigInt high-precision centre (`hp.ts`), BigInt reference orbit
  (`refOrbit.ts`), a second GLSL fragment shader with Zhuoran rebasing, and a
  dual-program renderer with an RG32F orbit texture. The engine auto-switches at
  ~1e9 and shows which one is live in the HUD. Also shipped: distance-estimation
  outline shading (both engines), URL-hash deep-link sharing with a copy button,
  a cinematic fly-in to Mandelbrot bookmarks, pinch-to-zoom, and a perturbation
  bookmark dive series. Validated the perturbation math against a BigInt ground
  truth (0 escape-count mismatches at 1e-20…1e-36) and confirmed both shaders
  compile + render in headless WebGL2 before shipping. Gate green.
- 2026-07-23 (claude), session 3 — **the colouring + interactivity release.** Fathom
  had only ever rendered escape-time bands; this session adds the colouring maths
  that make deep-zoom art. New shared colouring engine across *both* GPU engines:
  **Stripe Average Colouring**, **orbit traps** (point + cross), an **interior
  shading** toggle, and **normal-map relief lighting** (Lambert shading of the
  escape derivative — the embossed pseudo-3D look). Added **progressive rendering**
  (draft resolution while the camera moves, crisp on settle) so ultra-deep frames
  stay interactive, a cinematic **auto-dive**, **keyboard navigation**, a **wallpaper**
  mode, four palettes (Aurora/Magma/Candy/Deep Sea), showcase bookmarks, a HUD
  colouring badge, and colouring/relief in the share link. Built a **headless
  WebGL2 harness** (Chromium/SwiftShader via Playwright) that compiles every shader
  variant, renders each colouring mode, and runs a full end-to-end app smoke test —
  all green. Also *researched and deferred*, honestly: **deep-Julia perturbation**
  (validated as glitchy near Siegel-disk regions — Zhuoran rebasing assumes Z₀=0,
  which Julia centres break) and **series approximation** (a speed win that this
  session's escape-count metric couldn't prove glitch-free). Both are documented
  above with their validation results rather than shipped half-working. Gate green.
