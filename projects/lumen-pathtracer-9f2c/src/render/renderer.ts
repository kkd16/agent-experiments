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
import { radiance } from '../engine/integrator'
import type { GBuffer, RayStats } from '../engine/integrator'
import { tonemapToBytes } from '../engine/tonemap'
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
  done: boolean
}

const GBUFFER_PASSES = 16 // accumulate denoise guides over the first N samples
const DENOISE_THROTTLE_MS = 700

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
  private albAccum = new Float32Array(0)
  private norAccum = new Float32Array(0)
  private avg = new Float32Array(0)
  private out = new Uint8ClampedArray(0)
  private image: ImageData | null = null
  private denoiseCache: Float32Array | null = null
  private lastDenoiseMs = 0

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
    this.albAccum = new Float32Array(n * 3)
    this.norAccum = new Float32Array(n * 3)
    this.avg = new Float32Array(n * 3)
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
    this.albAccum.fill(0)
    this.norAccum.fill(0)
    this.bandSamples = []
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
    if (this.running && this.bandSamples[index] < this.targetSpp) {
      this.dispatchPass(index)
    }
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
    for (let i = 0; i < rad.length; i++) accum[rowOffset + i] += rad[i]
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
      for (let x = 0; x < this.width; x++) {
        const jx = this.stRng.next()
        const jy = this.stRng.next()
        const u = (x + jx) / this.width
        const vScreen = 1 - (y + jy) / this.height
        const ray = camera.generateRay(u, vScreen, this.stRng)
        const L = radiance(scene, ray, this.settings, this.stRng, stats, gbuf)
        const idx = (base + x) * 3
        this.accum[idx] += L.x
        this.accum[idx + 1] += L.y
        this.accum[idx + 2] += L.z
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
      }
    }
    this.totalRays += stats.rays
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
    const done = samples >= this.targetSpp
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
