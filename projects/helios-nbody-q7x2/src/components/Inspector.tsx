// A small floating panel describing the currently selected body, including the
// full osculating Kepler orbit it rides relative to the chosen primary (the
// heaviest body, or the system barycentre). The orbital elements come straight
// from `sim/orbit.ts` — the same reconstruction the on-canvas ellipse is drawn
// from, so the panel and the overlay always agree.

import type { OrbitElements, OrbitShape } from '../sim/orbit'

export interface InspectInfo {
  index: number
  mass: number
  speed: number
  distCom: number
  /** Human label for the body the orbit is measured against. */
  primaryLabel: string
  /** Osculating orbit relative to the primary, or null (e.g. body *is* primary). */
  orbit: OrbitElements | null
  /** Jacobi constant in the two-heaviest-body co-rotating frame, or null. */
  jacobi: number | null
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '∞'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e5 || a < 1e-2)) return v.toExponential(2)
  return v.toFixed(digits)
}

const SHAPE_LABEL: Record<OrbitShape, string> = {
  circular: 'circular',
  elliptical: 'elliptical',
  parabolic: 'parabolic',
  hyperbolic: 'hyperbolic',
}

const DEG = 180 / Math.PI

export function Inspector({ info, onClose }: { info: InspectInfo; onClose: () => void }) {
  const o = info.orbit
  return (
    <div className="inspector">
      <div className="inspector-head">
        <span>Body #{info.index}</span>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Deselect">
          ×
        </button>
      </div>
      <div className="inspector-body">
        <Row label="Mass" value={fmt(info.mass, 2)} />
        <Row label="Speed" value={fmt(info.speed)} />
        <Row label="Dist. to COM" value={fmt(info.distCom, 1)} />
        <div className="inspector-divider">
          <span>orbit vs {info.primaryLabel}</span>
        </div>
        {o ? (
          <>
            <Row label="Separation r" value={fmt(o.r, 1)} />
            <Row
              label="Shape"
              value={SHAPE_LABEL[o.shape]}
              valueClass={o.bound ? 'good' : 'warn'}
            />
            <Row label="Eccentricity e" value={fmt(o.eccentricity, 4)} />
            {Number.isFinite(o.semiMajor) && <Row label="Semi-major a" value={fmt(o.semiMajor, 1)} />}
            <Row label="Periapsis" value={fmt(o.periapsis, 1)} />
            {o.apoapsis != null && <Row label="Apoapsis" value={fmt(o.apoapsis, 1)} />}
            {o.period != null && <Row label="Period T" value={fmt(o.period, 1)} />}
            <Row label="Arg. periapsis ϖ" value={`${(o.argPeriapsis * DEG).toFixed(1)}°`} />
            <Row label="True anomaly ν" value={`${(o.trueAnomaly * DEG).toFixed(1)}°`} />
            <Row label="Spec. energy ε" value={fmt(o.energy)} />
            <Row label="Spec. ang. mom. h" value={fmt(o.angularMomentum, 1)} />
            <Row
              label="Direction"
              value={o.prograde ? 'prograde ↺' : 'retrograde ↻'}
            />
            {info.jacobi != null && <Row label="Jacobi C (3-body)" value={fmt(info.jacobi, 2)} />}
          </>
        ) : (
          <p className="inspector-note">This is the primary — no orbit to report.</p>
        )}
      </div>
      <p className="inspector-foot">Click empty space or press Esc to deselect.</p>
    </div>
  )
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="inspector-row">
      <span className="inspector-label">{label}</span>
      <span className={`inspector-value ${valueClass ?? ''}`}>{value}</span>
    </div>
  )
}
