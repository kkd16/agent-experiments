import { hpFromNumber, hpMul, hpToNumber, PBITS, type HP } from './hp'

// The reference orbit for perturbation rendering.
//
// Perturbation theory rewrites the escape-time iteration z ↦ z^p + c around a
// single high-precision "reference" point C (here, the view centre). For any
// nearby pixel c = C + δc it iterates only the *difference* δz = z − Z, where
// Z_n is the reference orbit:
//
//     Z_{n+1} = Z_n^p + C          (Z_0 = 0, the critical orbit)
//
// The GPU then advances δz with the exact binomial expansion of
// (Z+δz)^p − Z^p + δc. δz and δc are tiny (≈ pixel scale), so they survive in
// ordinary float32 even at a zoom of 1e-30 — where the absolute coordinates
// would need 30+ digits. The catch is that Z_n itself must be computed
// accurately, which is why it runs here in BigInt fixed-point on the CPU. The
// result — an O(1)-magnitude complex sequence — is handed to the GPU as float32
// arrays; the deep digits live entirely in how Z_n was *derived*, not in its
// stored value.

export type RefOrbit = {
  xs: Float32Array // Z_n real part, index 0..length
  ys: Float32Array // Z_n imaginary part
  length: number // highest valid index (orbit has length+1 points, Z_0..Z_length)
  escaped: boolean // whether the reference left the escape radius
}

// A generous reference bailout so the stored orbit is long (fewer GPU rebases)
// while staying well inside float32's range (|Z| < 1e3, so |Z|² < 1e6).
const REF_BAILOUT2 = 1e6

// Complex fixed-point multiply: (a+bi)(c+di) = (ac−bd) + (ad+bc)i.
function cmul(ax: HP, ay: HP, bx: HP, by: HP): [HP, HP] {
  return [hpMul(ax, bx) - hpMul(ay, by), hpMul(ax, by) + hpMul(ay, bx)]
}

/**
 * Iterate the reference orbit Z_{n+1} = Z_n^p + C from centre (cx, cy) in
 * fixed-point, storing each Z_n as float32. Stops early if the reference
 * escapes. `power` is the map degree (2, 3 or 4).
 */
export function computeReferenceOrbit(cx: HP, cy: HP, maxIter: number, power = 2): RefOrbit {
  const n = Math.max(1, Math.min(maxIter, 1_000_000)) | 0
  const p = Math.max(2, Math.min(4, power | 0))
  const xs = new Float32Array(n + 1)
  const ys = new Float32Array(n + 1)
  const escFixed = hpFromNumber(REF_BAILOUT2)

  let zx: HP = 0n
  let zy: HP = 0n
  xs[0] = 0
  ys[0] = 0
  let length = n
  let escaped = false

  for (let i = 1; i <= n; i++) {
    // Z^p by repeated complex multiply (p ≤ 4, so at most three products).
    let px = zx
    let py = zy
    for (let k = 2; k <= p; k++) {
      ;[px, py] = cmul(px, py, zx, zy)
    }
    zx = px + cx
    zy = py + cy
    xs[i] = hpToNumber(zx) // Float32Array store rounds to float32
    ys[i] = hpToNumber(zy)
    const zx2 = hpMul(zx, zx)
    const zy2 = hpMul(zy, zy)
    if (zx2 + zy2 > escFixed) {
      length = i
      escaped = true
      break
    }
  }

  return { xs, ys, length, escaped }
}

// Fixed-point iteration cost grows with PBITS; expose it so callers can size the
// work sensibly (kept here to keep PBITS in one import site for tests).
export const REFERENCE_PRECISION_BITS = PBITS
