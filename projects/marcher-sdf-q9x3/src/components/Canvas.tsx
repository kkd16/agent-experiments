// The viewport: the WebGL canvas plus pointer-driven orbit / pan / zoom, and the
// FPS + error overlays. Camera changes are dispatched into the scene reducer.

import { useEffect, useRef } from 'react'
import type { Dispatch, PointerEvent as ReactPointerEvent, RefObject, WheelEvent as ReactWheelEvent } from 'react'
import type { Camera } from '../scene/types'
import type { Action } from '../state/reducer'
import type { SppState } from '../hooks/useRenderer'
import { clamp } from '../gl/math'

interface CanvasProps {
  canvasRef: RefObject<HTMLCanvasElement | null>
  camera: Camera
  fps: number
  error: string | null
  spp: SppState
  dispatch: Dispatch<Action>
}

const DEG = Math.PI / 180

export default function Canvas({ canvasRef, camera, fps, error, spp, dispatch }: CanvasProps) {
  const drag = useRef<{ x: number; y: number; mode: 'orbit' | 'pan' } | null>(null)
  const cam = useRef(camera)
  useEffect(() => {
    cam.current = camera
  }, [camera])

  const onPointerDown = (e: ReactPointerEvent) => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const pan = e.shiftKey || e.button === 1 || e.button === 2
    drag.current = { x: e.clientX, y: e.clientY, mode: pan ? 'pan' : 'orbit' }
    if (!pan && cam.current.autoRotate) dispatch({ type: 'patchCamera', patch: { autoRotate: false } })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    const c = cam.current
    if (d.mode === 'orbit') {
      dispatch({
        type: 'patchCamera',
        patch: {
          azimuth: c.azimuth - dx * 0.35,
          elevation: clamp(c.elevation + dy * 0.35, -85, 85),
        },
      })
    } else {
      const az = c.azimuth * DEG
      const rx = Math.cos(az)
      const rz = -Math.sin(az)
      const k = c.distance * 0.0016
      dispatch({
        type: 'patchCamera',
        patch: {
          target: [
            c.target[0] - rx * dx * k,
            c.target[1] + dy * k,
            c.target[2] - rz * dx * k,
          ],
        },
      })
    }
  }

  const endDrag = (e: ReactPointerEvent) => {
    if ((e.target as Element).hasPointerCapture?.(e.pointerId)) {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    }
    drag.current = null
  }

  const onWheel = (e: ReactWheelEvent) => {
    const c = cam.current
    dispatch({
      type: 'patchCamera',
      patch: { distance: clamp(c.distance * Math.exp(e.deltaY * 0.0012), 1.2, 45) },
    })
  }

  return (
    <div className="viewport">
      <canvas
        ref={canvasRef}
        className="gl-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="hud">
        <span className={`fps ${fps < 30 ? 'low' : ''}`}>{Math.round(fps)} fps</span>
        {spp.accumulating ? (
          <span className={`spp ${spp.sample >= spp.max ? 'done' : ''}`}>
            {spp.sample >= spp.max ? `converged · ${spp.max} spp` : `refining · ${spp.sample}/${spp.max} spp`}
          </span>
        ) : null}
        <span className="hud-hint">drag orbit · shift-drag pan · scroll zoom</span>
      </div>
      {spp.accumulating && spp.max > 0 ? (
        <div className="spp-bar" aria-hidden>
          <div
            className={`spp-fill ${spp.sample >= spp.max ? 'done' : ''}`}
            style={{ width: `${Math.min(100, (spp.sample / Math.max(spp.max, 1)) * 100)}%` }}
          />
        </div>
      ) : null}
      {error ? (
        <div className="gl-error">
          <strong>Shader error</strong>
          <pre>{error}</pre>
        </div>
      ) : null}
    </div>
  )
}
