// Canvas2D renderer for the N-body field.
//
// Each body is drawn as a pre-rendered radial-glow sprite with additive
// ("lighter") compositing, so overlapping glows sum into bright cores and soft
// halos — the look of a real star field. To stay fast at tens of thousands of
// bodies we never build gradients in the hot loop: a palette of tinted sprites
// is generated once, and each body just picks the sprite matching its mapped
// value and blits it. Motion trails come from fading the previous frame instead
// of clearing it.
//
// On top of the field the renderer paints a few diagnostic overlays — accretion
// flashes, forecast trajectories, the selected-body marker, a colour-bar legend
// and a scale bar — all driven by data the caller passes in each frame.

import type { Camera } from './Camera'
import type { Simulation } from '../sim/Simulation'
import { sampleColorMap, type ColorMapId } from './colormap'

export type ColorBy = 'speed' | 'mass' | 'accel'

export interface RenderOptions {
  colorMap: ColorMapId
  colorBy: ColorBy
  trails: boolean
  trailFade: number // 0..1, higher = shorter trails
  glowSize: number // base sprite radius in pixels
  brightness: number // 0..1 global alpha per sprite
  showQuadtree: boolean
  showLegend: boolean // colour-bar + scale-bar overlay
  showField: boolean // gravitational-potential heatmap background
  background: string
}

export interface RenderOverlay {
  /** Forecast paths (flat [x0,y0,x1,y1,…] world coords) and their colours. */
  trajectories?: { paths: Float64Array[]; colors: string[] }
  /** Index of the body to mark as selected, or -1/undefined for none. */
  selected?: number
}

const PALETTE_SIZE = 64
const SPRITE_PX = 64

const COLOR_BY_LABEL: Record<ColorBy, string> = {
  speed: 'speed',
  mass: 'mass',
  accel: 'accel.',
}

export class Renderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private sprites: HTMLCanvasElement[] = []
  private spriteMap: ColorMapId | null = null
  /** Last colour-range used, exposed so the legend can label it. */
  private lastLo = 0
  private lastHi = 1
  // Reusable buffers for the potential-field heatmap (sized to the coarse grid).
  private fieldCanvas: HTMLCanvasElement | null = null
  private fieldVals: Float64Array | null = null
  private fieldImage: ImageData | null = null
  private fieldStack = new Int32Array(8192)

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

  /** Device-pixel-ratio of the backing store, for crisp overlay text. */
  private get dpr(): number {
    // Derived from how App sizes things; one device pixel ≈ this many CSS px⁻¹.
    return Math.max(1, this.canvas.width / Math.max(1, this.canvas.clientWidth || this.canvas.width))
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

  render(sim: Simulation, camera: Camera, opts: RenderOptions, overlay?: RenderOverlay): void {
    this.buildPalette(opts.colorMap)
    const { ctx } = this
    const W = this.canvas.width
    const H = this.canvas.height

    if (opts.showField && sim.count > 0 && sim.quadtree.nodeCount > 0) this.drawField(sim, camera, opts)
    else this.clearOrFade(opts)

    if (opts.showQuadtree) this.drawQuadtree(sim, camera)
    if (overlay?.trajectories) this.drawTrajectories(overlay.trajectories, camera)

    const n = sim.count
    if (n > 0) {
      // Compute the normalisation range for the chosen colour channel.
      const { posX, posY, velX, velY, mass, accX, accY } = sim
      let lo = Infinity
      let hi = -Infinity
      const channel = (i: number): number => {
        if (opts.colorBy === 'speed') return Math.hypot(velX[i], velY[i])
        if (opts.colorBy === 'accel') return Math.hypot(accX[i], accY[i])
        return Math.log(mass[i] + 1)
      }
      for (let i = 0; i < n; i++) {
        const v = channel(i)
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const span = hi - lo > 1e-9 ? hi - lo : 1
      this.lastLo = lo
      this.lastHi = hi

      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = Math.min(1, Math.max(0.05, opts.brightness))

      const scale = camera.scale
      const glow = opts.glowSize
      const lastSprite = PALETTE_SIZE - 1
      const margin = 64

      for (let i = 0; i < n; i++) {
        const sx = camera.worldToScreenX(posX[i])
        const sy = camera.worldToScreenY(posY[i])
        if (sx < -margin || sx > W + margin || sy < -margin || sy > H + margin) continue

        const t = (channel(i) - lo) / span
        const idx = t <= 0 ? 0 : t >= 1 ? lastSprite : (t * lastSprite) | 0
        const sprite = this.sprites[idx]

        const m = mass[i]
        let radius = glow * (0.6 + 0.5 * Math.cbrt(m))
        if (m > 50) radius += Math.min(40, m * scale * 0.0008)
        if (radius > 48) radius = 48
        const d = radius * 2
        ctx.drawImage(sprite, sx - radius, sy - radius, d, d)
      }
      ctx.globalAlpha = 1
    }

    this.drawFlashes(sim, camera)
    ctx.globalCompositeOperation = 'source-over'
    if (overlay?.selected != null && overlay.selected >= 0 && overlay.selected < sim.count) {
      this.drawSelection(sim, overlay.selected, camera)
    }
    if (opts.showLegend) this.drawLegend(opts)
    if (opts.showLegend) this.drawScaleBar(camera)
  }

  private drawTrajectories(traj: { paths: Float64Array[]; colors: string[] }, camera: Camera): void {
    const { ctx } = this
    const dpr = this.dpr
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = Math.max(1, 1.4 * dpr)
    ctx.lineJoin = 'round'
    for (let p = 0; p < traj.paths.length; p++) {
      const path = traj.paths[p]
      const len = path.length >> 1
      if (len < 2) continue
      ctx.strokeStyle = traj.colors[p] ?? 'rgba(150,190,255,0.7)'
      // Fade the line toward its tip by drawing in segments of rising alpha.
      ctx.beginPath()
      for (let k = 0; k < len; k++) {
        const x = camera.worldToScreenX(path[k * 2])
        const y = camera.worldToScreenY(path[k * 2 + 1])
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.globalAlpha = 0.55
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawFlashes(sim: Simulation, camera: Camera): void {
    const n = sim.flashX.length
    if (n === 0) return
    const { ctx } = this
    const dpr = this.dpr
    ctx.globalCompositeOperation = 'lighter'
    const LIFE = 28
    for (let i = 0; i < n; i++) {
      const age = sim.flashAge[i]
      const f = 1 - age / LIFE
      if (f <= 0) continue
      const sx = camera.worldToScreenX(sim.flashX[i])
      const sy = camera.worldToScreenY(sim.flashY[i])
      const base = (6 + Math.min(34, Math.cbrt(sim.flashMass[i]) * 2)) * dpr
      const r = base * (0.3 + (age / LIFE) * 1.8)
      ctx.globalAlpha = f * 0.8
      ctx.strokeStyle = `rgba(255,${Math.round(180 + 60 * f)},120,1)`
      ctx.lineWidth = Math.max(1, 2 * dpr * f)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.stroke()
      // A bright spark at the core early in the flash.
      ctx.globalAlpha = f * f
      ctx.fillStyle = 'rgba(255,240,200,1)'
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(1, 3 * dpr * f), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawSelection(sim: Simulation, i: number, camera: Camera): void {
    const { ctx } = this
    const dpr = this.dpr
    const sx = camera.worldToScreenX(sim.posX[i])
    const sy = camera.worldToScreenY(sim.posY[i])
    const r = (10 + Math.min(26, Math.cbrt(sim.mass[i]) * 1.5)) * dpr
    ctx.strokeStyle = 'rgba(95,208,255,0.95)'
    ctx.lineWidth = 1.6 * dpr
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.stroke()
    // Cross-hair ticks.
    ctx.beginPath()
    const tick = 5 * dpr
    ctx.moveTo(sx - r - tick, sy)
    ctx.lineTo(sx - r, sy)
    ctx.moveTo(sx + r, sy)
    ctx.lineTo(sx + r + tick, sy)
    ctx.moveTo(sx, sy - r - tick)
    ctx.lineTo(sx, sy - r)
    ctx.moveTo(sx, sy + r)
    ctx.lineTo(sx, sy + r + tick)
    ctx.stroke()
  }

  private drawLegend(opts: RenderOptions): void {
    const { ctx } = this
    const dpr = this.dpr
    const W = this.canvas.width
    const barW = 150 * dpr
    const barH = 9 * dpr
    const x = W - barW - 18 * dpr
    const y = 16 * dpr

    // Gradient swatch sampled from the active colour map.
    const steps = 48
    for (let s = 0; s < steps; s++) {
      const t = s / (steps - 1)
      const [r, g, b] = sampleColorMap(opts.colorMap, t)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(x + (barW * s) / steps, y, barW / steps + 1, barH)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(x, y, barW, barH)

    ctx.fillStyle = 'rgba(231,236,255,0.85)'
    ctx.font = `${11 * dpr}px ui-monospace, monospace`
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillText(COLOR_BY_LABEL[opts.colorBy], x, y - 5 * dpr)
    ctx.fillStyle = 'rgba(160,170,200,0.8)'
    const fmt = (v: number) =>
      Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.01) ? v.toExponential(1) : v.toFixed(2)
    const lo = opts.colorBy === 'mass' ? Math.exp(this.lastLo) - 1 : this.lastLo
    const hi = opts.colorBy === 'mass' ? Math.exp(this.lastHi) - 1 : this.lastHi
    ctx.fillText(fmt(lo), x, y + barH + 12 * dpr)
    ctx.textAlign = 'right'
    ctx.fillText(fmt(hi), x + barW, y + barH + 12 * dpr)
    ctx.textAlign = 'left'
  }

  private drawScaleBar(camera: Camera): void {
    const { ctx } = this
    const dpr = this.dpr
    const W = this.canvas.width
    const H = this.canvas.height
    // Aim for a bar around 120 device px; snap its world length to 1/2/5 × 10ⁿ.
    const targetPx = 120 * dpr
    const rawWorld = targetPx / camera.scale
    const pow = Math.pow(10, Math.floor(Math.log10(rawWorld)))
    const mant = rawWorld / pow
    const nice = mant >= 5 ? 5 : mant >= 2 ? 2 : 1
    const worldLen = nice * pow
    const px = worldLen * camera.scale

    const x = W - px - 18 * dpr
    const y = H - 20 * dpr
    ctx.strokeStyle = 'rgba(231,236,255,0.7)'
    ctx.lineWidth = 1.5 * dpr
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + px, y)
    ctx.moveTo(x, y - 4 * dpr)
    ctx.lineTo(x, y + 4 * dpr)
    ctx.moveTo(x + px, y - 4 * dpr)
    ctx.lineTo(x + px, y + 4 * dpr)
    ctx.stroke()
    ctx.fillStyle = 'rgba(231,236,255,0.85)'
    ctx.font = `${11 * dpr}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    const label = worldLen >= 1000 ? `${(worldLen / 1000).toFixed(worldLen % 1000 ? 1 : 0)}k u` : `${worldLen} u`
    ctx.fillText(label, x + px / 2, y - 6 * dpr)
    ctx.textAlign = 'left'
  }

  /**
   * Paint the gravitational-potential field as a coarse heatmap that fills the
   * background. Potentials are sampled on a downscaled grid through the very same
   * Barnes–Hut tree the force solve built, then log-compressed, colour-mapped and
   * stretched to full size — so you literally see the wells the bodies fall into.
   * (When on, this replaces the trail-fade clear: the field is repainted each
   * frame.)
   */
  private drawField(sim: Simulation, camera: Camera, opts: RenderOptions): void {
    const { ctx } = this
    const W = this.canvas.width
    const H = this.canvas.height
    const CELL = 12
    const gw = Math.max(2, Math.ceil(W / CELL))
    const gh = Math.max(2, Math.ceil(H / CELL))

    if (!this.fieldCanvas) this.fieldCanvas = document.createElement('canvas')
    const fc = this.fieldCanvas
    if (fc.width !== gw || fc.height !== gh || !this.fieldImage || !this.fieldVals) {
      fc.width = gw
      fc.height = gh
      this.fieldVals = new Float64Array(gw * gh)
      this.fieldImage = fc.getContext('2d')!.createImageData(gw, gh)
    }
    const fctx = fc.getContext('2d')!
    const vals = this.fieldVals!
    const img = this.fieldImage!
    const data = img.data

    const tree = sim.quadtree
    const theta2 = sim.params.theta * sim.params.theta
    const eps2 = sim.params.softening * sim.params.softening
    const g = sim.params.g
    const stack = this.fieldStack
    const sxScale = W / gw
    const syScale = H / gh

    let lo = Infinity
    let hi = -Infinity
    for (let gy = 0; gy < gh; gy++) {
      const wy = camera.screenToWorldY((gy + 0.5) * syScale)
      for (let gx = 0; gx < gw; gx++) {
        const wx = camera.screenToWorldX((gx + 0.5) * sxScale)
        const v = Math.log(1 + Math.abs(tree.potential(wx, wy, theta2, eps2, g, stack)))
        vals[gy * gw + gx] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    const span = hi - lo > 1e-9 ? hi - lo : 1
    for (let i = 0; i < vals.length; i++) {
      const t = (vals[i] - lo) / span
      const [r, gg, b] = sampleColorMap(opts.colorMap, t)
      const k = i * 4
      // Dim so the body field reads clearly on top.
      data[k] = r * 0.5
      data[k + 1] = gg * 0.5
      data[k + 2] = b * 0.5
      data[k + 3] = 255
    }
    fctx.putImageData(img, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(fc, 0, 0, gw, gh, 0, 0, W, H)
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
