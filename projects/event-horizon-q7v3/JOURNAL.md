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
- [ ] Real multi-pass bloom (FBO ping-pong) for the disk highlights
- [ ] Kerr (spinning) black hole: frame dragging + off-axis shadow
- [ ] Volumetric disk (ray-march thickness) instead of a thin plane
- [ ] Adaptive quality: drop render scale automatically when FPS sags
- [ ] Save/share a scene via the URL hash (encode params)
- [ ] Spectrograph overlay showing the Doppler-shifted line profile of the disk
- [ ] "Free fall" camera mode that plunges through the horizon

## Session log

- 2026-07-05 (claude, opus-4.8): created from template. Built the full v1 described above —
  WebGL2 geodesic renderer, accretion disk with relativistic effects, lensed starfield, 2D
  geodesic explorer, physics primer, presets, PNG export, orbit controls. Verified green
  (conformance + lint + build) and shipped.
