// Differential operators on the irregular Voronoi mesh — the numerical substrate the
// circulation model (and the Proof Lab) run on.
//
// The mesh is a blue-noise scatter of sites, so there is no regular grid to take finite
// differences on. Instead we fit a local linear model at every cell: given a scalar field
// f and a cell r with neighbours j, the gradient ∇f is the vector g that best explains the
// neighbour differences f_j − f_r in a least-squares sense,
//
//     minimise Σ_j ( f_j − f_r − g · (x_j − x_r) )²      ⇒     g = M⁻¹ b,
//
// with M = Σ_j d_j d_jᵀ  (a 2×2 matrix that depends only on geometry) and b = Σ_j (f_j −
// f_r) d_j, where d_j = x_j − x_r. Because M depends only on the mesh we invert it once and
// cache, per cell, the coefficient vectors  c_j = M⁻¹ d_j  — then ∇f[r] = Σ_j c_j (f_j −
// f_r) is a single sparse pass. Divergence and curl fall straight out of the same gradients.
//
// Everything here is pure and deterministic: the same mesh always yields the same operators.

import type { Mesh } from './types'

export interface Vec2Field {
  gx: Float64Array
  gy: Float64Array
}

/**
 * Precomputed least-squares differential operators for a mesh, restricted to a domain.
 * `inDomain` marks which cells participate (e.g. all solid cells, or just the ocean); a
 * neighbour outside the domain is skipped, so operators near a domain boundary use the
 * available one-sided stencil.
 */
export class MeshDiff {
  readonly n: number
  /** Per cell: the in-domain neighbour region indices. */
  readonly nbr: Int32Array[]
  /** Per cell, per neighbour: the x/y least-squares gradient coefficients c_j. */
  readonly cx: Float64Array[]
  readonly cy: Float64Array[]
  readonly inDomain: Uint8Array

  constructor(mesh: Mesh, inDomain: Uint8Array) {
    const n = mesh.numRegions
    this.n = n
    this.inDomain = inDomain
    this.nbr = new Array(n)
    this.cx = new Array(n)
    this.cy = new Array(n)

    for (let r = 0; r < n; r++) {
      if (!inDomain[r]) {
        this.nbr[r] = new Int32Array(0)
        this.cx[r] = new Float64Array(0)
        this.cy[r] = new Float64Array(0)
        continue
      }
      const raw = mesh.neighbors[r]
      const js: number[] = []
      for (const j of raw) if (inDomain[j]) js.push(j)
      const k = js.length
      const nbr = new Int32Array(js)
      const cx = new Float64Array(k)
      const cy = new Float64Array(k)

      // Assemble M = Σ d d^T (symmetric 2×2) from the neighbour offsets.
      let m00 = 0
      let m01 = 0
      let m11 = 0
      const dxs = new Float64Array(k)
      const dys = new Float64Array(k)
      for (let a = 0; a < k; a++) {
        const j = js[a]
        const dx = mesh.px[j] - mesh.px[r]
        const dy = mesh.py[j] - mesh.py[r]
        dxs[a] = dx
        dys[a] = dy
        m00 += dx * dx
        m01 += dx * dy
        m11 += dy * dy
      }
      // Invert M (with a tiny Tikhonov ridge so a degenerate/collinear stencil is safe).
      const eps = (m00 + m11) * 1e-9 + 1e-12
      const a00 = m00 + eps
      const a11 = m11 + eps
      const det = a00 * a11 - m01 * m01
      if (Math.abs(det) > 1e-18 && k >= 2) {
        const inv00 = a11 / det
        const inv01 = -m01 / det
        const inv11 = a00 / det
        for (let a = 0; a < k; a++) {
          // c_j = M⁻¹ d_j
          cx[a] = inv00 * dxs[a] + inv01 * dys[a]
          cy[a] = inv01 * dxs[a] + inv11 * dys[a]
        }
      }
      this.nbr[r] = nbr
      this.cx[r] = cx
      this.cy[r] = cy
    }
  }

  /** Least-squares gradient of a scalar field over the domain. */
  gradient(f: ArrayLike<number>): Vec2Field {
    const gx = new Float64Array(this.n)
    const gy = new Float64Array(this.n)
    for (let r = 0; r < this.n; r++) {
      if (!this.inDomain[r]) continue
      const nbr = this.nbr[r]
      const cxr = this.cx[r]
      const cyr = this.cy[r]
      const fr = f[r]
      let gxr = 0
      let gyr = 0
      for (let a = 0; a < nbr.length; a++) {
        const diff = f[nbr[a]] - fr
        gxr += cxr[a] * diff
        gyr += cyr[a] * diff
      }
      gx[r] = gxr
      gy[r] = gyr
    }
    return { gx, gy }
  }

  /** Divergence ∂u/∂x + ∂v/∂y of a vector field, cell by cell. */
  divergence(u: ArrayLike<number>, v: ArrayLike<number>): Float64Array {
    const div = new Float64Array(this.n)
    for (let r = 0; r < this.n; r++) {
      if (!this.inDomain[r]) continue
      const nbr = this.nbr[r]
      const cxr = this.cx[r]
      const cyr = this.cy[r]
      const ur = u[r]
      const vr = v[r]
      let d = 0
      for (let a = 0; a < nbr.length; a++) {
        const j = nbr[a]
        d += cxr[a] * (u[j] - ur) + cyr[a] * (v[j] - vr)
      }
      div[r] = d
    }
    return div
  }

  /** Vertical curl (∂v/∂x − ∂u/∂y) of a vector field, cell by cell. */
  curlZ(u: ArrayLike<number>, v: ArrayLike<number>): Float64Array {
    const curl = new Float64Array(this.n)
    for (let r = 0; r < this.n; r++) {
      if (!this.inDomain[r]) continue
      const nbr = this.nbr[r]
      const cxr = this.cx[r]
      const cyr = this.cy[r]
      const ur = u[r]
      const vr = v[r]
      let c = 0
      for (let a = 0; a < nbr.length; a++) {
        const j = nbr[a]
        // ∂v/∂x uses the x-coefficients on v; ∂u/∂y uses the y-coefficients on u.
        c += cxr[a] * (v[j] - vr) - cyr[a] * (u[j] - ur)
      }
      curl[r] = c
    }
    return curl
  }
}
