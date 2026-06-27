import type { Point, Rect } from './types'

// A tiny seeded PRNG (mulberry32) so every point distribution is reproducible
// from a seed — handy for sharing a layout or comparing algorithms on the same
// input. Returns a function yielding floats in [0, 1).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniformly random points inside the rectangle. */
export function uniformPoints(n: number, r: Rect, rng: () => number): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < n; i++) {
    pts.push({
      x: r.minX + rng() * (r.maxX - r.minX),
      y: r.minY + rng() * (r.maxY - r.minY),
    })
  }
  return pts
}

/** Jittered grid — a near-regular lattice with a little noise. */
export function jitteredGrid(n: number, r: Rect, rng: () => number): Point[] {
  const w = r.maxX - r.minX
  const h = r.maxY - r.minY
  const aspect = w / h
  const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)))
  const rows = Math.max(1, Math.ceil(n / cols))
  const cw = w / cols
  const ch = h / rows
  const pts: Point[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols && pts.length < n; i++) {
      pts.push({
        x: r.minX + (i + 0.2 + 0.6 * rng()) * cw,
        y: r.minY + (j + 0.2 + 0.6 * rng()) * ch,
      })
    }
  }
  return pts
}

/**
 * Bridson's Poisson-disk sampling: blue-noise points no closer than `radius`.
 * Produces the organic, evenly spaced distributions that make Voronoi diagrams
 * look their best. `target` caps the count; sampling also stops naturally when
 * the active list empties.
 */
export function poissonDisk(target: number, r: Rect, rng: () => number, radius?: number): Point[] {
  const w = r.maxX - r.minX
  const h = r.maxY - r.minY
  // Pick a radius that yields roughly `target` points if not specified.
  const rad = radius ?? Math.sqrt((w * h) / (target * 1.9))
  const cell = rad / Math.SQRT2
  const gw = Math.ceil(w / cell)
  const gh = Math.ceil(h / cell)
  const grid: number[] = new Array(gw * gh).fill(-1)
  const pts: Point[] = []
  const active: number[] = []

  const gx = (p: Point) => Math.floor((p.x - r.minX) / cell)
  const gy = (p: Point) => Math.floor((p.y - r.minY) / cell)

  const fits = (p: Point) => {
    if (p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY) return false
    const cx = gx(p)
    const cy = gy(p)
    for (let j = Math.max(0, cy - 2); j <= Math.min(gh - 1, cy + 2); j++) {
      for (let i = Math.max(0, cx - 2); i <= Math.min(gw - 1, cx + 2); i++) {
        const idx = grid[j * gw + i]
        if (idx >= 0) {
          const q = pts[idx]
          const dx = q.x - p.x
          const dy = q.y - p.y
          if (dx * dx + dy * dy < rad * rad) return false
        }
      }
    }
    return true
  }

  const emit = (p: Point) => {
    const idx = pts.length
    pts.push(p)
    grid[gy(p) * gw + gx(p)] = idx
    active.push(idx)
  }

  emit({ x: r.minX + rng() * w, y: r.minY + rng() * h })

  const k = 30 // candidates per active point
  while (active.length > 0 && pts.length < target) {
    const a = Math.floor(rng() * active.length)
    const origin = pts[active[a]]
    let placed = false
    for (let attempt = 0; attempt < k; attempt++) {
      const ang = rng() * Math.PI * 2
      const dd = rad * (1 + rng())
      const cand = { x: origin.x + Math.cos(ang) * dd, y: origin.y + Math.sin(ang) * dd }
      if (fits(cand)) {
        emit(cand)
        placed = true
        break
      }
    }
    if (!placed) active.splice(a, 1)
  }
  return pts
}
