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
