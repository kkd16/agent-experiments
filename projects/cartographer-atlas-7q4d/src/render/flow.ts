// Flow-field visualisation — streamlines and animated particle drift for the wind and ocean
// circulation. The engine gives a vector (u,v) per Voronoi region; this module samples that
// onto a regular grid (fast bilinear lookup), draws static direction arrows for export, and
// advects thousands of motes along the field for the live animation.
//
// Screen axes: +x = east, +y = south — the same convention the engine's vectors use, so a
// particle at (x,y) simply steps by (u,v).

import type { WorldMap } from '../core/types'
import type { Palette } from './palettes'

export type FlowKind = 'wind' | 'current'

/** A regular-grid resample of a per-region vector field, with O(1) bilinear sampling. */
export class FlowField {
  readonly cols: number
  readonly rows: number
  readonly W: number
  readonly H: number
  private u: Float32Array
  private v: Float32Array
  private valid: Uint8Array
  /** Peak sampled speed, for normalisation. */
  readonly peak: number

  constructor(world: WorldMap, kind: FlowKind, cols = 110) {
    const W = world.params.width
    const H = world.params.height
    this.W = W
    this.H = H
    this.cols = cols
    this.rows = Math.max(2, Math.round((cols * H) / W))
    const nGrid = this.cols * this.rows
    this.u = new Float32Array(nGrid)
    this.v = new Float32Array(nGrid)
    this.valid = new Uint8Array(nGrid)

    const index = buildSiteIndex(world)
    const c = world.circulation
    const fu = kind === 'wind' ? c.windU : c.curU
    const fv = kind === 'wind' ? c.windV : c.curV
    const isOcean = (r: number): boolean => world.ocean[r] === 1 || world.lake[r] === 1

    let peak = 1e-6
    for (let gy = 0; gy < this.rows; gy++) {
      for (let gx = 0; gx < this.cols; gx++) {
        const x = ((gx + 0.5) / this.cols) * W
        const y = ((gy + 0.5) / this.rows) * H
        const r = nearestSite(index, world, x, y)
        const gi = gy * this.cols + gx
        // Wind is defined everywhere; current only over the sea.
        const ok = r >= 0 && (kind === 'wind' ? true : isOcean(r))
        if (ok) {
          this.u[gi] = fu[r]
          this.v[gi] = fv[r]
          this.valid[gi] = 1
          const s = Math.hypot(fu[r], fv[r])
          if (s > peak) peak = s
        }
      }
    }
    this.peak = peak
  }

  /** Bilinear sample of (u,v); returns zero vector and valid=false outside the field. */
  sample(x: number, y: number, out: { u: number; v: number; valid: boolean }): void {
    const fx = (x / this.W) * this.cols - 0.5
    const fy = (y / this.H) * this.rows - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    let u = 0
    let v = 0
    let wsum = 0
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const gx = x0 + dx
        const gy = y0 + dy
        if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) continue
        const gi = gy * this.cols + gx
        if (!this.valid[gi]) continue
        const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty)
        u += this.u[gi] * w
        v += this.v[gi] * w
        wsum += w
      }
    }
    if (wsum > 0.35) {
      out.u = u / wsum
      out.v = v / wsum
      out.valid = true
    } else {
      out.u = 0
      out.v = 0
      out.valid = false
    }
  }
}

// --- Fast nearest-region lookup ---------------------------------------------

interface SiteIndex {
  cols: number
  rows: number
  cellW: number
  cellH: number
  buckets: Int32Array[]
}

const siteIndexCache = new WeakMap<WorldMap, SiteIndex>()

function buildSiteIndex(world: WorldMap): SiteIndex {
  const cached = siteIndexCache.get(world)
  if (cached) return cached
  const W = world.params.width
  const H = world.params.height
  const mesh = world.mesh
  // ~ one bucket per few regions.
  const cols = Math.max(4, Math.round(Math.sqrt(mesh.numSolid / 2)))
  const rows = Math.max(4, Math.round((cols * H) / W))
  const cellW = W / cols
  const cellH = H / rows
  const lists: number[][] = Array.from({ length: cols * rows }, () => [])
  for (let r = 0; r < mesh.numSolid; r++) {
    const gx = Math.min(cols - 1, Math.max(0, Math.floor(mesh.px[r] / cellW)))
    const gy = Math.min(rows - 1, Math.max(0, Math.floor(mesh.py[r] / cellH)))
    lists[gy * cols + gx].push(r)
  }
  const buckets = lists.map((l) => Int32Array.from(l))
  const idx: SiteIndex = { cols, rows, cellW, cellH, buckets }
  siteIndexCache.set(world, idx)
  return idx
}

function nearestSite(index: SiteIndex, world: WorldMap, x: number, y: number): number {
  const { cols, rows, cellW, cellH, buckets } = index
  const mesh = world.mesh
  const cgx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellW)))
  const cgy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellH)))
  let best = -1
  let bestD = Infinity
  // Expand ring by ring until we've found a site and covered one extra ring for safety.
  for (let ring = 0; ring < Math.max(cols, rows); ring++) {
    const x0 = Math.max(0, cgx - ring)
    const x1 = Math.min(cols - 1, cgx + ring)
    const y0 = Math.max(0, cgy - ring)
    const y1 = Math.min(rows - 1, cgy + ring)
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        // Only the ring's perimeter is new.
        if (ring > 0 && gx > x0 && gx < x1 && gy > y0 && gy < y1) continue
        const list = buckets[gy * cols + gx]
        for (let k = 0; k < list.length; k++) {
          const r = list[k]
          const dx = mesh.px[r] - x
          const dy = mesh.py[r] - y
          const d = dx * dx + dy * dy
          if (d < bestD) {
            bestD = d
            best = r
          }
        }
      }
    }
    if (best >= 0 && ring >= 1) break
  }
  return best
}

// --- Static streamline arrows (captured by PNG/thumbnail export) -------------

/** Draw a sparse grid of direction arrows for the given field. */
export function drawFlowArrows(
  ctx: CanvasRenderingContext2D,
  world: WorldMap,
  kind: FlowKind,
  pal: Palette,
): void {
  const field = new FlowField(world, kind, kind === 'wind' ? 46 : 60)
  const W = world.params.width
  const H = world.params.height
  const L = Math.min(W, H) * (kind === 'wind' ? 0.03 : 0.024)
  const color = kind === 'wind' ? pal.wind ?? 'rgba(230,238,248,0.35)' : pal.riverLabel ?? 'rgba(180,235,255,0.5)'
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = kind === 'wind' ? 1 : 1.1
  ctx.lineCap = 'round'
  const s = { u: 0, v: 0, valid: false }
  for (let gy = 0; gy < field.rows; gy++) {
    for (let gx = 0; gx < field.cols; gx++) {
      const x = ((gx + 0.5) / field.cols) * W
      const y = ((gy + 0.5) / field.rows) * H
      field.sample(x, y, s)
      if (!s.valid) continue
      const mag = Math.hypot(s.u, s.v)
      if (mag < 1e-3) continue
      const ang = Math.atan2(s.v, s.u)
      const len = L * (0.5 + Math.min(1, mag / (field.peak || 1)))
      const dx = Math.cos(ang)
      const dy = Math.sin(ang)
      const x0 = x - dx * len * 0.5
      const y0 = y - dy * len * 0.5
      const x1 = x + dx * len * 0.5
      const y1 = y + dy * len * 0.5
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      const hl = len * 0.4
      const a2 = 0.5
      ctx.lineTo(x1 - hl * Math.cos(ang - a2), y1 - hl * Math.sin(ang - a2))
      ctx.moveTo(x1, y1)
      ctx.lineTo(x1 - hl * Math.cos(ang + a2), y1 - hl * Math.sin(ang + a2))
      ctx.stroke()
    }
  }
}

// --- Animated particle drift -------------------------------------------------

/** A pool of motes advected along a FlowField, drawn as short fading streaks. */
export class FlowAnimator {
  private field: FlowField
  private W: number
  private H: number
  private n: number
  private x: Float32Array
  private y: Float32Array
  private px: Float32Array
  private py: Float32Array
  private age: Float32Array
  private life: Float32Array
  private speedScale: number
  private color: string
  private s = { u: 0, v: 0, valid: false }

  constructor(world: WorldMap, kind: FlowKind, count: number, color: string) {
    this.field = new FlowField(world, kind, kind === 'wind' ? 120 : 130)
    this.W = world.params.width
    this.H = world.params.height
    this.n = count
    this.x = new Float32Array(count)
    this.y = new Float32Array(count)
    this.px = new Float32Array(count)
    this.py = new Float32Array(count)
    this.age = new Float32Array(count)
    this.life = new Float32Array(count)
    this.speedScale = Math.min(this.W, this.H) * (kind === 'wind' ? 0.16 : 0.14)
    this.color = color
    for (let i = 0; i < count; i++) this.spawn(i, true)
  }

  private spawn(i: number, initial: boolean): void {
    // Rejection-sample a valid starting point.
    for (let tries = 0; tries < 24; tries++) {
      const x = Math.random() * this.W
      const y = Math.random() * this.H
      this.field.sample(x, y, this.s)
      if (this.s.valid) {
        this.x[i] = x
        this.y[i] = y
        this.px[i] = x
        this.py[i] = y
        this.age[i] = initial ? Math.random() * 2 : 0
        this.life[i] = 1.4 + Math.random() * 2.2
        return
      }
    }
    // Give up gracefully: park it and let it respawn next frame.
    this.x[i] = -1
    this.y[i] = -1
    this.age[i] = 999
    this.life[i] = 0
  }

  /** Advance every particle by dt seconds and draw its streak. */
  step(ctx: CanvasRenderingContext2D, dt: number): void {
    const s = this.s
    ctx.lineCap = 'round'
    ctx.strokeStyle = this.color
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt
      if (this.age[i] > this.life[i] || this.x[i] < 0) {
        this.spawn(i, false)
        continue
      }
      this.field.sample(this.x[i], this.y[i], s)
      if (!s.valid) {
        this.spawn(i, false)
        continue
      }
      this.px[i] = this.x[i]
      this.py[i] = this.y[i]
      this.x[i] += s.u * this.speedScale * dt
      this.y[i] += s.v * this.speedScale * dt
      if (this.x[i] < 0 || this.y[i] < 0 || this.x[i] > this.W || this.y[i] > this.H) {
        this.spawn(i, false)
        continue
      }
      const mag = Math.hypot(s.u, s.v)
      // Fade in and out over the particle's life; brighter where the flow is faster.
      const t = this.age[i] / this.life[i]
      const envelope = Math.sin(Math.PI * t)
      const alpha = Math.min(0.9, 0.15 + mag * 0.9) * envelope
      if (alpha <= 0.01) continue
      ctx.globalAlpha = alpha
      ctx.lineWidth = 0.7 + mag * 1.6
      ctx.beginPath()
      ctx.moveTo(this.px[i], this.py[i])
      ctx.lineTo(this.x[i], this.y[i])
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
}
