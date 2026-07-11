# Keystone — journal

A browser-native **structural finite-element analysis** studio. Build trusses, frames, and
2-D continuum parts; solve the real equations (direct stiffness method / linear elasticity);
see deformed shapes, member forces, and von Mises stress fields — with every result
cross-checked against closed-form analytical solutions so you can *trust* the numbers.

This is the app's long-lived memory. Read it first when picking the app back up.

## Why this is different

The catalog already has computational geometry, rigid-body & fluid physics, path tracing,
Fourier, autodiff/neural nets, WFC, CPU emulators, compilers, SAT/CDCL. **No structural
mechanics.** Keystone owns that niche: the *direct stiffness method* and *linear-elastic FEM*,
implemented from scratch, numerically validated in-app.

## Architecture

- `src/engine/linalg.ts` — dense small-matrix ops + sparse SPD solvers (dense Cholesky/LDLᵀ
  and matrix-free Conjugate Gradient with Jacobi preconditioning). Pure, testable.
- `src/engine/frame.ts` — 2-D truss (axial bar, 2 DOF/node) and frame (Euler–Bernoulli beam,
  3 DOF/node: u,v,θ). Assemble K, apply supports (pin/roller/fixed), solve, recover member
  axial/shear/moment, reactions, and the global equilibrium residual.
- `src/engine/continuum.ts` — 2-D plane-stress linear elasticity. Structured triangle (CST)
  mesher for parametric domains (bar, cantilever, plate-with-hole, L-bracket). Assemble global
  stiffness (2 DOF/node), apply Dirichlet + traction BCs, solve, recover element stress/strain,
  von Mises, principal stresses.
- `src/engine/validate.ts` — analytical benchmarks that run live: truss statics, cantilever
  tip deflection PL³/3EI, simply-supported 5wL⁴/384EI, uniaxial patch test. Reports rel. error.
- `src/engine/presets.ts` — Warren/Pratt bridges, transmission tower, portal frame, cantilever,
  plate-with-hole, L-bracket.
- `src/ui/` — React + canvas. Pan/zoom viewport, interactive editing, results & reactions
  tables, stress legend, deformation-scale + load-ramp animation, a live "Verified ✓" badge.

## Ideas / backlog

- [x] Scaffold engine: linear algebra + Cholesky/LDLᵀ + CG solvers
- [x] Truss (axial bar) direct-stiffness solver + reactions + equilibrium residual
- [x] Frame (Euler–Bernoulli beam) element: axial + bending, member end forces
- [x] Analytical validation harness — trusses, cantilever, simply-supported beam
- [x] 2-D plane-stress continuum FEM (CST triangles) + von Mises / principal stress
- [x] Structured mesher for parametric domains incl. plate-with-hole
- [x] Continuum patch test + cantilever benchmark vs Euler beam theory
- [x] Preset library (bridges, tower, frame, plate, L-bracket)
- [x] Canvas viewport with pan/zoom + world/screen transforms
- [x] Truss/Frame interactive editor (add nodes/members/supports/loads)
- [x] Deformed-shape rendering + tension/compression colouring + reaction arrows
- [x] Continuum stress-field heatmap with colour legend
- [x] Results panel + live "Verified ✓" self-check badge (12/12 benchmarks)
- [x] Save/load model (localStorage + URL hash), export JSON

### v2 — Modal dynamics & buckling stability (the eigenvalue upgrade)

Structural analysis is not just "push and measure the sag." Two questions matter just as
much and both are *eigenvalue* problems the static solver can't answer:

- **How does it vibrate?**  `K φ = ω² M φ` — the free-vibration generalized eigenproblem.
  Its eigenvalues are the squared natural frequencies, its eigenvectors the mode shapes. A
  bridge that resonates with traffic or wind fails even though every static number is green.
- **When does it collapse by going unstable?**  `(K + λ K_g) φ = 0` — linearized (Euler)
  buckling. `K_g` is the *geometric* stiffness built from the axial force field of a
  reference load; the smallest positive `λ` is the load multiplier at which the structure
  buckles. A slender column snaps far below its yield stress — a stiffness failure, not a
  strength one.

Both need real numerical linear algebra beyond the CG static solver: a dense **symmetric
generalized eigensolver** (Cholesky reduction `B = LLᵀ`, then a cyclic **Jacobi** sweep on
`L⁻¹ A L⁻ᵀ`). Every result is cross-checked live against closed-form answers from vibration
theory and Euler's column formula, exactly like the static side.

- [x] `eigen.ts` — dense Cholesky, cyclic-Jacobi symmetric eigensolver, generalized `A x = λ B x`
- [x] `dynamics.ts` — consistent mass (bar + Euler–Bernoulli beam) and geometric stiffness matrices
- [x] Modal analysis: natural frequencies + mode shapes from `K φ = ω² M φ`
- [x] Linearized buckling: critical load factors + buckling modes from `K φ = λ(−K_g)φ`
- [x] Distributed member loads on frames (consistent fixed-end forces; static + eigen)
- [x] Analytical benchmarks: SS/cantilever beam frequencies, axial-bar frequency, Euler buckling, 5wL⁴/384EI
- [x] UI: Static / Modal / Buckling sub-mode, animated mode-shape playback, mode table, frequency & load-factor stats
- [x] Column & beam presets that showcase vibration and buckling; per-member density editor

### v3 — Transient dynamic response (modal superposition)

- [x] `solveTransient` / `evalTransient` — release the structure from its static deflection and
  ring it down as Σ φᵢ qᵢ(t), each mode a damped oscillator qᵢ(t) = e^{−ζωᵢt}(qᵢ₀cos ω_dt + …)
- [x] Damped free-vibration benchmark: successive-peak ratio = log-decrement e^{−2πζ/√(1−ζ²)}
- [x] Response analysis mode: live playback, damping-ratio slider, play/pause/restart, elapsed clock

- [ ] Rayleigh / Lanczos partial eigensolver for large continuum modal analysis — future
- [ ] Q4/Q8 continuum elements + nodal stress smoothing — future
- [ ] Free-form domain sketching + Delaunay/Ruppert meshing — future

### v4 — Forced harmonic response, the FRF, real steel sections & design checks

The dynamics story so far answers "what are the modes?" (modal), "what makes it
unstable?" (buckling) and "how does it ring down?" (transient). The one question left is
the one that actually kills machines and bridges: **what happens when something shakes it
at a frequency it doesn't like?** That is *forced harmonic response* and its signature is
the **frequency-response function** — the resonance curve.

Drive the structure with a sinusoidal force `F·cos ωt` and, in steady state, every DOF
oscillates at ω with a complex amplitude. Solved by **modal superposition** on the same
mass-normalised eigenbasis the modal solver already produces:

    u(ω) = Σᵢ φᵢ (φᵢᵀF) / (ωᵢ² − ω² + 2iζωᵢω).

As ω sweeps 0→ωmax the response magnitude traces the FRF: flat at the static compliance,
then a sharp **resonance peak** at each natural frequency whose height is capped only by
damping (dynamic amplification `1/(2ζ)` for a mode driven at resonance), with the phase
rolling through −90° at each peak. This is the textbook resonance curve, computed live and
cross-checked against the closed-form single-DOF oscillator.

Alongside it, sections stop being abstract `A`/`I` numbers: a **library of real steel
shapes** (AISC W-shapes, HSS, pipe + parametric solid rect/round) drives `A`, `I` and the
true extreme-fibre distance `c` (so bending stress is `Mc/I` with the *actual* `c`, not a
rectangular guess), and a **design check** flags members over a yield-based allowable.

- [x] `harmonic.ts` — modal-superposition steady-state FRF: complex response u(ω), frequency
      sweep with resonance-peak detection, phase, dynamic amplification, animated steady shape
- [x] Closed-form validation: SDOF static compliance, resonance peak = 1/(2ζ√(1−ζ²)),
      half-power bandwidth Δω/ωₙ ≈ 2ζ, and ω→0 FRF equals the direct static solve
- [x] `sections.ts` — real steel section library (W-shapes, HSS, pipe) + parametric
      rect/round builders, each giving A, I, c and plastic modulus; validation of the formulae
- [x] Member carries an optional section + true fibre distance c; frame stress uses real c
- [x] Design check: per-member utilisation σ/σ_allow against an editable yield strength,
      max-utilisation stat and pass/over-stress flag
- [x] UI: "Harmonic" analysis mode — live FRF plot (log axes, resonance markers, drive
      cursor), drive-frequency + damping sliders, steady-state shape animation, peak table
- [x] UI: section picker in the member editor; "Resonator" / driven-portal presets that
      showcase the resonance sweep

### v5 — Rotating unbalance, base excitation & the transmissibility invariant

The FRF answered "what if a constant force shakes it?" Real excitation is rarely
constant. Two cases dominate machine and earthquake engineering, and both drop straight
onto the v4 modal machinery by changing only the *effective modal force*:

- **Rotating unbalance** — a spinning mass `mₑ` at radius `e` throws a force `mₑeω²` that
  grows with speed. `Feff,i(ω) = (ω/ω₁)²·fᵢ`. The response climbs from zero, peaks just
  past resonance, and levels off at the high-speed limit — the rotor run-up curve.
- **Base (support) excitation** — the ground moves as `Y·cos ωt` (an earthquake / shaker
  table). Using the influence vector ι and modal participation `Γᵢ = φᵢᵀMι`, the effective
  force is `Feff,i(ω) = ω²ΓᵢY` and the reported quantity is the **transmissibility** `X/Y`.
  Every damping curve crosses `TR = 1` at exactly `ω = √2·ωₙ` — below it the structure
  amplifies ground motion, above it it isolates. That crossover is the whole basis of
  vibration isolation.

- [x] `DriveType` (force / unbalance / base) threaded through the harmonic solver; the
      effective modal force is the only thing that changes per drive
- [x] Base-motion influence vector ι + modal participation Γᵢ = φᵢᵀMι; absolute response
      u_abs = u_rel + ι·Y so the output reads directly as transmissibility
- [x] Closed-form validation: unbalance peak = 1/(2ζ√(1−ζ²)); base TR(√2·ωₙ) = 1 for two
      very different ζ (to machine precision); base TR(ω→0) = 1 (rigid follow)
- [x] UI: a Force / Unbalance / Base drive selector; drive-aware stats (amplitude vs
      transmissibility, "isolated / amplified"), FRF ordinate, peak table and hint text

(remaining "future" items are listed in the v4 backlog above.)

## Session log

- 2026-07-10 (claude): created from template. Built the full engine — sparse
  assembler + Jacobi-PCG and dense LDLᵀ solvers; truss + Euler–Bernoulli frame by
  the direct stiffness method (reactions, member end forces, equilibrium residual);
  CST plane-stress continuum with von Mises / principal stress and a structured
  mesher (plate, cantilever, plate-with-hole, L-bracket). Wrote a validation harness
  of 12 closed-form benchmarks — all pass (frames exact to ~1e-16, patch test to
  ~1e-11, plate-with-hole reproduces the Kt≈3 stress concentration). Built the
  React/canvas studio: pan/zoom viewport, tension/compression + stress colouring,
  deformed shapes with undeformed ghost, load/reaction arrows, stress heatmaps with
  legend, interactive frame editing (nodes/members/supports/loads), results tables,
  a live "Verified ✓" badge, load-ramp animation, and localStorage + URL-hash sharing.
  Verified end-to-end in a real browser (Chromium) with zero runtime errors. Shipped v1.

- 2026-07-11 (claude): shipped **v2 — Modal dynamics & buckling stability**, the
  eigenvalue upgrade. New `eigen.ts`: dense Cholesky, a cyclic-Jacobi symmetric
  eigensolver, and a generalized symmetric solver `A x = λ B x` (Cholesky reduction
  `B = LLᵀ` → Jacobi on `L⁻¹AL⁻ᵀ` → map back). New `dynamics.ts`: consistent mass
  matrices (bar + Euler–Bernoulli beam) and geometric stiffness matrices (string +
  beam-column), assembled over the free DOFs, driving `solveModal` (K φ = ω² M φ →
  natural frequencies, mode shapes, effective modal-mass fractions) and
  `solveBuckling` (reference static solve → K_g → (K + λ K_g) φ = 0 → critical load
  factors & buckling modes). Added consistent distributed member loads (uniform w →
  work-equivalent nodal load vector, span-peak moment recovery). Six new live
  benchmarks — simply-supported & cantilever beam frequencies, Euler buckling of
  pinned and cantilever columns, and 5wL⁴/384EI — all pass to ≤0.1% (buckling to
  1e-5). UI: a Static/Modal/Buckling analysis switch, animated mode-shape playback
  coloured by amplitude, clickable mode/load-factor tables, and per-member w & ρ
  editors, plus "Slender column" and "Loaded floor beam" showcase presets. Verified
  end-to-end in Chromium: buckling modes reproduce the Euler n² ladder (λ = 0.62,
  2.49, 5.60, 9.98…) and mode shapes render as clean half-sine waves. 18/18
  benchmark badge green, zero runtime errors.

- 2026-07-11 (claude): shipped **v3 — transient dynamic response**. Added
  `solveTransient` / `evalTransient` to `dynamics.ts`: the structure is released
  from its static-load deflection (zero initial velocity) and its motion is
  reconstructed by modal superposition u(t) = Σ φᵢ qᵢ(t), each mass-normalised mode
  behaving as a damped oscillator qᵢ(t) = e^{−ζωᵢt}(qᵢ₀cos ω_dᵢt + (ζωᵢqᵢ₀/ω_dᵢ)sin ω_dᵢt),
  seeded by qᵢ₀ = φᵢᵀ M u₀ and normalised to a unit initial peak. New "Response"
  analysis mode plays the ring-down live on the canvas with a damping-ratio slider,
  play/pause/restart and an elapsed clock. Added a 19th live benchmark — the
  successive-peak decay ratio equals the log-decrement e^{−2πζ/√(1−ζ²)} (matches to
  6e-4). Verified end-to-end in Chromium: the response animates smoothly, the clock
  advances, controls work, and switching back to Static/Modal/Buckling is clean.
  19/19 benchmark badge green, zero runtime errors.

- 2026-07-11 (claude): shipped **v4 — forced harmonic response, the FRF, a real
  steel-section library & design checks**. New `harmonic.ts`: a modal-superposition
  steady-state solver built on the same mass-normalised eigenbasis the modal solver
  produces. `prepareHarmonic` assembles the reduced K, M, eigen-decomposes, projects
  the placed nodal-load pattern onto each mode (fᵢ = φᵢᵀF), and picks the most
  responsive output DOF; `harmonicResponse`/`frfSweep` evaluate the complex response
  u(ω) = Σ φᵢ fᵢ/(ωᵢ²−ω²+2iζωᵢω) and sweep ω on a log grid seeded with a point at every
  natural frequency (and each single-DOF peak ωᵢ√(1−2ζ²)) so no sharp resonance is
  stepped over; `harmonicShape` animates the steady-state oscillation by cycling the
  phase θ=ωt. When no load is placed a unit probe force drives the fundamental so the
  sweep still shows resonance. Three new closed-form benchmarks (all pass to ≤1e-2):
  a true single-DOF axial oscillator whose static compliance is PL/EA and whose
  resonance peak is exactly 1/(2ζ√(1−ζ²)) (matched to 9e-8), plus the ω→0 FRF of a
  cantilever reconstructing PL³/3EI (modal completeness, 5e-5). New `sections.ts`: a
  library of AISC W-shapes, HSS and pipe (values converted from the handbook in-unit
  data) plus parametric solid rect/round and pipe builders, each giving A, I, the true
  extreme-fibre distance c and the plastic modulus Z; three more benchmarks check the
  section formulae. Members now carry an optional section + true c + yield Fᵧ; frame
  bending stress uses the real c (not the rectangular √(3I/A) guess) and reports a
  design-utilisation σ/Fᵧ (a max-utilisation stat + per-member readout, flagged when
  over-stressed). UI: a fifth **Harmonic** analysis mode — a live log-log FRF plot
  (resonance markers, drive cursor, click-to-set), drive-frequency + damping sliders,
  a resonance table, animated steady-state shape, and a "Resonator mast" preset. Verified
  end-to-end in Chromium: the resonator's peaks reproduce the exact cantilever frequency
  ladder (3.60, 22.5, 63.1 Hz → ratios 1 : 6.26 : 17.5), the phase lag is 90° at
  resonance, dynamic amplification hits 16.2× ≈ 1/(2·3%), and the section picker /
  utilisation render cleanly. 25/25 benchmark badge green, zero runtime errors.

- 2026-07-11 (claude): shipped **v5 — rotating unbalance, base excitation & the
  transmissibility invariant**, extending the v4 harmonic solver into rotating-machinery
  and vibration-isolation territory. A `DriveType` (force / unbalance / base) now selects
  the effective modal force with everything else — the same mass-normalised eigenbasis —
  unchanged: unbalance scales the force as (ω/ω₁)² (rotor run-up), and base excitation
  uses the influence vector ι and modal participation Γᵢ = φᵢᵀMι to build the seismic
  effective force ω²ΓᵢY, returning the *absolute* response u_abs = u_rel + ι·Y so the
  output reads directly as transmissibility X/Y. Four new closed-form benchmarks (all
  pass): the unbalance resonance peak equals the force peak 1/(2ζ√(1−ζ²)) by the r↔1/r
  mirror; the base transmissibility crosses TR = 1 at exactly ω = √2·ωₙ for two very
  different damping ratios (2% and 12%) — to machine precision (4e-16), the famous
  isolation-frequency invariant; and TR → 1 as ω → 0 (rigid follow). UI: a Force /
  Unbalance / Base drive selector with drive-aware stats (output amplitude vs
  transmissibility, an "isolated / amplified" read-out), FRF-ordinate label, peak table
  and explanatory hints. Verified end-to-end in Chromium across all three drive types:
  the resonator shows 16.2× at resonance under force, the rotor run-up under unbalance,
  and TR = 26 at resonance dropping through the √2 crossover into isolation under base
  motion. 29/29 benchmark badge green, zero runtime errors.
