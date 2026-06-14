interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  fmt?: (v: number) => string
}

export function Slider({ label, value, min, max, step, onChange, fmt }: SliderProps) {
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <span className="slider-value">{(fmt ?? ((v) => v.toFixed(2)))(value)}</span>
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
