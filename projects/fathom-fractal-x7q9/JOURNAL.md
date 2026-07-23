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

### Session 3 — "Depth, speed, and beauty" (planned)

**A. Advanced colouring engine (flagship)** — the set has always been rendered by
escape-time alone; this adds the colouring algorithms that make deep-zoom art
look the way it does in the galleries.

- [ ] A colouring **mode** selector shared by *both* engines: Smooth (current),
      **Stripe Average Colouring** (Jussi Härkönen's `0.5+0.5·sin(f·arg z)` running
      mean, mixed by the smooth fractional escape), **Orbit trap · point** (min |z|
      over the orbit), **Orbit trap · cross** (min distance to the axes).
- [ ] An **interior shading** toggle — colour the set's interior by the same
      mode's statistic instead of flat black (interior orbit traps are gorgeous).
- [ ] A **feature frequency** control (stripe density / trap scale), auto-labelled
      per mode, wired through the control panel and the HUD.
- [ ] Encode the colouring in the **share link** so deep-zoom art round-trips.
- [ ] Validate every shader variant compiles in a real headless WebGL2 context
      before shipping (Chromium/SwiftShader harness), and that a rendered frame is
      non-degenerate (not NaN / not uniformly black).

**B. Perturbation for Julia sets** — deep zoom has been Mandelbrot-only.

- [ ] A Julia **reference orbit** (`z_{n+1}=z_n²+c` from a high-precision seed z₀).
- [ ] A Julia **perturbation fragment shader** (`δz_{n+1}=2·Z_n·δz_n+δz_n²`, δc≡0)
      with Zhuoran rebasing, plus renderer plumbing and auto-engagement past ~1e9.
- [ ] Ground-truth the Julia delta iteration against a BigInt reference in Node
      (0 escape-count mismatches, matching the Mandelbrot validation bar).

**C. Series approximation** — skip the numerically-safe early iterations so the
deepest dives start hundreds/thousands of iterations in.

- [ ] Compute the perturbation **series coefficients** `A,B,C` (δz ≈ A·δc + B·δc² +
      C·δc³) alongside the reference orbit, in BigInt fixed-point.
- [ ] Pick a **skip iteration** by probing the frame's corners: advance while the
      series still predicts δz to a set tolerance, then hand off to the shader.
- [ ] Seed the shader's δz from the series at the skip point (new uniforms), and
      **prove correctness** in Node: series-seeded vs from-scratch escape counts
      must match across a grid at 1e-20 … 1e-30.

**D. Progressive rendering** — keep ultra-deep frames interactive.

- [ ] Render at reduced internal resolution while the camera is moving
      (drag / wheel / pinch / fly), then a full-quality pass once motion settles.
- [ ] A subtle "refining…" HUD hint; export always renders at full quality.

**E. Polish**

- [ ] Keyboard navigation (arrows pan, +/- zoom, `f` fit, `r` reset, `[`/`]` iters).
- [ ] New palettes tuned for stripe/trap colouring; colouring-showcase bookmarks.
- [ ] HUD colouring badge; refreshed help copy; keep the gate green throughout.

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
