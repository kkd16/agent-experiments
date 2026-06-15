// Palette studio. Spin harmonies off a base color (rotated in Oklch so they stay balanced), or
// extract a palette from an uploaded image via k-means in Oklab. Any palette can be turned into a
// gradient and sent straight to the studio.

import { useRef, useState } from 'react'
import { rgbaToCss, rgbaToHex } from '../color/convert'
import { extractPalette } from '../color/extract'
import { HARMONY_LABELS, harmony } from '../color/harmony'
import type { HarmonyKind } from '../color/harmony'
import { makeStopId } from '../color/random'
import type { Gradient, RGBA } from '../color/types'
import { navigate } from '../state/router'
import { ColorPicker } from './ColorPicker'

const KINDS: HarmonyKind[] = ['complementary', 'analogous', 'triadic', 'tetradic', 'split', 'monochrome']

function gradientFromColors(colors: RGBA[]): Gradient {
  const n = Math.max(2, colors.length)
  const stops = colors.map((color, i) => ({ id: makeStopId(), color, pos: n === 1 ? 0 : i / (n - 1) }))
  return { type: 'linear', angle: 90, cx: 0.5, cy: 0.5, space: 'oklch', hue: 'shorter', stops }
}

function Swatches({ colors, onUse }: { colors: RGBA[]; onUse: (g: Gradient) => void }) {
  if (colors.length === 0) return null
  return (
    <div className="pal-result">
      <div className="pal-swatches">
        {colors.map((c, i) => (
          <div className="pal-swatch" key={i} style={{ background: rgbaToCss(c) }}>
            <span>{rgbaToHex({ ...c, a: 1 })}</span>
          </div>
        ))}
      </div>
      <div className="pal-bar" style={{ background: `linear-gradient(90deg, ${colors.map(rgbaToCss).join(', ')})` }} />
      <button
        className="btn"
        onClick={() => {
          onUse(gradientFromColors(colors))
          navigate('studio')
        }}
      >
        → Use as gradient
      </button>
    </div>
  )
}

export function Palette({ onUse }: { onUse: (g: Gradient) => void }) {
  const [base, setBase] = useState<RGBA>({ r: 0.23, g: 0.51, b: 0.96, a: 1 })
  const [kind, setKind] = useState<HarmonyKind>('triadic')
  const [extracted, setExtracted] = useState<RGBA[]>([])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const palette = harmony(base, kind)

  const onFile = (file: File) => {
    setBusy(true)
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, 200 / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h)
          const data = ctx.getImageData(0, 0, w, h)
          setExtracted(extractPalette(data, 6))
        }
      } catch {
        /* ignore */
      }
      setBusy(false)
      URL.revokeObjectURL(img.src)
    }
    img.onerror = () => setBusy(false)
    img.src = URL.createObjectURL(file)
  }

  return (
    <div className="palette-page">
      <div className="palette-grid">
        <section className="card">
          <h3>Harmonies</h3>
          <p className="muted small">Rotated in Oklch — balanced lightness &amp; chroma.</p>
          <ColorPicker value={base} onChange={setBase} />
          <div className="harmony-kinds">
            {KINDS.map((k) => (
              <button key={k} className={`chip${k === kind ? ' is-active' : ''}`} onClick={() => setKind(k)}>
                {HARMONY_LABELS[k]}
              </button>
            ))}
          </div>
          <Swatches colors={palette} onUse={onUse} />
        </section>

        <section className="card">
          <h3>Extract from image</h3>
          <p className="muted small">k-means clustering in Oklab — perceptual dominant colors.</p>
          <div className="dropzone" onClick={() => fileRef.current?.click()}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
              }}
            />
            {busy ? <span>Clustering…</span> : <span>Click to choose an image</span>}
          </div>
          <Swatches colors={extracted} onUse={onUse} />
        </section>
      </div>
    </div>
  )
}
