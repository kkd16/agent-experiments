// lighttree.ts — Importance Sampling of Many Lights (Conty Estevez & Kulla 2018).
//
// Next-event estimation has to answer one question at every shade point: *which*
// of the scene's emitters do I connect a shadow ray to? Lumen's original answer
// was "pick one uniformly" (scene.sampleLight's `rng.int(numLights)`). With one
// ceiling light that is perfect; with a thousand little lights it is a disaster —
// almost every shadow ray is spent on a light that is occluded, faces away, or is
// simply too far to matter, while the handful of emitters that actually light the
// point are seen one-in-a-thousand of the time. The image is pure noise and no
// amount of extra samples fixes the *distribution* — only sampling the right light
// does.
//
// The fix is a **light BVH**: a binary tree over the emissive triangles whose every
// node caches the cluster's total power, its bounding box, and a bounding cone of
// its emitter normals. To choose a light for a point `p`, we walk the tree from the
// root, at each internal node picking the child in proportion to a cheap, *conserva-
// tive* estimate of how much that cluster could illuminate `p`:
//
//     importance(node, p) = power(node) · orient(node, p) / dist²(p, box(node))
//
// — bright/near/well-oriented clusters win, dim/far/back-facing ones almost never
// do. Accumulating the product of the per-step branch probabilities yields the
// exact discrete selection pdf, which `prob(p, primId)` recomputes for the MIS
// weight. Because that pdf is (1) a proper distribution — normalised at every split,
// so it sums to 1 over the leaves — and (2) strictly positive for every light (the
// orientation term is floored and the distance is clamped, so no contributing light
// is ever excluded), the estimator stays **unbiased**: the tree only reshapes the
// variance of next-event estimation, never its mean. A tree-sampled render converges
// to exactly the same image a uniform one does — it just gets there far faster when
// the lights are many.

import type { Vec3 } from './vec3'
import { cross, dot, len2, normalize, scale, sub, v } from './vec3'
import type { Aabb } from './ray'
import { aabbEmpty, aabbUnion, aabbUnionPoint, aabbCenter } from './ray'
import type { Triangle } from './primitive'
import type { Rng } from './rng'

// A single emitter, reduced to what the tree needs: its primitive id (an index into
// scene.prims), its centroid (for the split), its bounds, its scalar power, and its
// emission direction (the triangle's geometric normal — emitters are one-sided).
interface LightRef {
  primId: number
  centroid: Vec3
  bounds: Aabb
  power: number
  axis: Vec3
}

// A tree node. Internal nodes carry both children and `mid` (the index in the
// reordered ref array where the right child begins, used to route prob() descent to
// the correct subtree); leaves carry a single primId.
interface Node {
  bounds: Aabb
  power: number
  axis: Vec3 // normal-cone axis
  cosCone: number // cosine of the cone half-angle (1 = a single direction)
  left: number // child node index, or -1 for a leaf
  right: number // child node index, or -1 for a leaf
  mid: number // ref index where the right subtree starts (internal only)
  primId: number // emitter primId (leaf only, else -1)
}

const ORIENT_FLOOR = 0.05 // every cluster keeps ≥5% of its facing weight → positivity
const RECV_FLOOR = 0.05 // and ≥5% of its *receiver*-facing weight, so a cluster behind the
//                         shade point is heavily down-weighted but never excluded (positivity)

export class LightTree {
  private readonly nodes: Node[] = []
  private readonly root: number
  private readonly minD2: number
  // primId → its position in the reordered ref array, so prob() can route its
  // descent left/right at each split by comparing against the node's `mid`.
  private readonly refPos: Map<number, number> = new Map()
  readonly lightCount: number

  // Build a light tree from the scene's emissive triangles. `emission` maps a
  // primId to the triangle's emitted radiance (so power = luminance·area).
  constructor(refs: LightRef[]) {
    this.lightCount = refs.length
    // Distance clamp: keeps importance finite when `p` sits on/inside a light's box
    // and bounds the dynamic range of the 1/d² term to the scene's own scale.
    let diag2 = 1
    if (refs.length > 0) {
      let bb = aabbEmpty()
      for (const r of refs) bb = aabbUnion(bb, r.bounds)
      diag2 = len2(sub(bb.max, bb.min))
    }
    this.minD2 = Math.max(1e-8, diag2 * 1e-8)
    const order = refs.slice() // reordered in place by the recursive build
    this.root = refs.length > 0 ? this.build(order, 0, order.length) : -1
    for (let i = 0; i < order.length; i++) this.refPos.set(order[i].primId, i)
  }

  // Recursively build the subtree spanning order[start, end) and return its node
  // index. A single ref becomes a leaf; otherwise we median-split the centroids on
  // the widest axis and recurse, aggregating power, bounds and the normal cone.
  private build(order: LightRef[], start: number, end: number): number {
    const count = end - start
    if (count === 1) {
      const r = order[start]
      const idx = this.nodes.length
      this.nodes.push({
        bounds: r.bounds,
        power: r.power,
        axis: r.axis,
        cosCone: 1,
        left: -1,
        right: -1,
        mid: -1,
        primId: r.primId,
      })
      return idx
    }
    // Centroid bounds → widest axis → median split (nth-element by partial sort).
    let cmin = v(Infinity, Infinity, Infinity)
    let cmax = v(-Infinity, -Infinity, -Infinity)
    for (let i = start; i < end; i++) {
      const c = order[i].centroid
      cmin = v(Math.min(cmin.x, c.x), Math.min(cmin.y, c.y), Math.min(cmin.z, c.z))
      cmax = v(Math.max(cmax.x, c.x), Math.max(cmax.y, c.y), Math.max(cmax.z, c.z))
    }
    const ex = cmax.x - cmin.x
    const ey = cmax.y - cmin.y
    const ez = cmax.z - cmin.z
    const axis = ex >= ey && ex >= ez ? 'x' : ey >= ez ? 'y' : 'z'
    const key = (r: LightRef) => (axis === 'x' ? r.centroid.x : axis === 'y' ? r.centroid.y : r.centroid.z)
    // Sort the slice by the chosen axis (counts here are small — hundreds of lights).
    const slice = order.slice(start, end).sort((a, b) => key(a) - key(b))
    for (let i = 0; i < slice.length; i++) order[start + i] = slice[i]
    // (17.0) SAH-style split: instead of cutting at the median, choose the split that
    // minimises Σ_child power(child)·surfaceArea(bounds(child)) — the light-transport
    // analogue of the geometry BVH's surface-area heuristic. It clusters bright, tight
    // groups of emitters together (so a descent's importance estimate is far sharper)
    // and isolates a lone powerful light from a diffuse halo of dim ones, which is
    // exactly where median splitting wastes its branch probabilities. Prefix/suffix
    // sweeps give every candidate split's cost in O(count); ties (e.g. coincident
    // lights, zero area) keep the median, so the uniform-reduction guarantee holds.
    const leftCost = new Float64Array(count)
    {
      let b = aabbEmpty()
      let pw = 0
      for (let i = 0; i < count; i++) {
        b = aabbUnion(b, order[start + i].bounds)
        pw += order[start + i].power
        leftCost[i] = surfaceArea(b) * pw // left child = items [0..i]
      }
    }
    let bestK = count >> 1
    let bestCost = Infinity
    {
      let b = aabbEmpty()
      let pw = 0
      const rightCost = new Float64Array(count)
      for (let i = count - 1; i >= 0; i--) {
        b = aabbUnion(b, order[start + i].bounds)
        pw += order[start + i].power
        rightCost[i] = surfaceArea(b) * pw // right child = items [i..count-1]
      }
      for (let k = 1; k < count; k++) {
        const c = leftCost[k - 1] + rightCost[k]
        if (c < bestCost) {
          bestCost = c
          bestK = k
        }
      }
    }
    const mid = start + bestK
    // Reserve this node, then build children (post-order indices are fine).
    const idx = this.nodes.length
    this.nodes.push({
      bounds: aabbEmpty(),
      power: 0,
      axis: v(0, 0, 1),
      cosCone: 1,
      left: -1,
      right: -1,
      mid,
      primId: -1,
    })
    const left = this.build(order, start, mid)
    const right = this.build(order, mid, end)
    const ln = this.nodes[left]
    const rn = this.nodes[right]
    const cone = coneUnion(ln.axis, ln.cosCone, rn.axis, rn.cosCone)
    const n = this.nodes[idx]
    n.bounds = aabbUnion(ln.bounds, rn.bounds)
    n.power = ln.power + rn.power
    n.axis = cone.axis
    n.cosCone = cone.cosCone
    n.left = left
    n.right = right
    return idx
  }

  // The conservative importance of a node's cluster as seen from point `p` (with an
  // optional surface normal `nRecv` at `p`): its power, attenuated by 1/d² to the
  // nearest point of its box, by a bound on how squarely any emitter in it can face
  // `p`, and — when a receiver normal is given — by a bound on how much of the
  // cluster lies in `p`'s upper (lit) hemisphere, so a cluster *behind* the surface
  // is heavily down-weighted (its light can only graze or miss). Always strictly
  // positive (ORIENT_FLOOR, RECV_FLOOR and minD2), which keeps every light reachable
  // → unbiased. `nRecv` undefined ⇒ the 14.0 receiver-agnostic importance, verbatim.
  private importance(nodeIdx: number, p: Vec3, nRecv?: Vec3): number {
    const n = this.nodes[nodeIdx]
    const d2 = Math.max(distance2PointAabb(p, n.bounds), this.minD2)
    const center = aabbCenter(n.bounds)
    const toP = sub(p, center)
    const l2 = len2(toP)
    let orient = 1
    let recv = 1
    if (l2 > 1e-12) {
      const invLen = 1 / Math.sqrt(l2)
      const dirToP = scale(toP, invLen) // cluster → p
      // Largest cos(emitter-normal, dirToP) achievable within the normal cone: the
      // cone's axis-to-p angle reduced by the cone's half-angle (0 if it already
      // straddles dirToP). Negative ⇒ the cluster faces away; floored, never zero.
      const cosAxis = clampUnit(dot(n.axis, dirToP))
      const angleAxis = Math.acos(cosAxis)
      const coneHalf = Math.acos(clampUnit(n.cosCone))
      const diff = angleAxis - coneHalf
      const best = diff <= 0 ? 1 : diff >= Math.PI / 2 ? 0 : Math.cos(diff)
      orient = Math.max(ORIENT_FLOOR, best)
      // (17.0) Receiver-aware term: the largest cos(nRecv, p→cluster) achievable over
      // the cluster's box — the box-centre direction widened by the angle the box
      // subtends at `p` — so a cluster the surface can actually see scores high and
      // one tucked below the horizon scores the floor. A heuristic (it only reshapes
      // the variance), made safe by RECV_FLOOR > 0 so positivity (unbiasedness) holds.
      if (nRecv) {
        const cosN = clampUnit(-dot(nRecv, dirToP)) // p→cluster is −dirToP
        const angN = Math.acos(cosN)
        // Angular radius the cluster box subtends at p (half its diagonal over the
        // distance), so a wide nearby cluster is judged by its closest-facing extent.
        const half = 0.5 * Math.sqrt(len2(sub(n.bounds.max, n.bounds.min)))
        const sinR = Math.min(1, half * invLen)
        const angR = Math.asin(sinR)
        const d = angN - angR
        const bestN = d <= 0 ? 1 : d >= Math.PI / 2 ? 0 : Math.cos(d)
        recv = Math.max(RECV_FLOOR, bestN)
      }
    }
    return (n.power * orient * recv) / d2
  }

  // Stochastically choose a light for point `p`, returning its primId and the exact
  // probability that this descent selected it (the product of the per-split branch
  // probabilities). One rng.next() is consumed per internal node on the path.
  sample(p: Vec3, rng: Rng, nRecv?: Vec3): { primId: number; prob: number } {
    let node = this.root
    let prob = 1
    while (this.nodes[node].left >= 0) {
      const n = this.nodes[node]
      const il = this.importance(n.left, p, nRecv)
      const ir = this.importance(n.right, p, nRecv)
      const sum = il + ir
      // sum is > 0 (importance is strictly positive); guard only against fp dust.
      const pl = sum > 0 ? il / sum : 0.5
      if (rng.next() < pl) {
        prob *= pl
        node = n.left
      } else {
        prob *= 1 - pl
        node = n.right
      }
    }
    return { primId: this.nodes[node].primId, prob }
  }

  // The probability that sample() would select light `primId` from point `p` — the
  // identical branch-probability product, recomputed by routing the descent toward
  // the leaf that owns `primId`. Returns 0 for a primId the tree does not contain.
  prob(p: Vec3, primId: number, nRecv?: Vec3): number {
    const pos = this.refPos.get(primId)
    if (pos === undefined) return 0
    let node = this.root
    let prob = 1
    while (this.nodes[node].left >= 0) {
      const n = this.nodes[node]
      const il = this.importance(n.left, p, nRecv)
      const ir = this.importance(n.right, p, nRecv)
      const sum = il + ir
      const pl = sum > 0 ? il / sum : 0.5
      if (pos < n.mid) {
        prob *= pl
        node = n.left
      } else {
        prob *= 1 - pl
        node = n.right
      }
    }
    return prob
  }
}

// Build the LightRefs for a set of emissive triangles and assemble the tree.
export function buildLightTree(
  prims: { primId: number; tri: Triangle; emission: Vec3 }[],
): LightTree {
  const refs: LightRef[] = prims.map(({ primId, tri, emission }) => {
    const p0 = tri.p0
    const p1 = v(p0.x + tri.e1.x, p0.y + tri.e1.y, p0.z + tri.e1.z)
    const p2 = v(p0.x + tri.e2.x, p0.y + tri.e2.y, p0.z + tri.e2.z)
    let bounds = aabbEmpty()
    bounds = aabbUnionPoint(bounds, p0)
    bounds = aabbUnionPoint(bounds, p1)
    bounds = aabbUnionPoint(bounds, p2)
    const centroid = v((p0.x + p1.x + p2.x) / 3, (p0.y + p1.y + p2.y) / 3, (p0.z + p1.z + p2.z) / 3)
    // Power ∝ radiant exitance × area = luminance(emission) · area. Floored so a
    // (degenerate) zero-emission "light" still carries strictly positive importance.
    const lum = 0.2126 * emission.x + 0.7152 * emission.y + 0.0722 * emission.z
    const power = Math.max(lum * tri.area, 1e-12)
    return { primId, centroid, bounds, power, axis: tri.ng }
  })
  return new LightTree(refs)
}

// ---- geometry helpers --------------------------------------------------------

function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x
}

// Surface area of an AABB (0 for an empty/degenerate box), the SAH split cost metric.
function surfaceArea(b: Aabb): number {
  const dx = Math.max(0, b.max.x - b.min.x)
  const dy = Math.max(0, b.max.y - b.min.y)
  const dz = Math.max(0, b.max.z - b.min.z)
  return 2 * (dx * dy + dy * dz + dz * dx)
}

// Squared distance from a point to the nearest point of an AABB (0 if inside).
function distance2PointAabb(p: Vec3, b: Aabb): number {
  const dx = p.x < b.min.x ? b.min.x - p.x : p.x > b.max.x ? p.x - b.max.x : 0
  const dy = p.y < b.min.y ? b.min.y - p.y : p.y > b.max.y ? p.y - b.max.y : 0
  const dz = p.z < b.min.z ? b.min.z - p.z : p.z > b.max.z ? p.z - b.max.z : 0
  return dx * dx + dy * dy + dz * dz
}

// Rotate unit vector `vec` around unit axis `k` by angle θ (Rodrigues' formula).
function rotateAround(vec: Vec3, k: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const kv = dot(k, vec)
  return v(
    vec.x * c + (k.y * vec.z - k.z * vec.y) * s + k.x * kv * (1 - c),
    vec.y * c + (k.z * vec.x - k.x * vec.z) * s + k.y * kv * (1 - c),
    vec.z * c + (k.x * vec.y - k.y * vec.x) * s + k.z * kv * (1 - c),
  )
}

// The bounding cone of the union of two cones (axis + cos half-angle), following
// PBRT's DirectionCone::Union: if one already contains the other, return it; else
// spread a new cone that just covers both (or the whole sphere if it wraps past π).
function coneUnion(
  aAxis: Vec3,
  aCos: number,
  bAxis: Vec3,
  bCos: number,
): { axis: Vec3; cosCone: number } {
  const thetaA = Math.acos(clampUnit(aCos))
  const thetaB = Math.acos(clampUnit(bCos))
  const thetaD = Math.acos(clampUnit(dot(aAxis, bAxis)))
  if (Math.min(thetaD + thetaB, Math.PI) <= thetaA) return { axis: aAxis, cosCone: aCos }
  if (Math.min(thetaD + thetaA, Math.PI) <= thetaB) return { axis: bAxis, cosCone: bCos }
  const thetaO = (thetaA + thetaD + thetaB) / 2
  if (thetaO >= Math.PI) return { axis: aAxis, cosCone: -1 } // whole sphere
  const thetaR = thetaO - thetaA
  const wr = cross(aAxis, bAxis)
  if (len2(wr) < 1e-18) return { axis: aAxis, cosCone: -1 }
  const axis = normalize(rotateAround(aAxis, normalize(wr), thetaR))
  return { axis, cosCone: Math.cos(Math.min(thetaO, Math.PI)) }
}
