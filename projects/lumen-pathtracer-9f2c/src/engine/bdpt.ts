// bdpt.ts — a bidirectional path tracer (Veach–Guibas) behind the very same
// `(scene, ray, settings, rng, stats, gbuf)` contract as the unidirectional
// integrator in `integrator.ts`.
//
// Why bidirectional. The unidirectional tracer only ever grows a path from the
// camera and finds light by next-event estimation. That is unbiased but slow
// whenever the light that matters is hard to reach from the visible surfaces —
// an emitter aimed at a wall (indirect-only rooms), a bulb inside a fixture,
// glossy interreflection. BDPT also grows a path *from a light* and then
// *connects* every camera-path vertex to every light-path vertex. Each (s,t)
// connection is one way of sampling a full transport path; multiple importance
// sampling (the balance heuristic) blends them so the technique best suited to
// each regime dominates. Crucially BDPT estimates the *same* rendering equation
// as the path tracer, so the two converge to the same image — the verification
// suite uses exactly that as an oracle.
//
// What this implementation does (and doesn't). It is "BDPT without light
// tracing": the camera subpath length is t ≥ 2, so every connection lands in the
// *current* pixel and the existing band-worker render loop needs no changes. The
// camera (lens) vertex is marked as a delta endpoint, which also removes the
// t = 1 technique from the MIS partition, keeping the remaining techniques a
// valid partition of unity (still unbiased, still matches the path tracer). The
// only transport it forgoes is paths reachable *solely* by light tracing (e.g. a
// caustic seen directly), which plain NEE misses too. Participating media and
// spectral dispersion are handled only by the unidirectional integrator; BDPT
// runs achromatically on surface transport (delta glass/mirror vertices are
// transported through but never connected, exactly as their physics demands).

import type { Vec3 } from './vec3'
import { add, dot, isBlack, madd, mul, neg, normalize, onb, scale, sub, toWorld, v } from './vec3'
import { makeRay } from './ray'
import type { Ray } from './ray'
import type { Scene } from './scene'
import type { Rng } from './rng'
import { cosineHemisphere } from './rng'
import type { Material } from './material'
import { evalBSDF, isDelta, pdfBSDF, resolveMaterial, sampleBSDF } from './material'
import type { Triangle } from './primitive'
import type { IntegratorSettings } from './types'
import type { GBuffer, RayStats } from './integrator'

const EPS = 1e-4

// One vertex on a subpath. Both subpaths share this record. Forward/reverse pdfs
// are stored in *area measure* (probability per unit surface area), which is what
// the MIS recurrence needs; the random walk converts each bounce's solid-angle
// pdf to area as the path is built.
interface Vertex {
  kind: 'camera' | 'light' | 'surface'
  p: Vec3 // world position
  ng: Vec3 // geometric normal (emitters: the winding/front normal). |cos| only.
  ns: Vec3 // shading normal, oriented to face `wo` (the incoming side)
  wo: Vec3 // unit direction from this vertex toward the previous one
  beta: Vec3 // path throughput carried *to* this vertex
  pdfFwd: number // area density of sampling this vertex from the previous one
  pdfRev: number // area density of sampling the previous vertex from this one
  delta: boolean // delta (specular) BSDF / camera endpoint — never connectible
  isLight: boolean // this surface is an emitter (or the light endpoint)
  material: Material | null // resolved material (null for the camera endpoint)
  primId: number // primitive index (for emitter area / emission), -1 otherwise
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Convert a solid-angle (directional) pdf measured at `fromP` into an area pdf at
// a surface point `toP` (normal `toNg`): dω = dA·|cosθ_to| / d², so
// pdf_A = pdf_ω·|cosθ_to| / d².
function convertDensity(pdfDir: number, fromP: Vec3, toP: Vec3, toNg: Vec3): number {
  const dx = toP.x - fromP.x
  const dy = toP.y - fromP.y
  const dz = toP.z - fromP.z
  const dist2 = dx * dx + dy * dy + dz * dz
  if (dist2 === 0) return 0
  const inv = 1 / Math.sqrt(dist2)
  const cos = Math.abs(toNg.x * dx + toNg.y * dy + toNg.z * dz) * inv
  return (pdfDir * cos) / dist2
}

// The geometry term G(a,b) = |cosθ_a|·|cosθ_b| / d², with the visibility V(a,b)
// resolved by a shadow ray. 0 when occluded or back-facing past tolerance.
function geometry(scene: Scene, a: Vertex, b: Vertex, stats: RayStats): number {
  const d = sub(b.p, a.p)
  const dist2 = dot(d, d)
  if (dist2 <= 0) return 0
  const dist = Math.sqrt(dist2)
  const w = scale(d, 1 / dist)
  const cosA = Math.abs(dot(a.ns, w))
  const cosB = Math.abs(dot(b.ns, w))
  if (cosA === 0 || cosB === 0) return 0
  const o = madd(a.p, a.ng, dot(a.ng, w) > 0 ? EPS : -EPS)
  stats.rays++
  if (scene.occluded(o, w, EPS, dist - 1e-3)) return 0
  return (cosA * cosB) / dist2
}

// Cosine-weighted area-light emission densities at a light vertex `lv` toward a
// surface vertex `next`: the directional pdf is cos⁺/π, converted to area at next.
function pdfLight(lv: Vertex, next: Vertex): number {
  const d = sub(next.p, lv.p)
  const dist2 = dot(d, d)
  if (dist2 <= 0) return 0
  const inv = 1 / Math.sqrt(dist2)
  const w = scale(d, inv)
  const cosL = Math.max(0, dot(lv.ng, w))
  const pdfDir = cosL / Math.PI
  const cosN = Math.abs(dot(next.ng, w))
  return (pdfDir * cosN) / dist2
}

// Area density of *choosing* this light point as a path origin: uniform over the
// emissive triangles and uniform over the chosen triangle's area.
function pdfLightOrigin(scene: Scene, lv: Vertex): number {
  const nL = scene.lights.length
  if (nL === 0) return 0
  const tri = scene.prims[lv.primId] as Triangle
  return 1 / (tri.area * nL)
}

// Directional BSDF pdf of scattering through `v` from the direction toward
// `prev` to the direction toward `next`, converted to an area density at `next`.
function vertexPdf(v: Vertex, prev: Vertex | null, next: Vertex): number {
  if (v.kind === 'light') return pdfLight(v, next)
  if (v.kind === 'camera' || v.material === null) return 0 // never queried for t ≥ 2
  const wp = prev ? normalize(sub(prev.p, v.p)) : v.wo
  const wn = normalize(sub(next.p, v.p))
  const pdfDir = pdfBSDF(v.material, wp, wn, v.ns)
  return convertDensity(pdfDir, v.p, next.p, next.ng)
}

const emission = (m: Material | null): Vec3 =>
  m && m.kind === 'emissive' ? m.emission : v(0, 0, 0)

// ---------------------------------------------------------------------------
// Subpath construction
// ---------------------------------------------------------------------------

// Grow a subpath by random walk. `verts` already holds the endpoint vertex; we
// shoot `ray`, and at each surface append a vertex, accumulating throughput and
// the area-measure forward/reverse densities. `mode` only affects nothing here
// (shading-normal transport correction is omitted — Lumen's BDPT scenes use flat
// geometry where shading == geometric normals). Returns the escaped environment
// radiance (camera subpath only), gathered by BSDF sampling with MIS weight 1.
function randomWalk(
  scene: Scene,
  ray0: { o: Vec3; d: Vec3 },
  beta0: Vec3,
  pdfDir0: number,
  maxVerts: number,
  rng: Rng,
  stats: RayStats,
  verts: Vertex[],
  gbuf: GBuffer | undefined,
): Vec3 {
  let beta = beta0
  let pdfFwd = pdfDir0 // directional pdf of the current ray's direction
  let r = makeRay(ray0.o, ray0.d)
  let escaped = v(0, 0, 0)
  let captured = false

  while (verts.length < maxVerts) {
    stats.rays++
    const hit = scene.intersect(r)
    if (!hit) {
      escaped = mul(beta, scene.envRadiance(r.d))
      if (gbuf && !captured) {
        gbuf.albedo = scene.envRadiance(r.d)
        gbuf.normal = neg(r.d)
      }
      break
    }
    const prev = verts[verts.length - 1]
    const rawMat = scene.materials[hit.material]
    const mat = resolveMaterial(rawMat, hit.p, 0)
    const prim = scene.prims[hit.primId]
    const isEmit = rawMat.kind === 'emissive'
    // Emitters store their *winding* (front) normal so emission is one-sided and
    // consistent with the light sampler; |cos| keeps convert/G orientation-free.
    const ng = isEmit && prim.kind === 'triangle' ? (prim as Triangle).ng : hit.ng
    const vert: Vertex = {
      kind: 'surface',
      p: hit.p,
      ng,
      ns: hit.n,
      wo: neg(r.d),
      beta,
      pdfFwd: convertDensity(pdfFwd, prev.p, hit.p, hit.ng),
      pdfRev: 0,
      delta: isDelta(mat),
      isLight: isEmit,
      material: mat,
      primId: hit.primId,
    }
    verts.push(vert)

    if (gbuf && !captured) {
      gbuf.albedo = albedoGuide(mat)
      gbuf.normal = hit.n
      captured = true
    }

    if (isEmit) break // emitters do not scatter further
    if (verts.length >= maxVerts) break

    const bs = sampleBSDF(mat, vert.wo, hit.n, hit.frontFace, rng)
    if (!bs || bs.pdf <= 0 || isBlack(bs.weight)) break
    const pdfRevDir = bs.specular ? 0 : pdfBSDF(mat, bs.wi, vert.wo, hit.n)
    pdfFwd = bs.specular ? 0 : bs.pdf
    beta = mul(beta, bs.weight)
    // Back-fill the previous vertex's reverse area density (sampling it *from*
    // this vertex along the just-chosen scattering direction).
    prev.pdfRev = convertDensity(pdfRevDir, vert.p, prev.p, prev.ng)
    r = makeRay(madd(hit.p, hit.ng, dot(hit.ng, bs.wi) > 0 ? EPS : -EPS), bs.wi)
  }
  return escaped
}

function albedoGuide(m: Material): Vec3 {
  switch (m.kind) {
    case 'diffuse':
    case 'metal':
      return m.albedo
    case 'dielectric':
      return v(0.9, 0.95, 1)
    case 'thinfilm':
      return m.base ?? v(0.85, 0.85, 0.95)
    case 'emissive':
      return v(1, 1, 1)
  }
}

interface CameraWalk {
  verts: Vertex[]
  escaped: Vec3
}

function cameraSubpath(
  scene: Scene,
  ray: { o: Vec3; d: Vec3 },
  maxVerts: number,
  rng: Rng,
  stats: RayStats,
  gbuf: GBuffer | undefined,
): CameraWalk {
  const verts: Vertex[] = [
    {
      kind: 'camera',
      p: ray.o,
      ng: ray.d,
      ns: ray.d,
      wo: ray.d,
      beta: v(1, 1, 1),
      pdfFwd: 1, // irrelevant for t ≥ 2 (see file header / journal)
      pdfRev: 0,
      delta: true, // a pinhole lens is a delta endpoint → removes the t=1 strategy
      isLight: false,
      material: null,
      primId: -1,
    },
  ]
  // The first camera vertex (camera[1]) inherits primary throughput 1 and a
  // placeholder forward pdf of 1, which the MIS recurrence never reads.
  const escaped = randomWalk(scene, ray, v(1, 1, 1), 1, maxVerts, rng, stats, verts, gbuf)
  return { verts, escaped }
}

function lightSubpath(scene: Scene, maxVerts: number, rng: Rng, stats: RayStats): Vertex[] {
  const verts: Vertex[] = []
  const nL = scene.lights.length
  if (nL === 0) return verts
  const li = scene.lights[rng.int(nL)]
  const tri = scene.prims[li] as Triangle
  // Uniform point on the triangle.
  const su = Math.sqrt(rng.next())
  const bu = 1 - su
  const bv = rng.next() * su
  const p = madd(madd(tri.p0, tri.e1, bu), tri.e2, bv)
  const Le = emission(scene.materials[tri.material])
  const pdfPos = 1 / tri.area
  const pdfChoice = 1 / nL

  verts.push({
    kind: 'light',
    p,
    ng: tri.ng,
    ns: tri.ng,
    wo: tri.ng,
    beta: Le,
    pdfFwd: pdfPos * pdfChoice,
    pdfRev: 0,
    delta: false,
    isLight: true,
    material: scene.materials[tri.material],
    primId: li,
  })
  if (maxVerts <= 1 || isBlack(Le)) return verts

  // Cosine-weighted emission direction about the front normal.
  const local = cosineHemisphere(rng)
  const { t, b } = onb(tri.ng)
  const dir = normalize(toWorld(local, t, b, tri.ng))
  const cos = local.z
  const pdfDir = cos / Math.PI
  if (pdfDir <= 0) return verts
  // β for the walk: Lₑ·cosθ / (pdfChoice·pdfPos·pdfDir).
  const beta = scale(Le, cos / (pdfChoice * pdfPos * pdfDir))
  const o = madd(p, tri.ng, EPS)
  randomWalk(scene, { o, d: dir }, beta, pdfDir, maxVerts, rng, stats, verts, undefined)
  return verts
}

// ---------------------------------------------------------------------------
// MIS — a faithful port of pbrt's balance-heuristic BDPT weight. `sampledLight`
// (for s == 1) temporarily replaces light[0]. The four connection-time reverse
// densities are overridden then restored, so the subpath vertices stay reusable
// across the other strategies of the same camera/light path pair.
// ---------------------------------------------------------------------------

const remap0 = (f: number): number => (f !== 0 ? f : 1)

function misWeight(
  scene: Scene,
  cam: Vertex[],
  light: Vertex[],
  s: number,
  t: number,
  sampledLight: Vertex | null,
): number {
  if (s + t === 2) return 1

  const pt = cam[t - 1]
  const ptMinus = t >= 2 ? cam[t - 2] : null
  // For s == 1 the connection uses a freshly sampled light point in place of
  // light[0]; everywhere below `qs`/`qsMinus` read from this view.
  const qs = s >= 1 ? (s === 1 ? sampledLight! : light[s - 1]) : null
  const qsMinus = s >= 2 ? light[s - 2] : null

  // Save the fields we are about to override.
  const save = {
    ptDelta: pt.delta,
    ptRev: pt.pdfRev,
    qsDelta: qs ? qs.delta : false,
    qsRev: qs ? qs.pdfRev : 0,
    ptMinusRev: ptMinus ? ptMinus.pdfRev : 0,
    qsMinusRev: qsMinus ? qsMinus.pdfRev : 0,
  }

  pt.delta = false
  if (qs) qs.delta = false

  // pt.pdfRev — area density of sampling pt from the light side.
  pt.pdfRev = qs
    ? vertexPdf(qs, qsMinus, pt)
    : pdfLightOrigin(scene, pt) // s == 0: pt is itself the light origin
  // ptMinus.pdfRev — sampling ptMinus from pt along the connection direction.
  if (ptMinus) {
    ptMinus.pdfRev = qs ? vertexPdf(pt, qs, ptMinus) : pdfLight(pt, ptMinus)
  }
  // qs / qsMinus reverse densities — sampling them from the camera side.
  if (qs) qs.pdfRev = vertexPdf(pt, ptMinus, qs)
  if (qsMinus) qsMinus.pdfRev = vertexPdf(qs!, pt, qsMinus)

  let sumRi = 0
  // Camera side: walk from the connection vertex back toward the lens.
  let ri = 1
  for (let i = t - 1; i > 0; i--) {
    ri *= remap0(cam[i].pdfRev) / remap0(cam[i].pdfFwd)
    if (!cam[i].delta && !cam[i - 1].delta) sumRi += ri
  }
  // Light side: walk from the connection vertex back toward the emitter.
  ri = 1
  for (let i = s - 1; i >= 0; i--) {
    const vi = i === s - 1 && s >= 1 ? qs! : light[i]
    ri *= remap0(vi.pdfRev) / remap0(vi.pdfFwd)
    const prevDelta = i > 0 ? light[i - 1].delta : false // area lights aren't delta
    if (!vi.delta && !prevDelta) sumRi += ri
  }

  // Restore.
  pt.delta = save.ptDelta
  pt.pdfRev = save.ptRev
  if (qs) {
    qs.delta = save.qsDelta
    qs.pdfRev = save.qsRev
  }
  if (ptMinus) ptMinus.pdfRev = save.ptMinusRev
  if (qsMinus) qsMinus.pdfRev = save.qsMinusRev

  return 1 / (1 + sumRi)
}

// ---------------------------------------------------------------------------
// Connection strategies
// ---------------------------------------------------------------------------

// Sample a point on an emissive triangle as seen from `refP` (BDPT's s == 1 ≡
// next-event estimation), uniform over triangles and their area. Triangle-only
// so it shares the light-subpath's MIS partition; the environment is gathered on
// camera escape instead.
function bdptSampleLight(
  scene: Scene,
  refP: Vec3,
  rng: Rng,
): { wi: Vec3; dist: number; radiance: Vec3; pdf: number; vertex: Vertex } | null {
  const nL = scene.lights.length
  if (nL === 0) return null
  const li = scene.lights[rng.int(nL)]
  const tri = scene.prims[li] as Triangle
  const su = Math.sqrt(rng.next())
  const bu = 1 - su
  const bv = rng.next() * su
  const p = madd(madd(tri.p0, tri.e1, bu), tri.e2, bv)
  const toL = sub(p, refP)
  const dist2 = dot(toL, toL)
  if (dist2 < 1e-10) return null
  const dist = Math.sqrt(dist2)
  const wi = scale(toL, 1 / dist)
  const cosL = dot(tri.ng, neg(wi))
  if (cosL <= 1e-6) return null // light faces away
  const pdfArea = 1 / (tri.area * nL)
  const pdf = (pdfArea * dist2) / cosL // → solid angle
  const vertex: Vertex = {
    kind: 'light',
    p,
    ng: tri.ng,
    ns: tri.ng,
    wo: tri.ng,
    beta: v(0, 0, 0),
    pdfFwd: pdfArea, // light-origin area density (for MIS)
    pdfRev: 0,
    delta: false,
    isLight: true,
    material: scene.materials[tri.material],
    primId: li,
  }
  return { wi, dist, radiance: emission(scene.materials[tri.material]), pdf, vertex }
}

// Evaluate one (s,t) connection, returning its MIS-weighted radiance.
function connect(
  scene: Scene,
  cam: Vertex[],
  light: Vertex[],
  s: number,
  t: number,
  rng: Rng,
  stats: RayStats,
): Vec3 {
  const pt = cam[t - 1]

  // s == 0 — the camera subpath hit an emitter on its own.
  if (s === 0) {
    if (!pt.isLight) return v(0, 0, 0)
    if (dot(pt.ng, pt.wo) <= 0) return v(0, 0, 0) // front face toward the camera
    const L = mul(pt.beta, emission(pt.material))
    if (isBlack(L)) return v(0, 0, 0)
    return scale(L, misWeight(scene, cam, light, 0, t, null))
  }

  // The camera endpoint must be connectible for any s ≥ 1.
  if (pt.delta || pt.material === null) return v(0, 0, 0)

  // s == 1 — connect the camera vertex to a freshly sampled light point (NEE).
  if (s === 1) {
    const ls = bdptSampleLight(scene, pt.p, rng)
    if (!ls || ls.pdf <= 0 || isBlack(ls.radiance)) return v(0, 0, 0)
    const f = evalBSDF(pt.material, pt.wo, ls.wi, pt.ns)
    if (isBlack(f)) return v(0, 0, 0)
    const cos = Math.abs(dot(pt.ns, ls.wi))
    const o = madd(pt.p, pt.ng, dot(pt.ng, ls.wi) > 0 ? EPS : -EPS)
    stats.rays++
    if (scene.occluded(o, ls.wi, EPS, ls.dist - 1e-3)) return v(0, 0, 0)
    const L = scale(mul(mul(pt.beta, f), ls.radiance), cos / ls.pdf)
    if (isBlack(L)) return v(0, 0, 0)
    return scale(L, misWeight(scene, cam, light, 1, t, ls.vertex))
  }

  // s ≥ 2 — general vertex-to-vertex connection.
  const qs = light[s - 1]
  if (qs.delta || qs.material === null || isBlack(qs.beta)) return v(0, 0, 0)
  const dir = normalize(sub(pt.p, qs.p)) // qs → pt
  const fLight = evalBSDF(qs.material, qs.wo, dir, qs.ns)
  if (isBlack(fLight)) return v(0, 0, 0)
  const fCam = evalBSDF(pt.material, pt.wo, neg(dir), pt.ns)
  if (isBlack(fCam)) return v(0, 0, 0)
  const g = geometry(scene, qs, pt, stats)
  if (g === 0) return v(0, 0, 0)
  const L = scale(mul(mul(qs.beta, fLight), mul(fCam, pt.beta)), g)
  if (isBlack(L)) return v(0, 0, 0)
  return scale(L, misWeight(scene, cam, light, s, t, null))
}

// ---------------------------------------------------------------------------
// Public entry point — same signature as `radiance` in integrator.ts.
// ---------------------------------------------------------------------------

export function radianceBDPT(
  scene: Scene,
  ray: Ray,
  settings: IntegratorSettings,
  rng: Rng,
  stats: RayStats,
  gbuf?: GBuffer,
): Vec3 {
  const maxDepth = settings.maxDepth
  // Camera path can have up to maxDepth+1 surface vertices (+ the lens); light
  // path up to maxDepth surface vertices (+ the emitter). A connection's path
  // length is s + t - 2 edges, which we cap at maxDepth.
  const camMax = maxDepth + 2
  const lightMax = maxDepth + 1

  const { verts: cam, escaped } = cameraSubpath(scene, ray, camMax, rng, stats, gbuf)
  const light = lightSubpath(scene, lightMax, rng, stats)

  let L = escaped // environment seen along the camera path (weight 1)
  const nc = cam.length
  const nl = light.length
  for (let t = 2; t <= nc; t++) {
    for (let s = 0; s <= nl; s++) {
      const depth = s + t - 2
      if (depth < 0 || depth > maxDepth) continue
      const c = connect(scene, cam, light, s, t, rng, stats)
      if (!isBlack(c)) L = add(L, c)
    }
  }

  if (!Number.isFinite(L.x) || !Number.isFinite(L.y) || !Number.isFinite(L.z)) {
    return v(0, 0, 0)
  }
  return L
}

// ---------------------------------------------------------------------------
// Verification hooks (used by the self-test suite).
// ---------------------------------------------------------------------------

// The solid-angle → area density conversion BDPT depends on, exposed for tests.
export function areaDensity(pdfDir: number, fromP: Vec3, toP: Vec3, toNg: Vec3): number {
  return convertDensity(pdfDir, fromP, toP, toNg)
}

// Multiple importance sampling must form a *partition of unity*: for any single
// light-transport path, the MIS weights of every strategy able to sample it sum
// to exactly 1 — that is what makes the bidirectional estimator unbiased. This
// builds a fixed diffuse path E→A→B→L (camera, two surfaces, an area light) and
// returns |Σ w(s,t) − 1| over the three connection strategies with t ≥ 2:
// (t=4,s=0) the camera path hits the light, (t=3,s=1) ≡ next-event estimation,
// and (t=2,s=2) a vertex-to-vertex connection. A correct recurrence drives the
// residual to ~1e-16.
export function misPartitionResidual(scene: Scene): number {
  const E = v(0, 1, -3) // camera
  const A = v(0, 0, 0) // floor vertex (up normal)
  const B = v(1, 1.5, 3) // back-wall vertex (−z normal) — non-coplanar with A
  const Lp = v(0, 3, 0) // light vertex (down normal)
  const up = v(0, 1, 0)
  const down = v(0, -1, 0)
  const bn = v(0, 0, -1)
  const diffuse: Material = { kind: 'diffuse', albedo: v(0.5, 0.5, 0.5) }
  const lightMat = scene.materials[scene.materials.length - 1]
  const lightPrim = scene.lights[0]

  const dir = (a: Vec3, b: Vec3): Vec3 => normalize(sub(b, a))
  const diffPdf = (n: Vec3, w: Vec3): number => Math.max(0, dot(n, w)) / Math.PI

  // Camera subpath E, A, B, L (camera-direction forward densities).
  const cam: Vertex[] = [
    mkV('camera', E, dir(E, A), dir(E, A), dir(E, A), true, false, null, -1, 1, 0),
    mkV('surface', A, up, up, dir(A, E), false, false, diffuse, -1, 1, 0),
    mkV('surface', B, bn, bn, dir(B, A), false, false, diffuse, -1, 0, 0),
    mkV('surface', Lp, down, down, dir(Lp, B), false, true, lightMat, lightPrim, 0, 0),
  ]
  cam[2].pdfFwd = convertDensity(diffPdf(up, dir(A, B)), A, B, bn)
  cam[3].pdfFwd = convertDensity(diffPdf(bn, dir(B, Lp)), B, Lp, down)

  // Light subpath L, B, A (light-direction forward densities).
  const light: Vertex[] = [
    mkV('light', Lp, down, down, down, false, true, lightMat, lightPrim, 0, 0),
    mkV('surface', B, bn, bn, dir(B, Lp), false, false, diffuse, -1, 0, 0),
    mkV('surface', A, up, up, dir(A, B), false, false, diffuse, -1, 0, 0),
  ]
  light[0].pdfFwd = pdfLightOrigin(scene, light[0])
  light[1].pdfFwd = pdfLight(light[0], light[1])

  const sampled = mkV('light', Lp, down, down, down, false, true, lightMat, lightPrim, 0, 0)
  sampled.pdfFwd = pdfLightOrigin(scene, sampled)

  const w40 = misWeight(scene, cam, light, 0, 4, null)
  const w31 = misWeight(scene, cam, light, 1, 3, sampled)
  const w22 = misWeight(scene, cam, light, 2, 2, null)
  return Math.abs(w40 + w31 + w22 - 1)
}

function mkV(
  kind: Vertex['kind'],
  p: Vec3,
  ng: Vec3,
  ns: Vec3,
  wo: Vec3,
  delta: boolean,
  isLight: boolean,
  material: Material | null,
  primId: number,
  pdfFwd: number,
  pdfRev: number,
): Vertex {
  return { kind, p, ng, ns, wo, beta: v(1, 1, 1), pdfFwd, pdfRev, delta, isLight, material, primId }
}
