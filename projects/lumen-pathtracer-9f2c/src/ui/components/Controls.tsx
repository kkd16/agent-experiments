// Controls.tsx — the render studio's control panel. Settings split into two
// groups by cost: "render" settings (scene, geometry sampling, path depth)
// require restarting the accumulation, while "display" settings (exposure, tone
// mapping, denoise) are applied live to the existing HDR buffer.

import { Panel, Segmented, Slider, TextArea, Toggle } from './Field'
import { SCENES } from '../../engine/scenes'
import type { ToneMapping } from '../../engine/types'
import { RES_PRESETS } from './controlConfig'
import type { ControlState } from './controlConfig'

export function Controls(props: {
  state: ControlState
  set: <K extends keyof ControlState>(key: K, value: ControlState[K]) => void
  running: boolean
  onRender: () => void
  onStop: () => void
  onSave: () => void
}) {
  const { state, set, running, onRender, onStop, onSave } = props
  const preset = SCENES.find((s) => s.id === state.sceneId)

  return (
    <div className="controls">
      <Panel title="Scene" subtitle="Pick a world to render">
        <div className="scene-grid">
          {SCENES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === state.sceneId ? 'scene-btn active' : 'scene-btn'}
              onClick={() => set('sceneId', s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Panel>

      {preset?.sky && (
        <Panel title="Sky & Sun" subtitle="Preetham daylight — the sun is a sampled light">
          <Slider
            label="Sun azimuth"
            value={state.sunAzimuth}
            min={0}
            max={360}
            step={1}
            onChange={(v) => set('sunAzimuth', v)}
            format={(v) => `${v.toFixed(0)}°`}
            hint="Compass direction of the sun (orbits the scene)."
          />
          <Slider
            label="Sun elevation"
            value={state.sunElevation}
            min={1}
            max={89}
            step={1}
            onChange={(v) => set('sunElevation', v)}
            format={(v) => `${v.toFixed(0)}°`}
            hint="Height of the sun above the horizon — low sun reddens and lengthens shadows."
          />
          <Slider
            label="Turbidity"
            value={state.turbidity}
            min={1.8}
            max={9}
            step={0.1}
            onChange={(v) => set('turbidity', v)}
            format={(v) => v.toFixed(1)}
            hint="Atmospheric haze: ~2 is a crisp alpine sky, ~8 a muggy summer haze."
          />
        </Panel>
      )}

      {preset?.obj && (
        <Panel title="Model" subtitle="Paste a Wavefront OBJ">
          <TextArea
            label="OBJ source"
            value={state.objText}
            rows={7}
            placeholder={'# paste OBJ here (v / vn / f)\n# blank = a demo cube'}
            onChange={(v) => set('objText', v)}
            hint="Vertices are auto-centred and scaled to fit; missing normals are recomputed smooth."
          />
        </Panel>
      )}

      <Panel title="Sampling" subtitle="Quality vs. speed">
        <Segmented
          label="Resolution"
          value={String(state.resIndex)}
          onChange={(v) => set('resIndex', parseInt(v, 10))}
          options={RES_PRESETS.map((r, i) => ({ value: String(i), label: r.label }))}
        />
        <Slider
          label="Sample target"
          value={state.spp}
          min={16}
          max={4096}
          step={16}
          onChange={(v) => set('spp', v)}
          format={(v) => `${v} spp`}
          hint="Paths traced per pixel before the render is considered converged."
        />
        <Slider
          label="Max path depth"
          value={state.maxDepth}
          min={1}
          max={24}
          step={1}
          onChange={(v) => set('maxDepth', v)}
          format={(v) => `${v} bounces`}
          hint="Longer paths capture more indirect light (and cost more)."
        />
        <Slider
          label="Roulette start"
          value={state.rrStart}
          min={1}
          max={16}
          step={1}
          onChange={(v) => set('rrStart', v)}
          format={(v) => `bounce ${v}`}
          hint="Russian roulette unbiasedly kills dim paths after this depth."
        />
        <Slider
          label="Firefly clamp"
          value={state.clampIndirect}
          min={0}
          max={50}
          step={1}
          onChange={(v) => set('clampIndirect', v)}
          format={(v) => (v === 0 ? 'off' : v.toFixed(0))}
          hint="Clamps bright indirect spikes (slightly biased; 0 disables)."
        />
        <Slider
          label="Aperture (depth of field)"
          value={state.aperture}
          min={0}
          max={0.6}
          step={0.01}
          onChange={(v) => set('aperture', v)}
          format={(v) => v.toFixed(2)}
          hint="Lens radius. 0 is a pinhole; larger blurs out-of-focus depths."
        />
        <Toggle
          label="Adaptive sampling"
          value={state.adaptive}
          onChange={(v) => set('adaptive', v)}
          hint="Stop sampling bands once their estimated noise drops below the target — clean regions finish early."
        />
        {state.adaptive && (
          <Slider
            label="Noise target"
            value={state.adaptiveThreshold}
            min={0.005}
            max={0.1}
            step={0.005}
            onChange={(v) => set('adaptiveThreshold', v)}
            format={(v) => `${(v * 100).toFixed(1)}%`}
            hint="Relative-error threshold below which a region is considered converged."
          />
        )}
      </Panel>

      <Panel title="Display" subtitle="Applied live — no re-render">
        <Toggle
          label="Noise heatmap"
          value={state.showNoise}
          onChange={(v) => set('showNoise', v)}
          hint="Visualise per-pixel Monte-Carlo noise (relative error): dark = converged, bright = noisy."
        />
        <Slider
          label="Exposure"
          value={state.exposure}
          min={-4}
          max={4}
          step={0.1}
          onChange={(v) => set('exposure', v)}
          format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} EV`}
        />
        <Segmented<ToneMapping>
          label="Tone mapping"
          value={state.tonemap}
          onChange={(v) => set('tonemap', v)}
          options={[
            { value: 'aces', label: 'ACES' },
            { value: 'filmic', label: 'Filmic' },
            { value: 'reinhard', label: 'Reinhard' },
            { value: 'linear', label: 'Linear' },
          ]}
        />
        <Toggle
          label="À-Trous denoiser"
          value={state.denoiseEnabled}
          onChange={(v) => set('denoiseEnabled', v)}
          hint="Edge-avoiding wavelet filter guided by the albedo/normal G-buffer."
        />
        {state.denoiseEnabled && (
          <>
            <Slider
              label="Denoise passes"
              value={state.denoiseIterations}
              min={1}
              max={6}
              step={1}
              onChange={(v) => set('denoiseIterations', v)}
            />
            <Slider
              label="Denoise strength"
              value={state.denoiseSigma}
              min={0.05}
              max={2}
              step={0.05}
              onChange={(v) => set('denoiseSigma', v)}
              format={(v) => v.toFixed(2)}
            />
          </>
        )}
      </Panel>

      <div className="action-row">
        {running ? (
          <button className="btn warn" type="button" onClick={onStop}>
            ◼ Stop
          </button>
        ) : (
          <button className="btn primary" type="button" onClick={onRender}>
            ▶ Render
          </button>
        )}
        <button className="btn" type="button" onClick={onRender} title="Restart accumulation">
          ⟳ Restart
        </button>
        <button className="btn" type="button" onClick={onSave} title="Save PNG">
          ⤓ Save
        </button>
      </div>
    </div>
  )
}
