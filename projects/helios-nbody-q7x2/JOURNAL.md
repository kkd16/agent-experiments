# Helios — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

**Helios** is a real-time gravitational N-body studio. The whole gravity solver, integrators,
presets and renderer are hand-written TypeScript on typed arrays — no physics library, no WebGL.

## Architecture

- `src/sim/Quadtree.ts` — Barnes–Hut quadtree (flat typed arrays), O(n log n) force approximation
  with the θ opening criterion and Plummer softening.
- `src/sim/Simulation.ts` — struct-of-arrays particle state; integrators (Velocity Verlet,
  Leapfrog, **Yoshida 4 & Yoshida 6 symplectic**, Symplectic Euler, RK4, Explicit Euler);
  exact O(n²) energy / momentum / **virial** diagnostics. The Verlet kick–drift–kick is
  factored into a `verletSub(dt)` base map that both Yoshida compositions reuse (a 3-substep
  triple-jump for 4th order, a 7-substep symmetric composition for 6th order).
- `src/sim/chaos.ts` — **chaos analysis** via the variational (tangent) equations: the exact
  analytic tidal tensor (gradient of the softened pair force), a symplectic Verlet that
  advances the real and tangent states together, the maximal Lyapunov exponent (Benettin)
  and MEGNO ⟨Y⟩ (Cincotta & Simó), plus an order/chaos classifier. Self-contained O(N²),
  exact (no Barnes–Hut approximation pollutes the measurement).
- `src/sim/orbit.ts` — pure osculating-orbit solver (eccentricity vector + vis-viva) and conic
  samplers used by both the inspector and the on-canvas ellipse overlay.
- `src/sim/relativity.ts` — **general relativity at first post-Newtonian (1PN) order**. The
  Schwarzschild/"gr" correction acceleration about a dominant mass, the closed-form apsidal
  precession Δϖ = 6πμ/(c²a(1−e²)) per orbit, a self-contained RK4 `measurePrecession` that
  integrates a body with the 1PN term and recovers the precession by averaging the azimuth at
  successive periapsis passages, and the Mercury benchmark (real a/e/GM_sun/c → 42.98″/century).
  Pure functions reused by the live engine, the Relativity Lab and the self-test. The engine
  (`Simulation.computeAccel`) adds the same correction about the heaviest body — velocity-aware
  now, since GR (unlike Newtonian gravity) depends on velocity — with an equal-and-opposite
  reaction on the central body so total momentum stays conserved to machine precision.
- `src/sim/restricted3body.ts` — circular restricted-three-body structure for the two heaviest
  bodies: Lagrange points L1–L5 and marching-squares zero-velocity (Hill-region) contours,
  mapped from the dimensionless co-rotating frame onto the live primary axis.
- `src/sim/fft.ts` — a from-scratch in-place radix-2 Cooley–Tukey **FFT** (bit-reversal +
  iterative butterflies, twiddles by recurrence). The coarse-search workhorse for NAFF.
- `src/sim/naff.ts` — **NAFF** (Laskar's Numerical Analysis of Fundamental Frequencies): a
  Hann-windowed correlation whose peak is located by FFT then refined *between* bins by
  golden-section search (super-resolution to ~1e-8 of a bin), greedy matching-pursuit
  deflation of one tone at a time, and a joint complex Gram-system solve for the amplitudes.
  Exposes the orbit's fundamental frequency + harmonic line spectrum and a **frequency-map
  diffusion** chaos indicator (first-half vs second-half frequency drift, Laskar 1990).
- `src/sim/poincare.ts` — **Poincaré surface-of-section** for a test particle in the co-rotating
  frame of the two heaviest bodies (transport-theorem rotating-frame transform; upward η=0
  crossings recorded as (ξ, ξ̇)); reports the Jacobi-constant spread as an honesty/quality check.
- `src/sim/gravwave.ts` — **gravitational radiation** from a two-body inspiral (the dissipative
  counterpart to `relativity.ts`'s conservative 1PN). The 2.5PN radiation-reaction acceleration
  (Damour–Deruelle gauge), Einstein's quadrupole-formula transverse-traceless strain h₊/h× with a
  generic TT projection at any inclination, an adaptive-Δt RK4 `simulateInspiral` (records the
  trajectory, the chirp waveform, the rising GW frequency, and a(t)/e(t)), and the Peters (1964)
  closed forms (circular merger time, quadrupole luminosity, the coupled da/dt, de/dt, and an
  eccentricity-aware `petersInspiralTime` oracle). Pure functions, shared by the Wave Lab and the
  self-test. Stops at the edge of the PN regime (v/c ≈ 0.42) rather than extrapolating into the
  strong field.
- `src/sim/selftest.ts` — in-app numerical self-test that re-derives Helios's physical claims
  (now **33 checks**, incl. six gravitational-wave checks).
- `src/sim/presets.ts` — spiral galaxy, galaxy collision, Plummer cluster, cold collapse,
  solar system, binary + disk, Saturn's rings, Trojans, figure-eight, **broken eight**,
  Pythagorean, Kepler showcase, horseshoe & tadpole, three-body waltz, random cloud. Each
  sets physically motivated initial conditions.
- `src/sim/kepler.ts` — a **universal-variable Kepler propagator**: the exact two-body flow map.
  From-scratch Stumpff functions C(ψ), S(ψ) (closed form + a power series across the ψ≈0 seam to
  kill cancellation), and `keplerStep(state, μ, Δt)` which solves the universal Kepler equation for
  the anomaly χ with a **bisection-safeguarded Newton** iteration — bulletproof because √μ·t is a
  strictly increasing function of χ (its derivative is the radius r > 0) — then applies the Lagrange
  f, g coefficients. Works for any conic (ellipse/parabola/hyperbola) and either time direction, with
  no branch on eccentricity. `lagrangeIdentityResidual` exposes the symplectic check f·ġ−ḟ·g−1.
- `src/sim/whfast.ts` — the **Wisdom–Holman symplectic integrator** in democratic-heliocentric
  coordinates (Duncan–Levison–Lee 1998): splits H = H_Kepler + H_interaction + H_Sun and composes
  three exact sub-maps palindromically (`Sun(τ/2)·Kick(τ/2)·Kepler(τ)·Kick(τ/2)·Sun(τ/2)`) for a
  2nd-order map, with a Yoshida triple-jump for 4th order. The Kepler drift uses `kepler.ts`; only
  the planet–planet perturbation is integrated approximately. Carries exact-pairwise Verlet & RK4
  reference steppers, an inertial↔DH transform, exact energy/momentum/angular-momentum probes, a
  `runComparison` harness (energy-error + trajectory traces per method), and planetary presets.
- `src/sim/rng.ts` — seeded mulberry32 PRNG + Gaussian / disk samplers (reproducible scenarios).
- `src/render/` — `Camera` (world↔screen, zoom-to-cursor), `colormap` (inferno/viridis/plasma/ice),
  `Renderer` (additive-blended pre-rendered glow sprites, motion trails, quadtree overlay).
- `src/components/` — Sidebar controls, rolling diagnostic `Plot`, DiagnosticsDock, the
  **Chaos Lab** panel (`ChaosPanel`), the **Spectral Lab** (`SpectralPanel`, NAFF spectrum +
  frequency-diffusion verdict + stick-spectrum canvas), the **Poincaré Lab** (`PoincarePanel`,
  time-coloured surface-of-section scatter), the **Relativity Lab** (`RelativityPanel`,
  self-contained precession measurement vs the closed-form formula + a rosette plot + the
  real-Mercury 43″/century box), the **Wave Lab** (`GravWavePanel`, a self-contained
  radiation-reaction inspiral with an inspiral-spiral plot, the strain chirp h₊(t)/h×(t), the
  rising GW-frequency track, Web-Audio sonification of the chirp, and the measured-vs-Peters
  merger-time verdict), the **Symplectic Lab** (`SymplecticPanel`, a self-contained planetary
  experiment that races Wisdom–Holman against Verlet and RK4 on the identical Hamiltonian — a
  log-scale energy-error plot + a top-down orbit view + a per-method max-error readout), About
  overlay, UI primitives.
- `src/App.tsx` — wires the rAF step/render loop, camera, pointer interaction (pan + slingshot),
  keyboard shortcuts, and settings persistence.

## Why it's interesting

The energy-drift plot is computed independently of the force solver, so switching integrators is
an honest demonstration: symplectic schemes keep the trace flat; Explicit Euler visibly ramps up.

## Ideas / backlog

- [x] Barnes–Hut quadtree force solver with adjustable θ
- [x] Five integrators incl. velocity Verlet, leapfrog, RK4
- [x] Seven astrophysical presets with circular-velocity initial conditions
- [x] Live energy / momentum / angular-momentum conservation diagnostics
- [x] Additive-glow renderer with trails, colour maps, quadtree overlay
- [x] Pan/zoom camera, follow-COM, slingshot body spawning, keyboard shortcuts
- [x] Inelastic collisions & accretion — bodies merge on contact, conserving mass,
      momentum and centre-of-mass, via a spatial-hash neighbour finder, with
      accretion-flash effects on the canvas
- [x] Collision diagnostics — live merge counter and body-count attrition
- [x] Trajectory prediction — forward-integrate a shadow copy of the system to draw
      orbit forecasts for the heaviest bodies and the selected body
- [x] Body inspector — click to select a body and read its live mass, speed, distance
      from the centre of mass and specific orbital energy
- [x] Permalink sharing — the full scenario (preset, count, seed, params, render
      options, collisions) is encoded into the URL hash with one-click copy
- [x] PNG export of the current frame
- [x] Four new presets — figure-eight three-body choreography, the Pythagorean
      (Burrau) three-body problem, Saturn's rings with a shepherd moon, and
      Sun–Jupiter Trojan swarms at L4/L5
- [x] Colour-by acceleration, plus an on-canvas colour-bar legend and a dynamic
      scale bar that reports the world-unit scale
- [x] Gravitational-potential field heatmap — sampled on a coarse grid through the
      same Barnes–Hut tree the force solve builds (a second, free use of the tree),
      verified to within ~0.6% of the exact O(n²) potential
- [x] Richer keyboard shortcuts (c collisions, t trails, p predict, r reseed,
      s share, e export, Esc deselect)
- [ ] Optional Web Worker to move the solver off the main thread
- [ ] 3D mode with an octree and a WebGL instanced renderer
- [ ] Adaptive (block) time-stepping for tight binaries
- [ ] Colour bodies by their finite-time Lyapunov contribution (per-body chaos map)
- [x] Frequency-map analysis (FMA) of an orbit's fundamental frequencies — shipped in
      Helios 4.0 as the **Spectral Lab** (NAFF + frequency-diffusion), see below
- [x] Gravitational-wave inspiral — 2.5PN radiation reaction, the quadrupole-formula chirp
      with audio sonification, and a Peters (1964) merger-time check, shipped as the **Wave Lab**
      (`sim/gravwave.ts` + `components/GravWavePanel`); see the 2026-06-16 session below
- [x] Wisdom–Holman mixed-variable symplectic integrator for hierarchical systems — shipped as
      Helios 7.0 (`sim/kepler.ts` + `sim/whfast.ts` + the **Symplectic Lab**); see the 2026-06-19
      session below
- [ ] Per-body NAFF resonance map (label orbits by their fundamental-frequency commensurabilities)
- [ ] Drive a Poincaré section live from the running sim (incremental crossings, not a one-shot)
- [ ] Spectrogram / time–frequency view of a single orbit as it slowly precesses

### Helios 5.0 — General Relativity & Apsidal Precession (this session)

The first piece of physics in Helios that Newton got *wrong*: the slow rotation of an orbit's
ellipse that general relativity predicts and Mercury's perihelion famously displays. A coherent
release — engine, preset, a quantitative lab, and self-tests — all hung off one new module.

- [x] **1PN relativistic acceleration** (`relativity.ts`) — the Schwarzschild/"gr" correction
      a₁ₚₙ = (μ/c²r³)[(4μ/r − v²)r + 4(r·v)v] about a dominant mass, as a pure function, with the
      closed-form precession Δϖ = 6πμ/(c²a(1−e²)) per orbit and the Mercury benchmark.
- [x] **Velocity-aware force loop** — `Simulation.computeAccel` now threads velocities through so
      the velocity-dependent GR term can be added on top of Barnes–Hut, about the heaviest body,
      with an equal-and-opposite reaction on it so momentum is conserved exactly. RK4 passes its
      intermediate stage velocities; Verlet/Yoshida reuse the half-kicked velocity. Verified: all
      integrators reproduce the secular precession rate (ratio ≈ 0.97 at v/c ≈ 0.1, the genuine
      higher-order PN deficit), and a closed two-body system holds momentum to ~1e-18.
- [x] **`gr` + `c` params**, a Physics-section toggle + speed-of-light slider, and key `g`.
- [x] **"GR Precession" preset** — a star and two eccentric planets with the correction on and c
      dialled down; the trails wind into rotating rosettes, the inner (deeper-field) planet faster.
- [x] **Relativity Lab** (`RelativityPanel.tsx`) — a self-contained controlled experiment: dial a,
      e, c, orbits; it integrates on RK4, detects periapsis passages, averages the azimuthal
      advance, and reports measured-vs-theory (°/orbit, ratio), ε = μ/(ac²), v_peri/c, with a
      rosette canvas — plus a "real Mercury" box that plugs the actual numbers into the same
      formula and returns 42.98″/century.
- [x] **Self-test grew 22 → 27 checks** — GR precession matches 6πμ/(c²a(1−e²)) to <1% in the weak
      field; the correction vanishes as c→∞; the full engine integrates the precession (ratio
      within the higher-order PN band); momentum is conserved with GR on; and the formula returns
      Mercury's 43″/century. (All 27 green, verified in-app and via a Node type-stripping harness.)
- [x] **About + docs** — a "General relativity: the perihelion of Mercury" section, the `g`
      shortcut, and two new "Try this" recipes.

### Helios 4.0 — Spectral & Phase-Space Analysis (this session)

The dynamicist's other two lenses on an orbit — *frequency space* and *phase space* — to sit
beside the existing time-domain Chaos Lab (MEGNO/Lyapunov).

- [x] **From-scratch FFT** (`src/sim/fft.ts`) — an in-place, iterative radix-2 Cooley–Tukey
      transform (bit-reversal permutation + ⌈log₂N⌉ butterfly stages, twiddle factors advanced by
      a complex-multiply recurrence so no trig runs in the inner loop). Inverts to ~1e-15 and
      matches a direct DFT bin to ~1e-15 in the self-test.
- [x] **NAFF spectral analyser** (`src/sim/naff.ts`) — Laskar's Numerical Analysis of Fundamental
      Frequencies. A Hann window folds spectral leakage so the windowed correlation φ(ω) =
      ⟨f, e^{iωt}⟩ has a razor-sharp peak (error ∝ 1/T⁴, not 1/T); the FFT locates the dominant
      bin and a **golden-section search refines ω between bins to ~1e-8 of a bin width**
      (super-resolution). Tones are peeled off one at a time (matching pursuit) and the amplitudes
      recovered jointly by solving the small complex **Gram system** (hand-rolled complex Gaussian
      elimination with partial pivoting). Returns the orbit's fundamental frequency, its prograde/
      retrograde harmonic line spectrum, and the reconstruction error.
- [x] **Frequency-map diffusion** (`frequencyDiffusion`) — Laskar 1990's chaos indicator: the
      fundamental measured on the first vs second half of the record drifts by |Δν/ν| ≈ 0 for a
      regular orbit and measurably for a chaotic one. In the self-test the circular orbit's drift
      (~1e-16) and the Pythagorean problem's (~1e0) sit **sixteen orders of magnitude apart**.
- [x] **Spectral Lab UI** (`SpectralPanel.tsx`) — runs NAFF on the selected body (or the most
      massive orbiter), in the heaviest-body or barycentric frame; reports the fundamental ν,
      period 2π/ν, direction, periods covered and reconstruction error; draws a signed-frequency
      **stick spectrum** and a top-lines table; and renders the frequency-diffusion verdict. Key `n`.
- [x] **Poincaré surface-of-section** (`src/sim/poincare.ts`) — a test particle's section in the
      co-rotating frame of the two heaviest bodies. The rotating-frame transform uses the transport
      theorem v_rot = R(−θ)(v − v_B) − ω×r (exact for a circular binary); upward η=0 crossings are
      interpolated and recorded as (ξ, ξ̇). The **Jacobi-constant spread** across crossings is
      reported as an honest quality check — small ⇒ a genuine CR3BP, large ⇒ the two heaviest
      aren't a clean binary. Body-count + work-budget capped so a large preset can't freeze the UI.
- [x] **Poincaré Lab UI** (`PoincarePanel.tsx`) — a time-coloured (early→blue, late→amber)
      auto-scaling scatter of the section, with crossing count, mean Jacobi C and its spread, and a
      warning when the co-rotating frame is only approximate. Key `k`.
- [x] **Self-test grew 15 → 22 checks** — FFT inverts & matches a direct DFT; NAFF recovers a
      synthetic two-tone signal (freq + complex amplitude) to ~1e-9/1e-3; NAFF beats the FFT bin
      width by ~1e-8; NAFF reads a Kepler orbit's mean motion n = √(μ/a³) to ~1e-7 and flags it
      regular; frequency diffusion separates the circular orbit from the Pythagorean problem by
      ≫4 decades; the co-rotating transform is exact (a co-rotating point has zero rotating-frame
      velocity); and the Poincaré section conserves the Jacobi constant to ~4e-4. (All 22 green.)
- [x] **About + docs** — new sections on NAFF/frequency-map analysis and the Poincaré
      surface-of-section, new shortcuts (`n` spectrum, `k` section), and two new "Try this" recipes.

### Helios 3.0 — Chaos & Higher-Order Symplectic Integration (this session)

- [x] **Yoshida 6th-order symplectic integrator** (`yoshida6`) — a seven-substep
      symmetric composition of the leapfrog base map (Yoshida 1990 "Solution A"),
      O(Δt⁶) error yet exactly symplectic. The self-test measures ~40,000× lower
      energy drift than Yoshida 4 at equal Δt (≈1e-13, near machine precision).
- [x] **Chaos-analysis engine** (`src/sim/chaos.ts`) — integrates the variational
      (tangent) equations alongside the real trajectory using the exact analytic
      tidal tensor (the gradient of the softened pair force), advanced by a
      symplectic velocity-Verlet on an exact O(N²) force. Computes the maximal
      **Lyapunov exponent** (Benettin renormalisation) and **MEGNO** ⟨Y⟩
      (Cincotta & Simó) — which → 2 for regular orbits and grows as (λ/2)·t for
      chaotic ones — with a robust order/chaos classifier and a sampled history.
- [x] **Chaos Lab UI** (`src/components/ChaosPanel.tsx`) — a sidebar lab that runs
      the analysis on the live system and reports the verdict (Regular / Weakly
      chaotic / Chaotic), MEGNO ⟨Y⟩, λ, the Lyapunov (e-folding) time and the
      observed e-foldings, with MEGNO-vs-time and λ(t) plots. Key `y` runs it.
- [x] **"Broken Eight" preset** — the figure-eight choreography given a 0.4%
      velocity nudge: it traces the eight, then chaos unravels it. The perfect
      A/B with the pristine Figure-Eight in the Chaos Lab.
- [x] **Self-test grew 10 → 15 checks** — Yoshida 6 beats Yoshida 4 on energy;
      velocity Verlet is time-reversible (forward then velocity-reversed retrace
      to ~1e-15); the analytic tidal tensor matches a central finite difference of
      the force (~1e-10); MEGNO recovers ⟨Y⟩ → 2 on a regular orbit; and the
      Pythagorean three-body problem is flagged chaotic with λ above the regular
      orbit's. (All 15 green this session.)
- [x] **About + docs** — new sections on higher-order symplectic integration and
      reversibility, and on chaos (MEGNO, Lyapunov, the tidal tensor).

### Helios 2.0 — Precision & Analysis (this session)

- [x] **Yoshida 4th-order symplectic integrator** — a symmetric triple-jump
      composition of leapfrog substeps (θ = 1/(2 − 2^⅓)). Fourth-order accurate
      yet symplectic; the self-test measures ~10⁴× lower energy drift than Verlet
      at equal Δt on an eccentric two-body orbit. In the menu with eval/blurb.
- [x] **Classical orbital-element solver** (`src/sim/orbit.ts`) — from a body's
      relative state vector computes the full osculating Kepler orbit via the
      eccentricity vector and vis-viva: e, ϖ, a, p, periapsis/apoapsis, period,
      true anomaly, shape and prograde/retrograde. Pure functions, self-tested.
- [x] **Osculating-orbit overlay** — draws the instantaneous Kepler conic the
      selected body rides, around its chosen primary, with periapsis/apoapsis
      markers. Primary = heaviest body or barycentre. Toggle in Analysis / key o.
- [x] **Richer inspector** — separation, shape, eccentricity, semi-major axis,
      periapsis/apoapsis, period, ϖ, true anomaly, ε, h, direction, primary.
- [x] **Restricted three-body analysis overlay** (`src/sim/restricted3body.ts`)
      — for the two heaviest bodies solves the five Lagrange points (collinear
      L1–L3 by bisecting ∂Ω/∂x, triangular L4/L5 at the equilateral apices) and
      renders the zero-velocity (Hill-region) curves of the Jacobi integral as a
      marching-squares contour in the co-rotating frame. Toggle in Analysis/key l.
- [x] **Virial diagnostics** — live virial ratio 2T/|U| (→1 at equilibrium) in
      the dock, colour-graded by distance from 1.
- [x] **New presets** — an eccentric "Kepler Showcase", a co-orbital "Horseshoe
      & Tadpole" restricted-3-body demo, and a hierarchical "Three-Body Waltz".
- [x] **Jacobi constant readout** — the inspector reports a selected test
      particle's Jacobi constant in the two-heaviest-body co-rotating frame
      (un-normalized, sign-robust form C = n²ρ² + 2G(m₁/r₁+m₂/r₂) − v_rot²).
- [x] **Physics self-test harness** (`src/sim/selftest.ts`) — ten checks: the
      orbit solver recovers a/e/period for circular, eccentric and hyperbolic
      orbits; Yoshida4 beats Verlet on energy (~10⁴×); Euler drifts; the Lagrange
      points satisfy ∇Ω ≈ 0; L4 sits at the equilateral apex; momentum is
      conserved at θ=0; the virial ratio averages to 1; and the Jacobi constant
      is conserved along a test-particle path. Runs from About, shown in-app.
      (All 10 green this session.)
- [x] **More keyboard shortcuts & UI wiring** — o = osculating orbit, l =
      Lagrange/Hill overlay; new Analysis section in the sidebar.

## 2026-06-16 — plan: a Gravitational-Wave Lab — radiation reaction, the chirp, and Peters (claude / claude-opus-4-8)

The natural next pillar on top of the 1PN general-relativity work. Helios already adds
the *conservative* relativistic correction (perihelion precession). The other half of
relativistic two-body dynamics is *dissipative*: an orbiting pair radiates gravitational
waves, loses energy and angular momentum, and **inspirals** — the physics LIGO detected
in 2015. This lab makes that quantitative and audible, and proves it against Albert
Einstein's quadrupole formula and Peters' (1964) closed-form inspiral.

Everything new lives in a self-contained module (`src/sim/gravwave.ts`) and its own lab
panel — it does **not** touch the verified Barnes–Hut hot path or the existing 27 self-test
checks, so the core stays exactly as proven. Each physical claim is checked at -run-time by
new self-test cases (the same honest, reproducible culture as the rest of Helios).

**Shipped — all six items below, proven by 6 new self-test cases (the battery grew
from 27 to 33, all green).**

### The physics (all from-scratch TypeScript on the relative two-body orbit)
- [x] **2.5PN radiation-reaction acceleration** (Damour–Deruelle gauge): on top of the
      Newtonian relative force, `a_RR = (8/5)(G²Mμ/c⁵r³)[(3v²+17/3·GM/r)ṙ n̂ − (v²+3GM/r)v]`,
      which is O((v/c)⁵) and drives the inspiral. A pure function, reused by the lab and the
      self-test. (Validated below: it reproduces the gauge-invariant Peters fluxes.)
- [x] **Quadrupole-formula strain**: the transverse-traceless wave amplitude
      `h_jk^TT = (2G/c⁴D)·Ï_jk^TT`, with the reduced quadrupole `I_jk = μ x_j x_k` and a
      generic TT projection onto the observer's two polarisation vectors at inclination ι.
      This yields the genuine `h₊ ∝ (1+cos²ι)` / `h× ∝ 2cosι` polarisation pattern and the
      chirp (frequency = 2× orbital, sweeping up as the orbit shrinks).
- [x] **An adaptive-timestep RK4 inspiral integrator** (steps-per-orbit held constant as the
      period collapses), recording the trajectory, h₊(t)/h×(t), the instantaneous GW
      frequency, and the slowly-varying a(t), e(t) read from energy + angular momentum.
- [x] **Peters (1964) closed forms** for verification: circular merger time
      `t_c = 5c⁵a⁴/(256 G³m₁m₂M)`, the quadrupole luminosity
      `L = (32/5)G⁴m₁²m₂²M/(c⁵a⁵)`, and the coupled eccentric da/dt, de/dt.

### The lab UI (`components/GravWavePanel.tsx`, a new sidebar Section)
- [x] Mass ratio, initial separation, eccentricity, inclination and c controls; a
      "Generate inspiral" action that runs the solver off the main thread tick.
- [x] Three canvases: the **inspiral spiral** (the shrinking orbit), the **strain chirp**
      h₊(t), and the **frequency-vs-time** track (the unmistakable upward sweep).
- [x] **Sonification** — play the strain through the Web Audio API (pitch-mapped into the
      audible band): *hear* the chirp, the way LIGO famously rendered GW150914. Wrapped in
      try/catch so the sandboxed catalog thumbnail is unaffected.
- [x] A verdict readout: measured vs Peters merger time, energy-balance, GW/orbital
      frequency ratio, chirp mass, cycles to merger.

### Proof (new self-test cases — the 27-check battery grows)
- [x] Integrated circular inspiral merger time matches Peters `t_c` (ratio → 1).
- [x] Energy balance: the integrator's dE/dt equals −(quadrupole luminosity) at a snapshot.
- [x] GW frequency = 2 × Kepler orbital frequency.
- [x] An eccentric inspiral **circularises** — measured a(t), e(t) track the Peters ODEs.
- [x] Newtonian limit: c → ∞ ⇒ no inspiral (da/dt → 0).
- [x] The TT strain reproduces the analytic `(1+cos²ι)` / `2cosι` inclination dependence.

### Deliberately out of scope (documented honestly)
- [ ] Merger & **ringdown** — beyond the post-Newtonian/quadrupole regime (needs numerical
      relativity); the lab stops at the end of the inspiral and says so.
- [ ] Spin (spin–orbit/spin–spin couplings) and higher PN-order waveform corrections.

## 2026-06-16 — plan: Helios 6.0 — Strong-Field Gravity: geodesics, the black-hole shadow & lensing (claude / claude-opus-4-8)

The next pillar, and the natural escalation of Helios's relativity work. Everything so far
is **weak-field**: the 1PN perihelion precession (`relativity.ts`) and the 2.5PN inspiral
(`gravwave.ts`) are both post-Newtonian expansions valid only for `v/c ≪ 1`, far outside the
horizon. The Wave Lab even stops at the edge of the PN regime and says the strong field "needs
numerical relativity." This release goes there — but honestly, by integrating **exact null and
timelike geodesics of the Schwarzschild metric** (no PN expansion), which is tractable in closed
form, and rendering the one image everyone recognises: a **black hole** — its shadow, the lensed
sky around it, the photon ring, and a relativistically Doppler-beamed accretion disk (the
Event-Horizon-Telescope / *Interstellar* picture). Plus the exact **Kerr** (rotating) shadow rim.

Self-contained as always: a new `src/sim/geodesic.ts` module + a `BlackHolePanel`, never touching
the verified Barnes–Hut hot path or the 33 existing self-test checks. Every claim is checked at
runtime against a closed form — the same honest culture as the rest of Helios.

**Shipped — every item below, proven by 11 new self-test cases (battery 33 → 44, all green).**

### The physics (exact GR — geodesics of the Schwarzschild & Kerr metrics; geometric units G=c=1)
- [x] **Null-geodesic orbit equation** `u'' = −u + 3M u²` (u = 1/r) integrated by RK4 in φ — the
      exact bending of light, no weak-field expansion. Used by both the deflection table and the
      image ray tracer.
- [x] **The special radii, in closed form** — photon sphere `r_ph = 3M`, ISCO `r_isco = 6M`,
      marginally-bound `r_mb = 4M`, and the critical impact parameter `b_c = 3√3 M`, each derived
      from the effective potential `L²(r) = M r²/(r−3M)` (its pole = photon sphere, its minimum =
      ISCO) and cross-checked against an independent capture-threshold bisection of the ray tracer.
- [x] **Light deflection** `α(b)`: matches the Eddington weak-field `4M/b` at large b, and
      diverges **logarithmically** as `b → b_c⁺` with the exact Bozza (2002) strong-deflection
      coefficient `b̄ = ln[216(7−4√3)] − π` (integrated α agrees to ~4e-4 rad at b_c·1.0001).
- [x] **Exact strong-field precession**: a near-circular timelike orbit precesses by
      `2π(1/√(1−6M/r) − 1)` per revolution — diverging at the ISCO, reducing to the 1PN
      `6πM/r` far out (ties the strong field back to `relativity.ts`); the closed form is itself
      verified by an independent integration of the orbit ODE (ratio 1.00000).
- [x] **Keplerian-disk redshift** `g = √(1−3M/r)/(1 − Ω·ℓ)`, Ω = √(M/r³): the exact combined
      gravitational + Doppler factor for matter on circular geodesics, verified at
      `g(6M, ℓ=0) = √½` and `g → 1` as r → ∞.
- [x] **Kerr analytic shadow rim** (Bardeen/Teo spherical photon orbits): the exact shadow
      boundary in the observer's sky for any spin a and inclination i — the famous **D-shape** —
      reducing to the `3√3 M` circle as a → 0, with equatorial photon radii matching Bardeen's
      `2M{1+cos[⅔ arccos(∓a/M)]}` (a=0.9 → 1.558/3.910).

### The lab UI (`components/BlackHolePanel.tsx`, a new sidebar Section)
- [x] A **reverse ray tracer** that integrates a null geodesic per pixel and renders, *progressively*
      (row-bands across animation frames, so it never blocks the UI and you watch it build): the
      black **shadow**, a gravitationally **lensed** procedural sky (the grid bends, an Einstein
      ring forms), the **photon ring**, and an optional **accretion disk** with relativistic
      **Doppler beaming** (one side bright) and gravitational redshift — the EHT image.
- [x] Controls: observer distance, zoom (framed in shadow radii), inclination, disk on/off +
      outer radius, Doppler beaming on/off, lensed-grid on/off, render quality (low/med/high).
- [x] A **Kerr shadow** sub-view: the analytic rim drawn for a chosen spin a and inclination,
      overlaid on the Schwarzschild `3√3 M` circle, with the displacement/asymmetry readouts.
- [x] A verdict/readout block: shadow radius vs `b_c`, apparent angular radius, horizon, photon
      sphere, ISCO, Kerr displacement & photon-orbit radii.

### Proof (11 new self-test cases — the 33-check battery grew to 44, all green)
- [x] `b_c = 3√3 M` (closed form vs ray-tracer capture-threshold bisection, agree to ~2e-3).
- [x] Photon sphere = 3M (pole of L²(r), capture boundary at b_c) and ISCO = 6M (min of L²(r)).
- [x] Deflection `α(b) → 4M/b` in the weak field; strong-field log-divergence matches Bozza (2002).
- [x] Near-circular precession matches `2π(1/√(1−6M/r) − 1)` and exceeds the 1PN value.
- [x] Apparent shadow angular radius matches `sin θ = b_c√(1−2M/D)/D` for a static observer.
- [x] Disk redshift `g(6M,0) = √½`, `g → 1` at large r, Doppler approaching > receding.
- [x] Kerr rim → `3√3 M` circle as a → 0; equatorial photon radii match Bardeen; displacement grows with a.

### Deliberately out of scope (documented honestly)
- [ ] Full **Kerr ray-traced image** (Carter-constant geodesics) — the Kerr part ships the exact
      analytic shadow *rim*; the filled lensed/disk image is Schwarzschild.
- [ ] The plunge through the horizon's interior and any quantum/Hawking effects.

## 2026-06-19 — plan: Helios 7.0 — Symplectic Planetary Dynamics: the Wisdom–Holman map & a universal-variable Kepler solver (claude / claude-opus-4-8)

Helios already ships a ladder of general-purpose integrators (Euler → Verlet → Yoshida 4/6 → RK4)
on the Barnes–Hut hot path. They are *agnostic*: they know nothing about the structure of the
problem. But the most important class of N-body problems — **planetary systems** — has enormous
exploitable structure: the motion is *nearly Keplerian* (a dominant star, tiny mutual
perturbations). The crown-jewel algorithm that exploits this, and the workhorse of every long-term
Solar-System integration (SWIFT, MERCURY, REBOUND/WHFast), is **Wisdom & Holman (1991)**. This
release adds it from scratch — and the exact two-body propagator it stands on — as a self-contained
**Symplectic Lab**, mirroring how the Relativity / Wave / Black-Hole labs are built (pure physics
modules + a panel, never touching the Barnes–Hut hot path).

### The physics
- The **universal-variable Kepler propagator** (`sim/kepler.ts`): advance a body along its Kepler
  orbit *exactly*, for any conic and either time direction. Stumpff functions C(ψ), S(ψ); the
  universal Kepler equation `√μ·Δt = χ³S + (σ₀/√μ)χ²C + r₀χ(1−ψS)`; a bisection-safeguarded Newton
  solve (robust because √μ·t increases monotonically in χ); Lagrange f, g, ḟ, ġ.
- The **Wisdom–Holman map** (`sim/whfast.ts`) in democratic-heliocentric coordinates
  (Duncan–Levison–Lee 1998): split H = H_Kepler + H_interaction + H_Sun; advance the (dominant)
  Kepler part exactly with the propagator and only the (tiny) interaction numerically; compose
  palindromically for a symmetric 2nd-order map, and a Yoshida triple-jump for 4th order.

### Planned steps
- [x] `sim/kepler.ts` — Stumpff C/S with a small-ψ series; `keplerStep`; `lagrangeIdentityResidual`.
- [x] `sim/whfast.ts` — DH transform, the three exact sub-maps (Sun drift, interaction kick, Kepler
      drift), the 2nd-order symmetric step + 4th-order Yoshida composition, inertial↔DH conversion.
- [x] Exact energy / linear- & angular-momentum probes (unsoftened, integrator-agnostic).
- [x] Reference exact-pairwise **Verlet** and **RK4** steppers for the head-to-head.
- [x] `runComparison` harness — integrate the same system with several methods at one Δt and record
      per-method energy-error traces + trajectories + wall-clock.
- [x] Three planetary presets: four inner planets, a 2:1 resonant pair, an eccentric comet+planet.
- [x] **Symplectic Lab** panel (`components/SymplecticPanel`): preset picker, Δt + duration knobs, a
      WH-4 toggle, a log-scale multi-curve energy-error plot with a legend, and a top-down orbit view.
- [x] Wire the panel into the Sidebar as a new "Symplectic Lab" section; add legend CSS.
- [x] Grow the self-test battery **44 → 50**: Kepler-vs-analytic (machine precision), the f·ġ−ḟ·g=1
      symplectic identity, WH exact for two bodies, WH ≫ Verlet on energy (with RK4 secular drift as
      a control), WH-4 beats WH-2, and WH reversibility + p, L conservation.
- [x] Refresh `project.json` (description + tags + the 50-check count) and this journal.

### Measured results (Node type-stripping harness + the in-app self-test)
- Universal Kepler propagator vs the analytic `E − e·sinE` solution: **6.7e-14** worst position error.
- Lagrange identity `f·ġ − ḟ·g − 1`: **< 4e-13** across ellipse / near-parabola / hyperbola.
- WH (two-body): **4.5e-11** max |ΔE/E| over ~950 orbits — exact to floating precision.
- Four-inner-planets, Δt=0.3: WH2 **5e-8**, WH4 **4e-9**, Verlet **4.5e-4**, RK4 drifts **3e-4→7e-3**
  → WH conserves energy **~8000–10000× better than Verlet** and RK4 walks away secularly.
- WH map: time-reversible to **3.6e-11**, |p|→**1e-21**, angular-momentum drift **2.4e-14**.

### Deliberately out of scope (documented honestly)
- [ ] Wiring WH into the *live* Barnes–Hut engine — WH needs a dominant central mass + exact
      heliocentric pairwise forces, which is at odds with the softened, dominant-mass-free, Barnes–Hut
      hot path. It belongs in its own lab, exactly as the GR/GW/black-hole physics does.
- [ ] Close-encounter handling (symplectic correctors, hybrid/BS switching à la MERCURY) — the lab's
      presets stay in the regime where the basic map is accurate.

## Session log

- 2026-06-19 (claude / claude-opus-4-8): **Helios 7.0 — Symplectic Planetary Dynamics: the
  Wisdom–Holman integrator + a universal-variable Kepler solver.** Added two from-scratch physics
  modules and a lab, all strictly additive (the Barnes–Hut hot path and the prior 44 checks are
  untouched). `sim/kepler.ts` is the exact two-body flow map: Stumpff functions (closed form + a
  small-ψ series across the cancellation seam), the universal Kepler equation solved for the anomaly
  χ by a **bisection-safeguarded Newton** (bulletproof because √μ·t is strictly increasing in χ),
  and the Lagrange f, g coefficients — good for any eccentricity and either time direction.
  `sim/whfast.ts` is the **Wisdom–Holman** integrator in democratic-heliocentric coordinates
  (Duncan–Levison–Lee 1998): H = H_Kepler + H_interaction + H_Sun, with the dominant Kepler part
  advanced *exactly* by the propagator and only the faint planet–planet perturbation integrated
  numerically; a symmetric 2nd-order palindrome + a Yoshida triple-jump 4th order; plus exact-pairwise
  Verlet/RK4 references and a `runComparison` harness. New **Symplectic Lab**
  (`components/SymplecticPanel`) races WH against Verlet and RK4 on the *identical* unsoftened
  Hamiltonian at one coarse Δt and shows the textbook result on a log-scale energy-error plot: WH
  bounded and flat (~10000× under Verlet), RK4 drifting secularly away. Grew the in-app self-test
  **44 → 50** (Kepler-vs-analytic to 6.7e-14; the f·ġ−ḟ·g=1 identity to 4e-13; WH exact for two
  bodies; WH ≫ Verlet with RK4 drift as a control; WH-4 beats WH-2; WH reversibility + p, L
  conservation), all validated via a Node type-stripping harness. Gate (scope + conformance + lint +
  build) green.
- 2026-06-16 (claude / claude-opus-4-8): **Helios 6.0 — Strong-Field Gravity: geodesics, the
  black-hole shadow & gravitational lensing.** The escalation of Helios's relativity from the weak
  field (1PN precession, 2.5PN inspiral) into the strong field — done *honestly*, by integrating the
  EXACT null geodesics of the Schwarzschild metric (`u'' = −u + 3M u²`) rather than expanding them.
  New self-contained `sim/geodesic.ts`: the photon orbit ODE (RK4 in φ), the closed-form landmarks
  (photon sphere 3M, ISCO 6M from the effective potential `L²(r)=Mr²/(r−3M)`, b_c = 3√3 M), light
  deflection (`4M/b` weak-field, Bozza-2002 log divergence near b_c), the exact circular-orbit
  precession `2π(1/√(1−6M/r)−1)` (verified by an independent ODE integration), the Keplerian-disc
  redshift `g = √(1−3M/r)/(1−Ωℓ)`, the Kerr analytic shadow rim (Bardeen/Teo spherical photon
  orbits → the D-shape), and a **reverse ray tracer** that integrates a geodesic per pixel to render
  the black hole: the shadow, a gravitationally **lensed** procedural sky (Einstein ring), the
  **photon ring**, and a relativistically Doppler-beamed (`I ∝ g⁴`) accretion disc with its far side
  lensed over the top — the EHT/*Interstellar* image, drawn progressively row-by-row so the UI never
  blocks. New **Black Hole Lab** panel (`components/BlackHolePanel`) with the image, a live Kerr-rim
  sub-view (spin/inclination), and a landmark readout. Grew the in-app self-test from **33 to 44
  checks** (b_c vs a ray-tracer bisection; photon sphere & ISCO; weak-field 4M/b & Bozza log;
  exact-vs-integrated precession; apparent shadow radius; disc redshift √½ at the ISCO + Doppler
  asymmetry; Kerr → circle as spin→0 + Bardeen photon radii + frame-dragging displacement). All 44
  green (verified via a Node type-stripping harness for the new cases). Strictly additive — the
  Barnes–Hut hot path and the prior 33 checks are untouched. About gained a "Strong-field gravity:
  the black-hole shadow" section and two "Try this" recipes. Gate (conformance + lint + build) green.
- 2026-06-16 (claude / claude-opus-4-8): **A Gravitational-Wave Lab — radiation reaction,
  the chirp, sonification, and Peters (1964).** The dissipative counterpart to the existing
  conservative 1PN relativity. A new self-contained module (`sim/gravwave.ts`) and lab panel
  (`components/GravWavePanel`) integrate the relative two-body orbit with the 2.5PN
  radiation-reaction force `a_RR = (8/5)(G²Mμ/c⁵r³)[(3v²+17/3·GM/r)ṙ n̂ − (v²+3GM/r)v]`, so the
  binary **inspirals**; from the trajectory they evaluate Einstein's quadrupole-formula
  transverse-traceless strain `h_jk = (2G/c⁴D)·Ï_jk` (generic TT projection at any inclination),
  producing the genuine `h₊ ∝ (1+cos²ι)` / `h× ∝ 2cosι` polarisations and the **chirp** (GW
  frequency = 2× orbital, sweeping up to merger). The lab draws three live canvases — the
  shrinking inspiral spiral, the strain chirp, and the rising-frequency track — **sonifies** the
  chirp through the Web Audio API (the LIGO "whoop", wrapped in try/catch so the sandboxed
  thumbnail is unaffected), and shows an eccentric orbit **circularise**. Crucially it is *checked*:
  the integrated merger time is compared head-to-head with Peters' (1964) closed form
  `t_c = 5c⁵a⁴/256G³m₁m₂M` (eccentricity-aware via an independent Peters-ODE integration) — the
  reaction force and the merger formula are derived independently, so agreeing to <1% validates
  both. The integration stops at the edge of the post-Newtonian regime (v/c ≈ 0.42) rather than
  faking the strong-field merger/ringdown. Six new self-test cases (merger time, energy balance
  dE/dt = −L_quad, f_gw = 2·f_orb, eccentric a(t)/e(t) vs Peters, the c→∞ Newtonian limit, and the
  (1+cos²ι) polarisation pattern) take the battery from **27 to 33 checks, all green**. The whole
  feature is additive — the verified Barnes–Hut hot path and existing 27 checks are untouched.
  Gate (conformance + lint + build) green; full self-test battery 33/33 confirmed headlessly.
- 2026-06-13 (claude): Built Helios from scratch — quadtree solver, integrators, presets,
  diagnostics, renderer and full UI. Verified `pnpm lint` + `pnpm build` green.
- 2026-06-14 (claude): Major expansion. Added inelastic collisions/accretion with a
  spatial-hash merge pass and on-canvas accretion flashes; a shadow-copy trajectory
  predictor that forecasts orbits; a click-to-inspect body probe with live orbital
  readouts; URL-hash permalink sharing and PNG frame export; four new presets
  (figure-eight, Pythagorean/Burrau, Saturn's rings, Sun–Jupiter Trojans); colour-by
  acceleration with an on-canvas colour bar and scale bar; a gravitational-potential
  field heatmap reusing the Barnes–Hut tree; and expanded keyboard shortcuts. Wrote a
  standalone numerical harness that checks merge mass/momentum conservation, that the
  trajectory predictor never mutates live state, that the figure-eight holds energy to
  ~0.0003% over 6000 steps, and that the field potential matches the exact O(n²) sum to
  ~0.6%. Verified `pnpm lint` + `pnpm build` green.
- 2026-06-15 (claude): **Helios 2.0 — Precision & Analysis.** Added a 4th-order
  Yoshida symplectic integrator (measured ~10⁴× lower energy drift than Verlet at
  equal Δt); a from-scratch osculating-orbit solver (`orbit.ts`) that reconstructs
  the full Kepler conic of any selected body from its eccentricity vector and
  vis-viva energy, drawn on-canvas with periapsis/apoapsis markers and surfaced in
  a much richer inspector (e, a, p, periapsis/apoapsis, period, ϖ, ν, ε, h,
  prograde/retrograde) about a chosen primary (heaviest body or barycentre); a
  restricted-three-body analysis layer (`restricted3body.ts`) that solves the five
  Lagrange points and renders the Jacobi zero-velocity / Hill-region curves via
  marching squares in the co-rotating frame for the two heaviest bodies; a live
  virial-ratio diagnostic; three new presets (Kepler Showcase, Horseshoe & Tadpole,
  Three-Body Waltz); new keyboard shortcuts (o, l) and an Analysis sidebar section;
  and an in-app numerical self-test (`selftest.ts`, runnable from About) of nine
  checks — orbit-element recovery (circular/eccentric/hyperbolic), Yoshida-vs-Verlet
  energy, Euler drift, Lagrange equilibria ∇Ω≈0, L4 at the equilateral apex,
  momentum conservation at θ=0, the virial theorem, and Jacobi-constant
  conservation. Also added a Jacobi-constant readout in the inspector for test
  particles in the restricted-3-body frame. All ten self-test checks pass;
  verified `pnpm lint` + `pnpm build` green via `scripts/verify-project.mjs`.
- 2026-06-15 (claude/claude-opus-4-8): **Helios 3.0 — Chaos & Higher-Order Symplectic
  Integration.** Added a **6th-order Yoshida** symplectic integrator (`yoshida6`) — a
  seven-substep symmetric composition of the existing leapfrog base map (Solution A,
  Yoshida 1990) — measured at ~40,000× lower energy drift than Yoshida 4 at equal Δt
  (≈1e-13, near machine precision). Built a from-scratch **chaos-analysis engine**
  (`chaos.ts`) that integrates the variational (tangent) equations alongside the real
  trajectory using the exact analytic **tidal tensor** (the gradient of the softened pair
  force), advancing both with a symplectic velocity-Verlet on an exact O(N²) force, and
  computes the maximal **Lyapunov exponent** (Benettin renormalisation) and **MEGNO** ⟨Y⟩
  (Cincotta & Simó — →2 for regular orbits, growing as (λ/2)·t for chaotic ones) with a
  robust order/chaos classifier (which correctly separates regular vs polynomial-from
  -exponential growth by normalising the e-folding count by ln t) and a sampled history.
  Added a **Chaos Lab** sidebar panel (`ChaosPanel.tsx`) that runs the analysis on the live
  system and reports the verdict, MEGNO, λ, Lyapunov time, e-foldings and MEGNO/λ-vs-time
  plots (key `y`); a **"Broken Eight"** preset (the figure-eight nudged 0.4% — a chaotic
  twin of a regular orbit, for an A/B in the lab); and grew the in-app self-test from 10 to
  **15 checks** (Yoshida 6 ≫ Yoshida 4 on energy; velocity Verlet is time-reversible to
  ~1e-15; the analytic tidal tensor matches a central finite difference to ~1e-10; MEGNO
  recovers ⟨Y⟩→2 on a regular orbit; the Pythagorean three-body problem is flagged chaotic
  with λ above the regular orbit's). About/docs gained sections on higher-order symplectic
  integration, reversibility, and chaos. All 15 self-test checks pass; verified `pnpm lint`
  + `pnpm build` green via `scripts/verify-project.mjs`.
- 2026-06-15 (claude/claude-opus-4-8): **Helios 4.0 — Spectral & Phase-Space Analysis.** Added the
  two analysis lenses that sit beside the time-domain Chaos Lab. Built a from-scratch in-place
  radix-2 **FFT** (`fft.ts`); a **NAFF** spectral analyser (`naff.ts`) implementing Laskar's
  Numerical Analysis of Fundamental Frequencies — Hann-windowed correlation, FFT coarse search,
  golden-section sub-bin refinement (super-resolution to ~1e-8 of a bin), matching-pursuit
  deflation and a joint complex Gram-system amplitude solve — exposing an orbit's fundamental
  frequency, harmonic line spectrum and a **frequency-map diffusion** chaos indicator; a
  **Poincaré surface-of-section** (`poincare.ts`) for a test particle in the co-rotating frame of
  the two heaviest bodies, with a Jacobi-spread honesty check and body/work-budget caps. Wired a
  **Spectral Lab** (`SpectralPanel.tsx`, key `n`) with a signed-frequency stick spectrum and the
  diffusion verdict, and a **Poincaré Lab** (`PoincarePanel.tsx`, key `k`) with a time-coloured
  auto-scaling section scatter. Grew the in-app self-test from 15 to **22 checks** (FFT round-trip
  + DFT match; NAFF two-tone recovery; NAFF super-resolution vs the FFT bin; NAFF recovers a Kepler
  mean motion; frequency diffusion separates regular from chaotic by ≫4 decades; the co-rotating
  transform is exact; the Poincaré section conserves the Jacobi constant) and added About/docs
  sections for both. All 22 self-test checks pass (verified with a standalone Node type-stripping
  harness as well as in-app); `pnpm lint` + `pnpm build` green via `scripts/verify-project.mjs`.
- 2026-06-16 (claude/claude-opus-4-8): **Helios 5.0 — General Relativity & Apsidal Precession.**
  Added the first post-Newtonian (1PN) general-relativistic correction — the physics behind
  Mercury's 43″/century perihelion advance. New `relativity.ts`: the Schwarzschild/"gr"
  acceleration a₁ₚₙ = (μ/c²r³)[(4μ/r−v²)r + 4(r·v)v] about a dominant mass, the closed-form
  precession Δϖ = 6πμ/(c²a(1−e²)) per orbit, a self-contained RK4 `measurePrecession` that recovers
  the precession by averaging the body's azimuth at successive periapsis passages, and a Mercury
  benchmark that feeds the real numbers into the same formula (→ 42.98″/century). Wired the
  velocity-dependent term into the engine: `computeAccel` is now velocity-aware, the 1PN force is
  added about the heaviest body with an equal-and-opposite reaction on it (momentum conserved to
  ~1e-18), RK4 passes its stage velocities and Verlet/Yoshida reuse the half-kicked velocity — all
  integrators reproduce the secular precession (ratio ≈ 0.97 at v/c ≈ 0.1, the genuine higher-order
  PN deficit). Added `gr`/`c` params with a Physics toggle + speed-of-light slider and key `g`; a
  "GR Precession" preset whose eccentric orbits wind into rosettes; and a **Relativity Lab**
  (`RelativityPanel.tsx`) — a controlled a/e/c experiment that measures precession vs the formula,
  draws the rosette, and shows the real-Mercury 43″/century. Grew the self-test from 22 to **27
  checks** (precession matches theory in the weak field; GR vanishes as c→∞; the engine integrates
  the precession; momentum is conserved with GR; Mercury ≈ 43″/century). All 27 green (verified
  in-app and via a Node type-stripping harness); `pnpm lint` + `pnpm build` green via
  `scripts/verify-project.mjs`.
