import type { ReactNode } from 'react'

// Small, consistent control primitives used across all modes.

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel-title">{title}</h2>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Field({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-head">
        <span className="field-label">{label}</span>
        {value !== undefined && <span className="field-value">{value}</span>}
      </span>
      {children}
    </label>
  )
}

export function Slider({
  min,
  max,
  step,
  value,
  onChange,
}: {
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
}) {
  return (
    <input
      className="slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={o.id === value}
          className={o.id === value ? 'seg active' : 'seg'}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </label>
  )
}

export function Button({
  children,
  onClick,
  variant = 'default',
}: {
  children: ReactNode
  onClick: () => void
  variant?: 'default' | 'primary' | 'ghost'
}) {
  return (
    <button className={`btn btn-${variant}`} onClick={onClick} type="button">
      {children}
    </button>
  )
}

export function Readout({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="readout">
      {items.map((it) => (
        <div className="readout-item" key={it.label}>
          <span className="readout-value">{it.value}</span>
          <span className="readout-label">{it.label}</span>
        </div>
      ))}
    </div>
  )
}
