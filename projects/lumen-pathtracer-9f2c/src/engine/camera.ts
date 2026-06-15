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
}

export class Camera {
  private eye: Vec3
  private lowerLeft: Vec3
  private horizontal: Vec3
  private vertical: Vec3
  private u: Vec3
  private vv: Vec3
  private lensRadius: number

  constructor(def: CameraDef, aspect: number) {
    this.eye = def.eye
    this.lensRadius = def.aperture * 0.5
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
      const disk = lens ? concentricDiskFrom(lens.x, lens.y) : concentricDisk(rng)
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
