// Color conversions, derived from first principles. No external color libraries.
//
// Canonical color = gamma-encoded sRGB { r, g, b } in 0..1 (+ alpha). Everything else is reached
// by going through linear-light sRGB and CIE XYZ (D65). Matrices are the standard sRGB/D65 set;
// the Oklab pipeline is Björn Ottosson's. Each forward conversion has an exact inverse so the
// engine can round-trip a color through any space without drift (verified in selftest.ts).

import type { HSL, HSV, Lab, LCh, LinearRGB, OkLab, OkLCh, RGB, RGBA, XYZ } from './types'

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

/** Wrap a hue into [0, 360). */
export const wrapHue = (h: number) => ((h % 360) + 360) % 360

// ── sRGB transfer function (gamma) ───────────────────────────────────────────
export function srgbToLinearChannel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
export function linearToSrgbChannel(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

export function rgbToLinear(rgb: RGB): LinearRGB {
  return {
    r: srgbToLinearChannel(rgb.r),
    g: srgbToLinearChannel(rgb.g),
    b: srgbToLinearChannel(rgb.b),
  }
}
export function linearToRgb(lin: LinearRGB): RGB {
  return {
    r: linearToSrgbChannel(lin.r),
    g: linearToSrgbChannel(lin.g),
    b: linearToSrgbChannel(lin.b),
  }
}

// ── linear sRGB ↔ CIE XYZ (D65) ──────────────────────────────────────────────
export function linearToXyz(c: LinearRGB): XYZ {
  return {
    x: 0.4123907993 * c.r + 0.3575843394 * c.g + 0.1804807884 * c.b,
    y: 0.2126390059 * c.r + 0.7151686788 * c.g + 0.072192315 * c.b,
    z: 0.0193308187 * c.r + 0.1191947798 * c.g + 0.9505321522 * c.b,
  }
}
export function xyzToLinear(xyz: XYZ): LinearRGB {
  return {
    r: 3.2409699419 * xyz.x - 1.5373831776 * xyz.y - 0.4986107603 * xyz.z,
    g: -0.9692436363 * xyz.x + 1.8759675015 * xyz.y + 0.0415550574 * xyz.z,
    b: 0.0556300797 * xyz.x - 0.2039769589 * xyz.y + 1.0569715142 * xyz.z,
  }
}

// ── CIE XYZ ↔ CIELab (D65 white) ─────────────────────────────────────────────
const XN = 0.95047
const YN = 1.0
const ZN = 1.08883
const LAB_E = 216 / 24389
const LAB_K = 24389 / 27

const labF = (t: number) => (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116)
const labFInv = (t: number) => {
  const t3 = t * t * t
  return t3 > LAB_E ? t3 : (116 * t - 16) / LAB_K
}

export function xyzToLab(xyz: XYZ): Lab {
  const fx = labF(xyz.x / XN)
  const fy = labF(xyz.y / YN)
  const fz = labF(xyz.z / ZN)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}
export function labToXyz(lab: Lab): XYZ {
  const fy = (lab.L + 16) / 116
  const fx = fy + lab.a / 500
  const fz = fy - lab.b / 200
  return { x: labFInv(fx) * XN, y: labFInv(fy) * YN, z: labFInv(fz) * ZN }
}

// ── Oklab (Ottosson) ─────────────────────────────────────────────────────────
export function linearToOklab(c: LinearRGB): OkLab {
  const l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b
  const m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b
  const s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}
export function oklabToLinear(lab: OkLab): LinearRGB {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

// ── Cylindrical helpers (Lab/Oklab → LCh/Oklch) ──────────────────────────────
function toCylindrical(a: number, b: number): { C: number; h: number } {
  const C = Math.hypot(a, b)
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  return { C, h }
}
function fromCylindrical(C: number, h: number): { a: number; b: number } {
  const r = (h * Math.PI) / 180
  return { a: C * Math.cos(r), b: C * Math.sin(r) }
}

// ── Public end-to-end conversions (all from gamma sRGB RGB) ───────────────────
export const rgbToXyz = (rgb: RGB): XYZ => linearToXyz(rgbToLinear(rgb))
export const xyzToRgb = (xyz: XYZ): RGB => linearToRgb(xyzToLinear(xyz))

export const rgbToLab = (rgb: RGB): Lab => xyzToLab(rgbToXyz(rgb))
export const labToRgb = (lab: Lab): RGB => xyzToRgb(labToXyz(lab))

export const rgbToOklab = (rgb: RGB): OkLab => linearToOklab(rgbToLinear(rgb))
export const oklabToRgb = (lab: OkLab): RGB => linearToRgb(oklabToLinear(lab))

export function rgbToOklch(rgb: RGB): OkLCh {
  const { L, a, b } = rgbToOklab(rgb)
  const { C, h } = toCylindrical(a, b)
  return { L, C, h }
}
export function oklchToRgb(lch: OkLCh): RGB {
  const { a, b } = fromCylindrical(lch.C, lch.h)
  return oklabToRgb({ L: lch.L, a, b })
}

export function rgbToLch(rgb: RGB): LCh {
  const { L, a, b } = rgbToLab(rgb)
  const { C, h } = toCylindrical(a, b)
  return { L, C, h }
}
export function lchToRgb(lch: LCh): RGB {
  const { a, b } = fromCylindrical(lch.C, lch.h)
  return labToRgb({ L: lch.L, a, b })
}

// ── HSL / HSV ────────────────────────────────────────────────────────────────
// Shared chroma ramp: given hue/60 (hp ∈ [0,6)) and chroma c, return the base RGB triple before
// the lightness/value offset is added back.
function hueRamp(hp: number, c: number): [number, number, number] {
  const x = c * (1 - Math.abs((hp % 2) - 1))
  if (hp < 1) return [c, x, 0]
  if (hp < 2) return [x, c, 0]
  if (hp < 3) return [0, c, x]
  if (hp < 4) return [0, x, c]
  if (hp < 5) return [x, 0, c]
  return [c, 0, x]
}

export function rgbToHsl(rgb: RGB): HSL {
  const { r, g, b } = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r:
        h = ((g - b) / d) % 6
        break
      case g:
        h = (b - r) / d + 2
        break
      default:
        h = (r - g) / d + 4
    }
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s, l }
}
export function hslToRgb(hsl: HSL): RGB {
  const { h, s, l } = hsl
  const c = (1 - Math.abs(2 * l - 1)) * s
  const [r, g, b] = hueRamp(wrapHue(h) / 60, c)
  const m = l - c / 2
  return { r: r + m, g: g + m, b: b + m }
}

export function rgbToHsv(rgb: RGB): HSV {
  const { r, g, b } = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 1e-9) {
    switch (max) {
      case r:
        h = ((g - b) / d) % 6
        break
      case g:
        h = (b - r) / d + 2
        break
      default:
        h = (r - g) / d + 4
    }
    h *= 60
    if (h < 0) h += 360
  }
  const s = max <= 0 ? 0 : d / max
  return { h, s, v: max }
}
export function hsvToRgb(hsv: HSV): RGB {
  const { h, s, v } = hsv
  const c = v * s
  const [r, g, b] = hueRamp(wrapHue(h) / 60, c)
  const m = v - c
  return { r: r + m, g: g + m, b: b + m }
}

// ── hex & CSS string parse / format ──────────────────────────────────────────
const hex2 = (n: number) =>
  Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, '0')

/** '#rrggbb' or '#rrggbbaa' when alpha < 1. */
export function rgbaToHex(c: RGBA): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
  return c.a >= 1 ? base : base + hex2(c.a)
}

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa (with or without leading #). Returns null on failure. */
export function parseHex(input: string): RGBA | null {
  let s = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3,4}$/.test(s)) {
    s = s
      .split('')
      .map((ch) => ch + ch)
      .join('')
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s) && !/^[0-9a-fA-F]{8}$/.test(s)) return null
  const r = parseInt(s.slice(0, 2), 16) / 255
  const g = parseInt(s.slice(2, 4), 16) / 255
  const b = parseInt(s.slice(4, 6), 16) / 255
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1
  return { r, g, b, a }
}

/** A CSS color for the live DOM — rgb()/rgba() with 0..255 channels. */
export function rgbaToCss(c: RGBA): string {
  const r = Math.round(clamp01(c.r) * 255)
  const g = Math.round(clamp01(c.g) * 255)
  const b = Math.round(clamp01(c.b) * 255)
  return c.a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${round(c.a, 3)})`
}

/** A modern oklch() CSS string (nice for export / display). */
export function rgbaToOklchCss(c: RGBA): string {
  const { L, C, h } = rgbToOklch(c)
  const base = `oklch(${round(L * 100, 1)}% ${round(C, 3)} ${round(h, 1)})`
  return c.a >= 1 ? base : base.replace(')', ` / ${round(c.a, 3)})`)
}

export function round(x: number, dp = 0): number {
  const m = Math.pow(10, dp)
  return Math.round(x * m) / m
}

export const clampRgb = (rgb: RGB): RGB => ({
  r: clamp01(rgb.r),
  g: clamp01(rgb.g),
  b: clamp01(rgb.b),
})

/** Is this color (before clamping) outside the sRGB gamut? */
export function isOutOfGamut(rgb: RGB, eps = 1e-4): boolean {
  return (
    rgb.r < -eps || rgb.r > 1 + eps || rgb.g < -eps || rgb.g > 1 + eps || rgb.b < -eps || rgb.b > 1 + eps
  )
}
