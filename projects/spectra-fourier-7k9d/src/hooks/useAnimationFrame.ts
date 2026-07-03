import { useEffect, useLayoutEffect, useRef } from 'react'

// Run a callback on every animation frame while `active`. The callback receives
// the delta time (seconds) and the absolute timestamp (seconds). The latest
// callback is always used without restarting the loop, so passing an inline
// closure each render is fine.

export function useAnimationFrame(
  callback: (dt: number, t: number) => void,
  active = true,
): void {
  const cbRef = useRef(callback)
  // Keep the ref pointing at the latest callback without restarting the loop.
  useLayoutEffect(() => {
    cbRef.current = callback
  })

  useEffect(() => {
    if (!active) return
    let raf = 0
    let last: number | null = null
    const loop = (now: number) => {
      const tSec = now / 1000
      const dt = last === null ? 0 : tSec - last
      last = tSec
      cbRef.current(dt, tSec)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active])
}
