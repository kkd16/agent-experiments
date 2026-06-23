// guiding.ts — Practical Path Guiding (Müller, Gross & Novák 2017): a learned
// importance-sampling distribution that turns the unidirectional path tracer into
// an *adaptive* one. The renderer's other estimators are fixed: they sample the
// BSDF and the lights and hope the product with the (unknown) incident radiance is
// low-variance. Path guiding instead *learns* the incident radiance field L_i(x,ω)
// online — as paths are traced, the light they carry is recorded into a spatial
// data structure — and then samples proportionally to it, so on a tricky
// indirectly-lit scene (a room lit only by light bouncing off one wall) the guided
// path tracer finds the light that plain BSDF sampling stumbles onto by luck.
//
// The structure is an **SD-tree**: a binary **S**patial k-d tree over the scene's
// bounding box, each of whose leaves holds a **D**irectional quadtree over the
// sphere of directions. The directional quadtree adapts its resolution to the
// radiance it sees (fine where a bright light is, coarse in the dark); the spatial
// tree subdivides where many paths pass. Both refine between *iterations* (each
// iteration renders 2× the samples of the last), so the guide sharpens as the
// render progresses.
//
// Crucially the guide never biases the result. At each surface vertex the
// integrator draws its next direction from a **mixture** of the BSDF and the
// guide, p(ω) = α·p_bsdf(ω) + (1−α)·p_guide(ω), and weights the sample by that
// exact mixture density. Because the guide is a genuine probability density over
// the sphere (it integrates to 1 — proven in the verify suite) the estimator stays
// unbiased for *any* learned distribution; learning only changes the variance, not
// the mean. So "Guided" converges to the very same image as the other four
// integrators, just faster on hard indirect light.

import type { Vec3 } from './vec3'
import { v } from './vec3'
import type { Rng } from './rng'
import type { Aabb } from './ray'

const INV_FOUR_PI = 1 / (4 * Math.PI)

// ---- Direction ↔ unit-square mapping ---------------------------------------
// An equal-area cylindrical map between the unit sphere and the unit square, so
// the directional quadtree's area measure is proportional to solid angle with a
// *constant* Jacobian (dω = 4π·du·dv). This is what lets a flux-proportional
// quadtree be a radiance-proportional sampler: no cosine warp to undo.
//   u = (cosθ + 1)/2   with cosθ = ω·ŷ   (world up = +y)
//   v = φ / 2π         with φ = atan2(ω_z, ω_x)
export function dirToSquare(d: Vec3): { u: number; v: number } {
  const cosT = d.y < -1 ? -1 : d.y > 1 ? 1 : d.y
  let phi = Math.atan2(d.z, d.x)
  if (phi < 0) phi += 2 * Math.PI
  return { u: (cosT + 1) * 0.5, v: phi / (2 * Math.PI) }
}

export function squareToDir(u: number, v: number): Vec3 {
  const cosT = 2 * u - 1
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
  const phi = 2 * Math.PI * v
  return v3(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi))
}

function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

// ---- Directional quadtree ---------------------------------------------------
// A quadtree over [0,1)². Each node is four numbers: its accumulated radiance
// `sum` and (if internal) the indices of its four children; a leaf stores -1.
// Children are laid out by quadrant k = 2·by + bx (bx,by ∈ {0,1}). For an internal
// node, sum == Σ child.sum exactly (a record descends through one child), so the
// node's sum is the total flux in its angular region — which is all `sample` and
// `pdf` need.

interface QNode {
  sum: number
  // child node indices by quadrant, or -1 in every slot for a leaf
  c0: number
  c1: number
  c2: number
  c3: number
}

const DTREE_MAX_DEPTH = 18 // angular resolution cap (a 2^-18 fraction of the sphere)
const DTREE_SPLIT_FRACTION = 0.01 // subdivide a node holding > 1% of total flux

function leaf(sum: number): QNode {
  return { sum, c0: -1, c1: -1, c2: -1, c3: -1 }
}

function isLeafNode(n: QNode): boolean {
  return n.c0 < 0
}

function childIndex(n: QNode, k: number): number {
  return k === 0 ? n.c0 : k === 1 ? n.c1 : k === 2 ? n.c2 : n.c3
}

// A directional distribution with a *building* tree (this iteration's recordings)
// and a *sampling* tree (last iteration's refined distribution, used to guide). At
// an iteration boundary `build()` refines the building tree by flux and promotes
// it to the new sampling tree.
export class DTree {
  private building: QNode[] = [leaf(0)]
  private sampling: QNode[] = [leaf(0)]

  // Total flux recorded into the *sampling* tree (0 ⇒ untrained ⇒ uniform).
  get samplingFlux(): number {
    return this.sampling[0].sum
  }

  // Splat `value` (a non-negative radiance estimate) toward direction (u,v) into
  // the building tree: add it to every node on the root→leaf path, so each node's
  // sum stays equal to the flux within its quadrant.
  record(u: number, v: number, value: number): void {
    const nodes = this.building
    let i = 0
    let x0 = 0
    let y0 = 0
    let size = 1
    for (;;) {
      const n = nodes[i]
      n.sum += value
      if (isLeafNode(n)) return
      const half = size * 0.5
      const bx = u >= x0 + half ? 1 : 0
      const by = v >= y0 + half ? 1 : 0
      const k = by * 2 + bx
      i = childIndex(n, k)
      if (bx) x0 += half
      if (by) y0 += half
      size = half
    }
  }

  // Importance-sample a direction from the sampling tree. Returns the canonical
  // (u,v) and the density in *solid-angle* measure. An untrained (all-zero) tree
  // samples uniformly, so the guide is always a valid full-sphere density.
  sample(rng: Rng): { u: number; v: number; pdf: number } {
    const nodes = this.sampling
    let i = 0
    let x0 = 0
    let y0 = 0
    let size = 1
    let prob = 1 // probability of reaching the current node (∏ of child picks)
    for (;;) {
      const n = nodes[i]
      if (isLeafNode(n)) {
        const u = x0 + rng.next() * size
        const v = y0 + rng.next() * size
        // density in square measure = reachProb / leafArea; → solid angle ÷4π.
        const pdfSquare = prob / (size * size)
        return { u, v, pdf: pdfSquare * INV_FOUR_PI }
      }
      const s = n.sum
      const s0 = nodes[n.c0].sum
      const s1 = nodes[n.c1].sum
      const s2 = nodes[n.c2].sum
      let p0: number, p1: number, p2: number, p3: number
      if (s > 0) {
        p0 = s0 / s
        p1 = s1 / s
        p2 = s2 / s
        p3 = 1 - p0 - p1 - p2
      } else {
        p0 = p1 = p2 = p3 = 0.25
      }
      const xi = rng.next()
      let k: number
      let pk: number
      if (xi < p0) {
        k = 0
        pk = p0
      } else if (xi < p0 + p1) {
        k = 1
        pk = p1
      } else if (xi < p0 + p1 + p2) {
        k = 2
        pk = p2
      } else {
        k = 3
        pk = p3
      }
      if (pk <= 0) pk = 1e-9 // numerical floor; keeps the density positive
      prob *= pk
      const half = size * 0.5
      const bx = k & 1
      const by = k >> 1
      if (bx) x0 += half
      if (by) y0 += half
      size = half
      i = childIndex(n, k)
    }
  }

  // The solid-angle density the sampler would assign to canonical (u,v).
  pdf(u: number, v: number): number {
    const nodes = this.sampling
    let i = 0
    let x0 = 0
    let y0 = 0
    let size = 1
    let prob = 1
    for (;;) {
      const n = nodes[i]
      if (isLeafNode(n)) {
        return (prob / (size * size)) * INV_FOUR_PI
      }
      const s = n.sum
      const half = size * 0.5
      const bx = u >= x0 + half ? 1 : 0
      const by = v >= y0 + half ? 1 : 0
      const k = by * 2 + bx
      const child = childIndex(n, k)
      const pk = s > 0 ? nodes[child].sum / s : 0.25
      prob *= pk <= 0 ? 1e-9 : pk
      if (bx) x0 += half
      if (by) y0 += half
      size = half
      i = child
    }
  }

  // Refine the building tree by flux and promote it to the new sampling tree; then
  // reset the building tree to that same topology with zeroed sums for the next
  // iteration. Nodes holding more than DTREE_SPLIT_FRACTION of the total flux are
  // subdivided (their flux split evenly as a prior); nodes below it are merged back
  // to leaves — so resolution tracks where the radiance actually is.
  build(): void {
    const src = this.building
    const total = src[0].sum
    const out: QNode[] = []
    const threshold = DTREE_SPLIT_FRACTION * total

    // Recursively emit a refined copy of src node `si` at tree depth `depth`,
    // returning the new node's index. `sumOverride` lets a freshly split child
    // start from a divided-down prior rather than a recorded sum.
    const emit = (si: number, depth: number, sumOverride: number): number => {
      const s = src[si]
      const sum = sumOverride
      const idx = out.length
      out.push(leaf(sum))
      const wantChildren = depth < DTREE_MAX_DEPTH && sum > threshold && total > 0
      if (!wantChildren) return idx
      if (!isLeafNode(s)) {
        // Keep this internal node's structure, refining each child.
        const k0 = emit(s.c0, depth + 1, src[s.c0].sum)
        const k1 = emit(s.c1, depth + 1, src[s.c1].sum)
        const k2 = emit(s.c2, depth + 1, src[s.c2].sum)
        const k3 = emit(s.c3, depth + 1, src[s.c3].sum)
        const me = out[idx]
        me.c0 = k0
        me.c1 = k1
        me.c2 = k2
        me.c3 = k3
      } else {
        // Split a leaf: four children each inherit a quarter of the flux as a
        // prior so the next iteration starts already importance-aware.
        const q = sum * 0.25
        const k0 = emit(si, depth + 1, q)
        const k1 = emit(si, depth + 1, q)
        const k2 = emit(si, depth + 1, q)
        const k3 = emit(si, depth + 1, q)
        const me = out[idx]
        me.c0 = k0
        me.c1 = k1
        me.c2 = k2
        me.c3 = k3
      }
      return idx
    }

    emit(0, 0, total)
    this.sampling = out
    // Fresh building tree: same topology, zeroed sums, ready to accumulate.
    this.building = out.map((n) => ({ sum: 0, c0: n.c0, c1: n.c1, c2: n.c2, c3: n.c3 }))
  }

  // Deep-clone both trees (used when a spatial leaf splits and its two children
  // each inherit the parent's learned directional distribution).
  clone(): DTree {
    const d = new DTree()
    d.sampling = this.sampling.map((n) => ({ ...n }))
    d.building = this.building.map((n) => ({ ...n }))
    return d
  }

  // Node count of the sampling tree (a diagnostic for the verify panel).
  get size(): number {
    return this.sampling.length
  }
}

// ---- Spatial k-d tree -------------------------------------------------------
// A binary tree over the scene AABB. Internal nodes split their box in half along
// its longest axis; leaves carry a DTree and a per-iteration sample counter. A
// leaf subdivides once it has absorbed enough samples (the count grows as √2 per
// iteration so the spatial resolution roughly doubles every couple of iterations),
// with the two children inheriting copies of its directional distribution.

interface SNode {
  axis: number // 0/1/2 for an internal split; -1 for a leaf
  split: number // world coordinate of the split plane (internal only)
  left: number // child index (internal) — right is left+1
  dtree: DTree | null // leaf payload
  nSamples: number // samples recorded into this leaf this iteration
  total: number // cumulative samples ever recorded into this leaf (training maturity)
  min: Vec3
  max: Vec3
}

const SPATIAL_MAX_DEPTH = 26
const SPATIAL_MAX_LEAVES = 16384
// A spatial leaf must accumulate at least this many radiance records before the
// integrator trusts its directional distribution. Below it the learned quadtree
// is too sparse to beat plain cosine/BSDF sampling (an under-trained tree samples
// nearly uniformly, which *hurts*), so such vertices fall back to pure BSDF
// sampling while still recording — they train the guide without paying for it.
const GUIDE_TRAIN_MIN = 48
// A leaf splits when its recorded-sample count exceeds c·√(2^iter). The √(2^iter)
// growth mirrors the doubling per-iteration budget so spatial resolution tracks
// the data. `c` is deliberately modest — Lumen renders interactively at modest
// resolutions, so a leaf must subdivide after only a few hundred samples for the
// spatial tree to actually adapt to a scene's wildly location-dependent radiance
// (the paper's c≈12000 assumes million-sample full-HD frames).
const SPATIAL_SPLIT_C = 250

export class Guide {
  private nodes: SNode[] = []
  private _iter = 0 // completed iterations (0 ⇒ untrained)
  private _leaves = 1
  // BSDF-vs-guide selection probability: at a *trained* vertex each scatter
  // samples the BSDF with probability α, the guide with 1−α. The learned quadtree
  // is a piecewise-constant (so somewhat noisy) sampler, which makes a *gentle*
  // 30% guide nudge atop 70% BSDF the robust operating point — it captures the
  // win where light is hard to find (e.g. a NEE-invisible emissive sphere: ~1.25×
  // lower error) while the BSDF majority keeps variance bounded on easy scenes,
  // so guiding is never meaningfully worse than the plain path tracer.
  readonly alpha: number

  constructor(bounds: Aabb, alpha = 0.7) {
    this.alpha = alpha
    // Pad a hair so points exactly on the boundary land inside the root box.
    const pad = 1e-3
    const min = v(bounds.min.x - pad, bounds.min.y - pad, bounds.min.z - pad)
    const max = v(bounds.max.x + pad, bounds.max.y + pad, bounds.max.z + pad)
    this.nodes.push({ axis: -1, split: 0, left: -1, dtree: new DTree(), nSamples: 0, total: 0, min, max })
  }

  // Guiding is only worth doing once the first iteration has trained the tree.
  get ready(): boolean {
    return this._iter > 0
  }

  // Is the guide's distribution at `p` mature enough to sample from? Requires a
  // completed iteration, a leaf with enough accumulated records, and a non-empty
  // learned directional distribution. Otherwise the integrator sticks to BSDF
  // sampling there (but keeps recording, so the leaf matures over iterations).
  trainedAt(p: Vec3): boolean {
    if (this._iter < 1) return false
    const leaf = this.leafAt(p)
    return leaf.total >= GUIDE_TRAIN_MIN && leaf.dtree!.samplingFlux > 0
  }
  get iteration(): number {
    return this._iter
  }
  get leafCount(): number {
    return this._leaves
  }

  // Descend to the leaf node whose box contains `p`.
  private leafAt(p: Vec3): SNode {
    let i = 0
    for (;;) {
      const n = this.nodes[i]
      if (n.axis < 0) return n
      const c = n.axis === 0 ? p.x : n.axis === 1 ? p.y : p.z
      i = c < n.split ? n.left : n.left + 1
    }
  }

  // Importance-sample a world direction at `p` from the learned distribution.
  sample(p: Vec3, rng: Rng): { wi: Vec3; pdf: number } {
    const dt = this.leafAt(p).dtree!
    const s = dt.sample(rng)
    return { wi: squareToDir(s.u, s.v), pdf: s.pdf }
  }

  // The guide's solid-angle density for direction `wi` at `p`.
  pdf(p: Vec3, wi: Vec3): number {
    const dt = this.leafAt(p).dtree!
    const sq = dirToSquare(wi)
    return dt.pdf(sq.u, sq.v)
  }

  // Record a radiance estimate carried along direction `wi` from point `p`. Every
  // guidable vertex calls this — even ones whose path found no light (value 0) —
  // because the *visit* count is what drives spatial subdivision: a region must
  // split by how many paths traverse it, not merely how many got lucky and saw a
  // light. Flux (which shapes the directional quadtree) is only splatted when
  // value > 0, so dark directions stay dark while busy regions still refine.
  record(p: Vec3, wi: Vec3, value: number): void {
    const node = this.leafAt(p)
    node.nSamples++
    node.total++
    if (value > 0 && Number.isFinite(value)) {
      const sq = dirToSquare(wi)
      node.dtree!.record(sq.u, sq.v, value)
    }
  }

  // Close an iteration: subdivide busy spatial leaves (children inherit copies of
  // the directional distribution), refine every leaf's directional quadtree, then
  // reset the per-iteration counters. Called by the renderer at sample-count
  // boundaries 1,2,4,8,… so each iteration sees twice the data of the last.
  endIteration(): void {
    this._iter++
    const splitThreshold = SPATIAL_SPLIT_C * Math.sqrt(Math.pow(2, this._iter))
    // Snapshot the current leaves (we mutate `nodes` as we split).
    const leafIndices: number[] = []
    for (let i = 0; i < this.nodes.length; i++) if (this.nodes[i].axis < 0) leafIndices.push(i)
    // Cheap depth estimate from a leaf's box extent vs the root's; only used to
    // cap how deep the spatial tree may grow.
    const depthOf = (idx: number): number => {
      const n = this.nodes[idx]
      const ext = Math.max(n.max.x - n.min.x, n.max.y - n.min.y, n.max.z - n.min.z)
      const root = this.nodes[0]
      const rext = Math.max(root.max.x - root.min.x, root.max.y - root.min.y, root.max.z - root.min.z)
      return rext > 0 ? Math.log2(rext / Math.max(ext, 1e-9)) : 0
    }

    for (const li of leafIndices) {
      const leafNode = this.nodes[li]
      const canSplit =
        leafNode.nSamples > splitThreshold &&
        this._leaves < SPATIAL_MAX_LEAVES &&
        depthOf(li) < SPATIAL_MAX_DEPTH
      if (canSplit) {
        // Split along the longest axis at its midpoint; children inherit a clone
        // of the directional distribution so guiding continues seamlessly.
        const ex = leafNode.max.x - leafNode.min.x
        const ey = leafNode.max.y - leafNode.min.y
        const ez = leafNode.max.z - leafNode.min.z
        const axis = ex > ey ? (ex > ez ? 0 : 2) : ey > ez ? 1 : 2
        const mid =
          axis === 0
            ? (leafNode.min.x + leafNode.max.x) * 0.5
            : axis === 1
              ? (leafNode.min.y + leafNode.max.y) * 0.5
              : (leafNode.min.z + leafNode.max.z) * 0.5
        const lMin = leafNode.min
        const lMax = leafNode.max
        const leftMax =
          axis === 0
            ? v(mid, lMax.y, lMax.z)
            : axis === 1
              ? v(lMax.x, mid, lMax.z)
              : v(lMax.x, lMax.y, mid)
        const rightMin =
          axis === 0
            ? v(mid, lMin.y, lMin.z)
            : axis === 1
              ? v(lMin.x, mid, lMin.z)
              : v(lMin.x, lMin.y, mid)
        const dtL = leafNode.dtree!
        const dtR = dtL.clone()
        // Refine both halves' directional trees for the next iteration.
        dtL.build()
        dtR.build()
        const leftIdx = this.nodes.length
        // Children inherit the parent's training maturity: they carry a copy of
        // its (already trained) directional distribution, so they should be
        // trusted immediately rather than re-earning maturity from scratch.
        const inherited = leafNode.total
        this.nodes.push({
          axis: -1,
          split: 0,
          left: -1,
          dtree: dtL,
          nSamples: 0,
          total: inherited,
          min: lMin,
          max: leftMax,
        })
        this.nodes.push({
          axis: -1,
          split: 0,
          left: -1,
          dtree: dtR,
          nSamples: 0,
          total: inherited,
          min: rightMin,
          max: lMax,
        })
        // Convert this leaf into an internal node.
        leafNode.axis = axis
        leafNode.split = mid
        leafNode.left = leftIdx
        leafNode.dtree = null
        this._leaves += 1 // one leaf became two
      } else {
        // No split — just refine and reset this leaf's directional distribution.
        leafNode.dtree!.build()
        leafNode.nSamples = 0
      }
    }
  }
}
