// Small, dependency-free control primitives shared across the panels.

import type { ReactNode } from 'react'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  title?: string
}

export function Slider({ label, value, min, max, step, onChange, format, title }: SliderProps) {
  return (
    <label className="ctl ctl-slider" title={title}>
      <span className="ctl-row">
        <span className="ctl-label">{label}</span>
        <span className="ctl-value">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

interface ToggleProps {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  title?: string
}

export function Toggle({ label, checked, onChange, title }: ToggleProps) {
  return (
    <label className="ctl ctl-toggle" title={title}>
      <span className="ctl-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </label>
  )
}

interface SegmentedProps<T extends string> {
  label?: string
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (v: T) => void
}

export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="ctl ctl-segmented">
      {label && <span className="ctl-label">{label}</span>}
      <div className="segmented" role="group">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.title}
            className={`seg ${value === o.value ? 'active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

interface SelectProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}

export function Select<T extends string>({ label, value, options, onChange }: SelectProps<T>) {
  return (
    <label className="ctl ctl-select">
      <span className="ctl-label">{label}</span>
      <div className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </label>
  )
}

export function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="section" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="section-body">{children}</div>
    </details>
  )
}
