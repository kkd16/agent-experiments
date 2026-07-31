// GLSL sources for the fractal renderer.
//
// Fathom renders with two different fragment shaders, picked per frame by zoom:
//
//   * FRAG_SRC       — the direct engine. Iterates the escape-time formula in
//                      *emulated double precision* (df64: every coordinate is a
//                      vec2(hi, lo) pair, ~48 bits). Good to a zoom of ~1e13,
//                      entirely on the GPU. Used at shallow/medium depth, for
//                      Julia sets, and for every non-power formula (Burning Ship,
//                      Tricorn, Celtic, Perpendicular).
//   * FRAG_PERTURB_SRC — the deep engine. Uses *perturbation theory*: a single
//                      high-precision reference orbit (uploaded as a texture)
//                      plus a per-pixel delta iterated in plain float32, with
//                      Zhuoran rebasing to stay glitch-free. This lifts the zoom
//                      floor from ~1e13 to ~1e30+. Supported for the pure power
//                      maps z^p + c (p = 2, 3, 4), whose critical orbit starts at
//                      Z0 = 0 — the assumption Zhuoran rebasing depends on.
//
// Both support optional distance-estimation (DE) shading, which outlines the
// set's filaments by dividing |z| by the escape derivative |dz/dc|. DE and the
// normal-map relief lighting are only mathematically valid for holomorphic maps
// (Mandelbrot / Cubic / Quartic); for the abs/conjugate formulas the derivative
// is left at zero so those effects degrade to a no-op instead of a wrong image.

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
// abs of a df64: the value's sign is the sign of the hi limb (|lo| <= 0.5 ulp).
vec2 ds_abs(vec2 a) { return a.x < 0.0 ? ds_neg(a) : a; }

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

// Plain-float32 complex multiply, shared by both engines' derivative bookkeeping
// (and the perturbation delta recurrence).
const CMPLX = `
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }`

// Shared colouring helpers: palette lookup, smooth iteration count, the per-orbit
// statistic accumulators (stripe average / orbit trap), and the final shade.
//
// Colouring modes (u_colorMode):
//   0  smooth   — classic smooth escape-time bands (the historical look)
//   1  stripe   — Stripe Average Colouring: the running mean of
//                 0.5+0.5·sin(f·arg z) along the orbit, mixed between its last
//                 two values by the smooth fractional escape so it stays crisp
//   2  trapPt   — orbit trap: min |z| over the orbit (glowing filaments)
//   3  trapCr   — orbit trap: min distance to the real/imaginary axes (a weave)
//
// With u_interior = 1 the set's interior is painted by the same statistic
// instead of flat black. Every mode still supports the optional DE outline.
const COLOR_COMMON = `
uniform sampler2D u_palette;
uniform float u_colorScale;
uniform float u_colorOffset;
uniform int   u_de;          // 1 = distance-estimation outline shading
uniform float u_deStrength;  // px multiplier for the DE falloff
uniform int   u_colorMode;   // 0 smooth, 1 stripe, 2 trap-point, 3 trap-cross
uniform float u_featureFreq; // stripe density / orbit-trap scale
uniform int   u_interior;    // 1 = shade the interior instead of flat black
uniform int   u_relief;      // 1 = normal-map relief (Lambert) lighting
uniform float u_lightAngle;  // light azimuth, radians
uniform float u_lightHeight; // light elevation (higher = flatter shading)
uniform float u_logPower;    // ln(formula degree) for the smooth iteration count

vec3 paletteColor(float t) {
  return texture(u_palette, vec2(fract(t), 0.5)).rgb;
}

// Normal-map relief: treat u = z / (dz/dc) as a surface normal in the plane and
// light it with a Lambert term. This is the classic embossed / pseudo-3D fractal
// look. z is the escape value; der is the escape derivative dz/dc.
float reliefShade(vec2 z, vec2 der) {
  float d2 = dot(der, der);
  if (d2 < 1e-30) return 1.0;
  // complex division z / der
  vec2 u = vec2(z.x * der.x + z.y * der.y, z.y * der.x - z.x * der.y) / d2;
  u = normalize(u);
  vec2 light = vec2(cos(u_lightAngle), sin(u_lightAngle));
  float t = (u.x * light.x + u.y * light.y + u_lightHeight) / (1.0 + u_lightHeight);
  return clamp(t, 0.0, 1.0);
}

// Smooth (fractional) iteration count from |z|^2 at escape. logDeg = ln(degree):
// ln(2) recovers the classic quadratic count; higher-degree maps escape faster,
// so the fractional part is divided by the map's degree instead.
float smoothIter(float mag2, float iter) {
  float logZn = 0.5 * log(mag2);
  float nu = log(logZn / log(2.0)) / u_logPower;
  return iter + 1.0 - nu;
}

// Fold the current orbit point z_k into the running colour statistics. k is the
// orbit index; k==0 (z=0 for the parameter-plane sets) is skipped because
// arg(0) is undefined. The stripe mean keeps its previous value too, so the
// caller can mix the last two by the smooth fractional escape and avoid banding.
void accumStats(vec2 z, int k, inout float sSum, inout float sPrev,
                inout float trap, inout int cnt) {
  if (k == 0) return;
  if (u_colorMode == 1) {
    float s = 0.5 + 0.5 * sin(u_featureFreq * atan(z.y, z.x));
    sPrev = sSum;
    sSum += s;
    cnt++;
  } else if (u_colorMode == 2) {
    trap = min(trap, length(z));
  } else if (u_colorMode == 3) {
    trap = min(trap, min(abs(z.x), abs(z.y)));
  }
}

// Resolve one pixel to a colour from the accumulated statistics. Interior points
// (escaped == false) are black unless u_interior asks for them to be painted.
// dist is the exterior distance estimate in world units; pxScale is world units
// per pixel; mag2/sIter describe the escape.
vec3 finalColor(bool escaped, float mag2, float sIter, float dist, float pxScale,
                float sSum, float sPrev, float trap, int cnt, vec2 zEnd, vec2 der) {
  if (!escaped && u_interior == 0) return vec3(0.0);

  float pc;
  if (u_colorMode == 1) {
    float avg  = cnt > 0 ? sSum / float(cnt) : 0.0;
    float avgP = cnt > 1 ? sPrev / float(cnt - 1) : avg;
    pc = escaped ? mix(avgP, avg, fract(sIter)) : avg;
  } else if (u_colorMode == 2 || u_colorMode == 3) {
    pc = sqrt(max(trap, 0.0)) * u_featureFreq;
  } else {
    pc = escaped ? sIter * u_colorScale : sqrt(mag2) * u_featureFreq * 0.5;
  }

  vec3 base = paletteColor(pc + u_colorOffset);
  if (escaped && u_de == 1) {
    float pxDist = dist / max(pxScale, 1e-38);
    // tanh gives a soft, resolution-independent glow around the boundary.
    base *= tanh(pxDist * u_deStrength);
  }
  if (escaped && u_relief == 1) {
    // Keep some ambient so lit faces read as colour, not pure black.
    base *= 0.28 + 0.72 * reliefShade(zEnd, der);
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
uniform int   u_mode;        // 0 = parameter plane (Mandelbrot), 1 = Julia
uniform int   u_formula;     // 0 z²  1 z³  2 z⁴  3 ship  4 tricorn  5 celtic  6 perp
uniform vec2  u_jx;          // df64 Julia constant, real
uniform vec2  u_jy;          // df64 Julia constant, imaginary
uniform int   u_aa;          // supersampling factor per axis (1..3)

out vec4 fragColor;
${DF64}
${CMPLX}
${COLOR_COMMON}

const float BAILOUT2 = 65536.0; // escape radius^2 (R = 256) for smooth coloring

// One escape-time step for the selected formula: given z = (zx, zy) in df64 and
// the constant c = (cx, cy), return the next z. The pre-squared limbs a2 = zx²,
// b2 = zy² are passed in (already needed for the bailout test) to avoid redoing
// the df64 multiplies.
void stepFormula(vec2 zx, vec2 zy, vec2 a2, vec2 b2, vec2 cx, vec2 cy,
                 out vec2 nx, out vec2 ny) {
  if (u_formula == 0) {                 // Mandelbrot: z² + c
    vec2 ab = ds_mul(zx, zy);
    nx = ds_add(ds_sub(a2, b2), cx);
    ny = ds_add(ds_add(ab, ab), cy);    // 2·zx·zy + cy
  } else if (u_formula == 1) {          // Cubic: z³ + c
    vec2 threeA2 = ds_add(a2, ds_add(a2, a2));
    vec2 threeB2 = ds_add(b2, ds_add(b2, b2));
    nx = ds_add(ds_mul(zx, ds_sub(a2, threeB2)), cx); // x(x²−3y²)
    ny = ds_add(ds_mul(zy, ds_sub(threeA2, b2)), cy); // y(3x²−y²)
  } else if (u_formula == 2) {          // Quartic: z⁴ + c  = (z²)²
    vec2 p = ds_sub(a2, b2);            // Re(z²)
    vec2 q = ds_mul(ds_add(zx, zx), zy); // Im(z²) = 2xy
    vec2 p2 = ds_mul(p, p);
    vec2 q2 = ds_mul(q, q);
    nx = ds_add(ds_sub(p2, q2), cx);
    ny = ds_add(ds_mul(ds_add(p, p), q), cy); // 2·p·q
  } else if (u_formula == 3) {          // Burning Ship: (|x|+i|y|)² + c
    vec2 ab = ds_mul(ds_abs(zx), ds_abs(zy));
    nx = ds_add(ds_sub(a2, b2), cx);
    ny = ds_add(ds_add(ab, ab), cy);   // 2·|x|·|y| + cy
  } else if (u_formula == 4) {          // Tricorn / Mandelbar: conj(z)² + c
    vec2 ab = ds_mul(zx, zy);
    nx = ds_add(ds_sub(a2, b2), cx);
    ny = ds_add(ds_neg(ds_add(ab, ab)), cy); // −2·zx·zy + cy
  } else if (u_formula == 5) {          // Celtic: |Re(z²)| + i·Im(z²) + c
    vec2 ab = ds_mul(zx, zy);
    nx = ds_add(ds_abs(ds_sub(a2, b2)), cx);
    ny = ds_add(ds_add(ab, ab), cy);
  } else {                              // Perpendicular Burning Ship
    vec2 ab = ds_mul(ds_abs(zx), zy);
    nx = ds_add(ds_sub(a2, b2), cx);
    ny = ds_add(ds_neg(ds_add(ab, ab)), cy); // −2·|x|·y + cy
  }
}

// Advance the plain-float escape derivative dz/dc for the holomorphic power maps.
vec2 stepDeriv(vec2 zc, vec2 dp) {
  if (u_formula == 0) {
    return 2.0 * cmul(zc, dp) + vec2(1.0, 0.0);
  } else if (u_formula == 1) {
    return 3.0 * cmul(cmul(zc, zc), dp) + vec2(1.0, 0.0);
  } else {
    vec2 zc2 = cmul(zc, zc);
    vec2 zc3 = cmul(zc2, zc);
    return 4.0 * cmul(zc3, dp) + vec2(1.0, 0.0);
  }
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

  // The escape derivative is only meaningful for the holomorphic power maps
  // (formulas 0/1/2); leaving dp = 0 makes DE + relief a graceful no-op elsewhere.
  bool deriv = (u_de == 1 || u_relief == 1) && u_formula <= 2;
  vec2 dp = vec2(0.0);            // derivative dz/dc (Julia: dz/dz0), plain float
  bool escaped = false;
  int iter = 0;
  float m = 0.0;
  float sSum = 0.0, sPrev = 0.0, trap = 1e20; // colour-statistic accumulators
  int cnt = 0;
  for (int k = 0; k < u_maxIter; k++) {
    vec2 a2 = ds_mul(zx, zx);
    vec2 b2 = ds_mul(zy, zy);
    vec2 mag = ds_add(a2, b2);
    m = mag.x;
    accumStats(vec2(zx.x, zy.x), k, sSum, sPrev, trap, cnt);
    if (m > BAILOUT2) { escaped = true; iter = k; break; }
    if (deriv) dp = stepDeriv(vec2(zx.x, zy.x), dp);
    vec2 nx, ny;
    stepFormula(zx, zy, a2, b2, cx, cy, nx, ny);
    zx = nx; zy = ny;
  }

  float s = escaped ? smoothIter(m, float(iter)) : 0.0;
  float dist = 0.0;
  if (escaped && u_de == 1) {
    float zmag = sqrt(m);
    dist = zmag * log(zmag) / max(length(dp), 1e-30);
  }
  return finalColor(escaped, m, s, dist, u_scale.x, sSum, sPrev, trap, cnt,
                    vec2(zx.x, zy.x), dp);
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

// --- Perturbation fragment shader (deep zoom, power maps z^p + c) -------------
//
// The reference orbit Z_n arrives as an RG32F texture (index m -> texel
// (m % W, m / W)). Each pixel iterates its delta in float32. For the quadratic
// map the recurrence is dz' = 2·Z·dz + dz² + dc; for degree p it is the exact
// binomial expansion of (Z+dz)^p − Z^p + dc, which keeps every term at the tiny
// delta scale (no catastrophic cancellation).
//
// Rebasing (Zhuoran, 2021): whenever |z| < |dz| (the actual value dips below the
// delta — a would-be glitch) or the reference runs out, reset dz to the true
// value z and restart the reference index at 0. This assumes Z_0 = 0, which is
// exactly the critical orbit of every z^p + c map. One reference orbit, no
// glitch hunting, validated against a BigInt ground truth.
export const FRAG_PERTURB_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform vec2  u_resolution;
uniform float u_pixelScale;  // world units per backing pixel (dc scale), small
uniform int   u_maxIter;
uniform int   u_orbitLen;    // highest valid reference index
uniform int   u_power;       // formula degree p (2, 3 or 4)
uniform sampler2D u_orbit;   // RG32F reference orbit: (Zx, Zy)
uniform int   u_aa;

out vec4 fragColor;
${CMPLX}
${COLOR_COMMON}

const float BAILOUT2 = 65536.0;

vec2 orbitAt(int m) {
  int W = textureSize(u_orbit, 0).x;
  return texelFetch(u_orbit, ivec2(m % W, m / W), 0).rg;
}

// Exact (Z+dz)^p − Z^p, expanded so every term stays at the delta scale.
vec2 deltaStep(vec2 Z, vec2 dz) {
  if (u_power == 2) {
    vec2 dz2 = cmul(dz, dz);
    return 2.0 * cmul(Z, dz) + dz2;
  } else if (u_power == 3) {
    vec2 Z2 = cmul(Z, Z);
    vec2 dz2 = cmul(dz, dz);
    vec2 dz3 = cmul(dz2, dz);
    return 3.0 * cmul(Z2, dz) + 3.0 * cmul(Z, dz2) + dz3;
  } else {
    vec2 Z2 = cmul(Z, Z);
    vec2 Z3 = cmul(Z2, Z);
    vec2 dz2 = cmul(dz, dz);
    vec2 dz3 = cmul(dz2, dz);
    vec2 dz4 = cmul(dz2, dz2);
    return 4.0 * cmul(Z3, dz) + 6.0 * cmul(Z2, dz2) + 4.0 * cmul(Z, dz3) + dz4;
  }
}

// Escape derivative d(z)/d(dc) = p·z^{p-1}·dv + 1 at the true value z = Z + dz.
vec2 derivStep(vec2 zc, vec2 dv) {
  if (u_power == 2) {
    return 2.0 * cmul(zc, dv) + vec2(1.0, 0.0);
  } else if (u_power == 3) {
    return 3.0 * cmul(cmul(zc, zc), dv) + vec2(1.0, 0.0);
  } else {
    vec2 zc2 = cmul(zc, zc);
    vec2 zc3 = cmul(zc2, zc);
    return 4.0 * cmul(zc3, dv) + vec2(1.0, 0.0);
  }
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
  float sSum = 0.0, sPrev = 0.0, trap = 1e20; // colour-statistic accumulators
  int cnt = 0;
  vec2 zEnd = vec2(0.0);
  bool deriv = (u_de == 1 || u_relief == 1);

  for (int k = 0; k < u_maxIter; k++) {
    vec2 Z = orbitAt(m);
    if (deriv) dv = derivStep(Z + dz, dv);   // true value z_n = Z + dz
    dz = deltaStep(Z, dz) + dc;
    m++;
    n++;
    Z = orbitAt(m);
    vec2 z = Z + dz;               // true value at iteration n
    mag2 = dot(z, z);
    zEnd = z;
    accumStats(z, n, sSum, sPrev, trap, cnt);
    if (mag2 > BAILOUT2) { escaped = true; break; }
    float dd = dot(dz, dz);
    if (mag2 < dd || m >= u_orbitLen) {
      dz = z;                     // rebase to reference index 0
      m = 0;
    }
  }

  float s = escaped ? smoothIter(mag2, float(n)) : 0.0;
  float dist = 0.0;
  if (escaped && u_de == 1) {
    float zmag = sqrt(mag2);
    dist = zmag * log(zmag) / max(length(dv), 1e-30);
  }
  return finalColor(escaped, mag2, s, dist, u_pixelScale, sSum, sPrev, trap, cnt,
                    zEnd, dv);
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
