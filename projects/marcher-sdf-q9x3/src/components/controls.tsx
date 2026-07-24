// Small reusable form controls shared by the inspector and global panel.

import type { ReactNode } from 'react'
import type { Vec3 } from '../scene/types'
import { hexToRgb, rgbToHex } from './color'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
}

export function Slider({ label, value, min, max, step, onChange, format }: SliderProps) {
  return (
    <label className="ctl">
      <span className="ctl-label">
        <span>{label}</span>
        <span className="ctl-value">{format ? format(value) : value.toFixed(2)}</span>
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

interface Vec3FieldProps {
  label: string
  value: Vec3
  min: number
  max: number
  step: number
  onChange: (v: Vec3) => void
}

const AXES: Array<{ i: 0 | 1 | 2; k: string }> = [
  { i: 0, k: 'X' },
  { i: 1, k: 'Y' },
  { i: 2, k: 'Z' },
]

export function Vec3Field({ label, value, min, max, step, onChange }: Vec3FieldProps) {
  return (
    <div className="ctl">
      <span className="ctl-label">
        <span>{label}</span>
      </span>
      <div className="vec3">
        {AXES.map(({ i, k }) => (
          <label key={k} className="vec3-axis">
            <span>{k}</span>
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={round(value[i])}
              onChange={(e) => {
                const next: Vec3 = [...value] as Vec3
                next[i] = parseFloat(e.target.value)
                if (Number.isNaN(next[i])) next[i] = 0
                onChange(next)
              }}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

interface ColorFieldProps {
  label: string
  value: Vec3
  onChange: (v: Vec3) => void
}

export function ColorField({ label, value, onChange }: ColorFieldProps) {
  return (
    <label className="ctl ctl-color">
      <span className="ctl-label">
        <span>{label}</span>
      </span>
      <input
        type="color"
        value={rgbToHex(value)}
        onChange={(e) => onChange(hexToRgb(e.target.value))}
      />
    </label>
  )
}

interface ToggleProps {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}

export function Toggle({ label, value, onChange }: ToggleProps) {
  return (
    <label className="ctl ctl-toggle">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className={`switch ${value ? 'on' : ''}`}
        onClick={() => onChange(!value)}
      >
        <span className="switch-knob" />
      </button>
    </label>
  )
}

interface SegmentedProps<T extends string> {
  label?: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}

export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="ctl">
      {label ? (
        <span className="ctl-label">
          <span>{label}</span>
        </span>
      ) : null}
      <div className="segmented">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={o.value === value ? 'active' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      <div className="panel-body">{children}</div>
    </section>
  )
}
