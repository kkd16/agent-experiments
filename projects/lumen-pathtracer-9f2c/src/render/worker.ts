/// <reference lib="webworker" />
// worker.ts — one render worker. It owns a horizontal band of the image, builds
// its own copy of the Scene + BVH (cheaper than serialising the acceleration
// structure), and on each `pass` message traces exactly one more sample per
// pixel in its band, returning that pass's radiance (and, on early passes, the
// albedo/normal G-buffer for denoising). The UI thread accumulates the passes.

import { Scene } from '../engine/scene'
import { Camera } from '../engine/camera'
import { Rng } from '../engine/rng'
import { halton23, halton57, pixelOffset } from '../engine/qmc'
import { integrate } from '../engine/integrator'
import type { GBuffer, RayStats } from '../engine/integrator'
import { MltState, DEFAULT_MLT } from '../engine/pssmlt'
import { SppmState, DEFAULT_SPPM } from '../engine/sppm'
import { Guide } from '../engine/guiding'
import type { FromWorker, InitMsg, IntegratorSettings, ToWorker } from '../engine/types'

// A power of two ≥ 1 — the path-guiding iteration boundaries (1,2,4,8,…), at
// which the SD-tree refines and doubles the data backing the next iteration.
function isPow2(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0
}

// A full-frame estimator (PSSMLT or SPPM): both advance with step(n), expose a
// progress figure, and read back a fresh HDR image. Each worker owns the *whole*
// image (not a band); the UI thread averages the workers' independent estimates.
interface FrameEstimator {
  step(n: number): void
  image(out?: Float32Array): Float32Array
  readonly mutationsPerPixel: number
  readonly brightness: number
  readonly stats: RayStats
}

let scene: Scene | null = null
let camera: Camera | null = null
let width = 0
let height = 0
let bandStart = 0
let bandEnd = 0
let settings: IntegratorSettings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
let rng: Rng = new Rng(1)
let frame: FrameEstimator | null = null
let frameKind: 'pssmlt' | 'sppm' | null = null
// The path-guiding SD-tree (only for the 'guided' integrator); persists across
// passes so it can learn the incident-radiance field over successive iterations.
let guide: Guide | null = null

function handleInit(msg: InitMsg): void {
  width = msg.width
  height = msg.height
  bandStart = msg.bandStart
  bandEnd = msg.bandEnd
  settings = msg.settings
  scene = new Scene(msg.scene)
  camera = new Camera(msg.scene.camera, width / height)
  rng = new Rng(msg.seed ^ (bandStart * 0x9e3779b1), bandStart + 1)
  frame = null
  frameKind = null
  guide = settings.integrator === 'guided' ? new Guide(scene.bounds) : null
  if (settings.integrator === 'pssmlt') {
    // Bootstrap scales gently with resolution but stays bounded so startup is
    // quick; chains are seeded from a per-worker seed so each is decorrelated.
    const nBootstrap = Math.min(40000, Math.max(12000, Math.round(width * height * 0.3)))
    frame = new MltState(scene, camera, settings, width, height, msg.seed >>> 0, {
      ...DEFAULT_MLT,
      nChains: 8,
      nBootstrap,
    })
    frameKind = 'pssmlt'
  } else if (settings.integrator === 'sppm') {
    // Photons per pass scale with resolution (a denser image wants a denser map)
    // but stay bounded so each pass returns promptly to the UI for compositing.
    const photonsPerPass = Math.min(250000, Math.max(60000, Math.round(width * height * 0.8)))
    frame = new SppmState(scene, camera, settings, width, height, msg.seed >>> 0, {
      ...DEFAULT_SPPM,
      photonsPerPass,
    })
    frameKind = 'sppm'
  }
  const ready: FromWorker = {
    type: 'ready',
    buildMs: scene.buildMs,
    triCount: scene.triangleCount,
    bvhNodes: scene.bvh.nodeCount,
    bvhDepth: scene.bvh.maxDepth,
  }
  post(ready, [])
}

// One full-frame estimator pass. PSSMLT advances its chains by ~½ a mutation per
// pixel; SPPM runs one complete photon pass (camera measurement points + photon
// emission + radius update). Either way we ship the current normalised image
// back and keep accumulating across passes so the estimate refines progressively.
function handleFramePass(): void {
  if (!frame) return
  const before = frame.stats.rays
  if (frameKind === 'sppm') {
    frame.step(1)
  } else {
    frame.step(Math.max(1, Math.round(width * height * 0.5)))
  }
  const img = frame.image() // a fresh Float32Array we can hand off by transfer
  const buf = img.buffer as ArrayBuffer
  const done: FromWorker = {
    type: 'mltDone',
    image: buf,
    mpp: frame.mutationsPerPixel,
    rays: frame.stats.rays - before,
    b: frame.brightness,
  }
  post(done, [buf])
}

function handlePass(sampleIndex: number, captureGBuffer: boolean): void {
  if (!scene || !camera) return
  const rows = bandEnd - bandStart
  const rad = new Float32Array(rows * width * 3)
  const alb = captureGBuffer ? new Float32Array(rows * width * 3) : undefined
  const nor = captureGBuffer ? new Float32Array(rows * width * 3) : undefined
  const stats: RayStats = { rays: 0 }
  const gbuf: GBuffer | undefined = captureGBuffer
    ? { albedo: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 } }
    : undefined

  // Halton index: +1 so the very first sample isn't the degenerate (0,0) point.
  const hIndex = sampleIndex + 1
  for (let y = bandStart; y < bandEnd; y++) {
    const row = (y - bandStart) * width
    for (let x = 0; x < width; x++) {
      // Low-discrepancy sub-pixel jitter + lens sample, decorrelated per pixel
      // by a Cranley–Patterson rotation; deeper bounces stay on the RNG.
      const off = pixelOffset(x, y)
      const pj = halton23(hIndex, off.x, off.y)
      const lens = halton57(hIndex, off.x, off.y)
      const u = (x + pj.x) / width
      const vScreen = 1 - (y + pj.y) / height // flip so +v is up
      const ray = camera.generateRay(u, vScreen, rng, lens)
      const L = integrate(scene, ray, settings, rng, stats, gbuf, guide ?? undefined)
      const idx = (row + x) * 3
      rad[idx] = L.x
      rad[idx + 1] = L.y
      rad[idx + 2] = L.z
      if (alb && nor && gbuf) {
        alb[idx] = gbuf.albedo.x
        alb[idx + 1] = gbuf.albedo.y
        alb[idx + 2] = gbuf.albedo.z
        nor[idx] = gbuf.normal.x
        nor[idx + 1] = gbuf.normal.y
        nor[idx + 2] = gbuf.normal.z
      }
    }
  }

  // Close a path-guiding iteration at every power-of-two sample count, so each
  // iteration trains on twice the samples of the last and the SD-tree sharpens.
  if (guide && isPow2(sampleIndex + 1)) guide.endIteration()

  const transfer: ArrayBuffer[] = [rad.buffer]
  if (alb) transfer.push(alb.buffer)
  if (nor) transfer.push(nor.buffer)
  const done: FromWorker = {
    type: 'passDone',
    sampleIndex,
    bandStart,
    bandEnd,
    rays: stats.rays,
    radiance: rad.buffer,
    albedo: alb?.buffer,
    normal: nor?.buffer,
  }
  post(done, transfer)
}

function post(msg: FromWorker, transfer: ArrayBuffer[]): void {
  ;(self as unknown as Worker).postMessage(msg, transfer)
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'init':
      handleInit(msg)
      break
    case 'pass':
      if (frame) handleFramePass()
      else handlePass(msg.sampleIndex, msg.captureGBuffer)
      break
    case 'reset':
      break
  }
}
