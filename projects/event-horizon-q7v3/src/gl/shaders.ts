// GLSL ES 3.00 shaders for the black hole ray tracer.
//
// The fragment shader integrates a photon's null geodesic *backwards* from the camera. In our
// units the Schwarzschild radius rs = 1 (so M = 0.5). Angular momentum L = r⃗ × v⃗ is conserved
// because the effective acceleration is purely radial, which lets us use the compact Cartesian
// form of the photon shape equation d²u/dφ² + u = 3M·u²:
//
//     a⃗ = -1.5 · |L|² · r⃗ / r⁵            (rs = 1)
//
// Rays that fall inside r = 1 are captured (black shadow); rays that escape sample a procedural,
// gravitationally-lensed starfield along their final direction. The disk sits in the y = 0 plane.

export const VERT_SRC = /* glsl */ `#version 300 es
// Fullscreen triangle generated from gl_VertexID — no vertex buffers needed.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export const FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  uResolution;
uniform float uTime;
uniform float uAspect;
uniform float uTanHalfFov;

uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamForward;

uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskBrightness;
uniform float uDiskTemp;
uniform float uDiskDensity;

uniform int   uSteps;
uniform float uStepSize;

uniform bool  uDoppler;
uniform bool  uRedshift;

uniform float uStarBrightness;
uniform float uExposure;

const float PI = 3.14159265359;

// ---------------------------------------------------------------- hashing / noise
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float vnoise(vec3 p) {
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
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return s;
}

// ---------------------------------------------------------------- black-body colour
// Neil Bartlett's approximation of the Planckian locus. Input in Kelvin, output linear-ish RGB.
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r, g, b;
  if (t <= 66.0) {
    r = 1.0;
  } else {
    r = 329.698727446 * pow(max(t - 60.0, 0.0), -0.1332047592) / 255.0;
  }
  if (t <= 66.0) {
    g = (99.4708025861 * log(max(t, 1.0)) - 161.1195681661) / 255.0;
  } else {
    g = 288.1221695283 * pow(max(t - 60.0, 0.0), -0.0755148492) / 255.0;
  }
  if (t >= 66.0) {
    b = 1.0;
  } else if (t <= 19.0) {
    b = 0.0;
  } else {
    b = (138.5177312231 * log(max(t - 10.0, 1.0)) - 305.0447927307) / 255.0;
  }
  return clamp(vec3(r, g, b), 0.0, 1.0);
}

// ---------------------------------------------------------------- lensed starfield
vec3 starLayer(vec3 dir, float scale, float threshold) {
  vec3 p = dir * scale;
  vec3 id = floor(p);
  vec3 f = fract(p);
  vec3 rnd = hash33(id);
  float present = step(threshold, rnd.z);
  vec3 center = rnd * 0.7 + 0.15;
  float d = length(f - center);
  float glow = present * smoothstep(0.16, 0.0, d);
  float temp = mix(2800.0, 13000.0, hash13(id + 5.0));
  float bright = 0.5 + 1.4 * hash13(id + 11.0);
  return glow * bright * blackbody(temp);
}

vec3 starField(vec3 dir) {
  dir = normalize(dir);
  vec3 col = vec3(0.0);
  col += starLayer(dir, 70.0, 0.955);
  col += starLayer(dir, 150.0, 0.978) * 0.7;
  col += starLayer(dir, 300.0, 0.988) * 0.45;
  // faint interstellar nebula so the void isn't dead black
  float neb = fbm(dir * 3.0 + 4.0);
  neb = pow(max(neb - 0.52, 0.0), 2.0) * 1.6;
  float neb2 = fbm(dir * 6.0 - 2.0);
  col += neb * vec3(0.10, 0.05, 0.20);
  col += pow(max(neb2 - 0.6, 0.0), 2.0) * vec3(0.04, 0.10, 0.14);
  col += vec3(0.004, 0.006, 0.012); // deep-sky glow
  return col * uStarBrightness;
}

// ---------------------------------------------------------------- accretion disk
// Returns emitted radiance; writes coverage into the alpha out-param. photonDir is the
// integration velocity at the hit (points away from the camera along the traced path).
vec3 sampleDisk(vec3 hit, vec3 photonDir, out float alpha) {
  float r = length(hit);
  float t = clamp((r - uDiskInner) / max(uDiskOuter - uDiskInner, 1e-3), 0.0, 1.0);

  // soft inner/outer edges
  float edge = smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.82, t);

  // Keplerian shear — inner material orbits faster (∝ r^-1.5)
  float ang = atan(hit.z, hit.x);
  float kepler = uTime * 0.55 / pow(max(r, uDiskInner), 1.5);
  vec2 swirl = vec2(cos(ang - kepler), sin(ang - kepler)) * r;
  float turb = fbm(vec3(swirl * 0.6, r * 0.45 - kepler * 2.0));
  float bands = 0.5 + 0.5 * sin(ang * 3.0 - kepler * 4.0 + turb * 6.2);
  float density = edge * (0.30 + 0.95 * turb) * (0.55 + 0.6 * bands);

  // temperature: hotter toward the ISCO (∝ r^-0.75 for a thin disk, softened here)
  float kelvin = mix(9500.0, 1700.0, pow(t, 0.55)) * uDiskTemp;
  float emit = uDiskBrightness * (0.4 + 1.4 / (0.35 + 2.6 * t));

  // relativistic effects -------------------------------------------------
  vec3 vdir = normalize(cross(vec3(0.0, 1.0, 0.0), hit));   // prograde orbital direction
  float beta = min(sqrt(0.5 / max(r, uDiskInner)), 0.95);   // orbital speed (units of c)
  float gamma = 1.0 / sqrt(1.0 - beta * beta);
  vec3 nObs = -normalize(photonDir);                         // emitter → observer direction
  float doppler = 1.0 / (gamma * (1.0 - beta * dot(vdir, nObs)));

  float shift = 1.0;
  if (uDoppler) shift *= doppler;
  if (uRedshift) shift *= sqrt(max(1.0 - 1.0 / r, 0.0));     // gravitational redshift
  kelvin *= clamp(shift, 0.2, 5.0);
  emit *= clamp(pow(shift, 3.0), 0.03, 9.0);                 // relativistic beaming ∝ δ³

  vec3 col = blackbody(kelvin) * emit;
  alpha = clamp(density * uDiskDensity, 0.0, 1.0);
  return col;
}

// ---------------------------------------------------------------- geodesic
vec3 accel(vec3 p, float h2) {
  float r2 = max(dot(p, p), 0.09); // clamp near the horizon to keep the integrator finite
  return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
}

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= uAspect;

  vec3 dir = normalize(uCamForward + uv.x * uTanHalfFov * uCamRight + uv.y * uTanHalfFov * uCamUp);
  vec3 pos = uCamPos;
  vec3 vel = dir;

  vec3 L = cross(pos, vel);
  float h2 = dot(L, L);

  float camR = length(uCamPos);
  float escapeR = max(32.0, camR * 1.7);

  vec3 color = vec3(0.0);
  float transmit = 1.0;
  bool captured = false;

  for (int i = 0; i < 2000; i++) {
    if (i >= uSteps) break;
    float r = length(pos);
    if (r < 1.0) { captured = true; break; }
    if (r > escapeR && dot(pos, vel) > 0.0) break;

    float dt = uStepSize * (0.35 + 0.22 * r); // adaptive: longer steps far from the hole

    // classic RK4 on (position, velocity)
    vec3 a1 = accel(pos, h2);
    vec3 p2 = pos + 0.5 * dt * vel;      vec3 v2 = vel + 0.5 * dt * a1;
    vec3 a2 = accel(p2, h2);
    vec3 p3 = pos + 0.5 * dt * v2;       vec3 v3 = vel + 0.5 * dt * a2;
    vec3 a3 = accel(p3, h2);
    vec3 p4 = pos + dt * v3;             vec3 v4 = vel + dt * a3;
    vec3 a4 = accel(p4, h2);

    vec3 newPos = pos + dt / 6.0 * (vel + 2.0 * v2 + 2.0 * v3 + v4);
    vec3 newVel = vel + dt / 6.0 * (a1 + 2.0 * a2 + 2.0 * a3 + a4);

    // equatorial-plane crossing → sample the disk (sub-step interpolated so it stays crisp)
    if (pos.y * newPos.y < 0.0 && transmit > 0.01) {
      float tt = pos.y / (pos.y - newPos.y);
      vec3 hit = mix(pos, newPos, tt);
      float rr = length(hit);
      if (rr > uDiskInner && rr < uDiskOuter) {
        float alpha;
        vec3 dc = sampleDisk(hit, normalize(mix(vel, newVel, tt)), alpha);
        color += transmit * dc * alpha;
        transmit *= (1.0 - alpha);
      }
    }

    pos = newPos;
    vel = newVel;
  }

  vec3 bg = captured ? vec3(0.0) : starField(vel);
  color += transmit * bg;

  color *= uExposure;
  color = aces(color);
  color = pow(color, vec3(1.0 / 2.2)); // gamma
  fragColor = vec4(color, 1.0);
}
`
