// The Gamut studio. Color you can *describe* in Oklch is often more saturated than a screen can
// actually show — it falls outside the sRGB gamut. This page makes that visible: an Oklch L–C
// slice for a chosen hue, with the sRGB boundary drawn, every stop plotted and flagged, and a
// live comparison of the two ways to bring a color back in (channel clip vs CSS Color 4 chroma
// reduction). It also reports the perceptual distance (ΔE) between adjacent stops and names them.

import { useEffect, useMemo, useRef, useState } from 'react'
import { isOutOfGamut, oklchToRgb, rgbToOklch, rgbaToCss, round } from '../color/convert'
import { difference, METRIC_BLURB, METRIC_LABELS } from '../color/difference'
import type { DiffMetric } from '../color/difference'
import { gamutSlice, maxChromaForLh } from '../color/gamut'
import { outOfGamutFraction, ramp, sortedStops } from '../color/interpolate'
import { nearestNamedColor } from '../color/names'
import type { Gradient } from '../color/types'

const C_MAX = 0.4 // x-axis extent in Oklch chroma (sRGB tops out well below this)
const W = 340
const H = 300

const METRICS: DiffMetric[] = ['de2000', 'deok', 'de94', 'de76']

export function Gamut({ gradient, setGradient }: { gradient: Gradient; setGradient: (g: Gradient) => void }) {
  const stops = sortedStops(gradient.stops)
  const [hue, setHue] = useState(() => Math.round(rgbToOklch(stops[0]?.color ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 }).h))
  const [metric, setMetric] = useState<DiffMetric>('de2000')
  const [selIdx, setSelIdx] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Paint the L–C slice: each pixel is an Oklch color at this hue; out-of-gamut regions are dark.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(W, H)
    const d = img.data
    for (let py = 0; py < H; py++) {
      const L = 1 - py / (H - 1)
      for (let px = 0; px < W; px++) {
        const C = (px / (W - 1)) * C_MAX
        const rgb = oklchToRgb({ L, C, h: hue })
        const o = (py * W + px) * 4
        if (isOutOfGamut(rgb)) {
          // checkerboard "no man's land"
          const v = ((px >> 3) + (py >> 3)) & 1 ? 22 : 14
          d[o] = v
          d[o + 1] = v
          d[o + 2] = v + 4
          d[o + 3] = 255
        } else {
          d[o] = rgb.r * 255
          d[o + 1] = rgb.g * 255
          d[o + 2] = rgb.b * 255
          d[o + 3] = 255
        }
      }
    }
    ctx.putImageData(img, 0, 0)

    // boundary curve
    const slice = gamutSlice(hue, 160)
    ctx.beginPath()
    slice.forEach((pt, i) => {
      const x = (pt.C / C_MAX) * (W - 1)
      const y = (1 - pt.L) * (H - 1)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [hue])

  const toXY = (L: number, C: number) => ({
    x: (Math.min(C, C_MAX) / C_MAX) * 100,
    y: (1 - L) * 100,
  })

  const pairs = stops.slice(0, -1).map((s, i) => ({ a: s, b: stops[i + 1], i }))
  const selected = stops[Math.min(selIdx, stops.length - 1)] ?? stops[0]
  const named = selected ? nearestNamedColor(selected.color) : null
  const gamutMode = gradient.gamut ?? 'clip'

  // What actually matters: how much of the *interpolated* gradient strays off-screen.
  const oogPct = useMemo(() => Math.round(outOfGamutFraction(gradient) * 100), [gradient])
  const clipRamp = useMemo(() => ramp({ ...gradient, gamut: 'clip' }, 48).map(rgbaToCss), [gradient])
  const mapRamp = useMemo(() => ramp({ ...gradient, gamut: 'map' }, 48).map(rgbaToCss), [gradient])

  return (
    <div className="gamut-page">
      <div className="gamut-main">
        <section className="card">
          <h3>Oklch gamut slice · hue {Math.round(hue)}°</h3>
          <p className="muted small">
            Lightness (vertical) × chroma (horizontal) at a fixed hue. The white line is the sRGB
            boundary — color past it can be named but not shown. Stops at this hue sit on the slice.
          </p>
          <div className="gamut-stage">
            <canvas ref={canvasRef} width={W} height={H} className="gamut-canvas" />
            {stops.map((s, i) => {
              const lch = rgbToOklch(s.color)
              const { x, y } = toXY(lch.L, lch.C)
              const hueDelta = Math.min(Math.abs(lch.h - hue), 360 - Math.abs(lch.h - hue))
              const near = hueDelta < 12
              const oog = isOutOfGamut(stopOklchRgb(s.color))
              return (
                <button
                  key={s.id}
                  className={`gamut-stop${i === selIdx ? ' is-selected' : ''}${near ? ' is-near' : ''}`}
                  style={{ left: `${x}%`, top: `${y}%`, background: rgbaToCss(s.color), opacity: near ? 1 : 0.45 }}
                  onClick={() => {
                    setSelIdx(i)
                    setHue(Math.round(lch.h))
                  }}
                  title={`stop ${i + 1} · Δhue ${Math.round(hueDelta)}°${oog ? ' · out of gamut' : ''}`}
                >
                  {oog && <span className="oog-mark">!</span>}
                </button>
              )
            })}
          </div>
          <label className="ctrl wide">
            <span>Hue</span>
            <input type="range" min={0} max={360} value={hue} onChange={(e) => setHue(Number(e.target.value))} />
            <b>{Math.round(hue)}°</b>
          </label>
          <div className="hue-chips">
            {stops.map((s, i) => (
              <button key={s.id} className="hue-chip" style={{ background: rgbaToCss(s.color) }} onClick={() => setHue(Math.round(rgbToOklch(s.color).h))} title={`go to stop ${i + 1}'s hue`} />
            ))}
          </div>
        </section>

        <div className="gamut-side">
          <section className="card">
            <h3>Out-of-gamut handling</h3>
            <p className="muted small">
              {oogPct === 0
                ? 'This gradient interpolates entirely inside sRGB.'
                : `~${oogPct}% of this gradient's interpolated colors land outside sRGB.`}{' '}
              Choose how to recover them:
            </p>
            <div className="seg" role="group" aria-label="Gamut mode">
              <button className={gamutMode === 'clip' ? 'is-active' : ''} onClick={() => setGradient({ ...gradient, gamut: 'clip' })}>
                Clip channels
              </button>
              <button className={gamutMode === 'map' ? 'is-active' : ''} onClick={() => setGradient({ ...gradient, gamut: 'map' })}>
                Map chroma (CSS 4)
              </button>
            </div>
            <p className="muted small">
              {gamutMode === 'clip'
                ? 'Clamp each RGB channel to [0,1]. Fast, but can shift hue and crush detail.'
                : 'Reduce Oklch chroma until the clipped result is within a just-noticeable ΔE — hue-preserving.'}
            </p>
            <div className="ramp-compare">
              <span className="ramp-label">Clip</span>
              <span className="ramp-strip">{clipRamp.map((c, i) => (<span key={i} style={{ background: c }} />))}</span>
              <span className="ramp-label">Map</span>
              <span className="ramp-strip">{mapRamp.map((c, i) => (<span key={i} style={{ background: c }} />))}</span>
            </div>
          </section>

          <section className="card">
            <h3>Selected stop</h3>
            {selected && named ? (
              <div className="named">
                <span className="named-swatch" style={{ background: rgbaToCss(selected.color) }} />
                <div>
                  <div className="named-name">
                    nearest name: <b>{named.name}</b>
                  </div>
                  <div className="muted small">
                    ΔE₀₀ {round(named.delta, 2)} · oklch({round(rgbToOklch(selected.color).L * 100, 1)}% {round(rgbToOklch(selected.color).C, 3)}{' '}
                    {round(rgbToOklch(selected.color).h, 1)})
                  </div>
                  <div className="muted small">max chroma here: {round(maxChromaForLh(rgbToOklch(selected.color).L, rgbToOklch(selected.color).h), 3)}</div>
                </div>
              </div>
            ) : (
              <p className="muted">No stop.</p>
            )}
            <div className="stop-swatches">
              {stops.map((s, i) => (
                <button
                  key={s.id}
                  className={`swatch${i === selIdx ? ' is-selected' : ''}`}
                  style={{ background: rgbaToCss(s.color) }}
                  onClick={() => setSelIdx(i)}
                  title={`stop ${i + 1}`}
                />
              ))}
            </div>
          </section>
        </div>
      </div>

      <section className="card">
        <h3>Perceptual distance between adjacent stops</h3>
        <div className="metric-seg seg" role="group" aria-label="Difference metric">
          {METRICS.map((m) => (
            <button key={m} className={m === metric ? 'is-active' : ''} onClick={() => setMetric(m)}>
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
        <p className="muted small">{METRIC_BLURB[metric]}</p>
        <div className="de-rows">
          {pairs.map(({ a, b, i }) => {
            const de = difference(a.color, b.color, metric)
            // Scale a bar: ΔE of ~50 spans the row for the Lab-based metrics; ΔEOK is ~0..0.4.
            const max = metric === 'deok' ? 0.4 : 50
            const w = Math.min(100, (de / max) * 100)
            return (
              <div className="de-row" key={i}>
                <span className="de-pair">
                  <span className="dot" style={{ background: rgbaToCss(a.color) }} />
                  <span className="dot" style={{ background: rgbaToCss(b.color) }} />
                </span>
                <span className="de-bar">
                  <span className="de-fill" style={{ width: `${w}%` }} />
                </span>
                <b className="de-num">{round(de, metric === 'deok' ? 3 : 2)}</b>
              </div>
            )
          })}
          {pairs.length === 0 && <p className="muted">Add a second stop to compare.</p>}
        </div>
      </section>
    </div>
  )
}

// the stop's sRGB re-derived from its Oklch (kept for the boundary check on plotted dots).
function stopOklchRgb(color: { r: number; g: number; b: number }) {
  return oklchToRgb(rgbToOklch(color))
}
