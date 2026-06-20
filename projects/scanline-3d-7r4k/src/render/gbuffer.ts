// The deferred G-buffer. The forward `shaded` pass, besides writing lit radiance to
// the HDR buffer, records the geometry + material + the pre-fog lighting
// decomposition for each pixel here. The screen-space passes (SSAO / SSR / contact
// shadows / TAA, all in render/ssfx.ts + render/taa.ts) then resolve the indirect
// terms by reading this buffer — exactly the raster→deferred split a modern GPU does,
// only here it is plain typed arrays.
//
// Layout (all parallel, indexed by pixel = y*W + x):
//   pos      Float32 ×3  world-space position
//   normal   Float32 ×3  world-space shading normal (after normal mapping)
//   albedo   Float32 ×3  base colour (after texture modulation)
//   direct   Float32 ×3  punctual-light radiance      (contact shadows darken this)
//   ambient  Float32 ×3  diffuse-IBL radiance         (SSAO darkens this)
//   spec     Float32 ×3  specular-IBL probe radiance  (SSR replaces this)
//   rough    Float32 ×1  perceptual roughness
//   metal    Float32 ×1  metallic
//   fog      Float32 ×1  fog blend factor 0..1 (indirect light reaches the eye ×(1-fog))
//   mask     Uint8   ×1  1 = geometry, 0 = background/sky
export class GBuffer {
  width = 0
  height = 0
  pos = new Float32Array(0)
  normal = new Float32Array(0)
  albedo = new Float32Array(0)
  direct = new Float32Array(0)
  ambient = new Float32Array(0)
  spec = new Float32Array(0)
  rough = new Float32Array(0)
  metal = new Float32Array(0)
  fog = new Float32Array(0)
  mask = new Uint8Array(0)

  // Grow the typed arrays to match the framebuffer; no-op when already sized.
  ensure(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    const n = width * height
    this.pos = new Float32Array(n * 3)
    this.normal = new Float32Array(n * 3)
    this.albedo = new Float32Array(n * 3)
    this.direct = new Float32Array(n * 3)
    this.ambient = new Float32Array(n * 3)
    this.spec = new Float32Array(n * 3)
    this.rough = new Float32Array(n)
    this.metal = new Float32Array(n)
    this.fog = new Float32Array(n)
    this.mask = new Uint8Array(n)
  }

  // Only the coverage mask needs clearing each frame; every covered pixel rewrites
  // the rest, and uncovered pixels are skipped by the screen-space passes.
  clear(): void {
    this.mask.fill(0)
  }
}
