// A from-scratch color picker: a saturation/value square, a hue rail, an alpha rail, and
// hex / oklch text fields — all driven by pointer events, no <input type="color"> and no library.
// Internal source of truth is HSV (so dragging into a corner doesn't make the hue "jump"), synced
// to the incoming RGBA whenever it changes from the outside (e.g. selecting a different stop).

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  hsvToRgb,
  parseHex,
  rgbaToHex,
  rgbToHsv,
  rgbToOklch,
  round,
} from '../color/convert'
import type { HSV, RGBA } from '../color/types'

const cl01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Pointer position within the target element as fractions, computed at event time (no refs). */
function frac(e: React.PointerEvent): [number, number] {
  const r = e.currentTarget.getBoundingClientRect()
  return [cl01((e.clientX - r.left) / r.width), cl01((e.clientY - r.top) / r.height)]
}

export function ColorPicker({ value, onChange }: { value: RGBA; onChange: (c: RGBA) => void }) {
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(value))
  const [alpha, setAlpha] = useState(value.a)
  const [hexText, setHexText] = useState(() => rgbaToHex(value))
  const lastSig = useRef(rgbaToHex(value))

  const sig = rgbaToHex(value)
  useEffect(() => {
    if (sig !== lastSig.current) {
      setHsv(rgbToHsv(value))
      setAlpha(value.a)
      setHexText(sig)
      lastSig.current = sig
    }
  }, [sig, value])

  const emit = useCallback(
    (nextHsv: HSV, nextAlpha: number) => {
      const rgb = hsvToRgb(nextHsv)
      const out: RGBA = { ...rgb, a: nextAlpha }
      const outSig = rgbaToHex(out)
      lastSig.current = outSig
      setHexText(outSig)
      onChange(out)
    },
    [onChange],
  )

  // Applied from inside the inline pointer handlers (event time), so the ref read inside `emit` is
  // never reached during render.
  const applySV = (fx: number, fy: number) => {
    const next = { ...hsv, s: fx, v: 1 - fy }
    setHsv(next)
    emit(next, alpha)
  }
  const applyHue = (fx: number) => {
    const next = { ...hsv, h: fx * 360 }
    setHsv(next)
    emit(next, alpha)
  }
  const applyAlpha = (fx: number) => {
    setAlpha(fx)
    emit(hsv, fx)
  }

  const hueColor = rgbaToHex({ ...hsvToRgb({ h: hsv.h, s: 1, v: 1 }), a: 1 })
  const solid = rgbaToHex({ ...hsvToRgb(hsv), a: 1 })
  const withAlpha = rgbaToHex({ ...hsvToRgb(hsv), a: alpha })
  const lch = rgbToOklch(hsvToRgb(hsv))

  function commitHex(text: string) {
    const parsed = parseHex(text)
    if (parsed) {
      const nextHsv = rgbToHsv(parsed)
      setHsv(nextHsv)
      setAlpha(parsed.a)
      emit(nextHsv, parsed.a)
    } else {
      setHexText(withAlpha)
    }
  }

  return (
    <div className="picker">
      <div
        className="sv"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId)
          const [fx, fy] = frac(e)
          applySV(fx, fy)
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return
          const [fx, fy] = frac(e)
          applySV(fx, fy)
        }}
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
        }}
      >
        <span className="sv-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: solid }} />
      </div>

      <div className="rail-row">
        <span
          className="swatch-lg"
          style={{ background: `linear-gradient(${withAlpha}, ${withAlpha}), conic-gradient(#bbb 25%, #fff 0 50%, #bbb 0 75%, #fff 0)`, backgroundSize: 'cover, 10px 10px' }}
        />
        <div className="rails">
          <div
            className="rail hue"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId)
              applyHue(frac(e)[0])
            }}
            onPointerMove={(e) => e.buttons === 1 && applyHue(frac(e)[0])}
          >
            <span className="rail-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
          </div>
          <div
            className="rail alpha"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId)
              applyAlpha(frac(e)[0])
            }}
            onPointerMove={(e) => e.buttons === 1 && applyAlpha(frac(e)[0])}
            style={{ ['--solid' as string]: solid }}
          >
            <span className="rail-thumb" style={{ left: `${alpha * 100}%`, background: withAlpha }} />
          </div>
        </div>
      </div>

      <div className="picker-fields">
        <label className="fld">
          <span>HEX</span>
          <input
            value={hexText}
            onChange={(e) => setHexText(e.target.value)}
            onBlur={(e) => commitHex(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commitHex((e.target as HTMLInputElement).value)}
            spellCheck={false}
          />
        </label>
        <div className="oklch-readout" title="Oklch — perceptual lightness / chroma / hue">
          oklch({round(lch.L * 100, 1)}% {round(lch.C, 3)} {round(lch.h, 1)})
        </div>
      </div>
    </div>
  )
}
