// In-app numerical self-tests for the implicit-modelling subsystem. Each check
// re-derives a claim from an independent reference: the primitive distances against
// closed-form geometry, the smooth-minimum against its defining inequality, and the
// marched mesh against analytic volume, against the Euler characteristic that pins down
// its topology (a sphere must give χ=2, a torus χ=0), and against the field gradient it
// is supposed to follow. Nothing here touches the DOM.
import type { Vec3 } from '../math/vec.ts'
import { sphere, box, torus, smin, union, subtract, gradient, type Sdf } from './sdf.ts'
import { marchingCubes, signedVolume, isWatertight } from './marchingcubes.ts'

export interface SdfTest {
  name: string
  pass: boolean
  detail: string
}

// Euler characteristic V − E + F of a triangle mesh.
function eulerChar(indices: number[], vertexCount: number): number {
  const edges = new Set<string>()
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2]
    const e = (x: number, y: number): void => { edges.add(x < y ? `${x}_${y}` : `${y}_${x}`) }
    e(a, b); e(b, c); e(c, a)
  }
  return vertexCount - edges.size + indices.length / 3
}

export function runSdfSelfTest(): SdfTest[] {
  const tests: SdfTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — primitive distances against closed form
  {
    const s = sphere(1)
    const b = box(0.5, 0.5, 0.5)
    const t = torus(0.7, 0.2)
    const okS = Math.abs(s(2, 0, 0) - 1) < 1e-9 && Math.abs(s(0, 0, 0) + 1) < 1e-9
    const okB = Math.abs(b(1, 0, 0) - 0.5) < 1e-9 && Math.abs(b(0, 0, 0) + 0.5) < 1e-9
    // a point 0.2 outside the tube, on the +x side of the ring
    const okT = Math.abs(t(0.7 + 0.2 + 0.1, 0, 0) - 0.1) < 1e-9
    add('Primitive distances', okS && okB && okT,
      `sphere(2,0,0)=${s(2, 0, 0).toFixed(3)}, box(1,0,0)=${b(1, 0, 0).toFixed(3)}, torus exact`)
  }

  // 2 — smooth-minimum is bounded above by min and reduces to it far from the seam
  {
    const a = 0.3, bb = 0.8, k = 0.2
    const m = smin(a, bb, k)
    const reduces = Math.abs(smin(a, bb + 5, k) - a) < 1e-9 // far apart → exact min
    const bounded = m <= Math.min(a, bb) + 1e-12 && m > Math.min(a, bb) - k
    const limit = Math.abs(smin(a, bb, 0) - Math.min(a, bb)) < 1e-12 // k→0 is hard min
    add('Smooth-minimum identity', reduces && bounded && limit,
      `smin=${m.toFixed(4)} ≤ min=${Math.min(a, bb).toFixed(4)}, reduces & limits hold`)
  }

  // 3 — CSG sign algebra: union = min, subtraction carves the second from the first
  {
    const s1 = sphere(1)
    const s2 = (x: number, y: number, z: number): number => sphere(1)(x - 0.5, y, z)
    const u = union(s1, s2)
    const d = subtract(s1, s2)
    // inside s2 only: union is inside (<0), difference is outside (>0)
    const okU = u(1.4, 0, 0) < 0
    const okD = d(1.4, 0, 0) > 0 && d(-0.9, 0, 0) < 0
    add('CSG union / subtract', okU && okD, 'union keeps both solids, subtract removes the tool')
  }

  // 4 — marching a sphere: watertight, on-surface, outward-wound, right volume
  {
    const r = 1.0
    const sdf: Sdf = { name: 's', f: sphere(r), bounds: { min: [-1.35, -1.35, -1.35], max: [1.35, 1.35, 1.35] } }
    const res = 40
    const out = marchingCubes(sdf, res, 0)
    let maxErr = 0
    for (const v of out.mesh.vertices) maxErr = Math.max(maxErr, Math.abs(Math.hypot(v.position[0], v.position[1], v.position[2]) - r))
    const cell = 2.7 / res
    const vol = signedVolume(out.mesh)
    const analytic = (4 / 3) * Math.PI * r ** 3
    const ratio = vol / analytic
    const ok = out.watertight && maxErr < cell && ratio > 0.985 && ratio < 1.005
    add('Marched sphere', ok,
      `watertight=${out.watertight}, max on-surface err=${maxErr.toFixed(4)}<${cell.toFixed(4)}, vol ratio=${ratio.toFixed(4)}`)
  }

  // 5 — topology by Euler characteristic: a sphere is χ=2, a torus χ=0 (genus 1)
  {
    const sSdf: Sdf = { name: 's', f: sphere(1), bounds: { min: [-1.35, -1.35, -1.35], max: [1.35, 1.35, 1.35] } }
    const tSdf: Sdf = { name: 't', f: torus(0.7, 0.28), bounds: { min: [-1.2, -0.5, -1.2], max: [1.2, 0.5, 1.2] } }
    const so = marchingCubes(sSdf, 36, 0)
    const to = marchingCubes(tSdf, 48, 0)
    const chiS = eulerChar(so.mesh.indices, so.vertexCount)
    const chiT = eulerChar(to.mesh.indices, to.vertexCount)
    add('Euler characteristic', chiS === 2 && chiT === 0,
      `sphere χ=${chiS} (want 2), torus χ=${chiT} (want 0 — genus 1)`)
  }

  // 6 — gradient normals: every marched-sphere normal points radially outward
  {
    const sdf: Sdf = { name: 's', f: sphere(1), bounds: { min: [-1.35, -1.35, -1.35], max: [1.35, 1.35, 1.35] } }
    const out = marchingCubes(sdf, 36, 0)
    let minDot = 1
    for (const v of out.mesh.vertices) {
      const l = Math.hypot(v.position[0], v.position[1], v.position[2]) || 1
      const d = (v.position[0] * v.normal[0] + v.position[1] * v.normal[1] + v.position[2] * v.normal[2]) / l
      minDot = Math.min(minDot, d)
    }
    add('Gradient normals', minDot > 0.999, `min(normal·radial)=${minDot.toFixed(5)} (want →1)`)
  }

  // 7 — central-difference gradient matches the analytic sphere gradient (= n̂)
  {
    const f = sphere(1)
    const p: Vec3 = [0.6, 0.5, 0.3]
    const g = gradient(f, p[0], p[1], p[2], 1e-4)
    const gl = Math.hypot(g[0], g[1], g[2])
    const pl = Math.hypot(p[0], p[1], p[2])
    const dotN = (g[0] * p[0] + g[1] * p[1] + g[2] * p[2]) / (gl * pl)
    add('Analytic gradient', Math.abs(gl - 1) < 1e-3 && dotN > 0.9999,
      `|∇f|=${gl.toFixed(4)} (unit), aligned with p̂ (${dotN.toFixed(5)})`)
  }

  // 8 — an entirely-positive field crosses nothing → an empty mesh
  {
    const sdf: Sdf = { name: 'far', f: sphere(0.2), bounds: { min: [2, 2, 2], max: [3, 3, 3] } }
    const out = marchingCubes(sdf, 16, 0)
    add('Empty field', out.triangleCount === 0 && !isWatertight([]),
      `no crossings → ${out.triangleCount} triangles`)
  }

  return tests
}
