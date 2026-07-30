import type { ReactNode } from 'react';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3 className="panel-section__title">{title}</h3>
      <div className="panel-section__body">{children}</div>
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="slider">
      <span className="slider__label">
        <span>{label}</span>
        <span className="slider__value">{format ? format(value) : value}</span>
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
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          className={'segmented__btn' + (o.value === value ? ' is-active' : '')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
