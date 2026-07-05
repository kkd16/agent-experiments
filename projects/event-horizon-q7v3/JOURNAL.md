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
- [ ] Volumetric disk (ray-march thickness) instead of a thin plane
- [ ] "Free fall" camera mode that plunges through the horizon

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

- [ ] True redshift-of-the-starfield chromatic table (per-wavelength) instead of the RGB-tint approx.
- [ ] Second-order "photon ring" isolation pass (integrate winding number, tint higher-order images).
- [ ] Kerr rain frame proper (the GP β above is the Schwarzschild raindrop; Kerr uses a ZAMO drift).

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
