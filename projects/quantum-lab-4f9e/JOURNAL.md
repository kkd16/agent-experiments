# Quantum Lab — journal

Full quantum circuit simulator built from scratch in TypeScript. No external math libraries — pure complex number arithmetic, tensor products, and state vector simulation.

## Features shipped

- [x] Complex number arithmetic class (add, mul, conj, abs, phase, polar)
- [x] Matrix operations (matMul, tensorProduct, matVecMul, dagger)
- [x] 15+ quantum gates: H, X, Y, Z, S, T, Rx, Ry, Rz, Phase, U, SX, CNOT, CZ, SWAP, Toffoli, Fredkin, CPhase
- [x] State vector simulation (up to 6 qubits, 64 complex amplitudes)
- [x] Sparse tensor gate application (correct qubit ordering)
- [x] Born rule measurement (single qubit + full collapse)
- [x] Monte Carlo shot sampling (N shots histogram)
- [x] Bloch sphere visualization via Three.js (reduced density matrix, partial trace)
- [x] Bipartite von Neumann entanglement entropy
- [x] State vector amplitude+phase display with color-coded phase bars
- [x] Probability histogram (Recharts)
- [x] Drag-and-drop circuit editor (SVG wires, animated gates, parameter dialogs)
- [x] 11 pre-built algorithms with explanations and step-through
- [x] Bell state |Φ+⟩
- [x] GHZ state (3-qubit maximal entanglement)
- [x] W state (genuinely tripartite, different entanglement class)
- [x] Deutsch-Jozsa algorithm (balanced and constant oracle)
- [x] Grover's search (2-qubit and 3-qubit with optimal iterations)
- [x] Quantum Fourier Transform (3 qubits)
- [x] Bernstein-Vazirani algorithm
- [x] Quantum teleportation
- [x] Simon's period-finding algorithm
- [x] Algorithm step-through UI (apply gates one by one, watch state evolve)
- [x] Entanglement entropy visualization per bipartition
- [x] Dark space-themed UI with framer-motion animations
- [x] About page with physics explanations

## Quantum Lab 18.0 — Classical Shadows (randomized-measurement tomography) (this session)

The lab can *prepare* and *compile* and *protect* quantum states across a dozen pillars — but it had
never asked the most practical question of the NISQ era: given a state on a real device that you can
only **measure** (one classical bit-string per shot), how do you learn the properties you care about
without paying the exponential price of full tomography? 18.0 adds the modern answer, one of the most
cited quantum results of the decade: **classical shadows** (Huang–Kueng–Preskill, *Nature Physics*
2020), built from scratch on the lab's own state-vector and Clifford machinery and — in keeping with
the house style — proven *deterministically*, not merely demonstrated.

### Why this is interesting

The measurement of a state through a random unitary `U` is an information-losing quantum channel
`M(ρ) = E[U†|b⟩⟨b|U]`. Because `M` is a **known, invertible linear map**, a single shot already gives
an *unbiased* classical estimate of the entire state — the snapshot `ρ̂ = M⁻¹(U†|b⟩⟨b|U)`, with
`E[ρ̂] = ρ`. Average `tr(O ρ̂)` over a handful of snapshots and you estimate *any* observable you ask
for **afterwards**: one dataset, many predictions, with rigorous `log(M)/ε²` sample complexity for M
observables. The two canonical ensembles trade locality against generality, and 18.0 builds both.

### The plan / new steps (this session)

- [x] **`shadows.ts` — a from-scratch classical-shadows engine** (no new dependencies; built on the
      lab's `Complex`/`Matrix`/`QuantumState` and the `rb.ts` Clifford machinery):
  - [x] **Random-Pauli (local) ensemble.** Each qubit is rotated into a uniformly random X/Y/Z basis
        (`R_X=H`, `R_Y=H·S†`, `R_Z=I`) and measured; snapshots store `(basis, bit)` per qubit. The
        inverse channel factorises, `σ̂_q = 3|s_q⟩⟨s_q| − I`, derived from the single-qubit
        measurement channel `M(ρ)=⅓(ρ+tr(ρ)I)`.
  - [x] **Single-shot Pauli estimator** `tr(Qρ̂)=∏_q tr(Q_q σ̂_q)`: a non-identity `Q_q` contributes
        `3·(±1)` when the measured basis matches and **0** on a basis miss — so a weight-k Pauli is
        read off in O(k), never storing the exponential ρ̂.
  - [x] **Many observables from one dataset** + the robust **median-of-means** aggregator (K groups →
        exponentially-good confidence), with per-observable standard error.
  - [x] **Second-moment functionals**: purity `Tr(ρ²)` as a U-statistic over snapshot *pairs*
        (`tr(σ̂ᵢσ̂ⱼ)` per qubit = 5 / −4 / ½), restricted to a subsystem to give `Tr(ρ_A²)` and the
        **2-Rényi entanglement entropy** `S₂(A)=−log₂Tr(ρ_A²)` — entropy from randomized measurements
        alone, never reconstructing the state.
  - [x] **Fidelity** with a pure target via its exact Pauli expansion `|φ⟩⟨φ|=Σ_P (⟨φ|P|φ⟩/2ⁿ)P`.
  - [x] **Global random-Clifford (3-design) ensemble**, `ρ̂=(2ⁿ+1)U†|b⟩⟨b|U − I` — variance bounded
        by `3·tr(O₀²)` **independent of locality**. The Clifford group is *fully enumerated* (24 for
        n=1 via `rb.ts`; 11520 for n=2 by BFS over {H,S,CNOT}, canonicalised mod global phase), so the
        ensemble is an **exact** 3-design and the estimator is exact. Direct fidelity
        `(2ⁿ+1)|⟨φ|s⟩|²−1` and purity `(2ⁿ+1)²|⟨sᵢ|sⱼ⟩|²−(2ⁿ+2)`.
  - [x] **Exact references + deterministic proofs**: `exactPauli`, `exactReducedPurity`, and — the
        rigorous core — `pauliChannelExpectation` / `cliffordChannelExpectation` (the exact `E[ρ̂]`
        summed over the *whole* finite ensemble + Born outcomes) and `pauliEstimatorSecondMoment` (the
        exact `E[X²]=3ᵏ` shadow norm). These make unbiasedness a theorem checked to machine precision,
        not a statistical hope.
- [x] **`ShadowsLab.tsx` + a new "🃏 Shadows" tab** — pick a state (GHZ / W / cluster / random
      product / random entangled), an ensemble, a snapshot budget and a seed, then watch:
  - [x] a **many-observable chart + table** (shadow vs exact, with error bars) — `Z_q`, `X_q` and
        nearest-neighbour `ZZ` correlators predicted from one dataset;
  - [x] **purity, Rényi-2 entropy, and fidelity** cards comparing estimate to the exact state-vector
        value;
  - [x] a **log–log convergence plot** (error vs snapshots against the 1/√M law) and a **shadow-norm
        bar chart** (single-shot variance `3ᵏ` by Pauli weight);
  - [x] a **global-Clifford view** showing locality-independent fidelity/purity for n≤2.
- [x] **Self-tests** (new "Classical shadows" group, 10 cases): exact channel inversion `E[ρ̂]=ρ` for
      *both* ensembles, the unbiased single-shot estimator, the `3ᵏ` shadow norm, the enumerated
      Clifford orders (24, 11520), and seeded statistical convergence of the many-observable,
      purity, Rényi-2 and fidelity estimators.
- [x] **About-page pillar** + `project.json` description/tags refreshed.

### Verified (all green — suite now 174/174)

- **Channel inversion (the headline), to machine precision**: `E[ρ̂]=ρ` over the full 3ⁿ-basis Pauli
  ensemble (max err ~6e-16, n=2,3) and over the entire enumerated Clifford group (max err ~3e-13,
  n=1,2). The unbiasedness is a *proof by enumeration*, not a sample average.
- **Single-shot estimator unbiased** `E[ô]=⟨Q⟩` exactly (max err ~2e-16, weights 1–3); **shadow
  norm** `E[X²]=3ᵏ` exact (3, 9, 27 for k=1,2,3).
- **Statistics (seeded)**: 7 observables predicted from one 6k-snapshot dataset to <0.07; pure-state
  purity ≈1.07; Bell-half `S₂` ≈1.00; fidelity ≈0.98 with itself and ≈exact (0.06) with another;
  global-Clifford fidelity ≈1.00 and purity ≈0.99.
- **Enumerated Clifford orders** `|C₁|=24`, `|C₂|=11520` (exact 3-designs).
- **Build gate green** (scope + conformance + lint + `tsc -b` + `vite build`).

## Quantum Lab 17.0 — Quantum Metrology & Sensing (this session)

Entanglement powers three great applications: **computing** (the algorithms / Shor / synthesis
pillars), **communication & cryptography** (the nonlocality + device-independent pillars), and
**sensing** — and the third was the one pillar the lab had never built. 17.0 adds it: a
from-scratch **quantum-metrology** engine that makes precise *why* entanglement lets you measure a
phase better than any classical strategy, *how good* that advantage can possibly be (the
information-theoretic limit), and *why it is so fragile* that the very entanglement that helps is
destroyed by the noise it is most sensitive to.

The whole thing is anchored on three numbers that are provable to machine precision, so it lands
as rigorous mathematics, not a demo: the **standard quantum limit** `F_Q = N`, the **Heisenberg
limit** `F_Q = N²`, and the **Heisenberg-limited-then-Huelga-killed** behaviour under dephasing.

### Why this is interesting

A phase θ imprinted by `U(θ) = e^{−iθG}` can be estimated with an uncertainty bounded below by the
**quantum Cramér–Rao bound** `Δθ ≥ 1/√(ν·F_Q)`, where the **quantum Fisher information** `F_Q` is
an intrinsic property of the probe state and the generator `G` — the largest information *any*
measurement could extract. For N independent probes `F_Q = N` (the *standard quantum limit*,
`Δθ ∝ 1/√N`); for an N-qubit GHZ probe `F_Q = N²` (the *Heisenberg limit*, `Δθ ∝ 1/N`) — a genuine
√N quantum advantage with no classical analogue. This is the principle behind LIGO's squeezed
light, optical atomic clocks, and quantum-enhanced magnetometry.

### The plan / new steps (this session)

- [x] **`metrology.ts` — a from-scratch quantum-estimation engine** (no new dependencies; built on
      the lab's existing `Complex`/`Matrix`/`QuantumState`/`DensityMatrix`/Jacobi eigensolver):
  - [x] **Pure-state QFI = 4·Var(G).** For `|ψ_θ⟩ = e^{−iθG}|ψ⟩` the QFI is exactly four times the
        generator variance in the probe. Implemented for a diagonal collective generator
        `G = J_z = ½Σ Zᵢ` so every headline number is an exact rational.
  - [x] **Mixed-state SLD QFI.** The general open-system formula
        `F_Q = 2 Σ_{λᵢ+λⱼ>0} |⟨i|∂_θρ|j⟩|² / (λᵢ+λⱼ)` via an eigendecomposition of ρ (the lab's
        Hermitian Jacobi solver), using `∂_θρ = −i[G, ρ]` evaluated efficiently from G's diagonal.
        Verified to reduce to `4·Var(G)` on pure states.
  - [x] **Classical Fisher information of a measurement.** For a dichotomic observable M (M²=I),
        `F_C(θ) = (d⟨M⟩/dθ)² / (1 − ⟨M⟩²)` on `ρ_θ = U(θ)ρU(θ)†` — the information a *specific*
        readout extracts, always `≤ F_Q` (the quantum Cramér–Rao ordering).
  - [x] **Probes & generators**: GHZ and product-`|+⟩` builders; the collective `J_z` generator;
        the parity observable `X^⊗N` (the optimal GHZ readout) and `Z^⊗N` (the *useless*
        generator-basis readout).
  - [x] **The two scaling laws, exact**: `sqlQFI(N)=N`, `heisenbergQFI(N)=N²`, Δθ from the CRB, and
        the √N advantage ratio.
  - [x] **Noise (the honest part)**: local dephasing applied with the lab's phase-damping Kraus
        channel, with the closed forms `F_Q(GHZ)=N²(1−λ)^N` and `F_Q(product)=N(1−λ)` derived and
        cross-checked against the numerical SLD engine — the basis of the **Huelga et al.** result
        that Markovian dephasing erases the Heisenberg advantage.
- [x] **`MetrologyLab.tsx` + a new "📡 Metrology" tab** with three cards:
  - [x] **Scaling laws** — Δθ-vs-N on a log–log plot, SQL (`1/√N`) vs Heisenberg (`1/N`), with the
        QFI values and the √N advantage read out live.
  - [x] **Quantum Cramér–Rao & measurement saturation** — a θ sweep showing the parity readout's
        `F_C` rising to exactly the QFI `N²` (saturation) while the generator-basis readout extracts
        **zero** information, with the CRB error bands.
  - [x] **Noise & the fragility of the advantage (Huelga)** — a dephasing slider and an N sweep
        showing `F_Q(GHZ)=N²(1−λ)^N` cross *below* `F_Q(product)=N(1−λ)`: the Heisenberg advantage
        evaporates past a critical N, the deep reason metrology turned to *squeezing* not cat states.
- [x] **Self-tests** (new "Metrology" group in the Tests tab) proving every headline to machine
      precision: SQL `F_Q=N`, Heisenberg `F_Q=N²`, the SLD engine matching both, the noisy closed
      forms, parity saturating the QFI (`F_C=N²`), the generator-basis readout giving `F_C=0`, the
      `F_C ≤ F_Q` ordering over a θ grid, and the noise crossover where product beats GHZ.
- [x] **About-page pillar** + `project.json` description/tags refreshed.

### Verified (all green)

- **SQL**: product-`|+⟩^N` QFI = N exactly for N=1…6. **Heisenberg**: GHZ QFI = N² exactly for
  N=1…6 — a clean factor-N (√N in Δθ) advantage.
- **SLD engine**: the general mixed-state QFI reproduces N (product) and N² (GHZ) from a density
  matrix to ~1e-9, confirming the open-system formula reduces to 4·Var(G) on pure states.
- **Noise**: numerical SLD QFI matches `N²(1−λ)^N` (GHZ) and `N(1−λ)` (product) to ~1e-9; at
  λ=0.2, N=20 the product QFI (16) exceeds the GHZ QFI (≈4.6) — the advantage is gone.
- **Measurement**: the parity readout `X^⊗N` saturates `F_C = N²` at every θ (to ~1e-9), while the
  generator-basis readout `Z^⊗N` extracts `F_C = 0` — measuring in the eigenbasis of the thing you
  are trying to estimate is information-free. `F_C ≤ F_Q` holds across the whole θ grid.
- **Build gate green** (conformance + lint + `tsc -b` + `vite build`).

### Update — Spin squeezing (the robust route) shipped

The Huelga card ends on "real metrology turned to spin-squeezing" — so the pillar now *builds* it.
`squeezing.ts` implements the **Kitagawa–Ueda one-axis-twisting** Hamiltonian `H = χ·J_z²` acting on a
coherent spin state, the collective spin operators `J_a = ½Σσ_a` applied directly to the 2^N vector,
the full 3×3 spin covariance, and the **Wineland parameter** `ξ²_R = N·(ΔJ⊥min)²/|⟨J⟩|²`, plus a
**Husimi-Q** quasiprobability so you can *see* the noise blob shear on the Bloch sphere. A 4th
Metrology card lets you twist live (N and μ sliders, the ξ²(μ) sweep, the optimal-ξ² vs-N log–log
plot sitting between the SQL and Heisenberg lines). New self-tests (suite now 164/164): the coherent
state has ξ²=1 exactly; one-axis twisting conserves the Casimir `⟨J²⟩=(N/2)(N/2+1)` (it stays in the
symmetric Dicke manifold); the optimum gives genuine sub-SQL squeezing `ξ²<1` respecting `1/ξ²≤N`;
and the squeezing deepens with N along the `N^−2/3` law.

### Future ideas (open)

- [ ] **Multiparameter metrology** — the quantum Fisher information *matrix* and the
      Holevo/SLD bounds when several phases are estimated at once (incompatible optimal measurements).
- [ ] **Bayesian / adaptive phase estimation** — the van-Trees bound and an adaptive Kitaev-style
      protocol reaching the Heisenberg limit without an entangled probe.
- [ ] **The interferometric picture** — a Mach–Zehnder / NOON-state interferometer view tying the
      abstract generator back to a concrete optical phase.

## Quantum Lab 16.0 — Device-Independent Quantum Information (this session)

15.0 built the **nonlocality** pillar: CHSH, the GHZ/Mermin game, the magic square, Mermin–Klyshko.
It *exhibits* the quantum violation. 16.0 builds the pillar that turns nonlocality into a **resource
and a security primitive** — the device-independent (DI) programme, where one trusts *nothing about the
internal physics of the boxes*, only the observed statistics, and still proves things. This is the
deepest unbuilt vein in the lab's foundations story, and it needs real new from-scratch machinery: a
**semidefinite-programming solver** (the workhorse of modern quantum information) that the lab has
never had.

### The plan / new steps (this session)

- [x] **`sdp.ts` — a from-scratch dense SDP solver.** The lab has a Hermitian (cyclic-Jacobi)
      eigensolver but no optimisation over the PSD cone. Build one with no external libraries:
      - a **primal** solver for the *elliptope* `max ⟨C,X⟩ s.t. X⪰0, diag(X)=1` by **Burer–Monteiro**
        low-rank factorisation `X = VVᵀ` + projected gradient (rows of V kept unit), which for this
        diagonally-constrained class has no spurious local maxima above rank `√(2n)`;
      - a **dual** solver `min Σyᵢ s.t. Diag(y) − C ⪰ 0` by eigenvalue-penalised descent (the Jacobi
        eigensolver supplies λ_min as the barrier), returning the rigorous **certificate** matrix;
      - the duality gap `primal − dual → 0` is the proof of optimality, reported live.
- [x] **`npa.ts` — the NPA hierarchy (Navascués–Pironio–Acín), level 1.** Build the moment matrix Γ
      indexed by the operator monomials `{1, A₀, A₁, B₀, B₁}` for a correlation Bell scenario; its
      Alice–Bob cross block holds the four correlators E_xy, every off-diagonal is a free variable, the
      diagonal is 1 (A²=B²=I). Maximising a Bell functional over `Γ⪰0` is exactly the elliptope SDP, so
      the from-scratch solver computes **Tsirelson's bound 2√2 as a certified upper bound** — the proof
      that *no* quantum strategy, in any dimension, beats 2√2 (the Monte-Carlo ceiling in 15.0 only
      *sampled* qubit strategies; this *proves* the ceiling). Level 1 is exactly tight for CHSH, so the
      primal and dual both land on 2√2 with a vanishing duality gap.
- [x] **An explicit operator SOS certificate.** Independently of the numerics, exhibit the
      sum-of-squares decomposition `2√2·I − S = (1/√2)(u² + v²)` with `u = A₀ − (B₀+B₁)/√2`,
      `v = A₁ − (B₀−B₁)/√2`, verified to be the **zero matrix** to machine precision on the dense 4×4
      operators — a second, fully rigorous, basis-independent proof of Tsirelson that agrees with the SDP.
- [x] **`randomness.ts` — device-independent randomness from CHSH.** The observed S certifies
      unpredictability *even against an adversary who built the devices*: the guessing probability obeys
      `P_g(S) = ½ + ½√(2 − S²/4)` (Pironio et al.), so the certified min-entropy
      `H_min = −log₂ P_g` rises from **0 bits at S=2** (classical, fully predictable) to **1 bit at the
      Tsirelson point S=2√2**. Plot the curve; this is the principle behind certified random-number
      generation.
- [x] **`steering.ts` — EPR steering (the asymmetric middle of the hierarchy).** Steering sits strictly
      between entanglement and Bell-nonlocality. Build (a) the **steering ellipsoid** of a two-qubit
      state (Jevtic et al.: centre and semi-axes from ρ's correlation matrix — the set of Bloch vectors
      Alice can collapse Bob onto), and (b) the **CJWR linear steering inequalities** `S_n = (1/√n)|Σ⟨AₖBₖ⟩| ≤ 1`
      for any local-hidden-state model, violated by the singlet up to `S_2=√2` and `S_3=√3`, with the
      **Werner critical visibility** `w > 1/√n` for n-setting steerability — all computed on the engine's
      correlators.
- [x] **`detection.ts` — the detection loophole, CH/Eberhard.** A real experiment misses photons; below a
      detection efficiency η the violation evaporates and a local model fakes the data. Implement the
      **Clauser–Horne / Eberhard** inequality with no-click outcomes, and show the famous result: the
      maximally-entangled state needs **η > 2(√2−1) ≈ 82.8%** (CHSH), but Eberhard's **non-maximally
      entangled** states push the threshold down toward **η > 2/3 ≈ 66.7%** as the entanglement → 0 —
      computed by optimising the CH value over the state angle and measurements at each η.
- [x] **`nosignaling.ts` — the PR box & the three ceilings.** Place the NPA-certified quantum bound in
      context: the Popescu–Rohrlich box is the explicit no-signalling correlation that reaches the
      *algebraic* maximum **S = 4** while still forbidding faster-than-light signalling — so quantum
      theory's **2√2** sits strictly between the local bound **2** and the no-signalling bound **4**.
      Build the PR box exactly, verify its no-signalling marginals, its S = 4, and the CHSH-game
      win probability 1 it permits; this is the foil that makes the SDP's 2√2 a *non-trivial* ceiling
      (nature could have been more nonlocal and still causal — it isn't).
      *(Note discovered while building: NPA level 1 is tight for plain CHSH → exactly 2√2, but loose for
      the tilted/marginal CHSH family, which needs a higher level — so the SDP is scoped to the CHSH
      headline it proves tightly, not over-claimed for tilted inequalities.)*
- [x] **`DeviceIndependentLab.tsx` + a new "🛡️ Device-Indep" tab** tying it together: the NPA SDP solving
      live (primal/dual convergence, certified 2√2), the SOS certificate, the DI-randomness curve, the
      steering ellipsoid + CJWR violation, the Eberhard η-threshold curve, and the PR-box three-ceilings view.
- [x] **Self-tests** (new "Device-Independent" group in the Tests tab) proving every headline number to
      machine precision: SDP primal=dual=2√2, the SOS residual = 0, P_g endpoints (S=2→1 bit lost,
      S=2√2→1 bit), S_3 = √3, the Eberhard threshold, and the PR box's S=4 + exact no-signalling.
- [x] **About-page pillar** + `project.json` description/tags refreshed.

### Verified (all green — 15 new self-tests, suite now 151/151)

- **SDP primal** (Burer–Monteiro over the elliptope) → `2.828427` = 2√2; the witness Γ is PSD (λ_min ≈ −2e-16)
  with unit diagonal. **SDP dual** certificate → `2.828427` with slack `Diag(y) − C ⪰ 0`, the dual variables
  landing on the analytic `y = [0, 1/√2, 1/√2, 1/√2, 1/√2]`. **Duality gap ≈ 1.6e-8** — optimality proven from
  the inside.
- **Operator SOS certificate** `2√2·I − S − (1/√2)(u²+v²)` is the **exact zero matrix** (max entry `2.2e-16`), the
  two squares are individually PSD, and `⟨Φ⁺|S|Φ⁺⟩ = 2.828427`. A rigorous, basis-independent second proof.
- **DI randomness**: `H_min(2) = 0`, `H_min(2√2) = 1` bit (`P_guess = ½`), monotone in between — certified vs any adversary.
- **EPR steering**: the singlet gives `S₂ = √2`, `S₃ = √3`; the Werner 3-setting threshold is exactly `w > 1/√3`;
  the steering ellipsoid fills the Bloch ball for the singlet (axes 1,1,1) and shrinks to radius `w`.
- **Detection / Eberhard**: `η*(π/4) = 0.82843 = 2(√2−1)` to ~1e-5; a less-entangled `|ψ(0.3)⟩` tolerates
  `η* = 0.71833 < 0.828`, the frontier heading toward the analytic Eberhard limit `2/3`.
- **PR box**: `S = 4` exactly, signalling deviation `0`, CHSH-game win `1` — placing quantum's 2√2 strictly between
  the local `2` and no-signalling `4`.
- **Build gate green** (conformance + lint + `tsc -b` + `vite build`), and a headless-Chromium smoke test renders all
  six cards, the live NPA solve, and the on-demand Eberhard frontier with no page errors.

### Future ideas (open)

- [ ] NPA **level 2** (and the "almost-quantum" `1+AB`) — a larger moment matrix that tightens the bound for the
      *tilted* CHSH family and other inequalities where level 1 is loose (the SDP solver already generalises).
- [ ] **Device-independent QKD** key-rate curves (the Acín–Brunner–Gisin–Massar–Pironio–Scarani protocol) from the
      certified randomness + the leakage of error correction.
- [ ] Push the **Eberhard frontier** into the deep small-θ tail with a homotopy / analytic-seed continuation so the
      curve visibly touches 2/3 rather than stopping at the numerically-robust range.
- [ ] The **I3322** inequality and dimension-witnessing (qubits suboptimal) once the NPA solver carries projector-level
      monomials, not just correlators.
- [ ] A **steering-robustness** measure (the critical mixing for a general two-qubit state) and the 3-D steering
      ellipsoid rendered on the existing Three.js Bloch sphere.

## Quantum Lab 15.0 — Nonlocality, Bell Tests & Quantum Pseudo-telepathy (this session)

The lab has been deep on *circuits* (algorithms, Shor), *codes* (3/9-qubit, Steane, surface,
distillation), *many-body* (MPS/DMRG/free fermions) and *compilation* (SK / KAK / Shannon) — but it
had **no foundations-of-nonlocality pillar**. 15.0 adds the one piece of quantum information that is
not about computing faster but about the world being *non-classical*: entanglement produces
correlations no local-hidden-variable (LHV) theory can reproduce, and in some games quantum players
win with *certainty* where the best classical players provably cannot. Everything runs on the exact
state-vector engine and every headline number is proven to machine precision in the self-test suite.

A genuinely new engine module `nonlocality.ts` + a `NonlocalityLab.tsx` tab (🔔 Bell), touching no
existing engine, plus an About entry and a block of new self-tests.

### The physics, built from scratch

- [x] **±1 dichotomic observables & correlators.** A measurement direction `θ` in the X–Z plane is
  the observable `A(θ) = cosθ·Z + sinθ·X` (Hermitian, eigenvalues ±1). The two-party correlator
  `E(a,b) = ⟨ψ| A(a) ⊗ B(b) |ψ⟩` is evaluated on the real engine by expanding the tensor product into
  four Pauli terms (ZZ, ZX, XZ, XX) and using the lab's `expectation`. On the Bell state |Φ⁺⟩ this
  reproduces the textbook `E(a,b) = cos(a−b)` to machine precision.
- [x] **The CHSH inequality.** `S = E(a,b) + E(a,b′) + E(a′,b) − E(a′,b′)`. Any LHV theory obeys
  `|S| ≤ 2` (the Bell–CHSH bound); the singlet/|Φ⁺⟩ with the canonical angles {Z, X} × {(Z±X)/√2}
  reaches `S = 2√2 ≈ 2.828` — **Tsirelson's bound**. Both constants are exposed, and a sweep of one
  angle plots S(θ) against the classical band ±2 and the Tsirelson lines ±2√2.
- [x] **Tsirelson's bound, two ways.** (1) A from-scratch Nelder–Mead **maximiser over the four
  measurement angles** rediscovers `S → 2√2` from a random start. (2) A **Monte-Carlo certificate**:
  thousands of random qubit strategies are checked to *never* exceed 2√2 — the bound is not just
  achieved, it is a ceiling. The analytic Tsirelson vector argument (`|v+v′| + |v−v′| ≤ 2√2` by
  Cauchy–Schwarz on `‖v±v′‖² = 4`) is reproduced numerically over the geometric representation.
- [x] **The CHSH game.** Reframed as a cooperative game: a referee sends bits x,y; players answer
  a,b; they win iff `a ⊕ b = x ∧ y`. The dictionary `p_win = (S + 4)/8` turns the classical bound
  into `0.75` and Tsirelson into `cos²(π/8) = (2+√2)/4 ≈ 0.854` — a strictly larger win rate with no
  communication.
- [x] **The GHZ / Mermin game — quantum pseudo-telepathy.** Three players share |GHZ⟩; on inputs
  (x,y,z) with x⊕y⊕z = 0 they must answer a⊕b⊕c = x∨y∨z. The Mermin operators (⟨XXX⟩ = +1,
  ⟨XYY⟩ = ⟨YXY⟩ = ⟨YYX⟩ = −1, all verified on the engine) make the quantum strategy "measure X for
  input 0, Y for input 1" win **all four questions with certainty (p = 1)**, while a brute force over
  all 64 deterministic classical strategies tops out at exactly **3/4** — proven, not asserted. The
  parity contradiction (multiplying the four constraints gives 0 = 1) is the certificate that no
  perfect LHV strategy exists.
- [x] **The Mermin–Peres magic-square game.** A 3×3 grid of two-qubit Pauli observables in which every
  row multiplies to +I and every column to +I *except the last, which is −I*. The whole operator
  algebra is verified from scratch on 4×4 matrices: each cell is involutory (O²=I, so ±1-valued), the
  three cells of any row/column mutually commute (so they're jointly measurable), and the row/column
  product identities hold exactly. The product-of-everything parity (+1 by rows, −1 by columns) is the
  contradiction that bounds classical play at **8/9** (confirmed by brute force over all consistent
  ±1 tables), while two shared Bell pairs let quantum players win **all 81 question pairs (p = 1)** —
  verified by an explicit 4-qubit shared-state simulation.
- [x] **Mermin–Klyshko — exponentially growing nonlocality.** The n-party generalisation of CHSH.
  The Mermin polynomial Mₙ (built by the Belinskii–Klyshko recursion `Mₙ = ½[Mₙ₋₁(Aₙ+Aₙ′) +
  M′ₙ₋₁(Aₙ−Aₙ′)]`) obeys |⟨Mₙ⟩| ≤ 1 for every LHV theory, but the n-qubit GHZ state reaches
  **2^((n−1)/2)** with the optimal X–Y-plane settings αⱼ = −(j−1)π/2n (found and verified to machine
  precision). Unlike CHSH's fixed 2√2 ceiling, the quantum/classical ratio *doubles every two
  parties* — at n=10 it is already 22.6×. The quantum value is read off the engine (the Mermin
  operator on |GHZₙ⟩); the LHV bound 1 is brute-forced over all 2²ⁿ deterministic assignments. A
  fourth card plots the exponential separation.
- [x] **Self-tests:** correlator = cos(a−b); CHSH classical ≤ 2 and Tsirelson = 2√2; Nelder–Mead
  rediscovers the optimum; Monte-Carlo Tsirelson ceiling; CHSH-game win-rate dictionary; GHZ Mermin
  expectations; GHZ quantum p=1 vs classical 3/4; magic-square involutivity, commutation, row/column
  products, classical 8/9 and quantum p=1.
- [x] **`NonlocalityLab.tsx` tab** with interactive cards: a CHSH explorer (four angle sliders, live S
  meter against the classical band and Tsirelson lines, the S(θ) sweep, the optimiser button, the
  game-win bars), the GHZ game (the four-question truth table, the Mermin-operator expectations, the
  classical-vs-quantum bars), the magic square (the 3×3 operator grid with live row/column product
  badges, the parity contradiction, classical-vs-quantum bars), and the Mermin–Klyshko exponential-
  violation plot + table (n = 2…10).
- [x] **About entry** explaining Bell's theorem, Tsirelson's bound, pseudo-telepathy and the
  exponential Mermin–Klyshko violation.

### Future ideas (open)
- [ ] The CH/Eberhard inequality and the **detection-loophole** threshold (η > 2/3 for the singlet).
- [ ] The **I3322** inequality (the next Bell inequality, where qubits are *not* optimal — needs
  higher dimension), as a contrast to CHSH.
- [ ] **EPR steering** and the steering ellipsoid; the LHS-model bound vs the quantum violation.
- [ ] A genuine **device-independent randomness** demo: bits certified by the CHSH violation.
- [ ] The **CHSH semidefinite (NPA level-1) relaxation** to prove Tsirelson's bound as an upper bound
  rather than sample it.

## Quantum Lab 2.0 — Open Systems, Error Correction & Verification (this session)

Shipped a major upgrade turning the pure-state toy into a genuine open-system + variational
quantum lab, all from scratch in TypeScript, fully tested and building green.

### Engine
- [x] **Complex Hermitian eigensolver** (`Hermitian.ts`) — cyclic Jacobi with exact-unitary
      complex rotations (c²+s²=1 by construction, robust on near-degenerate blocks). Powers
      exact von Neumann entropy, density-matrix spectra and Hamiltonian diagonalisation.
- [x] **Fixed a latent correctness bug**: bipartite entanglement entropy previously used only
      the diagonal of the reduced ρ (wrong unless ρ is already diagonal) — now exact via the
      eigensolver. Verified Bell = 1 bit, product = 0.
- [x] **Density-matrix engine** (`DensityMatrix.ts`) — mixed states with ρ→UρU†, Kraus channels
      ρ→ΣKρK†, partial trace, purity Tr(ρ²), entropy, reduced Bloch vectors. Byte-for-byte
      consistent with the state-vector path (operator embedding shares one bit-layout convention).
- [x] **Noise channels** (`noise.ts`) — depolarizing, amplitude/phase damping, bit/phase/bit-phase
      flip as Kraus sets; all verified to satisfy Σ Kᵏ†Kᵏ = I.
- [x] **Fixed an engine limitation**: `applyMatrix` sorted target qubits, forcing the *higher*
      index to always be the control — so `control < target` CNOTs were impossible (and the
      Builder's control dot mismatched the simulation). Now respects array order; this also fixed
      a **latent bug in the original W-state circuit** (it never actually produced |W₃⟩).

### Algorithms
- [x] **Quantum Phase Estimation** (phase kickback + inverse QFT) — exact for dyadic phases.
- [x] **Error-correcting codes**: 3-qubit bit-flip, 3-qubit phase-flip, **9-qubit Shor code**
      (corrects an arbitrary single-qubit error) — all reversible majority-vote decoders.
- [x] **VQE** — ground-state energy of a 2-site TFIM via a hardware-efficient ansatz + from-scratch
      Nelder–Mead, matching exact diagonalisation to <5e-3.
- [x] **QAOA for MaxCut** — cost/mixer layers, grid+multi-start optimization, ≥85% of optimum.
- [x] Algorithms grouped by category in the gallery.

### Tooling & UI
- [x] **Density / Noise lab** viz tab — interactive noise sliders, ρ heatmap (magnitude × phase),
      eigenvalue spectrum, purity & entropy, noisy Bloch spheres.
- [x] **Variational lab** page — run VQE/QAOA live with convergence plot & cut distribution.
- [x] **Tests** page — 23-case self-test suite runnable in-browser (green).
- [x] **Export**: OpenQASM 2.0, JSON, shareable `#c=` URL, circuit depth/gate metrics.

### Future ideas
- [x] Surface-code patch — shipped in 6.0 (rotated `[[d²,1,d]]` code + MWPM/blossom decoder + threshold)
- [ ] 5-qubit perfect [[5,1,3]] code
- [ ] Interactive Bloch sphere gate application; Wigner functions
- [ ] Larger QAOA graphs with code-splitting

## Quantum Lab 3.0 — Stabilizer engine, Schmidt, analytic gradients & RB (this session)

A second from-scratch simulation paradigm sits alongside the state-vector and density-matrix
engines: an **Aaronson–Gottesman stabilizer (CHP) tableau** that runs Clifford circuits in
*polynomial* time, scaling to dozens of qubits where the 2ⁿ state vector cannot. Plus exact
Schmidt decomposition, analytic parameter-shift gradients, randomized benchmarking and the
7-qubit Steane code — everything verified against the existing exact engine.

### Engine
- [x] **Stabilizer tableau** (`Stabilizer.ts`) — destabilizer/stabilizer rows over GF(2) with
      phase bits (Aaronson–Gottesman 2004). Clifford gates H, S, S†, X, Y, Z, CNOT, CZ, SWAP;
      single-qubit measurement with correct deterministic/random branching. O(n²) per gate.
- [x] **Stabilizer generators as Pauli strings** — read the n stabilizers of any Clifford state
      (GHZ → +XXXX, +ZZII, +IZZI, +IIZZ; verified). Plus `pauliEigenvalue` for measuring an
      arbitrary commuting Pauli observable (code syndromes), and non-Clifford gate detection.
- [x] **Cross-check** — over 400 random Clifford circuits the tableau's full measurement
      distribution matched the state vector to 7e-16, and every read-off generator stabilises |ψ⟩
      exactly (verified in the self-test suite).
- [x] **Schmidt decomposition** (`Schmidt.ts`) — bipartite |ψ⟩ = Σ λᵢ|aᵢ⟩|bᵢ⟩ via reduced-ρ
      eigendecomposition; returns Schmidt coefficients, rank, and entropy (= entanglement entropy,
      matched to 1e-15).
- [x] **Analytic gradients** (`gradient.ts`) — exact parameter-shift rule (±π/2), a Nesterov
      momentum gradient-descent VQE; gradient matches central differences to 5e-11 and reaches the
      exact ground energy.
- [x] **Randomized benchmarking** (`rb.ts`) — enumerated 24-element single-qubit Clifford group,
      random sequences closed with the exact inverse, exact survival on the density-matrix engine
      under any noise channel, log-linear decay fit → average error per Clifford (recovers f = 1−p).

### Algorithms
- [x] **Steane 7-qubit code** ([[7,1,3]] CSS code) — encode |0⟩ₗ (prep circuit verified against
      all 6 stabilizers + logical operators), inject an arbitrary single-qubit error, read the
      Hamming syndrome from the live tableau, correct, and verify recovery — all 21 single-qubit
      errors located and corrected.

### UI
- [x] **Stabilizer Lab** page — GHZ / line-graph / ring-graph / Steane presets, qubit count scaled
      to 30, live stabilizer generators (colour-coded Pauli strings) and a state-vector-vs-tableau
      memory comparison.
- [x] **Randomized benchmarking** card — channel + strength sliders, survival-vs-length scatter
      with the fitted decay curve, extracted fidelity.
- [x] **Gradient-descent VQE** in the Variational lab — Nelder–Mead vs analytic gradients raced on
      one convergence plot.
- [x] **Schmidt panel** — Schmidt spectrum bars + rank in the State-vector viz tab.
- [x] Extended the in-browser self-test suite to 37 cases (stabilizer↔state-vector, Schmidt,
      gradients, Steane recovery, RB) and refreshed the About page.

## Quantum Lab 4.0 — Tensor Networks (MPS + TEBD) (this session)

A **fourth** from-scratch simulation paradigm joins the state-vector, density-matrix and
stabilizer engines: a **Matrix Product State** (tensor network). Where the stabilizer tableau
buys scale by restricting to Clifford gates, the MPS buys scale by restricting *entanglement* —
it runs **arbitrary** gates in O(χ³) and stores the state in O(n·χ²), exact for bounded-χ states
and a controlled, quantifiable approximation beyond. This is the regime real condensed-matter and
near-term-circuit simulation lives in, and it lets the lab reach 40 qubits the 2ⁿ vector cannot.

### Engine
- [x] **Complex SVD from scratch** (`SVD.ts`) — thin A = U Σ V† via the eigendecomposition of the
      *smaller* Gram matrix (A†A or AA†), reusing the cyclic-Jacobi idea. A flat-buffer core
      (`svdFlat`, Float64Array re/im, zero per-element allocation) with a `Complex[][]` wrapper for
      the tests. Verified: reconstructs random rectangular matrices to 1e-15 and U is orthonormal.
- [x] **Matrix Product State engine** (`MPS.ts`) — rank-3 site tensors in flat re/im buffers, mixed
      canonical form with a tracked orthogonality centre, single-qubit gates by direct contraction,
      two-qubit gates by contract → apply → SVD-resplit with truncation to χ_max, and a **SWAP
      network** so arbitrary (distant) qubit pairs work. Exact **truncation-error** accounting
      (Σ of discarded Schmidt weight).
- [x] **Read-out the representation gives for free**: bond Schmidt spectra and the **entanglement
      entropy of every cut** in one canonical sweep; ⟨Zᵢ⟩/⟨Xᵢ⟩ from the centre tensor; **perfect
      (uncorrelated) sampling** in O(n·χ²) via the right-canonical gauge; exact amplitudes and (for
      small n) the dense state vector for cross-checking.
- [x] **Cross-checked against the exact engine**: MPS at full χ reproduces the state vector
      amplitude-for-amplitude (≤1e-9), GHZ needs exactly χ=2 with 1 bit of entropy at every cut,
      bond entropy equals the reduced-density-matrix entropy, sampling reproduces the Born rule.
- [x] **Performance**: rewrote the contraction + SVD hot paths onto typed arrays (no `Complex`
      allocation), ~3–4× faster — a 40-qubit depth-10 random brickwork at χ=12 runs in ~0.3 s.

### Physics
- [x] **TEBD time evolution** (`tebd.ts`) — real-time dynamics of the transverse-field Ising chain.
      Bond Hamiltonians exponentiated exactly (V e^{−iτΛ} V†) and applied in a 2nd-order Strang
      (even/odd) Trotter sweep with per-gate truncation. A global quench from |0…0⟩ reproduces the
      textbook **linear growth of half-chain entanglement** (a correlation light-cone) and the
      oscillating transverse magnetisation — matched to **exact** dense evolution to ~1e-4 on small
      chains.

### UI
- [x] **Tensor tab** (`TensorLab.tsx`) — *Circuit → MPS* card: GHZ / cluster / QFT / random-brickwork
      presets, qubit (≤40) and bond-dimension χ sliders, live bond-dimension and entanglement-entropy
      profiles across the chain, perfect-sampling histogram, MPS-vs-dense memory & compression, and a
      live "✓ exact" cross-check vs the state vector for n ≤ 12. *TEBD quench* card: run a
      transverse-field-Ising quench and watch the entanglement light-cone and magnetisation evolve,
      with a "vs exact evolution" error readout on small chains.
- [x] Extended the in-browser self-test suite 37 → **47 cases** (SVD, MPS↔state-vector amplitudes &
      entropy, GHZ χ=2, truncation accounting, perfect sampling, TEBD↔exact dynamics) and added a
      Tensor-Networks card to the About page.

### Future ideas
- [x] Two-site DMRG ground-state search (variational MPS) — shipped in 5.0 (TFIM **and** Heisenberg/XXZ)
- [ ] Finite-temperature METTS / purification (MPO) and a Trotterised MPO time-evolution
- [ ] Web Worker offload for the heavy quench/DMRG so the UI never blocks
- [ ] iTEBD / infinite-MPS for translationally-invariant chains

## Quantum Lab 5.0 — DMRG & Matrix Product Operators (this session)

The flagship algorithm of 1-D quantum many-body physics now runs in the browser, built
entirely from scratch on the existing MPS / SVD / Hermitian-eigensolver stack: **two-site
DMRG**, which finds the *ground state* of a local Hamiltonian variationally over the
bond-dimension-χ Matrix Product State manifold. This closes the top item on the 4.0 roadmap
and turns the tensor-network engine from a forward simulator into a variational solver.

### Plan (this session)
- [x] **Matrix Product Operator** (`MPO.ts`) — the operator analogue of an MPS: a chain of
      rank-4 tensors with the standard lower-triangular finite-state-machine construction.
      Builders for the transverse-field Ising chain (bond dim 3) and the Heisenberg/XXZ chain
      (bond dim 5, complex Y, tunable anisotropy Δ and optional longitudinal field), plus a
      dense expander `mpoToDense` for the exact cross-check.
- [x] **Left/right environment tensors** — the contracted MPS·MPO·MPS sandwich blocks, built
      and updated incrementally as the orthogonality centre sweeps (staged, allocation-light
      typed-array contractions).
- [x] **Matrix-free effective Hamiltonian** `Hₑff·Θ` — the two-site superblock operator
      applied via a four-stage contraction (L · Wₛ · Wₛ₊₁ · R · Θ); no dense Hₑff is ever formed.
- [x] **Lanczos eigensolver** (`dmrg.ts`) — Krylov iteration with full reorthogonalisation,
      warm-started from the current Θ, tridiagonal projection diagonalised by the app's
      Hermitian eigensolver; returns the local ground eigenpair.
- [x] **Two-site sweep + truncated SVD** — fuse → optimise → re-split to χ with exact
      discarded-Schmidt-weight accounting, moving the centre; left-to-right and right-to-left
      half-sweeps to the variational minimum, with a per-half-sweep energy convergence trace.
- [x] **Energy variance ⟨H²⟩ − ⟨H⟩²** via a **double-layer MPO contraction** — the
      basis-independent certificate that the converged state is a genuine eigenstate, valid at
      chain lengths far past exact diagonalisation.
- [x] **Multi-start restarts** — DMRG can stall in a local minimum in symmetry-broken /
      near-degenerate phases (the deep ferromagnetic Ising regime); a few independent random
      restarts keep the lowest-energy run and make convergence robust there (verified: n=12 h=0.1
      goes from a stuck excited state to the exact ground at variance ~1e-12).
- [x] **DMRG lab** card (`TensorLab.tsx`) — pick TFIM or Heisenberg/XXZ, n (≤40), χ and the
      model parameter; watch the energy descend per half-sweep against the exact line (n ≤ 8),
      with ground-state entropy & bond-dimension profiles, variance certificate, χ reached,
      truncated weight and solve time.
- [x] **Quantum phase-transition scan** — sweep a control parameter and solve the ground state
      at each value, plotting the central-cut entanglement entropy and energy/site. The
      entropy peaks where the gap closes: the Ising critical field h=1 (a small pinning field
      lifts the Z₂ degeneracy for a clean peak) and the gapless XXZ critical line −1<Δ<1 (zero
      entanglement in the gapped ferromagnet beyond Δ=−1) — a direct ground-state locator of a
      quantum critical point.
- [x] **Tests** — extended the in-browser suite 47 → **52 cases**: TFIM and Heisenberg/XXZ
      (incl. anisotropy) ground energies vs exact diagonalisation of the *same* MPO, the
      ground-state entanglement profile vs the exact eigenstate, the energy variance → 0, and
      the XXZ ferromagnet-vs-critical entanglement contrast.

### Verified
- DMRG ground energies match exact diagonalisation to **~1e-13** (TFIM n=6/7/8, Heisenberg
  Δ = −0.5/0.5/1/1.5), entanglement-entropy profiles to ~1e-12, variance = 0 for gapped chains.
- The residual variance at the **critical** Ising point (h=1) is honest bond-truncation error:
  the central cut wants χ≈2^(n/2) and a smaller χ leaves a small, *quantified* error — exactly
  the regime DMRG is designed to expose.
- Performance (typed-array hot paths): Heisenberg n=20 χ=20 ≈ 1.4 s, n=30 χ=24 ≈ 4 s — well
  past where a 2ⁿ state vector could be diagonalised at all. lint + tsc + build + 51/51 green.

## Quantum Lab 6.0 — Topological QEC: the Surface Code & an MWPM (blossom) decoder (this session)

This closes the oldest item on the roadmap (the 2.0 "surface-code patch" future idea) with the
real thing: the **rotated planar surface code**, the leading architecture for fault-tolerant
quantum computing, decoded by a genuine **Minimum-Weight Perfect Matching** decoder built from
first principles. No combinatorics library, no PyMatching — a faithful from-scratch implementation
of **Edmonds' blossom algorithm** (Galil's O(V³) primal-dual weighted matching) is the engine, and
the lab uses it to reproduce the hallmark of a working quantum code: an **error-correction
threshold** where bigger codes start to help.

### Plan (this session)
- [x] **General-graph max-weight matching** (`surface/blossom.ts`) — a faithful TypeScript port of
      the canonical primal-dual blossom algorithm: dual variables + complementary slackness, on-the-fly
      contraction/expansion of blossoms (odd alternating cycles), `maxWeightMatching` with a
      `maxcardinality` flag, and a `minWeightPerfectMatching` wrapper (weight negation against a
      constant turns min-weight-perfect into max-weight-max-cardinality). All weights kept
      integer/half-integer so the slack comparisons are exact and termination is guaranteed.
      (Caught two porting bugs: the internal `mate[]` stores *endpoints* and needs a final
      vertex conversion; and the reference relies on Python negative-list-indexing wrap-around in
      `expandBlossom`/`augmentBlossom`, emulated with modular index helpers.)
- [x] **Rotated surface code construction** (`surface/SurfaceCode.ts`) — for any odd distance d:
      d² data qubits, the (d−1)² bulk weight-4 checks on a checkerboard, the 2(d−1) weight-2
      boundary checks, giving exactly d²−1 stabilizers, with representative logical X (a row) and
      logical Z (a column). Verified: every X- and Z-check commutes, and the two logicals anticommute.
- [x] **MWPM decoder** — for each error sector, build the decoding graph (vertices = detecting
      checks + a single boundary node; each data qubit is an edge between its two checks or from its
      one check to the boundary), BFS for defect-pair and defect-boundary distances **with the boundary
      enterable-but-not-traversable** (so it never serves as an intermediate vertex), assemble the
      matching graph with boundary copies, run the blossom solver, and XOR the matched correction
      chains. The residual is then tested for commutation with the logical operator: a stabilizer is a
      success, a logical string is a failure.
- [x] **Monte-Carlo threshold experiment** — independent bit-flip noise at rate p, decoded by MWPM
      across distances d = 3,5,7, with the threshold located from the crossing of the most-separated
      curves. Recovers **p_th ≈ 10%** (the known MWPM code-capacity threshold ≈ 10.3%), reproducibly
      across seeds (0.097–0.103).
- [x] **Surface tab** (`SurfaceLab.tsx`) — an interactive lattice: pick d and the error type, sample
      errors at a chosen p or click qubits to toggle them by hand, and watch the checks light up
      (defects), the MWPM matching draw across the lattice (including connections to the boundary),
      the correction qubits ring, and a live ✓ corrected / ✗ logical-error verdict. Plus the threshold
      sweep plot with the distance curves crossing at the estimated p_th.
- [x] **Tests** — extended the in-browser suite 52 → **59 cases**: blossom MWPM vs brute-force
      matching on 120 random graphs, code structure (d²−1 commuting checks, anticommuting logicals for
      d=3,5,7), the decoder correcting *every* error of weight ≤ ⌊(d−1)/2⌋, and the threshold ordering
      (d=7 beats d=3 below threshold, loses above it).

### Verified
- Blossom MWPM equals exhaustive brute force on 120 random complete graphs (exact, zero diff).
- d = 3,5,7 codes have d²−1 commuting stabilizers and anticommuting logicals; the decoder corrects
  all single-qubit errors and all errors up to the code distance.
- The threshold experiment crosses at ≈10% across seeds. lint + tsc + build + 59/59 self-tests green.

### Future ideas
- [x] Phenomenological noise: repeated noisy syndrome rounds → a 3-D matching graph — shipped in 7.0
- [x] Logical-error-rate fit Λ = p_L(d)/p_L(d+2) and a finite-size-scaling collapse for a sharper p_th — shipped in 7.0
- [x] Union-Find decoder for speed — shipped in 7.0 (Delfosse–Nivelle; cross-checked against MWPM)
- [ ] Circuit-level noise with diagonal hook edges (the full syndrome-extraction circuit)
- [ ] Correlated (depolarizing) decoding that matches X and Z jointly
- [ ] Web Worker offload so big sweeps never block the UI

## Quantum Lab 7.0 — Fault Tolerance in Space-Time (this session)

The 6.0 surface code assumed *perfect* syndrome measurement (the code-capacity model). Real
hardware measures the stabilizers repeatedly and **each measurement is itself noisy**, so a
single bad readout is indistinguishable from a data error that flickers on for one round. 7.0
closes that gap with the real fault-tolerance story — decoding in **space-time** — plus a
second, near-linear-time decoder and the finite-size-scaling analysis that turns a fuzzy
crossing into a sharp threshold. Everything is additive (new modules + new lab cards) and is
cross-checked against the 6.0 MWPM decoder and brute force, the project's way.

### Plan (this session)
- [x] **Generic decoder layer** (`surface/decoder.ts`) — factor the decoder out from the graph.
      A `MatchingGraph` is detector nodes + one boundary sink + edges that each carry an
      optional **data qubit** (space edge) or nothing (time edge = measurement error). Both the
      2-D code-capacity graph and the 3-D space-time graph are instances.
- [x] **MWPM on the generic graph** (`decodeMWPM`) — BFS shortest-path metric (boundary
      enter-only) → Edmonds' blossom (reused from 6.0) → path reconstruction toggling only the
      data qubits along each matched chain.
- [x] **Union-Find decoder** (`decodeUF`, Delfosse–Nivelle 2017) — from scratch: uniform
      cluster growth (each odd cluster claims a half-edge per round; an edge claimed from both
      sides fuses its clusters; the boundary is a free, infinite defect sink) until every
      cluster is even or boundary-connected, then a **peeling decoder** (Delfosse–Zémor) on a
      spanning forest of the grown erasure reads off a concrete correction. Near-linear time,
      provably correct up to the code distance. (Caught one real bug: the growth loop must keep
      going when a round advances the frontier without yet *fusing* anything — a boundary-bound
      edge grows one half-edge per round — instead of bailing the moment no edge completes.)
- [x] **Phenomenological noise + the 3-D space-time graph** (`surface/spacetime.ts`) — T noisy
      rounds (data flip rate p, measurement flip rate q) + one perfect readout; detectors are
      the *differences* of consecutive syndromes; the graph stacks T+1 copies of the 2-D graph
      with a vertical measurement-error edge between layers. `spaceTimeShot` runs one full
      experiment (history + verdict) and `phenomLogicalErrorRate` / `phenomThresholdSweep`
      Monte-Carlo it — recovering the textbook phenomenological threshold (~2.5–3%, far below
      the 10.3% code-capacity figure: the price of measuring imperfectly).
- [x] **Finite-size scaling** — `lambdaRatios` computes Λ_d = p_L(d)/p_L(d+2) (>1 and growing
      below threshold = a working code), and `collapseFit` performs the universal data collapse
      (Wang–Harrington–Preskill): grid-search (p_th, ν), fit a quadratic in x=(p−p_th)·d^{1/ν}
      by least squares, keep the minimum-residual collapse. Recovers p_th ≈ 9.7% for code
      capacity and ≈ 2.3% phenomenological from small distances.
- [x] **Surface lab UI** — a **space-time decoder** card (T-round slider, p=q, decoder toggle,
      a strip of per-round mini-lattices showing the detector history with the perfect final
      round flagged, full verdict), a generalised **threshold** card (toggle code-capacity ↔
      phenomenological and MWPM ↔ Union-Find), and a **finite-size scaling** card (Λ table +
      a universal-collapse plot of every (d,p) point folded onto one curve, with fitted p_th, ν).
- [x] **Tests** — extended the in-browser suite **59 → 67**: Union-Find corrects every error of
      weight ≤ ⌊(d−1)/2⌋ (d=3,5,7), Union-Find agrees with optimal MWPM on the logical verdict
      ≥ 90% of the time, the space-time graph has the right node/time-edge/space-edge counts,
      the phenomenological threshold ordering holds (below p_th the bigger code wins, above it
      loses — for both decoders), Λ > 1 below threshold, and the collapse fit recovers p_th ≈ 10%.

### Verified
- Union-Find corrects all errors up to the code distance and tracks MWPM's logical verdict to
  ~95% on random code-capacity errors (d=5, p=8%) — the expected near-optimality.
- Phenomenological MWPM threshold ≈ 2.5%, Union-Find ≈ 2.3% (UF sits just under MWPM, as it
  should); the universal collapse independently recovers ~2.3% phenomenological / ~9.7% code
  capacity. lint + tsc + build + 67/67 self-tests green.

## Quantum Lab 8.0 — Free Fermions: the exactly-solvable TFIM (Jordan–Wigner + Bogoliubov) (this session)

Every engine so far either pays 2ⁿ (state vector, density matrix), restricts the gate set
(stabilizer), or *approximates* by bounding entanglement (MPS / DMRG / TEBD). 8.0 adds the one
thing none of them is: an engine that solves a genuinely interacting-looking model **exactly, in
polynomial time**, at sizes far beyond all of them — by exploiting the fact that the
transverse-field Ising chain is *secretly free*. The Jordan–Wigner transform maps the spins onto
non-interacting fermions, and the Lieb–Schultz–Mattis diagonalisation of the resulting quadratic
Hamiltonian turns out to be **literally a singular-value decomposition** of an n×n matrix — so the
lab's own from-scratch complex SVD does the work. The payoff is an *exact oracle* that reproduces
the lab's TFIM ground energy (from exact diagonalisation and DMRG) to machine precision and then
runs to hundreds of sites, recovering real universal physics.

The solver works in the Jordan–Wigner-natural convention H = −J ΣXX − h ΣZ, the on-site Hadamard
image of the lab's H = −J ΣZZ − h ΣX: identical spectrum and identical spatial entanglement (a
Hadamard on every site cannot move entanglement between regions), so the cross-checks against the
existing TFIM MPO and `QuantumState.entanglementEntropy` are exact.

### Plan (this session)
- [x] **Jordan–Wigner + BdG solver** (`FreeFermion.ts`) — build the quadratic-fermion matrices
      A (symmetric), B (antisymmetric) for the open TFIM; recognise R = A−B and (A+B) = Rᵀ so the
      Lieb–Schultz–Mattis eigenproblem φ(A−B)(A+B)=Λ²φ **is the SVD R = UΣVᵀ** (Λ_k = singular
      values, φ = U, ψ = V) — reusing `svdFlat` verbatim. Ground energy E₀ = −½ΣΛ_k.
- [x] **Per-mode energies aligned with the mode vectors** — computed as Λ_k = φ_kᵀ R ψ_k from each
      mode's own vectors, so the quench attaches phases to the right mode (a misalignment leaves
      the static correlators correct but silently breaks the dynamics — caught and fixed).
- [x] **Ground-state correlation matrices** P=⟨cᵢ†cⱼ⟩, Q=⟨cᵢcⱼ⟩ from the Bogoliubov amplitudes,
      and field-direction magnetisation ⟨Zᵢ⟩ = 1 − 2Pᵢᵢ.
- [x] **Entanglement entropy via the Majorana covariance matrix** (Peschel) — build the block's
      2L×2L covariance from P, Q (the (M−I) matrix is Hermitian, diagonalised by the app's
      Hermitian eigensolver; its ±λ pairs give S = Σ H₂((1+λ)/2)) — exact, O(L³), at any n.
- [x] **Central charge c = ½** — a Calabrese–Cardy fit of S(L) = (c/6) ln[(2n/π) sin(πL/n)] reads
      the Ising-CFT central charge straight off the entanglement of an exactly-solved critical chain.
- [x] **Pfeuty thermodynamic limit** — closed-form e₀(J,h) = −(1/π)∫₀^π √(J²+h²−2Jh cos k) dk, and
      the **finite-temperature** energy E(T)/n = −(1/2n)ΣΛ_k tanh(Λ_k/2T).
- [x] **Exact real-time quench** (`ffQuench.ts`) — ground state of H(J,h_i) evolved under H(J,h_f).
      The state stays Gaussian, so the fermionic two-point functions evolve in **O(n³) per step**
      via the final-Hamiltonian mode rotations cⱼ(t)=Σᵢ[Fⱼᵢ(t)cᵢ + Gⱼᵢ(t)cᵢ†], cast as four
      complex matrix products against the initial correlators. (Subtlety caught: F is symmetric but
      G's imaginary part is *antisymmetric*, Gᵀ = conj(G) — the inner factor in the products must be
      the transpose.) Observables: ⟨Z⟩(t) and the half-chain entropy → the entanglement light-cone.
- [x] **Independent dense quench oracle** — builds the 2ⁿ Hamiltonians and evolves exactly,
      sharing no code with the free-fermion path; the cross-check the quench is graded against.
- [x] **Free-Fermion lab** (`FreeFermionLab.tsx`) — four cards: the Bogoliubov spectrum &
      exact-vs-Pfeuty energy (n up to 256), the quantum-phase-transition sweep (gap closing &
      entanglement peak at h=J), the central-charge fit (c≈½ live), and the quench light-cone
      (half-chain entropy & magnetisation vs time, ✓-exact for n ≤ 8).
- [x] **Tests** — extended the in-browser suite **67 → 75**: ground energy vs exact diagonalisation,
      block entropy vs exact RDM, gap closing at h=J, central charge c=½, Pfeuty energy density,
      thermal limit, quench vs exact dense evolution, and the light-cone growth.

### Verified
- TFIM ground energy matches exact diagonalisation of the lab's own MPO to **~1e-13** (n=6,7,8).
- Block entanglement entropy matches the exact reduced-density-matrix entropy to **~3e-11** at
  every cut (n=6,8).
- The fitted central charge is **c ≈ 0.524** at n=48 (→ 0.5 as n→∞); the Pfeuty energy density
  matches to ~1e-3 at n=220; the gap is ~0.02 at h=J (n=160) and ~1.6 at h=1.8.
- The quench reproduces ⟨Z⟩(t) to **~1e-7** and the half-chain entropy to **~1e-6** vs exact dense
  evolution (n=6,8). lint + tsc + build + 75/75 self-tests green.

### Future ideas
- [ ] XY-model / general quadratic fermions (anisotropy γ), and the critical exponents from
      finite-size scaling of the gap → **shipped in 9.0** (open + periodic anisotropic XY)
- [ ] Periodic boundaries (the even/odd parity sectors) for a clean closed-form match
      → **shipped in 9.0** (momentum-space anti-periodic sector, exact finite-N Loschmidt)
- [ ] Free-fermion entanglement *negativity* and mutual information between disjoint blocks
      → **mutual information shipped in 9.0**; negativity still open
- [ ] Loschmidt echo / dynamical quantum phase transitions after the quench → **shipped in 9.0**

## Quantum Lab 9.0 — Dynamical Quantum Phase Transitions, the XY model & periodic free fermions (planned + shipping this session)

The free-fermion engine was, until now, the *open*, *isotropic* (Ising, γ=1) chain in
*equilibrium plus a single quench observable*. 9.0 turns it into the full toolkit a condensed-matter
theorist actually reaches for: the **anisotropic XY model** in a field (the Ising chain is its γ=1
point), solved both as an open chain and — newly — in **momentum space with periodic boundaries**
(the clean, factorising closed form), and used to compute the headline non-equilibrium phenomenon
of the last decade: the **dynamical quantum phase transition (DQPT)** and its integer-quantised
**dynamical topological order parameter**. Every new quantity is cross-checked against an
independent dense 2ⁿ oracle that shares no code with the free-fermion path.

The physics, validated end-to-end in a throwaway oracle before a line of TS was written:

- The periodic chain factorises into independent 2×2 momentum modes (Anderson pseudospins). The
  Loschmidt return amplitude is then a **product over modes**, exact at finite N in the
  anti-periodic (even-parity) sector — matched to dense exact evolution to **~1e-15**.
- A quench *across* the critical point produces **Fisher-zero lines** that cross the time axis: the
  rate function l(t) = −lim (1/N) ln|⟨ψ₀|e^{−iH_f t}|ψ₀⟩|² develops **non-analytic cusps** at the
  critical times tₙ* = (2n+1)π/εₖ* (kₖ* the critical mode where the initial and final pseudospins
  are orthogonal). A quench that does *not* cross stays analytic — no DQPT.
- The **dynamical topological order parameter** ν_D(t) (Budich–Heyl Pancharatnam geometric-phase
  winding) is an **integer** that is 0 before the first DQPT and jumps by exactly **+1 at every
  cusp** — validated to land on 0,1,2,3,… at the analytic critical times, and to stay 0 for every
  non-crossing quench.

### Plan / steps (this session)
- [x] **`solveXY(n, J, h, γ)`** — generalise the open-chain BdG solver to the anisotropic XY model
      (the only change is two off-diagonals of R = A−B: R[i,i+1] = −J(1−γ), R[i+1,i] = −J(1+γ));
      `solveTFIM` becomes `solveXY(…, 1)`. Rᵀ = A+B still holds for any γ, so the SVD trick and all
      downstream correlators/entropy carry over untouched. Cross-check vs dense XY diagonalisation.
- [x] **`xyChain.ts` — periodic momentum-space engine.** Anderson-pseudospin field
      d⃗(k) = (h − J cos k, J γ sin k), dispersion εₖ = 2|d⃗|, ground-energy density
      e₀ = −(1/π)∫₀^π |d⃗| dk (reduces to Pfeuty at γ=1), field-direction magnetisation, and the
      **XY phase diagram** (Ising line h=1 for γ≠0; the anisotropy/XX critical line γ=0, h<1).
- [x] **Loschmidt echo / DQPT.** `loschmidtRate` (continuum integral of −ln|Gₖ|²,
      |Gₖ(t)|² = 1 − sin²Δθₖ·sin²(εₖ^f t)), the **critical mode** (d⃗_i·d⃗_f = 0; for Ising
      cos k* = (1+h_i h_f)/(h_i+h_f)) and the **critical times**; `loschmidtFiniteN` (exact product
      over anti-periodic momenta) for the finite-N cross-check.
- [x] **Dynamical topological order parameter** `dtop(t)` — per-mode 2×2 unitary evolution, the
      Pancharatnam geometric phase φₖ^G = arg⟨u(0)|u(t)⟩ + Eₖ t, integrated to an integer winding
      over k ∈ [0,π]; returns ν_D(t) and the φₖ^G(k) curve at a chosen time.
- [x] **Dense periodic oracle** `loschmidtDense(n, …)` — builds the 2ⁿ periodic XY Hamiltonian,
      exact ground state → exact time evolution → l_N(t); shares no code with the FF path.
- [x] **Mutual information between disjoint blocks** `mutualInformation` on the open-chain ground
      state (I(A:B) = S_A + S_B − S_{A∪B} from the Majorana covariance matrix), and its decay with
      separation (exponential off-criticality, slow at h=J).
- [x] **New `DynamicsLab.tsx` tab (🌀 Dynamics)** — a DQPT card (h_i/h_f/γ sliders; l(t) with cusps
      marked at the critical times; "crosses critical point?" verdict; exact-dense overlay for n≤8)
      and a DTOP card (ν_D(t) integer step function + the winding of φₖ^G across the Brillouin zone).
- [x] **Extend `FreeFermionLab.tsx`** — an XY-anisotropy card (γ slider, dispersion & phase diagram)
      and a disjoint-block mutual-information card.
- [x] **Tests (72 → 80)** — solveXY≡solveTFIM at γ=1; open XY ground energy vs dense; Loschmidt
      finite-N vs dense (~1e-14); DQPT cusps ⇔ critical-point crossing; ν_D integer, +1 per cusp,
      0 for non-crossing; e₀ vs the closed-form integral; mutual information identity & decay.
- [x] **Wire the tab + About entry + this journal.**

### Verified
- The exact finite-N Loschmidt rate (anti-periodic momentum product) matches an independent dense
  2ⁿ time evolution of the periodic XY chain to **~1e-14** (n=6,8; Ising and anisotropic γ).
- `criticalTimes` land exactly on the numerically-located cusps of the rate function
  (1.171, 3.512, 5.854 for the h=2→0.5 Ising quench); ν_D(t) = 0 before the first cusp and jumps
  **0→1→2→3** at each, and is identically 0 for every non-crossing quench.
- `solveXY(γ=1)` reproduces `solveTFIM` to 0; the open anisotropic-XY ground energy matches exact
  diagonalisation to ~5e-13 (incl. the XX point γ=0); the thermodynamic e₀ matches the open chain
  to ~2e-3 at n=240; the disjoint-block mutual information satisfies I(A:Ā)=2S(L) to 1e-13 and is
  ~1e-11 between separated blocks deep in the paramagnet but 0.012 at criticality.
- Two real bugs caught in development (both via the dense oracle): the Loschmidt oscillates at the
  full dispersion εₖ=2|d⃗| not |d⃗| (a missing factor of 2 in the per-mode frequency), and the
  geometric-phase decomposition is φ^G = arg⟨u|U|u⟩ **+** Eₖt (a sign that, wrong, leaked a spurious
  t-linear winding into ν_D). lint + tsc + build + 80/80 self-tests green.

## Session log

- 2026-06-13 (claude/claude-sonnet-4-6): Created full quantum circuit simulator from scratch. Implemented complex arithmetic, tensor product gate application, 11 pre-built algorithms (Grover, QFT, Deutsch-Jozsa, teleportation, Bell/GHZ/W states, Bernstein-Vazirani, Simon), Three.js Bloch spheres, drag-and-drop circuit editor, entanglement entropy, state vector visualization, and Monte Carlo measurement sampling.
- 2026-06-14 (claude/claude-opus-4-8): **Quantum Lab 3.0.** Added a second from-scratch simulation
  paradigm — an Aaronson–Gottesman stabilizer (CHP) tableau (`Stabilizer.ts`) that runs Clifford
  circuits in O(n²), scaling to 30 qubits where the state vector cannot, with live signed-Pauli
  generators and an arbitrary-Pauli-observable eigenvalue routine. Built exact Schmidt decomposition
  (`Schmidt.ts`), analytic parameter-shift gradients + a momentum gradient-descent VQE (`gradient.ts`),
  single-qubit randomized benchmarking with a Clifford-group enumeration and decay fit (`rb.ts`), and
  the Steane [[7,1,3]] code with live stabilizer-syndrome decoding (`steane.ts`). New **Stabilizer**
  page (generators, memory comparison, Steane syndrome demo, RB plot), a Schmidt spectrum panel, and a
  Nelder–Mead-vs-gradient VQE race in the Variational lab. Every module was numerically verified
  against the exact engine (stabilizer↔state-vector to 7e-16, Schmidt entropy to 1e-15, gradients to
  5e-11, all 21 Steane errors corrected, RB recovers f=1−p); the in-browser suite grew 23 → 37 cases,
  all green, with lint + tsc + build passing. Built an open-system + variational engine from scratch: a complex Hermitian Jacobi eigensolver, a full density-matrix simulator with Kraus noise channels (depolarizing, amplitude/phase damping, bit/phase flip), and exact von Neumann entropy/purity. Added QPE, the 3-qubit bit-flip & phase-flip codes, the 9-qubit Shor code, VQE (Nelder–Mead, matches exact diagonalisation), and QAOA MaxCut. Added a Density/Noise viz tab (ρ heatmap, spectrum, noisy Bloch spheres), an interactive Variational lab, a 23-case in-browser test suite, OpenQASM 2.0 / JSON export, shareable URLs, and circuit metrics. Fixed three latent bugs along the way: the diagonal-only entropy approximation, the sorted-qubit CNOT direction (control could not be the lower-indexed qubit), and the W-state circuit (which never actually produced |W₃⟩). Verified green: lint + tsc + build + 23/23 self-tests.
- 2026-06-15 (claude/claude-opus-4-8): **Quantum Lab 4.0 — Tensor Networks.** Added a fourth
  from-scratch simulation paradigm: a Matrix Product State engine (`MPS.ts`) backed by a from-scratch
  complex thin SVD (`SVD.ts`, flat-buffer Gram-eigendecomposition core). It runs arbitrary 1- and
  2-qubit circuits (distant pairs via a SWAP network) in O(χ³), truncating each two-qubit gate's SVD
  to a chosen bond dimension χ with exact discarded-weight accounting — reaching 40 qubits the 2ⁿ
  vector cannot hold. The canonical form yields per-cut entanglement entropy and Schmidt spectra in
  one sweep, ⟨Z⟩/⟨X⟩ from the centre tensor, and exact O(n·χ²) perfect sampling. Built TEBD real-time
  evolution (`tebd.ts`) of the transverse-field Ising chain — exact bond-Hamiltonian exponentials in a
  2nd-order Trotter sweep — reproducing the global-quench entanglement light-cone and oscillating
  magnetisation. New **Tensor** tab (`TensorLab.tsx`): Circuit→MPS card (GHZ/cluster/QFT/brickwork
  presets, χ slider, live bond-dimension & entropy profiles, sampling histogram, memory/compression,
  exact cross-check for n≤12) and a TEBD quench card (entanglement & magnetisation vs time, vs-exact
  error on small chains). Everything verified against the exact engines (MPS↔state-vector amplitudes
  to 1e-9 and entropy to 1e-15, GHZ at χ=2, Born-rule sampling, TEBD↔exact dynamics to 1e-4); rewrote
  the contraction + SVD hot paths onto typed arrays for ~3–4× speed. In-browser suite 37 → 47 cases,
  all green; lint + tsc + build pass.
- 2026-06-15 (claude/claude-opus-4-8): **Quantum Lab 5.0 — DMRG & Matrix Product Operators.** Built
  the workhorse of 1-D many-body physics from scratch on the tensor-network stack. Added a Matrix
  Product Operator engine (`MPO.ts`) — rank-4 operator tensors with the lower-triangular
  finite-state-machine construction, builders for the transverse-field Ising (bond dim 3) and
  Heisenberg/XXZ (bond dim 5, complex Y, anisotropy Δ + optional field) chains, and a dense
  expander for exact cross-checks. Built two-site DMRG (`dmrg.ts`): incremental left/right MPS·MPO·MPS
  environment blocks, a matrix-free effective-Hamiltonian contraction (L·Wₛ·Wₛ₊₁·R·Θ), a from-scratch
  warm-started **Lanczos** eigensolver (full reorthogonalisation, tridiagonal projection diagonalised
  by the app's Hermitian eigensolver), and the fuse→optimise→truncated-SVD→sweep loop with a
  per-half-sweep energy trace and exact discarded-weight accounting. The energy **variance**
  ⟨H²⟩−⟨H⟩² comes from a double-layer MPO contraction — the basis-independent eigenstate certificate.
  New **DMRG lab** card (model/n/χ/parameter controls, energy-descent plot vs the exact line for n≤8,
  ground-state entropy & bond-dimension profiles, variance, χ reached, truncation, solve time). Verified
  against exact diagonalisation of the same MPO to ~1e-13 (TFIM and Heisenberg incl. anisotropy),
  entropy profiles to ~1e-12, variance→0 for gapped chains (the critical-point residual is honest
  truncation error). Added multi-start restarts for robustness in symmetry-broken phases, and a
  **quantum phase-transition scan** card that locates a critical point from the ground-state
  entanglement peak (Ising h=1, gapless XXZ line −1<Δ<1). Typed-array hot paths keep Heisenberg
  n=30 χ=24 ≈ 4 s. In-browser suite 47 → 52 cases, all green; lint + tsc + build pass.
- 2026-06-16 (claude/claude-opus-4-8): **Quantum Lab 6.0 — the Surface Code & an MWPM decoder.**
  Built topological quantum error correction from scratch. Added a faithful from-scratch
  implementation of **Edmonds' blossom algorithm** for general-graph maximum-weight matching
  (`surface/blossom.ts`, Galil's O(V³) primal-dual form), with a `minWeightPerfectMatching` wrapper —
  verified exact against brute force on 120 random graphs (fixing two porting bugs: the internal
  endpoint-encoded `mate[]`, and Python negative-index wrap-around in blossom expand/augment).
  Constructed the rotated planar surface code `[[d²,1,d]]` for any odd d (`surface/SurfaceCode.ts`) —
  d² data qubits, d²−1 weight-≤4 checks, representative logicals — and a real **MWPM decoder**: build
  the decoding graph (checks + a boundary node, qubits as edges), BFS distances with the boundary
  enterable-but-not-traversable, match with blossom, and classify the residual as a stabilizer
  (success) or a logical operator (failure). A **Monte-Carlo threshold sweep** across d=3,5,7
  reproduces the known MWPM code-capacity threshold ≈10.3% (found at ≈10% across seeds). New
  **Surface** tab (`SurfaceLab.tsx`): an interactive lattice with click-to-toggle / random errors,
  live defects, the matching drawn across the lattice and to the boundary, correction rings, a
  corrected/logical-error verdict, and the threshold plot with crossing curves. In-browser suite
  52 → 59 cases (blossom vs brute force, code structure, weight-≤⌊(d−1)/2⌋ correction, threshold
  ordering), all green; lint + tsc + build pass.
- 2026-06-16 (claude/claude-opus-4-8): **Quantum Lab 7.0 — Fault Tolerance in Space-Time.**
  Took the surface code from perfect measurements to the real fault-tolerant setting. Factored
  the decoder out from its graph into a generic `MatchingGraph` (`surface/decoder.ts`) — detector
  nodes + a boundary sink + edges carrying an optional data qubit — so the same decoders run on
  the 2-D code-capacity graph and the new 3-D space-time graph. Built a from-scratch **Union-Find
  decoder** (Delfosse–Nivelle: uniform cluster growth with a boundary defect-sink, then a
  Delfosse–Zémor peeling decoder on a spanning forest of the grown erasure) alongside the 6.0
  MWPM decoder; it corrects every error up to the code distance and tracks MWPM's logical verdict
  to ~95% (fixed a growth-loop bug that bailed before boundary-bound edges could finish growing).
  Added the **phenomenological noise model** (`surface/spacetime.ts`): T noisy syndrome rounds
  (data + measurement errors) + a perfect readout, detectors as syndrome *differences*, stacked
  into a 3-D matching graph whose time edges absorb measurement errors. Monte-Carlo sweeps recover
  the phenomenological threshold (MWPM ≈ 2.5%, UF ≈ 2.3% — well below the 10.3% code-capacity
  figure). Added **finite-size scaling**: the Λ = p_L(d)/p_L(d+2) suppression factor and a
  universal data collapse (`collapseFit`) that grid-fits (p_th, ν) by folding every distance/rate
  curve onto one quadratic — independently recovering p_th. New Surface-lab cards: a space-time
  decoder with a per-round detector-history strip, a threshold card that toggles model
  (code-capacity ↔ phenomenological) and decoder (MWPM ↔ Union-Find), and a finite-size-scaling
  card with the Λ table and a universal-collapse plot. In-browser suite 59 → 67 cases (UF
  correctness, UF↔MWPM agreement, space-time graph structure, phenomenological threshold ordering
  for both decoders, Λ>1, collapse recovers p_th), all green; lint + tsc + build pass.
- 2026-06-18 (claude/claude-opus-4-8): **Quantum Lab 8.0 — Free Fermions (Jordan–Wigner +
  Bogoliubov).** Added a fifth from-scratch engine that solves the transverse-field Ising chain
  *exactly* in O(n³) by exploiting that it is secretly free. The Jordan–Wigner transform sends the
  open TFIM to a quadratic fermion Hamiltonian whose Lieb–Schultz–Mattis diagonalisation is, after
  recognising (A+B) = (A−B)ᵀ, **exactly a singular-value decomposition** of an n×n matrix — so the
  app's own complex SVD gives the Bogoliubov spectrum and ground energy E₀=−½ΣΛ_k (`FreeFermion.ts`).
  Block entanglement comes from the ground state's **Majorana covariance matrix** (Peschel),
  diagonalised by the existing Hermitian eigensolver. Built the closed-form **Pfeuty** thermodynamic
  energy and finite-T energy, and an exact real-time **quench** (`ffQuench.ts`) that evolves the
  Gaussian fermionic correlation matrices in O(n³)/step (ground state of H(h_i) under H(h_f)) →
  the entanglement light-cone, with an independent dense 2ⁿ oracle for the cross-check. New
  **Free-Fermion lab** (`FreeFermionLab.tsx`): Bogoliubov spectrum & exact-vs-Pfeuty energy to 256
  sites, the quantum-phase-transition sweep (gap closes / entanglement peaks at h=J), a live
  **central-charge fit recovering c=½** from the Calabrese–Cardy scaling, and the quench light-cone
  (✓-exact for n≤8). Verified against the lab's own engines: ground energy vs exact diagonalisation
  to ~1e-13, block entropy vs exact RDM to ~3e-11, the quench vs exact dense evolution to ~1e-6;
  the fit gives c≈0.52→½ and the energy density matches Pfeuty to ~1e-3. Caught two real bugs along
  the way (mode-energy/mode-vector alignment in the quench phases; and G being only *real*-symmetric
  — its imaginary part is antisymmetric, Gᵀ=conj(G) — in the correlation-matrix products). In-browser
  suite 67 → 75 cases, all green; lint + tsc + build pass.
- 2026-06-19 (claude/claude-opus-4-8): **Quantum Lab 9.0 — Dynamical Quantum Phase Transitions, the
  XY model & periodic free fermions.** Turned the equilibrium, isotropic, open free-fermion engine
  into the full non-equilibrium toolkit. Generalised the open-chain BdG solver to the **anisotropic
  XY model** `solveXY(n,J,h,γ)` (the Ising chain is its γ=1 point; the only change is two
  off-diagonals of R=A−B, and Rᵀ=A+B still holds so the SVD trick and every correlator/entropy carry
  over untouched) — verified against exact diagonalisation of the dense XY Hamiltonian incl. the XX
  point γ=0. Added a from-scratch **periodic momentum-space engine** (`xyChain.ts`): the chain
  factorises into independent 2×2 Anderson-pseudospin modes d⃗(k)=(Jγ sin k, h−J cos k), dispersion
  εₖ=2|d⃗|, ground-energy density (Pfeuty at γ=1), and the XY phase diagram. On it, the headline
  result of the decade: the **dynamical quantum phase transition**. The Loschmidt return amplitude
  factorises over modes, so the rate function l(t)=−lim(1/N)ln|⟨ψ₀|e^{−iH_f t}|ψ₀⟩|² develops
  **non-analytic cusps** at the critical times tₙ*=(2n+1)π/εₖ* whenever the quench crosses the
  critical point (a critical mode d⃗_i·d⃗_f=0 exists) — the exact finite-N rate (anti-periodic
  momentum product) matched an **independent dense 2ⁿ time evolution to ~1e-14**. Built the integer
  **dynamical topological order parameter** ν_D(t) (Budich–Heyl): the winding of the Pancharatnam
  geometric phase φₖ^G=arg⟨u(0)|u(t)⟩+Eₖt across the Brillouin zone — 0 before the first cusp, jumping
  0→1→2→3 at each, identically 0 for non-crossing quenches. Added exact **mutual information between
  disjoint blocks** from the Majorana covariance matrix (I(A:Ā)=2S(L) to 1e-13; ~0 between separated
  blocks in the paramagnet, 0.012 at criticality). New **Dynamics** tab (`DynamicsLab.tsx`): the DQPT
  rate-function card (cusps + exact-dense overlay) and the DTOP card (integer step function + the
  φₖ^G Brillouin-zone winding); the Free-Fermion lab gains an XY-anisotropy card (dispersion + phase
  diagram) and a disjoint-block mutual-information decay card. Caught two real bugs via the dense
  oracle along the way: the Loschmidt frequency is the full dispersion εₖ=2|d⃗| (a missing factor of
  2), and the geometric-phase sign φ^G=arg⟨u|U|u⟩**+**Eₖt (wrong sign leaked a spurious t-linear
  winding into ν_D). In-browser suite 72 → 80 cases, all green; lint + tsc + build pass.

## Quantum Lab 10.0 — Shor's Algorithm: integer factoring by quantum order-finding (this session)

The lab has had the *pieces* of Shor's algorithm for a long time — a Quantum Fourier Transform, an
inverse-QFT phase-estimation routine, Simon's period-finding — but never the headline result itself:
**factoring an integer with a quantum computer.** 10.0 closes that, building the whole pipeline from
scratch and, in the project's tradition, in *two* independent quantum paradigms cross-checked against
an exact analytic reference and against each other.

Shor's insight is that factoring reduces to **order-finding**: to factor N, pick a coprime `a` and
find the multiplicative order `r` (the period of `x ↦ a·x mod N`); if `r` is even and `a^(r/2) ≢ −1`,
then `gcd(a^(r/2) ± 1, N)` are non-trivial factors. The order is found quantumly by phase-estimating
the eigenphase `s/r` of the modular-multiplication unitary `U_a|x⟩ = |a·x mod N⟩`, then recovering
`r` from the measured `s/r` with a **continued-fraction** expansion. Everything below is one new
self-contained module (`src/quantum/shor.ts`) + one lab tab (`ShorLab.tsx`) + new self-tests; no
existing engine is touched.

### Plan (this session)
- [x] **Classical number theory** (`shor.ts`) — `gcd`/`egcd`, fast `modpow`, `multiplicativeOrder`,
      primality (Miller–Rabin, deterministic for the small N we factor), perfect-power detection, and
      the **continued-fraction convergents** that turn a measured `s/r` back into `r`.
- [x] **A flat-amplitude quantum micro-engine** (Float64Array re/im) inside `shor.ts` — Hadamard,
      (controlled) phase, SWAP, an inverse-QFT that mirrors the app's existing `inverseQFTOps`
      convention, and the key primitive: **controlled modular multiplication** `|x⟩ ↦ |a·x mod N⟩`
      built as an exact in-place permutation (unitary because ×a is a bijection on Z_N).
- [x] **Full-register order-finding** (`orderFindFull`) — the textbook circuit: a `t = 2⌈log₂N⌉`-qubit
      counting register in uniform superposition, `t` controlled-`U_a^{2^k}` modular multipliers onto an
      `n`-qubit work register prepared in |1⟩, an inverse QFT, then read the counting register. Returns
      the **exact output distribution** (marginalised over the work register) — the genuine quantum
      probability comb, computed without ever knowing `r`.
- [x] **Iterative / semiclassical order-finding** (`orderFindIterative`) — the hardware-friendly
      one-ancilla variant (Kitaev): a *single* recycled control qubit measured bit-by-bit with
      classical phase feedback, so it runs in `n+1` qubits and reaches far larger N than the full
      register. Cross-checked to sample the same distribution.
- [x] **Analytic ideal comb** (`idealOrderDistribution`) — the closed-form Dirichlet-kernel
      distribution `P(y) = (1/r) Σ_s |Σ_k e^{2πik(s/r − y/2^t)}/2^t|²`, the exact reference the two
      quantum simulators are graded against to machine precision.
- [x] **The classical Shor wrapper** (`shorFactor`) — even/perfect-power/prime preprocessing, random
      `a`, the `gcd` shortcut, quantum order-finding, the even-order & non-trivial-root checks, and the
      `gcd(a^(r/2)±1, N)` factor extraction, with a full step log — actually factoring 15, 21, 33, 35…
- [x] **Shor lab tab** (`ShorLab.tsx`) — a *Factor* card (pick N + seed, watch the attempts and the
      factor tree resolve), an *Order-finding spectrum* card (the genuine full-register output
      histogram with the `s/r` rational ticks and the recovered period), and a *Continued-fraction
      convergents* card (the table that reconstructs `r` from the measurement).
- [x] **Tests** — extend the in-browser suite: modpow/order vs brute force, continued fractions
      reconstruct known rationals, the full-register distribution matches the analytic comb to ~1e-12,
      the iterative sampler recovers the correct order with high probability, and end-to-end factoring
      of several composites returns correct factors. Plus an About-page card.

### Verified
- The genuine **full-register state-vector** output distribution equals the closed-form analytic
  comb to **~1e-14** for every tested (a, N) — `{7,2,4}/15`, `{2,5}/21` — and is normalised to 1e-9.
  This validates the entire quantum circuit (controlled modular multiplication + inverse QFT) against
  an independent reference *without ever using r*.
- The **iterative one-ancilla** sampler recovers the correct order on 40–51 of 60 runs (a=7/N=15,
  a=2/N=21, a=2/N=33) — the expected ≳½ success rate that a couple of attempts amplifies to certainty.
- **End-to-end**: Shor's algorithm factors 15=3×5, 21=3×7, 33=3×11, 35=5×7, 39=3×13, 55=5×11,
  rejects the prime 13, and short-circuits 14→2 classically. Multiplicative order matches brute force
  for every coprime base of 15/21/33/35; continued fractions reconstruct 3/8 and the y/2⁸ phases.
- A subtlety worth recording: the iterative scheme reuses a *single* control qubit, so after each
  bit is measured the control must be projected, renormalised, **and reset to |0⟩** (an X when the
  outcome was 1) before the next round — and the phase-feedback rotation diag(1, e^{−iπφ_acc}) must
  cancel exactly the tail phase 2π(φ_acc/2) of the already-measured less-significant bits.
- In-browser self-test suite **80 → 88 cases**, all green; lint + tsc + build pass (the exact CI gate).

## Quantum Lab 11.0 — Measurement-Based Quantum Computation: the One-Way Quantum Computer (this session)

Every engine so far is a variation on the *circuit* model — unitary gates applied to a state. 11.0
adds a genuinely different **model of computation**: the **one-way quantum computer** (Raussendorf–
Briegel). There are no gates. You prepare one large, fixed, maximally-entangled **cluster state** and
then compute purely by **measuring its qubits one at a time** in adaptively chosen single-qubit bases.
Measurement is irreversible and random — yet feeding each outcome forward into later measurement
angles, and undoing a final Pauli **byproduct operator**, makes the computation deterministic. The
striking fact this paradigm rests on is that *measurement alone is universal*.

This is a new self-contained module (`src/quantum/mbqc.ts`) + a lab tab (`MBQCLab.tsx`) + new
self-tests, touching no existing engine — the same pattern that landed Shor 10.0. The whole thing is
cross-checked against an **independent dense circuit-model oracle** that shares no code with the
cluster engine, the project's house style.

The physics, derived from scratch and pinned down before a line of UI: the elementary gadget
(prepare output |+⟩, entangle `E`, measure the input at plane-angle α) realises **J(−α)** with a known
`X^s` byproduct, where `J(α)=H·P(α)`. Since `P(α)=J(0)J(α)` exactly and any single-qubit unitary
`U=e^{iδ}J(0)J(γ)J(β)J(α)` (its ZXZ Euler decomposition), `{J(α),CZ}` is universal. Composing gadgets,
each wire carries a symbolic byproduct `X^{xs}Z^{zs}` (signal sets of earlier outcomes): a fresh J on a
wire folds the standing X-signal into the measurement's sign-dependency and the Z-signal into its
π-shift (the rule φ=(−1)^{sX}α+sZπ), then the output inherits `X^{new outcome}` and `Z^{old X-signal}`;
a logical CZ updates `zs_A ^= xs_B`, `zs_B ^= xs_A`. Undoing the final byproduct gives the deterministic
logical state — *the same one for every measurement record*.

### Plan / steps (this session)
- [x] **Dynamic complex state-vector micro-engine** (`CState`, Float64Array re/im) — prepare |+⟩ qubits,
      entangle with CZ, Pauli X/Z, and projective X–Y-plane measurement that **frees the measured qubit**
      (halving the dimension), so the live register never exceeds (#logical wires + 1) at any depth —
      the MBQC memory advantage made concrete.
- [x] **Measurement calculus** (Danos–Kashefi–Panangaden) — patterns over N / E / M commands with X- and
      Z-signal dependency sets, run with adaptive angles φ=(−1)^{sX}·α+sZ·π and final byproduct corrections.
- [x] **Universal {J(α), CZ} compiler** (`PatternBuilder`) — `applyJ`/`applyCZ` propagate the byproduct
      operators symbolically; a named-gate dictionary (H=J(0); P/S/T/Z=J(0)J(θ); Rz; Rx=J(0)J(θ); arbitrary
      U via Euler; CNOT=H·CZ·H) emits a measurement pattern + a parallel logical-gate list for grading.
- [x] **Independent dense oracle** (`oracleApply`) — replays the logical-gate list as 2×2 (J) / diagonal CZ
      matrices on a 2^{nWires} vector, sharing no code with the cluster runner; `fidelity` compares up to a
      physically-irrelevant global phase.
- [x] **Graph / cluster states** — `clusterState(G)`, the generators `K_v=X_v∏_{w∼v}Z_w`, and a Pauli-string
      expectation routine proving ⟨K_v⟩=+1 (line / ring / star / box / box+diagonals).
- [x] **MBQC lab tab** (`MBQCLab.tsx`) — a *Compile a gate to a cluster* card (pick H/S/T/Rz/Rx/U/CNOT/Bell,
      see the cluster graph with measured outcomes + adapted angles, the byproduct correction this run, the
      corrected output on |0…0⟩, and a live ✓ fidelity vs the oracle), a *Determinism from randomness* card
      (the same computation under 10 different outcome strings, all fidelity-1 after correction), and a
      *Graph states & their stabilizers* card (colour-coded Pauli generators with ⟨K_v⟩).
- [x] **Tests (89 → 95)** — every pattern = oracle over 8 patterns × 24 random inputs/outcomes (fidelity 1);
      outcome-independence over 38 outcome strings; 24 random multi-gate 2-wire circuits = oracle (clusters of
      ~dozens of qubits, live register ≤ 3); T⁸=I; cluster ⟨K_v⟩=+1; the Bell pattern's output distribution.
- [x] **Wire the tab + About entry + this journal.**

### Verified
- Every measurement pattern (H, S, T, Rz, Rx, arbitrary Euler U, CNOT, and the H;CNOT Bell circuit)
  reproduces the independent dense circuit oracle to **fidelity 1.0 (15 nines)** over hundreds of random
  inputs and random measurement outcomes.
- **Determinism from randomness**: the corrected logical output is identical across dozens of distinct
  measurement records (min fidelity 1.0) — the property that makes the one-way computer work.
- Random 6–11-gate two-wire circuits compile to clusters of up to ~23 physical qubits yet are simulated
  with a **live register of ≤ 3 qubits**, matching the oracle exactly — the MBQC memory advantage.
- Cluster states are graph states: ⟨K_v⟩ = +1 for every generator on the line, ring, star and box graphs.
- lint + tsc + build + **95/95 self-tests** green (the exact CI gate).

### Session log
- 2026-06-20 (claude / claude-opus-4-8): **Quantum Lab 11.0 — Measurement-Based Quantum Computation.**
  Added a wholly different model of computation: the one-way quantum computer, where computation is driven
  by adaptive single-qubit *measurements* on a fixed entangled cluster state rather than by gates. One
  self-contained module (`src/quantum/mbqc.ts`) — a dynamic state-vector engine that frees each qubit on
  measurement (live register ≤ #wires at any depth), the measurement calculus (N/E/M with feed-forward
  angles φ=(−1)^{sX}α+sZπ), a universal {J(α),CZ} compiler that propagates the Pauli byproduct operators
  symbolically, an independent dense circuit oracle, and graph/cluster states with their K_v generators —
  plus a `MBQCLab` tab and six new self-tests, touching no existing engine. Derived the gadget from
  scratch (`J(α)=H·P(α)`, the elementary measurement realises J(−α) up to an X byproduct; any U via its
  ZXZ Euler decomposition makes {J(α),CZ} universal) and verified it: every pattern reproduces the circuit
  model to fidelity 1.0 over hundreds of random inputs/outcomes, the corrected output is determinism-
  identical across dozens of measurement records, random multi-gate circuits spread over ~23 physical
  qubits but simulate with ≤3 live, and cluster ⟨K_v⟩=+1. Suite 89 → 95, all green; lint + tsc + build pass.
- 2026-06-20 (claude/claude-opus-4-8[1m]): **Quantum Lab 10.0 — Shor's Algorithm.** Added the one
  iconic quantum algorithm the lab was missing: integer factoring by quantum order-finding, in one
  self-contained module (`src/quantum/shor.ts`) + one tab (`ShorLab.tsx`) + 8 new self-tests, touching
  no existing engine. Built a flat-amplitude (Float64Array re/im) quantum micro-engine with Hadamard,
  (controlled) phase, SWAP, an inverse QFT mirroring the app's `inverseQFTOps` convention, and the key
  primitive — **controlled modular multiplication** `|x⟩↦|c·x mod N⟩` as an exact in-place permutation.
  On it: full-register order-finding (the textbook t=2⌈log₂N⌉ counting register + controlled-U_a^{2^k}
  multipliers + iQFT, returning the exact output distribution), the **iterative/semiclassical** one-
  ancilla variant (Kitaev, classical feedback) that scales past the full register, a closed-form
  analytic comb reference, the classical number theory (gcd, modpow, Miller–Rabin, perfect-power,
  continued-fraction convergents, `recoverOrder`), and the **`shorFactor` wrapper** that actually
  factors composites with a full step log. The Shor tab factors 15/21/33/35/39/55 live with a factor
  tree + step trace, an order-finding spectrum (genuine state-vector histogram with the k/r rational
  ticks marked), and a continued-fraction convergent table. The full-register simulator matches the
  analytic comb to ~1e-14 (no knowledge of r), and every composite factors correctly. Suite 80 → 88,
  green; lint + tsc + build pass.

## Quantum Lab 12.0 — Fault-tolerant universality: Solovay–Kitaev compilation + magic-state distillation (this session)

The lab has spent versions 2.0–11.0 building the entire fault-tolerant *Clifford* substrate — the
stabilizer tableau, the Steane and surface codes, the MWPM and Union-Find decoders, space-time
fault tolerance. But a Clifford-only machine is, by Gottesman–Knill, **classically simulable**: it
cannot do anything quantumly useful. 12.0 closes the loop with the two ideas that turn that substrate
into a **universal** quantum computer, and they are duals of one another:

1. **Solovay–Kitaev** — *given* the discrete fault-tolerant gate set {H, T} + Clifford, compile any
   unitary into it. This tells you the **T-count** of a computation.
2. **Magic-state distillation** — *supply* the non-Clifford T gates that compilation consumes, by
   purifying noisy |T⟩ magic states with Clifford-only post-selection.

Both are built from scratch, in the project's house style (a self-contained module + a lab tab +
self-tests cross-checked against an independent reference), and both were validated in a throwaway
oracle before a line of TS was written.

### Solovay–Kitaev (`src/quantum/solovay.ts`)
- [x] **Compact SU(2) core** — every operator is a pair (a, b) standing for [[a, b], [−b̄, ā]];
      products stay in this form, with closed-form axis–angle extraction and an operator-norm
      (largest-singular-value) distance. No matrix library, no eigensolver.
- [x] **The discrete instruction set** {H, T, T†, S, S†, X, Y, Z} as exact SU(2) lifts (H lifted as
      −iH), plus the genuine U(2) matrices for an honest reconstruction check.
- [x] **The Dawson–Nielsen group-commutator decomposition** `gcDecompose(Δ)` — for Δ a rotation by θ
      about n̂, take V₀=Rx(φ), W₀=Ry(φ) with φ=2·asin(√(√((1−cos(θ/2))/2))) so the commutator has angle
      θ, then conjugate both by the rotation S carrying the commutator's axis onto n̂. Uses only
      rotations and cross products — verified to reconstruct Δ = V W V† W† to ~1e-13.
- [x] **The ε₀-net** — a breadth-first enumeration of every reduced word up to length 16,
      deduplicated by SU(2) value (folding the global ± sign): ~9,900 words covering SU(2) with
      radius ε₀ ≈ 0.20, built (and cached) in well under a second.
- [x] **The recursion** `solovayKitaev(U, n)` — base approximation from the net, then approximate U at
      depth n−1, write the leftover error as a balanced group commutator, recurse on V and W, and
      reassemble V_{n−1} W_{n−1} V_{n−1}† W_{n−1}† U_{n−1}. Error contracts as ε_n ≈ c·ε_{n−1}^{3/2}.
- [x] **The compile API** — `compileGate(target, depth)` returns the (simplified) word, the
      approximation error, the gate count, and the **T-count** (the costly non-Clifford resource).
      Named targets (Rz(π/5), V=√X, golden-ratio rotations, seeded Haar-ish gates) plus an adjustable
      Rz(θ).
- [x] **Solovay–Kitaev lab** (`SolovayLab.tsx`) — a *Compile* card (target + depth + a live word
      preview with T/T† highlighted as the costly resource), a *Convergence* card that sweeps depth
      0→5 and plots the error (log scale) and gate count against the SK law, and an *Instruction set &
      base net* card (the eight generators, the net size and covering radius, the universality note).

### Magic-state distillation (`src/quantum/distillation.ts`)
- [x] **The [15,11,3] Hamming code from scratch** — parity-check columns = the binary numerals 1…15;
      all 2¹¹ codewords enumerated, with the textbook weight enumerator (A₀=1, A₃=35, A₄=105, …, A₁₅=1).
- [x] **The 15-to-1 routine, exactly** — the Bravyi–Kitaev protocol on the [[15,1,3]] Reed–Muller code
      reduces to: an input |T⟩ phase (Z) error at rate p; accept iff the pattern is a Hamming codeword
      (trivial X-syndrome); fail iff that codeword has **odd weight** (a Z-logical). `distill(p)` sums
      over every codeword to get the exact p_out, the acceptance probability, and the improvement verdict.
- [x] **The 35 p³ law** — because the code has distance 3 with exactly **35 weight-3 logicals**,
      p_out/p³ → 35 as p → 0 (verified to 35.2 at p=0.002). The **threshold** where p_out = p is
      computed exactly (p* ≈ 14.2%), below the leading-order 1/√35 ≈ 16.9% (the positive higher-order
      terms lower it).
- [x] **The cascade** `distillCascade(pIn, rounds)` — feed the output back in: round r reaches error
      ~35^((3^r−1)/2)·p^(3^r) (the exponent triples each round) at a cost of 15^r raw states per output
      — doubly-exponential suppression (5% → 5e-3 → 5e-6 → 4e-15 in three rounds).
- [x] **Monte-Carlo cross-check** — a from-scratch mulberry32 RNG drives the post-selected protocol
      directly; its p_out matches the exact code enumeration (4.76e-2 vs 4.77e-2 at p=0.1).
- [x] **Distillation lab** (`DistillationLab.tsx`) — a *15-to-1 routine* card (the [[15,1,3]] code
      facts, an input-p slider, p_out / 35p³ / acceptance / threshold verdict), a *Cascade* card (the
      per-round error collapse and raw-state cost), and a *Suppression curve* card (the log-log p_out
      vs p_in curve crossing the break-even line at the threshold, the weight enumerator with its 35
      weight-3 logicals highlighted, and the MC-vs-exact cross-check).

### Verified
- gc-decompose reconstructs Δ = V W V† W† to ~4e-13 over 200 random near-identity rotations; the
  gate SU(2) lifts match the genuine U(2) gates to ~1e-16; the base net (9,877 words) covers SU(2)
  with radius 0.198.
- SK error falls monotonically with depth and reaches **< 1e-3 at depth 3** (worst of four targets
  9e-4); every compiled {H,T} word, multiplied back out in genuine U(2), reproduces its target up to
  a global phase to the same error; an exact gate (T) is found by the net at depth 0 (error 0).
- The full depth sweep shows the textbook scaling — error ~ε₀^{(3/2)^n} (≈0.07 → 0.034 → 0.008 →
  0.001 → 5e-5 → 6e-7) and length ~5^n (16 → 80 → 388 → 1.9k → 9k → 42k) — at ≤ 400 ms per depth-5 compile.
- Distillation: the Hamming code has 2048 codewords with the correct weight enumerator; p_out/p³ → 35;
  distillation helps at 2% and hurts at 25% with p* ≈ 0.1415; the cascade drives 5% to 4e-15 in three
  rounds; the Monte-Carlo agrees with the exact enumeration.
- In-browser self-test suite **95 → 106 cases** (6 Solovay–Kitaev + 5 distillation), all green; lint +
  tsc + build pass (the exact CI gate).

### Future ideas
- [x] Solovay–Kitaev gate compilation to {H, T} — shipped in 12.0
- [x] Magic-state distillation (15-to-1, the 35 p³ law) — shipped in 12.0
- [x] Two-qubit gate synthesis (KAK decomposition → CNOTs + single-qubit SK) — shipped in 13.0
- [x] Wire SK into a two-qubit gate so it re-expresses as a fault-tolerant {H,T,CNOT} circuit with a
      total T-count — shipped in 13.0 (the fault-tolerant compile card)
- [ ] Block-code / multi-level distillation (the 116-to-12, or Bravyi–Haah triorthogonal codes) and
      the resource-vs-fidelity trade-off curve
- [ ] 5-qubit perfect [[5,1,3]] code (still open from 2.0)
- [ ] Optimal 1- and 2-CNOT circuit *templates* (the synthesis already proves the optimal CNOT count;
      the realised circuit currently uses the universal 3-CNOT Cartan circuit for all non-local gates)
- [x] Multi-qubit synthesis: cosine–sine decomposition (CSD) / quantum Shannon decomposition to lower
      an arbitrary n-qubit unitary to a CNOT count — **shipped in 14.0**
- [ ] **Optimised QSD CNOT counts** — the (9/16)·4ⁿ Shende–Bullock–Markov optimisation (absorb one CNOT
      of each demultiplexed R_z into the adjacent diagonal), and the (23/48)·4ⁿ variant; report the
      improved count alongside the current (¾)·4ⁿ
- [ ] **Recurse the QSD base case into the optimal 2-qubit KAK circuit** (≤3 CNOTs) instead of going all
      the way to 1-qubit ZYZ leaves — reuses 13.0 and cuts the constant factor
- [ ] **Quantum multiplexor diagonalisation across the recursion** — fuse the central R_z multiplexor of a
      child with the parent's, the standard QSD CNOT saving
- [ ] **CSD-based state preparation** — the same machinery prepares an arbitrary n-qubit state |ψ⟩ from
      |0…0⟩ with a column-only cosine–sine recursion (cheaper than full unitary synthesis)
- [ ] **Animated recursion-tree explorer** — click into a node to watch its CSD split and the multiplexors
      demultiplex, all the way to the ZYZ leaves

## Quantum Lab 14.0 — n-Qubit gate synthesis: the Quantum Shannon Decomposition (this session)

The compilation story had a 1-qubit engine (Solovay–Kitaev, 12.0) and a 2-qubit engine (the KAK
decomposition, 13.0). 14.0 finishes it: the **Quantum Shannon Decomposition** (Shende–Bullock–Markov)
synthesises *any* n-qubit unitary into a {Rz, Ry, CNOT} circuit, built from scratch on top of the lab's
existing complex linear algebra. As always, the whole algorithm was validated numerically in a throwaway
Node oracle (`scratchpad/qsd*.mjs`) before a line of TS was written — that oracle caught the three real
bugs (below) at machine speed.

### New ideas this needed (`shannon.ts`)
- [x] **Eigendecomposition of a UNITARY (normal) matrix** — `eigUnitary`. W normal ⇒ its Hermitian parts
      (W+W†)/2 and (W−W†)/2i commute and share an eigenbasis; diagonalise the first (reusing the lab's
      Hermitian Jacobi solver) and resolve each degenerate cluster with the second. Robust through the
      repeated eigenvalues of structured gates.
- [x] **The cosine–sine decomposition** — `cosineSineDecomposition`. Partition a 2ⁿ×2ⁿ unitary by its top
      qubit; U = diag(L0,L1)·[[C,−S],[S,C]]·diag(R0†,R1†), recovered from a block SVD (Hermitian eig of
      the Gram matrix) + an orthonormal completion. cos²+sin²=1, every block unitary. The right factor R1
      is read off the bottom-right block of CS†·diag(L0†,L1†)·U — **division-free**, so it survives the
      degenerate cos=0/sin=0 rows of permutations & reflections.
- [x] **Demultiplexing a quantum multiplexor** — `demultiplex`. diag(A,B) = (I⊗V)·(uniformly-controlled
      R_z)·(I⊗W) with V,e^{iφ}=eig(A·B†), W=D†V†A. Reproduces both blocks exactly (no dropped phase).
- [x] **Uniformly-controlled rotation → CNOTs** at the **optimal 2^m** count via the Gray-code /
      Walsh–Hadamard angle transform (Möttönen et al.) — θ_i = 2⁻ᵐ Σ_j (−1)^{popcount(gray(i)&j)} α_j.
- [x] **The recursion** — `shannonDecompose`: CSD → demux the two multiplexors → recurse on the four
      (n−1)-qubit gates, bottoming out in the 1-qubit ZYZ. Exactly **(¾)·4ⁿ − 3·2ⁿ⁻¹** CNOTs (6/36/168/720
      for n=2…5), reproducing the gate to ~1e-11 at 5 qubits.
- [x] **Peephole optimiser** — `optimizeCircuit`: adjacent-CNOT cancellation + same-axis rotation fusion +
      zero-rotation drop. Collapses structured gates far below the generic bound (Toffoli 36→16, C²Z 36→14,
      C³X 168→80, QFT-3 36→28) while a Haar-random SU(2ⁿ) stays exactly on it.
- [x] **Fault-tolerant {H,T,CNOT} compile** — `faultTolerantShannon`: every rotation → a Solovay–Kitaev
      word, so an arbitrary n-qubit unitary gets a real T-count, closing the loop with the 1- and 2-qubit
      synthesis.

### The three bugs the oracle / self-tests caught
- The CSD's right factor is **R†, not R** (the recursion was structurally wrong until this was fixed).
- `distModPhase` minimised over the **wrong global-phase sign** (cost the base case its reconstruction).
- The orthonormal **completion seeded from e_c**, which for a permutation's degenerate Gram is *already an
  occupied column* — it collapsed to a duplicate and broke unitarity. Fixed by searching e₀…e_{m−1} for a
  genuinely independent residual. (Increment & Grover diffusion went from err ~3 → ~1e-15/3e-8.)

### UI + verification
- [x] New tab **🪜 n-Qubit Synthesis** (`ShannonLab.tsx`): pick a gate (QFT/Toffoli/Fredkin/C²Z/C³X/Grover
      diffusion/modular increment/Haar-random SU(2ⁿ), 2–5 qubits), see the {Rz,Ry,CNOT} circuit, the
      per-level recursion breakdown summing to the closed form, the ¾·4ⁿ cost curve with the gate marked,
      a peephole-optimise toggle, and the live fault-tolerant compile with a total T-count.
- [x] `shannonGates.ts` — the named n-qubit gate registry (QFT, Toffoli, Fredkin, C²Z, C³X, Grover
      diffusion, modular adders, seeded Haar-random unitaries).
- [x] About-page entry; `project.json` description + tags; test-suite count 113 → **124**.
- [x] **11 new self-tests** (unitary eigensolver, CSD reconstruction + Pythagorean identity + unitary
      blocks, exact demultiplexor, uniformly-controlled rotation at 2^m CNOTs, full QSD on random SU(2ⁿ)
      and structured gates, the closed-form CNOT count, the 1-qubit base case, the optimiser, the
      end-to-end fault-tolerant compile, and a regression test over every registry gate incl. the
      degenerate permutations/reflections). Suite **124/124**; lint + tsc + build all green (the exact CI gate).

### Session log
- 2026-06-23 (claude/claude-opus-4-8[1m]): **Quantum Lab 14.0 — n-qubit synthesis (Quantum Shannon
  Decomposition).** Generalised the lab's 1-qubit (Solovay–Kitaev) and 2-qubit (KAK) synthesis to *any*
  number of qubits, from scratch: the cosine–sine decomposition (built on two block SVDs + an orthonormal
  completion), the eigendecomposition of a unitary matrix (commuting-Hermitian simultaneous
  diagonalisation), demultiplexing via eig(A·B†), and the optimal Gray-code uniformly-controlled rotation,
  recursing to the ZYZ base case at exactly (¾)·4ⁿ−3·2ⁿ⁻¹ CNOTs. Two modules (`shannon.ts`,
  `shannonGates.ts`) + one tab (`ShannonLab.tsx`) + 11 self-tests, touching no existing engine. Validated
  in a throwaway Node oracle first (which caught the R-vs-R† and phase-sign bugs); the self-tests caught
  the degenerate-completion bug on permutations/reflections. Closes the loop with SK for a fault-tolerant
  {H,T,CNOT} compile and a T-count. Suite 113 → 124, all green; lint + tsc + build pass.

## Quantum Lab 13.0 — Two-qubit gate synthesis: the KAK (Cartan) decomposition (this session)

Solovay–Kitaev (12.0) compiles any *single*-qubit gate to the discrete set. The missing dual is the
*two*-qubit story: a real machine has only single-qubit rotations and **one** entangler (the CNOT), so
to run an arbitrary two-qubit gate a compiler must lower it onto that basis. The structure theorem that
makes this possible — and that fixes the **minimum CNOT count** of any gate — is the **KAK (Cartan)
decomposition** of SU(4). 13.0 builds it from scratch and feeds the single-qubit pieces back through
12.0's Solovay–Kitaev to produce a fully discrete {H, T, CNOT} circuit. Validated end-to-end in a
throwaway Node oracle (8 iterations, ~5000 random gates) before any TS was written, in the house style.

### Plan / steps (this session)
- [x] **`src/quantum/kak.ts` — the decomposition core.** Complex-matrix helpers (det via Gaussian
      elimination, plain transpose, Frobenius norm), a flat real-symmetric **Jacobi** eigensolver, and
      a **simultaneous diagonaliser** `simDiag(Sr,Si)` of two commuting real symmetric matrices (diagonalise
      Sr, then refine inside each degenerate eigen-cluster on Si) — the piece that makes the method robust
      for the degenerate-spectrum gates (CNOT, iSWAP).
- [x] **The magic (Bell) basis** `MAGIC` and its property: M†(k₀⊗k₁)M ∈ SO(4), M† exp(i·canonical) M is
      diagonal. `canonicalGate(cx,cy,cz)=exp(i(cx XX+cy YY+cz ZZ))` via the real-symmetric eig of the
      (real) Hamiltonian.
- [x] **`kakDecompose(U)`** — reduce to SU(4); transform to the magic basis Ũ=O₁FO₂; recover **O₁ ∈ SO(4)**
      as the real eigenvectors of ŨŨᵀ (via `simDiag` on its real/imag parts), then **O₂** by stripping the
      shared phase from each row of O₁ᵀŨ; force *both* O₁,O₂ into SO(4) (paired row/μ sign flips — the bug
      that, unfixed, silently makes a layer non-local); read the canonical gate A=M·diag(e^{iμ})·M† and
      **tensor-factor** L=MO₁M† and R=MO₂M† into single-qubit gates. Reconstruction **~1e-12**, locality **~1e-15**.
- [x] **`canonCoordsOf` / `canonicalizeCoords`** — read (cx,cy,cz) off A via the *calibrated* magic-order
      sign table, then fold into the Weyl chamber. The sign of cz is a **chirality invariant** for x<π/4
      (a gate and its mirror have conjugate Makhlin G₁) — fixed by matching the source gate's invariants.
- [x] **`makhlinInvariants` / `cnotCount`** — the complete local invariants G₁,G₂, and the geometric CNOT
      cost (0 local · 1 the CNOT corner · 2 the cz=0 face · 3 the interior).
- [x] **`src/quantum/kakCircuit.ts` — synthesis + fault tolerance.** The optimal **3-CNOT Cartan circuit**
      (Vatan–Williams; angles read off (cx,cy,cz), verified to 1e-15) sandwiched by the local layers →
      `synthesize(U)` returns the {Rz,Ry,CNOT} circuit. `faultTolerant(U,depth)` compiles every single-qubit
      gate via Solovay–Kitaev (`matToSU2` strips the global phase; the **SU(2) the word realises** is used,
      not `sequenceToU2`, which uses the opposite product order) → total CNOT + **T-count** + end-to-end error.
      Named targets: CNOT, CZ, iSWAP, √iSWAP, √SWAP, the Berkeley B gate, SWAP, and a seeded random SU(4).
- [x] **`SynthLab.tsx` — the 🔧 2-Qubit Synthesis tab.** Gate picker (+ a custom-interaction slider trio),
      the canonical coordinates / Makhlin invariants / optimal CNOT count, a hand-drawn **circuit diagram**,
      a projected **Weyl-chamber tetrahedron** with the gate's point animated into place, and a live
      fault-tolerant compile card (depth slider, total T-count, per-gate {H,T} words). Wired into `App.tsx`
      with an About entry.
- [x] **7 new self-tests** — reconstruction over named + 64 random gates; both layers local; the textbook
      canonical classes; the correct optimal CNOT counts; the famous Makhlin values; the recovered
      coordinates rebuilding the same invariants (chirality and all); and the end-to-end fault-tolerant
      circuit reproducing a random gate while SWAP stays Clifford (0 T).

### Verified
- KAK synthesis reconstructs every named gate and 64 random SU(4) gates from {Rz,Ry,CNOT} to **≤5e-14**,
  with both local layers genuine tensor products to **~1e-15**.
- Canonical coordinates land exactly on the textbook classes — CNOT (π/4,0,0), iSWAP (π/4,π/4,0),
  SWAP (π/4,π/4,π/4) — and the optimal CNOT counts are correct (CNOT/CZ→1, iSWAP/√iSWAP/B→2, √SWAP/SWAP/
  generic→3).
- Makhlin invariants take their famous values: CNOT (0,1), iSWAP (0,−1), SWAP (−1,−3); and the recovered
  Weyl coordinates rebuild a gate with the **same** invariants over 64 random gates (worst |ΔG|≈3e-14),
  the gauge-invariant end-to-end certificate.
- The fault-tolerant {H,T,CNOT} compile reproduces a generic gate at SK depth 3 (err ~5e-3, ~5k T gates,
  3 CNOTs) while the Clifford SWAP compiles to **0 T** exactly.
- In-browser self-test suite **106 → 113**, all green; lint + tsc + build pass (the exact CI gate).

### Session log
- 2026-06-22 (claude/claude-opus-4-8[1m]): **Quantum Lab 13.0 — Two-qubit gate synthesis (KAK).** Built
  the two-qubit dual of Solovay–Kitaev: the **KAK / Cartan decomposition** of SU(4) from scratch, lowering
  any two-qubit gate onto single-qubit rotations + CNOTs, and onward (via 12.0's SK) to a discrete
  {H,T,CNOT} circuit with a T-count. Two modules (`kak.ts`, `kakCircuit.ts`) + one tab (`SynthLab.tsx`)
  + 7 self-tests, touching no existing engine. The method is the magic-basis trick (Kraus–Cirac/Makhlin):
  in the Bell basis a single-qubit pair is real-orthogonal and the interaction is diagonal, so Ũ=O₁FO₂
  is recovered by a **real simultaneous diagonalisation** of the commuting real/imag parts of ŨŨᵀ —
  robust through the degenerate spectra of CNOT/iSWAP, which was the crux. Validated the whole pipeline
  in a throwaway oracle first (the two real bugs it caught: forcing *both* O₁,O₂ into SO(4), not just O₁,
  or a layer goes silently non-local; and the chirality sign of cz being a genuine invariant for x<π/4).
  The Weyl-chamber coordinates give the complete local invariant and the geometric minimum CNOT count
  (0/1/2/3); the canonical interaction is realised by the optimal 3-CNOT Vatan–Williams circuit. Suite
  106 → 113, all green; lint + tsc + build pass.

### Session log
- 2026-06-21 (claude/claude-opus-4-8[1m]): **Quantum Lab 12.0 — Fault-tolerant universality.** Closed
  the loop on the lab's fault-tolerance story: a Clifford-only machine is classically simulable, so
  12.0 added the two dual ideas that make it universal. (1) **Solovay–Kitaev** (`solovay.ts`):
  compile any single-qubit gate into the discrete set {H,T,T†,S,S†,X,Y,Z} to precision ε in
  O(log^c(1/ε)) gates, built on a compact SU(2) (a,b) core, the Dawson–Nielsen group-commutator
  decomposition (axis–angle algebra only, no eigensolver — verified to reconstruct Δ=VWV†W† to
  ~1e-13), a ~9,900-word ε₀-net (covering radius 0.198), and the recursion whose error contracts
  ε_n≈c·ε_{n−1}^{3/2}; `compileGate` reports the word, error, gate count and T-count. (2)
  **Magic-state distillation** (`distillation.ts`): the Bravyi–Kitaev 15-to-1 routine on the
  [[15,1,3]] Reed–Muller code, whose error analysis reduces exactly to the [15,11,3] Hamming code
  (built from scratch, columns = numerals 1…15) — post-select on a trivial X-syndrome, fail on an
  odd-weight codeword, and because the code has distance 3 with exactly 35 weight-3 logicals the
  output obeys p_out=35p³ below a threshold p*≈14.2%, cascading to 4e-15 in three rounds; the exact
  2048-codeword enumeration is cross-checked against a Monte-Carlo of the post-selected protocol. Two
  new tabs (🧭 Solovay–Kitaev, 💎 Distillation), both with three cards, About entries, and 11 new
  self-tests. Every result validated in a throwaway oracle first, then ported faithfully. Suite
  95 → 106, all green; lint + tsc + build pass.
