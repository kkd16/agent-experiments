// A vertex flowing through the pipeline carries its clip-space position plus the
// world-space attributes the fragment stage needs for lighting and texturing.
import type { Vec2, Vec3, Vec4 } from '../math/vec.ts'

export interface PipeVertex {
  clip: Vec4 // homogeneous clip-space position
  world: Vec3 // world-space position (for per-fragment lighting)
  normal: Vec3 // world-space normal
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

export interface FrameStats {
  trianglesIn: number
  trianglesDrawn: number
  trianglesCulled: number
  trianglesClipped: number
  pixelsFilled: number
}
