// GLSL sources for the fractal renderer.
//
// Fathom renders with two different fragment shaders, picked per frame by zoom:
//
//   * FRAG_SRC       — the direct engine. Iterates the escape-time formula in
//                      *emulated double precision* (df64: every coordinate is a
//                      vec2(hi, lo) pair, ~48 bits). Good to a zoom of ~1e13,
//                      entirely on the GPU. Used at shallow/medium depth and for
//                      Julia sets.
//   * FRAG_PERTURB_SRC — the deep engine. Uses *perturbation theory*: a single
//                      high-precision reference orbit (uploaded as a texture)
//                      plus a per-pixel delta iterated in plain float32, with
//                      Zhuoran rebasing to stay glitch-free. This lifts the zoom
//                      floor from ~1e13 to ~1e30+, far past what any per-pixel
//                      float scheme can reach, because the deep digits live in
//                      how the reference was derived, not in the shader's floats.
//
// Both support optional distance-estimation (DE) shading, which outlines the
// set's filaments by dividing |z| by the escape derivative |dz/dc|.

// A fullscreen triangle drawn with no vertex buffers (gl_VertexID trick).
export const VERT_SRC = `#version 300 es
precision highp float;
const vec2 verts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() {
  gl_Position = vec4(verts[gl_VertexID], 0.0, 1.0);
}`

// Emulated double-precision (df64) primitives. A double is a vec2(hi, lo) where
// the true value is hi + lo and |lo| <= 0.5 ulp(hi). These are the classic
// Dekker/Knuth error-free transformations, transcribed to GLSL. They rely on
// IEEE round-to-nearest float32 and must NOT be reassociated by the compiler —
// stable on every desktop driver we target.
const DF64 = `
vec2 ds_set(float a) { return vec2(a, 0.0); }

vec2 ds_add(vec2 a, vec2 b) {
  float t1 = a.x + b.x;
  float e = t1 - a.x;
  float t2 = ((b.x - e) + (a.x - (t1 - e))) + a.y + b.y;
  float hi = t1 + t2;
  float lo = t2 - (hi - t1);
  return vec2(hi, lo);
}

vec2 ds_neg(vec2 a) { return vec2(-a.x, -a.y); }
vec2 ds_sub(vec2 a, vec2 b) { return ds_add(a, ds_neg(b)); }

vec2 ds_mul(vec2 a, vec2 b) {
  float split = 4097.0; // 2^12 + 1, the float32 Dekker splitting constant
  float cona = a.x * split;
  float conb = b.x * split;
  float a1 = cona - (cona - a.x);
  float b1 = conb - (conb - b.x);
  float a2 = a.x - a1;
  float b2 = b.x - b1;
  float c11 = a.x * b.x;
  float c21 = a2 * b2 + (a2 * b1 + (a1 * b2 + (a1 * b1 - c11)));
  float c2 = a.x * b.y + a.y * b.x;
  float t1 = c11 + c2;
  float e = t1 - c11;
  float t2 = a.y * b.y + ((c2 - e) + (c11 - (t1 - e))) + c21;
  float hi = t1 + t2;
  float lo = t2 - (hi - t1);
  return vec2(hi, lo);
}`

// Shared colouring helpers: palette lookup, smooth iteration count, DE shade.
const COLOR_COMMON = `
uniform sampler2D u_palette;
uniform float u_colorScale;
uniform float u_colorOffset;
uniform int   u_de;          // 1 = distance-estimation outline shading
uniform float u_deStrength;  // px multiplier for the DE falloff

vec3 paletteColor(float t) {
  return texture(u_palette, vec2(fract(t), 0.5)).rgb;
}

// Smooth (fractional) iteration count from |z|^2 at escape.
float smoothIter(float mag2, float iter) {
  float logZn = 0.5 * log(mag2);
  float nu = log(logZn / log(2.0)) / log(2.0);
  return iter + 1.0 - nu;
}

// Combine smooth-iteration colour with an optional DE outline. dist is the
// exterior distance estimate in world units; pxScale is world units per pixel.
vec3 shade(float sIter, float dist, float pxScale) {
  vec3 base = paletteColor(sIter * u_colorScale + u_colorOffset);
  if (u_de == 1) {
    float pxDist = dist / max(pxScale, 1e-38);
    // tanh gives a soft, resolution-independent glow around the boundary.
    float g = tanh(pxDist * u_deStrength);
    base *= g;
  }
  return base;
}`

export const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform vec2  u_resolution;
uniform vec2  u_cx;          // df64 view-center real part
uniform vec2  u_cy;          // df64 view-center imaginary part
uniform vec2  u_scale;       // df64 world units per backing pixel
uniform int   u_maxIter;
uniform int   u_mode;        // 0 = Mandelbrot, 1 = Julia
uniform vec2  u_jx;          // df64 Julia constant, real
uniform vec2  u_jy;          // df64 Julia constant, imaginary
uniform int   u_aa;          // supersampling factor per axis (1..3)

out vec4 fragColor;
${DF64}
${COLOR_COMMON}

const float BAILOUT2 = 65536.0; // escape radius^2 (R = 256) for smooth coloring

// Escape-time colour for one backing-store pixel coordinate.
vec3 sampleAt(vec2 fragPx) {
  vec2 px = fragPx - 0.5 * u_resolution;
  vec2 wx = ds_add(u_cx, ds_mul(ds_set(px.x), u_scale));
  vec2 wy = ds_add(u_cy, ds_mul(ds_set(px.y), u_scale));

  vec2 zx, zy, cx, cy;
  if (u_mode == 1) {
    zx = wx; zy = wy; cx = u_jx; cy = u_jy;
  } else {
    zx = ds_set(0.0); zy = ds_set(0.0); cx = wx; cy = wy;
  }

  vec2 dp = vec2(0.0);            // derivative dz/dc (Julia: dz/dz0), plain float
  bool escaped = false;
  int iter = 0;
  float m = 0.0;
  for (int k = 0; k < u_maxIter; k++) {
    vec2 zx2 = ds_mul(zx, zx);
    vec2 zy2 = ds_mul(zy, zy);
    vec2 mag = ds_add(zx2, zy2);
    m = mag.x;
    if (m > BAILOUT2) { escaped = true; iter = k; break; }
    if (u_de == 1) {
      vec2 zc = vec2(zx.x, zy.x);
      vec2 t = vec2(zc.x * dp.x - zc.y * dp.y, zc.x * dp.y + zc.y * dp.x);
      dp = 2.0 * t + vec2(1.0, 0.0);
    }
    vec2 xy = ds_mul(zx, zy);
    zy = ds_add(ds_add(xy, xy), cy);      // 2*zx*zy + cy
    zx = ds_add(ds_sub(zx2, zy2), cx);    // zx^2 - zy^2 + cx
  }

  if (!escaped) return vec3(0.0); // interior of the set

  float s = smoothIter(m, float(iter));
  float dist = 0.0;
  if (u_de == 1) {
    float zmag = sqrt(m);
    dist = zmag * log(zmag) / max(length(dp), 1e-30);
  }
  return shade(s, dist, u_scale.x);
}

void main() {
  vec3 col;
  if (u_aa <= 1) {
    col = sampleAt(gl_FragCoord.xy);
  } else {
    int n = u_aa;
    float inv = 1.0 / float(n);
    col = vec3(0.0);
    for (int sy = 0; sy < n; sy++) {
      for (int sx = 0; sx < n; sx++) {
        vec2 off = (vec2(float(sx), float(sy)) + 0.5) * inv - 0.5;
        col += sampleAt(gl_FragCoord.xy + off);
      }
    }
    col /= float(n * n);
  }
  fragColor = vec4(col, 1.0);
}`

// --- Perturbation fragment shader (deep zoom, Mandelbrot only) ---------------
//
// The reference orbit Z_n arrives as an RG32F texture (index m -> texel
// (m % W, m / W)). Each pixel iterates its delta in float32:
//
//   dz_{n+1} = 2·Z_m·dz_n + dz_n² + dc
//
// Rebasing (Zhuoran, 2021): whenever |z| < |dz| (the actual value dips below the
// delta — a would-be glitch) or the reference runs out, reset dz to the true
// value z and restart the reference index at 0. One reference orbit, no glitch
// hunting, provably faithful (validated against a BigInt ground truth).
export const FRAG_PERTURB_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform vec2  u_resolution;
uniform float u_pixelScale;  // world units per backing pixel (dc scale), small
uniform int   u_maxIter;
uniform int   u_orbitLen;    // highest valid reference index
uniform sampler2D u_orbit;   // RG32F reference orbit: (Zx, Zy)
uniform int   u_aa;

out vec4 fragColor;
${COLOR_COMMON}

const float BAILOUT2 = 65536.0;

vec2 orbitAt(int m) {
  int W = textureSize(u_orbit, 0).x;
  return texelFetch(u_orbit, ivec2(m % W, m / W), 0).rg;
}

vec3 sampleAt(vec2 fragPx) {
  vec2 px = fragPx - 0.5 * u_resolution;
  vec2 dc = px * u_pixelScale;    // this pixel's delta from the reference

  vec2 dz = vec2(0.0);            // delta z = z - Z
  vec2 dv = vec2(0.0);            // derivative d(z)/d(dc), for DE
  int m = 0;
  int n = 0;
  bool escaped = false;
  float mag2 = 0.0;

  for (int k = 0; k < u_maxIter; k++) {
    vec2 Z = orbitAt(m);
    if (u_de == 1) {
      vec2 zc = Z + dz;           // true value z_n
      vec2 t = vec2(zc.x * dv.x - zc.y * dv.y, zc.x * dv.y + zc.y * dv.x);
      dv = 2.0 * t + vec2(1.0, 0.0);
    }
    // dz = 2*Z*dz + dz^2 + dc
    vec2 twoZdz = vec2(Z.x * dz.x - Z.y * dz.y, Z.x * dz.y + Z.y * dz.x);
    vec2 dz2 = vec2(dz.x * dz.x - dz.y * dz.y, 2.0 * dz.x * dz.y);
    dz = 2.0 * twoZdz + dz2 + dc;
    m++;
    n++;
    Z = orbitAt(m);
    vec2 z = Z + dz;               // true value at iteration n
    mag2 = dot(z, z);
    if (mag2 > BAILOUT2) { escaped = true; break; }
    float dd = dot(dz, dz);
    if (mag2 < dd || m >= u_orbitLen) {
      dz = z;                     // rebase to reference index 0
      m = 0;
    }
  }

  if (!escaped) return vec3(0.0);

  float s = smoothIter(mag2, float(n));
  float dist = 0.0;
  if (u_de == 1) {
    float zmag = sqrt(mag2);
    dist = zmag * log(zmag) / max(length(dv), 1e-30);
  }
  return shade(s, dist, u_pixelScale);
}

void main() {
  vec3 col;
  if (u_aa <= 1) {
    col = sampleAt(gl_FragCoord.xy);
  } else {
    int n = u_aa;
    float inv = 1.0 / float(n);
    col = vec3(0.0);
    for (int sy = 0; sy < n; sy++) {
      for (int sx = 0; sx < n; sx++) {
        vec2 off = (vec2(float(sx), float(sy)) + 0.5) * inv - 0.5;
        col += sampleAt(gl_FragCoord.xy + off);
      }
    }
    col /= float(n * n);
  }
  fragColor = vec4(col, 1.0);
}`
