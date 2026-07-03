import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface CanvasSize {
  width: number // CSS pixels
  height: number // CSS pixels
  dpr: number
}

// Keep a canvas's backing store sized to its CSS box times devicePixelRatio, so
// drawing stays crisp on HiDPI displays. Returns the canvas ref and the current
// logical (CSS-pixel) size. Callers should scale their context by `dpr` before
// drawing, then use CSS-pixel coordinates.

export function useDprCanvas(): {
  ref: RefObject<HTMLCanvasElement | null>
  size: CanvasSize
} {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState<CanvasSize>({ width: 300, height: 150, dpr: 1 })

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const apply = () => {
      const rect = parent.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      setSize((prev) =>
        prev.width === width && prev.height === height && prev.dpr === dpr
          ? prev
          : { width, height, dpr },
      )
    }

    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(parent)
    window.addEventListener('resize', apply)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [])

  return { ref, size }
}

/** Get a 2D context already scaled for the given size (CSS-pixel coordinates). */
export function prepareContext(
  canvas: HTMLCanvasElement | null,
  size: CanvasSize,
): CanvasRenderingContext2D | null {
  if (!canvas) return null
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)
  return ctx
}
