// WebGL2 plumbing. Owns the GL context, compiles the generated program (only when
// the scene structure changes), uploads uniforms every frame, and runs the render
// loop. The scene itself lives in React; the renderer just reads the latest copy
// handed to it via setScene() and paints it.

import type { Scene } from '../scene/types'
import { buildShader } from '../sdf/shader'
import { structuralKey } from '../sdf/codegen'
import { orbitPosition, sunDirection, worldToObjectMat3 } from './math'

export interface RendererCallbacks {
  onFps?: (fps: number) => void
  onError?: (message: string | null) => void
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? 'unknown shader error'
    gl.deleteShader(sh)
    throw new Error(log)
  }
  return sh
}

export class Renderer {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement
  private program: WebGLProgram | null = null
  private locs = new Map<string, WebGLUniformLocation | null>()
  private scene: Scene
  private structKey = ''
  private glsl = ''
  private running = false
  private raf = 0
  private spin = 0
  private lastT = 0
  private frames = 0
  private fpsAccum = 0
  private cb: RendererCallbacks

  // Scratch uniform buffers, resized when the node count changes.
  private posArr = new Float32Array(3)
  private rotArr = new Float32Array(9)
  private scaleArr = new Float32Array(1)
  private paramArr = new Float32Array(4)
  private blendArr = new Float32Array(1)
  private matColArr = new Float32Array(3)
  private matPbrArr = new Float32Array(4)
  private rotTmp = new Float32Array(9)

  constructor(canvas: HTMLCanvasElement, scene: Scene, cb: RendererCallbacks = {}) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL2 is not available in this browser.')
    this.gl = gl
    this.canvas = canvas
    this.scene = scene
    this.cb = cb
    this.rebuild(scene)
  }

  get generatedGlsl(): string {
    return this.glsl
  }

  setScene(scene: Scene): void {
    this.scene = scene
    const key = structuralKey(scene)
    if (key !== this.structKey) this.rebuild(scene)
  }

  private ensureBuffers(slots: number): void {
    if (this.posArr.length === slots * 3) return
    this.posArr = new Float32Array(slots * 3)
    this.rotArr = new Float32Array(slots * 9)
    this.scaleArr = new Float32Array(slots)
    this.paramArr = new Float32Array(slots * 4)
    this.blendArr = new Float32Array(slots)
    this.matColArr = new Float32Array(slots * 3)
    this.matPbrArr = new Float32Array(slots * 4)
  }

  private rebuild(scene: Scene): void {
    const gl = this.gl
    const built = buildShader(scene)
    let vs: WebGLShader | null = null
    let fs: WebGLShader | null = null
    try {
      vs = compileShader(gl, gl.VERTEX_SHADER, built.vertex)
      fs = compileShader(gl, gl.FRAGMENT_SHADER, built.fragment)
      const prog = gl.createProgram()!
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed')
      }
      // Success: swap in the new program.
      if (this.program) gl.deleteProgram(this.program)
      this.program = prog
      this.locs.clear()
      this.structKey = structuralKey(scene)
      this.glsl = built.glsl
      this.ensureBuffers(built.slots)
      this.cb.onError?.(null)
    } catch (err) {
      // Keep the previous good program running; surface the error to the UI.
      this.cb.onError?.(err instanceof Error ? err.message : String(err))
    } finally {
      if (vs) gl.deleteShader(vs)
      if (fs) gl.deleteShader(fs)
    }
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (this.locs.has(name)) return this.locs.get(name) ?? null
    const l = this.program ? this.gl.getUniformLocation(this.program, name) : null
    this.locs.set(name, l)
    return l
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const scale = this.scene.quality.resolutionScale
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr * scale))
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr * scale))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  private uploadUniforms(dt: number): void {
    const gl = this.gl
    const s = this.scene
    const cam = s.camera

    if (cam.autoRotate) this.spin += cam.autoRotateSpeed * dt
    const azimuth = cam.azimuth + this.spin
    const eye = orbitPosition(cam.target, cam.distance, azimuth, cam.elevation)
    const sun = sunDirection(s.sun.azimuth, s.sun.elevation)

    const u1f = (n: string, v: number) => {
      const l = this.loc(n)
      if (l) gl.uniform1f(l, v)
    }
    const u1i = (n: string, v: number) => {
      const l = this.loc(n)
      if (l) gl.uniform1i(l, v)
    }
    const u3f = (n: string, a: number, b: number, c: number) => {
      const l = this.loc(n)
      if (l) gl.uniform3f(l, a, b, c)
    }

    gl.uniform2f(this.loc('uResolution')!, this.canvas.width, this.canvas.height)
    u1f('uTime', this.fpsAccum)
    u3f('uCamPos', eye[0], eye[1], eye[2])
    u3f('uCamTarget', cam.target[0], cam.target[1], cam.target[2])
    u1f('uFov', cam.fov)

    u3f('uSunDir', sun[0], sun[1], sun[2])
    u3f('uSunColor', s.sun.color[0], s.sun.color[1], s.sun.color[2])
    u1f('uSunIntensity', s.sun.intensity)

    u3f('uSkyColor', s.env.skyColor[0], s.env.skyColor[1], s.env.skyColor[2])
    u3f('uHorizonColor', s.env.horizonColor[0], s.env.horizonColor[1], s.env.horizonColor[2])
    u3f('uGroundColor', s.env.groundColor[0], s.env.groundColor[1], s.env.groundColor[2])
    u1f('uAmbient', s.env.ambient)
    u3f('uFogColor', s.env.fogColor[0], s.env.fogColor[1], s.env.fogColor[2])
    u1f('uFogDensity', s.env.fogDensity)

    u1f('uGroundH', s.ground.height)
    u1i('uCheck', s.ground.checker ? 1 : 0)
    u3f('uGroundCol1', s.ground.color1[0], s.ground.color1[1], s.ground.color1[2])
    u3f('uGroundCol2', s.ground.color2[0], s.ground.color2[1], s.ground.color2[2])

    u1i('uMaxSteps', Math.round(s.quality.maxSteps))
    u1f('uMaxDist', s.quality.maxDist)
    u1f('uEps', s.quality.surfaceEps)
    u1f('uFar', s.quality.maxDist)
    u1f('uShadowSoft', s.quality.shadowSoftness)
    u1f('uShadowStr', s.quality.shadowStrength)
    u1f('uAoStr', s.quality.aoStrength)
    u1i('uReflect', s.quality.reflections ? 1 : 0)

    u1f('uExposure', s.post.exposure)
    u1f('uGamma', s.post.gamma)
    u1f('uVignette', s.post.vignette)
    u1f('uSaturation', s.post.saturation)

    // Per-node arrays.
    const n = s.nodes.length
    for (let i = 0; i < n; i++) {
      const node = s.nodes[i]
      this.posArr[i * 3] = node.transform.position[0]
      this.posArr[i * 3 + 1] = node.transform.position[1]
      this.posArr[i * 3 + 2] = node.transform.position[2]
      worldToObjectMat3(node.transform.rotation, this.rotTmp)
      this.rotArr.set(this.rotTmp, i * 9)
      this.scaleArr[i] = Math.max(node.transform.scale, 1e-3)
      this.paramArr[i * 4] = node.params[0] ?? 0
      this.paramArr[i * 4 + 1] = node.params[1] ?? 0
      this.paramArr[i * 4 + 2] = node.params[2] ?? 0
      this.paramArr[i * 4 + 3] = node.params[3] ?? 0
      this.blendArr[i] = node.combine.radius
      this.matColArr[i * 3] = node.material.color[0]
      this.matColArr[i * 3 + 1] = node.material.color[1]
      this.matColArr[i * 3 + 2] = node.material.color[2]
      this.matPbrArr[i * 4] = node.material.metallic
      this.matPbrArr[i * 4 + 1] = node.material.roughness
      this.matPbrArr[i * 4 + 2] = node.material.reflectivity
      this.matPbrArr[i * 4 + 3] = node.material.emission
    }
    const setV3 = (name: string, arr: Float32Array) => {
      const l = this.loc(name)
      if (l) gl.uniform3fv(l, arr)
    }
    const set1 = (name: string, arr: Float32Array) => {
      const l = this.loc(name)
      if (l) gl.uniform1fv(l, arr)
    }
    const setV4 = (name: string, arr: Float32Array) => {
      const l = this.loc(name)
      if (l) gl.uniform4fv(l, arr)
    }
    setV3('uPos', this.posArr)
    const lr = this.loc('uRot')
    if (lr) gl.uniformMatrix3fv(lr, false, this.rotArr)
    set1('uScale', this.scaleArr)
    setV4('uParam', this.paramArr)
    set1('uBlend', this.blendArr)
    setV3('uMatColor', this.matColArr)
    setV4('uMatPBR', this.matPbrArr)
  }

  private frame = (t: number): void => {
    if (!this.running) return
    const dt = this.lastT ? Math.min((t - this.lastT) / 1000, 0.05) : 0.016
    this.lastT = t
    this.fpsAccum += dt

    // FPS reporting roughly twice a second.
    this.frames += 1
    if (this.fpsAccum - this.lastFpsReport > 0.5) {
      const fps = this.frames / (this.fpsAccum - this.lastFpsReport)
      this.cb.onFps?.(fps)
      this.frames = 0
      this.lastFpsReport = this.fpsAccum
    }

    this.resize()
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    if (this.program) {
      gl.useProgram(this.program)
      this.uploadUniforms(dt)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    } else {
      gl.clearColor(0.05, 0.05, 0.07, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    this.raf = requestAnimationFrame(this.frame)
  }

  private lastFpsReport = 0

  start(): void {
    if (this.running) return
    this.running = true
    this.lastT = 0
    this.raf = requestAnimationFrame(this.frame)
  }

  dispose(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    if (this.program) this.gl.deleteProgram(this.program)
    this.program = null
    this.locs.clear()
  }
}
