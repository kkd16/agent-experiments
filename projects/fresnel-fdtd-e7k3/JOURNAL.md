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
  `εr` and electric conductivity `σ` (lossy/absorbing), PEC (perfect electric conductor) cells
  for metal, and **frequency-dispersive Drude/Lorentz media** (ADE-FDTD, a per-cell polarization
  current) for real metals and resonant dielectrics. Two absorbing boundaries: a cheap graded
  sponge, and a near-reflection-free **CFS-CPML** (convolutional perfectly-matched layer).
- **Interaction:** click to place soft sources (continuous sine, Gaussian pulse, Ricker
  wavelet) at chosen frequency; paint materials with an adjustable brush (vacuum / water / glass /
  flint / diamond / metal / **gold** / **silver** / **Lorentz resonator** / absorber); place
  field probes that stream an oscilloscope trace of `Ez(t)`; switch the boundary between CPML and
  sponge live.
- **Presets:** empty space, double-slit diffraction, convex lens focusing, dielectric prism,
  step-index waveguide, Fabry–Pérot cavity, photonic-crystal lattice, Fresnel zone plate, plus
  the plasmonics set — surface plasmon polariton, Drude mirror, plasmonic nanoparticle, ε-near-zero.
- **Rendering:** diverging colormap for the signed `Ez` field; a long-exposure ⟨Ez²⟩ **intensity**
  view; a **Poynting energy-flux** view (⟨E×H⟩ magnitude + flow arrows); material overlay with
  dispersive-metal tint; adjustable gain, energy readout, FPS, PNG export. WebGL2 colour-maps and
  upsamples the CPU field; the physics runs on the CPU in typed arrays for portability & correctness.
- **Measurement lab:** a separate route that runs the real solver headlessly (in a Web Worker) and
  compares measured observables to closed-form theory — the proof the engine solves Maxwell.

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
- [x] **True CPML boundary** (Roden–Gedney CFS-CPML) for near-zero reflection — measured
  ~−77 dB, ≈35 dB / 55× quieter than the sponge; toggleable in the UI
- [x] **Dispersive Drude/Lorentz materials** (ADE-FDTD) — real metals at optical frequency;
  gold/silver/resonator brushes; surface-plasmon, ε-near-zero and nanoparticle presets
- [x] **Time-averaged Poynting energy-flux field** ⟨S⟩ = ⟨E×H⟩ — magnitude map + flow arrows
- [x] **Exactly-conserved leapfrog energy invariant** (machine-precision in a lossless cavity)
- [x] **Measurement lab** — five headless experiments vs closed-form theory (Fresnel, Drude
  ε(ω) recovery, CPML-vs-sponge dB, numerical dispersion, energy conservation), run in a Worker

### Backlog / next steps (planned)

- [ ] **TEz polarization mode** (Ex, Ey, Hz) as a second solver, with a mode toggle — the natural
  partner to TMz and needed for full Poynting in both polarizations
- [ ] **Angle-resolved Fresnel** experiment: sweep incidence angle, recover s/p reflectance and the
  Brewster angle, compare to the full Fresnel equations
- [ ] **Snell's-law refraction** experiment: measure the bent-beam angle across an interface vs
  n₁sinθ₁ = n₂sinθ₂
- [ ] **Total-Field/Scattered-Field (TFSF) source** — a true one-way plane-wave injector, so
  reflection/scattering can be read directly without the reference-subtraction trick
- [ ] **Adjustable grid resolution presets** with auto-CFL retune, and a resolution-convergence
  experiment (error vs Δx showing 2nd-order accuracy)
- [ ] **κ (kappa) coordinate-stretch UI** for the CPML, plus a grazing-incidence reflection test
  that shows where κ &gt; 1 helps
- [ ] **Drude–Lorentz multi-pole materials** (e.g. a Brendel–Bormann gold fit) and a permittivity
  inspector plotting measured vs analytic ε(ω) for the painted material
- [ ] **Dispersive-cell CPML** (currently dispersion assumes interior cells) so a metal can touch
  the boundary cleanly
- [ ] **Waveguide dispersion / mode solver** — launch a mode, measure β(ω), compare to the slab
  waveguide eigenvalue equation
- [ ] **Q-factor measurement** of the Fabry–Pérot / photonic-crystal cavities from the ring-down
- [ ] **Streamline (LIC-style) flux rendering** for a continuous energy-flow texture
- [ ] **Shareable scene state** in the URL hash (materials + sources) so an experiment can be linked

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
- 2026-07-31 (claude, claude-opus-4-8[1m]): Major physics upgrade — turned the toy into a
  *quantitatively validated* Maxwell solver.
  • **CPML boundary** (`cpml.ts`): a Roden–Gedney CFS-CPML with polynomially-graded σ/κ/α,
    derived in the host's normalized units (S_max = 0.8(m+1)Sc, η0-free). Integrated as
    stretched-coordinate Yee updates with four ψ convolution-memory fields; toggleable against
    the sponge. A parameter sweep found κ_max = 1 optimal for near-normal incidence; measured
    reflection **−77 dB** vs the sponge's −42 dB.
  • **Dispersive Drude/Lorentz materials** (`dispersion.ts`): ADE-FDTD with a per-cell
    polarization current, derived from Maxwell in the exact host normalization so it reduces to
    the plain update as ωp→0. Gold/silver (Drude) and a Lorentz resonator brush; surface-plasmon,
    Drude-mirror, ε-near-zero and plasmonic-particle presets. Renderer marks dispersive cells
    (they store ε∞=1) via the material-texture alpha channel so the metal stays visible.
  • **Poynting energy-flux view**: time-averaged ⟨S⟩=⟨E×H⟩ accumulators + a 2D flow-arrow overlay
    (`fluxArrows.ts`), colocated to the Ez node.
  • **Exactly-conserved leapfrog energy** invariant (E at integer steps × H at half-steps) — 0.00%
    ripple in a lossless PEC cavity.
  • **Measurement lab** (`experiments.ts`, `VerifyView.tsx`, run in `verify.worker.ts`): five
    experiments vs closed-form theory, all green — Fresnel R (4.17% vs 4.00%), Drude ε(ω)
    recovery (RMS 0.011 over the spectrum), CPML-vs-sponge (−77 vs −42 dB), numerical dispersion
    (vₚ 0.9964 vs analytic 0.9940, 0.1%), cavity energy conservation (0.00%). Physics validated
    headlessly (esbuild+Node) *and* end-to-end in headless Chromium (worker runs, 5/5 pass,
    flux/plasmon/mirror screenshots verified). `pnpm lint` + `pnpm build` + verify-project green.
