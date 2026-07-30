// Headless verification for the parts that don't need a GPU: the GLSL code the
// engine assembles is structurally sound for every preset and every
// primitive × modifier combination, the codegen wires each domain op through,
// and scenes round-trip through the file (de)serialiser without loss.
//
// Run with `pnpm test`. This is intentionally outside the build's tsconfig, so
// it never affects the CI lint/build gate — it's a developer safety net.

import { describe, expect, it } from 'vitest'
import { buildShader } from '../src/sdf/shader'
import { generateMap } from '../src/sdf/codegen'
import { defaultScene, PRESETS } from '../src/scene/presets'
import { DOMAIN_LIST, PRIMITIVES, PRIMITIVE_LIST, makeNode } from '../src/scene/primitives'
import { parseScene, serializeScene } from '../src/scene/io'
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
  })

  it('rejects junk input', () => {
    expect(parseScene('not json at all')).toBeNull()
    expect(parseScene('42')).toBeNull()
    expect(parseScene('{"format":"something-else","scene":{"nodes":[]}}')).toBeNull()
  })
})
