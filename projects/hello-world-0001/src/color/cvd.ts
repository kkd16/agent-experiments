// Color-vision-deficiency simulation. We use the Viénot–Brettel–Mollon (1999) method: take the
// color into LMS cone space, project it onto the plane of colors a dichromat can distinguish, then
// blend between the original and the projection by `severity` for the anomalous-trichromat case.
// Tritanopia uses Brettel's two-plane construction. Everything runs in linear light.

import { clampRgb, linearToRgb, rgbToLinear } from './convert'
import type { RGB } from './types'

export type CvdType = 'normal' | 'protan' | 'deutan' | 'tritan'

// linear sRGB → LMS (Hunt-Pointer-Estevez normalized to D65, common in CVD literature)
function rgbLinToLms(r: number, g: number, b: number): [number, number, number] {
  return [
    0.31399022 * r + 0.63951294 * g + 0.04649755 * b,
    0.15537241 * r + 0.75789446 * g + 0.08670142 * b,
    0.01775239 * r + 0.10944209 * g + 0.87256922 * b,
  ]
}
function lmsToRgbLin(l: number, m: number, s: number): [number, number, number] {
  return [
    5.47221206 * l - 4.6419601 * m + 0.16963708 * s,
    -1.1252419 * l + 2.29317094 * m - 0.1678952 * s,
    0.02980165 * l - 0.19318073 * m + 1.16364789 * s,
  ]
}

function simulateDichromat(rgb: RGB, type: Exclude<CvdType, 'normal'>): RGB {
  const lin = rgbToLinear(rgb)
  const [l, m, s] = rgbLinToLms(lin.r, lin.g, lin.b)
  let l2 = l
  let m2 = m
  let s2 = s
  if (type === 'protan') {
    l2 = 1.05118294 * m - 0.05116099 * s
  } else if (type === 'deutan') {
    m2 = 0.9513092 * l + 0.04866992 * s
  } else {
    // tritan — two-plane projection split by the m/l ratio
    if (l === 0 && m === 0) {
      s2 = s
    } else if (m / Math.max(l, 1e-9) < 0.3) {
      s2 = -0.86744736 * l + 1.86727089 * m
    } else {
      s2 = 0.06557719 * l + 0.06342486 * m
    }
  }
  const [r2, g2, b2] = lmsToRgbLin(l2, m2, s2)
  return clampRgb(linearToRgb({ r: r2, g: g2, b: b2 }))
}

/** Simulate how `rgb` appears under a CVD of the given type at `severity` (0..1). */
export function simulateCvd(rgb: RGB, type: CvdType, severity = 1): RGB {
  if (type === 'normal' || severity <= 0) return rgb
  const full = simulateDichromat(rgb, type)
  if (severity >= 1) return full
  return {
    r: rgb.r + (full.r - rgb.r) * severity,
    g: rgb.g + (full.g - rgb.g) * severity,
    b: rgb.b + (full.b - rgb.b) * severity,
  }
}

export const CVD_LABELS: Record<CvdType, string> = {
  normal: 'Normal vision',
  protan: 'Protanopia (no L cones)',
  deutan: 'Deuteranopia (no M cones)',
  tritan: 'Tritanopia (no S cones)',
}
