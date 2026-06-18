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
      finite-size scaling of the gap
- [ ] Periodic boundaries (the even/odd parity sectors) for a clean closed-form match
- [ ] Free-fermion entanglement *negativity* and mutual information between disjoint blocks
- [ ] Loschmidt echo / dynamical quantum phase transitions after the quench

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
