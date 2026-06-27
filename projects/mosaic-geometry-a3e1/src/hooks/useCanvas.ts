import { useEffect, useRef, useState } from 'react'

export interface CanvasSize {
  width: number // CSS pixels
  height: number
  dpr: number
}

/**
 * Wires a <canvas> to its container: tracks the displayed size with a
 * ResizeObserver and keeps the backing store at device-pixel resolution so
 * everything stays crisp on HiDPI screens. Returns the canvas ref to attach and
 * the current logical size to draw against.
 */
export function useCanvas() {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0, dpr: 1 })

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const apply = () => {
      const rect = parent.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      const bw = Math.floor(width * dpr)
      const bh = Math.floor(height * dpr)
      // Assigning canvas.width/height clears the canvas even when the value is
      // unchanged — so only touch the backing store on a real size change.
      // (ResizeObserver fires an initial callback that would otherwise wipe the
      // first paint without triggering a redraw.)
      if (canvas.width !== bw) canvas.width = bw
      if (canvas.height !== bh) canvas.height = bh
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      setSize((s) => (s.width === width && s.height === height && s.dpr === dpr ? s : { width, height, dpr }))
    }

    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  return { ref, size }
}
