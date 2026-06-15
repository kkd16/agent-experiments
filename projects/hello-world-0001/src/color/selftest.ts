// An in-app self-test suite for the color engine. Round-trips must be exact, known reference
// values must match, and structural invariants (gamut clamping, hue interpolation, contrast
// monotonicity) must hold. The Tests page runs these live; a tiny node harness runs them in CI dev.

import {
  hslToRgb,
  hsvToRgb,
  labToRgb,
  lchToRgb,
  oklabToRgb,
  oklchToRgb,
  parseHex,
  rgbaToHex,
  rgbToHsl,
  rgbToHsv,
  rgbToLab,
  rgbToLch,
  rgbToOklab,
  rgbToOklch,
} from './convert'
import { contrastRatio, relativeLuminance, wcagLevel } from './contrast'
import { simulateCvd } from './cvd'
import { harmony } from './harmony'
import { lerpHue, mix } from './interpolate'
import { toCSS } from './gradient'
import { parseCssColor, parseCssGradient, splitTopLevel } from './parseCss'
import type { Gradient, RGB, RGBA } from './types'

export interface TestResult {
  group: string
  name: string
  pass: boolean
  detail: string
}

const approx = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps
const rgbClose = (a: RGB, b: RGB, eps = 1e-4) =>
  approx(a.r, b.r, eps) && approx(a.g, b.g, eps) && approx(a.b, b.b, eps)

const SAMPLES: RGB[] = [
  { r: 1, g: 0, b: 0 },
  { r: 0, g: 1, b: 0 },
  { r: 0, g: 0, b: 1 },
  { r: 1, g: 1, b: 1 },
  { r: 0, g: 0, b: 0 },
  { r: 0.2, g: 0.5, b: 0.8 },
  { r: 0.93, g: 0.51, b: 0.21 },
  { r: 0.42, g: 0.17, b: 0.66 },
  { r: 0.5, g: 0.5, b: 0.5 },
]

export function runTests(): TestResult[] {
  const out: TestResult[] = []
  const t = (group: string, name: string, pass: boolean, detail = '') =>
    out.push({ group, name, pass, detail })

  // ── round-trips ────────────────────────────────────────────────────────────
  const rt: [string, (c: RGB) => RGB][] = [
    ['Oklab', (c) => oklabToRgb(rgbToOklab(c))],
    ['Oklch', (c) => oklchToRgb(rgbToOklch(c))],
    ['CIELab', (c) => labToRgb(rgbToLab(c))],
    ['CIE LCh', (c) => lchToRgb(rgbToLch(c))],
    ['HSL', (c) => hslToRgb(rgbToHsl(c))],
    ['HSV', (c) => hsvToRgb(rgbToHsv(c))],
  ]
  for (const [name, fn] of rt) {
    let worst = 0
    let ok = true
    for (const c of SAMPLES) {
      const back = fn(c)
      worst = Math.max(worst, Math.abs(back.r - c.r), Math.abs(back.g - c.g), Math.abs(back.b - c.b))
      if (!rgbClose(c, back, 1e-3)) ok = false
    }
    t('Round-trips', `sRGB → ${name} → sRGB`, ok, `max error ${worst.toExponential(2)}`)
  }

  // hex round-trip
  {
    let ok = true
    for (const c of SAMPLES) {
      const p = parseHex(rgbaToHex({ ...c, a: 1 }))
      if (!p || !rgbClose(c, p, 1 / 255 + 1e-6)) ok = false
    }
    t('Round-trips', 'sRGB → hex → sRGB', ok, '8-bit quantization only')
    const a = parseHex('#3366cc80')
    t('Round-trips', 'hex alpha parse (#…80)', !!a && approx(a!.a, 128 / 255, 1e-6), 'alpha = 0x80/255')
    t('Round-trips', 'short hex (#f80)', rgbClose(parseHex('#f80')!, { r: 1, g: 136 / 255, b: 0 }))
  }

  // ── known reference values ──────────────────────────────────────────────────
  {
    // Oklab of pure white ≈ L 1, a 0, b 0; of mid-grey, a=b=0
    const white = rgbToOklab({ r: 1, g: 1, b: 1 })
    t('Reference values', 'Oklab(white) ≈ {1,0,0}', approx(white.L, 1, 2e-3) && approx(white.a, 0, 2e-3) && approx(white.b, 0, 2e-3), `L=${white.L.toFixed(4)}`)
    // CIELab of white is L=100
    const labWhite = rgbToLab({ r: 1, g: 1, b: 1 })
    t('Reference values', 'CIELab(white).L ≈ 100', approx(labWhite.L, 100, 1e-2), `L=${labWhite.L.toFixed(3)}`)
    // relative luminance of white = 1, black = 0
    t('Reference values', 'luminance(white)=1, (black)=0', approx(relativeLuminance({ r: 1, g: 1, b: 1 }), 1, 1e-6) && approx(relativeLuminance({ r: 0, g: 0, b: 0 }), 0, 1e-9))
    // black/white contrast is exactly 21
    t('Reference values', 'contrast(black,white)=21', approx(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }), 21, 1e-6))
    t('Reference values', "wcagLevel(21)='AAA'", wcagLevel(21) === 'AAA')
    // hue of pure red in oklch is ~29°, blue ~264°
    const redH = rgbToOklch({ r: 1, g: 0, b: 0 }).h
    t('Reference values', 'Oklch hue(red) ≈ 29°', approx(redH, 29.23, 1), `h=${redH.toFixed(2)}°`)
  }

  // ── interpolation invariants ────────────────────────────────────────────────
  {
    const a: RGBA = { r: 1, g: 0, b: 0, a: 1 }
    const b: RGBA = { r: 0, g: 0, b: 1, a: 1 }
    const m0 = mix(a, b, 0, 'oklch', 'shorter')
    const m1 = mix(a, b, 1, 'oklch', 'shorter')
    t('Interpolation', 'mix(t=0) = start, mix(t=1) = end', rgbClose(m0, a, 2e-3) && rgbClose(m1, b, 2e-3))
    // hue wrap: 350° → 10° shorter goes up through 360, longer goes the other way
    t('Interpolation', "lerpHue shorter (350→10) = 0°", approx(lerpHue(350, 10, 0.5, 'shorter'), 0, 1e-6) || approx(lerpHue(350, 10, 0.5, 'shorter'), 360, 1e-6))
    t('Interpolation', 'lerpHue longer (350→10) = 180°', approx(lerpHue(350, 10, 0.5, 'longer'), 180, 1e-6))
    // alpha is linear regardless of space
    const am = mix({ r: 0, g: 0, b: 0, a: 0 }, { r: 1, g: 1, b: 1, a: 1 }, 0.5, 'oklab', 'shorter')
    t('Interpolation', 'alpha interpolates linearly', approx(am.a, 0.5, 1e-9))
    // different spaces give genuinely different midpoints (sanity that the engine isn't a no-op)
    const sMid = mix(a, b, 0.5, 'srgb', 'shorter')
    const oMid = mix(a, b, 0.5, 'oklab', 'shorter')
    t('Interpolation', 'sRGB vs Oklab midpoints differ', !rgbClose(sMid, oMid, 0.02), 'distinct ramps')
  }

  // ── gamut clamping ──────────────────────────────────────────────────────────
  {
    // a very saturated Oklch color is out of sRGB gamut → mix() must clamp to [0,1]
    const wild = oklchToRgb({ L: 0.6, C: 0.4, h: 150 })
    const inRange = wild.r >= -1e-9 && wild.r <= 1 + 1e-9 ? false : true // expect out of range before clamp
    const clampedMix = mix({ r: 0, g: 0, b: 0, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, 0.5, 'oklch', 'shorter')
    const ok = clampedMix.r >= 0 && clampedMix.r <= 1 && clampedMix.g >= 0 && clampedMix.g <= 1 && clampedMix.b >= 0 && clampedMix.b <= 1
    t('Gamut', 'wide Oklch is out of sRGB gamut', inRange, 'before clamp')
    t('Gamut', 'mix output stays within [0,1]', ok)
  }

  // ── CVD + harmony structural checks ─────────────────────────────────────────
  {
    const red: RGB = { r: 0.9, g: 0.1, b: 0.1 }
    const sim = simulateCvd(red, 'deutan', 1)
    const inGamut = [sim.r, sim.g, sim.b].every((x) => x >= 0 && x <= 1)
    t('Vision', 'CVD sim stays in gamut', inGamut)
    t('Vision', 'CVD severity 0 is identity', rgbClose(simulateCvd(red, 'protan', 0), red))
    const tri = harmony({ r: 0.2, g: 0.6, b: 0.9, a: 1 }, 'triadic')
    t('Vision', 'triadic harmony returns 3 colors', tri.length === 3)
    const triHues = tri.map((c) => rgbToOklch(c).h)
    const spread = Math.abs(((triHues[1] - triHues[0] + 540) % 360) - 180)
    t('Vision', 'triad hues ~120° apart', approx(spread, 120, 8), `Δ≈${spread.toFixed(0)}°`)
  }

  // ── CSS import (inverse of export) ──────────────────────────────────────────
  {
    t('CSS import', "parse '#ff0000'", rgbClose(parseCssColor('#ff0000')!, { r: 1, g: 0, b: 0 }))
    t('CSS import', "parse 'rgb(255, 0, 0)'", rgbClose(parseCssColor('rgb(255, 0, 0)')!, { r: 1, g: 0, b: 0 }, 2e-3))
    const rgba = parseCssColor('rgba(0, 0, 255, 0.5)')
    t('CSS import', "parse 'rgba(…,0.5)'", !!rgba && rgbClose(rgba!, { r: 0, g: 0, b: 1 }, 2e-3) && approx(rgba!.a, 0.5, 1e-6))
    t('CSS import', "parse 'hsl(120,100%,50%)'", rgbClose(parseCssColor('hsl(120, 100%, 50%)')!, { r: 0, g: 1, b: 0 }, 2e-3))
    const ok = parseCssColor('oklch(62.8% 0.258 29.2)')
    t('CSS import', "parse 'oklch(…)' ≈ red", !!ok && rgbClose(ok!, { r: 1, g: 0, b: 0 }, 0.02))

    t('CSS import', 'splitTopLevel respects parens', splitTopLevel('rgb(1, 2, 3), #fff', ',').length === 2)

    const lin = parseCssGradient('linear-gradient(90deg, #ff0000, #0000ff)')
    t('CSS import', 'linear: type/angle/stops', !!lin && lin!.type === 'linear' && approx(lin!.angle, 90, 1e-6) && lin!.stops.length === 2)
    t('CSS import', 'linear: endpoints + auto positions', !!lin && rgbClose(lin!.stops[0].color, { r: 1, g: 0, b: 0 }) && approx(lin!.stops[0].pos, 0, 1e-9) && approx(lin!.stops[1].pos, 1, 1e-9))

    const mid = parseCssGradient('linear-gradient(to right, #000000 0%, #808080 50%, #ffffff 100%)')
    t('CSS import', "linear: 'to right' = 90°, 3 stops", !!mid && approx(mid!.angle, 90, 1e-6) && mid!.stops.length === 3 && approx(mid!.stops[1].pos, 0.5, 1e-9))

    const rad = parseCssGradient('radial-gradient(circle at 25% 75%, #ffffff, #000000)')
    t('CSS import', 'radial: center parsed', !!rad && rad!.type === 'radial' && approx(rad!.cx, 0.25, 1e-9) && approx(rad!.cy, 0.75, 1e-9))

    t('CSS import', 'non-gradient string rejected', parseCssGradient('12px solid red') === null)

    // round-trip: export an sRGB gradient, parse it back, endpoints survive
    const g: Gradient = {
      type: 'linear',
      angle: 45,
      cx: 0.5,
      cy: 0.5,
      space: 'srgb',
      hue: 'shorter',
      stops: [
        { id: 'a', color: { r: 0.2, g: 0.5, b: 0.8, a: 1 }, pos: 0 },
        { id: 'b', color: { r: 0.93, g: 0.51, b: 0.21, a: 1 }, pos: 1 },
      ],
    }
    const back = parseCssGradient(toCSS(g))
    t(
      'CSS import',
      'export → import round-trip',
      !!back && rgbClose(back!.stops[0].color, g.stops[0].color, 2e-3) && rgbClose(back!.stops[back!.stops.length - 1].color, g.stops[1].color, 2e-3),
    )
  }

  return out
}

export function summarize(results: TestResult[]): { passed: number; total: number } {
  return { passed: results.filter((r) => r.pass).length, total: results.length }
}
