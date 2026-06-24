// The world-space triangle soup the ray tracer sees. We flatten the live scene —
// every mesh transformed by its (animated) model matrix — into cache-friendly typed
// arrays: positions + precomputed edges for Möller–Trumbore, per-vertex normals,
// uv and tangent for shading, and a per-triangle material index into a small table.
// Emissive triangles are collected with their world areas so the path tracer can
// sample them as area lights.
import type { Mat4 } from '../math/mat4.ts'
import { normalMatrix, transformMat3, transformPoint } from '../math/mat4.ts'
import type { Vec3 } from '../math/vec.ts'
import type { Mesh } from '../geometry/mesh.ts'
import type { Material } from '../render/shading.ts'
import type { NormalMap, Texture } from '../render/texture.ts'
import { getFilmLUT } from './thinfilm.ts'
import type { FilmLUT } from './thinfilm.ts'

export interface RTMaterial {
  albedo: Vec3
  metallic: number
  roughness: number
  specular: number
  shininess: number
  emission: Vec3
  texture: Texture | null
  normalMap: NormalMap | null
  // dielectric transmission (v8)
  transmission: number // 0 = opaque, > 0 = glass (rough-dielectric BSDF)
  ior: number // index of refraction
  attenuation: Vec3 // Beer–Lambert absorption coeff inside the body (1/world-unit)
  dispersion: number // wavelength IOR spread (prism rainbow)
  // thin-film interference (v9): a baked cosθ→RGB reflectance LUT, or null when no coat
  filmThicknessNm: number
  filmIor: number
  filmLut: FilmLUT | null
}

export interface RTInstance {
  mesh: Mesh
  model: Mat4
  material: Material
  texture: Texture | null
  normalMap: NormalMap | null
}

function toRTMaterial(m: Material, texture: Texture | null, normalMap: NormalMap | null): RTMaterial {
  return {
    albedo: m.albedo,
    metallic: m.metallic ?? 0,
    roughness: Math.min(1, Math.max(0.02, m.roughness ?? 0.5)),
    specular: m.specular,
    shininess: m.shininess,
    emission: m.emission ?? [0, 0, 0],
    texture,
    normalMap,
    transmission: m.transmission ?? 0,
    ior: m.ior ?? 1.5,
    attenuation: m.attenuation ?? [0, 0, 0],
    dispersion: m.dispersion ?? 0,
    filmThicknessNm: m.filmThicknessNm ?? 0,
    filmIor: m.filmIor ?? 1.33,
    // bake the angle LUT once for the (thickness, film IOR, substrate IOR) triple
    filmLut: (m.filmThicknessNm ?? 0) > 0
      ? getFilmLUT(m.filmThicknessNm as number, m.filmIor ?? 1.33, m.ior ?? 1.5)
      : null,
  }
}

export class RTScene {
  readonly count: number
  // geometry (flat, 3 floats per vertex unless noted)
  readonly p0: Float32Array
  readonly e1: Float32Array
  readonly e2: Float32Array
  readonly n0: Float32Array
  readonly n1: Float32Array
  readonly n2: Float32Array
  readonly uv0: Float32Array // 2 floats / tri
  readonly uv1: Float32Array
  readonly uv2: Float32Array
  readonly tan: Float32Array // 4 floats / tri (world tangent xyz + handedness)
  readonly matIndex: Int32Array
  // per-triangle bounds + centroid for the BVH builder
  readonly triMin: Float32Array
  readonly triMax: Float32Array
  readonly centroid: Float32Array
  readonly materials: RTMaterial[]
  // emissive area lights
  readonly emissiveTris: number[] = []
  readonly emissiveArea: number[] = [] // cumulative area, for sampling by area
  totalEmissiveArea = 0

  constructor(instances: RTInstance[]) {
    let total = 0
    for (const inst of instances) total += inst.mesh.indices.length / 3
    this.count = total
    this.p0 = new Float32Array(total * 3)
    this.e1 = new Float32Array(total * 3)
    this.e2 = new Float32Array(total * 3)
    this.n0 = new Float32Array(total * 3)
    this.n1 = new Float32Array(total * 3)
    this.n2 = new Float32Array(total * 3)
    this.uv0 = new Float32Array(total * 2)
    this.uv1 = new Float32Array(total * 2)
    this.uv2 = new Float32Array(total * 2)
    this.tan = new Float32Array(total * 4)
    this.matIndex = new Int32Array(total)
    this.triMin = new Float32Array(total * 3)
    this.triMax = new Float32Array(total * 3)
    this.centroid = new Float32Array(total * 3)
    this.materials = []

    let tri = 0
    for (const inst of instances) {
      const matId = this.materials.length
      const rtm = toRTMaterial(inst.material, inst.texture, inst.normalMap)
      this.materials.push(rtm)
      const emissive = rtm.emission[0] + rtm.emission[1] + rtm.emission[2] > 1e-4

      const { mesh, model } = inst
      const nrm = normalMatrix(model)
      // world-space vertex attributes, computed once per vertex
      const vs = mesh.vertices
      const wp = new Array<Vec3>(vs.length)
      const wn = new Array<Vec3>(vs.length)
      const wt = new Array<[number, number, number, number]>(vs.length)
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i]
        wp[i] = transformPoint(model, v.position)
        const n = transformMat3(nrm, v.normal)
        const nl = Math.hypot(n[0], n[1], n[2]) || 1
        wn[i] = [n[0] / nl, n[1] / nl, n[2] / nl]
        const tIn = v.tangent ?? [1, 0, 0, 1]
        const tx = model[0] * tIn[0] + model[4] * tIn[1] + model[8] * tIn[2]
        const ty = model[1] * tIn[0] + model[5] * tIn[1] + model[9] * tIn[2]
        const tz = model[2] * tIn[0] + model[6] * tIn[1] + model[10] * tIn[2]
        const tl = Math.hypot(tx, ty, tz) || 1
        wt[i] = [tx / tl, ty / tl, tz / tl, tIn[3]]
      }

      const idx = mesh.indices
      for (let k = 0; k < idx.length; k += 3) {
        const ia = idx[k], ib = idx[k + 1], ic = idx[k + 2]
        const a = wp[ia], b = wp[ib], c = wp[ic]
        const o3 = tri * 3
        const o2 = tri * 2
        const o4 = tri * 4
        this.p0[o3] = a[0]; this.p0[o3 + 1] = a[1]; this.p0[o3 + 2] = a[2]
        const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
        const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2]
        this.e1[o3] = e1x; this.e1[o3 + 1] = e1y; this.e1[o3 + 2] = e1z
        this.e2[o3] = e2x; this.e2[o3 + 1] = e2y; this.e2[o3 + 2] = e2z
        const na = wn[ia], nb = wn[ib], nc = wn[ic]
        this.n0[o3] = na[0]; this.n0[o3 + 1] = na[1]; this.n0[o3 + 2] = na[2]
        this.n1[o3] = nb[0]; this.n1[o3 + 1] = nb[1]; this.n1[o3 + 2] = nb[2]
        this.n2[o3] = nc[0]; this.n2[o3 + 1] = nc[1]; this.n2[o3 + 2] = nc[2]
        this.uv0[o2] = vs[ia].uv[0]; this.uv0[o2 + 1] = vs[ia].uv[1]
        this.uv1[o2] = vs[ib].uv[0]; this.uv1[o2 + 1] = vs[ib].uv[1]
        this.uv2[o2] = vs[ic].uv[0]; this.uv2[o2 + 1] = vs[ic].uv[1]
        const ta = wt[ia]
        this.tan[o4] = ta[0]; this.tan[o4 + 1] = ta[1]; this.tan[o4 + 2] = ta[2]; this.tan[o4 + 3] = ta[3]
        this.matIndex[tri] = matId

        // bounds + centroid
        const minx = Math.min(a[0], b[0], c[0]), miny = Math.min(a[1], b[1], c[1]), minz = Math.min(a[2], b[2], c[2])
        const maxx = Math.max(a[0], b[0], c[0]), maxy = Math.max(a[1], b[1], c[1]), maxz = Math.max(a[2], b[2], c[2])
        this.triMin[o3] = minx; this.triMin[o3 + 1] = miny; this.triMin[o3 + 2] = minz
        this.triMax[o3] = maxx; this.triMax[o3 + 1] = maxy; this.triMax[o3 + 2] = maxz
        this.centroid[o3] = (minx + maxx) * 0.5
        this.centroid[o3 + 1] = (miny + maxy) * 0.5
        this.centroid[o3 + 2] = (minz + maxz) * 0.5

        if (emissive) {
          // world area = ½|e1 × e2|
          const cx = e1y * e2z - e1z * e2y
          const cy = e1z * e2x - e1x * e2z
          const cz = e1x * e2y - e1y * e2x
          const area = 0.5 * Math.hypot(cx, cy, cz)
          if (area > 1e-9) {
            this.totalEmissiveArea += area
            this.emissiveTris.push(tri)
            this.emissiveArea.push(this.totalEmissiveArea)
          }
        }
        tri++
      }
    }
  }
}
