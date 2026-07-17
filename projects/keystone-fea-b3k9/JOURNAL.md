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
- `src/engine/isoparam.ts` — higher-order **isoparametric** plane-stress elements (v9): Q4
  (bilinear, 2×2 Gauss) and Q8 (8-node serendipity, 3×3 Gauss) shape functions + natural
  derivatives, the mapped Jacobian/B matrix, element stiffness + consistent mass, and the
  Gauss→node **stress-recovery** (extrapolation) matrices. Pure, testable.
- `src/engine/quadmesh.ts` — structured **quadrilateral** meshers for the same four domains
  (Q4 or Q8, with de-duplicated mid-side nodes), plus edge / boundary-edge helpers for BCs and
  consistent edge tractions.
- `src/engine/quadsolve.ts` — the Q4/Q8 static solver (smooth recovered nodal stress field) and
  **continuum modal** analysis (K φ = ω² M φ) by scalable **subspace iteration** on the sparse
  system — the lowest modes without a full dense eigensolve.
- `src/engine/plastic.ts` — nonlinear pushover: event-to-event elastic–plastic hinge tracking
  (moment-release condensation, mechanism detection from the tangent spectrum), capacity curve.
- `src/engine/seismic.ts` — seismic time-history: a Newmark-β integrator, Rayleigh damping, a
  seeded ground-motion library, and the elastic response spectrum.
- `src/engine/inelastic.ts` — inelastic (nonlinear hysteretic) seismic time-history: bilinear
  kinematic-hardening plastic hinges + a Newmark-β / Newton–Raphson march (initial-stiffness with
  line search), giving hysteresis loops, ductility, residual drift and the R factor.
- `src/engine/validate.ts` — analytical benchmarks that run live (55 of them): truss statics,
  cantilever PL³/3EI, 5wL⁴/384EI, patch test, modal/buckling, harmonic/FRF, plastic collapse,
  seismic, the inelastic hinge/hysteresis checks, and the v9 isoparametric checks (Q4/Q8 patch
  test, Q8 Euler & Timoshenko cantilever, Q4 refinement, continuum bending frequency). Reports
  rel. error.
- `src/engine/presets.ts` — Warren/Pratt bridges, transmission tower, portal frame, cantilever,
  plate-with-hole, L-bracket, plastic-collapse frames, and seismic/inelastic moment frames.
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

- [x] Rayleigh / Lanczos partial eigensolver for large continuum modal analysis — **shipped in
      v9** (subspace iteration; sparse-CG inner solves, dense reduced eigenproblem)
- [x] Q4/Q8 continuum elements + nodal stress smoothing — **shipped in v9**
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

### v6 — Nonlinear pushover: plastic hinges & collapse (the inelastic upgrade)

Everything so far is **linear-elastic**: double the load, double the stress. Real steel does
not fail that way. Past first yield a cross-section keeps carrying load while a **plastic hinge**
forms — the moment saturates at the plastic capacity `Mₚ = Z·Fᵧ` and the section rotates freely.
Load then *redistributes* to the still-elastic parts until enough hinges turn the frame into a
**mechanism** and it collapses. The load multiplier at that instant — the **collapse load
factor** — is what plastic design is actually about, and for many frames it is far above first
yield (a fixed-fixed beam carries 33 % more; a propped cantilever, more still).

This is a genuinely *nonlinear* analysis, and it has a beautiful exactness story to validate
against: classical **plastic limit analysis** gives closed-form collapse loads (`4Mₚ/L`,
`6Mₚ/L`, `8Mₚ/L`, `11.66Mₚ/L²`, portal sway `4Mₚ/h`) by the virtual-work mechanism method — so
the incremental solver can be cross-checked exactly like every other chapter.

The method is **event-to-event elastic–plastic hinge tracking**. At each stage we solve the
current (partially-hinged) structure elastically for the reference load *rate*, find the smallest
load increment `Δλ` that brings the next section to `Mₚ`, insert a moment release there (static
condensation of that rotational DOF), freeze its moment at `±Mₚ`, and repeat — accumulating the
load factor and the deflection — until the stiffness goes singular (the mechanism). The trace of
(control deflection, load factor) is the **capacity (pushover) curve**: rising, softening at each
hinge, flat-topping at collapse.

- [x] `plastic.ts` — hinge-aware beam stiffness (moment-release condensation + released-rotation
      recovery), `memberMp` from section `Z` / `Fᵧ`, and the accumulated end-force bookkeeping
- [x] `solvePushover` — incremental event-to-event solver: elastic rate solve, next-hinge search,
      hinge insertion, **mechanism detection from the tangent spectrum** (smallest/largest
      eigenvalue ratio — a failed Cholesky pivot alone missed the round-off-singular case), and the
      mechanism shape from the singular system's null eigenvector
- [x] Capacity curve + per-event states (deflected shape + cumulative hinge set) for scrubbing;
      collapse plateau along the mechanism at constant load factor
- [x] Optional second-order (P-Δ) pushover: add the geometric stiffness from current axial forces
      so axial load visibly lowers the collapse capacity
- [x] Exact benchmarks: SS beam `4Mₚ/L`, propped cantilever `6Mₚ/L` (point) & `11.66Mₚ/L²` (UDL),
      fixed-fixed beam `8Mₚ/L`, fixed-base portal sway `4Mₚ/h`
- [x] UI: a **Pushover** analysis mode — live capacity-curve plot (load factor vs control
      deflection, hinge-event markers, load cursor), a load-scrub play/pause that animates the
      structure deflecting and hinges popping in, a clickable hinge-sequence table, collapse stats
- [x] Presets that showcase redistribution: propped cantilever (UDL), fixed-fixed beam, portal
      sway frame — each with a defined `Mₚ` so collapse is dramatic
- [x] Canvas: plastic-hinge glyphs (a filled amber disc at each formed hinge) drawn on the deflected shape

### v7 — Seismic time-history & the response spectrum (the earthquake chapter)

Modal found the frequencies, transient rang the structure down from a kick, and
harmonic traced the resonance of a *steady* sinusoid. The one excitation left is
the one earthquake engineering is built on: an **arbitrary ground motion**, with
no single frequency and no steady state. The support accelerates along a recorded
accelerogram `a_g(t)` and the equation of motion must be marched forward in time:

    M·ü + C·u̇ + K·u = −M·ι·a_g(t),

with `u` the displacement *relative to the moving ground*, `ι` the influence
vector (unit rigid ground translation), and `C = a₀M + a₁K` **Rayleigh
(proportional) damping** tuned to a target modal damping ζ at the first and third
modal frequencies. The integrator is the unconditionally-stable **Newmark-β
average-acceleration** scheme (γ = ½, β = ¼): the effective stiffness
`K̂ = K + (γ/βΔt)C + (1/βΔt²)M` is Cholesky-factored *once* and every step is two
triangular solves. Alongside the history it computes the **elastic response
spectrum** — for a whole bank of SDOF oscillators spanning 0.05–4 s, each is
driven by the *same* record and its peak recorded, giving Sd(T) and the
pseudo-spectral Sv = ωSd, Sa = ω²Sd. The spectrum is *the* object a seismic
designer reads demand from, and the structure's own natural periods are marked on
it. Three deterministic (seeded, never `Math.random`) ground motions ship: a
broadband synthetic (Kanai–Tajimi soil spectrum × Jennings envelope), a near-fault
velocity **pulse** (Ricker wavelet), and a **harmonic shaker**. Everything is
cross-checked live against closed-form structural dynamics.

- [x] `seismic.ts` — the whole chapter, pure/deterministic, built on the eigen +
      dynamics assembler already in place.
- [x] **Newmark-β integrator** (average-acceleration, γ=½/β=¼): cached-Cholesky
      effective-stiffness solve, both an MDOF form and a fast scalar SDOF form.
- [x] **Rayleigh damping** `C = a₀M + a₁K` from a target ζ at ω₁ and ω₃
      (`rayleighCoeffs`) — proportional damping that keeps the modal picture clean.
- [x] **Ground-motion library**: `syntheticQuake` (seeded broadband, Kanai–Tajimi
      × Jennings, baseline-corrected to give velocity/displacement), `pulseGround`
      (near-fault Ricker wavelet), `harmonicGround` (ramped shaker) — all scaled to
      a target PGA in g, with PGA/PGV/PGD reported.
- [x] **Response spectrum** `responseSpectrum`: a bank of 64 log-spaced SDOF
      oscillators integrated under the record → Sd, Sv, Sa(T); `spectrumAt`
      interpolates the demand at any period.
- [x] MDOF time-history: relative-displacement response, output/roof DOF picked
      from the largest running peak, elastic base-shear history ιᵀKu, peak roof
      drift, peak inter-level drift, and a strided store so the animation stays cheap.
- [x] `seismicShape` — the drawn frame at any instant: relative deformation
      (normalised) **plus a rigid ground sway** so the whole structure rides the
      quake, drifting against the fixed undeformed ghost.
- [x] **5 closed-form benchmarks** (all green): Newmark undamped period fidelity
      `u(T)=u₀`; the step-load dynamic-amplification factor **DAF = 2**; the damped
      log-decrement `e^(−2πζ/√(1−ζ²))` via direct integration; the SDOF harmonic
      steady-state amplitude `(F/k)/√((1−r²)²+(2ζr)²)`; and the spectral
      high-frequency limit **Sa(T→0) = PGA**.
- [x] UI: a seventh **Seismic** analysis mode — record selector (Quake / Pulse /
      Shaker), live-shaking canvas animation, a ground-acceleration trace, a roof
      time-history, and the **response-spectrum plot** with the structure's periods
      marked; PGA + damping sliders, play/pause/restart, click-to-scrub the traces,
      and stat tiles (T₁, Sa(T₁), peak roof, peak drift, peak base shear, PGA, PGV).
- [x] Two showcase presets: a **5-storey moment frame** (T₁ ≈ 0.84 s, resonates
      under the shaker) and a slender **10-storey tower** (T₁ ≈ 2 s, hammered by the
      near-fault pulse) — member density scaled to lump realistic floor mass so the
      periods land in the earthquake-sensitive band.

- [x] Inelastic time-history (hysteretic hinges) — marry v6's plasticity to the
      Newmark march for a true nonlinear seismic response — **shipped in v8**
- [ ] Multi-support / asynchronous excitation and a design-spectrum overlay — future

(remaining "future" items are also listed in the v4 backlog above.)

### v8 — Inelastic (nonlinear hysteretic) seismic time-history (the ductility chapter)

Every earthquake chapter so far is **linear-elastic**: the frame rings under the
ground motion but always returns to plumb, and the base shear it reports climbs
with intensity without limit. Real buildings do not survive a design earthquake
elastically — they are *designed* to yield. Past first yield a section forms a
**plastic hinge**, its moment saturates at Mₚ, and the structure dissipates energy
in fat hysteresis loops instead of storing it elastically. That inelastic action
is the whole basis of modern seismic design — the response-modification (R)
factor, the ductility demand, and the **residual drift** a building is left with.
v8 marries the plastic hinges of v6 to the Newmark march of v7 and computes it
directly:

    M·ü + C·u̇ + f_s(u) = −M·ι·a_g(t),

where the restoring force f_s(u) is now **nonlinear**. Members carry **bilinear
kinematic-hardening** hinges at both ends (elastic slope k up to Mₚ, post-yield
slope α·k, elastic unloading — α = 0 is elastic–perfectly-plastic), and the
equation is marched by Newmark-β with **Newton–Raphson equilibrium iterations**:
each iterate does a per-member *state determination* (a coupled two-hinge return
map enforcing the full KKT conditions) and the effective-stiffness system is
re-solved to equilibrium before the hinge states are committed. The tangent
discontinuities of plasticity are handled by the **initial-stiffness method** (a
constant, once-factored elastic effective stiffness — provably non-divergent)
with a **backtracking line search** for monotone residual decrease.

- [x] `inelastic.ts` — the whole chapter, pure/deterministic, built on the existing
      assembler + Newmark constants.
- [x] `springReturn` / `newmarkEPP` — the fundamental **bilinear kinematic-hardening
      spring** (1-D return map) and a scalar EPP oscillator with a full energy ledger
      (input / kinetic / damping / strain / hysteretic) — the SDOF reference.
- [x] `memberState` — coupled **two-hinge return map** at a beam's rotational ends,
      with an active-set that enforces the *full* KKT conditions (plastic-multiplier
      sign **and** every inactive hinge inside the yield surface) so f_s stays
      continuous, plus the consistent tangent (= static condensation when α = 0).
- [x] `solveInelasticSeismic` — MDOF Newmark-β + initial-stiffness Newton–Raphson
      with line search; outputs the roof history, the **nonlinear base shear** ιᵀf_s,
      the yielded-hinge set + peak plastic rotations, per-step hinge-active flags, an
      energy time-history, ductility μ, **residual drift**, dissipated hysteretic
      energy, and — for the force-reduction story — the elastic response of the same
      record (the **R factor** = elastic peak base shear / inelastic peak).
- [x] **6 closed-form benchmarks** (all green): the bilinear backbone f(2u_y) =
      f_y + αk·u_y, the post-yield tangent αk, the perfectly-plastic unload (f = 0 at
      the plastic offset), the EPP **energy balance** (closes to 0.1 %), the SDOF
      **elastic limit** (f_y→∞ reproduces the linear Newmark SDOF to 4e-14), and — the
      strongest — the **MDOF elastic limit**: with Mₚ→∞ the full nonlinear march
      reproduces the independent linear `solveSeismic` to **2e-13** (machine
      precision, two entirely separate codepaths). Badge **39 → 45**.
- [x] UI: an eighth **Inelastic** analysis mode — record selector, a live shaking
      canvas where amber plastic-hinge glyphs pop in as sections yield (and the frame
      carries its permanent residual drift), the iconic **base-shear-vs-roof-drift
      hysteresis loop** (`HysteresisPlot`), ground + roof time-series with scrub,
      play/pause/restart, PGA / **yield-strength ×** / **post-yield α** / damping
      sliders, and stat tiles (μ, R, peak roof, residual drift, hysteretic energy,
      hinges yielded, peak vs elastic base shear, T₁).
- [x] A **Ductile frame (inelastic)** preset (4-storey moment frame, capacity-designed
      weak-beam/strong-column Mₚ) plus the existing 5- and 10-storey seismic frames,
      which yield under the stronger records.

- [ ] Inelastic **constant-ductility** / strength-reduction spectra (Rμ–μ–T) — future
- [ ] P-Δ in the nonlinear march (marry v6's geometric stiffness to the hinge model) — future

### v9 — Higher-order continuum: isoparametric Q4/Q8 elements, smooth stress recovery & continuum dynamics

Every continuum result so far came from the **constant-strain triangle** (CST): one B matrix per
element, stress *constant* across each element, and a notoriously **stiff** bending response — a
coarse CST cantilever is ~12 % too stiff, and its stress field is a jumpy patchwork of flat
tiles. That is the weakest part of the studio, and v9 fixes it with the workhorses of real 2-D
FEA:

- **Isoparametric Q4** — the bilinear quadrilateral (4 nodes, 2×2 Gauss). Passes the patch test
  exactly; converges to the right answer under refinement (its shear-locking bending error dies
  as the mesh refines).
- **Isoparametric Q8** — the quadratic **serendipity** quadrilateral (8 nodes, 3×3 Gauss). It
  captures bending and curved stress gradients a CST cannot: a **coarse** Q8 mesh reproduces
  Euler–Bernoulli beam deflection to <1 % and the full **Timoshenko** (bending + shear) answer to
  <0.1 %.

Both are integrated numerically over the parent square [-1,1]² and mapped to the physical element
by the isoparametric Jacobian. The element stress is sampled at the **superconvergent** Gauss
points and **extrapolated to the nodes** (a per-order extrapolation matrix), then averaged across
the mesh — turning FEA's jumpy element stresses into the **smooth C⁰ nodal field** engineers
actually read. And because the two questions of dynamics matter for solids too, v9 adds
**continuum modal** analysis (K φ = ω² M φ with a consistent mass matrix), solved by **subspace
iteration** so only the lowest handful of modes are computed — the sparse-CG inner solves keep it
interactive at thousands of DOFs where a dense eigensolve would freeze. The fundamental of a
cantilever plate lands exactly on the Euler–Bernoulli beam frequency, closing the loop with the
frame modal chapter.

- [x] `isoparam.ts` — Q4/Q8 shape functions + natural derivatives, 2×2 / 3×3 Gauss rules, the
      mapped Jacobian + B matrix, element stiffness Kᵉ = ∫BᵀDB t dΩ and consistent mass
      Mᵉ = ∫ρNᵀN t dΩ, and the Gauss→node stress-extrapolation matrices (bilinear/biquadratic fit)
- [x] `quadmesh.ts` — structured Q4/Q8 meshers for the four domains (plate, cantilever,
      plate-with-hole, L-bracket) with de-duplicated mid-side nodes and boundary-edge helpers
- [x] `quadsolve.ts` — `solveQuad` (assemble → BC-aware PCG solve → smooth recovered nodal
      σxx/σyy/τxy, von Mises, principal, strain energy, equilibrium residual) and `solveQuadModal`
- [x] **Subspace (Bathe) iteration** for the lowest continuum modes: solve K X̄ = M X (sparse CG),
      project to a small K_r/M_r, dense-eig the reduced system, rotate, iterate to convergence
- [x] **10 new closed-form benchmarks** (badge 45 → **55**): Q4 & Q8 patch test (σ uniform, σyy/τxy
      vanish, u = σW/E — all exact to ~1e-6); Q8 cantilever vs Euler PL³/3EI (<1.5 %) and vs the
      full Timoshenko bending+shear answer (<0.5 %); Q4 cantilever converging under refinement; and
      the continuum modal fundamental = the Euler–Bernoulli cantilever bending frequency (<2 %)
- [x] UI: an **Element formulation** selector (CST / Q4 / Q8) and a continuum **Static / Modes**
      switch in the 2-D continuum tab; a smooth quad stress renderer (nodal-averaged field);
      continuum mode selector + live mode-shape animation; quad-aware results panel (recovered
      max von Mises, element/node counts, formulation, PCG iters) and a modal panel (frequencies,
      periods, free-DOF count)
- [x] Verified end-to-end in headless Chromium: the plate-with-hole Q8 renders the smooth Kt
      stress concentration at the hole, the Q8 cantilever bends with the correct through-depth
      stress gradient on 20 elements, continuum Modes animates the first mode of a 1486-DOF part in
      real time, and the badge reads **55/55** with zero runtime errors

- [ ] **Superconvergent Patch Recovery (Zienkiewicz–Zhu)** proper — a least-squares patch fit per
      node instead of simple averaging, plus the **ZZ error estimator** (‖σ* − σ_h‖) to drive
      adaptive refinement — future
- [ ] **Q9 (full biquadratic Lagrange) + Q6 incompatible modes / B-bar** for near-incompressible
      plane strain (locking-free) — future
- [ ] **Plane strain toggle** (the other 2-D elasticity model) and a **thermal load** (α·ΔT) term — future
- [ ] **6-node quadratic triangle (LST/T6)** to mesh curved boundaries (the hole) exactly — future
- [ ] **Continuum buckling & harmonic** (reuse the geometric-stiffness / FRF machinery on the
      isoparametric mesh) so the plate gets the full dynamics story the frames already have — future
- [ ] **Free-form domain sketching + Delaunay/Ruppert meshing** feeding the Q4/Q8 assembler — future

## Session log

- 2026-07-17 (claude): shipped **v9 — higher-order continuum: isoparametric Q4/Q8
  elements, smooth stress recovery & continuum modal dynamics**, the chapter that
  upgrades the app's weakest part (constant-strain triangles). New `isoparam.ts`:
  the bilinear **Q4** (2×2 Gauss) and quadratic 8-node serendipity **Q8** (3×3
  Gauss) plane-stress elements — shape functions + natural derivatives, the mapped
  isoparametric Jacobian and B matrix, element stiffness Kᵉ = ∫BᵀDB t dΩ and
  consistent mass Mᵉ = ∫ρNᵀN t dΩ, plus per-order Gauss→node stress-extrapolation
  matrices (a bilinear/biquadratic fit through the superconvergent Gauss-point
  stresses). New `quadmesh.ts`: structured Q4/Q8 meshers for the four domains with
  de-duplicated mid-side nodes and boundary-edge helpers for BCs + consistent edge
  tractions ({½,½} for Q4, {⅙,⅔,⅙} for Q8). New `quadsolve.ts`: the static solver
  (BC-aware PCG, then a **smooth recovered nodal stress field** — the C⁰ picture,
  not the CST's flat tiles) and **continuum modal** analysis K φ = ω² M φ solved by
  scalable **subspace (Bathe) iteration** — solve K X̄ = M X with sparse CG, project
  to a small reduced eigenproblem, rotate, iterate — so the lowest modes of a
  thousands-of-DOF part stay interactive where a dense Jacobi solve would freeze the
  tab. Ten new closed-form benchmarks (badge **45 → 55**, all green): the Q4 and Q8
  patch tests (uniform σ, vanishing σyy/τxy, u = σW/E — exact to ~1e-6); the Q8
  cantilever reproducing Euler–Bernoulli PL³/3EI to <1 % *and* the full Timoshenko
  (bending + shear) answer to <0.1 % on a coarse 12×3 mesh (where a CST needs a 12 %
  tolerance); the Q4 cantilever converging under refinement (shear-locking cured);
  and the **continuum modal fundamental** matching the Euler–Bernoulli cantilever
  bending frequency (β₁L = 1.875) to 0.15 %. UI: an **Element formulation** selector
  (CST / Q4 / Q8), a continuum **Static / Modes** switch, a smooth quad stress
  renderer, a continuum mode selector with live mode-shape animation, and
  quad/modal-aware results panels. Verified end-to-end in headless Chromium: the
  plate-with-hole Q8 renders the smooth Kt stress concentration (max von Mises
  156.7 MPa, converged, equilibrium 4e-11), the Q8 cantilever bends with the correct
  through-depth stress gradient on 20 elements, continuum Modes animates the first
  mode of a **1486-DOF** part in real time (fundamental 45.3 Hz, 6 modes found), the
  badge reads **55/55**, and Static/Modal/… on the frame side and CST/Q4/Q8 on the
  continuum side all switch cleanly with zero runtime errors.

- 2026-07-16 (claude): shipped **v8 — inelastic (nonlinear hysteretic) seismic
  time-history**, the ductility chapter that marries v6's plastic hinges to v7's
  Newmark march. New `inelastic.ts` solves `M ü + C u̇ + f_s(u) = −M ι a_g(t)`
  with a **nonlinear** restoring force: members carry **bilinear
  kinematic-hardening** plastic hinges at both ends (elastic slope k → yield Mₚ →
  post-yield slope α·k, elastic unloading; α = 0 is elastic–perfectly-plastic).
  The march is Newmark-β with **Newton–Raphson** equilibrium iterations — each
  iterate runs a per-member *state determination* (a coupled two-hinge return map
  that enforces the *full* KKT conditions: the plastic-multiplier sign **and**
  every inactive hinge staying inside the yield surface, so f_s is continuous),
  with the consistent tangent reducing to exactly the pushover's static
  condensation when α = 0. The tangent discontinuities of plasticity are tamed by
  the **initial-stiffness method** (a constant, once-factored elastic effective
  stiffness `K̂₀ = K + b₀M + b₁C`, provably non-divergent) plus a **backtracking
  line search** for monotone residual decrease — which took the model from ~10–20
  non-converged steps per record (worst residual > 1) to a clean **converged**
  march (worst residual < 5e-6) on every showcase frame. Outputs: the roof
  history, the *nonlinear* base shear ιᵀf_s, the yielded-hinge set with peak
  plastic rotations, per-step hinge-active flags for the animation, an energy
  time-history, the **ductility** μ, the **residual (permanent) drift**, the
  dissipated **hysteretic energy**, and — running the same record elastically as a
  reference — the **force-reduction (R) factor**. Six new closed-form benchmarks
  (all green): the bilinear backbone, the post-yield tangent αk, the
  perfectly-plastic unload, the EPP **energy balance** (closes to 0.1 %), the SDOF
  **elastic limit** (f_y→∞ = linear Newmark to 4e-14), and — the strongest — the
  **MDOF elastic limit**, where the full nonlinear Newton march reproduces the
  independent linear `solveSeismic` to **2e-13** when nothing yields. Badge **39 →
  45**. UI: an eighth **Inelastic** analysis mode — a live shaking canvas with
  amber plastic-hinge glyphs popping in as sections yield (the frame carrying its
  permanent residual drift), the iconic **base-shear-vs-roof-drift hysteresis
  loop**, ground + roof traces with click-to-scrub, play/pause/restart, and PGA /
  **yield-strength ×** / **post-yield α** / damping sliders, plus a stat grid (μ,
  R, peak roof, residual drift, hysteretic energy, hinges yielded, peak vs elastic
  base shear, T₁). A new **Ductile frame (inelastic)** preset (4-storey,
  capacity-designed weak-beam/strong-column Mₚ) showcases it. Verified end-to-end
  in headless Chromium: the badge reads **45/45**, the ductile frame yields at 4
  hinges under the synthetic quake (μ ≈ 1.3, R ≈ 1.1) and far harder under the
  near-fault pulse (μ up to 6, R up to ~4, ~0.5 m residual drift), the amber
  hinges render at the drift-concentration story, the hysteresis loops open, and
  Seismic / Pushover / the other modes still work with zero runtime errors.

- 2026-07-16 (claude): shipped **v7 — seismic time-history & the response
  spectrum**, the earthquake chapter. New `seismic.ts`: a **Newmark-β**
  average-acceleration integrator (γ=½, β=¼, unconditionally stable) that marches
  `M ü + C u̇ + K u = −M ι a_g(t)` — the relative-displacement equation of motion
  under support acceleration — with **Rayleigh damping** `C = a₀M + a₁K` tuned to a
  target ζ at the 1st and 3rd modal frequencies. The effective stiffness is
  Cholesky-factored once and reused every step. A seeded (never `Math.random`)
  ground-motion library ships three records: a broadband synthetic accelerogram
  (Kanai–Tajimi soil spectrum × Jennings envelope, baseline-corrected so the
  velocity/displacement don't drift), a near-fault velocity **pulse** (Ricker
  wavelet), and a ramped **harmonic shaker** — each scaled to a target PGA. On top
  sits the **elastic response spectrum**: 64 log-spaced SDOF oscillators (0.05–4 s)
  each integrated under the same record to give the peak Sd and the pseudo-spectral
  Sv = ωSd, Sa = ω²Sd. The MDOF time-history reports the roof/output-DOF drift
  history, the elastic base-shear history ιᵀKu, peak roof + inter-level drift, and
  a rigid-ground-sway shape (`seismicShape`) so the whole frame visibly rides the
  quake against the fixed ghost. Five new closed-form benchmarks — Newmark period
  fidelity, the step-load DAF = 2, the damped log-decrement via direct integration,
  the SDOF harmonic steady-state amplitude, and the spectral limit Sa(T→0) = PGA —
  all pass (errors ≤ 8e-3), taking the badge to **39/39**. UI: a seventh **Seismic**
  analysis mode — a record selector, a live-shaking canvas, a ground-acceleration
  trace, a roof time-history, and the response-spectrum plot with the structure's
  natural periods marked and Sa(T₁) called out; PGA + damping sliders, play / pause
  / restart, click-to-scrub the traces, and a stat grid (T₁, Sa(T₁), peak roof,
  peak drift, peak base shear, PGA, PGV). Two showcase presets: a 5-storey moment
  frame (T₁ ≈ 0.84 s — resonates under the shaker at 0.59 g demand, 130 mm roof
  drift) and a slender 10-storey tower (T₁ ≈ 2 s — the near-fault pulse drives it to
  640 mm, an order of magnitude the pulse's own displacement, the classic long-
  period vulnerability). Verified end-to-end in headless Chromium across frames and
  trusses and all three records: the badge reads 39/39, the frame sways and rings
  down, the spectrum renders with the T₁ marker on its descending branch, and there
  are zero runtime errors.

- 2026-07-11 (claude): shipped **v6 — nonlinear pushover: plastic hinges & collapse**,
  the first *inelastic* chapter. New `plastic.ts`: a concentrated-plasticity,
  event-to-event elastic–plastic solver. `memberMp` reads the plastic capacity
  Mₚ = Z·Fᵧ from the assigned section (or a shape-factor estimate). Each increment
  assembles the current partially-hinged tangent stiffness — plastic hinges are
  moment releases applied by **static condensation** of the hinged rotational DOF,
  with the released rotation recovered afterwards so member end forces stay exact —
  solves for the reference-load *rate* dU/dλ, and finds the smallest Δλ that drives
  the next un-hinged section to ±Mₚ. It accumulates λ, the deflection and the member
  end forces, freezes the yielded section at ±Mₚ, and repeats until the tangent goes
  singular: the collapse mechanism. Detecting that singularity is the subtle part —
  a failed Cholesky pivot alone let the round-off-singular fixed-fixed case slip
  through (over-predicting by √3), so collapse is judged from the **tangent
  spectrum** (smallest/largest eigenvalue ratio < 1e-9, which also catches P-Δ
  indefiniteness), and the mechanism shape is that null eigenvector. Outputs the
  capacity curve, the ordered hinge sequence, the collapse load factor, the plastic
  reserve λc/λ₁, and the deflected shape at every event (plus a mechanism plateau)
  for animation. Optional second-order (P-Δ) adds the geometric stiffness from the
  current axial forces so axial load visibly lowers the collapse capacity. Five new
  live benchmarks — SS beam 4Mₚ/L, propped cantilever 6Mₚ/L (point) and 11.66Mₚ/L²
  (UDL), fixed-fixed 8Mₚ/L, portal sway 4Mₚ/h — all reproduce classical plastic
  limit analysis (three exact to ~1e-14, the UDL to 8e-4). UI: a sixth **Pushover**
  analysis mode — a live load-factor-vs-deflection capacity plot (hinge-event dots,
  first-yield & collapse reference lines, a load cursor, click-to-scrub), a
  load-scrub play/pause that animates the frame deflecting with amber plastic-hinge
  discs popping in on the deformed shape, a clickable hinge-sequence table, a P-Δ
  toggle, and collapse/reserve stats; plus an Mₚ member editor and three plastic-
  collapse presets (propped cantilever UDL, fixed-fixed beam, sway portal). Verified
  end-to-end in Chromium: the sway portal collapses at λc = 5.45 = 4Mₚ/h exactly
  with four hinges and a 1.21× reserve, P-Δ lowers the capacity, and the badge is
  green — **34/34 benchmarks**, zero runtime errors.

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
