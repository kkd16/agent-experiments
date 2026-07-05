// The studio's control panel: seed, world/terrain/climate/water/civilisation sliders,
// presets, palette and layer toggles, and export. Parameter changes flow through
// `patch` (which regenerates the world); view changes flow through `setView` (a cheap
// re-render).

import type { ReactElement } from 'react'
import type { TerrainMode, WorldParams, WorldShape } from '../core/types'
import { PRESETS, SHAPES } from '../core/presets'
import { PALETTES } from '../render/palettes'
import { randomSeed } from '../core/rng'
import type { Overlay, ViewOptions } from './viewOptions'
import { OVERLAYS } from './viewOptions'

interface Props {
  params: WorldParams
  patch: (p: Partial<WorldParams>) => void
  view: ViewOptions
  setView: (v: ViewOptions) => void
  onExportPng: () => void
  onExportSvg: () => void
  generating: boolean
  chronicleOpen: boolean
  onToggleChronicle: () => void
  agesOpen: boolean
  onToggleAges: () => void
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  fmt?: (v: number) => string
}): ReactElement {
  const { label, value, min, max, step, onChange, fmt } = props
  return (
    <label className="ctl">
      <span className="ctl-row">
        <span className="ctl-label">{label}</span>
        <span className="ctl-val">{fmt ? fmt(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function Toggle(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): ReactElement {
  return (
    <label className={`toggle ${props.checked ? 'on' : ''}`}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="toggle-dot" />
      {props.label}
    </label>
  )
}

const TERRAIN_MODES: { value: TerrainMode; label: string }[] = [
  { value: 'noise', label: 'Noise' },
  { value: 'tectonic', label: 'Tectonic' },
]

const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']
function bearing(deg: number): string {
  return COMPASS[Math.round(((deg % 360) / 45)) % 8]
}

export default function Controls({
  params,
  patch,
  view,
  setView,
  onExportPng,
  onExportSvg,
  generating,
  chronicleOpen,
  onToggleChronicle,
  agesOpen,
  onToggleAges,
}: Props): ReactElement {
  const setV = (partial: Partial<ViewOptions>): void => setView({ ...view, ...partial })

  return (
    <aside className="panel">
      <header className="panel-head">
        <h1>Cartographer</h1>
        <p className="tagline">procedural atlas generator</p>
      </header>

      <section className="group">
        <div className="seed-row">
          <input
            className="seed-input"
            value={params.seed}
            spellCheck={false}
            onChange={(e) => patch({ seed: e.target.value })}
            aria-label="World seed"
          />
          <button
            className="btn dice"
            title="Random seed"
            onClick={() => patch({ seed: randomSeed() })}
          >
            🎲
          </button>
        </div>
        {generating && <div className="gen-note">generating…</div>}
      </section>

      <section className="group">
        <h2>Presets</h2>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className="preset"
              title={p.blurb}
              onClick={() => patch(p.patch)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </section>

      <section className="group">
        <h2>World</h2>
        <label className="ctl">
          <span className="ctl-label">Shape</span>
          <div className="seg">
            {SHAPES.map((s) => (
              <button
                key={s.value}
                className={`seg-btn ${params.shape === s.value ? 'active' : ''}`}
                onClick={() => patch({ shape: s.value as WorldShape })}
              >
                {s.label}
              </button>
            ))}
          </div>
        </label>
        <Slider
          label="Detail (regions)"
          value={params.regions}
          min={2500}
          max={13000}
          step={500}
          onChange={(v) => patch({ regions: v })}
          fmt={(v) => `${(v / 1000).toFixed(1)}k`}
        />
        <Slider
          label="Sea level"
          value={params.seaLevel}
          min={0.15}
          max={0.65}
          step={0.01}
          onChange={(v) => patch({ seaLevel: v })}
          fmt={(v) => v.toFixed(2)}
        />
        <Slider
          label="Island falloff"
          value={params.islandFalloff}
          min={0.4}
          max={1.5}
          step={0.05}
          onChange={(v) => patch({ islandFalloff: v })}
          fmt={(v) => v.toFixed(2)}
        />
      </section>

      <section className="group">
        <h2>Terrain</h2>
        <label className="ctl">
          <span className="ctl-label">Mode</span>
          <div className="seg">
            {TERRAIN_MODES.map((m) => (
              <button
                key={m.value}
                className={`seg-btn ${params.terrainMode === m.value ? 'active' : ''}`}
                onClick={() => patch({ terrainMode: m.value })}
              >
                {m.label}
              </button>
            ))}
          </div>
        </label>
        {params.terrainMode === 'tectonic' && (
          <Slider
            label="Plates"
            value={params.plates}
            min={4}
            max={20}
            step={1}
            onChange={(v) => patch({ plates: v })}
          />
        )}
        <Slider
          label="Feature scale"
          value={params.noiseScale}
          min={1.5}
          max={7}
          step={0.1}
          onChange={(v) => patch({ noiseScale: v })}
          fmt={(v) => v.toFixed(1)}
        />
        <Slider
          label="Octaves"
          value={params.octaves}
          min={3}
          max={8}
          step={1}
          onChange={(v) => patch({ octaves: v })}
        />
        <Slider
          label="Erosion"
          value={params.erosion}
          min={0}
          max={4}
          step={1}
          onChange={(v) => patch({ erosion: v })}
        />
      </section>

      <section className="group">
        <h2>Climate</h2>
        <Slider
          label="Wind bearing"
          value={params.windAngle}
          min={0}
          max={359}
          step={1}
          onChange={(v) => patch({ windAngle: v })}
          fmt={(v) => `${v}° ${bearing(v)}`}
        />
        <Slider
          label="Rain shadow"
          value={params.orographic}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => patch({ orographic: v })}
          fmt={(v) => v.toFixed(2)}
        />
      </section>

      <section className="group">
        <h2>Water</h2>
        <Slider
          label="Rainfall"
          value={params.rainfall}
          min={0.4}
          max={2.5}
          step={0.1}
          onChange={(v) => patch({ rainfall: v })}
          fmt={(v) => v.toFixed(1)}
        />
        <Slider
          label="River threshold"
          value={params.riverThreshold}
          min={0.004}
          max={0.05}
          step={0.002}
          onChange={(v) => patch({ riverThreshold: v })}
          fmt={(v) => v.toFixed(3)}
        />
      </section>

      <section className="group">
        <h2>Civilisation</h2>
        <Slider
          label="Cities"
          value={params.cities}
          min={0}
          max={28}
          step={1}
          onChange={(v) => patch({ cities: v })}
        />
      </section>

      <section className="group">
        <h2>Overlay</h2>
        <div className="overlay-grid">
          {OVERLAYS.map((o) => (
            <button
              key={o.value}
              className={`seg-btn ${view.overlay === o.value ? 'active' : ''}`}
              onClick={() => setV({ overlay: o.value as Overlay })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="group">
        <h2>Style</h2>
        <div className="palette-row">
          {PALETTES.map((p) => (
            <button
              key={p.key}
              className={`pal-btn ${view.paletteKey === p.key ? 'active' : ''}`}
              onClick={() => setV({ paletteKey: p.key })}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="toggle-grid">
          <Toggle label="Rivers" checked={view.showRivers} onChange={(v) => setV({ showRivers: v })} />
          <Toggle label="Coast" checked={view.showCoast} onChange={(v) => setV({ showCoast: v })} />
          <Toggle
            label="Hillshade"
            checked={view.showHillshade}
            onChange={(v) => setV({ showHillshade: v })}
          />
          <Toggle label="Contours" checked={view.showContours} onChange={(v) => setV({ showContours: v })} />
          <Toggle label="Borders" checked={view.showBorders} onChange={(v) => setV({ showBorders: v })} />
          <Toggle label="Labels" checked={view.showLabels} onChange={(v) => setV({ showLabels: v })} />
          <Toggle label="Grain" checked={view.showGrain} onChange={(v) => setV({ showGrain: v })} />
          <Toggle label="Frame" checked={view.showFrame} onChange={(v) => setV({ showFrame: v })} />
          <Toggle label="Compass" checked={view.showCompass} onChange={(v) => setV({ showCompass: v })} />
          <Toggle label="Scale" checked={view.showScale} onChange={(v) => setV({ showScale: v })} />
          <Toggle label="Graticule" checked={view.showGraticule} onChange={(v) => setV({ showGraticule: v })} />
          <Toggle label="Plates" checked={view.showPlates} onChange={(v) => setV({ showPlates: v })} />
          <Toggle label="Wind" checked={view.showWind} onChange={(v) => setV({ showWind: v })} />
        </div>
        <div className="toggle-grid civ-toggles">
          <Toggle label="Provinces" checked={view.showProvinces} onChange={(v) => setV({ showProvinces: v })} />
          <Toggle label="Roads" checked={view.showRoads} onChange={(v) => setV({ showRoads: v })} />
          <Toggle label="Cities" checked={view.showCities} onChange={(v) => setV({ showCities: v })} />
        </div>
      </section>

      <section className="group">
        <button
          className={`btn chronicle-btn ${agesOpen ? 'active' : ''}`}
          onClick={onToggleAges}
        >
          ⏳ {agesOpen ? 'Close' : 'Play'} the Ages
        </button>
        <button
          className={`btn chronicle-btn ${chronicleOpen ? 'active' : ''}`}
          onClick={onToggleChronicle}
        >
          📜 {chronicleOpen ? 'Hide' : 'Read'} the Chronicle
        </button>
      </section>

      <section className="group export-row">
        <button className="btn export" onClick={onExportPng}>
          Export PNG
        </button>
        <button className="btn export" onClick={onExportSvg}>
          Export SVG
        </button>
      </section>

      <footer className="panel-foot">
        Tectonics · Köppen climate · named rivers · biomes · a resource economy & trade ·
        a generated chronicle — all in your browser. Click any cell to inspect it.
      </footer>
    </aside>
  )
}
