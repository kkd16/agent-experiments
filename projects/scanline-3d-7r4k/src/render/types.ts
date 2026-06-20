// A vertex flowing through the pipeline carries its clip-space position plus the
// world-space attributes the fragment stage needs for lighting and texturing.
import type { Vec2, Vec3, Vec4 } from '../math/vec.ts'

export interface PipeVertex {
  clip: Vec4 // homogeneous clip-space position
  world: Vec3 // world-space position (for per-fragment lighting)
  normal: Vec3 // world-space normal
  tangent: Vec4 // world-space tangent (xyz) + handedness (w), for normal mapping
  uv: Vec2
}

export type RenderMode =
  | 'shaded'
  | 'albedo'
  | 'wireframe'
  | 'depth'
  | 'normals'
  | 'uv'
  | 'overdraw'
  | 'clip'
  // deferred G-buffer / screen-space debug views (v4)
  | 'position'
  | 'roughness'
  | 'ao'
  | 'reflections'

export interface FrameStats {
  trianglesIn: number
  trianglesDrawn: number
  trianglesCulled: number
  trianglesClipped: number
  pixelsFilled: number
  rtSamples: number // path-tracer samples/pixel (0 in raster mode)
  rtNodes: number // BVH node count (0 in raster mode)
}
