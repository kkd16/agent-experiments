// Colour conversion helpers shared by the UI controls and scene tree. Kept out of
// controls.tsx so that file only exports components (Fast Refresh friendliness).

import type { Vec3 } from '../scene/types'

export function rgbToHex(rgb: Vec3): string {
  const to = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`
}

export function hexToRgb(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
