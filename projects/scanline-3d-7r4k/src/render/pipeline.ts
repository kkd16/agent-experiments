// The per-object vertex stage: transform a mesh into clip space, near-clip every
// triangle, then hand the survivors to the rasterizer (or draw their edges in
// wireframe mode).
import type { Mat4 } from '../math/mat4.ts'
import { multiply, normalMatrix, transformMat3, transformPoint, transformVec4 } from '../math/mat4.ts'
import { normalize } from '../math/vec.ts'
import type { Vec3 } from '../math/vec.ts'
import { clipNear } from './clip.ts'
import { Framebuffer } from './framebuffer.ts'
import { drawLine, rasterizeTriangle, screenOf } from './raster.ts'
import type { Uniforms } from './raster.ts'
import type { GBuffer } from './gbuffer.ts'
import type { Mesh } from '../geometry/mesh.ts'
import type { FrameStats, PipeVertex } from './types.ts'

export interface DrawObject {
  mesh: Mesh
  model: Mat4
  uniforms: Uniforms
}

const WIRE = Framebuffer.pack(0.5, 0.95, 0.7)
const WIRE_CLIPPED = Framebuffer.pack(1, 0.45, 0.4)

export function drawObject(
  fb: Framebuffer,
  view: Mat4,
  proj: Mat4,
  obj: DrawObject,
  cullBack: boolean,
  stats: FrameStats,
  gbuf: GBuffer | null = null,
): void {
  const { mesh, model, uniforms } = obj
  const mvp = multiply(proj, multiply(view, model))
  const nrm = normalMatrix(model)
  const idx = mesh.indices
  const verts = mesh.vertices

  // transform every vertex once
  const clipPos = new Array<PipeVertex>(verts.length)
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]
    // Tangents ride the model matrix's upper-left 3×3 (not the normal matrix) so
    // they stay glued to the surface; w carries the bitangent handedness.
    const tIn = v.tangent ?? [1, 0, 0, 1]
    const tw: Vec3 = normalize([
      model[0] * tIn[0] + model[4] * tIn[1] + model[8] * tIn[2],
      model[1] * tIn[0] + model[5] * tIn[1] + model[9] * tIn[2],
      model[2] * tIn[0] + model[6] * tIn[1] + model[10] * tIn[2],
    ])
    clipPos[i] = {
      clip: transformVec4(mvp, [v.position[0], v.position[1], v.position[2], 1]),
      world: transformPoint(model, v.position),
      normal: normalize(transformMat3(nrm, v.normal)),
      tangent: [tw[0], tw[1], tw[2], tIn[3]],
      uv: v.uv,
    }
  }

  for (let t = 0; t < idx.length; t += 3) {
    stats.trianglesIn++
    const tri = [clipPos[idx[t]], clipPos[idx[t + 1]], clipPos[idx[t + 2]]]
    const clipped = clipNear(tri)
    if (clipped.length < 3) continue
    const wasClipped = clipped.length !== 3
    const uni: Uniforms = wasClipped !== uniforms.wasClipped ? { ...uniforms, wasClipped } : uniforms

    // fan-triangulate the (3- or 4-vertex) clipped polygon
    for (let f = 1; f < clipped.length - 1; f++) {
      const a = clipped[0]
      const b = clipped[f]
      const c = clipped[f + 1]
      if (uni.mode === 'wireframe') {
        const wcol = wasClipped ? WIRE_CLIPPED : WIRE
        const sa = screenOf(a, fb.width, fb.height)
        const sb = screenOf(b, fb.width, fb.height)
        const sc = screenOf(c, fb.width, fb.height)
        drawLine(fb, sa[0], sa[1], sb[0], sb[1], wcol)
        drawLine(fb, sb[0], sb[1], sc[0], sc[1], wcol)
        drawLine(fb, sc[0], sc[1], sa[0], sa[1], wcol)
        stats.trianglesDrawn++
      } else {
        rasterizeTriangle(fb, [a, b, c], uni, stats, cullBack, gbuf)
      }
    }
    if (wasClipped) stats.trianglesClipped++
  }
}
