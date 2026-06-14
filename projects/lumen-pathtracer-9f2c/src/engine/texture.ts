// texture.ts — procedural, world-space surface textures.
//
// These are evaluated analytically at a hit point's 3D position, so they need no
// UV coordinates, no image decoding, and nothing that breaks the postMessage
// boundary: a `Texture` is a plain serialisable record the workers rebuild for
// free. The integrator resolves a textured material into a flat-coloured one at
// each vertex (see `resolveMaterial`), so the BSDF math never has to know a
// texture existed.
//
//   • checker — the classic 3D checkerboard; parity of ⌊p·scale⌋ picks a colour.
//   • grid    — thin lines on a base colour, like a technical blueprint floor.
//   • marble  — value-noise fractal Brownian motion folded through a sine to give
//               veined stone; the workhorse "this is really procedural" pattern.

import type { Vec3 } from './vec3'
import { lerp, v } from './vec3'

export type Texture =
  | { kind: 'checker'; even: Vec3; odd: Vec3; scale: number }
  | { kind: 'grid'; base: Vec3; line: Vec3; scale: number; width: number }
  | { kind: 'marble'; lo: Vec3; hi: Vec3; scale: number; turbulence: number }

// ---------------------------------------------------------------------------
// Value noise — a cheap, well-distributed scalar field on ℝ³.
// ---------------------------------------------------------------------------

// Integer hash → float in [0,1). Three large primes decorrelate the axes; the
// xor-shift-multiply finisher (à la `splitmix`) scrambles the low bits that the
// lattice grid would otherwise leave visibly periodic.
function hash3(ix: number, iy: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const fade = (t: number): number => t * t * (3 - 2 * t) // smoothstep

// Trilinearly interpolated value noise at point (x,y,z).
function valueNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = fade(x - ix)
  const fy = fade(y - iy)
  const fz = fade(z - iz)
  const c000 = hash3(ix, iy, iz)
  const c100 = hash3(ix + 1, iy, iz)
  const c010 = hash3(ix, iy + 1, iz)
  const c110 = hash3(ix + 1, iy + 1, iz)
  const c001 = hash3(ix, iy, iz + 1)
  const c101 = hash3(ix + 1, iy, iz + 1)
  const c011 = hash3(ix, iy + 1, iz + 1)
  const c111 = hash3(ix + 1, iy + 1, iz + 1)
  const x00 = c000 + (c100 - c000) * fx
  const x10 = c010 + (c110 - c010) * fx
  const x01 = c001 + (c101 - c001) * fx
  const x11 = c011 + (c111 - c011) * fx
  const y0 = x00 + (x10 - x00) * fy
  const y1 = x01 + (x11 - x01) * fy
  return y0 + (y1 - y0) * fz
}

// Turbulence: a sum of |noise| octaves (the absolute value gives the sharp
// creases that read as stone veins rather than smooth clouds).
function turbulence(x: number, y: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * Math.abs(valueNoise(x * freq, y * freq, z * freq) * 2 - 1)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

// ---------------------------------------------------------------------------
// Public evaluation
// ---------------------------------------------------------------------------

export function evalTexture(tex: Texture, p: Vec3): Vec3 {
  switch (tex.kind) {
    case 'checker': {
      const s = tex.scale
      const parity =
        Math.floor(p.x * s) + Math.floor(p.y * s) + Math.floor(p.z * s)
      return (parity & 1) === 0 ? tex.even : tex.odd
    }
    case 'grid': {
      const s = tex.scale
      const w = tex.width
      const fx = Math.abs(((p.x * s) % 1) + (p.x < 0 ? 1 : 0)) % 1
      const fz = Math.abs(((p.z * s) % 1) + (p.z < 0 ? 1 : 0)) % 1
      const onLine = fx < w || fx > 1 - w || fz < w || fz > 1 - w
      return onLine ? tex.line : tex.base
    }
    case 'marble': {
      const s = tex.scale
      const t = turbulence(p.x * s, p.y * s, p.z * s, 5)
      // Fold position + turbulence through a sine to produce the veins.
      const m = 0.5 + 0.5 * Math.sin((p.x + p.z) * s + tex.turbulence * t * Math.PI * 2)
      return lerp(tex.lo, tex.hi, m)
    }
  }
}

// A representative flat colour for a texture — used only as a denoiser albedo
// guide for textured surfaces so the G-buffer is not left black.
export function textureMeanColor(tex: Texture): Vec3 {
  switch (tex.kind) {
    case 'checker':
      return v((tex.even.x + tex.odd.x) * 0.5, (tex.even.y + tex.odd.y) * 0.5, (tex.even.z + tex.odd.z) * 0.5)
    case 'grid':
      return tex.base
    case 'marble':
      return v((tex.lo.x + tex.hi.x) * 0.5, (tex.lo.y + tex.hi.y) * 0.5, (tex.lo.z + tex.hi.z) * 0.5)
  }
}
