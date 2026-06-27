// camera.ts — a thin-lens pinhole-plus-aperture camera.
//
// With aperture = 0 it is an ideal pinhole. With a finite aperture it samples a
// disk of radius `aperture` and refocuses each ray onto a plane `focusDist`
// away, producing physically correct depth of field (circle of confusion grows
// with distance from the focal plane).

import type { Vec3 } from './vec3'
import { add, cross, madd, normalize, scale, sub, v } from './vec3'
import type { Ray } from './ray'
import { concentricDisk, concentricDiskFrom } from './rng'
import type { Rng } from './rng'

export interface CameraDef {
  eye: Vec3
  target: Vec3
  up: Vec3
  vfovDeg: number
  aperture: number
  focusDist: number
  // (22.0) Aperture *shape* for the depth-of-field bokeh. A real iris is a
  // regular polygon of `blades` straight edges, not a perfect circle, so an
  // out-of-focus highlight images as that polygon (the classic hexagonal/
  // octagonal bokeh ball). `blades < 3` ⇒ a circular aperture (the historical
  // concentric-disk sampler, bit-for-bit). `bladeRotation` (radians) spins the
  // iris. The mean lens offset stays zero either way, so depth of field remains
  // unbiased — only the *shape* of the circle of confusion changes.
  blades?: number
  bladeRotation?: number
}

// (22.0) Sample a point uniformly over a regular `blades`-gon inscribed in the
// unit circle (vertices at radius 1), rotated by `rot`. `u1,u2 ∈ [0,1)`. For
// uniform inputs this is *exactly* area-uniform: u1·blades splits into an integer
// part (which triangular wedge of the polygon, each equally likely) and a
// fractional part that — independent of the integer part for uniform u1 — is one
// of the two barycentric coordinates inside that wedge (the (a,b)→(1−a,1−b) fold
// turns the unit square into a uniform triangle sample). `blades < 3` falls back
// to the circular concentric-disk sampler, so a circular aperture is unchanged.
export function sampleAperture(blades: number, rot: number, u1: number, u2: number): { x: number; y: number } {
  if (blades < 3) return concentricDiskFrom(u1, u2)
  const fn = u1 * blades
  let t = Math.floor(fn)
  if (t >= blades) t = blades - 1
  const ut = fn - t // independent U[0,1) for uniform u1
  const a0 = rot + (2 * Math.PI * t) / blades
  const a1 = rot + (2 * Math.PI * (t + 1)) / blades
  let a = ut
  let b = u2
  if (a + b > 1) {
    a = 1 - a
    b = 1 - b
  }
  // Barycentric point in triangle (origin, V_t, V_{t+1}); weights (1−a−b, a, b).
  const x = a * Math.cos(a0) + b * Math.cos(a1)
  const y = a * Math.sin(a0) + b * Math.sin(a1)
  return { x, y }
}

export class Camera {
  private eye: Vec3
  private lowerLeft: Vec3
  private horizontal: Vec3
  private vertical: Vec3
  private u: Vec3
  private vv: Vec3
  private lensRadius: number
  private blades: number
  private bladeRot: number

  constructor(def: CameraDef, aspect: number) {
    this.eye = def.eye
    this.lensRadius = def.aperture * 0.5
    this.blades = def.blades ?? 0
    this.bladeRot = def.bladeRotation ?? 0
    const theta = (def.vfovDeg * Math.PI) / 180
    const halfH = Math.tan(theta / 2)
    const halfW = aspect * halfH
    const w = normalize(sub(def.eye, def.target)) // points back toward the eye
    this.u = normalize(cross(def.up, w))
    this.vv = cross(w, this.u)
    const fd = def.focusDist
    // Image plane placed at the focus distance so DoF math stays simple.
    this.horizontal = scale(this.u, 2 * halfW * fd)
    this.vertical = scale(this.vv, 2 * halfH * fd)
    this.lowerLeft = sub(
      sub(sub(def.eye, scale(this.horizontal, 0.5)), scale(this.vertical, 0.5)),
      scale(w, fd),
    )
  }

  // s, t ∈ [0,1] image-plane coordinates (origin bottom-left). `lens`, when
  // given, is a [0,1)² low-discrepancy sample for the aperture; otherwise the
  // lens point is drawn from the RNG.
  generateRay(s: number, t: number, rng: Rng, lens?: { x: number; y: number }): Ray {
    let origin = this.eye
    let target = add(this.lowerLeft, add(scale(this.horizontal, s), scale(this.vertical, t)))
    if (this.lensRadius > 0) {
      // A polygonal iris (blades ≥ 3) samples the n-gon for shaped bokeh; a
      // circular iris keeps the historical concentric-disk sampler bit-for-bit.
      const disk =
        this.blades >= 3
          ? lens
            ? sampleAperture(this.blades, this.bladeRot, lens.x, lens.y)
            : sampleAperture(this.blades, this.bladeRot, rng.next(), rng.next())
          : lens
            ? concentricDiskFrom(lens.x, lens.y)
            : concentricDisk(rng)
      const offset = add(scale(this.u, disk.x * this.lensRadius), scale(this.vv, disk.y * this.lensRadius))
      origin = add(this.eye, offset)
      target = sub(target, offset)
    }
    const dir = normalize(sub(target, origin))
    return { o: origin, d: dir, tMax: Infinity }
  }
}

// Orbit helper used by the UI: convert spherical orbit params to an eye point.
export function orbitEye(target: Vec3, radius: number, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch)
  const dir = v(cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw))
  return madd(target, dir, radius)
}
