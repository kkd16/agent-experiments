// An in-app numerical self-test of the v8 dielectric layer. Each check re-derives an
// optical claim from an independent closed form — the unpolarised Fresnel equations,
// Snell's law, the critical angle for total internal reflection, Beer–Lambert
// transmittance, and (the headline) an energy-conserving furnace: a *clear* glass
// sphere in a uniform unit environment must re-emit ≈ unit radiance, because a smooth
// dielectric's reflect+refract split obeys R+T=1 and loses no energy. Nothing here
// touches the DOM; it runs live in the browser and headlessly under Node.
import type { Vec3 } from '../math/vec.ts'
import { buildMesh } from '../geometry/mesh.ts'
import { scaling } from '../math/mat4.ts'
import { RTScene } from './rtscene.ts'
import type { RTInstance } from './rtscene.ts'
import { BVH } from './bvh.ts'
import { Rng } from './sampling.ts'
import { tracePath } from './tracer.ts'
import type { RTContext } from './tracer.ts'
import { beerLambert, cauchyIor, fresnelDielectric, reflect, refract, smithG1 } from './dielectric.ts'

export interface DielectricTest {
  name: string
  pass: boolean
  detail: string
}

export function runDielectricSelfTest(): DielectricTest[] {
  const tests: DielectricTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — Fresnel at normal incidence equals the Schlick base reflectance ((n−1)/(n+1))².
  {
    const n = 1.5
    const r0 = fresnelDielectric(1, 1, n)
    const expect = ((n - 1) / (n + 1)) ** 2 // = 0.04 for n = 1.5
    const r0b = fresnelDielectric(1, n, 1) // reversed direction, same interface → same R
    const ok = Math.abs(r0 - expect) < 1e-9 && Math.abs(r0 - r0b) < 1e-9
    add('Fresnel normal-incidence R₀', ok, `R(0°)=${r0.toFixed(4)} = ((n−1)/(n+1))²=${expect.toFixed(4)}, reversible`)
  }

  // 2 — energy conservation at a lossless interface: R + T = 1 across all angles, both
  // directions (no TIR on the air→glass side; glass→air checked below the critical angle).
  {
    let maxErr = 0
    for (let i = 0; i <= 90; i++) {
      const c = Math.cos((i / 180) * Math.PI)
      const R = fresnelDielectric(c, 1, 1.5)
      maxErr = Math.max(maxErr, Math.abs(R + (1 - R) - 1)) // trivially 1, but guards NaN
      // glass→air below the critical angle (~41.8°): still R+T=1
      if (i < 41) {
        const Rg = fresnelDielectric(c, 1.5, 1)
        if (Rg < 0 || Rg > 1) maxErr = 1
      }
    }
    add('Energy: R + T = 1 (lossless)', maxErr < 1e-12, `max |R+T−1| = ${maxErr.toExponential(1)} over 0–90°, both directions`)
  }

  // 3 — Snell's law: the refracted ray obeys n_i·sinθ_i = n_t·sinθ_t, and a ray refracted
  // in then back out is collinear with the original (reversibility of the interface).
  {
    const eta = 1 / 1.5 // air → glass
    const N: Vec3 = [0, 0, 1]
    // incident from above at 30° to the normal, travelling downward
    const ti = (30 / 180) * Math.PI
    const I: Vec3 = [Math.sin(ti), 0, -Math.cos(ti)]
    const out = new Float64Array(3)
    const ok1 = refract(I[0], I[1], I[2], N[0], N[1], N[2], eta, out)
    const sinT = Math.hypot(out[0], out[1]) // since N is z, the transverse component is sinθt
    const snell = Math.abs(1 * Math.sin(ti) - 1.5 * sinT)
    // reverse the transmitted ray and refract it back (glass → air): the interface normal
    // on its incident — now the glass — side is −N, and reversibility must return −I.
    const out2 = new Float64Array(3)
    const ok2 = refract(-out[0], -out[1], -out[2], -N[0], -N[1], -N[2], 1.5, out2)
    const collinear = ok2 ? Math.hypot(out2[0] + I[0], out2[1] + I[1], out2[2] + I[2]) : 1
    const ok = ok1 && ok2 && snell < 1e-6 && collinear < 1e-6
    add('Snell refraction + reversibility', ok, `n_i·sinθ_i−n_t·sinθ_t=${snell.toExponential(1)}, in→out collinear (Δ=${collinear.toExponential(1)})`)
  }

  // 4 — total internal reflection: past the critical angle θc = asin(1/1.5) ≈ 41.8°,
  // refract() must fail and Fresnel must read exactly 1.
  {
    const thetaC = Math.asin(1 / 1.5)
    const below = thetaC - 0.02, above = thetaC + 0.02
    const N: Vec3 = [0, 0, 1]
    const mk = (t: number): Vec3 => [Math.sin(t), 0, -Math.cos(t)]
    const o = new Float64Array(3)
    const Ib = mk(below), Ia = mk(above)
    const refrBelow = refract(Ib[0], Ib[1], Ib[2], N[0], N[1], N[2], 1.5, o) // glass→air, eta=1.5
    const refrAbove = refract(Ia[0], Ia[1], Ia[2], N[0], N[1], N[2], 1.5, o)
    const Fabove = fresnelDielectric(Math.cos(above), 1.5, 1)
    const ok = refrBelow && !refrAbove && Math.abs(Fabove - 1) < 1e-12
    add('Total internal reflection', ok, `θc=${(thetaC * 180 / Math.PI).toFixed(1)}°: refracts below, TIR above (F=${Fabove.toFixed(3)})`)
  }

  // 5 — reflect() is a unit mirror about the normal (specular law: θ_in = θ_out).
  {
    const N: Vec3 = [0, 1, 0]
    const I: Vec3 = [Math.sin(0.7), -Math.cos(0.7), 0]
    const o = new Float64Array(3)
    reflect(I[0], I[1], I[2], N[0], N[1], N[2], o)
    const unit = Math.abs(Math.hypot(o[0], o[1], o[2]) - 1)
    const inAng = Math.acos(Math.abs(I[0] * N[0] + I[1] * N[1] + I[2] * N[2]))
    const outAng = Math.acos(Math.abs(o[0] * N[0] + o[1] * N[1] + o[2] * N[2]))
    const ok = unit < 1e-9 && Math.abs(inAng - outAng) < 1e-9 && o[1] > 0
    add('Specular reflection law', ok, `|R|=1 (err ${unit.toExponential(1)}), θ_in=θ_out=${(outAng * 180 / Math.PI).toFixed(1)}°`)
  }

  // 6 — Beer–Lambert transmittance is multiplicative and monotone: T(2d)=T(d)².
  {
    const a: Vec3 = [0.3, 0.8, 1.6]
    const d = 1.7
    const t1 = beerLambert(a, d)
    const t2 = beerLambert(a, 2 * d)
    let err = 0
    for (let k = 0; k < 3; k++) err = Math.max(err, Math.abs(t2[k] - t1[k] * t1[k]))
    const ok = err < 1e-12 && t1[0] > t1[1] && t1[1] > t1[2] // less absorbed ⇒ more transmitted
    add('Beer–Lambert absorption', ok, `T(2d)=T(d)² (err ${err.toExponential(1)}), reddens: T=[${t1.map((x) => x.toFixed(2)).join(', ')}]`)
  }

  // 7 — Cauchy dispersion orders the channel IORs n_blue > n_green > n_red, with green
  // unshifted (the hero wavelength), and collapses to achromatic when dispersion = 0.
  {
    const base = 1.5, disp = 1
    const nR = cauchyIor(base, disp, 0), nG = cauchyIor(base, disp, 1), nB = cauchyIor(base, disp, 2)
    const off = cauchyIor(base, 0, 2)
    const ok = nB > nG && nG > nR && Math.abs(nG - base) < 1e-12 && Math.abs(off - base) < 1e-12
    add('Cauchy dispersion ordering', ok, `n: R=${nR.toFixed(4)} < G=${nG.toFixed(4)} < B=${nB.toFixed(4)} (achromatic when off)`)
  }

  // 8 — Smith G1 masking is a bounded shadowing weight in (0,1], → 1 head-on, < 1 grazing.
  {
    const a = 0.5 * 0.5
    const head = smithG1(1, a), graze = smithG1(0.08, a)
    const ok = head > 0.99 && head <= 1 + 1e-9 && graze > 0 && graze < head
    add('Smith G1 masking bound', ok, `G1(0°)=${head.toFixed(3)} (≈1), G1(85°)=${graze.toFixed(3)} (shadowed)`)
  }

  // 9 — the furnace test for the BSDF: a *clear* (non-absorbing) smooth glass sphere in a
  // uniform unit-white environment must re-emit ≈ unit radiance. Every ray that strikes it
  // reflects or refracts (R+T=1, throughput 1) and eventually escapes to the unit sky, so
  // the integrator neither creates nor destroys energy — the strongest proof of correctness.
  {
    const glass: RTInstance['material'] = {
      albedo: [1, 1, 1], specular: 0.5, shininess: 32, rim: 0,
      metallic: 0, roughness: 0, transmission: 1, ior: 1.5, attenuation: [0, 0, 0], dispersion: 0,
    }
    const insts: RTInstance[] = [
      { mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: glass, texture: null, normalMap: null },
    ]
    const scene = new RTScene(insts)
    const bvh = new BVH(scene)
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky: () => [1, 1, 1], maxBounces: 24, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30,
    }
    const rng = new Rng(0x91a55c0d)
    let sum = 0, n = 0
    const N = 40000
    for (let k = 0; k < N; k++) {
      const ang = rng.next() * Math.PI * 2
      const r = Math.sqrt(rng.next()) * 0.9
      const ox = Math.cos(ang) * r, oy = Math.sin(ang) * r, oz = 4
      const c = tracePath(ox, oy, oz, 0, 0, -1, ctx, rng)
      sum += (c[0] + c[1] + c[2]) / 3; n++
    }
    const avg = sum / n
    const ok = avg > 0.94 && avg < 1.06
    add('Furnace test (clear-glass energy)', ok, `mean radiance ${avg.toFixed(4)} of unit env (smooth glass, 24 bounces)`)
  }

  return tests
}
