// Test images ("phantoms") for the tomography lab. Every phantom is a square
// Float64Array of length size*size, row-major, values in [0,1], defined over the
// normalized square [-1,1]×[-1,1] with y pointing *up* in maths convention (the
// rasteriser flips it into the top-left-origin pixel grid).
//
// The centrepiece is the Shepp–Logan head phantom — the canonical CT test image,
// a sum of ten ellipses of differing density that mimics a cross-section of a
// skull with ventricles and small tumours. Reconstructing it faithfully is the
// classic benchmark every filtered-back-projection implementation is judged on.

export type PhantomName = 'shepp' | 'disk' | 'bars' | 'circles' | 'spokes'

export const PHANTOMS: { id: PhantomName; label: string }[] = [
  { id: 'shepp', label: 'Shepp–Logan head' },
  { id: 'disk', label: 'Uniform disk' },
  { id: 'circles', label: 'Nested rings' },
  { id: 'bars', label: 'Density bars' },
  { id: 'spokes', label: 'Radial spokes' },
]

// The modified Shepp–Logan ellipses: [intensity, semi-axis a, semi-axis b,
// centre x0, centre y0, rotation φ in degrees]. Intensities are additive.
const SHEPP: [number, number, number, number, number, number][] = [
  [1.0, 0.69, 0.92, 0, 0, 0],
  [-0.8, 0.6624, 0.874, 0, -0.0184, 0],
  [-0.2, 0.11, 0.31, 0.22, 0, -18],
  [-0.2, 0.16, 0.41, -0.22, 0, 18],
  [0.1, 0.21, 0.25, 0, 0.35, 0],
  [0.1, 0.046, 0.046, 0, 0.1, 0],
  [0.1, 0.046, 0.046, 0, -0.1, 0],
  [0.1, 0.046, 0.023, -0.08, -0.605, 0],
  [0.1, 0.023, 0.023, 0, -0.606, 0],
  [0.1, 0.023, 0.046, 0.06, -0.605, 0],
]

function sheppValue(x: number, y: number): number {
  let v = 0
  for (const [amp, a, b, x0, y0, phiDeg] of SHEPP) {
    const phi = (phiDeg * Math.PI) / 180
    const cos = Math.cos(phi)
    const sin = Math.sin(phi)
    const dx = x - x0
    const dy = y - y0
    const xr = dx * cos + dy * sin
    const yr = -dx * sin + dy * cos
    if ((xr * xr) / (a * a) + (yr * yr) / (b * b) <= 1) v += amp
  }
  return v
}

/** Rasterise a phantom to a `size`×`size` grayscale buffer in [0,1]. */
export function makePhantom(name: PhantomName, size: number): Float64Array {
  const out = new Float64Array(size * size)
  const c = (size - 1) / 2
  const scale = size / 2
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Normalised maths coordinates: x right, y up, unit disk inscribed.
      const x = (px - c) / scale
      const y = -(py - c) / scale
      const r = Math.hypot(x, y)
      const ang = Math.atan2(y, x)
      let v = 0
      switch (name) {
        case 'shepp':
          v = sheppValue(x, y)
          break
        case 'disk':
          v = r < 0.85 ? 1 : 0
          break
        case 'circles': {
          // A stack of concentric annuli of alternating density.
          if (r < 0.9) v = 0.35 + 0.5 * (0.5 + 0.5 * Math.cos(r * Math.PI * 6))
          break
        }
        case 'bars': {
          // Three vertical bars of increasing density inside a faint disk.
          if (r < 0.9) {
            v = 0.15
            const band = (x + 1) * 3 // 0..6 across the width
            if (band > 1.2 && band < 1.9) v = 0.55
            else if (band > 2.6 && band < 3.3) v = 0.8
            else if (band > 4.0 && band < 4.7) v = 1.0
          }
          break
        }
        case 'spokes': {
          if (r < 0.9) v = 0.5 + 0.5 * Math.cos(ang * 10) * Math.min(1, r * 2)
          break
        }
      }
      out[py * size + px] = Math.max(0, Math.min(1, v))
    }
  }
  return out
}
