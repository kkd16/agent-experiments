// Lightweight runtime self-tests for the FFT core. These run once in development
// (see main.tsx) and log to the console; they are a cheap guard that the hand
// written transforms actually match the direct DFT and round-trip correctly.

import { fromReal, magnitude } from './complex'
import { fft, ifft, dft } from './fft'
import { fieldFromGray, fft2 } from './fft2'
import { cwtMorlet } from './wavelet'

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

  return { passed, failed, messages }
}
