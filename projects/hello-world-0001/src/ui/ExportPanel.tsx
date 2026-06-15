// Export. The CSS we emit is "densified" so the perceptual interpolation survives in plain CSS;
// SVG and PNG likewise. The share link round-trips the whole gradient through the URL hash.

import { useState } from 'react'
import { rgbaToOklchCss } from '../color/convert'
import { paintToCanvas, toCSSDecl, toJSON, toSVG } from '../color/gradient'
import { ramp } from '../color/interpolate'
import { encodeGradient } from '../state/store'
import type { Gradient } from '../color/types'

type Tab = 'css' | 'oklch' | 'svg' | 'json'

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function download(filename: string, data: BlobPart, mime: string) {
  try {
    const blob = new Blob([data], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch {
    /* ignore */
  }
}

/** CSS that bakes the gradient into a many-stop background, ready to paste. */
function oklchCss(g: Gradient): string {
  const cols = ramp(g, g.space === 'srgb' ? g.stops.length : 24)
  const stops = cols.map((c, i) => `${rgbaToOklchCss(c)} ${Math.round((i / (cols.length - 1)) * 1000) / 10}%`).join(',\n    ')
  const head =
    g.type === 'linear'
      ? `linear-gradient(${g.angle}deg,`
      : g.type === 'radial'
        ? `radial-gradient(circle at ${Math.round(g.cx * 100)}% ${Math.round(g.cy * 100)}%,`
        : `conic-gradient(from ${g.angle}deg at ${Math.round(g.cx * 100)}% ${Math.round(g.cy * 100)}%,`
  return `background: ${head}\n    ${stops});`
}

export function ExportPanel({ gradient }: { gradient: Gradient }) {
  const [tab, setTab] = useState<Tab>('css')
  const [flash, setFlash] = useState('')

  const text =
    tab === 'css' ? toCSSDecl(gradient) : tab === 'oklch' ? oklchCss(gradient) : tab === 'svg' ? toSVG(gradient) : toJSON(gradient)

  const flashMsg = (m: string) => {
    setFlash(m)
    setTimeout(() => setFlash(''), 1400)
  }

  const shareLink = () => {
    const code = encodeGradient(gradient)
    const base = window.location.href.split('#')[0]
    const url = `${base}#/studio?g=${code}`
    copy(url).then((ok) => flashMsg(ok ? 'Share link copied' : 'Copy failed'))
  }

  const savePng = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 900
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    paintToCanvas(gradient, ctx, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (blob) download('gradient.png', blob, 'image/png')
    }, 'image/png')
    flashMsg('PNG downloading…')
  }

  return (
    <div className="export">
      <div className="export-tabs">
        {(['css', 'oklch', 'svg', 'json'] as Tab[]).map((t) => (
          <button key={t} className={t === tab ? 'is-active' : ''} onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      <pre className="export-code"><code>{text}</code></pre>
      <div className="export-actions">
        <button className="btn" onClick={() => copy(text).then((ok) => flashMsg(ok ? 'Copied' : 'Copy failed'))}>
          Copy {tab.toUpperCase()}
        </button>
        <button className="btn ghost" onClick={() => download(tab === 'svg' ? 'gradient.svg' : tab === 'json' ? 'gradient.json' : 'gradient.css', text, tab === 'svg' ? 'image/svg+xml' : 'text/plain')}>
          Download
        </button>
        <button className="btn ghost" onClick={savePng}>
          PNG ↓
        </button>
        <button className="btn ghost" onClick={shareLink}>
          Share link
        </button>
        {flash && <span className="flash">{flash}</span>}
      </div>
      <p className="muted small">
        {gradient.space === 'srgb'
          ? 'sRGB interpolation maps 1:1 to native CSS stops.'
          : `${gradient.space} interpolation is baked into ${24} densified stops so it survives anywhere.`}
      </p>
    </div>
  )
}
