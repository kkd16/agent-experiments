import { useState } from 'react'
import type { Engine, RenderSettings, RTSettings } from '../engine/renderer.ts'
import type { RTMode, RTView } from '../raytrace/raytracer.ts'
import type { DenoiseSettings } from '../raytrace/denoise.ts'
import { runDenoiseSelfTest } from '../raytrace/denoise_verify.ts'
import type { DenoiseTest } from '../raytrace/denoise_verify.ts'
import type { RenderMode } from '../render/types.ts'
import type { PostSettings, ToneMap } from '../render/post.ts'
import type { SSFXSettings } from '../render/ssfx.ts'
import type { ShadingModel } from '../render/shading.ts'
import { PRESET_LABELS } from '../scene/scene.ts'
import { runRTSelfTest } from '../raytrace/verify.ts'
import type { RTTest } from '../raytrace/verify.ts'
import { runDielectricSelfTest } from '../raytrace/dielectric_verify.ts'
import type { DielectricTest } from '../raytrace/dielectric_verify.ts'
import { runThinFilmSelfTest } from '../raytrace/thinfilm_verify.ts'
import type { ThinFilmTest } from '../raytrace/thinfilm_verify.ts'
import { MEDIUM_PRESETS } from '../raytrace/medium.ts'
import { runMediumSelfTest } from '../raytrace/medium_verify.ts'
import type { MediumTest } from '../raytrace/medium_verify.ts'
import { runSpectralSelfTest } from '../raytrace/spectral_verify.ts'
import type { SpectralTest } from '../raytrace/spectral_verify.ts'
import { runSSFXSelfTest } from '../render/ssfx_verify.ts'
import type { SSFXTest } from '../render/ssfx_verify.ts'
import type { TransparencySettings } from '../render/oit.ts'
import { runOITSelfTest } from '../render/oit_verify.ts'
import type { OITTest } from '../render/oit_verify.ts'
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
  const setTransp = (patch: Partial<TransparencySettings>): void => set({ transparency: { ...settings.transparency, ...patch } })
  const setDen = (patch: Partial<DenoiseSettings>): void => setRT({ denoise: { ...settings.rt.denoise, ...patch } })
  const setMed = (patch: Partial<RTSettings['medium']>): void => setRT({ medium: { ...settings.rt.medium, ...patch } })
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
  const [denTests, setDenTests] = useState<DenoiseTest[] | null>(null)
  const [denTesting, setDenTesting] = useState(false)
  const runDen = (): void => {
    setDenTesting(true)
    setDenTests(null)
    setTimeout(() => {
      setDenTests(runDenoiseSelfTest())
      setDenTesting(false)
    }, 30)
  }
  const [oitTests, setOitTests] = useState<OITTest[] | null>(null)
  const [oitTesting, setOitTesting] = useState(false)
  const runOit = (): void => {
    setOitTesting(true)
    setOitTests(null)
    setTimeout(() => {
      setOitTests(runOITSelfTest())
      setOitTesting(false)
    }, 30)
  }
  const [dieTests, setDieTests] = useState<DielectricTest[] | null>(null)
  const [dieTesting, setDieTesting] = useState(false)
  const runDie = (): void => {
    setDieTesting(true)
    setDieTests(null)
    setTimeout(() => {
      setDieTests(runDielectricSelfTest())
      setDieTesting(false)
    }, 30)
  }
  const [filmTests, setFilmTests] = useState<ThinFilmTest[] | null>(null)
  const [filmTesting, setFilmTesting] = useState(false)
  const runFilm = (): void => {
    setFilmTesting(true)
    setFilmTests(null)
    setTimeout(() => {
      setFilmTests(runThinFilmSelfTest())
      setFilmTesting(false)
    }, 30)
  }
  const [medTests, setMedTests] = useState<MediumTest[] | null>(null)
  const [medTesting, setMedTesting] = useState(false)
  const runMed = (): void => {
    setMedTesting(true)
    setMedTests(null)
    setTimeout(() => {
      setMedTests(runMediumSelfTest())
      setMedTesting(false)
    }, 30)
  }
  const [specTests, setSpecTests] = useState<SpectralTest[] | null>(null)
  const [specTesting, setSpecTesting] = useState(false)
  const runSpec = (): void => {
    setSpecTesting(true)
    setSpecTests(null)
    setTimeout(() => {
      setSpecTests(runSpectralSelfTest())
      setSpecTesting(false)
    }, 30)
  }
  const activeSdf = SDF_PRESETS.find((p) => p.key === props.sdfPreset) ?? SDF_PRESETS[0]
  const rtViews: { key: RTView; label: string }[] = [
    { key: 'denoised', label: 'Denoised' },
    { key: 'noisy', label: 'Noisy' },
    { key: 'split', label: 'Wipe' },
    { key: 'albedo', label: 'Albedo' },
    { key: 'normal', label: 'Normal' },
    { key: 'variance', label: 'Variance' },
  ]

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
    { key: 'spectral', label: 'Spectral' },
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
          {rt.mode !== 'ao' && (
            <Slider
              label="Max bounces" value={rt.maxBounces} min={1} max={8} step={1}
              onChange={(v) => setRT({ maxBounces: v })} format={(v) => v.toFixed(0)}
            />
          )}
          {rt.mode !== 'ao' && (
            <Toggle
              label="Multiple importance sampling"
              value={rt.mis}
              onChange={(v) => setRT({ mis: v })}
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
            BVH-accelerated Möller–Trumbore tracing, and direct light by <em>multiple importance
            sampling</em> — next-event estimation and BSDF sampling combined by the power heuristic,
            so glossy surfaces under area lights converge fast and without double-counting. Toggle
            MIS off to watch next-event-only fireflies erupt on the same scene. The analytic sky is
            an infinite emitter — drag to orbit and it re-converges.
          </p>
        </Section>
      )}

      {isRT && rt.mode === 'spectral' && (
        <Section title="Spectral rendering — true dispersion">
          <p className="blurb">
            The path tracer's RGB cousin fakes dispersion with a three-channel hero hack; this mode
            does the real thing. Each camera ray carries a single <em>wavelength</em> λ — importance-
            sampled ∝ ȳ(λ) and stratified across a pixel's samples — and every glass facet bends it by
            <em> that</em> wavelength's index of refraction (a real <em>Sellmeier</em> curve for named
            glasses, BK7 / SF10 / silica / water / diamond, or the achromatic Cauchy fan), so a prism
            splits white light into a <em>continuous</em> spectrum. Radiance per λ is reconstructed to
            colour through the <em>CIE 1931</em> matching functions and white-balanced so a
            non-dispersive scene reads at the same exposure as the RGB tracer — only dispersion differs.
            Existing RGB materials get a <em>Smits</em>-up-sampled reflectance spectrum; emitters can be
            true <em>Planckian</em> blackbodies. Try <em>Prism</em>, <em>Dispersion</em> and
            <em> Blackbody</em>, and let them converge — one wavelength per ray makes colour noisy
            early, so the progressive average (the <em>Noisy</em> view) cleans up to a fully
            saturated spectrum; the edge-avoiding denoiser is best left off here since it blurs the
            very chromatic detail dispersion creates.
          </p>
          <button className="reset" onClick={runSpec} type="button" disabled={specTesting} style={{ width: '100%' }}>
            {specTesting ? 'Running…' : 'Run spectral self-test'}
          </button>
          {specTests && (
            <div className="rt-tests">
              <p className="blurb">
                {specTests.filter((t) => t.pass).length}/{specTests.length} checks passed — the
                equal-energy white point, the importance-sampled wavelength estimator vs a deterministic
                CMF integral, the Smits round-trip, the catalogue Abbe numbers &amp; normal dispersion,
                the prism minimum-deviation spread (flint vs crown), the blackbody locus, and two
                spectral furnaces (energy &amp; exposure parity).
              </p>
              {specTests.map((t) => (
                <p key={t.name} className={`obj-msg ${t.pass ? 'ok' : 'err'}`}>
                  {t.pass ? '✓' : '✗'} {t.name} — {t.detail}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

      {isRT && rt.mode === 'path' && (
        <Section title="Atmosphere — volumetric media">
          <div className="toggles">
            <Toggle label="Participating medium" value={rt.medium.enabled} onChange={(v) => setMed({ enabled: v })} />
          </div>
          {rt.medium.enabled && (
            <>
              <div className="seg seg-wrap">
                {MEDIUM_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    className={rt.medium.preset === p.key ? 'active' : ''}
                    onClick={() => setMed({ preset: p.key, g: p.g })}
                    type="button"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="blurb">{(MEDIUM_PRESETS.find((p) => p.key === rt.medium.preset) ?? MEDIUM_PRESETS[0]).blurb}</p>
              <Slider
                label="Density" value={rt.medium.density} min={0.1} max={3} step={0.1}
                onChange={(v) => setMed({ density: v })} format={(v) => `${v.toFixed(1)}×`}
              />
              <Slider
                label="Anisotropy (g)" value={rt.medium.g} min={-0.9} max={0.9} step={0.05}
                onChange={(v) => setMed({ g: v })}
                format={(v) => (Math.abs(v) < 0.03 ? 'isotropic' : v > 0 ? `${v.toFixed(2)} forward` : `${v.toFixed(2)} back`)}
              />
            </>
          )}
          <p className="blurb">
            A bounded region of <em>participating media</em> that absorbs and scatters light along
            the ray, not just at surfaces — fog, haze, smoke and nebulae. Light is lost as
            transmittance <em>e<sup>−∫σ ds</sup></em> (Beer–Lambert) and turns by the
            Henyey–Greenstein phase function; in-scattered direct light comes from NEE through the
            volume, so occluders carve real <em>god-ray</em> beams. Homogeneous media use a spectral
            (per-RGB) estimator so fog can be coloured; heterogeneous smoke/nebulae use Woodcock
            <em> delta / ratio tracking</em> over a from-scratch fBm density field. Try the
            <em> Cathedral</em> &amp; <em>Nebula</em> scenes.
          </p>
          <button className="reset" onClick={runMed} type="button" disabled={medTesting} style={{ width: '100%' }}>
            {medTesting ? 'Running…' : 'Run volumetrics self-test'}
          </button>
          {medTests && (
            <div className="rt-tests">
              <p className="blurb">
                {medTests.filter((t) => t.pass).length}/{medTests.length} checks passed — the phase
                function's normalisation, the spectral &amp; Woodcock estimators against analytic
                Beer–Lambert, and a multiple-scattering furnace for energy conservation.
              </p>
              {medTests.map((t) => (
                <p key={t.name} className={`obj-msg ${t.pass ? 'ok' : 'err'}`}>
                  {t.pass ? '✓' : '✗'} {t.name} — {t.detail}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

      {isRT && (
        <Section title="Denoiser (À-Trous · SVGF-lite)">
          <div className="toggles">
            <Toggle label="Denoise" value={rt.denoise.enabled} onChange={(v) => setDen({ enabled: v })} />
            <Toggle label="Demodulate albedo" value={rt.denoise.demodulate} onChange={(v) => setDen({ demodulate: v })} />
            <Toggle label="Variance-guided" value={rt.denoise.varianceGuided} onChange={(v) => setDen({ varianceGuided: v })} />
          </div>
          <p className="blurb">Show:</p>
          <div className="seg seg-wrap">
            {rtViews.map((v) => (
              <button
                key={v.key}
                className={rt.view === v.key ? 'active' : ''}
                onClick={() => setRT({ view: v.key })}
                type="button"
              >
                {v.label}
              </button>
            ))}
          </div>
          {rt.view === 'split' && (
            <Slider
              label="Wipe position" value={rt.splitPos} min={0.1} max={0.9} step={0.01}
              onChange={(v) => setRT({ splitPos: v })} format={(v) => `${(v * 100).toFixed(0)}% noisy`}
            />
          )}
          {rt.denoise.enabled && (
            <>
              <Slider
                label="Wavelet levels" value={rt.denoise.iterations} min={1} max={6} step={1}
                onChange={(v) => setDen({ iterations: v })} format={(v) => `${v.toFixed(0)} · ≈${1 << (v + 2)}px`}
              />
              <Slider
                label="Colour σ" value={rt.denoise.sigmaColor} min={0.5} max={16} step={0.5}
                onChange={(v) => setDen({ sigmaColor: v })} format={(v) => v.toFixed(1)}
              />
              <Slider
                label="Normal σ" value={rt.denoise.sigmaNormal} min={4} max={128} step={4}
                onChange={(v) => setDen({ sigmaNormal: v })} format={(v) => v.toFixed(0)}
              />
              <Slider
                label="Plane σ" value={rt.denoise.sigmaPos} min={0.05} max={2} step={0.05}
                onChange={(v) => setDen({ sigmaPos: v })} format={(v) => v.toFixed(2)}
              />
            </>
          )}
          <p className="blurb">
            An edge-avoiding À-Trous wavelet (Dammertz 2010) with SVGF-style (Schied 2017) variance
            guidance turns the noisy low-sample path tracer into a clean image: it blurs <em>only</em>
            along surfaces — stopped at creases (normal), depth cliffs (plane) and detail (luminance) —
            and only as hard as the local Monte-Carlo noise demands, filtering <em>colour ÷ albedo</em>
            so texture never smears. Try <em>Wipe</em> for a noisy↔denoised split, or the feature
            views the filter reads. As it converges it decays to the exact average.
          </p>
          <button className="reset" onClick={runDen} type="button" disabled={denTesting} style={{ width: '100%' }}>
            {denTesting ? 'Running…' : 'Run denoiser self-test'}
          </button>
          {denTests && (
            <div className="rt-tests">
              <p className="blurb">
                {denTests.filter((t) => t.pass).length}/{denTests.length} checks passed — kernel correctness,
                edge preservation, unbiased variance reduction, and a real path-traced frame end-to-end.
              </p>
              {denTests.map((t) => (
                <p key={t.name} className={`obj-msg ${t.pass ? 'ok' : 'err'}`}>
                  {t.pass ? '✓' : '✗'} {t.name} — {t.detail}
                </p>
              ))}
            </div>
          )}
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
                from an independent reference: ray/triangle &amp; BVH vs brute force, the sampling
                distributions, two furnace tests (energy conservation), an area-light furnace proving
                MIS adds no double-count, and MIS cutting variance ~30000× vs next-event-only.
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

      {isRT && rt.mode === 'path' && (
        <Section title="Dielectrics — refraction & glass">
          <p className="blurb">
            The missing half of surface optics: dielectric <em>refraction</em>. Each glass facet
            obeys the exact unpolarised <em>Fresnel</em> equations and <em>Snell's law</em> —
            reflecting some light, bending the rest (with total internal reflection past the
            critical angle), tinting it by <em>Beer–Lambert</em> absorption through the body, and
            (with <em>dispersion</em> on) fanning each wavelength by its own IOR into a spectrum.
            A smooth interface is exactly energy-conserving (R+T=1); frosted glass roughens the
            microfacet. Try the <em>Glass</em> &amp; <em>Prism</em> scenes and let them converge.
          </p>
          <button className="reset" onClick={runDie} type="button" disabled={dieTesting} style={{ width: '100%' }}>
            {dieTesting ? 'Running…' : 'Run dielectric self-test'}
          </button>
          {dieTests && (
            <div className="rt-tests">
              <p className="blurb">
                {dieTests.filter((t) => t.pass).length}/{dieTests.length} checks passed — Fresnel
                endpoints &amp; energy (R+T=1), Snell + reversibility, total internal reflection, the
                critical angle, Beer–Lambert, Cauchy dispersion ordering, and a clear-glass furnace.
              </p>
              {dieTests.map((t) => (
                <p key={t.name} className={`obj-msg ${t.pass ? 'ok' : 'err'}`}>
                  {t.pass ? '✓' : '✗'} {t.name} — {t.detail}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

      {isRT && rt.mode === 'path' && (
        <Section title="Thin-film iridescence — structural colour">
          <p className="blurb">
            A dielectric coat a few hundred nanometres thick turns a surface <em>iridescent</em>: the
            wave reflected off its top interface interferes with the one off its bottom, and because
            the phase gap is a fixed length in nanometres, each wavelength interferes differently —
            so the reflectance <em>R(λ)</em> is coloured, and the colour drifts with thickness and
            viewing angle. We solve the exact two-interface <em>Airy</em> reflectance and fold it
            through the CIE colour-matching functions; it replaces the microfacet Fresnel in both
            the path tracer and the rasterizer. Open the <em>Iridescence</em> scene: the front row is
            a thickness ladder (blue→gold→magenta→cyan), behind it an anodised knot and a soap bubble.
          </p>
          <button className="reset" onClick={runFilm} type="button" disabled={filmTesting} style={{ width: '100%' }}>
            {filmTesting ? 'Running…' : 'Run thin-film self-test'}
          </button>
          {filmTests && (
            <div className="rt-tests">
              <p className="blurb">
                {filmTests.filter((t) => t.pass).length}/{filmTests.length} checks passed — energy
                bound (0≤R≤1), a vanishing film collapsing to bare Fresnel (cross-checked vs the
                dielectric kernel), neutral-grey white point, and thickness/angle hue drift.
              </p>
              {filmTests.map((t) => (
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

      {!isRT && (
        <Section title="Transparency (WBOIT + refraction)">
          <div className="toggles">
            <Toggle label="Glass (order-independent)" value={settings.transparency.enabled} onChange={(v) => setTransp({ enabled: v })} />
          </div>
          {settings.transparency.enabled && (
            <>
              <Slider
                label="Refraction" value={settings.transparency.refraction} min={0} max={64} step={2}
                onChange={(v) => setTransp({ refraction: v })} format={(v) => `${v.toFixed(0)} px`}
              />
              <Slider
                label="Glass thickness" value={settings.transparency.thickness} min={0.1} max={4} step={0.1}
                onChange={(v) => setTransp({ thickness: v })} format={(v) => v.toFixed(1)}
              />
            </>
          )}
          <p className="blurb">
            The real-time twin of the path tracer's glass. Transmissive objects leave the opaque
            deferred path for a forward pass that needs no sorting: each glass fragment's Fresnel
            reflection is accumulated with a depth weight into a <em>Weighted-Blended OIT</em> buffer
            (McGuire &amp; Bavoil 2013) while the transmittance Π(1−α) accumulates beside it, so the
            blend is <em>order-independent</em> even where glass interpenetrates. The background is
            then refracted in screen space — sampled at an offset along the surface normal — and
            tinted by Beer–Lambert. Switch the engine to <em>Ray tracer</em> on the <em>Glass</em>
            scene to A/B it against the true refraction. Best seen on <em>Interior</em> &amp; <em>Glass</em>.
          </p>
          <button className="reset" onClick={runOit} type="button" disabled={oitTesting} style={{ width: '100%' }}>
            {oitTesting ? 'Running…' : 'Run transparency self-test'}
          </button>
          {oitTests && (
            <div className="rt-tests">
              <p className="blurb">
                {oitTests.filter((t) => t.pass).length}/{oitTests.length} checks passed — the single-layer
                "over" identity, order independence, opaque occlusion, an energy bound, and the depth weight.
              </p>
              {oitTests.map((t) => (
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
