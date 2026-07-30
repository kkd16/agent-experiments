// Top bar: brand, preset launcher, and the global actions (view GLSL, help, reset).

import { PRESETS } from '../scene/presets'
import type { Scene } from '../scene/types'

interface ToolbarProps {
  onLoadPreset: (build: () => Scene) => void
  onReset: () => void
  onShowGlsl: () => void
  onShowHelp: () => void
  onExport: () => void
  onCapture: () => void
  onExportJson: () => void
  onImportJson: () => void
  saved: boolean
}

export default function Toolbar({
  onLoadPreset,
  onReset,
  onShowGlsl,
  onShowHelp,
  onExport,
  onCapture,
  onExportJson,
  onImportJson,
  saved,
}: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>◈</span>
        <span className="brand-name">Marcher</span>
        <span className="brand-sub">SDF Ray Marching Studio</span>
      </div>

      <div className="presets">
        <span className="presets-label">Presets</span>
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => onLoadPreset(p.build)}>
            {p.name}
          </button>
        ))}
      </div>

      <div className="toolbar-actions">
        <span className={`save-dot ${saved ? 'ok' : ''}`} title={saved ? 'Autosaved' : 'Saving…'}>
          {saved ? 'saved' : 'saving…'}
        </span>
        <button type="button" onClick={onImportJson} title="Load a scene from a JSON file (O)">
          Load
        </button>
        <button type="button" onClick={onExportJson} title="Save the scene to a JSON file (S)">
          Save
        </button>
        <button type="button" onClick={onCapture} title="Save the current frame as a PNG (P)">
          PNG
        </button>
        <button type="button" onClick={onExport} title="Download a standalone HTML shader toy (E)">
          Export
        </button>
        <button type="button" onClick={onShowGlsl}>
          GLSL
        </button>
        <button type="button" onClick={onShowHelp}>
          Help
        </button>
        <button type="button" className="reset" onClick={onReset}>
          Reset
        </button>
      </div>
    </header>
  )
}
