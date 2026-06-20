// v6 — real-time denoised path tracing.
//
// An **edge-avoiding À-Trous wavelet** denoiser (Dammertz, Sewtz, Hanika & Lensch,
// "Edge-Avoiding À-Trous Wavelet Transform for fast Global Illumination Filtering",
// HPG 2010) with **SVGF-style** per-pixel variance guidance (Schied et al.,
// "Spatiotemporal Variance-Guided Filtering", HPG 2017). It turns the noisy
// low-sample output of the CPU path tracer into a clean image by blurring *only*
// along surfaces — never across a geometric or material edge — and only as hard as
// the local Monte-Carlo noise demands.
//
// The filter is a sequence of cross-bilateral 5×5 B-spline convolutions whose tap
// spacing **doubles** every iteration (the "à-trous"/holes trick): N iterations
// reach a 2^(N+2)-wide footprint at N·25 taps instead of one giant kernel. Each tap
// is reweighted by three edge-stopping functions read from the path tracer's primary
// feature buffers:
//
//   • **luminance** w_l = exp(−|l_p − l_q| / (σ_l·√Var_p + ε))  — SVGF's noise-aware
//     term: where the estimate is still noisy (high variance) it blurs freely; where
//     it has converged (variance → 0) it preserves every pixel, so the result decays
//     to the *exact* progressive average with no permanent over-blur.
//   • **normal** w_n = max(0, n_p·n_q)^σ_n — stops the filter at creases/silhouettes.
//   • **plane** w_p = exp(−|n_p·(P_q − P_p)| / σ_p) — the point-to-tangent-plane
//     distance: stops it at depth discontinuities while letting it follow a tilted
//     surface (more robust than a raw depth/world-distance test).
//
// Filtering operates on **demodulated irradiance** (colour ÷ albedo) so texture detail
// is divided out before the blur and multiplied back after — edges in the albedo never
// get smeared. Variance is carried through with the *squared* weights (SVGF), giving a
// filtered variance estimate that feeds the next coarser level.
//
// Everything here is a pure pass over typed arrays — no DOM, no allocation in the hot
// loop — so it is both the live viewport denoiser and a headless self-test target.

export interface DenoiseSettings {
  enabled: boolean
  iterations: number // à-trous levels; footprint ≈ 2^(iterations+2) px
  sigmaColor: number // luminance edge-stopping σ_l (bigger = blurs harder)
  sigmaNormal: number // normal edge-stopping exponent σ_n (bigger = sharper creases)
  sigmaPos: number // plane-distance edge-stopping σ_p, world units
  demodulate: boolean // filter colour ÷ albedo, re-modulate after (preserves texture)
  varianceGuided: boolean // scale σ_l by per-pixel √variance (SVGF) vs a flat σ_l
}

export const DEFAULT_DENOISE: DenoiseSettings = {
  enabled: true,
  iterations: 4,
  sigmaColor: 4,
  sigmaNormal: 64,
  sigmaPos: 0.4,
  demodulate: true,
  varianceGuided: true,
}

// Inputs to one denoise pass. All buffers are caller-owned and sized W·H (·3 for rgb).
export interface DenoiseInput {
  W: number
  H: number
  color: Float32Array // noisy mean radiance, rgb
  variance: Float32Array // per-pixel luminance variance of the mean estimator
  albedo: Float32Array // primary-hit albedo guide, rgb (used iff demodulate)
  pos: Float32Array // primary-hit world position, xyz
  normal: Float32Array // primary-hit world normal, xyz
  mask: Uint8Array // 1 = ray hit a surface, 0 = background/sky
  out: Float32Array // destination, rgb (re-modulated beauty)
  settings: DenoiseSettings
}

// Rec.709 luma — the perceptual channel the bilateral colour weight compares on.
function luma(a: Float32Array, o: number): number {
  return 0.2126 * a[o] + 0.7152 * a[o + 1] + 0.0722 * a[o + 2]
}

// The à-trous filter. Holds its own ping-pong scratch so the per-frame call never
// allocates; resizes lazily when the render resolution changes.
export class Denoiser {
  private W = 0
  private H = 0
  private irrA = new Float32Array(0)
  private irrB = new Float32Array(0)
  private varA = new Float32Array(0)
  private varB = new Float32Array(0)
  private guide = new Float32Array(0) // the (clamped) albedo we divided by, to re-modulate

  // 5-tap cubic B-spline row [1 4 6 4 1]/16 — the à-trous wavelet's scaling filter.
  private static readonly K = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]

  private ensure(W: number, H: number): void {
    if (this.W === W && this.H === H && this.irrA.length) return
    this.W = W
    this.H = H
    const n3 = W * H * 3
    const n1 = W * H
    this.irrA = new Float32Array(n3)
    this.irrB = new Float32Array(n3)
    this.varA = new Float32Array(n1)
    this.varB = new Float32Array(n1)
    this.guide = new Float32Array(n3)
  }

  run(input: DenoiseInput): void {
    const { W, H, color, variance, albedo, pos, normal, mask, out, settings } = input
    this.ensure(W, H)
    const N = W * H
    const eps = 1e-4
    const K = Denoiser.K
    const { iterations, sigmaColor, sigmaNormal, sigmaPos, demodulate, varianceGuided } = settings

    // ── demodulate: irr = colour ÷ albedo (guide clamped away from 0 so dark
    //    surfaces don't explode), and remember the guide to multiply back later.
    const guide = this.guide
    let srcI = this.irrA
    let srcV = this.varA
    let dstI = this.irrB
    let dstV = this.varB
    for (let i = 0; i < N; i++) {
      const o = i * 3
      let gr = 1, gg = 1, gb = 1
      if (demodulate && mask[i]) {
        gr = albedo[o] > 0.05 ? albedo[o] : 0.05
        gg = albedo[o + 1] > 0.05 ? albedo[o + 1] : 0.05
        gb = albedo[o + 2] > 0.05 ? albedo[o + 2] : 0.05
      }
      guide[o] = gr; guide[o + 1] = gg; guide[o + 2] = gb
      srcI[o] = color[o] / gr; srcI[o + 1] = color[o + 1] / gg; srcI[o + 2] = color[o + 2] / gb
      srcV[i] = variance[i]
    }

    // ── à-trous: each level convolves with the B-spline at spacing 2^level,
    //    reweighted by the edge-stopping functions; variance rides along with w².
    for (let level = 0; level < iterations; level++) {
      const step = 1 << level
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const pi = y * W + x
          const po = pi * 3
          const mp = mask[pi]
          const npx = normal[po], npy = normal[po + 1], npz = normal[po + 2]
          const Px = pos[po], Py = pos[po + 1], Pz = pos[po + 2]
          const lp = luma(srcI, po)
          const sd = varianceGuided ? Math.sqrt(srcV[pi] > 0 ? srcV[pi] : 0) : 1
          const colDenom = sigmaColor * sd + eps

          let sr = 0, sg = 0, sb = 0, sv = 0, wsum = 0
          for (let oy = -2; oy <= 2; oy++) {
            const yy = y + oy * step
            if (yy < 0 || yy >= H) continue
            const ky = K[oy + 2]
            for (let ox = -2; ox <= 2; ox++) {
              const xx = x + ox * step
              if (xx < 0 || xx >= W) continue
              const qi = yy * W + xx
              if (mask[qi] !== mp) continue // never mix surface with sky
              const qo = qi * 3
              let w = ky * K[ox + 2]
              if (mp) {
                // normal weight (creases) — also drops back-facing neighbours
                const dn = npx * normal[qo] + npy * normal[qo + 1] + npz * normal[qo + 2]
                if (dn <= 0) continue
                w *= Math.pow(dn, sigmaNormal)
                // plane-distance weight (depth discontinuities)
                const dpx = pos[qo] - Px, dpy = pos[qo + 1] - Py, dpz = pos[qo + 2] - Pz
                const planeD = Math.abs(npx * dpx + npy * dpy + npz * dpz)
                w *= Math.exp(-planeD / (sigmaPos + eps))
              }
              // luminance/noise weight
              const lq = luma(srcI, qo)
              w *= Math.exp(-Math.abs(lp - lq) / colDenom)

              sr += w * srcI[qo]; sg += w * srcI[qo + 1]; sb += w * srcI[qo + 2]
              sv += w * w * srcV[qi]
              wsum += w
            }
          }
          if (wsum > 0) {
            const inv = 1 / wsum
            dstI[po] = sr * inv; dstI[po + 1] = sg * inv; dstI[po + 2] = sb * inv
            dstV[pi] = sv * inv * inv
          } else {
            dstI[po] = srcI[po]; dstI[po + 1] = srcI[po + 1]; dstI[po + 2] = srcI[po + 2]
            dstV[pi] = srcV[pi]
          }
        }
      }
      const ti = srcI; srcI = dstI; dstI = ti
      const tv = srcV; srcV = dstV; dstV = tv
    }

    // ── re-modulate: beauty = filtered irradiance × the albedo guide.
    for (let i = 0; i < N; i++) {
      const o = i * 3
      out[o] = srcI[o] * guide[o]
      out[o + 1] = srcI[o + 1] * guide[o + 1]
      out[o + 2] = srcI[o + 2] * guide[o + 2]
    }
  }
}
