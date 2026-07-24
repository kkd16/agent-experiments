// One "lane" of the studio: a simulation bound to a canvas. It owns the DOM
// element handles, the drawing context/transform, and the long-exposure cloud,
// and exposes them only through methods — which keeps every mutation inside a
// plain-object boundary (no React-ref value is ever reassigned from the
// outside), satisfying the compiler-based react-hooks immutability rules while
// letting the animation loop drive N lanes uniformly.

import { Simulation } from './simulation'
import type { LiveStats, SimConfig } from './simulation'
import { makeTransform } from '../render/field'
import type { Transform } from '../render/field'
import { drawScene } from '../render/scene'
import type { SceneOpts } from '../render/scene'

/** DPI-aware backing store for a canvas; returns its 2-D context. */
function prepCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

export class Lane {
  readonly index: number
  private readonly splatColor: string
  private readonly trailRGB: [number, number, number]

  sim: Simulation | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private tf: Transform | null = null
  private cloud: HTMLCanvasElement | null = null
  private cloudCtx: CanvasRenderingContext2D | null = null
  private splat = 0

  private canvasEl: HTMLCanvasElement | null = null
  private wrapEl: HTMLElement | null = null

  constructor(index: number, splatColor: string, trailRGB: [number, number, number]) {
    this.index = index
    this.splatColor = splatColor
    this.trailRGB = trailRGB
  }

  // ── DOM element handles (set via React callback refs at commit time) ──
  attachCanvas(el: HTMLCanvasElement | null) {
    this.canvasEl = el
  }
  attachWrap(el: HTMLElement | null) {
    this.wrapEl = el
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  rebuild(config: SimConfig) {
    this.sim = new Simulation(config)
    if (this.cloud && this.cloudCtx) this.cloudCtx.clearRect(0, 0, this.cloud.width, this.cloud.height)
    this.splat = 0
  }
  clear() {
    this.sim = null
  }
  setBurnIn(v: number) {
    if (this.sim) this.sim.config.burnInFrac = v
  }
  step(n: number) {
    this.sim?.step(n)
  }

  /** Fit the canvas to its wrapper (DPI aware) and rebuild the transform. */
  resize(view: [number, number, number, number]) {
    const wrap = this.wrapEl
    const canvas = this.canvasEl
    if (!wrap || !canvas) return
    const rect = wrap.getBoundingClientRect()
    const side = Math.max(160, Math.min(rect.width, rect.height))
    canvas.style.width = `${side}px`
    canvas.style.height = `${side}px`
    this.ctx = prepCanvas(canvas, side, side)
    this.tf = makeTransform(view, side, side)
    // The accumulation canvas mirrors the main one; resizing clears it, so we
    // skip past already-seen samples rather than re-splatting the whole chain.
    if (!this.cloud) this.cloud = document.createElement('canvas')
    this.cloudCtx = prepCanvas(this.cloud, side, side)
    this.splat = this.sim ? this.sim.xs.length : 0
  }

  /** One frame: splat new samples onto the cloud, then draw the scene. */
  render(field: HTMLCanvasElement | null, cloudOn: boolean, opts: SceneOpts) {
    const { sim, ctx, tf } = this
    if (!sim || !ctx || !tf) return
    const cctx = this.cloudCtx
    if (cctx) {
      cctx.globalCompositeOperation = 'lighter'
      cctx.fillStyle = this.splatColor
      const from = Math.min(this.splat, sim.xs.length)
      for (let k = from; k < sim.xs.length; k++) {
        const [px, py] = tf.toPx(sim.xs[k], sim.ys[k])
        cctx.beginPath()
        cctx.arc(px, py, 1.4, 0, Math.PI * 2)
        cctx.fill()
      }
      this.splat = sim.xs.length
    }
    drawScene(ctx, sim, tf, field, cloudOn ? this.cloud : null, { ...opts, trailRGB: this.trailRGB })
  }

  // ── read-outs ──────────────────────────────────────────────────────────
  stats(): LiveStats | null {
    return this.sim ? this.sim.stats() : null
  }
  column(dim: 0 | 1): number[] {
    return this.sim ? this.sim.column(dim) : []
  }
  /** Convergence history: whole-chain running-mean of a coordinate vs iters. */
  history(dim: 0 | 1): { iter: number[]; val: number[] } {
    if (!this.sim) return { iter: [], val: [] }
    return { iter: this.sim.histIter, val: dim === 0 ? this.sim.histMeanX : this.sim.histMeanY }
  }
  get chain(): Simulation | null {
    return this.sim
  }
}
