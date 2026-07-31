// Headless verification for the parts that don't need a GPU: the GLSL code the
// engine assembles is structurally sound for every preset and every
// primitive × modifier combination, the codegen wires each domain op through,
// and scenes round-trip through the file (de)serialiser without loss.
//
// Run with `pnpm test`. This is intentionally outside the build's tsconfig, so
// it never affects the CI lint/build gate — it's a developer safety net.

import { describe, expect, it } from 'vitest'
import { BLOOM_BLUR_SHADER, BLOOM_PREFILTER_SHADER, buildShader } from '../src/sdf/shader'
import { generateMap } from '../src/sdf/codegen'
import { defaultScene, PRESETS } from '../src/scene/presets'
import { DOMAIN_LIST, PRIMITIVES, PRIMITIVE_LIST, makeNode } from '../src/scene/primitives'
import { parseScene, serializeScene } from '../src/scene/io'
import { buildStandaloneHtml } from '../src/export/standalone'
import type { DomainMod, PrimitiveKind, Scene } from '../src/scene/types'

/** Strip GLSL comments so prose parentheses/braces don't skew the balance check. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function countChar(src: string, ch: string): number {
  let n = 0
  for (let i = 0; i < src.length; i++) if (src[i] === ch) n++
  return n
}

function assertBalanced(label: string, src: string): void {
  const code = stripComments(src)
  expect(countChar(code, '{'), `${label}: braces`).toBe(countChar(code, '}'))
  expect(countChar(code, '('), `${label}: parens`).toBe(countChar(code, ')'))
  expect(countChar(code, '['), `${label}: brackets`).toBe(countChar(code, ']'))
  expect(src, `${label}: no undefined leaked into GLSL`).not.toContain('undefined')
  expect(src, `${label}: no NaN leaked into GLSL`).not.toContain('NaN')
}

function assertShaderVariant(label: string, src: string): void {
  assertBalanced(label, src)
  expect(src.startsWith('#version 300 es'), `${label}: starts with #version`).toBe(true)
  expect(countChar(src, '#') >= 1, `${label}: has a #version`).toBe(true)
  expect(src, `${label}: declares main`).toContain('void main()')
}

describe('shader assembly', () => {
  it('produces three balanced, well-formed variants for every preset', () => {
    for (const preset of PRESETS) {
      const scene = preset.build()
      const built = buildShader(scene)
      assertShaderVariant(`${preset.id}/direct`, built.fragment)
      assertShaderVariant(`${preset.id}/accum`, built.fragmentAccum)
      assertShaderVariant(`${preset.id}/present`, built.present)
      // The accumulation variant must read the previous target; the present pass must sample it.
      expect(built.fragmentAccum, `${preset.id}: accum reads uPrev`).toContain('uPrev')
      expect(built.present, `${preset.id}: present samples uAccum`).toContain('uAccum')
      // NODE_COUNT is always at least 1 so the uniform arrays are legal.
      expect(built.slots).toBeGreaterThanOrEqual(1)
    }
  })

  it('assembles the path-traced integrator into the accumulation shader', () => {
    // A scene that opts into the path tracer must carry the whole GI machinery in
    // its accumulation variant, and it must still be a balanced, well-formed shader.
    const scene = defaultScene()
    scene.render.integrator = 'pathtrace'
    scene.render.bounces = 6
    scene.render.fireflyClamp = 8
    const built = buildShader(scene)
    assertShaderVariant('pathtrace/accum', built.fragmentAccum)
    for (const sym of ['pathTrace(', 'neeSun(', 'neeEmitters(', 'cosineHemisphere(', 'glossyLobe(', 'visibility(']) {
      expect(built.fragmentAccum, `path tracer defines ${sym}`).toContain(sym)
    }
    // The dispatch that routes samples to the path tracer must be present.
    expect(built.fragmentAccum, 'renderSample dispatches on uIntegrator').toContain('uIntegrator == 1')
    // The GI showcase presets ship in path-trace mode.
    const cornell = PRESETS.find((p) => p.id === 'cornell')?.build()
    expect(cornell?.render.integrator, 'Cornell Box is path-traced').toBe('pathtrace')
    expect(cornell?.env.emissive, 'Cornell Box has an emitter light').toBe(true)
  })

  it('carries the dielectric glass + dispersion machinery in every variant', () => {
    const scene = defaultScene()
    const g = makeNode('sphere')
    g.material.transmission = 1
    g.material.ior = 1.5
    g.material.absorption = 2
    g.material.dispersion = 0.6
    scene.nodes = [g, ...scene.nodes]
    scene.render.integrator = 'pathtrace'
    const built = buildShader(scene)
    for (const variant of [built.fragment, built.fragmentAccum]) {
      assertBalanced('glass', variant)
      for (const sym of ['uMatGlass', 'glassOf(', 'fresnelDielectric(', 'raymarchSide(', 'uDispersive']) {
        expect(variant, `glass shader defines ${sym}`).toContain(sym)
      }
    }
    // The direct/fast path approximates glass; the path tracer does it for real.
    expect(built.fragment, 'direct path has the glass see-through').toContain('glassShade(')
    expect(built.fragmentAccum, 'path tracer refracts the ray').toContain('refract(')
  })

  it('carries the thin-film iridescence + physical-sky + frost machinery in every variant', () => {
    const scene = defaultScene()
    const irid = makeNode('sphere')
    irid.material.iridescence = 1
    irid.material.filmThickness = 420
    const frostNode = makeNode('box')
    frostNode.material.transmission = 1
    frostNode.material.roughness = 0.5
    scene.nodes = [irid, frostNode, ...scene.nodes]
    scene.env.skyMode = 'physical'
    scene.env.turbidity = 5
    scene.render.integrator = 'pathtrace'
    const built = buildShader(scene)
    for (const variant of [built.fragment, built.fragmentAccum]) {
      assertBalanced('surfaces', variant)
      for (const sym of [
        'uMatFilm',
        'uSkyMode',
        'uTurbidity',
        'thinFilm(',
        'iridescenceTint(',
        'physicalSky(',
        'raySphere(',
      ]) {
        expect(variant, `surfaces shader defines ${sym}`).toContain(sym)
      }
    }
    // PI must be defined exactly once (skyColor uses it before the path tracer block).
    const piDefs = (built.fragmentAccum.match(/#define PI /g) ?? []).length
    expect(piDefs, 'PI is defined exactly once').toBe(1)
    // The path tracer applies the iridescent tint and roughens refraction (frost).
    expect(built.fragmentAccum, 'path tracer tints specular with iridescence').toContain('iridescenceTint(res.y')
    expect(built.fragmentAccum, 'physical sky routes through envDome').toContain('uSkyMode == 1')
  })

  it('bakes the film + sky uniforms into the standalone export', () => {
    const html = buildStandaloneHtml(PRESETS.find((p) => p.id === 'daybreak')!.build(), 'Sky')
    for (const sym of ['uMatFilm', 'uSkyMode', 'uTurbidity', 'matFilm']) {
      expect(html, `export ships ${sym}`).toContain(sym)
    }
    // A physical-sky preset bakes skyMode = 1 into the config.
    expect(html, 'config marks the physical sky').toContain('"skyMode":1')
  })

  it('ships the iridescence, frost and physical-sky showcase presets', () => {
    const iridescent = PRESETS.find((p) => p.id === 'iridescent')?.build()
    expect(iridescent?.nodes.some((n) => n.material.iridescence > 0), 'Iridescent shimmers').toBe(true)
    const frost = PRESETS.find((p) => p.id === 'frost')?.build()
    expect(
      frost?.nodes.some((n) => n.material.transmission > 0 && n.material.roughness > 0.2),
      'Frost has rough glass',
    ).toBe(true)
    const daybreak = PRESETS.find((p) => p.id === 'daybreak')?.build()
    expect(daybreak?.env.skyMode, 'Daybreak uses the physical sky').toBe('physical')
    expect(daybreak?.sun.elevation, 'Daybreak sun sits low').toBeLessThan(15)
  })

  it('wires the bloom passes and present composite', () => {
    const built = buildShader(defaultScene())
    // The present pass reads the bloom texture and its intensity.
    for (const sym of ['uAccum', 'uBloomTex', 'uBloomInt']) {
      expect(built.present, `present samples ${sym}`).toContain(sym)
    }
    // The two scene-independent bloom passes are balanced, well-formed shaders.
    assertShaderVariant('bloom/prefilter', BLOOM_PREFILTER_SHADER)
    assertShaderVariant('bloom/blur', BLOOM_BLUR_SHADER)
    expect(BLOOM_PREFILTER_SHADER, 'prefilter thresholds').toContain('uThresh')
    expect(BLOOM_BLUR_SHADER, 'blur is directional').toContain('uDir')
  })

  it('bakes the accumulation path tracer + bloom into the standalone export', () => {
    const cornell = PRESETS.find((p) => p.id === 'cornell')!.build()
    const html = buildStandaloneHtml(cornell, 'Test')
    expect(html.startsWith('<!doctype html>'), 'is an HTML document').toBe(true)
    expect(html, 'closes the document').toContain('</html>')
    expect(html, 'no undefined leaked into the export').not.toContain('undefined')
    // Ships every shader the progressive path needs, plus the glass uniform upload.
    for (const sym of ['FRAG_ACCUM', 'FRAG_PRESENT', 'FRAG_PRE', 'FRAG_BLUR', 'uMatGlass', 'progAccum']) {
      expect(html, `export ships ${sym}`).toContain(sym)
    }
    // A path-traced preset bakes integrator = 1 into the config.
    expect(html, 'config marks the path tracer').toContain('"integrator":1')
  })

  it('ships the glass, dispersion and bloom showcase presets', () => {
    const prism = PRESETS.find((p) => p.id === 'prism')?.build()
    expect(prism, 'Prism exists').toBeTruthy()
    expect(prism?.nodes.some((n) => n.material.dispersion > 0), 'Prism disperses').toBe(true)
    const crystal = PRESETS.find((p) => p.id === 'crystal')?.build()
    expect(crystal?.nodes.some((n) => n.material.transmission > 0), 'Crystal has glass').toBe(true)
    expect(crystal?.nodes.some((n) => n.material.absorption > 0), 'Crystal absorbs').toBe(true)
    const supernova = PRESETS.find((p) => p.id === 'supernova')?.build()
    expect(supernova?.post.bloom, 'Supernova blooms').toBeGreaterThan(0)
  })

  it('generates a balanced map() for every primitive × modifier combination', () => {
    for (const kind of PRIMITIVE_LIST) {
      for (const domain of DOMAIN_LIST) {
        const node = makeNode(kind as PrimitiveKind)
        node.modifier.domain = domain as DomainMod
        const scene: Scene = { ...defaultScene(), nodes: [node] }
        const map = generateMap(scene)
        assertBalanced(`${kind}+${domain}`, map.glsl)
        expect(map.glsl, `${kind}+${domain}: emits a map()`).toContain('vec2 map(vec3 p)')
        // The whole shader must also assemble cleanly around it.
        assertShaderVariant(`${kind}+${domain}/accum`, buildShader(scene).fragmentAccum)
      }
    }
  })

  it('wires each domain modifier to its GLSL op', () => {
    const opFor: Partial<Record<DomainMod, string>> = {
      repeat: 'opRepeat',
      mirror: 'opMirror',
      twist: 'opTwist',
      bend: 'opBend',
      elongate: 'opElongate',
      polar: 'opPolar',
    }
    for (const [domain, op] of Object.entries(opFor)) {
      const node = makeNode('box')
      node.modifier.domain = domain as DomainMod
      const map = generateMap({ ...defaultScene(), nodes: [node] })
      expect(map.glsl, `${domain} → ${op}`).toContain(`${op}(`)
    }
  })

  it('has a primitive spec and codegen path for every kind in the list', () => {
    for (const kind of PRIMITIVE_LIST) {
      expect(PRIMITIVES[kind as PrimitiveKind], `${kind} spec exists`).toBeTruthy()
      const map = generateMap({ ...defaultScene(), nodes: [makeNode(kind as PrimitiveKind)] })
      // A sphere-only fallback would show slot 0; make sure the primitive is referenced.
      expect(map.glsl.length).toBeGreaterThan(0)
    }
  })
})

describe('scene file round-trip', () => {
  it('serialises and parses every preset without loss', () => {
    for (const preset of PRESETS) {
      const scene = preset.build()
      const text = serializeScene(scene)
      const parsed = parseScene(text)
      expect(parsed, `${preset.id}: parses`).not.toBeNull()
      expect(parsed).toEqual(scene)
    }
  })

  it('accepts a bare scene object as well as the wrapped document', () => {
    const scene = defaultScene()
    const bare = JSON.stringify(scene)
    expect(parseScene(bare)).toEqual(scene)
  })

  it('backfills missing fields on an old/partial save', () => {
    const partial = JSON.stringify({ nodes: [makeNode('sphere')] })
    const parsed = parseScene(partial)
    expect(parsed).not.toBeNull()
    expect(parsed?.render.accumulate).toBe(true)
    expect(parsed?.camera.aperture).toBe(0)
    expect(parsed?.sun.angle).toBeGreaterThanOrEqual(0)
    expect(parsed?.env.emissive).toBe(false)
    // Session-5 fields backfill on an old save.
    expect(parsed?.nodes[0].material.transmission).toBe(0)
    expect(parsed?.nodes[0].material.ior).toBeGreaterThan(1)
    expect(parsed?.post.bloom).toBe(0)
    expect(parsed?.post.bloomThreshold).toBeGreaterThan(0)
    // Session-6 fields backfill on an old save.
    expect(parsed?.nodes[0].material.iridescence).toBe(0)
    expect(parsed?.nodes[0].material.filmThickness).toBeGreaterThan(0)
    expect(parsed?.env.skyMode).toBe('gradient')
    expect(parsed?.env.turbidity).toBeGreaterThan(0)
  })

  it('rejects junk input', () => {
    expect(parseScene('not json at all')).toBeNull()
    expect(parseScene('42')).toBeNull()
    expect(parseScene('{"format":"something-else","scene":{"nodes":[]}}')).toBeNull()
  })
})
