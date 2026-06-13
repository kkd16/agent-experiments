// The control sidebar: presets, simulation parameters, integrator selection and
// rendering options. Pure presentation — every value and setter is owned by App.

import type { RenderOptions } from '../render/Renderer'
import type { ColorMapId } from '../render/colormap'
import { COLORMAP_IDS } from '../render/colormap'
import { INTEGRATORS } from '../sim/types'
import type { IntegratorId, SimParams } from '../sim/types'
import { PRESETS } from '../sim/presets'
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
      </Section>

      <Section title="Rendering">
        <Select<ColorMapId>
          label="Colour map"
          value={p.render.colorMap}
          options={COLORMAP_IDS.map((id) => ({ value: id, label: id }))}
          onChange={(v) => p.onRender({ colorMap: v })}
        />
        <Segmented<'speed' | 'mass'>
          label="Colour by"
          value={p.render.colorBy}
          options={[
            { value: 'speed', label: 'Speed' },
            { value: 'mass', label: 'Mass' },
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
