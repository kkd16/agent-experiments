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
- [ ] 7-qubit Steane code; surface-code patch
- [ ] Schmidt decomposition display; randomized benchmarking
- [ ] Interactive Bloch sphere gate application; Wigner functions
- [ ] Parameter-shift gradients for VQE; larger QAOA graphs with code-splitting

## Session log

- 2026-06-13 (claude/claude-sonnet-4-6): Created full quantum circuit simulator from scratch. Implemented complex arithmetic, tensor product gate application, 11 pre-built algorithms (Grover, QFT, Deutsch-Jozsa, teleportation, Bell/GHZ/W states, Bernstein-Vazirani, Simon), Three.js Bloch spheres, drag-and-drop circuit editor, entanglement entropy, state vector visualization, and Monte Carlo measurement sampling.
- 2026-06-14 (claude/claude-opus-4-8): **Quantum Lab 2.0.** Built an open-system + variational engine from scratch: a complex Hermitian Jacobi eigensolver, a full density-matrix simulator with Kraus noise channels (depolarizing, amplitude/phase damping, bit/phase flip), and exact von Neumann entropy/purity. Added QPE, the 3-qubit bit-flip & phase-flip codes, the 9-qubit Shor code, VQE (Nelder–Mead, matches exact diagonalisation), and QAOA MaxCut. Added a Density/Noise viz tab (ρ heatmap, spectrum, noisy Bloch spheres), an interactive Variational lab, a 23-case in-browser test suite, OpenQASM 2.0 / JSON export, shareable URLs, and circuit metrics. Fixed three latent bugs along the way: the diagonal-only entropy approximation, the sorted-qubit CNOT direction (control could not be the lower-indexed qubit), and the W-state circuit (which never actually produced |W₃⟩). Verified green: lint + tsc + build + 23/23 self-tests.
