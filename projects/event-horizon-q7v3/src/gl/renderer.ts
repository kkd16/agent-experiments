import { FRAG_SRC, VERT_SRC } from './shaders'
import type { Params } from '../types'
import { lookBasis, orbitPosition } from '../math/vec'

/** Thrown when WebGL2 or shader compilation is unavailable — the UI shows a friendly fallback. */
export class RendererError extends Error {}

const UNIFORM_NAMES = [
  'uResolution', 'uTime', 'uAspect', 'uTanHalfFov',
  'uCamPos', 'uCamRight', 'uCamUp', 'uCamForward',
  'uDiskInner', 'uDiskOuter', 'uDiskBrightness', 'uDiskTemp', 'uDiskDensity',
  'uSteps', 'uStepSize', 'uDoppler', 'uRedshift', 'uStarBrightness', 'uExposure',
] as const

type UniformName = (typeof UNIFORM_NAMES)[number]

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

export class BlackHoleRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private vao: WebGLVertexArrayObject
  private uniforms = {} as Record<UniformName, WebGLUniformLocation | null>

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: true, // so we can export a PNG of the current frame
      powerPreference: 'high-performance',
    })
    if (!gl) throw new RendererError('WebGL2 is not available in this browser.')
    this.gl = gl

    const vert = compile(gl, gl.VERTEX_SHADER, VERT_SRC)
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
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
    this.program = program

    const vao = gl.createVertexArray()
    if (!vao) throw new RendererError('Could not allocate a VAO.')
    this.vao = vao

    for (const name of UNIFORM_NAMES) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }
  }

  /** Render one frame. `width`/`height` are the drawing-buffer size in device pixels. */
  render(params: Params, timeSeconds: number, width: number, height: number): void {
    const gl = this.gl
    const canvas = gl.canvas as HTMLCanvasElement
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    const eye = orbitPosition(params.cameraDistance, params.inclination, params.azimuth)
    const { right, up, forward } = lookBasis(eye, [0, 0, 0])
    const tanHalfFov = Math.tan((params.fov * Math.PI) / 180 / 2)
    const aspect = width / Math.max(height, 1)

    const u = this.uniforms
    gl.uniform2f(u.uResolution, width, height)
    gl.uniform1f(u.uTime, timeSeconds)
    gl.uniform1f(u.uAspect, aspect)
    gl.uniform1f(u.uTanHalfFov, tanHalfFov)
    gl.uniform3f(u.uCamPos, eye[0], eye[1], eye[2])
    gl.uniform3f(u.uCamRight, right[0], right[1], right[2])
    gl.uniform3f(u.uCamUp, up[0], up[1], up[2])
    gl.uniform3f(u.uCamForward, forward[0], forward[1], forward[2])
    gl.uniform1f(u.uDiskInner, params.diskInner)
    gl.uniform1f(u.uDiskOuter, Math.max(params.diskOuter, params.diskInner + 0.5))
    gl.uniform1f(u.uDiskBrightness, params.diskBrightness)
    gl.uniform1f(u.uDiskTemp, params.diskTemperature)
    gl.uniform1f(u.uDiskDensity, params.diskDensity)
    gl.uniform1i(u.uSteps, Math.round(params.steps))
    gl.uniform1f(u.uStepSize, params.stepSize)
    gl.uniform1i(u.uDoppler, params.doppler ? 1 : 0)
    gl.uniform1i(u.uRedshift, params.redshift ? 1 : 0)
    gl.uniform1f(u.uStarBrightness, params.starBrightness)
    gl.uniform1f(u.uExposure, params.exposure)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.program)
    gl.deleteVertexArray(this.vao)
    const ext = gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }
}
