import { FRAG_SRC, VERT_SRC, BRIGHT_SRC, BLUR_SRC, DOWNSAMPLE_SRC, COMPOSITE_SRC } from './shaders'
import type { Params } from '../types'
import { lookBasis, orbitPosition } from '../math/vec'
import { effectiveDiskInner } from '../state'

/** Thrown when WebGL2 or shader compilation is unavailable — the UI shows a friendly fallback. */
export class RendererError extends Error {}

const SCENE_UNIFORMS = [
  'uResolution', 'uTime', 'uAspect', 'uTanHalfFov',
  'uCamPos', 'uCamRight', 'uCamUp', 'uCamForward',
  'uSpin', 'uErgosphere',
  'uDiskInner', 'uDiskOuter', 'uDiskBrightness', 'uDiskTemp', 'uDiskDensity',
  'uSteps', 'uStepSize', 'uDoppler', 'uRedshift', 'uStarBrightness', 'uExposure', 'uToneMap',
] as const

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new RendererError('Could not allocate a shader.')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error'
    gl.deleteShader(shader)
    throw new RendererError(`Shader failed to compile: ${log}`)
  }
  return shader
}

function link(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc)
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc)
  const program = gl.createProgram()
  if (!program) throw new RendererError('Could not allocate the GL program.')
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown error'
    throw new RendererError(`Program failed to link: ${log}`)
  }
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  return program
}

function uniformMap(gl: WebGL2RenderingContext, program: WebGLProgram, names: readonly string[]) {
  const out: Record<string, WebGLUniformLocation | null> = {}
  for (const n of names) out[n] = gl.getUniformLocation(program, n)
  return out
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

export class BlackHoleRenderer {
  private gl: WebGL2RenderingContext
  private vao: WebGLVertexArrayObject

  private sceneProg: WebGLProgram
  private brightProg: WebGLProgram
  private blurProg: WebGLProgram
  private downProg: WebGLProgram
  private compProg: WebGLProgram

  private uScene: Record<string, WebGLUniformLocation | null>
  private uBright: Record<string, WebGLUniformLocation | null>
  private uBlur: Record<string, WebGLUniformLocation | null>
  private uDown: Record<string, WebGLUniformLocation | null>
  private uComp: Record<string, WebGLUniformLocation | null>

  /** Whether float render targets (and therefore the bloom pipeline) are available. */
  private bloomSupported: boolean

  private targets: {
    scene?: Target
    halfA?: Target
    halfB?: Target
    quarterA?: Target
    quarterB?: Target
  } = {}
  private allocW = 0
  private allocH = 0

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: true, // so we can export a PNG of the current frame
      powerPreference: 'high-performance',
    })
    if (!gl) throw new RendererError('WebGL2 is not available in this browser.')
    this.gl = gl

    // Float colour buffers power the HDR bloom; degrade gracefully if unavailable.
    this.bloomSupported = !!gl.getExtension('EXT_color_buffer_float')

    this.sceneProg = link(gl, VERT_SRC, FRAG_SRC)
    this.brightProg = link(gl, VERT_SRC, BRIGHT_SRC)
    this.blurProg = link(gl, VERT_SRC, BLUR_SRC)
    this.downProg = link(gl, VERT_SRC, DOWNSAMPLE_SRC)
    this.compProg = link(gl, VERT_SRC, COMPOSITE_SRC)

    this.uScene = uniformMap(gl, this.sceneProg, SCENE_UNIFORMS)
    this.uBright = uniformMap(gl, this.brightProg, ['uScene', 'uExposure', 'uThreshold'])
    this.uBlur = uniformMap(gl, this.blurProg, ['uTex', 'uDirection'])
    this.uDown = uniformMap(gl, this.downProg, ['uTex'])
    this.uComp = uniformMap(gl, this.compProg, ['uScene', 'uBloomHalf', 'uBloomQuarter', 'uExposure', 'uStrength'])

    const vao = gl.createVertexArray()
    if (!vao) throw new RendererError('Could not allocate a VAO.')
    this.vao = vao
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fbo, w, h }
  }

  private disposeTarget(t?: Target) {
    if (!t) return
    this.gl.deleteTexture(t.tex)
    this.gl.deleteFramebuffer(t.fbo)
  }

  private ensureTargets(w: number, h: number) {
    if (w === this.allocW && h === this.allocH && this.targets.scene) return
    const hw = Math.max(1, w >> 1)
    const hh = Math.max(1, h >> 1)
    const qw = Math.max(1, w >> 2)
    const qh = Math.max(1, h >> 2)
    for (const key of ['scene', 'halfA', 'halfB', 'quarterA', 'quarterB'] as const) {
      this.disposeTarget(this.targets[key])
    }
    this.targets = {
      scene: this.makeTarget(w, h),
      halfA: this.makeTarget(hw, hh),
      halfB: this.makeTarget(hw, hh),
      quarterA: this.makeTarget(qw, qh),
      quarterB: this.makeTarget(qw, qh),
    }
    this.allocW = w
    this.allocH = h
  }

  private drawTo(target: Target | null, w: number, h: number) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null)
    gl.viewport(0, 0, w, h)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private bindSampler(loc: WebGLUniformLocation | null, tex: WebGLTexture, unit: number) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (loc) gl.uniform1i(loc, unit)
  }

  private setSceneUniforms(params: Params, timeSeconds: number, width: number, height: number, toneMap: boolean) {
    const gl = this.gl
    const u = this.uScene

    const eye = orbitPosition(params.cameraDistance, params.inclination, params.azimuth)
    const { right, up, forward } = lookBasis(eye, [0, 0, 0])
    const tanHalfFov = Math.tan((params.fov * Math.PI) / 180 / 2)
    const aspect = width / Math.max(height, 1)
    const diskInner = effectiveDiskInner(params)

    gl.uniform2f(u.uResolution, width, height)
    gl.uniform1f(u.uTime, timeSeconds)
    gl.uniform1f(u.uAspect, aspect)
    gl.uniform1f(u.uTanHalfFov, tanHalfFov)
    gl.uniform3f(u.uCamPos, eye[0], eye[1], eye[2])
    gl.uniform3f(u.uCamRight, right[0], right[1], right[2])
    gl.uniform3f(u.uCamUp, up[0], up[1], up[2])
    gl.uniform3f(u.uCamForward, forward[0], forward[1], forward[2])
    gl.uniform1f(u.uSpin, params.spin)
    gl.uniform1i(u.uErgosphere, params.ergosphere ? 1 : 0)
    gl.uniform1f(u.uDiskInner, diskInner)
    gl.uniform1f(u.uDiskOuter, Math.max(params.diskOuter, diskInner + 0.5))
    gl.uniform1f(u.uDiskBrightness, params.diskBrightness)
    gl.uniform1f(u.uDiskTemp, params.diskTemperature)
    gl.uniform1f(u.uDiskDensity, params.diskDensity)
    gl.uniform1i(u.uSteps, Math.round(params.steps))
    gl.uniform1f(u.uStepSize, params.stepSize)
    gl.uniform1i(u.uDoppler, params.doppler ? 1 : 0)
    gl.uniform1i(u.uRedshift, params.redshift ? 1 : 0)
    gl.uniform1f(u.uStarBrightness, params.starBrightness)
    gl.uniform1f(u.uExposure, params.exposure)
    gl.uniform1i(u.uToneMap, toneMap ? 1 : 0)
  }

  /** Render one frame. `width`/`height` are the drawing-buffer size in device pixels. */
  render(params: Params, timeSeconds: number, width: number, height: number): void {
    const gl = this.gl
    const canvas = gl.canvas as HTMLCanvasElement
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.bindVertexArray(this.vao)

    const useBloom = this.bloomSupported && params.bloom && params.bloomStrength > 0.001

    // ---- fast path: no bloom → render the scene straight to the screen, tonemapped in-shader.
    if (!useBloom) {
      gl.useProgram(this.sceneProg)
      this.setSceneUniforms(params, timeSeconds, width, height, true)
      this.drawTo(null, width, height)
      return
    }

    // ---- HDR path: scene → float FBO, bloom chain, composite to screen.
    this.ensureTargets(width, height)
    const t = this.targets
    const scene = t.scene!
    const halfA = t.halfA!
    const halfB = t.halfB!
    const quarterA = t.quarterA!
    const quarterB = t.quarterB!

    // 1. scene (linear HDR, no tonemap) → scene target
    gl.useProgram(this.sceneProg)
    this.setSceneUniforms(params, timeSeconds, width, height, false)
    this.drawTo(scene, scene.w, scene.h)

    // 2. bright-pass + downsample to half res
    gl.useProgram(this.brightProg)
    this.bindSampler(this.uBright.uScene, scene.tex, 0)
    gl.uniform1f(this.uBright.uExposure, params.exposure)
    gl.uniform1f(this.uBright.uThreshold, params.bloomThreshold)
    this.drawTo(halfA, halfA.w, halfA.h)

    // 3. blur half res (H then V), ping-ponging halfA ↔ halfB
    gl.useProgram(this.blurProg)
    this.bindSampler(this.uBlur.uTex, halfA.tex, 0)
    gl.uniform2f(this.uBlur.uDirection, 1, 0)
    this.drawTo(halfB, halfB.w, halfB.h)
    this.bindSampler(this.uBlur.uTex, halfB.tex, 0)
    gl.uniform2f(this.uBlur.uDirection, 0, 1)
    this.drawTo(halfA, halfA.w, halfA.h) // blurred half-res bloom now in halfA

    // 4. downsample halfA → quarter, blur (H then V) for a wider second scale
    gl.useProgram(this.downProg)
    this.bindSampler(this.uDown.uTex, halfA.tex, 0)
    this.drawTo(quarterA, quarterA.w, quarterA.h)
    gl.useProgram(this.blurProg)
    this.bindSampler(this.uBlur.uTex, quarterA.tex, 0)
    gl.uniform2f(this.uBlur.uDirection, 1, 0)
    this.drawTo(quarterB, quarterB.w, quarterB.h)
    this.bindSampler(this.uBlur.uTex, quarterB.tex, 0)
    gl.uniform2f(this.uBlur.uDirection, 0, 1)
    this.drawTo(quarterA, quarterA.w, quarterA.h) // wide bloom now in quarterA

    // 5. composite scene + bloom → screen (exposure + ACES + gamma)
    gl.useProgram(this.compProg)
    this.bindSampler(this.uComp.uScene, scene.tex, 0)
    this.bindSampler(this.uComp.uBloomHalf, halfA.tex, 1)
    this.bindSampler(this.uComp.uBloomQuarter, quarterA.tex, 2)
    gl.uniform1f(this.uComp.uExposure, params.exposure)
    gl.uniform1f(this.uComp.uStrength, params.bloomStrength)
    this.drawTo(null, width, height)
  }

  dispose(): void {
    const gl = this.gl
    for (const key of ['scene', 'halfA', 'halfB', 'quarterA', 'quarterB'] as const) {
      this.disposeTarget(this.targets[key])
    }
    gl.deleteProgram(this.sceneProg)
    gl.deleteProgram(this.brightProg)
    gl.deleteProgram(this.blurProg)
    gl.deleteProgram(this.downProg)
    gl.deleteProgram(this.compProg)
    gl.deleteVertexArray(this.vao)
    const ext = gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }
}
