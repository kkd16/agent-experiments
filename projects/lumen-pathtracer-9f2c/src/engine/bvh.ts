// bvh.ts — a bounding volume hierarchy built with a binned Surface Area
// Heuristic (SAH). The BVH turns the O(n) brute-force ray/scene test into an
// expected O(log n) traversal, which is what makes thousands of triangles
// tractable at interactive sample rates on a single CPU thread.
//
// Build: top-down. At each node we bin primitive centroids into 12 buckets
// along the widest centroid axis, evaluate the SAH cost of splitting after each
// bucket boundary, and take the cheapest split (falling back to a median/leaf
// when no split helps). Traversal: an explicit stack with a front-to-back child
// ordering so the nearer child is visited first and prunes the farther one.

import type { Vec3 } from './vec3'
import type { Aabb } from './ray'
import {
  aabbCenter,
  aabbEmpty,
  aabbHit,
  aabbSurfaceArea,
  aabbUnion,
  aabbUnionPoint,
} from './ray'
import type { Primitive, PrimHit } from './primitive'
import { intersectPrim, primBounds } from './primitive'
import { v } from './vec3'

interface BvhNode {
  box: Aabb
  left: number // interior: left child index; leaf: first primitive slot
  right: number // interior: right child index; leaf: unused (-1)
  count: number // leaf: primitive count; interior: 0
}

const NUM_BINS = 12
const MAX_LEAF = 4

export class Bvh {
  readonly nodes: BvhNode[] = []
  readonly order: Int32Array // primitive index per leaf slot
  readonly prims: Primitive[]
  private readonly bounds: Aabb[]
  private readonly centers: Vec3[]
  // Stats exposed for the UI.
  readonly nodeCount: number = 0
  readonly leafCount: number = 0
  readonly maxDepth: number = 0

  // The root node's AABB = the bounds of the whole scene (used by path guiding to
  // anchor its spatial tree, and by anyone needing the world extent).
  get rootBounds(): Aabb {
    return this.nodes.length > 0 ? this.nodes[0].box : aabbEmpty()
  }

  constructor(prims: Primitive[]) {
    this.prims = prims
    const n = prims.length
    this.order = new Int32Array(n)
    for (let i = 0; i < n; i++) this.order[i] = i
    this.bounds = prims.map(primBounds)
    this.centers = this.bounds.map(aabbCenter)

    if (n === 0) {
      this.nodes.push({ box: aabbEmpty(), left: 0, right: -1, count: 0 })
      return
    }
    let leaves = 0
    let maxD = 0
    const build = (start: number, end: number, depth: number): number => {
      maxD = Math.max(maxD, depth)
      const nodeIndex = this.nodes.length
      this.nodes.push({ box: aabbEmpty(), left: 0, right: -1, count: 0 })

      // Bounds of this range and of its centroids.
      let box = aabbEmpty()
      let cbox = aabbEmpty()
      for (let i = start; i < end; i++) {
        const pi = this.order[i]
        box = aabbUnion(box, this.bounds[pi])
        cbox = aabbUnionPoint(cbox, this.centers[pi])
      }
      const node = this.nodes[nodeIndex]
      node.box = box
      const count = end - start

      const ext = {
        x: cbox.max.x - cbox.min.x,
        y: cbox.max.y - cbox.min.y,
        z: cbox.max.z - cbox.min.z,
      }
      const axis = ext.x > ext.y ? (ext.x > ext.z ? 0 : 2) : ext.y > ext.z ? 1 : 2
      const axisExtent = axis === 0 ? ext.x : axis === 1 ? ext.y : ext.z

      if (count <= MAX_LEAF || axisExtent < 1e-9) {
        node.left = start
        node.count = count
        leaves++
        return nodeIndex
      }

      const mid = this.partitionSAH(start, end, axis, cbox)
      if (mid === start || mid === end) {
        // Degenerate split — fall back to a leaf.
        node.left = start
        node.count = count
        leaves++
        return nodeIndex
      }

      const leftChild = build(start, mid, depth + 1)
      const rightChild = build(mid, end, depth + 1)
      // Re-fetch: `this.nodes` may have grown/reallocated conceptually.
      this.nodes[nodeIndex].left = leftChild
      this.nodes[nodeIndex].right = rightChild
      this.nodes[nodeIndex].count = 0
      return nodeIndex
    }
    build(0, n, 0)
    // Freeze stats.
    ;(this as { nodeCount: number }).nodeCount = this.nodes.length
    ;(this as { leafCount: number }).leafCount = leaves
    ;(this as { maxDepth: number }).maxDepth = maxD
  }

  // Binned SAH partition. Returns the split index in `order` (start..end).
  private partitionSAH(start: number, end: number, axis: number, cbox: Aabb): number {
    const cmin = axis === 0 ? cbox.min.x : axis === 1 ? cbox.min.y : cbox.min.z
    const cmax = axis === 0 ? cbox.max.x : axis === 1 ? cbox.max.y : cbox.max.z
    const scale = NUM_BINS / Math.max(1e-12, cmax - cmin)

    const binBox: Aabb[] = new Array(NUM_BINS)
    const binCount = new Int32Array(NUM_BINS)
    for (let i = 0; i < NUM_BINS; i++) binBox[i] = aabbEmpty()

    const binOf = (pi: number): number => {
      const c = this.centers[pi]
      const cc = axis === 0 ? c.x : axis === 1 ? c.y : c.z
      let b = ((cc - cmin) * scale) | 0
      if (b < 0) b = 0
      if (b >= NUM_BINS) b = NUM_BINS - 1
      return b
    }

    for (let i = start; i < end; i++) {
      const pi = this.order[i]
      const b = binOf(pi)
      binCount[b]++
      binBox[b] = aabbUnion(binBox[b], this.bounds[pi])
    }

    // Sweep to accumulate left/right costs for the NUM_BINS-1 candidate planes.
    const leftArea = new Float64Array(NUM_BINS - 1)
    const rightArea = new Float64Array(NUM_BINS - 1)
    const leftCount = new Int32Array(NUM_BINS - 1)
    const rightCount = new Int32Array(NUM_BINS - 1)

    let accBox = aabbEmpty()
    let accCount = 0
    for (let i = 0; i < NUM_BINS - 1; i++) {
      accBox = aabbUnion(accBox, binBox[i])
      accCount += binCount[i]
      leftArea[i] = aabbSurfaceArea(accBox)
      leftCount[i] = accCount
    }
    accBox = aabbEmpty()
    accCount = 0
    for (let i = NUM_BINS - 1; i > 0; i--) {
      accBox = aabbUnion(accBox, binBox[i])
      accCount += binCount[i]
      rightArea[i - 1] = aabbSurfaceArea(accBox)
      rightCount[i - 1] = accCount
    }

    let bestCost = Infinity
    let bestSplit = -1
    for (let i = 0; i < NUM_BINS - 1; i++) {
      const cost = leftCount[i] * leftArea[i] + rightCount[i] * rightArea[i]
      if (cost < bestCost && leftCount[i] > 0 && rightCount[i] > 0) {
        bestCost = cost
        bestSplit = i
      }
    }
    if (bestSplit < 0) return start // no valid split

    // Partition `order[start..end]` so bins ≤ bestSplit come first (Hoare-style).
    let i = start
    let j = end - 1
    while (i <= j) {
      while (i <= j && binOf(this.order[i]) <= bestSplit) i++
      while (i <= j && binOf(this.order[j]) > bestSplit) j--
      if (i < j) {
        const tmp = this.order[i]
        this.order[i] = this.order[j]
        this.order[j] = tmp
        i++
        j--
      }
    }
    return i
  }

  // Nearest-hit traversal. Returns the primitive index hit and the local PrimHit.
  intersect(o: Vec3, d: Vec3, tMin: number, tMax: number): { hit: PrimHit; primId: number } | null {
    const invD = v(1 / d.x, 1 / d.y, 1 / d.z)
    let closest: PrimHit | null = null
    let closestId = -1
    let curTMax = tMax

    const stack = this.stack
    let sp = 0
    stack[sp++] = 0
    while (sp > 0) {
      const ni = stack[--sp]
      const node = this.nodes[ni]
      if (!aabbHit(node.box, o, invD, tMin, curTMax)) continue
      if (node.count > 0) {
        const first = node.left
        for (let k = 0; k < node.count; k++) {
          const pi = this.order[first + k]
          const h = intersectPrim(this.prims[pi], o, d, tMin, curTMax)
          if (h) {
            closest = h
            closestId = pi
            curTMax = h.t
          }
        }
      } else {
        stack[sp++] = node.left
        stack[sp++] = node.right
      }
    }
    return closest ? { hit: closest, primId: closestId } : null
  }

  // Any-hit (shadow) traversal: returns true as soon as anything blocks (tMin,tMax).
  occluded(o: Vec3, d: Vec3, tMin: number, tMax: number): boolean {
    const invD = v(1 / d.x, 1 / d.y, 1 / d.z)
    const stack = this.stack
    let sp = 0
    stack[sp++] = 0
    while (sp > 0) {
      const ni = stack[--sp]
      const node = this.nodes[ni]
      if (!aabbHit(node.box, o, invD, tMin, tMax)) continue
      if (node.count > 0) {
        const first = node.left
        for (let k = 0; k < node.count; k++) {
          const pi = this.order[first + k]
          if (intersectPrim(this.prims[pi], o, d, tMin, tMax)) return true
        }
      } else {
        stack[sp++] = node.left
        stack[sp++] = node.right
      }
    }
    return false
  }

  // Preallocated traversal stack (depth is bounded by tree height).
  private stack = new Int32Array(128)
}
