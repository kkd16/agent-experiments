// Scene → GLSL. This turns the ordered node list into a `map(vec3)` function that
// returns vec2(distance, materialId). Per-node numeric values are *not* baked into
// the source — they arrive as uniform arrays (uPos/uRot/uScale/uParam/uBlend), so
// dragging a slider only updates a uniform and never triggers a shader recompile.
// A recompile is only needed when the scene *structure* changes (a node's kind,
// its combine op, whether it is smooth or visible, the node count, or the ground
// toggle). `structuralKey` captures exactly that.

import type { PrimitiveKind, Scene, SdfNode } from '../scene/types'

const GROUND_ID = '-1.0'

function primitiveExpr(kind: PrimitiveKind, i: number): string {
  const p = `uParam[${i}]`
  switch (kind) {
    case 'sphere':
      return `sdSphere(pl, ${p}.x)`
    case 'box':
      return `sdBox(pl, ${p}.xyz)`
    case 'roundBox':
      return `sdRoundBox(pl, ${p}.xyz, ${p}.w)`
    case 'torus':
      return `sdTorus(pl, ${p}.x, ${p}.y)`
    case 'capsule':
      return `sdCapsule(pl, ${p}.x, ${p}.y)`
    case 'cylinder':
      return `sdCylinder(pl, ${p}.x, ${p}.y)`
    case 'cone':
      return `sdCone(pl, ${p}.x, ${p}.y)`
    case 'octahedron':
      return `sdOctahedron(pl, ${p}.x)`
    case 'plane':
      return `sdPlane(pl)`
    case 'ellipsoid':
      return `sdEllipsoid(pl, ${p}.xyz)`
    case 'hexPrism':
      return `sdHexPrism(pl, vec2(${p}.x, ${p}.y))`
    case 'pyramid':
      return `sdPyramid(pl, ${p}.x)`
    case 'link':
      return `sdLink(pl, ${p}.x, ${p}.y, ${p}.z)`
    case 'roundCone':
      return `sdRoundCone(pl, ${p}.x, ${p}.y, ${p}.z)`
  }
}

/** Domain warp emitted before the primitive is evaluated (operates on `pl`). */
function domainLines(node: SdfNode, i: number): string[] {
  const a = `uModA[${i}]`
  switch (node.modifier.domain) {
    case 'repeat':
      return [`  pl = opRepeat(pl, ${a}.xyz, ${a}.w);`]
    case 'mirror':
      return [`  pl = opMirror(pl, ${a}.xyz);`]
    case 'twist':
      return [`  pl = opTwist(pl, ${a}.x);`]
    case 'bend':
      return [`  pl = opBend(pl, ${a}.x);`]
    case 'elongate':
      return [`  pl = opElongate(pl, ${a}.xyz);`]
    case 'polar':
      return [`  pl = opPolar(pl, ${a}.x);`]
    default:
      return []
  }
}

function foldExpr(node: SdfNode, i: number): string {
  const rhs = `vec2(d, ${i}.0)`
  const { op, smooth } = node.combine
  const k = `uBlend[${i}]`
  if (op === 'union') return smooth ? `opSmoothUnion(acc, ${rhs}, ${k})` : `opUnion(acc, ${rhs})`
  if (op === 'subtract')
    return smooth ? `opSmoothSubtract(acc, ${rhs}, ${k})` : `opSubtract(acc, ${rhs})`
  return smooth ? `opSmoothIntersect(acc, ${rhs}, ${k})` : `opIntersect(acc, ${rhs})`
}

export interface GeneratedMap {
  glsl: string
  /** Number of uniform-array slots the shader must declare (>= 1). */
  slots: number
}

export function generateMap(scene: Scene): GeneratedMap {
  const lines: string[] = []
  lines.push('vec2 map(vec3 p){')
  lines.push('  vec3 pl;')
  lines.push('  float d;')
  lines.push('  vec2 acc = vec2(uFar, -2.0);')
  lines.push('  bool started = false;')

  scene.nodes.forEach((node, i) => {
    if (!node.visible) return
    const mod = node.modifier
    const twistBend = mod.domain === 'twist' || mod.domain === 'bend'
    lines.push(`  // ${node.name}`)
    lines.push(`  pl = uRot[${i}] * (p - uPos[${i}]);`)
    lines.push(`  pl /= uScale[${i}];`)
    for (const l of domainLines(node, i)) lines.push(l)
    lines.push(`  d = ${primitiveExpr(node.kind, i)};`)
    // Post-distance shaping: round every edge, then optionally hollow to a shell.
    lines.push(`  d -= uModB[${i}].x;`)
    if (mod.shellOn) lines.push(`  d = abs(d) - uModB[${i}].y;`)
    // Twist/bend break the metric; shrink the step to keep sphere-tracing safe.
    lines.push(`  d *= ${twistBend ? '0.6 * ' : ''}uScale[${i}];`)
    lines.push(`  if (!started){ acc = vec2(d, ${i}.0); started = true; }`)
    lines.push(`  else acc = ${foldExpr(node, i)};`)
  })

  if (scene.ground.enabled) {
    lines.push(`  { vec2 g = vec2(p.y - uGroundH, ${GROUND_ID});`)
    lines.push('    acc = started ? opUnion(acc, g) : g; started = true; }')
  }

  lines.push('  return acc;')
  lines.push('}')
  return { glsl: lines.join('\n'), slots: Math.max(scene.nodes.length, 1) }
}

/**
 * A compact signature of everything that requires a shader recompile. Two scenes
 * with the same key can share a compiled program and differ only by uniforms.
 */
export function structuralKey(scene: Scene): string {
  const parts = scene.nodes.map(
    (n) =>
      `${n.visible ? 1 : 0}${n.kind}:${n.combine.op}${n.combine.smooth ? 's' : 'h'}` +
      `:${n.modifier.domain}${n.modifier.shellOn ? 'S' : ''}`,
  )
  parts.push(`g${scene.ground.enabled ? 1 : 0}`)
  parts.push(`n${scene.nodes.length}`)
  return parts.join('|')
}
