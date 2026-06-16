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
import type { FromWorker, InitMsg, IntegratorSettings, ToWorker } from '../engine/types'

let scene: Scene | null = null
let camera: Camera | null = null
let width = 0
let height = 0
let bandStart = 0
let bandEnd = 0
let settings: IntegratorSettings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
let rng: Rng = new Rng(1)
// PSSMLT: each worker runs its own independent set of Markov chains over the
// *whole* image (not a band); the UI thread averages the workers' estimates.
let mlt: MltState | null = null

function handleInit(msg: InitMsg): void {
  width = msg.width
  height = msg.height
  bandStart = msg.bandStart
  bandEnd = msg.bandEnd
  settings = msg.settings
  scene = new Scene(msg.scene)
  camera = new Camera(msg.scene.camera, width / height)
  rng = new Rng(msg.seed ^ (bandStart * 0x9e3779b1), bandStart + 1)
  mlt = null
  if (settings.integrator === 'pssmlt') {
    // Bootstrap scales gently with resolution but stays bounded so startup is
    // quick; chains are seeded from a per-worker seed so each is decorrelated.
    const nBootstrap = Math.min(40000, Math.max(12000, Math.round(width * height * 0.3)))
    mlt = new MltState(scene, camera, settings, width, height, msg.seed >>> 0, {
      ...DEFAULT_MLT,
      nChains: 8,
      nBootstrap,
    })
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

// One PSSMLT pass: advance the chains by ~½ a mutation per pixel, then ship the
// current normalised image back. The worker keeps its splat buffer across passes
// so the estimate refines progressively.
function handleMltPass(): void {
  if (!mlt) return
  const before = mlt.stats.rays
  const steps = Math.max(1, Math.round(width * height * 0.5))
  mlt.step(steps)
  const img = mlt.image() // a fresh Float32Array we can hand off by transfer
  const buf = img.buffer as ArrayBuffer
  const done: FromWorker = {
    type: 'mltDone',
    image: buf,
    mpp: mlt.mutationsPerPixel,
    rays: mlt.stats.rays - before,
    b: mlt.brightness,
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
      const L = integrate(scene, ray, settings, rng, stats, gbuf)
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
      if (mlt) handleMltPass()
      else handlePass(msg.sampleIndex, msg.captureGBuffer)
      break
    case 'reset':
      break
  }
}
