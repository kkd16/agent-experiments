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

// ── Procedural normal maps ───────────────────────────────────────────────────
// A NormalMap returns a tangent-space normal (x,y ∈ −1..1, z ≈ 1) for a UV. Each
// is derived by central-differencing a scalar height field, so the perturbation
// always points "uphill" and stays unit-length.
export type NormalMap = (u: number, v: number) => Vec3

export type NormalMapKind = 'none' | 'bumps' | 'ripples' | 'brick' | 'scales'

const heightToNormal = (height: (u: number, v: number) => number, strength: number): NormalMap => (u, v) => {
  const e = 1 / 256
  const hl = height(u - e, v)
  const hr = height(u + e, v)
  const hd = height(u, v - e)
  const hu = height(u, v + e)
  const dx = (hr - hl) * strength
  const dy = (hu - hd) * strength
  // gradient → tangent-space normal
  const nx = -dx
  const ny = -dy
  const nz = 1
  const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz)
  return [nx * inv, ny * inv, nz * inv]
}

const hash2 = (x: number, y: number): number =>
  fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453)

export const makeNormalMap = (kind: NormalMapKind): NormalMap | null => {
  switch (kind) {
    case 'none':
      return null
    case 'bumps':
      // hexish field of rounded bumps
      return heightToNormal((u, v) => {
        const s = 9
        const cu = fract(u * s) - 0.5
        const cv = fract(v * s) - 0.5
        const d = Math.sqrt(cu * cu + cv * cv)
        return smoothstep(0.42, 0.0, d)
      }, 22)
    case 'ripples':
      return heightToNormal((u, v) => {
        const d = Math.sqrt((u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5))
        return Math.sin(d * 60) * 0.5 + 0.5
      }, 6)
    case 'brick':
      // raised bricks with recessed mortar lines, matching the brick texture
      return heightToNormal((u, v) => {
        const s = 5
        const row = Math.floor(v * s)
        const offset = (row & 1) * 0.5
        const bu = fract(u * s + offset)
        const bv = fract(v * s)
        const m = 0.07
        const edge = Math.min(
          smoothstep(0, m, bu) * smoothstep(0, m, 1 - bu),
          smoothstep(0, m, bv) * smoothstep(0, m, 1 - bv),
        )
        return edge
      }, 16)
    case 'scales':
      // staggered dimples with a little per-cell jitter
      return heightToNormal((u, v) => {
        const s = 11
        const row = Math.floor(v * s)
        const offset = (row & 1) * 0.5
        const cu = fract(u * s + offset) - 0.5
        const cv = fract(v * s) - 0.5
        const j = hash2(Math.floor(u * s + offset), row) * 0.12
        const d = Math.sqrt(cu * cu + cv * cv) + j
        return 1 - smoothstep(0.0, 0.5, d)
      }, 18)
  }
}
