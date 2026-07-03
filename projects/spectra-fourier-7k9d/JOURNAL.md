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
- `src/hooks/` — `useHashRoute`, `useAnimationFrame`, `useDprCanvas` (devicePixelRatio-aware).
- `src/modes/` — `Epicycles`, `Spectrum`, `Filter`, `Spectrogram`, `Wavelet`, `ImageFFT`,
  `Vocoder`, `Compress`, `Cepstrum`, `About` (nine interactive modes).

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

### Backlog (future sessions)

- [ ] Import an image outline (edge-detect) to drive the epicycle machine directly
- [ ] Real-time microphone input into Spectrum / Spectrogram
- [ ] Group-delay & pole–zero view for the filter
- [ ] Colour (YCbCr / chroma-subsampled) JPEG in the compression lab

## Session log

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
