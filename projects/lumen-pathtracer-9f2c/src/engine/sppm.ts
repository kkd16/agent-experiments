// sppm.ts — Stochastic Progressive Photon Mapping, Lumen's fourth light-transport
// integrator (alongside the unidirectional path tracer, BDPT, and PSSMLT).
//
// The path tracer, BDPT and PSSMLT all build paths that *end on a light*. That is
// exactly the wrong shape for a **caustic**: light focused through a lens or a
// glass sphere onto a diffuse surface (a "specular→diffuse", or SDS, path seen
// from the camera). Next-event estimation cannot help — the connecting segment
// from the diffuse catch-point to the light must pass *through* the glass, and a
// straight shadow ray does not refract, so the light has measure zero under NEE.
// Pure BSDF sampling can find such a path only by blind luck (a diffuse bounce
// that happens to thread the lens), so caustics are the textbook high-variance,
// slow-to-converge case for the other three integrators.
//
// Photon mapping turns the problem around. It shoots **photons from the lights**,
// lets them refract/reflect through the specular geometry, and records where they
// land on diffuse surfaces — so the rare SDS transport is found by *construction*,
// from the light's side, not hoped for from the camera's. **Progressive** photon
// mapping (Hachisuka et al. 2008) then runs many photon passes and, crucially,
// *shrinks each measurement point's gather radius* between passes on the schedule
//
//     N_{i+1} = N_i + α·M_i,   R²_{i+1} = R²_i · (N_i + α·M_i)/(N_i + M_i),
//     τ_{i+1} = (τ_i + Σ f·ΔΦ) · R²_{i+1}/R²_i,
//
// which provably drives the density-estimation bias to zero while keeping the
// variance bounded — so the estimate *converges*, like the other three, to the
// true solution of the rendering equation. **Stochastic** PPM (Hachisuka &
// Jensen 2009) re-traces jittered camera rays every pass, so the measurement
// points themselves are a Monte-Carlo process: this anti-aliases, captures
// depth-of-field and glossy visible points, and lets a single per-pixel radius
// statistic stand in for the whole pixel footprint.
//
// Lumen reuses the existing engine verbatim: `Scene.intersect`, the `Material`
// BSDFs (`sampleBSDF`/`evalBSDF`/`isDelta`) and the `Camera` are shared with the
// path tracer, so a photon walk and a camera walk are the same code with the
// roles of "emitter" and "sensor" swapped. Photons are emitted from the scene's
// emissive triangles, sampled in proportion to their power so every photon
// carries equal flux. Like PSSMLT, each render worker runs an *independent*
// full-frame SPPM and the UI thread averages their estimates.
//
// References: Hachisuka, Ogaki & Jensen, "Progressive Photon Mapping" (SIGGRAPH
// Asia 2008); Hachisuka & Jensen, "Stochastic Progressive Photon Mapping"
// (SIGGRAPH Asia 2009); Jensen, "Realistic Image Synthesis Using Photon Mapping".

import type { Vec3 } from './vec3'
import { add, dot, isBlack, luminance, madd, maxComponent, mul, neg, onb, scale, toWorld, v } from './vec3'
import { makeRay } from './ray'
import type { Ray } from './ray'
import { Rng, triangleBary } from './rng'
import type { Scene } from './scene'
import type { Camera } from './camera'
import type { Material } from './material'
import { bumpedNormal, evalBSDF, isDelta, isSpectral, resolveMaterial, sampleBSDF } from './material'
import { LAMBDA_MAX, LAMBDA_MIN, wavelengthWeight } from './spectrum'
import type { Triangle } from './primitive'
import type { RayStats } from './integrator'
import type { IntegratorSettings } from './types'

const EPS = 1e-4
const INV_PI = 1 / Math.PI

// Offset a ray origin off a surface along its geometric normal to defeat
// self-intersection (shared convention with the path tracer).
function offsetOrigin(p: Vec3, ng: Vec3, dir: Vec3): Vec3 {
  return madd(p, ng, dot(ng, dir) > 0 ? EPS : -EPS)
}

export interface SppmOptions {
  // Photons emitted per worker per pass. More photons ⇒ a denser map ⇒ less
  // variance per pass (at higher cost). Equal flux is carried by every photon.
  photonsPerPass: number
  // The radius-reduction exponent α ∈ (0,1) (Hachisuka's 2/3-ish). Smaller α
  // shrinks the radius faster (less bias, more variance); larger keeps it wide.
  alpha: number
  // Initial gather radius as a fraction of the scene's bounding-box diagonal.
  initialRadiusFrac: number
  // Spectral photons: when a photon first strikes a dispersive (wavelength-
  // dependent) surface it commits a random "hero" wavelength and carries that
  // wavelength's RGB weight, so its later refraction bends per-colour and the
  // caustic it deposits is *coloured* — a rainbow caustic — instead of white.
  // Because E_λ[weight] = (1,1,1) the total caustic energy is unchanged; only
  // its colour is spread spatially. Default on (no extra cost). (Optional so
  // older call sites that omit it default to enabled.)
  spectralPhotons?: boolean
  // Environment photons: when the scene's environment carries a sun (a daylight
  // gradient sun or a Preetham sky), emit photons from it too — from a disc
  // perpendicular to the sun direction, sized to the scene's bounding sphere —
  // so daylight scenes get photon-mapped sun caustics and indirect light, not
  // just the area-light scenes. Default on.
  envPhotons?: boolean
}

export const DEFAULT_SPPM: SppmOptions = {
  photonsPerPass: 120000,
  alpha: 0.7,
  initialRadiusFrac: 0.012,
  spectralPhotons: true,
  envPhotons: true,
}

// ---------------------------------------------------------------------------
// A spatial hash over the per-pixel measurement points, rebuilt each pass. Each
// point is inserted into every grid cell its gather sphere [x−r, x+r] overlaps,
// so a photon need only look up the single cell holding its position to find
// *every* measurement point whose radius could reach it. Stored CSR-style in two
// typed arrays so a pass allocates nothing in the hot deposit loop. Hash
// collisions merely add a few extra distance tests, never miss a point.
// ---------------------------------------------------------------------------
export class HashGrid {
  private cellStart: Int32Array = new Int32Array(1)
  private entries: Int32Array = new Int32Array(1)
  private tableMask = 0
  private invCell = 1
  private ox = 0
  private oy = 0
  private oz = 0

  private static hash(ix: number, iy: number, iz: number, mask: number): number {
    // Teschner et al. spatial hash; XOR of large primes, masked to the table.
    return ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask
  }

  // (Re)build the grid from the alive measurement points. `count` is the number
  // of pixels; `alive[i]` says whether pixel i contributed a point this pass.
  build(
    count: number,
    alive: Uint8Array,
    px: Float64Array,
    py: Float64Array,
    pz: Float64Array,
    r2: Float64Array,
  ): void {
    // Scene-wide bounds of the points and the largest gather radius set the grid
    // resolution: a cell edge equal to the max radius keeps every point's box to
    // at most two cells per axis.
    let minx = Infinity
    let miny = Infinity
    let minz = Infinity
    let maxx = -Infinity
    let maxy = -Infinity
    let maxz = -Infinity
    let maxR = 0
    let nAlive = 0
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue
      nAlive++
      if (px[i] < minx) minx = px[i]
      if (py[i] < miny) miny = py[i]
      if (pz[i] < minz) minz = pz[i]
      if (px[i] > maxx) maxx = px[i]
      if (py[i] > maxy) maxy = py[i]
      if (pz[i] > maxz) maxz = pz[i]
      const r = Math.sqrt(r2[i])
      if (r > maxR) maxR = r
    }
    if (nAlive === 0 || maxR <= 0) {
      this.cellStart = new Int32Array(2)
      this.entries = new Int32Array(0)
      this.tableMask = 0
      return
    }
    const cell = maxR
    this.invCell = 1 / cell
    this.ox = minx - cell
    this.oy = miny - cell
    this.oz = minz - cell

    // Power-of-two table sized to the live point count (load factor ~1).
    let tableSize = 1
    while (tableSize < nAlive) tableSize <<= 1
    tableSize <<= 1
    const mask = tableSize - 1
    this.tableMask = mask

    // CSR pass 1: count (point, cell) incidences per bucket.
    const counts = new Int32Array(tableSize + 1)
    const cellOf = (val: number, origin: number): number => Math.floor((val - origin) * this.invCell)
    let totalPairs = 0
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue
      const r = Math.sqrt(r2[i])
      const ix0 = cellOf(px[i] - r, this.ox)
      const ix1 = cellOf(px[i] + r, this.ox)
      const iy0 = cellOf(py[i] - r, this.oy)
      const iy1 = cellOf(py[i] + r, this.oy)
      const iz0 = cellOf(pz[i] - r, this.oz)
      const iz1 = cellOf(pz[i] + r, this.oz)
      for (let ix = ix0; ix <= ix1; ix++)
        for (let iy = iy0; iy <= iy1; iy++)
          for (let iz = iz0; iz <= iz1; iz++) {
            counts[HashGrid.hash(ix, iy, iz, mask)]++
            totalPairs++
          }
    }
    // Prefix sum → bucket start offsets.
    const cellStart = new Int32Array(tableSize + 1)
    let acc = 0
    for (let h = 0; h < tableSize; h++) {
      cellStart[h] = acc
      acc += counts[h]
    }
    cellStart[tableSize] = acc
    // CSR pass 2: scatter point indices into their buckets.
    const entries = new Int32Array(totalPairs)
    const cursor = cellStart.slice(0, tableSize)
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue
      const r = Math.sqrt(r2[i])
      const ix0 = cellOf(px[i] - r, this.ox)
      const ix1 = cellOf(px[i] + r, this.ox)
      const iy0 = cellOf(py[i] - r, this.oy)
      const iy1 = cellOf(py[i] + r, this.oy)
      const iz0 = cellOf(pz[i] - r, this.oz)
      const iz1 = cellOf(pz[i] + r, this.oz)
      for (let ix = ix0; ix <= ix1; ix++)
        for (let iy = iy0; iy <= iy1; iy++)
          for (let iz = iz0; iz <= iz1; iz++) {
            const h = HashGrid.hash(ix, iy, iz, mask)
            entries[cursor[h]++] = i
          }
    }
    this.cellStart = cellStart
    this.entries = entries
  }

  // Invoke `fn(pointIndex)` for every measurement point in the cell holding (x,y,z).
  forEachNear(x: number, y: number, z: number, fn: (i: number) => void): void {
    if (this.entries.length === 0) return
    const ix = Math.floor((x - this.ox) * this.invCell)
    const iy = Math.floor((y - this.oy) * this.invCell)
    const iz = Math.floor((z - this.oz) * this.invCell)
    const h = HashGrid.hash(ix, iy, iz, this.tableMask)
    const start = this.cellStart[h]
    const end = this.cellStart[h + 1]
    for (let k = start; k < end; k++) fn(this.entries[k])
  }
}

// One emissive triangle prepared as a photon source, with its emitted power.
interface PhotonLight {
  tri: Triangle
  emission: Vec3
  power: number // scalar luminous power lum(Le)·A, the selection weight
}

// The environment sun prepared as a photon source. Photons leave a disc of
// radius `radius` (the scene's bounding-sphere radius) perpendicular to the sun
// direction and travel into the scene as a parallel beam (the sun is at
// infinity), with a small cone jitter of half-angle acos(cosSize). The selection
// `weight` is the sun's luminous power lum(L)·π·R²·Ω, and `repLum` (= lum of the
// representative radiance) divides it back out when a photon's flux is set, so
// the photon flux is L·ΣW/repLum — exactly parallel to the triangle Le·π·ΣW/lum.
interface SunSource {
  dir: Vec3 // unit direction from the scene toward the sun
  cosSize: number
  solidAngle: number // Ω = 2π(1−cosSize)
  center: Vec3 // scene bounding-sphere centre
  radius: number // scene bounding-sphere radius
  repLum: number // luminance of the representative (cone-centre) sun radiance
  weight: number // selection weight in the photon-source pool
}

// ---------------------------------------------------------------------------
// A running SPPM renderer. Mirrors `MltState`'s shape so the worker and the
// single-thread fallback drive it the same way they drive PSSMLT: `step(n)`
// advances by n full passes, `image()` reads back the current HDR estimate, and
// `mutationsPerPixel` reports progress (here: passes completed) so the existing
// progress/averaging plumbing is reused unchanged.
// ---------------------------------------------------------------------------
export class SppmState {
  readonly W: number
  readonly H: number
  readonly stats: RayStats = { rays: 0 }
  private readonly nPixels: number
  private readonly scene: Scene
  private readonly camera: Camera
  private readonly settings: IntegratorSettings
  private readonly opts: SppmOptions
  private readonly rng: Rng

  // Per-pixel measurement-point statistics, persistent across passes.
  private readonly r2: Float64Array // current squared gather radius
  private readonly nPhotons: Float64Array // accumulated (α-weighted) photon count N
  private readonly tauR: Float64Array // accumulated, radius-rescaled flux τ
  private readonly tauG: Float64Array
  private readonly tauB: Float64Array
  private readonly emitR: Float64Array // emitted radiance seen directly on the camera path
  private readonly emitG: Float64Array
  private readonly emitB: Float64Array

  // This-pass measurement points (overwritten every pass).
  private readonly alive: Uint8Array
  private readonly hpX: Float64Array
  private readonly hpY: Float64Array
  private readonly hpZ: Float64Array
  private readonly nX: Float64Array
  private readonly nY: Float64Array
  private readonly nZ: Float64Array
  private readonly woX: Float64Array
  private readonly woY: Float64Array
  private readonly woZ: Float64Array
  private readonly betaR: Float64Array // camera-path throughput to the visible point
  private readonly betaG: Float64Array
  private readonly betaB: Float64Array
  private readonly hpMat: (Material | null)[] // resolved BSDF at the visible point
  // This-pass gathered flux Σ f·ΔΦ (before the camera throughput is folded in).
  private readonly flR: Float64Array
  private readonly flG: Float64Array
  private readonly flB: Float64Array
  private readonly flM: Int32Array // photons gathered this pass

  private readonly grid = new HashGrid()
  private readonly lights: PhotonLight[]
  private readonly lightCdf: Float64Array
  private readonly triPower: number // Σ lum(Le)·A over the emissive triangles
  private readonly sun: SunSource | null // the environment sun, if it emits photons
  private readonly totalPower: number // triPower + (sun ? sun.weight : 0)
  private readonly spectral: boolean // commit a hero wavelength on dispersive hits
  private passes = 0
  private emittedTotal = 0 // photons emitted across all passes

  constructor(
    scene: Scene,
    camera: Camera,
    settings: IntegratorSettings,
    W: number,
    H: number,
    seed: number,
    opts: SppmOptions = DEFAULT_SPPM,
  ) {
    this.scene = scene
    this.camera = camera
    this.settings = settings
    this.W = W
    this.H = H
    this.nPixels = W * H
    this.opts = opts
    this.rng = new Rng(seed >>> 0, 1)

    const n = this.nPixels
    this.r2 = new Float64Array(n)
    this.nPhotons = new Float64Array(n)
    this.tauR = new Float64Array(n)
    this.tauG = new Float64Array(n)
    this.tauB = new Float64Array(n)
    this.emitR = new Float64Array(n)
    this.emitG = new Float64Array(n)
    this.emitB = new Float64Array(n)
    this.alive = new Uint8Array(n)
    this.hpX = new Float64Array(n)
    this.hpY = new Float64Array(n)
    this.hpZ = new Float64Array(n)
    this.nX = new Float64Array(n)
    this.nY = new Float64Array(n)
    this.nZ = new Float64Array(n)
    this.woX = new Float64Array(n)
    this.woY = new Float64Array(n)
    this.woZ = new Float64Array(n)
    this.betaR = new Float64Array(n)
    this.betaG = new Float64Array(n)
    this.betaB = new Float64Array(n)
    this.hpMat = new Array<Material | null>(n).fill(null)
    this.flR = new Float64Array(n)
    this.flG = new Float64Array(n)
    this.flB = new Float64Array(n)
    this.flM = new Int32Array(n)

    this.spectral = opts.spectralPhotons ?? true

    // Scene bounds (centre + bounding-sphere radius), shared by the initial
    // gather radius and the environment-sun photon disc.
    const bounds = this.sceneBounds()

    // Initial gather radius from the scene's extent.
    const r0 = bounds.diagonal * opts.initialRadiusFrac
    this.r2.fill(r0 * r0)

    // Index the emissive triangles as photon sources, with a power CDF for
    // power-proportional emitter selection (so every photon carries equal flux).
    this.lights = []
    for (const li of scene.lights) {
      const tri = scene.prims[li] as Triangle
      const mat = scene.materials[tri.material]
      const emission = mat.kind === 'emissive' ? mat.emission : v(0, 0, 0)
      const power = luminance(emission) * tri.area
      if (power > 0) this.lights.push({ tri, emission, power })
    }
    this.lightCdf = new Float64Array(this.lights.length + 1)
    for (let i = 0; i < this.lights.length; i++) this.lightCdf[i + 1] = this.lightCdf[i] + this.lights[i].power
    this.triPower = this.lightCdf[this.lights.length]

    // Add the environment sun to the photon-source pool, if it emits.
    this.sun = (opts.envPhotons ?? true) ? buildSunSource(scene, bounds.center, bounds.radius) : null
    this.totalPower = this.triPower + (this.sun ? this.sun.weight : 0)
  }

  // True when there is at least one photon source (a triangle light or the sun).
  private get hasPhotonSources(): boolean {
    return this.lights.length > 0 || this.sun !== null
  }

  get passCount(): number {
    return this.passes
  }
  // Reported as "mutations per pixel" so the renderer's progress + averaging
  // plumbing (shared with PSSMLT) treats one SPPM pass as one sample of progress.
  get mutationsPerPixel(): number {
    return this.passes
  }
  get brightness(): number {
    return 0
  }

  // The scene's axis-aligned bounds as a centre, a bounding-sphere radius (half
  // the box diagonal), and that diagonal — used for the gather radius and the
  // environment-sun photon disc.
  private sceneBounds(): { center: Vec3; radius: number; diagonal: number } {
    let minx = Infinity
    let miny = Infinity
    let minz = Infinity
    let maxx = -Infinity
    let maxy = -Infinity
    let maxz = -Infinity
    for (const p of this.scene.prims) {
      if (p.kind === 'sphere') {
        const r = Math.abs(p.radius)
        minx = Math.min(minx, p.center.x - r)
        miny = Math.min(miny, p.center.y - r)
        minz = Math.min(minz, p.center.z - r)
        maxx = Math.max(maxx, p.center.x + r)
        maxy = Math.max(maxy, p.center.y + r)
        maxz = Math.max(maxz, p.center.z + r)
      } else {
        const verts = [p.p0, madd(p.p0, p.e1, 1), madd(p.p0, p.e2, 1)]
        for (const q of verts) {
          minx = Math.min(minx, q.x)
          miny = Math.min(miny, q.y)
          minz = Math.min(minz, q.z)
          maxx = Math.max(maxx, q.x)
          maxy = Math.max(maxy, q.y)
          maxz = Math.max(maxz, q.z)
        }
      }
    }
    if (!Number.isFinite(minx)) return { center: v(0, 0, 0), radius: 1, diagonal: 1 }
    const dx = maxx - minx
    const dy = maxy - miny
    const dz = maxz - minz
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const diagonal = d > 0 ? d : 1
    return {
      center: v(0.5 * (minx + maxx), 0.5 * (miny + maxy), 0.5 * (minz + maxz)),
      radius: 0.5 * diagonal,
      diagonal,
    }
  }

  // Advance the render by `nPasses` full SPPM passes.
  step(nPasses: number): void {
    for (let p = 0; p < nPasses; p++) this.onePass()
  }

  private onePass(): void {
    this.cameraPass()
    this.grid.build(this.nPixels, this.alive, this.hpX, this.hpY, this.hpZ, this.r2)
    if (this.hasPhotonSources) this.photonPass()
    this.updateStatistics()
    this.passes++
    this.emittedTotal += this.opts.photonsPerPass
  }

  // ---- Camera pass: re-trace jittered eye rays, follow specular bounces, and
  // record the first non-specular surface as this pass's measurement point. ----
  private cameraPass(): void {
    const rng = this.rng
    const W = this.W
    const H = this.H
    const maxDepth = this.settings.maxDepth
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        this.alive[i] = 0
        this.flR[i] = 0
        this.flG[i] = 0
        this.flB[i] = 0
        this.flM[i] = 0
        this.hpMat[i] = null
        const u = (x + rng.next()) / W
        const t = 1 - (y + rng.next()) / H
        let ray: Ray = this.camera.generateRay(u, t, rng)
        let beta = v(1, 1, 1)
        let medium: Vec3 | null = null
        let lambda = 0 // committed hero wavelength (0 = achromatic, not yet chosen)
        for (let depth = 0; depth <= maxDepth; depth++) {
          this.stats.rays++
          const hit = this.scene.intersect(ray)
          if (!hit) {
            // Escaped to the environment: gather it weighted by throughput.
            const env = this.scene.envRadiance(ray.d)
            this.emitR[i] += beta.x * env.x
            this.emitG[i] += beta.y * env.y
            this.emitB[i] += beta.z * env.z
            break
          }
          if (medium) {
            beta = mul(beta, v(Math.exp(-medium.x * hit.t), Math.exp(-medium.y * hit.t), Math.exp(-medium.z * hit.t)))
          }
          const rawMat = this.scene.materials[hit.material]
          // Spectral dispersion: on the first wavelength-dependent surface the
          // camera path crosses (a prism seen directly), commit a hero wavelength
          // so the view refracts per-colour — matching the photon side.
          if (this.spectral && lambda === 0 && isSpectral(rawMat)) {
            lambda = LAMBDA_MIN + rng.next() * (LAMBDA_MAX - LAMBDA_MIN)
            beta = mul(beta, wavelengthWeight(lambda))
          }
          const mat = resolveMaterial(rawMat, hit.p, lambda)
          hit.n = bumpedNormal(rawMat, hit.p, hit.n, hit.ng)
          if (mat.kind === 'emissive') {
            // A directly visible emitter (or one seen through specular glass):
            // photon mapping handles indirect light, so emission is added here.
            if (hit.frontFace) {
              this.emitR[i] += beta.x * mat.emission.x
              this.emitG[i] += beta.y * mat.emission.y
              this.emitB[i] += beta.z * mat.emission.z
            }
            break
          }
          if (!isDelta(mat)) {
            // The measurement point: store it and stop the camera walk here.
            this.alive[i] = 1
            this.hpX[i] = hit.p.x
            this.hpY[i] = hit.p.y
            this.hpZ[i] = hit.p.z
            this.nX[i] = hit.n.x
            this.nY[i] = hit.n.y
            this.nZ[i] = hit.n.z
            this.woX[i] = -ray.d.x
            this.woY[i] = -ray.d.y
            this.woZ[i] = -ray.d.z
            this.betaR[i] = beta.x
            this.betaG[i] = beta.y
            this.betaB[i] = beta.z
            this.hpMat[i] = mat
            break
          }
          // Specular bounce: continue the camera walk.
          const bs = sampleBSDF(mat, neg(ray.d), hit.n, hit.frontFace, rng)
          if (!bs || bs.pdf <= 0 || isBlack(bs.weight)) break
          beta = mul(beta, bs.weight)
          if (bs.transmission && rawMat.kind === 'dielectric') {
            medium = hit.frontFace ? rawMat.absorption ?? null : null
          }
          ray = makeRay(offsetOrigin(hit.p, hit.ng, bs.wi), bs.wi)
        }
      }
    }
  }

  // ---- Photon pass: emit equal-flux photons from the emitters, walk them, and
  // deposit at every non-specular surface into the nearby measurement points. ----
  private photonPass(): void {
    const rng = this.rng
    const np = this.opts.photonsPerPass
    const maxDepth = this.settings.maxDepth
    const rrStart = this.settings.rrStart
    for (let p = 0; p < np; p++) {
      const emit = this.emitPhoton(rng)
      if (!emit) continue
      let ray = emit.ray
      let beta = emit.flux
      let medium: Vec3 | null = null
      let lambda = 0 // committed hero wavelength (0 = achromatic, not yet chosen)
      for (let depth = 0; depth <= maxDepth; depth++) {
        this.stats.rays++
        const hit = this.scene.intersect(ray)
        if (!hit) break
        if (medium) {
          beta = mul(beta, v(Math.exp(-medium.x * hit.t), Math.exp(-medium.y * hit.t), Math.exp(-medium.z * hit.t)))
        }
        const rawMat = this.scene.materials[hit.material]
        // Spectral photons: the first time a photon strikes a dispersive surface
        // it commits a random hero wavelength and is tinted by that wavelength's
        // RGB weight, so its onward refraction bends per-colour and the caustic
        // it deposits is coloured. E_λ[weight] = (1,1,1) keeps total flux exact.
        if (this.spectral && lambda === 0 && isSpectral(rawMat)) {
          lambda = LAMBDA_MIN + rng.next() * (LAMBDA_MAX - LAMBDA_MIN)
          beta = mul(beta, wavelengthWeight(lambda))
        }
        const mat = resolveMaterial(rawMat, hit.p, lambda)
        hit.n = bumpedNormal(rawMat, hit.p, hit.n, hit.ng)
        if (mat.kind === 'emissive') break // photons are absorbed by lights
        const wi = neg(ray.d) // incoming direction at the surface (points back along the photon)
        if (!isDelta(mat)) {
          this.deposit(hit.p, hit.n, mat, wi, beta)
        }
        // Russian roulette to bound the photon path length.
        if (depth >= rrStart) {
          const q = Math.min(0.95, Math.max(0.05, maxComponent(beta)))
          if (rng.next() >= q) break
          beta = scale(beta, 1 / q)
        }
        const bs = sampleBSDF(mat, wi, hit.n, hit.frontFace, rng)
        if (!bs || bs.pdf <= 0 || isBlack(bs.weight)) break
        beta = mul(beta, bs.weight)
        if (bs.transmission && rawMat.kind === 'dielectric') {
          medium = hit.frontFace ? rawMat.absorption ?? null : null
        }
        ray = makeRay(offsetOrigin(hit.p, hit.ng, bs.wi), bs.wi)
      }
    }
  }

  // Sample an emitter (power-proportional), then a point and a cosine-weighted
  // direction on its front face. The cosθ/pdf_ω = π and 1/pdf_A = A factors and
  // the 1/p_light selection term are folded into the flux, so every photon
  // carries flux Le·π·Σpower/lum(Le) — equal across white emitters, tinted by
  // coloured ones. The final image normalises by the total photons emitted.
  private emitPhoton(rng: Rng): { ray: Ray; flux: Vec3 } | null {
    if (this.totalPower <= 0) return null
    // Choose a source from the pool (triangles + the sun) by its power.
    const target = rng.next() * this.totalPower
    if (this.sun && target >= this.triPower) return this.emitSunPhoton(rng, this.sun)
    const nL = this.lights.length
    if (nL === 0) return null
    // Choose the emitter triangle by its power via the CDF (within [0, triPower)).
    let lo = 0
    let hi = nL
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.lightCdf[mid + 1] <= target) lo = mid + 1
      else hi = mid
    }
    const light = this.lights[Math.min(lo, nL - 1)]
    const tri = light.tri
    // Uniform point on the triangle.
    const { u, v: bv } = triangleBary(rng)
    const origin = madd(madd(tri.p0, tri.e1, u), tri.e2, bv)
    // Cosine-weighted direction in the emitter's front hemisphere (+ng).
    const dir = this.cosineAround(tri.ng, rng)
    const lum = luminance(light.emission)
    if (lum <= 0) return null
    const fluxScale = (Math.PI * this.totalPower) / lum
    const flux = scale(light.emission, fluxScale)
    return { ray: makeRay(offsetOrigin(origin, tri.ng, dir), dir), flux }
  }

  // Emit one photon from the environment sun. We sample a direction toward the
  // sun uniformly within its cone (the sun's disc, exactly as next-event
  // estimation samples it), read the radiance there, then launch the photon from
  // a uniformly sampled point on a disc of radius R (the scene's bounding-sphere
  // radius) one radius out along that direction, travelling as a parallel beam
  // into the scene. The disc faces the beam (cosθ = 1), so the per-photon flux is
  //   Φ = L·cosθ/(pdf_A·pdf_ω)·(ΣW/w_sun) = L·(πR²)·Ω·ΣW/(lum(L_rep)·πR²·Ω)
  //     = L·ΣW/lum(L_rep),
  // exactly parallel to the triangle case Le·π·ΣW/lum(Le); the πR²·Ω geometry
  // cancels against the selection weight, so the estimate is unbiased for any R.
  private emitSunPhoton(rng: Rng, sun: SunSource): { ray: Ray; flux: Vec3 } | null {
    // Direction toward the sun, uniform in the solar cone (matches sampleEnvLight).
    const u1 = rng.next()
    const u2 = rng.next()
    const cosT = 1 - u1 * (1 - sun.cosSize)
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
    const phi = 2 * Math.PI * u2
    const fr = onb(sun.dir)
    const toSun = toWorld(v(Math.cos(phi) * sinT, Math.sin(phi) * sinT, cosT), fr.t, fr.b, sun.dir)
    const L = this.scene.envRadiance(toSun)
    if (luminance(L) <= 0) return null
    // A uniformly sampled point on the emission disc (radius R, perpendicular to
    // toSun), centred one radius out toward the sun so the whole scene is behind it.
    const dr = sun.radius * Math.sqrt(rng.next())
    const da = 2 * Math.PI * rng.next()
    const disc = onb(toSun)
    const center = madd(sun.center, toSun, sun.radius)
    const origin = add(center, add(scale(disc.t, dr * Math.cos(da)), scale(disc.b, dr * Math.sin(da))))
    const dir = neg(toSun) // the photon travels away from the sun, into the scene
    const flux = scale(L, this.totalPower / sun.repLum)
    return { ray: makeRay(origin, dir), flux }
  }

  // A cosine-weighted hemisphere direction around the unit normal n.
  private cosineAround(n: Vec3, rng: Rng): Vec3 {
    const r = Math.sqrt(rng.next())
    const phi = 2 * Math.PI * rng.next()
    const lx = r * Math.cos(phi)
    const ly = r * Math.sin(phi)
    const lz = Math.sqrt(Math.max(0, 1 - lx * lx - ly * ly))
    // Build a tangent frame (Duff 2017, inlined to avoid importing onb here).
    const sign = n.z >= 0 ? 1 : -1
    const a = -1 / (sign + n.z)
    const b = n.x * n.y * a
    const tx = 1 + sign * n.x * n.x * a
    const ty = sign * b
    const tz = -sign * n.x
    const bx = b
    const by = sign + n.y * n.y * a
    const bz = -n.y
    return {
      x: lx * tx + ly * bx + lz * n.x,
      y: lx * ty + ly * by + lz * n.y,
      z: lx * tz + ly * bz + lz * n.z,
    }
  }

  // Deposit one photon (arriving with incoming direction `wi`, flux `phi`) into
  // every measurement point within its gather radius, accumulating Σ f·ΔΦ.
  private deposit(p: Vec3, _nPhoton: Vec3, _photonMat: Material, wi: Vec3, phi: Vec3): void {
    void _nPhoton
    void _photonMat
    this.grid.forEachNear(p.x, p.y, p.z, (i) => {
      if (!this.alive[i]) return
      const dx = this.hpX[i] - p.x
      const dy = this.hpY[i] - p.y
      const dz = this.hpZ[i] - p.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > this.r2[i]) return
      const mat = this.hpMat[i]
      if (!mat) return
      const wo = v(this.woX[i], this.woY[i], this.woZ[i])
      const n = v(this.nX[i], this.nY[i], this.nZ[i])
      // BSDF at the measurement point for (camera dir wo, photon dir wi).
      let f: Vec3
      if (mat.kind === 'diffuse' && !mat.sigma && !mat.coat) {
        if (dot(wi, n) <= 0 || dot(wo, n) <= 0) return
        f = scale(mat.albedo, INV_PI)
      } else {
        f = evalBSDF(mat, wo, wi, n)
        if (isBlack(f)) return
      }
      this.flR[i] += f.x * phi.x
      this.flG[i] += f.y * phi.y
      this.flB[i] += f.z * phi.z
      this.flM[i]++
    })
  }

  // ---- Progressive update: fold this pass's gathered flux into τ and shrink
  // the radius on the Hachisuka schedule (per measurement point). ----
  private updateStatistics(): void {
    const alpha = this.opts.alpha
    for (let i = 0; i < this.nPixels; i++) {
      if (!this.alive[i]) continue
      const M = this.flM[i]
      const N = this.nPhotons[i]
      if (N + M <= 0) continue
      const ratio = (N + alpha * M) / (N + M)
      this.r2[i] *= ratio
      // Fold in the camera-path throughput β at the measurement point, then add
      // this pass's gathered flux and rescale the running total to the new radius.
      const bR = this.betaR[i]
      const bG = this.betaG[i]
      const bB = this.betaB[i]
      this.tauR[i] = (this.tauR[i] + bR * this.flR[i]) * ratio
      this.tauG[i] = (this.tauG[i] + bG * this.flG[i]) * ratio
      this.tauB[i] = (this.tauB[i] + bB * this.flB[i]) * ratio
      this.nPhotons[i] = N + alpha * M
    }
  }

  // The current HDR estimate: directly-seen emission (averaged over passes) plus
  // the radius-normalised photon-density estimate of the (caustic + indirect)
  // radiance, τ / (N_emitted · π · R²), scaled by the camera throughput already
  // folded into τ.
  image(out?: Float32Array): Float32Array {
    const dst = out ?? new Float32Array(this.nPixels * 3)
    const passes = this.passes
    const emitScale = passes > 0 ? 1 / passes : 0
    const nEmit = this.emittedTotal
    for (let i = 0; i < this.nPixels; i++) {
      let r = this.emitR[i] * emitScale
      let g = this.emitG[i] * emitScale
      let b = this.emitB[i] * emitScale
      if (nEmit > 0 && this.r2[i] > 0) {
        const denom = 1 / (nEmit * Math.PI * this.r2[i])
        r += this.tauR[i] * denom
        g += this.tauG[i] * denom
        b += this.tauB[i] * denom
      }
      const o = i * 3
      dst[o] = Number.isFinite(r) ? r : 0
      dst[o + 1] = Number.isFinite(g) ? g : 0
      dst[o + 2] = Number.isFinite(b) ? b : 0
    }
    return dst
  }
}

// Build the environment sun as a photon source, or null if the scene has no sun
// (a solid colour or a sun-less gradient) or its sun carries no energy. The
// selection weight is the sun's total luminous power lum(L_rep)·π·R²·Ω, so the
// share of photons the sun receives is proportional to how much light it pours
// into the scene relative to the triangle emitters.
function buildSunSource(scene: Scene, center: Vec3, radius: number): SunSource | null {
  const es = scene.envSun
  if (!es || radius <= 0) return null
  const rep = scene.envRadiance(es.dir) // representative (cone-centre) radiance
  const repLum = luminance(rep)
  if (repLum <= 0) return null
  const weight = repLum * Math.PI * radius * radius * es.solidAngle
  if (!(weight > 0)) return null
  return { dir: es.dir, cosSize: es.cosSize, solidAngle: es.solidAngle, center, radius, repLum, weight }
}

// One-shot convenience used by the verification suite: render a scene to a
// normalised HDR image with SPPM at a given number of passes.
export function renderSPPM(
  scene: Scene,
  camera: Camera,
  settings: IntegratorSettings,
  W: number,
  H: number,
  passes: number,
  seed: number,
  opts: SppmOptions = DEFAULT_SPPM,
): Float32Array {
  const state = new SppmState(scene, camera, settings, W, H, seed, opts)
  state.step(Math.max(1, passes))
  return state.image()
}
