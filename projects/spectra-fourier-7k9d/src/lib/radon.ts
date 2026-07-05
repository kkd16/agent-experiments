// Computed tomography from scratch: the Radon transform and its inversion.
//
// A parallel-beam CT scanner measures, for every angle θ, the set of line
// integrals of an object f(x,y) across a bank of detectors — the projection
// p_θ(t) = ∫ f(t·(cosθ,sinθ) + s·(−sinθ,cosθ)) ds. Stacked over θ this is the
// **sinogram** (a point in the object traces a sinusoid through it, hence the
// name). Recovering f from the sinogram is the inverse problem CT hardware
// solves millions of times a day.
//
// Two inversions live here, both built only on the app's from-scratch FFT:
//
//   • Filtered back-projection (FBP) — ramp-filter each projection, then smear
//     it back across the image along its ray and sum. The ramp filter is the
//     exact deconvolution of the 1/r blur that plain back-projection produces.
//
//   • Direct Fourier reconstruction — the **Fourier Slice Theorem**: the 1-D
//     Fourier transform of a projection at angle θ is exactly a radial line,
//     at angle θ, through the object's 2-D Fourier transform. Grid every
//     projection's spectrum onto a Cartesian k-space and inverse-2D-FFT. This
//     is the theorem that *makes* CT possible, rendered literally visible.

import { fromReal } from './complex'
import { transform, nextPow2 } from './fft'
import { makeField, fft2, fftShift2, type Field2D } from './fft2'

export type FilterName = 'ramlak' | 'shepp' | 'cosine' | 'hann' | 'hamming' | 'none'

export const FILTERS: { id: FilterName; label: string }[] = [
  { id: 'ramlak', label: 'Ram–Lak (ideal ramp)' },
  { id: 'shepp', label: 'Shepp–Logan' },
  { id: 'cosine', label: 'Cosine' },
  { id: 'hann', label: 'Hann' },
  { id: 'hamming', label: 'Hamming' },
  { id: 'none', label: 'None (raw back-projection)' },
]

export interface Sinogram {
  data: Float64Array // nAngles × nDet, row (angle)-major
  nAngles: number
  nDet: number
  tMax: number // detector half-span in normalized units
  angles: Float64Array // θ in radians, one per row
}

const SQRT2 = Math.SQRT2

/** Bilinear sample of a size×size image in normalized maths coords (x right, y up). */
function sampleNorm(img: ArrayLike<number>, size: number, x: number, y: number): number {
  const c = (size - 1) / 2
  const scale = size / 2
  const px = x * scale + c
  const py = -y * scale + c
  if (px < 0 || px > size - 1 || py < 0 || py > size - 1) return 0
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const x1 = Math.min(size - 1, x0 + 1)
  const y1 = Math.min(size - 1, y0 + 1)
  const fx = px - x0
  const fy = py - y0
  const a = img[y0 * size + x0]
  const b = img[y0 * size + x1]
  const cc = img[y1 * size + x0]
  const d = img[y1 * size + x1]
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + cc * (1 - fx) * fy + d * fx * fy
}

/**
 * Forward Radon transform: ray-driven line integrals producing the sinogram.
 * Detectors span t ∈ [−tMax, tMax] with tMax = √2 so the whole square is seen;
 * each ray is integrated over its chord by dense bilinear sampling.
 *
 * `arcRad` is the angular span the gantry sweeps (default π = a full parallel
 * scan). A smaller arc is a *limited-angle* scan — a missing wedge of directions
 * that leaves a bow-tie hole in k-space; FBP streaks there, iterative + priors
 * cope. Angles are spread uniformly over [0, arcRad).
 */
export function forwardRadon(
  img: ArrayLike<number>,
  size: number,
  nAngles: number,
  nDet = Math.round(size * SQRT2),
  arcRad = Math.PI,
): Sinogram {
  const tMax = SQRT2
  const sMax = SQRT2
  const nSteps = Math.max(64, Math.round(size * 1.5))
  const ds = (2 * sMax) / (nSteps - 1)
  const data = new Float64Array(nAngles * nDet)
  const angles = new Float64Array(nAngles)
  for (let a = 0; a < nAngles; a++) {
    const theta = (a * arcRad) / nAngles
    angles[a] = theta
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    for (let d = 0; d < nDet; d++) {
      const t = ((d / (nDet - 1)) * 2 - 1) * tMax
      const bx = t * cos
      const by = t * sin
      let sum = 0
      for (let si = 0; si < nSteps; si++) {
        const s = ((si / (nSteps - 1)) * 2 - 1) * sMax
        const x = bx - s * sin
        const y = by + s * cos
        sum += sampleNorm(img, size, x, y)
      }
      data[a * nDet + d] = sum * ds
    }
  }
  return { data, nAngles, nDet, tMax, angles }
}

/** Add zero-mean Gaussian noise (std = frac × sinogram RMS) — simulates dose. */
export function addNoise(sino: Sinogram, frac: number, seed = 1): Sinogram {
  if (frac <= 0) return sino
  const { data } = sino
  let ss = 0
  for (let i = 0; i < data.length; i++) ss += data[i] * data[i]
  const rms = Math.sqrt(ss / data.length)
  const sigma = frac * rms
  // Deterministic Box–Muller with a splitmix32 stream so a link reproduces.
  let s = (seed >>> 0) || 1
  const rand = () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    z ^= z >>> 15
    return (z >>> 0) / 4294967296
  }
  const out = new Float64Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const u1 = Math.max(1e-12, rand())
    const u2 = rand()
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    out[i] = data[i] + sigma * g
  }
  return { ...sino, data: out }
}

/** The ramp filter's frequency response with the chosen apodisation window. */
function rampResponse(name: FilterName, f: number, fNyq: number): number {
  if (name === 'none') return 1
  const ramp = Math.abs(f)
  const r = Math.min(1, Math.abs(f) / fNyq) // 0..1
  let w = 1
  switch (name) {
    case 'ramlak':
      w = 1
      break
    case 'shepp': {
      const x = (Math.PI * r) / 2
      w = x === 0 ? 1 : Math.sin(x) / x
      break
    }
    case 'cosine':
      w = Math.cos((Math.PI * r) / 2)
      break
    case 'hann':
      w = 0.5 * (1 + Math.cos(Math.PI * r))
      break
    case 'hamming':
      w = 0.54 + 0.46 * Math.cos(Math.PI * r)
      break
  }
  return ramp * w
}

/**
 * Ramp-filter every projection in the frequency domain. Returns a fresh sinogram
 * whose rows are the filtered projections Q_θ(t), ready for back-projection.
 */
export function filterSinogram(sino: Sinogram, name: FilterName): Sinogram {
  const { data, nAngles, nDet, tMax, angles } = sino
  if (name === 'none') return { data: data.slice(), nAngles, nDet, tMax, angles }
  const dt = (2 * tMax) / (nDet - 1)
  const nfft = nextPow2(nDet * 2)
  const fNyq = 1 / (2 * dt)
  // Precompute the multiplicative filter for each bin.
  const H = new Float64Array(nfft)
  for (let k = 0; k < nfft; k++) {
    const kk = k <= nfft / 2 ? k : k - nfft
    const f = kk / (nfft * dt)
    H[k] = rampResponse(name, f, fNyq) * dt
  }
  const out = new Float64Array(nAngles * nDet)
  const buf = new Float64Array(nfft)
  for (let a = 0; a < nAngles; a++) {
    buf.fill(0)
    for (let d = 0; d < nDet; d++) buf[d] = data[a * nDet + d]
    const spec = transform(fromReal(buf), false)
    for (let k = 0; k < nfft; k++) {
      spec.re[k] *= H[k]
      spec.im[k] *= H[k]
    }
    const back = transform(spec, true)
    for (let d = 0; d < nDet; d++) out[a * nDet + d] = back.re[d]
  }
  return { data: out, nAngles, nDet, tMax, angles }
}

/**
 * Back-project one projection row into an accumulator image (no scaling). Used
 * both by the full reconstruction and by the live "watch it build" animation.
 */
export function backprojectAngle(
  acc: Float64Array,
  sino: Sinogram,
  a: number,
  size: number,
): void {
  const { data, nDet, tMax, angles } = sino
  const dt = (2 * tMax) / (nDet - 1)
  const dc = (nDet - 1) / 2
  const cos = Math.cos(angles[a])
  const sin = Math.sin(angles[a])
  const c = (size - 1) / 2
  const scale = size / 2
  const row = a * nDet
  for (let py = 0; py < size; py++) {
    const y = -(py - c) / scale
    for (let px = 0; px < size; px++) {
      const x = (px - c) / scale
      const t = x * cos + y * sin
      const fidx = t / dt + dc
      const i0 = Math.floor(fidx)
      if (i0 < 0 || i0 >= nDet - 1) continue
      const frac = fidx - i0
      acc[py * size + px] += data[row + i0] * (1 - frac) + data[row + i0 + 1] * frac
    }
  }
}

/** Full back-projection over every angle, scaled by π/nAngles (the FBP constant). */
export function backproject(sino: Sinogram, size: number): Float64Array {
  const acc = new Float64Array(size * size)
  for (let a = 0; a < sino.nAngles; a++) backprojectAngle(acc, sino, a, size)
  const k = Math.PI / sino.nAngles
  for (let i = 0; i < acc.length; i++) acc[i] *= k
  return acc
}

/** Filtered back-projection = ramp-filter, then back-project. */
export function fbp(sino: Sinogram, size: number, filter: FilterName): Float64Array {
  return backproject(filterSinogram(sino, filter), size)
}

// ---------------------------------------------------------------------------
// Direct Fourier reconstruction — the Fourier Slice Theorem made literal.
// ---------------------------------------------------------------------------

export interface FourierRecon {
  recon: Float64Array // size×size real reconstruction
  kmag: Float64Array // size×size log-magnitude of the *gridded* k-space (for display)
}

/** Bilinear splat of a complex value into a centered accumulator grid. */
function splat(
  re: Float64Array,
  im: Float64Array,
  wsum: Float64Array,
  size: number,
  gx: number,
  gy: number,
  vr: number,
  vi: number,
): void {
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  for (let dy = 0; dy <= 1; dy++) {
    const yy = y0 + dy
    if (yy < 0 || yy >= size) continue
    const wy = dy === 0 ? 1 - (gy - y0) : gy - y0
    for (let dx = 0; dx <= 1; dx++) {
      const xx = x0 + dx
      if (xx < 0 || xx >= size) continue
      const w = (dx === 0 ? 1 - (gx - x0) : gx - x0) * wy
      const idx = yy * size + xx
      re[idx] += vr * w
      im[idx] += vi * w
      wsum[idx] += w
    }
  }
}

/**
 * Reconstruct by gridding each projection's 1-D spectrum onto a Cartesian
 * k-space (the slice theorem) and inverse-transforming. Also returns the filled
 * k-space magnitude so the UI can show the polar samples tiling the plane.
 */
export function directFourier(sino: Sinogram, size: number): FourierRecon {
  const { data, nAngles, nDet, tMax, angles } = sino
  const dt = (2 * tMax) / (nDet - 1)
  const nfft = nextPow2(nDet * 2)
  const dc = (nDet - 1) / 2 // detector index of t = 0
  const cx = size / 2
  const cy = size / 2
  const gr = new Float64Array(size * size)
  const gi = new Float64Array(size * size)
  const gw = new Float64Array(size * size)
  const buf = new Float64Array(nfft)
  const half = size / 2
  for (let a = 0; a < nAngles; a++) {
    const cos = Math.cos(angles[a])
    const sin = Math.sin(angles[a])
    buf.fill(0)
    for (let d = 0; d < nDet; d++) buf[d] = data[a * nDet + d]
    const spec = transform(fromReal(buf), false)
    for (let k = 0; k < nfft; k++) {
      const kk = k <= nfft / 2 ? k : k - nfft
      const f = kk / (nfft * dt) // physical frequency (cycles per unit length)
      // Image spans [-1,1] (pixel size 2/size) ⇒ k-space bin spacing 1/2 ⇒
      // radius in bins = f / (1/2) = 2f.
      const rBins = 2 * f
      if (Math.abs(rBins) > half) continue
      // The detector samples sit at t_d = (d − dc)·dt, so the continuous slice
      // value is S(f_k) = dt · e^{+2πi·k·dc/nfft} · X[k] — the phase that
      // re-references the DFT (origin at index 0) to the detector centre.
      const phi = (2 * Math.PI * k * dc) / nfft
      const cp = Math.cos(phi) * dt
      const sp = Math.sin(phi) * dt
      const xr = spec.re[k]
      const xi = spec.im[k]
      const vr = cp * xr - sp * xi
      const vi = cp * xi + sp * xr
      const gx = cx + rBins * cos
      const gy = cy - rBins * sin // image y is up ⇒ frequency y is up ⇒ row index down
      splat(gr, gi, gw, size, gx, gy, vr, vi)
    }
  }
  // Density-compensate the overlapping polar samples.
  const kmag = new Float64Array(size * size)
  let kmax = 0
  for (let i = 0; i < gr.length; i++) {
    if (gw[i] > 1e-9) {
      gr[i] /= gw[i]
      gi[i] /= gw[i]
    }
    const m = Math.log1p(Math.hypot(gr[i], gi[i]))
    kmag[i] = m
    if (m > kmax) kmax = m
  }
  const invK = kmax > 0 ? 1 / kmax : 0
  for (let i = 0; i < kmag.length; i++) kmag[i] *= invK
  // Inverse transform: our grid has DC at the center, so shift it to the corner,
  // ifft2, then shift the spatial result back to the center.
  const centered: Field2D = { width: size, height: size, re: gr, im: gi }
  const corner = fftShift2(centered)
  fft2(corner, true)
  const spatial = fftShift2(corner)
  const recon = new Float64Array(size * size)
  for (let i = 0; i < recon.length; i++) recon[i] = spatial.re[i]
  return { recon, kmag }
}

/** Build a displayable log-magnitude image of the object's true 2-D spectrum. */
export function trueSpectrum(img: ArrayLike<number>, size: number): Float64Array {
  const f = makeField(size, size)
  for (let i = 0; i < size * size; i++) f.re[i] = img[i]
  fft2(f, false)
  const sh = fftShift2(f)
  const out = new Float64Array(size * size)
  let max = 0
  for (let i = 0; i < out.length; i++) {
    const v = Math.log1p(Math.hypot(sh.re[i], sh.im[i]))
    out[i] = v
    if (v > max) max = v
  }
  const inv = max > 0 ? 1 / max : 0
  for (let i = 0; i < out.length; i++) out[i] *= inv
  return out
}

// ---------------------------------------------------------------------------
// Quality metrics.
// ---------------------------------------------------------------------------

/** Min–max normalise a buffer into [0,1] (returns a fresh array). */
export function normalize01(a: ArrayLike<number>): Float64Array {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const span = hi - lo || 1
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - lo) / span
  return out
}

/**
 * Least-squares affine fit a·recon + b ≈ target, returning the matched
 * reconstruction, per-pixel absolute error and the RMSE. CT reconstructions are
 * only defined up to such a gain/offset, so this is the honest way to score them.
 */
export function affineError(
  recon: ArrayLike<number>,
  target: ArrayLike<number>,
): { matched: Float64Array; error: Float64Array; rmse: number } {
  const n = recon.length
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sx += recon[i]
    sy += target[i]
    sxx += recon[i] * recon[i]
    sxy += recon[i] * target[i]
  }
  const denom = n * sxx - sx * sx
  const a = Math.abs(denom) < 1e-12 ? 0 : (n * sxy - sx * sy) / denom
  const b = (sy - a * sx) / n
  const matched = new Float64Array(n)
  const error = new Float64Array(n)
  let ss = 0
  for (let i = 0; i < n; i++) {
    const m = a * recon[i] + b
    matched[i] = m
    const e = m - target[i]
    error[i] = Math.abs(e)
    ss += e * e
  }
  return { matched, error, rmse: Math.sqrt(ss / n) }
}

/** Pearson correlation of two equal-length buffers. */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return num / (Math.sqrt(da * db) + 1e-12)
}
