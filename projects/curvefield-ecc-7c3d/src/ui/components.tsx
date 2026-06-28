import type { ReactNode } from 'react'

export function PageHead({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children?: ReactNode
}) {
  return (
    <div className="page-head">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  )
}

export function Panel({
  title,
  sub,
  right,
  children,
}: {
  title?: ReactNode
  sub?: ReactNode
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="panel">
      {title && (
        <h2 style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>{title}</span>
          {right}
        </h2>
      )}
      {sub && <div className="sub">{sub}</div>}
      {children}
    </section>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        <span className="val">{display ?? value}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export function Verdict({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={`tag ${ok ? 'ok' : 'no'}`}>{children}</span>
}
