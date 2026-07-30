// WebGL2 plumbing. Owns the GL context, compiles the generated program(s) (only
// when the scene structure changes), uploads uniforms every frame, and runs the
// render loop. The scene itself lives in React; the renderer just reads the
// latest copy handed to it via setScene() and paints it.
//
// Two render paths share the same generated map()/shading code:
//   • direct   — a single pass straight to the canvas (the original renderer),
//                used as a guaranteed fallback and by the standalone export.
//   • accumulate — a progressive path-tracer-style loop: each frame folds one
//                jittered sample into a running average kept in a float ping-pong
//                target, then a tiny present pass tonemaps it to the canvas. This
//                is what makes depth-of-field, area-light soft shadows and
//                temporal anti-aliasing converge. It resets the instant the view
//                changes (see the per-frame view hash) so orbiting stays live.

import type { Scene, SdfNode } from '../scene/types'
import { TEXTURE_INDEX } from '../scene/primitives'
import { buildShader } from '../sdf/shader'
import { structuralKey } from '../sdf/codegen'
import { orbitPosition, sunDirection, worldToObjectMat3 } from './math'

export interface RendererCallbacks {
  onFps?: (fps: number) => void
  onError?: (message: string | null) => void
  /** Progressive-accumulation progress: current sample count, cap, and whether accumulating. */
  onSpp?: (sample: number, max: number, accumulating: boolean) => void
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
  private accumProgram: WebGLProgram | null = null
  private presentProgram: WebGLProgram | null = null
  private locsByProg = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>()
  private activeProg: WebGLProgram | null = null
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

  // Accumulation targets (ping-pong RGBA16F). Only allocated when float render
  // targets are available.
  private floatOk = false
  private tex: [WebGLTexture | null, WebGLTexture | null] = [null, null]
  private fbo: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null]
  private accumW = 0
  private accumH = 0
  private cur = 0 // index of the target we write next
  private lastTex: WebGLTexture | null = null
  private sample = 0
  private viewSig = Number.NaN
  private hashAccum = 0

  // Scratch uniform buffers, resized when the node count changes.
  private posArr = new Float32Array(3)
  private rotArr = new Float32Array(9)
  private scaleArr = new Float32Array(1)
  private paramArr = new Float32Array(4)
  private blendArr = new Float32Array(1)
  private matColArr = new Float32Array(3)
  private matPbrArr = new Float32Array(4)
  private modAArr = new Float32Array(4)
  private modBArr = new Float32Array(4)
  private matTexArr = new Float32Array(4)
  private rotTmp = new Float32Array(9)
  private rotScratch: [number, number, number] = [0, 0, 0]
  private eye: [number, number, number] = [0, 0, 0]
  private sun: [number, number, number] = [0, 1, 0]

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
    // Enable float color buffers so we can render into an RGBA16F accumulation
    // target; if unavailable we silently fall back to the direct path.
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float')
    if (this.floatOk) {
      try {
        const built = buildShader(scene)
        this.presentProgram = this.makeProgram(built.vertex, built.present)
      } catch {
        this.floatOk = false
        this.presentProgram = null
      }
    }
    this.rebuild(scene)
  }

  get generatedGlsl(): string {
    return this.glsl
  }

  /** Whether the progressive accumulation path is actually usable. */
  get accumulationAvailable(): boolean {
    return this.floatOk
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
    this.modAArr = new Float32Array(slots * 4)
    this.modBArr = new Float32Array(slots * 4)
    this.matTexArr = new Float32Array(slots * 4)
  }

  private makeProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl
    let vs: WebGLShader | null = null
    let fs: WebGLShader | null = null
    try {
      vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc)
      fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc)
      const prog = gl.createProgram()!
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed')
      }
      return prog
    } finally {
      if (vs) gl.deleteShader(vs)
      if (fs) gl.deleteShader(fs)
    }
  }

  private rebuild(scene: Scene): void {
    const gl = this.gl
    const built = buildShader(scene)
    try {
      const direct = this.makeProgram(built.vertex, built.fragment)
      let accum: WebGLProgram | null = null
      if (this.floatOk) {
        try {
          accum = this.makeProgram(built.vertex, built.fragmentAccum)
        } catch {
          // Accumulation shader failed to build for this scene — keep direct only.
          accum = null
        }
      }
      // Success: swap in the new program(s).
      if (this.program) gl.deleteProgram(this.program)
      if (this.accumProgram) gl.deleteProgram(this.accumProgram)
      this.program = direct
      this.accumProgram = accum
      this.structKey = structuralKey(scene)
      this.glsl = built.glsl
      this.ensureBuffers(built.slots)
      this.sample = 0
      this.viewSig = Number.NaN
      this.cb.onError?.(null)
    } catch (err) {
      // Keep the previous good program running; surface the error to the UI.
      this.cb.onError?.(err instanceof Error ? err.message : String(err))
    }
  }

  private loc(name: string): WebGLUniformLocation | null {
    const prog = this.activeProg
    if (!prog) return null
    let map = this.locsByProg.get(prog)
    if (!map) {
      map = new Map()
      this.locsByProg.set(prog, map)
    }
    if (map.has(name)) return map.get(name) ?? null
    const l = this.gl.getUniformLocation(prog, name)
    map.set(name, l)
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

  /** (Re)allocate the ping-pong float targets to match the render size. */
  private setupTargets(w: number, h: number): boolean {
    const gl = this.gl
    this.disposeTargets()
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        this.disposeTargets()
        this.floatOk = false
        return false
      }
      this.tex[i] = tex
      this.fbo[i] = fbo
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.accumW = w
    this.accumH = h
    this.cur = 0
    this.lastTex = null
    this.sample = 0
    return true
  }

  private disposeTargets(): void {
    const gl = this.gl
    for (let i = 0; i < 2; i++) {
      if (this.tex[i]) gl.deleteTexture(this.tex[i])
      if (this.fbo[i]) gl.deleteFramebuffer(this.fbo[i])
      this.tex[i] = null
      this.fbo[i] = null
    }
    this.accumW = 0
    this.accumH = 0
    this.lastTex = null
  }

  // --- per-frame math -------------------------------------------------------

  private hput(x: number): void {
    // Quantise to avoid float noise perpetually resetting the accumulation.
    const v = Math.round(x * 4096) | 0
    this.hashAccum = (Math.imul(this.hashAccum, 16777619) ^ v) | 0
  }

  /**
   * Advance the animation clock, fill the scratch uniform arrays for this frame,
   * and return a compact hash of everything that affects the converged image.
   * When the hash changes the accumulation must reset.
   */
  private computeFrame(dt: number): number {
    const s = this.scene
    const cam = s.camera
    if (cam.autoRotate) this.spin += cam.autoRotateSpeed * dt
    const azimuth = cam.azimuth + this.spin
    this.eye = orbitPosition(cam.target, cam.distance, azimuth, cam.elevation)
    this.sun = sunDirection(s.sun.azimuth, s.sun.elevation)

    const time = this.fpsAccum
    const animate = s.animate
    const n = s.nodes.length
    for (let i = 0; i < n; i++) {
      const node = s.nodes[i]
      const t = node.transform
      const live = animate && node.anim.enabled
      const a = node.anim

      let px = t.position[0]
      let py = t.position[1]
      let pz = t.position[2]
      let rx = t.rotation[0]
      let ry = t.rotation[1]
      let rz = t.rotation[2]
      let sc = t.scale
      if (live) {
        px += a.posAmp[0] * Math.sin(time * a.posSpeed[0])
        py += a.posAmp[1] * Math.sin(time * a.posSpeed[1])
        pz += a.posAmp[2] * Math.sin(time * a.posSpeed[2])
        rx += a.spin[0] * time
        ry += a.spin[1] * time
        rz += a.spin[2] * time
        sc *= 1 + a.scalePulse * Math.sin(time * a.scaleSpeed)
      }

      this.posArr[i * 3] = px
      this.posArr[i * 3 + 1] = py
      this.posArr[i * 3 + 2] = pz
      this.rotScratch[0] = rx
      this.rotScratch[1] = ry
      this.rotScratch[2] = rz
      worldToObjectMat3(this.rotScratch, this.rotTmp)
      this.rotArr.set(this.rotTmp, i * 9)
      this.scaleArr[i] = Math.max(sc, 1e-3)

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

      this.packModifier(node, i)

      this.matTexArr[i * 4] = TEXTURE_INDEX[node.material.texture] ?? 0
      this.matTexArr[i * 4 + 1] = node.material.texScale
      this.matTexArr[i * 4 + 2] = node.material.texStrength
      this.matTexArr[i * 4 + 3] = 0
    }

    // View hash: eye/target/fov/DoF, sun, environment, ground, quality, emissive,
    // AA, and every (animated) per-node value. Post is excluded — it only affects
    // the present pass, so tweaking exposure never discards the accumulation.
    this.hashAccum = 0
    const h = (x: number) => this.hput(x)
    h(this.eye[0]); h(this.eye[1]); h(this.eye[2])
    h(cam.target[0]); h(cam.target[1]); h(cam.target[2])
    h(cam.fov); h(cam.aperture); h(cam.focusDistance)
    h(this.sun[0]); h(this.sun[1]); h(this.sun[2])
    h(s.sun.color[0]); h(s.sun.color[1]); h(s.sun.color[2])
    h(s.sun.intensity); h(s.sun.angle)
    h(s.env.skyColor[0]); h(s.env.skyColor[1]); h(s.env.skyColor[2])
    h(s.env.horizonColor[0]); h(s.env.horizonColor[1]); h(s.env.horizonColor[2])
    h(s.env.groundColor[0]); h(s.env.groundColor[1]); h(s.env.groundColor[2])
    h(s.env.ambient); h(s.env.fogDensity)
    h(s.env.fogColor[0]); h(s.env.fogColor[1]); h(s.env.fogColor[2])
    h(s.env.emissive ? 1 : 0); h(s.env.emissiveStrength); h(s.env.emissiveShadows ? 1 : 0)
    h(s.ground.enabled ? 1 : 0); h(s.ground.height); h(s.ground.checker ? 1 : 0)
    h(s.ground.color1[0]); h(s.ground.color1[1]); h(s.ground.color1[2])
    h(s.ground.color2[0]); h(s.ground.color2[1]); h(s.ground.color2[2])
    h(s.quality.maxSteps); h(s.quality.maxDist); h(s.quality.surfaceEps)
    h(s.quality.shadowSoftness); h(s.quality.shadowStrength); h(s.quality.aoStrength)
    h(s.quality.reflections ? 1 : 0); h(s.quality.antialias ? 1 : 0)
    for (let i = 0; i < this.posArr.length; i++) h(this.posArr[i])
    for (let i = 0; i < this.rotArr.length; i++) h(this.rotArr[i])
    for (let i = 0; i < this.scaleArr.length; i++) h(this.scaleArr[i])
    for (let i = 0; i < this.paramArr.length; i++) h(this.paramArr[i])
    for (let i = 0; i < this.blendArr.length; i++) h(this.blendArr[i])
    for (let i = 0; i < this.matColArr.length; i++) h(this.matColArr[i])
    for (let i = 0; i < this.matPbrArr.length; i++) h(this.matPbrArr[i])
    for (let i = 0; i < this.modAArr.length; i++) h(this.modAArr[i])
    for (let i = 0; i < this.modBArr.length; i++) h(this.modBArr[i])
    for (let i = 0; i < this.matTexArr.length; i++) h(this.matTexArr[i])
    return this.hashAccum
  }

  /** Upload the raymarch uniforms (common to both direct and accum programs). */
  private uploadRaymarch(): void {
    const gl = this.gl
    const s = this.scene
    const cam = s.camera

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

    const rl = this.loc('uResolution')
    if (rl) gl.uniform2f(rl, this.canvas.width, this.canvas.height)
    u1f('uTime', this.fpsAccum)
    u3f('uCamPos', this.eye[0], this.eye[1], this.eye[2])
    u3f('uCamTarget', cam.target[0], cam.target[1], cam.target[2])
    u1f('uFov', cam.fov)
    u1f('uAperture', cam.aperture)
    u1f('uFocusDist', cam.focusDistance)

    u3f('uSunDir', this.sun[0], this.sun[1], this.sun[2])
    u3f('uSunColor', s.sun.color[0], s.sun.color[1], s.sun.color[2])
    u1f('uSunIntensity', s.sun.intensity)
    u1f('uSunAngle', s.sun.angle)

    u3f('uSkyColor', s.env.skyColor[0], s.env.skyColor[1], s.env.skyColor[2])
    u3f('uHorizonColor', s.env.horizonColor[0], s.env.horizonColor[1], s.env.horizonColor[2])
    u3f('uGroundColor', s.env.groundColor[0], s.env.groundColor[1], s.env.groundColor[2])
    u1f('uAmbient', s.env.ambient)
    u3f('uFogColor', s.env.fogColor[0], s.env.fogColor[1], s.env.fogColor[2])
    u1f('uFogDensity', s.env.fogDensity)
    u1i('uEmissive', s.env.emissive ? 1 : 0)
    u1f('uEmissiveStr', s.env.emissiveStrength)
    u1i('uEmisShadow', s.env.emissiveShadows ? 1 : 0)

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
    u1i('uAA', s.quality.antialias ? 2 : 1)

    u1f('uExposure', s.post.exposure)
    u1f('uGamma', s.post.gamma)
    u1f('uVignette', s.post.vignette)
    u1f('uSaturation', s.post.saturation)

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
    setV4('uModA', this.modAArr)
    setV4('uModB', this.modBArr)
    setV4('uMatTex', this.matTexArr)
  }

  /** Pack a node's domain modifier into the uModA/uModB vec4 slots. */
  private packModifier(node: SdfNode, i: number): void {
    const m = node.modifier
    let a0 = 0
    let a1 = 0
    let a2 = 0
    let a3 = 0
    switch (m.domain) {
      case 'repeat':
        a0 = m.repeat[0]
        a1 = m.repeat[1]
        a2 = m.repeat[2]
        a3 = m.repeatLimit
        break
      case 'mirror':
        a0 = m.mirror[0]
        a1 = m.mirror[1]
        a2 = m.mirror[2]
        break
      case 'twist':
        a0 = m.twist
        break
      case 'bend':
        a0 = m.bend
        break
      case 'elongate':
        a0 = m.elongate[0]
        a1 = m.elongate[1]
        a2 = m.elongate[2]
        break
      case 'polar':
        a0 = m.polar
        break
    }
    this.modAArr[i * 4] = a0
    this.modAArr[i * 4 + 1] = a1
    this.modAArr[i * 4 + 2] = a2
    this.modAArr[i * 4 + 3] = a3
    this.modBArr[i * 4] = m.round
    this.modBArr[i * 4 + 1] = m.shellOn ? m.shell : 0
    this.modBArr[i * 4 + 2] = 0
    this.modBArr[i * 4 + 3] = 0
  }

  /** Grab the current frame as a PNG data URL (preserveDrawingBuffer is on). */
  captureDataURL(): string {
    try {
      return this.canvas.toDataURL('image/png')
    } catch {
      return ''
    }
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
    const w = this.canvas.width
    const h = this.canvas.height

    const canAccum =
      this.floatOk && this.scene.render.accumulate && !!this.accumProgram && !!this.presentProgram

    if (!this.program) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      gl.clearColor(0.05, 0.05, 0.07, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.raf = requestAnimationFrame(this.frame)
      return
    }

    if (canAccum) {
      this.renderAccumulate(w, h, dt)
    } else {
      this.renderDirect(w, h, dt)
      this.cb.onSpp?.(0, 0, false)
    }

    this.raf = requestAnimationFrame(this.frame)
  }

  private renderDirect(w: number, h: number, dt: number): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    this.computeFrame(dt)
    this.activeProg = this.program
    gl.useProgram(this.program)
    this.uploadRaymarch()
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private renderAccumulate(w: number, h: number, dt: number): void {
    const gl = this.gl
    if (this.accumW !== w || this.accumH !== h) {
      if (!this.setupTargets(w, h)) {
        // Float targets failed after all — permanently fall back.
        this.renderDirect(w, h, dt)
        this.cb.onSpp?.(0, 0, false)
        return
      }
    }

    const sig = this.computeFrame(dt)
    if (sig !== this.viewSig) {
      this.viewSig = sig
      this.sample = 0
      this.cur = 0
      this.lastTex = null
    }

    const maxSamples = Math.max(1, Math.round(this.scene.render.maxSamples))
    if (this.sample < maxSamples) {
      const read = 1 - this.cur
      const write = this.cur
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[write])
      gl.viewport(0, 0, w, h)
      this.activeProg = this.accumProgram
      gl.useProgram(this.accumProgram)
      this.uploadRaymarch()
      const su = this.loc('uSample')
      if (su) gl.uniform1i(su, this.sample)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.tex[read])
      const pl = this.loc('uPrev')
      if (pl) gl.uniform1i(pl, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      this.lastTex = this.tex[write]
      this.sample += 1
      this.cur = read
    }

    // Present the accumulated average to the canvas.
    if (this.lastTex) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, w, h)
      this.activeProg = this.presentProgram
      gl.useProgram(this.presentProgram)
      const rl = this.loc('uResolution')
      if (rl) gl.uniform2f(rl, w, h)
      const p = this.scene.post
      const setf = (name: string, v: number) => {
        const l = this.loc(name)
        if (l) gl.uniform1f(l, v)
      }
      setf('uExposure', p.exposure)
      setf('uGamma', p.gamma)
      setf('uVignette', p.vignette)
      setf('uSaturation', p.saturation)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.lastTex)
      const al = this.loc('uAccum')
      if (al) gl.uniform1i(al, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    this.cb.onSpp?.(this.sample, maxSamples, true)
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
    const gl = this.gl
    if (this.program) gl.deleteProgram(this.program)
    if (this.accumProgram) gl.deleteProgram(this.accumProgram)
    if (this.presentProgram) gl.deleteProgram(this.presentProgram)
    this.program = null
    this.accumProgram = null
    this.presentProgram = null
    this.disposeTargets()
    this.activeProg = null
  }
}
