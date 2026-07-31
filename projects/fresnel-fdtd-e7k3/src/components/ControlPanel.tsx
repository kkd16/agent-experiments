import type { SimController, SimParams, SimStats, DisplayMode } from '../hooks/useSimulation';
import type { ToolState, Tool } from './types';
import type { SourceKind, BoundaryMode } from '../sim/FDTD';
import { Section, Slider, Segmented } from './ui';
import { BRUSH_MATERIALS, isDispersiveBrush } from '../sim/materials';
import { MaterialEpsChart } from './MaterialEpsChart';
import { PRESETS } from '../sim/presets';
import { COLORMAP_NAMES, COLORMAP_LABELS, type ColormapName } from '../sim/colormaps';

interface Props {
  params: SimParams;
  setParams: React.Dispatch<React.SetStateAction<SimParams>>;
  tool: ToolState;
  setTool: React.Dispatch<React.SetStateAction<ToolState>>;
  controller: SimController;
  stats: SimStats;
  onSnapshot: () => void;
  onStructureChange: () => void;
}

const TOOL_OPTS: { value: Tool; label: string; title: string }[] = [
  { value: 'source', label: 'Source', title: 'Click the field to drop a wave source' },
  { value: 'paint', label: 'Paint', title: 'Drag to paint the selected material' },
  { value: 'probe', label: 'Probe', title: 'Click to place an oscilloscope probe' },
  { value: 'erase', label: 'Erase', title: 'Drag to clear materials, sources & probes' },
];

const SOURCE_OPTS: { value: SourceKind; label: string }[] = [
  { value: 'sine', label: 'Sine' },
  { value: 'gaussian', label: 'Pulse' },
  { value: 'ricker', label: 'Ricker' },
];

const VIEW_OPTS: { value: DisplayMode; label: string; title: string }[] = [
  { value: 'field', label: 'Field', title: 'Instantaneous signed Ez field' },
  { value: 'intensity', label: 'Intensity', title: 'Time-averaged ⟨Ez²⟩ — a long exposure' },
  { value: 'flux', label: 'Flux', title: 'Time-averaged Poynting energy flux ⟨S⟩ = ⟨E×H⟩' },
];

const BOUNDARY_OPTS: { value: BoundaryMode; label: string; title: string }[] = [
  { value: 'cpml', label: 'CPML', title: 'Convolutional PML — near-zero reflection (~−70 dB)' },
  { value: 'sponge', label: 'Sponge', title: 'Graded lossy layer — cheap, a few % reflection' },
];

export function ControlPanel({
  params,
  setParams,
  tool,
  setTool,
  controller,
  stats,
  onSnapshot,
  onStructureChange,
}: Props) {
  const set = <K extends keyof SimParams>(k: K, v: SimParams[K]) =>
    setParams((p) => ({ ...p, [k]: v }));
  const setT = <K extends keyof ToolState>(k: K, v: ToolState[K]) =>
    setTool((t) => ({ ...t, [k]: v }));

  return (
    <div className="panel">
      <Section title="Presets">
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className="preset-btn"
              title={p.blurb}
              onClick={() => {
                controller.loadPreset(p.key);
                onStructureChange();
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Tool">
        <Segmented options={TOOL_OPTS} value={tool.tool} onChange={(v) => setT('tool', v)} />
        <p className="hint">{TOOL_OPTS.find((o) => o.value === tool.tool)?.title}</p>
      </Section>

      {tool.tool === 'source' && (
        <Section title="Source">
          <Segmented options={SOURCE_OPTS} value={tool.sourceKind} onChange={(v) => setT('sourceKind', v)} />
          <Slider
            label="Wavelength"
            value={tool.sourceWavelength}
            min={6}
            max={40}
            step={1}
            onChange={(v) => setT('sourceWavelength', v)}
            format={(v) => `${v} cells`}
          />
          <Slider
            label="Amplitude"
            value={tool.sourceAmplitude}
            min={0.1}
            max={2}
            step={0.1}
            onChange={(v) => setT('sourceAmplitude', v)}
            format={(v) => v.toFixed(1)}
          />
        </Section>
      )}

      {(tool.tool === 'paint' || tool.tool === 'erase') && (
        <Section title="Material">
          <div className="swatches">
            {BRUSH_MATERIALS.map((m) => (
              <button
                key={m.key}
                type="button"
                className={'swatch' + (tool.brushKey === m.key ? ' is-active' : '')}
                onClick={() => setT('brushKey', m.key)}
                title={m.label}
              >
                <span className="swatch__chip" style={{ background: m.swatch }} />
                <span className="swatch__label">{m.label}</span>
              </button>
            ))}
          </div>
          <Slider
            label="Brush size"
            value={tool.brushSize}
            min={1}
            max={30}
            step={1}
            onChange={(v) => setT('brushSize', v)}
            format={(v) => `${v} cells`}
          />
          {isDispersiveBrush(tool.brushKey) && (
            <>
              <MaterialEpsChart brushKey={tool.brushKey} />
              <p className="hint">
                Frequency-dispersive metal. Where Re ε &lt; 0 it reflects; near ε = −1 it carries a
                surface plasmon; at ε = 0 the wavelength inside diverges (ε-near-zero).
              </p>
            </>
          )}
        </Section>
      )}

      <Section title="Simulation">
        <div className="btn-row">
          <button type="button" className="btn btn--primary" onClick={() => set('running', !params.running)}>
            {params.running ? '❚❚ Pause' : '► Run'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              set('running', false);
              controller.stepOnce();
            }}
          >
            Step
          </button>
          <button type="button" className="btn" onClick={() => controller.resetFields()}>
            Clear field
          </button>
        </div>
        <button
          type="button"
          className="btn btn--wide"
          onClick={() => {
            controller.reset();
            onStructureChange();
          }}
        >
          Reset everything
        </button>
        <Slider
          label="Speed"
          value={params.substeps}
          min={1}
          max={10}
          step={1}
          onChange={(v) => set('substeps', v)}
          format={(v) => `${v}×`}
        />
      </Section>

      <Section title="Boundary">
        <Segmented
          options={BOUNDARY_OPTS}
          value={params.boundary}
          onChange={(v) => set('boundary', v)}
        />
        <p className="hint">{BOUNDARY_OPTS.find((o) => o.value === params.boundary)?.title}</p>
      </Section>

      <Section title="Display">
        <Segmented options={VIEW_OPTS} value={params.displayMode} onChange={(v) => set('displayMode', v)} />
        {params.displayMode !== 'field' && (
          <button type="button" className="btn btn--wide" onClick={() => controller.resetExposure()}>
            ↻ Reset {params.displayMode === 'flux' ? 'flux average' : 'exposure'}
          </button>
        )}
        {params.displayMode === 'flux' && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={params.showArrows}
              onChange={(e) => set('showArrows', e.target.checked)}
            />
            <span>Flow arrows</span>
          </label>
        )}
        <label className="select-row">
          <span>Colormap</span>
          <select value={params.colormap} onChange={(e) => set('colormap', e.target.value as ColormapName)}>
            {COLORMAP_NAMES.map((c) => (
              <option key={c} value={c}>
                {COLORMAP_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <Slider
          label="Gain"
          value={params.gain}
          min={0.2}
          max={6}
          step={0.1}
          onChange={(v) => set('gain', v)}
          format={(v) => `${v.toFixed(1)}×`}
        />
        <Slider
          label="Material overlay"
          value={params.matOverlay}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => set('matOverlay', v)}
          format={(v) => `${Math.round(v * 100)}%`}
        />
        <button type="button" className="btn btn--wide" onClick={onSnapshot}>
          ⤓ Save PNG
        </button>
      </Section>

      <Section title="Readout">
        <div className="readout">
          <div>
            <span className="readout__k">Step</span>
            <span className="readout__v">{stats.step.toLocaleString()}</span>
          </div>
          <div>
            <span className="readout__k">FPS</span>
            <span className="readout__v">{stats.fps.toFixed(0)}</span>
          </div>
          <div>
            <span className="readout__k">Energy</span>
            <span className="readout__v">{formatEnergy(stats.energy)}</span>
          </div>
        </div>
      </Section>
    </div>
  );
}

function formatEnergy(e: number): string {
  if (e >= 1e6) return (e / 1e6).toFixed(2) + 'M';
  if (e >= 1e3) return (e / 1e3).toFixed(2) + 'k';
  return e.toFixed(1);
}
