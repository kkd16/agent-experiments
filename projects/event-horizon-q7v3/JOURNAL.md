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
