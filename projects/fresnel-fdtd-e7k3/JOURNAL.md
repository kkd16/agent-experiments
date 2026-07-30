# Fresnel — FDTD Electromagnetics Lab — journal

An in-browser 2D **Finite-Difference Time-Domain** solver for Maxwell's equations. Paint
optical materials (glass, metal, absorbers), drop in wave sources, and watch electromagnetic
waves propagate, refract, diffract, and interfere in real time on a Yee grid — the same
numerical method used in real photonics and antenna engineering.

This is the app's long-lived memory. Read it first when picking the project back up, then keep
it current.

## What it is (design brief)

- **Physics:** 2D TMz mode FDTD. Fields `Ez`, `Hx`, `Hy` on a staggered Yee grid, leapfrog
  time stepping at the Courant-stable limit. Non-magnetic media with relative permittivity
  `εr` and electric conductivity `σ` (lossy/absorbing). PEC (perfect electric conductor) cells
  for metal. A graded-conductivity absorbing boundary layer (sponge PML) soaks up outgoing
  waves so the domain reads as open space.
- **Interaction:** click to place soft sources (continuous sine, Gaussian pulse, Ricker
  wavelet) at chosen frequency; paint materials with an adjustable brush (vacuum / glass /
  dense glass / metal / absorber, or a custom permittivity); place field probes that stream an
  oscilloscope trace of `Ez(t)`.
- **Presets:** empty space, double-slit diffraction, convex lens focusing, dielectric prism,
  step-index waveguide, Fabry–Pérot cavity, photonic-crystal lattice, Fresnel zone plate.
- **Rendering:** diverging colormap for the signed `Ez` field, materials shown as a subtle
  index overlay, adjustable gain, energy readout, FPS, and a PNG snapshot export. WebGL2 is
  used purely to colour-map and upsample the CPU field texture; the physics runs on the CPU in
  typed arrays for portability and correctness.

## Roadmap / backlog

- [x] Scaffold engine architecture (sim / render / hooks / components split)
- [x] FDTD core: Yee grid, leapfrog update, CFL-stable dt, normalized units
- [x] Material model: εr, σ, PEC mask; per-cell update coefficients
- [x] Absorbing boundary: graded-conductivity sponge layer around the domain
- [x] Sources: continuous sine, Gaussian pulse, Ricker wavelet; soft injection
- [x] WebGL2 field renderer with diverging colormaps + material overlay
- [x] Colormap LUTs (RdBu / inferno / grayscale / spectral)
- [x] Simulation hook: RAF loop, substeps/frame, decoupled from React renders
- [x] Interaction: place source / paint material / erase / probe, with brush size
- [x] Oscilloscope panel plotting live Ez(t) at probes
- [x] Preset scenes: slit, lens, prism, waveguide, cavity, photonic crystal, zone plate
- [x] Control panel UI: sources, materials, sim controls, colormap, gain, energy, FPS
- [x] Hash-routed Guide/About page explaining the physics
- [x] PNG snapshot export
- [x] Polished "lab instrument" dark visual design, responsive layout
- [x] Time-averaged intensity ("long exposure") view — ⟨Ez²⟩ accumulator + GPU mode
- [ ] Stretch: true CPML boundary for near-zero reflection
- [ ] Stretch: TEz mode and full Poynting-vector energy-flux field
- [ ] Stretch: dispersive (Drude/Lorentz) materials for real metals at optical frequency
- [ ] Stretch: adjustable grid resolution presets with auto-CFL retune

## Session log

- 2026-07-30 (claude, claude-opus-4-8[1m]): Created project. Built the full FDTD engine
  (Yee-grid TMz solver, material coefficients, sponge absorbing boundary, three source types),
  a WebGL2 colormap renderer with four palettes and a material overlay, the React simulation
  hook with a render-decoupled RAF loop, the interactive canvas (place source / paint / probe),
  an oscilloscope, eight physics presets, the full control panel, a hash-routed physics guide,
  and PNG export. Verified with `pnpm lint` and `pnpm build`.
- 2026-07-30 (claude, claude-opus-4-8[1m]): Added a time-averaged intensity ("long exposure")
  view. The engine accumulates ⟨Ez²⟩ per cell while active; a new GPU shader mode renders it
  (sqrt-mapped for photographic range) so interference fringes, focal spots, and cavity modes
  resolve into a still image. Added a Field/Intensity toggle and a Reset-exposure control, plus
  a guide section. Verified the double-slit long-exposure fringe pattern in headless Chromium.
