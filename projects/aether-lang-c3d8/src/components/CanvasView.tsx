import { useEffect, useRef } from 'react'
import type { TurtleCmd } from '../lang/values.ts'
import { interpretTurtle } from '../lang/turtle.ts'

interface Props {
  effects: TurtleCmd[]
  animate: boolean
}

export default function CanvasView({ effects, animate }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { segments, bounds } = interpretTurtle(effects)
    const parent = canvas.parentElement
    const cssW = parent ? parent.clientWidth : 600
    const cssH = parent ? parent.clientHeight : 420
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(cssW * dpr))
    canvas.height = Math.max(1, Math.floor(cssH * dpr))
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`

    const pad = 24
    const drawW = bounds.maxX - bounds.minX || 1
    const drawH = bounds.maxY - bounds.minY || 1
    const scale = Math.min((cssW - pad * 2) / drawW, (cssH - pad * 2) / drawH)
    const offX = (cssW - drawW * scale) / 2 - bounds.minX * scale
    const offY = (cssH - drawH * scale) / 2 - bounds.minY * scale

    const tx = (x: number): number => (offX + x * scale) * dpr
    const ty = (y: number): number => (offY + y * scale) * dpr

    const paint = (count: number): void => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (let i = 0; i < count && i < segments.length; i++) {
        const s = segments[i]
        ctx.strokeStyle = s.color
        ctx.lineWidth = Math.max(0.5, s.width * scale * 0.5) * dpr
        ctx.beginPath()
        ctx.moveTo(tx(s.x1), ty(s.y1))
        ctx.lineTo(tx(s.x2), ty(s.y2))
        ctx.stroke()
      }
    }

    cancelAnimationFrame(rafRef.current)
    if (!animate || segments.length === 0) {
      paint(segments.length)
      return
    }

    const start = performance.now()
    const duration = Math.min(1400, 300 + segments.length * 2)
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      paint(Math.floor(eased * segments.length))
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [effects, animate])

  return (
    <div className="canvas-wrap">
      {effects.length === 0 ? (
        <div className="panel-empty">
          This program drew nothing. Try a visual example (forward / turn / color…) or the fractal
          tree.
        </div>
      ) : (
        <canvas ref={canvasRef} className="turtle-canvas" />
      )}
    </div>
  )
}
