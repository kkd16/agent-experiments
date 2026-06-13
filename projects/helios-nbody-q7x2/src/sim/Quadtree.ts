// Barnes–Hut quadtree.
//
// The naive N-body force calculation is O(n²): every body pulls on every other
// body. Barnes–Hut reduces this to O(n log n) by recursively subdividing space
// into a quadtree. Distant clusters of bodies are approximated by their centre
// of mass, controlled by the opening angle θ (theta): a node of width `s` at
// distance `d` is treated as a single point mass when `s / d < θ`.
//
// The tree is stored in flat typed arrays (struct-of-arrays) rather than as an
// object graph. This keeps allocations out of the hot loop, plays nicely with
// the JIT, and lets us rebuild the whole structure every frame without churning
// the garbage collector.

const QUADRANTS = 4
// A leaf can hold at most one body; deeper than this and we treat coincident
// bodies as merged to avoid infinite subdivision.
const MAX_DEPTH = 64

export class Quadtree {
  // Node geometry: centre and half-width of each node's square cell.
  private cx: Float64Array
  private cy: Float64Array
  private half: Float64Array

  // Aggregate mass and centre of mass of the subtree rooted at each node.
  mass: Float64Array
  comX: Float64Array
  comY: Float64Array

  // children[node * 4 + q] = child node index for quadrant q, or -1.
  private children: Int32Array
  // For a leaf, the body index it holds; -1 for empty or internal nodes.
  private body: Int32Array

  private count = 0
  private capacity: number

  constructor(initialCapacity = 1024) {
    this.capacity = initialCapacity
    this.cx = new Float64Array(initialCapacity)
    this.cy = new Float64Array(initialCapacity)
    this.half = new Float64Array(initialCapacity)
    this.mass = new Float64Array(initialCapacity)
    this.comX = new Float64Array(initialCapacity)
    this.comY = new Float64Array(initialCapacity)
    this.children = new Int32Array(initialCapacity * QUADRANTS)
    this.body = new Int32Array(initialCapacity)
  }

  get nodeCount(): number {
    return this.count
  }

  /** Root node geometry, useful for the debug overlay / camera auto-fit. */
  get rootHalf(): number {
    return this.count > 0 ? this.half[0] : 0
  }

  private grow(): void {
    const next = this.capacity * 2
    const realloc = (src: Float64Array) => {
      const dst = new Float64Array(next)
      dst.set(src)
      return dst
    }
    this.cx = realloc(this.cx)
    this.cy = realloc(this.cy)
    this.half = realloc(this.half)
    this.mass = realloc(this.mass)
    this.comX = realloc(this.comX)
    this.comY = realloc(this.comY)
    const childNext = new Int32Array(next * QUADRANTS)
    childNext.set(this.children)
    this.children = childNext
    const bodyNext = new Int32Array(next)
    bodyNext.set(this.body)
    this.body = bodyNext
    this.capacity = next
  }

  private allocNode(cx: number, cy: number, half: number): number {
    if (this.count >= this.capacity) this.grow()
    const n = this.count++
    this.cx[n] = cx
    this.cy[n] = cy
    this.half[n] = half
    this.mass[n] = 0
    this.comX[n] = 0
    this.comY[n] = 0
    this.body[n] = -1
    const base = n * QUADRANTS
    this.children[base] = -1
    this.children[base + 1] = -1
    this.children[base + 2] = -1
    this.children[base + 3] = -1
    return n
  }

  /** Quadrant index (0..3) of a point relative to a node centre. */
  private quadrant(node: number, x: number, y: number): number {
    // bit 0 = east, bit 1 = north.
    const east = x >= this.cx[node] ? 1 : 0
    const north = y >= this.cy[node] ? 2 : 0
    return east | north
  }

  private childCentre(node: number, q: number): [number, number] {
    const h = this.half[node] * 0.5
    const dx = q & 1 ? h : -h
    const dy = q & 2 ? h : -h
    return [this.cx[node] + dx, this.cy[node] + dy]
  }

  /**
   * Build the tree from scratch for `n` bodies. Positions and masses are the
   * simulation's struct-of-arrays buffers. The root cell is the bounding square
   * of all bodies, padded slightly so nothing sits exactly on a boundary.
   */
  build(n: number, posX: Float64Array, posY: Float64Array, mass: Float64Array): void {
    this.count = 0
    if (n === 0) return

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const x = posX[i]
      const y = posY[i]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    const cx = (minX + maxX) * 0.5
    const cy = (minY + maxY) * 0.5
    // Half-width covering the larger extent, with 5% padding and a floor so a
    // single body (zero extent) still yields a valid cell.
    const extent = Math.max(maxX - minX, maxY - minY, 1e-6)
    const half = extent * 0.5 * 1.05

    this.allocNode(cx, cy, half)
    for (let i = 0; i < n; i++) {
      this.insert(i, posX[i], posY[i], mass[i])
    }
  }

  private insert(bodyIndex: number, x: number, y: number, m: number): void {
    let node = 0
    let depth = 0

    for (;;) {
      const occupant = this.body[node]
      const base = node * QUADRANTS

      const isInternal =
        this.children[base] >= 0 ||
        this.children[base + 1] >= 0 ||
        this.children[base + 2] >= 0 ||
        this.children[base + 3] >= 0

      if (occupant < 0 && !isInternal) {
        // Empty leaf — drop the body here.
        this.body[node] = bodyIndex
        this.mass[node] = m
        this.comX[node] = x
        this.comY[node] = y
        return
      }

      if (occupant >= 0) {
        // Leaf already holds one body. Promote to internal and push the
        // existing occupant down into the appropriate child, unless we have hit
        // the depth cap (coincident bodies) — then just merge masses.
        if (depth >= MAX_DEPTH) {
          const total = this.mass[node] + m
          this.comX[node] = (this.comX[node] * this.mass[node] + x * m) / total
          this.comY[node] = (this.comY[node] * this.mass[node] + y * m) / total
          this.mass[node] = total
          return
        }

        const ex = this.comX[node]
        const ey = this.comY[node]
        const em = this.mass[node]
        this.body[node] = -1

        const eq = this.quadrant(node, ex, ey)
        const [ccx, ccy] = this.childCentre(node, eq)
        const childE = this.allocNode(ccx, ccy, this.half[node] * 0.5)
        this.children[node * QUADRANTS + eq] = childE
        this.body[childE] = occupant
        this.mass[childE] = em
        this.comX[childE] = ex
        this.comY[childE] = ey
        // Fall through: node is now internal, loop continues below.
      }

      // Internal node: fold the incoming body into this subtree's centre of
      // mass, then descend into the matching quadrant (creating it if absent).
      const total = this.mass[node] + m
      this.comX[node] = (this.comX[node] * this.mass[node] + x * m) / total
      this.comY[node] = (this.comY[node] * this.mass[node] + y * m) / total
      this.mass[node] = total

      const q = this.quadrant(node, x, y)
      let child = this.children[node * QUADRANTS + q]
      if (child < 0) {
        const [ccx, ccy] = this.childCentre(node, q)
        child = this.allocNode(ccx, ccy, this.half[node] * 0.5)
        this.children[node * QUADRANTS + q] = child
      }
      node = child
      depth++
    }
  }

  /**
   * Accumulate the gravitational acceleration on a body at (x, y) using the
   * Barnes–Hut opening criterion. `theta2` is θ², `eps2` the squared softening
   * length (which removes the singularity as r → 0), `g` the gravitational
   * constant. Self-interaction is skipped via `selfIndex`.
   *
   * Returns nothing; writes into the provided 2-element scratch via the return
   * tuple to avoid allocation, we instead use out-params through a closure-free
   * stack walk and return the pair.
   */
  acceleration(
    x: number,
    y: number,
    selfIndex: number,
    theta2: number,
    eps2: number,
    g: number,
    stack: Int32Array,
  ): [number, number] {
    let ax = 0
    let ay = 0
    let sp = 0
    stack[sp++] = 0

    while (sp > 0) {
      const node = stack[--sp]
      const m = this.mass[node]
      if (m === 0) continue

      const dx = this.comX[node] - x
      const dy = this.comY[node] - y
      const r2 = dx * dx + dy * dy

      const base = node * QUADRANTS
      const c0 = this.children[base]
      const c1 = this.children[base + 1]
      const c2 = this.children[base + 2]
      const c3 = this.children[base + 3]
      const isLeaf = c0 < 0 && c1 < 0 && c2 < 0 && c3 < 0

      if (isLeaf) {
        if (this.body[node] === selfIndex) continue
        const inv = 1 / (r2 + eps2)
        const invSqrt = Math.sqrt(inv)
        const f = g * m * inv * invSqrt
        ax += f * dx
        ay += f * dy
        continue
      }

      // Opening criterion: s² < θ² · d² ⇒ treat node as a single point mass.
      const s = this.half[node] * 2
      if (s * s < theta2 * r2) {
        const inv = 1 / (r2 + eps2)
        const invSqrt = Math.sqrt(inv)
        const f = g * m * inv * invSqrt
        ax += f * dx
        ay += f * dy
      } else {
        if (c0 >= 0) stack[sp++] = c0
        if (c1 >= 0) stack[sp++] = c1
        if (c2 >= 0) stack[sp++] = c2
        if (c3 >= 0) stack[sp++] = c3
      }
    }

    return [ax, ay]
  }

  /**
   * Visit every node's square cell for the debug overlay. Calls `visit(cx, cy,
   * half, isLeaf)` for each allocated node.
   */
  forEachCell(visit: (cx: number, cy: number, half: number, isLeaf: boolean) => void): void {
    for (let n = 0; n < this.count; n++) {
      const base = n * QUADRANTS
      const isLeaf =
        this.children[base] < 0 &&
        this.children[base + 1] < 0 &&
        this.children[base + 2] < 0 &&
        this.children[base + 3] < 0
      visit(this.cx[n], this.cy[n], this.half[n], isLeaf)
    }
  }
}
