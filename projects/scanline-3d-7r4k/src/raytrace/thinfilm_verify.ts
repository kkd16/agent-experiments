// A numerical self-test of the thin-film optics. Each check re-derives a claim from an
// independent reference: energy stays bounded, a vanishing film collapses to the bare
// Fresnel reflectance of the substrate (cross-checked against `dielectric.ts`), a flat
// non-dispersive stack integrates to a neutral grey, and the structural colour both
// drifts with thickness and shifts with viewing angle — the signature of interference.
// Runs live in the browser; nothing here touches the DOM.
import { fresnelDielectric } from './dielectric.ts'
import {
  filmReflectanceAt, filmReflectanceRGB, buildFilmLUT, sampleFilmLUT,
} from './thinfilm.ts'

export interface ThinFilmTest {
  name: string
  pass: boolean
  detail: string
}

const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b
// chroma = saturation-like distance of an RGB from its own grey (how colourful it is)
const chroma = (r: number, g: number, b: number): number => {
  const m = (r + g + b) / 3
  return Math.hypot(r - m, g - m, b - m)
}

export function runThinFilmSelfTest(): ThinFilmTest[] {
  const tests: ThinFilmTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }
  const tmp = new Float64Array(3)

  // 1 — energy: 0 ≤ R ≤ 1 across a dense angle × thickness × wavelength × IOR sweep, and
  //     the integrated RGB reflectance has luminance ≤ 1 (a film never amplifies light).
  {
    let minR = 1, maxR = 0, maxLum = 0, n = 0
    for (const n1 of [1.2, 1.33, 1.45, 1.8]) {
      for (const n2 of [1.0, 1.33, 1.5, 2.4]) {
        for (let d = 0; d <= 900; d += 60) {
          for (let ci = 0.02; ci <= 1; ci += 0.05) {
            for (const l of [410, 480, 530, 580, 650, 710]) {
              const R = filmReflectanceAt(ci, 1.0, n1, n2, d, l)
              if (R < minR) minR = R
              if (R > maxR) maxR = R
              n++
            }
            filmReflectanceRGB(ci, 1.0, n1, n2, d, tmp)
            maxLum = Math.max(maxLum, lum(tmp[0], tmp[1], tmp[2]))
          }
        }
      }
    }
    const ok = minR >= -1e-9 && maxR <= 1 + 1e-9 && maxLum <= 1 + 1e-6
    add('Energy conservation (0 ≤ R ≤ 1)', ok, `R∈[${minR.toFixed(3)}, ${maxR.toFixed(3)}] over ${n} samples; max integrated luminance ${maxLum.toFixed(3)}`)
  }

  // 2 — d → 0 collapse: a vanishing film must reproduce the bare Fresnel reflectance of
  //     the n0│n2 interface for ANY film IOR n1 and wavelength (the film disappears).
  //     Cross-checked against the independent `fresnelDielectric` in dielectric.ts.
  {
    let maxErr = 0
    for (const n2 of [1.0, 1.33, 1.5, 2.4]) {
      for (const n1 of [1.2, 1.5, 2.0]) {
        for (let ci = 0.05; ci <= 1; ci += 0.05) {
          const ref = fresnelDielectric(ci, 1.0, n2)
          const got = filmReflectanceAt(ci, 1.0, n1, n2, 0, 550)
          maxErr = Math.max(maxErr, Math.abs(ref - got))
        }
      }
    }
    add('d → 0 collapses to Fresnel(n0│n2)', maxErr < 1e-6, `max |R_film − R_fresnel| = ${maxErr.toExponential(1)} over angles × film IORs`)
  }

  // 3 — neutrality + white point: a non-dispersive flat stack (d = 0) integrates to a
  //     neutral grey (no false colour from the CMF integration), and the grey level
  //     equals the substrate's luminous Fresnel reflectance.
  {
    const n2 = 1.5, ci = 0.7
    filmReflectanceRGB(ci, 1.0, 1.4, n2, 0, tmp)
    const ch = chroma(tmp[0], tmp[1], tmp[2])
    const L = lum(tmp[0], tmp[1], tmp[2])
    const ref = fresnelDielectric(ci, 1.0, n2)
    const ok = ch < 0.01 && Math.abs(L - ref) < 0.02
    add('Flat stack is neutral grey', ok, `chroma ${ch.toExponential(1)} (≈0), grey luminance ${L.toFixed(3)} vs Fresnel ${ref.toFixed(3)}`)
  }

  // 4 — structural colour: a real film is coloured, and the colour drifts with thickness.
  //     A high-index film (n1 ≈ 2.0, like a TiO₂ coat) in air swings reflectance widely, so
  //     its head-on colour at 180 nm and 320 nm must be both saturated AND chromatically far
  //     apart — interference, not a fixed tint. (A symmetric soap film air│water│air is the
  //     same physics but pale — peak reflectance only ~8% — so the vivid stack tests it best.)
  {
    const thin = new Float64Array(3), thick = new Float64Array(3)
    filmReflectanceRGB(1.0, 1.0, 2.0, 1.0, 180, thin)
    filmReflectanceRGB(1.0, 1.0, 2.0, 1.0, 320, thick)
    const satThin = chroma(thin[0], thin[1], thin[2])
    const satThick = chroma(thick[0], thick[1], thick[2])
    const dist = Math.hypot(thin[0] - thick[0], thin[1] - thick[1], thin[2] - thick[2])
    const ok = satThin > 0.05 && satThick > 0.05 && dist > 0.1
    add('Thickness → hue drift (iridescence)', ok, `chroma 180nm=${satThin.toFixed(3)}, 320nm=${satThick.toFixed(3)}; colour shift Δ=${dist.toFixed(3)}`)
  }

  // 5 — angle shift: at a FIXED thickness the colour changes with viewing angle, because
  //     cosθ1 inside the film scales the optical path (a bubble's rim differs from its face).
  {
    const head = new Float64Array(3), graze = new Float64Array(3)
    filmReflectanceRGB(1.0, 1.0, 1.33, 1.0, 380, head)   // straight on
    filmReflectanceRGB(0.4, 1.0, 1.33, 1.0, 380, graze)  // ~66°
    const dist = Math.hypot(head[0] - graze[0], head[1] - graze[1], head[2] - graze[2])
    add('Angle → hue shift (Snell path)', dist > 0.05, `colour shift head-on→66° Δ=${dist.toFixed(3)}`)
  }

  // 6 — baked LUT matches the reference evaluation it caches (lerp error is small).
  {
    const lut = buildFilmLUT(1.33, 1.0, 380, 64)
    let maxErr = 0
    for (let ci = 0.1; ci <= 1; ci += 0.037) {
      sampleFilmLUT(lut, ci, tmp)
      const ref = new Float64Array(3)
      filmReflectanceRGB(ci, 1.0, 1.33, 1.0, 380, ref)
      maxErr = Math.max(maxErr, Math.abs(tmp[0] - ref[0]), Math.abs(tmp[1] - ref[1]), Math.abs(tmp[2] - ref[2]))
    }
    add('Baked LUT ≈ reference', maxErr < 0.02, `max |LUT − ref| = ${maxErr.toFixed(4)} across the cosθ range (64-entry table)`)
  }

  return tests
}
