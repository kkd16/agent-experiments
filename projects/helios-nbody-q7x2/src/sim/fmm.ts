// The Fast Multipole Method — gravity in O(N).
//
// Barnes–Hut (see `Quadtree.ts`) is O(N log N): every body still walks the tree
// individually. The Fast Multipole Method (Greengard & Rokhlin 1987) removes
// that last log by talking *cell-to-cell*. A cluster of sources is summarised
// once as a **multipole expansion** about its centre; a cluster of well-separated
// targets receives that influence once as a **local (Taylor) expansion** about
// *their* centre, which every body in the cell then simply evaluates. Each body's
// far field is assembled from a bounded number of these cell-to-cell transfers,
// so the whole force solve is O(N) — one of the algorithms that reshaped
// scientific computing.
//
// This is a **kernel-exact, 2-D Cartesian** FMM specialised to Helios's force
// law: the Plummer-softened Newtonian kernel
//
//     G(d) = 1 / √(dx² + dy² + ε²),     Φ(x) = −Σ_j g·m_j·G(x − x_j),     a = −∇Φ.
//
// The softening ε makes the kernel *analytic everywhere* — there is no longer a
// 1/r singularity — so the clean route is to expand Φ in a multivariate Taylor
// series. Source clusters become Cartesian moments M_k = Σ q·v^k; the cell-to-cell
// transfer (M2L) convolves those moments against the kernel's own Taylor
// coefficients, which obey the regularised-Coulomb recurrence of Duan & Krasny
// (2001) — exact, ε included natively, no special functions.
//
// Everything here matches `Quadtree.acceleration` byte-for-byte in the limit of
// high order and small θ, which is exactly what the FMM Lab and the self-tests
// check: the FMM is validated against the O(N²) direct sum it accelerates.

// ---------------------------------------------------------------------------
// Multi-index bookkeeping for 2-D Taylor expansions of total degree ≤ p.
//
// A coefficient array stores one number per multi-index (a, b) with a + b ≤ p,
// packed degree-major: degree 0 first, then degree 1, … Within a degree d the
// pairs run (0,d), (1,d−1), …, (d,0). `tri(p)` is the count, `midx(a,b)` the slot.
// ---------------------------------------------------------------------------

/** Number of multi-indices (a, b) with a + b ≤ p. */
export function triCount(p: number): number {
  return ((p + 1) * (p + 2)) / 2
}

/** Flat slot of multi-index (a, b), degree-major. Caller guarantees a + b ≤ p. */
function midx(a: number, b: number): number {
  const d = a + b
  return (d * (d + 1)) / 2 + a
}

/** Pascal's triangle up to order p (inclusive), row-major (p+1)×(p+1). */
function binomialTable(p: number): Float64Array {
  const n = p + 1
  const c = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    c[i * n] = 1
    for (let j = 1; j <= i; j++) c[i * n + j] = c[(i - 1) * n + (j - 1)] + c[(i - 1) * n + j]
  }
  return c
}

// ---------------------------------------------------------------------------
// The kernel's own Taylor coefficients.
//
// a_{i,j}(R) = (1/(i! j!)) ∂^{i+j} G / ∂x^i ∂y^j evaluated at the displacement R,
// for the softened kernel G = (Rx² + Ry² + ε²)^{−1/2}. These are the *normalised*
// derivatives, and they satisfy a three-term recurrence in the total degree
// n = i + j (Duan & Krasny 2001; the ε² simply rides along inside s):
//
//   n · s · a_{i,j} = (2n−1)·(Rx·a_{i−1,j} + Ry·a_{i,j−1}) − (n−1)·(a_{i−2,j} + a_{i,j−2}),
//
// with a_{0,0} = s^{−1/2}, s = Rx² + Ry² + ε², and a ≡ 0 for any negative index.
// Filled in increasing degree, this gives every coefficient up to order p with no
// special functions — verified against finite differences in the self-tests.
// ---------------------------------------------------------------------------

/** Normalised kernel Taylor coefficients a_{i,j} at displacement R, up to order p.
 *  Writes into `out` when supplied (length ≥ triCount(p)) to avoid allocation. */
export function kernelTaylor(rx: number, ry: number, eps2: number, p: number, out?: Float64Array): Float64Array {
  const s = rx * rx + ry * ry + eps2
  const a = out ?? new Float64Array(triCount(p))
  a[0] = 1 / Math.sqrt(s)
  const invS = 1 / s
  for (let n = 1; n <= p; n++) {
    const c1 = (2 * n - 1) / n
    const c2 = (n - 1) / n
    for (let i = 0; i <= n; i++) {
      const j = n - i
      let v = 0
      if (i >= 1) v += rx * a[midx(i - 1, j)]
      if (j >= 1) v += ry * a[midx(i, j - 1)]
      v *= c1
      if (i >= 2) v -= c2 * a[midx(i - 2, j)]
      if (j >= 2) v -= c2 * a[midx(i, j - 2)]
      a[midx(i, j)] = v * invS
    }
  }
  // The recurrence yields coefficients with a (−1)^(i+j) sign relative to the
  // true derivatives (it expands G in the −δ direction). Flip the odd-degree
  // terms so a_{i,j} = (1/(i! j!)) ∂^{i+j}G/∂x^i∂y^j exactly — verified against
  // finite differences in the self-tests.
  for (let n = 1; n <= p; n += 2) {
    const o = (n * (n + 1)) / 2
    for (let i = 0; i <= n; i++) a[o + i] = -a[o + i]
  }
  return a
}

// ---------------------------------------------------------------------------
// Adaptive quadtree. Cells subdivide until they hold ≤ ncrit bodies (or hit the
// depth cap). Bodies are stored in a permutation array `order`; each leaf owns a
// contiguous slice [start, start+count). Internal nodes carry no bodies of their
// own — their influence lives in their descendants' moments.
// ---------------------------------------------------------------------------

interface FmmTree {
  cx: Float64Array
  cy: Float64Array
  half: Float64Array
  child: Int32Array // child[node*4 + q] = node index or -1
  start: Int32Array // leaf body-slice start in `order`
  count: Int32Array // leaf body count (0 for internal nodes)
  order: Int32Array // body indices grouped by leaf
  nodeCount: number
}

function buildTree(
  n: number,
  posX: Float64Array,
  posY: Float64Array,
  ncrit: number,
  maxDepth: number,
): FmmTree {
  // Root cell: the square bounding box of all bodies, padded so points on the
  // boundary land strictly inside.
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
  const cx0 = (minX + maxX) / 2
  const cy0 = (minY + maxY) / 2
  let half0 = Math.max(maxX - minX, maxY - minY) / 2
  if (!(half0 > 0)) half0 = 1 // all coincident — any positive size works
  half0 *= 1.0000001

  // Generous capacity; grows if a pathological clustering needs more nodes.
  let cap = Math.max(16, Math.ceil((4 * n) / Math.max(1, ncrit)) + 16)
  let cx = new Float64Array(cap)
  let cy = new Float64Array(cap)
  let half = new Float64Array(cap)
  let child = new Int32Array(cap * 4).fill(-1)
  let start = new Int32Array(cap)
  let count = new Int32Array(cap)

  const grow = () => {
    const nc = cap * 2
    const fx = (src: Float64Array) => {
      const d = new Float64Array(nc)
      d.set(src)
      return d
    }
    cx = fx(cx)
    cy = fx(cy)
    half = fx(half)
    const nch = new Int32Array(nc * 4).fill(-1)
    nch.set(child)
    child = nch
    const ns = new Int32Array(nc)
    ns.set(start)
    start = ns
    const ncnt = new Int32Array(nc)
    ncnt.set(count)
    count = ncnt
    cap = nc
  }

  let nodeCount = 0
  const newNode = (ccx: number, ccy: number, chalf: number): number => {
    if (nodeCount >= cap) grow()
    const id = nodeCount++
    cx[id] = ccx
    cy[id] = ccy
    half[id] = chalf
    child[id * 4] = -1
    child[id * 4 + 1] = -1
    child[id * 4 + 2] = -1
    child[id * 4 + 3] = -1
    count[id] = 0
    return id
  }

  // Body index buffer (a permutation we partition in place by quadrant).
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  const scratch = new Int32Array(n)

  const root = newNode(cx0, cy0, half0)

  // Recursively split the slice order[lo, hi) belonging to `node`.
  const split = (node: number, lo: number, hi: number, depth: number): void => {
    const cnt = hi - lo
    if (cnt <= ncrit || depth >= maxDepth) {
      start[node] = lo
      count[node] = cnt
      return
    }
    const ncx = cx[node]
    const ncy = cy[node]
    const h = half[node] / 2
    // Counting sort the slice into the four quadrants (q = (x≥cx) | (y≥cy)<<1).
    const qc = [0, 0, 0, 0]
    for (let i = lo; i < hi; i++) {
      const b = order[i]
      const q = (posX[b] >= ncx ? 1 : 0) | (posY[b] >= ncy ? 2 : 0)
      qc[q]++
    }
    const qStart = [lo, lo + qc[0], lo + qc[0] + qc[1], lo + qc[0] + qc[1] + qc[2]]
    const cur = [qStart[0], qStart[1], qStart[2], qStart[3]]
    for (let i = lo; i < hi; i++) {
      const b = order[i]
      const q = (posX[b] >= ncx ? 1 : 0) | (posY[b] >= ncy ? 2 : 0)
      scratch[cur[q]++] = b
    }
    for (let i = lo; i < hi; i++) order[i] = scratch[i]
    // Create the (non-empty) children and recurse.
    for (let q = 0; q < 4; q++) {
      if (qc[q] === 0) continue
      const ccx = ncx + (q & 1 ? h : -h)
      const ccy = ncy + (q & 2 ? h : -h)
      const c = newNode(ccx, ccy, h)
      child[node * 4 + q] = c
      const s = qStart[q]
      split(c, s, s + qc[q], depth + 1)
    }
  }
  split(root, 0, n, 0)

  return {
    cx: cx.subarray(0, nodeCount),
    cy: cy.subarray(0, nodeCount),
    half: half.subarray(0, nodeCount),
    child: child.subarray(0, nodeCount * 4),
    start,
    count,
    order,
    nodeCount,
  }
}

// ---------------------------------------------------------------------------
// The FMM force solve.
// ---------------------------------------------------------------------------

export interface FmmOptions {
  /** Expansion order p — the maximum total Taylor degree. Accuracy ↑ with p. */
  order: number
  /** Multipole-acceptance parameter θ ∈ (0,1): accept a cell pair when the sum of
   *  their radii ≤ θ·(centre distance). Smaller θ ⇒ more direct work ⇒ accuracy ↑. */
  theta: number
  /** Softening length squared, ε². */
  eps2: number
  /** Gravitational constant g. */
  g: number
  /** Max bodies per leaf before subdividing (default 32). */
  ncrit?: number
  /** Depth cap (default 32). */
  maxDepth?: number
}

export interface FmmStats {
  nodes: number
  /** Number of cell-to-cell multipole→local transfers performed. */
  m2l: number
  /** Number of body pairs evaluated directly in the near field. */
  p2p: number
  /** Number of bodies. */
  n: number
}

/**
 * O(N) gravitational acceleration for every body, written into `outX`/`outY`.
 * Uses the exact same softened Newtonian kernel as `Quadtree.acceleration`, so
 * the result converges to the direct O(N²) sum as the order rises and θ falls.
 */
export function fmmAccel(
  n: number,
  posX: Float64Array,
  posY: Float64Array,
  mass: Float64Array,
  opts: FmmOptions,
  outX: Float64Array,
  outY: Float64Array,
): FmmStats {
  const p = Math.max(0, Math.floor(opts.order))
  const theta = opts.theta
  const eps2 = opts.eps2
  const g = opts.g
  const ncrit = Math.max(1, opts.ncrit ?? 32)
  const maxDepth = opts.maxDepth ?? 32

  for (let i = 0; i < n; i++) {
    outX[i] = 0
    outY[i] = 0
  }
  if (n === 0) return { nodes: 0, m2l: 0, p2p: 0, n: 0 }

  const tree = buildTree(n, posX, posY, ncrit, maxDepth)
  const { cx, cy, half, child, start, count, order, nodeCount } = tree
  const T = triCount(p)
  const C = binomialTable(p)
  const cN = p + 1
  const M = new Float64Array(nodeCount * T) // multipole moments per node
  const L = new Float64Array(nodeCount * T) // local coefficients per node

  // Per-body local powers, reused.
  const px = new Float64Array(p + 1)
  const py = new Float64Array(p + 1)
  const isLeaf = (node: number) => child[node * 4] < 0 && child[node * 4 + 1] < 0 && child[node * 4 + 2] < 0 && child[node * 4 + 3] < 0

  // --- Upward pass: P2M at leaves, then M2M up to the root. -----------------
  // Post-order: because children are always created with a larger node index
  // than their parent here? No — children get HIGHER indices than the parent, so
  // a reverse sweep visits children before parents. We rely on that ordering.
  for (let node = nodeCount - 1; node >= 0; node--) {
    const base = node * T
    if (isLeaf(node)) {
      // P2M — accumulate raw moments M_{a,b} = Σ q·(x−cx)^a·(y−cy)^b.
      const lo = start[node]
      const hi = lo + count[node]
      const ncx = cx[node]
      const ncy = cy[node]
      for (let k = lo; k < hi; k++) {
        const bi = order[k]
        const q = mass[bi]
        const dx = posX[bi] - ncx
        const dy = posY[bi] - ncy
        px[0] = 1
        py[0] = 1
        for (let d = 1; d <= p; d++) {
          px[d] = px[d - 1] * dx
          py[d] = py[d - 1] * dy
        }
        for (let a = 0; a <= p; a++) {
          const qa = q * px[a]
          for (let b = 0; a + b <= p; b++) {
            M[base + midx(a, b)] += qa * py[b]
          }
        }
      }
    } else {
      // M2M — fold each child's moments, shifted to this node's centre.
      for (let qd = 0; qd < 4; qd++) {
        const c = child[node * 4 + qd]
        if (c < 0) continue
        const cbase = c * T
        const tx = cx[c] - cx[node]
        const ty = cy[c] - cy[node]
        // Powers of the shift.
        px[0] = 1
        py[0] = 1
        for (let d = 1; d <= p; d++) {
          px[d] = px[d - 1] * tx
          py[d] = py[d - 1] * ty
        }
        for (let a = 0; a <= p; a++) {
          for (let b = 0; a + b <= p; b++) {
            let acc = 0
            for (let ap = 0; ap <= a; ap++) {
              const cax = C[a * cN + ap] * px[a - ap]
              for (let bp = 0; bp <= b; bp++) {
                acc += cax * C[b * cN + bp] * py[b - bp] * M[cbase + midx(ap, bp)]
              }
            }
            M[base + midx(a, b)] += acc
          }
        }
      }
    }
  }

  // --- Interaction pass: dual-tree traversal with the multipole-accept test. -
  // M2L writes into a target cell's local expansion; near pairs go to P2P, which
  // writes directly into the body accelerations.
  const stats: FmmStats = { nodes: nodeCount, m2l: 0, p2p: 0, n }
  const SQRT2 = Math.SQRT2

  // M2L: add source node B's far field into target node A's local coefficients.
  const aBuf = new Float64Array(T) // reused kernel-coefficient scratch
  const m2l = (A: number, B: number) => {
    const abase = A * T
    const bbase = B * T
    const rx = cx[A] - cx[B]
    const ry = cy[A] - cy[B]
    const a = kernelTaylor(rx, ry, eps2, p, aBuf)
    // λ_{m} = −g · Σ_k (−1)^{|k|} C(m1+k1,m1) C(m2+k2,m2) a_{m+k} M_k.
    for (let m1 = 0; m1 <= p; m1++) {
      for (let m2 = 0; m1 + m2 <= p; m2++) {
        let acc = 0
        const remM = p - m1 - m2
        for (let k1 = 0; k1 <= remM; k1++) {
          const cb1 = C[(m1 + k1) * cN + m1]
          for (let k2 = 0; k1 + k2 <= remM; k2++) {
            const sgn = (k1 + k2) & 1 ? -1 : 1
            acc += sgn * cb1 * C[(m2 + k2) * cN + m2] * a[midx(m1 + k1, m2 + k2)] * M[bbase + midx(k1, k2)]
          }
        }
        L[abase + midx(m1, m2)] += -g * acc
      }
    }
    stats.m2l++
  }

  // P2P: exact softened pairwise force from source node B onto target node A.
  const p2p = (A: number, B: number) => {
    const aLo = start[A]
    const aHi = aLo + count[A]
    const bLo = start[B]
    const bHi = bLo + count[B]
    for (let ia = aLo; ia < aHi; ia++) {
      const i = order[ia]
      const xi = posX[i]
      const yi = posY[i]
      let ax = 0
      let ay = 0
      for (let ib = bLo; ib < bHi; ib++) {
        const j = order[ib]
        if (j === i) continue
        const dx = posX[j] - xi
        const dy = posY[j] - yi
        const inv = 1 / (dx * dx + dy * dy + eps2)
        const f = g * mass[j] * inv * Math.sqrt(inv)
        ax += f * dx
        ay += f * dy
      }
      outX[i] += ax
      outY[i] += ay
    }
    stats.p2p += (aHi - aLo) * (bHi - bLo)
  }

  // Dual-tree traversal. Visits ordered cell pairs; each target receives every
  // source exactly once. Self-overlap resolves by splitting down to leaves.
  const interact = (A: number, B: number) => {
    const rx = cx[A] - cx[B]
    const ry = cy[A] - cy[B]
    const dist = Math.sqrt(rx * rx + ry * ry)
    const rA = half[A] * SQRT2
    const rB = half[B] * SQRT2
    if (rA + rB <= theta * dist) {
      m2l(A, B)
      return
    }
    const aLeaf = isLeaf(A)
    const bLeaf = isLeaf(B)
    if (aLeaf && bLeaf) {
      p2p(A, B)
      return
    }
    // Split the larger of the two cells (or whichever isn't a leaf).
    if (bLeaf || (!aLeaf && half[A] >= half[B])) {
      for (let q = 0; q < 4; q++) {
        const c = child[A * 4 + q]
        if (c >= 0) interact(c, B)
      }
    } else {
      for (let q = 0; q < 4; q++) {
        const c = child[B * 4 + q]
        if (c >= 0) interact(A, c)
      }
    }
  }
  interact(0, 0)

  // --- Downward pass: L2L pushes locals from parents to children. -----------
  // Forward sweep visits parents before children (parents have lower indices).
  for (let node = 0; node < nodeCount; node++) {
    if (isLeaf(node)) continue
    const pbase = node * T
    for (let qd = 0; qd < 4; qd++) {
      const c = child[node * 4 + qd]
      if (c < 0) continue
      const cbase = c * T
      const tx = cx[c] - cx[node]
      const ty = cy[c] - cy[node]
      px[0] = 1
      py[0] = 1
      for (let d = 1; d <= p; d++) {
        px[d] = px[d - 1] * tx
        py[d] = py[d - 1] * ty
      }
      // λ_child_{m} += Σ_{Mm≥m} C(M1,m1) C(M2,m2) t^{M−m} λ_parent_{M}.
      for (let m1 = 0; m1 <= p; m1++) {
        for (let m2 = 0; m1 + m2 <= p; m2++) {
          let acc = 0
          const rem = p - m1 - m2
          for (let d1 = 0; d1 <= rem; d1++) {
            const M1 = m1 + d1
            const cb1 = C[M1 * cN + m1] * px[d1]
            for (let d2 = 0; d1 + d2 <= rem; d2++) {
              const M2 = m2 + d2
              acc += cb1 * C[M2 * cN + m2] * py[d2] * L[pbase + midx(M1, M2)]
            }
          }
          L[cbase + midx(m1, m2)] += acc
        }
      }
    }
  }

  // --- L2P: evaluate each leaf's local expansion at its bodies. -------------
  // The local expansion is the far-field potential Φ_far(u) = Σ λ_{m} u^m about
  // the leaf centre; the far-field acceleration is its analytic gradient −∇Φ_far.
  for (let node = 0; node < nodeCount; node++) {
    if (!isLeaf(node)) continue
    const lbase = node * T
    const lo = start[node]
    const hi = lo + count[node]
    const ncx = cx[node]
    const ncy = cy[node]
    for (let k = lo; k < hi; k++) {
      const bi = order[k]
      const ux = posX[bi] - ncx
      const uy = posY[bi] - ncy
      px[0] = 1
      py[0] = 1
      for (let d = 1; d <= p; d++) {
        px[d] = px[d - 1] * ux
        py[d] = py[d - 1] * uy
      }
      let ax = 0
      let ay = 0
      for (let m1 = 0; m1 <= p; m1++) {
        for (let m2 = 0; m1 + m2 <= p; m2++) {
          const lam = L[lbase + midx(m1, m2)]
          if (m1 >= 1) ax += lam * m1 * px[m1 - 1] * py[m2]
          if (m2 >= 1) ay += lam * m2 * px[m1] * py[m2 - 1]
        }
      }
      // a = −∇Φ_far.
      outX[bi] += -ax
      outY[bi] += -ay
    }
  }

  return stats
}

/**
 * Direct O(N²) reference force — the exact softened Newtonian sum the FMM
 * approximates. Used by the self-tests and the FMM Lab to measure error.
 */
export function directAccel(
  n: number,
  posX: Float64Array,
  posY: Float64Array,
  mass: Float64Array,
  eps2: number,
  g: number,
  outX: Float64Array,
  outY: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    const xi = posX[i]
    const yi = posY[i]
    let ax = 0
    let ay = 0
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const dx = posX[j] - xi
      const dy = posY[j] - yi
      const inv = 1 / (dx * dx + dy * dy + eps2)
      const f = g * mass[j] * inv * Math.sqrt(inv)
      ax += f * dx
      ay += f * dy
    }
    outX[i] = ax
    outY[i] = ay
  }
}

/** Max and RMS of the relative force error |a_fmm − a_direct| / |a_direct|. */
export function forceError(
  n: number,
  axA: Float64Array,
  ayA: Float64Array,
  axB: Float64Array,
  ayB: Float64Array,
): { max: number; rms: number } {
  let max = 0
  let sum = 0
  let cnt = 0
  for (let i = 0; i < n; i++) {
    const dx = axA[i] - axB[i]
    const dy = ayA[i] - ayB[i]
    const ref = Math.hypot(axB[i], ayB[i])
    if (ref === 0) continue
    const rel = Math.hypot(dx, dy) / ref
    if (rel > max) max = rel
    sum += rel * rel
    cnt++
  }
  return { max, rms: cnt ? Math.sqrt(sum / cnt) : 0 }
}
