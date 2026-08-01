# Event Horizon — journal

A real-time, physically-grounded **Schwarzschild black hole ray tracer** that runs entirely in
your browser. Every pixel of the main view is produced by integrating a photon's null geodesic
*backwards* from the camera through curved spacetime — so the gravitational lensing, the
Einstein ring, the warped starfield, and the lopsided glow of the accretion disk are all
*computed*, not faked with a texture. A second view traces individual light rays in 2D so you
can see exactly how geometry bends them, and a primer explains the physics.

This is the app's long-lived memory. Read it first when you pick the project back up.

## What's built (v1)

- **Relativistic renderer (WebGL2):** per-pixel geodesic integration of the photon shape
  equation `d²u/dφ² + u = 3M u²` in its Cartesian form `a = -1.5·h²·r⃗ / r⁵` (units where the
  Schwarzschild radius `rs = 1`, so `M = 0.5`). RK4 integrator with distance-adaptive step size.
- **Accretion disk** in the equatorial plane with: Keplerian shear + fBm turbulence (animated),
  an approximate **Planckian (black-body) colour** ramp, **relativistic Doppler beaming**
  (approaching side brighter & bluer), and **gravitational + transverse redshift**. Sub-step
  plane-crossing interpolation keeps the disk crisp regardless of step count.
- **Lensed procedural starfield** (multi-layer hashed stars + faint fBm nebula) sampled along the
  *escaping* ray direction, so the background genuinely wraps around the hole into an Einstein ring.
- **Photon-sphere / horizon capture:** rays that fall inside `r = rs` go black; the unstable
  photon orbit at `1.5 rs` produces the bright photon ring for free.
- **ACES filmic tonemap** + exposure, so the huge HDR range of the disk resolves gracefully.
- **Interactive camera:** drag to orbit (azimuth + inclination), wheel to dolly, auto-orbit.
- **Full control panel:** disk radii/brightness/temperature, integration steps & step size
  (quality vs. speed), Doppler & redshift toggles, exposure, star brightness, render scale, FOV.
- **Presets:** Cinematic, Edge-On, Top-Down, Photon Ring, Interstellar-ish.
- **2D Geodesic Explorer** (CPU): parallel photons fired past the hole, coloured by fate
  (escaped / captured), with the horizon, photon sphere, and critical impact parameter
  `b_crit = 3√3·M` drawn to scale. Shows deflection directly.
- **Physics primer** view with the equations and what each control changes.
- **PNG export** of the current frame, live FPS readout, graceful WebGL2-missing fallback.

## Ideas / backlog

- [x] WebGL2 geodesic ray tracer with lensed starfield
- [x] Accretion disk: black-body colour, Doppler beaming, gravitational redshift
- [x] Orbit/dolly camera + auto-orbit + presets
- [x] 2D geodesic explorer with photon sphere & critical impact parameter
- [x] Physics primer / about view
- [x] PNG screenshot export + FPS meter + WebGL2 fallback
- [x] Volumetric disk (ray-march thickness) instead of a thin plane
- [x] "Free fall" camera mode that plunges through the horizon

## v2 — "Kerr" (the spinning-black-hole release)

The centrepiece of v2 is a **rotating (Kerr) black hole**. A spinning hole drags spacetime
itself around with it (frame dragging), which asymmetrically distorts the shadow into the
famous flat-edged "D" and skews the whole lensed image — none of which a Schwarzschild hole
shows. Doing it honestly means abandoning the reduced Cartesian shape-equation and integrating
the **full Kerr null geodesic** in Boyer–Lindquist coordinates. Below is the plan; each item is
implemented and checked off in this same session.

### Physics engine

- [x] Add a **spin** parameter `a/M ∈ [0, 0.998]` (0 = Schwarzschild, 1 = extremal Kerr).
- [x] **Kerr geodesic integrator (GLSL)** via the Hamiltonian form: carry BL position
  `(r, θ, φ)` + covariant momenta `(p_r, p_θ)` with `E = −p_t` and `L = p_φ` conserved. Evolve
  with RK4 using the inverse Kerr metric `gᵘᵛ(r,θ)` and its analytic `∂_r`, `∂_θ`. No turning-point
  sign flips (the Hamiltonian is smooth), so it stays robust through periapsis.
- [x] **Cartesian ⇄ Boyer–Lindquist** conversion (oblate-spheroidal, spin axis = world *Y*),
  including correct **covariant-momentum initialisation** from the camera ray by lowering the
  flat-space direction with the metric and solving the null condition for `p_t`.
- [x] **Dual-path renderer**: `a ≈ 0` keeps the fast, proven Cartesian Schwarzschild loop;
  `a > 0` engages the Kerr Hamiltonian loop. Both share disk + starfield sampling.
- [x] **Outer-horizon capture** at `r₊ = M + √(M²−a²)` and an **ergosphere** overlay
  (`r_ergo(θ) = M + √(M²−a²cos²θ)`) you can switch on.
- [x] **Exact GR disk photometry** for the Kerr path: one relativistic frequency-shift factor
  `g = √(−(g_tt + 2Ω g_tφ + Ω² g_φφ)) / (1 − Ω·b)` (with the photon's own conserved `b = L/E`
  and the prograde orbital `Ω`) unifies gravitational redshift, transverse + longitudinal Doppler
  **and** frame dragging in a single physically-correct number. Colour shifts by `g`, intensity by `g³`.
- [x] **Spin-aware prograde ISCO** with an "inner edge tracks ISCO" auto option (ISCO marches from
  `6M` down toward `M` as `a → M`).

### Rendering & UX

- [x] **Multi-pass HDR bloom**: render the scene to a float FBO, bright-pass extract, separable
  Gaussian blur (ping-pong, two scales), composite before the tonemap — real glow on the disk.
- [x] **Adaptive quality**: watch the frame time and auto-lower/-raise `renderScale` to hold a
  target FPS, with a toggle.
- [x] **URL-hash scene sharing**: encode the full parameter set into the location hash; a
  "Copy link" button; restore on load so a tuned scene is a shareable link.
- [x] **Relativistic-line spectrograph overlay**: a live panel plotting the disk's `g`-shifted
  emission-line profile — the classic skewed, double-horned relativistic Fe-Kα shape — recomputed
  from the current inclination + spin on the CPU.
- [x] **2D explorer → Kerr**: equatorial Kerr geodesics with frame dragging (prograde vs
  retrograde asymmetry), the ergosphere ring and outer horizon drawn, plus a spin slider.
- [x] **Physics primer update**: Kerr metric, frame dragging, the ergosphere, the `g`-factor and
  where bloom/adaptive quality fit.
- [x] **New presets** (Maximal Spin, Frame Dragging, Retrograde) + **keyboard shortcuts**
  (number keys → presets, `Space` auto-orbit, `B` bloom, `R` reset, `S` save PNG) and a spin/ISCO HUD readout.

## v3 — "Infall" (the volumetric-disk & plunge release)

v1 gave a thin-plane Schwarzschild tracer; v2 made the hole spin. v3 clears the two remaining
v1 backlog items — a **volumetric accretion disk** and a **free-fall camera** — and turns them
into the centrepiece. The theme is *depth and immersion*: the disk stops being an infinitely thin
sheet and becomes a glowing, self-shadowing slab of gas, and the camera can leave its safe orbit
and **plunge toward the horizon on a real infalling geodesic**, so you finally see what a person
falling in would see: the entire sky crushed into a shrinking, blue-shifted window ahead.

### Rendering engine

- [x] **Volumetric accretion disk.** Replace the single equatorial-plane crossing with a proper
  **emission–absorption ray-march** along the photon's own geodesic. The disk is a flared slab of
  half-thickness `H(ρ) = h₀·(ρ/ρ_in)^1.15` with a Gaussian vertical density profile
  `exp(−1.8·(y/H)²)`. Each integration step that lands inside the slab accumulates
  `color += T·S·(1−e^{−κ·ds})`, `T *= e^{−κ·ds}` — so the disk genuinely occludes itself, the far
  side is dimmed as it shines through the near side, and the inner wall casts the material into
  real 3-D relief. Works on **both** the Schwarzschild and Kerr paths, reusing each path's exact
  relativistic photometry (Doppler beaming / g-factor) per marched sample. Toggle + a thickness
  slider; the fast thin-plane path is preserved for when you want crispness or speed.
- [x] **Free-fall "rain-frame" observer.** Put the camera on a Gullstrand–Painlevé raindrop that
  fell from rest at infinity: at radius r it moves inward at `β = √(r_s/r)` relative to the static
  frame. Every camera ray is **relativistically aberrated** into the static coordinates before the
  geodesic is integrated, and the whole image is **Doppler-shifted and beamed** by
  `D = γ(1 + β·μ)`. The result is physically what an infaller sees — the sky rushes forward and
  compresses, blue ahead and red behind — and it lets the camera descend below the photon sphere.
- [x] **"Plunge" dive animation.** A HUD button + `F` key eases the camera smoothly down its radial
  world-line toward the horizon (and back out), forcing the rain frame on, with a live HUD readout
  of the observer's radius, `β`, and Lorentz `γ`. The single most visceral thing the app can do.
- [x] New uniforms (`uVolumetric`, `uDiskThickness`, `uObserverBeta`) wired through the renderer;
  `β` is derived on the CPU from the live camera radius so the dive animation drives it for free.

### UX & docs

- [x] New controls: **Volumetric** toggle + **Disk thickness** slider (Accretion disk group) and a
  **Free fall** toggle (Camera group), all serialised into the shareable URL hash.
- [x] New presets: **Volumetric** (thick, spinning, ISCO-tracked) and **Plunge** (rain frame, close).
- [x] Keyboard: `V` toggles the volumetric disk, `F` triggers/aborts the plunge.
- [x] **Physics primer** gains sections on volume rendering a relativistic disk, the rain frame,
  aberration, and what an infalling observer sees; the "thin plane" caveat is updated.
- [x] **Geodesic explorer**: draw the exact Kerr **prograde & retrograde circular-photon-orbit**
  radii (closed form `r = 2M[1 + cos(⅔·arccos(∓a/M))]`) as reference rings, plus a live readout of
  the horizon, ergosphere, photon orbits and ISCO for the current spin.

### Ideas / future backlog

- [x] True redshift-of-the-starfield chromatic table (per-wavelength) instead of the RGB-tint approx.
- [x] Second-order "photon ring" isolation pass **in the render shader** (tint higher-order images).
      The *physics* of the photon ring is now covered analytically in v4's Observatory (the deflection
      curve shows the bending racing through π, 2π as `b → b_crit`); this remaining item is the GPU
      image-space isolation of those higher-order rings in the main render.
- [x] Kerr rain frame proper (the GP β above is the Schwarzschild raindrop; Kerr uses a ZAMO drift).
- [x] A "trace this pixel" probe: click the main render and plot that one photon's geodesic + its
      conserved (E, L, Q) using the new CPU integrators.

## v4 — "Observatory" (the verification & shadow-science release)

v1–v3 made a beautiful, physically-motivated picture. But every sibling lab in this repo earns its
keep by being **proven from the inside** — a self-test suite that re-derives its results and a
place where the theory and the simulation are checked against each other. Event Horizon had neither.
v4 fixes that and, in doing so, turns the app from a renderer into an **instrument**: it now computes
the exact GR observables an astronomer measures (the shadow outline, the light-bending curve) and
verifies them live, in the browser, on every load.

### New physics package (`src/physics/`), pure + headless-testable

- [x] **`kerr.ts` — closed-form observables & the analytic shadow.** Horizons `r±`, ergosphere,
      prograde/retrograde circular photon orbits, prograde ISCO (Bardeen), the exact `g`-factor, and
      the star of the release: the **critical curve**. Each spherical photon orbit at BL radius `r`
      fixes `ξ(r) = L/E` and `η(r) = Q/E²` (derived from `R(r)=R'(r)=0`), projected to the observer
      sky by `α = −ξ/sinθ_o`, `β² = η + a²cos²θ_o − ξ²cot²θ_o`. Collapses to a circle of `3√3·M` at
      `a=0`. Plus `isCaptured(α,β)` — an **independent** capture test via the Kerr radial potential
      `R(r)` (a photon is trapped iff `R` never vanishes above the horizon), so the shadow can be
      cross-checked two entirely different ways.
- [x] **`cpu-geodesic.ts` — faithful CPU ports of the GPU integrators.** The Schwarzschild
      reduced-Cartesian photon (now accumulating total winding so bending can exceed 2π), the full
      **3-D Kerr Hamiltonian** integrator (line-for-line the shader's `kerrInv`/`kerrDeriv` + the
      camera→covariant-momenta null init), and a lean equatorial Kerr tracer. These let us measure
      **Carter's constant** and the null Hamiltonian along real geodesics and bisect capture edges.
- [x] **`selftest.ts` — 20 checks, five groups.** *Light bending:* `b_crit` bisected from real
      photons = `3√3·M` to 6 figures; deflection at `b = 20, 40 rs` matches the 2nd-order GR series
      to <1%; bending diverges monotonically toward `b_crit`. *Kerr integrator:* Carter's `Q` and the
      null condition `2H=0` conserved to `~10⁻⁵` along four integrated null geodesics. *Kerr shadow
      (analytic):* the spherical-orbit `ξ(r),η(r)` satisfy `R=R'=0` (`|R|~10⁻¹⁴`); equatorial light
      rings have `η=0`; the `a→0` curve is a circle of `b_crit`; the analytic curve is the exact
      capture/escape knife-edge (300/300 boundary points). *Kerr shadow (integrated):* analytic
      shadow edges match the renderer's **own** equatorial ray tracer to <2% across three spins.
      *Closed-form:* horizon/photon-sphere/ISCO limits, the physics package agrees with the UI
      helpers bit-for-bit, shadow area = `π·b_crit²`, displacement is zero at `a=0` and grows with spin.

### New "Observatory" tab (`src/components/Observatory.tsx`)

- [x] **Shadow / critical-curve panel.** Live `(α, β)` sky plot: the numerically-determined captured
      region (from the radial-potential test) drawn as a black silhouette, the exact analytic critical
      curve traced in cyan **exactly along its rim** (theory = simulation), and the Schwarzschild
      reference circle dashed for scale. Spin + inclination sliders; read-outs for width, height,
      area, frame-dragging displacement and asymmetry, plus the light-ring / ISCO geometry.
- [x] **Light-bending & photon-ring panel.** The integrated deflection `α(b)` for Schwarzschild with
      the weak-field `4M/b` asymptote and the `b_crit` divergence, `π`-multiple gridlines marking the
      successive photon-ring orders (the curve climbs past `2π`, one full extra loop, near `b_crit`).
- [x] **Verification panel.** The whole suite rendered as grouped pass/✓ badges with each measured
      error inline and an `N/N passing` headline — the suite runs after first paint so the tab opens
      instantly.
- [x] Wired the tab + `#/observatory` route + the `O` keyboard shortcut; new Physics-primer section
      ("The shadow — computed, and proven"); Observatory-themed CSS.
- [x] Verified green via `node scripts/verify-project.mjs event-horizon-q7v3` (scope + conformance +
      lint + tsc + build) **and** driven headless in Chromium against the production build: the tab
      mounts, **20/20 self-tests pass live**, the shadow silhouette sits under the analytic curve, the
      readouts update on spin/inclination, and there are **zero console errors**.

## v5 — "The Probe" (the click-a-photon & light-echo release)

v4 made the shadow *provable*; v5 makes the whole image *interrogable*. Until now the renderer was a
black box: 200 000 photons a frame, none of which you could ever ask a question. v5 turns every pixel
into an instrument you can click. It also clears three of the four remaining backlog items — the
GPU light-echo isolation, the proper Kerr (ZAMO) rain frame, and a physically-consistent per-colour
redshift — and adds a fresh verification group so the new machinery is proven from the inside, the
way everything else in this app is.

### The photon probe (headline, `src/physics/probe.ts` + a render overlay)

- [x] **`probe.ts` — path-recording ports of the exact integrators.** The v4 CPU integrators measured
      conserved quantities but threw the trajectory away. v5 adds `tracePhotonPathSchw` and
      `tracePhotonPathKerr` that record the full world-space polyline **and** its physics: the
      conserved `E`, `L`, Carter's `Q`, the impact parameter `b = L/E`, the closest approach `r_min`,
      the count of equatorial-plane crossings (the image order), the accumulated winding angle, and
      the photon's fate (captured / hit the disk at radius r / escaped to the sky along direction d̂).
      Same RK4 schemes, step-size laws and capture tests as the shader, so the recovered path is the
      one the pixel actually shows.
- [x] **Exact camera-ray reconstruction**, including the free-fall aberration. `cameraRay(params, ndc)`
      rebuilds the same ray the fragment shader casts for a device coordinate — orbit basis, fov, aspect
      — and applies the identical Gullstrand–Painlevé (or ZAMO) aberration when free-fall is on, so a
      click in the rain frame traces the photon you're really seeing.
- [x] **Click-to-trace overlay in `RenderView`.** A second, transparent 2-D canvas over the GL canvas.
      Click (distinguished from a drag) → trace that photon → keep the world-space path fixed and
      **re-project it every frame** with the live camera, so you can then orbit around the frozen
      geodesic and watch it bend in 3-D. Markers for the camera, the closest approach, the disk hit and
      the horizon; the curve is colour-graded by gravitational potential. `Esc` / a button clears it.
- [x] **Live probe read-out panel.** `b = L/E` against `b_crit`, `E`, `L`, `Q`, `r_min`, crossings,
      total deflection, and a plain-language verdict ("captured — crossed the horizon", "escaped to the
      sky", "absorbed by the disk at r = …"). Serialised nowhere — it's a live instrument, not a preset.

### Light-echo isolation in the render shader (clears a backlog item)

- [x] **Per-pixel image order.** Track how many times each traced photon crosses the equatorial half
      plane (Schwarzschild) / accumulates π of winding (Kerr); that integer *is* the lensing image
      order — direct (n = 0), first photon ring (n = 1), second (n = 2)…
- [x] **`uRingHighlight` tint pass.** A toggle (Look group, key `P`) that overlays a thin, distinctly
      hued glow on the n ≥ 1 higher-order images — the light echoes hugging the shadow that the EHT
      resolves as the "photon ring". Off by default; serialised into the share hash.

### Proper Kerr rain frame + physical colour (clears two backlog items)

- [x] **ZAMO free-fall for a > 0.** The v3 raindrop was the Schwarzschild GP observer (pure radial β).
      For a spinning hole the natural infaller is dragged azimuthally: v5 adds the zero-angular-momentum
      (ZAMO) frame-dragging drift `ω = −g_tφ/g_φφ` to the aberration boost, so plunging into a Kerr hole
      swirls the sky as well as compressing it.
- [x] **Per-wavelength starfield redshift.** Replace the ad-hoc RGB tint of the free-fall Doppler with a
      physically-consistent shift of each star's **black-body temperature** by the Doppler factor
      (`T → T·D`), so the colour follows the real Planckian locus (a blueshifted star genuinely walks up
      the black-body curve toward white-blue) instead of a hand-tuned gain.

### Verification & docs

- [x] **New self-test group "Photon probe".** The recorded path must (a) conserve `E`, `L` and Carter's
      `Q` to tolerance, (b) recover `b = L/E` equal to the geometric aim for a distant camera, (c) be
      captured for `b < b_crit` and escape for `b > b_crit` (Schwarzschild), and (d) reproduce the
      analytic deflection for a grazing ray. Bumps the live suite past 20 checks.
- [x] **Physics-primer section** on lensing image orders / the photon ring, what the probe measures, and
      the ZAMO frame; **new presets** ("Light Echo", "Probe"); README/HUD hint + keyboard updates.
- [x] **Ship green + headless-verified.** `node scripts/verify-project.mjs` (scope + conformance + lint +
      tsc + build) **and** driven in Chromium against the production build: probe traces on click, the
      overlay tracks the orbit, the light-echo tint appears, the new self-tests pass live, zero console
      errors.

## v6 — "The Charged Hole" (the Kerr–Newman / no-hair release)

v1–v5 covered the two-parameter sub-family of black holes: mass and spin (Schwarzschild → Kerr).
But general relativity's **no-hair theorem** says a stationary black hole is fixed by *three*
numbers — mass `M`, spin `a`, and electric **charge `Q`**. v6 completes the family. It adds the
charge parameter and generalises **every layer of the engine** — the GPU renderer, the CPU
integrators, the closed-form observables, the analytic shadow, the disk photometry, the probe, the
spectrograph, and the verification suite — from Kerr to the fully general **Kerr–Newman** metric.
With no spin this is a **Reissner–Nordström** hole; with both, it is the most general isolated black
hole there is. Charge shrinks the horizon and the shadow, and it does so through one tidy
substitution that runs through the whole codebase: the mass function `2Mr` becomes `2Mr − Q²`, and
the horizon function gains a term, `Δ = r² − 2Mr + a² + Q²`.

### The physics (all validated in a Node oracle first, then ported)

- [x] **Charge parameter** `Q* = Q/M ∈ [0, 1]`, wired through `Params`, the share-hash (`qc`), and a
      new slider in the Black-hole group. Spin and charge share one **extremal budget**
      `a*² + Q*² ≤ 1` (a real horizon requires it); the UI clamps the charge to whatever room the
      current spin leaves, so the hole is never driven super-extremal / naked.
- [x] **Closed-form Kerr–Newman observables** (`physics/kerr.ts`): horizons `r± = M ± √(M²−a²−Q²)`,
      the RN photon sphere `r_ph = ½(3M+√(9M²−8Q²))` and its critical impact parameter `r_ph²/√Δ`
      (→ `3√3·M` uncharged, → `4M` at extremal), the charged spherical-photon-orbit ratios
      `ξ(r) = −(r³−3Mr²+a²r+a²M+2Q²r)/[a(r−M)]` and
      `η(r) = r²[4a²Δ−(r²−3Mr+2a²+2Q²)²]/[a²(r−M)²]` (derived by hand, verified to reduce to the
      Kerr forms), a numeric **KN photon-ring finder** (the η=0 roots — no Bardeen closed form once
      charged), and the charge-aware radial potential, `isCaptured` test, shadow critical curve, and
      `g`-factor.
- [x] **GPU renderer** (`gl/shaders.ts`): `uCharge2` uniform threaded through `kerrCov`/`kerrInv`,
      the horizon + ergosphere capture radii, and both the thin and volumetric disk photometry (the
      KN Kepler frequency `Ω = √(Mr−Q²)/(r²+a√(Mr−Q²))` and the `2Mr−Q²` metric). The reduced
      Cartesian Schwarzschild fast path is now taken only for a *static, uncharged* hole; any spin
      **or** charge engages the full Hamiltonian loop (which handles a=0, Q>0 as Reissner–Nordström).
- [x] **CPU integrators** (`cpu-geodesic.ts`, `geodesics.ts`, `probe.ts`, `lineprofile.ts`): the
      same `q2` substitution ported line-for-line, so the click-a-photon probe, the 2-D equatorial
      explorer, the conservation tracer, and the emission-line profile all honour charge — and the
      probe's Model read-out now names the family member (Schwarzschild / Kerr / Reissner–Nordström /
      Kerr–Newman).
- [x] **Three new presets** — *Reissner–Nordström* (static, heavily charged), *Kerr–Newman*
      (spinning + charged), *Extremal charge* (pushed to `a*²+Q*²≈1`). New HUD readout naming the
      hole and its `Q/M`.

### UX, docs & proof

- [x] **Observatory** gains a **charge slider** (capped by the extremal budget) that drives the live
      shadow: the cyan critical curve and the independent radial-potential silhouette both shrink as
      charge rises; new read-outs for the charged light rings and the extremal budget
      `√(a*²+Q*²)/1`; the caption explains the `Δ = r²−2Mr+a²+Q²` mechanism.
- [x] **Geodesic Explorer** gains a charge slider — the equatorial fan tightens symmetrically, the
      horizon / ergosphere / light-ring / capture-guide all track the charge (RN when static).
- [x] **Physics primer**: a new *"Charge: the Kerr–Newman family"* section (the no-hair theorem, the
      `2Mr−Q²` substitution, the shrinking horizon/shadow, the shared extremal budget), plus updates
      to the g-factor and honest-caveats sections.
- [x] **Verification**: a new *"Kerr–Newman (charge)"* self-test group — the RN shadow is a circle of
      `r_ph²/√Δ`; the RN critical `b` recovers `3√3·M` uncharged and `4M` extremal; charged spherical
      orbits satisfy `R=R'=0` (~1e-12); the KN ring-finder matches Bardeen at Q=0 (~1e-16); charged
      light rings have `η=0`; the **analytic charged shadow edges match the renderer's own integrated
      equatorial geodesics** (<1%); charge measurably shrinks the shadow; and the probe's RN capture
      edge equals the RN critical impact parameter. The live suite goes from **25 → 33 checks**.
- [x] **Ship green + headless-verified**: `node scripts/verify-project.mjs event-horizon-q7v3` (scope
      + conformance + lint + tsc + build) **and** driven in Chromium against the production build.

## v7 — "Orbits" (the matter release)

v1–v6 traced one thing, exhaustively: **light**. Every pixel, every self-test, every geodesic in the
app is a *null* geodesic. But a black hole's most visceral physics is what it does to **matter** — the
precessing orbits, the innermost stable circular orbit, the plunge — and the app had never tumbled a
single massive particle. v7 adds the app's first **timelike** geodesic tracer and turns it into a full
orbital-mechanics lab. The physics is the same Kerr–Newman spacetime and the same Hamiltonian equations
of motion; the only change is the mass-shell normalisation `gᵘᵛ p_u p_v = −1` instead of `= 0`. That one
sign gives matter an ISCO (which light has not), makes bound orbits **precess** instead of close
(Mercury's perihelion advance — GR's first triumph), and makes sub-separatrix orbits **plunge**.

### New physics package (`src/physics/orbits.ts`), pure + headless-testable

- [x] **Equatorial Kerr–Newman timelike machinery.** The inverse metric at θ = π/2, the velocity part
      of the mass shell `U(r)`, and the radial function `R(r) = (dr/dτ)² = gʳʳ·(−1 − U)` — the particle
      lives where `R ≥ 0`, its zeros are periapsis/apoapsis, a double zero is a circular orbit. Reduces to
      the textbook `R = E² − (1−2M/r)(1+L²/r²)` at a = Q = 0.
- [x] **`orbitFromApsides` — the conserved (E, L) from a periapsis/apoapsis pair.** Both radii are turning
      points (`U = −1`), so subtracting the two equations gives a quadratic in `E/L`; back-substitution
      fixes the magnitude. Exact for Kerr–Newman, prograde/retrograde selectable.
- [x] **`circularOrbit` — the double-root limit** (`U = −1` and `U′ = 0`) — and `circularBPT`, the
      Bardeen–Press–Teukolsky closed form kept as the verification oracle. Plus `iscoSigned`
      (prograde/retrograde ISCO), `marginallyBound` (the E = 1 capture orbit), and `omega` (dφ/dt).
- [x] **Path-recording RK4 integrator** in proper time τ: records the world-plane polyline **and** the
      cumulative τ at each point (so the animation can advance by *proper time* — the star faithfully
      speeds up at periapsis), detects periapsis passages to measure the **precession** and the radial /
      azimuthal periods, accumulates coordinate time for the **time-dilation** read-out, holds the mass
      shell `|2H+1|` to ~1e-12, and classifies the fate (bound / plunge / unbound).

### New "Orbit Lab" tab (`src/components/OrbitLab.tsx`)

- [x] **Animated top-down orbit view.** The traced rosette with a bright, proper-time-paced star and a
      fading trail; the horizon shadow, ISCO ring, ergosphere, prograde/retrograde light rings and the
      marginally-bound circle drawn to scale (world radius ρ = √(r²+a²), matching the Geodesic Explorer).
      Static layers are rendered once to an offscreen canvas and blitted each frame; only the star + trail
      redraw — smooth at 60 fps.
- [x] **Live `R(r)` effective-potential inset** beside the orbit: the radial function with its forbidden
      band shaded, the turning points and ISCO marked, and the particle's current radius tracked in real
      time — the phase-space picture next to the real-space one.
- [x] **Controls + transport + presets.** Spin, charge (capped by the extremal budget), periapsis and
      apoapsis, prograde/retrograde; play/pause + speed; six presets (Precessing rosette, Zoom–whirl,
      Plunge, Near-circular, Retrograde, Charged Kerr–Newman). Rich read-outs: E, L, eccentricity,
      precession per orbit, radial & orbital periods (proper and coordinate), the two-clock time dilation,
      ISCO / horizon / marginally-bound reference, and a live orbit classification.

### Verification & docs

- [x] **New self-test group "Timelike orbits (matter)" — 11 checks.** Circular `E, L` = Bardeen–Press–
      Teukolsky (rel < 1e-4 over 4 spins × 2 senses × 4 radii); circular Ω = the GR-Kepler law incl.
      charge; apsides fix `R(r_p) = R(r_a) = 0` (~1e-16, Kerr–Newman); integrated perihelion precession =
      **exact GR** `2π[(1−6M/a)^{−1/2}−1]` near-circular (rel < 4e-3) and → Einstein's weak-field
      `6πM/[a(1−e²)]` in the far field (< 1.5%); the ISCO is marginally stable (`R″ = 0`) and splits
      prograde/retrograde with spin; the marginally-bound orbit has E = 1 exactly; a zoom–whirl orbit
      holds `2H = −1` while precessing ~150°/orbit; the separatrix cleanly divides plunging from turning
      orbits; and the orbiting clock runs slow, deeper = slower. **The live suite goes from 33 → 44 checks.**
- [x] **Physics-primer section** "Orbits of matter: precession, the ISCO & zoom–whirl"; new `#/orbits`
      route + **Orbits** tab + the `M` keyboard shortcut.
- [x] **Validated the physics in a throwaway vite-SSR Node oracle first** (16 checks — circular vs BPT,
      Ω vs Kepler, ISCO stability, precession convergence vs step size proving the integrator, not the
      formula, is exact), then ported. Ship green (scope + conformance + lint + tsc + build) and driven
      headless in Chromium against the production build.

### Ideas / future backlog

- [ ] Render a **lensed orbiting hotspot** in the main GPU view — a bright clump following a real timelike
      geodesic (a Sgr A* flare), lensed and Doppler-beamed by the existing shader.
- [ ] **Spherical (non-equatorial) orbits** with Carter's constant — the 3-D analogue, tracing the polar
      oscillation as well as the radial one.
- [ ] A **"drop a star" mode** in the main render: click to launch a test particle and watch its 3-D
      world-line lensed live.

## Session log

- 2026-07-05 (claude, opus-4.8): created from template. Built the full v1 described above —
  WebGL2 geodesic renderer, accretion disk with relativistic effects, lensed starfield, 2D
  geodesic explorer, physics primer, presets, PNG export, orbit controls. Verified green
  (conformance + lint + build) and shipped.
- 2026-07-05 (claude, opus-4.8): **v2 "Kerr"**. Turned the Schwarzschild tracer into a full
  rotating black-hole simulator. New Kerr Hamiltonian null-geodesic integrator (Boyer–Lindquist,
  analytic inverse-metric gradient) with correct Cartesian⇄BL and momentum init; exact GR
  `g`-factor disk photometry (redshift + Doppler + frame dragging in one term); ergosphere +
  spin-aware ISCO; multi-pass HDR bloom (float FBO ping-pong); adaptive quality; URL-hash scene
  sharing; a live relativistic-line spectrograph; a Kerr-capable 2D geodesic explorer; rewritten
  physics primer; new spin presets + keyboard shortcuts. Verified green + screenshot-checked.
- 2026-07-05 (claude, opus-4.8): **v3 "Infall"**. Cleared the last two v1 backlog items and made
  them the headline. (1) **Volumetric accretion disk** — the equatorial-plane crossing is replaced
  by an emission–absorption ray-march through a flared, Gaussian-profiled slab (`H ∝ ρ^0.75`), on
  both the Schwarzschild and Kerr paths, reusing each path's exact photometry per sample, so the
  disk self-shadows and stands up in 3-D; a toggle + thickness slider, thin-plane path preserved.
  (2) **Free-fall "rain frame"** — a Gullstrand–Painlevé infalling camera: every ray is
  relativistically aberrated (`β = √(rs/r)`) before integration and the whole image is
  Doppler-beamed by `D = γ(1+β·μ)`, plus a **Plunge** button/`F` that eases the camera down to the
  horizon with a live β/γ HUD — the sky compresses and blazes ahead exactly as it should. Added
  `V`/`F` shortcuts, Volumetric + Plunge presets, hash-serialised new params, primer sections on
  volume rendering / the rain frame / aberration, and exact Kerr prograde+retrograde light-ring
  rings + a geometry readout in the explorer. Verified green **and** headless-rendered every mode
  in Chromium (no shader-compile / runtime errors; shadow, plunge compression and rings confirmed).
- 2026-07-06 (claude, opus-4.8): **v4 "Observatory"**. Gave the app the one thing every sibling lab
  in this repo has and it lacked — a **verification story**. New pure `src/physics/` package: `kerr.ts`
  (closed-form horizons/ergosphere/light-rings/ISCO/`g`-factor and the exact **analytic shadow
  critical curve** `α=−ξ/sinθ_o`, `β²=η+a²cos²θ_o−ξ²cot²θ_o` from the spherical-photon-orbit
  `ξ(r),η(r)`, plus an independent radial-potential capture test), `cpu-geodesic.ts` (faithful CPU
  ports of the Schwarzschild and full 3-D Kerr Hamiltonian integrators + a lean equatorial tracer,
  used to measure Carter's constant / the null condition and bisect capture edges), and `selftest.ts`
  (**20 checks in five groups**). New **Observatory** tab: a live `(α,β)` shadow plot with the numeric
  captured region under the exact analytic curve (theory = simulation, displaced into the Kerr "D" as
  spin rises), a Schwarzschild light-bending/photon-ring plot (deflection hugging `4M/b`, diverging
  through `π`,`2π` at `b_crit`), and the whole self-test suite as live pass badges. Wired `#/observatory`
  + the `O` key + a new primer section. Validated every formula in a throwaway Node oracle first
  (b_crit to 5e-8, Carter drift ~1e-5, R=R'=0 to 1e-14, a→0 shadow = exact circle), then ported;
  full gate green (scope + conformance + lint + tsc + build) and driven headless in Chromium against
  the production build — **20/20 self-tests pass live, zero console errors**, shadow silhouette hugs
  the analytic curve, read-outs track the sliders. No shader/renderer files touched — purely additive.
- 2026-07-10 (claude, opus-4.8): **v5 "The Probe"**. Made the whole image interrogable and cleared
  all four remaining v3 backlog items. (1) **Photon probe** — a new pure `src/physics/probe.ts`
  (path-recording ports of the exact Schwarzschild + Kerr integrators, an exact camera-ray
  reconstruction that includes the free-fall aberration boost, and a vector relativistic-aberration
  helper proved to reduce to the old radial rain-frame formula). Click anywhere on the render and the
  clicked pixel's photon is traced, its world-space geodesic frozen and **re-projected every frame**
  (a new 2-D overlay canvas + `src/ui/probe-overlay.ts`) so you can orbit around it in 3-D, with a
  live read-out of the conserved `E`, `L`, Carter's `Q`, impact parameter `b=|L/E|` vs `b_crit`,
  closest approach, image order and fate. (2) **Light-echo isolation in the shader** — per-pixel
  equatorial-crossing count = lensing image order; a `uRingHighlight` toggle (key `P`) tints the
  higher-order photon-ring echoes cyan/gold/magenta. (3) **Kerr ZAMO rain frame** — the free-fall
  boost is now a velocity *vector* (`uObserverVel`): radial GP infall plus the frame-dragging ZAMO
  azimuthal drift `ω=−g_tφ/g_φφ` for `a>0`, shared bit-for-bit between renderer and probe. (4)
  **Per-wavelength starfield redshift** — each star's black-body *temperature* is shifted by the
  Doppler factor (a real Planckian-locus walk) instead of an RGB tint. New "Photon probe" self-test
  group (centre ray captured; the probe's own capture edge = `b_crit` to ~5e-3; off-axis escape with
  `b>b_crit`; finite Kerr E/L/Q; free-fall Doppler blue/red-shifts fore/aft) → **25/25 live**. New
  presets (Light Echo, Probe), `P` shortcut, two primer sections, updated caveats. Validated the new
  physics in a throwaway vite-SSR Node oracle first (capture edge 2.593 vs b_crit 2.598), then full
  gate green (scope + conformance + lint + tsc + build) and driven headless in Chromium against the
  production build — shader compiles, probe traces a captured photon on click (`b=1.02 rs < b_crit`),
  a grazing click shows an order-2 looping ray that escapes, the ZAMO+spin+echo scene renders,
  **25/25 self-tests pass live, zero console errors**.
- 2026-07-17 (claude, opus-4.8): **v6 "The Charged Hole"**. Completed the no-hair family by adding
  electric **charge** and generalising the entire engine from Kerr to **Kerr–Newman**. Derived the
  charged spherical-photon-orbit ratios `ξ(r)`, `η(r)`, the RN photon sphere / critical impact
  parameter, and a numeric KN light-ring finder by hand, validated them in a throwaway Node oracle
  (rings = Bardeen to 1e-12 at Q=0; `R=R'=0` to 1e-15; extremal `a*²+Q*²=1` → degenerate horizon at
  r=M; shadow area monotone-decreasing in charge), *then* ported. The charge enters through one
  substitution — the mass function `2Mr → 2Mr − Q²`, `Δ` gains `+Q²` — threaded through the GLSL
  renderer (`uCharge2`: metric, horizon, ergosphere, both disk paths + the KN Kepler frequency), the
  CPU integrators (`cpu-geodesic`, `geodesics`, `probe`, `lineprofile`), and the closed-form
  observables + analytic shadow in `physics/kerr.ts`. Spin and charge now share the extremal budget
  `a*²+Q*² ≤ 1` (UI-clamped). New charge sliders in the Controls, Observatory and Geodesic Explorer;
  three KN presets; a HUD/probe read-out that names the family member (Schwarzschild / Kerr / RN /
  Kerr–Newman); a new primer section on the no-hair theorem. New **"Kerr–Newman (charge)"** self-test
  group cross-checks the charged shadow two independent ways (analytic critical curve vs the
  renderer's own integrated equatorial geodesics, <1%) and the RN limits (`3√3·M → 4M`) — the live
  suite goes **25 → 33 checks**. Full gate green (scope + conformance + lint + tsc + build), the
  suite runs **33/33 in headless Node**, and driven in Chromium against the production build:
  Reissner–Nordström, Kerr–Newman and extremal-charge scenes render with a visibly smaller shadow,
  the Observatory charge slider shrinks the critical curve live, zero console/shader errors.
- 2026-08-01 (claude, opus-4.8): **v7 "Orbits"**. Gave the app its first tracer of **matter** —
  timelike geodesics — after six versions that traced only light. New pure `src/physics/orbits.ts`:
  the equatorial Kerr–Newman inverse metric and radial function `R(r) = (dr/dτ)²`, an exact
  `orbitFromApsides` solver for the conserved `(E, L)` of a periapsis/apoapsis pair (and its
  double-root `circularOrbit` limit), the Bardeen–Press–Teukolsky closed form kept as an oracle,
  prograde/retrograde ISCO + marginally-bound helpers, and a proper-time RK4 integrator that records
  the world-line **and** its cumulative τ (so the animation advances by proper time), measures the
  perihelion **precession** and the radial/orbital periods, tracks the two-clock **time dilation**, and
  classifies bound / plunge / unbound while holding `2H = −1` to ~1e-12. New **Orbit Lab** tab
  (`#/orbits`, `M` key): an animated top-down view of the precessing rosette with a proper-time-paced
  star, the horizon/ISCO/ergosphere/light-rings/marginally-bound circles to scale, a live `R(r)`
  effective-potential inset, spin/charge/periapsis/apoapsis + prograde controls, play/pause + speed,
  six presets (Precessing rosette, Zoom–whirl, Plunge, Near-circular, Retrograde, Charged Kerr–Newman)
  and full read-outs (E, L, eccentricity, precession/orbit, periods, dτ/dt, ISCO/horizon/marg-bound).
  New primer section and a **"Timelike orbits (matter)"** self-test group: circular `E,L` = BPT
  (<1e-4), Ω = GR-Kepler, apsides fix `R=0` (~1e-16), precession = **exact GR** near-circular and →
  Einstein's `6πM/[a(1−e²)]` in the far field, ISCO marginal stability `R″=0` + prograde/retrograde
  split, `r_mb` has E=1, a zoom–whirl orbit conserves the shell while precessing ~150°, the separatrix
  divides plunge from turn, and the orbiting clock runs slow — the live suite goes **33 → 44 checks**.
  Validated all the physics in a throwaway vite-SSR Node oracle first (16 checks; step-size sweep
  proved the *integrator* is exact and the weak-field *formula* is the leading-order term), then ported.
  Purely additive — no shader/renderer files touched. Full gate green (scope + conformance + lint + tsc
  + build), suite **44/44 in headless Node**, and driven in Chromium against the production build.
