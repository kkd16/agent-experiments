import type { Params, Preset } from '../types'
import { CONTROL_GROUPS } from '../ui/controls-config'

interface Props {
  params: Params
  onChange: (patch: Partial<Params>) => void
  presets: Preset[]
  onPreset: (p: Preset) => void
  onReset: () => void
}

export default function Controls({ params, onChange, presets, onPreset, onReset }: Props) {
  return (
    <div className="controls">
      <section className="panel">
        <div className="panel__head">
          <h2>Presets</h2>
          <button className="ghost" onClick={onReset}>
            Reset
          </button>
        </div>
        <div className="presets">
          {presets.map((p) => (
            <button key={p.name} className="preset" onClick={() => onPreset(p)} title={p.blurb}>
              {p.name}
            </button>
          ))}
        </div>
      </section>

      {CONTROL_GROUPS.map((group) => (
        <section className="panel" key={group.title}>
          <h2>{group.title}</h2>
          {group.sliders.map((s) => {
            const value = params[s.key]
            return (
              <label className="row" key={s.key} title={s.help}>
                <span className="row__label">{s.label}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={value}
                  onChange={(e) => onChange({ [s.key]: Number(e.target.value) } as Partial<Params>)}
                />
                <span className="row__value">{s.format ? s.format(value) : value.toFixed(2)}</span>
              </label>
            )
          })}
          {group.toggles?.map((t) => (
            <label className="toggle" key={t.key} title={t.help}>
              <input
                type="checkbox"
                checked={params[t.key]}
                onChange={(e) => onChange({ [t.key]: e.target.checked } as Partial<Params>)}
              />
              <span>{t.label}</span>
            </label>
          ))}
        </section>
      ))}
    </div>
  )
}
