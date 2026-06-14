// denoise.ts — an edge-avoiding À-Trous wavelet filter (Dammertz, Sewtz,
// Hanika & Lensch 2010). It cleans Monte-Carlo noise from a still frame while
// preserving geometric edges, by running a 5×5 B3-spline blur at exponentially
// increasing pixel strides and weighting each tap by how similar its colour,
// surface normal, and albedo are to the centre pixel. Cross-edge taps get a
// near-zero weight, so blur happens *along* surfaces but never across silhouettes.
//
// It consumes the G-buffer the integrator already produced (no extra rays) and
// is purely a viewing aid — the underlying HDR samples are never modified.

export interface DenoiseParams {
  iterations: number
  sigmaColor: number
  sigmaNormal: number
  sigmaAlbedo: number
}

const KERNEL = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16] // B3 spline, separable

export function denoise(
  color: Float32Array, // averaged linear RGB
  normal: Float32Array, // averaged normals (need not be unit)
  albedo: Float32Array, // averaged albedo
  width: number,
  height: number,
  params: DenoiseParams,
): Float32Array {
  let src = color.slice()
  const dst = new Float32Array(color.length)
  const n = width * height

  // Pre-normalise the normal guide once.
  const nrm = new Float32Array(normal.length)
  for (let i = 0; i < n; i++) {
    const x = normal[i * 3]
    const y = normal[i * 3 + 1]
    const z = normal[i * 3 + 2]
    const l = Math.hypot(x, y, z) || 1
    nrm[i * 3] = x / l
    nrm[i * 3 + 1] = y / l
    nrm[i * 3 + 2] = z / l
  }

  for (let it = 0; it < params.iterations; it++) {
    const step = 1 << it
    // Dammertz: tighten the colour edge-stopping function each iteration.
    const sigC = params.sigmaColor / (1 << it)
    const invSigC = 1 / Math.max(1e-6, sigC * sigC)
    const invSigN = 1 / Math.max(1e-6, params.sigmaNormal * params.sigmaNormal)
    const invSigA = 1 / Math.max(1e-6, params.sigmaAlbedo * params.sigmaAlbedo)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ci = y * width + x
        const cr = src[ci * 3]
        const cg = src[ci * 3 + 1]
        const cb = src[ci * 3 + 2]
        const nx = nrm[ci * 3]
        const ny = nrm[ci * 3 + 1]
        const nz = nrm[ci * 3 + 2]
        const ar = albedo[ci * 3]
        const ag = albedo[ci * 3 + 1]
        const ab = albedo[ci * 3 + 2]

        let sumR = 0
        let sumG = 0
        let sumB = 0
        let sumW = 0
        for (let dy = -2; dy <= 2; dy++) {
          const sy = y + dy * step
          if (sy < 0 || sy >= height) continue
          for (let dx = -2; dx <= 2; dx++) {
            const sx = x + dx * step
            if (sx < 0 || sx >= width) continue
            const si = sy * width + sx
            const kr = KERNEL[dy + 2] * KERNEL[dx + 2]

            // Colour edge-stopping (luminance-weighted distance).
            const dr = src[si * 3] - cr
            const dg = src[si * 3 + 1] - cg
            const db = src[si * 3 + 2] - cb
            const dist2 = dr * dr + dg * dg + db * db
            const wColor = Math.exp(-dist2 * invSigC)

            // Normal edge-stopping (1 − cosθ between normals).
            const nd = 1 - (nx * nrm[si * 3] + ny * nrm[si * 3 + 1] + nz * nrm[si * 3 + 2])
            const wNormal = Math.exp(-Math.max(0, nd) * invSigN)

            // Albedo edge-stopping (texture/material discontinuities).
            const er = albedo[si * 3] - ar
            const eg = albedo[si * 3 + 1] - ag
            const eb = albedo[si * 3 + 2] - ab
            const aDist = er * er + eg * eg + eb * eb
            const wAlbedo = Math.exp(-aDist * invSigA)

            const w = kr * wColor * wNormal * wAlbedo
            sumR += src[si * 3] * w
            sumG += src[si * 3 + 1] * w
            sumB += src[si * 3 + 2] * w
            sumW += w
          }
        }
        const inv = sumW > 0 ? 1 / sumW : 0
        dst[ci * 3] = sumR * inv
        dst[ci * 3 + 1] = sumG * inv
        dst[ci * 3 + 2] = sumB * inv
      }
    }
    // Copy the result out so the next, wider iteration reads filtered colour.
    // (`dst` is fully overwritten every iteration, so it is safe to reuse.)
    src = dst.slice()
  }
  return src
}
