// The control sidebar: presets, simulation parameters, integrator selection and
// rendering options. Pure presentation — every value and setter is owned by App.

import type { ColorBy, RenderOptions } from '../render/Renderer'
import type { ColorMapId } from '../render/colormap'
import { COLORMAP_IDS } from '../render/colormap'
import { INTEGRATORS } from '../sim/types'
import type { IntegratorId, SimParams } from '../sim/types'
import { PRESETS } from '../sim/presets'
import type { ChaosResult } from '../sim/chaos'
import type { FreqDiffusion, NaffResult } from '../sim/naff'
import type { PoincareResult } from '../sim/poincare'
import { ChaosPanel } from './ChaosPanel'
import { SpectralPanel } from './SpectralPanel'
import { PoincarePanel } from './PoincarePanel'
import { RelativityPanel } from './RelativityPanel'
import { Section, Segmented, Select, Slider, Toggle } from './primitives'

export interface SidebarProps {
  presetId: string
  presetDescription: string
  onPreset: (id: string) => void
  count: number
  countBounds: { min: number; max: number }
  onCount: (n: number) => void
  onReseed: () => void
  onReset: () => void
  params: SimParams
  onParams: (patch: Partial<SimParams>) => void
  subSteps: number
  onSubSteps: (n: number) => void
  render: RenderOptions
  onRender: (patch: Partial<RenderOptions>) => void
  mode: 'pan' | 'slingshot'
  onMode: (m: 'pan' | 'slingshot') => void
  slingMass: number
  onSlingMass: (m: number) => void
  followCom: boolean
  onFollowCom: (v: boolean) => void
  predict: boolean
  onPredict: (v: boolean) => void
  predictHorizon: number
  onPredictHorizon: (n: number) => void
  chaosResult: ChaosResult | null
  chaosRunning: boolean
  chaosHorizon: number
  onChaosHorizon: (n: number) => void
  onAnalyzeChaos: () => void
  spectralResult: NaffResult | null
  spectralDiffusion: FreqDiffusion | null
  spectralRunning: boolean
  spectralTerms: number
  onSpectralTerms: (n: number) => void
  spectralRef: 'heaviest' | 'barycenter'
  onSpectralRef: (m: 'heaviest' | 'barycenter') => void
  onAnalyzeSpectral: () => void
  spectralTargetLabel: string
  poincareResult: PoincareResult | null
  poincareRunning: boolean
  onAnalyzePoincare: () => void
  poincareTargetLabel: string
}

const integrator = INTEGRATORS.reduce<Record<string, (typeof INTEGRATORS)[number]>>((acc, it) => {
  acc[it.id] = it
  return acc
}, {})

export function Sidebar(p: SidebarProps) {
  const info = integrator[p.params.integrator]
  return (
    <aside className="sidebar">
      <Section title="Scenario">
        <div className="preset-grid">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`preset ${preset.id === p.presetId ? 'active' : ''}`}
              onClick={() => p.onPreset(preset.id)}
              title={preset.description}
            >
              {preset.name}
            </button>
          ))}
        </div>
        <p className="preset-desc">{p.presetDescription}</p>
        <Slider
          label="Bodies"
          value={p.count}
          min={p.countBounds.min}
          max={p.countBounds.max}
          step={p.count > 2000 ? 500 : 50}
          onChange={(v) => p.onCount(Math.round(v))}
          format={(v) => v.toLocaleString()}
          title="Number of bodies in the scenario"
        />
        <div className="btn-row">
          <button type="button" className="btn" onClick={p.onReset}>
            ↻ Rebuild
          </button>
          <button type="button" className="btn" onClick={p.onReseed}>
            🎲 New seed
          </button>
        </div>
      </Section>

      <Section title="Integrator">
        <Select<IntegratorId>
          label="Scheme"
          value={p.params.integrator}
          options={INTEGRATORS.map((it) => ({ value: it.id, label: it.label }))}
          onChange={(v) => p.onParams({ integrator: v })}
        />
        {info && (
          <p className="integrator-blurb">
            <span className={`tag ${info.symplectic ? 'good' : 'warn'}`}>
              {info.symplectic ? 'symplectic' : 'non-symplectic'}
            </span>
            <span className="tag">{info.evals}× eval/step</span>
            {info.blurb}
          </p>
        )}
      </Section>

      <Section title="Physics">
        <Slider
          label="Gravity G"
          value={p.params.g}
          min={0.1}
          max={4}
          step={0.05}
          onChange={(v) => p.onParams({ g: v })}
          format={(v) => v.toFixed(2)}
          title="Gravitational constant"
        />
        <Slider
          label="Timestep Δt"
          value={p.params.dt}
          min={0.005}
          max={0.2}
          step={0.005}
          onChange={(v) => p.onParams({ dt: v })}
          format={(v) => v.toFixed(3)}
          title="Integration timestep — smaller is more accurate but slower"
        />
        <Slider
          label="Softening ε"
          value={p.params.softening}
          min={0.5}
          max={20}
          step={0.5}
          onChange={(v) => p.onParams({ softening: v })}
          format={(v) => v.toFixed(1)}
          title="Plummer softening length — removes the force singularity at r→0"
        />
        <Slider
          label="Opening angle θ"
          value={p.params.theta}
          min={0.2}
          max={1.2}
          step={0.05}
          onChange={(v) => p.onParams({ theta: v })}
          format={(v) => v.toFixed(2)}
          title="Barnes–Hut accuracy: smaller θ is more accurate but slower (θ=0 is exact)"
        />
        <Slider
          label="Steps / frame"
          value={p.subSteps}
          min={1}
          max={8}
          step={1}
          onChange={(v) => p.onSubSteps(Math.round(v))}
          title="Sub-steps per rendered frame — raises simulation speed"
        />
        <Toggle
          label="Relativity (1PN)"
          checked={p.params.gr}
          onChange={(v) => p.onParams({ gr: v })}
          title="Add Einstein's first post-Newtonian correction about the heaviest body — orbits precess (key: g)"
        />
        {p.params.gr && (
          <Slider
            label="Speed of light c"
            value={p.params.c}
            min={60}
            max={2000}
            step={10}
            onChange={(v) => p.onParams({ c: Math.round(v) })}
            format={(v) => v.toFixed(0)}
            title="GR strength: lower c → stronger relativity → faster precession (∝ 1/c²). Large c → Newtonian."
          />
        )}
        <Toggle
          label="Collisions (merge)"
          checked={p.params.collide}
          onChange={(v) => p.onParams({ collide: v })}
          title="Bodies that touch merge inelastically, conserving mass and momentum"
        />
        {p.params.collide && (
          <Slider
            label="Capture radius"
            value={p.params.collisionScale}
            min={0.1}
            max={3}
            step={0.1}
            onChange={(v) => p.onParams({ collisionScale: v })}
            format={(v) => v.toFixed(1)}
            title="Merge distance scale: capture radius R = scale · mass^(1/3)"
          />
        )}
      </Section>

      <Section title="Forecast" defaultOpen={false}>
        <Toggle
          label="Predict orbits"
          checked={p.predict}
          onChange={p.onPredict}
          title="Forecast future paths of the heaviest bodies (and the selected one) by evolving a shadow copy of the system"
        />
        {p.predict && (
          <Slider
            label="Horizon"
            value={p.predictHorizon}
            min={100}
            max={1500}
            step={50}
            onChange={(v) => p.onPredictHorizon(Math.round(v))}
            format={(v) => `${v} steps`}
            title="How far ahead to forecast (effective length is capped for large N)"
          />
        )}
      </Section>

      <Section title="Analysis" defaultOpen={false}>
        <Toggle
          label="Osculating orbit"
          checked={p.render.showOrbit}
          onChange={(v) => p.onRender({ showOrbit: v })}
          title="Draw the instantaneous Kepler orbit of the selected body (key: o)"
        />
        <Segmented<'heaviest' | 'barycenter'>
          label="Orbit about"
          value={p.render.primary}
          options={[
            { value: 'heaviest', label: 'Heaviest', title: 'Two-body orbit about the most massive body' },
            { value: 'barycenter', label: 'Barycentre', title: 'Orbit in the mean field about the centre of mass' },
          ]}
          onChange={(v) => p.onRender({ primary: v })}
        />
        <Toggle
          label="Lagrange & Hill curves"
          checked={p.render.showLagrange}
          onChange={(v) => p.onRender({ showLagrange: v })}
          title="Restricted-3-body L1–L5 points and zero-velocity (Hill-region) curves for the two heaviest bodies (key: l)"
        />
      </Section>

      <Section title="Chaos Lab" defaultOpen={false}>
        <ChaosPanel
          result={p.chaosResult}
          running={p.chaosRunning}
          horizon={p.chaosHorizon}
          onHorizon={p.onChaosHorizon}
          onRun={p.onAnalyzeChaos}
          bodyCount={p.count}
        />
      </Section>

      <Section title="Spectral Lab" defaultOpen={false}>
        <SpectralPanel
          result={p.spectralResult}
          diffusion={p.spectralDiffusion}
          running={p.spectralRunning}
          terms={p.spectralTerms}
          onTerms={p.onSpectralTerms}
          refMode={p.spectralRef}
          onRefMode={p.onSpectralRef}
          onRun={p.onAnalyzeSpectral}
          targetLabel={p.spectralTargetLabel}
          bodyCount={p.count}
        />
      </Section>

      <Section title="Poincaré Lab" defaultOpen={false}>
        <PoincarePanel
          result={p.poincareResult}
          running={p.poincareRunning}
          onRun={p.onAnalyzePoincare}
          targetLabel={p.poincareTargetLabel}
          bodyCount={p.count}
        />
      </Section>

      <Section title="Relativity Lab" defaultOpen={false}>
        <RelativityPanel />
      </Section>

      <Section title="Rendering">
        <Select<ColorMapId>
          label="Colour map"
          value={p.render.colorMap}
          options={COLORMAP_IDS.map((id) => ({ value: id, label: id }))}
          onChange={(v) => p.onRender({ colorMap: v })}
        />
        <Segmented<ColorBy>
          label="Colour by"
          value={p.render.colorBy}
          options={[
            { value: 'speed', label: 'Speed' },
            { value: 'mass', label: 'Mass' },
            { value: 'accel', label: 'Accel.' },
          ]}
          onChange={(v) => p.onRender({ colorBy: v })}
        />
        <Toggle label="Motion trails" checked={p.render.trails} onChange={(v) => p.onRender({ trails: v })} />
        {p.render.trails && (
          <Slider
            label="Trail length"
            value={1 - p.render.trailFade}
            min={0}
            max={0.97}
            step={0.01}
            onChange={(v) => p.onRender({ trailFade: 1 - v })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        )}
        <Slider
          label="Glow size"
          value={p.render.glowSize}
          min={0.5}
          max={6}
          step={0.1}
          onChange={(v) => p.onRender({ glowSize: v })}
          format={(v) => v.toFixed(1)}
        />
        <Slider
          label="Brightness"
          value={p.render.brightness}
          min={0.05}
          max={1}
          step={0.05}
          onChange={(v) => p.onRender({ brightness: v })}
          format={(v) => `${Math.round(v * 100)}%`}
        />
        <Toggle
          label="Show quadtree"
          checked={p.render.showQuadtree}
          onChange={(v) => p.onRender({ showQuadtree: v })}
          title="Visualise the Barnes–Hut spatial subdivision"
        />
        <Toggle
          label="Potential field"
          checked={p.render.showField}
          onChange={(v) => p.onRender({ showField: v })}
          title="Heatmap of the gravitational potential, sampled through the Barnes–Hut tree (replaces motion trails while on)"
        />
        <Toggle
          label="Legend & scale bar"
          checked={p.render.showLegend}
          onChange={(v) => p.onRender({ showLegend: v })}
          title="Show the colour-bar legend and the world-unit scale bar"
        />
      </Section>

      <Section title="Interaction" defaultOpen={false}>
        <Segmented<'pan' | 'slingshot'>
          label="Mouse drag"
          value={p.mode}
          options={[
            { value: 'pan', label: 'Pan', title: 'Drag to pan the camera' },
            { value: 'slingshot', label: 'Slingshot', title: 'Drag to fling a new body' },
          ]}
          onChange={p.onMode}
        />
        {p.mode === 'slingshot' && (
          <Slider
            label="Spawn mass"
            value={p.slingMass}
            min={1}
            max={5000}
            step={1}
            onChange={(v) => p.onSlingMass(Math.round(v))}
            format={(v) => v.toLocaleString()}
            title="Mass of bodies created by slingshot"
          />
        )}
        <Toggle
          label="Follow centre of mass"
          checked={p.followCom}
          onChange={p.onFollowCom}
          title="Keep the camera centred on the system's centre of mass"
        />
      </Section>
    </aside>
  )
}
