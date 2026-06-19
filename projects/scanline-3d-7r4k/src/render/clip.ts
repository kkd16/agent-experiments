// Near-plane clipping in homogeneous clip space (Sutherland–Hodgman). A vertex
// is in front of the near plane when z + w ≥ 0; clipping there before the
// perspective divide is what keeps w strictly positive so the divide is safe and
// geometry straddling the camera doesn't smear across the screen.
import type { Vec2, Vec3, Vec4 } from '../math/vec.ts'
import type { PipeVertex } from './types.ts'

const lerpVertex = (a: PipeVertex, b: PipeVertex, t: number): PipeVertex => {
  const mix2 = (p: Vec2, q: Vec2): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
  const mix3 = (p: Vec3, q: Vec3): Vec3 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
  ]
  const mix4 = (p: Vec4, q: Vec4): Vec4 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
    p[3] + (q[3] - p[3]) * t,
  ]
  return {
    clip: mix4(a.clip, b.clip),
    world: mix3(a.world, b.world),
    normal: mix3(a.normal, b.normal),
    tangent: mix4(a.tangent, b.tangent),
    uv: mix2(a.uv, b.uv),
  }
}

const NEAR_EPS = 1e-5
const dist = (v: PipeVertex): number => v.clip[2] + v.clip[3] // z + w

// Returns the clipped polygon as a fan-ready vertex list (possibly empty). The
// input is one triangle; output may have 0, 3 or 4 vertices.
export const clipNear = (tri: PipeVertex[]): PipeVertex[] => {
  const out: PipeVertex[] = []
  const n = tri.length
  for (let i = 0; i < n; i++) {
    const cur = tri[i]
    const nxt = tri[(i + 1) % n]
    const dc = dist(cur)
    const dn = dist(nxt)
    const curIn = dc >= -NEAR_EPS
    const nxtIn = dn >= -NEAR_EPS
    if (curIn) out.push(cur)
    if (curIn !== nxtIn) {
      const t = dc / (dc - dn)
      out.push(lerpVertex(cur, nxt, t))
    }
  }
  return out
}
