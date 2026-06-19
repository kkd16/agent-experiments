import { useState } from 'react'
import type { RenderSettings } from '../engine/renderer.ts'
import type { RenderMode } from '../render/types.ts'
import type { PostSettings, ToneMap } from '../render/post.ts'
import type { ShadingModel } from '../render/shading.ts'
import { PRESET_LABELS } from '../scene/scene.ts'

const MODES: { key: RenderMode; label: string; blurb: string }[] = [
  { key: 'shaded', label: 'Shaded', blurb: 'Full HDR beauty pass — lighting, IBL, normal maps, tone mapping & post FX.' },
  { key: 'albedo', label: 'Albedo', blurb: 'Unlit base/texture colour — what shading starts from.' },
  { key: 'wireframe', label: 'Wireframe', blurb: 'Triangle edges only, drawn with Bresenham lines.' },
  { key: 'depth', label: 'Depth', blurb: 'Linearised z-buffer value as greyscale (near = white).' },
  { key: 'normals', label: 'Normals', blurb: 'Shading normals (incl. normal maps) mapped to RGB.' },
  { key: 'uv', label: 'UV', blurb: 'Perspective-correct texture coordinates as colour.' },
  { key: 'overdraw', label: 'Overdraw', blurb: 'Heatmap of how many triangles touched each pixel.' },
  { key: 'clip', label: 'Clip', blurb: 'Red = triangles cut by the near-plane clipper.' },
]

const TONE_MAPS: { key: ToneMap; label: string }[] = [
  { key: 'aces', label: 'ACES' },
  { key: 'reinhard', label: 'Reinhard' },
  { key: 'filmic', label: 'Filmic' },
  { key: 'none', label: 'Clamp' },
]

interface Props {
  settings: RenderSettings
  setSettings: (s: RenderSettings) => void
  preset: string
  setPreset: (p: string) => void
  resolutionScale: number
  setResolutionScale: (n: number) => void
  onResetCamera: () => void
  onScreenshot: () => void
  onLoadOBJ: (text: string) => void
  sampleOBJ: string
  objError: string | null
  objInfo: string | null
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
  const setPost = (patch: Partial<PostSettings>): void => set({ post: { ...settings.post, ...patch } })
  const activeMode = MODES.find((m) => m.key === settings.mode) ?? MODES[0]
  const post = settings.post
  const [objText, setObjText] = useState('')

  const models: { key: ShadingModel; label: string }[] = [
    { key: 'pbr', label: 'PBR (Cook–Torrance)' },
    { key: 'phong', label: 'Blinn–Phong' },
  ]

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
        <div className="seg seg-wrap">
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

      <Section title="Lighting model">
        <div className="seg">
          {models.map((m) => (
            <button
              key={m.key}
              className={settings.shadingModel === m.key ? 'active' : ''}
              onClick={() => set({ shadingModel: m.key })}
              type="button"
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="toggles">
          <Toggle label="Environment / IBL" value={settings.environment} onChange={(v) => set({ environment: v })} />
          <Toggle label="Normal maps" value={settings.normalMaps} onChange={(v) => set({ normalMaps: v })} />
        </div>
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

      <Section title="Post FX (HDR · shaded view)">
        <div className="seg seg-wrap">
          {TONE_MAPS.map((t) => (
            <button
              key={t.key}
              className={post.toneMap === t.key ? 'active' : ''}
              onClick={() => setPost({ toneMap: t.key })}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>
        <Slider
          label="Exposure" value={post.exposure} min={0.2} max={3} step={0.1}
          onChange={(v) => setPost({ exposure: v })} format={(v) => `${v.toFixed(1)}×`}
        />
        <div className="toggles">
          <Toggle label="Bloom" value={post.bloom} onChange={(v) => setPost({ bloom: v })} />
          <Toggle label="FXAA" value={post.fxaa} onChange={(v) => setPost({ fxaa: v })} />
          <Toggle label="Vignette" value={post.vignette} onChange={(v) => setPost({ vignette: v })} />
        </div>
        {post.bloom && (
          <Slider
            label="Bloom amount" value={post.bloomIntensity} min={0} max={1.5} step={0.05}
            onChange={(v) => setPost({ bloomIntensity: v })} format={(v) => v.toFixed(2)}
          />
        )}
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

      <Section title="Import OBJ">
        <textarea
          className="obj-input"
          placeholder="Paste Wavefront OBJ here…"
          value={objText}
          onChange={(e) => setObjText(e.target.value)}
          spellCheck={false}
        />
        <div className="seg">
          <button onClick={() => props.onLoadOBJ(objText)} type="button" disabled={!objText.trim()}>
            Load mesh
          </button>
          <button onClick={() => { setObjText(props.sampleOBJ); props.onLoadOBJ(props.sampleOBJ) }} type="button">
            Sample
          </button>
        </div>
        {props.objError && <p className="obj-msg err">{props.objError}</p>}
        {props.objInfo && !props.objError && <p className="obj-msg ok">{props.objInfo}</p>}
      </Section>

      <div className="actions">
        <button className="reset" onClick={props.onResetCamera} type="button">Reset camera</button>
        <button className="reset" onClick={props.onScreenshot} type="button">Save PNG</button>
      </div>

      <footer className="panel-foot">
        Drag to orbit · scroll to zoom. Everything here — transform, clip, raster, shade,
        tone-map — is plain TypeScript writing pixels into a buffer. No WebGL.
      </footer>
    </aside>
  )
}
