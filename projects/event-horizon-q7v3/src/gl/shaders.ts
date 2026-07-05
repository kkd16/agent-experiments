// GLSL ES 3.00 shaders for the black hole ray tracer.
//
// The main fragment shader integrates a photon's null geodesic *backwards* from the camera. It
// runs in one of two modes:
//
//   • Schwarzschild (spin a = 0) — the fast, reduced Cartesian shape equation. In our units the
//     Schwarzschild radius rs = 1 (so M = 0.5). Angular momentum L = r⃗ × v⃗ is conserved because
//     the effective acceleration is purely radial, giving  a⃗ = -1.5·|L|²·r⃗/r⁵.
//
//   • Kerr (spin a > 0) — the full rotating-hole geodesic, integrated in Boyer–Lindquist
//     coordinates with a Hamiltonian formulation: we carry the position (r, θ, φ) and the
//     covariant momenta (p_r, p_θ), with E = −p_t and L = p_φ conserved. The equations of motion
//     use the inverse Kerr metric gᵘᵛ(r,θ); the momentum forces come from its gradient. There are
//     no turning-point sign flips (the Hamiltonian is smooth), so it stays robust through periapsis.
//
// Rays that fall through the horizon are captured (black shadow); rays that escape sample a
// procedural, gravitationally-lensed starfield along their final direction. The disk sits in the
// equatorial (y = 0) plane; the spin axis is the world +Y axis.

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

uniform float uSpin;         // dimensionless a/M
uniform bool  uErgosphere;   // draw the static-limit shell

uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskBrightness;
uniform float uDiskTemp;
uniform float uDiskDensity;
uniform bool  uVolumetric;   // ray-march a finite-thickness slab instead of a thin plane
uniform float uDiskThickness;// half-thickness scale h₀ at the inner edge (rs); slab flares outward

uniform int   uSteps;
uniform float uStepSize;

uniform bool  uDoppler;
uniform bool  uRedshift;

uniform float uObserverBeta; // free-fall rain-observer speed β = √(rs/r); 0 = static camera

uniform float uStarBrightness;
uniform float uExposure;
uniform bool  uToneMap;      // apply exposure + ACES + gamma here (no-bloom fast path)

const float PI = 3.14159265359;
const float MASS = 0.5;      // M = rs/2 in our units

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
// Rest-frame disk sample: the turbulent pattern + black-body temperature ramp before any
// relativistic frequency shift. "hit" is the world-space crossing point (for the pattern);
// "rDisk" is the physical disk radius (Boyer-Lindquist r in Kerr, |hit| in Schwarzschild).
void diskBase(vec3 hit, float rDisk, out float density, out float kelvin, out float emit) {
  float t = clamp((rDisk - uDiskInner) / max(uDiskOuter - uDiskInner, 1e-3), 0.0, 1.0);

  // soft inner/outer edges
  float edge = smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.82, t);

  // Keplerian shear — inner material orbits faster (∝ r^-1.5)
  float ang = atan(hit.z, hit.x);
  float kepler = uTime * 0.55 / pow(max(rDisk, uDiskInner), 1.5);
  vec2 swirl = vec2(cos(ang - kepler), sin(ang - kepler)) * rDisk;
  float turb = fbm(vec3(swirl * 0.6, rDisk * 0.45 - kepler * 2.0));
  float bands = 0.5 + 0.5 * sin(ang * 3.0 - kepler * 4.0 + turb * 6.2);
  density = edge * (0.30 + 0.95 * turb) * (0.55 + 0.6 * bands);

  // temperature: hotter toward the ISCO (∝ r^-0.75 for a thin disk, softened here)
  kelvin = mix(9500.0, 1700.0, pow(t, 0.55)) * uDiskTemp;
  emit = uDiskBrightness * (0.4 + 1.4 / (0.35 + 2.6 * t));
}

// Schwarzschild disk: approximate relativistic Doppler + gravitational redshift (as in v1).
vec3 sampleDiskSchw(vec3 hit, vec3 photonDir, out float alpha) {
  float density, kelvin, emit;
  float r = length(hit);
  diskBase(hit, r, density, kelvin, emit);

  vec3 vdir = normalize(cross(vec3(0.0, 1.0, 0.0), hit));    // prograde orbital direction
  float beta = min(sqrt(0.5 / max(r, uDiskInner)), 0.95);    // orbital speed (units of c)
  float gamma = 1.0 / sqrt(1.0 - beta * beta);
  vec3 nObs = -normalize(photonDir);                          // emitter → observer direction
  float doppler = 1.0 / (gamma * (1.0 - beta * dot(vdir, nObs)));

  float shift = 1.0;
  if (uDoppler) shift *= doppler;
  if (uRedshift) shift *= sqrt(max(1.0 - 1.0 / r, 0.0));      // gravitational redshift
  kelvin *= clamp(shift, 0.2, 5.0);
  emit *= clamp(pow(shift, 3.0), 0.03, 9.0);                  // relativistic beaming ∝ δ³

  alpha = clamp(density * uDiskDensity, 0.0, 1.0);
  return blackbody(kelvin) * emit;
}

// Kerr disk: the *exact* relativistic frequency-shift factor g bundles gravitational redshift,
// transverse + longitudinal Doppler and frame dragging into one number, using the photon's own
// conserved impact parameter b = L/E and the prograde equatorial orbital angular velocity Ω.
vec3 sampleDiskKerr(vec3 hit, float r, float E, float L, out float alpha) {
  float density, kelvin, emit;
  diskBase(hit, r, density, kelvin, emit);

  float a = uSpin * MASS;
  float sqrtM = sqrt(MASS);
  float Om = sqrtM / (pow(r, 1.5) + a * sqrtM);               // prograde Ω (co-rotating disk)

  // equatorial metric (θ = π/2 ⇒ sinθ = 1, cosθ = 0)
  float Sig = r * r;
  float gtt = -(1.0 - 2.0 * MASS * r / Sig);
  float gtp = -2.0 * MASS * r * a / Sig;
  float gpp = (r * r + a * a + 2.0 * MASS * r * a * a / Sig);

  float denom = -(gtt + 2.0 * Om * gtp + Om * Om * gpp);      // (u^t)^-2 for the orbiting emitter
  float b = L / max(abs(E), 1e-6) * sign(E);
  float g = sqrt(max(denom, 1e-6)) / max(1.0 - Om * b, 1e-3); // ν_obs / ν_emit

  float shift = (uDoppler || uRedshift) ? g : 1.0;
  kelvin *= clamp(shift, 0.15, 6.0);
  emit *= clamp(pow(shift, 3.0), 0.02, 12.0);

  alpha = clamp(density * uDiskDensity, 0.0, 1.0);
  return blackbody(kelvin) * emit;
}

// ---------------------------------------------------------------- volumetric disk
// The volumetric path treats the disk as a flared slab of gas. Its half-thickness grows with the
// cylindrical radius ρ, and the density falls off as a Gaussian in the vertical (y) direction. A
// geodesic step that lands inside the slab contributes emission attenuated by everything already
// in front of it (classic emission–absorption), so the disk self-shadows and the far side glows
// through the near side. Sampling reuses each path's exact relativistic photometry.
// Half-thickness of the slab at cylindrical radius ρ. A mild sub-linear flare (H ∝ ρ^0.75 about a
// fixed 3 rs reference) keeps the disk geometrically thin — H/ρ shrinks outward, as for a real
// radiatively-efficient disk — so the shadow stays clean instead of drowning in a puffy sphere.
float diskH(float rho) {
  return uDiskThickness * pow(max(rho / 3.0, 0.2), 0.75);
}

// Schwarzschild volumetric sample at world point "pos" (y may be off the plane); "pdir" is the
// photon's local direction of travel there. Returns emission (with beaming baked in) + density.
void diskVolSchw(vec3 pos, vec3 pdir, out vec3 emission, out float dens) {
  float rho = length(pos.xz);
  float density, kelvin, emit;
  diskBase(vec3(pos.x, 0.0, pos.z), rho, density, kelvin, emit);
  float z = pos.y / max(diskH(rho), 1e-3);
  dens = density * exp(-1.8 * z * z);

  vec3 vdir = normalize(cross(vec3(0.0, 1.0, 0.0), vec3(pos.x, 0.0, pos.z)));
  float beta = min(sqrt(0.5 / max(rho, uDiskInner)), 0.95);
  float gamma = 1.0 / sqrt(1.0 - beta * beta);
  vec3 nObs = -normalize(pdir);
  float doppler = 1.0 / (gamma * (1.0 - beta * dot(vdir, nObs)));
  float shift = 1.0;
  if (uDoppler) shift *= doppler;
  if (uRedshift) shift *= sqrt(max(1.0 - 1.0 / max(rho, 1.0001), 0.0));
  kelvin *= clamp(shift, 0.2, 5.0);
  emit *= clamp(pow(shift, 3.0), 0.03, 9.0);
  emission = blackbody(kelvin) * emit;
}

// Kerr volumetric sample — the exact g-factor evaluated at the cylindrical radius ρ.
void diskVolKerr(vec3 pos, float E, float L, out vec3 emission, out float dens) {
  float rho = length(pos.xz);
  float density, kelvin, emit;
  diskBase(vec3(pos.x, 0.0, pos.z), rho, density, kelvin, emit);
  float z = pos.y / max(diskH(rho), 1e-3);
  dens = density * exp(-1.8 * z * z);

  float a = uSpin * MASS;
  float sqrtM = sqrt(MASS);
  float rr = max(rho, uDiskInner);
  float Om = sqrtM / (pow(rr, 1.5) + a * sqrtM);
  float Sig = rr * rr;
  float gtt = -(1.0 - 2.0 * MASS * rr / Sig);
  float gtp = -2.0 * MASS * rr * a / Sig;
  float gpp = (rr * rr + a * a + 2.0 * MASS * rr * a * a / Sig);
  float denom = -(gtt + 2.0 * Om * gtp + Om * Om * gpp);
  float b = L / max(abs(E), 1e-6) * sign(E);
  float g = sqrt(max(denom, 1e-6)) / max(1.0 - Om * b, 1e-3);
  float shift = (uDoppler || uRedshift) ? g : 1.0;
  kelvin *= clamp(shift, 0.15, 6.0);
  emit *= clamp(pow(shift, 3.0), 0.02, 12.0);
  emission = blackbody(kelvin) * emit;
}

// Doppler chromatic tint for the free-fall observer: D>1 (blueshift) pushes toward blue and
// dims red; D<1 does the reverse. A cheap perceptual stand-in for a full per-wavelength shift.
vec3 dopplerTint(vec3 c, float D) {
  float s = clamp(log(max(D, 1e-3)), -1.2, 1.2);
  vec3 gain = vec3(1.0 - 0.28 * s, 1.0 - 0.04 * s, 1.0 + 0.24 * s);
  return c * max(gain, vec3(0.0));
}

// ---------------------------------------------------------------- Schwarzschild geodesic
vec3 accel(vec3 p, float h2) {
  float r2 = max(dot(p, p), 0.09); // clamp near the horizon to keep the integrator finite
  return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
}

// ---------------------------------------------------------------- Kerr metric (Boyer–Lindquist)
// Covariant components, packed as (g_tt, g_tφ, g_rr, g_θθ, g_φφ).
void kerrCov(float r, float th, out float gtt, out float gtp, out float grr, out float gthth, out float gpp) {
  float a = uSpin * MASS;
  float a2 = a * a;
  float ct = cos(th);
  float st = max(sin(th), 2.0e-2);
  float s2 = st * st;
  float Sig = r * r + a2 * ct * ct;
  float Del = r * r - 2.0 * MASS * r + a2;
  gtt = -(1.0 - 2.0 * MASS * r / Sig);
  gtp = -2.0 * MASS * r * a * s2 / Sig;
  grr = Sig / Del;
  gthth = Sig;
  gpp = (r * r + a2 + 2.0 * MASS * r * a2 * s2 / Sig) * s2;
}

// Inverse (contravariant) components, packed as (g^tt, g^tφ, g^rr, g^θθ, g^φφ).
void kerrInv(float r, float th, out float gtt, out float gtp, out float grr, out float gthth, out float gpp) {
  float a = uSpin * MASS;
  float a2 = a * a;
  float ct = cos(th);
  float st = max(sin(th), 2.0e-2);
  float s2 = st * st;
  float Sig = r * r + a2 * ct * ct;
  float Del = r * r - 2.0 * MASS * r + a2;
  float A = (r * r + a2) * (r * r + a2) - a2 * Del * s2;
  gtt = -A / (Sig * Del);
  gtp = -2.0 * MASS * a * r / (Sig * Del);
  grr = Del / Sig;
  gthth = 1.0 / Sig;
  gpp = (Del - a2 * s2) / (Sig * Del * s2);
}

// 2·H for the null Hamiltonian: gᵘᵛ p_u p_v with p_t = −E, p_φ = L. Zero along the geodesic.
float kerrGval(float r, float th, float pr, float pth, float E, float L) {
  float gtt, gtp, grr, gthth, gpp;
  kerrInv(r, th, gtt, gtp, grr, gthth, gpp);
  return gtt * E * E - 2.0 * gtp * E * L + grr * pr * pr + gthth * pth * pth + gpp * L * L;
}

// Hamilton's equations. dphi is returned for image reconstruction; (dr, dth, dpr, dpth) drive
// the dynamics. The momentum forces are −½·∇(2H) evaluated by central differences in (r, θ).
void kerrDeriv(float r, float th, float pr, float pth, float E, float L,
               out float dr, out float dth, out float dphi, out float dpr, out float dpth) {
  float gtt, gtp, grr, gthth, gpp;
  kerrInv(r, th, gtt, gtp, grr, gthth, gpp);
  dr = grr * pr;
  dth = gthth * pth;
  dphi = -gtp * E + gpp * L;
  float h = 1.0e-3;
  float gr1 = kerrGval(r + h, th, pr, pth, E, L);
  float gr0 = kerrGval(r - h, th, pr, pth, E, L);
  float gt1 = kerrGval(r, th + h, pr, pth, E, L);
  float gt0 = kerrGval(r, th - h, pr, pth, E, L);
  dpr = -0.25 * (gr1 - gr0) / h;   // −0.5 · (·)/(2h)
  dpth = -0.25 * (gt1 - gt0) / h;
}

// world (x,y,z) ⇄ Boyer–Lindquist (r,θ,φ), spin axis = world +Y.
void worldToBL(vec3 p, out float r, out float th, out float ph) {
  float a = uSpin * MASS;
  float a2 = a * a;
  float R2 = dot(p, p);
  float r2 = 0.5 * ((R2 - a2) + sqrt(max((R2 - a2) * (R2 - a2) + 4.0 * a2 * p.y * p.y, 0.0)));
  r = sqrt(max(r2, 1e-8));
  th = acos(clamp(p.y / r, -1.0, 1.0));
  ph = atan(p.z, p.x);
}

vec3 blToWorld(float r, float th, float ph) {
  float a = uSpin * MASS;
  float s = sqrt(r * r + a * a);
  float st = sin(th);
  return vec3(s * st * cos(ph), r * cos(th), s * st * sin(ph));
}

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// =================================================================== Schwarzschild path
void traceSchwarzschild(vec3 pos, vec3 vel, float escapeR, out vec3 color, out float transmit, out bool captured, out vec3 outDir) {
  vec3 L = cross(pos, vel);
  float h2 = dot(L, L);
  color = vec3(0.0);
  transmit = 1.0;
  captured = false;

  for (int i = 0; i < 2000; i++) {
    if (i >= uSteps) break;
    float r = length(pos);
    if (r < 1.0) { captured = true; break; }
    if (r > escapeR && dot(pos, vel) > 0.0) break;

    float dt = uStepSize * (0.35 + 0.22 * r);

    vec3 a1 = accel(pos, h2);
    vec3 p2 = pos + 0.5 * dt * vel;      vec3 v2 = vel + 0.5 * dt * a1;
    vec3 a2 = accel(p2, h2);
    vec3 p3 = pos + 0.5 * dt * v2;       vec3 v3 = vel + 0.5 * dt * a2;
    vec3 a3 = accel(p3, h2);
    vec3 p4 = pos + dt * v3;             vec3 v4 = vel + dt * a3;
    vec3 a4 = accel(p4, h2);

    vec3 newPos = pos + dt / 6.0 * (vel + 2.0 * v2 + 2.0 * v3 + v4);
    vec3 newVel = vel + dt / 6.0 * (a1 + 2.0 * a2 + 2.0 * a3 + a4);

    if (uVolumetric) {
      // emission–absorption march: accumulate wherever this step is inside the flared slab
      vec3 mid = 0.5 * (pos + newPos);
      float rhoM = length(mid.xz);
      if (transmit > 0.004 && rhoM > uDiskInner * 0.8 && rhoM < uDiskOuter * 1.1 && abs(mid.y) < diskH(rhoM) * 3.0) {
        vec3 em; float dn;
        diskVolSchw(mid, normalize(vel + newVel), em, dn);
        float ds = length(newPos - pos);
        float alpha = 1.0 - exp(-dn * uDiskDensity * 3.2 * ds);
        color += transmit * em * alpha * 1.2;
        transmit *= (1.0 - alpha);
      }
    } else if (pos.y * newPos.y < 0.0 && transmit > 0.01) {
      float tt = pos.y / (pos.y - newPos.y);
      vec3 hit = mix(pos, newPos, tt);
      float rr = length(hit);
      if (rr > uDiskInner && rr < uDiskOuter) {
        float alpha;
        vec3 dc = sampleDiskSchw(hit, normalize(mix(vel, newVel, tt)), alpha);
        color += transmit * dc * alpha;
        transmit *= (1.0 - alpha);
      }
    }

    pos = newPos;
    vel = newVel;
  }
  outDir = vel;
}

// =================================================================== Kerr path
void traceKerr(vec3 camPos, vec3 dir, float escapeR, out vec3 color, out float transmit, out bool captured, out vec3 outDir) {
  float a = uSpin * MASS;
  float rplus = MASS + sqrt(max(MASS * MASS - a * a, 0.0));

  // --- initial position + covariant momenta from the camera ray ---------------
  float r, th, ph;
  worldToBL(camPos, r, th, ph);

  // finite-difference the world direction into BL coordinate velocities
  float eps = 1e-3;
  float r1, th1, ph1;
  worldToBL(camPos + eps * dir, r1, th1, ph1);
  float dph = ph1 - ph;
  dph -= 2.0 * PI * floor((dph + PI) / (2.0 * PI)); // wrap to (−π, π]
  float pr_con = (r1 - r) / eps;      // contravariant p^r
  float pth_con = (th1 - th) / eps;   // p^θ
  float pph_con = dph / eps;          // p^φ

  float gtt, gtp, grr, gthth, gpp;
  kerrCov(r, th, gtt, gtp, grr, gthth, gpp);

  // null condition g_tt (p^t)² + 2 g_tφ p^φ p^t + (spatial) = 0 → solve for future-pointing p^t
  float spatial = grr * pr_con * pr_con + gthth * pth_con * pth_con + gpp * pph_con * pph_con;
  float bq = 2.0 * gtp * pph_con;
  float disc = sqrt(max(bq * bq - 4.0 * gtt * spatial, 0.0));
  float pt1 = (-bq + disc) / (2.0 * gtt);
  float pt2 = (-bq - disc) / (2.0 * gtt);
  float pt_con = max(pt1, pt2);       // future-directed (largest dt/dλ)

  // lower indices: covariant momenta
  float E = -(gtt * pt_con + gtp * pph_con);           // E = −p_t
  float L = gtp * pt_con + gpp * pph_con;              // L = p_φ
  float pr = grr * pr_con;                             // p_r
  float pth = gthth * pth_con;                         // p_θ

  color = vec3(0.0);
  transmit = 1.0;
  captured = false;

  vec3 prevWorld = camPos;
  float prevY = camPos.y;

  for (int i = 0; i < 2000; i++) {
    if (i >= uSteps) break;
    // Capture generously near the horizon: in Boyer–Lindquist the metric blows up as Δ→0, so a
    // photon this deep is bound — stopping here avoids numerical "reflection" back out.
    if (r < rplus + 0.06 * rplus) { captured = true; break; }
    if (r > escapeR && pr > 0.0) break;

    // Shrink the step as the photon nears the horizon to keep the plunge accurate.
    float prox = clamp((r - rplus) * 1.6, 0.12, 1.0);
    float dt = uStepSize * (0.35 + 0.22 * r) * prox;

    // RK4 on (r, θ, φ, p_r, p_θ)
    float k1r, k1t, k1p, k1pr, k1pt;
    kerrDeriv(r, th, pr, pth, E, L, k1r, k1t, k1p, k1pr, k1pt);
    float k2r, k2t, k2p, k2pr, k2pt;
    kerrDeriv(r + 0.5 * dt * k1r, th + 0.5 * dt * k1t, pr + 0.5 * dt * k1pr, pth + 0.5 * dt * k1pt, E, L, k2r, k2t, k2p, k2pr, k2pt);
    float k3r, k3t, k3p, k3pr, k3pt;
    kerrDeriv(r + 0.5 * dt * k2r, th + 0.5 * dt * k2t, pr + 0.5 * dt * k2pr, pth + 0.5 * dt * k2pt, E, L, k3r, k3t, k3p, k3pr, k3pt);
    float k4r, k4t, k4p, k4pr, k4pt;
    kerrDeriv(r + dt * k3r, th + dt * k3t, pr + dt * k3pr, pth + dt * k3pt, E, L, k4r, k4t, k4p, k4pr, k4pt);

    float nr = r + dt / 6.0 * (k1r + 2.0 * k2r + 2.0 * k3r + k4r);
    float nth = th + dt / 6.0 * (k1t + 2.0 * k2t + 2.0 * k3t + k4t);
    float nph = ph + dt / 6.0 * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
    float npr = pr + dt / 6.0 * (k1pr + 2.0 * k2pr + 2.0 * k3pr + k4pr);
    float npth = pth + dt / 6.0 * (k1pt + 2.0 * k2pt + 2.0 * k3pt + k4pt);

    // Pole handling: θ is bounded to [0, π]. Crossing a pole is not a coordinate discontinuity in
    // the physical path — it just flips the azimuth by π and reverses p_θ. Reflecting here keeps
    // the reconstructed world path continuous and removes the classic Boyer–Lindquist axis seam.
    if (nth < 0.0) { nth = -nth; nph += PI; npth = -npth; }
    else if (nth > PI) { nth = 2.0 * PI - nth; nph += PI; npth = -npth; }

    vec3 world = blToWorld(nr, nth, nph);

    // ergosphere shell (static limit) — faint volumetric glow when enabled
    if (uErgosphere && transmit > 0.01) {
      float ct = cos(nth);
      float rErgo = MASS + sqrt(max(MASS * MASS - a * a * ct * ct, 0.0));
      if (nr < rErgo && nr > rplus) {
        color += transmit * dt * vec3(0.05, 0.16, 0.28) * 0.09;
      }
    }

    if (uVolumetric) {
      // volumetric slab march (Kerr) — same emission–absorption accumulation as the flat path
      vec3 mid = 0.5 * (prevWorld + world);
      float rhoM = length(mid.xz);
      if (transmit > 0.004 && rhoM > uDiskInner * 0.8 && rhoM < uDiskOuter * 1.1 && abs(mid.y) < diskH(rhoM) * 3.0) {
        vec3 em; float dn;
        diskVolKerr(mid, E, L, em, dn);
        float ds = length(world - prevWorld);
        float alpha = 1.0 - exp(-dn * uDiskDensity * 3.2 * ds);
        color += transmit * em * alpha * 1.2;
        transmit *= (1.0 - alpha);
      }
    } else if (prevY * world.y < 0.0 && transmit > 0.01) {
      // equatorial-plane crossing → sample the thin disk
      float tt = prevY / (prevY - world.y);
      vec3 hit = mix(prevWorld, world, tt);
      float rHit = mix(r, nr, tt);
      if (rHit > uDiskInner && rHit < uDiskOuter) {
        float alpha;
        vec3 dc = sampleDiskKerr(hit, rHit, E, L, alpha);
        color += transmit * dc * alpha;
        transmit *= (1.0 - alpha);
      }
    }

    prevWorld = world;
    prevY = world.y;
    r = nr; th = nth; ph = nph; pr = npr; pth = npth;
  }

  // escape direction for the starfield = the last world-space propagation step
  outDir = normalize(blToWorld(r, th, ph) - prevWorld + 1e-6 * dir);
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= uAspect;

  vec3 dir = normalize(uCamForward + uv.x * uTanHalfFov * uCamRight + uv.y * uTanHalfFov * uCamUp);
  vec3 pos = uCamPos;

  // Free-fall (Gullstrand–Painlevé rain) observer: aberrate the camera ray into the static frame
  // before integrating, and remember the Doppler factor so the whole sky beams and shifts as it
  // would for someone plunging in. β = 0 collapses this to the ordinary static camera.
  float dopplerD = 1.0;
  float beta = clamp(uObserverBeta, 0.0, 0.9985);
  if (beta > 0.0002) {
    vec3 eHat = -normalize(uCamPos);        // the raindrop moves radially inward
    float mu = dot(dir, eHat);              // look-direction cosine along the motion
    float g = 1.0 / sqrt(1.0 - beta * beta);
    vec3 perp = dir - mu * eHat;
    dir = normalize(perp / (g * (1.0 + beta * mu)) + eHat * ((mu + beta) / (1.0 + beta * mu)));
    dopplerD = g * (1.0 + beta * mu);       // ν_observed / ν_static for light from this direction
  }

  float camR = length(uCamPos);
  float escapeR = max(32.0, camR * 1.7);

  vec3 color;
  float transmit;
  bool captured;
  vec3 outDir;

  if (uSpin < 0.0015) {
    traceSchwarzschild(pos, dir, escapeR, color, transmit, captured, outDir);
  } else {
    traceKerr(pos, dir, escapeR, color, transmit, captured, outDir);
  }

  vec3 bg = captured ? vec3(0.0) : starField(outDir);
  color += transmit * bg;

  // Apply the observer Doppler shift + relativistic beaming to the assembled (linear) image.
  if (beta > 0.0002) {
    color = dopplerTint(color, dopplerD) * clamp(pow(dopplerD, 3.0), 0.05, 24.0);
  }

  if (uToneMap) {
    color *= uExposure;
    color = aces(color);
    color = pow(color, vec3(1.0 / 2.2)); // gamma
  }
  fragColor = vec4(color, 1.0);
}
`

// ---------------------------------------------------------------- bloom post-processing
// Bright-pass + downsample: keeps only luminance above the knee, at half resolution.
export const BRIGHT_SRC = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uScene;
uniform float uExposure;
uniform float uThreshold;
void main() {
  vec2 texel = 1.0 / vec2(textureSize(uScene, 0));
  vec2 uv = gl_FragCoord.xy * 2.0 * texel; // half-res target reads full-res source
  // 4-tap box downsample
  vec3 c = vec3(0.0);
  c += texture(uScene, uv + texel * vec2(-0.5, -0.5)).rgb;
  c += texture(uScene, uv + texel * vec2( 0.5, -0.5)).rgb;
  c += texture(uScene, uv + texel * vec2(-0.5,  0.5)).rgb;
  c += texture(uScene, uv + texel * vec2( 0.5,  0.5)).rgb;
  c *= 0.25 * uExposure;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(lum - uThreshold, 0.0) / max(lum, 1e-4);
  fragColor = vec4(c * k, 1.0);
}
`

// Separable Gaussian blur (9-tap). uDirection is (1,0) or (0,1) in texels.
export const BLUR_SRC = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDirection;
void main() {
  vec2 texel = 1.0 / vec2(textureSize(uTex, 0));
  vec2 uv = gl_FragCoord.xy * texel;
  vec2 d = uDirection * texel;
  float w0 = 0.227027, w1 = 0.1945946, w2 = 0.1216216, w3 = 0.054054, w4 = 0.016216;
  vec3 c = texture(uTex, uv).rgb * w0;
  c += texture(uTex, uv + d * 1.0).rgb * w1;
  c += texture(uTex, uv - d * 1.0).rgb * w1;
  c += texture(uTex, uv + d * 2.0).rgb * w2;
  c += texture(uTex, uv - d * 2.0).rgb * w2;
  c += texture(uTex, uv + d * 3.0).rgb * w3;
  c += texture(uTex, uv - d * 3.0).rgb * w3;
  c += texture(uTex, uv + d * 4.0).rgb * w4;
  c += texture(uTex, uv - d * 4.0).rgb * w4;
  fragColor = vec4(c, 1.0);
}
`

// Downsample a texture by half with a 4-tap box (used to build the second, wider bloom scale).
export const DOWNSAMPLE_SRC = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTex;
void main() {
  vec2 texel = 1.0 / vec2(textureSize(uTex, 0));
  vec2 uv = gl_FragCoord.xy * 2.0 * texel;
  vec3 c = vec3(0.0);
  c += texture(uTex, uv + texel * vec2(-0.5, -0.5)).rgb;
  c += texture(uTex, uv + texel * vec2( 0.5, -0.5)).rgb;
  c += texture(uTex, uv + texel * vec2(-0.5,  0.5)).rgb;
  c += texture(uTex, uv + texel * vec2( 0.5,  0.5)).rgb;
  fragColor = vec4(c * 0.25, 1.0);
}
`

// Final composite: scene * exposure + bloom, then ACES tonemap + gamma → screen.
export const COMPOSITE_SRC = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloomHalf;
uniform sampler2D uBloomQuarter;
uniform float uExposure;
uniform float uStrength;
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uScene, 0));
  vec3 scene = texture(uScene, uv).rgb * uExposure;
  vec3 bloom = texture(uBloomHalf, uv).rgb + texture(uBloomQuarter, uv).rgb * 1.25;
  vec3 color = scene + bloom * uStrength;
  color = aces(color);
  color = pow(color, vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`
