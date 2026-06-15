// The main studio. Holds the editable gradient (lifted into App so it survives navigation) and
// wires the preview, stop rail, color picker, the space-comparison strip, the contrast / CVD
// read-outs, and export together.

import { useCallback, useRef, useState } from 'react'
import { rgbaToCss } from '../color/convert'
import { sortedStops } from '../color/interpolate'
import { toCSS } from '../color/gradient'
import { museGradient } from '../color/random'
import { SPACE_BLURB, SPACE_LABELS } from '../color/types'
import type { Gradient, GradientType, HueMode, InterpSpace, RGBA, Stop } from '../color/types'
import { randomSeed, loadGallery, saveGallery, encodeGradient } from '../state/store'
import { ColorPicker } from './ColorPicker'
import { ComparisonStrip } from './ComparisonStrip'
import { ContrastPanel } from './ContrastPanel'
import { CvdPanel } from './CvdPanel'
import { ExportPanel } from './ExportPanel'
import { StopTrack } from './StopTrack'

const TYPES: GradientType[] = ['linear', 'radial', 'conic']
const HUE_MODES: HueMode[] = ['shorter', 'longer', 'increasing', 'decreasing']
const CYLINDRICAL: InterpSpace[] = ['oklch', 'lch', 'hsl']

export function Studio({ gradient, setGradient }: { gradient: Gradient; setGradient: (g: Gradient) => void }) {
  const [rawSelectedId, setSelectedId] = useState<string | null>(gradient.stops[0]?.id ?? null)
  const [saved, setSaved] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)

  // Derive a valid selection rather than correcting it in an effect: if the selected stop went
  // away (deleted, or the whole gradient was replaced) fall back to the first stop.
  const selectedId = gradient.stops.some((s) => s.id === rawSelectedId)
    ? rawSelectedId
    : (sortedStops(gradient.stops)[0]?.id ?? null)

  const patch = useCallback((p: Partial<Gradient>) => setGradient({ ...gradient, ...p }), [gradient, setGradient])
  const setStops = useCallback((stops: Stop[]) => setGradient({ ...gradient, stops }), [gradient, setGradient])

  const selected = gradient.stops.find((s) => s.id === selectedId) ?? null
  const setSelectedColor = (color: RGBA) => setStops(gradient.stops.map((s) => (s.id === selectedId ? { ...s, color } : s)))

  const reverse = () => setStops(gradient.stops.map((s) => ({ ...s, pos: 1 - s.pos })))
  const distribute = () => {
    const order = sortedStops(gradient.stops)
    const n = order.length
    const remap = new Map(order.map((s, i) => [s.id, n === 1 ? 0 : i / (n - 1)]))
    setStops(gradient.stops.map((s) => ({ ...s, pos: remap.get(s.id) ?? s.pos })))
  }
  const muse = () => {
    const g = museGradient(randomSeed())
    setGradient(g)
    setSelectedId(g.stops[0].id)
  }
  const saveToGallery = () => {
    const items = loadGallery()
    saveGallery([{ id: `g${Date.now().toString(36)}`, code: encodeGradient(gradient), createdAt: Date.now() }, ...items])
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const setCenterFromEvent = (e: React.PointerEvent) => {
    if (gradient.type === 'linear') return
    const el = previewRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    patch({
      cx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      cy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    })
  }

  const isCylindrical = CYLINDRICAL.includes(gradient.space)

  return (
    <div className="studio">
      <div
        className="preview"
        ref={previewRef}
        style={{ background: toCSS(gradient) }}
        onPointerDown={(e) => {
          if (gradient.type !== 'linear') {
            ;(e.target as Element).setPointerCapture?.(e.pointerId)
            setCenterFromEvent(e)
          }
        }}
        onPointerMove={(e) => e.buttons === 1 && setCenterFromEvent(e)}
      >
        {gradient.type !== 'linear' && (
          <span className="center-dot" style={{ left: `${gradient.cx * 100}%`, top: `${gradient.cy * 100}%` }} />
        )}
        <div className="preview-tag">{gradient.type} · {SPACE_LABELS[gradient.space]}</div>
      </div>

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Gradient type">
          {TYPES.map((t) => (
            <button key={t} className={t === gradient.type ? 'is-active' : ''} onClick={() => patch({ type: t })}>
              {t}
            </button>
          ))}
        </div>

        {gradient.type !== 'radial' && (
          <label className="ctrl">
            <span>Angle</span>
            <input type="range" min={0} max={360} value={gradient.angle} onChange={(e) => patch({ angle: Number(e.target.value) })} />
            <b>{Math.round(gradient.angle)}°</b>
          </label>
        )}

        <label className="ctrl">
          <span>Space</span>
          <select value={gradient.space} onChange={(e) => patch({ space: e.target.value as InterpSpace })}>
            {(Object.keys(SPACE_LABELS) as InterpSpace[]).map((s) => (
              <option key={s} value={s}>
                {SPACE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        {isCylindrical && (
          <label className="ctrl">
            <span>Hue</span>
            <select value={gradient.hue} onChange={(e) => patch({ hue: e.target.value as HueMode })}>
              {HUE_MODES.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="toolbar-spacer" />
        <button className="btn ghost" onClick={reverse} title="Reverse stop order">
          ⇄ Reverse
        </button>
        <button className="btn ghost" onClick={distribute} title="Space stops evenly">
          ⇉ Distribute
        </button>
        <button className="btn ghost" onClick={saveToGallery}>
          {saved ? 'Saved ✓' : '☆ Save'}
        </button>
        <button className="btn" onClick={muse}>
          ✦ Muse
        </button>
      </div>

      <p className="space-blurb">{SPACE_BLURB[gradient.space]}</p>

      <StopTrack gradient={gradient} selectedId={selectedId} onSelect={setSelectedId} onStops={setStops} />

      <div className="studio-grid">
        <section className="card">
          <h3>Selected stop</h3>
          {selected ? (
            <>
              <ColorPicker value={selected.color} onChange={setSelectedColor} />
              <label className="ctrl wide">
                <span>Position</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={selected.pos}
                  onChange={(e) => setStops(gradient.stops.map((s) => (s.id === selectedId ? { ...s, pos: Number(e.target.value) } : s)))}
                />
                <b>{Math.round(selected.pos * 100)}%</b>
              </label>
              <div className="stop-swatches">
                {sortedStops(gradient.stops).map((s) => (
                  <button
                    key={s.id}
                    className={`swatch${s.id === selectedId ? ' is-selected' : ''}`}
                    style={{ background: rgbaToCss(s.color) }}
                    onClick={() => setSelectedId(s.id)}
                    title={`${Math.round(s.pos * 100)}%`}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="muted">No stop selected.</p>
          )}
        </section>

        <section className="card">
          <h3>Interpolation space</h3>
          <p className="muted small">Same stops, every space. Click to adopt.</p>
          <ComparisonStrip gradient={gradient} onPick={(s) => patch({ space: s })} />
        </section>

        <section className="card">
          <h3>Contrast</h3>
          <ContrastPanel gradient={gradient} />
        </section>

        <section className="card">
          <h3>Color-vision preview</h3>
          <CvdPanel gradient={gradient} />
        </section>

        <section className="card span-2">
          <h3>Export</h3>
          <ExportPanel gradient={gradient} />
        </section>
      </div>
    </div>
  )
}
