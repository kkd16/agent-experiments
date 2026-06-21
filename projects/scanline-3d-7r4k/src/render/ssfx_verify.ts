// Numerical self-tests for the deferred screen-space passes. Each check re-derives a
// claim from an independent reference and runs headlessly (no DOM) so it can be a
// browser button *and* a CI-time harness. The renderer's render() never touches the
// canvas — only present() does — so we can drive whole frames here and inspect the
// raw buffers it produced.
import { Renderer } from '../engine/renderer.ts'
import type { RenderSettings } from '../engine/renderer.ts'
import { DEFAULT_POST } from './post.ts'
import { DEFAULT_SSFX } from './ssfx.ts'
import type { SSFXSettings } from './ssfx.ts'
import { DEFAULT_DENOISE } from '../raytrace/denoise.ts'
import { PRESETS } from '../scene/scene.ts'
import { multiply } from '../math/mat4.ts'

export interface SSFXTest {
  name: string
  pass: boolean
  detail: string
}

const baseSettings = (ssfx: Partial<SSFXSettings>): RenderSettings => ({
  engine: 'raster',
  mode: 'shaded',
  cullBack: false,
  autoRotate: false,
  showGround: true,
  fog: false,
  ambientBoost: 1,
  lightBoost: 1,
  shadows: true,
  shadingModel: 'pbr',
  environment: true,
  normalMaps: true,
  post: { ...DEFAULT_POST, bloom: false, fxaa: false, vignette: false },
  ssfx: { ...DEFAULT_SSFX, ssao: false, ssr: false, contactShadows: false, taa: false, ...ssfx },
  rt: {
    mode: 'path', maxBounces: 4, softShadows: true, sunSoftness: 1.5,
    lightRadius: 0.25, aoRadius: 1.5, resolutionScale: 0.5, compare: false, splitPos: 0.5,
    denoise: DEFAULT_DENOISE, view: 'denoised',
    medium: { enabled: false, preset: 'haze', density: 1, g: 0.55 },
  },
})

// Sum of LDR luminance over the colour buffer (a cheap "how bright is the frame").
function luminanceSum(color: Uint32Array): number {
  let s = 0
  for (let i = 0; i < color.length; i++) {
    const p = color[i]
    s += (p & 0xff) * 0.299 + ((p >> 8) & 0xff) * 0.587 + ((p >> 16) & 0xff) * 0.114
  }
  return s
}

function hdrHasNaN(hdr: Float32Array): boolean {
  for (let i = 0; i < hdr.length; i++) if (!Number.isFinite(hdr[i])) return true
  return false
}

export function runSSFXSelfTest(): SSFXTest[] {
  const tests: SSFXTest[] = []
  const W = 192
  const H = 144
  const ok = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // ── 1. G-buffer coverage ────────────────────────────────────────────────────
  {
    const r = new Renderer(W, H, PRESETS.showcase())
    r.render(0, baseSettings({ ssao: true }))
    let covered = 0
    for (let i = 0; i < r.gbuffer.mask.length; i++) covered += r.gbuffer.mask[i]
    const frac = covered / (W * H)
    ok('G-buffer coverage', frac > 0.2 && frac < 0.98, `${(frac * 100).toFixed(1)}% of pixels carry deferred geometry`)
  }

  // ── 2. G-buffer reprojection round-trips through the camera ──────────────────
  {
    const r = new Renderer(W, H, PRESETS.showcase())
    r.render(0, baseSettings({ ssao: true })) // taa off ⇒ unjittered projection
    const view = r.camera.view()
    const proj = r.camera.projection(W / H)
    const vp = multiply(proj, view)
    const { pos, mask } = r.gbuffer
    let checked = 0, hit = 0
    for (let y = 0; y < H; y += 3) {
      for (let x = 0; x < W; x += 3) {
        const i = y * W + x
        if (!mask[i]) continue
        const wx = pos[i * 3], wy = pos[i * 3 + 1], wz = pos[i * 3 + 2]
        const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15]
        if (cw <= 1e-6) continue
        const nx = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw
        const ny = (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw
        const px = Math.round((nx * 0.5 + 0.5) * W)
        const py = Math.round((1 - (ny * 0.5 + 0.5)) * H)
        checked++
        if (Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1) hit++
      }
    }
    const acc = checked > 0 ? hit / checked : 0
    ok('G-buffer reprojection', acc > 0.95, `${(acc * 100).toFixed(1)}% of stored positions reproject to their own pixel`)
  }

  // ── 3. SSAO darkens the scene (and only via occlusion) ──────────────────────
  {
    const rOff = new Renderer(W, H, PRESETS.showcase())
    rOff.render(0, baseSettings({}))
    const off = luminanceSum(rOff.fb.color)
    const rOn = new Renderer(W, H, PRESETS.showcase())
    rOn.render(0, baseSettings({ ssao: true }))
    const on = luminanceSum(rOn.fb.color)
    const darker = on < off
    // AO must lie in [0,1] and actually find some occlusion (not a no-op, not all-black)
    let mn = 2, mx = -1, occlSum = 0, n = 0
    for (let i = 0; i < rOn.gbuffer.mask.length; i++) {
      if (!rOn.gbuffer.mask[i]) continue
      const a = rOn.screenFX.ao[i]
      if (a < mn) mn = a
      if (a > mx) mx = a
      occlSum += 1 - a; n++
    }
    const meanOccl = n > 0 ? occlSum / n : 0
    const bounded = mn >= 0 && mx <= 1.0001 && meanOccl > 0.001 && meanOccl < 0.95
    ok('SSAO darkens & is bounded', darker && bounded,
      `frame ${((1 - on / off) * 100).toFixed(1)}% darker · mean occlusion ${(meanOccl * 100).toFixed(1)}% · ao∈[${mn.toFixed(2)},${mx.toFixed(2)}]`)
  }

  // ── 4. SSR finds on-screen reflections on the mirror scene ──────────────────
  {
    const r = new Renderer(W, H, PRESETS.reflections())
    r.render(0, baseSettings({ ssr: true }))
    let hits = 0, refl = 0
    for (let i = 0; i < r.gbuffer.mask.length; i++) {
      if (!r.gbuffer.mask[i]) continue
      if (r.screenFX.ssrConf[i] > 0.01) { hits++; refl += r.screenFX.ssrConf[i] }
    }
    const frac = hits / (W * H)
    ok('SSR finds reflections', hits > 50 && frac < 0.9,
      `${hits.toLocaleString()} pixels caught a screen reflection (avg confidence ${hits ? (refl / hits).toFixed(2) : '0'})`)
  }

  // ── 5. SSR is energy-aware: it changes the image but doesn't blow it up ─────
  {
    const off = new Renderer(W, H, PRESETS.reflections())
    off.render(0, baseSettings({}))
    const on = new Renderer(W, H, PRESETS.reflections())
    on.render(0, baseSettings({ ssr: true }))
    const lo = luminanceSum(off.fb.color)
    const hi = luminanceSum(on.fb.color)
    const ratio = hi / lo
    const changed = Math.abs(hi - lo) / lo > 0.002
    const sane = ratio > 0.5 && ratio < 2.5 // replaces the probe, never runs away
    ok('SSR is energy-aware', changed && sane, `reflections shift brightness ×${ratio.toFixed(3)} (replaces the IBL probe, no runaway)`)
  }

  // ── 6. TAA anti-aliases: the converged frame has far less high-frequency
  //       (staircase) energy than the single-sampled first frame ──────────────
  {
    const lum = (c: Uint32Array, i: number): number =>
      (c[i] & 0xff) * 0.299 + ((c[i] >> 8) & 0xff) * 0.587 + ((c[i] >> 16) & 0xff) * 0.114
    // discrete Laplacian magnitude — the signature of jagged single-sample edges
    const aliasEnergy = (c: Uint32Array): number => {
      let e = 0
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x
          e += Math.abs(4 * lum(c, i) - lum(c, i - 1) - lum(c, i + 1) - lum(c, i - W) - lum(c, i + W))
        }
      }
      return e
    }
    const r = new Renderer(W, H, PRESETS.showcase())
    const s = baseSettings({ taa: true })
    let first: Uint32Array | null = null
    let last = r.fb.color
    for (let f = 0; f < 16; f++) {
      r.render(0, s)
      const cur = r.fb.color.slice()
      if (f === 0) first = cur
      last = cur
    }
    const e0 = aliasEnergy(first!)
    const e1 = aliasEnergy(last)
    const drop = 1 - e1 / (e0 || 1)
    ok('TAA anti-aliases', e1 < e0 * 0.7, `converged frame carries ${(drop * 100).toFixed(0)}% less staircase energy than a single sample`)
  }

  // ── 7. NaN-free across every raster scene with all effects on ───────────────
  {
    const all = baseSettings({ ssao: true, ssr: true, contactShadows: true, taa: true })
    let clean = true
    const bad: string[] = []
    for (const key of Object.keys(PRESETS)) {
      const r = new Renderer(W, H, PRESETS[key]())
      r.render(0, all)
      if (hdrHasNaN(r.fb.hdr)) { clean = false; bad.push(key) }
    }
    ok('NaN-free across scenes', clean, clean ? `all ${Object.keys(PRESETS).length} scenes resolve with finite radiance` : `NaNs in: ${bad.join(', ')}`)
  }

  return tests
}
