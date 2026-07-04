// Responsive canvas that renders the current world. Sizes its backing store to the
// container width × device-pixel-ratio and maps world coordinates (0..width,
// 0..height) onto it, so the map is always crisp and fills the pane.

import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import type { WorldMap } from '../core/types'
import { renderWorld } from '../render/render'
import { paletteByKey } from '../render/palettes'
import type { ViewOptions } from './viewOptions'

interface Props {
  world: WorldMap | null
  view: ViewOptions
}

export default function MapCanvas({ world, view }: Props): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !world) return

    const draw = (): void => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const W = world.params.width
      const H = world.params.height
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cssW = Math.max(1, wrap.clientWidth)
      const cssH = cssW * (H / W)
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0)
      renderWorld(ctx, world, {
        palette: paletteByKey(view.paletteKey),
        showRivers: view.showRivers,
        showCoast: view.showCoast,
        showHillshade: view.showHillshade,
        showBorders: view.showBorders,
        showLabels: view.showLabels,
        showGrain: view.showGrain,
      })
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [world, view])

  return (
    <div className="map-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="map-canvas" />
    </div>
  )
}
