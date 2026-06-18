interface Option<T extends string> {
  value: T
  label: string
}

interface SegmentedProps<T extends string> {
  value: T
  options: Option<T>[]
  onChange: (v: T) => void
  wrap?: boolean
}

// A compact button-group control used for color mode, blend mode, etc.
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  wrap,
}: SegmentedProps<T>) {
  return (
    <div className={wrap ? 'segmented wrap' : 'segmented'} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
