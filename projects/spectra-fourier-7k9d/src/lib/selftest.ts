// Lightweight runtime self-tests for the FFT core. These run once in development
// (see main.tsx) and log to the console; they are a cheap guard that the hand
// written transforms actually match the direct DFT and round-trip correctly.

import { fromReal, magnitude } from './complex'
import { fft, ifft, dft } from './fft'
import { fieldFromGray, fft2 } from './fft2'
import { cwtMorlet } from './wavelet'
import {
  WAVELETS,
  BIOR_WAVELETS,
  getBank,
  maxLevel,
  wavedec,
  waverec,
  dwtStep,
  mra,
  denoise,
  snrDb as dwtSnrDb,
  orthonormalityDefect,
} from './dwt'
import { dwtSignal, addNoise } from './dwtSignals'
import { wpAnalyze, bestBasis, wpReconstruct, wpLeafSignal, spectralCentroid } from './wp'
import { timeStretch, pitchTimeShift, hannPeriodic, snrDb } from './phasevocoder'
import { dct1d, idct1d, dct2d, idct2d, compressImage } from './dct'
import { cepstrum } from './cepstrum'
import { voicedSignal, pulseTrain, VOWELS } from './synth'
import { polyRoots } from './poly'
import { cx, cabs, cmul } from './cplx'
import {
  designFilter,
  freqResponse,
  impulseResponse,
  type DesignParams,
} from './filterdesign'
import { freqToNote, refinePeak } from './note'
import { ellipk, ellipj, ellipdeg, ellipap } from './ellip'
import { remezDesign } from './remez'
import { estimateOrders, buttord, cheb1ord, ellipord } from './filterspec'
import type { FilterSpec } from './filterspec'
import { reassignSpectrogram, makeTfrSignal, instantaneousFreq } from './reassign'
import { makePhantom } from './phantom'
import { forwardRadon, fbp, directFourier, affineError, correlation } from './radon'
import {
  geometryFromSino,
  project,
  backproject,
  makeSolver,
  reconstructIterative,
} from './iterative'
import { traceContour } from './contour'
import {
  recover,
  buildProblem,
  basisMatrix,
  matVec,
  matTVec,
  softThreshold,
  fista,
  ista,
  phaseTransition,
  mulberry32,
  type BasisKind,
  type RecoverConfig,
} from './cs'
import { cmul as spCmul, cconj as spCconj } from './cplx'
import {
  generateSignal as spGenerate,
  sampleCovariance as spCovariance,
  hermitianEig as spHermitianEig,
  rootMusic as spRootMusic,
  esprit as spEsprit,
  music as spMusic,
  welch as spWelch,
  burg as spBurg,
  arSpectrum as spArSpectrum,
  periodogram as spPeriodogram,
  aicMdl as spAicMdl,
  analyze as spAnalyze,
  mulberry32 as spMulberry,
  type SignalConfig as SpSignalConfig,
} from './spectral'
import {
  SCHEMES,
  constellation,
  mapBits,
  demapSymbols,
  grayEncode,
  grayDecode,
  qfunc,
  erfc,
  theoryBER,
  simulateLink,
  mulberry32 as commsRng,
  gaussian as commsGaussian,
  ebn0ToSigma,
  randomBits,
  type Scheme,
} from './comms'
import { rrcTaps, rcTaps, convolveReal, upsample, firComplex, sampleSymbols } from './pulse'
import {
  activeCarriers,
  modulate,
  demodulate,
  applyChannel,
  channelResponse,
  paprDb,
  CHANNELS,
} from './ofdm'
import {
  CONV_CODES,
  buildTrellis,
  convEncode,
  viterbiHard,
  viterbiSoft,
  distanceSpectrum,
  simulateCoded,
  unionBoundSoft,
  unionBoundHard,
  uncodedBer,
  PUNCTURES,
  punctureRate,
  applyPuncture,
  depuncture,
  textToBits,
  bitsToText,
  mulberry32 as fecRng,
} from './fec'
import {
  runAdaptive,
  makeScenario,
  learningCurves,
  wienerSolution,
  misalignmentDb,
  snrDbTail,
  runKalman,
  convolve as adConvolve,
  solveSmall,
  type AlgoConfig,
  type ScenarioConfig,
} from './adaptive'
import {
  codeCatalogue as ldpcCatalogue,
  codeById as ldpcById,
  encode as ldpcEncode,
  extractMessage as ldpcExtract,
  syndromeWeight as ldpcSyndrome,
  decodeDemo as ldpcDecodeDemo,
  waterfall as ldpcWaterfall,
  uncodedBer as ldpcUncodedBer,
  girth as ldpcGirth,
  shannonLimitDb as ldpcShannonLimit,
  mulberry32 as ldpcRng,
} from './ldpc'

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

  // 8b. The from-scratch orthonormal wavelet filters (Daubechies + Symlet) are
  //     each derived by spectral-factoring the half-band polynomial. Every one
  //     must sum to √2 and be double-shift orthonormal to machine precision.
  {
    let worstDefect = 0
    let worstSum = 0
    for (const w of WAVELETS) {
      const bank = getBank(w.id)
      let sum = 0
      for (const v of bank.lo) sum += v
      worstSum = Math.max(worstSum, Math.abs(sum - Math.SQRT2))
      worstDefect = Math.max(worstDefect, orthonormalityDefect(bank.lo))
    }
    check('derived wavelet filters sum to √2 and are orthonormal', worstSum < 1e-9 && worstDefect < 1e-9)
  }

  // 8c. db2 matches the published Daubechies coefficients (validates the
  //     derivation against a known reference; reversal is an equally valid
  //     orthonormal filter, so accept either order).
  {
    const db2 = Array.from(getBank('db2').lo)
    const ref = [0.48296291314469025, 0.836516303737469, 0.22414386804185735, -0.12940952255092145]
    const eq = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
    check('db2 matches published Daubechies coefficients', eq(db2, ref) || eq(db2, ref.slice().reverse()))
  }

  // 8d. The periodic DWT is paraunitary: multi-level analysis → synthesis is an
  //     exact identity for every wavelet, and energy is preserved (Parseval).
  {
    const N = 1024
    const x = new Float64Array(N)
    for (let i = 0; i < N; i++) x[i] = Math.sin(0.05 * i) + 0.4 * Math.sin(0.3 * i + 1) + (i > 500 && i < 520 ? 2 : 0)
    let worst = 0
    for (const w of WAVELETS) {
      const bank = getBank(w.id)
      const dec = wavedec(x, bank, maxLevel(N, bank))
      const rec = waverec(dec)
      for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(rec[i] - x[i]))
    }
    const bank = getBank('db4')
    const dec = wavedec(x, bank, maxLevel(N, bank))
    let ex = 0
    for (const v of x) ex += v * v
    let ec = 0
    for (const v of dec.approx) ec += v * v
    for (const d of dec.details) for (const v of d) ec += v * v
    check('DWT perfect reconstruction (all wavelets) + Parseval', worst < 1e-9 && Math.abs(ex - ec) / ex < 1e-9)
  }

  // 8e. Vanishing moments: db2 (2 vanishing moments) annihilates a linear ramp,
  //     so its interior detail coefficients are ~0.
  {
    const N = 256
    const x = new Float64Array(N)
    for (let i = 0; i < N; i++) x[i] = 3 + 0.5 * i
    const { cD } = dwtStep(x, getBank('db2'))
    let mx = 0
    for (let i = 2; i < cD.length - 2; i++) mx = Math.max(mx, Math.abs(cD[i]))
    check('db2 annihilates a linear signal (2 vanishing moments)', mx < 1e-9)
  }

  // 8f. Multiresolution bands are additive: A_J + Σ D_j reproduces the signal.
  {
    const N = 1024
    const x = dwtSignal('doppler', N)
    const bank = getBank('sym6')
    const m = mra(x, bank, maxLevel(N, bank))
    let e = 0
    for (let i = 0; i < N; i++) {
      let s = m.approx[i]
      for (const d of m.details) s += d[i]
      e = Math.max(e, Math.abs(s - x[i]))
    }
    check('MRA bands sum exactly back to the signal', e < 1e-9)
  }

  // 8g. Wavelet shrinkage denoising raises SNR on the Donoho "blocks" signal for
  //     all three threshold rules.
  {
    const N = 1024
    const clean = dwtSignal('blocks', N)
    const noisy = addNoise(clean, 0.5, 7)
    const bank = getBank('sym8')
    const lv = maxLevel(N, bank)
    const before = dwtSnrDb(clean, noisy)
    let worstGain = Infinity
    for (const rule of ['universal', 'sure', 'bayes'] as const) {
      const r = denoise(noisy, bank, lv, rule, 'soft')
      worstGain = Math.min(worstGain, dwtSnrDb(clean, r.clean) - before)
    }
    check('wavelet denoising improves SNR (VisuShrink/SURE/Bayes)', worstGain > 1.5)
  }

  // 8h. The full wavelet-packet tree (split every node) reconstructs exactly, and
  //     the best-basis cover — for both cost functions — is also an exact inverse.
  {
    const N = 1024
    const bank = getBank('sym6')
    const x = dwtSignal('doppler', N)
    const J = 4
    const nodes = wpAnalyze(x, bank, J)
    const splitAll = nodes.map((lvl, j) => lvl.map(() => j < J))
    const recFull = wpReconstruct(nodes, splitAll, bank)
    let worst = 0
    for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(recFull[i] - x[i]))
    for (const c of ['shannon', 'l1'] as const) {
      const bb = bestBasis(nodes, c)
      const rec = wpReconstruct(nodes, bb.split, bank)
      for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(rec[i] - x[i]))
    }
    check('wavelet-packet full-tree + best-basis reconstruction exact', worst < 1e-9)
  }

  // 8i. The best basis is genuinely optimal: its total Shannon cost is ≤ both the
  //     undivided root and the full-depth cover (the two trivial bases).
  {
    const nodes = wpAnalyze(dwtSignal('heavisine', 1024), getBank('sym6'), 5)
    const bb = bestBasis(nodes, 'shannon')
    check(
      'wavelet-packet best-basis cost ≤ root and ≤ full-depth cover',
      bb.bestCost <= bb.fullTreeCost + 1e-6 && bb.bestCost <= bb.finestCost + 1e-6,
    )
  }

  // 8j. Adaptivity: for a pure tone the best basis subdivides down to its finest
  //     level near the tone and concentrates ≥90% of the energy in that band.
  {
    const N = 1024
    const f0 = 0.09375
    const x = new Float64Array(N)
    for (let i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * f0 * i)
    const nodes = wpAnalyze(x, getBank('sym8'), 5)
    const bb = bestBasis(nodes, 'shannon')
    let near = 0
    let tot = 0
    let maxLevel = 0
    let maxE = 0
    for (const lf of bb.leaves) {
      const band = nodes[lf.j][lf.k]
      let e = 0
      for (const v of band) e += v * v
      tot += e
      if (Math.abs(spectralCentroid(wpLeafSignal(nodes, lf, getBank('sym8'))) - f0) < 0.03) near += e
      if (e > maxE) {
        maxE = e
        maxLevel = lf.j
      }
    }
    check('wavelet-packet best basis adapts fine resolution to a tone', near / tot > 0.9 && maxLevel >= 3)
  }

  // 8k. Biorthogonal wavelets (CDF 5/3 & 9/7, the JPEG-2000 pair) run by the
  //     lifting scheme: multi-level analysis→synthesis is exact for every signal,
  //     the additive MRA bands sum back, and a constant maps to the approximation
  //     only (its detail band is ~0).
  {
    let worst = 0
    let mraErr = 0
    let dcDetail = 0
    for (const w of BIOR_WAVELETS) {
      const bank = getBank(w.id)
      for (const sig of ['blocks', 'doppler', 'heavisine'] as const) {
        const x = dwtSignal(sig, 1024)
        const L = maxLevel(1024, bank)
        const rec = waverec(wavedec(x, bank, L))
        for (let i = 0; i < 1024; i++) worst = Math.max(worst, Math.abs(rec[i] - x[i]))
      }
      const dop = dwtSignal('doppler', 1024)
      const m = mra(dop, bank, maxLevel(1024, bank))
      for (let i = 0; i < 1024; i++) {
        let s = m.approx[i]
        for (const d of m.details) s += d[i]
        mraErr = Math.max(mraErr, Math.abs(s - dop[i]))
      }
      const constant = new Float64Array(256).fill(3)
      const { cD } = dwtStep(constant, bank)
      for (let i = 0; i < cD.length; i++) dcDetail = Math.max(dcDetail, Math.abs(cD[i]))
    }
    check('biorthogonal (CDF 5/3 & 9/7) lifting PR + MRA + DC-to-approx', worst < 1e-9 && mraErr < 1e-9 && dcDetail < 1e-8)
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
    transHz: 60,
    stopWeight: 4,
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

  // ---- Live analyser helpers ----

  // 24. Equal-temperament note mapping: A4 = 440 Hz, C4 ≈ 261.63 Hz, and a
  //     slightly-sharp A is reported as positive cents.
  {
    const a4 = freqToNote(440)
    const c4 = freqToNote(261.6256)
    const sharpA = freqToNote(440 * Math.pow(2, 10 / 1200)) // +10 cents
    const ok =
      a4?.name === 'A4' &&
      Math.abs(a4.cents) <= 0 &&
      c4?.name === 'C4' &&
      sharpA?.name === 'A4' &&
      Math.abs((sharpA?.cents ?? 0) - 10) <= 1 &&
      freqToNote(0) === null
    check('freqToNote: A4=440, C4≈261.6, +10 cents detected', ok)
  }

  // 25. Parabolic peak refinement recovers a between-bins frequency: a tone at
  //     2.5 bins should be located near 2.5·binHz, closer than a bare argmax.
  {
    const binHz = 10
    const mag = new Float64Array(8)
    // a symmetric hump peaking between bins 2 and 3 (true peak 2.5)
    for (let k = 0; k < 8; k++) mag[k] = Math.exp(-Math.pow(k - 2.5, 2) / 0.8)
    // argmax is bin 2 or 3; refine from the higher of the two
    let kmax = 0
    for (let k = 1; k < 8; k++) if (mag[k] > mag[kmax]) kmax = k
    const f = refinePeak(mag, kmax, binHz)
    check('refinePeak: sub-bin interpolation lands near 25 Hz', Math.abs(f - 25) < 1.2)
  }

  // ---- Optimal filter design (v6): elliptic + Parks–McClellan + spec estimators ----

  // 26. Jacobi identities: sn²+cn²=1, dn²+m·sn²=1, and sn(K,m)=1 at the quarter period.
  {
    let idOk = true
    for (const m of [0.15, 0.4, 0.75]) {
      for (let u = -3; u <= 3; u += 0.5) {
        const { sn, cn, dn } = ellipj(u, m)
        if (Math.abs(sn * sn + cn * cn - 1) > 1e-12) idOk = false
        if (Math.abs(dn * dn + m * sn * sn - 1) > 1e-12) idOk = false
      }
      const q = ellipj(ellipk(m), m)
      if (Math.abs(q.sn - 1) > 1e-9 || Math.abs(q.cn) > 1e-9) idOk = false
    }
    check('Jacobi sn/cn/dn identities + sn(K,m)=1', idOk)
  }

  // 27. Elliptic degree equation: N·K(k₁)/K′(k₁) == K(k)/K′(k) for the solved modulus.
  {
    let degOk = true
    for (const N of [3, 4, 5, 7]) {
      for (const m1 of [1e-4, 1e-3, 1e-2]) {
        const m = ellipdeg(N, m1)
        const lhs = (N * ellipk(m1)) / ellipk(1 - m1)
        const rhs = ellipk(m) / ellipk(1 - m)
        if (Math.abs(lhs - rhs) / rhs > 1e-6) degOk = false
      }
    }
    check('elliptic degree equation N·K(k₁)/K′(k₁)=K(k)/K′(k)', degOk)
  }

  // 28. The analog elliptic prototype is equiripple in both bands and meets spec: the
  //     passband stays within Rp of 0 dB and the stopband stays below −Rs, with N
  //     stable (LHP) poles.
  {
    const magAt = (z: import('./cplx').Cx[], p: import('./cplx').Cx[], k: number, w: number) => {
      const s = cx(0, w)
      let num = cx(k, 0)
      for (const zi of z) num = cmul(num, cx(s.re - zi.re, s.im - zi.im))
      let den = cx(1, 0)
      for (const pj of p) den = cmul(den, cx(s.re - pj.re, s.im - pj.im))
      const dd = den.re * den.re + den.im * den.im
      return cabs(cx((num.re * den.re + num.im * den.im) / dd, (num.im * den.re - num.re * den.im) / dd))
    }
    let specOk = true
    for (const [N, rp, rs] of [
      [4, 1, 40],
      [5, 0.5, 60],
      [6, 0.1, 80],
    ] as [number, number, number][]) {
      const { z, p, k } = ellipap(N, rp, rs)
      const m = ellipdeg(N, (Math.pow(10, rp / 10) - 1) / (Math.pow(10, rs / 10) - 1))
      const Ws = 1 / Math.sqrt(m)
      let pbMin = Infinity
      let pbMax = -Infinity
      for (let w = 0; w <= 1; w += 0.002) {
        const db = 20 * Math.log10(magAt(z, p, k, w))
        pbMax = Math.max(pbMax, db)
        pbMin = Math.min(pbMin, db)
      }
      let sbMax = -Infinity
      for (let w = Ws; w <= Ws * 30; w += Ws * 0.02) sbMax = Math.max(sbMax, 20 * Math.log10(magAt(z, p, k, w)))
      const stable = p.every((pp) => pp.re < 0)
      if (!(pbMax < 0.05 && pbMin > -rp - 0.05 && sbMax < -rs + 0.1 && stable && p.length === N)) specOk = false
    }
    check('elliptic prototype: equiripple both bands, meets Rp/Rs, stable', specOk)
  }

  // 29. The digital elliptic filter (through the bilinear pipeline) holds its passband
  //     ripple and remains stable.
  {
    const d = designFilter({ ...baseParams, family: 'ellip', order: 6, cutoff: 150, rippleDb: 1, stopDb: 60 })
    const fr = freqResponse(d, 4096)
    const iCut = nearest(fr.hz, 150)
    let pbMax = -Infinity
    let pbMin = Infinity
    for (let i = 0; i <= iCut; i++) {
      pbMax = Math.max(pbMax, fr.magDb[i])
      pbMin = Math.min(pbMin, fr.magDb[i])
    }
    check('digital elliptic LP: passband ripple ≤ Rp, stable', d.stable && pbMax < 0.1 && pbMin > -1 - 0.25)
  }

  // 30. Parks–McClellan converges to an *equiripple* filter: with equal band weights the
  //     max passband deviation equals the max stopband ripple (the alternation theorem).
  {
    const r = remezDesign(31, [
      { lo: 0, hi: 0.2, desired: 1, weight: 1 },
      { lo: 0.3, hi: 0.5, desired: 0, weight: 1 },
    ])
    const h = r.taps
    const ampAt = (f: number) => {
      let re = 0
      let im = 0
      for (let n = 0; n < h.length; n++) {
        re += h[n] * Math.cos(-2 * Math.PI * f * n)
        im += h[n] * Math.sin(-2 * Math.PI * f * n)
      }
      return Math.hypot(re, im)
    }
    let pbDev = 0
    for (let f = 0; f <= 0.2; f += 0.001) pbDev = Math.max(pbDev, Math.abs(ampAt(f) - 1))
    let sbMax = 0
    for (let f = 0.3; f <= 0.5; f += 0.001) sbMax = Math.max(sbMax, ampAt(f))
    let sym = 0
    for (let n = 0; n < h.length; n++) sym = Math.max(sym, Math.abs(h[n] - h[h.length - 1 - n]))
    check(
      'Parks–McClellan: converged, symmetric (linear phase), equiripple',
      r.converged && sym < 1e-12 && Math.abs(pbDev - sbMax) / sbMax < 0.05,
    )
  }

  // 31. A weighted Remez trades ripple by exactly the weight ratio: a 10× stopband weight
  //     makes the stopband ripple ≈ 1/10 of the passband ripple.
  {
    const r = remezDesign(41, [
      { lo: 0, hi: 0.2, desired: 1, weight: 1 },
      { lo: 0.28, hi: 0.5, desired: 0, weight: 10 },
    ])
    const h = r.taps
    const ampAt = (f: number) => {
      let re = 0
      let im = 0
      for (let n = 0; n < h.length; n++) {
        re += h[n] * Math.cos(-2 * Math.PI * f * n)
        im += h[n] * Math.sin(-2 * Math.PI * f * n)
      }
      return Math.hypot(re, im)
    }
    let pbDev = 0
    for (let f = 0; f <= 0.2; f += 0.001) pbDev = Math.max(pbDev, Math.abs(ampAt(f) - 1))
    let sbMax = 0
    for (let f = 0.28; f <= 0.5; f += 0.001) sbMax = Math.max(sbMax, ampAt(f))
    check('weighted Remez: ripple ratio ≈ weight ratio (10×)', Math.abs(pbDev / sbMax - 10) / 10 < 0.1)
  }

  // 32. Order estimators are sound: the minimum order each formula returns yields a filter
  //     that actually meets the stopband attenuation at the stopband edge, and the elliptic
  //     order is never worse than Chebyshev, which is never worse than Butterworth.
  {
    const spec: FilterSpec = { fp: 150, fs: 250, rp: 1, rs: 50, fsamp: 1000, response: 'low' }
    const est = estimateOrders(spec)
    let meets = true
    const fams: [import('./filterdesign').FamilyId, number, number][] = [
      ['butter', est.butter, spec.fp],
      ['cheby1', est.cheby1, spec.fp],
      ['cheby2', est.cheby2, spec.fs],
      ['ellip', est.ellip, spec.fp],
    ]
    for (const [family, N, fc] of fams) {
      const d = designFilter({ ...baseParams, family, order: N, cutoff: fc, rippleDb: spec.rp, stopDb: spec.rs })
      const fr = freqResponse(d, 8192)
      if (fr.magDb[nearest(fr.hz, spec.fs)] > -spec.rs + 0.6) meets = false
    }
    const ordered = ellipord(spec) <= cheb1ord(spec) && cheb1ord(spec) <= buttord(spec)
    check('order estimators meet Rs at edge; ellip ≤ cheby ≤ butter', meets && ordered)
  }

  // 33. Reassignment concentrates a pure tone: the reassigned frequency of every
  //     energetic cell collapses onto the tone's true frequency (sub-bin), and the
  //     reassigned spectrogram is sharper (lower Rényi entropy) than the STFT.
  {
    const fs = 4000
    const f0 = 650
    const N = 2048
    const tone = new Float64Array(N)
    for (let i = 0; i < N; i++) tone[i] = Math.cos((2 * Math.PI * f0 * i) / fs)
    const r = reassignSpectrogram(tone, { fs, fftSize: 512, hop: 64, sigma: 60 })
    // The ridge (dominant reassigned freq per column) should sit within ~one
    // bin of f0 despite the peak bin being 656 Hz away from it.
    let maxErr = 0
    let counted = 0
    for (let c = 0; c < r.cols; c++) {
      const f = r.ridge[c]
      if (isFinite(f)) {
        maxErr = Math.max(maxErr, Math.abs(f - f0))
        counted++
      }
    }
    const sharper = r.entropy.reassigned < r.entropy.stft - 0.5
    check(
      'reassignment locks a tone to its true frequency + sharpens vs STFT',
      counted > 4 && maxErr < r.binHz && sharper,
    )
  }

  // 34. Reassigned ridge of a linear chirp tracks the analytic instantaneous
  //     frequency f(t) = f0 + rate·t at every column, to within a bin.
  {
    const fs = 4000
    const N = 4096
    const dur = N / fs
    const chirp = makeTfrSignal('linearChirp', N, fs)
    const r = reassignSpectrogram(chirp, { fs, fftSize: 512, hop: 64, sigma: 45 })
    let maxErr = 0
    let counted = 0
    for (let c = 0; c < r.cols; c++) {
      const f = r.ridge[c]
      if (!isFinite(f)) continue
      const t = r.frameTimes[c]
      const truth = instantaneousFreq('linearChirp', t, dur, fs)
      maxErr = Math.max(maxErr, Math.abs(f - truth))
      counted++
    }
    check('reassigned ridge tracks the chirp instantaneous frequency', counted > 20 && maxErr < 2 * r.binHz)
  }

  // 35. Synchrosqueezing preserves the time axis (energy is not moved in time):
  //     the per-column energy profile of the SST tracks the STFT's, while still
  //     concentrating in frequency. Probe with an amplitude *burst* — a tone under
  //     a Gaussian envelope — so column energy has real temporal structure to
  //     correlate (a stationary tone would be near-flat and correlate only noise).
  {
    const fs = 4000
    const N = 2048
    const sig = new Float64Array(N)
    const c0 = N / 2
    const w0 = N / 5
    for (let i = 0; i < N; i++) {
      const env = Math.exp(-Math.pow((i - c0) / w0, 2))
      sig[i] = env * Math.sin((2 * Math.PI * 500 * i) / fs)
    }
    const r = reassignSpectrogram(sig, { fs, fftSize: 512, hop: 64, sigma: 60 })
    // Column energy of STFT vs synchro should correlate strongly (time preserved).
    const colEnergy = (t: typeof r.stft) => {
      const e = new Float64Array(t.cols)
      for (let c = 0; c < t.cols; c++) {
        let s = 0
        for (let row = 0; row < t.rows; row++) s += Math.pow(10, t.data[row * t.cols + c] / 10)
        e[c] = s
      }
      return e
    }
    const a = colEnergy(r.stft)
    const b = colEnergy(r.synchro)
    let ma = 0
    let mb = 0
    for (let c = 0; c < a.length; c++) {
      ma += a[c]
      mb += b[c]
    }
    ma /= a.length
    mb /= b.length
    let num = 0
    let da = 0
    let db = 0
    for (let c = 0; c < a.length; c++) {
      num += (a[c] - ma) * (b[c] - mb)
      da += (a[c] - ma) ** 2
      db += (b[c] - mb) ** 2
    }
    const corr = num / (Math.sqrt(da * db) + 1e-12)
    check('synchrosqueezing preserves the time axis (col-energy corr > 0.95)', corr > 0.95)
  }

  // 26. Radon of a centered disk is (nearly) angle-independent: a symmetric
  //     object casts the same shadow from every direction.
  {
    const size = 64
    const disk = makePhantom('disk', size)
    const sino = forwardRadon(disk, size, 60)
    const dc = Math.floor(sino.nDet / 2)
    let lo = Infinity
    let hi = -Infinity
    for (let a = 0; a < sino.nAngles; a++) {
      const v = sino.data[a * sino.nDet + dc]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    check('Radon of a disk is angle-independent (center ray)', (hi - lo) / hi < 0.05)
  }

  // 27. Every projection integrates to the same total mass (∫p_θ dt = const).
  {
    const size = 64
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 45)
    const dt = (2 * sino.tMax) / (sino.nDet - 1)
    let lo = Infinity
    let hi = -Infinity
    for (let a = 0; a < sino.nAngles; a++) {
      let s = 0
      for (let d = 0; d < sino.nDet; d++) s += sino.data[a * sino.nDet + d]
      s *= dt
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
    check('projection mass is conserved across angles', (hi - lo) / hi < 0.02)
  }

  // 28. Filtered back-projection recovers the Shepp–Logan phantom faithfully.
  {
    const size = 64
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 120)
    const rec = fbp(sino, size, 'ramlak')
    check('FBP reconstructs Shepp–Logan (corr > 0.9)', correlation(rec, ph) > 0.9)
  }

  // 29. The Fourier Slice Theorem reconstruction (gridding + inverse 2-D FFT)
  //     produces a recognisable image, and back-projection with no ramp filter
  //     is markedly blurrier (proving the filter is doing real work).
  {
    const size = 64
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 120)
    const df = directFourier(sino, size)
    const raw = fbp(sino, size, 'none')
    const cf = correlation(df.recon, ph)
    const cr = correlation(raw, ph)
    check('direct-Fourier slice reconstruction is recognisable (corr > 0.6)', cf > 0.6)
    check('the ramp filter beats raw back-projection', cf > cr)
  }

  // 30. affineError of a buffer against itself is zero; correlation is one.
  {
    const size = 32
    const ph = makePhantom('circles', size)
    const { rmse } = affineError(ph, ph)
    check('affineError(x, x) == 0 and corr(x, x) == 1', rmse < 1e-9 && correlation(ph, ph) > 0.9999)
  }

  // 31. Contour tracing of a disk returns a closed loop of nearly constant radius.
  {
    const size = 96
    const g = new Float64Array(size * size)
    const c = (size - 1) / 2
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) g[y * size + x] = Math.hypot(x - c, y - c) < size * 0.35 ? 1 : 0
    const contour = traceContour(g, size, 0.5)
    let lo = Infinity
    let hi = -Infinity
    for (const p of contour) {
      const r = Math.hypot(p.x, p.y)
      if (r < lo) lo = r
      if (r > hi) hi = r
    }
    check('contour of a disk is a closed near-circular loop', contour.length > 32 && hi - lo < 0.15)
  }

  // ---- Iterative CT reconstruction (the Tomography mode, algebraic solvers) ---

  // I1. The back-projector is the EXACT transpose of the projector:
  //     ⟨A x, y⟩ = ⟨x, Aᵀ y⟩. This is the one property the ART family needs to
  //     converge, and the reason SIRT/SART/CGLS are well posed here.
  {
    const size = 40
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 30)
    const g = geometryFromSino(sino, size)
    const rng = mulberry32(17)
    const x = new Float64Array(size * size)
    for (let i = 0; i < x.length; i++) x[i] = rng() - 0.5
    const y = new Float64Array(g.nAngles * g.nDet)
    for (let i = 0; i < y.length; i++) y[i] = rng() - 0.5
    const Ax = project(x, g)
    const Aty = backproject(y, g)
    let lhs = 0
    for (let i = 0; i < Ax.length; i++) lhs += Ax[i] * y[i]
    let rhs = 0
    for (let i = 0; i < x.length; i++) rhs += x[i] * Aty[i]
    const rel = Math.abs(lhs - rhs) / (Math.abs(lhs) + 1e-12)
    check('iterative projector: Aᵀ is the exact adjoint of A (⟨Ax,y⟩=⟨x,Aᵀy⟩)', rel < 1e-9)
  }

  // I2. The matrix-free forward projector reproduces the library's forwardRadon
  //     to machine precision — so a measured sinogram is a consistent b for Ax=b.
  {
    const size = 48
    const ph = makePhantom('circles', size)
    const sino = forwardRadon(ph, size, 24)
    const g = geometryFromSino(sino, size)
    const Ax = project(ph, g)
    let maxErr = 0
    for (let i = 0; i < Ax.length; i++) maxErr = Math.max(maxErr, Math.abs(Ax[i] - sino.data[i]))
    check('iterative forward projector matches forwardRadon (max err < 1e-9)', maxErr < 1e-9)
  }

  // I3. CGLS drives the least-squares residual down monotonically and
  //     reconstructs Shepp–Logan faithfully in a handful of iterations.
  {
    const size = 64
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 90)
    const g = geometryFromSino(sino, size)
    const { x, history } = reconstructIterative(
      sino.data,
      g,
      { method: 'cgls', relax: 1, nonneg: false, lambda: 0 },
      12,
    )
    let monotone = true
    for (let i = 1; i < history.length; i++) if (history[i] > history[i - 1] + 1e-9) monotone = false
    check('CGLS: residual monotone ↓ and reconstructs Shepp–Logan (corr > 0.9)', monotone && correlation(x, ph) > 0.9)
  }

  // I4. SIRT and SART both converge (residual falls) and recover the phantom;
  //     the non-negativity projection keeps SIRT ≥ 0 everywhere.
  {
    const size = 64
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 90)
    const g = geometryFromSino(sino, size)
    const sirt = reconstructIterative(sino.data, g, { method: 'sirt', relax: 1, nonneg: true, lambda: 0 }, 30)
    const sart = reconstructIterative(sino.data, g, { method: 'sart', relax: 1, nonneg: false, lambda: 0 }, 8)
    const sirtFell = sirt.history[sirt.history.length - 1] < sirt.history[0]
    const sartFell = sart.history[sart.history.length - 1] < sart.history[0]
    let nonneg = true
    for (let i = 0; i < sirt.x.length; i++) if (sirt.x[i] < -1e-9) nonneg = false
    const recovers = correlation(sirt.x, ph) > 0.85 && correlation(sart.x, ph) > 0.85
    check('SIRT & SART converge & recover; SIRT non-negativity holds', sirtFell && sartFell && nonneg && recovers)
  }

  // I5. SART reaches a given residual in FEWER sweeps than SIRT — the payoff of
  //     block-iterative updates (fresh information used sooner per sweep).
  {
    const size = 64
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 60)
    const g = geometryFromSino(sino, size)
    const nSweeps = 6
    const sirt = reconstructIterative(sino.data, g, { method: 'sirt', relax: 1, nonneg: false, lambda: 0 }, nSweeps)
    const sart = reconstructIterative(sino.data, g, { method: 'sart', relax: 1, nonneg: false, lambda: 0 }, nSweeps)
    check('SART converges faster per sweep than SIRT', sart.history[nSweeps - 1] < sirt.history[nSweeps - 1])
  }

  // I6. THE HEADLINE: under SPARSE views, iterative reconstruction beats FBP.
  //     With only 20 angles the ramp filter streaks; CGLS fits all rays jointly
  //     and correlates markedly better with the truth.
  {
    const size = 64
    const ph = makePhantom('shepp', size)
    const sino = forwardRadon(ph, size, 20)
    const g = geometryFromSino(sino, size)
    const fbpRec = fbp(sino, size, 'ramlak')
    const { x } = reconstructIterative(
      sino.data,
      g,
      { method: 'cgls', relax: 1, nonneg: false, lambda: 0 },
      20,
    )
    const cCgls = correlation(x, ph)
    const cFbp = correlation(fbpRec, ph)
    check('sparse-view (20 angles): CGLS beats FBP correlation', cCgls > cFbp)
  }

  // I7. The incremental solver (stepped like the UI drives it) reaches the same
  //     estimate as the batch helper — the animation and the math agree.
  {
    const size = 48
    const ph = makePhantom('circles', size)
    const sino = forwardRadon(ph, size, 45)
    const g = geometryFromSino(sino, size)
    const opts = { method: 'sirt' as const, relax: 1, nonneg: false, lambda: 0 }
    const solver = makeSolver(sino.data, g, opts)
    for (let k = 0; k < 15; k++) solver.step()
    const batch = reconstructIterative(sino.data, g, opts, 15)
    let maxErr = 0
    for (let i = 0; i < solver.x.length; i++) maxErr = Math.max(maxErr, Math.abs(solver.x[i] - batch.x[i]))
    check('stepped solver == batch solver (animation matches the math)', maxErr < 1e-9)
  }

  // ---- Compressed sensing (the Sensing mode) --------------------------------
  const relL2 = (a: Float64Array, b: Float64Array): number => {
    let num = 0
    let den = 0
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i]
      num += d * d
      den += b[i] * b[i]
    }
    return Math.sqrt(num / Math.max(den, 1e-30))
  }

  // 32. Every sparsifying basis is orthonormal: x = Mᵀ(Mx) to machine precision.
  {
    const N = 48
    let worst = 0
    for (const kind of ['spike', 'dct', 'fourier'] as BasisKind[]) {
      const M = basisMatrix(kind, N)
      const rng = mulberry32(11)
      const x = new Float64Array(N)
      for (let i = 0; i < N; i++) x[i] = rng() - 0.5
      const xr = matTVec(M, matVec(M, x, N, N), N, N)
      worst = Math.max(worst, relL2(xr, x))
    }
    check('every CS basis is orthonormal (exact round trip)', worst < 1e-9)
  }

  // 33. The composite operator's transpose is a true adjoint: ⟨Bx,y⟩ = ⟨x,Bᵀy⟩.
  {
    const cfg: RecoverConfig = { N: 40, k: 5, m: 20, basis: 'dct', operator: 'gaussian', solver: 'fista', lambda: 0.02, iterations: 10, noise: 0, seed: 3 }
    const { B } = buildProblem(cfg)
    const rng = mulberry32(5)
    const x = new Float64Array(40)
    for (let i = 0; i < 40; i++) x[i] = rng() - 0.5
    const yv = new Float64Array(20)
    for (let i = 0; i < 20; i++) yv[i] = rng() - 0.5
    const Bx = matVec(B, x, 20, 40)
    let lhs = 0
    for (let i = 0; i < 20; i++) lhs += Bx[i] * yv[i]
    const Bty = matTVec(B, yv, 20, 40)
    let rhs = 0
    for (let i = 0; i < 40; i++) rhs += x[i] * Bty[i]
    check('CS operator transpose is a true adjoint', Math.abs(lhs - rhs) < 1e-9)
  }

  // 34. Soft-threshold (the ℓ₁ proximal operator) shrinks toward zero correctly.
  {
    const t = softThreshold(new Float64Array([3, -3, 0.5, -0.4, 0]), 1)
    check('soft-threshold shrinks by the threshold', approxEqual(t[0], 2) && approxEqual(t[1], -2) && t[2] === 0 && t[3] === 0 && t[4] === 0)
  }

  // 35. FISTA recovers a k-sparse spike train exactly from m ≪ N measurements.
  {
    const cfg: RecoverConfig = { N: 128, k: 8, m: 48, basis: 'spike', operator: 'gaussian', solver: 'fista', lambda: 0.02, iterations: 400, noise: 0, seed: 42 }
    const r = recover(cfg)
    check('FISTA: exact recovery from 48 of 128 (spike/Gaussian)', r.exact && r.supportRecall > 0.999)
  }

  // 36. FISTA works transform-domain too: a DCT-sparse signal sensed by an
  //     (incoherent) Gaussian operator recovers exactly from 50 of 128.
  {
    const cfg: RecoverConfig = { N: 128, k: 6, m: 50, basis: 'dct', operator: 'gaussian', solver: 'fista', lambda: 0.02, iterations: 400, noise: 0, seed: 7 }
    const r = recover(cfg)
    check('FISTA: exact recovery (DCT-sparse signal)', r.exact)
  }

  // 36b. Partial-Fourier sensing of the same signal also works, but needs more
  //      measurements — DCT and Fourier are coherent bases (incoherence matters).
  {
    const cfg: RecoverConfig = { N: 128, k: 6, m: 64, basis: 'dct', operator: 'fourier', solver: 'fista', lambda: 0.02, iterations: 400, noise: 0, seed: 7 }
    const r = recover(cfg)
    check('FISTA: partial-Fourier recovery (coherent bases need more m)', r.exact)
  }

  // 37. OMP recovers the same signal exactly, by a different (greedy) route.
  {
    const cfg: RecoverConfig = { N: 128, k: 8, m: 48, basis: 'spike', operator: 'gaussian', solver: 'omp', lambda: 0, iterations: 0, noise: 0, seed: 42 }
    const r = recover(cfg)
    check('OMP: exact recovery of the same problem', r.exact)
  }

  // 38. The ℓ₂ (least-energy) baseline provably FAILS on the same data — the
  //     whole point: minimising energy spreads the answer, ℓ₁ finds the spikes.
  {
    const cfg: RecoverConfig = { N: 128, k: 8, m: 48, basis: 'spike', operator: 'gaussian', solver: 'l2', lambda: 0, iterations: 300, noise: 0, seed: 42 }
    const r = recover(cfg)
    check('min-ℓ₂ baseline fails where ℓ₁ succeeds', r.relError > 0.2)
  }

  // 39. ISTA's objective decreases monotonically (step ≤ 1/L), and FISTA's
  //     acceleration reaches a strictly lower objective in the same budget.
  {
    const cfg: RecoverConfig = { N: 96, k: 6, m: 40, basis: 'spike', operator: 'gaussian', solver: 'ista', lambda: 0.03, iterations: 150, noise: 0, seed: 9 }
    const { B, y } = buildProblem(cfg)
    const hi = ista(B, y, 0.03, 150, 40, 96).history
    const hf = fista(B, y, 0.03, 150, 40, 96).history
    let mono = true
    for (let i = 1; i < hi.length; i++) if (hi[i] > hi[i - 1] + 1e-9) mono = false
    check('ISTA monotone & FISTA accelerates below it', mono && hi[hi.length - 1] < hi[0] && hf[hf.length - 1] < hi[hi.length - 1])
  }

  // 40. The phase transition has the right corners: easy (few spikes, many
  //     measurements) recovers; hard (many spikes, few measurements) does not.
  {
    const pt = phaseTransition({ N: 40, basis: 'spike', operator: 'gaussian', solver: 'fista', mSteps: 5, kSteps: 5, trials: 4, iterations: 120, lambda: 0.02, seed: 1 })
    const cols = pt.mVals.length
    const rows = pt.kVals.length
    const easy = pt.field[0 * cols + (cols - 1)] // smallest k, largest m
    const hard = pt.field[(rows - 1) * cols + 0] // largest k, smallest m
    check('phase transition: easy corner recovers, hard corner does not', easy > 0.9 && hard < 0.5)
  }

  // ---- Resolve mode: super-resolution spectral estimation (v10) ----

  const angErr = (a: number, b: number) =>
    Math.abs((((a - b + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI)
  const nearestErr = (est: number[], truth: number[]) =>
    Math.max(...truth.map((t) => Math.min(...est.map((e) => angErr(e, t)))))
  const peaksOf = (grid: Float64Array, spec: Float64Array, count: number): number[] => {
    const ps: { w: number; v: number }[] = []
    for (let i = 1; i < spec.length - 1; i++)
      if (spec[i] > spec[i - 1] && spec[i] >= spec[i + 1]) ps.push({ w: grid[i], v: spec[i] })
    ps.sort((a, b) => b.v - a.v)
    return ps.slice(0, count).map((p) => p.w)
  }

  // 41. The Hermitian eigensolver reconstructs R and yields an orthonormal basis.
  {
    const M = 6
    const rng = spMulberry(7)
    const g = () => {
      const u = Math.max(rng(), 1e-12)
      const v = rng()
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    }
    const Hre = new Float64Array(M * M)
    const Him = new Float64Array(M * M)
    for (let i = 0; i < M; i++)
      for (let j = i; j < M; j++) {
        const a = g()
        const b = i === j ? 0 : g()
        Hre[i * M + j] = a
        Hre[j * M + i] = a
        Him[i * M + j] = b
        Him[j * M + i] = -b
      }
    const eig = spHermitianEig(Hre, Him, M)
    let maxErr = 0
    for (let i = 0; i < M; i++)
      for (let j = 0; j < M; j++) {
        let re = 0
        let im = 0
        for (let e = 0; e < M; e++) {
          const q = eig[e].vec
          const v = spCmul(q[i], spCconj(q[j]))
          re += eig[e].value * v.re
          im += eig[e].value * v.im
        }
        maxErr = Math.max(maxErr, Math.abs(re - Hre[i * M + j]), Math.abs(im - Him[i * M + j]))
      }
    let orth = 0
    for (let a = 0; a < M; a++)
      for (let b = 0; b < M; b++) {
        let re = 0
        let im = 0
        for (let k = 0; k < M; k++) {
          const v = spCmul(spCconj(eig[a].vec[k]), eig[b].vec[k])
          re += v.re
          im += v.im
        }
        orth = Math.max(orth, Math.abs(re - (a === b ? 1 : 0)), Math.abs(im))
      }
    check('Hermitian eig reconstructs R & is orthonormal', maxErr < 1e-8 && orth < 1e-8)
  }

  // A pair of complex tones separated by 0.35 of a DFT bin — deep sub-Rayleigh.
  const N1 = 64
  const M1 = 24
  const fs1 = N1
  const w1 = 0.6
  const w2 = 0.6 + 0.35 * ((2 * Math.PI) / N1)
  const t1 = (w1 / (2 * Math.PI)) * fs1
  const t2 = (w2 / (2 * Math.PI)) * fs1
  const cfg1: SpSignalConfig = {
    N: N1,
    fs: fs1,
    tones: [
      { freq: t1, amp: 1 },
      { freq: t2, amp: 1 },
    ],
    snrDb: 30,
    complex: true,
    seed: 12345,
  }
  const sig1 = spGenerate(cfg1)
  const cov1 = spCovariance(sig1.data, M1, true)
  const eig1 = spHermitianEig(cov1.Hre, cov1.Him, M1)
  const truth1 = [w1, w2]

  // 42. Root-MUSIC resolves the sub-Rayleigh pair to < 1% of a bin.
  {
    const est = spRootMusic(eig1, 2, M1).omegas.sort((a, b) => a - b)
    check('Root-MUSIC resolves two sub-Rayleigh tones', nearestErr(est, truth1) < 0.01)
  }
  // 43. ESPRIT resolves the same pair, by a completely different route.
  {
    const est = spEsprit(eig1, 2, M1).omegas.sort((a, b) => a - b)
    check('ESPRIT resolves two sub-Rayleigh tones', nearestErr(est, truth1) < 0.01)
  }
  // 44. The MUSIC pseudospectrum shows two distinct peaks at the tones.
  {
    const gridA = new Float64Array(4000)
    for (let i = 0; i < 4000; i++) gridA[i] = -Math.PI + (2 * Math.PI * i) / 4000
    const ps = spMusic(eig1, 2, M1, gridA)
    check('MUSIC pseudospectrum splits the pair into two peaks', nearestErr(peaksOf(gridA, ps, 2), truth1) < 0.02)
  }
  // 45. The FFT periodogram provably CANNOT split them — a single blurred lobe.
  {
    const gridA = new Float64Array(4000)
    for (let i = 0; i < 4000; i++) gridA[i] = -Math.PI + (2 * Math.PI * i) / 4000
    const per = spPeriodogram(sig1.data, gridA)
    check('periodogram fails to resolve (the Rayleigh wall)', nearestErr(peaksOf(gridA, per, 2), truth1) > 0.02)
  }
  // 46. Burg (max-entropy AR) resolves a moderately-separated pair (0.8 bin).
  {
    const wa = 0.6
    const wb = 0.6 + 0.8 * ((2 * Math.PI) / N1)
    const cfg: SpSignalConfig = {
      N: N1,
      fs: fs1,
      tones: [
        { freq: (wa / (2 * Math.PI)) * fs1, amp: 1 },
        { freq: (wb / (2 * Math.PI)) * fs1, amp: 1 },
      ],
      snrDb: 30,
      complex: true,
      seed: 77,
    }
    const s = spGenerate(cfg)
    const gridA = new Float64Array(4000)
    for (let i = 0; i < 4000; i++) gridA[i] = -Math.PI + (2 * Math.PI * i) / 4000
    const ar = spArSpectrum(spBurg(s.data, 14), gridA)
    check('Burg MEM resolves a moderately-separated pair', nearestErr(peaksOf(gridA, ar, 2), [wa, wb]) < 0.02)
  }
  // 47. MDL correctly counts three well-separated complex sources.
  {
    const cfg: SpSignalConfig = {
      N: 128,
      fs: 1,
      tones: [
        { freq: -0.25, amp: 1 },
        { freq: 0.05, amp: 0.8 },
        { freq: 0.3, amp: 1.2 },
      ],
      snrDb: 25,
      complex: true,
      seed: 999,
    }
    const s = spGenerate(cfg)
    const cov = spCovariance(s.data, 40, true)
    const eig = spHermitianEig(cov.Hre, cov.Him, 40)
    const om = spAicMdl(
      eig.map((e) => e.value),
      cov.L,
      40,
    )
    check('MDL counts three complex sources', om.kMDL === 3)
  }
  // 48. analyze() end-to-end recovers three real tones (120/128/300 Hz) via
  //     root-MUSIC, and MDL counts the six underlying complex exponentials.
  {
    const cfg: SpSignalConfig = {
      N: 160,
      fs: 1000,
      tones: [
        { freq: 120, amp: 1 },
        { freq: 128, amp: 0.9 },
        { freq: 300, amp: 1 },
      ],
      snrDb: 25,
      complex: false,
      seed: 4242,
    }
    const s = spGenerate(cfg)
    const res = spAnalyze(s, cfg, {
      M: 40,
      p: 6,
      autoOrder: false,
      forwardBackward: true,
      burgOrder: 20,
      gridSize: 2000,
      methods: ['periodogram', 'music'],
    })
    const got = res.rootMusic.freqsHz
    const near = (f: number) => Math.min(...got.map((x) => Math.abs(x - f)))
    const om = spAicMdl(res.eigenvalues, res.L, 40)
    check(
      'analyze() recovers 120/128/300 Hz and MDL counts 6',
      near(120) < 2 && near(128) < 2 && near(300) < 2 && om.kMDL === 6,
    )
  }
  // 49. The FFT baselines resolve WELL-separated tones (guards the fftshift/resample
  //     path that feeds the periodogram + Welch overlays onto the shared ω axis).
  {
    const cfg: SpSignalConfig = {
      N: 128,
      fs: 128,
      tones: [
        { freq: 20, amp: 1 },
        { freq: 45, amp: 0.8 },
      ],
      snrDb: 40,
      complex: true,
      seed: 3,
    }
    const s = spGenerate(cfg)
    const G = 2000
    const gridA = new Float64Array(G)
    for (let i = 0; i < G; i++) gridA[i] = -Math.PI + (2 * Math.PI * i) / G
    const gridHz = Array.from(gridA, (w) => (w / (2 * Math.PI)) * 128)
    const peakHz = (curve: Float64Array): number[] => {
      const p: { f: number; v: number }[] = []
      for (let i = 1; i < curve.length - 1; i++)
        if (curve[i] > curve[i - 1] && curve[i] >= curve[i + 1]) p.push({ f: gridHz[i], v: curve[i] })
      p.sort((a, b) => b.v - a.v)
      return p.slice(0, 2).map((x) => x.f).sort((a, b) => a - b)
    }
    const pp = peakHz(spPeriodogram(s.data, gridA))
    const wp = peakHz(spWelch(s.data, gridA, 64, 0.5))
    check(
      'periodogram & Welch locate two separated tones (20/45 Hz)',
      Math.abs(pp[0] - 20) < 1 && Math.abs(pp[1] - 45) < 1 && Math.abs(wp[0] - 20) < 1.5 && Math.abs(wp[1] - 45) < 1.5,
    )
  }

  // ===== Digital communications (the Modem lab) =====

  // 37. Gray code is an involution-free bijection whose neighbours differ in one
  //     bit: grayDecode∘grayEncode = id, and grayEncode(i) vs grayEncode(i+1)
  //     is a single-bit flip.
  {
    let ok = true
    for (let i = 0; i < 256; i++) if (grayDecode(grayEncode(i)) !== i) ok = false
    let oneBit = true
    for (let i = 0; i < 255; i++) {
      const diff = grayEncode(i) ^ grayEncode(i + 1)
      if (diff === 0 || (diff & (diff - 1)) !== 0) oneBit = false // not a power of two
    }
    check('Gray code round-trips and adjacent labels differ by one bit', ok && oneBit)
  }

  // 38. Every constellation has unit average symbol energy (the invariant the
  //     whole Eb/N0 bookkeeping rests on).
  {
    let ok = true
    for (const s of SCHEMES) {
      const c = constellation(s.id)
      let e = 0
      for (const p of c.points) e += p.re * p.re + p.im * p.im
      if (Math.abs(e / c.M - 1) > 1e-9) ok = false
    }
    check('all constellations are normalized to unit average energy', ok)
  }

  // 39. map→demap is exact with no noise, for every scheme (the modulator and
  //     the hard-decision demodulator are true inverses over random bits).
  {
    let ok = true
    for (const s of SCHEMES) {
      const rng = commsRng(7 + s.M)
      const bits = randomBits(s.bitsPerSymbol * 4000, rng)
      const sym = mapBits(bits, s.id)
      const back = demapSymbols(sym.re, sym.im, s.id)
      for (let i = 0; i < bits.length; i++) if (bits[i] !== back[i]) ok = false
    }
    check('map→demap is lossless at zero noise for BPSK/QPSK/16-/64-QAM', ok)
  }

  // 40. Gray labelling: physically nearest constellation neighbours (distance =
  //     the minimum spacing) differ in exactly one bit. This is what makes
  //     BER ≈ SER/k at high SNR.
  {
    let ok = true
    for (const s of SCHEMES) {
      if (s.id === 'bpsk') continue
      const c = constellation(s.id)
      // Minimum nonzero pairwise distance.
      let dmin = Infinity
      for (let a = 0; a < c.points.length; a++)
        for (let b = a + 1; b < c.points.length; b++) {
          const dr = c.points[a].re - c.points[b].re
          const di = c.points[a].im - c.points[b].im
          const d = Math.sqrt(dr * dr + di * di)
          if (d > 1e-9 && d < dmin) dmin = d
        }
      for (let a = 0; a < c.points.length; a++)
        for (let b = a + 1; b < c.points.length; b++) {
          const dr = c.points[a].re - c.points[b].re
          const di = c.points[a].im - c.points[b].im
          const d = Math.sqrt(dr * dr + di * di)
          if (Math.abs(d - dmin) < 1e-6) {
            let flips = 0
            for (let j = 0; j < s.bitsPerSymbol; j++) if (c.points[a].bits[j] !== c.points[b].bits[j]) flips++
            if (flips !== 1) ok = false
          }
        }
    }
    check('Gray map: nearest constellation neighbours differ in one bit', ok)
  }

  // 41. The rational erfc/Q-function matches known values and its identities:
  //     Q(0)=½, Q(−x)=1−Q(x), erfc(0)=1, and Q(1)≈0.158655.
  {
    const ok =
      approxEqual(qfunc(0), 0.5, 1e-6) &&
      approxEqual(erfc(0), 1, 1e-6) &&
      approxEqual(qfunc(-1.3) + qfunc(1.3), 1, 1e-6) &&
      Math.abs(qfunc(1) - 0.1586552539) < 1e-4 &&
      Math.abs(qfunc(2) - 0.0227501319) < 1e-4
    check('Q-function via erfc matches known values and symmetry', ok)
  }

  // 42. Theory BER is strictly decreasing in Eb/N0 for every scheme, and at a
  //     fixed Eb/N0 a denser constellation is worse (BPSK < 16-QAM < 64-QAM BER).
  {
    let monotone = true
    for (const s of SCHEMES) {
      let prev = 1
      for (let db = -2; db <= 16; db += 1) {
        const p = theoryBER(s.id, db)
        if (p > prev + 1e-12) monotone = false
        prev = p
      }
    }
    const at10 = (id: Scheme) => theoryBER(id, 10)
    const ordered = at10('bpsk') < at10('qam16') && at10('qam16') < at10('qam64')
    check('theory BER decreases with Eb/N0 and worsens with density', monotone && ordered)
  }

  // 43. Monte-Carlo BER tracks the closed form. BPSK/QPSK are exact theory;
  //     16-QAM uses the tight nearest-neighbour approximation. Measure at an SNR
  //     that yields plenty of errors so the sample rate is stable.
  {
    const trials: { id: Scheme; db: number; tol: number; nsym: number }[] = [
      { id: 'bpsk', db: 4, tol: 0.15, nsym: 120000 },
      { id: 'qpsk', db: 4, tol: 0.15, nsym: 120000 },
      { id: 'qam16', db: 10, tol: 0.28, nsym: 120000 },
    ]
    let ok = true
    for (const t of trials) {
      const r = simulateLink(t.id, t.db, t.nsym, 12345)
      const th = theoryBER(t.id, t.db)
      if (th <= 0) continue
      const rel = Math.abs(r.ber - th) / th
      if (rel > t.tol) ok = false
    }
    check('Monte-Carlo BER tracks closed-form theory (BPSK/QPSK/16-QAM)', ok)
  }

  // 44. The AWGN generator delivers the requested variance: over many samples the
  //     empirical per-dimension variance equals σ² set from Eb/N0.
  {
    const sigma = ebn0ToSigma(6, 2)
    const rng = commsRng(999)
    let s = 0
    let ss = 0
    const N = 200000
    for (let i = 0; i < N; i++) {
      const g = sigma * commsGaussian(rng)
      s += g
      ss += g * g
    }
    const mean = s / N
    const varEmp = ss / N - mean * mean
    check('AWGN variance matches the Eb/N0 setting', Math.abs(varEmp - sigma * sigma) / (sigma * sigma) < 0.05 && Math.abs(mean) < 0.02)
  }

  // 45. Root-raised-cosine taps have unit energy, and the matched cascade RRC⊛RRC
  //     is a raised cosine: ~1 at its center and ~0 at every other symbol instant
  //     (the zero-ISI Nyquist property that opens the eye).
  {
    const beta = 0.25
    const sps = 8
    const span = 8
    const rrc = rrcTaps(beta, sps, span)
    let e = 0
    for (let i = 0; i < rrc.length; i++) e += rrc[i] * rrc[i]
    const comb = convolveReal(rrc, rrc)
    const center = rrc.length - 1 // peak of the symmetric cascade
    const peak = comb[center]
    let maxIsi = 0
    for (let m = 1; m <= span; m++) {
      if (center - m * sps >= 0) maxIsi = Math.max(maxIsi, Math.abs(comb[center - m * sps]))
      if (center + m * sps < comb.length) maxIsi = Math.max(maxIsi, Math.abs(comb[center + m * sps]))
    }
    check('RRC has unit energy and RRC⊛RRC is zero-ISI (Nyquist)', Math.abs(e - 1) < 1e-9 && maxIsi / peak < 0.02)
  }

  // 46. Reference raised cosine is itself zero-ISI: zero at every nonzero symbol
  //     instant, one at the center.
  {
    const rc = rcTaps(0.35, 8, 6)
    const center = (rc.length - 1) / 2
    let ok = Math.abs(rc[center] - 1) < 1e-9
    for (let m = 1; m <= 6; m++) {
      if (Math.abs(rc[center - m * 8]) > 1e-9) ok = false
      if (Math.abs(rc[center + m * 8]) > 1e-9) ok = false
    }
    check('raised-cosine reference is zero-ISI at symbol instants', ok)
  }

  // 47. The full shaping chain recovers symbols with negligible ISI in the clear:
  //     upsample → RRC(Tx) → RRC(Rx) → sample lands back on the transmitted
  //     constellation (matched-filter peak), so a noiseless link is error-free.
  {
    const rng = commsRng(3)
    const scheme: Scheme = 'qpsk'
    const bits = randomBits(2 * 500, rng)
    const sym = mapBits(bits, scheme)
    const sps = 8
    const span = 8
    const rrc = rrcTaps(0.25, sps, span)
    const up = upsample(sym.re, sym.im, sps)
    const tx = firComplex(up, rrc)
    const rx = firComplex(tx, rrc)
    const delay = rrc.length - 1
    const rr = sampleSymbols(rx, sps, delay, sym.length)
    // Normalize to unit average power then demap.
    let p = 0
    for (let i = 0; i < rr.length; i++) p += rr.re[i] * rr.re[i] + rr.im[i] * rr.im[i]
    const g = Math.sqrt(rr.length / p)
    for (let i = 0; i < rr.length; i++) {
      rr.re[i] *= g
      rr.im[i] *= g
    }
    const back = demapSymbols(rr.re, rr.im, scheme)
    let errs = 0
    // Ignore the first/last `span` symbols (filter transients).
    for (let i = span * 2; i < bits.length - span * 2; i++) if (bits[i] !== back[i]) errs++
    check('RRC Tx/Rx chain is ISI-free (noiseless link error-free)', errs === 0)
  }

  // 48. OFDM round-trips perfectly through a flat channel with no noise: the FFT
  //     of the IFFT (minus the CP) reproduces exactly the transmitted subcarriers.
  {
    const nfft = 64
    const cfg = { nfft, cpLen: 8, active: activeCarriers(nfft, 3) }
    const scheme: Scheme = 'qam16'
    const nActive = cfg.active.length
    const rng = commsRng(11)
    const bits = randomBits(scheme === 'qam16' ? 4 * nActive * 4 : nActive, rng)
    const sym = mapBits(bits, scheme)
    const tx = modulate(sym.re, sym.im, cfg)
    const dem = demodulate(tx, cfg) // H = 1
    let maxErr = 0
    for (let i = 0; i < sym.length && i < dem.symRe.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(dem.symRe[i] - sym.re[i]), Math.abs(dem.symIm[i] - sym.im[i]))
    }
    check('OFDM IFFT→FFT round-trips subcarriers exactly (flat channel)', maxErr < 1e-9)
  }

  // 49. The OFDM magic: with a cyclic prefix ≥ the channel memory, a frequency-
  //     selective multipath channel becomes N independent flat gains. A one-tap
  //     zero-forcing equalizer inverts each subcarrier and recovers the symbols
  //     exactly, with no noise — even through a rich echo channel.
  {
    const nfft = 128
    const ch = CHANNELS.find((c) => c.id === 'multipath')!
    const cfg = { nfft, cpLen: 16, active: activeCarriers(nfft, 4) }
    const scheme: Scheme = 'qpsk'
    const nActive = cfg.active.length
    const rng = commsRng(21)
    const bits = randomBits(2 * nActive * 3, rng)
    const sym = mapBits(bits, scheme)
    const tx = modulate(sym.re, sym.im, cfg)
    const rxSig = applyChannel(tx, ch.hRe, ch.hIm)
    const H = channelResponse(ch.hRe, ch.hIm, nfft)
    const dem = demodulate({ re: rxSig.re, im: rxSig.im, length: rxSig.length }, cfg, H)
    let maxErr = 0
    for (let i = 0; i < sym.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(dem.symRe[i] - sym.re[i]), Math.abs(dem.symIm[i] - sym.im[i]))
    }
    // And without equalization the multipath badly corrupts the symbols.
    const demRaw = demodulate({ re: rxSig.re, im: rxSig.im, length: rxSig.length }, cfg)
    let rawErr = 0
    for (let i = 0; i < sym.length; i++) {
      rawErr = Math.max(rawErr, Math.abs(demRaw.symRe[i] - sym.re[i]))
    }
    check('OFDM CP + 1-tap equalizer inverts multipath exactly', maxErr < 1e-9 && rawErr > 0.1)
  }

  // 50. PAPR is well defined and ≥ 0 dB, and a single active subcarrier (a pure
  //     complex sinusoid) has ~0 dB PAPR (constant envelope), while a full OFDM
  //     symbol has a substantially higher peak.
  {
    const nfft = 64
    const one = { nfft, cpLen: 0, active: [5] }
    const tone = modulate([1], [0], one)
    const single = paprDb({ re: tone.re, im: tone.im, length: tone.length })
    const cfg = { nfft, cpLen: 8, active: activeCarriers(nfft, 3) }
    const rng = commsRng(5)
    const bits = randomBits(2 * cfg.active.length, rng)
    const sym = mapBits(bits, 'qpsk')
    const full = modulate(sym.re, sym.im, cfg)
    const many = paprDb({ re: full.re, im: full.im, length: full.length })
    check('PAPR: single tone ≈ 0 dB, full OFDM symbol is peakier', single < 0.2 && many > single + 2)
  }

  // ---- forward error correction: convolutional codes + Viterbi (v10) --------

  // 51. Published free distances are re-derived from each trellis, and the (7,5)
  //     distance spectrum matches the textbook {1,2,4,8,…} / {1,4,12,32,…}.
  {
    const want: Record<string, number> = { k3_r12: 5, k4_r12: 6, k5_r12: 7, k7_r12: 10, k7_r13: 15 }
    let ok = true
    for (const c of CONV_CODES) {
      const spec = distanceSpectrum(buildTrellis(c))
      if (spec.dFree !== want[c.id]) ok = false
    }
    // the classic (7,5) K=3 spectrum
    const s = distanceSpectrum(buildTrellis(CONV_CODES[0]))
    const aOk = s.terms[0].aCount === 1 && s.terms[1].aCount === 2 && s.terms[2].aCount === 4
    const cOk = s.terms[0].cInfo === 1 && s.terms[1].cInfo === 4 && s.terms[2].cInfo === 12
    check('conv codes: d_free matches published values, (7,5) spectrum exact', ok && aOk && cOk)
  }

  // 52. Encode → decode is exact on a noiseless channel for every code, both
  //     hard and soft, with the K−1 flush bits correctly removed.
  {
    let ok = true
    for (const c of CONV_CODES) {
      const tr = buildTrellis(c)
      const rng = fecRng(7)
      const msg = new Uint8Array(120)
      for (let i = 0; i < msg.length; i++) msg[i] = rng() < 0.5 ? 0 : 1
      const coded = convEncode(msg, tr)
      const soft = Float64Array.from(coded, (b) => 1 - 2 * b)
      const dh = viterbiHard(coded, tr)
      const ds = viterbiSoft(soft, tr)
      if (dh.decoded.length !== msg.length || ds.decoded.length !== msg.length) ok = false
      for (let i = 0; i < msg.length; i++) if (dh.decoded[i] !== msg[i] || ds.decoded[i] !== msg[i]) ok = false
    }
    check('Viterbi (hard & soft) inverts the encoder exactly with no noise', ok)
  }

  // 53. The single-error-correcting reach: the (7,5) code, d_free 5, must fix any
  //     one flipped coded bit within a block.
  {
    const tr = buildTrellis(CONV_CODES[0])
    const rng = fecRng(31)
    const msg = new Uint8Array(24)
    for (let i = 0; i < msg.length; i++) msg[i] = rng() < 0.5 ? 0 : 1
    const coded = convEncode(msg, tr)
    let allFixed = true
    for (let e = 0; e < coded.length; e++) {
      const rx = coded.slice()
      rx[e] ^= 1
      const dec = viterbiHard(rx, tr)
      for (let i = 0; i < msg.length; i++) if (dec.decoded[i] !== msg[i]) allFixed = false
    }
    check('(7,5) hard Viterbi corrects any single coded-bit error', allFixed)
  }

  // 54. The union bound is a valid *upper* bound past threshold, and soft beats
  //     hard beats uncoded in Monte-Carlo at a useful Eb/N0.
  {
    const tr = buildTrellis(CONV_CODES[3]) // K=7 (171,133)
    const spec = distanceSpectrum(tr)
    const r = simulateCoded(tr, { msgBits: 20000, ebn0Db: 4, punc: PUNCTURES[0], seed: 4242 })
    const ubS = unionBoundSoft(spec, r.rate, 4)
    const ubH = unionBoundHard(spec, r.rate, 4)
    const ordering = r.softBer <= r.hardBer + 1e-9 && r.hardBer < r.uncodedBer
    const bounded = r.softBer <= ubS + 1e-6 && r.hardBer <= ubH + 1e-6
    check('coded link: soft ≤ hard < uncoded, and measured ≤ union bound (4 dB)', ordering && bounded)
  }

  // 55. Soft decoding gives a real coding gain: at 4 dB the K=7 code's soft BER is
  //     at least an order of magnitude below uncoded BPSK.
  {
    const tr = buildTrellis(CONV_CODES[3])
    const r = simulateCoded(tr, { msgBits: 30000, ebn0Db: 4, punc: PUNCTURES[0], seed: 99 })
    check('K=7 soft Viterbi is ≥10× below uncoded BPSK at 4 dB', r.softBer * 10 <= uncodedBer(4))
  }

  // 56. Puncturing raises the rate exactly (1/2 → 2/3 → 3/4 → 5/6) and the
  //     depuncture/apply-puncture pair round-trips the kept bits with erasures.
  {
    const rateOk =
      approxEqual(punctureRate(2, PUNCTURES[0]), 1 / 2, 1e-12) &&
      approxEqual(punctureRate(2, PUNCTURES[1]), 2 / 3, 1e-12) &&
      approxEqual(punctureRate(2, PUNCTURES[2]), 3 / 4, 1e-12) &&
      approxEqual(punctureRate(2, PUNCTURES[3]), 5 / 6, 1e-12)
    const tr = buildTrellis(CONV_CODES[3])
    const rng = fecRng(5)
    const msg = new Uint8Array(60)
    for (let i = 0; i < msg.length; i++) msg[i] = rng() < 0.5 ? 0 : 1
    const coded = convEncode(msg, tr)
    const steps = coded.length / tr.n
    const punc = PUNCTURES[2]
    const tx = applyPuncture(coded, tr.n, punc)
    const { full, mask } = depuncture(tx, tr.n, punc, steps, 0)
    let rt = true
    let r = 0
    for (let i = 0; i < full.length; i++) {
      if (mask[i]) {
        if (full[i] !== coded[i]) rt = false
        r++
      }
    }
    check('puncturing: rates 1/2→2/3→3/4→5/6 exact and de-puncture round-trips', rateOk && rt && r === tx.length)
  }

  // 57. A punctured (rate-3/4) coded link still corrects: at a modest Eb/N0 the
  //     decoded BER sits well below the raw channel bit-error rate.
  {
    const tr = buildTrellis(CONV_CODES[3])
    const r = simulateCoded(tr, { msgBits: 30000, ebn0Db: 5, punc: PUNCTURES[2], seed: 606 })
    check('rate-3/4 punctured link decodes below the channel BER (5 dB)', r.softBer < r.channelBer)
  }

  // 58. Text ⇄ bits round-trips, and a message wrapped in the K=7 code survives a
  //     channel that shreds the same bits sent uncoded.
  {
    const text = 'HELLO WORLD 12345'
    const rt = bitsToText(textToBits(text)) === text
    const tr = buildTrellis(CONV_CODES[3])
    const r = simulateCoded(tr, { msgBits: 4000, ebn0Db: 3, punc: PUNCTURES[0], seed: 2024 })
    check('text↔bits round-trips; coded message far outlives uncoded at 3 dB', rt && r.softBer < r.uncodedBer)
  }

  // ---- Adaptive filters & Kalman (mode: Adaptive) ------------------------

  // Shared helpers: a small dense solve and the convolution the scenarios use.
  // 59. solveSmall recovers the solution of a known linear system.
  {
    // [[2,1],[1,3]]·z = [5,10] → z = [1,3].
    const A = new Float64Array([2, 1, 1, 3])
    const b = new Float64Array([5, 10])
    const z = solveSmall(A, b, 2)
    check('solveSmall: 2×2 Gaussian elimination is exact', approxEqual(z[0], 1, 1e-9) && approxEqual(z[1], 3, 1e-9))
  }

  // 60. convolve matches a hand-computed short convolution.
  {
    const c = adConvolve(new Float64Array([1, 2, 3]), new Float64Array([1, 1]))
    // [1, 3, 5, 3]
    check('convolve: full linear convolution is correct', c.length === 4 && c[0] === 1 && c[1] === 3 && c[2] === 5 && c[3] === 3)
  }

  const sysid: ScenarioConfig = {
    scenario: 'sysid',
    N: 3000,
    plantLen: 8,
    color: 0,
    snrDb: 45,
    freq: 0.02,
    channel: 0,
    arA1: 0.6,
    arA2: -0.8,
    delay: 8,
  }
  const baseAlgo: AlgoConfig = { algo: 'lms', L: 16, mu: 0.05, lambda: 1.0, delta: 0.01, apaOrder: 4, eps: 1e-3 }

  // 61. LMS identifies an unknown FIR plant (white input) to good misalignment.
  {
    const sc = makeScenario(sysid, 12345)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'lms', mu: 0.05 })
    const mis = misalignmentDb(run.w, sc.truth!)
    check('LMS identifies the plant (misalignment < −20 dB)', mis < -20)
  }

  // 62. NLMS identifies the same plant, more robustly to step size.
  {
    const sc = makeScenario(sysid, 12345)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'nlms', mu: 0.5 })
    check('NLMS identifies the plant (misalignment < −25 dB)', misalignmentDb(run.w, sc.truth!) < -25)
  }

  // 63. APA (affine projection, order 4) converges too.
  {
    const sc = makeScenario(sysid, 12345)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'apa', mu: 0.3, apaOrder: 4 })
    check('APA identifies the plant (misalignment < −20 dB)', misalignmentDb(run.w, sc.truth!) < -20)
  }

  // 64. RLS converges to the exact least-squares (Wiener) solution: the adaptive
  //     recursion and the batch normal-equation solve agree to high precision.
  {
    const sc = makeScenario(sysid, 12345)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'rls', lambda: 1.0, delta: 0.01 })
    const wStar = wienerSolution(sc.u, sc.d, 16)
    check('RLS == Wiener/least-squares solution (misalignment < −40 dB)', misalignmentDb(run.w, wStar) < -40)
  }

  // 65. RLS is strictly more accurate than LMS on the same data (its exactness).
  {
    const sc = makeScenario(sysid, 777)
    const lms = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'lms', mu: 0.05 })
    const rls = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'rls', lambda: 1.0 })
    check('RLS beats LMS misalignment on identical data', misalignmentDb(rls.w, sc.truth!) < misalignmentDb(lms.w, sc.truth!))
  }

  // 66. Coloured input (eigenvalue spread) hurts LMS's steady-state MSE far more
  //     than RLS — the classic reason to pay for RLS.
  {
    const white: ScenarioConfig = { ...sysid, color: 0 }
    const colored: ScenarioConfig = { ...sysid, color: 0.85 }
    const tailMse = (cfg: ScenarioConfig, a: AlgoConfig) => {
      const sc = makeScenario(cfg, 2024)
      const r = runAdaptive(sc.u, sc.d, a)
      let s = 0
      for (let n = 2500; n < 3000; n++) s += r.e[n] * r.e[n]
      return s / 500
    }
    const lmsWhite = tailMse(white, { ...baseAlgo, algo: 'lms', mu: 0.05 })
    const lmsColor = tailMse(colored, { ...baseAlgo, algo: 'lms', mu: 0.05 })
    const rlsColor = tailMse(colored, { ...baseAlgo, algo: 'rls', lambda: 1.0 })
    check('coloured input degrades LMS more than RLS (eigenvalue spread)', lmsColor > lmsWhite && lmsColor > rlsColor * 2)
  }

  // 67. The ensemble learning curve descends: the averaged MSE over the final
  //     stretch is far below the initial transient (weights start at zero).
  {
    const { curvesDb } = learningCurves(sysid, [{ ...baseAlgo, algo: 'rls', lambda: 1.0 }], 12, 500)
    const c = curvesDb[0]
    const mean = (a: number, b: number) => {
      let s = 0
      for (let i = a; i < b; i++) s += c[i]
      return s / (b - a)
    }
    check('RLS learning curve descends (end ≪ start)', mean(c.length - 200, c.length) < mean(0, 6) - 20)
  }

  // 68. Adaptive noise cancellation: a tone buried under correlated noise is
  //     recovered — the RLS canceller lifts SNR by >15 dB.
  {
    const anc: ScenarioConfig = { ...sysid, scenario: 'anc', N: 4000, snrDb: 40, freq: 0.02 }
    const sc = makeScenario(anc, 7)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'rls', L: 12, lambda: 1.0 })
    const snrIn = snrDbTail(sc.clean!, sc.d)
    const snrOut = snrDbTail(sc.clean!, run.e) // recovered signal = error output
    check('ANC lifts SNR by > 15 dB (RLS canceller)', snrOut - snrIn > 15)
  }

  // 69. Channel equalization: after training, tail symbol decisions are (nearly)
  //     error-free on the mild Proakis-B channel at a good SNR.
  {
    const eq: ScenarioConfig = { ...sysid, scenario: 'equalize', N: 6000, channel: 0, snrDb: 25, delay: 8 }
    const sc = makeScenario(eq, 99)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'rls', L: 21, lambda: 0.999 })
    let err = 0
    let cnt = 0
    for (let n = 5000; n < 6000; n++) {
      const dec = run.y[n] >= 0 ? 1 : -1
      if (n - 8 >= 0) {
        if (dec !== sc.symbols![n - 8]) err++
        cnt++
      }
    }
    check('equalizer drives tail SER below 1% (Proakis-B, 25 dB)', err / cnt < 0.01)
  }

  // 70. …and the equalized combined response channel⊛equalizer approximates a
  //     unit delay: one dominant tap near Δ, the rest suppressed (opened eye).
  {
    const eq: ScenarioConfig = { ...sysid, scenario: 'equalize', N: 6000, channel: 0, snrDb: 30, delay: 8 }
    const sc = makeScenario(eq, 99)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'rls', L: 21, lambda: 0.999 })
    const comb = adConvolve(sc.channelTaps!, run.w)
    let peak = 0
    let peakIdx = 0
    let energy = 0
    for (let i = 0; i < comb.length; i++) {
      energy += comb[i] * comb[i]
      if (Math.abs(comb[i]) > peak) {
        peak = Math.abs(comb[i])
        peakIdx = i
      }
    }
    // Dominant tap carries most of the energy → residual ISI is small.
    check('equalized response ≈ a clean delay (dominant tap)', peak * peak > 0.8 * energy && Math.abs(peakIdx - 8) <= 2)
  }

  // 71. Linear prediction: a one-step predictor of a sharp AR(2) resonance learns
  //     the AR coefficients and yields a large prediction (whitening) gain.
  {
    const pr: ScenarioConfig = { ...sysid, scenario: 'predict', N: 4000, arA1: 1.5, arA2: -0.95 }
    const sc = makeScenario(pr, 3)
    const run = runAdaptive(sc.u, sc.d, { ...baseAlgo, algo: 'rls', L: 8, lambda: 1.0 })
    let varU = 0
    let varE = 0
    for (let n = 2000; n < 4000; n++) {
      varU += sc.clean![n] * sc.clean![n]
      varE += run.e[n] * run.e[n]
    }
    const gainDb = 10 * Math.log10(varU / varE)
    const tapsOk = approxEqual(run.w[0], 1.5, 0.1) && approxEqual(run.w[1], -0.95, 0.1)
    check('predictor learns AR(2) taps and whitens (gain > 8 dB)', gainDb > 8 && tapsOk)
  }

  // 72. Kalman filter: on a random-acceleration target the state estimate beats
  //     the raw noisy measurements in position RMSE.
  {
    const run = runKalman(
      { N: 500, dt: 0.1, sigmaA: 1.0, sigmaMeas: 1.5, trueSigmaA: 0.8, motion: 'randomwalk' },
      42,
    )
    check('Kalman RMSE < measurement RMSE (random-walk target)', run.rmseKalman < run.rmseMeas)
  }

  // 73. Kalman covariance converges to a bounded steady state below the raw
  //     measurement variance (the filter genuinely fuses past + present).
  {
    const run = runKalman(
      { N: 400, dt: 0.1, sigmaA: 0.5, sigmaMeas: 1.5, trueSigmaA: 0.5, motion: 'sine' },
      7,
    )
    const ss = run.posStd[run.posStd.length - 1]
    check('Kalman position uncertainty settles below the measurement σ', ss > 0 && ss < 1.5)
  }

  // 74. LDPC systematic encoder: every code satisfies H·c = 0 and round-trips the
  //     message bits back out of the codeword for random messages.
  {
    let ok = true
    for (const code of ldpcCatalogue()) {
      const rng = ldpcRng(12345)
      for (let t = 0; t < 12; t++) {
        const msg = new Uint8Array(code.k)
        for (let i = 0; i < code.k; i++) msg[i] = rng() < 0.5 ? 0 : 1
        const c = ldpcEncode(code, msg)
        if (ldpcSyndrome(code, c) !== 0) ok = false
        const back = ldpcExtract(code, c)
        for (let i = 0; i < code.k; i++) if (back[i] !== msg[i]) ok = false
      }
      if (code.k !== code.n - code.rank) ok = false
    }
    check('LDPC encode satisfies H·c=0 and is systematic (all codes)', ok)
  }

  // 75. Belief propagation: at a comfortable SNR every decoder in the family
  //     recovers the transmitted block almost always.
  {
    const code = ldpcById('peg_96_48')
    let worst = 1
    for (const algo of ['sp', 'ms', 'nms', 'oms'] as const) {
      let succ = 0
      const trials = 40
      for (let s = 0; s < trials; s++) {
        if (ldpcDecodeDemo(code, 5, algo, 40, 3000 + s).recovered) succ++
      }
      worst = Math.min(worst, succ / trials)
    }
    check('LDPC decoders recover ≥90% of blocks at 5 dB (all four schedules)', worst >= 0.9)
  }

  // 76. Coding gain: sum-product BER sits far below uncoded BPSK at the same Eb/N0.
  {
    const code = ldpcById('peg_96_48')
    const pt = ldpcWaterfall(code, 'sp', [3.5], 40, {
      minBlocks: 200,
      maxBlocks: 1200,
      targetBlockErrors: 30,
      seed: 5,
    })[0]
    check('LDPC sum-product BER << uncoded BPSK at 3.5 dB', pt.ber < ldpcUncodedBer(3.5) * 0.25)
  }

  // 77. Sum-product is the strongest of the four (min-sum never beats it materially),
  //     and a PEG code has girth ≥ 6 (no 4-cycles) while the dense Hamming code is girth-4.
  {
    const code = ldpcById('peg_96_48')
    const budget = { minBlocks: 200, maxBlocks: 1200, targetBlockErrors: 30, seed: 9 }
    const sp = ldpcWaterfall(code, 'sp', [2.5], 40, budget)[0]
    const ms = ldpcWaterfall(code, 'ms', [2.5], 40, budget)[0]
    const gainOk = sp.ber <= ms.ber * 1.5 + 1e-9
    const girthOk = ldpcGirth(ldpcById('peg_96_48')) >= 6 && ldpcGirth(ldpcById('hamming74')) === 4
    const shannonOk = Math.abs(ldpcShannonLimit(0.5)) < 0.01
    check('LDPC: sum-product ≤ min-sum BER, PEG girth ≥ 6, Shannon(½)≈0 dB', gainOk && girthOk && shannonOk)
  }

  return { passed, failed, messages }
}
