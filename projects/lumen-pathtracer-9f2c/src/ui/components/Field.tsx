// Field.tsx — reusable labelled controls used throughout the control panel.

import type { ReactNode } from 'react'

export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  hint?: string
}) {
  const { label, value, min, max, step, onChange, format, hint } = props
  return (
    <label className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        <span className="field-value">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  const { label, value, options, onChange } = props
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
      </div>
      <div className="segmented">
        {options.map((o) => (
          <button
            key={o.value}
            className={o.value === value ? 'seg active' : 'seg'}
            onClick={() => onChange(o.value)}
            type="button"
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="field toggle">
      <div className="field-head">
        <span className="field-label">{props.label}</span>
        <button
          type="button"
          className={props.value ? 'switch on' : 'switch'}
          onClick={() => props.onChange(!props.value)}
          aria-pressed={props.value}
        >
          <span className="knob" />
        </button>
      </div>
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  )
}

export function TextArea(props: {
  label: string
  value: string
  placeholder?: string
  rows?: number
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <label className="field">
      <div className="field-head">
        <span className="field-label">{props.label}</span>
      </div>
      <textarea
        className="textarea"
        rows={props.rows ?? 6}
        spellCheck={false}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  )
}

export function Panel(props: { title: string; children: ReactNode; subtitle?: string }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>{props.title}</h3>
        {props.subtitle && <p>{props.subtitle}</p>}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}
