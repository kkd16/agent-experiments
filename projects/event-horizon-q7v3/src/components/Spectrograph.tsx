import { useEffect, useMemo, useRef } from 'react'
import type { Params } from '../types'
import { effectiveDiskInner } from '../state'
import { computeLineProfile } from '../physics/lineprofile'

interface Props {
  params: Params
}

/**
 * A live overlay plotting the disk's relativistic emission-line profile: flux vs the frequency
 * ratio g = ν_obs/ν_emit. The blue (right) horn is the approaching, blueshifted side; the long red
 * (left) tail is gravitational redshift from material deep in the well. Its shape tracks spin and
 * inclination exactly (light-bending aside) — this is how spin is measured from real spectra.
 */
export default function Spectrograph({ params }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const profile = useMemo(
    () => computeLineProfile(params.spin, params.inclination, effectiveDiskInner(params), params.diskOuter),
    // Only the physical inputs to the line profile matter; recomputing on every param tick is wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.spin, params.inclination, params.diskInner, params.diskOuter, params.iscoTrack],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = 210
    const h = 96
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const padL = 6
    const padR = 6
    const padT = 6
    const padB = 16
    const plotW = w - padL - padR
    const plotH = h - padT - padB
    const { flux, gMin, gMax } = profile
    const n = flux.length
    const xOf = (g: number) => padL + ((g - gMin) / (gMax - gMin)) * plotW
    const yOf = (f: number) => padT + (1 - f) * plotH

    // rest-energy reference line (g = 1)
    ctx.strokeStyle = 'rgba(150,170,220,0.35)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(xOf(1), padT)
    ctx.lineTo(xOf(1), padT + plotH)
    ctx.stroke()
    ctx.setLineDash([])

    // filled area under the curve, tinted red→white→blue by shift
    const grad = ctx.createLinearGradient(padL, 0, padL + plotW, 0)
    grad.addColorStop(0.0, 'rgba(255,80,60,0.85)')
    grad.addColorStop(0.5, 'rgba(255,240,220,0.9)')
    grad.addColorStop(1.0, 'rgba(120,180,255,0.9)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(xOf(gMin), yOf(0))
    for (let i = 0; i < n; i++) {
      const g = gMin + ((i + 0.5) / n) * (gMax - gMin)
      ctx.lineTo(xOf(g), yOf(flux[i]))
    }
    ctx.lineTo(xOf(gMax), yOf(0))
    ctx.closePath()
    ctx.fill()

    // crisp top stroke
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const g = gMin + ((i + 0.5) / n) * (gMax - gMin)
      const x = xOf(g)
      const y = yOf(flux[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // axis labels
    ctx.fillStyle = 'rgba(200,210,230,0.7)'
    ctx.font = '9px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.fillText('redshift', xOf(gMin) + 24, h - 4)
    ctx.fillText('1', xOf(1), h - 4)
    ctx.fillText('blueshift', xOf(gMax) - 26, h - 4)
  }, [profile])

  return (
    <div className="spectro">
      <div className="spectro__title">Disk line profile — g = ν₍obs₎/ν₍emit₎</div>
      <canvas ref={canvasRef} />
    </div>
  )
}
