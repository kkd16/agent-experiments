// The Animate studio. Gradients don't have to hold still: cycle their hue, sweep them under the
// box, or spin a conic. A live preview runs on requestAnimationFrame; the exported CSS is portable
// (@keyframes you can paste anywhere). Hue-cycle bakes discrete frames — CSS can't tween between
// two gradient images — while sweep/spin animate a single property and stay tiny.

import { useEffect, useRef, useState } from 'react'
import { ANIM_LABELS, defaultAnim, frameAt, toKeyframesCss } from '../color/animate'
import type { Anim, AnimKind } from '../color/animate'
import { toCSS } from '../color/gradient'
import type { Gradient } from '../color/types'

const KINDS: AnimKind[] = ['hue', 'sweep', 'spin', 'none']

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function Animate({ gradient }: { gradient: Gradient }) {
  const [anim, setAnim] = useState<Anim>(() => ({ ...defaultAnim(), kind: 'hue' }))
  const [playing, setPlaying] = useState(true)
  const [flash, setFlash] = useState('')
  const previewRef = useRef<HTMLDivElement>(null)
  const startRef = useRef<number>(0)
  const rafRef = useRef<number>(0)

  // Drive the preview directly through the DOM (avoids re-rendering React 60×/s).
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    if (anim.kind === 'sweep') {
      // sweep is pure CSS background-position; set up once and let the browser animate.
      el.style.backgroundImage = toCSS(gradient)
      el.style.backgroundSize = '200% 200%'
    } else {
      el.style.backgroundSize = ''
    }

    if (!playing || anim.kind === 'none') {
      el.style.backgroundImage = toCSS(gradient)
      el.style.backgroundPosition = ''
      return
    }

    let stop = false
    const loop = (now: number) => {
      if (stop) return
      if (!startRef.current) startRef.current = now
      const t = ((now - startRef.current) % anim.durationMs) / anim.durationMs
      if (anim.kind === 'sweep') {
        const p = (Math.sin(t * Math.PI * 2 - Math.PI / 2) + 1) / 2 // ease in-out ping-pong
        el.style.backgroundPosition = `${p * 100}% 50%`
      } else {
        el.style.backgroundImage = toCSS(frameAt(gradient, anim, t))
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      stop = true
      cancelAnimationFrame(rafRef.current)
    }
  }, [gradient, anim, playing])

  // Reset the clock when the animation kind changes so it always starts clean.
  useEffect(() => {
    startRef.current = 0
  }, [anim.kind])

  const css = toKeyframesCss(gradient, anim)
  const flashMsg = (m: string) => {
    setFlash(m)
    setTimeout(() => setFlash(''), 1400)
  }

  return (
    <div className="animate-page">
      <div className="preview animate-preview" ref={previewRef} />

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Animation">
          {KINDS.map((k) => (
            <button key={k} className={k === anim.kind ? 'is-active' : ''} onClick={() => setAnim((a) => ({ ...a, kind: k }))}>
              {ANIM_LABELS[k]}
            </button>
          ))}
        </div>
        <label className="ctrl">
          <span>Duration</span>
          <input
            type="range"
            min={1000}
            max={20000}
            step={500}
            value={anim.durationMs}
            onChange={(e) => setAnim((a) => ({ ...a, durationMs: Number(e.target.value) }))}
          />
          <b>{(anim.durationMs / 1000).toFixed(1)}s</b>
        </label>
        <div className="toolbar-spacer" />
        <button className="btn ghost" onClick={() => setPlaying((p) => !p)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
      </div>

      <p className="muted small">
        {anim.kind === 'hue'
          ? 'Every stop rotates through the hue wheel in Oklch. Export bakes 24 frames into a stepped @keyframes (CSS can’t tween gradient images).'
          : anim.kind === 'sweep'
            ? 'The gradient is oversized and slid under the box — one tiny, smoothly-interpolated @keyframes.'
            : anim.kind === 'spin'
              ? 'A conic gradient’s start angle spins via a registered @property custom property (modern browsers).'
              : 'No animation — a static background.'}
      </p>

      <section className="card span-2">
        <h3>Animation CSS</h3>
        <pre className="export-code"><code>{css}</code></pre>
        <div className="export-actions">
          <button className="btn" onClick={() => copy(css).then((ok) => flashMsg(ok ? 'Copied' : 'Copy failed'))}>
            Copy CSS
          </button>
          {flash && <span className="flash">{flash}</span>}
        </div>
      </section>
    </div>
  )
}
