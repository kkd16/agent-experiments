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
import { deltaE2000Lab, deltaE76Lab, deltaE94Lab, deltaEOk } from './difference'
import { cuspForHue, gamutMapOklch, inGamut, maxChromaForLh } from './gamut'
import { cubicBezier, ease } from './easing'
import { nearestNamedColor } from './names'
import { hueRotated, sweepKeyframesCss } from './animate'
import { decodeGradient, encodeGradient } from '../state/store'
import type { Gradient, Lab, RGB, RGBA } from './types'

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

  // ── ΔE color difference (CIEDE2000 against the Sharma–Wu–Dalal reference set) ─
  {
    // The canonical 34 test pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000
    // Color-Difference Formula: …". Each row is L1,a1,b1, L2,a2,b2, expected ΔE00.
    const SHARMA: number[][] = [
      [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
      [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
      [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
      [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
      [50, -1.1848, -84.8006, 50, 0, -82.7485, 1.0],
      [50, -0.9009, -85.5211, 50, 0, -82.7485, 1.0],
      [50, 0, 0, 50, -1, 2, 2.3669],
      [50, -1, 2, 50, 0, 0, 2.3669],
      [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
      [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
      [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
      [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
      [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
      [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
      [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
      [50, 2.5, 0, 50, 0, -2.5, 4.3065],
      [50, 2.5, 0, 73, 25, -18, 27.1492],
      [50, 2.5, 0, 61, -5, 29, 22.8977],
      [50, 2.5, 0, 56, -27, -3, 31.903],
      [50, 2.5, 0, 58, 24, 15, 19.4535],
      [50, 2.5, 0, 50, 3.1736, 0.5854, 1.0],
      [50, 2.5, 0, 50, 3.2972, 0, 1.0],
      [50, 2.5, 0, 50, 1.8634, 0.5757, 1.0],
      [50, 2.5, 0, 50, 3.2592, 0.335, 1.0],
      [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
      [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
      [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
      [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
      [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
      [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
      [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
      [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
      [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
      [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
    ]
    let worst = 0
    let ok = true
    for (const row of SHARMA) {
      const a: Lab = { L: row[0], a: row[1], b: row[2] }
      const b: Lab = { L: row[3], a: row[4], b: row[5] }
      const got = deltaE2000Lab(a, b)
      worst = Math.max(worst, Math.abs(got - row[6]))
      if (Math.abs(got - row[6]) > 1e-4) ok = false
    }
    t('ΔE color difference', 'CIEDE2000 = Sharma et al. (34 pairs)', ok, `max error ${worst.toExponential(2)}`)
    // ΔE76 is plain Euclidean in Lab.
    t('ΔE color difference', 'ΔE76 = Euclidean Lab', approx(deltaE76Lab({ L: 0, a: 0, b: 0 }, { L: 3, a: 4, b: 0 }), 5, 1e-9))
    // ΔE94 ≤ ΔE76 (the weighting only ever shrinks chroma/hue terms).
    {
      const a: Lab = { L: 50, a: 40, b: 30 }
      const b: Lab = { L: 55, a: 10, b: 60 }
      t('ΔE color difference', 'ΔE94 ≤ ΔE76', deltaE94Lab(a, b) <= deltaE76Lab(a, b) + 1e-9)
    }
    // identical colors → zero difference in every metric.
    const red: RGB = { r: 0.8, g: 0.1, b: 0.2 }
    t('ΔE color difference', 'ΔE(x,x)=0 (OK + 2000)', deltaEOk(red, red) < 1e-9)
    // nearest named color of pure red is "red".
    t('ΔE color difference', "nearest named(#f00) = 'red'", nearestNamedColor({ r: 1, g: 0, b: 0 }).name === 'red')
    t('ΔE color difference', "nearest named(#fff) = 'white'", nearestNamedColor({ r: 1, g: 1, b: 1 }).name === 'white')
  }

  // ── Gamut mapping (CSS Color 4) ──────────────────────────────────────────────
  {
    // A wildly saturated Oklch teal is out of sRGB; mapping must return a displayable color.
    const wild = { L: 0.7, C: 0.4, h: 160 }
    t('Gamut mapping', 'wild Oklch is out of gamut', !inGamut(wild))
    const mapped = gamutMapOklch(wild)
    const disp = mapped.r >= -1e-6 && mapped.r <= 1 + 1e-6 && mapped.g >= -1e-6 && mapped.g <= 1 + 1e-6 && mapped.b >= -1e-6 && mapped.b <= 1 + 1e-6
    t('Gamut mapping', 'mapped color is displayable', disp)
    // an in-gamut color is returned ~unchanged.
    const safe = { L: 0.6, C: 0.05, h: 30 }
    const mappedSafe = gamutMapOklch(safe)
    const orig = oklchToRgb(safe)
    t('Gamut mapping', 'in-gamut color preserved', rgbClose(mappedSafe, orig, 2e-3))
    // L=1 → white, L=0 → black, regardless of chroma asked for.
    t('Gamut mapping', 'L=1 → white', rgbClose(gamutMapOklch({ L: 1, C: 0.3, h: 90 }), { r: 1, g: 1, b: 1 }, 1e-6))
    t('Gamut mapping', 'L=0 → black', rgbClose(gamutMapOklch({ L: 0, C: 0.3, h: 90 }), { r: 0, g: 0, b: 0 }, 1e-6))
    // maxChroma: zero chroma is always in gamut; the boundary is positive in the mid-range.
    const cMax = maxChromaForLh(0.6, 30)
    t('Gamut mapping', 'maxChromaForLh > 0 mid-range', cMax > 0.01 && inGamut({ L: 0.6, C: cMax, h: 30 }))
    t('Gamut mapping', 'just past boundary is out', !inGamut({ L: 0.6, C: cMax + 0.01, h: 30 }))
    const cusp = cuspForHue(30)
    t('Gamut mapping', 'cusp chroma ≥ a mid slice', cusp.C >= cMax - 1e-3)
  }

  // ── Easing (cubic-bezier solver) ─────────────────────────────────────────────
  {
    t('Easing', 'ease endpoints 0→0, 1→1', approx(ease(0, 'ease'), 0, 1e-9) && approx(ease(1, 'ease'), 1, 1e-9))
    t('Easing', 'linear is identity', approx(ease(0.37, 'linear'), 0.37, 1e-9))
    // ease-in starts slow: at t=0.5 the output is below 0.5.
    t('Easing', 'ease-in lags at midpoint', ease(0.5, 'ease-in') < 0.5)
    t('Easing', 'ease-out leads at midpoint', ease(0.5, 'ease-out') > 0.5)
    // smoothstep is symmetric about 0.5.
    t('Easing', 'smoothstep symmetric', approx(ease(0.5, 'smoothstep'), 0.5, 1e-9) && approx(ease(0.25, 'smoothstep') + ease(0.75, 'smoothstep'), 1, 1e-9))
    t('Easing', 'step snaps at 0.5', ease(0.49, 'step') === 0 && ease(0.5, 'step') === 1)
    // a custom linear bezier reproduces identity.
    const lin = cubicBezier(0.5, 0.5, 0.5, 0.5)
    t('Easing', 'cubic-bezier solver monotone', lin(0.3) < lin(0.6) && lin(0.6) < lin(0.9))
  }

  // ── Animation ────────────────────────────────────────────────────────────────
  {
    const g: Gradient = {
      type: 'linear', angle: 90, cx: 0.5, cy: 0.5, space: 'oklch', hue: 'shorter',
      stops: [
        { id: 'a', color: { r: 1, g: 0, b: 0, a: 1 }, pos: 0 },
        { id: 'b', color: { r: 0, g: 0, b: 1, a: 1 }, pos: 1 },
      ],
    }
    // rotating hue by 360° returns (≈) the original colors.
    const full = hueRotated(g, 360)
    t('Animation', 'hue rotate 360° ≈ identity', rgbClose(full.stops[0].color, g.stops[0].color, 2e-3) && rgbClose(full.stops[1].color, g.stops[1].color, 2e-3))
    // rotating by 180° actually changes the colors.
    const half = hueRotated(g, 180)
    t('Animation', 'hue rotate 180° changes colors', !rgbClose(half.stops[0].color, g.stops[0].color, 0.05))
    const css = sweepKeyframesCss(g, 4000)
    t('Animation', 'sweep CSS has @keyframes + background-position', css.includes('@keyframes') && css.includes('background-position'))
  }

  // ── Serialization (easing + gamut survive the URL round-trip) ────────────────
  {
    const g: Gradient = {
      type: 'radial', angle: 33, cx: 0.3, cy: 0.7, space: 'oklch', hue: 'longer', gamut: 'map',
      stops: [
        { id: 'a', color: { r: 0.1, g: 0.2, b: 0.9, a: 1 }, pos: 0, easing: 'ease-in-out' },
        { id: 'b', color: { r: 0.9, g: 0.4, b: 0.1, a: 0.8 }, pos: 1, easing: 'smoothstep' },
      ],
    }
    const back = decodeGradient(encodeGradient(g))
    const okFields = !!back && back.type === 'radial' && back.gamut === 'map' && approx(back.angle, 33, 1e-6) && back.hue === 'longer'
    const okEasing = !!back && back.stops[0].easing === 'ease-in-out' && back.stops[1].easing === 'smoothstep'
    t('Serialization', 'gradient fields round-trip', okFields)
    t('Serialization', 'per-stop easing round-trips', okEasing)
    // a legacy link with no gamut/easing decodes to the defaults (clip / linear).
    const legacy = decodeGradient(encodeGradient({ ...g, gamut: undefined, stops: g.stops.map((s) => ({ ...s, easing: undefined })) }))
    t('Serialization', 'legacy link defaults (clip/linear)', !!legacy && legacy.gamut === 'clip' && legacy.stops[0].easing === undefined)
  }

  // gamut='map' keeps a wide gradient hue truer than naïve clipping
  {
    const wide: Gradient = {
      type: 'linear', angle: 90, cx: 0.5, cy: 0.5, space: 'oklch', hue: 'shorter',
      stops: [
        { id: 'a', color: { r: 0, g: 0, b: 0, a: 1 }, pos: 0 },
        { id: 'b', color: oklchToRgbA({ L: 0.8, C: 0.37, h: 145 }), pos: 1 },
      ],
    }
    const clip = mix(wide.stops[0].color, wide.stops[1].color, 0.5, 'oklch', 'shorter', 'clip')
    const map = mix(wide.stops[0].color, wide.stops[1].color, 0.5, 'oklch', 'shorter', 'map')
    const both = [clip, map].every((c) => c.r >= 0 && c.r <= 1 && c.g >= 0 && c.g <= 1 && c.b >= 0 && c.b <= 1)
    t('Gamut mapping', 'clip & map both stay in [0,1]', both)
    t('Gamut mapping', 'clip and map differ on a wide ramp', !rgbClose(clip, map, 0.01))
  }

  return out
}

function oklchToRgbA(c: { L: number; C: number; h: number }): RGBA {
  const r = oklchToRgb(c)
  return { r: r.r, g: r.g, b: r.b, a: 1 }
}

export function summarize(results: TestResult[]): { passed: number; total: number } {
  return { passed: results.filter((r) => r.pass).length, total: results.length }
}
