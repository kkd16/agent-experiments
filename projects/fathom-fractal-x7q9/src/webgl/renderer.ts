import { buildPaletteTexture, getPalette } from './palettes'
import { FRAG_PERTURB_SRC, FRAG_SRC, VERT_SRC } from './shaders'
import type { FractalMode } from '../fractal/types'

// One immutable snapshot of everything the shaders need for a single frame.
export type FrameState = {
  centerX: number
  centerY: number
  scale: number // world units per backing-store pixel
  maxIter: number
  mode: FractalMode
  juliaX: number
  juliaY: number
  colorScale: number
  colorOffset: number
  aa: number
  paletteId: string
  de: boolean
  deStrength: number
  colorMode: number // 0 smooth, 1 stripe, 2 trap-point, 3 trap-cross
  featureFreq: number // stripe density / orbit-trap scale
  interior: boolean // paint the interior instead of flat black
  relief: boolean // normal-map relief lighting
  lightAngle: number // light azimuth, radians
  lightHeight: number // light elevation
  perturbation: boolean // use the reference-orbit deep engine
  orbitLen: number // highest valid reference index (perturbation mode)
}

// Split a JS double into the (hi, lo) float32 pair the df64 shader expects.
function splitDouble(x: number): [number, number] {
  const hi = Math.fround(x)
  const lo = Math.fround(x - hi)
  return [hi, lo]
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Failed to allocate shader')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error'
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc)
  const program = gl.createProgram()
  if (!program) throw new Error('Failed to allocate program')
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown error'
    gl.deleteProgram(program)
    throw new Error(`Program link failed: ${log}`)
  }
  return program
}

// Query every active uniform of a program into a name -> location map.
function uniformMap(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): Record<string, WebGLUniformLocation | null> {
  const map: Record<string, WebGLUniformLocation | null> = {}
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)
    if (!info) continue
    const name = info.name.replace(/\[0\]$/, '')
    map[name] = gl.getUniformLocation(program, name)
  }
  return map
}

const ORBIT_TEX_WIDTH = 2048 // reference orbit packed as a 2D RG32F texture

export class FractalRenderer {
  private gl: WebGL2RenderingContext
  private direct: WebGLProgram
  private directU: Record<string, WebGLUniformLocation | null>
  private perturb: WebGLProgram | null = null
  private perturbU: Record<string, WebGLUniformLocation | null> = {}
  private paletteTex: WebGLTexture
  private orbitTex: WebGLTexture | null = null
  private vao: WebGLVertexArrayObject
  private paletteId = ''

  /** Whether the deep perturbation engine compiled successfully on this GPU. */
  readonly perturbationAvailable: boolean

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    })
    if (!gl) throw new Error('WebGL2 is not available in this browser.')
    this.gl = gl

    this.direct = createProgram(gl, VERT_SRC, FRAG_SRC)
    this.directU = uniformMap(gl, this.direct)

    // The deep engine is a best-effort upgrade: if it fails to compile on this
    // driver (or float textures aren't sampleable), we simply fall back to the
    // df64 engine and clamp zoom to its precision floor.
    let perturbOk: boolean
    try {
      this.perturb = createProgram(gl, VERT_SRC, FRAG_PERTURB_SRC)
      this.perturbU = uniformMap(gl, this.perturb)
      this.orbitTex = gl.createTexture()
      perturbOk = this.orbitTex !== null
    } catch {
      this.perturb = null
      this.orbitTex = null
      perturbOk = false
    }
    this.perturbationAvailable = perturbOk

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('Failed to allocate vertex array')
    this.vao = vao

    const tex = gl.createTexture()
    if (!tex) throw new Error('Failed to allocate palette texture')
    this.paletteTex = tex
    this.setPalette('nebula')
  }

  private setPalette(id: string) {
    if (id === this.paletteId) return
    const gl = this.gl
    const data = buildPaletteTexture(getPalette(id))
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.paletteId = id
  }

  /** Upload a fresh reference orbit (Z_n) for the perturbation engine. */
  setReferenceOrbit(xs: Float32Array, ys: Float32Array, length: number) {
    const gl = this.gl
    if (!this.orbitTex) return
    const count = length + 1
    const w = ORBIT_TEX_WIDTH
    const h = Math.max(1, Math.ceil(count / w))
    const data = new Float32Array(w * h * 2)
    for (let i = 0; i < count; i++) {
      data[i * 2] = xs[i]
      data[i * 2 + 1] = ys[i]
    }
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.orbitTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  resize(width: number, height: number) {
    this.gl.viewport(0, 0, width, height)
  }

  render(state: FrameState) {
    const gl = this.gl
    const canvas = gl.canvas as HTMLCanvasElement
    this.setPalette(state.paletteId)

    const usePerturb = state.perturbation && this.perturb !== null
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex)

    const aa = Math.max(1, Math.min(3, Math.round(state.aa)))
    const maxIter = Math.max(1, Math.round(state.maxIter))

    if (usePerturb) {
      const u = this.perturbU
      gl.useProgram(this.perturb)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.orbitTex)
      gl.uniform2f(u.u_resolution, canvas.width, canvas.height)
      gl.uniform1f(u.u_pixelScale, state.scale)
      gl.uniform1i(u.u_maxIter, maxIter)
      gl.uniform1i(u.u_orbitLen, Math.max(1, state.orbitLen))
      gl.uniform1i(u.u_orbit, 1)
      gl.uniform1i(u.u_aa, aa)
      gl.uniform1i(u.u_palette, 0)
      gl.uniform1f(u.u_colorScale, state.colorScale)
      gl.uniform1f(u.u_colorOffset, state.colorOffset)
      gl.uniform1i(u.u_de, state.de ? 1 : 0)
      gl.uniform1f(u.u_deStrength, state.deStrength)
      gl.uniform1i(u.u_colorMode, state.colorMode)
      gl.uniform1f(u.u_featureFreq, state.featureFreq)
      gl.uniform1i(u.u_interior, state.interior ? 1 : 0)
      gl.uniform1i(u.u_relief, state.relief ? 1 : 0)
      gl.uniform1f(u.u_lightAngle, state.lightAngle)
      gl.uniform1f(u.u_lightHeight, state.lightHeight)
    } else {
      const u = this.directU
      gl.useProgram(this.direct)
      gl.uniform2f(u.u_resolution, canvas.width, canvas.height)
      gl.uniform2fv(u.u_cx, splitDouble(state.centerX))
      gl.uniform2fv(u.u_cy, splitDouble(state.centerY))
      gl.uniform2fv(u.u_scale, splitDouble(state.scale))
      gl.uniform1i(u.u_maxIter, maxIter)
      gl.uniform1i(u.u_mode, state.mode === 'julia' ? 1 : 0)
      gl.uniform2fv(u.u_jx, splitDouble(state.juliaX))
      gl.uniform2fv(u.u_jy, splitDouble(state.juliaY))
      gl.uniform1i(u.u_aa, aa)
      gl.uniform1i(u.u_palette, 0)
      gl.uniform1f(u.u_colorScale, state.colorScale)
      gl.uniform1f(u.u_colorOffset, state.colorOffset)
      gl.uniform1i(u.u_de, state.de ? 1 : 0)
      gl.uniform1f(u.u_deStrength, state.deStrength)
      gl.uniform1i(u.u_colorMode, state.colorMode)
      gl.uniform1f(u.u_featureFreq, state.featureFreq)
      gl.uniform1i(u.u_interior, state.interior ? 1 : 0)
      gl.uniform1i(u.u_relief, state.relief ? 1 : 0)
      gl.uniform1f(u.u_lightAngle, state.lightAngle)
      gl.uniform1f(u.u_lightHeight, state.lightHeight)
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose() {
    const gl = this.gl
    gl.deleteProgram(this.direct)
    if (this.perturb) gl.deleteProgram(this.perturb)
    gl.deleteTexture(this.paletteTex)
    if (this.orbitTex) gl.deleteTexture(this.orbitTex)
    gl.deleteVertexArray(this.vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
