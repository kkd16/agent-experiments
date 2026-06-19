// Procedural textures. Each is just a function (u, v) → linear rgb, so there is
// no image decoding and patterns stay crisp at any resolution. Checker/grid/brick
// edges are analytically anti-aliased with smoothstep against the cell fraction.
import { fract, smoothstep } from '../math/scalar.ts'
import type { Vec3 } from '../math/vec.ts'
import { lerp3 } from '../math/vec.ts'

export type Texture = (u: number, v: number) => Vec3

export type TextureKind = 'none' | 'checker' | 'grid' | 'bricks' | 'uv'

const aaStep = (edge: number, x: number, w = 0.04): number => smoothstep(edge - w, edge + w, x)

export const checker = (a: Vec3, b: Vec3, scale = 6): Texture => (u, v) => {
  const cu = Math.floor(u * scale)
  const cv = Math.floor(v * scale)
  return (cu + cv) & 1 ? a : b
}

export const grid = (line: Vec3, fill: Vec3, scale = 8, thickness = 0.06): Texture => (u, v) => {
  const fu = fract(u * scale)
  const fv = fract(v * scale)
  const du = Math.min(fu, 1 - fu)
  const dv = Math.min(fv, 1 - fv)
  const d = Math.min(du, dv)
  const t = aaStep(thickness, d, 0.02)
  return lerp3(line, fill, t)
}

export const bricks = (brick: Vec3, mortar: Vec3, scale = 5): Texture => (u, v) => {
  const row = Math.floor(v * scale)
  const offset = (row & 1) * 0.5
  const bu = fract(u * scale + offset)
  const bv = fract(v * scale)
  const m = 0.06
  const inMortar = Math.min(bu, 1 - bu) < m || Math.min(bv, 1 - bv) < m
  if (inMortar) return mortar
  // subtle per-brick tint variation
  const col = Math.floor(u * scale + offset)
  const hash = fract(Math.sin(row * 12.9898 + col * 78.233) * 43758.5453)
  const tint = 0.85 + hash * 0.25
  return [brick[0] * tint, brick[1] * tint, brick[2] * tint]
}

export const uvDebug: Texture = (u, v) => [u, v, 0.5]

export const makeTexture = (kind: TextureKind): Texture | null => {
  switch (kind) {
    case 'none': return null
    case 'checker': return checker([0.92, 0.92, 0.95], [0.15, 0.17, 0.22])
    case 'grid': return grid([0.1, 0.7, 0.9], [0.08, 0.09, 0.12], 8, 0.05)
    case 'bricks': return bricks([0.62, 0.28, 0.22], [0.82, 0.8, 0.76], 5)
    case 'uv': return uvDebug
  }
}
