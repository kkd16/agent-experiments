// postprocess.ts — a physically based **image-formation** pipeline applied on
// the UI thread to the rendered image, *after* light transport.
//
// Every estimator in Lumen is about getting the scene-referred radiance right.
// But a real photograph is not the radiance field — it is what a *camera and a
// piece of film* did to it. Light scatters inside the lens (veiling glare), the
// pupil cuts off-axis rays (natural vignetting), the glass refracts each colour
// to a slightly different magnification (lateral chromatic aberration), and the
// emulsion records discrete silver grains (film grain). This module adds those
// four image-formation effects as a post-capture stage.
//
// The pipeline is deliberately split by colour space, the way a real imaging
// chain is:
//   • **Glare** and **vignetting** are *radiometric* — they redistribute and
//     attenuate energy — so they run in **linear HDR**, before tone mapping.
//   • **Chromatic aberration** and **film grain** are *display-referred*
//     artefacts of the recording medium, so they run on the **tone-mapped
//     8-bit** image, after the tone curve.
//
// None of this touches the light transport: with every strength at 0 the stage
// is a bit-exact identity, so the renderer's default output and all of the
// engine's transport proofs are unchanged. Each effect is written as a pure,
// deterministic function with an analytic invariant the verify suite pins down
// (glare conserves energy; the vignette is exactly cos⁴θ; chromatic aberration
// is identity at the optical centre and leaves green fixed; grain is zero-mean
// and vanishes at the black/white points).

// Settings for the whole pipeline. All-zero ⇒ identity. Carried inside the
// renderer's `DisplaySettings` so it applies live, without restarting a render.
export interface PostSettings {
  // Veiling-glare bloom: the fraction of each pixel's energy routed through the
  // lens-glare point-spread function (a normalised multi-scale blur). 0 = off.
  bloomStrength: number
  // Base glare radius in pixels (the tightest of the three glare scales).
  bloomRadius: number
  // Natural (cos⁴θ) vignetting amount in [0,1]: 0 = flat field, 1 = the full
  // physical falloff for the lens' field of view.
  vignette: number
  // Lateral chromatic-aberration magnitude in [0,1] (scaled to a small physical
  // pupil dispersion inside). 0 = off; green is always left fixed.
  chromatic: number
  // Film-grain amount in [0,1]: signal-dependent monochromatic noise that peaks
  // in the midtones and vanishes at pure black/white. 0 = off.
  grain: number
  // Camera vertical field of view (degrees) — sets the field angle the natural
  // vignette is computed against, so the falloff is tied to the actual lens.
  vfovDeg: number
}

export const POST_OFF: PostSettings = {
  bloomStrength: 0,
  bloomRadius: 0,
  vignette: 0,
  chromatic: 0,
  grain: 0,
  vfovDeg: 45,
}

// Does the pipeline have any *radiometric* (pre-tone-map, HDR) work to do?
export function postActiveHdr(p: PostSettings): boolean {
  return (p.bloomStrength > 0 && p.bloomRadius >= 1) || p.vignette > 0
}

// Does the pipeline have any *display-referred* (post-tone-map) work to do?
export function postActiveDisplay(p: PostSettings): boolean {
  return p.chromatic > 0 || p.grain > 0
}

// The physical magnitudes the [0,1] UI knobs map onto, kept here so the proofs
// and the renderer agree on the same scale.
export const CA_MAX_FRACTION = 0.04 // max pupil-dispersion magnification spread
export const GRAIN_MAGNITUDE = 0.16 // peak grain amplitude (display fraction)

const clampi = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

// ---- 1. Veiling-glare bloom (energy-conserving) -----------------------------
//
// Real lens glare is a *linear, energy-conserving* operation: a fraction of the
// light from every point is spread by the lens' point-spread function (PSF) into
// a halo, but no energy is created or destroyed (a passive optical element). We
// model the PSF as a normalised mixture of three Gaussians at increasing radius
// (a tight core + a broad veil — the Spencer et al. 1995 glare model), so the
// blur preserves total energy exactly, and the displayed result is the convex
// blend `(1−s)·image + s·glare(image)`, which is therefore also energy-exact.
//
// Each Gaussian is approximated by three iterations of a normalised box blur
// (the central-limit theorem: repeated box ⇒ Gaussian), which is O(N) per pixel
// independent of radius via a running sum, so even a wide veil stays cheap.

// One horizontal normalised box-blur pass over an interleaved-RGB buffer. The
// window is [x−rad, x+rad]; a running sum makes it O(width) per row regardless
// of `rad`. Edges clamp to the border pixel (a feature that does not reach the
// border — e.g. a centred highlight — therefore keeps its energy exactly).
function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, rad: number): void {
  const win = 2 * rad + 1
  const inv = 1 / win
  for (let y = 0; y < h; y++) {
    const row = y * w * 3
    for (let c = 0; c < 3; c++) {
      let sum = 0
      for (let k = -rad; k <= rad; k++) sum += src[row + clampi(k, 0, w - 1) * 3 + c]
      for (let x = 0; x < w; x++) {
        dst[row + x * 3 + c] = sum * inv
        const xin = clampi(x + rad + 1, 0, w - 1)
        const xout = clampi(x - rad, 0, w - 1)
        sum += src[row + xin * 3 + c] - src[row + xout * 3 + c]
      }
    }
  }
}

// One vertical normalised box-blur pass (the column-wise twin of `boxBlurH`).
function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, rad: number): void {
  const win = 2 * rad + 1
  const inv = 1 / win
  const stride = w * 3
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      const col = x * 3 + c
      let sum = 0
      for (let k = -rad; k <= rad; k++) sum += src[clampi(k, 0, h - 1) * stride + col]
      for (let y = 0; y < h; y++) {
        dst[y * stride + col] = sum * inv
        const yin = clampi(y + rad + 1, 0, h - 1)
        const yout = clampi(y - rad, 0, h - 1)
        sum += src[yin * stride + col] - src[yout * stride + col]
      }
    }
  }
}

// A separable Gaussian-approximating blur: three box iterations on each axis.
// Returns a fresh buffer; `src` is left untouched.
export function gaussianBlurRGB(src: Float32Array, w: number, h: number, rad: number): Float32Array {
  if (rad < 1) return src.slice()
  const a = new Float32Array(src.length)
  const b = new Float32Array(src.length)
  boxBlurH(src, a, w, h, rad)
  boxBlurV(a, b, w, h, rad)
  for (let i = 0; i < 2; i++) {
    boxBlurH(b, a, w, h, rad)
    boxBlurV(a, b, w, h, rad)
  }
  return b
}

// The multi-scale glare PSF: a normalised (Σweights = 1) mixture of three
// Gaussians at radius {r, 2r, 4r}. Normalisation is what makes the glare
// energy-conserving — each Gaussian preserves total energy, so any convex
// combination of them does too.
export function glareRGB(src: Float32Array, w: number, h: number, baseRad: number): Float32Array {
  const scales: [number, number][] = [
    [baseRad, 0.5],
    [baseRad * 2, 0.3],
    [baseRad * 4, 0.2],
  ]
  const out = new Float32Array(src.length)
  for (const [r, wgt] of scales) {
    const g = gaussianBlurRGB(src, w, h, Math.max(1, Math.round(r)))
    for (let i = 0; i < out.length; i++) out[i] += wgt * g[i]
  }
  return out
}

// Apply veiling-glare bloom: blend a `strength` fraction of the original image
// through the glare PSF. The result has (centred-feature) total energy equal to
// the input — a passive optical element neither creates nor destroys light.
export function applyBloom(
  src: Float32Array,
  w: number,
  h: number,
  strength: number,
  baseRad: number,
): Float32Array {
  const g = glareRGB(src, w, h, baseRad)
  const out = new Float32Array(src.length)
  const s = strength
  for (let i = 0; i < out.length; i++) out[i] = (1 - s) * src[i] + s * g[i]
  return out
}

// ---- 2. Natural (cos⁴θ) vignetting ------------------------------------------
//
// Off-axis points on the image plane receive less irradiance than the centre by
// the textbook cos⁴θ law (one cosine from the inverse-square distance to the
// off-axis point, one from the foreshortened aperture, two from the tilted image
// patch — see e.g. PBRT §6.4.7). With `tanθ = r` (image-plane radius in
// focal-length units), cosθ = 1/√(1+r²), so the falloff is 1/(1+r²)². The centre
// (r=0) is exactly 1 — unattenuated — for any strength.

// The pure cos⁴θ falloff at image-plane coordinate (x,y) measured in
// focal-length units (so x,y = tan of the per-axis field angle). Exported for
// the verify suite: factor(0,0)=1, monotone-decreasing in x²+y², always (0,1].
export function naturalVignetteFactor(x: number, y: number): number {
  const c2 = 1 / (1 + x * x + y * y) // = cos²θ
  return c2 * c2 // = cos⁴θ
}

// Multiply a linear-HDR interleaved-RGB buffer in place by the cos⁴ field, lerped
// by `strength` (0 ⇒ all-ones identity, 1 ⇒ the full physical falloff). `vfovDeg`
// is the camera's vertical field of view, which sets the field angle at the frame
// edge so the vignette is tied to the actual lens.
export function applyVignette(
  buf: Float32Array,
  w: number,
  h: number,
  strength: number,
  vfovDeg: number,
): void {
  const tanV = Math.tan((vfovDeg * Math.PI) / 360)
  const tanH = tanV * (w / h)
  for (let y = 0; y < h; y++) {
    const ndcY = ((y + 0.5) / h) * 2 - 1
    const fy = ndcY * tanV
    for (let x = 0; x < w; x++) {
      const ndcX = ((x + 0.5) / w) * 2 - 1
      const fx = ndcX * tanH
      const f = naturalVignetteFactor(fx, fy)
      const factor = 1 - strength * (1 - f)
      const i = (y * w + x) * 3
      buf[i] *= factor
      buf[i + 1] *= factor
      buf[i + 2] *= factor
    }
  }
}

// ---- 3. Lateral chromatic aberration ----------------------------------------
//
// A real lens cannot focus every wavelength to the same magnification, so the
// red, green and blue images are scaled by slightly different factors about the
// optical centre — colour fringes that grow with distance from the centre and
// vanish at it. We gather each channel from a radially rescaled source position
// (red magnified, blue minified, green fixed) with bilinear resampling. At the
// centre all three channels read the same texel (no fringe); with magnitude 0 it
// is a bit-exact identity; green is untouched at any magnitude.

// Bilinear sample of one channel of an 8-bit RGBA image, clamped at the border.
function sampleChannel(src: Uint8ClampedArray, w: number, h: number, fx: number, fy: number, c: number): number {
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const x0c = clampi(x0, 0, w - 1)
  const x1c = clampi(x0 + 1, 0, w - 1)
  const y0c = clampi(y0, 0, h - 1)
  const y1c = clampi(y0 + 1, 0, h - 1)
  const p00 = src[(y0c * w + x0c) * 4 + c]
  const p10 = src[(y0c * w + x1c) * 4 + c]
  const p01 = src[(y1c * w + x0c) * 4 + c]
  const p11 = src[(y1c * w + x1c) * 4 + c]
  const top = p00 + (p10 - p00) * tx
  const bot = p01 + (p11 - p01) * tx
  return top + (bot - top) * ty
}

// Lateral chromatic aberration on a tone-mapped RGBA byte image. `k` is the
// per-channel magnification spread (red ×(1+k), blue ×(1−k), green ×1). Returns
// a fresh buffer. The source coordinate for a magnification `m` is
// centre + (p−centre)/m, so the centre is a fixed point of every channel.
export function chromaticAberration(src: Uint8ClampedArray, w: number, h: number, k: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const invR = 1 / (1 + k) // red magnified ⇒ sample nearer the centre
  const invB = 1 / (1 - k) // blue minified ⇒ sample farther from the centre
  for (let y = 0; y < h; y++) {
    const dy = y - cy
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const o = (y * w + x) * 4
      out[o] = sampleChannel(src, w, h, cx + dx * invR, cy + dy * invR, 0)
      out[o + 1] = src[o + 1] // green is the reference channel — untouched
      out[o + 2] = sampleChannel(src, w, h, cx + dx * invB, cy + dy * invB, 2)
      out[o + 3] = 255
    }
  }
  return out
}

// ---- 4. Film grain (photographic, signal-dependent) -------------------------
//
// Photographic grain is the discrete silver-halide structure of the emulsion. It
// is most visible in the midtones and disappears toward pure black and pure white
// (no exposure ⇒ no grains; full saturation ⇒ all grains developed), so its
// amplitude follows √(L(1−L)). The noise itself is zero-mean (it perturbs, never
// biases, the image) and monochromatic (a luminance dither shared across the
// channels, as real grain clumps are). It is deterministic in the pixel
// coordinate (a fixed hash, not the wall clock) so the catalog thumbnail and the
// verify suite are reproducible.

// A 2D integer hash → uniform [0,1). Deterministic, no global RNG state.
function hash01(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// Triangular-PDF noise in (−1,1) with mean exactly 0 — the difference of two
// independent uniforms (smoother and zero-mean, the standard dither).
function tpdfNoise(x: number, y: number): number {
  return hash01(x, y, 1) - hash01(x, y, 2)
}

// The grain amplitude envelope: peaks at L=½ (value 1), zero at L∈{0,1}. Exported
// so the verify suite can pin the black/white-preserving endpoints.
export function grainEnvelope(luma: number): number {
  const l = luma < 0 ? 0 : luma > 1 ? 1 : luma
  return 2 * Math.sqrt(l * (1 - l))
}

// Add film grain to a tone-mapped RGBA byte image in place. `strength` ∈ [0,1].
export function applyGrain(out: Uint8ClampedArray, w: number, h: number, strength: number): void {
  const amp = strength * GRAIN_MAGNITUDE * 255
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const luma = (0.2126 * out[o] + 0.7152 * out[o + 1] + 0.0722 * out[o + 2]) / 255
      const delta = amp * grainEnvelope(luma) * tpdfNoise(x, y)
      out[o] = clampi(out[o] + delta, 0, 255)
      out[o + 1] = clampi(out[o + 1] + delta, 0, 255)
      out[o + 2] = clampi(out[o + 2] + delta, 0, 255)
    }
  }
}

// ---- Pipeline orchestration -------------------------------------------------

// Run the radiometric (pre-tone-map) stages on a linear-HDR buffer. Returns a
// fresh buffer so the caller's accumulation average is never mutated.
export function postProcessHdr(src: Float32Array, w: number, h: number, p: PostSettings): Float32Array {
  let buf: Float32Array
  if (p.bloomStrength > 0 && p.bloomRadius >= 1) {
    buf = applyBloom(src, w, h, p.bloomStrength, p.bloomRadius)
  } else {
    buf = src.slice()
  }
  if (p.vignette > 0) applyVignette(buf, w, h, p.vignette, p.vfovDeg)
  return buf
}

// Run the display-referred (post-tone-map) stages on an RGBA byte image in place.
export function postProcessDisplay(out: Uint8ClampedArray, w: number, h: number, p: PostSettings): void {
  if (p.chromatic > 0) {
    const ca = chromaticAberration(out, w, h, p.chromatic * CA_MAX_FRACTION)
    out.set(ca)
  }
  if (p.grain > 0) applyGrain(out, w, h, p.grain)
}
