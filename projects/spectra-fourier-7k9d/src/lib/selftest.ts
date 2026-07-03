// Lightweight runtime self-tests for the FFT core. These run once in development
// (see main.tsx) and log to the console; they are a cheap guard that the hand
// written transforms actually match the direct DFT and round-trip correctly.

import { fromReal, magnitude } from './complex'
import { fft, ifft, dft } from './fft'
import { fieldFromGray, fft2 } from './fft2'
import { cwtMorlet } from './wavelet'
import { timeStretch, pitchTimeShift, hannPeriodic, snrDb } from './phasevocoder'
import { dct1d, idct1d, dct2d, idct2d, compressImage } from './dct'
import { cepstrum } from './cepstrum'
import { voicedSignal, pulseTrain, VOWELS } from './synth'
import { polyRoots } from './poly'
import { cx, cabs } from './cplx'
import {
  designFilter,
  freqResponse,
  impulseResponse,
  type DesignParams,
} from './filterdesign'

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps
}

export function runSelfTests(): { passed: number; failed: number; messages: string[] } {
  const messages: string[] = []
  let passed = 0
  let failed = 0
  const check = (name: string, ok: boolean) => {
    if (ok) {
      passed++
    } else {
      failed++
      messages.push(`FAIL: ${name}`)
    }
  }

  // 1. FFT of a pure cosine has energy in exactly two bins (k and N-k).
  {
    const N = 64
    const k0 = 5
    const sig = new Float64Array(N)
    for (let i = 0; i < N; i++) sig[i] = Math.cos((2 * Math.PI * k0 * i) / N)
    const mag = magnitude(fft(fromReal(sig)))
    let ok = approxEqual(mag[k0], N / 2, 1e-6) && approxEqual(mag[N - k0], N / 2, 1e-6)
    for (let k = 0; k < N; k++) {
      if (k !== k0 && k !== N - k0 && mag[k] > 1e-6) ok = false
    }
    check('cosine spectrum is a single pair of bins', ok)
  }

  // 2. FFT matches the direct DFT on random data.
  {
    const N = 128
    const a = fromReal(Array.from({ length: N }, (_, i) => Math.sin(i) + 0.3 * i))
    const f = fft(a)
    const d = dft(a)
    let ok = true
    for (let k = 0; k < N; k++) {
      if (!approxEqual(f.re[k], d.re[k], 1e-6) || !approxEqual(f.im[k], d.im[k], 1e-6)) ok = false
    }
    check('fft == direct dft', ok)
  }

  // 3. ifft(fft(x)) round-trips to x.
  {
    const N = 256
    const orig = Array.from({ length: N }, (_, i) => Math.cos(0.1 * i) - 0.5 * Math.sin(0.03 * i))
    const rt = ifft(fft(fromReal(orig)))
    let ok = true
    for (let i = 0; i < N; i++) {
      if (!approxEqual(rt.re[i], orig[i], 1e-9)) ok = false
    }
    check('ifft(fft(x)) == x', ok)
  }

  // 4. Linearity: FFT(a + b) == FFT(a) + FFT(b).
  {
    const N = 32
    const a = fromReal(Array.from({ length: N }, (_, i) => Math.sin(i)))
    const b = fromReal(Array.from({ length: N }, (_, i) => Math.cos(2 * i)))
    const sum = fromReal(Array.from({ length: N }, (_, i) => Math.sin(i) + Math.cos(2 * i)))
    const fa = fft(a)
    const fb = fft(b)
    const fsum = fft(sum)
    let ok = true
    for (let k = 0; k < N; k++) {
      if (!approxEqual(fa.re[k] + fb.re[k], fsum.re[k], 1e-9)) ok = false
      if (!approxEqual(fa.im[k] + fb.im[k], fsum.im[k], 1e-9)) ok = false
    }
    check('fft is linear', ok)
  }

  // 5. Parseval's theorem: Σ|x[n]|² == (1/N) Σ|X[k]|².
  {
    const N = 64
    const x = Array.from({ length: N }, (_, i) => Math.sin(0.4 * i) + 0.3 * Math.cos(1.1 * i))
    const X = fft(fromReal(x))
    let energyTime = 0
    for (const v of x) energyTime += v * v
    let energyFreq = 0
    for (let k = 0; k < N; k++) energyFreq += X.re[k] * X.re[k] + X.im[k] * X.im[k]
    check('Parseval: energy conserved between domains', approxEqual(energyTime, energyFreq / N, 1e-6))
  }

  // 6. 2-D FFT round-trips: ifft2(fft2(x)) == x.
  {
    const w = 8
    const h = 8
    const gray = new Float64Array(w * h)
    for (let i = 0; i < w * h; i++) gray[i] = Math.sin(i * 0.7) + 0.5 * Math.cos(i * 0.31)
    const f = fieldFromGray(gray, w, h)
    const orig = f.re.slice()
    fft2(f, false)
    fft2(f, true)
    let ok = true
    for (let i = 0; i < w * h; i++) {
      if (!approxEqual(f.re[i], orig[i], 1e-9) || Math.abs(f.im[i]) > 1e-9) ok = false
    }
    check('ifft2(fft2(x)) == x', ok)
  }

  // 7. 2-D FFT is separable: the transform of an outer product a⊗b equals the
  //    outer product of the 1-D transforms A⊗B.
  {
    const w = 8
    const h = 8
    const a = Array.from({ length: w }, (_, i) => Math.cos(0.3 * i))
    const b = Array.from({ length: h }, (_, j) => Math.sin(0.2 * j) + 0.4)
    const gray = new Float64Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = a[x] * b[y]
    const F = fft2(fieldFromGray(gray, w, h), false)
    const A = fft(fromReal(a))
    const B = fft(fromReal(b))
    let ok = true
    for (let l = 0; l < h; l++) {
      for (let k = 0; k < w; k++) {
        const er = A.re[k] * B.re[l] - A.im[k] * B.im[l]
        const ei = A.re[k] * B.im[l] + A.im[k] * B.re[l]
        const idx = l * w + k
        if (!approxEqual(F.re[idx], er, 1e-6) || !approxEqual(F.im[idx], ei, 1e-6)) ok = false
      }
    }
    check('2-D FFT is separable (outer product)', ok)
  }

  // 8. Morlet admissibility: a valid wavelet has zero mean, so it produces no
  //    response to a constant (DC) signal.
  {
    const N = 128
    const dc = new Float64Array(N)
    dc.fill(1)
    const res = cwtMorlet(dc, { fs: N, omega0: 6, scalesPerOctave: 8 })
    let maxPower = 0
    for (const row of res.power) for (let i = 0; i < row.length; i++) if (row[i] > maxPower) maxPower = row[i]
    check('Morlet wavelet has zero mean (no DC response)', maxPower < 1e-6)
  }

  // 9. Phase vocoder identity: an unmodified analysis/synthesis round-trip
  //    reconstructs the interior of the signal to high SNR (the WOLA/COLA guard).
  {
    const fs = 8000
    const sig = voicedSignal(8192, { f0: 150, fs, formants: VOWELS[0].formants })
    const id = timeStretch(sig, 1, { fftSize: 1024, overlap: 4 })
    check('phase vocoder identity reconstructs (SNR > 40 dB)', snrDb(sig, id, 1024) > 40)
  }

  // 10. Weighted overlap-add: the summed squared Hann at 75% overlap is constant,
  //     so the vocoder's normalisation is well posed (the "constant overlap-add").
  {
    const N = 1024
    const hop = N / 4
    const win = hannPeriodic(N)
    const acc = new Float64Array(N)
    for (let s = -4; s <= 4; s++) {
      const off = s * hop
      for (let i = 0; i < N; i++) {
        const j = i - off
        if (j >= 0 && j < N) acc[i] += win[j] * win[j]
      }
    }
    let mn = Infinity
    let mx = -Infinity
    for (let i = N / 4; i < (3 * N) / 4; i++) {
      mn = Math.min(mn, acc[i])
      mx = Math.max(mx, acc[i])
    }
    check('Hann² is constant-overlap-add at 75%', (mx - mn) / mx < 1e-6)
  }

  // 11. Pitch-shift by an octave doubles the perceived pitch while preserving
  //     duration — checked with the cepstral pitch detector.
  {
    const fs = 8000
    const sig = voicedSignal(8192, { f0: 130, fs, formants: VOWELS[2].formants })
    const up = pitchTimeShift(sig, { fftSize: 1024, overlap: 4, semitones: 12, stretch: 1 })
    const durOk = Math.abs(up.length / sig.length - 1) < 0.08
    const c = cepstrum(Float64Array.from(up.subarray(0, 2048)), {
      fftSize: 2048,
      fs,
      window: 'hann',
      lifterCutoff: 30,
      minF: 60,
      maxF: 800,
    })
    check('octave pitch-shift ≈ doubles f0, keeps duration', durOk && Math.abs(c.pitchHz - 260) < 40)
  }

  // 12. DCT-II/III round-trip and orthonormality (energy preserved).
  {
    const x = Float64Array.from([12, -3, 7, 42, 0, -18, 5, 9])
    const rt = idct1d(dct1d(x))
    let rtOk = true
    for (let i = 0; i < 8; i++) if (!approxEqual(rt[i], x[i], 1e-9)) rtOk = false
    const X = dct1d(x)
    let et = 0
    let ef = 0
    for (let i = 0; i < 8; i++) {
      et += x[i] * x[i]
      ef += X[i] * X[i]
    }
    check('DCT-II/III round-trip + energy (orthonormal)', rtOk && approxEqual(et, ef, 1e-9))
  }

  // 13. 2-D DCT round-trip over an 8×8 block.
  {
    const blk = new Float64Array(64)
    for (let i = 0; i < 64; i++) blk[i] = Math.sin(i * 0.7) * 40 - 10
    const rt = idct2d(dct2d(blk))
    let ok = true
    for (let i = 0; i < 64; i++) if (!approxEqual(rt[i], blk[i], 1e-8)) ok = false
    check('2-D DCT 8×8 round-trip', ok)
  }

  // 14. JPEG-lite rate/distortion is monotone: higher quality → higher PSNR and
  //     a lower compression ratio.
  {
    const w = 64
    const h = 64
    const img = new Float64Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) img[y * w + x] = 0.5 + 0.5 * Math.sin(x * 0.3) * Math.cos(y * 0.2)
    const hi = compressImage(img, w, h, 95)
    const lo = compressImage(img, w, h, 15)
    check('DCT codec: quality ↑ ⇒ PSNR ↑, ratio ↓', hi.psnr > lo.psnr && lo.ratio > hi.ratio)
  }

  // 15. Cepstrum locates the period of a harmonic pulse train (its pitch).
  {
    const fs = 8000
    const N = 2048
    const period = 40 // → 200 Hz
    const pt = pulseTrain(N, period, 30)
    const res = cepstrum(pt, { fftSize: N, fs, window: 'hann', lifterCutoff: 30, minF: 60, maxF: 800 })
    check('cepstral peak = pulse-train period (pitch)', Math.abs(res.pitchQuefrency - period) < 2)
  }

  // ---- Filter design engine ----

  const baseParams: DesignParams = {
    family: 'butter',
    response: 'low',
    order: 4,
    fs: 1000,
    cutoff: 100,
    cutoffHi: 200,
    rippleDb: 1,
    stopDb: 40,
    biquadType: 'lowpass',
    q: 0.707,
    gainDb: 6,
    taps: 63,
    window: 'hamming',
  }
  const nearest = (hz: Float64Array, target: number) => {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < hz.length; i++) {
      const d = Math.abs(hz[i] - target)
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return bi
  }

  // 16. Durand–Kerner recovers the roots of a known polynomial.
  {
    // (x−2)(x+3) = x² + x − 6
    const roots = polyRoots([cx(1), cx(1), cx(-6)])
    const vals = roots.map((r) => r.re).sort((a, b) => a - b)
    const allReal = roots.every((r) => Math.abs(r.im) < 1e-6)
    check('polyRoots factors x²+x−6 → {−3, 2}', allReal && approxEqual(vals[0], -3, 1e-6) && approxEqual(vals[1], 2, 1e-6))
  }

  // 17. Butterworth low-pass is −3 dB at its cutoff (the prewarped bilinear
  //     transform preserves the critical frequency exactly).
  {
    const d = designFilter({ ...baseParams, family: 'butter', order: 6, cutoff: 150 })
    const fr = freqResponse(d, 4096)
    const i = nearest(fr.hz, 150)
    check('Butterworth LP is −3 dB at cutoff', Math.abs(fr.magDb[i] - -3.0103) < 0.15)
  }

  // 18. A low-pass passes DC (unity) and rejects Nyquist; the design is stable.
  {
    const d = designFilter({ ...baseParams, family: 'butter', order: 5, cutoff: 120 })
    const fr = freqResponse(d, 2048)
    const dcOk = Math.abs(fr.mag[0] - 1) < 0.02
    const nyqOk = fr.magDb[fr.magDb.length - 1] < -40
    check('LP: unity at DC, deep reject at Nyquist, stable', dcOk && nyqOk && d.stable)
  }

  // 19. Butterworth magnitude is monotonically non-increasing (the maximally-flat
  //     property — no ripple anywhere).
  {
    const d = designFilter({ ...baseParams, family: 'butter', order: 8, cutoff: 130 })
    const fr = freqResponse(d, 1024)
    let monotone = true
    for (let i = 1; i < fr.mag.length; i++) if (fr.mag[i] > fr.mag[i - 1] + 1e-4) monotone = false
    check('Butterworth magnitude is monotone (maximally flat)', monotone)
  }

  // 20. Chebyshev-I stays inside its passband ripple bound and is stable.
  {
    const rippleDb = 1
    const d = designFilter({ ...baseParams, family: 'cheby1', order: 6, cutoff: 140, rippleDb })
    const fr = freqResponse(d, 4096)
    const iCut = nearest(fr.hz, 140)
    let maxPass = -Infinity
    let minPass = Infinity
    for (let i = 0; i <= iCut; i++) {
      maxPass = Math.max(maxPass, fr.magDb[i])
      minPass = Math.min(minPass, fr.magDb[i])
    }
    // Ripple confined to [−ripple−slack, +slack].
    check('Chebyshev-I passband ripple ≈ spec', d.stable && maxPass < 0.1 && minPass > -rippleDb - 0.25)
  }

  // 21. A linear-phase FIR has constant group delay of (numTaps−1)/2 samples.
  {
    const taps = 65
    const d = designFilter({ ...baseParams, family: 'fir', response: 'low', taps, cutoff: 150, window: 'hann' })
    const fr = freqResponse(d, 512)
    // sample the mid-band group delay (away from nulls where phase is ill-defined)
    let ok = true
    for (let i = 5; i < 120; i++) if (Math.abs(fr.groupDelay[i] - (taps - 1) / 2) > 0.25) ok = false
    check('FIR linear phase ⇒ constant group delay (N−1)/2', ok)
  }

  // 22. The z-plane transfer function agrees with the time-domain filter: the FFT
  //     of the impulse response reproduces the analytic frequency response.
  {
    const d = designFilter({ ...baseParams, family: 'cheby2', order: 5, response: 'high', cutoff: 160, stopDb: 45 })
    const L = 2048
    const imp = impulseResponse(d, L)
    const spec = magnitude(fft(fromReal(imp)))
    const fr = freqResponse(d, L / 2 + 1)
    let maxErr = 0
    // compare across the band, skipping deep-stopband bins where both are tiny
    for (let k = 1; k < L / 2; k++) {
      if (fr.mag[k] < 0.05) continue
      maxErr = Math.max(maxErr, Math.abs(spec[k] - fr.mag[k]))
    }
    check('impulse-response FFT == analytic H(e^jω)', maxErr < 0.03)
  }

  // 23. Every classic IIR design across all four response types is stable
  //     (all poles strictly inside the unit circle).
  {
    let allStable = true
    for (const family of ['butter', 'cheby1', 'cheby2'] as const) {
      for (const response of ['low', 'high', 'band', 'notch'] as const) {
        const d = designFilter({ ...baseParams, family, response, order: 4, cutoff: 120, cutoffHi: 220 })
        if (!d.stable || d.poles.some((p) => cabs(p) >= 1)) allStable = false
      }
    }
    check('all classic IIR designs (3 families × 4 types) are stable', allStable)
  }

  return { passed, failed, messages }
}
