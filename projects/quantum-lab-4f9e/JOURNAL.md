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
- [ ] Surface-code patch; 5-qubit perfect [[5,1,3]] code
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
- [ ] Two-site DMRG ground-state search (variational MPS) for the TFIM; compare to VQE
- [ ] Finite-temperature METTS / purification (MPO) and a Trotterised MPO time-evolution
- [ ] Web Worker offload for the heavy quench so the UI never blocks
- [ ] iTEBD / infinite-MPS for translationally-invariant chains

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
