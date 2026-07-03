// Lightweight runtime self-tests for the FFT core. These run once in development
// (see main.tsx) and log to the console; they are a cheap guard that the hand
// written transforms actually match the direct DFT and round-trip correctly.

import { fromReal, magnitude } from './complex'
import { fft, ifft, dft } from './fft'

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

  return { passed, failed, messages }
}
