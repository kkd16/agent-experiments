import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  defaultParams,
  randomParams,
  samplePath,
  type HarmonographParams,
  type Pendulum,
} from './harmonograph'
import { THEMES } from './themes'
import { PRESETS } from './presets'
import { drawCanvas, toSvg } from './render'

const SIZE = 720

type PendKey = 'x1' | 'x2' | 'y1' | 'y2'
const PEND_KEYS: PendKey[] = ['x1', 'x2', 'y1', 'y2']

export default function App() {
  const [params, setParams] = useState<HarmonographParams>(defaultParams)
  const [themeId, setThemeId] = useState(THEMES[0].id)
  const [lineWidth, setLineWidth] = useState(1.1)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const theme = useMemo(
    () => THEMES.find((t) => t.id === themeId) ?? THEMES[0],
    [themeId],
  )
  const points = useMemo(() => samplePath(params), [params])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    drawCanvas(ctx, points, theme, SIZE, lineWidth)
  }, [points, theme, lineWidth])

  function updatePendulum(key: PendKey, field: keyof Pendulum, value: number) {
    setParams((p) => ({ ...p, [key]: { ...p[key], [field]: value } }))
  }

  function downloadSvg() {
    const svg = toSvg(points, theme, SIZE, lineWidth)
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'harmonograph.svg'
    a.click()
    URL.revokeObjectURL(url)
  }

  function downloadPng() {
    const url = canvasRef.current?.toDataURL('image/png')
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = 'harmonograph.png'
    a.click()
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Harmonograph Lab</h1>
          <p className="sub">
            Four damped pendulums swing in interference — tune them into figures
            no plotter could keep drawing forever.
          </p>
        </div>
        <div className="topbar-actions">
          <button className="ghost" onClick={() => setParams(randomParams())}>
            🎲 Randomize
          </button>
          <button className="ghost" onClick={() => setParams(defaultParams())}>
            ↺ Reset
          </button>
        </div>
      </header>

      <div className="stage">
        <div className="canvas-wrap" style={{ background: theme.background }}>
          <canvas
            ref={canvasRef}
            width={SIZE}
            height={SIZE}
            className="canvas"
          />
        </div>

        <aside className="panel">
          <section className="group">
            <div className="group-title">Theme</div>
            <div className="swatches">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`swatch ${t.id === themeId ? 'active' : ''}`}
                  style={{ background: t.background }}
                  title={t.name}
                  onClick={() => setThemeId(t.id)}
                >
                  <span style={{ background: t.stroke[0] }} />
                  <span style={{ background: t.stroke[1] }} />
                  <span style={{ background: t.stroke[2] }} />
                </button>
              ))}
            </div>
          </section>

          <section className="group">
            <div className="group-title">Presets</div>
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  className="preset"
                  onClick={() => setParams(p.params)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </section>

          <section className="group">
            <Slider
              label="Line width"
              value={lineWidth}
              min={0.3}
              max={3}
              step={0.1}
              onChange={setLineWidth}
              fmt={(v) => v.toFixed(1)}
            />
            <Slider
              label="Trace length"
              value={params.duration}
              min={40}
              max={400}
              step={1}
              onChange={(v) => setParams((p) => ({ ...p, duration: v }))}
              fmt={(v) => v.toFixed(0)}
            />
          </section>

          {PEND_KEYS.map((key) => (
            <section className="group" key={key}>
              <div className="group-title">
                Pendulum <span className="tag">{key.toUpperCase()}</span>
              </div>
              <Slider
                label="Frequency"
                value={params[key].freq}
                min={0.5}
                max={6}
                step={0.001}
                onChange={(v) => updatePendulum(key, 'freq', v)}
                fmt={(v) => v.toFixed(2)}
              />
              <Slider
                label="Phase"
                value={params[key].phase}
                min={0}
                max={Math.PI * 2}
                step={0.01}
                onChange={(v) => updatePendulum(key, 'phase', v)}
                fmt={(v) => `${((v / Math.PI) * 180).toFixed(0)}°`}
              />
              <Slider
                label="Amplitude"
                value={params[key].amp}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => updatePendulum(key, 'amp', v)}
                fmt={(v) => v.toFixed(2)}
              />
              <Slider
                label="Damping"
                value={params[key].damp}
                min={0}
                max={0.05}
                step={0.0005}
                onChange={(v) => updatePendulum(key, 'damp', v)}
                fmt={(v) => v.toFixed(4)}
              />
            </section>
          ))}

          <section className="group">
            <div className="export-row">
              <button onClick={downloadSvg}>⬇ SVG</button>
              <button onClick={downloadPng}>⬇ PNG</button>
            </div>
          </section>
        </aside>
      </div>
    </main>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  fmt: (v: number) => string
}

function Slider({ label, value, min, max, step, onChange, fmt }: SliderProps) {
  return (
    <label className="slider">
      <span className="slider-label">
        {label}
        <span className="slider-value">{fmt(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}
