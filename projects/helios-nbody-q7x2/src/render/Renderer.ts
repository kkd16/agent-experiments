// Canvas2D renderer for the N-body field.
//
// Each body is drawn as a pre-rendered radial-glow sprite with additive
// ("lighter") compositing, so overlapping glows sum into bright cores and soft
// halos — the look of a real star field. To stay fast at tens of thousands of
// bodies we never build gradients in the hot loop: a palette of tinted sprites
// is generated once, and each body just picks the sprite matching its mapped
// value and blits it. Motion trails come from fading the previous frame instead
// of clearing it.

import type { Camera } from './Camera'
import type { Simulation } from '../sim/Simulation'
import { sampleColorMap, type ColorMapId } from './colormap'

export type ColorBy = 'speed' | 'mass'

export interface RenderOptions {
  colorMap: ColorMapId
  colorBy: ColorBy
  trails: boolean
  trailFade: number // 0..1, higher = shorter trails
  glowSize: number // base sprite radius in pixels
  brightness: number // 0..1 global alpha per sprite
  showQuadtree: boolean
  background: string
}

const PALETTE_SIZE = 64
const SPRITE_PX = 64

export class Renderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private sprites: HTMLCanvasElement[] = []
  private spriteMap: ColorMapId | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
  }

  /** (Re)build the tinted glow sprite palette for a colour map. */
  private buildPalette(map: ColorMapId): void {
    if (this.spriteMap === map && this.sprites.length === PALETTE_SIZE) return
    this.sprites = []
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const t = i / (PALETTE_SIZE - 1)
      const [r, g, b] = sampleColorMap(map, t)
      const c = document.createElement('canvas')
      c.width = SPRITE_PX
      c.height = SPRITE_PX
      const sctx = c.getContext('2d')!
      const cx = SPRITE_PX / 2
      const grad = sctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
      grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`)
      grad.addColorStop(0.2, `rgba(${r},${g},${b},0.55)`)
      grad.addColorStop(0.5, `rgba(${r},${g},${b},0.18)`)
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
      sctx.fillStyle = grad
      sctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX)
      this.sprites.push(c)
    }
    this.spriteMap = map
  }

  /** Resize the backing store to match a CSS size and device pixel ratio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr))
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr))
  }

  private clearOrFade(opts: RenderOptions): void {
    const { ctx } = this
    const { width, height } = this.canvas
    ctx.globalCompositeOperation = 'source-over'
    if (opts.trails) {
      // Fade toward the background colour to leave decaying trails.
      ctx.globalAlpha = Math.min(1, Math.max(0.02, opts.trailFade))
      ctx.fillStyle = opts.background
      ctx.fillRect(0, 0, width, height)
      ctx.globalAlpha = 1
    } else {
      ctx.fillStyle = opts.background
      ctx.fillRect(0, 0, width, height)
    }
  }

  render(sim: Simulation, camera: Camera, opts: RenderOptions): void {
    this.buildPalette(opts.colorMap)
    const { ctx } = this
    const W = this.canvas.width
    const H = this.canvas.height

    this.clearOrFade(opts)

    if (opts.showQuadtree) this.drawQuadtree(sim, camera)

    const n = sim.count
    if (n === 0) return

    // Compute the normalisation range for the chosen colour channel.
    const { posX, posY, velX, velY, mass } = sim
    let lo = Infinity
    let hi = -Infinity
    if (opts.colorBy === 'speed') {
      for (let i = 0; i < n; i++) {
        const s = velX[i] * velX[i] + velY[i] * velY[i]
        if (s < lo) lo = s
        if (s > hi) hi = s
      }
      lo = Math.sqrt(lo)
      hi = Math.sqrt(hi)
    } else {
      for (let i = 0; i < n; i++) {
        const m = Math.log(mass[i] + 1)
        if (m < lo) lo = m
        if (m > hi) hi = m
      }
    }
    const span = hi - lo > 1e-9 ? hi - lo : 1

    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.min(1, Math.max(0.05, opts.brightness))

    const scale = camera.scale
    const glow = opts.glowSize
    const lastSprite = PALETTE_SIZE - 1
    // Cull bodies outside the viewport (with a sprite-sized margin).
    const margin = 64

    for (let i = 0; i < n; i++) {
      const sx = camera.worldToScreenX(posX[i])
      const sy = camera.worldToScreenY(posY[i])
      if (sx < -margin || sx > W + margin || sy < -margin || sy > H + margin) continue

      let t: number
      if (opts.colorBy === 'speed') {
        const s = Math.sqrt(velX[i] * velX[i] + velY[i] * velY[i])
        t = (s - lo) / span
      } else {
        t = (Math.log(mass[i] + 1) - lo) / span
      }
      const idx = t <= 0 ? 0 : t >= 1 ? lastSprite : (t * lastSprite) | 0
      const sprite = this.sprites[idx]

      // Size grows weakly with mass and with zoom, clamped to stay point-like.
      const m = mass[i]
      let radius = glow * (0.6 + 0.5 * Math.cbrt(m))
      // Massive seeds (galactic cores / stars) scale a little with zoom.
      if (m > 50) radius += Math.min(40, m * scale * 0.0008)
      if (radius > 48) radius = 48
      const d = radius * 2
      ctx.drawImage(sprite, sx - radius, sy - radius, d, d)
    }

    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawQuadtree(sim: Simulation, camera: Camera): void {
    const { ctx } = this
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = 'rgba(120,170,255,0.16)'
    ctx.lineWidth = 1
    ctx.beginPath()
    sim.quadtree.forEachCell((cx, cy, half) => {
      const x = camera.worldToScreenX(cx - half)
      const y = camera.worldToScreenY(cy - half)
      const s = half * 2 * camera.scale
      if (s < 3) return // skip cells too small to see
      ctx.rect(x, y, s, s)
    })
    ctx.stroke()
  }
}
