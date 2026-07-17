import type { HudInfo } from '../fractal/types'

function formatMag(m: number): string {
  if (m < 1000) return `${m.toFixed(1)}×`
  const exp = Math.floor(Math.log10(m))
  const mant = m / Math.pow(10, exp)
  return `${mant.toFixed(2)}e${exp}×`
}

// The centre coordinates can run to dozens of digits at deep zoom; wrap them so
// the HUD stays readable instead of overflowing.
function CoordRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud-row hud-coord">
      <span className="hud-key">{label}</span>
      <span className="hud-val hud-coord-val">{value}</span>
    </div>
  )
}

export default function Hud({ hud }: { hud: HudInfo }) {
  const deep = hud.engine === 'perturb'
  return (
    <div className="hud">
      <CoordRow label="re" value={hud.re} />
      <CoordRow label="im" value={hud.im} />
      <div className="hud-row">
        <span className="hud-key">zoom</span>
        <span className="hud-val">{formatMag(hud.magnification)}</span>
      </div>
      <div className="hud-row">
        <span className="hud-key">iter</span>
        <span className="hud-val">{hud.maxIter}</span>
      </div>
      <div className="hud-row">
        <span className="hud-key">engine</span>
        <span className={deep ? 'hud-val hud-engine deep' : 'hud-val hud-engine'}>
          {deep ? 'perturbation' : 'df64'}
        </span>
      </div>
      <div className="hud-row">
        <span className="hud-key">fps</span>
        <span className="hud-val">{hud.fps.toFixed(0)}</span>
      </div>
    </div>
  )
}
