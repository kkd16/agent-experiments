import { buildPaletteTexture, getPalette } from './palettes'
import { FRAG_SRC, VERT_SRC } from './shaders'
import type { FractalMode } from '../fractal/types'

// One immutable snapshot of everything the shader needs for a single frame.
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
}

// Split a JS double into the (hi, lo) float32 pair the df64 shader expects.
// hi + lo reproduces the double to ~48 bits, which is what caps the zoom depth.
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

const UNIFORM_NAMES = [
  'u_resolution',
  'u_cx',
  'u_cy',
  'u_scale',
  'u_maxIter',
  'u_mode',
  'u_jx',
  'u_jy',
  'u_palette',
  'u_colorScale',
  'u_colorOffset',
  'u_aa',
] as const

type UniformName = (typeof UNIFORM_NAMES)[number]

export class FractalRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private uniforms: Record<UniformName, WebGLUniformLocation | null>
  private paletteTex: WebGLTexture
  private vao: WebGLVertexArrayObject
  private paletteId = ''

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

    this.program = createProgram(gl, VERT_SRC, FRAG_SRC)
    gl.useProgram(this.program)

    this.uniforms = {} as Record<UniformName, WebGLUniformLocation | null>
    for (const name of UNIFORM_NAMES) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name)
    }

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

  resize(width: number, height: number) {
    this.gl.viewport(0, 0, width, height)
  }

  render(state: FrameState) {
    const gl = this.gl
    const canvas = gl.canvas as HTMLCanvasElement
    const u = this.uniforms

    this.setPalette(state.paletteId)

    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex)

    gl.uniform2f(u.u_resolution, canvas.width, canvas.height)
    gl.uniform2fv(u.u_cx, splitDouble(state.centerX))
    gl.uniform2fv(u.u_cy, splitDouble(state.centerY))
    gl.uniform2fv(u.u_scale, splitDouble(state.scale))
    gl.uniform1i(u.u_maxIter, Math.max(1, Math.round(state.maxIter)))
    gl.uniform1i(u.u_mode, state.mode === 'julia' ? 1 : 0)
    gl.uniform2fv(u.u_jx, splitDouble(state.juliaX))
    gl.uniform2fv(u.u_jy, splitDouble(state.juliaY))
    gl.uniform1i(u.u_palette, 0)
    gl.uniform1f(u.u_colorScale, state.colorScale)
    gl.uniform1f(u.u_colorOffset, state.colorOffset)
    gl.uniform1i(u.u_aa, Math.max(1, Math.min(3, Math.round(state.aa))))

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose() {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteTexture(this.paletteTex)
    gl.deleteVertexArray(this.vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
