/// <reference lib="webworker" />
// worker.ts — one render worker. It owns a horizontal band of the image, builds
// its own copy of the Scene + BVH (cheaper than serialising the acceleration
// structure), and on each `pass` message traces exactly one more sample per
// pixel in its band, returning that pass's radiance (and, on early passes, the
// albedo/normal G-buffer for denoising). The UI thread accumulates the passes.

import { Scene } from '../engine/scene'
import { Camera } from '../engine/camera'
import { Rng } from '../engine/rng'
import { radiance } from '../engine/integrator'
import type { GBuffer, RayStats } from '../engine/integrator'
import type { FromWorker, InitMsg, IntegratorSettings, ToWorker } from '../engine/types'

let scene: Scene | null = null
let camera: Camera | null = null
let width = 0
let height = 0
let bandStart = 0
let bandEnd = 0
let settings: IntegratorSettings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
let rng: Rng = new Rng(1)

function handleInit(msg: InitMsg): void {
  width = msg.width
  height = msg.height
  bandStart = msg.bandStart
  bandEnd = msg.bandEnd
  settings = msg.settings
  scene = new Scene(msg.scene)
  camera = new Camera(msg.scene.camera, width / height)
  rng = new Rng(msg.seed ^ (bandStart * 0x9e3779b1), bandStart + 1)
  const ready: FromWorker = {
    type: 'ready',
    buildMs: scene.buildMs,
    triCount: scene.triangleCount,
    bvhNodes: scene.bvh.nodeCount,
    bvhDepth: scene.bvh.maxDepth,
  }
  post(ready, [])
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

  for (let y = bandStart; y < bandEnd; y++) {
    const row = (y - bandStart) * width
    for (let x = 0; x < width; x++) {
      const jx = rng.next()
      const jy = rng.next()
      const u = (x + jx) / width
      const vScreen = 1 - (y + jy) / height // flip so +v is up
      const ray = camera.generateRay(u, vScreen, rng)
      const L = radiance(scene, ray, settings, rng, stats, gbuf)
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
      handlePass(msg.sampleIndex, msg.captureGBuffer)
      break
    case 'reset':
      break
  }
}
