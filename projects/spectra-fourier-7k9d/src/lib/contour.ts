// Turn a picture into a single closed curve the epicycle machine can redraw.
//
// The pipeline is: grayscale image → binary silhouette (threshold against the
// border colour) → Moore-neighbour boundary tracing of the largest blob → an
// ordered list of points. Feeding that loop to the Fourier decomposition makes
// the rotating vectors trace the outline of any glyph or uploaded shape.

import { normalizePath, type Point } from './paths'

// Eight neighbours in clockwise order, starting East. Used by the tracer.
const DIRS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

function dirIndex(dx: number, dy: number): number {
  for (let k = 0; k < 8; k++) if (DIRS[k][0] === dx && DIRS[k][1] === dy) return k
  return 0
}

/**
 * Build a foreground mask by comparing each pixel to the average border colour,
 * so a dark shape on a light field (or vice-versa) both segment correctly.
 */
function foregroundMask(gray: ArrayLike<number>, size: number, threshold: number): Uint8Array {
  let bg = 0
  let cnt = 0
  for (let x = 0; x < size; x++) {
    bg += gray[x] + gray[(size - 1) * size + x]
    cnt += 2
  }
  for (let y = 0; y < size; y++) {
    bg += gray[y * size] + gray[y * size + size - 1]
    cnt += 2
  }
  bg /= cnt || 1
  const mask = new Uint8Array(size * size)
  for (let i = 0; i < size * size; i++) mask[i] = Math.abs(gray[i] - bg) > threshold ? 1 : 0
  return mask
}

/** Largest 4-connected component of a mask, as a fresh mask (flood fill). */
function largestComponent(mask: Uint8Array, size: number): Uint8Array {
  const label = new Int32Array(size * size).fill(0)
  const stack: number[] = []
  let best = 0
  let bestSize = 0
  let next = 1
  for (let s = 0; s < size * size; s++) {
    if (!mask[s] || label[s]) continue
    const id = next++
    let count = 0
    stack.length = 0
    stack.push(s)
    label[s] = id
    while (stack.length) {
      const p = stack.pop() as number
      count++
      const px = p % size
      const py = (p / size) | 0
      const nb = [
        px > 0 ? p - 1 : -1,
        px < size - 1 ? p + 1 : -1,
        py > 0 ? p - size : -1,
        py < size - 1 ? p + size : -1,
      ]
      for (const q of nb) {
        if (q >= 0 && mask[q] && !label[q]) {
          label[q] = id
          stack.push(q)
        }
      }
    }
    if (count > bestSize) {
      bestSize = count
      best = id
    }
  }
  const out = new Uint8Array(size * size)
  if (best) for (let i = 0; i < out.length; i++) out[i] = label[i] === best ? 1 : 0
  return out
}

/**
 * Trace the outer boundary of the dominant shape in a grayscale image and return
 * it as a normalized closed path (centered, extent ~1). Returns [] if no shape
 * is found. `threshold` (0..1) sets how far a pixel must differ from the border
 * to count as part of the shape.
 */
export function traceContour(gray: ArrayLike<number>, size: number, threshold = 0.35): Point[] {
  const raw = foregroundMask(gray, size, threshold)
  const mask = largestComponent(raw, size)
  const at = (x: number, y: number) => x >= 0 && x < size && y >= 0 && y < size && mask[y * size + x] === 1

  // Find a start pixel (raster scan) — the first foreground pixel.
  let sx = -1
  let sy = -1
  for (let i = 0; i < size * size && sx < 0; i++) {
    if (mask[i]) {
      sx = i % size
      sy = (i / size) | 0
    }
  }
  if (sx < 0) return []

  const contour: Point[] = []
  let cx = sx
  let cy = sy
  // We arrived scanning left-to-right, so the previous (background) pixel is West.
  let bx = sx - 1
  let by = sy
  const maxSteps = 8 * size * size
  for (let step = 0; step < maxSteps; step++) {
    contour.push({ x: cx, y: cy })
    const startK = dirIndex(bx - cx, by - cy)
    let found = false
    for (let i = 1; i <= 8; i++) {
      const k = (startK + i) % 8
      const nx = cx + DIRS[k][0]
      const ny = cy + DIRS[k][1]
      if (at(nx, ny)) {
        // The background pixel we last examined becomes the new backtrack.
        const pk = (startK + i - 1) % 8
        bx = cx + DIRS[pk][0]
        by = cy + DIRS[pk][1]
        cx = nx
        cy = ny
        found = true
        break
      }
    }
    if (!found) break // isolated pixel
    if (cx === sx && cy === sy && contour.length > 2) break // closed the loop
  }
  if (contour.length < 8) return []
  // Image y runs downward; flip so the redrawn shape is upright.
  return normalizePath(contour.map((p) => ({ x: p.x, y: -p.y })))
}

// ---------------------------------------------------------------------------
// Built-in glyph silhouettes so the mode works with no upload (and renders in
// the sandboxed catalog thumbnail if the canvas is available).
// ---------------------------------------------------------------------------

export const GLYPHS: { id: string; label: string }[] = [
  { id: 'λ', label: 'Lambda λ' },
  { id: 'π', label: 'Pi π' },
  { id: '@', label: 'At @' },
  { id: '&', label: 'Ampersand &' },
  { id: 'Ω', label: 'Omega Ω' },
  { id: '?', label: 'Question ?' },
  { id: 'A', label: 'Letter A' },
  { id: 'g', label: 'Letter g' },
]

/** Render a glyph to a grayscale buffer. Defensive — returns null on failure. */
export function glyphImage(text: string, size: number): Float64Array | null {
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
    ctx.font = `bold ${Math.round(size * 0.66)}px Georgia, "Times New Roman", serif`
    ctx.fillText(text, size / 2, size / 2 + size * 0.02)
    const data = ctx.getImageData(0, 0, size, size).data
    const out = new Float64Array(size * size)
    for (let i = 0; i < size * size; i++) out[i] = data[i * 4] / 255
    return out
  } catch {
    return null
  }
}
