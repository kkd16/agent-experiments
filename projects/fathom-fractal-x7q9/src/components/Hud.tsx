import type { HudInfo } from '../fractal/types'

function formatMag(m: number): string {
  if (m < 1000) return `${m.toFixed(1)}×`
  const exp = Math.floor(Math.log10(m))
  const mant = m / Math.pow(10, exp)
  return `${mant.toFixed(2)}e${exp}×`
}

function formatCoord(x: number, span: number): string {
  const digits = Math.min(17, Math.max(4, Math.round(-Math.log10(span)) + 4))
  const s = x.toFixed(digits)
  return x >= 0 ? `+${s}` : s
}

export default function Hud({ hud }: { hud: HudInfo }) {
  return (
    <div className="hud">
      <div className="hud-row">
        <span className="hud-key">re</span>
        <span className="hud-val">{formatCoord(hud.re, hud.span)}</span>
      </div>
      <div className="hud-row">
        <span className="hud-key">im</span>
        <span className="hud-val">{formatCoord(hud.im, hud.span)}</span>
      </div>
      <div className="hud-row">
        <span className="hud-key">zoom</span>
        <span className="hud-val">{formatMag(hud.magnification)}</span>
      </div>
      <div className="hud-row">
        <span className="hud-key">iter</span>
        <span className="hud-val">{hud.maxIter}</span>
      </div>
      <div className="hud-row">
        <span className="hud-key">fps</span>
        <span className="hud-val">{hud.fps.toFixed(0)}</span>
      </div>
    </div>
  )
}
