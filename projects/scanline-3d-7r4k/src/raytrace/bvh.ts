// A binned surface-area-heuristic bounding volume hierarchy over the scene's
// triangle soup. Build cost is O(n log n); each ray then costs O(log n) instead of
// testing every triangle. Nodes are stored in flat typed arrays (structure-of-
// arrays) and traversed with a small explicit stack — no per-ray allocation.
import { rayAABB } from './intersect.ts'
import type { RTScene } from './rtscene.ts'

const BINS = 12
const MAX_LEAF = 4

export interface ClosestHit {
  t: number
  tri: number
  u: number
  v: number
}

function area(minx: number, miny: number, minz: number, maxx: number, maxy: number, maxz: number): number {
  const dx = maxx - minx, dy = maxy - miny, dz = maxz - minz
  return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx)
}

export class BVH {
  private readonly scene: RTScene
  private readonly triIndex: Int32Array
  private readonly nodeMin: Float32Array
  private readonly nodeMax: Float32Array
  private readonly nodeLeftFirst: Int32Array // internal: left child index; leaf: first triangle
  private readonly nodeCount: Int32Array // 0 = internal node
  private nodesUsed = 0
  nodeTotal = 0
  // reused per-ray traversal stack (depth is bounded by ~2·log₂n)
  private readonly stack = new Int32Array(128)
  // reused SAH bin scratch
  private readonly binCount = new Int32Array(BINS)
  private readonly binMin = new Float32Array(BINS * 3)
  private readonly binMax = new Float32Array(BINS * 3)

  constructor(scene: RTScene) {
    this.scene = scene
    const n = scene.count
    this.triIndex = new Int32Array(n)
    for (let i = 0; i < n; i++) this.triIndex[i] = i
    const maxNodes = Math.max(1, 2 * n)
    this.nodeMin = new Float32Array(maxNodes * 3)
    this.nodeMax = new Float32Array(maxNodes * 3)
    this.nodeLeftFirst = new Int32Array(maxNodes)
    this.nodeCount = new Int32Array(maxNodes)
    if (n > 0) this.build()
  }

  private build(): void {
    this.nodesUsed = 1
    this.nodeLeftFirst[0] = 0
    this.nodeCount[0] = this.scene.count
    this.updateBounds(0)
    this.subdivide(0)
    this.nodeTotal = this.nodesUsed
  }

  private updateBounds(node: number): void {
    const { triMin, triMax } = this.scene
    let minx = Infinity, miny = Infinity, minz = Infinity
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    const first = this.nodeLeftFirst[node]
    const count = this.nodeCount[node]
    for (let i = 0; i < count; i++) {
      const t = this.triIndex[first + i] * 3
      if (triMin[t] < minx) minx = triMin[t]
      if (triMin[t + 1] < miny) miny = triMin[t + 1]
      if (triMin[t + 2] < minz) minz = triMin[t + 2]
      if (triMax[t] > maxx) maxx = triMax[t]
      if (triMax[t + 1] > maxy) maxy = triMax[t + 1]
      if (triMax[t + 2] > maxz) maxz = triMax[t + 2]
    }
    const o = node * 3
    this.nodeMin[o] = minx; this.nodeMin[o + 1] = miny; this.nodeMin[o + 2] = minz
    this.nodeMax[o] = maxx; this.nodeMax[o + 1] = maxy; this.nodeMax[o + 2] = maxz
  }

  private subdivide(node: number): void {
    const count = this.nodeCount[node]
    if (count <= MAX_LEAF) return
    const first = this.nodeLeftFirst[node]
    const { centroid } = this.scene

    // centroid bounds of this node
    let cminx = Infinity, cminy = Infinity, cminz = Infinity
    let cmaxx = -Infinity, cmaxy = -Infinity, cmaxz = -Infinity
    for (let i = 0; i < count; i++) {
      const c = this.triIndex[first + i] * 3
      const x = centroid[c], y = centroid[c + 1], z = centroid[c + 2]
      if (x < cminx) cminx = x; if (x > cmaxx) cmaxx = x
      if (y < cminy) cminy = y; if (y > cmaxy) cmaxy = y
      if (z < cminz) cminz = z; if (z > cmaxz) cmaxz = z
    }
    const cmin = [cminx, cminy, cminz]
    const ext = [cmaxx - cminx, cmaxy - cminy, cmaxz - cminz]

    // search all three axes for the lowest-SAH bin plane
    let bestAxis = -1
    let bestPos = 0
    let bestCost = Infinity
    for (let axis = 0; axis < 3; axis++) {
      if (ext[axis] < 1e-9) continue
      const scale = BINS / ext[axis]
      this.binCount.fill(0)
      for (let b = 0; b < BINS; b++) {
        this.binMin[b * 3] = Infinity; this.binMin[b * 3 + 1] = Infinity; this.binMin[b * 3 + 2] = Infinity
        this.binMax[b * 3] = -Infinity; this.binMax[b * 3 + 1] = -Infinity; this.binMax[b * 3 + 2] = -Infinity
      }
      for (let i = 0; i < count; i++) {
        const tri = this.triIndex[first + i]
        const c = tri * 3
        let b = ((centroid[c + axis] - cmin[axis]) * scale) | 0
        if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1
        this.binCount[b]++
        const tb = tri * 3
        const bo = b * 3
        if (this.scene.triMin[tb] < this.binMin[bo]) this.binMin[bo] = this.scene.triMin[tb]
        if (this.scene.triMin[tb + 1] < this.binMin[bo + 1]) this.binMin[bo + 1] = this.scene.triMin[tb + 1]
        if (this.scene.triMin[tb + 2] < this.binMin[bo + 2]) this.binMin[bo + 2] = this.scene.triMin[tb + 2]
        if (this.scene.triMax[tb] > this.binMax[bo]) this.binMax[bo] = this.scene.triMax[tb]
        if (this.scene.triMax[tb + 1] > this.binMax[bo + 1]) this.binMax[bo + 1] = this.scene.triMax[tb + 1]
        if (this.scene.triMax[tb + 2] > this.binMax[bo + 2]) this.binMax[bo + 2] = this.scene.triMax[tb + 2]
      }

      // sweep from the left and right to accumulate area·count on each side
      const leftArea = new Float64Array(BINS - 1)
      const leftCount = new Int32Array(BINS - 1)
      const rightArea = new Float64Array(BINS - 1)
      const rightCount = new Int32Array(BINS - 1)
      let lminx = Infinity, lminy = Infinity, lminz = Infinity, lmaxx = -Infinity, lmaxy = -Infinity, lmaxz = -Infinity
      let lcount = 0
      for (let i = 0; i < BINS - 1; i++) {
        lcount += this.binCount[i]
        const bo = i * 3
        if (this.binMin[bo] < lminx) lminx = this.binMin[bo]
        if (this.binMin[bo + 1] < lminy) lminy = this.binMin[bo + 1]
        if (this.binMin[bo + 2] < lminz) lminz = this.binMin[bo + 2]
        if (this.binMax[bo] > lmaxx) lmaxx = this.binMax[bo]
        if (this.binMax[bo + 1] > lmaxy) lmaxy = this.binMax[bo + 1]
        if (this.binMax[bo + 2] > lmaxz) lmaxz = this.binMax[bo + 2]
        leftCount[i] = lcount
        leftArea[i] = area(lminx, lminy, lminz, lmaxx, lmaxy, lmaxz)
      }
      let rminx = Infinity, rminy = Infinity, rminz = Infinity, rmaxx = -Infinity, rmaxy = -Infinity, rmaxz = -Infinity
      let rcount = 0
      for (let i = BINS - 1; i >= 1; i--) {
        rcount += this.binCount[i]
        const bo = i * 3
        if (this.binMin[bo] < rminx) rminx = this.binMin[bo]
        if (this.binMin[bo + 1] < rminy) rminy = this.binMin[bo + 1]
        if (this.binMin[bo + 2] < rminz) rminz = this.binMin[bo + 2]
        if (this.binMax[bo] > rmaxx) rmaxx = this.binMax[bo]
        if (this.binMax[bo + 1] > rmaxy) rmaxy = this.binMax[bo + 1]
        if (this.binMax[bo + 2] > rmaxz) rmaxz = this.binMax[bo + 2]
        rightCount[i - 1] = rcount
        rightArea[i - 1] = area(rminx, rminy, rminz, rmaxx, rmaxy, rmaxz)
      }
      for (let i = 0; i < BINS - 1; i++) {
        const cost = leftArea[i] * leftCount[i] + rightArea[i] * rightCount[i]
        if (cost > 0 && cost < bestCost) {
          bestCost = cost
          bestAxis = axis
          bestPos = cmin[axis] + ext[axis] * ((i + 1) / BINS)
        }
      }
    }

    if (bestAxis < 0) return // degenerate (all centroids coincident) → leaf
    // don't split if the SAH says a leaf is cheaper than the best partition
    const o = node * 3
    const parentArea = area(
      this.nodeMin[o], this.nodeMin[o + 1], this.nodeMin[o + 2],
      this.nodeMax[o], this.nodeMax[o + 1], this.nodeMax[o + 2],
    )
    if (bestCost >= parentArea * count) return

    // partition triangles around bestPos on bestAxis (in-place)
    let i = first
    let j = first + count - 1
    while (i <= j) {
      const tri = this.triIndex[i]
      if (centroid[tri * 3 + bestAxis] < bestPos) {
        i++
      } else {
        this.triIndex[i] = this.triIndex[j]
        this.triIndex[j] = tri
        j--
      }
    }
    const leftCount = i - first
    if (leftCount === 0 || leftCount === count) return // partition failed → leaf

    const left = this.nodesUsed++
    const right = this.nodesUsed++
    this.nodeLeftFirst[left] = first
    this.nodeCount[left] = leftCount
    this.nodeLeftFirst[right] = i
    this.nodeCount[right] = count - leftCount
    this.nodeLeftFirst[node] = left
    this.nodeCount[node] = 0 // mark internal
    this.updateBounds(left)
    this.updateBounds(right)
    this.subdivide(left)
    this.subdivide(right)
  }

  // Nearest hit along the ray within (tMin, tMax). Writes into `out` and returns it,
  // or returns null on a miss. `dir` is assumed normalized (t is world distance).
  closest(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    tMin: number, tMax: number,
    out: ClosestHit,
  ): ClosestHit | null {
    if (this.scene.count === 0) return null
    const invx = 1 / dx, invy = 1 / dy, invz = 1 / dz
    const { p0, e1, e2 } = this.scene
    const stack = this.stack
    let sp = 0
    stack[sp++] = 0
    let bestT = tMax
    let found = false
    while (sp > 0) {
      const node = stack[--sp]
      const o = node * 3
      const enter = rayAABB(
        ox, oy, oz, invx, invy, invz,
        this.nodeMin[o], this.nodeMin[o + 1], this.nodeMin[o + 2],
        this.nodeMax[o], this.nodeMax[o + 1], this.nodeMax[o + 2],
        tMin, bestT,
      )
      if (enter === Infinity) continue
      const count = this.nodeCount[node]
      if (count === 0) {
        // internal: push both children, nearer one last so it's popped first
        const left = this.nodeLeftFirst[node]
        const right = left + 1
        const lo = left * 3, ro = right * 3
        const tl = rayAABB(ox, oy, oz, invx, invy, invz,
          this.nodeMin[lo], this.nodeMin[lo + 1], this.nodeMin[lo + 2],
          this.nodeMax[lo], this.nodeMax[lo + 1], this.nodeMax[lo + 2], tMin, bestT)
        const tr = rayAABB(ox, oy, oz, invx, invy, invz,
          this.nodeMin[ro], this.nodeMin[ro + 1], this.nodeMin[ro + 2],
          this.nodeMax[ro], this.nodeMax[ro + 1], this.nodeMax[ro + 2], tMin, bestT)
        if (tl < tr) {
          if (tr !== Infinity) stack[sp++] = right
          if (tl !== Infinity) stack[sp++] = left
        } else {
          if (tl !== Infinity) stack[sp++] = left
          if (tr !== Infinity) stack[sp++] = right
        }
      } else {
        const first = this.nodeLeftFirst[node]
        for (let k = 0; k < count; k++) {
          const tri = this.triIndex[first + k]
          const a3 = tri * 3
          // inlined Möller–Trumbore
          const e1x = e1[a3], e1y = e1[a3 + 1], e1z = e1[a3 + 2]
          const e2x = e2[a3], e2y = e2[a3 + 1], e2z = e2[a3 + 2]
          const px = dy * e2z - dz * e2y
          const py = dz * e2x - dx * e2z
          const pz = dx * e2y - dy * e2x
          const det = e1x * px + e1y * py + e1z * pz
          if (det > -1e-9 && det < 1e-9) continue
          const inv = 1 / det
          const tx = ox - p0[a3], ty = oy - p0[a3 + 1], tz = oz - p0[a3 + 2]
          const u = (tx * px + ty * py + tz * pz) * inv
          if (u < 0 || u > 1) continue
          const qx = ty * e1z - tz * e1y
          const qy = tz * e1x - tx * e1z
          const qz = tx * e1y - ty * e1x
          const vv = (dx * qx + dy * qy + dz * qz) * inv
          if (vv < 0 || u + vv > 1) continue
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv
          if (t < tMin || t >= bestT) continue
          bestT = t
          out.t = t; out.tri = tri; out.u = u; out.v = vv
          found = true
        }
      }
    }
    return found ? out : null
  }

  // Any-hit shadow query: is anything blocking the segment (tMin, tMax)?
  occluded(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    tMin: number, tMax: number,
  ): boolean {
    if (this.scene.count === 0) return false
    const invx = 1 / dx, invy = 1 / dy, invz = 1 / dz
    const { p0, e1, e2 } = this.scene
    const stack = this.stack
    let sp = 0
    stack[sp++] = 0
    while (sp > 0) {
      const node = stack[--sp]
      const o = node * 3
      const enter = rayAABB(ox, oy, oz, invx, invy, invz,
        this.nodeMin[o], this.nodeMin[o + 1], this.nodeMin[o + 2],
        this.nodeMax[o], this.nodeMax[o + 1], this.nodeMax[o + 2], tMin, tMax)
      if (enter === Infinity) continue
      const count = this.nodeCount[node]
      if (count === 0) {
        const left = this.nodeLeftFirst[node]
        stack[sp++] = left
        stack[sp++] = left + 1
      } else {
        const first = this.nodeLeftFirst[node]
        for (let k = 0; k < count; k++) {
          const tri = this.triIndex[first + k]
          const a3 = tri * 3
          const e1x = e1[a3], e1y = e1[a3 + 1], e1z = e1[a3 + 2]
          const e2x = e2[a3], e2y = e2[a3 + 1], e2z = e2[a3 + 2]
          const px = dy * e2z - dz * e2y
          const py = dz * e2x - dx * e2z
          const pz = dx * e2y - dy * e2x
          const det = e1x * px + e1y * py + e1z * pz
          if (det > -1e-9 && det < 1e-9) continue
          const inv = 1 / det
          const tx = ox - p0[a3], ty = oy - p0[a3 + 1], tz = oz - p0[a3 + 2]
          const u = (tx * px + ty * py + tz * pz) * inv
          if (u < 0 || u > 1) continue
          const qx = ty * e1z - tz * e1y
          const qy = tz * e1x - tx * e1z
          const qz = tx * e1y - ty * e1x
          const vv = (dx * qx + dy * qy + dz * qz) * inv
          if (vv < 0 || u + vv > 1) continue
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv
          if (t > tMin && t < tMax) return true
        }
      }
    }
    return false
  }

  // The world-space AABB of the whole scene (the root node's bounds), or null when
  // there is no geometry. Used to fit a participating medium's box to the scene.
  worldBounds(): { minx: number; miny: number; minz: number; maxx: number; maxy: number; maxz: number } | null {
    if (this.scene.count === 0) return null
    return {
      minx: this.nodeMin[0], miny: this.nodeMin[1], minz: this.nodeMin[2],
      maxx: this.nodeMax[0], maxy: this.nodeMax[1], maxz: this.nodeMax[2],
    }
  }
}
