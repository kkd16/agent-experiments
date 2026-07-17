// GLSL sources for the fractal renderer.
//
// The interesting part is the fragment shader: it iterates the escape-time
// formula in *emulated double precision*. WebGL only guarantees 32-bit floats,
// which lets you zoom to about 1e-4 before the image dissolves into blocky
// pixels. By storing every coordinate as a `vec2(hi, lo)` pair — a "double
// single", ~48 bits of mantissa — Fathom pushes the usable zoom to ~1e13,
// roughly a billion times deeper, entirely on the GPU and with no per-pixel
// branching penalty beyond the extra arithmetic.

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
uniform sampler2D u_palette;
uniform float u_colorScale;
uniform float u_colorOffset;
uniform int   u_aa;          // supersampling factor per axis (1..3)

out vec4 fragColor;
${DF64}

const float BAILOUT2 = 65536.0; // escape radius^2 (R = 256) for smooth coloring

vec3 paletteColor(float t) {
  return texture(u_palette, vec2(fract(t), 0.5)).rgb;
}

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

  bool escaped = false;
  int iter = 0;
  float m = 0.0;
  for (int k = 0; k < u_maxIter; k++) {
    vec2 zx2 = ds_mul(zx, zx);
    vec2 zy2 = ds_mul(zy, zy);
    vec2 mag = ds_add(zx2, zy2);
    m = mag.x;
    if (m > BAILOUT2) { escaped = true; iter = k; break; }
    vec2 xy = ds_mul(zx, zy);
    zy = ds_add(ds_add(xy, xy), cy);      // 2*zx*zy + cy
    zx = ds_add(ds_sub(zx2, zy2), cx);    // zx^2 - zy^2 + cx
  }

  if (!escaped) return vec3(0.0); // interior of the set

  // Continuous (fractional) iteration count for band-free gradients.
  float logZn = 0.5 * log(m);
  float nu = log(logZn / log(2.0)) / log(2.0);
  float s = float(iter) + 1.0 - nu;
  return paletteColor(s * u_colorScale + u_colorOffset);
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
