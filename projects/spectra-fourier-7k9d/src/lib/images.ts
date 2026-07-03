// Procedural grayscale test images for the 2-D FFT mode, plus helpers to turn an
// uploaded photo into a grayscale buffer and to build radial frequency masks.
//
// Every image is a Float64Array of length width*height in [0,1], row-major.
// Procedural patterns are chosen to have instantly recognizable spectra:
// a sinusoidal grating is two bright dots, a checkerboard is a cross of dots,
// concentric rings are a ring in frequency space, and so on.

export type ImageName =
  | 'grating'
  | 'checker'
  | 'disk'
  | 'rings'
  | 'spokes'
  | 'text'
  | 'portrait'

export const IMAGES: { id: ImageName; label: string }[] = [
  { id: 'grating', label: 'Sine grating' },
  { id: 'checker', label: 'Checkerboard' },
  { id: 'disk', label: 'Disk' },
  { id: 'rings', label: 'Concentric rings' },
  { id: 'spokes', label: 'Radial spokes' },
  { id: 'text', label: 'Text "FFT"' },
  { id: 'portrait', label: 'Synthetic face' },
]

function gauss(dx: number, dy: number, s: number): number {
  return Math.exp(-(dx * dx + dy * dy) / (2 * s * s))
}

/** Generate a procedural grayscale image of the given square size. */
export function proceduralImage(name: ImageName, size: number): Float64Array {
  const out = new Float64Array(size * size)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size
      const ny = y / size
      const dx = x - c
      const dy = y - c
      const r = Math.hypot(dx, dy) / (size / 2)
      const ang = Math.atan2(dy, dx)
      let v = 0
      switch (name) {
        case 'grating':
          // A diagonal sinusoidal grating → a symmetric pair of spectral dots.
          v = 0.5 + 0.5 * Math.cos(2 * Math.PI * (nx * 8 + ny * 5))
          break
        case 'checker': {
          const s = size / 8
          v = (Math.floor(x / s) + Math.floor(y / s)) % 2 === 0 ? 0.92 : 0.08
          break
        }
        case 'disk':
          v = r < 0.55 ? 0.9 : 0.06
          break
        case 'rings':
          v = 0.5 + 0.5 * Math.cos(r * Math.PI * 9)
          break
        case 'spokes':
          v = 0.5 + 0.5 * Math.cos(ang * 12)
          break
        case 'text':
          // Fallback text is drawn on a canvas below; here provide a soft frame.
          v = 0.06
          break
        case 'portrait': {
          // A synthetic "face": bright oval head, two eye dips, a mouth curve.
          let f = 0.12
          f += 0.8 * gauss(dx, dy * 1.15, size * 0.28) // head
          f -= 0.5 * gauss(dx + size * 0.16, dy + size * 0.06, size * 0.05) // eye
          f -= 0.5 * gauss(dx - size * 0.16, dy + size * 0.06, size * 0.05) // eye
          const mouth = Math.abs(dy - size * 0.18 - 0.0015 * dx * dx)
          f -= 0.4 * Math.exp(-(mouth * mouth) / (2 * (size * 0.03) ** 2)) *
            Math.exp(-(dx * dx) / (2 * (size * 0.22) ** 2))
          v = Math.max(0, Math.min(1, f))
          break
        }
      }
      out[y * size + x] = Math.max(0, Math.min(1, v))
    }
  }

  if (name === 'text') {
    const drawn = textImage('FFT', size)
    if (drawn) return drawn
  }
  return out
}

/** Draw text to an offscreen canvas and return it as a grayscale buffer. */
function textImage(text: string, size: number): Float64Array | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `bold ${Math.round(size * 0.42)}px Inter, sans-serif`
    ctx.fillText(text, size / 2, size / 2)
    const data = ctx.getImageData(0, 0, size, size).data
    const out = new Float64Array(size * size)
    for (let i = 0; i < size * size; i++) out[i] = data[i * 4] / 255
    return out
  } catch {
    return null
  }
}

/**
 * Decode an uploaded image File into a square grayscale buffer of `size`. Cover-
 * fits the image so it fills the square. Resolves null on any failure (kept
 * defensive so a sandboxed context can't crash the mode).
 */
export function loadImageFile(file: File, size: number): Promise<Float64Array | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve(null)
          // cover-fit
          const scale = Math.max(size / img.width, size / img.height)
          const dw = img.width * scale
          const dh = img.height * scale
          ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh)
          const data = ctx.getImageData(0, 0, size, size).data
          const out = new Float64Array(size * size)
          for (let i = 0; i < size * size; i++) {
            const r = data[i * 4]
            const g = data[i * 4 + 1]
            const b = data[i * 4 + 2]
            out[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255
          }
          URL.revokeObjectURL(url)
          resolve(out)
        } catch {
          resolve(null)
        }
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        resolve(null)
      }
      img.src = url
    } catch {
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------------------
// Radial frequency masks. Built in the *centered* (fft-shifted) frequency plane,
// where the DC term sits at the middle. Radius is a fraction 0..1 of the Nyquist
// distance (corner). A cosine transition band keeps the reconstruction free of
// harsh ringing.
// ---------------------------------------------------------------------------

export type MaskKind = 'low' | 'high' | 'band'

export interface MaskParams {
  kind: MaskKind
  radius: number // 0..1 (cutoff, or band center)
  width: number // 0..1 (band half-width; ignored for low/high)
  softness: number // 0..1 transition band width
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Build a mask (length width*height, values 0..1) in the centered frequency
 * plane. Multiply a shifted spectrum by this, unshift, inverse-transform.
 */
export function radialMask(width: number, height: number, p: MaskParams): Float64Array {
  const out = new Float64Array(width * height)
  const cx = width / 2
  const cy = height / 2
  const maxR = Math.hypot(cx, cy)
  const soft = Math.max(0.001, p.softness) * 0.5
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.hypot(x - cx, y - cy) / maxR // 0..~1
      let g: number
      if (p.kind === 'low') {
        g = 1 - smoothstep(p.radius - soft, p.radius + soft, r)
      } else if (p.kind === 'high') {
        g = smoothstep(p.radius - soft, p.radius + soft, r)
      } else {
        const lo = Math.max(0, p.radius - p.width)
        const hi = p.radius + p.width
        const up = smoothstep(lo - soft, lo + soft, r)
        const down = 1 - smoothstep(hi - soft, hi + soft, r)
        g = up * down
      }
      out[y * width + x] = g
    }
  }
  return out
}
