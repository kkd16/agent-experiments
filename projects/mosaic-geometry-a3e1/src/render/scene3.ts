import type { Vec3 } from '../geometry/vector3'
import { sub3, add3, scale3, cross3, dot3, normalize3, len3 } from '../geometry/vector3'

// A tiny from-scratch software 3-D renderer — no WebGL, no 3-D library. It projects,
// depth-sorts and flat-shades primitives by hand into the same 2-D canvas the rest of
// the studio draws to. An orbit camera (yaw/pitch/distance) looks at a target; every
// primitive (face / segment / point) is projected to screen space, sorted back-to-front
// (painter's algorithm) and painted, with faces optionally back-face culled and
// Lambert-shaded from a fixed key light. Good enough for the convex, mostly-star-shaped
// scenes the Space axis renders (hulls, tetra meshes, Voronoi foam).

export interface Camera {
  yaw: number // radians, orbit around world up
  pitch: number // radians, clamped to ±~85°
  dist: number // eye distance from target
  fov: number // vertical field of view, radians
  target: Vec3
}

export function makeCamera(target: Vec3, radius: number, yaw = 0.6, pitch = 0.5): Camera {
  const fov = (50 * Math.PI) / 180
  const dist = (radius * 1.4) / Math.tan(fov / 2) + radius
  return { yaw, pitch, dist, fov, target }
}

export type RGB = [number, number, number]

interface Basis {
  eye: Vec3
  right: Vec3
  up: Vec3
  forward: Vec3
}

/** Camera orbit direction & orthonormal basis (a hand-rolled look-at). */
export function basisOf(cam: Camera): Basis {
  const cp = Math.cos(cam.pitch)
  const dir: Vec3 = {
    x: cp * Math.sin(cam.yaw),
    y: Math.sin(cam.pitch),
    z: cp * Math.cos(cam.yaw),
  }
  const eye = add3(cam.target, scale3(dir, cam.dist))
  const forward = normalize3(sub3(cam.target, eye))
  const worldUp: Vec3 = Math.abs(forward.y) > 0.999 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }
  const right = normalize3(cross3(forward, worldUp))
  const up = cross3(right, forward)
  return { eye, right, up, forward }
}

export interface Projected {
  x: number
  y: number
  depth: number // camera-space distance in front of the eye (>0 visible)
  ok: boolean
}

export function project(b: Basis, cam: Camera, p: Vec3, width: number, height: number): Projected {
  const rel = sub3(p, b.eye)
  const cz = dot3(rel, b.forward)
  if (cz <= 1e-4) return { x: 0, y: 0, depth: cz, ok: false }
  const cx = dot3(rel, b.right)
  const cy = dot3(rel, b.up)
  const f = height / 2 / Math.tan(cam.fov / 2)
  return { x: width / 2 + (f * cx) / cz, y: height / 2 - (f * cy) / cz, depth: cz, ok: true }
}

// ── Primitives ────────────────────────────────────────────────────────────────
export interface FacePrim {
  kind: 'face'
  a: Vec3
  b: Vec3
  c: Vec3
  color: RGB
  opacity?: number
  cull?: boolean // back-face cull (default true)
  stroke?: string // optional edge stroke
}
export interface SegPrim {
  kind: 'seg'
  a: Vec3
  b: Vec3
  color: string
  width?: number
  dash?: number[]
}
export interface PointPrim {
  kind: 'point'
  p: Vec3
  color: string
  r: number
  ring?: string
}
export type Prim = FacePrim | SegPrim | PointPrim

export interface LightOpts {
  dir?: Vec3 // world direction the light travels toward
  ambient?: number
}

const DEFAULT_LIGHT: Required<LightOpts> = {
  dir: normalize3({ x: -0.4, y: -0.8, z: -0.5 }),
  ambient: 0.32,
}

function shade(color: RGB, normal: Vec3, light: Required<LightOpts>): string {
  // Two-sided Lambert so faces read whichever way their winding points.
  const nl = Math.abs(dot3(normal, light.dir))
  const k = light.ambient + (1 - light.ambient) * nl
  const r = Math.min(255, Math.round(color[0] * k))
  const g = Math.min(255, Math.round(color[1] * k))
  const bch = Math.min(255, Math.round(color[2] * k))
  return `rgb(${r},${g},${bch})`
}

/**
 * Paint a mixed primitive list into `ctx`, back-to-front. The 2-D transform is
 * assumed already set to CSS-pixel space (dpr applied by the caller).
 */
export function paintScene(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  width: number,
  height: number,
  prims: Prim[],
  light: LightOpts = {},
): void {
  const b = basisOf(cam)
  const L: Required<LightOpts> = { dir: light.dir ?? DEFAULT_LIGHT.dir, ambient: light.ambient ?? DEFAULT_LIGHT.ambient }

  interface Draw {
    depth: number
    paint: () => void
  }
  const draws: Draw[] = []

  for (const prim of prims) {
    if (prim.kind === 'face') {
      const pa = project(b, cam, prim.a, width, height)
      const pb = project(b, cam, prim.b, width, height)
      const pc = project(b, cam, prim.c, width, height)
      if (!pa.ok || !pb.ok || !pc.ok) continue
      const nWorld = cross3(sub3(prim.b, prim.a), sub3(prim.c, prim.a))
      if (len3(nWorld) < 1e-18) continue
      const nrm = normalize3(nWorld)
      const centroid = { x: (prim.a.x + prim.b.x + prim.c.x) / 3, y: (prim.a.y + prim.b.y + prim.c.y) / 3, z: (prim.a.z + prim.b.z + prim.c.z) / 3 }
      const toEye = sub3(b.eye, centroid)
      const facing = dot3(nrm, toEye) // >0 → front-facing
      if ((prim.cull ?? true) && facing <= 0) continue
      const fill = shade(prim.color, nrm, L)
      const opacity = prim.opacity ?? 1
      const stroke = prim.stroke
      draws.push({
        depth: (pa.depth + pb.depth + pc.depth) / 3,
        paint: () => {
          ctx.beginPath()
          ctx.moveTo(pa.x, pa.y)
          ctx.lineTo(pb.x, pb.y)
          ctx.lineTo(pc.x, pc.y)
          ctx.closePath()
          ctx.globalAlpha = opacity
          ctx.fillStyle = fill
          ctx.fill()
          if (stroke) {
            ctx.globalAlpha = opacity
            ctx.lineWidth = 1
            ctx.strokeStyle = stroke
            ctx.stroke()
          }
          ctx.globalAlpha = 1
        },
      })
    } else if (prim.kind === 'seg') {
      const pa = project(b, cam, prim.a, width, height)
      const pb = project(b, cam, prim.b, width, height)
      if (!pa.ok || !pb.ok) continue
      const color = prim.color
      const w = prim.width ?? 1.2
      const dash = prim.dash
      draws.push({
        depth: (pa.depth + pb.depth) / 2,
        paint: () => {
          ctx.beginPath()
          ctx.moveTo(pa.x, pa.y)
          ctx.lineTo(pb.x, pb.y)
          ctx.lineWidth = w
          ctx.strokeStyle = color
          ctx.lineCap = 'round'
          if (dash) ctx.setLineDash(dash)
          ctx.stroke()
          if (dash) ctx.setLineDash([])
        },
      })
    } else {
      const pp = project(b, cam, prim.p, width, height)
      if (!pp.ok) continue
      const color = prim.color
      const rr = prim.r
      const ring = prim.ring
      draws.push({
        depth: pp.depth,
        paint: () => {
          ctx.beginPath()
          ctx.arc(pp.x, pp.y, rr, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
          if (ring) {
            ctx.lineWidth = 1.5
            ctx.strokeStyle = ring
            ctx.stroke()
          }
        },
      })
    }
  }

  draws.sort((u, v) => v.depth - u.depth) // far → near
  for (const d of draws) d.paint()
}
