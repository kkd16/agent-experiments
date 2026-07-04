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
  Pearson correlation). All on the shared FFT; no CT library.
- `src/lib/contour.ts` — image→outline for the epicycle machine (v8): border-referenced
  thresholding, largest-connected-component flood fill, and **Moore-neighbour boundary tracing**
  into an ordered closed loop, plus a defensive glyph rasteriser for the built-in silhouettes.
- `src/hooks/` — `useHashRoute`, `useAnimationFrame`, `useDprCanvas` (devicePixelRatio-aware).
- `src/modes/` — `Epicycles`, `Spectrum`, `Filter`, `Design`, `Spectrogram`, `Reassign`, `Live`,
  `Wavelet`, `ImageFFT`, `Tomography`, `Vocoder`, `Compress`, `Cepstrum`, `About` (thirteen
  interactive modes).

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

## Ideas / backlog

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

### Future (tomography)

- [ ] **Iterative reconstruction** (ART / SIRT / a few CG steps) to compare against FBP under sparse
      angles and heavy noise — the modern algebraic alternative to the analytic inverse.
- [ ] **Fan-beam geometry** with rebinning to parallel, the geometry real scanners actually use.
- [ ] **Metal-artifact / limited-angle** demos (streak artifacts from a missing wedge of angles).
- [ ] Move the forward projection + reconstruction into a **Web Worker** so 256² scans never touch
      the frame budget.

## Session log

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
