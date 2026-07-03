// Perceptual colormaps for heatmaps (the spectrogram). Each maps t in [0,1] to an
// [r,g,b] triple. The control points are sampled from the well-known matplotlib
// colormaps and interpolated linearly — good enough for a display, no dependency.

export type ColormapName = 'magma' | 'viridis' | 'inferno' | 'ice'

export const COLORMAPS: { id: ColormapName; label: string }[] = [
  { id: 'magma', label: 'Magma' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'inferno', label: 'Inferno' },
  { id: 'ice', label: 'Ice' },
]

type Stop = [number, number, number]

const MAGMA: Stop[] = [
  [0, 0, 4],
  [28, 16, 68],
  [79, 18, 123],
  [129, 37, 129],
  [181, 54, 122],
  [229, 80, 100],
  [251, 135, 97],
  [254, 194, 135],
  [252, 253, 191],
]

const VIRIDIS: Stop[] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
]

const INFERNO: Stop[] = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
]

const ICE: Stop[] = [
  [3, 5, 26],
  [10, 30, 70],
  [16, 62, 120],
  [24, 100, 170],
  [46, 145, 205],
  [110, 190, 225],
  [190, 228, 242],
  [245, 252, 255],
]

const TABLES: Record<ColormapName, Stop[]> = {
  magma: MAGMA,
  viridis: VIRIDIS,
  inferno: INFERNO,
  ice: ICE,
}

/** Sample a colormap at t in [0,1], returning [r,g,b] in 0..255. */
export function sampleColormap(name: ColormapName, t: number): Stop {
  const stops = TABLES[name]
  const clamped = Math.max(0, Math.min(1, t))
  const x = clamped * (stops.length - 1)
  const i0 = Math.floor(x)
  const i1 = Math.min(i0 + 1, stops.length - 1)
  const f = x - i0
  const a = stops[i0]
  const b = stops[i1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

/** Precompute a 256-entry lookup table (Uint8, RGBA) for fast pixel writes. */
export function colormapLUT(name: ColormapName): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = sampleColormap(name, i / 255)
    lut[i * 4] = r
    lut[i * 4 + 1] = g
    lut[i * 4 + 2] = b
    lut[i * 4 + 3] = 255
  }
  return lut
}
