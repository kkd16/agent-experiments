import type { ReactNode } from 'react'
import type { ColorMode, RenderParams } from '../fractal/types'
import { recommendedIter } from '../fractal/useFractalEngine'
import { PALETTES, paletteGradientCss } from '../webgl/palettes'

const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: 'smooth', label: 'Smooth' },
  { id: 'stripe', label: 'Stripe' },
  { id: 'trapPoint', label: 'Trap ·' },
  { id: 'trapCross', label: 'Trap +' },
]

// The feature-frequency slider means different things per colouring mode.
const FREQ_LABEL: Record<ColorMode, string> = {
  smooth: 'Interior detail',
  stripe: 'Stripe density',
  trapPoint: 'Trap scale',
  trapCross: 'Trap scale',
}

type Props = {
  params: RenderParams
  span: number
  setParam: <K extends keyof RenderParams>(key: K, value: RenderParams[K]) => void
  onReset: () => void
  onSeedJulia: () => void
  onExport: () => void
  onShare: () => void
  shareLabel: string
  onSetMode: (mode: 'mandelbrot' | 'julia') => void
  onDive: () => void
  diving: boolean
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      {children}
    </label>
  )
}

export default function ControlPanel({
  params,
  span,
  setParam,
  onReset,
  onSeedJulia,
  onExport,
  onShare,
  shareLabel,
  onSetMode,
  onDive,
  diving,
}: Props) {
  const effectiveIter = params.autoIter ? recommendedIter(span) : params.maxIter

  return (
    <div className="panel">
      <div className="panel-section">
        <div className="seg">
          <button
            className={params.mode === 'mandelbrot' ? 'seg-btn active' : 'seg-btn'}
            onClick={() => onSetMode('mandelbrot')}
          >
            Mandelbrot
          </button>
          <button
            className={params.mode === 'julia' ? 'seg-btn active' : 'seg-btn'}
            onClick={() => onSetMode('julia')}
          >
            Julia
          </button>
        </div>
      </div>

      <div className="panel-section">
        <div className="section-title">Palette</div>
        <div className="palette-grid">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              className={params.paletteId === p.id ? 'swatch active' : 'swatch'}
              title={p.name}
              onClick={() => setParam('paletteId', p.id)}
            >
              <span className="swatch-bar" style={{ background: paletteGradientCss(p) }} />
              <span className="swatch-name">{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel-section">
        <div className="section-title">Colouring</div>
        <div className="mode-grid">
          {COLOR_MODES.map((m) => (
            <button
              key={m.id}
              className={params.colorMode === m.id ? 'mode-btn active' : 'mode-btn'}
              onClick={() => setParam('colorMode', m.id)}
              title={m.label}
            >
              {m.label}
            </button>
          ))}
        </div>
        <Row label={`${FREQ_LABEL[params.colorMode]} ${params.featureFreq.toFixed(1)}`}>
          <input
            type="range"
            min={1}
            max={24}
            step={0.5}
            value={params.featureFreq}
            onChange={(e) => setParam('featureFreq', Number(e.target.value))}
          />
        </Row>
        <Row label="Shade interior">
          <input
            type="checkbox"
            checked={params.interior}
            onChange={(e) => setParam('interior', e.target.checked)}
          />
        </Row>
      </div>

      <div className="panel-section">
        <div className="section-title">Colour</div>
        <Row label={`Density ${params.colorScale.toFixed(3)}`}>
          <input
            type="range"
            min={0.002}
            max={0.15}
            step={0.001}
            value={params.colorScale}
            onChange={(e) => setParam('colorScale', Number(e.target.value))}
          />
        </Row>
        <Row label={`Shift ${params.colorOffset.toFixed(2)}`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={params.colorOffset}
            onChange={(e) => setParam('colorOffset', Number(e.target.value))}
          />
        </Row>
        <Row label={`Animate ${params.cycleSpeed.toFixed(2)}`}>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={params.cycleSpeed}
            onChange={(e) => setParam('cycleSpeed', Number(e.target.value))}
          />
        </Row>
      </div>

      <div className="panel-section">
        <div className="section-title">Detail</div>
        <Row label="Auto iterations">
          <input
            type="checkbox"
            checked={params.autoIter}
            onChange={(e) => setParam('autoIter', e.target.checked)}
          />
        </Row>
        <Row label={`Iterations ${effectiveIter}`}>
          <input
            type="range"
            min={60}
            max={30000}
            step={20}
            value={params.maxIter}
            disabled={params.autoIter}
            onChange={(e) => setParam('maxIter', Number(e.target.value))}
          />
        </Row>
        <Row label={`Anti-alias ${params.aa}×${params.aa}`}>
          <input
            type="range"
            min={1}
            max={3}
            step={1}
            value={params.aa}
            onChange={(e) => setParam('aa', Number(e.target.value))}
          />
        </Row>
      </div>

      <div className="panel-section">
        <div className="section-title">Distance estimation</div>
        <Row label="Outline filaments">
          <input
            type="checkbox"
            checked={params.de}
            onChange={(e) => setParam('de', e.target.checked)}
          />
        </Row>
        <Row label={`Glow ${params.deStrength.toFixed(1)}`}>
          <input
            type="range"
            min={0.5}
            max={12}
            step={0.5}
            value={params.deStrength}
            disabled={!params.de}
            onChange={(e) => setParam('deStrength', Number(e.target.value))}
          />
        </Row>
      </div>

      <div className="panel-section actions">
        <button className={diving ? 'btn active' : 'btn'} onClick={onDive}>
          {diving ? 'Stop dive' : 'Auto dive ▾'}
        </button>
        {params.mode === 'mandelbrot' && (
          <button className="btn" onClick={onSeedJulia}>
            Julia from centre
          </button>
        )}
        <button className="btn" onClick={onExport}>
          Save PNG
        </button>
        <button className="btn" onClick={onShare}>
          {shareLabel}
        </button>
        <button className="btn subtle" onClick={onReset}>
          Reset view
        </button>
      </div>
    </div>
  )
}
