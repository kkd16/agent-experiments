// Photon-mapped caustics (Jensen 1996) — the one class of light transport the
// unidirectional path tracer structurally cannot reach. A pinhole eye ray landing on
// the lit floor under a glass sphere would have to randomly thread a direction back
// *through* the sphere onto the small sun, an event next-event estimation cannot
// sample and BSDF sampling finds with vanishing probability. So L(S⁺)D transport — the
// focused light of a caustic, the rainbow a prism paints on a wall — renders as black.
//
// This pass shoots photons *forward* from the lights, refracts/reflects them through the
// specular objects (glass, mirrors), deposits them on the first diffuse surface they
// reach (only once they have passed ≥1 specular event — direct light is the path
// tracer's job), and reconstructs the caustic by a k-nearest density estimate. It is
// wholly additive: a separate estimator, composited on top of the beauty pass, so the
// base tracer is untouched and there is nothing to double-count.
//
// Every claim here is re-derived independently in `photonmap_verify.ts`: the two gather
// kernels each integrate to 1, the spatial-hash grid ≡ a brute-force radius search, a
// beam on a ⟂ plane reconstructs its analytic irradiance, the specular gate deposits
// nothing without glass, a lens sphere concentrates flux, the estimate converges as √N,
// and a dispersive slab fans violet farther than red — the physics of a rainbow.
import type { Vec3 } from '../math/vec.ts'
import type { Light, DirLight, PointLight } from '../render/shading.ts'
import type { RTScene } from './rtscene.ts'
import type { BVH, ClosestHit } from './bvh.ts'
import { surfaceAt } from './tracer.ts'
import { fresnelDielectric, refract, reflect, smithG1 } from './dielectric.ts'
import { Rng, hashSeed, orthonormalBasis, sampleGGX, toWorld, uniformCone } from './sampling.ts'
import {
  rgbToSpectrum, sampleWavelength, sellmeierIor, cauchyIor, getGlass, spectrumAt,
  spectralRadianceToRGB,
} from './spectrum.ts'

const EPS = 1e-3
const PI = Math.PI

export type CausticKernel = 'constant' | 'cone'

export interface CausticOptions {
  photons: number // target photons to *emit* (deposited count is smaller — most miss the glass)
  radius: number // gather radius in world units
  kernel: CausticKernel
  spectral: boolean // wavelength-carrying photons → dispersed (rainbow) caustics
  maxBounces: number // specular-chain length guard per photon
  depositDirect: boolean // deposit L→D photons too (global-irradiance mode; used by the flux test)
  mirror: boolean // treat sharp metal as a specular reflector (reflective caustics)
  intensity: number // artistic multiplier on the deposited caustic radiance
}

export const DEFAULT_CAUSTIC_OPTIONS: CausticOptions = {
  photons: 200_000,
  radius: 0.16,
  kernel: 'cone',
  spectral: false,
  maxBounces: 12,
  depositDirect: false,
  mirror: false,
  intensity: 1,
}

export interface PhotonStats {
  emitted: number
  stored: number
  specularHits: number // photons that reached a diffuse surface after ≥1 specular bounce
  buildMs: number
  gridCells: number
}

// ── kernels ───────────────────────────────────────────────────────────────────────────
// Each K(d) is a normalised reconstruction kernel over the gather disc: ∫₀^r K(d)·2πd dd = 1,
// so a uniform photon density n_A (photons/area) each carrying flux Φ estimates the true
// irradiance E = n_A·Φ without bias. The constant (disc) kernel is exact for the flux test;
// the cone kernel weights nearer photons more, sharpening the caustic's core.
export function kernelWeight(kernel: CausticKernel, d: number, r: number): number {
  const inv = 1 / (PI * r * r)
  if (kernel === 'cone') {
    const t = 1 - d / r
    return t <= 0 ? 0 : t * 3 * inv // 3/(πr²)·(1−d/r); ∫ = 1
  }
  return inv // 1/(πr²); ∫ = 1
}

// ── the spatial-hash photon store ───────────────────────────────────────────────────────
// A uniform grid over deposited photon positions with cell size = the gather radius, so a
// query only ever inspects the 3×3×3 block of cells around it. Structure-of-arrays, built
// once by a counting sort; no per-query allocation. Verified ≡ a brute-force radius search.
export class PhotonGrid {
  private readonly cell: number
  private readonly invCell: number
  private minx = 0; private miny = 0; private minz = 0
  private nx = 1; private ny = 1; private nz = 1
  private cellStart = new Int32Array(1) // CSR row pointers, length cells+1
  private order = new Int32Array(0) // photon indices sorted by cell
  // photon data (parallel arrays)
  readonly px: Float64Array
  readonly py: Float64Array
  readonly pz: Float64Array
  readonly fr: Float64Array
  readonly fg: Float64Array
  readonly fb: Float64Array
  readonly nx3: Float64Array // deposit surface normal
  readonly ny3: Float64Array
  readonly nz3: Float64Array
  count = 0
  cells = 0

  constructor(capacity: number, cellSize: number) {
    this.cell = cellSize
    this.invCell = 1 / cellSize
    this.px = new Float64Array(capacity)
    this.py = new Float64Array(capacity)
    this.pz = new Float64Array(capacity)
    this.fr = new Float64Array(capacity)
    this.fg = new Float64Array(capacity)
    this.fb = new Float64Array(capacity)
    this.nx3 = new Float64Array(capacity)
    this.ny3 = new Float64Array(capacity)
    this.nz3 = new Float64Array(capacity)
  }

  add(x: number, y: number, z: number, r: number, g: number, b: number, nx: number, ny: number, nz: number): void {
    const i = this.count
    if (i >= this.px.length) return
    this.px[i] = x; this.py[i] = y; this.pz[i] = z
    this.fr[i] = r; this.fg[i] = g; this.fb[i] = b
    this.nx3[i] = nx; this.ny3[i] = ny; this.nz3[i] = nz
    this.count++
  }

  private cellIndex(x: number, y: number, z: number): number {
    let ix = ((x - this.minx) * this.invCell) | 0
    let iy = ((y - this.miny) * this.invCell) | 0
    let iz = ((z - this.minz) * this.invCell) | 0
    if (ix < 0) ix = 0; else if (ix >= this.nx) ix = this.nx - 1
    if (iy < 0) iy = 0; else if (iy >= this.ny) iy = this.ny - 1
    if (iz < 0) iz = 0; else if (iz >= this.nz) iz = this.nz - 1
    return (iz * this.ny + iy) * this.nx + ix
  }

  // Finalise: compute the bounds, size the grid, and counting-sort the photons into cells.
  finalize(): void {
    const n = this.count
    if (n === 0) { this.cellStart = new Int32Array(1); this.order = new Int32Array(0); this.cells = 0; return }
    let minx = Infinity, miny = Infinity, minz = Infinity
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    for (let i = 0; i < n; i++) {
      const x = this.px[i], y = this.py[i], z = this.pz[i]
      if (x < minx) minx = x; if (x > maxx) maxx = x
      if (y < miny) miny = y; if (y > maxy) maxy = y
      if (z < minz) minz = z; if (z > maxz) maxz = z
    }
    // pad by a cell so boundary photons always have a full neighbourhood
    this.minx = minx - this.cell; this.miny = miny - this.cell; this.minz = minz - this.cell
    this.nx = Math.max(1, Math.ceil((maxx - minx) * this.invCell) + 3)
    this.ny = Math.max(1, Math.ceil((maxy - miny) * this.invCell) + 3)
    this.nz = Math.max(1, Math.ceil((maxz - minz) * this.invCell) + 3)
    const cells = this.nx * this.ny * this.nz
    this.cells = cells
    const counts = new Int32Array(cells + 1)
    const cellOf = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(this.px[i], this.py[i], this.pz[i])
      cellOf[i] = c
      counts[c + 1]++
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c]
    const order = new Int32Array(n)
    const cursor = counts.slice(0, cells)
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]
      order[cursor[c]++] = i
    }
    this.cellStart = counts
    this.order = order
  }

  // Gather the deposited irradiance at (x,y,z) on a surface with unit normal (nrx,nry,nrz):
  // Σ Φᵢ·K(dᵢ) over photons within radius r whose deposit normal agrees with the receiver
  // (a gate that stops a caustic on the floor bleeding onto a wall that shares the cell).
  // Writes E (irradiance, rgb) into `out` and returns the photon count that contributed.
  gather(
    x: number, y: number, z: number,
    nrx: number, nry: number, nrz: number,
    r: number, kernel: CausticKernel, out: Float64Array,
  ): number {
    out[0] = 0; out[1] = 0; out[2] = 0
    if (this.count === 0) return 0
    const r2 = r * r
    let ix = ((x - this.minx) * this.invCell) | 0
    let iy = ((y - this.miny) * this.invCell) | 0
    let iz = ((z - this.minz) * this.invCell) | 0
    if (ix < 0) ix = 0; else if (ix >= this.nx) ix = this.nx - 1
    if (iy < 0) iy = 0; else if (iy >= this.ny) iy = this.ny - 1
    if (iz < 0) iz = 0; else if (iz >= this.nz) iz = this.nz - 1
    let er = 0, eg = 0, eb = 0, hits = 0
    const invCone = kernel === 'cone' ? 3 / (PI * r * r) : 1 / (PI * r * r)
    for (let dz = -1; dz <= 1; dz++) {
      const cz = iz + dz
      if (cz < 0 || cz >= this.nz) continue
      for (let dy = -1; dy <= 1; dy++) {
        const cy = iy + dy
        if (cy < 0 || cy >= this.ny) continue
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx
          if (cx < 0 || cx >= this.nx) continue
          const c = (cz * this.ny + cy) * this.nx + cx
          const s = this.cellStart[c], e = this.cellStart[c + 1]
          for (let k = s; k < e; k++) {
            const p = this.order[k]
            const ddx = this.px[p] - x, ddy = this.py[p] - y, ddz = this.pz[p] - z
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz
            if (d2 > r2) continue
            // reject photons deposited on a differently-oriented surface sharing the cell
            if (this.nx3[p] * nrx + this.ny3[p] * nry + this.nz3[p] * nrz < 0.7) continue
            const w = kernel === 'cone' ? Math.max(0, 1 - Math.sqrt(d2) / r) * invCone : invCone
            if (w <= 0) continue
            er += this.fr[p] * w; eg += this.fg[p] * w; eb += this.fb[p] * w
            hits++
          }
        }
      }
    }
    out[0] = er; out[1] = eg; out[2] = eb
    return hits
  }
}

// A specular surface a photon bends through: glass, or (optionally) a sharp metal mirror.
function isGlass(scene: RTScene, tri: number): boolean {
  return scene.materials[scene.matIndex[tri]].transmission > 0
}
function isMirror(scene: RTScene, tri: number): boolean {
  const m = scene.materials[scene.matIndex[tri]]
  return m.transmission === 0 && m.metallic > 0.9 && m.roughness < 0.08
}

// The world-space AABB of the specular geometry (glass, and mirrors when enabled). The
// emitter aims its photons at this box, so almost every photon has a chance to become a
// caustic rather than being wasted on the open floor. Returns null when there is none.
function specularBounds(scene: RTScene, mirror: boolean): { cx: number; cy: number; cz: number; ex: number; ey: number; ez: number; radius: number } | null {
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  let any = false
  for (let t = 0; t < scene.count; t++) {
    if (!isGlass(scene, t) && !(mirror && isMirror(scene, t))) continue
    any = true
    const o = t * 3
    if (scene.triMin[o] < minx) minx = scene.triMin[o]
    if (scene.triMin[o + 1] < miny) miny = scene.triMin[o + 1]
    if (scene.triMin[o + 2] < minz) minz = scene.triMin[o + 2]
    if (scene.triMax[o] > maxx) maxx = scene.triMax[o]
    if (scene.triMax[o + 1] > maxy) maxy = scene.triMax[o + 1]
    if (scene.triMax[o + 2] > maxz) maxz = scene.triMax[o + 2]
  }
  if (!any) return null
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2
  const ex = (maxx - minx) / 2, ey = (maxy - miny) / 2, ez = (maxz - minz) / 2
  return { cx, cy, cz, ex, ey, ez, radius: Math.hypot(ex, ey, ez) }
}

// The whole scene's AABB — the target for `depositDirect` (global-irradiance) emission,
// used by the flux self-test where there is no specular object to aim at.
function sceneBounds(scene: RTScene): { cx: number; cy: number; cz: number; radius: number } | null {
  if (scene.count === 0) return null
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let t = 0; t < scene.count; t++) {
    const o = t * 3
    if (scene.triMin[o] < minx) minx = scene.triMin[o]
    if (scene.triMin[o + 1] < miny) miny = scene.triMin[o + 1]
    if (scene.triMin[o + 2] < minz) minz = scene.triMin[o + 2]
    if (scene.triMax[o] > maxx) maxx = scene.triMax[o]
    if (scene.triMax[o + 1] > maxy) maxy = scene.triMax[o + 1]
    if (scene.triMax[o + 2] > maxz) maxz = scene.triMax[o + 2]
  }
  return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, cz: (minz + maxz) / 2, radius: Math.hypot(maxx - minx, maxy - miny, maxz - minz) / 2 }
}

// The IOR a photon of wavelength λ sees at a dielectric — the named-glass Sellmeier curve,
// else the material's achromatic Cauchy fan around its base index, else the flat base index.
export function photonIor(mat: RTScene['materials'][number], lambda: number, spectral: boolean): number {
  if (!spectral) return mat.ior
  if (mat.glass) { const g = getGlass(mat.glass); if (g) return sellmeierIor(g, lambda) }
  if (mat.dispersion > 0) return cauchyIor(mat.ior, mat.dispersion, lambda)
  return mat.ior
}

const tmpHit: ClosestHit = { t: 0, tri: -1, u: 0, v: 0 }
const tmpDir = new Float64Array(3)

// The photon-map builder + caustic estimator. Build once per (geometry, lights, options)
// change; then `estimate` is called per visible surface point to gather the caustic.
export class PhotonMap {
  private grid: PhotonGrid | null = null
  private opts: CausticOptions = DEFAULT_CAUSTIC_OPTIONS
  stats: PhotonStats = { emitted: 0, stored: 0, specularHits: 0, buildMs: 0, gridCells: 0 }

  // Trace one photon forward from (o, d) carrying flux (fr,fg,fb) at wavelength λ, depositing
  // it on the first diffuse surface reached after ≥1 specular event (or immediately, in
  // depositDirect mode). Pure specular chains (glass→glass→…) continue up to maxBounces.
  private tracePhoton(
    scene: RTScene, bvh: BVH,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    fr: number, fg: number, fb: number,
    lambda: number, rng: Rng, grid: PhotonGrid,
  ): void {
    const opts = this.opts
    let hasSpecular = false
    let absR = 0, absG = 0, absB = 0 // Beer–Lambert of the body we are inside
    for (let bounce = 0; bounce < opts.maxBounces; bounce++) {
      const hit = bvh.closest(ox, oy, oz, dx, dy, dz, 1e-4, 1e30, tmpHit)
      if (!hit) return
      const t = tmpHit.t
      if (absR > 0 || absG > 0 || absB > 0) {
        fr *= Math.exp(-absR * t); fg *= Math.exp(-absG * t); fb *= Math.exp(-absB * t)
      }
      const tri = tmpHit.tri
      const glass = isGlass(scene, tri)
      const mirror = opts.mirror && isMirror(scene, tri)
      if (!glass && !mirror) {
        // diffuse receiver — deposit only genuine caustic (post-specular) photons
        if (hasSpecular || opts.depositDirect) {
          const s = surfaceAt(scene, tri, tmpHit.u, tmpHit.v, dx, dy, dz)
          grid.add(s.px, s.py, s.pz, fr, fg, fb, s.gx, s.gy, s.gz)
          this.stats.specularHits++
        }
        return
      }
      const s = surfaceAt(scene, tri, tmpHit.u, tmpHit.v, dx, dy, dz)
      // incident propagation dir is (dx,dy,dz); the surface normal s.n faces against it
      let nx = s.nx, ny = s.ny, nz = s.nz
      const vx = -dx, vy = -dy, vz = -dz
      if (mirror) {
        reflect(dx, dy, dz, nx, ny, nz, tmpDir)
        const m = s.mat
        fr *= m.albedo[0]; fg *= m.albedo[1]; fb *= m.albedo[2] // metal reflectance ≈ albedo (F0)
      } else {
        // rough glass perturbs the normal by a GGX microfacet (mirrors sampleDielectric)
        const rough = s.mat.roughness
        const smooth = rough <= 0.04
        if (!smooth) {
          const a = rough * rough
          const [t1, t2] = orthonormalBasis([nx, ny, nz])
          const mm = sampleGGX(rng.next(), rng.next(), a)
          const mw = toWorld(mm, t1, t2, [nx, ny, nz])
          nx = mw[0]; ny = mw[1]; nz = mw[2]
          if (vx * nx + vy * ny + vz * nz < 0) { nx = -nx; ny = -ny; nz = -nz }
        }
        const ior = photonIor(s.mat, lambda, opts.spectral)
        const etaI = s.frontFace ? 1.0 : ior
        const etaT = s.frontFace ? ior : 1.0
        const cosI = -(dx * nx + dy * ny + dz * nz)
        const F = fresnelDielectric(cosI, etaI, etaT)
        if (rng.next() < F) {
          reflect(dx, dy, dz, nx, ny, nz, tmpDir) // selecting the lobe by F keeps flux (R+T=1)
        } else if (refract(dx, dy, dz, nx, ny, nz, etaI / etaT, tmpDir)) {
          // entering a body turns on its absorption; exiting clears it
          if (s.frontFace) { absR = s.mat.attenuation[0]; absG = s.mat.attenuation[1]; absB = s.mat.attenuation[2] }
          else { absR = 0; absG = 0; absB = 0 }
        } else {
          reflect(dx, dy, dz, nx, ny, nz, tmpDir) // total internal reflection
        }
        if (!smooth) {
          const g1 = smithG1(nx * tmpDir[0] + ny * tmpDir[1] + nz * tmpDir[2], rough * rough)
          fr *= g1; fg *= g1; fb *= g1
        }
      }
      hasSpecular = true
      const wx = tmpDir[0], wy = tmpDir[1], wz = tmpDir[2]
      const side = (s.gx * wx + s.gy * wy + s.gz * wz) >= 0 ? 1 : -1
      ox = s.px + s.gx * EPS * side
      oy = s.py + s.gy * EPS * side
      oz = s.pz + s.gz * EPS * side
      dx = wx; dy = wy; dz = wz
      // Russian roulette on a long chain so absorbing glass can't spin forever
      if (bounce >= 3) {
        let q = Math.max(fr, fg, fb)
        if (q > 0.95) q = 0.95; if (q < 0.05) q = 0.05
        if (rng.next() >= q) return
        fr /= q; fg /= q; fb /= q
      }
    }
  }

  // Emit `n` photons from one directional (sun) light as a parallel beam over the
  // cross-section that bounds the target, so Φ = colour·intensity·A/n (A = beam area ⟂ to
  // the sun). `spectralScale` folds the emitter colour into a Smits spectrum in spectral mode.
  private emitDirectional(
    scene: RTScene, bvh: BVH, light: DirLight, n: number,
    target: { cx: number; cy: number; cz: number; radius: number },
    grid: PhotonGrid, seed: number,
  ): void {
    let lx = light.direction[0], ly = light.direction[1], lz = light.direction[2]
    const ll = Math.hypot(lx, ly, lz) || 1
    lx /= ll; ly /= ll; lz /= ll
    const b = orthonormalBasis([lx, ly, lz])
    const u = b[0], v = b[1]
    const half = target.radius * 1.02
    const A = (2 * half) * (2 * half) // beam cross-section area
    const startBack = target.radius + 1
    const spectral = this.opts.spectral
    const colSpectrum = spectral ? rgbToSpectrum(light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity) : null
    // RGB flux per photon (the beam's irradiance E⊥ = colour·intensity, over area A, ÷ n)
    const eR = light.color[0] * light.intensity * A / n
    const eG = light.color[1] * light.intensity * A / n
    const eB = light.color[2] * light.intensity * A / n
    const tmp = new Float64Array(3)
    for (let i = 0; i < n; i++) {
      const rng = new Rng(hashSeed(i, seed, 0x1a2b))
      const a = (rng.next() * 2 - 1) * half
      const c = (rng.next() * 2 - 1) * half
      const ox = target.cx + u[0] * a + v[0] * c - lx * startBack
      const oy = target.cy + u[1] * a + v[1] * c - ly * startBack
      const oz = target.cz + u[2] * a + v[2] * c - lz * startBack
      if (spectral && colSpectrum) {
        const ws = sampleWavelength(rng.next())
        // photon carries a scalar spectral flux weight; deposit converts to RGB via the CMF
        const weight = spectrumAt(colSpectrum, ws.lambda) * A / n
        spectralRadianceToRGB(weight, ws.lambda, ws.pdf, tmp)
        this.tracePhoton(scene, bvh, ox, oy, oz, lx, ly, lz, tmp[0], tmp[1], tmp[2], ws.lambda, rng, grid)
      } else {
        this.tracePhoton(scene, bvh, ox, oy, oz, lx, ly, lz, eR, eG, eB, 0, rng, grid)
      }
    }
  }

  // Emit `n` photons from one point light into the cone that subtends the target AABB, so
  // Φ = radiant-intensity·Ω/n. (The caustic pass models a point light as a physical
  // inverse-square source — colour·intensity is its radiant intensity — which is what makes
  // the density estimate reconstruct a true irradiance.)
  private emitPoint(
    scene: RTScene, bvh: BVH, light: PointLight, n: number,
    target: { cx: number; cy: number; cz: number; radius: number },
    grid: PhotonGrid, seed: number,
  ): void {
    const px = light.position[0], py = light.position[1], pz = light.position[2]
    let ax = target.cx - px, ay = target.cy - py, az = target.cz - pz
    const dist = Math.hypot(ax, ay, az) || 1
    ax /= dist; ay /= dist; az /= dist
    let sinMax = target.radius / dist
    if (sinMax > 0.999) sinMax = 0.999
    const cosMax = Math.sqrt(1 - sinMax * sinMax)
    const omega = 2 * PI * (1 - cosMax) // solid angle of the cone
    const axis: Vec3 = [ax, ay, az]
    const bb = orthonormalBasis(axis)
    const t1 = bb[0], t2 = bb[1]
    const spectral = this.opts.spectral
    const colSpectrum = spectral ? rgbToSpectrum(light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity) : null
    const iR = light.color[0] * light.intensity * omega / n
    const iG = light.color[1] * light.intensity * omega / n
    const iB = light.color[2] * light.intensity * omega / n
    const tmp = new Float64Array(3)
    for (let i = 0; i < n; i++) {
      const rng = new Rng(hashSeed(i, seed, 0x3c4d))
      const local = uniformCone(rng.next(), rng.next(), cosMax)
      const w = toWorld(local, t1, t2, axis)
      if (spectral && colSpectrum) {
        const ws = sampleWavelength(rng.next())
        const weight = spectrumAt(colSpectrum, ws.lambda) * omega / n
        spectralRadianceToRGB(weight, ws.lambda, ws.pdf, tmp)
        this.tracePhoton(scene, bvh, px, py, pz, w[0], w[1], w[2], tmp[0], tmp[1], tmp[2], ws.lambda, rng, grid)
      } else {
        this.tracePhoton(scene, bvh, px, py, pz, w[0], w[1], w[2], iR, iG, iB, 0, rng, grid)
      }
    }
  }

  // Build the photon map for the scene + lights under the given options. Emits the photon
  // budget split by luminance across the caustic-casting lights, aiming each at the specular
  // geometry (or the whole scene, in depositDirect mode).
  build(scene: RTScene, bvh: BVH, lights: Light[], opts: CausticOptions): void {
    const t0 = performance.now()
    this.opts = opts
    this.stats = { emitted: 0, stored: 0, specularHits: 0, buildMs: 0, gridCells: 0 }
    const target = opts.depositDirect ? sceneBounds(scene) : specularBounds(scene, opts.mirror)
    if (!target || lights.length === 0 || scene.count === 0) {
      this.grid = null
      this.stats.buildMs = performance.now() - t0
      return
    }
    // budget the photons across lights by luminance
    const lum = (l: Light): number => 0.2126 * l.color[0] + 0.7152 * l.color[1] + 0.0722 * l.color[2]
    let total = 0
    for (const l of lights) total += Math.max(1e-4, lum(l) * l.intensity)
    const grid = new PhotonGrid(opts.photons + 16, opts.radius)
    let seed = 1
    for (const l of lights) {
      const share = Math.max(1, Math.round(opts.photons * (Math.max(1e-4, lum(l) * l.intensity) / total)))
      if (l.type === 'dir') this.emitDirectional(scene, bvh, l, share, target, grid, seed)
      else this.emitPoint(scene, bvh, l, share, target, grid, seed)
      this.stats.emitted += share
      seed += 101
    }
    grid.finalize()
    this.grid = grid
    this.stats.stored = grid.count
    this.stats.gridCells = grid.cells
    this.stats.buildMs = performance.now() - t0
  }

  hasPhotons(): boolean { return this.grid !== null && this.grid.count > 0 }

  // The deposited photon store (for the self-test's hue-spread + debug splat), or null.
  photons(): PhotonGrid | null { return this.grid }

  // Outgoing caustic radiance at a visible diffuse point: L = (albedo/π)·E, where E is the
  // gathered irradiance. Writes rgb into `out`. `nrx..` is the receiver shading normal.
  estimate(
    px: number, py: number, pz: number,
    nrx: number, nry: number, nrz: number,
    ar: number, ag: number, ab: number,
    out: Float64Array,
  ): void {
    out[0] = 0; out[1] = 0; out[2] = 0
    const grid = this.grid
    if (!grid) return
    const hits = grid.gather(px, py, pz, nrx, nry, nrz, this.opts.radius, this.opts.kernel, out)
    if (hits === 0) return
    const k = this.opts.intensity / PI
    out[0] *= ar * k; out[1] *= ag * k; out[2] *= ab * k
  }
}
