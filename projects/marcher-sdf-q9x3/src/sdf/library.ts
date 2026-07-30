// The static GLSL library: signed-distance functions for every primitive and
// the constructive-solid-geometry operators. These are emitted verbatim into the
// fragment shader; codegen (codegen.ts) only stitches per-node calls around them.
//
// The distance functions follow Inigo Quilez's well-known formulations. Each op
// works on a vec2 that carries `(distance, materialId)` so the shader can recover
// which node owns the nearest surface after the whole field is folded together.

export const SDF_PRIMITIVES = /* glsl */ `
float sdSphere(vec3 p, float r){ return length(p) - r; }

float sdBox(vec3 p, vec3 b){
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r){
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdTorus(vec3 p, float ra, float rb){
  vec2 q = vec2(length(p.xz) - ra, p.y);
  return length(q) - rb;
}

float sdCapsule(vec3 p, float h, float r){
  p.y -= clamp(p.y, -h, h);
  return length(p) - r;
}

float sdCylinder(vec3 p, float r, float h){
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdCone(vec3 p, float r, float h){
  // Solid cone: base radius r at y=-h/2, apex at y=+h/2.
  vec2 q = vec2(r, h);
  vec2 w = vec2(length(p.xz), p.y + h * 0.5);
  vec2 a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  vec2 b = w - q * vec2(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  float k = sign(q.y);
  float d = min(dot(a, a), dot(b, b));
  float s = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
  return sqrt(d) * sign(s);
}

float sdOctahedron(vec3 p, float s){
  p = abs(p);
  float m = p.x + p.y + p.z - s;
  vec3 q;
  if (3.0 * p.x < m) q = p.xyz;
  else if (3.0 * p.y < m) q = p.yzx;
  else if (3.0 * p.z < m) q = p.zxy;
  else return m * 0.57735027;
  float k = clamp(0.5 * (q.z - q.y + s), 0.0, s);
  return length(vec3(q.x, q.y - s + k, q.z - k));
}

float sdPlane(vec3 p){ return p.y; }

float sdEllipsoid(vec3 p, vec3 r){
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

float sdHexPrism(vec3 p, vec2 h){
  const vec3 k = vec3(-0.8660254, 0.5, 0.57735);
  p = abs(p);
  p.xy -= 2.0 * min(dot(k.xy, p.xy), 0.0) * k.xy;
  vec2 d = vec2(
    length(p.xy - vec2(clamp(p.x, -k.z * h.x, k.z * h.x), h.x)) * sign(p.y - h.x),
    p.z - h.y);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdPyramid(vec3 p, float h){
  float m2 = h * h + 0.25;
  p.xz = abs(p.xz);
  p.xz = (p.z > p.x) ? p.zx : p.xz;
  p.xz -= 0.5;
  vec3 q = vec3(p.z, h * p.y - 0.5 * p.x, h * p.x + 0.5 * p.y);
  float s = max(-q.x, 0.0);
  float t = clamp((q.y - 0.5 * p.z) / (m2 + 0.25), 0.0, 1.0);
  float a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
  float b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
  float d2 = min(q.y, -q.x * m2 - q.y * 0.5) > 0.0 ? 0.0 : min(a, b);
  return sqrt((d2 + q.z * q.z) / m2) * sign(max(q.z, -p.y));
}

float sdLink(vec3 p, float le, float r1, float r2){
  vec3 q = vec3(p.x, max(abs(p.y) - le, 0.0), p.z);
  return length(vec2(length(q.xy) - r1, q.z)) - r2;
}

float sdRoundCone(vec3 p, float r1, float r2, float h){
  vec2 q = vec2(length(p.xz), p.y);
  float b = (r1 - r2) / max(h, 1e-4);
  float a = sqrt(max(1.0 - b * b, 0.0));
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) return length(q) - r1;
  if (k > a * h) return length(q - vec2(0.0, h)) - r2;
  return dot(q, vec2(a, b)) - r1;
}
`

// Domain warps applied to a node's local point before its primitive is evaluated.
// Each numeric input arrives as a uniform so twisting/repeating never recompiles.
export const SDF_DOMAIN = /* glsl */ `
float repAxis(float p, float s, float lim){
  if (s <= 0.0) return p;
  float c = round(p / s);
  if (lim > 0.5) c = clamp(c, -lim, lim);
  return p - s * c;
}

vec3 opRepeat(vec3 p, vec3 s, float lim){
  return vec3(repAxis(p.x, s.x, lim), repAxis(p.y, s.y, lim), repAxis(p.z, s.z, lim));
}

vec3 opMirror(vec3 p, vec3 m){
  if (m.x > 0.5) p.x = abs(p.x);
  if (m.y > 0.5) p.y = abs(p.y);
  if (m.z > 0.5) p.z = abs(p.z);
  return p;
}

vec3 opTwist(vec3 p, float k){
  float a = k * p.y;
  float c = cos(a), s = sin(a);
  return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

vec3 opBend(vec3 p, float k){
  float c = cos(k * p.x), s = sin(k * p.x);
  mat2 m = mat2(c, -s, s, c);
  vec2 xy = m * p.xy;
  return vec3(xy.x, xy.y, p.z);
}

// Stretch a primitive along each axis by h: the shape is split and a straight
// prism of length 2·h is inserted, leaving the caps intact. Distance-preserving.
vec3 opElongate(vec3 p, vec3 h){
  return p - clamp(p, -h, h);
}

// Kaleidoscopic fold: wrap the XZ plane into "reps" identical angular wedges
// around the Y axis. A rotation of the domain, so the metric stays valid.
vec3 opPolar(vec3 p, float reps){
  if (reps < 0.5) return p;
  float a = atan(p.z, p.x);
  float r = length(p.xz);
  float sector = 6.28318530718 / reps;
  a = mod(a + 0.5 * sector, sector) - 0.5 * sector;
  return vec3(cos(a) * r, p.y, sin(a) * r);
}
`

// Procedural texture bank: value-noise-driven patterns woven into material albedo.
// `texPattern` returns a 0..1 field selected by `kind`; the shader mixes albedo
// toward a darker tint by that field, scaled by the material's texture strength.
export const SDF_TEXTURE = /* glsl */ `
float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float fbm(vec3 p){
  float a = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 4; i++){
    sum += a * vnoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return sum;
}

// Triplanar checker/grid so flat pattern samples stay stable across faces.
float triChecker(vec3 p, vec3 n){
  vec3 w = abs(n);
  w /= max(w.x + w.y + w.z, 1e-4);
  float cx = mod(floor(p.y) + floor(p.z), 2.0);
  float cy = mod(floor(p.x) + floor(p.z), 2.0);
  float cz = mod(floor(p.x) + floor(p.y), 2.0);
  return cx * w.x + cy * w.y + cz * w.z;
}

float triGrid(vec3 p, vec3 n){
  vec3 w = abs(n);
  w /= max(w.x + w.y + w.z, 1e-4);
  vec3 g = abs(fract(p) - 0.5);
  float lx = smoothstep(0.44, 0.5, max(g.y, g.z));
  float ly = smoothstep(0.44, 0.5, max(g.x, g.z));
  float lz = smoothstep(0.44, 0.5, max(g.x, g.y));
  return lx * w.x + ly * w.y + lz * w.z;
}

float texPattern(int kind, vec3 p, vec3 n, float scale){
  vec3 q = p * scale;
  if (kind == 1) return triChecker(q, n);
  if (kind == 2) return fbm(q);
  if (kind == 3){
    float m = fbm(q * 0.6);
    return 0.5 + 0.5 * sin((q.x + q.y) * 1.2 + 6.0 * m);
  }
  if (kind == 4){
    float rings = length(q.xz) + 0.6 * fbm(q * 0.5);
    return 0.5 + 0.5 * sin(rings * 6.2831);
  }
  if (kind == 5) return triGrid(q, n);
  return 0.0;
}
`

export const SDF_OPS = /* glsl */ `
vec2 opUnion(vec2 a, vec2 b){ return (a.x < b.x) ? a : b; }

vec2 opSubtract(vec2 a, vec2 b){
  // Carve b out of a; the remaining surface keeps a's material.
  return (a.x > -b.x) ? a : vec2(-b.x, a.y);
}

vec2 opIntersect(vec2 a, vec2 b){ return (a.x > b.x) ? a : b; }

vec2 opSmoothUnion(vec2 a, vec2 b, float k){
  k = max(k, 1e-4);
  float h = clamp(0.5 + 0.5 * (b.x - a.x) / k, 0.0, 1.0);
  float d = mix(b.x, a.x, h) - k * h * (1.0 - h);
  return vec2(d, h > 0.5 ? a.y : b.y);
}

vec2 opSmoothSubtract(vec2 a, vec2 b, float k){
  k = max(k, 1e-4);
  float h = clamp(0.5 - 0.5 * (a.x + b.x) / k, 0.0, 1.0);
  float d = mix(a.x, -b.x, h) + k * h * (1.0 - h);
  return vec2(d, a.y);
}

vec2 opSmoothIntersect(vec2 a, vec2 b, float k){
  k = max(k, 1e-4);
  float h = clamp(0.5 - 0.5 * (b.x - a.x) / k, 0.0, 1.0);
  float d = mix(b.x, a.x, h) + k * h * (1.0 - h);
  return vec2(d, h > 0.5 ? a.y : b.y);
}
`
