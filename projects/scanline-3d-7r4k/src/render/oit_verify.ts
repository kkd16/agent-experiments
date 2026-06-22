// A numerical self-test of the v8 Weighted-Blended OIT core (McGuire & Bavoil 2013).
// It re-derives the compositing claims against the exact `oitWeight` / `blendWBOIT`
// the renderer uses: a single layer reproduces the classic "over" operator, the blend
// is genuinely *order-independent* (two interpenetrating layers composite identically
// whichever is drawn first — the whole point of the technique), a fully opaque layer
// hides the background, and the result stays energy-bounded. Pure math, no DOM.
import type { Vec3 } from '../math/vec.ts'
import { blendWBOIT, oitWeight } from './oit.ts'

export interface OITTest {
  name: string
  pass: boolean
  detail: string
}

interface Layer { z: number; a: number; c: Vec3 }

// Accumulate a set of glass layers exactly as Transparency.accumulate does, then blend
// over a background — the reference path the renderer's per-pixel resolve also takes.
function composite(layers: Layer[], bg: Vec3): Vec3 {
  let aR = 0, aG = 0, aB = 0, aA = 0, reveal = 1
  for (const l of layers) {
    const w = oitWeight(l.z, l.a)
    aR += l.c[0] * l.a * w; aG += l.c[1] * l.a * w; aB += l.c[2] * l.a * w
    aA += l.a * w
    reveal *= (1 - l.a)
  }
  const inv = aA > 1e-9 ? 1 / aA : 0
  const out: number[] = [0, 0, 0]
  blendWBOIT(aR * inv, aG * inv, aB * inv, reveal, bg[0], bg[1], bg[2], out)
  return [out[0], out[1], out[2]]
}

const d3 = (a: Vec3, b: Vec3): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))

export function runOITSelfTest(): OITTest[] {
  const tests: OITTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — a single layer reduces to the standard "over": C·a + B·(1−a), and is
  // independent of the depth weight (the weight cancels for one layer).
  {
    const C: Vec3 = [0.8, 0.2, 0.1], B: Vec3 = [0.1, 0.3, 0.9], a = 0.4
    const got = composite([{ z: 0.2, a, c: C }], B)
    const expect: Vec3 = [C[0] * a + B[0] * (1 - a), C[1] * a + B[1] * (1 - a), C[2] * a + B[2] * (1 - a)]
    const farWeight = composite([{ z: 0.95, a, c: C }], B) // different depth, same result
    const ok = d3(got, expect) < 1e-12 && d3(got, farWeight) < 1e-12
    add('Single layer = "over"', ok, `Δ=${d3(got, expect).toExponential(1)}, weight-independent (Δz: ${d3(got, farWeight).toExponential(1)})`)
  }

  // 2 — order independence: two interpenetrating layers composite identically whichever
  // order they are accumulated in (the defining property of WBOIT — no sorting needed).
  {
    const B: Vec3 = [0.2, 0.2, 0.2]
    const l1: Layer = { z: 0.3, a: 0.5, c: [0.9, 0.1, 0.1] }
    const l2: Layer = { z: 0.6, a: 0.7, c: [0.1, 0.1, 0.9] }
    const ab = composite([l1, l2], B)
    const ba = composite([l2, l1], B)
    add('Order independence', d3(ab, ba) < 1e-12, `|composite(1,2) − composite(2,1)| = ${d3(ab, ba).toExponential(1)}`)
  }

  // 3 — a fully opaque layer (α=1) hides the background entirely (reveal = 0 → out = C).
  {
    const C: Vec3 = [0.7, 0.5, 0.2], B: Vec3 = [0.9, 0.9, 0.9]
    const got = composite([{ z: 0.4, a: 1, c: C }], B)
    add('Opaque layer hides background', d3(got, C) < 1e-12, `out=[${got.map((x) => x.toFixed(2)).join(', ')}] = C (bg fully occluded)`)
  }

  // 4 — energy bound: with all colours and the background in [0,1], the composite of any
  // stack stays in [0,1] (the convex blend never creates or amplifies energy).
  {
    let maxV = 0, minV = 1
    const B: Vec3 = [0.5, 0.5, 0.5]
    for (let k = 0; k < 2000; k++) {
      const layers: Layer[] = []
      const n = 1 + (k % 4)
      for (let i = 0; i < n; i++) {
        const r = (Math.sin(k * 12.9 + i * 7.1) * 0.5 + 0.5)
        const g = (Math.sin(k * 3.3 + i * 1.7) * 0.5 + 0.5)
        const b = (Math.sin(k * 9.1 + i * 4.4) * 0.5 + 0.5)
        layers.push({ z: r * 2 - 1, a: g, c: [r, g, b] })
      }
      const o = composite(layers, B)
      for (let c = 0; c < 3; c++) { maxV = Math.max(maxV, o[c]); minV = Math.min(minV, o[c]) }
    }
    const ok = maxV <= 1 + 1e-9 && minV >= -1e-9
    add('Energy-bounded composite', ok, `over 2000 random stacks: out ∈ [${minV.toFixed(3)}, ${maxV.toFixed(3)}] ⊂ [0,1]`)
  }

  // 5 — the depth weight is a positive, bounded function of (z, α) only — never of draw
  // order — which is exactly what licenses the order independence above.
  {
    let okBound = true
    let maxW = 0, minW = Infinity
    for (let i = 0; i <= 40; i++) {
      const z = (i / 40) * 2 - 1
      const w = oitWeight(z, 1)
      if (w < 0.02 - 1e-9 || w > 30 + 1e-9) okBound = false
      maxW = Math.max(maxW, w); minW = Math.min(minW, w)
    }
    const nearer = oitWeight(-0.9, 1), farther = oitWeight(0.9, 1)
    const ok = okBound && nearer > farther // nearer fragments weigh more
    add('Depth weight bounded & monotone', ok, `w ∈ [${minW.toFixed(2)}, ${maxW.toFixed(2)}]⊂[0.02,30], near ${nearer.toFixed(2)} > far ${farther.toFixed(2)}`)
  }

  return tests
}
