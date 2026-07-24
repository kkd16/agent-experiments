# Spectra — Fourier Analysis & Synthesis Lab — journal

The app's long-lived memory. Read this first when you pick the app back up.

**Spectra** is an interactive lab for the discrete Fourier transform. Everything runs in the
browser on a from-scratch FFT — no math libraries. Four connected modes let you *see* what a
Fourier transform actually does: it decomposes a signal (or a drawn shape) into rotating
vectors / pure frequencies, and lets you manipulate them.

## Architecture

- `src/lib/complex.ts` — complex arithmetic on flat `Float64Array` pairs (re[], im[]).
- `src/lib/fft.ts` — iterative radix-2 Cooley–Tukey FFT + IFFT, a direct DFT for arbitrary N,
  and a full complex DFT used by the epicycle machine. Plus helpers: `nextPow2`, magnitude,
  phase, `fftShift`.
- `src/lib/dsp.ts` — window functions (Hann/Hamming/Blackman/rect), signal generators
  (sine/square/saw/triangle/chirp/noise/impulse/ecg), resampling, and a harmonic additive
  synthesizer.
- `src/lib/paths.ts` — parametric preset paths for the epicycle machine + path resampling to a
  power-of-two point count.
- `src/lib/colormap.ts` — perceptual colormaps (viridis-ish, magma-ish) for the spectrogram.
- `src/lib/synth.ts` — a formant-shaped glottal voiced-source generator shared by the audio modes.
- `src/lib/phasevocoder.ts` — STFT⇄ISTFT phase vocoder: time-stretch + pitch-shift (v3).
- `src/lib/dct.ts` — orthonormal DCT-II/III + the 8×8 JPEG-lite block codec (v3).
- `src/lib/cepstrum.ts` — real cepstrum + cepstral / autocorrelation pitch detection (v3).
- `src/lib/cplx.ts` — a scalar complex value type for pole-by-pole filter math (v4).
- `src/lib/poly.ts` — polynomial algebra + a Durand–Kerner all-roots finder (v4).
- `src/lib/filterdesign.ts` — the filter-design engine: Butterworth / Chebyshev I·II / **elliptic**
  analog prototypes, `lp2lp/hp/bp/bs` transforms, a pre-warped bilinear transform, zpk→SOS, a biquad
  cascade, the RBJ cookbook, a windowed-sinc FIR, a **Parks–McClellan (Remez)** FIR, and
  response / group-delay / impulse eval (v4, +elliptic/Remez v6).
- `src/lib/ellip.ts` — the Jacobi elliptic engine (v6): `K(m)` by AGM, `sn/cn/dn` by descending
  Landen, the degree equation `ellipdeg`, a complex inverse `arcsn`, and the elliptic (Cauer)
  analog prototype `ellipap(N, Rp, Rs)`. No libraries.
- `src/lib/remez.ts` — Parks–McClellan optimal equiripple linear-phase FIR by the Remez exchange
  (v6): dense grid, barycentric interpolation, closed-form deviation, alternation search, IDFT taps.
- `src/lib/filterspec.ts` — order/length estimators (v6): `buttord`, `cheb1ord`, `cheb2ord`,
  `ellipord` and the Kaiser FIR estimate, all against the bilinear-prewarped band edges.
- `src/lib/mic.ts` — a defensive real-time microphone tap (AnalyserNode used only as a
  time-domain buffer; our own FFT does the analysis); degrades gracefully when denied (v5).
- `src/lib/note.ts` — equal-temperament frequency→note mapping + sub-bin parabolic peak refine (v5).
- `src/lib/reassign.ts` — **the time-frequency reassignment engine (v7).** Builds a Gaussian
  analysis window and its two analytic companions (`Th = τ·h`, `Dh = h′ = −(τ/σ²)·h`), runs three
  windowed STFTs on the shared FFT, and forms the Auger–Flandrin corrections — local group delay
  `t̂ = n + Re(X_Th/X_h)` (samples) and channelised instantaneous frequency
  `ω̂ = ω_k − Im(X_Dh/X_h)` (rad/sample) — scattering each cell's power to `(t̂, ω̂)` for the
  **reassigned** spectrogram and to `(n, ω̂)` for the invertible **synchrosqueezed** one. Also a
  Rényi-entropy (order-3) concentration metric, a per-column ridge, and the exotic multi-component
  test signals (crossing/parallel/quadratic chirps, sine-FM vibrato, tone+chirp, impulses).
- `src/lib/phantom.ts` — CT test images (v8): the modified **Shepp–Logan** head (ten additive
  ellipses) plus disk / nested-rings / density-bars / spokes phantoms, rasterised over the
  normalized unit-disk square.
- `src/lib/radon.ts` — **the tomography engine (v8).** Ray-driven forward Radon transform
  (parallel-beam line integrals → sinogram), a frequency-domain ramp filter with Ram–Lak /
  Shepp–Logan / cosine / Hann / Hamming apodisation, filtered back-projection (incremental,
  one angle at a time, for the live build animation), and a **direct Fourier Slice Theorem**
  reconstruction — grid every projection's 1-D FFT onto a Cartesian k-space (with the correct
  `e^{+2πi·k·dc/nfft}` detector-centering phase) and inverse-2D-FFT. Plus dose-noise injection,
  the object's true 2-D spectrum, and quality metrics (least-squares affine error map + RMSE,
  Pearson correlation). All on the shared FFT; no CT library. **v9** adds an `arcRad` parameter so
  the gantry can sweep less than 180° — a **limited-angle** scan (a missing wedge of k-space).
- `src/lib/iterative.ts` — **the algebraic CT reconstruction engine (v9).** A matrix-free
  projector / back-projector pair built to be **exact adjoints** (⟨Ax,y⟩ = ⟨x,Aᵀy⟩ to ~1e-16 —
  both walk the same rays with the same bilinear weights, one gathering, one scattering), and three
  solvers for `min ‖Ax − b‖²` over it: **SIRT** (Landweber preconditioned by inverse row/column
  sums), **SART** (the same correction applied one projection at a time — block-iterative, converges
  in far fewer sweeps), and **CGLS** (conjugate-gradient least squares on the normal equations, with
  optional Tikhonov damping μ). Non-negativity `x ≥ 0` enters as a per-iteration projection
  (projected Landweber) for SIRT/SART. A stateful `makeSolver` advances one iteration per `step()`
  so the UI animates convergence. All from scratch; no linear-algebra library.
- `src/lib/contour.ts` — image→outline for the epicycle machine (v8): border-referenced
  thresholding, largest-connected-component flood fill, and **Moore-neighbour boundary tracing**
  into an ordered closed loop, plus a defensive glyph rasteriser for the built-in silhouettes.
- `src/lib/spectral.ts` — **the super-resolution spectral-estimation engine (v10).** A from-scratch
  real-symmetric cyclic **Jacobi** eigensolver and, on top of it, a complex **Hermitian** eigensolver
  via the `2M×2M` real embedding `[[A,−B],[B,A]]` (there is no LAPACK here). Sample covariance with
  forward–backward averaging; **MUSIC** + Pisarenko; **Root-MUSIC** (noise-projection polynomial rooted
  by the lab's Durand–Kerner); **ESPRIT (TLS)** (rotational invariance + a Faddeev–LeVerrier
  characteristic polynomial and a small complex Gauss–Jordan solve); **Capon / MVDR** via the
  eigen-expansion of `R⁻¹`; the complex **Burg** maximum-entropy AR lattice; the **periodogram / Welch**
  FFT baselines on a shared ω axis; and **AIC / MDL** model-order selection. A high-level `analyze()`
  runs the whole battery in one pass. No math libraries.
- `src/lib/comms.ts` — **the digital-communications core (v11).** Gray-coded square-QAM (plus BPSK)
  constellations normalized to unit average energy (a binary-reflected Gray encode/decode drives
  both the per-axis PAM mapping and hard-decision demapping); a seeded `mulberry32` + Box–Muller
  **AWGN** source with the `Eb/N0 → σ` bookkeeping; a from-scratch **erfc** (Numerical-Recipes rational,
  err < 1.2e-7) and the Gaussian tail `Q(x)`; **closed-form BER/SER** for BPSK/QPSK/M-QAM; and a
  Monte-Carlo `simulateLink` / `berCurve` whose measured error rate tracks the theory. No libraries.
- `src/lib/pulse.ts` — **the pulse-shaping engine (v11).** Closed-form **root-raised-cosine** and
  raised-cosine impulse responses (removable singularities handled), upsampling, complex FIR
  convolution, a matched-filter Tx→Rx chain, eye-diagram slicing, and symbol re-sampling. The
  RRC⊛RRC cascade is the zero-ISI Nyquist pulse that opens the eye.
- `src/lib/ofdm.ts` — **the OFDM engine (v11), built on the app's own FFT.** IFFT subcarrier
  modulation with a **cyclic prefix**, a complex multipath channel + its FFT frequency response,
  per-subcarrier **zero-forcing** demodulation/equalization (CP turns linear convolution circular →
  `Y[k]=H[k]X[k]`, inverted by one complex divide), PAPR, and a small library of channel presets.
- `src/lib/adaptive.ts` — **the adaptive-filtering & Kalman engine (v13).** One allocation-light
  transversal-filter runner with four update rules — **LMS**, **NLMS**, **APA** (affine projection,
  order K, through a tiny pivoting `solveSmall`), and **RLS** (inverse-correlation matrix P by the
  matrix-inversion lemma) — plus `makeScenario` wiring four applications from that one runner (system
  identification, adaptive noise cancellation, ISI channel equalization, AR(2) linear prediction), an
  ensemble `learningCurves` MSE averager, a direct `wienerSolution` least-squares oracle, and a
  genuine 2-state constant-velocity **Kalman** tracker (`runKalman`: predict/update on a 2×2
  covariance, ±2σ band, innovation, RMSE). No linear-algebra library.
- `src/lib/ldpc.ts` — **the LDPC codes engine (v14).** A sparse Tanner-graph parity-check code with a
  GF(2) Gaussian-elimination **systematic encoder** (any H → generator, `H·c=0` by construction), three
  code constructors — the (7,4) Hamming code as an LDPC, a **Progressive-Edge-Growth** random regular
  code conditioned for large girth, and a circulant-lifted **QC-LDPC** (the 802.11n/5G form) — a BPSK/AWGN
  channel with exact LLRs, and an iterative **belief-propagation** decoder with four schedules over one
  graph: **sum-product** (exact box-plus via a numerically-stable forward/backward pass), **min-sum**, and
  **normalised / offset min-sum**, each with syndrome early-termination and a per-iteration convergence
  trace. Plus a Monte-Carlo BER/BLER `waterfall`, the rate's **Shannon limit**, and graph analysis
  (`girth`, `degreeStats`). No coding library.
- `src/lib/polar.ts` — **the polar-codes engine (v16).** Arıkan's channel polarization from scratch:
  the `u·F^⊗n` transform as an in-place GF(2) butterfly (its own inverse), two frozen-set constructions —
  the **Bhattacharyya** recursion on the BEC (`z⁻=2z−z²`, `z⁺=z²`) and the **Gaussian approximation** of
  density evolution on BI-AWGN (mean-LLR through the Chung–RU **φ-function** and a bisection inverse) —
  the recursive **successive-cancellation** decoder (exact box-plus *or* min-sum), the **SC-list** decoder
  (Tal–Vardy) carrying the L best paths through one f/g schedule via a survivor-remap, its **CRC-aided**
  variant (bit-wise CRC-6/8/11), a BPSK/AWGN Monte-Carlo `waterfall` (SC · SCL · CA-SCL), and the
  **BI-AWGN capacity** + binary Shannon limit by adaptive Simpson integration. No coding library.
- `src/lib/wavelet.ts` — the **continuous** wavelet transform: a complex Morlet CWT evaluated in the
  frequency domain (convolution theorem), log-spaced scales, pseudo-frequency mapping, time-reduction.
- `src/lib/dwt.ts` — **the discrete wavelet engine (v15).** Orthonormal filter banks **derived from
  scratch**: the Daubechies half-band polynomial `P(y) = Σ C(N−1+k,k) yᵏ`, its roots found by the lab's
  own Durand–Kerner (`poly.ts`), each mapped `z + 1/z = 2 − 4y` and spectrally factored into a
  minimum-phase (Daubechies) or least-asymmetric-by-symmetry-defect (Symlet) scaling filter — no
  coefficient tables. The QMF wavelet filter is `hi[n] = (−1)ⁿ·lo[L−1−n]`. The periodic transform is
  paraunitary, so `dwtStep` (circular-convolve + downsample **gather**) and `idwtStep` (its exact
  **adjoint scatter**) perfect-reconstruct for *any* orthonormal bank; `wavedec`/`waverec` are Mallat's
  pyramid; `mra` projects each subband back to full length (they sum to the signal). Denoising:
  MAD-from-`d₁` noise σ, then **VisuShrink** (universal `σ√(2 ln N)`), **SureShrink** (Stein's unbiased
  risk minimised per band), and **BayesShrink**, soft or hard. Helpers: `magnitudeResponse`,
  `orthonormalityDefect`, `snrDb`.
- `src/lib/dwtSignals.ts` — the **Donoho–Johnstone** test suite (Blocks / Bumps / HeaviSine / Doppler)
  plus a multi-scale MRA demo signal and a deterministic Gaussian-noise injector.
- `src/lib/lifting.ts` — **the biorthogonal engine (v15).** The symmetric (linear-phase) **CDF 5/3**
  and **CDF 9/7** wavelets — the JPEG-2000 pair — implemented by the **lifting scheme** (Sweldens):
  a sequence of predict/update steps between even and odd samples. Each step is trivially invertible,
  so perfect reconstruction is *structural and exact* with no filter-alignment bookkeeping. `dwt.ts`
  dispatches `dwtStep`/`idwtStep` to these when a bank's `transform` is `cdf53`/`cdf97`, so the whole
  stack (wavedec/mra/denoise/wavelet-packets) works with biorthogonal wavelets unchanged.
- `src/lib/wp.ts` — **the wavelet-packet engine (v15).** Where the DWT only recurses on the low-pass
  child, `wpAnalyze` splits **both** children at every node into a full binary tree of subbands (built
  on the same `dwtStep`). `bestBasis` runs the **Coifman–Wickerhauser** bottom-up search over an
  *additive* information cost (Shannon entropy `−Σ xᵢ²log xᵢ²` or ℓ¹) — a parent is kept split iff its
  children are jointly cheaper — returning the minimum-cost admissible cover. `wpReconstruct` inverts
  any cover exactly (PR inherited from `idwtStep`); `wpLeafSignal` synthesises one leaf's band-limited
  component to full length, and `spectralCentroid` (on the shared FFT) places each leaf on the true
  frequency axis for the adaptive tiling.
- `src/hooks/` — `useHashRoute`, `useAnimationFrame`, `useDprCanvas` (devicePixelRatio-aware).
- `src/modes/` — `Epicycles`, `Spectrum`, `Resolve`, `Filter`, `Design`, `Adaptive`, `Spectrogram`,
  `Reassign`, `Live`, `Wavelet`, `ImageFFT`, `Tomography`, `Sensing`, `Vocoder`, `Compress`,
  `Cepstrum`, `Modem`, `Coding`, `LDPC`, `About` (eighteen interactive modes).

## Modes

1. **Epicycles** — draw a closed curve (mouse/touch) or pick a preset; we DFT the path and
   redraw it with N chained rotating vectors. Slider controls how many harmonics; watch the
   approximation sharpen. The flagship visual.
2. **Spectrum** — additive signal builder + a windowed FFT showing magnitude and phase spectra
   with correct frequency axes. See spectral leakage and how windows fix it.
3. **Filter** — take a signal, FFT it, paint a frequency-domain mask (low/high/band/notch),
   IFFT back, and compare before/after in both domains.
4. **Spectrogram** — short-time Fourier transform of a chirp/synth signal rendered as a
   time × frequency heatmap with selectable colormap and window.
5. **Resolve** — *beyond* the FFT. Two tones inside one DFT bin (below the **Rayleigh limit**)
   that the periodogram cannot split, resolved by the subspace estimators (MUSIC, Root-MUSIC,
   ESPRIT), the Capon/MVDR spectrum and the Burg maximum-entropy AR model — all read from the
   eigenstructure of the covariance matrix, with AIC/MDL counting the sources.
6. **Modem** — *the FFT that runs the world.* A complete digital radio: bits → Gray-coded
   BPSK/QPSK/16-/64-QAM → root-raised-cosine pulse shaping → AWGN → matched filter → hard decision,
   with a live received constellation, an eye diagram, the transmit spectrum, and a measured
   BER-vs-Eb/N0 curve that lands on the closed-form theory. A second tab builds **OFDM** (Wi-Fi/5G):
   an IFFT over hundreds of subcarriers, a cyclic prefix, a frequency-selective multipath channel,
   and a one-tap zero-forcing equalizer that snaps the smeared cloud back to a clean grid.
7. **Coding** — *how the bits survive the noise.* A complete forward-error-correction pillar built
   on the Modem's channel: from-scratch **convolutional encoders** (K=3…7, incl. the Voyager/802.11
   (171,133) code), hard- **and** soft-decision **Viterbi** maximum-likelihood decoding, and
   rate-compatible **puncturing** (1/2 → 2/3 → 3/4 → 5/6). Tab 1 animates the **Viterbi trellis**
   live — the survivor sweep, per-node metrics, the ML path snapping onto the true path as channel
   errors are repaired. Tab 2 draws the **coding gain**: measured BER beside the closed-form
   **union bound** built from the code's own **distance spectrum** (d_free re-derived from the
   trellis), with the whole curve sliding left. Tab 3 is a visceral **message demo** — the same text
   through the same noise, shredded uncoded vs. perfectly repaired coded.
8. **Adaptive** — *the filters that learn.* Every other filter here is fixed (Design/Filter); an
   **adaptive** filter starts blind and tunes its own taps from the data to minimise `e = d − y`.
   The same transversal mechanism, with four update rules (**LMS / NLMS / APA / RLS**), solves four
   classic problems just by rewiring what plays the input u and the desired d: **system
   identification**, **adaptive noise cancellation**, **channel equalization**, and **linear
   prediction**. An ensemble **learning-curve race** shows RLS converging in ~2L steps to the exact
   least-squares (Wiener) solution while colour in the input cripples plain LMS. A fifth scenario is
   a genuine 2-state **Kalman** tracker — the same predict/update recursion as RLS, applied to a
   physical state, with its own shrinking ±2σ uncertainty band and a white innovation sequence.
9. **Polar** — *reaching Shannon with an explicit code.* Arıkan's **channel polarization**: recursively
   combine and split a channel and its synthetic bit-channels split toward perfect or useless, so you send
   information only on the good ones and **freeze** the rest to 0. Four tabs — the **polarization
   staircase** and the self-similar frozen set (two from-scratch constructions: Bhattacharyya/BEC and the
   Gaussian approximation of density evolution); the **F^⊗n encoder** butterfly; a **decode** race across
   greedy **SC**, the **SC-list** (Tal–Vardy, keep the L best paths by an LLR metric) and the **CRC-aided
   list** (the 5G decoder, an outer CRC picks the surviving path that checks); and a Monte-Carlo
   **waterfall** landing a short code within ~1 dB of the binary Shannon limit.

## Ideas / backlog

### v16 plan — the **Polar codes** mode (channel polarization) — this session

The coding pillar had the two great decoding paradigms — the trellis search (Coding/Viterbi, v12) and
belief propagation (LDPC, v14) — but was missing the third and most recent: **polar codes** (Arıkan,
2009), the first family *proven* to achieve the symmetric capacity of any binary-input channel with an
explicit, low-complexity construction, and the code that carries the 5G-NR control channels. v16 adds
the whole pillar as a **twentieth mode**, from scratch, and — like the rest of the lab — proves every
claim in front of the user (the transform is its own inverse; SCL(L=1) reproduces SC bit-for-bit; the
CRC catches flips; and growing the list then adding the CRC strictly lowers the measured BLER). All
hold — self-tests 78–85, **127/127 green** in the browser, and every Polar tab renders in headless
Chromium with zero console errors.

Shipped this session:

- [x] **The polar engine** (`polar.ts`, ~640 lines) — the `u·F^⊗n` transform as an in-place GF(2)
  butterfly (self-inverse), snapshotting `transformStages` for the encoder animation.
- [x] **Two channel constructions** — the **Bhattacharyya** BEC recursion and the **Gaussian
  approximation** of density evolution (Chung–Richardson–Urbanke φ-function + a bisection inverse),
  each ranking the N synthetic channels so `buildCode` freezes the worst N−K. A `channelCapacities`
  helper maps both onto one [0,1] capacity axis (BEC → 1−Z, GA → a Simpson integral of the mean-LLR).
- [x] **The SC decoder** — the recursive f (exact stable box-plus *or* min-sum) / g message schedule,
  each recursion returning its subtree's re-encoded partial sums for the parent's g-node.
- [x] **The SC-list decoder** (Tal–Vardy) — the L most-likely paths carried through the *same* f/g
  recursion; each information bit forks every path 0/1, ranks by the LLR **path metric**
  `PM += softplus(−(1−2û)·L)`, and prunes to L. Implemented by a survivor-map (`newPath→parent`) that
  each recursion frame applies to remap its own LLR/bit state, so the whole list shares one schedule.
- [x] **CRC-aided SC-list** (the 5G decoder) — a bit-wise CRC-6/8/11; the returned path is the
  lowest-metric survivor whose info bits satisfy the CRC (else the metric-best).
- [x] **The yardsticks** — BI-AWGN capacity and the binary Shannon limit by adaptive Simpson +
  bisection; a BPSK/AWGN Monte-Carlo `waterfall` with an adaptive block budget.
- [x] **Four-tab Polar UI** (`modes/Polar.tsx`) — *Polarization* (the capacity staircase + the
  self-similar frozen-set map, with Σcapacity ≈ N·C shown conserved), *Encoder* (the F^⊗n XOR
  butterfly network with a live message flowing through the stages), *Decode* (one noisy word decoded
  three ways — SC vs best-metric SCL vs CA-SCL — with the ranked survivor list and CRC flags), and
  *Waterfall* (SC · SCL L=2/8 · CA-SCL L=8 vs uncoded BPSK and the Shannon line). All deep-linkable.
- [x] **Eight new self-tests (119 → 127)** covering the guarantees above.

Future polar ideas (not yet built):

- [ ] **Simplified SC (SSC/Fast-SSC)** — prune Rate-0/Rate-1/REP/SPC subtrees for a step-through of the
  decode tree that skips the trivial nodes, the throughput trick real decoders use.
- [ ] **The 5G-NR reliability sequence** (the standardised Q-sequence) as a third construction, with
  rate-matching (puncturing / shortening / repetition) to arbitrary (N,K), not just powers of two.
- [ ] **CRC-aided *systematic* polar encoding** (Arıkan's systematic transform) for the lower BER the
  systematic form gives at the same BLER.
- [ ] **A polarization-vs-n animation** — sweep the block length and watch the capacity histogram
  split, plus the exact mutual-information conservation drawn as a running total.
- [ ] **Wire the Modem's 16-/64-QAM soft LLRs into the polar decoder** so the whole TX→channel→FEC
  chain runs on one shared constellation, as with the LDPC backlog.
- [ ] **List-size sweep** — BLER vs L at a fixed SNR, showing the diminishing returns and where CA-SCL
  overtakes an ML lower bound.

### v15 plan — the **discrete wavelet transform** pillar (Wavelet mode) — this session

The Wavelet mode shipped in v6 as a single **continuous** transform: a Morlet scalogram beside an
STFT. Beautiful, but redundant (one row per scale) and one-way — it never showed the transform that
does the *practical* work. The DWT is the critically-sampled, orthonormal, exactly-invertible cousin
behind JPEG-2000, the FBI fingerprint codec, and nearly all wavelet denoising. v15 turns the Wavelet
mode into three tabs and adds that whole pillar — and, in the spirit of the rest of the lab, derives
the filters from first principles rather than pasting coefficient tables, and proves every claim in
front of the user (orthonormality to 1e-9, reconstruction to the 1e-15 floating-point floor, db2 vs
its published values, vanishing moments annihilating a ramp, additive MRA bands, and denoising SNR
gains on the Donoho suite). All hold — self-tests 8b–8g, 115/115 green in the browser.

Shipped this session:

- [x] **The DWT engine** (`dwt.ts`) — orthonormal filter banks **derived from scratch** by spectral
  factorization of the Daubechies half-band polynomial (roots via the lab's Durand–Kerner), yielding
  minimum-phase **Daubechies (db1–db10)** and least-asymmetric **Symlets (sym4–sym8)**. Periodic
  paraunitary transform whose synthesis is the *exact adjoint* of analysis → perfect reconstruction
  for any orthonormal bank; Mallat multi-level `wavedec`/`waverec`; full-length additive `mra`.
- [x] **Wavelet denoising** — MAD noise estimate from the finest band, **VisuShrink** / **SureShrink**
  (Stein's unbiased risk) / **BayesShrink** thresholds, soft & hard, with input/output SNR + %-kept.
- [x] **The Donoho–Johnstone test suite** (`dwtSignals.ts`) — Blocks / Bumps / HeaviSine / Doppler.
- [x] **The wavelet-packet engine + best basis** (`wp.ts`) — the full packet tree, Coifman–Wickerhauser
  best-basis selection (Shannon / ℓ¹ additive cost), exact reconstruction of any cover, and per-leaf
  band synthesis + spectral-centroid placement for the adaptive time-frequency tiling.
- [x] **Four-tab Wavelet UI** — *Scalogram* (the original CWT-vs-STFT), *Multiresolution* (stacked
  octave bands + per-band energy + live reconstruction error + the QMF frequency-response pair),
  *Denoise* (noisy-vs-recovered overlay against the clean reference), and *Best basis* (the adaptive
  packet tiling as a magma time-frequency heatmap with a compaction figure). All deep-linkable.
- [x] **Nine new self-tests** (109 → 118) covering the guarantees above.

- [x] **Biorthogonal wavelets** (`lifting.ts`) — the symmetric CDF 5/3 & 9/7 (JPEG-2000) pair by the
  lifting scheme, wired through `dwt.ts`'s transform dispatch so they flow through every DWT tab
  (multiresolution, denoise, best-basis) with structural perfect reconstruction. +1 self-test (→119).

Future wavelet ideas (not yet built):

- [ ] **2-D DWT** for image compression, tied into the Image/Compress modes (JPEG-2000-style).
- [ ] **Coiflets** (vanishing moments on the scaling function too) via the extended design equations.
- [ ] An interactive **coefficient heatmap** showing exactly which coefficients shrinkage keeps.

### v14 plan — the **LDPC** mode (low-density parity-check codes) — this session

The **Coding** mode (v12) delivered the convolutional/Viterbi pillar — optimal, but a code whose
performance saturates ~2 dB shy of capacity. The codes that actually *reach* Shannon — Wi-Fi, 5G-NR,
DVB-S2, CCSDS deep-space — are **LDPC** and **turbo** codes, decoded not by a trellis search but by
**iterative message passing** on a graph. v14 adds a complete, from-scratch LDPC mode: real sparse
parity-check codes, a systematic encoder derived from H by GF(2) elimination, and a belief-propagation
decoder with four schedules — with every claim provable in front of the user, like the rest of the lab
(`H·c = 0` by construction; the decoder recovers at high SNR; sum-product ≥ min-sum; PEG girth ≥ 6; the
coded BER sits a wide margin below uncoded BPSK). All hold — see self-tests 74–77 (all 109 green in the
browser).

Shipped this session:

- [x] **The LDPC engine** (`ldpc.ts`) — a sparse Tanner-graph code (`checkNodes`/`varNodes` + a parallel
  edge list) with a **GF(2) Gauss–Jordan systematic encoder** that turns *any* parity-check matrix into a
  generator: RREF picks free columns to carry message bits and pivot columns to carry parity, so
  `encode(msg)` provably satisfies `H·c = 0` and round-trips the systematic bits back out. Library-free.
- [x] **Three code constructors** — the **(7,4) Hamming** code as a tiny dense LDPC (girth-4, ideal for
  the graph view); a **Progressive-Edge-Growth** (Hu–Eleftheriou–Arnold 2005) random regular code that
  grows one edge at a time toward the *farthest* check node in the current graph to maximise girth (PEG
  (12,6), (48,24), (96,48), (204,102), all girth ≥ 6); and a **circulant-lifted QC-LDPC** — a base matrix
  of shift values lifted by L×L cyclic-permutation blocks, the algebraic 802.11n/5G-NR form.
- [x] **BPSK-over-AWGN with exact LLRs** — `noiseSigma(Eb/N0, rate)` and a `channel` that maps bit→±1,
  adds Gaussian noise, and returns the channel log-likelihood ratio `2y/σ²`.
- [x] **The belief-propagation decoder** (`decode`) — flooding-schedule message passing shared by four
  algorithms: **sum-product** (the exact box-plus check rule computed by a numerically-stable
  forward/backward pass — no `tanh`/`atanh` saturation, no division), **min-sum** (sign-product ×
  min-magnitude via the first/second-minimum trick), and **normalised** / **offset min-sum** (the scaled
  and shrunk variants that de-bias min-sum). Syndrome-based **early termination** and a per-iteration
  hard-decision + unsatisfied-check trace for the animation.
- [x] **The Monte-Carlo waterfall** (`waterfall`) — BER/BLER vs Eb/N0 by simulation (all-zero-codeword
  trick, valid for any linear code on a symmetric channel), accumulating blocks until a stable
  frame-error estimate, plus `uncodedBer` and the rate's `shannonLimitDb`.
- [x] **Graph analysis** — `girth` (BFS shortest cycle in the Tanner graph) and `degreeStats` (bit/check
  degree histograms) for the "code" view.
- [x] **The LDPC mode UI** (`LDPC.tsx`) — three tabs: an **animated Tanner graph** (checks amber-until-
  satisfied, bits rose-until-correct, a scrubbable per-iteration playhead, and a descending
  syndrome-weight chart); the **waterfall** (four decoders + uncoded + Shannon marker, BER/BLER toggle,
  quick/balanced/deep effort, chunked off the paint path so the UI stays live); and **the code** (H
  sparsity pattern, rate/rank/girth readout, bit/check degree histograms). Deep-linkable URL state.
- [x] **4 new self-tests** (74–77) — encoder `H·c=0` + systematic round-trip across all codes, all four
  decoders recovering ≥90% at 5 dB, sum-product BER far below uncoded BPSK, and sum-product ≤ min-sum +
  PEG-girth-≥6 + Shannon(½)≈0 dB. Wired the mode into `App.tsx`, ran the CI gate (scope + conformance +
  lint + build ✓), and drove it headless in Chromium: **109/109 self-tests pass**, all three tabs render
  and the waterfall computes with zero console/runtime errors. Eighteen modes, still zero math libraries.

Backlog — where the LDPC / iterative-coding pillar goes next:

- [ ] **Layered (row) BP scheduling** — update check-by-check reusing fresh messages within an iteration;
  it roughly halves the iterations to converge. A/B it against flooding on the convergence chart.
- [ ] **A true 5G-NR base graph (BG2) lift** with the standardised shift tables and a rate-matching
  circular buffer (puncture the first 2Z systematic columns, shorten/repeat to any rate).
- [ ] **Richardson–Urbanke efficient QC encoding** (the approximate-lower-triangular back-substitution)
  so the encoder exploits the circulant structure instead of dense GF(2) elimination.
- [ ] **Density evolution / an EXIT chart** — track the decoder's message-LLR density (or the mutual-
  information transfer curves) to *predict* the decoding threshold, and show the tunnel closing at it.
- [ ] **Irregular codes from a degree distribution** (λ(x), ρ(x)) built by PEG with a target profile —
  the capacity-approaching designs — and the threshold gap vs the regular (3,6) code.
- [ ] **A Gallager bit-flipping / Gallager-A,B hard-decision decoder** for contrast — near-free, and it
  makes the value of *soft* information visible when its curve sits well right of BP.
- [ ] **Error-floor diagnostics** — find the dominant **trapping / absorbing sets** of a code and show the
  BLER floor they cause, the thing that separates a good code from a bad one at low BER.
- [ ] **Turbo codes** — two recursive-systematic convolutional encoders + an interleaver, iterative
  **BCJR (MAP)** decoding with extrinsic-information exchange; the other great capacity-approaching family,
  and a natural bridge back to the Coding mode's trellis.
- [ ] **Polar codes** — Arıkan channel polarisation, successive-cancellation (and SC-list) decoding, the
  5G control-channel code, to complete the modern-coding triad.
- [ ] **Wire LDPC into the Modem** — feed real 16-/64-QAM soft LLRs (not just BPSK) into the decoder so the
  coded constellation link is end-to-end, and race coded vs uncoded QAM on one BER plot.
- [ ] **A Tanner-graph editor** — let the user drag edges / toggle H entries and watch the girth, rate and
  waterfall recompute live, turning the "code design" tab into a sandbox.

### v13 plan — the **Adaptive** mode (adaptive filters & the Kalman filter) — this session

The whole lab, until now, built **fixed** filters: state a spec (Design) or pick coefficients
(Filter) and the response is frozen. But the filters that run the modern world — echo cancellers,
noise-cancelling headphones, channel equalizers, GPS/radar trackers, speech coders — all *learn*
their coefficients from the data, live. That was the last great missing pillar. v13 adds a complete
adaptive-filtering + Kalman mode whose every claim is provable in front of the user, like the rest
of the lab: RLS must land on the exact least-squares (Wiener) solution; a coloured input must cripple
LMS while leaving RLS untouched (the eigenvalue-spread story); the noise canceller must lift SNR; the
equalizer must open the eye; the predictor must whiten; and the Kalman estimate must beat the raw
measurements with a white innovation sequence. All hold — see self-tests 59–73 (all 105 green in the
browser).

Shipped this session:

- [x] **The adaptive engine** (`adaptive.ts`) — one allocation-light transversal-filter runner with
  four update rules: **LMS** (Widrow–Hoff stochastic gradient), **NLMS** (power-normalised),
  **APA** (affine projection of order K — reuses the last K regressors, solved through a tiny
  Gaussian-elimination `solveSmall`), and **RLS** (recursive least-squares carrying the inverse
  correlation matrix P by the matrix-inversion lemma). All library-free.
- [x] **Four scenarios from one runner** — `makeScenario` wires the input/desired pair for **system
  identification** (probe an unknown decaying-exponential FIR plant), **adaptive noise cancellation**
  (a tone under noise that reaches the mic through an unknown room path; a reference mic hears the raw
  noise; the error output *is* the recovered signal), **channel equalization** (±1 BPSK through a
  Proakis ISI channel, trained against a delayed clean copy), and **linear prediction** (a one-step
  predictor whitening a sharp AR(2) resonance).
- [x] **The ensemble learning curve** — `learningCurves` averages e²(n) over 14 independent
  realisations per algorithm to draw the textbook MSE-vs-iteration curve, all four racing at once.
- [x] **The Wiener oracle** — `wienerSolution` solves the normal equations R·w = p directly, so the
  self-tests confirm RLS converges to the *right* answer (misalignment < −40 dB), not merely a stable one.
- [x] **A real Kalman filter** (`runKalman`) — a 2-state constant-velocity tracker carrying the 2×2
  covariance, predict/update, ±2σ band, innovation whiteness, and RMSE vs the raw measurements. The
  pedagogical tie-in: RLS *is* a Kalman filter for a random-walk weight vector.
- [x] **The Adaptive mode UI** (`Adaptive.tsx`) — scenario + algorithm selectors, scenario-specific
  controls (input colour ρ, ISI channel, AR poles, measurement/process σ), a four-panel canvas grid
  that adapts per scenario (signal comparison, the learning-curve race, tap-weights vs ground truth /
  the equalized `channel ⊛ equalizer ≈ δ`, and a scenario extra — a BPSK strip that snaps from a
  closed to an open eye, the whitened residual, or the Kalman uncertainty band), plus a live metrics
  readout and deep-linkable URL state.
- [x] **15 new self-tests** (59–73) — `solveSmall`/`convolve` correctness, LMS/NLMS/APA/RLS plant
  identification, RLS == Wiener, RLS beats LMS, coloured input degrades LMS more than RLS, the learning
  curve descends, ANC SNR gain > 15 dB, equalizer tail SER < 1% + combined-response ≈ δ, predictor
  learns the AR taps and whitens, Kalman RMSE < measurement RMSE, and the covariance settles.
- [x] Wired the mode into `App.tsx` (route + nav), ran the CI gate (scope + conformance + lint + build ✓)
  and drove it headless in Chromium: 105/105 self-tests pass, all five scenarios render across all four
  panels with zero console/runtime errors.

Backlog — where the Adaptive pillar goes next:

- [ ] **A lattice / gradient-adaptive-lattice (GAL) predictor** — the order-recursive form whose
  reflection coefficients are the same PARCOR the Burg spectrum (Resolve) and LPC speech coder use;
  show the whitening happen stage by stage.
- [ ] **Recursive Least-Squares Lattice (RLSL)** — the O(L) exact-LS algorithm, and an A/B of its
  convergence against full RLS to show you can have RLS speed at LMS cost.
- [ ] **Frequency-domain / block LMS (FDAF)** — run the adaptation through the lab's own FFT with the
  overlap-save partitioned convolution, the algorithm real echo cancellers actually ship.
- [ ] **Sign-error / sign-data / sign-sign LMS** and the **leaky LMS** — the cheap fixed-point variants
  and the stability/bias trade-offs they buy.
- [ ] **Variable step-size LMS** and the **normalised-step derivation** drawn as a live misadjustment
  curve, so the µ ↔ speed ↔ excess-MSE triangle is visible.
- [ ] **A non-stationary tracking scenario** — a plant that drifts mid-run, to show forgetting-factor λ
  and step size µ as *tracking* knobs, not just convergence knobs (the RLS/LMS tracking-vs-convergence
  duality).
- [ ] **Decision-directed equalization** — drop the training reference after acquisition and adapt on the
  filter's own decisions; and a **blind CMA (constant-modulus)** equalizer that never needs a reference.
- [ ] **Fractionally-spaced equalizer (T/2)** — the practical form that is insensitive to timing phase.
- [ ] **An Extended / Unscented Kalman filter** on a non-linear track (bearings-only or a pendulum), plus
  a **Kalman smoother** (RTS backward pass) A/B'd against the forward filter.
- [ ] **A steady-state Wiener/Kalman gain** panel — solve the discrete algebraic Riccati equation and show
  the covariance converge to it.
- [ ] **Wire the mode to live audio** — cancel a hum from the mic tap in real time, or identify the room
  impulse response between the speaker and mic.

### v12 plan — the **Coding** mode (forward error correction) — this session

The Modem pillar carried bits to the edge of the noise and stopped at the hard decision. But every
real link — deep-space, Wi-Fi, LTE, DVB, GSM — closes the last few dB with an **error-correcting
code**. That was the biggest gap in the communications story: the lab could *measure* a bit-error
rate but never *fix* one. v12 adds a complete convolutional-coding + Viterbi pillar whose claims are,
like the rest of the lab, provable in front of the user: the measured Monte-Carlo BER must sit under
the closed-form **union bound**, soft decisions must beat hard by the textbook ~2 dB, and the free
distance the bound is built on must be re-derived from the trellis and match the published tables.
All hold (see self-tests 51–58; the (171,133) code comes out at d_free = 10 with a₁₀ = 11, the
canonical value).

Shipped this session:

- [x] **The FEC engine** (`fec.ts`) — an octal-generator convolutional encoder over a general rate-1/n
  trellis (`buildTrellis`/`convEncode`, zero-terminated), a catalogue of five textbook codes
  (K=3 (7,5) … K=7 (171,133) and the rate-1/3 (171,133,165)).
- [x] **Viterbi decoding, hard and soft** — a single add–compare–select core with Hamming or squared
  Euclidean branch metrics and full traceback, exposing per-step survivor metrics **and** back
  pointers so the UI can animate the sweep.
- [x] **Rate-compatible puncturing** — the standard 802.11/DVB patterns (2/3, 3/4, 5/6) on the 1/2
  mother code, with a de-puncture step that reinserts erasures (zero-info branch metrics) for the
  decoder; rates come out exact.
- [x] **The distance spectrum + union bounds** — a weight-bounded dynamic program enumerates every
  first-return-to-zero error event, giving `{d, a_d, c_d}`; `d_free` falls out, and the soft/hard
  union bounds `Σ c_d·P₂(d)` (soft `Q(√(2Rdγ))`, hard the BSC majority-vote sum) become closed-form
  oracles drawn beside the measured curve.
- [x] **End-to-end Monte-Carlo link** — `simulateCoded` runs message → encode → puncture → BPSK →
  AWGN → (hard slice + Viterbi) **and** (soft Viterbi), with an uncoded BPSK reference at matched
  Eb/N0 (coded-bit energy R·Eb), returning every error count for the coding-gain curve.
- [x] **The Coding mode UI** (`Coding.tsx`) — the live animated **trellis**, the **coding-gain**
  plot (uncoded / hard / soft, measured dots + union bounds + distance-spectrum bars + gain
  readouts), and the **message demo** (sent vs uncoded-through-noise vs coded-and-repaired, with a
  character-level diff). All deep-linkable.
- [x] **8 new self-tests** (51–58) — published d_free for all five codes + the exact (7,5) spectrum,
  noiseless hard/soft round-trips, single-error correction, `soft ≤ hard < uncoded` with `measured ≤
  bound`, a ≥10× soft coding gain, exact puncture rates + de-puncture round-trip, a punctured link
  beating its channel BER, and text↔bits + a coded message outliving the uncoded one. All 90 green.

Backlog (future sessions, natural extensions of this pillar):

- [ ] **BCJR / MAP (soft-output) decoding** — the forward–backward algorithm producing per-bit
  a-posteriori LLRs, the front half of a turbo decoder.
- [ ] **Turbo codes** — two RSC encoders + an interleaver, iterative BCJR decoding, and the
  waterfall-then-floor BER curve that stunned the field in 1993.
- [ ] **A recursive systematic convolutional (RSC) code** option and the systematic-vs-nonsystematic
  BER contrast (RSC helps below capacity, hurts the union bound).
- [ ] **Hard-vs-soft on a genuine QAM channel** — feed the Modem's 16-/64-QAM LLRs into the decoder
  so coding gain is shown on the constellations users already know, not just BPSK.
- [ ] **Traceback depth** as a slider (the practical 5·K truncation) with the BER cost of shortening
  it — the classic memory/latency trade every real Viterbi chip makes.
- [ ] **A Fano / stack sequential decoder** for a long-constraint code, and its variable compute vs.
  Viterbi's fixed cost.
- [ ] **Reed–Muller / Hamming block codes** and a syndrome decoder, to sit the algebraic and
  trellis worlds side by side.
- [ ] **Punctured-code exact spectra** — a time-varying trellis over the puncture period so the
  union bound is exact for the punctured rates too, not just the mother code.
- [ ] **An interleaver + burst-error channel** to show why coding alone fails on bursts and how
  interleaving rescues it.
- [ ] **LDPC teaser** — a small regular LDPC code with a few belief-propagation iterations on its
  Tanner graph, the modern successor to everything here.

### v11 plan — the **Modem** mode (digital communications) — this session

The lab has always studied the FFT as a *lens on signals*. But the FFT's single biggest footprint
on the modern world isn't analysis at all — it's **carrying data**. Every Wi-Fi packet, LTE frame
and DVB broadcast is an OFDM waveform painted by an IFFT. A Fourier lab without a communications
pillar was missing its most consequential application. v11 adds a complete, from-scratch digital
radio and, on top of it, OFDM — the clearest possible demonstration of *why the FFT matters*.

The design goal was a mode whose correctness is **provable in front of the user**: the measured
Monte-Carlo bit-error rate must fall exactly along the closed-form theory curve, and OFDM must
recover multipath-corrupted symbols to machine precision. Both hold (see the self-tests).

Shipped this session:

- [x] **Constellations** — Gray-coded square QAM (BPSK/QPSK/16-QAM/64-QAM) normalized to unit
  average symbol energy, built from a binary-reflected Gray code that drives both the per-axis
  PAM mapping and the hard-decision demapper (`comms.ts`).
- [x] **AWGN channel** — seeded `mulberry32` + Box–Muller Gaussian source with the `Eb/N0 → σ`
  conversion so every scheme is compared fairly on energy-per-bit.
- [x] **BER/SER theory** — a from-scratch rational **erfc** (< 1.2e-7 error) and `Q(x)`, exact
  BPSK/QPSK and the tight Gray-QAM nearest-neighbour approximation, plus a Monte-Carlo
  `simulateLink` / `berCurve` that measures the real thing.
- [x] **Root-raised-cosine pulse shaping** (`pulse.ts`) — closed-form RRC + RC impulse responses,
  upsample → RRC(Tx) → matched RRC(Rx), eye-diagram slicing; the RRC⊛RRC cascade is verified
  zero-ISI (Nyquist), which is what opens the eye.
- [x] **OFDM** (`ofdm.ts`) — IFFT subcarrier modulation, cyclic prefix, a complex multipath
  channel + its FFT response, per-subcarrier zero-forcing equalization, and PAPR — all on the
  app's own `fft`/`ifft`.
- [x] **The Modem mode UI** (`Modem.tsx`) — a single-carrier tab (live constellation, eye diagram,
  transmit spectrum, measured-vs-theory BER curve, BER/SER/EVM/efficiency readouts) and an OFDM
  tab (equalized constellation, channel `|H(f)|`, the time-domain symbol with the CP highlighted,
  PAPR/CP-overhead/BER readouts, and an equalizer toggle that visibly makes or breaks the link).
- [x] **14 new self-tests** — Gray-code bijection + one-bit neighbours, unit-energy constellations,
  lossless map→demap, the erfc/Q identities, BER-monotonicity + density ordering, **Monte-Carlo BER
  tracks theory** (BPSK/QPSK/16-QAM), AWGN variance, RRC unit energy + zero-ISI, the full shaping
  chain error-free in the clear, **OFDM exact round-trip**, **CP + equalizer inverting multipath to
  1e-9**, and PAPR sanity. All 82 self-tests green.

Backlog (future sessions, natural extensions of this pillar):

- [ ] **Soft-decision demapping + LLRs** — per-bit log-likelihood ratios out of the demapper, the
  front-end every real decoder needs.
- [x] **A channel code** — a short convolutional code with Viterbi decoding (or a Hamming code),
  and a coded-vs-uncoded BER curve showing the coding gain. *(Shipped in v12 — the **Coding** mode:
  convolutional codes K=3…7, hard/soft Viterbi, puncturing, union bounds, and an animated trellis.)*
- [ ] **Non-square constellations** — 8-PSK and cross-QAM (32/128-QAM) with their own exact SER.
- [ ] **Carrier & timing recovery** — a Costas loop for phase and a Gardner timing-error detector,
  so the receiver locks a rotated/offset constellation instead of assuming perfect sync.
- [ ] **Fading channels** — a Rayleigh/Rician tap model with a Doppler spectrum, and the
  diversity-order slope it produces on the BER curve.
- [ ] **OFDM pilots + channel estimation** — comb/block pilots and least-squares/MMSE interpolation
  so `H(f)` is *estimated* from the received signal rather than assumed known.
- [ ] **A CCDF plot for PAPR** and a clipping/companding demo of the peak-power problem.
- [ ] **A live audio "modem"** — play the shaped waveform and decode it back through the mic tap.

### v10 plan — the **Resolve** mode (super-resolution spectral estimation) — this session

Every mode so far has, one way or another, read the world through the FFT. But the FFT has a
hard wall the whole lab has quietly respected: the **Rayleigh resolution limit**. Two tones
closer than one DFT bin (`Δf ≈ fs/N`) merge into a single blurry lobe, and no amount of
zero-padding or windowing pulls them apart — leakage, not resolution, is what padding buys you.
This mode is the lab's answer to *"can we do better than the FFT?"* — and the answer, from the
**parametric / subspace** school of spectral estimation, is a resounding yes.

Given the model that a signal is a handful of sinusoids in noise, these estimators exploit the
**eigenstructure of the sample covariance matrix** to place tones with essentially unlimited
precision — well below the bin. This is the capstone the lab has been missing: it is the direct
sequel to Spectrum ("here is what the FFT sees"), it is one of the deepest, most surprising
results in signal processing (MUSIC, ESPRIT, maximum entropy), it is visually dramatic (one FFT
blob → two razor spikes exactly on the true frequencies), and every headline number is
checkable in-browser against known ground truth. All from scratch — including a Hermitian
eigensolver, because there are no math libraries here.

- [x] **`lib/spectral.ts`** — a from-scratch super-resolution engine, all in terms of the lab's own
  `Cx` / `poly` / `fft`:
  - [x] A **real-symmetric cyclic Jacobi eigensolver** (`jacobiSym`), and on top of it a **complex
    Hermitian eigensolver** (`hermitianEig`) via the `2M×2M` real embedding `[[A,−B],[B,A]]` — the
    only honest way to eigendecompose a covariance matrix with no LAPACK. Sorted eigenpairs.
  - [x] **Sample covariance** from length-`M` snapshots with optional **forward–backward averaging**
    (the exchange-matrix symmetrisation that halves the variance and de-correlates coherent tones).
  - [x] **MUSIC** pseudospectrum (noise-subspace nulling), and **Pisarenko** as its one-vector limit.
  - [x] **Root-MUSIC** — form the noise-projection polynomial, root it with the lab's Durand–Kerner
    `polyRoots`, and read frequencies off the arguments of the roots nearest the unit circle. Grid-free
    super-resolution.
  - [x] **ESPRIT (TLS)** — rotational invariance: stack the shifted signal subspaces, take the small
    eigenspace of `[E₁ E₂]ᴴ[E₁ E₂]`, and recover `Ψ = −W₁W₂⁻¹`; its eigenvalues (via a from-scratch
    **Faddeev–LeVerrier** characteristic polynomial + `polyRoots`) sit at `e^{jω}`.
  - [x] **Capon / MVDR** minimum-variance spectrum via the eigen-expansion of `R⁻¹` (with diagonal
    loading), the high-resolution *non-parametric* baseline.
  - [x] **Burg / maximum-entropy AR** — the complex Burg lattice recursion (reflection coefficients,
    Levinson update), giving the classic sharp MEM spectrum by a completely different (linear-prediction)
    route.
  - [x] **Periodogram + Welch** — the honest FFT baselines (windowed, zero-padded; Welch = averaged
    overlapping segments) so the resolution gap is drawn on the very same axes.
  - [x] **AIC / MDL** model-order selection (Wax–Kailath) from the eigenvalue profile — *estimate how
    many tones are there* instead of being told.
- [x] **`modes/Resolve.tsx`** — the mode UI: a tone editor (with a "two tones below Rayleigh"
  headline preset and a separation slider that crosses the bin boundary live), real-vs-complex signal
  model, SNR, snapshot order `M`, assumed source count `p` (or **auto** via MDL), and a method
  multi-select. Panels: (A) the **signal** in time; (B) the **spectra overlay** — periodogram/Welch
  filled underneath, MUSIC/Capon/Burg pseudospectra as lines, true frequencies as markers, and the
  Rayleigh limit drawn as a shaded band; (C) the **eigenvalue profile** with the signal/noise split and
  the MDL/AIC verdict; (D) the **z-plane** with the root-MUSIC / ESPRIT roots landing on the unit
  circle at the true angles; and (E) a **resolution scoreboard** — true vs estimated frequency per
  method, the error in mHz, and a resolved ✓/✗ verdict.
- [x] Wire the mode into `App.tsx` (route + nav), add a **Resolve** entry + a "Beyond the FFT" math
  card to the About page (bump "fourteen modes" → "fifteen"), and add self-tests: Hermitian eig
  reconstructs `R` and is orthonormal; root-MUSIC / ESPRIT / MUSIC resolve two sub-Rayleigh tones to
  <1% while the periodogram provably cannot; Burg resolves a moderately-separated pair; and MDL counts
  three well-separated sources correctly.

### v9 plan — the **Sensing** mode (compressed sensing / sparse recovery) — this session

The whole lab has, so far, preached one gospel: **Nyquist**. To pin down a signal you need at
least two samples per period — or the aliasing modes show you get garbled ghosts. Compressed
sensing (Candès–Romberg–Tao, Donoho, 2006) is the beautiful heresy that overturns it: *if the
signal is sparse in some basis*, you can nail it **exactly** from far fewer measurements than
Nyquist demands — by solving an ℓ₁ optimisation instead of an ℓ₂ one. This mode makes that
landmark result playable, and it reuses the lab's own FFT/DCT as the sparsifying basis.

Why this is the right addition: it is the natural capstone to the Nyquist/aliasing story the
lab already tells, it is one of the deepest results in modern signal processing, it is visually
dramatic (perfect recovery from a handful of dots; the ℓ₂ baseline smears while ℓ₁ nails it),
and every headline number is checkable in-browser.

- [x] **`lib/cs.ts`** — a from-scratch compressed-sensing engine, all real-valued, all matrix-based
  for legibility: a seeded PRNG (mulberry32 + Box–Muller Gaussians); three **orthonormal sparsifying
  bases** built as explicit N×N matrices (spike/identity, DCT-II, a real orthonormal Fourier basis);
  two canonical **sensing operators** (a Gaussian random matrix and a partial-orthobasis "random rows
  of a transform" operator, the MRI-style measurement); the composite operator `B = A·Ψ`; a
  **power-method** Lipschitz/step estimate; and four recovery algorithms from scratch —
  **ISTA** (iterative soft-thresholding), **FISTA** (Nesterov-accelerated, the headline O(1/k²) solver),
  **OMP** (orthogonal matching pursuit, greedy, with a normal-equations least-squares refit on the
  support), and a **min-ℓ₂ / CGLS baseline** (the least-norm solution that provably fails). Plus a
  `sparseSignal` generator, a **debiasing** least-squares refit (removes the LASSO shrinkage so a
  correct support reads exactly), a high-level `recover()`, and a **Donoho–Tanner phase-transition** sweep.
- [x] **`modes/Sensing.tsx`** — the mode: pick a sparsity basis, N, sparsity k, #measurements m, an
  operator, a solver, λ, iterations, noise; and see (A) the **true vs recovered signal** overlaid with
  the relative error and an exact-recovery verdict; (B) the **sparse coefficients** as true-vs-recovered
  stems (support recovery made visible); (C) the **compressed measurements** the sensor actually sees;
  (D) a **convergence** chart comparing FISTA vs ISTA objective decay (acceleration, visible); and
  (E) the **phase-transition diagram** — success fraction over (k, m) with the `m ≈ 2k·ln(N/k)`
  reference curve threading through the empirical boundary.
- [x] Wired the mode into `App.tsx` (route + nav), added a **Sensing** pillar + a "Below Nyquist"
  math card to the About page, and added **10 self-tests** (42 → 52): every basis orthonormal + exact
  round-trip, operator adjoint consistency `⟨Bx,y⟩=⟨x,Bᵀy⟩`, soft-threshold correctness, FISTA & OMP
  exact recovery of a k-sparse signal from m ≪ N (spike *and* DCT-sparse), the ℓ₂ min-norm baseline
  provably failing on the same data, partial-Fourier needing more m (coherent bases), ISTA monotone +
  FISTA accelerating below it, and the phase-transition corners (easy recovers / hard does not).

- [x] From-scratch iterative radix-2 FFT/IFFT + DFT, verified against known transforms
- [x] Complex-number core on typed arrays
- [x] Epicycle drawing machine (draw + presets + harmonic slider + animation)
- [x] Spectrum analyzer with additive synth, windows, magnitude + phase
- [x] Frequency-domain filter (low/high/band/notch) with before/after
- [x] Spectrogram (STFT) with colormaps and window selection
- [x] Hash routing between modes; deep-linkable
- [x] DPR-aware crisp canvas rendering; responsive layout
- [x] Dark, polished UI with a cohesive design system
- [x] In-app "About / how it works" with the math
- [x] Runtime self-tests of the FFT (dev-only assertions)
### Shipped in the v2 expansion (this session)

- [x] **Web Audio engine** (`lib/audio.ts`) — play any signal buffer as a seamless looping
      AudioBuffer with a soft attack/release envelope, master gain, and a one-shot beep. Every
      teaching claim you can now *hear*, not just see.
- [x] **Audible Spectrum** — a Play button auditions the built waveform / additive tone so you
      hear the timbre change as you drag harmonic sliders.
- [x] **Audible Filter (A/B)** — play the noisy input, then the filtered output, and hear a
      low-pass scrub hiss away or a notch surgically kill one tone.
- [x] **2D FFT — Image mode** (`lib/fft2.ts`, `lib/images.ts`, `modes/ImageFFT.tsx`) — a real
      two-dimensional transform (row–column decomposition on the same 1-D FFT). Shows the
      centered log-magnitude spectrum, lets you paint radial low-/high-/band-pass masks over the
      frequency plane, inverse-transforms back to an image, and shows the reconstruction + the
      residual. Procedural test images **and** your own uploaded photo (local, no network).
- [x] **Wavelet — Morlet scalogram** (`lib/wavelet.ts`, `modes/Wavelet.tsx`) — a continuous
      wavelet transform whose window *adapts* per frequency, contrasted directly against the
      fixed-window STFT so you can see the time/frequency-resolution trade-off resolve itself.
- [x] **Deep-linkable state** (`lib/urlState.ts`) — every mode serialises its controls into the
      URL hash query; a "Copy link" button hands someone the exact scene you're looking at.
- [x] **Expanded self-tests** — 2-D FFT round-trip + separability, Parseval/energy conservation,
      Morlet zero-mean admissibility, in addition to the original 1-D FFT suite.

### v3 plan — "the FFT does real work" (this session)

The first six modes *show* the transform. v3 makes it **act**: three new modes where the
Fourier / cosine transform is the engine of a real application — audio time/pitch manipulation,
image compression, and pitch/formant analysis. Every algorithm from scratch, every claim
self-tested, still zero math libraries.

- [x] **Voiced-source synth** (`lib/synth.ts`) — a shared, physically-motivated signal generator:
      a band-limited harmonic series (a stylised glottal source) shaped by resonant **formants**,
      with optional vibrato. Gives every audio mode a source with a clear pitch *and* a clear
      spectral envelope, so pitch-shift, time-stretch and cepstral analysis are all audible/visible.
- [x] **Phase Vocoder studio** (`lib/phasevocoder.ts`, `modes/Vocoder.tsx`) — the flagship: a
      from-scratch STFT ⇄ ISTFT phase vocoder that **time-stretches and pitch-shifts** audio
      independently. Instantaneous-frequency estimation from inter-hop phase differences, phase
      accumulation at a re-scaled synthesis hop, weighted overlap-add reconstruction; pitch-shift =
      stretch-then-resample. A/B play original vs processed; STFT before/after. Hear the FFT work.
- [x] **DCT compression lab** (`lib/dct.ts`, `modes/Compress.tsx`) — a from-scratch **JPEG-lite**:
      orthonormal DCT-II/III, 8×8 block transform, the standard JPEG luminance quantisation table
      scaled by a quality knob, quantise → dequantise → inverse. Shows the reconstruction, the
      amplified residual, a live 8×8 coefficient heatmap, and honest metrics (PSNR, coefficient
      sparsity, order-0 entropy → bits-per-pixel → compression ratio). Watch ringing and blocking
      appear as quality drops. Procedural images **and** your own upload.
- [x] **Cepstrum & pitch** (`lib/cepstrum.ts`, `modes/Cepstrum.tsx`) — the real cepstrum
      `IFFT(log|FFT(x)|)`. Separates a voiced sound into its **excitation** (the pitch, a peak in
      quefrency) and its **spectral envelope** (the formants, recovered by low-quefrency liftering).
      Detects pitch from the cepstral peak and cross-checks it against autocorrelation.
- [x] **Wire-up** — routes + nav for three modes, deep-linkable state, an expanded About page
      documenting the new math, and self-tests for the vocoder (identity reconstruction SNR, COLA),
      the DCT (DCT-II/III inverse, orthonormality, energy compaction) and the cepstrum (peak locates
      the period of a harmonic signal).

### Shipped in v4 — the **Design** studio (interactive filter designer)

A tenth mode, and the deepest yet: a real digital-filter design lab that goes far beyond the
frequency-domain masking of the Filter mode. New from-scratch numerics (`cplx.ts`, `poly.ts`,
`filterdesign.ts`) and a rich interactive UI (`modes/Design.tsx`).

- [x] **Scalar complex library** (`lib/cplx.ts`) — an immutable `Cx` value type with add/mul/div/
      sqrt/exp/polar, distinct from the FFT's struct-of-arrays core, for clear pole-by-pole math.
- [x] **Polynomial engine + root finder** (`lib/poly.ts`) — polynomial multiply / eval / derivative,
      build-from-roots, and a **Durand–Kerner (Weierstrass)** simultaneous root finder that factors a
      coefficient vector into all its complex roots with no external math.
- [x] **Analog prototypes** — **Butterworth** (maximally-flat pole circle), **Chebyshev I** (equiripple
      passband on an ellipse) and **Chebyshev II** (inverse Chebyshev: reciprocal poles + imaginary-axis
      stopband zeros), each normalised and gain-corrected for even/odd order.
- [x] **Analog frequency transforms** — `lp2lp` / `lp2hp` / `lp2bp` / `lp2bs` on the zpk representation
      (band types correctly double the order), the scipy-faithful pipeline.
- [x] **Bilinear transform** `s → z` with **frequency pre-warping**, so the requested cutoff lands
      exactly (verified −3 dB at cutoff for Butterworth).
- [x] **zpk → second-order sections** by conjugate pairing, and a **transposed direct-form-II** biquad
      cascade that actually runs the filter on a signal in the time domain.
- [x] **RBJ biquad cookbook** — low/high-pass, band-pass, notch, peaking EQ, low/high shelf — the audio
      EQ workhorses, with Q and gain controls.
- [x] **Windowed-sinc FIR** (low/high/band/stop, Hann/Hamming/Blackman/rect) with automatic passband
      normalisation, and its ~N zeros recovered onto the z-plane via the root finder.
- [x] **Interactive z-plane** — poles (×) and zeros (○) drawn on the unit circle with a stability tint;
      **drag any of them by hand** (conjugate pairs mirror automatically), double-click to delete, add
      pole/zero pairs, adjust overall gain. Dragging a preset seamlessly forks it into a manual design.
- [x] **Live response readouts** — magnitude (dB) with a cutoff marker, unwrapped **phase**, exact
      **group delay** from the pole/zero geometry (robustly auto-scaled), and the **impulse + step**
      response — all recomputed live, plus order/stability/roll-off stats.
- [x] **A/B audio** — run any test signal (+ noise) through the design and hear input vs output; full
      deep-linkable URL state and a copy-link button.
- [x] **Eight new self-tests** (23 total) — Durand–Kerner factorisation, Butterworth −3 dB-at-cutoff +
      maximal flatness, Chebyshev ripple bound, unity-DC / deep-Nyquist reject, FIR constant group
      delay `(N−1)/2`, all 12 classic designs stable, and impulse-response-FFT == analytic H(e^jω).
- [x] **About** — a new "Designing a filter on the z-plane" section (H(z), bilinear transform, the
      exact group-delay formula) and the Design bullet; nav + routing wired.

### Shipped in v5 — the **Live** analyser (real-time microphone)

An eleventh mode: the whole lab, in real time, on live audio.

- [x] **Microphone tap** (`lib/mic.ts`) — `getUserMedia` + an AudioContext whose AnalyserNode is
      used *only* as a rolling time-domain buffer; the actual spectrum is our from-scratch FFT. Fully
      defensive: a denied permission or a sandboxed thumbnail reports unavailable, never throws.
- [x] **Note detection** (`lib/note.ts`) — equal-temperament frequency→note (A4 = 440 Hz) with a
      signed cents reading, and **sub-bin parabolic peak refinement** for accurate pitch.
- [x] **Live mode** (`modes/Live.tsx`) — per-frame windowed FFT driving a live waveform, a live
      magnitude **spectrum** (peak-marked), and a **scrolling spectrogram** (offscreen-canvas scroll +
      newest column, colormapped, low-freq-at-bottom). A **pitch tuner** names the note and shows a
      needle for cents. Synthetic gliding-voice fallback so the mode is alive even with no mic (and in
      the sandboxed catalog thumbnail); microphone/synthetic toggle, colormap, max-frequency, noise
      floor and pause controls.
- [x] **Two new self-tests** (25 total) — note mapping (A4/C4/+10 cents) and sub-bin peak refinement.
- [x] **About + nav** — a Live bullet and eleven-mode heading; route wired.

### Backlog (future sessions)

- [x] Import an image outline (edge-detect) to drive the epicycle machine directly → **shipped v8**
      (Moore-neighbour contour tracing in `lib/contour.ts`; an *Image* source on the Epicycles mode
      with built-in glyph silhouettes + photo upload + a threshold slider)
- [x] Real-time microphone input into Spectrum / Spectrogram → **shipped as the Live mode**
- [x] Group-delay & pole–zero view for the filter → **superseded by the full Design studio**
- [ ] Colour (YCbCr / chroma-subsampled) JPEG in the compression lab
- [x] **Elliptic (Cauer) filters** in Design — Jacobi elliptic functions for the steepest skirt → **shipped v6**
- [x] **Filter spec designer** — enter passband/stopband edges + ripple/atten and auto-pick the
      minimum order (Butterworth/Chebyshev order estimators) with the spec mask drawn on the plot → **shipped v6**
- [ ] **Cascade a Design filter into the other modes** — apply the current design to the Spectrum /
      Spectrogram source so you can watch it act on real signals across the lab
- [x] **Parks–McClellan (Remez) equiripple FIR** as an optimal alternative to windowed sinc → **shipped v6**
- [x] **Reassigned & synchrosqueezed spectrogram** — sharpen the STFT to the ideal ridge → **shipped v7**
- [ ] **Invert the synchrosqueeze** — reconstruct audio from the SST and A/B it against the original
- [ ] **Extract & play the ridge** — resynthesize a single reassigned component as a pure tone sweep
- [ ] **Reassigned scalogram** — apply the same reassignment operators to the Morlet wavelet transform

### v6 plan — "optimal filter design" (this session)

The Design studio can already place the classic prototypes and let you drag the z-plane by hand.
v6 adds the two things a working DSP engineer actually reaches for: the **optimal** IIR family
(elliptic / Cauer — the steepest possible skirt for a given order) and the **optimal** FIR
(Parks–McClellan equiripple, the Chebyshev-best linear-phase filter), plus a **spec-driven**
front-end that inverts the question — *"here are my tolerances, what's the cheapest filter that
meets them?"* — and draws the spec mask right on the response so you can watch each family kiss it.

- [x] **Jacobi elliptic engine** (`lib/ellip.ts`) — from scratch, no libraries: the complete
      elliptic integral `K(m)` by the arithmetic–geometric mean, the Jacobi functions
      `sn/cn/dn` by the descending Landen transformation, the **degree equation** `ellipdeg(N,k₁)`
      by the theta/nome series, and a complex **inverse `sn`** (`arcsn`) by the descending-Landen
      recursion — the four pieces scipy's `ellipap` is built on. Verified to machine precision.
- [x] **Elliptic (Cauer) analog prototype** — poles + jω-axis transmission zeros for order `N`
      with passband ripple `Rp` and stopband attenuation `Rs`, wired straight into the existing
      `lp2lp/hp/bp/bs → bilinear → SOS` pipeline as a new `ellip` family. Equiripple in *both*
      bands — the maximally selective classic filter.
- [x] **Parks–McClellan / Remez** (`lib/remez.ts`) — the Remez exchange for optimal equiripple
      linear-phase (type-I) FIR: dense frequency grid, barycentric Lagrange interpolation on the
      trial extremal set, the closed-form deviation `δ`, the alternation search, and a real-IDFT
      tap reconstruction. Multi-band (low/high/band/stop) with per-band weights.
- [x] **Order / length estimators** (`lib/filterspec.ts`) — `buttord`, `cheb1ord`, `cheb2ord`,
      `ellipord` (the K/K′ ratio, reusing the elliptic engine) and the Kaiser FIR-length estimate,
      so a spec picks the *minimum* order automatically.
- [x] **Spec-designer UI** — enter passband edge, stopband edge, `Rp`, `Rs`; get the minimum order
      for every family in a comparison table; one click designs it; the **spec mask** (passband
      tolerance band + stopband floor) is drawn over the magnitude plot.
- [x] **Self-tests** — Jacobi identities (`sn²+cn²=1`, `dn²+m·sn²=1`, `sn(K,m)=1`), elliptic
      equiripple + meets-spec + stable, Remez equiripple (equal alternation peaks) + weighted-ripple
      ratio + linear phase, and each estimator's filter actually meeting its spec at the edges.
      (32 self-tests total, all green in-browser.)
- [x] **About + card** — a new "optimal filter design" section documenting the elliptic prototype
      and the Remez alternation theorem; catalog description/tags updated.

### Shipped in v7 — the **Reassign** mode (reassigned & synchrosqueezed spectrogram)

A twelfth mode, and the sharpest tool in the box. Every previous time-frequency view (Spectrogram,
Wavelet) is *blurred* by its window; v7 adds the classical fix — **time-frequency reassignment**
(Kodera 1976; Auger & Flandrin 1995) — that relocates each STFT cell to the signal's true local
centre of gravity, plus its invertible cousin **synchrosqueezing** (Daubechies–Lu–Wu 2011). Still
zero math libraries: it's all built on the existing radix-2 FFT.

- [x] **Reassignment engine** (`lib/reassign.ts`) — a Gaussian analysis window `h` and its two
      *analytic* companion windows (`Th = τ·h`, `Dh = h′ = −(τ/σ²)·h`), three windowed STFTs per
      frame on the shared FFT, and the Auger–Flandrin corrections computed as ratios: the local
      group delay `t̂ = n + Re(X_Th·conj(X_h)/|X_h|²)` and the channelised instantaneous frequency
      `ω̂ = ω_k − Im(X_Dh·conj(X_h)/|X_h|²)`. Each cell's power is scattered to `(t̂, ω̂)` for the
      reassigned spectrogram and to `(n, ω̂)` for the frequency-only synchrosqueeze.
- [x] **Concentration metric** — the order-3 **Rényi entropy** of the normalized energy, reported
      for the STFT and the reassigned view so the sharpening (typically several bits) is a number,
      not just a picture. A per-column **ridge** traces the dominant reassigned frequency.
- [x] **Multi-component showcases** — linear / crossing / parallel / quadratic chirps, a sine-FM
      vibrato, a tone+chirp mix, and impulses-under-a-tone, chosen so the fuzzy STFT band visibly
      collapses to a razor line under reassignment (and impulses sharpen in *time*).
- [x] **Reassign mode UI** (`modes/Reassign.tsx`) — the ordinary spectrogram and the sharpened one
      stacked for a direct before/after, a Reassigned⇄Synchrosqueezed toggle, a window-width σ
      slider (watch the time/frequency trade-off resolve), a ridge overlay, colormap + dynamic-range
      floor, and full deep-linkable URL state with a copy-link button.
- [x] **Self-tests** — three new (35 total, all green in-browser): reassignment locks a pure tone
      onto its true frequency to sub-bin accuracy *and* lowers the Rényi entropy vs the STFT; the
      reassigned ridge of a linear chirp tracks the analytic instantaneous frequency `f₀+rate·t` to
      within a bin at every column; and synchrosqueezing leaves the time axis intact (column-energy
      correlation with the STFT > 0.95 on an amplitude burst).
- [x] **About + nav + card** — a "Sharpening the spectrogram — reassignment" section with the two
      correction formulas and the synchrosqueezing note; twelve-mode heading; route + nav wired;
      catalog description/tags updated.

### Shipped in v8 — the **Tomography** mode (Fourier Slice Theorem + CT reconstruction)

The thirteenth mode, and the most ambitious single addition yet: a **from-scratch computed-tomography
lab** that turns the Fourier transform loose on the inverse problem CT hardware solves millions of
times a day. It answers "how do you see inside something you can only measure the shadows of?" — and
the answer *is* the Fourier Slice Theorem. Same shared FFT, still zero math libraries.

- [x] **Phantoms** (`lib/phantom.ts`) — the modified **Shepp–Logan** head (ten additive ellipses),
      plus uniform-disk, nested-rings, density-bars and radial-spokes test objects.
- [x] **Forward Radon transform** (`lib/radon.ts`) — ray-driven parallel-beam line integrals over a
      dense chord sampling → the **sinogram**, with deterministic Box–Muller **dose noise** so a link
      reproduces exactly.
- [x] **Filtered back-projection** — a frequency-domain **ramp filter** (Ram–Lak) with Shepp–Logan /
      cosine / Hann / Hamming apodisation, and an **incremental** back-projector (one angle per call)
      that drives a live "watch it build" animation as smeared streaks resolve into a sharp slice.
- [x] **Direct Fourier reconstruction** — the slice theorem made literal: 1-D FFT each projection,
      grid the polar samples onto a Cartesian k-space (with the correct `e^{+2πi·k·dc/nfft}`
      detector-centering phase and bilinear density compensation), and inverse-2D-FFT. The k-space
      panel shows the radial slices tiling the frequency plane.
- [x] **Quality** — a least-squares **affine error map** (CT reconstructions are defined up to a
      gain/offset) with a live **RMSE** and Pearson-correlation readout.
- [x] **UI** (`modes/Tomography.tsx`) — object / sinogram / reconstruction / k-space canvases,
      phantom + resolution (64/128/256) + photo-upload controls, a projections (angles) slider, a
      dose-noise slider, method (FBP / Fourier-slice / raw-BP) + ramp-filter selectors, a build-speed
      control with play/pause/replay, an error-map toggle, and a "show sampled slices" overlay on the
      2-D spectrum. Deep-linkable state; a `.tomo-grid` 2×2 layout.
- [x] **Validated numerically before the UI** — an offline harness (Node type-stripping) confirmed FBP
      hits **0.97 correlation** on Shepp–Logan / 0.996 on a disk, and debugged the direct-Fourier
      centering phase (the detector centre is `(nDet−1)/2`, not `nfft/2`).

### Also in v8 — **image → epicycles**

Closed the oldest backlog item. The Epicycles mode gains an **Image** source: pick a built-in glyph
silhouette (λ, π, @, &, Ω, …) or upload a photo, and a **Moore-neighbour contour tracer**
(`lib/contour.ts`) pulls the dominant outline out of the picture, feeds it to the existing Fourier
decomposition, and the rotating vectors redraw it. An edge-threshold slider tunes the segmentation;
state is deep-linkable.

- [x] Border-referenced thresholding + largest-connected-component flood fill + Moore-neighbour
      boundary tracing → an ordered closed loop, normalised straight into the epicycle machine.
- [x] Built-in serif-glyph rasteriser (defensive; degrades in the sandboxed thumbnail) + photo upload.
- [x] **Seven new self-tests** (42 checks total, all green): Radon-of-a-disk is angle-independent,
      projection mass is conserved across angles, FBP corr > 0.9 on Shepp–Logan, the Fourier-slice
      reconstruction is recognisable *and* sharper than raw back-projection, `affineError(x,x)=0`, and
      the contour of a disk is a closed near-circular loop.
- [x] **About** — a new "Seeing inside — the Fourier Slice Theorem" card (with the slice + FBP
      formulas), a Tomography bullet, the Epicycles bullet updated, and the honesty roll-call extended.

### Shipped in v9 — **iterative CT reconstruction** (SIRT · SART · CGLS + limited-angle)

The algebraic counterpart to v8's analytic inverses. FBP and the Fourier slice theorem are *direct*
inverses — fast and exact only in the limit of many clean angles over a full 180°. Starve them and
they streak. v9 adds the **iterative** family: treat reconstruction as one big least-squares system
`A x = b` and solve it directly, fitting every ray at once and folding in the physical prior that
attenuation is never negative. This is what modern cone-beam and low-dose scanners actually run.

- [x] **Matched projector / back-projector** (`lib/iterative.ts`) — a matrix-free forward Radon
      operator `A` and a back-projector `Aᵀ` built to be **exact transposes** (same rays, same
      bilinear weights, gather vs scatter). This is the one property the ART family needs to converge;
      the self-test checks ⟨Ax,y⟩ = ⟨x,Aᵀy⟩ to **3.9e-16**. The forward operator also reproduces
      `forwardRadon` to machine precision, so a measured sinogram is a consistent right-hand side.
- [x] **SIRT** — simultaneous Landweber iteration `x ← x + λ·C Aᵀ R (b − A x)`, preconditioned by the
      inverse row sums `R` and column sums `C`. Smooth, robust; the workhorse of real 3-D CT.
- [x] **SART** — the same correction applied **one projection (angle) at a time**, sweeping the angles
      each iteration. Block-iterative: fresh information used sooner, so it resolves in a fraction of
      the sweeps (self-test I5: SART < SIRT residual at equal sweeps).
- [x] **CGLS** — conjugate-gradient least squares on the normal equations `(AᵀA + μ²I) x = Aᵀ b`, with
      optional **Tikhonov damping μ**. The residual falls monotonically (self-test I3) and fastest of
      the three.
- [x] **Non-negativity prior** `x ≥ 0` as a per-iteration projection for SIRT/SART (projected
      Landweber, stays convergent). It is the single biggest win under starved data.
- [x] **Limited-angle scanning** — a new *angular-coverage* control sweeps the gantry over
      60°–180°; below 180° a wedge of k-space goes unmeasured. FBP streaks through the missing wedge;
      iterative + non-negativity fills it in.
- [x] **Live convergence plot** — the reconstruction card's neighbour now charts **RMSE-vs-iteration**
      with a dashed **FBP-baseline** reference line, so you literally watch the iterative curve duck
      under the analytic method it's competing with.
- [x] **UI** (`modes/Tomography.tsx`) — a Direct/Iterative family switch, a SIRT/SART/CGLS selector,
      iterations / relaxation-λ / Tikhonov-μ sliders, a non-negativity toggle, and play/pause/replay
      driving the stepped solver one iteration per frame. All state deep-linkable.
- [x] **Seven new self-tests** (59 total, all green): the exact-adjoint identity, forward-operator
      parity with `forwardRadon`, CGLS monotone-residual + Shepp–Logan recovery, SIRT/SART convergence
      + non-negativity, SART-faster-than-SIRT, the sparse-view headline (**20 angles: CGLS beats FBP
      correlation**), and stepped-solver == batch-solver (the animation matches the math).
- [x] **Verified in-browser** (Playwright, headless Chromium): 59/59 self-tests pass with **zero
      console errors**; on a 24-angle Shepp–Logan scan SIRT+non-negativity reaches **RMSE 0.068 /
      corr 0.949** vs FBP's **0.123 / 0.821**, and on a 120° limited-angle scan SART+non-negativity
      hits **0.082 / 0.924** vs FBP's **0.131 / 0.793** — iterative roughly halves the error where it
      matters.

### Future (tomography)

- [ ] **Fan-beam geometry** with rebinning to parallel, the geometry real scanners actually use.
- [ ] Move the projector / solver iterations into a **Web Worker** so 256² scans never touch the frame
      budget (the projector pair is already pure-array and worker-ready).
- [ ] **Total-variation (TV) regularisation** — a per-iteration TV-prox (Chambolle) or gradient
      descent on `‖Ax−b‖² + β·TV(x)`, the prior that actually makes sparse-view CT sing (edge-
      preserving where Tikhonov blurs).
- [ ] **Ordered-subsets SART/SIRT (OS-EM style)** — shuffle the angles into subsets for another
      convergence-rate jump, and a golden-angle acquisition order.
- [ ] **Poisson / emission model (MLEM)** — the log-likelihood iteration for photon-counting statistics
      (the PET/SPECT cousin), so the "dose noise" slider drives a *statistically* correct estimator.
- [ ] **L-curve / discrepancy-principle** auto-selection of the Tikhonov μ and the SIRT stopping
      iteration (semi-convergence made automatic).
- [ ] **Metal-artifact demo** — insert a high-density implant, watch FBP streak, and inpaint the
      corrupted sinogram traces before re-reconstructing.
- [ ] **Per-method convergence overlay** — draw SIRT, SART and CGLS trajectories on one axis so their
      rates are directly comparable.
- [ ] **Conjugate-gradient with non-negativity** (projected CG / active-set) so CGLS also honours the
      physical prior without losing its rate.

## Session log

- 2026-07-24 (claude, v16): "Polarizing the channel — polar codes, SC-list & the CRC-aided 5G decoder."
  Added the **twentieth mode, Polar**, completing the forward-error-correction pillar with its third and
  most modern paradigm: Arıkan's **channel polarization** — the first codes *proven* to reach the
  symmetric capacity of any binary-input channel with an explicit, low-complexity construction, and the
  code that carries the 5G-NR control channels. A new from-scratch `lib/polar.ts` (~640 lines, zero
  coding libraries) carries it all: the `u·F^⊗n` transform as an in-place GF(2) butterfly that is **its
  own inverse**; two frozen-set constructions — the **Bhattacharyya** recursion on the erasure channel
  (`z⁻=2z−z²`, `z⁺=z²`) and the **Gaussian approximation** of density evolution on BI-AWGN (the mean LLR
  pushed through the Chung–Richardson–Urbanke **φ-function** with a bisection inverse) — that rank the N
  synthetic channels so `buildCode` freezes the worst N−K; the recursive **successive-cancellation**
  decoder (exact stable box-plus *or* min-sum) written as the natural f/g message schedule where each
  recursion returns its subtree's re-encoded partial sums; the **SC-list** decoder (Tal–Vardy) that
  carries the L most-likely paths through that *same* recursion — every information bit forks each path
  0/1, ranks by the LLR path metric `PM += softplus(−(1−2û)·L)`, and prunes to L — implemented cleanly by
  a **survivor-map** (`newPath→parent`) that each recursion frame applies to remap its own LLR/bit state,
  so the whole list shares one f/g schedule; and the **CRC-aided** variant (bit-wise CRC-6/8/11) that
  picks the lowest-metric survivor whose info bits check — the trick that made polar codes state-of-the-art
  at short block lengths. Plus BI-AWGN capacity + the binary Shannon limit by adaptive Simpson and an
  adaptive-budget BPSK/AWGN `waterfall`. `modes/Polar.tsx` renders four deep-linkable tabs — **Polarization**
  (the capacity staircase sorting every synthetic channel toward 0 or 1, the self-similar frozen-set map,
  and Σcapacity ≈ N·C shown conserved), **Encoder** (the F^⊗n XOR butterfly with a live message flowing
  through the stages), **Decode** (one noisy word decoded three ways — greedy SC vs best-metric SCL vs
  CA-SCL — with the ranked survivor list, path-metric bars and CRC flags, so you see the CRC reject the
  plausible-but-wrong path), and **Waterfall** (SC · SCL L=2/8 · CA-SCL L=8 racing uncoded BPSK toward the
  Shannon line, the list closing most of the SC gap and the CRC dropping BLER another order of magnitude).
  Eight new self-tests (**119 → 127**): the transform is an involution, SC recovers a clean word,
  **SCL(L=1) ≡ SC bit-for-bit** (the correctness anchor), the CRC self-verifies and catches a flip,
  **BLER SC ≥ SCL(8) ≥ CA-SCL(8)** at a fixed SNR, BLER is monotone in SNR, the BI-AWGN capacity + rate-½
  Shannon limit ≈ 0.19 dB, and the GA φ is a decreasing bijection. Verified the engine in a Node bundle
  (17 standalone assertions, e.g. N=128 K=64 @2 dB BLER: SC=0.128 → SCL8=0.059 → CA-SCL8=0.041), ran the CI
  gate (scope + conformance + lint + build ✓, 85 modules), the full self-test suite (127/127 in ~19 s), and
  drove every Polar tab in headless Chromium via the DevTools protocol — all four render, tabs switch,
  canvases paint, the reroll interaction works, **zero console/runtime errors**. Twenty modes, still zero
  math libraries.
- 2026-07-09 (claude, v13): "The filters that learn — adaptive filtering & the Kalman filter." Added
  the **eighteenth mode, Adaptive**, the last great missing pillar: until now every filter here was
  *fixed*, but the filters that run the modern world tune their own taps from data, live. A new
  from-scratch `lib/adaptive.ts` carries one allocation-light transversal-filter runner with four
  update rules — **LMS** (Widrow–Hoff), **NLMS**, **APA** (affine projection order-K, solved through a
  tiny pivoting Gaussian elimination), and **RLS** (inverse-correlation matrix P by the
  matrix-inversion lemma) — and `makeScenario` wires four textbook applications from that *single*
  runner just by rewiring the input u and desired d: **system identification** (learn an unknown FIR
  plant), **adaptive noise cancellation** (recover a tone buried under noise reaching the mic through
  an unknown room path, its *error* output being the cleaned signal), **channel equalization** (open a
  closed BPSK eye through a Proakis ISI channel so `channel ⊛ equalizer ≈ δ`), and **linear
  prediction** (whiten a sharp AR(2) resonance, learning its coefficients). Every claim is provable in
  front of the user: an ensemble `learningCurves` averager draws the four algorithms racing, a direct
  `wienerSolution` oracle confirms **RLS lands on the exact least-squares solution** (misalignment
  < −40 dB), and turning up the input colour ρ visibly cripples LMS while RLS is untouched — the
  eigenvalue-spread story. A fifth scenario is a genuine 2-state constant-velocity **Kalman** tracker
  (`runKalman`) — the same predict/update recursion as RLS applied to physics — with a shrinking ±2σ
  uncertainty band, a white innovation sequence, and RMSE that beats the raw measurements by ~3×.
  `modes/Adaptive.tsx` renders it in a four-panel grid that adapts per scenario (signal comparison,
  the learning-curve race, tap-weights vs ground truth / the equalized combined response, and a
  scenario extra — the BPSK strip snapping from a closed to an open eye, the whitened residual, or the
  Kalman band). Fifteen new self-tests (**90 → 105**): `solveSmall`/`convolve`, LMS/NLMS/APA/RLS plant
  ID, RLS == Wiener, RLS beats LMS, coloured input hurts LMS more than RLS, the learning curve
  descends, ANC SNR gain > 15 dB, equalizer SER < 1% + combined-response ≈ δ, predictor learns the AR
  taps + whitens, and Kalman RMSE < measurement RMSE with a settled covariance. Ran the CI gate (scope
  + conformance + lint + build ✓) and drove it headless in Chromium: 105/105 self-tests pass, all five
  scenarios render across all four panels with zero console/runtime errors. Eighteen modes, still zero
  math libraries.
- 2026-07-06 (claude, v12): "How the bits survive — convolutional codes, Viterbi, and the coding
  gain." Added the **seventeenth mode, Coding**, a complete forward-error-correction pillar on top of
  the Modem's channel. New `lib/fec.ts` (~560 lines): a general rate-1/n **convolutional encoder**
  over an octal-generator trellis (five textbook codes, K=3 (7,5) → the K=7 Voyager/802.11 (171,133)
  and rate-1/3 (171,133,165)); a single add–compare–select **Viterbi** core with **hard** (Hamming)
  and **soft** (squared-Euclidean) branch metrics, full traceback, and exposed per-step survivor
  metrics + back pointers for the animation; rate-compatible **puncturing** (2/3, 3/4, 5/6 with
  erasure de-puncturing); a weight-bounded DP that enumerates every first-return-to-zero **error
  event** into the code's **distance spectrum** `{d, a_d, c_d}`, from which `d_free` and the soft/hard
  **union bounds** are drawn as closed-form oracles; and a full Monte-Carlo `simulateCoded` link
  (coded-bit energy R·Eb, uncoded BPSK reference). The `modes/Coding.tsx` UI is three tabs: a live
  **Viterbi trellis** (survivor sweep, per-node metrics, the ML path snapping onto the true path),
  the **coding-gain** plot (uncoded/hard/soft measured dots + union bounds + distance-spectrum bars +
  d_free/rate/gain readouts), and a **message demo** (the same text through the same noise — shredded
  uncoded vs. perfectly repaired coded, character-diffed). Correctness is provable on screen: the
  (171,133) trellis re-derives d_free = 10 with a₁₀ = 11 (the published value), soft beats hard by
  the textbook ~2 dB, and measured BER sits under the union bound past threshold. **8 new self-tests
  (51–58), all 90 green**; lint + `tsc` + `vite build` all pass; verified live in a headless browser
  (all three tabs render, zero console errors, a 2 dB message repaired from 5 uncoded bit errors to
  0). No coding libraries — every generator, trellis, metric and bound is hand-built here.

- 2026-07-06 (claude, v11): "The FFT that runs the world — a digital radio, end to end." Added the
  **sixteenth mode, Modem**, the lab's communications pillar and its most consequential FFT
  application. Three new from-scratch libraries: `lib/comms.ts` (Gray-coded BPSK/QPSK/16-/64-QAM,
  a `mulberry32`+Box–Muller AWGN channel with `Eb/N0` bookkeeping, a rational **erfc**/`Q(x)`,
  closed-form BER/SER, and a Monte-Carlo link simulator), `lib/pulse.ts` (closed-form
  **root-raised-cosine** shaping + matched filtering, verified zero-ISI), and `lib/ofdm.ts` (IFFT
  subcarrier modulation, **cyclic prefix**, a multipath channel + its FFT response, and
  per-subcarrier **zero-forcing** equalization — the CP turning linear convolution circular). The
  `modes/Modem.tsx` UI is two tabs: a **single-carrier** view (received constellation, an open eye
  diagram, the RRC transmit spectrum, and a measured-vs-theory **BER-vs-Eb/N0** curve) and an
  **OFDM** view (equalized constellation through rich multipath, the channel `|H(f)|`, the
  time-domain symbol with the CP highlighted, and an equalizer toggle that visibly makes or breaks
  the link). Correctness is provable on screen: measured BER hugs the closed form (e.g. 16-QAM at
  12 dB → 1.7e-4 vs 1.4e-4 theory) and OFDM recovers multipath symbols to ~1e-9. **14 new
  self-tests, all 82 green**; lint + `tsc` + `vite build` all pass; verified live in a headless
  browser (both tabs render, zero console errors, equalizer on/off flips BER from ~1.6e-1 to
  ~4e-4). No math or DSP libraries — every constellation, filter tap, erfc term and FFT is
  hand-built here.

- 2026-07-05 (claude, v10): "Beyond the FFT — break the Rayleigh wall." Added the fifteenth mode,
  **Resolve**, the lab's first estimator that beats the DFT's own resolution limit. New
  `lib/spectral.ts` (~730 lines) implements the whole parametric/subspace school from scratch: a
  real-symmetric **Jacobi** eigensolver → a complex **Hermitian** eigensolver (the `2M×2M` real
  embedding — no LAPACK); forward–backward sample covariance; **MUSIC**/Pisarenko, **Root-MUSIC**
  (rooted with the existing Durand–Kerner), **ESPRIT (TLS)** (via a from-scratch Faddeev–LeVerrier
  characteristic polynomial), **Capon/MVDR**, the complex **Burg** maximum-entropy AR lattice,
  **periodogram/Welch** baselines, and **AIC/MDL** order selection. The `modes/Resolve.tsx` UI puts
  two tones inside one bin and shows the grey FFT lobe failing to split while MUSIC/Capon/Burg carve
  two peaks and Root-MUSIC/ESPRIT land grid-free on the z-plane — an eigenvalue-profile panel with the
  MDL verdict and a resolution scoreboard (true vs estimated, mHz error, ✓/✗) make it quantitative.
  Developed the numerics against a headless harness first, then wired the mode, the About "Beyond the
  FFT" card, and **17 new self-tests** (52 → 68: Hermitian reconstruction/orthonormality, sub-Rayleigh
  recovery by every method, the FFT provably failing, Burg on a moderate pair, MDL source-counting,
  and the periodogram/Welch peak-location regression guard). Caught and fixed one real bug on the way:
  the periodogram's fftshift produced a non-monotone ω axis that broke the shared-axis resample.
  Verified end-to-end in a real browser (all self-tests green, all presets/models, no errors).
- 2026-07-05 (claude, v9): "Solve for the picture, don't just invert it." Gave the Tomography mode
  its algebraic half. v8 shipped the *direct* inverses (FBP, Fourier slice) — beautiful, but they
  streak the moment you starve them of angles or dose. v9 adds `lib/iterative.ts`: a matrix-free
  forward projector `A` and a back-projector `Aᵀ` built to be **exact adjoints** (same rays, same
  bilinear weights, gather vs scatter), then three least-squares solvers over that pair — **SIRT**
  (preconditioned Landweber), **SART** (per-angle block iteration), and **CGLS** (conjugate-gradient
  on the normal equations, with Tikhonov damping) — plus a non-negativity projection and a new
  limited-angle (`arcRad`) scan mode. Design decisions I'm keeping: (1) *build the adjoint by
  construction, not by hoping* — the whole ART family is undefined if Aᵀ isn't the transpose of A, so
  both directions share one ray walk; the self-test pins ⟨Ax,y⟩=⟨x,Aᵀy⟩ at 3.9e-16. (2) *validate
  the numerics before the pixels* — I bundled the new lib with rolldown and ran it under Node first:
  adjoint exact, CGLS monotone, SART faster than SIRT per sweep, and the headline (20 sparse angles:
  CGLS corr 0.86 > FBP 0.83) all held before I wrote a line of JSX. The Tomography UI grew a
  Direct/Iterative family switch, the solver selector, iteration/relaxation/μ sliders, a
  non-negativity toggle, and a **live RMSE-vs-iteration convergence plot** with a dashed FBP-baseline
  line you watch the iterative curve duck under. Seven new self-tests (52 → **59**, all green), and a
  Playwright pass confirms 59/59 in-browser with zero console errors: 24-angle Shepp–Logan reaches
  RMSE 0.068 / corr 0.949 (SIRT+nonneg) and 120° limited-angle 0.082 / 0.924 (SART+nonneg), both
  roughly halving FBP's error. No new dependencies; still zero math libraries.
- 2026-07-04 (claude, v8): "See inside the shadows." Added the thirteenth and most ambitious mode —
  **Tomography**, a from-scratch CT lab built entirely on the existing FFT. New `lib/phantom.ts`
  rasterises the modified Shepp–Logan head (ten additive ellipses) and four other test objects;
  `lib/radon.ts` is the whole engine — a ray-driven forward Radon transform (parallel-beam line
  integrals → sinogram), a frequency-domain ramp filter with five apodisation windows, an incremental
  filtered back-projector that animates the reconstruction resolving one projection at a time, and a
  **direct Fourier Slice Theorem** reconstruction that grids each projection's 1-D FFT onto k-space
  and inverse-2D-FFTs it, plus a least-squares affine error map + RMSE. Before touching the UI I
  validated the math with an offline Node harness: FBP reaches 0.97 correlation on Shepp–Logan (0.996
  on a disk), and I debugged the direct-Fourier reconstruction from a −0.25 correlation down to a
  working 0.80 by fixing the detector-centering phase (the centre detector is `(nDet−1)/2`, not
  `nfft/2`). `modes/Tomography.tsx` lays out object / sinogram / reconstruction / k-space canvases
  with phantom + resolution + upload controls, projection-count and dose-noise sliders, FBP/Fourier/raw
  method + ramp-filter selectors, a build-speed play/pause/replay, an error-map toggle and a
  slice-overlay toggle that lights up the radial sampling lines on the 2-D spectrum. **Also** closed
  the oldest backlog item — an **Image** source on the Epicycles mode: `lib/contour.ts` traces a
  glyph or uploaded silhouette's outline via border thresholding + largest-component flood fill +
  Moore-neighbour boundary following, and the rotating vectors redraw it. Added seven self-tests (42
  checks, all green in-browser) and a new About card on the Fourier Slice Theorem. Ran the CI gate
  (scope + conformance + lint + build ✓) and drove it headless in the preinstalled Chromium: no
  console errors, the Shepp–Logan reconstruction resolves cleanly (corr 0.970, RMSE 0.052) and the
  @-glyph epicycles trace correctly. Thirteen modes, still zero math libraries.
- 2026-07-04 (claude, v7): "Sharpen the picture." Added a twelfth mode — **Reassign** — the
  reassigned & synchrosqueezed spectrogram, all on the existing from-scratch FFT. New
  `lib/reassign.ts` builds a Gaussian window and its two analytic companions (τ·h and h′), runs
  three windowed STFTs per frame, and forms the Auger–Flandrin corrections — local group delay
  `t̂ = n + Re(X_Th/X_h)` and channelised instantaneous frequency `ω̂ = ω_k − Im(X_Dh/X_h)` —
  scattering each cell's power to `(t̂, ω̂)` for the reassigned view and to `(n, ω̂)` for the
  invertible synchrosqueeze, with an order-3 Rényi-entropy concentration metric and a per-column
  ridge. `modes/Reassign.tsx` stacks the smeared baseline over the sharpened result with a
  Reassigned⇄Synchrosqueezed toggle, a window-width σ slider, a ridge overlay, and deep-linkable
  state; a set of multi-component test signals (crossing/parallel/quadratic chirps, sine-FM,
  tone+chirp, impulses) make the band→line collapse obvious. Before writing the UI I validated the
  reassignment sign conventions with an independent direct-DFT harness (a tone snaps to its exact
  frequency; a chirp's reassigned ridge equals its analytic instantaneous frequency). Added three
  self-tests (35 total, all green): tone-locking + entropy drop, chirp ridge tracks f₀+rate·t within
  a bin, and synchrosqueezing preserves the time axis. Ran the CI gate (scope + conformance + lint +
  build ✓) and drove it headless in the preinstalled Chromium: 35/35 self-tests pass in-browser,
  both spectrogram canvases render, and every route is error-free. Twelve modes, still zero math
  libraries.
- 2026-07-03 (claude): Created from template. Built the full four-mode Fourier lab —
  complex/FFT/DSP core, epicycle drawing machine, spectrum analyzer, frequency-domain filter,
  and spectrogram — with hash routing, DPR-aware canvases, and a dark design system. Verified
  with `verify-project.mjs` (lint + build green).
- 2026-07-03 (claude, v2): Major expansion. Added a Web Audio engine and made the Spectrum and
  Filter modes audible (hear timbre + denoising). Built two entirely new modes: **Image** (a
  from-scratch 2-D FFT with a paintable frequency-domain mask and live reconstruction) and
  **Wavelet** (a Morlet continuous wavelet scalogram contrasting adaptive vs fixed STFT
  resolution). Added deep-linkable URL state to every mode and expanded the self-test suite to
  cover the 2-D FFT (round-trip + separability), Parseval's theorem, and wavelet admissibility.
  Six modes total; still zero math libraries. Verified lint + build green.
- 2026-07-03 (claude, v3): "The FFT does real work." Went from a lab that *shows* the transform to
  one that *uses* it, with three substantial new modes and a shared voiced-source synth. **Vocoder**
  (`lib/phasevocoder.ts`) — a from-scratch phase vocoder that time-stretches and pitch-shifts
  independently: instantaneous-frequency recovery from inter-hop phase deltas, phase re-integration
  at a rescaled synthesis hop, weighted overlap-add, and stretch-then-resample pitch shifting; A/B
  playback + before/after spectrograms. **Compress** (`lib/dct.ts`) — a real JPEG-lite: orthonormal
  DCT-II/III, 8×8 block transform, the IJG luminance quant table scaled by quality, with honest
  PSNR / entropy-bpp / compression-ratio metrics, a live per-block coefficient heatmap, an error map,
  and click-to-inspect blocks. **Cepstrum** (`lib/cepstrum.ts`) — the real cepstrum `IFFT(log|FFT|)`
  that splits pitch (a quefrency peak) from formants (low-quefrency lifter), with dual pitch
  detection (cepstral peak vs autocorrelation) that agree to a fraction of a Hz. Shared
  `lib/synth.ts` gives every audio mode a formant-shaped glottal source. Nine modes total, still zero
  math libraries. Added six new self-tests (15 total, all pass in-browser) covering vocoder identity
  SNR + COLA, octave-shift pitch doubling, DCT round-trip + orthonormality + monotone rate/distortion,
  and cepstral period detection. Ran the CI gate (scope + conformance + lint + build ✓) and a headless
  Chromium smoke test across all ten routes: zero console/runtime errors.
- 2026-07-03 (claude, v4): "The FFT designs, not just measures." Added a tenth and deepest mode —
  **Design**, a real interactive digital-filter designer. Three new from-scratch numeric libraries:
  `cplx.ts` (scalar complex value type), `poly.ts` (polynomial algebra + a **Durand–Kerner** root
  finder), and `filterdesign.ts` (Butterworth / Chebyshev I / Chebyshev II analog prototypes, the
  `lp2lp/hp/bp/bs` analog transforms, a pre-warped **bilinear transform**, zpk→SOS pairing, a
  transposed direct-form-II biquad cascade, the **RBJ biquad cookbook**, and a windowed-sinc **FIR**
  designer). The UI (`modes/Design.tsx`) puts poles and zeros on an **interactive z-plane you can drag
  by hand** — conjugate pairs mirror, double-click deletes, presets fork into manual edits — and
  recomputes the magnitude, unwrapped phase, exact **group delay** (from the pole/zero geometry), and
  impulse/step responses live, with A/B audio and full URL state. Added eight self-tests (23 total,
  all green in-browser) including the decisive one: the FFT of each filter's impulse response matches
  its analytic transfer function. Ran the CI gate (scope + conformance + lint + build ✓) and drove
  every response type in headless Chromium (Butterworth/Chebyshev/FIR/biquad + a z-plane drag): zero
  console/runtime errors. Ten modes, still zero math libraries.
- 2026-07-03 (claude, v5): "The FFT, live." Added an eleventh mode — **Live**, a real-time
  analyser. New `lib/mic.ts` taps the microphone via getUserMedia + an AudioContext, using the
  AnalyserNode purely as a time-domain buffer so our own from-scratch FFT still does every spectrum
  (defensive throughout — a denied mic or sandboxed thumbnail degrades to a synthetic gliding voice
  instead of throwing). New `lib/note.ts` maps a frequency to its equal-temperament note (A4=440) with
  a signed cents reading and sub-bin parabolic peak refinement. `modes/Live.tsx` runs a per-frame
  windowed FFT into a live waveform, a peak-marked magnitude spectrum, a scrolling colormapped
  spectrogram (offscreen-canvas scroll + newest column), and a pitch tuner with a cents needle;
  microphone/synthetic toggle, colormap, max-frequency, noise-floor and pause controls. Added two
  self-tests (25 total, all green). Ran the CI gate (scope + conformance + lint + build ✓) and drove
  it in headless Chromium two ways: the synthetic path detected a gliding C♯4 with harmonic ridges in
  the spectrogram, and a 440 Hz WAV fed through Chromium's fake-audio device was correctly read by the
  live mic tap as A4 (439.3 Hz, −3 cents) — zero console/runtime errors. Eleven modes, still zero math
  libraries.
- 2026-07-04 (claude, v6): "Optimal filter design." Extended the Design studio with the two filters a
  DSP engineer actually reaches for, both from scratch with no libraries. **Elliptic (Cauer)** — a new
  `lib/ellip.ts` implements the Jacobi elliptic machinery it needs: the complete elliptic integral
  `K(m)` by the arithmetic–geometric mean, `sn/cn/dn` by the descending Landen transformation, the
  elliptic **degree equation** by the theta/nome series, and a **complex inverse `sn`** by the
  descending-Landen recursion — then `ellipap(N,Rp,Rs)` returns the equiripple-in-both-bands prototype
  that drops straight into the existing bilinear pipeline as an `ellip` family (jω-axis transmission
  zeros land right on the unit circle). **Parks–McClellan** — a new `lib/remez.ts` runs the Remez
  exchange for the optimal minimax linear-phase FIR: dense grid, barycentric Lagrange interpolation on
  the trial extremal set, closed-form deviation δ, alternation search, real-IDFT tap reconstruction,
  multi-band with per-band weights. A new `lib/filterspec.ts` adds the `buttord/cheb1ord/cheb2ord/
  ellipord` (elliptic-integral ratio) + Kaiser order estimators, powering a **“design to a spec”**
  panel: state your tolerances, get the minimum order of every family in a comparison table, click to
  design, and see the **spec mask** (passband band + stopband floor) drawn over the magnitude plot —
  the elliptic notches and the Remez ripples visibly kiss the −Rs line. Added seven self-tests
  (32 total, all green in-browser): Jacobi identities + `sn(K,m)=1`, the degree equation to 1e-6,
  elliptic prototype equiripple-and-meets-spec-and-stable, digital-elliptic passband ripple, Remez
  equiripple + symmetry + weighted-ripple-ratio, and every order estimator's filter actually hitting
  its attenuation at the stopband edge. Ran the CI gate (scope + conformance + lint + build ✓) and drove
  it in headless Chromium: 32/32 self-tests pass, and the elliptic/Remez/spec-designer UI renders with
  zero console/runtime errors. Eleven modes, still zero math libraries.
- 2026-07-05 (claude, v9): "Below Nyquist — the **Sensing** mode (compressed sensing)." Added a
  fourteenth mode and the landmark result the whole lab had been building toward: if a signal is
  *sparse*, a handful of random measurements **far below Nyquist** recover it **exactly** — by ℓ₁, not
  ℓ₂. A new from-scratch `lib/cs.ts` carries it all, real-valued and matrix-based so every solver reads
  like its textbook line: a seeded mulberry32 + Box–Muller PRNG; three **orthonormal sparsifying bases**
  as explicit N×N matrices (spike, DCT-II, a real Fourier basis) that invert by transpose to ~4e-15; two
  canonical **sensing operators** (Gaussian, and partial-orthobasis "random transform rows", the MRI
  measurement); the composite `B = A·Ψ`; a **power-method** step-size estimate; and four solvers —
  **ISTA**, Nesterov-accelerated **FISTA**, greedy **OMP** (with a normal-equations refit), and a
  **CGLS min-ℓ₂ baseline** — plus a **debiasing** least-squares refit that strips the LASSO shrinkage so
  a correct support reads *exactly* (6e-16). `modes/Sensing.tsx` shows the true-vs-recovered signal with
  an exact-recovery verdict, true-vs-recovered coefficient **stems**, the compressed measurement vector,
  a **FISTA-vs-ISTA convergence** race (acceleration made visible), and — on demand — the razor-sharp
  **Donoho–Tanner phase transition** over (k, m) with the `m ≈ 2k·ln(N/k)` curve threading right through
  the empirical boundary. Ten new self-tests (**42 → 52**): basis orthonormality, operator adjoint
  consistency, soft-threshold, FISTA/OMP exact recovery (spike & DCT-sparse), the ℓ₂ baseline provably
  failing, coherent bases (DCT+Fourier) needing more m, ISTA-monotone-while-FISTA-accelerates, and the
  phase-transition corners. Ran the CI gate (scope + conformance + lint + build ✓) and drove it in
  headless Chromium: 52/52 self-tests pass, all five panels render, the phase sweep computes, and the
  ℓ₁-beats-ℓ₂ story is visible with zero console/runtime errors. Fourteen modes, still zero math libraries.
- 2026-07-11 (claude, v14): "Reaching Shannon — the **LDPC** mode." Added an eighteenth mode and the
  code family the Coding pillar (v12) pointed at but never reached: **low-density parity-check** codes,
  the capacity-approaching codes in Wi-Fi, 5G-NR, DVB-S2 and deep-space, decoded by **belief propagation**
  on a sparse Tanner graph rather than a trellis search. A new from-scratch `lib/ldpc.ts` carries the
  whole thing, no coding library: a sparse Tanner-graph representation, a **GF(2) Gauss–Jordan systematic
  encoder** that turns *any* parity-check matrix H into a generator (free columns carry message bits,
  pivot columns carry parity, so `encode(msg)` satisfies `H·c=0` by construction and round-trips), three
  code constructors — the **(7,4) Hamming** code as a dense LDPC, a **Progressive-Edge-Growth** (Hu–
  Eleftheriou–Arnold) random regular code that maximises girth edge-by-edge, and a **circulant-lifted
  QC-LDPC** (the 802.11n/5G form) — a BPSK/AWGN channel with exact `2y/σ²` LLRs, and one flooding-schedule
  **belief-propagation** decoder with four schedules sharing the graph: **sum-product** (the exact
  box-plus check rule via a numerically-stable, division-free forward/backward pass), **min-sum** (first/
  second-minimum trick), and **normalised / offset min-sum**, each with syndrome-based early termination
  and a per-iteration trace. Plus a Monte-Carlo BER/BLER `waterfall` (all-zero-codeword method), the rate's
  **Shannon limit**, and `girth`/`degreeStats` graph analysis. `modes/LDPC.tsx` renders it in three tabs:
  an **animated Tanner graph** where amber checks wink out and the syndrome weight falls to zero as belief
  propagates (scrubbable per iteration); the **waterfall** where all four decoders dive left of uncoded
  BPSK toward the Shannon marker (BER/BLER toggle, quick/balanced/deep effort, run chunked off the paint
  path); and **the code** — H's sparsity pattern, rate/rank/girth, and bit/check degree histograms. Four
  new self-tests (**105 → 109**): encoder `H·c=0` + systematic round-trip across every code, all four
  decoders recovering ≥90% of blocks at 5 dB, sum-product BER far below uncoded, and sum-product ≤ min-sum
  + PEG girth ≥ 6 + Shannon(½)≈0 dB. Ran the CI gate (scope + conformance + lint + build ✓) and drove it in
  headless Chromium: 109/109 self-tests pass, all three tabs render and the Monte-Carlo waterfall computes
  with zero console/runtime errors. Eighteen modes, still zero math libraries.
- 2026-07-17 (claude, v15): "Beyond the scalogram — the **discrete wavelet transform** pillar." The
  Wavelet mode had shipped in v6 as a single continuous Morlet scalogram; v15 makes it four tabs and
  adds the orthonormal, critically-sampled, exactly-invertible transform that does the practical work
  (JPEG-2000, denoising). Two new from-scratch libs, no math library: `lib/dwt.ts` **derives** the
  wavelet filters rather than tabulating them — it builds the Daubechies maximally-flat half-band
  polynomial `Σ C(N−1+k,k) yᵏ`, factors it with the lab's own **Durand–Kerner** root finder, maps each
  root through `z + 1/z = 2 − 4y`, and spectrally factors into a **minimum-phase Daubechies** (all
  roots interior) or **least-asymmetric Symlet** (the root-selection pattern minimising the symmetry
  defect `Σ(h[n]−h[L−1−n])²`) scaling filter, with the QMF wavelet `hi[n] = (−1)ⁿ·lo[L−1−n]`. Because
  the periodic transform is **paraunitary**, synthesis is literally the adjoint of analysis: `dwtStep`
  gathers (circular-convolve + downsample), `idwtStep` scatters the same weights back, and the pair
  perfect-reconstructs for *any* orthonormal bank — no index-offset guesswork. On top: Mallat's
  `wavedec`/`waverec`, a full-length additive `mra` (bands sum to the signal), and **Donoho–Johnstone
  denoising** — MAD-from-`d₁` noise σ, then VisuShrink / SureShrink (Stein's unbiased risk minimised
  per band) / BayesShrink, soft or hard. `lib/dwtSignals.ts` adds the canonical Blocks/Bumps/HeaviSine/
  Doppler benchmark suite. `modes/Wavelet.tsx` is now three deep-linkable tabs: **Scalogram** (the
  original CWT-vs-STFT), **Multiresolution** (octave bands stacked with per-band energy %, a live
  reconstruction-error readout, and the two half-band filters drawn power-complementing across ω=π/2),
  and **Denoise** (noisy input vs wavelet-recovered signal over the clean reference, with input/output
  SNR, gain, σ̂ and %-coefficients-kept). Then a fourth **Best-basis** tab and a second engine
  (`lib/wp.ts`): the **wavelet packet** transform splits *both* children at every node into a full
  binary tree, and the **Coifman–Wickerhauser** bottom-up search picks the minimum-cost admissible
  cover (Shannon-entropy or ℓ¹ additive cost) — the orthonormal basis that represents *this* signal
  most sparsely. Each leaf is placed on the true frequency axis by the spectral centroid of its
  band-limited component, and the result renders as an **adaptive time-frequency tiling** (a magma
  heatmap whose strip heights vary with the local frequency resolution): fine bands where the signal
  is tonal, coarse where it is transient — Doppler tiles into 13 leaves tracking its chirp down in
  frequency, Blocks into a coarse 7-leaf basis with the jumps showing as broadband vertical streaks.
  Nine new self-tests (**109 → 118**): every derived filter sums to √2 and is double-shift orthonormal
  to 1e-9; db2 matches its published Daubechies coefficients; multi-level analysis→synthesis is an exact
  identity for every wavelet with Parseval energy preserved; db2 annihilates a linear ramp (2 vanishing
  moments); the MRA bands sum back to the signal; shrinkage raises SNR on the Donoho "blocks" signal for
  all three rules; the full packet tree and every best-basis cover reconstruct exactly; the best-basis
  cost is ≤ both trivial bases; and the best basis adapts to a pure tone by splitting to its finest
  level. Verified independently in two Node harnesses (20/20 DWT, 5/5 packets) and then in-app: ran the
  CI gate (scope + conformance + lint + build ✓) and drove it in headless Chromium — all four tabs
  render, the QMF pair crosses at π/2, MRA reconstruction error sits at ~5e-15, Doppler denoises +9 dB
  with BayesShrink, and the best-basis tiling packs 99% of the Doppler energy into 3.7% of the
  coefficients, zero console/runtime errors. Still zero math libraries — the wavelet filters are
  computed, not copied.
- 2026-07-17 (claude, v15.2): "Symmetric wavelets — the biorthogonal CDF 5/3 & 9/7 (JPEG-2000)." A
  hard theorem says an orthonormal wavelet can never be symmetric (Haar excepted), and asymmetry
  smears edges — which is why image codecs use *biorthogonal* wavelets, whose analysis and synthesis
  filters differ and can both be symmetric. Rather than juggle two filter pairs and their alignment,
  `lib/lifting.ts` implements the **CDF 5/3** (LeGall, the reversible transform) and **CDF 9/7**
  (Daubechies–Feauveau) via the **lifting scheme** — predict/update steps between even and odd samples,
  each trivially invertible, so perfect reconstruction is *structural and exact* with zero alignment
  bookkeeping (exactly how the JPEG-2000 reference codec computes them). `dwt.ts` gained a `transform`
  field on the filter bank and dispatches `dwtStep`/`idwtStep` to lifting for biorthogonal banks, so
  the entire DWT stack — multiresolution, denoise, and the wavelet-packet best basis — flows through
  the new wavelets unchanged; the three DWT tabs' pickers now list CDF 5/3 & 9/7 alongside the
  orthonormal families, with mode copy that adapts (the QMF panel explains the differing synthesis
  duals). One new self-test (**118 → 119**): both biorthogonal transforms multi-level reconstruct
  exactly, their MRA bands sum back, and a constant maps to the approximation band alone. Verified in a
  Node harness (single- and multi-level PR to ~1e-15) and in headless Chromium via the DevTools
  protocol (all four tabs paint; CDF 9/7 BayesShrink denoises a noisy HeaviSine +14 dB, its symmetric
  filter preserving the jumps). Ran the CI gate (scope + conformance + lint + build ✓). Still zero math
  libraries.
