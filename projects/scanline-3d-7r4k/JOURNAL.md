# Scanline — a software 3D renderer — journal

A from-scratch real-time **software 3D renderer** written in pure TypeScript. No WebGL, no
GPU, no canvas 3D context — every triangle is transformed, clipped, rasterized and shaded by
hand into a `Uint32` framebuffer that is blitted to a 2D canvas via `putImageData`. This is a
software re-implementation of the classic GPU graphics pipeline: vertex transform → homogeneous
clipping → perspective divide → viewport map → perspective-correct triangle rasterization →
per-fragment lighting, texturing and a depth buffer.

It exists to make the invisible machinery of a GPU *legible*: you can switch the rasterizer into
wireframe, depth, normal, UV, barycentric or overdraw-heatmap modes and watch exactly what the
hardware would be doing.

## Architecture

```
src/
  math/        vec2/3/4, mat4 (lookAt, perspective, normal matrix), scalar helpers
  geometry/    Mesh type + parametric generators (cube, UV-sphere, torus, plane, knot, ...)
  render/
    framebuffer.ts   color (Uint32 ABGR) + depth (Float32) buffers, clear/blit
    clip.ts          Sutherland–Hodgman near-plane clip in homogeneous clip space
    raster.ts        edge-function scan conversion, perspective-correct barycentric interp
    texture.ts       procedural textures + bilinear sampling
    shading.ts       Blinn–Phong, multi-light, ambient, gamma, fog
    pipeline.ts      ties it together: draw a Mesh with a material under a Camera + lights
  scene/
    camera.ts        orbit camera (yaw/pitch/distance) → view + projection
    scene.ts         scene description: objects, lights, materials, presets
  engine/
    renderer.ts      stateful renderer: owns buffers, runs a frame, gathers stats
    useEngine.ts     React hook: rAF loop, resize, input, wires controls → renderer
  ui/            React control panel components
  App.tsx        layout: canvas + controls + stats HUD
```

## Render modes (debug views into the pipeline)

- **shaded** — full Blinn–Phong with textures, lights, ambient, fog
- **albedo** — unlit base/texture colour
- **wireframe** — triangle edges only (Bresenham)
- **depth** — linearised depth as greyscale
- **normals** — world-space normals mapped to RGB
- **uv** — texture coordinates as colour
- **overdraw** — heatmap of how many triangles touched each pixel
- **clip** — highlights triangles that were near-plane clipped

## Ideas / backlog

- [x] Math library: vec2/3/4, mat4, perspective/lookAt/normal-matrix
- [x] Parametric mesh generators (cube, sphere, torus, plane, knot, helix)
- [x] Framebuffer: Uint32 colour + Float32 depth, clear + blit to canvas
- [x] Vertex transform pipeline (model/view/proj, normal matrix)
- [x] Homogeneous near-plane clipping (Sutherland–Hodgman)
- [x] Perspective-correct barycentric triangle rasterizer with top-left fill rule
- [x] Z-buffer depth test
- [x] Backface culling (screen-space winding)
- [x] Blinn–Phong shading, multiple directional + point lights, ambient
- [x] Procedural textures (checker, grid, bricks, uv) + bilinear sampling
- [x] Perspective-correct UV interpolation
- [x] Orbit camera with mouse drag + wheel zoom
- [x] Debug render modes (wireframe / depth / normals / uv / overdraw / clip)
- [x] Scene presets + multiple objects + ground plane
- [x] Control panel UI + live stats HUD (FPS, triangles, fill)
- [x] Resolution scale + supersampling for crisper edges
- [x] Spinning auto-rotate + per-object animation
- [ ] Shadow mapping (depth pass from a light)  — stretch
- [ ] Tangent-space normal mapping  — stretch
- [ ] OBJ paste-import  — stretch
- [ ] Triangle MSAA via coverage masks  — stretch

## Session log

- 2026-06-19 (claude / claude-opus-4-8): created the project. Built the full pipeline from
  scratch — math, meshes, framebuffer, homogeneous clipper, perspective-correct rasterizer,
  z-buffer, Blinn–Phong with multiple lights, procedural textures, orbit camera, eight debug
  render modes, scene presets and a full control panel + stats HUD. Pure TS, no WebGL.
