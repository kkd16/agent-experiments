import { useState } from 'react'
import type { Engine, RenderSettings, RTSettings } from '../engine/renderer.ts'
import type { RTMode } from '../raytrace/raytracer.ts'
import type { RenderMode } from '../render/types.ts'
import type { PostSettings, ToneMap } from '../render/post.ts'
import type { SSFXSettings } from '../render/ssfx.ts'
import type { ShadingModel } from '../render/shading.ts'
import { PRESET_LABELS } from '../scene/scene.ts'
import { runRTSelfTest } from '../raytrace/verify.ts'
import type { RTTest } from '../raytrace/verify.ts'
import { runSSFXSelfTest } from '../render/ssfx_verify.ts'
import type { SSFXTest } from '../render/ssfx_verify.ts'
import { SDF_PRESETS } from '../sdf/scenes.ts'
import { runSdfSelfTest } from '../sdf/verify.ts'
import type { SdfTest } from '../sdf/verify.ts'
import type { SdfInfo } from '../sdf/marchingcubes.ts'

const MODES: { key: RenderMode; label: string; blurb: string }[] = [
  { key: 'shaded', label: 'Shaded', blurb: 'Full HDR beauty pass — lighting, IBL, normal maps, tone mapping & post FX.' },
  { key: 'albedo', label: 'Albedo', blurb: 'Unlit base/texture colour — what shading starts from.' },
  { key: 'wireframe', label: 'Wireframe', blurb: 'Triangle edges only, drawn with Bresenham lines.' },
  { key: 'depth', label: 'Depth', blurb: 'Linearised z-buffer value as greyscale (near = white).' },
  { key: 'normals', label: 'Normals', blurb: 'Shading normals (incl. normal maps) mapped to RGB.' },
  { key: 'uv', label: 'UV', blurb: 'Perspective-correct texture coordinates as colour.' },
  { key: 'overdraw', label: 'Overdraw', blurb: 'Heatmap of how many triangles touched each pixel.' },
  { key: 'clip', label: 'Clip', blurb: 'Red = triangles cut by the near-plane clipper.' },
  { key: 'position', label: 'Position', blurb: 'Deferred G-buffer: world position wrapped into colour.' },
  { key: 'roughness', label: 'Roughness', blurb: 'Deferred G-buffer: per-pixel material roughness (black = mirror).' },
  { key: 'ao', label: 'Ambient occ.', blurb: 'Screen-space ambient occlusion buffer — the raster twin of the path tracer’s AO render.' },
  { key: 'reflections', label: 'Reflections', blurb: 'Screen-space reflections: the on-screen colour each pixel reflects (black where the ray missed).' },
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
  sdfPreset: string
  setSdfPreset: (k: string) => void
  sdfRes: number
  setSdfRes: (n: number) => void
  sdfSmooth: number
  setSdfSmooth: (n: number) => void
  sdfIso: number
  setSdfIso: (n: number) => void
  sdfInfo: SdfInfo | null
  onViewImplicit: () => void
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
  const setRT = (patch: Partial<RTSettings>): void => set({ rt: { ...settings.rt, ...patch } })
  const setSSFX = (patch: Partial<SSFXSettings>): void => set({ ssfx: { ...settings.ssfx, ...patch } })
  const activeMode = MODES.find((m) => m.key === settings.mode) ?? MODES[0]
  const post = settings.post
  const rt = settings.rt
  const ssfx = settings.ssfx
  const isRT = settings.engine === 'rt'
  const [objText, setObjText] = useState('')
  const [tests, setTests] = useState<RTTest[] | null>(null)
  const [testing, setTesting] = useState(false)
  const runTests = (): void => {
    setTesting(true)
    setTests(null)
    // defer so the "running…" state paints before the synchronous test blocks
    setTimeout(() => {
      setTests(runRTSelfTest())
      setTesting(false)
    }, 30)
  }
  const [ssfxTests, setSsfxTests] = useState<SSFXTest[] | null>(null)
  const [ssfxTesting, setSsfxTesting] = useState(false)
  const runSSFX = (): void => {
    setSsfxTesting(true)
    setSsfxTests(null)
    setTimeout(() => {
      setSsfxTests(runSSFXSelfTest())
      setSsfxTesting(false)
    }, 30)
  }
  const [sdfTests, setSdfTests] = useState<SdfTest[] | null>(null)
  const [sdfTesting, setSdfTesting] = useState(false)
  const runSdf = (): void => {
    setSdfTesting(true)
    setSdfTests(null)
    setTimeout(() => {
      setSdfTests(runSdfSelfTest())
      setSdfTesting(false)
    }, 30)
  }
  const activeSdf = SDF_PRESETS.find((p) => p.key === props.sdfPreset) ?? SDF_PRESETS[0]

  const models: { key: ShadingModel; label: string }[] = [
    { key: 'pbr', label: 'PBR (Cook–Torrance)' },
    { key: 'phong', label: 'Blinn–Phong' },
  ]
  const engines: { key: Engine; label: string }[] = [
    { key: 'raster', label: 'Rasterizer' },
    { key: 'rt', label: 'Ray tracer' },
  ]
  const rtModes: { key: RTMode; label: string }[] = [
    { key: 'path', label: 'Path tracer' },
    { key: 'ao', label: 'Ambient occlusion' },
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

      <Section title="Engine">
        <div className="seg">
          {engines.map((e) => (
            <button
              key={e.key}
              className={settings.engine === e.key ? 'active' : ''}
              onClick={() => set({ engine: e.key })}
              type="button"
            >
              {e.label}
            </button>
          ))}
        </div>
        <p className="blurb">
          {isRT
            ? 'A from-scratch BVH path tracer renders the same scene as a physically-correct reference — progressive, so it refines while the camera is still.'
            : 'The real-time software rasterizer: transform → clip → scan-convert → shade, ~60 fps.'}
        </p>
      </Section>

      <Section title={isRT ? 'Raster view (left of split)' : 'Render mode'}>
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

      {isRT && (
        <Section title="Path tracer">
          <div className="seg">
            {rtModes.map((m) => (
              <button
                key={m.key}
                className={rt.mode === m.key ? 'active' : ''}
                onClick={() => setRT({ mode: m.key })}
                type="button"
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="toggles">
            <Toggle label="Split-screen compare" value={rt.compare} onChange={(v) => setRT({ compare: v })} />
            <Toggle label="Soft shadows" value={rt.softShadows} onChange={(v) => setRT({ softShadows: v })} />
          </div>
          {rt.compare && (
            <Slider
              label="Split position" value={rt.splitPos} min={0.1} max={0.9} step={0.01}
              onChange={(v) => setRT({ splitPos: v })} format={(v) => `${(v * 100).toFixed(0)}%`}
            />
          )}
          {rt.mode === 'path' && (
            <Slider
              label="Max bounces" value={rt.maxBounces} min={1} max={8} step={1}
              onChange={(v) => setRT({ maxBounces: v })} format={(v) => v.toFixed(0)}
            />
          )}
          {rt.mode === 'ao' && (
            <Slider
              label="AO radius" value={rt.aoRadius} min={0.2} max={4} step={0.1}
              onChange={(v) => setRT({ aoRadius: v })} format={(v) => v.toFixed(1)}
            />
          )}
          {rt.softShadows && (
            <>
              <Slider
                label="Sun softness" value={rt.sunSoftness} min={0} max={8} step={0.5}
                onChange={(v) => setRT({ sunSoftness: v })} format={(v) => `${v.toFixed(1)}°`}
              />
              <Slider
                label="Point-light radius" value={rt.lightRadius} min={0} max={1} step={0.05}
                onChange={(v) => setRT({ lightRadius: v })} format={(v) => v.toFixed(2)}
              />
            </>
          )}
          <Slider
            label="RT resolution" value={rt.resolutionScale} min={0.25} max={1} step={0.05}
            onChange={(v) => setRT({ resolutionScale: v })} format={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <p className="blurb">
            BVH-accelerated Möller–Trumbore tracing, next-event estimation to every light, and the
            analytic sky as an infinite emitter — drag to orbit and it re-converges.
          </p>
        </Section>
      )}

      {isRT && (
        <Section title="Verification">
          <button className="reset" onClick={runTests} type="button" disabled={testing} style={{ width: '100%' }}>
            {testing ? 'Running…' : 'Run RT self-test'}
          </button>
          {tests && (
            <div className="rt-tests">
              <p className="blurb">
                {tests.filter((t) => t.pass).length}/{tests.length} checks passed — each re-derives a claim
                from an independent reference.
              </p>
              {tests.map((t) => (
                <p key={t.name} className={`obj-msg ${t.pass ? 'ok' : 'err'}`}>
                  {t.pass ? '✓' : '✗'} {t.name} — {t.detail}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

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

      {!isRT && (
        <Section title="Screen-space FX (deferred)">
          <div className="toggles">
            <Toggle label="Ambient occlusion" value={ssfx.ssao} onChange={(v) => setSSFX({ ssao: v })} />
            <Toggle label="Reflections (SSR)" value={ssfx.ssr} onChange={(v) => setSSFX({ ssr: v })} />
            <Toggle label="Contact shadows" value={ssfx.contactShadows} onChange={(v) => setSSFX({ contactShadows: v })} />
            <Toggle label="Temporal AA" value={ssfx.taa} onChange={(v) => setSSFX({ taa: v })} />
          </div>
          {ssfx.ssao && (
            <>
              <Slider
                label="AO radius" value={ssfx.ssaoRadius} min={0.1} max={1.5} step={0.05}
                onChange={(v) => setSSFX({ ssaoRadius: v })} format={(v) => v.toFixed(2)}
              />
              <Slider
                label="AO intensity" value={ssfx.ssaoIntensity} min={0.2} max={3} step={0.1}
                onChange={(v) => setSSFX({ ssaoIntensity: v })} format={(v) => `${v.toFixed(1)}×`}
              />
              <Slider
                label="AO contrast" value={ssfx.ssaoPower} min={0.5} max={3} step={0.1}
                onChange={(v) => setSSFX({ ssaoPower: v })} format={(v) => v.toFixed(1)}
              />
            </>
          )}
          {ssfx.ssr && (
            <>
              <Slider
                label="SSR reach" value={ssfx.ssrMaxDist} min={1} max={16} step={0.5}
                onChange={(v) => setSSFX({ ssrMaxDist: v })} format={(v) => v.toFixed(1)}
              />
              <Slider
                label="SSR roughness cutoff" value={ssfx.ssrRoughnessCutoff} min={0.05} max={1} step={0.05}
                onChange={(v) => setSSFX({ ssrRoughnessCutoff: v })} format={(v) => v.toFixed(2)}
              />
            </>
          )}
          {ssfx.contactShadows && (
            <Slider
              label="Contact length" value={ssfx.contactLength} min={0.05} max={1} step={0.05}
              onChange={(v) => setSSFX({ contactLength: v })} format={(v) => v.toFixed(2)}
            />
          )}
          <p className="blurb">
            A deferred G-buffer resolves indirect light in screen space — occlusion in the creases,
            true on-screen reflections, and temporal supersampling — closing the gap to the
            path-traced reference. Switch <em>Auto-rotate</em> off to watch TAA sharpen. The
            <em> Ambient occ.</em> &amp; <em>Reflections</em> render modes show each buffer raw.
          </p>
          <button className="reset" onClick={runSSFX} type="button" disabled={ssfxTesting} style={{ width: '100%' }}>
            {ssfxTesting ? 'Running…' : 'Run screen-space self-test'}
          </button>
          {ssfxTests && (
            <div className="rt-tests">
              <p className="blurb">
                {ssfxTests.filter((t) => t.pass).length}/{ssfxTests.length} checks passed — each drives whole
                frames through the renderer and inspects the raw buffers.
              </p>
              {ssfxTests.map((t) => (
                <p key={t.name} className={`obj-msg ${t.pass ? 'ok' : 'err'}`}>
                  {t.pass ? '✓' : '✗'} {t.name} — {t.detail}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

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

      <Section title="Implicit modelling (SDF → marching cubes)">
        <div className="seg seg-wrap">
          {SDF_PRESETS.map((p) => (
            <button
              key={p.key}
              className={props.sdfPreset === p.key ? 'active' : ''}
              onClick={() => { props.setSdfPreset(p.key); props.onViewImplicit() }}
              type="button"
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="blurb">{activeSdf.blurb}</p>
        <Slider
          label="Grid resolution" value={props.sdfRes} min={16} max={96} step={4}
          onChange={props.setSdfRes} format={(v) => `${v.toFixed(0)}³ cells`}
        />
        <Slider
          label="Blend smoothness" value={props.sdfSmooth} min={0} max={0.6} step={0.01}
          onChange={props.setSdfSmooth} format={(v) => v.toFixed(2)}
        />
        <Slider
          label="Iso level" value={props.sdfIso} min={-0.4} max={0.4} step={0.02}
          onChange={props.setSdfIso} format={(v) => v.toFixed(2)}
        />
        <div className="seg">
          <button className="active" onClick={props.onViewImplicit} type="button">
            View in scene
          </button>
        </div>
        {props.sdfInfo && (
          <p className={`obj-msg ${props.sdfInfo.watertight ? 'ok' : ''}`}>
            {props.sdfInfo.triangles.toLocaleString()} triangles · {props.sdfInfo.vertices.toLocaleString()} welded
            vertices · {props.sdfInfo.watertight ? 'watertight ✓' : 'open surface'} · {props.sdfInfo.ms.toFixed(0)} ms
          </p>
        )}
        <p className="blurb">
          A signed distance field — primitives combined with boolean and <em>smooth</em> CSG — is
          sampled on a grid and polygonised by hand-written marching cubes. Vertices are welded
          across cells (so the mesh is a closed manifold) and normals come straight from the field
          gradient. The result drops into the same rasterizer <em>and</em> path tracer as any mesh.
        </p>
        <button className="reset" onClick={runSdf} type="button" disabled={sdfTesting} style={{ width: '100%' }}>
          {sdfTesting ? 'Running…' : 'Run marching-cubes self-test'}
        </button>
        {sdfTests && (
          <div className="rt-tests">
            <p className="blurb">
              {sdfTests.filter((t) => t.pass).length}/{sdfTests.length} checks passed — primitive
              distances, the smooth-min identity, analytic volume, and the Euler characteristic that
              fixes the topology (sphere χ=2, torus χ=0).
            </p>
            {sdfTests.map((t) => (
              <p key={t.name} className={`obj-msg ${t.pass ? 'ok' : 'err'}`}>
                {t.pass ? '✓' : '✗'} {t.name} — {t.detail}
              </p>
            ))}
          </div>
        )}
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
