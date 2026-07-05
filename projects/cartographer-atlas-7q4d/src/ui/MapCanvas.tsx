// Responsive canvas that renders the current world. Sizes its backing store to the
// container width × device-pixel-ratio and maps world coordinates (0..width,
// 0..height) onto it, so the map is always crisp and fills the pane. Clicking picks
// the Voronoi cell under the cursor and reports it up for the inspector.
//
// When the flow animation is on, the (expensive) base map is rendered once to an offscreen
// canvas and blitted every frame, with the drifting circulation particles advected on top —
// so the atlas breathes without repainting every Voronoi cell each frame.

import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import type { HistoryFrame, WorldMap } from '../core/types'
import { renderWorld, nearestRegion } from '../render/render'
import { paletteByKey } from '../render/palettes'
import { FlowAnimator } from '../render/flow'
import type { ViewOptions } from './viewOptions'

interface Props {
  world: WorldMap | null
  view: ViewOptions
  selected: number | null
  onPick: (region: number | null) => void
  /** When the timeline is open, the history frame to render (else null). */
  frame?: HistoryFrame | null
}

/** Rough luminance of a hex/`rgb()` background, for picking a legible particle colour. */
function isDarkBackground(css: string): boolean {
  const m = css.match(/#([0-9a-f]{6})/i)
  if (m) {
    const h = m[1]
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return 0.299 * r + 0.587 * g + 0.114 * b < 128
  }
  return true
}

export default function MapCanvas({ world, view, selected, onPick, frame }: Props): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !world) return

    const W = world.params.width
    const H = world.params.height
    const pal = paletteByKey(view.paletteKey)

    let raf = 0
    let base: HTMLCanvasElement | null = null
    let animator: FlowAnimator | null = null
    let lastT = 0

    const renderBase = (): { cw: number; ch: number; dpr: number } => {
      const ctx = canvas.getContext('2d')
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cssW = Math.max(1, wrap.clientWidth)
      const cssH = cssW * (H / W)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      if (ctx) {
        ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0)
        renderWorld(ctx, world, { palette: pal, view, selected, frame })
      }
      return { cw: canvas.width, ch: canvas.height, dpr }
    }

    const startAnimation = (): void => {
      // Snapshot the freshly-drawn base into an offscreen canvas we blit each frame.
      try {
        const b = document.createElement('canvas')
        b.width = canvas.width
        b.height = canvas.height
        const bctx = b.getContext('2d')
        if (!bctx) return
        bctx.drawImage(canvas, 0, 0)
        base = b
      } catch {
        return // degraded canvas: fall back to the static map already drawn
      }
      const dark = isDarkBackground(pal.background)
      const color =
        view.flowField === 'current'
          ? dark
            ? 'rgba(150,236,255,1)'
            : 'rgba(20,110,150,1)'
          : dark
            ? 'rgba(236,244,255,1)'
            : 'rgba(38,52,80,1)'
      const count = Math.min(2800, Math.max(600, Math.round((W * H) / 480)))
      try {
        animator = new FlowAnimator(world, view.flowField, count, color)
      } catch {
        animator = null
        return
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const tick = (t: number): void => {
        if (!base || !animator || !ctx) return
        const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016
        lastT = t
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.drawImage(base, 0, 0)
        ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0)
        animator.step(ctx, dt)
        raf = requestAnimationFrame(tick)
      }
      lastT = 0
      raf = requestAnimationFrame(tick)
    }

    const draw = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      renderBase()
      if (view.animateFlow) startAnimation()
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [world, view, selected, frame])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (!canvas || !world) return
    const rect = canvas.getBoundingClientRect()
    const wx = ((e.clientX - rect.left) / rect.width) * world.params.width
    const wy = ((e.clientY - rect.top) / rect.height) * world.params.height
    const r = nearestRegion(world, wx, wy)
    onPick(r === selected ? null : r)
  }

  return (
    <div className="map-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="map-canvas" onClick={handleClick} />
    </div>
  )
}
