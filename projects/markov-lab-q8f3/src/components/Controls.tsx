import type { Mode } from '../engine/permalink'
import type { SamplerDef } from '../samplers/types'
import type { Target } from '../targets/targets'

interface Props {
  targets: Target[]
  samplers: SamplerDef[]
  targetId: string
  samplerId: string
  params: Record<string, number>
  seed: number
  burnInFrac: number
  speed: number
  running: boolean
  mode: Mode
  selLane: number
  laneColors: string[]
  laneNames: [string, string]
  showField: boolean
  showTrail: boolean
  showTrajectory: boolean
  showCloud: boolean
  onMode: (m: Mode) => void
  onSelLane: (i: number) => void
  onTarget: (id: string) => void
  onSampler: (id: string) => void
  onParam: (key: string, v: number) => void
  onSeed: () => void
  onBurnIn: (v: number) => void
  onSpeed: (v: number) => void
  onToggleRun: () => void
  onStep: () => void
  onReset: () => void
  onExport: () => void
  onCopyLink: () => void
  copied: boolean
  onToggle: (k: 'showField' | 'showTrail' | 'showTrajectory' | 'showCloud') => void
}

export default function Controls(p: Props) {
  const sampler = p.samplers.find((s) => s.id === p.samplerId)!
  const target = p.targets.find((t) => t.id === p.targetId)!

  return (
    <aside className="controls">
      <div className="brand">
        <span className="brand-mark">∿</span>
        <div>
          <h1>Markov</h1>
          <p className="brand-sub">a Monte-Carlo sampling studio</p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">Mode</div>
        <div className="seg">
          <button
            className={`seg-btn ${p.mode === 'single' ? 'seg-on' : ''}`}
            onClick={() => p.onMode('single')}
          >
            Single
          </button>
          <button
            className={`seg-btn ${p.mode === 'race' ? 'seg-on' : ''}`}
            onClick={() => p.onMode('race')}
            title="Run two samplers side-by-side on the same target & seed"
          >
            Race ⚔
          </button>
        </div>
        {p.mode === 'race' && (
          <p className="blurb">
            Two samplers, one target, one seed — the compare bar under the arena diffs their ESS,
            efficiency and mixing live. Pick which lane to edit below.
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">Target distribution</div>
        <div className="chip-grid">
          {p.targets.map((t) => (
            <button
              key={t.id}
              className={`chip ${t.id === p.targetId ? 'chip-on' : ''}`}
              onClick={() => p.onTarget(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
        <p className="blurb">{target.blurb}</p>
      </section>

      <section className="panel">
        <div className="panel-head">
          {p.mode === 'race' ? `Sampler · editing lane ${p.selLane === 0 ? 'A' : 'B'}` : 'Sampler'}
        </div>
        {p.mode === 'race' && (
          <div className="seg lane-seg">
            {[0, 1].map((i) => (
              <button
                key={i}
                className={`seg-btn ${p.selLane === i ? 'seg-on' : ''}`}
                style={p.selLane === i ? { borderColor: p.laneColors[i], color: p.laneColors[i] } : undefined}
                onClick={() => p.onSelLane(i)}
              >
                <span className="lane-dot" style={{ background: p.laneColors[i] }} />
                {i === 0 ? 'A' : 'B'} · {p.laneNames[i]}
              </button>
            ))}
          </div>
        )}
        <div className="chip-grid">
          {p.samplers.map((s) => (
            <button
              key={s.id}
              className={`chip ${s.id === p.samplerId ? 'chip-on' : ''}`}
              onClick={() => p.onSampler(s.id)}
              title={s.blurb}
            >
              {s.name}
              {s.usesGradient && <span className="grad-badge" title="uses ∇log π">∇</span>}
            </button>
          ))}
        </div>
        <p className="blurb">{sampler.blurb}</p>
      </section>

      <section className="panel">
        <div className="panel-head">Parameters</div>
        {sampler.params.map((spec) => {
          const val = p.params[spec.key] ?? spec.default
          if (spec.toggle) {
            const on = val > 0.5
            return (
              <label className="slider-row" key={spec.key}>
                <span className="slider-label">{spec.label}</span>
                <button
                  className={`toggle param-toggle ${on ? 'toggle-on' : ''}`}
                  onClick={() => p.onParam(spec.key, on ? 0 : 1)}
                >
                  <span className="toggle-dot" />
                  {on ? 'on' : 'off'}
                </button>
                <span className="slider-val">{on ? '✓' : '—'}</span>
              </label>
            )
          }
          const display = spec.integer ? val.toFixed(0) : val.toFixed(spec.log ? 3 : 2)
          return (
            <label className="slider-row" key={spec.key}>
              <span className="slider-label">{spec.label}</span>
              <input
                type="range"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={val}
                onChange={(e) => p.onParam(spec.key, Number(e.target.value))}
              />
              <span className="slider-val">{display}</span>
            </label>
          )
        })}
        <label className="slider-row">
          <span className="slider-label">burn-in</span>
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.02}
            value={p.burnInFrac}
            onChange={(e) => p.onBurnIn(Number(e.target.value))}
          />
          <span className="slider-val">{(p.burnInFrac * 100).toFixed(0)}%</span>
        </label>
        <label className="slider-row">
          <span className="slider-label">speed</span>
          <input
            type="range"
            min={1}
            max={400}
            step={1}
            value={p.speed}
            onChange={(e) => p.onSpeed(Number(e.target.value))}
          />
          <span className="slider-val">{p.speed}/f</span>
        </label>
      </section>

      <section className="panel">
        <div className="btn-row">
          <button className={`btn btn-primary ${p.running ? 'btn-run' : ''}`} onClick={p.onToggleRun}>
            {p.running ? '❚❚ Pause' : '▶ Run'}
          </button>
          <button className="btn" onClick={p.onStep} disabled={p.running}>
            Step
          </button>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={p.onReset}>
            ↺ Reset
          </button>
          <button className="btn" onClick={p.onSeed}>
            ⚄ Reseed ({p.seed % 1000})
          </button>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={p.onExport} title="download the chain as CSV">
            ⭳ Export {p.mode === 'race' ? `lane ${p.selLane === 0 ? 'A' : 'B'} ` : ''}CSV
          </button>
          <button
            className={`btn ${p.copied ? 'btn-ok' : ''}`}
            onClick={p.onCopyLink}
            title="copy a shareable link that restores this exact configuration"
          >
            {p.copied ? '✓ Copied' : '🔗 Copy link'}
          </button>
        </div>
        <div className="toggle-row">
          <Toggle on={p.showField} label="density" onClick={() => p.onToggle('showField')} />
          <Toggle on={p.showCloud} label="cloud" onClick={() => p.onToggle('showCloud')} />
          <Toggle on={p.showTrail} label="trail" onClick={() => p.onToggle('showTrail')} />
          <Toggle
            on={p.showTrajectory}
            label="paths"
            onClick={() => p.onToggle('showTrajectory')}
          />
        </div>
      </section>
    </aside>
  )
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button className={`toggle ${on ? 'toggle-on' : ''}`} onClick={onClick}>
      <span className="toggle-dot" />
      {label}
    </button>
  )
}
