// pngSamples.ts — procedural RGBA source images for the Image Studio. Each is
// chosen to make the scanline filters behave differently: smooth gradients love
// Sub/Up, flat UI blocks love None + a palette, value-noise "photos" need the
// adaptive per-row choice, and pure noise is incompressible whatever you do.

import type { RGBAImage } from './png.ts'

function img(width: number, height: number): RGBAImage {
  return { width, height, rgba: new Uint8Array(width * height * 4) }
}
function put(im: RGBAImage, x: number, y: number, r: number, g: number, b: number, a = 255) {
  const o = (y * im.width + x) * 4
  im.rgba[o] = r
  im.rgba[o + 1] = g
  im.rgba[o + 2] = b
  im.rgba[o + 3] = a
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r: number, g: number, b: number
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

// A tiny seeded value-noise field (smooth, for the "photo" source).
function valueNoise(seed: number) {
  const grid = 8
  const rand = new Float64Array((grid + 1) * (grid + 1))
  let s = seed >>> 0
  for (let i = 0; i < rand.length; i++) {
    s = (1103515245 * s + 12345) >>> 0
    rand[i] = (s >>> 8) / 0xffffff
  }
  const smooth = (t: number) => t * t * (3 - 2 * t)
  return (u: number, v: number) => {
    const gx = u * grid, gy = v * grid
    const x0 = Math.min(grid - 1, Math.floor(gx)), y0 = Math.min(grid - 1, Math.floor(gy))
    const fx = smooth(gx - x0), fy = smooth(gy - y0)
    const a = rand[y0 * (grid + 1) + x0], b = rand[y0 * (grid + 1) + x0 + 1]
    const c = rand[(y0 + 1) * (grid + 1) + x0], d = rand[(y0 + 1) * (grid + 1) + x0 + 1]
    const top = a + (b - a) * fx, bot = c + (d - c) * fx
    return top + (bot - top) * fy
  }
}

export interface SampleDef {
  id: string
  name: string
  note: string
  make: (w: number, h: number) => RGBAImage
}

export const SAMPLES: SampleDef[] = [
  {
    id: 'gradient',
    name: 'Smooth gradient',
    note: 'Slowly varying RGB — the ideal case for Sub/Up (small residuals).',
    make(w, h) {
      const im = img(w, h)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const r = Math.round((x / (w - 1 || 1)) * 255)
          const g = Math.round((y / (h - 1 || 1)) * 255)
          const b = Math.round(((x + y) / ((w + h - 2) || 1)) * 255)
          put(im, x, y, r, g, b)
        }
      return im
    },
  },
  {
    id: 'wheel',
    name: 'Colour wheel',
    note: 'An HSV disc — hue by angle, saturation by radius; a rich full-colour test.',
    make(w, h) {
      const im = img(w, h)
      const cx = (w - 1) / 2, cy = (h - 1) / 2, R = Math.min(cx, cy)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy
          const r = Math.hypot(dx, dy)
          if (r <= R) {
            const ang = (Math.atan2(dy, dx) * 180) / Math.PI
            const [rr, gg, bb] = hsv(ang, Math.min(1, r / R), 1)
            put(im, x, y, rr, gg, bb)
          } else {
            put(im, x, y, 18, 22, 30)
          }
        }
      return im
    },
  },
  {
    id: 'rings',
    name: 'Concentric rings',
    note: 'A handful of flat colours in bands — few distinct colours, ideal for a palette.',
    make(w, h) {
      const im = img(w, h)
      const palette: [number, number, number][] = [
        [20, 24, 34], [46, 196, 182], [58, 141, 222], [162, 122, 236], [242, 183, 74], [235, 92, 112],
      ]
      const cx = (w - 1) / 2, cy = (h - 1) / 2
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const r = Math.hypot(x - cx, y - cy)
          const band = Math.floor(r / 6) % palette.length
          const [rr, gg, bb] = palette[band]
          put(im, x, y, rr, gg, bb)
        }
      return im
    },
  },
  {
    id: 'photo',
    name: 'Synthetic photo',
    note: 'Smooth value-noise "terrain" — no single filter wins every row; adaptive shines.',
    make(w, h) {
      const im = img(w, h)
      const nR = valueNoise(1337), nG = valueNoise(7919), nB = valueNoise(4242)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const u = x / (w - 1 || 1), v = y / (h - 1 || 1)
          put(
            im, x, y,
            Math.round(40 + 200 * nR(u, v)),
            Math.round(50 + 190 * nG(u, v)),
            Math.round(60 + 180 * nB(u, v)),
          )
        }
      return im
    },
  },
  {
    id: 'ui',
    name: 'Flat UI blocks',
    note: 'Sharp-edged solid rectangles — long runs; None + a palette compress hard.',
    make(w, h) {
      const im = img(w, h)
      const cols: [number, number, number][] = [
        [14, 18, 26], [46, 196, 182], [58, 141, 222], [242, 183, 74], [235, 92, 112], [162, 122, 236],
      ]
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const bx = Math.floor((x / w) * 4), by = Math.floor((y / h) * 3)
          const [r, g, b] = cols[(bx + by * 4) % cols.length]
          const border = x % Math.max(4, Math.floor(w / 4)) === 0 || y % Math.max(4, Math.floor(h / 3)) === 0
          if (border) put(im, x, y, 8, 10, 14)
          else put(im, x, y, r, g, b)
        }
      return im
    },
  },
  {
    id: 'noise',
    name: 'Random noise',
    note: 'Uniform random RGB — near-incompressible; no filter helps, the honest worst case.',
    make(w, h) {
      const im = img(w, h)
      let s = 2166136261 >>> 0
      const b = () => {
        s = (1103515245 * s + 12345) >>> 0
        return (s >>> 16) & 0xff
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(im, x, y, b(), b(), b())
      return im
    },
  },
  {
    id: 'alpha',
    name: 'Alpha vignette',
    note: 'A colourful disc fading to transparent — exercises the alpha channel (RGBA).',
    make(w, h) {
      const im = img(w, h)
      const cx = (w - 1) / 2, cy = (h - 1) / 2, R = Math.min(cx, cy)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const r = Math.hypot(x - cx, y - cy)
          const [rr, gg, bb] = hsv((r / R) * 300, 0.9, 1)
          const a = Math.max(0, Math.min(255, Math.round(255 * (1 - r / R))))
          put(im, x, y, rr, gg, bb, a)
        }
      return im
    },
  },
]
