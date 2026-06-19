// The stateful renderer. It owns the framebuffer + mesh cache, turns a scene
// description into per-frame draw calls (building each object's model matrix from
// its animated transform) and runs the whole pipeline for one frame.
import type { Mesh, MeshKind } from '../geometry/mesh.ts'
import { buildMesh, computeTangents, makePlane } from '../geometry/mesh.ts'
import type { Mat4 } from '../math/mat4.ts'
import { multiply, rotationX, rotationY, rotationZ, scaling, translation } from '../math/mat4.ts'
import type { Vec3 } from '../math/vec.ts'
import { cross, normalize, sub } from '../math/vec.ts'
import { DEG2RAD } from '../math/scalar.ts'
import { makeEnvironment } from '../render/environment.ts'
import type { Environment } from '../render/environment.ts'
import { Framebuffer } from '../render/framebuffer.ts'
import { drawObject } from '../render/pipeline.ts'
import type { DrawObject } from '../render/pipeline.ts'
import { presentOverdraw } from '../render/raster.ts'
import { resolveHDR } from '../render/post.ts'
import type { PostSettings } from '../render/post.ts'
import type { Light, ShadeContext, ShadingModel } from '../render/shading.ts'
import { boundsOf, ShadowMap, transformedCenter } from '../render/shadow.ts'
import { makeNormalMap, makeTexture } from '../render/texture.ts'
import type { FrameStats, RenderMode } from '../render/types.ts'
import { OrbitCamera } from '../scene/camera.ts'
import type { SceneConfig } from '../scene/scene.ts'
import { lerp3 } from '../math/vec.ts'
import { clamp01 } from '../math/scalar.ts'
import { RayTracer } from '../raytrace/raytracer.ts'
import type { RTCamera, RTMode } from '../raytrace/raytracer.ts'
import type { RTInstance } from '../raytrace/rtscene.ts'
import type { RTLighting } from '../raytrace/tracer.ts'

export type Engine = 'raster' | 'rt'

export interface RTSettings {
  mode: RTMode // 'path' (global illumination) | 'ao' (ambient occlusion)
  maxBounces: number // path-tracer light-bounce depth
  softShadows: boolean // cone/area light sampling for penumbrae
  sunSoftness: number // directional-light cone half-angle, degrees
  lightRadius: number // point-light sphere radius (world units)
  aoRadius: number // ambient-occlusion reach (world units)
  resolutionScale: number // RT internal resolution relative to the framebuffer
  compare: boolean // split-screen: rasterizer left, path tracer right
  splitPos: number // divider position, 0..1
}

export interface RenderSettings {
  engine: Engine
  mode: RenderMode
  cullBack: boolean
  autoRotate: boolean
  showGround: boolean
  fog: boolean
  ambientBoost: number // 0.5..2 multiplier on ambient
  lightBoost: number // 0.3..2 multiplier on light intensities
  shadows: boolean
  shadingModel: ShadingModel
  environment: boolean // image-based lighting + skybox
  normalMaps: boolean // honour per-object normal maps
  post: PostSettings
  rt: RTSettings
}

const RT_BUDGET_MS = 26 // per-frame time the path tracer may spend refining
const DIVIDER = Framebuffer.pack(0.95, 0.95, 1)

const emptyStats = (): FrameStats => ({
  trianglesIn: 0,
  trianglesDrawn: 0,
  trianglesCulled: 0,
  trianglesClipped: 0,
  pixelsFilled: 0,
  rtSamples: 0,
  rtNodes: 0,
})

export class Renderer {
  fb: Framebuffer
  readonly camera = new OrbitCamera()
  private scene: SceneConfig
  private meshCache = new Map<MeshKind, Mesh>()
  private ground: Mesh
  private shadowMap = new ShadowMap(1024)
  private env: Environment
  private customMesh: Mesh | null = null
  private customMeshId = 0
  readonly rayTracer = new RayTracer()
  spinClock = 0

  constructor(width: number, height: number, scene: SceneConfig) {
    this.fb = new Framebuffer(width, height)
    this.scene = scene
    this.ground = makePlane(16, 8)
    computeTangents(this.ground)
    this.env = makeEnvironment(scene.sky)
    if (scene.view) this.camera.applyView(scene.view)
  }

  setScene(scene: SceneConfig): void {
    this.scene = scene
    this.env = makeEnvironment(scene.sky)
    if (scene.view) this.camera.applyView(scene.view)
  }

  // Install an imported OBJ mesh for the 'custom' scene.
  setCustomMesh(mesh: Mesh): void {
    this.customMesh = mesh
    this.customMeshId++
  }

  resize(width: number, height: number): void {
    if (width === this.fb.width && height === this.fb.height) return
    this.fb = new Framebuffer(width, height)
  }

  private mesh(kind: MeshKind): Mesh {
    if (kind === 'custom') return this.customMesh ?? this.mesh('sphere')
    let m = this.meshCache.get(kind)
    if (!m) {
      m = buildMesh(kind)
      this.meshCache.set(kind, m)
    }
    return m
  }

  triangleBudget(): number {
    // total source triangles across the scene (for the HUD before culling)
    let n = 0
    for (const o of this.scene.objects) n += this.mesh(o.meshKind).indices.length / 3
    if (this.scene.ground) n += this.ground.indices.length / 3
    return n
  }

  private scaledLights(s: RenderSettings): Light[] {
    if (s.lightBoost === 1) return this.scene.lights
    return this.scene.lights.map((l) => ({ ...l, intensity: l.intensity * s.lightBoost }))
  }

  // Dispatch to the rasterizer or the ray tracer. Animation only advances in
  // raster mode; the path tracer needs a still scene to accumulate against.
  render(dt: number, settings: RenderSettings): FrameStats {
    if (settings.engine === 'rt') return this.renderRT(settings)
    return this.renderRaster(dt, settings)
  }

  renderRaster(dt: number, settings: RenderSettings): FrameStats {
    const { fb, scene, camera } = this
    if (settings.autoRotate) this.spinClock += dt
    const t = this.spinClock

    const aspect = fb.width / fb.height
    const view = camera.view()
    const proj = camera.projection(aspect)
    const eye = camera.eye()

    // 'shaded' is the only HDR beauty pass; everything else packs straight to color
    const hdrMode = settings.mode === 'shaded'
    const useEnv = settings.environment
    fb.clear(scene.bgTop, scene.bgBottom, hdrMode)
    if (hdrMode && useEnv) {
      const dirOf = this.makeRayGenerator(eye, aspect)
      const env = this.env
      fb.fillSky(dirOf, (d) => {
        const c = env.sky(d)
        return [c[0] * env.intensity, c[1] * env.intensity, c[2] * env.intensity]
      })
    }

    const ambient: Vec3 = [
      scene.ambient[0] * settings.ambientBoost,
      scene.ambient[1] * settings.ambientBoost,
      scene.ambient[2] * settings.ambientBoost,
    ]
    const lights = this.scaledLights(settings)
    const shade: ShadeContext = {
      lights,
      ambient,
      eye,
      fogColor: scene.fogColor,
      fogDensity: settings.fog ? scene.fogDensity : 0,
      model: settings.shadingModel,
      environment: useEnv ? this.env : undefined,
    }

    // animated model matrices, computed once and reused by both passes
    const objectModels = scene.objects.map((o) =>
      this.objectModel(o.position, o.scale, o.baseRotation, o.spin * t, o.tiltSpin * t),
    )

    // ── shadow pass: render scene depth from the primary directional light ──
    if (settings.shadows && settings.mode === 'shaded') {
      const lightIndex = scene.lights.findIndex((l) => l.type === 'dir')
      const dirLight = lightIndex >= 0 ? scene.lights[lightIndex] : null
      if (dirLight && dirLight.type === 'dir') {
        const centers = objectModels.map(transformedCenter)
        const b = boundsOf(centers)
        const radius = Math.min(8, b.radius + 2.2)
        this.shadowMap.setLight(dirLight.direction, b.center, radius)
        this.shadowMap.clear()
        for (let i = 0; i < scene.objects.length; i++) {
          this.shadowMap.renderMesh(this.mesh(scene.objects[i].meshKind), objectModels[i])
        }
        const sm = this.shadowMap
        shade.shadow = { sample: (p, ndl) => sm.sample(p, ndl), lightIndex }
      }
    }

    const stats = emptyStats()
    const draws: DrawObject[] = []

    if (settings.showGround && scene.ground) {
      draws.push({
        mesh: this.ground,
        model: translation(0, 0, 0),
        uniforms: {
          mode: settings.mode,
          material: scene.groundMaterial,
          texture: makeTexture(scene.groundTexture),
          normalMap: settings.normalMaps ? makeNormalMap(scene.groundNormalMap) : null,
          shade,
          near: camera.near,
          far: camera.far,
          wasClipped: false,
        },
      })
    }

    for (let i = 0; i < scene.objects.length; i++) {
      const o = scene.objects[i]
      draws.push({
        mesh: this.mesh(o.meshKind),
        model: objectModels[i],
        uniforms: {
          mode: settings.mode,
          material: o.material,
          texture: makeTexture(o.texture),
          normalMap: settings.normalMaps ? makeNormalMap(o.normalMap) : null,
          shade,
          near: camera.near,
          far: camera.far,
          wasClipped: false,
        },
      })
    }

    for (const d of draws) drawObject(fb, view, proj, d, settings.cullBack, stats)

    if (settings.mode === 'overdraw') presentOverdraw(fb)
    else if (hdrMode) resolveHDR(fb, settings.post)

    return stats
  }

  // ── the ray-traced reference path ────────────────────────────────────────────
  // Flatten the live scene into a triangle soup, (re)build the BVH only when the
  // geometry changes, refine the progressive path-traced image for a frame's time
  // budget, then composite it — full-screen, or split against the rasterizer.
  renderRT(settings: RenderSettings): FrameStats {
    const { fb, scene, camera } = this
    const t = this.spinClock
    const aspect = fb.width / fb.height
    const eye = camera.eye()
    const cam = this.cameraSnapshot(eye, aspect)

    const objectModels = scene.objects.map((o) =>
      this.objectModel(o.position, o.scale, o.baseRotation, o.spin * t, o.tiltSpin * t),
    )
    const instances = this.buildRTInstances(objectModels, settings)
    const geomKey =
      `${scene.name}|${t.toFixed(4)}|${settings.showGround ? 1 : 0}|${settings.normalMaps ? 1 : 0}|${this.customMeshId}`
    this.rayTracer.setGeometry(instances, geomKey)

    const light = this.buildRTLighting(settings)
    const rt = settings.rt
    const e3 = `${eye[0].toFixed(3)},${eye[1].toFixed(3)},${eye[2].toFixed(3)}`
    const f3 = `${cam.fx.toFixed(3)},${cam.fy.toFixed(3)},${cam.fz.toFixed(3)}`
    const resetKey = [
      geomKey, e3, f3, rt.mode, rt.maxBounces, rt.softShadows ? 1 : 0,
      rt.sunSoftness, rt.lightRadius, rt.aoRadius, settings.environment ? 1 : 0,
      settings.lightBoost, settings.ambientBoost, settings.fog ? 1 : 0,
    ].join('|')

    const rtW = Math.max(16, Math.round(fb.width * rt.resolutionScale))
    const rtH = Math.max(16, Math.round(fb.height * rt.resolutionScale))
    this.rayTracer.step(cam, light, rt.mode, settings.post, rtW, rtH, RT_BUDGET_MS, resetKey)

    const stats = emptyStats()
    if (rt.compare) {
      // left half: the real-time rasterizer at the same (frozen) pose
      this.renderRaster(0, settings)
      const split = Math.round(clamp01(rt.splitPos) * fb.width)
      this.rayTracer.blit(fb.color, fb.width, fb.height, split, fb.width)
      // draw the divider
      const x = Math.min(fb.width - 1, Math.max(0, split))
      for (let y = 0; y < fb.height; y++) {
        fb.color[y * fb.width + x] = DIVIDER
        if (x + 1 < fb.width) fb.color[y * fb.width + x + 1] = DIVIDER
      }
    } else {
      this.rayTracer.blit(fb.color, fb.width, fb.height, 0, fb.width)
    }

    stats.trianglesIn = this.rayTracer.triangles
    stats.rtSamples = this.rayTracer.minSamples
    stats.rtNodes = this.rayTracer.nodes
    return stats
  }

  // The camera's orthonormal basis + view-ray scale, the data the tracer needs to
  // generate primary rays (matches makeRayGenerator).
  private cameraSnapshot(eye: Vec3, aspect: number): RTCamera {
    const { camera } = this
    const forward = normalize(sub(camera.target, eye))
    const right = normalize(cross(forward, [0, 1, 0]))
    const up = cross(right, forward)
    return {
      ex: eye[0], ey: eye[1], ez: eye[2],
      fx: forward[0], fy: forward[1], fz: forward[2],
      rx: right[0], ry: right[1], rz: right[2],
      ux: up[0], uy: up[1], uz: up[2],
      tanHalf: Math.tan((camera.fovDeg * DEG2RAD) / 2),
      aspect,
    }
  }

  private buildRTInstances(objectModels: Mat4[], settings: RenderSettings): RTInstance[] {
    const { scene } = this
    const insts: RTInstance[] = []
    if (settings.showGround && scene.ground) {
      insts.push({
        mesh: this.ground,
        model: translation(0, 0, 0),
        material: scene.groundMaterial,
        texture: makeTexture(scene.groundTexture),
        normalMap: settings.normalMaps ? makeNormalMap(scene.groundNormalMap) : null,
      })
    }
    for (let i = 0; i < scene.objects.length; i++) {
      const o = scene.objects[i]
      insts.push({
        mesh: this.mesh(o.meshKind),
        model: objectModels[i],
        material: o.material,
        texture: makeTexture(o.texture),
        normalMap: settings.normalMaps ? makeNormalMap(o.normalMap) : null,
      })
    }
    return insts
  }

  private buildRTLighting(settings: RenderSettings): RTLighting {
    const { scene } = this
    const ambient: Vec3 = [
      scene.ambient[0] * settings.ambientBoost,
      scene.ambient[1] * settings.ambientBoost,
      scene.ambient[2] * settings.ambientBoost,
    ]
    const env = settings.environment ? this.env : null
    const intensity = this.env.intensity
    const bgTop = scene.bgTop
    const bgBottom = scene.bgBottom
    const sky = (dx: number, dy: number, dz: number): Vec3 => {
      if (env) {
        const c = env.sky([dx, dy, dz])
        return [c[0] * intensity, c[1] * intensity, c[2] * intensity]
      }
      return lerp3(bgBottom, bgTop, clamp01(dy * 0.5 + 0.5))
    }
    const rt = settings.rt
    return {
      lights: this.scaledLights(settings),
      env,
      ambient,
      sky,
      maxBounces: rt.mode === 'ao' ? 1 : rt.maxBounces,
      sunCosHalf: rt.softShadows ? Math.cos(rt.sunSoftness * DEG2RAD) : 1,
      lightRadius: rt.softShadows ? rt.lightRadius : 0,
      aoRadius: rt.aoRadius > 0 ? rt.aoRadius : 1e30,
    }
  }

  // Build a per-pixel view-ray generator for the current camera, used to paint
  // the skybox directly into the HDR buffer.
  private makeRayGenerator(eye: Vec3, aspect: number): (x: number, y: number) => Vec3 {
    const { fb, camera } = this
    const forward = normalize(sub(camera.target, eye))
    const right = normalize(cross(forward, [0, 1, 0]))
    const up = cross(right, forward)
    const tanHalf = Math.tan((camera.fovDeg * DEG2RAD) / 2)
    const W = fb.width
    const H = fb.height
    return (x: number, y: number): Vec3 => {
      const ndcX = (2 * (x + 0.5)) / W - 1
      const ndcY = 1 - (2 * (y + 0.5)) / H
      const sx = ndcX * aspect * tanHalf
      const sy = ndcY * tanHalf
      return normalize([
        forward[0] + right[0] * sx + up[0] * sy,
        forward[1] + right[1] * sx + up[1] * sy,
        forward[2] + right[2] * sx + up[2] * sy,
      ])
    }
  }

  private objectModel(pos: Vec3, scale: number, base: Vec3, spinY: number, spinX: number): Mat4 {
    const baseRot = multiply(rotationY(base[1]), multiply(rotationX(base[0]), rotationZ(base[2])))
    const anim = multiply(rotationY(spinY), rotationX(spinX))
    let m = multiply(anim, multiply(baseRot, scaling(scale, scale, scale)))
    m = multiply(translation(pos[0], pos[1], pos[2]), m)
    return m
  }

  present(ctx: CanvasRenderingContext2D): void {
    this.fb.present(ctx)
  }
}
