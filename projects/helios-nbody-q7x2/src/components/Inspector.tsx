// A small floating panel describing the currently selected body. The orbital
// quantities (specific energy, semi-major axis) are taken relative to the most
// massive body in the system — the natural primary for the planet/ring/Trojan
// scenarios where inspection is most useful.

export interface InspectInfo {
  index: number
  mass: number
  speed: number
  distCom: number
  /** Distance to the heaviest body, or null when the selected body *is* it. */
  distCentral: number | null
  /** Two-body specific orbital energy relative to the primary, or null. */
  specificEnergy: number | null
  /** Semi-major axis when bound, else null. */
  semiMajor: number | null
  /** Orbital period (Kepler) when bound, else null. */
  period: number | null
  bound: boolean | null
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e5 || a < 1e-2)) return v.toExponential(2)
  return v.toFixed(digits)
}

export function Inspector({ info, onClose }: { info: InspectInfo; onClose: () => void }) {
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
        {info.distCentral != null && <Row label="Dist. to primary" value={fmt(info.distCentral, 1)} />}
        {info.specificEnergy != null && <Row label="Spec. energy ε" value={fmt(info.specificEnergy)} />}
        {info.semiMajor != null && <Row label="Semi-major a" value={fmt(info.semiMajor, 1)} />}
        {info.period != null && <Row label="Period T" value={fmt(info.period, 1)} />}
        {info.bound != null && (
          <Row
            label="Orbit"
            value={info.bound ? 'bound' : 'unbound'}
            valueClass={info.bound ? 'good' : 'warn'}
          />
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
