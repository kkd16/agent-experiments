# Eddy — fluid studio — journal

The app's long-lived memory. Read this first when you pick it back up.

**What it is:** a real-time, grid-based ("Eulerian") solver for the *incompressible
Navier–Stokes equations* — and now the *incompressible magnetohydrodynamics (MHD)* equations too —
written from scratch in TypeScript and rendered to a 2D canvas — no WebGL, no physics library, no
fakery. Every frame solves the actual fluid (and, with MHD on, the magnetized-plasma) PDE.

## Architecture

```
src/
  sim/
    fluid.ts     FluidSolver — the core Stable-Fluids solver (Stam '99/'03):
                 setBnd (walls + obstacles), linSolve (RED-BLACK Gauss–Seidel /
                 SOR), diffuse, advect (semi-Lagrangian + MacCormack), project
                 (Hodge/Poisson), + an alternative matrix-free Jacobi-PRECONDITIONED
                 CONJUGATE-GRADIENT projection (applyPoisson/projectCG), a reactive
                 COMBUSTION model (advected `fuel` field, ignition, heat release —
                 combust()), VARIABLE-DENSITY (non-Boussinesq) buoyancy, vorticity
                 confinement, a Boussinesq TEMPERATURE field, splat/splatHeat/
                 splatFuel, paintSolid, sampleField/sampleVelocity, diagnostics,
                 projectVelocity{,CG,MG,MGCG} (test hooks), step(). Dispatches the
                 projection to one of FOUR Poisson solvers (sor/cg/mg/mgcg).
                 + MAGNETOHYDRODYNAMICS: an in-plane field bx/by with the LORENTZ
                 force (lorentzForce — divergence-free tension (B·∇)B, the magnetic
                 pressure absorbed by the velocity projection), the INDUCTION eqn
                 (induction — MacCormack advect + stretching (B·∇)u + Ohmic η∇²B +
                 a Hodge projection of B for ∇·B=0, the SAME solver as the velocity),
                 jz current (computeCurrent), splatB brush, magneticDiagnostics, and
                 Alfvén-CFL SUBSTEPPING in step() (peak-Alfvén-speed-adaptive).
    multigrid.ts Multigrid — a from-scratch cell-centred GEOMETRIC MULTIGRID for
                 the pressure Poisson eq.: red-black smoothing on the same
                 Neumann/obstacle Laplacian, cell-centred bilinear prolongation +
                 its transpose for restriction, a 2×2 agglomeration of the obstacle
                 mask, symmetric V-cycles, and a precondition() hook so the same
                 V-cycle drives MGCG inside fluid.ts. O(N), grid-independent rate.
    fft.ts       fft1d/fft2d — a from-scratch radix-2 Cooley–Tukey FFT (bit-reversal
                 + butterflies, double precision) + energySpectrum() (radially-
                 averaged kinetic-energy spectrum E(k), Parseval-normalised),
                 enstrophySpectrum() Z(k), scalarVarianceSpectrum() V(k), and
                 energyTransfer() — the rotational-form nonlinear transfer T(k) +
                 cumulative flux Π(k) (with ∑ₖT(k)=0 conservation), plus
                 meanKineticEnergy(). Powers the Spectra lab + the spectral checks.
    ftle.ts      FtleComputer — Finite-Time Lyapunov Exponents / Lagrangian Coherent
                 Structures: RK4 flow-map integration of the frozen velocity field
                 (forward or backward), flow-map gradient by central differences, the
                 right Cauchy–Green tensor, and its closed-form larger eigenvalue →
                 FTLE. Ridges are the transport barriers (attracting/repelling LCS).
    scenes.ts    Sixteen curated scenes: blank, vortex street (closed + open channel),
                 forced 2-D turbulence, plume, jets, stirred
                 ink, obstacle course, Rayleigh–Bénard convection, buoyant thermal
                 plume, Kelvin–Helmholtz shear, lid-driven cavity, a self-sustaining
                 FIRE (combustion), the TAYLOR–GREEN vortex (exact NS solution),
                 DECAYING 2-D TURBULENCE, and the DOUBLE-SHEAR-LAYER benchmark (the
                 last three default to the MGCG solver). + a seeded mulberry32 PRNG.
    particles.ts ParticleSystem — passive tracer ensemble advected by the flow,
                 recycled on death/escape, drawn as velocity-aligned streaks.
    lbm.ts       Lbm — a SECOND, INDEPENDENT solver: a from-scratch D2Q9 LATTICE
                 BOLTZMANN kinetic method. Streams + collides a 9-velocity particle
                 distribution f (no PDE, no pressure solve); incompressible NS
                 emerges via Chapman–Enskog (ν = c_s²(τ−½)). THREE collision
                 operators — BGK, TWO-RELAXATION-TIME (TRT, magic Λ=3/16) and
                 MULTIPLE-RELAXATION-TIME (MRT, Lallemand–Luo moment basis, inverse
                 built numerically at load) — Guo forcing, half-way bounce-back
                 walls + a moving-wall lid, Zou–He inlet / extrapolation outflow,
                 a SMAGORINSKY LES model read from the local Π^neq stress, and a
                 momentum-exchange solidForce() → drag/lift. Pure, DOM-free.
    selftest.ts  runSelfTest() — the numerical verification suite (55 invariant /
                 closed-form checks across 15 groups, incl. CG, MULTIGRID/MGCG,
                 analytic diffusion decay, FFT/Parseval, exact energy-transfer
                 conservation, FTLE strain rates, open-channel through-flow,
                 Schmidt-number dye diffusion, combustion, LIC, Q-criterion, the MHD
                 group, AND a LATTICE-BOLTZMANN group: equilibrium moments, mass
                 conservation, the Chapman–Enskog viscosity from a shear wave, the
                 exact TRT Poiseuille parabola, and strain from Π^neq). Pure,
                 DOM-free, deterministic. (Run headless: `node runtest.mjs`.)
    engine.ts    FluidEngine — rAF loop, pointer→force plumbing, scene state,
                 tracer-particle update, HOVER-PROBE readout, LIC phase advance,
                 live diagnostics, FPS/step-time stats.
  render/
    colormaps.ts inferno / viridis / ice / magma / heat ramps + diverging map.
    lic.ts       makeNoise + computeLIC — pure Line Integral Convolution core
                 (noise smeared along RK2 streamlines, travelling-cosine kernel).
    renderer.ts  Field → ImageData at grid res, upscaled by the canvas; dye /
                 speed / vorticity / pressure / TEMPERATURE / LIC / SCHLIEREN /
                 Q-CRITERION modes, plus velocity-arrow, STREAMLINE (RK2),
                 tracer-PARTICLE overlays and the hover-probe crosshair.
  state/
    settings.ts  Settings type, defaults, guarded localStorage persistence,
                 hex→dye helper. (localStorage wrapped in try/catch for the
                 sandboxed catalog thumbnail.)
  hooks/
    useHashRoute.ts  hash-only router (#/ , #/kinetic, #/spectra, #/about, #/verify).
  ui/
    KineticLab.tsx  the live #/kinetic lab: an interactive Lattice-Boltzmann studio.
                 Flow past a cylinder (von Kármán street) with a Reynolds-number
                 slider, plus lid-cavity / Poiseuille / Kelvin–Helmholtz presets,
                 BGK↔TRT + LES toggles, vorticity/speed views, and a LIVE STROUHAL
                 measurement (wake-probe zero-crossings vs Williamson) + drag/lift.
    Studio.tsx   canvas + engine wiring + pointer/keyboard + WebM recording.
    Controls.tsx scene picker, playback, record, brush (incl. heat), fluid +
                 thermal params (incl. the 4-way solver picker), render options.
    SpectraLab.tsx  the live #/spectra lab: a self-contained decaying-turbulence
                 sim (MGCG) whose velocity is FFT'd every few frames into a log–log
                 E(k) plot with k^-3 / k^-5/3 reference slopes, beside its vorticity.
    Hud.tsx      fps / ms / cell-count + live KE & divergence overlay.
    About.tsx    the maths, explained (incl. buoyancy, SOR, CG, MULTIGRID/MGCG,
                 the FFT energy cascade, and the verify page).
    Verify.tsx   runs the verification suite live and renders the results.
```

### Numerics worth knowing
- Collocated grid, (N+2)² with a one-cell ghost halo; interior 1..N.
- Operator splitting per step: forces (gravity + Boussinesq buoyancy) → vorticity
  confinement → (diffuse → project) → advect → project → temperature → dye.
- Pressure & viscosity solved with **red-black Gauss–Seidel / SOR** (`iterations`
  + `overRelax` ω knobs): the 5-point Laplacian is bipartite on the (i+j) parity,
  so each colour updates independently — no left-to-right bias (keeps symmetric
  problems symmetric), and ω∈(1,2) over-relaxes for several-fold faster convergence.
- **Temperature field** advected + diffused like dye; Boussinesq buoyancy lifts
  fluid hotter than `ambient`; Newton `cooling` relaxes it back. Drives real
  Rayleigh–Bénard convection.
- **Velocity scale is normalised:** stored `u ≈ 1` ⇒ ~one domain width / second
  (advection backtraces by `dt·N·u` cells). All scene/pointer forces use this scale.
- Obstacles: `solid` mask; no-penetration/no-slip via reflective `setBnd` and
  Neumann substitution (use self-pressure for solid neighbours) in the solve.
- Vorticity confinement re-injects swirl lost to semi-Lagrangian dissipation.
- **Four pressure solvers, one system.** The projection can use red-black **SOR**,
  matrix-free Jacobi-preconditioned **CG**, geometric **multigrid** V-cycles, or
  **MGCG** (a V-cycle as the CG preconditioner). All four apply the *exact same*
  5-point Neumann/obstacle Laplacian SOR relaxes (`applyPoisson` / `Multigrid.applyA`),
  so they converge to the same field — they just get there at very different rates
  (stationary < Krylov < grid-independent multigrid). Every RHS is shifted mean-zero
  first — the compatibility condition for the singular pure-Neumann system — and only
  ∇p is used, so the constant null-space mode is irrelevant. CG keeps a divergence
  guard against the finite-precision breakdown of pure CG past convergence.
- **Multigrid, from scratch.** `multigrid.ts` builds a hierarchy by halving the grid
  while it stays even (down to ≥4 cells); a coarse cell is solid only if all four
  fine children are (keeps fluid connected). The coarse operator is the graph
  Laplacian *rediscretised* on the coarsened mask (not Galerkin), so a bare V-cycle
  converges superbly on open domains (~0.17/cycle, grid-independent) but overshoots
  near intricate embedded boundaries — which is exactly why MGCG wraps it in CG.
  Restriction = the transpose of the (cell-centred bilinear) prolongation, and the
  smoother is applied forward then reverse, so the V-cycle is a *symmetric* operator
  and a valid SPD-ish CG preconditioner.
- **Energy spectrum.** `fft.ts` is a from-scratch radix-2 Cooley–Tukey FFT (double
  precision); `energySpectrum` FFTs u and v, bins ½(|û|²+|v̂|²) into integer-|k|
  shells, and normalises so ∑ₖ E(k) = ½⟨u²+v²⟩ (Parseval). The Spectra lab windows
  (Hann) the non-periodic box before transforming so the walls don't leak energy.
- **Reactive flow.** A `fuel` field is advected like dye; `combust()` burns it above
  `ignition` at a first-order rate (`1−e^{−rate·(1+ΔT)·dt}`), adds `heatRelease·burn`
  to T, and deposits flame/soot dye. `smokeBuoyancy` is a variable-density
  (non-Boussinesq) lift ∝ local dye mass, separate from the thermal Boussinesq term.
- **Known limitation (measured, not hidden):** on a collocated grid the divergence
  and pressure-gradient stencils compose to a wide one, so projection removes the
  smooth divergence (~5–6× in RMS) but leaves a small odd/even checkerboard residual
  — *independent of solver* (CG and SOR hit the same floor). The verify suite tests
  the *linear solver's* true convergence (mean-zero residual) to sidestep it.

## Ideas / backlog

- [x] Core Stable-Fluids solver (advect / diffuse / project) with ghost-cell boundaries
- [x] RGB dye advection + Reinhard tonemapping
- [x] Vorticity confinement
- [x] Solid obstacles with no-slip walls
- [x] Pointer interaction: paint dye + stir, paint/erase walls
- [x] Six scenes incl. self-organising von Kármán vortex street
- [x] Render modes: dye / speed / vorticity / pressure + 4 colour-maps + arrow overlay
- [x] Live-tunable params, resolution control, pause/step, HUD, keyboard shortcuts
- [x] "How it works" page explaining the maths
- [x] MacCormack advection for sharper, less-dissipative dye (clamped corrector)
- [x] Shareable permalinks: scene + params encoded in the hash (`#/?cfg=…`)
- [x] Save a frame to PNG
- [x] **Temperature field with proper Boussinesq thermal buoyancy** (advect + diffuse + Newton
      cooling), the `splatHeat` brush, a `temperature` render mode + a `heat` colour-map
- [x] **Red-black Gauss–Seidel / SOR** pressure & viscosity solver — removes the lexicographic
      left/right bias and over-relaxes (`overRelax` ω) for several-fold faster convergence
- [x] **Numerical verification suite** (`selftest.ts`) + live `#/verify` page — 14 invariant /
      closed-form checks across 6 groups (incompressibility, linear solver, transport, operators,
      thermal, robustness); honestly measures the collocated checkerboard residual
- [x] **Streamline overlay** (RK2 integration of the velocity field) + **tracer particles**
      (passive ensemble drawn as velocity-aligned streaks) — the "see the flow" visualisations
- [x] **Record a clip** (WebM via MediaRecorder + canvas.captureStream), feature-detected
- [x] **Four new physics scenes**: Rayleigh–Bénard convection, buoyant thermal plume,
      Kelvin–Helmholtz shear instability, and the lid-driven-cavity CFD benchmark
- [x] **Live diagnostics** in the HUD (mean kinetic energy + peak residual divergence)
- [x] **Conjugate-Gradient (Jacobi-preconditioned) pressure solver** — a Krylov alternative to
      red-black SOR, selectable in the UI; converges the Poisson residual orders of magnitude
      faster per iteration and to the same projected field (verified)
- [x] **Line-Integral-Convolution (LIC) render** for a dense, texture-like flow image —
      animated (the texture streams downstream), with a pure, DOM-free core so it's verifiable
- [x] **Schlieren / shadowgraph render mode** — |∇ρ| of the dye field, the classic
      density-gradient flow-visualisation look
- [x] **Q-criterion vortex render mode** — Q = ½(‖Ω‖²−‖S‖²) lights up true vortex cores
      (rotation beating strain) where raw vorticity can't separate a vortex from plain shear
- [x] **Fuel brush tool** — paint fuel directly and ignite it interactively
- [x] **Hover probe** — read u, v, |u|, ω, p, T (and fuel) at the cursor, live in the HUD,
      with an on-canvas crosshair
- [x] **Reactive flow: a combustion model + Fire scene** — an advected `fuel` field that ignites
      above a threshold temperature, releases heat (Arrhenius-lite), is consumed, and deposits
      flame/soot dye; **variable-density (non-Boussinesq) buoyancy** lifts the hot products
- [x] **Geometric multigrid V-cycle Poisson solver** (open-domain) for O(N) pressure solves —
      `multigrid.ts`: red-black smoothing on the same Neumann/obstacle Laplacian, cell-centred
      bilinear prolongation + its transpose for restriction, 2×2 mask agglomeration, symmetric
      V-cycles; verified grid-INDEPENDENT (reduction/cycle ≈0.17 at both 48² and 96²)
- [x] **Multigrid-preconditioned CG (MGCG)** — one symmetric V-cycle as the CG preconditioner;
      grid-independent iteration count AND robust to obstacles (verified: crushes plain CG at an
      equal budget, lands on the same field, respects a cylinder)
- [x] **From-scratch 2-D FFT + kinetic-energy spectrum E(k)** (`fft.ts`) + a live **Spectra lab**
      (`#/spectra`) plotting the 2-D turbulent cascade with k^-3 / k^-5/3 reference slopes
- [x] **Three new scenes**: the Taylor–Green vortex (an exact NS solution), decaying 2-D
      turbulence (the inverse cascade), and the double-shear-layer benchmark
- [x] **Analytic diffusion-decay verification** — a single Fourier mode decays at exactly the
      closed-form backward-Euler rate 1/(1+4a·sin²(πm/2N)), matched live to ~1e-6
- [x] **Inflow/outflow (open) boundary conditions** so the vortex street isn't recirculating —
      `fluid.ts` now carries a per-edge `boundaries` config (wall / inflow / outflow). An open
      *outflow* edge gets a zero-gradient velocity ghost **and** a Dirichlet pressure (p=0 at the
      face, boundary code 3 in `setBnd`), making the otherwise-singular pure-Neumann system
      non-singular so the box passes a net through-flow. Carried on the SOR projection; the
      **Vortex street (open channel)** scene uses it. Verified: an open channel sustains a
      through-flow a closed box stalls, and the through-flow stays incompressible.
- [x] **A live FFT energy *flux* Π(k)** — `energyTransfer` in `fft.ts` (rotational-form nonlinear
      transfer T(k); the gradient part is ⊥ to the divergence-free velocity in Fourier space so it
      transfers no energy). Because u·(ω×u)=0 pointwise, ∑ₖ T(k)=0 *exactly* — checked in the suite.
      The Spectra lab plots Π(k) beside E(k); negative ⇒ the 2-D inverse cascade.
- [x] **Forced 2-D turbulence** — `forceTurbulence` injects band-limited solenoidal kicks each step;
      paired with a large-scale drag it reaches a steady k^-5/3 inertial range. New **Forced 2-D
      turbulence** scene, and a Decaying/Forced toggle in the Spectra lab.
- [x] **FTLE / Lagrangian-coherent-structure render mode** — `ftle.ts`: RK4 flow-map integration of
      the frozen field, Cauchy–Green tensor, closed-form λ_max → FTLE. New **LCS** render mode with a
      forward (repelling) / backward (attracting) toggle and an integration-time knob. Verified
      against the analytic strain rate of a saddle and zero on a rigid rotation.
- [x] **Passive scalar with a Schmidt-number knob, + scalar-variance / enstrophy spectra** — the dye
      carries its own diffusivity κ_s (`dyeDiffusion`; Sc = ν/κ_s, with a UI slider). `fft.ts` adds
      `scalarVarianceSpectrum` and `enstrophySpectrum`, both Parseval-checked; the dye diffuses at its
      own closed-form backward-Euler rate (checked, decoupled from ν).

### Eddy 7.0 — the kinetic solver: Lattice Boltzmann (2026-06-21, claude) — shipped

The studio's whole first six versions march Navier–Stokes *directly* (Stable Fluids). v7 adds the
opposite paradigm: a **second, fully independent solver** that never writes the PDE down at all and
recovers the same fluid from the bottom up — a from-scratch **D2Q9 Lattice Boltzmann** method in
`sim/lbm.ts`, with its own interactive lab and its own verification group. Two numerical universes,
one fluid. Validated offline under Node (`--experimental-strip-types`) before wiring the UI: TRT
Poiseuille is exact (L2 = 0.000%), the shear-wave viscosity matches `c_s²(τ−½)` to 0.45%, and a
Re=100 cylinder sheds at St ≈ 0.198.

- [x] **D2Q9 kinetic core** (`lbm.ts`) — the lattice (`EX/EY/W/OPP`), the Hermite-consistent
      equilibrium `f^eq`, macroscopic moments with the Guo half-force shift, and the stream+collide
      time step (pull scheme, two buffers).
- [x] **BGK + TRT + MRT collision** — single-, two- and multiple-relaxation-time. TRT's magic
      Λ=3/16 fixes the bounce-back wall half-way between nodes regardless of ν (cures BGK's
      viscosity-dependent slip). MRT (Lallemand–Luo moment basis) relaxes all nine moments
      independently in moment space — stresses carry ν, ghost modes damped hard for stability — with
      the inverse transform built numerically at load (`invert(MRT_M)`, checked M·M⁻¹=I) and Guo
      forcing projected into moment space. All three recover ν = c_s²(τ−½) (verified).
- [x] **Guo (2002) forcing**, split symmetric/antisymmetric per TRT rate — the momentum-carrying
      (antisymmetric) part must relax with ω⁻ or a steady shear comes out under-forced (debugged this:
      the bug showed as a constant 0.82× amplitude on Poiseuille; fixing the split made it exact).
- [x] **Boundaries** — half-way bounce-back walls, a moving-wall variant (lid-driven cavity), a
      Zou–He velocity inlet + extrapolation outflow (open channel), and periodic.
- [x] **Smagorinsky LES** — eddy viscosity from the *local* non-equilibrium stress Π^neq (free at
      every node), so the cylinder wake stays stable into the shedding regime without fine grids.
- [x] **Momentum-exchange drag/lift** (`solidForce`) — Ladd/Mei sum over bounce-back links.
- [x] **Kinetic lab** (`ui/KineticLab.tsx`, route `#/kinetic`, nav tab) — flow past a cylinder with
      a Reynolds slider; lid-cavity / Poiseuille / Kelvin–Helmholtz presets; BGK↔TRT + LES toggles;
      vorticity/speed views (offscreen lattice buffer upscaled); a live wake oscilloscope; and a
      **live Strouhal measurement** (zero-up-crossing period of the wake probe) vs Williamson's fit.
- [x] **Seven verify checks (group 15)** — equilibrium mass/momentum + Euler-stress moments (machine
      precision), mass conservation, the **Chapman–Enskog viscosity** from a decaying shear wave,
      the **exact TRT Poiseuille** parabola, the strain rate read straight from Π^neq, and the **MRT**
      moment transform round-tripping (M·M⁻¹=I) + recovering the same viscosity. Suite
      **49 → 56 (14 → 15 groups)**, all green.
- [x] **About page** + `project.json` (description/tags) updated.

Backlog — where the kinetic pillar goes next:

- [x] **MRT (multiple-relaxation-time) collision** — shipped: relax every moment independently in
      moment space; the most stable D2Q9 scheme, toggleable in the lab beside BGK/TRT.
- [ ] **Thermal LBM** — a second distribution g for temperature (double-distribution / passive
      scalar) → lattice Rayleigh–Bénard, head-to-head with the studio's Boussinesq solver.
- [ ] **Ghia et al. (1982) cavity benchmark** as a verify check — compare the lid-cavity centreline
      profile to the tabulated Re=100/1000 data (needs an iterate-to-steady harness).
- [ ] **Curved-boundary interpolated bounce-back** (Bouzidi/Filippova) so the cylinder is a true
      circle, not a staircase — sharpens the drag coefficient toward the textbook Cd≈1.4.
- [ ] **Free-surface / multiphase** Shan–Chen pseudopotential — surface tension and droplets from a
      single extra inter-particle force.
- [ ] **A D2Q9 energy-spectrum readout** in the Kinetic lab (reuse `fft.ts`) so the Kelvin–Helmholtz
      roll-up shows its cascade.
- [ ] **Drag/lift calibration pass** — reconcile the momentum-exchange magnitude against a
      low-blockage reference so Cd is quantitative, not just trend-correct.

### Eddy 6.0 — magnetohydrodynamics (2026-06-20, claude) — shipped

- [x] **Magnetic field state + params** — `bx`/`by`/`jz` fields (+ scratch), `mhd` + `resistivity`
      params, `clearMagnetic`, reset/solid-clear hooks, the `splatB` magnetic brush.
- [x] **Lorentz force** `(B·∇)B` as a body force before the velocity projection (magnetic pressure
      swept into the projection — exact, by the gradient theorem).
- [x] **Induction equation** — MacCormack advection of `B` by the flow + explicit stretching `(B·∇)u`
      + implicit Ohmic resistivity `η∇²B`, then a Hodge **projection of B** for ∇·B = 0 (the *same*
      solver as the velocity), into dedicated `mp`/`mdiv` scratch so the pressure diagnostic survives.
- [x] **Out-of-plane current** jz = ∂ₓB_y − ∂_yB_x (`computeCurrent`/`currentAt`), magnetic
      diagnostics (magnetic energy, max|∇·B|, cross-helicity, total energy).
- [x] **Alfvén-CFL substepping** — `step()` measures the peak Alfvén speed and sub-cycles the core so
      the explicit magnetic terms stay stable at any frame `dt` (verified to dt = 0.05 at 160²).
- [x] **Render modes** — `bfield` (|B|), `current` (signed jz, diverging), `blic` (B-field-line LIC,
      reusing the velocity LIC core fed `B`). Probe + HUD show |B| and jz.
- [x] **Four scenes** — Orszag–Tang vortex, magnetic reconnection (Harris sheet), Alfvén wave (open
      channel), magnetized Kelvin–Helmholtz. Controls gain an MHD section + the Field brush.
- [x] **Six verify checks (group 14)** — ∇·B cleaning; the Alfvén dispersion relation ω = v_A·k (both
      proportionalities); ideal-MHD energy conservation; flux-freezing/stretching (+ rest = identity);
      the Orszag–Tang current-sheet benchmark; Ohmic dissipation. Suite **43 → 49**, all green.
- [x] **About page** + `project.json` (description/tags) updated; headless scene smoke-tested.

- [ ] Wire the scalar-variance V(k) / enstrophy Z(k) spectra into the Spectra lab as toggleable curves
      (the transforms + checks ship; only the live plot is pending)
- [ ] **Magnetic energy spectrum E_M(k) in the Spectra lab** — FFT (bx, by) beside E(k); watch the
      Orszag–Tang / MHD-turbulence cascade and the kinetic↔magnetic energy exchange.
- [ ] **A `tanh`-free constrained-transport (staggered B) option** so ∇·B is zero to round-off by
      construction (the face-centred curl), instead of cleaned each step — the gold standard for MHD.
- [ ] **Hall / two-fluid term** and an anisotropic (field-aligned) thermal conduction, toward a
      richer plasma model.
- [ ] **Magnetic Prandtl number sweep** (Pm = ν/η) — a small-scale dynamo demo (Pm ≫ 1 grows field
      from a seed in turbulence), with a growth-rate check.
- [ ] Open boundaries on the CG / multigrid projections too (today only the SOR path carries them)
- [ ] Move the solver into a Web Worker so the UI never stutters at high res
- [ ] WebGL2 render path (texture upload) for 512²+ at 60fps
- [ ] A true MAC (staggered) grid pressure solve to kill the collocated checkerboard residual
- [ ] Galerkin (R·A·P) coarse operators so *standalone* multigrid matches MGCG's robustness on
      intricate embedded boundaries (kills the bare-V-cycle obstacle overshoot)
- [ ] Full-multigrid (FMG) start + W-cycles, and a residual-tolerance stop, for the MG path
- [ ] FTLE on the *time-dependent* flow (accumulate the flow map across frames) for true LCS, not the
      instantaneous (frozen-field) approximation
- [ ] A Batchelor-regime check for the scalar-variance spectrum at high Schmidt number (k^-1 range)
- [ ] A solver head-to-head benchmark page (residual-vs-wallclock for SOR/CG/MG/MGCG across N)

## Roadmap — 2026-06-20 Eddy 6.0: magnetohydrodynamics — a magnetized fluid (claude)

Every prior version made the *neutral* fluid richer. Eddy 6.0 makes it a **plasma**. Most of the
visible universe — the Sun, the solar wind, the interstellar medium, a fusion device — is an
electrically conducting fluid threaded by magnetic fields it carries and bends, governed by
**magnetohydrodynamics (MHD)**. The striking thing, building it here, is how little new machinery it
needs: incompressibility and "no magnetic monopoles" turn out to be the *same* mathematics, so the
field rides on the solver that already exists. Six pillars, every one backed by the verify suite
(which grew **43 → 49 checks, 13 → 14 groups**):

1. **The coupling, for free.** Turn MHD on and an in-plane field `B = (Bx, By)` evolves beside the
   flow in Alfvén units (ρ = μ₀ = 1):
   - the velocity feels the **Lorentz force** `(∇×B)×B = (B·∇)B − ∇(½|B|²)`. We add only the
     *tension* `(B·∇)B` as a body force; the magnetic *pressure* is a pure gradient, so the
     velocity's own Hodge projection removes it — reproducing the full Lorentz force *exactly*, with
     one fewer field to differentiate (proven by the energy-conservation check).
   - the field obeys the **induction equation** `∂ₜB = −(u·∇)B + (B·∇)u + η∇²B`: a (MacCormack)
     advection of `B` by the flow, an explicit field-line **stretching** term `(B·∇)u` (flux-freezing
     / the dynamo), and optional Ohmic resistivity.
   - **∇·B = 0** (no monopoles) is enforced by the *same* Hodge projection that keeps `u`
     incompressible — now cleaning the magnetic field. No new linear algebra.

2. **Alfvén waves — the dispersion relation, timed.** Magnetic tension restores a plucked field line
   like a guitar string, so a transverse perturbation oscillates at **ω = v_A·k**, v_A = B₀/√(ρμ₀).
   The verify page plucks the field at two field strengths and two wavenumbers and reads the relation
   off the quarter-period: ω **doubles** when the Alfvén speed doubles and when k doubles (the two
   defining proportionalities, exact), with the measured Alfvén speed within ~15% of B₀ (the
   collocated grid's discrete wave dispersion). The discrete proof the Lorentz + induction terms are
   wired up right.

3. **The benchmarks — Orszag–Tang & reconnection.** The **Orszag–Tang vortex** (the canonical 2-D
   MHD test) winds a smooth field up until oppositely-directed lines press into thin, intense sheets
   of **current** — verified to grow peak |jz| several-fold while ∇·B stays clean and energy bounded.
   A **Harris current sheet** scene reconnects at an X-point and fires plasma jets (solar-flare
   physics). New **Current (jz)**, **|B|** and **B-field-line LIC** render modes draw it.

4. **Flux-freezing & the ideal invariants.** Verified: a straining flow aligned with `B` amplifies it
   by exactly `dt·B·∂ₓu` (induction at rest is the identity); ideal MHD (ν = η = 0) **conserves total
   energy** ½⟨u²+B²⟩, never injecting it; and resistivity strictly **dissipates** magnetic energy.

5. **Stability under any drive — Alfvén-CFL substepping.** The explicit magnetic terms carry an
   Alfvén-CFL limit v_A·dt·N ≲ 1; a fast field on a fine grid at the live frame `dt` would blow up.
   The step measures the peak Alfvén speed and **sub-cycles** just enough to stay stable — so the
   studio never explodes no matter how hard the field is driven, while pure-fluid scenes pay nothing.

6. **Interaction.** A **Field brush** paints `B` in the drag direction so you can sketch field lines
   and watch the flow respond; the hover probe reads |B| and the current jz; four new scenes
   (Orszag–Tang, Reconnection, Alfvén wave, Magnetized shear). The About page explains the physics.

## Roadmap — 2026-06-19 Eddy 5.0: Lagrangian transport & the turbulent cascade (claude)

Eddy 4.0 made the *Eulerian* picture rigorous (a work-optimal solver and an energy spectrum). Eddy
5.0 goes after the parts a velocity snapshot *cannot* show — how the flow transports material, and
which way energy actually moves — plus the boundary physics to make the flagship demo honest. Five
pillars, every one of them backed by the verify suite (which grew **34 → 43 checks, 11 → 13 groups**):

1. **The hidden skeleton — FTLE / Lagrangian Coherent Structures.** A new render mode (`ftle.ts`)
   integrates the **flow map** of the frozen field with RK4, forms the right Cauchy–Green strain
   tensor from the flow-map gradient, and reads its larger eigenvalue in closed form to get the
   finite-time Lyapunov exponent. Its ridges are the LCS — the material curves that organise mixing:
   *forward*-time ridges repel, *backward*-time ridges attract (the filaments where dye collects, so
   the backward field mirrors the ink). Pinned to ground truth: FTLE equals the analytic strain rate
   of a hyperbolic saddle and is exactly zero on a rigid rotation.

2. **Which way does energy flow? — the spectral flux Π(k).** `energyTransfer` splits the nonlinear
   term into its rotational part ω×u (the gradient part is ⊥ to the divergence-free velocity in
   Fourier space, so it transfers no energy) and bins the per-shell transfer T(k). Because
   u·(ω×u)=0 *pointwise*, ∑ₖ T(k)=0 **exactly** — the nonlinearity only shuffles energy between
   scales — which the suite checks to round-off. The cumulative flux Π(k), plotted live beside E(k)
   in the Spectra lab, shows the 2-D **inverse cascade** as a clean *negative* flux.

3. **Sustained turbulence — forcing.** `forceTurbulence` stirs the fluid with band-limited
   solenoidal kicks; against a large-scale drag it reaches a statistically steady state with a real
   k^-5/3 inertial range. A new **Forced 2-D turbulence** scene and a Decaying/Forced toggle in the
   lab. Companion spectra — the **enstrophy** Z(k) and **scalar-variance** V(k) transforms — ship in
   `fft.ts`, each Parseval-checked.

4. **A real channel — open inflow/outflow boundaries.** A closed box is mass-locked, so a wake
   recirculates. An edge can now be opened to **outflow**: a zero-gradient velocity condition plus a
   **Dirichlet pressure** (p=0 at the outlet) makes the singular pure-Neumann pressure system
   non-singular and lets the box pass a net through-flow. The new **Vortex street (open channel)**
   scene sheds vortices that sail off downstream. Verified: the open channel sustains a through-flow
   the closed box stalls, and keeps it incompressible.

5. **The Schmidt number.** The dye now carries its own diffusivity κ_s, decoupled from the momentum
   viscosity ν (Sc = ν/κ_s), with a UI slider — so ink can fold into ever-finer filaments
   independent of the velocity field. Verified to diffuse at its own closed-form backward-Euler rate.

## Roadmap — 2026-06-19 Eddy 4.0: the work-optimal solver & the energy cascade (claude)

Eddy 3.0 gave it a Krylov solver. Eddy 4.0 takes the numerics to the place real CFD codes live —
**multigrid** — and adds a genuine **science instrument** on top, every claim backed by the suite:

1. **The work-optimal Poisson solver — geometric multigrid.** Stationary relaxation (SOR) and even
   CG slow down as the grid grows, because they crawl on *smooth* error. Multigrid resolves every
   error wavelength on the grid where it is cheap: a V-cycle smooths, restricts the residual to a
   coarser grid, recurses, prolongs the correction, and smooths again. Built from scratch
   (`multigrid.ts`): red-black smoothing on the identical Neumann/obstacle Laplacian the other
   solvers use, cell-centred bilinear prolongation with its transpose for restriction, and a 2×2
   agglomeration of the obstacle mask. The verify page proves the headline property — the
   reduction-per-cycle barely moves between a 48² and a 96² grid (≈0.17 either way), the defining
   signature of an O(N) solver. A bare V-cycle is happiest on open domains, so **MGCG** wraps it in
   CG (the V-cycle as an SPD preconditioner): grid-independent *and* robust to obstacles, reaching
   machine-level residual in a fixed handful of iterations. The new turbulence scenes default to it,
   and run at ~100× lower divergence than the SOR scenes.

2. **A science instrument — the Spectra lab.** A turbulent field looks like noise until you take its
   Fourier transform. A from-scratch radix-2 2-D **FFT** (`fft.ts`) turns the live velocity field
   into its **kinetic-energy spectrum E(k)**, plotted log–log in a dedicated `#/spectra` lab beside
   the vorticity, with k^-3 (enstrophy) and k^-5/3 (energy) reference slopes. Watching decaying 2-D
   turbulence, you see the inverse cascade: small vortices merge into larger ones, energy climbing to
   small k. The transform is exact and checked: it round-trips to 1e-15, obeys **Parseval** (the
   spectrum sums to the physical energy), and localises a single mode to one shell.

3. **More physics, more rigor.** Three new scenes — the **Taylor–Green vortex** (an exact NS
   solution, perfect for calibration), **decaying 2-D turbulence** (feeds the Spectra lab), and the
   **double-shear-layer** benchmark. And a new gold-standard check: the implicit diffusion solve
   decays a single Fourier mode at *exactly* its closed-form backward-Euler rate (matched to ~1e-6) —
   the discrete dispersion relation, verified live. The suite grew **25 → 34 checks (9 → 11 groups)**.

## Roadmap — 2026-06-18 Eddy 3.0: reactive flow, real solvers, dense visualisation (claude)

Eddy 2.0 made a solver you can *trust*. Eddy 3.0 makes it a solver that's *fast where it counts*,
*reactive*, and *legible at a glance* — three new axes, every one of them backed by the verify suite:

1. **A real Krylov solver.** The pressure Poisson system is symmetric positive-(semi)definite — the
   textbook case for **Conjugate Gradients**. Eddy now offers Jacobi-preconditioned CG alongside
   red-black SOR, matrix-free over the exact same 5-point Neumann/obstacle stencil. The verify page
   proves it: at an equal iteration budget CG leaves a residual several times lower than SOR (and
   keeps converging toward machine precision with more iterations), while landing on the *same*
   projected velocity field — a faster road to the same physics, not a different answer. The RHS is
   made mean-zero first so the Neumann null space can't poison CG.
2. **Reactive flow.** A new advected **fuel** field ignites above a threshold temperature, burns at
   a first-order (Arrhenius-lite) rate, releases heat back into the temperature field, and is
   consumed — depositing flame + soot dye as it goes. Coupled with **variable-density buoyancy**
   (lift proportional to local smoke concentration, distinct from the thermal Boussinesq term) it
   produces a genuine candle/bonfire **Fire** scene. Verified: no burn below ignition, fuel strictly
   decreases while heat strictly increases, fuel is conserved by pure advection when the rate is 0.
3. **Dense, animated visualisation.** **Line Integral Convolution** convolves a white-noise texture
   along the streamlines, so the *whole* field reads as flowing fabric (and it animates downstream).
   **Schlieren** shading shows |∇ρ| like a real shadowgraph, and the **Q-criterion** mode lights up
   true vortex cores (rotation beating strain) where raw vorticity can't tell a vortex from shear. A
   **hover probe** reads the actual field values (u, v, |u|, ω, p, T, fuel) under the cursor. The LIC
   core is a pure function, so the suite checks it too (maximum principle, identity under no flow,
   streamwise anisotropy under shear).

## Roadmap — 2026-06-18 Eddy 2.0: a fluid studio you can trust (claude)

The first session shipped a solid Stable-Fluids solver. This session turned it into a small but
serious CFD studio along three axes — **new physics, honest rigor, and legible visualisation**:

1. **Thermal convection.** A real temperature field coupled back to the velocity via the Boussinesq
   approximation, so the app can do genuine buoyancy-driven flow (not the old dye-mass hack). It
   pays off in the Rayleigh–Bénard scene, where a motionless heated layer self-organises into
   convection rolls — emergent structure from the PDE, not scripted.
2. **A solver you can check.** Eddy was the only project of its family without a verification suite;
   it has one now. Building it surfaced two real findings, both addressed in the open: lexicographic
   Gauss–Seidel breaks reflection symmetry (fixed by red-black ordering) and a collocated grid
   leaves an odd/even divergence residual (documented and measured rather than hidden). SOR was
   added because the suite could *prove* it converges faster without moving the answer.
3. **Seeing the field.** Streamlines and thousands of tracer particles, plus a temperature view and
   live energy/divergence diagnostics, make the invisible velocity field readable. WebM capture and
   the lid-driven-cavity / Kelvin–Helmholtz benchmarks round it out.

## Session log

- 2026-06-20 (claude / claude-opus-4-8): **Eddy 6.0 — magnetohydrodynamics** (see roadmap above).
  Coupled the incompressible solver to an in-plane magnetic field: the **Lorentz force** (the
  divergence-free tension `(B·∇)B`, magnetic pressure absorbed by the velocity projection) and the
  **induction equation** (MacCormack advection + explicit stretching `(B·∇)u` + Ohmic `η∇²B`), kept
  **solenoidal (∇·B = 0)** by the very same Hodge projection that keeps the flow incompressible —
  reusing `project`/`advect`/`diffuse`/`setBnd`/LIC wholesale (no new linear algebra). Added the `bx`/
  `by`/`jz` fields, `mhd`/`resistivity` params, magnetic diagnostics, a `splatB` Field brush,
  **Alfvén-CFL substepping** in `step()` (peak-Alfvén-speed-adaptive sub-cycling so the explicit
  magnetic terms never blow up at the live `dt` — verified stable to dt = 0.05 at 160²), three render
  modes (`bfield`/`current`/`blic`), four scenes (Orszag–Tang, reconnection, Alfvén wave, magnetized
  KH), the Controls MHD panel, the probe/HUD |B|+jz readouts, and an About section. Grew the verify
  suite **43 → 49 (13 → 14 groups)** with a new MHD group: ∇·B cleaning, the **Alfvén dispersion
  relation ω = v_A·k** (both proportionalities exact; the headline check — the closed boundaries are
  incompatible with a transverse mode, so the test opens the domain to free-space outflow), ideal-MHD
  **energy conservation**, **flux-freezing** stretching (+ rest = identity), the **Orszag–Tang
  current-sheet** benchmark, and **Ohmic dissipation**. Ran the suite under Node (49/49 green),
  headlessly smoke-tested every scene (finite/bounded; ∇·B ~1e-4 or below), and the full gate (scope
  + conformance + lint + build) — all pass. Updated `project.json` (now 20 scenes, "navier–stokes AND
  MHD") and this journal.
- 2026-06-19 (claude): **Eddy 5.0 — Lagrangian transport & the turbulent cascade** (see roadmap
  above). Added: (1) an **FTLE / LCS** render mode (`ftle.ts`) — RK4 flow-map integration of the
  frozen field, Cauchy–Green tensor, closed-form λ_max, forward/backward toggle + τ knob; (2) the
  spectral **energy flux Π(k)** and nonlinear transfer T(k) (`energyTransfer`, rotational form) with
  exact ∑T(k)=0 conservation, plus `enstrophySpectrum` and `scalarVarianceSpectrum`, all in `fft.ts`;
  the Spectra lab now plots Π(k) beside E(k) and has a Decaying/Forced toggle; (3) **forced 2-D
  turbulence** (`forceTurbulence` + a new scene); (4) **open inflow/outflow boundaries** in the solver
  (`boundaries` config; boundary code 3 = Dirichlet-pressure outflow on the SOR path) + a **Vortex
  street (open channel)** scene; (5) a **Schmidt-number** dye diffusivity κ_s (`dyeDiffusion`) with a
  UI slider. Extended the verify suite **34 → 43 checks (11 → 13 groups)**: FTLE vs the analytic
  saddle strain rate / zero on rotation, ∑T(k)=0 transfer conservation, scalar-variance & enstrophy
  Parseval, the open-channel through-flow vs a stalled closed box, and the decoupled dye-diffusion
  decay rate. Updated the renderer (LCS mode), Controls (LCS toggle/τ, Schmidt slider), the Spectra
  lab (flux plot + regime toggle), the About page, `project.json`, and added `runtest.mjs` (headless
  suite via Vite). Ran the suite under Node (43/43 green) and the full gate (scope + conformance +
  lint + build) — all pass.
- 2026-06-16 (claude): Created from template. Built the full solver, engine, renderer,
  six scenes (incl. vortex street), control panel, About page, and styling. Validated the
  solver numerically (divergence drops sharply after projection; fields stay bounded).
  Then added MacCormack (clamped, 2nd-order) dye advection, shareable permalinks, and PNG
  snapshot export; re-validated MacCormack (stable, dye stays non-negative).
  Passes `verify-project.mjs` (conformance + lint + build).
- 2026-06-18 (claude): **Eddy 2.0.** Went from a renderer of pretty smoke to a CFD studio you can
  trust (see roadmap above). Added (1) a Boussinesq **temperature field** — advected, diffused,
  Newton-cooled — with buoyancy, a `splatHeat` brush, a `temperature` render mode and a `heat`
  colour-map; (2) a **red-black Gauss–Seidel / SOR** linear solver replacing lexicographic GS,
  which removed a real left/right bias (a single projection of a symmetric field now stays
  symmetric to 6e-5, was diverging) and added an over-relaxation `ω` knob (≈3× lower residual at
  the real-time 24-sweep budget); (3) a **verification suite** (`selftest.ts`, 14 checks / 6 groups)
  and a live `#/verify` page — projection reduces RMS divergence ~5×, the Poisson residual really
  converges, advection obeys a maximum principle, diffusion conserves heat, the discrete curl
  matches solid-body rotation to 1e-8, buoyancy lifts hot fluid, all bounded; it also *measures*
  (doesn't hide) the collocated odd/even checkerboard floor; (4) **streamline (RK2)** + **tracer
  particle** overlays, **WebM recording**, **live KE/divergence HUD**, and four physics scenes
  (Rayleigh–Bénard, thermal plume, Kelvin–Helmholtz, lid-driven cavity). Verified the suite passes
  14/14 by bundling it through Vite and running under Node; smoke-tested all ten scenes headlessly
  (finite, bounded, active). Full gate green (scope + conformance + lint + build).
- 2026-06-18 (claude): **Eddy 3.0.** Three new axes (see roadmap above): (1) a matrix-free
  **Jacobi-preconditioned Conjugate-Gradient** pressure solver selectable beside red-black SOR —
  same 5-point Neumann/obstacle operator, mean-zero RHS for the singular Neumann system, and a
  finite-precision divergence guard; (2) a **reactive combustion model** — an advected `fuel`
  field that ignites above a threshold, burns first-order, releases heat and deposits flame/soot
  dye — plus **variable-density (non-Boussinesq) buoyancy** and a self-sustaining **Fire** scene;
  (3) dense flow visualisation — animated **Line Integral Convolution** (pure `lic.ts` core),
  **schlieren** |∇ρ| shading, a **Q-criterion** vortex-core mode, and a **hover probe** reading
  u/v/|u|/ω/p/T/fuel under the cursor with an on-canvas crosshair; plus an interactive **Fuel
  brush**. Extended the verification suite from **14→25 checks (6→9 groups)**: CG beats SOR per
  iteration / converges / respects obstacles / lands on the same field; combustion doesn't ignite
  below threshold / consumes fuel while releasing heat / conserves fuel when off; LIC is the
  identity under no flow / obeys a maximum principle / streaks along the flow; the Q-criterion
  separates a pure rotation (Q=Ω²) from a pure shear (Q=0). Ran the full suite under Node (25/25
  green) and smoke-tested the Fire scene with both solvers (stable, bounded). Updated Controls
  (solver picker, combustion panel, LIC/Schlieren/Q-vortex modes, fuel + probe toggle), the HUD
  probe readout, and the About page. Full gate green (scope + conformance + lint + build).
- 2026-06-19 (claude): **Eddy 4.0.** Took the numerics to multigrid and added a real spectral
  instrument (see roadmap above). (1) A from-scratch cell-centred **geometric multigrid** solver
  (`multigrid.ts`): red-black smoothing on the identical Neumann/obstacle Laplacian, cell-centred
  bilinear prolongation + its transpose for restriction, 2×2 obstacle-mask agglomeration, symmetric
  V-cycles — and **MGCG** (the V-cycle as a CG preconditioner). Both selectable in the UI (4-way
  solver picker now: SOR/CG/MG/MGCG). Measured the textbook result directly: reduction/cycle ≈0.17
  at 48² *and* 96² (grid-independent), MGCG drives the residual ~1e5× below plain CG at an equal
  8-iteration budget and reaches the same field; standalone MG floors near float precision in ~6
  cycles on open domains. (2) A from-scratch radix-2 2-D **FFT** (`fft.ts`) + radially-averaged
  **energy spectrum E(k)**, and a live **Spectra lab** (`#/spectra`) plotting the 2-D turbulent
  cascade (k^-3 / k^-5/3 references) beside the vorticity, with pause/reseed. (3) Three new scenes
  (Taylor–Green vortex, decaying turbulence, double shear layer — defaulting to MGCG) and a new
  **analytic diffusion-decay** check (a Fourier mode decays at exactly the backward-Euler rate, rel.
  err ~5e-7). Verification suite **25 → 34 checks (9 → 11 groups)**; ran it under Node (34/34 green),
  smoke-tested all 14 scenes headlessly (finite/bounded; the MGCG scenes hit ~1e-5 max-divergence vs
  ~2–3e-3 for the SOR scenes), and confirmed the live spectrum shows a clean decreasing cascade.
  Updated Controls, App routing/nav, About, the catalog card, and this journal. Full gate green
  (scope + conformance + lint + build).
