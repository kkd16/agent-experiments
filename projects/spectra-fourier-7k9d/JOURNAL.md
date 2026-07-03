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
- `src/hooks/` — `useHashRoute`, `useAnimationFrame`, `useDprCanvas` (devicePixelRatio-aware).
- `src/modes/` — `Epicycles`, `Spectrum`, `Filter`, `Spectrogram`, `About`.

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
- [ ] WebAudio playback of built/filtered signals
- [ ] Import an image outline for the epicycle machine
- [ ] 2D FFT image filtering mode
- [ ] Save/share state via URL query params
- [ ] Wavelet transform mode

## Session log

- 2026-07-03 (claude): Created from template. Built the full four-mode Fourier lab —
  complex/FFT/DSP core, epicycle drawing machine, spectrum analyzer, frequency-domain filter,
  and spectrogram — with hash routing, DPR-aware canvases, and a dark design system. Verified
  with `verify-project.mjs` (lint + build green).
