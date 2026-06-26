# Helios — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

**Helios** is a real-time gravitational N-body studio. The whole gravity solver, integrators,
presets and renderer are hand-written TypeScript on typed arrays — no physics library, no WebGL.

## Architecture

- `src/sim/Quadtree.ts` — Barnes–Hut quadtree (flat typed arrays), O(n log n) force approximation
  with the θ opening criterion and Plummer softening.
- `src/sim/fmm.ts` — the **Fast Multipole Method**: an O(N) gravity solver (Greengard & Rokhlin).
  A kernel-exact, 2-D **Cartesian-Taylor** FMM specialised to Helios's *softened* Newtonian kernel
  1/√(r²+ε²) — because ε removes the singularity the kernel is analytic, so the influence of a
  source cluster is a multivariate Taylor (multipole) expansion of Cartesian moments, the
  cell-to-cell transfer (M2L) convolves those moments against the kernel's own derivatives, and a
  far cluster of targets receives one local Taylor expansion it then evaluates. The kernel
  derivatives come from the **Duan–Krasny (2001) regularised-Coulomb recurrence** (ε rides inside
  s = r²+ε², no special functions). Full machinery: an adaptive quadtree (ncrit bodies/leaf), an
  upward P2M→M2M pass, a **dual-tree traversal** with a multipole-acceptance criterion that fires
  M2L on well-separated cell pairs and direct P2P on near ones, a downward L2L pass, and an L2P
  evaluation whose analytic gradient gives the force a = −∇Φ. Matches `Quadtree.acceleration`
  byte-for-byte in the high-order / small-θ limit — proven against the direct O(N²) sum in the
  self-tests (spectral convergence in the order p; momentum conserved to the expansion error;
  sub-quadratic interaction count). Exposes `fmmAccel`, `directAccel`, `kernelTaylor` and
  `forceError`. The engine can run on it (`Simulation.computeAccel`, `forceSolver: 'fmm'`).
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
- `src/sim/threebody.ts` — the **full planar equal-mass three-body problem in free fall** (the
  engine of the Three-Body Atlas). A 4th-order **Hermite predictor–corrector** (Makino–Aarseth)
  on softened gravity with the analytic **jerk** (da/dt) and the standard Aarseth adaptive
  timestep — the gold-standard small-N integrator. An honest **escape criterion** (a body
  hyperbolically unbound from the *bound* binary of the other two, receding, beyond an escape
  radius, in a clean hierarchy), **outcome classification** (escape/which body, long-lived,
  singular) with an interplay (close-encounter) count and a per-pixel energy-error quality flag,
  the **Agekyan–Anosova region D** parametrisation, named special configurations (Lagrange
  equilateral, Euler collinear, isosceles), and a `recordTrajectory` for the click-to-inspect
  replay. Pure functions; exact conserved-quantity probes (L≡0, fixed COM). Shared by the Lab
  and the self-test.
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

### Helios 10.0 — the Three-Body Chaos Atlas (this session, planned + shipped)

The iconic **Agekyan–Anosova free-fall map**: the only canonical N-body picture Helios was
missing. Three equal masses released from rest; every pixel is one release configuration of
the third body; the colour is the *outcome* of the gravitational scattering. It is the
companion to the *restricted* three-body Resonance Atlas — but here it is the **full,
unrestricted** three-body problem, the textbook example of deterministic chaos.

- [x] `src/sim/threebody.ts` — the full planar equal-mass three-body problem in free fall,
      integrated with a **4th-order Hermite predictor–corrector** (Makino–Aarseth) on softened
      gravity with its **analytic jerk** and the standard **Aarseth adaptive timestep** — the
      gold-standard small-N integrator (energy conserved to ~1e-8 across a chaotic scattering).
- [x] An honest **escape criterion** — a body is an escaper once it is hyperbolically unbound
      from the *bound* binary formed by the other two, receding, and beyond an escape radius;
      records the escape time, the escaper's identity, and the surviving binary's a / e.
- [x] **Outcome classification** — escape (which body), long-lived/bound, or singular
      (deep close approach), plus a count of close-encounter "interplays" and the worst
      energy error, so unreliable pixels can be flagged honestly.
- [x] The **Agekyan–Anosova region D** — m₁,m₂ fixed at (∓½,0); the third body sweeps the
      canonical region (x∈[0,½], y≥0, inside the unit circle about m₁) that represents every
      distinct free-fall triangle up to symmetry. Points outside D are masked.
- [x] A **Three-Body Atlas Lab** panel (`AnosovaPanel.tsx`) — a progressive, rAF-budgeted
      fractal heatmap (like the Resonance Atlas) with four colour modes: **escape time** (the
      fractal), **escaper identity** (three basins), **binary semimajor axis**, and
      **interplay count**; a colormap legend and a live outcome census.
- [x] **Click-to-inspect** — clicking a pixel integrates that exact release and draws its
      trajectory in a mini-canvas (time-coloured), with the pairwise-distance history and the
      measured outcome — "the dance behind the pixel".
- [x] **Launch in Studio** — send a clicked configuration straight into the live N-body engine
      (a new `loadBodies` path) to watch it evolve full-screen with every diagnostic.
- [x] Named special configurations (equilateral **Lagrange homothetic**, **Euler collinear**,
      isosceles) as one-click seeds, with the symmetry/collapse each is famous for.
- [x] Grew the in-app self-test with three-body checks: angular momentum stays **exactly zero**
      for an at-rest start; the centre of mass is fixed; an **isosceles** release keeps its
      mirror symmetry to machine precision; the **equilateral** release stays equilateral as it
      collapses homothetically; energy is conserved across a chaotic scattering; the map is
      deterministic.
- [x] A **zoom into the fractal** — drag a box on the map to re-scan that sub-rectangle of region D
      (the viewport drives the cell→release mapping and the row count from its aspect), exposing the
      basin boundaries' self-similarity; a one-click reset restores the full region.
- [x] **Lifetime statistics** — a log-binned **escape-time histogram** beside the census (the long
      algebraic tail of the three-body lifetime made visible), plus a mean-interplay readout.
- [ ] Move the Anosova scan into a Web Worker so a Fine grid never touches the main-thread budget.
- [ ] A **regularised** (Kustaanheimo–Stiefel / Burdet–Heggie) integrator option so the map is
      exact at zero softening through close approaches.

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
- [x] **Fully ray-traced KERR (rotating) black hole** — integrate Carter-constant null geodesics
      per pixel (the step the Black-Hole Lab's note explicitly deferred), rendering the asymmetric
      shadow + frame-dragging-warped, Doppler-beamed disc, and proving the integrated shadow matches
      the analytic Bardeen/Teo rim; shipped as the **Kerr Lab** in Helios 9.0 (`sim/kerr.ts` +
      `components/KerrPanel`); see the plan below
- [ ] Per-body NAFF resonance map (label orbits by their fundamental-frequency commensurabilities)
- [ ] Drive a Poincaré section live from the running sim (incremental crossings, not a one-shot)
- [x] Spectrogram / time–frequency view of a single orbit as it slowly precesses — shipped in
      Helios 8.0 as the drill-down beneath the Resonance Atlas (`sim/spectrogram.ts`)
- [x] Frequency-map ATLAS — Laskar's frequency-map analysis swept across a 2-D family of initial
      conditions to render the resonance web / Arnold diffusion map; shipped as the **Resonance
      Atlas Lab** in Helios 8.0 (`sim/fma.ts` + `components/AtlasPanel`); see the plan below

## 2026-06-26 — plan: Helios 11.0 — The Fast Multipole Method: O(N) gravity (claude / claude-opus-4-8[1m])

Helios has computed gravity with **Barnes–Hut** since day one — O(N log N), and beautiful, but it
still makes every body walk the tree on its own. The crown that was missing is the **Fast Multipole
Method** (Greengard & Rokhlin, 1987) — one of the *Top-10 Algorithms of the 20th Century* — which
removes the last logarithm by talking **cell-to-cell** and brings the whole force solve down to
**O(N)**. Helios 10.0 builds an FMM from scratch and, crucially, makes it *exact for Helios's own
physics*: the simulation's force law is the **Plummer-softened** Newtonian kernel 1/√(r²+ε²), not the
bare 1/r, so the elegant complex-analytic (log-kernel) FMM does not apply. The softening, though, is a
gift — it makes the kernel **analytic everywhere**, which is exactly the condition for a *Cartesian
Taylor* (kernel-exact) FMM. Source clusters become Cartesian moments M_k = Σ q·v^k; the cell-to-cell
transfer convolves them against the kernel's own Taylor coefficients; and those coefficients obey the
**Duan–Krasny (2001) regularised-Coulomb recurrence**, with ε² folded natively into s = r²+ε² and no
special functions. The result is validated where it counts: against the brute-force O(N²) sum it
accelerates, with an error that falls *geometrically* in the expansion order.

The deliverable is threefold — a correct O(N) solver (`fmm.ts`), the ability to **drive the live
simulation** with it (a Force-solver selector), and an **FMM Lab** that proves both claims live in the
browser: accuracy (the convergence plot) and cost (a log–log scaling plot that pulls away from the
direct sum). Plus seven new self-test checks so the claims are honest and reproducible.

Plan:

- [x] `sim/fmm.ts` — the **multi-index bookkeeping** for 2-D Taylor expansions of total degree ≤ p
      (`triCount`, degree-major packing, a Pascal-triangle table).
- [x] `kernelTaylor` — the normalised kernel derivatives a_{i,j} = (1/(i!j!))∂^{i+j}G via the
      Duan–Krasny three-term recurrence, with the odd-degree sign fixed so they are the **true**
      derivatives (the recurrence expands in −δ). Verified against finite differences.
- [x] An **adaptive quadtree** (counting-sort partition into quadrants, ≤ ncrit bodies per leaf, a
      body-permutation array with per-leaf slices). Pre-order node numbering so a single reverse
      sweep does the upward pass and a forward sweep the downward pass.
- [x] **P2M / M2M** — leaf moments, then binomial-shift aggregation to parents.
- [x] **M2L** — the cell-to-cell transfer: λ_m = −g·Σ_k (−1)^{|k|} C(m+k,m)·a_{m+k}·M_k. Derived by
      hand (multinomial split of (u−v)^n) and verified numerically against direct on a single pair.
- [x] **L2L / L2P** — push locals parent→child, evaluate the local polynomial at each body, take its
      analytic gradient for a = −∇Φ.
- [x] **Dual-tree traversal** with a multipole-acceptance criterion (r_A + r_B ≤ θ·dist → M2L, else
      split the larger cell, leaf×leaf → P2P). Self-overlap resolves by splitting to leaves.
- [x] `directAccel` + `forceError` (max & RMS relative force error) reference helpers.
- [x] Reuse the kernel-coefficient scratch buffer across M2L calls (no per-transfer allocation).
- [x] **Validate the whole thing in Node** (type-stripping harness): kernel-vs-FD; FMM-vs-direct
      convergence p=1…8; momentum; O(N) scaling timing; edge cases (n=0/1/2, coincident, collinear,
      two clusters). Spectral convergence confirmed; momentum to ~5e-7.
- [x] **Wire it as a live force solver** — `forceSolver` + `fmmOrder` on `SimParams`, a branch in
      `Simulation.computeAccel` (θ reused as the FMM separation parameter; the BH tree still built so
      the overlay / potential heatmap / camera-fit keep working), and a **Force-solver** Select +
      order slider in the Sidebar's Physics section.
- [x] **FMM Lab** (`components/FmmPanel.tsx`) — an rAF-budgeted benchmark: an accuracy probe (max/RMS
      error, FMM vs direct timing, speed-up), a **convergence plot** (rms error vs order, log y), and
      a **scaling plot** (log–log time vs N for FMM and direct, with ∝N and ∝N² guide slopes). Wired
      into the Sidebar.
- [x] Grew the in-app self-test (+7 → **78 checks**): kernel Taylor vs finite differences; the O(N)
      force matches the O(N²) sum; error falls geometrically with order; momentum conserved; the
      interaction work is sub-quadratic; and the **live FMM solver conserves energy like Barnes–Hut**.
- [x] About/docs: a "The Fast Multipole Method: O(N) gravity" section; `project.json` description +
      tags. Verified 78/78 in a real browser (Chromium) and `pnpm lint` + `pnpm build` green via
      `scripts/verify-project.mjs`.
- [ ] **Stochastic / variance-based ncrit and θ auto-tuning** — pick the leaf size and acceptance
      that minimise wall-clock for a target error, per scene.
- [ ] **Octree FMM for a future 3-D mode** — the same Cartesian-Taylor machinery generalises to a
      3-D solid-harmonic-free expansion (the recurrence already has a clean d-dimensional form).
- [ ] **Periodic boundaries via an Ewald/FMM lattice sum** — wrap the root cell and add the
      far-field lattice contribution for a cosmological torus.
- [ ] Run the FMM solve **off the main thread** in the existing Web Worker so very large N never
      touches the frame budget.

## 2026-06-22 — plan: Helios 9.0 — Kerr: the spinning black hole, ray-traced (claude / claude-opus-4-8[1m])

The Black-Hole Lab reverse-ray-traces the *exact* null geodesics of the **Schwarzschild** metric —
but its rotating cousin appears only as an *analytic* shadow rim, with a note that read: *"a fully
ray-traced rotating image needs Carter-constant geodesics, left for a future session."* This is that
session. Helios 9.0 adds the **Kerr Lab**: a from-scratch reverse ray tracer that integrates the
genuine null geodesics of the **Kerr** spacetime per pixel and renders the spinning black hole — the
asymmetric shadow, the frame-dragging-warped Einstein ring, and a Doppler-beamed accretion disc on
relativistic prograde circular orbits — then *proves* the integrated shadow boundary lands on the
analytic Bardeen/Teo rim already in the codebase. Nothing here touches the live Barnes–Hut engine.

### The physics (Boyer–Lindquist Kerr, geometric units G = c = 1, lengths in M)

- **Metric & landmarks.** The Kerr metric in Boyer–Lindquist coordinates with `Σ = r² + a²cos²θ`,
  `Δ = r² − 2Mr + a²`, `A = (r²+a²)² − a²Δsin²θ`. Outer horizon `r₊ = M + √(M²−a²)`; ergosphere
  `r_E(θ) = M + √(M²−a²cos²θ)`; horizon angular velocity `Ω_H = a/(r₊²+a²)`; frame-dragging
  `ω(r,θ) = −g_tφ/g_φφ` (the ZAMO/LNRF angular velocity). Prograde/retrograde **ISCO** by the
  Bardeen–Press–Teukolsky (1972) closed form (`6M` at `a=0`; `M`/`9M` at `a=M`), and the equatorial
  photon-orbit radii from `geodesic.ts`.
- **Geodesics, the honest way.** Light follows null geodesics of the metric. We integrate **Hamilton's
  equations** for `H = ½ gᵘᵛ pᵤpᵥ` (which is `0` for light): `ẋᵘ = gᵘᵛpᵥ`, `ṗᵤ = −½ (∂ᵤgᵃᵇ)pₐp_b`.
  `t,φ` are cyclic ⇒ `E = −p_t` and `L_z = p_φ` are conserved exactly; only `(r, p_r, θ, p_θ)` evolve.
  The contravariant metric is written out in closed form; the position derivatives in the force are
  taken by a careful central finite-difference of `H` (validated below), so the integrator is robust
  through the strong field and has no turning-point sign bookkeeping.
- **The hidden constant.** Kerr is integrable thanks to a *third* conserved quantity beyond `E, L_z`:
  **Carter's constant** `Q = p_θ² + cos²θ(L_z²/sin²θ − a²E²)` (null form). It is *not* manifest in the
  Hamiltonian — its constancy along an independently-stepped RK4 trajectory is the sharpest test that
  the geodesic integrator is correct.
- **Image plane (Bardeen 1973).** A photon reaching an observer at inclination `i` carries celestial
  coordinates `α = −ξ/sin i`, `β = ±√(η + a²cos²i − ξ²cot²i)` with `ξ = L_z/E`, `η = Q/E²`. We invert
  this per pixel, fix `E=1`, take `p_r` from the null condition `H=0` (ingoing), and integrate inward.
- **The shadow, integrated vs analytic.** A ray that crosses `r₊` (or winds past the step budget on the
  photon shell) is captured → black; one that escapes reads its asymptotic direction off a procedural
  sky → **gravitationally lensed**. The boundary between the two — found by *bisecting the ray tracer*
  in `α` along `β=0` — must coincide with the analytic Bardeen/Teo rim `kerrShadowRim`. As `a→0` it
  collapses onto the Schwarzschild `b_c = 3√3 M` circle. Frame dragging displaces the prograde edge
  inward and the retrograde edge outward (the famous D-shape).
- **Doppler-beamed disc.** Disc gas rides prograde circular geodesics at `Ω = √M/(r^{3/2}+a√M)`; the
  observed/emitted frequency ratio is `g = √(−(g_tt + 2Ω g_tφ + Ω² g_φφ)) / (1 − Ω ξ)`, beaming the
  approaching side (`I ∝ g⁴`). As `a→0` this reduces *exactly* to the Schwarzschild
  `√(1−3M/r)/(1−Ωℓ)` already in `geodesic.ts` — a clean cross-check.

### Planned steps — all shipped this session

- [x] `sim/kerr.ts` — the Kerr engine: closed-form covariant + contravariant metric, landmarks
      (`r₊`, ergosphere, `Ω_H`, frame-drag `ω`, ISCO±), the null Hamiltonian + Hamilton's-equation
      RHS with FD position-derivatives, an adaptive RK4 geodesic stepper, Carter `Q`, the per-pixel
      `(α,β)→(initial momenta)` setup, a `kerrTraceRay` classifier (`captured | escaped | disc`), the
      `kerrShadowAlphaAtBeta0` bisection of the tracer, the prograde-disc redshift `g`, and progressive
      band renderer `renderKerrBands`.
- [x] `components/KerrPanel.tsx` — the **Kerr Lab**: spin/inclination/zoom/disc/Doppler/quality
      controls, a progressive reverse-ray-traced image with the analytic rim overlaid on it, and a
      readout (`r₊`, `r_E`, `Ω_H`, ISCO±, prograde/retrograde shadow edges) — self-contained, never
      touching the live engine.
- [x] Wire the Kerr Lab into the Sidebar; update the Black-Hole Lab's "future session" note to point
      at it; remove the now-obsolete caveat.
- [x] Grew the in-app self-test (+9): metric inverse `gᵘᵛg_νσ = δ`; `H≈0` conserved along a geodesic;
      **Carter `Q` conserved**; the FD force matches a finer-FD reference; `a→0` ray-traced shadow →
      `3√3 M`; the **integrated shadow edges match the analytic Bardeen rim** at `i=90°`; frame-drag
      asymmetry (prograde edge < retrograde edge); ISCO± closed form (`6M`; `M`/`9M`); Kerr disc
      redshift → Schwarzschild `diskRedshiftFactor` as `a→0`; `Ω_H = a/(r₊²+a²)`.
- [x] About/docs: a "Kerr: the spinning black hole, ray-traced" section; `project.json` description +
      tags (`kerr-geodesics`, `carter-constant`, `frame-dragging`, `ergosphere`, `isco`); session log.

### Deliberately out of scope (documented honestly)

- We render the **direct image + first photon-ring crossings** of a geometrically-thin, optically-thin
  disc with the exact relativistic shift — not a full radiative-transfer / GRMHD simulation.
- The disc sits in the equatorial plane on *circular* prograde geodesics from the ISCO outward; we do
  not model plunging gas inside the ISCO or a finite disc thickness.
- Position derivatives in the geodesic force use a validated central finite-difference rather than the
  hand-expanded analytic ∂ᵣgᵃᵇ/∂_θgᵃᵇ — chosen for robustness; correctness is pinned by Carter-`Q`
  conservation, the `H≈0` null condition, and the analytic-rim match.

## 2026-06-22 — plan: Helios 8.0 — The Resonance Atlas: Frequency-Map Analysis & Time-Frequency Spectroscopy (claude / claude-opus-4-8)

Helios already measures *one* orbit's frequency (the Spectral Lab's NAFF) and one orbit's chaos
(the Chaos Lab's MEGNO/Lyapunov, the Spectral Lab's frequency diffusion). The next escalation is to
sweep that measurement across a whole **family** of orbits and draw the structure it reveals — the
single most celebrated product of modern celestial mechanics: **Laskar's frequency-map analysis
(FMA)**, the technique that produced the diffusion portrait of the Solar System and the asteroid
belt's resonance web (the "Arnold web").

### The physics (a self-contained, canonical model — the planar circular restricted three-body problem)

- The Atlas is computed in the **dimensionless rotating frame** of the Sun–Jupiter problem (primaries
  fixed at (−μ,0) and (1−μ,0), unit mean motion), independent of the live Barnes–Hut engine — so it
  is exactly reproducible and carries no body-count limit. The effective potential is
  `Ω = ½(x²+y²) + (1−μ)/r₁ + μ/r₂`; the equations of motion are `ẍ = 2ẏ + Ωₓ`, `ÿ = −2ẋ + Ω_y`
  (the `2ẏ`/`−2ẋ` are the Coriolis force, the `+x`/`+y` in ∇Ω the centrifugal); the lone integral is
  the **Jacobi constant** `C = 2Ω − (ẋ²+ẏ²)`.
- A test particle is launched on an osculating Kepler ellipse about the Sun (primary 1) from orbital
  elements (semimajor axis `a`, eccentricity `e`), mapped into the rotating frame by subtracting the
  frame rotation `ω×r`. We integrate it (RK4, fixed small step) and record the **inertial** signal
  `Z(t) = (x+iy)·e^{i t}` — whose dominant NAFF frequency is the orbit's mean motion `n`.
- Measuring `n` on the first vs the second half of the record gives the **frequency-diffusion** index
  `D = log₁₀|Δn/n|` (reuses `naff.frequencyDiffusion`): `D ≲ −6` on a regular torus, `D ≳ −3` in the
  chaotic resonance-overlap zones. Swept across the `(a, e)` plane it is the resonance/diffusion map.

### Planned steps — all shipped this session

- [x] `sim/fma.ts` — the FMA engine: effective potential `Ω`, its analytic gradient `∇Ω`, the Jacobi
      constant, an RK4 rotating-frame integrator, IC construction from `(a, e)`, single-orbit signal
      recording, and `computeCell(a, e, μ, opts)` → `{ freq n, logDiffusion D, jacobiDrift, escaped }`.
- [x] Progressive 2-D scan: `AtlasPanel` walks the `(a, e)` grid on `requestAnimationFrame` inside a
      14 ms-per-frame budget, so the heatmap fills in live without ever blocking the main thread.
- [x] `components/AtlasPanel.tsx` — the **Resonance Atlas Lab**: a canvas heatmap (x = a, y = e) with
      two colourings — **diffusion** (the chaos/Arnold-web view) and **frequency** (resonance plateaus),
      a colour-bar, hover readout `(a, e, n, D)`, resonance-line guides `n = p/q`, a region/μ preset
      picker, a resolution slider, and a progress bar with stop.
- [x] `sim/spectrogram.ts` — a sliding-window (Hann) short-time spectrum of a complex signal: per-slice
      windowed FFT magnitude + a NAFF fundamental **ridge**, returning a time×frequency magnitude map.
- [x] Drill-down: **click a cell** in the Atlas to integrate that exact orbit longer and draw its
      **time-frequency spectrogram** below (using the valid prefix even when a chaotic orbit escapes).
- [x] Grew the in-app self-test **50 → 56**: the analytic `∇Ω` vs central differences (1e-10); `∇Ω`
      consistency with `restricted3body.omegaGradient` (machine eps); the RK4 integrator conserving
      Jacobi (≈2e-9); the **Kepler frequency law** `n = a^{-3/2}` recovered end-to-end (5e-6); the
      diffusion separating a regular orbit from a chaotic one by ~5 decades; the spectrogram ridge
      tracking a synthetic **chirp** upward while staying flat for a pure tone.
- [x] About/docs: a "Frequency-map analysis: the resonance web" section + a "Try this" recipe.
- [x] `project.json` description + tags (`frequency-map-analysis`, `arnold-web`, `resonance`,
      `kirkwood-gaps`, `restricted-three-body`, `spectrogram`); JOURNAL session-log entry; gate green.

### Deliberately out of scope (documented honestly)

- The Atlas is the **planar circular** RTBP (the standard FMA testbed), not the live elliptic /
  N-body field — coupling it to the running engine is a future step.
- We measure the diffusion of the *dominant* line `n`; a full Laskar proper-element pipeline would
  track a fixed quasi-periodic basis and its combinations. The speckle this leaves on the map is
  authentic to real FMA portraits, not a bug.

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

### Helios 10.0 — the Three-Body Atlas (this session)

The one canonical N-body picture Helios was missing. The Resonance Atlas maps the *restricted*
problem (a massless test particle); this maps the **full, unrestricted** three-body problem —
the original textbook example of deterministic chaos.

#### The physics (a self-contained, exact model — equal-mass planar free fall)

Three equal unit masses (G = m = 1) are released **from rest** from a triangle and integrated to
their outcome. From almost any triangle the generic story is the same: a chaotic *interplay* of
close passages that ends with one body **ejected** while the other two settle into a bound binary.
The outcome depends so sensitively on the starting triangle that the map of outcomes is a fractal.

- **Integrator.** A from-scratch 4th-order **Hermite predictor–corrector** (Makino & Aarseth
  1992) on softened gravity, using the analytic acceleration **and jerk** (da/dt) and the standard
  Aarseth adaptive timestep `dt = √(η·(|a||a₂|+|j|²)/(|j||a₃|+|a₂|²))`. For N = 3 this is the
  gold standard — it resolves the violent close approaches that drive the chaos while conserving
  energy to ~1e-5 (fine) / ~1e-3 (map preset) across a whole scattering of dozens of encounters.
- **Escape criterion (honest).** A body has escaped once the *other two* form a bound binary
  (E_bin < 0), the candidate is hyperbolic relative to the binary's barycentre (E_k > 0) and
  receding (R·V > 0), it is beyond an escape radius, **and** the hierarchy is clean (R > 2·a_bin).
  Records the escape time, the escaper's identity and the surviving binary's a/e.
- **Region D.** With m₁,m₂ at (∓½,0), the third body sweeps the canonical Agekyan–Anosova region
  (x∈[0,½], y≥0, inside the unit circle about m₁), which represents every distinct free-fall
  triangle up to translation/rotation/reflection/scale. Points outside D are masked.

#### The Lab UI (`components/AnosovaPanel.tsx`, a new sidebar Section)

A progressive, requestAnimationFrame-budgeted **fractal heatmap** (every pixel = one release,
integrated live, never blocking the main thread) with four colour modes — **lifetime** (the
escape-time fractal), **escaper** (three interleaved basins), **binary a**, and **interplays** —
a colormap legend and a live **outcome census** bar. **Click any pixel** to replay *the dance
behind it*: the actual trajectory in a time-shaded mini-canvas plus the pairwise-separation
history (log) and the measured outcome. **Launch in Studio** sends the exact configuration into
the live Barnes–Hut engine (a new `loadBodies`-style path in `App.tsx`) to watch it scatter
full-screen with every diagnostic. Five named special triangles (Lagrange equilateral, Euler
collinear, isosceles, …) are one-click seeds.

#### Proof (6 new self-test cases — the battery grew 66 → 72, all green)

Total angular momentum of an at-rest triple is **exactly zero**; the centre of mass is fixed; the
Hermite scheme conserves energy through a chaotic scattering; the map is **deterministic** (same
triangle → identical outcome, the prerequisite for a fractal); an **isosceles** release keeps its
mirror symmetry to machine precision; and a perfect **equilateral** release collapses
**homothetically** (the Lagrange central configuration, shape deviation < 1e-9). Verified with a
standalone Node type-stripping harness as well as in `tsc -b`.

#### Deliberately out of scope (documented honestly)
- The map uses **softened** gravity (a smoothed variant of the classical point-mass map). A
  regularised (KS / Burdet–Heggie) integrator for the exact zero-softening map is on the backlog.
- "Long-lived" pixels are those that don't resolve within the time/step budget — genuinely the
  long algebraic tail of the three-body lifetime distribution, shown as a distinct category rather
  than forced to a verdict.

## Session log

- 2026-06-26 (claude / claude-opus-4-8[1m]): **Helios 11.0 — the Fast Multipole Method: O(N)
  gravity.** Added the algorithm Helios was missing — an FMM that brings the force solve from
  Barnes–Hut's O(N log N) down to **O(N)** — and made it *exact for Helios's softened Newtonian
  kernel*. New `sim/fmm.ts`: a kernel-exact **2-D Cartesian-Taylor** FMM. Because the Plummer
  softening makes 1/√(r²+ε²) analytic, a source cluster's pull is a multivariate Taylor expansion of
  Cartesian moments; the cell-to-cell transfer (M2L) convolves those moments against the kernel's own
  derivatives, which come from the **Duan–Krasny (2001) regularised-Coulomb recurrence** (ε folded
  into s = r²+ε², no special functions — the recurrence's odd-degree sign corrected so the
  coefficients are the true derivatives, verified against finite differences). Full pipeline: an
  adaptive quadtree (counting-sort quadrant partition, ≤ ncrit/leaf, pre-order numbering), an upward
  **P2M→M2M** pass, a **dual-tree traversal** with a multipole-acceptance criterion (M2L on
  well-separated cells, direct P2P on near ones), a downward **L2L** pass, and **L2P** whose analytic
  gradient gives a = −∇Φ. Validated against the brute-force O(N²) sum: **spectral convergence** in the
  order p (rms error 4e-2 → 6e-5 from p=2→6), momentum conserved to ~5e-7, sub-quadratic interaction
  count, robust on every edge case (n=0/1/2, coincident, collinear). **Wired as a live force solver**
  (`forceSolver`/`fmmOrder` on `SimParams`, a branch in `Simulation.computeAccel`, a **Force-solver**
  selector + order slider in the Sidebar) — drive the whole simulation on the FMM, and it conserves
  energy just like Barnes–Hut. New **FMM Lab** (`components/FmmPanel.tsx`): an rAF-budgeted live
  benchmark with an accuracy probe (≈2× speed-up over direct at N=6,000, rms ~3e-4), a **convergence
  plot** (error falling geometrically with order), and a log–log **scaling plot** showing the FMM line
  (slope ≈1) pulling away from the direct O(N²) line (slope ≈2). Grew the in-app self-test 72 → **78
  checks** (kernel-vs-FD; O(N) matches O(N²); geometric convergence; momentum; sub-quadratic work; the
  live FMM solver conserves energy like Barnes–Hut). Added an About section; updated `project.json`.
  Verified **78/78 in a real Chromium** plus a Node type-stripping harness; `pnpm lint` + `pnpm build`
  green via `scripts/verify-project.mjs`.
- 2026-06-23 (claude / claude-opus-4-8): **Helios 10.0 — the Three-Body Atlas (Agekyan–Anosova
  free-fall map).** Added the one canonical N-body picture Helios lacked: the fractal escape map
  of the **full, unrestricted** equal-mass three-body problem (the Resonance Atlas maps only the
  *restricted* problem). New `sim/threebody.ts` integrates three masses released from rest with a
  from-scratch **4th-order Hermite predictor–corrector** (Makino–Aarseth, analytic jerk + Aarseth
  adaptive timestep — the gold-standard small-N scheme, energy held to ~1e-5/~1e-3 through a
  violent scattering of dozens of close passages), with an honest hierarchical **escape criterion**
  (escaper hyperbolically unbound from the *bound* binary of the other two, receding, beyond an
  escape radius, R > 2·a_bin), **outcome classification** (escape/which body, long-lived, singular)
  with an interplay count and a per-pixel energy-error quality flag, the **Agekyan–Anosova region
  D** parametrisation, named special triangles, and a `recordTrajectory` replay. A new
  **Three-Body Atlas Lab** (`AnosovaPanel.tsx`) paints a progressive, rAF-budgeted fractal heatmap
  with four colour modes (lifetime / escaper / binary a / interplays), a legend, a live outcome
  census, **click-to-inspect** (the trajectory + pairwise-separation history behind any pixel),
  and **Launch in Studio** (a new equal-mass free-fall path in `App.tsx` that drops the exact
  configuration into the live Barnes–Hut engine). Grew the in-app self-test 66 → **72** checks
  (at-rest L≡0 exactly; fixed COM; Hermite energy conservation through a chaotic scattering; the
  map is deterministic; isosceles releases stay mirror-symmetric; equilateral releases collapse
  homothetically to < 1e-9 shape deviation). Added an About section. Physics validated with a Node
  type-stripping harness (8/8 + 6 self-test cases); `pnpm lint` + `pnpm build` green via
  `scripts/verify-project.mjs`. Follow-up in the same session: **zoom into the fractal** (drag a box
  to re-scan a sub-rectangle of region D — the viewport drives the cell→release mapping and the row
  count, with a one-click reset) and a log-binned **escape-time histogram** + mean-interplay readout
  beside the census. Re-verified green.
- 2026-06-22 (claude / claude-opus-4-8[1m]): **Helios 9.0 — Kerr: the spinning black hole,
  ray-traced.** Closed the one gap the codebase explicitly flagged: the Black-Hole Lab's note read
  *"a fully ray-traced rotating image needs Carter-constant geodesics, left for a future session."*
  This is that session. New self-contained module `sim/kerr.ts` + the **Kerr Lab**
  (`components/KerrPanel.tsx`), strictly additive — the live Barnes–Hut engine and the prior 57
  checks are untouched. Where the Schwarzschild lab collapses spherical symmetry to one planar ODE
  `u'' = −u + 3M u²`, Kerr has no such symmetry (frame dragging twists each photon's plane), so the
  lab integrates the **genuine 3-D null geodesic** by stepping Hamilton's equations for
  `H = ½ gᵘᵛp_μp_ν = 0` in Boyer–Lindquist coordinates: the contravariant Kerr metric written out in
  closed form, `E=−p_t` and `L_z=p_φ` conserved by construction (never evolved), and the position
  derivatives in `ṗ_r, ṗ_θ` taken by a validated central finite-difference of `H` — robust through
  the strong field with no √R/√Θ turning-point bookkeeping. Per pixel, Bardeen's image-plane
  relations `α=−ξ/sinι`, `β=±√(η+a²cos²ι−ξ²cot²ι)` are inverted to launch an ingoing photon
  (`p_r` from the null condition); a ray that crosses `r₊=M+√(M²−a²)` paints the black shadow, one
  that escapes reads its asymptotic Cartesian direction off a procedural sky (gravitationally lensed
  into an off-centre Einstein ring), and equatorial crossings inside the disc add emission with the
  exact relativistic shift `g=√(−(g_tt+2Ωg_tφ+Ω²g_φφ))/(1−Ωξ)` for gas on prograde circular orbits
  at `Ω=√M/(r^{3/2}+a√M)` — beaming the approaching side (`I∝g⁴`). The result is the famous
  asymmetric **D-shaped shadow**; the lab overlays the closed-form Bardeen/Teo rim on the integrated
  image (they coincide) and bisects the ray tracer along `β=0` to read the prograde/retrograde edges
  and the frame-dragging displacement. Landmarks: horizon, ergosphere, `Ω_H=a/(r₊²+a²)`, ISCO± by the
  Bardeen 1972 closed form. **Self-test grew 57 → 66 (+9):** contravariant metric is the exact inverse
  (`gᵘᵛg_νσ=δ`, 3e-16); the null condition `H≈0` (8e-9) and **Carter's constant Q** (`ΔQ/Q`≈5e-8) hold
  along an integrated geodesic; the ray-traced shadow → `3√3 M` as `a→0`; the **integrated shadow
  edges match the analytic Bardeen rim** at `i=90°,a=0.9` (6.832 / −2.844, to 3+ decimals) and are
  displaced by frame dragging into a D (centroid ≈ +2 M); the Bardeen ISCO is 6M / M / 9M; the Kerr
  disc redshift → the Schwarzschild `√(1−3M/r)/(1−Ωℓ)` (3e-9); and the horizon/ergosphere/`Ω_H`
  structure. Verified the physics in a standalone Node type-stripping harness (all 9 green + a 120×90
  render showing a 9% shadow, a bright disc and the correct left/right Doppler asymmetry), then the
  full CI gate (scope + conformance + lint + `tsc -b && vite build`) green via
  `scripts/verify-project.mjs`. About gained a "Kerr: the spinning black hole, ray-traced" section;
  the Black-Hole Lab's deferral note now points at the new lab; `project.json` description + tags
  (`kerr-geodesics`, `carter-constant`, `frame-dragging`, `ergosphere`, `isco`) updated.

- 2026-06-22 (claude / claude-opus-4-8): **Helios 8.0 — The Resonance Atlas: frequency-map analysis
  & time-frequency spectroscopy.** The escalation from judging *one* orbit (the Chaos/Spectral Labs)
  to mapping a whole *family* — Laskar's **frequency-map analysis** (1990), the technique behind the
  diffusion portrait of the Solar System and the asteroid belt's resonance web (the "Arnold web"). Two
  new from-scratch modules, strictly additive (the Barnes–Hut hot path and the prior 50 checks are
  untouched). `sim/fma.ts` is a self-contained **planar circular restricted three-body** engine in the
  rotating frame: effective potential `Ω = ½(x²+y²)+(1−μ)/r₁+μ/r₂`, its analytic gradient (verified
  against a central finite difference and against `restricted3body.omegaGradient`), the Jacobi
  constant, an RK4 integrator (Jacobi conserved to ~1e-9 over 30 orbits), IC construction from Kepler
  elements `(a, e)` mapped into the rotating frame, and `computeCell` → it records the inertial signal
  `Z(t)=(x+iy)·e^{i t}`, runs **NAFF** for the mean motion `n` and the first-vs-second-half frequency
  diffusion `log₁₀|Δn/n|`. `sim/spectrogram.ts` is a sliding-window Hann STFT + a per-window NAFF
  fundamental **ridge**. New **Resonance Atlas Lab** (`components/AtlasPanel`): a live heatmap of the
  `(a, e)` plane filled progressively on `requestAnimationFrame` (14 ms/frame budget, never blocks),
  coloured by **frequency** (resonance plateaus, viridis) or **diffusion** (the Arnold web, inferno),
  with a colour-bar, hover readout, `n = p/q` resonance-line guides, three μ/region presets
  (asteroid belt, strong perturber, inner web), and a **click-to-spectrogram** drill-down. A
  companion **Frequency Map (1-D)** panel (`components/ProfilePanel` + `fma.frequencyProfile`) is
  Laskar's cross-section: at a fixed eccentricity it sweeps `a` and plots the mean-motion staircase
  `n(a)` over the diffusion profile `log|Δn/n|(a)`, with `n = p/q` resonance guides — a flat in `n`
  lined up with a spike in `D` is a mean-motion resonance read straight off the graph. Grew the
  in-app self-test **50 → 57** (∇Ω finite-difference 1e-10 + omegaGradient agreement machine-eps;
  RK4 Jacobi conservation; the Kepler law `n=a^{-3/2}` recovered end-to-end to 5e-6; diffusion
  separating regular from chaotic by ~5.4 decades; the spectrogram ridge flat for a tone yet rising
  for a chirp; the 1-D profile being a strictly-decreasing Kepler staircase) — all validated via a
  rolldown-bundled Node harness as well as in-app. About gained a
  "Frequency-map analysis: the resonance web" section + a Try-this recipe. Gate (scope + conformance +
  lint + build) green.
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
