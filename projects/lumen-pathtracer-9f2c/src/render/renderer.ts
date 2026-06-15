// renderer.ts — the UI-thread render controller. It owns the canvas, a pool of
// render workers, and the progressive accumulation buffers, and it ties them
// together: dispatch a pass to each idle worker, fold the returned radiance into
// the running sum, and on each animation frame tone-map (and optionally denoise)
// the current average onto the screen. If Workers are unavailable — e.g. inside
// the sandboxed catalog thumbnail — it transparently falls back to a chunked
// single-threaded loop so the preview still renders.

import { Scene } from '../engine/scene'
import { Camera } from '../engine/camera'
import { Rng } from '../engine/rng'
import { halton23, halton57, pixelOffset } from '../engine/qmc'
import { integrate } from '../engine/integrator'
import type { GBuffer, RayStats } from '../engine/integrator'
import { tonemapToBytes, noiseToBytes } from '../engine/tonemap'
import { denoise } from '../engine/denoise'
import type { DenoiseParams } from '../engine/denoise'
import type {
  FromWorker,
  IntegratorSettings,
  PassDoneMsg,
  ReadyMsg,
  SceneDef,
  ToneMapping,
  ToWorker,
} from '../engine/types'

export interface DisplaySettings {
  exposure: number
  tonemap: ToneMapping
  denoiseEnabled: boolean
  denoise: DenoiseParams
  showNoise: boolean // overlay the per-pixel relative-error heatmap instead
}

// Adaptive sampling: once a band's mean relative error falls below `threshold`
// (after a warm-up), the renderer stops dispatching new passes to it. Clean
// regions therefore stop accruing samples early while noisy ones keep refining
// toward the target spp, so the whole frame reaches a uniform quality sooner.
export interface AdaptiveSettings {
  enabled: boolean
  threshold: number
}

export interface RenderStats {
  samples: number
  targetSpp: number
  rays: number
  raysPerSec: number
  elapsedMs: number
  workers: number
  mode: 'multithread' | 'singlethread'
  triCount: number
  bvhNodes: number
  bvhDepth: number
  noise: number // mean relative error across the image (0 = converged)
  converged: number // fraction of bands that hit the adaptive threshold
  done: boolean
}

const GBUFFER_PASSES = 16 // accumulate denoise guides over the first N samples
const DENOISE_THROTTLE_MS = 700
const ADAPT_WARMUP = 24 // min samples before adaptive early-out may trigger
const NOISE_HEATMAP_GAIN = 6 // scales relative error into the heatmap palette
const NOISE_REFRESH_MS = 160 // throttle for the per-pixel noise recompute

export class Renderer {
  private ctx: CanvasRenderingContext2D
  private width = 0
  private height = 0
  private sceneDef: SceneDef
  private settings: IntegratorSettings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
  private display: DisplaySettings
  private targetSpp = 1024

  private workers: Worker[] = []
  private bands: { start: number; end: number }[] = []
  private inFlight: boolean[] = []
  private bandSamples: number[] = []
  private mode: 'multithread' | 'singlethread' = 'singlethread'

  private accum = new Float32Array(0)
  private accumSq = new Float32Array(0) // Σ of per-sample radiance² → variance
  private albAccum = new Float32Array(0)
  private norAccum = new Float32Array(0)
  private avg = new Float32Array(0)
  private noise = new Float32Array(0) // per-pixel relative error (1 channel)
  private out = new Uint8ClampedArray(0)
  private image: ImageData | null = null
  private denoiseCache: Float32Array | null = null
  private lastDenoiseMs = 0
  private adaptive: AdaptiveSettings = { enabled: false, threshold: 0.03 }
  private bandConverged: boolean[] = []
  private meanNoise = 0
  private lastNoiseMs = 0

  private running = false
  private raf = 0
  private startTime = 0
  private totalRays = 0
  private readyWorkers = 0
  private readyMeta: ReadyMsg | null = null

  // Single-thread fallback state.
  private stScene: Scene | null = null
  private stCamera: Camera | null = null
  private stRng = new Rng(1)
  private stRow = 0
  private stSample = 0

  onStats: (s: RenderStats) => void = () => {}

  constructor(canvas: HTMLCanvasElement, sceneDef: SceneDef, display: DisplaySettings) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
    this.sceneDef = sceneDef
    this.display = display
  }

  // ---- configuration ---------------------------------------------------------

  setResolution(width: number, height: number): void {
    this.width = width
    this.height = height
    const n = width * height
    this.accum = new Float32Array(n * 3)
    this.accumSq = new Float32Array(n * 3)
    this.albAccum = new Float32Array(n * 3)
    this.norAccum = new Float32Array(n * 3)
    this.avg = new Float32Array(n * 3)
    this.noise = new Float32Array(n)
    this.out = new Uint8ClampedArray(n * 4)
    this.image = new ImageData(width, height)
    const canvas = this.ctx.canvas
    canvas.width = width
    canvas.height = height
  }

  setScene(def: SceneDef): void {
    this.sceneDef = def
  }
  setSettings(s: IntegratorSettings): void {
    this.settings = s
  }
  setTarget(spp: number): void {
    this.targetSpp = spp
  }
  setDisplay(d: DisplaySettings): void {
    this.display = d
    this.denoiseCache = null // force recompute
  }
  // Adaptive sampling is applied live: re-arming a stopped band is fine because
  // every passDone re-evaluates the convergence test before dispatching again.
  setAdaptive(a: AdaptiveSettings): void {
    this.adaptive = a
    if (!a.enabled) this.bandConverged = this.bandConverged.map(() => false)
  }

  get currentMode(): 'multithread' | 'singlethread' {
    return this.mode
  }

  // ---- lifecycle -------------------------------------------------------------

  // (Re)start a fresh render of the current scene at the current resolution.
  start(): void {
    this.stop()
    this.resetBuffers()
    this.running = true
    this.startTime = now()
    this.totalRays = 0
    this.spawnWorkers()
    this.loop()
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const w of this.workers) w.terminate()
    this.workers = []
    this.inFlight = []
    this.readyWorkers = 0
  }

  dispose(): void {
    this.stop()
  }

  private resetBuffers(): void {
    this.accum.fill(0)
    this.accumSq.fill(0)
    this.albAccum.fill(0)
    this.norAccum.fill(0)
    this.noise.fill(0)
    this.bandSamples = []
    this.bandConverged = []
    this.meanNoise = 0
    this.lastNoiseMs = 0
    this.denoiseCache = null
    this.stRow = 0
    this.stSample = 0
  }

  // ---- worker pool -----------------------------------------------------------

  private spawnWorkers(): void {
    const cores = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4))
    let created: Worker[] = []
    try {
      for (let i = 0; i < cores; i++) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
        created.push(w)
      }
    } catch {
      // Sandboxed contexts forbid Workers — tear down and fall back.
      for (const w of created) {
        try {
          w.terminate()
        } catch {
          /* ignore */
        }
      }
      created = []
    }

    if (created.length === 0) {
      this.mode = 'singlethread'
      this.setupSingleThread()
      return
    }

    this.mode = 'multithread'
    this.workers = created
    this.bands = sliceBands(this.height, created.length)
    this.inFlight = new Array(created.length).fill(false)
    this.bandSamples = new Array(created.length).fill(0)
    this.bandConverged = new Array(created.length).fill(false)
    const seed = (Math.random() * 0xffffffff) >>> 0

    created.forEach((w, i) => {
      w.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorkerMessage(i, ev.data)
      w.onerror = () => {
        // A worker died mid-flight; degrade gracefully to single-thread.
        this.fallbackToSingleThread()
      }
      const init: ToWorker = {
        type: 'init',
        scene: this.sceneDef,
        width: this.width,
        height: this.height,
        bandStart: this.bands[i].start,
        bandEnd: this.bands[i].end,
        settings: this.settings,
        seed: seed + i * 2654435761,
      }
      w.postMessage(init)
    })

    // Watchdog: if a worker was constructed but is silently blocked (e.g. a
    // sandboxed iframe with no same-origin), no `ready` ever arrives. Fall back.
    window.setTimeout(() => {
      if (this.running && this.mode === 'multithread' && this.readyWorkers === 0) {
        this.fallbackToSingleThread()
      }
    }, 1800)
  }

  private fallbackToSingleThread(): void {
    if (this.mode === 'singlethread') return
    for (const w of this.workers) {
      try {
        w.terminate()
      } catch {
        /* ignore */
      }
    }
    this.workers = []
    this.mode = 'singlethread'
    this.resetBuffers()
    this.setupSingleThread()
  }

  private setupSingleThread(): void {
    this.stScene = new Scene(this.sceneDef)
    this.stCamera = new Camera(this.sceneDef.camera, this.width / this.height)
    this.stRng = new Rng((Math.random() * 0xffffffff) >>> 0, 1)
    this.bandSamples = [0]
    this.bandConverged = [false]
    this.bands = [{ start: 0, end: this.height }]
    this.readyMeta = {
      type: 'ready',
      buildMs: this.stScene.buildMs,
      triCount: this.stScene.triangleCount,
      bvhNodes: this.stScene.bvh.nodeCount,
      bvhDepth: this.stScene.bvh.maxDepth,
    }
  }

  private onWorkerMessage(index: number, msg: FromWorker): void {
    if (msg.type === 'ready') {
      this.readyWorkers++
      this.readyMeta = msg
      this.dispatchPass(index)
      return
    }
    this.accumulatePass(msg)
    this.inFlight[index] = false
    if (this.running && this.shouldDispatch(index)) {
      this.dispatchPass(index)
    }
  }

  // A band keeps sampling until it reaches the target spp, unless adaptive
  // sampling has declared it converged (its mean relative error fell below the
  // threshold after a warm-up). A converged band stops accruing samples while the
  // pool's still-noisy bands keep refining toward the target.
  private shouldDispatch(index: number): boolean {
    if (this.bandSamples[index] >= this.targetSpp) return false
    if (this.adaptive.enabled && this.bandSamples[index] >= ADAPT_WARMUP) {
      if (this.bandRelError(index) < this.adaptive.threshold) {
        this.bandConverged[index] = true
        return false
      }
    }
    this.bandConverged[index] = false
    return true
  }

  private dispatchPass(index: number): void {
    if (!this.running) return
    const sampleIndex = this.bandSamples[index]
    if (sampleIndex >= this.targetSpp) return
    this.inFlight[index] = true
    const msg: ToWorker = {
      type: 'pass',
      sampleIndex,
      captureGBuffer: sampleIndex < GBUFFER_PASSES,
    }
    this.workers[index].postMessage(msg)
  }

  private accumulatePass(msg: PassDoneMsg): void {
    const rad = new Float32Array(msg.radiance)
    const rowOffset = msg.bandStart * this.width * 3
    const accum = this.accum
    const accumSq = this.accumSq
    for (let i = 0; i < rad.length; i++) {
      const x = rad[i]
      accum[rowOffset + i] += x
      accumSq[rowOffset + i] += x * x
    }
    if (msg.albedo && msg.normal) {
      const alb = new Float32Array(msg.albedo)
      const nor = new Float32Array(msg.normal)
      const a = this.albAccum
      const nn = this.norAccum
      for (let i = 0; i < alb.length; i++) {
        a[rowOffset + i] += alb[i]
        nn[rowOffset + i] += nor[i]
      }
    }
    this.totalRays += msg.rays
    // bandSamples indexed by worker; find which band this came from.
    const bandIndex = this.bands.findIndex((b) => b.start === msg.bandStart)
    if (bandIndex >= 0) this.bandSamples[bandIndex] = msg.sampleIndex + 1
  }

  // ---- main loop -------------------------------------------------------------

  private loop = (): void => {
    if (!this.running) return
    if (this.mode === 'singlethread') this.tickSingleThread()
    this.composite()
    this.emitStats()
    this.raf = requestAnimationFrame(this.loop)
  }

  // Render a slice of work synchronously, budgeted to keep the frame responsive.
  private tickSingleThread(): void {
    if (!this.stScene || !this.stCamera) return
    if (this.stSample >= this.targetSpp) return
    const scene = this.stScene
    const camera = this.stCamera
    const stats: RayStats = { rays: 0 }
    const capture = this.stSample < GBUFFER_PASSES
    const gbuf: GBuffer | undefined = capture
      ? { albedo: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 } }
      : undefined
    // Time-budgeted: process rows until ~24ms elapse, then yield to the browser.
    const budgetEnd = now() + 24
    while (now() < budgetEnd) {
      const y = this.stRow
      const base = y * this.width
      const hIndex = this.stSample + 1
      for (let x = 0; x < this.width; x++) {
        const off = pixelOffset(x, y)
        const pj = halton23(hIndex, off.x, off.y)
        const lens = halton57(hIndex, off.x, off.y)
        const u = (x + pj.x) / this.width
        const vScreen = 1 - (y + pj.y) / this.height
        const ray = camera.generateRay(u, vScreen, this.stRng, lens)
        const L = integrate(scene, ray, this.settings, this.stRng, stats, gbuf)
        const idx = (base + x) * 3
        this.accum[idx] += L.x
        this.accum[idx + 1] += L.y
        this.accum[idx + 2] += L.z
        this.accumSq[idx] += L.x * L.x
        this.accumSq[idx + 1] += L.y * L.y
        this.accumSq[idx + 2] += L.z * L.z
        if (gbuf) {
          this.albAccum[idx] += gbuf.albedo.x
          this.albAccum[idx + 1] += gbuf.albedo.y
          this.albAccum[idx + 2] += gbuf.albedo.z
          this.norAccum[idx] += gbuf.normal.x
          this.norAccum[idx + 1] += gbuf.normal.y
          this.norAccum[idx + 2] += gbuf.normal.z
        }
      }
      this.stRow++
      if (this.stRow >= this.height) {
        this.stRow = 0
        this.stSample++
        this.bandSamples[0] = this.stSample
        if (this.stSample >= this.targetSpp) break
        if (
          this.adaptive.enabled &&
          this.stSample >= ADAPT_WARMUP &&
          this.bandRelError(0) < this.adaptive.threshold
        ) {
          this.bandConverged[0] = true
          this.stSample = this.targetSpp
          break
        }
      }
    }
    this.totalRays += stats.rays
  }

  // Mean luminance relative error over a band: the standard error of the Monte
  // Carlo mean divided by the mean itself, averaged across the band's pixels.
  // This is the live, unbiased noise estimate that drives both the heatmap and
  // the adaptive early-out.
  private bandRelError(bandIndex: number): number {
    const b = this.bands[bandIndex]
    if (!b) return 0
    const n = Math.max(1, this.bandSamples[bandIndex])
    if (n < 2) return 1
    const w = this.width
    let sum = 0
    let count = 0
    for (let y = b.start; y < b.end; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3
        // Luminance of the running mean and of the per-sample variance.
        const mr = this.accum[i] / n
        const mg = this.accum[i + 1] / n
        const mb = this.accum[i + 2] / n
        const meanLum = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb
        const vr = Math.max(0, this.accumSq[i] / n - mr * mr)
        const vg = Math.max(0, this.accumSq[i + 1] / n - mg * mg)
        const vb = Math.max(0, this.accumSq[i + 2] / n - mb * mb)
        const varLum = 0.2126 * vr + 0.7152 * vg + 0.0722 * vb
        const stdErr = Math.sqrt(varLum / n)
        sum += stdErr / (meanLum + 1e-3)
        count++
      }
    }
    return count > 0 ? sum / count : 0
  }

  // Fill `this.noise` with the per-pixel relative error for the heatmap, and
  // return the image-wide mean (also used as the headline convergence stat).
  private buildNoise(): number {
    const w = this.width
    const noise = this.noise
    let total = 0
    for (let bi = 0; bi < this.bands.length; bi++) {
      const b = this.bands[bi]
      const n = Math.max(1, this.bandSamples[bi])
      for (let y = b.start; y < b.end; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x
          const i = p * 3
          const mr = this.accum[i] / n
          const mg = this.accum[i + 1] / n
          const mb = this.accum[i + 2] / n
          const meanLum = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb
          const vr = Math.max(0, this.accumSq[i] / n - mr * mr)
          const vg = Math.max(0, this.accumSq[i + 1] / n - mg * mg)
          const vb = Math.max(0, this.accumSq[i + 2] / n - mb * mb)
          const varLum = 0.2126 * vr + 0.7152 * vg + 0.0722 * vb
          const rel = n >= 2 ? Math.sqrt(varLum / n) / (meanLum + 1e-3) : 1
          noise[p] = rel
          total += rel
        }
      }
    }
    return noise.length > 0 ? total / noise.length : 0
  }

  // Build the averaged HDR buffer, optionally denoise, tone-map, and blit.
  private composite(): void {
    if (!this.image) return
    const minSamples = this.minSamples()
    if (minSamples <= 0 && this.stSample === 0) {
      // Nothing rendered yet — clear to dark so the canvas is not garbage.
      this.out.fill(0)
      for (let i = 3; i < this.out.length; i += 4) this.out[i] = 255
      this.image.data.set(this.out)
      this.ctx.putImageData(this.image, 0, 0)
      return
    }
    // Average each pixel by the number of samples its band has completed.
    this.buildAverage()
    // Refresh the relative-error map (the convergence stat + heatmap source) on a
    // throttle — it is an extra full-image pass, and ~6 Hz is plenty for a stat.
    const t = now()
    if (t - this.lastNoiseMs > NOISE_REFRESH_MS || this.lastNoiseMs === 0) {
      this.meanNoise = this.buildNoise()
      this.lastNoiseMs = t
    }
    if (this.display.showNoise) {
      noiseToBytes(this.noise, this.out, NOISE_HEATMAP_GAIN)
      this.image.data.set(this.out)
      this.ctx.putImageData(this.image, 0, 0)
      return
    }
    // `Float32Array` (= Float32Array<ArrayBufferLike>) so the denoise result and
    // the raw average — backed by different buffer kinds — unify cleanly.
    let display: Float32Array = this.avg
    if (this.display.denoiseEnabled) display = this.maybeDenoise()
    tonemapToBytes(display, this.out, this.display.exposure, this.display.tonemap)
    this.image.data.set(this.out)
    this.ctx.putImageData(this.image, 0, 0)
  }

  private buildAverage(): void {
    const w3 = this.width * 3
    for (let bi = 0; bi < this.bands.length; bi++) {
      const b = this.bands[bi]
      const s = Math.max(1, this.bandSamples[bi])
      const inv = 1 / s
      const gInv = 1 / Math.max(1, Math.min(s, GBUFFER_PASSES))
      const start = b.start * w3
      const end = b.end * w3
      for (let i = start; i < end; i++) this.avg[i] = this.accum[i] * inv
      // Pre-divide the G-buffer in place into the same average pass is messy;
      // we divide albedo/normal lazily inside denoise via gInv-scaled copies.
      this.gInvByBand[bi] = gInv
    }
  }

  private gInvByBand: number[] = []

  private maybeDenoise(): Float32Array {
    const t = now()
    if (this.denoiseCache && t - this.lastDenoiseMs < DENOISE_THROTTLE_MS) {
      return this.denoiseCache
    }
    this.lastDenoiseMs = t
    // Build per-pixel averaged albedo/normal guides.
    const n = this.width * this.height
    const alb = new Float32Array(n * 3)
    const nor = new Float32Array(n * 3)
    const w3 = this.width * 3
    for (let bi = 0; bi < this.bands.length; bi++) {
      const b = this.bands[bi]
      const gInv = this.gInvByBand[bi] ?? 1
      const start = b.start * w3
      const end = b.end * w3
      for (let i = start; i < end; i++) {
        alb[i] = this.albAccum[i] * gInv
        nor[i] = this.norAccum[i] * gInv
      }
    }
    this.denoiseCache = denoise(this.avg, nor, alb, this.width, this.height, this.display.denoise)
    return this.denoiseCache
  }

  private minSamples(): number {
    if (this.bandSamples.length === 0) return 0
    let m = Infinity
    for (const s of this.bandSamples) m = Math.min(m, s)
    return m === Infinity ? 0 : m
  }

  private emitStats(): void {
    const elapsed = now() - this.startTime
    const samples = this.minSamples()
    // A render is finished when every band has either reached the target sample
    // count or been declared converged by adaptive sampling.
    const nBands = this.bands.length || 1
    const convergedCount = this.bandConverged.filter(Boolean).length
    const allSettled =
      this.bandSamples.length > 0 &&
      this.bandSamples.every((s, i) => s >= this.targetSpp || this.bandConverged[i])
    const done = samples >= this.targetSpp || allSettled
    if (done) this.running = false
    this.onStats({
      samples,
      targetSpp: this.targetSpp,
      rays: this.totalRays,
      raysPerSec: elapsed > 0 ? (this.totalRays / elapsed) * 1000 : 0,
      elapsedMs: elapsed,
      workers: this.mode === 'multithread' ? this.workers.length : 1,
      mode: this.mode,
      triCount: this.readyMeta?.triCount ?? 0,
      bvhNodes: this.readyMeta?.bvhNodes ?? 0,
      bvhDepth: this.readyMeta?.bvhDepth ?? 0,
      noise: this.meanNoise,
      converged: convergedCount / nBands,
      done,
    })
  }

  // ---- export ----------------------------------------------------------------

  // Returns a PNG data URL of the current (composited) canvas.
  toDataURL(): string {
    return this.ctx.canvas.toDataURL('image/png')
  }
}

// Split `height` rows across `count` bands as evenly as possible.
function sliceBands(height: number, count: number): { start: number; end: number }[] {
  const bands: { start: number; end: number }[] = []
  const base = Math.floor(height / count)
  let rem = height - base * count
  let y = 0
  for (let i = 0; i < count; i++) {
    const rows = base + (rem > 0 ? 1 : 0)
    if (rem > 0) rem--
    bands.push({ start: y, end: y + rows })
    y += rows
  }
  return bands
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
