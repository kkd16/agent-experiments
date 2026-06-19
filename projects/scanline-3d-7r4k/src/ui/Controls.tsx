import type { RenderSettings } from '../engine/renderer.ts'
import type { RenderMode } from '../render/types.ts'
import { PRESET_LABELS } from '../scene/scene.ts'

const MODES: { key: RenderMode; label: string; blurb: string }[] = [
  { key: 'shaded', label: 'Shaded', blurb: 'Full Blinn–Phong with textures, lights, ambient & fog.' },
  { key: 'albedo', label: 'Albedo', blurb: 'Unlit base/texture colour — what shading starts from.' },
  { key: 'wireframe', label: 'Wireframe', blurb: 'Triangle edges only, drawn with Bresenham lines.' },
  { key: 'depth', label: 'Depth', blurb: 'Linearised z-buffer value as greyscale (near = white).' },
  { key: 'normals', label: 'Normals', blurb: 'World-space surface normals mapped to RGB.' },
  { key: 'uv', label: 'UV', blurb: 'Perspective-correct texture coordinates as colour.' },
  { key: 'overdraw', label: 'Overdraw', blurb: 'Heatmap of how many triangles touched each pixel.' },
  { key: 'clip', label: 'Clip', blurb: 'Red = triangles cut by the near-plane clipper.' },
]

interface Props {
  settings: RenderSettings
  setSettings: (s: RenderSettings) => void
  preset: string
  setPreset: (p: string) => void
  resolutionScale: number
  setResolutionScale: (n: number) => void
  onResetCamera: () => void
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)} type="button">
      <span className="toggle-knob" />
      <span>{label}</span>
    </button>
  )
}

function Slider({
  label, value, min, max, step, onChange, format,
}: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void; format: (v: number) => string
}) {
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}</span>
        <span className="slider-val">{format(value)}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

export default function Controls(props: Props) {
  const { settings, setSettings, preset, setPreset, resolutionScale, setResolutionScale } = props
  const set = (patch: Partial<RenderSettings>): void => setSettings({ ...settings, ...patch })
  const activeMode = MODES.find((m) => m.key === settings.mode) ?? MODES[0]

  return (
    <aside className="panel">
      <header className="brand">
        <div className="brand-mark">▲</div>
        <div>
          <h1>Scanline</h1>
          <p>software 3D renderer</p>
        </div>
      </header>

      <Section title="Scene">
        <div className="seg">
          {PRESET_LABELS.map((p) => (
            <button
              key={p.key}
              className={preset === p.key ? 'active' : ''}
              onClick={() => setPreset(p.key)}
              type="button"
            >
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Render mode">
        <div className="mode-grid">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={settings.mode === m.key ? 'mode active' : 'mode'}
              onClick={() => set({ mode: m.key })}
              type="button"
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="blurb">{activeMode.blurb}</p>
      </Section>

      <Section title="Pipeline">
        <div className="toggles">
          <Toggle label="Auto-rotate" value={settings.autoRotate} onChange={(v) => set({ autoRotate: v })} />
          <Toggle label="Shadow map" value={settings.shadows} onChange={(v) => set({ shadows: v })} />
          <Toggle label="Backface cull" value={settings.cullBack} onChange={(v) => set({ cullBack: v })} />
          <Toggle label="Distance fog" value={settings.fog} onChange={(v) => set({ fog: v })} />
          <Toggle label="Ground plane" value={settings.showGround} onChange={(v) => set({ showGround: v })} />
        </div>
      </Section>

      <Section title="Quality & lighting">
        <Slider
          label="Resolution" value={resolutionScale} min={0.4} max={2} step={0.1}
          onChange={setResolutionScale} format={(v) => `${v.toFixed(1)}×`}
        />
        <Slider
          label="Ambient" value={settings.ambientBoost} min={0.2} max={2.5} step={0.1}
          onChange={(v) => set({ ambientBoost: v })} format={(v) => `${v.toFixed(1)}×`}
        />
        <Slider
          label="Light power" value={settings.lightBoost} min={0.2} max={2.5} step={0.1}
          onChange={(v) => set({ lightBoost: v })} format={(v) => `${v.toFixed(1)}×`}
        />
      </Section>

      <button className="reset" onClick={props.onResetCamera} type="button">Reset camera</button>

      <footer className="panel-foot">
        Drag to orbit · scroll to zoom. Everything here — transform, clip, raster, shade — is
        plain TypeScript writing pixels into a buffer. No WebGL.
      </footer>
    </aside>
  )
}
